import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import type { Action } from "@arbor/core";
import { ArborRuntime } from "../src/runtime.js"; import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { RemoteRuntimeIngress } from "../src/remote-ingress.js"; import { RemoteSessionAuthority, createRemoteSessionIdentity } from "../src/remote-session.js";
import { RemoteOperationTokenAuthority } from "../src/remote/ephemeral-token.js"; import { RemoteResultReconciler } from "../src/remote/remote-reconcile.js";
import { AuthenticatedRemoteHttpHost } from "../src/remote/http-listener.js";

const dirs: string[] = []; afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const root: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
function temp() { const value = mkdtempSync(join(tmpdir(), "arbor-remote-http-")); dirs.push(value); return value; }
function setup() {
  const dir = temp(); const now = () => new Date("2026-08-12T00:00:00.000Z"); const sessionAuthority = new RemoteSessionAuthority({ persistence_dir: dir, now });
  const runtime = new ArborRuntime({ persistence_dir: dir, remote_session_authority: sessionAuthority }); runtime.manager.startCampaign("campaign", "plan", root);
  const [child] = runtime.manager.branch("campaign", "root", [{ ...root, description: "child", delegate_to: "seed" }]);
  const identity = createRemoteSessionIdentity({ session_id: "worker-1", actor_id: "remote:worker", expires_at: "2026-08-13T00:00:00.000Z", thread_audiences: [{ campaign_id: "campaign", parent_node_id: "root", child_node_id: child!, author_node_id: "root" }] }); sessionAuthority.register(identity.registration);
  const tokens = new RemoteOperationTokenAuthority({ persistence_dir: dir, now });
  const reconciler = new RemoteResultReconciler({ verify: async (claim) => claim.output === "locally checked" ? { provenance: { tag: "verified", cmd: "local verifier", exit: 0, stdout_hash: "sha256:local" }, reason: "matched local check" } : { provenance: null, reason: "did not match local check" } });
  const host = new AuthenticatedRemoteHttpHost(new RemoteRuntimeIngress(new RuntimeCatalogRouter(runtime), sessionAuthority), tokens, reconciler, { enabled: true, host: "127.0.0.1", port: 0 });
  return { runtime, identity, tokens, host, child: child! };
}
function envelope(input: ReturnType<typeof setup>, operation: string) { const metadata = { operation_id: operation, idempotency_key: `${operation}:key`, correlation_id: "c", actor_id: "remote:worker", requested_at: "2026-08-12T00:00:00.000Z" }; return input.identity.signTransport({ metadata, command: { kind: "bus.thread.send", params: { campaign_id: "campaign", parent_node_id: "root", child_node_id: input.child, from_node_id: "root", expected_thread_version: input.runtime.manager.getParentChildThread("campaign", "root", input.child).version, message_kind: "delegate", content: "remote work", provenance: { tag: "claimed", claimant: "remote" }, capability_tier: "specialist" } }, issued_at: "2026-08-12T00:00:00.000Z", nonce: `nonce-${operation}-012345678901` }); }
async function post(port: number, path: string, token: string, body: unknown) { return fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }); }

describe("authenticated remote HTTP host", () => {
  it("requires explicit opt-in and TLS for every non-loopback bind", () => {
    const input = setup(); const ingress = new RemoteRuntimeIngress(new RuntimeCatalogRouter(input.runtime), new RemoteSessionAuthority());
    expect(() => new AuthenticatedRemoteHttpHost(ingress, input.tokens, new RemoteResultReconciler({ verify: async () => ({ provenance: null, reason: "test stub" }) }), { enabled: true, host: "192.0.2.10", port: 8443 })).toThrow("requires TLS");
    expect(() => new AuthenticatedRemoteHttpHost(ingress, input.tokens, new RemoteResultReconciler({ verify: async () => ({ provenance: null, reason: "test stub" }) }), { enabled: true, host: "0.0.0.0", port: 8443, tls: { key: "x", cert: "x" } })).toThrow("allow_wildcard_bind");
  });
  it("is opt-in, rejects over-scoped/reused grants, and drives a signed session command", async () => {
    const input = setup(); const address = await input.host.start();
    try {
      const issued = input.tokens.issue({ session_id: "worker-1", campaign_id: "campaign", operation_id: "send-1", capabilities: ["command.dispatch"], sensitive: false });
      const wrong = await post(address.port, "/v1/sessions/worker-1/commands", issued.token, envelope(input, "wrong")); expect(wrong.status).toBe(403);
      const fresh = input.tokens.issue({ session_id: "worker-1", campaign_id: "campaign", operation_id: "send-1", capabilities: ["command.dispatch"], sensitive: false });
      const accepted = await post(address.port, "/v1/sessions/worker-1/commands", fresh.token, envelope(input, "send-1")); expect(accepted.status).toBe(200);
      expect(input.runtime.manager.getParentChildThread("campaign", "root", input.child).messages).toHaveLength(1);
      expect((await post(address.port, "/v1/sessions/worker-1/commands", fresh.token, envelope(input, "send-1"))).status).toBe(403);
    } finally { await input.host.stop(); }
    const disabled = setup(); await expect(new AuthenticatedRemoteHttpHost(new RemoteRuntimeIngress(new RuntimeCatalogRouter(disabled.runtime), new RemoteSessionAuthority()), disabled.tokens, new RemoteResultReconciler({ verify: async () => ({ provenance: null, reason: "test stub" }) }), { host: "127.0.0.1", port: 0 }).start()).rejects.toThrow("explicit opt-in");
  });
  it("persists consent_required and strips a remote verified claim until local verification", async () => {
    const input = setup(); const address = await input.host.start();
    try {
      const grant = input.tokens.issue({ session_id: "worker-1", campaign_id: "campaign", operation_id: "result-1", capabilities: ["result.submit"], sensitive: true });
      const claim = { campaign_id: "campaign", node_id: input.child, operation_id: "result-1", output: "unchecked", provenance: { tag: "verified", cmd: "remote", exit: 0, stdout_hash: "sha256:remote" } };
      expect((await post(address.port, "/v1/sessions/worker-1/results", grant.token, claim)).status).toBe(409);
      expect(input.tokens.inspect(grant.grant.grant_id).state).toBe("consent_required"); input.tokens.consent(grant.grant.grant_id);
      const result = await (await post(address.port, "/v1/sessions/worker-1/results", grant.token, claim)).json() as any; expect(result.value).toMatchObject({ locally_verified: false, provenance: { tag: "claimed", claimant: "worker-1" }, confinement_grade: "remote_unattested" });
      const verifiedGrant = input.tokens.issue({ session_id: "worker-1", campaign_id: "campaign", operation_id: "result-2", capabilities: ["result.submit"], sensitive: false });
      const verified = await (await post(address.port, "/v1/sessions/worker-1/results", verifiedGrant.token, { ...claim, operation_id: "result-2", output: "locally checked" })).json() as any; expect(verified.value).toMatchObject({ locally_verified: true, provenance: { tag: "verified", cmd: "local verifier" } });
    } finally { await input.host.stop(); }
  });
  // ADR-041 §2: the byte boundary must reject duplicate members and non-I-JSON
  // numbers BEFORE signature verification. JSON.parse silently accepts both
  // (last-wins / Infinity), which is why the host must parse with parseIJson.
  it("rejects a duplicate JSON member and a non-I-JSON number at the byte boundary", async () => {
    const input = setup(); const address = await input.host.start();
    try {
      const issued = input.tokens.issue({ session_id: "worker-1", campaign_id: "campaign", operation_id: "send-1", capabilities: ["command.dispatch"], sensitive: false });
      const raw = async (body: string) => fetch(`http://127.0.0.1:${address.port}/v1/sessions/worker-1/commands`, { method: "POST", headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" }, body });
      const signed = envelope(input, "send-1");
      // A conforming peer signs one representation; JSON.parse would collapse
      // this to the second `metadata` and verify a body nobody signed.
      const duplicated = `{${JSON.stringify(signed).slice(1, -1)},"metadata":{"operation_id":"send-1"}}`;
      const dup = await raw(duplicated);
      expect(dup.status).toBe(400);
      expect(await dup.json()).toMatchObject({ code: "malformed_envelope", category: "input", retryable: false });
      expect(JSON.parse(duplicated)).toBeTruthy(); // JSON.parse accepts it — the listener must not.

      const nonFinite = await raw('{"metadata":{"operation_id":"a","x":1e400},"command":{"params":{"campaign_id":"campaign"}}}');
      expect(nonFinite.status).toBe(400);
      expect(await nonFinite.json()).toMatchObject({ code: "malformed_envelope", retryable: false });
    } finally { await input.host.stop(); }
  });
  it("does not consume an operation grant for a command that fails signature authentication", async () => {
    const input = setup(); const address = await input.host.start();
    try {
      const issued = input.tokens.issue({ session_id: "worker-1", campaign_id: "campaign", operation_id: "send-1", capabilities: ["command.dispatch"], sensitive: false });
      const invalid = envelope(input, "send-1") as any; invalid.proof.signature = invalid.proof.signature.replace(/^./, invalid.proof.signature[0] === "A" ? "B" : "A");
      expect((await post(address.port, "/v1/sessions/worker-1/commands", issued.token, invalid)).status).toBe(403);
      expect((await post(address.port, "/v1/sessions/worker-1/commands", issued.token, envelope(input, "send-1"))).status).toBe(200);
    } finally { await input.host.stop(); }
  });
});
