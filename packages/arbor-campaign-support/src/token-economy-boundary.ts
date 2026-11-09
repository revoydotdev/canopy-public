import {
  countWithCharacterFallback,
  foldStructuralContext,
  willManageContext,
  type ContextCapability,
  type ExpansionTokenEpoch,
  type ManagementPrediction,
  type ProviderTokenCapability,
  type StructuralContextEntry,
  type StructuralFoldPolicy,
  type TokenCount,
  type TokenUsage,
} from "@arbor/core";

export interface ExpansionTokenEpochPort {
  ensure(input: {
    campaign_id: string;
    node_id: string;
    expansion_id: string;
    capability: ProviderTokenCapability;
    reserved_output_tokens: number;
    requested_output_tokens: number;
    prefill: TokenCount;
  }): ExpansionTokenEpoch;
  claimWarning(campaignId: string, nodeId: string, expansionId: string, expectedRevision: number): { status: "claimed" | "idempotent" | "conflict"; epoch: ExpansionTokenEpoch };
  claimOverflowRetry(campaignId: string, nodeId: string, expansionId: string): { status: "claimed" | "exhausted"; epoch: ExpansionTokenEpoch };
  recordPrefill(campaignId: string, nodeId: string, expansionId: string, prefill: TokenCount): { status: "recorded" | "idempotent"; epoch: ExpansionTokenEpoch };
  claimManagement(campaignId: string, nodeId: string, expansionId: string, prediction: ManagementPrediction, claimId: string): { status: "claimed" | "idempotent" | "not_required" | "stale_prediction" | "claim_conflict"; epoch: ExpansionTokenEpoch };
  recordUsage(campaignId: string, nodeId: string, expansionId: string, usage: TokenUsage, expectedRevision?: number): { status: "recorded" | "idempotent" | "conflict"; epoch: ExpansionTokenEpoch };
}

export type ProviderCapabilityStatus =
  | { readonly status: "available"; readonly capability: ProviderTokenCapability }
  | {
    readonly status: "unavailable";
    readonly provider_id: string;
    readonly model_id: string;
    /** Names the missing piece (max output tokens, context capacity, or their inconsistency). */
    readonly missing: string;
  };

export interface ProviderTokenBridge {
  capability(params: { campaign_id: string; node_id: string }): ProviderTokenCapability | undefined | Promise<ProviderTokenCapability | undefined>;
  /**
   * Optional typed report for unknown models. Bridges built on
   * `resolveProviderTokenCapability` implement it so a caller can name the
   * missing capability instead of seeing a bare `undefined`. No dispatch path
   * consumes it yet: `prepareTokenDispatch` only calls `capability()`.
   */
  capabilityStatus?(params: { campaign_id: string; node_id: string }): ProviderCapabilityStatus | Promise<ProviderCapabilityStatus>;
  count?(text: string, capability: ProviderTokenCapability): number | Promise<number>;
  readonly counter_id?: string;
}

export interface StructuralContextPort {
  entries(params: { campaign_id: string; node_id: string; capability: ContextCapability }): readonly StructuralContextEntry[] | Promise<readonly StructuralContextEntry[]>;
}

export interface TokenEconomyConfig {
  readonly epochs: ExpansionTokenEpochPort;
  readonly provider: ProviderTokenBridge;
  readonly fallback_capability: ProviderTokenCapability;
  readonly reserved_output_tokens: number;
  readonly requested_output_tokens: number;
  readonly warning_threshold_tokens?: number;
  readonly characters_per_token?: number;
  readonly structural_context?: StructuralContextPort;
  readonly structural_policy?: StructuralFoldPolicy;
  /** Stable operation/attempt identity. Replay returns the same epoch; a retry must return a new value. */
  readonly expansion_id: (params: { campaign_id: string; node_id: string; phase: string; attempt_id?: string }) => string;
  /** Optional content-preserving reducer invoked at most once for one expansion epoch. */
  readonly overflow_recovery?: (input: {
    readonly prompt: string;
    readonly base_prompt: string;
    readonly campaign_id: string;
    readonly node_id: string;
    readonly capability: ContextCapability;
    readonly overflow_tokens: number;
    readonly eligible_input_tokens: number;
    readonly phase: string;
    readonly count_prompt: (text: string) => Promise<number>;
  }) => string | null | Promise<string | null>;
  /** Hard ceiling is one retry per persisted expansion epoch; zero disables it. */
  readonly overflow_retry_budget?: 0 | 1;
}

export type TokenDispatchPreparation = {
  readonly status: "ready" | "suppressed_overflow";
  readonly prompt: string;
  readonly epoch: ExpansionTokenEpoch;
  readonly expansion_id: string;
  readonly counted: TokenCount;
  readonly overflow_tokens: number;
  readonly recovered_from_overflow_tokens: number;
  readonly warning: "none" | "claimed" | "idempotent" | "conflict";
  readonly management: "not_required" | "claimed" | "idempotent" | "stale_prediction" | "claim_conflict";
  readonly overflow_retry: "not_needed" | "recovered" | "exhausted" | "unavailable" | "recovery_failed";
};

/**
 * Read-only projection of the literal prompt handed to an executor.  Keeping
 * this step separate from epoch/warning claims lets diagnostics inspect the
 * real model input without changing token-accounting authority.
 */
export async function projectTokenDispatchPrompt(input: {
  campaign_id: string;
  node_id: string;
  prompt: string;
  capability: ContextCapability;
  config: Pick<TokenEconomyConfig, "structural_context" | "structural_policy">;
}): Promise<string> {
  const structural = input.config.structural_context
    ? await input.config.structural_context.entries(input)
    : [];
  const folded = structural.length > 0
    ? foldStructuralContext(structural, input.capability, input.config.structural_policy ?? {
      max_entries: 50,
      recent_tail: 5,
      max_rendered_characters: 12_000,
    })
    : undefined;
  return folded ? `${input.prompt}\n\nStructural context:\n${folded.rendered}` : input.prompt;
}

export async function prepareTokenDispatch(input: {
  campaign_id: string;
  node_id: string;
  prompt: string;
  capability: ContextCapability;
  phase: string;
  /** Stable identity of the currently active node expansion; retries must change it. */
  attempt_id?: string;
  config: TokenEconomyConfig;
}): Promise<TokenDispatchPreparation> {
  let prompt = await projectTokenDispatchPrompt(input);
  let advertised: ProviderTokenCapability | undefined;
  try { advertised = await input.config.provider.capability({ campaign_id: input.campaign_id, node_id: input.node_id }); } catch { advertised = undefined; }
  const capability = advertised ?? input.config.fallback_capability;
  let counted = await countPrompt(prompt, capability, input.config.provider, input.config.characters_per_token);
  const expansionId = input.config.expansion_id({ campaign_id: input.campaign_id, node_id: input.node_id, phase: input.phase, ...(input.attempt_id === undefined ? {} : { attempt_id: input.attempt_id }) });
  if (!expansionId.trim()) throw new Error("token expansion_id must be non-empty");
  let epoch = input.config.epochs.ensure({
    campaign_id: input.campaign_id,
    node_id: input.node_id,
    expansion_id: expansionId,
    capability,
    reserved_output_tokens: input.config.reserved_output_tokens,
    requested_output_tokens: input.config.requested_output_tokens,
    prefill: counted,
  });
  let active = counted.tokens;
  let retry: TokenDispatchPreparation["overflow_retry"] = "not_needed";
  const threshold = input.config.warning_threshold_tokens ?? Math.floor(epoch.eligible_input_tokens * 0.8);
  let warning: TokenDispatchPreparation["warning"] = "none";
  let management: TokenDispatchPreparation["management"] = "not_required";
  if (active >= Math.min(threshold, epoch.eligible_input_tokens)) {
    const warningResult = input.config.epochs.claimWarning(input.campaign_id, input.node_id, expansionId, epoch.revision);
    warning = warningResult.status;
    epoch = warningResult.epoch;
    const prediction = willManageContext(epoch, threshold);
    const result = input.config.epochs.claimManagement(
      input.campaign_id,
      input.node_id,
      expansionId,
      prediction,
      `context:${input.campaign_id}:${input.node_id}`,
    );
    management = result.status;
    epoch = result.epoch;
  }
  let overflow = Math.max(0, active - epoch.eligible_input_tokens);
  const initialOverflow = overflow;
  if (overflow > 0) {
    const retryBudget = input.config.overflow_retry_budget ?? 1;
    if (retryBudget !== 0 && retryBudget !== 1) throw new Error("overflow_retry_budget must be 0 or 1");
    if (retryBudget === 0) retry = "unavailable";
    else if (!input.config.overflow_recovery) retry = "unavailable";
    else {
      const claim = input.config.epochs.claimOverflowRetry(input.campaign_id, input.node_id, expansionId);
      epoch = claim.epoch;
      if (claim.status === "exhausted") retry = "exhausted";
      else {
        try {
          const recovered = await input.config.overflow_recovery({
            prompt,
            base_prompt: input.prompt,
            campaign_id: input.campaign_id,
            node_id: input.node_id,
            capability: input.capability,
            overflow_tokens: overflow,
            eligible_input_tokens: epoch.eligible_input_tokens,
            phase: input.phase,
            count_prompt: async (text) => (await countPrompt(text, capability, input.config.provider, input.config.characters_per_token)).tokens,
          });
          if (recovered === null || recovered.trim().length === 0) retry = "recovery_failed";
          else {
            const recoveredCount = await countPrompt(recovered, capability, input.config.provider, input.config.characters_per_token);
            prompt = recovered;
            counted = recoveredCount;
            active = recoveredCount.tokens;
            overflow = Math.max(0, active - epoch.eligible_input_tokens);
            retry = overflow === 0 ? "recovered" : "recovery_failed";
            if (overflow === 0) epoch = input.config.epochs.recordPrefill(input.campaign_id, input.node_id, expansionId, recoveredCount).epoch;
          }
        } catch { retry = "recovery_failed"; }
      }
    }
  }
  return {
    status: overflow > 0 ? "suppressed_overflow" : "ready",
    prompt,
    epoch,
    expansion_id: expansionId,
    counted,
    overflow_tokens: overflow,
    recovered_from_overflow_tokens: retry === "recovered" ? initialOverflow : 0,
    warning,
    management,
    overflow_retry: retry,
  };
}

async function countPrompt(text: string, capability: ProviderTokenCapability, provider: ProviderTokenBridge, charactersPerToken?: number): Promise<TokenCount> {
  if (provider.count) {
    try {
      const tokens = await provider.count(text, capability);
      if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error("provider token count must be a non-negative safe integer");
      const counterId = provider.counter_id?.trim();
      if (!counterId) throw new Error("provider counter must expose counter_id");
      return { tokens, source: "provider_counter", counter_id: counterId };
    } catch {
      return countWithCharacterFallback(text, charactersPerToken);
    }
  }
  return countWithCharacterFallback(text, charactersPerToken);
}

/** Routing signal only: it is never a critic verdict, node failure, or KB fact. */
export class ContextOverflowError extends Error {
  readonly code = "eligible_context_overflow" as const;
  constructor(
    readonly campaign_id: string,
    readonly node_id: string,
    readonly phase: string,
    readonly epoch_id: string,
    readonly overflow_tokens: number,
  ) {
    super(`Eligible context overflow (${overflow_tokens} tokens) during ${phase}; model dispatch suppressed`);
    this.name = "ContextOverflowError";
  }
}
