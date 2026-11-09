// Shared fixtures for the search-core tests: configs, a synchronous step driver,
// and a synthetic coding-shaped task simulator. The simulator is a correctness
// and regression lane for the policies only — it is NOT efficacy evidence
// (ADR-131); real-world benefit is Stage 0's measurement.

import { createSeededRng, hashSeed } from "../../src/search/rng.js";
import { applySearchObservation, createSearchStep, decideSearchStep } from "../../src/search/step.js";
import type {
  SearchAction,
  SearchConfig,
  SearchLedgerEvent,
  SearchPolicyConfig,
  SearchRewardInput,
  SearchStepState,
  SearchStopReason,
  VerifiedProvenance,
} from "../../src/search/types.js";

export const VERIFIED: VerifiedProvenance = { tag: "verified", cmd: "bun run test", exit: 0, stdout_hash: "sha256:fixture" };

export const POLICIES: Record<SearchPolicyConfig["kind"], SearchPolicyConfig> = {
  abmcts_beta: { kind: "abmcts_beta", prior: { alpha: 1, beta: 1 }, virtual_loss: 1 },
  puct: { kind: "puct", c_puct: 1, q_init: 0.5, gen_prior_weight: 1 },
  arbor_eq1: {
    kind: "arbor_eq1",
    score_context: { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 0 },
    score_config: { exploration_constant: Math.SQRT2 },
  },
  best_of_n: { kind: "best_of_n" },
  refine_chain: { kind: "refine_chain" },
};

export function config(policy: SearchPolicyConfig, overrides: Partial<SearchConfig> = {}): SearchConfig {
  return {
    policy,
    seed: "seed-1",
    budget: { max_usd: 100, max_attempts: 8 },
    max_refine_depth: 3,
    max_width: null,
    step_prior: { estimated_gain: 1, estimated_cost: 1, category: "fix" },
    ...overrides,
  };
}

/** What an attempt produced; the driver turns it into a SearchRewardInput. */
export interface AttemptOutcome {
  readonly verified: boolean;
  readonly reward: number;
  readonly cost_usd: number;
}

export type Oracle = (action: SearchAction, attemptId: string, state: SearchStepState) => AttemptOutcome;

export interface StepRun {
  readonly events: SearchLedgerEvent[];
  readonly state: SearchStepState;
  readonly stop: SearchStopReason;
  readonly actions: SearchAction[];
}

/** Sequential (K = 1) driver: decide, observe, repeat until the core says stop. */
export function runStep(stepId: string, searchConfig: SearchConfig, oracle: Oracle): StepRun {
  let state = createSearchStep(stepId);
  const events: SearchLedgerEvent[] = [];
  const actions: SearchAction[] = [];
  for (;;) {
    const decision = decideSearchStep(state, searchConfig);
    if (decision.kind === "stop") return { events, state, stop: decision.reason, actions };
    if (decision.kind === "await") throw new Error("a sequential driver never has an attempt in flight");
    events.push({ kind: "decision", record: decision.record });
    actions.push(decision.record.action);
    const outcome = oracle(decision.record.action, decision.record.attempt_id, decision.state);
    const observation: SearchRewardInput = {
      attempt_id: decision.record.attempt_id,
      reward: outcome.verified ? 1 : outcome.reward,
      verification: outcome.verified ? VERIFIED : null,
      cost_usd: outcome.cost_usd,
    };
    events.push({ kind: "observation", observation });
    state = applySearchObservation(decision.state, observation);
  }
}

/**
 * A synthetic task. Every attempt has a latent quality q in [0, 1]: it verifies
 * with probability q, and a failure reports a noisy graded reward around q
 * (capped below 1, so a failure never looks verified). GEN draws q around the
 * task's p; REFINE moves its parent's q by delta, so delta > 0 makes deeper
 * search pay, delta < 0 makes it harmful, and delta = 0 makes it neutral.
 */
export interface SyntheticTask {
  readonly id: string;
  readonly p: number;
  readonly delta: number;
  readonly cost_usd: number;
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

export function syntheticOracle(task: SyntheticTask): Oracle {
  const rng = createSeededRng(hashSeed(`oracle\u0000${task.id}`));
  const quality = new Map<string, number>();
  return (action, attemptId) => {
    const jitter = 0.2 * rng.nextUniform() - 0.1;
    const q = action.kind === "gen"
      ? clamp(task.p + jitter, 0, 1)
      : clamp((quality.get(action.attempt_id) as number) + task.delta + jitter / 2, 0, 1);
    quality.set(attemptId, q);
    const verified = rng.nextUniform() < q;
    const graded = clamp(q + 0.3 * rng.nextUniform() - 0.15, 0, 0.9);
    return { verified, reward: verified ? 1 : graded, cost_usd: task.cost_usd };
  };
}

export function syntheticTasks(prefix: string, count: number, p: [number, number], delta: number): SyntheticTask[] {
  const rng = createSeededRng(hashSeed(`tasks\u0000${prefix}`));
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    p: p[0] + (p[1] - p[0]) * rng.nextUniform(),
    delta,
    cost_usd: 0.01,
  }));
}
