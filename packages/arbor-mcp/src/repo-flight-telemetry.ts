/**
 * Repository-local Flight execution telemetry.
 *
 * This is deliberately an append-only, closed-schema journal rather than a
 * general logging facility.  Flight telemetry is operational evidence: it
 * records bounded measurements and opaque digests only, never command output,
 * environment values, credentials, prompts, or provider payloads.
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireWriterLock, type WriterLockHandle } from "@arbor/core";

export const REPO_FLIGHT_TELEMETRY_SCHEMA_VERSION = 1 as const;
export const REPO_FLIGHT_RESOURCE_CLASSES = ["small", "standard", "large", "exclusive"] as const;
export type RepoFlightResourceClass = (typeof REPO_FLIGHT_RESOURCE_CLASSES)[number];

export const REPO_FLIGHT_TELEMETRY_STAGES = [
  "admission", "workspace", "session", "execution", "validation", "coverage", "evidence", "final_audit",
] as const;
export type RepoFlightTelemetryStage = (typeof REPO_FLIGHT_TELEMETRY_STAGES)[number];

export interface RepoFlightStageTelemetry {
  /** Time between durable queue admission and a Flight-owned dispatch. */
  readonly queue_ms: number;
  /** Monotonic wall time measured by the Flight-owned supervisor. */
  readonly wall_ms: number;
  /** Process CPU time measured by the Flight-owned supervisor. */
  readonly cpu_ms: number | "unavailable";
  /** Maximum resident set size observed during the stage. */
  readonly peak_rss_bytes: number | "unavailable";
  /** Cumulative bytes read and written by the supervised stage. */
  readonly io_read_bytes: number | "unavailable";
  readonly io_write_bytes: number | "unavailable";
  readonly cache_hits: number;
  readonly cache_misses: number;
}

/** A bounded dependency summary; dependency names and paths are never stored. */
export interface RepoFlightDependencySummary {
  readonly dependency_count: number;
  readonly blocked_dependency_count: number;
  readonly critical_path_ms: number;
  /** Opaque digest of the ordered, authorized dependency edge set. */
  readonly critical_path_digest: `sha256:${string}`;
}

export interface RepoFlightTelemetryObservation {
  readonly schema_version: typeof REPO_FLIGHT_TELEMETRY_SCHEMA_VERSION;
  readonly kind: "revoy2.repo_flight.stage_telemetry";
  readonly observation_id: string;
  readonly repo_run_id: string;
  readonly stage: RepoFlightTelemetryStage;
  readonly resource_class: RepoFlightResourceClass;
  readonly observed_at: string;
  readonly measurements: RepoFlightStageTelemetry;
  readonly dependencies: RepoFlightDependencySummary;
}

type StoredEvent = RepoFlightTelemetryObservation & {
  readonly sequence: number;
  readonly previous_hash: `sha256:${string}` | null;
  readonly event_hash: `sha256:${string}`;
};

export interface RepoFlightTelemetrySummary {
  readonly repo_run_id: string;
  readonly observation_count: number;
  readonly stages: readonly RepoFlightTelemetryStage[];
  readonly queue_ms: number;
  readonly wall_ms: number;
  readonly cpu_ms: number | "unavailable";
  readonly peak_rss_bytes: number | "unavailable";
  readonly io_read_bytes: number | "unavailable";
  readonly io_write_bytes: number | "unavailable";
  readonly cache_hits: number;
  readonly cache_misses: number;
  readonly critical_path_ms: number;
  readonly critical_path_digest: `sha256:${string}` | null;
}

type RepoFlightTelemetryTotals = Pick<RepoFlightTelemetrySummary, "queue_ms" | "wall_ms" | "cpu_ms" | "peak_rss_bytes" | "io_read_bytes" | "io_write_bytes" | "cache_hits" | "cache_misses">;

export type RepoFlightTelemetryResult =
  | { readonly ok: true; readonly observation: RepoFlightTelemetryObservation; readonly replayed: boolean }
  | { readonly ok: false; readonly code: "invalid" | "conflict" | "corrupt_store" | "write_failed" | "closed"; readonly reason: string };

export interface RepoFlightTelemetryOptions {
  readonly persistence_dir: string;
  readonly max_observations?: number;
}

export type RepoFlightPerformanceLane = "ordinary_changed_scope" | "warm_exact_candidate" | "uncached_full_audit";
export interface RepoFlightPerformanceCohortRun {
  readonly cohort_identity_digest: `sha256:${string}`;
  readonly wall_ms: number;
  readonly host_telemetry_available: boolean;
  readonly semantic_agreement: boolean;
  readonly coverage_agreement: boolean;
  readonly attestation_agreement: boolean;
  readonly false_cache_hit: boolean;
  readonly crash_evidence_complete: boolean;
}
export interface RepoFlightPerformancePromotionResult {
  readonly eligible: boolean;
  readonly lane: RepoFlightPerformanceLane;
  readonly baseline_p95_ms: number | null;
  readonly shadow_p95_ms: number | null;
  readonly reduction_percent: number | null;
  readonly findings: readonly string[];
}

const MAX_TEXT_BYTES = 512;
const MAX_OBSERVATIONS = 100_000;
const MAX_DURATION_MS = 31_536_000_000;
const MAX_BYTES = Number.MAX_SAFE_INTEGER;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

/**
 * Durable Flight-owned stage measurements.  A replay failure renders the
 * journal read-only: missing or altered telemetry may not be silently
 * replaced with a new history after restart.
 */
export class RepoFlightTelemetryStore {
  private readonly path: string;
  private readonly lock: WriterLockHandle;
  private readonly maxObservations: number;
  private readonly events: StoredEvent[] = [];
  private readonly observations = new Map<string, StoredEvent>();
  private corrupt = false;
  private closed = false;

  constructor(options: RepoFlightTelemetryOptions) {
    if (!validText(options.persistence_dir, MAX_TEXT_BYTES * 8)) throw new Error("repo-flight telemetry persistence directory is invalid");
    this.maxObservations = options.max_observations ?? 20_000;
    if (!Number.isSafeInteger(this.maxObservations) || this.maxObservations < 1 || this.maxObservations > MAX_OBSERVATIONS) throw new Error("repo-flight telemetry observation bound is invalid");
    mkdirSync(options.persistence_dir, { recursive: true, mode: 0o700 });
    const acquired = acquireWriterLock(options.persistence_dir, { holder: "repo-flight-telemetry" });
    if (!acquired.ok) throw new Error(acquired.detail);
    this.lock = acquired.lock;
    this.path = join(options.persistence_dir, "repo-flight-telemetry.jsonl");
    try { this.restore(); } catch (error) { this.lock.release(); throw error; }
  }

  close(): void { if (!this.closed) { this.closed = true; this.lock.release(); } }
  isAppendable(): boolean { return !this.closed && !this.corrupt; }

  record(value: unknown): RepoFlightTelemetryResult {
    if (this.closed) return failure("closed", "repo-flight telemetry store is closed");
    if (this.corrupt) return failure("corrupt_store", "repo-flight telemetry journal failed replay validation and is read-only");
    if (!validObservation(value)) return failure("invalid", "telemetry observation does not satisfy the closed bounded schema");
    const observation = freeze(structuredClone(value));
    const prior = this.observations.get(observation.observation_id);
    if (prior !== undefined) {
      const { sequence: _sequence, previous_hash: _previous, event_hash: _hash, ...priorObservation } = prior;
      return stableJson(priorObservation) === stableJson(observation)
        ? { ok: true, observation: freeze(structuredClone(priorObservation)), replayed: true }
        : failure("conflict", "telemetry observation id was reused with different content");
    }
    if (this.events.length >= this.maxObservations) return failure("write_failed", "repo-flight telemetry capacity is exhausted; archive the durable journal explicitly");
    const unsigned = freeze({ ...observation, sequence: this.events.length + 1, previous_hash: this.events.at(-1)?.event_hash ?? null });
    const event = freeze({ ...unsigned, event_hash: digest(unsigned) });
    if (!this.append(event)) return failure("write_failed", "telemetry observation could not be durably appended");
    this.events.push(event); this.observations.set(event.observation_id, event);
    return { ok: true, observation: freeze(structuredClone(observation)), replayed: false };
  }

  list(repoRunId?: string, limit = 200): readonly RepoFlightTelemetryObservation[] {
    if (this.closed) return [];
    const bounded = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 2_000) : 200;
    return this.events.filter((event) => repoRunId === undefined || event.repo_run_id === repoRunId).slice(-bounded)
      .map(({ sequence: _sequence, previous_hash: _previous, event_hash: _hash, ...observation }) => freeze(structuredClone(observation)));
  }

  summarize(repoRunId: string): RepoFlightTelemetrySummary | null {
    if (!validId(repoRunId)) throw new Error("repo-flight telemetry repo_run_id is invalid");
    const matching = this.events.filter((event) => event.repo_run_id === repoRunId);
    if (matching.length === 0) return null;
    const sums = matching.reduce<RepoFlightTelemetryTotals>((total, event) => ({
      queue_ms: total.queue_ms + event.measurements.queue_ms,
      wall_ms: total.wall_ms + event.measurements.wall_ms,
      cpu_ms: addAvailable(total.cpu_ms, event.measurements.cpu_ms),
      peak_rss_bytes: maxAvailable(total.peak_rss_bytes, event.measurements.peak_rss_bytes),
      io_read_bytes: addAvailable(total.io_read_bytes, event.measurements.io_read_bytes),
      io_write_bytes: addAvailable(total.io_write_bytes, event.measurements.io_write_bytes),
      cache_hits: total.cache_hits + event.measurements.cache_hits,
      cache_misses: total.cache_misses + event.measurements.cache_misses,
    }), { queue_ms: 0, wall_ms: 0, cpu_ms: "unavailable" as const, peak_rss_bytes: "unavailable" as const, io_read_bytes: "unavailable" as const, io_write_bytes: "unavailable" as const, cache_hits: 0, cache_misses: 0 });
    const critical = matching.reduce((best, event) => event.dependencies.critical_path_ms > best.dependencies.critical_path_ms ? event : best);
    return freeze({ repo_run_id: repoRunId, observation_count: matching.length, stages: freeze([...new Set(matching.map((event) => event.stage))]), ...sums,
      critical_path_ms: critical.dependencies.critical_path_ms, critical_path_digest: critical.dependencies.critical_path_digest });
  }

  private restore(): void {
    if (!existsSync(this.path)) return;
    try {
      const lines = readFileSync(this.path, "utf8").split("\n"); if (lines.at(-1) === "") lines.pop();
      if (lines.length > this.maxObservations) throw new Error("telemetry journal exceeds configured capacity");
      for (const line of lines) {
        const parsed: unknown = JSON.parse(line);
        if (!validStoredEvent(parsed) || parsed.sequence !== this.events.length + 1 || parsed.previous_hash !== (this.events.at(-1)?.event_hash ?? null)) throw new Error("telemetry journal event is invalid");
        const { event_hash, ...unsigned } = parsed;
        if (digest(unsigned) !== event_hash || this.observations.has(parsed.observation_id)) throw new Error("telemetry journal hash chain is invalid");
        this.events.push(freeze(parsed)); this.observations.set(parsed.observation_id, freeze(parsed));
      }
    } catch { this.corrupt = true; }
  }

  private append(event: StoredEvent): boolean {
    let fd: number | null = null;
    try {
      const directory = dirname(this.path); mkdirSync(directory, { recursive: true, mode: 0o700 });
      fd = openSync(this.path, "a", 0o600);
      writeFileSync(fd, `${stableJson(event)}\n`, "utf8"); fsyncSync(fd);
      closeSync(fd); fd = null;
      const directoryFd = openSync(directory, "r"); try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      return true;
    } catch { return false; }
    finally { if (fd !== null) try { closeSync(fd); } catch { /* failed close is already a failed append */ } }
  }
}

export function validateRepoFlightTelemetryObservation(value: unknown): value is RepoFlightTelemetryObservation { return validObservation(value); }

/** ADR-152's fixed ten-run, nearest-rank promotion rule. */
export function evaluateRepoFlightPerformancePromotion(input: { readonly lane: RepoFlightPerformanceLane; readonly baseline: readonly RepoFlightPerformanceCohortRun[]; readonly shadow: readonly RepoFlightPerformanceCohortRun[] }): RepoFlightPerformancePromotionResult {
  const findings: string[] = [];
  if (input.baseline.length !== 10 || input.shadow.length !== 10) findings.push("baseline and shadow cohorts must each contain exactly ten runs");
  const runs = [...input.baseline, ...input.shadow];
  if (runs.some((run) => !validPerformanceRun(run))) findings.push("performance cohort contains a malformed run");
  const identities = new Set(runs.map((run) => run.cohort_identity_digest));
  if (identities.size !== 1) findings.push("baseline and shadow runs do not share one fixed cohort identity");
  if (runs.some((run) => !run.host_telemetry_available)) findings.push("host telemetry is unavailable");
  if (input.shadow.some((run) => !run.semantic_agreement || !run.coverage_agreement || !run.attestation_agreement)) findings.push("shadow semantics, coverage, or attestation disagreed with baseline");
  if (input.shadow.some((run) => run.false_cache_hit)) findings.push("shadow cohort contains a false cache hit");
  if (input.shadow.some((run) => !run.crash_evidence_complete)) findings.push("shadow cohort lacks complete crash evidence");
  const baselineP95 = input.baseline.length === 10 && input.baseline.every(validPerformanceRun) ? nearestRankP95(input.baseline.map((run) => run.wall_ms)) : null;
  const shadowP95 = input.shadow.length === 10 && input.shadow.every(validPerformanceRun) ? nearestRankP95(input.shadow.map((run) => run.wall_ms)) : null;
  const reduction = baselineP95 !== null && shadowP95 !== null && baselineP95 > 0 ? ((baselineP95 - shadowP95) / baselineP95) * 100 : null;
  if (baselineP95 !== null && shadowP95 !== null) {
    if (input.lane === "ordinary_changed_scope" && (shadowP95 > 15 * 60_000 || reduction === null || reduction < 60)) findings.push("ordinary changed-scope p95 misses the fifteen-minute and sixty-percent thresholds");
    if (input.lane === "warm_exact_candidate" && shadowP95 > 2 * 60_000) findings.push("warm exact-candidate p95 exceeds two minutes");
    if (input.lane === "uncached_full_audit" && shadowP95 > baselineP95) findings.push("uncached full-audit p95 is slower than baseline");
  }
  return freeze({ eligible: findings.length === 0, lane: input.lane, baseline_p95_ms: baselineP95, shadow_p95_ms: shadowP95, reduction_percent: reduction, findings: freeze(findings) });
}

function validObservation(value: unknown): value is RepoFlightTelemetryObservation {
  if (!exact(value, ["schema_version", "kind", "observation_id", "repo_run_id", "stage", "resource_class", "observed_at", "measurements", "dependencies"])) return false;
  return value.schema_version === 1 && value.kind === "revoy2.repo_flight.stage_telemetry" && validId(value.observation_id) && validId(value.repo_run_id)
    && stage(value.stage) && resourceClass(value.resource_class) && instant(value.observed_at) && validMeasurements(value.measurements) && validDependencies(value.dependencies);
}

function validStoredEvent(value: unknown): value is StoredEvent {
  return exact(value, ["schema_version", "kind", "observation_id", "repo_run_id", "stage", "resource_class", "observed_at", "measurements", "dependencies", "sequence", "previous_hash", "event_hash"])
    && validObservation(stripStored(value)) && typeof value.sequence === "number" && Number.isSafeInteger(value.sequence) && value.sequence > 0
    && (value.previous_hash === null || isDigest(value.previous_hash)) && isDigest(value.event_hash);
}

function stripStored(value: Record<string, unknown>): unknown { const { sequence: _sequence, previous_hash: _previous, event_hash: _hash, ...observation } = value; return observation; }
function validMeasurements(value: unknown): value is RepoFlightStageTelemetry {
  return exact(value, ["queue_ms", "wall_ms", "cpu_ms", "peak_rss_bytes", "io_read_bytes", "io_write_bytes", "cache_hits", "cache_misses"])
    && bounded(value.queue_ms, MAX_DURATION_MS) && bounded(value.wall_ms, MAX_DURATION_MS) && availableBounded(value.cpu_ms, MAX_DURATION_MS)
    && availableBounded(value.peak_rss_bytes, MAX_BYTES) && availableBounded(value.io_read_bytes, MAX_BYTES) && availableBounded(value.io_write_bytes, MAX_BYTES)
    && bounded(value.cache_hits, MAX_COUNTER) && bounded(value.cache_misses, MAX_COUNTER);
}
function validDependencies(value: unknown): value is RepoFlightDependencySummary {
  return exact(value, ["dependency_count", "blocked_dependency_count", "critical_path_ms", "critical_path_digest"])
    && bounded(value.dependency_count, MAX_COUNTER) && bounded(value.blocked_dependency_count, MAX_COUNTER)
    && value.blocked_dependency_count <= value.dependency_count && bounded(value.critical_path_ms, MAX_DURATION_MS) && isDigest(value.critical_path_digest);
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function validText(value: unknown, maximum = MAX_TEXT_BYTES): value is string { return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= maximum; }
function validId(value: unknown): value is string { return validText(value) && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value); }
function instant(value: unknown): value is string { return validText(value, 64) && !Number.isNaN(Date.parse(value)); }
function bounded(value: unknown, maximum: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum; }
function availableBounded(value: unknown, maximum: number): value is number | "unavailable" { return value === "unavailable" || bounded(value, maximum); }
function addAvailable(left: number | "unavailable", right: number | "unavailable"): number | "unavailable" { return left === "unavailable" ? right : right === "unavailable" ? left : left + right; }
function maxAvailable(left: number | "unavailable", right: number | "unavailable"): number | "unavailable" { return left === "unavailable" ? right : right === "unavailable" ? left : Math.max(left, right); }
function stage(value: unknown): value is RepoFlightTelemetryStage { return typeof value === "string" && (REPO_FLIGHT_TELEMETRY_STAGES as readonly string[]).includes(value); }
function resourceClass(value: unknown): value is RepoFlightResourceClass { return typeof value === "string" && (REPO_FLIGHT_RESOURCE_CLASSES as readonly string[]).includes(value); }
function validPerformanceRun(value: RepoFlightPerformanceCohortRun): boolean { return isDigest(value.cohort_identity_digest) && bounded(value.wall_ms, MAX_DURATION_MS) && [value.host_telemetry_available, value.semantic_agreement, value.coverage_agreement, value.attestation_agreement, value.false_cache_hit, value.crash_evidence_complete].every((item) => typeof item === "boolean"); }
function nearestRankP95(values: readonly number[]): number { return [...values].sort((left, right) => left - right)[Math.ceil(0.95 * values.length) - 1]!; }
function isDigest(value: unknown): value is `sha256:${string}` { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value); }
function digest(value: unknown): `sha256:${string}` { return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`; }
function stableJson(value: unknown): string { return JSON.stringify(sort(value)); }
function sort(value: unknown): unknown { if (Array.isArray(value)) return value.map(sort); if (typeof value !== "object" || value === null) return value; return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sort(child)])); }
function freeze<T>(value: T): T { return Object.freeze(value); }
function failure(code: Extract<RepoFlightTelemetryResult, { readonly ok: false }> ["code"], reason: string): RepoFlightTelemetryResult { return { ok: false, code, reason }; }
