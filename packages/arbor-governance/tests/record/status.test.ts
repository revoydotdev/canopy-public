import { describe, expect, it } from "vitest";
import { deriveStatusVector, validateTransition, ZERO_OBLIGATIONS } from "../../src/record/status.js";
import type { DecisionStatus } from "../../src/contracts.js";

const LEGAL: ReadonlyArray<[DecisionStatus, DecisionStatus]> = [
  ["draft", "proposed"],
  ["draft", "rejected"],
  ["proposed", "accepted"],
  ["proposed", "rejected"],
  ["accepted", "superseded"],
];

const ALL_STATUSES: readonly DecisionStatus[] = ["draft", "proposed", "accepted", "rejected", "superseded"];

describe("validateTransition", () => {
  it.each(LEGAL)("allows %s -> %s", (from, to) => {
    const result = validateTransition(from, to);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ from, to });
  });

  it("rejects every pair not in the legal table", () => {
    const legalSet = new Set(LEGAL.map(([f, t]) => `${f}->${t}`));
    let illegalChecked = 0;
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const key = `${from}->${to}`;
        if (legalSet.has(key)) continue;
        illegalChecked++;
        const result = validateTransition(from, to);
        expect(result.ok).toBe(false);
        if (result.ok) continue;
        expect(result.error.code).toBe("validation");
        expect(result.error.at).toBe(key);
      }
    }
    // sanity: we actually exercised a nontrivial number of illegal pairs
    expect(illegalChecked).toBe(ALL_STATUSES.length * ALL_STATUSES.length - LEGAL.length);
  });

  it("rejects a no-op (same state to itself) for every state", () => {
    for (const s of ALL_STATUSES) {
      const result = validateTransition(s, s);
      expect(result.ok).toBe(false);
    }
  });

  it("rejects transitions out of terminal states (rejected, superseded)", () => {
    for (const to of ALL_STATUSES) {
      expect(validateTransition("rejected", to).ok).toBe(false);
      expect(validateTransition("superseded", to).ok).toBe(false);
    }
  });

  it("rejects skipping draft straight to accepted", () => {
    expect(validateTransition("draft", "accepted").ok).toBe(false);
  });
});

describe("deriveStatusVector", () => {
  it("zero obligations (every legacy record): implementation none, verification unverified, compliance unknown", () => {
    const vector = deriveStatusVector("accepted", ZERO_OBLIGATIONS);
    expect(vector).toEqual({
      decision: "accepted",
      implementation: "none",
      verification: "unverified",
      compliance: "unknown",
    });
  });

  it("carries the decision status through unchanged", () => {
    for (const decision of ALL_STATUSES) {
      expect(deriveStatusVector(decision, ZERO_OBLIGATIONS).decision).toBe(decision);
    }
  });

  it("partial satisfaction/verification when some but not all obligations resolve", () => {
    const vector = deriveStatusVector("accepted", { total: 4, satisfied: 2, verifiedByTest: 1 });
    expect(vector.implementation).toBe("partial");
    expect(vector.verification).toBe("partial");
  });

  it("complete/verified when every obligation resolves and is test-verified", () => {
    const vector = deriveStatusVector("accepted", { total: 3, satisfied: 3, verifiedByTest: 3 });
    expect(vector.implementation).toBe("complete");
    expect(vector.verification).toBe("verified");
  });

  it("compliance is never anything but unknown — this package owns no graph-plane comparison", () => {
    expect(deriveStatusVector("accepted", { total: 10, satisfied: 10, verifiedByTest: 10 }).compliance).toBe(
      "unknown",
    );
  });
});
