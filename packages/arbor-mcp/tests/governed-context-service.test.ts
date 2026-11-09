import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GovernedContextService } from "../src/governed-context-service.js";
import type { FoldProposal, HarnessRevision, PlaybookDelta, Provenance, RevisionEvaluation } from "@arbor/core";

const provenance: Provenance = { tag: "claimed", claimant: "seed" };
const expires = "2030-01-01T00:00:00.000Z";
const evaluation = (overrides: Partial<RevisionEvaluation> = {}): RevisionEvaluation => ({
  outcome: "not_yet_measured", fidelity_ratio: null, main_model_tokens: null, child_model_tokens: null,
  latency_ms: null, regression_detected: false, rollback_count: 0, replay_evidence_ids: [], holdout_evidence_ids: [], ...overrides,
});

function artifact(service: GovernedContextService, content = "0123456789") {
  return service.captureArtifact({ campaign_id: "c", media_type: "text/plain", producer: "seed", visibility: "campaign", provenance, content });
}

function fold(service: GovernedContextService, output = artifact(service, "folded")): FoldProposal {
  const omitted = artifact(service, "full transcript");
  return {
    id: "fold-1", campaign_id: "c", task_id: "task-1", node_id: "n", scale: "granular", source_event_ids: ["event-1"], source_message_ranges: [{ context_id: "parent-child", thread_id: "root", start_communication_id: "message-1", end_communication_id: "message-1", start_byte: 0, end_byte: 4 }], retained_claims: ["test passed"],
    omitted_artifacts: [omitted], output_artifact: output, measures: { expected_token_savings: 5 }, proposed_by: "seed", provenance,
    created_at: "2029-01-01T00:00:00.000Z", expires_at: expires,
  };
}

function revision(component: HarnessRevision["component"] = "supplemental_prompt"): Omit<HarnessRevision, "status" | "evaluation"> {
  return {
    id: "revision-1", campaign_id: "c", task_id: "task-1", component, patch: { guidance: "prefer focused evidence" }, source_event_ids: ["event-1"], source_message_ranges: [{ context_id: "parent-child", thread_id: "root", start_communication_id: "message-1", end_communication_id: "message-1", start_byte: 0, end_byte: 4 }],
    expected_benefit: "reduce repeated investigation", proposed_by: "seed", provenance, created_at: "2029-01-01T00:00:00.000Z", expires_at: expires,
  };
}

describe("GovernedContextService", () => {
  it("content-addresses raw artifacts and exposes bounded, visibility-gated read-only windows", () => {
    const service = new GovernedContextService();
    const ref = artifact(service, "abcdefghij");
    expect(ref.id).toMatch(/^ctx_[a-f0-9]{64}$/);
    expect(service.readWorkspace({ artifact_id: ref.id, offset: 2, max_bytes: 3, visibility: "campaign" })).toMatchObject({ offset: 2, content: "cde", truncated: true });
    const criticOnly = service.captureArtifact({ campaign_id: "c", media_type: "text/plain", producer: "lenticel", visibility: "critic_only", provenance, content: "secret" });
    expect(() => service.readWorkspace({ artifact_id: criticOnly.id, visibility: "campaign" })).toThrow(/critic visibility/);
    expect(service.readWorkspace({ artifact_id: criticOnly.id, visibility: "critic_only" }).content).toBe("secret");
    expect(() => service.readWorkspace({ artifact_id: "ctx_missing", visibility: "campaign" })).toThrow(/not found/);
  });

  it("activates only independently approved, source-complete, fidelity-complete folds and can roll them back", () => {
    const service = new GovernedContextService();
    const proposal = fold(service);
    expect(service.proposeFold(proposal).status).toBe("proposed");
    expect(() => service.approveFold(proposal.id, "seed", 1)).toThrow(/requires distinct critic/);
    expect(() => service.approveFold(proposal.id, "lenticel", 0.99)).toThrow(/fidelity/);
    expect(service.approveFold(proposal.id, "lenticel", 1)).toMatchObject({ status: "active", approved_by: "lenticel" });
    expect(service.overlays("c").active_folds).toHaveLength(1);
    expect(service.rollbackFold(proposal.id, "operator")).toMatchObject({ status: "rolled_back" });
  });

  it("refuses a fold whose output artifact belongs to a different campaign, at proposal and at checkpoint", () => {
    // `requireArtifact` only checks that an artifact id exists in the
    // content-addressed store; it never confirms the artifact's own
    // campaign_id matches the fold's declared campaign_id. A fold for
    // campaign "c" must never be able to smuggle campaign "other"'s content
    // into "c"'s specialist/critic context.
    const service = new GovernedContextService();
    const foreignOutput = service.captureArtifact({ campaign_id: "other", media_type: "text/plain", producer: "seed", visibility: "campaign", provenance, content: "belongs to a different campaign" });
    const proposal = fold(service, foreignOutput);
    expect(() => service.proposeFold(proposal)).toThrow(/campaign/);
    expect(service.overlays("c").active_folds).toHaveLength(0);
    expect(() => service.rollbackFold(proposal.id, "operator")).toThrow(/not found/);
  });

  it("preserves a retained-fact floor across successive compaction cycles", () => {
    const service = new GovernedContextService();
    const requiredFacts = ["tests pass", "authority remains separate", "raw evidence retained"];
    const retainedCounts: number[] = [];
    let prior: string | undefined;
    for (let cycle = 1; cycle <= 6; cycle += 1) {
      const proposal = {
        ...fold(service, artifact(service, `folded cycle ${cycle}`)),
        id: `collapse-regression-${cycle}`,
        retained_claims: [...requiredFacts],
        ...(prior === undefined ? {} : { supersedes_fold_id: prior }),
      };
      const record = service.proposeFold(proposal);
      retainedCounts.push(record.retained_claims.length);
      prior = record.id;
    }
    expect(retainedCounts).toHaveLength(6);
    expect(Math.min(...retainedCounts)).toBeGreaterThanOrEqual(requiredFacts.length);
    expect(retainedCounts.some((count, index) => index > 0 && count < retainedCounts[index - 1]!)).toBe(false);
  });

  it("rejects fold proposals that point to raw evidence the workspace does not own", () => {
    const service = new GovernedContextService();
    const proposal = fold(service);
    expect(() => service.proposeFold({ ...proposal, id: "unknown-ref", output_artifact: { ...proposal.output_artifact, id: "ctx_missing" } })).toThrow(/unknown context artifact/);
    expect(() => service.proposeFold({ ...proposal, id: "no-claims", retained_claims: [] })).toThrow(/source events/);
    expect(() => service.proposeFold({ ...proposal, id: "negative", measures: { expected_token_savings: -1 } })).toThrow(/non-negative/);
  });

  it("keeps ACE-style playbook deltas campaign-local and independently curated", () => {
    const service = new GovernedContextService();
    const delta: Omit<PlaybookDelta, "status"> = {
      id: "playbook-1", campaign_id: "c", task_id: "task-1", kind: "add", patch: { lesson: "run focused test first" }, source_event_ids: ["event-1"], source_message_ranges: [{ context_id: "parent-child", thread_id: "root", start_communication_id: "message-1", end_communication_id: "message-1", start_byte: 0, end_byte: 4 }],
      observed_outcome: "avoided repeat failure", counter_evidence: [], proposed_by: "seed", provenance, created_at: "2029-01-01T00:00:00.000Z", expires_at: expires,
    };
    expect(service.proposePlaybook(delta).status).toBe("proposed");
    expect(() => service.approvePlaybook(delta.id, "seed")).toThrow(/requires distinct critic/);
    expect(service.approvePlaybook(delta.id, "lenticel")).toMatchObject({ status: "active", approved_by: "lenticel" });
    expect(service.overlays("c").active_playbook).toHaveLength(1);
    expect(() => service.proposePlaybook({ ...delta, id: "no-evidence", source_event_ids: [] })).toThrow(/source evidence/);
  });

  it("allowlists campaign-local harness revisions, requires independent activation, and gates promotion on replay, holdout and human approval", () => {
    const service = new GovernedContextService();
    expect(() => service.proposeRevision(revision("base_prompt"))).toThrow(/forbidden/);
    expect(service.proposeRevision(revision()).status).toBe("proposed");
    expect(() => service.approveRevision("revision-1", "seed")).toThrow(/requires distinct critic/);
    expect(service.approveRevision("revision-1", "lenticel")).toMatchObject({ status: "active", approved_by: "lenticel" });
    expect(() => service.promoteRevision("revision-1", "human")).toThrow(/durable measured hermetic evaluation run/);
    const evidence = (runId: string, partition: "replay" | "holdout", scenario: string = partition) => service.captureArtifact({
      campaign_id: "c", media_type: "application/vnd.arbor.overlay-evaluation+json", producer: "arbor-eval/governed-overlay", visibility: "critic_only",
      provenance: { tag: "generated", generator: "arbor-eval/governed-overlay", input_hash: `sha256:${scenario}` },
      content: JSON.stringify({ schema_version: 1, revision_id: "revision-1", evaluation_run_id: runId, scenario_id: scenario, partition }),
    }).id;
    const settle = (id: string, replayScenario: string, holdoutScenario: string) => {
      service.startEvaluation({ id, revision_id: "revision-1", requested_by: "operator", evaluator_id: "hermetic-evaluator" });
      const replay = evidence(id, "replay", replayScenario); const holdout = evidence(id, "holdout", holdoutScenario);
      service.settleEvaluation(id, { kind: "measured", evidence_ids: [replay, holdout], evaluation: evaluation({ outcome: "improved", fidelity_ratio: 1, main_model_tokens: 1, child_model_tokens: 1, latency_ms: 1, replay_evidence_ids: [replay], holdout_evidence_ids: [holdout] }) });
    };
    settle("measured-first", "replay-first", "holdout-first");
    // The legacy command remains an auditable observation, but even when it
    // follows a real evaluator result it cannot carry stale evaluator
    // authority into promotion.
    service.recordEvaluation("revision-1", evaluation({ outcome: "improved", fidelity_ratio: 1, replay_evidence_ids: ["forged-replay"], holdout_evidence_ids: ["forged-holdout"] }));
    expect(() => service.promoteRevision("revision-1", "human-operator")).toThrow(/current canonical evaluation projection/);
    settle("measured-fresh", "replay-fresh", "holdout-fresh");
    expect(() => service.promoteRevision("revision-1", "")).toThrow(/human approval/);
    expect(service.promoteRevision("revision-1", "human-operator").promotion?.approved_by_human).toBe("human-operator");
    expect(service.rollbackRevision("revision-1", "operator")).toMatchObject({ status: "rolled_back", evaluation: { rollback_count: 1 } });
  });

  it("samples only approved, unexpired campaign-local overlays at a checkpoint and states unsupported execution semantics", () => {
    const service = new GovernedContextService({ clock: () => "2029-06-01T00:00:00.000Z" });
    const output = artifact(service, "folded durable context");
    const proposedFold = fold(service, output);
    service.proposeFold(proposedFold); service.approveFold(proposedFold.id, "lenticel", 1);
    service.proposeRevision(revision()); service.approveRevision("revision-1", "lenticel");
    const retrieval = service.proposeRevision({ ...revision("retrieval_policy"), id: "retrieval", patch: { index_ids: ["campaign-index"], max_results: 4, query_scope: "campaign" } });
    service.approveRevision(retrieval.id, "lenticel");
    const checkpoint = service.checkpoint({ campaign_id: "c", node_id: "node", as_of: "2029-06-01T00:00:00.000Z" });
    expect(checkpoint.specialist_context).toEqual(["folded durable context"]);
    expect(checkpoint.critic_context).toEqual(["folded durable context"]);
    expect(checkpoint.specialist_prompt_fragments).toEqual(["prefer focused evidence"]);
    expect(checkpoint.applied_overlay_ids).toEqual(expect.arrayContaining(["fold-1", "revision-1"]));
    expect(checkpoint.unapplied_overlays).toEqual([{ id: "retrieval", reason: "no capability-gated isolated retrieval/index adapter is configured" }]);
    expect(service.list("c").revisions.find((item) => item.id === "retrieval")?.campaign_id).toBe("c");
  });

  it("expires a revision before a checkpoint rather than resurrecting it after restart", () => {
    const service = new GovernedContextService({ clock: () => "2031-01-01T00:00:00.000Z" });
    const stale = { ...revision(), expires_at: "2030-01-01T00:00:00.000Z" };
    service.proposeRevision(stale);
    expect(() => service.approveRevision(stale.id, "lenticel")).toThrow(/expired/);

    const activated = new GovernedContextService({ clock: () => "2029-01-02T00:00:00.000Z" });
    activated.proposeRevision(stale); activated.approveRevision(stale.id, "lenticel");
    const later = activated.checkpoint({ campaign_id: "c", node_id: "n", as_of: "2031-01-01T00:00:00.000Z" });
    expect(later.applied_overlay_ids).toEqual([]);
    expect(activated.list("c").revisions).toMatchObject([{ id: stale.id, status: "expired" }]);
  });

  it("treats parent/subagent message ranges as bus evidence, not a second message authority", () => {
    const service = new GovernedContextService({ message_evidence: { hasMessageRange: (_campaign, range) => range.start_communication_id === "durable-parent-child" && range.end_communication_id === "durable-parent-child" } });
    const proposal = fold(service);
    expect(() => service.proposeFold({ ...proposal, source_message_ranges: [{ context_id: "parent-child", thread_id: "root", start_communication_id: "missing", end_communication_id: "missing", start_byte: 0, end_byte: 1 }] })).toThrow(/unknown durable message range/);
    expect(() => service.proposeFold({ ...proposal, source_message_ranges: [{ context_id: "parent-child", thread_id: "root", start_communication_id: "durable-parent-child", end_communication_id: "durable-parent-child", start_byte: 2, end_byte: 1 }] })).toThrow(/range is invalid/);
    expect(service.proposeFold({ ...proposal, source_message_ranges: [{ context_id: "parent-child", thread_id: "root", start_communication_id: "durable-parent-child", end_communication_id: "durable-parent-child", start_byte: 0, end_byte: 1 }] }).status).toBe("proposed");
  });

  it("accepts only bounded non-executable subagent descriptors", () => {
    const service = new GovernedContextService();
    expect(() => service.proposeRevision({ ...revision("subagent_descriptor"), patch: { descriptor: { role: "seed", objective: "inspect", allowed_context_artifact_ids: [], allowed_message_ranges: [], max_children: 1, recursive_delegation: true } } })).toThrow(/forbid recursive/);
    expect(() => service.proposeRevision({ ...revision("subagent_descriptor"), patch: { descriptor: { role: "seed", objective: "inspect", allowed_context_artifact_ids: [], allowed_message_ranges: [], max_children: 1, recursive_delegation: false }, command: "rm" } })).toThrow(/executable/);
    expect(() => service.proposeRevision({ ...revision("subagent_descriptor"), patch: { descriptor: { role: "seed", objective: "inspect", allowed_context_artifact_ids: [42], allowed_message_ranges: [], max_children: 1, recursive_delegation: false } } as unknown as Record<string, unknown> })).toThrow(/artifact ids must be strings/);
    expect(service.proposeRevision({ ...revision("subagent_descriptor"), id: "descriptor", patch: { descriptor: { role: "seed", objective: "inspect", allowed_context_artifact_ids: [], allowed_message_ranges: [], max_children: 1, recursive_delegation: false } } }).component).toBe("subagent_descriptor");
  });

  it("enacts retrieval and declarative descriptor overlays only through capability-gated, reference-only adapters", () => {
    const service = new GovernedContextService({ adapters: {
      capabilities: new Set(["context.retrieve", "subagent.describe"]),
      retrieval_index: { retrieve: () => [{ artifact_id: retrieved.id }] },
      declarative_subagent: { prepare: () => ({ artifact_ids: [descriptorContext.id] }) },
    } });
    const retrieved = artifact(service, "retrieved campaign evidence");
    const descriptorContext = artifact(service, "descriptor bounded context");
    const retrieval = service.proposeRevision({ ...revision("retrieval_policy"), id: "retrieval-adapter", patch: { index_ids: ["campaign-index"], max_results: 1, query_scope: "campaign" } });
    const descriptor = service.proposeRevision({ ...revision("subagent_descriptor"), id: "descriptor-adapter", patch: { descriptor: { role: "seed", objective: "inspect", allowed_context_artifact_ids: [descriptorContext.id], allowed_message_ranges: [], max_children: 0, recursive_delegation: false } } });
    service.approveRevision(retrieval.id, "lenticel"); service.approveRevision(descriptor.id, "lenticel");
    const checkpoint = service.checkpoint({ campaign_id: "c", node_id: "n", as_of: "2029-06-01T00:00:00.000Z" });
    expect(checkpoint.applied_overlay_ids).toEqual(expect.arrayContaining(["retrieval-adapter", "descriptor-adapter"]));
    expect(checkpoint.specialist_context).toEqual(expect.arrayContaining(["retrieved campaign evidence", "descriptor bounded context"]));
    expect(checkpoint.unapplied_overlays).toEqual([]);
  });

  it("never leaves partial adapter content in specialist/critic context when the same overlay is rejected as unapplied", () => {
    // The adapter returns one real, valid campaign artifact followed by one
    // reference it has no right to (unavailable/cross-campaign). The whole
    // overlay must be refused atomically: either its content is not present
    // at all, or the id must not appear in unapplied_overlays.
    const service = new GovernedContextService({ adapters: {
      capabilities: new Set(["context.retrieve"]),
      retrieval_index: { retrieve: () => [{ artifact_id: retrieved.id }, { artifact_id: "ctx_does-not-exist" }] },
    } });
    const retrieved = artifact(service, "should never leak to a rejected overlay");
    const retrieval = service.proposeRevision({ ...revision("retrieval_policy"), id: "retrieval-adapter", patch: { index_ids: ["campaign-index"], max_results: 2, query_scope: "campaign" } });
    service.approveRevision(retrieval.id, "lenticel");
    const checkpoint = service.checkpoint({ campaign_id: "c", node_id: "n", as_of: "2029-06-01T00:00:00.000Z" });
    expect(checkpoint.unapplied_overlays.map((o) => o.id)).toContain("retrieval-adapter");
    expect(checkpoint.applied_overlay_ids).not.toContain("retrieval-adapter");
    expect(checkpoint.specialist_context).not.toContain("should never leak to a rejected overlay");
    expect(checkpoint.critic_context).not.toContain("should never leak to a rejected overlay");
  });

  it("refuses a declarative-subagent adapter's context references that are not in the descriptor's own allowlist", () => {
    // A `subagent_descriptor` revision declares exactly which artifacts the
    // resulting subagent may see via `allowed_context_artifact_ids`. If the
    // capability-gated adapter hands back a different artifact at checkpoint
    // time, that artifact must never reach specialist/critic context: the
    // descriptor's allowlist is the authority, not whatever the adapter chose
    // to prepare.
    const service = new GovernedContextService({ adapters: {
      capabilities: new Set(["subagent.describe"]),
      declarative_subagent: { prepare: () => ({ artifact_ids: [outOfScope.id] }) },
    } });
    const allowed = artifact(service, "declared allowed context");
    const outOfScope = artifact(service, "never declared in the descriptor allowlist");
    const descriptor = service.proposeRevision({ ...revision("subagent_descriptor"), id: "descriptor-adapter", patch: { descriptor: { role: "seed", objective: "inspect", allowed_context_artifact_ids: [allowed.id], allowed_message_ranges: [], max_children: 0, recursive_delegation: false } } });
    service.approveRevision(descriptor.id, "lenticel");
    const checkpoint = service.checkpoint({ campaign_id: "c", node_id: "n", as_of: "2029-06-01T00:00:00.000Z" });
    expect(checkpoint.unapplied_overlays.map((o) => o.id)).toContain("descriptor-adapter");
    expect(checkpoint.applied_overlay_ids).not.toContain("descriptor-adapter");
    expect(checkpoint.specialist_context).not.toContain("never declared in the descriptor allowlist");
    expect(checkpoint.critic_context).not.toContain("never declared in the descriptor allowlist");
  });

  it("records one descriptor child request before execution and rejects inactive, multi-child, or replayed dispatch", () => {
    const service = new GovernedContextService();
    const descriptor = { ...revision("subagent_descriptor"), id: "executable-descriptor", patch: { descriptor: { role: "seed", objective: "inspect", allowed_context_artifact_ids: [], allowed_message_ranges: [], max_children: 1, recursive_delegation: false } } };
    service.proposeRevision(descriptor);
    expect(() => service.requestSubagentExecution({ id: "run", campaign_id: "c", parent_node_id: "node", revision_id: descriptor.id, requested_by: "operator", child_session_id: "child", worktree_node_id: "worktree" })).toThrow(/active independently approved/);
    service.approveRevision(descriptor.id, "lenticel");
    const requested = service.requestSubagentExecution({ id: "run", campaign_id: "c", parent_node_id: "node", revision_id: descriptor.id, requested_by: "operator", child_session_id: "child", worktree_node_id: "worktree" });
    expect(requested).toMatchObject({ state: "requested", revision_id: descriptor.id, child_session_id: "child" });
    expect(service.requestSubagentExecution({ id: "different-operation", campaign_id: "c", parent_node_id: "node", revision_id: descriptor.id, requested_by: "operator", child_session_id: "other", worktree_node_id: "other" }).id).toBe("run");
    const multi = service.proposeRevision({ ...descriptor, id: "multi", patch: { descriptor: { ...descriptor.patch.descriptor as object, max_children: 2 } } }); service.approveRevision(multi.id, "lenticel");
    expect(() => service.requestSubagentExecution({ id: "multi-run", campaign_id: "c", parent_node_id: "node", revision_id: multi.id, requested_by: "operator", child_session_id: "child", worktree_node_id: "worktree" })).toThrow(/max_children exactly 1/);
  });

  it("persists content, activation evidence and rollback state without a second authority", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-governed-context-"));
    try {
      const first = new GovernedContextService({ persistence_dir: dir });
      const proposal = fold(first);
      first.proposeFold(proposal); first.approveFold(proposal.id, "lenticel", 1); first.rollbackFold(proposal.id, "operator");
      const restored = new GovernedContextService({ persistence_dir: dir });
      expect(restored.list("c").folds).toMatchObject([{ id: proposal.id, status: "rolled_back", approved_by: "lenticel" }]);
      expect(restored.readWorkspace({ artifact_id: proposal.output_artifact.id, visibility: "campaign" }).content).toBe("folded");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("restores malformed JSON and missing durable arrays without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-governed-context-malformed-"));
    try {
      const path = join(dir, "governed-context", "state.json");
      mkdirSync(join(dir, "governed-context"), { recursive: true });
      writeFileSync(path, "{ malformed", "utf8");
      expect(() => new GovernedContextService({ persistence_dir: dir })).not.toThrow();
      writeFileSync(path, JSON.stringify({ schema_version: 1, artifacts: {}, folds: null, playbook: "no", revisions: [], evaluation_runs: {} }), "utf8");
      expect(() => new GovernedContextService({ persistence_dir: dir })).not.toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("drops a structurally malformed fold individually and reports it, while restoring the valid sibling (WA-30)", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-governed-context-malformed-fold-"));
    try {
      const path = join(dir, "governed-context", "state.json");
      mkdirSync(join(dir, "governed-context"), { recursive: true });
      const output = { id: "ctx_missing", sha256: "sha256", media_type: "text/plain", byte_length: 0, campaign_id: "c", producer: "seed", visibility: "campaign", provenance };
      const validFold = {
        id: "fold-1", campaign_id: "c", task_id: "task-1", node_id: "n", scale: "granular", source_event_ids: ["event-1"],
        source_message_ranges: [{ context_id: "parent-child", thread_id: "root", start_communication_id: "message-1", end_communication_id: "message-1", start_byte: 0, end_byte: 4 }],
        retained_claims: ["test passed"], omitted_artifacts: [], output_artifact: output, measures: { expected_token_savings: 5 },
        proposed_by: "seed", provenance, created_at: "2029-01-01T00:00:00.000Z", expires_at: expires, status: "proposed",
      };
      const malformedFold = { id: "fold-broken", campaign_id: "c" }; // missing every other required field
      writeFileSync(path, JSON.stringify({ schema_version: 1, artifacts: [], folds: [malformedFold, validFold], playbook: [], revisions: [], executions: [], evaluation_runs: [] }), "utf8");

      const restored = new GovernedContextService({ persistence_dir: dir });
      expect(restored.list("c").folds).toMatchObject([{ id: "fold-1", status: "proposed" }]);
      expect(restored.restoreDiagnostics()).toMatchObject([{ kind: "fold", id: "fold-broken", reason: expect.stringContaining("malformed") }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reports one diagnostic and still starts when the whole persisted file is unparseable (WA-30)", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-governed-context-corrupt-file-"));
    try {
      const path = join(dir, "governed-context", "state.json");
      mkdirSync(join(dir, "governed-context"), { recursive: true });
      writeFileSync(path, "{ not json at all", "utf8");
      const restored = new GovernedContextService({ persistence_dir: dir });
      expect(restored.restoreDiagnostics()).toMatchObject([{ kind: "file", id: null, reason: expect.any(String) }]);
      expect(restored.list("c")).toMatchObject({ folds: [] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reconciles a persisted running evaluation to a durable unmeasured retryable result without auto-replay", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-governed-evaluation-restart-"));
    try {
      const first = new GovernedContextService({ persistence_dir: dir });
      first.proposeRevision(revision()); first.approveRevision("revision-1", "lenticel");
      first.startEvaluation({ id: "interrupted-run", revision_id: "revision-1", requested_by: "operator", evaluator_id: "hermetic" });
      const restored = new GovernedContextService({ persistence_dir: dir });
      expect(restored.getEvaluationRun("interrupted-run")).toMatchObject({ state: "unmeasured", reason: "evaluation interrupted by process restart", completed_at: expect.any(String) });
      expect(restored.startEvaluation({ id: "fresh-run", revision_id: "revision-1", requested_by: "operator", evaluator_id: "hermetic" })).toMatchObject({ id: "fresh-run", state: "running" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("drops tampered restored artifacts whose bytes no longer match their content address", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-governed-context-tamper-"));
    try {
      const first = new GovernedContextService({ persistence_dir: dir }); const ref = artifact(first, "original");
      const path = join(dir, "governed-context", "state.json"); const state = JSON.parse(readFileSync(path, "utf8"));
      state.artifacts[0].content = "edited-after-hash"; writeFileSync(path, JSON.stringify(state), "utf8");
      const restored = new GovernedContextService({ persistence_dir: dir });
      expect(() => restored.readWorkspace({ artifact_id: ref.id, visibility: "campaign" })).toThrow(/was not found/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("settles measured evaluations only with exact-run, revision, partitioned critic-only generated overlay evidence", () => {
    const service = new GovernedContextService();
    const revisionRecord = service.proposeRevision(revision()); service.approveRevision(revisionRecord.id, "lenticel");
    const run = service.startEvaluation({ id: "evaluation-run", revision_id: revisionRecord.id, requested_by: "operator", evaluator_id: "hermetic-evaluator" });
    expect(() => service.startEvaluation({ id: "racing-evaluation-run", revision_id: revisionRecord.id, requested_by: "operator-2", evaluator_id: "other-hermetic-evaluator" })).toThrow(/already running/);
    const generated = (campaign_id: string, visibility: "campaign" | "critic_only", revision_id = revisionRecord.id, partition: "replay" | "holdout" = "replay", media_type = "application/vnd.arbor.overlay-evaluation+json", evaluation_run_id = run.id) => service.captureArtifact({ campaign_id, media_type, producer: "arbor-eval/governed-overlay", visibility, provenance: { tag: "generated", generator: "arbor-eval/governed-overlay", input_hash: `hash:${campaign_id}:${visibility}:${media_type}:${revision_id}:${partition}:${evaluation_run_id}` }, content: JSON.stringify({ schema_version: 1, evaluation_run_id, revision_id, scenario_id: `${campaign_id}-${visibility}-${media_type}-${revision_id}-${partition}`, partition }) });
    const replay = generated("c", "critic_only"); const holdout = generated("c", "critic_only", revisionRecord.id, "holdout"); const crossCampaign = generated("other", "critic_only"); const crossRevision = generated("c", "critic_only", "different-revision"); const wrongVisibility = generated("c", "campaign"); const wrongType = generated("c", "critic_only", revisionRecord.id, "replay", "text/plain");
    const forgedProvenance = service.captureArtifact({ campaign_id: "c", media_type: "application/vnd.arbor.overlay-evaluation+json", producer: "forged", visibility: "critic_only", provenance: { tag: "generated", generator: "", input_hash: "" }, content: "forged" });
    const measured = (additional: readonly string[] = [], partitions: { readonly replay: readonly string[]; readonly holdout: readonly string[] } = { replay: [replay.id], holdout: [holdout.id] }) => ({ kind: "measured" as const, evidence_ids: [replay.id, holdout.id, ...additional], evaluation: evaluation({ outcome: "unchanged", fidelity_ratio: 1, main_model_tokens: 1, child_model_tokens: 1, latency_ms: 1, replay_evidence_ids: partitions.replay, holdout_evidence_ids: partitions.holdout }) });
    expect(() => service.settleEvaluation(run.id, measured(["ctx_" + "0".repeat(64)]))).toThrow(/invalid measured/);
    expect(() => service.settleEvaluation(run.id, measured([crossCampaign.id]))).toThrow(/invalid measured/);
    expect(() => service.settleEvaluation(run.id, measured([crossRevision.id]))).toThrow(/invalid measured/);
    expect(() => service.settleEvaluation(run.id, measured([wrongVisibility.id]))).toThrow(/invalid measured/);
    expect(() => service.settleEvaluation(run.id, measured([wrongType.id]))).toThrow(/invalid measured/);
    expect(() => service.settleEvaluation(run.id, measured([forgedProvenance.id]))).toThrow(/invalid measured/);
    expect(() => service.settleEvaluation(run.id, measured([], { replay: [holdout.id], holdout: [replay.id] }))).toThrow(/invalid measured/);
    expect(service.settleEvaluation(run.id, measured())).toMatchObject({ state: "measured", evidence_ids: [replay.id, holdout.id] });
    // A manual observation clears the mutable revision evaluator projection.
    // The evaluator identity must still be read from the selected durable run,
    // otherwise its own evidence could be used to self-quarantine.
    service.recordEvaluation(revisionRecord.id, evaluation({ outcome: "regressed", fidelity_ratio: 1, main_model_tokens: 1, child_model_tokens: 1, latency_ms: 1, regression_detected: true }));
    expect(() => service.quarantineRevision(revisionRecord.id, "hermetic-evaluator", "self quarantine", [replay.id])).toThrow(/selected evaluator/);
    const later = service.startEvaluation({ id: "later-evaluation-run", revision_id: revisionRecord.id, requested_by: "operator", evaluator_id: "hermetic-evaluator" });
    expect(() => service.settleEvaluation(later.id, measured())).toThrow(/invalid measured/);
  });

  it("rejects malformed durable evidence at every governed overlay boundary", () => {
    const service = new GovernedContextService({ message_evidence: { hasMessageRange: () => true } });
    const proposal = fold(service);
    const range = proposal.source_message_ranges[0]!;
    expect(() => service.proposeFold({ ...proposal, task_id: "  " })).toThrow(/task identity/);
    expect(() => service.proposeFold({ ...proposal, id: "missing-omitted", omitted_artifacts: [{ ...proposal.omitted_artifacts[0]!, id: "ctx_missing" }] })).toThrow(/unknown context artifact/);
    expect(() => service.proposeFold({ ...proposal, id: "bad-range", source_message_ranges: [{ ...range, context_id: "" }] })).toThrow(/range is invalid/);
    expect(() => service.proposeFold({ ...proposal, id: "unsafe-range", source_message_ranges: [{ ...range, start_byte: 0.5 }] })).toThrow(/range is invalid/);

    const delta: Omit<PlaybookDelta, "status"> = {
      id: "delta-boundaries", campaign_id: "c", task_id: "task", kind: "add", patch: {}, source_event_ids: ["event"], source_message_ranges: [range],
      observed_outcome: "observed", counter_evidence: [], proposed_by: "seed", provenance, created_at: "2029-01-01T00:00:00.000Z", expires_at: expires,
    };
    expect(() => service.proposePlaybook({ ...delta, task_id: "" })).toThrow(/task identity/);
    expect(() => service.proposePlaybook({ ...delta, observed_outcome: "  " })).toThrow(/source evidence/);
    service.proposePlaybook(delta);
    expect(() => service.approvePlaybook(delta.id, "seed")).toThrow(/distinct critic/);

    expect(() => service.proposeRevision({ ...revision(), id: "no-task", task_id: "" })).toThrow(/task identity/);
    expect(() => service.proposeRevision({ ...revision(), id: "no-evidence", source_message_ranges: [] })).toThrow(/source evidence/);
    expect(() => service.proposeRevision({ ...revision(), id: "missing-revision-range", source_message_ranges: [{ ...range, end_byte: -1 }] })).toThrow(/range is invalid/);
  });

  it("keeps artifact windows bounded and campaign overlays isolated after evaluation and promotion", () => {
    const service = new GovernedContextService();
    const ref = artifact(service, "abcdefghij");
    expect(service.readWorkspace({ artifact_id: ref.id, offset: -5, max_bytes: 0, visibility: "campaign" })).toMatchObject({ offset: 0, content: "a", truncated: true });
    expect(service.readWorkspace({ artifact_id: ref.id, offset: 2, max_bytes: 99_999, visibility: "campaign" })).toMatchObject({ content: "cdefghij", truncated: false });

    const record = service.proposeRevision(revision());
    expect(() => service.recordEvaluation("missing", evaluation())).toThrow(/was not found/);
    service.approveRevision(record.id, "lenticel");
    service.recordEvaluation(record.id, evaluation({ outcome: "regressed", rollback_count: 99 }));
    expect(service.rollbackRevision(record.id, "operator").evaluation.rollback_count).toBe(1);
    expect(service.overlays("other")).toMatchObject({ active_folds: [], active_playbook: [], active_harness_revisions: [], rollbackable_ids: [] });
    expect(service.list("other")).toEqual({ folds: [], playbook: [], revisions: [], executions: [] });
    expect(service.newId("overlay")).toMatch(/^overlay_/);
  });
});
