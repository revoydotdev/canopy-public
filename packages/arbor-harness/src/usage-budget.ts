/**
 * Static model-pricing and bounded-usage controls for native inference.
 *
 * This module is intentionally provider-neutral.  It neither fetches a
 * pricing page nor guesses a model's tokenizer: composition supplies an
 * exact model observation and, when a prospective limit is requested, an
 * explicit estimate authority.  Absence is a typed refusal, never free use.
 */
import type { Cost } from "@arbor/core";
import type { NativeUsageAndCost } from "./inference.js";
import type { NativeModelRequest } from "./native-worker.js";

const ONE_MILLION = 1_000_000;

export interface NativeConfiguredPriceObservation {
  /** Stable operator/configuration identity, recorded in priced Cost facts. */
  readonly price_source_id: string;
  /** ISO timestamp at which this static schedule was observed/configured. */
  readonly observed_at: string;
  readonly provider_id: string;
  readonly model_id: string;
  readonly currency: string;
  readonly minor_unit_exponent: number;
  /** Exact integer minor units per one million provider input tokens. */
  readonly input_minor_units_per_million_tokens: number;
  /** Exact integer minor units per one million provider output tokens. */
  readonly output_minor_units_per_million_tokens: number;
  /** Cache traffic is billed independently; these rates must never fall back to fresh input. */
  readonly cache_read_minor_units_per_million_tokens: number;
  readonly cache_write_minor_units_per_million_tokens: number;
}

export type NativePriceResolution =
  | { readonly kind: "priced"; readonly cost: Extract<Cost, { kind: "priced" }>; readonly observation: NativeConfiguredPriceObservation }
  | { readonly kind: "unpriced"; readonly reason: string };

/** Composition-owned authority; implementations must never consult ambient/live prices. */
export interface NativeModelPricingAuthority {
  price(input: {
    readonly provider_id: string;
    readonly model_id: string;
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cache_read_tokens: number;
    readonly cache_write_tokens: number;
  }): NativePriceResolution;
}

/**
 * The narrow reference authority accepts one immutable static observation.
 * It intentionally requires an exact provider/model match: a similarly named
 * model, revision, or provider account is not a price-schedule match.
 */
export class StaticNativeModelPricingAuthority implements NativeModelPricingAuthority {
  readonly observation: NativeConfiguredPriceObservation;

  constructor(observation: NativeConfiguredPriceObservation) {
    this.observation = freezePriceObservation(observation);
  }

  price(input: { readonly provider_id: string; readonly model_id: string; readonly input_tokens: number; readonly output_tokens: number; readonly cache_read_tokens: number; readonly cache_write_tokens: number }): NativePriceResolution {
    if (![input.input_tokens, input.output_tokens, input.cache_read_tokens, input.cache_write_tokens].every(validTokens)) return { kind: "unpriced", reason: "token observation is invalid for configured pricing" };
    if (input.provider_id !== this.observation.provider_id || input.model_id !== this.observation.model_id) {
      return { kind: "unpriced", reason: "no exact configured price observation matches this provider/model" };
    }
    const inputCost = ceilRatio(input.input_tokens, this.observation.input_minor_units_per_million_tokens);
    const outputCost = ceilRatio(input.output_tokens, this.observation.output_minor_units_per_million_tokens);
    const cacheReadCost = ceilRatio(input.cache_read_tokens, this.observation.cache_read_minor_units_per_million_tokens);
    const cacheWriteCost = ceilRatio(input.cache_write_tokens, this.observation.cache_write_minor_units_per_million_tokens);
    const total = inputCost + outputCost + cacheReadCost + cacheWriteCost;
    if (![inputCost, outputCost, cacheReadCost, cacheWriteCost, total].every(Number.isSafeInteger)) {
      return { kind: "unpriced", reason: "configured price calculation exceeds safe integer range" };
    }
    return {
      kind: "priced",
      observation: this.observation,
      cost: Object.freeze({ kind: "priced", minor_units: total, currency: this.observation.currency, minor_unit_exponent: this.observation.minor_unit_exponent, price_source_id: this.observation.price_source_id }),
    };
  }
}

export type NativeProspectiveTokenEstimate =
  | { readonly kind: "estimated"; readonly input_tokens: number; readonly output_tokens: number; readonly cache_read_tokens: number | null; readonly cache_write_tokens: number | null; readonly authority: string }
  | { readonly kind: "unavailable"; readonly reason: string };

/** A declared upper-bound estimator, used only when a caller configures a prospective limit. */
export interface NativeTokenEstimateAuthority {
  estimate(request: NativeModelRequest): NativeProspectiveTokenEstimate;
}

/**
 * Explicit conservative estimator for providers without a composed tokenizer.
 * One UTF-8 byte per token is an upper bound, not a claim about provider token
 * accounting.  The configured output bound must also be sent to the provider
 * adapter, so a preflight estimate cannot be silently exceeded in one call.
 */
export class NativeUtf8UpperBoundTokenEstimator implements NativeTokenEstimateAuthority {
  constructor(private readonly options: { readonly authority: string; readonly max_input_tokens: number; readonly max_output_tokens: number }) {
    if (options.authority.trim().length === 0) throw new Error("token estimate authority must be non-empty");
    if (!validTokens(options.max_input_tokens) || options.max_input_tokens <= 0 || !validTokens(options.max_output_tokens) || options.max_output_tokens <= 0) throw new Error("token estimate input/output bounds must be positive safe integers");
  }

  estimate(request: NativeModelRequest): NativeProspectiveTokenEstimate {
    const inputTokens = Buffer.byteLength(JSON.stringify(request), "utf8");
    if (!Number.isSafeInteger(inputTokens)) return { kind: "unavailable", reason: "UTF-8 upper-bound estimate exceeds safe integer range" };
    if (inputTokens > this.options.max_input_tokens) return { kind: "unavailable", reason: "request exceeds the configured maximum input-token estimate" };
    // Each cache counter is a subset of provider prompt input. Bounding each
    // separately by the complete UTF-8 request byte count is conservative even
    // when the provider's cache partition and tokenization are unknown. It can
    // over-reserve, but cannot turn unavailable cache telemetry into zero use.
    return Object.freeze({ kind: "estimated", input_tokens: inputTokens, output_tokens: this.options.max_output_tokens, cache_read_tokens: inputTokens, cache_write_tokens: inputTokens, authority: this.options.authority });
  }
}

/** Safe upper-bound token and cost ceilings for one isolated native session. */
export interface NativeUsageBudgetLimits {
  /** Fresh, non-cache input tokens. `max_input_tokens` remains a compatibility alias. */
  readonly max_fresh_input_tokens?: number;
  readonly max_input_tokens?: number;
  readonly max_output_tokens?: number;
  readonly max_cache_read_tokens?: number;
  readonly max_cache_write_tokens?: number;
  readonly max_total_tokens?: number;
  readonly max_cost?: Readonly<{ currency: string; minor_units: number; minor_unit_exponent: number }>;
}

export type NativeBudgetDecision =
  | { readonly allowed: true; readonly estimate: NativeProspectiveTokenEstimate | null }
  | { readonly allowed: false; readonly reason: string };

export interface NativeUsageBudgetPort {
  admit(request: NativeModelRequest): NativeBudgetDecision;
  observe(observation: NativeUsageAndCost): { readonly observation: NativeUsageAndCost; readonly allowed: boolean; readonly reason?: string };
  total(): NativeUsageAndCost | null;
}

/**
 * A session-local controller.  It blocks the next model call from crossing a
 * known prospective ceiling and terminates immediately after a provider's
 * measured observation crosses one, before the worker can call a tool or
 * another model turn.
 */
export class NativeUsageBudgetController implements NativeUsageBudgetPort {
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private freshInputTokens = 0;
  private cost: Cost | null = null;
  private terminalReason: string | null = null;

  constructor(
    private readonly options: {
      readonly provider_id: string;
      readonly model_id: string;
      readonly limits: NativeUsageBudgetLimits;
      readonly token_estimator?: NativeTokenEstimateAuthority;
      readonly pricing?: NativeModelPricingAuthority;
    },
  ) {
    assertLimits(options.limits);
  }

  admit(request: NativeModelRequest): NativeBudgetDecision {
    if (this.terminalReason !== null) return { allowed: false, reason: this.terminalReason };
    if (!hasLimits(this.options.limits)) return { allowed: true, estimate: null };
    const estimate = this.options.token_estimator?.estimate(request) ?? { kind: "unavailable" as const, reason: "no explicit token estimate authority was composed" };
    if (estimate.kind === "unavailable") return { allowed: false, reason: `prospective budget unavailable: ${estimate.reason}` };
    if (![estimate.input_tokens, estimate.output_tokens].every(validTokens) || !validEstimateDimension(estimate.cache_read_tokens) || !validEstimateDimension(estimate.cache_write_tokens) || estimate.authority.trim().length === 0) {
      return { allowed: false, reason: "prospective budget unavailable: token estimate authority returned an invalid estimate" };
    }
    const input = this.freshInputTokens + estimate.input_tokens;
    const output = this.outputTokens + estimate.output_tokens;
    const needsCacheEstimate = this.options.limits.max_cache_read_tokens !== undefined || this.options.limits.max_cache_write_tokens !== undefined || this.options.limits.max_total_tokens !== undefined || this.options.limits.max_cost !== undefined;
    if (needsCacheEstimate && (estimate.cache_read_tokens === null || estimate.cache_write_tokens === null)) return { allowed: false, reason: "prospective budget unavailable: estimator cannot bound cache-read and cache-write tokens" };
    const tokenFailure = exceedsTokenLimit(this.options.limits, input, output, this.cacheReadTokens + (estimate.cache_read_tokens ?? 0), this.cacheWriteTokens + (estimate.cache_write_tokens ?? 0));
    if (tokenFailure !== null) return { allowed: false, reason: tokenFailure };
    if (this.options.limits.max_cost !== undefined) {
      const price = this.options.pricing?.price({ provider_id: this.options.provider_id, model_id: this.options.model_id, input_tokens: estimate.input_tokens, output_tokens: estimate.output_tokens, cache_read_tokens: estimate.cache_read_tokens!, cache_write_tokens: estimate.cache_write_tokens! })
        ?? { kind: "unpriced" as const, reason: "no configured pricing authority was composed" };
      if (price.kind === "unpriced") return { allowed: false, reason: `prospective cost budget unavailable: ${price.reason}` };
      if (!matchesCostLimit(price.cost, this.options.limits.max_cost)) return { allowed: false, reason: "prospective cost budget unavailable: configured price denomination differs from the budget" };
      const existing = this.cost;
      if (existing !== null && (existing.kind !== "priced" || !sameDenomination(existing, price.cost))) return { allowed: false, reason: "prospective cost budget unavailable: cumulative cost denomination differs" };
      const total = (existing?.kind === "priced" ? existing.minor_units : 0) + price.cost.minor_units;
      if (!Number.isSafeInteger(total) || total > this.options.limits.max_cost.minor_units) return { allowed: false, reason: "prospective cost budget would be exceeded" };
    }
    return { allowed: true, estimate };
  }

  observe(observation: NativeUsageAndCost): { readonly observation: NativeUsageAndCost; readonly allowed: boolean; readonly reason?: string } {
    if (this.terminalReason !== null) return { observation, allowed: false, reason: this.terminalReason };
    let resolved: NativeUsageAndCost = observation;
    if (observation.tokens.kind === "measured" && observation.cost.kind === "unpriced" && this.options.pricing !== undefined) {
      const price = this.options.pricing.price({ provider_id: this.options.provider_id, model_id: this.options.model_id, input_tokens: observation.tokens.input_tokens, output_tokens: observation.tokens.output_tokens, cache_read_tokens: observation.tokens.cache_read_tokens, cache_write_tokens: observation.tokens.cache_write_tokens });
      if (price.kind === "priced") resolved = Object.freeze({ tokens: observation.tokens, cost: price.cost });
    }
    if (observation.tokens.kind === "measured") {
      this.inputTokens += observation.tokens.input_tokens;
      this.freshInputTokens += observation.tokens.input_tokens;
      this.outputTokens += observation.tokens.output_tokens;
      this.cacheReadTokens += observation.tokens.cache_read_tokens;
      this.cacheWriteTokens += observation.tokens.cache_write_tokens;
    }
    this.cost = addCost(this.cost, resolved.cost);
    const measuredCostHasWrongDenomination = this.options.limits.max_cost !== undefined
      && this.cost?.kind === "priced"
      && !matchesCostLimit(this.cost, this.options.limits.max_cost);
    const tokenFailure = observation.tokens.kind === "unavailable" && hasTokenLimits(this.options.limits)
      ? "runtime token budget cannot be enforced because the provider did not report measured usage"
      : exceedsTokenLimit(this.options.limits, this.freshInputTokens, this.outputTokens, this.cacheReadTokens, this.cacheWriteTokens);
    const costFailure = this.options.limits.max_cost !== undefined && (this.cost === null || this.cost.kind === "unpriced")
      ? "runtime cost budget cannot be enforced because no attributable configured price is available"
      : measuredCostHasWrongDenomination
        ? "runtime cost budget cannot be enforced because measured cost denomination differs from the budget"
      : this.options.limits.max_cost !== undefined && this.cost !== null && this.cost.kind === "priced" && this.cost.minor_units > this.options.limits.max_cost.minor_units
        ? "runtime cost budget exceeded"
        : null;
    const failure = tokenFailure ?? costFailure;
    if (failure !== null) this.terminalReason = failure;
    return failure === null ? { observation: resolved, allowed: true } : { observation: resolved, allowed: false, reason: failure };
  }

  total(): NativeUsageAndCost | null {
    if (this.cost === null && this.inputTokens === 0 && this.outputTokens === 0 && this.cacheReadTokens === 0 && this.cacheWriteTokens === 0) return null;
    return Object.freeze({ tokens: Object.freeze({ kind: "measured", input_tokens: this.inputTokens, output_tokens: this.outputTokens, cache_read_tokens: this.cacheReadTokens, cache_write_tokens: this.cacheWriteTokens }), cost: this.cost ?? Object.freeze({ kind: "unpriced", reason: "no provider cost or configured price was available" }) });
  }
}

function freezePriceObservation(value: NativeConfiguredPriceObservation): NativeConfiguredPriceObservation {
  for (const [name, field] of Object.entries({ price_source_id: value.price_source_id, provider_id: value.provider_id, model_id: value.model_id, currency: value.currency })) {
    if (typeof field !== "string" || field.trim().length === 0) throw new Error(`configured price ${name} must be non-empty`);
  }
  if (Number.isNaN(Date.parse(value.observed_at))) throw new Error("configured price observed_at must be an ISO timestamp");
  if (!Number.isSafeInteger(value.minor_unit_exponent) || value.minor_unit_exponent < 0 || value.minor_unit_exponent > 9) throw new Error("configured price minor_unit_exponent must be a safe integer between 0 and 9");
  if (![value.input_minor_units_per_million_tokens, value.output_minor_units_per_million_tokens, value.cache_read_minor_units_per_million_tokens, value.cache_write_minor_units_per_million_tokens].every(validTokens)) throw new Error("configured price rates must be non-negative safe integers");
  return Object.freeze({ ...value });
}

function assertLimits(limits: NativeUsageBudgetLimits): void {
  for (const [name, value] of Object.entries({ max_fresh_input_tokens: limits.max_fresh_input_tokens, max_input_tokens: limits.max_input_tokens, max_output_tokens: limits.max_output_tokens, max_cache_read_tokens: limits.max_cache_read_tokens, max_cache_write_tokens: limits.max_cache_write_tokens, max_total_tokens: limits.max_total_tokens })) {
    if (value !== undefined && !validTokens(value)) throw new Error(`${name} must be a non-negative safe integer when configured`);
  }
  if (limits.max_cost !== undefined) {
    if (typeof limits.max_cost.currency !== "string" || limits.max_cost.currency.trim().length === 0 || !validTokens(limits.max_cost.minor_units) || !Number.isSafeInteger(limits.max_cost.minor_unit_exponent) || limits.max_cost.minor_unit_exponent < 0 || limits.max_cost.minor_unit_exponent > 9) throw new Error("max_cost must contain a currency and non-negative safe integer minor amount/exponent");
  }
}
function hasLimits(limits: NativeUsageBudgetLimits): boolean { return limits.max_fresh_input_tokens !== undefined || limits.max_input_tokens !== undefined || limits.max_output_tokens !== undefined || limits.max_cache_read_tokens !== undefined || limits.max_cache_write_tokens !== undefined || limits.max_total_tokens !== undefined || limits.max_cost !== undefined; }
function hasTokenLimits(limits: NativeUsageBudgetLimits): boolean { return limits.max_fresh_input_tokens !== undefined || limits.max_input_tokens !== undefined || limits.max_output_tokens !== undefined || limits.max_cache_read_tokens !== undefined || limits.max_cache_write_tokens !== undefined || limits.max_total_tokens !== undefined; }
function exceedsTokenLimit(limits: NativeUsageBudgetLimits, input: number, output: number, cacheRead: number, cacheWrite: number): string | null {
  const freshLimit = limits.max_fresh_input_tokens ?? limits.max_input_tokens;
  if (freshLimit !== undefined && input > freshLimit) return "native fresh-input-token budget would be exceeded";
  if (limits.max_output_tokens !== undefined && output > limits.max_output_tokens) return "native output-token budget would be exceeded";
  if (limits.max_cache_read_tokens !== undefined && cacheRead > limits.max_cache_read_tokens) return "native cache-read-token budget would be exceeded";
  if (limits.max_cache_write_tokens !== undefined && cacheWrite > limits.max_cache_write_tokens) return "native cache-write-token budget would be exceeded";
  if (limits.max_total_tokens !== undefined && input + output + cacheRead + cacheWrite > limits.max_total_tokens) return "native total-token budget would be exceeded";
  return null;
}
function addCost(existing: Cost | null, next: Cost): Cost {
  if (existing === null) return next;
  if (existing.kind !== "priced" || next.kind !== "priced" || !sameDenomination(existing, next)) return { kind: "unpriced", reason: "cumulative cost is unavailable because observations lack one matching configured price denomination" };
  const total = existing.minor_units + next.minor_units;
  return Number.isSafeInteger(total) ? { ...existing, minor_units: total } : { kind: "unpriced", reason: "cumulative configured cost exceeds safe integer range" };
}
function sameDenomination(left: Extract<Cost, { kind: "priced" }>, right: Extract<Cost, { kind: "priced" }>): boolean { return left.currency === right.currency && left.minor_unit_exponent === right.minor_unit_exponent && left.price_source_id === right.price_source_id; }
function matchesCostLimit(cost: Extract<Cost, { kind: "priced" }>, limit: NonNullable<NativeUsageBudgetLimits["max_cost"]>): boolean {
  return cost.currency === limit.currency && cost.minor_unit_exponent === limit.minor_unit_exponent;
}
function ceilRatio(tokens: number, rate: number): number {
  const numerator = BigInt(tokens) * BigInt(rate);
  const rounded = (numerator + BigInt(ONE_MILLION - 1)) / BigInt(ONE_MILLION);
  return Number(rounded);
}
function validTokens(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function validEstimateDimension(value: unknown): value is number | null { return value === null || validTokens(value); }
