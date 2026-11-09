/**
 * Native critic transport (single-call fast path).
 *
 * A controlled A/B (n=3 per config, 2026-08-15) showed the claude-code
 * critic path costs a ~19-24s / ~$0.11 floor per review REGARDLESS of model,
 * turn cap, or prompt size -- the floor is the Claude Code CLI process
 * itself (safe-mode init, system-prompt cache write, plan-mode repo scan),
 * not the review work. A critic is a single-verdict scorer (cf. arXiv
 * 2607.05391, LLM-as-a-Verifier): it needs no agent harness.
 *
 * This composes exactly one non-streaming chat-completion call through the
 * existing native provider adapter (`@arbor/harness`), reusing the same
 * credential source selected for native sessions and readiness gate
 * (`resolveNativeHarnessExecutionReadiness`) the doctor and the native
 * executor composition (`cli.ts`'s `configuredNativeAgentExecutor`) use.
 * The explicitly selected stateless Claude Code bridge is also supported;
 * that route leaves Claude Code sign-in inside the CLI process.
 * It deliberately does NOT go through `NativeAgentExecutor`/native-session:
 * a critic call has no tools, no history, and no session lifecycle to
 * manage -- only a prompt in, a verdict out.
 */
import { randomUUID } from "node:crypto";
import {
  createReferenceNativeModelAdapterRegistry,
  type NativeModelAdapterRegistry,
  type NativeModelPort,
  type NativeUsageAndCost,
  type OpenAICompatibleFetch,
} from "@arbor/harness";
import {
  resolveNativeCredentialOverlay,
  resolveNativeProviderSelection,
  type ArborConfig,
  type NativeCredentialOverlay,
} from "@arbor/config";
import type { TokenUsageResult } from "@arbor/core";
import { resolveNativeHarnessExecutionReadiness } from "./native-harness-readiness.js";
import { createClaudeCodeNativeModelPort } from "./claude-code-native-route.js";
import { createOpenAICodexNativeModelPort } from "./openai-codex-native-route.js";
import { resolveOpenAICodexCliSelection } from "./native-executor-composition.js";
import { NATIVE_CRITIC_VERDICT_SCHEMA, NATIVE_CRITIC_VERDICT_SCHEMA_ID, nativeCriticVerdictInstruction } from "./native-critic-contract.js";

/** Set to "native" to prefer the fast single-call transport over the CLI critic path. */
export const ARBOR_CRITIC_TRANSPORT_ENV = "ARBOR_CRITIC_TRANSPORT";
/** Optional model override for the native critic call; defaults to native.model. */
export const ARBOR_NATIVE_CRITIC_MODEL_ENV = "ARBOR_NATIVE_CRITIC_MODEL";

export type NativeCriticCallResult =
  | { readonly ok: true; readonly text: string; readonly usage: TokenUsageResult }
  | { readonly ok: false; readonly error: string; readonly usage: TokenUsageResult };

export interface NativeCriticPort {
  /** True when the selected native route is ready; Claude CLI auth remains CLI-owned. */
  readonly ready: boolean;
  readonly model_id: string | null;
  call(prompt: string, signal?: AbortSignal): Promise<NativeCriticCallResult>;
}

export interface NativeCriticPortDeps {
  readonly config: Pick<ArborConfig, "native">;
  /** Defaults to the same provider-native source used by native sessions; inject for tests. */
  readonly credential?: NativeCredentialOverlay;
  /** Working directory for the stateless Claude Code bridge. */
  readonly cwd?: string;
  /** Defaults to `createReferenceNativeModelAdapterRegistry(fetch)`; inject for tests. */
  readonly adapters?: Pick<NativeModelAdapterRegistry, "inspect" | "create">;
  readonly fetch?: OpenAICompatibleFetch;
  readonly env?: NodeJS.ProcessEnv;
}

function unavailableUsage(reason: string): TokenUsageResult {
  return { kind: "unavailable", reason };
}

function notReadyPort(modelId: string | null, reason: string): NativeCriticPort {
  return Object.freeze({
    ready: false,
    model_id: modelId,
    async call(): Promise<NativeCriticCallResult> {
      return { ok: false, error: reason, usage: unavailableUsage(reason) };
    },
  });
}

function mapUsage(usage: NativeUsageAndCost | undefined): TokenUsageResult {
  if (usage === undefined) return unavailableUsage("native critic response did not include a usage observation");
  if (usage.tokens.kind !== "measured") {
    return unavailableUsage(usage.tokens.kind === "unavailable" ? usage.tokens.reason : "native critic usage was not a measured token count");
  }
  return {
    input_tokens: usage.tokens.input_tokens,
    output_tokens: usage.tokens.output_tokens,
    cached_input_tokens: usage.tokens.cache_read_tokens,
    cache_write_input_tokens: usage.tokens.cache_write_tokens,
    counter_source: "provider_counter",
  };
}

/**
 * Composes a `NativeCriticPort` from config/credential/adapter inputs.
 * Mirrors `cli.ts`'s native executor composition but stays scoped to
 * exactly one non-streaming critic call -- no session, loop, or
 * `NativeAgentExecutor` machinery. Construction performs no network I/O.
 */
export function createNativeCriticPort(deps: NativeCriticPortDeps): NativeCriticPort {
  const env = deps.env ?? process.env;
  const claudeCodeRoute = deps.config.native.auth_route === "claude_code_cli";
  const openAiCodexRoute = deps.config.native.auth_route === "openai_codex_cli";
  const credentialSelection = openAiCodexRoute
    ? resolveOpenAICodexCliSelection(env)
    : !claudeCodeRoute && deps.credential === undefined
    ? resolveNativeCredentialOverlay({
      credential_source: deps.config.native.credential_source, provider_id: deps.config.native.provider_id,
      adapter_id: deps.config.native.adapter_id, base_url: deps.config.native.base_url, env,
    })
    : null;
  const credential = claudeCodeRoute || openAiCodexRoute
    ? resolveNativeCredentialOverlay({ credential_source: "api_key", provider_id: deps.config.native.provider_id, adapter_id: deps.config.native.adapter_id, base_url: deps.config.native.base_url, env: {} }).overlay
    : deps.credential ?? credentialSelection!.overlay;
  const adapters = deps.adapters ?? createReferenceNativeModelAdapterRegistry(deps.fetch ?? fetch);
  // Claude Code owns its CLI login; readiness should validate route and
  // adapter shape without inventing or reading a Canopy credential.
  const readinessCredential = claudeCodeRoute ? { present: true, mechanism: "api_key" as const } : openAiCodexRoute ? credentialSelection!.facts : credential;
  const readiness = resolveNativeHarnessExecutionReadiness(deps.config.native, readinessCredential, adapters, credentialSelection?.boundary);
  // `forced_by_config` (native.mode === "fallback") pins the SPECIALIST to
  // the connector; it does not make the native provider unusable. The critic
  // transport is separately opt-in via ARBOR_CRITIC_TRANSPORT=native, so an
  // operator can run a connector specialist with a native critic — the exact
  // measured-win topology. Every other non-ready reason (selection
  // incomplete, credential absent, adapter unavailable) still fails closed.
  const forcedConnectorSpecialist = readiness.kind === "connector_fallback" && readiness.reason === "forced_by_config";
  if (readiness.kind !== "direct_native" && !forcedConnectorSpecialist) {
    return notReadyPort(null, `native critic transport is not ready: ${readiness.kind}${"reason" in readiness ? `/${readiness.reason}` : ""}`);
  }
  // The forced-connector readiness short-circuits before the credential
  // check, so verify it here — a ready:true port must actually be able to
  // authenticate.
  if (forcedConnectorSpecialist && !credential.present) {
    return notReadyPort(null, "native critic transport is not ready: connector_fallback/credential_absent");
  }
  const selection = forcedConnectorSpecialist
    ? resolveNativeProviderSelection({ ...deps.config.native, mode: "native" })
    : resolveNativeProviderSelection(deps.config.native);
  if (selection.kind !== "native") {
    // Readiness and selection are derived from the same config; disagreement
    // here means the two resolvers drifted, not that the native path is
    // usable. Fail closed rather than dispatch against an unresolved model.
    return notReadyPort(null, "native readiness disagreed with provider selection");
  }
  const modelId = env[ARBOR_NATIVE_CRITIC_MODEL_ENV]?.trim() || selection.model;
  const observedAt = new Date().toISOString();
  let port: NativeModelPort;
  try {
    const request = {
      adapter_id: selection.adapter_id,
      provider_id: selection.provider_id,
      base_url: selection.base_url,
      model_id: modelId,
      // An overridden model no longer carries the configured selection's
      // revision pin -- copying it across model identities would assert a
      // fingerprint the adapter never observed for this model.
      ...(modelId === selection.model && selection.revision !== null ? { revision: selection.revision } : {}),
      observed_at: observedAt,
      structured_schemas: [NATIVE_CRITIC_VERDICT_SCHEMA],
      credential_required: true,
      // A verdict is a few hundred tokens of structured JSON. Without a
      // ceiling, reasoning-style models free-run their hidden chain of
      // thought inside the completion budget — measured live as 4.5–45 s
      // per call on the same prompt. The cap bounds wall time and cost;
      // 2000 leaves generous headroom for reasoning-inclusive providers.
      max_output_tokens: 2_000,
      credential_mechanism: credential.mechanism,
    };
    port = claudeCodeRoute
      ? createClaudeCodeNativeModelPort({ request, cwd: deps.cwd ?? process.cwd(), ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) })
      : openAiCodexRoute
        ? createOpenAICodexNativeModelPort({ request, cwd: deps.cwd ?? process.cwd(), env })
      : adapters.create(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : "native critic adapter composition failed";
    return notReadyPort(modelId, message);
  }
  return Object.freeze({
    get ready() { return claudeCodeRoute || (openAiCodexRoute ? credentialSelection!.facts.present : credential.present); },
    model_id: modelId,
    async call(prompt: string, signal?: AbortSignal): Promise<NativeCriticCallResult> {
      const abortSignal = signal ?? new AbortController().signal;
      try {
        const request =
          {
            session_id: `native-critic:${randomUUID()}`,
            turn: 1,
            // The credential is a request-time secret, not prompt content; it
            // never appears in this request body and is discarded once the
            // fetch call returns.
            prompt: `${prompt}\n\n${nativeCriticVerdictInstruction({ tools: "none" })}`,
            history: [],
            profile: null,
            governed_context: { instructions: [], artifacts: [] },
            context: null,
            structured_output: { schema_id: NATIVE_CRITIC_VERDICT_SCHEMA_ID },
          };
        const response = claudeCodeRoute || openAiCodexRoute
          ? await port.run(request, null, abortSignal)
          : await credential.inject((apiKey) => port.run(request, apiKey, abortSignal));
        if (response === undefined) {
          const reason = "native critic credential was not available at dispatch";
          return { ok: false, error: reason, usage: unavailableUsage(reason) };
        }
        const usage = mapUsage(response.usage_and_cost);
        if (response.final_message === null || response.final_message.trim().length === 0) {
          return { ok: false, error: "native critic call returned no final message", usage };
        }
        return { ok: true, text: response.final_message, usage };
      } catch (error) {
        const message = error instanceof Error ? error.message : "native critic call failed";
        return { ok: false, error: message, usage: unavailableUsage(message) };
      }
    },
  });
}
