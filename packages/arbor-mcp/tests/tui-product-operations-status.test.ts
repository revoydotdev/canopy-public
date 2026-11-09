/**
 * Audit 2026-08-23 (WA-27): the Cockpit's PRODUCT OPERATIONS block reported
 * Remote/Scheduler/Verification/Follow-up lineage as "unavailable" on a
 * healthy install because the product surface issued COMMAND kinds
 * (`remote.control`/`scheduler.control`) as status reads and campaign-scoped
 * queries without a campaign id — every one failed validation and was folded
 * to null. Drive the real TUI and read the rendered block.
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

const rootAction: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}
async function settle(ms: number): Promise<void> { await new Promise((resolve) => setTimeout(resolve, ms)); }

describe("cockpit product-operations status (WA-27)", () => {
  let tempDir = "";
  afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

  it("reports remote, scheduler, verification and follow-up facets from real inspect queries, not as 'unavailable'", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-tui-product-ops-"));
    const persistenceDir = resolvePersistenceDir(tempDir);
    const seed = new ArborRuntime({ persistence_dir: persistenceDir, devtools_logger: { persistence_dir: persistenceDir, disable_fsync: true } });
    await seed.start();
    seed.manager.startCampaign("c1", "plan.md", rootAction);
    await seed.close();

    const stdin = new PassThrough();
    let out = "";
    const stdout = new PassThrough(); stdout.on("data", (d: Buffer) => { out += d.toString(); });
    // Console is the only product surface now, and it absorbed the Cockpit's
    // PRODUCT OPERATIONS facets (ADR-149 Decision 7). Give it the vertical
    // room the operator-fact block needs to render every facet rather than
    // collapsing to a "+N more" strip.
    Object.assign(stdout, { rows: 80, columns: 200, isTTY: false });
    const stderr = new PassThrough(); stderr.on("data", () => {});
    const donePromise = runTui({ cwd: tempDir, stdin, stdout, stderr, frame_interval_ms: 10, resume: true });
    await expect.poll(() => stripAnsi(out), { timeout: 15_000 }).toContain("Esc blur");
    stdin.write("\u0002");
    // M2 (ui-spec §4): the rail's default landing tab is Git, and the cycle
    // order is Git -> Governance -> Inspect -> Project -> ADRs -> Docs ->
    // DevTools (`ALL_INSPECTOR_TABS`, responsive-sidebar.ts) -- six presses
    // to reach DevTools, not three.
    stdin.write("\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C\u001b[C");
    // M2 (ui-spec §2.2): the framed top band is now 8-12 rows (was a fixed
    // 4-row hero), so the docked rail is shorter and the DevTools facet
    // panel no longer fits DOCTOR..FOLLOW-UP LINEAGE in one unscrolled
    // screen. Page down the persistent diagnostic pane before polling for
    // REMOTE -- `out` captures the whole cumulative stream, so scrolling
    // first still proves every facet reachable, just no longer above the
    // fold.
    for (let i = 0; i < 4; i += 1) { stdin.write("\u001b[6~"); await settle(80); }
    await expect.poll(() => stripAnsi(out), { timeout: 8_000 }).toContain("REMOTE");
    const deadline = Date.now() + 8_000;
    while (!stripAnsi(out).includes("FOLLOW-UP LINEAGE") && Date.now() < deadline) {
      stdin.write("\u001b[6~");
      await settle(80);
    }
    const frame = stripAnsi(out);
    // WA-27's actual claim: these facets must report what their real inspect
    // query returned, never a blanket "unavailable". Console renders them as
    // "LABEL  value", so assert the label is present and is NOT followed by
    // "unavailable" -- that is the defect, and it survives any spacing change.
    for (const label of ["REMOTE", "SCHEDULER", "VERIFICATION", "FOLLOW-UP LINEAGE"]) {
      expect(frame, `${label} facet missing`).toContain(label);
      expect(new RegExp(`${label}\\s+unavailable`).test(frame), `${label} reported unavailable`).toBe(false);
    }
    stdin.end();
    expect(await donePromise).toBe(0);
  }, 20_000);
});
