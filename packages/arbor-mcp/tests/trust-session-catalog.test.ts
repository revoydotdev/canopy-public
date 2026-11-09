import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { createRemoteSessionIdentity } from "../src/remote-session.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function root(): string { const value = mkdtempSync(join(tmpdir(), "arbor-trust-catalog-")); roots.push(value); return value; }
function metadata(id: string) {
  return { operation_id: id, idempotency_key: `idem-${id}`, actor_id: "local:trust-operator", correlation_id: `corr-${id}`, requested_at: "2026-08-08T00:00:00.000Z" };
}
function query(kind: "trust.session.list" | "trust.session.status", extra: Record<string, unknown> = {}) {
  return { schema_version: 1 as const, query_id: `query-${kind}`, query: { kind, ...extra } };
}

describe("trust session catalog controls", () => {
  it("enrols bounded direct-edge authority, rotates/revokes it, and keeps public keys out of operator projections", async () => {
    const persistence = root();
    const runtime = new ArborRuntime({ persistence_dir: persistence });
    const router = new RuntimeCatalogRouter(runtime);
    const identity = createRemoteSessionIdentity({
      session_id: "remote-session-1", actor_id: "remote:parent", expires_at: "2099-01-01T00:00:00.000Z",
      thread_audiences: [{ campaign_id: "campaign-1", parent_node_id: "parent", child_node_id: "child", author_node_id: "parent" }],
    });

    await expect(router.dispatchCommand({ schema_version: 1 as const, metadata: metadata("enroll"), command: { kind: "trust.session.enroll" as const, registration: identity.registration } })).resolves.toMatchObject({ ok: true, value: { accepted: true, operation_id: "enroll" } });
    const listed = router.executeQuery(query("trust.session.list"));
    expect(listed).toMatchObject({ ok: true, value: { total: 1, sessions: [{ session_id: "remote-session-1", state: "active", actor_id: "remote:parent", approval_authority: false }] } });
    expect(JSON.stringify(listed)).not.toContain(identity.registration.public_key_pem);

    const next = createRemoteSessionIdentity({
      session_id: identity.registration.session_id, actor_id: identity.registration.actor_id, expires_at: identity.registration.expires_at,
      thread_audiences: identity.registration.thread_audiences,
    });
    await expect(router.dispatchCommand({ schema_version: 1 as const, metadata: metadata("rotate"), command: {
      kind: "trust.session.rotate" as const, session_id: identity.registration.session_id, key_id: next.registration.key_id,
      public_key_pem: next.registration.public_key_pem, certificate_id: next.registration.certificate_id,
    } })).resolves.toMatchObject({ ok: true, value: { accepted: true, operation_id: "rotate" } });
    expect(router.executeQuery(query("trust.session.status", { session_id: identity.registration.session_id }))).toMatchObject({
      ok: true, value: { key_id: next.registration.key_id, revoked_key_ids: [identity.registration.key_id], state: "active" },
    });

    await expect(router.dispatchCommand({ schema_version: 1 as const, metadata: metadata("revoke"), command: { kind: "trust.session.revoke" as const, session_id: identity.registration.session_id } })).resolves.toMatchObject({ ok: true, value: { accepted: true, operation_id: "revoke" } });
    expect(router.executeQuery(query("trust.session.status", { session_id: identity.registration.session_id }))).toMatchObject({ ok: true, value: { state: "revoked", revoked_at: expect.any(String) } });
    expect(runtime.operations.get("revoke")).toMatchObject({ actor_id: "local:trust-operator", capability: "trust.session.write", state: "completed", result_summary: "remote session remote-session-1 revoked" });
  });

  it("persists rotation and terminal lifecycle audit across restart, while revocation denies old and replacement proofs", async () => {
    const persistence = root();
    const first = new ArborRuntime({ persistence_dir: persistence });
    const router = new RuntimeCatalogRouter(first);
    const identity = createRemoteSessionIdentity({
      session_id: "remote-session-2", actor_id: "remote:child", expires_at: "2099-01-01T00:00:00.000Z",
      thread_audiences: [{ campaign_id: "campaign-2", parent_node_id: "parent", child_node_id: "child", author_node_id: "child" }],
    });
    await expect(router.dispatchCommand({ schema_version: 1 as const, metadata: metadata("persist-enroll"), command: { kind: "trust.session.enroll" as const, registration: identity.registration } })).resolves.toMatchObject({ ok: true, value: { accepted: true } });
    const replacement = createRemoteSessionIdentity({ session_id: identity.registration.session_id, actor_id: identity.registration.actor_id, expires_at: identity.registration.expires_at, thread_audiences: identity.registration.thread_audiences });
    await expect(router.dispatchCommand({ schema_version: 1 as const, metadata: metadata("persist-rotate"), command: { kind: "trust.session.rotate" as const, session_id: identity.registration.session_id, key_id: replacement.registration.key_id, public_key_pem: replacement.registration.public_key_pem, certificate_id: replacement.registration.certificate_id } })).resolves.toMatchObject({ ok: true, value: { accepted: true } });

    const restarted = new ArborRuntime({ persistence_dir: persistence });
    const restartedRouter = new RuntimeCatalogRouter(restarted);
    expect(restartedRouter.executeQuery(query("trust.session.status", { session_id: identity.registration.session_id }))).toMatchObject({ ok: true, value: { key_id: replacement.registration.key_id, revoked_key_ids: [identity.registration.key_id] } });
    expect(restarted.operations.get("persist-rotate")).toMatchObject({ state: "completed", actor_id: "local:trust-operator", result_summary: `remote session ${identity.registration.session_id} key rotated to ${replacement.registration.key_id}` });

    const oldProof = identity.sign({ kind: "bus.thread.send", metadata: {}, params: {}, nonce: "old-key", issued_at: new Date().toISOString() });
    expect(restarted.remoteSessionAuthority.verifyThread(oldProof, { kind: "bus.thread.send", metadata: {}, params: {}, audience: identity.registration.thread_audiences[0]! })).toMatchObject({ ok: false, error: expect.stringContaining("identity, certificate or key") });
    await expect(restartedRouter.dispatchCommand({ schema_version: 1 as const, metadata: metadata("persist-revoke"), command: { kind: "trust.session.revoke" as const, session_id: identity.registration.session_id } })).resolves.toMatchObject({ ok: true, value: { accepted: true } });
    const replacementProof = replacement.sign({ kind: "bus.thread.send", metadata: {}, params: {}, nonce: "replacement-key", issued_at: new Date().toISOString() });
    expect(restarted.remoteSessionAuthority.verifyThread(replacementProof, { kind: "bus.thread.send", metadata: {}, params: {}, audience: identity.registration.thread_audiences[0]! })).toMatchObject({ ok: false, error: "remote session is not active" });
  });

  it("rejects ambient edge-less enrollment and unauthorized trust capabilities", async () => {
    const identity = createRemoteSessionIdentity({ session_id: "ambient", actor_id: "remote:ambient", expires_at: "2099-01-01T00:00:00.000Z", thread_audiences: [] });
    const runtime = new ArborRuntime({ persistence_dir: root() });
    await expect(new RuntimeCatalogRouter(runtime).dispatchCommand({ schema_version: 1 as const, metadata: metadata("ambient"), command: { kind: "trust.session.enroll" as const, registration: identity.registration } })).resolves.toMatchObject({ ok: false, error: { code: "validation" } });
    const restricted = new RuntimeCatalogRouter(runtime, { granted_capabilities: new Set(["trust.session.read"]) });
    await expect(restricted.dispatchCommand({ schema_version: 1 as const, metadata: metadata("denied"), command: { kind: "trust.session.enroll" as const, registration: { ...identity.registration, approval_authority: true } } })).resolves.toMatchObject({ ok: false, error: { code: "permission" } });
    expect(new RuntimeCatalogRouter(runtime, { granted_capabilities: new Set(["trust.session.write"]) }).executeQuery(query("trust.session.list"))).toMatchObject({ ok: false, error: { code: "permission" } });
  });
});
