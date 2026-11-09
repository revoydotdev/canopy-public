import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuditIntegrityError,
  EvidenceLedger,
  saveLedger,
  loadLedger,
  loadLedgerResult,
  persistGateCheckpoint,
  persistRecoveryDecision,
} from "../src/index.js";
import type { Provenance, NodeState, GateRecord } from "@arbor/core";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "arbor-audit-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makePacket(overrides: Record<string, unknown> = {}) {
  return {
    campaign_id: "camp1",
    node_id: "node_1",
    timestamp: new Date().toISOString(),
    action_description: "test action",
    action_category: "test",
    specialist_agent: "seed",
    critic_agent: "lenticel",
    node_state_before: "expanding" as NodeState,
    node_state_after: "verified" as NodeState,
    provenance: { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test"} as Provenance,
    specialist_output: "done",
    critic_verdict_approved: true,
    critic_root_cause: null,
    score_before: 0,
    score_after: 42,
    gates: [] as GateRecord[],
    kb_entries_written: ["kb_1"],
    ...overrides,
  };
}

describe("saveLedger + loadLedger", () => {
  it("persists and verifies linked interruption phases and detects tampering", () => {
    const ledger = new EvidenceLedger();
    const partialEvidenceId = ledger.record(makePacket({ node_id: "node_1", specialist_output: "partial artifact" }));
    const common = {
      campaign_id: "camp1", node_id: "node_1", operation_id: "interrupt-1", scope: "subtree" as const,
      affected_node_ids: ["node_1", "node_2"], partial_evidence_ids: [partialEvidenceId],
      provenance: { tag: "claimed", claimant: "operator" } as Provenance, reason: "operator stop",
    };
    expect(() => ledger.recordInterruption({ ...common, operation_id: "missing-evidence", partial_evidence_ids: ["future"], phase: "requested", request_record_id: null })).toThrow("not prior same-campaign evidence");
    const requestId = ledger.recordInterruption({ ...common, phase: "requested", request_record_id: null });
    expect(ledger.recordInterruption({ ...common, phase: "requested", request_record_id: null })).toBe(requestId);
    expect(() => ledger.recordInterruption({ ...common, scope: "node", phase: "requested", request_record_id: null })).toThrow("conflicting interruption");
    expect(() => ledger.recordInterruption({ ...common, phase: "state_applied", request_record_id: requestId })).toThrow("prior acknowledgement");
    expect(() => ledger.recordInterruption({ ...common, reason: "x".repeat(16 * 1024 + 1), phase: "acknowledged", request_record_id: requestId })).toThrow("bounds");
    ledger.recordInterruption({ ...common, phase: "acknowledged", request_record_id: requestId });
    ledger.recordInterruption({ ...common, phase: "state_applied", request_record_id: requestId });
    saveLedger(ledger, tempDir, "camp1");
    const loaded = loadLedger(tempDir, "camp1");
    expect(loaded.getInterruptions("camp1", "interrupt-1").map((record) => record.interruption.phase))
      .toEqual(["requested", "acknowledged", "state_applied"]);
    expect(loaded.verifyIntegrity().valid).toBe(true);

    const path = join(tempDir, "audit", "camp1.jsonl");
    writeFileSync(path, readFileSync(path, "utf8").replace("operator stop", "operator halt"));
    const corrupted = loadLedgerResult(tempDir, "camp1");
    expect(corrupted.value?.getRecords()).toHaveLength(0);
    expect(corrupted.diagnostics[0]?.code).toBe("integrity_failure");
  });

  it("fsyncs and reloads recovery authority records idempotently", () => {
    const ledger = new EvidenceLedger();
    const input = {
      campaign_id: "camp1", node_id: "node_1", recovery_operation_id: "recover-1", decision: "abandon" as const,
      actor: "operator", authority: "operator" as const, reason: "lease ownership is ambiguous",
      prior_operation_id: "expand-1", new_operation_id: null, expected_version: "v1", observed_version: "v1",
      lease: { previous: "ambiguous" as const, new_lease_id: null },
      isolation: { result: "not_checked" as const, checkpoint_operation_id: null, evidence_deficit: null },
      outcome: "blocked" as const,
    };
    const id = persistRecoveryDecision(ledger, tempDir, input);
    expect(persistRecoveryDecision(ledger, tempDir, input)).toBe(id);
    const loaded = loadLedger(tempDir, "camp1");
    expect(loaded.getRecoveryDecisions("camp1")).toHaveLength(1);
    expect(loaded.verifyIntegrity().valid).toBe(true);
  });

  it("fsyncs a gate checkpoint before a manager makes its transition visible", () => {
    const ledger = new EvidenceLedger();
    persistGateCheckpoint(ledger, tempDir, {
      campaign_id: "camp1",
      node_id: "node_1",
      transition: "node_expansion",
      operation_id: "expand-node-1",
      gate: {
        gate: "isolation",
        result: "bypass",
        checked_at: "2026-08-01T12:00:00.000Z",
        detail: "worktree probe unavailable",
        bypass_evidence_deficit: "git worktree probe required",
      },
    });

    const loaded = loadLedger(tempDir, "camp1");
    expect(loaded.getGateCheckpoints("camp1")).toHaveLength(1);
    expect(loaded.getBypasses("camp1")).toHaveLength(1);
  });

  it("round-trips trace packets", () => {
    const ledger = new EvidenceLedger();
    ledger.record(makePacket({ node_id: "n1" }));
    ledger.record(makePacket({ node_id: "n2" }));
    ledger.record(makePacket({ node_id: "n3" }));

    saveLedger(ledger, tempDir, "camp1");
    const loaded = loadLedger(tempDir, "camp1");

    const packets = loaded.getCampaign("camp1");
    expect(packets).toHaveLength(3);
  });

  it("returns empty ledger for non-existent file", () => {
    const ledger = loadLedger(tempDir, "nonexistent");
    expect(ledger.getCampaign("camp1")).toHaveLength(0);
  });

  it("appends only newly-recorded packets when saved more than once", () => {
    const ledger = new EvidenceLedger();
    ledger.record(makePacket({ node_id: "n1" }));
    saveLedger(ledger, tempDir, "camp1");
    ledger.record(makePacket({ node_id: "n2" }));
    saveLedger(ledger, tempDir, "camp1");

    const persistedRows = readFileSync(join(tempDir, "audit", "camp1.jsonl"), "utf-8")
      .trim()
      .split("\n");
    expect(persistedRows).toHaveLength(2);
    expect(loadLedger(tempDir, "camp1").verifyIntegrity().valid).toBe(true);
  });

  it("rejects a tampered persisted ledger rather than returning untrusted evidence", () => {
    const ledger = new EvidenceLedger();
    ledger.record(makePacket());
    saveLedger(ledger, tempDir, "camp1");
    const filePath = join(tempDir, "audit", "camp1.jsonl");
    const packet = JSON.parse(readFileSync(filePath, "utf-8")) as { action_description: string };
    packet.action_description = "tampered";
    writeFileSync(filePath, `${JSON.stringify(packet)}\n`);

    expect(() => loadLedger(tempDir, "camp1")).toThrow(AuditIntegrityError);
  });

  it("quarantines tampered evidence and returns an explicitly empty projection", () => {
    const ledger = new EvidenceLedger();
    ledger.record(makePacket());
    saveLedger(ledger, tempDir, "camp1");
    const filePath = join(tempDir, "audit", "camp1.jsonl");
    const packet = JSON.parse(readFileSync(filePath, "utf-8")) as { action_description: string };
    packet.action_description = "tampered";
    writeFileSync(filePath, `${JSON.stringify(packet)}\n`);

    const result = loadLedgerResult(tempDir, "camp1");
    expect(result.value?.getRecords()).toEqual([]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      artifact: "audit_ledger", code: "integrity_failure", quarantined_path: expect.stringContaining("quarantine"),
    }));
  });

  it("rejects an append from a ledger that is not chained to persisted evidence", () => {
    const first = new EvidenceLedger();
    first.record(makePacket({ node_id: "n1" }));
    saveLedger(first, tempDir, "camp1");

    const disconnected = new EvidenceLedger();
    disconnected.record(makePacket({ node_id: "n2" }));
    expect(() => saveLedger(disconnected, tempDir, "camp1")).toThrow(AuditIntegrityError);
  });
});
