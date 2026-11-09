import { describe, it, expect } from "vitest";
import { CampaignManager, TokenEpochService } from "@arbor/mcp";
import { PHASE_MESSAGE_MAX_CONTENT_BYTES } from "@arbor/audit";
import { runCampaign, DEFAULT_LOOP_CONFIG, composeSpecialistPrompt, verifyLiveNodeCards, FAULT_MATRIX, type LoopExecutor, type CampaignLoopConfig, type LoopEvent, type ExecutorContextComposition } from "../src/loop.js";
import { WorktreeManager } from "@arbor/campaign-support";
import { PanelOfCritics } from "@arbor/campaign-support";
import { deriveCandidateNodeCard } from "@arbor/core";
import type { Action, ScoreContext, CapabilityContext } from "@arbor/core";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rootAction: Action = {
  description: "execute plan",
  estimated_gain: 100,
  estimated_cost: 1,
  category: "root",
  delegate_to: "crown",
};

const refactorAction: Action = {
  description: "refactor auth module",
  estimated_gain: 50,
  estimated_cost: 10,
  category: "refactor",
  delegate_to: "seed",
};

const ctx: ScoreContext = {
  accuracy_regression_rate: 0,
  crash_regression_rate: 0,
  best_known: 100,
  total_visits: 5,
};

const specialistCap: CapabilityContext = { tier: "specialist" };
const criticCap: CapabilityContext = { tier: "critic" };

/** Fake executor that always approves/verifies, for happy-path tests. */
function approvingExecutor(): LoopExecutor & { specialized: string[]; reviewed: string[] } {
  const specialized: string[] = [];
  const reviewed: string[] = [];
  return {
    specialized,
    reviewed,
    async specialize({ node_id }) {
      specialized.push(node_id);
      return { output: "work complete, tests pass", provenance: { tag: "verified", cmd: "npx vitest run", exit: 0, stdout_hash: "sha256:test" }, token_usage: { input_tokens: 30, output_tokens: 5, cached_input_tokens: 12, cache_write_input_tokens: 4, counter_source: "provider_counter" } };
    },
    async review({ node_id }) {
      reviewed.push(node_id);
      return { approved: true, rationale: "approved: tests pass, code clean", measurement_validated: true, token_usage: { input_tokens: 44, output_tokens: 3, cached_input_tokens: 8, cache_write_input_tokens: 2, counter_source: "provider_counter" } };
    },
    log() {},
  };
}

const noUsage = { kind: "unavailable" as const, reason: "test fixture" };

/** Fake executor that rejects (critic rejection → backtrack + failure KB entry). */
function rejectingExecutor(): LoopExecutor {
  return {
    async specialize() {
      return { output: "attempted work but broke tests", provenance: { tag: "claimed", claimant: "seed" }, token_usage: noUsage };
    },
    async review() {
      return { approved: false, rationale: "tests failed", root_cause: "missing mock for auth service", token_usage: noUsage };
    },
    log() {},
  };
}

function makeConfig(overrides: Partial<CampaignLoopConfig> = {}): CampaignLoopConfig {
  return {
    max_iterations: overrides.max_iterations ?? 10,
    specialist_base_prompt: DEFAULT_LOOP_CONFIG.specialist_base_prompt,
    critic_base_prompt: DEFAULT_LOOP_CONFIG.critic_base_prompt,
    specialist_cap: specialistCap,
    critic_cap: criticCap,
    score_ctx: () => ctx,
    use_worktrees: overrides.use_worktrees ?? false,
    branch_actions: overrides.branch_actions ?? (() => null),
    execution_strategy: overrides.execution_strategy,
    panel: overrides.panel,
    run_reviewer: overrides.run_reviewer,
    communications: overrides.communications,
    communication_limit: overrides.communication_limit,
    communication_budget: overrides.communication_budget,
    communication_clock: overrides.communication_clock,
    token_economy: overrides.token_economy,
    interruptions: overrides.interruptions,
    telemetry: overrides.telemetry,
    workspace_composition: overrides.workspace_composition,
    task_skills: overrides.task_skills,
    compaction_every_iterations: overrides.compaction_every_iterations,
    structural_compaction: overrides.structural_compaction,
    critic_retry: overrides.critic_retry,
    scope_retry: overrides.scope_retry,
    retry_context: overrides.retry_context,
    turn_budget_estimate: overrides.turn_budget_estimate,
    dispatch_heartbeat_ms: overrides.dispatch_heartbeat_ms,
  };
}

function startCampaign(mgr: CampaignManager, id = "camp1"): void {
  mgr.startCampaign(id, "plan.md", rootAction);
  mgr.branch(id, "root", [refactorAction, { ...refactorAction, description: "add unit tests", category: "testing" }]);
}

describe("runCampaign — governed skill dispatch", () => {
  it("forwards the exact durable skill identity to the selected specialist", async () => {
    const mgr = new CampaignManager(); mgr.startCampaign("skill-campaign", "plan.md", rootAction);
    const skillInputs = { target_path: "src/example.ts" };
    const skillInputsProvenance = { tag: "claimed" as const, claimant: "cli-command" as const, command_name: "inspect", command_descriptor_hash: `sha256:${"a".repeat(64)}`, input_hash: `sha256:${"b".repeat(64)}` };
    mgr.branch("skill-campaign", "root", [{ ...refactorAction, skill_id: "add-test", skill_version: "1.2.0", skill_inputs: skillInputs, skill_inputs_provenance: skillInputsProvenance }]);
    let observed: { skill_id?: string; skill_version?: string } = {};
    const executor: LoopExecutor = {
      async specialize(input) { observed = input; return { output: "done", provenance: { tag: "claimed", claimant: "seed" }, token_usage: noUsage }; },
      async review() { return { approved: true, rationale: "ok", critic_agent: "lenticel", measurement_validated: true, token_usage: noUsage }; },
    };
    await runCampaign({ manager: mgr, campaign_id: "skill-campaign", executor, config: makeConfig({ max_iterations: 1 }) });
    expect(observed).toMatchObject({ skill_id: "add-test", skill_version: "1.2.0", skill_inputs: skillInputs, skill_inputs_provenance: skillInputsProvenance });
  });
});

describe("runCampaign — task execution strategy", () => {
  it("stops a multi-candidate task on its first durably verified node", async () => {
    const mgr = new CampaignManager(); startCampaign(mgr);
    const executor = approvingExecutor();
    const report = await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({ execution_strategy: { kind: "first_verified" } }) });
    expect(report).toMatchObject({ halted: true, halt_reason: "verified_result", iterations: 1, verified: 1 });
    expect(executor.specialized).toHaveLength(1);
    expect(mgr.getCampaignSnapshot("camp1")?.nodes.filter((node) => node.state === "pending")).toHaveLength(1);
  });

  it("does not stop on a verified node while a dependent (depends_on) plan step is still pending", async () => {
    const mgr = new CampaignManager();
    const implement = { description: "implement the change", estimated_gain: 8, estimated_cost: 2, category: "implementation", delegate_to: "seed" };
    const verify = {
      description: "run the acceptance command", estimated_gain: 6, estimated_cost: 1, category: "verification", delegate_to: "seed",
      depends_on: ["implement the change"],
    };
    const admitted = mgr.admitCampaignPlan({ id: "dep-halt", plan_path: "plan.md", root_action: rootAction, actions: [implement, verify] });
    expect(admitted.ok).toBe(true);
    const executor = approvingExecutor();
    const composed: string[][] = [];
    const report = await runCampaign({ manager: mgr, campaign_id: "dep-halt", executor, config: makeConfig({ execution_strategy: { kind: "first_verified" }, max_iterations: 4, workspace_composition: { compose(input) { composed.push([...input.source_node_ids]); return { ok: true }; } } }) });
    // The implementation node verifies on iteration 1, which releases the
    // dependent acceptance step — the halt must wait for it rather than
    // abandoning the plan's own verification action (field-observed F1).
    expect(report).toMatchObject({ halted: true, halt_reason: "verified_result", verified: 2 });
    expect(executor.specialized).toHaveLength(2);
    expect(composed).toEqual([[expect.any(String)]]);
    const states = mgr.getCampaignSnapshot("dep-halt")!.nodes.map((node) => node.state);
    expect(states.filter((state) => state === "pending")).toHaveLength(0);
  });

  it("fails a dependent node before dispatch when prerequisite composition is unavailable", async () => {
    const mgr = new CampaignManager();
    const implement = { description: "implement prerequisite", estimated_gain: 8, estimated_cost: 2, category: "implementation", delegate_to: "seed" };
    const verify = { description: "verify prerequisite", estimated_gain: 6, estimated_cost: 1, category: "verification", delegate_to: "seed", depends_on: ["implement prerequisite"] };
    expect(mgr.admitCampaignPlan({ id: "dep-no-compose", plan_path: "plan.md", root_action: rootAction, actions: [implement, verify] }).ok).toBe(true);
    const executor = approvingExecutor();
    const report = await runCampaign({ manager: mgr, campaign_id: "dep-no-compose", executor, config: makeConfig({ execution_strategy: { kind: "first_verified" }, max_iterations: 4 }) });
    expect(report.verified).toBe(1);
    expect(executor.specialized).toHaveLength(1);
    const dependent = mgr.getCampaignSnapshot("dep-no-compose")!.nodes.find((node) => mgr.getNodeInfo("dep-no-compose", node.id)?.action.description === "verify prerequisite");
    expect(dependent?.state).toBe("failed");
  });

  it("does not treat a claimed result as task completion", async () => {
    const mgr = new CampaignManager(); startCampaign(mgr);
    const specialized: string[] = [];
    const executor: LoopExecutor = {
      async specialize({ node_id }) { specialized.push(node_id); return { output: "claimed", provenance: { tag: "claimed", claimant: "seed" }, token_usage: noUsage }; },
      async review() { return { approved: true, rationale: "approved but not verified", critic_agent: "lenticel", measurement_validated: false, token_usage: noUsage }; },
    };
    const report = await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({ execution_strategy: { kind: "first_verified" } }) });
    expect(report).toMatchObject({ halted: true, halt_reason: "no_nodes", verified: 0, claimed: 2 });
    expect(specialized).toHaveLength(2);
  });

  it("directly executes the admitted single node without letting UCT choose another candidate", async () => {
    const mgr = new CampaignManager(); startCampaign(mgr);
    const pending = mgr.getCampaignSnapshot("camp1")!.nodes.filter((node) => node.state === "pending");
    const target = pending[1]!.id;
    const executor = approvingExecutor();
    const report = await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({ execution_strategy: { kind: "direct_single_action", node_id: target } }) });
    expect(report).toMatchObject({ halted: true, halt_reason: "verified_result", iterations: 1, verified: 1 });
    expect(executor.specialized).toEqual([target]);
    expect(mgr.getNodeInfo("camp1", target)?.state).toBe("verified");
  });

  it("retains exhaustive selection for an exploratory tree search", async () => {
    const mgr = new CampaignManager(); startCampaign(mgr);
    const executor = approvingExecutor();
    const report = await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({ execution_strategy: { kind: "tree_search" } }) });
    // WA-69: exploration still runs to exhaustion (both children specialized
    // below), but the terminal label now reflects the achieved result
    // (verified: 2) instead of reading identically to a hollow "no_nodes"
    // halt that verified nothing.
    expect(report).toMatchObject({ halted: true, halt_reason: "verified_result", verified: 2 });
    expect(executor.specialized).toHaveLength(2);
  });

  it("WA-69: halts no_nodes only when the exhausted frontier never verified anything", async () => {
    const mgr = new CampaignManager(); startCampaign(mgr);
    const executor: LoopExecutor = {
      async specialize() { return { output: "claimed", provenance: { tag: "claimed", claimant: "seed" }, token_usage: noUsage }; },
      async review() { return { approved: true, rationale: "approved but not verified", critic_agent: "lenticel", measurement_validated: false, token_usage: noUsage }; },
    };
    const report = await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({ execution_strategy: { kind: "tree_search" } }) });
    expect(report).toMatchObject({ halted: true, halt_reason: "no_nodes", verified: 0, claimed: 2 });
  });

  it("halts 'stranded_work', not 'no_nodes', when the only remaining node is 'interrupted' — selectNode cannot see it, but the frontier is not empty", async () => {
    // Defect: selectNode only ever picks "pending". A node parked
    // "interrupted" (ADR-016, a recoverable operational stop) is invisible
    // to it, so a resumed campaign whose sole node is interrupted reported
    // "no_nodes" — indistinguishable from a genuinely exhausted, hollow
    // tree — even though real, recoverable work still exists.
    const mgr = new CampaignManager();
    mgr.startCampaign("camp1", "plan.md", rootAction);
    const [nodeId] = mgr.branch("camp1", "root", [refactorAction]);
    // Interrupt the node directly through the manager's real `interrupt`
    // command (the same one a `LoopInterruptionPort` adapter calls in
    // production) rather than driving it through a first `runCampaign` —
    // a run that itself exhausts its iteration budget durably marks the
    // WHOLE campaign halted (`completeAutoHalt`), which would make the
    // second call below halt immediately on `manager.isHalted`'s durable
    // flag before selection ever runs, testing the wrong thing.
    mgr.interrupt({
      campaign_id: "camp1", node_id: nodeId!,
      operation_id: `test-interrupt:${nodeId}`,
      scope: "node", reason: "network blip",
      expected_version: mgr.getCampaignVersion("camp1"),
      provenance: { tag: "claimed", claimant: "test" },
      acknowledge: () => {},
    });
    expect(mgr.getNodeInfo("camp1", nodeId!)?.state).toBe("interrupted");

    // selectNode sees only "pending" nodes — none exist. Without this fix,
    // this would report "no_nodes" (tree exhausted), indistinguishable from
    // a genuinely hollow run, even though the interrupted node is real,
    // recoverable work sitting right there.
    const report = await runCampaign({
      manager: mgr, campaign_id: "camp1", executor: approvingExecutor(),
      config: makeConfig({ max_iterations: 5 }),
    });
    expect(report.halted).toBe(true);
    expect(report.halt_reason).toBe("stranded_work");
    expect(report.halt_reason).not.toBe("no_nodes");
    expect(report.iterations).toBe(0);
  });
});

describe("runCampaign — token economy boundary", () => {
  it("routes provider overflow without manufacturing a critic verdict or node failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-loop-epoch-"));
    try {
      const mgr = new CampaignManager(); startCampaign(mgr);
      const executor = approvingExecutor();
      await expect(runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({
        max_iterations: 1,
        token_economy: {
          epochs: new TokenEpochService(directory),
          provider: { counter_id: "provider-counter", capability: () => ({ provider_id: "p", model_id: "m", context_capacity: 100, max_output_tokens: 20, source: "runtime" }), count: () => 81 },
          fallback_capability: { provider_id: "fallback", model_id: "fallback", context_capacity: 100, max_output_tokens: 20, source: "configured" },
          reserved_output_tokens: 20, requested_output_tokens: 20, expansion_id: ({ phase }) => `operation-1:${phase}`,
        },
      }) })).rejects.toMatchObject({ code: "eligible_context_overflow", phase: "specialist" });
      expect(executor.specialized).toHaveLength(0);
      expect(mgr.auditCampaign("camp1").failed).toBe(0);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("turns overflow into the canonical interruption sink when composed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-loop-epoch-"));
    try {
      const mgr = new CampaignManager(); startCampaign(mgr);
      const calls: unknown[] = [];
      const report = await runCampaign({ manager: mgr, campaign_id: "camp1", executor: approvingExecutor(), config: makeConfig({
        max_iterations: 1,
        interruptions: { interrupt: (input) => { calls.push(input); } },
        token_economy: {
          epochs: new TokenEpochService(directory),
          provider: { counter_id: "counter", capability: () => ({ provider_id: "p", model_id: "m", context_capacity: 100, max_output_tokens: 20, source: "runtime" }), count: () => 81 },
          fallback_capability: { provider_id: "f", model_id: "f", context_capacity: 100, max_output_tokens: 20, source: "configured" },
          reserved_output_tokens: 20, requested_output_tokens: 20, expansion_id: ({ phase }) => `op:${phase}`,
        },
      }) });
      expect(report).toMatchObject({ interrupted: 1, failed: 0, kb_entries_written: 0 });
      expect(calls).toMatchObject([{ cause: "context_overflow", phase: "specialist", scope: "node" }]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("routes critic-phase overflow the same way — the specialist ran, but the critic dispatch is suppressed before review", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-loop-epoch-"));
    try {
      const mgr = new CampaignManager(); startCampaign(mgr);
      const calls: unknown[] = [];
      let dispatchCount = 0;
      const executor = approvingExecutor();
      const report = await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({
        max_iterations: 1,
        interruptions: { interrupt: (input) => { calls.push(input); } },
        token_economy: {
          epochs: new TokenEpochService(directory),
          // First call (specialist) stays under capacity; second call (critic) overflows.
          provider: { counter_id: "counter", capability: () => ({ provider_id: "p", model_id: "m", context_capacity: 100, max_output_tokens: 20, source: "runtime" }), count: () => (++dispatchCount === 1 ? 20 : 81) },
          fallback_capability: { provider_id: "f", model_id: "f", context_capacity: 100, max_output_tokens: 20, source: "configured" },
          reserved_output_tokens: 20, requested_output_tokens: 20, expansion_id: ({ phase }) => `op:${phase}`,
        },
      }) });
      expect(executor.specialized).toHaveLength(1);
      expect(executor.reviewed).toHaveLength(0);
      expect(report).toMatchObject({ interrupted: 1, failed: 0 });
      expect(calls).toMatchObject([{ cause: "context_overflow", phase: "critic", scope: "node" }]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("persists provider cache usage after a dispatched expansion", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-loop-epoch-"));
    try {
      const mgr = new CampaignManager(); startCampaign(mgr); let selected = "";
      const service = new TokenEpochService(directory);
      const executor: LoopExecutor = {
        async specialize({ node_id }) { selected = node_id; return { output: "ok", provenance: { tag: "verified", cmd: "test", exit: 0, stdout_hash: "sha256:test" }, token_usage: { input_tokens: 30, output_tokens: 5, cached_input_tokens: 12, cache_write_input_tokens: 4, counter_source: "provider_counter" } }; },
        async review() { return { approved: true, rationale: "approved", token_usage: { input_tokens: 44, output_tokens: 3, cached_input_tokens: 8, cache_write_input_tokens: 2, counter_source: "provider_counter" } }; },
      };
      await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({
        max_iterations: 1,
        token_economy: {
          epochs: service,
          provider: { counter_id: "provider-counter", capability: () => ({ provider_id: "p", model_id: "m", context_capacity: 100, max_output_tokens: 20, source: "runtime" }), count: () => 20 },
          fallback_capability: { provider_id: "fallback", model_id: "fallback", context_capacity: 100, max_output_tokens: 20, source: "configured" },
          reserved_output_tokens: 20, requested_output_tokens: 20, expansion_id: ({ phase }) => `operation-1:${phase}`,
        },
      }) });
      expect(new TokenEpochService(directory).get("camp1", selected, "operation-1:specialist")?.usage).toMatchObject({ cached_input_tokens: 12, cache_write_input_tokens: 4 });
      expect(new TokenEpochService(directory).get("camp1", selected, "operation-1:critic")?.usage).toMatchObject({ input_tokens: 44, cached_input_tokens: 8 });
      expect(new TokenEpochService(directory).get("camp1", selected, "operation-1:critic")?.epoch_id).not.toBe(new TokenEpochService(directory).get("camp1", selected, "operation-1:specialist")?.epoch_id);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe("runCampaign — recoverable specialist operations", () => {
  it("interrupts a recoverable transport failure instead of terminally failing and learning it", async () => {
    const mgr = new CampaignManager(); startCampaign(mgr);
    const calls: Array<{ cause: string; phase: string; reason: string }> = [];
    const executor: LoopExecutor = {
      async specialize() {
        return {
          output: "",
          provenance: { tag: "claimed", claimant: "seed" },
          token_usage: noUsage,
          error: { kind: "transport_error", recoverable: true, provenance: { tag: "claimed", claimant: "seed" }, message: "connection reset by peer" },
        };
      },
      async review() { throw new Error("critic must not run after a specialist transport failure"); },
    };
    const report = await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({
      max_iterations: 2,
      interruptions: { interrupt(input) {
        calls.push(input);
        mgr.interrupt({
          campaign_id: input.campaign_id, node_id: input.node_id,
          operation_id: "transport-interrupt-1", scope: input.scope,
          reason: input.reason, expected_version: mgr.getCampaignVersion(input.campaign_id),
          provenance: { tag: "generated", generator: "test-runtime", input_hash: "transport-interrupt-1" },
          acknowledge: () => {},
        });
      } },
    }) });

    expect(report).toMatchObject({ interrupted: 1, failed: 0, kb_entries_written: 0 });
    expect(report.halt_reason).not.toBe("no_nodes");
    expect(calls).toEqual([expect.objectContaining({ cause: "operational_error", phase: "specialist", reason: "transport_error: connection reset by peer" })]);
    const interrupted = mgr.getCampaignSnapshot("camp1")!.nodes.find((node) => node.state === "interrupted");
    expect(interrupted).toBeDefined();
    expect(mgr.getRecoverableNodes("camp1")).toEqual([expect.objectContaining({ node_id: interrupted!.id, prior_operation_id: "transport-interrupt-1" })]);
    expect(mgr.auditCampaign("camp1").failed).toBe(0);
  });

  it("keeps an explicitly unrecoverable transport failure terminal", async () => {
    const mgr = new CampaignManager(); startCampaign(mgr);
    const calls: unknown[] = [];
    const executor: LoopExecutor = {
      async specialize() {
        return {
          output: "",
          provenance: { tag: "claimed", claimant: "seed" },
          token_usage: noUsage,
          error: { kind: "transport_error", recoverable: false, provenance: { tag: "claimed", claimant: "seed" }, message: "invalid endpoint" },
        };
      },
      async review() { throw new Error("critic must not run after a specialist transport failure"); },
    };
    const report = await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({
      max_iterations: 1,
      interruptions: { interrupt(input) { calls.push(input); } },
    }) });

    expect(report).toMatchObject({ interrupted: 0, failed: 1 });
    expect(calls).toEqual([]);
    expect(mgr.auditCampaign("camp1").failed).toBe(1);
  });
});

describe("runCampaign — happy path", () => {
  it("selects, expands, dispatches, reviews, records verified, and reports", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const executor = approvingExecutor();

    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      config: makeConfig({ max_iterations: 3 }),
    });

    expect(report.campaign_id).toBe("camp1");
    expect(executor.specialized.length).toBeGreaterThan(0);
    expect(executor.reviewed.length).toBe(executor.specialized.length);
    expect(report.verified).toBeGreaterThan(0);
    expect(report.failed).toBe(0);
    expect(report.halted).toBe(true);
    expect(report.path.length).toBeGreaterThan(0);
  });

  it("injects KB context into specialist and critic prompts", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const prompts: { role: string; prompt: string }[] = [];

    const executor: LoopExecutor = {
      async specialize({ prompt }) {
        prompts.push({ role: "specialist", prompt });
        return { output: "ok", provenance: { tag: "verified", cmd: "t", exit: 0, stdout_hash: "sha256:test" }, token_usage: noUsage };
      },
      async review({ prompt }) {
        prompts.push({ role: "critic", prompt });
        return { approved: true, rationale: "approved", token_usage: noUsage };
      },
      log() {},
    };

    await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({ max_iterations: 2 }) });

    const spec = prompts.find((p) => p.role === "specialist");
    const crit = prompts.find((p) => p.role === "critic");
    expect(spec).toBeDefined();
    expect(crit).toBeDefined();
    // Both prompts carry the base role prompt.
    expect(spec!.prompt).toContain(DEFAULT_LOOP_CONFIG.specialist_base_prompt);
    expect(crit!.prompt).toContain(DEFAULT_LOOP_CONFIG.critic_base_prompt);
  });

  it("branches children when branch_actions returns actions", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const executor = approvingExecutor();

    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      config: makeConfig({
        max_iterations: 4,
        branch_actions: () => [{ ...refactorAction, description: "child of verified" }],
      }),
    });

    // Branching should let the tree grow beyond the initial 2 leaves.
    expect(executor.specialized.length).toBeGreaterThan(2);
    expect(report.verified).toBeGreaterThan(0);
  });

  it("routes selection through NodeCard capability routing when task skills are given — divergent outcomes prove real routing", async () => {
    // Previous version of this test only asserted report.campaign_id/verified/halted,
    // which hold identically whether or not capability routing ever ran (audit
    // finding 2026-08-04: "routing proof test cannot fail"). This version
    // correlates the loop's `capability_routed` signal (matched: card overlap
    // with task_skills) against the independently-derived `selected` event's
    // category for the SAME node_id, across a run that dispatches both of
    // startCampaign's leaf children — one whose card carries "refactor"
    // (matches task_skills) and one whose card carries "testing" (doesn't).
    // If routing were broken (always/never matched, or driven by anything
    // other than actual card-skill overlap) this per-node correlation, and
    // the presence of BOTH a true and a false outcome in one run, would fail.
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const executor = approvingExecutor();
    const events: LoopEvent[] = [];

    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor: { ...executor, log: (e) => events.push(e) },
      config: makeConfig({ max_iterations: 3, task_skills: ["refactor"] }),
    });

    expect(report.campaign_id).toBe("camp1");
    expect(report.verified).toBeGreaterThan(0);
    expect(report.halted).toBe(true);

    const routedByNode = new Map<string, boolean>();
    for (const e of events) if (e.type === "capability_routed") routedByNode.set(e.node_id, e.matched);
    const categoryByNode = new Map<string, string>();
    for (const e of events) if (e.type === "selected") categoryByNode.set(e.node_id, e.category);

    // Both leaf categories from startCampaign must have actually been selected.
    expect(new Set(categoryByNode.values())).toEqual(new Set(["refactor", "testing"]));
    expect(routedByNode.size).toBe(categoryByNode.size);

    for (const [nodeId, matched] of routedByNode) {
      expect(matched).toBe(categoryByNode.get(nodeId) === "refactor");
    }
    // The signal is not constant within this single run.
    expect([...routedByNode.values()]).toContain(true);
    expect([...routedByNode.values()]).toContain(false);
  });

  it("reports no capability match for any selection when task skills overlap no card", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const executor = approvingExecutor();
    const events: LoopEvent[] = [];

    await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor: { ...executor, log: (e) => events.push(e) },
      config: makeConfig({ max_iterations: 3, task_skills: ["skill-that-matches-nothing"] }),
    });

    const routed = events.filter(
      (e): e is Extract<LoopEvent, { type: "capability_routed" }> => e.type === "capability_routed",
    );
    expect(routed.length).toBeGreaterThan(0);
    expect(routed.every((e) => e.matched === false)).toBe(true);
  });

  it("never records a CompactionLifecycle for auto-compaction — no structural folding is implemented (G-04)", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const executor = approvingExecutor();
    const events: LoopEvent[] = [];
    await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor: { ...executor, log: (e) => events.push(e) },
      config: makeConfig({ max_iterations: 2, compaction_every_iterations: 1 }),
    });
    // Recording `status: "completed"` for a compaction that never folded
    // anything would be a fabricated ledger claim — the loop must not do
    // that, so the lifecycle ledger stays genuinely empty every time the
    // policy fires, not "maybe recorded, maybe not".
    expect(mgr.getCompactionLifecycles("camp1")).toHaveLength(0);
    // The absence is surfaced as a typed event instead of silently vanishing
    // behind a swallowed AuditIntegrityError (the pre-fix behavior).
    expect(events.some((e) => e.type === "compaction_skipped")).toBe(true);
  });

  it("reports a cancelled structural compaction as interrupted, not skipped", async () => {
    const mgr = new CampaignManager(); startCampaign(mgr);
    const events: LoopEvent[] = [];
    await runCampaign({
      manager: mgr, campaign_id: "camp1", executor: { ...approvingExecutor(), log: (event) => events.push(event) },
      config: makeConfig({ max_iterations: 1, compaction_every_iterations: 1, structural_compaction: {
        compact: async () => ({ status: "interrupted", reason: "operator cancelled compaction" }),
      } }),
    });
    expect(events).toContainEqual({ type: "compaction_interrupted", node_id: expect.any(String), reason: "operator cancelled compaction" });
    expect(events.some((event) => event.type === "compaction_skipped" && event.reason === "operator cancelled compaction")).toBe(false);
  });
});

describe("runCampaign — dispatch heartbeat (observability for a long in-flight specialist/critic call)", () => {
  // 2026-08-27 incident: an hour-long real `arbor run` capture logged exactly
  // one `specialist_dispatched` line and then total ledger silence for the
  // rest of the hour — `executor.specialize` is a single opaque `await`, so
  // nothing distinguishes "still genuinely working" from "wedged" while it
  // is pending. These heartbeats close that blind spot without changing
  // dispatch semantics (no timeout/retry/cancellation follows from one).
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  it("emits periodic dispatch_heartbeat events while a specialist call is still pending", async () => {
    const mgr = new CampaignManager(); startCampaign(mgr);
    const events: LoopEvent[] = [];
    const executor: LoopExecutor = {
      async specialize() {
        await sleep(120);
        return { output: "ok", provenance: { tag: "claimed", claimant: "seed" }, token_usage: noUsage };
      },
      async review() {
        return { approved: true, rationale: "approved", token_usage: noUsage };
      },
      log: (event) => events.push(event),
    };

    await runCampaign({
      manager: mgr, campaign_id: "camp1", executor,
      config: makeConfig({ max_iterations: 1, dispatch_heartbeat_ms: 20 }),
    });

    const heartbeats = events.filter((e) => e.type === "dispatch_heartbeat" && e.phase === "specialist");
    expect(heartbeats.length).toBeGreaterThan(0);
    // Every heartbeat lands strictly between dispatch and the event that
    // follows it — proof this is real mid-flight signal, not a fabricated
    // burst emitted once specialize() already settled.
    const dispatchIdx = events.findIndex((e) => e.type === "specialist_dispatched");
    const lastHeartbeatIdx = events.reduce((last, event, index) => event.type === "dispatch_heartbeat" && event.phase === "specialist" ? index : last, -1);
    const nextEventIdx = events.findIndex((e, i) => i > lastHeartbeatIdx && e.type !== "dispatch_heartbeat");
    expect(dispatchIdx).toBeGreaterThanOrEqual(0);
    expect(lastHeartbeatIdx).toBeGreaterThan(dispatchIdx);
    expect(nextEventIdx).toBeGreaterThan(lastHeartbeatIdx);
  });

  it("emits periodic dispatch_heartbeat events while a critic call is still pending", async () => {
    const mgr = new CampaignManager(); startCampaign(mgr);
    const events: LoopEvent[] = [];
    const executor: LoopExecutor = {
      async specialize() {
        return { output: "ok", provenance: { tag: "claimed", claimant: "seed" }, token_usage: noUsage };
      },
      async review() {
        await sleep(120);
        return { approved: true, rationale: "approved", token_usage: noUsage };
      },
      log: (event) => events.push(event),
    };

    await runCampaign({
      manager: mgr, campaign_id: "camp1", executor,
      config: makeConfig({ max_iterations: 1, dispatch_heartbeat_ms: 20 }),
    });

    expect(events.some((e) => e.type === "dispatch_heartbeat" && e.phase === "critic")).toBe(true);
  });

  it("emits no heartbeats at all when dispatch_heartbeat_ms is 0 (opt-out preserves legacy silence)", async () => {
    const mgr = new CampaignManager(); startCampaign(mgr);
    const events: LoopEvent[] = [];
    const executor: LoopExecutor = {
      async specialize() {
        await sleep(60);
        return { output: "ok", provenance: { tag: "claimed", claimant: "seed" }, token_usage: noUsage };
      },
      async review() {
        return { approved: true, rationale: "approved", token_usage: noUsage };
      },
      log: (event) => events.push(event),
    };

    await runCampaign({
      manager: mgr, campaign_id: "camp1", executor,
      config: makeConfig({ max_iterations: 1, dispatch_heartbeat_ms: 0 }),
    });

    expect(events.some((e) => e.type === "dispatch_heartbeat")).toBe(false);
  });
});

describe("runCampaign — rejection/backtrack", () => {
  it("records failed nodes on critic rejection and writes failure KB entries", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const executor = rejectingExecutor();

    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      config: makeConfig({ max_iterations: 3 }),
    });

    expect(report.failed).toBeGreaterThan(0);
    // KB entries were written for failures (root_cause documented).
    expect(mgr.auditCampaign("camp1").total).toBeGreaterThan(0);
    // Critic rejection does NOT verify a node.
    expect(report.verified).toBe(0);
  });
});

describe("runCampaign — halt behavior", () => {
  it("halts on max_iterations when the tree never converges", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const executor = approvingExecutor();

    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      config: makeConfig({ max_iterations: 2 }),
    });

    expect(report.iterations).toBeLessThanOrEqual(2);
    expect(report.halted).toBe(true);
  });

  it("halts cleanly when no nodes remain expandable", async () => {
    const mgr = new CampaignManager();
    // No children branched — after root (verified), nothing is pending.
    mgr.startCampaign("empty", "plan.md", rootAction);

    const executor = approvingExecutor();
    const report = await runCampaign({
      manager: mgr,
      campaign_id: "empty",
      executor,
      config: makeConfig({ max_iterations: 10 }),
    });

    // Nothing to expand — the loop halts immediately without dispatching.
    expect(executor.specialized.length).toBe(0);
    expect(report.halted).toBe(true);
  });
});

describe("runCampaign — defensive node-info fallback", () => {
  it("dispatches emptyAction metadata rather than throwing when a just-selected node's info is unexpectedly unavailable", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    // A thin proxy over the real manager: every method behaves exactly as the
    // real CampaignManager, except getNodeInfo returns null on its first call
    // — simulating the narrow race the loop defends against between
    // selectNode returning an id and getNodeInfo resolving it.
    let getNodeInfoCalls = 0;
    const proxiedManager = new Proxy(mgr, {
      get(target, prop, receiver) {
        if (prop === "getNodeInfo") {
          return (...args: Parameters<CampaignManager["getNodeInfo"]>) => {
            getNodeInfoCalls++;
            return getNodeInfoCalls === 1 ? null : Reflect.apply(target.getNodeInfo, target, args);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as CampaignManager;

    let dispatchedAction: Action | undefined;
    const executor: LoopExecutor = {
      async specialize({ action }) {
        dispatchedAction = action;
        return { output: "work complete, tests pass", provenance: { tag: "claimed", claimant: "seed" }, token_usage: noUsage };
      },
      async review() {
        return { approved: true, rationale: "approved", token_usage: noUsage };
      },
      log() {},
    };

    await runCampaign({ manager: proxiedManager, campaign_id: "camp1", executor, config: makeConfig({ max_iterations: 1 }) });

    expect(getNodeInfoCalls).toBeGreaterThan(0);
    expect(dispatchedAction).toEqual({
      description: "(action metadata unavailable)",
      estimated_gain: 0,
      estimated_cost: 0,
      category: "unknown",
      delegate_to: "seed",
    });
  });
});

describe("runCampaign — worktrees", () => {
  it("acquires and releases worktree leases when use_worktrees=true", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const executor = approvingExecutor();
    const worktrees = new WorktreeManager({}, true); // dryRun

    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      config: makeConfig({ use_worktrees: true, max_iterations: 2 }),
      worktrees,
    });

    expect(report.verified).toBeGreaterThan(0);
    // All leases released after completion.
    expect(worktrees.listActive().length).toBe(0);
  });

  it("consumes an operator-authorized recovery lease instead of rejecting it as a duplicate", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const nodeId = mgr.getCampaignSnapshot("camp1")!.nodes.find((node) => node.parent_id === "root")!.id;
    const worktrees = new WorktreeManager({}, true);
    expect(worktrees.acquireLease({ campaign_id: "camp1", node_id: nodeId, specialist: "seed" })).not.toBeNull();

    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor: approvingExecutor(),
      config: makeConfig({ use_worktrees: true, max_iterations: 1 }),
      worktrees,
    });

    expect(report.verified).toBe(1);
    expect(worktrees.listActive()).toEqual([]);
  });

  it("releases the lease when specialist dispatch throws", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const worktrees = new WorktreeManager({}, true);
    const executor: LoopExecutor = {
      async specialize() { throw new Error("specialist crashed"); },
      async review() { return { approved: true, rationale: "unreachable", token_usage: noUsage }; },
    };

    await expect(runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      config: makeConfig({ use_worktrees: true }),
      worktrees,
    })).rejects.toThrow("specialist crashed");
    expect(worktrees.listActive()).toEqual([]);
  });

  it("keeps the lease held (never releases it) when critic dispatch throws — the node ends awaiting_review, still live", async () => {
    // Defect fix: a node left `awaiting_review` (real specialist work, but
    // no critic verdict because dispatching the critic itself failed) is
    // NOT terminal (see `TERMINAL_NODE_STATES`). Releasing its lease here
    // would abandon its uncommitted worktree changes to a best-effort,
    // exception-swallowing capture — this test previously asserted the
    // opposite (lease released) as if that were correct; it was the bug.
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const worktrees = new WorktreeManager({}, true);
    const executor: LoopExecutor = {
      async specialize() {
        return { output: "done", provenance: { tag: "claimed", claimant: "seed" }, token_usage: noUsage };
      },
      async review() { throw new Error("critic crashed"); },
    };

    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      config: makeConfig({ use_worktrees: true }),
      worktrees,
    });
    expect(report.review_pending).toBeGreaterThan(0);
    expect(report.cleanup.leases_released).toBe(0);
    // Both branched nodes end awaiting_review; both keep their lease live.
    expect(worktrees.listActive()).toHaveLength(2);
    for (const active of worktrees.listActive()) {
      const info = mgr.getNodeInfo("camp1", active.node_id);
      expect(info?.state).toBe("awaiting_review");
    }
  });

  it("keeps the lease held (never releases it) when a panel reviewer throws — the node ends awaiting_review, still live", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const worktrees = new WorktreeManager({}, true);
    const executor = approvingExecutor();

    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      config: makeConfig({
        use_worktrees: true,
        panel: new PanelOfCritics(),
        run_reviewer: async () => { throw new Error("panel reviewer crashed"); },
      }),
      worktrees,
    });
    expect(report.review_pending).toBeGreaterThan(0);
    expect(report.cleanup.leases_released).toBe(0);
    expect(worktrees.listActive()).toHaveLength(2);
  });

  it("releases an acquired lease when the isolation gate fails", async () => {
    class IsolationFailWorktrees extends WorktreeManager {
      released = 0;
      override acquireLease(params: { campaign_id: string; node_id: string; specialist: string }) {
        return {
          node_id: params.node_id,
          campaign_id: params.campaign_id,
          branch: "test",
          path: ".tmp",
          acquired_at: new Date().toISOString(),
          acquired_by: params.specialist,
          starting_commit: "",
          active: true,
        };
      }
      override releaseLease() { this.released++; return true; }
    }

    const mgr = new CampaignManager();
    startCampaign(mgr);
    const worktrees = new IsolationFailWorktrees({}, true);
    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor: approvingExecutor(),
      config: makeConfig({ use_worktrees: true, max_iterations: 1 }),
      worktrees,
    });

    expect(worktrees.released).toBe(1);
    expect(report.cleanup.leases_released).toBe(1);
  });

  it("does not misreport a refused lease acquisition as a starting commit mismatch", async () => {
    class RefusingWorktrees extends WorktreeManager {
      override acquireLease() { return null; }
      override get lastAcquireFailure() { return "repository has an uncommitted dependency artifact"; }
    }

    const mgr = new CampaignManager();
    startCampaign(mgr);
    await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor: approvingExecutor(),
      config: makeConfig({ use_worktrees: true, max_iterations: 1 }),
      worktrees: new RefusingWorktrees({}, true),
    });

    const failed = mgr.getCampaignSnapshot("camp1")!.nodes.find((node) => node.state === "failed")!;
    expect(failed.gate_records.at(-1)?.detail).toBe("worktree not isolated; no active lease on worktree");
    expect(failed.specialist_output).toContain("repository has an uncommitted dependency artifact");
  });

  it("real git repo: a full campaign leaves zero arbor/* branches and zero leaked worktrees behind", async () => {
    // End-to-end proof for the measured incident: a hygiene pass found 306
    // orphaned arbor/* branches and 6 orphaned worktrees (47M) after normal
    // `run`/`demo` campaigns — not just crashes. This drives the REAL loop
    // (not dryRun) against a throwaway repo through several expanded nodes
    // and asserts both counts are back to zero afterward. Before the
    // `releaseLease` branch-deletion fix, this test fails: the worktree
    // directories disappear but every node's `arbor/<campaign>/<node>`
    // branch survives.
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const repo = mkdtempSync(join(tmpdir(), "arbor-loop-e2e-"));
    try {
      spawnSync("git", ["init", "-q", repo], { stdio: "ignore" });
      spawnSync("git", ["-C", repo, "config", "user.email", "t@t"], { stdio: "ignore" });
      spawnSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "ignore" });
      require("node:fs").writeFileSync(join(repo, "x.txt"), "hi\n");
      spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
      spawnSync("git", ["-C", repo, "commit", "-qm", "init"], { stdio: "ignore" });

      const listArborBranches = (): string[] =>
        spawnSync("git", ["-C", repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/arbor/"], { encoding: "utf-8" })
          .stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      const listWorktrees = (): string[] =>
        spawnSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf-8" })
          .stdout.split("\n").filter((l) => l.startsWith("worktree ") && !l.endsWith(repo));

      expect(listArborBranches()).toEqual([]);
      expect(listWorktrees()).toEqual([]);

      const mgr = new CampaignManager();
      startCampaign(mgr); // root branches into 2 expandable child nodes
      const executor = approvingExecutor();
      const worktrees = new WorktreeManager({ repoRoot: repo }); // real, NOT dryRun

      const report = await runCampaign({
        manager: mgr,
        campaign_id: "camp1",
        executor,
        config: makeConfig({ use_worktrees: true, max_iterations: 10 }),
        worktrees,
      });

      // Sanity: the loop actually did real per-node work through real
      // worktrees, so a passing assertion below is not vacuous.
      expect(executor.specialized.length).toBeGreaterThanOrEqual(2);
      expect(report.verified + report.claimed).toBeGreaterThanOrEqual(2);

      expect(listArborBranches()).toEqual([]);
      expect(listWorktrees()).toEqual([]);
    } finally {
      spawnSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("runCampaign — cancellation", () => {
  it("reports cancellation separately from halt and keeps the active lease held (no interruption port to durably record recovery authority over it)", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const worktrees = new WorktreeManager({}, true);
    const controller = new AbortController();
    const executor: LoopExecutor = {
      async specialize({ signal }) {
        controller.abort(new Error("operator cancelled"));
        if (signal?.aborted) throw signal.reason;
        return { output: "unreachable", provenance: { tag: "claimed", claimant: "seed" }, token_usage: noUsage };
      },
      async review() { return { approved: true, rationale: "unreachable", token_usage: noUsage }; },
    };

    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      config: makeConfig({ use_worktrees: true }),
      worktrees,
      signal: controller.signal,
    });

    expect(report.cancelled).toBe(true);
    expect(report.cancellation_reason).toBe("operator cancelled");
    expect(report.halted).toBe(false);
    expect(report.halt_reason).toBeNull();
    // No `config.interruptions` port is wired here, so the cancellation
    // never became a durable `"interrupted"` ledger state (see the
    // "legacy terminal behavior" comment on the retry/interrupt branch
    // above) — the node stays "expanding". A crash-adjacent stop with no
    // in-process controlled path left is exactly the case a released lease
    // could hand to a concurrent dispatch while this node's uncommitted
    // work is still the only copy of it; leaving it held for the next
    // `runCampaign`'s `reconcileLeases` staleness sweep (ADR-101) is the
    // safe choice, not a leak.
    expect(report.cleanup.leases_released).toBe(0);
    expect(worktrees.listActive()).toHaveLength(1);
    expect(mgr.getCampaignSnapshot("camp1")?.nodes.find((n) => n.id === worktrees.listActive()[0]!.node_id)?.state).toBe("expanding");
  });

  it("does not dispatch when already cancelled", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const executor = approvingExecutor();
    const controller = new AbortController();
    controller.abort("stop now");

    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      config: makeConfig(),
      signal: controller.signal,
    });

    expect(executor.specialized).toHaveLength(0);
    expect(report.cancelled).toBe(true);
    expect(report.cancellation_reason).toBe("stop now");
    expect(report.halted).toBe(false);
  });
});

describe("runCampaign — telemetry", () => {
  it("emits phase-timing and usage-cost observations through the telemetry port", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const base = approvingExecutor();
    const sources = ["system_instructions", "project_instructions", "task", "repository_graph", "code", "tool_output", "trajectory", "memory", "critic_feedback", "human_input"] as const;
    const context = { offered_tokens: 10, retained_tokens: 8, pruned_tokens: 2, indexed_reference_tokens: 0, stable_prefix_tokens: 0, dynamic_tokens: 8,
      per_source: sources.map((source) => ({ source, offered_tokens: source === "task" ? 10 : 0, retained_tokens: source === "task" ? 8 : 0,
        cache_class: (["system_instructions", "project_instructions", "repository_graph", "memory"] as readonly string[]).includes(source) ? "stable" as const : "dynamic" as const,
        disposition: source === "task" ? "mixed" as const : "absent" as const, reason: "fixture", provenance: { tag: "generated" as const, generator: "fixture", input_hash: source }, evidence_pointer: `context-source:${source}:fixture` })) } satisfies ExecutorContextComposition;
    const executor: LoopExecutor = { ...base,
      async specialize(input) { return { ...(await base.specialize(input)), context_composition: context, tool_economy: { offered_calls: 3, host_executions: 2, reused_reads: 1, avoided_output_bytes: 1000 } }; },
      async review(input) { return { ...(await base.review(input)), context_composition: context, tool_economy: { offered_calls: 0, host_executions: 0, reused_reads: 0, avoided_output_bytes: 0 } }; } };
    const phases: string[] = [];
    const costs: number[] = [];
    const costAgents: string[] = [];
    const attributions: unknown[] = [];
    const contexts: Array<{ phase: string; idempotency_key: string }> = [];
    const toolEconomy: Array<{ phase: string; reused_reads: number }> = [];
    const telemetry = {
      recordPhaseTiming(input: { phase: string }) { phases.push(input.phase); return "id"; },
      recordUsageCost(input: { input_tokens: number; agent_id: string }) { costs.push(input.input_tokens); costAgents.push(input.agent_id); return "id"; },
      recordNodeCostAttribution(input: unknown) { attributions.push(input); return "node-cost"; },
      recordContextEconomy(input: { phase: string; idempotency_key: string }) { contexts.push(input); return "context"; },
      recordToolEconomy(input: { phase: string; reused_reads: number }) { toolEconomy.push(input); return "tools"; },
    };
    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      config: makeConfig({ max_iterations: 2, telemetry }),
    });

    expect(report.iterations).toBeGreaterThan(0);
    // Every completed iteration emits select + expand + critic + backprop.
    expect(phases.filter((p) => p === "select").length).toBeGreaterThan(0);
    expect(phases.filter((p) => p === "expand").length).toBeGreaterThan(0);
    expect(phases.filter((p) => p === "critic").length).toBeGreaterThan(0);
    expect(phases.filter((p) => p === "backprop").length).toBeGreaterThan(0);
    // Specialist usage cost is emitted when the fake returns token usage.
    expect(costs.length).toBeGreaterThan(0);
    expect(costAgents).toEqual(expect.arrayContaining(["seed", "lenticel"]));
    expect(attributions).toContainEqual(expect.objectContaining({ type: "node_cost_attribution", produced_verified_progress: true,
      total_tokens: expect.objectContaining({ cache_read: 20, cache_write: 6 }) }));
    expect(contexts.filter((entry) => entry.phase === "expand")).toHaveLength(report.iterations);
    expect(contexts.filter((entry) => entry.phase === "critic")).toHaveLength(report.iterations);
    expect(new Set(contexts.map((entry) => entry.idempotency_key)).size).toBe(contexts.length);
    expect(toolEconomy.filter((entry) => entry.phase === "expand" && entry.reused_reads === 1)).toHaveLength(report.iterations);
    expect(toolEconomy.filter((entry) => entry.phase === "critic" && entry.reused_reads === 0)).toHaveLength(report.iterations);
  });

  it("preserves an executor's configured priced observation instead of fabricating loop pricing", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const base = approvingExecutor();
    const executor: LoopExecutor = {
      ...base,
      async specialize(input) {
        const result = await base.specialize(input);
        return { ...result, usage_cost: { provider: "openai", model_family: "gpt", cost: { kind: "priced", minor_units: 17, currency: "USD", minor_unit_exponent: 6, price_source_id: "operator-schedule-2026-08" } } };
      },
      async review(input) {
        const result = await base.review(input);
        return { ...result, usage_cost: { provider: "openai", model_family: "gpt", cost: { kind: "priced", minor_units: 19, currency: "USD", minor_unit_exponent: 6, price_source_id: "operator-schedule-2026-08" } } };
      },
    };
    const observations: unknown[] = [];
    await runCampaign({
      manager: mgr, campaign_id: "camp1", executor,
      config: makeConfig({ max_iterations: 1, telemetry: { recordPhaseTiming() { return "phase"; }, recordUsageCost(input) { observations.push(input); return "cost"; } } }),
    });
    expect(observations).toContainEqual(expect.objectContaining({ provider: "openai", model_family: "gpt", cost: expect.objectContaining({ kind: "priced", minor_units: 17, price_source_id: "operator-schedule-2026-08" }) }));
  });

  it("prices the critic span when a panel reviewer reports token usage and a configured cost", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const base = approvingExecutor();
    const schedule = { currency: "USD", minor_unit_exponent: 6, price_source_id: "operator-schedule-2026-10" };
    const executor: LoopExecutor = {
      ...base,
      async specialize(input) {
        return { ...(await base.specialize(input)), usage_cost: { provider: "other", model_family: "other", cost: { kind: "priced", minor_units: 50, ...schedule } } };
      },
    };
    const attributions: Array<{ top_cost_spans: Array<{ kind: string; cost: { kind: string; minor_units?: number } }>; total_cost: { kind: string; minor_units?: number } }> = [];
    const criticCosts: unknown[] = [];
    await runCampaign({
      manager: mgr, campaign_id: "camp1", executor,
      config: makeConfig({
        max_iterations: 1,
        panel: new PanelOfCritics({ reviewers: { lenticel: true, burl: false } }),
        run_reviewer: async () => ({
          approved: true, rationale: "ok",
          token_usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 0, cache_write_input_tokens: 0, counter_source: "provider_counter" },
          usage_cost: { provider: "other", model_family: "other", cost: { kind: "priced", minor_units: 7, ...schedule } },
        }),
        telemetry: {
          recordPhaseTiming() { return "phase"; },
          recordUsageCost(input) { if (input.phase === "critic") criticCosts.push(input.cost); return "cost"; },
          recordNodeCostAttribution(input) { attributions.push(input as never); return "node-cost"; },
        },
      }),
    });
    // Two reviewers run (the panel's mandatory ones), 7 each.
    expect(criticCosts).toContainEqual(expect.objectContaining({ kind: "priced", minor_units: 14 }));
    const critic = attributions[0]?.top_cost_spans.find((span) => span.kind === "critic");
    expect(critic?.cost).toMatchObject({ kind: "priced", minor_units: 14 });
    expect(attributions[0]?.total_cost).toMatchObject({ kind: "priced", minor_units: 64 });
  });

  it("journals the specialist's completed output as a `final` ledger phase message (ADR-016)", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const executor = approvingExecutor();
    const phaseMessages: Array<{ campaign_id: string; node_id: string; phase: string; content: string; content_length_bytes: number; provenance: unknown; idempotency_key: string; operation_id: string }> = [];
    const report = await runCampaign({
      manager: mgr, campaign_id: "camp1", executor,
      config: makeConfig({
        max_iterations: 1,
        telemetry: {
          recordPhaseTiming() { return "phase"; },
          recordUsageCost() { return "cost"; },
          recordPhaseMessage(input) { phaseMessages.push(input as typeof phaseMessages[number]); return "phase-message"; },
        },
      }),
    });
    expect(report.iterations).toBeGreaterThan(0);
    expect(phaseMessages.length).toBeGreaterThan(0);
    const message = phaseMessages[0];
    expect(message.campaign_id).toBe("camp1");
    expect(message.node_id).toBe(executor.specialized[0]);
    expect(message.phase).toBe("final");
    // The real specialist output, byte-identical — not a fabricated summary.
    expect(message.content).toBe("work complete, tests pass");
    expect(message.content_length_bytes).toBe(Buffer.byteLength(message.content, "utf8"));
    expect(message.provenance).toMatchObject({ tag: "verified" });
    expect(message.idempotency_key).toContain(message.node_id);
    // Idempotency keys are unique per node/epoch/role/phase.
    expect(new Set(phaseMessages.map((m) => m.idempotency_key)).size).toBe(phaseMessages.length);
  });

  it("never fabricates a commentary stream — only a genuine `final` message is ever emitted", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const executor = approvingExecutor();
    const phases: string[] = [];
    await runCampaign({
      manager: mgr, campaign_id: "camp1", executor,
      config: makeConfig({
        max_iterations: 2,
        telemetry: {
          recordPhaseTiming() { return "phase"; },
          recordUsageCost() { return "cost"; },
          recordPhaseMessage(input) { phases.push((input as { phase: string }).phase); return "phase-message"; },
        },
      }),
    });
    expect(phases.length).toBeGreaterThan(0);
    expect(phases.every((p) => p === "final")).toBe(true);
  });

  it("truncates an oversized phase message deliberately, logs the truncation, and never bypasses the ledger cap", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const base = approvingExecutor();
    const oversized = "x".repeat(PHASE_MESSAGE_MAX_CONTENT_BYTES + 500);
    const executor: LoopExecutor = {
      ...base,
      async specialize(input) { return { ...(await base.specialize(input)), output: oversized }; },
    };
    const events: LoopEvent[] = [];
    const phaseMessages: Array<{ content: string; content_length_bytes: number }> = [];
    await runCampaign({
      manager: mgr, campaign_id: "camp1", executor: { ...executor, log(e) { events.push(e); } },
      config: makeConfig({
        max_iterations: 1,
        telemetry: {
          recordPhaseTiming() { return "phase"; },
          recordUsageCost() { return "cost"; },
          recordPhaseMessage(input) { phaseMessages.push(input as typeof phaseMessages[number]); return "phase-message"; },
        },
      }),
    });
    expect(phaseMessages.length).toBeGreaterThan(0);
    // The ledger cap is never bypassed — the recorded content is truncated, not the full oversized blob.
    expect(phaseMessages[0].content_length_bytes).toBeLessThanOrEqual(PHASE_MESSAGE_MAX_CONTENT_BYTES);
    expect(phaseMessages[0].content.length).toBeLessThan(oversized.length);
    const truncationEvent = events.find((e) => e.type === "phase_message_truncated");
    expect(truncationEvent).toBeDefined();
    expect((truncationEvent as { original_bytes: number }).original_bytes).toBe(Buffer.byteLength(oversized, "utf8"));
  });
});

describe("runCampaign — user interviews (ADR-019, G-05)", () => {
  it("a lead-level needs_input (a plan step — root's direct child) raises a blocking RequestUserInput and the pending-interview guard fires on the next real run", async () => {
    const mgr = new CampaignManager();
    // startCampaign(mgr) branches two plan-level children off root — those
    // are "the lead" in ADR-019's sense: root itself is born `claimed` with
    // no children (arbor-core's createCampaign) and is never itself
    // dispatched, so the plan's admission-level actions are its direct
    // children, not the tree-structural root.
    startCampaign(mgr);

    let specializeCalls = 0;
    let dispatchedNodeId = "";
    const executor: LoopExecutor = {
      async specialize({ node_id }) {
        specializeCalls++;
        dispatchedNodeId = node_id;
        return {
          output: "this plan step cannot proceed without direction",
          provenance: { tag: "claimed", claimant: "seed" },
          token_usage: noUsage,
          needs_input: {
            question: "Which top-level strategy should the campaign pursue?",
            options: [
              { id: "a", text: "Strategy A", is_other: false },
              { id: "b", text: "Strategy B", is_other: false },
            ],
            requester_role: "seed",
            idempotency_key: `camp1:${node_id}:lead-input`,
          },
        };
      },
      async review() {
        throw new Error("critic must not be dispatched when the specialist needs input");
      },
      log() {},
    };

    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      config: makeConfig({ max_iterations: 5 }),
    });

    expect(specializeCalls).toBe(1);
    // Confirms the dispatched node really is a direct child of root — the
    // premise the "lead" authority assertion below depends on.
    expect(mgr.getNodeInfo("camp1", dispatchedNodeId)?.parent_id).toBe("root");
    expect(report.awaiting_user_input).toBe(true);
    expect(report.halted).toBe(false);

    // Roundtrip: the RequestUserInput is a real, projected ledger record —
    // not just an internal call that happened to fire.
    const records = mgr.getUserInputs("camp1");
    expect(records).toHaveLength(1);
    expect(records[0]!.question.authority).toBe("lead");
    expect(records[0]!.question.blocking).toBe("blocking");
    expect(records[0]!.question.question).toContain("top-level strategy");
    expect(mgr.awaitingUserInput("camp1")).toBe(true);

    // Proof the pending-interview guard now fires on a real path: a second
    // run against the same campaign must not dispatch anything at all.
    let secondRunDispatched = false;
    const guardExecutor: LoopExecutor = {
      async specialize() { secondRunDispatched = true; throw new Error("must not dispatch while awaiting user input"); },
      async review() { secondRunDispatched = true; throw new Error("must not dispatch while awaiting user input"); },
      log() {},
    };
    const report2 = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor: guardExecutor,
      config: makeConfig({ max_iterations: 5 }),
    });
    expect(secondRunDispatched).toBe(false);
    expect(report2.iterations).toBe(0);
    // The ledger-truth guard is what actually matters here — the second run
    // may resolve via either the awaiting-user-input branch or an unrelated
    // halt condition (e.g. below_threshold, since no node has scored yet),
    // but either way it must never reach a dispatch.
    expect(mgr.awaitingUserInput("camp1")).toBe(true);

    // Once the human answers, the guard clears.
    mgr.answerUserInput(records[0]!.id, {
      option_id: "a", custom_text: "", answered_by: "human", answered_at: new Date().toISOString(),
    });
    expect(mgr.awaitingUserInput("camp1")).toBe(false);
  });

  it("a delegated sibling's needs_input (a plan step's own sub-action, branched mid-campaign) is recorded async, not with lead authority", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr); // root + two plan-level (lead) children

    const executor: LoopExecutor = {
      async specialize({ node_id }) {
        const info = mgr.getNodeInfo("camp1", node_id)!;
        if (info.parent_id === "root") {
          // A lead-level plan step: does its work normally so branch_actions
          // below decomposes it into a delegated sub-action.
          return { output: "plan step completed", provenance: { tag: "claimed", claimant: "seed" }, token_usage: noUsage };
        }
        // A delegated sub-action (grandchild of root): cannot proceed
        // without a human call.
        return {
          output: "this sub-action needs a human call before continuing",
          provenance: { tag: "claimed", claimant: "seed" },
          token_usage: noUsage,
          needs_input: {
            question: "Should the specialist proceed with the risky sub-step?",
            options: [{ id: "proceed", text: "Proceed", is_other: false }],
            requester_role: "seed",
            idempotency_key: `camp1:${node_id}:delegated-input`,
          },
        };
      },
      async review({ node_id }) {
        const info = mgr.getNodeInfo("camp1", node_id)!;
        if (info.parent_id === "root") return { approved: true, rationale: "plan step approved", token_usage: noUsage };
        throw new Error("critic must not be dispatched when the specialist needs input");
      },
      log() {},
    };

    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      config: makeConfig({
        max_iterations: 5,
        branch_actions: () => [{ ...refactorAction, description: "delegated sub-action" }],
      }),
    });

    expect(report.awaiting_user_input).toBe(true);
    const records = mgr.getUserInputs("camp1");
    expect(records).toHaveLength(1);
    expect(records[0]!.question.authority).toBe("delegated_needs_input");
    expect(records[0]!.question.blocking).toBe("async");
    // The record's node really is a grandchild of root, not a plan step.
    const recordedNode = mgr.getNodeInfo("camp1", records[0]!.node_id);
    expect(recordedNode?.parent_id).not.toBe("root");
  });
});

describe("runCampaign — classified operational errors (G-08)", () => {
  it("records a specialist timeout as a typed failure, skips the critic, and emits the fault matrix's telemetry outcome", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const phases: { phase: string; outcome: string }[] = [];
    const events: LoopEvent[] = [];
    const telemetry = {
      recordPhaseTiming(input: { phase: string; outcome: string }) { phases.push({ phase: input.phase, outcome: input.outcome }); return "id"; },
      recordUsageCost() { return "id"; },
    };
    const executor: LoopExecutor = {
      async specialize() {
        return {
          output: "",
          provenance: { tag: "claimed", claimant: "seed" },
          token_usage: noUsage,
          error: {
            kind: "timeout", provenance: { tag: "claimed", claimant: "opencode-executor" },
            message: "specialist timed out after 120000ms", elapsed_ms: 120_000, partial_output: null,
            usage: noUsage,
          },
        };
      },
      async review() {
        throw new Error("critic must not be dispatched on a classified specialist error");
      },
      log: (e) => events.push(e),
    };

    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      config: makeConfig({ max_iterations: 2, telemetry }),
    });

    expect(report.failed).toBeGreaterThan(0);
    // FAULT_MATRIX maps "timeout" to the "timeout" telemetry outcome — not
    // the generic success/failure binary every other phase-timing emission
    // used before this.
    expect(phases.some((p) => p.phase === "backprop" && p.outcome === "timeout")).toBe(true);
    const failedEvent = events.find((e): e is Extract<LoopEvent, { type: "node_failed" }> => e.type === "node_failed");
    // U3: the bare error kind previously dropped the observed message here —
    // now it carries the real reason, not just "timeout".
    expect(failedEvent?.root_cause).toBe("timeout: specialist timed out after 120000ms");
    expect(mgr.getNodeInfo("camp1", failedEvent!.node_id)?.state).toBe("failed");
  });

  it("ADR-120: FAULT_MATRIX.policy_refused exists, mapping to failure/terminal (unchanged behavior; the code is now merely distinguishable)", () => {
    expect(FAULT_MATRIX.policy_refused).toEqual({ telemetry_outcome: "failure", recovery: "terminal" });
    // Distinct object identity from internal_error's entry — this is a real
    // new discriminant, not an alias.
    expect(FAULT_MATRIX.policy_refused).not.toBe(FAULT_MATRIX.internal_error);
  });

  it("a 'terminal'-recovery kind never claims a governed abandonment it cannot perform: no branch keys off fault.recovery === \"abandon\"", () => {
    // Defect: FAULT_MATRIX previously named this disposition "abandon",
    // which reads as ADR-012's governed `abandoned` node state (preserves
    // the node, releases the confirmed lease, requires operator/auditor
    // authorization). No code anywhere branches on that value — a
    // context_window_exceeded/internal_error/policy_refused node just falls
    // through to the same typed terminal failure a declined decomposition
    // uses (recordClassifiedError, landing the node in "failed", not a
    // distinct "abandoned" state). The matrix must not name a mechanism the
    // loop does not have.
    for (const kind of ["context_window_exceeded", "internal_error", "policy_refused"] as const) {
      expect(FAULT_MATRIX[kind].recovery).not.toBe("abandon");
      expect(FAULT_MATRIX[kind].recovery).toBe("terminal");
    }
  });

  it("ADR-120: routes a policy_refused specialist error through FAULT_MATRIX's terminal path — telemetry sees the real kind, not internal_error", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const phases: { phase: string; outcome: string }[] = [];
    const events: LoopEvent[] = [];
    const telemetry = {
      recordPhaseTiming(input: { phase: string; outcome: string }) { phases.push({ phase: input.phase, outcome: input.outcome }); return "id"; },
      recordUsageCost() { return "id"; },
    };
    const executor: LoopExecutor = {
      async specialize() {
        return {
          output: "",
          provenance: { tag: "claimed", claimant: "seed" },
          token_usage: noUsage,
          error: {
            kind: "policy_refused", code: "action_scope_path_denied", recoverable: true,
            provenance: { tag: "claimed", claimant: "opencode-executor" },
            message: "execution refused: write path exceeds the system-owned action scope",
          },
        };
      },
      async review() {
        throw new Error("critic must not be dispatched on a classified specialist error");
      },
      log: (e) => events.push(e),
    };

    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      config: makeConfig({ max_iterations: 2, telemetry }),
    });

    expect(report.failed).toBeGreaterThan(0);
    // ADR-120 Decision §3: FAULT_MATRIX.policy_refused.recovery is "terminal"
    // (unchanged behavior, same as internal_error today) — the node still
    // fails, but the *telemetry outcome* and the recorded root_cause now
    // reflect the real policy_refused kind and code, not a collapsed
    // internal_error.
    expect(phases.some((p) => p.phase === "backprop" && p.outcome === "failure")).toBe(true);
    const failedEvent = events.find((e): e is Extract<LoopEvent, { type: "node_failed" }> => e.type === "node_failed");
    expect(failedEvent?.root_cause).toContain("policy_refused");
    expect(failedEvent?.root_cause).not.toContain("internal_error");
    expect(mgr.getNodeInfo("camp1", failedEvent!.node_id)?.state).toBe("failed");
  });

  it("reports the timeout's real observed elapsed_ms as phase-timing duration_ms instead of a hardcoded 0 (fix #3)", async () => {
    // Note: `elapsed_ms`/`partial_output`/`usage` are the frozen
    // NodeError.timeout fields landed by the sibling core-state
    // remediation bucket, not yet present in this worktree's @arbor/core.
    // Production construction sites (claude-code-campaign.ts,
    // native-agent-executor.ts) deliberately do NOT cast around the
    // resulting excess-property error, so it stays visible pending
    // integration. This test literal casts (`as never`) only so the test
    // suite itself can exercise `recordClassifiedError`'s consumption of
    // these fields today, ahead of that landing.
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const phases: { phase: string; outcome: string; duration_ms: number }[] = [];
    const telemetry = {
      recordPhaseTiming(input: { phase: string; outcome: string; duration_ms: number }) { phases.push(input); return "id"; },
      recordUsageCost() { return "id"; },
    };
    const executor: LoopExecutor = {
      async specialize() {
        return {
          output: "",
          provenance: { tag: "claimed", claimant: "seed" },
          token_usage: noUsage,
          error: {
            kind: "timeout",
            provenance: { tag: "claimed", claimant: "claude-code-plugin" },
            message: "Claude Code timed out after 900000ms",
            elapsed_ms: 900_412,
            partial_output: "partial findings",
            usage: { kind: "unavailable", reason: "process killed on timeout before usage was reported" },
          } as never,
        };
      },
      async review() {
        throw new Error("critic must not be dispatched on a classified specialist error");
      },
    };

    await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      config: makeConfig({ max_iterations: 2, telemetry }),
    });

    const backprop = phases.find((p) => p.phase === "backprop" && p.outcome === "timeout");
    expect(backprop?.duration_ms).toBe(900_412);
  });

  it("keeps a critic-boundary transport_error's node awaiting review with its candidate intact instead of scoring it a failure (tranche1 item 3)", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const events: LoopEvent[] = [];
    const executor: LoopExecutor = {
      async specialize() {
        return { output: "real work happened", provenance: { tag: "claimed", claimant: "seed" }, token_usage: noUsage };
      },
      async review() {
        return {
          approved: false,
          rationale: "unreachable — error field takes precedence",
          token_usage: noUsage,
          error: { kind: "transport_error", recoverable: true, provenance: { tag: "claimed", claimant: "opencode-server-executor" }, message: "HTTP 503: service unavailable" },
        };
      },
      log: (e) => events.push(e),
    };

    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      config: makeConfig({ max_iterations: 2 }),
    });

    // A critic transport failure is not a verdict: the specialist's already-
    // completed work must not be discarded and the node must not be scored
    // as a node failure — see docs/proposals/orchestration-refactor-and-
    // retooling-plan.md §13 items 2/3.
    expect(report.failed).toBe(0);
    expect(report.review_pending).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "node_failed")).toBe(false);
    expect(events.some((e) => e.type === "review_pending" && e.reason === "transport_error")).toBe(true);
    const reviewedNodeId = events.find((e): e is Extract<LoopEvent, { type: "review_pending" }> => e.type === "review_pending")!.node_id;
    const info = mgr.getNodeInfo("camp1", reviewedNodeId);
    // `"awaiting_review"` is a frozen @arbor/core NodeState addition not yet
    // landed in this worktree (sibling durable-types bucket) — compared as a
    // string so this assertion typechecks against today's NodeState union
    // and still exercises the real runtime value.
    expect(info?.state as string).toBe("awaiting_review");
    const candidate = (info as unknown as { candidate?: { specialist_output: string; specialist_agent: string; review_status: string } }).candidate;
    expect(candidate).toBeDefined();
    expect(candidate?.specialist_output).toBe("real work happened");
    expect(candidate?.specialist_agent).toBe("seed");
    expect(candidate?.review_status).toBe("awaiting_review");
  });
});

describe("runCampaign — malformed critic after a machine verification verdict (O1, ADR-184)", () => {
  const malformedCritic = {
    approved: false,
    rationale: "n/a",
    token_usage: noUsage,
    error: { kind: "malformed_critic_verdict", recoverable: true, provenance: { tag: "claimed", claimant: "native-critic" }, message: "reply was not a JSON object" },
  } as unknown as Awaited<ReturnType<LoopExecutor["review"]>>;

  it("FAILED machine verification + malformed critic fails the node (verification root cause) instead of parking it, and the campaign does not halt stranded_work", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const events: LoopEvent[] = [];
    const executor: LoopExecutor = {
      async specialize() {
        return {
          output: "work that does not pass",
          provenance: { tag: "claimed", claimant: "seed" },
          deferred_verification: Promise.resolve({ attempted: true as const, failed: true as const, code: "command_exit_nonzero", exit: 1 }),
          token_usage: noUsage,
        };
      },
      async review() { return malformedCritic; },
      log: (e) => events.push(e),
    };
    const report = await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({ max_iterations: 3 }) });
    expect(report.review_pending).toBe(0);
    expect(report.failed).toBeGreaterThan(0);
    expect(report.halt_reason).not.toBe("stranded_work");
    expect(events.some((e) => e.type === "review_failed_after_machine_failure" && e.reason === "malformed_critic_verdict")).toBe(true);
    const failed = events.find((e): e is Extract<LoopEvent, { type: "node_failed" }> => e.type === "node_failed")!;
    expect(failed.root_cause).toContain("machine verification failed: command_exit_nonzero (exit 1)");
    expect((mgr.getCampaignSnapshot("camp1")?.nodes ?? []).some((n) => n.state === "awaiting_review")).toBe(false);
  });

  it("a PASSED machine verification + malformed critic still parks awaiting_review with its candidate kept", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const events: LoopEvent[] = [];
    const executor: LoopExecutor = {
      async specialize() {
        return {
          output: "work that passes",
          provenance: { tag: "claimed", claimant: "seed" },
          deferred_verification: Promise.resolve({ attempted: true as const, failed: false as const } as never),
          token_usage: noUsage,
        };
      },
      async review() { return malformedCritic; },
      log: (e) => events.push(e),
    };
    const report = await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({ max_iterations: 2 }) });
    expect(report.failed).toBe(0);
    expect(report.review_pending).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "review_failed_after_machine_failure")).toBe(false);
    const id = events.find((e): e is Extract<LoopEvent, { type: "review_pending" }> => e.type === "review_pending")!.node_id;
    const info = mgr.getNodeInfo("camp1", id);
    expect(info?.state as string).toBe("awaiting_review");
    expect((info as unknown as { candidate?: { specialist_output: string } }).candidate?.specialist_output).toBe("work that passes");
  });
});

describe("runCampaign — critic-phase containment (B2: an unexpected throw must not kill the run)", () => {
  it("an executor.review that throws (not a classified critic.error) leaves the node awaiting_review with its candidate intact, records recordReviewFailure, and the run completes instead of rejecting", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const events: LoopEvent[] = [];
    const executor: LoopExecutor = {
      async specialize() {
        return { output: "real work happened", provenance: { tag: "claimed", claimant: "seed" }, token_usage: noUsage };
      },
      async review() {
        // Not a classified `critic.error` — an unexpected throw, exactly the
        // shape the field test observed (something inside the harness's own
        // critic-phase plumbing throwing, not the critic transport itself
        // returning a result).
        throw new TypeError("cannot read properties of undefined (reading 'foo')");
      },
      log: (e) => events.push(e),
    };

    // Before B2, this threw out of runCampaign entirely instead of resolving.
    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      config: makeConfig({ max_iterations: 2 }),
    });

    expect(report.failed).toBe(0);
    expect(report.review_pending).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "node_failed")).toBe(false);
    expect(events.some((e) => e.type === "review_pending" && e.reason === "internal_error")).toBe(true);
    const reviewedNodeId = events.find((e): e is Extract<LoopEvent, { type: "review_pending" }> => e.type === "review_pending")!.node_id;
    const info = mgr.getNodeInfo("camp1", reviewedNodeId);
    expect(info?.state as string).toBe("awaiting_review");
    const candidate = (info as unknown as { candidate?: { specialist_output: string; review_status: string } }).candidate;
    expect(candidate?.specialist_output).toBe("real work happened");
    expect(candidate?.review_status).toBe("awaiting_review");
  });

  it("a throw from KB injection before the critic transport is even reached is contained the same way (not just a throw from the transport itself)", async () => {
    const real = new CampaignManager();
    startCampaign(real);
    const events: LoopEvent[] = [];
    const executor: LoopExecutor = {
      async specialize() {
        return { output: "real work happened", provenance: { tag: "claimed", claimant: "seed" }, token_usage: noUsage };
      },
      async review() {
        return { approved: true, rationale: "ok", token_usage: noUsage };
      },
      log: (e) => events.push(e),
    };
    // A thin wrapper around the real manager that throws only for the
    // critic-tier `kbInject` call — exercising a precondition failure
    // upstream of the critic transport call itself (one of B2's named
    // suspects), not the transport throwing.
    const throwingKbManager = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "kbInject") {
          return (prompt: string, campaignId: string, cap: CapabilityContext, nodeId?: string) => {
            if (cap.tier === "critic") throw new Error("KB injection precondition violated");
            return Reflect.get(target, prop, receiver).call(target, prompt, campaignId, cap, nodeId);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const report = await runCampaign({ manager: throwingKbManager, campaign_id: "camp1", executor, config: makeConfig({ max_iterations: 2 }) });

    expect(report.review_pending).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "review_pending" && e.reason === "internal_error")).toBe(true);
  });
});

describe("runCampaign — resume stranded reviews on re-entry (B3)", () => {
  it("dispatches the critic (not the specialist) for a node stranded awaiting_review with a durable candidate, and records the verdict", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const [childId] = mgr.getCampaignSnapshot("camp1")!.nodes.filter((n) => n.state === "pending").map((n) => n.id);
    mgr.expandNode("camp1", childId, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
    mgr.recordCandidate("camp1", childId, {
      specialist_output: "specialist already finished this before the process died",
      specialist_agent: "seed",
      provenance: { tag: "claimed", claimant: "seed" },
    });
    expect(mgr.getNodeInfo("camp1", childId)?.state as string).toBe("awaiting_review");

    const specialized: string[] = [];
    const reviewed: { node_id: string; specialist_output: string }[] = [];
    const executor: LoopExecutor = {
      async specialize({ node_id }) {
        specialized.push(node_id);
        return { output: "should never be reached", provenance: { tag: "claimed", claimant: "seed" }, token_usage: noUsage };
      },
      async review({ node_id, specialist_output }) {
        reviewed.push({ node_id, specialist_output });
        return { approved: true, rationale: "resumed review approves the stranded candidate", token_usage: noUsage };
      },
    };

    const report = await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({ max_iterations: 1 }) });

    // Critic-only: the specialist must never re-run for the stranded node —
    // the candidate already IS its output.
    expect(specialized).not.toContain(childId);
    expect(reviewed).toContainEqual({ node_id: childId, specialist_output: "specialist already finished this before the process died" });
    const info = mgr.getNodeInfo("camp1", childId);
    expect(info?.state as string).not.toBe("awaiting_review");
    expect(["verified", "claimed"]).toContain(info?.state as string);
    expect(report.verified + report.claimed).toBeGreaterThan(0);
  });

  it("a stranded review that fails leaves the node awaiting_review again instead of crashing the resume pass", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const [childId] = mgr.getCampaignSnapshot("camp1")!.nodes.filter((n) => n.state === "pending").map((n) => n.id);
    mgr.expandNode("camp1", childId, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
    mgr.recordCandidate("camp1", childId, {
      specialist_output: "stranded work", specialist_agent: "seed", provenance: { tag: "claimed", claimant: "seed" },
    });
    const executor: LoopExecutor = {
      async specialize() { throw new Error("must not be dispatched"); },
      async review() { throw new Error("critic transport still down"); },
    };
    // max_iterations: 0 — the resume pass runs unconditionally before the
    // per-node `for` loop even starts, so this exercises only
    // `resumeStrandedReviews` and cannot be confused with the main loop
    // separately (and validly) selecting the campaign's other pending node.
    const report = await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({ max_iterations: 0 }) });
    expect(report.review_pending).toBeGreaterThan(0);
    const info = mgr.getNodeInfo("camp1", childId);
    expect(info?.state as string).toBe("awaiting_review");
    expect((info as unknown as { candidate?: { specialist_output: string } }).candidate?.specialist_output).toBe("stranded work");
  });

  it("a stranded review aborted mid-dispatch reports cancellation instead of recording a fabricated internal_error verdict", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const [childId] = mgr.getCampaignSnapshot("camp1")!.nodes.filter((n) => n.state === "pending").map((n) => n.id);
    mgr.expandNode("camp1", childId, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
    mgr.recordCandidate("camp1", childId, {
      specialist_output: "stranded work", specialist_agent: "seed", provenance: { tag: "claimed", claimant: "seed" },
    });
    const controller = new AbortController();
    const executor: LoopExecutor = {
      async specialize() { throw new Error("must not be dispatched"); },
      async review({ signal }) {
        // Simulate the executor observing cancellation mid-dispatch, the same
        // way a real provider transport aborts an in-flight call.
        controller.abort(new Error("test cancellation"));
        throw signal?.reason instanceof Error ? signal.reason : new Error("aborted");
      },
    };
    const report = await runCampaign({
      manager: mgr, campaign_id: "camp1", executor,
      config: makeConfig({ max_iterations: 0 }),
      signal: controller.signal,
    });
    // The run must honestly report cancellation, not silently swallow it.
    expect(report.cancelled).toBe(true);
    // The node's stranded candidate must be left untouched by the aborted
    // attempt — no fabricated "internal_error" review verdict recorded
    // against real work that never actually got reviewed.
    const info = mgr.getNodeInfo("camp1", childId) as unknown as { state: string; outcome?: { kind: string } };
    expect(info.state).toBe("awaiting_review");
    expect(info.outcome).toBeUndefined();
  });
});

describe("runCampaign — gate-failure root cause carries detail (U3)", () => {
  it("an isolation-gate rejection's critic_root_cause includes the gate's detail, not just a fixed literal", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    // `expandNode` is stubbed to force the isolation-gate-rejection branch
    // deterministically — real gate-failure conditions (a lease that fails
    // to acquire) require a real/broken git worktree to reproduce, which
    // would make this test slow and environment-dependent for something
    // that's really about one literal string in loop.ts. Every other
    // `CampaignManagerPort` method used along this path is the real
    // `CampaignManager`.
    const recordedParams: { critic_root_cause?: string; critic_rationale: string }[] = [];
    const originalRecordResult = mgr.recordResult.bind(mgr);
    mgr.recordResult = ((campaignId, nodeId, params) => {
      recordedParams.push(params);
      return originalRecordResult(campaignId, nodeId, params);
    }) as typeof mgr.recordResult;
    const originalExpandNode = mgr.expandNode.bind(mgr);
    mgr.expandNode = ((_campaignId, _nodeId) => {
      void originalExpandNode; // isolation is bypassed deliberately for this fixture
      return {
        ok: false as const,
        gate: {
          gate: "isolation" as const,
          result: "fail" as const,
          checked_at: new Date().toISOString(),
          detail: "no active lease on worktree",
          failures: ["no active lease on worktree"],
          unresolved: [],
        },
      };
    }) as typeof mgr.expandNode;

    const executor = approvingExecutor();
    await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({ max_iterations: 1 }) });

    expect(recordedParams).toHaveLength(1);
    expect(recordedParams[0]!.critic_root_cause).toContain("no active lease on worktree");
    expect(recordedParams[0]!.critic_rationale).toBe("no active lease on worktree");
  });

  it("a classified operational error's critic_root_cause includes the observed message, not just the bare error kind", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const events: LoopEvent[] = [];
    const executor: LoopExecutor = {
      async specialize() {
        return {
          output: "",
          provenance: { tag: "claimed", claimant: "seed" },
          token_usage: noUsage,
          error: { kind: "transport_error", recoverable: true, provenance: { tag: "claimed", claimant: "seed" }, message: "connection reset by peer" },
        };
      },
      async review() { throw new Error("critic must not be dispatched on a classified specialist error"); },
      log: (e) => events.push(e),
    };
    await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({ max_iterations: 1 }) });
    const failedEvent = events.find((e): e is Extract<LoopEvent, { type: "node_failed" }> => e.type === "node_failed");
    expect(failedEvent?.root_cause).toContain("connection reset by peer");
  });
});

describe("runCampaign — candidate token usage survives an incomplete review (Q4)", () => {
  it("recordCandidate captures the specialist's measured token_usage before critic dispatch", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const usage = { input_tokens: 512, output_tokens: 64, cached_input_tokens: 0, cache_write_input_tokens: 0, counter_source: "provider_counter" as const };
    const events: LoopEvent[] = [];
    const executor: LoopExecutor = {
      async specialize() {
        return { output: "real work happened", provenance: { tag: "claimed", claimant: "seed" }, token_usage: usage };
      },
      async review() {
        return {
          approved: false,
          rationale: "unreachable",
          token_usage: noUsage,
          error: { kind: "transport_error", recoverable: true, provenance: { tag: "claimed", claimant: "opencode-server-executor" }, message: "HTTP 503" },
        };
      },
      log: (e) => events.push(e),
    };
    await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({ max_iterations: 1 }) });
    const reviewedNodeId = events.find((e): e is Extract<LoopEvent, { type: "review_pending" }> => e.type === "review_pending")!.node_id;
    const info = mgr.getNodeInfo("camp1", reviewedNodeId);
    const candidate = (info as unknown as { candidate?: { token_usage?: unknown } }).candidate;
    expect(candidate?.token_usage).toMatchObject({ input_tokens: 512, output_tokens: 64 });
  });
});

describe("runCampaign — dispatch preflight (tranche1 §13 items 4/5)", () => {
  it("short-circuits before any specialist dispatch when authority is missing, without dispatching the executor", async () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("preflight-block-camp", "plan.md", rootAction);
    mgr.branch("preflight-block-camp", "root", [{
      ...refactorAction,
      // Absolute path fails validNativeHighRiskDeclaration — a real authoring bug.
      high_risk_tool_scope: { write_paths: ["/etc/passwd"], command_argv: [] },
    }]);
    const executor = approvingExecutor();
    const events: LoopEvent[] = [];
    const [nodeId] = mgr.getCampaignSnapshot("preflight-block-camp")!.nodes.filter((n) => n.state === "pending").map((n) => n.id);
    await runCampaign({
      manager: mgr,
      campaign_id: "preflight-block-camp",
      executor: { ...executor, log: (e) => events.push(e) },
      config: makeConfig({ max_iterations: 1 }),
    });

    // The specialist/critic must never be dispatched — that's the entire
    // point of a *preflight*: the rejection fires before any model call,
    // using the same synthetic-rejection mechanism the isolation gate uses
    // (which likewise never increments `report.failed` on this path).
    expect(executor.specialized).toHaveLength(0);
    expect(executor.reviewed).toHaveLength(0);
    expect(events.some((e) => e.type === "specialist_dispatched")).toBe(false);
    expect(mgr.getNodeInfo("preflight-block-camp", nodeId)?.state).toBe("failed");
  });

  it("dispatches normally when authority is sufficient (no declared scope) and workspace is ready", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const executor = approvingExecutor();
    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      config: makeConfig({ execution_strategy: { kind: "first_verified" } }),
    });

    expect(executor.specialized).toHaveLength(1);
    expect(report).toMatchObject({ halted: true, halt_reason: "verified_result", verified: 1 });
  });
});

describe("verifyLiveNodeCards — Phase 4D.3 Defect 1: signature verification on the live path", () => {
  // Before this, `verifyNodeCard` had zero production callers (arbor-core's
  // `signNodeCard` ran on every card derivation, but nothing ever checked the
  // signature back) — a card whose signature didn't check out would be
  // trusted identically to a genuine one. `buildLiveNodeCards` in loop.ts now
  // calls this exact function on every card it derives before handing the
  // set to `manager.selectNodeWithCard`. These tests exercise that function
  // directly, the same one the production path calls.
  const secret = "loop-test-verification-secret";

  it("passes through a card whose signature verifies", () => {
    const card = deriveCandidateNodeCard(
      { id: "n1", action_description: "refactor auth module", action_category: "refactor", action_delegate: "seed" },
      secret,
    );
    expect(verifyLiveNodeCards([card], secret).map((c) => c.node_id)).toEqual(["n1"]);
  });

  it("drops a card with a tampered signature rather than trusting it", () => {
    const card = deriveCandidateNodeCard(
      { id: "n1", action_description: "refactor auth module", action_category: "refactor", action_delegate: "seed" },
      secret,
    );
    const tampered = { ...card, signature: "0".repeat(64) };
    expect(verifyLiveNodeCards([tampered], secret)).toEqual([]);
  });

  it("drops a card signed with a different secret than the one used to verify", () => {
    const card = deriveCandidateNodeCard(
      { id: "n1", action_description: "refactor auth module", action_category: "refactor", action_delegate: "seed" },
      "a-different-secret",
    );
    expect(verifyLiveNodeCards([card], secret)).toEqual([]);
  });

  it("filters a mixed set to only the cards that verify, preserving the rest", () => {
    const good = deriveCandidateNodeCard(
      { id: "n1", action_description: "refactor auth module", action_category: "refactor", action_delegate: "seed" },
      secret,
    );
    const bad = deriveCandidateNodeCard(
      { id: "n2", action_description: "add unit tests", action_category: "testing", action_delegate: "seed" },
      "wrong-secret",
    );
    expect(verifyLiveNodeCards([good, bad], secret).map((c) => c.node_id)).toEqual(["n1"]);
  });
});

describe("runCampaign — ADR-062 governance tiers", () => {
  it("direct tier (review: waived) never dispatches the critic and records review_waived provenance honestly", async () => {
    // A single-node campaign (matching the real `direct`-tier admission
    // shape: one root_action, no siblings), so a non-halting "claimed"
    // result cannot fall through to a second UCT selection.
    const mgr = new CampaignManager(); mgr.startCampaign("camp-waived", "plan.md", rootAction);
    mgr.branch("camp-waived", "root", [refactorAction]);
    const target = mgr.getCampaignSnapshot("camp-waived")!.nodes.find((node) => node.state === "pending")!.id;
    let reviewCalls = 0;
    const executor: LoopExecutor = {
      async specialize() {
        return { output: "narrow fix applied", provenance: { tag: "claimed", claimant: "seed" }, token_usage: noUsage };
      },
      async review() {
        reviewCalls += 1;
        throw new Error("critic must never be dispatched for a waived-review direct tier node");
      },
    };
    const report = await runCampaign({ manager: mgr, campaign_id: "camp-waived", executor, config: makeConfig({ execution_strategy: { kind: "direct_single_action", node_id: target, review: "waived" } }) });
    expect(reviewCalls).toBe(0);
    expect(report).toMatchObject({ halted: true, halt_reason: "no_nodes", claimed: 1, verified: 0 });
    const info = mgr.getNodeInfo("camp-waived", target);
    // Honest provenance: the specialist's own "claimed" tag survives — the
    // waiver never upgrades it to a fabricated "verified"/critic_approved.
    expect(info?.provenance?.tag).toBe("claimed");
    expect(info?.review_waived).toMatchObject({ by: "arbiter-direct" });
    const snapshot = mgr.getCampaignSnapshot("camp-waived")!;
    const node = snapshot.nodes.find((n) => n.id === target)!;
    expect(node.critic_verdict).toBeNull();
  });

  it("reviewed tier (review: critic, the default) still dispatches a real critic for a single-action campaign", async () => {
    const mgr = new CampaignManager(); startCampaign(mgr);
    const pending = mgr.getCampaignSnapshot("camp1")!.nodes.filter((node) => node.state === "pending");
    const target = pending[0]!.id;
    const executor = approvingExecutor();
    const report = await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({ execution_strategy: { kind: "direct_single_action", node_id: target, review: "critic" } }) });
    expect(executor.reviewed).toEqual([target]);
    expect(report.verified).toBe(1);
    expect(mgr.getNodeInfo("camp1", target)?.review_waived).toBeUndefined();
  });

  it("bounded critic-block retry: one automatic re-dispatch on rejection, then halts honestly without looping", async () => {
    // A single-node campaign (no sibling) so a revived retry can only ever
    // re-select the SAME node — isolates the retry-count assertion from UCT
    // sibling-selection noise.
    const mgr = new CampaignManager(); mgr.startCampaign("camp-retry", "plan.md", rootAction);
    mgr.branch("camp-retry", "root", [refactorAction]);
    const target = mgr.getCampaignSnapshot("camp-retry")!.nodes.find((n) => n.state === "pending")!.id;
    const executor = rejectingExecutor();
    let specializeCalls = 0;
    const countingExecutor: LoopExecutor = {
      async specialize(input) { specializeCalls += 1; return executor.specialize(input); },
      async review(input) { return executor.review(input); },
    };
    const report = await runCampaign({
      manager: mgr, campaign_id: "camp-retry", executor: countingExecutor,
      config: makeConfig({ critic_retry: { max_retries: 1 }, max_iterations: 5 }),
    });
    // Exactly one retry: the node is dispatched twice (original + one bounded
    // retry), never more, and the run halts honestly (no verified result).
    expect(specializeCalls).toBe(2);
    expect(report.verified).toBe(0);
    expect(mgr.getNodeInfo("camp-retry", target)?.critic_retry_count).toBe(1);
    expect(mgr.getNodeInfo("camp-retry", target)?.state).toBe("failed");
  });

  it("critic_retry omitted (default) preserves the unchanged legacy behavior: no retry, terminal failure on first rejection", async () => {
    const mgr = new CampaignManager(); mgr.startCampaign("camp-noretry", "plan.md", rootAction);
    mgr.branch("camp-noretry", "root", [refactorAction]);
    const target = mgr.getCampaignSnapshot("camp-noretry")!.nodes.find((n) => n.state === "pending")!.id;
    const executor = rejectingExecutor();
    let specializeCalls = 0;
    const countingExecutor: LoopExecutor = {
      async specialize(input) { specializeCalls += 1; return executor.specialize(input); },
      async review(input) { return executor.review(input); },
    };
    await runCampaign({ manager: mgr, campaign_id: "camp-noretry", executor: countingExecutor, config: makeConfig({ max_iterations: 5 }) });
    expect(specializeCalls).toBe(1);
    expect(mgr.getNodeInfo("camp-noretry", target)?.state).toBe("failed");
    expect(mgr.getNodeInfo("camp-noretry", target)?.critic_retry_count).toBe(0);
  });

  it("retries one machine-blocked scope violation with exact corrective feedback, then verifies", async () => {
    const mgr = new CampaignManager(); mgr.startCampaign("camp-scope-retry", "plan.md", rootAction);
    mgr.branch("camp-scope-retry", "root", [refactorAction]);
    const target = mgr.getCampaignSnapshot("camp-scope-retry")!.nodes.find((node) => node.state === "pending")!.id;
    const prompts: string[] = [];
    const events: LoopEvent[] = [];
    let attempt = 0;
    let capsule: import("@arbor/campaign-support").RetryContextCapsule | null = null;
    const executor: LoopExecutor = {
      async specialize(input) {
        prompts.push(input.prompt);
        attempt += 1;
        if (attempt === 1) return {
          output: "implementation works but touched an unauthorized test",
          provenance: { tag: "claimed", claimant: "seed" },
          deferred_verification: Promise.resolve({
            attempted: true as const, failed: true as const, code: "write_scope_violation",
            scope_observation: { declared: ["src/lib.rs"], observed_out_of_scope: ["tests/checkpoint.rs"], enforcement: "blocked" as const },
          }),
          token_usage: noUsage,
        };
        return { output: "in-scope implementation", provenance: { tag: "verified", cmd: "cargo test", exit: 0, stdout_hash: "sha256:ok" }, token_usage: noUsage };
      },
      async review() { return { approved: true, rationale: "implementation is correct", measurement_validated: true, token_usage: noUsage }; },
      log(event) { events.push(event); },
    };
    const retry_context = {
      load: () => capsule,
      save: (input: { capsule: import("@arbor/campaign-support").RetryContextCapsule }) => { capsule = input.capsule; },
    };
    const report = await runCampaign({ manager: mgr, campaign_id: "camp-scope-retry", executor, config: makeConfig({ max_iterations: 4, execution_strategy: { kind: "first_verified" }, scope_retry: { max_retries: 1 }, retry_context }) });
    expect(events).toContainEqual({ type: "scope_retry", node_id: target, attempt: 1, max_retries: 1, paths: ["tests/checkpoint.rs"] });
    expect(report).toMatchObject({ verified: 1, failed: 1 });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("CORRECTIVE RETRY");
    expect(prompts[1]).toContain("tests/checkpoint.rs");
    expect(mgr.getNodeInfo("camp-scope-retry", target)).toMatchObject({ state: "verified", scope_retry_count: 1, critic_retry_count: 0 });
    expect(events.some((event) => event.type === "critic_retry")).toBe(false);
  });
});

describe("runCampaign — pipelined verification (OPT-1)", () => {
  it("applies a deferred verification upgrade at recordResult, overlapping it with critic dispatch", async () => {
    const mgr = new CampaignManager(); startCampaign(mgr);
    let resolveVerify: (v: { provenance: { tag: "verified"; cmd: string; exit: number; stdout_hash: string } } | null) => void = () => {};
    let reviewStarted = false;
    let verifyPendingWhenReviewStarted = false;
    const executor: LoopExecutor = {
      async specialize() {
        return {
          output: "work done",
          provenance: { tag: "claimed", claimant: "seed" },
          deferred_verification: new Promise((resolve) => { resolveVerify = resolve; }),
          token_usage: noUsage,
        };
      },
      async review() {
        reviewStarted = true;
        // The deferred promise must still be unresolved while the critic
        // runs — that concurrency is the whole point of OPT-1.
        verifyPendingWhenReviewStarted = true;
        resolveVerify({ provenance: { tag: "verified", cmd: "node --test", exit: 0, stdout_hash: "sha256:ok" } });
        return { approved: true, rationale: "ok", critic_agent: "lenticel", measurement_validated: true, token_usage: noUsage };
      },
    };
    const report = await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({ max_iterations: 1 }) });
    expect(reviewStarted).toBe(true);
    expect(verifyPendingWhenReviewStarted).toBe(true);
    expect(report.verified).toBe(1);
  });

  it("a deferred verification resolving null leaves the result honestly claimed", async () => {
    const mgr = new CampaignManager(); startCampaign(mgr);
    const executor: LoopExecutor = {
      async specialize() {
        return {
          output: "work done",
          provenance: { tag: "claimed", claimant: "seed" },
          deferred_verification: Promise.resolve(null),
          token_usage: noUsage,
        };
      },
      async review() {
        return { approved: true, rationale: "ok", critic_agent: "lenticel", measurement_validated: false, token_usage: noUsage };
      },
    };
    const report = await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({ max_iterations: 1 }) });
    expect(report.verified).toBe(0);
    expect(report.claimed).toBeGreaterThan(0);
  });
});

describe("runCampaign — E-2 turn-budget estimate + expansion", () => {
  it("threads config.turn_budget_estimate into the specialist dispatch", async () => {
    const mgr = new CampaignManager(); startCampaign(mgr);
    const executor = approvingExecutor();
    const observed: (number | undefined)[] = [];
    const wrapped: LoopExecutor = {
      async specialize(input) { observed.push(input.turn_budget_estimate); return executor.specialize(input); },
      async review(input) { return executor.review(input); },
    };
    await runCampaign({ manager: mgr, campaign_id: "camp1", executor: wrapped, config: makeConfig({ execution_strategy: { kind: "first_verified" }, turn_budget_estimate: 16 }) });
    expect(observed).toEqual([16]);
  });

  it("expands the turn budget (doubled) on a critic-block retry caused by a FAILED machine verification", async () => {
    const mgr = new CampaignManager(); mgr.startCampaign("camp-expand", "plan.md", rootAction);
    mgr.branch("camp-expand", "root", [refactorAction]);
    const observed: (number | undefined)[] = [];
    const executor: LoopExecutor = {
      async specialize(input) {
        observed.push(input.turn_budget_estimate);
        return {
          output: "attempted work but broke tests",
          provenance: { tag: "claimed", claimant: "seed" },
          deferred_verification: Promise.resolve({ attempted: true as const, failed: true as const }),
          token_usage: noUsage,
        };
      },
      async review() { return { approved: false, rationale: "tests failed", root_cause: "missing mock", token_usage: noUsage }; },
    };
    await runCampaign({ manager: mgr, campaign_id: "camp-expand", executor, config: makeConfig({ critic_retry: { max_retries: 1 }, turn_budget_estimate: 10, max_iterations: 5 }) });
    // Original dispatch at the base estimate, retry dispatch doubled.
    expect(observed).toEqual([10, 20]);
  });

  it("caps the expansion at the turn-budget ceiling instead of doubling past it", async () => {
    const mgr = new CampaignManager(); mgr.startCampaign("camp-cap", "plan.md", rootAction);
    mgr.branch("camp-cap", "root", [refactorAction]);
    const observed: (number | undefined)[] = [];
    const executor: LoopExecutor = {
      async specialize(input) {
        observed.push(input.turn_budget_estimate);
        return {
          output: "attempted work but broke tests",
          provenance: { tag: "claimed", claimant: "seed" },
          deferred_verification: Promise.resolve({ attempted: true as const, failed: true as const }),
          token_usage: noUsage,
        };
      },
      async review() { return { approved: false, rationale: "tests failed", root_cause: "missing mock", token_usage: noUsage }; },
    };
    await runCampaign({ manager: mgr, campaign_id: "camp-cap", executor, config: makeConfig({ critic_retry: { max_retries: 1 }, turn_budget_estimate: 30, max_iterations: 5 }) });
    // 30 * 2 = 60, capped at the 32 ceiling.
    expect(observed).toEqual([30, 32]);
  });

  it("does NOT expand the turn budget on a critic-block retry that was NOT caused by a failed verification", async () => {
    const mgr = new CampaignManager(); mgr.startCampaign("camp-noexpand", "plan.md", rootAction);
    mgr.branch("camp-noexpand", "root", [refactorAction]);
    const observed: (number | undefined)[] = [];
    const executor: LoopExecutor = {
      async specialize(input) {
        observed.push(input.turn_budget_estimate);
        // No deferred_verification at all — nothing was attempted, never a failure.
        return { output: "attempted work but broke tests", provenance: { tag: "claimed", claimant: "seed" }, token_usage: noUsage };
      },
      async review() { return { approved: false, rationale: "tests failed", root_cause: "missing mock", token_usage: noUsage }; },
    };
    await runCampaign({ manager: mgr, campaign_id: "camp-noexpand", executor, config: makeConfig({ critic_retry: { max_retries: 1 }, turn_budget_estimate: 10, max_iterations: 5 }) });
    // Retried (critic_retry is configured), but the budget stays flat.
    expect(observed).toEqual([10, 10]);
  });

  it("emits a bounded diagnostic when trusted machine verification fails", async () => {
    const mgr = new CampaignManager(); startCampaign(mgr);
    const base = approvingExecutor();
    const events: LoopEvent[] = [];
    const executor: LoopExecutor = {
      async specialize(input) {
        const result = await base.specialize(input);
        return { ...result, provenance: { tag: "claimed", claimant: "seed" }, deferred_verification: Promise.resolve({ attempted: true as const, failed: true as const, code: "command_exit_nonzero", exit: 1, diagnostic: "error[E0599]: no method named read_u40" }) };
      },
      review: (input) => base.review(input),
      log: (event) => events.push(event),
    };
    await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({ execution_strategy: { kind: "first_verified" }, max_iterations: 1 }) });
    expect(events).toContainEqual({ type: "machine_verification_failed", node_id: expect.any(String), code: "command_exit_nonzero", exit: 1 });
    expect(events).toContainEqual({ type: "node_failed", node_id: expect.any(String), root_cause: expect.stringContaining("error[E0599]: no method named read_u40") });
    const node = mgr.getCampaignSnapshot("camp1")?.nodes.find((candidate) => candidate.parent_id === "root");
    expect(node).toMatchObject({ state: "failed" });
  });
});

describe("runCampaign — ADR-185 stage fractions reach the backed-up reward", () => {
  async function failOnePass(stages: { passed: number; total: number } | undefined) {
    const mgr = new CampaignManager(); startCampaign(mgr);
    const base = approvingExecutor();
    const executor: LoopExecutor = {
      async specialize(input) {
        const result = await base.specialize(input);
        return { ...result, provenance: { tag: "claimed", claimant: "seed" }, deferred_verification: Promise.resolve({ attempted: true as const, failed: true as const, code: "command_exit_nonzero", exit: 1, ...(stages === undefined ? {} : { stages }) }) };
      },
      review: (input) => base.review(input),
    };
    await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({ execution_strategy: { kind: "first_verified" }, max_iterations: 1 }) });
    const node = mgr.getCampaignSnapshot("camp1")!.nodes.find((candidate) => candidate.parent_id === "root")!;
    return mgr.getNodeInfo("camp1", node.id)!;
  }

  it("a 2-of-3 stage failure backs up 0.6 with measured generated-provenance evidence", async () => {
    const info = await failOnePass({ passed: 2, total: 3 });
    expect(info.state).toBe("failed");
    expect(info.value_estimate).toBeCloseTo(0.6, 10);
    expect(info.reward).toMatchObject({ source: "measured_partial", measured: true, provenance_tag: "generated" });
    expect(info.reward!.value).toBeCloseTo(0.6, 10);
    expect(info.reward!.components).toEqual([expect.objectContaining({ channel: "graded", source: "verification_stage_fraction", raw: 2 / 3, weight: 0.9 })]);
  });

  it("a failure with no stage report stays an unmeasured 0, never a low measured score", async () => {
    const info = await failOnePass(undefined);
    expect(info.value_estimate).toBe(0);
    expect(info.reward).toMatchObject({ value: 0, source: "unmeasured", measured: false, provenance_tag: null });
  });
});

/** A complete, valid five-mandate `CriticVerdict`, optionally carrying E-3 confidence. */
function criticVerdict(overrides: Partial<import("@arbor/core").CriticVerdict> = {}): import("@arbor/core").CriticVerdict {
  return {
    approved: false,
    critic: "lenticel",
    rationale: "tests failed",
    root_cause: "missing mock",
    measurement_validated: false,
    guardrails_enforced: true,
    introspection_passed: true,
    stability_ok: true,
    checks: [
      { name: "root_cause", passed: false, detail: "no attributable measurement" },
      { name: "measurement_validation", passed: false, detail: "tests failed" },
      { name: "guardrail_enforcement", passed: true, detail: "in scope" },
      { name: "introspection", passed: true, detail: "consistent" },
      { name: "stability_monitoring", passed: true, detail: "stable" },
    ],
    ...overrides,
  };
}

describe("runCampaign — E-3 critic confidence + tier-dependent block thresholds", () => {
  it("reviewed tier: a BLOCK with confidence < 0.5 routes to the bounded-retry seam, even with critic_retry unconfigured", async () => {
    const mgr = new CampaignManager(); mgr.startCampaign("camp-e3-retry", "plan.md", rootAction);
    mgr.branch("camp-e3-retry", "root", [refactorAction]);
    const target = mgr.getCampaignSnapshot("camp-e3-retry")!.nodes.find((n) => n.state === "pending")!.id;
    let specializeCalls = 0;
    const executor: LoopExecutor = {
      async specialize() { specializeCalls += 1; return { output: "attempted work but broke tests", provenance: { tag: "claimed", claimant: "seed" }, token_usage: noUsage }; },
      async review() { return { approved: false, rationale: "tests failed", root_cause: "missing mock", verdict: criticVerdict({ confidence: 0.2, confidence_source: "self_report" }), token_usage: noUsage }; },
    };
    await runCampaign({ manager: mgr, campaign_id: "camp-e3-retry", executor, config: makeConfig({ execution_strategy: { kind: "direct_single_action", node_id: target, review: "critic" }, max_iterations: 5 }) });
    expect(specializeCalls).toBe(2);
    expect(mgr.getNodeInfo("camp-e3-retry", target)?.critic_retry_count).toBe(1);
  });

  it("reviewed tier: a BLOCK with confidence >= 0.5 stays terminal (no retry)", async () => {
    const mgr = new CampaignManager(); mgr.startCampaign("camp-e3-hiconf", "plan.md", rootAction);
    mgr.branch("camp-e3-hiconf", "root", [refactorAction]);
    const target = mgr.getCampaignSnapshot("camp-e3-hiconf")!.nodes.find((n) => n.state === "pending")!.id;
    let specializeCalls = 0;
    const executor: LoopExecutor = {
      async specialize() { specializeCalls += 1; return { output: "attempted work but broke tests", provenance: { tag: "claimed", claimant: "seed" }, token_usage: noUsage }; },
      async review() { return { approved: false, rationale: "tests failed", root_cause: "missing mock", verdict: criticVerdict({ confidence: 0.8, confidence_source: "self_report" }), token_usage: noUsage }; },
    };
    await runCampaign({ manager: mgr, campaign_id: "camp-e3-hiconf", executor, config: makeConfig({ execution_strategy: { kind: "direct_single_action", node_id: target, review: "critic" }, max_iterations: 5 }) });
    expect(specializeCalls).toBe(1);
    expect(mgr.getNodeInfo("camp-e3-hiconf", target)?.state).toBe("failed");
  });

  it("reviewed tier: an ABSENT confidence stays terminal — exactly today's behavior, no retry from this seam", async () => {
    const mgr = new CampaignManager(); mgr.startCampaign("camp-e3-absent", "plan.md", rootAction);
    mgr.branch("camp-e3-absent", "root", [refactorAction]);
    const target = mgr.getCampaignSnapshot("camp-e3-absent")!.nodes.find((n) => n.state === "pending")!.id;
    let specializeCalls = 0;
    const executor: LoopExecutor = {
      async specialize() { specializeCalls += 1; return { output: "attempted work but broke tests", provenance: { tag: "claimed", claimant: "seed" }, token_usage: noUsage }; },
      // No `confidence` on the verdict at all — an older/malformed critic response.
      async review() { return { approved: false, rationale: "tests failed", root_cause: "missing mock", verdict: criticVerdict(), token_usage: noUsage }; },
    };
    await runCampaign({ manager: mgr, campaign_id: "camp-e3-absent", executor, config: makeConfig({ execution_strategy: { kind: "direct_single_action", node_id: target, review: "critic" }, max_iterations: 5 }) });
    expect(specializeCalls).toBe(1);
  });

  it("governed tier: a low-confidence BLOCK stays terminal — behavior is UNCHANGED from before E-3", async () => {
    const mgr = new CampaignManager(); mgr.startCampaign("camp-e3-governed", "plan.md", rootAction);
    mgr.branch("camp-e3-governed", "root", [refactorAction]);
    const target = mgr.getCampaignSnapshot("camp-e3-governed")!.nodes.find((n) => n.state === "pending")!.id;
    let specializeCalls = 0;
    const executor: LoopExecutor = {
      async specialize() { specializeCalls += 1; return { output: "attempted work but broke tests", provenance: { tag: "claimed", claimant: "seed" }, token_usage: noUsage }; },
      async review() { return { approved: false, rationale: "tests failed", root_cause: "missing mock", verdict: criticVerdict({ confidence: 0.1, confidence_source: "self_report" }), token_usage: noUsage }; },
    };
    // No execution_strategy at all -> the unchanged full governed path.
    await runCampaign({ manager: mgr, campaign_id: "camp-e3-governed", executor, config: makeConfig({ max_iterations: 5 }) });
    expect(specializeCalls).toBe(1);
    expect(mgr.getNodeInfo("camp-e3-governed", target)?.state).toBe("failed");
  });
});

describe("runCampaign — Y-1 (ADR-065) scope-observation journaling", () => {
  it("an audit-tier scope mismatch riding the deferred verification lands as a durable scope_observation record", async () => {
    const mgr = new CampaignManager(); startCampaign(mgr);
    const executor: LoopExecutor = {
      async specialize() {
        return {
          output: "work done", provenance: { tag: "claimed", claimant: "seed" },
          deferred_verification: Promise.resolve({
            provenance: { tag: "verified" as const, cmd: "npm test", exit: 0, stdout_hash: "sha256:x", strength: "command_executed" as const },
            scope_observation: { declared: ["test/decorator.test.js"], observed_out_of_scope: ["package.json"], enforcement: "audit" as const },
          }),
          token_usage: noUsage,
        };
      },
      async review() { return { approved: true, rationale: "ok", critic_agent: "lenticel", measurement_validated: true, token_usage: noUsage }; },
    };
    await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({ max_iterations: 1 }) });
    const observations = mgr.getScopeObservations("camp1");
    expect(observations).toHaveLength(1);
    expect(observations[0]?.observation).toMatchObject({ declared: ["test/decorator.test.js"], observed_out_of_scope: ["package.json"], enforcement: "audit" });
  });

  it("WA-67 (label half): a verified node with an audit-mode scope violation halts terminal_outcome partial, not completed, and carries the violation in a durable diagnostic", async () => {
    const mgr = new CampaignManager(); startCampaign(mgr);
    const executor: LoopExecutor = {
      async specialize() {
        return {
          output: "work done", provenance: { tag: "claimed", claimant: "seed" },
          deferred_verification: Promise.resolve({
            provenance: { tag: "verified" as const, cmd: "npm test", exit: 0, stdout_hash: "sha256:x", strength: "command_executed" as const },
            scope_observation: { declared: ["test/decorator.test.js"], observed_out_of_scope: ["lib/decorate.js"], enforcement: "audit" as const },
          }),
          token_usage: noUsage,
        };
      },
      async review() { return { approved: true, rationale: "ok", critic_agent: "lenticel", measurement_validated: true, token_usage: noUsage }; },
    };
    const report = await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({ max_iterations: 1 }) });
    expect(report.verified).toBe(1);
    const listed = mgr.listCampaigns().find((campaign) => campaign.id === "camp1");
    // Before this fix: "completed" — the exact false-completion shape
    // WA-67 names, indistinguishable from a genuinely clean verified halt.
    expect(listed?.terminal_outcome).toBe("partial");
    const diagnostic = mgr.getCampaignRunDiagnostic("camp1");
    expect(diagnostic?.message).toContain("lib/decorate.js");
    expect(diagnostic?.message).toContain("audit");
  });

  it("no observation, no record — the journaling never fabricates one", async () => {
    const mgr = new CampaignManager(); startCampaign(mgr);
    const executor: LoopExecutor = {
      async specialize() {
        return {
          output: "work done", provenance: { tag: "claimed", claimant: "seed" },
          deferred_verification: Promise.resolve({ provenance: { tag: "verified" as const, cmd: "npm test", exit: 0, stdout_hash: "sha256:x", strength: "command_executed" as const } }),
          token_usage: noUsage,
        };
      },
      async review() { return { approved: true, rationale: "ok", critic_agent: "lenticel", measurement_validated: true, token_usage: noUsage }; },
    };
    await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({ max_iterations: 1 }) });
    expect(mgr.getScopeObservations("camp1")).toHaveLength(0);
  });
});

describe("runCampaign — E-7c (ADR-063) verification_source is echoed from the deferred upgrade into recordResult", () => {
  it("a verification_source matching this call's own campaign/node target verifies normally", async () => {
    const mgr = new CampaignManager(); startCampaign(mgr);
    const target = mgr.getCampaignSnapshot("camp1")!.nodes.find((n) => n.state === "pending")!.id;
    const executor: LoopExecutor = {
      async specialize(params) {
        return {
          output: "work done", provenance: { tag: "claimed", claimant: "seed" },
          deferred_verification: Promise.resolve({
            provenance: { tag: "verified" as const, cmd: "npm test", exit: 0, stdout_hash: "sha256:x", strength: "command_executed" as const },
            verification_source: { campaign_id: params.campaign_id, node_id: params.node_id },
          }),
          token_usage: noUsage,
        };
      },
      async review() { return { approved: true, rationale: "ok", critic_agent: "lenticel", measurement_validated: true, token_usage: noUsage }; },
    };
    await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({ execution_strategy: { kind: "direct_single_action", node_id: target, review: "critic" }, max_iterations: 1 }) });
    expect(mgr.getNodeInfo("camp1", target)?.state).toBe("verified");
  });

  it("a verification_source naming a DIFFERENT node is rejected as an evidence replay, never silently accepted", async () => {
    const mgr = new CampaignManager(); startCampaign(mgr);
    const target = mgr.getCampaignSnapshot("camp1")!.nodes.find((n) => n.state === "pending")!.id;
    const executor: LoopExecutor = {
      async specialize(params) {
        return {
          output: "work done", provenance: { tag: "claimed", claimant: "seed" },
          deferred_verification: Promise.resolve({
            provenance: { tag: "verified" as const, cmd: "npm test", exit: 0, stdout_hash: "sha256:x", strength: "command_executed" as const },
            // Deliberately wrong: this verification claims to originate from
            // a different node than the one this call is actually recording
            // a result for.
            verification_source: { campaign_id: params.campaign_id, node_id: `${params.node_id}-other` },
          }),
          token_usage: noUsage,
        };
      },
      async review() { return { approved: true, rationale: "ok", critic_agent: "lenticel", measurement_validated: true, token_usage: noUsage }; },
    };
    await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({ execution_strategy: { kind: "direct_single_action", node_id: target, review: "critic" }, max_iterations: 1 }) });
    const node = mgr.getNodeInfo("camp1", target);
    expect(node?.state).toBe("failed");
    // recordFailure (manager.ts) writes the computed root cause as
    // `FAILED: <rootCause>` onto the node's own `specialist_output` --
    // the manager's evidence-replay rejection, not the critic's ("ok")
    // rationale, is what actually terminated this node.
    expect(node?.specialist_output).toContain("evidence replay");
  });
});

describe("runCampaign — ADR-068 durable advisory evidence, real worktree end-to-end", () => {
  const SIB_BUG_LINE = '  if (value === "PLANTED_BUG_MARKER_TEXT") { return true; }';
  const SIB_FIXED_LINE = '  if (value === "CORRECTED_MARKER_TEXT") { return true; }';

  it("a real sibling-site scan finding computed from the actual worktree diff lands as a durable advisory_evidence record", async () => {
    // This is the loop-side wiring ADR-068 named as its own disclosed
    // follow-up ("the deferred loop-side wiring for advisory evidence...
    // means no advisory_evidence record exists in any real campaign yet").
    // Unlike the scope-observation/E-7c tests above, this does not hand
    // the loop a pre-fabricated finding: it runs the REAL, non-dryRun
    // `WorktreeManager` against a throwaway git repo, has the specialist
    // fix a bug in only ONE of two identical sibling sites inside its real
    // worktree, and lets `computeSiblingSiteNote` (sibling-scan.ts) discover
    // the untouched sibling from the worktree's actual git diff — proving
    // the finding survives specialize() -> advisoryEvidence.push() ->
    // recordResult({ advisory_evidence }) -> journalResult -> the ledger.
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const fs = require("node:fs") as typeof import("node:fs");
    const repo = mkdtempSync(join(tmpdir(), "arbor-advisory-e2e-"));
    try {
      spawnSync("git", ["init", "-q", repo], { stdio: "ignore" });
      spawnSync("git", ["-C", repo, "config", "user.email", "t@t"], { stdio: "ignore" });
      spawnSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "ignore" });
      writeFileSync(join(repo, "a.js"), `function checkA(value) {\n${SIB_BUG_LINE}\n  return false;\n}\n`);
      writeFileSync(join(repo, "b.js"), `function checkB(value) {\n${SIB_BUG_LINE}\n  return false;\n}\n`);
      spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
      spawnSync("git", ["-C", repo, "commit", "-qm", "init"], { stdio: "ignore" });

      const mgr = new CampaignManager();
      startCampaign(mgr);
      const target = mgr.getCampaignSnapshot("camp1")!.nodes.find((n) => n.state === "pending")!.id;
      const executor: LoopExecutor = {
        async specialize(params) {
          // Fix the bug in a.js only — b.js is left with the identical
          // planted bug, which is exactly the sibling-site scan's target.
          const filePath = join(params.worktree_path, "a.js");
          const content = fs.readFileSync(filePath, "utf-8");
          fs.writeFileSync(filePath, content.replace(SIB_BUG_LINE, SIB_FIXED_LINE));
          return { output: "fixed the bug in a.js", provenance: { tag: "claimed", claimant: "seed" }, token_usage: noUsage };
        },
        async review() { return { approved: true, rationale: "ok", critic_agent: "lenticel", measurement_validated: true, token_usage: noUsage }; },
      };
      const worktrees = new WorktreeManager({ repoRoot: repo }); // real, NOT dryRun

      await runCampaign({
        manager: mgr,
        campaign_id: "camp1",
        executor,
        config: makeConfig({ execution_strategy: { kind: "direct_single_action", node_id: target, review: "critic" }, use_worktrees: true, max_iterations: 1 }),
        worktrees,
      });

      const advisory = mgr.getAdvisoryEvidence("camp1");
      const siblingFinding = advisory.find((record) => record.evidence.generator === "sibling_scan");
      expect(siblingFinding).toBeDefined();
      expect(siblingFinding?.evidence.activity).toBe("sibling-site completeness scan");
      expect(siblingFinding?.evidence.payload).toContain("b.js");
    } finally {
      spawnSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("runCampaign — E-4 verification-strength-aware critic note", () => {
  it("presents synchronous connector verification to the critic without requiring a deferred promise", async () => {
    const mgr = new CampaignManager(); startCampaign(mgr);
    let criticPrompt = "";
    const executor: LoopExecutor = {
      async specialize() {
        return {
          output: "work done",
          provenance: { tag: "verified", cmd: "cargo test --quiet", exit: 0, stdout_hash: "sha256:x", strength: "command_executed" },
          verification_evidence: "machine verification passed: cargo test --quiet",
          token_usage: noUsage,
        };
      },
      async review(input) {
        criticPrompt = input.prompt;
        return { approved: true, rationale: "ok", critic_agent: "lenticel", measurement_validated: true, token_usage: noUsage };
      },
    };
    await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({ max_iterations: 1 }) });
    expect(criticPrompt).toContain("machine verification has ALREADY RUN for this result and passed");
    expect(criticPrompt).toContain("cargo test --quiet");
  });

  it("a command_executed verification keeps the existing 'verification passed' note wording", async () => {
    const mgr = new CampaignManager(); startCampaign(mgr);
    let criticPrompt = "";
    const executor: LoopExecutor = {
      async specialize() {
        return {
          output: "work done", provenance: { tag: "claimed", claimant: "seed" },
          deferred_verification: Promise.resolve({ provenance: { tag: "verified" as const, cmd: "npx vitest run", exit: 0, stdout_hash: "sha256:x", strength: "command_executed" as const } }),
          token_usage: noUsage,
        };
      },
      async review(input) {
        criticPrompt = input.prompt;
        return { approved: true, rationale: "ok", critic_agent: "lenticel", measurement_validated: true, token_usage: noUsage };
      },
    };
    await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({ max_iterations: 1 }) });
    expect(criticPrompt).toContain("machine verification has ALREADY RUN for this result and passed");
    expect(criticPrompt).not.toContain("acceptance command was NOT run");
  });

  it("an outputs_check verification is NOT presented as 'verification passed' — it says the acceptance command did not run", async () => {
    const mgr = new CampaignManager(); startCampaign(mgr);
    let criticPrompt = "";
    const executor: LoopExecutor = {
      async specialize() {
        return {
          output: "work done", provenance: { tag: "claimed", claimant: "seed" },
          deferred_verification: Promise.resolve({ provenance: { tag: "verified" as const, cmd: "declared-outputs-check", exit: 0, stdout_hash: "sha256:x", strength: "outputs_check" as const } }),
          token_usage: noUsage,
        };
      },
      async review(input) {
        criticPrompt = input.prompt;
        return { approved: true, rationale: "ok", critic_agent: "lenticel", measurement_validated: true, token_usage: noUsage };
      },
    };
    const report = await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({ max_iterations: 1 }) });
    expect(criticPrompt).not.toContain("verification passed");
    expect(criticPrompt).toContain("declared outputs are present");
    expect(criticPrompt).toContain("acceptance command was NOT run");
    expect(criticPrompt).toContain("specialist did not provide the required VALIDATION EVIDENCE section");
    expect(report).toMatchObject({ verified: 0, claimed: 1 });
    expect(mgr.getNodeInfo("camp1", report.path[0]!.node_id)?.state).toBe("claimed");
  });
});

describe("acceptance-aware specialist completion protocol", () => {
  it("derives a generic evidence report from the assigned action and constraints", () => {
    const prompt = composeSpecialistPrompt({
      base_prompt: "base", foreground: "", action: {
        description: "deliver the assigned workflow", category: "general",
        constraints: ["keyboard operation remains available"], acceptance_checks: ["the required presentation outcome is observable"],
      },
      governed_checkpoint: null, checkpoint_at: "2026-08-22T00:00:00.000Z", communications: [], inject_memory: (value) => value,
    });

    expect(prompt).toContain("Completion evidence protocol (required before handoff to review):");
    expect(prompt).toContain("Action outcome: deliver the assigned workflow");
    expect(prompt).toContain("keyboard operation remains available");
    expect(prompt).toContain("Acceptance check: the required presentation outcome is observable");
    expect(prompt).toContain("behavioral, accessibility, visual/presentation, or other task-specific checks when they apply");
    expect(prompt).toContain("VALIDATION EVIDENCE:");
    expect(prompt).toContain("State `not run` with the reason");
    expect(prompt).toContain("never sufficient to call the action complete, working, or verified");
  });

  it("tells the independent critic that a supplied report is only candidate evidence", async () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("camp1", "plan.md", rootAction);
    mgr.branch("camp1", "root", [{ ...refactorAction, acceptance_checks: ["the bounded workflow remains usable"] }]);
    let criticPrompt = "";
    const executor: LoopExecutor = {
      async specialize() {
        return {
          output: "implemented\n\nVALIDATION EVIDENCE:\n- criterion: intended behavior\n  method: executed bounded check\n  observed result: pass",
          provenance: { tag: "claimed", claimant: "seed" }, token_usage: noUsage,
        };
      },
      async review(input) {
        criticPrompt = input.prompt;
        return { approved: false, rationale: "reviewed independently", token_usage: noUsage };
      },
    };
    await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({ max_iterations: 1 }) });
    expect(criticPrompt).toContain("the specialist supplied a self-reported VALIDATION EVIDENCE section");
    expect(criticPrompt).toContain("do not treat it as verification");
    expect(criticPrompt).toContain("the bounded workflow remains usable");
  });
});

describe("runCampaign — X-1 sibling-site completeness scan", () => {
  const BUG_LINE = '  if (value === "PLANTED_BUG_MARKER_TEXT") { return true; }';
  const FIXED_LINE = '  if (value === "CORRECTED_MARKER_TEXT") { return true; }';

  function initRepo(): string {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const repo = mkdtempSync(join(tmpdir(), "arbor-loop-sibling-"));
    spawnSync("git", ["init", "-q", repo], { stdio: "ignore" });
    spawnSync("git", ["-C", repo, "config", "user.email", "t@t"], { stdio: "ignore" });
    spawnSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "ignore" });
    writeFileSync(join(repo, "a.js"), `function checkA(value) {\n${BUG_LINE}\n  return false;\n}\n`);
    writeFileSync(join(repo, "b.js"), `function checkB(value) {\n${BUG_LINE}\n  return false;\n}\n`);
    spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
    spawnSync("git", ["-C", repo, "commit", "-qm", "init: two planted sites"], { stdio: "ignore" });
    return repo;
  }

  it("appends a critic note pointing at the unfixed sibling when only one of two identical sites was fixed", async () => {
    const repo = initRepo();
    try {
      const mgr = new CampaignManager(); startCampaign(mgr);
      const worktrees = new WorktreeManager({ repoRoot: repo });
      let criticPrompt = "";
      const executor: LoopExecutor = {
        async specialize({ worktree_path }) {
          const content = require("node:fs").readFileSync(join(worktree_path, "a.js"), "utf-8") as string;
          writeFileSync(join(worktree_path, "a.js"), content.replace(BUG_LINE, FIXED_LINE));
          return { output: "fixed the bug in a.js", provenance: { tag: "claimed", claimant: "seed" }, token_usage: noUsage };
        },
        async review(input) {
          criticPrompt = input.prompt;
          return { approved: true, rationale: "ok", critic_agent: "lenticel", measurement_validated: true, token_usage: noUsage };
        },
      };
      await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({ use_worktrees: true, max_iterations: 1 }), worktrees });
      expect(criticPrompt).toContain("Sibling-site scan");
      expect(criticPrompt).toContain("1 occurrence(s) of a pattern this change modified remain unchanged");
      expect(criticPrompt).toContain("b.js:2");
      expect(criticPrompt).toContain("verify the fix is complete across all sites or explain why the remaining sites are out of scope");
    } finally {
      const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
      spawnSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("adds no note when both identical sites were fixed", async () => {
    const repo = initRepo();
    try {
      const mgr = new CampaignManager(); startCampaign(mgr);
      const worktrees = new WorktreeManager({ repoRoot: repo });
      let criticPrompt = "";
      const executor: LoopExecutor = {
        async specialize({ worktree_path }) {
          const fs = require("node:fs") as typeof import("node:fs");
          for (const file of ["a.js", "b.js"]) {
            const content = fs.readFileSync(join(worktree_path, file), "utf-8") as string;
            fs.writeFileSync(join(worktree_path, file), content.replace(BUG_LINE, FIXED_LINE));
          }
          return { output: "fixed the bug in both files", provenance: { tag: "claimed", claimant: "seed" }, token_usage: noUsage };
        },
        async review(input) {
          criticPrompt = input.prompt;
          return { approved: true, rationale: "ok", critic_agent: "lenticel", measurement_validated: true, token_usage: noUsage };
        },
      };
      await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({ use_worktrees: true, max_iterations: 1 }), worktrees });
      expect(criticPrompt).not.toContain("Sibling-site scan");
    } finally {
      const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
      spawnSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("degrades silently (no note) when the worktree is not a real git repo", async () => {
    const mgr = new CampaignManager(); startCampaign(mgr);
    let criticPrompt = "";
    const executor: LoopExecutor = {
      async specialize() {
        return { output: "work complete", provenance: { tag: "claimed", claimant: "seed" }, token_usage: noUsage };
      },
      async review(input) {
        criticPrompt = input.prompt;
        return { approved: true, rationale: "ok", critic_agent: "lenticel", measurement_validated: true, token_usage: noUsage };
      },
    };
    // use_worktrees: false -> the loop's synthetic ".tmp" worktree path, which is not a git repo.
    await runCampaign({ manager: mgr, campaign_id: "camp1", executor, config: makeConfig({ max_iterations: 1 }) });
    expect(criticPrompt).not.toContain("Sibling-site scan");
  });
});
