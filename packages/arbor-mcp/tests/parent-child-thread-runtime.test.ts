import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CampaignManager } from "../src/manager.js";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";

const root = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
const provenance = { tag: "claimed" as const, claimant: "operator" };

function metadata(id: string, correlationId = `corr-${id}`) {
  return { operation_id: id, idempotency_key: `idem-${id}`, correlation_id: correlationId, actor_id: "operator", requested_at: "2026-08-08T00:00:00.000Z" };
}

async function send(router: RuntimeCatalogRouter, id: string, fields: Record<string, unknown>, correlationId?: string) {
  return await router.dispatchCommand({ schema_version: 1, metadata: metadata(id, correlationId), command: { kind: "bus.thread.send", expected_thread_version: "origin", ...fields } });
}

function acceptedMessageId(result: Awaited<ReturnType<typeof send>>): string {
  if (!result.ok || !result.value.accepted || !("message_id" in result.value)) return "";
  return String(result.value.message_id);
}

describe("parent-child durable conversation threads", () => {
  it("notifies an optional push adapter only after durable history advances; duplicate/rejected delivery cannot change authority", async () => {
    const manager = new CampaignManager();
    manager.startCampaign("campaign", "plan.md", root);
    const child = manager.branch("campaign", "root", [{ ...root, description: "child" }])[0]!;
    const pushed: Array<{ message_id: string; version: string; reason: string }> = [];
    const router = new RuntimeCatalogRouter(new ArborRuntime({ manager }), {
      thread_push: { notify(event) {
        // The adapter is passed only an already-replayable cursor; it cannot
        // make a message exist.  This would fail if delivery preceded append.
        const history = manager.getParentChildThread(event.campaign_id, event.parent_node_id, event.child_node_id);
        expect(history.version).toBe(event.version);
        expect(history.messages.some((message) => message.id === event.message_id)).toBe(true);
        pushed.push({ message_id: event.message_id, version: event.version, reason: event.reason });
      } },
    });
    const fields = { campaign_id: "campaign", parent_node_id: "root", child_node_id: child, from_node_id: "root", message_kind: "delegate", content: "durable first", provenance, capability_tier: "specialist" };
    const first = await send(router, "push", fields);
    const messageId = acceptedMessageId(first);
    expect(first).toMatchObject({ ok: true, value: { accepted: true, delivery: "durable" } });
    expect(pushed).toEqual([{ message_id: messageId, version: messageId, reason: "message_appended" }]);
    // Operation idempotency prevents a retry from producing another wake-up.
    expect(await send(router, "push", fields)).toMatchObject({ ok: true, value: { accepted: true } });
    expect(pushed).toHaveLength(1);

    const throwing = new RuntimeCatalogRouter(new ArborRuntime({ manager }), { thread_push: { notify() { throw new Error("socket gone"); } } });
    const second = await send(throwing, "push-failure", { ...fields, expected_thread_version: messageId, content: "still durable" });
    expect(second).toMatchObject({ ok: true, value: { accepted: true, delivery: "durable" } });
    expect(manager.getParentChildThread("campaign", "root", child).messages).toHaveLength(2);
  });

  it("durably supports bidirectional reply, explicit ack, needs-attention, and restart restoration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-parent-child-thread-"));
    try {
      const manager = new CampaignManager({ persistence_dir: dir });
      manager.startCampaign("campaign", "plan.md", root);
      const child = manager.branch("campaign", "root", [{ ...root, description: "child", delegate_to: "seed" }])[0]!;
      const router = new RuntimeCatalogRouter(new ArborRuntime({ manager }));
      const childFirst = await send(router, "child-first", {
        campaign_id: "campaign", parent_node_id: "root", child_node_id: child, from_node_id: child,
        message_kind: "clarify", intent: "needs_attention", content: "Need a constraint", evidence_refs: ["audit://evidence/constraint"], provenance, capability_tier: "specialist",
        ack_required: true, deadline_at: "2027-08-08T00:00:00.000Z",
      }, "thread-correlation");
      expect(childFirst).toMatchObject({ ok: true, value: { accepted: true, delivery: "durable" } });
      const childMessageId = acceptedMessageId(childFirst);
      expect(await send(router, "parent-reply", {
        campaign_id: "campaign", parent_node_id: "root", child_node_id: child, from_node_id: "root",
        message_kind: "reply", intent: "response", content: "Use the local package boundary", provenance, capability_tier: "specialist",
        parent_communication_id: childMessageId, reply_to_communication_id: childMessageId, expected_thread_version: childMessageId,
      }, "thread-correlation")).toMatchObject({ ok: true, value: { accepted: true } });

      const beforeAck = router.executeQuery({ schema_version: 1, query_id: "before-ack", query: { kind: "bus.thread.history", campaign_id: "campaign", parent_node_id: "root", child_node_id: child } });
      const replyId = beforeAck.ok && typeof beforeAck.value === "object" && beforeAck.value !== null && "messages" in beforeAck.value
        ? (beforeAck.value.messages as Array<{ id: string }>).at(-1)?.id ?? ""
        : "";
      expect(beforeAck).toMatchObject({ ok: true, value: { needs_attention_message_ids: [childMessageId], messages: [
        { author_node_id: child, intent: "needs_attention", delivery: "pending", payload_preview: { evidence_refs: ["audit://evidence/constraint"] } },
        { author_node_id: "root", intent: "response", reply_to_communication_id: childMessageId },
      ] } });
      const ackEnvelope = { schema_version: 1 as const, metadata: metadata("ack", "different-correlation-is-replaced-by-target"), command: {
        kind: "bus.thread.ack", campaign_id: "campaign", parent_node_id: "root", child_node_id: child, from_node_id: "root",
        expected_thread_version: replyId, message_id: childMessageId, provenance, capability_tier: "specialist",
      } };
      const acknowledged = await router.dispatchCommand(ackEnvelope);
      expect(acknowledged).toMatchObject({ ok: true, value: { accepted: true, delivery: "durable" } });
      // Sender idempotency is shared with every other direct-thread append:
      // retrying the same ack cannot append a second acknowledgement.
      expect(await router.dispatchCommand(ackEnvelope)).toMatchObject({ ok: true, value: { accepted: true } });

      const query = { schema_version: 1 as const, query_id: "history", query: { kind: "bus.thread.history" as const, campaign_id: "campaign", parent_node_id: "root", child_node_id: child } };
      const before = router.executeQuery(query);
      expect(before).toMatchObject({ ok: true, value: { parent_node_id: "root", child_node_id: child, can_accept_direct_input: true, messages: [
        { author_node_id: child, delivery: "acknowledged", payload_preview: { evidence_refs: ["audit://evidence/constraint"] } }, { author_node_id: "root", parent_communication_id: childMessageId }, { author_node_id: "root", acknowledges_communication_id: childMessageId },
      ] } });
      const restored = new RuntimeCatalogRouter(new ArborRuntime({ manager: new CampaignManager({ persistence_dir: dir }) }));
      expect(restored.executeQuery(query)).toMatchObject({ ok: true, value: { messages: [
        { author_node_id: child, delivery: "acknowledged" }, { author_node_id: "root", delivery: "acknowledged" }, { author_node_id: "root", acknowledges_communication_id: childMessageId },
      ] } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects cross-thread replies and derives timeout only from persisted deadline plus query time", async () => {
    const manager = new CampaignManager();
    manager.startCampaign("campaign", "plan.md", root);
    const child = manager.branch("campaign", "root", [{ ...root, description: "child" }])[0]!;
    const sibling = manager.branch("campaign", "root", [{ ...root, description: "sibling" }])[0]!;
    const router = new RuntimeCatalogRouter(new ArborRuntime({ manager }));
    const first = await send(router, "deadline", {
      campaign_id: "campaign", parent_node_id: "root", child_node_id: child, from_node_id: "root", message_kind: "delegate",
      content: "work", provenance, capability_tier: "specialist", intent: "request", ack_required: true, deadline_at: "2026-08-09T00:00:00.000Z",
    }, "same-correlation");
    const firstId = acceptedMessageId(first);
    expect(router.executeQuery({ schema_version: 1, query_id: "timed-out", query: { kind: "bus.thread.history", campaign_id: "campaign", parent_node_id: "root", child_node_id: child, as_of: "2026-08-10T00:00:00.000Z" } }))
      .toMatchObject({ ok: true, value: { messages: [{ delivery: "timed_out", intent: "request" }] } });
    expect(await send(router, "wrong-correlation", {
      campaign_id: "campaign", parent_node_id: "root", child_node_id: child, from_node_id: child, message_kind: "reply", content: "wrong correlation",
      provenance, capability_tier: "specialist", reply_to_communication_id: firstId, expected_thread_version: firstId,
    }, "different-correlation")).toMatchObject({ ok: true, value: { accepted: false, error: { code: "conflict" } } });
    expect(await send(router, "cross-thread", {
      campaign_id: "campaign", parent_node_id: "root", child_node_id: sibling, from_node_id: "root", message_kind: "reply", content: "wrong thread",
      provenance, capability_tier: "specialist", reply_to_communication_id: firstId,
    }, "same-correlation")).toMatchObject({ ok: true, value: { accepted: false, error: { code: "conflict" } } });
  });

  it("enforces direct-tree endpoint, thread linkage, idempotency and reader capability isolation", async () => {
    const manager = new CampaignManager();
    manager.startCampaign("campaign", "plan.md", root);
    const child = manager.branch("campaign", "root", [{ ...root, description: "child" }])[0]!;
    const outsider = manager.branch("campaign", "root", [{ ...root, description: "outsider" }])[0]!;
    const router = new RuntimeCatalogRouter(new ArborRuntime({ manager }));
    const base = { campaign_id: "campaign", parent_node_id: "root", child_node_id: child, from_node_id: "root", message_kind: "delegate", content: "work", provenance, capability_tier: "critic" };
    const sent = await send(router, "sealed", base);
    expect(sent).toMatchObject({ ok: true, value: { accepted: true } });
    expect(await send(router, "sealed", base)).toMatchObject({ ok: true, value: { accepted: true } });
    expect(await send(router, "stale", { ...base, from_node_id: child })).toMatchObject({ ok: true, value: { accepted: false, error: { code: "conflict" } } });
    expect(await send(router, "outsider", { ...base, from_node_id: outsider })).toMatchObject({ ok: true, value: { accepted: false, error: { code: "conflict" } } });
    const specialist = new RuntimeCatalogRouter(new ArborRuntime({ manager }), { communication_tier: "specialist" });
    expect(specialist.executeQuery({ schema_version: 1, query_id: "redacted", query: { kind: "bus.thread.history", campaign_id: "campaign", parent_node_id: "root", child_node_id: child } }))
      .toMatchObject({ ok: true, value: { messages: [] } });
  });
});
