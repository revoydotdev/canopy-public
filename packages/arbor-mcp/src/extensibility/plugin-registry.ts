import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { Provenance } from "@arbor/core";
import { redactNativeText } from "@arbor/harness";
import { CommandCatalog } from "./command-catalog.js";
import { parsePluginManifest, validateTierAuthority, verifyPluginManifest, type PluginManifest, type PluginTrustTier } from "./plugin-manifest.js";
import { loadPluginHookHandlers } from "./plugin-hook-handlers.js";
import type { HookCatalog } from "../hooks/catalog.js";
import type { SkillCatalog } from "../skills/catalog.js";
import { McpConnector } from "../mcp-client/mcp-connector.js";

export interface PluginTierFact {
  readonly schema_version: 1;
  readonly sequence: number;
  readonly plugin_id: string;
  readonly version: string;
  readonly previous_tier: PluginTrustTier | null;
  readonly tier: PluginTrustTier;
  readonly reason: "admitted" | "promoted" | "demoted" | "manifest_violation";
  readonly evidence_refs: readonly string[];
  readonly provenance: Provenance;
  readonly at: string;
  readonly previous_hash: string | null;
  readonly content_hash: string;
}
export type PluginActivationState = "installed" | "enabled" | "disabled";
export interface AdmittedPlugin { readonly manifest: PluginManifest; readonly tier: PluginTrustTier; readonly root: string; readonly state: PluginActivationState }

export class PluginTierLedger {
  private readonly facts: PluginTierFact[] = [];
  constructor(private readonly file: string | null = null) { if (file && existsSync(file)) this.replay(readFileSync(file, "utf8")); }
  list(): readonly PluginTierFact[] { return Object.freeze([...this.facts]); }
  append(input: Omit<PluginTierFact, "schema_version" | "sequence" | "previous_hash" | "content_hash">): PluginTierFact {
    const base = { schema_version: 1 as const, sequence: this.facts.length + 1, ...input, previous_hash: this.facts.at(-1)?.content_hash ?? null };
    const fact = Object.freeze({ ...base, content_hash: sha256(JSON.stringify(base)) });
    this.facts.push(fact); this.persist(); return fact;
  }
  private replay(text: string): void {
    for (const line of text.split("\n").filter(Boolean)) {
      const fact = JSON.parse(line) as PluginTierFact; const { content_hash, ...base } = fact;
      if (fact.schema_version !== 1 || fact.sequence !== this.facts.length + 1 || fact.previous_hash !== (this.facts.at(-1)?.content_hash ?? null) || sha256(JSON.stringify(base)) !== content_hash) throw new Error("plugin tier ledger integrity failure");
      this.facts.push(Object.freeze(fact));
    }
  }
  private persist(): void { if (!this.file) return; mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 }); const temporary = `${this.file}.tmp`; writeFileSync(temporary, this.facts.map((fact) => JSON.stringify(fact)).join("\n") + "\n", { mode: 0o600 }); renameSync(temporary, this.file); }
}

export interface PluginRegistryOptions {
  readonly trusted_keys: ReadonlyMap<string, string>;
  readonly tier_ledger?: PluginTierLedger;
  readonly persistence_dir?: string;
  readonly clock?: () => Date;
}

export class PluginRegistry {
  private readonly plugins = new Map<string, AdmittedPlugin>();
  private readonly rollbacks = new Map<string, AdmittedPlugin>();
  private readonly componentSnapshots = new Map<string, ReadonlyMap<string, Buffer>>();
  private readonly rollbackSnapshots = new Map<string, ReadonlyMap<string, Buffer>>();
  private readonly componentTargets = new Map<string, Set<{ readonly commands: CommandCatalog; readonly hooks?: HookCatalog; readonly skills?: SkillCatalog }>>();
  private readonly ledger: PluginTierLedger;
  private readonly clock: () => Date;
  private readonly installationsFile: string | null;
  constructor(private readonly options: PluginRegistryOptions) {
    this.ledger = options.tier_ledger ?? new PluginTierLedger(options.persistence_dir ? join(options.persistence_dir, "plugin-tiers.ndjson") : null);
    this.clock = options.clock ?? (() => new Date());
    this.installationsFile = options.persistence_dir ? join(options.persistence_dir, "plugin-installations.json") : null;
    this.replayInstallations();
  }
  facts(): readonly PluginTierFact[] { return this.ledger.list(); }
  list(): readonly AdmittedPlugin[] { return Object.freeze([...this.plugins.values()].sort((a, b) => a.manifest.plugin_id.localeCompare(b.manifest.plugin_id))); }
  inspect(pluginId: string): AdmittedPlugin | null { return this.plugins.get(pluginId) ?? null; }

  admit(bytes: Uint8Array | string, root: string): AdmittedPlugin {
    const manifest = parsePluginManifest(bytes); verifyPluginManifest(manifest, this.options.trusted_keys); validateTierAuthority(manifest);
    if (this.plugins.has(manifest.plugin_id)) throw new Error(`plugin ${manifest.plugin_id} is already admitted`);
    const plugin = Object.freeze({ manifest, tier: manifest.requested_tier, root: resolve(root), state: "installed" as const });
    this.plugins.set(manifest.plugin_id, plugin);
    this.record(plugin, null, plugin.tier, "admitted", Object.values(manifest.verification));
    this.persistInstallations();
    return plugin;
  }

  installComponents(pluginId: string, targets: { readonly commands: CommandCatalog; readonly hooks?: HookCatalog; readonly skills?: SkillCatalog }): void {
    const plugin = this.required(pluginId); validateTierAuthority(plugin.manifest, plugin.tier);
    const registered = this.componentTargets.get(pluginId) ?? new Set(); registered.add(targets); this.componentTargets.set(pluginId, registered); this.syncComponents(plugin, targets, false);
  }

  /** The only MCP projection: construct the existing fail-closed connector after T4 admission. */
  mcpConnector(pluginId: string, options: { readonly environment?: NodeJS.ProcessEnv; readonly transport_factory?: ConstructorParameters<typeof McpConnector>[0]["transport_factory"] } = {}): McpConnector {
    const plugin = this.required(pluginId); validateTierAuthority(plugin.manifest, plugin.tier);
    if (plugin.tier !== "T4") throw new Error("plugin MCP servers require T4");
    return new McpConnector({ servers: plugin.manifest.components.mcp_servers, active: () => this.isActiveRevision(plugin), ...options });
  }

  changeTier(pluginId: string, tier: PluginTrustTier, evidenceRefs: readonly string[], reason: "promoted" | "demoted"): AdmittedPlugin {
    const current = this.required(pluginId); if (evidenceRefs.length === 0 || evidenceRefs.length > 32 || evidenceRefs.some((value) => !value.trim() || Buffer.byteLength(value) > 512)) throw new Error("tier change requires bounded evidence refs");
    validateTierAuthority(current.manifest, tier);
    const updated = Object.freeze({ ...current, tier }); this.plugins.set(pluginId, updated); this.record(updated, current.tier, tier, reason, evidenceRefs); this.persistInstallations(); return updated;
  }

  enable(pluginId: string, acknowledgeRisk = false): AdmittedPlugin {
    const current = this.required(pluginId); if (requiresAcknowledgement(current) && !acknowledgeRisk) throw new Error("risky plugin activation requires explicit acknowledgement");
    const updated = Object.freeze({ ...current, state: "enabled" as const }); this.plugins.set(pluginId, updated); try { this.syncAllComponents(updated, false); this.persistInstallations(); return updated; } catch (error) { this.plugins.set(pluginId, current); this.syncAllComponents(current, false); throw error; }
  }

  disable(pluginId: string): AdmittedPlugin {
    const current = this.required(pluginId); const updated = Object.freeze({ ...current, state: "disabled" as const }); this.plugins.set(pluginId, updated); try { this.syncAllComponents(updated, false); this.persistInstallations(); return updated; } catch (error) { this.plugins.set(pluginId, current); this.syncAllComponents(current, false); throw error; }
  }

  update(pluginId: string, bytes: Uint8Array | string, root: string, acknowledgeRisk = false): AdmittedPlugin {
    const current = this.required(pluginId); const manifest = parsePluginManifest(bytes); verifyPluginManifest(manifest, this.options.trusted_keys); validateTierAuthority(manifest);
    if (manifest.plugin_id !== pluginId) throw new Error("plugin update must retain the installed plugin id"); if (requiresAcknowledgement({ ...current, manifest }) && !acknowledgeRisk) throw new Error("risky plugin update requires explicit acknowledgement");
    const previousSnapshot = this.componentSnapshots.get(pluginId) ?? this.captureComponents(current); const nextSnapshot = this.captureComponents(Object.freeze({ manifest, tier: manifest.requested_tier, root: resolve(root), state: current.state }));
    const updated = Object.freeze({ manifest, tier: manifest.requested_tier, root: resolve(root), state: current.state }); this.rollbacks.set(pluginId, current); this.rollbackSnapshots.set(pluginId, previousSnapshot); this.componentSnapshots.set(pluginId, nextSnapshot); this.plugins.set(pluginId, updated);
    try { this.syncAllComponents(updated, true); this.persistInstallations(); return updated; } catch (error) { this.plugins.set(pluginId, current); this.rollbacks.delete(pluginId); this.componentSnapshots.set(pluginId, previousSnapshot); this.rollbackSnapshots.delete(pluginId); this.syncAllComponents(current, true); throw error; }
  }

  rollback(pluginId: string, acknowledgeRisk = false): AdmittedPlugin {
    const current = this.required(pluginId); const prior = this.rollbacks.get(pluginId); if (!prior) throw new Error("plugin has no rollback point"); if (requiresAcknowledgement(current) && !acknowledgeRisk) throw new Error("risky plugin rollback requires explicit acknowledgement");
    const priorSnapshot = this.rollbackSnapshots.get(pluginId) ?? this.captureComponents(prior); const currentSnapshot = this.componentSnapshots.get(pluginId) ?? this.captureComponents(current);
    this.plugins.set(pluginId, prior); this.rollbacks.delete(pluginId); this.componentSnapshots.set(pluginId, priorSnapshot); this.rollbackSnapshots.delete(pluginId);
    try { this.syncAllComponents(prior, true); this.persistInstallations(); return prior; } catch (error) { this.plugins.set(pluginId, current); this.rollbacks.set(pluginId, prior); this.componentSnapshots.set(pluginId, currentSnapshot); this.rollbackSnapshots.set(pluginId, priorSnapshot); this.syncAllComponents(current, true); throw error; }
  }

  recordRuntimeCheck(pluginId: string, input: { readonly passed: boolean; readonly observed_capabilities: readonly string[]; readonly evidence_ref: string }): AdmittedPlugin {
    const current = this.required(pluginId); const declared = new Set(current.manifest.capabilities.tools);
    const violation = !input.passed || input.observed_capabilities.some((capability) => !declared.has(capability));
    if (!violation) return current;
    const demotedTier: PluginTrustTier = current.tier === "T4" ? "T3" : current.tier === "T3" ? "T2" : "T1";
    const updated = Object.freeze({ ...current, tier: demotedTier }); this.plugins.set(pluginId, updated); this.record(updated, current.tier, demotedTier, "manifest_violation", [input.evidence_ref]); this.persistInstallations(); return updated;
  }

  private required(pluginId: string): AdmittedPlugin { const value = this.plugins.get(pluginId); if (!value) throw new Error(`plugin ${pluginId} is not admitted`); return value; }
  private syncAllComponents(plugin: AdmittedPlugin, replace: boolean): void { const snapshot = this.componentSnapshots.get(plugin.manifest.plugin_id) ?? this.captureComponents(plugin); this.componentSnapshots.set(plugin.manifest.plugin_id, snapshot); for (const targets of this.componentTargets.get(plugin.manifest.plugin_id) ?? []) this.syncComponents(plugin, targets, replace, snapshot); }
  private syncComponents(plugin: AdmittedPlugin, targets: { readonly commands: CommandCatalog; readonly hooks?: HookCatalog; readonly skills?: SkillCatalog }, replace: boolean, snapshot = this.componentSnapshots.get(plugin.manifest.plugin_id) ?? this.captureComponents(plugin)): void {
    this.componentSnapshots.set(plugin.manifest.plugin_id, snapshot);
    const active = () => this.isActiveRevision(plugin);
    for (const relative of plugin.manifest.components.commands) targets.commands.register(component(snapshot, relative), relative, "plugin", replace, active, plugin.manifest.plugin_id);
    const hookHandlerPaths = plugin.manifest.components.hook_handlers ?? [];
    if (hookHandlerPaths.length > 0) {
      // ADR-111 decision 1/3: hook_handlers requires code_execution, which
      // validateTierAuthority already confines to T4; this is defense in
      // depth against that invariant being violated upstream, not the
      // primary gate.
      if (plugin.tier !== "T4") throw new Error(`plugin '${plugin.manifest.plugin_id}' hook_handlers requires tier T4 (is ${plugin.tier})`);
      if (!targets.hooks) throw new Error("plugin hook target is unavailable");
      targets.hooks.addPluginHandlers(plugin.manifest.plugin_id, loadPluginHookHandlers(plugin.root, plugin.manifest.plugin_id, hookHandlerPaths));
    }
    for (const relative of plugin.manifest.components.hooks) { if (!targets.hooks) throw new Error("plugin hook target is unavailable"); targets.hooks.register(component(snapshot, relative), relative, active, plugin.manifest.plugin_id, replace, plugin.tier); }
    for (const relative of plugin.manifest.components.skills) { if (!targets.skills) throw new Error("plugin skill target is unavailable"); targets.skills.register(component(snapshot, relative), relative, active, plugin.manifest.plugin_id, replace); }
  }
  private captureComponents(plugin: AdmittedPlugin): ReadonlyMap<string, Buffer> { const snapshot = new Map<string, Buffer>(); for (const relative of plugin.manifest.components.commands) snapshot.set(relative, readComponent(plugin.root, relative, ".md")); for (const relative of plugin.manifest.components.hooks) snapshot.set(relative, readComponent(plugin.root, relative, ".json")); for (const relative of plugin.manifest.components.skills) snapshot.set(relative, readComponent(plugin.root, relative, ".json")); return snapshot; }
  private isActiveRevision(plugin: AdmittedPlugin): boolean { const current = this.plugins.get(plugin.manifest.plugin_id); return current !== undefined && current.state === "enabled" && current.manifest === plugin.manifest && current.root === plugin.root && current.tier === plugin.tier; }
  private record(plugin: AdmittedPlugin, previous: PluginTrustTier | null, tier: PluginTrustTier, reason: PluginTierFact["reason"], refs: readonly string[]): void {
    const evidenceRefs = Object.freeze(refs.map((value) => redactNativeText(value).slice(0, 512)));
    const digest = sha256(JSON.stringify({ plugin: plugin.manifest.plugin_id, version: plugin.manifest.version, previous, tier, reason, evidenceRefs }));
    this.ledger.append({ plugin_id: plugin.manifest.plugin_id, version: plugin.manifest.version, previous_tier: previous, tier, reason, evidence_refs: evidenceRefs, provenance: { tag: "verified", cmd: "plugin-registry.verify", exit: 0, stdout_hash: digest, check: { kind: "internal_integrity", breadth: "single" } }, at: this.clock().toISOString() });
  }
  private replayInstallations(): void {
    if (!this.installationsFile || !existsSync(this.installationsFile)) return;
    const value = JSON.parse(readFileSync(this.installationsFile, "utf8")) as unknown;
    if (!Array.isArray(value) || value.length > 64) throw new Error("plugin installation registry is malformed");
    for (const entry of value) {
      if (!entry || typeof entry !== "object") throw new Error("plugin installation registry is malformed");
      const record = entry as { manifest?: unknown; root?: unknown; tier?: unknown; state?: unknown; rollback?: unknown; snapshot?: unknown; rollback_snapshot?: unknown };
      const manifest = parsePluginManifest(JSON.stringify(record.manifest)); verifyPluginManifest(manifest, this.options.trusted_keys);
      if (typeof record.root !== "string" || !["T1", "T2", "T3", "T4"].includes(String(record.tier))) throw new Error("plugin installation registry is malformed");
      validateTierAuthority(manifest, record.tier as PluginTrustTier);
      const state = record.state === undefined ? "enabled" : record.state;
      if (state !== "installed" && state !== "enabled" && state !== "disabled") throw new Error("plugin installation registry is malformed");
      const plugin = Object.freeze({ manifest, root: resolve(record.root), tier: record.tier as PluginTrustTier, state }); this.plugins.set(manifest.plugin_id, plugin);
      if (record.snapshot !== undefined && record.snapshot !== null) this.componentSnapshots.set(manifest.plugin_id, parseSnapshot(record.snapshot));
      if (record.rollback !== undefined && record.rollback !== null) {
        const rollback = record.rollback as { manifest?: unknown; root?: unknown; tier?: unknown; state?: unknown };
        const rollbackManifest = parsePluginManifest(JSON.stringify(rollback.manifest)); verifyPluginManifest(rollbackManifest, this.options.trusted_keys);
        if (typeof rollback.root !== "string" || !["T1", "T2", "T3", "T4"].includes(String(rollback.tier)) || !["installed", "enabled", "disabled"].includes(String(rollback.state)) || rollbackManifest.plugin_id !== manifest.plugin_id) throw new Error("plugin installation rollback is malformed");
        this.rollbacks.set(manifest.plugin_id, Object.freeze({ manifest: rollbackManifest, root: resolve(rollback.root), tier: rollback.tier as PluginTrustTier, state: rollback.state as PluginActivationState }));
        if (record.rollback_snapshot !== undefined && record.rollback_snapshot !== null) this.rollbackSnapshots.set(manifest.plugin_id, parseSnapshot(record.rollback_snapshot));
      }
    }
  }
  private persistInstallations(): void {
    if (!this.installationsFile) return;
    mkdirSync(dirname(this.installationsFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.installationsFile}.tmp`;
    const projection = [...this.plugins.values()].sort((a, b) => a.manifest.plugin_id.localeCompare(b.manifest.plugin_id)).map((plugin) => ({ manifest: plugin.manifest, root: plugin.root, tier: plugin.tier, state: plugin.state, rollback: this.rollbacks.get(plugin.manifest.plugin_id) ?? null, snapshot: serializeSnapshot(this.componentSnapshots.get(plugin.manifest.plugin_id)), rollback_snapshot: serializeSnapshot(this.rollbackSnapshots.get(plugin.manifest.plugin_id)) }));
    writeFileSync(temporary, `${JSON.stringify(projection, null, 2)}\n`, { mode: 0o600 }); renameSync(temporary, this.installationsFile);
  }
}

function requiresAcknowledgement(plugin: Pick<AdmittedPlugin, "manifest">): boolean { const capabilities = plugin.manifest.capabilities; return capabilities.code_execution || capabilities.network || capabilities.filesystem_write || plugin.manifest.components.mcp_servers.length > 0; }
function component(snapshot: ReadonlyMap<string, Buffer>, relative: string): Buffer { const bytes = snapshot.get(relative); if (bytes === undefined) throw new Error("plugin component snapshot is missing"); return bytes; }
function serializeSnapshot(snapshot: ReadonlyMap<string, Buffer> | undefined): Record<string, string> | null { return snapshot === undefined ? null : Object.fromEntries([...snapshot.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => [path, bytes.toString("base64")])); }
function parseSnapshot(value: unknown): ReadonlyMap<string, Buffer> { if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value as object).length > 192) throw new Error("plugin component snapshot is malformed"); const result = new Map<string, Buffer>(); for (const [path, encoded] of Object.entries(value as Record<string, unknown>)) { if (!path || typeof encoded !== "string" || encoded.length > 174_764 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("plugin component snapshot is malformed"); const bytes = Buffer.from(encoded, "base64"); if (bytes.byteLength === 0 || bytes.byteLength > 131_072) throw new Error("plugin component snapshot is malformed"); result.set(path, bytes); } return result; }

function readComponent(root: string, relative: string, extension: string): Buffer { if (!relative.endsWith(extension) || relative.startsWith("/") || relative.includes("\\") || relative.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("plugin component path is unsafe"); const absolute = resolve(root, relative); if (!absolute.startsWith(`${resolve(root)}${sep}`)) throw new Error("plugin component escapes root"); const bytes = readFileSync(absolute); if (bytes.byteLength === 0 || bytes.byteLength > 128 * 1024) throw new Error("plugin component is empty or oversized"); return bytes; }
function sha256(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
