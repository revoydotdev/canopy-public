import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateRepoFlightPerformancePromotion, RepoFlightTelemetryStore, validateRepoFlightTelemetryObservation, type RepoFlightPerformanceCohortRun, type RepoFlightTelemetryObservation } from "../src/repo-flight-telemetry.js";

const sha = (letter: string) => `sha256:${letter.repeat(64)}` as `sha256:${string}`;
const sample = (overrides: Partial<RepoFlightTelemetryObservation> = {}): RepoFlightTelemetryObservation => ({
  schema_version: 1,
  kind: "revoy2.repo_flight.stage_telemetry",
  observation_id: "telemetry:one",
  repo_run_id: "run:one",
  stage: "validation",
  resource_class: "standard",
  observed_at: "2026-08-28T18:00:00.000Z",
  measurements: { queue_ms: 14, wall_ms: 400, cpu_ms: 240, peak_rss_bytes: 2_048, io_read_bytes: 120, io_write_bytes: 64, cache_hits: 3, cache_misses: 1 },
  dependencies: { dependency_count: 4, blocked_dependency_count: 1, critical_path_ms: 311, critical_path_digest: sha("a") },
  ...overrides,
});

describe("repo-local Flight telemetry", () => {
  it("durably appends bounded stage measurements and reconstructs a restart-safe critical-path summary", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-flight-telemetry-"));
    const first = new RepoFlightTelemetryStore({ persistence_dir: dir });
    expect(first.record(sample())).toMatchObject({ ok: true, replayed: false });
    expect(first.record(sample())).toMatchObject({ ok: true, replayed: true });
    expect(first.record(sample({ observation_id: "telemetry:two", stage: "coverage", resource_class: "large", measurements: { queue_ms: 7, wall_ms: 900, cpu_ms: 300, peak_rss_bytes: 4_096, io_read_bytes: 40, io_write_bytes: 80, cache_hits: 0, cache_misses: 4 }, dependencies: { dependency_count: 2, blocked_dependency_count: 0, critical_path_ms: 800, critical_path_digest: sha("b") } }))).toMatchObject({ ok: true, replayed: false });
    first.close();

    const restarted = new RepoFlightTelemetryStore({ persistence_dir: dir });
    expect(restarted.list("run:one")).toHaveLength(2);
    expect(restarted.summarize("run:one")).toEqual({
      repo_run_id: "run:one", observation_count: 2, stages: ["validation", "coverage"],
      queue_ms: 21, wall_ms: 1_300, cpu_ms: 540, peak_rss_bytes: 4_096,
      io_read_bytes: 160, io_write_bytes: 144, cache_hits: 3, cache_misses: 5,
      critical_path_ms: 800, critical_path_digest: sha("b"),
    });
    expect(readFileSync(join(dir, "repo-flight-telemetry.jsonl"), "utf8")).not.toContain("stdout");
    restarted.close();
  });

  it("enforces the closed schema so raw output, secrets, unbounded strings, and malformed metrics cannot enter the journal", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-flight-telemetry-"));
    const telemetry = new RepoFlightTelemetryStore({ persistence_dir: dir });
    const rawOutput = { ...sample(), raw_output: "do not persist provider output" };
    const secret = { ...sample(), measurements: { ...sample().measurements, secret: "credential" } };
    const invalidMetric = sample({ measurements: { ...sample().measurements, wall_ms: -1 } });
    const invalidDependency = sample({ dependencies: { ...sample().dependencies, blocked_dependency_count: 5 } });
    expect(validateRepoFlightTelemetryObservation(rawOutput)).toBe(false);
    expect(telemetry.record(rawOutput)).toMatchObject({ ok: false, code: "invalid" });
    expect(telemetry.record(secret)).toMatchObject({ ok: false, code: "invalid" });
    expect(telemetry.record(invalidMetric)).toMatchObject({ ok: false, code: "invalid" });
    expect(telemetry.record(invalidDependency)).toMatchObject({ ok: false, code: "invalid" });
    expect(telemetry.list()).toEqual([]);
    telemetry.close();
  });

  it("fails closed after a tampered durable history rather than replacing it after restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-flight-telemetry-"));
    const telemetry = new RepoFlightTelemetryStore({ persistence_dir: dir });
    expect(telemetry.record(sample())).toMatchObject({ ok: true });
    telemetry.close();
    appendFileSync(join(dir, "repo-flight-telemetry.jsonl"), '{"not":"a chained Flight event"}\n');
    const restarted = new RepoFlightTelemetryStore({ persistence_dir: dir });
    expect(restarted.isAppendable()).toBe(false);
    expect(restarted.record(sample({ observation_id: "telemetry:later" }))).toMatchObject({ ok: false, code: "corrupt_store" });
    restarted.close();
  });

  it("requires fixed ten-run cohorts and nearest-rank p95 before a performance promotion", () => {
    const run = (wall_ms: number, overrides: Partial<RepoFlightPerformanceCohortRun> = {}): RepoFlightPerformanceCohortRun => ({ cohort_identity_digest: sha("c"), wall_ms, host_telemetry_available: true, semantic_agreement: true, coverage_agreement: true, attestation_agreement: true, false_cache_hit: false, crash_evidence_complete: true, ...overrides });
    const eligible = evaluateRepoFlightPerformancePromotion({ lane: "ordinary_changed_scope", baseline: Array.from({ length: 10 }, () => run(60 * 60_000)), shadow: Array.from({ length: 10 }, () => run(10 * 60_000)) });
    expect(eligible).toMatchObject({ eligible: true, baseline_p95_ms: 3_600_000, shadow_p95_ms: 600_000, reduction_percent: expect.any(Number), findings: [] });
    expect(evaluateRepoFlightPerformancePromotion({ lane: "warm_exact_candidate", baseline: Array.from({ length: 10 }, () => run(300_000)), shadow: Array.from({ length: 9 }, () => run(100_000)).concat(run(100_000, { host_telemetry_available: false })) })).toMatchObject({ eligible: false, shadow_p95_ms: 100_000, findings: expect.arrayContaining(["host telemetry is unavailable"]) });
    expect(evaluateRepoFlightPerformancePromotion({ lane: "uncached_full_audit", baseline: Array.from({ length: 10 }, () => run(1_000)), shadow: Array.from({ length: 9 }, () => run(900)).concat(run(1_001)) })).toMatchObject({ eligible: false, baseline_p95_ms: 1_000, shadow_p95_ms: 1_001 });
  });
});
