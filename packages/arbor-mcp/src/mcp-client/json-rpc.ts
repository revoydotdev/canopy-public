import { MCP_CALL_TIMEOUT_MS, MCP_MAX_CONCURRENT_CALLS, MCP_MAX_FRAME_BYTES, MCP_MAX_METHOD_BYTES, MCP_MAX_TIMEOUT_MS, MCP_PREFERRED_PROTOCOL_VERSION } from "./contracts.js";

export type JsonRpcRequest = { readonly jsonrpc: "2.0"; readonly id: number; readonly method: string; readonly params?: unknown };
export type JsonRpcResponse =
  | { readonly jsonrpc: "2.0"; readonly id: number; readonly result: unknown }
  | { readonly jsonrpc: "2.0"; readonly id: number; readonly error: { readonly code: number; readonly message: string; readonly data?: unknown } };
export type JsonRpcNotification = { readonly jsonrpc: "2.0"; readonly method: string; readonly params?: unknown };

export interface JsonRpcTransport {
  open(signal: AbortSignal, secret: string | null): Promise<void>;
  exchange(message: JsonRpcRequest, options: { readonly signal: AbortSignal; readonly secret: string | null; readonly protocol_version: string | null }): Promise<unknown>;
  notify(message: JsonRpcNotification, options: { readonly signal: AbortSignal; readonly secret: string | null; readonly protocol_version: string | null }): Promise<void>;
  close(secret: string | null, protocol_version: string | null): Promise<void>;
  /** Registers a handler for server-sent notifications observed outside a request/response pair (e.g. on a `subscriptions/listen` stream). Returns an unsubscribe function. Optional: transports (and test doubles) that never observe inbound notifications may omit it, in which case `subscriptions/listen` support is simply unavailable for that transport. */
  onNotification?(handler: (message: JsonRpcNotification) => void): () => void;
  readonly connected: boolean;
}

export type JsonRpcFailureCode = "transport" | "timeout" | "cancelled" | "protocol" | "remote_error" | "closed" | "concurrency";
export class JsonRpcClientError extends Error {
  constructor(readonly code: JsonRpcFailureCode, message: string, readonly remote_code?: number) { super(message); this.name = "JsonRpcClientError"; }
}

export class BoundedJsonRpcClient {
  private nextId = 1;
  private inFlight = 0;
  constructor(private readonly transport: JsonRpcTransport, private readonly maxConcurrent = MCP_MAX_CONCURRENT_CALLS) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > MCP_MAX_CONCURRENT_CALLS) throw new JsonRpcClientError("concurrency", "invalid JSON-RPC concurrency bound");
  }
  get connected(): boolean { return this.transport.connected; }
  async open(signal: AbortSignal, secret: string | null = null): Promise<void> { await this.transport.open(signal, secret); }
  onNotification(handler: (message: JsonRpcNotification) => void): () => void { return this.transport.onNotification?.(handler) ?? ((): void => {}); }
  async request(method: string, params: unknown, options: { readonly timeout_ms: number; readonly signal?: AbortSignal; readonly secret?: string | null; readonly protocol_version?: string | null; readonly client_capabilities?: Readonly<Record<string, unknown>> }): Promise<unknown> {
    assertMethod(method);
    if (!this.connected) throw new JsonRpcClientError("closed", "JSON-RPC transport is not connected");
    if (this.inFlight >= this.maxConcurrent) throw new JsonRpcClientError("concurrency", "JSON-RPC concurrency limit reached");
    assertBoundedTimeout(options.timeout_ms);
    const id = this.nextId++;
    if (!Number.isSafeInteger(id)) throw new JsonRpcClientError("protocol", "JSON-RPC request id exhausted");
    const effectiveParams = options.protocol_version === MCP_PREFERRED_PROTOCOL_VERSION
      ? modernRequestParams(params, options.client_capabilities ?? {})
      : params;
    const request = Object.freeze({ jsonrpc: "2.0" as const, id, method, ...(effectiveParams === undefined ? {} : { params: effectiveParams }) });
    this.inFlight += 1;
    const timeout = new AbortController();
    const external = options.signal;
    const forward = (): void => timeout.abort(external?.reason);
    if (external?.aborted) forward(); else external?.addEventListener("abort", forward, { once: true });
    const timer = setTimeout(() => timeout.abort(new JsonRpcClientError("timeout", `JSON-RPC request timed out: ${method}`)), options.timeout_ms);
    try {
      let raw: unknown;
      try { raw = await this.transport.exchange(request, { signal: timeout.signal, secret: options.secret ?? null, protocol_version: options.protocol_version ?? null }); }
      catch (error) {
        if (external?.aborted) throw new JsonRpcClientError("cancelled", `JSON-RPC request cancelled: ${method}`);
        if (timeout.signal.aborted && !external?.aborted) {
          await this.cancelTimedOutRequest(id, options.secret ?? null, options.protocol_version ?? null);
          throw new JsonRpcClientError("timeout", `JSON-RPC request timed out: ${method}`);
        }
        throw error instanceof JsonRpcClientError ? error : new JsonRpcClientError("transport", boundedMessage(error));
      }
      const response = parseJsonRpcResponse(raw, id);
      if ("error" in response) throw new JsonRpcClientError("remote_error", boundedText(response.error.message, 512), response.error.code);
      return response.result;
    } finally { clearTimeout(timer); external?.removeEventListener("abort", forward); this.inFlight -= 1; }
  }
  async notify(method: string, params: unknown, options: { readonly signal?: AbortSignal; readonly secret?: string | null; readonly protocol_version?: string | null; readonly timeout_ms?: number } = {}): Promise<void> {
    assertMethod(method);
    if (!this.connected) throw new JsonRpcClientError("closed", "JSON-RPC transport is not connected");
    const timeoutMs = options.timeout_ms ?? MCP_CALL_TIMEOUT_MS; assertBoundedTimeout(timeoutMs);
    const message = Object.freeze({ jsonrpc: "2.0" as const, method, ...(params === undefined ? {} : { params }) });
    const controller = new AbortController(); const external = options.signal; const forward = (): void => controller.abort(external?.reason);
    if (external?.aborted) forward(); else external?.addEventListener("abort", forward, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { await this.transport.notify(message, { signal: controller.signal, secret: options.secret ?? null, protocol_version: options.protocol_version ?? null }); }
    catch (error) { if (external?.aborted) throw new JsonRpcClientError("cancelled", `JSON-RPC notification cancelled: ${method}`); if (controller.signal.aborted) throw new JsonRpcClientError("timeout", `JSON-RPC notification timed out: ${method}`); throw error instanceof JsonRpcClientError ? error : new JsonRpcClientError("transport", boundedMessage(error)); }
    finally { clearTimeout(timer); external?.removeEventListener("abort", forward); }
  }
  close(secret: string | null = null, protocolVersion: string | null = null): Promise<void> { return this.transport.close(secret, protocolVersion); }
  private async cancelTimedOutRequest(id: number, secret: string | null, protocolVersion: string | null): Promise<void> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 250);
    try { await this.transport.notify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "timeout" } }, { signal: controller.signal, secret, protocol_version: protocolVersion }); } catch { /* cancellation is best-effort after the typed timeout */ } finally { clearTimeout(timer); }
  }
}

export function parseJsonRpcResponse(raw: unknown, expectedId: number): JsonRpcResponse {
  const value = typeof raw === "string" ? parseBoundedJson(raw) : raw;
  if (!plain(value) || value.jsonrpc !== "2.0" || !Number.isSafeInteger(value.id) || value.id !== expectedId) throw new JsonRpcClientError("protocol", "invalid or mismatched JSON-RPC response envelope");
  const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
  const hasError = Object.prototype.hasOwnProperty.call(value, "error");
  if (hasResult === hasError) throw new JsonRpcClientError("protocol", "JSON-RPC response must contain exactly one of result or error");
  if (hasError) {
    if (!exactKeys(value, ["jsonrpc", "id", "error"]) || !plain(value.error) || !onlyKeys(value.error, ["code", "message", "data"]) || !Number.isSafeInteger(value.error.code) || typeof value.error.message !== "string") throw new JsonRpcClientError("protocol", "invalid JSON-RPC error object");
    return { jsonrpc: "2.0", id: expectedId, error: { code: value.error.code as number, message: boundedText(value.error.message, 512), ...(value.error.data === undefined ? {} : { data: value.error.data }) } };
  }
  if (!exactKeys(value, ["jsonrpc", "id", "result"])) throw new JsonRpcClientError("protocol", "JSON-RPC success response has unknown fields");
  return { jsonrpc: "2.0", id: expectedId, result: value.result };
}

export function parseBoundedJson(text: string): unknown {
  if (Buffer.byteLength(text, "utf8") > MCP_MAX_FRAME_BYTES) throw new JsonRpcClientError("protocol", "JSON-RPC frame exceeds byte bound");
  try { return JSON.parse(text); } catch { throw new JsonRpcClientError("protocol", "malformed JSON-RPC frame"); }
}
export function plain(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
export function boundedJsonBytes(value: unknown, maximum: number): number { try { const encoded = JSON.stringify(value); if (encoded === undefined) return Number.POSITIVE_INFINITY; const bytes = Buffer.byteLength(encoded, "utf8"); return bytes > maximum ? maximum + 1 : bytes; } catch { return Number.POSITIVE_INFINITY; } }
export function assertBoundedTimeout(value: number): void { if (!Number.isSafeInteger(value) || value <= 0 || value > MCP_MAX_TIMEOUT_MS) throw new JsonRpcClientError("protocol", `timeout must be a positive safe integer no greater than ${MCP_MAX_TIMEOUT_MS}`); }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean { return Object.keys(value).length === expected.length && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key)); }
function onlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean { return Object.keys(value).every((key) => expected.includes(key)); }
function boundedText(value: string, bytes: number): string { return Buffer.byteLength(value, "utf8") <= bytes ? value : Buffer.from(value).subarray(0, bytes).toString("utf8").replace(/\uFFFD$/, ""); }
function boundedMessage(error: unknown): string { return boundedText(error instanceof Error ? error.message : "JSON-RPC transport failed", 512); }
function assertMethod(value: string): void { if (!value.trim() || Buffer.byteLength(value, "utf8") > MCP_MAX_METHOD_BYTES) throw new JsonRpcClientError("protocol", "JSON-RPC method is empty or oversized"); }
function modernRequestParams(params: unknown, clientCapabilities: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const input = plain(params) ? params : {};
  const priorMeta = plain(input._meta) ? input._meta : {};
  return Object.freeze({
    ...input,
    _meta: Object.freeze({
      ...priorMeta,
      "io.modelcontextprotocol/protocolVersion": MCP_PREFERRED_PROTOCOL_VERSION,
      "io.modelcontextprotocol/clientInfo": Object.freeze({ name: "revoy2", version: "0.2.0" }),
      "io.modelcontextprotocol/clientCapabilities": clientCapabilities,
    }),
  });
}
