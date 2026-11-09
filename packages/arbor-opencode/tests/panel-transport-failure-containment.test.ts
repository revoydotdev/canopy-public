/**
 * panel-transport-failure-containment.test.ts — a review that never happened
 * must never be recorded as a review that rejected.
 *
 * WHY THIS EXISTS. The loop core is careful about this: `recordReviewFailure`
 * leaves a node `awaiting_review` with its candidate intact, `review_pending`
 * is documented as "never a rendered verdict", and the containment branch in
 * `runCampaign` refuses to score a node whose critic could not be reached. All
 * of that machinery is gated on `CriticResult.error` being set.
 *
 * `ReviewerVerdict` had no `error` field. It was structurally incapable of
 * saying "the review did not happen", so `createOpenCodePanelReviewer` — the
 * reviewer every production campaign actually uses — caught its own transport
 * failures and returned an ordinary-looking rejection instead:
 *
 *   { approved: false,
 *     rationale: "lenticel dispatch failed (transport_error): ...",
 *     root_cause: "transport_error", severity: "high" }
 *
 * From there `reconcile()` treated it as a real rejection, `reconcilePanelVerdict`
 * built a syntactically valid five-mandate verdict out of zero parsed votes,
 * `critic.error` was never set so containment never fired, and the node went
 * terminal `failed` carrying a five-mandate rejection nobody had rendered. A
 * network blip was durably recorded as "the critic reviewed this work and
 * rejected it."
 *
 * The existing containment tests all use a reviewer that THROWS, which is the
 * one failure shape the real reviewer never produces — it catches everything.
 * These tests use the shape production actually emits.
 */
import { describe, it, expect } from "vitest";
import { CampaignManager } from "@arbor/mcp";
import { PanelOfCritics, reconcile } from "@arbor/campaign-support";
import { runCampaign, DEFAULT_LOOP_CONFIG, type LoopExecutor, type CampaignLoopConfig, type LoopEvent } from "../src/loop.js";
import type { Action, ScoreContext, CapabilityContext, TokenUsage } from "@arbor/core";

const rootAction: Action = {
  description: "execute plan", estimated_gain: 100, estimated_cost: 1,
  category: "root", delegate_to: "crown",
};
const refactorAction: Action = {
  description: "refactor auth module", estimated_gain: 50, estimated_cost: 10,
  category: "refactor", delegate_to: "seed",
};
const ctx: ScoreContext = { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 100, total_visits: 5 };
const specialistCap: CapabilityContext = { tier: "specialist" };
const criticCap: CapabilityContext = { tier: "critic" };
const noUsage: TokenUsage = {
  input_tokens: 0, output_tokens: 0, cached_input_tokens: 0,
  cache_write_input_tokens: 0, counter_source: "provider_counter",
};

function makeConfig(overrides: Partial<CampaignLoopConfig> = {}): CampaignLoopConfig {
  return {
    max_iterations: 10,
    specialist_base_prompt: DEFAULT_LOOP_CONFIG.specialist_base_prompt,
    critic_base_prompt: DEFAULT_LOOP_CONFIG.critic_base_prompt,
    specialist_cap: specialistCap,
    critic_cap: criticCap,
    score_ctx: () => ctx,
    use_worktrees: false,
    branch_actions: () => null,
    ...overrides,
  } as CampaignLoopConfig;
}

function startCampaign(mgr: CampaignManager, id = "camp1"): void {
  mgr.startCampaign(id, "plan.md", rootAction);
  mgr.branch(id, "root", [refactorAction]);
}

function claimingExecutor(): LoopExecutor {
  return {
    async specialize() {
      return { output: "real work happened", provenance: { tag: "claimed", claimant: "seed" }, token_usage: noUsage };
    },
    async review() { throw new Error("unreachable: panel is configured"); },
  };
}

/**
 * Exactly what `createOpenCodePanelReviewer` returns when `runOpenCode`
 * reports a failed dispatch: a caught transport error wearing a verdict's
 * clothes. Kept in this shape deliberately — if the production reviewer stops
 * emitting this, these tests should be revisited, not quietly passed.
 */
const TRANSPORT_ERROR = {
  kind: "transport_error" as const,
  recoverable: true,
  provenance: { tag: "claimed" as const, claimant: "opencode-executor" },
  message: "opencode run exited 1: socket hang up",
};

const TRANSPORT_FAILURE_AS_VERDICT = {
  approved: false,
  rationale: "lenticel dispatch failed (transport_error): opencode run exited 1: socket hang up",
  root_cause: "transport_error",
  severity: "high" as const,
};

describe("a panel whose reviewers could not be reached", () => {
  it("leaves the node awaiting_review rather than failing it", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor: claimingExecutor(),
      config: makeConfig({
        panel: new PanelOfCritics(),
        run_reviewer: async () => ({
          ...TRANSPORT_FAILURE_AS_VERDICT,
          error: TRANSPORT_ERROR,
        }),
      }),
    });
    expect(report.review_pending).toBeGreaterThan(0);
    expect(report.failed).toBe(0);
  });

  it("emits review_pending, never a node_failed carrying a verdict nobody rendered", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const events: LoopEvent[] = [];
    await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor: { ...claimingExecutor(), log: (e) => { events.push(e); } },
      config: makeConfig({
        panel: new PanelOfCritics(),
        run_reviewer: async () => ({
          ...TRANSPORT_FAILURE_AS_VERDICT,
          error: TRANSPORT_ERROR,
        }),
      }),
    });
    expect(events.some((e) => e.type === "review_pending")).toBe(true);
    expect(events.some((e) => e.type === "node_failed")).toBe(false);
  });

  it("preserves the specialist's candidate instead of discarding completed work", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor: claimingExecutor(),
      config: makeConfig({
        panel: new PanelOfCritics(),
        run_reviewer: async () => ({
          ...TRANSPORT_FAILURE_AS_VERDICT,
          error: TRANSPORT_ERROR,
        }),
      }),
    });
    // `resumableReviewNodes` is precisely the set the harness can pick up
    // again: nodes parked `awaiting_review` with their candidate intact.
    expect(mgr.resumableReviewNodes("camp1").length).toBeGreaterThan(0);
  });
});

describe("reconcile distinguishes an unrendered review from a rejection", () => {
  it("reports an error rather than a decision when the mandatory reviewer never ran", () => {
    const decision = reconcile(
      { lenticel: { ...TRANSPORT_FAILURE_AS_VERDICT, error: TRANSPORT_ERROR } },
      { high_stakes: false },
    );
    expect(decision.error).toBeDefined();
    expect(decision.error?.kind).toBe("transport_error");
  });

  it("does not let an unreached reviewer masquerade as a binding rejection", () => {
    // Lenticel genuinely approved. Security could not be reached. The panel
    // must not report a clean approval (a mandated check never ran), and must
    // not report a rejection either (nobody rejected anything).
    const decision = reconcile({
      lenticel: { approved: true, rationale: "looks good" },
      security: { ...TRANSPORT_FAILURE_AS_VERDICT, error: TRANSPORT_ERROR },
    }, { high_stakes: true });
    expect(decision.error).toBeDefined();
    expect(decision.approved).toBe(false);
  });

  it("still returns a real rejection when a reviewer that actually ran rejected", () => {
    // An optional reviewer being unreachable must not erase a genuine verdict
    // from a reviewer that did render one.
    const decision = reconcile({
      lenticel: { approved: false, rationale: "no root cause given", root_cause: "missing_root_cause", severity: "high" },
      design: { ...TRANSPORT_FAILURE_AS_VERDICT, error: TRANSPORT_ERROR },
    }, { high_stakes: false });
    expect(decision.error).toBeUndefined();
    expect(decision.approved).toBe(false);
    expect(decision.critic_root_cause).toContain("missing_root_cause");
  });
});
