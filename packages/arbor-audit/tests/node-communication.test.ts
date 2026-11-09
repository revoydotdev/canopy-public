import { describe, expect, it } from "vitest";
import { EvidenceLedger, CONVERSATION_MAX_ID_BYTES, type NodeCommunicationInput } from "../src/audit.js";

function message(overrides: Partial<NodeCommunicationInput> = {}): NodeCommunicationInput {
  return {
    campaign_id: "campaign", node_id: "node-a", author_node_id: "node-a", recipient_node_id: "node-b", other_recipient_node_ids: [],
    kind: "delegate", payload: { content: "do work", provenance: { tag: "claimed", claimant: "crown" } }, capability_tier: "specialist",
    trigger_turn: false, as_of: "iter:1", correlation_id: "correlation", idempotency_key: "message-1", acknowledges_communication_id: null, retracts_communication_id: null,
    ...overrides,
  };
}

describe("NodeCommunication audit evidence", () => {
  it("replays across restart and keeps idempotent records stable while rejecting conflicts", () => {
    const ledger = new EvidenceLedger();
    const id = ledger.recordNodeCommunication(message());
    expect(ledger.recordNodeCommunication(message())).toBe(id);
    expect(() => ledger.recordNodeCommunication(message({ payload: { content: "different", provenance: { tag: "claimed", claimant: "crown" } } }))).toThrow("conflicting");
    const restored = new EvidenceLedger();
    expect(restored.fromJSONL(ledger.toJSONL())).toBe(1);
    expect(restored.getNodeCommunications("campaign", "node-b")).toHaveLength(1);
    expect(restored.verifyIntegrity()).toMatchObject({ valid: true });
  });

  it("filters restricted reasoning by capability and projects fan-out without a pending counter", () => {
    const ledger = new EvidenceLedger();
    ledger.recordNodeCommunication(message({ capability_tier: "critic", other_recipient_node_ids: ["node-c"] }));
    expect(ledger.getNodeCommunications("campaign", "node-c", { tier: "specialist" })).toEqual([]);
    expect(ledger.getNodeCommunications("campaign", "node-c", { tier: "critic" })).toHaveLength(1);
    expect(ledger.getNodeCommunications("campaign", "node-c", { tier: "auditor", limit: 1 })).toHaveLength(1);
  });

  it("requires durable acknowledgement/retraction linkage and detects tampering", () => {
    const ledger = new EvidenceLedger();
    const original = ledger.recordNodeCommunication(message());
    const acknowledgement = ledger.recordNodeCommunication(message({ idempotency_key: "message-2", kind: "report", acknowledges_communication_id: original }));
    expect(ledger.recordNodeCommunication(message({ idempotency_key: "message-3", kind: "retract", retracts_communication_id: acknowledgement }))).toMatch(/^communication_/);
    expect(() => ledger.recordNodeCommunication(message({ idempotency_key: "broken", acknowledges_communication_id: "missing" }))).toThrow("unknown");
    const lines = ledger.toJSONL().split("\n");
    const tampered = JSON.parse(lines[0]) as { communication: { payload: { content: string } } };
    tampered.communication.payload.content = "forged";
    const restored = new EvidenceLedger();
    restored.fromJSONL([JSON.stringify(tampered), ...lines.slice(1)].join("\n"));
    expect(restored.verifyIntegrity()).toMatchObject({ valid: false });
  });

  it("scopes idempotency and linkage to a campaign and validates provenance structurally", () => {
    const ledger = new EvidenceLedger();
    const first = ledger.recordNodeCommunication(message());
    expect(ledger.recordNodeCommunication(message({ campaign_id: "other" }))).not.toBe(first);
    expect(() => ledger.recordNodeCommunication(message({ campaign_id: "third", idempotency_key: "third", acknowledges_communication_id: first }))).toThrow("in campaign third");
    expect(() => ledger.recordNodeCommunication(message({ idempotency_key: "bad-provenance", payload: { content: "x", provenance: { tag: "claimed" } as never } }))).toThrow("provenance");
    // G-26: a `verified` provenance claiming a passed command without a
    // stdout_hash must not be trusted onto the ledger (the type requires it).
    expect(() => ledger.recordNodeCommunication(message({ idempotency_key: "bad-verified-provenance", payload: { content: "x", provenance: { tag: "verified", cmd: "pytest", exit: 0 } as never } }))).toThrow("provenance");
    expect(() => ledger.recordNodeCommunication(message({ idempotency_key: "bad-retract", kind: "retract" }))).toThrow("retract communications");
  });

  // ============================================================
  // Phase 4D.1 — conversation envelope (reply, clarify, promote)
  // ============================================================

  it("accepts reply kind", () => {
    const ledger = new EvidenceLedger();
    const id = ledger.recordNodeCommunication(message({ idempotency_key: "reply-msg", kind: "reply" }));
    expect(id).toMatch(/^communication_/);
    const comms = ledger.getNodeCommunications("campaign", "node-b");
    expect(comms).toHaveLength(1);
    expect(comms[0].communication.kind).toBe("reply");
  });

  it("accepts clarify kind", () => {
    const ledger = new EvidenceLedger();
    const id = ledger.recordNodeCommunication(message({ idempotency_key: "clarify-msg", kind: "clarify" }));
    expect(id).toMatch(/^communication_/);
    const comms = ledger.getNodeCommunications("campaign", "node-b");
    expect(comms[0].communication.kind).toBe("clarify");
  });

  it("accepts promote kind", () => {
    const ledger = new EvidenceLedger();
    const id = ledger.recordNodeCommunication(message({ idempotency_key: "promote-msg", kind: "promote" }));
    expect(id).toMatch(/^communication_/);
    const comms = ledger.getNodeCommunications("campaign", "node-b");
    expect(comms[0].communication.kind).toBe("promote");
  });

  it("rejects invalid kind outside the 7-element closed union", () => {
    const ledger = new EvidenceLedger();
    expect(() => ledger.recordNodeCommunication(message({ idempotency_key: "bad-kind", kind: "unknown" as never }))).toThrow("invalid kind");
  });

  it("rejects invalid kind: empty string", () => {
    const ledger = new EvidenceLedger();
    expect(() => ledger.recordNodeCommunication(message({ idempotency_key: "empty-kind", kind: "" as never }))).toThrow("invalid kind");
  });

  it("conversation_id and parent_communication_id survive toJSONL/fromJSONL round-trip byte-identically", () => {
    const ledger = new EvidenceLedger();
    ledger.recordNodeCommunication(message({
      idempotency_key: "conv-msg",
      kind: "reply",
      conversation_id: "conv-abc-123",
      parent_communication_id: null,
    }));
    const second = ledger.recordNodeCommunication(message({
      idempotency_key: "conv-msg-2",
      kind: "reply",
      conversation_id: "conv-abc-123",
      parent_communication_id: "communication_0",
      acknowledges_communication_id: null,
    }));
    expect(second).toMatch(/^communication_/);

    const jsonl = ledger.toJSONL();
    const restored = new EvidenceLedger();
    restored.fromJSONL(jsonl);
    expect(restored.verifyIntegrity()).toMatchObject({ valid: true });

    const comms = restored.getNodeCommunications("campaign", "node-b");
    const convMsg = comms.find((r) => r.communication.idempotency_key === "conv-msg")!;
    expect(convMsg.communication.conversation_id).toBe("conv-abc-123");
    expect(convMsg.communication.parent_communication_id).toBeNull();

    const convMsg2 = comms.find((r) => r.communication.idempotency_key === "conv-msg-2")!;
    expect(convMsg2.communication.conversation_id).toBe("conv-abc-123");
    expect(convMsg2.communication.parent_communication_id).toBe("communication_0");
  });

  it("legacy record without conversation_id/parent_communication_id replays as undefined/null", () => {
    const ledger = new EvidenceLedger();
    ledger.recordNodeCommunication(message({ idempotency_key: "legacy-msg" }));
    const jsonl = ledger.toJSONL();
    const parsed = JSON.parse(jsonl.split("\n")[0]) as { communication: Record<string, unknown> };
    // Simulate a legacy record that never had the fields
    delete parsed.communication.conversation_id;
    delete parsed.communication.parent_communication_id;

    const restored = new EvidenceLedger();
    restored.fromJSONL(JSON.stringify(parsed));
    expect(restored.verifyIntegrity()).toMatchObject({ valid: true });
    const comms = restored.getNodeCommunications("campaign", "node-b");
    expect(comms).toHaveLength(1);
    expect(comms[0].communication.conversation_id).toBeUndefined();
    expect(comms[0].communication.parent_communication_id).toBeUndefined();
  });

  it("idempotency with same conversation_id returns same record id", () => {
    const ledger = new EvidenceLedger();
    const first = ledger.recordNodeCommunication(message({
      idempotency_key: "idemp-conv", kind: "reply", conversation_id: "conv-xyz",
    }));
    const second = ledger.recordNodeCommunication(message({
      idempotency_key: "idemp-conv", kind: "reply", conversation_id: "conv-xyz",
    }));
    expect(second).toBe(first);
  });

  it("idempotency conflict with different conversation_id throws", () => {
    const ledger = new EvidenceLedger();
    ledger.recordNodeCommunication(message({
      idempotency_key: "conflict-conv", kind: "reply", conversation_id: "conv-alpha",
    }));
    expect(() => ledger.recordNodeCommunication(message({
      idempotency_key: "conflict-conv", kind: "reply", conversation_id: "conv-beta",
    }))).toThrow("conflicting");
  });

  it("validates: empty conversation_id is rejected", () => {
    const ledger = new EvidenceLedger();
    expect(() => ledger.recordNodeCommunication(message({
      idempotency_key: "empty-conv", kind: "reply", conversation_id: "",
    }))).toThrow("conversation_id must be non-empty");
  });

  it("validates: oversized conversation_id (>512 bytes) is rejected", () => {
    const ledger = new EvidenceLedger();
    const oversized = "x".repeat(CONVERSATION_MAX_ID_BYTES + 1);
    expect(() => ledger.recordNodeCommunication(message({
      idempotency_key: "oversized-conv", kind: "reply", conversation_id: oversized,
    }))).toThrow(`conversation_id exceeds ${CONVERSATION_MAX_ID_BYTES} UTF-8 bytes`);
  });

  it("validates: conversation_id at exactly 512 bytes is accepted", () => {
    const ledger = new EvidenceLedger();
    const exactly = "x".repeat(CONVERSATION_MAX_ID_BYTES);
    const id = ledger.recordNodeCommunication(message({
      idempotency_key: "exact-conv", kind: "reply", conversation_id: exactly,
    }));
    expect(id).toMatch(/^communication_/);
  });

  it("validates: empty parent_communication_id (non-null) is rejected", () => {
    const ledger = new EvidenceLedger();
    expect(() => ledger.recordNodeCommunication(message({
      idempotency_key: "empty-parent", kind: "reply", parent_communication_id: "",
    }))).toThrow("parent_communication_id must be non-empty");
  });

  it("validates: parent_communication_id null is allowed (start of conversation)", () => {
    const ledger = new EvidenceLedger();
    const id = ledger.recordNodeCommunication(message({
      idempotency_key: "null-parent", kind: "reply", parent_communication_id: null,
    }));
    expect(id).toMatch(/^communication_/);
  });

  it("capability tier redacts new kinds correctly", () => {
    const ledger = new EvidenceLedger();
    ledger.recordNodeCommunication(message({
      idempotency_key: "critic-clarify", kind: "clarify", capability_tier: "critic",
      other_recipient_node_ids: ["node-c"],
    }));
    expect(ledger.getNodeCommunications("campaign", "node-c", { tier: "specialist" })).toEqual([]);
    expect(ledger.getNodeCommunications("campaign", "node-c", { tier: "critic" })).toHaveLength(1);
  });

  it("hash-chain integrity is preserved across reply/clarify/promote kinds", () => {
    const ledger = new EvidenceLedger();
    ledger.recordNodeCommunication(message({ idempotency_key: "step-1", kind: "delegate" }));
    ledger.recordNodeCommunication(message({ idempotency_key: "step-2", kind: "reply", conversation_id: "conv-1", parent_communication_id: null }));
    ledger.recordNodeCommunication(message({ idempotency_key: "step-3", kind: "clarify", conversation_id: "conv-1" }));
    ledger.recordNodeCommunication(message({ idempotency_key: "step-4", kind: "promote" }));
    expect(ledger.verifyIntegrity()).toMatchObject({ valid: true });

    // Tamper detection still works
    const lines = ledger.toJSONL().split("\n");
    const parsed = JSON.parse(lines[1]) as { communication: { payload: { content: string } } };
    parsed.communication.payload.content = "tampered";
    const restored = new EvidenceLedger();
    restored.fromJSONL([...lines.slice(0, 1), JSON.stringify(parsed), ...lines.slice(2)].join("\n"));
    expect(restored.verifyIntegrity()).toMatchObject({ valid: false });
  });

  it("all three new kinds round-trip through recordNodeCommunication -> getNodeCommunications", () => {
    const ledger = new EvidenceLedger();
    for (const kind of ["reply", "clarify", "promote"] as const) {
      ledger.recordNodeCommunication(message({
        idempotency_key: `rt-${kind}`,
        kind,
        conversation_id: `conv-${kind}`,
        parent_communication_id: null,
      }));
    }
    const comms = ledger.getNodeCommunications("campaign", "node-b");
    expect(comms).toHaveLength(3);
    expect(comms.map((c) => c.communication.kind).sort()).toEqual(["clarify", "promote", "reply"]);
    expect(ledger.verifyIntegrity()).toMatchObject({ valid: true });
  });
});
