import { describe, expect, it } from "vitest";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import type { HarnessEvaluationPort } from "../src/harness-evaluation-port.js";
import type { Provenance } from "@arbor/core";

const provenance: Provenance = { tag: "claimed", claimant: "seed" };
const metadata = (operation_id: string, actor_id = "operator") => ({ operation_id, idempotency_key: `${operation_id}:key`, correlation_id: operation_id, actor_id, requested_at: "2030-01-01T00:00:00.000Z" });

function prepared(evaluator: HarnessEvaluationPort) {
  const runtime = new ArborRuntime({ harness_evaluator: evaluator });
  runtime.manager.startCampaign("c", "plan.md", { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" });
  runtime.manager.recordBusMessage({ campaign_id: "c", node_id: "root", author_node_id: "root", recipient_node_id: "child", other_recipient_node_ids: [], kind: "delegate", payload: { content: "source", provenance }, capability_tier: "specialist", trigger_turn: false, as_of: "2030-01-01T00:00:00.000Z", correlation_id: "source", idempotency_key: "source", acknowledges_communication_id: null, retracts_communication_id: null, conversation_id: "thread" });
  const message = runtime.manager.getAuditRecords("c").find((record) => record.kind === "node_communication"); if (!message) throw new Error("fixture has no durable source message");
  runtime.governedContext.proposeRevision({ id: "revision", campaign_id: "c", task_id: "task", component: "supplemental_prompt", patch: { guidance: "bounded" }, source_event_ids: [message.id], source_message_ranges: [{ context_id: "thread", thread_id: "root", start_communication_id: message.id, end_communication_id: message.id, start_byte: 0, end_byte: 1 }], expected_benefit: "evaluation", proposed_by: "seed", provenance, created_at: "2030-01-01T00:00:00.000Z", expires_at: "2031-01-01T00:00:00.000Z" });
  runtime.governedContext.approveRevision("revision", "lenticel");
  return { runtime, router: new RuntimeCatalogRouter(runtime) };
}

describe("harness evaluation lifecycle", () => {
  it("dispatches one evaluator for duplicate operation retries and cancels it into a durable retryable run", async () => {
    let calls = 0; let aborts = 0;
    const evaluator: HarnessEvaluationPort = {
      evaluator_id: "slow-hermetic",
      evaluate: async ({ signal }) => {
        calls += 1;
        return new Promise((resolve) => {
          const stop = () => { aborts += 1; resolve({ kind: "unmeasured" as const, reason: "observed abort" }); };
          if (signal?.aborted) stop(); else signal?.addEventListener("abort", stop, { once: true });
        });
      },
    };
    const { runtime, router } = prepared(evaluator);
    const start = { schema_version: 1 as const, metadata: metadata("evaluation-op"), command: { kind: "harness.evaluation.start" as const, revision_id: "revision" } };
    expect(await router.dispatchCommand(start)).toMatchObject({ ok: true, value: { accepted: true, operation_id: "evaluation-op" } });
    expect(await router.dispatchCommand(start)).toMatchObject({ ok: true, value: { accepted: true, operation_id: "evaluation-op" } });
    expect(calls).toBe(1);
    expect(await router.dispatchCommand({ schema_version: 1, metadata: metadata("cancel-op"), command: { kind: "operation.cancel", target_operation_id: "evaluation-op" } })).toMatchObject({ ok: true, value: { accepted: true } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(aborts).toBe(1);
    expect(runtime.operations.get("evaluation-op")).toMatchObject({ state: "cancelled" });
    expect(runtime.governedContext.getEvaluationRun("evaluation:evaluation-op")).toMatchObject({ state: "unmeasured", reason: "controlled evaluation was cancelled" });
  });
});
