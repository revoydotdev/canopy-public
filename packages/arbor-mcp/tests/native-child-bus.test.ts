import { describe, expect, it } from "vitest";
import type { Action } from "@arbor/core";
import { NativeHarnessWorker, NativeSessionEngine, type NativeModelPort, type NativeToolPort, type NativeToolRequest, type SessionStartRequest } from "@arbor/harness";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { createNativeBusThreadToolPorts, createNativeClarificationToolPort } from "../src/native-tool-host.js";
import type { NativeBusThreadScope } from "../src/native-bus-thread-contracts.js";

const root: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };

/** A real ArborRuntime with one genuine parent/child edge, plus a second unrelated child to prove foreign-edge denial against a real (not fabricated) node. */
function setup(): { runtime: ArborRuntime; router: RuntimeCatalogRouter; child: string; otherChild: string } {
  const runtime = new ArborRuntime();
  runtime.manager.startCampaign("campaign", "plan.md", root);
  const [child] = runtime.manager.branch("campaign", "root", [{ ...root, description: "child", delegate_to: "seed" }]);
  const [otherChild] = runtime.manager.branch("campaign", "root", [{ ...root, description: "other-child", delegate_to: "seed" }]);
  if (!child || !otherChild) throw new Error("missing child");
  const router = new RuntimeCatalogRouter(runtime);
  return { runtime, router, child, otherChild };
}

function scopeFor(campaignId: string, parentNodeId: string, childNodeId: string): NativeBusThreadScope {
  return { campaign_id: campaignId, parent_node_id: parentNodeId, child_node_id: childNodeId, capability_tier: "specialist", provenance: { tag: "claimed", claimant: "native-child-bus-test" } };
}

function toolRequest(sessionId: string, input: unknown): NativeToolRequest {
  return { session_id: sessionId, turn: 1, call_id: `call-${sessionId}`, input, workspace_roots: [], filesystem: "read_only", intent_evidence: [], network_allowed: false };
}

function workerStart(sessionId: string, tool: string): SessionStartRequest {
  return {
    session_id: sessionId,
    policy: {
      filesystem: "read_only", approvals: "never", tool_allow: [tool], tool_deny: [], workspace_roots: ["/workspace"],
      max_wall_clock_ms: 1_000, max_events: 16, network_allowed: false, ambient_plugins_allowed: false,
      user_configuration_allowed: false, inherited_credentials_allowed: false,
    },
    required_capabilities: [], lineage: { kind: "new" }, ephemeral: false,
  };
}

async function workerRoundTrip(tool: string, ports: readonly NativeToolPort[], input: unknown): Promise<ReturnType<NativeSessionEngine["observe"]>> {
  const sessionId = `worker-${tool}`;
  let turn = 0;
  const model: NativeModelPort = {
    async run() {
      turn += 1;
      return turn === 1
        ? { text: [], tool_calls: [{ call_id: "bus-call", tool, input, input_summary: tool, risk: "low" }], final_message: null }
        : { text: [], tool_calls: [], final_message: "bus tool completed" };
    },
  };
  const engine = new NativeSessionEngine({ clock: { now: () => 1_700_000_000_000 }, capabilities: [] });
  const result = await new NativeHarnessWorker({ session_engine: engine, model, tools: ports })
    .run({ start: workerStart(sessionId, tool), prompt: "exercise native bus tool", max_turns: 2 });
  expect(result.session.state).toBe("completed");
  return engine.observe(sessionId);
}

async function callTool(ports: readonly { tool: string; execute: (request: NativeToolRequest, secret: string | null, signal: AbortSignal) => Promise<{ model_output: string; evidence: { outcome: string; code: string; action_scope?: unknown } }> }[], tool: string, req: NativeToolRequest) {
  const port = ports.find((p) => p.tool === tool);
  if (!port) throw new Error(`no port for ${tool}`);
  const response = await port.execute(req, null, new AbortController().signal);
  return { ...response, payload: JSON.parse(response.model_output) as Record<string, unknown> };
}

describe("bus.thread.clarify through the real worker", () => {
  it("a model-issued clarify (no thread version supplied) lands durably on the trusted edge, even when no reply arrives in time", async () => {
    const { runtime, router, child } = setup();
    const scope = scopeFor("campaign", "root", child);
    // The parent already wrote once: a model that cannot read the version would otherwise be stale.
    runtime.manager.recordParentChildThreadMessage({
      campaign_id: "campaign", node_id: "root", parent_node_id: "root", child_node_id: child,
      expected_thread_version: "origin", author_node_id: "root", recipient_node_id: child, other_recipient_node_ids: [], kind: "delegate",
      payload: { content: "go", provenance: { tag: "claimed", claimant: "parent" } }, capability_tier: "orchestrator",
      trigger_turn: true, as_of: new Date().toISOString(), correlation_id: "seed", idempotency_key: "seed-msg",
      acknowledges_communication_id: null, retracts_communication_id: null, parent_communication_id: null, intent: "request",
      reply_to_communication_id: null, ack_required: false, deadline_at: null,
    });
    const port = createNativeClarificationToolPort({ router, resolve_scope: ({ session_id }) => session_id.startsWith("worker-") ? scope : null });
    expect((port as { model_definition?: { name: string } }).model_definition?.name).toBe("bus.thread.clarify");
    const events = await workerRoundTrip("bus.thread.clarify", [port], { question: "which db?", timeout_ms: 60 });
    expect(events.find((event) => event.kind === "tool_result")).toMatchObject({ payload: { success: false, evidence: { code: "clarify_timeout" } } });
    const messages = runtime.manager.getParentChildThread("campaign", "root", child).messages;
    expect(messages.at(-1)).toMatchObject({ kind: "clarify", author_node_id: child, intent: "needs_attention" });
    expect(messages.at(-1)!.payload_preview).toMatchObject({ content: "which db?" });
  });
});

describe("native child-to-parent bus tool ports", () => {
  it("round-trips a bounded clarification on exactly the trusted parent edge", async () => {
    const { runtime, router, child, otherChild } = setup();
    const scope = scopeFor("campaign", "root", child);
    const originalDispatch = router.dispatchCommand.bind(router);
    router.dispatchCommand = (async (envelope: Parameters<typeof router.dispatchCommand>[0]) => {
      const result = await originalDispatch(envelope);
      const question = runtime.manager.getParentChildThread("campaign", "root", child).messages.at(-1);
      if (question?.kind === "clarify") {
        const questionId = question.id;
        if (questionId === undefined) throw new Error("clarification was not persisted");
        runtime.manager.recordParentChildThreadMessage({
          campaign_id: "campaign", node_id: "root", parent_node_id: "root", child_node_id: child,
          expected_thread_version: runtime.manager.getParentChildThread("campaign", "root", child).version,
          author_node_id: "root", recipient_node_id: child, other_recipient_node_ids: [], kind: "reply",
          payload: { content: "yes, continue", provenance: { tag: "claimed", claimant: "parent" } }, capability_tier: "orchestrator",
          trigger_turn: true, as_of: new Date().toISOString(), correlation_id: "session-child", idempotency_key: "clarify-reply-id",
          acknowledges_communication_id: null, retracts_communication_id: null, parent_communication_id: null,
          intent: "response", reply_to_communication_id: questionId, ack_required: false, deadline_at: null,
        });
      }
      return result;
    }) as typeof router.dispatchCommand;
    const port = createNativeClarificationToolPort({ router, resolve_scope: (request) => request.session_id === "session-child" ? scope : null });
    const result = await port.execute(toolRequest("session-child", { expected_thread_version: runtime.manager.getParentChildThread("campaign", "root", child).version, question: "may I continue?", timeout_ms: 100 }), null, new AbortController().signal);
    expect(result.evidence, result.result_summary).toMatchObject({ outcome: "succeeded", action_scope: { status: "bound" } });
    expect(JSON.parse(result.model_output)).toMatchObject({ reply: { content: "yes, continue" } });

    const denied = await port.execute({ ...toolRequest("session-child", { expected_thread_version: runtime.manager.getParentChildThread("campaign", "root", child).version, question: "foreign", child_node_id: otherChild, timeout_ms: 100 }), call_id: "clarify-foreign" }, null, new AbortController().signal);
    expect(denied.evidence).toMatchObject({ outcome: "refused", code: "bus_thread_scope_denied" });
  });

  it("times out and cancels bounded clarification waits without losing their durable question", async () => {
    const { runtime, router, child } = setup();
    const scope = scopeFor("campaign", "root", child);
    const port = createNativeClarificationToolPort({ router, resolve_scope: () => scope });
    const timeout = await port.execute(toolRequest("session-child", { expected_thread_version: runtime.manager.getParentChildThread("campaign", "root", child).version, question: "any reply?", timeout_ms: 1 }), null, new AbortController().signal);
    expect(timeout.evidence).toMatchObject({ outcome: "failed", code: "clarify_timeout" });
    expect(runtime.manager.getParentChildThread("campaign", "root", child).messages).toMatchObject([expect.objectContaining({ kind: "clarify" })]);
    const controller = new AbortController(); controller.abort();
    const cancelled = await port.execute({ ...toolRequest("session-child", { expected_thread_version: runtime.manager.getParentChildThread("campaign", "root", child).version, question: "cancel", timeout_ms: 100 }), call_id: "clarify-cancel" }, null, controller.signal);
    expect(cancelled.evidence).toMatchObject({ outcome: "cancelled", code: "cancelled" });
  });

  it("permits one in-flight clarification and replays an identical completed call without a second ledger write", async () => {
    const { runtime, router, child } = setup();
    const scope = scopeFor("campaign", "root", child);
    const port = createNativeClarificationToolPort({ router, resolve_scope: () => scope });
    const firstRequest = { ...toolRequest("session-child", { expected_thread_version: runtime.manager.getParentChildThread("campaign", "root", child).version, question: "first", timeout_ms: 100 }), call_id: "clarify-first" };
    const first = port.execute(firstRequest, null, new AbortController().signal);
    const second = await port.execute({ ...toolRequest("session-child", { expected_thread_version: runtime.manager.getParentChildThread("campaign", "root", child).version, question: "second", timeout_ms: 100 }), call_id: "clarify-second" }, null, new AbortController().signal);
    expect(second.evidence).toMatchObject({ outcome: "failed", code: "clarify_in_flight" });
    const settled = await first;
    expect(settled.evidence).toMatchObject({ outcome: "failed", code: "clarify_timeout" });
    const replay = await port.execute(firstRequest, null, new AbortController().signal);
    expect(replay).toEqual(settled);
    expect(port.recovery_protection?.(firstRequest)).toMatchObject({ effect_kind: "external", repeatable: true, idempotency_key_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/), acknowledged_by: "revoy-native-bus-thread-clarify:v1" });
    const collision = await port.execute({ ...firstRequest, input: { expected_thread_version: runtime.manager.getParentChildThread("campaign", "root", child).version, question: "changed question", timeout_ms: 100 } }, null, new AbortController().signal);
    expect(collision.evidence).toMatchObject({ outcome: "refused", code: "clarify_idempotency_collision" });
    expect(collision).not.toEqual(settled);
    expect(runtime.manager.getParentChildThread("campaign", "root", child).messages).toHaveLength(1);
  });

  it("posts on the child's own parent edge and the message is genuinely readable via bus.thread.history", async () => {
    const { runtime, router, child } = setup();
    const scope = scopeFor("campaign", "root", child);
    const ports = createNativeBusThreadToolPorts({ router, resolve_scope: (r) => (r.session_id === "session-child" ? scope : null) });
    const before = runtime.manager.getParentChildThread("campaign", "root", child);

    const result = await callTool(ports, "bus.thread.send", toolRequest("session-child", {
      expected_thread_version: before.version, message_kind: "report", content: "child status: working", ack_required: false,
    }));

    expect(result.evidence.outcome).toBe("succeeded");
    expect(result.evidence.action_scope).toMatchObject({ status: "bound", provenance_tag: "claimed", scope_id_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) });
    expect(result.payload).toMatchObject({ outcome: "succeeded" });
    const messageId = result.payload.message_id as string;
    expect(typeof messageId).toBe("string");

    // Real ledger round trip: read it back through the same catalog kind a
    // parent would use, not a mock or an internal field on the tool result.
    const history = runtime.manager.getParentChildThread("campaign", "root", child);
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0]).toMatchObject({ id: messageId, author_node_id: child, recipient_node_ids: ["root"], kind: "report", payload_preview: { content: "child status: working" } });
  });

  it("denies a send targeting a foreign edge with an explicit, specific failure — never a silent redirect", async () => {
    const { runtime, router, child, otherChild } = setup();
    const scope = scopeFor("campaign", "root", child);
    const ports = createNativeBusThreadToolPorts({ router, resolve_scope: (r) => (r.session_id === "session-child" ? scope : null) });
    const before = runtime.manager.getParentChildThread("campaign", "root", child);

    // The dispatched child (scoped to `child`) tries to name a different real
    // node as the recipient edge.
    const result = await callTool(ports, "bus.thread.send", toolRequest("session-child", {
      expected_thread_version: before.version, message_kind: "report", content: "trying to reach a sibling's parent edge", child_node_id: otherChild,
    }));

    expect(result.evidence.outcome).toBe("refused");
    expect(result.evidence.code).toBe("bus_thread_scope_denied");
    expect(result.payload).toMatchObject({ outcome: "refused", code: "bus_thread_scope_denied" });

    // Nothing was appended anywhere — neither the named edge nor the real one.
    expect(runtime.manager.getParentChildThread("campaign", "root", child).messages).toHaveLength(0);
    expect(runtime.manager.getParentChildThread("campaign", "root", otherChild).messages).toHaveLength(0);
  });

  it("refuses every bus-thread tool when the session has no resolved scope at all", async () => {
    const { router, child } = setup();
    const scope = scopeFor("campaign", "root", child);
    const ports = createNativeBusThreadToolPorts({ router, resolve_scope: (r) => (r.session_id === "session-child" ? scope : null) });

    const result = await callTool(ports, "bus.thread.send", toolRequest("session-unknown", { expected_thread_version: "origin", message_kind: "report", content: "x" }));
    expect(result.evidence.outcome).toBe("refused");
    expect(result.evidence.code).toBe("missing_bus_thread_scope");
  });

  it("exposes exactly the scoped surface — never sibling.spawn or subagent.execute", async () => {
    const { router, child } = setup();
    const scope = scopeFor("campaign", "root", child);
    const ports = createNativeBusThreadToolPorts({ router, resolve_scope: () => scope });

    const names = ports.map((p) => p.tool).sort();
    expect(names).toEqual(["bus.thread.ack", "bus.thread.send", "sibling.status"]);
    expect(names).not.toContain("sibling.spawn");
    expect(names).not.toContain("subagent.execute");

    // Even a maliciously-shaped input naming a different command kind cannot
    // change what the port dispatches: the discriminant is constructed by
    // this module from the trusted scope, never read from model input.
    const result = await callTool(ports, "bus.thread.send", toolRequest("session-any", {
      kind: "sibling.spawn", expected_thread_version: "origin", message_kind: "report", content: "attempted kind override",
    }));
    expect(result.evidence.outcome).toBe("succeeded");
    expect(result.payload.outcome).toBe("succeeded");
  });

  it("round-trips acknowledgement: an ack_required message the child acks moves out of pending in the projection", async () => {
    const { runtime, router, child } = setup();
    const scope = scopeFor("campaign", "root", child);
    const ports = createNativeBusThreadToolPorts({ router, resolve_scope: () => scope });

    // The parent delegates with ack_required via the manager directly (parent
    // side already exists and is out of scope for this port set).
    const delegated = runtime.manager.recordParentChildThreadMessage({
      campaign_id: "campaign", node_id: "root", parent_node_id: "root", child_node_id: child,
      expected_thread_version: runtime.manager.getParentChildThread("campaign", "root", child).version,
      author_node_id: "root", recipient_node_id: child, other_recipient_node_ids: [], kind: "delegate",
      payload: { content: "please handle this", provenance: { tag: "claimed", claimant: "parent" } },
      capability_tier: "orchestrator", trigger_turn: true, as_of: new Date().toISOString(),
      correlation_id: "corr-1", idempotency_key: "idem-delegate-1",
      acknowledges_communication_id: null, retracts_communication_id: null, parent_communication_id: null,
      intent: "request", reply_to_communication_id: null, ack_required: true, deadline_at: null,
    });

    const pendingBefore = runtime.manager.getParentChildThread("campaign", "root", child);
    const target = pendingBefore.messages.find((m) => m.id === delegated.message_id)!;
    expect(target.delivery).toBe("pending");

    const ackResult = await callTool(ports, "bus.thread.ack", toolRequest("session-child", {
      expected_thread_version: pendingBefore.version, message_id: delegated.message_id,
    }));
    expect(ackResult.evidence.outcome).toBe("succeeded");
    expect(ackResult.evidence.action_scope).toMatchObject({ status: "bound", provenance_tag: "claimed", scope_id_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) });

    const after = runtime.manager.getParentChildThread("campaign", "root", child);
    const acked = after.messages.find((m) => m.id === delegated.message_id)!;
    expect(acked.delivery).toBe("acknowledged");
  });

  it("denies an ack targeting a foreign edge", async () => {
    const { runtime, router, child, otherChild } = setup();
    const scope = scopeFor("campaign", "root", child);
    const ports = createNativeBusThreadToolPorts({ router, resolve_scope: () => scope });
    const before = runtime.manager.getParentChildThread("campaign", "root", otherChild);

    const result = await callTool(ports, "bus.thread.ack", toolRequest("session-child", {
      expected_thread_version: before.version, message_id: "not-a-real-message", child_node_id: otherChild,
    }));
    expect(result.evidence.outcome).toBe("refused");
    expect(result.evidence.code).toBe("bus_thread_scope_denied");
  });

  it("sibling.status reads only this session's own node, never an arbitrary one", async () => {
    const { router, child, otherChild } = setup();
    const scope = scopeFor("campaign", "root", child);
    const ports = createNativeBusThreadToolPorts({ router, resolve_scope: () => scope });

    const denied = await callTool(ports, "sibling.status", toolRequest("session-child", { node_id: otherChild }));
    expect(denied.evidence.outcome).toBe("refused");
    expect(denied.evidence.code).toBe("bus_thread_scope_denied");

    const allowed = await callTool(ports, "sibling.status", toolRequest("session-child", {}));
    expect(allowed.evidence.outcome).toBe("succeeded");
    expect(allowed.evidence.action_scope).toEqual({ status: "not_required" });
    expect(allowed.payload).toMatchObject({ node_id: child, campaign_id: "campaign" });
  });

  it("round-trips every composed bus port through NativeHarnessWorker evidence validation", async () => {
    const { runtime, router, child } = setup();
    const scope = scopeFor("campaign", "root", child);
    const ports = createNativeBusThreadToolPorts({ router, resolve_scope: ({ session_id }) => session_id.startsWith("worker-") ? scope : null });

    const statusEvents = await workerRoundTrip("sibling.status", ports, {});
    expect(statusEvents.find((event) => event.kind === "tool_result")).toMatchObject({ payload: { success: true, evidence: { action_scope: { status: "not_required" } } } });

    const beforeSend = runtime.manager.getParentChildThread("campaign", "root", child);
    const sendEvents = await workerRoundTrip("bus.thread.send", ports, {
      expected_thread_version: beforeSend.version, message_kind: "report", content: "worker round trip", ack_required: false,
    });
    expect(sendEvents.find((event) => event.kind === "tool_result")).toMatchObject({ payload: { success: true, evidence: { action_scope: { status: "bound", provenance_tag: "claimed", scope_id_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) } } } });

    const pending = runtime.manager.recordParentChildThreadMessage({
      campaign_id: "campaign", node_id: "root", parent_node_id: "root", child_node_id: child,
      expected_thread_version: runtime.manager.getParentChildThread("campaign", "root", child).version,
      author_node_id: "root", recipient_node_id: child, other_recipient_node_ids: [], kind: "delegate",
      payload: { content: "ack this", provenance: { tag: "claimed", claimant: "parent" } }, capability_tier: "orchestrator",
      trigger_turn: true, as_of: new Date().toISOString(), correlation_id: "worker-ack", idempotency_key: "worker-ack-idempotency",
      acknowledges_communication_id: null, retracts_communication_id: null, parent_communication_id: null, intent: "request",
      reply_to_communication_id: null, ack_required: true, deadline_at: null,
    });
    const ackEvents = await workerRoundTrip("bus.thread.ack", ports, {
      expected_thread_version: runtime.manager.getParentChildThread("campaign", "root", child).version, message_id: pending.message_id,
    });
    expect(ackEvents.find((event) => event.kind === "tool_result")).toMatchObject({ payload: { success: true, evidence: { action_scope: { status: "bound", provenance_tag: "claimed", scope_id_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) } } } });
  });
});
