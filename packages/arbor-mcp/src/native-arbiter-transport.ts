/**
 * Native arbiter transport (single-call intake classification).
 *
 * ADR-062 defined the ARBITER intake contract (`arbiter-intake.ts`) with a
 * port seam so a composition root could supply a model-backed classifier;
 * until now only the zero-token heuristic port existed and the structured
 * schema/contract had no runtime consumer. This composes exactly one
 * non-streaming chat-completion call through the same native
 * OpenAI-compatible adapter, credential overlay, and readiness gate the
 * native critic transport (`native-critic-transport.ts`) uses — including
 * its `forced_by_config` carve-out, so an operator can run a connector
 * specialist with a native arbiter.
 *
 * Failure posture: a malformed decision (per `ARBITER_DECISION_CONTRACT`)
 * or any transport failure throws, and `composeArbiterIntakePort` routes
 * the classification to the heuristic port instead — intake never ships an
 * invalid decision and never silently downgrades to `governed` when a
 * cheap, honest local classification exists.
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
  loadNativeProviderSecretOverlay,
  resolveNativeProviderSelection,
  type ArborConfig,
  type NativeProviderSecretOverlay,
} from "@arbor/config";
import type { TokenUsageResult } from "@arbor/core";
import { resolveNativeHarnessExecutionReadiness } from "./native-harness-readiness.js";
import {
  ARBITER_DECISION_CONTRACT,
  ARBITER_DECISION_SCHEMA,
  ARBITER_DECISION_SCHEMA_ID,
  createHeuristicArbiterIntakePort,
  parseArbiterDecisionOutput,
  type ArbiterIntakePort,
} from "./arbiter-intake.js";

/**
 * Set to "native" to prefer a model-backed intake classifier over the
 * zero-token heuristic for EVERY task, or to "escalate" to run the
 * zero-token heuristic first and call the model-backed classifier only
 * when the heuristic's own signal is ambiguous (ADR-062's "heuristics + LLM
 * only when ambiguous" -- see `composeArbiterIntakePort`). Any other value,
 * or unset, uses the heuristic alone for every task.
 */
export const ARBOR_ARBITER_TRANSPORT_ENV = "ARBOR_ARBITER_TRANSPORT";
/** Optional model override for the native arbiter call; defaults to native.model. */
export const ARBOR_NATIVE_ARBITER_MODEL_ENV = "ARBOR_NATIVE_ARBITER_MODEL";

export interface NativeArbiterIntakePort extends ArbiterIntakePort {
  /** True only when the native provider selection is complete and a credential is present. */
  readonly ready: boolean;
  readonly model_id: string | null;
}

export interface NativeArbiterPortDeps {
  readonly config: Pick<ArborConfig, "native">;
  /** Defaults to `loadNativeProviderSecretOverlay(env, config.native.provider_id)`; inject for tests. */
  readonly credential?: NativeProviderSecretOverlay;
  /** Defaults to `createReferenceNativeModelAdapterRegistry(fetch)`; inject for tests. */
  readonly adapters?: Pick<NativeModelAdapterRegistry, "inspect" | "create">;
  readonly fetch?: OpenAICompatibleFetch;
  readonly env?: NodeJS.ProcessEnv;
  /** Y-2: forwarded to the heuristic port's `structural_paths` resolver (composeArbiterIntakePort always constructs the heuristic port, native or not). */
  readonly structural_paths?: (path: string) => readonly string[];
}

/** Prompt guidance only; `ARBITER_DECISION_CONTRACT` remains authoritative. */
export function nativeArbiterDecisionInstruction(): string {
  return [
    "You are an intake arbiter deciding how much governance a task needs before any work starts.",
    'Return exactly one JSON object with tier ("direct" for one narrow, reversible, file-named change; "reviewed" for one bounded action that deserves an independent review; "governed" for anything risky, irreversible, multi-step, or whose write scope cannot be derived from the task text),',
    "rationale (one sentence), category (a short kebab-case task category), and blast_radius with reversibility (reversible|irreversible|unknown), write_paths (literal file paths the task names, or null), and command_argv (verification commands the task names as argv arrays, or null).",
    "Escalate to governed whenever uncertain. Do not add prose, markdown, or fields outside that contract.",
  ].join(" ");
}

function notReadyPort(modelId: string | null, reason: string): NativeArbiterIntakePort {
  return Object.freeze({
    ready: false,
    model_id: modelId,
    async classify(): Promise<never> {
      throw new Error(reason);
    },
  });
}

function mapUsage(usage: NativeUsageAndCost | undefined): TokenUsageResult {
  if (usage === undefined) return { kind: "unavailable", reason: "native arbiter response did not include a usage observation" };
  if (usage.tokens.kind !== "measured") {
    return { kind: "unavailable", reason: usage.tokens.kind === "unavailable" ? usage.tokens.reason : "native arbiter usage was not a measured token count" };
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
 * Composes a `NativeArbiterIntakePort`. Construction performs no network
 * I/O; readiness, selection, and the forced-connector carve-out mirror
 * `createNativeCriticPort` exactly.
 */
export function createNativeArbiterPort(deps: NativeArbiterPortDeps): NativeArbiterIntakePort {
  const env = deps.env ?? process.env;
  const credential = deps.credential ?? loadNativeProviderSecretOverlay(env, deps.config.native.provider_id);
  const adapters = deps.adapters ?? createReferenceNativeModelAdapterRegistry(deps.fetch ?? fetch);
  const readiness = resolveNativeHarnessExecutionReadiness(deps.config.native, credential, adapters);
  const forcedConnectorSpecialist = readiness.kind === "connector_fallback" && readiness.reason === "forced_by_config";
  if (readiness.kind !== "direct_native" && !forcedConnectorSpecialist) {
    return notReadyPort(null, `native arbiter transport is not ready: ${readiness.kind}${"reason" in readiness ? `/${readiness.reason}` : ""}`);
  }
  if (forcedConnectorSpecialist && !credential.present) {
    return notReadyPort(null, "native arbiter transport is not ready: connector_fallback/credential_absent");
  }
  const selection = forcedConnectorSpecialist
    ? resolveNativeProviderSelection({ ...deps.config.native, mode: "native" })
    : resolveNativeProviderSelection(deps.config.native);
  if (selection.kind !== "native") {
    return notReadyPort(null, "native readiness disagreed with provider selection");
  }
  const modelId = env[ARBOR_NATIVE_ARBITER_MODEL_ENV]?.trim() || selection.model;
  const observedAt = new Date().toISOString();
  let port: NativeModelPort;
  try {
    port = adapters.create({
      adapter_id: selection.adapter_id,
      provider_id: selection.provider_id,
      base_url: selection.base_url,
      model_id: modelId,
      ...(modelId === selection.model && selection.revision !== null ? { revision: selection.revision } : {}),
      observed_at: observedAt,
      structured_schemas: [ARBITER_DECISION_SCHEMA],
      credential_required: true,
      // A decision is a few hundred tokens of structured JSON; the cap
      // bounds reasoning-style providers' hidden chain-of-thought spend.
      max_output_tokens: 1_000,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "native arbiter adapter composition failed";
    return notReadyPort(modelId, message);
  }
  return Object.freeze({
    ready: true,
    model_id: modelId,
    async classify(input: { readonly task: string; readonly evidence_ids: readonly string[]; readonly signal?: AbortSignal }) {
      const sessionId = `native-arbiter:${randomUUID()}`;
      const response = await credential.inject((apiKey) => port.run(
        {
          session_id: sessionId,
          turn: 1,
          prompt: `Task:\n${input.task}\n\n${nativeArbiterDecisionInstruction()}`,
          history: [],
          profile: null,
          governed_context: { instructions: [], artifacts: [] },
          context: null,
          structured_output: { schema_id: ARBITER_DECISION_SCHEMA_ID },
        },
        apiKey,
        input.signal ?? new AbortController().signal,
      ));
      if (response === undefined) throw new Error("native arbiter credential was not available at dispatch");
      if (response.final_message === null || response.final_message.trim().length === 0) throw new Error("native arbiter call returned no final message");
      let parsed: unknown;
      try { parsed = JSON.parse(response.final_message); } catch { throw new Error("native arbiter decision is not a single JSON object"); }
      const validation = ARBITER_DECISION_CONTRACT.validate(parsed);
      if (!validation.valid) throw new Error(`native arbiter decision failed the ${ARBITER_DECISION_CONTRACT.schema_id} contract: ${validation.reason}`);
      return {
        raw_decision: response.final_message,
        session_id: sessionId,
        model_identity: modelId,
        usage: mapUsage(response.usage_and_cost),
      };
    },
  });
}

/**
 * Composition-root selector:
 *
 *   - `ARBOR_ARBITER_TRANSPORT=native` (with a ready native provider)
 *     classifies EVERY task through the model and falls back to the
 *     heuristic port when the native call fails or its decision fails the
 *     contract.
 *   - `ARBOR_ARBITER_TRANSPORT=escalate` (with a ready native provider)
 *     runs the zero-token heuristic FIRST and calls the model-backed
 *     classifier only when the heuristic's own decision is `reviewed` --
 *     the heuristic's sole "neither clearly narrow nor clearly risky"
 *     branch, i.e. its one genuinely ambiguous outcome (`direct` and
 *     `governed` are both confident, keyword-driven decisions the
 *     heuristic already trusts). ADR-062's disclosed "heuristics + LLM
 *     only when ambiguous" composition. Falls back to the heuristic's own
 *     `reviewed` decision when the native call fails, its decision fails
 *     the contract, or no native provider is ready -- escalation can only
 *     ever REPLACE an ambiguous heuristic call with a more confident one,
 *     never leave a task unclassified.
 *   - Every other configuration (including unset) uses the heuristic port
 *     alone for every task, unchanged from before this seam existed.
 */
export function composeArbiterIntakePort(deps: NativeArbiterPortDeps): ArbiterIntakePort {
  const env = deps.env ?? process.env;
  const heuristic = createHeuristicArbiterIntakePort(deps.structural_paths ? { structural_paths: deps.structural_paths } : undefined);
  const mode = env[ARBOR_ARBITER_TRANSPORT_ENV]?.trim();
  if (mode === "native") {
    const native = createNativeArbiterPort(deps);
    if (!native.ready) return heuristic;
    return Object.freeze({
      async classify(input: { readonly task: string; readonly evidence_ids: readonly string[]; readonly signal?: AbortSignal }) {
        try {
          return await native.classify(input);
        } catch {
          return heuristic.classify(input);
        }
      },
    });
  }
  if (mode === "escalate") {
    const native = createNativeArbiterPort(deps);
    return Object.freeze({
      async classify(input: { readonly task: string; readonly evidence_ids: readonly string[]; readonly signal?: AbortSignal }) {
        const heuristicResult = await heuristic.classify(input);
        if (!native.ready) return heuristicResult;
        const parsed = parseArbiterDecisionOutput(heuristicResult.raw_decision);
        const ambiguous = parsed.ok && parsed.value.tier === "reviewed";
        if (!ambiguous) return heuristicResult;
        try {
          return await native.classify(input);
        } catch {
          return heuristicResult;
        }
      },
    });
  }
  return heuristic;
}
