/**
 * Closes the "confirmation admits a campaign but never runs it" gap: a
 * confirmed task-composer draft must SUBMIT the admitted campaign to a real
 * supervised `campaign.run` job (see `task-composer-admission.ts`), not just
 * create its tree and report `job_id: null`.
 *
 * These tests exercise `ArborRuntime`'s own default `TaskComposer`
 * composition (no `task_composer` override), which is exactly what
 * `cli.ts`'s `createCliRuntime` relies on for `arbor task ... confirm`.
 */
import { describe, expect, it } from "vitest";
import type { Action } from "@arbor/core";
import { runCampaign, type CampaignLoopConfig, type LoopExecutor } from "@arbor/opencode";
import type { JobScheduler } from "../src/job-scheduler.js";
import { CampaignManager } from "../src/manager.js";
import { ArborRuntime, CAMPAIGN_RUN_JOB_KIND, type CampaignRunner, type CampaignRunOutcome } from "../src/runtime.js";
import type { TaskAttachmentStore } from "../src/task-attachment-store.js";
import { createSupervisedTaskComposerAdmissionPort } from "../src/task-composer-admission.js";

const proposal = (): string => JSON.stringify({
  summary: "implement the requested change", assumptions: [], questions: [],
  root_action: { description: "deliver the task", estimated_gain: 1, estimated_cost: 1, category: "delivery", delegate_to: "crown" },
  actions: [{ description: "implement and verify", estimated_gain: 1, estimated_cost: 1, category: "delivery", delegate_to: "seed" }],
  acceptance_checks: ["tests pass"], acceptance_mapping: [{ criterion: "tests pass", action_descriptions: ["implement and verify"] }], risk_notes: [],
});
const planner = {
  plan: async () => ({
    raw_proposal: proposal(), session_id: "plan-session", model_identity: "native-test",
    usage: { kind: "unavailable" as const, reason: "test planner" },
  }),
};
const preexistingRoot: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };

function loopConfig(): CampaignLoopConfig {
  return {
    max_iterations: 10,
    specialist_base_prompt: "specialist",
    critic_base_prompt: "critic",
    specialist_cap: { tier: "specialist" },
    critic_cap: { tier: "critic" },
    score_ctx: () => ({ accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 100, total_visits: 1 }),
    use_worktrees: false,
    branch_actions: () => null,
  };
}

function deterministicExecutor(): LoopExecutor {
  return {
    async specialize() {
      return { output: "done", provenance: { tag: "claimed", claimant: "seed" }, token_usage: { kind: "unavailable", reason: "test executor" } };
    },
    async review() {
      return { approved: true, rationale: "looks good", critic_agent: "critic", measurement_validated: true, token_usage: { kind: "unavailable", reason: "test executor" } };
    },
  };
}

/** A real `CampaignRunner` that records every campaign id it was asked to run and genuinely drives the tree-search loop, exactly like `campaign-job-runner.test.ts`'s doubles. */
function recordingCampaignRunner(manager: CampaignManager): { runner: CampaignRunner; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    runner: {
      async run(campaignId: string, signal: AbortSignal): Promise<CampaignRunOutcome> {
        calls.push(campaignId);
        const report = await runCampaign({ manager, campaign_id: campaignId, executor: deterministicExecutor(), config: loopConfig(), signal });
        return { halted: report.halted, halt_reason: report.halt_reason, cancelled: report.cancelled, awaiting_user_input: report.awaiting_user_input };
      },
    },
  };
}

describe("task-composer confirmation submits a real run (not just admission)", () => {
  it("(a) confirm() on a question-free proposal returns a non-null job_id", async () => {
    const manager = new CampaignManager();
    const { runner } = recordingCampaignRunner(manager);
    const runtime = new ArborRuntime({ manager, campaign_runner: runner, task_composer_planner: planner });

    const draft = await runtime.taskComposer.submit({ kind: "taskcomposer.submit", task: "ship it", source: "cli", idempotency_key: "submit-a" });
    expect(draft.status).toBe("proposed");
    const confirmed = await runtime.taskComposer.confirm({ kind: "taskcomposer.confirm", draft_id: draft.id, expected_revision: draft.revision, idempotency_key: "confirm-a" });
    expect(confirmed.status).toBe("admitted");
    expect(confirmed.job_id).not.toBeNull();
    expect(confirmed.campaign_id).toBe(`composer-${draft.id}`);
  });

  it("(b) the submitted job reaches the runner, invoked with the admitted campaign_id", async () => {
    const manager = new CampaignManager();
    const { runner, calls } = recordingCampaignRunner(manager);
    const runtime = new ArborRuntime({ manager, campaign_runner: runner, task_composer_planner: planner });

    const draft = await runtime.taskComposer.submit({ kind: "taskcomposer.submit", task: "ship it", source: "cli", idempotency_key: "submit-b" });
    const confirmed = await runtime.taskComposer.confirm({ kind: "taskcomposer.confirm", draft_id: draft.id, expected_revision: draft.revision, idempotency_key: "confirm-b" });

    expect(calls).toEqual([confirmed.campaign_id]);
  });

  it("(c) re-confirming with the same idempotency_key replays the same job_id — no second submission", async () => {
    const manager = new CampaignManager();
    const { runner, calls } = recordingCampaignRunner(manager);
    const runtime = new ArborRuntime({ manager, campaign_runner: runner, task_composer_planner: planner });

    const draft = await runtime.taskComposer.submit({ kind: "taskcomposer.submit", task: "ship it", source: "cli", idempotency_key: "submit-c" });
    const first = await runtime.taskComposer.confirm({ kind: "taskcomposer.confirm", draft_id: draft.id, expected_revision: draft.revision, idempotency_key: "confirm-c" });
    const second = await runtime.taskComposer.confirm({ kind: "taskcomposer.confirm", draft_id: draft.id, expected_revision: draft.revision, idempotency_key: "confirm-c" });

    expect(second).toEqual(first);
    expect(second.job_id).toBe(first.job_id);
    expect(calls).toEqual([first.campaign_id]);
    expect(runtime.jobScheduler.view({ include_terminal: true }).jobs).toHaveLength(1);
  });

  it("(d) an admission-gate failure fails closed: no job submitted, no phantom running state", async () => {
    const manager = new CampaignManager();
    const { runner, calls } = recordingCampaignRunner(manager);
    const runtime = new ArborRuntime({ manager, campaign_runner: runner, task_composer_planner: planner });

    const draft = await runtime.taskComposer.submit({ kind: "taskcomposer.submit", task: "ship it", source: "cli", idempotency_key: "submit-d" });
    // Force the admission step itself to fail: a campaign with the composer's
    // deterministic id (`composer-${draft.id}`) already exists, so
    // `manager.admitCampaignPlan` throws before any job is ever submitted.
    manager.admitCampaignPlan({ id: `composer-${draft.id}`, plan_path: "preexisting.json", root_action: preexistingRoot, actions: [preexistingRoot] });

    const confirmed = await runtime.taskComposer.confirm({ kind: "taskcomposer.confirm", draft_id: draft.id, expected_revision: draft.revision, idempotency_key: "confirm-d" });

    expect(confirmed.status).toBe("failed");
    expect(confirmed.job_id).toBeNull();
    expect(confirmed.campaign_id).toBeNull();
    expect(calls).toEqual([]);
    expect(runtime.jobScheduler.view({ include_terminal: true }).jobs).toEqual([]);
  });

  it("ADR-118: a real admission-gate refusal (not a pre-existing-campaign throw) states the projected remediation, not just the raw gate detail", async () => {
    const manager = new CampaignManager();
    const { runner } = recordingCampaignRunner(manager);
    const runtime = new ArborRuntime({ manager, campaign_runner: runner, task_composer_planner: planner });
    // Call the real supervised admission port directly, the same one
    // `ArborRuntime` composes for its own `TaskComposer` (runtime.ts) — this
    // exercises `admit()`'s actual thrown-error text without depending on
    // `TaskComposer.confirm` also threading a `config` override through
    // (which it does not today; see task-composer.ts's own `confirm`).
    const admission = createSupervisedTaskComposerAdmissionPort({
      manager,
      jobScheduler: () => runtime.jobScheduler,
      campaignRunJobKind: CAMPAIGN_RUN_JOB_KIND,
      hasCampaignRunner: () => true,
      runCampaignJob: (campaignId, jobId) => runtime.runCampaignJob(campaignId, jobId),
    });

    await expect(admission.admit({
      draft_id: "draft-gate-fail",
      campaign_id: "composer-draft-gate-fail",
      plan_path: ".arbor/task-composer/draft-gate-fail.json",
      proposal: { root_action: preexistingRoot, actions: [preexistingRoot], acceptance_checks: [], acceptance_mapping: [], summary: "s", assumptions: [], questions: [], risk_notes: [] },
      // A negative max_seconds makes `checkAdmission`'s config_valid check
      // genuinely fail — a real admission-gate refusal, not the "campaign
      // already exists" throw test (d) above uses.
      config: { max_seconds: -1 },
    })).rejects.toThrow(/campaign admission gate failed: .+ — .+(config|precondition)/i);
  });

  it("(e) preflights a paused scheduler before admission so no orphan campaign is exposed", async () => {
    const manager = new CampaignManager();
    const { runner, calls } = recordingCampaignRunner(manager);
    const runtime = new ArborRuntime({ manager, campaign_runner: runner, task_composer_planner: planner });
    // A real failure, not a double: pausing the scheduler makes its own
    // `.submit()` genuinely reject with "queue is paused" after admission
    // has already durably created the tree.
    runtime.jobScheduler.pause();

    const draft = await runtime.taskComposer.submit({ kind: "taskcomposer.submit", task: "ship it", source: "cli", idempotency_key: "submit-e" });
    const confirmed = await runtime.taskComposer.confirm({ kind: "taskcomposer.confirm", draft_id: draft.id, expected_revision: draft.revision, idempotency_key: "confirm-e" });

    expect(confirmed.status).toBe("failed");
    expect(confirmed.planner.error).toMatch(/run job could not be submitted/);
    expect(calls).toEqual([]);
    expect(manager.listCampaigns().some((campaign) => campaign.id === `composer-${draft.id}`)).toBe(false);
  });

  it("fails closed when no campaign runner is configured at all (typed absence, not a silent job_id: null)", async () => {
    const manager = new CampaignManager();
    const runtime = new ArborRuntime({ manager, task_composer_planner: planner });

    const draft = await runtime.taskComposer.submit({ kind: "taskcomposer.submit", task: "ship it", source: "cli", idempotency_key: "submit-f" });
    const confirmed = await runtime.taskComposer.confirm({ kind: "taskcomposer.confirm", draft_id: draft.id, expected_revision: draft.revision, idempotency_key: "confirm-f" });

    expect(confirmed.status).toBe("failed");
    expect(confirmed.planner.error).toMatch(/no campaign runner is configured/);
    expect(manager.listCampaigns()).toEqual([]);
  });

  it("verifies and immutably binds attachment refs before dispatching their admitted campaign", async () => {
    const calls: string[] = [];
    const attachmentStore = {
      resolve: () => { calls.push("resolve"); return []; },
      bindCampaign: (campaignId: string) => { calls.push(`bind:${campaignId}`); },
    } as unknown as TaskAttachmentStore;
    const scheduler = {
      preflightSubmit: () => ({ ok: true }),
      submit: () => ({ ok: true, dispatched: false, job: { id: "job-media" } }),
    } as unknown as JobScheduler;
    const admission = createSupervisedTaskComposerAdmissionPort({
      manager: { admitCampaignPlan: () => ({ ok: true, campaign_id: "campaign-media" }) } as unknown as CampaignManager,
      jobScheduler: () => scheduler,
      campaignRunJobKind: "campaign.run",
      hasCampaignRunner: () => true,
      attachment_store: attachmentStore,
      runCampaignJob: () => ({ ok: true }),
    });

    const result = await admission.admit({
      draft_id: "draft-media", campaign_id: "campaign-media", plan_path: "plan.json",
      proposal: { root_action: preexistingRoot, actions: [preexistingRoot] },
      config: {}, attachments: [{ sha256: "a".repeat(64) }],
    } as never);

    expect(calls).toEqual(["resolve", "bind:campaign-media"]);
    expect(result).toEqual({ campaign_id: "campaign-media", job_id: "job-media" });
  });

  it("rejects attachment admission when the composed runner has no attachment store", async () => {
    const admission = createSupervisedTaskComposerAdmissionPort({
      manager: {} as CampaignManager,
      jobScheduler: () => ({} as JobScheduler),
      campaignRunJobKind: "campaign.run",
      hasCampaignRunner: () => true,
      runCampaignJob: () => ({ ok: true }),
    });

    await expect(admission.admit({ attachments: [{ sha256: "a".repeat(64) }] } as never))
      .rejects.toThrow(/attachment-capable campaign runner/);
  });

  it("surfaces a scheduler submission failure after successful campaign admission", async () => {
    const admission = createSupervisedTaskComposerAdmissionPort({
      manager: { admitCampaignPlan: () => ({ ok: true, campaign_id: "campaign-submit-failure" }) } as unknown as CampaignManager,
      jobScheduler: () => ({
        preflightSubmit: () => ({ ok: true }),
        submit: () => ({ ok: false, error: "queue changed" }),
      } as unknown as JobScheduler),
      campaignRunJobKind: "campaign.run",
      hasCampaignRunner: () => true,
      runCampaignJob: () => ({ ok: true }),
    });

    await expect(admission.admit({
      draft_id: "draft-submit-failure", campaign_id: "campaign-submit-failure", plan_path: "plan.json",
      proposal: { root_action: preexistingRoot, actions: [preexistingRoot] }, config: {},
    } as never)).rejects.toThrow(/run job could not be submitted: queue changed/);
  });

  it("surfaces a dispatched campaign runner start failure", async () => {
    const admission = createSupervisedTaskComposerAdmissionPort({
      manager: { admitCampaignPlan: () => ({ ok: true, campaign_id: "campaign-start-failure" }) } as unknown as CampaignManager,
      jobScheduler: () => ({
        preflightSubmit: () => ({ ok: true }),
        submit: () => ({ ok: true, dispatched: true, job: { id: "job-start-failure" } }),
      } as unknown as JobScheduler),
      campaignRunJobKind: "campaign.run",
      hasCampaignRunner: () => true,
      runCampaignJob: () => ({ ok: false, reason: "runner unavailable" }),
    });

    await expect(admission.admit({
      draft_id: "draft-start-failure", campaign_id: "campaign-start-failure", plan_path: "plan.json",
      proposal: { root_action: preexistingRoot, actions: [preexistingRoot] }, config: {},
    } as never)).rejects.toThrow(/run could not start: runner unavailable/);
  });
});
