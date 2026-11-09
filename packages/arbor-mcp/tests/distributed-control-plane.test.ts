import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalResourceIdentity, DistributedControlClient, DistributedControlHttpHost, DistributedControlPlane, parseCanonicalResourceIdentity, signDistributedControlRequest } from "../src/distributed-control-plane.js";

const roots: string[] = [];
const secretA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", secretB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", secretC = "ccccccccccccccccccccccccccccccccccccccccccc";
const request = (id: string, extra: Record<string, unknown> = {}) => ({ request_id: id, ...extra });
const resource = canonicalResourceIdentity({ namespace: "repository", repository: "repo-a", kind: "result", key: "production-schema" });
const hash = (character: string) => `sha256:${character.repeat(64)}`;
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("distributed cross-host control plane", () => {
  it("routes authenticated TLS traffic between two processes rooted in different repositories", async () => {
    const root = mkdtempSync(join(tmpdir(), "revoy-cross-process-")); roots.push(root); const authority = join(root, "authority"), repoA = join(root, "repo-a"), repoB = join(root, "repo-b"), key = join(root, "key.pem"), cert = join(root, "cert.pem"); mkdirSync(repoA); mkdirSync(repoB);
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
    const plane = new DistributedControlPlane({ persistence_dir: authority, host_credentials: { host_a: secretA, host_b: secretB } }); const server = new DistributedControlHttpHost(plane, { enabled: true, host: "127.0.0.1", port: 0, tls: { key: readFileSync(key), cert: readFileSync(cert) } }); const address = await server.start(), base = `${address.protocol}//${address.host}:${address.port}`, moduleUrl = new URL("../src/distributed-control-plane.ts", import.meta.url).href, worker = join(root, "worker.ts");
    writeFileSync(worker, `import { DistributedControlClient } from ${JSON.stringify(moduleUrl)};\nconst [base,host,secret,mode]=process.argv.slice(2); const client=new DistributedControlClient({base_url:base,host_id:host,secret}); await client.request("POST","/v1/hosts/register",{request_id:"register:"+host,repo_id:host==="host_a"?"repo-a":"repo-b",session_id:host,endpoint:"https://"+host+".invalid",capabilities:["messages"],ttl_ms:60000}); if(mode==="send"){const result=await client.request("POST","/v1/messages",{request_id:"cross-send",recipient_host_id:"host_b",kind:"peer.query",payload:{question:"cross repo"},correlation_id:"cross"}); console.log(JSON.stringify(result));}else{for(let i=0;i<50;i++){const result=await client.request("POST","/v1/inbox/claim",{request_id:"claim:"+i,consumer_id:"process-b",after_sequence:0,limit:10,visibility_timeout_ms:1000}); if(result.ok&&result.value.messages.length){const message=result.value.messages[0]; await client.request("POST","/v1/messages/ack",{request_id:"ack",message_id:message.message_id,claim_id:message.claim_id}); console.log(JSON.stringify({ok:true,sender:message.sender_host_id,payload:message.payload})); process.exit(0);} await Bun.sleep(20);} process.exit(2);}\n`);
    const run = (cwd: string, args: string[]) => new Promise<string>((resolve, reject) => { const child = spawn("bun", [worker, base, ...args], { cwd, env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; }); child.once("error", reject); child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`worker ${code}: ${stderr}`))); });
    const [received, sent] = await Promise.all([run(repoB, ["host_b", secretB, "receive"]), run(repoA, ["host_a", secretA, "send"])]); expect(JSON.parse(sent)).toMatchObject({ ok: true }); expect(JSON.parse(received)).toEqual({ ok: true, sender: "host_a", payload: { question: "cross repo" } }); const health = plane.health("host_a"); expect(health.ok && health.value).toMatchObject({ messages: { acknowledged: 1 } }); await server.stop(); plane.close();
  }, 15_000);

  it("discovers live hosts and durably routes ordered offline messages across restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "revoy-control-")); roots.push(root); const credentials = { host_a: secretA, host_b: secretB };
    let plane = new DistributedControlPlane({ persistence_dir: root, host_credentials: credentials }); let server = new DistributedControlHttpHost(plane, { enabled: true, host: "127.0.0.1", port: 0 });
    let address = await server.start(); const a = new DistributedControlClient({ base_url: `${address.protocol}//${address.host}:${address.port}`, host_id: "host_a", secret: secretA });
    expect((await a.request("POST", "/v1/hosts/register", request("register-a", { repo_id: "repo-a", session_id: "session-a", endpoint: "https://a.invalid", capabilities: ["messages"], ttl_ms: 60_000 }))).ok).toBe(true);
    for (const id of ["one", "two"]) expect((await a.request("POST", "/v1/messages", request(`send-${id}`, { recipient_host_id: "host_b", kind: "peer.query", payload: { id }, correlation_id: id }))).ok).toBe(true);
    await server.stop(); plane.close(); plane = new DistributedControlPlane({ persistence_dir: root, host_credentials: credentials }); server = new DistributedControlHttpHost(plane, { enabled: true, host: "127.0.0.1", port: 0 }); address = await server.start();
    const b = new DistributedControlClient({ base_url: `${address.protocol}//${address.host}:${address.port}`, host_id: "host_b", secret: secretB }); const claimed = await b.request<{ messages: Array<{ message_id: string; sequence: number; claim_id: string }> }>("POST", "/v1/inbox/claim", request("claim", { consumer_id: "worker-b", after_sequence: 0, limit: 10, visibility_timeout_ms: 1_000 }));
    expect(claimed.ok && claimed.value.messages.map((message) => message.sequence)).toEqual([1, 2]); const first = claimed.ok ? claimed.value.messages[0]! : null; expect((await b.request("POST", "/v1/messages/ack", request("ack", { message_id: first?.message_id, claim_id: first?.claim_id }))).ok).toBe(true);
    const inbox = await b.request<{ messages: Array<{ sequence: number }> }>("GET", "/v1/inbox?after=1"); expect(inbox.ok && inbox.value.messages.map((message) => message.sequence)).toEqual([2]); await server.stop(); plane.close();
  });

  it("enforces server-side route, audience, resource, expiry, rotation and revocation grants", () => {
    const root = mkdtempSync(join(tmpdir(), "revoy-grants-")); roots.push(root); let time = Date.parse("2026-08-20T12:00:00.000Z");
    const plane = new DistributedControlPlane({ persistence_dir: root, now: () => new Date(time), host_grants: {
      admin: { secret: secretA, routes: ["grants.manage", "health.read"], expires_at: "2027-01-01T00:00:00.000Z" },
      worker: { secret: secretB, routes: ["messages.send", "leases.manage"], audiences: ["admin"], resource_prefixes: ["revoy-resource:v1:repository:repo-a:"], expires_at: "2026-08-20T13:00:00.000Z" },
      denied: { secret: secretC, routes: ["messages.receive"], expires_at: "2027-01-01T00:00:00.000Z" },
    } });
    expect(plane.send("worker", request("allowed", { recipient_host_id: "admin", kind: "x", payload: {} })).ok).toBe(true);
    expect(plane.send("worker", request("audience", { recipient_host_id: "denied", kind: "x", payload: {} }))).toMatchObject({ ok: false, error: "authorization_failed" });
    const outside = canonicalResourceIdentity({ namespace: "repository", repository: "repo-b", kind: "result", key: "x" }); expect(plane.acquire("worker", request("outside", { resource_id: outside, ttl_ms: 1_000 }))).toMatchObject({ ok: false, error: "authorization_failed" });
    expect(plane.rotateGrant("admin", request("rotate", { target_host_id: "worker", grant: { secret: secretC, routes: ["messages.send"], audiences: ["admin"], expires_at: "2027-01-01T00:00:00.000Z" } })).ok).toBe(true); expect(plane.credential("worker")).toBe(secretC);
    expect(plane.revokeGrant("admin", request("revoke", { target_host_id: "worker" })).ok).toBe(true); expect(plane.send("worker", request("revoked", { recipient_host_id: "admin", kind: "x", payload: {} }))).toMatchObject({ ok: false, error: "authentication_failed" });
    time = Date.parse("2028-01-01T00:00:00.000Z"); expect(plane.health("admin")).toMatchObject({ ok: false, error: "authentication_failed" }); plane.close();
  });

  it("prevents claim collisions, reclaims expired visibility, dead-letters bounded retries, and projects health", () => {
    const root = mkdtempSync(join(tmpdir(), "revoy-claims-")); roots.push(root); let time = Date.parse("2026-08-20T12:00:00.000Z"); const plane = new DistributedControlPlane({ persistence_dir: root, host_credentials: { host_a: secretA, host_b: secretB }, now: () => new Date(time), max_delivery_attempts: 2 });
    plane.send("host_a", request("send", { recipient_host_id: "host_b", kind: "x", payload: {} })); const first = plane.claim("host_b", request("claim-1", { consumer_id: "one", after_sequence: 0, limit: 10, visibility_timeout_ms: 1_000 })); expect(first.ok && first.value.messages).toHaveLength(1); expect(plane.claim("host_b", request("claim-2", { consumer_id: "two", after_sequence: 0, limit: 10, visibility_timeout_ms: 1_000 }))).toMatchObject({ ok: true, value: { messages: [] } });
    time += 1_001; const second = plane.claim("host_b", request("claim-3", { consumer_id: "two", after_sequence: 0, limit: 10, visibility_timeout_ms: 1_000 })); expect(second.ok && second.value.messages).toHaveLength(1); time += 1_001; expect(plane.claim("host_b", request("claim-4", { consumer_id: "three", after_sequence: 0, limit: 10, visibility_timeout_ms: 1_000 }))).toMatchObject({ ok: true, value: { messages: [] } });
    const health = plane.health("host_a"); expect(health.ok && health.value).toMatchObject({ messages: { dead_letter: 1 } }); plane.close();
  });

  it("uses alias-resistant typed resource identity and durable committed adoption recovery", () => {
    for (const candidate of ["revoy-resource:v1:repository:Repo-A:result:x", "revoy-resource:v1:repository:repo-a:result:../x", "revoy-resource:v1:repository:repo-a:result:a/b", "revoy-resource:v1:repository:repo-a:result:ｅ", "revoy-resource:v1:repository:repo-a:result:link->target"]) expect(() => parseCanonicalResourceIdentity(candidate)).toThrow();
    const root = mkdtempSync(join(tmpdir(), "revoy-adopt-")); roots.push(root); let time = Date.parse("2026-08-20T12:00:00.000Z"); const plane = new DistributedControlPlane({ persistence_dir: root, host_credentials: { host_a: secretA, host_b: secretB }, now: () => new Date(time) });
    const lease = plane.acquire("host_a", request("lease", { resource_id: resource, ttl_ms: 1_000 })); const fence = lease.ok ? lease.value.fencing_token : 0; const prepared = plane.prepareAdoption("host_a", request("prepare", { resource_id: resource, fencing_token: fence, artifact_hash: hash("a"), base_head: hash("b"), selection_digest: hash("c") })); expect(prepared.ok).toBe(true);
    const committed = plane.finishAdoption("host_a", request("commit", { transaction_id: prepared.ok ? prepared.value.transaction_id : "missing" }), "commit"); expect(committed.ok && committed.value.state).toBe("committed"); time += 1_001; expect(plane.acquire("host_b", request("takeover", { resource_id: resource, ttl_ms: 1_000 }))).toMatchObject({ ok: false, error: "conflict" });
    const finalized = plane.reconcileAdoption("host_a", request("recover", { transaction_id: prepared.ok ? prepared.value.transaction_id : "missing", resolution: "finalize", result_head: hash("d"), tree_digest: hash("e") })); expect(finalized.ok && finalized.value.state).toBe("finalized"); expect(plane.acquire("host_b", request("takeover-2", { resource_id: resource, ttl_ms: 1_000 })).ok).toBe(true); plane.close();
  });

  it("rejects replay, idempotency drift, insecure transport, malformed restore, and client exhaustion", async () => {
    const root = mkdtempSync(join(tmpdir(), "revoy-auth-")); roots.push(root); const now = new Date("2026-08-20T12:00:00.000Z"); const plane = new DistributedControlPlane({ persistence_dir: root, host_credentials: { host_a: secretA }, now: () => now }); expect(() => new DistributedControlPlane({ persistence_dir: root, host_credentials: { host_a: secretA } })).toThrow(/already owned/); expect(() => new DistributedControlHttpHost(plane, { enabled: true, host: "0.0.0.0", port: 0 })).toThrow(/wildcard/); expect(() => new DistributedControlClient({ base_url: "http://192.0.2.1:8080", host_id: "host_a", secret: secretA })).toThrow(/plaintext/);
    const authInput = { host_id: "host_a", method: "POST", path: "/v1/messages", timestamp: now.toISOString(), nonce: "nonce_0123456789abcdef", body: { safe: true } }, signature = signDistributedControlRequest(secretA, authInput); expect(plane.authenticate({ ...authInput, signature }).ok).toBe(true); expect(plane.authenticate({ ...authInput, signature })).toMatchObject({ ok: false, error: "replay" }); expect(plane.register("host_a", request("same", { repo_id: "repo", session_id: "a", endpoint: "https://a.invalid", capabilities: [], ttl_ms: 10_000 })).ok).toBe(true); expect(plane.register("host_a", request("same", { repo_id: "different", session_id: "a", endpoint: "https://a.invalid", capabilities: [], ttl_ms: 10_000 }))).toMatchObject({ ok: false, error: "conflict" }); plane.close();
    const statePath = join(root, "distributed-control-plane.json"), state = JSON.parse(readFileSync(statePath, "utf8")); state.fencing[resource] = -1; writeFileSync(statePath, JSON.stringify(state)); expect(() => new DistributedControlPlane({ persistence_dir: root, host_credentials: { host_a: secretA } })).toThrow(/malformed/);
    const unavailable = new DistributedControlClient({ base_url: "http://127.0.0.1:1", host_id: "host_a", secret: secretA, fetch: vi.fn(async () => { throw new Error("partition"); }) as never, max_attempts: 2, backoff_ms: 1, deadline_ms: 100 }); expect(await unavailable.request("GET", "/v1/health")).toMatchObject({ ok: false, error: "unavailable" });
  });
});
