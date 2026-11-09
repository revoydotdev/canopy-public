/**
 * Y-2 (ADR-068): `sweepLedgerAudit`'s five deterministic cross-record checks.
 * Each check gets a fixture that fires it and a fixture that stays clean.
 */
import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { canonicalizeForHash } from "@arbor/core";
import { EvidenceLedger, scopeDecisionSigningPayload, type AuditRecord, type ScopeDecisionRecord, type TracePacket } from "../src/audit.js";
import { sweepLedgerAudit } from "../src/ledger-audit-sweep.js";

/** A REAL, correctly-signed scope_decision record -- built through `EvidenceLedger.recordScopeDecision` so the signature is genuine. */
function realScopeDecision(): ScopeDecisionRecord {
  const ledger = new EvidenceLedger();
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const previousRecordContentHash = ledger.getLedgerTip(CAMPAIGN);
  const payload = scopeDecisionSigningPayload({
    campaign_id: CAMPAIGN, node_id: "node-a", paths: ["lib/a.js"], decision: "approved_widening",
    parent_decision_id: null, previous_record_content_hash: previousRecordContentHash,
  });
  const signature = sign(null, Buffer.from(canonicalizeForHash(payload), "utf8"), keys.privateKey).toString("base64");
  const id = ledger.recordScopeDecision({
    campaign_id: CAMPAIGN, node_id: "node-a", paths: ["lib/a.js"], decision: "approved_widening",
    decided_by: "operator", parent_decision_id: null, public_key: publicKey, signature,
    idempotency_key: "scopedec:1", previous_record_content_hash: previousRecordContentHash,
  });
  return ledger.getScopeDecisions(CAMPAIGN).find((record) => record.id === id)!;
}

const CAMPAIGN = "camp1";

function trace(overrides: Partial<TracePacket> = {}): TracePacket {
  return {
    kind: "trace",
    id: overrides.id ?? "trace_1",
    previous_hash: null,
    content_hash: "hash",
    campaign_id: CAMPAIGN,
    node_id: "node-a",
    timestamp: "2026-08-01T00:00:00.000Z",
    action_description: "do it",
    action_category: "testing",
    specialist_agent: "seed",
    critic_agent: "lenticel",
    node_state_before: "expanding",
    node_state_after: "verified",
    provenance: { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:x" },
    specialist_output: "done",
    critic_verdict_approved: true,
    critic_root_cause: null,
    score_before: 0,
    score_after: 1,
    gates: [],
    kb_entries_written: [],
    ...overrides,
  };
}

function raceOutcome(overrides: Record<string, unknown> = {}): AuditRecord {
  return {
    kind: "telemetry_observation",
    id: overrides.id as string ?? "telemetry_race",
    previous_hash: null,
    content_hash: "hash",
    campaign_id: CAMPAIGN,
    node_id: (overrides.node_id as string) ?? "node-a",
    timestamp: "2026-08-01T00:01:00.000Z",
    observation: {
      operation_id: "op:race",
      epoch: 1,
      type: "race_outcome",
      phase: "expand",
      outcome: "success",
      source_evidence_id: "telemetry_seed",
      idempotency_key: "race:1",
      provenance: { tag: "generated", generator: "test", input_hash: "h" },
      forked_at_ms: 20000,
      winner: "primary",
      loser_wall_ms: 10000,
      cancelled: true,
      ...overrides,
    },
  } as AuditRecord;
}

function usageCost(nodeId: string, phase: "expand" | "critic", id: string): AuditRecord {
  return {
    kind: "telemetry_observation",
    id,
    previous_hash: null,
    content_hash: "hash",
    campaign_id: CAMPAIGN,
    node_id: nodeId,
    timestamp: "2026-08-01T00:00:30.000Z",
    observation: {
      operation_id: `op:${phase}`,
      epoch: 1,
      type: "usage_cost",
      phase,
      outcome: "success",
      source_evidence_id: "telemetry_seed",
      idempotency_key: `cost:${id}`,
      provenance: { tag: "generated", generator: "test", input_hash: "h" },
      provider: "other",
      model_family: "other",
      input_tokens: 1,
      output_tokens: 1,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost: { kind: "unpriced", reason: "test" },
    },
  } as AuditRecord;
}

function scopeObservation(overrides: Record<string, unknown> = {}): AuditRecord {
  return {
    kind: "scope_observation",
    id: overrides.id as string ?? "scopeobs_1",
    previous_hash: null,
    content_hash: "hash",
    campaign_id: CAMPAIGN,
    node_id: (overrides.node_id as string) ?? "node-a",
    timestamp: (overrides.timestamp as string) ?? "2026-08-01T00:00:00.000Z",
    observation: {
      declared: [],
      observed_out_of_scope: ["lib/leak.js"],
      enforcement: "audit",
      idempotency_key: overrides.id as string ?? "scope:1",
      ...overrides,
    },
  } as AuditRecord;
}

function phaseTiming(nodeId: string, phase: "select" | "expand" | "critic" | "gate" | "backprop", id: string): AuditRecord {
  return {
    kind: "telemetry_observation",
    id,
    previous_hash: null,
    content_hash: "hash",
    campaign_id: CAMPAIGN,
    node_id: nodeId,
    timestamp: "2026-08-01T00:00:10.000Z",
    observation: {
      operation_id: `op:${phase}`,
      epoch: 1,
      type: "phase_timing",
      phase,
      outcome: "success",
      source_evidence_id: "telemetry_seed",
      idempotency_key: `timing:${id}`,
      provenance: { tag: "generated", generator: "test", input_hash: "h" },
      duration_ms: 100,
    },
  } as AuditRecord;
}

function waiverOutcome(id: string, waivedAt: string): AuditRecord {
  return {
    kind: "waiver_outcome",
    id,
    previous_hash: null,
    content_hash: "hash",
    campaign_id: CAMPAIGN,
    node_id: "node-a",
    timestamp: waivedAt,
    outcome: {
      task_category: "testing",
      waived_by: "arbiter",
      waived_reason: "low risk",
      waived_at: waivedAt,
      idempotency_key: `waiver:${id}`,
    },
  } as AuditRecord;
}

function waiverAdoption(id: string, waiverRecordId: string): AuditRecord {
  return {
    kind: "waiver_outcome_amendment",
    id,
    previous_hash: null,
    content_hash: "hash",
    campaign_id: CAMPAIGN,
    node_id: "node-a",
    timestamp: "2026-08-02T00:00:00.000Z",
    amendment: {
      waiver_record_id: waiverRecordId,
      kind: "adopted",
      value: true,
      recorded_by: "operator",
      reason: "reviewed",
      idempotency_key: `adopt:${id}`,
    },
  } as AuditRecord;
}

function advisoryEvidence(id: string, sourceEvidenceId: string): AuditRecord {
  return {
    kind: "advisory_evidence",
    id,
    previous_hash: null,
    content_hash: "hash",
    campaign_id: CAMPAIGN,
    node_id: "node-a",
    timestamp: "2026-08-01T00:02:00.000Z",
    evidence: {
      generator: "sibling_scan",
      activity: "scan",
      payload: "finding",
      payload_truncated: false,
      source_evidence_id: sourceEvidenceId,
      idempotency_key: `advisory:${id}`,
    },
  } as AuditRecord;
}

describe("sweepLedgerAudit", () => {
  describe("(a) unaccounted_race_loser", () => {
    it("fires when a cancelled fork/primary win has only one specialist usage_cost row and no reason", () => {
      const records = [trace(), raceOutcome(), usageCost("node-a", "expand", "cost_specialist"), usageCost("node-a", "critic", "cost_critic")];
      const findings = sweepLedgerAudit(records, CAMPAIGN);
      expect(findings.filter((f) => f.check === "unaccounted_race_loser")).toHaveLength(1);
    });

    it("stays clean when the reason field is present (real bench v5c shape)", () => {
      const records = [trace(), raceOutcome({ loser_usage_unavailable_reason: "Claude Code call aborted" }), usageCost("node-a", "expand", "cost_specialist")];
      expect(sweepLedgerAudit(records, CAMPAIGN).filter((f) => f.check === "unaccounted_race_loser")).toHaveLength(0);
    });

    it("stays clean when a second specialist usage_cost row was actually journaled", () => {
      const records = [trace(), raceOutcome(), usageCost("node-a", "expand", "cost_1"), usageCost("node-a", "expand", "cost_2")];
      expect(sweepLedgerAudit(records, CAMPAIGN).filter((f) => f.check === "unaccounted_race_loser")).toHaveLength(0);
    });

    it("stays clean when the race was never cancelled", () => {
      const records = [trace(), raceOutcome({ cancelled: false }), usageCost("node-a", "expand", "cost_1")];
      expect(sweepLedgerAudit(records, CAMPAIGN).filter((f) => f.check === "unaccounted_race_loser")).toHaveLength(0);
    });
  });

  describe("(b) scope_escalation_downgrade", () => {
    it("fires when a blocked observation is followed by an audit observation for the same path/lineage", () => {
      const records = [
        scopeObservation({ id: "scopeobs_1", enforcement: "blocked", lineage_root: "root", timestamp: "2026-08-01T00:00:00.000Z" }),
        scopeObservation({ id: "scopeobs_2", enforcement: "audit", lineage_root: "root", timestamp: "2026-08-01T00:01:00.000Z" }),
      ];
      const findings = sweepLedgerAudit(records, CAMPAIGN);
      expect(findings.filter((f) => f.check === "scope_escalation_downgrade")).toHaveLength(1);
      expect(findings[0]!.record_id).toBe("scopeobs_2");
    });

    it("stays clean when both observations are audit-tier (real bench shape: every observed scope_observation is audit)", () => {
      const records = [
        scopeObservation({ id: "scopeobs_1", enforcement: "audit", lineage_root: "root" }),
        scopeObservation({ id: "scopeobs_2", enforcement: "audit", lineage_root: "root" }),
      ];
      expect(sweepLedgerAudit(records, CAMPAIGN).filter((f) => f.check === "scope_escalation_downgrade")).toHaveLength(0);
    });

    it("stays clean when the audit observation belongs to a different lineage", () => {
      const records = [
        scopeObservation({ id: "scopeobs_1", enforcement: "blocked", lineage_root: "root-a" }),
        scopeObservation({ id: "scopeobs_2", enforcement: "audit", lineage_root: "root-b" }),
      ];
      expect(sweepLedgerAudit(records, CAMPAIGN).filter((f) => f.check === "scope_escalation_downgrade")).toHaveLength(0);
    });
  });

  describe("(c) unwitnessed_command_execution", () => {
    it("fires when a command_executed-strength trace has no critic phase_timing", () => {
      const records = [trace({ provenance: { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:x", strength: "command_executed" } })];
      expect(sweepLedgerAudit(records, CAMPAIGN).filter((f) => f.check === "unwitnessed_command_execution")).toHaveLength(1);
    });

    it("stays clean when a critic phase_timing record exists for the node", () => {
      const records = [
        trace({ provenance: { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:x", strength: "command_executed" } }),
        phaseTiming("node-a", "critic", "timing_critic"),
      ];
      expect(sweepLedgerAudit(records, CAMPAIGN).filter((f) => f.check === "unwitnessed_command_execution")).toHaveLength(0);
    });

    it("stays clean for outputs_check strength (real bench shape: no command_executed trace observed in ab3)", () => {
      const records = [trace({ provenance: { tag: "verified", cmd: "declared-outputs-check", exit: 0, stdout_hash: "sha256:x", strength: "outputs_check" } })];
      expect(sweepLedgerAudit(records, CAMPAIGN).filter((f) => f.check === "unwitnessed_command_execution")).toHaveLength(0);
    });
  });

  describe("(d) unadopted_waiver", () => {
    it("fires (info) for a waiver older than the threshold with no adoption amendment", () => {
      const records = [waiverOutcome("waiver_1", "2026-01-01T00:00:00.000Z")];
      const findings = sweepLedgerAudit(records, CAMPAIGN, { now: () => Date.parse("2026-08-01T00:00:00.000Z") });
      const matches = findings.filter((f) => f.check === "unadopted_waiver");
      expect(matches).toHaveLength(1);
      expect(matches[0]!.severity).toBe("info");
    });

    it("stays clean when the waiver has an adoption amendment", () => {
      const records = [waiverOutcome("waiver_1", "2026-01-01T00:00:00.000Z"), waiverAdoption("amend_1", "waiver_1")];
      const findings = sweepLedgerAudit(records, CAMPAIGN, { now: () => Date.parse("2026-08-01T00:00:00.000Z") });
      expect(findings.filter((f) => f.check === "unadopted_waiver")).toHaveLength(0);
    });

    it("stays clean when the waiver is younger than the threshold", () => {
      const records = [waiverOutcome("waiver_1", "2026-07-31T00:00:00.000Z")];
      const findings = sweepLedgerAudit(records, CAMPAIGN, { now: () => Date.parse("2026-08-01T00:00:00.000Z") });
      expect(findings.filter((f) => f.check === "unadopted_waiver")).toHaveLength(0);
    });
  });

  describe("(e) unresolved_advisory_witness", () => {
    it("fires (defensive) when source_evidence_id does not resolve in the campaign", () => {
      const records = [advisoryEvidence("advisory_1", "trace_missing")];
      const findings = sweepLedgerAudit(records, CAMPAIGN);
      expect(findings.filter((f) => f.check === "unresolved_advisory_witness")).toHaveLength(1);
    });

    it("stays clean when the witness resolves", () => {
      const records = [trace({ id: "trace_1" }), advisoryEvidence("advisory_1", "trace_1")];
      expect(sweepLedgerAudit(records, CAMPAIGN).filter((f) => f.check === "unresolved_advisory_witness")).toHaveLength(0);
    });
  });

  describe("(f) forged_scope_decision", () => {
    it("fires on a hand-forged signature (bad signature bytes)", () => {
      const real = realScopeDecision();
      const forged: AuditRecord = { ...real, decision: { ...real.decision, signature: Buffer.from("not a real signature").toString("base64") } };
      const findings = sweepLedgerAudit([forged], CAMPAIGN);
      expect(findings.filter((f) => f.check === "forged_scope_decision")).toHaveLength(1);
    });

    it("fires when a public_key does not match its parent hop's generation key", () => {
      const genesis = realScopeDecision();
      const otherKeys = generateKeyPairSync("ed25519");
      const otherPublicKey = otherKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
      const payload = scopeDecisionSigningPayload({
        campaign_id: CAMPAIGN, node_id: "node-a", paths: ["lib/a.js"], decision: "revoked",
        parent_decision_id: genesis.id, previous_record_content_hash: genesis.content_hash,
      });
      const signature = sign(null, Buffer.from(canonicalizeForHash(payload), "utf8"), otherKeys.privateKey).toString("base64");
      const forgedChild: AuditRecord = {
        kind: "scope_decision", id: "scopedec_forged", previous_hash: genesis.content_hash, content_hash: "hash",
        campaign_id: CAMPAIGN, node_id: "node-a", timestamp: "2026-08-01T00:03:00.000Z",
        decision: {
          paths: ["lib/a.js"], decision: "revoked", decided_by: "operator", parent_decision_id: genesis.id,
          public_key: otherPublicKey, signature, idempotency_key: "scopedec:forged",
        },
      } as AuditRecord;
      const findings = sweepLedgerAudit([genesis, forgedChild], CAMPAIGN);
      expect(findings.filter((f) => f.check === "forged_scope_decision")).toHaveLength(1);
    });

    it("stays clean for a legitimate, correctly-signed chain", () => {
      const genesis = realScopeDecision();
      const findings = sweepLedgerAudit([genesis], CAMPAIGN);
      expect(findings.filter((f) => f.check === "forged_scope_decision")).toHaveLength(0);
    });
  });

  it("a fully clean campaign produces no findings across all six checks", () => {
    const records = [
      trace({ id: "trace_1", provenance: { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:x", strength: "command_executed" } }),
      phaseTiming("node-a", "critic", "timing_critic"),
      usageCost("node-a", "expand", "cost_1"),
      raceOutcome({ cancelled: false }),
      scopeObservation({ id: "scopeobs_1", enforcement: "audit", lineage_root: "root" }),
      waiverOutcome("waiver_1", "2026-08-01T00:00:00.000Z"),
      advisoryEvidence("advisory_1", "trace_1"),
      realScopeDecision(),
    ];
    expect(sweepLedgerAudit(records, CAMPAIGN, { now: () => Date.parse("2026-08-01T00:00:00.000Z") })).toEqual([]);
  });
});
