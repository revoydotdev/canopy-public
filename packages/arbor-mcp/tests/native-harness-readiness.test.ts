import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { DEFAULT_CONFIG } from "@arbor/config";
import { createReferenceNativeModelAdapterRegistry } from "@arbor/harness";
import { HeadlessHarness, harnessReadinessScreen } from "@arbor/tui";
import { ConfigInspectionService } from "../src/config-inspection.js";
import { createCliRuntime, main } from "../src/cli.js";
import {
  buildNativeHarnessReadiness,
  describeNativeConnectorFallbackDemotion,
  formatNativeHarnessReadiness,
  NativeHarnessReadinessService,
  requiresDirectNativeProvider,
  resolveNativeHarnessExecutionReadiness,
} from "../src/native-harness-readiness.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { RuntimePortAdapter } from "../src/tui-adapter.js";
import { codexCliCredentialFacts } from "../src/native-executor-composition.js";
import { validateNativeHarnessReadinessQuery } from "../src/native-harness-readiness-contracts.js";

const complete = {
  mode: "auto" as const, adapter_id: "openai-compatible" as const, provider_id: "fixture-provider",
  base_url: "https://fixture.invalid/v1", model: "fixture-model", revision: "fixture-revision",
  pricing: { price_source_id: "fixture-price", observed_at: "2026-08-09T00:00:00.000Z", provider_id: "fixture-provider", model_id: "fixture-model", currency: "USD", minor_unit_exponent: 2, input_minor_units_per_million_tokens: 100, output_minor_units_per_million_tokens: 200, cache_read_minor_units_per_million_tokens: 25, cache_write_minor_units_per_million_tokens: 125 },
  usage_budget: { estimate_authority: "fixture-upper-bound", estimate_max_input_tokens: 100, estimate_max_output_tokens: 50, max_session_total_tokens: 150, max_campaign_tokens: 1_000 },
};

describe("native harness setup/readiness doctor", () => {
  it("rejects a blank readiness query id at the canonical envelope boundary", () => {
    expect(validateNativeHarnessReadinessQuery({
      schema_version: 1,
      query_id: "   ",
      query: { kind: "harness.native.readiness" },
    })).toEqual(["query_id is required"]);
  });

  it("reports source, adapter, credential-presence, model/revision, pricing, and budget facts without secret material", () => {
    const config = { ...DEFAULT_CONFIG, native: complete };
    const view = new ConfigInspectionService({ defaults: DEFAULT_CONFIG, file: { native: complete } }).inspect();
    const doctor = new NativeHarnessReadinessService({
      config, config_view: view,
      credential: { present: true, source: "env", env_var: "ARBOR_NATIVE_API_KEY" },
      adapters: createReferenceNativeModelAdapterRegistry(fetch),
    }).inspect();
    expect(doctor).toMatchObject({
      execution: { kind: "direct_native", selected_by: "auto" },
      config_sources: { file_present: true, native: { mode: "file", model: "file", pricing: "file", usage_budget: "file" } },
      adapter: { adapter_id: "openai-compatible", availability: "available", implementation_id: "revoy2-openai-compatible-native-adapter" },
      credential: { required: true, present: true, source: "env", env_var: "ARBOR_NATIVE_API_KEY" },
      model_revision: { configured: "fixture-revision", readiness: "configured_unobserved" },
      pricing: { readiness: "configured", matches_selected_model: true },
      budget: { readiness: "configured", cache_estimate: "conservative_utf8_upper_bound", session_limits_configured: true, campaign_limits_configured: true },
      missing_requirements: [],
    });
    expect(JSON.stringify(doctor)).not.toContain("never-project-this");
  });

  it("fails closed across partial, unsupported, and mismatched native selections", () => {
    const adapters = createReferenceNativeModelAdapterRegistry(fetch);
    const inspect = (native: typeof DEFAULT_CONFIG.native) => {
      const config = { ...DEFAULT_CONFIG, native };
      return buildNativeHarnessReadiness({
        config,
        config_view: new ConfigInspectionService({ defaults: DEFAULT_CONFIG, file: { native } }).inspect(),
        credential: { present: false, source: "absent", env_var: null },
        adapters,
      });
    };

    const partialAuto = inspect({
      ...DEFAULT_CONFIG.native,
      mode: "auto",
      provider_id: "fixture-provider",
      base_url: "https://fixture.invalid/v1",
      model: "",
    });
    expect(partialAuto).toMatchObject({
      execution: { kind: "connector_fallback", reason: "selection_incomplete" },
      missing_requirements: [{ code: "native_model_missing" }],
    });

    const forcedFallback = inspect({ ...DEFAULT_CONFIG.native, mode: "fallback" });
    expect(forcedFallback).toMatchObject({
      execution: { kind: "connector_fallback", reason: "forced_by_config" },
      missing_requirements: [{ code: "native_mode_fallback" }],
    });

    const explicitIncomplete = inspect({
      ...DEFAULT_CONFIG.native,
      mode: "native",
      adapter_id: "openai-compatible",
      provider_id: "fixture-provider",
      base_url: "",
      model: "fixture-model",
    });
    expect(explicitIncomplete).toMatchObject({
      execution: { kind: "unavailable", reason: "native_selection_incomplete", adapter_id: null },
      selection: { adapter_id: null },
      missing_requirements: [{ code: "native_base_url_missing" }],
    });
    expect(formatNativeHarnessReadiness(explicitIncomplete)).toContain("Credential: absent / api_key / absent\n");

    const unsupportedNative = {
      ...complete,
      mode: "native" as const,
      adapter_id: "openai-compatible" as const,
      pricing: { ...complete.pricing, model_id: "different-model" },
    };
    const unsupportedConfig = { ...DEFAULT_CONFIG, native: unsupportedNative };
    const unsupported = buildNativeHarnessReadiness({
      config: unsupportedConfig,
      config_view: new ConfigInspectionService({ defaults: DEFAULT_CONFIG, file: { native: unsupportedNative } }).inspect(),
      credential: { present: true, source: "env", env_var: "ARBOR_NATIVE_API_KEY" },
      adapters: { inspect: () => null },
    });
    expect(unsupported).toMatchObject({
      execution: { kind: "unavailable", reason: "native_adapter_unsupported", adapter_id: "openai-compatible" },
      adapter: { availability: "unavailable" },
      pricing: { readiness: "configured", matches_selected_model: false },
      missing_requirements: [{ code: "native_adapter_unavailable" }],
    });

    const costOnlyBudget = inspect({
      ...DEFAULT_CONFIG.native,
      usage_budget: { estimate_authority: "fixture", estimate_max_input_tokens: 1, estimate_max_output_tokens: 1, max_campaign_cost: { currency: "USD", minor_units: 1, minor_unit_exponent: 2 } },
    });
    expect(costOnlyBudget.budget).toMatchObject({ readiness: "configured", cache_estimate: "conservative_utf8_upper_bound", campaign_limits_configured: true });
  });

  it("makes auto mode direct-native only with complete config plus credential presence, otherwise reports truthful fallback", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-native-doctor-"));
    const previousKey = process.env.ARBOR_NATIVE_API_KEY;
    try {
      writeFileSync(join(root, "arbor.jsonc"), JSON.stringify({ native: complete }), "utf8");
      delete process.env.ARBOR_NATIVE_API_KEY;
      const absent = new RuntimeCatalogRouter(createCliRuntime(root, ".arbor-absent")).executeQuery({ schema_version: 1, query_id: "absent", query: { kind: "harness.native.readiness" } });
      expect(absent).toMatchObject({ ok: true, value: { execution: { kind: "connector_fallback", reason: "credential_absent" }, credential: { present: false }, missing_requirements: [expect.objectContaining({ code: "native_credential_absent" })] } });

      process.env.ARBOR_NATIVE_API_KEY = "never-project-this";
      const runtime = createCliRuntime(root, ".arbor-ready");
      const ready = new RuntimeCatalogRouter(runtime).executeQuery({ schema_version: 1, query_id: "ready", query: { kind: "harness.native.readiness" } });
      expect(ready).toMatchObject({ ok: true, capability: "harness.connector.read", value: { execution: { kind: "direct_native", selected_by: "auto" }, credential: { present: true } } });
      expect(runtime.inspectHarnessConnector("revoy-native")).not.toBeNull();
      expect(JSON.stringify(ready)).not.toContain("never-project-this");
    } finally { if (previousKey === undefined) delete process.env.ARBOR_NATIVE_API_KEY; else process.env.ARBOR_NATIVE_API_KEY = previousKey; rmSync(root, { recursive: true, force: true }); }
  });

  it("exposes the exact same doctor projection through the read-only CLI command", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-native-doctor-cli-"));
    try {
      const stdout = new PassThrough(); let text = ""; stdout.on("data", (chunk: Buffer) => { text += chunk.toString(); });
      const status = await main(["doctor", "--json"], {
        cwd: root,
        stdin: new PassThrough(),
        stdout,
        stderr: new PassThrough(),
        env: { ARBOR_HARNESS_INTEGRATION: "opencode" },
        execute_integration_probe: () => "1.2.3",
      });
      expect(status).toBe(0);
      // ADR-099: a fresh checkout now ships a complete native.* selection
      // (defaults.ts), so the doctor's fallback reason is genuinely
      // credential absence, not an incomplete out-of-the-box selection.
      expect(JSON.parse(text)).toMatchObject({ execution: { kind: "connector_fallback", reason: "credential_absent" } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("renders the canonical doctor result through the TUI runtime port without a credential value", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-native-doctor-tui-"));
    try {
    const runtime = createCliRuntime(root, ".arbor");
    const app = new HeadlessHarness({
      client: { connect: () => {}, disconnect: () => {}, requestSnapshot: () => {}, close: () => {}, interruptCampaign: () => {} }, terminal: { restore: () => {} }, clock: { now: () => 1 },
      telemetrySource: { fetch: async () => ({ campaign_id: "c", source_record_count: 0, counters: [], phase_histograms: [], usage_cost: [], context_economy: [], tool_economy: [] }) }, runtime: new RuntimePortAdapter(new RuntimeCatalogRouter(runtime)) as never,
    });
    await app.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "harness-readiness" }, at: 1 });
    await app.dispatch({ type: "ui_intent", intent: { type: "issue_query", queryId: "readiness", request: { kind: "harness.native.readiness", query_id: "readiness", params: {} } }, at: 2 });
    const projection = harnessReadinessScreen.project(app.model.screens.get("harness-readiness"), { width: 120, height: 20 });
    expect(projection).toMatchObject({ screen: "harness-readiness", caption: expect.stringContaining("1 setup blocker"), rows: expect.arrayContaining([expect.objectContaining({ concern: "Execution", status: expect.stringContaining("connector_fallback") })]) });
    expect(JSON.stringify(projection)).not.toContain("ARBOR_NATIVE_API_KEY=");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("ADR-099 O3: an unmodified default config resolves direct_native once only a credential is present", () => {
    const readiness = buildNativeHarnessReadiness({
      config: DEFAULT_CONFIG,
      config_view: new ConfigInspectionService({ defaults: DEFAULT_CONFIG, file: null }).inspect(),
      credential: { present: true, source: "env", env_var: "ANTHROPIC_API_KEY" },
      adapters: createReferenceNativeModelAdapterRegistry(fetch),
    });
    expect(readiness).toMatchObject({
      execution: { kind: "direct_native", selected_by: "auto" },
      selection: { mode: "auto", adapter_id: DEFAULT_CONFIG.native.adapter_id, provider_id: DEFAULT_CONFIG.native.provider_id, model_id: DEFAULT_CONFIG.native.model },
      missing_requirements: [],
    });
    expect(describeNativeConnectorFallbackDemotion(readiness)).toBeNull();
  });

  it("accepts only the OpenAI WIF bearer on the OpenAI-compatible adapter", () => {
    const adapters = createReferenceNativeModelAdapterRegistry(fetch);
    const openai = { ...complete, adapter_id: "openai-compatible" as const, provider_id: "openai", base_url: "https://api.openai.com/v1" };
    expect(resolveNativeHarnessExecutionReadiness({ ...openai, credential_source: "openai_wif" }, { present: true, mechanism: "oauth_bearer" }, adapters)).toMatchObject({ kind: "direct_native" });
    expect(resolveNativeHarnessExecutionReadiness({ ...openai, credential_source: "openai_wif" }, { present: false, mechanism: "oauth_bearer" }, adapters)).toMatchObject({ kind: "unavailable", reason: "credential_absent" });
    expect(resolveNativeHarnessExecutionReadiness({ ...openai, credential_source: "openai_wif" }, { present: false, mechanism: "oauth_bearer", state: "expired" }, adapters)).toMatchObject({ kind: "unavailable", reason: "credential_expired" });
    expect(resolveNativeHarnessExecutionReadiness({ ...openai, credential_source: "openai_wif", adapter_id: "anthropic-messages", provider_id: "anthropic" }, { present: true, mechanism: "oauth_bearer" }, adapters)).toMatchObject({ kind: "unavailable", reason: "credential_source_unusable" });
    expect(resolveNativeHarnessExecutionReadiness({ ...openai, credential_source: "openai_wif", base_url: "https://attacker.example/v1" }, { present: true, mechanism: "oauth_bearer" }, adapters)).toMatchObject({ kind: "unavailable", reason: "credential_source_unusable" });
  });

  it("keeps the native provider matrix direct and binds each route to its credential contract", () => {
    const adapters = createReferenceNativeModelAdapterRegistry(fetch);
    const routes = [
      { name: "OpenAI API key", config: { ...complete, provider_id: "openai", base_url: "https://api.openai.com/v1" }, credential: { present: true, mechanism: "api_key" as const }, directOnly: false },
      { name: "OpenAI WIF", config: { ...complete, provider_id: "openai", base_url: "https://api.openai.com/v1", credential_source: "openai_wif" as const }, credential: { present: true, mechanism: "oauth_bearer" as const }, directOnly: false },
      { name: "OpenRouter", config: { ...complete, provider_id: "openrouter", base_url: "https://openrouter.ai/api/v1" }, credential: { present: true, mechanism: "api_key" as const }, directOnly: true },
      { name: "Anthropic API key", config: { ...complete, adapter_id: "anthropic-messages" as const, provider_id: "anthropic", base_url: "https://api.anthropic.com/v1" }, credential: { present: true, mechanism: "api_key" as const }, directOnly: false },
      { name: "Ollama local", config: { ...complete, adapter_id: "ollama-native" as const, provider_id: "ollama", base_url: "http://127.0.0.1:11434" }, credential: { present: false, mechanism: "api_key" as const }, directOnly: true },
    ];
    for (const route of routes) {
      expect(resolveNativeHarnessExecutionReadiness(route.config, route.credential, adapters), route.name).toMatchObject({ kind: "direct_native" });
      expect(requiresDirectNativeProvider(route.config), route.name).toBe(route.directOnly);
    }

    const invalidOpenRouter = { ...complete, provider_id: "openrouter", base_url: "https://api.openai.com/v1" };
    expect(resolveNativeHarnessExecutionReadiness({ ...invalidOpenRouter, mode: "fallback" }, { present: true, mechanism: "api_key" }, adapters))
      .toMatchObject({ kind: "unavailable", reason: "provider_native_route_required" });
    expect(resolveNativeHarnessExecutionReadiness({ ...invalidOpenRouter, adapter_id: "anthropic-messages" }, { present: true, mechanism: "api_key" }, adapters))
      .toMatchObject({ kind: "unavailable", reason: "provider_native_route_required" });
  });

  it("requires Ollama Cloud credentials without weakening its direct-native route", () => {
    const adapters = createReferenceNativeModelAdapterRegistry(fetch);
    const ollamaCloud = {
      ...complete,
      mode: "native" as const,
      adapter_id: "ollama-native" as const,
      provider_id: "ollama",
      base_url: "https://ollama.com",
      model: "gpt-oss:120b-cloud",
    };
    expect(resolveNativeHarnessExecutionReadiness(ollamaCloud, { present: false, mechanism: "api_key" }, adapters))
      .toMatchObject({ kind: "unavailable", reason: "credential_absent", adapter_id: "ollama-native" });
    expect(resolveNativeHarnessExecutionReadiness(ollamaCloud, { present: true, mechanism: "api_key" }, adapters))
      .toMatchObject({ kind: "direct_native", selected_by: "native" });
    expect(requiresDirectNativeProvider(ollamaCloud)).toBe(true);
  });

  it("projects an expired WIF token as expired with actionable refresh guidance", () => {
    const native = { ...complete, adapter_id: "openai-compatible" as const, provider_id: "openai", base_url: "https://api.openai.com/v1", credential_source: "openai_wif" as const };
    const config = { ...DEFAULT_CONFIG, native };
    const readiness = buildNativeHarnessReadiness({
      config,
      config_view: new ConfigInspectionService({ defaults: DEFAULT_CONFIG, file: { native } }).inspect(),
      credential: { present: false, source: "openai_wif", mechanism: "oauth_bearer", state: "expired", env_var: "OPENAI_WIF_ACCESS_TOKEN" },
      adapters: createReferenceNativeModelAdapterRegistry(fetch),
    });
    expect(readiness).toMatchObject({
      execution: { kind: "unavailable", reason: "credential_expired" },
      credential: { source: "openai_wif", state: "expired", present: false },
      missing_requirements: [{ code: "native_credential_expired", action: expect.stringContaining("Obtain a fresh") }],
    });
  });

  it("ADR-099 §2: names the demotion reason at the point of fallback, not only in doctor's prose", () => {
    const credentialAbsent = buildNativeHarnessReadiness({
      config: DEFAULT_CONFIG,
      config_view: new ConfigInspectionService({ defaults: DEFAULT_CONFIG, file: null }).inspect(),
      credential: { present: false, source: "absent", env_var: null },
      adapters: createReferenceNativeModelAdapterRegistry(fetch),
    });
    expect(credentialAbsent.execution).toEqual({ kind: "connector_fallback", reason: "credential_absent" });
    expect(describeNativeConnectorFallbackDemotion(credentialAbsent)).toBe(
      "Canopy (native) execution is not ready (connector_fallback: credential_absent); campaigns fail closed — no connector runs in its place unless connectors.allow_deprecated admits one. "
      + "Set ARBOR_NATIVE_API_KEY or ANTHROPIC_API_KEY in .env or the process environment; the doctor records only the selected variable name and presence.",
    );

    const forcedFallback = buildNativeHarnessReadiness({
      config: { ...DEFAULT_CONFIG, native: { ...DEFAULT_CONFIG.native, mode: "fallback" } },
      config_view: new ConfigInspectionService({ defaults: DEFAULT_CONFIG, file: null }).inspect(),
      credential: { present: true, source: "env", env_var: "ANTHROPIC_API_KEY" },
      adapters: createReferenceNativeModelAdapterRegistry(fetch),
    });
    expect(describeNativeConnectorFallbackDemotion(forcedFallback)).toBe(
      "Canopy (native) execution is not ready (connector_fallback: forced_by_config); campaigns fail closed — no connector runs in its place unless connectors.allow_deprecated admits one. "
      + "Set native.mode to auto or native to enable direct-native selection.",
    );
  });

  it("treats an expired Codex access token with a stored refresh token as CLI-refreshable", () => {
    const facts = codexCliCredentialFacts({ state: "expired", reason: "expired access", expired_at: "2026-01-01T00:00:00.000Z", refreshable: true }, "/user/.codex/auth.json");
    expect(facts).toMatchObject({ present: true, state: "present", source: "codex_oauth", file_path: "/user/.codex/auth.json" });
    expect(resolveNativeHarnessExecutionReadiness(
      { ...DEFAULT_CONFIG.native, mode: "native", provider_id: "openai", adapter_id: "openai-compatible", base_url: "https://api.openai.com/v1", model: "gpt-test", auth_route: "openai_codex_cli" },
      facts,
      createReferenceNativeModelAdapterRegistry(fetch),
    )).toMatchObject({ kind: "direct_native" });
    expect(codexCliCredentialFacts({ state: "expired", reason: "expired without refresh", expired_at: "2026-01-01T00:00:00.000Z", refreshable: false }, "/user/.codex/auth.json")).toMatchObject({ present: false, state: "expired" });
  });

  it("requires a present Codex CLI session for the OpenAI inference-only auth route", () => {
    const native = { ...DEFAULT_CONFIG.native, mode: "native" as const, provider_id: "openai", adapter_id: "openai-compatible" as const, base_url: "https://api.openai.com/v1", model: "gpt-test", auth_route: "openai_codex_cli" as const };
    const adapters = createReferenceNativeModelAdapterRegistry(fetch);
    expect(resolveNativeHarnessExecutionReadiness(native, { present: false, state: "absent" }, adapters)).toMatchObject({ kind: "unavailable", reason: "credential_absent" });
    expect(resolveNativeHarnessExecutionReadiness(native, { present: false, state: "expired" }, adapters)).toMatchObject({ kind: "unavailable", reason: "credential_expired" });
    expect(resolveNativeHarnessExecutionReadiness(native, { present: true, state: "present" }, adapters)).toMatchObject({ kind: "direct_native" });
    expect(resolveNativeHarnessExecutionReadiness({ ...native, provider_id: "anthropic" }, { present: true }, adapters)).toMatchObject({ kind: "unavailable", reason: "provider_native_route_required" });
  });

  it("admits the explicit stateless Claude Code bridge route without an Arbor OAuth credential", () => {
    const config = { ...DEFAULT_CONFIG, native: { ...DEFAULT_CONFIG.native, mode: "native" as const, auth_route: "claude_code_cli" as const } };
    const readiness = buildNativeHarnessReadiness({
      config,
      config_view: new ConfigInspectionService({ defaults: config, file: null }).inspect(),
      credential: { present: false, source: "absent", env_var: null },
      adapters: createReferenceNativeModelAdapterRegistry(fetch),
    });
    expect(readiness).toMatchObject({ execution: { kind: "direct_native" }, credential: { present: false }, missing_requirements: [] });
    expect(readiness).toMatchObject({
      selection: { auth_route: "claude_code_cli" },
      credential: { required: false, authentication_owner: "claude_code_cli", source: "absent" },
    });
    expect(formatNativeHarnessReadiness(readiness)).toContain("Authentication: claude_code_cli (claude_code_cli)");
  });
});
