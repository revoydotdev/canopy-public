/**
 * arbor-core/tests/tree-recovery.invariant.test.ts — Phase 5.2 ADR-012 recovery invariants.
 *
 * Asserts the tree-recovery invariants:
 *
 *   - Retry recovery requires a fresh lease (stale/absent lease is rejected).
 *   - Retry recovery requires a fresh operation id (duplicate linkage rejected).
 *   - Interruption recovery requires fresh authority (abandon requires an
 *     operator/auditor role; a specialist cannot authorize abandonment).
 *   - Recovery never silently requeues partial work: retry returns the node to
 *     pending with linkage only — it does not dispatch work, manufacture a
 *     critic verdict, or fabricate an outcome.
 *   - A failed recovery attempt leaves the node state unchanged (no false tree
 *     transition on failure).
 *
 * These tests assert EXISTING behavior; they do not invent new authority
 * semantics. They import only from @arbor/core.
 */

import { describe, it, expect } from "vitest";
import {
  createCampaign,
  createChild,
  beginExpansion,
  interruptNode,
  retryInterruptedNode,
  abandonInterruptedNode,
  verifyNode,
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

const interruptProv: Provenance = { tag: "generated", generator: "runtime", input_hash: "sha:interrupt" };

const retryAttempt: RecoveryAttempt = {
  action: "retry", operation_id: "recovery-2", prior_operation_id: "recovery-1", actor_id: "crown",
  reason: "fresh isolation passed", expected_version: "snapshot-1", lease_id: "lease-2", recorded_at: "2026-08-01T12:00:00.000Z",
};

const abandonment: RecoveryAbandonment = {
  action: "abandon", operation_id: "recovery-abandon", prior_operation_id: "recovery-1", actor_id: "operator",
  actor_role: "operator", reason: "lease ambiguity preserved for audit", expected_version: "snapshot-1", recorded_at: "2026-08-01T12:00:00.000Z",
};

/** Build a campaign with one interrupted child node. */
function interruptedChild(): { tree: Map<string, import("../src/types.js").TreeNode>; childId: string } {
  const c = createCampaign("camp1", "plan.md", rootAction);
  const childId = createChild(c.tree, "root", childAction);
  beginExpansion(c.tree, childId);
  interruptNode(c.tree, childId, {
    operation_id: "interrupt-1",
    scope: "node",
    provenance: interruptProv,
    reason: "operator stop",
  });
  return { tree: c.tree, childId };
}

describe("ADR-012: retry requires fresh authority", () => {
  it("rejects a retry without a fresh lease_id", () => {
    const { tree, childId } = interruptedChild();
    const stale = { ...retryAttempt, lease_id: "" };
    expect(() => retryInterruptedNode(tree, childId, stale)).toThrow("fresh lease_id");
    // No false transition: the node stays interrupted.
    expect(tree.get(childId)!.state).toBe("interrupted");
  });

  it("rejects a retry with a duplicate operation id (stale authority)", () => {
    const { tree, childId } = interruptedChild();
    retryInterruptedNode(tree, childId, retryAttempt);
    expect(() => retryInterruptedNode(tree, childId, retryAttempt)).toThrow("already linked");
    expect(tree.get(childId)!.state).toBe("pending");
  });

  it("rejects a retry on a node that is not interrupted (verified)", () => {
    const c = createCampaign("camp2", "plan.md", rootAction);
    const childId = createChild(c.tree, "root", childAction);
    beginExpansion(c.tree, childId);
    verifyNode(c.tree, childId, { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test"}, "ok", 10);
    // A verified node is not interrupted and cannot be retried.
    expect(() => retryInterruptedNode(c.tree, childId, retryAttempt)).toThrow("not interrupted");
    expect(c.tree.get(childId)!.state).toBe("verified");
  });
});

describe("ADR-012: interruption recovery requires fresh authority", () => {
  it("abandon requires an operator or auditor role", () => {
    const { tree, childId } = interruptedChild();
    const unauthorized = { ...abandonment, actor_role: "specialist" as "operator" };
    expect(() => abandonInterruptedNode(tree, childId, unauthorized)).toThrow("operator or auditor");
    expect(tree.get(childId)!.state).toBe("interrupted");
  });

  it("abandon is a nonselectable governance outcome, not a critic failure", () => {
    const { tree, childId } = interruptedChild();
    abandonInterruptedNode(tree, childId, abandonment);
    const node = tree.get(childId)!;
    expect(node.state).toBe("abandoned");
    expect(node.provenance).toBeNull();
    // Abandon preserves the interrupted outcome as evidence; it does not
    // manufacture a critic verdict.
    expect(node.outcome?.kind).not.toBe("verdict");
    expect(node.critic_verdict).toBeUndefined();
    // Abandoned nodes are not re-selectable.
    expect(selectNode(tree, ctx, DEFAULT_SCORE_CONFIG)).not.toBe(childId);
  });
});

describe("ADR-012: no silent requeue of partial work", () => {
  it("retry returns the node to pending with linkage only — no outcome manufactured", () => {
    const { tree, childId } = interruptedChild();
    const node = tree.get(childId)!;
    node.specialist_output = "incomplete output";
    const visits = node.visit_count;

    retryInterruptedNode(tree, childId, retryAttempt);

    expect(node.state).toBe("pending");
    // Partial work is preserved, not silently requeued as fresh.
    expect(node.specialist_output).toBe("incomplete output");
    expect(node.visit_count).toBe(visits);
    // No critic verdict or outcome is manufactured by recovery.
    expect(node.outcome).toBeUndefined();
    expect(node.critic_verdict).toBeUndefined();
    // Linkage is recorded for audit.
    expect(node.recovery_attempts).toEqual([retryAttempt]);
  });

  it("a failed recovery attempt leaves the node state unchanged", () => {
    const { tree, childId } = interruptedChild();
    const before = tree.get(childId)!.state;
    expect(() => retryInterruptedNode(tree, childId, { ...retryAttempt, lease_id: "" })).toThrow();
    expect(tree.get(childId)!.state).toBe(before);
    expect(tree.get(childId)!.recovery_attempts).toBeUndefined();
  });
});
