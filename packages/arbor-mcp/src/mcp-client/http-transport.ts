import { MCP_MAX_FRAME_BYTES, MCP_PREFERRED_PROTOCOL_VERSION } from "./contracts.js";
import { JsonRpcClientError, parseBoundedJson, plain, type JsonRpcNotification, type JsonRpcRequest, type JsonRpcTransport } from "./json-rpc.js";

export interface HttpMcpTransportOptions { readonly url: string; readonly fetch?: typeof fetch; }
export class HttpMcpTransport implements JsonRpcTransport {
  private active = false;
  private sessionId: string | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly notificationHandlers = new Set<(message: JsonRpcNotification) => void>();
  constructor(private readonly options: HttpMcpTransportOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    let url: URL; try { url = new URL(options.url); } catch { throw new JsonRpcClientError("transport", "MCP HTTP URL is invalid"); }
    if (url.protocol !== "https:" || url.username || url.password || Buffer.byteLength(options.url) > 2_048) throw new JsonRpcClientError("transport", "MCP HTTP URL must be bounded HTTPS without embedded credentials");
  }
  get connected(): boolean { return this.active; }
  onNotification(handler: (message: JsonRpcNotification) => void): () => void { this.notificationHandlers.add(handler); return () => { this.notificationHandlers.delete(handler); }; }
  async open(signal: AbortSignal, _secret: string | null): Promise<void> { if (signal.aborted) throw new JsonRpcClientError("transport", "MCP HTTP start aborted"); this.active = true; }
  async exchange(message: JsonRpcRequest, options: { readonly signal: AbortSignal; readonly secret: string | null; readonly protocol_version: string | null }): Promise<unknown> {
    const response = await this.post(message, options);
    const assigned = response.headers.get("mcp-session-id");
    if (message.method === "initialize" && assigned !== null) { if (!/^[\x21-\x7e]+$/.test(assigned) || assigned.length > 512) throw new JsonRpcClientError("protocol", "invalid MCP session id"); this.sessionId = assigned; }
    if (!response.ok) throw new JsonRpcClientError("transport", `MCP HTTP request failed with status ${response.status}`);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (message.method === "subscriptions/listen" && contentType.includes("text/event-stream")) return this.consumeListenStream(response, message.id, options.signal);
    const text = await boundedBody(response);
    if (contentType.includes("text/event-stream")) return responseFromSse(text, message.id);
    if (!contentType.includes("application/json")) throw new JsonRpcClientError("protocol", "MCP HTTP response has unsupported content type");
    return parseBoundedJson(text);
  }
  /**
   * `subscriptions/listen`'s response stream stays open and interleaves
   * notifications with an eventual terminal response (graceful server
   * close) -- unlike every other request, it must not wait for the body to
   * finish before dispatching what has already arrived. Notifications are
   * forwarded to registered handlers as each SSE event completes; the
   * terminal JSON-RPC response (matching `id`) resolves the promise.
   */
  private async consumeListenStream(response: Response, id: number, signal: AbortSignal): Promise<unknown> {
    if (response.body === null) throw new JsonRpcClientError("protocol", "MCP subscriptions/listen response has no body");
    const reader = response.body.getReader();
    const onAbort = (): void => { reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      const dataLines: string[] = [];
      let eventBytes = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) throw new JsonRpcClientError("closed", "MCP subscriptions/listen stream ended without a terminal response");
        buffer += decoder.decode(part.value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (line.startsWith(":")) continue;
          if (line === "") {
            if (dataLines.length > 0) {
              const value = parseBoundedJson(dataLines.join("\n"));
              dataLines.length = 0; eventBytes = 0;
              if (!plain(value)) throw new JsonRpcClientError("protocol", "invalid MCP subscriptions/listen event");
              if (Object.prototype.hasOwnProperty.call(value, "id")) { if (value.id === id) return value; continue; }
              if (typeof value.method !== "string" || !value.method) throw new JsonRpcClientError("protocol", "invalid MCP subscriptions/listen notification");
              const notification: JsonRpcNotification = Object.freeze({ jsonrpc: "2.0", method: value.method, ...(value.params === undefined ? {} : { params: value.params as unknown }) });
              for (const handler of this.notificationHandlers) handler(notification);
            }
            continue;
          }
          if (line.startsWith("data:")) {
            const chunk = line.slice(5).trimStart();
            eventBytes += Buffer.byteLength(chunk, "utf8");
            if (eventBytes > MCP_MAX_FRAME_BYTES) throw new JsonRpcClientError("protocol", "MCP subscriptions/listen event exceeds byte bound");
            dataLines.push(chunk);
          }
        }
      }
    } finally { signal.removeEventListener("abort", onAbort); }
  }
  async notify(message: JsonRpcNotification, options: { readonly signal: AbortSignal; readonly secret: string | null; readonly protocol_version: string | null }): Promise<void> {
    const response = await this.post(message, options); if (!response.ok) throw new JsonRpcClientError("transport", `MCP HTTP notification failed with status ${response.status}`); await discardBounded(response);
  }
  async close(secret: string | null, protocolVersion: string | null): Promise<void> {
    const session = this.sessionId; this.active = false; this.sessionId = null;
    if (session === null) return;
    const headers: Record<string, string> = { "Mcp-Session-Id": session };
    if (secret !== null) headers.Authorization = `Bearer ${secret}`;
    if (protocolVersion !== null) headers["MCP-Protocol-Version"] = protocolVersion;
    try { await this.fetchImpl(this.options.url, { method: "DELETE", headers, signal: AbortSignal.timeout(1_000) }); } catch { /* best-effort session cleanup */ }
  }
  private post(message: JsonRpcRequest | JsonRpcNotification, options: { readonly signal: AbortSignal; readonly secret: string | null; readonly protocol_version: string | null }): Promise<Response> {
    if (!this.active) throw new JsonRpcClientError("closed", "MCP HTTP transport is closed");
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    if (options.secret !== null) headers.Authorization = `Bearer ${options.secret}`;
    if (this.sessionId !== null && options.protocol_version !== MCP_PREFERRED_PROTOCOL_VERSION) headers["Mcp-Session-Id"] = this.sessionId;
    if (options.protocol_version !== null) headers["MCP-Protocol-Version"] = options.protocol_version;
    if (options.protocol_version === MCP_PREFERRED_PROTOCOL_VERSION) {
      headers["Mcp-Method"] = message.method;
      const params = plain(message.params) ? message.params : null;
      if (params && typeof params.name === "string") headers["Mcp-Name"] = params.name;
    }
    return this.fetchImpl(this.options.url, { method: "POST", headers, body: JSON.stringify(message), signal: options.signal });
  }
}

async function boundedBody(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > MCP_MAX_FRAME_BYTES) { await reader.cancel(); throw new JsonRpcClientError("protocol", "MCP HTTP response exceeds byte bound"); } chunks.push(part.value); }
  const joined = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(joined); } catch { throw new JsonRpcClientError("protocol", "MCP HTTP response is not valid UTF-8"); }
}
async function discardBounded(response: Response): Promise<void> { if (response.body === null) return; const reader = response.body.getReader(); let size = 0; for (;;) { const part = await reader.read(); if (part.done) return; size += part.value.byteLength; if (size > MCP_MAX_FRAME_BYTES) { await reader.cancel(); return; } } }
function responseFromSse(text: string, id: number): unknown {
  let data: string[] = [];
  for (const line of text.split(/\r?\n/).concat("")) {
    if (line.startsWith(":")) continue;
    if (line === "") { if (data.length > 0) { const value = parseBoundedJson(data.join("\n")); data = []; if (plain(value) && value.id === id) return value; } continue; }
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  throw new JsonRpcClientError("protocol", "MCP SSE response did not contain the correlated response");
}
