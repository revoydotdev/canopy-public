/**
 * `CampaignManager.getRecoverableNodes` — the missing `recovery.retry`/
 * `recovery.abandon` read path (`prior_operation_id`). Verified against
 * `arbor-core/src/runtime-contracts.ts`, `manager.ts`, `recovery-service.ts`,
 * and `tree.ts`'s `interruptNode`: no query, projection, or event previously
 * surfaced a node's prior operation id to any client.
 *
 * The runtime catalog exposes this exact durable view as `recovery.pending`;
 * this focused suite guards its source-of-truth manager semantics.
 */
import { describe, expect, it } from "vitest";
import { CampaignManager } from "../src/manager.js";

const rootAction = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" } as const;
const childAction = { description: "child", estimated_gain: 1, estimated_cost: 1, category: "refactor", delegate_to: "seed" } as const;

describe("CampaignManager.getRecoverableNodes", () => {
  it("returns [] for an unknown campaign", () => {
    const manager = new CampaignManager();
    expect(manager.getRecoverableNodes("does-not-exist")).toEqual([]);
  });

  it("excludes plain pending nodes — the default resting state of every untouched node, not a recovery signal", () => {
    const manager = new CampaignManager();
    manager.startCampaign("c1", "plan.md", rootAction);
    manager.branch("c1", "root", [childAction]);
    expect(manager.getRecoverableNodes("c1")).toEqual([]);
  });

  it("surfaces a genuinely interrupted node's real prior_operation_id (tree.ts's interruptNode always sets node.outcome.operation_id)", () => {
    const manager = new CampaignManager();
    manager.startCampaign("c1", "plan.md", rootAction);
    const [nodeId] = manager.branch("c1", "root", [childAction]);
    manager.expandNode("c1", nodeId, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
    const version = manager.getCampaignVersion("c1");

    manager.interrupt({
      campaign_id: "c1", node_id: nodeId, operation_id: "op-interrupt-1", scope: "node",
      reason: "operator-interrupt", expected_version: version,
      provenance: { tag: "claimed", claimant: "operator" },
      acknowledge: () => {},
    });

    const recoverable = manager.getRecoverableNodes("c1");
    expect(recoverable).toEqual([{ campaign_id: "c1", node_id: nodeId, state: "interrupted", prior_operation_id: "op-interrupt-1", expected_version: manager.getCampaignVersion("c1") }]);
  });

  it("lists a crashed 'expanding' node with prior_operation_id: null — a typed unavailable, never a fabricated or zero value", () => {
    const manager = new CampaignManager();
    manager.startCampaign("c1", "plan.md", rootAction);
    const [nodeId] = manager.branch("c1", "root", [childAction]);
    manager.expandNode("c1", nodeId, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
    // No interrupt was ever recorded for this node — it is simply stuck
    // "expanding" (e.g. a crashed worker), so no durable operation id exists.
    const snapshot = manager.getCampaignSnapshot("c1");
    expect(snapshot?.nodes.find((n) => n.id === nodeId)?.state).toBe("expanding");

    const recoverable = manager.getRecoverableNodes("c1");
    expect(recoverable).toEqual([{ campaign_id: "c1", node_id: nodeId, state: "expanding", prior_operation_id: null, expected_version: manager.getCampaignVersion("c1") }]);
  });

  it("stops listing a node once retried back to pending (retryInterruptedNode clears the interrupted outcome)", () => {
    const manager = new CampaignManager();
    manager.startCampaign("c1", "plan.md", rootAction);
    const [nodeId] = manager.branch("c1", "root", [childAction]);
    manager.expandNode("c1", nodeId, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
    const version = manager.getCampaignVersion("c1");
    manager.interrupt({
      campaign_id: "c1", node_id: nodeId, operation_id: "op-interrupt-2", scope: "node",
      reason: "operator-interrupt", expected_version: version,
      provenance: { tag: "claimed", claimant: "operator" },
      acknowledge: () => {},
    });
    expect(manager.getRecoverableNodes("c1")).toHaveLength(1);

    const retryResult = manager.persistRetryTransition({
      request: {
        operation_id: "op-retry-2", idempotency_key: "idem-retry-2", campaign_id: "c1", node_id: nodeId,
        prior_operation_id: "op-interrupt-2", expected_version: manager.getCampaignVersion("c1"),
        action: "retry", actor_id: "tui-operator", actor_role: "operator", reason: "operator retry",
      },
      lease_id: "lease-1",
      isolation: { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true },
    });
    expect(retryResult.ok).toBe(true);
    expect(manager.getCampaignSnapshot("c1")?.nodes.find((n) => n.id === nodeId)?.state).toBe("pending");
    expect(manager.getRecoverableNodes("c1")).toEqual([]);
  });

  it("rejects a retry whose prior operation id disagrees with durable interruption evidence", () => {
    const manager = new CampaignManager();
    manager.startCampaign("c1", "plan.md", rootAction);
    const [nodeId] = manager.branch("c1", "root", [childAction]);
    manager.expandNode("c1", nodeId, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
    manager.interrupt({
      campaign_id: "c1", node_id: nodeId, operation_id: "op-authoritative", scope: "node",
      reason: "operator-interrupt", expected_version: manager.getCampaignVersion("c1"),
      provenance: { tag: "claimed", claimant: "operator" }, acknowledge: () => {},
    });
    const before = manager.getCampaignVersion("c1");
    const result = manager.persistRetryTransition({
      request: {
        operation_id: "op-retry-forged", idempotency_key: "idem-retry-forged", campaign_id: "c1", node_id: nodeId,
        prior_operation_id: "op-client-claimed", expected_version: before,
        action: "retry", actor_id: "operator", actor_role: "operator", reason: "retry",
      },
      lease_id: "fresh-lease",
      isolation: { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true },
    });
    expect(result).toEqual({ ok: false, detail: "prior_operation_id does not match the interrupted node outcome" });
    expect(manager.getCampaignVersion("c1")).toBe(before);
    expect(manager.getCampaignSnapshot("c1")?.nodes.find((node) => node.id === nodeId)?.state).toBe("interrupted");
  });

  it("rejects abandonment whose prior operation id disagrees with durable interruption evidence", () => {
    const manager = new CampaignManager();
    manager.startCampaign("c1", "plan.md", rootAction);
    const [nodeId] = manager.branch("c1", "root", [childAction]);
    manager.expandNode("c1", nodeId, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
    manager.interrupt({
      campaign_id: "c1", node_id: nodeId, operation_id: "op-authoritative", scope: "node",
      reason: "operator-interrupt", expected_version: manager.getCampaignVersion("c1"),
      provenance: { tag: "claimed", claimant: "operator" }, acknowledge: () => {},
    });
    const before = manager.getCampaignVersion("c1");
    const result = manager.persistAbandonment({
      request: {
        operation_id: "op-abandon-forged", idempotency_key: "idem-abandon-forged", campaign_id: "c1", node_id: nodeId,
        prior_operation_id: "op-client-claimed", expected_version: before,
        action: "abandon", actor_id: "operator", actor_role: "operator", reason: "abandon",
      },
      old_lease_state: "inactive",
    });
    expect(result).toEqual({ ok: false, detail: "prior_operation_id does not match the interrupted node outcome" });
    expect(manager.getCampaignVersion("c1")).toBe(before);
    expect(manager.getCampaignSnapshot("c1")?.nodes.find((node) => node.id === nodeId)?.state).toBe("interrupted");
  });
});
