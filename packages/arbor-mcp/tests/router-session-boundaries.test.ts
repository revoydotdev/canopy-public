/**
 * Per-surface pin for `RuntimeRouterOptions.require_local_session`
 * (security investigation 2026-10-06; rationale at the option in
 * runtime-catalog.ts and in ADR-084's 2026-10-06 amendment).
 *
 * Only the TUI composition sets the flag. Every other router is reached
 * either in-process by the operator's own CLI, by a stdio MCP peer the
 * operator spawned (ADR-084: junior unless --trusted-client), by the
 * loopback web dashboard (junior anonymously, senior behind the bootstrap
 * cookie; anonymous raw reads refused since the 2026-10-06 decision), or by
 * the signed remote ingress (commands only). Those surfaces
 * authenticate by tier, cookie or signed remote proof, never by a local
 * session proof — and this file drives each real entry point so that adding
 * or removing the flag at any of them is a deliberate, test-breaking change.
 *
 * The last block pins WHY the flag is not a transport authenticator: a local
 * session proof carries its own public key, so any caller can mint as many
 * distinct identities as it likes.
 */
import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import * as http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.js";
import { ArborRuntime } from "../src/runtime.js";
import { ArborWebUIServer } from "../src/webui.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { RuntimePortAdapter } from "../src/tui-adapter.js";
import { LocalSessionAuthority } from "../src/local-session.js";
import { RemoteRuntimeIngress } from "../src/remote-ingress.js";
import { EXIT_CODES } from "../src/exit-codes.js";

const EXPIRY = "2099-01-01T00:00:00.000Z";
const NO_IDENTITY = "approval commands require an authenticated identity";

function metadata(operation_id: string, actor_id = "claimed-actor") {
  return { operation_id, idempotency_key: `${operation_id}:key`, correlation_id: operation_id, actor_id, requested_at: "2026-10-06T00:00:00.000Z" };
}

function approvalRequest(operation_id: string) {
  return {
    kind: "approval.request", request_id: `${operation_id}-approval`, idempotency_key: `${operation_id}-approval:key`,
    action: "campaign.halt", subject: "halt", resource_id: "campaign-1", proposer: "claimed-actor",
    rationale: "pin", expires_at: EXPIRY, metadata: metadata(operation_id),
  };
}

function identityMutation(operation_id: string, session_id: string) {
  return { kind: "session.identity.mutate", session_id, display_name: "pinned", provenance: { tag: "claimed", claimant: "test" }, metadata: metadata(operation_id) };
}

/** A runtime holding one captured output and an approved two-party disclosure of it. */
async function seededRuntime(persistence: string): Promise<{ runtime: ArborRuntime; evidence_id: string; approval_id: string }> {
  const runtime = new ArborRuntime({ persistence_dir: persistence });
  const captured = await new RuntimeCatalogRouter(runtime).dispatchCommand({
    schema_version: 1, metadata: metadata("capture"),
    command: { kind: "output.capture", artifact: { campaign_id: "c1", node_id: "n1", stream: "stdout", media_type: "text/plain", provenance: { tag: "claimed", claimant: "seed" } }, content: "approved raw material" },
  });
  if (!captured.ok || !captured.value.accepted || !("output" in captured.value)) throw new Error("capture failed");
  const evidence_id = captured.value.output.descriptor.id;
  const requested = runtime.approvals.request({ request_id: "raw", idempotency_key: "raw", action: "output.raw", subject: "review", resource_id: evidence_id, proposer: "operator-a", rationale: "incident review", expires_at: EXPIRY });
  if (!requested.ok) throw new Error(requested.error);
  const approved = runtime.approvals.approve({ request_id: "raw", actor: "auditor-b", clock: runtime.approvals.now() });
  if (!approved.ok) throw new Error(approved.error);
  return { runtime, evidence_id, approval_id: "raw" };
}

function collect(stream: PassThrough): { text(): string } {
  let buffer = "";
  stream.on("data", (chunk: Buffer) => { buffer += chunk.toString(); });
  return { text: () => buffer };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function rpc(stdin: PassThrough, stdout: { text(): string }, id: string, method: string, input: unknown): Promise<{ ok: boolean; value?: { accepted?: boolean; content?: string; error?: { summary?: string } }; error?: { summary?: string; message?: string; data?: unknown } }> {
  stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: { input } })}\n`);
  for (let attempt = 0; attempt < 200; attempt++) {
    const line = stdout.text().split("\n").find((candidate) => candidate.includes(`"id":"${id}"`));
    if (line) { const reply = JSON.parse(line); return reply.result ?? { ok: false, error: reply.error }; }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`no reply for ${id}`);
}

async function serve(args: string[], runtime: ArborRuntime, cwd: string) {
  const stdin = new PassThrough();
  const stdoutStream = new PassThrough();
  const stdout = collect(stdoutStream);
  const done = main(args, { cwd, persistence_dir: undefined, stdin, stdout: stdoutStream, stderr: new PassThrough(), runtime_factory: () => runtime });
  await tick();
  stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "router-session-boundaries", version: "1" } } })}\n`);
  await tick();
  stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await tick();
  return { stdin, stdout, done };
}

function request(port: number, method: string, path: string, body?: unknown, cookie?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) } }, (response) => {
      let output = "";
      response.on("data", (chunk) => { output += String(chunk); });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, json: output.trim().startsWith("{") ? JSON.parse(output) : null }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

describe("require_local_session is set only where a local session is the authority", () => {
  it("in-process CLI: the operator's own `arbor session identity set` mutates with no session proof", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "arbor-router-session-cli-"));
    try {
      const stdout = new PassThrough();
      const out = collect(stdout);
      const code = await main(["session", "identity", "set", "cli-pinned", "--name", "operator"], { cwd, persistence_dir: undefined, stdin: new PassThrough(), stdout, stderr: new PassThrough() });
      expect(code).toBe(EXIT_CODES.SUCCESS);
      expect(out.text()).toContain('"accepted": true');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("stdio `arbor serve` (junior default): mutation refused by tier; an approved raw disclosure is readable with no session proof", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "arbor-router-session-serve-"));
    const seeded = await seededRuntime(join(cwd, ".arbor"));
    const session = await serve(["serve"], seeded.runtime, cwd);
    try {
      const mutation = await rpc(session.stdin, session.stdout, "mutate", "arbor_command", identityMutation("serve-junior", "serve-junior"));
      expect(JSON.stringify(mutation)).toMatch(/junior/);
      const raw = await rpc(session.stdin, session.stdout, "raw", "arbor_query", { kind: "output.raw", evidence_id: seeded.evidence_id, approval_id: seeded.approval_id });
      expect(raw).toMatchObject({ ok: true, value: { content: "approved raw material" } });
      const unapproved = await rpc(session.stdin, session.stdout, "raw-missing", "arbor_query", { kind: "output.raw", evidence_id: seeded.evidence_id, approval_id: "never-approved" });
      // Refused by the approval record, not by a session check: the flag is off here.
      expect(JSON.stringify(unapproved)).toContain("raw output approval denied: approval record was not found");
      expect(JSON.stringify(unapproved)).not.toContain("raw output session denied");
      // The router attaches the remedy at the denial site: obtain an approval.
      // Re-authenticating cannot clear it (ADR-179 amendment 2026-10-06).
      expect(unapproved.error?.data).toMatchObject({
        kind: "authorization_refusal",
        gate_refusal: { schema_version: 2, gate: "capability", code: "approval_not_granted", correcting_actor: "caller", corrective_action: "request_approval", remediation: expect.stringContaining("approval.request") },
      });
    } finally {
      session.stdin.end();
      await session.done;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("stdio `arbor serve --trusted-client`: approvals still refuse an unauthenticated peer (D41), and the refusal is not a session-proof demand", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "arbor-router-session-trusted-"));
    const session = await serve(["serve", "--trusted-client"], new ArborRuntime({ persistence_dir: join(cwd, ".arbor") }), cwd);
    try {
      const approval = await rpc(session.stdin, session.stdout, "approval", "arbor_command", approvalRequest("serve-trusted"));
      expect(approval).toMatchObject({ ok: true, value: { accepted: false, error: { summary: NO_IDENTITY } } });
      const mutation = await rpc(session.stdin, session.stdout, "mutate", "arbor_command", identityMutation("serve-trusted-mutate", "serve-trusted"));
      expect(mutation).toMatchObject({ ok: true, value: { accepted: true } });
    } finally {
      session.stdin.end();
      await session.done;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("loopback web dashboard: anonymous is junior and reads no raw output; the bootstrap cookie confers senior and the raw read, but never an approval identity", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "arbor-router-session-web-"));
    const seeded = await seededRuntime(cwd);
    const web = new ArborWebUIServer(seeded.runtime);
    await new Promise<void>((resolve) => web.start(0, resolve));
    try {
      const port = web.getPort()!;
      const anonymousMutation = await request(port, "POST", "/api/runtime/command", identityMutation("web-anon", "web-anon"));
      expect(JSON.stringify(anonymousMutation.json)).toMatch(/junior/);
      // Changed 2026-10-06 (operator decision): this used to return the
      // content. Any local process reaches this port, so an approved raw
      // read now also needs the operator session; the approval record alone
      // no longer suffices here. The flag stays off — the cookie, not a local
      // session proof, is this surface's authority.
      const anonymousRaw = await request(port, "POST", "/api/runtime/query", { kind: "output.raw", evidence_id: seeded.evidence_id, approval_id: seeded.approval_id });
      expect(anonymousRaw.json).toMatchObject({ ok: false, error: { code: "permission", summary: "raw output disclosure requires the authenticated operator session" } });
      expect(JSON.stringify(anonymousRaw.json)).not.toContain("approved raw material");

      const bootstrap = await request(port, "GET", new URL(web.getOperatorUrl()!).pathname + new URL(web.getOperatorUrl()!).search);
      const cookie = String(bootstrap.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
      expect(cookie).toMatch(/^arbor_operator=/);
      const operatorRaw = await request(port, "POST", "/api/runtime/query", { kind: "output.raw", evidence_id: seeded.evidence_id, approval_id: seeded.approval_id }, cookie);
      expect(operatorRaw.json).toMatchObject({ ok: true, value: { content: "approved raw material" } });
      const operatorMutation = await request(port, "POST", "/api/runtime/command", identityMutation("web-operator", "web-operator"), cookie);
      expect(operatorMutation.json).toMatchObject({ ok: true, value: { accepted: true } });
      const operatorApproval = await request(port, "POST", "/api/runtime/command", approvalRequest("web-operator-approval"), cookie);
      expect(operatorApproval.json).toMatchObject({ ok: true, value: { accepted: false, error: { summary: NO_IDENTITY } } });
    } finally {
      await web.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("signed remote ingress forwards no query, so a raw read can never arrive there as `unauthenticated-local`", async () => {
    const runtime = new ArborRuntime();
    const ingress = new RemoteRuntimeIngress(new RuntimeCatalogRouter(runtime), runtime.remoteSessionAuthority);
    const result = await ingress.dispatch({ metadata: metadata("remote-raw"), command: { kind: "output.raw", evidence_id: "x", approval_id: "y" } });
    expect(result).toMatchObject({ ok: false, error: { summary: expect.stringContaining("only supports direct-thread send/ack and approval") } });
  });
});

describe("why the flag must not be set on a transport-reached router", () => {
  it("a local session proof is self-certifying: two freshly minted sessions satisfy proposer != decider", async () => {
    // On the TUI only the in-process adapter can reach the router, so the
    // operator holding the process IS the authority and the proof merely
    // stops actor text from being forged. Behind a transport, any peer could
    // mint both keys below and approve its own request.
    const router = new RuntimeCatalogRouter(new ArborRuntime(), { require_local_session: true });
    const proposer = new RuntimePortAdapter(router, undefined, new LocalSessionAuthority().identity());
    const minted = new RuntimePortAdapter(router, undefined, new LocalSessionAuthority().identity());
    await expect(proposer.command({ kind: "approval.request", metadata: { operation_id: "mint-request", idempotency_key: "mint-request:key" }, params: {
      request_id: "mint", idempotency_key: "mint:key", action: "campaign.halt", subject: "halt", resource_id: "campaign-1", rationale: "pin", expires_at: EXPIRY,
    } })).resolves.toMatchObject({ ok: true, value: { accepted: true } });
    await expect(minted.command({ kind: "approval.approve", metadata: { operation_id: "mint-approve", idempotency_key: "mint-approve:key" }, params: { request_id: "mint" } }))
      .resolves.toMatchObject({ ok: true, value: { accepted: true } });
  });
});
