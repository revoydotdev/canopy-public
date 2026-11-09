/**
 * Arbor opencode plugin entry point.
 *
 * Loads cleanly in two contexts:
 *
 *   1. As an opencode plugin (registered in opencode.json `plugins` array):
 *      Returns a `Hooks` object with a `config` hook that merges the 11 agents
 *      and 5 categories into the live opencode config.
 *
 *   2. As a config-builder (imported directly):
 *      `buildArborConfigBlock()` returns a plain JSON object that a consumer
 *      can spread into their opencode.json `agent` block, no plugin loader needed.
 *
 * The `@opencode-ai/plugin` package is an optional peer dependency — types are
 * imported lazily so the package type-checks and tests without it installed.
 * When the plugin IS loaded by opencode, the SDK types take precedence.
 */

import { loadConfigWithProvenance } from "@arbor/config";
import { buildAllAgents, type AgentModelOverrides } from "./agents.js";
import { ARBOR_CATEGORIES, CAPABILITY_TIER, resolveCategoryModel, resolveCategoryModelWithFallback, type AvailableModelCatalog, type CategoryModelOverrides, type ArborAgentName, type ArborCategoryName } from "@arbor/core";
import type { OpencodeAgentConfig, PermissionConfig, PermissionEffect } from "./types.js";

/** Plugin context shape — mirrors @opencode-ai/plugin's PluginInput. */
export interface ArborPluginContext {
  project: unknown;
  directory: string;
  worktree: string;
  client?: unknown;
  serverUrl?: URL;
}

/** Hooks object — mirrors @opencode-ai/plugin's Hooks interface. */
export interface ArborHooks {
  dispose?: () => Promise<void>;
  /** The config hook — opencode calls this with a mutable config draft. */
  config?: (input: { config: Record<string, unknown> }) => Promise<void>;
}

/** The opencode config block this plugin contributes. */
export interface ArborConfigBlock {
  agent: Record<ArborAgentName, OpencodeAgentConfig>;
  /** Categories surface as agent metadata — see categories.ts for routing. */
  arbor_categories: Record<ArborCategoryName, { subagent_type: ArborAgentName; description: string; model?: string; model_source?: "configured" | "fallback" | "unavailable" }>;
}

/**
 * G-33: extract real per-agent model overrides from `<directory>/arbor.jsonc`
 * (`@arbor/config`'s `ArborConfig.agents`) — the same loader `arbor-mcp`'s
 * `createCliRuntime` uses for its own config-driven fields (`kb.backend`,
 * `config_inspection`). `"auto"` (`DEFAULT_CONFIG.agents[name].model`'s
 * sentinel — the value every agent has until an operator sets a real one)
 * and empty strings mean "no override configured": filtered out here so a
 * plain read of `effective.agents` can never be mistaken for an operator's
 * real choice.
 */
function loadAgentModelOverrides(directory: string): AgentModelOverrides {
  const { effective } = loadConfigWithProvenance(directory);
  const overrides: AgentModelOverrides = {};
  for (const [name, agentConfig] of Object.entries(effective.agents)) {
    if (agentConfig.model && agentConfig.model !== "auto") {
      overrides[name as ArborAgentName] = agentConfig.model;
    }
  }
  return overrides;
}

/**
 * G-35: an operator's real `categories.*.model` values, same filtering as
 * `loadAgentModelOverrides`. `arbor.jsonc`'s `categories` key had a schema
 * entry and no reader, so setting it changed nothing anywhere.
 */
function loadCategoryModelOverrides(directory: string): CategoryModelOverrides {
  const { effective } = loadConfigWithProvenance(directory);
  const overrides: CategoryModelOverrides = {};
  for (const [name, categoryConfig] of Object.entries(effective.categories ?? {})) {
    if (categoryConfig.model && categoryConfig.model !== "auto") {
      overrides[name as ArborCategoryName] = categoryConfig.model;
    }
  }
  return overrides;
}

/**
 * Build the pure config block (no SDK needed).
 * Consumers can spread this into their opencode.json or merge it via the plugin.
 *
 * `modelOverrides` (G-33) is the real `arbor.jsonc`-sourced value an
 * operator's `agents.*.model` edit resolves to — see `loadAgentModelOverrides`
 * and `arborPlugin` below, the live composition root that supplies it.
 */
export function buildArborConfigBlock(
  modelOverrides?: AgentModelOverrides,
  categoryOverrides?: CategoryModelOverrides,
  availableModels?: AvailableModelCatalog,
): ArborConfigBlock {
  const agents = buildAllAgents({ modelOverrides });
  const categories = Object.fromEntries(
    (Object.keys(ARBOR_CATEGORIES) as ArborCategoryName[]).map((name) => {
      const base = { subagent_type: ARBOR_CATEGORIES[name].subagent_type, description: ARBOR_CATEGORIES[name].description };
      // G-35 baseline (no live catalog available): unchanged behavior, byte
      // for byte — `resolveCategoryModel` alone, no `model_source` field.
      if (availableModels === undefined) {
        const resolved = resolveCategoryModel(name, categoryOverrides);
        return [name, { ...base, ...(resolved === undefined ? {} : { model: resolved.model }) }];
      }
      // A live catalog is available: use `resolveCategoryModelWithFallback`
      // (ADR-001 — a configured-but-unavailable model must not silently
      // fail the category, it falls back and says so) and record which
      // source actually won, since the model choice is now observable here.
      try {
        const resolved = resolveCategoryModelWithFallback(name, categoryOverrides, availableModels);
        return [name, { ...base, model: resolved.model, model_source: resolved.source === "configured" ? "configured" as const : "fallback" as const }];
      } catch {
        // Neither the configured model nor the built-in default is present
        // in the live catalog. A typed absence, not a thrown error that
        // would abort the whole plugin config hook for every category.
        return [name, { ...base, model_source: "unavailable" as const }];
      }
    }),
  ) as ArborConfigBlock["arbor_categories"];
  return { agent: agents, arbor_categories: categories };
}

/**
 * ADR-001: the live model catalog `resolveCategoryModelWithFallback` needs
 * to know whether a category's configured/default model is actually
 * present in the running harness. `ctx.client.config.providers()`
 * (`@opencode-ai/sdk`'s `GET /provider`) is the same live catalog
 * `arbor-mcp`'s `OpenCodeProviderCapabilityAdapter` (cli.ts) already reads
 * over HTTP for output-token capability; here the plugin already runs
 * inside a live opencode process and can read it directly off the supplied
 * client. Best-effort and additive: an absent/erroring client (every
 * existing test that constructs `ArborPluginContext` without a `client`,
 * and any host that does not supply one) falls back to `undefined`, which
 * `buildArborConfigBlock` above treats as "no live catalog" — identical to
 * pre-ADR-001-wiring behavior.
 */
async function loadAvailableModelCatalog(client: unknown): Promise<AvailableModelCatalog | undefined> {
  const providers = (client as { config?: { providers?: (options?: unknown) => Promise<unknown> } } | undefined)?.config?.providers;
  if (typeof providers !== "function") return undefined;
  try {
    const result = await providers.call((client as { config: unknown }).config);
    const list = (result as { data?: { providers?: unknown } } | undefined)?.data?.providers;
    if (!Array.isArray(list)) return undefined;
    const catalog = new Set<string>();
    for (const provider of list) {
      if (typeof provider !== "object" || provider === null) continue;
      const id = (provider as { id?: unknown }).id;
      const models = (provider as { models?: unknown }).models;
      if (typeof id !== "string" || id.length === 0 || typeof models !== "object" || models === null) continue;
      for (const modelId of Object.keys(models)) catalog.add(`${id}/${modelId}`);
    }
    return catalog.size > 0 ? catalog : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The opencode plugin function. Returns Hooks with a `config` hook that merges
 * the arbor agents and categories into the live config.
 *
 * Usage in opencode.json:
 *   { "plugins": ["@arbor/opencode"] }
 *
 * Usage as direct import:
 *   import { arborPlugin } from "@arbor/opencode";
 *   const hooks = await arborPlugin({ project: {}, directory: ".", worktree: "." });
 *   await hooks.config?.({ config: myConfig });
 */
export async function arborPlugin(ctx: ArborPluginContext): Promise<ArborHooks> {
  return {
    config: async ({ config }) => {
      // G-33: `ctx.directory` is the real project directory for this
      // opencode session (mirrors `PluginInput.directory` — "Current
      // project directory for this session") — the one place this plugin
      // can genuinely read `arbor.jsonc` and let an operator's
      // `agents.*.model` edit reach the live agent registration below.
      const modelOverrides = loadAgentModelOverrides(ctx.directory);
      // G-35: the same read for `categories.*.model`, which previously had a
      // schema entry and no reader at all.
      const categoryOverrides = loadCategoryModelOverrides(ctx.directory);
      // ADR-001: the live model catalog this session's host actually has
      // connected, when the host supplies a client capable of answering it.
      const availableModels = await loadAvailableModelCatalog(ctx.client);
      const block = buildArborConfigBlock(modelOverrides, categoryOverrides, availableModels);
      // Merge agents — last write wins, but don't clobber a user-defined override.
      const existingAgent = (config.agent ?? {}) as Record<string, Partial<OpencodeAgentConfig>>;
      const merged: Record<string, OpencodeAgentConfig> = {};
      const clampDiagnostics: PermissionClampDiagnostic[] = [];
      for (const [name, agent] of Object.entries(block.agent)) {
        const existing = existingAgent[name];
        if (!existing) { merged[name] = agent; continue; }
        const rawPermission = mergePermissions(agent.permission, existing.permission ?? {});
        const { permission, diagnostics } = clampTierPermissions(name as ArborAgentName, agent.permission, rawPermission);
        clampDiagnostics.push(...diagnostics);
        merged[name] = { ...agent, ...existing, permission };
      }
      config.agent = merged;
      config.arbor_categories = block.arbor_categories;
      // WA-19 / ADR-001: an override that attempted to loosen a critic's or
      // auditor's edit/write/task permission below its base was dropped by
      // `clampTierPermissions` above. Never `console.log` this — the hook's
      // own return channel is `config` (the same pattern `arbor_categories`
      // already uses above), plus the opencode client's real `/log` API
      // (`ctx.client.app.log`) when the host supplies one, so an operator
      // can actually see why their override did not take effect.
      if (clampDiagnostics.length > 0) {
        config.arbor_permission_diagnostics = clampDiagnostics;
        const client = ctx.client as { app?: { log?: (options: { body: { service: string; level: "warn"; message: string; extra?: Record<string, unknown> } }) => unknown } } | undefined;
        for (const diagnostic of clampDiagnostics) {
          try {
            await client?.app?.log?.({ body: { service: "arbor-opencode", level: "warn", message: diagnostic.reason, extra: { agent: diagnostic.agent, key: diagnostic.key, attempted: diagnostic.attempted, clamped_to: diagnostic.clamped_to } } });
          } catch { /* the diagnostics channel is best-effort; the clamp itself already applied */ }
        }
      }
    },
    dispose: async () => {
      // No persistent state to clean up — agents are config-only.
    },
  };
}

/** Merge a base permission config with an override (override wins per-key). */
function mergePermissions(base: PermissionConfig, override: PermissionConfig): PermissionConfig {
  const out: PermissionConfig = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const baseVal = out[key];
    if (typeof value === "string") {
      out[key] = value;
    } else if (typeof baseVal === "object" && baseVal !== null) {
      out[key] = { ...(baseVal as Record<string, import("./types.js").PermissionEffect>), ...(value as Record<string, import("./types.js").PermissionEffect>) };
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** WA-19: a record of an override the deny-wins clamp refused to apply. */
export interface PermissionClampDiagnostic {
  readonly agent: ArborAgentName;
  readonly key: string;
  readonly attempted: PermissionConfig[string];
  readonly clamped_to: PermissionConfig[string];
  readonly reason: string;
}

/** The tier-defining keys ADR-001's no-self-approval guarantee depends on. */
const TIER_CLAMPED_KEYS = ["edit", "write", "task"] as const;

function permissionRank(effect: PermissionEffect): number { return effect === "deny" ? 0 : effect === "ask" ? 1 : 2; }
/** The loosest effect reachable anywhere in a permission value (a glob object is as loose as its loosest entry). */
function loosestEffect(value: PermissionConfig[string] | undefined): PermissionEffect {
  if (value === undefined) return "deny";
  if (typeof value === "string") return value;
  let worst: PermissionEffect = "deny";
  for (const effect of Object.values(value)) if (permissionRank(effect) > permissionRank(worst)) worst = effect;
  return worst;
}

/**
 * WA-19 / ADR-001: `mergePermissions` above is last-write-wins with no floor
 * — a project or user `opencode.json` override could grant a critic-tier
 * agent `edit`/`write`/`task`, defeating the structural no-self-approval
 * guarantee that tier exists to enforce. This clamp runs AFTER the normal
 * merge for critic-tier agents only: for each tier-defining key, if
 * the merged result is looser than the agent's own base permission
 * (`permissionsFor`'s output — never the override), the whole key reverts to
 * base and the attempted loosening is recorded as a diagnostic instead of
 * being silently dropped. A tightening override (equal-or-stricter) is left
 * untouched.
 */
function clampTierPermissions(agent: ArborAgentName, base: PermissionConfig, merged: PermissionConfig): { permission: PermissionConfig; diagnostics: PermissionClampDiagnostic[] } {
  const tier = CAPABILITY_TIER[agent];
  if (tier !== "critic") return { permission: merged, diagnostics: [] };
  const out: PermissionConfig = { ...merged };
  const diagnostics: PermissionClampDiagnostic[] = [];
  for (const key of TIER_CLAMPED_KEYS) {
    const mergedValue = merged[key];
    if (mergedValue === undefined) continue;
    const baseValue = base[key];
    if (permissionRank(loosestEffect(mergedValue)) > permissionRank(loosestEffect(baseValue))) {
      diagnostics.push({ agent, key, attempted: mergedValue, clamped_to: baseValue ?? "deny", reason: `${agent} is a ${tier}-tier agent; its "${key}" permission may not be loosened below its base value (ADR-001 no-self-approval)` });
      out[key] = baseValue ?? "deny";
    }
  }
  return { permission: out, diagnostics };
}

/**
 * Default export for opencode plugin auto-discovery.
 * Opencode resolves `plugins: ["@arbor/opencode"]` to this default export.
 */
export default arborPlugin;
