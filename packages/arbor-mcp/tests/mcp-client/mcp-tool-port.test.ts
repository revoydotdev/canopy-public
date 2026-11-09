import { describe, expect, it } from "vitest";
import { NativeHarnessWorker, NativeSessionEngine, type NativeModelRequest, type NativeToolRequest } from "@arbor/harness";
import { McpClient } from "../../src/mcp-client/mcp-client.js";
import { createMcpToolPort } from "../../src/mcp-client/mcp-tool-port.js";
import { FakeMcpServer } from "./fake-mcp-server.js";

const request: NativeToolRequest = { session_id: "s", turn: 1, call_id: "c", input: {}, workspace_roots: [], filesystem: "read_only", network_allowed: false, intent_evidence: [] };

describe("MCP native tool adapter", () => {
  it("namespaces, advertises, and maps successful and remote-error results", async () => {
    const server = new FakeMcpServer(); const client = new McpClient(server); const [tool] = await client.connect();
    const port = createMcpToolPort({ server_id: "fixture", tool: tool!, client, risk: "low", mutating: false });
    expect(port.tool).toBe("mcp.fixture.read"); expect(port.tool).not.toBe("file.read"); expect(port.model_definition).toMatchObject({ risk: "low", parameters: { type: "object" } });
    expect(await port.execute(request, null, new AbortController().signal)).toMatchObject({ evidence: { outcome: "succeeded", code: "ok", effect: "observed" } });
    server.callResult = { content: [{ type: "text", text: "bad input" }], isError: true };
    expect(await port.execute(request, null, new AbortController().signal)).toMatchObject({ evidence: { outcome: "failed", code: "mcp_tool_error", effect: "none" } });
  });

  it("bounds oversized output, omits binary content, and never projects a bearer secret", async () => {
    const server = new FakeMcpServer(); server.callResult = { content: [{ type: "text", text: `token SECRET ${"x".repeat(5_000)}` }, { type: "image", data: "SECRET" }] };
    const client = new McpClient(server); const [tool] = await client.connect("SECRET");
    const lease = { lease_id: "opaque", inject: async <T>(recipient: (secret: string) => Promise<T>): Promise<T> => recipient("SECRET") };
    const port = createMcpToolPort({ server_id: "fixture", tool: tool!, client, risk: "high", mutating: true, credential_for_session: () => lease, max_result_bytes: 1_024 });
    const result = await port.execute(request, null, new AbortController().signal);
    expect(JSON.stringify(result)).not.toContain("SECRET"); expect(result.model_output).toContain('"truncated":true'); expect(result.model_output).toContain("non_text_parts"); expect(Buffer.byteLength(result.model_output)).toBeLessThanOrEqual(1_024);
    expect(result.evidence).toMatchObject({ outcome: "succeeded", effect: "applied" });
  });

  it("refuses non-object and over-bound arguments before transport dispatch", async () => {
    const server = new FakeMcpServer(); const client = new McpClient(server); const [tool] = await client.connect(); const port = createMcpToolPort({ server_id: "fixture", tool: tool!, client, risk: "low", mutating: false, max_argument_bytes: 4 });
    expect(port.preflight?.({ ...request, input: "bad" })).toMatchObject({ allowed: false, code: "mcp_invalid_arguments", evidence: { stage: "audit" } });
    expect(port.preflight?.({ ...request, input: { too: "large" } })).toMatchObject({ allowed: false, code: "mcp_arguments_too_large" });
  });

  it("maps a bounded call timeout into execution evidence", async () => {
    const server = new FakeMcpServer(); const client = new McpClient(server); const [tool] = await client.connect(); server.delayMs = 50;
    const port = createMcpToolPort({ server_id: "fixture", tool: tool!, client, risk: "low", mutating: false, call_timeout_ms: 5 });
    expect(await port.execute(request, null, new AbortController().signal)).toMatchObject({ evidence: { outcome: "failed", code: "mcp_timeout" } });
  });

  it("maps a malformed tool result to typed protocol evidence", async () => {
    const server = new FakeMcpServer(); const client = new McpClient(server); const [tool] = await client.connect(); server.callResult = { content: "not-an-array" };
    const port = createMcpToolPort({ server_id: "fixture", tool: tool!, client, risk: "low", mutating: false });
    expect(await port.execute(request, null, new AbortController().signal)).toMatchObject({ evidence: { outcome: "failed", code: "mcp_protocol" } });
  });

  it("redacts untrusted descriptions and schema strings before model projection", async () => {
    const server = new FakeMcpServer(); server.tools = [{ name: "read", description: "token=DESCRIPTION_SECRET_VALUE", inputSchema: { type: "object", description: "password=SCHEMA_SECRET_VALUE" } }];
    const client = new McpClient(server); const [tool] = await client.connect(); const port = createMcpToolPort({ server_id: "fixture", tool: tool!, client, risk: "low", mutating: false });
    expect(JSON.stringify(port.model_definition)).not.toContain("SECRET_VALUE");
    expect(JSON.stringify(port.model_definition)).toContain("[REDACTED]");
  });

  it("keeps bearer material out of worker events and model conversation history", async () => {
    const secret = "BEARER_SECRET_VALUE"; const server = new FakeMcpServer(); server.callResult = { content: [{ type: "text", text: `Bearer ${secret}` }] };
    const client = new McpClient(server); const [tool] = await client.connect(secret); const lease = { lease_id: "opaque", inject: async <T>(recipient: (value: string) => Promise<T>): Promise<T> => recipient(secret) };
    const port = createMcpToolPort({ server_id: "fixture", tool: tool!, client, risk: "low", mutating: false, credential_for_session: () => lease });
    const requests: NativeModelRequest[] = []; let turn = 0;
    const engine = new NativeSessionEngine({ capabilities: [], clock: { now: () => Date.now() } });
    const worker = new NativeHarnessWorker({ session_engine: engine, model: { async run(modelRequest) { requests.push(modelRequest); turn += 1; return turn === 1 ? { text: [], tool_calls: [{ call_id: "call", tool: port.tool, input: {}, input_summary: "read", risk: "low", context_refs: [] }], final_message: null } : { text: [], tool_calls: [], final_message: "done" }; } }, tools: [port] });
    await worker.run({ start: { session_id: "worker-session", policy: { filesystem: "read_only", network_allowed: false, approvals: "on_risk", tool_allow: [port.tool], tool_deny: [], workspace_roots: ["/workspace"], max_wall_clock_ms: 1_000, max_events: 100, ambient_plugins_allowed: false, user_configuration_allowed: false, inherited_credentials_allowed: false }, required_capabilities: [], lineage: { kind: "new" }, ephemeral: false }, prompt: "use tool", max_turns: 3 });
    expect(JSON.stringify(engine.observe("worker-session"))).not.toContain(secret); expect(JSON.stringify(requests)).not.toContain(secret);
  });
});
