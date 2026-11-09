/**
 * HttpMcpTransport is exercised through its injected `fetch` seam, never a
 * live socket — this repository's hermetic convention. Each fake `fetch`
 * below returns a real `Response` object so the transport's own header,
 * status, content-type, and streaming-body logic all run for real; only the
 * network hop itself is replaced.
 */
import { describe, expect, it } from "vitest";
import { HttpMcpTransport } from "../../src/mcp-client/http-transport.js";
import { MCP_MAX_FRAME_BYTES, MCP_PREFERRED_PROTOCOL_VERSION } from "../../src/mcp-client/contracts.js";

const noSecretOptions = { signal: new AbortController().signal, secret: null, protocol_version: null } as const;
const req = (id: number, method: string, params?: unknown) => ({ jsonrpc: "2.0" as const, id, method, ...(params === undefined ? {} : { params }) });

describe("HTTP MCP transport construction", () => {
  it("rejects a URL string that does not parse", () => {
    expect(() => new HttpMcpTransport({ url: "not a url" })).toThrow(/invalid/);
  });
  it("rejects a non-HTTPS scheme", () => {
    expect(() => new HttpMcpTransport({ url: "http://example.test/mcp" })).toThrow(/HTTPS/);
  });
  it("rejects embedded credentials in the URL", () => {
    expect(() => new HttpMcpTransport({ url: "https://user:pass@example.test/mcp" })).toThrow(/HTTPS/);
  });
  it("rejects a URL longer than the 2048-byte bound", () => {
    const long = `https://example.test/${"a".repeat(2_048)}`;
    expect(() => new HttpMcpTransport({ url: long })).toThrow(/HTTPS/);
  });
  it("accepts a bounded HTTPS URL and starts disconnected", () => {
    const transport = new HttpMcpTransport({ url: "https://example.test/mcp" });
    expect(transport.connected).toBe(false);
  });
});

describe("HTTP MCP transport open/close lifecycle", () => {
  it("refuses to open once the caller's signal is already aborted", async () => {
    const transport = new HttpMcpTransport({ url: "https://example.test/mcp" });
    const controller = new AbortController(); controller.abort();
    await expect(transport.open(controller.signal, null)).rejects.toMatchObject({ code: "transport" });
    expect(transport.connected).toBe(false);
  });
  it("marks itself connected after a clean open", async () => {
    const transport = new HttpMcpTransport({ url: "https://example.test/mcp" });
    await transport.open(new AbortController().signal, null);
    expect(transport.connected).toBe(true);
  });
  it("skips the DELETE call on close when no session was ever assigned", async () => {
    let fetchCalls = 0;
    const transport = new HttpMcpTransport({ url: "https://example.test/mcp", fetch: (async () => { fetchCalls += 1; return new Response("{}"); }) as typeof fetch });
    await transport.open(new AbortController().signal, null);
    await transport.close(null, null);
    expect(fetchCalls).toBe(0);
    expect(transport.connected).toBe(false);
  });
  it("issues a best-effort session DELETE with auth and protocol headers, swallowing failures", async () => {
    const seen: { method?: string; headers?: Record<string, string> } = {};
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") { seen.method = init.method; seen.headers = init.headers as Record<string, string>; throw new Error("network gone"); }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { headers: { "content-type": "application/json", "mcp-session-id": "sess-1" } });
    }) as typeof fetch;
    const transport = new HttpMcpTransport({ url: "https://example.test/mcp", fetch: fakeFetch });
    await transport.open(new AbortController().signal, null);
    await transport.exchange(req(1, "initialize"), noSecretOptions);
    await expect(transport.close("token-x", "2025-06-18")).resolves.toBeUndefined();
    expect(seen.method).toBe("DELETE");
    expect(seen.headers?.["Mcp-Session-Id"]).toBe("sess-1");
    expect(seen.headers?.Authorization).toBe("Bearer token-x");
    expect(seen.headers?.["MCP-Protocol-Version"]).toBe("2025-06-18");
  });
});

describe("HTTP MCP transport request/response handling", () => {
  it("rejects exchange before the transport has been opened", async () => {
    const transport = new HttpMcpTransport({ url: "https://example.test/mcp" });
    await expect(transport.exchange(req(1, "tools/list"), noSecretOptions)).rejects.toMatchObject({ code: "closed" });
  });
  it("captures a well-formed session id from an initialize response", async () => {
    let secondHeaders: Record<string, string> | undefined;
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      if (headers["Content-Type"] && !secondHeaders && JSON.parse(String(init?.body)).method === "tools/list") secondHeaders = headers;
      if (JSON.parse(String(init?.body)).method === "initialize") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { headers: { "content-type": "application/json", "mcp-session-id": "abc-123" } });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const transport = new HttpMcpTransport({ url: "https://example.test/mcp", fetch: fakeFetch });
    await transport.open(new AbortController().signal, null);
    await transport.exchange(req(1, "initialize"), noSecretOptions);
    await transport.exchange(req(2, "tools/list"), noSecretOptions);
    expect(secondHeaders?.["Mcp-Session-Id"]).toBe("abc-123");
  });
  it("rejects an initialize response carrying an invalid session id header", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { headers: { "content-type": "application/json", "mcp-session-id": "has spaces" } })) as typeof fetch;
    const transport = new HttpMcpTransport({ url: "https://example.test/mcp", fetch: fakeFetch });
    await transport.open(new AbortController().signal, null);
    await expect(transport.exchange(req(1, "initialize"), noSecretOptions)).rejects.toMatchObject({ code: "protocol" });
  });
  it("rejects an initialize response whose session id exceeds 512 bytes", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { headers: { "content-type": "application/json", "mcp-session-id": "a".repeat(513) } })) as typeof fetch;
    const transport = new HttpMcpTransport({ url: "https://example.test/mcp", fetch: fakeFetch });
    await transport.open(new AbortController().signal, null);
    await expect(transport.exchange(req(1, "initialize"), noSecretOptions)).rejects.toMatchObject({ code: "protocol" });
  });
  it("surfaces a non-2xx HTTP status as a transport failure", async () => {
    const fakeFetch = (async () => new Response("nope", { status: 503 })) as typeof fetch;
    const transport = new HttpMcpTransport({ url: "https://example.test/mcp", fetch: fakeFetch });
    await transport.open(new AbortController().signal, null);
    await expect(transport.exchange(req(1, "tools/list"), noSecretOptions)).rejects.toMatchObject({ code: "transport", message: expect.stringContaining("503") });
  });
  it("rejects a response whose content type is neither JSON nor SSE", async () => {
    const fakeFetch = (async () => new Response("<html></html>", { headers: { "content-type": "text/html" } })) as typeof fetch;
    const transport = new HttpMcpTransport({ url: "https://example.test/mcp", fetch: fakeFetch });
    await transport.open(new AbortController().signal, null);
    await expect(transport.exchange(req(1, "tools/list"), noSecretOptions)).rejects.toMatchObject({ code: "protocol" });
  });
  it("parses a correlated event from a text/event-stream body", async () => {
    const sse = `: comment\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n`;
    const fakeFetch = (async () => new Response(sse, { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const transport = new HttpMcpTransport({ url: "https://example.test/mcp", fetch: fakeFetch });
    await transport.open(new AbortController().signal, null);
    await expect(transport.exchange(req(7, "tools/call"), noSecretOptions)).resolves.toMatchObject({ result: { ok: true } });
  });
  it("throws when the SSE stream never carries the correlated id", async () => {
    const sse = `data: {"jsonrpc":"2.0","id":999,"result":{}}\n\n`;
    const fakeFetch = (async () => new Response(sse, { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const transport = new HttpMcpTransport({ url: "https://example.test/mcp", fetch: fakeFetch });
    await transport.open(new AbortController().signal, null);
    await expect(transport.exchange(req(7, "tools/call"), noSecretOptions)).rejects.toMatchObject({ code: "protocol" });
  });
  it("adds the modern-protocol Mcp-Method and Mcp-Name headers only for the preferred protocol version", async () => {
    const seen: Record<string, string>[] = [];
    const fakeFetch = (async (_url: string, init?: RequestInit) => { seen.push(init?.headers as Record<string, string>); return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { headers: { "content-type": "application/json" } }); }) as typeof fetch;
    const transport = new HttpMcpTransport({ url: "https://example.test/mcp", fetch: fakeFetch });
    await transport.open(new AbortController().signal, null);
    await transport.exchange(req(1, "tools/call", { name: "read" }), { signal: new AbortController().signal, secret: null, protocol_version: MCP_PREFERRED_PROTOCOL_VERSION });
    expect(seen[0]?.["Mcp-Method"]).toBe("tools/call");
    expect(seen[0]?.["Mcp-Name"]).toBe("read");
    await transport.exchange(req(2, "tools/call", { name: "read" }), noSecretOptions);
    expect(seen[1]?.["Mcp-Method"]).toBeUndefined();
  });
  it("attaches a bearer Authorization header only when a secret is supplied", async () => {
    const seen: Record<string, string>[] = [];
    const fakeFetch = (async (_url: string, init?: RequestInit) => { seen.push(init?.headers as Record<string, string>); return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { headers: { "content-type": "application/json" } }); }) as typeof fetch;
    const transport = new HttpMcpTransport({ url: "https://example.test/mcp", fetch: fakeFetch });
    await transport.open(new AbortController().signal, null);
    await transport.exchange(req(1, "tools/list"), { signal: new AbortController().signal, secret: "shh", protocol_version: null });
    expect(seen[0]?.Authorization).toBe("Bearer shh");
    await transport.exchange(req(2, "tools/list"), noSecretOptions);
    expect(seen[1]?.Authorization).toBeUndefined();
  });
});

describe("HTTP MCP transport subscriptions/listen streaming", () => {
  it("dispatches interleaved notifications and resolves on the terminal correlated response", async () => {
    const events = [
      `data: {"jsonrpc":"2.0","method":"notifications/subscriptions/acknowledged","params":{"_meta":{"io.modelcontextprotocol/subscriptionId":1}}}\n\n`,
      `: keep-alive\n`,
      `data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n`,
      `data: {"jsonrpc":"2.0","id":1,"result":{"resultType":"complete"}}\n\n`,
    ].join("");
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(events)); controller.close(); } });
    const fakeFetch = (async () => new Response(body, { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const transport = new HttpMcpTransport({ url: "https://example.test/mcp", fetch: fakeFetch });
    await transport.open(new AbortController().signal, null);
    const seen: string[] = [];
    transport.onNotification?.((message) => seen.push(message.method));
    const result = await transport.exchange(req(1, "subscriptions/listen", { notifications: { toolsListChanged: true } }), noSecretOptions);
    expect(seen).toEqual(["notifications/subscriptions/acknowledged", "notifications/tools/list_changed"]);
    expect(result).toMatchObject({ result: { resultType: "complete" } });
  });
  it("throws when the listen stream ends without a terminal response", async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n`)); controller.close(); } });
    const fakeFetch = (async () => new Response(body, { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const transport = new HttpMcpTransport({ url: "https://example.test/mcp", fetch: fakeFetch });
    await transport.open(new AbortController().signal, null);
    await expect(transport.exchange(req(1, "subscriptions/listen", { notifications: {} }), noSecretOptions)).rejects.toMatchObject({ code: "closed" });
  });
});

describe("HTTP MCP transport notify()", () => {
  it("resolves and drains the body on a successful notification", async () => {
    let drained = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("ok")); controller.close(); drained = true; } });
    const fakeFetch = (async () => new Response(body)) as typeof fetch;
    const transport = new HttpMcpTransport({ url: "https://example.test/mcp", fetch: fakeFetch });
    await transport.open(new AbortController().signal, null);
    await expect(transport.notify({ jsonrpc: "2.0", method: "notifications/initialized" }, noSecretOptions)).resolves.toBeUndefined();
    expect(drained).toBe(true);
  });
  it("rejects a notification whose response is not ok", async () => {
    const fakeFetch = (async () => new Response("no", { status: 500 })) as typeof fetch;
    const transport = new HttpMcpTransport({ url: "https://example.test/mcp", fetch: fakeFetch });
    await transport.open(new AbortController().signal, null);
    await expect(transport.notify({ jsonrpc: "2.0", method: "notifications/initialized" }, noSecretOptions)).rejects.toMatchObject({ code: "transport" });
  });
});

describe("HTTP MCP transport bounded body handling", () => {
  it("rejects a response body larger than the byte bound", async () => {
    const oversized = new Uint8Array(MCP_MAX_FRAME_BYTES + 1);
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(oversized); controller.close(); } });
    const fakeFetch = (async () => new Response(body, { headers: { "content-type": "application/json" } })) as typeof fetch;
    const transport = new HttpMcpTransport({ url: "https://example.test/mcp", fetch: fakeFetch });
    await transport.open(new AbortController().signal, null);
    await expect(transport.exchange(req(1, "tools/list"), noSecretOptions)).rejects.toMatchObject({ code: "protocol", message: expect.stringContaining("byte bound") });
  });
  it("rejects a body that is not valid UTF-8", async () => {
    const invalid = new Uint8Array([0xff, 0xfe, 0xfd]);
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(invalid); controller.close(); } });
    const fakeFetch = (async () => new Response(body, { headers: { "content-type": "application/json" } })) as typeof fetch;
    const transport = new HttpMcpTransport({ url: "https://example.test/mcp", fetch: fakeFetch });
    await transport.open(new AbortController().signal, null);
    await expect(transport.exchange(req(1, "tools/list"), noSecretOptions)).rejects.toMatchObject({ code: "protocol", message: expect.stringContaining("UTF-8") });
  });
  it("tolerates an oversized body during a fire-and-forget notify drain instead of throwing", async () => {
    const oversized = new Uint8Array(MCP_MAX_FRAME_BYTES + 1);
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(oversized); controller.close(); } });
    const fakeFetch = (async () => new Response(body)) as typeof fetch;
    const transport = new HttpMcpTransport({ url: "https://example.test/mcp", fetch: fakeFetch });
    await transport.open(new AbortController().signal, null);
    await expect(transport.notify({ jsonrpc: "2.0", method: "notifications/initialized" }, noSecretOptions)).resolves.toBeUndefined();
  });
});
