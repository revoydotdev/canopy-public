import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadConfigFromString, loadConfigWithProvenance, loadKeymap, resolveConfigScopes, resolveNativeProviderSelection, validateConfig, DEFAULT_CONFIG, DEFAULT_NATIVE_ESTIMATE_MAX_OUTPUT_TOKENS, stripJsonc, type ArborConfig } from "../src/index.js";
import { KEYMAP_SPEC_PREFIX } from "../src/keymap.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "arbor-config-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("loadConfigFromString", () => {
  it("returns defaults for empty string", () => {
    const config = loadConfigFromString("");
    expect(config.tree_search.max_seconds).toBe(0);
    expect(config.agents.crown.model).toBe("auto");
  });

  it("parses a full config", () => {
    const jsonc = JSON.stringify({
      agents: { crown: { model: "gpt-5" } },
      categories: { "seed-quick": { model: "cheap" } },
      tree_search: { max_seconds: 300, min_score: 0.5, exploration_constant: 1.0, convergence_iterations: 3 },
    });
    const config = loadConfigFromString(jsonc);
    expect(config.agents.crown.model).toBe("gpt-5");
    expect(config.tree_search.max_seconds).toBe(300);
  });

  it("merges partial config with defaults", () => {
    const config = loadConfigFromString(JSON.stringify({ agents: { crown: { model: "gpt-5" } } }));
    expect(config.agents.crown.model).toBe("gpt-5");
    expect(config.agents.heartwood.model).toBe("auto");
    expect(config.tree_search.max_seconds).toBe(0);
  });

  it("strips JSONC comments", () => {
    const jsonc = `{
      // this is a comment
      "agents": { "crown": { "model": "gpt-5" } } // inline comment
    }`;
    const config = loadConfigFromString(jsonc);
    expect(config.agents.crown.model).toBe("gpt-5");
  });

  it("strips trailing commas", () => {
    const jsonc = `{"agents": {"crown": {"model": "gpt-5"},},}`;
    expect(() => loadConfigFromString(jsonc)).not.toThrow();
  });

  it("returns defaults for whitespace-only string", () => {
    const config = loadConfigFromString("   \n  ");
    expect(config.tree_search.max_seconds).toBe(0);
    expect(config.agents.crown.model).toBe("auto");
  });

  it("ignores an unknown top-level key (e.g. a stale background_tasks from an old config file)", () => {
    const jsonc = JSON.stringify({
      agents: { crown: { model: "gpt-5" } },
      background_tasks: { default_concurrency: 3 },
    });
    const config = loadConfigFromString(jsonc);
    expect(config.agents.crown.model).toBe("gpt-5");
    expect((config as unknown as Record<string, unknown>).background_tasks).toEqual({ default_concurrency: 3 });
  });
});

describe("validateConfig", () => {
  it("accepts default config", () => {
    const result = validateConfig(DEFAULT_CONFIG);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts bounded stdio and HTTPS MCP server declarations", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.native.mcp_servers = [
      { server_id: "fs", transport: "stdio", command: "fixture-server", args: ["--root", "."], read_only_tools: ["read"] },
      { server_id: "search", transport: "http", url: "https://example.test/mcp", credential_env: "SEARCH_TOKEN" },
    ];
    expect(validateConfig(config)).toEqual({ valid: true, errors: [] });
  });

  it("keeps MCP resources and prompts opt-in while accepting explicit bounded feature gates", () => {
    const defaults = loadConfigFromString(JSON.stringify({ native: { mcp_servers: [{ server_id: "default", transport: "stdio", command: "fixture-server" }] } }));
    expect(defaults.native.mcp_servers?.[0]).not.toHaveProperty("resources");
    expect(defaults.native.mcp_servers?.[0]).not.toHaveProperty("prompts");

    const enabled = loadConfigFromString(JSON.stringify({ native: { mcp_servers: [{ server_id: "docs", transport: "http", url: "https://example.test/mcp", resources: true, prompts: true }] } }));
    expect(enabled.native.mcp_servers?.[0]).toMatchObject({ resources: true, prompts: true });
  });

  it("rejects non-boolean MCP capability opt-ins", () => {
    const result = validateConfig({ ...structuredClone(DEFAULT_CONFIG), native: { ...structuredClone(DEFAULT_CONFIG).native, mcp_servers: [{ server_id: "docs", transport: "stdio", command: "fixture-server", resources: "yes" } as never] } });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("native.mcp_servers[0].resources must be a boolean");
  });

  it("rejects duplicate ids, insecure HTTP, transport drift, and conflicting risk declarations", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.native.mcp_servers = [
      { server_id: "same", transport: "http", url: "http://example.test/mcp", read_only_tools: ["query"], mutating_tools: ["query"] },
      { server_id: "same", transport: "stdio", command: "server" },
    ];
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes("absolute https"))).toBe(true);
    expect(result.errors.some((error) => error.includes("unique"))).toBe(true);
    expect(result.errors.some((error) => error.includes("both read-only and mutating"))).toBe(true);
  });

  it("rejects unknown MCP server fields as catalog drift", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.native.mcp_servers = [{ server_id: "fs", transport: "stdio", command: "server", token: "must-not-be-config" } as never];
    const result = validateConfig(config);
    expect(result.valid).toBe(false); expect(result.errors.some((error) => error.includes("unknown fields") && error.includes("token"))).toBe(true);
  });

  it("accepts a configured native.max_turns and rejects an out-of-bounds one", () => {
    const valid = structuredClone(DEFAULT_CONFIG);
    valid.native.max_turns = 48;
    expect(validateConfig(valid)).toEqual({ valid: true, errors: [] });

    const tooLarge = structuredClone(DEFAULT_CONFIG);
    tooLarge.native.max_turns = 513;
    expect(validateConfig(tooLarge).errors.some((error) => error.includes("native.max_turns"))).toBe(true);

    const nonPositive = structuredClone(DEFAULT_CONFIG);
    nonPositive.native.max_turns = 0;
    expect(validateConfig(nonPositive).errors.some((error) => error.includes("native.max_turns"))).toBe(true);
  });

  it("accepts a boolean native.usage_accounting_enabled and rejects a non-boolean one", () => {
    const valid = structuredClone(DEFAULT_CONFIG);
    valid.native.usage_accounting_enabled = false;
    expect(validateConfig(valid)).toEqual({ valid: true, errors: [] });

    const invalid = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, any>;
    invalid.native.usage_accounting_enabled = "false";
    expect(validateConfig(invalid as unknown as ArborConfig).errors.some((error: string) => error.includes("native.usage_accounting_enabled"))).toBe(true);
  });

  it("defaults the per-request output-token budget to 8,000 so the token budget, not the 4 MiB byte limit, ends a long turn", () => {
    expect(DEFAULT_NATIVE_ESTIMATE_MAX_OUTPUT_TOKENS).toBe(8_000);
    const omitted = loadConfigFromString(JSON.stringify({ native: { usage_budget: { estimate_authority: "bounded", estimate_max_input_tokens: 100_000 } } }));
    expect(validateConfig(omitted)).toEqual({ valid: true, errors: [] });
    expect(omitted.native.usage_budget!.estimate_max_output_tokens).toBeUndefined();
    const zero = structuredClone(omitted);
    zero.native.usage_budget!.estimate_max_output_tokens = 0;
    expect(validateConfig(zero).errors.join("\n")).toContain("estimate_max_output_tokens");
  });

  it("validates every bounded native pricing, budget, and MCP declaration", () => {
    const valid = structuredClone(DEFAULT_CONFIG);
    valid.native.pricing = {
      price_source_id: "operator", observed_at: "2026-08-12T00:00:00Z", provider_id: "provider",
      model_id: "model", currency: "USD", minor_unit_exponent: 2,
      input_minor_units_per_million_tokens: 1, output_minor_units_per_million_tokens: 2,
      cache_read_minor_units_per_million_tokens: 0, cache_write_minor_units_per_million_tokens: 0,
    };
    valid.native.usage_budget = {
      estimate_authority: "bounded", estimate_max_input_tokens: 1, estimate_max_output_tokens: 1,
      max_session_input_tokens: 1, max_session_output_tokens: 1, max_session_cache_read_tokens: 1, max_session_cache_write_tokens: 1, max_session_total_tokens: 4,
      max_campaign_tokens: 3, max_session_cost: { currency: "USD", minor_units: 1, minor_unit_exponent: 2 },
      max_campaign_cost: { currency: "USD", minor_units: 2, minor_unit_exponent: 2 },
    };
    valid.native.transport = { timeout_ms: 120_000, max_response_bytes: 4_194_304 };
    valid.native.mcp_servers = [{
      server_id: "local", transport: "stdio", command: "server", args: ["--safe"], env: { MODE: "test" },
      credential_env: "TOKEN", read_only_tools: ["read"], mutating_tools: ["write"],
    }];
    expect(validateConfig(valid)).toEqual({ valid: true, errors: [] });

    const invalid = structuredClone(valid) as unknown as Record<string, any>;
    invalid.native.pricing = {
      ...invalid.native.pricing, price_source_id: "", observed_at: "not-a-date", minor_unit_exponent: 10,
      input_minor_units_per_million_tokens: -1,
    };
    invalid.native.usage_budget = {
      ...invalid.native.usage_budget, estimate_authority: "", estimate_max_input_tokens: 0,
      max_session_input_tokens: -1, max_session_cache_read_tokens: -1,
      max_session_cost: { currency: "EUR", minor_units: -1, minor_unit_exponent: 10 },
      max_campaign_cost: { currency: "EUR", minor_units: -1, minor_unit_exponent: 10 },
    };
    invalid.native.transport = { timeout_ms: 300_001, max_response_bytes: 8_388_609 };
    invalid.native.mcp_servers = [
      null,
      { server_id: "BAD ID", transport: "stdio", command: "", args: [1], env: { "bad-key": 1 }, credential_env: "bad env", read_only_tools: ["dup", "dup"] },
      { server_id: "http", transport: "http", url: "https://user:secret@example.test", command: "forbidden" },
      { server_id: "unknown", transport: "sse" },
    ];
    const errors = validateConfig(invalid as never).errors.join("\n");
    for (const expected of [
      "pricing requires", "observed_at", "minor_unit_exponent", "pricing rates", "estimate_authority",
      "positive safe", "max_session_cost", "max_campaign_cost", "transport.timeout_ms", "transport.max_response_bytes", "must be an object",
      "server_id", "command is required", "args is invalid", "env is invalid", "credential_env",
      "read_only_tools", "stdio fields", "absolute https", "transport must be",
    ]) expect(errors).toContain(expected);

    const withoutPricing = structuredClone(valid);
    delete withoutPricing.native.pricing;
    expect(validateConfig(withoutPricing).errors.filter((error) => error.includes("requires native.pricing"))).toHaveLength(2);
  });

  it("rejects native mode omissions and oversized MCP server collections", () => {
    const native = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, any>;
    native.native = { ...native.native, mode: "native", provider_id: "", base_url: "", model: "", revision: 1 };
    expect(validateConfig(native as never).errors.join("\n")).toContain("native.provider_id");

    const absent = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, any>;
    delete absent.native;
    expect(validateConfig(absent as never).errors).toContain("native.mode must be \"auto\", \"native\", or \"fallback\"");

    const oversized = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, any>;
    oversized.native.mcp_servers = Array.from({ length: 9 }, (_, index) => ({ server_id: `s${index}`, transport: "stdio", command: "x" }));
    expect(validateConfig(oversized as never).errors).toContain("native.mcp_servers must be an array with at most 8 entries");
  });

  it("accepts explicit web.fetch/web.search capability grants and rejects non-boolean values", () => {
    const granted = structuredClone(DEFAULT_CONFIG);
    granted.native.capabilities = { web_fetch: true, web_search: true };
    granted.native.web_search = { provider: "duckduckgo_lite" };
    expect(validateConfig(granted)).toEqual({ valid: true, errors: [] });

    const badFetch = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, any>;
    badFetch.native.capabilities = { web_fetch: "yes" };
    expect(validateConfig(badFetch as never).errors).toContain("native.capabilities.web_fetch must be boolean when configured");

    const badSearch = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, any>;
    badSearch.native.capabilities = { web_search: 1 };
    expect(validateConfig(badSearch as never).errors).toContain("native.capabilities.web_search must be boolean when configured");
  });

  it("defaults native.capabilities.web_fetch/web_search to unset (deny-by-default)", () => {
    expect(DEFAULT_CONFIG.native.capabilities?.web_fetch).toBeUndefined();
    expect(DEFAULT_CONFIG.native.capabilities?.web_search).toBeUndefined();
  });

  it("rejects an empty or oversized native.web_search.provider", () => {
    const empty = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, any>;
    empty.native.web_search = { provider: "" };
    expect(validateConfig(empty as never).errors).toContain("native.web_search.provider must be a non-empty string of at most 64 characters when configured");

    const oversized = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, any>;
    oversized.native.web_search = { provider: "x".repeat(65) };
    expect(validateConfig(oversized as never).errors).toContain("native.web_search.provider must be a non-empty string of at most 64 characters when configured");
  });

  it("rejects missing agent", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    delete config.agents.crown;
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("crown"))).toBe(true);
  });

  it("accepts max_seconds=0 as disabled and rejects negative values", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.tree_search.max_seconds = 0;
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
    config.tree_search.max_seconds = -1;
    const invalid = validateConfig(config);
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.some((e) => e.includes("max_seconds"))).toBe(true);
  });

  it("rejects missing category", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    delete config.categories["seed-quick"];
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("seed-quick"))).toBe(true);
  });

  it("rejects agent with empty model string", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.agents.crown!.model = "";
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("crown") && e.includes("empty model"))).toBe(true);
  });

  it("rejects agent with whitespace-only model", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.agents.crown!.model = "   ";
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("crown") && e.includes("empty model"))).toBe(true);
  });

  it("rejects category with empty model string", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.categories["seed-quick"]!.model = "";
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("seed-quick") && e.includes("empty model"))).toBe(true);
  });

  it("uses a closed native adapter selection and blocks an unknown transport", () => {
    expect(DEFAULT_CONFIG.native.adapter_id).toBe("anthropic-messages");
    const malformed = {
      ...DEFAULT_CONFIG,
      native: { ...DEFAULT_CONFIG.native, mode: "native" as const, adapter_id: "unshipped-wire" as "openai-compatible" },
    };
    expect(validateConfig(malformed).errors).toContain("native.adapter_id must be one of: openai-compatible, anthropic-messages, aws-bedrock-messages, gcp-vertex-messages, ollama-native");
    expect(resolveNativeProviderSelection(malformed.native)).toEqual({ kind: "unavailable", reason: "native_adapter_unsupported", adapter_id: "unshipped-wire" });
  });

  it("rejects min_score < 0", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.tree_search.min_score = -1;
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("min_score"))).toBe(true);
  });

  it("rejects exploration_constant <= 0", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.tree_search.exploration_constant = 0;
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("exploration_constant"))).toBe(true);
  });

  it("rejects convergence_iterations < 1", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.tree_search.convergence_iterations = 0;
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("convergence_iterations"))).toBe(true);
  });
});

describe("loadConfig from filesystem", () => {
  it("returns defaults when no .arbor/ exists", () => {
    const config = loadConfig(tempDir);
    expect(config.agents.crown.model).toBe("auto");
  });

  it("reads and merges arbor.jsonc", () => {
    writeFileSync(join(tempDir, "arbor.jsonc"), JSON.stringify({
      agents: { crown: { model: "custom-model" } },
    }));
    const config = loadConfig(tempDir);
    expect(config.agents.crown.model).toBe("custom-model");
    expect(config.agents.heartwood.model).toBe("auto");
  });
});

describe("config scope chain (ADR-110)", () => {
  let organizationDir: string;
  let userDir: string;

  beforeEach(() => {
    organizationDir = mkdtempSync(join(tmpdir(), "arbor-config-test-org-"));
    userDir = mkdtempSync(join(tmpdir(), "arbor-config-test-user-"));
  });

  afterEach(() => {
    rmSync(organizationDir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  });

  const scopeEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    ARBOR_ORGANIZATION_CONFIG_DIR: organizationDir,
    ARBOR_USER_CONFIG_DIR: userDir,
    ...extra,
  });

  it("is a no-op layer when no scope file exists anywhere (absent scope == absent project file today)", () => {
    const config = loadConfig(tempDir, scopeEnv());
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("resolves organization < user < project < env precedence over a constructed multi-scope fixture", () => {
    // organization: the weakest file-based scope. Sets a value nothing else touches, and one every later scope overrides.
    writeFileSync(join(organizationDir, "arbor.jsonc"), JSON.stringify({
      kb: { backend: "sqlite" },
      tree_search: { max_seconds: 10 },
    }));
    // user: overrides the organization-set tree_search value, sets one nothing later touches.
    writeFileSync(join(userDir, "arbor.jsonc"), JSON.stringify({
      tree_search: { max_seconds: 20 },
      agents: { crown: { model: "user-model" } },
    }));
    // project: overrides the user-set agents value.
    writeFileSync(join(tempDir, "arbor.jsonc"), JSON.stringify({
      agents: { crown: { model: "project-model" } },
    }));

    const noEnv = loadConfig(tempDir, scopeEnv());
    expect(noEnv.kb.backend).toBe("sqlite"); // organization value survives — nothing overrides it
    expect(noEnv.tree_search.max_seconds).toBe(20); // user overrides organization
    expect(noEnv.agents.crown.model).toBe("project-model"); // project overrides user
    expect(noEnv.agents.heartwood.model).toBe("auto"); // untouched leaf still falls back to defaults

    // env outranks every file-based scope, including project.
    const withEnv = loadConfig(tempDir, scopeEnv({ ARBOR_CONFIG__AGENTS__CROWN__MODEL: "env-model" }));
    expect(withEnv.agents.crown.model).toBe("env-model");
    expect(withEnv.kb.backend).toBe("sqlite"); // env override is scoped to the one leaf; organization still supplies the rest
  });

  it("resolveConfigScopes reports each scope's own path, presence, and raw (unmerged) layer", () => {
    writeFileSync(join(organizationDir, "arbor.jsonc"), JSON.stringify({ kb: { backend: "sqlite" } }));
    // No user-scope file written — user scope must be a no-op, not an error.
    writeFileSync(join(tempDir, "arbor.jsonc"), JSON.stringify({ agents: { crown: { model: "project-model" } } }));

    const resolution = resolveConfigScopes(tempDir, scopeEnv());
    expect(resolution.organization).toMatchObject({ scope: "organization", path: join(organizationDir, "arbor.jsonc"), present: true, layer: { kb: { backend: "sqlite" } } });
    expect(resolution.user).toMatchObject({ scope: "user", path: join(userDir, "arbor.jsonc"), present: false, layer: null });
    expect(resolution.project).toMatchObject({ scope: "project", path: join(tempDir, "arbor.jsonc"), present: true, layer: { agents: { crown: { model: "project-model" } } } });
    expect(resolution.scoped.kb.backend).toBe("sqlite");
    expect(resolution.scoped.agents.crown.model).toBe("project-model");
  });

  it("the organization scope has no configured path at all when ARBOR_ORGANIZATION_CONFIG_DIR is unset", () => {
    const resolution = resolveConfigScopes(tempDir, { ARBOR_USER_CONFIG_DIR: userDir });
    expect(resolution.organization).toEqual({ scope: "organization", path: "", present: false, layer: null });
  });

  it("loadConfigWithProvenance exposes the progressive per-scope merges (organization_only < user_only < file_only)", () => {
    writeFileSync(join(organizationDir, "arbor.jsonc"), JSON.stringify({ tree_search: { max_seconds: 10 } }));
    writeFileSync(join(userDir, "arbor.jsonc"), JSON.stringify({ tree_search: { max_seconds: 20 } }));
    writeFileSync(join(tempDir, "arbor.jsonc"), JSON.stringify({ tree_search: { max_seconds: 30 } }));

    const result = loadConfigWithProvenance(tempDir, scopeEnv({ ARBOR_CONFIG__TREE_SEARCH__MIN_SCORE: "0.9" }));
    expect(result.organization_only.tree_search.max_seconds).toBe(10);
    expect(result.user_only.tree_search.max_seconds).toBe(20);
    expect(result.file_only.tree_search.max_seconds).toBe(30);
    expect(result.effective.tree_search.max_seconds).toBe(30);
    expect(result.effective.tree_search.min_score).toBe(0.9);
    expect(result.env_overrides).toEqual([{ path: "tree_search.min_score", env_var: "ARBOR_CONFIG__TREE_SEARCH__MIN_SCORE" }]);
  });

  it("rejects a shape violation in any scope file, not only the project one", () => {
    writeFileSync(join(organizationDir, "arbor.jsonc"), JSON.stringify({ tree_search: { max_seconds: "not-a-number" } }));
    expect(() => loadConfig(tempDir, scopeEnv())).toThrow("Invalid Arbor config");
  });

  it("rejects prototype-pollution keys layered in from a non-project scope", () => {
    writeFileSync(join(userDir, "arbor.jsonc"), '{"__proto__":{"polluted":true}}');
    expect(() => loadConfig(tempDir, scopeEnv())).toThrow("Unsafe config key");
  });
});

describe("loadKeymap from filesystem", () => {
  it("returns present:false and no diagnostics when arbor.keymap does not exist", () => {
    const result = loadKeymap(tempDir);
    expect(result).toEqual({ present: false, bindings: [], diagnostics: [] });
  });

  it("reads and parses a valid arbor.keymap", () => {
    writeFileSync(join(tempDir, "arbor.keymap"), `${KEYMAP_SPEC_PREFIX}\nctrl-a = "focus palette"`);
    const result = loadKeymap(tempDir);
    expect(result.present).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0].description).toBe("focus palette");
  });

  it("reports diagnostics for a malformed arbor.keymap without throwing", () => {
    writeFileSync(join(tempDir, "arbor.keymap"), `${KEYMAP_SPEC_PREFIX}\ncapslock-a = "bad modifier"`);
    const result = loadKeymap(tempDir);
    expect(result.present).toBe(true);
    expect(result.bindings).toEqual([]);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});

describe("kb.backend config", () => {
  it("defaults to jsonl", () => {
    const config = loadConfigFromString("");
    expect(config.kb.backend).toBe("jsonl");
  });

  it("accepts sqlite backend", () => {
    const config = loadConfigFromString(JSON.stringify({ kb: { backend: "sqlite" } }));
    expect(config.kb.backend).toBe("sqlite");
  });

  it("validates kb.backend must be jsonl or sqlite", () => {
    const config = { ...DEFAULT_CONFIG, kb: { backend: "mongo" as "jsonl" | "sqlite" } };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("kb.backend"))).toBe(true);
  });

  it("accepts jsonl backend in validation", () => {
    expect(validateConfig(DEFAULT_CONFIG).valid).toBe(true);
  });
});

describe("tui.theme config", () => {
  it("is omitted by default (terminal fallback applies)", () => {
    const config = loadConfigFromString("");
    expect(config.tui?.theme).toBeUndefined();
  });

  it("accepts a named theme override", () => {
    const config = loadConfigFromString(JSON.stringify({ tui: { theme: "moss-agate" } }));
    expect(config.tui?.theme).toBe("moss-agate");
  });

  it("round-trips through loadConfig from a real arbor.jsonc file", () => {
    writeFileSync(join(tempDir, "arbor.jsonc"), JSON.stringify({ tui: { theme: "copper-canopy" } }));
    const config = loadConfig(tempDir, {});
    expect(config.tui?.theme).toBe("copper-canopy");
  });

  it("validates tui.theme must be a known catalog name", () => {
    const config = { ...DEFAULT_CONFIG, tui: { theme: "not-a-real-theme" as never } };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("tui.theme"))).toBe(true);
  });

  it("passes validation for every real catalog name", () => {
    for (const theme of ["moss-agate", "verdigris-forge", "sandstone-thicket", "birchwood-frost", "obsidian-fern", "copper-canopy", "slate-orchard"] as const) {
      expect(validateConfig({ ...DEFAULT_CONFIG, tui: { theme } }).valid).toBe(true);
    }
  });

  it("passes validation when tui is omitted entirely", () => {
    expect(validateConfig(DEFAULT_CONFIG).valid).toBe(true);
  });
});

describe("sandbox.confinement config (LR-NH-04)", () => {
  it("is omitted by default (os_best_effort applies at the sandbox broker)", () => {
    const config = loadConfigFromString("");
    expect(config.sandbox?.confinement).toBeUndefined();
  });

  it("accepts an explicit confinement level", () => {
    const config = loadConfigFromString(JSON.stringify({ sandbox: { confinement: "os_required" } }));
    expect(config.sandbox?.confinement).toBe("os_required");
  });

  it("round-trips through loadConfig from a real arbor.jsonc file", () => {
    writeFileSync(join(tempDir, "arbor.jsonc"), JSON.stringify({ sandbox: { confinement: "app_only" } }));
    const config = loadConfig(tempDir, {});
    expect(config.sandbox?.confinement).toBe("app_only");
  });

  it("validates sandbox.confinement must be a known level", () => {
    const config = { ...DEFAULT_CONFIG, sandbox: { confinement: "not-a-real-level" as never } };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("sandbox.confinement"))).toBe(true);
  });

  it("passes validation for every real level", () => {
    for (const confinement of ["off", "app_only", "os_best_effort", "os_required"] as const) {
      expect(validateConfig({ ...DEFAULT_CONFIG, sandbox: { confinement } }).valid).toBe(true);
    }
  });

  it("passes validation when sandbox is omitted entirely", () => {
    expect(validateConfig(DEFAULT_CONFIG).valid).toBe(true);
  });
});

describe("agent compaction/foreground validation (C-06)", () => {
  it("accepts a well-formed compaction and foreground binding", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.agents.crown = {
      model: "auto",
      compaction: { model: "gpt-5-mini" },
      foreground: { modes: ["streaming", "steerable"], inputs: ["task"], outputs: ["summary"] },
    };
    expect(validateConfig(config)).toEqual({ valid: true, errors: [] });
  });

  it("round-trips a well-formed compaction/foreground binding through loadConfigFromString", () => {
    const jsonc = JSON.stringify({
      agents: { crown: { model: "auto", compaction: { model: "gpt-5-mini" }, foreground: { modes: ["promote"], inputs: ["a"], outputs: ["b"] } } },
    });
    const config = loadConfigFromString(jsonc);
    expect(config.agents.crown.compaction).toEqual({ model: "gpt-5-mini" });
    expect(config.agents.crown.foreground).toEqual({ modes: ["promote"], inputs: ["a"], outputs: ["b"] });
  });

  it("rejects a malformed compaction.model (empty string)", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.agents.crown = { model: "auto", compaction: { model: "   " } };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("crown") && e.includes("compaction"))).toBe(true);
  });

  it("rejects a malformed foreground.modes entry outside the closed enum", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.agents.crown = { model: "auto", foreground: { modes: ["not-a-real-mode" as never] } };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("crown") && e.includes("foreground"))).toBe(true);
  });

  it("rejects non-unique foreground.inputs/outputs", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.agents.crown = { model: "auto", foreground: { inputs: ["a", "a"] } };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("crown") && e.includes("foreground"))).toBe(true);
  });
});

describe("stripJsonc", () => {
  it("removes single-line comments", () => {
    expect(stripJsonc('{"a": 1 // comment\n}')).toBe('{"a": 1 \n}');
  });

  it("removes block comments", () => {
    expect(stripJsonc('{"a": /* block */ 1}')).toBe('{"a":  1}');
  });

  it("removes trailing commas before closing brace", () => {
    expect(stripJsonc('{"a": 1,}')).toBe('{"a": 1}');
  });

  it("removes trailing commas before closing bracket", () => {
    expect(stripJsonc('{"a": [1, 2,]}')).toBe('{"a": [1, 2]}');
  });

  it("handles string with only whitespace and comments", () => {
    const result = stripJsonc("   // just a comment\n   /* block */  ");
    expect(result.trim()).toBe("");
  });
});
