import { InMemoryCredentialLeaseBroker, redactNativeText, type NativeCredentialLeasePort, type NativeToolPort } from "@arbor/harness";
import { MCP_MAX_SECRET_BYTES, MCP_MAX_SERVERS, type McpConnectorDiagnostic, type McpConnectorInspection, type McpElicitationPort, type McpPromptDescription, type McpResourceDescription, type McpResourceTemplateDescription, type McpServerConfig, type McpToolDescription } from "./contracts.js";
import { plain, type JsonRpcNotification, type JsonRpcTransport } from "./json-rpc.js";
import { HttpMcpTransport } from "./http-transport.js";
import { McpClient } from "./mcp-client.js";
import { createMcpToolPort } from "./mcp-tool-port.js";
import { StdioMcpTransport } from "./stdio-transport.js";

export interface McpConnectorOptions {
  readonly servers: readonly McpServerConfig[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly transport_factory?: (config: McpServerConfig) => JsonRpcTransport;
  /** Dynamic owner gate. It only prevents future session acquisition; already issued ports remain in-flight safe. */
  readonly active?: () => boolean;
  /** Resolves elicitation MRTR input requests for every connected server (ADR-098). Omitted means no server's elicitation requests can ever be resolved, which is the safe default -- elicitation is never ambient. */
  readonly elicitation?: McpElicitationPort;
}
interface ConnectedServer {
  readonly server_id: string;
  readonly client: McpClient;
  readonly credentials: McpServerCredentialBroker | null;
  readonly config: McpServerConfig;
  ports: readonly NativeToolPort[];
  resources: readonly McpResourceDescription[];
  resource_templates: readonly McpResourceTemplateDescription[];
  prompts: readonly McpPromptDescription[];
  subscription: { close(): void } | null;
}
type PreparedCredential = { readonly kind: "none" } | { readonly kind: "unavailable" } | { readonly kind: "ready"; readonly broker: McpServerCredentialBroker };

export class McpConnector {
  readonly name = "mcp-client-connector";
  private readonly clients: ConnectedServer[] = [];
  private ports: readonly NativeToolPort[] = Object.freeze([]);
  private readonly failures: McpConnectorDiagnostic[] = [];
  private readonly approvedHighRisk = new Set<string>();
  private readonly servers: readonly McpServerConfig[];
  private readonly transportFactory: McpConnectorOptions["transport_factory"];
  private readonly credentials = new Map<string, PreparedCredential>();
  private connection: Promise<void> | null = null;
  private closed = false;
  private readonly active: () => boolean;
  private readonly elicitation: McpElicitationPort | undefined;
  private readonly listenController = new AbortController();
  constructor(options: McpConnectorOptions) {
    validateServerCatalog(options.servers);
    this.servers = Object.freeze([...options.servers]); this.transportFactory = options.transport_factory; this.active = options.active ?? (() => true); this.elicitation = options.elicitation;
    const environment = options.environment ?? process.env;
    for (const server of this.servers) {
      if (server.credential_env === undefined) { this.credentials.set(server.server_id, { kind: "none" }); continue; }
      const secret = environment[server.credential_env];
      this.credentials.set(server.server_id, secret === undefined || secret.length === 0 || Buffer.byteLength(secret, "utf8") > MCP_MAX_SECRET_BYTES
        ? { kind: "unavailable" }
        : { kind: "ready", broker: new McpServerCredentialBroker(server.server_id, secret) });
    }
  }

  async toolPortsForSession(_scope: { readonly campaign_id: string; readonly node_id: string; readonly worktree_path: string; readonly session_id: string }): Promise<readonly NativeToolPort[]> {
    if (this.closed || !this.active()) return Object.freeze([]);
    this.connection ??= this.connectAll();
    await this.connection;
    return this.active() ? this.ports : Object.freeze([]);
  }
  diagnostics(): readonly McpConnectorDiagnostic[] { return Object.freeze(this.failures.map((item) => Object.freeze({ ...item }))); }
  inspections(): readonly McpConnectorInspection[] { return this.active() ? Object.freeze(this.clients.map((entry) => Object.freeze({ server_id: entry.server_id, client: entry.client.inspect(), resources: entry.resources, resource_templates: entry.resource_templates, prompts: entry.prompts }))) : Object.freeze([]); }
  systemApprovedToolNames(): readonly string[] { return Object.freeze([...this.approvedHighRisk]); }
  async close(): Promise<void> {
    this.closed = true;
    this.listenController.abort();
    if (this.connection !== null) await this.connection.catch(() => {});
    for (const entry of this.clients) entry.subscription?.close();
    await Promise.allSettled(this.clients.map(async ({ client, credentials, server_id }) => {
      const lease = credentials?.leaseForSession(`mcp-close:${server_id}`, "mcp.connect");
      if (lease === undefined) await client.close(); else await lease.inject((secret) => client.close(secret));
    }));
    this.clients.length = 0; this.ports = Object.freeze([]); this.approvedHighRisk.clear();
  }

  private async connectAll(): Promise<void> {
    await Promise.all(this.servers.map((config) => this.connectServer(config)));
    this.recomputePorts();
    await Promise.all(this.clients.map((entry) => this.openLiveDiscovery(entry)));
  }

  /**
   * Rebuilds the deduped, namespaced port list from every connected
   * server's current port set. Called at initial connect and again,
   * incrementally, whenever `subscriptions/listen` reports a tool-list
   * change for one server (ADR-098 decision 4) -- the same dedup path,
   * just re-run instead of run once.
   */
  private recomputePorts(): void {
    const names = new Set<string>();
    const combined: NativeToolPort[] = [];
    for (const entry of this.clients) for (const port of entry.ports) combined.push(port);
    this.ports = Object.freeze(combined.filter((port) => {
      if (names.has(port.tool)) { this.failures.push(Object.freeze({ server_id: serverIdFromTool(port.tool), code: "mcp_tool_collision", message: "duplicate namespaced MCP tool omitted" })); return false; }
      names.add(port.tool); return true;
    }));
  }

  private buildPorts(config: McpServerConfig, client: McpClient, credentials: McpServerCredentialBroker | null, tools: readonly McpToolDescription[]): readonly NativeToolPort[] {
    const readOnly = new Set(config.read_only_tools ?? []); const mutating = new Set(config.mutating_tools ?? []);
    const ports = tools.map((tool) => createMcpToolPort({
      server_id: config.server_id, tool, client, risk: readOnly.has(tool.name) ? "low" : "high",
      // External annotations are descriptive, not authority. Only the local
      // operator allowlist can make an MCP operation eligible for read reuse;
      // unknown tools are treated as potentially mutating by default.
      mutating: mutating.has(tool.name) || !readOnly.has(tool.name),
      ...(credentials === null ? {} : { credential_for_session: (sessionId: string) => credentials.leaseForSession(sessionId, "mcp.tool.call"), redact: (value: string) => credentials.redact(value) }),
    }));
    for (const port of ports) if (mutating.has(port.tool.slice(`mcp.${config.server_id}.`.length))) this.approvedHighRisk.add(port.tool);
    return ports;
  }

  /**
   * Opens a `subscriptions/listen` stream for one connected server when it
   * declared `listChanged` for a capability this connector uses, and
   * re-runs discovery for that capability on the matching notification.
   * The stream is torn down by `close()` via `listenController`.
   */
  private async openLiveDiscovery(entry: ConnectedServer): Promise<void> {
    if (this.listenController.signal.aborted || !entry.client.connected) return;
    const capabilities = entry.client.inspect().capabilities;
    if (!plain(capabilities)) return;
    const tools = plain(capabilities.tools) && capabilities.tools.listChanged === true;
    const resources = entry.config.resources === true && plain(capabilities.resources) && capabilities.resources.listChanged === true;
    const prompts = entry.config.prompts === true && plain(capabilities.prompts) && capabilities.prompts.listChanged === true;
    if (!tools && !resources && !prompts) return;
    const lease = entry.credentials?.leaseForSession(`mcp-listen:${entry.server_id}`, "mcp.connect");
    const onNotification = (message: JsonRpcNotification): void => {
      void this.handleListenNotification(entry, message).catch((error) => {
        this.failures.push(Object.freeze({ server_id: entry.server_id, code: "mcp_live_discovery_failed", message: entry.credentials?.redact(boundedError(error)) ?? boundedError(error) }));
      });
    };
    const filter = { toolsListChanged: tools, resourcesListChanged: resources, promptsListChanged: prompts };
    try {
      entry.subscription = lease === undefined
        ? entry.client.subscribe(filter, onNotification, { signal: this.listenController.signal })
        : await lease.inject((secret) => Promise.resolve(entry.client.subscribe(filter, onNotification, { signal: this.listenController.signal, secret })));
    } catch (error) {
      this.failures.push(Object.freeze({ server_id: entry.server_id, code: "mcp_live_discovery_failed", message: entry.credentials?.redact(boundedError(error)) ?? boundedError(error) }));
    }
  }

  private async handleListenNotification(entry: ConnectedServer, message: JsonRpcNotification): Promise<void> {
    const lease = entry.credentials?.leaseForSession(`mcp-listen-refresh:${entry.server_id}`, "mcp.connect");
    if (message.method === "notifications/tools/list_changed") {
      const tools = lease === undefined ? await entry.client.listTools() : await lease.inject((secret) => entry.client.listTools(secret));
      entry.ports = this.buildPorts(entry.config, entry.client, entry.credentials, tools);
      this.recomputePorts();
    } else if (message.method === "notifications/resources/list_changed" && entry.config.resources === true) {
      entry.resources = lease === undefined ? await entry.client.listResources() : await lease.inject((secret) => entry.client.listResources(secret));
      entry.resource_templates = lease === undefined ? await entry.client.listResourceTemplates() : await lease.inject((secret) => entry.client.listResourceTemplates(secret));
    } else if (message.method === "notifications/prompts/list_changed" && entry.config.prompts === true) {
      entry.prompts = lease === undefined ? await entry.client.listPrompts() : await lease.inject((secret) => entry.client.listPrompts(secret));
    }
  }
  private async connectServer(config: McpServerConfig): Promise<void> {
    let credentials: McpServerCredentialBroker | null = null;
    let client: McpClient | null = null;
    try {
      const prepared = this.credentials.get(config.server_id)!;
      if (prepared.kind === "unavailable") throw new McpConnectorError("configured MCP credential is absent or exceeds its byte bound");
      credentials = prepared.kind === "ready" ? prepared.broker : null;
      client = new McpClient(this.transport(config), { server_id: config.server_id, resources: config.resources === true, prompts: config.prompts === true, elicitation: this.elicitation });
      const entry: ConnectedServer = { server_id: config.server_id, client, credentials, config, ports: Object.freeze([]), resources: Object.freeze([]), resource_templates: Object.freeze([]), prompts: Object.freeze([]), subscription: null };
      this.clients.push(entry);
      const connectLease = credentials?.leaseForSession(`mcp-connect:${config.server_id}`, "mcp.connect");
      const tools = connectLease === undefined ? await client.connect() : await connectLease.inject((secret) => client!.connect(secret));
      entry.ports = this.buildPorts(config, client, credentials, tools);
      if (config.resources === true) entry.resources = connectLease === undefined ? await client.listResources() : await connectLease.inject((secret) => client!.listResources(secret));
      if (config.resources === true) entry.resource_templates = connectLease === undefined ? await client.listResourceTemplates() : await connectLease.inject((secret) => client!.listResourceTemplates(secret));
      if (config.prompts === true) entry.prompts = connectLease === undefined ? await client.listPrompts() : await connectLease.inject((secret) => client!.listPrompts(secret));
    } catch (error) {
      const message = credentials?.redact(boundedError(error)) ?? boundedError(error);
      this.failures.push(Object.freeze({ server_id: config.server_id, code: error instanceof McpConnectorError ? "mcp_credential_unavailable" : "mcp_connection_failed", message }));
      if (client !== null) {
        const lease = credentials?.leaseForSession(`mcp-failed-close:${config.server_id}`, "mcp.connect");
        if (lease === undefined) await client.close().catch(() => {}); else await lease.inject((secret) => client!.close(secret)).catch(() => {});
      }
    }
  }
  private transport(config: McpServerConfig): JsonRpcTransport {
    if (this.transportFactory !== undefined) return this.transportFactory(config);
    return config.transport === "stdio" ? new StdioMcpTransport({ command: config.command, args: config.args, env: config.env, credential_env: config.credential_env }) : new HttpMcpTransport({ url: config.url });
  }
}

class McpServerCredentialBroker {
  private readonly broker = new InMemoryCredentialLeaseBroker();
  private readonly providerId: string;
  constructor(serverId: string, private readonly secret: string) { this.providerId = `mcp:${serverId}`; this.broker.register({ provider_id: this.providerId, account_id: "default", scopes: ["mcp.connect", "mcp.tool.call"], secret }); }
  leaseForSession(sessionId: string, scope: "mcp.connect" | "mcp.tool.call"): NativeCredentialLeasePort | undefined {
    const issued = this.broker.issue({ provider_id: this.providerId, account_id: "default", scopes: [scope], session_id: sessionId, expires_at: new Date(Date.now() + 10 * 60_000).toISOString() });
    if (!issued.issued) return undefined;
    const leaseId = issued.lease.lease_id;
    return Object.freeze({ lease_id: leaseId, inject: async <T>(recipient: (secret: string) => Promise<T>): Promise<T> => {
      let invoked: Promise<T> | undefined;
      const resolution = this.broker.inject(leaseId, sessionId, (secret) => { invoked = recipient(secret); });
      if (!resolution.available || invoked === undefined) throw new McpConnectorError("MCP credential lease is unavailable");
      return invoked;
    } });
  }
  redact(value: string): string { return redactNativeText(value, { secrets: [this.secret] }); }
}

class McpConnectorError extends Error { constructor(message: string) { super(message); this.name = "McpConnectorError"; } }
function validateServerCatalog(servers: readonly McpServerConfig[]): void {
  if (!Array.isArray(servers) || servers.length > MCP_MAX_SERVERS) throw new McpConnectorError(`native.mcp_servers exceeds maximum ${MCP_MAX_SERVERS}`);
  const ids = new Set<string>();
  for (const server of servers) {
    if (!/^[a-z0-9-]{1,32}$/.test(server.server_id) || ids.has(server.server_id)) throw new McpConnectorError("MCP server ids must be bounded, valid, and unique"); ids.add(server.server_id);
    if (server.credential_env !== undefined && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(server.credential_env)) throw new McpConnectorError("MCP credential environment name is invalid");
    for (const tools of [server.read_only_tools, server.mutating_tools] as const) if (tools !== undefined && (tools.length > 64 || new Set(tools).size !== tools.length || tools.some((tool: string) => !tool || Buffer.byteLength(tool) > 128))) throw new McpConnectorError("MCP configured tool catalog is invalid or oversized");
    if (server.read_only_tools?.some((tool: string) => server.mutating_tools?.includes(tool))) throw new McpConnectorError("MCP tool cannot be both read-only and mutating");
    if (server.transport === "stdio") {
      if (!server.command.trim() || Buffer.byteLength(server.command) > 1_024 || (server.args?.length ?? 0) > 64 || server.args?.some((arg: string) => Buffer.byteLength(arg) > 4_096)) throw new McpConnectorError("MCP stdio command or arguments are invalid or oversized");
      if (server.env !== undefined && (Object.keys(server.env).length > 32 || Object.entries(server.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || Buffer.byteLength(value) > 8_192))) throw new McpConnectorError("MCP stdio environment is invalid or oversized");
      if (server.credential_env !== undefined && server.env?.[server.credential_env] !== undefined) throw new McpConnectorError("MCP credential must not be stored in configured stdio environment");
    } else if (server.transport === "http") {
      let url: URL; try { url = new URL(server.url); } catch { throw new McpConnectorError("MCP HTTP URL is invalid"); }
      if (Buffer.byteLength(server.url) > 2_048 || url.protocol !== "https:" || url.username || url.password) throw new McpConnectorError("MCP HTTP URL must be absolute HTTPS without credentials");
    } else throw new McpConnectorError("MCP transport is invalid");
  }
}
function boundedError(error: unknown): string { const value = error instanceof Error ? error.message : "MCP connection failed"; return Buffer.byteLength(value) <= 512 ? value : Buffer.from(value).subarray(0, 512).toString("utf8"); }
function serverIdFromTool(tool: string): string { return tool.split(".")[1] ?? "unknown"; }
