/**
 * arbor-eval/frontier-flash-profile — a closed, eval-owned prerequisite for
 * the testing-only DeepSeek V4 Flash lane.
 *
 * Source exposure: independently authored from the user constraint and the
 * recorded public OpenRouter catalog facts in
 * docs/frontier-operator-interface/assimilation/reference-lock.json. No
 * external implementation, test, asset, or live provider call is used here.
 *
 * This module deliberately does not read environment variables, create an
 * adapter/port, or dispatch a request. A caller must first supply a fresh,
 * bounded catalog attestation and an explicit credential presence signal; a
 * later eval-only composition seam may consume a `ready` outcome. There is no
 * fallback route or production eligibility in this profile.
 */

const FRONTIER_FLASH_PROVIDER_ID = "openrouter" as const;
const FRONTIER_FLASH_ADAPTER_ID = "openai-compatible" as const;
const FRONTIER_FLASH_MODEL_ID = "deepseek/deepseek-v4-flash-0731" as const;
const FRONTIER_FLASH_CANONICAL_SLUG = "deepseek/deepseek-v4-flash-20260731" as const;

/** A catalog attestation must be no older than this hard upper bound. */
const MAX_FRONTIER_FLASH_ATTESTATION_AGE_MS = 15 * 60 * 1000;
const MAX_OBSERVED_METADATA_ENTRIES = 9;
const MAX_OBSERVED_METADATA_STRING_LENGTH = 128;

export interface FrontierFlashTestingProfile {
  readonly provider_id: typeof FRONTIER_FLASH_PROVIDER_ID;
  readonly adapter_id: typeof FRONTIER_FLASH_ADAPTER_ID;
  readonly model_id: typeof FRONTIER_FLASH_MODEL_ID;
  readonly canonical_slug: typeof FRONTIER_FLASH_CANONICAL_SLUG;
  readonly testing_only: true;
  readonly production_eligible: false;
  readonly fallback: null;
}

/**
 * The only profile this module can make ready. Keep these constants eval-owned;
 * production configuration and composition must not import this module.
 */
export const FRONTIER_FLASH_TESTING_PROFILE: Readonly<FrontierFlashTestingProfile> = Object.freeze({
  provider_id: FRONTIER_FLASH_PROVIDER_ID,
  adapter_id: FRONTIER_FLASH_ADAPTER_ID,
  model_id: FRONTIER_FLASH_MODEL_ID,
  canonical_slug: FRONTIER_FLASH_CANONICAL_SLUG,
  testing_only: true,
  production_eligible: false,
  fallback: null,
});

export interface FrontierFlashObservedMetadata {
  readonly created: number;
  readonly context_length: number;
  readonly top_provider_max_completion_tokens: number;
  readonly tool_calling: true;
  readonly input_modality: "text";
  readonly output_modality: "text";
  readonly reasoning_default_effort?: "high" | "xhigh";
  readonly price_input_usd_per_token?: number;
  readonly price_output_usd_per_token?: number;
}

export interface FrontierFlashCatalogAttestation {
  readonly checked_at: string;
  readonly source_url: string;
  readonly id: string;
  readonly canonical_slug: string;
  readonly observed_metadata: FrontierFlashObservedMetadata;
}

/**
 * A locally saved, authoritative OpenRouter model document. This module never
 * fetches it: the caller is responsible for preserving the lookup time and
 * exact catalog URL alongside the document it obtained.
 */
export interface CreateFrontierFlashCatalogAttestationInput {
  readonly catalog_model: unknown;
  readonly checked_at: string;
  readonly source_url: string;
}

export type CreateFrontierFlashCatalogAttestationOutcome =
  | Readonly<{ readonly status: "ready"; readonly attestation: Readonly<FrontierFlashCatalogAttestation> }>
  | Readonly<{ readonly status: "invalid"; readonly reason: "catalog_document_malformed" | "catalog_document_tool_calling_unconfirmed" | "catalog_document_not_text_only" }>;

/**
 * All clock values are injected so this pure validator has no hidden time or
 * network dependency. `profile` is intentionally `unknown`: callers must not
 * be able to smuggle a route override past validation.
 */
export interface ResolveFrontierFlashProfileInput {
  readonly profile?: unknown;
  readonly credential?: unknown;
  readonly catalog_attestation?: unknown;
  readonly now_ms: number;
  readonly max_attestation_age_ms: number;
}

export type FrontierFlashProfileSkipReason = "profile_absent" | "credential_absent";
export type FrontierFlashProfileInvalidReason =
  | "profile_malformed"
  | "profile_not_testing_only"
  | "profile_production_eligible"
  | "profile_fallback_present"
  | "profile_route_mismatch"
  | "credential_malformed"
  | "catalog_attestation_absent"
  | "catalog_attestation_malformed"
  | "catalog_attestation_stale"
  | "catalog_attestation_future";

export type FrontierFlashProfileOutcome =
  | Readonly<{
    readonly status: "ready";
    readonly profile: Readonly<FrontierFlashTestingProfile>;
    readonly catalog_attestation: Readonly<FrontierFlashCatalogAttestation>;
    readonly credential_present: true;
    readonly production_eligible: false;
    readonly fallback: null;
  }>
  | Readonly<{
    readonly status: "skipped";
    readonly measurement: "unmeasured";
    readonly reason: FrontierFlashProfileSkipReason;
    readonly selected_profile: null;
  }>
  | Readonly<{
    readonly status: "invalid";
    readonly measurement: "unmeasured";
    readonly reason: FrontierFlashProfileInvalidReason;
    readonly selected_profile: null;
  }>;

/**
 * Convert one locally persisted OpenRouter model response into the bounded
 * attestation consumed by the live lane.  The conversion is deliberately
 * closed: it cannot select a model, substitute a price, or contact a remote
 * endpoint.  An absent tools declaration is invalid rather than guessed.
 */
export function createFrontierFlashCatalogAttestation(
  input: CreateFrontierFlashCatalogAttestationInput,
): CreateFrontierFlashCatalogAttestationOutcome {
  if (!isRecord(input.catalog_model)) return invalidCatalogDocument("catalog_document_malformed");
  const envelope = input.catalog_model;
  const document = hasOnlyKeys(envelope, ["data"]) && isRecord(envelope.data) ? envelope.data : envelope;
  const topProvider = isRecord(document.top_provider) ? document.top_provider : null;
  const pricing = isRecord(document.pricing) ? document.pricing : null;
  if (
    document.id !== FRONTIER_FLASH_MODEL_ID
    || document.canonical_slug !== FRONTIER_FLASH_CANONICAL_SLUG
    || !isPositiveSafeInteger(document.created)
    || !isPositiveSafeInteger(document.context_length)
    || topProvider === null
    || !isPositiveSafeInteger(topProvider.max_completion_tokens)
    || pricing === null
    || !isNonNegativeFiniteNumber(pricing.prompt)
  ) return invalidCatalogDocument("catalog_document_malformed");

  const parameters = Array.isArray(document.supported_parameters) ? document.supported_parameters : null;
  if (parameters === null || !parameters.every((value) => typeof value === "string") || !parameters.includes("tools")) {
    return invalidCatalogDocument("catalog_document_tool_calling_unconfirmed");
  }
  const architecture = isRecord(document.architecture) ? document.architecture : null;
  const inputModality = textModality(architecture?.input_modalities);
  const outputModality = textModality(architecture?.output_modalities);
  if (inputModality === null || outputModality === null) return invalidCatalogDocument("catalog_document_not_text_only");
  const candidate: FrontierFlashCatalogAttestation = {
    checked_at: input.checked_at,
    source_url: input.source_url,
    id: document.id,
    canonical_slug: document.canonical_slug,
    observed_metadata: {
      created: document.created,
      context_length: document.context_length,
      top_provider_max_completion_tokens: topProvider.max_completion_tokens,
      tool_calling: true,
      input_modality: inputModality,
      output_modality: outputModality,
      price_input_usd_per_token: Number(pricing.prompt),
      ...(isNonNegativeFiniteNumber(pricing.completion) ? { price_output_usd_per_token: Number(pricing.completion) } : {}),
    },
  };
  const validation = validateAttestation(candidate, Date.parse(input.checked_at), MAX_FRONTIER_FLASH_ATTESTATION_AGE_MS);
  return validation.status === "ready"
    ? Object.freeze({ status: "ready" as const, attestation: validation.value })
    : invalidCatalogDocument("catalog_document_malformed");
}

/**
 * Resolves a closed testing-only profile without ever selecting an alternate
 * provider, adapter, or model. A skip/invalid result is terminal for this
 * resolver: callers must report it as unmeasured, never reinterpret it as a
 * successful provider result.
 */
export function resolveFrontierFlashTestingProfile(input: ResolveFrontierFlashProfileInput): FrontierFlashProfileOutcome {
  const profileStatus = validateProfile(input.profile);
  if (profileStatus === "profile_absent") return skipped(profileStatus);
  if (profileStatus !== null) return invalid(profileStatus);

  if (input.credential === undefined || input.credential === null || input.credential === "") {
    return skipped("credential_absent");
  }
  if (typeof input.credential !== "string" || input.credential.trim().length === 0) {
    return invalid("credential_malformed");
  }

  if (input.catalog_attestation === undefined || input.catalog_attestation === null) {
    return invalid("catalog_attestation_absent");
  }
  const attestation = validateAttestation(input.catalog_attestation, input.now_ms, input.max_attestation_age_ms);
  if (attestation.status !== "ready") return invalid(attestation.reason);

  return Object.freeze({
    status: "ready" as const,
    profile: FRONTIER_FLASH_TESTING_PROFILE,
    catalog_attestation: attestation.value,
    credential_present: true as const,
    production_eligible: false as const,
    fallback: null,
  });
}

function validateProfile(profile: unknown): "profile_absent" | FrontierFlashProfileInvalidReason | null {
  if (profile === undefined) return "profile_absent";
  if (!isRecord(profile) || !hasOnlyKeys(profile, [
    "provider_id", "adapter_id", "model_id", "canonical_slug", "testing_only", "production_eligible", "fallback",
  ])) return "profile_malformed";
  if (profile.testing_only !== true) return "profile_not_testing_only";
  if (profile.production_eligible !== false) return "profile_production_eligible";
  if (profile.fallback !== null) return "profile_fallback_present";
  if (
    profile.provider_id !== FRONTIER_FLASH_PROVIDER_ID ||
    profile.adapter_id !== FRONTIER_FLASH_ADAPTER_ID ||
    profile.model_id !== FRONTIER_FLASH_MODEL_ID || profile.canonical_slug !== FRONTIER_FLASH_CANONICAL_SLUG
  ) return "profile_route_mismatch";
  return null;
}

function validateAttestation(
  candidate: unknown,
  nowMs: number,
  maxAgeMs: number,
): { readonly status: "ready"; readonly value: Readonly<FrontierFlashCatalogAttestation> } | { readonly status: "invalid"; readonly reason: FrontierFlashProfileInvalidReason } {
  if (!isValidClockInput(nowMs, maxAgeMs)) return { status: "invalid", reason: "catalog_attestation_malformed" };
  if (!isRecord(candidate) || !hasOnlyKeys(candidate, ["checked_at", "source_url", "id", "canonical_slug", "observed_metadata"])) {
    return { status: "invalid", reason: "catalog_attestation_malformed" };
  }
  if (
    candidate.id !== FRONTIER_FLASH_MODEL_ID ||
    candidate.canonical_slug !== FRONTIER_FLASH_CANONICAL_SLUG ||
    !isAllowedCatalogUrl(candidate.source_url) ||
    !isCanonicalIsoTimestamp(candidate.checked_at) ||
    !isObservedMetadata(candidate.observed_metadata)
  ) return { status: "invalid", reason: "catalog_attestation_malformed" };

  const checkedAtMs = Date.parse(candidate.checked_at);
  if (checkedAtMs > nowMs) return { status: "invalid", reason: "catalog_attestation_future" };
  if (nowMs - checkedAtMs > maxAgeMs) return { status: "invalid", reason: "catalog_attestation_stale" };

  return {
    status: "ready",
    value: Object.freeze({
      checked_at: candidate.checked_at,
      source_url: candidate.source_url,
      id: candidate.id,
      canonical_slug: candidate.canonical_slug,
      observed_metadata: Object.freeze({ ...candidate.observed_metadata }),
    }),
  };
}

function isValidClockInput(nowMs: number, maxAgeMs: number): boolean {
  return Number.isSafeInteger(nowMs) && nowMs >= 0
    && Number.isSafeInteger(maxAgeMs) && maxAgeMs > 0 && maxAgeMs <= MAX_FRONTIER_FLASH_ATTESTATION_AGE_MS;
}

function isAllowedCatalogUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "openrouter.ai"
      && url.port === ""
      && url.username === ""
      && url.password === ""
      && url.search === ""
      && url.hash === ""
      && (url.pathname === "/api/v1/model/deepseek/deepseek-v4-flash-0731" || url.pathname === "/deepseek/deepseek-v4-flash-0731/api");
  } catch {
    return false;
  }
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function isObservedMetadata(value: unknown): value is FrontierFlashObservedMetadata {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length < 4 || entries.length > MAX_OBSERVED_METADATA_ENTRIES) return false;
  const allowedKeys = new Set([
    "created", "context_length", "top_provider_max_completion_tokens", "tool_calling",
    "input_modality", "output_modality", "reasoning_default_effort", "price_input_usd_per_token", "price_output_usd_per_token",
  ]);
  if (entries.some(([key]) => !allowedKeys.has(key))) return false;
  if (!isPositiveSafeInteger(value.created) || !isPositiveSafeInteger(value.context_length)
    || !isPositiveSafeInteger(value.top_provider_max_completion_tokens) || value.tool_calling !== true) return false;
  if (value.input_modality !== "text" || value.output_modality !== "text") return false;
  if (value.reasoning_default_effort !== undefined && value.reasoning_default_effort !== "high" && value.reasoning_default_effort !== "xhigh") return false;
  if (value.price_input_usd_per_token !== undefined && (
    typeof value.price_input_usd_per_token !== "number"
    || !Number.isFinite(value.price_input_usd_per_token)
    || value.price_input_usd_per_token < 0
  )) return false;
  if (value.price_output_usd_per_token !== undefined && (
    typeof value.price_output_usd_per_token !== "number"
    || !Number.isFinite(value.price_output_usd_per_token)
    || value.price_output_usd_per_token < 0
  )) return false;
  return entries.every(([, item]) => typeof item !== "string" || (item.length > 0 && item.length <= MAX_OBSERVED_METADATA_STRING_LENGTH));
}

function isNonNegativeFiniteNumber(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0;
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(value)) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0;
}

function textModality(value: unknown): "text" | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") && value.includes("text") ? "text" : null;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasOnlyKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function skipped(reason: FrontierFlashProfileSkipReason): FrontierFlashProfileOutcome {
  return Object.freeze({ status: "skipped" as const, measurement: "unmeasured" as const, reason, selected_profile: null });
}

function invalid(reason: FrontierFlashProfileInvalidReason): FrontierFlashProfileOutcome {
  return Object.freeze({ status: "invalid" as const, measurement: "unmeasured" as const, reason, selected_profile: null });
}

function invalidCatalogDocument(reason: "catalog_document_malformed" | "catalog_document_tool_calling_unconfirmed" | "catalog_document_not_text_only"): CreateFrontierFlashCatalogAttestationOutcome {
  return Object.freeze({ status: "invalid" as const, reason });
}
