/**
 * The header band's left zone must show the run identity for a running
 * campaign (ui-spec §2.2: "Left zone: repository, branch/worktree, run
 * id."). `refreshTelemetry` — the only writer of `AppModel.telemetryCampaignId`,
 * which `deriveStatusBarZones`/`headerLeftLines` render as `run <id>` — was
 * previously invoked only from a palette-triggered screen switch or a halt
 * transition, never from a timer. An operator who never navigated screens
 * via the palette therefore saw `run —` for the whole life of a campaign,
 * even while the right zone (fed by the independently-timed
 * `refreshExecutionStatus`) correctly reported it running. Drive the real
 * TUI, seed a running (non-halted) campaign, and never touch the palette.
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
  return text.replace(/\[[0-9;?]*[A-Za-z]/g, "");
}

describe("header band run identity (ui-spec §2.2 left zone)", () => {
  let tempDir = "";
  afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

  it("shows the running campaign's id without any palette navigation or halt", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-tui-run-identity-"));
    const persistenceDir = resolvePersistenceDir(tempDir);
    const seed = new ArborRuntime({ persistence_dir: persistenceDir, devtools_logger: { persistence_dir: persistenceDir, disable_fsync: true } });
    await seed.start();
    seed.manager.startCampaign("run-identity-c1", "plan.md", rootAction);
    await seed.close();

    const stdin = new PassThrough();
    let out = "";
    const stdout = new PassThrough(); stdout.on("data", (d: Buffer) => { out += d.toString(); });
    Object.assign(stdout, { rows: 24, columns: 120, isTTY: false });
    const stderr = new PassThrough(); stderr.on("data", () => {});
    // `resume: true` treats the seeded campaign as the operator's own
    // session rather than pre-existing history, isolating this from the
    // separate `preexistingCampaignIds` behavior — the defect reproduces
    // here purely from `refreshTelemetry` never being timer-driven.
    const donePromise = runTui({ cwd: tempDir, stdin, stdout, stderr, frame_interval_ms: 10, resume: true });
    await expect.poll(() => stripAnsi(out), { timeout: 15_000 }).toContain("Esc blur");

    // Never write to the palette or switch screens. Only the background
    // timers (execution-status + telemetry, same 2s cadence) should be able
    // to resolve the run identity.
    await expect.poll(() => stripAnsi(out), { timeout: 8_000 }).toContain("run run-identity-c1");

    stdin.end();
    expect(await donePromise).toBe(0);
  }, 20_000);
});
