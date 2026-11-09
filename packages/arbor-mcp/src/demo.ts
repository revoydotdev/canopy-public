/**
 * `arbor demo` — autonomous campaign demo driver.
 */
import { ArborRuntime } from "./runtime.js";
import { RuntimeCatalogRouter } from "./runtime-catalog.js";
import { RuntimePortAdapter, type DevtoolsStreamLine } from "./tui-adapter.js";
import { devtoolsHookForRuntime } from "./devtools-log.js";
import { parseCampaignExecutorRequest, resolveCampaignExecutorLane, type CampaignExecutorRequest, type CampaignLaneResolution } from "./campaign-executor-lane.js";
import { CANOPY_CONNECTOR_ID, DeprecatedHarnessRefusal, recordDeprecatedHarnessAdmission, type DeprecatedHarnessAdmission } from "./canopy-lane-policy.js";
import { createCockpitTelemetrySource } from "./cockpit-sources.js";
import { composeLoopConfigPorts, buildAgentDefinitionSource } from "./loop-ports-helper.js";
import {
  createOpenCodeLoopExecutor,
  DEFAULT_SPECIALIST_MODEL,
  DEFAULT_CRITIC_MODEL,
  createOpenCodePanelReviewer,
  resolveConfiguredModel,
} from "./opencode-executor.js";
import { createOpenCodeServerLoopExecutor } from "./opencode-server-executor.js";
import { createOpenCodeDecomposer } from "./opencode-decomposer.js";
import { ManagerScoreContextAdapter } from "./loop-adapters.js";
import { buildConfigInspection, configuredNativeAgentExecutor, createNativePanelReviewer, OpenCodeProviderCapabilityAdapter, resolveCliOrganizationPolicy, resolvePersistenceDir, takeWriterLock } from "./cli.js";
import { composeNativeExecutorEnvironment, resolveNativeCredentialSelection, type NativeExecutorEnvironment } from "./native-executor-composition.js";
import { createWorktreeRecoveryLeaseAuthority } from "./recovery-lease-adapter.js";
import { TaskAttachmentStore } from "./task-attachment-store.js";
import { NativeHarnessReadinessService, resolveNativeHarnessExecutionReadiness, type NativeHarnessExecutionReadiness } from "./native-harness-readiness.js";
import { createReferenceNativeModelAdapterRegistry, HarnessIntegrationRegistry, type ConnectorInspection } from "@arbor/harness";
import { createNativeHarnessConnectorDescriptor } from "./harness-control-plane.js";
import { inspectHarnessIntegrationEnvironment } from "./doctor.js";
import type { CampaignHarnessIntegration } from "./campaign-harness-integration.js";
import type { NativeAgentExecutor } from "./native-agent-executor.js";
import { EXIT_CODES } from "./exit-codes.js";
import type { Action, CampaignConfig } from "@arbor/core";
import {
  runCampaign,
  WorktreeManager,
  PanelOfCritics,
  type LoopExecutor,
  type SpecialistResult,
  type CriticResult,
  type LoopEvent,
  type CampaignLoopConfig,
  type ReviewerVerdict,
  type ReviewerRunner,
} from "@arbor/opencode";
import { loadConfig, type ArborConfig } from "@arbor/config";
import {
  HeadlessHarness,
  installScreens,
  StdoutRenderer,
  TuiShell,
  timerCadence,
  createProcessSignalPort,
  createNavigation,
  createKeyboardHandler,
  attachKeyboardInput,
} from "@arbor/tui";

// ============================================================
// DEMO PLAN STEPS
// ============================================================

interface DemoStep {
  description: string;
  estimated_gain: number;
  estimated_cost: number;
  category: string;
  delegate_to: string;
  verifiable: boolean;
  fail_chance: number;
}

const DEMO_PLAN_STEPS: readonly DemoStep[] = Object.freeze([
  { description: "Bring repo-wide branch coverage to ≥85% (currently 80.71%)", estimated_gain: 8, estimated_cost: 4, category: "testing", delegate_to: "seed", verifiable: true, fail_chance: 0.15 },
  { description: "Record the surveillance fifth-gate decision by ADR or explicitly defer", estimated_gain: 6, estimated_cost: 3, category: "governance", delegate_to: "heartwood", verifiable: false, fail_chance: 0.10 },
  { description: "Per-knob config source/ledger provenance on governance-critical values (ADR-020 extension)", estimated_gain: 4, estimated_cost: 2, category: "config", delegate_to: "seed", verifiable: true, fail_chance: 0.05 },
  { description: "Final release report: live gate results into release-readiness.md", estimated_gain: 7, estimated_cost: 5, category: "release", delegate_to: "heartwood", verifiable: false, fail_chance: 0.25 },
  { description: "Flip A1 worktrees: use_worktrees:true + WorktreeManager in demo driver", estimated_gain: 9, estimated_cost: 6, category: "emulation", delegate_to: "seed", verifiable: true, fail_chance: 0.20 },
  { description: "A4 critic panel: wire panel + run_reviewer into CampaignLoopConfig", estimated_gain: 5, estimated_cost: 3, category: "emulation", delegate_to: "seed", verifiable: true, fail_chance: 0.10 },
  { description: "B1 all-12-screen routing: feed projections for diagnostics/tasks/operations/output", estimated_gain: 6, estimated_cost: 4, category: "tui", delegate_to: "seed", verifiable: true, fail_chance: 0.15 },
  { description: "C2 true decoupling: separate opencode run driver + arbor tui observer", estimated_gain: 7, estimated_cost: 8, category: "topology", delegate_to: "heartwood", verifiable: false, fail_chance: 0.30 },
]);

function stepToAction(step: DemoStep): Action {
  return {
    description: step.description,
    estimated_gain: step.estimated_gain,
    estimated_cost: step.estimated_cost,
    category: step.category,
    delegate_to: step.delegate_to,
    constraints: ["MUST self-validate before submitting", "MUST NOT modify unrelated code"],
  };
}

// ============================================================
// DETERMINISTIC LOOP EXECUTOR
// ============================================================

export function createDemoLoopExecutor(
  adapter: RuntimePortAdapter,
  devtoolsHook: (loop: unknown) => void,
  campaignId: string,
  seed = 42,
): LoopExecutor {
  let rng = seed;
  const rand = (): number => {
    rng = (rng * 1664525 + 1013904223) & 0x7fffffff;
    return rng / 0x7fffffff;
  };

  let specializeCalls = 0;
  let reviewCalls = 0;

  const log = (event: LoopEvent): void => {
    devtoolsHook(event);
    const line: DevtoolsStreamLine = {
      seq: 0,
      ts: new Date().toISOString(),
      event_kind: `loop.${event.type}`,
      campaign_id: campaignId,
      node_id:
        "node_id" in event && typeof event.node_id === "string"
          ? event.node_id
          : "parent_id" in event && typeof event.parent_id === "string"
            ? event.parent_id
            : null,
      node_state: undefined,
      synthetic: false,
    };
    adapter.pushDevtoolsLine(line);
  };

  return {
    async specialize(params): Promise<SpecialistResult> {
      specializeCalls++;
      const step = DEMO_PLAN_STEPS[(specializeCalls - 1) % DEMO_PLAN_STEPS.length];
      const verifiable = step?.verifiable ?? true;
      adapter.pushDevtoolsLine({
        seq: 0, ts: new Date().toISOString(), event_kind: "loop.tool_call",
        campaign_id: campaignId, node_id: params.node_id, synthetic: false,
        loop_event: {
          type: "tool_call", tool: "demo.specialize",
          args: `seed · ${step?.delegate_to ?? "seed"} · ${step?.category ?? ""}`,
          ok: true, duration_ms: 800,
          stdout: `[demo] specialized '${params.action.description.slice(0, 60)}'`,
        } as never,
      });
      if (verifiable) {
        adapter.pushDevtoolsLine({
          seq: 0, ts: new Date().toISOString(), event_kind: "loop.diff",
          campaign_id: campaignId, node_id: params.node_id, synthetic: true,
          loop_event: {
            type: "diff", path: "packages/arbor-core/src/scoring.ts",
            additions: 3, deletions: 1,
            diff: "diff --git a/packages/arbor-core/src/scoring.ts b/packages/arbor-core/src/scoring.ts\n@@ -40,7 +40,9 @@\n-const c = 1.41;\n+const c = 1.41421356237;\n+// tighten the UCT exploration constant\n+logger.trace(\"rebalanced\");",
          } as never,
        });
      }
      // G-05: the "governance" step is exactly the kind of node ADR-019
      // describes — a decision (record the surveillance fifth-gate decision
      // by ADR, or explicitly defer it) that a specialist should not resolve
      // on its own. This is `arbor demo`'s real exercise of the needs_input
      // path: deterministic, reproducible on every run. DEMO_PLAN_STEPS are
      // branched directly under root (the plan's own admission-level
      // actions), so the loop raises this with lead/blocking authority —
      // exactly ADR-019's "plan/admission interview blocks selectNode" case.
      const needsInput = step?.category === "governance"
        ? {
            question: `Governance decision required: ${step.description}. Record by ADR, or defer to a future campaign?`,
            options: [
              { id: "record-adr", text: "Record the decision by ADR now", is_other: false },
              { id: "defer", text: "Defer to a future campaign", is_other: false },
            ],
            requester_role: "demo-specialist",
            idempotency_key: `${campaignId}:${params.node_id}:governance-input`,
          }
        : undefined;
      return {
        output: `[demo] ${params.action.description}\nStatus: completed\nVerification: automated tests passed`,
        // G-22: this executor never runs a command — no vitest process, no
        // real stdout. `verified` provenance asserts a verification command
        // genuinely ran and its output is content-hashed; a scripted double
        // cannot honestly claim that regardless of the `verifiable` flag
        // (which only decides whether the synthetic devtools "diff" line is
        // pushed above). `claimed` is the truthful tag for simulated work.
        provenance: { tag: "claimed", claimant: params.specialist_agent },
        token_usage: { kind: "unavailable", reason: "deterministic demo executor is seeded/scripted; it does not simulate provider usage" },
        ...(needsInput ? { needs_input: needsInput } : {}),
      };
    },
    async review(params): Promise<CriticResult> {
      reviewCalls++;
      const step = DEMO_PLAN_STEPS[(reviewCalls - 1) % DEMO_PLAN_STEPS.length];
      const accepted = step ? rand() >= step.fail_chance : true;
      adapter.pushDevtoolsLine({
        seq: 0, ts: new Date().toISOString(), event_kind: "loop.tool_call",
        campaign_id: campaignId, node_id: params.node_id, synthetic: false,
        loop_event: {
          type: "tool_call", tool: "demo.review",
          args: `lenticel · ${accepted ? "approve" : "reject"}`,
          ok: true, duration_ms: 400,
          stdout: accepted ? "[demo] critic approved — gates passed" : "[demo] critic rejected — edge-case coverage insufficient",
        } as never,
      });
      const noUsage = { kind: "unavailable" as const, reason: "deterministic demo executor is seeded/scripted; it does not simulate provider usage" };
      if (!accepted) {
        return {
          approved: false,
          rationale: `Critic rejected: ${params.action.description} — edge case coverage insufficient`,
          root_cause: "insufficient_test_coverage",
          critic_agent: "lenticel",
          measurement_validated: false,
          token_usage: noUsage,
        };
      }
      return {
        approved: true,
        rationale: `Approved: ${params.action.description} — output matches spec, gates passed`,
        critic_agent: "lenticel",
        measurement_validated: true,
        token_usage: noUsage,
      };
    },
    log,
  };
}

// ============================================================
// PANEL-OF-CRITICS REVIEWER (A-7: `panel`/`run_reviewer` composition)
// ============================================================

/**
 * A `ReviewerRunner` (A-7): `loop.ts` only calls this when `config.panel` is
 * set — before this, no production composition root ever supplied either
 * field, so `PanelOfCritics.review` (the checks-and-balances panel ROADMAP
 * claims as a completed foundation) never ran on a real campaign.
 *
 * `ctx` (the second argument `loop.ts` passes) is the same small
 * `PanelContext` for every reviewer — `{action_category, high_stakes,
 * description}` — not the prepared specialist output; that is the panel
 * contract as designed in `critics.ts`, not something this composition root
 * can widen.
 *
 * Deterministic mode is seeded/scripted (hermetic, no network — used by
 * `runOneCampaign`'s test callers). Real mode genuinely dispatches
 * `opencode run` per active reviewer, using the shared production adapter
 * from opencode-executor. That adapter fails closed (not approved) on an
 * unparseable or failed response and is also what `arbor run` uses.
 */
function createDemoPanelReviewer(
  adapter: RuntimePortAdapter,
  campaignId: string,
  mode: "real" | "deterministic",
  options: { criticModel?: string; opencodeBin?: string; timeoutMs?: number } = {},
): ReviewerRunner {
  if (mode === "deterministic") {
    let rng = 90210;
    const rand = (): number => { rng = (rng * 1664525 + 1013904223) & 0x7fffffff; return rng / 0x7fffffff; };
    return async (criticName, ctx): Promise<ReviewerVerdict> => {
      const approved = rand() >= 0.12;
      adapter.pushDevtoolsLine({
        seq: 0, ts: new Date().toISOString(), event_kind: "loop.tool_call",
        campaign_id: campaignId, node_id: null, synthetic: false,
        loop_event: {
          type: "tool_call", tool: "demo.panel_review",
          args: `${criticName} · ${approved ? "approve" : "reject"}`,
          ok: true, duration_ms: 150,
          stdout: `[demo] ${criticName} ${approved ? "approved" : "rejected"} — ${ctx.description.slice(0, 60)}`,
        } as never,
      });
      // `ReviewerVerdict.token_usage` is a plain `TokenUsage`, not the
      // `TokenUsageResult` union `SpecialistResult`/`CriticResult` use — it
      // has no `{kind:"unavailable"}` variant. Omitting the field is the
      // honest representation of "no real usage available" here.
      const checks = ["root_cause", "measurement_validation", "guardrail_enforcement", "introspection", "stability_monitoring"].map((name) => ({
        name: name as "root_cause" | "measurement_validation" | "guardrail_enforcement" | "introspection" | "stability_monitoring",
        passed: approved,
        detail: approved ? `${criticName}: deterministic demo check passed` : `${criticName}: deterministic demo concern`,
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

  return createOpenCodePanelReviewer(adapter, campaignId, {
    criticModel: options.criticModel,
    opencodeBin: options.opencodeBin,
    timeoutMs: options.timeoutMs,
    devtoolsTool: "demo.panel_review",
  });
}

// ============================================================
// CAMPAIGN LOOP CONFIGURATION
// ============================================================

/**
 * Exported for tests: proves `panel`/`run_reviewer` (A-7) and `use_worktrees`
 * (A-2) genuinely arrive in the `CampaignLoopConfig` the one production
 * `runCampaign` caller builds, without re-deriving `runOneCampaign`'s whole
 * composition.
 */
export function createDemoConfig(
  runtime: ArborRuntime,
  panel: { panel: PanelOfCritics; run_reviewer: ReviewerRunner },
  useWorktrees: boolean,
): CampaignLoopConfig {
  const scoreAdapter = new ManagerScoreContextAdapter(runtime.manager);
  // The loopPorts helpers return mcp-side structural types that are runtime-compatible
  // with the opencode-side CampaignLoopConfig field types but not perfectly assignable
  // under tsc --build strict checking. The cast is safe: the objects are the same
  // canonical runtime ports composed by ArborRuntime.
  return {
    max_iterations: 80,
    specialist_base_prompt: "You are a Seed (demo). Self-validate before submitting.",
    critic_base_prompt: "You are Lenticel (demo). APPROVAL-BIASED: reject only verified blockers.",
    specialist_cap: { tier: "specialist" },
    critic_cap: { tier: "critic" },
    score_ctx: (campaignId: string) => scoreAdapter.score_ctx(campaignId),
    // A-2: the one production `runCampaign` caller now genuinely creates
    // isolated git worktrees (ADR-001's mandatory isolation gate) whenever
    // the caller supplies a `WorktreeManager` — see `runOneCampaign` below.
    // Hermetic test callers that pass no manager keep `false` (dry-run),
    // exactly as before.
    use_worktrees: useWorktrees,
    branch_actions: () => null,
    // G-01: exercise capability routing on a real run. Most DEMO_PLAN_STEPS
    // descriptions route to "seed-quick" via routeCategory (no architecture/
    // doc/multi-step keywords), and every step's action.delegate_to is
    // "seed" or "heartwood" — both appear verbatim as card skills alongside
    // the routed category (see deriveCandidateNodeCard). This is a static,
    // campaign-level skill hint, not per-iteration intent derived from an
    // operator command — that refinement is future work.
    task_skills: ["seed-quick", "seed"],
    // A-7: the panel-of-critics now genuinely runs on every real campaign
    // instead of being permanently unreachable dead code.
    panel: panel.panel,
    run_reviewer: panel.run_reviewer,
    // G-30: composeLoopConfigPorts now composes a real, fully-formed
    // TokenEconomyConfig itself — no override needed here.
    ...composeLoopConfigPorts(runtime),
  } as CampaignLoopConfig;
}

// ============================================================
// DEMO RUNNER
// ============================================================

export interface DemoOptions {
  once: boolean;
  persistenceDir: string;
  frameIntervalMs: number;
  settleDelayMs: number;
  pollIntervalMs: number;
  /** "real" = live model calls on the resolved `liveLane`; "deterministic" = seeded, no network. */
  executor: "real" | "deterministic";
  /**
   * Which harness a "real" run executes on. Canopy-only (amends ADR-061):
   * `native` is the Canopy lane, composed by `composeDemoNativeLane`;
   * `opencode` is reachable only with a recorded `connectors.allow_deprecated`
   * admission. A "real" run without a lane is refused, never defaulted.
   */
  liveLane?: DemoLiveLane;
  /** Per-dispatch ceiling for a real specialist/critic call. See `--timeout`. */
  specialistTimeoutMs?: number;
  /**
   * How the "real" executor talks to opencode (Stage 0,
   * docs/full-harness-ownership-brief.md §5). "subprocess" (default) shells
   * out to `opencode run` per dispatch, exactly as before. "server" spawns
   * one `opencode serve` and drives it over HTTP, returning real token usage
   * and a server-validated structured critic verdict instead of scraping
   * stdout. Ignored when executor is "deterministic".
   */
  transport: "subprocess" | "server";
  specialistModel?: string;
  criticModel?: string;
  /**
   * A-2: optional command run inside a specialist's real git worktree after
   * it edits files. When it exits 0, provenance is genuinely `!verified`
   * (opencode-executor.ts's `runVerification`) instead of `!claimed`. Unset
   * by default — worktree isolation (below) is now always on for the real
   * `arbor demo` entrypoint, but running a build/test command inside every
   * ephemeral worktree is a real cost an operator should opt into explicitly
   * (a fresh `git worktree add` has no `node_modules`, so most build/test
   * commands need an install step of their own to succeed there).
   */
  verificationCmd?: string;
  /**
   * Ordered, fail-fast staged verification — the same repeatable
   * `--verification-cmd` contract `selfhost` already accepts. `arbor run`
   * parsed the flag as single/last-wins, so the staged arm was unreachable
   * from the entrypoint the demo reel actually drives: repeating the flag
   * silently overwrote the earlier command and every run could only ever
   * report `check.breadth: "single"`.
   */
  verificationCmds?: readonly string[];
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

const DEFAULT_DEMO_OPTIONS: Omit<DemoOptions, "persistenceDir" | "stdout" | "stderr"> = {
  once: false,
  frameIntervalMs: 250,
  settleDelayMs: 2000,
  pollIntervalMs: 500,
  executor: "real",
  transport: "subprocess",
};

/** The harness a live `arbor run` campaign executes on. */
export type DemoLiveLane =
  | { readonly kind: "native"; readonly integration: CampaignHarnessIntegration; readonly connector: ConnectorInspection }
  | { readonly kind: "opencode"; readonly admission: DeprecatedHarnessAdmission };

export async function runOneCampaign(
  runtime: ArborRuntime,
  adapter: RuntimePortAdapter,
  campaignIndex: number,
  seed: number,
  demoOptions: Readonly<Pick<DemoOptions, "executor" | "transport" | "specialistModel" | "criticModel" | "verificationCmd" | "verificationCmds" | "specialistTimeoutMs" | "liveLane">>,
  /**
   * G-16: cooperative cancellation for the whole campaign run. Wired from
   * `demomain`'s SIGINT/SIGTERM handlers so an operator interrupt actually
   * reaches `runCampaign`'s abort path instead of only flipping the
   * poll-loop's local `done` flag (which previously let a mid-flight
   * campaign run to completion before shutdown took effect).
   */
  signal?: AbortSignal,
  /**
   * A-2: a real, repo-rooted `WorktreeManager`. `demomain` (the actual
   * production `runCampaign` caller) always supplies one; hermetic test
   * callers that omit it keep the pre-existing dry-run behavior
   * (`use_worktrees: false`) so no test ever shells out to `git`.
   */
  worktrees?: WorktreeManager,
  /**
   * A-6: `tree_search.*` from `arbor.jsonc`, mapped to `CampaignConfig` by
   * `campaignConfigFromArborConfig`. `demomain` loads this once and threads
   * it through every campaign; test callers that omit it get the manager's
   * built-in `DEFAULT_CAMPAIGN_CONFIG`, exactly as before.
   */
  campaignConfig?: Partial<CampaignConfig>,
): Promise<void> {
  const live = demoOptions.executor === "real" ? demoOptions.liveLane : undefined;
  if (demoOptions.executor === "real" && live === undefined) {
    throw new Error("runOneCampaign: a live run requires a resolved lane (the Canopy native lane, or an admitted deprecated connector); there is no default connector");
  }
  const campaignId = `demo-${campaignIndex}-${Date.now().toString(36)}`;
  adapter.setCampaignId(campaignId);

  const rootAction: Action = {
    description: `Demo campaign #${campaignIndex} — autonomous tree search`,
    estimated_gain: 10,
    estimated_cost: 2,
    category: "planning",
    delegate_to: "crown",
  };

  const startResult = runtime.manager.startCampaign(campaignId, `demo-plan-${campaignIndex}.md`, rootAction, campaignConfig);
  if (!startResult.ok) {
    adapter.pushDevtoolsLine({
      seq: 0, ts: new Date().toISOString(), event_kind: "campaign.start_failed",
      campaign_id: campaignId, node_id: null, synthetic: false,
    });
    return;
  }

  adapter.pushDevtoolsLine({
    seq: 0, ts: new Date().toISOString(), event_kind: "campaign.changed",
    campaign_id: campaignId, node_id: null, node_state: "created", synthetic: false,
  });

  runtime.manager.branch(campaignId, "root", DEMO_PLAN_STEPS.map(stepToAction));

  const hook = devtoolsHookForRuntime(runtime);

  // A deprecated lane's admission is journalled on the campaign's own ledger
  // before any turn runs on it, so the run's evidence says which harness ran
  // it and on whose opt-in.
  if (live?.kind === "opencode") recordDeprecatedHarnessAdmission(runtime.manager, campaignId, live.admission);
  const nativeInput = live?.kind === "native"
    ? { runtime, campaign_id: campaignId, adapter, cwd: process.cwd(), connector: live.connector } as const
    : null;

  const reviewer = live?.kind === "native" && nativeInput !== null
    ? live.integration.createReviewer(nativeInput)
    : createDemoPanelReviewer(adapter, campaignId, demoOptions.executor, {
      criticModel: demoOptions.criticModel,
    });
  const config = createDemoConfig(runtime, { panel: new PanelOfCritics(), run_reviewer: reviewer }, worktrees !== undefined);
  // Wire the decomposer for real runs only. Without it `FAULT_MATRIX`'s
  // `timeout -> "decompose"` is inert and a timed-out node just fails, which
  // is the behaviour every real campaign showed: a specialist handed an epic
  // ("Bring repo-wide branch coverage to >=85%") burned its whole budget and
  // died, twice, at 120s and again at 900s. The deterministic executor never
  // times out, so it needs no decomposer and gets none.
  //
  // The decomposer gets its own, shorter ceiling than a specialist: proposing
  // a handful of sub-actions is a small generation, and letting it inherit a
  // 15-minute specialist budget would mean a stuck decomposition costs as
  // much as the work it was meant to make tractable.
  //
  // The opencode decomposer belongs to the opencode lane only: on the Canopy
  // lane a decomposer comes from the native integration or not at all, never
  // from a connector behind its back.
  if (live?.kind === "opencode") {
    config.decomposer = createOpenCodeDecomposer({
      configDir: process.cwd(),
      timeoutMs: Math.min(demoOptions.specialistTimeoutMs ?? 900_000, 180_000),
    });
  } else if (live?.kind === "native" && nativeInput !== null) {
    const decomposer = live.integration.createDecomposer?.(nativeInput);
    if (decomposer !== undefined) config.decomposer = decomposer;
    // The native lane's machine verification is the project's declared
    // acceptance commands, the same source `arbor task` uses.
    const acceptance = loadConfig(process.cwd()).verification?.acceptance_commands;
    if (acceptance !== undefined) config.acceptance_commands = acceptance;
  }
  const executor = live?.kind === "native" && nativeInput !== null
    ? live.integration.createExecutor(nativeInput)
    : live?.kind === "opencode"
    ? demoOptions.transport === "server"
      ? createOpenCodeServerLoopExecutor(adapter, hook, campaignId, {
          specialistModel: demoOptions.specialistModel,
          criticModel: demoOptions.criticModel,
          verificationCmd: demoOptions.verificationCmd,
          ...(demoOptions.specialistTimeoutMs === undefined ? {} : { timeoutMs: demoOptions.specialistTimeoutMs }),
        })
      : createOpenCodeLoopExecutor(adapter, hook, campaignId, {
          specialistModel: demoOptions.specialistModel,
          criticModel: demoOptions.criticModel,
          verificationCmd: demoOptions.verificationCmd,
          ...(demoOptions.verificationCmds === undefined ? {} : { verificationCmds: demoOptions.verificationCmds }),
          ...(demoOptions.specialistTimeoutMs === undefined ? {} : { timeoutMs: demoOptions.specialistTimeoutMs }),
        })
    : createDemoLoopExecutor(adapter, hook, campaignId, seed);

  try {
    const report = await runCampaign({ manager: runtime.manager, campaign_id: campaignId, executor, config, worktrees, signal });
    adapter.pushDevtoolsLine({
      seq: 0, ts: new Date().toISOString(), event_kind: "campaign.completed",
      campaign_id: campaignId, node_id: null, node_state: report.halted ? "halted" : "completed", synthetic: false,
    });
  } catch {
    adapter.pushDevtoolsLine({
      seq: 0, ts: new Date().toISOString(), event_kind: "campaign.error",
      campaign_id: campaignId, node_id: null, synthetic: false,
    });
  } finally {
    // The server transport (createOpenCodeServerLoopExecutor) owns a
    // long-lived `opencode serve` child that keeps the event loop alive
    // until released — see opencode-server-executor.ts's `makeServerProvider`
    // comment. Nothing else in this module ever gets a handle to that
    // process, so this `finally` (success, halt, error, or abort — all funnel
    // here) is the only release point. The subprocess transport and the demo
    // double don't own a persistent handle and don't expose `close`.
    const closeable = executor as unknown as { close?: () => Promise<void> };
    if (typeof closeable.close === "function") {
      await closeable.close();
    }
  }
}

/**
 * A-6: map `arbor.jsonc`'s `tree_search.*` onto `CampaignConfig` — the
 * per-campaign runtime shape `startCampaign` actually reads. Before this,
 * the file schema and the per-campaign runtime config were two structurally
 * separate paths with no code connecting them, so every knob under
 * `tree_search.*` was parsed, validated, and discarded.
 */
export function campaignConfigFromArborConfig(config: ArborConfig): Partial<CampaignConfig> {
  return {
    max_seconds: config.tree_search.max_seconds,
    min_score: config.tree_search.min_score,
    convergence_iterations: config.tree_search.convergence_iterations,
    score_config: { exploration_constant: config.tree_search.exploration_constant },
  };
}

/**
 * The cost disclosure `arbor run` shows when it is about to spend real money.
 *
 * `arbor run` defaults to the REAL executor (documented in --help) and,
 * without --once, runs campaigns back-to-back indefinitely at
 * max_iterations: 80 each. `selfhost` — the same class of expensive
 * autonomous action — refuses to start without explicit --max-iterations and
 * --max-seconds. That asymmetry left the cheaper-sounding command as the
 * unbounded one, and nothing said so at the moment of running it.
 *
 * The notice is a notification rather than a stderr banner because the TUI
 * clears the screen on init, so anything printed before that is wiped before
 * it can be read. The notification ring is where the operator is looking.
 *
 * The default is deliberately NOT flipped to deterministic: `run` is
 * documented as the genuine autonomous tree-search run, and silently
 * substituting a seeded executor would make the headline command a
 * fabrication — a worse defect than the one this fixes.
 *
 * Returns null for the deterministic executor, which spends nothing and needs
 * no warning.
 */
export function realExecutorDisclosure(
  options: Pick<DemoOptions, "executor" | "once" | "specialistModel" | "criticModel">,
): { id: string; severity: "warning"; message: string; createdAt: number } | null {
  if (options.executor !== "real") return null;
  return {
    id: "run:real-executor",
    severity: "warning",
    // Report what will actually be used, not the raw CLI option. Before
    // G-33 this read `options.specialistModel` directly and printed
    // "live model calls to undefined (specialist)" on every run without an
    // explicit --model. The specialist model is now resolved per dispatched
    // agent from `agents.*.model`, so no single name is correct for it; the
    // critic is always Lenticel and can be named concretely.
    message: `REAL executor — live model calls. Specialist: ${options.specialistModel
      ?? `per-agent from arbor.jsonc agents.*.model (default ${DEFAULT_SPECIALIST_MODEL})`}. `
      + `Critic: ${options.criticModel ?? resolveConfiguredModel("lenticel", process.cwd(), DEFAULT_CRITIC_MODEL)}. `
      + (options.once
        ? "Bounded: --once runs a single campaign."
        : "UNBOUNDED: campaigns run back-to-back until interrupted. Use --once, or --executor deterministic for a free run."),
    createdAt: 0,
  };
}

export interface DemoNativeLane {
  readonly safe_mode: boolean;
  readonly hook_bus: NativeExecutorEnvironment["hook_bus"];
  readonly hook_catalog: NativeExecutorEnvironment["hook_catalog"];
  readonly native_environment: NativeExecutorEnvironment;
  readonly native_selection: NativeHarnessExecutionReadiness;
  readonly native_readiness: NativeHarnessReadinessService;
  readonly harness_integrations: HarnessIntegrationRegistry<CampaignHarnessIntegration>;
  readonly task_attachment_store: TaskAttachmentStore;
  readonly recovery_leases: ReturnType<typeof createWorktreeRecoveryLeaseAuthority>;
  /** The box `composeNativeExecutorEnvironment` records hook evidence against; the caller fills it with the runtime it builds. */
  readonly runtime_box: { current: ArborRuntime | null };
  readonly native_executor: () => NativeAgentExecutor | null;
  readonly operator_doctor_integration: ReturnType<typeof inspectHarnessIntegrationEnvironment>;
}

/**
 * `arbor run`'s native lane, composed by `createCliRuntime`'s own helpers.
 *
 * ADR-142 §2 extracted `composeNativeExecutorEnvironment` precisely so this
 * composition root could build the native lane the way `serve`/`webui` do.
 * Until it called it, `arbor run` reached no hook bus at all: every one of the
 * ten devolved host hooks was provable only through `arbor task`, and nothing
 * detected the absence on the entry point that actually runs campaigns.
 *
 * Every dependency is the real one — the same credential resolution, catalog
 * loading, plugin trust set, attachment store, recovery lease authority and
 * native executor builder `createCliRuntime` uses. A simplified stand-in here
 * would be the divergent double that module's header forbids, and a hook bus
 * assembled differently is a security difference, not a style one.
 *
 * `safe_mode` honours `ARBOR_SAFE_MODE` exactly as `createCliRuntime` does: an
 * empty `HookCatalog` rather than `fromDirectory`, so no descriptor and no
 * plugin is loaded on a safe-mode run. The organization-policy layer is read
 * through `resolveCliOrganizationPolicy` for the same reason `createCliRuntime`
 * reads it, so a policy-declared safe mode is honoured here too.
 */
export function composeDemoNativeLane(input: {
  readonly cwd: string;
  readonly config: ArborConfig;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly persistence_dir: string;
}): DemoNativeLane {
  const organizationPolicy = resolveCliOrganizationPolicy(input.cwd, input.environment);
  const safeMode = input.environment.ARBOR_SAFE_MODE === "1" || organizationPolicy?.startup.safe_mode === true;
  const runtimeBox: { current: ArborRuntime | null } = { current: null };
  const recoveryLeases = createWorktreeRecoveryLeaseAuthority({ repo_root: input.cwd });
  const taskAttachmentStore = new TaskAttachmentStore(input.persistence_dir);
  // No director is composed without a governance admission authority, for
  // `createCliRuntime`'s own documented reason: a hook that can never admit
  // fails every campaign turn with a message no operator can diagnose.
  const nativeEnvironment = composeNativeExecutorEnvironment({
    cwd: input.cwd, config: input.config, environment: input.environment, safe_mode: safeMode,
    persistence_dir: input.persistence_dir, organization_policy: organizationPolicy, runtime_box: runtimeBox,
  });
  const nativeSelection = resolveNativeHarnessExecutionReadiness(
    input.config.native, nativeEnvironment.native_credential, nativeEnvironment.native_adapters, nativeEnvironment.native_credential_selection.boundary,
  );
  const nativeReadiness = new NativeHarnessReadinessService({
    config: input.config,
    config_view: buildConfigInspection(input.cwd).inspect(),
    credential: nativeEnvironment.native_credential_selection.facts,
    adapters: nativeEnvironment.native_adapters,
    ...(nativeEnvironment.native_credential_selection.boundary === undefined ? {} : { credential_boundary: nativeEnvironment.native_credential_selection.boundary }),
  });
  const native_executor = (): NativeAgentExecutor | null => configuredNativeAgentExecutor(
    input.cwd, input.config, runtimeBox, nativeEnvironment.composition, taskAttachmentStore, undefined, recoveryLeases,
  );
  const harnessIntegrations = new HarnessIntegrationRegistry<CampaignHarnessIntegration>();
  if (nativeSelection.kind === "direct_native") {
    harnessIntegrations.register(createNativeHarnessConnectorDescriptor(undefined, true), {
      createExecutor() {
        const native = native_executor();
        if (native === null) throw new Error("native integration was selected without a native executor");
        return native;
      },
      createReviewer: ({ campaign_id }) => {
        const native = native_executor();
        if (native === null) throw new Error("native integration was selected without a native reviewer");
        return createNativePanelReviewer(native, campaign_id);
      },
    });
  }
  return {
    safe_mode: safeMode,
    hook_bus: nativeEnvironment.hook_bus,
    hook_catalog: nativeEnvironment.hook_catalog,
    native_environment: nativeEnvironment,
    native_selection: nativeSelection,
    native_readiness: nativeReadiness,
    harness_integrations: harnessIntegrations,
    task_attachment_store: taskAttachmentStore,
    recovery_leases: recoveryLeases,
    runtime_box: runtimeBox,
    native_executor,
    operator_doctor_integration: inspectHarnessIntegrationEnvironment(input.environment, undefined, nativeReadiness.inspect()),
  };
}

export async function demomain(argv: string[]): Promise<number> {
  let once = false;
  let persistenceDir = ".arbor";
  let executor: DemoOptions["executor"];
  // The lane is resolved ONCE, after parsing, by `resolveCampaignExecutorLane`
  // — on the default path as well as the `--executor` path. It used to be
  // hardcoded to "real" here and the resolver was consulted only when the flag
  // was passed, so the two decisions never compared: the resolver's own
  // documented default (native) was silently overridden, and the connector
  // fallback that `CampaignLaneResolution.fell_back_from` exists to make
  // non-silent was recorded on neither path.
  let requestedExecutor: CampaignExecutorRequest = undefined;
  let transport: DemoOptions["transport"] =
    process.env.ARBOR_OPENCODE_TRANSPORT === "server" ? "server" : "subprocess";
  let transportExplicit = false;
  let specialistModel: string | undefined;
  let criticModel: string | undefined;
  let verificationCmd: string | undefined;
  const verificationCmds: string[] = [];
  // Real-agent policy lives here, not in the library defaults.
  //
  // `opencode-executor.ts`'s 120_000ms default and arbor-config's 600s
  // `max_seconds` were both sized for the DETERMINISTIC executor, which
  // answers instantly. Against a real model they are not conservative, they
  // are wrong: every specialist in every real campaign on 2026-08-08 was
  // aborted mid-work at the two-minute ceiling and recorded the identical
  // failure_mode "timeout: fetch failed: The operation was aborted." Not one
  // reached a critic, which is why zero nodes ever verified. And a 600s
  // campaign budget cannot fit even one 900s specialist, let alone a tree.
  //
  // 15 minutes per dispatch and a 2-hour campaign budget are the defaults a
  // real coding agent actually needs; both are overridable per run.
  let specialistTimeoutSec = 900;
  let budgetSec = 7200;
  const extra: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--once") { once = true; }
    else if (argv[i] === "--persistence-dir" && i + 1 < argv.length) { persistenceDir = argv[++i]; }
    else if (argv[i] === "--executor" && i + 1 < argv.length) {
      // ADR-142: an unrecognised lane is refused rather than silently treated
      // as the default. This branch only RECORDS the request; the resolution
      // happens once after parsing so the default path cannot disagree with it.
      try { requestedExecutor = parseCampaignExecutorRequest(argv[++i]); }
      catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); return 1; }
    }
    else if (argv[i] === "--transport" && i + 1 < argv.length) {
      const v = argv[++i];
      if (v !== "subprocess" && v !== "server") {
        process.stderr.write(`unknown transport: ${v} (expected "subprocess" or "server")\n`);
        return 1;
      }
      transport = v;
      transportExplicit = true;
    }
    else if (argv[i] === "--model" && i + 1 < argv.length) { specialistModel = argv[++i]; }
    else if (argv[i] === "--critic-model" && i + 1 < argv.length) { criticModel = argv[++i]; }
    else if (argv[i] === "--verification-cmd" && i + 1 < argv.length) {
      const cmd = argv[++i];
      // An empty value was falsy, became `undefined`, and silently disabled
      // verification with no error and no log — a run that looked configured
      // and verified nothing.
      if (cmd.trim() === "") { process.stderr.write("--verification-cmd expects a non-empty command\n"); return 1; }
      verificationCmds.push(cmd);
      verificationCmd = cmd;
    }
    else if (argv[i] === "--timeout" && i + 1 < argv.length) {
      const v = Number.parseInt(argv[++i], 10);
      if (!Number.isFinite(v) || v <= 0) { process.stderr.write(`--timeout expects a positive number of seconds\n`); return 1; }
      specialistTimeoutSec = v;
    }
    else if (argv[i] === "--budget" && i + 1 < argv.length) {
      const v = Number.parseInt(argv[++i], 10);
      if (!Number.isFinite(v) || v <= 0) { process.stderr.write(`--budget expects a positive number of seconds\n`); return 1; }
      budgetSec = v;
    }
    else { extra.push(argv[i]); }
  }

  // Containment: `arbor run`/`arbor demo` is a production composition root
  // exactly like `serve`/`webui` (`createCliRuntime` in cli.ts) — it owns a
  // persistence root of its own (ledger/devtools/kb under `--persistence-dir`),
  // not merely a target it inspects. `serve`/`webui` already refuse an
  // implicit/absolute/`..`-escaping `ARBOR_PERSISTENCE_DIR` via
  // `resolvePersistenceDir`; before this, `run`/`demo` parsed `--persistence-dir`
  // itself and passed it straight to `ArborRuntime` unchecked, so the same
  // conceptual setting was sandboxed on one entrypoint and unguarded on the
  // one an operator is most likely to run for real autonomous campaign work.
  // Reusing `resolvePersistenceDir` (rather than re-deriving the rule) keeps
  // there being exactly one definition of "contained" in this package.
  //
  // Contrast `ledger-command.ts`'s `--dir`, deliberately left uncontained —
  // see that file's own header comment: it names an existing ledger the
  // operator points this command AT (verify/repair a backup elsewhere on
  // disk), not this process's own working-state directory.
  try {
    persistenceDir = resolvePersistenceDir(process.cwd(), persistenceDir);
  } catch (error) {
    process.stderr.write(`arbor run: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_CODES.USAGE;
  }

  if (extra.length > 0 && extra[0] !== "--help" && extra[0] !== "-h") {
    process.stderr.write(`unknown demo flag: ${extra[0]}\n`);
    return 1;
  }

  if (extra[0] === "--help" || extra[0] === "-h") {
    process.stdout.write("arbor run [--once] [--executor native|deterministic] [--persistence-dir <dir>] [--model <m>] [--critic-model <m>]  (alias: arbor demo)\n");
    process.stdout.write("  --once              Run one campaign, render ~2s, exit.\n");
    process.stdout.write("  --executor          native (default; the Canopy harness, revoy-native)\n");
    process.stdout.write("                        | deterministic (seeded, no network — for tests / offline).\n");
    process.stdout.write("                        `real` is a deprecated alias for the default. There is no\n");
    process.stdout.write("                        connector fallback: an unready native lane is an error.\n");
    process.stdout.write("                        | opencode: DEPRECATED until after 1.0.0; refused unless arbor.jsonc\n");
    process.stdout.write("                          sets connectors.allow_deprecated: true with connectors.reason.\n");
    process.stdout.write("  --transport         opencode lane only: subprocess (default) | server.\n");
    process.stdout.write("                        Also settable via ARBOR_OPENCODE_TRANSPORT=server.\n");
    process.stdout.write(`  --model             Specialist model (default ${DEFAULT_SPECIALIST_MODEL}).\n`);
    process.stdout.write(`  --critic-model      Critic model (default ${DEFAULT_CRITIC_MODEL}, a stable OpenRouter alias).\n`);
    process.stdout.write("  --persistence-dir   Root persistence directory (default: .arbor).\n");
    process.stdout.write("  --timeout <sec>     Per-dispatch ceiling for a real specialist/critic call (default 900).\n");
    process.stdout.write("                        The old 120s default was sized for the deterministic executor\n");
    process.stdout.write("                        and aborted every real specialist mid-work.\n");
    process.stdout.write("  --budget <sec>      Campaign wall-clock budget for a real run (default 7200).\n");
    process.stdout.write("                        Must exceed --timeout, or the campaign halts before its first\n");
    process.stdout.write("                        node returns. arbor.jsonc tree_search.max_seconds overrides.\n");
    process.stdout.write("  --verification-cmd  Repeatable: each occurrence is one ordered, fail-fast stage run\n" +
    "                      inside a specialist's real git worktree; all exiting 0 makes\n");
    process.stdout.write("                        provenance genuinely `!verified` instead of `!claimed`. opencode\n");
    process.stdout.write("                        lane only; the native lane runs verification.acceptance_commands.\n");
    process.stdout.write("\n  Default (no --once): run campaigns back-to-back (player-piano).\n");
    process.stdout.write("  Worktree isolation (ADR-001) is always on: every specialist dispatch runs in a real,\n");
    process.stdout.write("  leased git worktree under <cwd>/.worktrees/.\n");
    return 0;
  }

  // The ONE lane decision, taken on every path, before the writer lock so a
  // refused lane creates nothing on disk. Canopy-only (amends ADR-061): the
  // default is the native lane and nothing falls back; `--executor opencode`
  // is refused with a typed ADR-179 remedy unless `connectors.allow_deprecated`
  // admits it. Native readiness is read from the same credential and
  // adapter resolution `composeDemoNativeLane` uses below.
  const cwd = process.cwd();
  let arborConfig: ArborConfig;
  let lane: CampaignLaneResolution;
  try {
    arborConfig = loadConfig(cwd);
    const credential = resolveNativeCredentialSelection(arborConfig, process.env);
    const readiness = resolveNativeHarnessExecutionReadiness(arborConfig.native, credential.overlay, createReferenceNativeModelAdapterRegistry(fetch), credential.boundary);
    lane = resolveCampaignExecutorLane({
      ...(requestedExecutor === undefined ? {} : { requested: requestedExecutor }),
      native_available: readiness.kind === "direct_native",
      ...(readiness.kind === "direct_native" ? {} : { native_unavailable_reason: `${readiness.kind}: ${readiness.reason}` }),
      config: arborConfig,
    });
  } catch (error) {
    process.stderr.write(`arbor run: ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof DeprecatedHarnessRefusal ? EXIT_CODES.USAGE : EXIT_CODES.FAILURE;
  }
  if (lane.deprecated_admission !== undefined) process.stderr.write(`[executor] ${lane.reason}\n`);
  // Connector-only flags are refused on any other lane rather than ignored:
  // an operator who passed them believes they changed something.
  if (lane.lane !== "opencode" && transportExplicit) {
    process.stderr.write("arbor run: --transport selects the deprecated opencode connector's transport and has no meaning on the " + lane.lane + " lane\n");
    return EXIT_CODES.USAGE;
  }
  if (lane.lane === "native" && verificationCmds.length > 0) {
    process.stderr.write("arbor run: --verification-cmd is an opencode-connector option; on the Canopy lane declare verification.acceptance_commands in arbor.jsonc\n");
    return EXIT_CODES.USAGE;
  }
  executor = lane.lane === "deterministic" ? "deterministic" : "real";

  // WA-16 (ADR-029): `arbor run`/`arbor demo` is a production composition
  // root exactly like `serve`/`webui` — it owns a persistence directory and
  // drives real campaign writes against it (ledger, snapshot, devtools,
  // kb). Before this, only `serve`/`webui`/`task` took the single-writer
  // lock; a second `demomain` (or `serve`/`webui`) pointed at the same
  // directory could race this process's in-flight campaign writes exactly
  // as WA-15's `task confirm --wait` case did. `takeWriterLock` is the same
  // primitive and stale-pid reclaim semantics `serve`/`webui` use — see its
  // doc comment in cli.ts.
  const lock = takeWriterLock(persistenceDir, "run", process.stderr);
  if (lock === null) return EXIT_CODES.CONFLICT;
  try {

  const options: DemoOptions = {
    ...DEFAULT_DEMO_OPTIONS, once, persistenceDir, executor, transport,
    specialistModel, criticModel, verificationCmd,
    ...(verificationCmds.length === 0 ? {} : { verificationCmds }),
    specialistTimeoutMs: specialistTimeoutSec * 1000,
    stdout: process.stdout, stderr: process.stderr,
  };

  installScreens();

  const worktreeManager = new WorktreeManager({ repoRoot: cwd });

  // ADR-142 §2: the native lane, composed the way `createCliRuntime` composes
  // it. `arbor run` is a production composition root, so the ten devolved
  // native hooks have to be reachable here and not only from `serve`/`webui`.
  const nativeLane = composeDemoNativeLane({ cwd, config: arborConfig, environment: process.env, persistence_dir: options.persistenceDir });
  // Bind the resolved lane to the harness that will actually run it. The
  // pre-lock readiness and this composition read the same inputs; if they
  // ever disagree the run refuses rather than stamping a native claim on
  // anything else.
  if (lane.lane === "native") {
    const native = nativeLane.harness_integrations.inspect(CANOPY_CONNECTOR_ID);
    if (native === null) {
      process.stderr.write(`arbor run: the Canopy lane was resolved but did not compose (${nativeLane.native_selection.kind}); refusing rather than falling back\n`);
      return EXIT_CODES.FAILURE;
    }
    options.liveLane = { kind: "native", integration: native.integration, connector: native.connector };
  } else if (lane.lane === "opencode" && lane.deprecated_admission !== undefined) {
    options.liveLane = { kind: "opencode", admission: lane.deprecated_admission };
  }

  const runtime = new ArborRuntime({
    persistence_dir: options.persistenceDir,
    // A-7: the same real config/agent sources `createCliRuntime` composes
    // for `serve`/`webui` — the `config.get`/`agent.list` catalog queries
    // reflect this repo's actual `arbor.jsonc` and agent catalog here too.
    config_inspection: buildConfigInspection(cwd),
    agent_definitions: buildAgentDefinitionSource(),
    // A-7: the same real live provider-capability query `createCliRuntime`
    // composes — see `OpenCodeProviderCapabilityAdapter`'s doc comment in
    // cli.ts. `arbor demo`/`arbor run` is a production composition root too;
    // leaving it unfed here while `serve`/`webui` had it would be the same
    // "changes nothing for this entry point" gap this field's history warns
    // against.
    model_capabilities: new OpenCodeProviderCapabilityAdapter(),
    // The native lane, so this runtime's connector inventory and its operator
    // doctor report the same readiness `createCliRuntime` reports. Absent
    // before, which is how a `arbor run` campaign could execute with no hook
    // bus in existence at all.
    harness_integrations: nativeLane.harness_integrations,
    harness_connector_registry: nativeLane.harness_integrations.connectors,
    native_harness_readiness: nativeLane.native_readiness,
    operator_doctor_integration: nativeLane.operator_doctor_integration,
  });
  // The hook bus records every firing into this runtime's durable session
  // journal, so the box has to name the runtime the instant it exists.
  nativeLane.runtime_box.current = runtime;
  let runtimeWorkError: unknown;
  let runtimeWorkFailed = false;
  let runtimeStartSucceeded = false;
  try {
  const started = await runtime.start();
  if (!started.ok) {
    options.stderr.write(started.failures.map((f) => f.summary).join("; ") || "runtime did not start\n");
    return 1;
  }
  runtimeStartSucceeded = true;

  // Raw output requires a matching durable approval inside the router; the
  // demo deliberately does not synthesize one.
  const router = new RuntimeCatalogRouter(runtime);
  const adapter = new RuntimePortAdapter(router, () => runtime.operations.list().length);

  // Mirror runTui's composition
  const termCols = (process.stdout.columns && process.stdout.columns > 0) ? process.stdout.columns : 120;
  const termRows = (process.stdout.rows && process.stdout.rows > 0) ? process.stdout.rows : 40;
  const nav = createNavigation(
    { id: "main", route: "campaigns", panes: [{ id: "main", title: "Campaigns" }], split: "horizontal", ratio: 0.5 },
    { columns: termCols, rows: termRows },
  );

  const renderer = new StdoutRenderer(options.stdout, { clear_screen: true });

  const harness = new HeadlessHarness({
    client: { connect: () => {}, disconnect: () => {}, requestSnapshot: () => {}, close: () => {}, interruptCampaign: () => {} },
    terminal: { restore: () => {} },
    clock: { now: () => Date.now() },
    telemetrySource: createCockpitTelemetrySource(runtime),
    runtime: {
      command: (request: { kind: string; metadata: { operation_id: string; idempotency_key: string }; params?: Record<string, unknown> }) =>
        adapter.command({ ...request, params: request.params ?? {} }) as never,
      query: (request: { kind: string; query_id: string; params: Record<string, unknown> }) =>
        adapter.query(request) as never,
      activeOperationCount: () => adapter.activeOperationCount(),
    } as never,
  });

  // Cost disclosure, in-band. See realExecutorDisclosure's doc comment.
  const disclosure = realExecutorDisclosure(options);
  if (disclosure !== null) {
    await harness.dispatch({ type: "notification_added", notification: disclosure } as never);
  }

  await harness.dispatch({ type: "screen_changed", screen: "campaigns" });
  // The screens render only when their required capabilities are granted; the
  // model defaults to an empty set, so grant the demo screens' capabilities or
  // the TUI renders an empty frame (an earlier blocker).
  await harness.dispatch({ type: "grants_updated", capabilities: ["campaign.read", "campaign.write", "tree.read", "tree.write", "tree.interrupt", "task.read", "task.retry", "operation.read", "operation.cancel", "recovery.write", "recovery.abandon", "output.read", "output.capture", "communication.read", "communication.write", "event.read", "config.read", "agent.read", "job.read", "job.write", "approval.read", "approval.request", "approval.decide", "devtools.read"] } as never);

  const shell = new TuiShell({
    renderer,
    projection: () => {
      const app = harness.model;
      const content = app.snapshot !== null ? "running" : "loading";
      return { app, navigation: nav, output: { content, evidence_pointer: undefined } } as never;
    },
    cadence: timerCadence,
    signals: createProcessSignalPort(),
    frame_interval_ms: options.frameIntervalMs,
  });

  options.stderr.write(`arbor run — autonomous tree-search campaign${options.once ? " (--once)" : " (continuous)"}\n`);
  options.stderr.write(`  persistence: ${options.persistenceDir}/devtools/devtools.log\n`);
  options.stderr.write(`  worktrees: ${cwd}/.worktrees (ADR-001 isolation, always on)\n`);
  options.stderr.write(`  Keys: 0-9=screen  d=devtools  i=interrupt  h=halt  q=quit\n`);

  await shell.start();

  const demoScreens: readonly import("@arbor/tui").ScreenId[] =
    ["campaigns", "diagnostics", "tasks", "operations", "output", "communications", "config", "agents", "jobs", "approvals"];
  // Built once and reused for both real stdin bytes (via attachKeyboardInput
  // below) and the auto-cycle's synthesized keys (pollTick) — one entry point,
  // one keymap, no parallel-authority path between "operator pressed a key"
  // and "the demo pretended a key was pressed".
  const keyHandler = createKeyboardHandler({
    onScreenChange: (screen) => { void harness.dispatch({ type: "screen_changed", screen }); },
    onCommand: (kind) => {
      if (kind === "halt") {
        const active = runtime.manager.getActiveCampaignId();
        if (active) runtime.manager.completeAutoHalt(active, "manual");
      }
    },
    onInterrupt: () => {
      const active = runtime.manager.getActiveCampaignId();
      if (!active) return;
      const expanding = runtime.manager.getActiveExpandingNode(active);
      if (!expanding) return;
      runtime.interrupt({
        campaign_id: active, node_id: expanding, operation_id: `demo:interrupt:${Date.now()}`,
        scope: "node", reason: "operator-interrupt",
        expected_version: runtime.manager.getCampaignVersion(active),
        partial_evidence_ids: [], provenance: { tag: "claimed", claimant: "operator" },
      });
    },
    onQuit: () => { done = true; if (settleTimer) clearTimeout(settleTimer); },
    screens: demoScreens,
  });
  const detachKeyboard = attachKeyboardInput(process.stdin, keyHandler);

  let done = false;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const activeCampaigns = new Set<Promise<void>>();

  // G-16: a real AbortController, passed into every runCampaign call below —
  // SIGINT/SIGTERM previously only flipped `done`, which the poll loop
  // notices only after the in-flight campaign runs to completion. Aborting
  // this controller lets runCampaign's cooperative cancellation path stop a
  // mid-flight campaign immediately (loop.ts's per-iteration signal check and
  // the executor-level signal it forwards to opencode/fetch calls).
  const abortController = new AbortController();
  const signalHandler = (): void => {
    done = true;
    if (settleTimer) clearTimeout(settleTimer);
    abortController.abort(new Error("operator SIGINT/SIGTERM"));
  };
  process.on("SIGINT", signalHandler);
  process.on("SIGTERM", signalHandler);

  let campaignIndex = 0;
  let campaignSeed = 42;

  const autoScreens: readonly import("@arbor/tui").ScreenId[] = ["campaigns", "diagnostics", "devtools", "tasks", "operations"];
  let autoScreenIdx = 0;
  let lastScreenSwitch = 0;
  const SCREEN_SWITCH_INTERVAL_MS = 4000;

  const feedScreen = async (screen: import("@arbor/tui").ScreenId, value: unknown): Promise<void> => {
    await harness.dispatch({ type: "query_results", queryId: `demo:${screen}`, screen, value } as never);
  };

  /**
   * Ask for telemetry whenever the active campaign changes.
   *
   * The status bar's campaign/events/budget/model zones read
   * `AppModel.telemetrySnapshot`, which is only ever set by the
   * telemetry_requested -> fetch_telemetry -> telemetry_received path. That
   * whole path existed and worked; nothing in production ever ENTERED it, so
   * `telemetrySnapshot` stayed null forever and status-bar.ts — which
   * correctly refuses to fabricate — rendered four permanent em dashes beside
   * a live, animating epoch counter. Classic Unreached: a complete
   * intent/effect/reducer chain with no emitter.
   *
   * Gated on the campaign actually changing rather than fired per frame:
   * `telemetry_requested` bumps the epoch and appends a notification every
   * time, so a per-frame dispatch would spam the notification ring and make
   * the epoch counter meaningless as an activity signal.
   */
  let lastTelemetryCampaign: string | null = null;
  const refreshTelemetry = async (): Promise<void> => {
    const active = runtime.manager.getActiveCampaignId();
    if (!active || active === lastTelemetryCampaign) return;
    lastTelemetryCampaign = active;
    await harness.dispatch({ type: "telemetry_requested", campaignId: active, at: 0 } as never);
  };

  const feedAutoScreens = async (): Promise<void> => {
    // Route each auto-cycled screen's data to its own per-screen slot (4F.1).
    // (The active campaign id was only used to synthesise a placeholder
    // campaigns row when the real query returned none. An empty list is the
    // honest projection of "no campaigns" — the screen renders its own
    // "(no campaigns)" for it — so the placeholder, and this read, are gone.)
    const cursor = runtime.eventStream.cursor().sequence.toString();

    try {
      const tasks = await adapter.query({ kind: "task.list", query_id: "demo:tasks", params: { limit: 8 } });
      if (tasks.ok) {
        await feedScreen("tasks", (tasks.value as { items?: unknown[] }).items ?? []);
      }
    } catch { /* best-effort */ }

    try {
      const events = await adapter.query({ kind: "event.resume", query_id: "demo:events", params: { cursor } });
      if (events.ok) {
        const evs = (events.value as { events?: readonly Record<string, unknown>[] }).events ?? [];
        await feedScreen("diagnostics", evs);
        await feedScreen("operations", evs);
      }
    } catch { /* best-effort */ }

    const stream = adapter.devtoolsStream();
    if (stream.lines.length > 0) {
      await feedScreen("devtools", stream);
    }

    try {
      const campaigns = await adapter.query({ kind: "campaign.list", query_id: "demo:campaigns", params: { limit: 20 } });
      if (campaigns.ok) {
        // Pass `campaign.list` through unchanged. This used to rename its
        // fields into {name, status, node_count, verified_count} — the third
        // site in this repository to invent that shape, after
        // frame-resource.ts and screens/campaigns.ts's own guards. The screen
        // now reads the runtime's real field names, so translating here would
        // blank the demo's campaigns table exactly as the guards used to blank
        // the live one. It was also wrong on its own terms:
        // `verified_count: iterations_completed` reported iterations as
        // verified nodes, which are different quantities.
        const items = (campaigns.value as { items?: Array<Record<string, unknown>> }).items ?? [];
        await feedScreen("campaigns", items);
      }
    } catch { /* best-effort */ }
  };

  const pollTick = async (): Promise<void> => {
    if (done) return;

    const now = Date.now();
    if (now - lastScreenSwitch > SCREEN_SWITCH_INTERVAL_MS) {
      // The *which* is driven solely by the autoScreenIdx step counter (never
      // Date.now()/Math.random()), so the key sequence — and the frames it
      // produces — stays reproducible run to run. Date.now() above only gates
      // *when* the next tick is due, same as before this change.
      autoScreenIdx = (autoScreenIdx + 1) % autoScreens.length;
      const nextScreen = autoScreens[autoScreenIdx];
      const digit = demoScreens.indexOf(nextScreen);
      // Every member of `autoScreens` is now reachable through `keyHandler`
      // — the nine digit-bound screens plus "devtools", which keyboard.ts
      // now binds to the real, non-digit key `d` (demoScreens' ten digit
      // slots were already fully claimed, so devtools never had a spare
      // digit). No direct `harness.dispatch({type:"screen_changed"})`
      // remains: the auto-cycle exercises the same keymap entry a real
      // operator keystroke uses, for every screen it cycles through.
      keyHandler(digit >= 0 ? String(digit) : "d");
      lastScreenSwitch = now;
    }

    await feedAutoScreens();
    await refreshTelemetry();
    shell.invalidate();
  };

  const campaignLoop = async (): Promise<void> => {
    while (!done) {
      const seed = campaignSeed++;
      const idx = campaignIndex++;
      const campaignPromise = runOneCampaign(
        runtime, adapter, idx, seed, options, abortController.signal,
        worktreeManager,
        // The wall-clock budget must be able to contain the dispatches it
        // authorises. arbor.jsonc's `tree_search.max_seconds` wins when set;
        // otherwise a real-executor run uses `--budget` (default 2h) rather
        // than the library's 600s, which cannot fit even one 15-minute
        // specialist and would halt the campaign budget_exhausted before its
        // first node ever returned.
        executor === "real"
          ? { max_seconds: budgetSec, ...campaignConfigFromArborConfig(arborConfig) }
          : campaignConfigFromArborConfig(arborConfig),
      );
      activeCampaigns.add(campaignPromise);
      await campaignPromise;
      activeCampaigns.delete(campaignPromise);
      if (options.once) {
        settleTimer = setTimeout(() => { done = true; }, options.settleDelayMs);
        while (!done) { await pollTick(); await new Promise<void>((r) => setTimeout(r, options.pollIntervalMs)); }
        break;
      }
      const settleStart = Date.now();
      while (Date.now() - settleStart < 500 && !done) {
        await pollTick();
        await new Promise<void>((r) => setTimeout(r, options.pollIntervalMs));
      }
    }
  };

  const loopPromise = campaignLoop();
  while (!done) { await pollTick(); await new Promise<void>((r) => setTimeout(r, options.pollIntervalMs)); }
  await loopPromise;

  process.off("SIGINT", signalHandler);
  process.off("SIGTERM", signalHandler);
  detachKeyboard();

  await shell.stop();
  renderer.restore();
  return 0;
  } catch (error) {
    runtimeWorkError = error;
    runtimeWorkFailed = true;
    throw error;
  } finally {
    const closed = await runtime.close();
    if (!closed.ok && runtimeStartSucceeded) {
      const closeError = new Error(`runtime shutdown failed: ${closed.failures.map((failure) => failure.summary).join("; ") || "unknown failure"}`);
      if (runtimeWorkFailed) throw new AggregateError([runtimeWorkError, closeError], "demo work and runtime shutdown both failed");
      throw closeError;
    }
  }
  } finally { lock.release(); }
}
