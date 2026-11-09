import { describe, expect, it } from "vitest";
import { clusterBootstrap, median, pooledMean, pooledMeanDifference, pooledRatio, quantile, wilsonInterval } from "../src/stage0/stats.js";

describe("Stage 0 statistics", () => {
  it("wilsonInterval matches the textbook value and stays inside [0, 1]", () => {
    const interval = wilsonInterval(8, 10);
    expect(interval.estimate).toBe(0.8);
    expect(interval.lower).toBeCloseTo(0.4902, 3);
    expect(interval.upper).toBeCloseTo(0.9433, 3);
    expect(wilsonInterval(0, 5).lower).toBe(0);
    expect(wilsonInterval(5, 5).upper).toBe(1);
    expect(() => wilsonInterval(3, 2)).toThrow(RangeError);
  });

  it("quantile interpolates linearly and median handles even counts", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(quantile([0, 10], 0.9)).toBe(9);
    expect(Number.isNaN(median([]))).toBe(true);
  });

  it("pooled statistics pair units within clusters", () => {
    const clusters = [{ a: [1, 1], b: [0, 1], cost: [2, 2] }, { a: [0], b: [0], cost: [5] }];
    expect(pooledMean("a")(clusters)).toBeCloseTo(2 / 3, 10);
    expect(pooledMeanDifference("a", "b")(clusters)).toBeCloseTo(1 / 3, 10);
    expect(pooledRatio("cost", "a")(clusters)).toBeCloseTo(9 / 2, 10);
    expect(Number.isNaN(pooledRatio("cost", "b")([{ cost: [1], b: [0] }]))).toBe(true);
  });

  it("clusterBootstrap is deterministic in its seed and brackets the estimate", () => {
    const clusters = Array.from({ length: 30 }, (_, i) => ({ a: [i % 3 === 0 ? 0 : 1, 1], b: [0, i % 2] }));
    const first = clusterBootstrap(clusters, pooledMeanDifference("a", "b"), 2000, "seed-1");
    const again = clusterBootstrap(clusters, pooledMeanDifference("a", "b"), 2000, "seed-1");
    const other = clusterBootstrap(clusters, pooledMeanDifference("a", "b"), 2000, "seed-2");
    expect(again).toEqual(first);
    // On a continuous statistic a different seed moves the percentile endpoints.
    const continuous = Array.from({ length: 30 }, (_, i) => ({ a: [(i * 0.37) % 1], b: [0] }));
    const c1 = clusterBootstrap(continuous, pooledMeanDifference("a", "b"), 2000, "seed-1");
    const c2 = clusterBootstrap(continuous, pooledMeanDifference("a", "b"), 2000, "seed-2");
    expect(c2.lower).not.toBe(c1.lower);
    expect(other.estimate).toBe(first.estimate);
    expect(first.lower).toBeLessThanOrEqual(first.estimate);
    expect(first.upper).toBeGreaterThanOrEqual(first.estimate);
    expect(first.lower).toBeGreaterThan(0);
  });

  it("a constant difference has a degenerate interval at that difference", () => {
    const clusters = Array.from({ length: 10 }, () => ({ a: [1], b: [0] }));
    const result = clusterBootstrap(clusters, pooledMeanDifference("a", "b"), 500, "s");
    expect(result.lower).toBe(1);
    expect(result.upper).toBe(1);
  });

  it("counts resamples on which a ratio is undefined instead of hiding them", () => {
    const clusters = [{ cost: [1], ok: [0] }, { cost: [1], ok: [1] }];
    const result = clusterBootstrap(clusters, pooledRatio("cost", "ok"), 400, "r");
    expect(result.undefined_resamples).toBeGreaterThan(0);
    expect(result.undefined_resamples).toBeLessThan(400);
  });
});
