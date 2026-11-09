import { describe, expect, it } from "vitest";
import { scoreAction } from "../../src/scoring.js";
import { selectSearchAction } from "../../src/search/policy.js";
import { createSeededRng, hashSeed } from "../../src/search/rng.js";
import { applySearchObservation, createSearchStep, decideSearchStep, replaySearchStep, validateSearchConfig } from "../../src/search/step.js";
import { SEARCH_POLICY_KINDS, SearchContractError } from "../../src/search/types.js";
import type { SearchConfig, SearchDecisionRecord, SearchLedgerEvent, SearchPolicyConfig, SearchStepState } from "../../src/search/types.js";
import { POLICIES, VERIFIED, config, runStep, syntheticOracle, syntheticTasks } from "./harness.js";
import type { Oracle } from "./harness.js";

const ALL_POLICIES = SEARCH_POLICY_KINDS.map((kind) => POLICIES[kind]);

/** Dispatch then observe `rewards` in order, all unverified. */
function observeSequence(searchConfig: SearchConfig, rewards: readonly number[]): SearchStepState {
  let state = createSearchStep("step");
  for (const reward of rewards) {
    const decision = decideSearchStep(state, searchConfig);
    if (decision.kind !== "dispatch") throw new Error(`expected dispatch, got ${decision.kind}`);
    state = applySearchObservation(decision.state, { attempt_id: decision.record.attempt_id, reward, verification: null, cost_usd: 0.01 });
  }
  return state;
}

function dispatch(state: SearchStepState, searchConfig: SearchConfig): { record: SearchDecisionRecord; state: SearchStepState } {
  const decision = decideSearchStep(state, searchConfig);
  if (decision.kind !== "dispatch") throw new Error(`expected dispatch, got ${decision.kind}`);
  return decision;
}

const never: Oracle = () => ({ verified: false, reward: 0.3, cost_usd: 0.01 });

describe("Thompson posterior updates (abmcts_beta)", () => {
  it("adds each observed reward as fractional pseudo-counts to the GEN arm", () => {
    const rng = createSeededRng(hashSeed("posterior-property"));
    const flat = config(POLICIES.abmcts_beta, { max_refine_depth: 0, budget: { max_usd: 100, max_attempts: 50 } });
    for (let trial = 0; trial < 50; trial++) {
      const rewards = Array.from({ length: 1 + (rng.nextUint32() % 12) }, () => Math.round(rng.nextUniform() * 900) / 1000);
      const { record } = dispatch(observeSequence(flat, rewards), flat);
      const stats = record.levels[0].arms[0].stats;
      if (stats.kind !== "beta") throw new Error("expected beta stats");
      const sum = rewards.reduce((total, reward) => total + reward, 0);
      expect(stats.alpha).toBeCloseTo(1 + sum, 12);
      expect(stats.beta).toBeCloseTo(1 + rewards.length - sum, 12);
      expect(stats.draw).toBeGreaterThan(0);
      expect(stats.draw).toBeLessThan(1);
    }
  });

  it("gates GEN against the aggregated CONT arm, then picks a child by its subtree posterior", () => {
    const deep = config(POLICIES.abmcts_beta);
    let state = observeSequence(deep, [0.4]);
    // CONT has no deeper result yet, so it carries only the prior.
    const first = dispatch(state, deep).record;
    expect(first.levels[0].arms.map((arm) => arm.arm)).toEqual(["gen", "cont"]);
    expect(first.levels[0].arms[0].stats).toMatchObject({ kind: "beta", alpha: 1.4, beta: 1.6 });
    expect(first.levels[0].arms[1].stats).toMatchObject({ kind: "beta", alpha: 1, beta: 1 });

    // Force a refinement of a0 so CONT has evidence, then inspect the gate again.
    state = applySearchObservation(
      { ...state, attempts: [...state.attempts, { id: "step/a1", parent_id: "step/a0", depth: 1, status: "in_flight", reward: null, verified: false, cost_usd: null, refine_prior: null }], decisions: 2 },
      { attempt_id: "step/a1", reward: 0.8, verification: null, cost_usd: 0.01 },
    );
    const second = dispatch(state, deep).record;
    expect(second.levels[0].arms[1].stats).toMatchObject({ kind: "beta", alpha: 1.8 });

    // Width 1 closes every GEN arm that already has a child, so the descent is forced:
    // base → a0 (subtree a0 + a1) → a1 → refine a1.
    const forced = dispatch(state, { ...deep, max_width: 1 }).record;
    expect(forced.levels.map((level) => [level.node, level.chosen])).toEqual([[null, "step/a0"], ["step/a0", "step/a1"], ["step/a1", "gen"]]);
    expect(forced.levels[0].arms).toHaveLength(1);
    expect(forced.levels[0].arms[0]).toMatchObject({ arm: "step/a0", visits: 2 });
    const subtreeStats = forced.levels[0].arms[0].stats;
    if (subtreeStats.kind !== "beta") throw new Error("expected beta stats");
    expect(subtreeStats.alpha).toBeCloseTo(1 + 0.4 + 0.8, 12);
    expect(subtreeStats.beta).toBeCloseTo(1 + 0.6 + 0.2, 12);
    expect(forced.action).toEqual({ kind: "refine", attempt_id: "step/a1" });
  });

  it("charges virtual loss for an in-flight attempt", () => {
    const flat = config({ kind: "abmcts_beta", prior: { alpha: 2, beta: 3 }, virtual_loss: 1.5 }, { max_refine_depth: 0 });
    const first = dispatch(createSearchStep("step"), flat);
    const second = dispatch(first.state, flat).record;
    expect(second.levels[0].arms[0]).toMatchObject({ arm: "gen", visits: 1, stats: { kind: "beta", alpha: 2, beta: 4.5 } });
  });

  it("re-derives one decision from its recorded rng state alone", () => {
    const deep = config(POLICIES.abmcts_beta);
    const state = observeSequence(deep, [0.2, 0.7, 0.1]);
    const { record } = dispatch(state, deep);
    const selection = selectSearchAction(state, deep, createSeededRng(record.rng_state));
    expect(selection?.levels).toEqual(record.levels);
    expect(selection?.action).toEqual(record.action);
  });
});

describe("stopping", () => {
  it("stops at the attempt cap for every policy", () => {
    for (const policy of ALL_POLICIES) {
      const run = runStep("cap", config(policy, { budget: { max_usd: 100, max_attempts: 5 } }), never);
      expect(run.stop).toBe("attempt_cap");
      expect(run.state.attempts).toHaveLength(5);
    }
  });

  it("stops when provider-measured spend reaches the USD budget", () => {
    for (const policy of ALL_POLICIES) {
      const run = runStep("usd", config(policy, { budget: { max_usd: 0.035, max_attempts: 50 } }), never);
      expect(run.stop).toBe("usd_exhausted");
      expect(run.state.attempts).toHaveLength(4);
      expect(run.state.spent_usd).toBeGreaterThanOrEqual(0.035);
    }
  });

  it("ends the step at the first !verified attempt for every policy", () => {
    for (const policy of ALL_POLICIES) {
      for (const verifyAt of [0, 2, 5]) {
        let calls = 0;
        const oracle: Oracle = () => ({ verified: calls++ === verifyAt, reward: 0.4, cost_usd: 0.01 });
        const run = runStep("first", config(policy, { budget: { max_usd: 100, max_attempts: 20 } }), oracle);
        expect(run.stop).toBe("verified");
        expect(run.state.attempts).toHaveLength(verifyAt + 1);
        expect(run.state.attempts.filter((attempt) => attempt.verified)).toHaveLength(1);
      }
    }
  });

  it("never stops on reward 1 without !verified provenance", () => {
    const run = runStep("unverified", config(POLICIES.best_of_n, { budget: { max_usd: 100, max_attempts: 3 } }), () => ({ verified: false, reward: 1, cost_usd: 0 }));
    expect(run.stop).toBe("attempt_cap");
    expect(run.state.attempts.every((attempt) => !attempt.verified)).toBe(true);
  });

  it("awaits an in-flight attempt at a limit or with no arm, and stops once it lands", () => {
    const capped = config(POLICIES.best_of_n, { budget: { max_usd: 100, max_attempts: 1 } });
    const inFlight = dispatch(createSearchStep("step"), capped).state;
    expect(decideSearchStep(inFlight, capped)).toEqual({ kind: "await" });
    const landed = applySearchObservation(inFlight, { attempt_id: "step/a0", reward: 0.2, verification: null, cost_usd: 0.01 });
    expect(decideSearchStep(landed, capped)).toEqual({ kind: "stop", reason: "attempt_cap" });

    const narrow = config(POLICIES.best_of_n, { max_width: 1 });
    const narrowInFlight = dispatch(createSearchStep("step"), narrow).state;
    expect(decideSearchStep(narrowInFlight, narrow)).toEqual({ kind: "await" });
    const narrowLanded = applySearchObservation(narrowInFlight, { attempt_id: "step/a0", reward: 0.2, verification: null, cost_usd: 0.01 });
    expect(decideSearchStep(narrowLanded, narrow)).toEqual({ kind: "stop", reason: "arms_exhausted" });

    const spent = config(POLICIES.best_of_n, { budget: { max_usd: 0.01, max_attempts: 5 } });
    const spentState = applySearchObservation(dispatch(createSearchStep("step"), spent).state, { attempt_id: "step/a0", reward: 0, verification: null, cost_usd: 0.02 });
    const another = dispatch({ ...spentState, spent_usd: 0 }, spent).state;
    expect(decideSearchStep({ ...another, spent_usd: 0.02 }, spent)).toEqual({ kind: "await" });
  });

  it("verified wins over an attempt still in flight", () => {
    const wide = config(POLICIES.best_of_n);
    const twoInFlight = dispatch(dispatch(createSearchStep("step"), wide).state, wide).state;
    const oneVerified = applySearchObservation(twoInFlight, { attempt_id: "step/a1", reward: 1, verification: VERIFIED, cost_usd: 0.01 });
    expect(decideSearchStep(oneVerified, wide)).toEqual({ kind: "stop", reason: "verified" });
  });

  it("exhausts arms when width and depth allow nothing more", () => {
    for (const policy of ALL_POLICIES) {
      const run = runStep("width", config(policy, { max_width: 2, max_refine_depth: 0 }), never);
      expect(run.stop).toBe("arms_exhausted");
      expect(run.state.attempts).toHaveLength(2);
    }
  });
});

describe("best-of-N equivalence", () => {
  it("every policy with depth 0 and width N dispatches exactly best-of-N", () => {
    for (const task of syntheticTasks("equivalence", 60, [0.05, 0.5], 0.2)) {
      for (const n of [1, 4, 8]) {
        const baseline = runStep(task.id, config(POLICIES.best_of_n, { max_refine_depth: 0, max_width: n, budget: { max_usd: 100, max_attempts: n } }), syntheticOracle(task));
        for (const policy of ALL_POLICIES) {
          const run = runStep(task.id, config(policy, { max_refine_depth: 0, max_width: n, budget: { max_usd: 100, max_attempts: n } }), syntheticOracle(task));
          expect(run.actions).toEqual(baseline.actions);
          expect(run.stop).toBe(baseline.stop);
          expect(run.state.attempts).toEqual(baseline.state.attempts);
          expect(run.actions.every((action) => action.kind === "gen")).toBe(true);
        }
      }
    }
  });
});

describe("deterministic replay", () => {
  it("replays every policy's ledger bit-for-bit and lands on the same state", () => {
    for (const policy of ALL_POLICIES) {
      for (const task of syntheticTasks(`replay-${policy.kind}`, 20, [0.02, 0.3], 0.1)) {
        const searchConfig = config(policy, { budget: { max_usd: 100, max_attempts: 12 } });
        const run = runStep(task.id, searchConfig, syntheticOracle(task));
        const replay = replaySearchStep(task.id, searchConfig, JSON.parse(JSON.stringify(run.events)) as SearchLedgerEvent[]);
        expect(replay.ok).toBe(true);
        if (!replay.ok) continue;
        expect(replay.state).toEqual(run.state);
        expect(replay.next).toEqual({ kind: "stop", reason: run.stop });
      }
    }
  });

  it("reports the first event whose re-derived decision differs", () => {
    const searchConfig = config(POLICIES.abmcts_beta, { budget: { max_usd: 100, max_attempts: 10 } });
    const run = runStep("tamper", searchConfig, never);
    const events = structuredClone(run.events);
    const target = events[4];
    if (target.kind !== "decision") throw new Error("expected a decision at index 4");
    const stats = target.record.levels[0].arms[0].stats;
    if (stats.kind !== "beta") throw new Error("expected beta stats");
    (stats as { draw: number }).draw = stats.draw + Number.EPSILON;
    const replay = replaySearchStep("tamper", searchConfig, events);
    expect(replay).toMatchObject({ ok: false, event_index: 4, reason: "re-derived decision differs from the recorded one" });

    const reseeded = replaySearchStep("tamper", { ...searchConfig, seed: "other" }, run.events);
    expect(reseeded).toMatchObject({ ok: false, event_index: 0 });
  });

  it("rejects a decision recorded after the step stopped, and a bad observation", () => {
    const searchConfig = config(POLICIES.best_of_n, { budget: { max_usd: 100, max_attempts: 2 } });
    const run = runStep("extra", searchConfig, never);
    const extra = replaySearchStep("extra", searchConfig, [...run.events, run.events[0]]);
    expect(extra).toMatchObject({ ok: false, event_index: run.events.length, reason: "recorded a decision where the policy yields stop" });
    const badObservation = replaySearchStep("extra", searchConfig, [run.events[0], run.events[1], run.events[1]]);
    expect(badObservation).toMatchObject({ ok: false, event_index: 2, expected: null, actual: null });
  });

  it("treats -0 and 0 as different numbers when comparing records", () => {
    const searchConfig = config(POLICIES.best_of_n);
    const run = runStep("zero", { ...searchConfig, budget: { max_usd: 100, max_attempts: 1 } }, never);
    const events = structuredClone(run.events);
    const first = events[0];
    if (first.kind !== "decision") throw new Error("expected a decision");
    (first.record as { spent_usd_before: number }).spent_usd_before = -0;
    expect(replaySearchStep("zero", { ...searchConfig, budget: { max_usd: 100, max_attempts: 1 } }, events)).toMatchObject({ ok: false, event_index: 0 });
    const reshaped = structuredClone(run.events);
    const reshapedFirst = reshaped[0];
    if (reshapedFirst.kind !== "decision") throw new Error("expected a decision");
    (reshapedFirst.record as unknown as { levels: unknown }).levels = {};
    expect(replaySearchStep("zero", { ...searchConfig, budget: { max_usd: 100, max_attempts: 1 } }, reshaped)).toMatchObject({ ok: false });
    (reshapedFirst.record as unknown as { extra: number }).extra = 1;
    expect(replaySearchStep("zero", { ...searchConfig, budget: { max_usd: 100, max_attempts: 1 } }, reshaped)).toMatchObject({ ok: false });
  });
});

describe("policy specifics", () => {
  it("puct follows its priors and q", () => {
    const noGenPrior = config({ kind: "puct", c_puct: 1, q_init: 0, gen_prior_weight: 0 });
    const state = observeSequence(noGenPrior, [0.3]);
    expect(dispatch(state, noGenPrior).record.action).toEqual({ kind: "refine", attempt_id: "step/a0" });

    const strongGen = config({ kind: "puct", c_puct: 1, q_init: 0, gen_prior_weight: 1000 });
    const genRecord = dispatch(state, strongGen).record;
    expect(genRecord.action).toEqual({ kind: "gen" });
    expect(genRecord.levels[0].arms[0].stats).toMatchObject({ kind: "puct", q: 0.3 });

    // An observation's refine_prior feeds the child arm's prior weight.
    const weighted = applySearchObservation(dispatch(createSearchStep("step"), strongGen).state, { attempt_id: "step/a0", reward: 0.3, verification: null, cost_usd: 0, refine_prior: 3000 });
    const weightedRecord = dispatch(weighted, strongGen).record;
    expect(weightedRecord.levels[0].arms[1].stats).toMatchObject({ kind: "puct", prior: 0.75 });

    // All-zero weights fall back to a uniform prior.
    const zero = config({ kind: "puct", c_puct: 1, q_init: 0.5, gen_prior_weight: 0 }, { max_refine_depth: 0 });
    expect(dispatch(createSearchStep("step"), zero).record.levels[0].arms[0].stats).toMatchObject({ kind: "puct", prior: 1, q: 0.5 });
  });

  it("arbor_eq1 scores every arm with the production eq. 1 scorer and uses no randomness", () => {
    const eq1 = config(POLICIES.arbor_eq1);
    const state = observeSequence(eq1, [0.3, 0.6]);
    const record = dispatch(state, eq1).record;
    const reseeded = dispatch(state, { ...eq1, seed: "different" }).record;
    expect(reseeded.levels).toEqual(record.levels);
    const policy = POLICIES.arbor_eq1 as Extract<SearchPolicyConfig, { kind: "arbor_eq1" }>;
    const total = record.levels[0].arms.reduce((sum, arm) => sum + arm.visits, 0);
    for (const arm of record.levels[0].arms) {
      const expected = scoreAction(
        { description: "", delegate_to: "", estimated_gain: 1, estimated_cost: 1, category: "fix" },
        { ...policy.score_context, total_visits: total },
        arm.visits,
        policy.score_config,
      );
      expect(arm.stats).toEqual({ kind: "eq1", score: expected });
    }
  });

  it("refine_chain refines the latest attempt until the depth cap, then widens", () => {
    const run = runStep("chain", config(POLICIES.refine_chain, { max_refine_depth: 2, budget: { max_usd: 100, max_attempts: 6 } }), never);
    expect(run.actions).toEqual([
      { kind: "gen" },
      { kind: "refine", attempt_id: "chain/a0" },
      { kind: "refine", attempt_id: "chain/a1" },
      { kind: "gen" },
      { kind: "refine", attempt_id: "chain/a3" },
      { kind: "refine", attempt_id: "chain/a4" },
    ]);
    expect(run.state.attempts.map((attempt) => attempt.depth)).toEqual([0, 1, 2, 0, 1, 2]);
    const capped = runStep("chain", config(POLICIES.refine_chain, { max_refine_depth: 0, max_width: 1 }), never);
    expect(capped.stop).toBe("arms_exhausted");
  });
});

describe("contracts", () => {
  const searchConfig = config(POLICIES.best_of_n);
  const inFlight = (): SearchStepState => dispatch(createSearchStep("step"), searchConfig).state;

  it("rejects malformed observations", () => {
    const cases: Array<[string, Parameters<typeof applySearchObservation>[1]]> = [
      ["unknown attempt", { attempt_id: "nope", reward: 0, verification: null, cost_usd: 0 }],
      ["reward", { attempt_id: "step/a0", reward: 1.5, verification: null, cost_usd: 0 }],
      ["reward", { attempt_id: "step/a0", reward: Number.NaN, verification: null, cost_usd: 0 }],
      ["cost_usd", { attempt_id: "step/a0", reward: 0.5, verification: null, cost_usd: -1 }],
      ["refine_prior", { attempt_id: "step/a0", reward: 0.5, verification: null, cost_usd: 0, refine_prior: -1 }],
      ["reward 1", { attempt_id: "step/a0", reward: 0.9, verification: VERIFIED, cost_usd: 0 }],
      ["exit 0", { attempt_id: "step/a0", reward: 1, verification: { ...VERIFIED, exit: 1 }, cost_usd: 0 }],
      ["!verified", { attempt_id: "step/a0", reward: 1, verification: { tag: "claimed", claimant: "seed" } as never, cost_usd: 0 }],
    ];
    for (const [message, observation] of cases) {
      expect(() => applySearchObservation(inFlight(), observation)).toThrow(SearchContractError);
      expect(() => applySearchObservation(inFlight(), observation)).toThrow(message);
    }
    const landed = applySearchObservation(inFlight(), { attempt_id: "step/a0", reward: 0.5, verification: null, cost_usd: 0 });
    expect(() => applySearchObservation(landed, { attempt_id: "step/a0", reward: 0.5, verification: null, cost_usd: 0 })).toThrow("already observed");
  });

  it("validates configuration and refuses to decide on an invalid one", () => {
    expect(validateSearchConfig(config(POLICIES.abmcts_beta))).toEqual([]);
    const problems = validateSearchConfig({
      ...config({ kind: "abmcts_beta", prior: { alpha: 0, beta: 1 }, virtual_loss: -1 }),
      seed: "",
      budget: { max_usd: 0, max_attempts: 0.5 },
      max_refine_depth: -1,
      max_width: 0,
    });
    expect(problems).toHaveLength(7);
    expect(validateSearchConfig(config({ kind: "puct", c_puct: -1, q_init: 2, gen_prior_weight: Number.NaN }))).toHaveLength(3);
    expect(validateSearchConfig(config({ kind: "mystery" } as never))).toEqual(["unknown policy mystery"]);
    expect(() => decideSearchStep(createSearchStep("step"), config(POLICIES.best_of_n, { seed: "" }))).toThrow(SearchContractError);
    expect(() => createSearchStep("")).toThrow(SearchContractError);
  });
});
