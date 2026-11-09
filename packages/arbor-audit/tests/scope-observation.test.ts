import { describe, expect, it } from "vitest";
import {
  EvidenceLedger,
  type ScopeObservationInput,
  SCOPE_OBSERVATION_MAX_PATHS,
  SCOPE_OBSERVATION_MAX_PATH_BYTES,
  validateScopeObservation,
} from "../src/audit.js";

function observation(overrides: Partial<ScopeObservationInput> = {}): ScopeObservationInput {
  return {
    campaign_id: "campaign",
    node_id: "node-a",
    declared: ["test/decorator.test.js"],
    observed_out_of_scope: ["lib/decorator.js"],
    enforcement: "audit",
    idempotency_key: "result:1:scope",
    ...overrides,
  };
}

describe("ScopeObservation audit evidence (Y-1, graduated scope enforcement)", () => {
  it("recordScopeObservation appends a hash-chained record and is idempotent on the same idempotency_key", () => {
    const ledger = new EvidenceLedger();
    const id = ledger.recordScopeObservation(observation());
    expect(id).toMatch(/^scopeobs_/);
    expect(ledger.recordScopeObservation(observation())).toBe(id);
    expect(() => ledger.recordScopeObservation(observation({ enforcement: "blocked" })))
      .toThrow(/conflicting scope observation/);
    expect(ledger.verifyIntegrity().valid).toBe(true);
  });

  it("getScopeObservations returns only records for the requested campaign", () => {
    const ledger = new EvidenceLedger();
    ledger.recordScopeObservation(observation({ campaign_id: "a", idempotency_key: "k1" }));
    ledger.recordScopeObservation(observation({ campaign_id: "b", idempotency_key: "k2" }));
    expect(ledger.getScopeObservations("a")).toHaveLength(1);
    expect(ledger.getScopeObservations("a")[0]!.observation.idempotency_key).toBe("k1");
  });

  it("distinguishes 'audit' (mined, never blocked) from 'blocked' (authored, fails closed) enforcement records", () => {
    const ledger = new EvidenceLedger();
    ledger.recordScopeObservation(observation({ enforcement: "audit", idempotency_key: "mined" }));
    ledger.recordScopeObservation(observation({ enforcement: "blocked", idempotency_key: "authored" }));
    const records = ledger.getScopeObservations("campaign");
    expect(records.map((r) => r.observation.enforcement).sort()).toEqual(["audit", "blocked"]);
  });

  it("survives a JSONL round trip and keeps minting fresh ids after reload", () => {
    const first = new EvidenceLedger();
    // Y-2: a repeat with the same node/enforcement/path set folds instead of
    // minting a new record (see scope-observation-amendment.test.ts) -- use a
    // genuinely different out-of-scope path here so this test keeps proving
    // the id-minting/reload path, not the fold path.
    const firstId = first.recordScopeObservation(observation({ idempotency_key: "k1" }));
    const reloaded = new EvidenceLedger();
    reloaded.fromJSONL(first.toJSONL());
    const secondId = reloaded.recordScopeObservation(observation({ idempotency_key: "k2", observed_out_of_scope: ["lib/other.js"] }));
    expect(secondId).not.toBe(firstId);
    expect(reloaded.verifyIntegrity().valid).toBe(true);
  });

  it("validateScopeObservation requires at least one observed out-of-scope path and bounded path lists/bytes", () => {
    expect(() => validateScopeObservation(observation({ observed_out_of_scope: [] })))
      .toThrow(/at least one observed out-of-scope path/);
    expect(() => validateScopeObservation(observation({ declared: Array.from({ length: SCOPE_OBSERVATION_MAX_PATHS + 1 }, (_, i) => `p${i}`) })))
      .toThrow(/exceed/);
    expect(() => validateScopeObservation(observation({ declared: ["x".repeat(SCOPE_OBSERVATION_MAX_PATH_BYTES + 1)] })))
      .toThrow(/exceeds/);
    expect(() => validateScopeObservation(observation({ enforcement: "unknown" as never })))
      .toThrow(/enforcement must be audit or blocked/);
  });

  it("rejects the reserved 'governance' campaign id like every other record kind", () => {
    const ledger = new EvidenceLedger();
    expect(() => ledger.recordScopeObservation(observation({ campaign_id: "governance" }))).toThrow(/reserved/);
  });
});
