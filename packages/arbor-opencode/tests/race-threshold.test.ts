/**
 * X-1 (ADR-069, learned fork threshold): behavior tests for
 * `resolveLearnedForkThresholdMs` and its supporting ledger-scan helpers,
 * against real-shaped ledger JSONL fixtures (the exact record shapes
 * verified against qa-bench's real audit ledgers -- `telemetry_observation`
 * records carrying `phase_timing`/`expand` and `usage_cost` with an
 * `operation_id` ending `:specialist`).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RACE_THRESHOLD_MAX_LEDGER_FILES,
  RACE_THRESHOLD_MIN_OBSERVATIONS,
  collectSpecialistWallObservations,
  p50,
  resolveLearnedForkThresholdMs,
} from "../src/race-threshold.js";
import { DEFAULT_RACE_FORK_MS, MAX_RACE_FORK_MS, MIN_RACE_FORK_MS, RACE_FORK_MS_ENV } from "../src/race.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function persistenceDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "arbor-race-threshold-"));
  directories.push(directory);
  mkdirSync(join(directory, "audit"), { recursive: true });
  return directory;
}

/** Builds a two-line ledger fixture: an `expand` phase_timing at `expandTs`, then a `:specialist` usage_cost at `usageTs`, for one (campaign, node, epoch). Mirrors the real record shape (only the fields this module reads are populated). */
function ledgerLine(kind: string, campaignId: string, nodeId: string, timestamp: string, observation: Record<string, unknown>): string {
  return JSON.stringify({ kind, campaign_id: campaignId, node_id: nodeId, timestamp, observation });
}

function writeLedger(directory: string, fileName: string, records: string[]): void {
  writeFileSync(join(directory, "audit", fileName), `${records.join("\n")}\n`);
}

function specialistDeltaRecords(campaignId: string, nodeId: string, epoch: number, expandTs: string, usageTs: string): string[] {
  return [
    ledgerLine("telemetry_observation", campaignId, nodeId, expandTs, { type: "phase_timing", phase: "expand", epoch, duration_ms: 33 }),
    ledgerLine("telemetry_observation", campaignId, nodeId, usageTs, {
      type: "usage_cost",
      phase: "expand",
      epoch,
      operation_id: `${campaignId}:${nodeId}:specialist`,
    }),
  ];
}

describe("collectSpecialistWallObservations", () => {
  it("returns [] when the audit directory does not exist", () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-race-threshold-nodir-"));
    directories.push(directory);
    expect(collectSpecialistWallObservations(directory)).toEqual([]);
  });

  it("extracts one delta per (campaign, node, epoch) with both an expand phase_timing and a :specialist usage_cost", () => {
    const directory = persistenceDir();
    writeLedger(directory, "camp1.jsonl", specialistDeltaRecords(
      "camp1", "node_1", 1,
      "2026-08-15T00:00:00.000Z",
      "2026-08-15T00:00:20.000Z",
    ));
    const deltas = collectSpecialistWallObservations(directory);
    expect(deltas).toEqual([20_000]);
  });

  it("skips malformed lines silently and still extracts valid ones", () => {
    const directory = persistenceDir();
    const records = specialistDeltaRecords("camp1", "node_1", 1, "2026-08-15T00:00:00.000Z", "2026-08-15T00:00:10.000Z");
    writeLedger(directory, "camp1.jsonl", ["{not valid json", "", ...records, "{\"also\": \"not enough fields\"}"]);
    expect(collectSpecialistWallObservations(directory)).toEqual([10_000]);
  });

  it("ignores a node whose expand phase_timing is present but whose specialist usage_cost never arrives", () => {
    const directory = persistenceDir();
    writeLedger(directory, "camp1.jsonl", [
      ledgerLine("telemetry_observation", "camp1", "node_1", "2026-08-15T00:00:00.000Z", { type: "phase_timing", phase: "expand", epoch: 1 }),
    ]);
    expect(collectSpecialistWallObservations(directory)).toEqual([]);
  });

  it("does not confuse a critic-suffixed usage_cost with a specialist one", () => {
    const directory = persistenceDir();
    writeLedger(directory, "camp1.jsonl", [
      ledgerLine("telemetry_observation", "camp1", "node_1", "2026-08-15T00:00:00.000Z", { type: "phase_timing", phase: "expand", epoch: 1 }),
      ledgerLine("telemetry_observation", "camp1", "node_1", "2026-08-15T00:00:05.000Z", { type: "usage_cost", phase: "critic", epoch: 1, operation_id: "camp1:node_1:critic" }),
    ]);
    expect(collectSpecialistWallObservations(directory)).toEqual([]);
  });

  it("scans multiple ledger files across multiple campaigns", () => {
    const directory = persistenceDir();
    writeLedger(directory, "camp1.jsonl", specialistDeltaRecords("camp1", "node_1", 1, "2026-08-15T00:00:00.000Z", "2026-08-15T00:00:15.000Z"));
    writeLedger(directory, "camp2.jsonl", specialistDeltaRecords("camp2", "node_1", 1, "2026-08-15T00:00:00.000Z", "2026-08-15T00:00:25.000Z"));
    expect([...collectSpecialistWallObservations(directory)].sort((a: number, b: number) => a - b)).toEqual([15_000, 25_000]);
  });

  it("bounds the scan to the newest RACE_THRESHOLD_MAX_LEDGER_FILES files by mtime", () => {
    const directory = persistenceDir();
    const total = RACE_THRESHOLD_MAX_LEDGER_FILES + 5;
    for (let i = 0; i < total; i++) {
      const campaignId = `camp${i}`;
      writeLedger(directory, `${campaignId}.jsonl`, specialistDeltaRecords(campaignId, "node_1", 1, "2026-08-15T00:00:00.000Z", "2026-08-15T00:00:11.000Z"));
      // Stagger mtimes so ordering is deterministic; the oldest 5 files (i < 5) must be excluded.
      const mtime = new Date(2026, 7, 15, 0, 0, i);
      utimesSync(join(directory, "audit", `${campaignId}.jsonl`), mtime, mtime);
    }
    const deltas = collectSpecialistWallObservations(directory);
    expect(deltas).toHaveLength(RACE_THRESHOLD_MAX_LEDGER_FILES);
  });
});

describe("p50", () => {
  it("computes the median of an odd-length list", () => {
    expect(p50([5, 1, 3])).toBe(3);
  });
  it("computes the average of the two middle values of an even-length list", () => {
    expect(p50([10, 20, 30, 40])).toBe(25);
  });
  it("throws on an empty list", () => {
    expect(() => p50([])).toThrow();
  });
});

describe("resolveLearnedForkThresholdMs", () => {
  it("falls back to the default when fewer than RACE_THRESHOLD_MIN_OBSERVATIONS deltas exist", () => {
    const directory = persistenceDir();
    for (let i = 0; i < RACE_THRESHOLD_MIN_OBSERVATIONS - 1; i++) {
      writeLedger(directory, `camp${i}.jsonl`, specialistDeltaRecords(`camp${i}`, "node_1", 1, "2026-08-15T00:00:00.000Z", "2026-08-15T00:00:10.000Z"));
    }
    const result = resolveLearnedForkThresholdMs(directory, "refactor", {});
    expect(result).toEqual({ thresholdMs: DEFAULT_RACE_FORK_MS, source: "default", observations: RACE_THRESHOLD_MIN_OBSERVATIONS - 1 });
  });

  it("computes a learned p50 threshold once at least RACE_THRESHOLD_MIN_OBSERVATIONS deltas exist", () => {
    const directory = persistenceDir();
    const deltaSeconds = [10, 12, 14, 16, 18]; // p50 = 14s = 14000ms, well within [MIN,MAX]
    deltaSeconds.forEach((seconds, i) => {
      writeLedger(directory, `camp${i}.jsonl`, specialistDeltaRecords(`camp${i}`, "node_1", 1, "2026-08-15T00:00:00.000Z", `2026-08-15T00:00:${String(seconds).padStart(2, "0")}.000Z`));
    });
    const result = resolveLearnedForkThresholdMs(directory, "refactor", {});
    expect(result).toEqual({ thresholdMs: 14_000, source: "learned", observations: 5 });
  });

  it("an env override always wins over a learned value", () => {
    const directory = persistenceDir();
    const deltaSeconds = [10, 12, 14, 16, 18];
    deltaSeconds.forEach((seconds, i) => {
      writeLedger(directory, `camp${i}.jsonl`, specialistDeltaRecords(`camp${i}`, "node_1", 1, "2026-08-15T00:00:00.000Z", `2026-08-15T00:00:${String(seconds).padStart(2, "0")}.000Z`));
    });
    const result = resolveLearnedForkThresholdMs(directory, "refactor", { [RACE_FORK_MS_ENV]: "9000" });
    expect(result).toEqual({ thresholdMs: 9_000, source: "env", observations: 0 });
  });

  it("clamps a learned threshold below MIN_RACE_FORK_MS", () => {
    const directory = persistenceDir();
    // 5 deltas, all 1000ms => p50 1000ms, below MIN_RACE_FORK_MS.
    for (let i = 0; i < 5; i++) {
      writeLedger(directory, `camp${i}.jsonl`, specialistDeltaRecords(`camp${i}`, "node_1", 1, "2026-08-15T00:00:00.000Z", "2026-08-15T00:00:01.000Z"));
    }
    const result = resolveLearnedForkThresholdMs(directory, null, {});
    expect(result).toEqual({ thresholdMs: MIN_RACE_FORK_MS, source: "learned", observations: 5 });
  });

  it("clamps a learned threshold above MAX_RACE_FORK_MS", () => {
    const directory = persistenceDir();
    for (let i = 0; i < 5; i++) {
      writeLedger(directory, `camp${i}.jsonl`, specialistDeltaRecords(`camp${i}`, "node_1", 1, "2026-08-15T00:00:00.000Z", "2026-08-15T00:10:00.000Z")); // 600s
    }
    const result = resolveLearnedForkThresholdMs(directory, undefined, {});
    expect(result).toEqual({ thresholdMs: MAX_RACE_FORK_MS, source: "learned", observations: 5 });
  });

  it("ignores taskCategory -- the ledger schema carries no category field, so the same global p50 is returned regardless of the category argument", () => {
    const directory = persistenceDir();
    const deltaSeconds = [10, 12, 14, 16, 18];
    deltaSeconds.forEach((seconds, i) => {
      writeLedger(directory, `camp${i}.jsonl`, specialistDeltaRecords(`camp${i}`, "node_1", 1, "2026-08-15T00:00:00.000Z", `2026-08-15T00:00:${String(seconds).padStart(2, "0")}.000Z`));
    });
    const forRefactor = resolveLearnedForkThresholdMs(directory, "refactor", {});
    const forFeature = resolveLearnedForkThresholdMs(directory, "feature", {});
    const forNull = resolveLearnedForkThresholdMs(directory, null, {});
    expect(forRefactor).toEqual(forFeature);
    expect(forRefactor).toEqual(forNull);
  });
});

describe("p50 — integer output (bench v6 regression)", () => {
  it("an even sample count yields a rounded integer, never the fractional midpoint the ledger validator refuses", async () => {
    const { p50 } = await import("../src/race-threshold.js");
    expect(p50([25676, 25677])).toBe(Math.round((25676 + 25677) / 2));
    expect(Number.isSafeInteger(p50([10, 21, 30, 41]))).toBe(true);
  });
});
