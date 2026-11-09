/**
 * M2.3 acceptance (brief): a real governed action progresses from
 * submission, through `RuntimeCatalogRouter.dispatchCommand` and runtime
 * events, to completion, visibly in the Inspect rail tab while the operator
 * types in the composer, opens a live document reader, and resizes the
 * terminal — the composer
 * draft stays intact, and the Inspect content comes from the ADR-161 event
 * read model (`packages/arbor-tui/src/read-model.ts`'s `summarizeForInspect`,
 * rendered by `responsive-sidebar.ts`'s `inspectTabBody`), not from any
 * transcript/log text.
 *
 * Mirrors `scripts/tui-demo-sim.ts`'s composition: a bare
 * `new ArborRuntime({ workspace_root, campaign_runner })` driven through a
 * second `RuntimeCatalogRouter` + `RuntimePortAdapter` pair over the SAME
 * runtime `runTui`'s own composition renders from (the `runtime_factory`
 * seam, `TuiLaunchOptions`), issuing the exact `campaign.start` then
 * `job.submit` (`CAMPAIGN_RUN_JOB_KIND`) commands a real operator's
 * composer/confirm flow would. The `campaign_runner` here is a minimal stub
 * that blocks on a controllable gate — this test decides exactly when the
 * job settles — rather than the full deterministic demo loop.
 */
import { afterEach, describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTui } from "../src/tui.js";
import { ArborRuntime } from "../src/runtime.js";
import type { CampaignRunner, CampaignRunOutcome } from "../src/runtime.js";
import { clearRegisteredScreens } from "@arbor/tui";

const ESC = String.fromCharCode(27);
const F6 = `${ESC}[17~`;
const TAB = "\t";
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g");

let tempDir: string | null = null;
afterEach(() => {
  clearRegisteredScreens();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

const settle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));

/** A campaign_runner that blocks on a gate the test alone controls, so the
 * supervised task's non-terminal -> terminal transition happens on this
 * test's own schedule, not a real (or simulated) tree-search loop's. */
function createControllableCampaignRunner(): { runner: CampaignRunner; release: () => void } {
  let resolveGate: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => { resolveGate = resolve; });
  const runner: CampaignRunner = {
    async run(_campaignId: string, signal: AbortSignal): Promise<CampaignRunOutcome> {
      await gate;
      return { halted: true, halt_reason: "acceptance-stub-complete", cancelled: signal.aborted, awaiting_user_input: false };
    },
  };
  return { runner, release: () => resolveGate?.() };
}

describe("Inspect rail shows a live governed action end to end (M2.3)", () => {
  it("dispatchCommand -> runtime events -> Inspect across composer input, a live reader, and terminal resize", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-inspect-live-"));
    mkdirSync(join(tempDir, "docs"));
    writeFileSync(join(tempDir, "docs", "m2.3-reader.md"), "M2.3_LIVE_READER_FIXTURE");
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let text = "";
    stdout.on("data", (chunk: Buffer) => { text += chunk.toString(); });
    let stderrText = "";
    stderr.on("data", (chunk: Buffer) => { stderrText += chunk.toString(); });
    const plain = (): string => text.replace(ANSI, "\n");

    const { runner, release } = createControllableCampaignRunner();
    const runtimeRef: { current: ArborRuntime | null } = { current: null };
    const proposal = JSON.stringify({
      summary: "Acceptance: a real governed action",
      assumptions: [],
      questions: [],
      root_action: { description: "Acceptance: a real governed action", estimated_gain: 10, estimated_cost: 2, category: "planning", delegate_to: "crown" },
      actions: [{ description: "Acceptance: verify the governed action", estimated_gain: 1, estimated_cost: 1, category: "verification", delegate_to: "seed" }],
      acceptance_checks: ["action completes"],
      acceptance_mapping: [{ criterion: "action completes", action_descriptions: ["Acceptance: verify the governed action"] }],
      risk_notes: [],
    });

    const runtimeFactory = (cwd: string, persistenceDir?: string): ArborRuntime => {
      const runtime = new ArborRuntime({
        workspace_root: cwd,
        persistence_dir: persistenceDir,
        campaign_runner: runner,
        task_composer_planner: {
          plan: async () => ({
            raw_proposal: proposal,
            session_id: "m2.3-planner",
            model_identity: "m2.3-deterministic-planner",
            usage: { kind: "unavailable", reason: "M2.3 acceptance fixture" },
          }),
        },
      });
      runtimeRef.current = runtime;
      return runtime;
    };

    // Real terminal-resize plumbing (`packages/arbor-tui/src/shell.ts`'s
    // `createProcessResizeSignalPort`/`defaultTerminalSize`) reads/subscribes
    // off the GLOBAL `process`/`process.stdout`, not the injected
    // `options.stdout` — `runTui`'s `TuiShell` construction (`tui.ts`) never
    // overrides `terminal_size`/`resize_signals`. Driving a resize from a
    // test therefore means dispatching the exact same global signal a real
    // terminal resize would raise, and restoring it afterward.
    const realStdout = process.stdout as unknown as { columns?: number; rows?: number };
    const originalColumns = realStdout.columns;
    const originalRows = realStdout.rows;

    const done = runTui({
      cwd: tempDir,
      stdin,
      stdout: stdout as never,
      stderr: stderr as never,
      runtime_factory: runtimeFactory,
    });

    try {
      // Submit through the same focused Console composer a real operator uses.
      // Enter invokes `taskcomposer.submit`, whose planner result is admitted
      // and then submitted as the supervised campaign-run job.
      await settle(250);
      stdin.write("Acceptance: a real governed action");
      await settle(100);
      stdin.write("\n");
      await settle(700);
      const runningJobs = (): Array<{ id: string; state?: string; status?: string }> => {
        const jobs = runtimeRef.current?.jobScheduler.view({ include_terminal: true }).jobs ?? [];
        return jobs as unknown as Array<{ id: string; state?: string; status?: string }>;
      };
      const jobDeadline = Date.now() + 10_000;
      while (runningJobs().length === 0 && Date.now() < jobDeadline) await settle(100);
      expect(runningJobs()).toHaveLength(1);
      const job = runningJobs()[0]!;
      const jobId = job.id;
      expect(jobId).toMatch(/^task-composer-run:draft-/);
      expect(runtimeRef.current?.manager.getActiveCampaignId()).toBeTruthy();

      const watermarkOf = (): number | null => {
        const match = plain().match(/watermark seq (\d+)/g)?.at(-1);
        return match ? Number(match.replace("watermark seq ", "")) : null;
      };

      // Focus the rail (F6 F6: composer -> transcript -> rail), then Tab to
      // the Inspect tab (`ALL_INSPECTOR_TABS`: git, governance, inspect, ...).
      stdin.write(F6);
      await settle();
      stdin.write(F6);
      await settle();
      stdin.write(TAB);
      await settle();
      stdin.write(TAB);
      await settle();

      const afterInspectFocus = plain();
      expect(afterInspectFocus).toContain("INSPECT");
      // The exact task/operation identity, from `summarizeForInspect`'s
      // `InspectTaskSummary` (`read-model.ts`) via `inspectTabBody`
      // (`responsive-sidebar.ts`) — never from a transcript/log line.
      // The rail is capped at 42 columns, so a UUID-bearing task/operation
      // pair is intentionally ellipsized. Assert the canonical task id
      // prefix rendered by Inspect and use the scheduler observation above
      // to bind the full id without weakening the real-path dispatch proof.
      expect(afterInspectFocus).toContain("task task-composer-run:");
      expect(afterInspectFocus).toContain("state started");
      expect(afterInspectFocus).not.toContain("state completed");
      const watermarkWhileRunning = watermarkOf();
      expect(watermarkWhileRunning).not.toBeNull();

      // Back to the composer (F6 F6: rail -> graph -> composer) and type a
      // multi-character draft while the job is still running.
      stdin.write(F6);
      await settle();
      stdin.write(F6);
      await settle();
      stdin.write("hello inspect");
      await settle();
      expect(plain()).toContain("❯ hello inspect");

      // Open the actual Console document reader while the governed action is
      // still blocked. The reader is reached through the production rail's
      // retained Docs tab and read from the temporary workspace.
      stdin.write(F6);
      await settle();
      stdin.write(F6);
      await settle();
      for (let index = 0; index < 3; index += 1) {
        stdin.write(TAB);
        await settle(40);
      }
      stdin.write("\n");
      const readerDeadline = Date.now() + 5_000;
      while (!plain().includes("M2.3_LIVE_READER_FIXTURE") && Date.now() < readerDeadline) await settle(50);
      expect(plain()).toContain("M2.3_LIVE_READER_FIXTURE");
      expect(plain()).toContain("❯ hello inspect");
      stdin.write(ESC);
      await settle(150);

      // Return to Inspect and prove the live task projection advanced across
      // opening/closing the reader without losing the composer draft.
      for (let index = 0; index < 4; index += 1) {
        stdin.write(TAB);
        await settle(40);
      }
      expect(plain()).toContain("INSPECT");
      expect(plain()).toContain("state started");
      stdin.write(F6);
      await settle();
      stdin.write(F6);
      await settle();
      expect(plain()).toContain("❯ hello inspect");

      // Resize while the job is still running and the draft is live.
      realStdout.columns = 90;
      realStdout.rows = 30;
      process.stdout.emit("resize");
      await settle(200);
      // The draft must survive a resize-driven full-frame repaint intact.
      expect(plain()).toContain("❯ hello inspect");

      // Release the stubbed campaign_runner: the supervised task now settles,
      // publishing a terminal `task.changed` (`runtime.ts`'s `runCampaignJob`
      // `finish` closure) that the next 500ms poll folds into the read model.
      release();
      await settle(700);

      // Re-focus the rail/Inspect tab to observe the terminal state (the
      // sidebar tab selection is sticky reducer state — `focus.rail_tab` —
      // but re-confirm the exact focus path rather than assume it held).
      stdin.write(F6);
      await settle();
      stdin.write(F6);
      await settle();

      const afterCompletion = plain();
      expect(afterCompletion).toContain("task task-composer-run:");
      expect(afterCompletion).toContain("state completed");
      const watermarkAfterCompletion = watermarkOf();
      expect(watermarkAfterCompletion).not.toBeNull();
      expect(watermarkAfterCompletion!).toBeGreaterThan(watermarkWhileRunning!);

      // The draft is still intact after the full run completed.
      expect(afterCompletion).toContain("❯ hello inspect");
    } finally {
      realStdout.columns = originalColumns;
      realStdout.rows = originalRows;
      stdin.end();
      const exitCode = await done;
      expect(exitCode).toBe(0);
      expect(stderrText).toBe("");
    }
  });
});
