import { MCP_CALL_TIMEOUT_MS, MCP_CONNECT_TIMEOUT_MS, MCP_LISTEN_TIMEOUT_MS, MCP_MAX_CONTENT_PARTS, MCP_MAX_DESCRIPTION_BYTES, MCP_MAX_ELICIT_MESSAGE_BYTES, MCP_MAX_ELICIT_ROUNDTRIPS, MCP_MAX_FRAME_BYTES, MCP_MAX_INPUT_REQUESTS, MCP_MAX_PROMPT_ARGUMENTS, MCP_MAX_PROMPT_NAME_BYTES, MCP_MAX_PROMPTS_PER_SERVER, MCP_MAX_REQUEST_STATE_BYTES, MCP_MAX_RESOURCE_URI_BYTES, MCP_MAX_RESOURCES_PER_SERVER, MCP_MAX_SCHEMA_BYTES, MCP_MAX_TOOL_NAME_BYTES, MCP_MAX_TOOLS_PER_SERVER, MCP_PREFERRED_PROTOCOL_VERSION, MCP_SUPPORTED_PROTOCOL_VERSIONS, type McpCallResult, type McpClientInspection, type McpElicitationPort, type McpPromptDescription, type McpPromptMessage, type McpPromptResult, type McpResourceContent, type McpResourceDescription, type McpResourceTemplateDescription, type McpSubscriptionFilter, type McpToolDescription, type McpSupportedProtocolVersion } from "./contracts.js";
import { BoundedJsonRpcClient, JsonRpcClientError, assertBoundedTimeout, boundedJsonBytes, plain, type JsonRpcNotification, type JsonRpcTransport } from "./json-rpc.js";
import { redactNativeText } from "@arbor/harness";

export interface McpClientOptions {
  readonly connect_timeout_ms?: number;
  readonly call_timeout_ms?: number;
  readonly max_tools?: number;
  /** Identifies this connection to a configured `McpElicitationPort`; cosmetic only, never sent over the wire. */
  readonly server_id?: string;
  /** Opt-in per ADR-098: requires the server to declare `capabilities.resources` at connect time. */
  readonly resources?: boolean;
  /** Opt-in per ADR-098: requires the server to declare `capabilities.prompts` at connect time. */
  readonly prompts?: boolean;
  /** Resolves `elicitation/create` MRTR input requests. Declaring this port also declares the `elicitation` client capability during discovery/initialize; omitting it means this client never advertises elicitation support, so a spec-conformant server will not send elicitation requests at all. */
  readonly elicitation?: McpElicitationPort;
}

export class McpClient {
  private state: McpClientInspection["state"] = "new";
  private protocolVersion: string | null = null;
  private serverInfo: Readonly<Record<string, unknown>> | null = null;
  private capabilities: Readonly<Record<string, unknown>> | null = null;
  private diagnostic: string | null = null;
  private readonly rpc: BoundedJsonRpcClient;
  private readonly serverId: string;
  private readonly resourcesRequested: boolean;
  private readonly promptsRequested: boolean;
  private readonly elicitation: McpElicitationPort | null;
  private readonly clientCapabilities: Readonly<Record<string, unknown>>;
  constructor(transport: JsonRpcTransport, private readonly options: McpClientOptions = {}) {
    if (options.connect_timeout_ms !== undefined) assertBoundedTimeout(options.connect_timeout_ms);
    if (options.call_timeout_ms !== undefined) assertBoundedTimeout(options.call_timeout_ms);
    if (options.max_tools !== undefined && (!Number.isSafeInteger(options.max_tools) || options.max_tools <= 0 || options.max_tools > MCP_MAX_TOOLS_PER_SERVER)) throw new JsonRpcClientError("protocol", `max_tools must be between 1 and ${MCP_MAX_TOOLS_PER_SERVER}`);
    this.rpc = new BoundedJsonRpcClient(transport);
    this.serverId = options.server_id ?? "unknown";
    this.resourcesRequested = options.resources === true;
    this.promptsRequested = options.prompts === true;
    this.elicitation = options.elicitation ?? null;
    this.clientCapabilities = Object.freeze(this.elicitation === null ? {} : { elicitation: Object.freeze({ form: Object.freeze({}), url: Object.freeze({}) }) });
  }
  get connected(): boolean { return this.state === "connected" && this.rpc.connected; }
  inspect(): McpClientInspection { return Object.freeze({ state: this.state, protocol_version: this.protocolVersion, server_info: this.serverInfo, capabilities: this.capabilities, diagnostic: this.diagnostic }); }
  async connect(secret: string | null = null, signal: AbortSignal = new AbortController().signal): Promise<readonly McpToolDescription[]> {
    if (this.connected) return this.listTools(secret, signal);
    if (this.state === "connecting") throw new JsonRpcClientError("protocol", "MCP client connection is already in progress");
    this.state = "connecting"; this.diagnostic = null;
    try {
      await withTimeout(this.options.connect_timeout_ms ?? MCP_CONNECT_TIMEOUT_MS, signal, (boundedSignal) => this.rpc.open(boundedSignal, secret));
      try {
        await this.connectModern(secret, signal);
      } catch (error) {
        if (!isLegacyProbeFailure(error)) throw error;
        await this.connectLegacy(secret, signal);
      }
      this.state = "connected";
      return await this.listTools(secret, signal);
    } catch (error) {
      this.state = "failed"; this.diagnostic = redactNativeText(boundedError(error), { secrets: secret === null ? [] : [secret] }); await this.rpc.close(secret, this.protocolVersion).catch(() => {}); throw error;
    }
  }
  async listTools(secret: string | null = null, signal: AbortSignal = new AbortController().signal): Promise<readonly McpToolDescription[]> {
    this.assertConnected();
    return this.listPaginated("tools/list", "tools", this.options.max_tools ?? MCP_MAX_TOOLS_PER_SERVER, secret, signal, validateTool);
  }
  async callTool(name: string, args: Readonly<Record<string, unknown>>, options: { readonly timeout_ms?: number; readonly signal?: AbortSignal; readonly secret?: string | null } = {}): Promise<McpCallResult> {
    this.assertConnected();
    const secret = options.secret ?? null;
    const result = await this.requestWithInputHandling("tools/call", { name, arguments: args }, { timeout_ms: options.timeout_ms ?? this.options.call_timeout_ms ?? MCP_CALL_TIMEOUT_MS, signal: options.signal, secret });
    if (boundedJsonBytes(result, MCP_MAX_FRAME_BYTES) > MCP_MAX_FRAME_BYTES || !Array.isArray(result.content) || result.content.length > MCP_MAX_CONTENT_PARTS || (result.isError !== undefined && typeof result.isError !== "boolean")) throw new JsonRpcClientError("protocol", "invalid or oversized MCP tools/call result");
    return Object.freeze({ content: Object.freeze([...result.content]), isError: result.isError === true });
  }
  /** ADR-098: gated by `McpClientOptions.resources`; throws if the server has not declared the `resources` capability at connect time. */
  async listResources(secret: string | null = null, signal: AbortSignal = new AbortController().signal): Promise<readonly McpResourceDescription[]> {
    this.assertConnected();
    this.assertCapabilityEnabled(this.resourcesRequested, "resources");
    return this.listPaginated("resources/list", "resources", MCP_MAX_RESOURCES_PER_SERVER, secret, signal, validateResource);
  }
  /** Resource templates use the same explicit resources opt-in and bounded pagination as concrete resources. */
  async listResourceTemplates(secret: string | null = null, signal: AbortSignal = new AbortController().signal): Promise<readonly McpResourceTemplateDescription[]> {
    this.assertConnected();
    this.assertCapabilityEnabled(this.resourcesRequested, "resources");
    return this.listPaginated("resources/templates/list", "resourceTemplates", MCP_MAX_RESOURCES_PER_SERVER, secret, signal, validateResourceTemplate);
  }
  async readResource(uri: string, options: { readonly timeout_ms?: number; readonly signal?: AbortSignal; readonly secret?: string | null } = {}): Promise<readonly McpResourceContent[]> {
    this.assertConnected();
    this.assertCapabilityEnabled(this.resourcesRequested, "resources");
    if (typeof uri !== "string" || !uri || Buffer.byteLength(uri, "utf8") > MCP_MAX_RESOURCE_URI_BYTES) throw new JsonRpcClientError("protocol", "invalid MCP resource uri");
    const secret = options.secret ?? null;
    const result = await this.requestWithInputHandling("resources/read", { uri }, { timeout_ms: options.timeout_ms ?? this.options.call_timeout_ms ?? MCP_CALL_TIMEOUT_MS, signal: options.signal, secret });
    if (boundedJsonBytes(result, MCP_MAX_FRAME_BYTES) > MCP_MAX_FRAME_BYTES || !Array.isArray(result.contents) || result.contents.length === 0 || result.contents.length > MCP_MAX_CONTENT_PARTS) throw new JsonRpcClientError("protocol", "invalid or oversized MCP resources/read result");
    return Object.freeze(result.contents.map((raw) => validateResourceContent(raw, secret)));
  }
  /** ADR-098: gated by `McpClientOptions.prompts`; throws if the server has not declared the `prompts` capability at connect time. */
  async listPrompts(secret: string | null = null, signal: AbortSignal = new AbortController().signal): Promise<readonly McpPromptDescription[]> {
    this.assertConnected();
    this.assertCapabilityEnabled(this.promptsRequested, "prompts");
    return this.listPaginated("prompts/list", "prompts", MCP_MAX_PROMPTS_PER_SERVER, secret, signal, validatePrompt);
  }
  async getPrompt(name: string, args: Readonly<Record<string, unknown>> = {}, options: { readonly timeout_ms?: number; readonly signal?: AbortSignal; readonly secret?: string | null } = {}): Promise<McpPromptResult> {
    this.assertConnected();
    this.assertCapabilityEnabled(this.promptsRequested, "prompts");
    if (typeof name !== "string" || !name || Buffer.byteLength(name, "utf8") > MCP_MAX_PROMPT_NAME_BYTES) throw new JsonRpcClientError("protocol", "invalid MCP prompt name");
    const secret = options.secret ?? null;
    const result = await this.requestWithInputHandling("prompts/get", { name, arguments: args }, { timeout_ms: options.timeout_ms ?? this.options.call_timeout_ms ?? MCP_CALL_TIMEOUT_MS, signal: options.signal, secret });
    if (boundedJsonBytes(result, MCP_MAX_FRAME_BYTES) > MCP_MAX_FRAME_BYTES || !Array.isArray(result.messages) || result.messages.length > MCP_MAX_CONTENT_PARTS || (result.description !== undefined && typeof result.description !== "string")) throw new JsonRpcClientError("protocol", "invalid or oversized MCP prompts/get result");
    return Object.freeze({ description: typeof result.description === "string" ? redactNativeText(boundedUtf8(result.description, MCP_MAX_DESCRIPTION_BYTES), { secrets: secret === null ? [] : [secret] }) : null, messages: Object.freeze(result.messages.map((raw) => validatePromptMessage(raw, secret))) });
  }
  /**
   * Opens a `subscriptions/listen` long-lived notification stream (ADR-098
   * decision 4) and keeps it re-opening until `options.signal` aborts --
   * the connection-lifetime concern the ADR's Consequences section flags.
   * Each server-sent notification is forwarded to `onNotification`
   * unfiltered; the caller (McpConnector) is responsible for reacting to
   * the specific `notifications/*` methods it cares about.
   */
  subscribe(filter: McpSubscriptionFilter, onNotification: (message: JsonRpcNotification) => void, options: { readonly signal: AbortSignal; readonly secret?: string | null }): { close(): void; readonly done: Promise<void> } {
    this.assertConnected();
    if (this.protocolVersion !== MCP_PREFERRED_PROTOCOL_VERSION) throw new JsonRpcClientError("protocol", "MCP subscriptions/listen requires protocol revision 2026-07-28");
    const controller = new AbortController();
    const forward = (): void => controller.abort(options.signal.reason);
    if (options.signal.aborted) forward(); else options.signal.addEventListener("abort", forward, { once: true });
    const unregister = this.rpc.onNotification(onNotification);
    let stopped = false;
    const run = async (): Promise<void> => {
      try {
        while (!stopped && !controller.signal.aborted) {
          try {
            await this.rpc.request("subscriptions/listen", { notifications: filter }, { timeout_ms: MCP_LISTEN_TIMEOUT_MS, signal: controller.signal, secret: options.secret ?? null, protocol_version: this.protocolVersion, client_capabilities: this.clientCapabilities });
          } catch (error) {
            if (stopped || controller.signal.aborted) return;
            // Only the expected idle-timeout boundary (MCP_LISTEN_TIMEOUT_MS) reopens the
            // stream -- the ADR's reconnect story. Any other failure (the server rejected
            // subscriptions/listen outright, a transport error, a protocol violation) is
            // terminal for this subscription rather than a busy retry loop.
            if (!(error instanceof JsonRpcClientError && error.code === "timeout")) return;
          }
        }
      } finally { unregister(); options.signal.removeEventListener("abort", forward); }
    };
    return { close: (): void => { stopped = true; controller.abort(); }, done: run() };
  }
  async close(secret: string | null = null): Promise<void> { await this.rpc.close(secret, this.protocolVersion); this.state = "closed"; }
  private assertConnected(): void { if (!this.connected) throw new JsonRpcClientError("closed", "MCP operation requires completed protocol negotiation"); }
  private assertCapabilityEnabled(requested: boolean, name: string): void { if (!requested) throw new JsonRpcClientError("protocol", `MCP ${name} capability was not requested for this server`); }
  private async listPaginated<T>(method: string, key: string, maximum: number, secret: string | null, signal: AbortSignal, validate: (raw: unknown, secret: string | null) => T): Promise<readonly T[]> {
    const items: T[] = []; let cursor: string | undefined; const cursors = new Set<string>();
    do {
      const result = await this.rpc.request(method, cursor === undefined ? {} : { cursor }, { timeout_ms: this.options.call_timeout_ms ?? MCP_CALL_TIMEOUT_MS, signal, secret, protocol_version: this.protocolVersion, client_capabilities: this.clientCapabilities });
      if (!plain(result) || !Array.isArray(result[key]) || (this.protocolVersion === MCP_PREFERRED_PROTOCOL_VERSION && result.resultType !== "complete")) throw new JsonRpcClientError("protocol", `invalid MCP ${method} result`);
      for (const raw of result[key] as unknown[]) { if (items.length >= maximum) throw new JsonRpcClientError("protocol", `MCP ${key} count exceeds configured bound`); items.push(validate(raw, secret)); }
      if (result.nextCursor === undefined) cursor = undefined;
      else { if (typeof result.nextCursor !== "string" || !result.nextCursor || Buffer.byteLength(result.nextCursor) > 512 || cursors.has(result.nextCursor)) throw new JsonRpcClientError("protocol", `invalid MCP ${method} cursor`); cursor = result.nextCursor; cursors.add(cursor); }
    } while (cursor !== undefined);
    return Object.freeze(items);
  }
  /**
   * Issues a request that supports MRTR (`tools/call`, `resources/read`,
   * `prompts/get`) and resolves any `InputRequiredResult` it gets back
   * (ADR-098 decision 2) through the configured `McpElicitationPort`,
   * retrying with `inputResponses`/`requestState` until the server returns
   * a complete result or the round-trip bound is exceeded.
   */
  private async requestWithInputHandling(method: string, initialParams: Readonly<Record<string, unknown>>, options: { readonly timeout_ms: number; readonly signal?: AbortSignal; readonly secret: string | null }): Promise<Record<string, unknown>> {
    let params: Record<string, unknown> = initialParams;
    for (let round = 0; round < MCP_MAX_ELICIT_ROUNDTRIPS; round++) {
      const result = await this.rpc.request(method, params, { timeout_ms: options.timeout_ms, signal: options.signal, secret: options.secret, protocol_version: this.protocolVersion, client_capabilities: this.clientCapabilities });
      if (!plain(result)) throw new JsonRpcClientError("protocol", `invalid MCP ${method} result`);
      if (result.resultType === "input_required") {
        if (this.elicitation === null) throw new JsonRpcClientError("protocol", `MCP server requested input on ${method} but no elicitation port is configured`);
        const resolved = await this.resolveInputRequests(result, options.secret);
        params = { ...initialParams, inputResponses: resolved.inputResponses, ...(resolved.requestState === undefined ? {} : { requestState: resolved.requestState }) };
        continue;
      }
      if (this.protocolVersion === MCP_PREFERRED_PROTOCOL_VERSION && result.resultType !== "complete") throw new JsonRpcClientError("protocol", `invalid MCP ${method} result`);
      return result;
    }
    throw new JsonRpcClientError("protocol", `MCP ${method} exceeded the input round-trip bound`);
  }
  private async resolveInputRequests(result: Record<string, unknown>, secret: string | null): Promise<{ readonly inputResponses: Readonly<Record<string, unknown>>; readonly requestState?: string }> {
    const requestState = typeof result.requestState === "string" && Buffer.byteLength(result.requestState, "utf8") <= MCP_MAX_REQUEST_STATE_BYTES ? result.requestState : undefined;
    if (result.requestState !== undefined && requestState === undefined) throw new JsonRpcClientError("protocol", "invalid or oversized MCP requestState");
    if (result.inputRequests === undefined) {
      if (requestState === undefined) throw new JsonRpcClientError("protocol", "MCP InputRequiredResult carries neither inputRequests nor requestState");
      return { inputResponses: Object.freeze({}), requestState };
    }
    if (!plain(result.inputRequests)) throw new JsonRpcClientError("protocol", "invalid MCP inputRequests");
    const keys = Object.keys(result.inputRequests);
    if (keys.length === 0 || keys.length > MCP_MAX_INPUT_REQUESTS) throw new JsonRpcClientError("protocol", "MCP inputRequests count is invalid");
    const responses: Record<string, unknown> = {};
    for (const key of keys) {
      const entry = (result.inputRequests as Record<string, unknown>)[key];
      if (!plain(entry) || typeof entry.method !== "string") throw new JsonRpcClientError("protocol", "invalid MCP input request entry");
      if (entry.method !== "elicitation/create") throw new JsonRpcClientError("protocol", `MCP server requested an unsupported MRTR method: ${entry.method}`);
      const params = plain(entry.params) ? entry.params : {};
      if (typeof params.message !== "string" || !params.message || Buffer.byteLength(params.message, "utf8") > MCP_MAX_ELICIT_MESSAGE_BYTES) throw new JsonRpcClientError("protocol", "invalid MCP elicitation message");
      const message = redactNativeText(params.message, { secrets: secret === null ? [] : [secret] });
      const mode = params.mode === "url" ? "url" as const : "form" as const;
      if (mode === "url" && (typeof params.url !== "string" || !params.url)) throw new JsonRpcClientError("protocol", "MCP url-mode elicitation is missing url");
      const request = mode === "url"
        ? { mode, message, url: params.url as string }
        : { mode, message, requestedSchema: plain(params.requestedSchema) ? params.requestedSchema : undefined };
      const answer = await this.elicitation!.elicit(request, { server_id: this.serverId });
      if (answer.action !== "accept" && answer.action !== "decline" && answer.action !== "cancel") throw new Error("McpElicitationPort returned an invalid action");
      responses[key] = answer.action === "accept" ? Object.freeze({ action: "accept", content: answer.content ?? {} }) : Object.freeze({ action: answer.action });
    }
    return { inputResponses: Object.freeze(responses), requestState };
  }
  private async connectModern(secret: string | null, signal: AbortSignal): Promise<void> {
    let result: unknown;
    try {
      result = await this.rpc.request("server/discover", {}, { timeout_ms: this.options.connect_timeout_ms ?? MCP_CONNECT_TIMEOUT_MS, signal, secret, protocol_version: MCP_PREFERRED_PROTOCOL_VERSION, client_capabilities: this.clientCapabilities });
    } catch (error) {
      if (error instanceof JsonRpcClientError && error.code === "remote_error" && error.remote_code === -32601) throw new LegacyProbeError();
      throw error;
    }
    if (!plain(result) || result.resultType !== "complete" || !Array.isArray(result.supportedVersions) || !plain(result.capabilities)) throw new LegacyProbeError();
    const offered = result.supportedVersions.filter((value): value is string => typeof value === "string");
    if (offered.length !== result.supportedVersions.length || offered.length === 0) throw new LegacyProbeError();
    if (!offered.includes(MCP_PREFERRED_PROTOCOL_VERSION)) throw new JsonRpcClientError("protocol", `unsupported MCP protocol version; server offered ${offered.join(", ")}`);
    if (!plain(result.capabilities.tools)) throw new JsonRpcClientError("protocol", "MCP server did not declare tools capability");
    if (this.resourcesRequested && !plain(result.capabilities.resources)) throw new JsonRpcClientError("protocol", "MCP server did not declare resources capability");
    if (this.promptsRequested && !plain(result.capabilities.prompts)) throw new JsonRpcClientError("protocol", "MCP server did not declare prompts capability");
    const metadata = plain(result._meta) ? result._meta : {};
    const info = metadata["io.modelcontextprotocol/serverInfo"];
    this.protocolVersion = MCP_PREFERRED_PROTOCOL_VERSION;
    this.capabilities = projectCapabilities(result.capabilities);
    this.serverInfo = plain(info) ? projectServerInfo(info, secret) : null;
  }
  private async connectLegacy(secret: string | null, signal: AbortSignal): Promise<void> {
    const result = await this.rpc.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "revoy2", version: "0.2.0" } }, { timeout_ms: this.options.connect_timeout_ms ?? MCP_CONNECT_TIMEOUT_MS, signal, secret });
    if (!plain(result) || !isSupportedLegacyVersion(result.protocolVersion) || !plain(result.capabilities) || !plain(result.serverInfo)) throw new JsonRpcClientError("protocol", `invalid or unsupported MCP initialize result${plain(result) && typeof result.protocolVersion === "string" ? `: ${result.protocolVersion}` : ""}`);
    if (!plain(result.capabilities.tools)) throw new JsonRpcClientError("protocol", "MCP server did not declare tools capability");
    if (this.resourcesRequested && !plain(result.capabilities.resources)) throw new JsonRpcClientError("protocol", "MCP server did not declare resources capability");
    if (this.promptsRequested && !plain(result.capabilities.prompts)) throw new JsonRpcClientError("protocol", "MCP server did not declare prompts capability");
    this.protocolVersion = result.protocolVersion;
    this.capabilities = projectCapabilities(result.capabilities);
    this.serverInfo = projectServerInfo(result.serverInfo, secret);
    await this.rpc.notify("notifications/initialized", undefined, { signal, secret, protocol_version: this.protocolVersion, timeout_ms: this.options.connect_timeout_ms ?? MCP_CONNECT_TIMEOUT_MS });
  }
}

class LegacyProbeError extends Error {}
function isLegacyProbeFailure(error: unknown): boolean { return error instanceof LegacyProbeError; }
function isSupportedLegacyVersion(value: unknown): value is McpSupportedProtocolVersion {
  return typeof value === "string" && value !== MCP_PREFERRED_PROTOCOL_VERSION && (MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(value);
}

function validateTool(value: unknown, secret: string | null): McpToolDescription {
  if (!plain(value) || typeof value.name !== "string" || !value.name || Buffer.byteLength(value.name) > MCP_MAX_TOOL_NAME_BYTES || !/^[A-Za-z0-9_.:-]+$/.test(value.name)) throw new JsonRpcClientError("protocol", "invalid MCP tool name");
  if (value.description !== undefined && typeof value.description !== "string") throw new JsonRpcClientError("protocol", "invalid MCP tool description");
  const description = redactNativeText(boundedUtf8(value.description ?? "External MCP tool", MCP_MAX_DESCRIPTION_BYTES), { secrets: secret === null ? [] : [secret] });
  const schema = value.inputSchema === undefined ? { type: "object", additionalProperties: true } : value.inputSchema;
  if (!plain(schema) || !isJsonValue(schema) || boundedJsonBytes(schema, MCP_MAX_SCHEMA_BYTES) > MCP_MAX_SCHEMA_BYTES) throw new JsonRpcClientError("protocol", "invalid or oversized MCP tool input schema");
  return Object.freeze({ name: value.name, description, inputSchema: redactJsonObject(schema, secret) });
}
function projectServerInfo(value: Record<string, unknown>, secret: string | null): Readonly<Record<string, unknown>> {
  if (typeof value.name !== "string" || !value.name.trim() || typeof value.version !== "string" || !value.version.trim() || (value.title !== undefined && typeof value.title !== "string")) throw new JsonRpcClientError("protocol", "invalid MCP serverInfo");
  const output: Record<string, unknown> = {};
  for (const key of ["name", "title", "version"]) if (typeof value[key] === "string") output[key] = redactNativeText(boundedUtf8(value[key] as string, 512), { secrets: secret === null ? [] : [secret] });
  return Object.freeze(output);
}
function validateResource(value: unknown, secret: string | null): McpResourceDescription {
  if (!plain(value) || typeof value.uri !== "string" || !value.uri || Buffer.byteLength(value.uri, "utf8") > MCP_MAX_RESOURCE_URI_BYTES) throw new JsonRpcClientError("protocol", "invalid MCP resource uri");
  if (typeof value.name !== "string" || !value.name) throw new JsonRpcClientError("protocol", "invalid MCP resource name");
  if (value.description !== undefined && typeof value.description !== "string") throw new JsonRpcClientError("protocol", "invalid MCP resource description");
  if (value.mimeType !== undefined && typeof value.mimeType !== "string") throw new JsonRpcClientError("protocol", "invalid MCP resource mimeType");
  const redact = (text: string): string => redactNativeText(boundedUtf8(text, MCP_MAX_DESCRIPTION_BYTES), { secrets: secret === null ? [] : [secret] });
  return Object.freeze({ uri: value.uri, name: redact(value.name), description: redact(value.description ?? ""), mimeType: typeof value.mimeType === "string" ? value.mimeType : null });
}
function validateResourceTemplate(value: unknown, secret: string | null): McpResourceTemplateDescription {
  if (!plain(value) || typeof value.uriTemplate !== "string" || !value.uriTemplate || Buffer.byteLength(value.uriTemplate, "utf8") > MCP_MAX_RESOURCE_URI_BYTES) throw new JsonRpcClientError("protocol", "invalid MCP resource template uri");
  if (typeof value.name !== "string" || !value.name) throw new JsonRpcClientError("protocol", "invalid MCP resource template name");
  if (value.description !== undefined && typeof value.description !== "string") throw new JsonRpcClientError("protocol", "invalid MCP resource template description");
  if (value.mimeType !== undefined && typeof value.mimeType !== "string") throw new JsonRpcClientError("protocol", "invalid MCP resource template mimeType");
  const redact = (text: string): string => redactNativeText(boundedUtf8(text, MCP_MAX_DESCRIPTION_BYTES), { secrets: secret === null ? [] : [secret] });
  return Object.freeze({ uriTemplate: value.uriTemplate, name: redact(value.name), description: redact(value.description ?? ""), mimeType: typeof value.mimeType === "string" ? redact(value.mimeType) : null });
}
function validateResourceContent(value: unknown, secret: string | null): McpResourceContent {
  if (!plain(value) || typeof value.uri !== "string" || !value.uri || Buffer.byteLength(value.uri, "utf8") > MCP_MAX_RESOURCE_URI_BYTES) throw new JsonRpcClientError("protocol", "invalid MCP resource content uri");
  if (value.mimeType !== undefined && typeof value.mimeType !== "string") throw new JsonRpcClientError("protocol", "invalid MCP resource content mimeType");
  const hasText = value.text !== undefined; const hasBlob = value.blob !== undefined;
  if (hasText === hasBlob) throw new JsonRpcClientError("protocol", "MCP resource content must carry exactly one of text or blob");
  if (hasText && (typeof value.text !== "string" || Buffer.byteLength(value.text, "utf8") > MCP_MAX_DESCRIPTION_BYTES * 16)) throw new JsonRpcClientError("protocol", "invalid or oversized MCP resource text content");
  if (hasBlob && (typeof value.blob !== "string" || Buffer.byteLength(value.blob, "utf8") > MCP_MAX_DESCRIPTION_BYTES * 16)) throw new JsonRpcClientError("protocol", "invalid or oversized MCP resource blob content");
  const redactText = (text: string): string => redactNativeText(text, { secrets: secret === null ? [] : [secret] });
  return Object.freeze({ uri: value.uri, mimeType: typeof value.mimeType === "string" ? value.mimeType : null, text: hasText ? redactText(value.text as string) : null, blob: hasBlob ? (value.blob as string) : null });
}
function validatePrompt(value: unknown, secret: string | null): McpPromptDescription {
  if (!plain(value) || typeof value.name !== "string" || !value.name || Buffer.byteLength(value.name, "utf8") > MCP_MAX_PROMPT_NAME_BYTES) throw new JsonRpcClientError("protocol", "invalid MCP prompt name");
  if (value.description !== undefined && typeof value.description !== "string") throw new JsonRpcClientError("protocol", "invalid MCP prompt description");
  const rawArguments = value.arguments === undefined ? [] : value.arguments;
  if (!Array.isArray(rawArguments) || rawArguments.length > MCP_MAX_PROMPT_ARGUMENTS) throw new JsonRpcClientError("protocol", "invalid or oversized MCP prompt arguments");
  const redact = (text: string): string => redactNativeText(boundedUtf8(text, MCP_MAX_DESCRIPTION_BYTES), { secrets: secret === null ? [] : [secret] });
  const args = rawArguments.map((raw): { readonly name: string; readonly description: string; readonly required: boolean } => {
    if (!plain(raw) || typeof raw.name !== "string" || !raw.name) throw new JsonRpcClientError("protocol", "invalid MCP prompt argument name");
    if (raw.description !== undefined && typeof raw.description !== "string") throw new JsonRpcClientError("protocol", "invalid MCP prompt argument description");
    if (raw.required !== undefined && typeof raw.required !== "boolean") throw new JsonRpcClientError("protocol", "invalid MCP prompt argument required flag");
    return Object.freeze({ name: redact(raw.name), description: redact(raw.description ?? ""), required: raw.required === true });
  });
  return Object.freeze({ name: value.name, description: redact(value.description ?? ""), arguments: Object.freeze(args) });
}
function validatePromptMessage(value: unknown, secret: string | null): McpPromptMessage {
  if (!plain(value) || (value.role !== "user" && value.role !== "assistant")) throw new JsonRpcClientError("protocol", "invalid MCP prompt message role");
  if (!plain(value.content) || !isJsonValue(value.content) || boundedJsonBytes(value.content, MCP_MAX_SCHEMA_BYTES) > MCP_MAX_SCHEMA_BYTES) throw new JsonRpcClientError("protocol", "invalid or oversized MCP prompt message content");
  return Object.freeze({ role: value.role, content: redactJsonObject(value.content, secret) });
}
function projectCapabilities(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const tools = plain(value.tools) ? value.tools : {};
  if (tools.listChanged !== undefined && typeof tools.listChanged !== "boolean") throw new JsonRpcClientError("protocol", "invalid MCP tools capability");
  const resources = plain(value.resources) ? value.resources : {};
  if (resources.listChanged !== undefined && typeof resources.listChanged !== "boolean") throw new JsonRpcClientError("protocol", "invalid MCP resources capability");
  const prompts = plain(value.prompts) ? value.prompts : {};
  if (prompts.listChanged !== undefined && typeof prompts.listChanged !== "boolean") throw new JsonRpcClientError("protocol", "invalid MCP prompts capability");
  return Object.freeze({
    tools: Object.freeze({ listChanged: tools.listChanged === true }),
    resources: Object.freeze({ listChanged: resources.listChanged === true }),
    prompts: Object.freeze({ listChanged: prompts.listChanged === true }),
  });
}
function boundedUtf8(value: string, max: number): string { if (Buffer.byteLength(value) <= max) return value; return Buffer.from(value).subarray(0, max).toString("utf8").replace(/\uFFFD$/, ""); }
function boundedError(error: unknown): string { return boundedUtf8(error instanceof Error ? error.message : "MCP connection failed", 512); }
async function withTimeout<T>(ms: number, signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> { const controller = new AbortController(); const forward = (): void => controller.abort(signal.reason); if (signal.aborted) forward(); else signal.addEventListener("abort", forward, { once: true }); const timer = setTimeout(() => controller.abort(), ms); try { return await run(controller.signal); } catch (error) { if (signal.aborted) throw new JsonRpcClientError("cancelled", "MCP connection was cancelled"); if (controller.signal.aborted) throw new JsonRpcClientError("timeout", "MCP connection timed out"); throw error; } finally { clearTimeout(timer); signal.removeEventListener("abort", forward); } }
function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 1_024 && value.every((item) => isJsonValue(item, depth + 1));
  return plain(value) && Object.keys(value).length <= 1_024 && Object.values(value).every((item) => isJsonValue(item, depth + 1));
}
function redactJsonObject(value: Record<string, unknown>, secret: string | null): Readonly<Record<string, unknown>> {
  const visit = (item: unknown): unknown => {
    if (typeof item === "string") return redactNativeText(item, { secrets: secret === null ? [] : [secret] });
    if (Array.isArray(item)) return Object.freeze(item.map(visit));
    if (plain(item)) return Object.freeze(Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)])));
    return item;
  };
  return visit(value) as Readonly<Record<string, unknown>>;
}
