import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadConfigWithProvenance, DEFAULT_CONFIG, loadNativeProviderSecretOverlay, nativeProviderCredentialEnvCandidates, NATIVE_PROVIDER_API_KEY_ENV, resolveNativeProviderSelection, validateConfig } from "../src/index.js";
import { loadConfigEnvOverrides, CONFIG_ENV_PREFIX } from "../src/env.js";

/**
 * An explicit `env` object is the whole environment the loader sees, scope
 * directories included (ADR-110). `{}` therefore means "the operator's real
 * `~/.arbor`", which is not hermetic on a configured machine; these point
 * the organization and user scopes at directories that do not exist.
 */
const noOperatorScope = (root: string): NodeJS.ProcessEnv => ({ ARBOR_USER_CONFIG_DIR: join(root, "no-user-scope"), ARBOR_ORGANIZATION_CONFIG_DIR: join(root, "no-organization-scope") });

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "arbor-config-env-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("loadConfigEnvOverrides", () => {
  it("reads no overrides from an env object with none of the ARBOR_CONFIG__* keys", () => {
    const result = loadConfigEnvOverrides({});
    expect(result.overlay).toEqual({});
    expect(result.applied).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it("names the env var as PREFIX__PATH__SEGMENTS, upper-cased, hyphens folded to underscores", () => {
    const result = loadConfigEnvOverrides({ [`${CONFIG_ENV_PREFIX}__KB__BACKEND`]: "sqlite" });
    expect(result.applied).toEqual([{ path: "kb.backend", env_var: "ARBOR_CONFIG__KB__BACKEND" }]);
    expect(result.overlay).toEqual({ kb: { backend: "sqlite" } });
  });

  it("resolves a hyphenated category leaf path", () => {
    const result = loadConfigEnvOverrides({ ARBOR_CONFIG__CATEGORIES__CROWN_STRUCTURAL__MODEL: "gpt-5" });
    expect(result.applied.map((a) => a.path)).toContain("categories.crown-structural.model");
    expect((result.overlay as { categories: { "crown-structural": { model: string } } }).categories["crown-structural"].model).toBe("gpt-5");
  });

  it("makes native provider selection a typed, provenance-addressable overlay", () => {
    const result = loadConfigEnvOverrides({
      ARBOR_CONFIG__NATIVE__MODE: "native",
      ARBOR_CONFIG__NATIVE__BASE_URL: "http://127.0.0.1:4010",
      ARBOR_CONFIG__NATIVE__MODEL: "mock-architect",
    });
    expect(result.overlay).toEqual({ native: { mode: "native", base_url: "http://127.0.0.1:4010", model: "mock-architect" } });
    expect(result.applied.map((entry) => entry.path)).toEqual(["native.mode", "native.base_url", "native.model"]);
  });

  it("overrides native.max_turns as ARBOR_CONFIG__NATIVE__MAX_TURNS", () => {
    const result = loadConfigEnvOverrides({ ARBOR_CONFIG__NATIVE__MAX_TURNS: "48" });
    expect(result.applied).toEqual([{ path: "native.max_turns", env_var: "ARBOR_CONFIG__NATIVE__MAX_TURNS" }]);
    expect((result.overlay as { native: { max_turns: number } }).native.max_turns).toBe(48);
  });

  it("overrides native.capabilities.web_fetch/web_search and native.web_search.provider (deny-by-default network capability leaves)", () => {
    const result = loadConfigEnvOverrides({
      ARBOR_CONFIG__NATIVE__CAPABILITIES__WEB_FETCH: "true",
      ARBOR_CONFIG__NATIVE__CAPABILITIES__WEB_SEARCH: "false",
      ARBOR_CONFIG__NATIVE__WEB_SEARCH__PROVIDER: "duckduckgo_lite",
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.overlay).toEqual({
      native: { capabilities: { web_fetch: true, web_search: false }, web_search: { provider: "duckduckgo_lite" } },
    });
  });

  it("overrides native.usage_accounting_enabled as a coerced boolean", () => {
    const result = loadConfigEnvOverrides({ ARBOR_CONFIG__NATIVE__USAGE_ACCOUNTING_ENABLED: "false" });
    expect(result.applied).toEqual([{ path: "native.usage_accounting_enabled", env_var: "ARBOR_CONFIG__NATIVE__USAGE_ACCOUNTING_ENABLED" }]);
    expect((result.overlay as { native: { usage_accounting_enabled: boolean } }).native.usage_accounting_enabled).toBe(false);
  });

  it("coerces a numeric leaf and applies it", () => {
    const result = loadConfigEnvOverrides({ ARBOR_CONFIG__TREE_SEARCH__MAX_SECONDS: "42" });
    expect((result.overlay as { tree_search: { max_seconds: number } }).tree_search.max_seconds).toBe(42);
    expect(result.diagnostics).toEqual([]);
  });

  it("rejects a non-numeric value for a numeric leaf as a diagnostic, not NaN", () => {
    const result = loadConfigEnvOverrides({ ARBOR_CONFIG__TREE_SEARCH__MAX_SECONDS: "not-a-number" });
    expect(result.overlay).toEqual({});
    expect(result.applied).toEqual([]);
    expect(result.diagnostics.length).toBe(1);
    expect(result.diagnostics[0]).toContain("ARBOR_CONFIG__TREE_SEARCH__MAX_SECONDS");
  });

  it("ignores unrelated env vars entirely", () => {
    const result = loadConfigEnvOverrides({ PATH: "/usr/bin", HOME: "/home/x" });
    expect(result.overlay).toEqual({});
    expect(result.applied).toEqual([]);
  });

  // C-05: DEFAULT_CONFIG.tui = {} has no `theme` key, so a walk over the
  // runtime default object never visits `tui.theme` — a known ArborConfig
  // leaf that just happens to default to an omitted/empty state. The env
  // reader must still resolve it (from the schema, not the runtime default).
  it("resolves a known-but-defaulted-empty leaf (tui.theme) that DEFAULT_CONFIG never seeds", () => {
    const result = loadConfigEnvOverrides({ ARBOR_CONFIG__TUI__THEME: "solar" });
    expect(result.diagnostics).toEqual([]);
    expect(result.applied).toEqual([{ path: "tui.theme", env_var: "ARBOR_CONFIG__TUI__THEME" }]);
    expect(result.overlay).toEqual({ tui: { theme: "solar" } });
  });

  it("resolves a nested optional agent leaf (compaction.model) absent from DEFAULT_CONFIG's agent shape", () => {
    const result = loadConfigEnvOverrides({ ARBOR_CONFIG__AGENTS__CROWN__COMPACTION__MODEL: "gpt-5-mini" });
    expect(result.diagnostics).toEqual([]);
    expect(result.applied).toEqual([{ path: "agents.crown.compaction.model", env_var: "ARBOR_CONFIG__AGENTS__CROWN__COMPACTION__MODEL" }]);
    expect(result.overlay).toEqual({ agents: { crown: { compaction: { model: "gpt-5-mini" } } } });
  });

  it("emits a typed diagnostic for an ARBOR_CONFIG__* path the schema does not know", () => {
    const result = loadConfigEnvOverrides({ ARBOR_CONFIG__NOT_A_REAL_SECTION__FOO: "x" });
    expect(result.applied).toEqual([]);
    expect(result.overlay).toEqual({});
    expect(result.diagnostics.length).toBe(1);
    expect(result.diagnostics[0]).toContain("ARBOR_CONFIG__NOT_A_REAL_SECTION__FOO");
  });

  it("emits a typed diagnostic for an unknown agent name under a known section", () => {
    const result = loadConfigEnvOverrides({ ARBOR_CONFIG__AGENTS__NOT_A_REAL_AGENT__MODEL: "x" });
    expect(result.applied).toEqual([]);
    expect(result.diagnostics.length).toBe(1);
    expect(result.diagnostics[0]).toContain("ARBOR_CONFIG__AGENTS__NOT_A_REAL_AGENT__MODEL");
  });

  // LR-NH-04: resolves the same known-but-defaulted-empty-leaf shape as
  // tui.theme above — DEFAULT_CONFIG.sandbox = {} never seeds `confinement`.
  it("resolves sandbox.confinement (ARBOR_CONFIG__SANDBOX__CONFINEMENT)", () => {
    const result = loadConfigEnvOverrides({ ARBOR_CONFIG__SANDBOX__CONFINEMENT: "os_required" });
    expect(result.diagnostics).toEqual([]);
    expect(result.applied).toEqual([{ path: "sandbox.confinement", env_var: "ARBOR_CONFIG__SANDBOX__CONFINEMENT" }]);
    expect(result.overlay).toEqual({ sandbox: { confinement: "os_required" } });
  });
});

describe("loadConfig applies a known-but-defaulted-empty leaf end to end (C-05)", () => {
  it("ARBOR_CONFIG__TUI__THEME reaches the effective config with env provenance", () => {
    const result = loadConfigWithProvenance(tempDir, { ARBOR_CONFIG__TUI__THEME: "moss-agate" });
    expect(result.effective.tui?.theme).toBe("moss-agate");
    expect(result.env_overrides).toEqual([{ path: "tui.theme", env_var: "ARBOR_CONFIG__TUI__THEME" }]);
    expect(result.file_only.tui?.theme).toBeUndefined();
  });
});

describe("loadConfig with env overrides", () => {
  it("layers env on top of a checked-in file value", () => {
    writeFileSync(join(tempDir, "arbor.jsonc"), JSON.stringify({ kb: { backend: "jsonl" } }), "utf8");
    const config = loadConfig(tempDir, { ARBOR_CONFIG__KB__BACKEND: "sqlite" });
    expect(config.kb.backend).toBe("sqlite");
  });

  it("layers env on top of in-code defaults when no arbor.jsonc exists", () => {
    const config = loadConfig(tempDir, { ARBOR_CONFIG__TREE_SEARCH__MIN_SCORE: "0.75" });
    expect(config.tree_search.min_score).toBe(0.75);
    expect(config.tree_search.max_seconds).toBe(DEFAULT_CONFIG.tree_search.max_seconds);
  });

  it("passing an explicit empty env object disables env overrides", () => {
    const config = loadConfig(tempDir, noOperatorScope(tempDir));
    expect(config).toEqual(DEFAULT_CONFIG);
  });
});

describe("loadConfigWithProvenance", () => {
  it("keeps file_only and env_overlay separately addressable and merges them into effective", () => {
    writeFileSync(join(tempDir, "arbor.jsonc"), JSON.stringify({ tree_search: { max_seconds: 300 } }), "utf8");
    const result = loadConfigWithProvenance(tempDir, { ARBOR_CONFIG__KB__BACKEND: "sqlite" });

    expect(result.file_only.tree_search.max_seconds).toBe(300);
    expect(result.file_only.kb.backend).toBe("jsonl"); // untouched by env in the file-only layer

    expect(result.env_overlay).toEqual({ kb: { backend: "sqlite" } });
    expect(result.env_overrides).toEqual([{ path: "kb.backend", env_var: "ARBOR_CONFIG__KB__BACKEND" }]);

    expect(result.effective.tree_search.max_seconds).toBe(300);
    expect(result.effective.kb.backend).toBe("sqlite");
  });

  it("keeps native selection in config provenance while excluding its API key", () => {
    writeFileSync(join(tempDir, "arbor.jsonc"), JSON.stringify({ native: { mode: "native", provider_id: "mock-openai", base_url: "http://127.0.0.1:4010", model: "architect" } }), "utf8");
    const result = loadConfigWithProvenance(tempDir, { ...noOperatorScope(tempDir), ARBOR_CONFIG__NATIVE__MODEL: "coding", [NATIVE_PROVIDER_API_KEY_ENV]: "never-project-this" });

    expect(result.file_only.native).toEqual({ mode: "native", adapter_id: "anthropic-messages", provider_id: "mock-openai", base_url: "http://127.0.0.1:4010", model: "architect", openrouter_fallback: { enabled: true, model: "claude-haiku-4-5" } });
    expect(result.env_overlay).toEqual({ native: { model: "coding" } });
    expect(result.effective.native.model).toBe("coding");
    expect(JSON.stringify(result)).not.toContain("never-project-this");
  });

  it("reports env_diagnostics for a rejected override without applying it to effective", () => {
    const result = loadConfigWithProvenance(tempDir, { ARBOR_CONFIG__TREE_SEARCH__MAX_SECONDS: "nope" });
    expect(result.env_diagnostics.length).toBe(1);
    expect(result.effective.tree_search.max_seconds).toBe(DEFAULT_CONFIG.tree_search.max_seconds);
  });

  it("with no arbor.jsonc and no env, file_only and effective both equal DEFAULT_CONFIG", () => {
    const result = loadConfigWithProvenance(tempDir, noOperatorScope(tempDir));
    expect(result.file_only).toEqual(DEFAULT_CONFIG);
    expect(result.effective).toEqual(DEFAULT_CONFIG);
    expect(result.env_overlay).toEqual({});
    expect(result.env_overrides).toEqual([]);
  });
});

describe("native provider credential overlay", () => {
  it("provides an environment credential only through an immediate callback", () => {
    const overlay = loadNativeProviderSecretOverlay({ [NATIVE_PROVIDER_API_KEY_ENV]: "opaque-test-key" });
    expect(overlay).toMatchObject({ source: "env", env_var: NATIVE_PROVIDER_API_KEY_ENV, present: true });
    expect(JSON.stringify(overlay)).not.toContain("opaque-test-key");
    expect(overlay.inject((secret) => `Bearer ${secret}`)).toBe("Bearer opaque-test-key");
  });

  it("treats absent or empty credentials as absent rather than a usable API key", () => {
    for (const env of [{}, { [NATIVE_PROVIDER_API_KEY_ENV]: "" }]) {
      const overlay = loadNativeProviderSecretOverlay(env);
      expect(overlay).toMatchObject({ source: "absent", env_var: null, present: false });
      expect(overlay.inject((secret) => secret)).toBeUndefined();
    }
  });

  it("accepts provider-standard names while keeping the generic override authoritative", () => {
    expect(nativeProviderCredentialEnvCandidates("openrouter")).toEqual(["ARBOR_NATIVE_API_KEY", "OPENROUTER_API_KEY"]);
    const provider = loadNativeProviderSecretOverlay({ OPENROUTER_API_KEY: "provider-key" }, "openrouter");
    expect(provider).toMatchObject({ source: "env", env_var: "OPENROUTER_API_KEY", present: true });
    expect(provider.inject((secret) => secret)).toBe("provider-key");

    const overridden = loadNativeProviderSecretOverlay({ ARBOR_NATIVE_API_KEY: "override", OPENROUTER_API_KEY: "provider-key" }, "openrouter");
    expect(overridden.env_var).toBe("ARBOR_NATIVE_API_KEY");
    expect(overridden.inject((secret) => secret)).toBe("override");
  });

  it("loads Ollama Cloud's provider-owned bearer key name", () => {
    expect(nativeProviderCredentialEnvCandidates("ollama")).toEqual(["ARBOR_NATIVE_API_KEY", "OLLAMA_API_KEY"]);
    const overlay = loadNativeProviderSecretOverlay({ OLLAMA_API_KEY: "ollama-cloud-fixture" }, "ollama");
    expect(overlay).toMatchObject({ source: "env", env_var: "OLLAMA_API_KEY", present: true });
    expect(overlay.inject((secret) => secret)).toBe("ollama-cloud-fixture");
    expect(JSON.stringify(overlay)).not.toContain("ollama-cloud-fixture");
  });

  it("supports Hugging Face's canonical HF_TOKEN without projecting it", () => {
    const overlay = loadNativeProviderSecretOverlay({ HF_TOKEN: "hf-secret" }, "huggingface");
    expect(overlay).toMatchObject({ env_var: "HF_TOKEN", present: true });
    expect(JSON.stringify(overlay)).not.toContain("hf-secret");
  });

  it("snapshots the admitted secret instead of re-reading a mutable environment", () => {
    const env = { OPENROUTER_API_KEY: "admitted" };
    const overlay = loadNativeProviderSecretOverlay(env, "openrouter");
    env.OPENROUTER_API_KEY = "mutated";
    expect(overlay.inject((secret) => secret)).toBe("admitted");
  });
});

describe("native provider validation", () => {
  it("requires endpoint and model only for an explicitly required native selection", () => {
    expect(validateConfig(DEFAULT_CONFIG).valid).toBe(true);
    // ADR-099: defaults.ts now ships a complete native.* selection, so
    // switching only `mode` to "native" is no longer itself an error.
    expect(validateConfig({ ...DEFAULT_CONFIG, native: { ...DEFAULT_CONFIG.native, mode: "native" } }).errors).toEqual([]);
    expect(validateConfig({ ...DEFAULT_CONFIG, native: { ...DEFAULT_CONFIG.native, mode: "native", base_url: "", model: "" } }).errors).toEqual([
      "native.base_url must be non-empty when native.mode is \"native\"",
      "native.model must be non-empty when native.mode is \"native\"",
    ]);
  });

  it("makes native/fallback selection explicit without considering a secret", () => {
    // ADR-099 O3: a fresh checkout's shipped defaults (mode: "auto" plus a
    // concrete adapter/provider/base_url/model) resolve to `native`,
    // `selected_by: "auto"` from config alone -- no credential involved.
    expect(resolveNativeProviderSelection(DEFAULT_CONFIG.native)).toEqual({
      kind: "native",
      adapter_id: DEFAULT_CONFIG.native.adapter_id,
      provider_id: DEFAULT_CONFIG.native.provider_id,
      base_url: DEFAULT_CONFIG.native.base_url,
      model: DEFAULT_CONFIG.native.model,
      revision: null,
      selected_by: "auto",
    });
    expect(resolveNativeProviderSelection({ mode: "fallback", adapter_id: "openai-compatible", provider_id: "provider", base_url: "https://provider.invalid", model: "model" })).toEqual({ kind: "fallback", reason: "forced_by_config" });
    expect(resolveNativeProviderSelection({ mode: "native", adapter_id: "openai-compatible", provider_id: "provider", base_url: "https://provider.invalid", model: "model" })).toEqual({ kind: "native", adapter_id: "openai-compatible", provider_id: "provider", base_url: "https://provider.invalid", model: "model", revision: null, selected_by: "native" });
    expect(resolveNativeProviderSelection({ ...DEFAULT_CONFIG.native, mode: "native", model: "" })).toEqual({ kind: "unavailable", reason: "native_selection_incomplete" });
  });

  it("keeps an optional native response revision in non-secret selection provenance", () => {
    const selected = resolveNativeProviderSelection({ mode: "native", adapter_id: "openai-compatible", provider_id: "provider", base_url: "https://provider.invalid", model: "model", revision: "fp_20260809" });
    expect(selected).toMatchObject({ kind: "native", revision: "fp_20260809" });
    expect(validateConfig({ ...DEFAULT_CONFIG, native: { ...DEFAULT_CONFIG.native, revision: "   " } }).errors).toContain("native.revision must be non-empty when configured");
  });
});
