import { describe, expect, it } from "vitest";
import { createSeededRng, deriveDecisionState, hashSeed, sampleBeta, sampleGamma } from "../../src/search/rng.js";

describe("seeded rng", () => {
  it("hashes seeds to a stable uint32", () => {
    expect(hashSeed("")).toBe(0x811c9dc5);
    expect(hashSeed("a")).toBe(0xe40c292c);
    expect(hashSeed("seed")).toBe(hashSeed("seed"));
    expect(hashSeed("seed")).not.toBe(hashSeed("seee"));
  });

  it("rejects a state that is not a uint32", () => {
    for (const bad of [-1, 1.5, 2 ** 32, Number.NaN]) expect(() => createSeededRng(bad)).toThrow(RangeError);
  });

  it("continues the identical stream from a recorded state", () => {
    const first = createSeededRng(12345);
    for (let i = 0; i < 10; i++) first.nextUint32();
    const resumed = createSeededRng(first.state());
    const fromFirst = Array.from({ length: 50 }, () => first.nextUniform());
    const fromResumed = Array.from({ length: 50 }, () => resumed.nextUniform());
    expect(fromResumed).toEqual(fromFirst);
  });

  it("draws uniforms strictly inside (0, 1)", () => {
    const rng = createSeededRng(7);
    for (let i = 0; i < 10_000; i++) {
      const u = rng.nextUniform();
      expect(u).toBeGreaterThan(0);
      expect(u).toBeLessThan(1);
    }
  });

  it("derives a distinct state per seed, step and decision index", () => {
    const states = new Set([
      deriveDecisionState("s", "step", 0),
      deriveDecisionState("s", "step", 1),
      deriveDecisionState("s", "other", 0),
      deriveDecisionState("t", "step", 0),
    ]);
    expect(states.size).toBe(4);
    expect(deriveDecisionState("s", "step", 3)).toBe(deriveDecisionState("s", "step", 3));
  });
});

describe("gamma and beta sampling", () => {
  const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

  it("matches the Beta mean for shapes above and below 1", () => {
    const rng = createSeededRng(99);
    for (const [alpha, beta] of [[1, 1], [2, 5], [0.5, 0.5], [0.3, 3], [40, 10]]) {
      const draws = Array.from({ length: 20_000 }, () => sampleBeta(rng, alpha, beta));
      expect(draws.every((draw) => draw > 0 && draw < 1)).toBe(true);
      expect(mean(draws)).toBeCloseTo(alpha / (alpha + beta), 1);
    }
  });

  it("matches the Gamma mean", () => {
    const rng = createSeededRng(5);
    for (const shape of [0.4, 1, 3.5]) {
      expect(mean(Array.from({ length: 20_000 }, () => sampleGamma(rng, shape)))).toBeCloseTo(shape, 1);
    }
  });

  it("rejects a non-positive or non-finite shape", () => {
    const rng = createSeededRng(1);
    for (const bad of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) expect(() => sampleGamma(rng, bad)).toThrow(RangeError);
  });
});
