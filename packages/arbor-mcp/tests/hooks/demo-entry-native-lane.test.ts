/**
 * `arbor run` / `arbor demo` — the campaign composition root that had no
 * native lane, and therefore no hook bus at all.
 *
 * WHY THIS FILE EXISTS. Ten host hooks were devolved to native handlers in
 * this series. Every proof of them ran through `arbor task`, because
 * `createCliRuntime` was the only composition root that called
 * `composeNativeExecutorEnvironment`. `demo.ts` built its own
 * `new ArborRuntime({...})` with four fields and never reached a hook bus, so
 * the devolution was unproven on the entry point that actually runs campaigns,
 * and nothing detected the absence. These cases assert on the composition
 * `demo.ts` builds, and on a real veto dispatch through the bus it builds —
 * not on a stub.
 *
 * The bus records every firing into the runtime's durable session journal, so
 * each case supplies a real `ArborRuntime` bound to the lane's runtime box
 * and then reads the evidence back out of the journal. A composition that
 * carried a bus nobody wired to a runtime could not pass the last case.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeToolPort, NativeToolPreflightResult, NativeToolRequest } from "@arbor/harness";
import { ArborRuntime } from "../../src/runtime.js";
import { RuntimeCatalogRouter } from "../../src/runtime-catalog.js";
import { NATIVE_HARNESS_CONNECTOR_ID } from "../../src/harness-control-plane.js";
import { composeDemoNativeLane, type DemoNativeLane } from "../../src/demo.js";
import { loadConfig, type ArborConfig } from "@arbor/config";

/** Every `hook_id` `DEFAULT_HOOK_SET` ships; twelve, after the devolution. */
const DEFAULT_HOOK_IDS = [
  "plan-confirm-notifier",
  "tool-execute-audit-log",
  "subagent-git-write-guard",
  "session-governance-orient",
  "session-isolation-report",
  "session-owed-decisions",
  "vi-readonly-guard",
  "claim-completeness-guard",
  "session-graph-freshness",
  "vi-dirty-tracker",
  "vi-graph-debt",
  "stop-battery",
  "repo-session-open",
  "repo-session-end",
  "session-operator-decision-queue",
  "evidence-staleness",
] as const;

let repo = "";
let lane: DemoNativeLane | null = null;
let runtime: ArborRuntime | null = null;
const git = (...args: string[]): void => { execFileSync("git", args, { cwd: repo, stdio: "ignore" }); };

/** A real `arbor.jsonc` whose native selection is dispatchable, loaded through the product's own loader. */
const nativeReadyConfig = (): ArborConfig => {
  writeFileSync(join(repo, "arbor.jsonc"), JSON.stringify({ native: {
    mode: "native", adapter_id: "openai-compatible", provider_id: "fixture-provider",
    base_url: "https://fixture.invalid/v1", model: "fixture-model",
  } }), "utf8");
  return loadConfig(repo);
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "demo-native-lane-"));
  git("init", "-q", "-b", "master");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "T");
  // `vi.spyOn(process, "cwd")`, never `process.chdir` — vitest runs in worker
  // threads where a real chdir is process-wide and races other suites.
  vi.spyOn(process, "cwd").mockReturnValue(repo);
  process.env.ARBOR_NATIVE_API_KEY = "test-only-native-key";
});

afterEach(async () => {
  delete process.env.ARBOR_NATIVE_API_KEY;
  delete process.env.ARBOR_SAFE_MODE;
  vi.restoreAllMocks();
  if (runtime !== null) { await runtime.close(); runtime = null; }
  if (lane !== null) { lane = null; }
  rmSync(repo, { recursive: true, force: true });
});

/**
 * A runtime bound the way `demo.ts` binds it, so hook evidence is durable
 * rather than a no-op.
 *
 * LIMIT, stated rather than papered over: this mirrors `demo.ts`'s
 * `new ArborRuntime({...})` option set by hand. It does not drive `demomain`
 * end to end, so it proves the composition `demo.ts` builds and hands over —
 * not that the option block is spelled correctly. The last case is what
 * catches a mistake in the option block itself.
 */
const bind = async (composed: DemoNativeLane): Promise<ArborRuntime> => {
  const started = new ArborRuntime({
    persistence_dir: join(repo, ".arbor-demo-native-lane"),
    harness_integrations: composed.harness_integrations,
    harness_connector_registry: composed.harness_integrations.connectors,
    native_harness_readiness: composed.native_readiness,
    operator_doctor_integration: composed.operator_doctor_integration,
  });
  expect((await started.start()).ok).toBe(true);
  composed.runtime_box.current = started;
  runtime = started;
  return started;
};

/** A tool port whose own preflight allows, so a denial below can only be a hook's. */
const permissivePort = (): NativeToolPort => Object.freeze({
  tool: "shell.execute",
  preflight: (): NativeToolPreflightResult => ({ allowed: true }),
  execute: (): Promise<never> => Promise.reject(new Error("preflight should have refused this call")),
});

/** `NativeToolPort.preflight` is optional; these cases need the chain, so require it once here. */
const asPreflightPort = (port: NativeToolPort): { preflight: (request: NativeToolRequest) => NativeToolPreflightResult } => {
  const { preflight } = port;
  if (preflight === undefined) throw new Error("tool port carries no preflight to compose hooks onto");
  return { preflight: (request) => preflight.call(port, request) };
};

const bashRequest = (command: string): NativeToolRequest => Object.freeze({
  session_id: "s-demo-1", turn: 1, call_id: "c-demo-1",
  input: { command }, workspace_roots: [repo], filesystem: "workspace_write",
  network_allowed: false, intent_evidence: [],
});



describe("`arbor run` composition root — the native lane and its hook bus", () => {
  it("composes a hook bus carrying every DEFAULT_HOOK_SET descriptor", async () => {
    lane = composeDemoNativeLane({ cwd: repo, config: nativeReadyConfig(), environment: process.env, persistence_dir: join(repo, ".arbor-demo-native-lane") });
    await bind(lane);

    expect(lane.hook_catalog.list().map((hook) => hook.hook_id).sort()).toEqual([...DEFAULT_HOOK_IDS].sort());
    expect(lane.hook_catalog.list().filter((hook) => hook.kind === "veto" && hook.event === "tool_preflight")).toHaveLength(3);
    expect(lane.hook_bus.diagnostics()).toEqual([]);
  });

  it("dispatches a DEFAULT_HOOK_SET veto through that bus and denies the write", async () => {
    lane = composeDemoNativeLane({ cwd: repo, config: nativeReadyConfig(), environment: process.env, persistence_dir: join(repo, ".arbor-demo-native-lane") });
    await bind(lane);

    const wrapped = asPreflightPort(lane.hook_bus.wrapToolPort(permissivePort(), { subagent: true }));
    const denied = wrapped.preflight(bashRequest("git commit -am wip"));
    expect(denied.allowed).toBe(false);
    expect(denied.allowed === false && denied.reason).toContain("commit");

    // A read-only git call from the same subagent context still passes: the
    // denial above is the guard's, not a blanket subagent block.
    expect(wrapped.preflight(bashRequest("git status")).allowed).toBe(true);
  });

  it("records the veto in the runtime's durable hook evidence, not only in the bus ledger", async () => {
    lane = composeDemoNativeLane({ cwd: repo, config: nativeReadyConfig(), environment: process.env, persistence_dir: join(repo, ".arbor-demo-native-lane") });
    const bound = await bind(lane);

    asPreflightPort(lane.hook_bus.wrapToolPort(permissivePort(), { subagent: true })).preflight(bashRequest("git add foo.txt"));

    const evidence = bound.harnessSessions?.hookInvocations() ?? [];
    expect(evidence.map((record) => [record.hook_id, record.decision])).toContainEqual(["subagent-git-write-guard", "deny"]);
  });

  it("registers the native connector, and the runtime's own catalog reports it", async () => {
    lane = composeDemoNativeLane({ cwd: repo, config: nativeReadyConfig(), environment: process.env, persistence_dir: join(repo, ".arbor-demo-native-lane") });
    const bound = await bind(lane);

    expect(lane.harness_integrations.connectors.list().map((entry) => entry.connector_id)).toContain(NATIVE_HARNESS_CONNECTOR_ID);
    // The runtime is handed the registry, not only the integration bindings:
    // `arbor run` reporting an empty connector inventory while holding a
    // composed native lane is the same invisible-absence defect.
    const inventory = new RuntimeCatalogRouter(bound).executeQuery({ schema_version: 1, query_id: "connectors", query: { kind: "harness.connector.inventory" } });
    expect(inventory.ok && (inventory.value as { connectors: { connector_id: string }[] }).connectors.map((entry) => entry.connector_id)).toContain(NATIVE_HARNESS_CONNECTOR_ID);
  });

  it("honours safe mode: an empty catalog, so no veto is composed at all", async () => {
    process.env.ARBOR_SAFE_MODE = "1";
    lane = composeDemoNativeLane({ cwd: repo, config: nativeReadyConfig(), environment: process.env, persistence_dir: join(repo, ".arbor-demo-native-lane") });
    const bound = await bind(lane);

    expect(lane.safe_mode).toBe(true);
    expect(lane.hook_catalog.list()).toEqual([]);
    // `wrapToolPort` returns the port untouched when zero veto hooks are
    // declared, so the same `git commit` that was denied above now passes and
    // writes no hook evidence at all.
    const port = permissivePort();
    expect(lane.hook_bus.wrapToolPort(port, { subagent: true })).toBe(port);
    expect(asPreflightPort(port).preflight(bashRequest("git commit -am wip"))).toEqual({ allowed: true });
    expect(bound.harnessSessions?.hookInvocations() ?? []).toEqual([]);
  });
});
