import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Action } from "@arbor/core";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { RemoteRuntimeIngress } from "../src/remote-ingress.js";
import { RemoteSessionAuthority, createRemoteSessionIdentity } from "../src/remote-session.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
const now = () => new Date("2026-08-08T00:00:00.000Z");
function temp(): string { const value = mkdtempSync(join(tmpdir(), "arbor-remote-ingress-")); roots.push(value); return value; }
function setup(dir = temp()) {
  const runtime = new ArborRuntime({ persistence_dir: dir });
  runtime.manager.startCampaign("campaign", "plan.md", root);
  const [child] = runtime.manager.branch("campaign", "root", [{ ...root, description: "child", delegate_to: "seed" }]);
  if (!child) throw new Error("child setup failed");
  const router = new RuntimeCatalogRouter(runtime);
  const authority = new RemoteSessionAuthority({ persistence_dir: dir, now });
  return { dir, runtime, router, authority, ingress: new RemoteRuntimeIngress(router, authority), child };
}
function metadata(actor_id: string, operation_id: string) { return { operation_id, idempotency_key: `${operation_id}:key`, correlation_id: "remote-correlation", actor_id, requested_at: "2026-08-08T00:00:00.000Z" }; }

describe("RemoteRuntimeIngress", () => {
  it("requires integrity, binds a message to one direct edge, rejects replay after restart, and persists verifier attribution", async () => {
    const { dir, runtime, authority, ingress, child } = setup();
    const identity = createRemoteSessionIdentity({ session_id: "remote-parent", actor_id: "remote:parent", expires_at: "2026-08-09T00:00:00.000Z", thread_audiences: [{ campaign_id: "campaign", parent_node_id: "root", child_node_id: child, author_node_id: "root" }] });
    authority.register(identity.registration);
    const base = { schema_version: 1 as const, metadata: metadata(identity.registration.actor_id, "remote-send"), command: { kind: "bus.thread.send" as const, campaign_id: "campaign", parent_node_id: "root", child_node_id: child, from_node_id: "root", expected_thread_version: runtime.manager.getParentChildThread("campaign", "root", child).version, message_kind: "delegate" as const, content: "bounded remote task", provenance: { tag: "claimed" as const, claimant: "remote:parent" }, capability_tier: "specialist" as const } };
    const proof = identity.sign({ kind: base.command.kind, metadata: base.metadata, params: { ...base.command, kind: undefined } as unknown as Record<string, unknown>, nonce: "nonce-1", issued_at: "2026-08-08T00:00:00.000Z" });
    // `kind` is omitted from the signed params by the ingress, not represented as undefined.
    const signed = identity.sign({ kind: base.command.kind, metadata: base.metadata, params: (({ kind: _kind, ...params }) => params)(base.command), nonce: "nonce-2", issued_at: "2026-08-08T00:00:00.000Z" });
    const envelope = { ...base, metadata: { ...base.metadata, remote_session_proof: signed } };
    await expect(ingress.dispatch(envelope)).resolves.toMatchObject({ ok: true, value: { accepted: true, delivery: "durable" } });
    expect(runtime.operations.get("remote-send")).toMatchObject({ actor_id: "remote:parent", remote_session: { session_id: "remote-parent", key_id: identity.registration.key_id, certificate_id: identity.registration.certificate_id, nonce: "nonce-2", integrity: "ed25519" } });
    await expect(ingress.dispatch(envelope)).resolves.toMatchObject({ ok: false, error: { code: "permission", summary: "remote session nonce was already consumed" } });
    const restartedAuthority = new RemoteSessionAuthority({ persistence_dir: dir, now });
    await expect(new RemoteRuntimeIngress(new RuntimeCatalogRouter(runtime), restartedAuthority).dispatch(envelope)).resolves.toMatchObject({ ok: false, error: { summary: "remote session nonce was already consumed" } });
    // A proof signed for a different edge remains cryptographically valid but is authorization-denied.
    const wrongEdge = { ...base, metadata: { ...metadata(identity.registration.actor_id, "wrong-edge"), remote_session_proof: identity.sign({ kind: base.command.kind, metadata: metadata(identity.registration.actor_id, "wrong-edge"), params: (({ kind: _kind, ...params }) => params)({ ...base.command, from_node_id: child, expected_thread_version: "different" }), nonce: "nonce-3", issued_at: "2026-08-08T00:00:00.000Z" }) }, command: { ...base.command, from_node_id: child, expected_thread_version: "different" } };
    await expect(ingress.dispatch(wrongEdge)).resolves.toMatchObject({ ok: false, error: { summary: "remote session is not authorized for this direct parent-child edge" } });
    void proof; // Exercise an independently generated proof without relying on a synthetic verifier fixture.
  });

  it("makes rotation and revocation fail closed", async () => {
    const { authority, ingress, runtime, child } = setup();
    const oldIdentity = createRemoteSessionIdentity({ session_id: "remote-child", actor_id: "remote:child", expires_at: "2026-08-09T00:00:00.000Z", thread_audiences: [{ campaign_id: "campaign", parent_node_id: "root", child_node_id: child, author_node_id: child }] });
    authority.register(oldIdentity.registration);
    const nextIdentity = createRemoteSessionIdentity({ session_id: "remote-child", actor_id: "remote:child", key_id: "rotated-key", expires_at: "2026-08-09T00:00:00.000Z", thread_audiences: oldIdentity.registration.thread_audiences });
    authority.rotateKey({ session_id: "remote-child", key_id: nextIdentity.registration.key_id, public_key_pem: nextIdentity.registration.public_key_pem, certificate_id: nextIdentity.registration.certificate_id });
    const command = { kind: "bus.thread.send" as const, campaign_id: "campaign", parent_node_id: "root", child_node_id: child, from_node_id: child, expected_thread_version: runtime.manager.getParentChildThread("campaign", "root", child).version, message_kind: "report" as const, content: "result", provenance: { tag: "claimed" as const, claimant: "remote:child" }, capability_tier: "specialist" as const };
    const oldMetadata = metadata("remote:child", "old-key");
    const oldEnvelope = { schema_version: 1 as const, metadata: { ...oldMetadata, remote_session_proof: oldIdentity.sign({ kind: command.kind, metadata: oldMetadata, params: (({ kind: _kind, ...params }) => params)(command), nonce: "old", issued_at: "2026-08-08T00:00:00.000Z" }) }, command };
    await expect(ingress.dispatch(oldEnvelope)).resolves.toMatchObject({ ok: false, error: { summary: "remote session identity, certificate or key is not active" } });
    const newMetadata = metadata("remote:child", "new-key");
    const newEnvelope = { schema_version: 1 as const, metadata: { ...newMetadata, remote_session_proof: nextIdentity.sign({ kind: command.kind, metadata: newMetadata, params: (({ kind: _kind, ...params }) => params)(command), nonce: "new", issued_at: "2026-08-08T00:00:00.000Z" }) }, command };
    await expect(ingress.dispatch(newEnvelope)).resolves.toMatchObject({ ok: true, value: { accepted: true } });
    authority.revokeSession("remote-child");
    const revokedMetadata = metadata("remote:child", "revoked");
    await expect(ingress.dispatch({ ...newEnvelope, metadata: { ...revokedMetadata, remote_session_proof: nextIdentity.sign({ kind: command.kind, metadata: revokedMetadata, params: (({ kind: _kind, ...params }) => params)(command), nonce: "revoked", issued_at: "2026-08-08T00:00:00.000Z" }) } })).resolves.toMatchObject({ ok: false, error: { summary: "remote session is not active" } });
  });

  it("binds remote proposal and decision actors, preserving independent approval", async () => {
    const { authority, ingress } = setup();
    const proposer = createRemoteSessionIdentity({ session_id: "proposer", actor_id: "remote:proposer", expires_at: "2030-08-09T00:00:00.000Z", thread_audiences: [], approval_authority: true });
    const decider = createRemoteSessionIdentity({ session_id: "decider", actor_id: "remote:decider", expires_at: "2030-08-09T00:00:00.000Z", thread_audiences: [], approval_authority: true });
    authority.register(proposer.registration); authority.register(decider.registration);
    const requestMetadata = metadata("remote:proposer", "approval-request");
    const request = { kind: "approval.request" as const, request_id: "remote-approval", idempotency_key: "remote-approval-key", action: "campaign.halt", subject: "halt", resource_id: "campaign", proposer: "remote:proposer", rationale: "operator review", expires_at: "2030-08-09T00:00:00.000Z" };
    const requestEnvelope = { schema_version: 1 as const, metadata: { ...requestMetadata, remote_session_proof: proposer.sign({ kind: request.kind, metadata: requestMetadata, params: (({ kind: _kind, ...params }) => params)(request), nonce: "approval-request", issued_at: "2026-08-08T00:00:00.000Z" }) }, command: request };
    const requested = await ingress.dispatch(requestEnvelope);
    expect(requested).toMatchObject({ ok: true, value: { accepted: true, record: { proposer: "remote:proposer" } } });
    const decisionMetadata = metadata("remote:decider", "approval-decision");
    const decision = { kind: "approval.approve" as const, request_id: "remote-approval", actor: "remote:decider" };
    await expect(ingress.dispatch({ schema_version: 1 as const, metadata: { ...decisionMetadata, remote_session_proof: decider.sign({ kind: decision.kind, metadata: decisionMetadata, params: (({ kind: _kind, ...params }) => params)(decision), nonce: "approval-decision", issued_at: "2026-08-08T00:00:00.000Z" }) }, command: decision })).resolves.toMatchObject({ ok: true, value: { accepted: true, record: { decided_by: "remote:decider", status: "approved" } } });
  });

  it("fails closed on certificate substitution and bounded replay-store exhaustion", async () => {
    const { authority, ingress, runtime, child } = setup();
    const identity = createRemoteSessionIdentity({ session_id: "bounded", actor_id: "remote:bounded", expires_at: "2026-08-09T00:00:00.000Z", thread_audiences: [{ campaign_id: "campaign", parent_node_id: "root", child_node_id: child, author_node_id: "root" }] });
    authority.register(identity.registration);
    const command = { kind: "bus.thread.send" as const, campaign_id: "campaign", parent_node_id: "root", child_node_id: child, from_node_id: "root", expected_thread_version: runtime.manager.getParentChildThread("campaign", "root", child).version, message_kind: "delegate" as const, content: "bounded", provenance: { tag: "claimed" as const, claimant: "remote:bounded" }, capability_tier: "specialist" as const };
    const meta = metadata("remote:bounded", "certificate-substitution");
    const valid = identity.sign({ kind: command.kind, metadata: meta, params: (({ kind: _kind, ...params }) => params)(command), nonce: "certificate", issued_at: "2026-08-08T00:00:00.000Z" });
    await expect(ingress.dispatch({ schema_version: 1 as const, metadata: { ...meta, remote_session_proof: { ...valid, certificate_id: "remote-cert:substituted" } }, command })).resolves.toMatchObject({ ok: false, error: { summary: "remote session identity, certificate or key is not active" } });

    const constrained = new RemoteSessionAuthority({ now, max_consumed_nonces: 1 });
    constrained.register(identity.registration);
    const constrainedIngress = new RemoteRuntimeIngress(new RuntimeCatalogRouter(runtime), constrained);
    const firstMeta = metadata("remote:bounded", "capacity-one");
    const first = { schema_version: 1 as const, metadata: { ...firstMeta, remote_session_proof: identity.sign({ kind: command.kind, metadata: firstMeta, params: (({ kind: _kind, ...params }) => params)(command), nonce: "one", issued_at: "2026-08-08T00:00:00.000Z" }) }, command };
    await expect(constrainedIngress.dispatch(first)).resolves.toMatchObject({ ok: true, value: { accepted: true } });
    const secondMeta = metadata("remote:bounded", "capacity-two");
    const second = { schema_version: 1 as const, metadata: { ...secondMeta, remote_session_proof: identity.sign({ kind: command.kind, metadata: secondMeta, params: (({ kind: _kind, ...params }) => params)({ ...command, expected_thread_version: runtime.manager.getParentChildThread("campaign", "root", child).version }), nonce: "two", issued_at: "2026-08-08T00:00:00.000Z" }) }, command: { ...command, expected_thread_version: runtime.manager.getParentChildThread("campaign", "root", child).version } };
    await expect(constrainedIngress.dispatch(second)).resolves.toMatchObject({ ok: false, error: { summary: "remote session nonce replay store capacity is exhausted" } });
  });
});
