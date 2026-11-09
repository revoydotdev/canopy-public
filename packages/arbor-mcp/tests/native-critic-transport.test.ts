import { describe, expect, it } from "vitest";
import type { OpenAICompatibleFetch } from "@arbor/harness";
import { resolveNativeCredentialOverlay, type ArborConfig, type NativeProviderSecretOverlay } from "@arbor/config";
import { createNativeCriticPort } from "../src/native-critic-transport.js";

function sse(...events: string[]): Response {
  return new Response(events.map((event) => `data: ${event}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function nativeConfig(overrides: Partial<ArborConfig["native"]> = {}): Pick<ArborConfig, "native"> {
  return {
    native: {
      mode: "native",
      adapter_id: "openai-compatible",
      provider_id: "openai-compatible",
      base_url: "https://model.invalid",
      model: "test-model",
      ...overrides,
    },
  };
}

const presentCredential: NativeProviderSecretOverlay = Object.freeze({
  source: "env",
  env_var: "ARBOR_NATIVE_API_KEY",
  present: true,
  mechanism: "api_key",
  inject<T>(recipient: (apiKey: string, mechanism: "api_key" | "oauth_bearer") => T): T | undefined { return recipient("super-secret-native-key", "api_key"); },
});

const absentCredential: NativeProviderSecretOverlay = Object.freeze({
  source: "absent",
  env_var: null,
  present: false,
  mechanism: "api_key",
  inject<T>(_recipient: (apiKey: string, mechanism: "api_key" | "oauth_bearer") => T): T | undefined { return undefined; },
});

const verdictPayload = {
  approved: true,
  rationale: "looks good",
  root_cause: null,
  measurement_validated: true,
  guardrails_enforced: true,
  introspection_passed: true,
  stability_ok: true,
  checks: [
    { name: "root_cause", passed: true, detail: "n/a" },
    { name: "measurement_validation", passed: true, detail: "measured" },
    { name: "guardrail_enforcement", passed: true, detail: "enforced" },
    { name: "introspection", passed: true, detail: "reviewed" },
    { name: "stability_monitoring", passed: true, detail: "stable" },
  ],
};

function verdictFetch(usage?: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: Record<string, number> }): OpenAICompatibleFetch {
  return async () => sse(
    JSON.stringify({
      model: "test-model",
      choices: [{ delta: { content: JSON.stringify(verdictPayload) }, finish_reason: "stop" }],
      ...(usage === undefined ? {} : { usage }),
    }),
    "[DONE]",
  );
}

describe("createNativeCriticPort", () => {
  it("is not ready when the native provider selection is incomplete", () => {
    const port = createNativeCriticPort({
      config: nativeConfig({ base_url: "", model: "" }),
      credential: presentCredential,
      fetch: verdictFetch(),
    });
    expect(port.ready).toBe(false);
  });

  it("is not ready when no credential is present", () => {
    const port = createNativeCriticPort({
      config: nativeConfig(),
      credential: absentCredential,
      fetch: verdictFetch(),
    });
    expect(port.ready).toBe(false);
  });

  it("is ready and calls through to a single non-streaming chat completion, mapping usage and model identity", async () => {
    let requestBody: Record<string, unknown> | undefined;
    let authHeader: string | undefined;
    const fetch: OpenAICompatibleFetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      authHeader = (init?.headers as Record<string, string>).authorization;
      return sse(
        JSON.stringify({
          model: "test-model",
          choices: [{ delta: { content: JSON.stringify(verdictPayload) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 20, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 5, cache_creation_tokens: 2 } },
        }),
        "[DONE]",
      );
    };
    const port = createNativeCriticPort({ config: nativeConfig(), credential: presentCredential, fetch });
    expect(port.ready).toBe(true);
    expect(port.model_id).toBe("test-model");
    const result = await port.call("Review this specialist output.");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(JSON.parse(result.text)).toMatchObject({ approved: true });
    // The four buckets are disjoint: fresh input is prompt_tokens net of both
    // cache reads and cache writes, so downstream sums cannot double-count.
    expect(result.usage).toEqual({ input_tokens: 13, output_tokens: 10, cached_input_tokens: 5, cache_write_input_tokens: 2, counter_source: "provider_counter" });
    // Never a streaming ask from the caller's perspective, but the wire
    // request is still exactly one HTTP call -- no repeated turns.
    expect(authHeader).toBe("Bearer super-secret-native-key");
    expect(requestBody?.model).toBe("test-model");
    // The credential must never leak into the recorded prompt/request body.
    expect(JSON.stringify(requestBody)).not.toContain("super-secret-native-key");
  });

  it("uses the same scoped OpenAI WIF bearer source for the native critic call", async () => {
    let authHeader: string | undefined;
    const now = Math.floor(Date.now() / 1000);
    const config = nativeConfig({ provider_id: "openai", base_url: "https://api.openai.com/v1", credential_source: "openai_wif" });
    const credential = resolveNativeCredentialOverlay({
      credential_source: "openai_wif", provider_id: "openai", adapter_id: "openai-compatible", base_url: "https://api.openai.com/v1",
      env: { OPENAI_WIF_ACCESS_TOKEN: "fixture-wif-token", OPENAI_WIF_EXPIRES_AT: String(now + 3600) },
    }).overlay;
    const port = createNativeCriticPort({
      config, credential,
      fetch: async (_url, init) => {
        authHeader = (init?.headers as Record<string, string>).authorization;
        return sse(JSON.stringify({ model: "test-model", choices: [{ delta: { content: JSON.stringify(verdictPayload) }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10 } }), "[DONE]");
      },
    });
    expect(port.ready).toBe(true);
    expect(await port.call("review" )).toMatchObject({ ok: true });
    expect(authHeader).toBe("Bearer fixture-wif-token");
  });

  it("routes the configured native critic verdict through Claude Code auth without using an Arbor API-key lease", async () => {
    let authHeader: string | undefined;
    const fetch: OpenAICompatibleFetch = async (_url, init) => {
      authHeader = (init?.headers as Record<string, string>).authorization;
      return sse(
        JSON.stringify({ model: "claude-sonnet-5", choices: [{ delta: { content: JSON.stringify(verdictPayload) }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10 } }),
        "[DONE]",
      );
    };
    const port = createNativeCriticPort({
      config: nativeConfig({ adapter_id: "anthropic-messages", provider_id: "anthropic", base_url: "https://api.anthropic.com", model: "claude-sonnet-5", auth_route: "claude_code_cli" }),
      // Prove that this route doesn't consume an otherwise available API-key lease.
      credential: presentCredential,
      fetch,
    });
    expect(port.ready).toBe(true);
    const result = await port.call("Review through the governed critic path.");
    expect(result.ok).toBe(true);
    expect(authHeader).toMatch(/^Bearer bridge-/);
    expect(authHeader).not.toContain("super-secret-native-key");
  });

  it("applies ARBOR_NATIVE_CRITIC_MODEL as a model override", () => {
    const port = createNativeCriticPort({
      config: nativeConfig(),
      credential: presentCredential,
      fetch: verdictFetch(),
      env: { ARBOR_NATIVE_CRITIC_MODEL: "override-model" },
    });
    expect(port.model_id).toBe("override-model");
  });

  it("maps usage to a typed unavailable reason when the provider omits it", async () => {
    const port = createNativeCriticPort({ config: nativeConfig(), credential: presentCredential, fetch: verdictFetch() });
    const result = await port.call("review");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.usage).toEqual({ kind: "unavailable", reason: expect.stringContaining("usage") });
  });

  it("returns a typed error (never throws) when the underlying call rejects", async () => {
    const fetch: OpenAICompatibleFetch = async () => { throw new Error("network exploded"); };
    const port = createNativeCriticPort({ config: nativeConfig(), credential: presentCredential, fetch });
    const result = await port.call("review");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error).toBeTruthy();
    expect(result.usage).toMatchObject({ kind: "unavailable" });
  });
});

describe("forced-connector specialist with native critic (native.mode=fallback)", () => {
  it("is ready under mode=fallback when selection fields and credential are present", () => {
    const config = nativeConfig();
    (config.native as { mode: string }).mode = "fallback";
    const port = createNativeCriticPort({ config, credential: presentCredential, fetch: verdictFetch() });
    expect(port.ready).toBe(true);
  });

  it("is NOT ready under mode=fallback when the credential is absent", () => {
    const config = nativeConfig();
    (config.native as { mode: string }).mode = "fallback";
    const port = createNativeCriticPort({ config, credential: absentCredential, fetch: verdictFetch() });
    expect(port.ready).toBe(false);
  });
});
