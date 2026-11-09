import { describe, it, expect } from "vitest";
import {
  checkAdmission,
  checkIsolation,
  checkEvidence,
  checkAudit,
  checkFoldActivation,
  checkHarnessActivation,
  checkHarnessPromotion,
  bypassGate,
  attachGateRecord,
} from "../src/gate.js";
import type { FoldProposal, HarnessRevision, Provenance, RevisionEvaluation, TreeNode } from "@arbor/core";

const provenance: Provenance = { tag: "claimed", claimant: "seed" };
const evaluation = (overrides: Partial<RevisionEvaluation> = {}): RevisionEvaluation => ({
  outcome: "not_yet_measured", fidelity_ratio: null, main_model_tokens: null, child_model_tokens: null,
  latency_ms: null, regression_detected: false, rollback_count: 0, replay_evidence_ids: [], holdout_evidence_ids: [], ...overrides,
});
const fold = (overrides: Partial<FoldProposal> = {}): FoldProposal => ({
  id: "fold", campaign_id: "campaign", task_id: "task", node_id: "node", scale: "granular", source_event_ids: ["event"], source_message_ranges: [{ context_id: "context", thread_id: "root", start_communication_id: "message", end_communication_id: "message", start_byte: 0, end_byte: 1 }], retained_claims: ["claim"],
  omitted_artifacts: [{ id: "ctx_a", sha256: "a", media_type: "text/plain", byte_length: 1, campaign_id: "campaign", producer: "seed", visibility: "campaign", provenance }],
  output_artifact: { id: "ctx_b", sha256: "b", media_type: "text/plain", byte_length: 1, campaign_id: "campaign", producer: "seed", visibility: "campaign", provenance },
  measures: { expected_token_savings: 1 }, proposed_by: "seed", provenance, created_at: "2029-01-01T00:00:00.000Z", expires_at: "2030-01-01T00:00:00.000Z", ...overrides,
});
const revision = (overrides: Partial<HarnessRevision> = {}): HarnessRevision => ({
  id: "revision", campaign_id: "campaign", task_id: "task", component: "supplemental_prompt", patch: {}, source_event_ids: ["event"], source_message_ranges: [{ context_id: "context", thread_id: "root", start_communication_id: "message", end_communication_id: "message", start_byte: 0, end_byte: 1 }], expected_benefit: "better", proposed_by: "seed", provenance,
  created_at: "2029-01-01T00:00:00.000Z", expires_at: "2030-01-01T00:00:00.000Z", status: "proposed", evaluation: evaluation(), ...overrides,
});

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

describe("checkAdmission", () => {
  it("passes when all checks pass", () => {
    const result = checkAdmission({
      plan_reviewed: true,
      resources_available: true,
      config_valid: true,
    });
    expect(result.result).toBe("pass");
    expect(result.failures).toHaveLength(0);
  });

  it("fails when plan is not reviewed", () => {
    const result = checkAdmission({
      plan_reviewed: false,
      resources_available: true,
      config_valid: true,
    });
    expect(result.result).toBe("fail");
    expect(result.detail).toContain("plan not reviewed");
  });

  it("fails with multiple reasons when multiple checks fail", () => {
    const result = checkAdmission({
      plan_reviewed: false,
      resources_available: false,
      config_valid: false,
    });
    expect(result.result).toBe("fail");
    expect(result.failures).toHaveLength(3);
  });
});

describe("checkIsolation", () => {
  it("passes when worktree is isolated, commit correct, and lease acquired", () => {
    const result = checkIsolation({
      worktree_isolated: true,
      starting_commit_correct: true,
      lease_acquired: true,
    });
    expect(result.result).toBe("pass");
  });

  it("fails when worktree is not isolated", () => {
    const result = checkIsolation({
      worktree_isolated: false,
      starting_commit_correct: true,
      lease_acquired: true,
    });
    expect(result.result).toBe("fail");
    expect(result.detail).toContain("worktree not isolated");
  });

  it("fails when the isolated worktree starts from the wrong commit", () => {
    const result = checkIsolation({
      worktree_isolated: true,
      starting_commit_correct: false,
      lease_acquired: true,
    });
    expect(result.result).toBe("fail");
    expect(result.failures).toEqual(["starting commit mismatch"]);
  });

  it("fails when lease not acquired", () => {
    const result = checkIsolation({
      worktree_isolated: true,
      starting_commit_correct: true,
      lease_acquired: false,
    });
    expect(result.result).toBe("fail");
    expect(result.detail).toContain("no active lease");
  });
});

describe("checkEvidence", () => {
  it("passes for !verified with a real stdout_hash", () => {
    const result = checkEvidence({
      provenance_tag: "verified",
      stdout_hash: "abc123",
    });
    expect(result.result).toBe("pass");
  });

  it("fails for !verified with a missing stdout_hash", () => {
    const result = checkEvidence({
      provenance_tag: "verified",
      stdout_hash: undefined,
    });
    expect(result.result).toBe("fail");
    expect(result.failures).toEqual(["provenance is !verified but stdout_hash is missing or empty"]);
    expect(result.unresolved).toEqual([]);
    expect(result.detail).toContain("stdout_hash is missing or empty");
  });

  it("fails for !verified with an empty stdout_hash", () => {
    const result = checkEvidence({
      provenance_tag: "verified",
      stdout_hash: "",
    });
    expect(result.result).toBe("fail");
    expect(result.detail).toContain("stdout_hash is missing or empty");
  });

  it("fails for !verified with a nonzero exit", () => {
    const result = checkEvidence({ provenance_tag: "verified", exit_code: 1, stdout_hash: "sha256:real" });
    expect(result.result).toBe("fail");
    expect(result.failures).toContain("verified provenance requires exit code 0");
  });

  it("passes for !claimed (no hash needed)", () => {
    const result = checkEvidence({
      provenance_tag: "claimed",
    });
    expect(result.result).toBe("pass");
  });

  it("fails when provenance is null", () => {
    const result = checkEvidence({
      provenance_tag: null,
    });
    expect(result.result).toBe("fail");
    expect(result.detail).toContain("no provenance tag");
    expect(result.failures).toEqual([]);
    expect(result.unresolved).toEqual(["no provenance tag on result"]);
  });

  it("blocks Phantom Grounding when a real hash anchors evidence that does not contain the promoted file claim", () => {
    const result = checkEvidence({
      provenance_tag: "verified", stdout_hash: "sha256:real",
      promoted_claim: "Updated packages/arbor-core/src/types.ts; 42 tests passed; exited 0",
      evidence_text: "41 tests passed; exited 0",
    });
    expect(result.result).toBe("fail");
    expect(result.failures).toContain("claim file path absent from evidence: packages/arbor-core/src/types.ts");
    expect(result.failures).toContain("claim test count absent from evidence: 42");
  });

  it("accepts exact file, count, and exit-code containment", () => {
    const result = checkEvidence({
      provenance_tag: "verified", stdout_hash: "sha256:real",
      promoted_claim: "Updated docs/result.md; 42 tests passed; exit code 0",
      evidence_text: "docs/result.md\n42 tests passed\nexit code 0\n",
    });
    expect(result.result).toBe("pass");
  });

  it("rejects a promoted claim when independent evidence text is absent", () => {
    const result = checkEvidence({
      provenance_tag: "verified", stdout_hash: "sha256:real",
      promoted_claim: "Updated docs/result.md",
    });
    expect(result.failures).toEqual(["promoted claim has no independently observed evidence text"]);
  });

  it("rejects a promoted exit code that is absent from the evidence", () => {
    const result = checkEvidence({
      provenance_tag: "verified", stdout_hash: "sha256:real",
      promoted_claim: "exited 7",
      evidence_text: "exited 0",
    });
    expect(result.failures).toEqual(["claim exit code absent from evidence: 7"]);
  });

  // ADR-134 O2: EvidenceCheck now has somewhere to put scope, and
  // checkEvidence surfaces it additively without changing pass/fail.
  it("surfaces the caller-declared check/strength as GateResult.resolved_scope, and still passes", () => {
    const result = checkEvidence({
      provenance_tag: "verified", stdout_hash: "sha256:real",
      check: { kind: "shell_command", breadth: "subset" },
      strength: "command_executed",
    });
    expect(result.result).toBe("pass");
    expect(result.resolved_scope).toEqual({ check: { kind: "shell_command", breadth: "subset" }, strength: "command_executed" });
  });

  it("preserves either independently declared scope field without fabricating the other", () => {
    const checkOnly = checkEvidence({
      provenance_tag: "verified", stdout_hash: "sha256:real",
      check: { kind: "internal_integrity", breadth: "suite" },
    });
    const strengthOnly = checkEvidence({
      provenance_tag: "verified", stdout_hash: "sha256:real",
      strength: "outputs_check",
    });

    expect(checkOnly.resolved_scope).toEqual({ check: { kind: "internal_integrity", breadth: "suite" } });
    expect(strengthOnly.resolved_scope).toEqual({ strength: "outputs_check" });
  });

  it("leaves resolved_scope undefined — never a failure — when the caller declares no scope", () => {
    const result = checkEvidence({ provenance_tag: "verified", stdout_hash: "sha256:real" });
    expect(result.result).toBe("pass");
    expect(result.resolved_scope).toBeUndefined();
  });

  it("never sets resolved_scope for a non-verified tag even if check/strength were somehow supplied", () => {
    const result = checkEvidence({
      provenance_tag: "claimed",
      check: { kind: "shell_command", breadth: "suite" },
      strength: "outputs_check",
    });
    expect(result.result).toBe("pass");
    expect(result.resolved_scope).toBeUndefined();
  });
});

describe("checkAudit", () => {
  it("passes when auditor agrees", () => {
    const result = checkAudit({ auditor_agrees: true, bypasses_recorded: [] });
    expect(result.result).toBe("pass");
  });

  it("fails when auditor disagrees", () => {
    const result = checkAudit({ auditor_agrees: false, bypasses_recorded: [] });
    expect(result.result).toBe("fail");
    expect(result.detail).toContain("auditor disagrees");
  });
});

describe("governed context gates", () => {
  it("permits only independently reviewed, complete-fidelity folds", () => {
    expect(checkFoldActivation({ proposal: fold(), approver: "lenticel", fidelity_ratio: 1 }).result).toBe("pass");
    const rejected = checkFoldActivation({ proposal: fold({ proposed_by: "lenticel", source_event_ids: [], source_message_ranges: [], retained_claims: [], measures: { expected_token_savings: -1 } }), approver: "lenticel", fidelity_ratio: null });
    expect(rejected.failures).toEqual(expect.arrayContaining([expect.stringContaining("may not approve"), expect.stringContaining("source event"), expect.stringContaining("message-range"), expect.stringContaining("retained"), expect.stringContaining("non-negative"), expect.stringContaining("fidelity")]));
    expect(checkFoldActivation({ proposal: fold({ omitted_artifacts: [{ ...fold().omitted_artifacts[0]!, id: "", sha256: "" }] }), approver: "lenticel", fidelity_ratio: 1 }).detail).toContain("content-addressed");
  });

  it("allows only independent, evidenced, expiring local harness activation", () => {
    expect(checkHarnessActivation({ revision: revision(), approver: "lenticel" }).result).toBe("pass");
    const rejected = checkHarnessActivation({ revision: revision({ component: "base_prompt", proposed_by: "lenticel", source_event_ids: [], expires_at: "" }), approver: "lenticel" });
    expect(rejected.failures).toHaveLength(4);
  });

  it("requires independent human-reviewed replay and holdout evidence for campaign-local promotion evidence", () => {
    expect(checkHarnessPromotion({ revision: revision({ status: "active", approved_by: "lenticel", evaluation: evaluation({ outcome: "improved", replay_evidence_ids: ["replay"], holdout_evidence_ids: ["holdout"] }) }), human_approver: "operator" }).result).toBe("pass");
    const rejected = checkHarnessPromotion({ revision: revision({ component: "base_prompt", evaluation: evaluation({ outcome: "regressed", regression_detected: true }) }), human_approver: " " });
    expect(rejected.failures).toEqual(expect.arrayContaining([expect.stringContaining("human approval"), expect.stringContaining("prior Lenticel"), expect.stringContaining("measured improvement")]));
    const selfPromoted = checkHarnessPromotion({ revision: revision({ status: "active", approved_by: "lenticel", evaluation: evaluation({ outcome: "improved", replay_evidence_ids: ["replay"], holdout_evidence_ids: ["holdout"] }) }), human_approver: "seed" });
    expect(selfPromoted.failures).toContain("human promoter must be distinct from revision proposer");
    const criticPromoted = checkHarnessPromotion({ revision: revision({ status: "active", approved_by: "operator", evaluation: evaluation({ outcome: "improved", replay_evidence_ids: ["replay"], holdout_evidence_ids: ["holdout"] }) }), human_approver: "operator" });
    expect(criticPromoted.failures).toContain("human promoter must be distinct from activating critic");
  });
});

describe("bypassGate", () => {
  it("creates a bypass record with evidence deficit", () => {
    const result = bypassGate("isolation", "worktree check not available in this env", "need git worktree integration");
    expect(result.result).toBe("bypass");
    expect(result.bypass_evidence_deficit).toBe("need git worktree integration");
  });

  it.each([
    ["empty reason", "", "need external evidence"],
    ["blank reason", "  \n", "need external evidence"],
    ["empty deficit", "probe unavailable", ""],
    ["blank deficit", "probe unavailable", " \t "],
  ])("rejects a bypass with %s", (_case, reason, deficit) => {
    expect(() => bypassGate("evidence", reason, deficit)).toThrow(/non-empty/);
  });
});

describe("attachGateRecord", () => {
  it("attaches a gate record to a node", () => {
    const node = makeMockNode();
    const passResult = checkAdmission({ plan_reviewed: true, resources_available: true, config_valid: true });
    attachGateRecord(node, passResult);

    expect(node.gate_records).toHaveLength(1);
    expect(node.gate_records[0]).toMatchObject({ gate: "admission", result: "pass" });
  });

  it("attaches a bypass record with its evidence deficit intact", () => {
    const node = makeMockNode();
    const bypass = bypassGate("evidence", "skip", "need verification cmd");
    attachGateRecord(node, bypass);
    expect(node.gate_records[0]).toMatchObject({ gate: "evidence", result: "bypass", bypass_evidence_deficit: "need verification cmd" });
  });
});
