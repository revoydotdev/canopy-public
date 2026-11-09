import { describe, expect, it } from "vitest";
import { McpConnector } from "../../src/mcp-client/mcp-connector.js";
import { loadConfigFromString } from "@arbor/config";
import { FakeMcpServer } from "./fake-mcp-server.js";

const scope = { campaign_id: "c", node_id: "n", worktree_path: "/tmp/w", session_id: "s" };
describe("MCP connector", () => {
  it("degrades a failed server to zero tools and a bounded diagnostic", async () => {
    const fake = new FakeMcpServer(); fake.failOpen = true;
    const connector = new McpConnector({ servers: [{ server_id: "down", transport: "stdio", command: "unused" }], transport_factory: () => fake });
    expect(fake.methods).toEqual([]); expect(await connector.toolPortsForSession(scope)).toEqual([]); expect(connector.diagnostics()).toMatchObject([{ server_id: "down", code: "mcp_connection_failed" }]);
  });

  it("connects once, applies read-only risk, and closes the transport", async () => {
    const fake = new FakeMcpServer(); const connector = new McpConnector({ servers: [{ server_id: "fs", transport: "stdio", command: "unused", read_only_tools: ["read"] }], transport_factory: () => fake });
    const ports = await connector.toolPortsForSession(scope); expect(ports).toHaveLength(1); expect((ports[0] as unknown as { model_definition: { risk: string } }).model_definition.risk).toBe("low"); expect(ports[0]?.recovery_protection?.({} as never)).toMatchObject({ effect_kind: "read_only", repeatable: true }); expect(connector.inspections()).toMatchObject([{ server_id: "fs", client: { state: "connected", protocol_version: "2025-06-18" } }]); await connector.close(); expect(fake.connected).toBe(false);
  });

  it("defaults discovered tools to high risk and reuses one lazy connection", async () => {
    const fake = new FakeMcpServer(); const connector = new McpConnector({ servers: [{ server_id: "db", transport: "stdio", command: "unused" }], transport_factory: () => fake });
    const first = await connector.toolPortsForSession(scope); const second = await connector.toolPortsForSession({ ...scope, session_id: "s2" });
    expect((first[0] as unknown as { model_definition: { risk: string } }).model_definition.risk).toBe("high"); expect(second[0]).toBe(first[0]); expect(fake.methods.filter((method) => method === "initialize")).toHaveLength(1);
    expect(first[0]?.recovery_protection?.({} as never)).toMatchObject({ effect_kind: "external", repeatable: false });
    expect(connector.systemApprovedToolNames()).toEqual([]);
  });

  it("system-approves only tools that the operator configured as mutating", async () => {
    const fake = new FakeMcpServer(); const connector = new McpConnector({ servers: [{ server_id: "db", transport: "stdio", command: "unused", mutating_tools: ["read"] }], transport_factory: () => fake });
    const [port] = await connector.toolPortsForSession(scope);
    expect(port?.tool).toBe("mcp.db.read"); expect(connector.systemApprovedToolNames()).toEqual(["mcp.db.read"]);
  });

  it("uses server-scoped opaque leases and never projects credential material", async () => {
    const fake = new FakeMcpServer(); const environment = { MCP_TOKEN: "VERY_SECRET_TOKEN" }; const connector = new McpConnector({ servers: [{ server_id: "secure", transport: "http", url: "https://example.test/mcp", credential_env: "MCP_TOKEN", read_only_tools: ["read"] }], environment, transport_factory: () => fake }); environment.MCP_TOKEN = "DRIFTED_TOKEN";
    const [port] = await connector.toolPortsForSession(scope); expect(port).toBeDefined();
    const result = await port!.execute({ session_id: "session-a", turn: 1, call_id: "call", input: {}, workspace_roots: [], filesystem: "read_only", network_allowed: false, intent_evidence: [] }, null, new AbortController().signal);
    expect(result.evidence.outcome).toBe("succeeded"); expect(JSON.stringify({ result, definition: (port as { model_definition?: unknown }).model_definition, diagnostics: connector.diagnostics(), inspections: connector.inspections() })).not.toContain("VERY_SECRET_TOKEN");
    await connector.close(); expect(fake.closeSecrets).toContain("VERY_SECRET_TOKEN"); expect(fake.seenSecrets).not.toContain("DRIFTED_TOKEN");
  });

  it("degrades a configured-but-absent credential to zero tools", async () => {
    const connector = new McpConnector({ servers: [{ server_id: "secure", transport: "http", url: "https://example.test/mcp", credential_env: "MISSING" }], environment: {}, transport_factory: () => new FakeMcpServer() });
    expect(await connector.toolPortsForSession(scope)).toEqual([]); expect(connector.diagnostics()).toMatchObject([{ code: "mcp_credential_unavailable" }]);
  });

  it("redacts credential material from connection diagnostics", async () => {
    const fake = new FakeMcpServer(); fake.open = async () => { throw new Error("authorization failed for VERY_SECRET_TOKEN"); };
    const connector = new McpConnector({ servers: [{ server_id: "secure", transport: "http", url: "https://example.test/mcp", credential_env: "MCP_TOKEN" }], environment: { MCP_TOKEN: "VERY_SECRET_TOKEN" }, transport_factory: () => fake });
    expect(await connector.toolPortsForSession(scope)).toEqual([]); expect(JSON.stringify(connector.diagnostics())).not.toContain("VERY_SECRET_TOKEN"); expect(JSON.stringify(connector.diagnostics())).toContain("[REDACTED]");
  });

  it("rejects unsafe or duplicate connector catalogs before any connection", () => {
    expect(() => new McpConnector({ servers: [{ server_id: "bad", transport: "http", url: "http://example.test/mcp" }] })).toThrow(/HTTPS/);
    expect(() => new McpConnector({ servers: [{ server_id: "same", transport: "stdio", command: "a" }, { server_id: "same", transport: "stdio", command: "b" }] })).toThrow(/unique/);
  });

  it("lists resources and prompts once opted in and the server declares both capabilities (ADR-098)", async () => {
    const fake = new FakeMcpServer("2026-07-28"); fake.capabilitiesResult = { tools: {}, resources: {}, prompts: {} };
    const connector = new McpConnector({ servers: [{ server_id: "docs", transport: "stdio", command: "unused", resources: true, prompts: true }], transport_factory: () => fake });
    await connector.toolPortsForSession(scope);
    expect(connector.inspections()).toMatchObject([{ server_id: "docs", resources: [{ uri: "file:///fixture.txt", name: "fixture.txt" }], resource_templates: [{ uriTemplate: "file:///users/{user}.txt", name: "user file" }], prompts: [{ name: "greet" }] }]);
  });

  it("routes validated user config to connector opt-ins while leaving omitted flags disabled", async () => {
    const defaults = loadConfigFromString(JSON.stringify({ native: { mcp_servers: [{ server_id: "default", transport: "stdio", command: "unused" }] } }));
    const defaultServer = new FakeMcpServer("2026-07-28"); defaultServer.capabilitiesResult = { tools: {}, resources: {}, prompts: {} };
    const defaultConnector = new McpConnector({ servers: defaults.native.mcp_servers ?? [], transport_factory: () => defaultServer });
    await defaultConnector.toolPortsForSession(scope);
    expect(defaultServer.methods).not.toContain("resources/list");
    expect(defaultServer.methods).not.toContain("resources/templates/list");
    expect(defaultServer.methods).not.toContain("prompts/list");
    await defaultConnector.close();

    const enabled = loadConfigFromString(JSON.stringify({ native: { mcp_servers: [{ server_id: "docs", transport: "stdio", command: "unused", resources: true, prompts: true }] } }));
    const enabledServer = new FakeMcpServer("2026-07-28"); enabledServer.capabilitiesResult = { tools: {}, resources: {}, prompts: {} };
    const enabledConnector = new McpConnector({ servers: enabled.native.mcp_servers ?? [], transport_factory: () => enabledServer });
    await enabledConnector.toolPortsForSession(scope);
    expect(enabledServer.methods).toContain("resources/list");
    expect(enabledServer.methods).toContain("resources/templates/list");
    expect(enabledServer.methods).toContain("prompts/list");
    expect(enabledConnector.inspections()).toMatchObject([{ server_id: "docs", resource_templates: [{ uriTemplate: "file:///users/{user}.txt" }] }]);
    await enabledConnector.close();
  });

  it("resolves elicitation MRTR through the connector-wide elicitation port", async () => {
    const fake = new FakeMcpServer("2026-07-28"); fake.capabilitiesResult = { tools: {} };
    fake.pendingInputRequired = { method: "tools/call", result: { resultType: "input_required", inputRequests: { who: { method: "elicitation/create", params: { message: "who are you?" } } } } };
    const elicitation = { elicit: async () => ({ action: "accept" as const, content: { name: "octocat" } }) };
    const connector = new McpConnector({ servers: [{ server_id: "fs", transport: "stdio", command: "unused", read_only_tools: ["read"] }], transport_factory: () => fake, elicitation });
    const [port] = await connector.toolPortsForSession(scope);
    const result = await port!.execute({ session_id: "s", turn: 1, call_id: "c", input: {}, workspace_roots: [], filesystem: "read_only", network_allowed: false, intent_evidence: [] }, null, new AbortController().signal);
    expect(result.evidence.outcome).toBe("succeeded");
  });

  it("re-discovers tools live over subscriptions/listen when a server declares tools.listChanged (ADR-098)", async () => {
    const fake = new FakeMcpServer("2026-07-28"); fake.capabilitiesResult = { tools: { listChanged: true } };
    const connector = new McpConnector({ servers: [{ server_id: "live", transport: "stdio", command: "unused" }], transport_factory: () => fake });
    const initial = await connector.toolPortsForSession(scope);
    expect(initial.map((port) => port.tool)).toEqual(["mcp.live.read"]);
    fake.tools = [...fake.tools, { name: "write", description: "Write a fixture", inputSchema: { type: "object" } }];
    await new Promise((resolve) => setTimeout(resolve, 10));
    fake.emitNotification("notifications/tools/list_changed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = await connector.toolPortsForSession(scope);
    expect(after.map((port) => port.tool).sort()).toEqual(["mcp.live.read", "mcp.live.write"]);
    await connector.close();
  });
});
