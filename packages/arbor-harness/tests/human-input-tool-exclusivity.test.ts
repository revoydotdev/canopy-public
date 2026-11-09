import { describe, expect, it } from "vitest";
import { createOpenAICompatibleModelPort } from "../src/openai-compatible.js";
import { createAnthropicMessagesModelPort } from "../src/anthropic-messages.js";
import type { NativeModelRequest } from "../src/native-worker.js";

/**
 * The human-input tool is exclusive, and both adapters ENFORCE that:
 *
 *   openai-compatible.ts:  if (calls.size !== 1) throw ... "human-input
 *                          handoff cannot be combined with other provider
 *                          tool calls"
 *   anthropic-messages.ts: the identical guard
 *
 * Neither used to STATE it in the description the model actually reads, while
 * the tool protocol tells the model it may "request several calls in one turn
 * only when they are independent". So the model did the natural thing — asked
 * the operator a question alongside real work — and the host killed the whole
 * campaign with a protocol error surfaced as `internal_error`.
 *
 * This asserts on the outgoing WIRE body, so the description and the guard
 * cannot drift apart again.
 */
const OBSERVED_AT = "2026-09-27T00:00:00.000Z";

const request = (): NativeModelRequest => ({
  session_id: "session-1",
  turn: 1,
  prompt: "make the requested change",
  history: [],
  profile: { role_id: "seed" },
  governed_context: { instructions: [], artifacts: [] },
  context: null,
  structured_output: null,
  tools_allowed: true,
} as NativeModelRequest);

const sse = (...events: string[]): Response =>
  new Response(events.map((event) => `data: ${event}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });

function toolNamed(tools: unknown, name: string): { function: { name: string; description: string } } | null {
  if (!Array.isArray(tools)) return null;
  for (const entry of tools) {
    const candidate = entry as { function?: { name?: string; description?: string }; name?: string; description?: string };
    const n = candidate.function?.name ?? candidate.name;
    if (n === name || n?.endsWith(name)) {
      return { function: { name: n ?? name, description: candidate.function?.description ?? candidate.description ?? "" } };
    }
  }
  return null;
}

describe("human-input tool description states its exclusivity", () => {
  it("openai-compatible: the wire description tells the model to call it alone", async () => {
    const seen: { body: Record<string, unknown> | null } = { body: null };
    const model = createOpenAICompatibleModelPort({
      fetch: async (_url, init) => { seen.body = JSON.parse(String(init?.body)) as Record<string, unknown>; return sse(JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }), "[DONE]"); },
      base_url: "https://model.invalid", provider_id: "openrouter", model_id: "stealth/space-bunny-alpha", observed_at: OBSERVED_AT,
      tools: [{ name: "file.patch", description: "patch a file", parameters: { type: "object" }, risk: "low" }],
      human_input_tool: { name: "request_human_input" },
      credential_required: false,
    });

    await model.run(request(), null, new AbortController().signal);

    const tool = toolNamed(seen.body?.tools, "request_human_input");
    expect(tool, "human-input tool must be advertised on the wire").not.toBeNull();
    expect(tool!.function.description).toMatch(/ONLY tool call/i);
  });

  it("anthropic-messages: the wire description tells the model to call it alone", async () => {
    const seen: { body: Record<string, unknown> | null } = { body: null };
    const model = createAnthropicMessagesModelPort({
      fetch: async (_url, init) => {
        seen.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sse(
          JSON.stringify({ type: "message_start", message: { id: "m", role: "assistant", content: [], model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 0 } } }),
          JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
          JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
          JSON.stringify({ type: "content_block_stop", index: 0 }),
          JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
          JSON.stringify({ type: "message_stop" }),
        );
      },
      base_url: "https://api.anthropic.invalid", provider_id: "anthropic", model_id: "claude-sonnet-5", observed_at: OBSERVED_AT,
      tools: [{ name: "file.patch", description: "patch a file", parameters: { type: "object" }, risk: "low" }],
      human_input_tool: {},
    });

    if (model.stream) for await (const _delta of model.stream(request(), "secret", new AbortController().signal)) { /* drain */ }

    const tool = toolNamed(seen.body?.tools, "request_human_input");
    expect(tool, "human-input tool must be advertised on the wire").not.toBeNull();
    expect(tool!.function.description).toMatch(/ONLY tool call/i);
  });

  it("both adapters point at userinput.ask as the non-blocking alternative", async () => {
    const seen: { body: Record<string, unknown> | null } = { body: null };
    const openai = createOpenAICompatibleModelPort({
      fetch: async (_url, init) => { seen.body = JSON.parse(String(init?.body)) as Record<string, unknown>; return sse(JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }), "[DONE]"); },
      base_url: "https://model.invalid", provider_id: "openrouter", model_id: "m", observed_at: OBSERVED_AT,
      human_input_tool: { name: "request_human_input" },
      credential_required: false,
    });
    await openai.run(request(), null, new AbortController().signal);

    const tool = toolNamed(seen.body?.tools, "request_human_input");
    expect(tool!.function.description).toMatch(/userinput\.ask/);
  });
});
