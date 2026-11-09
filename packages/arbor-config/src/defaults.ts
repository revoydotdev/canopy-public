import type { ArborConfig } from "./types.js";

/**
 * Default `native.usage_budget.estimate_max_output_tokens`: the per-request
 * completion limit sent to the provider as `max_tokens`. 8,000 keeps a
 * reasoning-heavy turn inside the 4 MiB default response byte limit, so the
 * token budget, not the byte limit, ends it (Stage 0 re-pilot, 2026-10-07).
 */
export const DEFAULT_NATIVE_ESTIMATE_MAX_OUTPUT_TOKENS = 8_000;

export const DEFAULT_CONFIG: ArborConfig = {
  agents: {
    crown: { model: "auto" },
    heartwood: { model: "auto" },
    taproot: { model: "auto" },
    cambium: { model: "auto" },
    burl: { model: "auto" },
    mycelium: { model: "auto" },
    rhizome: { model: "auto" },
    stoma: { model: "auto" },
    xylem: { model: "auto" },
    lenticel: { model: "auto" },
    seed: { model: "auto" },
  },
  categories: {
    "crown-structural": { model: "auto" },
    "heartwood-deep": { model: "auto" },
    "seed-quick": { model: "auto" },
    "leaf-visual": { model: "auto" },
    "sap-write": { model: "auto" },
  },
  tree_search: {
    max_seconds: 0,
    min_score: 0.1,
    exploration_constant: Math.SQRT2,
    convergence_iterations: 2,
  },
  kb: {
    backend: "jsonl",
  },
  // ADR-099: `mode: "auto"` with a complete selection is the shipped
  // default so a fresh checkout resolves `direct_native` the moment a
  // supported credential is exported, instead of guaranteeing
  // `selection_incomplete` until an operator discovers native.* exists.
  // `resolveNativeProviderSelection` itself is unchanged (ADR-099 Decision
  // 1) — this is only the values fed into it.
  native: {
    mode: "auto",
    adapter_id: "anthropic-messages",
    provider_id: "anthropic",
    // The anthropic-messages adapter has no ambient base_url fallback of
    // its own (base_url is a required composition-root input); this is the
    // literal https://api.anthropic.com default it would otherwise need
    // an operator to supply by hand.
    base_url: "https://api.anthropic.com",
    // Pinned deliberately, not inferred from a "latest" alias: an
    // unpinned default silently changes which model a campaign runs
    // against on the provider's schedule, not revoy's. "claude-sonnet-5"
    // is the current-generation Anthropic Messages model id this repo's
    // own adapter fixtures and tests already assume (see
    // packages/arbor-harness/tests/anthropic-messages.test.ts). ADR-099's
    // Consequences section names this pin as a real, ongoing cost: it goes
    // stale as Anthropic deprecates model ids and needs the same
    // staleness discipline `native.pricing`'s static observation already
    // carries (an operator override in arbor.jsonc, or a future scheduled
    // bump) — never a silent "auto-upgrade" in code.
    model: "claude-sonnet-5",
    openrouter_fallback: { enabled: true, model: "claude-haiku-4-5" },
  },
  // Omitted `theme` is the explicit, inspectable "use the terminal
  // light/dark/color-capability fallback" state (theme.ts's
  // `resolveStartupTheme`) — never a hidden implicit choice.
  tui: {},
  verification: {},
  // Omitted `confinement` is the explicit, inspectable "use the recommended
  // `os_best_effort` default" state (@arbor/mcp's `createSandboxBroker`) —
  // never a hidden implicit choice.
  sandbox: {},
};
