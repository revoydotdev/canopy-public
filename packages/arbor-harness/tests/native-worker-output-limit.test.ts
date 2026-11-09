/**
 * UCT Stage 0 Revision 2.2 pilot (docs/research/uct-search/stage0-pilot3-report-2026-10-07.md).
 *
 * - H6: the worker ignored the provider's length stop. 13 specialist sessions
 *   spent a whole 8,000-token turn reasoning and were ended as "no progress",
 *   and one turn's cut-off text was accepted as the specialist's final claim.
 *   Every adapter now reports a typed stop reason; the worker never accepts a
 *   cut-off turn as a result, gives the model a bounded continuation turn, and
 *   ends a session that keeps hitting the limit without a tool call with a
 *   typed reason.
 * - H7: a structured reply that was not JSON ended the session at once; only
 *   JSON the contract rejected got the bounded correction turns. Both now do.
 * - D3: a turn that failed after its stream completed lost its usage record.
 *
 * Every provider here is a scripted model port or a fake streaming fetch;
 * nothing leaves the process.
 */
import { describe, expect, it } from "vitest";

import { createAnthropicMessagesModelPort, type AnthropicMessagesFetch } from "../src/anthropic-messages.js";
import type { CapabilitySupport } from "../src/capabilities.js";
import { nativeAbortedTurnUsage, type NativeInferenceDelta, type NativeStructuredOutputContract } from "../src/inference.js";
import { NativeSessionEngine } from "../src/native-session.js";
import {
  MAX_OUTPUT_LIMIT_CONTINUATIONS,
  NATIVE_WORKER_OUTPUT_LIMIT_CODE,
  NativeHarnessWorker,
  type NativeModelPort,
  type NativeModelRequest,
  type NativeModelResponse,
  type NativeToolResponse,
} from "../src/native-worker.js";
import { createOpenAICompatibleModelPort, type OpenAICompatibleFetch } from "../src/openai-compatible.js";
import type { ExecutionPolicy, SessionStartRequest } from "../src/protocol.js";

const capabilities = [
  "streaming", "interruption", "resumption", "forking", "ephemeral_sessions", "structured_output", "tool_policy", "workspace_isolation", "approval_mediation", "usage_reporting", "artifact_capture", "remote_transport",
].map((capability) => ({ capability, grade: "native", evidence: { implementation_id: "native-reference", observed_at: "2026-10-07T00:00:00.000Z", detail: "native conformance" } })) as readonly CapabilitySupport[];

const policy: ExecutionPolicy = {
  filesystem: "read_only", approvals: "never", tool_allow: ["read"], tool_deny: [], workspace_roots: ["/workspace"], max_wall_clock_ms: 3_600_000, max_events: 400,
  network_allowed: false, ambient_plugins_allowed: false, user_configuration_allowed: false, inherited_credentials_allowed: false,
};
const start = (sessionId: string): SessionStartRequest => ({ session_id: sessionId, policy, required_capabilities: [], lineage: { kind: "new" }, ephemeral: false });

const readTool = {
  tool: "read",
  async execute(): Promise<NativeToolResponse> {
    return { result_summary: "read", model_output: "source text", evidence: { outcome: "succeeded", stage: "execution", code: "ok", effect: "observed", action_scope: { status: "not_required" } } };
  },
};

const usage = { tokens: { kind: "measured" as const, input_tokens: 100, output_tokens: 8_000, cache_read_tokens: 0, cache_write_tokens: 0 }, cost: { kind: "unpriced" as const, reason: "fixture" } };
const cutOff = (text: string): NativeModelResponse => ({ text: text.length === 0 ? [] : [{ text, phase: "final" }], tool_calls: [], final_message: text, stop_reason: "output_limit", usage_and_cost: usage });
const toolCall = (id: string): NativeModelResponse => ({ text: [], tool_calls: [{ call_id: id, tool: "read", input: { path: "a.ts" }, input_summary: "read a.ts", risk: "low" }], final_message: null, stop_reason: "tool_use" });
const answer = (text: string, extra: Partial<NativeModelResponse> = {}): NativeModelResponse => ({ text: [{ text, phase: "final" }], tool_calls: [], final_message: text, stop_reason: "completed", ...extra });

function scripted(responses: readonly NativeModelResponse[]): { model: NativeModelPort; requests: NativeModelRequest[] } {
  const requests: NativeModelRequest[] = [];
  return {
    requests,
    model: {
      async run(request) {
        requests.push(request);
        const response = responses[requests.length - 1];
        if (response === undefined) throw new Error(`no scripted response for turn ${requests.length}`);
        return response;
      },
    },
  };
}

async function runWorker(responses: readonly NativeModelResponse[], options: { maxTurns?: number; contract?: NativeStructuredOutputContract; sessionId?: string } = {}) {
  const sessionId = options.sessionId ?? "output-limit";
  const engine = new NativeSessionEngine({ clock: { now: () => 1_700_000_000_000 }, capabilities });
  const { model, requests } = scripted(responses);
  const result = await new NativeHarnessWorker({ session_engine: engine, model, tools: [readTool] })
    .run({ start: start(sessionId), prompt: "do the work", max_turns: options.maxTurns ?? 8, ...(options.contract === undefined ? {} : { structured_output: options.contract }) });
  const events = engine.observe(sessionId);
  const diagnostics = events.flatMap((event) => event.kind === "diagnostic" ? [event.payload] : []);
  return { result, requests, events, diagnostics };
}

describe("H6: a turn cut off at the output-token limit", () => {
  it("is never accepted as the final result, even when it carries text", async () => {
    const { result, diagnostics } = await runWorker([cutOff("I have analysed the queue and will now edit the fi")], { maxTurns: 1 });

    expect(result.session.state).toBe("failed");
    expect(result.session.terminal?.message ?? "").not.toContain("will now edit");
    expect(diagnostics.at(-1)).toMatchObject({ code: NATIVE_WORKER_OUTPUT_LIMIT_CODE, message: expect.stringContaining("last turn") });
  });

  it("gets a bounded continuation turn that names the cut-off, and the session completes on the model's next answer", async () => {
    const { result, requests, diagnostics } = await runWorker([cutOff(""), answer("patched the queue")]);

    expect(result.session.state).toBe("completed");
    expect(result.turns_started).toBe(2);
    expect(result.session.terminal?.message).toBe("patched the queue");
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain("model_output_limit_continuation");
    expect(requests[0]!.prompt).not.toContain("cut off at the output-token limit");
    expect(requests[1]!.prompt).toContain("Your previous turn was cut off at the output-token limit");
    expect(requests[1]!.prompt).toContain("make one tool call, or give a concise final answer");
  });

  it("delivers the note once: it is consumed by the turn it reached, never carried", async () => {
    const { requests } = await runWorker([cutOff(""), toolCall("c1"), answer("done")]);
    expect(requests[1]!.prompt).toContain("cut off at the output-token limit");
    expect(requests[2]!.prompt).not.toContain("cut off at the output-token limit");
  });

  it("keeps cut-off text only as commentary, never as a final-phase answer", async () => {
    const { events } = await runWorker([cutOff("half a sentence"), answer("done")]);
    const texts = events.flatMap((event) => event.kind === "model_text" ? [event.payload] : []);
    expect(texts[0]).toMatchObject({ text: "half a sentence", phase: "commentary" });
    expect(texts[1]).toMatchObject({ text: "done", phase: "final" });
  });

  it(`ends a session that hits the limit ${MAX_OUTPUT_LIMIT_CONTINUATIONS + 1} times in a row without a tool call, with a typed reason that states the limit`, async () => {
    const { result, requests, diagnostics } = await runWorker([cutOff(""), cutOff("thinking"), cutOff(""), answer("never reached")]);

    expect(result.session.state).toBe("failed");
    expect(requests).toHaveLength(MAX_OUTPUT_LIMIT_CONTINUATIONS + 1);
    expect(diagnostics.filter((diagnostic) => diagnostic.code === "model_output_limit_continuation")).toHaveLength(MAX_OUTPUT_LIMIT_CONTINUATIONS);
    expect(diagnostics.at(-1)).toMatchObject({ code: NATIVE_WORKER_OUTPUT_LIMIT_CODE, message: expect.stringContaining(`limit: ${MAX_OUTPUT_LIMIT_CONTINUATIONS} continuation turns`) });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain("model_no_progress");
  });

  it("resets the breaker when the model acts: a tool call between cut-off turns is progress", async () => {
    const { result } = await runWorker([cutOff(""), cutOff(""), toolCall("c1"), cutOff(""), cutOff(""), answer("done")]);
    expect(result.session.state).toBe("completed");
    expect(result.turns_started).toBe(6);
  });

  it("never accepts a cut-off turn as structured output, even when its JSON parsed", async () => {
    const contract: NativeStructuredOutputContract = { schema_id: "fixture.v1", validate: () => ({ valid: true }) };
    const { result, requests } = await runWorker([
      { ...cutOff('{"approved":true}'), structured_output: { approved: true } },
      answer('{"approved":false}', { structured_output: { approved: false } }),
    ], { contract });

    expect(result.session.state).toBe("completed");
    expect(result.structured_output).toEqual({ approved: false });
    expect(requests[1]!.prompt).toContain("Reply now with only the JSON object required by fixture.v1");
  });
});

describe("H7: a structured reply that is not JSON gets the bounded correction turns", () => {
  const contract = (unparsed?: (detail: string) => string): NativeStructuredOutputContract => ({
    schema_id: "fixture.verdict.v1",
    validate: (value) => (typeof value === "object" && value !== null && "approved" in value ? { valid: true } : { valid: false, reason: "approved is required" }),
    ...(unparsed === undefined ? {} : { unparsed_reason: unparsed }),
  });
  const prose = (text: string): NativeModelResponse => answer(text, { structured_output_unparsed: "the reply was prose with no JSON value" });

  it("re-prompts with the contract's own reason, and completes on the corrected reply", async () => {
    const { result, requests, diagnostics } = await runWorker([prose("The change looks correct to me."), answer('{"approved":true}', { structured_output: { approved: true } })], {
      contract: contract((detail) => `malformed: not JSON (${detail}); send only the verdict object`),
    });

    expect(result.session.state).toBe("completed");
    expect(result.structured_output).toEqual({ approved: true });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain("structured_output_retry");
    expect(requests[1]!.prompt).toContain("malformed: not JSON (the reply was prose with no JSON value); send only the verdict object");
  });

  it("states a precise generic reason naming the schema when the contract supplies none", async () => {
    const { requests } = await runWorker([prose("prose"), answer('{"approved":true}', { structured_output: { approved: true } })], { contract: contract() });
    expect(requests[1]!.prompt).toContain("your reply was not a JSON object (the reply was prose with no JSON value); reply with only the JSON object required by fixture.verdict.v1");
  });

  it("fails as invalid structured output under the contract's reason only once the corrections are spent", async () => {
    const { result, requests, diagnostics } = await runWorker([prose("one"), prose("two"), prose("three"), prose("four")], {
      contract: contract((detail) => `malformed: not JSON (${detail})`),
    });

    expect(result.session.state).toBe("failed");
    expect(requests).toHaveLength(3);
    expect(diagnostics.filter((diagnostic) => diagnostic.code === "structured_output_retry")).toHaveLength(2);
    expect(diagnostics.at(-1)).toMatchObject({ code: "structured_output_invalid", message: "malformed: not JSON (the reply was prose with no JSON value)" });
  });
});

function sse(...events: readonly unknown[]): Response {
  return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}
function openai(fetch: OpenAICompatibleFetch, extra: { structured?: boolean; tools?: boolean } = {}) {
  return createOpenAICompatibleModelPort({
    fetch, base_url: "https://model.invalid", provider_id: "openai-compatible", model_id: "test-model", observed_at: "2026-10-07T00:00:00.000Z",
    credential_required: false, timeout_ms: null,
    ...(extra.structured ? { structured_schemas: [{ schema_id: "fixture.v1", name: "fixture", schema: { type: "object" } }] } : {}),
    ...(extra.tools ? { tools: [{ name: "read", description: "read a file", parameters: { type: "object" }, risk: "low" as const }] } : {}),
  });
}
const baseRequest: NativeModelRequest = {
  session_id: "s", turn: 1, prompt: "work", history: [], profile: { role_id: "seed" },
  governed_context: { instructions: [], artifacts: [] }, context: null, structured_output: null,
};
async function deltasOf(port: NativeModelPort, request: NativeModelRequest = baseRequest): Promise<NativeInferenceDelta[]> {
  const deltas: NativeInferenceDelta[] = [];
  for await (const delta of port.stream!(request, null, new AbortController().signal)) deltas.push(delta);
  return deltas;
}
const REPORTED = { prompt_tokens: 900, completion_tokens: 8_000 };

describe("H6 at the adapters: the provider's stop reason is typed and propagated", () => {
  it("OpenAI-compatible: a reasoning-only stream that ends finish_reason length reports output_limit and an empty final", async () => {
    const deltas = await deltasOf(openai(async () => sse({ choices: [{ delta: { reasoning: "let me think about this at length" } }] }, { choices: [{ delta: {}, finish_reason: "length" }], usage: REPORTED })));
    expect(deltas).toContainEqual({ kind: "stop", reason: "output_limit" });
    expect(deltas.at(-1)).toEqual({ kind: "final", message: "" });
  });

  it("OpenAI-compatible: a tool call cut off mid-arguments is truncation, not a protocol failure, and dispatches nothing", async () => {
    const deltas = await deltasOf(openai(async () => sse(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: '{"path":"src/q' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "length" }], usage: REPORTED },
    ), { tools: true }), { ...baseRequest, tools_allowed: true });
    expect(deltas.some((delta) => delta.kind === "tool_call")).toBe(false);
    expect(deltas).toContainEqual({ kind: "stop", reason: "output_limit" });
  });

  it("OpenAI-compatible: structured output cut off at the limit is reported unparsed, even when an inner value balances", async () => {
    const deltas = await deltasOf(openai(async () => sse({ choices: [{ delta: { content: '{"checks":[{"name":"root_cause"}],"rationale":"the cha' }, finish_reason: "length" }] }), { structured: true }), { ...baseRequest, structured_output: { schema_id: "fixture.v1" } });
    expect(deltas.at(-1)).toEqual({ kind: "final", message: '{"checks":[{"name":"root_cause"}],"rationale":"the cha', structured_output_unparsed: "the reply was cut off at the output-token limit" });
  });

  it("OpenAI-compatible through the worker: a reasoning-only cut-off turn is continued, not ended as no progress", async () => {
    let calls = 0;
    const port = openai(async () => {
      calls += 1;
      return calls === 1
        ? sse({ choices: [{ delta: { reasoning: "r".repeat(64) }, finish_reason: "length" }], usage: REPORTED })
        : sse({ choices: [{ delta: { content: "the fix is in" }, finish_reason: "stop" }], usage: { prompt_tokens: 950, completion_tokens: 12 } });
    });
    const engine = new NativeSessionEngine({ clock: { now: () => 1_700_000_000_000 }, capabilities });
    const result = await new NativeHarnessWorker({ session_engine: engine, model: port, tools: [] }).run({ start: start("openai-cutoff"), prompt: "work", max_turns: 4 });

    expect(result.session.state).toBe("completed");
    expect(result.session.terminal?.message).toBe("the fix is in");
    const events = engine.observe("openai-cutoff");
    expect(events.filter((event) => event.kind === "usage").map((event) => event.payload)).toEqual([
      { input_tokens: 900, output_tokens: 8_000 },
      { input_tokens: 950, output_tokens: 12 },
    ]);
    expect(events.some((event) => event.kind === "diagnostic" && event.payload.code === "model_no_progress")).toBe(false);
  });

  it("Anthropic Messages: stop_reason max_tokens reports output_limit, and structured output cut off there is unparsed", async () => {
    const anthropicSse = (...events: readonly unknown[]): Response => new Response(events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    const fetch: AnthropicMessagesFetch = async () => anthropicSse(
      { type: "message_start", message: { model: "claude-fixture", usage: { input_tokens: 40, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: '{"approved": tr' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 4_096 } },
      { type: "message_stop" },
    );
    const port = createAnthropicMessagesModelPort({
      fetch, base_url: "https://anthropic.invalid", provider_id: "anthropic", model_id: "claude-fixture", observed_at: "2026-10-07T00:00:00.000Z",
      credential_required: false, structured_schemas: [{ schema_id: "fixture.v1", name: "fixture", schema: { type: "object" } }],
    });
    const deltas = await deltasOf(port, { ...baseRequest, structured_output: { schema_id: "fixture.v1" } });
    expect(deltas).toContainEqual({ kind: "stop", reason: "output_limit" });
    expect(deltas.at(-1)).toEqual({ kind: "final", message: '{"approved": tr', structured_output_unparsed: "the reply was cut off at the output-token limit" });
  });
});

describe("D3: a turn that fails after its stream completed keeps its provider-reported usage", () => {
  it("OpenAI-compatible: tool arguments that are not JSON after a normal stop carry the reported usage on the error", async () => {
    const port = openai(async () => sse(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: "{not json" } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: REPORTED },
    ), { tools: true });
    let error: unknown;
    try { await deltasOf(port, { ...baseRequest, tools_allowed: true }); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ kind: "protocol", message: "OpenAI-compatible tool arguments were not JSON" });
    expect(nativeAbortedTurnUsage(error)).toMatchObject({ kind: "reported", observation: { tokens: { kind: "measured", input_tokens: 900, output_tokens: 8_000 } } });
  });

  it("the worker records that usage when the turn fails", async () => {
    const port = openai(async () => sse(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: "{not json" } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: REPORTED },
    ), { tools: true });
    const engine = new NativeSessionEngine({ clock: { now: () => 1_700_000_000_000 }, capabilities });
    const result = await new NativeHarnessWorker({ session_engine: engine, model: port, tools: [readTool] }).run({ start: start("d3-openai"), prompt: "work", max_turns: 2 });

    expect(result.session.state).toBe("failed");
    expect(engine.observe("d3-openai").find((event) => event.kind === "usage")).toMatchObject({ payload: { input_tokens: 900, output_tokens: 8_000 } });
  });

  it("the worker records a completed response's usage before failing it on a protocol invariant", async () => {
    const { result, events } = await runWorker([{ text: [], tool_calls: toolCall("c1").tool_calls, final_message: "both", usage_and_cost: usage }]);
    expect(result.session.state).toBe("failed");
    expect(events.find((event) => event.kind === "usage")).toMatchObject({ payload: { input_tokens: 100, output_tokens: 8_000 } });
  });
});
