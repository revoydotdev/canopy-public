/**
 * The native executor's composition, in one place (ADR-142 §2).
 *
 * WHY THIS MODULE EXISTS. `arbor run` is deliberately its own production
 * composition root — it owns a persistence root, composes config, agent
 * definitions and live provider capability exactly as `createCliRuntime` does
 * for `serve`/`webui`. What it never composed was the native lane. So no
 * matter what executor `arbor run` selected, the native harness was not
 * reachable from it, and the same was true of `selfhost`. That is why every
 * campaign turn in this repository has run on a connector subprocess.
 *
 * The composition itself was not the hard part; it was simply written inside
 * `createCliRuntime`'s body, where only that one caller could reach it. This
 * module lifts it out unchanged so all three campaign composition roots build
 * it the same way. A second caller hand-rolling an equivalent would be exactly
 * the divergent double this repository forbids: a credential overlay or plugin
 * trust set assembled slightly differently is a security difference, not a
 * style one.
 *
 * It composes; it decides nothing. Which lane actually runs is
 * `resolveCampaignExecutorLane`'s judgement, kept separate so the decision can
 * be tested without a credential, an endpoint or a filesystem.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { ArborConfig } from "@arbor/config";
import { resolveNativeCredentialOverlay, resolveCodexOAuthCredential } from "@arbor/config";
import type { NativeCredentialOverlay, NativeCredentialSelection, NativeOAuthCredentialStatus, OrganizationPolicy } from "@arbor/config";
import { createReferenceNativeModelAdapterRegistry } from "@arbor/harness";
import { McpConnector } from "./mcp-client/mcp-connector.js";
import { SkillCatalog } from "./skills/catalog.js";
import { HookCatalog } from "./hooks/catalog.js";
import { HookBus } from "./hooks/bus.js";
import { CommandCatalog } from "./extensibility/command-catalog.js";
import { PluginRegistry } from "./extensibility/plugin-registry.js";
import type { ArborRuntime } from "./runtime.js";

/** The dependency set `configuredNativeAgentExecutor` needs to build a native executor. */
export interface NativeExecutorComposition {
  readonly credential: NativeCredentialOverlay;
  /** Set only when `credential`'s source is permanently unusable for inference (e.g. codex_oauth); see `resolveNativeCredentialOverlay`. */
  readonly credential_boundary?: { readonly reason: string };
  readonly adapters: ReturnType<typeof createReferenceNativeModelAdapterRegistry>;
  readonly mcp_connectors: readonly McpConnector[];
  readonly skill_catalog: SkillCatalog;
  readonly hook_bus: HookBus;
  readonly organization_policy: OrganizationPolicy | null;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export interface NativeExecutorEnvironmentInput {
  readonly cwd: string;
  readonly config: ArborConfig;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly safe_mode: boolean;
  readonly persistence_dir: string;
  readonly organization_policy: OrganizationPolicy | null;
  /**
   * The runtime this composition will serve, supplied as a box because the
   * hook bus records evidence against a runtime that does not exist yet at
   * composition time.
   */
  readonly runtime_box: { current: ArborRuntime | null };
}

/**
 * Everything the composition produced. The catalogs and the plugin registry
 * come back because the caller keeps using them for its own wiring — plugin
 * components are installed into the very catalogs the native executor reads,
 * so handing back copies would let the two views drift.
 */
export interface NativeExecutorEnvironment {
  readonly composition: NativeExecutorComposition;
  readonly native_credential_selection: NativeCredentialSelection;
  readonly native_credential: NativeCredentialOverlay;
  /**
   * The critic remains a separate single-call path, but uses the same
   * provider-native credential source and endpoint boundary.
   */
  readonly native_critic_credential: NativeCredentialOverlay;
  readonly native_adapters: ReturnType<typeof createReferenceNativeModelAdapterRegistry>;
  readonly mcp_connectors: readonly McpConnector[];
  /** The config-derived connector alone, without the plugin-contributed ones. */
  readonly mcp_connector: McpConnector;
  readonly skill_catalog: SkillCatalog;
  readonly hook_catalog: HookCatalog;
  readonly plugin_commands: CommandCatalog;
  readonly plugin_registry: PluginRegistry;
  readonly hook_bus: HookBus;
}

/**
 * Trusted plugin signing keys.
 *
 * Copied verbatim from cli.ts rather than restated: this refuses an invalid or
 * oversized trust file loudly instead of degrading to "trust nothing", because
 * a silently empty trust map and a correctly empty one are indistinguishable
 * to every caller, and one of them means the operator's plugin trust was
 * dropped on the floor.
 */
export function loadPluginTrust(cwd: string): ReadonlyMap<string, string> {
  const path = join(cwd, ".arbor", "plugin-trust.json");
  if (!existsSync(path)) return new Map();
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("plugin trust file must be an object of key id to Ed25519 public PEM");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 64 || entries.some(([key, pem]) => !key || key.length > 128 || typeof pem !== "string" || Buffer.byteLength(pem) > 8192)) throw new Error("plugin trust file is invalid or oversized");
  return new Map(entries as [string, string][]);
}

/**
 * Compose the native executor's dependency set.
 *
 * Lifted verbatim from `createCliRuntime` so its behaviour is unchanged; the
 * only difference is that more than one composition root can now call it.
 */
export function composeNativeExecutorEnvironment(input: NativeExecutorEnvironmentInput): NativeExecutorEnvironment {
  const { cwd, config, environment, safe_mode: safeMode, persistence_dir: persistenceDir, runtime_box: runtimeBox } = input;

  // This overlay exposes only source/presence metadata to the doctor. Its
  // callback is invoked later, at the session-owned model boundary.
  // `native.credential_source` selects the provider API key, CLI subscriber
  // diagnostics, or OpenAI API WIF bearer. The Claude CLI inference route
  // delegates auth to its local process and does not read an Arbor secret.
  const nativeCredentialSelection = resolveNativeCredentialSelection(config, environment);
  const nativeCredential = nativeCredentialSelection.overlay;
  const nativeCriticCredential = nativeCredential;
  const nativeAdapters = createReferenceNativeModelAdapterRegistry(fetch);
  const mcpConnector = new McpConnector({ servers: config.native.mcp_servers ?? [] });
  const skillCatalog = safeMode ? new SkillCatalog() : SkillCatalog.fromDirectory(join(cwd, ".arbor", "skills"));
  const hookCatalog = safeMode ? new HookCatalog() : HookCatalog.fromDirectory(join(cwd, ".arbor", "hooks"));
  const pluginCommands = safeMode ? new CommandCatalog() : CommandCatalog.fromLocations(join(homedir(), ".arbor", "commands"), join(cwd, ".arbor", "commands"));
  const pluginRegistry = new PluginRegistry({ trusted_keys: loadPluginTrust(cwd), persistence_dir: persistenceDir });
  const pluginMcpConnectors: McpConnector[] = [];
  for (const plugin of safeMode ? [] : pluginRegistry.list()) {
    pluginRegistry.installComponents(plugin.manifest.plugin_id, { commands: pluginCommands, hooks: hookCatalog, skills: skillCatalog });
    if (plugin.manifest.components.mcp_servers.length > 0) pluginMcpConnectors.push(pluginRegistry.mcpConnector(plugin.manifest.plugin_id));
  }
  const mcpConnectors = Object.freeze([mcpConnector, ...pluginMcpConnectors]);
  const hookBus = new HookBus({
    catalog: hookCatalog,
    on_fired(record) {
      const journal = runtimeBox.current?.harnessSessions;
      if (journal === null || journal === undefined || !journal.recordHookFired(record)) throw new Error("runtime hook evidence could not be durably recorded");
    },
  });

  const composition: NativeExecutorComposition = Object.freeze({
    credential: nativeCredential,
    ...(nativeCredentialSelection.boundary === undefined ? {} : { credential_boundary: nativeCredentialSelection.boundary }),
    adapters: nativeAdapters,
    mcp_connectors: mcpConnectors,
    skill_catalog: skillCatalog,
    hook_bus: hookBus,
    organization_policy: input.organization_policy,
    environment,
  });

  return {
    composition,
    native_credential_selection: nativeCredentialSelection,
    native_credential: nativeCredential,
    native_critic_credential: nativeCriticCredential,
    native_adapters: nativeAdapters,
    mcp_connectors: mcpConnectors,
    mcp_connector: mcpConnector,
    skill_catalog: skillCatalog,
    hook_catalog: hookCatalog,
    plugin_commands: pluginCommands,
    plugin_registry: pluginRegistry,
    hook_bus: hookBus,
  };
}

/**
 * The native credential selection for a config, without composing anything
 * else. `composeNativeExecutorEnvironment` uses it, and so does `arbor run`'s
 * lane decision, which must know whether the native lane is ready before it
 * takes the writer lock — one definition, so the two cannot disagree.
 */
export function resolveNativeCredentialSelection(config: ArborConfig, environment: Readonly<Record<string, string | undefined>>): NativeCredentialSelection {
  return config.native.auth_route === "openai_codex_cli"
    ? resolveOpenAICodexCliSelection(environment)
    : config.native.auth_route === "claude_code_cli"
    // The bridge asks Claude Code to use its own logged-in identity. Do not
    // open ~/.claude/.credentials.json or create an Arbor credential lease.
    ? resolveNativeCredentialOverlay({ credential_source: "api_key", provider_id: config.native.provider_id, adapter_id: config.native.adapter_id, base_url: config.native.base_url, env: {} })
    : resolveNativeCredentialOverlay({
      credential_source: config.native.credential_source, provider_id: config.native.provider_id,
      adapter_id: config.native.adapter_id, base_url: config.native.base_url, env: environment,
    });
}

/** Read Codex login metadata for readiness but never expose its bearer to the API adapter. */
export function resolveOpenAICodexCliSelection(environment: Readonly<Record<string, string | undefined>>): NativeCredentialSelection {
  const env = environment as NodeJS.ProcessEnv;
  const codex = resolveCodexOAuthCredential({ env });
  const empty = resolveNativeCredentialOverlay({
    credential_source: "api_key", provider_id: "openai", adapter_id: "openai-compatible",
    base_url: "https://api.openai.com/v1", env: {},
  });
  return Object.freeze({ overlay: empty.overlay, facts: codexCliCredentialFacts(codex.status, codex.file_path) });
}

/** A valid stored refresh token means the first-party Codex CLI can refresh an expired access token. */
export function codexCliCredentialFacts(status: NativeOAuthCredentialStatus, filePath: string) {
  const refreshable = status.state === "expired" && status.refreshable === true;
  const available = status.state === "present" || refreshable;
  return Object.freeze({
    source: "codex_oauth" as const,
    mechanism: "oauth_bearer" as const,
    present: available,
    state: available ? "present" as const : status.state,
    env_var: null,
    file_path: filePath,
  });
}
