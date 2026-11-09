/**
 * reserved-campaign-guard.test.ts — ADR-027 Decision point 2's reserved
 * campaign id, proven three ways per the implementation brief:
 *
 *   1. an ordinary write to campaign_id "governance" is refused, across
 *      every mutating method that accepts a caller-supplied campaign_id —
 *      not just `record()`;
 *   2. the legitimate writer (`recordGovernanceEvent`) still works, and its
 *      output round-trips through `saveLedger`/`loadLedger` at the exact
 *      path ADR-027 names (`<dir>/audit/governance.jsonl`);
 *   3. an ordinary campaign id is completely unaffected by the guard.
 *
 * Before this guard, "governance" was reserved in ADR-027's prose only —
 * nothing in EvidenceLedger enforced it, so a real campaign literally named
 * "governance" would silently collide with the governance event stream.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuditIntegrityError,
  EvidenceLedger,
  saveLedger,
  loadLedger,
} from "../src/index.js";
import type { Provenance, NodeState, GateRecord } from "@arbor/core";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "arbor-audit-governance-guard-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makePacket(overrides: Record<string, unknown> = {}) {
  return {
    campaign_id: "camp1",
    node_id: "node_1",
    timestamp: "2026-08-05T00:00:00.000Z",
    action_description: "test action",
    action_category: "test",
    specialist_agent: "seed",
    critic_agent: null,
    node_state_before: "pending" as NodeState,
    node_state_after: "verified" as NodeState,
    provenance: { tag: "claimed", claimant: "seed" } as Provenance,
    specialist_output: null,
    critic_verdict_approved: null,
    critic_root_cause: null,
    score_before: 0,
    score_after: 1,
    gates: [] as GateRecord[],
    kb_entries_written: [] as string[],
    ...overrides,
  };
}

function governanceGate(): GateRecord {
  return { gate: "admission", result: "pass", checked_at: "2026-08-05T00:00:00.000Z", detail: "ok" };
}

describe("ADR-027 reserved campaign_id guard — an ordinary write to \"governance\" is refused", () => {
  it("record() refuses campaign_id \"governance\"", () => {
    const ledger = new EvidenceLedger();
    expect(() => ledger.record(makePacket({ campaign_id: "governance" }))).toThrow(AuditIntegrityError);
    expect(() => ledger.record(makePacket({ campaign_id: "governance" }))).toThrow(/reserved/);
  });

  it("recordGateCheckpoint refuses campaign_id \"governance\"", () => {
    const ledger = new EvidenceLedger();
    expect(() => ledger.recordGateCheckpoint({
      campaign_id: "governance", node_id: "n1", transition: "campaign_start",
      operation_id: "op1", gate: governanceGate(),
    })).toThrow(AuditIntegrityError);
  });

  it("recordTelemetryObservation refuses campaign_id \"governance\"", () => {
    const ledger = new EvidenceLedger();
    expect(() => ledger.recordTelemetryObservation({
      campaign_id: "governance", node_id: "n1", operation_id: "op1", epoch: 1,
      phase: "select", outcome: "success", type: "phase_timing", duration_ms: 10,
      source_evidence_id: "trace_1", idempotency_key: "k1",
      provenance: { tag: "claimed", claimant: "seed" },
    })).toThrow(AuditIntegrityError);
  });

  it("recordMemoryFact refuses campaign_id \"governance\"", () => {
    const ledger = new EvidenceLedger();
    expect(() => ledger.recordMemoryFact({
      campaign_id: "governance", node_id: "n1", scope: { kind: "campaign" }, type: "success_pattern",
      content: "x", provenance: { tag: "claimed", claimant: "seed" }, tier: "specialist_visible",
      source_evidence_id: "trace_1", idempotency_key: "k1", tags: [],
    })).toThrow(AuditIntegrityError);
  });

  it("recordPhaseMessage refuses campaign_id \"governance\"", () => {
    const ledger = new EvidenceLedger();
    expect(() => ledger.recordPhaseMessage({
      campaign_id: "governance", node_id: "n1", operation_id: "op1", phase: "commentary",
      content: "hi", content_length_bytes: 2, provenance: { tag: "claimed", claimant: "seed" },
      idempotency_key: "k1",
    })).toThrow(AuditIntegrityError);
  });

  it("recordRecoveryDecision refuses campaign_id \"governance\"", () => {
    const ledger = new EvidenceLedger();
    expect(() => ledger.recordRecoveryDecision({
      campaign_id: "governance", node_id: "n1", recovery_operation_id: "rop1", decision: "retry",
      actor: "operator", authority: "operator", reason: "x", prior_operation_id: null,
      new_operation_id: null, expected_version: null, observed_version: "v1",
      lease: { previous: "unknown", new_lease_id: null },
      isolation: { result: "not_checked", checkpoint_operation_id: null, evidence_deficit: null },
      outcome: "planned",
    })).toThrow(AuditIntegrityError);
  });
});

describe("ADR-027 reserved campaign_id guard — the legitimate writer still works", () => {
  it("recordGovernanceEvent writes under campaign_id \"governance\" without exposing it as a parameter", () => {
    const ledger = new EvidenceLedger();
    const id = ledger.recordGovernanceEvent(makePacket({
      action_category: "policy_finding_observed",
      action_description: "POL-04: revoy2:ADR-001 accepted with zero obligations",
    }) as Omit<Parameters<EvidenceLedger["record"]>[0], "campaign_id">);
    expect(id).toMatch(/^trace_/);
    const campaign = ledger.getCampaign("governance");
    expect(campaign).toHaveLength(1);
    expect(campaign[0].campaign_id).toBe("governance");
    expect(campaign[0].action_category).toBe("policy_finding_observed");
  });

  it("round-trips through saveLedger/loadLedger at <dir>/audit/governance.jsonl", () => {
    const ledger = new EvidenceLedger();
    ledger.recordGovernanceEvent(makePacket({ idempotency_key: "gov-k1" }) as Omit<Parameters<EvidenceLedger["record"]>[0], "campaign_id">);
    saveLedger(ledger, tempDir, "governance");

    const expectedPath = join(tempDir, "audit", "governance.jsonl");
    expect(existsSync(expectedPath)).toBe(true);

    const reloaded = loadLedger(tempDir, "governance");
    expect(reloaded.getCampaign("governance")).toHaveLength(1);
    expect(reloaded.verifyIntegrity().valid).toBe(true);
  });

  it("is idempotent by key across repeated governance writes, exactly like the generic record() path", () => {
    const ledger = new EvidenceLedger();
    const packet = makePacket({ idempotency_key: "gov-dup" }) as Omit<Parameters<EvidenceLedger["record"]>[0], "campaign_id">;
    const first = ledger.recordGovernanceEvent(packet);
    const second = ledger.recordGovernanceEvent({ ...packet, timestamp: "2026-08-05T01:00:00.000Z" });
    expect(second).toBe(first);
    expect(ledger.getCampaign("governance")).toHaveLength(1);
  });
});

describe("ADR-027 reserved campaign_id guard — an ordinary campaign id is unaffected", () => {
  it("record() still works for a normal campaign id", () => {
    const ledger = new EvidenceLedger();
    expect(() => ledger.record(makePacket({ campaign_id: "camp1" }))).not.toThrow();
    expect(ledger.getCampaign("camp1")).toHaveLength(1);
  });

  it("recordTelemetryObservation still works for a normal campaign id", () => {
    const ledger = new EvidenceLedger();
    const traceId = ledger.record(makePacket({ campaign_id: "camp1" }));
    expect(() => ledger.recordTelemetryObservation({
      campaign_id: "camp1", node_id: "n1", operation_id: "op1", epoch: 1,
      phase: "select", outcome: "success", type: "phase_timing", duration_ms: 10,
      source_evidence_id: traceId, idempotency_key: "k1",
      provenance: { tag: "claimed", claimant: "seed" },
    })).not.toThrow();
  });

  it("a campaign id that merely CONTAINS \"governance\" is not reserved — only an exact match is", () => {
    const ledger = new EvidenceLedger();
    expect(() => ledger.record(makePacket({ campaign_id: "governance-2" }))).not.toThrow();
    expect(() => ledger.record(makePacket({ campaign_id: "my-governance" }))).not.toThrow();
  });
});
