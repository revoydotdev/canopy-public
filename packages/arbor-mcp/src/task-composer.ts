import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { requestsDeliberatePlanning } from "./task-planning-intent.js";
import type { Action, ArbiterBlastRadius, ArbiterDecision, CampaignConfig, GovernanceTier, HighRiskCommandArgvEntry, IntentLedger, IntentLifecycleRecord, TokenUsageResult } from "@arbor/core";
import { createIntentAdmissionState, isHighRiskCommandIntent, resetIntentTurn, transitionIntentAdmission } from "@arbor/core";
import type { IntentAdmissionState } from "@arbor/core";
import { CampaignManager } from "./manager.js";
import { defaultGateRemediation, projectGateRecord } from "./gate-refusal-projection.js";
import { classifyActionMutation, classifyGovernanceTier, extractDeclaredScope, extractExactWritePaths, incorporatePlannerWritePaths, turnBudgetEstimateForTier, type ArbiterIntakePort } from "./arbiter-intake.js";
import { buildIntentDecision, buildIntentScope } from "./intent-admission-bridge.js";
import { IntentLedgerStore } from "./intent-ledger-store.js";
import {
  parseTaskComposerProposal,
  type TaskComposerCommand,
  type TaskComposerCommandBinding,
  type TaskComposerDraft,
  type TaskComposerGuidance,
  type TaskComposerPlannerProjection,
  type TaskComposerProposal,
  type TaskComposerQuery,
  type TaskComposerValidation,
  type TaskAttachmentRef,
  validateTaskComposerCommand,
  validateTaskComposerProposal,
  validateTaskComposerQuery,
} from "./task-composer-contracts.js";
import type { TaskAttachmentStore } from "./task-attachment-store.js";

/** Bounded planner attempts before a draft is failed — see `plan()`'s retry rationale. */
const MAX_PLAN_ATTEMPTS = 3;

export interface TaskComposerPlannerPort {
  /** No-tools answer port, separate from executable plan production. */
  answer_reference?(input: { readonly draft_id: string; readonly task: string; readonly attachments: readonly TaskAttachmentRef[]; readonly signal: AbortSignal }): Promise<{
    readonly text: string | null; readonly error: string | null;
    readonly session_id: string | null; readonly model_identity: string | null; readonly usage: TokenUsageResult;
  }>;
  /** True only for a planner/executor composition that accepts NativeGovernedArtifact media. */
  readonly supports_governed_artifacts?: boolean;
  plan(input: { readonly draft_id: string; readonly task: string; readonly answers: Readonly<Record<string, string>>; readonly answered_questions?: readonly AnsweredTaskComposerQuestion[]; readonly parent_campaign_id: string | null; readonly evidence_ids: readonly string[]; readonly attachments?: readonly TaskAttachmentRef[]; /** ADR-117 §3: the prior attempt's schema-validation error, fed back so the planner can self-correct. Absent on the first attempt and after a transient-transport retry. */ readonly retry_context?: string; readonly signal?: AbortSignal }): Promise<{ readonly raw_proposal: string; readonly session_id: string | null; readonly model_identity: string | null; readonly usage: TokenUsageResult }>;
  /**
   * A cheap delta/patch call against an existing planner session, for when a
   * draft's clarification answers are known and a full replan would repay
   * the entire prompt from scratch. Optional: implementations without
   * session-based patching are supported, and `answer()` falls back to a
   * full `plan()` when this is absent or when the draft has no prior
   * session to patch against.
   */
  patch?(input: { readonly draft_id: string; readonly session_id: string | null; readonly prior_proposal: string; readonly answers: Readonly<Record<string, string>>; readonly newly_answered: Readonly<Record<string, string>>; readonly signal?: AbortSignal }): Promise<{ readonly raw_proposal: string; readonly session_id: string | null; readonly model_identity: string | null; readonly usage: TokenUsageResult }>;
}
export interface AnsweredTaskComposerQuestion { readonly id: string; readonly question: string; readonly answer: string }
export interface TaskComposerAdmissionPort {
  admit(input: { readonly draft_id: string; readonly campaign_id: string; readonly plan_path: string; readonly proposal: TaskComposerProposal; readonly attachments?: readonly TaskAttachmentRef[]; readonly config?: Partial<CampaignConfig>; readonly governance?: ArbiterDecision | null }): Promise<{ readonly campaign_id: string; readonly job_id: string | null }>;
}
export interface TaskComposerOptions {
  readonly manager: CampaignManager;
  readonly planner?: TaskComposerPlannerPort | null;
  /**
   * ADR-062: the cheap arbiter-intake classifier. Absent = every submission
   * falls back to `governed` (byte-identical to pre-ADR-062 behavior) unless
   * the caller passes an explicit `tier_override`.
   */
  readonly arbiter?: ArbiterIntakePort | null;
  readonly attachment_store?: TaskAttachmentStore;
  /** An injected admission port owns the campaign+job transaction when a scheduler is composed. */
  readonly admission?: TaskComposerAdmissionPort;
  readonly persistence_dir?: string;
  readonly clock?: () => string;
  readonly on_change?: (draft: TaskComposerDraft) => void;
}

type Store = { schema_version: 1; drafts: TaskComposerDraft[]; idempotency: Array<[string, { fingerprint: string; draft_id: string }]> };

/**
 * Pre-campaign authority. It never executes model tools itself and it cannot
 * admit a campaign without a confirmed, schema-validated proposal.
 */
export class TaskComposer {
  private readonly drafts = new Map<string, TaskComposerDraft>();
  private readonly idempotency = new Map<string, { fingerprint: string; draft_id: string }>();
  private readonly planning = new Map<string, AbortController>();
  private readonly planner: TaskComposerPlannerPort | null;
  private readonly arbiter: ArbiterIntakePort | null;
  private readonly admission: TaskComposerAdmissionPort;
  private readonly clock: () => string;
  private readonly path: string | null;
  /**
   * ADR-062's `intent-admission.ts`/`intent-lifecycle.ts` — built, tested,
   * but never given a production caller. Wired here: every real submission
   * gets a durable `IntentDecision`/ledger, keyed by a per-attempt intent id
   * (`draftId:revision` at the moment classification runs) so a retried
   * draft gets a fresh ledger rather than illegally reopening a terminal
   * (refused) one.
   */
  private readonly intentLedger: IntentLedgerStore;
  private readonly intentIds = new Map<string, string>();
  /** The most recent per-draft admission state, so a `retry()` after a failed/cancelled attempt opens a genuinely new turn (`resetIntentTurn`) instead of re-creating one from scratch. */
  private readonly intentAdmissionStates = new Map<string, IntentAdmissionState>();

  constructor(private readonly options: TaskComposerOptions) {
    this.planner = options.planner ?? null;
    this.arbiter = options.arbiter ?? null;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.path = options.persistence_dir === undefined ? null : join(options.persistence_dir, "task-composer", "drafts.json");
    this.intentLedger = new IntentLedgerStore(options.persistence_dir ?? null);
    this.admission = options.admission ?? { admit: async (input) => {
      const result = options.manager.admitCampaignPlan({ id: input.campaign_id, plan_path: input.plan_path, root_action: input.proposal.root_action, actions: input.proposal.actions, acceptance_checks: input.proposal.acceptance_checks, ...(input.proposal.acceptance_mapping === undefined ? {} : { acceptance_mapping: input.proposal.acceptance_mapping }), config: input.config, ...(input.governance ? { governance: input.governance } : {}) });
      // ADR-118: build the thrown text from the shared, versioned admission-
      // gate projection (same summary the MCP tool response and CLI failure
      // summary carry for the same refusal) rather than the bare `detail`
      // string, so the draft's `planner.error` a TUI/web reader sees also
      // states the remediation, not only what was denied.
      if (!result.ok) {
        const refusal = projectGateRecord(result.gate, defaultGateRemediation(result.gate.gate));
        throw new Error(`campaign admission gate failed: ${refusal?.summary ?? result.gate.detail} — ${refusal?.remediation ?? "resolve the admission gate deficit and retry"}`);
      }
      return { campaign_id: result.campaign_id, job_id: null };
    } };
    this.restore();
  }

  async dispatch(command: TaskComposerCommand): Promise<TaskComposerDraft> {
    const validated = validateTaskComposerCommand(command); if (!validated.ok) throw new Error(validated.error);
    switch (validated.value.kind) {
      case "taskcomposer.submit": return this.submit(validated.value);
      case "taskcomposer.answer": return this.answer(validated.value);
      case "taskcomposer.confirm": return this.confirm(validated.value);
      case "taskcomposer.cancel": return this.cancel(validated.value);
      case "taskcomposer.retry": return this.retry(validated.value);
      case "taskcomposer.reject": return this.reject(validated.value);
    }
  }

  async submit(input: Extract<TaskComposerCommand, { kind: "taskcomposer.submit" }>): Promise<TaskComposerDraft> {
    const validated = validateTaskComposerCommand(input);
    if (!validated.ok) throw new Error(validated.error);
    if (validated.value.kind !== "taskcomposer.submit") throw new Error("expected taskcomposer.submit");
    input = validated.value;
    const prior = this.idempotency.get(input.idempotency_key); const fingerprint = hash(input);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error(`idempotency key ${input.idempotency_key} names a different task submission`);
      const draft = this.drafts.get(prior.draft_id); if (!draft) throw new Error("task composer idempotency record is corrupt");
      return this.autoAdmit(clone(draft), input.idempotency_key);
    }
    if ((input.attachment_uploads?.length ?? 0) > 0 && input.tier_override !== undefined && input.tier_override !== "governed") throw new Error("task attachments require the governed planning tier");
    if ((input.attachment_uploads?.length ?? 0) > 0 && this.options.attachment_store === undefined) throw new Error("task attachment storage is unavailable");
    if ((input.attachment_uploads?.length ?? 0) > 0 && this.planner?.supports_governed_artifacts !== true) throw new Error("task attachments require an artifact-capable native execution path");
    const attachments = this.options.attachment_store?.capture(input.attachment_uploads ?? [], input.source) ?? [];
    const now = this.clock(); const id = `draft-${randomUUID()}`;
    const draft: TaskComposerDraft = withGuidance({
      id, revision: 1, status: "planning", task: input.task.trim(), source: input.source,
      parent_campaign_id: input.parent_campaign_id ?? null, evidence_ids: [...(input.evidence_ids ?? [])], attachments, proposal: null,
      answered_questions: [],
      planner: unavailablePlanner(this.planner), arbiter_decision: null, campaign_id: null, job_id: null, rejection_reason: null,
      mode: input.mode ?? "execute", reference_answer: null,
      auto_confirm: input.mode === "answer" ? false : input.auto_confirm ?? false, created_at: now, updated_at: now,
      ...(input.command === undefined ? {} : { command: input.command }),
    });
    this.drafts.set(id, draft); this.idempotency.set(input.idempotency_key, { fingerprint, draft_id: id }); this.persistAndEmit(draft);
    const planned = await this.withPlanning(draft.id, (signal) => this.classifyAndPlan(draft, input.tier_override ?? null, signal));
    return this.autoAdmit(planned, input.idempotency_key);
  }

  /**
   * ADR-062 arbiter intake. Runs before the (expensive, multi-action)
   * planner: an explicit `tier_override` records an operator-forced
   * decision and skips the arbiter call entirely; otherwise the cheap
   * arbiter classifier decides. `governed` (the default and the safe
   * fallback on any arbiter failure) proceeds through the unchanged
   * `plan()` planner round trip. `direct`/`reviewed` skip the planner:
   * the arbiter's own minimal single-action output IS the admitted plan —
   * no separate decomposition call.
   */
  private async classifyAndPlan(draft: TaskComposerDraft, tierOverride: GovernanceTier | null, signal: AbortSignal): Promise<TaskComposerDraft> {
    if (draft.mode === "answer") return this.respondToReference(draft, signal);
    let decided = tierOverride
      ? { decision: operatorForcedDecision(tierOverride, this.clock()), category: null as string | null }
      : await classifyGovernanceTier(this.arbiter, { task: draft.task, evidence_ids: draft.evidence_ids, signal }, this.clock);
    if ((draft.attachments?.length ?? 0) > 0 && decided.decision.tier !== "governed") decided = {
      ...decided,
      decision: { ...decided.decision, tier: "governed", rationale: `${decided.decision.rationale}; governed multimodal planning is required for attached media`, turn_budget_estimate: turnBudgetEstimateForTier("governed") },
    };
    // Fold the decision into the SAME persisted revision as the plan result
    // below (a local patch, not a separate `this.update` call) — submit()'s
    // revision-numbering contract (1 = created, 2 = planned) is unchanged by
    // ADR-062; the arbiter's own decision was never a second durable write.
    const requiresPlan = decided.decision.tier === "governed" || requestsDeliberatePlanning(draft.task);
    const admission = this.admitIntent(draft, decided.decision, requiresPlan);
    const withDecision: TaskComposerDraft = { ...draft, arbiter_decision: admission.decision };
    if (signal.aborted) return this.current(draft.id);
    if (admission.refusal !== null) {
      // ADR-062's arbiter never itself refuses — the only genuine refusal
      // this admission gate can produce is a structural one (oversized/empty
      // request, malformed turn) that the composer's own contract validator
      // (task-composer-contracts.ts's `MAX_TEXT`) already keeps out of a real
      // submission today. Failing the draft here (rather than proceeding) is
      // the "operator-visible, never silent" refusal the wiring requires —
      // it just has no path to exercise from `taskcomposer.submit` today.
      return this.update(withDecision, { status: "failed", planner: { kind: "failed", session_id: draft.planner.session_id, model_identity: draft.planner.model_identity, error: `intent admission refused: ${admission.refusal}`, usage: draft.planner.usage } });
    }
    // Risk tier is not permission to discard an explicit planning or
    // clarification prerequisite. Preserve the tier and use the same
    // durable question/answer path governed planning already owns.
    if (requiresPlan) return this.plan(withDecision, signal);
    const validated = validateTaskComposerProposal(buildMinimalProposal(withDecision.task, decided.category ?? "general", admission.decision));
    // Defensive fallback: if the synthesized minimal proposal somehow fails
    // the same schema every planner-produced proposal must pass, fall back
    // to the full planner round trip rather than admit an invalid plan.
    if (!validated.ok) return this.plan(withDecision, signal);
    if (signal.aborted) return this.current(draft.id);
    const proposal = applyCommandBinding(validated.value, withDecision.command);
    this.noteIntentProposed(withDecision.id, proposal, requiresPlan);
    return this.update(withDecision, { status: "proposed", proposal });
  }

  async answer(input: Extract<TaskComposerCommand, { kind: "taskcomposer.answer" }>): Promise<TaskComposerDraft> {
    const draft = this.requireRevision(input.draft_id, input.expected_revision);
    if (draft.mode === "answer") throw new Error("reference answers cannot enter campaign clarification");
    if (draft.status !== "awaiting_clarification" || draft.proposal === null) throw new Error(`draft ${draft.id} is not awaiting clarification`);
    const target = draft.proposal.questions.find((question) => question.id === input.question_id);
    if (!target || target.answer !== null) throw new Error(`question ${input.question_id} is not awaiting an answer`);
    const trimmedAnswer = input.answer.trim();
    const questions = draft.proposal.questions.map((question) => question.id === target.id ? { ...question, answer: trimmedAnswer } : question);
    const answeredQuestions = [...(draft.answered_questions ?? []), { id: target.id, question: target.question, answer: trimmedAnswer, answered_by: "operator" as const, answered_at: this.clock() }];
    const priorProposal = draft.proposal;
    const priorPlanner = draft.planner;
    const updated = this.update(draft, { status: questions.some((question) => question.answer === null) ? "awaiting_clarification" : "planning", proposal: { ...draft.proposal, questions }, answered_questions: answeredQuestions, planner: unavailablePlanner(this.planner, priorPlanner.usage) });
    if (updated.status === "awaiting_clarification") return updated;
    if (this.planner?.patch && priorPlanner.session_id !== null) {
      const answers = Object.fromEntries(questions.filter((question) => question.answer !== null).map((question) => [question.id, question.answer!]));
      const planned = await this.withPlanning(updated.id, (signal) => this.patch(updated, priorPlanner.session_id!, priorProposal, answers, { [target.id]: trimmedAnswer }, signal));
      return this.autoAdmit(planned, `answer:${updated.id}:${updated.revision}`);
    }
    const planned = await this.withPlanning(updated.id, (signal) => this.plan(updated, signal));
    return this.autoAdmit(planned, `answer:${updated.id}:${updated.revision}`);
  }

  async confirm(input: Extract<TaskComposerCommand, { kind: "taskcomposer.confirm" }>): Promise<TaskComposerDraft> {
    const operationKey = `confirm:${input.idempotency_key}`;
    const fingerprint = hash(input);
    const prior = this.idempotency.get(operationKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error(`idempotency key ${input.idempotency_key} names a different admission`);
      const replay = this.drafts.get(prior.draft_id); if (!replay) throw new Error("task composer idempotency record is corrupt");
      return clone(replay);
    }
    const draft = this.requireRevision(input.draft_id, input.expected_revision);
    if (draft.mode === "answer") throw new Error("reference answers cannot be confirmed into campaigns");
    if (draft.status === "admitted") return clone(draft);
    if (draft.status !== "proposed" || draft.proposal === null || draft.proposal.questions.some((question) => question.answer === null)) throw new Error(`draft ${draft.id} is not a confirmable proposal`);
    // A separate key cannot make a second campaign for the same draft; its only
    // authority is the current CAS revision.
    const campaignId = `composer-${draft.id}`;
    try {
      // The composer's own mutation-intent classification runs at
      // plan-materialization time, immediately before admission — never
      // persisted onto the draft's own `proposal` (that stays exactly what
      // the planner produced, for idempotent replay), only onto the actions
      // that actually reach `admission.admit`. A mutating action the
      // planner left unscoped is repaired (mined) or, if nothing is
      // derivable, rejects the plan here — a malformed plan is caught at
      // admission, never stranding a dispatched native specialist on a
      // runtime "action scope missing" it cannot self-correct.
      const materialized = classifyAndRepairMutatingActions(draft.proposal, draft.arbiter_decision?.tier ?? null);
      if (!materialized.ok) throw new Error(materialized.error);
      const admitted = await this.admission.admit({ draft_id: draft.id, campaign_id: campaignId, plan_path: `.arbor/task-composer/${draft.id}.json`, proposal: materialized.value, attachments: draft.attachments ?? [], governance: draft.arbiter_decision });
      const next = this.update(draft, { status: "admitted", campaign_id: admitted.campaign_id, job_id: admitted.job_id, planner: draft.planner });
      this.idempotency.set(operationKey, { fingerprint, draft_id: draft.id }); this.persist();
      this.noteIntentDispatched(draft.id, admitted.job_id ?? admitted.campaign_id, materialized.value.root_action.delegate_to);
      return next;
    } catch (error) {
      this.noteIntentRefused(draft.id, "invalid", safeError(error), true);
      return this.update(draft, { status: "failed", planner: { kind: "failed", session_id: draft.planner.session_id, model_identity: draft.planner.model_identity, error: safeError(error), usage: draft.planner.usage } });
    }
  }

  async reject(input: Extract<TaskComposerCommand, { kind: "taskcomposer.reject" }>): Promise<TaskComposerDraft> {
    const draft = this.requireRevision(input.draft_id, input.expected_revision);
    if (draft.mode === "answer") throw new Error("reference answers have no campaign proposal to reject; cancel a running answer instead");
    if (draft.status === "admitted") throw new Error(`draft ${draft.id} is already admitted`);
    this.noteIntentRefused(draft.id, "policy", input.reason.trim() || "the operator rejected the proposed plan", true);
    return this.update(draft, { status: "rejected", rejection_reason: input.reason.trim() });
  }

  async cancel(input: Extract<TaskComposerCommand, { kind: "taskcomposer.cancel" }>): Promise<TaskComposerDraft> {
    const draft = this.requireRevision(input.draft_id, input.expected_revision);
    if (draft.status !== "planning") throw new Error(`draft ${draft.id} is not planning`);
    this.planning.get(draft.id)?.abort(input.reason.trim());
    this.noteIntentRefused(draft.id, "unavailable", input.reason.trim() || "planning was cancelled", true);
    return this.update(draft, {
      status: "cancelled",
      planner: { kind: "cancelled", session_id: draft.planner.session_id, model_identity: draft.planner.model_identity, error: input.reason.trim(), usage: draft.planner.usage },
    });
  }

  /** Resume a failed/interrupted planning draft without duplicating its identity or lineage. */
  async retry(input: Extract<TaskComposerCommand, { kind: "taskcomposer.retry" }>): Promise<TaskComposerDraft> {
    const operationKey = `retry:${input.idempotency_key}`;
    const fingerprint = hash(input);
    const prior = this.idempotency.get(operationKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error(`idempotency key ${input.idempotency_key} names a different retry`);
      return this.current(prior.draft_id);
    }
    const draft = this.requireRevision(input.draft_id, input.expected_revision);
    if (draft.status !== "failed" && draft.status !== "cancelled") throw new Error(`draft ${draft.id} is not retryable`);
    const retrying = this.update(draft, { status: "planning", reference_answer: null, campaign_id: null, job_id: null, rejection_reason: null, planner: unavailablePlanner(this.planner, draft.planner.usage) });
    this.idempotency.set(operationKey, { fingerprint, draft_id: draft.id }); this.persist();
    const forcedTier = draft.arbiter_decision?.source === "operator_forced" ? draft.arbiter_decision.tier : null;
    const planned = await this.withPlanning(draft.id, (signal) => this.classifyAndPlan(retrying, forcedTier, signal));
    return this.autoAdmit(planned, input.idempotency_key);
  }

  query(query: TaskComposerQuery): TaskComposerDraft | { items: TaskComposerDraft[]; next_cursor: string | null } | null {
    const validated = validateTaskComposerQuery(query); if (!validated.ok) throw new Error(validated.error);
    const accepted = validated.value;
    if (accepted.kind === "taskcomposer.get") return this.get(accepted.draft_id);
    const items = [...this.drafts.values()].filter((draft) => accepted.parent_campaign_id === undefined || draft.parent_campaign_id === accepted.parent_campaign_id).sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id));
    const start = accepted.cursor === undefined ? 0 : Math.max(0, items.findIndex((item) => item.id === accepted.cursor) + 1);
    const page = items.slice(start, start + accepted.limit);
    return { items: page.map(clone), next_cursor: start + page.length < items.length ? page.at(-1)?.id ?? null : null };
  }

  get(id: string): TaskComposerDraft | null { const draft = this.drafts.get(id); return draft === undefined ? null : clone(draft); }

  private async plan(draft: TaskComposerDraft, signal: AbortSignal): Promise<TaskComposerDraft> {
    if (this.planner === null) {
      this.noteIntentRefused(draft.id, "unavailable", "native task planning is not configured", true);
      return this.update(draft, { status: "failed", planner: unavailablePlanner(null, draft.planner.usage) });
    }
    const answeredQuestions = answeredQuestionContext(draft);
    const answers = Object.fromEntries(answeredQuestions.map((question) => [question.id, question.answer]));
    // Retry a transient failure of the underlying provider call itself (the
    // call rejected: network/timeout/5xx) and, per ADR-117 §3, a
    // schema-invalid response (the call resolved but did not parse/
    // validate) — the same bounded re-prompt treatment, feeding the parse
    // error back to the planner as explicit request context so it can
    // self-correct. Both branches consume the same MAX_PLAN_ATTEMPTS
    // budget, so a persistently malformed planner still cannot loop
    // forever; it fails the draft once attempts are exhausted, same as a
    // persistently unreachable provider does today.
    let lastError = "planner produced no result";
    let lastSession: string | null = null;
    let lastModel: string | null = null;
    let usage = draft.planner.usage;
    let retryContext: string | undefined;
    for (let attempt = 1; attempt <= MAX_PLAN_ATTEMPTS; attempt += 1) {
      let result: Awaited<ReturnType<TaskComposerPlannerPort["plan"]>>;
      try {
        result = await this.planner.plan({ draft_id: draft.id, task: draft.task, answers, answered_questions: answeredQuestions, parent_campaign_id: draft.parent_campaign_id, evidence_ids: draft.evidence_ids, attachments: draft.attachments ?? [], retry_context: retryContext, signal });
      } catch (error) {
        if (signal.aborted) return this.current(draft.id);
        // transient_transport: the provider call was rejected, not a bad response. Retry.
        lastError = safeError(error); lastSession = null; lastModel = null;
        continue;
      }
      if (signal.aborted) return this.current(draft.id);
      usage = accumulateUsage(usage, result.usage);
      const parsed = parseTaskComposerProposal(result.raw_proposal);
      if (parsed.ok) {
        const carriedQuestions = carryMatchingAnswers(parsed.value.questions, answeredQuestions);
        const proposal = applyCommandBinding(normalizePlannerDeclaredCommandArgv({ ...parsed.value, questions: carriedQuestions }, draft.task), draft.command);
        const arbiterDecision = draft.arbiter_decision === null ? null : incorporatePlannerWritePaths(draft.arbiter_decision, [proposal.root_action, ...proposal.actions]);
        const proposedStatus = proposal.questions.some((question) => question.answer === null) ? "awaiting_clarification" : "proposed";
        if (proposedStatus === "proposed") this.noteIntentProposed(draft.id, proposal, draft.arbiter_decision?.tier === "governed" || requestsDeliberatePlanning(draft.task));
        return this.update(draft, { status: proposedStatus, proposal, ...(arbiterDecision === null ? {} : { arbiter_decision: arbiterDecision }), planner: { kind: "native", session_id: result.session_id, model_identity: result.model_identity, error: null, usage } });
      }
      // schema_invalid: the response resolved but did not parse/validate.
      // Retryable (ADR-117 §3): carry the parse error into the next
      // attempt's retry_context and consume one of MAX_PLAN_ATTEMPTS,
      // exactly as the transient_transport branch above already does.
      lastError = parsed.error; lastSession = result.session_id; lastModel = result.model_identity;
      retryContext = parsed.error;
      continue;
    }
    this.noteIntentRefused(draft.id, "unavailable", `${lastError} (after ${MAX_PLAN_ATTEMPTS} attempts)`, true);
    return this.update(draft, { status: "failed", planner: { kind: "failed", session_id: lastSession, model_identity: lastModel, error: `${lastError} (after ${MAX_PLAN_ATTEMPTS} attempts)`, usage } });
  }

  private async patch(draft: TaskComposerDraft, sessionId: string, priorProposal: TaskComposerProposal, answers: Readonly<Record<string, string>>, newlyAnswered: Readonly<Record<string, string>>, signal: AbortSignal): Promise<TaskComposerDraft> {
    if (this.planner === null || !this.planner.patch) return this.plan(draft, signal);
    let result: Awaited<ReturnType<NonNullable<TaskComposerPlannerPort["patch"]>>>;
    try {
      result = await this.planner.patch({ draft_id: draft.id, session_id: sessionId, prior_proposal: JSON.stringify(priorProposal), answers, newly_answered: newlyAnswered, signal });
    } catch (error) {
      if (signal.aborted) return this.current(draft.id);
      return this.update(draft, { status: "failed", planner: { kind: "failed", session_id: sessionId, model_identity: draft.planner.model_identity, error: safeError(error), usage: draft.planner.usage } });
    }
    if (signal.aborted) return this.current(draft.id);
    const usage = accumulateUsage(draft.planner.usage, result.usage);
    const parsed = parseTaskComposerProposal(result.raw_proposal);
    if (!parsed.ok) {
      this.noteIntentRefused(draft.id, "unavailable", parsed.error, true);
      return this.update(draft, { status: "failed", planner: { kind: "failed", session_id: result.session_id, model_identity: result.model_identity, error: parsed.error, usage } });
    }
    const carriedQuestions = carryMatchingAnswers(parsed.value.questions, answeredQuestionContext(draft));
    const proposal = applyCommandBinding(normalizePlannerDeclaredCommandArgv({ ...parsed.value, questions: carriedQuestions }, draft.task), draft.command);
    const arbiterDecision = draft.arbiter_decision === null ? null : incorporatePlannerWritePaths(draft.arbiter_decision, [proposal.root_action, ...proposal.actions]);
    const proposedStatus = proposal.questions.some((question) => question.answer === null) ? "awaiting_clarification" : "proposed";
    if (proposedStatus === "proposed") this.noteIntentProposed(draft.id, proposal, draft.arbiter_decision?.tier === "governed" || requestsDeliberatePlanning(draft.task));
    return this.update(draft, { status: proposedStatus, proposal, ...(arbiterDecision === null ? {} : { arbiter_decision: arbiterDecision }), planner: { kind: "native", session_id: result.session_id, model_identity: result.model_identity, error: null, usage } });
  }

  /**
   * ADR-062's real intake gate. Runs `intent-admission.ts`'s
   * `createIntentAdmissionState`/`transitionIntentAdmission` (and
   * `validateIntentAdmission` transitively, through the `"admit"` event)
   * against a real `IntentDecision` projected from the composer's own
   * `ArbiterDecision`, and opens this draft's intent ledger with an
   * `intent.decided` record. See `intent-admission-bridge.ts` for why the
   * projected `classification` is guaranteed to agree with this module's own
   * (private) verb detection.
   *
   * `phase === "refused"` is a genuine, typed, non-silent refusal — the
   * caller fails the draft. `phase === "clarification_required"` does not
   * fail the draft (an explicit-verb requirement over free-form task text
   * would refuse a large fraction of today's valid submissions — see the
   * module doc comment on the call site); it is folded into the returned
   * decision's `rationale`, which is already the operator-visible surface
   * (`taskComposerGuidance`).
   */
  private admitIntent(draft: TaskComposerDraft, decision: ArbiterDecision, requiresPlan: boolean): { decision: ArbiterDecision; refusal: string | null } {
    const intentId = `${draft.id}:${draft.revision}`;
    this.intentIds.set(draft.id, intentId);
    const intentDecision = buildIntentDecision({ intent_id: intentId, task: draft.task, actor_id: draft.source, tier: decision.tier, rationale: decision.rationale, clock: this.clock });
    const decidedRecord: IntentLifecycleRecord = {
      schema_version: intentDecision.schema_version, record_id: `${intentId}:decided`, intent_id: intentId, decision_id: intentDecision.decision_id,
      sequence: 0, occurred_at: this.clock(), actor_id: draft.source, correlation_id: draft.id, phase: "intent", kind: "intent.decided", decision: intentDecision,
    };
    this.intentLedger.append(intentId, decidedRecord);

    const turnId = intentId;
    const priorState = this.intentAdmissionStates.get(draft.id);
    // A retried draft (post `taskcomposer.retry`) already has a prior
    // admission state from its earlier attempt; `resetIntentTurn` is the
    // real turn-local reset intent-admission.ts defines for exactly this —
    // a fresh decision/turn that cannot inherit the previous attempt's
    // blockers. A brand-new draft has no prior state and starts one instead.
    const state0 = priorState ? resetIntentTurn(priorState, intentDecision, turnId) : createIntentAdmissionState(intentDecision, turnId);
    const scope = buildIntentScope({ campaign_scope_value: draft.parent_campaign_id ?? draft.id, write_paths: decision.blast_radius.write_paths });
    const transitioned = transitionIntentAdmission(state0, { kind: "admit", turn_id: turnId, request: draft.task, scope, dependencies: [] });
    if (!transitioned.ok) throw new Error(`intent admission transition failed unexpectedly: ${transitioned.error.code} ${transitioned.error.reason}`);
    const state = transitioned.state;
    this.intentAdmissionStates.set(draft.id, state);
    if (state.phase === "refused") {
      const reasons = state.blockers.map((blocker) => `${blocker.code}: ${blocker.reason}`).join("; ");
      const code: "policy" | "invalid" = state.blockers.some((blocker) => blocker.code === "policy") ? "policy" : "invalid";
      this.noteIntentRefused(draft.id, code, reasons, false);
      return { decision, refusal: reasons };
    }
    if (state.phase === "clarification_required") {
      const reasons = state.blockers.map((blocker) => `${blocker.code}: ${blocker.reason}`).join("; ");
      return { decision: { ...decision, rationale: `${decision.rationale}; intent-admission requests clarification (${reasons})` }, refusal: null };
    }
    void requiresPlan; // reserved for future review/plan-flag cross-checks; admission itself does not branch on it.
    return { decision, refusal: null };
  }

  /** Append `intent.planned` (governed/deliberate-planning tier only) then `intent.reviewed`, once, the first time a draft's proposal is finalized (no unanswered questions remaining). */
  private noteIntentProposed(draftId: string, proposal: TaskComposerProposal, requiresPlan: boolean): void {
    const intentId = this.intentIds.get(draftId);
    if (!intentId) return;
    const ledger = this.intentLedger.get(intentId);
    if (!ledger || ledger.records.at(-1)?.phase !== "intent") return; // already advanced (a re-plan during clarification) or no ledger to extend
    const base = { intent_id: intentId, decision_id: ledger.decision_id, actor_id: "task-composer", correlation_id: draftId } as const;
    let current = ledger;
    if (requiresPlan) {
      const planned: IntentLifecycleRecord = {
        schema_version: current.schema_version, ...base, record_id: `${intentId}:plan`, sequence: current.records.length, occurred_at: this.clock(),
        phase: "plan", kind: "intent.planned",
        plan_id: draftId,
        action_ids: proposal.actions.map((action, index) => (action.description.trim() || `action-${index}`).slice(0, 200)),
        plan_digest: `sha256:${hash(proposal)}`,
      };
      current = this.intentLedger.append(intentId, planned);
    }
    const reviewed: IntentLifecycleRecord = {
      schema_version: current.schema_version, ...base, record_id: `${intentId}:review`, sequence: current.records.length, occurred_at: this.clock(),
      phase: "review", kind: "intent.reviewed", reviewer_id: "task-composer-admission", verdict: "approved",
      rationale: "materialized proposal passed composer admission gate",
    };
    this.intentLedger.append(intentId, reviewed);
  }

  /** Append `intent.dispatched` once, when `confirm()` actually hands the admitted plan to a campaign run. */
  private noteIntentDispatched(draftId: string, operationId: string, agentId: string): void {
    const intentId = this.intentIds.get(draftId);
    if (!intentId) return;
    const ledger = this.intentLedger.get(intentId);
    if (!ledger || ledger.records.at(-1)?.phase !== "review") return;
    const record: IntentLifecycleRecord = {
      schema_version: ledger.schema_version, record_id: `${intentId}:dispatch`, intent_id: intentId, decision_id: ledger.decision_id,
      sequence: ledger.records.length, occurred_at: this.clock(), actor_id: "task-composer", correlation_id: draftId,
      phase: "dispatch", kind: "intent.dispatched", operation_id: operationId, agent_id: agentId, worktree_id: null,
    };
    this.intentLedger.append(intentId, record);
  }

  /** Append `intent.refused`, once, from whatever phase the intent's ledger last reached. A no-op once the ledger is already terminal or was never opened (draft restored from disk with no live admission state). */
  private noteIntentRefused(draftId: string, code: "ambiguous" | "insufficient_scope" | "unauthorized" | "policy" | "stale" | "invalid" | "unavailable", reason: string, retryable: boolean): void {
    const intentId = this.intentIds.get(draftId);
    if (!intentId) return;
    const ledger = this.intentLedger.get(intentId);
    if (!ledger) return;
    const last = ledger.records.at(-1)!;
    if (last.phase === "refusal" || last.phase === "verify") return;
    const record: IntentLifecycleRecord = {
      schema_version: ledger.schema_version, record_id: `${intentId}:refuse`, intent_id: intentId, decision_id: ledger.decision_id,
      sequence: ledger.records.length, occurred_at: this.clock(), actor_id: "task-composer", correlation_id: draftId,
      phase: "refusal", kind: "intent.refused", from_phase: last.phase as Exclude<typeof last.phase, "refusal">,
      refusal: { code, reason: (reason.trim() || "refused").slice(0, 2000), retryable },
    };
    this.intentLedger.append(intentId, record);
  }

  /** Real, queryable read of a draft's durable intent ledger — an operator/tool-visible audit trail of every admission/plan/review/dispatch/refusal outcome on this intake path. */
  getIntentLedger(draftId: string): IntentLedger | null {
    const intentId = this.intentIds.get(draftId);
    return intentId ? this.intentLedger.get(intentId) : null;
  }

  private requireRevision(id: string, expected: number): TaskComposerDraft { const draft = this.drafts.get(id); if (!draft) throw new Error(`draft ${id} was not found`); if (draft.revision !== expected) throw new Error(`draft ${id} revision conflict: expected ${expected}, found ${draft.revision}`); return draft; }
  private current(id: string): TaskComposerDraft { const draft = this.drafts.get(id); if (!draft) throw new Error(`draft ${id} was not found`); return clone(draft); }
  private async respondToReference(draft: TaskComposerDraft, signal: AbortSignal): Promise<TaskComposerDraft> {
    const stale = () => signal.aborted || this.current(draft.id).revision !== draft.revision;
    if (stale()) return this.current(draft.id);
    if (this.planner?.answer_reference === undefined) return this.update(draft, {
      status: "failed", planner: { ...draft.planner, kind: "unavailable", error: "This connector has no enforced read-only answer port. Select a ready native provider; the request was not converted into a campaign." },
    });
    try {
      const result = await this.planner.answer_reference({ draft_id: draft.id, task: draft.task, attachments: draft.attachments ?? [], signal });
      if (stale()) return this.current(draft.id);
      const usage = accumulateUsage(draft.planner.usage, result.usage);
      const error = result.error ?? (typeof result.text !== "string" || !result.text.trim() || result.text.length > 65_536 ? "The read-only provider returned no bounded answer." : null);
      return this.update(draft, {
        status: error === null ? "answered" : "failed",
        reference_answer: error === null ? { text: result.text!, provenance: { tag: "claimed", claimant: "native-reference-answer" } } : null,
        planner: { kind: error === null ? "native" : "failed", session_id: result.session_id, model_identity: result.model_identity, error, usage },
      });
    } catch (error) {
      if (stale()) return this.current(draft.id);
      return this.update(draft, { status: "failed", planner: { ...draft.planner, kind: "failed", error: safeError(error) } });
    }
  }

  private async autoAdmit(draft: TaskComposerDraft, idempotencyKey: string): Promise<TaskComposerDraft> {
    if (draft.mode === "answer") return draft;
    if (draft.auto_confirm !== true || draft.status !== "proposed") return draft;
    return this.confirm({ kind: "taskcomposer.confirm", draft_id: draft.id, expected_revision: draft.revision, idempotency_key: `auto:${hash(idempotencyKey).slice(0, 48)}` });
  }
  private async withPlanning(id: string, run: (signal: AbortSignal) => Promise<TaskComposerDraft>): Promise<TaskComposerDraft> {
    const controller = new AbortController();
    this.planning.set(id, controller);
    try { return await run(controller.signal); }
    finally { if (this.planning.get(id) === controller) this.planning.delete(id); }
  }
  private update(draft: TaskComposerDraft, changes: Partial<TaskComposerDraft>): TaskComposerDraft { const next = Object.freeze(withGuidance({ ...draft, ...changes, revision: draft.revision + 1, updated_at: this.clock() })); this.drafts.set(next.id, next); this.persistAndEmit(next); return clone(next); }
  private persistAndEmit(draft: TaskComposerDraft): void { this.persist(); this.options.on_change?.(clone(draft)); }
  private persist(): void { if (!this.path) return; mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 }); const store: Store = { schema_version: 1, drafts: [...this.drafts.values()], idempotency: [...this.idempotency.entries()] }; const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`; writeFileSync(temporary, `${JSON.stringify(store)}\n`, { encoding: "utf8", mode: 0o600 }); renameSync(temporary, this.path); }
  private restore(): void { if (!this.path || !existsSync(this.path)) return; try { const value = JSON.parse(readFileSync(this.path, "utf8")) as Store; if (value.schema_version !== 1 || !Array.isArray(value.drafts) || !Array.isArray(value.idempotency)) throw new Error("invalid task composer store"); let interrupted = false; for (const draft of value.drafts) { if (!validDraft(draft)) throw new Error("invalid task composer draft"); const legacyAnswers = draft.answered_questions ?? answeredQuestionContext(draft).map((answer) => ({ ...answer, answered_by: "operator" as const, answered_at: draft.updated_at })); const migrated = withGuidance({ ...draft, answered_questions: legacyAnswers, arbiter_decision: draft.arbiter_decision ?? null, auto_confirm: draft.auto_confirm ?? false }); const rehydrated = withGuidance(interruptStalePlanning(migrated, this.clock())); if (rehydrated.status !== draft.status || draft.guidance === undefined || draft.auto_confirm === undefined || draft.answered_questions === undefined) interrupted = true; this.drafts.set(rehydrated.id, Object.freeze(rehydrated)); } for (const entry of value.idempotency) { if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || !entry[1] || typeof entry[1].fingerprint !== "string" || typeof entry[1].draft_id !== "string" || !this.drafts.has(entry[1].draft_id)) throw new Error("invalid task composer idempotency record"); this.idempotency.set(entry[0], entry[1]); } if (interrupted) this.persist(); } catch { this.drafts.clear(); this.idempotency.clear(); const quarantine = `${this.path}.corrupt-${Date.now()}`; try { renameSync(this.path, quarantine); } catch { /* diagnostics must not turn startup into overwrite */ } }
  }
}

function answeredQuestionContext(draft: Pick<TaskComposerDraft, "proposal" | "answered_questions">): AnsweredTaskComposerQuestion[] {
  const durable = (draft.answered_questions ?? []).map(({ id, question, answer }) => ({ id, question, answer }));
  const seen = new Set(durable.map((item) => `${item.id}\0${normalizedQuestion(item.question)}`));
  const legacy = (draft.proposal?.questions ?? []).flatMap((question) => question.answer === null ? [] : [{ id: question.id, question: question.question, answer: question.answer }]);
  return [...durable, ...legacy.filter((item) => !seen.has(`${item.id}\0${normalizedQuestion(item.question)}`))];
}

/**
 * An answer is consent to one displayed question, not to a short identifier
 * the planner may reuse on a later revision. Whitespace-only presentation
 * changes are harmless; any wording change makes the new question unanswered.
 */
function carryMatchingAnswers(questions: readonly TaskComposerProposal["questions"][number][], answered: readonly AnsweredTaskComposerQuestion[]): TaskComposerProposal["questions"] {
  const prior = new Map(answered.map((item) => [item.id, item]));
  return questions.map((question) => {
    const match = prior.get(question.id);
    return { ...question, answer: match !== undefined && normalizedQuestion(match.question) === normalizedQuestion(question.question) ? match.answer : null };
  });
}

function normalizedQuestion(value: string): string { return value.trim().replace(/\s+/g, " "); }

/**
 * Repair one observed planner serialization error without granting new
 * command authority: `["cargo test --quiet"]` becomes
 * `["cargo", "test", "--quiet"]` only when the latter argv was literally
 * mined from the operator's task and both forms join to the same bytes.
 * Arbitrary model-authored shell strings remain untouched and will fail
 * closed at execution.
 */
export function normalizePlannerDeclaredCommandArgv(proposal: TaskComposerProposal, task: string): TaskComposerProposal {
  const declaredScope = extractDeclaredScope(task);
  const exactWritePaths = extractExactWritePaths(task);
  const exactWriteSet = new Set(exactWritePaths);
  const declared = declaredScope.command_argv;
  const atomic = proposal.actions.length === 1;
  const normalizeAction = (action: TaskComposerProposal["root_action"]): TaskComposerProposal["root_action"] => {
    const scope = action.high_risk_tool_scope;
    let changed = false;
    let command_argv = (scope?.command_argv ?? []).map((argv) => {
      // ADR-119: an intent entry (`argv_prefix`/`purpose`, not an array) has
      // no single-string form to repair -- pass it through unchanged.
      if (!Array.isArray(argv) || argv.length !== 1) return argv;
      const replacement = declared.find((candidate) => candidate.join(" ") === argv[0]!.trim());
      if (!replacement) return argv;
      changed = true;
      return replacement;
    });
    // An explicit operator-authored `... exactly <paths>` clause is a closed
    // allowlist, not merely a hint. Narrow planner output to it before adding
    // any omitted operator-declared paths. This can remove authority but can
    // never create authority absent from the operator's own text.
    let write_paths = scope?.write_paths ?? [];
    if (exactWriteSet.size > 0) {
      const narrowed = write_paths.filter((path) => exactWriteSet.has(path));
      if (narrowed.length !== write_paths.length) { write_paths = narrowed; changed = true; }
    }
    if (atomic) {
      const missingPaths = declaredScope.write_paths.filter((path) => !write_paths.includes(path));
      const missingCommands = declared.filter((candidate) => !command_argv.some((argv) => Array.isArray(argv) && argv.join(" ") === candidate.join(" ")));
      if (missingPaths.length > 0) { write_paths = [...write_paths, ...missingPaths]; changed = true; }
      if (missingCommands.length > 0) { command_argv = [...command_argv, ...missingCommands]; changed = true; }
    }
    return changed ? { ...action, high_risk_tool_scope: { write_paths, command_argv } } : action;
  };
  const root_action = normalizeAction(proposal.root_action);
  const actions = proposal.actions.map(normalizeAction);
  const normalized = root_action === proposal.root_action && actions.every((action, index) => action === proposal.actions[index])
    ? proposal
    : { ...proposal, root_action, actions };
  return bindCommandOnlyValidators(normalized);
}

/**
 * Bind a command-only validator's already-declared commands to its immediate
 * mutable prerequisite. This grants no command absent from the admitted plan
 * (the root action already carries the child union), but makes a red command
 * retry the node that can actually correct its own bytes instead of reviving
 * a zero-write validation shell forever.
 */
/** ADR-119: deep-clone one `command_argv` entry, literal or intent, so the result never aliases the source declaration. */
function cloneCommandArgvEntry(entry: HighRiskCommandArgvEntry): HighRiskCommandArgvEntry {
  return isHighRiskCommandIntent(entry) ? { argv_prefix: [...entry.argv_prefix], purpose: entry.purpose } : [...entry];
}

export function bindCommandOnlyValidators(proposal: TaskComposerProposal): TaskComposerProposal {
  const validators = proposal.actions.filter((action) => {
    const scope = action.high_risk_tool_scope;
    return scope !== undefined && scope.write_paths.length === 0 && scope.command_argv.length > 0;
  });
  let changed = false;
  const actions = proposal.actions.map((action) => {
    const scope = action.high_risk_tool_scope;
    if (scope === undefined || scope.write_paths.length === 0 || scope.command_argv.length > 0) return action;
    const inherited = validators.filter((validator) => validator.depends_on?.includes(action.description))
      .flatMap((validator) => validator.high_risk_tool_scope!.command_argv);
    const seen = new Set<string>();
    const commands = inherited.filter((argv) => { const key = JSON.stringify(argv); if (seen.has(key)) return false; seen.add(key); return true; });
    if (commands.length === 0 || commands.length > 32) return action;
    changed = true;
    return { ...action, high_risk_tool_scope: { write_paths: [...scope.write_paths], command_argv: commands.map((argv) => cloneCommandArgvEntry(argv)) } };
  });
  return changed ? { ...proposal, actions } : proposal;
}

/**
 * decisions/ADR-PENDING-native-structured-scope-pre-authorization-and-auto-approve.md:
 * the task composer's own mutation-intent classification of a
 * proposal's EXECUTABLE actions, applied at plan-materialization time —
 * never trusted from planner/model-authored JSON (`validateAction` in
 * task-composer-contracts.ts has no `mutating` field in its schema, so a
 * planner that emits one is rejected as unsupported, not adopted). Each
 * action in `proposal.actions` is classified from its own `description` via
 * `classifyActionMutation` (the same heuristic `arbiter-intake.ts`'s
 * deterministic tier classifier uses). `proposal.root_action` is tagged for
 * audit continuity only and never required to carry a scope: it is the
 * tree's anchor node, not normally dispatched as executable work (see
 * `manager.ts`'s own "root is normally not an executable node" note; the
 * one exception, `admitRootRecoveryForBlockedPlan`'s durable recovery
 * child, still gets scope from the SAME dispatch-time mining fallback
 * `deriveNativeHighRiskToolScope` already applies to every node).
 *
 * A `"mutating"` action that already carries a non-empty
 * `high_risk_tool_scope` (write_paths or command_argv) is left otherwise
 * untouched, but its `scope_provenance` is stamped `"authored"` — this is
 * the one place that knows, at admission time, that the scope arrived
 * already declared rather than being mined here. One that does not is
 * REPAIRED by mining the same declared-scope heuristic
 * `manager.ts`'s `deriveNativeHighRiskToolScope` already uses at dispatch
 * time (`extractDeclaredScope` over the action's own description plus its
 * `acceptance_checks`) — this can only narrow authority to what the
 * action's own text names, never widen it. Only when nothing is derivable
 * does this reject the whole plan with a legible, action-identifying error:
 * a malformed plan is caught here, at admission, instead of stranding a
 * dispatched native specialist mid-session on "action scope missing" with
 * no way to self-correct.
 *
 * `governed` tier (and an absent/unknown tier, the same safe default
 * `classifyGovernanceTier` itself falls back to) is deliberately exempt
 * from the repair-or-reject requirement — actions are still tagged for
 * audit, but never mined or rejected for a missing scope. This mirrors the
 * EXACT tier boundary `deriveNativeHighRiskToolScope` already draws for its
 * own mining fallback: a governed multi-action plan deliberately leaves
 * many actions read-only by omission (the planner's real decomposition
 * intentionally does this), so requiring a mined scope for every
 * mutating-sounding governed action would over-grant write authority the
 * plan never intended and would regress today's governed admission
 * behavior.
 */
export function classifyAndRepairMutatingActions(proposal: TaskComposerProposal, tier: GovernanceTier | null): TaskComposerValidation<TaskComposerProposal> {
  const enforceScope = tier === "direct" || tier === "reviewed";
  const root_action: Action = { ...proposal.root_action, mutating: classifyActionMutation(proposal.root_action.description) };
  const actions: Action[] = [];
  for (const action of proposal.actions) {
    const mutating = classifyActionMutation(action.description);
    const scope = action.high_risk_tool_scope;
    const hasScope = scope !== undefined && (scope.write_paths.length > 0 || scope.command_argv.length > 0);
    if (!enforceScope || mutating === "read_only" || hasScope) {
      // The action already carries whatever scope it carries (possibly
      // none) — stamp its real provenance only when there IS a non-empty
      // scope to stamp; this is the one place that knows the fact.
      const stamped = hasScope ? { ...scope!, scope_provenance: "authored" as const } : scope;
      actions.push({ ...action, mutating, ...(stamped === undefined ? {} : { high_risk_tool_scope: stamped }) });
      continue;
    }
    const mineable = [action.description, ...(action.acceptance_checks ?? [])].join("\n");
    const mined = extractDeclaredScope(mineable);
    if (mined.write_paths.length === 0 && mined.command_argv.length === 0) {
      return { ok: false, error: `action "${action.description}" is mutating but declares no high_risk_tool_scope, and none could be derived from its description or acceptance checks; the plan cannot be admitted` };
    }
    actions.push({ ...action, mutating, high_risk_tool_scope: { write_paths: mined.write_paths, command_argv: mined.command_argv, scope_provenance: "mined" } });
  }
  return { ok: true, value: { ...proposal, root_action, actions } };
}

function validDraft(value: unknown): value is TaskComposerDraft {
  if (typeof value !== "object" || value === null) return false;
  const draft = value as TaskComposerDraft;
  if (draft.mode !== undefined && draft.mode !== "execute" && draft.mode !== "answer") return false;
  if (draft.mode === "answer") {
    if (!["planning", "answered", "failed", "cancelled"].includes(draft.status) || draft.proposal !== null || draft.campaign_id !== null || draft.job_id !== null || draft.auto_confirm === true || draft.command !== undefined || draft.arbiter_decision !== null) return false;
    const answer = draft.reference_answer;
    if (draft.status === "answered") {
      if (!answer || typeof answer.text !== "string" || !answer.text.trim() || answer.text.length > 65_536 || answer.provenance?.tag !== "claimed" || answer.provenance.claimant !== "native-reference-answer") return false;
    } else if (answer != null) return false;
  } else if (draft.status === "answered" || draft.reference_answer != null) return false;
  if (!/^draft-[A-Za-z0-9-]{1,128}$/.test(draft.id) || !Number.isSafeInteger(draft.revision) || draft.revision < 1 || !["planning", "awaiting_clarification", "proposed", "rejected", "cancelled", "admitted", "failed", "answered"].includes(draft.status) || typeof draft.task !== "string" || !["cli", "tui", "web", "ide"].includes(draft.source) || (draft.parent_campaign_id !== null && typeof draft.parent_campaign_id !== "string") || !Array.isArray(draft.evidence_ids) || !draft.evidence_ids.every((id) => typeof id === "string") || !draft.planner || !["native", "unavailable", "cancelled", "failed"].includes(draft.planner.kind)) return false;
  // ADR-062: absent means either a pre-ADR-062 record or one whose submit
  // never reached classification — both legal. When present it must be a
  // well-formed decision; a corrupt record fails closed rather than
  // silently trusting a malformed governance claim.
  if (draft.arbiter_decision !== undefined && draft.arbiter_decision !== null && !isValidArbiterDecision(draft.arbiter_decision)) return false;
  if (draft.answered_questions !== undefined && (!Array.isArray(draft.answered_questions) || draft.answered_questions.some((answer) => typeof answer.id !== "string" || typeof answer.question !== "string" || typeof answer.answer !== "string" || answer.answered_by !== "operator" || typeof answer.answered_at !== "string"))) return false;
  if (draft.command !== undefined && !validateTaskComposerCommand({ kind: "taskcomposer.submit", task: draft.task, source: draft.source, idempotency_key: "restore-validation", command: draft.command }).ok) return false;
  if (draft.proposal === null) return true;
  const cleanAction = (action: Action): Action => {
    const { skill_inputs: _inputs, skill_inputs_provenance: _provenance, ...rest } = action;
    return rest;
  };
  const candidate = { ...draft.proposal, root_action: cleanAction(draft.proposal.root_action), actions: draft.proposal.actions.map(cleanAction), questions: draft.proposal.questions.map((question) => ({ id: question.id, question: question.question })) };
  const commands = draft.command;
  const matchingCommandSkill = commands?.skill_version === undefined || [draft.proposal.root_action, ...draft.proposal.actions].every((action) => action.skill_id === commands.skill_id && action.skill_version === commands.skill_version);
  const matchingCommandInputs = commands?.skill_inputs === undefined || [draft.proposal.root_action, ...draft.proposal.actions].every((action) =>
    JSON.stringify(action.skill_inputs) === JSON.stringify(commands.skill_inputs)
    && action.skill_inputs_provenance?.command_name === commands.name
    && action.skill_inputs_provenance?.command_descriptor_hash === commands.descriptor_hash
    && action.skill_inputs_provenance?.input_hash === commands.skill_inputs_hash);
  return matchingCommandSkill && matchingCommandInputs && draft.proposal.questions.every((question) => question.answer === null || typeof question.answer === "string") && validateTaskComposerProposal(candidate).ok;
}

function withGuidance(draft: TaskComposerDraft): TaskComposerDraft {
  return { ...draft, guidance: taskComposerGuidance(draft) };
}

/** Bounded human narration; canonical state remains the authority. */
export function taskComposerGuidance(draft: TaskComposerDraft): TaskComposerGuidance {
  if (draft.mode === "answer") {
    if (draft.status === "planning") return { kind: "working", headline: "Reading your reference", detail: "Preparing a read-only answer. No campaign or executable plan will be created.", recommendation: "Cancel to stop the answer request.", retryable: false };
    if (draft.status === "answered") return { kind: "ready", headline: "Reference answer", detail: draft.reference_answer?.text ?? "Answer unavailable", recommendation: "This is a model claim, not verified repository state. No campaign was created.", retryable: false };
    if (draft.status === "cancelled") return { kind: "stopped", headline: "Answer stopped", detail: "The read-only request was cancelled without campaign admission.", recommendation: "Retry this draft to ask again with the same references.", retryable: true };
    return { kind: "recovery", headline: "Reference answer unavailable", detail: draft.planner.error ?? "No answer was returned.", recommendation: "Resolve the provider issue, then retry this read-only draft. It cannot become a campaign.", retryable: true };
  }
  const question = draft.proposal?.questions.find((item) => item.answer === null);
  if (draft.status === "planning") return { kind: "working", headline: "Understanding your request", detail: "Revoy is turning your description into bounded work and safety checks.", recommendation: "No action is needed while planning continues.", retryable: false };
  if (draft.status === "awaiting_clarification" && question) return { kind: "question", headline: "One detail is needed", detail: question.question, recommendation: "Answer the question in plain language; Revoy will continue from the same draft.", retryable: true };
  // A stale/malformed status must never manufacture an operator action.  The
  // only source allowed to ask for an answer is an actual unanswered proposal
  // question above; without one, explain the reconciliation state instead.
  if (draft.status === "awaiting_clarification") return { kind: "recovery", headline: "Clarification state is reconciling", detail: "No unanswered planning question is currently available.", recommendation: "Refresh the task state; do not submit an answer until a specific question is shown.", retryable: false };
  if (draft.status === "proposed") return draft.auto_confirm === true
    ? { kind: "working", headline: "Safety checks complete", detail: "The request is ready and will start automatically.", recommendation: "No manual confirmation is required.", retryable: false }
    : { kind: "ready", headline: "Plan ready to review", detail: draft.proposal?.summary ?? draft.task, recommendation: "Confirm to start, or reject and restate the outcome you want.", retryable: true };
  if (draft.status === "admitted") return { kind: "started", headline: "Work started", detail: draft.campaign_id ? `Campaign ${draft.campaign_id} is handling the request.` : "The request passed admission and is running.", recommendation: "Follow progress here; Revoy will surface questions or a verified result.", retryable: false };
  if (draft.status === "cancelled") return { kind: "stopped", headline: "Planning stopped safely", detail: "No new campaign was admitted from this draft.", recommendation: "Describe the task again whenever you are ready.", retryable: true };
  if (draft.status === "rejected") return { kind: "stopped", headline: "Plan declined", detail: draft.rejection_reason ?? "The proposal was not accepted.", recommendation: "Restate the desired outcome and any constraint that should change.", retryable: true };
  const error = draft.planner.error ?? "The request could not be prepared.";
  if (draft.planner.kind === "unavailable") return { kind: "recovery", headline: "Planning is not connected", detail: "Revoy kept the project unchanged because no planning provider is available.", recommendation: "Run `arbor doctor`, resolve the provider recommendation, then submit the same request again.", retryable: true };
  if (/restart|interrupted/i.test(error)) return { kind: "recovery", headline: "Planning was interrupted", detail: "Revoy recovered the same draft without replaying uncertain work.", recommendation: "Retry this draft to continue safely with the same identity and lineage.", retryable: true };
  if (/admission gate|could not be submitted|could not start|runner is configured/i.test(error)) return { kind: "recovery", headline: "Safety checks stopped the run", detail: error, recommendation: "Resolve the named project condition, then retry this draft. No campaign remains admitted from the failed attempt.", retryable: true };
  // ADR-113 (gate failures carry a remedy) applied to classifyAndRepairMutatingActions's
  // own admission-time refusal: this is not a provider/environment problem
  // `arbor doctor` can diagnose -- it is a plan Revoy refused to admit
  // because the action is mutating and neither an authored high_risk_tool_scope
  // nor the mining fallback (extractDeclaredScope over description +
  // acceptance_checks) found a concrete write target or command in the
  // operator's own text. The one thing that resolves it is the operator
  // naming that target, so say so instead of pointing at a diagnostic that
  // will report nothing wrong.
  if (/is mutating but declares no high_risk_tool_scope/.test(error)) return { kind: "recovery", headline: "Revoy needs to know exactly what to write or run", detail: error, recommendation: "Name the exact files to create or edit (for example: create src/pages/index.astro and src/pages/about.astro), or the exact command to run (for example: run npm create astro@latest), then submit the same request again with that detail added.", retryable: true };
  return { kind: "recovery", headline: "Revoy could not prepare this request", detail: error, recommendation: "Check `arbor doctor`, then retry. If it repeats, keep the draft id when reporting the problem.", retryable: true };
}
/** Structural check mirroring `persist.ts`'s campaign-level `isArbiterDecision` — this store is a separate persistence artifact. */
function isValidArbiterDecision(value: unknown): value is ArbiterDecision {
  if (typeof value !== "object" || value === null) return false;
  const decision = value as Record<string, unknown>;
  if (decision.tier !== "direct" && decision.tier !== "reviewed" && decision.tier !== "governed") return false;
  if (typeof decision.rationale !== "string" || decision.rationale.length === 0) return false;
  if (decision.source !== "arbiter" && decision.source !== "operator_forced") return false;
  if (typeof decision.decided_at !== "string") return false;
  const blast = decision.blast_radius as Record<string, unknown> | undefined;
  if (typeof blast !== "object" || blast === null) return false;
  if (blast.reversibility !== "reversible" && blast.reversibility !== "irreversible" && blast.reversibility !== "unknown") return false;
  // E-2: additive, optional turn-budget estimate.
  return decision.turn_budget_estimate === undefined || (Number.isSafeInteger(decision.turn_budget_estimate) && (decision.turn_budget_estimate as number) > 0);
}

function unavailablePlanner(planner: TaskComposerPlannerPort | null, priorUsage: TokenUsageResult = initialUsage()): TaskComposerPlannerProjection { return { kind: planner === null ? "unavailable" : "native", session_id: null, model_identity: null, error: planner === null ? "native task planning is not configured" : null, usage: priorUsage }; }
const INITIAL_USAGE_REASON = "no planning call has completed for this draft yet";
function initialUsage(): TokenUsageResult { return { kind: "unavailable", reason: INITIAL_USAGE_REASON }; }
function isUsageUnavailable(usage: TokenUsageResult): usage is { kind: "unavailable"; reason: string } { return "kind" in usage && usage.kind === "unavailable"; }
/** Sums token usage across successive planner calls for one draft; never silently drops an `unavailable` reason. */
function accumulateUsage(prior: TokenUsageResult, next: TokenUsageResult): TokenUsageResult {
  if (isUsageUnavailable(prior) && prior.reason === INITIAL_USAGE_REASON) return next;
  if (isUsageUnavailable(prior) || isUsageUnavailable(next)) {
    const reasons = [isUsageUnavailable(prior) ? prior.reason : null, isUsageUnavailable(next) ? next.reason : null].filter((reason): reason is string => reason !== null);
    return { kind: "unavailable", reason: reasons.join("; ") };
  }
  return {
    input_tokens: prior.input_tokens + next.input_tokens,
    output_tokens: prior.output_tokens + next.output_tokens,
    cached_input_tokens: prior.cached_input_tokens + next.cached_input_tokens,
    cache_write_input_tokens: prior.cache_write_input_tokens + next.cache_write_input_tokens,
    counter_source: prior.counter_source === "provider_counter" && next.counter_source === "provider_counter" ? "provider_counter" : "character_fallback",
  };
}
/**
 * A `"planning"` draft found at restore has no live promise behind it — the
 * process died mid-call. There is no live session to safely resume against
 * from a cold restart, so terminate it into the existing `"failed"` status
 * (rather than leaving an infinite spinner) with an error that tells the
 * operator this was an interruption, not a planner rejection, so they know
 * to resubmit.
 */
function interruptStalePlanning(draft: TaskComposerDraft, now: string): TaskComposerDraft {
  const usage = draft.planner?.usage ?? initialUsage();
  if (draft.status !== "planning") return draft.planner?.usage === undefined ? { ...draft, planner: { ...draft.planner, usage } } : draft;
  return {
    ...draft,
    status: "failed",
    planner: { kind: "failed", session_id: draft.planner.session_id, model_identity: draft.planner.model_identity, error: "planning was interrupted by a process restart; resubmit to retry", usage },
    revision: draft.revision + 1,
    updated_at: now,
  };
}
/**
 * ADR-114 Decision §1: the tier a bare, brand-new-intent quick submission
 * resolves to when the operator names no explicit tier — "direct", matching
 * what the operator hand-supplied every run in the ADR's Context, never the
 * arbiter classifier `arbor task`'s own bare submit runs by default. This is
 * the single resolution point both `arbor greenfield`'s CLI dispatch
 * (`greenfieldCommand`, cli.ts) and the Console input strip's TUI dispatch
 * (ADR-124, tui.ts) read, so the two surfaces cannot silently drift onto
 * different defaults for the identical shape of request.
 */
export const GREENFIELD_DEFAULT_TIER: GovernanceTier = "direct";

/** ADR-062: an operator `--tier` override is recorded distinctly from an arbiter classification — never masquerading as one. */
function operatorForcedDecision(tier: GovernanceTier, now: string): ArbiterDecision {
  return { tier, rationale: "operator-forced via --tier", blast_radius: { reversibility: "unknown" }, source: "operator_forced", decided_at: now, turn_budget_estimate: turnBudgetEstimateForTier(tier) };
}

/**
 * ADR-062: the arbiter's own minimal single-action output serves as the
 * admitted plan for `direct`/`reviewed` tiers — no separate planning round
 * trip. `estimated_gain`/`estimated_cost` are nominal (1/1): a single-action
 * plan has no siblings for UCT to compare against, so these values are never
 * read by the loop's selection logic for a `direct_single_action` strategy.
 */
/**
 * WA-32/J3-20: apply the invoking command's structured role and exact skill
 * request onto the proposal's actions. Explicit positional command arguments
 * reach skill inputs only through the operator-authored argument mapping and
 * retain hashes of both the immutable command descriptor and supplied values.
 * `allowed_tools` remains a non-authoritative hint; the executor intersects
 * skill restrictions with its actual composed capabilities.
 */
function applyCommandBinding(proposal: TaskComposerProposal, command: TaskComposerCommandBinding | undefined): TaskComposerProposal {
  if (command === undefined) return proposal;
  const stamp = (action: Action): Action => ({
    ...action,
    ...(command.execution_role === "architect" || command.execution_role === "documentation-writer" ? { execution_role: command.execution_role } : {}),
    ...(command.skill_id === null || command.skill_version === undefined ? {} : { skill_id: command.skill_id, skill_version: command.skill_version }),
    ...(command.skill_inputs === undefined ? {} : {
      skill_inputs: command.skill_inputs,
      skill_inputs_provenance: { tag: "claimed" as const, claimant: "cli-command" as const, command_name: command.name, command_descriptor_hash: command.descriptor_hash!, input_hash: command.skill_inputs_hash! },
    }),
  });
  return { ...proposal, root_action: stamp(proposal.root_action), actions: proposal.actions.map(stamp) };
}

function buildMinimalProposal(task: string, category: string, decision: ArbiterDecision): TaskComposerProposal {
  const blast: ArbiterBlastRadius = decision.blast_radius;
  const hasScope = (blast.write_paths?.length ?? 0) > 0 || (blast.command_argv?.length ?? 0) > 0;
  const rootAction: Action = {
    description: task,
    estimated_gain: 1,
    estimated_cost: 1,
    category,
    delegate_to: "seed",
    ...(hasScope ? { high_risk_tool_scope: { write_paths: [...(blast.write_paths ?? [])], command_argv: (blast.command_argv ?? []).map((argv) => [...argv]) } } : {}),
  };
  return {
    summary: task,
    assumptions: [],
    questions: [],
    root_action: rootAction,
    actions: [rootAction],
    acceptance_checks: [],
    acceptance_mapping: [],
    risk_notes: [decision.rationale],
  };
}

function clone<T>(value: T): T { return structuredClone(value); }
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function safeError(error: unknown): string { return error instanceof Error ? error.message.slice(0, 1_024) : "task planning failed"; }
