import { describe, it, expect } from "vitest";
import {
  createCampaign,
  createChild,
  beginExpansion,
  verifyNode,
  failNode,
  backpropagate,
  pruneNode,
  interruptNode,
  retryInterruptedNode,
  abandonInterruptedNode,
  selectNode,
} from "../src/tree.js";
import type { Action, ScoreContext, Provenance, RecoveryAttempt, RecoveryAbandonment } from "../src/types.js";
import { DEFAULT_SCORE_CONFIG } from "../src/types.js";

const rootAction: Action = {
  description: "execute plan",
  estimated_gain: 100,
  estimated_cost: 1,
  category: "root",
  delegate_to: "crown",
};

const childAction: Action = {
  description: "refactor auth",
  estimated_gain: 50,
  estimated_cost: 10,
  category: "refactor",
  delegate_to: "seed",
};

const ctx: ScoreContext = {
  accuracy_regression_rate: 0,
  crash_regression_rate: 0,
  best_known: 100,
  total_visits: 5,
};

const retryAttempt: RecoveryAttempt = {
  action: "retry", operation_id: "recovery-2", prior_operation_id: "recovery-1", actor_id: "crown",
  reason: "fresh isolation passed", expected_version: "snapshot-1", lease_id: "lease-2", recorded_at: "2026-08-01T12:00:00.000Z",
};

const abandonment: RecoveryAbandonment = {
  action: "abandon", operation_id: "recovery-abandon", prior_operation_id: "recovery-1", actor_id: "operator",
  actor_role: "operator", reason: "lease ambiguity preserved for audit", expected_version: "snapshot-1", recorded_at: "2026-08-01T12:00:00.000Z",
};

describe("createCampaign", () => {
  it("creates a campaign with a claimed root node (root is the admitted plan, not a verified result)", () => {
    const c = createCampaign("camp1", "plan.md", rootAction);
    expect(c.id).toBe("camp1");
    expect(c.root_id).toBe("root");
    const root = c.tree.get("root")!;
    expect(root.state).toBe("claimed");
    expect(root.action.description).toBe("execute plan");
    expect(root).toMatchObject({ memory_mode: "accumulate", memory_mode_version: 1 });
  });
});


describe("ADR-016 interruption outcome", () => {
  it("interrupts pending and expanding subtree nodes deterministically without making them selectable", () => {
    const c = createCampaign("camp-interrupt", "plan.md", rootAction);
    const child = createChild(c.tree, "root", childAction);
    const grandchild = createChild(c.tree, child, childAction);
    beginExpansion(c.tree, child);
    c.tree.get(child)!.specialist_output = "partial output already observed";
    const result = interruptNode(c.tree, child, {
      operation_id: "interrupt-1", scope: "subtree", reason: "operator stop",
      provenance: { tag: "claimed", claimant: "operator" }, partial_evidence_ids: ["artifact-1"],
    });
    expect(result.affected_node_ids).toEqual([child, grandchild]);
    expect(c.tree.get(child)).toMatchObject({ state: "interrupted", specialist_output: "partial output already observed", outcome: { kind: "interrupted", operation_id: "interrupt-1", partial_evidence_ids: ["artifact-1"] } });
    expect(c.tree.get(grandchild)?.state).toBe("interrupted");
    expect(interruptNode(c.tree, child, {
      operation_id: "interrupt-1", scope: "subtree", reason: "operator stop",
      provenance: { tag: "claimed", claimant: "operator" }, partial_evidence_ids: ["artifact-1"],
    }).unchanged_node_ids).toEqual([child, grandchild]);
    expect(() => interruptNode(c.tree, child, {
      operation_id: "interrupt-1", scope: "node", reason: "operator stop",
      provenance: { tag: "claimed", claimant: "operator" }, partial_evidence_ids: ["artifact-1"],
    })).toThrow("Conflicting interruption replay");
    expect(selectNode(c.tree, ctx, DEFAULT_SCORE_CONFIG)).toBeNull();
    expect(() => verifyNode(c.tree, child, { tag: "verified", cmd: "test", exit: 0, stdout_hash: "sha256:test"}, "late", 1)).toThrow("interrupted");
    retryInterruptedNode(c.tree, child, retryAttempt);
    expect(c.tree.get(child)).toMatchObject({ state: "pending", outcome: undefined });
  });
});

describe("createChild + selectNode", () => {
  it("creates children under the root and selects one via UCT", () => {
    const c = createCampaign("camp1", "plan.md", rootAction);
    const childId = createChild(c.tree, "root", childAction);
    expect(childId).toBeDefined();

    const child = c.tree.get(childId)!;
    expect(child.parent_id).toBe("root");
    expect(child.state).toBe("pending");
    expect(c.tree.get("root")!.children_ids).toContain(childId);

    // Select should pick the child (it's the only pending node)
    const selected = selectNode(c.tree, ctx, DEFAULT_SCORE_CONFIG);
    expect(selected).toBe(childId);
  });

  it("selects null when no pending nodes exist", () => {
    const c = createCampaign("camp1", "plan.md", rootAction);
    // Root is verified, no children — nothing pending
    const selected = selectNode(c.tree, ctx, DEFAULT_SCORE_CONFIG);
    expect(selected).toBeNull();
  });

  it("skips nodes with failed/pruned ancestors", () => {
    const c = createCampaign("camp1", "plan.md", rootAction);
    const childId = createChild(c.tree, "root", childAction);
    const grandchildId = createChild(c.tree, childId, { ...childAction, description: "sub-task" });

    // Fail the child
    failNode(c.tree, childId, "test failure");

    // Grandchild should not be selected (its parent is failed)
    const selected = selectNode(c.tree, ctx, DEFAULT_SCORE_CONFIG);
    expect(selected).not.toBe(grandchildId);
  });
});

describe("beginExpansion", () => {
  it("transitions pending to expanding and increments visit_count", () => {
    const c = createCampaign("camp1", "plan.md", rootAction);
    const childId = createChild(c.tree, "root", childAction);
    const before = c.tree.get(childId)!.visit_count;
    beginExpansion(c.tree, childId);
    const node = c.tree.get(childId)!;
    expect(node.state).toBe("expanding");
    expect(node.visit_count).toBe(before + 1);
  });

  it("throws when trying to expand a non-pending node", () => {
    const c = createCampaign("camp1", "plan.md", rootAction);
    expect(() => beginExpansion(c.tree, "root")).toThrow(); // root is not pending
  });
});

describe("verifyNode", () => {
  it("marks as verified when provenance is !verified", () => {
    const c = createCampaign("camp1", "plan.md", rootAction);
    const childId = createChild(c.tree, "root", childAction);
    beginExpansion(c.tree, childId);

    const prov: Provenance = { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test"};
    verifyNode(c.tree, childId, prov, "all tests passed", 42.0);

    const node = c.tree.get(childId)!;
    expect(node.state).toBe("verified");
    expect(node.score).toBe(42.0);
    expect(node.provenance?.tag).toBe("verified");
  });

  it("marks as claimed when provenance is !critic_approved", () => {
    const c = createCampaign("camp1", "plan.md", rootAction);
    const childId = createChild(c.tree, "root", childAction);
    beginExpansion(c.tree, childId);

    const prov: Provenance = { tag: "critic_approved", critic: "lenticel", rationale: "looks good" };
    verifyNode(c.tree, childId, prov, "output looks reasonable", 30.0);

    const node = c.tree.get(childId)!;
    expect(node.state).toBe("claimed");
  });
});

describe("failNode + pruneNode", () => {
  it("marks a node as failed and returns the parent for backtracking", () => {
    const c = createCampaign("camp1", "plan.md", rootAction);
    const childId = createChild(c.tree, "root", childAction);
    beginExpansion(c.tree, childId);

    const parentId = failNode(c.tree, childId, "tests failed");
    expect(parentId).toBe("root");
    expect(c.tree.get(childId)!.state).toBe("failed");
  });

  it("refuses to fail an already-verified node — symmetric with verifyNode's own re-verification guard", () => {
    // verifyNode already refuses to launder a verified node into a
    // different Critic result (see the "is verified and cannot receive a
    // different Critic result" guard above). A late/duplicate failure
    // evidence delivery for the same node id must be refused the same way:
    // "verified" is meant to retire the branch, not remain overwritable by
    // whichever terminal call happens to land second.
    const c = createCampaign("camp1", "plan.md", rootAction);
    const childId = createChild(c.tree, "root", childAction);
    beginExpansion(c.tree, childId);
    const prov: Provenance = { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test" };
    verifyNode(c.tree, childId, prov, "all tests passed", 42.0);
    expect(c.tree.get(childId)!.state).toBe("verified");

    expect(() => failNode(c.tree, childId, "late duplicate failure evidence")).toThrow("verified");
    expect(c.tree.get(childId)!.state).toBe("verified");
  });

  it("prunes a node and all its children recursively", () => {
    const c = createCampaign("camp1", "plan.md", rootAction);
    const childId = createChild(c.tree, "root", childAction);
    const grandchildId = createChild(c.tree, childId, childAction);

    pruneNode(c.tree, childId);
    expect(c.tree.get(childId)!.state).toBe("pruned");
    expect(c.tree.get(grandchildId)!.state).toBe("pruned");
  });

  it("backtracks past a failed parent to the nearest valid ancestor", () => {
    const c = createCampaign("camp1", "plan.md", rootAction);
    // child (claimed) fails a grandchild, then the child itself fails under the root.
    const childId = createChild(c.tree, "root", childAction);
    const grandchildId = createChild(c.tree, childId, childAction);
    // Force the intermediate node into a failed state so its descendant's
    // backtrack must walk past it to reach the root.
    c.tree.get(childId)!.state = "failed";
    const parentId = failNode(c.tree, grandchildId, "grandchild broke");
    expect(parentId).toBe("root");
  });

  it("selectNode UCB category visits exclude an expanding node whose ancestor has failed (categoryVisits must apply the same isAlive check to expanding nodes it already applies to pending nodes)", () => {
    // `failNode` (unlike `pruneNode`) does not cascade into an already-failed
    // node's children — see "backtracks past a failed parent" above, which
    // exercises exactly this shape for the ancestor-walk. A node can be left
    // "expanding" (e.g. mid-specialist-dispatch, or already decomposed with
    // children of its own — see attemptDecomposition in arbor-opencode's
    // loop.ts, which leaves the decomposed node "expanding" permanently)
    // under a parent that later fails. `selectNode`'s categoryVisits loop
    // counts every "expanding" node's visit_count unconditionally, without
    // the isAlive(ancestor-path-valid) check it already applies to "pending"
    // nodes — so a stranded expanding descendant of a dead ancestor can
    // inflate its category's UCB denominator and suppress exploration of the
    // category's genuinely live arms.
    const c = createCampaign("camp1", "plan.md", rootAction);
    const deadParent = createChild(c.tree, "root", { ...childAction, category: "same" });
    const strandedExpanding = createChild(c.tree, deadParent, { ...childAction, category: "same" });
    beginExpansion(c.tree, strandedExpanding);
    c.tree.get(strandedExpanding)!.visit_count = 50;
    // Force the parent into a failed state without cascading into its
    // child, exactly as the "backtracks past a failed parent" test above
    // does — this is the reachable shape, not a synthetic one.
    c.tree.get(deadParent)!.state = "failed";

    // Two otherwise-identical pending candidates, differing only by
    // category: one shares the stranded node's ("same") category, the
    // other does not. Absent the bug both start at categoryVisits 0 and the
    // tie goes to whichever was inserted first (`pendingSame`, by
    // `selectNode`'s strict `score > bestScore`). If the stranded
    // expanding node's 50 visits leak into "same"'s categoryVisits, its
    // exploration bonus collapses relative to "other" and `pendingOther`
    // wins instead.
    const pendingSame = createChild(c.tree, "root", { ...childAction, category: "same" });
    const pendingOther = createChild(c.tree, "root", { ...childAction, category: "other" });
    const highExplore = { exploration_constant: Math.SQRT2 };
    const selected = selectNode(c.tree, ctx, highExplore);
    expect(selected).toBe(pendingSame);
    expect(selected).not.toBe(pendingOther);
  });

  it("selectNode UCB category visits exclude dead (failed/pruned) nodes", () => {
    const c = createCampaign("camp1", "plan.md", rootAction);
    // Two pending children in the SAME category; one will be failed and pruned.
    const a = createChild(c.tree, "root", { ...childAction, category: "same" });
    const b = createChild(c.tree, "root", { ...childAction, category: "same" });
    // Fail + prune a so its (added) visit count must not inflate b's category n_cat.
    c.tree.get(a)!.state = "failed";
    c.tree.get(a)!.visit_count = 50;
    pruneNode(c.tree, a);
    // b is the only living arm; its category visit count must be 0 (not 50).
    // With exploration_constant high, selecting b must not be suppressed by a's dead 50 visits.
    const highExplore = { exploration_constant: Math.SQRT2 };
    // Score b's category as if it were unexplored (should still be selectable at all).
    expect(selectNode(c.tree, ctx, highExplore)).toBe(b);
  });

  it("ADR-claimed-nodes-do-not-steer-selection: a claimed sibling's visits do not inflate its category's UCB count, and the claimed node itself is never re-selected", () => {
    const c = createCampaign("camp1", "plan.md", rootAction);
    // Two siblings in the SAME category. One critic-approves to "claimed"
    // (unverified provenance) with a large visit_count; the other stays pending.
    const a = createChild(c.tree, "root", { ...childAction, category: "same" });
    const b = createChild(c.tree, "root", { ...childAction, category: "same" });
    beginExpansion(c.tree, a);
    verifyNode(c.tree, a, { tag: "critic_approved", critic: "lenticel", rationale: "looks fine, unverified" }, "output", 0.9);
    expect(c.tree.get(a)!.state).toBe("claimed");
    c.tree.get(a)!.visit_count = 50;
    // A claimed node's success also backpropagates outcome=1 up the tree,
    // raising its own value_estimate — but the classic UCT score selectNode
    // uses never reads value_estimate, so this must not change which sibling
    // wins selection either.
    backpropagate(c.tree, a, 1);
    expect(c.tree.get(a)!.value_estimate).toBeGreaterThan(0);
    const highExplore = { exploration_constant: Math.SQRT2 };
    // b is the only pending arm; a's 50 visits and raised value_estimate must
    // not suppress b's exploration term, and a (claimed, not pending) must
    // never be the thing selectNode returns.
    expect(selectNode(c.tree, ctx, highExplore)).toBe(b);
  });
});

describe("ADR-106 backpropagate", () => {
  it("initializes edge_visit_count and value_estimate to zero on a new child", () => {
    const c = createCampaign("camp1", "plan.md", rootAction);
    const childId = createChild(c.tree, "root", childAction);
    const node = c.tree.get(childId)!;
    expect(node.edge_visit_count).toBe(0);
    expect(node.value_estimate).toBe(0);
  });

  it("ADR-133: increments edge_visit_count and updates value_estimate via min-form (weakest-link) along the path to the root", () => {
    const c = createCampaign("camp1", "plan.md", rootAction);
    const childId = createChild(c.tree, "root", childAction);
    const grandchildId = createChild(c.tree, childId, { ...childAction, description: "sub-task" });

    backpropagate(c.tree, grandchildId, 1);

    // First backpropagation on an edge sets value_estimate to the outcome
    // outright (there is no real prior observation to take a minimum
    // against — the 0 a fresh node initializes to is a placeholder).
    expect(c.tree.get(grandchildId)).toMatchObject({ edge_visit_count: 1, value_estimate: 1 });
    expect(c.tree.get(childId)).toMatchObject({ edge_visit_count: 1, value_estimate: 1 });
    expect(c.tree.get("root")).toMatchObject({ edge_visit_count: 1, value_estimate: 1 });

    backpropagate(c.tree, grandchildId, 0);

    // Min-form (weakest-link): the worst outcome ever backpropagated through
    // an edge wins, so a single 0 after a 1 drags value_estimate to 0 at
    // every node on the path — never back up, unlike a running average.
    expect(c.tree.get(grandchildId)).toMatchObject({ edge_visit_count: 2, value_estimate: 0 });
    expect(c.tree.get(childId)).toMatchObject({ edge_visit_count: 2, value_estimate: 0 });
    expect(c.tree.get("root")).toMatchObject({ edge_visit_count: 2, value_estimate: 0 });
  });

  it("leaves a sibling subtree's edge_visit_count/value_estimate untouched", () => {
    const c = createCampaign("camp1", "plan.md", rootAction);
    const a = createChild(c.tree, "root", { ...childAction, description: "branch A" });
    const b = createChild(c.tree, "root", { ...childAction, description: "branch B" });

    backpropagate(c.tree, a, 1);

    expect(c.tree.get(a)).toMatchObject({ edge_visit_count: 1 });
    expect(c.tree.get(b)).toMatchObject({ edge_visit_count: 0, value_estimate: 0 });
    // The shared root ancestor DOES accumulate branch A's backpropagation.
    expect(c.tree.get("root")).toMatchObject({ edge_visit_count: 1, value_estimate: 1 });
  });

  it("rejects a non-finite outcome rather than writing NaN into the tree", () => {
    const c = createCampaign("camp1", "plan.md", rootAction);
    const childId = createChild(c.tree, "root", childAction);
    expect(() => backpropagate(c.tree, childId, Number.NaN)).toThrow();
    expect(() => backpropagate(c.tree, childId, Number.POSITIVE_INFINITY)).toThrow();
    // Neither rejected call mutated the node.
    expect(c.tree.get(childId)).toMatchObject({ edge_visit_count: 0, value_estimate: 0 });
  });

  it("throws for an unknown node id", () => {
    const c = createCampaign("camp1", "plan.md", rootAction);
    expect(() => backpropagate(c.tree, "does-not-exist", 1)).toThrow();
  });

  // O3: backpropagate reuses failNode's ancestor-walk pattern for its own
  // statistics update, but the two concerns stay additive — running
  // backpropagate after failNode must not change which node failNode
  // already returned as the backtrack target.
  it("does not change failNode's own backtrack-target selection when backpropagate runs on the same tree afterward", () => {
    const c = createCampaign("camp1", "plan.md", rootAction);
    const childId = createChild(c.tree, "root", childAction);
    beginExpansion(c.tree, childId);

    const backtrackTarget = failNode(c.tree, childId, "tests failed");
    expect(backtrackTarget).toBe("root");
    expect(c.tree.get(childId)!.state).toBe("failed");

    // Backpropagate the failure along the same path AFTER failNode ran —
    // this must not retroactively change failNode's already-returned value,
    // nor the terminal state failNode already set.
    backpropagate(c.tree, childId, 0);

    expect(backtrackTarget).toBe("root");
    expect(c.tree.get(childId)!.state).toBe("failed");
    expect(c.tree.get(childId)).toMatchObject({ edge_visit_count: 1, value_estimate: 0 });
    expect(c.tree.get("root")).toMatchObject({ edge_visit_count: 1, value_estimate: 0 });
  });
});

describe("ADR-012 recovery tree transitions", () => {
  it("returns an interrupted node to pending with linkage only, preserving result fields and visit count", () => {
    const c = createCampaign("camp1", "plan.md", rootAction);
    const childId = createChild(c.tree, "root", childAction);
    beginExpansion(c.tree, childId);
    const node = c.tree.get(childId)!;
    node.specialist_output = "incomplete output";
    const visits = node.visit_count;
    retryInterruptedNode(c.tree, childId, retryAttempt);
    expect(node).toMatchObject({ state: "pending", specialist_output: "incomplete output", visit_count: visits, recovery_attempts: [retryAttempt] });
    expect(selectNode(c.tree, ctx, DEFAULT_SCORE_CONFIG)).toBe(childId);
  });

  it("uses abandoned as a nonselectable governance outcome without creating critic failure or pruning evidence", () => {
    const c = createCampaign("camp1", "plan.md", rootAction);
    const childId = createChild(c.tree, "root", childAction);
    const grandchildId = createChild(c.tree, childId, { ...childAction, description: "preserved child" });
    abandonInterruptedNode(c.tree, childId, abandonment);
    const node = c.tree.get(childId)!;
    expect(node).toMatchObject({ state: "abandoned", provenance: null, recovery_attempts: [abandonment] });
    expect(node.specialist_output).toBeUndefined();
    expect(c.tree.get(grandchildId)!.state).toBe("pending");
    expect(selectNode(c.tree, ctx, DEFAULT_SCORE_CONFIG)).not.toBe(grandchildId);
    expect(() => retryInterruptedNode(c.tree, childId, retryAttempt)).toThrow("not interrupted");
    expect(() => failNode(c.tree, childId, "not a critic rejection")).toThrow("abandoned");
    pruneNode(c.tree, childId);
    expect(node.state).toBe("abandoned");
  });

  it("rejects invalid or duplicate recovery linkage without changing the node state", () => {
    const c = createCampaign("camp1", "plan.md", rootAction);
    const childId = createChild(c.tree, "root", childAction);
    beginExpansion(c.tree, childId);
    retryInterruptedNode(c.tree, childId, retryAttempt);
    expect(() => retryInterruptedNode(c.tree, childId, retryAttempt)).toThrow("already linked");
    expect(c.tree.get(childId)!.state).toBe("pending");
    expect(() => abandonInterruptedNode(c.tree, childId, { ...abandonment, actor_role: "specialist" as "operator" })).toThrow("operator or auditor");
    expect(c.tree.get(childId)!.state).toBe("pending");
  });
});
