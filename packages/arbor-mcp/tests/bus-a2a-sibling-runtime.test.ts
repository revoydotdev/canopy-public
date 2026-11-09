import { describe, expect, it } from "vitest";
import type { Action } from "@arbor/core";
import { CampaignManager } from "../src/manager.js";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import type { A2ABridgeConfig } from "../src/a2a-bridge.js";

const root: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };

function metadata(overrides: Partial<Record<string, string>> = {}) {
  return {
    operation_id: "op-1", idempotency_key: "key-1", correlation_id: "correlation-1", actor_id: "operator",
    requested_at: "2026-08-01T00:00:00.000Z", ...overrides,
  };
}

function makeRouter(options: ConstructorParameters<typeof RuntimeCatalogRouter>[1] = {}) {
  const manager = new CampaignManager();
  manager.startCampaign("campaign", "plan.md", root);
  const runtime = new ArborRuntime({ manager });
  return { manager, runtime, router: new RuntimeCatalogRouter(runtime, options) };
}

describe("G-29: bus.record + bus.history reach the ledger through the catalog router", () => {
  it("records a bus message and projects it back through bus.history with conversation grouping and tier redaction", async () => {
    const { router } = makeRouter();

    const specialistMessage = {
      schema_version: 1 as const,
      metadata: metadata({ operation_id: "op-bus-1", idempotency_key: "bus-1" }),
      command: {
        kind: "bus.record" as const,
        campaign_id: "campaign",
        node_id: "root",
        communication: {
          author_node_id: "worker", recipient_node_id: "root", other_recipient_node_ids: [],
          kind: "report" as const, payload: { content: "specialist update", provenance: { tag: "claimed" as const, claimant: "worker" } },
          capability_tier: "specialist" as const, trigger_turn: false, as_of: "2026-08-01T00:00:00.000Z",
          correlation_id: "correlation-1", idempotency_key: "bus-1", acknowledges_communication_id: null, retracts_communication_id: null,
          conversation_id: "conv-a",
        },
      },
    };
    const criticMessage = {
      schema_version: 1 as const,
      metadata: metadata({ operation_id: "op-bus-2", idempotency_key: "bus-2" }),
      command: {
        kind: "bus.record" as const,
        campaign_id: "campaign",
        node_id: "root",
        communication: {
          author_node_id: "critic-1", recipient_node_id: "root", other_recipient_node_ids: [],
          kind: "clarify" as const, payload: { content: "critic-only note", provenance: { tag: "claimed" as const, claimant: "critic-1" } },
          capability_tier: "critic" as const, trigger_turn: false, as_of: "2026-08-01T00:00:01.000Z",
          correlation_id: "correlation-2", idempotency_key: "bus-2", acknowledges_communication_id: null, retracts_communication_id: null,
          conversation_id: "conv-b",
        },
      },
    };

    await expect(router.dispatchCommand(specialistMessage)).resolves.toMatchObject({ ok: true, value: { accepted: true }, capability: "bus.write" });
    await expect(router.dispatchCommand(criticMessage)).resolves.toMatchObject({ ok: true, value: { accepted: true } });
    // Idempotent replay durably records only once.
    await expect(router.dispatchCommand(specialistMessage)).resolves.toMatchObject({ ok: true, value: { accepted: true } });

    const specialistView = router.executeQuery({
      schema_version: 1, query_id: "bus-1", query: { kind: "bus.history", campaign_id: "campaign", tier: "specialist" },
    });
    expect(specialistView).toMatchObject({ ok: true, capability: "bus.read" });
    if (specialistView.ok) {
      const projection = specialistView.value as { conversations: Map<string, { conversation_id: string; payload_preview: { content: string } }[]> };
      expect(projection.conversations.get("conv-a")).toHaveLength(1);
      expect(projection.conversations.get("conv-a")![0]!.payload_preview.content).toBe("specialist update");
      // Structural redaction: a specialist-tier reader never sees the critic message.
      expect(projection.conversations.has("conv-b")).toBe(false);
    }

    const orchestratorView = router.executeQuery({
      schema_version: 1, query_id: "bus-2", query: { kind: "bus.history", campaign_id: "campaign", tier: "orchestrator" },
    });
    if (orchestratorView.ok) {
      const projection = orchestratorView.value as { conversations: Map<string, unknown[]> };
      expect(projection.conversations.get("conv-b")).toHaveLength(1);
    }
  });
});

describe("G-29: sibling.status reconciles from real delegate/report communications routed through the catalog", () => {
  it("flips active siblings from delegate to closed via communication.record dispatched through the router", async () => {
    const { router } = makeRouter();

    const delegate = {
      schema_version: 1 as const,
      metadata: metadata({ operation_id: "op-del", idempotency_key: "del-1" }),
      command: {
        kind: "communication.record" as const,
        campaign_id: "campaign",
        node_id: "root",
        communication: {
          author_node_id: "root", recipient_node_id: "sib-1", other_recipient_node_ids: [],
          kind: "delegate" as const, payload: { content: "do work", provenance: { tag: "claimed" as const, claimant: "root" } },
          capability_tier: "specialist" as const, trigger_turn: false, as_of: "2026-08-01T00:00:00.000Z",
          correlation_id: "correlation-1", idempotency_key: "del-1", acknowledges_communication_id: null, retracts_communication_id: null,
        },
      },
    };
    await expect(router.dispatchCommand(delegate)).resolves.toMatchObject({ ok: true, value: { accepted: true } });

    const beforeReport = router.executeQuery({
      schema_version: 1, query_id: "sib-1", query: { kind: "sibling.status", campaign_id: "campaign", node_id: "root" },
    });
    expect(beforeReport).toMatchObject({ ok: true, capability: "sibling.read", value: { active: ["sib-1"], within_bounds: true } });
    const beforeDepth = beforeReport.ok ? (beforeReport.value as { depth: number }).depth : -1;
    expect(beforeDepth).toBe(0);

    // Resolve the real delegate record id by reading it back through the
    // already-covered communication.history query.
    const history = router.executeQuery({
      schema_version: 1, query_id: "hist-1",
      query: { kind: "communication.history", campaign_id: "campaign", node_id: "sib-1", limit: 10 },
    });
    const delegateRecordId = history.ok
      ? (history.value as { communications: { id: string; communication: { kind: string } }[] }).communications
        .find((c) => c.communication.kind === "delegate")!.id
      : "";
    expect(delegateRecordId).toBeTruthy();

    const report = {
      schema_version: 1 as const,
      metadata: metadata({ operation_id: "op-rep", idempotency_key: "rep-1" }),
      command: {
        kind: "communication.record" as const,
        campaign_id: "campaign",
        node_id: "sib-1",
        communication: {
          author_node_id: "sib-1", recipient_node_id: "root", other_recipient_node_ids: [],
          kind: "report" as const, payload: { content: "done", provenance: { tag: "claimed" as const, claimant: "sib-1" } },
          capability_tier: "specialist" as const, trigger_turn: false, as_of: "2026-08-01T00:00:01.000Z",
          correlation_id: "correlation-2", idempotency_key: "rep-1",
          acknowledges_communication_id: delegateRecordId, retracts_communication_id: null,
        },
      },
    };

    await expect(router.dispatchCommand(report)).resolves.toMatchObject({ ok: true, value: { accepted: true } });

    const afterReport = router.executeQuery({
      schema_version: 1, query_id: "sib-2", query: { kind: "sibling.status", campaign_id: "campaign", node_id: "root" },
    });
    expect(afterReport).toMatchObject({ ok: true, value: { active: [] } });
  });
});

describe("G-29: a2a.send + a2a.receive bridge to/from NodeCommunication through the catalog", () => {
  const bridgeConfig: A2ABridgeConfig = { signing_secret: "test-a2a-secret", default_recipient_tier: "specialist" };

  it("keeps a2a commands unavailable until a bridge config is injected", async () => {
    const { router } = makeRouter();
    const receive = {
      schema_version: 1 as const,
      metadata: metadata({ operation_id: "op-a2a-recv", idempotency_key: "a2a-recv-1" }),
      command: {
        kind: "a2a.receive" as const, campaign_id: "campaign", node_id: "root",
        message: {
          id: "msg-in", task_id: "task-in", author_node_ref: "external-agent", recipient_node_refs: ["root"],
          parts: [{ kind: "text" as const, text: "external request" }], as_of: "2026-08-01T00:00:00.000Z",
        },
      },
    };
    await expect(router.dispatchCommand(receive)).resolves.toMatchObject({ ok: true, value: { accepted: false, error: { code: "unavailable" } } });
  });

  it("a2a.receive converts an inbound A2A message into a durably recorded NodeCommunication", async () => {
    const { router } = makeRouter({ a2a_bridge: bridgeConfig });
    const receive = {
      schema_version: 1 as const,
      metadata: metadata({ operation_id: "op-a2a-recv", idempotency_key: "a2a-recv-1" }),
      command: {
        kind: "a2a.receive" as const, campaign_id: "campaign", node_id: "root",
        message: {
          id: "msg-in", task_id: "task-in", author_node_ref: "external-agent", recipient_node_refs: ["root"],
          parts: [{ kind: "text" as const, text: "external request" }], as_of: "2026-08-01T00:00:00.000Z",
        },
      },
    };
    await expect(router.dispatchCommand(receive)).resolves.toMatchObject({ ok: true, value: { accepted: true }, capability: "a2a.write" });

    const history = router.executeQuery({
      schema_version: 1, query_id: "hist-2",
      query: { kind: "communication.history", campaign_id: "campaign", node_id: "root", limit: 10 },
    });
    expect(history).toMatchObject({
      ok: true,
      value: { communications: [{ communication: { payload: { content: "external request" }, idempotency_key: "a2a:msg-in" } }] },
    });
  });

  it("a2a.send records the outbound communication and projects it back as a wire-format A2A message", async () => {
    const { router } = makeRouter({ a2a_bridge: bridgeConfig });
    const send = {
      schema_version: 1 as const,
      metadata: metadata({ operation_id: "op-a2a-send", idempotency_key: "a2a:msg-out" }),
      command: {
        kind: "a2a.send" as const, campaign_id: "campaign", node_id: "root",
        communication: {
          author_node_id: "root", recipient_node_id: "external-agent", other_recipient_node_ids: [],
          kind: "report" as const, payload: { content: "internal result", provenance: { tag: "claimed" as const, claimant: "root" } },
          capability_tier: "specialist" as const, trigger_turn: false, as_of: "2026-08-01T00:00:02.000Z",
          correlation_id: "a2a:task-out", idempotency_key: "a2a:msg-out",
          acknowledges_communication_id: null, retracts_communication_id: null,
        },
      },
    };
    const result = await router.dispatchCommand(send);
    expect(result).toMatchObject({
      ok: true,
      capability: "a2a.write",
      value: { accepted: true, message: { id: "msg-out", task_id: "task-out", parts: [{ kind: "text", text: "internal result" }] } },
    });

    const history = router.executeQuery({
      schema_version: 1, query_id: "hist-3",
      query: { kind: "communication.history", campaign_id: "campaign", node_id: "root", limit: 10 },
    });
    expect(history).toMatchObject({
      ok: true,
      value: { communications: [{ communication: { idempotency_key: "a2a:msg-out", payload: { content: "internal result" } } }] },
    });
  });

  it("rejects denied or internally inconsistent outbound bridge calls and leaves an auditable terminal operation", async () => {
    const send = {
      schema_version: 1 as const,
      metadata: metadata({ operation_id: "op-a2a-denied", idempotency_key: "metadata-key" }),
      command: {
        kind: "a2a.send" as const, campaign_id: "campaign", node_id: "root",
        communication: {
          author_node_id: "root", recipient_node_id: "external-agent", other_recipient_node_ids: [], kind: "report" as const,
          payload: { content: "do not deliver", provenance: { tag: "claimed" as const, claimant: "root" } }, capability_tier: "specialist" as const,
          trigger_turn: false, as_of: "2026-08-01T00:00:02.000Z", correlation_id: "task", idempotency_key: "metadata-key", acknowledges_communication_id: null, retracts_communication_id: null,
        },
      },
    };
    const denied = makeRouter({ a2a_bridge: bridgeConfig, granted_capabilities: new Set() });
    await expect(denied.router.dispatchCommand(send)).resolves.toMatchObject({ ok: true, value: { accepted: false, error: { code: "permission" } } });
    expect(denied.runtime.operations.get("op-a2a-denied")).toMatchObject({ state: "rejected" });

    const inconsistent = makeRouter({ a2a_bridge: bridgeConfig });
    const mismatched = { ...send, metadata: metadata({ operation_id: "op-a2a-mismatch", idempotency_key: "metadata-key" }), command: { ...send.command, communication: { ...send.command.communication, idempotency_key: "different-key" } } };
    await expect(inconsistent.router.dispatchCommand(mismatched)).resolves.toMatchObject({ ok: true, value: { accepted: false, error: { code: "internal" } } });
    expect(inconsistent.runtime.operations.get("op-a2a-mismatch")).toMatchObject({ state: "rejected" });
    expect(inconsistent.router.executeQuery({ schema_version: 1, query_id: "empty-history", query: { kind: "communication.history", campaign_id: "campaign", node_id: "root", limit: 5 } }))
      .toMatchObject({ ok: true, value: { communications: [] } });
  });

  it("accepts real wire content while keeping a peer task state as a non-authoritative operation note", async () => {
    const { router, runtime } = makeRouter({ a2a_bridge: bridgeConfig });
    const receive = {
      schema_version: 1 as const, metadata: metadata({ operation_id: "op-a2a-wire", idempotency_key: "wire-1" }),
      command: {
        kind: "a2a.receive" as const, campaign_id: "campaign", node_id: "root",
        message: { id: "fallback", task_id: "fallback-task", author_node_ref: "external", recipient_node_refs: ["root"], parts: [{ kind: "text" as const, text: "fallback" }], as_of: "2026-08-01T00:00:00.000Z" },
        wire: { messageId: "wire-message", contextId: "wire-context", taskId: "wire-task", role: "ROLE_AGENT", parts: [{ text: "wire wins" }], metadata: { "arbor.dev/task-state": "TASK_STATE_WORKING", "arbor.dev/recipient-node-refs": ["root"] } },
      },
    };
    await expect(router.dispatchCommand(receive)).resolves.toMatchObject({ ok: true, value: { accepted: true } });
    expect(runtime.operations.get("op-a2a-wire")?.result_summary).toContain("peer asserted working; not trusted for authority");
    expect(router.executeQuery({ schema_version: 1, query_id: "wire-history", query: { kind: "communication.history", campaign_id: "campaign", node_id: "root", limit: 5 } }))
      .toMatchObject({ ok: true, value: { communications: [{ communication: { payload: { content: "wire wins" } } }] } });
  });

  it("fails closed for malformed sibling status and unavailable A2A card publication", () => {
    const { router } = makeRouter();
    expect(router.executeQuery({ schema_version: 1, query_id: "sibling-invalid", query: { kind: "sibling.status", campaign_id: "campaign", node_id: "" } }))
      .toMatchObject({ ok: false, error: { code: "validation" }, capability: null });
    expect(router.executeQuery({ schema_version: 1, query_id: "cards", query: { kind: "a2a.cards", campaign_id: "campaign" } }))
      .toMatchObject({ ok: false, error: { code: "unavailable" }, capability: "a2a.read" });
    expect(new RuntimeCatalogRouter(new ArborRuntime(), { a2a_bridge: bridgeConfig }).executeQuery({ schema_version: 1, query_id: "missing", query: { kind: "a2a.cards", campaign_id: "missing" } }))
      .toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});
