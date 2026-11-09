import { describe, expect, it } from "vitest";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import type { Action, Provenance } from "@arbor/core";

const provenance: Provenance = { tag: "claimed", claimant: "seed" };
const metadata = (operation_id: string, actor_id = "seed") => ({ operation_id, idempotency_key: `${operation_id}:key`, correlation_id: "ctx", actor_id });
const root: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };

function runtimeWithDurableMessage() {
  const runtime = new ArborRuntime();
  runtime.manager.startCampaign("c", "plan.md", root);
  runtime.manager.recordBusMessage({
    campaign_id: "c", node_id: "root", author_node_id: "parent", recipient_node_id: "child", other_recipient_node_ids: [], kind: "delegate",
    payload: { content: "investigate", provenance }, capability_tier: "specialist", trigger_turn: false, as_of: "2029-01-01T00:00:00.000Z",
    correlation_id: "ctx", idempotency_key: "message-1", acknowledges_communication_id: null, retracts_communication_id: null, conversation_id: "parent-child",
  });
  const message = runtime.manager.getAuditRecords("c").find((record) => record.kind === "node_communication");
  if (!message) throw new Error("test setup did not record durable message");
  return { runtime, messageId: message.id };
}

describe("governed context canonical catalog", () => {
  it("round-trips governed context, folds, playbook, and harness overlays through the same canonical router used by TUI transports", async () => {
    const { runtime, messageId } = runtimeWithDurableMessage();
    const router = new RuntimeCatalogRouter(runtime);
    const captured = await router.dispatchCommand({ schema_version: 1, metadata: metadata("capture"), command: {
      kind: "context.artifact.capture", artifact: { campaign_id: "c", media_type: "text/plain", producer: "seed", visibility: "campaign", provenance }, content: "abcdefgh",
    } });
    expect(captured).toMatchObject({ ok: true, value: { accepted: true } });
    const ref = runtime.governedContext.captureArtifact({ campaign_id: "c", media_type: "text/plain", producer: "seed", visibility: "campaign", provenance, content: "folded" });
    const omitted = runtime.governedContext.captureArtifact({ campaign_id: "c", media_type: "text/plain", producer: "seed", visibility: "campaign", provenance, content: "raw" });
    const workspace = router.executeQuery({ schema_version: 1, query_id: "workspace", query: { kind: "context.workspace", artifact_id: ref.id, max_bytes: 3, visibility: "campaign" } });
    expect(workspace).toMatchObject({ ok: true, value: { content: "fol", truncated: true } });
    const proposal = {
      id: "fold-router", campaign_id: "c", task_id: "task", node_id: "n", scale: "deep" as const, source_event_ids: ["event"], source_message_ranges: [{ context_id: "parent-child", thread_id: "root", start_communication_id: messageId, end_communication_id: messageId, start_byte: 0, end_byte: 3 }], retained_claims: ["claim"], omitted_artifacts: [omitted], output_artifact: ref,
      measures: { expected_token_savings: 3 }, proposed_by: "seed", provenance, created_at: "2029-01-01T00:00:00.000Z", expires_at: "2030-01-01T00:00:00.000Z",
    };
    expect(await router.dispatchCommand({ schema_version: 1, metadata: metadata("fold-propose"), command: { kind: "fold.propose", proposal } })).toMatchObject({ ok: true, value: { accepted: true } });
    expect(await router.dispatchCommand({ schema_version: 1, metadata: metadata("fold-approve", "lenticel"), command: { kind: "fold.approve", fold_id: proposal.id, fidelity_ratio: 1 } })).toMatchObject({ ok: true, value: { accepted: true } });
    const overlays = router.executeQuery({ schema_version: 1, query_id: "overlays", query: { kind: "context.overlays", campaign_id: "c" } });
    expect(overlays).toMatchObject({ ok: true, value: { active_folds: [{ id: "fold-router", approved_by: "lenticel" }], rollbackable_ids: ["fold-router"] } });
    const range = { context_id: "parent-child", thread_id: "root", start_communication_id: messageId, end_communication_id: messageId, start_byte: 0, end_byte: 3 };
    expect(await router.dispatchCommand({ schema_version: 1, metadata: metadata("playbook-propose"), command: { kind: "playbook.propose", delta: { id: "lesson", campaign_id: "c", task_id: "task", kind: "add", patch: { lesson: "preserve evidence" }, source_event_ids: ["event"], source_message_ranges: [range], observed_outcome: "helped", counter_evidence: [], proposed_by: "seed", provenance, created_at: "2029-01-01T00:00:00.000Z", expires_at: "2030-01-01T00:00:00.000Z" } } })).toMatchObject({ ok: true, value: { accepted: true } });
    expect(await router.dispatchCommand({ schema_version: 1, metadata: metadata("playbook-approve", "lenticel"), command: { kind: "playbook.approve", delta_id: "lesson" } })).toMatchObject({ ok: true, value: { accepted: true } });
    const harness = { id: "prompt", campaign_id: "c", task_id: "task", component: "supplemental_prompt" as const, patch: { guidance: "prefer cited evidence" }, source_event_ids: ["event"], source_message_ranges: [range], expected_benefit: "less repeated reading", proposed_by: "seed", provenance, created_at: "2029-01-01T00:00:00.000Z", expires_at: "2030-01-01T00:00:00.000Z" };
    expect(await router.dispatchCommand({ schema_version: 1, metadata: metadata("harness-propose"), command: { kind: "harness.propose", revision: harness } })).toMatchObject({ ok: true, value: { accepted: true } });
    expect(await router.dispatchCommand({ schema_version: 1, metadata: metadata("harness-approve", "lenticel"), command: { kind: "harness.approve", revision_id: "prompt" } })).toMatchObject({ ok: true, value: { accepted: true } });
    const evaluation = { outcome: "improved" as const, fidelity_ratio: 1, main_model_tokens: 10, child_model_tokens: 3, latency_ms: 4, regression_detected: false, rollback_count: 0, replay_evidence_ids: ["replay"], holdout_evidence_ids: ["holdout"] };
    expect(await router.dispatchCommand({ schema_version: 1, metadata: metadata("harness-evaluate"), command: { kind: "harness.evaluate", revision_id: "prompt", evaluation } })).toMatchObject({ ok: true, value: { accepted: true } });
    expect(await router.dispatchCommand({ schema_version: 1, metadata: metadata("harness-promote", "operator"), command: { kind: "harness.promote", revision_id: "prompt", human_approver: "operator" } })).toMatchObject({ ok: true, value: { accepted: false } });
    expect(await router.dispatchCommand({ schema_version: 1, metadata: metadata("fold-rollback", "operator"), command: { kind: "fold.rollback", fold_id: proposal.id } })).toMatchObject({ ok: true, value: { accepted: true } });
    expect(await router.dispatchCommand({ schema_version: 1, metadata: metadata("harness-rollback", "operator"), command: { kind: "harness.rollback", revision_id: "prompt" } })).toMatchObject({ ok: true, value: { accepted: true } });
    expect(router.executeQuery({ schema_version: 1, query_id: "governance", query: { kind: "context.governance", campaign_id: "c" } })).toMatchObject({ ok: true, value: { playbook: [{ id: "lesson", status: "active", approved_by: "lenticel" }], revisions: [{ id: "prompt", status: "rolled_back" }] } });
  });

  it("makes forbidden harness mutations an observable rejected command, not a hidden mutation", async () => {
    const router = new RuntimeCatalogRouter(new ArborRuntime());
    const result = await router.dispatchCommand({ schema_version: 1, metadata: metadata("forbidden"), command: {
      kind: "harness.propose", revision: {
        id: "bad", campaign_id: "c", task_id: "task", component: "base_prompt", patch: {}, source_event_ids: ["event"], source_message_ranges: [{ context_id: "context", thread_id: "root", start_communication_id: "message", end_communication_id: "message", start_byte: 0, end_byte: 1 }], expected_benefit: "bypass governance",
        proposed_by: "seed", provenance, created_at: "2029-01-01T00:00:00.000Z", expires_at: "2030-01-01T00:00:00.000Z",
      },
    } });
    expect(result).toMatchObject({ ok: true, value: { accepted: false, error: { code: "internal" } } });
  });
});
