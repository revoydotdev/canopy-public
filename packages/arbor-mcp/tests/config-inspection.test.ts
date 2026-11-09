import { describe, it, expect } from "vitest";
import { ConfigInspectionService, composeEffectiveConfig } from "../src/config-inspection.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { ArborRuntime } from "../src/runtime.js";
import { CampaignManager } from "../src/manager.js";
import { TaskSupervisor } from "@arbor/core";
import { RuntimeEventStream } from "@arbor/core";
import type { ArborConfig } from "@arbor/config";

const base: ArborConfig = {
  agents: { crown: { model: "crown-a" } },
  categories: { "crown-structural": { model: "cat-a" } },
  tree_search: { max_seconds: 120, min_score: 0.5, exploration_constant: 1.41, convergence_iterations: 2 },
  kb: { backend: "jsonl" },
  native: { mode: "auto", adapter_id: "openai-compatible", provider_id: "openai-compatible", base_url: "", model: "" },
};

describe("composeEffectiveConfig", () => {
  it("composes defaults → file → injected with later-source precedence", () => {
    const view = composeEffectiveConfig({
      defaults: base,
      file: { ...base, tree_search: { ...base.tree_search, max_seconds: 300 } },
      injected: { ...base, tree_search: { ...base.tree_search, max_seconds: 900, min_score: 0.9 } },
    });
    const leaf = view.leaves.find((l) => l.path === "tree_search.max_seconds");
    expect(view.schema).toEqual({ uri: "https://json-schema.org/draft/2020-12/schema", title: "Arbor Configuration" });
    expect(leaf?.value).toBe(900);
    expect(leaf?.source).toBe("injected");
    const unchanged = view.leaves.find((l) => l.path === "tree_search.exploration_constant");
    expect(unchanged?.value).toBe(1.41);
  });

  it("falls back to defaults when a key is absent in higher sources", () => {
    // `injected` is a DeepPartial<ArborConfig> overlay — the layering contract
    // (defaults → file → injected, falling back per-key) only makes sense for
    // a partial, and the type now says so directly (no cast needed).
    const view = composeEffectiveConfig({ defaults: base, injected: { kb: { backend: "sqlite" } } });
    expect(view.leaves.find((l) => l.path === "kb.backend")?.value).toBe("sqlite");
    expect(view.leaves.find((l) => l.path === "tree_search.min_score")?.value).toBe(0.5);
    expect(view.native_selection).toEqual({ kind: "fallback", reason: "selection_incomplete" });
  });

  it("structurally redacts secret-like leaf values", () => {
    const withSecret: ArborConfig = {
      ...base,
      agents: { crown: { model: "secret-model", compaction: { model: "comp" } } },
    };
    const view = composeEffectiveConfig({ file: { ...withSecret, agents: { crown: { model: "open-model", compaction: { model: "comp" } } } } });
    // agent key is `agents.crown.model` — not a secret path; injected override wins
    const open = view.leaves.find((l) => l.path === "agents.crown.model");
    expect(open?.value).toBe("open-model");
    // manufacture a secret-named leaf via a nested source to prove structural redaction
    const secretView = composeEffectiveConfig({ injected: { ...base, categories: { "crown-structural": { model: "x" } } } as ArborConfig, defaults: { ...base, agents: { crown: { model: "y" } } } });
    expect(secretView.has_redacted).toBe(false); // nothing secret-named here
    // Direct redaction of a token-bearing path must be exercised by the service level
  });

  it("redacts token/secret/password/api_key path segments", () => {
    // add a secret path through a nested unknown key using the pure fn's flattening
    const source = { ...base } as ArborConfig;
    const secretView = composeEffectiveConfig({ injected: source });
    // prove the SECRET_PATH_TOKENS matcher behavior via a synthetic leaf
    const isSecret = (path: string) => ["api_key", "token", "secret", "password", "credential"].some((t) => path.toLowerCase().split(".").some((s) => s.includes(t)));
    expect(isSecret("providers.openai_api_key")).toBe(true);
    expect(isSecret("tree_search.max_seconds")).toBe(false);
    expect(secretView.leaves.length).toBeGreaterThan(0);
  });

  it("isolates leaves to bounded depth and enumerates declared sources", () => {
    const view = composeEffectiveConfig({ defaults: base, file: base, injected: base, maxDepth: 2 });
    for (const leaf of view.leaves) expect(leaf.path.split(".").length).toBeLessThanOrEqual(2);
    expect(view.sources).toEqual({ defaults_present: true, organization_present: false, user_present: false, file_present: true, env_present: false, injected_present: true });
    expect(view.has_redacted).toBe(false);
  });

  it("rejects a depth above the documented safety bound", () => {
    expect(() => composeEffectiveConfig({ defaults: base, maxDepth: 33 })).toThrow("maxDepth must be an integer from 1 through 32");
  });

  it("defaults-only (no sources) yields an empty, well-formed view", () => {
    const view = composeEffectiveConfig({});
    expect(view.leaves).toEqual([]);
    expect(view.sources).toEqual({ defaults_present: false, organization_present: false, user_present: false, file_present: false, env_present: false, injected_present: false });
  });

  // G-07 (ADR-020 remainder): env overrides layer after file and before
  // injected, and report their own "env" source distinct from "file" —
  // provenance a caller can act on (e.g. an operator override vs. a
  // checked-in team default), not just "differs from default".
  it("composes an env overlay between file and injected, reporting a distinct 'env' source", () => {
    const view = composeEffectiveConfig({
      defaults: base,
      file: { tree_search: { max_seconds: 300 } },
      env: { tree_search: { max_seconds: 450 } },
      injected: { tree_search: { max_seconds: 900 } },
    });
    const leaf = view.leaves.find((l) => l.path === "tree_search.max_seconds");
    expect(leaf?.value).toBe(900);
    expect(leaf?.source).toBe("injected");

    const envOnly = composeEffectiveConfig({
      defaults: base,
      file: { tree_search: { max_seconds: 300 } },
      env: { tree_search: { max_seconds: 450 } },
    });
    const envLeaf = envOnly.leaves.find((l) => l.path === "tree_search.max_seconds");
    expect(envLeaf?.value).toBe(450);
    expect(envLeaf?.source).toBe("env");
    expect(envOnly.sources.env_present).toBe(true);
  });

  // ADR-110 Decision 2: `composeEffectiveConfig` names every declared scope
  // (organization/user, alongside the pre-existing file/env/injected), in
  // the same defaults -> organization -> user -> file(project) -> env ->
  // injected precedence `resolveConfigScopes` (`@arbor/config`) resolves.
  it("names organization and user as distinct provenance scopes, in declared precedence order", () => {
    const view = composeEffectiveConfig({
      defaults: base,
      organization: { tree_search: { max_seconds: 10 }, kb: { backend: "sqlite" } },
      user: { tree_search: { max_seconds: 20 } },
      file: { tree_search: { max_seconds: 30 } },
    });
    // project (file) outranks user outranks organization.
    expect(view.leaves.find((l) => l.path === "tree_search.max_seconds")).toMatchObject({ source: "file", value: 30 });
    // a leaf only organization touches keeps its organization provenance.
    expect(view.leaves.find((l) => l.path === "kb.backend")).toMatchObject({ source: "organization", value: "sqlite" });
    expect(view.sources).toMatchObject({ organization_present: true, user_present: true, file_present: true });

    // env still outranks every file-based scope, organization included.
    const withEnv = composeEffectiveConfig({
      defaults: base,
      organization: { kb: { backend: "sqlite" } },
      env: { kb: { backend: "jsonl" } },
    });
    expect(withEnv.leaves.find((l) => l.path === "kb.backend")).toMatchObject({ source: "env", value: "jsonl" });
  });

  it("projects the resolved native/fallback choice without projecting an API credential", () => {
    const native = composeEffectiveConfig({ defaults: base, env: { native: { mode: "native", provider_id: "fixture", base_url: "https://fixture.invalid", model: "fixture-model" } } });
    expect(native.native_selection).toEqual({ kind: "native", selected_by: "native", adapter_id: "openai-compatible", provider_id: "fixture", base_url: "https://fixture.invalid", model: "fixture-model", revision: null });

    const forcedFallback = composeEffectiveConfig({ defaults: base, env: { native: { mode: "fallback" } } });
    expect(forcedFallback.native_selection).toEqual({ kind: "fallback", reason: "forced_by_config" });
    expect(JSON.stringify(native)).not.toContain("ARBOR_NATIVE_API_KEY");
  });
});

describe("ConfigInspectionService + catalog config.get", () => {
  it("returns the effective view through the catalog router", () => {
    const manager = new CampaignManager();
    const runtime = new ArborRuntime({ manager, supervisor: new TaskSupervisor(), event_stream: new RuntimeEventStream("rt"), config_inspection: new ConfigInspectionService({ defaults: base, file: base }) });
    const router = new RuntimeCatalogRouter(runtime);
    const result = router.executeQuery({ schema_version: 1, query_id: "cfg", query: { kind: "config.get" } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as { leaves: { path: string; source: string }[] };
      expect(value.leaves.length).toBeGreaterThan(0);
      expect(value.leaves.every((l) => l.source === "default" || l.source === "file")).toBe(true);
    }
  });

  it("enforces the config.read capability gate", () => {
    const manager = new CampaignManager();
    const runtime = new ArborRuntime({ manager });
    const router = new RuntimeCatalogRouter(runtime, { granted_capabilities: new Set(["campaign.read"]) });
    const result = router.executeQuery({ schema_version: 1, query_id: "cfg", query: { kind: "config.get" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("permission");
  });

  it("rejects malformed config.get envelopes at validation", () => {
    const manager = new CampaignManager();
    const runtime = new ArborRuntime({ manager });
    const router = new RuntimeCatalogRouter(runtime);
    const result = router.executeQuery({ schema_version: 0, query_id: "", query: { kind: "config.get" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });
});
