/**
 * Canopy-only (operator directive 2026-10-07, amends ADR-061): every default
 * resolves to the native lane, and every non-Canopy harness lane is refused at
 * composition with a typed ADR-179 remedy unless `connectors.allow_deprecated`
 * admits it — in which case the run's own ledger records the admission.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectorRegistry, HarnessIntegrationRegistry, type ConnectorDescriptor } from "@arbor/harness";
import { loadConfigFromString } from "@arbor/config";
import { ArborRuntime } from "../src/runtime.js";
import { createCliRuntime, createProductionCampaignRunner } from "../src/cli.js";
import { NATIVE_HARNESS_CONNECTOR_ID } from "../src/harness-control-plane.js";
import { inspectHarnessIntegrationEnvironment } from "../src/doctor.js";
import { isGateRefusalProjection } from "../src/gate-refusal-projection.js";
import type { CampaignHarnessIntegration } from "../src/campaign-harness-integration.js";
import { OPENCODE_HARNESS_CONNECTOR_ID } from "../src/integrations/opencode-campaign.js";
import { CLAUDE_CODE_HARNESS_CONNECTOR_ID } from "../src/integrations/claude-code-campaign.js";
import { CODEX_HARNESS_CONNECTOR_ID } from "../src/integrations/codex-campaign.js";
import {
  admitDeprecatedHarnessLane,
  CANOPY_CONNECTOR_ID,
  DEFAULT_HARNESS_INTEGRATION_ID,
  DeprecatedHarnessRefusal,
  recordDeprecatedHarnessAdmission,
  resolveConfiguredHarnessIntegrationId,
} from "../src/canopy-lane-policy.js";

/** Integration id (the ARBOR_HARNESS_INTEGRATION value) → its registered connector id. */
const CONNECTOR_OF = { opencode: OPENCODE_HARNESS_CONNECTOR_ID, "claude-code": CLAUDE_CODE_HARNESS_CONNECTOR_ID, codex: CODEX_HARNESS_CONNECTOR_ID } as const;
const OPT_IN = { connectors: { allow_deprecated: true, reason: "post-1.0 comparison run" } };
const roots: string[] = [];

function project(config: Record<string, unknown> | null): string {
  const root = mkdtempSync(join(tmpdir(), "arbor-canopy-lane-"));
  roots.push(root);
  if (config !== null) writeFileSync(join(root, "arbor.jsonc"), JSON.stringify(config), "utf8");
  return root;
}

function refusalOf(compose: () => unknown): DeprecatedHarnessRefusal {
  try { compose(); } catch (error) {
    if (error instanceof DeprecatedHarnessRefusal) return error;
    throw error;
  }
  throw new Error("composition was expected to refuse a deprecated lane");
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Canopy lane policy — defaults", () => {
  it("defaults ARBOR_HARNESS_INTEGRATION to the native lane, and the Canopy connector id is revoy-native", () => {
    expect(DEFAULT_HARNESS_INTEGRATION_ID).toBe("native");
    expect(CANOPY_CONNECTOR_ID).toBe(NATIVE_HARNESS_CONNECTOR_ID);
    expect(resolveConfiguredHarnessIntegrationId({})).toBe("native");
    expect(resolveConfiguredHarnessIntegrationId({ ARBOR_HARNESS_INTEGRATION: "  " })).toBe("native");
    expect(inspectHarnessIntegrationEnvironment({}).integration_id).toBe("native");
  });

  it("composes no connector by default: the runtime has nothing but the native lane to select", () => {
    const runtime = createCliRuntime(project(null), ".arbor-default", { env: {} });
    for (const connector of Object.values(CONNECTOR_OF)) expect(runtime.inspectHarnessConnector(connector)).toBeNull();
  });
});

describe("Canopy lane policy — refusal without the opt-in", () => {
  for (const integration of ["opencode", "claude-code", "codex"] as const) {
    it(`refuses ARBOR_HARNESS_INTEGRATION=${integration} at composition with the typed ADR-179 remedy`, () => {
      const refusal = refusalOf(() => createCliRuntime(project(null), ".arbor-refused", { env: { ARBOR_HARNESS_INTEGRATION: integration } }));
      expect(refusal.lane).toBe(integration);
      expect(isGateRefusalProjection(refusal.refusal)).toBe(true);
      expect(refusal.refusal).toMatchObject({
        state: "refused", gate: "capability", code: "deprecated_harness_lane",
        correcting_actor: "operator", corrective_action: "grant_capability",
      });
      expect(refusal.refusal.summary).toContain(`ARBOR_HARNESS_INTEGRATION=${integration}`);
      expect(refusal.message).toContain("connectors.allow_deprecated: true");
    });
  }

  it("refuses native.mode \"fallback\" at composition", () => {
    const root = project({ native: { mode: "fallback", provider_id: "fixture", base_url: "https://fixture.invalid/v1", model: "fixture-model" } });
    const refusal = refusalOf(() => createCliRuntime(root, ".arbor-fallback", { env: {} }));
    expect(refusal.lane).toBe("native_mode_fallback");
    expect(refusal.refusal.remediation).toMatch(/native\.mode to "native" or "auto"/);
  });

  it("an opt-in without a reason is not an opt-in: the config itself is rejected", () => {
    expect(() => loadConfigFromString(JSON.stringify({ connectors: { allow_deprecated: true } }))).toThrow(/connectors\.allow_deprecated requires connectors\.reason/);
    expect(() => loadConfigFromString(JSON.stringify({ connectors: { allow_deprecated: true, reason: "two\nlines" } }))).toThrow(/single-line/);
    expect(() => loadConfigFromString(JSON.stringify({ connectors: { allow_deprecate: true } }))).toThrow(/unknown keys: allow_deprecate/);
    // An explicit `false` is a valid, inert setting.
    expect(() => admitDeprecatedHarnessLane("opencode", "test", loadConfigFromString(JSON.stringify({ connectors: { allow_deprecated: false } })))).toThrow(DeprecatedHarnessRefusal);
  });
});

describe("Canopy lane policy — explicit post-1.0 opt-in", () => {
  for (const integration of ["opencode", "claude-code", "codex"] as const) {
    it(`composes ARBOR_HARNESS_INTEGRATION=${integration} with the opt-in and says so at composition`, () => {
      const notices: string[] = [];
      const runtime = createCliRuntime(project(OPT_IN), ".arbor-opted-in", { env: { ARBOR_HARNESS_INTEGRATION: integration }, onNotice: (message) => notices.push(message) });
      expect(runtime.inspectHarnessConnector(CONNECTOR_OF[integration])).not.toBeNull();
      expect(notices).toContain(`[harness] deprecated harness lane "${integration}" (selected by ARBOR_HARNESS_INTEGRATION=${integration}) admitted by connectors.allow_deprecated: post-1.0 comparison run`);
    });
  }

  it("composes native.mode \"fallback\" with the opt-in", () => {
    const root = project({ ...OPT_IN, native: { mode: "fallback", provider_id: "fixture", base_url: "https://fixture.invalid/v1", model: "fixture-model" } });
    expect(() => createCliRuntime(root, ".arbor-fallback-opted-in", { env: {} })).not.toThrow();
  });

  it("records the admission in the campaign's ledger when a run executes on a non-Canopy connector", async () => {
    const integrations = new HarnessIntegrationRegistry<CampaignHarnessIntegration>();
    const descriptor: ConnectorDescriptor = {
      connector_id: OPENCODE_HARNESS_CONNECTOR_ID, implementation_version: "test", supported_upstream_range: "test-only", health: "healthy",
      capabilities: [{ capability: "interruption", grade: "governed", evidence: { implementation_id: "opencode", observed_at: "2026-10-07T00:00:00.000Z", detail: "fixture" } }],
    };
    integrations.register(descriptor, {
      createExecutor: () => ({ specialize: async () => { throw new Error("not reached"); }, review: async () => { throw new Error("not reached"); }, log: () => {} }),
      createReviewer: () => async () => ({ approved: true, rationale: "fixture" }),
    });
    const admission = admitDeprecatedHarnessLane("opencode", "ARBOR_HARNESS_INTEGRATION=opencode", loadConfigFromString(JSON.stringify(OPT_IN)));
    const runtimeBox: { current: ArborRuntime | null } = { current: null };
    const runner = createProductionCampaignRunner(runtimeBox, process.cwd(), {}, {
      integrations, requirements: [{ capability: "interruption", minimum_grade: "governed" }],
      deprecated_harness_admission: admission, allow_primary_checkout: true,
    });
    const runtime = new ArborRuntime({ campaign_runner: runner, harness_connector_registry: integrations.connectors, register_native_harness_connector: false });
    runtimeBox.current = runtime;
    const started = runtime.manager.startCampaign("opted-in", "plan.md", { description: "fixture", estimated_gain: 1, estimated_cost: 1, category: "planning", delegate_to: "crown" });
    expect(started.ok).toBe(true);
    const aborted = new AbortController(); aborted.abort();
    await runner.run("opted-in", aborted.signal).catch(() => undefined);

    const messages = runtime.manager.getPhaseMessages("opted-in");
    expect(messages.map((record) => record.message.content)).toContain(
      'deprecated harness lane "opencode" (selected by ARBOR_HARNESS_INTEGRATION=opencode) admitted by connectors.allow_deprecated: post-1.0 comparison run',
    );
    // Idempotent per campaign and lane: a resumed run does not duplicate it.
    recordDeprecatedHarnessAdmission(runtime.manager, "opted-in", admission);
    expect(runtime.manager.getPhaseMessages("opted-in")).toHaveLength(messages.length);
  });

  it("records nothing when the selected connector is the Canopy lane", async () => {
    const registry = new ConnectorRegistry();
    const integrations = new HarnessIntegrationRegistry<CampaignHarnessIntegration>(registry);
    integrations.register({
      connector_id: NATIVE_HARNESS_CONNECTOR_ID, implementation_version: "test", supported_upstream_range: "test-only", health: "healthy",
      capabilities: [{ capability: "interruption", grade: "governed", evidence: { implementation_id: "native", observed_at: "2026-10-07T00:00:00.000Z", detail: "fixture" } }],
    }, {
      createExecutor: () => ({ specialize: async () => { throw new Error("not reached"); }, review: async () => { throw new Error("not reached"); }, log: () => {} }),
      createReviewer: () => async () => ({ approved: true, rationale: "fixture" }),
    });
    const admission = admitDeprecatedHarnessLane("native_mode_fallback", "native.mode=\"fallback\"", loadConfigFromString(JSON.stringify(OPT_IN)));
    const runtimeBox: { current: ArborRuntime | null } = { current: null };
    const runner = createProductionCampaignRunner(runtimeBox, process.cwd(), {}, {
      integrations, requirements: [{ capability: "interruption", minimum_grade: "governed" }],
      deprecated_harness_admission: admission, allow_primary_checkout: true,
    });
    const runtime = new ArborRuntime({ campaign_runner: runner, harness_connector_registry: registry, register_native_harness_connector: false });
    runtimeBox.current = runtime;
    runtime.manager.startCampaign("canopy", "plan.md", { description: "fixture", estimated_gain: 1, estimated_cost: 1, category: "planning", delegate_to: "crown" });
    const aborted = new AbortController(); aborted.abort();
    await runner.run("canopy", aborted.signal).catch(() => undefined);
    expect(runtime.manager.getPhaseMessages("canopy").map((record) => record.message.content).join("\n")).not.toContain("deprecated harness lane");
  });
});
