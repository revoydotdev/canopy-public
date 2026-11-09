import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import type { InstallableIntegrationInspection, InstallableIntegrationSdk } from "./integration-sdk.js";

export interface LocalIntegrationRegistryEntry { readonly integration_id: string; readonly package_file: string; readonly root: string; }
export interface PreparedLocalIntegration { readonly integration_id: string; readonly package_bytes: Uint8Array; readonly root: string; }
export class LocalIntegrationRegistry {
  private readonly entries: readonly LocalIntegrationRegistryEntry[];
  constructor(readonly index_file: string) {
    const base = dirname(resolve(index_file)); const value = JSON.parse(readFileSync(index_file, "utf8")) as unknown;
    if (!plain(value) || value.schema_version !== 1 || !Array.isArray(value.packages) || value.packages.length > 256) throw new Error("local integration registry is malformed");
    const ids = new Set<string>(); this.entries = Object.freeze(value.packages.map((item) => {
      if (!plain(item) || Object.keys(item).sort().join(",") !== "integration_id,package_file,root" || typeof item.integration_id !== "string" || typeof item.package_file !== "string" || typeof item.root !== "string" || ids.has(item.integration_id)) throw new Error("local integration registry entry is malformed");
      ids.add(item.integration_id); return Object.freeze({ integration_id: item.integration_id, package_file: contained(base, item.package_file), root: contained(base, item.root) });
    }));
  }
  list(): readonly LocalIntegrationRegistryEntry[] { return this.entries; }
  prepare(sdk: InstallableIntegrationSdk, integrationId: string): PreparedLocalIntegration { const entry = this.entries.find((item) => item.integration_id === integrationId); if (!entry) throw new Error(`integration ${integrationId} is absent from the local registry`); const package_bytes = readFileSync(entry.package_file); const descriptor = sdk.discover(package_bytes); if (`extension.${descriptor.plugin_manifest.plugin_id}` !== integrationId) throw new Error("local registry identity does not match the signed package"); return Object.freeze({ integration_id: integrationId, package_bytes, root: entry.root }); }
  install(sdk: InstallableIntegrationSdk, integrationId: string): InstallableIntegrationInspection { const prepared = this.prepare(sdk, integrationId); return sdk.install(prepared.package_bytes, prepared.root); }
}
function contained(base: string, path: string): string { const target = resolve(base, path); const rel = relative(base, target); if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("local integration registry path escapes its root"); return target; }
function plain(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
