import { describe, expect, it } from "vitest";
import { CampaignManager } from "../src/manager.js";
import { TaskSupervisor, DEFAULT_SIBLING_BOUNDS, type SiblingBounds } from "@arbor/core";

describe("CampaignManager.getSiblingStatus", () => {
  it("returns empty active list when no delegate records exist", () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("c1", "/plan", { category: "test", description: "t", estimated_gain: 1, estimated_cost: 1, delegate_to: "seed" });
    const status = mgr.getSiblingStatus("c1", "n1");
    expect(status.active).toEqual([]);
    expect(status.depth).toBe(0);
    expect(status.within_bounds).toBe(true);
  });

  it("reconciles active siblings from delegate+report records (no in-memory count)", () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("c1", "/plan", { category: "test", description: "t", estimated_gain: 1, estimated_cost: 1, delegate_to: "seed" });
    const delegateId = mgr.recordNodeCommunication({
      campaign_id: "c1", node_id: "n1", author_node_id: "n1", recipient_node_id: "sib-1",
      other_recipient_node_ids: [], kind: "delegate", payload: { content: "do work", provenance: { tag: "claimed", claimant: "test-agent" } },
      capability_tier: "specialist", trigger_turn: false, as_of: "2026-01-01T00:00:00Z",
      correlation_id: "corr1", idempotency_key: "idem1", acknowledges_communication_id: null, retracts_communication_id: null,
    });
    let status = mgr.getSiblingStatus("c1", "n1");
    expect(status.active).toEqual(["sib-1"]);

    mgr.recordNodeCommunication({
      campaign_id: "c1", node_id: "sib-1", author_node_id: "sib-1", recipient_node_id: "n1",
      other_recipient_node_ids: [], kind: "report", payload: { content: "done", provenance: { tag: "claimed", claimant: "test-agent" } },
      capability_tier: "specialist", trigger_turn: false, as_of: "2026-01-01T00:00:01Z",
      correlation_id: "corr2", idempotency_key: "idem2", acknowledges_communication_id: delegateId, retracts_communication_id: null,
    });
    status = mgr.getSiblingStatus("c1", "n1");
    expect(status.active).toEqual([]);
  });

  it("survives crash-replay: a delegate with no matching report stays active", () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("c1", "/plan", { category: "test", description: "t", estimated_gain: 1, estimated_cost: 1, delegate_to: "seed" });
    mgr.recordNodeCommunication({
      campaign_id: "c1", node_id: "n1", author_node_id: "n1", recipient_node_id: "sib-orphan",
      other_recipient_node_ids: [], kind: "delegate", payload: { content: "do work", provenance: { tag: "claimed", claimant: "test-agent" } },
      capability_tier: "specialist", trigger_turn: false, as_of: "2026-01-01T00:00:00Z",
      correlation_id: "corr1", idempotency_key: "idem1", acknowledges_communication_id: null, retracts_communication_id: null,
    });
    const status = mgr.getSiblingStatus("c1", "n1");
    expect(status.active).toEqual(["sib-orphan"]);
  });

  it("marks within_bounds false when active siblings exceed the simultaneity cap", () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("c1", "/plan", { category: "test", description: "t", estimated_gain: 1, estimated_cost: 1, delegate_to: "seed" });
    for (let i = 0; i < 10; i += 1) {
      mgr.recordNodeCommunication({
        campaign_id: "c1", node_id: "n1", author_node_id: "n1", recipient_node_id: `sib-${i}`,
        other_recipient_node_ids: [], kind: "delegate", payload: { content: "x", provenance: { tag: "claimed", claimant: "test-agent" } },
        capability_tier: "specialist", trigger_turn: false, as_of: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
        correlation_id: `c${i}`, idempotency_key: `i${i}`, acknowledges_communication_id: null, retracts_communication_id: null,
      });
    }
    const status = mgr.getSiblingStatus("c1", "n1");
    expect(status.active.length).toBe(10);
    expect(status.within_bounds).toBe(false);
  });
});

describe("TaskSupervisor sibling bounds", () => {
  it("applies DEFAULT_SIBLING_BOUNDS when no override provided", () => {
    const sup = new TaskSupervisor();
    expect(sup.getSiblingBounds()).toEqual(DEFAULT_SIBLING_BOUNDS);
    expect(DEFAULT_SIBLING_BOUNDS.maxNestingDepth).toBe(4);
    expect(DEFAULT_SIBLING_BOUNDS.maxSimultaneousSiblings).toBe(8);
  });

  it("rejects invalid bounds at construction", () => {
    expect(() => new TaskSupervisor({ sibling_bounds: { maxNestingDepth: 0, maxSimultaneousSiblings: 8 } })).toThrow();
    expect(() => new TaskSupervisor({ sibling_bounds: { maxNestingDepth: 4, maxSimultaneousSiblings: 0 } })).toThrow();
  });

  it("rejects a child that exceeds maxNestingDepth", () => {
    const bounds: SiblingBounds = { maxNestingDepth: 2, maxSimultaneousSiblings: 8 };
    const sup = new TaskSupervisor({ sibling_bounds: bounds });
    sup.register({ id: "t0", operation_id: "op0", kind: "root", owner_scope_id: "s1" });
    sup.register({ id: "t1", operation_id: "op1", kind: "child", owner_scope_id: "s1", parent_id: "t0" });
    sup.register({ id: "t2", operation_id: "op2", kind: "grandchild", owner_scope_id: "s1", parent_id: "t1" });
    expect(() => sup.register({ id: "t3", operation_id: "op3", kind: "great", owner_scope_id: "s1", parent_id: "t2" })).toThrow(/nesting depth/);
  });

  it("rejects a child that exceeds maxSimultaneousSiblings under one parent", () => {
    const bounds: SiblingBounds = { maxNestingDepth: 4, maxSimultaneousSiblings: 2 };
    const sup = new TaskSupervisor({ sibling_bounds: bounds });
    sup.register({ id: "p", operation_id: "op0", kind: "parent", owner_scope_id: "s1" });
    sup.register({ id: "c1", operation_id: "op1", kind: "child", owner_scope_id: "s1", parent_id: "p" });
    sup.register({ id: "c2", operation_id: "op2", kind: "child", owner_scope_id: "s1", parent_id: "p" });
    expect(() => sup.register({ id: "c3", operation_id: "op3", kind: "child", owner_scope_id: "s1", parent_id: "p" })).toThrow(/maxSimultaneousSiblings/);
  });

  it("frees a sibling slot when a child completes, allowing a new sibling", () => {
    const bounds: SiblingBounds = { maxNestingDepth: 4, maxSimultaneousSiblings: 1 };
    const sup = new TaskSupervisor({ sibling_bounds: bounds });
    sup.register({ id: "p", operation_id: "op0", kind: "parent", owner_scope_id: "s1" });
    sup.register({ id: "c1", operation_id: "op1", kind: "child", owner_scope_id: "s1", parent_id: "p" });
    sup.start("c1");
    sup.complete("c1");
    sup.completeCleanup("c1");
    sup.remove("c1");
    expect(() => sup.register({ id: "c2", operation_id: "op2", kind: "child", owner_scope_id: "s1", parent_id: "p" })).not.toThrow();
  });
});
