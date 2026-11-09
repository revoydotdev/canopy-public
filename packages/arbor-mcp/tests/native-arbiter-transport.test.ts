import { describe, expect, it } from "vitest";
import type { OpenAICompatibleFetch } from "@arbor/harness";
import type { ArborConfig, NativeProviderSecretOverlay } from "@arbor/config";
import { ARBOR_ARBITER_TRANSPORT_ENV, ARBOR_NATIVE_ARBITER_MODEL_ENV, composeArbiterIntakePort, createNativeArbiterPort } from "../src/native-arbiter-transport.js";
import { parseArbiterDecisionOutput } from "../src/arbiter-intake.js";

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

const decisionPayload = {
  tier: "direct",
  rationale: "one narrow, file-named fix",
  category: "maintenance",
  blast_radius: { reversibility: "reversible", write_paths: ["src/x.ts"], command_argv: [["npm", "test"]] },
};

function decisionFetch(payload: unknown = decisionPayload): OpenAICompatibleFetch {
  return async (_url, init) => sse(
    JSON.stringify({
      model: (JSON.parse(String(init?.body)) as { model?: string }).model ?? "test-model",
      choices: [{ delta: { content: JSON.stringify(payload) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 120, completion_tokens: 40 },
    }),
    "[DONE]",
  );
}

describe("createNativeArbiterPort", () => {
  it("is not ready when the native provider selection is incomplete", () => {
    const port = createNativeArbiterPort({ config: nativeConfig({ base_url: "", model: "" }), credential: presentCredential, fetch: decisionFetch() });
    expect(port.ready).toBe(false);
  });

  it("is not ready when no credential is present", () => {
    const port = createNativeArbiterPort({ config: nativeConfig(), credential: absentCredential, fetch: decisionFetch() });
    expect(port.ready).toBe(false);
  });

  it("is ready under native.mode fallback (connector specialist + native arbiter) when a credential exists", () => {
    const port = createNativeArbiterPort({ config: nativeConfig({ mode: "fallback" }), credential: presentCredential, fetch: decisionFetch() });
    expect(port.ready).toBe(true);
  });

  it("classifies through one chat completion, returning a contract-valid raw decision with measured usage", async () => {
    const port = createNativeArbiterPort({ config: nativeConfig(), credential: presentCredential, fetch: decisionFetch() });
    expect(port.ready).toBe(true);
    const result = await port.classify({ task: "fix the typo in src/x.ts", evidence_ids: [] });
    expect(parseArbiterDecisionOutput(result.raw_decision)).toMatchObject({ ok: true, value: { tier: "direct" } });
    expect(result.model_identity).toBe("test-model");
    expect(result.usage).toMatchObject({ input_tokens: 120, output_tokens: 40 });
  });

  it("honors the model override env without inheriting the configured revision pin", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetch: OpenAICompatibleFetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return decisionFetch()( _url, init);
    };
    const port = createNativeArbiterPort({ config: nativeConfig(), credential: presentCredential, fetch, env: { [ARBOR_NATIVE_ARBITER_MODEL_ENV]: "cheap-model" } as NodeJS.ProcessEnv });
    const result = await port.classify({ task: "x", evidence_ids: [] });
    expect(port.model_id).toBe("cheap-model");
    expect(requestBody?.model).toBe("cheap-model");
    expect(result.model_identity).toBe("cheap-model");
  });

  it("throws when the decision fails the ARBITER_DECISION_CONTRACT (never ships an invalid decision)", async () => {
    const port = createNativeArbiterPort({ config: nativeConfig(), credential: presentCredential, fetch: decisionFetch({ tier: "yolo", rationale: "x", category: "x", blast_radius: { reversibility: "unknown" } }) });
    await expect(port.classify({ task: "x", evidence_ids: [] })).rejects.toThrow(/contract/);
  });
});

describe("composeArbiterIntakePort", () => {
  it("uses the heuristic port when the transport env is unset", async () => {
    const port = composeArbiterIntakePort({ config: nativeConfig(), credential: presentCredential, fetch: decisionFetch(), env: {} as NodeJS.ProcessEnv });
    const result = await port.classify({ task: "fix the typo in docs/guide.md", evidence_ids: [] });
    expect(result.usage).toMatchObject({ kind: "unavailable" });
  });

  it("uses the native port when opted in and ready", async () => {
    const port = composeArbiterIntakePort({ config: nativeConfig(), credential: presentCredential, fetch: decisionFetch(), env: { [ARBOR_ARBITER_TRANSPORT_ENV]: "native" } as NodeJS.ProcessEnv });
    const result = await port.classify({ task: "anything", evidence_ids: [] });
    expect(result.usage).toMatchObject({ input_tokens: 120 });
  });

  it("falls back to the heuristic classification when the native call fails", async () => {
    const failingFetch: OpenAICompatibleFetch = async () => { throw new Error("provider 503"); };
    const port = composeArbiterIntakePort({ config: nativeConfig(), credential: presentCredential, fetch: failingFetch, env: { [ARBOR_ARBITER_TRANSPORT_ENV]: "native" } as NodeJS.ProcessEnv });
    const result = await port.classify({ task: "fix the typo in docs/guide.md", evidence_ids: [] });
    expect(result.usage).toMatchObject({ kind: "unavailable" });
    expect(parseArbiterDecisionOutput(result.raw_decision)).toMatchObject({ ok: true, value: { tier: "direct" } });
  });

  it("falls back to the heuristic port entirely when opted in but not ready", async () => {
    const port = composeArbiterIntakePort({ config: nativeConfig(), credential: absentCredential, fetch: decisionFetch(), env: { [ARBOR_ARBITER_TRANSPORT_ENV]: "native" } as NodeJS.ProcessEnv });
    const result = await port.classify({ task: "fix the typo in docs/guide.md", evidence_ids: [] });
    expect(parseArbiterDecisionOutput(result.raw_decision)).toMatchObject({ ok: true, value: { tier: "direct" } });
  });
});

describe("composeArbiterIntakePort — ARBOR_ARBITER_TRANSPORT=escalate (ADR-062 heuristics + LLM only when ambiguous)", () => {
  // Neither a risk keyword nor a narrow verb nor an inferred mutation:
  // exercises the heuristic's sole ambiguous ("reviewed") branch.
  const ambiguousTask = "Investigate why the cache layer is slow and summarize the root causes";
  // A short, narrow-verb, file-named task: the heuristic's confident
  // "direct" branch.
  const confidentTask = "fix the typo in docs/guide.md";

  it("escalates to the native classifier when the heuristic's own decision is ambiguous (reviewed)", async () => {
    const governedPayload = { tier: "governed", rationale: "native: this needs real investigation before any change", category: "investigation", blast_radius: { reversibility: "unknown" } };
    const port = composeArbiterIntakePort({ config: nativeConfig(), credential: presentCredential, fetch: decisionFetch(governedPayload), env: { [ARBOR_ARBITER_TRANSPORT_ENV]: "escalate" } as NodeJS.ProcessEnv });
    const result = await port.classify({ task: ambiguousTask, evidence_ids: [] });
    expect(parseArbiterDecisionOutput(result.raw_decision)).toMatchObject({ ok: true, value: { tier: "governed", rationale: "native: this needs real investigation before any change" } });
    expect(result.usage).toMatchObject({ input_tokens: 120 });
  });

  it("never calls the native provider when the heuristic's own decision is already confident", async () => {
    const explodingFetch: OpenAICompatibleFetch = async () => { throw new Error("native must not be called for a confident heuristic decision"); };
    const port = composeArbiterIntakePort({ config: nativeConfig(), credential: presentCredential, fetch: explodingFetch, env: { [ARBOR_ARBITER_TRANSPORT_ENV]: "escalate" } as NodeJS.ProcessEnv });
    const result = await port.classify({ task: confidentTask, evidence_ids: [] });
    expect(parseArbiterDecisionOutput(result.raw_decision)).toMatchObject({ ok: true, value: { tier: "direct" } });
    expect(result.usage).toMatchObject({ kind: "unavailable" });
  });

  it("falls back to the heuristic's own ambiguous decision when the native escalation call fails", async () => {
    const failingFetch: OpenAICompatibleFetch = async () => { throw new Error("provider 503"); };
    const port = composeArbiterIntakePort({ config: nativeConfig(), credential: presentCredential, fetch: failingFetch, env: { [ARBOR_ARBITER_TRANSPORT_ENV]: "escalate" } as NodeJS.ProcessEnv });
    const result = await port.classify({ task: ambiguousTask, evidence_ids: [] });
    expect(parseArbiterDecisionOutput(result.raw_decision)).toMatchObject({ ok: true, value: { tier: "reviewed" } });
    expect(result.usage).toMatchObject({ kind: "unavailable" });
  });

  it("falls back to the heuristic's own ambiguous decision when no native provider is ready", async () => {
    const port = composeArbiterIntakePort({ config: nativeConfig(), credential: absentCredential, fetch: decisionFetch(), env: { [ARBOR_ARBITER_TRANSPORT_ENV]: "escalate" } as NodeJS.ProcessEnv });
    const result = await port.classify({ task: ambiguousTask, evidence_ids: [] });
    expect(parseArbiterDecisionOutput(result.raw_decision)).toMatchObject({ ok: true, value: { tier: "reviewed" } });
  });
});
