import { describe, expect, it } from "vitest";
import { BoundedJsonRpcClient } from "../../src/mcp-client/json-rpc.js";
import { FakeMcpServer } from "./fake-mcp-server.js";
import { HttpMcpTransport } from "../../src/mcp-client/http-transport.js";

describe("bounded JSON-RPC client", () => {
  it("correlates a closed validated response and types malformed frames", async () => {
    const server = new FakeMcpServer(); const client = new BoundedJsonRpcClient(server); await client.open(new AbortController().signal);
    expect(await client.request("initialize", {}, { timeout_ms: 100 })).toMatchObject({ protocolVersion: "2025-06-18" });
    server.malformed = true;
    await expect(client.request("initialize", {}, { timeout_ms: 100 })).rejects.toMatchObject({ code: "protocol" });
  });

  it("rejects extra envelope fields and invalid caller-supplied bounds", async () => {
    const server = new FakeMcpServer(); const client = new BoundedJsonRpcClient(server); await client.open(new AbortController().signal);
    server.exchange = async (message) => ({ jsonrpc: "2.0", id: message.id, result: {}, extra: true });
    await expect(client.request("x", {}, { timeout_ms: 100 })).rejects.toMatchObject({ code: "protocol" });
    await expect(client.request("x", {}, { timeout_ms: 0 })).rejects.toMatchObject({ code: "protocol" });
  });

  it("returns a typed timeout instead of leaking a transport throw", async () => {
    const server = new FakeMcpServer(); server.delayMs = 50; const client = new BoundedJsonRpcClient(server); await client.open(new AbortController().signal);
    await expect(client.request("initialize", {}, { timeout_ms: 5 })).rejects.toMatchObject({ code: "timeout" });
    expect(server.methods).toContain("notifications/cancelled");
  });

  it("enforces the concurrent-request ceiling", async () => {
    const server = new FakeMcpServer(); const client = new BoundedJsonRpcClient(server, 1); await client.open(new AbortController().signal); server.delayMs = 30;
    const first = client.request("initialize", {}, { timeout_ms: 100 });
    await expect(client.request("initialize", {}, { timeout_ms: 100 })).rejects.toMatchObject({ code: "concurrency" });
    await first;
  });

  it("drains SSE keepalives and carries bearer, session, and negotiated-version headers", async () => {
    const headers: Headers[] = []; let calls = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      headers.push(new Headers(init?.headers)); calls += 1;
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const request = JSON.parse(String(init?.body)) as { id?: number };
      return new Response(`: keepalive\n\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } })}\n\n`, { status: 200, headers: { "Content-Type": "text/event-stream", ...(calls === 1 ? { "Mcp-Session-Id": "session-1" } : {}) } });
    };
    const client = new BoundedJsonRpcClient(new HttpMcpTransport({ url: "https://example.test/mcp", fetch: fetchImpl }));
    await client.open(new AbortController().signal, "TOKEN");
    expect(await client.request("initialize", {}, { timeout_ms: 100, secret: "TOKEN" })).toEqual({ ok: true });
    expect(await client.request("tools/list", {}, { timeout_ms: 100, secret: "TOKEN", protocol_version: "2025-06-18" })).toEqual({ ok: true });
    expect(headers[0]?.get("authorization")).toBe("Bearer TOKEN");
    expect(headers[1]?.get("mcp-session-id")).toBe("session-1");
    expect(headers[1]?.get("mcp-protocol-version")).toBe("2025-06-18");
    expect(await client.request("tools/call", { name: "read", arguments: {} }, { timeout_ms: 100, secret: "TOKEN", protocol_version: "2026-07-28" })).toEqual({ ok: true });
    expect(headers[2]?.get("mcp-session-id")).toBeNull();
    expect(headers[2]?.get("mcp-method")).toBe("tools/call");
    expect(headers[2]?.get("mcp-name")).toBe("read");
    await client.close("TOKEN", "2025-06-18");
    expect(headers[3]?.get("authorization")).toBe("Bearer TOKEN");
    expect(headers[3]?.get("mcp-protocol-version")).toBe("2025-06-18");
  });
});
