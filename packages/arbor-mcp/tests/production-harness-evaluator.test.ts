import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NativeReadOnlyEvaluationResult, NativeAgentExecutor } from "../src/native-agent-executor.js";
import { ProductionHarnessEvaluator } from "../src/production-harness-evaluator.js";
import { GovernedContextService } from "../src/governed-context-service.js";
import { createCliRuntime } from "../src/cli.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const policy = (tools: readonly string[] = []) => ({
  filesystem: "read_only" as const, approvals: "never" as const, tool_allow: tools, tool_deny: [], workspace_roots: [],
  max_wall_clock_ms: 100, max_events: 8, network_allowed: false, ambient_plugins_allowed: false, user_configuration_allowed: false, inherited_credentials_allowed: false,
});
const unbudgeted = {
  reserveReadOnlyEvaluationPair: () => ({ kind: "not_configured" as const }),
  settleReadOnlyEvaluationPair: () => {},
};
function nativeResult(message: string, tools: readonly string[] = []): NativeReadOnlyEvaluationResult {
  return {
    inspection: { session_id: "fixed", state: "completed", policy: policy(tools), capabilities: [], lineage: { kind: "new" }, ephemeral: true, latest_sequence: 1, terminal: { state: "completed", cause: "completed", result: "claimed", message, provenance: { tag: "claimed", claimant: "fixture" } } },
    events: [{ protocol_version: "1", session_id: "fixed", sequence: 1, occurred_at: "2030-01-01T00:00:00.000Z", kind: "usage", payload: { input_tokens: 3, output_tokens: 2 } }],
    model_identity: { provider_id: "fixture", model_id: "same-model", revision: "fixture-response-r1", capabilities: [] },
    usage_and_cost: { tokens: { kind: "measured", input_tokens: 3, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0 }, cost: { kind: "unpriced", reason: "fixture" } },
  };
}
function service() {
  const value = new GovernedContextService();
  value.proposeRevision({ id: "candidate", campaign_id: "campaign", task_id: "task", component: "supplemental_prompt", patch: { guidance: "candidate-only guidance" }, source_event_ids: ["replay-record", "holdout-record"], source_message_ranges: [{ context_id: "thread", thread_id: "root", start_communication_id: "replay-record", end_communication_id: "holdout-record", start_byte: 0, end_byte: 1 }], expected_benefit: "quality", proposed_by: "seed", provenance: { tag: "claimed", claimant: "seed" }, created_at: "2029-01-01T00:00:00.000Z", expires_at: "2031-01-01T00:00:00.000Z" });
  value.approveRevision("candidate", "lenticel");
  return value;
}
function corpus(id: string, partition: "replay" | "holdout") {
  return { id, campaign_id: "campaign", kind: "node_communication", communication: { payload: { content: JSON.stringify({ schema_version: 1, kind: "harness_evaluation_scenario", partition, prompt: `${partition} prompt`, expected_final_sha256: `sha256:${hash("correct")}` }) } } };
}

describe("ProductionHarnessEvaluator", () => {
  it("applies the selected overlay only to candidate arms, uses equal fixed no-tools ceilings, and permits a genuine measured improvement", async () => {
    const context = service(); const calls: Array<{ prompt: string; node_id: string; session_id: string }> = [];
    const native = {
      ...unbudgeted,
      readOnlyEvaluationCeiling: () => ({ max_model_turns: 2, max_events: 8, max_wall_clock_ms: 100 }),
      evaluateReadOnly: async (input: { prompt: string; node_id: string; session_id: string }) => {
        calls.push(input);
        return nativeResult(input.prompt.includes("candidate-only guidance") ? "correct" : "incorrect");
      },
    } as unknown as NativeAgentExecutor;
    const evaluator = new ProductionHarnessEvaluator({ context: () => context, audit_records: () => [corpus("replay-record", "replay"), corpus("holdout-record", "holdout")], native_executor: () => native, now: () => 0 });
    const result = await evaluator.evaluate({ revision_id: "candidate", run_id: "run-1" });

    expect(result).toMatchObject({ kind: "measured", evaluation: { outcome: "improved", regression_detected: false, main_model_tokens: 10, child_model_tokens: 10 }, evidence_ids: [expect.any(String), expect.any(String)] });
    expect(calls).toHaveLength(4);
    expect(calls.filter((call) => call.node_id.startsWith("evaluation-control:")).every((call) => !call.prompt.includes("candidate-only guidance"))).toBe(true);
    expect(calls.filter((call) => call.node_id.startsWith("evaluation-candidate:")).every((call) => call.prompt.includes("candidate-only guidance"))).toBe(true);
    expect(calls.every((call) => call.prompt.includes("do not request tools or human input"))).toBe(true);
    if (result.kind === "measured") {
      const evidence = JSON.parse(context.readWorkspace({ artifact_id: result.evidence_ids[0]!, visibility: "critic_only" }).content);
      expect(evidence).toMatchObject({
        evaluation_run_id: "run-1", revision_id: "candidate",
        execution: { filesystem: "read_only", tools: 0, network: false, human_input: false, ceiling: { max_model_turns: 2, max_events: 8 } },
        control: { model_identity: { provider_id: "fixture", model_id: "same-model", revision: "fixture-response-r1" } },
        candidate: { model_identity: { provider_id: "fixture", model_id: "same-model", revision: "fixture-response-r1" } },
      });
    }
  });

  it("fails closed instead of claiming a result when the native evaluator is unavailable or an arm exposes tools", async () => {
    const context = service();
    const unavailable = new ProductionHarnessEvaluator({ context: () => context, audit_records: () => [corpus("replay-record", "replay"), corpus("holdout-record", "holdout")], native_executor: () => null });
    await expect(unavailable.evaluate({ revision_id: "candidate", run_id: "none" })).resolves.toMatchObject({ kind: "unmeasured", reason: expect.stringContaining("unavailable") });

    const unsafe = {
      ...unbudgeted,
      readOnlyEvaluationCeiling: () => ({ max_model_turns: 2, max_events: 8, max_wall_clock_ms: 100 }),
      evaluateReadOnly: async () => nativeResult("correct", ["file.write"]),
    } as unknown as NativeAgentExecutor;
    const evaluator = new ProductionHarnessEvaluator({ context: () => context, audit_records: () => [corpus("replay-record", "replay"), corpus("holdout-record", "holdout")], native_executor: () => unsafe });
    await expect(evaluator.evaluate({ revision_id: "candidate", run_id: "unsafe" })).resolves.toMatchObject({ kind: "unmeasured", reason: expect.stringContaining("no-tools/read-only") });
  });

  it("marks a controlled pair unmeasured when either arm lacks an observed revision or they differ", async () => {
    const context = service();
    const missingRevision = {
      ...unbudgeted,
      readOnlyEvaluationCeiling: () => ({ max_model_turns: 2, max_events: 8, max_wall_clock_ms: 100 }),
      evaluateReadOnly: async () => ({ ...nativeResult("correct"), model_identity: { provider_id: "fixture", model_id: "same-model", revision: null, capabilities: [] } }),
    } as unknown as NativeAgentExecutor;
    const missingEvaluator = new ProductionHarnessEvaluator({ context: () => context, audit_records: () => [corpus("replay-record", "replay"), corpus("holdout-record", "holdout")], native_executor: () => missingRevision });
    await expect(missingEvaluator.evaluate({ revision_id: "candidate", run_id: "missing-revision" })).resolves.toMatchObject({ kind: "unmeasured", reason: expect.stringContaining("revision is unavailable") });

    let calls = 0;
    const differentRevision = {
      ...unbudgeted,
      readOnlyEvaluationCeiling: () => ({ max_model_turns: 2, max_events: 8, max_wall_clock_ms: 100 }),
      evaluateReadOnly: async () => {
        calls += 1;
        return { ...nativeResult("correct"), model_identity: { provider_id: "fixture", model_id: "same-model", revision: calls % 2 === 0 ? "fixture-response-r2" : "fixture-response-r1", capabilities: [] } };
      },
    } as unknown as NativeAgentExecutor;
    const differentEvaluator = new ProductionHarnessEvaluator({ context: () => context, audit_records: () => [corpus("replay-record", "replay"), corpus("holdout-record", "holdout")], native_executor: () => differentRevision });
    await expect(differentEvaluator.evaluate({ revision_id: "candidate", run_id: "different-revision" })).resolves.toMatchObject({ kind: "unmeasured", reason: expect.stringContaining("same provider/model/revision") });
  });

  it("is reachable from the actual CLI composition and durably settles an absent provider as unmeasured", async () => {
    const repo = mkdtempSync(join(tmpdir(), "arbor-cli-controlled-evaluation-"));
    try {
      const runtime = createCliRuntime(repo); const router = new RuntimeCatalogRouter(runtime);
      expect(runtime.harnessEvaluator?.evaluator_id).toBe("revoy-native-controlled-overlay-v1");
      runtime.manager.startCampaign("campaign", "plan.md", { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" });
      const record = (partition: "replay" | "holdout") => runtime.manager.recordBusMessage({
        campaign_id: "campaign", node_id: "root", author_node_id: "root", recipient_node_id: "seed", other_recipient_node_ids: [], kind: "delegate",
        payload: { content: JSON.stringify({ schema_version: 1, kind: "harness_evaluation_scenario", partition, prompt: `${partition} durable scenario`, expected_final_sha256: `sha256:${hash("correct")}` }), provenance: { tag: "claimed", claimant: "seed" } },
        capability_tier: "specialist", trigger_turn: false, as_of: "2030-01-01T00:00:00.000Z", correlation_id: partition, idempotency_key: partition, acknowledges_communication_id: null, retracts_communication_id: null, conversation_id: "evaluation",
      });
      record("replay"); record("holdout");
      const messages = runtime.manager.getAuditRecords("campaign").filter((item) => item.kind === "node_communication");
      const revision = { id: "candidate", campaign_id: "campaign", task_id: "task", component: "supplemental_prompt" as const, patch: { guidance: "candidate only" }, source_event_ids: messages.map((item) => item.id), source_message_ranges: [{ context_id: "evaluation", thread_id: "root", start_communication_id: messages[0]!.id, end_communication_id: messages[1]!.id, start_byte: 0, end_byte: 1 }], expected_benefit: "fixture", proposed_by: "seed", provenance: { tag: "claimed" as const, claimant: "seed" }, created_at: "2030-01-01T00:00:00.000Z", expires_at: "2031-01-01T00:00:00.000Z" };
      runtime.governedContext.proposeRevision(revision); runtime.governedContext.approveRevision(revision.id, "lenticel");
      const started = await router.dispatchCommand({ schema_version: 1, metadata: { operation_id: "evaluate", idempotency_key: "evaluate", actor_id: "operator", correlation_id: "e2e", requested_at: "2030-01-01T00:00:00.000Z", session: {} }, command: { kind: "harness.evaluation.start", revision_id: revision.id } });
      expect(started).toMatchObject({ ok: true, value: { accepted: true } });
      for (let turns = 0; turns < 20 && runtime.governedContext.listEvaluationRuns("campaign")[0]?.state === "running"; turns += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(runtime.governedContext.listEvaluationRuns("campaign")).toMatchObject([{ revision_id: revision.id, state: "unmeasured", evaluator_id: "revoy-native-controlled-overlay-v1", reason: expect.stringContaining("unavailable") }]);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("honors a pre-aborted operator signal before either native arm starts", async () => {
    const context = service(); let calls = 0;
    const native = {
      ...unbudgeted,
      readOnlyEvaluationCeiling: () => ({ max_model_turns: 2, max_events: 8, max_wall_clock_ms: 100 }),
      evaluateReadOnly: async () => { calls += 1; return nativeResult("correct"); },
    } as unknown as NativeAgentExecutor;
    const evaluator = new ProductionHarnessEvaluator({ context: () => context, audit_records: () => [corpus("replay-record", "replay"), corpus("holdout-record", "holdout")], native_executor: () => native });
    const controller = new AbortController(); controller.abort("operator cancelled");
    await expect(evaluator.evaluate({ revision_id: "candidate", run_id: "cancelled", signal: controller.signal })).resolves.toMatchObject({ kind: "unmeasured", reason: expect.stringContaining("cancelled") });
    expect(calls).toBe(0);
  });

  it("denies the paired budget before either control or candidate provider call", async () => {
    const context = service(); let calls = 0;
    const native = {
      reserveReadOnlyEvaluationPair: () => ({ kind: "denied" as const, reason: "campaign token budget would be exceeded" }),
      settleReadOnlyEvaluationPair: () => {},
      readOnlyEvaluationCeiling: () => ({ max_model_turns: 2, max_events: 8, max_wall_clock_ms: 100 }),
      evaluateReadOnly: async () => { calls += 1; return nativeResult("correct"); },
    } as unknown as NativeAgentExecutor;
    const evaluator = new ProductionHarnessEvaluator({ context: () => context, audit_records: () => [corpus("replay-record", "replay"), corpus("holdout-record", "holdout")], native_executor: () => native });
    await expect(evaluator.evaluate({ revision_id: "candidate", run_id: "budget-denied" })).resolves.toMatchObject({ kind: "unmeasured", reason: expect.stringContaining("budget") });
    expect(calls).toBe(0);
  });
});
