#!/usr/bin/env bun
/**
 * scripts/tui-demo-sim.ts — launches the REAL `arbor tui` cockpit driven by a
 * fully simulated, hermetic campaign for recording a demo reel.
 *
 * Hermetic by construction:
 *   - No model/provider calls: the campaign loop's specialist + critic +
 *     panel reviewer are the deterministic, seeded implementations from
 *     `@arbor/mcp`'s `demo.ts` (the same ones `arbor run --executor
 *     deterministic` uses), plus a small local reviewer mirroring
 *     `demo.ts`'s own deterministic panel reviewer (not exported, so
 *     reimplemented here rather than touching product source).
 *   - No network: nothing in the executor/reviewer path performs I/O beyond
 *     the local persistence directory.
 *   - No git/worktree side effects: `createDemoConfig(..., useWorktrees:
 *     false)` — the campaign loop never shells out to git, and no
 *     `WorktreeManager` is constructed.
 *
 * Composition: rather than `createCliRuntime` (which composes real
 * opencode/native harness integrations we explicitly do not want here),
 * this mirrors it minimally with a bare `new ArborRuntime({ workspace_root,
 * persistence_dir, campaign_runner })` — the exact seam `runtime.ts` itself
 * documents as safe for a caller that "never touches opencode or the
 * filesystem" beyond the persistence dir. The simulated `campaign_runner`
 * drives the real `@arbor/opencode` `runCampaign` loop against the real
 * `CampaignManager`, so `tree.node_changed` / `gate.recorded` / `task.changed`
 * events flow through the runtime's real `RuntimeEventStream` exactly as a
 * genuine run would.
 *
 * Starting a campaign: this script never bypasses the catalog. It builds its
 * own `RuntimeCatalogRouter` + `RuntimePortAdapter` pair over the SAME
 * `ArborRuntime` instance the TUI renders from (a second, functionally
 * equivalent instance — `RuntimeCatalogRouter` is a thin, near-stateless
 * dispatch wrapper over the shared runtime; see its constructor) and, when
 * `--auto-start` is given, issues the exact `campaign.start` then
 * `job.submit` commands through `RuntimePortAdapter.command()` ->
 * `RuntimeCatalogRouter.dispatchCommand()` that the TUI's composer/confirm
 * flow issues for a real campaign. Without `--auto-start`, the operator
 * starts a campaign from the Console/composer screen as usual (planning
 * still needs a decomposer; none is wired here, so `--auto-start` is the
 * supported path for a scripted reel).
 *
 * Every campaign this driver starts is labeled SIMULATED in its root
 * action's description — an operator-visible string on the Console/Tree
 * screens — so a reel can never be mistaken for a real run.
 *
 * Flags:
 *   --project <dir>          scratch project directory (created if missing)
 *   --persistence-dir <dir>  runtime persistence dir (created if missing)
 *   --step-ms <n>            pacing delay per specialize/review step (default 1500)
 *   --seed <n>               deterministic executor/reviewer seed (default 42)
 *   --auto-start "<title>"   dispatch a real campaign.start + job.submit right after boot
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { runTui } from "../packages/arbor-mcp/src/tui.ts";
import type { TuiRendererKind } from "../packages/arbor-mcp/src/tui.ts";
import { resolvePersistenceDir } from "../packages/arbor-mcp/src/cli.ts";
import { ArborRuntime, CAMPAIGN_RUN_JOB_KIND } from "../packages/arbor-mcp/src/runtime.ts";
import type { CampaignRunner, CampaignRunOutcome } from "../packages/arbor-mcp/src/runtime.ts";
import { RuntimeCatalogRouter } from "../packages/arbor-mcp/src/runtime-catalog.ts";
import { RuntimePortAdapter } from "../packages/arbor-mcp/src/tui-adapter.ts";
import { createDemoLoopExecutor, createDemoConfig } from "../packages/arbor-mcp/src/demo.ts";
import { devtoolsHookForRuntime } from "../packages/arbor-mcp/src/devtools-log.ts";
import { runCampaign, PanelOfCritics } from "../packages/arbor-opencode/src/index.ts";
import type { LoopExecutor, ReviewerRunner } from "../packages/arbor-opencode/src/index.ts";
import type { Action } from "../packages/arbor-core/src/index.ts";

interface CliArgs {
  project: string;
  persistenceDir?: string;
  stepMs: number;
  seed: number;
  autoStart?: string;
  renderer?: TuiRendererKind;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let project = "/tmp/claude-1000/tui-demo-sim-project";
  let persistenceDir: string | undefined;
  let stepMs = 1500;
  let seed = 42;
  let autoStart: string | undefined;
  let renderer: TuiRendererKind | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project" && i + 1 < argv.length) project = resolve(argv[++i]!);
    else if (arg === "--persistence-dir" && i + 1 < argv.length) persistenceDir = resolve(argv[++i]!);
    else if (arg === "--step-ms" && i + 1 < argv.length) stepMs = Number(argv[++i]);
    else if (arg === "--seed" && i + 1 < argv.length) seed = Number(argv[++i]);
    else if (arg === "--auto-start" && i + 1 < argv.length) autoStart = argv[++i];
    // Passthrough, mirroring `tuimain`'s own `--renderer opentui|stdout`
    // (tui.ts), so a reel capture can force the stdout path the same way
    // the real `arbor tui --renderer stdout` does, instead of only ever
    // exercising whichever renderer `resolveRendererKind` picks by default.
    else if (arg === "--renderer" && i + 1 < argv.length) {
      const value = argv[++i];
      if (value !== "stdout" && value !== "opentui") throw new Error("--renderer must be 'stdout' or 'opentui'");
      renderer = value;
    }
  }
  if (!Number.isFinite(stepMs) || stepMs < 0) throw new Error("--step-ms must be a non-negative number");
  if (!Number.isFinite(seed)) throw new Error("--seed must be a number");
  return { project, persistenceDir, stepMs, seed, autoStart, renderer };
}

/**
 * SIM_STEPS: the simulated plan's leaf actions, branched from root in ONE
 * `branch()` call (see `run` below for why: `CampaignManager.selectNode`
 * (manager.ts) checks `campaign.halted` FIRST, before ever looking at the
 * tree -- once a campaign auto-halts `no_nodes`, that flag is permanent for
 * the campaign's lifetime with no un-halt path, so branching a SECOND
 * generation from a leaf AFTER the first `runCampaign` call has already
 * halted just adds unreachable "pending" nodes forever: `selectNode` returns
 * null on `campaign.halted` before it would ever consider them. A real,
 * deeper multi-generation reel would need the executor to elaborate
 * dynamically mid-loop; nothing in this hermetic demo path does that. One
 * flat, much larger generation is what this loop model actually supports.
 *
 * 28 leaf actions (up from the original 6, which exhausted -- `no_nodes` --
 * after ~7 total nodes in well under the reel's planned filming window even
 * at `--step-ms 1500`) land the campaign around the ~15-30 node target with
 * a real mix of claimed (this hermetic demo's actual terminal success state
 * -- `demo.ts`'s deterministic executor deliberately never asserts real
 * NodeState "verified", since no command genuinely ran), failed, and pruned
 * outcomes. Descriptions are all prefixed "SIMULATED" so the reel is never
 * mistaken for real work; two governance actions exercise the deterministic
 * executor's needs_input path (ADR-019) more than once.
 */
const SIM_STEPS: ReadonlyArray<Omit<Action, "constraints">> = [
  { description: "SIMULATED: tighten UCT exploration constant", estimated_gain: 6, estimated_cost: 2, category: "tuning", delegate_to: "seed" },
  { description: "SIMULATED: record fifth-gate decision by ADR or defer", estimated_gain: 5, estimated_cost: 2, category: "governance", delegate_to: "heartwood" },
  { description: "SIMULATED: add edge-case coverage for scoring", estimated_gain: 7, estimated_cost: 3, category: "testing", delegate_to: "seed" },
  { description: "SIMULATED: refactor demo panel reviewer", estimated_gain: 4, estimated_cost: 2, category: "cleanup", delegate_to: "seed" },
  { description: "SIMULATED: draft release notes stub", estimated_gain: 3, estimated_cost: 1, category: "docs", delegate_to: "heartwood" },
  { description: "SIMULATED: prototype worktree isolation toggle", estimated_gain: 8, estimated_cost: 4, category: "emulation", delegate_to: "seed" },
  { description: "SIMULATED: add a health check endpoint", estimated_gain: 5, estimated_cost: 2, category: "feature", delegate_to: "seed" },
  { description: "SIMULATED: cover the health check endpoint with tests", estimated_gain: 5, estimated_cost: 2, category: "testing", delegate_to: "seed" },
  { description: "SIMULATED: expand health check to report dependency status", estimated_gain: 6, estimated_cost: 3, category: "feature", delegate_to: "seed" },
  { description: "SIMULATED: add a rate limiter around the health check route", estimated_gain: 4, estimated_cost: 2, category: "hardening", delegate_to: "seed" },
  { description: "SIMULATED: record the health-check rollout gate by ADR or defer", estimated_gain: 5, estimated_cost: 2, category: "governance", delegate_to: "heartwood" },
  { description: "SIMULATED: add integration coverage across the health check route", estimated_gain: 7, estimated_cost: 3, category: "testing", delegate_to: "seed" },
  { description: "SIMULATED: document the health check contract", estimated_gain: 3, estimated_cost: 1, category: "docs", delegate_to: "heartwood" },
  { description: "SIMULATED: prune the unused legacy status probe", estimated_gain: 2, estimated_cost: 1, category: "cleanup", delegate_to: "seed" },
  { description: "SIMULATED: benchmark the health check route under load", estimated_gain: 6, estimated_cost: 3, category: "performance", delegate_to: "seed" },
  { description: "SIMULATED: wire the health check into the readiness probe", estimated_gain: 5, estimated_cost: 2, category: "feature", delegate_to: "seed" },
  { description: "SIMULATED: alert on sustained health check degradation", estimated_gain: 6, estimated_cost: 3, category: "observability", delegate_to: "seed" },
  { description: "SIMULATED: dashboard the health check history", estimated_gain: 4, estimated_cost: 2, category: "observability", delegate_to: "seed" },
  { description: "SIMULATED: add chaos coverage for a degraded dependency", estimated_gain: 7, estimated_cost: 4, category: "testing", delegate_to: "seed" },
  { description: "SIMULATED: draft the on-call runbook entry", estimated_gain: 3, estimated_cost: 1, category: "docs", delegate_to: "heartwood" },
  { description: "SIMULATED: retire the ad hoc status page", estimated_gain: 2, estimated_cost: 1, category: "cleanup", delegate_to: "seed" },
  { description: "SIMULATED: tune the alert debounce window", estimated_gain: 5, estimated_cost: 2, category: "tuning", delegate_to: "seed" },
  { description: "SIMULATED: ship the health check summary to the release notes", estimated_gain: 3, estimated_cost: 1, category: "docs", delegate_to: "heartwood" },
  { description: "SIMULATED: roll the health check endpoint out behind a flag", estimated_gain: 5, estimated_cost: 2, category: "feature", delegate_to: "seed" },
  { description: "SIMULATED: add a canary check before the flag flips globally", estimated_gain: 6, estimated_cost: 3, category: "hardening", delegate_to: "seed" },
  { description: "SIMULATED: add rollback coverage for a failed canary", estimated_gain: 6, estimated_cost: 3, category: "testing", delegate_to: "seed" },
  { description: "SIMULATED: update the operator runbook with the rollout steps", estimated_gain: 3, estimated_cost: 1, category: "docs", delegate_to: "heartwood" },
  { description: "SIMULATED: retire the interim manual rollout checklist", estimated_gain: 2, estimated_cost: 1, category: "cleanup", delegate_to: "seed" },
];

function stepToAction(step: Omit<Action, "constraints">): Action {
  return { ...step, constraints: ["MUST self-validate before submitting", "MUST NOT modify unrelated code"] };
}

/**
 * A small deterministic ReviewerRunner mirroring demo.ts's own (unexported)
 * `createDemoPanelReviewer` deterministic branch: seeded, no network, no
 * model. Written here rather than exporting the product's private helper.
 *
 * Paced like every other loop step (`paceExecutor`'s specialize/review):
 * `PanelOfCritics.review` runs every critic through this callback in
 * PARALLEL (`Promise.all`), so pacing each one costs one `stepMs` total per
 * node, not `stepMs` per critic -- without it, panel review was the one
 * loop step with NO pacing at all, so a node's total handling time was
 * only its two `paceExecutor`-wrapped calls, shortening the whole reel well
 * below its planned filming window.
 */
function createSimPanelReviewer(adapter: RuntimePortAdapter, campaignId: string, seed: number, stepMs: number, signal: AbortSignal): ReviewerRunner {
  let rng = seed;
  const rand = (): number => { rng = (rng * 1664525 + 1013904223) & 0x7fffffff; return rng / 0x7fffffff; };
  return async (criticName, ctx) => {
    await sleep(stepMs, signal);
    const approved = rand() >= 0.12;
    adapter.pushDevtoolsLine({
      seq: 0, ts: new Date().toISOString(), event_kind: "loop.tool_call",
      campaign_id: campaignId, node_id: null, synthetic: false,
      loop_event: {
        type: "tool_call", tool: "sim.panel_review",
        args: `${criticName} · ${approved ? "approve" : "reject"}`,
        ok: true, duration_ms: 150,
        stdout: `[sim] ${criticName} ${approved ? "approved" : "rejected"} — ${ctx.description.slice(0, 60)}`,
      } as never,
    });
    const checks = ["root_cause", "measurement_validation", "guardrail_enforcement", "introspection", "stability_monitoring"].map((name) => ({
      name: name as "root_cause" | "measurement_validation" | "guardrail_enforcement" | "introspection" | "stability_monitoring",
      passed: approved,
      detail: approved ? `${criticName}: deterministic sim check passed` : `${criticName}: deterministic sim concern`,
    }));
    return {
      approved,
      rationale: approved ? `${criticName}: no blocking concern` : `${criticName}: blocking concern in ${ctx.action_category}`,
      root_cause: approved ? undefined : "insufficient_test_coverage",
      severity: approved ? undefined : "high",
      verdict: {
        approved, critic: criticName,
        rationale: approved ? `${criticName}: no blocking concern` : `${criticName}: blocking concern in ${ctx.action_category}`,
        ...(approved ? {} : { root_cause: "insufficient_test_coverage" }),
        measurement_validated: approved, guardrails_enforced: approved,
        introspection_passed: approved, stability_ok: approved, checks,
      },
    };
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((res) => {
    if (ms <= 0 || signal.aborted) { res(); return; }
    const timer = setTimeout(res, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); res(); }, { once: true });
  });
}

/** Wraps a LoopExecutor so each specialize/review step is visibly paced. */
function paceExecutor(inner: LoopExecutor, stepMs: number, signal: AbortSignal): LoopExecutor {
  return {
    async specialize(params) { await sleep(stepMs, signal); return inner.specialize(params); },
    async review(params) { await sleep(stepMs, signal); return inner.review(params); },
    log: inner.log,
  };
}

/**
 * The deterministic demo executor's "governance" plan step raises a real,
 * blocking `needs_input` request (ADR-019: an unresolved interview blocks
 * node selection for the whole campaign — `runCampaign` returns immediately,
 * with `awaiting_user_input: true`, the moment it hits one; see demo.ts's own
 * G-05 note). A scripted, unattended reel has no operator to answer it, so
 * this plays that role once per stop: it lists the real `userinput.list`
 * query and answers every unanswered request's first option through the real
 * `userinput.answer` command — the same catalog surface the TUI's own
 * interview screen drives, just scripted instead of keyed in. Answers are
 * tagged `sim-operator` so they are never mistaken for a genuine human
 * decision. The caller is expected to re-invoke `runCampaign` afterward to
 * resume the now-unblocked loop (mirroring an operator resolving the
 * interview in the TUI, then the loop continuing).
 */
async function answerPendingInterviews(adapter: RuntimePortAdapter, campaignId: string): Promise<number> {
  const listed = await adapter.query({
    kind: "userinput.list",
    query_id: `sim-userinput-list:${campaignId}:${Date.now().toString(36)}`,
    params: { campaign_id: campaignId },
  });
  if (!listed.ok) return 0;
  const projection = listed.value as { records: readonly { id: string; question: { options: readonly { id: string }[] } }[]; answered_record_ids: readonly string[] };
  let answeredCount = 0;
  for (const record of projection.records) {
    if (projection.answered_record_ids.includes(record.id)) continue;
    const optionId = record.question.options[0]?.id ?? null;
    const result = await adapter.command({
      kind: "userinput.answer",
      metadata: { operation_id: `sim-answer:${record.id}`, idempotency_key: `sim-answer:${record.id}` },
      params: { record_id: record.id, answer: { option_id: optionId, custom_text: "", answered_by: "sim-operator", answered_at: new Date().toISOString() } },
    });
    if (result.ok && result.value?.accepted) answeredCount++;
  }
  return answeredCount;
}

/**
 * Builds the simulated CampaignRunner. `runtimeRef`/`adapterRef` are boxes
 * because the runner closure must outlive the ArborRuntime constructor call
 * that ultimately receives it (see `main`, mirroring `cli.ts`'s
 * `createCliRuntime` runtimeBox pattern).
 */
function createSimulatedCampaignRunner(
  runtimeRef: { current: ArborRuntime | null },
  adapterRef: { current: RuntimePortAdapter | null },
  stepMs: number,
  seed: number,
): CampaignRunner {
  let runIndex = 0;
  return {
    async run(campaignId: string, signal: AbortSignal): Promise<CampaignRunOutcome> {
      const runtime = runtimeRef.current;
      const adapter = adapterRef.current;
      if (!runtime || !adapter) throw new Error("simulated campaign runner invoked before its runtime finished composing");
      runIndex++;
      adapter.setCampaignId(campaignId);

      const hook = devtoolsHookForRuntime(runtime);
      const executor = paceExecutor(createDemoLoopExecutor(adapter, hook, campaignId, seed + runIndex), stepMs, signal);
      const reviewer = createSimPanelReviewer(adapter, campaignId, seed * 7 + runIndex, stepMs, signal);
      const config = createDemoConfig(runtime, { panel: new PanelOfCritics(), run_reviewer: reviewer }, false);

      // One `branch()` call, all 28 leaves siblings under root: see
      // SIM_STEPS's own doc comment for why a second, later `branch()` call
      // (deepening from an already-settled leaf, attempted here in an
      // earlier revision) cannot work in this loop model --
      // `CampaignManager.selectNode` refuses every node, new ones included,
      // for the rest of a campaign's life once `campaign.halted` is set.
      const children = runtime.manager.branch(campaignId, "root", SIM_STEPS.map(stepToAction));

      // Backtrack/prune demonstration: real tree.prune commands through the
      // catalog, pruning two branched children at different points as the
      // campaign works through the tree (not both immediately), so the reel
      // shows this more than once across its longer run.
      const pruneTargets = [children[2], children[Math.floor(children.length * 0.6)]].filter((id): id is string => id !== undefined);
      for (const [index, pruneTarget] of pruneTargets.entries()) {
        setTimeout(() => {
          if (signal.aborted) return;
          void adapter.command({
            kind: "tree.prune",
            metadata: { operation_id: `sim-prune:${campaignId}:${pruneTarget}`, idempotency_key: `sim-prune:${campaignId}:${pruneTarget}` },
            params: { campaign_id: campaignId, node_id: pruneTarget },
          });
        }, Math.max(stepMs, 250) * (index + 1) * 3);
      }

      // `runCampaign` stops the instant it hits an unanswered interview
      // (awaiting_user_input: true) — see `answerPendingInterviews`'s doc.
      // Resolve it and resume, bounded so a misbehaving executor can never
      // spin this forever.
      let report = await runCampaign({ manager: runtime.manager, campaign_id: campaignId, executor, config, signal });
      for (let resumeAttempt = 0; report.awaiting_user_input && !signal.aborted && resumeAttempt < 20; resumeAttempt++) {
        const answered = await answerPendingInterviews(adapter, campaignId);
        if (answered === 0) break;
        report = await runCampaign({ manager: runtime.manager, campaign_id: campaignId, executor, config, signal });
      }
      return { halted: report.halted, halt_reason: report.halt_reason, cancelled: report.cancelled, awaiting_user_input: report.awaiting_user_input };
    },
  };
}

/**
 * Issues the same real `campaign.start` then `job.submit` catalog commands
 * the TUI composer's confirm flow issues, through a `RuntimePortAdapter`
 * over the shared runtime — used by `--auto-start` so a scripted reel can
 * boot straight into a running campaign without operator keystrokes.
 */
async function autoStartCampaign(adapter: RuntimePortAdapter, title: string): Promise<void> {
  const campaignId = `sim-${Date.now().toString(36)}`;
  const rootAction: Action = {
    description: `SIMULATED demo campaign: ${title}`,
    estimated_gain: 10,
    estimated_cost: 2,
    category: "planning",
    delegate_to: "crown",
  };
  const startResult = await adapter.command({
    kind: "campaign.start",
    metadata: { operation_id: `sim-start:${campaignId}`, idempotency_key: `sim-start:${campaignId}` },
    params: { campaign_id: campaignId, plan_path: "sim-demo-plan.md", root_action: rootAction },
  });
  if (!startResult.ok || !startResult.value?.accepted) {
    const reason = !startResult.ok ? startResult.error?.summary : startResult.value?.error?.summary;
    throw new Error(`--auto-start: campaign.start was refused: ${reason ?? "unknown reason"}`);
  }
  const jobId = `sim-run:${campaignId}`;
  const submitResult = await adapter.command({
    kind: "job.submit",
    metadata: { operation_id: jobId, idempotency_key: jobId },
    params: { id: jobId, operation_id: jobId, job_kind: CAMPAIGN_RUN_JOB_KIND, owner_scope_id: campaignId, idempotency_key: jobId },
  });
  if (!submitResult.ok || !submitResult.value?.accepted) {
    const reason = !submitResult.ok ? submitResult.error?.summary : submitResult.value?.error?.summary;
    throw new Error(`--auto-start: job.submit was refused: ${reason ?? "unknown reason"}`);
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.project, { recursive: true });
  // Mirror `cli.ts`'s own `createCliRuntime` (`resolvePersistenceDir`):
  // resolve a real, contained persistence dir even when `--persistence-dir`
  // is not given, rather than leaving it `undefined`. `ArborRuntime` only
  // constructs its `OutputEvidenceStore` when `persistence_dir` is set
  // (runtime.ts's `this.outputEvidence = options.output_evidence ?? ...`),
  // so an undefined persistence dir left the launcher's `output_evidence.*`
  // commands/queries refusing every call with "output evidence persistence
  // is not configured" -- the real CLI never hits this because it always
  // resolves a persistence dir first.
  const persistenceDir = resolvePersistenceDir(args.project, args.persistenceDir);
  mkdirSync(persistenceDir, { recursive: true });

  const runtimeRef: { current: ArborRuntime | null } = { current: null };
  const adapterRef: { current: RuntimePortAdapter | null } = { current: null };

  const runtimeFactory = (cwd: string, persistenceDirArg?: string): ArborRuntime => {
    const runtime = new ArborRuntime({
      workspace_root: cwd,
      persistence_dir: persistenceDirArg ?? persistenceDir,
      campaign_runner: createSimulatedCampaignRunner(runtimeRef, adapterRef, args.stepMs, args.seed),
    });
    runtimeRef.current = runtime;
    const router = new RuntimeCatalogRouter(runtime);
    adapterRef.current = new RuntimePortAdapter(router, () => runtime.operations.list().length);
    return runtime;
  };

  const exitCode = await runTui({
    cwd: args.project,
    persistence_dir: persistenceDir,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    renderer: args.renderer,
    runtime_factory: runtimeFactory,
    on_ready: args.autoStart === undefined ? undefined : () => {
      autoStartCampaign(adapterRef.current!, args.autoStart!).catch((error) => {
        process.stderr.write(`tui-demo-sim: auto-start failed: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    },
  });
  return exitCode;
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    process.stderr.write(`tui-demo-sim: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
