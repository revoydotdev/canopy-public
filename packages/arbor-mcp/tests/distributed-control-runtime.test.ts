import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalResourceIdentity, DistributedControlClient } from "../src/distributed-control-plane.js";
import { DistributedControlRuntime, loadDistributedControlConfig, resolveDistributedSecret, runDistributedControlCli, type DistributedAuthorityConfig, type DistributedJoinConfig } from "../src/distributed-control-runtime.js";
import { DistributedRemoteBridge } from "../src/distributed-remote-bridge.js";

const roots: string[] = [];
const secret = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const peerSecret = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const hash = (value: string) => `sha256:${value.repeat(64)}`;
const resource = canonicalResourceIdentity({ namespace: "repository", repository: "repo-a", kind: "result", key: "candidate" });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function authorityConfig(root: string): DistributedAuthorityConfig {
  return { version: 1, role: "authority", persistence_dir: join(root, "authority"), listener: { host: "127.0.0.1", port: 0 }, grants: {
    operator: { secret_ref: { kind: "env", name: "OPERATOR_SECRET" }, routes: ["hosts.register", "hosts.discover", "messages.send", "messages.receive", "leases.manage", "adoptions.manage", "health.read"], resource_prefixes: ["*"], audiences: ["*"], capabilities: ["*"], expires_at: "2099-01-01T00:00:00.000Z" },
    peer: { secret_ref: { kind: "env", name: "PEER_SECRET" }, routes: ["hosts.register", "messages.send", "messages.receive"], resource_prefixes: [], audiences: ["operator"], capabilities: ["messages"], expires_at: "2099-01-01T00:00:00.000Z" },
  } };
}
function joinConfig(root: string, url: string, bridge = false): DistributedJoinConfig {
  return { version: 1, role: "join", persistence_dir: join(root, "join"), coordinator_url: url, host_id: "operator", secret_ref: { kind: "env", name: "OPERATOR_SECRET" }, registration: { repo_id: "repo-a", session_id: "session-a", endpoint: "https://operator.invalid", capabilities: ["messages"], ttl_ms: 1_000 }, heartbeat_ms: 100, ...(bridge ? { bridge: { enabled: true, persistence_dir: join(root, "bridge"), poll_interval_ms: 50, visibility_timeout_ms: 100 } } : {}) };
}
function streams() { const stdout = new PassThrough(), stderr = new PassThrough(); let out = "", err = ""; stdout.on("data", (chunk) => { out += chunk; }); stderr.on("data", (chunk) => { err += chunk; }); return { stdout, stderr, out: () => out, err: () => err }; }
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error("timed out waiting for the distributed control runtime"); }

describe("distributed production composition and operator reachability", () => {
  it("accepts only typed env or protected-file secrets and a closed config schema", () => {
    const root = mkdtempSync(join(tmpdir(), "revoy-control-config-")); roots.push(root); const protectedFile = join(root, "secret"); writeFileSync(protectedFile, `${secret}\n`); chmodSync(protectedFile, 0o600);
    expect(resolveDistributedSecret({ kind: "env", name: "CONTROL_SECRET" }, { env: { CONTROL_SECRET: secret } })).toBe(secret);
    expect(resolveDistributedSecret({ kind: "file", path: protectedFile })).toBe(secret);
    chmodSync(protectedFile, 0o644); expect(() => resolveDistributedSecret({ kind: "file", path: protectedFile })).toThrow(/0600/);
    const configPath = join(root, "config.json"); writeFileSync(configPath, JSON.stringify({ ...authorityConfig(root), inline_secret: secret })); expect(() => loadDistributedControlConfig(configPath)).toThrow(/closed/);
  });

  it("owns join heartbeat, bridge polling and graceful lock-releasing shutdown with redacted projection", async () => {
    const root = mkdtempSync(join(tmpdir(), "revoy-control-lifecycle-")); roots.push(root); const deps = { env: { OPERATOR_SECRET: secret, PEER_SECRET: peerSecret } }; const authority = new DistributedControlRuntime(authorityConfig(root), deps); await authority.start(); const url = authority.authorityAddress()!; let dispatches = 0;
    try {
      const joined = new DistributedControlRuntime(joinConfig(root, url, true), deps); joined.attachIngress({ dispatchTransport: async () => { dispatches++; return { ok: true, value: { accepted: true } }; } } as never); await joined.start();
      try {
        expect(() => joined.attachIngress({ dispatchTransport: async () => ({ ok: true }) } as never)).toThrow(/before runtime start/); await new Promise((resolve) => setTimeout(resolve, 240));
        const projection = await joined.project(); expect(projection.registration).toMatchObject({ registered: true, failure_count: 0 }); expect(projection.bridge.status).toBe("ready"); expect(JSON.stringify(projection)).not.toContain(secret); expect(JSON.stringify(projection)).not.toContain(root);
        const peer = new DistributedControlClient({ base_url: url, host_id: "peer", secret: peerSecret }); await peer.request("POST", "/v1/messages", { request_id: "command", recipient_host_id: "operator", kind: "remote.transport.command", payload: {}, correlation_id: "lifecycle" }); await waitFor(() => dispatches > 0, 10_000); await new Promise((resolve) => setTimeout(resolve, 150)); expect(dispatches).toBe(1);
      } finally { await joined.close(); }
      const restarted = new DistributedControlRuntime(joinConfig(root, url), deps); await restarted.start(); await restarted.close();
    } finally { await authority.close(); }
  });

  it("reports a poll failure as degraded health without an unhandled rejection when the bridge journal directory disappears", async () => {
    const root = mkdtempSync(join(tmpdir(), "revoy-control-durable-")); roots.push(root); const authority = new DistributedControlRuntime(authorityConfig(root), { env: { OPERATOR_SECRET: secret, PEER_SECRET: peerSecret } }); await authority.start(); const journal = join(root, "bridge");
    const bridge = new DistributedRemoteBridge({ client: new DistributedControlClient({ base_url: authority.authorityAddress()!, host_id: "operator", secret }), ingress: { dispatchTransport: async () => ({ ok: true }) } as never, persistence_dir: journal, poll_interval_ms: 50, visibility_timeout_ms: 100 });
    const unhandled: unknown[] = []; const capture = (reason: unknown): void => { unhandled.push(reason); }; process.on("unhandledRejection", capture);
    try { bridge.start(); await authority.close(); rmSync(journal, { recursive: true, force: true }); await waitFor(() => bridge.health().status === "degraded"); await new Promise((resolve) => setTimeout(resolve, 100)); expect(bridge.health().last_error).toBeTruthy(); } finally { process.off("unhandledRejection", capture); bridge.close(); }
    expect(unhandled).toEqual([]);
  });

  it("makes status, discovery, redacted inbox, leases and adoption recovery reachable through the CLI adapter", async () => {
    const root = mkdtempSync(join(tmpdir(), "revoy-control-cli-")); roots.push(root); mkdirSync(join(root, "configs")); const env = { OPERATOR_SECRET: secret, PEER_SECRET: peerSecret }; const authority = new DistributedControlRuntime(authorityConfig(root), { env }); await authority.start(); const url = authority.authorityAddress()!, configPath = join(root, "configs", "join.json"); writeFileSync(configPath, JSON.stringify(joinConfig(root, url)));
    const run = async (args: string[]) => { const io = streams(); const code = await runDistributedControlCli([...args, "--config", configPath], { cwd: root, env, stdout: io.stdout, stderr: io.stderr }); return { code, output: io.out(), error: io.err() }; };
    const status = await run(["status"]); expect(status.code).toBe(0); expect(JSON.parse(status.output)).toMatchObject({ role: "join", registration: { registered: true } }); expect(status.output).not.toContain(secret); expect(status.output).not.toContain(root);
    const discovery = await run(["discover", "--limit", "10"]); expect(discovery.code).toBe(0); expect(JSON.parse(discovery.output).hosts[0]).toMatchObject({ host_id: "operator", repo_id: "repo-a" });
    const peer = new DistributedControlClient({ base_url: url, host_id: "peer", secret: peerSecret }); await peer.request("POST", "/v1/messages", { request_id: "secret-message", recipient_host_id: "operator", kind: "peer.query", payload: { token: "must-not-project" }, correlation_id: "redact" }); const inbox = await run(["inbox"]); expect(inbox.code).toBe(0); expect(inbox.output).toContain("payload_bytes"); expect(inbox.output).not.toContain("must-not-project");
    const acquired = await run(["lease", "acquire", "--resource", resource, "--ttl-ms", "30000"]); expect(acquired.code).toBe(0); const lease = JSON.parse(acquired.output); expect(lease.fencing_token).toBe(1);
    const prepared = await run(["adoption", "prepare", "--resource", resource, "--fence", String(lease.fencing_token), "--artifact-sha256", hash("a"), "--base-head", hash("b"), "--selection-sha256", hash("c")]); expect(prepared.code).toBe(0); const transaction = JSON.parse(prepared.output);
    expect((await run(["adoption", "commit", "--transaction", transaction.transaction_id])).code).toBe(0); const inspected = await run(["adoption", "inspect", "--transaction", transaction.transaction_id]); expect(JSON.parse(inspected.output).state).toBe("committed"); const reconciled = await run(["adoption", "reconcile", "--transaction", transaction.transaction_id, "--resolution", "finalize", "--result-head", hash("d"), "--tree-sha256", hash("e")]); expect(reconciled.code).toBe(0); expect(JSON.parse(reconciled.output).state).toBe("finalized"); await authority.close();
  });

  it("serves authority config until shutdown and reports a bounded address without secrets", async () => {
    const root = mkdtempSync(join(tmpdir(), "revoy-control-serve-")); roots.push(root); const config = join(root, "authority.json"); writeFileSync(config, JSON.stringify(authorityConfig(root))); let release!: () => void; const shutdown = new Promise<void>((resolve) => { release = resolve; }); const io = streams(); const pending = runDistributedControlCli(["serve", "--config", config], { cwd: root, env: { OPERATOR_SECRET: secret, PEER_SECRET: peerSecret }, stdout: io.stdout, stderr: io.stderr, shutdown }); await new Promise((resolve) => setTimeout(resolve, 30)); expect(io.out()).toContain("bound_address"); expect(io.out()).not.toContain(secret); release(); expect(await pending).toBe(0);
    const runtime = new DistributedControlRuntime(authorityConfig(root), { env: { OPERATOR_SECRET: secret, PEER_SECRET: peerSecret } }); await runtime.start(); await runtime.close();
  });
});
