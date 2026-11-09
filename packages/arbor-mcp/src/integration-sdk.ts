import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { redactNativeText, type NativeCredentialLeasePort } from "@arbor/harness";
import { parsePluginManifest, type PluginManifest } from "./extensibility/plugin-manifest.js";
import { PluginRegistry, type AdmittedPlugin } from "./extensibility/plugin-registry.js";
import { createSandboxBroker } from "./sandbox/sandbox-broker.js";
import type { SandboxBroker } from "./sandbox/contracts.js";

export const INSTALLABLE_INTEGRATION_SDK_VERSION = "revoy.integration-sdk.v1" as const;
export type IntegrationSdkHealthState = "healthy" | "degraded" | "unavailable";
export type IntegrationSdkAdapter =
  | Readonly<{ kind: "command_skill"; adapter_id: string; commands: readonly string[]; skills: readonly string[] }>
  | Readonly<{ kind: "mcp"; adapter_id: string; server_id: string; allowed_origins: readonly string[]; path_prefixes: readonly string[] }>;
export interface InstallableIntegrationPackage {
  readonly schema_version: 1;
  readonly sdk_version: typeof INSTALLABLE_INTEGRATION_SDK_VERSION;
  readonly plugin_manifest: PluginManifest;
  readonly adapters: readonly IntegrationSdkAdapter[];
  readonly health: Readonly<{ kind: "host_probe"; timeout_ms: number }>;
  readonly isolation: Readonly<{ kind: "declarative" | "subprocess"; boundary: "no_in_process_code" }>;
}
export interface IntegrationSdkHealth { readonly state: IntegrationSdkHealthState; readonly detail: string; readonly observed_at: string; }
export interface InstallableIntegrationInspection {
  readonly integration_id: string; readonly version: string; readonly state: AdmittedPlugin["state"];
  readonly tier: AdmittedPlugin["tier"]; readonly permissions: PluginManifest["capabilities"];
  readonly adapters: readonly IntegrationSdkAdapter[]; readonly isolation: InstallableIntegrationPackage["isolation"];
  readonly health: IntegrationSdkHealth;
}
export interface InstallableIntegrationSdkOptions {
  readonly registry: PluginRegistry;
  readonly persistence_dir?: string;
  readonly health_probe: (input: { readonly integration_id: string; readonly version: string; readonly root: string; readonly timeout_ms: number; readonly package: InstallableIntegrationPackage }) => IntegrationSdkHealth | Promise<IntegrationSdkHealth>;
  readonly now?: () => Date;
  readonly sandbox?: SandboxBroker;
  readonly credential_for_integration?: (integration_id: string, credential_env: string) => NativeCredentialLeasePort | undefined;
}

type InstalledSdk = { package: InstallableIntegrationPackage; root: string; health: IntegrationSdkHealth; rollback: { package: InstallableIntegrationPackage; root: string } | null };

export class InstallableIntegrationSdk {
  private readonly installed = new Map<string, InstalledSdk>(); private readonly file: string | null; private readonly now: () => Date; private readonly sandbox: SandboxBroker;
  constructor(private readonly options: InstallableIntegrationSdkOptions) { this.file = options.persistence_dir ? join(options.persistence_dir, "integration-sdk-installations.json") : null; this.now = options.now ?? (() => new Date()); this.sandbox = options.sandbox ?? createSandboxBroker(); this.restore(); }

  discover(bytes: Uint8Array | string): InstallableIntegrationPackage { return parseIntegrationPackage(bytes); }
  list(): readonly InstallableIntegrationInspection[] { return Object.freeze([...this.installed.keys()].sort().map((id) => this.inspect(id)!)); }
  inspect(integrationId: string): InstallableIntegrationInspection | null {
    const current = this.installed.get(integrationId); const admitted = this.options.registry.inspect(pluginId(integrationId)); if (!current || !admitted) return null;
    return Object.freeze({ integration_id: integrationId, version: current.package.plugin_manifest.version, state: admitted.state, tier: admitted.tier, permissions: current.package.plugin_manifest.capabilities, adapters: current.package.adapters, isolation: current.package.isolation, health: current.health });
  }
  install(bytes: Uint8Array | string, root: string): InstallableIntegrationInspection {
    const descriptor = this.discover(bytes); const id = integrationId(descriptor); if (this.installed.has(id)) throw new Error(`integration ${id} is already installed`);
    const admitted = this.options.registry.admit(JSON.stringify(descriptor.plugin_manifest), resolve(root));
    const health = frozenHealth("unavailable", "health probe has not run", this.now().toISOString()); this.installed.set(id, { package: descriptor, root: admitted.root, health, rollback: null }); this.persist(); return this.inspect(id)!;
  }
  /**
   * Record metadata after the catalog-owned integration lifecycle has admitted
   * the signed plugin.  This deliberately does not admit or activate anything:
   * PluginRegistry remains the sole lifecycle authority.
   */
  recordCanonicalInstall(bytes: Uint8Array | string, root: string, health?: IntegrationSdkHealth): InstallableIntegrationInspection {
    const descriptor = this.discover(bytes); const id = integrationId(descriptor); if (this.installed.has(id)) throw new Error(`integration ${id} is already installed`);
    this.requireCanonicalPlugin(descriptor, root); const observed = health === undefined ? frozenHealth("unavailable", "health probe has not run", this.now().toISOString()) : validateHealth(health);
    this.installed.set(id, { package: descriptor, root: resolve(root), health: observed, rollback: null }); this.persist(); return this.inspect(id)!;
  }
  /** Record a catalog-owned update, retaining only SDK execution metadata. */
  recordCanonicalUpdate(integrationIdValue: string, bytes: Uint8Array | string, root: string, health: IntegrationSdkHealth): InstallableIntegrationInspection {
    const current = this.required(integrationIdValue); const descriptor = this.discover(bytes);
    if (integrationId(descriptor) !== integrationIdValue) throw new Error("integration update must retain integration identity");
    if (compareVersion(descriptor.plugin_manifest.version, current.package.plugin_manifest.version) <= 0) throw new Error("integration upgrade version must be newer than the installed version");
    this.requireCanonicalPlugin(descriptor, root); this.installed.set(integrationIdValue, { package: descriptor, root: resolve(root), health: validateHealth(health), rollback: { package: current.package, root: current.root } }); this.persist(); return this.inspect(integrationIdValue)!;
  }
  /** Record a catalog-owned rollback without changing the plugin lifecycle. */
  recordCanonicalRollback(integrationIdValue: string): InstallableIntegrationInspection {
    const current = this.required(integrationIdValue); if (!current.rollback) throw new Error("integration has no rollback point");
    this.requireCanonicalPlugin(current.rollback.package, current.rollback.root);
    this.installed.set(integrationIdValue, { package: current.rollback.package, root: current.rollback.root, health: frozenHealth("degraded", "rollback requires a fresh health probe", this.now().toISOString()), rollback: null }); this.persist(); return this.inspect(integrationIdValue)!;
  }
  /** Validate and probe a package before routing its lifecycle command. */
  async probePackage(bytes: Uint8Array | string, root: string): Promise<IntegrationSdkHealth> {
    const descriptor = this.discover(bytes); return this.probeDescriptor(integrationId(descriptor), descriptor, resolve(root));
  }
  async health(integrationIdValue: string): Promise<IntegrationSdkHealth> {
    const current = this.required(integrationIdValue); const health = await this.probeDescriptor(integrationIdValue, current.package, current.root);
    this.installed.set(integrationIdValue, { ...current, health }); this.persist(); return health;
  }
  async enable(integrationIdValue: string, acknowledgeRisk = false): Promise<InstallableIntegrationInspection> {
    const health = await this.health(integrationIdValue); if (health.state !== "healthy") throw new Error(`integration health is ${health.state}: ${health.detail}`);
    this.options.registry.enable(pluginId(integrationIdValue), acknowledgeRisk); this.persist(); return this.inspect(integrationIdValue)!;
  }
  disable(integrationIdValue: string): InstallableIntegrationInspection { this.required(integrationIdValue); this.options.registry.disable(pluginId(integrationIdValue)); this.persist(); return this.inspect(integrationIdValue)!; }
  async upgrade(integrationIdValue: string, bytes: Uint8Array | string, root: string, acknowledgeRisk = false): Promise<InstallableIntegrationInspection> {
    const current = this.required(integrationIdValue); const descriptor = this.discover(bytes); if (integrationId(descriptor) !== integrationIdValue) throw new Error("integration upgrade must retain integration identity");
    if (compareVersion(descriptor.plugin_manifest.version, current.package.plugin_manifest.version) <= 0) throw new Error("integration upgrade version must be newer than the installed version");
    const health = await this.options.health_probe({ integration_id: integrationIdValue, version: descriptor.plugin_manifest.version, root: resolve(root), timeout_ms: descriptor.health.timeout_ms, package: descriptor }); const validated = validateHealth(health); if (validated.state !== "healthy") throw new Error(`upgrade health is ${validated.state}: ${validated.detail}`);
    this.options.registry.update(pluginId(integrationIdValue), JSON.stringify(descriptor.plugin_manifest), resolve(root), acknowledgeRisk);
    this.installed.set(integrationIdValue, { package: descriptor, root: resolve(root), health: validated, rollback: { package: current.package, root: current.root } }); this.persist(); return this.inspect(integrationIdValue)!;
  }
  rollback(integrationIdValue: string, acknowledgeRisk = false): InstallableIntegrationInspection {
    const current = this.required(integrationIdValue); if (!current.rollback) throw new Error("integration has no rollback point"); this.options.registry.rollback(pluginId(integrationIdValue), acknowledgeRisk);
    this.installed.set(integrationIdValue, { package: current.rollback.package, root: current.rollback.root, health: frozenHealth("degraded", "rollback requires a fresh health probe", this.now().toISOString()), rollback: null }); this.persist(); return this.inspect(integrationIdValue)!;
  }
  authorize(integrationIdValue: string, request: { readonly tools?: readonly string[]; readonly code_execution?: boolean; readonly network?: boolean; readonly filesystem_write?: boolean }): { readonly admitted: boolean; readonly reason: string } {
    const inspection = this.inspect(integrationIdValue); if (!inspection || inspection.state !== "enabled" || inspection.health.state !== "healthy") return { admitted: false, reason: "integration is not enabled and healthy" };
    const declared = inspection.permissions; const tools = request.tools ?? [];
    if (tools.some((tool) => !declared.tools.includes(tool)) || request.code_execution === true && !declared.code_execution || request.network === true && !declared.network || request.filesystem_write === true && !declared.filesystem_write) return { admitted: false, reason: "requested permissions exceed the signed manifest" };
    return { admitted: true, reason: "request is within signed permissions and the host-owned health/isolation boundary" };
  }
  executeCommandSkill(integrationIdValue: string, adapterId: string, component: string, args: readonly string[]): string {
    const current = this.required(integrationIdValue); const adapter = current.package.adapters.find((item) => item.kind === "command_skill" && item.adapter_id === adapterId);
    if (!adapter || adapter.kind !== "command_skill" || !adapter.commands.includes(component)) throw new Error("command is outside the signed adapter");
    const admitted = this.authorize(integrationIdValue, {}); if (!admitted.admitted) throw new Error(admitted.reason);
    const file = contained(current.root, component); const template = readFileSync(file, "utf8"); if (Buffer.byteLength(template) > 128 * 1024) throw new Error("command skill is oversized");
    return template.replaceAll("{{args}}", args.join(" "));
  }
  async executeMcpAdapter(integrationIdValue: string, adapterId: string, input: string, signal?: AbortSignal): Promise<string> {
    const current = this.required(integrationIdValue); const adapter = current.package.adapters.find((item) => item.kind === "mcp" && item.adapter_id === adapterId);
    if (!adapter || adapter.kind !== "mcp") throw new Error("MCP adapter is outside the signed package");
    const admitted = this.authorize(integrationIdValue, { code_execution: true }); if (!admitted.admitted) throw new Error(admitted.reason);
    const server = current.package.plugin_manifest.components.mcp_servers.find((item) => item.server_id === adapter.server_id); if (!server || server.transport !== "stdio") throw new Error("executable MCP adapter requires a signed stdio server");
    if (Buffer.byteLength(input) > 64 * 1024) throw new Error("MCP adapter input is oversized");
    if (this.sandbox.confinement !== "os_confined") throw new Error(`OS sandbox unavailable: ${this.sandbox.diagnostic}`);
    const parsedInput = JSON.parse(input) as unknown; assertAdapterDestination(adapter, parsedInput, server.credential_env !== undefined);
    const execute = async (secret: string | null) => this.sandbox.run({ argv: [server.command, ...(server.args ?? [])], cwd: current.root, workspace_root: current.root, workspace_writable: secret === null && current.package.plugin_manifest.capabilities.filesystem_write, network_denied: !current.package.plugin_manifest.capabilities.network, timeout_ms: current.package.health.timeout_ms, max_output_bytes: 64 * 1024, signal: signal ?? new AbortController().signal, stdin: Buffer.from(secret === null ? input : JSON.stringify({ schema_version: 1, request: parsedInput, credential: secret, policy: { allowed_origins: adapter.allowed_origins, path_prefixes: adapter.path_prefixes } })) });
    const lease = server.credential_env === undefined ? undefined : this.options.credential_for_integration?.(integrationIdValue, server.credential_env); if (server.credential_env !== undefined && lease === undefined) throw new Error("declared integration credential is unavailable"); const settled = lease === undefined ? { result: await execute(null), secret: null as string | null } : await lease.inject(async (secret) => ({ result: await execute(secret), secret })); const result = settled.result;
    if (result.kind !== "exited" || result.exit !== 0 || result.confinement !== "os_confined") throw new Error(result.kind === "exited" ? redactNativeText(result.stderr.toString("utf8") || `MCP adapter exited ${result.exit}`, { secrets: settled.secret === null ? [] : [settled.secret] }) : `sandboxed MCP adapter ${result.kind}`);
    return redactNativeText(result.stdout.toString("utf8"), { secrets: settled.secret === null ? [] : [settled.secret] });
  }
  private required(id: string): InstalledSdk { const value = this.installed.get(id); if (!value) throw new Error(`integration ${id} is not installed`); return value; }
  private requireCanonicalPlugin(descriptor: InstallableIntegrationPackage, root: string): void {
    const admitted = this.options.registry.inspect(descriptor.plugin_manifest.plugin_id);
    if (!admitted || admitted.manifest.version !== descriptor.plugin_manifest.version || admitted.root !== resolve(root)) throw new Error("catalog-owned integration lifecycle is not reflected in the plugin registry");
  }
  private async probeDescriptor(integrationIdValue: string, descriptor: InstallableIntegrationPackage, root: string): Promise<IntegrationSdkHealth> {
    let observed: IntegrationSdkHealth;
    try { observed = await this.options.health_probe({ integration_id: integrationIdValue, version: descriptor.plugin_manifest.version, root, timeout_ms: descriptor.health.timeout_ms, package: descriptor }); }
    catch (error) { observed = frozenHealth("unavailable", error instanceof Error ? error.message : "health probe failed", this.now().toISOString()); }
    return validateHealth(observed);
  }
  private restore(): void { if (!this.file || !existsSync(this.file)) return; const value = JSON.parse(readFileSync(this.file, "utf8")) as unknown; if (!Array.isArray(value) || value.length > 64) throw new Error("integration SDK store is malformed"); for (const item of value as Array<{ package: unknown; root: string; health: IntegrationSdkHealth; rollback: { package: unknown; root: string } | null }>) { const descriptor = validatePackageValue(item.package); const id = integrationId(descriptor); if (!this.options.registry.inspect(pluginId(id)) || this.installed.has(id)) throw new Error("integration SDK store does not match the plugin registry"); this.installed.set(id, { package: descriptor, root: resolve(item.root), health: validateHealth(item.health), rollback: item.rollback ? { package: validatePackageValue(item.rollback.package), root: resolve(item.rollback.root) } : null }); } }
  private persist(): void { if (!this.file) return; mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 }); const temporary = `${this.file}.tmp`; const rows = [...this.installed].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value); writeFileSync(temporary, `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 }); renameSync(temporary, this.file); }
}

export function commandSkillIntegrationAdapter(adapterId: string, commands: readonly string[], skills: readonly string[]): IntegrationSdkAdapter { return Object.freeze({ kind: "command_skill", adapter_id: safeAdapterId(adapterId), commands: Object.freeze([...commands]), skills: Object.freeze([...skills]) }); }
export function mcpIntegrationAdapter(adapterId: string, serverId: string, allowedOrigins: readonly string[] = [], pathPrefixes: readonly string[] = []): IntegrationSdkAdapter { return Object.freeze({ kind: "mcp", adapter_id: safeAdapterId(adapterId), server_id: safeAdapterId(serverId), allowed_origins: Object.freeze([...allowedOrigins]), path_prefixes: Object.freeze([...pathPrefixes]) }); }

export function parseIntegrationPackage(bytes: Uint8Array | string): InstallableIntegrationPackage { const raw = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes); if (raw.byteLength === 0 || raw.byteLength > 256 * 1024) throw new Error("integration package manifest is empty or oversized"); let value: unknown; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { throw new Error("integration package manifest is not valid UTF-8 JSON"); } return validatePackageValue(value); }
export async function probeInstallableIntegrationHealth(input: { readonly integration_id: string; readonly root: string; readonly package: InstallableIntegrationPackage; readonly timeout_ms: number; readonly sandbox?: SandboxBroker; readonly now?: () => Date }): Promise<IntegrationSdkHealth> { const observed = (input.now ?? (() => new Date()))().toISOString(); try { if (input.package.isolation.kind === "declarative") { for (const adapter of input.package.adapters) if (adapter.kind === "command_skill") for (const component of [...adapter.commands, ...adapter.skills]) if (!existsSync(contained(resolve(input.root), component))) return frozenHealth("unavailable", `signed component ${component} is unavailable`, observed); return frozenHealth("healthy", "all signed declarative components are readable", observed); } const sandbox = input.sandbox ?? createSandboxBroker(); if (sandbox.confinement !== "os_confined") return frozenHealth("unavailable", `OS sandbox unavailable: ${sandbox.diagnostic}`, observed); const adapter = input.package.adapters.find((item) => item.kind === "mcp"); if (!adapter || adapter.kind !== "mcp") return frozenHealth("unavailable", "subprocess package has no MCP health adapter", observed); const server = input.package.plugin_manifest.components.mcp_servers.find((item) => item.server_id === adapter.server_id); if (!server || server.transport !== "stdio") return frozenHealth("unavailable", "health probe requires a signed stdio adapter", observed); const result = await sandbox.run({ argv: [server.command, ...(server.args ?? [])], cwd: resolve(input.root), workspace_root: resolve(input.root), workspace_writable: false, network_denied: true, timeout_ms: input.timeout_ms, max_output_bytes: 16 * 1024, signal: new AbortController().signal, stdin: Buffer.from("{}") }); return result.kind === "exited" && result.exit === 0 && result.confinement === "os_confined" ? frozenHealth("healthy", "sandboxed adapter health probe exited successfully", observed) : frozenHealth("unavailable", `sandboxed adapter health probe ${result.kind}`, observed); } catch (error) { return frozenHealth("unavailable", error instanceof Error ? error.message : "health probe failed", observed); } }
function validatePackageValue(value: unknown): InstallableIntegrationPackage {
  if (!plain(value) || !exact(value, ["schema_version", "sdk_version", "plugin_manifest", "adapters", "health", "isolation"]) || value.schema_version !== 1 || value.sdk_version !== INSTALLABLE_INTEGRATION_SDK_VERSION) throw new Error("integration package schema is invalid");
  const manifest = parsePluginManifest(JSON.stringify(value.plugin_manifest)); if (!Array.isArray(value.adapters) || value.adapters.length === 0 || value.adapters.length > 16) throw new Error("integration adapters are invalid"); const adapters = value.adapters.map((adapter) => validateAdapter(adapter, manifest));
  if (!plain(value.health) || !exact(value.health, ["kind", "timeout_ms"]) || value.health.kind !== "host_probe" || !Number.isSafeInteger(value.health.timeout_ms) || Number(value.health.timeout_ms) < 100 || Number(value.health.timeout_ms) > 60_000) throw new Error("integration health contract is invalid");
  if (!plain(value.isolation) || !exact(value.isolation, ["kind", "boundary"]) || (value.isolation.kind !== "declarative" && value.isolation.kind !== "subprocess") || value.isolation.boundary !== "no_in_process_code") throw new Error("integration isolation contract is invalid");
  const risky = manifest.capabilities.code_execution || manifest.capabilities.network || manifest.components.mcp_servers.length > 0; if (risky && value.isolation.kind !== "subprocess") throw new Error("executable, network, and MCP integrations require subprocess isolation"); if (!risky && adapters.every((adapter) => adapter.kind === "command_skill") && value.isolation.kind !== "declarative") throw new Error("command/skill-only integrations use declarative isolation");
  return Object.freeze({ schema_version: 1, sdk_version: INSTALLABLE_INTEGRATION_SDK_VERSION, plugin_manifest: manifest, adapters: Object.freeze(adapters), health: Object.freeze({ kind: "host_probe", timeout_ms: Number(value.health.timeout_ms) }), isolation: Object.freeze({ kind: value.isolation.kind as "declarative" | "subprocess", boundary: "no_in_process_code" }) });
}
function validateAdapter(value: unknown, manifest: PluginManifest): IntegrationSdkAdapter { if (!plain(value) || typeof value.adapter_id !== "string") throw new Error("integration adapter is invalid"); const id = safeAdapterId(value.adapter_id); if (value.kind === "command_skill" && exact(value, ["kind", "adapter_id", "commands", "skills"]) && strings(value.commands) && strings(value.skills) && value.commands.every((path) => manifest.components.commands.includes(path)) && value.skills.every((path) => manifest.components.skills.includes(path))) return commandSkillIntegrationAdapter(id, value.commands, value.skills); if (value.kind === "mcp" && exact(value, ["kind", "adapter_id", "server_id", "allowed_origins", "path_prefixes"]) && typeof value.server_id === "string" && strings(value.allowed_origins) && strings(value.path_prefixes) && (value.allowed_origins as string[]).every(validOrigin) && (value.path_prefixes as string[]).every((path) => path.startsWith("/") && !path.includes("..")) && manifest.requested_tier === "T4" && manifest.components.mcp_servers.some((server) => server.server_id === value.server_id && (server.credential_env === undefined || (value.allowed_origins as string[]).length > 0))) return mcpIntegrationAdapter(id, value.server_id, value.allowed_origins as string[], value.path_prefixes as string[]); throw new Error("integration adapter exceeds signed plugin components or tier"); }
function validateHealth(value: IntegrationSdkHealth): IntegrationSdkHealth { if (!value || !["healthy", "degraded", "unavailable"].includes(value.state) || typeof value.detail !== "string" || !Number.isFinite(Date.parse(value.observed_at))) throw new Error("integration health result is invalid"); return frozenHealth(value.state, value.detail, value.observed_at); }
function frozenHealth(state: IntegrationSdkHealthState, detail: string, observedAt: string): IntegrationSdkHealth { return Object.freeze({ state, detail: redactNativeText(detail).slice(0, 512), observed_at: observedAt }); }
function integrationId(descriptor: InstallableIntegrationPackage): string { return `extension.${descriptor.plugin_manifest.plugin_id}`; } function pluginId(id: string): string { if (!id.startsWith("extension.")) throw new Error("integration id must use extension.<plugin-id>"); return id.slice(10); }
function safeAdapterId(value: string): string { if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)) throw new Error("adapter_id is invalid"); return value; }
function plain(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); } function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value).sort(); const expected = [...keys].sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]); } function strings(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 64 && new Set(value).size === value.length && value.every((item) => typeof item === "string" && item.length > 0 && Buffer.byteLength(item) <= 1024); }
function contained(root: string, component: string): string { const target = resolve(root, component); const rel = relative(root, target); if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("integration component escapes its root"); return target; }
function validOrigin(value: string): boolean { try { const url = new URL(value); return url.protocol === "https:" && url.origin === value && !url.username && !url.password; } catch { return false; } }
function compareVersion(left: string, right: string): number { const a = left.split(".").map(Number); const b = right.split(".").map(Number); for (let index = 0; index < 3; index += 1) { const delta = (a[index] ?? 0) - (b[index] ?? 0); if (delta !== 0) return delta; } return 0; }
function assertAdapterDestination(adapter: Extract<IntegrationSdkAdapter, { kind: "mcp" }>, input: unknown, required: boolean): void { if (!plain(input) || typeof input.endpoint !== "string") { if (required) throw new Error("credentialed adapter requests require a signed destination"); return; } const url = new URL(input.endpoint); if (!adapter.allowed_origins.includes(url.origin) || adapter.path_prefixes.length > 0 && !adapter.path_prefixes.some((prefix) => url.pathname === prefix || url.pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))) throw new Error("adapter destination is outside the signed origin/route policy"); }
