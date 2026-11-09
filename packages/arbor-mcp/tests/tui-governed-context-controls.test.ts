import { afterEach, describe, expect, it } from "vitest";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { RuntimePortAdapter } from "../src/tui-adapter.js";
import { HeadlessHarness, installScreens, clearRegisteredScreens } from "@arbor/tui";

const provenance = { tag: "claimed" as const, claimant: "seed" };
afterEach(() => clearRegisteredScreens());
const meta = (id: string, actor = "seed") => ({ operation_id: id, idempotency_key: `${id}:key`, correlation_id: id, actor_id: actor });

function harness(runtime: ArborRuntime, commandResults?: Array<unknown>) {
  const adapter = new RuntimePortAdapter(new RuntimeCatalogRouter(runtime));
  return new HeadlessHarness({
    client: { connect() {}, disconnect() {}, requestSnapshot() {}, close() {}, interruptCampaign() {} }, terminal: { restore() {} }, clock: { now: () => 10 },
    telemetrySource: { fetch: async () => ({ campaign_id: "c", source_record_count: 0, counters: [], phase_histograms: [], usage_cost: [], context_economy: [], tool_economy: [] }) },
    runtime: {
      command: async (request: Parameters<RuntimePortAdapter["command"]>[0]) => { const result = await adapter.command(request); commandResults?.push(result); return result as never; },
      query: (request: Parameters<RuntimePortAdapter["query"]>[0]) => adapter.query(request) as never,
      activeOperationCount: () => adapter.activeOperationCount(),
    } as never,
  });
}

describe("governed context TUI control", () => {
  it("executes the selected active declarative descriptor through the TUI form and canonical catalog", async () => {
    let runtime!: ArborRuntime;
    runtime = new ArborRuntime({ declarative_subagent_executor: { execute: async (input) => {
      const artifact = runtime.governedContext.captureArtifact({ campaign_id: input.campaign_id, media_type: "text/plain", producer: "tui-subagent-fixture", visibility: "campaign", provenance, content: "bounded child result" });
      return { result_artifact_id: artifact.id, result_provenance: provenance, evidence_ids: [artifact.id, "source-event"] };
    } } });
    const router = new RuntimeCatalogRouter(runtime);
    runtime.manager.startCampaign("c", "plan.md", { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" });
    runtime.manager.recordBusMessage({ campaign_id: "c", node_id: "root", author_node_id: "root", recipient_node_id: "child", other_recipient_node_ids: [], kind: "delegate", payload: { content: "work", provenance }, capability_tier: "specialist", trigger_turn: false, as_of: "2030-01-01T00:00:00.000Z", correlation_id: "subagent-source", idempotency_key: "subagent-source", acknowledges_communication_id: null, retracts_communication_id: null, conversation_id: "thread" });
    const message = runtime.manager.getAuditRecords("c").find((record) => record.kind === "node_communication"); if (!message) throw new Error("missing durable message");
    const context = runtime.governedContext.captureArtifact({ campaign_id: "c", media_type: "text/plain", producer: "seed", visibility: "campaign", provenance, content: "approved context" });
    const revision = { id: "descriptor-ui", campaign_id: "c", task_id: "task", component: "subagent_descriptor" as const, patch: { descriptor: { role: "seed", objective: "Inspect approved context", allowed_context_artifact_ids: [context.id], allowed_message_ranges: [], max_children: 1, recursive_delegation: false } }, source_event_ids: ["source-event"], source_message_ranges: [{ context_id: "thread", thread_id: "root", start_communication_id: message.id, end_communication_id: message.id, start_byte: 0, end_byte: 1 }], expected_benefit: "bounded analysis", proposed_by: "seed", provenance, created_at: "2030-01-01T00:00:00.000Z", expires_at: "2031-01-01T00:00:00.000Z" };
    expect(await router.dispatchCommand({ schema_version: 1, metadata: meta("descriptor-propose"), command: { kind: "harness.propose", revision } })).toMatchObject({ ok: true });
    expect(await router.dispatchCommand({ schema_version: 1, metadata: meta("descriptor-approve", "lenticel"), command: { kind: "harness.approve", revision_id: revision.id } })).toMatchObject({ ok: true });
    expect(router.executeQuery({ schema_version: 1, query_id: "descriptor-overlays", query: { kind: "context.overlays", campaign_id: "c" } })).toMatchObject({ ok: true, value: { active_harness_revisions: [expect.objectContaining({ id: revision.id, component: "subagent_descriptor" })] } });
    installScreens(); const app = harness(runtime);
    await app.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "tree" }, at: 0 });
    await app.dispatch({ type: "ui_intent", intent: { type: "issue_query", queryId: "tree", request: { kind: "campaign.tree", query_id: "tree", params: { campaign_id: "c", limit: 200 } } }, at: 0 });
    expect(app.model.selection.get("tree")).toMatchObject({ id: "root", context: { campaign_id: "c" } });
    await app.dispatch({ type: "screen_changed", screen: "overlays" });
    await app.dispatch({ type: "ui_intent", intent: { type: "issue_query", queryId: "overlays", request: { kind: "context.overlays", query_id: "overlays", params: { campaign_id: "c" } } }, at: 1 });
    expect(app.model.selection.get("overlays")).toMatchObject({ id: revision.id, context: { overlay_type: "harness", component: "subagent_descriptor" } });
    await app.dispatch({ type: "ui_intent", intent: { type: "open_operator_form", command: "subagent.execute" }, at: 2 });
    expect(app.model.overlay).toMatchObject({ kind: "operator_form", command: "subagent.execute", fields: { campaign_id: "c", parent_node_id: "root", revision_id: revision.id } });
    await app.dispatch({ type: "ui_intent", intent: { type: "submit_operator_form" }, at: 3 });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(router.executeQuery({ schema_version: 1, query_id: "subagent-after", query: { kind: "subagent.executions", campaign_id: "c" } })).toMatchObject({ ok: true, value: [expect.objectContaining({ revision_id: revision.id, state: "completed", result_artifact_id: expect.stringMatching(/^ctx_/) })] });
  });

  it("rolls back a selected active governed fold through the TUI form and canonical catalog", async () => {
    const runtime = new ArborRuntime(); const router = new RuntimeCatalogRouter(runtime);
    runtime.manager.startCampaign("c", "plan.md", { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" });
    runtime.manager.recordBusMessage({ campaign_id: "c", node_id: "root", author_node_id: "root", recipient_node_id: "child", other_recipient_node_ids: [], kind: "delegate", payload: { content: "work", provenance }, capability_tier: "specialist", trigger_turn: false, as_of: "2030-01-01T00:00:00.000Z", correlation_id: "m", idempotency_key: "m", acknowledges_communication_id: null, retracts_communication_id: null, conversation_id: "thread" });
    const message = runtime.manager.getAuditRecords("c").find((record) => record.kind === "node_communication"); if (!message) throw new Error("missing durable message");
    const artifact = runtime.governedContext.captureArtifact({ campaign_id: "c", media_type: "text/plain", producer: "seed", visibility: "campaign", provenance, content: "fold" });
    const omitted = runtime.governedContext.captureArtifact({ campaign_id: "c", media_type: "text/plain", producer: "seed", visibility: "campaign", provenance, content: "source" });
    const proposal = { id: "fold-ui", campaign_id: "c", task_id: "task", node_id: "root", scale: "deep" as const, source_event_ids: ["event"], source_message_ranges: [{ context_id: "thread", thread_id: "root", start_communication_id: message.id, end_communication_id: message.id, start_byte: 0, end_byte: 1 }], retained_claims: ["claim"], omitted_artifacts: [omitted], output_artifact: artifact, measures: { expected_token_savings: 1 }, proposed_by: "seed", provenance, created_at: "2030-01-01T00:00:00.000Z", expires_at: "2031-01-01T00:00:00.000Z" };
    expect(await router.dispatchCommand({ schema_version: 1, metadata: meta("propose"), command: { kind: "fold.propose", proposal } })).toMatchObject({ ok: true, value: { accepted: true } });
    expect(await router.dispatchCommand({ schema_version: 1, metadata: meta("approve", "lenticel"), command: { kind: "fold.approve", fold_id: proposal.id, fidelity_ratio: 1 } })).toMatchObject({ ok: true, value: { accepted: true } });
    installScreens(); const app = harness(runtime);
    await app.dispatch({ type: "screen_changed", screen: "overlays" });
    await app.dispatch({ type: "ui_intent", intent: { type: "issue_query", queryId: "overlays", request: { kind: "context.overlays", query_id: "overlays", params: { campaign_id: "c" } } }, at: 1 });
    expect(app.model.selection.get("overlays")?.id).toBe("fold-ui");
    await app.dispatch({ type: "ui_intent", intent: { type: "open_operator_form", command: "fold.rollback" }, at: 2 });
    await app.dispatch({ type: "ui_intent", intent: { type: "submit_operator_form" }, at: 3 });
    expect(router.executeQuery({ schema_version: 1, query_id: "after", query: { kind: "context.overlays", campaign_id: "c" } })).toMatchObject({ ok: true, value: { active_folds: [], rollbackable_ids: [] } });
  });

  it("uses the selected overlay's typed row identity to roll back a harness revision", async () => {
    const runtime = new ArborRuntime(); const router = new RuntimeCatalogRouter(runtime);
    runtime.manager.startCampaign("c", "plan.md", { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" });
    runtime.manager.recordBusMessage({ campaign_id: "c", node_id: "root", author_node_id: "root", recipient_node_id: "child", other_recipient_node_ids: [], kind: "delegate", payload: { content: "work", provenance }, capability_tier: "specialist", trigger_turn: false, as_of: "2030-01-01T00:00:00.000Z", correlation_id: "m", idempotency_key: "m", acknowledges_communication_id: null, retracts_communication_id: null, conversation_id: "thread" });
    const message = runtime.manager.getAuditRecords("c").find((record) => record.kind === "node_communication"); if (!message) throw new Error("missing durable message");
    const revision = { id: "harness-ui", campaign_id: "c", task_id: "task", component: "supplemental_prompt" as const, patch: { guidance: "bounded" }, source_event_ids: ["event"], source_message_ranges: [{ context_id: "thread", thread_id: "root", start_communication_id: message.id, end_communication_id: message.id, start_byte: 0, end_byte: 1 }], expected_benefit: "focused", proposed_by: "seed", provenance, created_at: "2030-01-01T00:00:00.000Z", expires_at: "2031-01-01T00:00:00.000Z" };
    expect(await router.dispatchCommand({ schema_version: 1, metadata: meta("harness-propose"), command: { kind: "harness.propose", revision } })).toMatchObject({ ok: true, value: { accepted: true } });
    expect(await router.dispatchCommand({ schema_version: 1, metadata: meta("harness-approve", "lenticel"), command: { kind: "harness.approve", revision_id: revision.id } })).toMatchObject({ ok: true, value: { accepted: true } });
    installScreens(); const app = harness(runtime);
    await app.dispatch({ type: "screen_changed", screen: "overlays" });
    await app.dispatch({ type: "ui_intent", intent: { type: "issue_query", queryId: "overlays", request: { kind: "context.overlays", query_id: "overlays", params: { campaign_id: "c" } } }, at: 1 });
    expect(app.model.selection.get("overlays")?.context?.overlay_type).toBe("harness");
    await app.dispatch({ type: "ui_intent", intent: { type: "open_operator_form", command: "fold.rollback" }, at: 2 });
    await app.dispatch({ type: "ui_intent", intent: { type: "submit_operator_form" }, at: 3 });
    expect(runtime.governedContext.list("c").revisions).toMatchObject([{ id: "harness-ui", status: "rolled_back" }]);
  });

  it("runs the selected active revision hermetically, then exposes measured run detail and canonical promotion/quarantine forms", async () => {
    const runtime = new ArborRuntime({ harness_evaluator: { evaluator_id: "fixture-hermetic", evaluate: async () => ({ kind: "unmeasured" as const, reason: "fixture has no provider/tool/network path" }) } });
    const router = new RuntimeCatalogRouter(runtime);
    runtime.manager.startCampaign("c", "plan.md", { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" });
    runtime.manager.recordBusMessage({ campaign_id: "c", node_id: "root", author_node_id: "root", recipient_node_id: "child", other_recipient_node_ids: [], kind: "delegate", payload: { content: "evaluation source", provenance }, capability_tier: "specialist", trigger_turn: false, as_of: "2030-01-01T00:00:00.000Z", correlation_id: "evaluation-source", idempotency_key: "evaluation-source", acknowledges_communication_id: null, retracts_communication_id: null, conversation_id: "evaluation" });
    const message = runtime.manager.getAuditRecords("c").find((record) => record.kind === "node_communication"); if (!message) throw new Error("missing durable message");
    const makeRevision = (id: string) => ({ id, campaign_id: "c", task_id: "task", component: "supplemental_prompt" as const, patch: { guidance: "bounded" }, source_event_ids: [message.id], source_message_ranges: [{ context_id: "evaluation", thread_id: "root", start_communication_id: message.id, end_communication_id: message.id, start_byte: 0, end_byte: 1 }], expected_benefit: "bounded", proposed_by: "seed", provenance, created_at: "2030-01-01T00:00:00.000Z", expires_at: "2031-01-01T00:00:00.000Z" });
    const candidate = makeRevision("tui-evaluation-candidate"); runtime.governedContext.proposeRevision(candidate); runtime.governedContext.approveRevision(candidate.id, "lenticel");
    const commandResults: unknown[] = []; installScreens(); const app = harness(runtime, commandResults);
    await app.dispatch({ type: "screen_changed", screen: "overlays" });
    await app.dispatch({ type: "ui_intent", intent: { type: "issue_query", queryId: "overlays", request: { kind: "context.overlays", query_id: "overlays", params: { campaign_id: "c" } } }, at: 1 });
    expect(app.model.selection.get("overlays")).toMatchObject({ id: candidate.id, context: { status: "active", evaluation_outcome: "not_yet_measured" } });
    await app.dispatch({ type: "ui_intent", intent: { type: "open_operator_form", command: "harness.evaluation.start" }, at: 2 });
    expect(app.model.overlay).toMatchObject({ kind: "operator_form", command: "harness.evaluation.start", fields: { revision_id: candidate.id } });
    await app.dispatch({ type: "ui_intent", intent: { type: "submit_operator_form" }, at: 3 });
    expect(app.effects.at(-1)).toMatchObject({ type: "dispatch_command", request: { kind: "harness.evaluation.start", params: { revision_id: candidate.id } } });
    expect(commandResults.at(-1)).toMatchObject({ ok: true, value: { accepted: true } });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    // An unmeasured result is not a promotion fact and must remain explicitly
    // retryable rather than being silently removed from the candidate view.
    const candidatesAfter = router.executeQuery({ schema_version: 1, query_id: "candidate-after", query: { kind: "harness.evaluation.candidates", campaign_id: "c" } });
    expect(candidatesAfter).toMatchObject({ ok: true });
    expect((candidatesAfter as { value: readonly unknown[] }).value[0]).toMatchObject({ id: candidate.id, evaluation: { outcome: "not_yet_measured" } });
    const candidateRuns = router.executeQuery({ schema_version: 1, query_id: "candidate-runs", query: { kind: "harness.evaluation.runs", campaign_id: "c" } });
    expect(candidateRuns).toMatchObject({ ok: true, value: [expect.objectContaining({ revision_id: candidate.id, state: "unmeasured", evaluator_id: "fixture-hermetic" })] });

    const evaluationEvidence = (revisionId: string, evaluation_run_id: string) => (["replay", "holdout"] as const).map((partition) => { const content = JSON.stringify({ schema_version: 1, evaluation_run_id, revision_id: revisionId, scenario_id: `fixture:${partition}`, partition }); return runtime.governedContext.captureArtifact({ campaign_id: "c", media_type: "application/vnd.arbor.overlay-evaluation+json", producer: "arbor-eval/governed-overlay", visibility: "critic_only", provenance: { tag: "generated", generator: "arbor-eval/governed-overlay", input_hash: `sha256:${revisionId}:${evaluation_run_id}:${partition}` }, content }); });
    const promote = makeRevision("tui-evaluation-promote"); runtime.governedContext.proposeRevision(promote); runtime.governedContext.approveRevision(promote.id, "lenticel");
    const promoteRun = runtime.governedContext.startEvaluation({ id: "run-promote", revision_id: promote.id, requested_by: "operator", evaluator_id: "fixture-hermetic" });
    const evidence = evaluationEvidence(promote.id, promoteRun.id);
    runtime.governedContext.settleEvaluation(promoteRun.id, { kind: "measured", evidence_ids: evidence.map((item) => item.id), evaluation: { outcome: "improved", fidelity_ratio: 1, main_model_tokens: 2, child_model_tokens: 2, latency_ms: 2, regression_detected: false, rollback_count: 0, replay_evidence_ids: [evidence[0]!.id], holdout_evidence_ids: [evidence[1]!.id] }, detail: [{ summary: "redacted fixture" }] });
    await app.dispatch({ type: "screen_changed", screen: "harness-evaluations" });
    await app.dispatch({ type: "ui_intent", intent: { type: "issue_query", queryId: "runs", request: { kind: "harness.evaluation.runs", query_id: "runs", params: { campaign_id: "c" } } }, at: 4 });
    const promotionIndex = (app.model.screens.get("harness-evaluations") as readonly { id: string }[]).findIndex((run) => run.id === promoteRun.id);
    await app.dispatch({ type: "ui_intent", intent: { type: "select_row", screen: "harness-evaluations", row: promotionIndex }, at: 5 });
    // The measured improvement is a real selected run. Its detail query is
    // bounded/redacted and promotion is still re-authorized by the catalog.
    const selected = app.model.selection.get("harness-evaluations");
    if (selected?.context?.revision_id !== promote.id) throw new Error("expected selected measured promotion run");
    await app.dispatch({ type: "ui_intent", intent: { type: "view_selected_row_detail" }, at: 6 });
    expect(app.model.screens.get("harness-evaluations")).toMatchObject({ id: promoteRun.id, detail: [{ summary: "redacted fixture" }] });
    await app.dispatch({ type: "ui_intent", intent: { type: "issue_query", queryId: "runs-again", request: { kind: "harness.evaluation.runs", query_id: "runs-again", params: { campaign_id: "c" } } }, at: 7 });
    await app.dispatch({ type: "ui_intent", intent: { type: "open_operator_form", command: "harness.promote" }, at: 8 });
    await app.dispatch({ type: "ui_intent", intent: { type: "submit_operator_form" }, at: 9 });
    expect(runtime.governedContext.getRevision(promote.id)?.promotion?.approved_by_human).toBeTruthy();

    const quarantine = makeRevision("tui-evaluation-quarantine"); runtime.governedContext.proposeRevision(quarantine); runtime.governedContext.approveRevision(quarantine.id, "lenticel");
    const quarantineRun = runtime.governedContext.startEvaluation({ id: "run-quarantine", revision_id: quarantine.id, requested_by: "operator", evaluator_id: "fixture-hermetic" });
    const quarantineEvidence = evaluationEvidence(quarantine.id, quarantineRun.id);
    runtime.governedContext.settleEvaluation(quarantineRun.id, { kind: "measured", evidence_ids: quarantineEvidence.map((item) => item.id), evaluation: { outcome: "regressed", fidelity_ratio: 1, main_model_tokens: 2, child_model_tokens: 2, latency_ms: 2, regression_detected: true, rollback_count: 0, replay_evidence_ids: [quarantineEvidence[0]!.id], holdout_evidence_ids: [quarantineEvidence[1]!.id] } });
    await app.dispatch({ type: "ui_intent", intent: { type: "issue_query", queryId: "quarantine-runs", request: { kind: "harness.evaluation.runs", query_id: "quarantine-runs", params: { campaign_id: "c" } } }, at: 10 });
    const quarantineIndex = (app.model.screens.get("harness-evaluations") as readonly { id: string }[]).findIndex((run) => run.id === quarantineRun.id);
    await app.dispatch({ type: "ui_intent", intent: { type: "select_row", screen: "harness-evaluations", row: quarantineIndex }, at: 11 });
    await app.dispatch({ type: "ui_intent", intent: { type: "open_operator_form", command: "harness.quarantine" }, at: 12 });
    const form = app.model.overlay; if (form?.kind !== "operator_form") throw new Error("missing quarantine form");
    await app.dispatch({ type: "ui_intent", intent: { type: "operator_form_next_field", direction: 1 }, at: 13 });
    await app.dispatch({ type: "ui_intent", intent: { type: "operator_form_input", value: "measured regression" }, at: 14 });
    await app.dispatch({ type: "ui_intent", intent: { type: "submit_operator_form" }, at: 15 });
    expect(runtime.governedContext.getRevision(quarantine.id)).toMatchObject({ status: "quarantined", quarantine: { evidence_ids: quarantineEvidence.map((item) => item.id) } });
  });
});
