/**
 * Opt-in, bounded runtime cost observations. The probe groups only by a fixed
 * operation vocabulary; it never retains event, campaign, node, or path IDs.
 * Quantiles are bucket upper bounds, not exact latency claims.
 */
export const RUNTIME_COST_BUCKETS_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 5_000] as const;

const RUNTIME_COST_OPERATIONS = [
  "runtime_startup", "runtime_event_publish", "runtime_event_fold", "campaign_status_projection", "supervisor_persistence",
] as const;

export type RuntimeCostOperation =
  | "runtime_startup"
  | "runtime_event_publish"
  | "runtime_event_fold"
  | "campaign_status_projection"
  | "supervisor_persistence";

export interface RuntimeCostObservation {
  readonly operation: RuntimeCostOperation;
  readonly duration_ms: number;
}

export interface RuntimeCostSummary {
  readonly operation: RuntimeCostOperation;
  readonly count: number;
  readonly total_ms: number;
  readonly max_ms: number;
  readonly p50_upper_bound_ms: number | null;
  readonly p95_upper_bound_ms: number | null;
}

type MutableSummary = { count: number; total_ms: number; max_ms: number; buckets: number[] };

/** Fixed-memory collector intended for explicit local measurement sessions. */
export class RuntimePerformanceProbe {
  private readonly summaries = new Map<RuntimeCostOperation, MutableSummary>();

  observe(observation: RuntimeCostObservation): void {
    if (!RUNTIME_COST_OPERATIONS.includes(observation.operation) || !Number.isFinite(observation.duration_ms) || observation.duration_ms < 0) return;
    const row = this.summaries.get(observation.operation) ?? {
      count: 0, total_ms: 0, max_ms: 0, buckets: Array(RUNTIME_COST_BUCKETS_MS.length + 1).fill(0) as number[],
    };
    row.count += 1;
    row.total_ms += observation.duration_ms;
    row.max_ms = Math.max(row.max_ms, observation.duration_ms);
    const index = RUNTIME_COST_BUCKETS_MS.findIndex((bound) => observation.duration_ms <= bound);
    row.buckets[index < 0 ? RUNTIME_COST_BUCKETS_MS.length : index] += 1;
    this.summaries.set(observation.operation, row);
  }

  snapshot(): readonly RuntimeCostSummary[] {
    return Object.freeze([...this.summaries.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([operation, row]) => Object.freeze({
      operation,
      count: row.count,
      total_ms: row.total_ms,
      max_ms: row.max_ms,
      p50_upper_bound_ms: quantileUpperBound(row.buckets, row.count, 0.5),
      p95_upper_bound_ms: quantileUpperBound(row.buckets, row.count, 0.95),
    })));
  }
}

function quantileUpperBound(buckets: readonly number[], count: number, quantile: number): number | null {
  if (count === 0) return null;
  const target = Math.ceil(count * quantile);
  let seen = 0;
  for (let index = 0; index < buckets.length; index += 1) {
    seen += buckets[index] ?? 0;
    if (seen >= target) return RUNTIME_COST_BUCKETS_MS[index] ?? null;
  }
  return null; // overflow bucket has no finite upper bound.
}
