/**
 * scripts/tests/remedy-coverage-gate.test.mjs — ADR-113 decision 2/3's ratchet.
 *
 * WHY THESE TESTS. `auditRemedyCoverage` re-verifies its curated
 * `EXEMPT_GATES` list against real source text on every run rather than
 * trusting a static claim, and refuses to grow past `FLOOR` (7). These tests
 * pin both halves: the real repo's five confirmed entries actually verify
 * against real files, and the synthetic-fixture cases prove each failure
 * mode (stale entry, drifted source, missing file, over-floor) is reported
 * rather than silently passed.
 */

import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { auditRemedyCoverage, EXEMPT_GATES, FLOOR } from "../remedy-coverage-gate.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(REPO_ROOT, "scripts", "remedy-coverage-gate.mjs");

describe("auditRemedyCoverage — against the real repository", () => {
  it("confirms every curated entry against real, current source text", () => {
    const report = auditRemedyCoverage();
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.stale_entries).toEqual([]);
    expect(report.confirmed_remedy_less).toEqual(EXEMPT_GATES.map((e) => e.gate));
  });

  it("stays at or under the floor", () => {
    expect(EXEMPT_GATES.length).toBeLessThanOrEqual(FLOOR);
  });

  it("every exempt entry names a gate actually declared in package.json", () => {
    const declared = new Set(EXEMPT_GATES.map((e) => e.gate));
    const report = auditRemedyCoverage();
    for (const gate of declared) expect(report.confirmed_remedy_less.concat(report.stale_entries)).toContain(gate);
  });
});

describe("auditRemedyCoverage — failure modes, proven with synthetic fixtures", () => {
  it("reports a stale entry when its gate no longer exists in package.json", () => {
    const report = auditRemedyCoverage({
      declaredGates: ["gate:something-else"],
      exempt: [{ gate: "gate:long-gone", file: "does-not-matter.mjs", citation: "x:1", verify: () => true }],
    });
    expect(report.ok).toBe(false);
    expect(report.stale_entries).toEqual(["gate:long-gone"]);
  });

  it("reports a problem when the cited file no longer exists", () => {
    const report = auditRemedyCoverage({
      declaredGates: ["gate:fixture"],
      exempt: [{ gate: "gate:fixture", file: "scripts/does-not-exist-anywhere.mjs", citation: "x:1", verify: () => true }],
    });
    expect(report.ok).toBe(false);
    expect(report.problems[0]).toContain("no longer exists");
  });

  it("reports a problem when the verify predicate no longer matches real current source (drift)", () => {
    // package.json is a real, stable repo file; a predicate demanding text it
    // will never contain proves the "source changed shape" path fires against
    // REAL file text, not a mock.
    const report = auditRemedyCoverage({
      declaredGates: ["gate:fixture"],
      exempt: [{
        gate: "gate:fixture",
        file: "package.json",
        citation: "package.json:1",
        verify: (text) => text.includes("this string will never appear in package.json"),
      }],
    });
    expect(report.ok).toBe(false);
    expect(report.problems[0]).toContain("no longer matches current source");
  });

  it("fails once the exempt count exceeds FLOOR", () => {
    const overFloor = Array.from({ length: FLOOR + 1 }, (_, i) => ({
      gate: `gate:synthetic-${i}`,
      file: "package.json",
      citation: "synthetic",
      verify: () => true,
    }));
    const report = auditRemedyCoverage({
      declaredGates: overFloor.map((e) => e.gate),
      exempt: overFloor,
    });
    expect(report.over_floor).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("passes with an exempt list at exactly FLOOR", () => {
    const atFloor = Array.from({ length: FLOOR }, (_, i) => ({
      gate: `gate:synthetic-${i}`,
      file: "package.json",
      citation: "synthetic",
      verify: () => true,
    }));
    const report = auditRemedyCoverage({
      declaredGates: atFloor.map((e) => e.gate),
      exempt: atFloor,
    });
    expect(report.over_floor).toBe(false);
    expect(report.ok).toBe(true);
  });
});

describe("CLI", () => {
  it("passes (exit 0) against the real repository, human-readable mode", () => {
    const output = execFileSync(process.execPath, [CLI], { encoding: "utf8", cwd: REPO_ROOT });
    expect(output).toContain("PASS");
    for (const entry of EXEMPT_GATES) expect(output).toContain(entry.gate);
  });

  it("passes (exit 0) against the real repository, --json mode", () => {
    const output = execFileSync(process.execPath, [CLI, "--json"], { encoding: "utf8", cwd: REPO_ROOT });
    const report = JSON.parse(output);
    expect(report.ok).toBe(true);
    expect(report.floor).toBe(FLOOR);
  });
});
