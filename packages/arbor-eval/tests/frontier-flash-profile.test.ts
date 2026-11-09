/**
 * Source exposure: independently authored from the user/provider constraint
 * and recorded public OpenRouter catalog metadata. These tests perform no
 * network/provider call and never reuse an external implementation or test.
 */
import { describe, expect, it } from "vitest";
import {
  FRONTIER_FLASH_TESTING_PROFILE,
  createFrontierFlashCatalogAttestation,
  resolveFrontierFlashTestingProfile,
  type FrontierFlashCatalogAttestation,
} from "../src/frontier-flash-profile.js";

const NOW_MS = Date.parse("2026-08-30T12:00:00.000Z");
const MAX_AGE_MS = 5 * 60 * 1000;
const MAX_ATTESTATION_AGE_MS = 15 * 60 * 1000;

function attestation(overrides: Partial<FrontierFlashCatalogAttestation> = {}): FrontierFlashCatalogAttestation {
  return {
    checked_at: "2026-08-30T11:57:00.000Z",
      source_url: "https://openrouter.ai/api/v1/model/deepseek/deepseek-v4-flash-0731",
      id: FRONTIER_FLASH_TESTING_PROFILE.model_id,
      canonical_slug: FRONTIER_FLASH_TESTING_PROFILE.canonical_slug,
    observed_metadata: {
      created: 1785478908,
      context_length: 1_048_576,
      top_provider_max_completion_tokens: 384_000,
      tool_calling: true,
      input_modality: "text",
      output_modality: "text",
      reasoning_default_effort: "high",
      price_input_usd_per_token: 0.00000007868,
      price_output_usd_per_token: 0.00000026,
    },
    ...overrides,
  };
}

function resolve(overrides: Partial<Parameters<typeof resolveFrontierFlashTestingProfile>[0]> = {}) {
  return resolveFrontierFlashTestingProfile({
    profile: FRONTIER_FLASH_TESTING_PROFILE,
    credential: "test-only-secret",
    catalog_attestation: attestation(),
    now_ms: NOW_MS,
    max_attestation_age_ms: MAX_AGE_MS,
    ...overrides,
  });
}

function catalogDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "deepseek/deepseek-v4-flash-0731",
    canonical_slug: "deepseek/deepseek-v4-flash-20260731",
    created: 1785478908,
    context_length: 1_048_576,
    top_provider: { max_completion_tokens: 384_000 },
    pricing: { prompt: "0.000000089866", completion: "0.000000179732" },
    supported_parameters: ["tools"],
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    ...overrides,
  };
}

describe("resolveFrontierFlashTestingProfile", () => {
  it("returns the single closed, testing-only Flash profile when the catalog attestation is fresh", () => {
    expect(resolve()).toEqual(expect.objectContaining({
      status: "ready",
      credential_present: true,
      production_eligible: false,
      fallback: null,
      profile: FRONTIER_FLASH_TESTING_PROFILE,
      catalog_attestation: expect.objectContaining({
        id: "deepseek/deepseek-v4-flash-0731",
        canonical_slug: "deepseek/deepseek-v4-flash-20260731",
      }),
    }));
  });

  it("returns explicit unmeasured skips for absent profile or credential and never selects a route", () => {
    expect(resolve({ profile: undefined })).toEqual({ status: "skipped", measurement: "unmeasured", reason: "profile_absent", selected_profile: null });
    expect(resolve({ credential: undefined })).toEqual({ status: "skipped", measurement: "unmeasured", reason: "credential_absent", selected_profile: null });
    expect(resolve({ credential: "" })).toEqual({ status: "skipped", measurement: "unmeasured", reason: "credential_absent", selected_profile: null });
  });

  it("rejects production eligibility, fallback, Pro, generic, and another provider instead of rerouting", () => {
    expect(resolve({ profile: { ...FRONTIER_FLASH_TESTING_PROFILE, production_eligible: true } })).toMatchObject({ status: "invalid", reason: "profile_production_eligible", selected_profile: null });
    expect(resolve({ profile: { ...FRONTIER_FLASH_TESTING_PROFILE, fallback: "deepseek/deepseek-v4-pro" } })).toMatchObject({ status: "invalid", reason: "profile_fallback_present", selected_profile: null });
    expect(resolve({ profile: { ...FRONTIER_FLASH_TESTING_PROFILE, model_id: "deepseek/deepseek-v4-pro" } })).toMatchObject({ status: "invalid", reason: "profile_route_mismatch", selected_profile: null });
    expect(resolve({ profile: { ...FRONTIER_FLASH_TESTING_PROFILE, model_id: "deepseek/deepseek-v4" } })).toMatchObject({ status: "invalid", reason: "profile_route_mismatch", selected_profile: null });
    expect(resolve({ profile: { ...FRONTIER_FLASH_TESTING_PROFILE, provider_id: "another-provider" } })).toMatchObject({ status: "invalid", reason: "profile_route_mismatch", selected_profile: null });
    expect(resolve({ profile: { ...FRONTIER_FLASH_TESTING_PROFILE, model_id: "deepseek/deepseek-v4-flash-vision-exp" } })).toMatchObject({ status: "invalid", reason: "profile_route_mismatch", selected_profile: null });
  });

  it("rejects an absent, stale, future, malformed, or mismatched catalog attestation", () => {
    expect(resolve({ catalog_attestation: undefined })).toMatchObject({ status: "invalid", reason: "catalog_attestation_absent" });
    expect(resolve({ catalog_attestation: attestation({ checked_at: "2026-08-30T11:54:59.999Z" }) })).toMatchObject({ status: "invalid", reason: "catalog_attestation_stale" });
    expect(resolve({ catalog_attestation: attestation({ checked_at: "2026-08-30T12:00:00.001Z" }) })).toMatchObject({ status: "invalid", reason: "catalog_attestation_future" });
    expect(resolve({ catalog_attestation: attestation({ checked_at: "not-a-time" }) })).toMatchObject({ status: "invalid", reason: "catalog_attestation_malformed" });
    expect(resolve({ catalog_attestation: attestation({ id: "deepseek/deepseek-v4-pro" }) })).toMatchObject({ status: "invalid", reason: "catalog_attestation_malformed" });
    expect(resolve({ catalog_attestation: attestation({ canonical_slug: "deepseek/deepseek-v4-pro-20260423" }) })).toMatchObject({ status: "invalid", reason: "catalog_attestation_malformed" });
  });

  it("requires an HTTPS exact-host OpenRouter source URL and bounded non-secret metadata", () => {
    expect(resolve({ catalog_attestation: attestation({ source_url: "http://openrouter.ai/api/v1/model/deepseek/deepseek-v4-flash" }) })).toMatchObject({ status: "invalid", reason: "catalog_attestation_malformed" });
    expect(resolve({ catalog_attestation: attestation({ source_url: "https://openrouter.ai.evil.example/api/v1/model/deepseek/deepseek-v4-flash" }) })).toMatchObject({ status: "invalid", reason: "catalog_attestation_malformed" });
    expect(resolve({ catalog_attestation: attestation({ source_url: "https://openrouter.ai/api/v1/model/deepseek/deepseek-v4-flash?token=not-allowed" }) })).toMatchObject({ status: "invalid", reason: "catalog_attestation_malformed" });
    expect(resolve({ catalog_attestation: attestation({ observed_metadata: { created: 1, context_length: 2, top_provider_max_completion_tokens: 3, tool_calling: true, api_key: "must-not-record" } as unknown as FrontierFlashCatalogAttestation["observed_metadata"] }) })).toMatchObject({ status: "invalid", reason: "catalog_attestation_malformed" });
  });

  it("rejects malformed clock bounds rather than treating an attestation as indefinitely fresh", () => {
    expect(resolve({ max_attestation_age_ms: MAX_ATTESTATION_AGE_MS + 1 })).toMatchObject({ status: "invalid", reason: "catalog_attestation_malformed" });
    expect(resolve({ now_ms: Number.NaN })).toMatchObject({ status: "invalid", reason: "catalog_attestation_malformed" });
  });
});

describe("createFrontierFlashCatalogAttestation", () => {
  it("derives the closed attestation from a locally captured current Flash catalog document", () => {
    const result = createFrontierFlashCatalogAttestation({
      catalog_model: catalogDocument(),
      checked_at: "2026-08-30T12:00:00.000Z",
      source_url: "https://openrouter.ai/api/v1/model/deepseek/deepseek-v4-flash-0731",
    });
    expect(result).toMatchObject({
      status: "ready",
      attestation: {
        id: "deepseek/deepseek-v4-flash-0731",
        canonical_slug: "deepseek/deepseek-v4-flash-20260731",
        observed_metadata: {
          context_length: 1_048_576,
          top_provider_max_completion_tokens: 384_000,
          tool_calling: true,
          price_input_usd_per_token: 0.000000089866,
          input_modality: "text",
          output_modality: "text",
        },
      },
    });
  });

  it("accepts the authoritative single-model endpoint's exact data envelope", () => {
    const outcome = createFrontierFlashCatalogAttestation({
      catalog_model: { data: catalogDocument() },
      checked_at: "2026-08-30T12:00:00.000Z",
      source_url: "https://openrouter.ai/api/v1/model/deepseek/deepseek-v4-flash-0731",
    });
    expect(outcome).toMatchObject({
      status: "ready",
      attestation: { id: "deepseek/deepseek-v4-flash-0731", observed_metadata: { tool_calling: true } },
    });
  });

  it("refuses Pro/malformed documents and an unconfirmed tool capability instead of guessing a route", () => {
    const input = { checked_at: "2026-08-30T12:00:00.000Z", source_url: "https://openrouter.ai/api/v1/model/deepseek/deepseek-v4-flash-0731" };
    expect(createFrontierFlashCatalogAttestation({ ...input, catalog_model: catalogDocument({ id: "deepseek/deepseek-v4-pro" }) })).toEqual({ status: "invalid", reason: "catalog_document_malformed" });
    expect(createFrontierFlashCatalogAttestation({ ...input, catalog_model: catalogDocument({ id: "deepseek/deepseek-v4-flash-vision-exp" }) })).toEqual({ status: "invalid", reason: "catalog_document_malformed" });
    expect(createFrontierFlashCatalogAttestation({ ...input, catalog_model: catalogDocument({ supported_parameters: [] }) })).toEqual({ status: "invalid", reason: "catalog_document_tool_calling_unconfirmed" });
  });
});
