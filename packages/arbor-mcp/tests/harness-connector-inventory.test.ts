import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectorRegistry } from "@arbor/harness";
import { HeadlessHarness, harnessConnectorsScreen } from "@arbor/tui";
import { NATIVE_HARNESS_CONNECTOR_ID, createNativeHarnessConnectorDescriptor } from "../src/harness-control-plane.js";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { RuntimePortAdapter } from "../src/tui-adapter.js";
import { createCliRuntime } from "../src/cli.js";

function query(runtime: ArborRuntime) {
  return new RuntimeCatalogRouter(runtime).executeQuery({ schema_version: 1, query_id: "connectors", query: { kind: "harness.connector.inventory" } });
}

function tui(runtime: ArborRuntime): HeadlessHarness {
  const adapter = new RuntimePortAdapter(new RuntimeCatalogRouter(runtime));
  return new HeadlessHarness({
    client: { connect: () => {}, disconnect: () => {}, requestSnapshot: () => {}, close: () => {}, interruptCampaign: () => {} },
    terminal: { restore: () => {} }, clock: { now: () => 1 },
    telemetrySource: { fetch: async () => ({ campaign_id: "c", source_record_count: 0, counters: [], phase_histograms: [], usage_cost: [], context_economy: [], tool_economy: [] }) },
    runtime: adapter as never,
  });
}

describe("harness connector inventory", () => {
  it("reports unconfigured direct-native selection as explicit unattested fallback, never connector health", () => {
    const result = query(new ArborRuntime());
    expect(result).toMatchObject({ ok: true, capability: "harness.connector.read", value: {
      requirements: [{ capability: "interruption", minimum_grade: "governed" }, { capability: "tool_policy", minimum_grade: "governed" }],
      connectors: [], selection: { kind: "unavailable", reason: "not_configured" },
      selected_execution: { kind: "connector_fallback", connector_id: "opencode", readiness: "fallback_unattested", reason: "no direct-native connector is configured" },
    } });
  });

  it("projects the registered descriptor, capability grades, and exact selected direct execution", () => {
    const registry = new ConnectorRegistry();
    registry.register(createNativeHarnessConnectorDescriptor("2026-08-09T00:00:00.000Z"));
    const runtime = new ArborRuntime({ harness_connector_registry: registry, register_native_harness_connector: false });
    const result = query(runtime);
    expect(result).toMatchObject({ ok: true, value: {
      selection: { kind: "selected", connector_id: NATIVE_HARNESS_CONNECTOR_ID },
      selected_execution: { kind: "direct_native", connector_id: NATIVE_HARNESS_CONNECTOR_ID, readiness: "selected", reason: null },
      connectors: [expect.objectContaining({ connector_id: NATIVE_HARNESS_CONNECTOR_ID, capabilities: expect.arrayContaining([
        expect.objectContaining({ capability: "tool_policy", grade: "native" }),
        expect.objectContaining({ capability: "resumption", grade: "governed" }),
      ]) })],
    } });
  });

  it("never projects connector free-text diagnostics or evidence detail into the all-surface inventory", () => {
    const registry = new ConnectorRegistry();
    registry.register({
      connector_id: "secretive", implementation_version: "1", supported_upstream_range: "fixture", health: "degraded",
      diagnostic: "Authorization: Bearer never-project-this",
      capabilities: [{ capability: "tool_policy", grade: "governed", evidence: { implementation_id: "fixture", observed_at: "2026-08-09T00:00:00.000Z", detail: "api_key=never-project-this" } }],
    });
    const result = query(new ArborRuntime({ harness_connector_registry: registry, register_native_harness_connector: false }));
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("never-project-this");
    expect(result).toMatchObject({ ok: true, value: { connectors: [expect.objectContaining({ connector_id: "secretive", capabilities: [expect.objectContaining({ capability: "tool_policy", grade: "governed", observed_at: "2026-08-09T00:00:00.000Z" })] })] } });
  });

  it("uses the CLI's actual configured-native composition rather than a hand-built registry", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-connector-inventory-"));
    const previousKey = process.env.ARBOR_NATIVE_API_KEY;
    try {
      writeFileSync(join(root, "arbor.jsonc"), JSON.stringify({ native: {
        mode: "native", adapter_id: "openai-compatible", provider_id: "fixture-provider",
        base_url: "https://fixture.invalid/v1", model: "fixture-model",
      } }), "utf8");
      process.env.ARBOR_NATIVE_API_KEY = "test-only-native-key";
      const result = query(createCliRuntime(root, ".arbor-connector-inventory"));
      expect(result).toMatchObject({ ok: true, value: {
        connectors: expect.arrayContaining([expect.objectContaining({ connector_id: NATIVE_HARNESS_CONNECTOR_ID })]),
        selected_execution: { kind: "direct_native", connector_id: NATIVE_HARNESS_CONNECTOR_ID, readiness: "selected" },
      } });
    } finally { if (previousKey === undefined) delete process.env.ARBOR_NATIVE_API_KEY; else process.env.ARBOR_NATIVE_API_KEY = previousKey; rmSync(root, { recursive: true, force: true }); }
  });

  it("reports explicitly blocked native mode as unavailable rather than falsely advertising connector fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-connector-explicit-unavailable-"));
    const previousKey = process.env.ARBOR_NATIVE_API_KEY;
    try {
      writeFileSync(join(root, "arbor.jsonc"), JSON.stringify({ native: {
        mode: "native", adapter_id: "openai-compatible", provider_id: "fixture-provider",
        base_url: "https://fixture.invalid/v1", model: "fixture-model",
      } }), "utf8");
      delete process.env.ARBOR_NATIVE_API_KEY;
      const runtime = createCliRuntime(root, ".arbor-connector-explicit-unavailable");
      // Canopy-only: no connector is registered behind the blocked native
      // lane, so selection is unavailable rather than a connector fallback.
      expect(query(runtime)).toMatchObject({ ok: true, value: {
        selection: { kind: "unavailable" },
        selected_execution: {
          kind: "unavailable", connector_id: NATIVE_HARNESS_CONNECTOR_ID, readiness: "blocked",
          reason: expect.stringContaining("credential_absent"),
        },
      } });
      const app = tui(runtime);
      await app.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "harness-connectors" }, at: 1 });
      await app.dispatch({ type: "ui_intent", intent: { type: "issue_query", queryId: "blocked-connectors", request: { kind: "harness.connector.inventory", query_id: "blocked-connectors", params: {} } }, at: 2 });
      expect(harnessConnectorsScreen.project(app.model.screens.get("harness-connectors"), { width: 160, height: 20 }).caption)
        .toContain("unavailable via revoy-native (blocked)");
    } finally { if (previousKey === undefined) delete process.env.ARBOR_NATIVE_API_KEY; else process.env.ARBOR_NATIVE_API_KEY = previousKey; rmSync(root, { recursive: true, force: true }); }
  });

  it("reaches the same inventory through the TUI's canonical runtime-port projection", async () => {
    const registry = new ConnectorRegistry(); registry.register(createNativeHarnessConnectorDescriptor("2026-08-09T00:00:00.000Z"));
    const runtime = new ArborRuntime({ harness_connector_registry: registry, register_native_harness_connector: false });
    const app = tui(runtime);
    await app.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "harness-connectors" }, at: 1 });
    await app.dispatch({ type: "ui_intent", intent: { type: "issue_query", queryId: "connectors", request: { kind: "harness.connector.inventory", query_id: "connectors", params: {} } }, at: 2 });
    expect(app.model.screens.get("harness-connectors")).toMatchObject({ selected_execution: { kind: "direct_native", connector_id: NATIVE_HARNESS_CONNECTOR_ID } });
    expect(harnessConnectorsScreen.project(app.model.screens.get("harness-connectors"), { width: 160, height: 20 })).toMatchObject({
      rows: [expect.objectContaining({ connector: NATIVE_HARNESS_CONNECTOR_ID, health: "healthy", capabilities: expect.stringContaining("tool_policy:native") })],
      caption: expect.stringContaining("direct_native via revoy-native (selected)"),
    });
  });
});
