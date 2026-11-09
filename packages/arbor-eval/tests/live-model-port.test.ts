/**
 * arbor-eval/tests/live-model-port — exercises the REAL provider adapter
 * (`createOpenAICompatibleModelPort`, `@arbor/harness`) with only the
 * network boundary (`fetch`) faked, the same pattern `staged-native-safety.ts`
 * uses for its scripted scenarios. This proves the live-provider wiring
 * itself works end to end; it never claims a real network call happened.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { callLiveModel, createLiveModelPort, resolveLiveModelConfigFromEnv, type LiveModelConfig } from "../src/live-model-port.js";

const OBSERVED_AT = "2026-08-26T00:00:00.000Z";

function sseFinal(message: string): Response {
  const payload = { choices: [{ delta: { content: message } }], usage: { prompt_tokens: 11, completion_tokens: 3 } };
  return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}
function sseNoFinal(): Response {
  const payload = { choices: [{ delta: {} }], usage: { prompt_tokens: 11, completion_tokens: 0 } };
  return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const config: LiveModelConfig = Object.freeze({
  base_url: "https://live-eval-fixture.invalid/v1",
  provider_id: "fixture-provider",
  model_id: "fixture-model",
  credential: "test-secret",
  price_per_input_token_usd: 0.000001,
  price_per_output_token_usd: 0.000002,
  max_output_tokens: 512,
});

describe("resolveLiveModelConfigFromEnv — credential honesty", () => {
  it("returns null when any required variable is missing, never a fallback config", () => {
    expect(resolveLiveModelConfigFromEnv({})).toBeNull();
    expect(resolveLiveModelConfigFromEnv({
      ARBOR_EVAL_LIVE_BASE_URL: "https://x.invalid",
      ARBOR_EVAL_LIVE_PROVIDER_ID: "p",
      ARBOR_EVAL_LIVE_MODEL_ID: "m",
      // ARBOR_EVAL_LIVE_API_KEY intentionally absent
      ARBOR_EVAL_LIVE_PRICE_INPUT_USD: "0.000001",
      ARBOR_EVAL_LIVE_PRICE_OUTPUT_USD: "0.000002",
    })).toBeNull();
  });

  it("returns null when a price is not a valid non-negative number", () => {
    expect(resolveLiveModelConfigFromEnv({
      ARBOR_EVAL_LIVE_BASE_URL: "https://x.invalid",
      ARBOR_EVAL_LIVE_PROVIDER_ID: "p",
      ARBOR_EVAL_LIVE_MODEL_ID: "m",
      ARBOR_EVAL_LIVE_API_KEY: "secret",
      ARBOR_EVAL_LIVE_PRICE_INPUT_USD: "not-a-number",
      ARBOR_EVAL_LIVE_PRICE_OUTPUT_USD: "0.000002",
    })).toBeNull();
  });

  it("builds a real config from a fully-populated environment", () => {
    const resolved = resolveLiveModelConfigFromEnv({
      ARBOR_EVAL_LIVE_BASE_URL: "https://x.invalid",
      ARBOR_EVAL_LIVE_PROVIDER_ID: "p",
      ARBOR_EVAL_LIVE_MODEL_ID: "m",
      ARBOR_EVAL_LIVE_API_KEY: "secret",
      ARBOR_EVAL_LIVE_PRICE_INPUT_USD: "0.000001",
      ARBOR_EVAL_LIVE_PRICE_OUTPUT_USD: "0.000002",
    });
    expect(resolved).toMatchObject({ base_url: "https://x.invalid", provider_id: "p", model_id: "m", credential: "secret", max_output_tokens: 2048 });
  });
});

describe("callLiveModel — real adapter, faked network boundary", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns the provider's final message text through the real OpenAI-compatible adapter", async () => {
    const fakeFetch = vi.fn(async () => sseFinal("export function fixed() { return 1; }"));
    const port = createLiveModelPort(config, fakeFetch as unknown as typeof fetch, OBSERVED_AT);
    const { text } = await callLiveModel({ port, credential: config.credential, session_id: "s1", turn: 0, provider_id: config.provider_id, model_id: config.model_id, prompt: "fix it" });
    expect(text).toBe("export function fixed() { return 1; }");
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const call = fakeFetch.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-secret");
  });

  it("throws LiveModelCallError instead of silently returning empty text when there is no final message", async () => {
    const fakeFetch = vi.fn(async () => sseNoFinal());
    const port = createLiveModelPort(config, fakeFetch as unknown as typeof fetch, OBSERVED_AT);
    await expect(callLiveModel({ port, credential: config.credential, session_id: "s1", turn: 0, provider_id: config.provider_id, model_id: config.model_id, prompt: "fix it" }))
      .rejects.toMatchObject({
        name: "LiveModelCallError",
        cause_detail: expect.stringContaining("terminal_message=model response contained an empty final result"),
      });
  });

  it("propagates the adapter's own credential error when no secret is injected", async () => {
    const fakeFetch = vi.fn(async () => sseFinal("unused"));
    const port = createLiveModelPort(config, fakeFetch as unknown as typeof fetch, OBSERVED_AT);
    await expect(callLiveModel({ port, credential: "", session_id: "s1", turn: 0, provider_id: config.provider_id, model_id: config.model_id, prompt: "fix it" })).rejects.toThrow();
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("does not impose a completion-token cap unless the operator supplied one", async () => {
    const unbounded: LiveModelConfig = { ...config, max_output_tokens: null };
    const fakeFetch = vi.fn(async () => sseFinal("complete"));
    const port = createLiveModelPort(unbounded, fakeFetch as unknown as typeof fetch, OBSERVED_AT);
    await callLiveModel({ port, credential: unbounded.credential, session_id: "s-unbounded", turn: 0, provider_id: unbounded.provider_id, model_id: unbounded.model_id, prompt: "complete" });
    const [, init] = fakeFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).not.toHaveProperty("max_tokens");
  });
});
