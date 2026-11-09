import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkGapStatusConsistency, SUR_06_RULE_ID } from "../../src/gap-status/check.js";
import { parseGapRegister } from "../../src/gap-status/register.js";

const REPO_ROOT = process.cwd();
const AT = "2026-08-18T00:00:00.000Z";
const FIXTURE_ROADMAP = "packages/arbor-governance/tests/gap-status/fixtures/roadmap-fixture.md";
const FIXTURE_CONSISTENT = "packages/arbor-governance/tests/gap-status/fixtures/mentions-consistent.md";
const FIXTURE_BARE = "packages/arbor-governance/tests/gap-status/fixtures/mentions-bare.md";
const FIXTURE_CONTRADICTING = "packages/arbor-governance/tests/gap-status/fixtures/mentions-contradicting.md";
const FIXTURE_CORRECTED = "packages/arbor-governance/tests/gap-status/fixtures/mentions-corrected.md";

function fixtureRegister() {
  const text = readFileSync(join(REPO_ROOT, FIXTURE_ROADMAP), "utf8");
  return parseGapRegister(text);
}

describe("checkGapStatusConsistency — no false positives", () => {
  it("reports zero findings for a document whose assertions agree with the register", () => {
    const findings = checkGapStatusConsistency(REPO_ROOT, [FIXTURE_CONSISTENT], fixtureRegister(), { at: AT });
    expect(findings).toEqual([]);
  });

  it("reports zero findings for bare, non-status references — including a gap id with no register row at all", () => {
    const findings = checkGapStatusConsistency(REPO_ROOT, [FIXTURE_BARE], fixtureRegister(), { at: AT });
    expect(findings).toEqual([]);
  });

  it("skips a configured document that does not exist, rather than erroring", () => {
    const findings = checkGapStatusConsistency(REPO_ROOT, ["does/not/exist.md"], fixtureRegister(), { at: AT });
    expect(findings).toEqual([]);
  });

  it("does not compare the register document's own table against itself", () => {
    // The fixture's own prose above the register says "G-01 is closed" (true,
    // matches the row) and never asserts anything false outside the table —
    // scanning the register document itself must not flag its own rows as
    // contradicting themselves, once told (via registerDocument) which
    // document the register came from.
    const findings = checkGapStatusConsistency(REPO_ROOT, [FIXTURE_ROADMAP], fixtureRegister(), {
      at: AT,
      registerDocument: FIXTURE_ROADMAP,
    });
    expect(findings).toEqual([]);
  });

});

describe("checkGapStatusConsistency — contradicting fixture", () => {
  const findings = checkGapStatusConsistency(REPO_ROOT, [FIXTURE_CONTRADICTING], fixtureRegister(), { at: AT });

  it("flags the G-01 contradiction (register: closed, mention: open) — the G-36 class this gate exists to catch", () => {
    expect(findings.some((f) => f.detail.includes("G-01") && f.detail.includes("asserts G-01 is open"))).toBe(true);
  });

  it("flags the G-02 checklist contradiction (register: open, checklist: closed)", () => {
    expect(findings.some((f) => f.detail.includes("G-02") && f.detail.includes("asserts G-02 is closed"))).toBe(true);
  });

  it("tags every finding with rule_id SUR-06 and a non-empty remediation", () => {
    expect(findings.length).toBeGreaterThanOrEqual(2);
    for (const finding of findings) {
      expect(finding.rule_id).toBe(SUR_06_RULE_ID);
      expect(finding.remediation.length).toBeGreaterThan(0);
      expect(finding.waiver_eligible).toBe(true);
    }
  });
});

describe("checkGapStatusConsistency — empirical fail/pass proof (the gate has teeth)", () => {
  it("FAILS on the contradicting fixture, then PASSES on the corrected fixture (same claims, statuses reconciled with the register)", () => {
    const register = fixtureRegister();

    const before = checkGapStatusConsistency(REPO_ROOT, [FIXTURE_CONTRADICTING], register, { at: AT });
    expect(before.length).toBeGreaterThanOrEqual(2);

    const after = checkGapStatusConsistency(REPO_ROOT, [FIXTURE_CORRECTED], register, { at: AT });
    expect(after).toEqual([]);
  });
});
