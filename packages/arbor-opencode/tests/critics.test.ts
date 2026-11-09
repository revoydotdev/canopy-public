import { describe, it, expect } from "vitest";
import { PanelOfCritics, reconcile, type ReviewerRunner } from "@arbor/campaign-support";
import type { ReviewerVerdict } from "@arbor/campaign-support";
import { CampaignManager } from "@arbor/mcp";
import { runCampaign, DEFAULT_LOOP_CONFIG, type CampaignLoopConfig, type LoopExecutor } from "../src/loop.js";
import type { Action, ScoreContext, CapabilityContext } from "@arbor/core";

const rootAction: Action = {
  description: "execute plan",
  estimated_gain: 100,
  estimated_cost: 1,
  category: "root",
  delegate_to: "crown",
};
const authAction: Action = {
  description: "add auth token handling",
  estimated_gain: 50,
  estimated_cost: 10,
  category: "security",
  delegate_to: "seed",
};
const ctx: ScoreContext = { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 100, total_visits: 5 };
const specialistCap: CapabilityContext = { tier: "specialist" };
const criticCap: CapabilityContext = { tier: "critic" };

describe("PanelOfCritics.activeReviewers", () => {
  it("always includes lenticel (never an empty panel)", () => {
    const panel = new PanelOfCritics({ reviewers: { lenticel: false, burl: false } });
    const active = panel.activeReviewers({ action_category: "testing", high_stakes: false, description: "utility" });
    expect(active.map((c) => c.name)).toContain("lenticel");
  });

  it("adds security critic for security-category work", () => {
    const panel = new PanelOfCritics();
    const active = panel.activeReviewers({ action_category: "security", high_stakes: true, description: "auth token handling" });
    expect(active.map((c) => c.name)).toContain("security");
    expect(active.map((c) => c.name)).toContain("burl");
  });

  it("does not pull security/performance critics for unrelated work", () => {
    const panel = new PanelOfCritics();
    const active = panel.activeReviewers({ action_category: "testing", high_stakes: false, description: "add a unit test" });
    const names = active.map((c) => c.name);
    expect(names).not.toContain("security");
    expect(names).not.toContain("performance");
  });
});

describe("PanelOfCritics.reconcile", () => {
  it("approves when lenticel approves and no binding blocker", () => {
    const d = reconcile(
      { lenticel: { approved: true, rationale: "ok" }, burl: { approved: true, rationale: "fine", severity: "low" } },
      { high_stakes: false },
    );
    expect(d.approved).toBe(true);
    expect(d.critic_agent).toBe("panel");
  });

  it("rejects when lenticel rejects (lenticel is binding)", () => {
    const d = reconcile(
      {
        lenticel: { approved: false, rationale: "blocked", root_cause: "schema undefined" },
        burl: { approved: true, rationale: "fine" },
      },
      { high_stakes: false },
    );
    expect(d.approved).toBe(false);
    expect(d.critic_rationale).toContain("schema undefined");
  });

  it("rejects a bad action that Lenticel alone would approve, when a domain critic blocks", () => {
    // Lenticel approves, but the security critic finds a high-severity issue.
    // This is the Phase 3.4 acceptance: the panel rejects MORE bad actions.
    const d = reconcile(
      {
        lenticel: { approved: true, rationale: "looks fine to me" },
        security: { approved: false, rationale: "session token stored insecurely", root_cause: "token in localStorage", severity: "high" },
      },
      { high_stakes: true },
    );
    expect(d.approved).toBe(false);
    expect(d.critic_rationale).toContain("security");
    expect(d.critic_root_cause).toContain("token in localStorage");
  });

  it("lenticel alone approves (no domain critic) but high-stakes burl rejection blocks", () => {
    const d = reconcile(
      {
        lenticel: { approved: true, rationale: "ok" },
        burl: { approved: false, rationale: "irreversible architecture", root_cause: "couples all modules", severity: "high" },
      },
      { high_stakes: true },
    );
    expect(d.approved).toBe(false);
  });

  it("advisory (low-severity) domain concern does not block", () => {
    const d = reconcile(
      {
        lenticel: { approved: true, rationale: "ok" },
        performance: { approved: true, rationale: "minor inefficiency", severity: "low" },
      },
      { high_stakes: false },
    );
    expect(d.approved).toBe(true);
  });
});

describe("Panel rejects more bad actions than Lenticel alone (Phase 3.4)", () => {
  it("catches a bad auth action the single critic misses, via the security critic", async () => {
    const panel = new PanelOfCritics();

    // A bad action: Lenticel independently approves (its mandate is generic),
    // but the security critic catches the flaw.
    const runReviewer = async (name: string): Promise<ReviewerVerdict> => {
      if (name === "lenticel") return { approved: true, rationale: "code compiles" };
      if (name === "security") return { approved: false, rationale: "token stored insecurely", root_cause: "token in localStorage", severity: "high" };
      return { approved: true, rationale: "n/a" };
    };

    const decision = await panel.review(
      { action_category: "security", high_stakes: true, description: "add auth token handling" },
      runReviewer,
    );
    expect(decision.approved).toBe(false);

    // And a good action is approved.
    const good = await panel.review(
      { action_category: "testing", high_stakes: false, description: "add a unit test" },
      async () => ({ approved: true, rationale: "ok" }),
    );
    expect(good.approved).toBe(true);
  });
});

describe("Panel wired into runCampaign", () => {
  function makeConfig(panel: PanelOfCritics, runReviewer: ReviewerRunner): CampaignLoopConfig {
    return {
      max_iterations: 3,
      specialist_base_prompt: DEFAULT_LOOP_CONFIG.specialist_base_prompt,
      critic_base_prompt: DEFAULT_LOOP_CONFIG.critic_base_prompt,
      specialist_cap: specialistCap,
      critic_cap: criticCap,
      score_ctx: () => ctx,
      use_worktrees: false,
      branch_actions: () => null,
      panel,
      run_reviewer: runReviewer,
    };
  }

  it("panel rejection fails the node and backtracks", async () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("camp1", "plan.md", rootAction);
    mgr.branch("camp1", "root", [authAction]);

    const executor: LoopExecutor = {
      async specialize() {
        return { output: "added token handling", provenance: { tag: "claimed", claimant: "seed" }, token_usage: { kind: "unavailable", reason: "test fixture" } };
      },
      async review() {
        return { approved: true, rationale: "unused", token_usage: { kind: "unavailable", reason: "test fixture" } }; // executor.review is not called in panel mode
      },
      log() {},
    };

    const panel = new PanelOfCritics({ reviewers: { lenticel: true, burl: false, performance: false, design: false } });
    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      config: makeConfig(panel, async (name) => {
        if (name === "lenticel") return { approved: true, rationale: "ok" };
        if (name === "security") return { approved: false, rationale: "insecure storage", root_cause: "token in localStorage", severity: "high" };
        return { approved: true, rationale: "n/a" };
      }),
    });

    // The panel (security critic) rejects the auth action.
    expect(report.failed).toBeGreaterThan(0);
    expect(report.verified).toBe(0);
  });

  it("panel approves a sound action end-to-end", async () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("camp2", "plan.md", rootAction);
    mgr.branch("camp2", "root", [{ ...authAction, category: "testing", description: "add unit test" }]);

    const executor: LoopExecutor = {
      async specialize() {
        return { output: "added test", provenance: { tag: "verified", cmd: "npx vitest run", exit: 0, stdout_hash: "sha256:test" }, token_usage: { kind: "unavailable", reason: "test fixture" } };
      },
      async review() {
        return { approved: true, rationale: "unused", token_usage: { kind: "unavailable", reason: "test fixture" } };
      },
      log() {},
    };

    const panel = new PanelOfCritics();
    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp2",
      executor,
      config: makeConfig(panel, async (_name, context) => {
        expect(context.specialist_output).toBe("added test");
        expect(context.worktree_path).toBe(".tmp");
        return { approved: true, rationale: "ok" };
      }),
    });

    expect(report.verified).toBeGreaterThan(0);
    expect(report.failed).toBe(0);
  });
});
