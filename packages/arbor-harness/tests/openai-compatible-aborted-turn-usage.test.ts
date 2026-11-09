/**
 * Stage 0 re-pilot (2026-10-07) §4.2: three sessions ended when an
 * OpenAI-compatible stream crossed the 4 MiB response byte limit, and the
 * aborted turn's spend was never recorded, because the provider's usage
 * report (sent at the end of a stream) never arrived and the thrown error
 * carried nothing. The adapter now carries the turn's usage on the error —
 * the provider's report when one arrived, otherwise an explicit unpriced
 * estimate from the bytes received — and the worker records it.
 *
 * Every provider here is a fake streaming fetch; nothing leaves the process.
 */
import { describe, expect, it } from "vitest";

import type { CapabilitySupport } from "../src/capabilities.js";
import { nativeAbortedTurnUsage } from "../src/inference.js";
import { NativeSessionEngine } from "../src/native-session.js";
import { NativeHarnessWorker } from "../src/native-worker.js";
import { createOpenAICompatibleModelPort, type OpenAICompatibleFetch } from "../src/openai-compatible.js";
import type { NativeModelRequest } from "../src/native-worker.js";
import type { SessionStartRequest } from "../src/protocol.js";
import { NativeUsageBudgetController, StaticNativeModelPricingAuthority } from "../src/usage-budget.js";

const LIMIT = 4_096;
const REASONING = "r".repeat(200);
const MEASURED_USAGE = { prompt_tokens: 900, completion_tokens: 120 };

/** One SSE `data:` event carrying a reasoning delta (and, optionally, an interim usage report). */
function reasoningEvent(usage?: typeof MEASURED_USAGE): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { reasoning: REASONING } }], ...(usage === undefined ? {} : { usage }) })}\n\n`;
}

/** A fake provider whose reasoning stream never ends: only the adapter's byte limit can stop it. */
function overflowingFetch(options: { usageInFirstEvent: boolean }): { fetch: OpenAICompatibleFetch; sent: () => number } {
  let sent = 0;
  const fetch: OpenAICompatibleFetch = async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const event = new TextEncoder().encode(reasoningEvent(sent === 0 && options.usageInFirstEvent ? MEASURED_USAGE : undefined));
      sent += 1;
      controller.enqueue(event);
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  return { fetch, sent: () => sent };
}

function port(fetch: OpenAICompatibleFetch, maxOutputTokens?: number) {
  return createOpenAICompatibleModelPort({
    fetch, base_url: "https://model.invalid", provider_id: "openai-compatible", model_id: "test-model",
    observed_at: "2026-10-07T00:00:00.000Z", credential_required: false, timeout_ms: null,
    max_response_bytes: LIMIT, ...(maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }),
  });
}

const request: NativeModelRequest = {
  session_id: "session-1", turn: 1, prompt: "think", history: [], profile: { role_id: "seed" },
  governed_context: { instructions: [], artifacts: [] }, context: null, structured_output: null,
};

async function drain(model: ReturnType<typeof port>): Promise<unknown> {
  try { for await (const _delta of model.stream!(request, null, new AbortController().signal)) { /* the stream must overflow */ } } catch (error) { return error; }
  throw new Error("the overflowing stream completed");
}

describe("an OpenAI-compatible turn aborted at the response byte limit keeps its usage", () => {
  it("carries an explicit unpriced estimate from the bytes streamed when the provider sent no usage", async () => {
    const provider = overflowingFetch({ usageInFirstEvent: false });

    const error = await drain(port(provider.fetch, 8_000));

    expect(error).toMatchObject({ kind: "protocol", message: "OpenAI-compatible stream exceeded the configured response byte limit" });
    const usage = nativeAbortedTurnUsage(error);
    expect(usage).toMatchObject({ kind: "unpriced_estimate", observation: { tokens: { kind: "unavailable" }, cost: { kind: "unpriced", reason: expect.stringContaining("unpriced_estimate") } } });
    expect(usage!.response_bytes).toBeGreaterThan(LIMIT);
    // Every event before the one whose bytes crossed the limit was parsed before the abort.
    const parsedEvents = Math.floor(LIMIT / Buffer.byteLength(reasoningEvent()));
    expect(provider.sent()).toBeGreaterThan(parsedEvents);
    expect(usage).toMatchObject({ streamed_text_bytes: parsedEvents * REASONING.length, streamed_output_tokens_upper_bound: parsedEvents * REASONING.length });
  });

  it("bounds the estimate by the request's max_tokens", async () => {
    const usage = nativeAbortedTurnUsage(await drain(port(overflowingFetch({ usageInFirstEvent: false }).fetch, 50)));
    expect(usage).toMatchObject({ kind: "unpriced_estimate", streamed_output_tokens_upper_bound: 50 });
  });

  it("carries the provider's own usage report when one arrived before the abort", async () => {
    const usage = nativeAbortedTurnUsage(await drain(port(overflowingFetch({ usageInFirstEvent: true }).fetch)));
    expect(usage).toMatchObject({ kind: "reported", observation: { tokens: { kind: "measured", input_tokens: 900, output_tokens: 120 } } });
  });
});

const capabilities = [
  "streaming", "interruption", "resumption", "forking", "ephemeral_sessions", "structured_output", "tool_policy", "workspace_isolation", "approval_mediation", "usage_reporting", "artifact_capture", "remote_transport",
].map((capability) => ({ capability, grade: "native", evidence: { implementation_id: "native-reference", observed_at: "2026-10-07T00:00:00.000Z", detail: "native conformance" } })) as readonly CapabilitySupport[];

function start(sessionId: string): SessionStartRequest {
  return {
    session_id: sessionId, required_capabilities: [], lineage: { kind: "new" }, ephemeral: false,
    policy: { filesystem: "read_only", approvals: "always", tool_allow: [], tool_deny: [], workspace_roots: ["/workspace"], max_wall_clock_ms: 60_000, max_events: 40, network_allowed: false, ambient_plugins_allowed: false, user_configuration_allowed: false, inherited_credentials_allowed: false },
  };
}

function budget(): NativeUsageBudgetController {
  return new NativeUsageBudgetController({
    provider_id: "openai-compatible", model_id: "test-model", limits: {},
    pricing: new StaticNativeModelPricingAuthority({
      price_source_id: "fixture", observed_at: "2026-10-07T00:00:00.000Z", provider_id: "openai-compatible", model_id: "test-model", currency: "USD", minor_unit_exponent: 6,
      input_minor_units_per_million_tokens: 90_000, output_minor_units_per_million_tokens: 180_000, cache_read_minor_units_per_million_tokens: 9_000, cache_write_minor_units_per_million_tokens: 90_000,
    }),
  });
}

describe("the native worker records an aborted turn's usage", () => {
  it("adds a provider-reported aborted turn to the session's usage and priced spend", async () => {
    const engine = new NativeSessionEngine({ clock: { now: () => 1_700_000_000_000 }, capabilities });
    const usageBudget = budget();
    const result = await new NativeHarnessWorker({ session_engine: engine, model: port(overflowingFetch({ usageInFirstEvent: true }).fetch), tools: [], usage_budget: usageBudget })
      .run({ start: start("reported"), prompt: "think", max_turns: 1 });

    expect(result.session.state).toBe("failed");
    expect(engine.observe("reported").find((event) => event.kind === "usage")).toMatchObject({ payload: { input_tokens: 900, output_tokens: 120 } });
    expect(usageBudget.total()).toMatchObject({ tokens: { kind: "measured", input_tokens: 900, output_tokens: 120 }, cost: { kind: "priced", minor_units: 81 + 22 } });
    expect(result.usage_and_cost).toMatchObject({ tokens: { input_tokens: 900, output_tokens: 120 } });
  });

  it("records an unpriced estimate as a usage event and a diagnostic instead of dropping the turn", async () => {
    const engine = new NativeSessionEngine({ clock: { now: () => 1_700_000_000_000 }, capabilities });
    const usageBudget = budget();
    const result = await new NativeHarnessWorker({ session_engine: engine, model: port(overflowingFetch({ usageInFirstEvent: false }).fetch, 8_000), tools: [], usage_budget: usageBudget })
      .run({ start: start("estimated"), prompt: "think", max_turns: 1 });

    expect(result.session.state).toBe("failed");
    const events = engine.observe("estimated");
    expect(events.find((event) => event.kind === "usage")).toMatchObject({ payload: { input_tokens: null, output_tokens: null, unavailable_reason: expect.stringContaining("unpriced_estimate") } });
    expect(events.find((event) => event.kind === "diagnostic" && event.payload.code === "aborted_turn_usage_estimate")).toMatchObject({ payload: { message: expect.stringMatching(/at most \d+ output tokens streamed/) } });
    expect(events.at(-2)).toMatchObject({ kind: "diagnostic", payload: { code: "model_failure", message: expect.stringContaining("response byte limit") } });
  });
});
