/**
 * Audit 2026-08-23 (WA-25, WA-26): real cursor/paging bytes over real stdin
 * through the real `runTui` entry point. Before this wave, `ESC [ B` opened
 * the Compaction screen and `ESC [ 6 ~` changed nothing, because the CSI
 * table lacked the arrow sequences and `executeAction` never dispatched the
 * scroll action ids the decoder and reducer already understood.
 */
import { describe, expect, it, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArborRuntime } from "../src/runtime.js";
import { resolvePersistenceDir } from "../src/cli.js";
import { runTui } from "../src/tui.js";
import type { Action } from "@arbor/core";

const ESC = "\u001b";
const rootAction: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

/** The campaign ids visible in the most recent full frame, in render order. */
function visibleCampaignIds(out: string): string[] {
  const clean = stripAnsi(out);
  const lastClear = Math.max(clean.lastIndexOf("\u001b[2J"), clean.lastIndexOf("Campaigns ("));
  const frame = lastClear >= 0 ? clean.slice(lastClear) : clean;
  return [...frame.matchAll(/\bcmp-(\d{2})\b/g)].map((m) => m[0]);
}

async function settle(ms = 60): Promise<void> { await new Promise((resolve) => setTimeout(resolve, ms)); }

describe("keyboard scrolling and row selection over real stdin (WA-25, WA-26)", () => {
  let tempDir = "";
  afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

  it("PageDown advances the Campaigns viewport and Down selects the next row instead of opening Compaction", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-tui-scroll-"));
    const persistenceDir = resolvePersistenceDir(tempDir);
    const seed = new ArborRuntime({ persistence_dir: persistenceDir, devtools_logger: { persistence_dir: persistenceDir, disable_fsync: true } });
    await seed.start();
    for (let i = 0; i < 40; i++) seed.manager.startCampaign(`cmp-${String(i).padStart(2, "0")}`, `plan-${i}.md`, rootAction);
    await seed.close();

    const stdin = new PassThrough();
    let out = "";
    const stdout = new PassThrough(); stdout.on("data", (d: Buffer) => { out += d.toString(); });
    // A short terminal so 40 campaigns cannot fit on one page.
    Object.assign(stdout, { rows: 14, columns: 100, isTTY: false });
    const stderr = new PassThrough(); stderr.on("data", () => {});

    const donePromise = runTui({ cwd: tempDir, stdin, stdout, stderr, frame_interval_ms: 10 });
    await settle(150);

    // `\` then `1` is the Campaigns chord in SCREEN_NAV.
    // Console owns the keyboard from its first frame (tui.ts), so release
    // it before driving a bare navigation key.
    stdin.write("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 60));
    stdin.write("\\"); await settle(20); stdin.write("1"); await settle(250);
    const before = visibleCampaignIds(out);
    expect(before.length).toBeGreaterThan(0);
    expect(before.length).toBeLessThan(40);

    out = "";
    stdin.write(`${ESC}[6~`); // PageDown
    await settle(250);
    const afterPageDown = visibleCampaignIds(out);
    expect(afterPageDown.length).toBeGreaterThan(0);
    expect(afterPageDown[0]).not.toBe(before[0]);

    out = "";
    stdin.write(`${ESC}[H`); // Home
    await settle(250);
    expect(visibleCampaignIds(out)[0]).toBe(before[0]);

    out = "";
    stdin.write(`${ESC}[B`); // Down arrow
    await settle(400);
    const afterDown = stripAnsi(out);
    // The selection marker must be visible on the Campaigns table (it was
    // updated in the model but never rendered before lane T2.3b's finding).
    // The first Down seeds the selection on the first visible row and the
    // Campaigns table renders the `›` marker for it.
    expect(afterDown).toMatch(/›\s*cmp-\d{2}/);
    // The repaint after a selection move is a delta (status bar + rows), so
    // assert on what it must and must not contain rather than on the header.
    expect(afterDown).toMatch(/cmp-\d{2}/);
    expect(afterDown).not.toContain("Compaction");
    expect(afterDown).not.toContain("No data");

    stdin.end();
    const code = await donePromise;
    expect(code).toBe(0);
  }, 20_000);
});
