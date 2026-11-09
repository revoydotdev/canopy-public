import { describe, expect, it } from "vitest";
import type { Action, NodeCard } from "@arbor/core";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { RemoteRuntimeIngress } from "../src/remote-ingress.js";
import { RemoteSessionAuthority, createRemoteSessionIdentity } from "../src/remote-session.js";
import { A2A_DIRECT_THREAD_A2A_VERSION, A2A_DIRECT_THREAD_PROFILE_ID, createA2ADirectThreadProfileAdapter, type A2ADirectThreadAckInput, type A2ADirectThreadSendInput, type A2ADirectThreadTask } from "../src/a2a-direct-thread-profile.js";

const root: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
const now = () => new Date("2026-08-08T00:00:00.000Z");

function setup() {
  const runtime = new ArborRuntime();
  runtime.manager.startCampaign("campaign", "plan.md", root);
  const [child] = runtime.manager.branch("campaign", "root", [{ ...root, description: "child", delegate_to: "seed" }]);
  if (!child) throw new Error("missing child");
  const authority = new RemoteSessionAuthority({ now });
  const router = new RuntimeCatalogRouter(runtime);
  return { runtime, child, authority, adapter: createA2ADirectThreadProfileAdapter(new RemoteRuntimeIngress(router, authority)) };
}

function card(): NodeCard {
  return { node_id: "root", role: "orchestrator", skills: ["delegate"], tier: "orchestrator", modes: new Set(["streaming"]), inputs: [], outputs: [], source: "node", signature: "node-card-signature" };
}

describe("A2A direct-thread profile", () => {
  it("is explicitly unavailable without the typed ingress adapter and never claims a public endpoint", () => {
    const absent = createA2ADirectThreadProfileAdapter();
    expect(absent.agentCard(card(), { signing_secret: "test", default_recipient_tier: "specialist" })).toEqual({ ok: false, code: "unavailable", detail: expect.stringContaining("no public transport") });
  });

  it("declares A2A version plus host-composed Ed25519/direct-edge authentication on a configured card", () => {
    const { adapter } = setup();
    expect(adapter.agentCard(card(), { signing_secret: "test", default_recipient_tier: "specialist" })).toMatchObject({
      ok: true,
      value: {
        profile_id: A2A_DIRECT_THREAD_PROFILE_ID,
        a2a_version: A2A_DIRECT_THREAD_A2A_VERSION,
        transport: "host_composed_no_listener",
        authentication: { scheme: "arbor.remote-session.ed25519", per_operation_proof: true, direct_edge_authorization: true },
        card: { name: "root" },
      },
    });
  });

  it("maps one signed A2A task message to a durable direct thread, converges duplicate delivery, and permits a signed direct ack", async () => {
    const { runtime, child, authority, adapter } = setup();
    const identity = createRemoteSessionIdentity({
      session_id: "a2a-parent", actor_id: "remote:parent", expires_at: "2026-08-09T00:00:00.000Z",
      thread_audiences: [{ campaign_id: "campaign", parent_node_id: "root", child_node_id: child, author_node_id: "root" }],
    });
    authority.register(identity.registration);
    const task: A2ADirectThreadTask = { task_id: "a2a-task-1", campaign_id: "campaign", parent_node_id: "root", child_node_id: child };
    const send: A2ADirectThreadSendInput = {
      profile_id: A2A_DIRECT_THREAD_PROFILE_ID,
      a2a_version: A2A_DIRECT_THREAD_A2A_VERSION,
      task,
      actor_id: identity.registration.actor_id,
      from_node_id: "root",
      expected_thread_version: runtime.manager.getParentChildThread("campaign", "root", child).version,
      message_kind: "delegate" as const,
      ack_required: true,
      wire: {
        messageId: "a2a-message-1", taskId: task.task_id, contextId: task.task_id, role: "ROLE_AGENT" as const,
        parts: [{ text: "perform the bounded task" }],
        metadata: { "arbor.dev/author-node-ref": "root", "arbor.dev/recipient-node-refs": [child] },
      },
    };
    const prepared = adapter.prepareSend(send);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.detail);
    const firstProof = identity.sign({ ...prepared.value.signing, nonce: "first", issued_at: "2026-08-08T00:00:00.000Z" });
    await expect(adapter.deliverSend(send, firstProof)).resolves.toMatchObject({ ok: true, value: { accepted: true, delivery: "durable" } });
    // A redelivery uses a new integrity nonce but the same task/message ids;
    // its deterministic operation/idempotency identity must converge rather
    // than append a second ledger message.
    const duplicateProof = identity.sign({ ...prepared.value.signing, nonce: "duplicate", issued_at: "2026-08-08T00:00:00.000Z" });
    await expect(adapter.deliverSend(send, duplicateProof)).resolves.toMatchObject({ ok: true, value: { accepted: true } });
    const history = runtime.manager.getParentChildThread("campaign", "root", child);
    expect(history.messages).toHaveLength(1);
    const message = history.messages[0]!;

    const childIdentity = createRemoteSessionIdentity({
      session_id: "a2a-child", actor_id: "remote:child", expires_at: "2026-08-09T00:00:00.000Z",
      thread_audiences: [{ campaign_id: "campaign", parent_node_id: "root", child_node_id: child, author_node_id: child }],
    });
    authority.register(childIdentity.registration);
    const ack: A2ADirectThreadAckInput = { profile_id: A2A_DIRECT_THREAD_PROFILE_ID, a2a_version: A2A_DIRECT_THREAD_A2A_VERSION, task, actor_id: childIdentity.registration.actor_id, from_node_id: child, expected_thread_version: history.version, message_id: message.id };
    const preparedAck = adapter.prepareAck(ack);
    expect(preparedAck.ok).toBe(true);
    if (!preparedAck.ok) throw new Error(preparedAck.detail);
    const ackProof = childIdentity.sign({ ...preparedAck.value.signing, nonce: "ack", issued_at: "2026-08-08T00:00:00.000Z" });
    await expect(adapter.deliverAck(ack, ackProof)).resolves.toMatchObject({ ok: true, value: { accepted: true } });
    expect(runtime.manager.getParentChildThread("campaign", "root", child).messages[0]).toMatchObject({ delivery: "acknowledged" });
  });

  it("rejects cross-edge declarations before dispatch and authenticated sessions outside that edge at ingress", async () => {
    const { runtime, child, authority, adapter } = setup();
    const identity = createRemoteSessionIdentity({
      session_id: "a2a-isolated", actor_id: "remote:isolated", expires_at: "2026-08-09T00:00:00.000Z",
      thread_audiences: [{ campaign_id: "campaign", parent_node_id: "root", child_node_id: child, author_node_id: "root" }],
    });
    authority.register(identity.registration);
    const task: A2ADirectThreadTask = { task_id: "task-isolated", campaign_id: "campaign", parent_node_id: "root", child_node_id: child };
    const shared: Omit<A2ADirectThreadSendInput, "wire"> = { profile_id: A2A_DIRECT_THREAD_PROFILE_ID, a2a_version: A2A_DIRECT_THREAD_A2A_VERSION, task, actor_id: identity.registration.actor_id, from_node_id: "root", expected_thread_version: runtime.manager.getParentChildThread("campaign", "root", child).version, message_kind: "delegate" };
    expect(adapter.prepareSend({ ...shared, wire: { messageId: "bad-recipient", taskId: task.task_id, role: "ROLE_AGENT", parts: [{ text: "x" }], metadata: { "arbor.dev/recipient-node-refs": ["not-child"] } } })).toMatchObject({ ok: false, code: "scope_isolation" });
    const wrongEndpoint = { ...shared, from_node_id: child, wire: { messageId: "wrong-edge", taskId: task.task_id, role: "ROLE_AGENT" as const, parts: [{ text: "x" }] } };
    const prepared = adapter.prepareSend(wrongEndpoint);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.detail);
    const proof = identity.sign({ ...prepared.value.signing, nonce: "wrong-edge", issued_at: "2026-08-08T00:00:00.000Z" });
    await expect(adapter.deliverSend(wrongEndpoint, proof)).resolves.toMatchObject({ ok: false, code: "dispatch_refused", detail: "remote session is not authorized for this direct parent-child edge" });
  });
});
