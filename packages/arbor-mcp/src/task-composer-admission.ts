import type { CampaignManager } from "./manager.js";
import { defaultGateRemediation, projectGateRecord } from "./gate-refusal-projection.js";
import type { JobScheduler } from "./job-scheduler.js";
import type { TaskComposerAdmissionPort } from "./task-composer.js";
import type { TaskAttachmentStore } from "./task-attachment-store.js";

/**
 * Dependencies a composition root supplies so confirmation can genuinely
 * submit a run, not just admit a tree. `jobScheduler`/`hasCampaignRunner`/
 * `runCampaignJob` are lazy (`ArborRuntime` composes this port before its own
 * `jobScheduler`/`campaignRunner` fields are assigned; by the time `admit`
 * is actually invoked — at a real `taskcomposer.confirm`, always after
 * construction finishes — the closures resolve to the live values).
 */
export interface SupervisedTaskComposerAdmissionDeps {
  readonly manager: CampaignManager;
  readonly jobScheduler: () => JobScheduler;
  /** The `job_kind` a submitted run is registered under; callers pass `CAMPAIGN_RUN_JOB_KIND` (runtime.ts) so this module never needs a circular import on runtime.ts. */
  readonly campaignRunJobKind: string;
  /** True once a real `CampaignRunner` is configured. False means "typed absence", not a bug — submission fails closed instead of queuing a job nothing will ever execute. */
  readonly hasCampaignRunner: () => boolean;
  /** Immutable media binding for native campaign dispatch. Required for attachments. */
  readonly attachment_store?: TaskAttachmentStore;
  /** Starts the tree-search loop for an already-registered, already-started job — the exact seam `RuntimeCatalogRouter.dispatchJobCommand`'s `job.submit` case already uses for every other `CAMPAIGN_RUN_JOB_KIND` dispatch (see `ArborRuntime.runCampaignJob`). */
  readonly runCampaignJob: (campaignId: string, jobId: string) => { ok: true } | { ok: false; reason: string };
}

/**
 * Confirm-time admission port composed by `ArborRuntime` for its own default
 * `TaskComposer`. `manager.admitCampaignPlan` remains the sole tree-creation
 * authority and runs first; only once the tree is durably admitted does this
 * submit a supervised `campaign.run` job through the runtime's own
 * `JobScheduler` and hand it to `runCampaignJob`. No second runner and no
 * second job registry are introduced — this is the identical path
 * `RuntimeCatalogRouter`'s `job.submit` dispatch already drives for every
 * other `CAMPAIGN_RUN_JOB_KIND` job, including the native-executor path,
 * because it resolves to the same `runtime.campaignRunner`.
 *
 * A submission failure after a successful admission is thrown, not
 * swallowed: `TaskComposer.confirm` catches it and settles the draft as
 * `failed` with the error recorded, rather than reporting a fabricated
 * `job_id`.
 */
export function createSupervisedTaskComposerAdmissionPort(deps: SupervisedTaskComposerAdmissionDeps): TaskComposerAdmissionPort {
  return {
    async admit(input) {
      if (!deps.hasCampaignRunner()) throw new Error("no campaign runner is configured to run this campaign");
      if ((input.attachments?.length ?? 0) > 0 && deps.attachment_store === undefined) throw new Error("governed task attachments require an attachment-capable campaign runner");
      // Verify all content-addressed objects before tree creation. The later
      // binding uses the admitted id and remains immutable across restarts.
      if ((input.attachments?.length ?? 0) > 0) deps.attachment_store!.resolve(input.attachments!);
      const jobId = `task-composer-run:${input.draft_id}`;
      const jobInput = { id: jobId, operation_id: jobId, kind: deps.campaignRunJobKind, owner_scope_id: input.campaign_id, idempotency_key: jobId };
      const preflight = deps.jobScheduler().preflightSubmit(jobInput);
      if (!preflight.ok) throw new Error(`campaign run job could not be submitted: ${preflight.error}`);
      const admitted = deps.manager.admitCampaignPlan({
        id: input.campaign_id,
        plan_path: input.plan_path,
        root_action: input.proposal.root_action,
        actions: input.proposal.actions,
        acceptance_checks: input.proposal.acceptance_checks,
        ...(input.proposal.acceptance_mapping === undefined ? {} : { acceptance_mapping: input.proposal.acceptance_mapping }),
        config: input.config,
        ...(input.governance ? { governance: input.governance } : {}),
      });
      // ADR-118: same shared projection `TaskComposer`'s default admission
      // port (task-composer.ts) uses, so a supervised admission failure
      // states a remediation, not only the raw gate detail.
      if (!admitted.ok) {
        const refusal = projectGateRecord(admitted.gate, defaultGateRemediation(admitted.gate.gate));
        throw new Error(`campaign admission gate failed: ${refusal?.summary ?? admitted.gate.detail} — ${refusal?.remediation ?? "resolve the admission gate deficit and retry"}`);
      }
      if ((input.attachments?.length ?? 0) > 0) deps.attachment_store!.bindCampaign(admitted.campaign_id, input.attachments!);
      // Deterministic on draft_id: under correct CAS use TaskComposer.confirm
      // calls admit() at most once per draft (see its `status === "admitted"`
      // short-circuit and its own idempotency_key replay), but keeping the
      // scheduler-level id/operation_id deterministic means an accidental
      // second admit() for the same draft still replays the same job through
      // JobScheduler's own operation_id idempotency instead of starting a
      // second run.
      const submitted = deps.jobScheduler().submit(jobInput);
      if (!submitted.ok) throw new Error(`campaign ${admitted.campaign_id} was admitted but its run job could not be submitted: ${submitted.error}`);
      if (submitted.dispatched) {
        const started = deps.runCampaignJob(admitted.campaign_id, submitted.job.id);
        if (!started.ok) throw new Error(`campaign ${admitted.campaign_id} was admitted but its run could not start: ${started.reason}`);
      }
      return { campaign_id: admitted.campaign_id, job_id: submitted.job.id };
    },
  };
}
