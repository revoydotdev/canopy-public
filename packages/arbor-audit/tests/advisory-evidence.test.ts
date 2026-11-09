import { describe, expect, it } from "vitest";
import {
  ADVISORY_EVIDENCE_MAX_ACTIVITY_BYTES,
  ADVISORY_EVIDENCE_MAX_PAYLOAD_BYTES,
  EvidenceLedger,
  type AdvisoryEvidenceInput,
  validateAdvisoryEvidence,
} from "../src/audit.js";

function seedTrace(ledger: EvidenceLedger, campaignId = "campaign", nodeId = "node-a"): string {
  return ledger.record({
    campaign_id: campaignId,
    node_id: nodeId,
    timestamp: new Date().toISOString(),
    action_description: "seed",
    action_category: "test",
    specialist_agent: "specialist",
    critic_agent: null,
    node_state_before: "expanding",
    node_state_after: "expanding",
    provenance: null,
    specialist_output: null,
    critic_verdict_approved: null,
    critic_root_cause: null,
    score_before: 0,
    score_after: 0,
    gates: [],
    kb_entries_written: [],
  });
}

function evidence(overrides: Partial<AdvisoryEvidenceInput> = {}): Omit<AdvisoryEvidenceInput, "source_evidence_id"> & { source_evidence_id?: string } {
  return {
    campaign_id: "campaign",
    node_id: "node-a",
    generator: "sibling_scan",
    activity: "sibling scan of adjacent files",
    payload: "3 mutants survived at lib/decorate.js:12",
    idempotency_key: "k1",
    ...overrides,
  };
}

describe("AdvisoryEvidence audit evidence (Y-1, ADR-068)", () => {
  it("recordAdvisoryEvidence appends a hash-chained record witnessed by prior evidence, and is idempotent on the same idempotency_key", () => {
    const ledger = new EvidenceLedger();
    const traceId = seedTrace(ledger);
    const id = ledger.recordAdvisoryEvidence(evidence({ source_evidence_id: traceId }) as AdvisoryEvidenceInput);
    expect(id).toMatch(/^advisory_/);
    expect(ledger.recordAdvisoryEvidence(evidence({ source_evidence_id: traceId }) as AdvisoryEvidenceInput)).toBe(id);
    expect(() => ledger.recordAdvisoryEvidence(evidence({ source_evidence_id: traceId, activity: "different activity" }) as AdvisoryEvidenceInput))
      .toThrow(/conflicting advisory evidence/);
    expect(ledger.verifyIntegrity().valid).toBe(true);
  });

  it("refuses advisory evidence whose source_evidence_id does not resolve to prior evidence in the campaign", () => {
    const ledger = new EvidenceLedger();
    expect(() => ledger.recordAdvisoryEvidence(evidence({ source_evidence_id: "nonexistent" }) as AdvisoryEvidenceInput))
      .toThrow(/not prior evidence/);
  });

  it("refuses a forward or cross-campaign witness", () => {
    const ledger = new EvidenceLedger();
    const otherTraceId = seedTrace(ledger, "other-campaign", "node-b");
    expect(() => ledger.recordAdvisoryEvidence(evidence({ source_evidence_id: otherTraceId }) as AdvisoryEvidenceInput))
      .toThrow(/not prior evidence/);
  });

  it("getAdvisoryEvidence returns only records for the requested campaign", () => {
    const ledger = new EvidenceLedger();
    const traceA = seedTrace(ledger, "a", "node-a");
    const traceB = seedTrace(ledger, "b", "node-b");
    ledger.recordAdvisoryEvidence(evidence({ campaign_id: "a", node_id: "node-a", source_evidence_id: traceA, idempotency_key: "k1" }) as AdvisoryEvidenceInput);
    ledger.recordAdvisoryEvidence(evidence({ campaign_id: "b", node_id: "node-b", source_evidence_id: traceB, idempotency_key: "k2" }) as AdvisoryEvidenceInput);
    expect(ledger.getAdvisoryEvidence("a")).toHaveLength(1);
    expect(ledger.getAdvisoryEvidence("a")[0]!.evidence.idempotency_key).toBe("k1");
  });

  it("caps payload at ADVISORY_EVIDENCE_MAX_PAYLOAD_BYTES, marking payload_truncated rather than throwing", () => {
    const ledger = new EvidenceLedger();
    const traceId = seedTrace(ledger);
    const oversized = "x".repeat(ADVISORY_EVIDENCE_MAX_PAYLOAD_BYTES + 500);
    const id = ledger.recordAdvisoryEvidence(evidence({ source_evidence_id: traceId, payload: oversized, idempotency_key: "oversized" }) as AdvisoryEvidenceInput);
    const record = ledger.getAdvisoryEvidence("campaign").find((r) => r.id === id)!;
    expect(record.evidence.payload_truncated).toBe(true);
    expect(Buffer.byteLength(record.evidence.payload, "utf8")).toBeLessThanOrEqual(ADVISORY_EVIDENCE_MAX_PAYLOAD_BYTES);
  });

  it("does not truncate a payload within the cap", () => {
    const ledger = new EvidenceLedger();
    const traceId = seedTrace(ledger);
    const id = ledger.recordAdvisoryEvidence(evidence({ source_evidence_id: traceId, idempotency_key: "small" }) as AdvisoryEvidenceInput);
    const record = ledger.getAdvisoryEvidence("campaign").find((r) => r.id === id)!;
    expect(record.evidence.payload_truncated).toBe(false);
    expect(record.evidence.payload).toBe(evidence().payload);
  });

  it("truncation never splits a multi-byte UTF-8 character", () => {
    const ledger = new EvidenceLedger();
    const traceId = seedTrace(ledger);
    // Every character is a 3-byte UTF-8 code point; the cap (8192) is not a
    // multiple of 3, so a naive byte slice would corrupt the boundary char.
    const oversized = "☃".repeat(3000);
    const id = ledger.recordAdvisoryEvidence(evidence({ source_evidence_id: traceId, payload: oversized, idempotency_key: "multibyte" }) as AdvisoryEvidenceInput);
    const record = ledger.getAdvisoryEvidence("campaign").find((r) => r.id === id)!;
    expect(record.evidence.payload_truncated).toBe(true);
    // Round-trips through UTF-8 with no replacement characters.
    expect(record.evidence.payload).not.toContain("�");
    expect(Buffer.byteLength(record.evidence.payload, "utf8")).toBeLessThanOrEqual(ADVISORY_EVIDENCE_MAX_PAYLOAD_BYTES);
  });

  it("validateAdvisoryEvidence rejects an unknown generator, an oversized activity, and a non-ISO timestamp", () => {
    expect(() => validateAdvisoryEvidence(evidence({ generator: "unknown" as never, source_evidence_id: "t" }) as AdvisoryEvidenceInput))
      .toThrow(/generator must be one of/);
    expect(() => validateAdvisoryEvidence(evidence({ activity: "a".repeat(ADVISORY_EVIDENCE_MAX_ACTIVITY_BYTES + 1), source_evidence_id: "t" }) as AdvisoryEvidenceInput))
      .toThrow(/activity exceeds/);
    expect(() => validateAdvisoryEvidence(evidence({ timestamp: "not-a-date", source_evidence_id: "t" }) as AdvisoryEvidenceInput))
      .toThrow(/timestamp must be ISO-parseable/);
  });

  it("survives a JSONL round trip and keeps minting fresh ids after reload", () => {
    const first = new EvidenceLedger();
    const traceId = seedTrace(first);
    const firstId = first.recordAdvisoryEvidence(evidence({ source_evidence_id: traceId, idempotency_key: "k1" }) as AdvisoryEvidenceInput);
    const reloaded = new EvidenceLedger();
    reloaded.fromJSONL(first.toJSONL());
    const secondId = reloaded.recordAdvisoryEvidence(evidence({ source_evidence_id: traceId, idempotency_key: "k2" }) as AdvisoryEvidenceInput);
    expect(secondId).not.toBe(firstId);
    expect(reloaded.verifyIntegrity().valid).toBe(true);
  });

  it("rejects the reserved 'governance' campaign id like every other record kind", () => {
    const ledger = new EvidenceLedger();
    expect(() => ledger.recordAdvisoryEvidence(evidence({ campaign_id: "governance", source_evidence_id: "t" }) as AdvisoryEvidenceInput)).toThrow(/reserved/);
  });
});
