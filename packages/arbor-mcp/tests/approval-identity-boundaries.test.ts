import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import * as http from "node:http";
import { ArborRuntime } from "../src/runtime.js";
import { ArborMCPServer } from "../src/server.js";
import { startStdioSession } from "../src/cli.js";
import { ArborWebUIServer } from "../src/webui.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { RuntimePortAdapter } from "../src/tui-adapter.js";
import { LocalSessionAuthority } from "../src/local-session.js";

const EXPIRY = "2099-01-01T00:00:00.000Z";

function metadata(operation_id: string, actor_id: string) {
  return { operation_id, idempotency_key: `${operation_id}:key`, correlation_id: `${operation_id}:correlation`, actor_id, requested_at: "2026-08-24T00:00:00.000Z" };
}

function approvalRequest(proposer: string, operation_id = "approval-request") {
  return {
    kind: "approval.request", request_id: "approval-1", idempotency_key: "approval-1:key",
    action: "campaign.halt", subject: "halt the campaign", resource_id: "campaign-1",
    proposer, rationale: "operator requested halt", expires_at: EXPIRY,
    metadata: metadata(operation_id, proposer),
  };
}

function post(port: number, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, path: "/api/runtime/command", method: "POST", headers: { "content-type": "application/json" } }, (response) => {
      let output = "";
      response.on("data", (chunk) => { output += String(chunk); });
      response.on("end", () => resolve(JSON.parse(output)));
    });
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

async function initialize(input: PassThrough): Promise<void> {
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: "initialize", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "approval-boundary-test", version: "1" } } })}\n`);
  await new Promise<void>((resolve) => setImmediate(resolve));
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("D41 approval identity boundaries", () => {
  it("refuses an approval from the unauthenticated standard-MCP tool surface", async () => {
    const server = new ArborMCPServer(new ArborRuntime());
    const result = await server.callTool("arbor_command", approvalRequest("mcp-claimed")) as { ok: boolean; value: { accepted: boolean; error?: { code: string; summary: string } } };
    expect(result).toMatchObject({ ok: true, value: { accepted: false, error: { code: "permission", summary: "approval commands require an authenticated identity" } } });
  });

  it("refuses an approval from the CLI stdio MCP path even when the client supplies distinct actor text", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = "";
    output.on("data", (chunk: Buffer) => { transcript += chunk.toString(); });
    const session = await startStdioSession(new ArborMCPServer(new ArborRuntime()), input, output);
    try {
      await initialize(input);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: "approval", method: "arbor_command", params: { input: approvalRequest("cli-claimed") } })}\n`);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const reply = JSON.parse(transcript.split("\n").find((line) => line.includes('"id":"approval"'))!);
      expect(reply.result).toMatchObject({ ok: true, value: { accepted: false, error: { code: "permission", summary: "approval commands require an authenticated identity" } } });
    } finally {
      await session.close();
    }
  });

  it("refuses an approval from the unauthenticated loopback Web runtime route at its junior caller tier", async () => {
    const web = new ArborWebUIServer(new ArborRuntime());
    await new Promise<void>((resolve) => web.start(0, resolve));
    try {
      await expect(post(web.getPort()!, approvalRequest("web-claimed"))).resolves.toMatchObject({
        ok: true, value: { accepted: false, error: { code: "permission", summary: expect.stringContaining("junior") } },
      });
    } finally {
      await web.stop();
    }
  });

  it("binds TUI proposals and decisions to distinct signed local sessions", async () => {
    const runtime = new ArborRuntime();
    const router = new RuntimeCatalogRouter(runtime, { require_local_session: true });
    const proposerIdentity = new LocalSessionAuthority().identity();
    const deciderIdentity = new LocalSessionAuthority().identity();
    const proposer = new RuntimePortAdapter(router, undefined, proposerIdentity);
    const decider = new RuntimePortAdapter(router, undefined, deciderIdentity);

    const requested = await proposer.command({ kind: "approval.request", metadata: { operation_id: "tui-request", idempotency_key: "tui-request:key" }, params: {
      request_id: "tui-approval", idempotency_key: "tui-approval:key", action: "campaign.halt", subject: "halt the campaign", resource_id: "campaign-1", rationale: "operator requested halt", expires_at: EXPIRY,
    } });
    expect(requested).toMatchObject({ ok: true, value: { accepted: true } });

    const selfApproval = await proposer.command({ kind: "approval.approve", metadata: { operation_id: "tui-self", idempotency_key: "tui-self:key" }, params: { request_id: "tui-approval" } });
    expect(selfApproval).toMatchObject({ ok: true, value: { accepted: false, error: { code: "permission" } } });

    const approved = await decider.command({ kind: "approval.approve", metadata: { operation_id: "tui-decide", idempotency_key: "tui-decide:key" }, params: { request_id: "tui-approval" } });
    expect(approved).toMatchObject({ ok: true, value: { accepted: true } });
    const projected = await decider.query({ kind: "approval.list", query_id: "tui-approval-list", params: { status: "approved" } });
    expect(projected).toMatchObject({
      ok: true,
      value: { records: [expect.objectContaining({ request_id: "tui-approval", proposer: proposerIdentity.actor_id, decided_by: deciderIdentity.actor_id, status: "approved" })] },
    });
  });
});
