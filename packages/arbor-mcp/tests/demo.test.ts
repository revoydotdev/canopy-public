import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArborRuntime } from "../src/runtime.js";
import { resolvePersistenceDir } from "../src/cli.js";
import { acquireWriterLock } from "@arbor/core";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { RuntimePortAdapter } from "../src/tui-adapter.js";
import { runOneCampaign, createDemoLoopExecutor, createDemoConfig, campaignConfigFromArborConfig, demomain, realExecutorDisclosure } from "../src/demo.js";
import { devtoolsLoopHook, type DevToolsLogLine } from "../src/devtools-log.js";
import { EXIT_CODES } from "../src/exit-codes.js";
import { ManagerScoreContextAdapter } from "../src/loop-adapters.js";
import { composeLoopConfigPorts } from "../src/loop-ports-helper.js";
import {
  runCampaign,
  DEFAULT_LOOP_CONFIG,
  WorktreeManager,
  PanelOfCritics,
  type LoopExecutor,
  type CampaignLoopConfig,
  type ReviewerRunner,
} from "@arbor/opencode";
import type { Action } from "@arbor/core";
import type { ArborConfig } from "@arbor/config";

// ============================================================
// HELPERS
// ============================================================

const DEMO_STEPS: readonly Action[] = Object.freeze([
  { description: "Implement auth module", estimated_gain: 8, estimated_cost: 4, category: "implementation", delegate_to: "seed" },
  { description: "Add integration tests", estimated_gain: 6, estimated_cost: 3, category: "testing", delegate_to: "seed" },
  { description: "Security review", estimated_gain: 7, estimated_cost: 5, category: "security", delegate_to: "heartwood" },
  { description: "Document API endpoints", estimated_gain: 4, estimated_cost: 2, category: "documentation", delegate_to: "seed" },
  { description: "Optimize query plan", estimated_gain: 5, estimated_cost: 3, category: "optimization", delegate_to: "seed" },
  { description: "Deploy canary release", estimated_gain: 6, estimated_cost: 2, category: "deployment", delegate_to: "seed" },
  { description: "Run load test", estimated_gain: 7, estimated_cost: 4, category: "testing", delegate_to: "seed" },
  { description: "Clean up deprecated endpoints", estimated_gain: 3, estimated_cost: 1, category: "cleanup", delegate_to: "seed" },
]);

function readLines(dir: string): DevToolsLogLine[] {
  const path = join(dir, "devtools", "devtools.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DevToolsLogLine);
}

function findLogger(runtime: ArborRuntime): Parameters<typeof devtoolsLoopHook>[0] {
  const started = (runtime as unknown as Record<string, unknown[]> & { startedParticipants?: unknown[] })
    .startedParticipants ?? [];
  for (const participant of started) {
    const p = participant as Record<string, unknown>;
    if (p && p.name === "devtools-trace-logger" && p.logger) {
      return p.logger as Parameters<typeof devtoolsLoopHook>[0];
    }
  }
  return null;
}

// ============================================================
// TESTS
// ============================================================

describe("`arbor demo` campaign loop", () => {
  let dir: string;
  let runtime: ArborRuntime | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "arbor-demo-"));
  });

  afterEach(async () => {
    if (runtime) {
      try { await runtime.close(); } catch { /* cleanup */ }
      runtime = null;
    }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("runs a deterministic campaign to completion and writes devtools.log with runtime + loop.* lines", async () => {
    // 1. Compose runtime with persistence (triggers DevToolsTraceLogger)
    runtime = new ArborRuntime({
      persistence_dir: dir,
      devtools_logger: { persistence_dir: dir, disable_fsync: true, flush_interval_ms: 0 },
    });

    const started = await runtime.start();
    expect(started.ok).toBe(true);

    // 2. Snag the logger for loop-event bridging
    const logger = findLogger(runtime);
    const loopHook = devtoolsLoopHook(logger);

    const scoreAdapter = new ManagerScoreContextAdapter(runtime.manager);

    // 3. Seed the campaign
    const campaignId = "demo-test";
    const rootAction: Action = {
      description: "Demo test campaign — autonomous tree search",
      estimated_gain: 10,
      estimated_cost: 2,
      category: "planning",
      delegate_to: "crown",
    };

    const startResult = runtime.manager.startCampaign(campaignId, "test-plan.md", rootAction, {
      convergence_iterations: 20, // high enough not to interfere
    });
    expect(startResult.ok).toBe(true);

    // Root node starts as "claimed" — branch children so there are pending nodes to select.
    runtime.manager.branch(campaignId, "root", [...DEMO_STEPS]);

    // 4. Create deterministic LoopExecutor
    let specCalls = 0;
    let reviewCalls = 0;

    const executor: LoopExecutor = {
      async specialize(params) {
        specCalls++;
        return {
          output: `[test] ${params.action.description}\ncompleted`,
          provenance: { tag: "verified", cmd: "npx vitest run", exit: 0, stdout_hash: "sha256:test" },
          token_usage: { kind: "unavailable", reason: "test fixture" },
        };
      },
      async review(params) {
        reviewCalls++;
        return {
          approved: true,
          rationale: `approved: ${params.action.description}`,
          critic_agent: "lenticel",
          measurement_validated: true,
          token_usage: { kind: "unavailable", reason: "test fixture" },
        };
      },
      log: loopHook,
    };

    // 5. Create config with the plan steps as branch children
    const config: CampaignLoopConfig = {
      max_iterations: 50,
      specialist_base_prompt: DEFAULT_LOOP_CONFIG.specialist_base_prompt,
      critic_base_prompt: DEFAULT_LOOP_CONFIG.critic_base_prompt,
      specialist_cap: { tier: "specialist" },
      critic_cap: { tier: "critic" },
      score_ctx: () => scoreAdapter.score_ctx(campaignId),
      use_worktrees: false,
      branch_actions: () => null,
    };

    // 6. Run the campaign
    const report = await runCampaign({
      manager: runtime.manager,
      campaign_id: campaignId,
      executor,
      config,
    });

    // 7. Assertions: campaign completed
    expect(report.iterations).toBeGreaterThan(0);
    expect(report.verified).toBeGreaterThan(0);
    // All 8 plan steps should have been processed
    expect(report.verified + report.claimed + report.failed).toBeGreaterThanOrEqual(8);
    expect(specCalls).toBeGreaterThan(0);
    expect(reviewCalls).toBeGreaterThan(0);

    // 8. Close runtime to flush devtools log
    await runtime.close();
    runtime = null;

    // 9. Verify devtools.log content
    const lines = readLines(dir);
    expect(lines.length).toBeGreaterThan(0);

    // Should contain runtime events
    const runtimeLines = lines.filter((l) => !l.event_kind.startsWith("loop."));
    expect(runtimeLines.length).toBeGreaterThan(0);
    expect(runtimeLines.some((l) => l.event_kind === "campaign.changed")).toBe(true);
    expect(runtimeLines.some((l) => l.event_kind === "tree.node_changed")).toBe(true);

    // Should contain loop.* events (from the bridge)
    const loopLines = lines.filter((l) => l.event_kind.startsWith("loop."));
    expect(loopLines.length).toBeGreaterThan(0);
    expect(loopLines.some((l) => l.event_kind === "loop.specialist_dispatched")).toBe(true);
    expect(loopLines.some((l) => l.event_kind === "loop.critic_dispatched")).toBe(true);
    expect(loopLines.some((l) => l.event_kind === "loop.node_verified")).toBe(true);
    expect(loopLines.some((l) => l.event_kind === "loop.campaign_start")).toBe(true);

    // Every loop line should have loop_event set
    for (const ll of loopLines) {
      expect(ll.loop_event).not.toBeNull();
    }
  });

  it("exercises the devtools.stream adapter query surface", async () => {
    runtime = new ArborRuntime({
      persistence_dir: dir,
      devtools_logger: { persistence_dir: dir, disable_fsync: true, flush_interval_ms: 0 },
    });

    const started = await runtime.start();
    expect(started.ok).toBe(true);

    const router = new RuntimeCatalogRouter(runtime);
    const adapter = new RuntimePortAdapter(router, () => runtime!.operations.list().length);

    // Push some lines into the ring
    adapter.pushDevtoolsLine({
      seq: 1,
      ts: new Date().toISOString(),
      event_kind: "arbor-runtime.test-event",
      campaign_id: "test-campaign",
      node_id: null,
      synthetic: false,
    });
    adapter.pushDevtoolsLine({
      seq: 2,
      ts: new Date().toISOString(),
      event_kind: "loop.specialist_dispatched",
      campaign_id: "test-campaign",
      node_id: "node-xyz",
      synthetic: false,
    });

    // Query via devtools.stream
    const res = await adapter.query({ kind: "devtools.stream", query_id: "test:stream", params: {} });
    expect(res.ok).toBe(true);
    const stream = res.value as { campaign_id: string | null; lines: readonly Record<string, unknown>[] };
    expect(stream.lines).toHaveLength(2);
    expect(stream.lines[0].event_kind).toBe("arbor-runtime.test-event");
    expect(stream.lines[1].event_kind).toBe("loop.specialist_dispatched");

    // Verify the contract shape
    expect(stream).toHaveProperty("campaign_id");
    expect(stream).toHaveProperty("lines");
    expect(Array.isArray(stream.lines)).toBe(true);

    await runtime.close();
    runtime = null;
  });

  it("G-05: `arbor demo`'s real deterministic executor reaches the governance plan step and raises a genuine RequestUserInput — the pending-interview guard now has a real originator", async () => {
    // Before this, `manager.askForUserInput`'s only caller was the runtime
    // catalog's own operator-driven dispatcher — no agent and no loop path
    // ever raised a question. `createDemoLoopExecutor` (the real, unmodified
    // production executor `arbor demo --executor deterministic` runs) now
    // signals needs_input on its second dispatch (its internal step table's
    // "governance" entry), every time, deterministically. Driven directly
    // through `runCampaign` — the same config shape the pre-existing
    // "runs a deterministic campaign to completion" test above uses,
    // deliberately not `runOneCampaign`'s full port composition, which has
    // an unrelated, pre-existing `token_economy` wiring bug (see this
    // package's dispatch report: `composeLoopConfigPorts` assigns the raw
    // `TokenEpochService` to `token_economy` instead of a full
    // `TokenEconomyConfig`, so `prepareTokenDispatch` throws on `provider`
    // before any specialist ever dispatches — reported, not fixed here, it
    // is out of this lane's file ownership).
    runtime = new ArborRuntime({ persistence_dir: dir });
    const started = await runtime.start();
    expect(started.ok).toBe(true);

    const router = new RuntimeCatalogRouter(runtime);
    const adapter = new RuntimePortAdapter(router, () => runtime!.operations.list().length);
    const scoreAdapter = new ManagerScoreContextAdapter(runtime.manager);

    const campaignId = "demo-g05";
    const rootAction: Action = {
      description: "Demo G-05 campaign — autonomous tree search",
      estimated_gain: 10, estimated_cost: 2, category: "planning", delegate_to: "crown",
    };
    runtime.manager.startCampaign(campaignId, "test-plan.md", rootAction, {
      convergence_iterations: 20,
    });
    // Two plan-level (root's direct children) actions — enough for the
    // demo executor's second dispatch (the governance step) to fire.
    runtime.manager.branch(campaignId, "root", [
      { description: "step one", estimated_gain: 5, estimated_cost: 2, category: "implementation", delegate_to: "seed" },
      { description: "step two", estimated_gain: 5, estimated_cost: 2, category: "implementation", delegate_to: "seed" },
    ]);

    const executor = createDemoLoopExecutor(adapter, () => {}, campaignId, 42);
    const config: CampaignLoopConfig = {
      max_iterations: 5,
      specialist_base_prompt: DEFAULT_LOOP_CONFIG.specialist_base_prompt,
      critic_base_prompt: DEFAULT_LOOP_CONFIG.critic_base_prompt,
      specialist_cap: { tier: "specialist" },
      critic_cap: { tier: "critic" },
      score_ctx: () => scoreAdapter.score_ctx(campaignId),
      use_worktrees: false,
      branch_actions: () => null,
    };

    const report = await runCampaign({ manager: runtime.manager, campaign_id: campaignId, executor, config });

    expect(report.awaiting_user_input).toBe(true);
    expect(runtime.manager.awaitingUserInput(campaignId)).toBe(true);
    const records = runtime.manager.getUserInputs(campaignId);
    expect(records).toHaveLength(1);
    expect(records[0]!.question.question).toContain("Governance decision required");
    // Recorded lead/blocking: both branched actions are root's direct
    // children — the plan's own admission-level actions — matching
    // ADR-019's "plan/admission interview blocks selectNode" case.
    expect(records[0]!.question.authority).toBe("lead");
    expect(records[0]!.question.blocking).toBe("blocking");

    await runtime.close();
    runtime = null;
  });

  it("G-30: runOneCampaign's real token_economy no longer crashes prepareTokenDispatch on the very first dispatch", async () => {
    // Before this fix, `createDemoConfig` spread composeLoopConfigPorts's
    // token_economy — the bare TokenEpochService, not a full
    // TokenEconomyConfig — so every real dispatch (loop.ts's
    // prepareTokenDispatch reading config.token_economy.provider) threw
    // before the specialist was ever invoked, on every single `arbor demo`
    // run, real or deterministic. The crash was silently swallowed by this
    // function's own bare `catch`, surfacing only as an opaque
    // `campaign.error` devtools line. This proves the fix on the actual
    // production entrypoint: a real (non-aborted) run completes at least
    // one full dispatch cycle with real phase-timing telemetry, and never
    // emits `campaign.error`.
    runtime = new ArborRuntime({ persistence_dir: dir });
    const started = await runtime.start();
    expect(started.ok).toBe(true);

    const router = new RuntimeCatalogRouter(runtime);
    const adapter = new RuntimePortAdapter(router, () => runtime!.operations.list().length);

    await runOneCampaign(runtime, adapter, 0, 42, { executor: "deterministic", transport: "subprocess" });

    const stream = await adapter.query({ kind: "devtools.stream", query_id: "g09:stream", params: {} });
    expect(stream.ok).toBe(true);
    const kinds = (stream.value as { lines: readonly { event_kind: string }[] }).lines.map((l) => l.event_kind);
    expect(kinds).not.toContain("campaign.error");
    expect(kinds).toContain("loop.specialist_dispatched");

    const campaignId = runtime.manager.getActiveCampaignId();
    expect(campaignId).toBeTruthy();
    const observations = runtime.manager.getTelemetryObservations(campaignId!);
    expect(observations.some((o) => o.observation.type === "phase_timing")).toBe(true);

    // The deterministic executor is honestly `{kind:"unavailable"}` for
    // token_usage (it never calls a real provider) — so no usage_cost
    // record should exist for it. That absence is correct, not a bug: it is
    // exactly the typed-absence behavior `hasTokenUsage` gates emitCost on.
    // Wave 2's server transport (opencode-server-executor.ts) is what
    // returns genuine TokenUsage; with token_economy now correctly wired,
    // that transport's real runs — not exercised here, hermetic/no-network —
    // reach the same prepareTokenDispatch call this test proves no longer
    // crashes, and emitCost fires whenever hasTokenUsage(token_usage) is
    // true.
    expect(observations.some((o) => o.observation.type === "usage_cost")).toBe(false);

    await runtime.close();
    runtime = null;
  });

  it("G-30: with the fixed token_economy wired, a specialist that returns real TokenUsage writes a usage_cost record with real (unpriced) token counts", async () => {
    // Closes the loop as far as this hermetic suite can: Wave 2's server
    // transport (opencode-server-executor.ts) constructs genuine TokenUsage
    // from opencode's wire response (see toTokenUsage) — not exercised here,
    // since a real opencode serve process needs network/keys — but the loop
    // logic downstream of "the executor returned real TokenUsage" is fully
    // exercisable and provable now that composeLoopConfigPorts's
    // token_economy fixes the crash. This is the direct evidence for G-30:
    // when token_usage is real,
    // emitCost fires and a usage_cost record lands with a genuine,
    // non-fabricated token count and a correctly typed `unpriced` cost
    // (pricing stays out of scope).
    runtime = new ArborRuntime({ persistence_dir: dir });
    const started = await runtime.start();
    expect(started.ok).toBe(true);

    const scoreAdapter = new ManagerScoreContextAdapter(runtime.manager);
    const campaignId = "demo-g09-cost";
    const rootAction: Action = { description: "G-09 cost campaign", estimated_gain: 10, estimated_cost: 2, category: "planning", delegate_to: "crown" };
    runtime.manager.startCampaign(campaignId, "test-plan.md", rootAction, { convergence_iterations: 10 });
    runtime.manager.branch(campaignId, "root", [
      { description: "real-usage step", estimated_gain: 5, estimated_cost: 2, category: "implementation", delegate_to: "seed" },
    ]);

    const realTokenUsage = { input_tokens: 512, output_tokens: 128, cached_input_tokens: 64, cache_write_input_tokens: 0, counter_source: "provider_counter" as const };
    const executor: LoopExecutor = {
      async specialize() {
        return { output: "real specialist output", provenance: { tag: "claimed", claimant: "seed" }, token_usage: realTokenUsage };
      },
      async review() {
        return { approved: true, rationale: "approved", critic_agent: "lenticel", measurement_validated: true, token_usage: realTokenUsage };
      },
      log() {},
    };

    const config: CampaignLoopConfig = {
      max_iterations: 5,
      specialist_base_prompt: DEFAULT_LOOP_CONFIG.specialist_base_prompt,
      critic_base_prompt: DEFAULT_LOOP_CONFIG.critic_base_prompt,
      specialist_cap: { tier: "specialist" },
      critic_cap: { tier: "critic" },
      score_ctx: () => scoreAdapter.score_ctx(campaignId),
      use_worktrees: false,
      branch_actions: () => null,
      telemetry: runtime.loopPorts.telemetry as CampaignLoopConfig["telemetry"],
      token_economy: composeLoopConfigPorts(runtime).token_economy,
    };

    await runCampaign({ manager: runtime.manager, campaign_id: campaignId, executor, config });

    const observations = runtime.manager.getTelemetryObservations(campaignId);
    const costObservations = observations.filter((o) => o.observation.type === "usage_cost");
    expect(costObservations.length).toBeGreaterThan(0);
    const cost = costObservations[0]!.observation as { input_tokens: number; output_tokens: number; cost: { kind: string } };
    expect(cost.input_tokens).toBe(512);
    expect(cost.output_tokens).toBe(128);
    // Pricing is genuinely out of scope (G-09's done-when) — the record
    // must be honestly `unpriced`, never a fabricated price.
    expect(cost.cost.kind).toBe("unpriced");

    await runtime.close();
    runtime = null;
  });

  it("G-16: an aborted signal reaches runCampaign and cancels before any specialist dispatch", async () => {
    // demomain's SIGINT/SIGTERM handlers now abort a real AbortController and
    // pass it into every runOneCampaign call. Before that fix, runCampaign
    // never received a signal at all, so a mid-flight campaign always ran to
    // completion regardless of an operator interrupt. This proves the signal
    // genuinely reaches runCampaign's cooperative cancellation path — an
    // already-aborted signal must stop the loop before its first dispatch.
    runtime = new ArborRuntime({ persistence_dir: dir });
    const started = await runtime.start();
    expect(started.ok).toBe(true);

    const router = new RuntimeCatalogRouter(runtime);
    const adapter = new RuntimePortAdapter(router, () => runtime!.operations.list().length);

    const controller = new AbortController();
    controller.abort(new Error("test operator interrupt"));

    await runOneCampaign(
      runtime,
      adapter,
      0,
      1,
      { executor: "deterministic", transport: "subprocess" },
      controller.signal,
    );

    const res = await adapter.query({ kind: "devtools.stream", query_id: "test:stream", params: {} });
    expect(res.ok).toBe(true);
    const stream = res.value as { lines: readonly Record<string, unknown>[] };
    const kinds = stream.lines.map((l) => l.event_kind);
    expect(kinds).not.toContain("loop.specialist_dispatched");
    expect(kinds).toContain("loop.cancelled");

    await runtime.close();
    runtime = null;
  });
});

describe("A-7: panel/run_reviewer — the critic panel genuinely runs", () => {
  let dir: string;
  let runtime: ArborRuntime | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "arbor-demo-panel-"));
  });

  afterEach(async () => {
    if (runtime) {
      try { await runtime.close(); } catch { /* cleanup */ }
      runtime = null;
    }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("routes critic review through the panel (demo.panel_review) instead of the direct single-critic executor call (demo.review)", async () => {
    // Before A-7's fix, `createDemoConfig` never set `panel`/`run_reviewer`,
    // so `loop.ts` always took its `executor.review()` branch — the tool_call
    // line was always "demo.review". With the panel wired, `loop.ts` takes
    // the `config.panel` branch instead and never calls `executor.review()`
    // at all (see loop.ts's `if (config.panel) { ... } else { critic =
    // await executor.review(...) }`) — this is an observable behavior
    // change, not just a new field assignment.
    runtime = new ArborRuntime({ persistence_dir: dir });
    const started = await runtime.start();
    expect(started.ok).toBe(true);

    const router = new RuntimeCatalogRouter(runtime);
    const adapter = new RuntimePortAdapter(router, () => runtime!.operations.list().length);

    await runOneCampaign(runtime, adapter, 0, 42, { executor: "deterministic", transport: "subprocess" });

    const streamResult = await adapter.query({ kind: "devtools.stream", query_id: "panel:stream", params: {} });
    expect(streamResult.ok).toBe(true);
    const lines = (streamResult.value as { lines: readonly { event_kind: string; loop_event?: { tool?: string } }[] }).lines;
    const toolCalls = lines
      .filter((l) => l.event_kind === "loop.tool_call")
      .map((l) => l.loop_event?.tool);

    expect(toolCalls).toContain("demo.panel_review");
    expect(toolCalls).not.toContain("demo.review");
  });
});

describe("A-2: use_worktrees — the real, subprocess-backed verification path is reachable", () => {
  it("threads a real WorktreeManager into runCampaign so worktree_path reaching the executor is a real, git-backed path (not '.worktree-unavailable')", async () => {
    const repo = mkdtempSync(join(tmpdir(), "arbor-demo-a2-repo-"));
    const persistDir = mkdtempSync(join(tmpdir(), "arbor-demo-a2-persist-"));
    let runtime: ArborRuntime | null = null;
    try {
      spawnSync("git", ["init", "-q", repo], { stdio: "ignore" });
      spawnSync("git", ["-C", repo, "config", "user.email", "t@t"], { stdio: "ignore" });
      spawnSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "ignore" });
      writeFileSync(join(repo, "README.md"), "seed\n");
      spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
      spawnSync("git", ["-C", repo, "commit", "-qm", "init"], { stdio: "ignore" });

      const worktrees = new WorktreeManager({ repoRoot: repo });
      runtime = new ArborRuntime({ persistence_dir: persistDir });
      const started = await runtime.start();
      expect(started.ok).toBe(true);

      const campaignId = "demo-a2";
      const rootAction: Action = {
        description: "A-2 worktree campaign", estimated_gain: 10, estimated_cost: 2, category: "planning", delegate_to: "crown",
      };
      runtime.manager.startCampaign(campaignId, "test-plan.md", rootAction, { convergence_iterations: 20 });
      runtime.manager.branch(campaignId, "root", [
        { description: "edit a file", estimated_gain: 5, estimated_cost: 2, category: "implementation", delegate_to: "seed" },
      ]);

      let observedWorktreePath: string | undefined;
      const executor: LoopExecutor = {
        async specialize(params) {
          observedWorktreePath = params.worktree_path;
          return { output: "ok", provenance: { tag: "claimed", claimant: "seed" }, token_usage: { kind: "unavailable", reason: "test" } };
        },
        async review() {
          return { approved: true, rationale: "ok", critic_agent: "lenticel", measurement_validated: true, token_usage: { kind: "unavailable", reason: "test" } };
        },
        log() {},
      };
      const noOpReviewer: ReviewerRunner = async () => ({ approved: true, rationale: "no concerns" });
      const config = createDemoConfig(runtime, { panel: new PanelOfCritics(), run_reviewer: noOpReviewer }, true);

      await runCampaign({ manager: runtime.manager, campaign_id: campaignId, executor, config, worktrees });

      expect(config.use_worktrees).toBe(true);
      expect(observedWorktreePath).toBeTruthy();
      expect(observedWorktreePath).not.toBe(".worktree-unavailable");
      // Real, git-backed artifacts under the repo root — proof the manager
      // genuinely reached `runCampaign` and acquired a lease, not merely
      // that a boolean flipped.
      expect(existsSync(join(repo, ".worktrees"))).toBe(true);
      expect(existsSync(join(repo, ".arbor", "leases"))).toBe(true);
    } finally {
      if (runtime) await runtime.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(persistDir, { recursive: true, force: true });
    }
  });

  it("runOneCampaign callers that omit a WorktreeManager keep the pre-existing dry-run behavior (use_worktrees: false)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-demo-a2-dryrun-"));
    const runtime = new ArborRuntime({ persistence_dir: dir });
    try {
      const started = await runtime.start();
      expect(started.ok).toBe(true);
      const router = new RuntimeCatalogRouter(runtime);
      const adapter = new RuntimePortAdapter(router, () => runtime.operations.list().length);

      // No `worktrees` argument supplied — must not shell out to git.
      await runOneCampaign(runtime, adapter, 0, 1, { executor: "deterministic", transport: "subprocess" });

      const streamResult = await adapter.query({ kind: "devtools.stream", query_id: "dryrun:stream", params: {} });
      expect(streamResult.ok).toBe(true);
      const kinds = (streamResult.value as { lines: readonly { event_kind: string }[] }).lines.map((l) => l.event_kind);
      expect(kinds).not.toContain("campaign.error");
    } finally {
      await runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("A-6: config threaded into campaign execution", () => {
  const sampleArborConfig: ArborConfig = {
    agents: {},
    categories: {},
    tree_search: { max_seconds: 111, min_score: 0.25, exploration_constant: 2.5, convergence_iterations: 7 },
    kb: { backend: "jsonl" },
    native: { mode: "auto", adapter_id: "openai-compatible", provider_id: "openai-compatible", base_url: "", model: "" },
  };

  it("campaignConfigFromArborConfig maps arbor.jsonc's tree_search.* onto CampaignConfig", () => {
    expect(campaignConfigFromArborConfig(sampleArborConfig)).toEqual({
      max_seconds: 111,
      min_score: 0.25,
      convergence_iterations: 7,
      score_config: { exploration_constant: 2.5 },
    });
  });

  it("runOneCampaign threads a real CampaignConfig override into startCampaign — observable on the campaign snapshot, not just the call site", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-demo-a6-"));
    const runtime = new ArborRuntime({ persistence_dir: dir });
    try {
      const started = await runtime.start();
      expect(started.ok).toBe(true);
      const router = new RuntimeCatalogRouter(runtime);
      const adapter = new RuntimePortAdapter(router, () => runtime.operations.list().length);

      const override = campaignConfigFromArborConfig({
        ...sampleArborConfig,
        tree_search: { max_seconds: 4321, min_score: 0.42, exploration_constant: 3.14, convergence_iterations: 99 },
      });

      await runOneCampaign(
        runtime, adapter, 0, 1,
        { executor: "deterministic", transport: "subprocess" },
        undefined, undefined, override,
      );

      const campaignId = runtime.manager.getActiveCampaignId();
      expect(campaignId).toBeTruthy();
      const snapshot = runtime.manager.getCampaignSnapshot(campaignId!);
      expect(snapshot?.config.max_seconds).toBe(4321);
      expect(snapshot?.config.min_score).toBe(0.42);
      expect(snapshot?.config.convergence_iterations).toBe(99);
      expect(snapshot?.config.score_config.exploration_constant).toBe(3.14);
    } finally {
      await runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// demomain — the real `arbor demo`/`arbor run` CLI entry point's own
// argument parsing, help text, and validation branches. `demomain` was
// never directly called by any test before this block — every other test
// in this file drives the campaign loop through `runOneCampaign` and its
// helpers instead, so demomain() itself (the actual CLI entry point `arbor
// run`/`arbor demo` invokes) had zero coverage of its own body, including
// its argument parsing.
//
// Worth knowing before touching this block: calling `demomain()` at all —
// even once, even just its `--help` early return — changes demo.ts's
// reported function *denominator* in the coverage report, not just which
// functions are hit. Before anything called `demomain()`, V8's coverage
// collector reported only 17 "functions" in demo.ts (14 covered, 82.35%):
// V8 lazily parses function bodies, so the ~20 closures nested inside
// `demomain`'s interactive-loop section (connect/disconnect/onScreenChange/
// pollTick/campaignLoop/etc., reached only past every early-return branch)
// were never discovered by the collector at all — not even as "uncovered."
// The instant `demomain()` is called, regardless of which branch it takes,
// V8 fully compiles it and all nested closures become visible, growing the
// true denominator to 37 (15 covered here, 40.54%). This is not new
// untested surface — it is the same body that was always untested, now
// honestly counted instead of invisible to the tool.
//
// This block only exercises demomain's argument-parsing/help/validation
// branches (all return before constructing a runtime). The interactive
// body past that point — the real campaign loop, keyboard input, and
// SIGINT/SIGTERM handlers — is deliberately left uncovered here: it
// attaches real signal handlers to the actual process and reads real
// `process.stdin`, which is unsafe to exercise inside the shared vitest
// process (leaked listeners / raw-mode state could destabilize unrelated
// tests). Reported as a real, now-visible gap rather than chased with a
// risky test or silently left unmentioned.
// ============================================================
describe("demomain — CLI argument parsing, help, and validation", () => {
  it("--help prints real usage text to stdout and returns 0 without touching the filesystem or network", async () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const code = await demomain(["--help"]);
      expect(code).toBe(0);
      const printed = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(printed).toContain("arbor run [--once]");
      expect(printed).toContain("--executor");
      expect(printed).toContain("--transport");
    } finally {
      spy.mockRestore();
    }
  });

  it("-h is the same real branch as --help", async () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const code = await demomain(["-h"]);
      expect(code).toBe(0);
      expect(spy.mock.calls.map((c) => String(c[0])).join("")).toContain("arbor run [--once]");
    } finally {
      spy.mockRestore();
    }
  });

  it("an unknown --executor value is rejected with a real error message and exit code 1", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = await demomain(["--executor", "bogus"]);
      expect(code).toBe(1);
      // ADR-142: the lanes are native|opencode|deterministic, and `real` is a
      // deprecated alias for the resolved default rather than a name for
      // opencode. The behaviour this guards is unchanged -- an unrecognised
      // lane is refused with exit 1, never silently treated as the default.
      expect(spy.mock.calls.map((c) => String(c[0])).join("")).toContain('unknown --executor "bogus": expected native, opencode, or deterministic');
    } finally {
      spy.mockRestore();
    }
  });

  it("the DEFAULT path resolves to the Canopy lane and, when it is unready, refuses instead of falling back to a connector", async () => {
    // Regression guard for the two-decision defect (the default path once
    // bypassed the resolver) and for the Canopy-only directive (amends
    // ADR-061): the default is native, and an unready native lane is an
    // error, never a silent opencode run. The suite's operator-scope
    // isolation leaves no native credential, so the native lane is unready
    // here; the refusal happens before the writer lock, so nothing is
    // created on disk.
    const dir = `.arbor-lane-default-${process.pid}`;
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = await demomain(["--once", "--persistence-dir", dir]);
      const stderr = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(code).toBe(EXIT_CODES.FAILURE);
      expect(stderr).toContain("the Canopy harness (revoy-native) is unavailable");
      expect(stderr).toContain("no connector fallback");
      expect(stderr).not.toContain('"opencode" connector');
      expect(existsSync(join(process.cwd(), dir))).toBe(false);
    } finally {
      spy.mockRestore();
      rmSync(join(process.cwd(), dir), { recursive: true, force: true });
    }
  });

  it("--executor opencode is refused with the typed remedy unless connectors.allow_deprecated opts in", async () => {
    const dir = `.arbor-lane-opencode-${process.pid}`;
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = await demomain(["--once", "--executor", "opencode", "--persistence-dir", dir]);
      const stderr = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(code).toBe(EXIT_CODES.USAGE);
      expect(stderr).toContain("--executor opencode");
      expect(stderr).toContain("connectors.allow_deprecated: true");
      expect(existsSync(join(process.cwd(), dir))).toBe(false);
    } finally {
      spy.mockRestore();
      rmSync(join(process.cwd(), dir), { recursive: true, force: true });
    }
  });

  it("--executor opencode with the opt-in is admitted and its reason is reported before anything runs", async () => {
    // The opt-in lives in the (suite-isolated) user scope, because demomain
    // reads config from the real cwd. A regular file where the persistence
    // directory must go makes the writer lock fail right after the lane is
    // resolved: no campaign, no network, no opencode binary.
    const userDir = process.env.ARBOR_USER_CONFIG_DIR!;
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "arbor.jsonc"), JSON.stringify({ connectors: { allow_deprecated: true, reason: "demo opt-in fixture" } }), "utf8");
    const blocker = `.arbor-lane-blocker-${process.pid}`;
    writeFileSync(join(process.cwd(), blocker), "not a directory");
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await demomain(["--once", "--executor", "opencode", "--persistence-dir", join(blocker, "sub")]);
      const stderr = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(stderr).toContain('[executor] deprecated harness lane "opencode" (selected by --executor opencode) admitted by connectors.allow_deprecated: demo opt-in fixture');
    } finally {
      spy.mockRestore();
      rmSync(join(process.cwd(), blocker), { force: true });
      rmSync(join(userDir, "arbor.jsonc"), { force: true });
    }
  });

  it("a live runOneCampaign without a resolved lane is refused rather than defaulted to a connector", async () => {
    const runtime = new ArborRuntime();
    const adapter = new RuntimePortAdapter(new RuntimeCatalogRouter(runtime), () => 0);
    await expect(runOneCampaign(runtime, adapter, 0, 1, { executor: "real", transport: "subprocess" }))
      .rejects.toThrow(/requires a resolved lane.*no default connector/);
  });

  it("--help resolves no lane, so it emits no fallback line", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // The usage text goes to STDOUT (~2KB). Mocking only stderr let all of it
    // reach the real stdout, and any consumer parsing `vitest run
    // --reporter=json` output then fails to parse — which is how this one test
    // took gate:docs-truth down. The assertion below is about stderr, so
    // swallowing stdout costs nothing and keeps the reporter clean.
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await demomain(["--help"]);
      expect(spy.mock.calls.map((c) => String(c[0])).join("")).not.toContain("[executor]");
      // The usage text was still produced, just captured rather than emitted.
      expect(out.mock.calls.map((c) => String(c[0])).join("")).toContain("arbor run [--once]");
    } finally {
      spy.mockRestore();
      out.mockRestore();
    }
  });

  it("an unknown --transport value is rejected with a real error message and exit code 1", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = await demomain(["--transport", "bogus"]);
      expect(code).toBe(1);
      expect(spy.mock.calls.map((c) => String(c[0])).join("")).toContain('unknown transport: bogus (expected "subprocess" or "server")');
    } finally {
      spy.mockRestore();
    }
  });

  it("an unrecognized flag is rejected with a real error message and exit code 1", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = await demomain(["--not-a-real-flag"]);
      expect(code).toBe(1);
      expect(spy.mock.calls.map((c) => String(c[0])).join("")).toContain("unknown demo flag: --not-a-real-flag");
    } finally {
      spy.mockRestore();
    }
  });

  it("real flag parsing: --once, --persistence-dir, --model, --critic-model, and --verification-cmd are all recognized (validated indirectly: none trip the unknown-flag branch, and --help still short-circuits before any runtime is built)", async () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      // Every real flag demomain recognizes, immediately followed by --help
      // so parsing runs (proving each flag+value pair is consumed, not
      // mistaken for an unknown flag) but the function still returns before
      // constructing a runtime.
      const code = await demomain([
        "--once", "--persistence-dir", ".arbor-test", "--model", "some/model",
        "--critic-model", "some/critic", "--verification-cmd", "true", "--help",
      ]);
      expect(code).toBe(0);
      expect(spy.mock.calls.map((c) => String(c[0])).join("")).toContain("arbor run [--once]");
    } finally {
      spy.mockRestore();
    }
  });

  // ==========================================================
  // Persistence-dir containment (the defect this fixes): `arbor run`/`arbor
  // demo` used to pass `--persistence-dir` straight to `ArborRuntime`
  // unchecked — an absolute or `..`-escaping value was silently accepted and
  // arbor wrote a full ledger/devtools/kb tree wherever it pointed, unlike
  // `serve`/`webui`'s `ARBOR_PERSISTENCE_DIR`, which `resolvePersistenceDir`
  // (cli.ts) already refused. These prove the fix in BOTH directions: a
  // disallowed path is genuinely refused, and a contained one is genuinely
  // still accepted (a guard only ever proven to refuse is unverified — it
  // could just as well be refusing everything).
  // ==========================================================
  it("refuses an absolute --persistence-dir that escapes the working directory", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = await demomain(["--persistence-dir", "/tmp/arbor-outside-repo-test", "--executor", "deterministic", "--once"]);
      expect(code).toBe(EXIT_CODES.USAGE);
      expect(spy.mock.calls.map((c) => String(c[0])).join("")).toContain("must remain within the working directory");
    } finally {
      spy.mockRestore();
    }
  });

  it("ACCEPTS an absolute --persistence-dir that is inside the working directory", () => {
    // The direction the original pair missed. A blanket refusal of absolute
    // paths refused this too, which broke scripts/demo-window.sh: it passes the
    // repo's own `<repo>/.arbor` absolutely, and the live TUI pane died with
    // "must be relative to the working directory". Containment is the property;
    // absoluteness never was.
    const cwd = process.cwd();
    expect(resolvePersistenceDir(cwd, join(cwd, ".arbor"))).toBe(join(cwd, ".arbor"));
    expect(resolvePersistenceDir(cwd, ".arbor")).toBe(join(cwd, ".arbor"));
    expect(() => resolvePersistenceDir(cwd, "/tmp/elsewhere")).toThrow(/must remain within/);
    expect(() => resolvePersistenceDir(cwd, "../escape")).toThrow(/must remain within/);
  });

  it("refuses a `..`-escaping --persistence-dir the same way", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = await demomain(["--persistence-dir", "../arbor-outside-repo-test", "--executor", "deterministic", "--once"]);
      expect(code).toBe(EXIT_CODES.USAGE);
      expect(spy.mock.calls.map((c) => String(c[0])).join("")).toContain("must remain within the working directory");
    } finally {
      spy.mockRestore();
    }
  });

  it("accepts a contained relative --persistence-dir — proves the check is not refusing everything", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      // Followed by an unrelated unknown flag so the run still short-circuits
      // before constructing a real runtime (no network, no stdin/TUI side
      // effects) — but that later branch is only reached if the containment
      // check above it let this contained, relative path through silently.
      const code = await demomain(["--persistence-dir", "some/contained/dir", "--not-a-real-flag"]);
      expect(code).toBe(1);
      const printed = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(printed).toContain("unknown demo flag: --not-a-real-flag");
      expect(printed).not.toContain("must be relative");
      expect(printed).not.toContain("must remain within");
    } finally {
      spy.mockRestore();
    }
  });

  // WA-16 (audit/2026-08-23-50-defects.md; packet X-2 in
  // audit/2026-08-23-55-crosscuts.md): `arbor run`/`arbor demo` build an
  // `ArborRuntime` and start autonomous campaigns against the persistence
  // directory without ever taking the ADR-029 writer lock `serve`/`webui`/
  // `task` already require — a second `demomain`/`serve`/`webui` on the
  // same directory could silently drop the loser's evidence. `takeWriterLock`
  // (cli.ts) is refused synchronously, before any runtime/TUI/campaign setup,
  // so this needs no deterministic-executor campaign to actually run: a
  // pre-held lock must make `demomain` refuse at startup with
  // `EXIT_CODES.CONFLICT` and the same actionable holder+lock-path stderr
  // message `serve`/`webui` print (see cli.test.ts's own writer-lock test).
  it("refuses to start when the persistence directory's writer lock is already held (WA-16)", async () => {
    const dir = `.arbor-writer-lock-demomain-test-${process.pid}-${Date.now().toString(36)}`;
    const resolved = resolvePersistenceDir(process.cwd(), dir);
    const held = acquireWriterLock(resolved, { holder: "other-writer-under-test" });
    expect(held.ok).toBe(true);
    if (!held.ok) return;
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = await demomain(["--persistence-dir", dir, "--executor", "deterministic", "--once"]);
      expect(code).toBe(EXIT_CODES.CONFLICT);
      const printed = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(printed).toContain("other-writer-under-test");
      expect(printed).toContain(".arbor-writer.lock");
    } finally {
      spy.mockRestore();
      held.lock.release();
      rmSync(resolved, { recursive: true, force: true });
    }
  });
});

describe("realExecutorDisclosure — `arbor run` says when it is spending money", () => {
  const models = { specialistModel: "openrouter/spec-model", criticModel: "zai/critic-model" } as const;

  it("says nothing for the deterministic executor, which spends nothing", () => {
    expect(realExecutorDisclosure({ executor: "deterministic", once: false, ...models })).toBeNull();
    expect(realExecutorDisclosure({ executor: "deterministic", once: true, ...models })).toBeNull();
  });

  it("names both real models so the operator knows what is being billed", () => {
    const notice = realExecutorDisclosure({ executor: "real", once: true, ...models });
    expect(notice).not.toBeNull();
    expect(notice?.message).toContain("openrouter/spec-model");
    expect(notice?.message).toContain("zai/critic-model");
    expect(notice?.severity).toBe("warning");
  });

  it("distinguishes a bounded --once run from an unbounded one", () => {
    // The substance: `arbor run` with no flags loops campaigns back-to-back
    // forever against a live provider, while `selfhost` refuses to start
    // without explicit caps. The operator must be told which one they got.
    const bounded = realExecutorDisclosure({ executor: "real", once: true, ...models });
    const unbounded = realExecutorDisclosure({ executor: "real", once: false, ...models });
    expect(bounded?.message).toContain("Bounded");
    expect(bounded?.message).not.toContain("UNBOUNDED");
    expect(unbounded?.message).toContain("UNBOUNDED");
    expect(unbounded?.message).toContain("--once");
  });

  it("is pure — no wall clock, so the same options always yield the same notice", () => {
    const a = realExecutorDisclosure({ executor: "real", once: false, ...models });
    const b = realExecutorDisclosure({ executor: "real", once: false, ...models });
    expect(a).toEqual(b);
    expect(a?.createdAt).toBe(0);
  });
});
