/**
 * Y-2 (ADR-066, scope-observation dedupe + escalation): the fold shape --
 * `ScopeObservationAmendmentRecord` mirrors `WaiverOutcomeAmendmentRecord`'s
 * append-then-fold pattern exactly. See `scope-observation.test.ts` for the
 * base `ScopeObservationRecord` coverage this file extends.
 */
import { describe, expect, it } from "vitest";
import {
  EvidenceLedger,
  validateScopeObservationAmendment,
  type ScopeObservationAmendmentInput,
  type ScopeObservationInput,
} from "../src/audit.js";

function observation(overrides: Partial<ScopeObservationInput> = {}): ScopeObservationInput {
  return {
    campaign_id: "campaign", node_id: "node-a",
    declared: ["test/decorator.test.js"], observed_out_of_scope: ["lib/decorator.js"],
    enforcement: "audit", idempotency_key: "result:1:scope", lineage_root: "lineage-root-1",
    ...overrides,
  };
}

function amendment(overrides: Partial<ScopeObservationAmendmentInput> = {}): ScopeObservationAmendmentInput {
  return { campaign_id: "campaign", node_id: "node-a", scope_observation_record_id: "scopeobs_1", kind: "folded", idempotency_key: "amend:1", ...overrides };
}

describe("scope observation folding (Y-2)", () => {
  it("folds a repeat whose out-of-scope set is a subset of an already-journaled observation in the same lineage_root", () => {
    const ledger = new EvidenceLedger();
    const firstId = ledger.recordScopeObservation(observation({ idempotency_key: "k1", node_id: "node-a", observed_out_of_scope: ["lib/decorator.js", "lib/other.js"] }));
    const secondId = ledger.recordScopeObservation(observation({ idempotency_key: "k2", node_id: "node-b", observed_out_of_scope: ["lib/decorator.js"] }));
    expect(secondId).toBe(firstId);
    expect(ledger.getScopeObservations("campaign")).toHaveLength(1);
    const amendments = ledger.getScopeObservationAmendments("campaign", firstId);
    expect(amendments).toHaveLength(1);
    expect(amendments[0]!.amendment).toMatchObject({ scope_observation_record_id: firstId, kind: "folded", idempotency_key: "k2" });
    expect(ledger.verifyIntegrity().valid).toBe(true);
  });

  it("exposes folded counts via getFoldedScopeObservations", () => {
    const ledger = new EvidenceLedger();
    ledger.recordScopeObservation(observation({ idempotency_key: "k1", observed_out_of_scope: ["a", "b", "c"] }));
    ledger.recordScopeObservation(observation({ idempotency_key: "k2", observed_out_of_scope: ["a"] }));
    ledger.recordScopeObservation(observation({ idempotency_key: "k3", observed_out_of_scope: ["b", "c"] }));
    const folded = ledger.getFoldedScopeObservations("campaign");
    expect(folded).toHaveLength(1);
    expect(folded[0]!.folded_count).toBe(3);
  });

  it("does NOT fold across different lineage_root values, even with identical out-of-scope paths", () => {
    const ledger = new EvidenceLedger();
    const firstId = ledger.recordScopeObservation(observation({ idempotency_key: "k1", lineage_root: "root-a" }));
    const secondId = ledger.recordScopeObservation(observation({ idempotency_key: "k2", lineage_root: "root-b" }));
    expect(secondId).not.toBe(firstId);
    expect(ledger.getScopeObservations("campaign")).toHaveLength(2);
  });

  it("defaults lineage_root to node_id when absent -- pre-Y-2 callers degrade to per-node grouping, not silent no-op", () => {
    const ledger = new EvidenceLedger();
    const firstId = ledger.recordScopeObservation(observation({ idempotency_key: "k1", node_id: "node-a", lineage_root: undefined }));
    const secondId = ledger.recordScopeObservation(observation({ idempotency_key: "k2", node_id: "node-b", lineage_root: undefined }));
    expect(secondId).not.toBe(firstId); // different node_id, no explicit lineage_root -> different default group
    const thirdId = ledger.recordScopeObservation(observation({ idempotency_key: "k3", node_id: "node-a", lineage_root: undefined }));
    expect(thirdId).toBe(firstId); // same node_id default group -> folds
  });

  it("a genuinely new (non-subset) out-of-scope path always mints a new record, never folds", () => {
    const ledger = new EvidenceLedger();
    const firstId = ledger.recordScopeObservation(observation({ idempotency_key: "k1", observed_out_of_scope: ["lib/a.js"] }));
    const secondId = ledger.recordScopeObservation(observation({ idempotency_key: "k2", observed_out_of_scope: ["lib/b.js"] }));
    expect(secondId).not.toBe(firstId);
    expect(ledger.getScopeObservations("campaign")).toHaveLength(2);
  });

  it("recordScopeObservationAmendment is idempotent on idempotency_key and rejects a conflicting repeat", () => {
    const ledger = new EvidenceLedger();
    const recordId = ledger.recordScopeObservation(observation({ idempotency_key: "base" }));
    const id = ledger.recordScopeObservationAmendment(amendment({ scope_observation_record_id: recordId }));
    expect(id).toMatch(/^scopeobsamend_/);
    expect(ledger.recordScopeObservationAmendment(amendment({ scope_observation_record_id: recordId }))).toBe(id);
    expect(() => ledger.recordScopeObservationAmendment(amendment({ scope_observation_record_id: recordId, node_id: "different-node" })))
      .toThrow(/conflicting scope observation amendment/);
  });

  it("recordScopeObservationAmendment rejects an amendment referencing an unknown scope observation record", () => {
    const ledger = new EvidenceLedger();
    expect(() => ledger.recordScopeObservationAmendment(amendment({ scope_observation_record_id: "scopeobs_nonexistent" })))
      .toThrow(/unknown scope observation record/);
  });

  it("validateScopeObservationAmendment requires campaign, node, scope_observation_record_id, idempotency, and kind === 'folded'", () => {
    expect(() => validateScopeObservationAmendment(amendment({ campaign_id: "" }))).toThrow(/requires campaign/);
    expect(() => validateScopeObservationAmendment(amendment({ kind: "other" as never }))).toThrow(/must be folded/);
    expect(() => validateScopeObservationAmendment(amendment({ timestamp: "not-a-date" }))).toThrow(/ISO-parseable/);
  });

  it("survives a JSONL round trip and keeps minting fresh scopeobsamend_ ids after reload", () => {
    const first = new EvidenceLedger();
    const recordId = first.recordScopeObservation(observation({ idempotency_key: "base" }));
    const firstAmendId = first.recordScopeObservationAmendment(amendment({ scope_observation_record_id: recordId, idempotency_key: "amend-a" }));
    const reloaded = new EvidenceLedger();
    reloaded.fromJSONL(first.toJSONL());
    const secondAmendId = reloaded.recordScopeObservationAmendment(amendment({ scope_observation_record_id: recordId, idempotency_key: "amend-b" }));
    expect(secondAmendId).not.toBe(firstAmendId);
    expect(reloaded.verifyIntegrity().valid).toBe(true);
  });

  it("verifyIntegrity rejects an amendment forged to reference a record from a different campaign", () => {
    const ledger = new EvidenceLedger();
    const recordId = ledger.recordScopeObservation(observation({ campaign_id: "camp-a", idempotency_key: "base" }));
    ledger.recordScopeObservation(observation({ campaign_id: "camp-b", idempotency_key: "other" }));
    expect(() => ledger.recordScopeObservationAmendment(amendment({ campaign_id: "camp-b", scope_observation_record_id: recordId })))
      .toThrow(/unknown scope observation record/);
  });
});
