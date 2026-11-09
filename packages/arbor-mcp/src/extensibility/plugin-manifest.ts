import { createPublicKey, verify } from "node:crypto";
import type { McpServerConfig } from "../mcp-client/contracts.js";

export type PluginTrustTier = "T1" | "T2" | "T3" | "T4";
export type PluginGate = "G1" | "G2" | "G3" | "G4";
export type PluginSource =
  | Readonly<{ kind: "path"; path: string }>
  | Readonly<{ kind: "github"; repository: string; ref: string }>
  | Readonly<{ kind: "git-subdir"; repository: string; ref: string; subdir: string }>;

export interface PluginManifest {
  readonly schema_version: 1;
  readonly plugin_id: string;
  readonly version: string;
  readonly source: PluginSource;
  readonly requested_tier: PluginTrustTier;
  readonly capabilities: Readonly<{ tools: readonly string[]; code_execution: boolean; network: boolean; filesystem_write: boolean }>;
  readonly components: Readonly<{
    commands: readonly string[];
    hooks: readonly string[];
    /**
     * ADR-111 decision 1: CommonJS (`.cjs`) modules under the plugin's root,
     * each exporting the named functions a `hooks` descriptor's
     * `handler_ref` may resolve to via `PluginRegistry`'s hook-handler
     * loader. Optional and empty by default so every manifest signed before
     * this field existed still parses unchanged. Declaring one requires
     * `capabilities.code_execution: true`, which `validateTierAuthority`
     * already restricts to `T4`.
     */
    hook_handlers?: readonly string[];
    skills: readonly string[];
    mcp_servers: readonly McpServerConfig[];
  }>;
  readonly verification: Readonly<Partial<Record<PluginGate, string>>>;
  readonly signature: Readonly<{ algorithm: "ed25519"; key_id: string; value: string }>;
}

export class PluginManifestError extends Error {
  constructor(readonly code: "malformed" | "signature" | "gate" | "tier_violation", message: string) { super(message); this.name = "PluginManifestError"; }
}

export function parsePluginManifest(bytes: Uint8Array | string): PluginManifest {
  const raw = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
  if (raw.byteLength === 0 || raw.byteLength > 128 * 1024) throw new PluginManifestError("malformed", "plugin manifest is empty or oversized");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { throw new PluginManifestError("malformed", "plugin manifest is not valid UTF-8 JSON"); }
  if (!plain(value) || value.schema_version !== 1 || !id(value.plugin_id) || !semver(value.version) || !source(value.source)
    || !tier(value.requested_tier) || !capabilities(value.capabilities) || !components(value.components)
    || !verification(value.verification) || !signature(value.signature)) throw new PluginManifestError("malformed", "plugin manifest shape is invalid");
  return deepFreeze(value as unknown as PluginManifest);
}

export function canonicalPluginPayload(manifest: PluginManifest): Buffer {
  const { signature: _signature, ...unsigned } = manifest;
  return Buffer.from(canonical(unsigned), "utf8");
}

export function verifyPluginManifest(manifest: PluginManifest, trustedKeys: ReadonlyMap<string, string>): void {
  const pem = trustedKeys.get(manifest.signature.key_id);
  if (pem === undefined) throw new PluginManifestError("signature", "plugin signing key is not trusted");
  let signatureBytes: Buffer;
  try { signatureBytes = Buffer.from(manifest.signature.value, "base64"); } catch { throw new PluginManifestError("signature", "plugin signature is malformed"); }
  if (signatureBytes.byteLength !== 64 || !verify(null, canonicalPluginPayload(manifest), createPublicKey(pem), signatureBytes)) throw new PluginManifestError("signature", "plugin signature verification failed");
}

export const TIER_REQUIRED_GATES: Readonly<Record<PluginTrustTier, readonly PluginGate[]>> = Object.freeze({
  T1: Object.freeze(["G1"] as PluginGate[]), T2: Object.freeze(["G1", "G2"] as PluginGate[]), T3: Object.freeze(["G1", "G2", "G3"] as PluginGate[]), T4: Object.freeze(["G1", "G2", "G3", "G4"] as PluginGate[]),
});

export function validateTierAuthority(manifest: PluginManifest, tierValue = manifest.requested_tier): void {
  for (const gate of TIER_REQUIRED_GATES[tierValue]) if (!manifest.verification[gate]?.trim()) throw new PluginManifestError("gate", `${tierValue} requires ${gate} evidence`);
  const { code_execution: code, network, filesystem_write: writes } = manifest.capabilities;
  // ADR-111 decision 1: hook_handlers modules are code the harness loads and
  // calls in-process, so declaring any requires the signed code_execution
  // capability — which the checks below already confine to T4.
  if ((manifest.components.hook_handlers?.length ?? 0) > 0 && !code) throw new PluginManifestError("tier_violation", "hook_handlers requires capabilities.code_execution");
  if (tierValue === "T1" && (manifest.capabilities.tools.length > 0 || code || network || writes || manifest.components.hooks.length > 0 || manifest.components.skills.length > 0 || manifest.components.mcp_servers.length > 0)) throw new PluginManifestError("tier_violation", "T1 plugins are instruction-only commands");
  if (tierValue === "T2" && (code || network || writes || manifest.components.mcp_servers.length > 0)) throw new PluginManifestError("tier_violation", "T2 plugins cannot execute code, write, use network, or supply MCP servers");
  if (tierValue === "T3" && (code || network)) throw new PluginManifestError("tier_violation", "T3 plugins cannot execute code or use network");
  if (manifest.components.mcp_servers.length > 0 && tierValue !== "T4") throw new PluginManifestError("tier_violation", "plugin MCP servers require T4 host and transport vetting");
  if (manifest.capabilities.tools.length > 64 || new Set(manifest.capabilities.tools).size !== manifest.capabilities.tools.length) throw new PluginManifestError("malformed", "plugin tool capability list is invalid");
}

function plain(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function id(value: unknown): value is string { return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value); }
function semver(value: unknown): value is string { return typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value); }
function tier(value: unknown): value is PluginTrustTier { return value === "T1" || value === "T2" || value === "T3" || value === "T4"; }
function strings(value: unknown, max = 64): value is string[] { return Array.isArray(value) && value.length <= max && new Set(value).size === value.length && value.every((item) => typeof item === "string" && item.length > 0 && Buffer.byteLength(item) <= 1024); }
function source(value: unknown): value is PluginSource { return plain(value) && ((value.kind === "path" && typeof value.path === "string") || (value.kind === "github" && typeof value.repository === "string" && typeof value.ref === "string") || (value.kind === "git-subdir" && typeof value.repository === "string" && typeof value.ref === "string" && typeof value.subdir === "string")); }
function capabilities(value: unknown): boolean { return plain(value) && strings(value.tools) && typeof value.code_execution === "boolean" && typeof value.network === "boolean" && typeof value.filesystem_write === "boolean"; }
function components(value: unknown): boolean { return plain(value) && strings(value.commands) && strings(value.hooks) && (value.hook_handlers === undefined || strings(value.hook_handlers)) && strings(value.skills) && Array.isArray(value.mcp_servers) && value.mcp_servers.length <= 16; }
function verification(value: unknown): boolean { return plain(value) && Object.keys(value).every((key) => ["G1", "G2", "G3", "G4"].includes(key) && typeof value[key] === "string" && Buffer.byteLength(value[key] as string) <= 1024); }
function signature(value: unknown): boolean { return plain(value) && value.algorithm === "ed25519" && typeof value.key_id === "string" && value.key_id.length <= 128 && typeof value.value === "string" && value.value.length <= 256; }
function canonical(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested); Object.freeze(value); } return value; }
