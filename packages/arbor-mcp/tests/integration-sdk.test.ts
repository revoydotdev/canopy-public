import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalPluginPayload, type PluginManifest } from "../src/extensibility/plugin-manifest.js";
import { PluginRegistry } from "../src/extensibility/plugin-registry.js";
import { InstallableIntegrationSdk, INSTALLABLE_INTEGRATION_SDK_VERSION, commandSkillIntegrationAdapter, parseIntegrationPackage } from "../src/integration-sdk.js";
import { RUNTIME_CATALOG } from "../src/runtime-catalog.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(version = "1.0.0") {
  const root = mkdtempSync(join(tmpdir(), `arbor-sdk-${version.replaceAll(".", "-")}-`)); roots.push(root); mkdirSync(join(root, "commands")); writeFileSync(join(root, "commands", "review.md"), "Review {{args}}\n");
  const keys = generateKeyPairSync("ed25519"); const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const unsigned = { schema_version: 1 as const, plugin_id: "review-helper", version, source: { kind: "path" as const, path: root }, requested_tier: "T1" as const, capabilities: { tools: [], code_execution: false, network: false, filesystem_write: false }, components: { commands: ["commands/review.md"], hooks: [], skills: [], mcp_servers: [] }, verification: { G1: "audit://sdk/g1" } };
  const provisional = { ...unsigned, signature: { algorithm: "ed25519" as const, key_id: "sdk-key", value: "" } };
  const manifest: PluginManifest = { ...provisional, signature: { ...provisional.signature, value: sign(null, canonicalPluginPayload(provisional), keys.privateKey).toString("base64") } };
  const descriptor = { schema_version: 1, sdk_version: INSTALLABLE_INTEGRATION_SDK_VERSION, plugin_manifest: manifest, adapters: [commandSkillIntegrationAdapter("review-command", ["commands/review.md"], [])], health: { kind: "host_probe", timeout_ms: 1000 }, isolation: { kind: "declarative", boundary: "no_in_process_code" } };
  return { root, publicKey, privateKey: keys.privateKey, bytes: JSON.stringify(descriptor) };
}

describe("installable integration and skill SDK", () => {
  it("discovers a signed versioned package, gates permissions/health, upgrades, rolls back, and restores lifecycle state", async () => {
    const first = fixture("1.0.0"); const persistence = mkdtempSync(join(tmpdir(), "arbor-sdk-state-")); roots.push(persistence);
    const registry = new PluginRegistry({ trusted_keys: new Map([["sdk-key", first.publicKey]]), persistence_dir: persistence, clock: () => new Date("2026-08-20T00:00:00.000Z") });
    const sdk = new InstallableIntegrationSdk({ registry, persistence_dir: persistence, now: () => new Date("2026-08-20T00:00:00.000Z"), health_probe: ({ version }) => ({ state: "healthy", detail: `version ${version} responds`, observed_at: "2026-08-20T00:00:00.000Z" }) });
    expect(sdk.discover(first.bytes)).toMatchObject({ schema_version: 1, sdk_version: INSTALLABLE_INTEGRATION_SDK_VERSION, isolation: { kind: "declarative", boundary: "no_in_process_code" } });
    expect(sdk.install(first.bytes, first.root)).toMatchObject({ integration_id: "extension.review-helper", version: "1.0.0", state: "installed", health: { state: "unavailable" } });
    expect(sdk.authorize("extension.review-helper", {})).toMatchObject({ admitted: false });
    await expect(sdk.enable("extension.review-helper")).resolves.toMatchObject({ state: "enabled", health: { state: "healthy" } });
    expect(sdk.authorize("extension.review-helper", { tools: [] })).toMatchObject({ admitted: true });
    expect(sdk.authorize("extension.review-helper", { network: true })).toMatchObject({ admitted: false, reason: expect.stringContaining("signed manifest") });

    const secondRoot = mkdtempSync(join(tmpdir(), "arbor-sdk-1-1-0-")); roots.push(secondRoot); mkdirSync(join(secondRoot, "commands")); writeFileSync(join(secondRoot, "commands", "review.md"), "Review carefully {{args}}\n");
    const keys = generateKeyPairSync("ed25519");
    // The update must remain under the installed trusted identity. Build a
    // second registry fixture with a stable key rather than weakening trust.
    const stablePrivate = keys.privateKey; const stablePublic = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const updatePersistence = mkdtempSync(join(tmpdir(), "arbor-sdk-update-")); roots.push(updatePersistence);
    const signed = (version: string, root: string) => { const base = { schema_version: 1 as const, plugin_id: "stable-helper", version, source: { kind: "path" as const, path: root }, requested_tier: "T1" as const, capabilities: { tools: [], code_execution: false, network: false, filesystem_write: false }, components: { commands: ["commands/review.md"], hooks: [], skills: [], mcp_servers: [] }, verification: { G1: "audit://sdk/g1" } }; const provisional = { ...base, signature: { algorithm: "ed25519" as const, key_id: "stable", value: "" } }; const manifest = { ...provisional, signature: { ...provisional.signature, value: sign(null, canonicalPluginPayload(provisional), stablePrivate).toString("base64") } }; return JSON.stringify({ schema_version: 1, sdk_version: INSTALLABLE_INTEGRATION_SDK_VERSION, plugin_manifest: manifest, adapters: [{ kind: "command_skill", adapter_id: "stable-command", commands: ["commands/review.md"], skills: [] }], health: { kind: "host_probe", timeout_ms: 1000 }, isolation: { kind: "declarative", boundary: "no_in_process_code" } }); };
    const stableRoot = mkdtempSync(join(tmpdir(), "arbor-sdk-stable-")); roots.push(stableRoot); mkdirSync(join(stableRoot, "commands")); writeFileSync(join(stableRoot, "commands", "review.md"), "v1\n");
    const stableRegistry = new PluginRegistry({ trusted_keys: new Map([["stable", stablePublic]]), persistence_dir: updatePersistence }); const stableSdk = new InstallableIntegrationSdk({ registry: stableRegistry, persistence_dir: updatePersistence, health_probe: () => ({ state: "healthy", detail: "ready", observed_at: "2026-08-20T00:00:00.000Z" }) });
    stableSdk.install(signed("1.0.0", stableRoot), stableRoot); await stableSdk.enable("extension.stable-helper");
    await expect(stableSdk.upgrade("extension.stable-helper", signed("1.0.0", stableRoot), stableRoot)).rejects.toThrow(/newer/);
    await expect(stableSdk.upgrade("extension.stable-helper", signed("1.1.0", secondRoot), secondRoot)).resolves.toMatchObject({ version: "1.1.0" });
    expect(stableSdk.rollback("extension.stable-helper")).toMatchObject({ version: "1.0.0", health: { state: "degraded" } });
    const restoredRegistry = new PluginRegistry({ trusted_keys: new Map([["stable", stablePublic]]), persistence_dir: updatePersistence }); const restored = new InstallableIntegrationSdk({ registry: restoredRegistry, persistence_dir: updatePersistence, health_probe: () => ({ state: "healthy", detail: "ready", observed_at: "2026-08-20T00:00:00.000Z" }) });
    expect(restored.inspect("extension.stable-helper")).toMatchObject({ version: "1.0.0", state: "enabled", isolation: { boundary: "no_in_process_code" } });
  });

  it("rejects adapter/component escalation and keeps catalog plus CLI lifecycle reachable", () => {
    const value = JSON.parse(fixture().bytes); value.adapters[0].commands = ["commands/not-signed.md"];
    expect(() => parseIntegrationPackage(JSON.stringify(value))).toThrow("adapter exceeds signed plugin components");
    expect(RUNTIME_CATALOG.filter((entry) => entry.kind.startsWith("integration.")).map((entry) => entry.kind)).toEqual(expect.arrayContaining(["integration.install", "integration.enable", "integration.disable", "integration.update", "integration.rollback", "integration.inspect"]));
    const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8"); expect(cli).toContain('if (args[0] === "integration" || args[0] === "remote")'); expect(cli).toContain('if (args[0] === "plugin")'); expect(cli).toContain('rollback: "integration.rollback"');
  });

  it("does not record SDK install, update, or rollback metadata before the catalog-owned registry transition", async () => {
    const first = fixture(); const persistence = mkdtempSync(join(tmpdir(), "arbor-sdk-catalog-refusal-")); roots.push(persistence);
    const trusted = new Map([["sdk-key", first.publicKey]]); const rejected = new InstallableIntegrationSdk({ registry: new PluginRegistry({ trusted_keys: trusted, persistence_dir: persistence }), persistence_dir: persistence, health_probe: () => ({ state: "healthy", detail: "ready", observed_at: "2026-08-20T00:00:00.000Z" }) });
    await expect(Promise.resolve().then(() => rejected.recordCanonicalInstall(first.bytes, first.root))).rejects.toThrow("catalog-owned integration lifecycle"); expect(existsSync(join(persistence, "integration-sdk-installations.json"))).toBe(false);

    const registry = new PluginRegistry({ trusted_keys: trusted, persistence_dir: persistence }); const sdk = new InstallableIntegrationSdk({ registry, persistence_dir: persistence, health_probe: () => ({ state: "healthy", detail: "ready", observed_at: "2026-08-20T00:00:00.000Z" }) }); sdk.install(first.bytes, first.root); await sdk.enable("extension.review-helper");
    const nextRoot = mkdtempSync(join(tmpdir(), "arbor-sdk-catalog-next-")); roots.push(nextRoot); mkdirSync(join(nextRoot, "commands")); writeFileSync(join(nextRoot, "commands", "review.md"), "Review v2 {{args}}\n"); const next = JSON.parse(first.bytes); const provisional = { ...next.plugin_manifest, version: "1.1.0", source: { ...next.plugin_manifest.source, path: nextRoot }, signature: { ...next.plugin_manifest.signature, value: "" } }; next.plugin_manifest = { ...provisional, signature: { ...provisional.signature, value: sign(null, canonicalPluginPayload(provisional), first.privateKey).toString("base64") } }; const nextBytes = JSON.stringify(next);
    const beforeUpdate = readFileSync(join(persistence, "integration-sdk-installations.json"), "utf8"); expect(() => sdk.recordCanonicalUpdate("extension.review-helper", nextBytes, nextRoot, { state: "healthy", detail: "ready", observed_at: "2026-08-20T00:00:00.000Z" })).toThrow("catalog-owned integration lifecycle"); expect(readFileSync(join(persistence, "integration-sdk-installations.json"), "utf8")).toBe(beforeUpdate);
    await sdk.upgrade("extension.review-helper", nextBytes, nextRoot); const beforeRollback = readFileSync(join(persistence, "integration-sdk-installations.json"), "utf8"); expect(() => sdk.recordCanonicalRollback("extension.review-helper")).toThrow("catalog-owned integration lifecycle"); expect(readFileSync(join(persistence, "integration-sdk-installations.json"), "utf8")).toBe(beforeRollback);
  });
});
