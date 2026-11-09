/**
 * arbor-eval/stage0/scheduler — run (task, seed) units wave by wave.
 *
 * Units run in the preregistered order. Each unit executes K-wide waves
 * (`nextWaveToRun`) until every arm at every budget level can be derived.
 * Up to `unit_concurrency` units run at once, so at most
 * `unit_concurrency × k` attempts are in flight.
 *
 * Fallback (preregistered): once the wall-clock deadline or the USD ceiling
 * is reached, no new unit starts; units already started finish. The ledger is
 * resumable: an attempt already in it is never re-run.
 *
 * With a `guard` (`guard.ts`), every attempt is admitted individually against
 * the run's hard caps, at most `max_in_flight` attempts run at once, and a
 * guard stop ends the run: a unit whose wave was cut short is left
 * incomplete and no further unit starts.
 */
import { nextWaveToRun } from "./arms.js";
import { attemptKey, semaphore } from "./guard.js";
import type { Stage0RunGuard, Stage0StopReason } from "./guard.js";
import type { Stage0AttemptRecord, Stage0Experiment, Stage0LedgerEntry, Stage0WaveRecord } from "./types.js";
import { STAGE0_WAVE_SCHEMA } from "./types.js";

export interface Stage0Unit {
  readonly task_id: string;
  readonly seed: number;
}

export interface SchedulerOptions {
  readonly experiment: Stage0Experiment;
  readonly units: readonly Stage0Unit[];
  readonly k: number;
  readonly max_budget: number;
  readonly usd_unit: number;
  readonly unit_concurrency: number;
  /** Epoch ms after which no new unit starts. */
  readonly deadline_ms: number;
  /** Provider-measured USD after which no new unit starts. */
  readonly usd_ceiling: number;
  /** Attempts already in the ledger (resume). */
  readonly existing: readonly Stage0AttemptRecord[];
  readonly runAttempt: (unit: Stage0Unit, attemptIndex: number, wave: number, signal?: AbortSignal) => Promise<Stage0AttemptRecord>;
  /** Hard caps and the provider-fatal stop. */
  readonly guard?: Stage0RunGuard;
  /** Attempts in flight at once across all units (default: unbounded). */
  readonly max_in_flight?: number;
  readonly append: (entry: Stage0LedgerEntry) => void;
  readonly event: (event: string, detail: Record<string, unknown>) => void;
  readonly now?: () => number;
}

export interface SchedulerResult {
  readonly completed_units: number;
  readonly skipped_units: number;
  readonly attempts_run: number;
  readonly spent_usd: number;
  readonly stop_reason: "all_units" | "deadline" | "usd_ceiling" | Stage0StopReason;
  readonly stop_detail?: string;
  /** Units started but left incomplete by a guard stop. */
  readonly incomplete_units?: number;
}

export async function runUnits(options: SchedulerOptions): Promise<SchedulerResult> {
  const now = options.now ?? Date.now;
  const byUnit = new Map<string, Stage0AttemptRecord[]>();
  const key = (unit: Stage0Unit) => `${unit.task_id}#${unit.seed}`;
  let spent = 0;
  for (const attempt of options.existing) {
    const list = byUnit.get(key(attempt)) ?? [];
    list.push(attempt);
    byUnit.set(key(attempt), list);
    spent += attempt.cost_usd;
  }
  let next = 0;
  let completed = 0;
  let attemptsRun = 0;
  let stopReason: SchedulerResult["stop_reason"] = "all_units";
  let incomplete = 0;
  const guard = options.guard;
  const limit = semaphore(Math.max(1, options.max_in_flight ?? Number.POSITIVE_INFINITY));

  const dispatch = (unit: Stage0Unit, index: number, waveNumber: number): Promise<Stage0AttemptRecord | null> => limit(async () => {
    if (guard === undefined) return options.runAttempt(unit, index, waveNumber);
    const guardKey = attemptKey(unit, index);
    if (!guard.admit(guardKey)) return null;
    const record = await options.runAttempt(unit, index, waveNumber, guard.signal);
    guard.finish({ key: guardKey, cost_usd: record.cost_usd, provider_errors: record.provider_errors ?? [], connector_ids: record.connector_ids ?? [], campaign_id: record.campaign_id });
    return record;
  });

  const runUnit = async (unit: Stage0Unit): Promise<void> => {
    const attempts = byUnit.get(key(unit)) ?? [];
    byUnit.set(key(unit), attempts);
    for (;;) {
      const wave = nextWaveToRun(attempts, unit.task_id, unit.seed, options.max_budget, options.usd_unit, options.k);
      if (wave.length === 0) break;
      if (guard?.stopped != null) {
        incomplete++;
        options.event("unit_incomplete", { task_id: unit.task_id, seed: unit.seed, attempts: attempts.length, stop_reason: guard.stopped.reason });
        return;
      }
      const waveNumber = Math.floor(wave[0] / Math.min(options.k, options.max_budget));
      const startedAt = new Date(now());
      const results = await Promise.all(wave.map((index) => dispatch(unit, index, waveNumber)));
      const landed = results.filter((attempt): attempt is Stage0AttemptRecord => attempt !== null);
      const finishedAt = new Date(now());
      for (const attempt of landed) {
        options.append(attempt);
        attempts.push(attempt);
        spent += attempt.cost_usd;
        attemptsRun++;
      }
      const record: Stage0WaveRecord = {
        schema: STAGE0_WAVE_SCHEMA,
        experiment: options.experiment,
        task_id: unit.task_id,
        seed: unit.seed,
        wave: waveNumber,
        attempt_indices: landed.map((attempt) => attempt.attempt_index),
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        wall_ms: finishedAt.getTime() - startedAt.getTime(),
      };
      if (landed.length > 0) options.append(record);
    }
    completed++;
    options.event("unit_complete", { task_id: unit.task_id, seed: unit.seed, attempts: attempts.length, spent_usd: Number(spent.toFixed(6)) });
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (next >= options.units.length) return;
      if (guard?.stopped != null) return;
      if (now() >= options.deadline_ms) {
        stopReason = "deadline";
        return;
      }
      if (spent >= options.usd_ceiling) {
        stopReason = "usd_ceiling";
        return;
      }
      const unit = options.units[next++];
      await runUnit(unit);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.unit_concurrency) }, () => worker()));
  const stopped = guard?.stopped ?? null;
  return {
    completed_units: completed,
    skipped_units: options.units.length - next,
    attempts_run: attemptsRun,
    spent_usd: spent,
    stop_reason: stopped?.reason ?? stopReason,
    ...(stopped === null ? {} : { stop_detail: stopped.detail, incomplete_units: incomplete }),
  };
}

/**
 * The preregistered unit order: seed-major (every task at seed 0 before any
 * task at seed 1), tasks interleaved by member in their preregistered order,
 * so any completed prefix covers all three languages and as many tasks as
 * possible before adding seeds.
 */
export function preregisteredUnitOrder(taskIdsByMember: readonly (readonly string[])[], seeds: readonly number[]): Stage0Unit[] {
  const interleaved: string[] = [];
  const longest = Math.max(0, ...taskIdsByMember.map((ids) => ids.length));
  for (let i = 0; i < longest; i++) for (const ids of taskIdsByMember) if (i < ids.length) interleaved.push(ids[i]);
  return seeds.flatMap((seed) => interleaved.map((task_id) => ({ task_id, seed })));
}
