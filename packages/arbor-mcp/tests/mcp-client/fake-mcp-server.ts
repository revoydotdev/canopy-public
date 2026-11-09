import type { JsonRpcNotification, JsonRpcRequest, JsonRpcTransport } from "../../src/mcp-client/json-rpc.js";
import type { McpPromptDescription, McpResourceDescription, McpResourceTemplateDescription, McpToolDescription } from "../../src/mcp-client/contracts.js";

export class FakeMcpServer implements JsonRpcTransport {
  connected = false;
  initialized = false;
  readonly methods: string[] = [];
  tools: McpToolDescription[] = [{ name: "read", description: "Read a fixture", inputSchema: { type: "object" } }];
  resources: McpResourceDescription[] = [{ uri: "file:///fixture.txt", name: "fixture.txt", description: "A fixture resource", mimeType: "text/plain" }];
  resourceTemplates: McpResourceTemplateDescription[] = [{ uriTemplate: "file:///users/{user}.txt", name: "user file", description: "A per-user fixture", mimeType: "text/plain" }];
  prompts: McpPromptDescription[] = [{ name: "greet", description: "Greets someone", arguments: [{ name: "who", description: "who to greet", required: true }] }];
  callResult: unknown = { content: [{ type: "text", text: "fixture result" }] };
  resourceReadResult: unknown = { contents: [{ uri: "file:///fixture.txt", mimeType: "text/plain", text: "fixture contents" }] };
  promptGetResult: unknown = { description: "Greets someone", messages: [{ role: "user", content: { type: "text", text: "hello" } }] };
  capabilitiesResult: Record<string, unknown> = { tools: {} };
  /** When set, the first `tools/call` (or configured method) returns this InputRequiredResult once, then falls through to the normal complete result on retry. */
  pendingInputRequired: { readonly method: string; readonly result: Record<string, unknown> } | null = null;
  private inputRequiredConsumed = false;
  delayMs = 0;
  malformed = false;
  failOpen = false;
  seenSecrets: string[] = [];
  closeSecrets: Array<string | null> = [];
  readonly requests: JsonRpcRequest[] = [];
  private readonly notificationHandlers = new Set<(message: JsonRpcNotification) => void>();
  constructor(readonly protocolVersion = "2025-06-18") {}
  async open(_signal?: AbortSignal, secret?: string | null): Promise<void> { if (this.failOpen) throw new Error("server unavailable"); if (secret) this.seenSecrets.push(secret); this.connected = true; }
  onNotification(handler: (message: JsonRpcNotification) => void): () => void { this.notificationHandlers.add(handler); return () => { this.notificationHandlers.delete(handler); }; }
  async exchange(message: JsonRpcRequest, options: { readonly signal: AbortSignal; readonly secret: string | null }): Promise<unknown> {
    this.methods.push(message.method); this.requests.push(message); if (options.secret !== null) this.seenSecrets.push(options.secret);
    if (this.malformed) return { jsonrpc: "2.0", id: "wrong", result: {} };
    if (this.delayMs > 0) await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, this.delayMs); options.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true }); });
    if (this.pendingInputRequired !== null && message.method === this.pendingInputRequired.method && !this.inputRequiredConsumed) {
      this.inputRequiredConsumed = true;
      return response(message.id, this.pendingInputRequired.result);
    }
    if (this.protocolVersion === "2026-07-28") {
      if (message.method === "server/discover") return response(message.id, { resultType: "complete", supportedVersions: [this.protocolVersion], capabilities: this.capabilitiesResult, _meta: { "io.modelcontextprotocol/serverInfo": { name: "fake", version: "1" } } });
      if (message.method === "tools/list") return response(message.id, { resultType: "complete", tools: this.tools });
      if (message.method === "tools/call") return response(message.id, { resultType: "complete", ...(this.callResult as Record<string, unknown>) });
      if (message.method === "resources/list") return response(message.id, { resultType: "complete", resources: this.resources });
      if (message.method === "resources/templates/list") return response(message.id, { resultType: "complete", resourceTemplates: this.resourceTemplates });
      if (message.method === "resources/read") return response(message.id, { resultType: "complete", ...(this.resourceReadResult as Record<string, unknown>) });
      if (message.method === "prompts/list") return response(message.id, { resultType: "complete", prompts: this.prompts });
      if (message.method === "prompts/get") return response(message.id, { resultType: "complete", ...(this.promptGetResult as Record<string, unknown>) });
      if (message.method === "subscriptions/listen") return this.handleListen(message, options.signal);
      return error(message.id, -32601, "unknown method");
    }
    if (message.method === "server/discover") return error(message.id, -32601, "unknown method");
    if (message.method === "initialize") return response(message.id, { protocolVersion: this.protocolVersion, capabilities: this.capabilitiesResult, serverInfo: { name: "fake", version: "1" } });
    if (!this.initialized) return error(message.id, -32002, "not initialized");
    if (message.method === "tools/list") return response(message.id, { tools: this.tools });
    if (message.method === "tools/call") return response(message.id, this.callResult);
    if (message.method === "resources/list") return response(message.id, { resources: this.resources });
    if (message.method === "resources/templates/list") return response(message.id, { resourceTemplates: this.resourceTemplates });
    if (message.method === "resources/read") return response(message.id, this.resourceReadResult);
    if (message.method === "prompts/list") return response(message.id, { prompts: this.prompts });
    if (message.method === "prompts/get") return response(message.id, this.promptGetResult);
    return error(message.id, -32601, "unknown method");
  }
  /** Simulates a long-lived `subscriptions/listen` request: never resolves until the caller aborts, mirroring a real server holding the stream open. */
  private handleListen(_message: JsonRpcRequest, signal: AbortSignal): Promise<unknown> {
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("listen aborted")), { once: true });
    });
  }
  /** Test hook: pushes a notification straight to every registered handler, as if it arrived on the open listen stream. */
  emitNotification(method: string, params?: Record<string, unknown>): void {
    for (const handler of this.notificationHandlers) handler(Object.freeze({ jsonrpc: "2.0" as const, method, ...(params === undefined ? {} : { params }) }));
  }
  async notify(message: JsonRpcNotification): Promise<void> { this.methods.push(message.method); if (message.method === "notifications/initialized") this.initialized = true; }
  async close(secret: string | null = null): Promise<void> { this.closeSecrets.push(secret); this.connected = false; }
}
function response(id: number, result: unknown): unknown { return { jsonrpc: "2.0", id, result }; }
function error(id: number, code: number, message: string): unknown { return { jsonrpc: "2.0", id, error: { code, message } }; }
