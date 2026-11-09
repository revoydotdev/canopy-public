import { describe, expect, it } from "vitest";

import {
  AnthropicMessagesAdapterError,
  createAnthropicMessagesModelPort,
} from "../src/anthropic-messages.js";
import type { NativeModelRequest } from "../src/native-worker.js";
import type { NativeInferenceDelta } from "../src/inference.js";

const request = (overrides: Partial<NativeModelRequest> = {}): NativeModelRequest => ({
  session_id: "session-1",
  turn: 1,
  prompt: "make the requested change",
  history: [],
  profile: { role_id: "seed" },
  governed_context: { instructions: [], artifacts: [] },
  context: null,
  structured_output: null,
  ...overrides,
});

/** Builds a raw Anthropic-shaped SSE body from ordered event payloads. */
function anthropicSse(...events: Array<Record<string, unknown>>): Response {
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function textResponse(text: string, usage: Record<string, unknown> = { input_tokens: 5, output_tokens: 3 }): Response {
  return anthropicSse(
    { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5", usage: { input_tokens: usage.input_tokens ?? 0, cache_read_input_tokens: usage.cache_read_input_tokens ?? 0, cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: usage.output_tokens ?? 0 } },
    { type: "message_stop" },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }

describe("Anthropic Messages native model port", () => {
  it("shapes a request with system/tools/messages and a cache_control breakpoint on the stable prefix", async () => {
    let body: Record<string, unknown> | null = null;
    const model = createAnthropicMessagesModelPort({
      fetch: async (_url, init) => { body = JSON.parse(String(init?.body)); return textResponse("ok"); },
      base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-sonnet-5", observed_at: "2026-08-24T00:00:00.000Z", credential_required: false,
      tools: [{ name: "file.read", description: "read a file", parameters: { type: "object" }, risk: "low" }],
    });
    await model.run(request(), null, new AbortController().signal);

    expect(body).toMatchObject({ model: "claude-sonnet-5", stream: true, max_tokens: expect.any(Number) });
    const system = (body as unknown as { system: Array<Record<string, unknown>> }).system;
    expect(system).toHaveLength(1);
    expect(system[0]).toMatchObject({ type: "text", cache_control: { type: "ephemeral" } });
    expect(String(system[0]!.text)).toContain("Role: seed");
    const tools = (body as unknown as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools).toEqual([{ name: "file_read__c978089e2b8a7383", description: "read a file", input_schema: { type: "object" } }]);
    // Render order is tools -> system -> messages; a single breakpoint on the
    // last system block already caches tools + system together, so the tool
    // definition itself carries no separate cache_control marker.
    expect(tools[0]).not.toHaveProperty("cache_control");
  });

  it("normalizes a top-level union for Anthropic while retaining shared requirements", async () => {
    let body: Record<string, unknown> | null = null;
    const canonical = {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" }, create: { type: "boolean" }, expected_sha256: { type: "string" } },
      oneOf: [
        { required: ["path", "content", "create"] },
        { required: ["path", "content", "expected_sha256"] },
      ],
      additionalProperties: false,
    };
    const model = createAnthropicMessagesModelPort({
      fetch: async (_url, init) => { body = JSON.parse(String(init?.body)); return textResponse("ok"); },
      base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-sonnet-5", observed_at: "2026-08-24T00:00:00.000Z", credential_required: false,
      tools: [{ name: "file.write", description: "guarded write", parameters: canonical, risk: "high" }],
    });
    await model.run(request(), null, new AbortController().signal);

    const tools = (body as unknown as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools[0]!.input_schema).toEqual({ type: "object", properties: canonical.properties, required: ["path", "content"], additionalProperties: false });
    expect(canonical).toHaveProperty("oneOf");
  });

  it("omits every tool definition during a reserved final response turn", async () => {
    let body: Record<string, unknown> | null = null;
    const model = createAnthropicMessagesModelPort({
      fetch: async (_url, init) => { body = JSON.parse(String(init?.body)); return textResponse("finished"); },
      base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-sonnet-5", observed_at: "2026-08-24T00:00:00.000Z", credential_required: false,
      tools: [{ name: "file.patch", description: "patch a file", parameters: { type: "object" }, risk: "low" }],
    });
    await model.run(request({ tools_allowed: false }), null, new AbortController().signal);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
  });

  it("parses a streamed tool_use response into the harness's tool_call shape", async () => {
    const model = createAnthropicMessagesModelPort({
      fetch: async () => anthropicSse(
        { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5", usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "file_read__c978089e2b8a7383", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":' } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"README.md"}' } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } },
        { type: "message_stop" },
      ),
      base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-sonnet-5", observed_at: "2026-08-24T00:00:00.000Z",
      tools: [{ name: "file.read", description: "read a file", parameters: { type: "object" }, risk: "low" }],
    });

    const deltas: NativeInferenceDelta[] = [];
    for await (const delta of model.stream!(request(), "secret", new AbortController().signal)) deltas.push(delta);

    expect(deltas).toContainEqual({ kind: "tool_call", call_id: "toolu_1", tool: "file.read", input: { path: "README.md" }, input_summary: "provider requested file.read", risk: "low", context_refs: [] });
  });

  // ADR-109 O2/O4: extended thinking must round-trip -- parsed instead of
  // discarded, carried through history, and replayed to the next request
  // with its `signature` unmodified. `content_block_start` used to treat
  // any non-text/tool_use block (including `thinking`) as an opaque,
  // discarded placeholder (~line 383 before this fix).
  it("parses a streamed thinking block (with its signature) instead of discarding it as an unrecognized block kind", async () => {
    const model = createAnthropicMessagesModelPort({
      fetch: async () => anthropicSse(
        { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me consider the " } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "options." } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc123-opaque-token" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Here is the answer." } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } },
        { type: "message_stop" },
      ),
      base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-sonnet-5", observed_at: "2026-08-24T00:00:00.000Z",
    });

    const response = await model.run(request(), "secret", new AbortController().signal);
    expect(response.thinking).toEqual([{ text: "Let me consider the options.", signature: "sig-abc123-opaque-token" }]);
    expect(response.final_message).toBe("Here is the answer.");
  });

  it("replays a thinking history entry's signature to the next request unmodified and in original order (ADR-109 O4)", async () => {
    let body: Record<string, unknown> | null = null;
    const model = createAnthropicMessagesModelPort({
      fetch: async (_url, init) => { body = JSON.parse(String(init?.body)); return textResponse("continuing"); },
      base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-sonnet-5", observed_at: "2026-08-24T00:00:00.000Z", credential_required: false,
    });
    const capturedSignature = "sig-verbatim-do-not-mutate-9f3a";
    await model.run(request({
      history: [
        { kind: "thinking", text: "Reasoning about the plan.", signature: capturedSignature },
        { kind: "model_text", text: "I will proceed." },
        { kind: "tool_result", tool: "file.read", call_id: "toolu_1", text: "file contents" },
      ],
    }), null, new AbortController().signal);

    const messages = (body as unknown as { messages: Array<Record<string, unknown>> }).messages;
    expect(messages[0]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Reasoning about the plan.", signature: capturedSignature },
        { type: "text", text: "I will proceed." },
      ],
    });
    // The signature reaches the outbound request body byte-for-byte.
    expect(JSON.stringify(body)).toContain(capturedSignature);
    expect(messages[1]).toMatchObject({ role: "user" });
  });

  it("keeps a turn with no thinking entry on the original plain-text collapse (additive, not a rewrite of every message shape)", async () => {
    let body: Record<string, unknown> | null = null;
    const model = createAnthropicMessagesModelPort({
      fetch: async (_url, init) => { body = JSON.parse(String(init?.body)); return textResponse("continuing"); },
      base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-sonnet-5", observed_at: "2026-08-24T00:00:00.000Z", credential_required: false,
    });
    await model.run(request({ history: [{ kind: "model_text", text: "plain assistant text" }] }), null, new AbortController().signal);
    const messages = (body as unknown as { messages: Array<Record<string, unknown>> }).messages;
    expect(messages[0]).toEqual({ role: "assistant", content: "plain assistant text" });
  });

  it("maps dotted Arbor tool names through Anthropic's restricted wire grammar and back", async () => {
    let body: Record<string, unknown> | null = null;
    const model = createAnthropicMessagesModelPort({
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return anthropicSse(
          { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 } } },
          { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "file_read__c978089e2b8a7383", input: {} } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"README.md"}' } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } },
          { type: "message_stop" },
        );
      },
      base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-sonnet-5", observed_at: "2026-08-24T00:00:00.000Z",
      tools: [{ name: "file.read", description: "read a file", parameters: { type: "object" }, risk: "low" }],
    });

    const response = await model.run(request(), "secret", new AbortController().signal);
    expect((body as unknown as { tools: Array<{ name: string }> }).tools[0]!.name).toBe("file_read__c978089e2b8a7383");
    expect(response.tool_calls[0]).toMatchObject({ tool: "file.read", input_summary: "provider requested file.read" });
  });

  it("recovers from a provider tool_use outside the composed set instead of throwing a fatal protocol error", async () => {
    const model = createAnthropicMessagesModelPort({
      fetch: async () => anthropicSse(
        { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5", usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "grep.search", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } },
        { type: "message_stop" },
      ),
      base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-sonnet-5", observed_at: "2026-08-24T00:00:00.000Z",
      tools: [{ name: "file.read", description: "read a file", parameters: { type: "object" }, risk: "low" }],
    });

    const response = await model.run(request(), "secret", new AbortController().signal);

    expect(response.tool_calls).toEqual([{ call_id: "toolu_1", tool: "grep.search", input: null, input_summary: "provider requested uncomposed tool grep.search", risk: "low", context_refs: [], uncomposed: { available_tools: ["file.read"] } }]);
    expect(response.final_message).toBeNull();
  });

  it("round-trips a tool_result history entry as plain conversation text (no real tool_use/tool_result pairing across turns)", async () => {
    let body: Record<string, unknown> | null = null;
    const model = createAnthropicMessagesModelPort({
      fetch: async (_url, init) => { body = JSON.parse(String(init?.body)); return textResponse("continuing"); },
      base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-sonnet-5", observed_at: "2026-08-24T00:00:00.000Z", credential_required: false,
    });
    await model.run(request({ history: [{ kind: "tool_result", tool: "file.read", call_id: "toolu_1", text: "file contents" }] }), null, new AbortController().signal);
    const messages = (body as unknown as { messages: Array<Record<string, unknown>> }).messages;
    expect(messages[0]).toMatchObject({ role: "user" });
    expect(String(messages[0]!.content)).toContain("Tool file.read (toolu_1) returned:\nfile contents");
  });

  it("extracts usage (input/output/cache tokens) from message_start and message_delta", async () => {
    const model = createAnthropicMessagesModelPort({
      fetch: async () => textResponse("done", { input_tokens: 20, cache_read_input_tokens: 4, cache_creation_input_tokens: 2, output_tokens: 9 }),
      base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-sonnet-5", observed_at: "2026-08-24T00:00:00.000Z",
    });
    const response = await model.run(request(), "secret", new AbortController().signal);
    expect(response.usage_and_cost).toEqual({
      tokens: { kind: "measured", input_tokens: 20, output_tokens: 9, cache_read_tokens: 4, cache_write_tokens: 2 },
      cost: { kind: "unpriced", reason: "Anthropic Messages response does not include an attributable price schedule" },
    });
  });

  it("emits an Anthropic image content block for a governed image artifact", async () => {
    let body: Record<string, unknown> | null = null;
    const model = createAnthropicMessagesModelPort({
      fetch: async (_url, init) => { body = JSON.parse(String(init?.body)); return textResponse("seen"); },
      base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-sonnet-5", observed_at: "2026-08-24T00:00:00.000Z", credential_required: false,
      image_input: { max_images: 2, max_bytes_per_image: 1024 },
    });
    await model.run(request({ governed_context: { instructions: [], artifacts: [{ artifact_id: "screen-1", media_type: "image/png", encoding: "base64", content: "aGVsbG8=", provenance: { tag: "generated", generator: "fixture", input_hash: `sha256:${"a".repeat(64)}` } }] } }), null, new AbortController().signal);
    const messages = (body as unknown as { messages: Array<Record<string, unknown>> }).messages;
    const lastContent = messages.at(-1)!.content as Array<Record<string, unknown>>;
    expect(lastContent).toContainEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } });
    expect(model.identity?.capabilities).toContainEqual(expect.objectContaining({ capability: "image_input", available: true }));
  });

  it("rejects uncomposed or malformed governed image input before provider dispatch", async () => {
    let calls = 0;
    const artifact = { artifact_id: "screen-1", media_type: "image/png", encoding: "base64" as const, content: "not base64", provenance: { tag: "generated" as const, generator: "fixture", input_hash: `sha256:${"b".repeat(64)}` } };
    const model = createAnthropicMessagesModelPort({ fetch: async () => { calls += 1; return textResponse("x"); }, base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-sonnet-5", observed_at: "2026-08-24T00:00:00.000Z", credential_required: false });
    await expect(model.run(request({ governed_context: { instructions: [], artifacts: [artifact] } }), null, new AbortController().signal)).rejects.toThrow("image capability was not composed");
    expect(calls).toBe(0);
  });

  it("types an absent credential rather than crashing when the provider requires one", async () => {
    const model = createAnthropicMessagesModelPort({
      fetch: async () => { throw new Error("must not be called"); },
      base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-sonnet-5", observed_at: "2026-08-24T00:00:00.000Z",
    });
    let error: unknown;
    try { for await (const _delta of model.stream!(request(), null, new AbortController().signal)) { /* rejection expected */ } } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(AnthropicMessagesAdapterError);
    expect((error as AnthropicMessagesAdapterError).kind).toBe("credential");
    expect(model.classify_failure!(error)).toEqual({ kind: "terminal", reason: "credential" });
  });

  it("uses x-api-key and anthropic-version headers, never a bearer token", async () => {
    let init: RequestInit | undefined;
    const model = createAnthropicMessagesModelPort({
      fetch: async (_url, options) => { init = options; return textResponse("ok"); },
      base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-sonnet-5", observed_at: "2026-08-24T00:00:00.000Z",
    });
    await model.run(request(), "opaque-lease-secret", new AbortController().signal);
    expect(init?.headers).toMatchObject({ "x-api-key": "opaque-lease-secret", "anthropic-version": "2023-06-01" });
    expect(isRecord(init?.headers) ? init.headers : Object.fromEntries(new Headers(init?.headers))).not.toHaveProperty("authorization");
  });

  it("credential_mechanism: oauth_bearer sends Authorization: Bearer plus the OAuth beta header, never x-api-key", async () => {
    let init: RequestInit | undefined;
    const model = createAnthropicMessagesModelPort({
      fetch: async (_url, options) => { init = options; return textResponse("ok"); },
      base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-sonnet-5", observed_at: "2026-08-24T00:00:00.000Z",
      credential_mechanism: "oauth_bearer",
    });
    await model.run(request(), "fixture-claude-oauth-token", new AbortController().signal);
    const headers = isRecord(init?.headers) ? init.headers : Object.fromEntries(new Headers(init?.headers));
    expect(headers).toMatchObject({ authorization: "Bearer fixture-claude-oauth-token", "anthropic-beta": "oauth-2025-04-20", "anthropic-version": "2023-06-01" });
    expect(headers).not.toHaveProperty("x-api-key");
  });

  it("rejects an unrecognized credential_mechanism at composition time", () => {
    expect(() => createAnthropicMessagesModelPort({
      fetch: async () => textResponse("ok"),
      base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-sonnet-5", observed_at: "2026-08-24T00:00:00.000Z",
      // @ts-expect-error -- intentionally invalid to exercise the runtime guard
      credential_mechanism: "bearer",
    })).toThrow(AnthropicMessagesAdapterError);
  });

  it("classifies a 429 HTTP failure as retryable and a 400 as terminal", async () => {
    const rateLimited = createAnthropicMessagesModelPort({
      fetch: async () => new Response("", { status: 429, headers: { "retry-after": "3" } }),
      base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-sonnet-5", observed_at: "2026-08-24T00:00:00.000Z",
    });
    let rateLimitError: unknown;
    try { for await (const _delta of rateLimited.stream!(request(), "secret", new AbortController().signal)) { /* rejects first */ } } catch (caught) { rateLimitError = caught; }
    expect(rateLimited.classify_failure!(rateLimitError)).toEqual({ kind: "retryable", reason: "HTTP 429", retry_after_ms: 3_000 });

    const badRequest = createAnthropicMessagesModelPort({
      fetch: async () => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "tools.0.name: invalid name" } }), { status: 400 }),
      base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-sonnet-5", observed_at: "2026-08-24T00:00:00.000Z",
    });
    let badRequestError: unknown;
    try { for await (const _delta of badRequest.stream!(request(), "secret", new AbortController().signal)) { /* rejects first */ } } catch (caught) { badRequestError = caught; }
    expect(badRequest.classify_failure!(badRequestError)).toEqual({ kind: "terminal", reason: "http" });
    expect(badRequestError).toMatchObject({ message: "Anthropic Messages provider returned HTTP 400: invalid_request_error: tools.0.name: invalid name" });
  });

  it("does not retain an oversized provider error body", async () => {
    const model = createAnthropicMessagesModelPort({
      fetch: async () => new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "x".repeat(2_000) } }), { status: 400 }),
      base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-sonnet-5", observed_at: "2026-08-24T00:00:00.000Z",
    });
    let error: unknown;
    try { for await (const _delta of model.stream!(request(), "secret", new AbortController().signal)) { /* rejects first */ } } catch (caught) { error = caught; }
    expect(error).toMatchObject({ message: "Anthropic Messages provider returned HTTP 400" });
  });

  it("classifies a stream-level billing_error event with HTTP status 402, not 403", async () => {
    const model = createAnthropicMessagesModelPort({
      fetch: async () => anthropicSse(
        { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 } } },
        { type: "error", error: { type: "billing_error", message: "Payment required" } },
      ),
      base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-sonnet-5", observed_at: "2026-08-24T00:00:00.000Z",
    });
    let error: unknown;
    try { for await (const _delta of model.stream!(request(), "secret", new AbortController().signal)) { /* rejects */ } } catch (caught) { error = caught; }
    expect((error as AnthropicMessagesAdapterError).status).toBe(402);
  });

  it("reports usage as explicitly unavailable, not silently absent, when the provider stream completes without measured token counts", async () => {
    const model = createAnthropicMessagesModelPort({
      fetch: async () => anthropicSse(
        { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5" } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "no usage reported" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
        { type: "message_stop" },
      ),
      base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-sonnet-5", observed_at: "2026-08-24T00:00:00.000Z",
    });
    const response = await model.run(request(), "secret", new AbortController().signal);
    expect(response.usage_and_cost).toBeDefined();
    expect(response.usage_and_cost).toMatchObject({ tokens: { kind: "unavailable" } });
  });

  it("classifies a stream-level overloaded_error event as retryable", async () => {
    const model = createAnthropicMessagesModelPort({
      fetch: async () => anthropicSse(
        { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 } } },
        { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
      ),
      base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-sonnet-5", observed_at: "2026-08-24T00:00:00.000Z",
    });
    let error: unknown;
    try { for await (const _delta of model.stream!(request(), "secret", new AbortController().signal)) { /* rejects */ } } catch (caught) { error = caught; }
    expect(model.classify_failure!(error)).toEqual({ kind: "retryable", reason: "HTTP 529", retry_after_ms: null });
  });

  it("sends output_config.format for a composed structured schema and parses the guaranteed-JSON final text", async () => {
    const model = createAnthropicMessagesModelPort({
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body.output_config).toEqual({ format: { type: "json_schema", schema: { type: "object" } } });
        return textResponse('{"approved":false}');
      },
      base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-sonnet-5", observed_at: "2026-08-24T00:00:00.000Z",
      structured_schemas: [{ schema_id: "critic.v1", name: "critic_verdict", schema: { type: "object" } }],
    });
    const response = await model.run(request({ structured_output: { schema_id: "critic.v1" } }), "secret", new AbortController().signal);
    expect(response.structured_output).toEqual({ approved: false });
  });

  it("maps a composed human-input tool_use into a typed request rather than a host tool", async () => {
    const model = createAnthropicMessagesModelPort({
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { tools?: Array<{ name?: string }> };
        expect(body.tools?.map((tool) => tool.name)).toContain("request_human_input");
        return anthropicSse(
          { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 } } },
          { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_ask", name: "request_human_input", input: {} } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"request_id":"scope","question":"Which scope?","reason":"ambiguous"}' } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
          { type: "message_stop" },
        );
      },
      base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-sonnet-5", observed_at: "2026-08-24T00:00:00.000Z",
      human_input_tool: {},
    });
    const deltas: NativeInferenceDelta[] = [];
    for await (const delta of model.stream!(request(), "secret", new AbortController().signal)) deltas.push(delta);
    expect(deltas).toContainEqual({ kind: "human_input", request: { request_id: "scope", question: "Which scope?", reason: "ambiguous", evidence: [] } });
  });

  it("fails closed at construction when a caller composes an unverifiable response revision pin", () => {
    expect(() => createAnthropicMessagesModelPort({
      fetch: async () => textResponse("x"), base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-sonnet-5",
      observed_at: "2026-08-24T00:00:00.000Z",
      // @ts-expect-error -- Anthropic exposes no revision evidence; this option intentionally accepts only null/undefined.
      revision: "pinned-revision",
    })).toThrow("revision");
  });

  it("defaults prompt caching on with the 5m tier and honors an explicit 1h opt-in", async () => {
    let defaultBody: Record<string, unknown> | null = null;
    const defaultModel = createAnthropicMessagesModelPort({
      fetch: async (_url, init) => { defaultBody = JSON.parse(String(init?.body)); return textResponse("ok"); },
      base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-sonnet-5", observed_at: "2026-08-24T00:00:00.000Z", credential_required: false,
    });
    await defaultModel.run(request(), null, new AbortController().signal);
    const defaultSystem = (defaultBody as unknown as { system: Array<Record<string, unknown>> }).system;
    expect(defaultSystem[0]!.cache_control).toEqual({ type: "ephemeral" });

    let hourBody: Record<string, unknown> | null = null;
    const hourModel = createAnthropicMessagesModelPort({
      fetch: async (_url, init) => { hourBody = JSON.parse(String(init?.body)); return textResponse("ok"); },
      base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-sonnet-5", observed_at: "2026-08-24T00:00:00.000Z", credential_required: false,
      prompt_caching: { ttl: "1h" },
    });
    await hourModel.run(request(), null, new AbortController().signal);
    const hourSystem = (hourBody as unknown as { system: Array<Record<string, unknown>> }).system;
    expect(hourSystem[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

    let disabledBody: Record<string, unknown> | null = null;
    const disabledModel = createAnthropicMessagesModelPort({
      fetch: async (_url, init) => { disabledBody = JSON.parse(String(init?.body)); return textResponse("ok"); },
      base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-sonnet-5", observed_at: "2026-08-24T00:00:00.000Z", credential_required: false,
      prompt_caching: { enabled: false },
    });
    await disabledModel.run(request(), null, new AbortController().signal);
    const disabledSystem = (disabledBody as unknown as { system: Array<Record<string, unknown>> }).system;
    expect(disabledSystem[0]).not.toHaveProperty("cache_control");
  });

  it("fails closed when a worker requests a schema the adapter was not composed to serve", async () => {
    let calls = 0;
    const model = createAnthropicMessagesModelPort({
      fetch: async () => { calls += 1; return textResponse("x"); },
      base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-sonnet-5", observed_at: "2026-08-24T00:00:00.000Z",
    });
    await expect((async () => {
      for await (const _delta of model.stream!(request({ structured_output: { schema_id: "uncomposed.v1" } }), "secret", new AbortController().signal)) { /* rejection expected */ }
    })()).rejects.toThrow("schema was not composed");
    expect(calls).toBe(0);
  });

  it("fails closed when the streamed response model identity does not match the configured model", async () => {
    const model = createAnthropicMessagesModelPort({
      fetch: async () => textResponse("done"), // message_start declares "claude-sonnet-5"
      base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-opus-5", observed_at: "2026-08-24T00:00:00.000Z",
    });
    await expect((async () => { for await (const _delta of model.stream!(request(), "secret", new AbortController().signal)) { /* rejection expected */ } })())
      .rejects.toThrow("model identity did not match");
  });
});
