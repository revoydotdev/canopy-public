/**
 * `arbor-mcp selfhost` — run a REAL, LLM-backed campaign against revoy2's own
 * source, with isolation PROVEN before anything autonomous ever executes.
 *
 * This is Track B's foundation: `/usr/local/bin/opencode` exists and provider
 * keys are in the environment, so a real executor can run — and a real
 * executor modifies files. That makes isolation non-negotiable, not a nice-
 * to-have. Every campaign this module drives:
 *
 *   1. is checked against a fail-closed isolation gate BEFORE any worktree,
 *      runtime, or executor is constructed (`checkTargetIsolationSafety` /
 *      `evaluateTargetSafety`);
 *   2. runs inside a dedicated git worktree on a throwaway branch this
 *      module itself creates (`arbor/selfhost/<run-id>`), never the checkout
 *      it was invoked from;
 *   3. is bounded by a required iteration cap and a required wall-clock cap
 *      (no defaults — a caller must state both);
 *   4. never pushes, never merges, and only ever deletes the branch/worktree
 *      it created itself, on its own successful or failed exit.
 *
 * The isolation gate (`evaluateTargetSafety`) is a pure function over an
 * already-resolved path and branch name — no filesystem or git access — so
 * its refusal logic is directly unit-testable. `checkTargetIsolationSafety`
 * is the thin IO shell (realpath + `git rev-parse`) that feeds it.
 *
 * Composition reuses the same production stack every other CLI transport
 * uses (`createCliRuntime`, `RuntimeCatalogRouter`, `RuntimePortAdapter`,
 * `composeLoopConfigPorts`, `@arbor/opencode`'s `runCampaign`/
 * `WorktreeManager`) — rooted at the throwaway worktree path instead of the
 * invocation cwd, so recovery leases, KB backend, config inspection, and
 * per-node worktree isolation are all genuinely scoped inside it. There is no
 * second, parallel runtime stack here.
 *
 * The executor is the REAL one (`createOpenCodeLoopExecutor`, the same
 * subprocess-based `opencode run` executor `arbor run --executor real` uses)
 * unless a caller supplies `executorOverride` — a test-only hook so the
 * isolation/cap tests in `selfhost.test.ts` stay hermetic (no network, no
 * `opencode` binary required) without ever touching the production default.
 * `cli.ts`'s `selfhost` subcommand never sets it.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createCliRuntime, DEFAULT_NATIVE_CAMPAIGN_REQUIREMENTS } from "./cli.js";
import {
  resolvePrimaryCheckout,
  resolveHarnessSourceCheckout,
  FORBIDDEN_BRANCHES,
  FORBIDDEN_WORKER_BASENAME_PATTERN,
  evaluateTargetSafety,
  readCurrentBranch,
  checkTargetIsolationSafety,
  type SelfhostGuardErrorKind,
  type SelfhostGuardError,
  type IsolationGuardConfig,
} from "./target-isolation-guard.js";
export {
  resolvePrimaryCheckout,
  resolveHarnessSourceCheckout,
  FORBIDDEN_BRANCHES,
  FORBIDDEN_WORKER_BASENAME_PATTERN,
  evaluateTargetSafety,
  readCurrentBranch,
  checkTargetIsolationSafety,
  type SelfhostGuardErrorKind,
  type SelfhostGuardError,
  type IsolationGuardConfig,
};
import { EXIT_CODES } from "./exit-codes.js";
import { loadConfig } from "@arbor/config";
import { RuntimeCatalogRouter } from "./runtime-catalog.js";
import { devtoolsHookForRuntime } from "./devtools-log.js";
import { RuntimePortAdapter } from "./tui-adapter.js";
import { createOpenCodeLoopExecutor, DEFAULT_SPECIALIST_MODEL, DEFAULT_CRITIC_MODEL } from "./opencode-executor.js";
import { createOpenCodeDecomposer } from "./opencode-decomposer.js";
import { admitDeprecatedHarnessLane, recordDeprecatedHarnessAdmission } from "./canopy-lane-policy.js";
import { ManagerScoreContextAdapter } from "./loop-adapters.js";
import { composeLoopConfigPorts } from "./loop-ports-helper.js";
import { captureWorktreeResult, composeCapturedResults, listCapturedResults, readCapturedComposition } from "./result-adoption.js";
import {
  runCampaign,
  WorktreeManager,
  provisionWorktreeDependencies,
  type CampaignLoopConfig,
  type CampaignReport,
  type LoopExecutor,
  type DependencyProvisioningOptions,
  type DependencyProvisioningOutcome,
} from "@arbor/opencode";
import type { Action, DecomposerPort } from "@arbor/core";
import {
  deriveBacklog,
  selectNextBacklogItem,
  renderBrief,
  type BacklogItem,
  type GovernanceError,
} from "@arbor/governance";

// ============================================================
// THROWAWAY WORKTREE — the whole campaign's isolation boundary.
// ============================================================

export interface SelfhostWorktreePlan {
  readonly branch: string;
  readonly path: string;
}

/** Deterministic given `runId` — no clock or randomness inside, so dry-run planning is reproducible. */
export function planSelfhostWorktree(targetResolvedPath: string, runId: string): SelfhostWorktreePlan {
  return {
    branch: `arbor/selfhost/${runId}`,
    path: join(targetResolvedPath, ".worktrees", `selfhost-${runId}`),
  };
}

/** Only the CLI's real-run path uses this; tests supply their own explicit `runId` for determinism. */
export function defaultRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Create the throwaway worktree + branch. Always a NEW branch (`-b`) — never reuses or touches an existing one. */
/**
 * Is this run's identity already claimed?
 *
 * Checked BEFORE `git worktree add` and by direct inspection rather than by
 * parsing git's stderr: that text is locale- and version-dependent, and
 * matching on it is the same class of fragility this repository rejected when
 * it removed `localeCompare` from its hashing and ordering paths. A ref query
 * and a path check answer the question exactly.
 */
function claimedIdentity(
  targetResolvedPath: string,
  plan: SelfhostWorktreePlan,
): string | null {
  if (existsSync(plan.path)) {
    return `worktree path ${plan.path} already exists`;
  }
  const ref = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${plan.branch}`], {
    cwd: targetResolvedPath,
    stdio: "pipe",
    encoding: "utf-8",
  });
  if (ref.status === 0) {
    return `branch ${plan.branch} already exists`;
  }
  return null;
}

/**
 * `git worktree add` alone leaves an empty checkout: no `node_modules`, so
 * every verification command the campaign might run (including revoy2's own
 * `bun run build && bun run test:all && bun run gate:all` acceptance lane)
 * dies immediately. Provisioning failure fails the worktree honestly — the
 * worktree/branch this call just created are torn down rather than handed
 * back half-usable — mirroring `WorktreeManager.acquireLease`'s same
 * dependency-provisioning-then-fail-closed sequence in
 * `@arbor/campaign-support`'s `worktree.ts`.
 */
function createSelfhostWorktree(
  targetResolvedPath: string,
  plan: SelfhostWorktreePlan,
  dependencyProvisioning: DependencyProvisioningOptions,
): { ok: true; provisioning: DependencyProvisioningOutcome } | { ok: false; error: string } {
  mkdirSync(dirname(plan.path), { recursive: true });
  const result = spawnSync("git", ["worktree", "add", "-b", plan.branch, plan.path, "HEAD"], {
    cwd: targetResolvedPath,
    stdio: "pipe",
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || result.stdout || `git worktree add exited ${result.status}`).trim() };
  }
  const provisioning = provisionWorktreeDependencies(plan.path, dependencyProvisioning);
  if (provisioning.status === "failed") {
    removeSelfhostWorktree(targetResolvedPath, plan);
    return { ok: false, error: `dependency install failed (${provisioning.ecosystem} via ${provisioning.argv.join(" ")}): ${provisioning.detail}` };
  }
  return { ok: true, provisioning };
}

/**
 * Best-effort teardown of a worktree and branch this module created in this
 * same run. Never invoked on anything this run did not itself create —
 * `plan.branch`/`plan.path` are always this run's own `arbor/selfhost/<runId>`
 * / `.worktrees/selfhost-<runId>` values, derived above from `runId`, which
 * `runSelfhostCampaign` validates against a safe charset before it is ever
 * joined into a path (an unvalidated `runId` containing `..`/path separators
 * would compute a path outside `targetResolvedPath`, and this function would
 * then force-remove and branch-delete against it).
 */
function removeSelfhostWorktree(targetResolvedPath: string, plan: SelfhostWorktreePlan): void {
  spawnSync("git", ["worktree", "remove", "--force", plan.path], { cwd: targetResolvedPath, stdio: "pipe" });
  spawnSync("git", ["branch", "-D", plan.branch], { cwd: targetResolvedPath, stdio: "pipe" });
}

// ============================================================
// SELFHOST CAMPAIGN
// ============================================================

export interface SelfhostOptions {
  /** Repo path to target. Checked by the isolation gate before anything else. */
  readonly targetRepo: string;
  /**
   * Description of the one task the campaign's root action pursues. Ignored
   * when `fromBacklog` is set — the task text is derived instead (see below).
   */
  readonly task: string;
  /**
   * Track B3: take the task from revoy2's own real governance backlog (the
   * POL-04 findings `@arbor/governance`'s `deriveBacklog` computes — accepted
   * ADR records that assert things nothing verifies) instead of the
   * hand-passed `task` string above. Selection is deterministic
   * (`selectNextBacklogItem`: first "author_obligations"-classified item in
   * the backlog's own stable tier/record_number order; `not_applicable`
   * items, e.g. ADR-023/ADR-025, are never selected). `task` is ignored when
   * this is set; the resolved brief flows through the SAME `task` field
   * everywhere else in this module, not a parallel path.
   */
  readonly fromBacklog?: boolean;
  /**
   * Required when `fromBacklog` is set. Threaded straight through to
   * `deriveBacklog`'s `at` (stamped onto its evidence timestamps only — it
   * does not affect which record is selected, since classification and
   * ordering are derived from record content, not the clock). No default:
   * the selection itself must never depend on wall-clock or randomness.
   */
  readonly backlogAt?: string;
  /** Hard iteration cap. Required — no default (ADR-023 blast-radius bound). */
  readonly maxIterations: number;
  /** Wall-clock cap in seconds. Required — no default. */
  readonly maxSeconds: number;
  /** Compose everything and report the plan; dispatch nothing to a model. */
  readonly dryRun?: boolean;
  /** Keep the throwaway worktree/branch after the run for inspection (default: remove it). */
  readonly keepWorktree?: boolean;
  readonly specialistModel?: string;
  readonly criticModel?: string;
  /**
   * D4: ordered, fail-fast staged verification. Each entry is one shell
   * command run in sequence in the worktree after the specialist, each on
   * its own timeout budget (`--verification-cmd`, repeatable at the CLI —
   * see `selfhostMain`). A single entry reproduces the prior single-command
   * behavior exactly.
   */
  readonly verificationCmds?: readonly string[];
  readonly opencodeBin?: string;
  /**
   * Dependency install for the throwaway worktree, run right after `git
   * worktree add` and before anything is dispatched. Default: enabled,
   * ecosystem auto-detected from the target repo's own lockfile (see
   * `@arbor/campaign-support`'s `dependency-provisioning.ts`). Pass
   * `{ enabled: false }` to skip — e.g. a caller that already knows the
   * worktree needs no verification command.
   */
  readonly dependencyProvisioning?: DependencyProvisioningOptions;
  /** Deterministic run identity. Omitted in production (derived from the clock); tests pass an explicit value. */
  readonly runId?: string;
  readonly guard?: IsolationGuardConfig;
  /**
   * Cooperative external cancellation (e.g. an OS SIGINT/SIGTERM), combined
   * with the internal wall-clock timer via `AbortSignal.any`. Without this,
   * a hard-killed process (no handler run) never reaches the `finally`
   * block below and leaves its throwaway worktree/branch orphaned — verified
   * empirically 2026-08-05 (a bash-tool timeout SIGTERM killed a selfhost run
   * with no handler registered, and its worktree/branch were left behind).
   * `selfhostMain` wires this to real process signals; tests may pass their
   * own controller's signal to prove the same cooperative-abort path without
   * touching process-global handlers.
   */
  readonly externalSignal?: AbortSignal;
  /**
   * Test-only hook. Omitting this (the CLI/production path always omits it)
   * means the REAL `createOpenCodeLoopExecutor` dispatches every specialist
   * and critic call. Isolation/cap tests inject a hermetic fake so they can
   * prove iteration/wall-clock behavior without a network call or an
   * `opencode` binary.
   */
  readonly executorOverride?: LoopExecutor;
  /**
   * Test-only hook, same shape as `executorOverride`. Omitting this (the
   * CLI/production path always omits it) means the REAL
   * `createOpenCodeDecomposer` handles every timeout->decompose dispatch.
   * Tests inject a hermetic fake so the wiring itself (FAULT_MATRIX's
   * timeout -> decompose recovery actually reaching a decomposer here, not
   * just in demo.ts) is provable without a network call or an `opencode`
   * binary.
   */
  readonly decomposerOverride?: DecomposerPort;
}

/**
 * Audit record of a Track B3 backlog selection — carried on `SelfhostPlan` so
 * the dry-run print (and the `ran` report) names which real backlog item was
 * picked, which real finding it derives from, and why, for a human to review
 * before anything is dispatched.
 */
export interface SelfhostBacklogSelection {
  readonly record_id: string;
  readonly title: string;
  readonly file_path: string;
  readonly decision_status: string;
  readonly rank_tier: 0 | 1 | 2;
  readonly finding_rule_id: string;
  readonly finding_detail: string;
  readonly total_backlog_items: number;
  readonly selection_reason: string;
}

export interface SelfhostPlan {
  readonly target_resolved_path: string;
  readonly target_branch: string;
  readonly worktree_branch: string;
  readonly worktree_path: string;
  readonly campaign_id: string;
  readonly task: string;
  readonly max_iterations: number;
  readonly max_seconds: number;
  readonly specialist_model: string;
  readonly critic_model: string;
  readonly dry_run: boolean;
  /** Present only when `SelfhostOptions.fromBacklog` was set. */
  readonly backlog_selection?: SelfhostBacklogSelection;
}

export type SelfhostOutcome =
  | { kind: "refused"; error: SelfhostGuardError }
  | { kind: "backlog_derivation_failed"; error: GovernanceError }
  | { kind: "backlog_empty"; total_backlog_items: number }
  /**
   * The run's identity is already taken — its branch or worktree path exists.
   * Distinct from `worktree_failed` (git broke) because this is a STATE
   * disagreement, not a fault: another run owns that identity, and with
   * `--run-id` pinnable a caller can genuinely collide with a live or
   * abandoned run. Maps to the registry's CONFLICT, never FAILURE.
   */
  | { kind: "identity_conflict"; plan: SelfhostPlan; detail: string }
  | { kind: "worktree_failed"; plan: SelfhostPlan; error: string }
  | { kind: "dry_run"; plan: SelfhostPlan }
  | { kind: "ran"; plan: SelfhostPlan; report: CampaignReport; dependency_provisioning: DependencyProvisioningOutcome; selected_integration_id: string };

function selectionReasonFor(item: BacklogItem, totalItems: number): string {
  return (
    `first "author_obligations"-classified item (rank_tier ${item.rank_tier}) in the ` +
    `derived backlog of ${totalItems} POL-04 finding(s), ordered by tier then ` +
    `record_number (see deriveBacklog); not_applicable items (e.g. ADR-023, ADR-025 ` +
    `as of this writing) are never selected because their own text disclaims a ` +
    `buildable mechanism — see selectNextBacklogItem`
  );
}

function buildPlan(
  safety: { resolvedPath: string; branch: string },
  worktree: SelfhostWorktreePlan,
  campaignId: string,
  task: string,
  options: SelfhostOptions,
  backlogSelection: SelfhostBacklogSelection | undefined,
): SelfhostPlan {
  return {
    target_resolved_path: safety.resolvedPath,
    target_branch: safety.branch,
    worktree_branch: worktree.branch,
    worktree_path: worktree.path,
    campaign_id: campaignId,
    task,
    max_iterations: options.maxIterations,
    max_seconds: options.maxSeconds,
    specialist_model: options.specialistModel ?? DEFAULT_SPECIALIST_MODEL,
    critic_model: options.criticModel ?? DEFAULT_CRITIC_MODEL,
    dry_run: options.dryRun ?? false,
    ...(backlogSelection ? { backlog_selection: backlogSelection } : {}),
  };
}

/**
 * Drive one bounded, isolated, real campaign. Order is load-bearing:
 * isolation gate -> plan -> (dry-run stops here) -> create worktree -> compose
 * runtime rooted at the worktree -> seed the campaign -> run, bounded by both
 * caps -> always tear down the runtime, and the worktree unless kept.
 */
export async function runSelfhostCampaign(options: SelfhostOptions): Promise<SelfhostOutcome> {
  if (!Number.isInteger(options.maxIterations) || options.maxIterations <= 0) {
    throw new Error("selfhost: max_iterations must be a positive integer");
  }
  if (!(options.maxSeconds > 0)) {
    throw new Error("selfhost: max_seconds must be a positive number of seconds");
  }
  if (options.fromBacklog && !options.backlogAt) {
    throw new Error("selfhost: backlogAt is required when fromBacklog is set");
  }
  // `planSelfhostWorktree` joins this straight into a filesystem path
  // (`.worktrees/selfhost-<runId>`) and a git branch name — an unvalidated
  // `--run-id`/`runId` containing a path separator or a `..` segment computes
  // a path OUTSIDE the target repo entirely (verified: `runId:
  // "../../../../escape-marker"` against a single-level tmp repo resolves to
  // a sibling of the repo, not a path under it), which `createSelfhostWorktree`
  // and `removeSelfhostWorktree` then run `git worktree add`/`remove --force`
  // and `git branch -D` against. Reject before any of that runs — the same
  // fail-closed posture as the isolation gate below, for the one other input
  // that reaches a filesystem path in this module.
  if (options.runId !== undefined && !/^[A-Za-z0-9_-]+$/.test(options.runId)) {
    throw new Error(
      `selfhost: runId ${JSON.stringify(options.runId)} is invalid — must match /^[A-Za-z0-9_-]+$/ ` +
      "(no path separators or '.' — it is joined directly into a worktree path and a git branch name)",
    );
  }

  const safety = checkTargetIsolationSafety(options.targetRepo, options.guard ?? {});
  if (!safety.ok) return { kind: "refused", error: safety.error };

  // Track B3: resolve the real task BEFORE the worktree/plan exist, so a
  // dry-run — which stops before any of that — still names the exact backlog
  // item selected and why. Read against the target repo's own checked-out
  // decisions/ tree (not yet the throwaway worktree, which does not exist at
  // this point and, once created, is branched from this same HEAD anyway).
  let task = options.task;
  let backlogSelection: SelfhostBacklogSelection | undefined;
  if (options.fromBacklog) {
    const backlogResult = deriveBacklog({ repoRoot: safety.resolvedPath, at: options.backlogAt! });
    if (!backlogResult.ok) return { kind: "backlog_derivation_failed", error: backlogResult.error };

    const selected = selectNextBacklogItem(backlogResult.value);
    if (!selected) return { kind: "backlog_empty", total_backlog_items: backlogResult.value.items.length };

    task = renderBrief(selected);
    backlogSelection = {
      record_id: selected.record_id,
      title: selected.title,
      file_path: selected.file_path,
      decision_status: selected.decision_status,
      rank_tier: selected.rank_tier,
      finding_rule_id: selected.evidence.finding_rule_id,
      finding_detail: selected.evidence.finding_detail,
      total_backlog_items: backlogResult.value.items.length,
      selection_reason: selectionReasonFor(selected, backlogResult.value.items.length),
    };
  }

  const runId = options.runId ?? defaultRunId();
  const worktree = planSelfhostWorktree(safety.resolvedPath, runId);
  const campaignId = `selfhost-${runId}`;
  const plan = buildPlan(safety, worktree, campaignId, task, options, backlogSelection);

  // Dry-run stops here: no worktree, no runtime, no executor, no dispatch —
  // the plan above is the entire observable effect.
  if (options.dryRun) {
    return { kind: "dry_run", plan };
  }

  const claimed = claimedIdentity(safety.resolvedPath, worktree);
  if (claimed !== null) {
    return {
      kind: "identity_conflict",
      plan,
      detail:
        `${claimed} — another selfhost run owns this identity. Pick a different --run-id, `
        + "or remove the abandoned worktree/branch first. Refusing rather than reusing it: "
        + "two runs sharing one worktree would interleave writes with no coordination.",
    };
  }

  const created = createSelfhostWorktree(safety.resolvedPath, worktree, options.dependencyProvisioning ?? {});
  if (!created.ok) return { kind: "worktree_failed", plan, error: created.error };

  // Declared outside the try so the `finally` below can tear both down even
  // when construction itself throws (e.g. `createCliRuntime` -> config
  // validation) before either is fully set up — a synchronous throw here
  // used to skip this function's own `finally` entirely and orphan the
  // worktree/branch `createSelfhostWorktree` just created, the same failure
  // mode documented above for a hard process kill.
  let wallClockTimer: ReturnType<typeof setTimeout> | undefined;
  let runtime: ReturnType<typeof createCliRuntime> | undefined;
  try {
    const wallClockController = new AbortController();
    wallClockTimer = setTimeout(
      () => wallClockController.abort(new Error(`selfhost wall-clock cap of ${options.maxSeconds}s exceeded`)),
      Math.max(0, options.maxSeconds * 1000),
    );
    // Combine the wall-clock timer with any external cancellation (e.g. an OS
    // signal `selfhostMain` forwards) so either one drives the SAME graceful
    // path through `runCampaign`'s cooperative cancellation and into this
    // function's own `finally` cleanup below — never a hard process kill that
    // skips it.
    const runSignal = options.externalSignal
      ? AbortSignal.any([wallClockController.signal, options.externalSignal])
      : wallClockController.signal;

    // Rooted at the throwaway worktree, never the invocation cwd or the target
    // repo's own root — recovery leases, config inspection, and kb backend all
    // genuinely live inside the isolation boundary.
    const rt = createCliRuntime(worktree.path);
    runtime = rt;
    const started = await rt.start();
    if (!started.ok) {
      throw new Error(started.failures.map((failure) => failure.summary).join("; ") || "selfhost runtime did not start");
    }

    const router = new RuntimeCatalogRouter(rt);
    const adapter = new RuntimePortAdapter(router, () => rt.operations.list().length);

    const rootAction: Action = {
      description: task,
      estimated_gain: 5,
      estimated_cost: 3,
      category: "maintenance",
      delegate_to: "seed",
    };
    const startResult = rt.manager.startCampaign(campaignId, `selfhost-plan-${runId}.md`, rootAction);
    if (!startResult.ok) {
      throw new Error(`selfhost campaign admission gate rejected: ${startResult.gate.detail}`);
    }
    rt.manager.branch(campaignId, "root", [rootAction]);

    const scoreAdapter = new ManagerScoreContextAdapter(rt.manager);
    // D3 closed: the runtime composed by createCliRuntime carries the same
    // integration registry every other campaign surface selects through, so
    // ARBOR_HARNESS_INTEGRATION (claude-code / codex / opencode) and the
    // native lane are honoured here too. The legacy opencode-direct path
    // remains only for `--verification-cmd`, which is an opencode-executor
    // option; a project's `verification.acceptance_commands` covers every
    // integration through the harness-side verifier instead.
    const selectedIntegration = options.executorOverride === undefined && (options.verificationCmds?.length ?? 0) === 0
      ? rt.harnessIntegrations?.select(DEFAULT_NATIVE_CAMPAIGN_REQUIREMENTS)
      : undefined;
    const integrationInput = selectedIntegration?.kind === "selected"
      ? { runtime: rt, campaign_id: campaignId, adapter, cwd: worktree.path, connector: selectedIntegration.connector } as const
      : null;
    // Canopy-only (amends ADR-061): the direct opencode executor below is a
    // deprecated lane, reached when no integration was selected or
    // `--verification-cmd` forced it. It used to be the silent fallback; it
    // now needs the `connectors.allow_deprecated` opt-in and is recorded in
    // this campaign's ledger when used. An injected override is a test seam,
    // not a lane, and is not gated.
    const usesOpenCodeDirect = options.executorOverride === undefined && integrationInput === null;
    const projectConfig = loadConfig(worktree.path);
    const openCodeAdmission = usesOpenCodeDirect
      ? admitDeprecatedHarnessLane("opencode", (options.verificationCmds?.length ?? 0) > 0 ? "selfhost --verification-cmd" : "selfhost (no Canopy integration was selectable)", projectConfig)
      : undefined;
    if (openCodeAdmission !== undefined) recordDeprecatedHarnessAdmission(rt.manager, campaignId, openCodeAdmission);
    const executor: LoopExecutor =
      options.executorOverride ??
      (integrationInput !== null && selectedIntegration?.kind === "selected"
        ? selectedIntegration.integration.createExecutor(integrationInput)
        : createOpenCodeLoopExecutor(adapter, devtoolsHookForRuntime(rt), campaignId, {
          specialistModel: plan.specialist_model,
          criticModel: plan.critic_model,
          verificationCmds: options.verificationCmds,
          opencodeBin: options.opencodeBin,
        }));
    const integrationDecomposer = integrationInput !== null && selectedIntegration?.kind === "selected" ? selectedIntegration.integration.createDecomposer?.(integrationInput) : undefined;
    const projectAcceptance = projectConfig.verification?.acceptance_commands;

    const config: CampaignLoopConfig = {
      max_iterations: options.maxIterations,
      specialist_base_prompt:
        "You are a Seed, an isolated task executor in a dedicated git worktree of revoy2's own source. Self-validate before submitting.",
      critic_base_prompt: "You are Lenticel, the Critic. You are APPROVAL-BIASED: reject only verified blockers.",
      specialist_cap: { tier: "specialist" },
      critic_cap: { tier: "critic" },
      score_ctx: (id: string) => scoreAdapter.score_ctx(id),
      use_worktrees: true,
      branch_actions: () => null,
      // Wire the decomposer, same as demo.ts's real-executor path. Without
      // it FAULT_MATRIX's timeout -> "decompose" is inert here too, and a
      // timed-out node just fails instead of getting split. 90_000ms is
      // empirically grounded, not a guess: an initial 60_000ms here was
      // verified too tight against a real run (2026-08-08) — the specialist
      // correctly timed out at 120s and triggered decompose, but the
      // decomposer's own real GLM-5.2 dispatch (same prompt, same model, via
      // the one working transport in that environment — see opencode-
      // decomposer.ts's model default) took >60s and timed out too, so the
      // node just failed instead of splitting; a direct probe of the same
      // dispatch succeeded in ~40s. 90s gives headroom over both observed
      // points while staying meaningfully shorter than the specialist's
      // fixed 120s ceiling — a stuck decomposition should still cost less
      // than the work it exists to make tractable.
      ...(projectAcceptance === undefined ? {} : { acceptance_commands: projectAcceptance }),
      // The opencode decomposer runs only on the admitted opencode-direct
      // lane; on the Canopy lane a decomposer comes from the integration or
      // not at all, never from a connector behind its back.
      decomposer:
        options.decomposerOverride ??
        integrationDecomposer ??
        (openCodeAdmission === undefined ? undefined : createOpenCodeDecomposer({
          model: plan.critic_model,
          opencodeBin: options.opencodeBin,
          timeoutMs: 90_000,
        })),
      // Adopt-result (D1, ADR-087 dogfood 2026-08-24): durably capture each
      // node's worktree diff before its lease worktree is torn down, exactly
      // as `cli.ts`'s `createProductionCampaignLoopConfig` wires the generic
      // production campaign path — `composeLoopConfigPorts` deliberately
      // does NOT carry this (see its own selfhost/cli.ts callers: it needs
      // per-caller closures over `rt.manager`/`rt.resultVerification`,
      // not a structural port match). Without it a fully verified,
      // critic-approved selfhost node's diff evaporated on lease release and
      // `arbor adopt` always found `captures: []` — selfhosting could never
      // reach adoption. Only wired when the runtime is durable, same guard
      // cli.ts uses.
      ...(rt.persistenceRoot === null ? {} : {
        result_capture: {
          capture: (input) => {
            const inherited = readCapturedComposition(rt.persistenceRoot!, input.campaign_id, input.node_id)?.files ?? [];
            const declared = input.declared_write_paths === undefined ? undefined : [...new Set([...inherited, ...input.declared_write_paths])];
            // The real per-action fact (`task-composer.ts`'s
            // `classifyAndRepairMutatingActions`) wins when known — recorded
            // on the capture so an adopt-time scope refusal (WA-67) can name
            // it, never derived from anything a specialist/arbiter could
            // write. Absent (a scope constructed outside the task composer),
            // falls back to the same tier-based approximation
            // `scopeIsAuthored` (ADR-065, verification enforcement) uses for
            // the same reason.
            const actionProvenance = rt.manager.getNodeInfo(input.campaign_id, input.node_id)?.action.high_risk_tool_scope?.scope_provenance;
            const governanceTier = rt.manager.getCampaignSnapshot(input.campaign_id)?.governance?.tier;
            const scopeProvenance: "authored" | "mined" = actionProvenance ?? (governanceTier === undefined || governanceTier === null || governanceTier === "governed" ? "authored" : "mined");
            const captured = captureWorktreeResult({ ...input, ...(declared === undefined ? {} : { declared_write_paths: declared, scope_provenance: scopeProvenance }), persistence_dir: rt.persistenceRoot! });
            const provenance = input.verification_provenance;
            const command = input.verification_command_argv;
            if (captured?.verified === true && provenance?.tag === "verified" && provenance.exit === 0 && provenance.strength !== "outputs_check" && command !== undefined) {
              rt.resultVerification.record({
                campaign_id: input.campaign_id,
                node_id: input.node_id,
                checks: [{ command: [...command], exit_status: provenance.exit, duration_ms: null, summary: `machine verification passed: ${provenance.cmd}`, provenance }],
                files: [...captured.files],
                diffstat: { additions: null, deletions: null, files_changed: captured.files.length },
                confidence: "verified",
                absence_reason: null,
                provenance,
                idempotency_key: `campaign-result-verification:${input.campaign_id}:${input.node_id}:${captured.patch_sha256}:${provenance.stdout_hash}`,
              });
            }
          },
        },
        workspace_composition: {
          compose: (input) => {
            const capturedNodeIds = new Set(listCapturedResults(rt.persistenceRoot!, input.campaign_id).map((record) => record.node_id));
            const governed = rt.manager.getCampaignSnapshot(input.campaign_id)?.governance?.tier === "governed";
            const emptySourceNodeIds = governed ? input.source_node_ids.filter((sourceNodeId) => {
              if (capturedNodeIds.has(sourceNodeId)) return false;
              const scope = rt.manager.getNodeInfo(input.campaign_id, sourceNodeId)?.action.high_risk_tool_scope;
              return (scope?.write_paths.length ?? 0) === 0;
            }) : [];
            return composeCapturedResults({ ...input, persistence_dir: rt.persistenceRoot!, empty_source_node_ids: emptySourceNodeIds });
          },
        },
      }),
      ...composeLoopConfigPorts(rt),
    };

    // Per-node leases nest INSIDE the throwaway worktree — a second layer of
    // isolation, never rooted at the target repo directly.
    const worktrees = new WorktreeManager({ repoRoot: worktree.path });

    const report = await runCampaign({
      manager: rt.manager,
      campaign_id: campaignId,
      executor,
      config,
      worktrees,
      signal: runSignal,
    });

    return { kind: "ran", plan, report, dependency_provisioning: created.provisioning,
      selected_integration_id: selectedIntegration?.kind === "selected" ? selectedIntegration.connector.connector_id : "opencode-direct" };
  } finally {
    if (wallClockTimer !== undefined) clearTimeout(wallClockTimer);
    let shutdownFailure: Error | undefined;
    if (runtime !== undefined) {
      const closed = await runtime.close();
      if (!closed.ok) shutdownFailure = new Error(`runtime shutdown failed: ${closed.failures.map((failure) => failure.summary).join("; ") || "unknown failure"}`);
    }
    if (!options.keepWorktree) removeSelfhostWorktree(safety.resolvedPath, worktree);
    if (shutdownFailure !== undefined) throw shutdownFailure;
  }
}

// ============================================================
// CLI ENTRY POINT
// ============================================================

function formatBacklogSelection(selection: SelfhostBacklogSelection): string {
  return (
    `  backlog selection (Track B3, ${selection.total_backlog_items} item(s) in the derived backlog):\n` +
    `    selected:  ${selection.record_id} — ${selection.title} (${selection.file_path})\n` +
    `    finding:   ${selection.finding_rule_id} — ${selection.finding_detail}\n` +
    `    why:       ${selection.selection_reason}\n`
  );
}

/**
 * Map a run outcome onto ADR-054's exit-code registry.
 *
 * selfhost previously answered only 0 or 1, so an isolation REFUSAL (the
 * safety gate working exactly as designed) was indistinguishable from git
 * breaking. Conflating "the system worked and the answer is no" with "the
 * system failed" is the fail-open collapse the registry exists to prevent.
 */
export function exitCodeForOutcome(outcome: SelfhostOutcome): number {
  switch (outcome.kind) {
    // The guard fired. A well-formed request that policy forbids is a
    // VIOLATION, not a crash and not a usage error.
    case "refused":
      return EXIT_CODES.VIOLATION;
    // Another run owns this identity — a state disagreement, not a fault.
    case "identity_conflict":
      return EXIT_CODES.CONFLICT;
    case "worktree_failed":
    case "backlog_derivation_failed":
      return EXIT_CODES.FAILURE;
    // Nothing to dispatch is a real answer about governance state, not a
    // partial result: the backlog was derived successfully and was empty.
    case "backlog_empty":
    case "dry_run":
    case "ran":
      return EXIT_CODES.SUCCESS;
  }
}

function formatDependencyProvisioning(outcome: DependencyProvisioningOutcome): string {
  switch (outcome.status) {
    case "disabled": return "  dependencies: install disabled\n";
    case "skipped": return "  dependencies: skipped (no recognized lockfile)\n";
    case "installed": return `  dependencies: installed via ${outcome.ecosystem} (${outcome.argv.join(" ")}, ${outcome.duration_ms}ms)\n`;
    case "failed": return `  dependencies: FAILED via ${outcome.ecosystem} (${outcome.argv.join(" ")}${outcome.timed_out ? ", timed out" : ""}): ${outcome.detail}\n`;
  }
}

function formatOutcome(outcome: SelfhostOutcome): string {
  switch (outcome.kind) {
    case "refused":
      return `selfhost REFUSED (${outcome.error.kind}): ${outcome.error.message}\n`;
    case "backlog_derivation_failed":
      return `selfhost FAILED to derive the governance backlog (${outcome.error.code}): ${outcome.error.message}\n`;
    case "backlog_empty":
      return (
        `selfhost found NOTHING to dispatch: the derived governance backlog has ` +
        `${outcome.total_backlog_items} item(s), none classified "author_obligations" ` +
        `(the rest are "not_applicable" — records whose own text disclaims a buildable ` +
        `mechanism, e.g. ADR-023/ADR-025). Nothing was dispatched.\n`
      );
    case "identity_conflict":
      return `selfhost CONFLICT: ${outcome.detail}\n`;
    case "worktree_failed":
      return `selfhost worktree creation FAILED for ${outcome.plan.worktree_path}: ${outcome.error}\n`;
    case "dry_run":
      return (
        `selfhost DRY RUN — plan (no worktree created, nothing dispatched to a model):\n` +
        (outcome.plan.backlog_selection ? formatBacklogSelection(outcome.plan.backlog_selection) : "") +
        `${JSON.stringify(outcome.plan, null, 2)}\n`
      );
    case "ran": {
      const r = outcome.report;
      return (
        `selfhost RAN campaign ${outcome.plan.campaign_id} against ${outcome.plan.target_resolved_path}\n` +
        `  selected integration: ${outcome.selected_integration_id}\n` +
        (outcome.plan.backlog_selection ? formatBacklogSelection(outcome.plan.backlog_selection) : "") +
        `  worktree:   ${outcome.plan.worktree_path} (${outcome.plan.worktree_branch})\n` +
        formatDependencyProvisioning(outcome.dependency_provisioning) +
        `  iterations: ${r.iterations}/${outcome.plan.max_iterations}\n` +
        `  verified:   ${r.verified}   claimed: ${r.claimed}   failed: ${r.failed}   decomposed: ${r.decomposed}\n` +
        `  halted:     ${r.halted} (${r.halt_reason ?? "n/a"})\n` +
        `  cancelled:  ${r.cancelled} (${r.cancellation_reason ?? "n/a"})\n` +
        `  awaiting_user_input: ${r.awaiting_user_input}\n`
      );
    }
  }
}

export async function selfhostMain(
  argv: string[],
  environment: { cwd: string; stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream } = {
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
  },
): Promise<number> {
  let target = environment.cwd;
  let task = "Identify one small, safe, verifiable improvement to this repository and implement it.";
  let maxIterations: number | undefined;
  let maxSeconds: number | undefined;
  let dryRun = false;
  let keepWorktree = false;
  let specialistModel: string | undefined;
  let criticModel: string | undefined;
  // D4: repeatable -- each occurrence is one ordered, fail-fast stage.
  const verificationCmds: string[] = [];
  let fromBacklog = false;
  let backlogAt: string | undefined;
  let runId: string | undefined;
  let skipDependencyInstall = false;
  let dependencyInstallTimeoutMs: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target" && i + 1 < argv.length) { target = argv[++i]; }
    else if (arg === "--task" && i + 1 < argv.length) { task = argv[++i]; }
    else if (arg === "--max-iterations" && i + 1 < argv.length) { maxIterations = Number(argv[++i]); }
    else if (arg === "--max-seconds" && i + 1 < argv.length) { maxSeconds = Number(argv[++i]); }
    else if (arg === "--dry-run") { dryRun = true; }
    else if (arg === "--keep-worktree") { keepWorktree = true; }
    else if (arg === "--model" && i + 1 < argv.length) { specialistModel = argv[++i]; }
    else if (arg === "--critic-model" && i + 1 < argv.length) { criticModel = argv[++i]; }
    else if (arg === "--verification-cmd" && i + 1 < argv.length) { verificationCmds.push(argv[++i]); }
    else if (arg === "--from-backlog") { fromBacklog = true; }
    else if (arg === "--backlog-at" && i + 1 < argv.length) { backlogAt = argv[++i]; }
    else if (arg === "--run-id" && i + 1 < argv.length) { runId = argv[++i]; }
    else if (arg === "--skip-dependency-install") { skipDependencyInstall = true; }
    else if (arg === "--dependency-install-timeout-ms" && i + 1 < argv.length) { dependencyInstallTimeoutMs = Number(argv[++i]); }
    else if (arg === "--help" || arg === "-h") {
      environment.stdout.write(
        "arbor-mcp selfhost --max-iterations <n> --max-seconds <n> [--target <path>] [--task <text>]\n" +
        "                   [--dry-run] [--keep-worktree] [--model <m>] [--critic-model <m>] [--verification-cmd <cmd>]\n" +
        "                   [--from-backlog] [--backlog-at <iso-timestamp>] [--run-id <id>]\n" +
        "  --max-iterations   REQUIRED. Hard cap on campaign iterations.\n" +
        "  --max-seconds      REQUIRED. Wall-clock cap in seconds; the run aborts past it.\n" +
        "  --target           Repo to self-host against (default: cwd). Refused if it resolves to\n" +
        "                     master/main, the primary checkout, or a revoy2-w4* worker checkout.\n" +
        "  --dry-run          Compose everything and print the plan; dispatch nothing to a model.\n" +
        "  --keep-worktree    Keep the throwaway worktree/branch after the run (default: removed).\n" +
        "  --from-backlog     Track B3: take the task from revoy2's own derived governance backlog\n" +
        "                     (the POL-04 findings — accepted ADR records asserting things nothing\n" +
        "                     verifies) instead of --task. Selection is deterministic and printed\n" +
        "                     before dispatch (also under --dry-run). Overrides --task.\n" +
        "  --backlog-at       ISO-8601 timestamp for backlog evidence records (default: now).\n" +
        "                     Only stamps evidence — does not affect which item is selected.\n" +
        "  --run-id <id>      Pin the run identity (branch arbor/selfhost/<id>, worktree\n" +
        "                     .worktrees/selfhost-<id>) instead of a clock+random default —\n" +
        "                     lets a caller (e.g. scripts/demo-window.sh) predict the worktree's\n" +
        "                     own devtools.log path before the run starts.\n" +
        "  --skip-dependency-install         Skip installing dependencies into the throwaway\n" +
        "                     worktree (default: installed automatically from whichever\n" +
        "                     lockfile the target repo has — bun/npm/pnpm/yarn).\n" +
        "  --dependency-install-timeout-ms <n>  Bound on the install (default 600000ms).\n" +
        "  --verification-cmd <cmd>          Repeatable: each occurrence is one ordered,\n" +
        "                     fail-fast verification stage run in the worktree after the\n" +
        "                     specialist, each on its own timeout budget. One occurrence\n" +
        "                     behaves exactly as a single --verification-cmd always has.\n" +
        "\n  Every real run executes inside a dedicated git worktree on a throwaway\n" +
        "  arbor/selfhost/<run-id> branch — never the checkout it was invoked from.\n" +
        "\n  Executor: the Canopy harness (revoy-native) when native.* is ready, through the same\n" +
        "  registry every campaign surface uses (ARBOR_HARNESS_INTEGRATION selects; default native).\n" +
        "  The opencode, claude-code and codex connectors — and the opencode-direct path that\n" +
        "  --verification-cmd forces — are DEPRECATED until after 1.0.0 and refused unless\n" +
        "  arbor.jsonc sets connectors.allow_deprecated: true with connectors.reason. Prefer the\n" +
        "  project's verification.acceptance_commands, which the Canopy lane honours.\n",
      );
      return EXIT_CODES.SUCCESS;
    }
    else {
      environment.stderr.write(`unknown selfhost flag: ${arg}\n`);
      return EXIT_CODES.USAGE;
    }
  }

  if (maxIterations === undefined || !Number.isFinite(maxIterations)) {
    environment.stderr.write("selfhost: --max-iterations is required\n");
    return EXIT_CODES.USAGE;
  }
  if (maxSeconds === undefined || !Number.isFinite(maxSeconds)) {
    environment.stderr.write("selfhost: --max-seconds is required\n");
    return EXIT_CODES.USAGE;
  }


  // Forward OS signals into the cooperative abort path (`SelfhostOptions.externalSignal`)
  // instead of leaving Node's default signal disposition (immediate death,
  // skipping every `finally` — including worktree cleanup) in place.
  const signalController = new AbortController();
  const onSignal = (): void => signalController.abort(new Error("selfhost received SIGINT/SIGTERM"));
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const outcome = await runSelfhostCampaign({
      targetRepo: target,
      task,
      maxIterations,
      maxSeconds,
      dryRun,
      keepWorktree,
      specialistModel,
      criticModel,
      ...(verificationCmds.length === 0 ? {} : { verificationCmds }),
      fromBacklog,
      backlogAt: fromBacklog ? (backlogAt ?? new Date().toISOString()) : backlogAt,
      runId,
      dependencyProvisioning: {
        enabled: !skipDependencyInstall,
        ...(dependencyInstallTimeoutMs === undefined ? {} : { timeoutMs: dependencyInstallTimeoutMs }),
      },
      externalSignal: signalController.signal,
    });
    environment.stdout.write(formatOutcome(outcome));
    return exitCodeForOutcome(outcome);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
