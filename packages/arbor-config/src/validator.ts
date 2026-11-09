import type { AgentConfig, ArborConfig, ValidationResult } from "./types.js";
import { AGENT_NAMES, CATEGORY_NAMES, NATIVE_CREDENTIAL_SOURCE_IDS, NATIVE_PROVIDER_ADAPTER_IDS, SANDBOX_CONFINEMENT_LEVELS, TUI_THEME_NAMES, VERIFICATION_NETWORK_EGRESS_REASON_MAX, CONNECTOR_OPT_IN_REASON_MAX } from "./types.js";

const FOREGROUND_MODES = new Set(["streaming", "steerable", "promote"]);

export function validateConfig(config: ArborConfig): ValidationResult {
  const errors: string[] = [];

  for (const name of AGENT_NAMES) {
    if (!config.agents[name]) {
      errors.push(`Missing agent: ${name}`);
    } else if (!config.agents[name].model || config.agents[name].model.trim() === "") {
      errors.push(`Agent ${name} has empty model`);
    } else {
      validateAgentCompactionAndForeground(name, config.agents[name], errors);
    }
  }

  for (const name of CATEGORY_NAMES) {
    if (!config.categories[name]) {
      errors.push(`Missing category: ${name}`);
    } else if (!config.categories[name].model || config.categories[name].model.trim() === "") {
      errors.push(`Category ${name} has empty model`);
    }
  }

  if (config.tree_search.max_seconds < 0) {
    errors.push("tree_search.max_seconds must be >= 0 (0 disables the wall-clock budget)");
  }
  if (config.tree_search.min_score < 0) {
    errors.push("tree_search.min_score must be >= 0");
  }
  if (config.tree_search.exploration_constant <= 0) {
    errors.push("tree_search.exploration_constant must be > 0");
  }
  if (config.tree_search.convergence_iterations < 1) {
    errors.push("tree_search.convergence_iterations must be >= 1");
  }
  if (config.kb && !["jsonl", "sqlite"].includes(config.kb.backend)) {
    errors.push(`kb.backend must be "jsonl" or "sqlite", got: ${config.kb.backend}`);
  }

  if (!config.native || !["auto", "native", "fallback"].includes(config.native.mode)) {
    errors.push("native.mode must be \"auto\", \"native\", or \"fallback\"");
  } else {
    if (!(NATIVE_PROVIDER_ADAPTER_IDS as readonly string[]).includes(config.native.adapter_id)) errors.push(`native.adapter_id must be one of: ${NATIVE_PROVIDER_ADAPTER_IDS.join(", ")}`);
    if (!config.native.provider_id || config.native.provider_id.trim() === "") errors.push("native.provider_id must be non-empty");
    if (config.native.mode === "native" && (!config.native.base_url || config.native.base_url.trim() === "")) {
      errors.push("native.base_url must be non-empty when native.mode is \"native\"");
    }
    if (config.native.mode === "native" && (!config.native.model || config.native.model.trim() === "")) {
      errors.push("native.model must be non-empty when native.mode is \"native\"");
    }
    if (config.native.revision !== undefined && (typeof config.native.revision !== "string" || config.native.revision.trim() === "")) {
      errors.push("native.revision must be non-empty when configured");
    }
    const fallback = config.native.openrouter_fallback;
    if (fallback !== undefined && (fallback === null || typeof fallback !== "object"
      || typeof fallback.enabled !== "boolean" || typeof fallback.model !== "string" || fallback.model.trim() === "")) {
      errors.push("native.openrouter_fallback requires boolean enabled and a non-empty model");
    }
    if (config.native.credential_source !== undefined && !(NATIVE_CREDENTIAL_SOURCE_IDS as readonly string[]).includes(config.native.credential_source)) {
      errors.push(`native.credential_source must be one of: ${NATIVE_CREDENTIAL_SOURCE_IDS.join(", ")}`);
    }
    if (config.native.auth_route !== undefined && !["provider_api", "claude_code_cli", "openai_codex_cli"].includes(config.native.auth_route)) {
      errors.push('native.auth_route must be one of: provider_api, claude_code_cli, openai_codex_cli');
    }
    if (config.native.max_turns !== undefined && (!isPositiveSafeInteger(config.native.max_turns) || config.native.max_turns > 512)) {
      errors.push("native.max_turns must be a positive safe integer no greater than 512 when configured");
    }
    if (config.native.max_session_wall_clock_ms !== undefined && (!isPositiveSafeInteger(config.native.max_session_wall_clock_ms) || config.native.max_session_wall_clock_ms > 7_200_000)) {
      errors.push("native.max_session_wall_clock_ms must be a positive safe integer no greater than 7200000 when configured");
    }
    if (config.native.credential_lease_ttl_ms !== undefined && (!Number.isSafeInteger(config.native.credential_lease_ttl_ms) || config.native.credential_lease_ttl_ms < 1_000 || config.native.credential_lease_ttl_ms > 3_600_000)) {
      errors.push("native.credential_lease_ttl_ms must be a safe integer from 1000 through 3600000 when configured");
    }
    // A session must never outlive its own credential grant: the broker
    // re-checks the lease on every dispatch and issues no renewal, so a shorter
    // lease fails the campaign mid-flight with "credential lease unavailable:
    // expired" instead of at a reviewable boundary.
    if (config.native.max_session_wall_clock_ms !== undefined && config.native.credential_lease_ttl_ms !== undefined && config.native.credential_lease_ttl_ms < config.native.max_session_wall_clock_ms) {
      errors.push("native.credential_lease_ttl_ms must be at least native.max_session_wall_clock_ms so a session cannot outlive its credential lease");
    }
    if (config.native.usage_accounting_enabled !== undefined && typeof config.native.usage_accounting_enabled !== "boolean") {
      errors.push("native.usage_accounting_enabled must be boolean when configured");
    }
    const compaction = config.native.context_compaction;
    if (compaction !== undefined) {
      if (compaction.enabled !== undefined && typeof compaction.enabled !== "boolean") errors.push("native.context_compaction.enabled must be boolean when configured");
      if (compaction.threshold_fraction !== undefined && (typeof compaction.threshold_fraction !== "number" || !Number.isFinite(compaction.threshold_fraction) || compaction.threshold_fraction <= 0 || compaction.threshold_fraction > 1)) {
        errors.push("native.context_compaction.threshold_fraction must be a number in (0, 1] when configured");
      }
    }
    const pricing = config.native.pricing;
    if (pricing !== undefined) {
      if ([pricing.price_source_id, pricing.provider_id, pricing.model_id, pricing.currency].some((value) => typeof value !== "string" || value.trim() === "")) errors.push("native.pricing requires non-empty source, provider, model, and currency");
      if (Number.isNaN(Date.parse(pricing.observed_at))) errors.push("native.pricing.observed_at must be an ISO timestamp");
      if (!isNonNegativeSafeInteger(pricing.minor_unit_exponent) || pricing.minor_unit_exponent > 9) errors.push("native.pricing.minor_unit_exponent must be a safe integer between 0 and 9");
      if (![pricing.input_minor_units_per_million_tokens, pricing.output_minor_units_per_million_tokens, pricing.cache_read_minor_units_per_million_tokens, pricing.cache_write_minor_units_per_million_tokens].every(isNonNegativeSafeInteger)) errors.push("native.pricing rates must be non-negative safe integers");
    }
    const budget = config.native.usage_budget;
    if (budget !== undefined) {
      if (budget.estimate_authority.trim() === "") errors.push("native.usage_budget.estimate_authority must be non-empty");
      if (!isPositiveSafeInteger(budget.estimate_max_input_tokens) || (budget.estimate_max_output_tokens !== undefined && !isPositiveSafeInteger(budget.estimate_max_output_tokens))) errors.push("native.usage_budget requires a positive safe estimate_max_input_tokens, and a positive safe estimate_max_output_tokens when configured");
      for (const [name, value] of Object.entries({ max_session_input_tokens: budget.max_session_input_tokens, max_session_output_tokens: budget.max_session_output_tokens, max_session_cache_read_tokens: budget.max_session_cache_read_tokens, max_session_cache_write_tokens: budget.max_session_cache_write_tokens, max_session_total_tokens: budget.max_session_total_tokens, max_campaign_tokens: budget.max_campaign_tokens })) {
        if (value !== undefined && !isPositiveSafeInteger(value)) errors.push(`native.usage_budget.${name} must be a positive safe integer when configured`);
      }
      if (budget.max_session_cost !== undefined) {
        const cost = budget.max_session_cost;
        if (cost.currency.trim() === "" || !isNonNegativeSafeInteger(cost.minor_units) || !isNonNegativeSafeInteger(cost.minor_unit_exponent) || cost.minor_unit_exponent > 9) errors.push("native.usage_budget.max_session_cost must contain currency and non-negative safe amount/exponent");
        if (pricing === undefined) errors.push("native.usage_budget.max_session_cost requires native.pricing; live price lookup is not supported");
        else if (pricing.currency !== cost.currency || pricing.minor_unit_exponent !== cost.minor_unit_exponent) errors.push("native.usage_budget.max_session_cost denomination must match native.pricing");
      }
      if (budget.max_campaign_cost !== undefined) {
        const cost = budget.max_campaign_cost;
        if (cost.currency.trim() === "" || !isNonNegativeSafeInteger(cost.minor_units) || !isNonNegativeSafeInteger(cost.minor_unit_exponent) || cost.minor_unit_exponent > 9) errors.push("native.usage_budget.max_campaign_cost must contain currency and non-negative safe amount/exponent");
        if (pricing === undefined) errors.push("native.usage_budget.max_campaign_cost requires native.pricing; live price lookup is not supported");
        else if (pricing.currency !== cost.currency || pricing.minor_unit_exponent !== cost.minor_unit_exponent || pricing.price_source_id === "") errors.push("native.usage_budget.max_campaign_cost denomination must match native.pricing");
      }
    }
    const transport = config.native.transport;
    if (transport !== undefined) {
      if (transport.timeout_ms !== undefined && (!isPositiveSafeInteger(transport.timeout_ms) || transport.timeout_ms > 300_000)) {
        errors.push("native.transport.timeout_ms must be a positive safe integer no greater than 300000");
      }
      if (transport.max_response_bytes !== undefined && (!isPositiveSafeInteger(transport.max_response_bytes) || transport.max_response_bytes > 8_388_608)) {
        errors.push("native.transport.max_response_bytes must be a positive safe integer no greater than 8388608");
      }
    }
    const capabilities = config.native.capabilities;
    if (capabilities !== undefined && (typeof capabilities !== "object" || capabilities === null)) {
      errors.push("native.capabilities must be an object when configured");
    } else if (capabilities !== undefined) {
      if (capabilities.image_input !== undefined && typeof capabilities.image_input !== "boolean") errors.push("native.capabilities.image_input must be boolean when configured");
      if (capabilities.web_fetch !== undefined && typeof capabilities.web_fetch !== "boolean") errors.push("native.capabilities.web_fetch must be boolean when configured");
      if (capabilities.web_search !== undefined && typeof capabilities.web_search !== "boolean") errors.push("native.capabilities.web_search must be boolean when configured");
    }
    const webSearch = config.native.web_search;
    if (webSearch !== undefined) {
      if (typeof webSearch !== "object" || webSearch === null) errors.push("native.web_search must be an object when configured");
      else if (webSearch.provider !== undefined && (typeof webSearch.provider !== "string" || webSearch.provider.trim() === "" || webSearch.provider.length > 64)) {
        errors.push("native.web_search.provider must be a non-empty string of at most 64 characters when configured");
      }
    }
    validateMcpServers(config.native.mcp_servers, errors);
  }

  if (config.sandbox?.confinement !== undefined && !(SANDBOX_CONFINEMENT_LEVELS as readonly string[]).includes(config.sandbox.confinement)) {
    errors.push(`sandbox.confinement must be one of: ${SANDBOX_CONFINEMENT_LEVELS.join(", ")}`);
  }

  validateVerificationNetworkEgress(config.verification?.network_egress, errors);
  validateConnectorPolicy(config.connectors, errors);

  if (config.tui?.color !== undefined && !["auto", "always", "never"].includes(config.tui.color)) errors.push("tui.color must be auto, always, or never");
  if (config.tui?.theme !== undefined && !(TUI_THEME_NAMES as readonly string[]).includes(config.tui.theme)) {
    errors.push(`tui.theme must be one of: ${TUI_THEME_NAMES.join(", ")}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * `AgentConfig.compaction`/`.foreground` are validated here even though this
 * package has no in-package consumer for `compaction` (C-06: the intended
 * consumer is arbor-opencode's agent binding, unowned by this lane — see
 * ADR-020/G-07 lane report). `foreground` already has a live reader
 * (`arbor-mcp`'s runtime catalog, via `runtime.agentConfig[agent].foreground`),
 * so a malformed value there reaches behaviour today; validating its shape
 * here rejects a bad config before it does. Keeping both fields validated,
 * rather than silently accepted, is the honest floor while `compaction`
 * remains unwired: a malformed value is rejected instead of round-tripping
 * unnoticed until an eventual consumer trips over it.
 */
function validateAgentCompactionAndForeground(name: string, agent: AgentConfig, errors: string[]): void {
  if (agent.compaction !== undefined) {
    if (typeof agent.compaction !== "object" || agent.compaction === null || typeof agent.compaction.model !== "string" || agent.compaction.model.trim() === "") {
      errors.push(`Agent ${name} has an invalid compaction.model (must be a non-empty string)`);
    }
  }
  if (agent.foreground !== undefined) {
    const foreground = agent.foreground;
    if (typeof foreground !== "object" || foreground === null) {
      errors.push(`Agent ${name} has an invalid foreground binding`);
      return;
    }
    if (foreground.modes !== undefined && (!Array.isArray(foreground.modes) || foreground.modes.length !== new Set(foreground.modes).size || foreground.modes.some((mode) => !FOREGROUND_MODES.has(mode)))) {
      errors.push(`Agent ${name} has an invalid foreground.modes (must be unique values from: ${[...FOREGROUND_MODES].join(", ")})`);
    }
    for (const field of ["inputs", "outputs"] as const) {
      const value = foreground[field];
      if (value !== undefined && (!Array.isArray(value) || value.length !== new Set(value).size || value.some((entry) => typeof entry !== "string" || entry.trim() === ""))) {
        errors.push(`Agent ${name} has an invalid foreground.${field} (must be unique non-empty strings)`);
      }
    }
  }
}

/**
 * `verification.network_egress` widens a verifier command from "no host
 * network" to host network, so every grant must name an exact argv and say
 * why. The reason is embedded in the verified provenance label, hence the
 * single-line, bounded constraint; a duplicate argv would make the recorded
 * reason ambiguous.
 */
function validateVerificationNetworkEgress(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) { errors.push("verification.network_egress must be an array when configured"); return; }
  const seen = new Set<string>();
  value.forEach((grant: unknown, index) => {
    const at = `verification.network_egress[${index}]`;
    if (grant === null || typeof grant !== "object" || Array.isArray(grant)) { errors.push(`${at} must be an object with argv and reason`); return; }
    const { argv, reason, ...rest } = grant as Record<string, unknown>;
    if (Object.keys(rest).length > 0) errors.push(`${at} has unknown keys: ${Object.keys(rest).join(", ")}`);
    if (!Array.isArray(argv) || argv.length === 0 || argv.some((part) => typeof part !== "string" || part.length === 0 || part.includes("\0"))) {
      errors.push(`${at}.argv must be a non-empty array of non-empty strings`);
    } else {
      const key = JSON.stringify(argv);
      if (seen.has(key)) errors.push(`${at}.argv duplicates an earlier network_egress grant`);
      seen.add(key);
    }
    if (typeof reason !== "string" || reason.trim() === "" || reason.length > VERIFICATION_NETWORK_EGRESS_REASON_MAX || /[\u0000-\u001f\u007f]/.test(reason)) {
      errors.push(`${at}.reason must be a non-empty single-line string of at most ${VERIFICATION_NETWORK_EGRESS_REASON_MAX} characters`);
    }
  });
}

/**
 * `connectors.allow_deprecated` re-enables a non-Canopy harness lane, so the
 * opt-in must say why: the reason is copied into the evidence of every run
 * that uses it. An unknown key is refused rather than ignored, because a
 * misspelt opt-in that silently does nothing reads as a refusal bug.
 */
function validateConnectorPolicy(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (value === null || typeof value !== "object" || Array.isArray(value)) { errors.push("connectors must be an object when configured"); return; }
  const { allow_deprecated: allow, reason, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) errors.push(`connectors has unknown keys: ${Object.keys(rest).join(", ")}`);
  if (allow !== undefined && typeof allow !== "boolean") errors.push("connectors.allow_deprecated must be a boolean");
  if (reason !== undefined && (typeof reason !== "string" || reason.trim() === "" || reason.length > CONNECTOR_OPT_IN_REASON_MAX || /[\u0000-\u001f\u007f]/.test(reason))) {
    errors.push(`connectors.reason must be a non-empty single-line string of at most ${CONNECTOR_OPT_IN_REASON_MAX} characters`);
  }
  if (allow === true && reason === undefined) errors.push("connectors.allow_deprecated requires connectors.reason");
}

function isNonNegativeSafeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function isPositiveSafeInteger(value: unknown): value is number { return isNonNegativeSafeInteger(value) && value > 0; }

function validateMcpServers(value: import("./types.js").NativeProviderConfig["mcp_servers"], errors: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 8) { errors.push("native.mcp_servers must be an array with at most 8 entries"); return; }
  const ids = new Set<string>();
  for (const [index, server] of value.entries()) {
    const prefix = `native.mcp_servers[${index}]`;
    if (typeof server !== "object" || server === null || Array.isArray(server)) { errors.push(`${prefix} must be an object`); continue; }
    const allowedFields = new Set(["server_id", "transport", "credential_env", "read_only_tools", "mutating_tools", "resources", "prompts", ...(server.transport === "stdio" ? ["command", "args", "env"] : server.transport === "http" ? ["url"] : [])]);
    const unknownFields = Object.keys(server).filter((key) => !allowedFields.has(key));
    if (unknownFields.length > 0) errors.push(`${prefix} contains unknown fields: ${unknownFields.join(", ")}`);
    if (!/^[a-z0-9-]{1,32}$/.test(server.server_id)) errors.push(`${prefix}.server_id must match [a-z0-9-] and be at most 32 characters`);
    else if (ids.has(server.server_id)) errors.push(`${prefix}.server_id must be unique`); else ids.add(server.server_id);
    if (server.transport !== "stdio" && server.transport !== "http") { errors.push(`${prefix}.transport must be "stdio" or "http"`); continue; }
    for (const flag of ["resources", "prompts"] as const) if (server[flag] !== undefined && typeof server[flag] !== "boolean") errors.push(`${prefix}.${flag} must be a boolean`);
    if (server.transport === "stdio") {
      if (typeof server.command !== "string" || server.command.trim() === "" || Buffer.byteLength(server.command) > 1024) errors.push(`${prefix}.command is required and bounded for stdio`);
      if ((server as Record<string, unknown>).url !== undefined) errors.push(`${prefix}.url is not allowed for stdio`);
      if (server.args !== undefined && (!Array.isArray(server.args) || server.args.length > 64 || server.args.some((arg: unknown) => typeof arg !== "string" || Buffer.byteLength(arg) > 4096))) errors.push(`${prefix}.args is invalid or exceeds its bounds`);
      if (server.env !== undefined && (Object.keys(server.env).length > 32 || Object.entries(server.env).some(([key, item]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== "string" || Buffer.byteLength(item) > 8192))) errors.push(`${prefix}.env is invalid or exceeds its bounds`);
      if (server.credential_env !== undefined && server.env?.[server.credential_env] !== undefined) errors.push(`${prefix}.env must not contain the credential_env value; credentials are environment-only overlays`);
    } else {
      if ((server as Record<string, unknown>).command !== undefined || (server as Record<string, unknown>).args !== undefined || (server as Record<string, unknown>).env !== undefined) errors.push(`${prefix} stdio fields are not allowed for http`);
      try { const parsed = new URL(server.url); if (Buffer.byteLength(server.url) > 2048 || parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error(); } catch { errors.push(`${prefix}.url must be a bounded absolute https URL without embedded credentials`); }
    }
    if (server.credential_env !== undefined && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(server.credential_env)) errors.push(`${prefix}.credential_env must be a valid environment variable name`);
    for (const [field, tools] of [["read_only_tools", server.read_only_tools], ["mutating_tools", server.mutating_tools]] as const) if (tools !== undefined && (!Array.isArray(tools) || tools.length > 64 || new Set(tools).size !== tools.length || tools.some((tool) => typeof tool !== "string" || !tool || Buffer.byteLength(tool) > 128))) errors.push(`${prefix}.${field} is invalid or exceeds its bounds`);
    if (server.read_only_tools?.some((tool: string) => server.mutating_tools?.includes(tool))) errors.push(`${prefix} cannot declare a tool both read-only and mutating`);
  }
}
