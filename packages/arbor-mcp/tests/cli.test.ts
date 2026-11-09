import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCliRuntime,
  resolvePersistenceDir,
  startStdioSession,
  buildConfigInspection,
  main,
  ShutdownGate,
  OpenCodeProviderCapabilityAdapter,
  parseProviderCapabilities,
  createProductionCampaignLoopConfig,
  deriveProductionExecutionStrategy,
  deriveProductionTaskSkills,
  TASK_SUBCOMMANDS,
} from "../src/cli.js";
import { readFileSync } from "node:fs";
import { LEDGER_ACTIONS, ledgerCommand } from "../src/ledger-command.js";
import { ArborMCPServer } from "../src/server.js";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { TaskComposer } from "../src/task-composer.js";
import { CampaignManager } from "../src/manager.js";
import { EXIT_CODES, exitCodeForGovernanceError, exitCodeForFindings, escalate } from "../src/exit-codes.js";
import type { Action } from "@arbor/core";
import { acquireWriterLock } from "@arbor/core";
import { runCampaign, type LoopExecutor } from "@arbor/opencode";

/** Environment builder matching main()'s expected shape, with fresh streams per call. */
function makeEnv(cwd: string, overrides: Partial<{ persistence_dir: string; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; runtime_factory: (cwd: string, persistenceDir?: string) => ArborRuntime }> = {}) {
  return {
    cwd,
    persistence_dir: overrides.persistence_dir,
    stdin: overrides.stdin ?? new PassThrough(),
    stdout: overrides.stdout ?? new PassThrough(),
    stderr: overrides.stderr ?? new PassThrough(),
    runtime_factory: overrides.runtime_factory,
  };
}

function plannerUnavailableRuntime(cwd: string, persistenceDir?: string): ArborRuntime {
  return new ArborRuntime({
    persistence_dir: resolvePersistenceDir(cwd, persistenceDir),
    workspace_root: cwd,
    task_composer_planner: {
      plan: async () => { throw new Error("deterministic test planner is unavailable"); },
    },
  });
}

describe("capability index CLI discovery", () => {
  it("prints the shared revision-bound index without starting a runtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-capability-cli-"));
    try {
      const env = makeEnv(root);
      const output = collect(env.stdout);
      expect(await main(["capabilities", "--json"], env)).toBe(EXIT_CODES.SUCCESS);
      const index = JSON.parse(output.text()) as { revision: string; mcp_operations: string[] };
      expect(index.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(index.mcp_operations).toContain("arbor_query");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** WA-37: a deterministic, instantly-admittable task composer — no planner
 * or campaign runner round trip — so a `task confirm` CLI dispatch settles
 * synchronously and repeatably. */
function confirmableStubRuntime(cwd: string, persistenceDir?: string): ArborRuntime {
  const dir = resolvePersistenceDir(cwd, persistenceDir);
  const proposal = JSON.stringify({
    summary: "implement the requested change", assumptions: [], questions: [],
    root_action: { description: "deliver the task", estimated_gain: 1, estimated_cost: 1, category: "delivery", delegate_to: "crown" },
    actions: [{ description: "implement and verify", estimated_gain: 1, estimated_cost: 1, category: "delivery", delegate_to: "seed" }],
    acceptance_checks: ["tests pass"], acceptance_mapping: [{ criterion: "tests pass", action_descriptions: ["implement and verify"] }], risk_notes: [],
  });
  const manager = new CampaignManager({ persistence_dir: dir });
  const taskComposer = new TaskComposer({
    manager, persistence_dir: dir,
    planner: { plan: async () => ({ raw_proposal: proposal, session_id: "plan-session", model_identity: "native-test", usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0, cache_write_input_tokens: 0, counter_source: "provider_counter" } }) },
    admission: { admit: async ({ campaign_id }) => ({ campaign_id, job_id: `job-${campaign_id}` }) },
  });
  return new ArborRuntime({ persistence_dir: dir, workspace_root: cwd, manager, task_composer: taskComposer });
}

function collect(stream: PassThrough): { text(): string } {
  let buf = "";
  stream.on("data", (chunk: Buffer) => { buf += chunk.toString(); });
  return { text: () => buf };
}

async function initializeMcp(input: PassThrough, id: string | number = "initialize"): Promise<void> {
  input.write(`${JSON.stringify({
    jsonrpc: "2.0", id, method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "arbor-cli-test", version: "1" },
    },
  })}\n`);
  await new Promise<void>((resolve) => setImmediate(resolve));
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("CLI runtime composition", () => {
  it("roots persistence beneath the requested cwd and rejects escaping paths", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-"));
    try {
      expect(resolvePersistenceDir(root)).toBe(join(root, ".arbor"));
      expect(resolvePersistenceDir(root, "state/arbor")).toBe(join(root, "state", "arbor"));
      expect(() => resolvePersistenceDir(root, "../outside")).toThrow("remain within");
      expect(() => resolvePersistenceDir(root, "/tmp/outside")).toThrow("remain within");
      // Absolute AND contained: accepted. This is the case both the original
      // assertions here and demo.test.ts's pair missed, and it is the one a
      // real caller uses — scripts/demo-window.sh passes <repo>/.arbor
      // absolutely, and a blanket refusal of absolute paths killed the live
      // TUI pane on startup. Containment is the property; absoluteness is not.
      expect(resolvePersistenceDir(root, join(root, ".arbor"))).toBe(join(root, ".arbor"));
      const runtime = createCliRuntime(root);
      expect(runtime.manager.getPersistenceDiagnostics()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("starts without an unsolicited lifecycle message, serializes initialized requests, and closes the injected runtime on session close", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let data = "";
    output.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    const server = new ArborMCPServer(new ArborRuntime());
    const session = await startStdioSession(server, input, output);
    expect(server.runtime.health().state).toBe("started");
    expect(data).toBe("");

    await initializeMcp(input, 0);
    input.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(data).toContain('"id":1');
    expect(data).toContain("arbor_start_campaign");
    const toolListing = data.trim().split("\n").map((line) => JSON.parse(line) as { readonly id?: number; readonly result?: { readonly tools?: readonly Record<string, unknown>[] } }).find((message) => message.id === 1);
    expect(toolListing?.result?.tools).toEqual(expect.arrayContaining([
      // `objectContaining` deep-equals a nested plain object, so the whole
      // annotation record is pinned here rather than just `readOnlyHint`.
      expect.objectContaining({ name: "arbor_query", annotations: { title: "arbor_query", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }),
      expect.objectContaining({ name: "arbor_catalog_search", annotations: { title: "arbor_catalog_search", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }),
    ]));
    await session.close();
    expect(server.runtime.health().state).toBe("closed");
  });

  it("routes arbor_query and arbor_command through the canonical catalog", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let data = "";
    output.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    const server = new ArborMCPServer(new ArborRuntime());
    const session = await startStdioSession(server, input, output);
    await initializeMcp(input, 1);

    // arbor_query → catalog campaign.list
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "arbor_query", params: { input: { kind: "campaign.list", limit: 100 } } })}\n`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(data).toContain('"id":2');
    expect(data).toContain('"ok":true');
    expect(data).toContain('"value"');

    // arbor_command with an invalid kind returns a structured catalog failure.
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "arbor_command", params: { input: { kind: "not.a.real.command" } } })}\n`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(data).toContain('"id":3');
    // The router never throws; it returns ok:false or an accepted:false result.
    expect(data).toMatch(/"ok":false|"error"/);
    await session.close();
  });

  it("refuses normal MCP operations until the client completes initialization", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const outputText = collect(output);
    const session = await startStdioSession(new ArborMCPServer(new ArborRuntime()), input, output);

    input.write('{"jsonrpc":"2.0","id":"early","method":"tools/list"}\n');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(outputText.text()).toContain('"code":-32002');
    expect(outputText.text()).toContain("MCP session is not initialized");

    await initializeMcp(input, "late");
    input.write('{"jsonrpc":"2.0","id":"ready","method":"tools/list"}\n');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(outputText.text()).toContain('"id":"ready"');
    expect(outputText.text()).toContain("arbor_start_campaign");
    await session.close();
  });

  // A-6/A-7: config_inspection and agent_definitions previously had no
  // production caller anywhere — `config.get` returned an empty view and
  // `agent.list` returned an empty registry on every real `arbor-mcp serve`/
  // `webui` invocation regardless of `arbor.jsonc` or the real agent
  // catalog. `createCliRuntime` is the one production composition root for
  // both transports; these assert the fields genuinely arrive there.
  it("A-7: createCliRuntime feeds real agent_definitions — agent.list is no longer an empty registry", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-agents-"));
    try {
      const runtime = createCliRuntime(root);
      const router = new RuntimeCatalogRouter(runtime);
      const result = router.executeQuery({ schema_version: 1, query_id: "agents", query: { kind: "agent.list" } });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      const view = result.value as { definitions: readonly { name: string }[] };
      expect(view.definitions.length).toBeGreaterThan(0);
      expect(view.definitions.map((d) => d.name)).toContain("crown");
      expect(view.definitions.map((d) => d.name)).toContain("lenticel");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("A-6/A-7: createCliRuntime feeds real config_inspection sourced from arbor.jsonc — config.get is no longer always empty", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-config-"));
    try {
      writeFileSync(join(root, "arbor.jsonc"), JSON.stringify({ tree_search: { max_seconds: 42 } }), "utf8");
      const runtime = createCliRuntime(root);
      const router = new RuntimeCatalogRouter(runtime);
      const result = router.executeQuery({ schema_version: 1, query_id: "config", query: { kind: "config.get" } });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      const view = result.value as { leaves: readonly { path: string; value: unknown; source: string }[] };
      const overridden = view.leaves.find((leaf) => leaf.path === "tree_search.max_seconds");
      expect(overridden?.value).toBe(42);
      expect(overridden?.source).toBe("file");
      // An untouched key correctly reports as coming from the in-code default,
      // not from the file — proving the diff-based source labeling is real,
      // not every leaf being mislabeled "file" once any override exists.
      const untouched = view.leaves.find((leaf) => leaf.path === "tree_search.min_score");
      expect(untouched?.source).toBe("default");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // G-07 (ADR-020 remainder): an ARBOR_CONFIG__* env var reaches config.get
  // as its own "env" source, distinct from "file" — and wins over a
  // checked-in arbor.jsonc value for the same leaf, proving createCliRuntime
  // genuinely layers defaults -> file -> env rather than only ever reading
  // the file.
  it("G-07: createCliRuntime threads ARBOR_CONFIG__* env overrides into config_inspection as a distinct 'env' source", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-config-env-"));
    const envVar = "ARBOR_CONFIG__TREE_SEARCH__MAX_SECONDS";
    const previous = process.env[envVar];
    try {
      writeFileSync(join(root, "arbor.jsonc"), JSON.stringify({ tree_search: { max_seconds: 42 } }), "utf8");
      process.env[envVar] = "77";
      const runtime = createCliRuntime(root);
      const router = new RuntimeCatalogRouter(runtime);
      const result = router.executeQuery({ schema_version: 1, query_id: "config-env", query: { kind: "config.get" } });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      const view = result.value as { leaves: readonly { path: string; value: unknown; source: string }[] };
      const leaf = view.leaves.find((l) => l.path === "tree_search.max_seconds");
      expect(leaf?.value).toBe(77);
      expect(leaf?.source).toBe("env");
    } finally {
      if (previous === undefined) delete process.env[envVar]; else process.env[envVar] = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // G-11: `CampaignManagerOptions.kb_backend` genuinely branches KB
  // construction (manager.test.ts proves both backends behave identically
  // once selected), but until now nothing supplied it from `arbor.jsonc` on
  // a real run — createCliRuntime never called loadConfig. This proves the
  // wire is live: an arbor.jsonc requesting the sqlite backend makes the
  // manager eagerly create kb/kb.sqlite at construction time (loadKBFromSqlite
  // creates the file up front, unlike the jsonl path, which only reads), and
  // never the jsonl stream files.
  it("G-11: createCliRuntime threads arbor.jsonc's kb.backend into the CampaignManager it composes", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-kb-backend-"));
    try {
      writeFileSync(join(root, "arbor.jsonc"), JSON.stringify({ kb: { backend: "sqlite" } }), "utf8");
      createCliRuntime(root);
      expect(existsSync(join(root, ".arbor", "kb", "kb.sqlite"))).toBe(true);
      expect(existsSync(join(root, ".arbor", "kb", "failure-modes.jsonl"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("G-11: with no arbor.jsonc, createCliRuntime still defaults to the jsonl backend (no sqlite file materializes)", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-kb-default-"));
    try {
      createCliRuntime(root);
      expect(existsSync(join(root, ".arbor", "kb", "kb.sqlite"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails CLI runtime admission for an unsafe MCP server declaration", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-mcp-invalid-"));
    try {
      writeFileSync(join(root, "arbor.jsonc"), JSON.stringify({ native: { mcp_servers: [{ server_id: "remote", transport: "http", url: "http://example.test/mcp" }] } }), "utf8");
      expect(() => createCliRuntime(root)).toThrow(/https/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("production campaign-run composition derives root capability skills and routes review through the panel", async () => {
    const runtime = new ArborRuntime();
    const campaignId = "production-panel";
    const root: Action = {
      description: "Architecture decision for the campaign boundary",
      estimated_gain: 5,
      estimated_cost: 2,
      category: "architecture",
      delegate_to: "seed",
    };
    expect(runtime.manager.startCampaign(campaignId, "plan.md", root)).toMatchObject({ ok: true });
    expect(runtime.manager.branch(campaignId, "root", [root])).toHaveLength(1);

    // These values originate in the admitted campaign action, not a demo
    // fixture. `routeCategory` contributes crown-structural; raw category
    // and delegate remain available as explicit operator vocabulary.
    expect(deriveProductionTaskSkills(runtime, campaignId)).toEqual(
      expect.arrayContaining(["crown-structural", "architecture", "seed"]),
    );

    const reviewed: string[] = [];
    const config = createProductionCampaignLoopConfig(runtime, campaignId, async (name) => {
      reviewed.push(name);
      return { approved: true, rationale: `${name} approved` };
    });
    expect(config.task_skills).toEqual(expect.arrayContaining(["crown-structural", "architecture", "seed"]));
    expect(config.execution_strategy).toMatchObject({ kind: "direct_single_action" });
    expect(config.panel).toBeDefined();
    expect(config.run_reviewer).toBeDefined();

    // Keep this composition-root regression hermetic: production retains its
    // default isolated worktree setting, while the fake specialist here needs
    // no filesystem mutation. The panel/task-skill fields are unmodified.
    config.use_worktrees = false;
    const events: string[] = [];
    const executor: LoopExecutor = {
      specialize: async () => ({
        output: "completed",
        provenance: { tag: "claimed", claimant: "test-specialist" },
        token_usage: { kind: "unavailable", reason: "test" },
      }),
      review: async () => {
        throw new Error("production config must use panel reviewers, not executor.review");
      },
      log: (event) => events.push(event.type),
    };
    await runCampaign({ manager: runtime.manager, campaign_id: campaignId, executor, config });

    expect(events).not.toContain("capability_routed");
    expect(reviewed).toEqual(expect.arrayContaining(["lenticel", "burl"]));
  });

  it("derives direct, first-verified, and exploratory strategies from admitted plan shape", () => {
    const direct = new ArborRuntime();
    direct.manager.startCampaign("direct", "plan.md", { description: "one task", estimated_gain: 1, estimated_cost: 1, category: "docs", delegate_to: "seed", decomposition_depth: 0 });
    const [directNode] = direct.manager.branch("direct", "root", [{ description: "write", estimated_gain: 1, estimated_cost: 1, category: "docs", delegate_to: "seed", decomposition_depth: 0 }]);
    expect(deriveProductionExecutionStrategy(direct, "direct")).toEqual({ kind: "direct_single_action", node_id: directNode });

    const candidates = new ArborRuntime();
    candidates.manager.startCampaign("candidates", "plan.md", { description: "choose", estimated_gain: 1, estimated_cost: 1, category: "docs", delegate_to: "crown", decomposition_depth: 0 });
    candidates.manager.branch("candidates", "root", [
      { description: "a", estimated_gain: 1, estimated_cost: 1, category: "docs", delegate_to: "seed", decomposition_depth: 0 },
      { description: "b", estimated_gain: 1, estimated_cost: 1, category: "docs", delegate_to: "seed", decomposition_depth: 0 },
    ]);
    expect(deriveProductionExecutionStrategy(candidates, "candidates")).toEqual({ kind: "tree_search" });

    const exploratory = new ArborRuntime();
    exploratory.manager.startCampaign("explore", "plan.md", { description: "explore", estimated_gain: 1, estimated_cost: 1, category: "architecture", delegate_to: "crown", decomposition_depth: 2 });
    exploratory.manager.branch("explore", "root", [{ description: "investigate", estimated_gain: 1, estimated_cost: 1, category: "architecture", delegate_to: "seed", decomposition_depth: 1 }]);
    expect(deriveProductionExecutionStrategy(exploratory, "explore")).toEqual({ kind: "tree_search" });
  });

  it("buildConfigInspection: with no arbor.jsonc present, every leaf reports the in-code default source", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-noconfig-"));
    try {
      const view = buildConfigInspection(root).inspect();
      expect(view.leaves.length).toBeGreaterThan(0);
      expect(view.leaves.every((leaf) => leaf.source === "default")).toBe(true);
      expect(view.sources.file_present).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("OpenCodeProviderCapabilityAdapter / parseProviderCapabilities (A-7: model_capabilities)", () => {
  it("parseProviderCapabilities extracts real per-model output limits, keyed by providerID/modelID", () => {
    const map = parseProviderCapabilities({
      all: [
        { id: "zhipuai", models: { "glm-5.2": { limit: { context: 1_000_000, output: 131072 } } } },
        { id: "openrouter", models: { "deepseek-v4": { limit: { context: 200_000, output: 8192 } } } },
      ],
    });
    expect(map.get("zhipuai/glm-5.2")).toMatchObject({ context: 1_000_000, output: 131072 });
    expect(map.get("openrouter/deepseek-v4")).toMatchObject({ context: 200_000, output: 8192 });
    expect(map.size).toBe(2);
  });

  it("skips a provider with no id and models with no valid limit dimension", () => {
    const map = parseProviderCapabilities({
      all: [
        { models: { m: { limit: { context: 1, output: 1 } } } }, // no provider id — dropped
        {
          id: "p",
          models: {
            a: {},
            b: { limit: {} },
            c: { limit: { output: 0 } },
            d: { limit: { output: -1 } },
            e: { limit: { output: Number.NaN } },
            f: { limit: { context: 32_000, output: 0 } },
          },
        },
      ],
    });
    expect(map.size).toBe(1);
    expect(map.get("p/f")).toEqual({ context: 32_000, output: null });
  });

  it("an empty body (no `all`) parses to an empty map, not a throw", () => {
    expect(parseProviderCapabilities({}).size).toBe(0);
  });

  it("maxOutputTokens({}) — no model requested — always answers null and never touches the network", async () => {
    let called = false;
    const adapter = new OpenCodeProviderCapabilityAdapter({
      fetchImpl: (async () => { called = true; return new Response("{}"); }) as typeof fetch,
    });
    expect(adapter.maxOutputTokens({})).toBeNull();
    await new Promise((r) => setImmediate(r));
    expect(called).toBe(false);
  });

  it("refresh() against a real fake HTTP response warms the cache; a later maxOutputTokens call for that model returns the live value", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ all: [{ id: "zhipuai", models: { "glm-5.2": { limit: { context: 1_000_000, output: 131072 } } } }] }),
        { status: 200 },
      )) as typeof fetch;
    const adapter = new OpenCodeProviderCapabilityAdapter({ baseUrl: "http://fake.invalid", fetchImpl });
    expect(await adapter.refresh()).toBe(true);
    expect(adapter.maxOutputTokens({ model: "zhipuai/glm-5.2" })).toEqual({ value: 131072, source: "runtime" });
    expect(adapter.contextCapacity({ model: "zhipuai/glm-5.2" })).toEqual({ value: 1_000_000, source: "runtime" });
    expect(adapter.maxOutputTokens({ model: "unknown/unknown" })).toBeNull();
  });

  it("maxOutputTokens lazily warms on the first cache-miss for a real model id — the first call is null, a later call sees the live value", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ all: [{ id: "p", models: { m: { limit: { context: 1, output: 4096 } } } }] }), { status: 200 })) as typeof fetch;
    const adapter = new OpenCodeProviderCapabilityAdapter({ baseUrl: "http://fake.invalid", fetchImpl });
    expect(adapter.maxOutputTokens({ model: "p/m" })).toBeNull(); // triggers a background warm
    for (let i = 0; i < 50 && adapter.maxOutputTokens({ model: "p/m" }) === null; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(adapter.maxOutputTokens({ model: "p/m" })).toEqual({ value: 4096, source: "runtime" });
  });

  it("contextCapacity lazily warms the same model cache and exposes context without deriving it from output", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ all: [{ id: "p", models: { m: { limit: { context: 32_000, output: 4096 } } } }] }), { status: 200 })) as typeof fetch;
    const adapter = new OpenCodeProviderCapabilityAdapter({ baseUrl: "http://fake.invalid", fetchImpl });
    expect(adapter.contextCapacity({ model: "p/m" })).toBeNull();
    for (let i = 0; i < 50 && adapter.contextCapacity({ model: "p/m" }) === null; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(adapter.contextCapacity({ model: "p/m" })).toEqual({ value: 32_000, source: "runtime" });
    expect(adapter.contextCapacity({ model: "p/unknown" })).toBeNull();
  });

  it("refresh() answers false, not a throw, on a non-ok HTTP response", async () => {
    const adapter = new OpenCodeProviderCapabilityAdapter({
      baseUrl: "http://fake.invalid",
      fetchImpl: (async () => new Response("nope", { status: 500 })) as typeof fetch,
    });
    expect(await adapter.refresh()).toBe(false);
  });

  it("refresh() answers false, not a throw, when fetch itself rejects", async () => {
    const adapter = new OpenCodeProviderCapabilityAdapter({
      baseUrl: "http://fake.invalid",
      fetchImpl: (async () => { throw new Error("network down"); }) as typeof fetch,
    });
    expect(await adapter.refresh()).toBe(false);
  });

  it("refresh() answers false on a real spawn failure — no opencode binary at a bogus path, and no baseUrl override", async () => {
    const adapter = new OpenCodeProviderCapabilityAdapter({ opencodeBin: "/definitely/not/a/real/binary/path", timeoutMs: 3_000 });
    expect(await adapter.refresh()).toBe(false);
  }, 10_000);

  it("refresh() end-to-end against a real spawned process: parses the real 'listening on <url>' stdout line, then queries /provider over a real socket", async () => {
    // A tiny real executable standing in for `opencode serve` — prints the
    // exact stdout line `spawnCapabilityServer`'s regex parses, then serves
    // a real GET /provider over a real HTTP server, so this exercises the
    // genuine spawn -> stdout-parse -> fetch round trip end to end, not just
    // the baseUrl-injected fetch path the tests above cover.
    const root = mkdtempSync(join(tmpdir(), "arbor-fake-opencode-serve-"));
    const scriptPath = join(root, "fake-opencode");
    writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env node",
        "const http = require('node:http');",
        "const body = JSON.stringify({ all: [{ id: 'fakeprov', models: { 'fake-model': { limit: { context: 1000, output: 2048 } } } }] });",
        "const server = http.createServer((req, res) => {",
        "  if (req.url && req.url.startsWith('/provider')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); }",
        "  else { res.writeHead(404); res.end(); }",
        "});",
        "server.listen(0, '127.0.0.1', () => {",
        "  const addr = server.address();",
        "  process.stdout.write(`opencode server listening on http://127.0.0.1:${addr.port}\\n`);",
        "});",
        "process.on('SIGTERM', () => process.exit(0));",
      ].join("\n"),
      { mode: 0o755 },
    );
    try {
      const adapter = new OpenCodeProviderCapabilityAdapter({ opencodeBin: scriptPath, timeoutMs: 5_000 });
      const ok = await adapter.refresh();
      expect(ok).toBe(true);
      expect(adapter.maxOutputTokens({ model: "fakeprov/fake-model" })).toEqual({ value: 2048, source: "runtime" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});

describe("main() — CLI command dispatch (real transports, bounded)", () => {
  it("main(['serve']) starts a real MCP session on the given streams and exits cleanly when stdin ends", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-main-serve-"));
    try {
      const stdin = new PassThrough();
      const env = makeEnv(root, { stdin });
      const stdout = collect(env.stdout);
      const donePromise = main(["serve"], env);
      await new Promise((r) => setImmediate(r));
      expect(stdout.text()).toBe("");
      await initializeMcp(stdin, 0);
      expect(stdout.text()).toContain('"protocolVersion"');
      stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
      await new Promise((r) => setImmediate(r));
      expect(stdout.text()).toContain("arbor_start_campaign");
      stdin.end();
      expect(await donePromise).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("WA-10: main(['serve']) defaults to caller_tier junior — a mutating arbor_command is refused with a capability/tier error and nothing is persisted, but reads still work", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-main-serve-junior-"));
    try {
      const stdin = new PassThrough();
      const env = makeEnv(root, { stdin });
      const stdout = collect(env.stdout);
      const donePromise = main(["serve"], env);
      await new Promise((r) => setImmediate(r));
      await initializeMcp(stdin, 0);

      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "arbor_command", params: { input: { kind: "session.identity.mutate", session_id: "wa10-junior", display_name: "should not persist", provenance: { tag: "claimed", claimant: "test" }, metadata: { operation_id: "wa10-junior-op", idempotency_key: "wa10-junior-op", correlation_id: "wa10-junior-op", actor_id: "test-operator", requested_at: new Date().toISOString() } } } } )}\n`);
      await new Promise((r) => setImmediate(r));
      const afterDenial = stdout.text();
      expect(afterDenial).toContain('"id":1');
      // Denied at the protocol/capability layer, not silently accepted.
      expect(afterDenial).not.toMatch(/"id":1,"result":\{"ok":true/);
      expect(afterDenial).toMatch(/junior|CapabilityError|permission/i);

      // Reads still work for the junior caller.
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "arbor_query", params: { input: { kind: "session.identity.get", session_id: "wa10-junior" } } })}\n`);
      await new Promise((r) => setImmediate(r));
      expect(stdout.text()).toContain('"id":2');
      // Nothing was persisted by the refused mutation.
      expect(stdout.text()).toMatch(/"jsonrpc":"2\.0","id":2,"result":\{"ok":true,"capability":"harness\.session\.read","value":null\}/);

      stdin.end();
      expect(await donePromise).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("WA-10: main(['serve','--trusted-client']) keeps the senior default — the same mutation succeeds", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-main-serve-trusted-"));
    try {
      const stdin = new PassThrough();
      const env = makeEnv(root, { stdin });
      const stdout = collect(env.stdout);
      const donePromise = main(["serve", "--trusted-client"], env);
      await new Promise((r) => setImmediate(r));
      await initializeMcp(stdin, 0);

      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "arbor_command", params: { input: { kind: "session.identity.mutate", session_id: "wa10-trusted", display_name: "trusted write", provenance: { tag: "claimed", claimant: "test" }, metadata: { operation_id: "wa10-trusted-op", idempotency_key: "wa10-trusted-op", correlation_id: "wa10-trusted-op", actor_id: "test-operator", requested_at: new Date().toISOString() } } } })}\n`);
      await new Promise((r) => setImmediate(r));
      expect(stdout.text()).toMatch(/"jsonrpc":"2\.0","id":1,"result":\{"ok":true,"capability":"harness\.session\.write","value":\{"accepted":true/);

      stdin.end();
      expect(await donePromise).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("main(['serve']) with a bound ShutdownGate: an OS-signal trigger closes the session even without stdin ending", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-main-serve-gate-"));
    try {
      const gate = new ShutdownGate(0); // 0ms ack — proves the real interrupt+ack round-trip without a slow wait
      const donePromise = main(["serve"], makeEnv(root), gate);
      await new Promise((r) => setImmediate(r));
      gate.trigger();
      expect(await donePromise).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("main(['webui','0']) starts the real dashboard on an ephemeral port, reports it on stderr, and stops cleanly on a gate trigger", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-main-webui-"));
    try {
      const env = makeEnv(root);
      const stderr = collect(env.stderr);
      const gate = new ShutdownGate(0); // real trigger; 0ms ack avoids a slow wait
      const donePromise = main(["webui", "0"], env, gate);
      // Poll for the real "listening" callback before shutting down — starting
      // and stopping the server are both genuinely async (webui.start's
      // onReady callback fires once the HTTP server is actually listening).
      for (let i = 0; i < 100 && !stderr.text().includes("operator session:"); i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(stderr.text()).toMatch(/Arbor web dashboard operator session: http:\/\/127\.0\.0\.1:\d+\/\?operator_token=[A-Za-z0-9_-]+/);
      gate.trigger();
      expect(await donePromise).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("main(['webui']) with no port arg, and with a non-numeric/out-of-range port, both fall back to an ephemeral port (0), not a thrown error", async () => {
    for (const args of [["webui"], ["webui", "notanumber"], ["webui", "-1"], ["webui", "99999"]]) {
      const root = mkdtempSync(join(tmpdir(), "arbor-cli-main-webui-port-"));
      try {
        const env = makeEnv(root);
        const stderr = collect(env.stderr);
        const gate = new ShutdownGate(0);
        const donePromise = main(args, env, gate);
        for (let i = 0; i < 100 && !stderr.text().includes("running at"); i++) {
          await new Promise((r) => setTimeout(r, 5));
        }
        gate.trigger();
        expect(await donePromise).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  // (f)/Q5: a writer-lock conflict on `webui` must print an actionable
  // stderr message naming both the holder and the exact lock file, not just
  // a bare exit code, before returning CONFLICT.
  it("main(['webui']) refuses with an actionable holder+lock-path message on a writer-lock conflict", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-main-webui-conflict-"));
    try {
      const persistence = resolvePersistenceDir(root);
      const held = acquireWriterLock(persistence, { holder: "other-writer-under-test" });
      expect(held.ok).toBe(true);
      if (!held.ok) return;
      try {
        const env = makeEnv(root);
        const stderr = collect(env.stderr);
        const gate = new ShutdownGate(0);
        const code = await main(["webui", "0"], env, gate);
        expect(code).toBe(EXIT_CODES.CONFLICT);
        expect(stderr.text()).toContain("other-writer-under-test");
        expect(stderr.text()).toContain(".arbor-writer.lock");
      } finally {
        held.lock.release();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // NOTE: main()'s "run"/"demo" branch (`const { demomain } = await
  // import("./demo.js")`) is deliberately NOT exercised from this file.
  // demo.test.ts's own describe("demomain — ...") block calls `demomain`
  // directly (statically imported there, like every other helper in that
  // file) and covers the same real help/arg-validation branches — no need
  // to duplicate it here via `main()`'s dynamic re-import of the same
  // module.
  //
  // A genuinely surprising thing to know before adding more tests here or
  // in demo.test.ts: **calling `demomain()` at all — even once, even just
  // its `--help` early-return — permanently changes demo.ts's own reported
  // function *denominator*, not just the numerator.** Confirmed by
  // bisection (git-stash-isolating demo.test.ts's changes and diffing raw
  // coverage-final.json): before anything ever called `demomain()`, V8
  // reported only 17 "functions" in demo.ts, 14 covered (82.35%) — V8 lazily
  // parses function bodies, so the ~20 closures nested inside `demomain`'s
  // interactive-loop body (connect/disconnect/onScreenChange/pollTick/
  // campaignLoop/etc., past its early-return branches) were never even
  // *discovered* by the coverage collector, let alone counted as uncovered.
  // The instant something calls `demomain()` — regardless of which branch it
  // takes — V8 fully compiles the function and all its nested closures
  // become visible, growing the denominator to the true 37, with those ~20
  // now counted as real, honest misses (15/37 = 40.54%). This is not a
  // regression in tested behavior; it is the coverage tool becoming honest
  // about a pre-existing, much larger gap (`demomain`'s entire interactive
  // TUI/signal-handling/campaign-loop body was never exercised by any test,
  // dynamic-import or otherwise, before this wave). See demo.test.ts's
  // matching note for the numbers and the reasoning for not chasing full
  // coverage of that interactive body (real SIGINT/SIGTERM handlers and
  // process.stdin attachment — too risky to run inside the shared test
  // process). Reported to the coverage-floor owner rather than silently
  // worked around.

  it("main(['devtools','tail']) with no DevTools log on disk reports the miss and returns 1 without starting a watcher", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-main-tail-missing-"));
    try {
      const env = makeEnv(root);
      const stderr = collect(env.stderr);
      const code = await main(["devtools", "tail"], env);
      expect(code).toBe(EXIT_CODES.FAILURE);
      expect(stderr.text()).toContain("No DevTools log at");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("main(['devtools','tail']) with a real log file tails existing + appended lines, then exits cleanly on stdin end", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-main-tail-"));
    try {
      const logDir = join(root, ".arbor", "devtools");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(logDir, { recursive: true });
      const logPath = join(logDir, "devtools.log");
      writeFileSync(logPath, `${JSON.stringify({ ts: "t0", campaign_id: "camp-1", event_kind: "loop.started" })}\n`, "utf8");

      const stdin = new PassThrough();
      stdin.resume(); // put the readable side into flowing mode so `.end()` actually emits "end" below
      const env = makeEnv(root, { stdin });
      const stdout = collect(env.stdout);
      const stderr = collect(env.stderr);
      const donePromise = main(["devtools", "tail"], env);
      await new Promise((r) => setTimeout(r, 20));
      expect(stdout.text()).toContain("camp-1");
      expect(stdout.text()).toContain("loop.started");
      expect(stderr.text()).toContain("Tailing");

      // Append a second line and a filtered-out one for a different campaign.
      appendFileSync(logPath, `${JSON.stringify({ ts: "t1", campaign_id: "camp-1", event_kind: "loop.finished" })}\n`);
      appendFileSync(logPath, "not json at all\n");
      await new Promise((r) => setTimeout(r, 50));
      expect(stdout.text()).toContain("loop.finished");
      expect(stdout.text()).toContain("not json at all");

      stdin.end();
      expect(await donePromise).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("main(['devtools','tail','camp-2']) filters the tail to the given campaign only", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-main-tail-filter-"));
    try {
      const logDir = join(root, ".arbor", "devtools");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(logDir, { recursive: true });
      const logPath = join(logDir, "devtools.log");
      writeFileSync(
        logPath,
        `${JSON.stringify({ ts: "t0", campaign_id: "camp-1", event_kind: "loop.started" })}\n${JSON.stringify({ ts: "t0", campaign_id: "camp-2", event_kind: "loop.started" })}\n`,
        "utf8",
      );
      const stdin = new PassThrough();
      stdin.resume();
      const env = makeEnv(root, { stdin });
      const stdout = collect(env.stdout);
      const donePromise = main(["devtools", "tail", "camp-2"], env);
      await new Promise((r) => setTimeout(r, 20));
      expect(stdout.text()).toContain("camp-2");
      expect(stdout.text()).not.toContain("camp-1");
      stdin.end();
      await donePromise;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("main(['--help']), main(['-h']), and main([]) all print usage and return 0", async () => {
    for (const args of [["--help"], ["-h"], []]) {
      const root = mkdtempSync(join(tmpdir(), "arbor-cli-main-help-"));
      try {
        const env = makeEnv(root);
        const stdout = collect(env.stdout);
        const code = await main(args, env);
        expect(code).toBe(0);
        expect(stdout.text()).toContain("Usage: arbor <command> [options]");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  // D12: the top-level `arbor --help` summary must advertise exactly the
  // subcommands `task`/`ledger` actually dispatch.
  //
  // The first version of this test compared the rendered help against
  // TASK_SUBCOMMANDS/LEDGER_ACTIONS — but the help LINE IS RENDERED FROM those
  // same constants, so it could only ever match itself. Deleting "audit" from
  // LEDGER_ACTIONS entirely left all 61 tests green: the advertised set and the
  // expected set moved together. That is the identical "proves the rendering
  // matches its source, not that the source is true" defect D13 was filed for.
  //
  // Both assertions below use a source INDEPENDENT of the constant:
  //   - task:   `printTaskHelp`'s body is hand-written prose, not generated
  //             from TASK_SUBCOMMANDS, so it is a real second opinion.
  //   - ledger: the dispatcher's own runtime behaviour — an advertised action
  //             that no handler accepts falls to the usage branch.
  it("(D12) every task subcommand the detailed help documents is dispatched", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-help-parity-"));
    try {
      const env = makeEnv(root);
      const stdout = collect(env.stdout);
      expect(await main(["task", "--help"], env)).toBe(0);

      // Hand-written help body -> the subcommands it actually documents.
      const documented = new Set<string>();
      for (const match of stdout.text().matchAll(/^ {2}arbor task ([a-z-]+)/gm)) {
        documented.add(match[1]!);
      }
      expect(documented.size, "parsed no subcommands out of `arbor task --help`").toBeGreaterThan(3);
      expect([...documented].sort()).toEqual([...TASK_SUBCOMMANDS].sort());
      expect(stdout.text()).toContain("starts the work");
      expect(stdout.text()).toContain("--plan");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("(D12) the advertised ledger actions are exactly the ones a branch handles", () => {
    // Derived from an INDEPENDENT source: the dispatcher's own branches in the
    // source file, not the constant the help text is rendered from. Comparing
    // the constant against itself is what let `audit` go unadvertised in the
    // first place, and what let the first version of this test stay green
    // while `audit` was deleted outright.
    const source = readFileSync(new URL("../src/ledger-command.ts", import.meta.url), "utf8");
    const handled = new Set<string>();
    for (const match of source.matchAll(/\baction (?:===|!==) "([a-z-]+)"/g)) handled.add(match[1]!);

    expect(handled.size, "parsed no action branches out of ledger-command.ts").toBeGreaterThan(1);
    expect([...handled].sort()).toEqual([...LEDGER_ACTIONS].sort());
  });

  it("(D12) an unknown ledger action is refused, not silently run", () => {
    let stderr = "";
    const code = ledgerCommand(["definitely-not-an-action"], {
      stdout: { write: () => true } as never,
      stderr: { write: (chunk: string) => ((stderr += chunk), true) } as never,
    } as never);
    expect(stderr).toMatch(/^Usage: arbor-mcp ledger/);
    expect(code).not.toBe(0);
  });

  it("main(['--version']) prints the package version to stdout", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-main-version-"));
    try {
      const env = makeEnv(root);
      const stdout = collect(env.stdout);
      expect(await main(["--version"], env)).toBe(0);
      expect(stdout.text()).toMatch(/^arbor \d+\.\d+\.\d+\n$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("main(['not-a-real-command']) reports the unknown command and returns EXIT_CODES.USAGE (2) — a grammar mistake, not a crash", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-main-unknown-"));
    try {
      const env = makeEnv(root);
      const stderr = collect(env.stderr);
      const code = await main(["not-a-real-command"], env);
      expect(code).toBe(EXIT_CODES.USAGE);
      expect(stderr.text()).toContain("Unknown command: not-a-real-command");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// C2 — the CLI grammar's exit-code registry (ADR-054, adopted per
// docs/adr-governance-audit/09-prior-art-and-self-hosting-roadmap.md §24.2
// P6 / §24.6 Track C). Each test below drives a REAL `main(["governance",
// ...])` call against a real, crafted `decisions/` corpus (the same fixture
// methodology `governance-projection.test.ts` already uses against the real
// 27-record corpus, just against a temp one so a specific finding shape —
// an unresolved proof field, an unparseable record — can be produced
// deterministically) and asserts the actual returned process exit code, not
// merely that `EXIT_CODES` has the right numbers in it.
// ---------------------------------------------------------------------------

/** A minimal, real, parseable ADR record — the baseline every fixture below builds on. */
function cleanAcceptedRecord(number: number, title: string): string {
  return (
    `# ADR-${number}: ${title}\n\n` +
    `**Status:** Accepted\n` +
    `**Date:** 2026-08-05\n\n` +
    `## Context\n\nFixture context for a real governance-command exit-code test.\n\n` +
    `## Decision\n\nFixture decision text.\n\n` +
    `## Consequences\n\nFixture consequences text.\n`
  );
}

/** Same shape, plus a real "## Obligations" section whose one proof comment cites
 *  neither `symbol=` nor `roundtrip=` — `obligation/proof.ts`'s `resolveProofComment`
 *  resolves both to `state: "missing"` purely from the comment's own text (see its
 *  `missingField` branch), with no filesystem/vitest-config dependency at all, so this
 *  is real, deterministic, and portable to any temp repoRoot. Two "missing" fields on
 *  an obligation yields two real `M-B` findings with `severity: "blocker"`
 *  (`obligation/report.ts`), which is the one thing that escalates `governance`'s exit
 *  code to `EXIT_CODES.VIOLATION`. */
function accceptedRecordWithUnresolvedObligation(number: number, title: string): string {
  return (
    `# ADR-${number}: ${title}\n\n` +
    `**Status:** Accepted\n` +
    `**Date:** 2026-08-05\n\n` +
    `## Context\n\nFixture context for a real M-B blocker finding.\n\n` +
    `## Decision\n\nFixture decision text.\n\n` +
    `## Consequences\n\nFixture consequences text.\n\n` +
    `## Obligations\n\n` +
    `### O1 — a fixture obligation whose proof cites nothing resolvable\n\n` +
    `<!-- proof: -->\n`
  );
}

function writeDecisionsCorpus(root: string, files: Record<string, string>): void {
  const decisionsDir = join(root, "decisions");
  mkdirSync(decisionsDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(decisionsDir, name), content, "utf8");
  }
}

describe("main(['governance', ...]) — exit codes are real and derived from the GovernanceResult envelope", () => {
  it("a clean corpus (only a warning-severity POL-04 finding) returns EXIT_CODES.SUCCESS (0), and --json emits the real GovernanceResult<GovernanceSnapshot> envelope", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-gov-success-"));
    try {
      writeDecisionsCorpus(root, { "ADR-901-clean.md": cleanAcceptedRecord(901, "Clean fixture record") });
      const env = makeEnv(root);
      const stdout = collect(env.stdout);
      const code = await main(["governance", "--json"], env);
      expect(code).toBe(EXIT_CODES.SUCCESS);

      const envelope = JSON.parse(stdout.text()) as { ok: boolean; value?: unknown; capability?: unknown };
      expect(envelope.ok).toBe(true);
      expect(typeof envelope.capability).toBe("string");
      const value = envelope.value as { legacy_classification: { total: number }; policy_findings: { rule_id: string; severity: string }[] };
      expect(value.legacy_classification.total).toBe(1);
      // The clean record is accepted with zero obligations => exactly one
      // warning-severity POL-04 finding, no blocker.
      expect(value.policy_findings.some((f) => f.rule_id === "POL-04")).toBe(true);
      expect(value.policy_findings.every((f) => f.severity !== "blocker")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a record with an M-B blocker finding (an unresolved obligation proof) returns EXIT_CODES.VIOLATION (5) — a real violation, never conflated with a crash", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-gov-violation-"));
    try {
      writeDecisionsCorpus(root, {
        "ADR-902-violation.md": accceptedRecordWithUnresolvedObligation(902, "Unresolved obligation fixture"),
      });
      const env = makeEnv(root);
      const stdout = collect(env.stdout);
      const code = await main(["governance", "--json"], env);
      expect(code).toBe(EXIT_CODES.VIOLATION);

      const envelope = JSON.parse(stdout.text()) as { ok: boolean; value: { policy_findings: { rule_id: string; severity: string }[] } };
      expect(envelope.ok).toBe(true);
      const blockers = envelope.value.policy_findings.filter((f) => f.rule_id === "M-B" && f.severity === "blocker");
      expect(blockers.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a corpus with one unparseable record (and no blocker finding) returns EXIT_CODES.PARTIAL (3) — some targets in the corpus scan failed, others succeeded", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-gov-partial-"));
    try {
      writeDecisionsCorpus(root, {
        "ADR-903-clean.md": cleanAcceptedRecord(903, "Clean fixture record"),
        "ADR-904-broken.md": "", // empty file => classifyLegacyRecord reports "unparseable"
      });
      const env = makeEnv(root);
      const stdout = collect(env.stdout);
      const code = await main(["governance", "--json"], env);
      expect(code).toBe(EXIT_CODES.PARTIAL);

      const envelope = JSON.parse(stdout.text()) as {
        ok: boolean;
        value: { legacy_classification: { unparseable: number }; policy_findings: { severity: string }[] };
      };
      expect(envelope.ok).toBe(true);
      expect(envelope.value.legacy_classification.unparseable).toBe(1);
      expect(envelope.value.policy_findings.every((f) => f.severity !== "blocker")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // WA-20: a project with no decisions/ directory has no ADRs at all -- that
  // is a typed absence, not a failure. Before this fix, the raw
  // scanDecisionsCorpus ENOENT surfaced as `{code:"unavailable"}`, which
  // `exitCodeForGovernanceError` maps to EXIT_CODES.FAILURE (1) -- the same
  // code an unexpected crash uses. A project that has simply never adopted
  // ADRs must not read the same as a governance command crashing.
  it("a repo root with no decisions/ directory at all reports a typed absence and returns EXIT_CODES.SUCCESS (0), never FAILURE", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-gov-absence-"));
    try {
      // deliberately no decisions/ subdirectory created under root
      const env = makeEnv(root);
      const stdout = collect(env.stdout);
      const code = await main(["governance", "--json"], env);
      expect(code).toBe(EXIT_CODES.SUCCESS);

      const envelope = JSON.parse(stdout.text()) as { ok: boolean; absence?: boolean; message?: string };
      expect(envelope).toMatchObject({ ok: true, absence: true, message: expect.stringContaining("this project has no ADRs") });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("exit-codes.ts — the exit-code registry's own derivation functions", () => {
  it("EXIT_CODES is the complete, documented registry ADR-054 + this repo's own conventional low codes require", () => {
    expect(EXIT_CODES).toEqual({ SUCCESS: 0, FAILURE: 1, USAGE: 2, PARTIAL: 3, CONFLICT: 4, VIOLATION: 5 });
  });

  it("exitCodeForGovernanceError maps every real GovernanceErrorCode to a distinct, correct bucket", () => {
    expect(exitCodeForGovernanceError("validation")).toBe(EXIT_CODES.USAGE);
    expect(exitCodeForGovernanceError("unavailable")).toBe(EXIT_CODES.FAILURE);
    expect(exitCodeForGovernanceError("internal")).toBe(EXIT_CODES.FAILURE);
    // "conflict"/"permission" are real members of the closed GovernanceErrorCode
    // union (contracts.ts) that no current @arbor/governance function actually
    // returns yet (verified by reading every real GovernanceError construction
    // site in record/corpus.ts, obligation/report.ts, and this package's own
    // internalError) — wired correctly here so the day one does, it is never
    // silently swallowed into FAILURE.
    expect(exitCodeForGovernanceError("conflict")).toBe(EXIT_CODES.CONFLICT);
    expect(exitCodeForGovernanceError("permission")).toBe(EXIT_CODES.VIOLATION);
  });

  it("exitCodeForFindings escalates only on a real blocker-severity finding, using contracts.ts's own Severity vocabulary", () => {
    expect(exitCodeForFindings([])).toBe(EXIT_CODES.SUCCESS);
    expect(exitCodeForFindings([{ severity: "informational" }, { severity: "warning" }])).toBe(EXIT_CODES.SUCCESS);
    expect(exitCodeForFindings([{ severity: "warning" }, { severity: "blocker" }])).toBe(EXIT_CODES.VIOLATION);
  });

  it("escalate() picks the single highest-priority applicable code — VIOLATION beats CONFLICT beats PARTIAL beats SUCCESS", () => {
    expect(escalate([])).toBe(EXIT_CODES.SUCCESS);
    expect(escalate([EXIT_CODES.SUCCESS])).toBe(EXIT_CODES.SUCCESS);
    expect(escalate([EXIT_CODES.PARTIAL, EXIT_CODES.SUCCESS])).toBe(EXIT_CODES.PARTIAL);
    expect(escalate([EXIT_CODES.PARTIAL, EXIT_CODES.CONFLICT])).toBe(EXIT_CODES.CONFLICT);
    expect(escalate([EXIT_CODES.CONFLICT, EXIT_CODES.VIOLATION, EXIT_CODES.PARTIAL])).toBe(EXIT_CODES.VIOLATION);
  });
});

describe("startStdioSession / handleMessage — the remaining JSON-RPC methods", () => {
  it("initialize, resources/list, resources/read, tools/call, and an unknown method all get real, correctly-shaped responses", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const outputText = collect(output);
    const server = new ArborMCPServer(new ArborRuntime());
    const session = await startStdioSession(server, input, output);

    input.write('{"jsonrpc":"2.0","id":10,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"arbor-cli-test","version":"1"}}}\n');
    await new Promise((r) => setImmediate(r));
    expect(outputText.text()).toContain('"id":10');
    expect(outputText.text()).toContain('"protocolVersion"');

    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    await new Promise((r) => setImmediate(r));

    input.write('{"jsonrpc":"2.0","id":11,"method":"resources/list"}\n');
    await new Promise((r) => setImmediate(r));
    expect(outputText.text()).toContain('"id":11');
    expect(outputText.text()).toContain('"resources"');

    // "arbor://frame" is the one concrete (non-templated) resource URI —
    // server.ts special-cases it directly — so resources/read exercises the
    // real read path rather than a `{id}`-templated URI it can't resolve.
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 12, method: "resources/read", params: { uri: "arbor://frame" } })}\n`);
    await new Promise((r) => setImmediate(r));
    expect(outputText.text()).toContain('"id":12');
    expect(outputText.text()).toContain('"contents"');

    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "arbor_start_campaign", arguments: { plan_document: "x", initial_action: { description: "d", estimated_gain: 1, estimated_cost: 1, category: "c", delegate_to: "seed" } } } })}\n`);
    await new Promise((r) => setImmediate(r));
    expect(outputText.text()).toContain('"id":13');

    input.write('{"jsonrpc":"2.0","id":14,"method":"not/a/real/method"}\n');
    await new Promise((r) => setImmediate(r));
    expect(outputText.text()).toContain('"id":14');
    expect(outputText.text()).toContain("Method not found");

    input.write("not valid json at all\n");
    await new Promise((r) => setImmediate(r));
    expect(outputText.text()).toContain("Parse error");

    await session.close();
  });

  it("arbor_command accepts an already-enveloped {command:...} input as well as the bare {kind:...} shorthand", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const outputText = collect(output);
    const server = new ArborMCPServer(new ArborRuntime());
    const session = await startStdioSession(server, input, output);
    await initializeMcp(input, 19);

    input.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 20, method: "arbor_command",
      params: {
        input: {
          schema_version: 1,
          metadata: { operation_id: "test:already-enveloped", idempotency_key: "test:already-enveloped" },
          command: { kind: "not.a.real.command" },
        },
      },
    })}\n`);
    await new Promise((r) => setImmediate(r));
    expect(outputText.text()).toContain('"id":20');
    expect(outputText.text()).toMatch(/"ok":false|"error"/);

    input.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 21, method: "arbor_query",
      params: { input: { schema_version: 1, query_id: "already-enveloped", query: { kind: "campaign.list", limit: 10 } } },
    })}\n`);
    await new Promise((r) => setImmediate(r));
    expect(outputText.text()).toContain('"id":21');
    expect(outputText.text()).toContain('"ok":true');

    await session.close();
  });

  it("WA-11: a malformed devtools_break_on does not wedge the serialized stdio pending chain — tools/list answers promptly right after it", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const outputText = collect(output);
    const server = new ArborMCPServer(new ArborRuntime());
    const session = await startStdioSession(server, input, output);
    await initializeMcp(input, 30);

    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "devtools_break_on", arguments: { kind: "not_a_real_kind" } } } )}\n`);
    input.write('{"jsonrpc":"2.0","id":32,"method":"tools/list"}\n');

    const deadline = Date.now() + 2_000;
    while (!outputText.text().includes('"id":32') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(outputText.text()).toContain('"id":31');
    expect(outputText.text()).toContain('"id":32');
    expect(outputText.text()).toContain("arbor_start_campaign");

    await session.close();
  });

  it("WA-39: a failed tools/call sets isError:true", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const outputText = collect(output);
    const server = new ArborMCPServer(new ArborRuntime());
    const session = await startStdioSession(server, input, output);
    await initializeMcp(input, 40);

    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 41, method: "tools/call", params: { name: "not_a_real_tool", arguments: {} } })}\n`);
    await new Promise((r) => setImmediate(r));
    const parsed = JSON.parse(outputText.text().split("\n").find((line) => line.includes('"id":41'))!);
    expect(parsed.result.isError).toBe(true);
    expect(JSON.parse(parsed.result.content[0].text)).toMatchObject({ ok: false });

    await session.close();
  });

  it("WA-39: a capability/tier denial maps to a JSON-RPC error object, not a wrapped result", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const outputText = collect(output);
    const server = new ArborMCPServer(new ArborRuntime(), { caller_tier: "junior" });
    const session = await startStdioSession(server, input, output);
    await initializeMcp(input, 50);

    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 51, method: "arbor_command", params: { input: { kind: "session.identity.mutate", session_id: "wa39-denied", display_name: "x", provenance: { tag: "claimed", claimant: "test" }, metadata: { operation_id: "op-denied", idempotency_key: "op-denied", correlation_id: "op-denied", actor_id: "test-operator", requested_at: new Date().toISOString() } } } })}\n`);
    await new Promise((r) => setImmediate(r));
    const parsed = JSON.parse(outputText.text().split("\n").find((line) => line.includes('"id":51'))!);
    expect(parsed.result).toBeUndefined();
    expect(parsed.error).toBeDefined();
    expect(parsed.error.message).toMatch(/junior|permission|CapabilityError/i);

    await session.close();
  });

  it("WA-39: a non-capability arbor_command failure stays a wrapped result (ok:false), not a JSON-RPC error", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const outputText = collect(output);
    const server = new ArborMCPServer(new ArborRuntime());
    const session = await startStdioSession(server, input, output);
    await initializeMcp(input, 55);

    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 56, method: "arbor_command", params: { input: { kind: "not.a.real.command" } } })}\n`);
    await new Promise((r) => setImmediate(r));
    const parsed = JSON.parse(outputText.text().split("\n").find((line) => line.includes('"id":56'))!);
    expect(parsed.error).toBeUndefined();
    expect(parsed.result.ok).toBe(false);

    await session.close();
  });

  it("WA-39: an id-less notification other than notifications/initialized is dropped silently — no reply is written", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const outputText = collect(output);
    const server = new ArborMCPServer(new ArborRuntime());
    const session = await startStdioSession(server, input, output);
    await initializeMcp(input, 60);
    const before = outputText.text();

    input.write('{"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n');
    await new Promise((r) => setImmediate(r));
    expect(outputText.text()).toBe(before);

    // Confirm the session is still alive and answering real requests.
    input.write('{"jsonrpc":"2.0","id":61,"method":"tools/list"}\n');
    await new Promise((r) => setImmediate(r));
    expect(outputText.text()).toContain('"id":61');

    await session.close();
  });

  it("initialize with an unsupported protocolVersion selects the server's supported version", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const outputText = collect(output);
    const server = new ArborMCPServer(new ArborRuntime());
    const session = await startStdioSession(server, input, output);

    input.write('{"jsonrpc":"2.0","id":70,"method":"initialize","params":{"protocolVersion":"1999-01-01","capabilities":{},"clientInfo":{"name":"arbor-cli-test","version":"1"}}}\n');
    await new Promise((r) => setImmediate(r));
    const parsed = JSON.parse(outputText.text().split("\n").find((line) => line.includes('"id":70'))!);
    expect(parsed.error).toBeUndefined();
    expect(parsed.result).toMatchObject({ protocolVersion: "2025-06-18" });

    await session.close();
  });
});

describe("ShutdownGate — real interrupt-before-shutdown behaviour", () => {
  it("bind() then trigger(): an in-flight expanding node is genuinely interrupted before the signal resolves", async () => {
    const runtime = new ArborRuntime();
    const started = await runtime.start();
    expect(started.ok).toBe(true);
    const root: Action = { description: "plan", estimated_gain: 10, estimated_cost: 1, category: "root", delegate_to: "crown" };
    runtime.manager.startCampaign("camp-shutdown-1", "plan.md", root);
    const child: Action = { description: "do work", estimated_gain: 5, estimated_cost: 1, category: "work", delegate_to: "seed" };
    runtime.manager.branch("camp-shutdown-1", "root", [child]);
    const snapBefore = runtime.manager.getCampaignSnapshot("camp-shutdown-1")!;
    const nodeId = snapBefore.nodes.find((n) => n.state === "pending")!.id;

    const gate = new ShutdownGate(0);
    gate.bind(runtime);
    gate.trigger();
    await gate.signal;

    const snapAfter = runtime.manager.getCampaignSnapshot("camp-shutdown-1")!;
    const node = snapAfter.nodes.find((n) => n.id === nodeId)!;
    expect(node.state).toBe("interrupted");
    await runtime.close();
  });

  it("trigger() before bind(): the deferred execute() still runs once bind() supplies the runtime", async () => {
    const runtime = new ArborRuntime();
    await runtime.start();
    const gate = new ShutdownGate(0);
    gate.trigger(); // runtime not yet bound
    gate.bind(runtime); // must now run execute() itself
    await gate.signal;
    await runtime.close();
  });

  it("trigger() is idempotent — a second call is a no-op, signal still resolves exactly once", async () => {
    const runtime = new ArborRuntime();
    await runtime.start();
    const gate = new ShutdownGate(0);
    gate.bind(runtime);
    gate.trigger();
    gate.trigger();
    await expect(gate.signal).resolves.toBeUndefined();
    await runtime.close();
  });

  it("a halted campaign is skipped by the interrupt sweep — trigger() still resolves cleanly", async () => {
    const runtime = new ArborRuntime();
    await runtime.start();
    const root: Action = { description: "plan", estimated_gain: 10, estimated_cost: 1, category: "root", delegate_to: "crown" };
    runtime.manager.startCampaign("camp-shutdown-halted", "plan.md", root);
    runtime.manager.completeAutoHalt("camp-shutdown-halted", "manual");
    const gate = new ShutdownGate(0);
    gate.bind(runtime);
    gate.trigger();
    await expect(gate.signal).resolves.toBeUndefined();
    await runtime.close();
  });

  it("bind() without a prior trigger() does not start shutdown on its own", async () => {
    const runtime = new ArborRuntime();
    await runtime.start();
    const gate = new ShutdownGate(0);
    gate.bind(runtime);
    let resolved = false;
    void gate.signal.then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);
    await runtime.close();
  });
});

describe("main(['task', ...]) — canonical task composition", () => {
  it("submits and lists durable drafts through the CLI catalog surface", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-task-composer-"));
    try {
      const stdout = new PassThrough();
      const out = collect(stdout);
      // ADR-062: force the governed tier so this test keeps exercising the
      // planner-unavailable path deterministically, rather than the cheap
      // heuristic arbiter's own (also legitimate) direct/reviewed shortcut.
      expect(await main(["task", "draft a bounded task", "--tier", "governed", "--json"], makeEnv(root, { stdout, runtime_factory: plannerUnavailableRuntime }))).toBe(EXIT_CODES.FAILURE);
      const submitted = JSON.parse(out.text());
      expect(submitted).toMatchObject({ ok: true, capability: "taskcomposer.write", value: { accepted: true, draft: { task: "draft a bounded task", source: "cli", status: "failed" } } });

      const listedOut = new PassThrough();
      const listed = collect(listedOut);
      expect(await main(["task", "list", "--json"], makeEnv(root, { stdout: listedOut }))).toBe(EXIT_CODES.SUCCESS);
      expect(JSON.parse(listed.text())).toMatchObject({ ok: true, capability: "taskcomposer.read", value: { items: [{ task: "draft a bounded task", source: "cli" }] } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A draft that never actually admitted a campaign (here: planning itself
  // failed for lack of a configured native provider, exactly like the
  // "submits and lists" test above) has no `campaign_id`/`job_id` to wait
  // on. `--wait` must be a no-op in that case — the exact same output and
  // exit code as a plain `confirm` — not a hang and not a different shape.
  // Genuinely admitting a campaign requires a live provider (out of reach
  // for a deterministic unit test); this still exercises the real CLI
  // argument parsing, `--wait` flag stripping, and the `awaitConfirmedCampaign`
  // pass-through branch end to end through `main()`.
  it("'confirm --wait' is a no-op pass-through when confirm never started a campaign run", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-task-wait-noop-"));
    try {
      const submitOut = new PassThrough();
      const submitted = collect(submitOut);
      // ADR-062: force governed so this stays deterministic on the planner-
      // unavailable path (see the comment above this test).
      expect(await main(["task", "unreachable without a provider", "--tier", "governed", "--json"], makeEnv(root, { stdout: submitOut, runtime_factory: plannerUnavailableRuntime }))).toBe(EXIT_CODES.FAILURE);
      const draft = JSON.parse(submitted.text()).value.draft as { id: string; revision: number; status: string };
      expect(draft.status).toBe("failed");

      const plainOut = new PassThrough();
      const plain = collect(plainOut);
      const plainCode = await main(["task", "confirm", draft.id, String(draft.revision), "--json"], makeEnv(root, { stdout: plainOut }));

      const waitOut = new PassThrough();
      const waited = collect(waitOut);
      const waitCode = await main(["task", "confirm", draft.id, String(draft.revision), "--wait", "--json"], makeEnv(root, { stdout: waitOut }));

      expect(waitCode).toBe(plainCode);
      expect(waitCode).toBe(EXIT_CODES.CONFLICT);
      const plainResult = JSON.parse(plain.text());
      const waitResult = JSON.parse(waited.text());
      // `operation_id` legitimately differs — each `main()` invocation stamps
      // its own fresh idempotency/operation id — so compare structure and
      // outcome, not full deep equality of the two independent acknowledgements.
      expect(waitResult).toMatchObject({ ok: plainResult.ok, capability: plainResult.capability, value: { accepted: false } });
      expect(waitResult.value.draft).toBeUndefined();
      expect(Object.keys(waitResult)).toEqual(Object.keys(plainResult));
      expect(waitResult.campaign_result).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // WA-37: `task confirm <id> <rev>` must be safely re-runnable. A random
  // per-process idempotency key made a second identical CLI invocation miss
  // the composer's own replay lookup and hit a stale-revision CAS conflict
  // against the campaign the first run had already admitted.
  it("re-running an identical 'task confirm <id> <rev>' replays the same admitted campaign", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-task-confirm-replay-"));
    try {
      const submitOut = new PassThrough();
      const submitted = collect(submitOut);
      expect(await main(["task", "inspect a bounded capability and report findings", "--tier", "direct", "--plan", "--json"], makeEnv(root, { stdout: submitOut, runtime_factory: confirmableStubRuntime }))).toBe(EXIT_CODES.SUCCESS);
      const draft = JSON.parse(submitted.text()).value.draft as { id: string; revision: number; status: string };
      expect(draft.status).toBe("proposed");

      const firstOut = new PassThrough();
      const first = collect(firstOut);
      const firstCode = await main(["task", "confirm", draft.id, String(draft.revision), "--json"], makeEnv(root, { stdout: firstOut, runtime_factory: confirmableStubRuntime }));
      const firstResult = JSON.parse(first.text());
      expect(firstCode).toBe(EXIT_CODES.SUCCESS);
      expect(firstResult).toMatchObject({ ok: true, value: { accepted: true, draft: { status: "admitted" } } });
      const firstCampaignId = firstResult.value.draft.campaign_id;
      expect(typeof firstCampaignId).toBe("string");

      const secondOut = new PassThrough();
      const second = collect(secondOut);
      const secondCode = await main(["task", "confirm", draft.id, String(draft.revision), "--json"], makeEnv(root, { stdout: secondOut, runtime_factory: confirmableStubRuntime }));
      const secondResult = JSON.parse(second.text());
      expect(secondCode).toBe(EXIT_CODES.SUCCESS);
      expect(secondResult).toMatchObject({ ok: true, value: { accepted: true, draft: { status: "admitted", campaign_id: firstCampaignId } } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // WA-68: `task confirm`'s help text and TTY summary must not claim to
  // "approve, execute, and wait" when the draft is already `admitted` —
  // bare `arbor task <text>` (no --plan) already confirmed and waited for
  // every tier, so a later `task confirm <id> <rev>` on that draft is a
  // fast no-op replay, not a fresh approve-and-execute.
  it("(WA-68) 'task --help' documents confirm's replay behavior; the TTY summary reads the same on a fresh confirm and a replay", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-task-confirm-truth-"));
    try {
      const helpOut = new PassThrough();
      const help = collect(helpOut);
      expect(await main(["task", "--help"], makeEnv(root, { stdout: helpOut }))).toBe(EXIT_CODES.SUCCESS);
      expect(help.text()).toContain("already confirms and");
      expect(help.text()).toContain("fast no-op replay");

      const submitOut = new PassThrough();
      const submitted = collect(submitOut);
      expect(await main(["task", "inspect a bounded capability and report findings", "--tier", "direct", "--plan", "--json"], makeEnv(root, { stdout: submitOut, runtime_factory: confirmableStubRuntime }))).toBe(EXIT_CODES.SUCCESS);
      const draft = JSON.parse(submitted.text()).value.draft as { id: string; revision: number; status: string };
      expect(draft.status).toBe("proposed");

      const ttyFirst = new PassThrough() as PassThrough & { isTTY?: boolean }; ttyFirst.isTTY = true;
      const first = collect(ttyFirst);
      expect(await main(["task", "confirm", draft.id, String(draft.revision)], makeEnv(root, { stdout: ttyFirst, runtime_factory: confirmableStubRuntime }))).toBe(EXIT_CODES.SUCCESS);
      expect(first.text()).toContain(`Draft ${draft.id} confirm acknowledged (status: admitted)`);
      expect(first.text()).not.toContain(`Draft ${draft.id} confirmed (status:`);

      // The replay reads identically — neither line overclaims a fresh
      // approve-and-execute happened the second time.
      const ttySecond = new PassThrough() as PassThrough & { isTTY?: boolean }; ttySecond.isTTY = true;
      const second = collect(ttySecond);
      expect(await main(["task", "confirm", draft.id, String(draft.revision)], makeEnv(root, { stdout: ttySecond, runtime_factory: confirmableStubRuntime }))).toBe(EXIT_CODES.SUCCESS);
      expect(second.text()).toContain(`Draft ${draft.id} confirm acknowledged (status: admitted)`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--progress is stripped from task text and writes lifecycle only to stderr", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-task-progress-"));
    try {
      const stdout = new PassThrough(); const out = collect(stdout);
      const stderr = new PassThrough(); const err = collect(stderr);
      await main(["task", "inspect the repository", "--tier", "governed", "--plan", "--json", "--progress"], makeEnv(root, { stdout, stderr, runtime_factory: plannerUnavailableRuntime }));
      const parsed = JSON.parse(out.text());
      expect(parsed.value.draft.task).toBe("inspect the repository");
      expect(err.text()).toContain("[revoy] planning:");
      expect(out.text()).not.toContain("[revoy]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Isolation-guard gap: `--allow-primary-checkout` must be stripped from
  // task text like every other CLI-only flag, never dispatched to the
  // planner as literal task words.
  it("--allow-primary-checkout is stripped from task text", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-task-allow-primary-"));
    try {
      const stdout = new PassThrough(); const out = collect(stdout);
      await main(["task", "inspect the repository", "--allow-primary-checkout", "--plan", "--json"], makeEnv(root, { stdout, runtime_factory: plannerUnavailableRuntime }));
      const parsed = JSON.parse(out.text());
      expect(parsed.value.draft.task).toBe("inspect the repository");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("elevates the latest failed-node reason for no_nodes recovery", async () => {
    const { campaignFailureSummary } = await import("../src/cli.js");
    expect(campaignFailureSummary({ nodes: [{ state: "claimed" }, { state: "failed", specialist_output: "FAILED: isolation gate failed; add generated files to .gitignore" }] } as never)).toContain("isolation gate failed");
    expect(campaignFailureSummary({ nodes: [{ state: "failed", specialist_output: null }] } as never)).toBeNull();
  });

  it("main(['adopt']) lists a captured verified result and applies it to the working tree on --apply", async () => {
    const { spawnSync } = await import("node:child_process");
    const { captureWorktreeResult } = await import("../src/result-adoption.js");
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-adopt-"));
    const worktree = mkdtempSync(join(tmpdir(), "arbor-cli-adopt-wt-"));
    try {
      for (const dir of [root, worktree]) {
        spawnSync("git", ["init", "-q"], { cwd: dir });
        spawnSync("git", ["config", "user.email", "t@t"], { cwd: dir });
        spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
        writeFileSync(join(dir, "seed.txt"), "seed\n");
        spawnSync("git", ["add", "-A"], { cwd: dir });
        spawnSync("git", ["commit", "-qm", "base"], { cwd: dir });
      }
      mkdirSync(join(worktree, "docs"), { recursive: true });
      writeFileSync(join(worktree, "docs", "native-doctor.md"), "# doctor\n");
      captureWorktreeResult({ campaign_id: "camp-1", node_id: "n1", worktree_path: worktree, verified: true, score: 0.9, persistence_dir: join(root, ".arbor") });

      const listStdout = new PassThrough(); const listText = collect(listStdout);
      await main(["adopt", "--campaign", "camp-1"], makeEnv(root, { stdout: listStdout }));
      expect(listText.text()).toContain("verified");
      expect(listText.text()).toContain("docs/native-doctor.md");

      const reviewOut = new PassThrough(); const reviewText = collect(reviewOut);
      expect(await main(["review", "inspect", "--campaign", "camp-1", "--node", "n1", "--side-by-side"], makeEnv(root, { stdout: reviewOut }))).toBe(0);
      expect(reviewText.text()).toContain("# doctor");
      const commentOut = new PassThrough(); const commentText = collect(commentOut);
      expect(await main(["review", "comment", "--campaign", "camp-1", "--node", "n1", "--file", "docs/native-doctor.md", "--line", "1", "--side", "new", "--body", "Keep the heading concrete"], makeEnv(root, { stdout: commentOut }))).toBe(0);
      expect(JSON.parse(commentText.text())).toMatchObject({ value: { accepted: true } });
      const preflightOut = new PassThrough(); const preflightText = collect(preflightOut);
      expect(await main(["review", "preflight", "--campaign", "camp-1", "--node", "n1", "--files", "docs/native-doctor.md"], makeEnv(root, { stdout: preflightOut }))).toBe(0);
      expect(preflightText.text()).toContain('"status": "clean"');

      expect(existsSync(join(root, "docs", "native-doctor.md"))).toBe(false);
      const applyStdout = new PassThrough(); const applyText = collect(applyStdout);
      const code = await main(["adopt", "--campaign", "camp-1", "--apply"], makeEnv(root, { stdout: applyStdout }));
      expect(code).toBe(0);
      expect(applyText.text()).toContain("Adopted node n1");
      expect(existsSync(join(root, "docs", "native-doctor.md"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  // D6 (2026-08-24): a selfhost campaign captures into ITS OWN worktree's
  // `.arbor`, never the target root's. `arbor adopt --campaign X` invoked
  // from the target root used to silently read the (empty) root store and
  // report `captures: []` — indistinguishable from "nothing to adopt" —
  // even though the capture existed a few directories away. Two agents
  // independently misdiagnosed that as "adoption is broken" on 2026-08-24.
  // Root-invoked adopt must instead locate the campaign's real store and
  // report which of three states applies.
  describe("D6: locates a campaign's capture store instead of reporting a bare empty result", () => {
    it("locates a campaign captured only under a selfhost worktree's .arbor and adopts it from the target root", async () => {
      const { spawnSync } = await import("node:child_process");
      const { captureWorktreeResult } = await import("../src/result-adoption.js");
      const root = mkdtempSync(join(tmpdir(), "arbor-cli-d6-root-"));
      const captureSource = mkdtempSync(join(tmpdir(), "arbor-cli-d6-src-"));
      try {
        for (const dir of [root, captureSource]) {
          spawnSync("git", ["init", "-q"], { cwd: dir });
          spawnSync("git", ["config", "user.email", "t@t"], { cwd: dir });
          spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
          writeFileSync(join(dir, "seed.txt"), "seed\n");
          spawnSync("git", ["add", "-A"], { cwd: dir });
          spawnSync("git", ["commit", "-qm", "base"], { cwd: dir });
        }
        // Root's own .arbor never sees this campaign — only the selfhost
        // worktree's .arbor does, exactly as `selfhost.ts` writes captures
        // (`runtime.persistenceRoot` rooted at the worktree, not the target).
        const worktreePersistence = join(root, ".worktrees", "selfhost-run1", ".arbor");
        writeFileSync(join(captureSource, "docs.md"), "# from worktree\n");
        captureWorktreeResult({ campaign_id: "camp-wt", node_id: "n1", worktree_path: captureSource, verified: true, score: 1, persistence_dir: worktreePersistence });

        const listOut = new PassThrough(); const listText = collect(listOut);
        const listCode = await main(["adopt", "--campaign", "camp-wt", "--json"], makeEnv(root, { stdout: listOut }));
        expect(listCode).toBe(0);
        const listed = JSON.parse(listText.text());
        expect(listed).toMatchObject({ ok: true, resolution: "found_in_worktree", persistence_dir: worktreePersistence });
        expect(listed.captures).toHaveLength(1);

        expect(existsSync(join(root, "docs.md"))).toBe(false);
        const applyOut = new PassThrough(); const applyText = collect(applyOut);
        const applyCode = await main(["adopt", "--campaign", "camp-wt", "--apply", "--json"], makeEnv(root, { stdout: applyOut }));
        expect(applyCode).toBe(0);
        const applied = JSON.parse(applyText.text());
        expect(applied).toMatchObject({ ok: true, resolution: "found_in_worktree", persistence_dir: worktreePersistence });
        expect(existsSync(join(root, "docs.md"))).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(captureSource, { recursive: true, force: true });
      }
    });

    it("reports not_found (never a bare empty captures list) for a campaign id that exists nowhere", async () => {
      const { spawnSync } = await import("node:child_process");
      const root = mkdtempSync(join(tmpdir(), "arbor-cli-d6-missing-"));
      try {
        spawnSync("git", ["init", "-q"], { cwd: root });
        const out = new PassThrough(); const text = collect(out);
        const code = await main(["adopt", "--campaign", "never-existed", "--json"], makeEnv(root, { stdout: out }));
        expect(code).toBe(0);
        const parsed = JSON.parse(text.text());
        expect(parsed).toMatchObject({ ok: true, resolution: "not_found", captures: [] });
        expect(parsed.searched).toEqual(expect.arrayContaining([join(root, ".arbor")]));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("distinguishes a present-but-empty campaign (resolution: found) from a not-found one", async () => {
      const { spawnSync } = await import("node:child_process");
      const root = mkdtempSync(join(tmpdir(), "arbor-cli-d6-empty-"));
      try {
        spawnSync("git", ["init", "-q"], { cwd: root });
        // The store directory exists (the campaign ran and captured a store
        // path) but holds no valid capture records — distinct from a
        // campaign id nobody has ever heard of.
        mkdirSync(join(root, ".arbor", "adopt", "camp-empty"), { recursive: true });
        const out = new PassThrough(); const text = collect(out);
        const code = await main(["adopt", "--campaign", "camp-empty", "--json"], makeEnv(root, { stdout: out }));
        expect(code).toBe(0);
        const parsed = JSON.parse(text.text());
        expect(parsed).toMatchObject({ ok: true, resolution: "found", captures: [] });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  // E-8: a successful `arbor adopt --apply` marks that node's waiver outcome
  // (if any) adopted — the one outcome this cycle wires automatically.
  it("main(['adopt', '--apply']) marks a review-waived node's waiver outcome adopted", async () => {
    const { spawnSync } = await import("node:child_process");
    const { captureWorktreeResult } = await import("../src/result-adoption.js");
    const { EvidenceLedger: Ledger, saveLedger: save } = await import("@arbor/audit");
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-adopt-waiver-"));
    const worktree = mkdtempSync(join(tmpdir(), "arbor-cli-adopt-waiver-wt-"));
    try {
      for (const dir of [root, worktree]) {
        spawnSync("git", ["init", "-q"], { cwd: dir });
        spawnSync("git", ["config", "user.email", "t@t"], { cwd: dir });
        spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
        writeFileSync(join(dir, "seed.txt"), "seed\n");
        spawnSync("git", ["add", "-A"], { cwd: dir });
        spawnSync("git", ["commit", "-qm", "base"], { cwd: dir });
      }
      mkdirSync(join(worktree, "docs"), { recursive: true });
      writeFileSync(join(worktree, "docs", "waived.md"), "# waived\n");
      const persistenceDir = join(root, ".arbor");
      captureWorktreeResult({ campaign_id: "camp-waiver", node_id: "n1", worktree_path: worktree, verified: true, score: 0.9, persistence_dir: persistenceDir });

      // Seed a waiver outcome record for n1 directly on the ledger, the same
      // durable shape `manager.ts`'s `journalResult` writes on a review-waived
      // `recordResult`.
      const ledger = new Ledger();
      ledger.record({
        campaign_id: "camp-waiver", node_id: "n1", timestamp: "2026-08-01T00:00:00.000Z",
        action_description: "waived task", action_category: "test", specialist_agent: "seed", critic_agent: "lenticel",
        node_state_before: "expanding", node_state_after: "verified",
        provenance: { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test" },
        specialist_output: "done", critic_verdict_approved: true, critic_root_cause: null,
        score_before: 0, score_after: 1, gates: [], kb_entries_written: [],
      });
      ledger.recordWaiverOutcome({
        campaign_id: "camp-waiver", node_id: "n1", task_category: "test",
        waived_by: "arbiter", waived_reason: "low-risk", waived_at: "2026-08-01T00:00:00.000Z",
        idempotency_key: "n1:waiver",
      });
      save(ledger, persistenceDir, "camp-waiver");

      const applyOut = new PassThrough(); collect(applyOut);
      const code = await main(["adopt", "--campaign", "camp-waiver", "--apply"], makeEnv(root, { stdout: applyOut }));
      expect(code).toBe(0);

      const { loadLedger } = await import("@arbor/audit");
      const reloaded = loadLedger(persistenceDir, "camp-waiver");
      const [outcome] = reloaded.getFoldedWaiverOutcomes("camp-waiver");
      expect(outcome.adopted).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  // D51: re-scoping and applying are distinct commands. The first records a
  // signed manager decision plus a patch-bound authorization; the second must
  // name that exact authorization before it can mutate the target checkout.
  it("main(['adopt']) separately authorizes and applies a mined out-of-scope capture", async () => {
    const { spawnSync } = await import("node:child_process");
    const { captureWorktreeResult, readScopeExpansion } = await import("../src/result-adoption.js");
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-adopt-scope-"));
    const worktree = mkdtempSync(join(tmpdir(), "arbor-cli-adopt-scope-wt-"));
    try {
      for (const dir of [root, worktree]) {
        spawnSync("git", ["init", "-q"], { cwd: dir });
        spawnSync("git", ["config", "user.email", "t@t"], { cwd: dir });
        spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
        writeFileSync(join(dir, "seed.txt"), "seed\n");
        spawnSync("git", ["add", "-A"], { cwd: dir });
        spawnSync("git", ["commit", "-qm", "base"], { cwd: dir });
      }
      writeFileSync(join(worktree, "lib.js"), "module.exports = {};\n");
      writeFileSync(join(worktree, "test.js"), "require('./lib.js');\n");
      const persistenceDir = join(root, ".arbor");
      const manager = new CampaignManager({ persistence_dir: persistenceDir });
      manager.startCampaign("camp-scope", "plan.md", { description: "scope root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" });
      captureWorktreeResult({
        campaign_id: "camp-scope", node_id: "root", worktree_path: worktree, verified: true, score: 0.9,
        declared_write_paths: ["test.js"], scope_provenance: "mined", persistence_dir: persistenceDir,
      });

      const refusedOut = new PassThrough(); const refusedText = collect(refusedOut);
      const refusedCode = await main(["adopt", "--campaign", "camp-scope", "--node", "root", "--apply"], makeEnv(root, { stdout: refusedOut, stderr: refusedOut }));
      expect(refusedCode).not.toBe(0);
      expect(existsSync(join(root, "lib.js"))).toBe(false);
      const refusedMessage = refusedText.text();
      expect(refusedMessage).toContain("lib.js"); // the out-of-scope file
      expect(refusedMessage).toContain("test.js"); // the declared scope
      expect(refusedMessage).toContain("mined");
      expect(refusedMessage).toContain("scope authorization");

      const authorizeOut = new PassThrough(); const authorizeText = collect(authorizeOut);
      const authorizeCode = await main(["adopt", "--campaign", "camp-scope", "--node", "root", "--authorize-scope", "--actor", "operator", "--authorization-id", "scope-auth-cli"], makeEnv(root, { stdout: authorizeOut, stderr: authorizeOut }));
      expect(authorizeCode).toBe(0);
      expect(authorizeText.text()).toContain("Authorized scope expansion scope-auth-cli");
      expect(existsSync(join(root, "lib.js"))).toBe(false);

      const applyOut = new PassThrough(); const applyText = collect(applyOut);
      const applyCode = await main(["adopt", "--campaign", "camp-scope", "--node", "root", "--apply", "--scope-authorization", "scope-auth-cli"], makeEnv(root, { stdout: applyOut, stderr: applyOut }));
      expect(applyCode).toBe(0);
      expect(applyText.text()).toContain("Adopted node root");
      expect(existsSync(join(root, "lib.js"))).toBe(true);

      const expansion = readScopeExpansion(persistenceDir, "camp-scope", "root");
      expect(expansion).toMatchObject({
        campaign_id: "camp-scope", node_id: "root", declared_write_paths: ["test.js"],
        acknowledged_paths: ["lib.js"], scope_provenance: "mined", authorization_id: "scope-auth-cli",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  // U1: a task string starting with "-" must never be dispatched as literal
  // task text to the planner (the field-observed `arbor task --help` defect:
  // a real ~19s planner call for what was plainly a help request). There is
  // no seam to inject a planner spy through `main()` (the real planner is
  // composed deep inside `createCliRuntime`, gated behind live provider/
  // connector config this unit test intentionally has none of), so this
  // proves the stronger claim directly: no draft was ever recorded for
  // either invocation. A literal-text dispatch (the original defect) always
  // creates one — `submit()` durably persists the draft before planning even
  // starts (task-composer.ts) — so an empty list is direct proof the
  // planner path was never entered.
  it("(U1) '--help'/'-h' print help (exit 0) and other '-' prefixed input is a usage error (exit 2) — neither ever reaches the planner", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-task-flag-guard-"));
    try {
      const helpOut = new PassThrough(); const help = collect(helpOut);
      expect(await main(["task", "--help"], makeEnv(root, { stdout: helpOut }))).toBe(EXIT_CODES.SUCCESS);
      expect(help.text()).toContain("arbor task confirm <draft-id>");
      expect(help.text()).toContain("arbor task follow-up <campaign-id>");

      const hOut = new PassThrough(); const h = collect(hOut);
      expect(await main(["task", "-h"], makeEnv(root, { stdout: hOut }))).toBe(EXIT_CODES.SUCCESS);
      expect(h.text()).toContain("Usage: arbor task <text>");

      const badErr = new PassThrough(); const bad = collect(badErr);
      expect(await main(["task", "--bogus-flag"], makeEnv(root, { stderr: badErr }))).toBe(EXIT_CODES.USAGE);
      expect(bad.text()).toContain("Unknown task option: --bogus-flag");

      const listOut = new PassThrough(); const listed = collect(listOut);
      expect(await main(["task", "list", "--json"], makeEnv(root, { stdout: listOut }))).toBe(EXIT_CODES.SUCCESS);
      expect(JSON.parse(listed.text()).value.items).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // U2: the explicit review-only path still gives a readable plan summary;
  // JSON callers retain the canonical envelope instead of terminal prose.
  it("(U2) prints a human review-only summary on a TTY; --json and non-TTY stay exact JSON", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-task-human-summary-"));
    try {
      const ttyOut = new PassThrough() as PassThrough & { isTTY?: boolean };
      ttyOut.isTTY = true;
      const tty = collect(ttyOut);
      const ttyCode = await main(["task", "fix the typo in docs/guide.md", "--plan"], makeEnv(root, { stdout: ttyOut }));
      expect(ttyCode).toBe(EXIT_CODES.SUCCESS);
      expect(() => JSON.parse(tty.text())).toThrow();
      expect(tty.text()).toContain("Next:");

      const ttyJsonOut = new PassThrough() as PassThrough & { isTTY?: boolean };
      ttyJsonOut.isTTY = true;
      const ttyJson = collect(ttyJsonOut);
      await main(["task", "fix the typo in docs/guide.md", "--plan", "--json"], makeEnv(root, { stdout: ttyJsonOut }));
      const ttyJsonParsed = JSON.parse(ttyJson.text());
      expect(ttyJsonParsed).toMatchObject({ ok: true, value: { accepted: true, draft: { task: "fix the typo in docs/guide.md" } } });

      const plainOut = new PassThrough();
      const plain = collect(plainOut);
      await main(["task", "fix the typo in docs/guide.md", "--plan"], makeEnv(root, { stdout: plainOut }));
      const plainParsed = JSON.parse(plain.text());
      expect(plainParsed).toMatchObject({ ok: true, value: { accepted: true, draft: { task: "fix the typo in docs/guide.md" } } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // S3a: `arbor report --campaign <id>` printed a raw JSON blob even at a
  // TTY, naming node ids and enum strings with no narrative. A TTY human
  // invocation now gets an outcome line plus an id/state/score/root-cause
  // table; --json and non-TTY keep the exact JSON shape unchanged.
  it("(S3a) prints a human campaign-outcome summary on a TTY without --json; --json and non-TTY stay exact JSON", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-report-human-summary-"));
    try {
      const persistence_dir = resolvePersistenceDir(root);
      const runtime = new ArborRuntime({ persistence_dir });
      const rootAction: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
      runtime.manager.startCampaign("report-camp", "plan.md", rootAction);
      const [childId] = runtime.manager.branch("report-camp", "root", [{ ...rootAction, description: "child", delegate_to: "seed" }]);
      if (!childId) throw new Error("child setup failed");
      runtime.manager.recordResult("report-camp", childId, {
        specialist_output: "broke the build",
        specialist_agent: "seed",
        provenance: { tag: "claimed", claimant: "seed" },
        critic_agent: "lenticel",
        critic_approved: false,
        critic_rationale: "does not compile",
        score_ctx: { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 0, total_visits: 1 },
      });
      await runtime.close();

      const ttyOut = new PassThrough() as PassThrough & { isTTY?: boolean };
      ttyOut.isTTY = true;
      const tty = collect(ttyOut);
      const ttyCode = await main(["report", "--campaign", "report-camp"], makeEnv(root, { stdout: ttyOut }));
      expect(ttyCode).toBe(EXIT_CODES.SUCCESS);
      const ttyText = tty.text();
      expect(() => JSON.parse(ttyText)).toThrow();
      expect(ttyText).toContain("Campaign report-camp");
      expect(ttyText).toContain(childId);
      expect(ttyText).toContain("failed");
      expect(ttyText).toContain("does not compile");

      const ttyJsonOut = new PassThrough() as PassThrough & { isTTY?: boolean };
      ttyJsonOut.isTTY = true;
      const ttyJson = collect(ttyJsonOut);
      await main(["report", "--campaign", "report-camp", "--json"], makeEnv(root, { stdout: ttyJsonOut }));
      expect(JSON.parse(ttyJson.text())).toMatchObject({ ok: true, value: { schema: "arbor.run-report/v1", campaign_id: "report-camp" } });

      const plainOut = new PassThrough();
      const plain = collect(plainOut);
      await main(["report", "--campaign", "report-camp"], makeEnv(root, { stdout: plainOut }));
      expect(JSON.parse(plain.text())).toMatchObject({ ok: true, value: { schema: "arbor.run-report/v1", campaign_id: "report-camp" } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // E-8: `arbor report`'s human summary surfaces a one-line waiver-outcome
  // rollup — "waived outcomes: N adopted, M unadjudicated" per the manifest.
  it("(E-8) 'arbor report' human summary includes a waived-outcomes rollup line", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-report-waivers-"));
    try {
      const persistence_dir = resolvePersistenceDir(root);
      const runtime = new ArborRuntime({ persistence_dir });
      const rootAction: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
      runtime.manager.startCampaign("waiver-report-camp", "plan.md", rootAction);
      const [childId] = runtime.manager.branch("waiver-report-camp", "root", [{ ...rootAction, description: "child", delegate_to: "seed" }]);
      if (!childId) throw new Error("child setup failed");
      runtime.manager.expandNode("waiver-report-camp", childId, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
      runtime.manager.recordResult("waiver-report-camp", childId, {
        specialist_output: "done",
        specialist_agent: "seed",
        provenance: { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test" },
        critic_agent: "lenticel",
        critic_approved: true,
        critic_rationale: "ok",
        review_waived: { by: "arbiter", reason: "low-risk direct-tier task" },
        score_ctx: { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 0, total_visits: 1 },
      });
      await runtime.close();

      const ttyOut = new PassThrough() as PassThrough & { isTTY?: boolean };
      ttyOut.isTTY = true;
      const tty = collect(ttyOut);
      const code = await main(["report", "--campaign", "waiver-report-camp"], makeEnv(root, { stdout: ttyOut }));
      expect(code).toBe(EXIT_CODES.SUCCESS);
      expect(tty.text()).toContain("Waived outcomes: 0 adopted, 1 unadjudicated (1 total)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("bestResultNode — ab3 bench: the campaign's answer must survive into campaign_result", () => {
  const node = (id: string, state: string, score: number, output: string | null) => ({
    id, action_description: "", action_category: "", action_delegate: "", action_estimated_gain: 0,
    action_estimated_cost: 0, high_risk_tool_scope: { declared: false, write_path_count: 0, command_argv_count: 0, declaration_hash: null },
    decomposition_depth: null, score, state, parent_id: null, children_ids: [], depth: 0, visit_count: 0,
    provenance_tag: null, provenance: null, specialist_output: output, critic_verdict: null, gate_records: [],
    outcome: null, recovery_attempts: [], memory_mode: "isolated", memory_mode_version: 0,
    kb_entries_extracted: 0, created_at: "2026-08-15T00:00:00.000Z", review_waived: null, critic_retry_count: 0,
  });
  const snapshot = (nodes: unknown[]) => ({
    id: "c", plan_path: "", config: {} as never, root_id: "root", started_at: "", iterations_completed: 1,
    iterations_without_kb_entry: 0, best_score: 0, halted: true, halt_reason: "no_nodes", governance: null,
    decomposed: 0, nodes,
  }) as never;

  it("carries the best node's specialist_output (the read-only investigation's entire deliverable)", async () => {
    const { bestResultNode } = await import("../src/cli.js");
    const best = bestResultNode(snapshot([node("root", "claimed", 0, null), node("n1", "claimed", 0.4, "the FST_ERR listing")]));
    expect(best).toMatchObject({ id: "n1", output: "the FST_ERR listing" });
  });

  it("prefers a verified node over a higher-scoring claimed one", async () => {
    const { bestResultNode } = await import("../src/cli.js");
    const best = bestResultNode(snapshot([node("claimed-hi", "claimed", 0.9, "unverified"), node("v1", "verified", 0.5, "verified answer")]));
    expect(best).toMatchObject({ id: "v1", state: "verified", output: "verified answer" });
  });

  it("bounds an oversized output instead of shipping it whole", async () => {
    const { bestResultNode } = await import("../src/cli.js");
    const best = bestResultNode(snapshot([node("n1", "verified", 1, "x".repeat(9_000))]));
    expect(best?.output?.length).toBeLessThan(8_200);
    expect(best?.output).toContain("[truncated");
  });
});

describe("evidence CLI dispatch — flag parsing and the pure scope/format helpers", () => {
  // The atomic refresh path spawns a subprocess and is exercised end-to-end by
  // the evidence-transaction suite. Here: the CLI's typed usage error (real
  // dispatch, no spawn) and the two pure helpers around it — scope parsing and
  // result formatting — which carry most of the branches in this region.
  it("main(['evidence','refresh','--nonsense']) is a typed usage error, not a crash", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-evidence-flag-"));
    try {
      let err = "";
      const stderr = new PassThrough(); stderr.on("data", (c: Buffer) => { err += c.toString(); });
      const code = await main(["evidence", "refresh", "--nonsense"], makeEnv(root, { stderr }));
      expect(code).toBe(2); // USAGE
      expect(err).toContain("Unknown evidence refresh option");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("main(['evidence','wat']) with a non-refresh subcommand prints usage and exits 2", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-evidence-sub-"));
    try {
      let err = "";
      const stderr = new PassThrough(); stderr.on("data", (c: Buffer) => { err += c.toString(); });
      const code = await main(["evidence", "wat"], makeEnv(root, { stderr }));
      expect(code).toBe(2);
      expect(err).toContain("arbor evidence refresh");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("parseEvidenceRefreshScope handles auto, all, a comma list, and the undefined default", async () => {
    const { parseEvidenceRefreshScope } = await import("../src/cli.js");
    expect(parseEvidenceRefreshScope(undefined)).toBe("auto");
    expect(parseEvidenceRefreshScope("auto")).toBe("auto");
    expect(parseEvidenceRefreshScope("all")).toBe("all");
    expect(parseEvidenceRefreshScope("claim-ledger, determinism-baseline"))
      .toEqual(["claim-ledger", "determinism-baseline"]);
  });

  it("formatEvidenceRefreshResult renders the error branch and a full applied plan", async () => {
    const { formatEvidenceRefreshResult } = await import("../src/cli.js");
    expect(formatEvidenceRefreshResult({
      ok: false, dry_run: false, scope: "auto", stores: [], error: "boom",
      graph_precheck: null, suite_check: { ran: false, green: false, duration_ms: 0, detail: "" },
      remedy_commands: [], commit_before_verify_note: "note",
    } as never)).toContain("could not run: boom");

    const rendered = formatEvidenceRefreshResult({
      ok: false, dry_run: true, scope: ["claim-ledger"], error: null,
      graph_precheck: { ran: true, stale: true, action: "refreshed", detail: "rebuilt", duration_ms: 1 },
      stores: [{ name: "claim-ledger", checked: true, stale: true, action: "refreshed", reason: "ran", remedy_command: "x", duration_ms: 1 }],
      suite_check: { ran: true, green: false, duration_ms: 2, detail: "red" },
      remedy_commands: ["bun run determinism:refresh"], commit_before_verify_note: "commit first",
    } as never);
    expect(rendered).toMatch(/dry run/i);
    expect(rendered).toContain("graph precheck: refreshed");
    expect(rendered).toContain("claim-ledger: refreshed");
    expect(rendered).toContain("suite check: red");
    expect(rendered).toContain("remedy (in order): bun run determinism:refresh");
    expect(rendered).toContain("NOT ok");
  });
});
