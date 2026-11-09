import { describe, expect, it } from "vitest";
import { McpClient } from "../../src/mcp-client/mcp-client.js";
import { FakeMcpServer } from "./fake-mcp-server.js";

describe("MCP lifecycle client", () => {
  it("enforces initialize/initialized before listing and calling tools", async () => {
    const server = new FakeMcpServer(); const client = new McpClient(server);
    await expect(client.listTools()).rejects.toMatchObject({ code: "closed" });
    const tools = await client.connect();
    expect(server.methods).toEqual(["server/discover", "initialize", "notifications/initialized", "tools/list"]);
    expect(tools).toEqual([{ name: "read", description: "Read a fixture", inputSchema: { type: "object" } }]);
    expect(await client.callTool("read", {})).toMatchObject({ isError: false });
    expect(client.inspect()).toEqual({ state: "connected", protocol_version: "2025-06-18", server_info: { name: "fake", version: "1" }, capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } }, diagnostic: null });
  });

  it("supports the 2025-11-25 legacy lifecycle", async () => {
    const server = new FakeMcpServer("2025-11-25"); const client = new McpClient(server);
    await client.connect();
    expect(client.inspect().protocol_version).toBe("2025-11-25");
    expect(server.methods).toEqual(["server/discover", "initialize", "notifications/initialized", "tools/list"]);
  });

  it("supports 2026-07-28 discovery with per-request metadata and no initialized notification", async () => {
    const server = new FakeMcpServer("2026-07-28"); const client = new McpClient(server);
    await client.connect();
    await client.callTool("read", {});
    expect(server.methods).toEqual(["server/discover", "tools/list", "tools/call"]);
    for (const request of server.requests) expect(request.params).toMatchObject({ _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "revoy2", version: "0.2.0" },
      "io.modelcontextprotocol/clientCapabilities": {},
    } });
  });

  it("fails closed with a diagnostic when discovery offers only a future protocol", async () => {
    const server = new FakeMcpServer("2027-01-01");
    server.exchange = async (message) => ({ jsonrpc: "2.0", id: message.id, result: { resultType: "complete", supportedVersions: ["2027-01-01"], capabilities: { tools: {} } } });
    const client = new McpClient(server);
    await expect(client.connect()).rejects.toThrow(/unsupported MCP protocol version.*2027-01-01/);
    expect(client.inspect().diagnostic).toMatch(/unsupported MCP protocol version.*2027-01-01/);
  });

  it("enforces tool-count and schema-size bounds", async () => {
    const tooMany = new FakeMcpServer(); tooMany.tools = Array.from({ length: 65 }, (_, index) => ({ name: `tool-${index}`, description: "x", inputSchema: { type: "object" } }));
    await expect(new McpClient(tooMany).connect()).rejects.toMatchObject({ code: "protocol" });
    const oversized = new FakeMcpServer(); oversized.tools = [{ name: "huge", description: "x", inputSchema: { type: "object", description: "x".repeat(70_000) } }];
    await expect(new McpClient(oversized).connect()).rejects.toMatchObject({ code: "protocol" });
  });

  it("rejects invalid client bounds at construction", () => {
    expect(() => new McpClient(new FakeMcpServer(), { max_tools: 65 })).toThrow(/max_tools/);
    expect(() => new McpClient(new FakeMcpServer(), { call_timeout_ms: 0 })).toThrow(/timeout/);
  });
});

describe("MCP resources and prompts (ADR-098)", () => {
  it("refuses to list resources or prompts when the capability was not requested", async () => {
    const server = new FakeMcpServer("2026-07-28"); const client = new McpClient(server);
    await client.connect();
    await expect(client.listResources()).rejects.toMatchObject({ code: "protocol", message: expect.stringContaining("resources") });
    await expect(client.listResourceTemplates()).rejects.toMatchObject({ code: "protocol", message: expect.stringContaining("resources") });
    await expect(client.listPrompts()).rejects.toMatchObject({ code: "protocol", message: expect.stringContaining("prompts") });
  });
  it("fails connect when resources are requested but the server does not declare the capability", async () => {
    const server = new FakeMcpServer("2026-07-28"); server.capabilitiesResult = { tools: {} };
    const client = new McpClient(server, { resources: true });
    await expect(client.connect()).rejects.toMatchObject({ code: "protocol", message: expect.stringContaining("resources capability") });
  });
  it("lists resources, reads one, lists prompts, and gets one once both are declared and requested", async () => {
    const server = new FakeMcpServer("2026-07-28"); server.capabilitiesResult = { tools: {}, resources: {}, prompts: {} };
    const client = new McpClient(server, { resources: true, prompts: true });
    await client.connect();
    const resources = await client.listResources();
    expect(resources).toEqual([{ uri: "file:///fixture.txt", name: "fixture.txt", description: "A fixture resource", mimeType: "text/plain" }]);
    expect(await client.listResourceTemplates()).toEqual([{ uriTemplate: "file:///users/{user}.txt", name: "user file", description: "A per-user fixture", mimeType: "text/plain" }]);
    const contents = await client.readResource("file:///fixture.txt");
    expect(contents).toEqual([{ uri: "file:///fixture.txt", mimeType: "text/plain", text: "fixture contents", blob: null }]);
    const prompts = await client.listPrompts();
    expect(prompts).toEqual([{ name: "greet", description: "Greets someone", arguments: [{ name: "who", description: "who to greet", required: true }] }]);
    const prompt = await client.getPrompt("greet", { who: "world" });
    expect(prompt).toEqual({ description: "Greets someone", messages: [{ role: "user", content: { type: "text", text: "hello" } }] });
    expect(server.requests.find((request) => request.method === "prompts/get")?.params).toMatchObject({ name: "greet", arguments: { who: "world" } });
  });
});

describe("MCP elicitation MRTR (ADR-098)", () => {
  it("resolves a form-mode elicitation InputRequiredResult and retries tools/call with inputResponses", async () => {
    const server = new FakeMcpServer("2026-07-28"); server.capabilitiesResult = { tools: {} };
    server.pendingInputRequired = { method: "tools/call", result: {
      resultType: "input_required",
      inputRequests: { github_login: { method: "elicitation/create", params: { mode: "form", message: "Please provide your GitHub username", requestedSchema: { type: "object", properties: { name: { type: "string" } } } } } },
      requestState: "opaque-state",
    } };
    const seenRequests: unknown[] = [];
    const elicitation = { elicit: async (request: unknown) => { seenRequests.push(request); return { action: "accept" as const, content: { name: "octocat" } }; } };
    const client = new McpClient(server, { elicitation });
    await client.connect();
    const result = await client.callTool("read", {});
    expect(result.isError).toBe(false);
    expect(seenRequests).toEqual([{ mode: "form", message: "Please provide your GitHub username", requestedSchema: { type: "object", properties: { name: { type: "string" } } } }]);
    const retry = server.requests.filter((request) => request.method === "tools/call")[1];
    expect(retry?.params).toMatchObject({ name: "read", inputResponses: { github_login: { action: "accept", content: { name: "octocat" } } }, requestState: "opaque-state" });
  });
  it("throws a protocol error when a server elicits without a configured elicitation port", async () => {
    const server = new FakeMcpServer("2026-07-28"); server.capabilitiesResult = { tools: {} };
    server.pendingInputRequired = { method: "tools/call", result: { resultType: "input_required", inputRequests: { x: { method: "elicitation/create", params: { message: "need input" } } } } };
    const client = new McpClient(server);
    await client.connect();
    await expect(client.callTool("read", {})).rejects.toMatchObject({ code: "protocol", message: expect.stringContaining("no elicitation port") });
  });
  it("rejects an input request for any MRTR method other than elicitation/create", async () => {
    const server = new FakeMcpServer("2026-07-28"); server.capabilitiesResult = { tools: {} };
    server.pendingInputRequired = { method: "tools/call", result: { resultType: "input_required", inputRequests: { x: { method: "roots/list", params: {} } } } };
    const client = new McpClient(server, { elicitation: { elicit: async () => ({ action: "accept" }) } });
    await client.connect();
    await expect(client.callTool("read", {})).rejects.toMatchObject({ code: "protocol", message: expect.stringContaining("unsupported MRTR method") });
  });
});

describe("MCP subscriptions/listen live re-discovery (ADR-098)", () => {
  it("forwards notifications from an open subscribe() stream until close() aborts it", async () => {
    const server = new FakeMcpServer("2026-07-28"); server.capabilitiesResult = { tools: { listChanged: true } };
    const client = new McpClient(server);
    await client.connect();
    const seen: string[] = [];
    const controller = new AbortController();
    const handle = client.subscribe({ toolsListChanged: true }, (message) => seen.push(message.method), { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    server.emitNotification("notifications/tools/list_changed");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toEqual(["notifications/tools/list_changed"]);
    handle.close();
    await handle.done;
  });
  it("refuses to subscribe on a legacy protocol connection", async () => {
    const server = new FakeMcpServer("2025-06-18"); const client = new McpClient(server);
    await client.connect();
    expect(() => client.subscribe({ toolsListChanged: true }, () => {}, { signal: new AbortController().signal })).toThrow(/2026-07-28/);
  });
});
