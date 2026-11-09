/**
 * arbor-opencode/race-threshold -- learned fork threshold (ADR-069, X-1).
 *
 * `race.ts`'s `DEFAULT_RACE_FORK_MS` (25000ms) was a single guess from bench
 * v4's wall-time decomposition. By cycle-4 the persistence directory's audit
 * ledgers hold real history of how long specialist dispatch actually takes,
 * so this module derives a threshold from that history instead of the fixed
 * guess -- falling back to the existing `resolveForkThresholdMs(env)` path
 * unchanged whenever the history is too thin or absent.
 *
 * HONESTY NOTE on the statistic actually computed (see ADR-069): the ledger
 * schema has no per-campaign/per-node task-category field anywhere (verified
 * by inspecting every observation kind emitted across ~56 real bench
 * ledgers under qa-bench/{ab,ab2,ab3,fastify} -- `telemetry_observation`,
 * `gate_checkpoint`, and every `observation.type` therein carry
 * `campaign_id`/`node_id`/`operation_id`/`epoch`, never a task-class or
 * category label). Per-task-CLASS matching as the manifest's ideal is
 * therefore not implementable against what the ledgers actually contain;
 * `taskCategory` is accepted (additive, forward-compatible signature) but
 * is NOT used to filter observations -- every call computes a single GLOBAL
 * p50 across all reachable campaigns' ledgers. This is a deliberate,
 * documented deviation from the manifest's per-class ideal, not a silent
 * simplification.
 *
 * The statistic itself: the ledgers also carry no direct "specialist wall"
 * duration -- `phase_timing` only times `select`/`expand`/`backprop`/
 * `critic` (`expand`'s own `duration_ms` is bookkeeping only, 7-45ms across
 * every sample inspected; the actual specialist dispatch happens *between*
 * that `expand` phase_timing event and the specialist's own `usage_cost`
 * event, which is emitted immediately once the specialist call returns).
 * So the computed statistic is:
 *
 *   specialist_wall_ms = timestamp(usage_cost, operation_id ends ":specialist")
 *                        - timestamp(phase_timing, phase == "expand")
 *
 * for the same `(campaign_id, node_id, epoch)`, which brackets exactly the
 * specialist's real generation call (verified against real ledgers: e.g.
 * expand @ ...:35.964Z, specialist usage_cost @ ...:20:04.866Z => ~28.9s,
 * corroborated by that same node's critic phase_timing start time). This is
 * the simplest honest signal available in the current schema; it is named
 * here and in ADR-069 rather than silently substituted for the manifest's
 * "specialist phase_timing wall" framing, which does not exist as emitted.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_RACE_FORK_MS,
  MAX_RACE_FORK_MS,
  MIN_RACE_FORK_MS,
  RACE_FORK_MS_ENV,
  resolveForkThresholdMs,
} from "./race.js";

/** Newest-N ledger files considered, by mtime -- bounds the scan on a large persistence dir. */
export const RACE_THRESHOLD_MAX_LEDGER_FILES = 50;

/** Minimum observation count required before a learned threshold is trusted over the fallback. */
export const RACE_THRESHOLD_MIN_OBSERVATIONS = 5;

export type RaceThresholdSource = "learned" | "env" | "default";

export interface LearnedForkThreshold {
  readonly thresholdMs: number;
  readonly source: RaceThresholdSource;
  readonly observations: number;
}

interface NodeTimingAccumulator {
  expandAtMs: number | null;
  specialistUsageAtMs: number | null;
}

/** Parses one ledger line, extracting only what this module needs. Never throws -- malformed lines are simply not a match. */
function extractDelta(
  line: string,
  acc: Map<string, NodeTimingAccumulator>,
): void {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof record !== "object" || record === null) return;
  const rec = record as Record<string, unknown>;
  if (rec.kind !== "telemetry_observation") return;
  const campaignId = rec.campaign_id;
  const nodeId = rec.node_id;
  const observation = rec.observation;
  if (typeof campaignId !== "string" || typeof nodeId !== "string") return;
  if (typeof observation !== "object" || observation === null) return;
  const obs = observation as Record<string, unknown>;
  const epoch = obs.epoch;
  const timestamp = rec.timestamp;
  if (typeof timestamp !== "string") return;
  const parsedMs = Date.parse(timestamp);
  if (!Number.isFinite(parsedMs)) return;
  const key = `${campaignId}:${nodeId}:${typeof epoch === "number" ? epoch : "?"}`;

  if (obs.type === "phase_timing" && obs.phase === "expand") {
    const existing = acc.get(key) ?? { expandAtMs: null, specialistUsageAtMs: null };
    if (existing.expandAtMs === null) existing.expandAtMs = parsedMs;
    acc.set(key, existing);
    return;
  }
  if (obs.type === "usage_cost" && typeof obs.operation_id === "string" && obs.operation_id.endsWith(":specialist")) {
    const existing = acc.get(key) ?? { expandAtMs: null, specialistUsageAtMs: null };
    if (existing.specialistUsageAtMs === null) existing.specialistUsageAtMs = parsedMs;
    acc.set(key, existing);
  }
}

/**
 * Scans up to `RACE_THRESHOLD_MAX_LEDGER_FILES` newest-by-mtime `*.jsonl`
 * files under `<persistenceDir>/audit`, extracting one specialist-wall
 * delta per `(campaign_id, node_id, epoch)` that has both an `expand`
 * `phase_timing` event and a `:specialist`-suffixed `usage_cost` event.
 * Never throws: a missing/unreadable audit dir, or any individually
 * unreadable/malformed file, degrades to fewer (possibly zero)
 * observations rather than propagating an error.
 */
export function collectSpecialistWallObservations(persistenceDir: string): readonly number[] {
  const auditDir = join(persistenceDir, "audit");
  let entries: string[];
  try {
    entries = readdirSync(auditDir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const withMtime = entries
    .map((name) => {
      try {
        return { name, mtimeMs: statSync(join(auditDir, name)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { name: string; mtimeMs: number } => entry !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, RACE_THRESHOLD_MAX_LEDGER_FILES);

  const acc = new Map<string, NodeTimingAccumulator>();
  for (const { name } of withMtime) {
    let content: string;
    try {
      content = readFileSync(join(auditDir, name), "utf-8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      extractDelta(trimmed, acc);
    }
  }

  const deltas: number[] = [];
  for (const timing of acc.values()) {
    if (timing.expandAtMs === null || timing.specialistUsageAtMs === null) continue;
    const delta = timing.specialistUsageAtMs - timing.expandAtMs;
    if (delta > 0) deltas.push(delta);
  }
  return deltas;
}

/** Simple sort-based p50 (sufficient at this scale -- no streaming estimator, per the manifest's explicit deferral). */
export function p50(values: readonly number[]): number {
  if (values.length === 0) throw new Error("p50 requires at least one value");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  // Rounded: the threshold feeds a ledger observation whose validator
  // requires an integer count — bench v6 measured every even-sample p50
  // (a fractional midpoint average) being silently refused at journaling.
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

/**
 * Learned per-task-class fork threshold, per ADR-069/X-1. `taskCategory` is
 * accepted for forward compatibility with the manifest's stated ideal but is
 * NOT used to filter observations -- see this module's header for why
 * (no category field exists in the ledger schema this cycle). An env
 * override (`ARBOR_RACE_FORK_MS`) always wins over any learned value.
 * Fewer than `RACE_THRESHOLD_MIN_OBSERVATIONS` real deltas falls back to
 * `resolveForkThresholdMs(env)` (source `"default"`) unchanged.
 */
export function resolveLearnedForkThresholdMs(
  persistenceDir: string,
  taskCategory: string | null | undefined,
  env: Readonly<Record<string, string | undefined>>,
): LearnedForkThreshold {
  void taskCategory; // see module header: not used to filter this cycle -- ledger schema has no category field.
  const envRaw = env[RACE_FORK_MS_ENV];
  if (envRaw !== undefined && envRaw.trim() !== "") {
    return { thresholdMs: resolveForkThresholdMs(env), source: "env", observations: 0 };
  }

  const observations = collectSpecialistWallObservations(persistenceDir);
  if (observations.length < RACE_THRESHOLD_MIN_OBSERVATIONS) {
    return { thresholdMs: resolveForkThresholdMs(env), source: "default", observations: observations.length };
  }

  const learned = p50(observations);
  const clamped = Math.min(MAX_RACE_FORK_MS, Math.max(MIN_RACE_FORK_MS, learned));
  return { thresholdMs: clamped, source: "learned", observations: observations.length };
}

export { DEFAULT_RACE_FORK_MS, MIN_RACE_FORK_MS, MAX_RACE_FORK_MS };
