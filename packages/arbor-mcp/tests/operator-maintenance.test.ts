import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigInspectionService } from "../src/config-inspection.js";
import { applyMigration, buildUnifiedDoctor, inspectMigration, previewMigration, rollbackMigration } from "../src/operator-maintenance.js";
import type { NativeHarnessReadinessProjection } from "../src/native-harness-readiness.js";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";

const roots: string[] = [];
const root = (): string => { const value = mkdtempSync(join(tmpdir(), "arbor-maintenance-")); roots.push(value); return value; };
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const integration = { integration_id: "fixture", executable_present: true, authenticated: true, detail: "fixture integration is authenticated" } as const;

function readinessFixture(execution: NativeHarnessReadinessProjection["execution"], mode: NativeHarnessReadinessProjection["selection"]["mode"]): NativeHarnessReadinessProjection {
  return {
    execution,
    config_sources: { defaults_present: true, file_present: false, env_present: false, injected_present: false, native: {} },
    selection: { mode, auth_route: mode === "native" ? "provider_api" : null, adapter_id: "openai-compatible", provider_id: "openai", model_id: "gpt-5", endpoint_configured: true },
    adapter: { adapter_id: "openai-compatible", availability: "available", implementation_id: "openai-compatible-adapter", transport: "http" },
    credential: { required: true, present: execution.kind === "direct_native", source: execution.kind === "direct_native" ? "env" : "absent", authentication_owner: "canopy_credential_source", env_var: "ARBOR_NATIVE_API_KEY", file_path: null, mechanism: "api_key", state: execution.kind === "direct_native" ? "present" : "absent" },
    model_revision: { configured: null, readiness: "unpinned" },
    pricing: { readiness: "not_configured", price_source_id: null, matches_selected_model: null },
    budget: { readiness: "not_configured", cache_estimate: "not_configured", session_limits_configured: false, campaign_limits_configured: false },
    missing_requirements: [],
  };
}

describe("unified operator doctor", () => {
  it("is versioned, local-only, secret-free, and makes image input actionable only from explicit configuration", () => {
    const cwd = root();
    const config = new ConfigInspectionService({ defaults: { native: { capabilities: { image_input: false } } } as never, injected: { native: { capabilities: { image_input: true } } } as never }).inspect();
    const report = buildUnifiedDoctor({ cwd, persistence_dir: join(cwd, ".arbor"), config, readiness: null, integration, connectors: [{ connector_id: "fixture", status: "ready", capabilities: ["tool_calls"], detail: "in-process" }], operational: { integrations: [{ id: "extension.fixture", kind: "extension", state: "enabled", health: "ready", detail: "healthy", permissions: [], dependencies: [], handoff: { kind: "command", value: "arbor extension inspect fixture" } }], remote: { composed: true, registered_sessions: 2, detail: "authority composed" }, scheduler: { composed: true, schedules: 3, active: 2, human_required: 1, runs: 7, detail: "scheduler composed" }, sessions: { source_available: true, known: 4, live: 1, detail: "continuity ready" } } });
    expect(report).toMatchObject({ schema_version: 2, probe_scope: { local_only: true, network: "not_run", credential_values: "never_read" }, configured: { models: [{ image_input: { configured: true, actionable: false, source: "injected" } }] }, tools_and_connectors: [{ connector_id: "fixture", status: "ready" }], operational: { extensions: { status: "ready", total: 1, enabled: 1, unhealthy: 0 }, remote: { status: "ready", registered_sessions: 2 }, scheduler: { status: "attention", schedules: 3, active: 2, human_required: 1, runs: 7 }, sessions: { status: "ready", known: 4, live: 1 } } });
    expect(JSON.stringify(report)).not.toContain("secret");
  });

  // Parity gap #5: native is selected by native.mode in arbor.jsonc while
  // every connector is selected by ARBOR_HARNESS_INTEGRATION — a
  // misconfigured "native" run silently falls back to a connector with no
  // signal. mode_selection states the outcome and the concrete why in one
  // place instead of leaving the operator to infer it from execution/integration.
  it("states native as the active lane and why, without consulting the connector", () => {
    const cwd = root();
    const config = new ConfigInspectionService().inspect();
    const report = buildUnifiedDoctor({ cwd, persistence_dir: join(cwd, ".arbor"), config, readiness: readinessFixture({ kind: "direct_native", selected_by: "native" }, "native"), integration, connectors: [] });
    expect(report.mode_selection).toEqual({ active_lane: "native", connector_id: "fixture", native_mode: "native", reason: "native.mode=native selected native execution (explicit native.mode=native); ARBOR_HARNESS_INTEGRATION is not consulted while native is selected" });
  });

  it("names the connector and the real reason when native falls back", () => {
    const cwd = root();
    const config = new ConfigInspectionService().inspect();
    const report = buildUnifiedDoctor({ cwd, persistence_dir: join(cwd, ".arbor"), config, readiness: readinessFixture({ kind: "connector_fallback", reason: "credential_absent" }, "auto"), integration, connectors: [] });
    expect(report.mode_selection).toEqual({ active_lane: "connector", connector_id: "fixture", native_mode: "auto", reason: 'native.mode=auto fell back to the "fixture" connector (from ARBOR_HARNESS_INTEGRATION, a deprecated lane admitted only by connectors.allow_deprecated): credential_absent' });
  });

  it("names the connector dependency when native is outright unavailable", () => {
    const cwd = root();
    const config = new ConfigInspectionService().inspect();
    const report = buildUnifiedDoctor({ cwd, persistence_dir: join(cwd, ".arbor"), config, readiness: readinessFixture({ kind: "unavailable", reason: "credential_absent", adapter_id: "openai-compatible" }, "native"), integration, connectors: [] });
    expect(report.mode_selection).toEqual({ active_lane: "connector", connector_id: "fixture", native_mode: "native", reason: 'native.mode=native is unavailable (credential_absent); campaign execution depends on the "fixture" connector (from ARBOR_HARNESS_INTEGRATION, a deprecated lane admitted only by connectors.allow_deprecated) instead' });
  });

  it("reports the connector as authoritative when native readiness was never composed", () => {
    const cwd = root();
    const config = new ConfigInspectionService().inspect();
    const report = buildUnifiedDoctor({ cwd, persistence_dir: join(cwd, ".arbor"), config, readiness: null, integration, connectors: [] });
    expect(report.mode_selection).toEqual({ active_lane: "connector", connector_id: "fixture", native_mode: null, reason: "native readiness was not composed for this doctor call; the configured connector is authoritative" });
  });
});

describe("safe migration authority", () => {
  it("inspects, previews, applies with a preview hash, and restores an atomic backup", () => {
    const cwd = root(); const source = join(cwd, "opencode.json"); const target = join(cwd, "arbor.jsonc");
    writeFileSync(source, JSON.stringify({ provider: "openrouter", model: "example/model" })); writeFileSync(target, "operator-owned", "utf8");
    expect(inspectMigration(cwd)).toMatchObject({ schema_version: 1, target: { present: true }, compatibility: { status: "compatible" } });
    const preview = previewMigration({ cwd, source_path: "opencode.json" });
    expect(preview).toMatchObject({ source: { kind: "opencode" }, target: { overwrite_required: true }, rollback: { available: true } });
    expect(() => applyMigration({ cwd, source_path: "opencode.json", expected_source_sha256: preview.source.sha256, overwrite: false })).toThrow("explicit overwrite");
    const receipt = applyMigration({ cwd, source_path: "opencode.json", expected_source_sha256: preview.source.sha256, overwrite: true });
    expect(readFileSync(target, "utf8")).toContain("openrouter");
    rollbackMigration({ cwd, receipt_id: receipt.receipt_id });
    expect(readFileSync(target, "utf8")).toBe("operator-owned");
  });

  it("refuses a stale source and a rollback after an intervening target change", () => {
    const cwd = root(); const source = join(cwd, "source.json"); const target = join(cwd, "arbor.jsonc");
    writeFileSync(source, JSON.stringify({ provider: "p", model: "m" })); const preview = previewMigration({ cwd, source_path: "source.json" });
    writeFileSync(source, JSON.stringify({ provider: "p", model: "changed" }));
    expect(() => applyMigration({ cwd, source_path: "source.json", expected_source_sha256: preview.source.sha256, overwrite: false })).toThrow("changed since preview");
    const fresh = previewMigration({ cwd, source_path: "source.json" }); const receipt = applyMigration({ cwd, source_path: "source.json", expected_source_sha256: fresh.source.sha256, overwrite: false });
    expect(existsSync(target)).toBe(true); writeFileSync(target, "later operator update", "utf8");
    expect(() => rollbackMigration({ cwd, receipt_id: receipt.receipt_id })).toThrow("target changed");
  });
});

describe("operator maintenance catalog routes", () => {
  it("exposes doctor and migration inspection through canonical queries", () => {
    const cwd = root(); const runtime = new ArborRuntime({ persistence_dir: join(cwd, ".arbor"), workspace_root: cwd, config_inspection: new ConfigInspectionService(), operator_doctor_integration: integration }); const router = new RuntimeCatalogRouter(runtime);
    expect(router.executeQuery({ schema_version: 1, query_id: "doctor", query: { kind: "doctor.get" } })).toMatchObject({ ok: true, capability: "config.read", value: { schema_version: 2, operational: { remote: { status: "unavailable" }, scheduler: { status: "unavailable" }, sessions: { status: "ready", known: 0, live: 0 } } } });
    expect(router.executeQuery({ schema_version: 1, query_id: "migration", query: { kind: "migration.inspect" } })).toMatchObject({ ok: true, capability: "config.read", value: { schema_version: 1 } });
  });
});
