import { describe, it, expect } from "vitest";
import { combineReward, DEFAULT_REWARD_CONTRACT, RewardContractError } from "../src/reward.js";
import type { RewardObservation, VerifiedProvenance } from "../src/reward.js";

const verified: VerifiedProvenance = { tag: "verified", cmd: "bun test", exit: 0, stdout_hash: "sha256:abc" };

/** Deterministic LCG so the properties are reproducible without a new dependency. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function randomObservations(next: () => number): RewardObservation[] {
  const observations: RewardObservation[] = [];
  const count = Math.floor(next() * 5);
  for (let i = 0; i < count; i++) {
    const pick = next();
    if (pick < 0.2) observations.push({ channel: "terminal", provenance: verified });
    else if (pick < 0.6) {
      const total = 1 + Math.floor(next() * 10);
      observations.push({ channel: "graded", source: "verification_stage_fraction", stages_passed: Math.floor(next() * (total + 1)), stages_total: total });
    } else {
      observations.push({ channel: "estimate", source: "critic_confidence", value: next(), calibration: null });
    }
  }
  return observations;
}

function shuffle<T>(items: readonly T[], next: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

describe("combineReward — the provenance-typed reward contract", () => {
  it("a !verified terminal pass is exactly 1, whatever else was observed", () => {
    const reward = combineReward([
      { channel: "graded", source: "verification_stage_fraction", stages_passed: 0, stages_total: 5 },
      { channel: "terminal", provenance: verified },
    ]);
    expect(reward).toMatchObject({ value: 1, source: "verified_terminal", measured: true, provenance_tag: "verified" });
  });

  it("a failed verification backs up the weighted fraction of stages passed", () => {
    const reward = combineReward([{ channel: "graded", source: "verification_stage_fraction", stages_passed: 3, stages_total: 4 }]);
    expect(reward.value).toBeCloseTo(DEFAULT_REWARD_CONTRACT.graded_weight * 0.75, 12);
    expect(reward).toMatchObject({ source: "measured_partial", measured: true, provenance_tag: "generated" });
  });

  it("nothing observed is an unmeasured 0, not a low score", () => {
    expect(combineReward([])).toEqual({ value: 0, source: "unmeasured", measured: false, provenance_tag: null, components: [] });
  });

  it("an uncalibrated critic estimate is recorded but weighs 0", () => {
    const reward = combineReward([{ channel: "estimate", source: "critic_confidence", value: 0.99, calibration: null }]);
    expect(reward.value).toBe(0);
    expect(reward.source).toBe("unmeasured");
    expect(reward.components).toEqual([
      { channel: "estimate", source: "critic_confidence", raw: 0.99, weight: 0, contribution: 0, provenance_tag: "critic_approved", calibration_id: null },
    ]);
  });

  it("a calibrated estimate contributes its recorded weight but is never a measurement", () => {
    const config = { graded_weight: 0.6, ceiling: 0.9 };
    const estimateOnly = combineReward([{ channel: "estimate", source: "critic_confidence", value: 0.5, calibration: { calibration_id: "cal_1", weight: 0.3 } }], config);
    expect(estimateOnly).toMatchObject({ value: 0.15, source: "calibrated_estimate", measured: false });
    const blended = combineReward([
      { channel: "graded", source: "verification_stage_fraction", stages_passed: 1, stages_total: 1 },
      { channel: "estimate", source: "critic_confidence", value: 1, calibration: { calibration_id: "cal_1", weight: 0.3 } },
    ], config);
    expect(blended.value).toBeCloseTo(0.9, 12);
    expect(blended.source).toBe("measured_partial");
  });

  it("refuses a calibration weight that could lift a failure to a verified pass", () => {
    expect(() => combineReward([
      { channel: "estimate", source: "critic_confidence", value: 1, calibration: { calibration_id: "cal_1", weight: 0.5 } },
    ])).toThrow(RewardContractError);
    expect(() => combineReward([
      { channel: "estimate", source: "critic_confidence", value: 1, calibration: { calibration_id: " ", weight: 0 } },
    ])).toThrow(RewardContractError);
  });

  it("refuses malformed stage counts, estimates, provenance and configuration rather than coercing them", () => {
    const graded = (stages_passed: number, stages_total: number): RewardObservation =>
      ({ channel: "graded", source: "verification_stage_fraction", stages_passed, stages_total });
    for (const [passed, total] of [[1, 0], [3, 2], [-1, 2], [0.5, 2], [Number.NaN, 2]] as const) {
      expect(() => combineReward([graded(passed, total)])).toThrow(RewardContractError);
    }
    expect(() => combineReward([{ channel: "estimate", source: "critic_confidence", value: 1.5, calibration: null }])).toThrow(RewardContractError);
    const forged = { channel: "terminal", provenance: { tag: "claimed", claimant: "seed" } } as unknown as RewardObservation;
    expect(() => combineReward([forged])).toThrow(RewardContractError);
    expect(() => combineReward([], { graded_weight: 0.9, ceiling: 1 })).toThrow(RewardContractError);
    expect(() => combineReward([], { graded_weight: 0.95, ceiling: 0.9 })).toThrow(RewardContractError);
  });

  it("property: only a terminal pass reaches 1; every value lies in [0, 1]", () => {
    const next = rng(0x5eed_0001);
    for (let trial = 0; trial < 500; trial++) {
      const observations = randomObservations(next);
      const reward = combineReward(observations);
      expect(reward.value).toBeGreaterThanOrEqual(0);
      expect(reward.value).toBeLessThanOrEqual(1);
      const hasTerminal = observations.some((observation) => observation.channel === "terminal");
      if (hasTerminal) expect(reward.value).toBe(1);
      else expect(reward.value).toBeLessThanOrEqual(DEFAULT_REWARD_CONTRACT.ceiling);
    }
  });

  it("property: a planner prior never influences a backed-up value", () => {
    // Priors are not a field of any observation type. Smuggling them onto an
    // observation (as a careless caller spreading an Action might) must not
    // move the value, the source, or the audited components.
    const next = rng(0x5eed_0002);
    for (let trial = 0; trial < 300; trial++) {
      const observations = randomObservations(next);
      const baseline = combineReward(observations);
      const polluted = observations.map((observation) => ({
        ...observation,
        estimated_gain: next() * 1_000,
        estimated_cost: next() * 100,
        score: next() * 50,
        exploration_bonus: next(),
      })) as unknown as RewardObservation[];
      expect(combineReward(polluted)).toEqual(baseline);
    }
  });

  it("property: replay is deterministic and independent of observation order", () => {
    const next = rng(0x5eed_0003);
    for (let trial = 0; trial < 300; trial++) {
      const observations = randomObservations(next);
      const recorded = JSON.stringify(combineReward(observations));
      expect(JSON.stringify(combineReward(structuredClone(observations)))).toBe(recorded);
      expect(JSON.stringify(combineReward(shuffle(observations, next)))).toBe(recorded);
    }
  });
});
