import { describe, it, expect, afterEach, vi } from "vitest";
import { CampaignManager } from "@arbor/mcp";
import { runCampaign, DEFAULT_LOOP_CONFIG, type LoopExecutor, type CampaignLoopConfig, type LoopTelemetryPort } from "../src/loop.js";
import { WorktreeManager } from "@arbor/campaign-support";
import type { Action, ScoreContext, CapabilityContext, ArbiterDecision } from "@arbor/core";
import { RACE_SPECIALISTS_ENV, RACE_FORK_MS_ENV, MIN_RACE_FORK_MS } from "../src/race.js";

const rootAction: Action = { description: "execute plan", estimated_gain: 100, estimated_cost: 1, category: "root", delegate_to: "crown" };
const refactorAction: Action = { description: "refactor auth module", estimated_gain: 50, estimated_cost: 10, category: "refactor", delegate_to: "seed" };
const ctx: ScoreContext = { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 100, total_visits: 5 };
const specialistCap: CapabilityContext = { tier: "specialist" };
const criticCap: CapabilityContext = { tier: "critic" };
const noUsage = { kind: "unavailable" as const, reason: "test fixture" };
const usage = { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0, cache_write_input_tokens: 0, counter_source: "provider_counter" as const };

function directTier(): ArbiterDecision {
  return { tier: "direct", rationale: "cheap read-only fix", blast_radius: { reversibility: "reversible" }, source: "arbiter", decided_at: new Date().toISOString() };
}
function governedTier(): ArbiterDecision {
  return { tier: "governed", rationale: "high blast radius", blast_radius: { reversibility: "irreversible" }, source: "arbiter", decided_at: new Date().toISOString() };
}

function makeConfig(overrides: Partial<CampaignLoopConfig> = {}): CampaignLoopConfig {
  return {
    max_iterations: overrides.max_iterations ?? 5,
    specialist_base_prompt: DEFAULT_LOOP_CONFIG.specialist_base_prompt,
    critic_base_prompt: DEFAULT_LOOP_CONFIG.critic_base_prompt,
    specialist_cap: specialistCap,
    critic_cap: criticCap,
    score_ctx: () => ctx,
    use_worktrees: overrides.use_worktrees ?? true,
    branch_actions: overrides.branch_actions ?? (() => null),
    telemetry: overrides.telemetry,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runCampaign — X-1 specialist racing gate", () => {
  it("never races when ARBOR_RACE_SPECIALISTS is unset, even on a direct-tier campaign with a slow-verifying executor", async () => {
    vi.unstubAllEnvs();
    const mgr = new CampaignManager();
    mgr.admitCampaignPlan({ id: "gate-off", plan_path: "plan.md", root_action: rootAction, actions: [refactorAction], governance: directTier() });
    const worktrees = new WorktreeManager({}, true);
    let specializeCalls = 0;
    const executor: LoopExecutor = {
      async specialize() {
        specializeCalls += 1;
        return { output: "done", provenance: { tag: "claimed", claimant: "seed" }, token_usage: usage, deferred_verification: delay(50).then(() => ({ attempted: true as const, failed: true as const })) };
      },
      async review() { return { approved: true, rationale: "ok", measurement_validated: true, token_usage: noUsage }; },
    };
    await runCampaign({ manager: mgr, campaign_id: "gate-off", executor, worktrees, config: makeConfig() });
    expect(specializeCalls).toBe(1);
  });

  it("never races on a governed-tier campaign, even with the env flag set", async () => {
    vi.stubEnv(RACE_SPECIALISTS_ENV, "2");
    const mgr = new CampaignManager();
    mgr.admitCampaignPlan({ id: "gate-governed", plan_path: "plan.md", root_action: rootAction, actions: [refactorAction], governance: governedTier() });
    const worktrees = new WorktreeManager({}, true);
    let specializeCalls = 0;
    const executor: LoopExecutor = {
      async specialize() {
        specializeCalls += 1;
        return { output: "done", provenance: { tag: "claimed", claimant: "seed" }, token_usage: usage, deferred_verification: delay(50).then(() => ({ attempted: true as const, failed: true as const })) };
      },
      async review() { return { approved: true, rationale: "ok", measurement_validated: true, token_usage: noUsage }; },
    };
    await runCampaign({ manager: mgr, campaign_id: "gate-governed", executor, worktrees, config: makeConfig() });
    expect(specializeCalls).toBe(1);
  });

  it("never races when use_worktrees is false, even with the env flag set and a direct tier", async () => {
    vi.stubEnv(RACE_SPECIALISTS_ENV, "2");
    const mgr = new CampaignManager();
    mgr.admitCampaignPlan({ id: "gate-no-worktrees", plan_path: "plan.md", root_action: rootAction, actions: [refactorAction], governance: directTier() });
    let specializeCalls = 0;
    const executor: LoopExecutor = {
      async specialize() {
        specializeCalls += 1;
        return { output: "done", provenance: { tag: "claimed", claimant: "seed" }, token_usage: usage, deferred_verification: delay(50).then(() => ({ attempted: true as const, failed: true as const })) };
      },
      async review() { return { approved: true, rationale: "ok", measurement_validated: true, token_usage: noUsage }; },
    };
    await runCampaign({ manager: mgr, campaign_id: "gate-no-worktrees", executor, config: makeConfig({ use_worktrees: false }) });
    expect(specializeCalls).toBe(1);
  });

  it("forks and records the fork's verified result end-to-end, journaling both attempts' usage and a race observation", async () => {
    vi.stubEnv(RACE_SPECIALISTS_ENV, "2");
    vi.stubEnv(RACE_FORK_MS_ENV, String(MIN_RACE_FORK_MS));
    const mgr = new CampaignManager();
    mgr.admitCampaignPlan({ id: "race-fork-e2e", plan_path: "plan.md", root_action: rootAction, actions: [refactorAction], governance: directTier() });
    const target = mgr.getCampaignSnapshot("race-fork-e2e")!.nodes.find((n) => n.state === "pending")!.id;
    const worktrees = new WorktreeManager({}, true);

    let call = 0;
    const executor: LoopExecutor = {
      async specialize(params) {
        call += 1;
        if (call === 1) {
          // Attempt 1 never verifies within the (minimum, 5s) fork window.
          // Its verification honors the abort signal exactly like the real
          // connector does (verificationSignal = params.signal) — it never
          // settles on its own, only once cancelled.
          const verification = new Promise<{ attempted: true; failed: true }>((resolve) => {
            params.signal?.addEventListener("abort", () => resolve({ attempted: true, failed: true }), { once: true });
          });
          return { output: "attempt-1", provenance: { tag: "claimed", claimant: "seed" }, token_usage: usage, deferred_verification: verification };
        }
        // The fork verifies almost immediately.
        return { output: "attempt-2", provenance: { tag: "claimed", claimant: "seed" }, token_usage: usage, deferred_verification: Promise.resolve({ provenance: { tag: "verified" as const, cmd: "npx vitest run", exit: 0, stdout_hash: "sha256:fork" } }) };
      },
      async review({ specialist_output }) {
        return { approved: true, rationale: `approved: ${specialist_output}`, measurement_validated: true, token_usage: noUsage };
      },
    };

    const raceObservations: unknown[] = [];
    const usageCostRows: unknown[] = [];
    const telemetry: LoopTelemetryPort = {
      recordPhaseTiming() {},
      recordUsageCost(input) { usageCostRows.push(input); },
      recordRaceOutcome(input) { raceObservations.push(input); },
    };

    const report = await runCampaign({
      manager: mgr, campaign_id: "race-fork-e2e", executor, worktrees,
      config: makeConfig({ execution_strategy: { kind: "direct_single_action", node_id: target, review: "critic" }, telemetry }),
    });

    expect(report.verified).toBe(1);
    const node = mgr.getNodeInfo("race-fork-e2e", target);
    expect(node?.state).toBe("verified");
    // The winning provenance is the fork's independent machine verification,
    // never the primary's un-upgraded `claimed` tag.
    expect(mgr.getCampaignSnapshot("race-fork-e2e")!.nodes.find((n) => n.id === target)?.provenance?.tag).toBe("verified");

    expect(raceObservations).toHaveLength(1);
    expect(raceObservations[0]).toMatchObject({ winner: "fork", cancelled: true });

    // Both attempts' real spend reached the ledger — the winner's row
    // (emitted by the pre-existing specialist usage path) plus the loser's
    // row (emitted by the new race-loser path), both with real, non-zero
    // token counts (attempt 1's specialize() call had already returned
    // before the fork, so its usage was never actually unavailable).
    const specialistRows = usageCostRows.filter((row) => (row as { operation_id: string }).operation_id.includes(":specialist"));
    expect(specialistRows.length).toBeGreaterThanOrEqual(2);
    const loserRow = specialistRows.find((row) => (row as { operation_id: string }).operation_id.endsWith(":race-loser"));
    expect(loserRow).toMatchObject({ outcome: "cancelled", input_tokens: usage.input_tokens });

    // The fork's synthetic lease was released after the race concluded.
    expect(worktrees.isHeld(`${target}--race-fork`)).toBe(false);
  }, 15_000);
});
