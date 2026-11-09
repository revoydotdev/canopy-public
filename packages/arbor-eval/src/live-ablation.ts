/**
 * arbor-eval/live-ablation — ADR-095 Decisions 2-4: the tree-search-vs-linear
 * ablation the repo's central claim depends on, run against a real model and
 * real verification commands.
 *
 * Each task in `live-tasks.ts` runs `runs_per_arm_per_task` times (capped
 * `n`, ADR-095 target 3) through two arms sharing the same prompt, model,
 * verification command, and seed set:
 *
 *  - `tree_search`: `CampaignManager`'s branch/select/backtrack loop
 *    (`selectNode`, `@arbor/core`'s `tree.ts`) — UCB-scored selection across
 *    branch attempts, with a failed attempt backtracking via `failNode`.
 *  - `linear`: a single-branch baseline with NO UCB selection and NO
 *    backtracking — attempts are tried in fixed order, first success wins.
 *
 * The comparison metric is success rate at a FIXED verification-call budget
 * (`max_calls_per_run`), never wall-clock, so provider latency variance
 * cannot contaminate the result (ADR-095 Decision 2).
 *
 * An operator may opt into a prospective cost guard; without it, the report
 * preserves provider-measured usage rather than pretending the run was free.
 * `verified` provenance is only ever produced by `live-verification.ts`'s
 * `verifiedProvenanceFromRun`, which requires the task's real verification
 * command to have actually run and exited 0 — never fabricated here.
 *
 * The falsifiability clause (ADR-095 Decision 4): if the held-out linear
 * success rate meets or beats the held-out tree-search success rate, that is
 * surfaced as a non-suppressible `FalsifiabilityFinding` in the report,
 * never silently absorbed or re-run until it flips. Filing the actual
 * ADR-002 obligation entry is an operator/governance action outside this
 * package's file ownership (`decisions/ADR-002-*.md` is not owned here) —
 * this module only guarantees the finding cannot be missed.
 */
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action, Provenance, ScoreContext } from "@arbor/core";
import { CampaignManager } from "@arbor/mcp";
import type { NativeModelPort } from "@arbor/harness";
import type { NativeUsageAndCost } from "@arbor/harness";
import type { AttemptFeedback, LiveEvalTask } from "./live-tasks.js";
import { runVerificationCommand, verifiedProvenanceFromRun, type VerificationRunResult } from "./live-verification.js";
import { callLiveModel, LiveModelCallError } from "./live-model-port.js";
import { assertWithinCostCeiling, estimateLiveRunCostUsd } from "./live-cost-guard.js";

/**
 * The three arms, chosen so that each adjacent pair isolates ONE variable.
 *
 * The previous two arms were `tree_search` and `linear`, and they confounded
 * two things at once: `tree_search` was CampaignManager governance PLUS UCB
 * selection and backtracking, while `linear` was a raw loop with neither. A
 * difference between them could not be attributed to search or to governance,
 * which is the question the repository's premise actually turns on.
 *
 *   ungoverned_linear -> governed_linear   isolates GOVERNANCE
 *   governed_linear   -> governed_tree     isolates SEARCH
 *
 * `ungoverned_linear` is also the closest thing this harness has to the
 * repeated-independent-sampling baseline ADR-131 names as the salient
 * counter-hypothesis from the literature: fixed order, first success wins, no
 * selection policy of any kind.
 */
export type LiveArm = "governed_tree" | "governed_linear" | "ungoverned_linear";

export const LIVE_ARMS: readonly LiveArm[] = Object.freeze([
  "ungoverned_linear",
  "governed_linear",
  "governed_tree",
]);

export interface LiveAttemptResult {
  readonly attempt: number;
  readonly verification: VerificationRunResult;
  readonly success: boolean;
  /** Provider counter when returned, otherwise a typed unavailable measurement. */
  readonly usage_and_cost: NativeUsageAndCost | null;
}

export interface LiveSeedRunResult {
  readonly seed: number;
  readonly arm: LiveArm;
  readonly task_id: string;
  readonly success: boolean;
  readonly calls_used: number;
  readonly attempts: readonly LiveAttemptResult[];
}

export interface LiveTaskArmResult {
  readonly task_id: string;
  readonly held_out: boolean;
  readonly arm: LiveArm;
  readonly runs: readonly LiveSeedRunResult[];
  readonly n: number;
  readonly successes: number;
  readonly success_rate: number;
  /** Wilson score 95% confidence interval on the win rate. */
  readonly confidence_interval_95: readonly [number, number];
  /** n-of-m verdict: strict majority of the capped run count succeeded. */
  readonly verdict_pass: boolean;
}

/** Held-out success rate per arm. Keyed by arm so a new arm cannot be silently dropped. */
export interface ArmSuccessRates {
  readonly governed_tree: number;
  readonly governed_linear: number;
  readonly ungoverned_linear: number;
}

/**
 * One pre-registered claim and whether the held-out result contradicted it.
 *
 * `search` is ADR-095 Decision 4's original clause. `governance` is its
 * counterpart for the arm this instrument previously could not express: if
 * governance does not pay for itself at equal verification-call budget, that is
 * exactly as reportable as a losing tree-search arm, and for the same reason.
 */
export interface FalsifiabilityFinding {
  readonly claim: "search" | "governance";
  readonly triggered: boolean;
  readonly treatment_arm: LiveArm;
  readonly baseline_arm: LiveArm;
  readonly treatment_success_rate: number;
  readonly baseline_success_rate: number;
  readonly delta: number;
  readonly detail: string;
  /** Ready-to-file obligation prose; filing it is an operator action. */
  readonly recommended_obligation: string | null;
}

export interface LiveAblationReport {
  readonly schema: "arbor.live-ablation/v2";
  readonly generated_at: string;
  readonly model: { readonly provider_id: string; readonly model_id: string };
  readonly runs_per_arm_per_task: number;
  readonly max_calls_per_run: number;
  readonly task_results: readonly LiveTaskArmResult[];
  readonly calibration: ArmSuccessRates;
  readonly held_out: ArmSuccessRates;
  /** One finding per pre-registered claim; see `evaluateFalsifiability`. */
  readonly falsifiability: readonly FalsifiabilityFinding[];
}

export interface RunLiveAblationInput {
  readonly tasks: readonly LiveEvalTask[];
  readonly model_port: NativeModelPort;
  readonly credential: string;
  readonly provider_id: string;
  readonly model_id: string;
  /** Optional explicit arm subset for separately routed control samples. */
  readonly arms?: readonly LiveArm[];
  /** Equal finite A/B sample count. */
  readonly runs_per_arm_per_task: number;
  /** Equal finite verification-call budget preserving the comparative metric. */
  readonly max_calls_per_run: number;
  /** An opt-in prospective guard; measured provider usage remains mandatory. */
  readonly cost_ceiling_usd: number | null;
  readonly estimated_prompt_tokens_per_call: number;
  readonly max_output_tokens_per_call: number | null;
  readonly price_per_input_token_usd: number;
  readonly price_per_output_token_usd: number;
  readonly workdir_root?: string;
  readonly signal?: AbortSignal;
  /** Synchronous durable-observation hook; throwing fails the run closed. */
  readonly on_progress?: (event: LiveAblationProgressEvent) => void;
  /** Expensive diagnostic runs may retain every seed directory for review. */
  readonly retain_workdirs?: boolean;
  /** Durable seed checkpoints accepted only on exact task/arm/seed identity. */
  readonly resume_seed_results?: readonly LiveSeedRunResult[];
}

export type LiveAblationProgressEvent =
  | Readonly<{ readonly kind: "arm_started"; readonly task_id: string; readonly arm: LiveArm }>
  | Readonly<{ readonly kind: "seed_started"; readonly task_id: string; readonly arm: LiveArm; readonly seed: number; readonly workdir: string }>
  | Readonly<{ readonly kind: "seed_resumed"; readonly task_id: string; readonly arm: LiveArm; readonly seed: number; readonly result: LiveSeedRunResult }>
  | Readonly<{ readonly kind: "attempt_started"; readonly task_id: string; readonly arm: LiveArm; readonly seed: number; readonly attempt: number; readonly workdir: string }>
  | Readonly<{ readonly kind: "attempt_completed"; readonly task_id: string; readonly arm: LiveArm; readonly seed: number; readonly attempt: number; readonly workdir: string; readonly candidate_path: string; readonly result: LiveAttemptResult }>
  | Readonly<{ readonly kind: "seed_completed"; readonly task_id: string; readonly arm: LiveArm; readonly seed: number; readonly workdir: string; readonly result: LiveSeedRunResult }>
  | Readonly<{ readonly kind: "arm_completed"; readonly task_id: string; readonly arm: LiveArm; readonly result: LiveTaskArmResult }>;

function progress(input: RunLiveAblationInput, event: LiveAblationProgressEvent): void {
  input.on_progress?.(Object.freeze(event));
}

export class LiveAblationInterruptedError extends Error {
  constructor() { super("live eval interrupted by operator"); this.name = "LiveAblationInterruptedError"; }
}

const scoreCtx: ScoreContext = { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 100, total_visits: 5 };
const LIVE_CLAIMANT = "arbor-eval/live";

export async function runLiveAblation(input: RunLiveAblationInput): Promise<LiveAblationReport> {
  const arms = input.arms === undefined ? LIVE_ARMS : validateArms(input.arms);
  if (input.cost_ceiling_usd !== null) {
    if (input.max_output_tokens_per_call === null) {
      throw new Error("live cost ceiling requires an explicit --max-output-tokens bound");
    }
    const estimatedUsd = estimateLiveRunCostUsd({
      arms: arms.length, tasks: input.tasks.length, runs_per_arm_per_task: input.runs_per_arm_per_task,
      max_calls_per_run: input.max_calls_per_run, estimated_prompt_tokens_per_call: input.estimated_prompt_tokens_per_call,
      max_output_tokens_per_call: input.max_output_tokens_per_call, price_per_input_token_usd: input.price_per_input_token_usd,
      price_per_output_token_usd: input.price_per_output_token_usd,
    });
    assertWithinCostCeiling(estimatedUsd, input.cost_ceiling_usd);
  }

  const workdirRoot = input.workdir_root ?? tmpdir();
  const taskResults: LiveTaskArmResult[] = [];

  for (const task of input.tasks) {
    for (const arm of arms) {
      progress(input, { kind: "arm_started", task_id: task.id, arm });
      const runs: LiveSeedRunResult[] = [];
      for (let run = 0; run < input.runs_per_arm_per_task; run++) {
        throwIfAborted(input.signal);
        const seed = computeLiveSeed(task.id, arm, run);
        const resumed = input.resume_seed_results?.find((candidate) => candidate.task_id === task.id && candidate.arm === arm && candidate.seed === seed);
        if (resumed !== undefined) {
          if (resumed.calls_used !== resumed.attempts.length || resumed.calls_used > input.max_calls_per_run) {
            throw new Error(`live ablation: malformed resumed seed ${task.id}/${arm}/${seed}`);
          }
          runs.push(resumed);
          progress(input, { kind: "seed_resumed", task_id: task.id, arm, seed, result: resumed });
          continue;
        }
        const result = arm === "governed_tree"
          ? await runGovernedArm(task, seed, input, workdirRoot, "tree")
          : arm === "governed_linear"
            ? await runGovernedArm(task, seed, input, workdirRoot, "linear")
            : await runUngovernedLinearArm(task, seed, input, workdirRoot);
        runs.push(result);
      }
      const armResult = summarizeArm(task, arm, runs);
      taskResults.push(armResult);
      progress(input, { kind: "arm_completed", task_id: task.id, arm, result: armResult });
    }
  }

  const calibrationTasks = taskResults.filter((r) => !r.held_out);
  const heldOutTasks = taskResults.filter((r) => r.held_out);
  const rates = (subset: readonly LiveTaskArmResult[]): ArmSuccessRates => Object.freeze({
    governed_tree: aggregateSuccessRate(subset, "governed_tree"),
    governed_linear: aggregateSuccessRate(subset, "governed_linear"),
    ungoverned_linear: aggregateSuccessRate(subset, "ungoverned_linear"),
  });
  const calibration = rates(calibrationTasks);
  const heldOut = rates(heldOutTasks);
  const falsifiability = evaluateFalsifiability(heldOut);

  return Object.freeze({
    schema: "arbor.live-ablation/v2" as const,
    generated_at: new Date().toISOString(),
    model: { provider_id: input.provider_id, model_id: input.model_id },
    runs_per_arm_per_task: input.runs_per_arm_per_task,
    max_calls_per_run: input.max_calls_per_run,
    task_results: Object.freeze(taskResults),
    calibration,
    held_out: heldOut,
    falsifiability,
  });
}

function validateArms(arms: readonly LiveArm[]): readonly LiveArm[] {
  if (arms.length === 0) throw new Error("live ablation: at least one arm is required");
  const unique = new Set<LiveArm>();
  for (const arm of arms) {
    if (!LIVE_ARMS.includes(arm)) throw new Error(`live ablation: unsupported arm ${String(arm)}`);
    if (unique.has(arm)) throw new Error(`live ablation: duplicate arm ${arm}`);
    unique.add(arm);
  }
  return Object.freeze([...arms]);
}

/** ADR-095 Decision 4. Never silently absorbed: the finding is always present, `triggered` or not. */
/**
 * ADR-095 Decision 4, extended to both claims this instrument now separates.
 *
 * Never silently absorbed: a finding is always present for each claim,
 * `triggered` or not, with both arms' rates side by side so a losing arm is
 * exactly as visible as a winning one. A tie counts as a trigger — the burden
 * is on the extra machinery to earn its place, not on the baseline to beat it.
 */
export function evaluateFalsifiability(heldOut: ArmSuccessRates, today = new Date().toISOString().slice(0, 10)): readonly FalsifiabilityFinding[] {
  const claims = [
    {
      claim: "search" as const,
      treatment_arm: "governed_tree" as const,
      baseline_arm: "governed_linear" as const,
      treatment: heldOut.governed_tree,
      baseline: heldOut.governed_linear,
      record: "decisions/ADR-002-*.md",
      what: "ADR-002's tree-search adoption",
    },
    {
      claim: "governance" as const,
      treatment_arm: "governed_linear" as const,
      baseline_arm: "ungoverned_linear" as const,
      treatment: heldOut.governed_linear,
      baseline: heldOut.ungoverned_linear,
      record: "decisions/ADR-006-*.md",
      what: "the governed campaign path's process gates",
    },
  ];
  return Object.freeze(claims.map((c) => {
    const triggered = c.baseline >= c.treatment;
    return Object.freeze({
      claim: c.claim,
      triggered,
      treatment_arm: c.treatment_arm,
      baseline_arm: c.baseline_arm,
      treatment_success_rate: c.treatment,
      baseline_success_rate: c.baseline,
      delta: round(c.treatment - c.baseline),
      detail: triggered
        ? `held-out ${c.baseline_arm} success rate (${c.baseline}) matched or exceeded ${c.treatment_arm} (${c.treatment}) at equal verification-call budget`
        : `held-out ${c.treatment_arm} success rate (${c.treatment}) exceeded ${c.baseline_arm} (${c.baseline}) at equal verification-call budget`,
      recommended_obligation: triggered
        ? `File against ${c.record}: the held-out live ablation on ${today} found ${c.baseline_arm} ` +
          `matching or beating ${c.treatment_arm} at equal verification-call budget ` +
          `(${c.baseline_arm} ${c.baseline} vs ${c.treatment_arm} ${c.treatment}). ${c.what} is not ` +
          `supported by this result on the held-out set. This obligation must not be re-run until it ` +
          `flips, loosened, or silently absorbed — it requires an operator decision.`
        : null,
    });
  }));
}

function aggregateSuccessRate(results: readonly LiveTaskArmResult[], arm: LiveArm): number {
  const arms = results.filter((r) => r.arm === arm);
  const totalN = arms.reduce((sum, r) => sum + r.n, 0);
  const totalSuccesses = arms.reduce((sum, r) => sum + r.successes, 0);
  return totalN === 0 ? 0 : round(totalSuccesses / totalN);
}

function summarizeArm(task: LiveEvalTask, arm: LiveArm, runs: readonly LiveSeedRunResult[]): LiveTaskArmResult {
  const n = runs.length;
  const successes = runs.filter((r) => r.success).length;
  const successRate = n === 0 ? 0 : round(successes / n);
  return Object.freeze({
    task_id: task.id,
    held_out: task.held_out,
    arm,
    runs: Object.freeze(runs),
    n,
    successes,
    success_rate: successRate,
    confidence_interval_95: wilsonInterval(successes, n),
    verdict_pass: n > 0 && successes * 2 > n,
  });
}

/** Wilson score 95% CI for a binomial proportion — stable at small n, unlike a normal approximation. */
export function wilsonInterval(successes: number, n: number, z = 1.96): readonly [number, number] {
  if (n === 0) return [0, 0];
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [round(Math.max(0, (center - margin) / denom)), round(Math.min(1, (center + margin) / denom))];
}

/**
 * Both governed arms, sharing one body so that GOVERNANCE is held identical and
 * only SELECTION differs. Splitting them into two functions is how the two
 * variables get quietly re-confounded: any drift in gate wiring, provenance, or
 * critic verdicts between the copies would land in the measured effect and be
 * indistinguishable from a real search result.
 *
 *   selection "tree"   — `manager.selectNode` with UCB over live scores, and a
 *                        fresh sibling added after each real failure, so the arm
 *                        may abandon a poisoned line for a different workspace.
 *   selection "linear" — strict creation order, first branch first. No scoring
 *                        is consulted and no branch is ever revisited.
 */
async function runGovernedArm(
  task: LiveEvalTask,
  seed: number,
  input: RunLiveAblationInput,
  workdirRoot: string,
  selection: "tree" | "linear",
): Promise<LiveSeedRunResult> {
  const arm: LiveArm = selection === "tree" ? "governed_tree" : "governed_linear";
  const root = mkdtempSync(join(workdirRoot, `arbor-live-eval-${arm}-${task.id}-`));
  progress(input, { kind: "seed_started", task_id: task.id, arm, seed, workdir: root });
  try {
    const manager = new CampaignManager();
    const campaignId = `live-eval-${arm}-${task.id}-${seed}`;
    const startResult = manager.startCampaign(campaignId, `eval/live-plans/${task.id}.md`, rootAction(task), {
      max_seconds: 600,
      min_score: 0,
      convergence_iterations: 2,
    });
    if (!startResult.ok) throw new Error(`live ablation: failed to start campaign ${campaignId}: ${JSON.stringify(startResult)}`);

    // Each branch gets its OWN workspace. See live-tasks.ts's note on
    // `current_source`: with a single shared directory every attempt restarts
    // from the pristine fixture, branches are indistinguishable, and the tree
    // arm has nothing to return to.
    const branchIndexByNode = new Map<string, number>();
    const dirByNode = new Map<string, string>();
    const feedbackByNode = new Map<string, AttemptFeedback | null>();
    const pending: string[] = [];
    let nextBranchIndex = 0;

    const addBranch = (gain: number, cost: number, category: string, inheritFrom: string | null): string | null => {
      if (nextBranchIndex >= input.max_calls_per_run) return null;
      const [childId] = manager.branch(campaignId, "root", [branchAction(task, nextBranchIndex, gain, cost, category)]);
      const dir = mkdtempSync(join(root, `branch-${nextBranchIndex}-`));
      task.setup_fixture(dir);
      if (inheritFrom !== null) {
        // Carry the parent branch's partial progress forward, so continuing a
        // line and starting a fresh one are genuinely different moves.
        const parentDir = dirByNode.get(inheritFrom);
        if (parentDir !== undefined) {
          copyFileSync(join(parentDir, task.target_relative_path), join(dir, task.target_relative_path));
        }
        feedbackByNode.set(childId, feedbackByNode.get(inheritFrom) ?? null);
      } else {
        feedbackByNode.set(childId, null);
      }
      branchIndexByNode.set(childId, nextBranchIndex);
      dirByNode.set(childId, dir);
      pending.push(childId);
      nextBranchIndex++;
      return childId;
    };

    addBranch(BASE_BRANCH_GAIN, BASE_BRANCH_COST, BASE_BRANCH_CATEGORY, null);
    addBranch(BASE_BRANCH_GAIN, BASE_BRANCH_COST, BASE_BRANCH_CATEGORY, null);

    const attempts: LiveAttemptResult[] = [];
    let success = false;
    let liveCtx: ScoreContext = scoreCtx;

    while (attempts.length < input.max_calls_per_run) {
      throwIfAborted(input.signal);
      if (manager.haltStatus(campaignId).halted) break;

      const nodeId = selection === "tree"
        ? manager.selectNode(campaignId, liveCtx)
        : (pending.shift() ?? null);
      if (!nodeId) break;
      if (selection === "tree") {
        const queued = pending.indexOf(nodeId);
        if (queued >= 0) pending.splice(queued, 1);
      }
      const nodeInfo = manager.getNodeInfo(campaignId, nodeId);
      if (!nodeInfo) break;
      const branchIndex = branchIndexByNode.get(nodeId) ?? attempts.length;
      const dir = dirByNode.get(nodeId);
      if (dir === undefined) break;

      const expandResult = manager.expandNode(campaignId, nodeId, {
        worktree_isolated: true,
        starting_commit_correct: true,
        lease_acquired: true,
      });
      if (!expandResult.ok) {
        manager.recordResult(campaignId, nodeId, {
          specialist_output: `isolation gate failed: ${expandResult.gate.detail}`,
          specialist_agent: nodeInfo.action.delegate_to,
          provenance: claimedLiveProvenance(),
          critic_agent: "lenticel",
          critic_approved: false,
          critic_rationale: expandResult.gate.detail,
          critic_root_cause: "isolation gate failed",
          score_ctx: liveCtx,
        });
        continue;
      }

      const attemptResult = await runOneAttempt(
        task, dir, branchIndex, input, arm, seed, feedbackByNode.get(nodeId) ?? null,
      );
      attempts.push(attemptResult);
      manager.recordResult(campaignId, nodeId, {
        specialist_output: attemptResult.success
          ? `verification passed: ${attemptResult.verification.cmd_label}`
          : `FAILED: ${attemptResult.verification.cmd_label} exit=${attemptResult.verification.exit_code} stderr=${attemptResult.verification.stderr.slice(0, 500)}`,
        specialist_agent: task.id,
        provenance: attemptResult.success ? mustVerifiedProvenance(attemptResult.verification) : claimedLiveProvenance(),
        critic_agent: "lenticel",
        critic_approved: attemptResult.success,
        critic_rationale: attemptResult.success ? "verification command exited 0" : "verification command did not pass",
        critic_root_cause: attemptResult.success ? undefined : "live model output failed real verification",
        score_ctx: liveCtx,
      });
      if (attemptResult.success) { success = true; break; }

      const failure = feedbackFrom(attemptResult);
      feedbackByNode.set(nodeId, failure);
      liveCtx = deriveNextScoreContext(liveCtx, attempts, manager.getCampaignSnapshot(campaignId)?.best_score ?? 0);
      // A confirmed failure earns one more candidate. The tree arm may then
      // weigh continuing this line against a sibling; the linear arm simply
      // reaches it when its turn comes.
      addBranch(BASE_BRANCH_GAIN + FAILURE_STRATEGY_BOOST, BASE_BRANCH_COST, `${BASE_BRANCH_CATEGORY}-alt-${nextBranchIndex}`, nodeId);
    }

    const result = Object.freeze({ seed, arm, task_id: task.id, success, calls_used: attempts.length, attempts: Object.freeze(attempts) });
    progress(input, { kind: "seed_completed", task_id: task.id, arm, seed, workdir: root, result });
    return result;
  } finally {
    if (input.retain_workdirs !== true) rmSync(root, { recursive: true, force: true });
  }
}

/** The failing verification of one attempt, in the shape the next prompt takes. */
function feedbackFrom(attempt: LiveAttemptResult): AttemptFeedback {
  return Object.freeze({
    attempt: attempt.attempt,
    exit_code: attempt.verification.exit_code ?? -1,
    stdout: attempt.verification.stdout,
    stderr: attempt.verification.stderr,
  });
}

/**
 * Fold a real attempt outcome into the `ScoreContext` the next
 * `selectNode` call scores against (ADR-131 Decision §2's stated minimum).
 * Only `total_visits` (a real, observed call count) and `best_known` (read
 * from `CampaignManager`'s own real, verification-gated `best_score` — never
 * fabricated here) are updated; regression rates are left at their honest
 * starting value of 0 because this harness does not yet track per-category
 * regression history, a disclosed limitation, not a manufactured signal.
 */
function deriveNextScoreContext(prior: ScoreContext, attempts: readonly LiveAttemptResult[], measuredBestScore: number): ScoreContext {
  return Object.freeze({
    ...prior,
    total_visits: attempts.length + 1,
    best_known: measuredBestScore > 0 ? measuredBestScore : prior.best_known,
  });
}

/**
 * The ungoverned baseline: a raw loop with no CampaignManager, no gates, no
 * critic verdict and no provenance requirement. Success is decided by exactly
 * the same real verification command as the governed arms, so the arms remain
 * comparable; only the machinery around the attempt differs.
 */
async function runUngovernedLinearArm(
  task: LiveEvalTask,
  seed: number,
  input: RunLiveAblationInput,
  workdirRoot: string,
): Promise<LiveSeedRunResult> {
  const dir = mkdtempSync(join(workdirRoot, `arbor-live-eval-ungoverned-${task.id}-`));
  progress(input, { kind: "seed_started", task_id: task.id, arm: "ungoverned_linear", seed, workdir: dir });
  try {
    task.setup_fixture(dir);
    const attempts: LiveAttemptResult[] = [];
    let success = false;
    let feedback: AttemptFeedback | null = null;
    // Fixed order, no selection, no backtracking: attempts 0..budget-1 in sequence.
    for (let attempt = 0; attempt < input.max_calls_per_run; attempt++) {
      throwIfAborted(input.signal);
      const attemptResult = await runOneAttempt(task, dir, attempt, input, "ungoverned_linear", seed, feedback);
      attempts.push(attemptResult);
      if (attemptResult.success) { success = true; break; }
      feedback = feedbackFrom(attemptResult);
    }
    const result = Object.freeze({ seed, arm: "ungoverned_linear" as const, task_id: task.id, success, calls_used: attempts.length, attempts: Object.freeze(attempts) });
    progress(input, { kind: "seed_completed", task_id: task.id, arm: "ungoverned_linear", seed, workdir: dir, result });
    return result;
  } finally {
    if (input.retain_workdirs !== true) rmSync(dir, { recursive: true, force: true });
  }
}

async function runOneAttempt(
  task: LiveEvalTask,
  dir: string,
  attempt: number,
  input: RunLiveAblationInput,
  arm: LiveArm,
  seed: number,
  feedback: AttemptFeedback | null,
): Promise<LiveAttemptResult> {
  throwIfAborted(input.signal);
  progress(input, { kind: "attempt_started", task_id: task.id, arm, seed, attempt, workdir: dir });
  let text: string;
  let usage_and_cost: NativeUsageAndCost | null;
  try {
    ({ text, usage_and_cost } = await callLiveModel({
      port: input.model_port,
      credential: input.credential,
      session_id: `live-eval-${task.id}`,
      turn: attempt,
      provider_id: input.provider_id,
      model_id: input.model_id,
      prompt: task.prompt(attempt, feedback),
      signal: input.signal,
    }));
  } catch (error) {
    if (!(error instanceof LiveModelCallError)) throw error;
    // An HTTP-successful but empty completion is a measured model outcome,
    // not an infrastructure outage. Preserve it as a failed candidate so one
    // malformed response cannot abort (or be invisibly retried out of) an A/B
    // sample. The ordinary verifier supplies the same failure evidence and
    // attempt accounting as any other invalid patch.
    text = "";
    usage_and_cost = error.usage_and_cost;
  }
  throwIfAborted(input.signal);
  writeFileSync(join(dir, task.target_relative_path), text, "utf8");
  const verification = runVerificationCommand(task.verification(dir));
  const result = Object.freeze({ attempt, verification, success: verification.ran && verification.exit_code === 0, usage_and_cost });
  progress(input, { kind: "attempt_completed", task_id: task.id, arm, seed, attempt, workdir: dir, candidate_path: join(dir, task.target_relative_path), result });
  return result;
}

function claimedLiveProvenance(): Provenance {
  return Object.freeze({ tag: "claimed" as const, claimant: LIVE_CLAIMANT });
}

function mustVerifiedProvenance(result: VerificationRunResult): Provenance {
  // ADR-134 §2: this caller runs exactly one task-declared verification
  // command per attempt (`task.verification(dir)`, above) — never a suite or
  // a subset of one — so "single" is the honest, caller-declared breadth,
  // not a guess.
  const provenance = verifiedProvenanceFromRun(result, "single");
  if (!provenance) throw new Error("live ablation: attempted to record a success without a real verified provenance — this is a bug, never a fabricated tag");
  return provenance;
}

function rootAction(task: LiveEvalTask): Action {
  return { description: `live eval root: ${task.description}`, estimated_gain: 100, estimated_cost: 1, category: "root", delegate_to: "crown" };
}

const BASE_BRANCH_GAIN = 50;
const BASE_BRANCH_COST = 5;
const BASE_BRANCH_CATEGORY = "live-fix";
/**
 * Added to a follow-up branch's `estimated_gain` after a confirmed real
 * failure, so its gain-per-cost strictly exceeds any still-untried,
 * identically-scored sibling created before the failure. `BASE_BRANCH_GAIN
 * / BASE_BRANCH_COST` is 10; +15 gain at the same cost raises that to 13,
 * enough to win outright rather than tie (ADR-131 O3).
 */
const FAILURE_STRATEGY_BOOST = 15;

function branchAction(task: LiveEvalTask, attempt: number, gain: number, cost: number, category: string): Action {
  return { description: `${task.description} (attempt ${attempt})`, estimated_gain: gain, estimated_cost: cost, category, delegate_to: "live-model" };
}

/** Deterministic per-(task,arm,run) seed identifier — governs directory naming/ordering only, never model output. */
export function computeLiveSeed(taskId: string, arm: LiveArm, run: number): number {
  let h = 2166136261;
  const str = `${taskId}:${arm}:${run}`;
  for (let i = 0; i < str.length; i++) { h = (h ^ str.charCodeAt(i)) * 16777619; h >>>= 0; }
  return h;
}

function round(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new LiveAblationInterruptedError();
}
