/**
 * arbor-eval/stage0/analysis — the preregistered analysis and verdict.
 *
 * Inputs: the ledger's attempts and waves, the admitted task list and the
 * design. Output: per-arm results with intervals, the paired contrasts, the
 * cost and failure tables, and the verdict computed by the preregistered rule
 * in `stage0Verdict`. Nothing here reads a result before the rule is applied:
 * the thresholds are constants in this file and in the preregistration.
 */
import { deriveBestOfN, deriveCurrent, deriveKWide, Stage0IncompleteUnitError } from "./arms.js";
import type { Stage0ArmOutcome } from "./arms.js";
import { groupUnits } from "./ledger.js";
import { clusterBootstrap, median, pooledMean, pooledMeanDifference, pooledRatio, quantile, wilsonInterval } from "./stats.js";
import type { BootstrapResult, Cluster, Interval } from "./stats.js";
import type { Stage0AttemptRecord, Stage0Design, Stage0Task, Stage0WaveRecord } from "./types.js";

/** Preregistered thresholds. Changing any of these after a measured run is a protocol deviation. */
export const STAGE0_CRITERIA = {
  /** Cost per verified result of best_of_n@4 may be at most this multiple of current's. */
  bon_cost_per_verified_max_ratio: 1.5,
  /** False-acceptance rate of best_of_n@4 may exceed current's by at most this (absolute). */
  false_acceptance_max_increase: 0.02,
  /** K-wide@4 must cut median wall time to outcome below this fraction of best_of_n@4's. */
  kwide_wall_max_fraction: 0.8,
  /** K-wide@4 cost per verified result may be at most this multiple of best_of_n@4's. */
  kwide_cost_per_verified_max_ratio: 2.0,
  /** Hard stratum: tasks whose current-arm rate is at most this. */
  hard_task_max_current_rate: 0.5,
  /** Minimum hard-stratum size for a Stage 3 AB-MCTS comparison to be meaningful. */
  hard_stratum_min_tasks: 8,
  /** Minimum share of hard-stratum units best_of_n@8 leaves unsolved (headroom for REFINE). */
  hard_stratum_min_unsolved_bon8: 0.15,
} as const;

export interface ArmSummary {
  readonly arm: string;
  readonly units: number;
  readonly successes: number;
  readonly rate_wilson: Interval;
  readonly rate_task_bootstrap: BootstrapResult;
  readonly mean_cost_usd: number;
  readonly cost_per_verified: BootstrapResult;
  readonly false_acceptance_rate: number;
  readonly mean_attempts: number;
  readonly median_wall_ms: number;
  readonly p90_wall_ms: number;
}

export interface Contrast {
  readonly name: string;
  readonly a: string;
  readonly b: string;
  readonly difference: BootstrapResult;
}

export interface Stage0Analysis {
  readonly units_complete: number;
  readonly units_incomplete: readonly string[];
  readonly tasks: number;
  readonly arms: readonly ArmSummary[];
  readonly contrasts: readonly Contrast[];
  readonly hard_stratum: { readonly tasks: readonly string[]; readonly units: number; readonly bon8_unsolved_share: number };
  readonly attempts: { readonly total: number; readonly by_failure_class: Readonly<Record<string, number>>; readonly median_cost_usd: number; readonly median_tokens: Readonly<Record<string, number>>; readonly total_cost_usd: number };
  readonly verdict: Stage0Verdict;
  readonly outcomes: readonly Stage0ArmOutcome[];
}

export interface Stage0Verdict {
  readonly bon_over_current: "pass" | "fail";
  readonly bon_reasons: readonly string[];
  readonly kwide_as_default: "pass" | "fail" | "not_evaluated";
  readonly kwide_reasons: readonly string[];
  readonly abmcts_stage3_headroom: "present" | "absent";
  readonly abmcts_reasons: readonly string[];
  readonly recommended_default: "best_of_n+kwide" | "best_of_n" | "current";
}

export const armLabel = (arm: string, budget: number): string => (arm === "current" ? "current" : `${arm}@${budget}`);

function waveSpanLookup(waves: readonly Stage0WaveRecord[], taskId: string, seed: number): (indices: readonly number[]) => number | null {
  return (indices) => {
    const wave = waves.find((w) => w.task_id === taskId && w.seed === seed && indices.every((i) => w.attempt_indices.includes(i)) && w.attempt_indices.length === indices.length);
    return wave === undefined ? null : wave.wall_ms;
  };
}

export function deriveAllOutcomes(attempts: readonly Stage0AttemptRecord[], waves: readonly Stage0WaveRecord[], design: Stage0Design): { outcomes: Stage0ArmOutcome[]; incomplete: string[] } {
  const outcomes: Stage0ArmOutcome[] = [];
  const incomplete: string[] = [];
  for (const [unitKey, unitAttempts] of groupUnits(attempts)) {
    const { task_id: taskId, seed } = unitAttempts[0];
    try {
      const unit: Stage0ArmOutcome[] = [deriveCurrent(unitAttempts, taskId, seed)];
      for (const budget of design.budget_levels) {
        if (budget === 1) continue;
        unit.push(deriveBestOfN(unitAttempts, taskId, seed, budget, design.usd_unit));
        unit.push(deriveKWide(unitAttempts, taskId, seed, budget, design.usd_unit, design.k_wide, waveSpanLookup(waves, taskId, seed)));
      }
      outcomes.push(...unit);
    } catch (error) {
      if (!(error instanceof Stage0IncompleteUnitError)) throw error;
      incomplete.push(unitKey);
    }
  }
  return { outcomes, incomplete };
}

function clustersFor(outcomes: readonly Stage0ArmOutcome[]): Cluster[] {
  const byTask = new Map<string, Record<string, number[]>>();
  for (const outcome of outcomes) {
    const label = armLabel(outcome.arm, outcome.budget);
    const cluster = byTask.get(outcome.task_id) ?? {};
    const push = (key: string, value: number) => (cluster[key] ??= []).push(value);
    push(`${label}.success`, outcome.verified_and_adopted ? 1 : 0);
    push(`${label}.cost`, outcome.cost_usd);
    push(`${label}.false_acceptance`, outcome.false_acceptance ? 1 : 0);
    byTask.set(outcome.task_id, cluster);
  }
  return [...byTask.values()];
}

export function analyzeStage0(
  tasks: readonly Stage0Task[],
  attempts: readonly Stage0AttemptRecord[],
  waves: readonly Stage0WaveRecord[],
  design: Stage0Design,
): Stage0Analysis {
  const admitted = new Set(tasks.map((task) => task.id));
  const inScope = attempts.filter((attempt) => admitted.has(attempt.task_id));
  const { outcomes, incomplete } = deriveAllOutcomes(inScope, waves, design);
  const clusters = clustersFor(outcomes);
  const labels = ["current", ...design.budget_levels.filter((b) => b !== 1).flatMap((b) => [armLabel("best_of_n", b), armLabel("kwide", b)])];
  const boot = (statistic: Parameters<typeof clusterBootstrap>[1], tag: string) =>
    clusterBootstrap(clusters, statistic, design.bootstrap_resamples, `${design.bootstrap_seed}:${tag}`);

  const arms: ArmSummary[] = labels.map((label) => {
    const own = outcomes.filter((o) => armLabel(o.arm, o.budget) === label);
    const successes = own.filter((o) => o.verified_and_adopted).length;
    const walls = own.map((o) => o.wall_ms);
    return {
      arm: label,
      units: own.length,
      successes,
      rate_wilson: wilsonInterval(successes, own.length),
      rate_task_bootstrap: boot(pooledMean(`${label}.success`), `rate:${label}`),
      mean_cost_usd: own.length === 0 ? Number.NaN : own.reduce((s, o) => s + o.cost_usd, 0) / own.length,
      cost_per_verified: boot(pooledRatio(`${label}.cost`, `${label}.success`), `cpv:${label}`),
      false_acceptance_rate: own.length === 0 ? Number.NaN : own.filter((o) => o.false_acceptance).length / own.length,
      mean_attempts: own.length === 0 ? Number.NaN : own.reduce((s, o) => s + o.dispatched.length, 0) / own.length,
      median_wall_ms: median(walls),
      p90_wall_ms: quantile(walls, 0.9),
    };
  });

  const contrast = (a: string, b: string): Contrast => ({
    name: `${a} − ${b}`,
    a,
    b,
    difference: boot(pooledMeanDifference(`${a}.success`, `${b}.success`), `diff:${a}:${b}`),
  });
  const contrasts: Contrast[] = [];
  for (const budget of design.budget_levels.filter((b) => b !== 1)) {
    contrasts.push(contrast(armLabel("best_of_n", budget), "current"));
    contrasts.push(contrast(armLabel("kwide", budget), armLabel("best_of_n", budget)));
  }
  const budgets = design.budget_levels.filter((b) => b !== 1);
  for (let i = 1; i < budgets.length; i++) contrasts.push(contrast(armLabel("best_of_n", budgets[i]), armLabel("best_of_n", budgets[i - 1])));

  // Hard stratum: tasks whose current-arm rate is at most the threshold.
  const perTask = new Map<string, { current: number[]; bon8: number[] }>();
  const largest = Math.max(...design.budget_levels);
  for (const outcome of outcomes) {
    const entry = perTask.get(outcome.task_id) ?? { current: [], bon8: [] };
    if (outcome.arm === "current") entry.current.push(outcome.verified_and_adopted ? 1 : 0);
    if (outcome.arm === "best_of_n" && outcome.budget === largest) entry.bon8.push(outcome.verified_and_adopted ? 1 : 0);
    perTask.set(outcome.task_id, entry);
  }
  const hard = [...perTask.entries()].filter(([, e]) => e.current.length > 0 && e.current.reduce((s, v) => s + v, 0) / e.current.length <= STAGE0_CRITERIA.hard_task_max_current_rate);
  const hardUnits = hard.reduce((s, [, e]) => s + e.bon8.length, 0);
  const hardUnsolved = hard.reduce((s, [, e]) => s + e.bon8.filter((v) => v === 0).length, 0);

  const byClass: Record<string, number> = {};
  for (const attempt of inScope) {
    const cls = attempt.failure_class ?? "verified_and_adopted";
    byClass[cls] = (byClass[cls] ?? 0) + 1;
  }
  const verdict = stage0Verdict(arms, contrasts, { tasks: hard.length, unsolved_share: hardUnits === 0 ? 0 : hardUnsolved / hardUnits }, budgets);
  return {
    units_complete: new Set(outcomes.map((o) => `${o.task_id}#${o.seed}`)).size,
    units_incomplete: incomplete,
    tasks: perTask.size,
    arms,
    contrasts,
    hard_stratum: { tasks: hard.map(([id]) => id), units: hardUnits, bon8_unsolved_share: hardUnits === 0 ? 0 : hardUnsolved / hardUnits },
    attempts: {
      total: inScope.length,
      by_failure_class: byClass,
      median_cost_usd: median(inScope.map((a) => a.cost_usd)),
      median_tokens: {
        input: median(inScope.map((a) => a.tokens.input)),
        output: median(inScope.map((a) => a.tokens.output)),
        cache_read: median(inScope.map((a) => a.tokens.cache_read)),
      },
      total_cost_usd: inScope.reduce((s, a) => s + a.cost_usd, 0),
    },
    verdict,
    outcomes,
  };
}

/** The preregistered decision rule. Pure over the summaries, so it is unit-tested on synthetic inputs. */
export function stage0Verdict(
  arms: readonly ArmSummary[],
  contrasts: readonly Contrast[],
  hard: { readonly tasks: number; readonly unsolved_share: number },
  budgets: readonly number[],
): Stage0Verdict {
  const arm = (label: string) => arms.find((a) => a.arm === label);
  const primaryBudget = budgets.includes(4) ? 4 : budgets[0];
  const bonLabel = armLabel("best_of_n", primaryBudget);
  const kwLabel = armLabel("kwide", primaryBudget);
  const current = arm("current");
  const bon = arm(bonLabel);
  const kw = arm(kwLabel);
  const bonReasons: string[] = [];
  let bonPass = current !== undefined && bon !== undefined;
  const primary = contrasts.find((c) => c.a === bonLabel && c.b === "current");
  if (primary === undefined || !(primary.difference.lower > 0)) {
    bonPass = false;
    bonReasons.push(`${bonLabel} − current: 95% task-bootstrap CI lower bound ${primary?.difference.lower.toFixed(3) ?? "n/a"} is not > 0`);
  } else bonReasons.push(`${bonLabel} − current = ${primary.difference.estimate.toFixed(3)} [${primary.difference.lower.toFixed(3)}, ${primary.difference.upper.toFixed(3)}] excludes 0`);
  if (current !== undefined && bon !== undefined) {
    const ratio = bon.cost_per_verified.estimate / current.cost_per_verified.estimate;
    if (!(ratio <= STAGE0_CRITERIA.bon_cost_per_verified_max_ratio)) {
      bonPass = false;
      bonReasons.push(`cost per verified ratio ${ratio.toFixed(2)} exceeds ${STAGE0_CRITERIA.bon_cost_per_verified_max_ratio}`);
    } else bonReasons.push(`cost per verified ratio ${ratio.toFixed(2)} ≤ ${STAGE0_CRITERIA.bon_cost_per_verified_max_ratio}`);
    const faIncrease = bon.false_acceptance_rate - current.false_acceptance_rate;
    if (!(faIncrease <= STAGE0_CRITERIA.false_acceptance_max_increase)) {
      bonPass = false;
      bonReasons.push(`false-acceptance increase ${faIncrease.toFixed(3)} exceeds ${STAGE0_CRITERIA.false_acceptance_max_increase}`);
    } else bonReasons.push(`false-acceptance increase ${faIncrease.toFixed(3)} ≤ ${STAGE0_CRITERIA.false_acceptance_max_increase}`);
  }
  const kwReasons: string[] = [];
  let kwide: Stage0Verdict["kwide_as_default"] = "not_evaluated";
  if (bonPass && kw !== undefined && bon !== undefined) {
    const wallFraction = kw.median_wall_ms / bon.median_wall_ms;
    const costRatio = kw.cost_per_verified.estimate / bon.cost_per_verified.estimate;
    const wallOk = wallFraction <= STAGE0_CRITERIA.kwide_wall_max_fraction;
    const costOk = costRatio <= STAGE0_CRITERIA.kwide_cost_per_verified_max_ratio;
    kwReasons.push(`median wall ${kwLabel}/${bonLabel} = ${wallFraction.toFixed(2)} (needs ≤ ${STAGE0_CRITERIA.kwide_wall_max_fraction})`);
    kwReasons.push(`cost per verified ${kwLabel}/${bonLabel} = ${costRatio.toFixed(2)} (needs ≤ ${STAGE0_CRITERIA.kwide_cost_per_verified_max_ratio})`);
    kwide = wallOk && costOk ? "pass" : "fail";
  } else if (!bonPass) kwReasons.push("not evaluated: best_of_n did not pass");
  const abReasons: string[] = [];
  const headroom = hard.tasks >= STAGE0_CRITERIA.hard_stratum_min_tasks && hard.unsolved_share >= STAGE0_CRITERIA.hard_stratum_min_unsolved_bon8;
  abReasons.push(`hard-stratum tasks ${hard.tasks} (needs ≥ ${STAGE0_CRITERIA.hard_stratum_min_tasks})`);
  abReasons.push(`best_of_n@max unsolved share in hard stratum ${hard.unsolved_share.toFixed(3)} (needs ≥ ${STAGE0_CRITERIA.hard_stratum_min_unsolved_bon8})`);
  return {
    bon_over_current: bonPass ? "pass" : "fail",
    bon_reasons: bonReasons,
    kwide_as_default: kwide,
    kwide_reasons: kwReasons,
    abmcts_stage3_headroom: headroom ? "present" : "absent",
    abmcts_reasons: abReasons,
    recommended_default: !bonPass ? "current" : kwide === "pass" ? "best_of_n+kwide" : "best_of_n",
  };
}
