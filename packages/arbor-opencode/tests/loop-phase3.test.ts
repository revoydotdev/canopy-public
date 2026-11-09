import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { CampaignManager } from "@arbor/mcp";
import {
  runCampaign,
  DEFAULT_LOOP_CONFIG,
  type CampaignLoopConfig,
  type CampaignRetryContextPort,
  type LoopEvent,
  type LoopExecutor,
} from "../src/loop.js";
import { buildRetryContextCapsule, type RetryContextCapsule } from "@arbor/campaign-support";
import type { Action, ScoreContext, CapabilityContext } from "@arbor/core";

const rootAction: Action = {
  description: "execute plan",
  estimated_gain: 100,
  estimated_cost: 1,
  category: "root",
  delegate_to: "crown",
};
const makeAction = (i: number): Action => ({
  description: `branch ${i}`,
  estimated_gain: 50,
  estimated_cost: 10,
  category: "refactor",
  delegate_to: "seed",
});
const ctx: ScoreContext = { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 100, total_visits: 5 };
const specialistCap: CapabilityContext = { tier: "specialist" };
const criticCap: CapabilityContext = { tier: "critic" };

function makeConfig(overrides: Partial<CampaignLoopConfig> = {}): CampaignLoopConfig {
  return {
    max_iterations: overrides.max_iterations ?? 50,
    specialist_base_prompt: DEFAULT_LOOP_CONFIG.specialist_base_prompt,
    critic_base_prompt: DEFAULT_LOOP_CONFIG.critic_base_prompt,
    specialist_cap: specialistCap,
    critic_cap: criticCap,
    score_ctx: () => ctx,
    use_worktrees: false,
    branch_actions: overrides.branch_actions ?? (() => null),
  };
}

describe("Phase 3.3 — convergence halt in production", () => {
  it("halts on 'converged' when iterations produce no new KB entries", async () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("camp1", "plan.md", rootAction, {
      max_seconds: 600,
      min_score: 0, // failures must not trip below_threshold before convergence
      convergence_iterations: 2,
    });
    // Branch a linear chain of 6 alternatives from the root.
    mgr.branch("camp1", "root", [1, 2, 3, 4, 5, 6].map(makeAction));
    const specialized: string[] = [];

    const executor: LoopExecutor = {
      async specialize({ node_id }) {
        specialized.push(node_id);
        return { output: `attempt ${node_id}`, provenance: { tag: "claimed", claimant: "seed" }, token_usage: { kind: "unavailable", reason: "test fixture" } };
      },
      async review() {
        // Every node fails with the SAME rationale — so the second identical
        // failure writes no new KB entry, and the counter climbs to converge.
        return { approved: false, rationale: "same known failure", root_cause: "same root cause", token_usage: { kind: "unavailable", reason: "test fixture" } };
      },
      log() {},
    };

    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      config: makeConfig(),
    });

    // The first failure writes one KB entry; identical repeats add none.
    // After convergence_iterations (2) no-new-info iterations, halt = converged.
    expect(mgr.haltStatus("camp1").reason).toBe("converged");
    expect(report.halted).toBe(true);
    expect(report.halt_reason).toBe("converged");
    // Converged well before exhausting all 6 branches.
    expect(specialized.length).toBeLessThan(6);
    expect(report.failed).toBeGreaterThanOrEqual(3);
  });

  it("halts on budget (max_iterations) when each iteration learns something new", async () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("camp1", "plan.md", rootAction, {
      max_seconds: 600,
      min_score: 0, // failures must not trigger below_threshold
      convergence_iterations: 100, // effectively never converges
    });
    mgr.branch("camp1", "root", [1, 2, 3, 4, 5].map(makeAction));

    const executor: LoopExecutor = {
      async specialize({ node_id }) {
        // Each branch produces a UNIQUE failure so every iteration writes a
        // new KB entry (never converges).
        return { output: `failure ${node_id}`, provenance: { tag: "claimed", claimant: "seed" }, token_usage: { kind: "unavailable", reason: "test fixture" } };
      },
      async review({ node_id }) {
        return { approved: false, rationale: `failure ${node_id}`, root_cause: `distinct cause ${node_id}`, token_usage: { kind: "unavailable", reason: "test fixture" } };
      },
      log() {},
    };

    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      config: makeConfig({ max_iterations: 3 }),
    });

    expect(report.halt_reason).toBe("max_iterations");
    expect(report.failed).toBe(3); // three distinct failures, all recorded
    expect(report.kb_entries_written).toBeGreaterThan(0);
  });
});

describe("Phase 3.2 — KB injection references prior failures", () => {
  it("injects the root_cause of a prior failure into the next specialist prompt", async () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("camp2", "plan.md", rootAction, {
      max_seconds: 600,
      min_score: 0, // a failure must not trigger below_threshold before the 2nd specialist
      convergence_iterations: 100,
    });
    mgr.branch("camp2", "root", [makeAction(1), makeAction(2)]);

    const specialistPrompts: string[] = [];
    let failFirst = true;

    const executor: LoopExecutor = {
      async specialize({ prompt }) {
        specialistPrompts.push(prompt);
        return {
          output: failFirst ? "attempt failed" : "recovered",
          provenance: { tag: "claimed", claimant: "seed" },
          token_usage: { kind: "unavailable", reason: "test fixture" },
        };
      },
      async review() {
        // First specialist fails with a documented root cause; second passes.
        const s = failFirst;
        failFirst = false;
        if (s) return { approved: false, rationale: "broke the auth tests", root_cause: "missing mock for auth service", token_usage: { kind: "unavailable", reason: "test fixture" } };
        return { approved: true, rationale: "now works", token_usage: { kind: "unavailable", reason: "test fixture" } };
      },
      log() {},
    };

    await runCampaign({ manager: mgr, campaign_id: "camp2", executor, config: makeConfig() });

    // The first specialist prompt is the plain base (nothing to inject yet).
    expect(specialistPrompts[0]).not.toContain("missing mock for auth service");
    // After the first failure wrote a KB failure_mode entry, the SECOND
    // specialist prompt should reference the prior root cause.
    expect(specialistPrompts.length).toBeGreaterThan(1);
    if (specialistPrompts.length > 1) {
      expect(specialistPrompts[1]).toContain("missing mock for auth service");
    }
  });
});

describe("bounded retry context in the campaign loop", () => {
  function priorCapsule(attempt: number): RetryContextCapsule {
    const built = buildRetryContextCapsule({
      identity: { campaignId: "retry-campaign", nodeId: "prior-node" },
      failure: { failure_class: "critic", kind: "critic_rejection", normalized_root_cause: "missing regression test" },
      stableContextDigest: createHash("sha256").update(DEFAULT_LOOP_CONFIG.specialist_base_prompt).digest("hex"),
      attempt,
      priorPromptDigest: "a".repeat(64),
      taskFacts: [
        { id: "action_category", summary: "refactor" },
        { id: "action_description", summary: "branch 1" },
      ],
      changedFiles: [],
      evidence: [],
      requirements: [{ id: "critic_root_cause", description: "missing regression test", status: "unresolved" }],
      toolSignatures: [],
    });
    if (!built.ok) throw new Error(built.error.reason);
    return built.capsule;
  }

  it("projects a prior capsule into the specialist prompt and emits a non-enforced advisory", async () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("retry-campaign", "plan.md", rootAction, { max_seconds: 600, min_score: 0, convergence_iterations: 10 });
    mgr.branch("retry-campaign", "root", [makeAction(1)]);
    const prompts: string[] = [];
    const events: LoopEvent[] = [];
    const retry_context: CampaignRetryContextPort = { load: () => priorCapsule(1), save: () => {} };
    const executor: LoopExecutor = {
      async specialize({ prompt }) {
        prompts.push(prompt);
        return { output: "fixed", provenance: { tag: "claimed", claimant: "seed" }, token_usage: { kind: "unavailable", reason: "fixture" } };
      },
      async review() {
        return { approved: true, rationale: "verified", token_usage: { kind: "unavailable", reason: "fixture" } };
      },
      log(event) { events.push(event); },
    };

    await runCampaign({ manager: mgr, campaign_id: "retry-campaign", executor, config: { ...makeConfig({ max_iterations: 1 }), retry_context } });

    expect(prompts[0]).toContain("Bounded retry context (attempt 1");
    expect(events).toContainEqual(expect.objectContaining({ type: "retry_advisory", action: "continue", enforced: false }));
  });

  it("suppresses a repeated identical retry only when enforcement is explicitly enabled", async () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("retry-campaign", "plan.md", rootAction, { max_seconds: 600, min_score: 0, convergence_iterations: 10 });
    mgr.branch("retry-campaign", "root", [makeAction(1)]);
    let dispatches = 0;
    const events: LoopEvent[] = [];
    const executor: LoopExecutor = {
      async specialize() {
        dispatches += 1;
        return { output: "should not run", provenance: { tag: "claimed", claimant: "seed" }, token_usage: { kind: "unavailable", reason: "fixture" } };
      },
      async review() {
        return { approved: false, rationale: "should not run", token_usage: { kind: "unavailable", reason: "fixture" } };
      },
      log(event) { events.push(event); },
    };

    await runCampaign({
      manager: mgr,
      campaign_id: "retry-campaign",
      executor,
      config: {
        ...makeConfig({ max_iterations: 1 }),
        retry_context: { load: () => priorCapsule(2), save: () => {} },
        retry_advisory_enforcement: true,
      },
    });

    expect(dispatches).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({ type: "retry_advisory", action: "decompose", enforced: true }));
  });

  it("persists a structured critic rejection without retaining raw transcripts", async () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("retry-campaign", "plan.md", rootAction, { max_seconds: 600, min_score: 0, convergence_iterations: 10 });
    mgr.branch("retry-campaign", "root", [makeAction(1)]);
    const saved: RetryContextCapsule[] = [];
    const executor: LoopExecutor = {
      async specialize() {
        return {
          output: "large raw specialist transcript", provenance: { tag: "claimed", claimant: "seed" },
          token_usage: { kind: "unavailable", reason: "fixture" }, tool_call_signatures: ["test:{suite:unit}"],
          changed_files: [{ path: "src/retry.ts", changeKind: "modified", deltaDigest: "b".repeat(64), summary: "modified src/retry.ts" }],
        };
      },
      async review() {
        return { approved: false, rationale: "raw critic rationale", root_cause: "missing regression test", token_usage: { kind: "unavailable", reason: "fixture" }, tool_call_signatures: ["review:{scope:diff}"] };
      },
      log() {},
    };

    await runCampaign({
      manager: mgr,
      campaign_id: "retry-campaign",
      executor,
      config: {
        ...makeConfig({ max_iterations: 1 }),
        retry_context: { load: () => null, save: ({ capsule }) => saved.push(capsule) },
      },
    });

    expect(saved).toHaveLength(1);
    expect(saved[0]?.failure).toEqual(expect.objectContaining({ failure_class: "critic", kind: "critic_rejection" }));
    expect(saved[0]?.requirements[0]?.description).toBe("missing regression test");
    expect(JSON.stringify(saved[0])).not.toContain("large raw specialist transcript");
    expect(JSON.stringify(saved[0])).not.toContain("raw critic rationale");
    expect(saved[0]?.toolSignatures.map((entry) => entry.name)).toEqual(["review", "test"]);
    expect(saved[0]?.changedFiles).toEqual([
      { path: "src/retry.ts", changeKind: "modified", deltaDigest: "b".repeat(64), summary: "modified src/retry.ts" },
    ]);
  });

  it("reloads a critic rejection into the bounded retry of the same node", async () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("retry-campaign", "plan.md", rootAction, { max_seconds: 600, min_score: 0, convergence_iterations: 10 });
    mgr.branch("retry-campaign", "root", [makeAction(1)]);
    let stored: RetryContextCapsule | null = null;
    const prompts: string[] = [];
    const retry_context: CampaignRetryContextPort = {
      load: () => stored,
      save: ({ capsule }) => { stored = capsule; },
    };
    const executor: LoopExecutor = {
      async specialize({ prompt }) {
        prompts.push(prompt);
        return { output: "candidate", provenance: { tag: "claimed", claimant: "seed" }, token_usage: { kind: "unavailable", reason: "fixture" } };
      },
      async review() {
        return { approved: false, rationale: "negative numbers fail", root_cause: "support negative signed integers", token_usage: { kind: "unavailable", reason: "fixture" } };
      },
      log() {},
    };

    await runCampaign({
      manager: mgr,
      campaign_id: "retry-campaign",
      executor,
      config: { ...makeConfig({ max_iterations: 4 }), critic_retry: { max_retries: 1 }, retry_context },
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("Bounded retry context");
    expect(prompts[1]).toContain("CORRECTIVE RETRY");
    expect(prompts[1]).toContain("support negative signed integers");
    expect((stored as { attempt: number } | null)?.attempt).toBe(2);
  });
});
