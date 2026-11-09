/**
 * The one worked example the brief for this workstream calls for: a fixture
 * ADR carrying real obligations whose proof comments point at REAL symbols,
 * files, and test files already present in this repository (EvidenceLedger /
 * canonicalizeForHash / parseKeymap — see fixtures/worked-example.md). Proves
 * the resolver end-to-end (parse -> proof resolution -> coverage), then
 * mutates each field to a nonexistent value and proves each mutation is
 * caught with the correct resolution state.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { parseObligationsFromText, type Obligation } from "../../src/obligation/parse.js";
import { computeRecordCoverage } from "../../src/obligation/coverage.js";
import { resolveProofComment } from "../../src/obligation/proof.js";

const FIXTURE_PATH = resolvePath(dirname(fileURLToPath(import.meta.url)), "fixtures/worked-example.md");
const AT = "2026-08-04T00:00:00.000Z";

function parseFixture() {
  const text = readFileSync(FIXTURE_PATH, "utf-8");
  const result = parseObligationsFromText("revoy2:ADR-900", "packages/arbor-governance/tests/obligation/fixtures/worked-example.md", text);
  if (!result.ok) throw new Error(`fixture failed to parse: ${result.error.message}`);
  return result.value;
}

describe("worked example: parses cleanly", () => {
  it("finds exactly 3 obligations, each carrying one proof comment", () => {
    const record = parseFixture();
    expect(record.has_obligations_section).toBe(true);
    expect(record.obligations).toHaveLength(3);
    expect(record.obligations.map((o) => o.ordinal)).toEqual(["O1", "O2", "O3"]);
    expect(record.duplicate_ordinals).toEqual([]);
    for (const obligation of record.obligations) expect(obligation.proofs).toHaveLength(1);
  });
});

describe("worked example: resolves fully end-to-end (real symbols, real files, real collected tests)", () => {
  it("every obligation fully resolves; record-level implementation is complete, verification verified", () => {
    const record = parseFixture();
    const coverage = computeRecordCoverage(record, { at: AT });
    expect(coverage.ok).toBe(true);
    if (!coverage.ok) return;

    expect(coverage.value.obligation_count).toBe(3);
    expect(coverage.value.obligations_with_resolving_proof).toBe(3);
    expect(coverage.value.implementation).toBe("complete");
    expect(coverage.value.verification).toBe("verified");

    for (const obligation of coverage.value.obligations) {
      expect(obligation.fully_resolved).toBe(true);
      expect(obligation.attests).toBe("test_exists_and_is_collected");
      const [proof] = obligation.proofs;
      expect(proof.symbol.state).toBe("resolved");
      expect(proof.symbol.confidence).toBe("high");
      expect(proof.file?.state).toBe("resolved");
      expect(proof.roundtrip.state).toBe("resolved");
      expect(proof.fully_resolved).toBe(true);
    }
  });
});

describe("worked example: single-field mutations are each caught", () => {
  const record = parseFixture();
  const o1 = record.obligations[0] as Obligation; // symbol=EvidenceLedger file=.../audit.ts roundtrip=.../hash-chain-integrity.test.ts
  const baseProof = o1.proofs[0];

  it("baseline O1 proof resolves fully (sanity check before mutating)", () => {
    const result = resolveProofComment(baseProof, { at: AT });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.fully_resolved).toBe(true);
  });

  it("mutated symbol= (nonexistent name) is caught as missing", () => {
    const mutated = { ...baseProof, symbol: "TotallyNotARealSymbol_9284" };
    const result = resolveProofComment(mutated, { at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.symbol.state).toBe("missing");
    expect(result.value.fully_resolved).toBe(false);
  });

  it("mutated file= (nonexistent path) is caught as missing, and the dependent symbol= becomes unverifiable — never silently resolved", () => {
    const mutated = { ...baseProof, file: "packages/arbor-audit/src/this-file-does-not-exist.ts" };
    const result = resolveProofComment(mutated, { at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.file?.state).toBe("missing");
    expect(result.value.symbol.state).toBe("unverifiable");
    expect(result.value.symbol.state).not.toBe("resolved");
    expect(result.value.fully_resolved).toBe(false);
  });

  it("mutated roundtrip= (nonexistent test file) is caught as missing", () => {
    const mutated = { ...baseProof, roundtrip: "packages/arbor-audit/tests/this-test-does-not-exist.test.ts" };
    const result = resolveProofComment(mutated, { at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.roundtrip.state).toBe("missing");
    expect(result.value.fully_resolved).toBe(false);
  });

  it("the subtle case: roundtrip= pointing at a REAL, EXISTING file vitest never collects is caught as a false proof, not resolved", () => {
    // packages/arbor-audit/src/audit.ts is a real file — it exists on disk —
    // but it is a src file, not under any tests/ directory, so it is not
    // matched by the "packages/**/tests/**/*.test.ts" include glob. A naive
    // "does the path exist" check would wrongly call this resolved.
    const mutated = { ...baseProof, roundtrip: "packages/arbor-audit/src/audit.ts" };
    const result = resolveProofComment(mutated, { at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.roundtrip.state).toBe("missing");
    expect(result.value.roundtrip.detail).toMatch(/not matched by any vitest\.config\.ts include glob/);
    expect(result.value.fully_resolved).toBe(false);
  });
});
