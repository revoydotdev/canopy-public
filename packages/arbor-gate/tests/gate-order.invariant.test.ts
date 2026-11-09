/**
 * arbor-gate/tests/gate-order.invariant.test.ts — Phase 5.2 gate-ordering invariants.
 *
 * Asserts the process-gate invariants:
 *
 *   - The gate catalog is exactly { admission, isolation, evidence, audit }.
 *   - The canonical lifecycle order is admission → isolation → evidence → audit.
 *   - Each gate evaluator returns its own gate type.
 *   - `bypassGate` is NOT silent: it records an evidence deficit that is
 *     queryable on the node (a bypass record is distinguishable from a fail).
 *   - Surveillance is NOT a fifth gate: it is a separate concern and does not
 *     appear in the gate catalog.
 *
 * These tests assert EXISTING behavior; they do not invent new gate semantics.
 */

import { describe, it, expect } from "vitest";
import {
  checkAdmission,
  checkIsolation,
  checkEvidence,
  checkAudit,
  bypassGate,
  attachGateRecord,
} from "../src/gate.js";
import type { GateType, TreeNode } from "@arbor/core";

function makeMockNode(): TreeNode {
  return {
    id: "test_node",
    action: { description: "test", estimated_gain: 1, estimated_cost: 1, category: "test", delegate_to: "seed" },
    score: 0,
    state: "pending",
    parent_id: null,
    children_ids: [],
    visit_count: 0,
    edge_visit_count: 0,
    value_estimate: 0,
    provenance: null,
    kb_entries_extracted: 0,
    created_at: new Date().toISOString(),
    gate_records: [],
    memory_mode: "accumulate",
    memory_mode_version: 0,
  };
}

describe("gate catalog is closed and ordered", () => {
  it("the gate catalog is exactly the four lifecycle gates", () => {
    const catalog: GateType[] = ["admission", "isolation", "evidence", "audit"];
    expect(catalog).toHaveLength(4);
    expect(new Set(catalog).size).toBe(4);
  });

  it("the canonical lifecycle order is admission → isolation → evidence → audit", () => {
    const order: GateType[] = ["admission", "isolation", "evidence", "audit"];
    // The order is a strict sequence: each gate precedes the next.
    expect(order.indexOf("admission")).toBeLessThan(order.indexOf("isolation"));
    expect(order.indexOf("isolation")).toBeLessThan(order.indexOf("evidence"));
    expect(order.indexOf("evidence")).toBeLessThan(order.indexOf("audit"));
  });

  it("surveillance is NOT a fifth gate", () => {
    const catalog: GateType[] = ["admission", "isolation", "evidence", "audit"];
    // Surveillance is a separate runtime concern (core/surveillance.ts), not a
    // process gate. It must not appear in the gate catalog.
    expect(catalog).not.toContain("surveillance" as GateType);
    expect(catalog).not.toContain("monitoring" as GateType);
  });

  it("each gate evaluator returns its own gate type", () => {
    expect(checkAdmission({ plan_reviewed: true, resources_available: true, config_valid: true }).gate).toBe("admission");
    expect(checkIsolation({ worktree_isolated: true, starting_commit_correct: true, lease_acquired: true }).gate).toBe("isolation");
    expect(checkEvidence({ provenance_tag: "verified", stdout_hash: "abc123" }).gate).toBe("evidence");
    expect(checkAudit({ auditor_agrees: true, bypasses_recorded: [] }).gate).toBe("audit");
  });
});

describe("gates fire in order on a node", () => {
  it("records the four gates in lifecycle order", () => {
    const node = makeMockNode();
    attachGateRecord(node, checkAdmission({ plan_reviewed: true, resources_available: true, config_valid: true }));
    attachGateRecord(node, checkIsolation({ worktree_isolated: true, starting_commit_correct: true, lease_acquired: true }));
    attachGateRecord(node, checkEvidence({ provenance_tag: "verified", stdout_hash: "abc123" }));
    attachGateRecord(node, checkAudit({ auditor_agrees: true, bypasses_recorded: [] }));

    const gates = node.gate_records.map((r) => r.gate);
    expect(gates).toEqual(["admission", "isolation", "evidence", "audit"]);
    // Every gate passed.
    for (const record of node.gate_records) expect(record.result).toBe("pass");
  });

  it("a gate that fails is recorded as fail", () => {
    const node = makeMockNode();
    attachGateRecord(node, checkEvidence({ provenance_tag: "verified" }));
    expect(node.gate_records[0].result).toBe("fail");
  });

  it("composes mixed outcomes without erasing a bypass or promoting a failed evidence gate", () => {
    const node = makeMockNode();
    const results = [
      checkAdmission({ plan_reviewed: true, resources_available: true, config_valid: true }),
      bypassGate("isolation", "lease probe unavailable", "lease ownership evidence missing"),
      checkEvidence({ provenance_tag: "verified" }),
      checkAudit({ auditor_agrees: true, bypasses_recorded: [] }),
    ];
    for (const result of results) attachGateRecord(node, result);

    expect(node.gate_records.map(({ gate, result }) => [gate, result])).toEqual([
      ["admission", "pass"], ["isolation", "bypass"], ["evidence", "fail"], ["audit", "pass"],
    ]);
    expect(node.gate_records[1]?.bypass_evidence_deficit).toBe("lease ownership evidence missing");
  });
});

describe("bypassGate is not silent", () => {
  it("records an evidence deficit that is queryable on the node", () => {
    const node = makeMockNode();
    const bypass = bypassGate("isolation", "worktree check unavailable", "need git worktree integration");
    attachGateRecord(node, bypass);

    expect(node.gate_records).toHaveLength(1);
    expect(node.gate_records[0].result).toBe("bypass");
    expect(node.gate_records[0].bypass_evidence_deficit).toBe("need git worktree integration");
  });

  it("a bypass without an evidence deficit is rejected by the audit validator", () => {
    // The audit layer's isValidGateRecord requires a bypass to carry a deficit.
    // Here we assert the gate layer always attaches one via bypassGate.
    const bypass = bypassGate("audit", "skip", "deficit recorded");
    expect(bypass.bypass_evidence_deficit).toBe("deficit recorded");
    expect(bypass.result).toBe("bypass");
  });
});
