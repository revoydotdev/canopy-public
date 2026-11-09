/**
 * arbor-eval/stage0/stats — the preregistered statistics, as pure functions.
 *
 * - `wilsonInterval`: per-arm binomial interval over units. It treats units as
 *   independent, which seeds of one task are not, so it is reported beside the
 *   task-clustered bootstrap and never used for a verdict.
 * - `clusterBootstrap`: percentile bootstrap that resamples TASKS with
 *   replacement (the seeds of a task travel together). The verdict statistic.
 * - `median`, `quantile`: order statistics with linear interpolation.
 *
 * Every random draw comes from `@arbor/core`'s seeded generator, so a report
 * recomputed from the same ledger is identical.
 */
import { createSeededRng, hashSeed } from "@arbor/core";

export interface Interval {
  readonly estimate: number;
  readonly lower: number;
  readonly upper: number;
}

/** Wilson score interval for k successes in n trials (z = 1.96 for 95%). */
export function wilsonInterval(successes: number, trials: number, z = 1.959963984540054): Interval {
  if (!Number.isInteger(successes) || !Number.isInteger(trials) || trials < 0 || successes < 0 || successes > trials) {
    throw new RangeError(`wilsonInterval needs 0 <= successes <= trials, got ${successes}/${trials}`);
  }
  if (trials === 0) return { estimate: Number.NaN, lower: 0, upper: 1 };
  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const centre = (p + z2 / (2 * trials)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denominator;
  return { estimate: p, lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) };
}

/** Linear-interpolation quantile (type 7) of an unsorted sample. */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  if (!(q >= 0 && q <= 1)) throw new RangeError(`quantile q must be in [0, 1], got ${q}`);
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const below = Math.floor(position);
  const above = Math.ceil(position);
  return sorted[below] + (sorted[above] - sorted[below]) * (position - below);
}

export function median(values: readonly number[]): number {
  return quantile(values, 0.5);
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * One cluster (task) of paired observations. Each array holds one value per
 * unit of that cluster; a statistic reads whatever arrays it needs.
 */
export type Cluster = Readonly<Record<string, readonly number[]>>;

/**
 * A statistic over a multiset of clusters. Returning NaN marks a resample on
 * which the statistic is undefined (e.g. a ratio with a zero denominator);
 * such resamples are counted and excluded from the percentile interval.
 */
export type ClusterStatistic = (clusters: readonly Cluster[]) => number;

export interface BootstrapResult extends Interval {
  readonly resamples: number;
  readonly undefined_resamples: number;
  readonly seed: string;
}

/** Percentile bootstrap over clusters (95% by default). Deterministic in `seed`. */
export function clusterBootstrap(
  clusters: readonly Cluster[],
  statistic: ClusterStatistic,
  resamples: number,
  seed: string,
  level = 0.95,
): BootstrapResult {
  if (!Number.isInteger(resamples) || resamples < 1) throw new RangeError(`resamples must be a positive integer, got ${resamples}`);
  const estimate = statistic(clusters);
  if (clusters.length === 0) return { estimate, lower: Number.NaN, upper: Number.NaN, resamples, undefined_resamples: resamples, seed };
  const rng = createSeededRng(hashSeed(seed));
  const draws: number[] = [];
  let undefinedResamples = 0;
  const sample: Cluster[] = new Array(clusters.length);
  for (let r = 0; r < resamples; r++) {
    for (let i = 0; i < clusters.length; i++) sample[i] = clusters[rng.nextUint32() % clusters.length];
    const value = statistic(sample);
    if (Number.isFinite(value)) draws.push(value);
    else undefinedResamples++;
  }
  const alpha = (1 - level) / 2;
  return {
    estimate,
    lower: draws.length === 0 ? Number.NaN : quantile(draws, alpha),
    upper: draws.length === 0 ? Number.NaN : quantile(draws, 1 - alpha),
    resamples,
    undefined_resamples: undefinedResamples,
    seed,
  };
}

/** Mean over all units of one key (clusters weighted by their unit count). */
export function pooledMean(key: string): ClusterStatistic {
  return (clusters) => {
    let sum = 0;
    let count = 0;
    for (const cluster of clusters) {
      for (const value of cluster[key] ?? []) {
        sum += value;
        count++;
      }
    }
    return count === 0 ? Number.NaN : sum / count;
  };
}

/** Pooled mean of `a` minus pooled mean of `b`, units paired within each cluster. */
export function pooledMeanDifference(a: string, b: string): ClusterStatistic {
  const left = pooledMean(a);
  const right = pooledMean(b);
  return (clusters) => left(clusters) - right(clusters);
}

/** Σ numerator / Σ denominator over all units (e.g. USD per verified result). NaN when Σ denominator is 0. */
export function pooledRatio(numerator: string, denominator: string): ClusterStatistic {
  return (clusters) => {
    let top = 0;
    let bottom = 0;
    for (const cluster of clusters) {
      for (const value of cluster[numerator] ?? []) top += value;
      for (const value of cluster[denominator] ?? []) bottom += value;
    }
    return bottom === 0 ? Number.NaN : top / bottom;
  };
}
