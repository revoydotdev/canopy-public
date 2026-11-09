import { describe, expect, it } from "vitest";
import { CampaignManager } from "../src/manager.js";
import { parentChildThreadId, projectConversationBus, projectParentChildThread, type ConversationBusProjection } from "../src/conversation-bus.js";
import type { NodeCommunicationRecord, NodeCommunicationInput } from "@arbor/audit";
import { compareCodeUnits } from "@arbor/core";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeCommRecord(
  id: string,
  campaignId: string,
  comm: Partial<Record<string, unknown>> & { author_node_id: string; recipient_node_id: string; kind: string; as_of: string },
  prevHash: string | null = null,
): NodeCommunicationRecord {
  const base = {
    author_node_id: comm.author_node_id,
    recipient_node_id: comm.recipient_node_id,
    other_recipient_node_ids: comm.other_recipient_node_ids as string[] ?? [],
    kind: comm.kind,
    payload: { content: comm.content as string ?? "msg", provenance: { tag: "claimed" as const } },
    capability_tier: (comm.capability_tier as string) ?? "specialist",
    trigger_turn: false,
    as_of: comm.as_of,
    correlation_id: `corr-${id}`,
    idempotency_key: `idem-${id}`,
    acknowledges_communication_id: (comm.acknowledges_communication_id as string | null) ?? null,
    retracts_communication_id: (comm.retracts_communication_id as string | null) ?? null,
    conversation_id: comm.conversation_id as string | undefined,
    parent_communication_id: comm.parent_communication_id as string | null | undefined,
  };
  const contentHash = createHash("sha256").update(JSON.stringify(base)).digest("hex");
  return {
    kind: "node_communication",
    id,
    previous_hash: prevHash,
    content_hash: contentHash,
    campaign_id: campaignId,
    node_id: comm.author_node_id,
    timestamp: comm.as_of,
    communication: base as unknown as NodeCommunicationRecord["communication"],
  };
}

describe("projectConversationBus", () => {
  it("groups records by conversation_id ordered by as_of", () => {
    const records: NodeCommunicationRecord[] = [
      makeCommRecord("m1", "c1", { author_node_id: "n1", recipient_node_id: "n2", kind: "delegate", as_of: "2026-01-01T00:00:00Z", conversation_id: "conv-a" }),
      makeCommRecord("m2", "c1", { author_node_id: "n2", recipient_node_id: "n1", kind: "reply", as_of: "2026-01-01T00:00:01Z", conversation_id: "conv-a", parent_communication_id: "m1" }),
      makeCommRecord("m3", "c1", { author_node_id: "n3", recipient_node_id: "n4", kind: "delegate", as_of: "2026-01-01T00:00:02Z", conversation_id: "conv-b" }),
    ];
    const projection = projectConversationBus(records, { campaign_id: "c1" });
    expect(projection.conversations.size).toBe(2);
    const convA = projection.conversations.get("conv-a")!;
    expect(convA.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(convA[1]!.parent_communication_id).toBe("m1");
  });

  it("filters by campaign_id", () => {
    const records: NodeCommunicationRecord[] = [
      makeCommRecord("m1", "c1", { author_node_id: "n1", recipient_node_id: "n2", kind: "delegate", as_of: "2026-01-01T00:00:00Z", conversation_id: "c" }),
      makeCommRecord("m2", "c2", { author_node_id: "n3", recipient_node_id: "n4", kind: "delegate", as_of: "2026-01-01T00:00:01Z", conversation_id: "c" }),
    ];
    const projection = projectConversationBus(records, { campaign_id: "c1" });
    expect(projection.conversations.get("c")!.length).toBe(1);
    expect(projection.conversations.get("c")![0]!.id).toBe("m1");
  });

  it("filters by as_of (snapshot-stable)", () => {
    const records: NodeCommunicationRecord[] = [
      makeCommRecord("m1", "c1", { author_node_id: "n1", recipient_node_id: "n2", kind: "delegate", as_of: "2026-01-01T00:00:00Z", conversation_id: "c" }),
      makeCommRecord("m2", "c1", { author_node_id: "n2", recipient_node_id: "n1", kind: "reply", as_of: "2026-01-02T00:00:00Z", conversation_id: "c" }),
    ];
    const projection = projectConversationBus(records, { campaign_id: "c1", as_of: "2026-01-01T12:00:00Z" });
    expect(projection.conversations.get("c")!.length).toBe(1);
    expect(projection.conversations.get("c")![0]!.id).toBe("m1");
  });

  it("filters by conversation_id", () => {
    const records: NodeCommunicationRecord[] = [
      makeCommRecord("m1", "c1", { author_node_id: "n1", recipient_node_id: "n2", kind: "delegate", as_of: "2026-01-01T00:00:00Z", conversation_id: "conv-a" }),
      makeCommRecord("m2", "c1", { author_node_id: "n3", recipient_node_id: "n4", kind: "delegate", as_of: "2026-01-01T00:00:01Z", conversation_id: "conv-b" }),
    ];
    const projection = projectConversationBus(records, { campaign_id: "c1", conversation_id: "conv-b" });
    expect(projection.conversations.size).toBe(1);
    expect(projection.conversations.has("conv-b")).toBe(true);
  });

  it("bounds the result to the limit", () => {
    const records: NodeCommunicationRecord[] = Array.from({ length: 50 }, (_, i) =>
      makeCommRecord(`m${i}`, "c1", { author_node_id: "n1", recipient_node_id: "n2", kind: "delegate", as_of: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`, conversation_id: "c" }),
    );
    const projection = projectConversationBus(records, { campaign_id: "c1", limit: 10 });
    expect(projection.conversations.get("c")!.length).toBe(10);
  });

  it("windows to the NEWEST messages so a limited reader still sees the thread's latest version past 200 messages", () => {
    const records: NodeCommunicationRecord[] = Array.from({ length: 250 }, (_, i) =>
      makeCommRecord(`m${String(i).padStart(3, "0")}`, "c1", {
        author_node_id: "parent", recipient_node_id: "child", kind: "delegate",
        as_of: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), conversation_id: parentChildThreadId("parent", "child"),
      }),
    );
    const options = { campaign_id: "c1", parent_node_id: "parent", child_node_id: "child" };
    const limited = projectParentChildThread(records, { ...options, limit: 200 });
    const wide = projectParentChildThread(records, { ...options, limit: 1000 });
    expect(limited.messages).toHaveLength(200);
    expect(limited.messages.at(-1)!.id).toBe("m249");
    expect(limited.version).toBe("m249");
    expect(limited.version).toBe(wide.version);
    expect(limited.messages[0]!.id).toBe("m050");
  });

  it("structurally redacts higher-tier messages from lower-tier readers", () => {
    const records: NodeCommunicationRecord[] = [
      makeCommRecord("m1", "c1", { author_node_id: "n1", recipient_node_id: "n2", kind: "delegate", as_of: "2026-01-01T00:00:00Z", conversation_id: "c", capability_tier: "specialist" }),
      makeCommRecord("m2", "c1", { author_node_id: "n3", recipient_node_id: "n4", kind: "clarify", as_of: "2026-01-01T00:00:01Z", conversation_id: "c", capability_tier: "critic" }),
    ];
    const specialistView = projectConversationBus(records, { campaign_id: "c1", tier: "specialist" });
    expect(specialistView.conversations.get("c")!.length).toBe(1);
    expect(specialistView.conversations.get("c")![0]!.capability_tier).toBe("specialist");
    const criticView = projectConversationBus(records, { campaign_id: "c1", tier: "critic" });
    expect(criticView.conversations.get("c")!.length).toBe(2);
  });

  it("places records without conversation_id into ungrouped", () => {
    const records: NodeCommunicationRecord[] = [
      makeCommRecord("m1", "c1", { author_node_id: "n1", recipient_node_id: "n2", kind: "delegate", as_of: "2026-01-01T00:00:00Z" }),
    ];
    const projection = projectConversationBus(records, { campaign_id: "c1" });
    expect(projection.ungrouped.length).toBe(1);
    expect(projection.conversations.size).toBe(0);
  });

  it("rejects invalid campaign_id and limit", () => {
    expect(() => projectConversationBus([], { campaign_id: "" })).toThrow("non-empty");
    expect(() => projectConversationBus([], { campaign_id: "c1", limit: 0 })).toThrow();
    expect(() => projectConversationBus([], { campaign_id: "c1", limit: 1001 })).toThrow();
    expect(() => projectConversationBus([], { campaign_id: "c1", as_of: "not-a-date" })).toThrow("ISO-parseable");
  });
});

describe("CampaignManager.getConversationBus + recordBusMessage", () => {
  it("round-trips a conversation through the manager", () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("c1", "/plan", { category: "test", description: "t", estimated_gain: 1, estimated_cost: 1, delegate_to: "seed" });
    const id1 = mgr.recordBusMessage({
      campaign_id: "c1", node_id: "n1", author_node_id: "n1", recipient_node_id: "n2",
      other_recipient_node_ids: [], kind: "delegate", payload: { content: "do x", provenance: { tag: "claimed", claimant: "test-agent" } },
      capability_tier: "specialist", trigger_turn: false, as_of: "2026-01-01T00:00:00Z",
      correlation_id: "corr1", idempotency_key: "idem1", acknowledges_communication_id: null,
      retracts_communication_id: null, conversation_id: "conv-1",
    });
    expect(id1).toBeTruthy();
    const projection = mgr.getConversationBus("c1", { tier: "specialist" });
    expect(projection.conversations.get("conv-1")!.length).toBe(1);
    expect(projection.conversations.get("conv-1")![0]!.conversation_id).toBe("conv-1");
  });

  it("is idempotent on idempotency_key", () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("c1", "/plan", { category: "test", description: "t", estimated_gain: 1, estimated_cost: 1, delegate_to: "seed" });
    const input: NodeCommunicationInput & { conversation_id: string } = {
      campaign_id: "c1", node_id: "n1", author_node_id: "n1", recipient_node_id: "n2",
      other_recipient_node_ids: [], kind: "delegate", payload: { content: "do x", provenance: { tag: "claimed", claimant: "test-agent" } },
      capability_tier: "specialist", trigger_turn: false, as_of: "2026-01-01T00:00:00Z",
      correlation_id: "corr1", idempotency_key: "idem1", acknowledges_communication_id: null,
      retracts_communication_id: null, conversation_id: "conv-1",
    };
    const id1 = mgr.recordBusMessage(input);
    const id2 = mgr.recordBusMessage(input);
    expect(id1).toBe(id2);
  });

  it("rejects empty conversation_id", () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("c1", "/plan", { category: "test", description: "t", estimated_gain: 1, estimated_cost: 1, delegate_to: "seed" });
    expect(() =>
      mgr.recordBusMessage({
        campaign_id: "c1", node_id: "n1", author_node_id: "n1", recipient_node_id: "n2",
        other_recipient_node_ids: [], kind: "delegate", payload: { content: "x", provenance: { tag: "claimed", claimant: "test-agent" } },
        capability_tier: "specialist", trigger_turn: false, as_of: "2026-01-01T00:00:00Z", correlation_id: "c", idempotency_key: "i",
        acknowledges_communication_id: null, retracts_communication_id: null, conversation_id: "",
      } as never),
    ).toThrow("non-empty");
  });
});

// ============================================================
// Phase 4D.2 done-when criteria.
// ============================================================

describe("double-promote conflicts loudly (done-when criterion 2/4)", () => {
  it("flags two live promotes racing on the same target — both stay visible, both flagged, neither silently wins", () => {
    const records: NodeCommunicationRecord[] = [
      makeCommRecord("report-1", "c1", { author_node_id: "sib-1", recipient_node_id: "n1", kind: "report", as_of: "2026-01-01T00:00:00Z", conversation_id: "conv-a" }),
      makeCommRecord("promote-a", "c1", { author_node_id: "n1", recipient_node_id: "root", kind: "promote", as_of: "2026-01-01T00:00:01Z", conversation_id: "conv-a", parent_communication_id: "report-1" }),
      makeCommRecord("promote-b", "c1", { author_node_id: "critic-1", recipient_node_id: "root", kind: "promote", as_of: "2026-01-01T00:00:02Z", conversation_id: "conv-a", parent_communication_id: "report-1" }),
    ];
    const projection = projectConversationBus(records, { campaign_id: "c1" });

    // Structured, typed conflict — not a silent last-write-wins.
    expect(projection.promote_conflicts).toEqual([
      { conversation_id: "conv-a", target_communication_id: "report-1", communication_ids: ["promote-a", "promote-b"] },
    ]);

    const conv = projection.conversations.get("conv-a")!;
    expect(conv.find((m) => m.id === "promote-a")!.promote_conflict).toBe(true);
    expect(conv.find((m) => m.id === "promote-b")!.promote_conflict).toBe(true);
    // Neither record disappeared or was collapsed — the ledger is append-only.
    expect(conv.map((m) => m.id)).toEqual(["report-1", "promote-a", "promote-b"]);
  });

  it("does not conflict across distinct targets", () => {
    const records: NodeCommunicationRecord[] = [
      makeCommRecord("report-1", "c1", { author_node_id: "sib-1", recipient_node_id: "n1", kind: "report", as_of: "2026-01-01T00:00:00Z", conversation_id: "conv-a" }),
      makeCommRecord("report-2", "c1", { author_node_id: "sib-2", recipient_node_id: "n1", kind: "report", as_of: "2026-01-01T00:00:01Z", conversation_id: "conv-a" }),
      makeCommRecord("promote-a", "c1", { author_node_id: "n1", recipient_node_id: "root", kind: "promote", as_of: "2026-01-01T00:00:02Z", conversation_id: "conv-a", parent_communication_id: "report-1" }),
      makeCommRecord("promote-b", "c1", { author_node_id: "n1", recipient_node_id: "root", kind: "promote", as_of: "2026-01-01T00:00:03Z", conversation_id: "conv-a", parent_communication_id: "report-2" }),
    ];
    const projection = projectConversationBus(records, { campaign_id: "c1" });
    expect(projection.promote_conflicts).toEqual([]);
    const conv = projection.conversations.get("conv-a")!;
    expect(conv.every((m) => m.promote_conflict === false)).toBe(true);
  });

  it("a promote explicitly retracted by a later record is no longer live and does not conflict", () => {
    const records: NodeCommunicationRecord[] = [
      makeCommRecord("report-1", "c1", { author_node_id: "sib-1", recipient_node_id: "n1", kind: "report", as_of: "2026-01-01T00:00:00Z", conversation_id: "conv-a" }),
      makeCommRecord("promote-a", "c1", { author_node_id: "n1", recipient_node_id: "root", kind: "promote", as_of: "2026-01-01T00:00:01Z", conversation_id: "conv-a", parent_communication_id: "report-1" }),
      makeCommRecord("promote-c", "c1", { author_node_id: "critic-1", recipient_node_id: "root", kind: "promote", as_of: "2026-01-01T00:00:02Z", conversation_id: "conv-a", parent_communication_id: "report-1" }),
      makeCommRecord("retract-c", "c1", { author_node_id: "critic-1", recipient_node_id: "root", kind: "retract", as_of: "2026-01-01T00:00:03Z", conversation_id: "conv-a", retracts_communication_id: "promote-c" }),
    ];
    const projection = projectConversationBus(records, { campaign_id: "c1" });
    expect(projection.promote_conflicts).toEqual([]);
    const conv = projection.conversations.get("conv-a")!;
    expect(conv.find((m) => m.id === "promote-a")!.promote_conflict).toBe(false);
    expect(conv.find((m) => m.id === "promote-c")!.promote_conflict).toBe(false);
  });

  it("a promote with no parent link cannot be proven to race anything, and is never grouped", () => {
    const records: NodeCommunicationRecord[] = [
      makeCommRecord("promote-a", "c1", { author_node_id: "n1", recipient_node_id: "root", kind: "promote", as_of: "2026-01-01T00:00:00Z", conversation_id: "conv-a" }),
      makeCommRecord("promote-b", "c1", { author_node_id: "n2", recipient_node_id: "root", kind: "promote", as_of: "2026-01-01T00:00:01Z", conversation_id: "conv-a" }),
    ];
    const projection = projectConversationBus(records, { campaign_id: "c1" });
    expect(projection.promote_conflicts).toEqual([]);
  });
});

describe("steer-before-ack is typed (done-when criterion 3/4)", () => {
  it("types a steer preceding any acknowledgement as before_ack, without an ack_communication_id field", () => {
    const records: NodeCommunicationRecord[] = [
      makeCommRecord("delegate-1", "c1", { author_node_id: "n1", recipient_node_id: "sib-1", kind: "delegate", as_of: "2026-01-01T00:00:00Z", conversation_id: "conv-a" }),
      makeCommRecord("steer-1", "c1", { author_node_id: "n1", recipient_node_id: "sib-1", kind: "steer", as_of: "2026-01-01T00:00:01Z", conversation_id: "conv-a", acknowledges_communication_id: "delegate-1" }),
    ];
    const projection = projectConversationBus(records, { campaign_id: "c1" });
    const steer = projection.conversations.get("conv-a")!.find((m) => m.id === "steer-1")!;
    expect(steer.steer_timing).toEqual({ status: "before_ack", delegate_communication_id: "delegate-1" });
    expect(steer.steer_timing && "ack_communication_id" in steer.steer_timing).toBe(false);
  });

  it("types a steer following the sibling's own ack as after_ack, carrying the ack id", () => {
    const records: NodeCommunicationRecord[] = [
      makeCommRecord("delegate-1", "c1", { author_node_id: "n1", recipient_node_id: "sib-1", kind: "delegate", as_of: "2026-01-01T00:00:00Z", conversation_id: "conv-a" }),
      makeCommRecord("reply-1", "c1", { author_node_id: "sib-1", recipient_node_id: "n1", kind: "reply", as_of: "2026-01-01T00:00:01Z", conversation_id: "conv-a", acknowledges_communication_id: "delegate-1" }),
      makeCommRecord("steer-1", "c1", { author_node_id: "n1", recipient_node_id: "sib-1", kind: "steer", as_of: "2026-01-01T00:00:02Z", conversation_id: "conv-a", acknowledges_communication_id: "delegate-1" }),
    ];
    const projection = projectConversationBus(records, { campaign_id: "c1" });
    const steer = projection.conversations.get("conv-a")!.find((m) => m.id === "steer-1")!;
    expect(steer.steer_timing).toEqual({ status: "after_ack", delegate_communication_id: "delegate-1", ack_communication_id: "reply-1" });
  });

  it("an ack from an unrelated author does not count — steer stays before_ack", () => {
    const records: NodeCommunicationRecord[] = [
      makeCommRecord("delegate-1", "c1", { author_node_id: "n1", recipient_node_id: "sib-1", kind: "delegate", as_of: "2026-01-01T00:00:00Z", conversation_id: "conv-a" }),
      // A record authored by someone other than sib-1 that happens to reference
      // delegate-1 does not count as the delegated sibling's own acknowledgement.
      makeCommRecord("stray-1", "c1", { author_node_id: "bystander", recipient_node_id: "n1", kind: "reply", as_of: "2026-01-01T00:00:01Z", conversation_id: "conv-a", acknowledges_communication_id: "delegate-1" }),
      makeCommRecord("steer-1", "c1", { author_node_id: "n1", recipient_node_id: "sib-1", kind: "steer", as_of: "2026-01-01T00:00:02Z", conversation_id: "conv-a", acknowledges_communication_id: "delegate-1" }),
    ];
    const projection = projectConversationBus(records, { campaign_id: "c1" });
    const steer = projection.conversations.get("conv-a")!.find((m) => m.id === "steer-1")!;
    expect(steer.steer_timing).toEqual({ status: "before_ack", delegate_communication_id: "delegate-1" });
  });

  it("types a steer with no resolvable delegate as unlinked — distinct from before_ack", () => {
    const records: NodeCommunicationRecord[] = [
      makeCommRecord("steer-1", "c1", { author_node_id: "n1", recipient_node_id: "sib-1", kind: "steer", as_of: "2026-01-01T00:00:00Z", conversation_id: "conv-a", acknowledges_communication_id: "no-such-delegate" }),
    ];
    const projection = projectConversationBus(records, { campaign_id: "c1" });
    const steer = projection.conversations.get("conv-a")!.find((m) => m.id === "steer-1")!;
    expect(steer.steer_timing).toEqual({ status: "unlinked" });
    expect(steer.steer_timing?.status).not.toBe("before_ack");
  });

  it("non-steer messages always carry a null steer_timing", () => {
    const records: NodeCommunicationRecord[] = [
      makeCommRecord("delegate-1", "c1", { author_node_id: "n1", recipient_node_id: "sib-1", kind: "delegate", as_of: "2026-01-01T00:00:00Z", conversation_id: "conv-a" }),
    ];
    const projection = projectConversationBus(records, { campaign_id: "c1" });
    expect(projection.conversations.get("conv-a")![0]!.steer_timing).toBeNull();
  });
});

describe("a stale count can never gate or wedge selection (done-when criterion 4/4)", () => {
  it("projectConversationBus is pure: identical input yields deep-equal output, no memoization drift", () => {
    const records: NodeCommunicationRecord[] = [
      makeCommRecord("m1", "c1", { author_node_id: "n1", recipient_node_id: "n2", kind: "delegate", as_of: "2026-01-01T00:00:00Z", conversation_id: "c" }),
    ];
    const first = projectConversationBus(records, { campaign_id: "c1", as_of: "2026-01-02T00:00:00Z" });
    const second = projectConversationBus(records, { campaign_id: "c1", as_of: "2026-01-02T00:00:00Z" });
    expect(first).not.toBe(second); // no shared cached object
    expect(canonicalize(first)).toBe(canonicalize(second)); // same facts -> same projection, byte for byte
  });

  it("reflects a newly-replayed record on the very next call — reproduces the omo/opencode staleness bug and shows it cannot occur here", () => {
    const mutableRecords: NodeCommunicationRecord[] = [
      makeCommRecord("delegate-1", "c1", { author_node_id: "n1", recipient_node_id: "sib-1", kind: "delegate", as_of: "2026-01-01T00:00:00Z", conversation_id: "conv-a" }),
    ];
    // A "background running?" read before the sibling has reported.
    const stale = projectConversationBus(mutableRecords, { campaign_id: "c1" });
    expect(stale.conversations.get("conv-a")!.length).toBe(1);

    // The sibling reports — a new durable fact is replayed in. There is no
    // cache to invalidate: the caller simply passes the updated record set.
    mutableRecords.push(
      makeCommRecord("report-1", "c1", { author_node_id: "sib-1", recipient_node_id: "n1", kind: "report", as_of: "2026-01-01T00:00:01Z", conversation_id: "conv-a", acknowledges_communication_id: "delegate-1" }),
    );
    const fresh = projectConversationBus(mutableRecords, { campaign_id: "c1" });
    expect(fresh.conversations.get("conv-a")!.length).toBe(2);
    // The wedge this guards against: a caller reading a marker computed
    // before the report landed and never re-checking. Nothing here can do
    // that — every call re-derives from whatever `records` currently holds.
    expect(fresh).not.toBe(stale);
  });
});

describe("crash-mid-conversation restores byte-identically (done-when criterion 1/4)", () => {
  const action = { category: "test", description: "t", estimated_gain: 1, estimated_cost: 1, delegate_to: "seed" } as const;

  function busInput(overrides: Partial<NodeCommunicationInput> & { kind: NodeCommunicationInput["kind"] }): NodeCommunicationInput & { conversation_id: string } {
    return {
      campaign_id: "c1", node_id: "n1", author_node_id: "n1", recipient_node_id: "sib-1",
      other_recipient_node_ids: [], payload: { content: "msg", provenance: { tag: "claimed", claimant: "test-agent" } },
      capability_tier: "orchestrator", trigger_turn: false, as_of: "2026-01-01T00:00:00Z",
      correlation_id: "corr", idempotency_key: "idem", acknowledges_communication_id: null,
      retracts_communication_id: null, conversation_id: "conv-crash",
      ...overrides,
    };
  }

  it("round-trips a real disk-persisted conversation across a simulated process restart, byte-identically", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-bus-crash-"));
    try {
      const before = new CampaignManager({ persistence_dir: dir });
      before.startCampaign("c1", "/plan", action);
      const delegateId = before.recordBusMessage(busInput({
        kind: "delegate", as_of: "2026-01-01T00:00:00Z", correlation_id: "corr-1", idempotency_key: "idem-1",
      }));
      before.recordBusMessage(busInput({
        kind: "reply", author_node_id: "sib-1", recipient_node_id: "n1", as_of: "2026-01-01T00:00:01Z",
        correlation_id: "corr-2", idempotency_key: "idem-2", acknowledges_communication_id: delegateId,
      }));

      // "Crash": every write above already durably fsynced per call
      // (recordNodeCommunication saves to disk before returning — see
      // manager.ts's staged-write comment). A brand-new manager instance,
      // sharing nothing but the directory, stands in for the restarted
      // process — this is not an in-memory equality check.
      const snapshotAsOf = "2026-01-03T00:00:00Z";
      const beforeProjection = before.getConversationBus("c1", { tier: "orchestrator", as_of: snapshotAsOf });

      const after = new CampaignManager({ persistence_dir: dir });
      const afterProjection = after.getConversationBus("c1", { tier: "orchestrator", as_of: snapshotAsOf });

      expect(afterProjection).not.toBe(beforeProjection);
      expect(canonicalize(afterProjection)).toBe(canonicalize(beforeProjection));

      // Prove "mid-conversation", not merely "after the conversation had
      // already finished": the recovered manager keeps appending to the
      // SAME conversation, referencing the pre-crash delegate id.
      const steerId = after.recordBusMessage(busInput({
        kind: "steer", as_of: "2026-01-01T00:00:02Z", correlation_id: "corr-3", idempotency_key: "idem-3",
        acknowledges_communication_id: delegateId,
      }));
      expect(steerId).toBeTruthy();
      const continued = after.getConversationBus("c1", { tier: "orchestrator" });
      const ids = continued.conversations.get("conv-crash")!.map((m) => m.id);
      expect(ids).toHaveLength(3);
      expect(ids[2]).toBe(steerId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Deterministic byte-level serialization of a projection (Maps have no stable JSON.stringify order). */
function canonicalize(projection: ConversationBusProjection): string {
  return JSON.stringify({
    campaign_id: projection.campaign_id,
    as_of: projection.as_of,
    promote_conflicts: projection.promote_conflicts,
    ungrouped: projection.ungrouped,
    conversations: [...projection.conversations.entries()].sort((a, b) => compareCodeUnits(a[0], b[0])),
  });
}
