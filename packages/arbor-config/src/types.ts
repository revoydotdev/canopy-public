export interface ArborConfig {
  agents: Record<string, AgentConfig>;
  categories: Record<string, CategoryConfig>;
  tree_search: TreeSearchConfig;
  kb: KbBackendConfig;
  /**
   * Non-secret selection for the revoy-owned native reference executor.
   * Credentials deliberately live outside this durable/projection-safe config
   * shape; see `loadNativeProviderSecretOverlay`.
   */
  native: NativeProviderConfig;
  /** Optional, non-secret TUI presentation preferences. */
  tui?: TuiConfig;
  /**
   * Project-authored machine verification. `acceptance_commands` run, in
   * order and fail-fast, as the acceptance step for any node whose plan did
   * not declare its own `high_risk_tool_scope.command_argv`. Operator-
   * authored in the project config, so it carries authored provenance on
   * every governance tier — a governed campaign whose planner declared no
   * command used to get no machine verification at all, and the critic then
   * blocked every node for an acceptance command nobody ran.
   */
  verification?: VerificationConfig;
  /** Optional command-execution confinement policy for the sandbox broker (LR-NH-04). */
  sandbox?: SandboxConfig;
  /**
   * Harness-connector policy. Canopy (the native `revoy-native` lane) is the
   * only campaign harness before 1.0.0; every other connector lane is
   * deprecated and refused at composition unless this opts in.
   */
  connectors?: ConnectorPolicyConfig;
}

/**
 * The single post-1.0 opt-in for a deprecated (non-Canopy) harness lane:
 * the opencode, claude-code and codex connectors, and `native.mode:
 * "fallback"`. Absent or false, selecting any of them fails closed. When
 * true, `reason` is required and is recorded in the evidence of every run
 * that uses a deprecated lane, so an opt-in is never anonymous.
 */
export interface ConnectorPolicyConfig {
  allow_deprecated?: boolean;
  reason?: string;
}

/** Bound on `connectors.reason`; it is embedded in run evidence, so it is single-line and short. */
export const CONNECTOR_OPT_IN_REASON_MAX = 200;

/**
 * Closed confinement policy for `@arbor/mcp`'s sandbox broker. Mirrors
 * `SandboxConfinementLevel` in `@arbor/mcp`'s `sandbox/sandbox-broker.ts` —
 * duplicated here (the same layering `NATIVE_PROVIDER_ADAPTER_IDS` already
 * uses) because `@arbor/config` has no dependency on `@arbor/mcp`.
 */
export const SANDBOX_CONFINEMENT_LEVELS = ["off", "app_only", "os_best_effort", "os_required"] as const;
export type SandboxConfinementLevel = typeof SANDBOX_CONFINEMENT_LEVELS[number];

export interface SandboxConfig {
  /**
   * Omitted means `os_best_effort` (the recommended default): use OS
   * confinement (bubblewrap namespaces) when available, otherwise the honest
   * `application_validated` grade. Never silently collapsed to a single
   * "sandboxed" boolean — see `ConfinementGrade` in `@arbor/harness`.
   */
  confinement?: SandboxConfinementLevel;
}

/**
 * Closed selection of named TUI palettes (theme.ts's `TUI_THEME_NAMES` is the
 * actual runtime catalog; this list is duplicated here — the same layering
 * `NATIVE_PROVIDER_ADAPTER_IDS` already uses — because `@arbor/config` has no
 * dependency on `@arbor/tui`).
 */
export const TUI_THEME_NAMES = [
  "night-bloom",
  "moss-agate",
  "verdigris-forge",
  "sandstone-thicket",
  "birchwood-frost",
  "obsidian-fern",
  "copper-canopy",
  "slate-orchard",
] as const;
export type TuiThemeName = typeof TUI_THEME_NAMES[number];

export interface TuiConfig {
  /** Explicit interactive override; redirected output always remains plain. */
  color?: "auto" | "always" | "never";
  /**
   * Optional named theme override. Omitted (or absent) means the terminal
   * light/dark/color-capability fallback in `@arbor/tui`'s `theme.ts`
   * applies instead — never a secret, never a color value itself.
   */
  theme?: TuiThemeName;
}

/** Storage engine for the knowledge base. See G-11: the sole source of truth for this union. */
export type KbBackend = "jsonl" | "sqlite";

export interface KbBackendConfig {
  backend: KbBackend;
}

/** How the composition root selects revoy-native versus its connector fallback. */
export type NativeProviderMode = "auto" | "native" | "fallback";

/**
 * Closed selection of reference-harness wire adapters. Provider identities
 * remain open strings because hosted and local endpoints can share one
 * verified transport; a provider name is not an adapter declaration.
 *
 * ADR-100 grows this from two entries to five, kept in lockstep with
 * `NATIVE_MODEL_ADAPTER_IDS` in `packages/arbor-harness/src/model-adapter-registry.ts`
 * (that agreement is what `resolveNativeProviderSelection` depends on to
 * never accept a selection the registry can't compose).
 */
export const NATIVE_PROVIDER_ADAPTER_IDS = [
  "openai-compatible",
  "anthropic-messages",
  "aws-bedrock-messages",
  "gcp-vertex-messages",
  "ollama-native",
] as const;
export type NativeProviderAdapterId = typeof NATIVE_PROVIDER_ADAPTER_IDS[number];

/**
 * Which credential the composition root reads for the native lane's model
 * auth. `api_key` (the default when omitted) is today's provider API key
 * (`loadNativeProviderSecretOverlay`). `claude_oauth`/`codex_oauth` inspect
 * CLI subscriber credentials for diagnostics but fail closed for direct
 * provider HTTP inference. `openrouter_oauth` uses a user-approved OpenRouter PKCE key stored in the private user credential file; `openai_wif` accepts a pre-exchanged OpenAI API
 * workload identity bearer token and explicit expiry.
 */
export const NATIVE_CREDENTIAL_SOURCE_IDS = ["api_key", "claude_oauth", "codex_oauth", "openrouter_oauth", "openai_wif"] as const;
export type NativeCredentialSourceId = typeof NATIVE_CREDENTIAL_SOURCE_IDS[number];

/**
 * Provider identity and endpoint selection only. This is safe for the normal
 * config provenance projection: it intentionally has no API key/token field.
 */
export interface VerificationConfig {
  /** argv vectors, e.g. [["bun","run","tests:typecheck"],["bun","run","test"]]. */
  acceptance_commands?: readonly (readonly string[])[];
  /**
   * Operator-declared network egress for exact verifier argv. Every machine
   * verification command runs with NO host network by default (a private
   * network namespace with its own loopback). A command that genuinely needs
   * egress — e.g. `cargo test` on a repository without a `Cargo.lock`, which
   * must fetch crates — is listed here with the reason, and only an argv
   * exactly equal to a declared one is granted it. Never inferred from the
   * command text, never default-on; the grant and its reason are recorded in
   * the verification evidence.
   */
  network_egress?: readonly VerificationNetworkEgressGrant[];
}

/** One explicit verifier network opt-in: the exact argv and why it needs egress. */
export interface VerificationNetworkEgressGrant {
  argv: readonly string[];
  /** Operator-authored, bounded, single-line reason recorded in the evidence. */
  reason: string;
}

/** Upper bound on a `network_egress` reason, which is embedded in the verified provenance label. */
export const VERIFICATION_NETWORK_EGRESS_REASON_MAX = 200;

export interface NativeProviderConfig {
  /** `auto` uses native only when a complete endpoint/model selection exists. */
  mode: NativeProviderMode;
  /** Wire adapter, distinct from provider/account identity. */
  adapter_id: NativeProviderAdapterId;
  provider_id: string;
  base_url: string;
  model: string;
  /**
   * Optional provider-declared response revision expected by the composed
   * adapter. This is not a claim that a provider permanently pins a model:
   * execution/evaluation may use it only after the adapter observes the same
   * revision in that response protocol.
   */
  revision?: string;
  /**
   * Explicit opt-in to the closed frontier route: a tool-capable OpenRouter
   * model paired with a no-tool Claude-bridge child (`agents.lenticel.model`),
   * connector fallback forbidden. Absent or false, `provider_id:
   * "openrouter"` is an ordinary native provider like any other — the route
   * used to be selected by the provider id alone, which made OpenRouter
   * impossible to use plainly.
   */
  closed_route?: boolean;
  /** Native model failover through the owned Claude Code bridge, not a connector executor. */
  openrouter_fallback?: { enabled: boolean; model: string };
  /**
   * Static, operator-configured price observation. No runtime component may
   * replace this with a network lookup or a model-name approximation.
   */
  pricing?: NativePricingConfig;
  /**
   * Authoritative per-session model-turn ceiling for the native executor.
   * Absent means `NATIVE_MAX_TURNS_DEFAULT` (see arbor-mcp's
   * `native-agent-executor.ts`) governs; a call site MAY still pass its own
   * `max_turns` override, but composition should route through this leaf
   * rather than drift another hardcoded constant per call site.
   */
  max_turns?: number;
  /**
   * Wall-clock ceiling for one native executor session. Absent means the
   * executor's own 600s default governs.
   *
   * This exists because turn COUNT is the wrong bound on some transports. A
   * subscription-auth CLI bridge answers each turn by spawning a fresh
   * provider process, so a session doing real work spends its budget on
   * process latency rather than on turns: measured on sonnet over the
   * 25-tool catalogue, a single-function fix needed ~10 turns and exceeded
   * 600s with `max_turns` nowhere near its own ceiling. The ceiling was
   * previously an executor option no composition root ever passed, so no
   * operator could raise it and the only symptom was
   * `timeout: session wall-clock limit exceeded`.
   *
   * Not a substitute for `max_turns`; both apply independently.
   */
  max_session_wall_clock_ms?: number;
  /**
   * Lifetime of a scoped native credential lease. Absent means the broker's own
   * 600s default governs; the broker hard-caps it at 3600s.
   *
   * This must be at or above `max_session_wall_clock_ms`. The broker re-checks
   * the lease on every dispatch and issues no renewal, so a session that
   * outlives its own grant dies mid-campaign with
   * `ScopedCredentialLeaseError: credential lease unavailable: expired`.
   *
   * That combination was invisible while the only transport was a
   * subscription-auth CLI bridge: at ~2.5s per turn a session never reached
   * 600s, so the lease never expired. On a direct HTTP provider at ~0.6s per
   * turn a single-function fix legitimately runs past it, and the first
   * campaign to do so failed. Composition never passed `lease_ttl_ms`, so no
   * operator could widen it either.
   *
   * Deliberately NOT derived from `max_session_wall_clock_ms`: a lease bounds
   * how long a credential grant stays valid, which is a security boundary, so
   * widening it is an explicit operator act rather than a side effect.
   */
  credential_lease_ttl_ms?: number;
  /** Optional strict native-session ceilings and their declared estimator. */
  usage_budget?: NativeUsageBudgetConfig;
  /**
   * Default-on usage/cost metering, independent of `usage_budget`'s
   * enforcement ceilings. `false` is the explicit full opt-out; absent (or
   * `true`) means the native executor always accumulates observed
   * usage/cost, whether or not any hard cap is configured.
   */
  usage_accounting_enabled?: boolean;
  /**
   * Automatic mid-session context-compaction trigger. Absent means enabled at
   * the conservative default threshold (`DEFAULT_COMPACTION_THRESHOLD_FRACTION`
   * in `@arbor/harness`'s `context-manager.ts`); `enabled: false` disables
   * automatic compaction entirely. This leaf carries no summarizer: a real
   * model-backed summarizer, if any, is a composition-owned seam, never a
   * config value.
   */
  context_compaction?: NativeContextCompactionThresholdConfig;
  /** Non-secret, bounded wire limits for the selected native adapter. */
  transport?: NativeTransportConfig;
  /**
   * Which credential source to read for model auth. Absent means `api_key`
   * (unchanged default behavior). This is itself non-secret -- it names a
   * source, never a value -- and is safe for the normal config provenance
   * projection.
   */
  credential_source?: NativeCredentialSourceId;
  /** Select a provider-owned native inference route; CLI routes preserve provider login inside the first-party process. */
  auth_route?: "provider_api" | "claude_code_cli" | "openai_codex_cli";
  /** Explicit adapter capabilities; never inferred from a provider or model name. */
  capabilities?: NativeProviderCapabilities;
  /** Pluggable web.search provider selection; see `NativeProviderCapabilities.web_search`'s admission gate. */
  web_search?: NativeWebSearchConfig;
  /** External tool-only MCP servers. Credential values remain environment-only. */
  mcp_servers?: readonly NativeMcpServerConfig[];
}

export interface NativeTransportConfig {
  /** Per-attempt wall-clock ceiling, capped by the adapter at five minutes. */
  timeout_ms?: number;
  /** Raw streamed response ceiling; the adapter always caps this at 8 MiB. */
  max_response_bytes?: number;
}

export interface NativeProviderCapabilities {
  /** Enables governed image artifacts for the selected OpenAI-compatible adapter. */
  image_input?: boolean;
  /**
   * Explicitly grants the governed `web.fetch` tool (HTTPS GET of a
   * model-supplied URL) to native sessions. Default off: this repository
   * has no OS-level network confinement (LR-NH-07), so network egress is
   * an application-level policy decision, not a sandboxed one.
   */
  web_fetch?: boolean;
  /**
   * Explicitly grants the governed `web.search` tool. Every call is refused
   * as `provider_unconfigured` until `native.web_search.provider` also
   * names a composed provider — this flag alone does not make search work.
   */
  web_search?: boolean;
}

export interface NativeWebSearchConfig {
  /** Provider id recognized by the composition root (`searxng` is built in and requires ARBOR_WEB_SEARCH_ENDPOINT). */
  provider?: string;
}

export type NativeMcpServerConfig =
  | { readonly server_id: string; readonly transport: "stdio"; readonly command: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>>; readonly credential_env?: string; readonly read_only_tools?: readonly string[]; readonly mutating_tools?: readonly string[]; readonly resources?: boolean; readonly prompts?: boolean }
  | { readonly server_id: string; readonly transport: "http"; readonly url: string; readonly credential_env?: string; readonly read_only_tools?: readonly string[]; readonly mutating_tools?: readonly string[]; readonly resources?: boolean; readonly prompts?: boolean };

export interface NativePricingConfig {
  price_source_id: string;
  observed_at: string;
  provider_id: string;
  model_id: string;
  currency: string;
  minor_unit_exponent: number;
  input_minor_units_per_million_tokens: number;
  output_minor_units_per_million_tokens: number;
  cache_read_minor_units_per_million_tokens: number;
  cache_write_minor_units_per_million_tokens: number;
}

export interface NativeUsageBudgetConfig {
  /** Identifies the explicit conservative estimator, never a provider guess. */
  estimate_authority: string;
  /** Per-request conservative input bound enforced before provider dispatch. */
  estimate_max_input_tokens: number;
  /**
   * Per-request completion limit, also sent to the composed provider adapter
   * as `max_tokens`. Optional: omitted, it is
   * `DEFAULT_NATIVE_ESTIMATE_MAX_OUTPUT_TOKENS` (8,000). Keep it low enough
   * that the token budget, not `native.transport.max_response_bytes`, ends a
   * long reasoning turn: a reasoning stream spends roughly 400 raw SSE bytes
   * per token, so 16,000 tokens overran the 4 MiB default byte limit in the
   * Stage 0 re-pilot (docs/research/uct-search/stage0-repilot-report-2026-10-07.md §4.2).
   */
  estimate_max_output_tokens?: number;
  max_session_input_tokens?: number;
  max_session_output_tokens?: number;
  max_session_cache_read_tokens?: number;
  max_session_cache_write_tokens?: number;
  max_session_total_tokens?: number;
  max_session_cost?: {
    currency: string;
    minor_units: number;
    minor_unit_exponent: number;
  };
  /** Campaign-wide ceilings; require the same explicit estimate/pricing evidence. */
  max_campaign_tokens?: number;
  max_campaign_cost?: {
    currency: string;
    minor_units: number;
    minor_unit_exponent: number;
  };
}

export interface NativeContextCompactionThresholdConfig {
  enabled?: boolean;
  /** Must be in `(0, 1]` when configured. */
  threshold_fraction?: number;
}

export interface AgentConfig {
  model: string;
  compaction?: { model: string };
  /** Operator-authored bindings applied only to the re-derived foreground
   * card for a live dispatch; they never replace the durable tree node. */
  foreground?: {
    modes?: readonly ("streaming" | "steerable" | "promote")[];
    inputs?: readonly string[];
    outputs?: readonly string[];
  };
}

export interface CategoryConfig {
  model: string;
}

export interface TreeSearchConfig {
  max_seconds: number;
  min_score: number;
  exploration_constant: number;
  convergence_iterations: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export const AGENT_NAMES = [
  "crown", "heartwood", "taproot", "cambium",
  "burl", "mycelium", "rhizome", "stoma",
  "xylem", "lenticel", "seed",
] as const;

export const CATEGORY_NAMES = [
  "crown-structural", "heartwood-deep", "seed-quick", "leaf-visual", "sap-write",
] as const;
