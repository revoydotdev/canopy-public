/**
 * T2.3b (FP-17 / RV-TUI-14): a left-click SGR mouse report over real raw
 * stdin must resolve to a real row selection through the same
 * `select_row_identity` reducer path keyboard `j`/`k`/click-native-OpenTUI
 * selection already use — proven end-to-end through the real `runTui` entry
 * point (pattern: tui-keyboard-scrolling.test.ts / tui-command-surface-
 * expansion.test.ts's job-seeding), not by calling
 * `selectionIntentFromPaneHit` directly.
 *
 * Uses the Jobs screen, not Campaigns: `screens/jobs.ts`'s `renderJobsTable`
 * threads `ctx.selected_id` into a real visible `›` marker per row;
 * `screens/campaigns.ts`'s `renderCampaignTable` does not forward
 * `ctx.selected_id`/`row_ids` to `renderTable` at all (a real, pre-existing
 * gap in a file this record does not own — reported separately, not fixed
 * here), so a Campaigns click would update `AppModel.selection` correctly
 * but never show it on screen, which this test could not distinguish from a
 * click that resolved to nothing.
 */
import { describe, expect, it, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { RuntimePortAdapter } from "../src/tui-adapter.js";
import { resolvePersistenceDir } from "../src/cli.js";
import { runTui } from "../src/tui.js";
import { computeShellLayout } from "@arbor/tui";

const ESC = String.fromCharCode(27);
const ANSI_ESCAPE_PATTERN = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "gu");

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

async function settle(ms = 60): Promise<void> { await new Promise((resolve) => setTimeout(resolve, ms)); }

/** A raw xterm SGR mouse press report: left button, 1-based (column, row). */
function sgrLeftClick(column: number, row: number): string {
  return `${ESC}[<0;${column};${row}M`;
}

/** Submits a job through the real router, mirroring tui-command-surface-expansion.test.ts's own seeding helper. */
async function submitJob(adapter: RuntimePortAdapter, id: string, operationId: string): Promise<void> {
  const result = await adapter.command({
    kind: "job.submit",
    metadata: { operation_id: operationId, idempotency_key: `idem:${operationId}` },
    params: { id, operation_id: operationId, job_kind: "test-job", owner_scope_id: "scope-1", idempotency_key: `idem:${operationId}` },
  });
  expect(result.ok).toBe(true);
}

describe("SGR left-click row selection over real stdin (T2.3b, FP-17)", () => {
  let tempDir = "";
  afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

  it("a left-click on the Jobs table's third data row selects that job", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-tui-click-"));
    const persistenceDir = resolvePersistenceDir(tempDir);
    const seed = new ArborRuntime({ persistence_dir: persistenceDir, devtools_logger: { persistence_dir: persistenceDir, disable_fsync: true } });
    await seed.start();
    const seedRouter = new RuntimeCatalogRouter(seed);
    const seedAdapter = new RuntimePortAdapter(seedRouter, () => 0);
    for (let i = 0; i < 4; i++) await submitJob(seedAdapter, `job-${i}`, `op-${i}`);
    await seed.close();

    const stdin = new PassThrough();
    let out = "";
    const stdout = new PassThrough(); stdout.on("data", (d: Buffer) => { out += d.toString(); });
    // `runTui` sizes the scene from `process.stdout.columns`/`.rows`
    // (tui.ts's `termCols`/`termRows`), not from this injected stream's own
    // `.columns`/`.rows` — setting those here has no effect on layout (only
    // `isTTY` matters, for renderer selection); see
    // s07-a04-pointer-journeys.test.ts's file header for the full note.
    // Under vitest's piped stdout, `process.stdout.columns` is `undefined`,
    // so the real fallback of 120x40 governs — the `docked` layout class
    // (ui-spec §2.1).
    Object.assign(stdout, { isTTY: false });
    const stderr = new PassThrough(); stderr.on("data", () => {});

    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => { markReady = resolve; });
    const donePromise = runTui({ cwd: tempDir, stdin, stdout, stderr, frame_interval_ms: 10, on_ready: markReady });
    await ready;

    // "9" is the Jobs screen chord in SCREEN_NAV. The single seeded row's
    // sticky-select already lands on the first row (job-0) — this proves the
    // click MOVES it, not merely that a marker exists.
    // Console owns the keyboard from its first frame (tui.ts), so release
    // it before driving a bare navigation key.
    stdin.write("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 60));
    stdin.write("9"); await settle(300);
    const before = stripAnsi(out);
    expect(before).toContain("› job-0"); // sticky default selection
    expect(before).not.toContain("› job-2");

    // M2 (ui-spec §2.2): at the real 120x40 fallback the framed top band is
    // 12 rows (clamp(floor(40/3),8,12)), so the main pane's own border
    // starts at canvas row 12 (`computeShellLayout`'s `transcript.y`), not
    // row 5. Jobs starts there: border, caption, header, then data. Its
    // third data row is canvas row 17, or row 18 in 1-based SGR coordinates.
    const bodyTop = computeShellLayout({ columns: 120, rows: 40 }).transcript.y;
    out = "";
    stdin.write(sgrLeftClick(3, bodyTop + 6));
    await settle(250);
    // `out` now holds only the diff written since the click: the redrawn
    // rows themselves prove the marker moved off job-0's row onto job-2's,
    // not merely that job-2 gained one somewhere.
    const delta = stripAnsi(out);
    expect(delta).toContain("› job-2");
    expect(delta).toContain("  job-0");

    stdin.end();
    const code = await donePromise;
    expect(code).toBe(0);
  }, 20_000);
});
