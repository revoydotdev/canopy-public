import { describe, expect, it } from "vitest";
import { getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import { MCP_MAX_FRAME_BYTES } from "../src/mcp-client/contracts.js";
import { startStdioSession } from "../src/cli.js";
import { ArborMCPServer } from "../src/server.js";
import { ArborRuntime } from "../src/runtime.js";

/**
 * Executable scope statement for the shipped MCP server at protocol revision
 * 2025-06-18. Every `available` row is exercised through startStdioSession,
 * which is the production stdio server entry point. Unsupported protocol
 * surfaces are explicit so an absent implementation cannot count as green.
 */
const MCP_STDIO_CONFORMANCE_MATRIX = Object.freeze({
  protocol_version: "2025-06-18",
  transports: Object.freeze({
    stdio: Object.freeze({ status: "available", reason: "production server entry point is startStdioSession" }),
    streamable_http_server: Object.freeze({ status: "unavailable", reason: "no MCP Streamable HTTP server is composed" }),
    remote_serve_is_mcp: Object.freeze({ status: "unavailable", reason: "remote-serve implements Revoy remote transport, not MCP" }),
  }),
  capabilities: Object.freeze({
    discovery_and_negotiation: Object.freeze({ status: "available", reason: "initialize selects the fixed 2025-06-18 revision for any well-formed client version" }),
    resource_templates: Object.freeze({ status: "available", reason: "resources/templates/list exposes the three campaign URI templates" }),
    typed_authorization_refusal: Object.freeze({ status: "available", reason: "junior-tier and stale-session denials become JSON-RPC permission errors carrying a typed remedy for the correcting actor" }),
    bounded_request_frames: Object.freeze({ status: "available", reason: "stdio rejects frames over MCP_MAX_FRAME_BYTES and resumes at next frame" }),
    list_change_rediscovery: Object.freeze({ status: "available", reason: "registerTool and unregisterTool emit notifications/tools/list_changed through the production stdio session" }),
    server_elicitation: Object.freeze({ status: "available", reason: "tools can use the typed operator elicitation port, negotiated from client elicitation.form; decline/cancel/unavailable do not return success" }),
    request_cancellation: Object.freeze({ status: "available", reason: "stdio correlates notifications/cancelled requestId with the response; domain work already dispatched may continue and its late result is discarded" }),
    stale_mcp_session_refusal: Object.freeze({ status: "available", reason: "stdio initialize issues a transport identity; stale session-tagged cancellation is ignored and refusal data is session-bound" }),
  }),
});

function collect(stream: PassThrough): { lines(): string[] } {
  let text = "";
  stream.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
  return { lines: () => text.split("\n").filter(Boolean) };
}

async function response(output: ReturnType<typeof collect>, id: string | number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const found = output.lines().map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line.id === id);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`MCP response ${String(id)} did not arrive`);
}

async function waitForNotification(output: ReturnType<typeof collect>, method: string, occurrence = 0): Promise<{ id: string | number; params: Record<string, unknown> }> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const found = output.lines().map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.method === method);
    const item = found[occurrence];
    if (item && (typeof item.id === "string" || typeof item.id === "number")) return { id: item.id, params: (item.params ?? {}) as Record<string, unknown> };
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`MCP notification ${method} occurrence ${occurrence} did not arrive`);
}

describe("MCP stdio conformance matrix (2025-06-18)", () => {
  it("pins supported and explicitly unavailable protocol surfaces", () => {
    expect(MCP_STDIO_CONFORMANCE_MATRIX.protocol_version).toBe("2025-06-18");
    expect(MCP_STDIO_CONFORMANCE_MATRIX.transports).toEqual({
      stdio: { status: "available", reason: expect.any(String) },
      streamable_http_server: { status: "unavailable", reason: expect.any(String) },
      remote_serve_is_mcp: { status: "unavailable", reason: expect.any(String) },
    });
    expect(MCP_STDIO_CONFORMANCE_MATRIX.capabilities).toMatchObject({
      discovery_and_negotiation: { status: "available", reason: expect.any(String) },
      resource_templates: { status: "available", reason: expect.any(String) },
      typed_authorization_refusal: { status: "available", reason: expect.any(String) },
      bounded_request_frames: { status: "available", reason: expect.any(String) },
      list_change_rediscovery: { status: "available", reason: expect.any(String) },
      server_elicitation: { status: "available", reason: expect.any(String) },
      request_cancellation: { status: "available", reason: expect.any(String) },
      stale_mcp_session_refusal: { status: "available", reason: expect.any(String) },
    });
  });

  it("drives negotiation, resource/template discovery, and typed authorization refusal through the real stdio server", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const observed = collect(output);
    const session = await startStdioSession(new ArborMCPServer(new ArborRuntime(), { caller_tier: "junior" }), input, output);
    try {
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_STDIO_CONFORMANCE_MATRIX.protocol_version, capabilities: {}, clientInfo: { name: "matrix", version: "1" } } })}\n`);
      const initialized = await response(observed, 1);
      expect(initialized.result).toMatchObject({
        protocolVersion: MCP_STDIO_CONFORMANCE_MATRIX.protocol_version,
        capabilities: { tools: { listChanged: true }, resources: { listChanged: false, subscribe: false } },
      });
      input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');

      input.write('{"jsonrpc":"2.0","id":2,"method":"resources/list"}\n');
      const listed = await response(observed, 2);
      expect(listed.result).toMatchObject({ resources: [
        { uri: "arbor://frame", mimeType: "application/json" },
        { uri: "arbor://capabilities", mimeType: "application/json", description: expect.stringContaining("canonical consumer declarations") },
      ] });

      input.write('{"jsonrpc":"2.0","id":3,"method":"resources/templates/list"}\n');
      const templates = await response(observed, 3);
      expect((templates.result as { resourceTemplates: unknown[] }).resourceTemplates).toHaveLength(3);

      input.write('{"jsonrpc":"2.0","id":5,"method":"resources/read","params":{"uri":"arbor://frame"}}\n');
      const read = await response(observed, 5);
      expect(read.result).toMatchObject({ contents: [{ uri: "arbor://frame", mimeType: "application/json" }] });

      input.write('{"jsonrpc":"2.0","id":6,"method":"resources/read","params":{"uri":"arbor://capabilities"}}\n');
      const capabilityRead = await response(observed, 6);
      const capabilityText = (capabilityRead.result as { contents: Array<{ text: string }> }).contents[0]!.text;
      expect(JSON.parse(capabilityText)).toMatchObject({
        index: { revision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/), mcp_operations: expect.arrayContaining(["arbor_query", "devtools_clear"]) },
        parity: { status: "current", drift: [] },
      });

      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "arbor_command", params: { input: { kind: "session.identity.mutate", session_id: "matrix-session", display_name: "x", provenance: { tag: "claimed", claimant: "matrix" }, metadata: { operation_id: "matrix-denial", idempotency_key: "matrix-denial", correlation_id: "matrix-denial", actor_id: "matrix", requested_at: new Date().toISOString() } } } })}\n`);
      const denied = await response(observed, 4);
      expect(denied.error).toMatchObject({ code: -32001, data: { kind: "authorization_refusal", code: "permission", session_id: expect.stringMatching(/^stdio-/), summary: expect.any(String) } });
      // The refusal carries the canonical typed remedy, routed to the actor
      // that can clear it: a junior client cannot raise its own tier, so the
      // operator relaunches it trusted.
      expect((denied.error as { data: Record<string, unknown> }).data.gate_refusal).toMatchObject({
        schema_version: 2, kind: "gate.refusal", state: "refused", gate: "capability", code: "capability_not_granted",
        correcting_actor: "operator", corrective_action: "grant_capability", remediation: expect.stringContaining("arbor serve --trusted-client"),
      });

      // A stale or forged session proof is the caller's to clear, not the operator's.
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "arbor_command", params: { input: { kind: "git.worktree.switch", path: "/tmp/elsewhere", metadata: { operation_id: "matrix-stale", idempotency_key: "matrix-stale", correlation_id: "matrix-stale", actor_id: "local-session:gone", requested_at: new Date().toISOString(), session: { session_id: "gone", actor_id: "local-session:gone", issued_at: "2026-01-01T00:00:00.000Z", signature: "stale" } } } } })}\n`);
      const stale = await response(observed, 7);
      expect(stale.error).toMatchObject({ code: -32001, data: { kind: "authorization_refusal", code: "permission", gate_refusal: {
        schema_version: 2, gate: "capability", code: "caller_not_authenticated", correcting_actor: "caller", corrective_action: "reauthenticate",
      } } });
    } finally {
      await session.close();
    }
  });

  it("selects its supported version in initialize when the client requests an unsupported version", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const observed = collect(output);
    const session = await startStdioSession(new ArborMCPServer(new ArborRuntime()), input, output);
    try {
      input.write('{"jsonrpc":"2.0","id":"old-client","method":"initialize","params":{"protocolVersion":"2099-01-01","capabilities":{},"clientInfo":{"name":"unsupported-client","version":"1"}}}\n');
      const initialized = await response(observed, "old-client");
      expect(initialized.error).toBeUndefined();
      expect(initialized.result).toMatchObject({ protocolVersion: MCP_STDIO_CONFORMANCE_MATRIX.protocol_version });
      // The client may disconnect if it cannot speak the selected version;
      // this fixture closes without sending notifications/initialized.
    } finally {
      await session.close();
    }
  });

  it("emits list_changed after a process-local tool registration and rediscovery observes the descriptor", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const observed = collect(output);
    const server = new ArborMCPServer(new ArborRuntime());
    const session = await startStdioSession(server, input, output);
    try {
      input.write('{"jsonrpc":"2.0","id":40,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"matrix","version":"1"}}}\n');
      await response(observed, 40);
      input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      server.registerTool({ name: "matrix_dynamic", description: "registered for conformance", inputSchema: { type: "object" }, handler: async () => ({ ok: true }) });
      const deadline = Date.now() + 2_000;
      while (!observed.lines().some((line) => line.includes("notifications/tools/list_changed")) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(observed.lines().map((line) => JSON.parse(line) as Record<string, unknown>)).toContainEqual({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      input.write('{"jsonrpc":"2.0","id":41,"method":"tools/list"}\n');
      const listed = await response(observed, 41);
      expect((listed.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toContain("matrix_dynamic");
      expect(server.unregisterTool("matrix_dynamic")).toBe(true);
      expect(observed.lines().map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.method === "notifications/tools/list_changed")).toHaveLength(2);
    } finally {
      await session.close();
    }
  });

  it("returns the MCP resource-not-found error for an unknown non-empty URI", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const observed = collect(output);
    const session = await startStdioSession(new ArborMCPServer(new ArborRuntime()), input, output);
    try {
      input.write('{"jsonrpc":"2.0","id":20,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"matrix","version":"1"}}}\n');
      await response(observed, 20);
      input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      input.write('{"jsonrpc":"2.0","id":21,"method":"resources/read","params":{"uri":"arbor://not-a-resource"}}\n');
      const missing = await response(observed, 21);
      expect(missing.result).toBeUndefined();
      expect(missing.error).toMatchObject({ code: -32002, message: "Resource not found", data: { uri: "arbor://not-a-resource" } });
    } finally {
      await session.close();
    }
  });

  it("correlates cancellation by request id and does not cancel neighboring requests", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const observed = collect(output);
    const runtime = new ArborRuntime();
    const server = new ArborMCPServer(runtime);
    const original = server.callTool.bind(server);
    const releases = new Map<string, () => void>();
    server.callTool = async (name, args) => {
      if (name === "slow") return new Promise((resolve) => { releases.set(String(args.id), () => resolve({ ok: true })); });
      return original(name, args);
    };
    server.tools.push({ name: "slow", description: "slow fixture", inputSchema: {}, handler: async () => ({ ok: true }) });
    const session = await startStdioSession(server, input, output);
    try {
      input.write('{"jsonrpc":"2.0","id":30,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"matrix","version":"1"}}}\n');
      const initialized = await response(observed, 30);
      const sessionId = (initialized.result as { serverInfo: { session_id: string } }).serverInfo.session_id;
      expect(sessionId).toMatch(/^stdio-/);
      input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      input.write('{"jsonrpc":"2.0","id":"slow-1","method":"tools/call","params":{"name":"slow","arguments":{"id":"one"}}}\n');
      input.write('{"jsonrpc":"2.0","id":"slow-2","method":"tools/call","params":{"name":"slow","arguments":{"id":"two"}}}\n');
      await new Promise((resolve) => setTimeout(resolve, 10));
      input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "slow-1", sessionId: "stdio-stale-session", reason: "delayed cancellation" } })}\n`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(observed.lines().map((line) => JSON.parse(line) as Record<string, unknown>).some((line) => line.id === "slow-1")).toBe(false);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "slow-1", sessionId, reason: "operator cancelled" } })}\n`);
      const cancelled = await response(observed, "slow-1");
      expect(cancelled.error).toMatchObject({ code: -32800, message: "Request cancelled", data: { kind: "request_cancelled", session_id: sessionId } });
      releases.get("two")?.();
      expect(await response(observed, "slow-2")).toHaveProperty("result");
      input.write('{"jsonrpc":"2.0","id":"after-cancel","method":"ping"}\n');
      expect(await response(observed, "after-cancel")).toMatchObject({ result: {} });
    } finally {
      for (const release of releases.values()) release();
      await session.close();
    }
  });

  it("removes the request cancellation listener when stdio work completes normally", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const observed = collect(output);
    const server = new ArborMCPServer(new ArborRuntime());
    let requestSignal: AbortSignal | undefined;
    server.registerTool({
      name: "matrix_fast",
      description: "Immediate fixture result.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async (_args, signal) => { requestSignal = signal; return { ok: true }; },
    });
    const session = await startStdioSession(server, input, output);
    try {
      input.write('{"jsonrpc":"2.0","id":"cleanup-init","method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"matrix","version":"1"}}}\n');
      await response(observed, "cleanup-init");
      input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      input.write('{"jsonrpc":"2.0","id":"cleanup-call","method":"tools/call","params":{"name":"matrix_fast"}}\n');
      await response(observed, "cleanup-call");

      expect(requestSignal).toBeDefined();
      expect(getEventListeners(requestSignal!, "abort")).toHaveLength(0);
    } finally {
      await session.close();
    }
  });

  it("observes a handler rejection when cancellation arrives before the race is installed", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const observed = collect(output);
    const server = new ArborMCPServer(new ArborRuntime());
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    server.registerTool({
      name: "matrix_abort_then_reject",
      description: "Aborts its own stdio request and rejects afterwards.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async (_args, signal) => {
        input.write('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":"abort-before-race"}}\n');
        await Promise.resolve();
        if (!signal?.aborted) throw new Error("fixture cancellation did not arrive");
        throw new Error("late handler rejection");
      },
    });
    const session = await startStdioSession(server, input, output);
    try {
      input.write('{"jsonrpc":"2.0","id":"abort-init","method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"matrix","version":"1"}}}\n');
      await response(observed, "abort-init");
      input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      input.write('{"jsonrpc":"2.0","id":"abort-before-race","method":"tools/call","params":{"name":"matrix_abort_then_reject"}}\n');
      expect(await response(observed, "abort-before-race")).toMatchObject({ error: { code: -32800, message: "Request cancelled" } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await session.close();
    }
  });

  it("observes a handler rejection when cancellation arrives before the race is installed", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const observed = collect(output);
    const server = new ArborMCPServer(new ArborRuntime());
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    server.registerTool({
      name: "matrix_abort_then_reject",
      description: "Aborts its own stdio request and rejects afterwards.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async (_args, signal) => {
        input.write('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":"abort-before-race"}}\n');
        await Promise.resolve();
        if (!signal?.aborted) throw new Error("fixture cancellation did not arrive");
        throw new Error("late handler rejection");
      },
    });
    const session = await startStdioSession(server, input, output);
    try {
      input.write('{"jsonrpc":"2.0","id":"abort-init","method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"matrix","version":"1"}}}\n');
      await response(observed, "abort-init");
      input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      input.write('{"jsonrpc":"2.0","id":"abort-before-race","method":"tools/call","params":{"name":"matrix_abort_then_reject"}}\n');
      expect(await response(observed, "abort-before-race")).toMatchObject({ error: { code: -32800, message: "Request cancelled" } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await session.close();
    }
  });

  it("negotiates typed elicitation and keeps declined or cancelled input out of success paths", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const observed = collect(output);
    const server = new ArborMCPServer(new ArborRuntime());
    let admitted = 0;
    server.registerTool({
      name: "matrix_operator_input", description: "requires explicit operator input", inputSchema: { type: "object" },
      handler: async (_args, signal) => {
        if (!signal) return { ok: false, error: "missing request signal" };
        const answer = await server.requestOperatorInput({ message: "May this scenario be admitted?", requestedSchema: { type: "object", properties: { approve: { type: "boolean" } } } }, signal);
        if (answer.action !== "accept") return { ok: false, error: `operator input ${answer.action}` };
        admitted += 1;
        return { ok: true, answer: answer.content };
      },
    });
    const session = await startStdioSession(server, input, output);
    try {
      input.write('{"jsonrpc":"2.0","id":50,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{"elicitation":{"form":{}}},"clientInfo":{"name":"matrix","version":"1"}}}\n');
      const initialized = await response(observed, 50);
      const sessionId = (initialized.result as { serverInfo: { session_id: string } }).serverInfo.session_id;
      input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');

      input.write('{"jsonrpc":"2.0","id":"decline-call","method":"tools/call","params":{"name":"matrix_operator_input"}}\n');
      const declineRequest = await waitForNotification(observed, "elicitation/create");
      expect(declineRequest.params).toMatchObject({ mode: "form", message: "May this scenario be admitted?" });
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: declineRequest.id, result: { action: "decline" } })}\n`);
      expect(await response(observed, "decline-call")).toMatchObject({ result: { isError: true } });
      expect(admitted).toBe(0);

      input.write('{"jsonrpc":"2.0","id":"cancel-call","method":"tools/call","params":{"name":"matrix_operator_input"}}\n');
      const cancelRequest = await waitForNotification(observed, "elicitation/create", 1);
      input.write('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":"cancel-call","reason":"operator stopped waiting"}}\n');
      expect(await response(observed, "cancel-call")).toMatchObject({ error: { code: -32800, message: "Request cancelled" } });
      expect(observed.lines().map((line) => JSON.parse(line) as Record<string, unknown>)).toContainEqual({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: cancelRequest.id, sessionId, reason: "operator request cancelled" } });
      expect(admitted).toBe(0);
    } finally {
      await session.close();
    }
  });

  it("refuses operator input without elicitation.form and sends no server request", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const observed = collect(output);
    const server = new ArborMCPServer(new ArborRuntime());
    let admissionCount = 0;
    server.registerTool({ name: "needs_operator_input", description: "requires operator", inputSchema: { type: "object" }, handler: async (_args, signal) => {
      const result = await server.requestOperatorInput({ message: "Confirm?", requestedSchema: { type: "object" } }, signal!);
      if (result.action !== "accept") return { ok: false, error: result.action };
      admissionCount += 1;
      return { ok: true };
    } });
    const session = await startStdioSession(server, input, output);
    try {
      input.write('{"jsonrpc":"2.0","id":60,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"matrix","version":"1"}}}\n');
      await response(observed, 60);
      input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      input.write('{"jsonrpc":"2.0","id":"no-elicitation","method":"tools/call","params":{"name":"needs_operator_input"}}\n');
      expect(await response(observed, "no-elicitation")).toMatchObject({ result: { isError: true } });
      expect(observed.lines().map((line) => JSON.parse(line) as Record<string, unknown>).some((line) => line.method === "elicitation/create")).toBe(false);
      expect(admissionCount).toBe(0);
    } finally { await session.close(); }
  });

  it("rejects an oversized request frame and resumes at the next bounded frame", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const observed = collect(output);
    const session = await startStdioSession(new ArborMCPServer(new ArborRuntime()), input, output);
    try {
      input.write('{"jsonrpc":"2.0","id":10,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"matrix","version":"1"}}}\n');
      await response(observed, 10);
      input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      input.write("x".repeat(MCP_MAX_FRAME_BYTES + 1));
      await new Promise((resolve) => setImmediate(resolve));
      input.write("\n{\"jsonrpc\":\"2.0\",\"id\":11,\"method\":\"ping\"}\n");
      const ping = await response(observed, 11);
      expect(ping.result).toEqual({});
      const frameRefusal = observed.lines().map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => (line.error as { message?: string } | undefined)?.message?.includes("exceeds byte bound"));
      expect(frameRefusal).toMatchObject({ error: { code: -32600 } });
    } finally {
      await session.close();
    }
  });
});
