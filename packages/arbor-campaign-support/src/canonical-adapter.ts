/**
 * Canonical-adapter: bridges @arbor/mcp's ArborRuntime capability adapter into
 * the arbor-opencode token-economy port.
 *
 * This module used to also carry `composeCanonicalLoopConfig`, a pure
 * type-level restatement that every canonical loop port is a structural match.
 * It was deleted 2026-08-06: nothing outside its own tests ever called it, and
 * its reachability waiver's premise (a concurrent lane about to wire it) had
 * expired in fact. The structural-match guarantee it asserted is enforced by
 * the compiler at each real call site regardless.
 */

import type { ProviderTokenCapability } from "@arbor/core";
import type { ProviderCapabilityStatus, ProviderTokenBridge } from "./token-economy-boundary.js";

export type { ProviderCapabilityStatus };

/**
 * Structural match for `@arbor/mcp`'s `RuntimeModelCapabilityAdapter`
 * (loop-adapters.ts). Defined locally rather than imported: `@arbor/mcp`
 * imports `@arbor/opencode` at runtime, so a value-erasing `import type`
 * from `@arbor/mcp` here would still force `arbor-opencode`'s tsconfig to
 * reference `arbor-mcp` for `tsc --build` to resolve the type, completing a
 * real cycle in the project-reference graph. See `loop.ts`'s
 * `CampaignManagerPort` for the identical reasoning and the mirror-image
 * convention `@arbor/mcp`'s own `loop-adapters.ts` already uses. Every real
 * caller passes a live `RuntimeModelCapabilityAdapter` instance, which
 * structurally satisfies this port.
 */
export interface ModelCapabilityPort {
  resolveOutputLimit(input: { requested_max_output_tokens: number; model?: string }): {
    effective_max_output_tokens: number;
    limit_source: "requested" | "runtime" | "snapshot";
  };
  estimateTokens(input: { model?: string; content: string }): Promise<{ value: number } | null>;
  /**
   * Provider-advertised context capacity for a named model. Optional because
   * the live `RuntimeModelCapabilityAdapter` only surfaces max output today;
   * absence is reported as typed `unavailable`, never papered over with a
   * derived constant.
   */
  resolveContextCapacity?(input: { model?: string }): {
    value: number;
    source: "runtime" | "snapshot";
  } | null;
}

/**
 * Resolves a named model to a `ProviderTokenCapability` or a typed
 * `unavailable` naming the missing piece. The output limit is probed by
 * requesting an unbounded allocation, so an adapter with real data answers
 * its advertised cap; `limit_source "requested"` means the adapter echoed
 * the request because it knows nothing about this model. Context capacity
 * comes only from `resolveContextCapacity` — never from a derived constant.
 */
export function resolveProviderTokenCapability(
  capabilities: ModelCapabilityPort,
  providerId = "arbor-runtime",
  modelId = "default",
): ProviderCapabilityStatus {
  if (!providerId.trim() || !modelId.trim()) throw new Error("provider_id and model_id must be non-empty");
  const limit = capabilities.resolveOutputLimit({ requested_max_output_tokens: Number.MAX_SAFE_INTEGER, model: modelId });
  if (limit.limit_source === "requested") {
    return { status: "unavailable", provider_id: providerId, model_id: modelId, missing: "max output tokens" };
  }
  const context = capabilities.resolveContextCapacity?.({ model: modelId }) ?? null;
  if (!context) {
    return { status: "unavailable", provider_id: providerId, model_id: modelId, missing: "context capacity" };
  }
  if (!Number.isSafeInteger(context.value) || context.value < 1) throw new Error("provider context capacity must be a positive safe integer");
  if (!Number.isSafeInteger(limit.effective_max_output_tokens) || limit.effective_max_output_tokens < 1) throw new Error("provider max output tokens must be a positive safe integer");
  if (limit.effective_max_output_tokens > context.value) {
    return {
      status: "unavailable", provider_id: providerId, model_id: modelId,
      missing: `consistent context capacity (advertised max output ${limit.effective_max_output_tokens} exceeds context ${context.value})`,
    };
  }
  return {
    status: "available",
    capability: {
      provider_id: providerId,
      model_id: modelId,
      context_capacity: context.value,
      max_output_tokens: limit.effective_max_output_tokens,
      source: limit.limit_source,
    },
  };
}

/**
 * Extracts live provider capability metadata from RuntimeModelCapabilityAdapter
 * and wraps it as a ProviderTokenBridge for token economy configuration.
 *
 * Unknown models resolve to `undefined` (see `resolveProviderTokenCapability`
 * for the named reason); dispatch then uses the explicitly tagged
 * `fallback_capability` or refuses, depending on its own policy. No context
 * capacity is ever derived from the output limit.
 *
 * G-34: `modelId` is threaded into every `capabilities` call below. Before
 * this, the parameter existed (defaulting to `"default"`, surfacing in the
 * returned `ProviderTokenCapability.model_id`) but was never actually passed
 * to `resolveOutputLimit`/`estimateTokens` — so `OpenCodeProviderCapabilityAdapter`'s
 * `maxOutputTokens({model: undefined})` always took the "no model" branch and
 * answered `null` without ever warming its lazy cache for a named model
 * (`cli.ts`'s `OpenCodeProviderCapabilityAdapter` doc comment names this
 * exact caller as the reason it stays dark in production). This closes that
 * hollow shape: this bridge is the sole caller into the adapter, and it now
 * genuinely feeds the model id it was given.
 */
export function modelCapabilityTokenBridge(
  capabilities: ModelCapabilityPort,
  providerId = "arbor-runtime",
  modelId = "default",
): ProviderTokenBridge {
  return {
    capability(_params: { campaign_id: string; node_id: string }): ProviderTokenCapability | undefined {
      const status = resolveProviderTokenCapability(capabilities, providerId, modelId);
      return status.status === "available" ? status.capability : undefined;
    },
    capabilityStatus(_params: { campaign_id: string; node_id: string }): ProviderCapabilityStatus {
      return resolveProviderTokenCapability(capabilities, providerId, modelId);
    },
    async count(text: string, _capability: ProviderTokenCapability): Promise<number> {
      const estimate = await capabilities.estimateTokens({ content: text, model: modelId });
      return estimate?.value ?? Math.ceil(text.length / 4);
    },
    counter_id: "arbor-runtime-model-capability",
  };
}
