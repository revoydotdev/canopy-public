import type { Provenance } from "./types.js";

export type CapabilitySource = "runtime" | "snapshot" | "configured";
export interface ProviderTokenCapability {
  readonly provider_id: string;
  readonly model_id: string;
  readonly context_capacity: number;
  readonly max_output_tokens: number;
  readonly source: CapabilitySource;
}

export type TokenCount =
  | { readonly tokens: number; readonly source: "provider_counter"; readonly counter_id: string }
  | { readonly tokens: number; readonly source: "character_fallback"; readonly characters_per_token: number };

export interface TokenCounter {
  readonly counter_id: string;
  count(text: string, capability: ProviderTokenCapability): number;
}

export interface AppliedTokenBudget {
  readonly eligible_input_tokens: number;
  readonly reserved_output_tokens: number;
  readonly applied_output_tokens: number;
  readonly output_limit_source: "requested" | "provider_capability";
  readonly capability_source: CapabilitySource;
}

export interface TokenUsage {
  /** Provider-measured fresh input, excluding the two cache buckets below. */
  readonly input_tokens: number;
  readonly output_tokens: number;
  /** Cache-read and cache-write values are disjoint prompt-input buckets. */
  readonly cached_input_tokens: number;
  readonly cache_write_input_tokens: number;
  readonly counter_source: TokenCount["source"];
}

export interface ContextManagementClaim {
  readonly claim_id: string;
  readonly epoch_revision: number;
  readonly active_tokens_before: number;
}

export interface ExpansionTokenEpoch {
  readonly epoch_id: string;
  readonly provider_id: string;
  readonly model_id: string;
  readonly capability_source: CapabilitySource;
  readonly context_capacity: number;
  readonly reserved_output_tokens: number;
  readonly eligible_input_tokens: number;
  readonly applied_output_tokens: number;
  readonly output_limit_source: AppliedTokenBudget["output_limit_source"];
  readonly prefill: TokenCount;
  readonly usage: TokenUsage;
  readonly warning_delivered: boolean;
  /** Durable one-shot claim; set before an overflow recovery callback runs. */
  readonly overflow_retry_claimed?: boolean;
  readonly management_claim?: ContextManagementClaim;
  readonly revision: number;
}

/** Explicit last-resort approximation; callers cannot mistake it for provider accounting. */
export function countWithCharacterFallback(text: string, charactersPerToken = 4): TokenCount {
  if (!Number.isFinite(charactersPerToken) || charactersPerToken <= 0) throw new Error("characters_per_token must be positive");
  return { tokens: Math.ceil([...text].length / charactersPerToken), source: "character_fallback", characters_per_token: charactersPerToken };
}

export function resolveTokenBudget(capability: ProviderTokenCapability, reservedOutput: number, requestedOutput: number): AppliedTokenBudget {
  validateCapability(capability);
  assertNonNegativeInteger(reservedOutput, "reserved output");
  assertNonNegativeInteger(requestedOutput, "requested output");
  const appliedOutput = Math.min(requestedOutput, capability.max_output_tokens);
  // The request itself consumes output headroom even if a caller configured a
  // smaller reserve. Never advertise those same tokens as eligible input.
  const reserved = Math.min(Math.max(reservedOutput, appliedOutput), capability.context_capacity);
  return {
    eligible_input_tokens: capability.context_capacity - reserved,
    reserved_output_tokens: reserved,
    applied_output_tokens: appliedOutput,
    output_limit_source: requestedOutput > capability.max_output_tokens ? "provider_capability" : "requested",
    capability_source: capability.source,
  };
}

export function createExpansionTokenEpoch(input: {
  epoch_id: string;
  capability: ProviderTokenCapability;
  reserved_output_tokens: number;
  requested_output_tokens: number;
  prefill: TokenCount;
  usage?: Partial<Omit<TokenUsage, "counter_source">>;
}): ExpansionTokenEpoch {
  if (!input.epoch_id.trim()) throw new Error("epoch_id must be non-empty");
  validateCount(input.prefill);
  const budget = resolveTokenBudget(input.capability, input.reserved_output_tokens, input.requested_output_tokens);
  const usage: TokenUsage = {
    input_tokens: input.usage?.input_tokens ?? input.prefill.tokens,
    output_tokens: input.usage?.output_tokens ?? 0,
    cached_input_tokens: input.usage?.cached_input_tokens ?? 0,
    cache_write_input_tokens: input.usage?.cache_write_input_tokens ?? 0,
    counter_source: input.prefill.source,
  };
  for (const [key, value] of Object.entries(usage)) if (key !== "counter_source") assertNonNegativeInteger(value, key);
  return Object.freeze({
    epoch_id: input.epoch_id, provider_id: input.capability.provider_id, model_id: input.capability.model_id,
    context_capacity: input.capability.context_capacity,
    ...budget, prefill: Object.freeze({ ...input.prefill }), usage: Object.freeze(usage), warning_delivered: false, overflow_retry_claimed: false, revision: 0,
  });
}

export function claimOverflowRetry(epoch: ExpansionTokenEpoch): { readonly status: "claimed" | "exhausted"; readonly epoch: ExpansionTokenEpoch } {
  if (epoch.overflow_retry_claimed) return { status: "exhausted", epoch };
  return { status: "claimed", epoch: Object.freeze({ ...epoch, overflow_retry_claimed: true, revision: epoch.revision + 1 }) };
}

export function recordTokenPrefill(epoch: ExpansionTokenEpoch, prefill: TokenCount): ExpansionTokenEpoch {
  validateCount(prefill);
  if (JSON.stringify(epoch.prefill) === JSON.stringify(prefill)) return epoch;
  const usage = epoch.usage.input_tokens === epoch.prefill.tokens
    ? Object.freeze({ ...epoch.usage, input_tokens: prefill.tokens, counter_source: prefill.source })
    : epoch.usage;
  return Object.freeze({ ...epoch, prefill: Object.freeze({ ...prefill }), usage, revision: epoch.revision + 1 });
}

export function claimBudgetWarning(epoch: ExpansionTokenEpoch): ExpansionTokenEpoch {
  if (epoch.warning_delivered) return epoch;
  return Object.freeze({ ...epoch, warning_delivered: true, revision: epoch.revision + 1 });
}

/** Replaces provider-observed totals without mutating a recovered epoch. */
export function recordTokenUsage(epoch: ExpansionTokenEpoch, usage: TokenUsage): ExpansionTokenEpoch {
  for (const [key, value] of Object.entries(usage)) if (key !== "counter_source") assertNonNegativeInteger(value, key);
  const unchanged = Object.entries(usage).every(([key, value]) => epoch.usage[key as keyof TokenUsage] === value);
  if (unchanged) return epoch;
  return Object.freeze({ ...epoch, usage: Object.freeze({ ...usage }), revision: epoch.revision + 1 });
}

export interface ManagementPrediction {
  readonly epoch_id: string;
  readonly epoch_revision: number;
  readonly active_tokens: number;
  readonly should_manage: boolean;
  readonly reason: "within_budget" | "threshold_reached" | "context_exhausted" | "already_claimed";
}

export function willManageContext(epoch: ExpansionTokenEpoch, thresholdTokens = epoch.eligible_input_tokens): ManagementPrediction {
  assertNonNegativeInteger(thresholdTokens, "management threshold");
  const active = totalInputUsage(epoch);
  const claimed = epoch.management_claim !== undefined;
  const exhausted = active >= epoch.eligible_input_tokens;
  return {
    epoch_id: epoch.epoch_id, epoch_revision: epoch.revision, active_tokens: active,
    should_manage: !claimed && active >= Math.min(thresholdTokens, epoch.eligible_input_tokens),
    reason: claimed ? "already_claimed" : exhausted ? "context_exhausted" : active >= thresholdTokens ? "threshold_reached" : "within_budget",
  };
}

export type ManageContextResult =
  | { readonly status: "claimed"; readonly epoch: ExpansionTokenEpoch }
  | { readonly status: "idempotent"; readonly epoch: ExpansionTokenEpoch }
  | { readonly status: "not_required" | "stale_prediction" | "claim_conflict"; readonly epoch: ExpansionTokenEpoch };

export function manageContext(epoch: ExpansionTokenEpoch, prediction: ManagementPrediction, claimId: string): ManageContextResult {
  if (!claimId.trim()) throw new Error("claim_id must be non-empty");
  if (epoch.management_claim) return { status: epoch.management_claim.claim_id === claimId ? "idempotent" : "claim_conflict", epoch };
  if (prediction.epoch_id !== epoch.epoch_id || prediction.epoch_revision !== epoch.revision || prediction.active_tokens !== totalInputUsage(epoch)) {
    return { status: "stale_prediction", epoch };
  }
  if (!prediction.should_manage) return { status: "not_required", epoch };
  return {
    status: "claimed",
    epoch: Object.freeze({ ...epoch, management_claim: Object.freeze({ claim_id: claimId, epoch_revision: epoch.revision, active_tokens_before: prediction.active_tokens }), revision: epoch.revision + 1 }),
  };
}

export type ContextCapability = "specialist" | "critic";
export interface StructuralContextEntry {
  readonly identity: string;
  readonly signature?: string;
  readonly content_hash: string;
  readonly evidence_pointer: string;
  readonly provenance: Provenance;
  readonly visibility: ContextCapability;
  readonly content: string;
}
export interface StructuralFoldPolicy { readonly max_entries: number; readonly recent_tail: number; readonly max_rendered_characters: number; }
export interface FoldedStructure { readonly identity: string; readonly signature?: string; readonly content_hash: string; readonly evidence_pointer: string; readonly provenance: Provenance; }
export interface FoldedContext {
  readonly structures: readonly FoldedStructure[];
  readonly recent_tail: readonly (FoldedStructure & { readonly content: string })[];
  readonly elided_count: number;
  readonly rendered: string;
}

/** Deterministic structural projection. Entries that cannot fit are explicitly counted, never partially forged. */
export function foldStructuralContext(entries: readonly StructuralContextEntry[], capability: ContextCapability, policy: StructuralFoldPolicy): FoldedContext {
  validateFoldPolicy(policy);
  const visible = entries.filter((entry) => capability === "critic" || entry.visibility === "specialist");
  const candidates = visible.slice(-policy.max_entries);
  let structures = candidates.map(toStructure);
  let recent = candidates.slice(-policy.recent_tail).map((entry) => ({ ...toStructure(entry), content: entry.content }));
  let elided = visible.length - candidates.length;
  let rendered = renderFold(structures, recent, elided);
  while (rendered.length > policy.max_rendered_characters && recent.length > 0) {
    recent = recent.slice(1); elided += 1; rendered = renderFold(structures, recent, elided);
  }
  while (rendered.length > policy.max_rendered_characters && structures.length > 0) {
    const removed = structures[0]!.identity;
    structures = structures.slice(1); recent = recent.filter((entry) => entry.identity !== removed);
    elided += 1; rendered = renderFold(structures, recent, elided);
  }
  if (rendered.length > policy.max_rendered_characters) rendered = explicitElision(elided, policy.max_rendered_characters);
  return Object.freeze({ structures: Object.freeze(structures), recent_tail: Object.freeze(recent), elided_count: elided, rendered });
}

function totalInputUsage(epoch: ExpansionTokenEpoch): number {
  return epoch.usage.input_tokens + epoch.usage.cached_input_tokens + epoch.usage.cache_write_input_tokens;
}
function toStructure(entry: StructuralContextEntry): FoldedStructure {
  if (!entry.identity.trim() || !entry.content_hash.trim() || !entry.evidence_pointer.trim()) throw new Error("structural identities, hashes, and evidence pointers must be non-empty");
  return { identity: entry.identity, ...(entry.signature === undefined ? {} : { signature: entry.signature }), content_hash: entry.content_hash, evidence_pointer: entry.evidence_pointer, provenance: structuredClone(entry.provenance) };
}
function renderFold(structures: FoldedStructure[], recent: Array<FoldedStructure & { content: string }>, elided: number): string {
  return JSON.stringify({ kind: "structural_fold", structures, recent_tail: recent, elided_count: elided });
}
function explicitElision(count: number, max: number): string {
  const marker = JSON.stringify({ kind: "structural_fold", elided_count: count, exhausted: true });
  return marker.length <= max ? marker : JSON.stringify({ elided: true });
}
function validateCapability(value: ProviderTokenCapability): void {
  if (!value.provider_id.trim() || !value.model_id.trim()) throw new Error("provider_id and model_id must be non-empty");
  assertPositiveInteger(value.context_capacity, "context capacity");
  assertPositiveInteger(value.max_output_tokens, "maximum output");
  if (value.max_output_tokens > value.context_capacity) throw new Error("maximum output cannot exceed context capacity");
}
function validateCount(value: TokenCount): void { assertNonNegativeInteger(value.tokens, "token count"); }
function validateFoldPolicy(policy: StructuralFoldPolicy): void {
  assertPositiveInteger(policy.max_entries, "max_entries"); assertNonNegativeInteger(policy.recent_tail, "recent_tail"); assertPositiveInteger(policy.max_rendered_characters, "max_rendered_characters");
  if (policy.max_rendered_characters < 16) throw new Error("max_rendered_characters must fit an explicit elision marker");
}
function assertPositiveInteger(value: number, label: string): void { if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`); }
function assertNonNegativeInteger(value: unknown, label: string): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative safe integer`); }
