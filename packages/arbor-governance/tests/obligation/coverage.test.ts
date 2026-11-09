import { describe, expect, it } from "vitest";
import { parseObligationsFromText } from "../../src/obligation/parse.js";
import { computeObligationCoverage, computeRecordCoverage } from "../../src/obligation/coverage.js";

const AT = "2026-08-04T00:00:00.000Z";

describe("computeRecordCoverage: zero-obligation records (the current, honest state of every legacy ADR)", () => {
  it("obligation_count 0 => implementation none, verification not_applicable", () => {
    const parsed = parseObligationsFromText("revoy2:ADR-999", "decisions/ADR-999-fixture.md", "# ADR-999\n\n**Status:** Accepted\n");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const coverage = computeRecordCoverage(parsed.value, { at: AT });
    expect(coverage.ok).toBe(true);
    if (!coverage.ok) return;
    expect(coverage.value.obligation_count).toBe(0);
    expect(coverage.value.obligations_with_resolving_proof).toBe(0);
    expect(coverage.value.implementation).toBe("none");
    expect(coverage.value.verification).toBe("not_applicable");
  });
});

describe("computeRecordCoverage: status derivation across resolution mixes", () => {
  const TEXT = [
    "## Obligations",
    "",
    "### O1 — resolves fully",
    "<!-- proof: symbol=EvidenceLedger file=packages/arbor-audit/src/audit.ts roundtrip=packages/arbor-audit/tests/hash-chain-integrity.test.ts -->",
    "",
    "### O2 — never resolves (bad symbol)",
    "<!-- proof: symbol=NoSuchSymbolAnywhere42 roundtrip=packages/arbor-audit/tests/hash-chain-integrity.test.ts -->",
  ].join("\n");

  it("partial resolution across obligations => implementation partial, verification partial", () => {
    const parsed = parseObligationsFromText("revoy2:ADR-950", "decisions/ADR-950-fixture.md", TEXT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const coverage = computeRecordCoverage(parsed.value, { at: AT });
    expect(coverage.ok).toBe(true);
    if (!coverage.ok) return;
    expect(coverage.value.obligation_count).toBe(2);
    expect(coverage.value.obligations_with_resolving_proof).toBe(1);
    expect(coverage.value.implementation).toBe("partial");
    expect(coverage.value.verification).toBe("partial");
  });

  it("a fully-resolving obligation's coverage attests exactly 'test_exists_and_is_collected', nothing stronger", () => {
    const parsed = parseObligationsFromText("revoy2:ADR-950", "decisions/ADR-950-fixture.md", TEXT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const coverage = computeRecordCoverage(parsed.value, { at: AT });
    expect(coverage.ok).toBe(true);
    if (!coverage.ok) return;
    const [o1, o2] = coverage.value.obligations;
    expect(o1.fully_resolved).toBe(true);
    expect(o1.attests).toBe("test_exists_and_is_collected");
    expect(o2.fully_resolved).toBe(false);
    expect(o2.attests).toBeNull();
  });

  it("zero-of-N resolving => implementation none, verification unverified (distinct from the zero-obligation case)", () => {
    const badText = TEXT.replace("symbol=EvidenceLedger", "symbol=AlsoNotReal99");
    const parsed = parseObligationsFromText("revoy2:ADR-951", "decisions/ADR-951-fixture.md", badText);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const coverage = computeRecordCoverage(parsed.value, { at: AT });
    expect(coverage.ok).toBe(true);
    if (!coverage.ok) return;
    expect(coverage.value.obligation_count).toBe(2);
    expect(coverage.value.obligations_with_resolving_proof).toBe(0);
    expect(coverage.value.implementation).toBe("none");
    expect(coverage.value.verification).toBe("unverified");
  });
});

describe("computeObligationCoverage: propagates a sub-resolution error without throwing", () => {
  it("still returns a well-formed GovernanceResult for an obligation with zero proofs", () => {
    const parsed = parseObligationsFromText(
      "revoy2:ADR-952",
      "decisions/ADR-952-fixture.md",
      "## Obligations\n\n### O1 — no proof comment at all\n",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const [obligation] = parsed.value.obligations;
    const result = computeObligationCoverage(obligation, { at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.proof_count).toBe(0);
    expect(result.value.resolving_proof_count).toBe(0);
    expect(result.value.fully_resolved).toBe(false);
    expect(result.value.attests).toBeNull();
  });
});
