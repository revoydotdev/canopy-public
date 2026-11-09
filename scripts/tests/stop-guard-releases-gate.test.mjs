/**
 * scripts/tests/stop-guard-releases-gate.test.mjs — ADR-154.
 *
 * The point of these is the direction of the verdict. A release record that
 * names no gate is a regression AFTER the baseline and history BEFORE it, and
 * getting that backwards is the whole risk: too strict and every clone with
 * the historical journal wedges permanently, too loose and the regression this
 * gate exists to catch is relabelled as history.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATE = join(REPO_ROOT, "scripts", "stop-guard-releases-gate.mjs");

const { auditReleases, readBaseline, readReleases, REPORT_WINDOW_DAYS } = await import(GATE);

const BASELINE = Date.parse("2026-08-30T05:16:28.118Z");

const named = (at, count = 4) => ({
  schema_version: 1,
  session_id: "s",
  fingerprint: "abc",
  consecutive_count: count,
  released_at: at,
  blocking_gates: [{ gate: "gate:anti-stub:blocking", exit_code: "1" }],
  advisory_red_gates: [],
});

const unnamed = (at, count = 4) => ({
  schema_version: 1,
  session_id: "s",
  fingerprint: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  consecutive_count: count,
  released_at: at,
  blocking_gates: [],
  advisory_red_gates: [],
});

describe("the committed baseline", () => {
  it("parses, and is the instant the historical records end at", () => {
    const baseline = readBaseline();
    expect(baseline.ok).toBe(true);
    expect(baseline.through).toBe(BASELINE);
    expect(baseline.raw.adr).toBe(154);
  });

  it("is a blocker when unreadable, never an empty default", () => {
    const dir = mkdtempSync(join(tmpdir(), "revoy2-sg-baseline-"));
    try {
      const path = join(dir, "baseline.json");
      writeFileSync(path, "{ not json");
      expect(readBaseline(path).ok).toBe(false);
      writeFileSync(path, JSON.stringify({ empty_release_records_historical_through: "whenever" }));
      expect(readBaseline(path).ok).toBe(false);
      expect(readBaseline(join(dir, "absent.json")).ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("auditReleases", () => {
  it("passes on the historical empty-set records, which are evidence not regressions", () => {
    const records = [unnamed("2026-08-27T10:00:00.000Z"), unnamed("2026-08-30T05:16:28.118Z")];
    const result = auditReleases({ records, baselineThrough: BASELINE });
    expect(result.ok).toBe(true);
    expect(result.regressions).toEqual([]);
    expect(result.summary.historical_empty_releases).toBe(2);
  });

  it("FAILS on an empty-set record dated after the baseline", () => {
    const records = [unnamed("2026-08-27T10:00:00.000Z"), unnamed("2026-08-31T00:00:00.000Z")];
    const result = auditReleases({ records, baselineThrough: BASELINE });
    expect(result.ok).toBe(false);
    expect(result.regressions).toHaveLength(1);
    expect(result.problems[0]).toMatch(/named no red gate/);
    expect(result.problems[0]).toMatch(/regressed/);
  });

  it("treats an undated record as a regression, not as history", () => {
    // The safe direction: report a record we cannot place, rather than wave it
    // through on the strength of a missing field.
    const result = auditReleases({ records: [unnamed(undefined)], baselineThrough: BASELINE });
    expect(result.ok).toBe(false);
    expect(result.regressions).toHaveLength(1);
  });

  it("never fails on a named release, however many there are", () => {
    // A release means a session met a red gate it had no authority to clear.
    // That is the case the breaker exists for; failing here would punish the
    // session for the repository's state.
    const records = Array.from({ length: 200 }, (_, i) => named(`2026-09-0${(i % 9) + 1}T00:00:00.000Z`, i));
    const result = auditReleases({ records, baselineThrough: BASELINE });
    expect(result.ok).toBe(true);
    expect(result.summary.total_releases).toBe(200);
  });

  it("reports the rate signal an operator needs, without gating on it", () => {
    const now = Date.parse("2026-09-02T00:00:00.000Z");
    const records = [
      named("2026-09-01T00:00:00.000Z", 43),
      named("2026-08-01T00:00:00.000Z", 4),
      { ...named("2026-09-01T12:00:00.000Z", 5), fingerprint: "zzz" },
    ];
    const { summary } = auditReleases({ records, baselineThrough: BASELINE, now });
    expect(summary.total_releases).toBe(3);
    expect(summary.releases_in_window).toBe(2); // the 2026-08-01 one is outside 7 days
    expect(summary.window_days).toBe(REPORT_WINDOW_DAYS);
    expect(summary.max_consecutive_count).toBe(43);
    expect(summary.distinct_fingerprints).toBe(2);
    expect(summary.top_fingerprints[0]).toEqual({ fingerprint: "abc", count: 2 });
  });
});

describe("readReleases", () => {
  it("reports a malformed line rather than silently skipping it", () => {
    const dir = mkdtempSync(join(tmpdir(), "revoy2-sg-journal-"));
    try {
      const path = join(dir, "releases.jsonl");
      writeFileSync(path, `${JSON.stringify(named("2026-09-01T00:00:00.000Z"))}\nnot json\n`);
      const result = readReleases(path);
      expect(result.ok).toBe(false);
      expect(result.malformed).toEqual([2]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is clean and empty on a clone that has never released", () => {
    const result = readReleases(join(tmpdir(), "revoy2-no-such-journal.jsonl"));
    expect(result).toEqual({ ok: true, records: [], present: false });
  });
});
