/**
 * Secret-free readiness projection for the owned native harness.
 *
 * This is deliberately a configuration doctor, not a provider probe.  It
 * reports what this process can compose from declared config, shipped adapter
 * registry, and credential-presence metadata.  It never reads a credential
 * value, contacts a configured endpoint, or upgrades a fallback into health.
 */
import {
  nativeProviderCredentialEnvCandidates,
  resolveNativeProviderSelection,
  type ArborConfig,
  type NativeCredentialMechanism,
  type NativeProviderSelection,
} from "@arbor/config";
import type { NativeModelAdapterRegistry } from "@arbor/harness";
import type { ConfigSourceKind, EffectiveConfigView } from "./config-inspection.js";

/**
 * Non-secret credential facts the readiness doctor projects. A superset of
 * `NativeHarnessCredentialFacts` (`@arbor/config`) with its non-required
 * fields left optional so existing api_key-only call sites keep compiling
 * unchanged; the doctor call site (`createDoctorReadiness` in cli.ts) always
 * supplies the full shape via `resolveNativeCredentialOverlay`.
 */
export interface NativeHarnessCredentialInput {
  readonly present: boolean;
  readonly source: "env" | "absent" | "claude_oauth" | "codex_oauth" | "openrouter_oauth" | "openai_wif";
  readonly env_var?: string | null;
  readonly file_path?: string | null;
  readonly mechanism?: NativeCredentialMechanism;
  readonly state?: "present" | "absent" | "expired" | "unusable";
}

/** A credential source that is permanently unusable for inference, independent of the raw credential's own presence/expiry (e.g. codex_oauth). */
export interface NativeHarnessCredentialBoundary {
  readonly reason: string;
}

export type NativeHarnessExecutionReadiness =
  | { readonly kind: "direct_native"; readonly selected_by: "native" | "auto" }
  | { readonly kind: "connector_fallback"; readonly reason: "forced_by_config" | "selection_incomplete" | "credential_absent" }
  | { readonly kind: "unavailable"; readonly reason: "native_selection_incomplete" | "native_adapter_unsupported" | "credential_absent" | "credential_expired" | "credential_source_unusable" | "credential_mechanism_unsupported_by_adapter" | "provider_native_route_required"; readonly adapter_id: string | null };

/** These provider selections must never turn into subordinate harness dispatch. */
export function requiresDirectNativeProvider(config: ArborConfig["native"]): boolean {
  return config.adapter_id === "ollama-native" || ["ollama", "openrouter"].includes(config.provider_id.trim().toLowerCase());
}

function credentialFreeLocalOllama(config: ArborConfig["native"]): boolean {
  if (config.adapter_id !== "ollama-native") return false;
  try {
    const url = new URL(config.base_url);
    return ["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      && !url.username && !url.password;
  } catch { return false; }
}

function validDirectProviderRoute(config: ArborConfig["native"]): boolean {
  const provider = config.provider_id.trim().toLowerCase();
  if (provider === "ollama") return config.adapter_id === "ollama-native";
  if (provider !== "openrouter") return true;
  try {
    const url = new URL(config.base_url);
    return config.adapter_id === "openai-compatible" && url.protocol === "https:" && url.hostname === "openrouter.ai"
      && !url.username && !url.password;
  } catch { return false; }
}

export interface NativeHarnessReadinessProjection {
  readonly execution: NativeHarnessExecutionReadiness;
  readonly config_sources: Readonly<{ defaults_present: boolean; file_present: boolean; env_present: boolean; injected_present: boolean; native: Readonly<Record<string, ConfigSourceKind | null>> }>;
  readonly selection: Readonly<{
    mode: ArborConfig["native"]["mode"] | null;
    auth_route: ArborConfig["native"]["auth_route"] | null;
    adapter_id: string | null;
    provider_id: string | null;
    model_id: string | null;
    endpoint_configured: boolean;
  }>;
  readonly adapter: Readonly<{ adapter_id: string | null; availability: "available" | "unavailable" | "not_applicable"; implementation_id: string | null; transport: string | null }>;
  readonly credential: Readonly<{
    required: boolean; present: boolean; source: "env" | "absent" | "claude_oauth" | "codex_oauth" | "openrouter_oauth" | "openai_wif";
    authentication_owner: "canopy_credential_source" | "claude_code_cli" | "openai_codex_cli";
    env_var: string | null; file_path: string | null; mechanism: NativeCredentialMechanism;
    state: "present" | "absent" | "expired" | "unusable";
  }>;
  readonly model_revision: Readonly<{ configured: string | null; readiness: "not_applicable" | "unpinned" | "configured_unobserved" }>;
  readonly pricing: Readonly<{ readiness: "not_configured" | "configured"; price_source_id: string | null; matches_selected_model: boolean | null }>;
  readonly budget: Readonly<{ readiness: "not_configured" | "configured"; cache_estimate: "not_configured" | "conservative_utf8_upper_bound"; session_limits_configured: boolean; campaign_limits_configured: boolean }>;
  /** Concrete, non-secret corrections. Empty only when direct native is composable. */
  readonly missing_requirements: readonly Readonly<{ code: string; action: string }>[];
}

/** The runtime runner consumes this exact decision; it is stricter than config-only selection. */
export function resolveNativeHarnessExecutionReadiness(
  config: ArborConfig["native"],
  credential: Pick<NativeHarnessCredentialInput, "present" | "mechanism" | "state">,
  adapters: Pick<NativeModelAdapterRegistry, "inspect">,
  boundary?: NativeHarnessCredentialBoundary,
): NativeHarnessExecutionReadiness {
  const selected = resolveNativeProviderSelection(config);
  const claudeCodeRoute = config.auth_route === "claude_code_cli";
  const openAiCodexRoute = config.auth_route === "openai_codex_cli";
  const cliAuthRoute = claudeCodeRoute || openAiCodexRoute;
  const directRequired = requiresDirectNativeProvider(config) || cliAuthRoute;
  if (claudeCodeRoute && (config.mode !== "native" || config.provider_id.trim().toLowerCase() !== "anthropic" || config.adapter_id !== "anthropic-messages")) {
    return Object.freeze({ kind: "unavailable", reason: "provider_native_route_required", adapter_id: config.adapter_id });
  }
  if (openAiCodexRoute && (config.mode !== "native" || config.provider_id.trim().toLowerCase() !== "openai" || config.adapter_id !== "openai-compatible")) {
    return Object.freeze({ kind: "unavailable", reason: "provider_native_route_required", adapter_id: config.adapter_id });
  }
  if (directRequired && (selected.kind === "fallback" || !validDirectProviderRoute(config))) {
    return Object.freeze({ kind: "unavailable", reason: "provider_native_route_required", adapter_id: config.adapter_id });
  }
  if (selected.kind === "fallback") return Object.freeze({ kind: "connector_fallback", reason: selected.reason });
  if (selected.kind === "unavailable") return Object.freeze({ kind: "unavailable", reason: selected.reason, adapter_id: selected.adapter_id ?? null });
  if (adapters.inspect(selected.adapter_id) === null) {
    return Object.freeze({ kind: "unavailable", reason: "native_adapter_unsupported", adapter_id: selected.adapter_id });
  }
  // This opt-in route delegates authentication to the operator's Claude Code
  // process. Its OAuth token is neither read nor injected into Arbor's HTTP
  // adapter; the local bridge still returns model proposals to the native
  // worker, which retains all tool and governance authority.
  if (claudeCodeRoute) return Object.freeze({ kind: "direct_native", selected_by: selected.selected_by });
  if (openAiCodexRoute && !credential.present) {
    return Object.freeze({ kind: "unavailable", reason: credential.state === "expired" ? "credential_expired" : "credential_absent", adapter_id: selected.adapter_id });
  }
  if (openAiCodexRoute) return Object.freeze({ kind: "direct_native", selected_by: selected.selected_by });
  // A selected credential source is an invariant even while the provider
  // selection is incomplete: never let a bearer drift to a connector or
  // another endpoint.
  if (boundary !== undefined) {
    return Object.freeze({ kind: "unavailable", reason: "credential_source_unusable", adapter_id: selected.adapter_id });
  }
  if (config.credential_source === "openai_wif" && !isOpenAIWifRoute(config)) {
    return Object.freeze({ kind: "unavailable", reason: "credential_source_unusable", adapter_id: selected.adapter_id });
  }
  // This source is only authorized for public OpenAI inference. Other OAuth
  // credentials require their own distinct endpoint-specific source.
  if ((credential.mechanism ?? "api_key") === "oauth_bearer" && (config.credential_source !== "openai_wif" || selected.adapter_id !== "openai-compatible")) {
    return Object.freeze({ kind: "unavailable", reason: "credential_mechanism_unsupported_by_adapter", adapter_id: selected.adapter_id });
  }
  if (!credential.present && !credentialFreeLocalOllama(config)) {
    if (credential.state === "expired") return Object.freeze({ kind: "unavailable", reason: "credential_expired", adapter_id: selected.adapter_id });
    if (config.credential_source === "openai_wif") return Object.freeze({ kind: "unavailable", reason: "credential_absent", adapter_id: selected.adapter_id });
    return config.mode === "auto" && !directRequired
      ? Object.freeze({ kind: "connector_fallback", reason: "credential_absent" })
      : Object.freeze({ kind: "unavailable", reason: "credential_absent", adapter_id: selected.adapter_id });
  }
  return Object.freeze({ kind: "direct_native", selected_by: selected.selected_by });
}

function isOpenAIWifRoute(config: ArborConfig["native"]): boolean {
  if (config.provider_id.trim().toLowerCase() !== "openai" || config.adapter_id !== "openai-compatible") return false;
  try {
    const url = new URL(config.base_url);
    return url.protocol === "https:" && url.hostname === "api.openai.com" && url.port === "" && !url.username && !url.password && !url.search && !url.hash && url.pathname.replace(/\/$/, "") === "/v1";
  } catch { return false; }
}

function sourceFor(view: EffectiveConfigView, path: string): ConfigSourceKind | null {
  const direct = view.leaves.find((leaf) => leaf.path === path)?.source;
  if (direct !== undefined) return direct;
  // Object-valued config sections (pricing/usage_budget) are represented as
  // leaves. Report their source only when every declared child agrees.
  const nested = [...new Set(view.leaves.filter((leaf) => leaf.path.startsWith(`${path}.`)).map((leaf) => leaf.source))];
  return nested.length === 1 ? nested[0]! : null;
}

function selectedNative(config: ArborConfig["native"]): Extract<NativeProviderSelection, { readonly kind: "native" }> | null {
  const selection = resolveNativeProviderSelection(config);
  return selection.kind === "native" ? selection : null;
}

export function buildNativeHarnessReadiness(input: {
  readonly config: ArborConfig;
  readonly config_view: EffectiveConfigView;
  readonly credential: NativeHarnessCredentialInput;
  readonly adapters: Pick<NativeModelAdapterRegistry, "inspect">;
  readonly credential_boundary?: NativeHarnessCredentialBoundary;
}): NativeHarnessReadinessProjection {
  const native = selectedNative(input.config.native);
  const configSelection = resolveNativeProviderSelection(input.config.native);
  const execution = resolveNativeHarnessExecutionReadiness(input.config.native, input.credential, input.adapters, input.credential_boundary);
  const descriptor = native === null ? null : input.adapters.inspect(native.adapter_id);
  const pricing = input.config.native.pricing;
  const budget = input.config.native.usage_budget;
  const nativeSources = Object.freeze(Object.fromEntries([
    "mode", "adapter_id", "provider_id", "base_url", "model", "revision", "auth_route", "pricing", "usage_budget",
  ].map((field) => [field, sourceFor(input.config_view, `native.${field}`)])) as Record<string, ConfigSourceKind | null>);
  const missing: Array<{ code: string; action: string }> = [];
  if (execution.kind === "unavailable" && execution.reason === "provider_native_route_required") {
    missing.push({ code: "provider_native_route_required", action: input.config.native.auth_route === "claude_code_cli"
      ? "The Claude Code CLI auth route requires native.mode=\"native\", provider_id=\"anthropic\", and adapter_id=\"anthropic-messages\"; connector fallback is forbidden."
      : input.config.native.auth_route === "openai_codex_cli"
        ? "The Codex CLI auth route requires native.mode=\"native\", provider_id=\"openai\", and adapter_id=\"openai-compatible\"; connector fallback is forbidden."
      : "Ollama requires ollama-native; OpenRouter requires openai-compatible at https://openrouter.ai/api/v1. Configure a complete native selection; connector/Claude bridge fallback is not allowed for these providers." });
  }
  if (execution.kind === "connector_fallback" && execution.reason === "forced_by_config") {
    missing.push({ code: "native_mode_fallback", action: "Set native.mode to auto or native to enable direct-native selection." });
  }
  if (execution.kind === "connector_fallback" && execution.reason === "selection_incomplete") {
    for (const field of ["provider_id", "base_url", "model"] as const) {
      if (!input.config.native[field].trim()) missing.push({ code: `native_${field}_missing`, action: `Set native.${field} in arbor.jsonc or its documented config overlay.` });
    }
  }
  if (execution.kind === "unavailable" && execution.reason === "native_selection_incomplete") {
    for (const field of ["provider_id", "base_url", "model"] as const) {
      if (!input.config.native[field].trim()) missing.push({ code: `native_${field}_missing`, action: `Set native.${field}; explicit native mode fails closed until all three are configured.` });
    }
  }
  if (execution.kind === "unavailable" && execution.reason === "native_adapter_unsupported") {
    missing.push({ code: "native_adapter_unavailable", action: "Choose a shipped native.adapter_id or install and compose a reviewed adapter before selecting it." });
  }
  if ((execution.kind === "connector_fallback" && execution.reason === "credential_absent") || (execution.kind === "unavailable" && execution.reason === "credential_absent")) {
    const candidates = nativeProviderCredentialEnvCandidates(input.config.native.provider_id);
    missing.push({ code: "native_credential_absent", action: input.config.native.credential_source === "openrouter_oauth"
      ? "Run `arbor native-auth openrouter login` to authorize with OpenRouter and store its issued API key in the user-private Canopy credential file."
      : input.config.native.auth_route === "openai_codex_cli"
        ? "Sign in with the first-party Codex CLI (`codex login`); Canopy uses that CLI only as an inference transport and never sends its subscriber token to the public OpenAI API."
      : input.credential.source === "openai_wif"
      ? "Set OPENAI_WIF_ACCESS_TOKEN and OPENAI_WIF_EXPIRES_AT (Unix seconds) to an already exchanged, unexpired OpenAI API workload identity token; Canopy does not exchange or refresh it."
      : `Set ${candidates.join(" or ")} in .env or the process environment; the doctor records only the selected variable name and presence.` });
  }
  if (execution.kind === "unavailable" && execution.reason === "credential_expired") {
    missing.push({ code: "native_credential_expired", action: input.config.native.auth_route === "openai_codex_cli"
      ? "The Codex CLI login has expired; re-authenticate with `codex login`."
      : input.credential.source === "openai_wif"
      ? "The OpenAI WIF access token expired. Obtain a fresh, already exchanged API access token and update OPENAI_WIF_ACCESS_TOKEN and OPENAI_WIF_EXPIRES_AT (Unix seconds). Canopy does not exchange or refresh it."
      : "The selected provider credential has expired; renew it through its owning provider or CLI login, then rerun `arbor doctor`." });
  }
  if (execution.kind === "unavailable" && execution.reason === "credential_source_unusable" && input.credential_boundary !== undefined) {
    missing.push({ code: "native_credential_source_unusable", action: input.credential_boundary.reason });
  }
  if (execution.kind === "unavailable" && execution.reason === "credential_mechanism_unsupported_by_adapter") {
    missing.push({ code: "native_credential_mechanism_unsupported", action: `native.adapter_id "${input.config.native.adapter_id}" does not support the oauth_bearer credential mechanism; switch native.credential_source to api_key.` });
  }
  return Object.freeze({
    execution,
    config_sources: Object.freeze({ ...input.config_view.sources, native: nativeSources }),
    selection: Object.freeze({
      mode: input.config.native.mode,
      auth_route: input.config.native.auth_route,
      adapter_id: native?.adapter_id ?? (configSelection.kind === "unavailable" ? configSelection.adapter_id ?? null : null),
      provider_id: native?.provider_id ?? null,
      model_id: native?.model ?? null,
      endpoint_configured: native !== null,
    }),
    adapter: Object.freeze({
      adapter_id: native?.adapter_id ?? null,
      availability: native === null ? "not_applicable" : descriptor === null ? "unavailable" : "available",
      implementation_id: input.config.native.auth_route === "claude_code_cli" ? "revoy2-claude-code-native-route" : input.config.native.auth_route === "openai_codex_cli" ? "revoy2-openai-codex-native-route" : descriptor?.implementation_id ?? null,
      transport: input.config.native.auth_route === "claude_code_cli" ? "Claude Code CLI via stateless owned bridge" : input.config.native.auth_route === "openai_codex_cli" ? "Codex CLI via stateless native route" : descriptor?.transport ?? null,
    }),
    credential: Object.freeze({
      required: native !== null && !credentialFreeLocalOllama(input.config.native) && input.config.native.auth_route !== "claude_code_cli" && input.config.native.auth_route !== "openai_codex_cli", present: input.credential.present, source: input.credential.source,
      authentication_owner: input.config.native.auth_route === "claude_code_cli" ? "claude_code_cli" : input.config.native.auth_route === "openai_codex_cli" ? "openai_codex_cli" : "canopy_credential_source",
      env_var: input.credential.env_var ?? null, file_path: input.credential.file_path ?? null,
      mechanism: input.credential.mechanism ?? "api_key",
      state: input.credential.state ?? (input.credential.present ? "present" : "absent"),
    }),
    model_revision: Object.freeze({
      configured: native?.revision ?? null,
      readiness: native === null ? "not_applicable" : native.revision === null ? "unpinned" : "configured_unobserved",
    }),
    pricing: Object.freeze({
      readiness: pricing === undefined ? "not_configured" : "configured",
      price_source_id: pricing?.price_source_id ?? null,
      matches_selected_model: pricing === undefined || native === null ? null : pricing.provider_id === native.provider_id && pricing.model_id === native.model,
    }),
    budget: Object.freeze({
      readiness: budget === undefined ? "not_configured" : "configured",
      cache_estimate: budget === undefined ? "not_configured" : "conservative_utf8_upper_bound",
      session_limits_configured: budget !== undefined && (budget.max_session_input_tokens !== undefined || budget.max_session_output_tokens !== undefined || budget.max_session_cache_read_tokens !== undefined || budget.max_session_cache_write_tokens !== undefined || budget.max_session_total_tokens !== undefined || budget.max_session_cost !== undefined),
      campaign_limits_configured: budget !== undefined && (budget.max_campaign_tokens !== undefined || budget.max_campaign_cost !== undefined),
    }),
    missing_requirements: Object.freeze(missing.map((item) => Object.freeze(item))),
  });
}

/** A small immutable service keeps catalog/web/TUI/CLI on one projection. */
export class NativeHarnessReadinessService {
  constructor(private readonly input: Parameters<typeof buildNativeHarnessReadiness>[0]) {}
  inspect(): NativeHarnessReadinessProjection { return buildNativeHarnessReadiness(this.input); }
}

export function formatNativeHarnessReadiness(projection: NativeHarnessReadinessProjection): string {
  const execution = projection.execution.kind === "direct_native"
    ? `direct native (${projection.execution.selected_by})`
    : `${projection.execution.kind}: ${projection.execution.reason}`;
  const missing = projection.missing_requirements.length === 0
    ? "none"
    : projection.missing_requirements.map((item) => `${item.code}: ${item.action}`).join("\n");
  return [
    `Native harness readiness: ${execution}`,
    `Config sources: defaults=${projection.config_sources.defaults_present}, file=${projection.config_sources.file_present}, env=${projection.config_sources.env_present}, injected=${projection.config_sources.injected_present}`,
    `Adapter: ${projection.adapter.adapter_id ?? "not selected"} (${projection.adapter.availability})`,
    `Authentication: ${projection.credential.authentication_owner}${projection.selection.auth_route ? ` (${projection.selection.auth_route})` : ""}`,
    `Credential: ${projection.credential.source} / ${projection.credential.mechanism} / ${projection.credential.state}${projection.credential.env_var ? ` (${projection.credential.env_var})` : ""}${projection.credential.file_path ? ` (${projection.credential.file_path})` : ""}`,
    `Model/revision: ${projection.selection.provider_id ?? "not selected"} / ${projection.selection.model_id ?? "not selected"} (${projection.model_revision.readiness})`,
    `Pricing: ${projection.pricing.readiness}; budget: ${projection.budget.readiness}`,
    `Missing requirements:\n${missing}`,
  ].join("\n");
}

/**
 * ADR-099 §2: credential absence (or any other demotion cause) gets a
 * setup path named at the point of fallback, not only when an operator
 * happens to run `doctor`. `buildNativeHarnessReadiness`'s
 * `missing_requirements` already carries the concrete `{ code, action }`
 * pairs this projects from; this turns that into the one-line, log-ready
 * sentence a campaign-start call site (composition root, outside this
 * package's readiness lane) can emit the moment it takes the connector path
 * instead of direct native. Returns `null` when execution is `direct_native`
 * -- there is nothing demoted to name.
 */
export function describeNativeConnectorFallbackDemotion(projection: NativeHarnessReadinessProjection): string | null {
  if (projection.execution.kind === "direct_native") return null;
  const actions = projection.missing_requirements.map((item) => item.action).join(" ");
  const setupPath = actions.length > 0 ? actions : "Run `arbor doctor` for the concrete setup steps.";
  // Canopy-only (amends ADR-061): an unready native lane no longer demotes
  // to a connector by default; campaigns fail closed unless the operator
  // opted into a deprecated lane with `connectors.allow_deprecated`.
  return `Canopy (native) execution is not ready (${projection.execution.kind}: ${projection.execution.reason}); campaigns fail closed — no connector runs in its place unless connectors.allow_deprecated admits one. ${setupPath}`;
}
