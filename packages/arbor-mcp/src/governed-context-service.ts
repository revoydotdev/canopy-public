import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicOverwriteFile } from "@arbor/audit";
import type {
  ContextArtifactRef,
  ContextWorkspaceView,
  FoldProposal,
  FoldRecord,
  GovernedContextOverlays,
  HarnessRevision,
  PlaybookDelta,
  RevisionEvaluation,
  MessageRangeRef,
  NonExecutableSubagentDescriptor,
  DeclarativeSubagentExecution,
  HarnessEvaluationRun,
} from "@arbor/core";
import { isAllowedHarnessComponent } from "@arbor/core";
import { checkFoldActivation, checkHarnessActivation, checkHarnessPromotion } from "@arbor/gate";

interface PersistedContextState {
  schema_version: 1;
  artifacts: Array<{ ref: ContextArtifactRef; content: string }>;
  folds: FoldRecord[];
  playbook: PlaybookDelta[];
  revisions: HarnessRevision[];
  executions: DeclarativeSubagentExecution[];
  evaluation_runs: HarnessEvaluationRun[];
}

/**
 * WA-30: one structurally-invalid or unparseable record dropped during the
 * last `restore()`. A dropped record is never silently discarded — it is
 * individually reported here so an operator diagnostics surface (`doctor.get`)
 * can distinguish "nothing to restore" from "restore silently lost state".
 */
export interface GovernedContextRestoreDiagnostic {
  readonly kind: "file" | "artifact" | "fold" | "playbook" | "harness_revision" | "subagent_execution" | "evaluation_run";
  readonly id: string | null;
  readonly reason: string;
}

const EMPTY_EVALUATION: RevisionEvaluation = {
  outcome: "not_yet_measured", fidelity_ratio: null, main_model_tokens: null,
  child_model_tokens: null, latency_ms: null, regression_detected: false,
  rollback_count: 0, replay_evidence_ids: [], holdout_evidence_ids: [],
};

/** Structural port over the existing durable conversation bus; this service never records or owns messages. */
export interface DurableMessageEvidencePort {
  hasMessageRange(campaign_id: string, range: MessageRangeRef): boolean;
}

/**
 * The bounded, enactable result of one campaign-loop checkpoint.  It is a
 * projection over durable records, not another authority or an executor API.
 * Retrieval policy and descriptors are deliberately reported as unapplied
 * until an isolated executor has a typed implementation for them.
 */
export interface GovernedOverlayCheckpointProjection {
  checkpoint_at: string;
  specialist_context: readonly string[];
  critic_context: readonly string[];
  specialist_prompt_fragments: readonly string[];
  critic_prompt_fragments: readonly string[];
  applied_overlay_ids: readonly string[];
  unapplied_overlays: readonly { id: string; reason: string }[];
}

/**
 * Isolated retrieval is allowed to return only references to artifacts this
 * service already owns. It cannot inject bytes, tools, or an arbitrary index
 * result into a campaign prompt.
 */
export interface IsolatedRetrievalIndexAdapter {
  retrieve(input: { campaign_id: string; node_id: string; revision_id: string; index_ids: readonly string[]; max_results: number }): readonly { artifact_id: string }[];
}

/**
 * A descriptor adapter may prepare bounded context references for a declared
 * sub-agent role; it cannot spawn, delegate, execute code, or grant tools.
 */
export interface DeclarativeSubagentAdapter {
  prepare(input: { campaign_id: string; node_id: string; revision_id: string; descriptor: NonExecutableSubagentDescriptor }): { artifact_ids: readonly string[] };
}

export interface GovernedOverlayAdapters {
  readonly capabilities: ReadonlySet<"context.retrieve" | "subagent.describe">;
  readonly retrieval_index?: IsolatedRetrievalIndexAdapter;
  readonly declarative_subagent?: DeclarativeSubagentAdapter;
}

/**
 * Durable, bounded data-plane for governed context/harness evolution.
 *
 * It intentionally exposes no evaluator, REPL, shell, or mutable base prompt.
 * The service owns content-addressed raw artifacts and derived, rollbackable
 * campaign overlays; execution remains an optional isolated adapter elsewhere.
 */
export class GovernedContextService {
  private readonly artifacts = new Map<string, { ref: ContextArtifactRef; content: string }>();
  private readonly folds = new Map<string, FoldRecord>();
  private readonly playbook = new Map<string, PlaybookDelta>();
  private readonly revisions = new Map<string, HarnessRevision>();
  private readonly executions = new Map<string, DeclarativeSubagentExecution>();
  private readonly evaluationRuns = new Map<string, HarnessEvaluationRun>();
  private readonly path: string | null;
  private readonly restoreDiagnosticsList: GovernedContextRestoreDiagnostic[] = [];

  constructor(options: { persistence_dir?: string; message_evidence?: DurableMessageEvidencePort; critic_actor?: string; clock?: () => string; adapters?: GovernedOverlayAdapters } = {}) {
    this.path = options.persistence_dir ? join(options.persistence_dir, "governed-context", "state.json") : null;
    this.messageEvidence = options.message_evidence ?? null;
    this.criticActor = options.critic_actor ?? "lenticel";
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.adapters = options.adapters ?? null;
    this.restore();
  }
  private readonly messageEvidence: DurableMessageEvidencePort | null;
  private readonly criticActor: string;
  private readonly clock: () => string;
  private readonly adapters: GovernedOverlayAdapters | null;

  captureArtifact(input: Omit<ContextArtifactRef, "id" | "sha256" | "byte_length"> & { content: string }): ContextArtifactRef {
    const bytes = Buffer.from(input.content, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const id = `ctx_${sha256}`;
    const ref: ContextArtifactRef = { ...input, id, sha256, byte_length: bytes.byteLength };
    const existing = this.artifacts.get(id);
    if (existing && existing.content !== input.content) throw new Error(`content-address collision for ${id}`);
    this.artifacts.set(id, { ref, content: input.content });
    this.persist();
    return ref;
  }

  /** WA-30: records individually dropped or a whole file rejected on the last `restore()`. */
  restoreDiagnostics(): readonly GovernedContextRestoreDiagnostic[] { return [...this.restoreDiagnosticsList]; }

  /** Bounded read-only access. The caller cannot execute, mutate, or enumerate arbitrary filesystem state. */
  readWorkspace(input: { artifact_id: string; offset?: number; max_bytes?: number; visibility: ContextArtifactRef["visibility"] }): ContextWorkspaceView {
    const stored = this.artifacts.get(input.artifact_id);
    if (!stored) throw new Error(`context artifact ${input.artifact_id} was not found`);
    if (stored.ref.visibility === "critic_only" && input.visibility !== "critic_only") throw new Error("context artifact requires critic visibility");
    const offset = Math.max(0, input.offset ?? 0);
    const max = Math.min(65_536, Math.max(1, input.max_bytes ?? 8_192));
    const content = Buffer.from(stored.content, "utf8").subarray(offset, offset + max).toString("utf8");
    return { artifact: stored.ref, offset, content, truncated: offset + Buffer.byteLength(content, "utf8") < stored.ref.byte_length };
  }

  proposeFold(proposal: FoldProposal): FoldRecord {
    if (!proposal.task_id.trim()) throw new Error("fold proposal requires a task identity");
    this.requireValidLifetime(proposal);
    this.requireArtifact(proposal.output_artifact.id, proposal.campaign_id);
    for (const ref of proposal.omitted_artifacts) this.requireArtifact(ref.id, proposal.campaign_id);
    if (proposal.source_event_ids.length === 0 || proposal.source_message_ranges.length === 0 || proposal.retained_claims.length === 0) throw new Error("fold proposal requires source events, message ranges and retained claims");
    this.requireMessageRanges(proposal.campaign_id, proposal.source_message_ranges);
    if (proposal.measures.expected_token_savings < 0) throw new Error("fold expected token savings must be non-negative");
    const record: FoldRecord = { ...proposal, status: "proposed" };
    this.folds.set(record.id, record); this.persist(); return record;
  }

  approveFold(id: string, approver: string, fidelity_ratio: number): FoldRecord {
    const record = this.required(this.folds, id, "fold");
    if (isExpired(record, this.clock())) throw new Error("expired fold may not activate");
    this.requireCritic(approver);
    const gate = checkFoldActivation({ proposal: record, approver, fidelity_ratio });
    if (gate.result !== "pass") throw new Error(gate.detail);
    const active: FoldRecord = { ...record, status: "active", approved_by: approver, approved_at: new Date().toISOString(), measures: { ...record.measures, fidelity_ratio } };
    this.folds.set(id, active); this.persist(); return active;
  }

  rollbackFold(id: string, actor: string): FoldRecord {
    const record = this.required(this.folds, id, "fold");
    if (record.status !== "active") throw new Error("only active folds may be rolled back");
    const rolled: FoldRecord = { ...record, status: "rolled_back", rollback_of: `${actor}:${new Date().toISOString()}` };
    this.folds.set(id, rolled); this.persist(); return rolled;
  }

  proposePlaybook(delta: Omit<PlaybookDelta, "status">): PlaybookDelta {
    if (!delta.task_id.trim()) throw new Error("playbook delta requires a task identity");
    this.requireValidLifetime(delta);
    if (delta.source_event_ids.length === 0 || delta.source_message_ranges.length === 0 || !delta.observed_outcome.trim()) throw new Error("playbook delta requires source evidence, message ranges and observed outcome");
    this.requireMessageRanges(delta.campaign_id, delta.source_message_ranges);
    const record: PlaybookDelta = { ...delta, status: "proposed" };
    this.playbook.set(record.id, record); this.persist(); return record;
  }

  approvePlaybook(id: string, approver: string): PlaybookDelta {
    const record = this.required(this.playbook, id, "playbook delta");
    if (isExpired(record, this.clock())) throw new Error("expired playbook delta may not activate");
    this.requireCritic(approver);
    if (record.proposed_by === approver) throw new Error("playbook proposer may not approve its own delta");
    const active: PlaybookDelta = { ...record, status: "active", approved_by: approver, approved_at: new Date().toISOString() };
    this.playbook.set(id, active); this.persist(); return active;
  }

  proposeRevision(revision: Omit<HarnessRevision, "status" | "evaluation"> & { evaluation?: RevisionEvaluation }): HarnessRevision {
    const record: HarnessRevision = { ...revision, status: "proposed", evaluation: revision.evaluation ?? { ...EMPTY_EVALUATION } };
    if (!record.task_id.trim()) throw new Error("harness revision requires a task identity");
    this.requireValidLifetime(record);
    if (!isAllowedHarnessComponent(record.component)) throw new Error(`harness component ${record.component} is forbidden`);
    if (record.source_event_ids.length === 0 || record.source_message_ranges.length === 0) throw new Error("harness revision requires source evidence and durable message ranges");
    this.requireMessageRanges(record.campaign_id, record.source_message_ranges);
    if (record.component === "subagent_descriptor") this.requireNonExecutableDescriptor(record.campaign_id, record.patch);
    if (record.component === "supplemental_prompt" && !readGuidance(record.patch)) throw new Error("supplemental prompt requires a typed guidance fragment");
    if (record.component === "retrieval_policy") this.requireRetrievalPolicy(record.patch);
    this.revisions.set(record.id, record); this.persist(); return record;
  }

  approveRevision(id: string, approver: string): HarnessRevision {
    const record = this.required(this.revisions, id, "harness revision");
    if (isExpired(record, this.clock())) throw new Error("expired harness revision may not activate");
    this.requireCritic(approver);
    const gate = checkHarnessActivation({ revision: record, approver });
    if (gate.result !== "pass") throw new Error(gate.detail);
    const active: HarnessRevision = { ...record, status: "active", approved_by: approver, approved_at: new Date().toISOString() };
    this.revisions.set(id, active); this.persist(); return active;
  }

  /**
   * Legacy/manual observation compatibility only.  It deliberately cannot
   * name an evaluator or retain a prior evaluator identity: a caller-shaped
   * observation is useful for auditing, but is not a hermetic evaluation
   * authority and must never make a revision promotable.
   *
   * Canonical measured results are written exclusively by `settleEvaluation`
   * after it has bound them to a durable `HarnessEvaluationRun`.
   */
  recordEvaluation(id: string, evaluation: RevisionEvaluation): HarnessRevision {
    const record = this.required(this.revisions, id, "harness revision");
    const { evaluation_by: _discardedEvaluator, ...withoutEvaluator } = record;
    const next: HarnessRevision = { ...withoutEvaluator, evaluation: { ...evaluation, rollback_count: record.evaluation.rollback_count } };
    this.revisions.set(id, next); this.persist(); return next;
  }

  /** Read-only revision identity for isolated evaluators; never an activation authority. */
  getRevision(id: string): HarnessRevision | null { return this.revisions.get(id) ?? null; }

  startEvaluation(input: { id: string; revision_id: string; requested_by: string; evaluator_id: string }): HarnessEvaluationRun {
    const revision = this.required(this.revisions, input.revision_id, "harness revision");
    if (revision.status !== "active" || !input.requested_by.trim() || !input.evaluator_id.trim()) throw new Error("evaluation requires an active revision and named evaluator");
    const existing = this.evaluationRuns.get(input.id); if (existing) return existing;
    if ([...this.evaluationRuns.values()].some((run) => run.revision_id === input.revision_id && run.state === "running")) {
      throw new Error("a hermetic evaluation is already running for this revision");
    }
    const run: HarnessEvaluationRun = { ...input, campaign_id: revision.campaign_id, requested_at: this.clock(), state: "running", evidence_ids: [] };
    this.evaluationRuns.set(run.id, run); this.persist(); return run;
  }
  settleEvaluation(id: string, input: { kind: "measured" | "unmeasured"; evaluation?: RevisionEvaluation; evidence_ids?: readonly string[]; detail?: readonly Record<string, unknown>[]; reason?: string }): HarnessEvaluationRun {
    const run = this.required(this.evaluationRuns, id, "harness evaluation run"); if (run.state !== "running") return run;
    if (input.kind === "measured" && (!input.evaluation || !validEvaluation(input.evaluation) || input.evaluation.outcome === "not_yet_measured" || !input.evidence_ids?.length || !this.validMeasuredEvaluationEvidence(run, input.evidence_ids, input.evaluation))) throw new Error("invalid measured hermetic evaluation result");
    if (input.detail?.some((row) => Buffer.byteLength(JSON.stringify(row), "utf8") > 4_096 || /(?:secret|api[_-]?key|token)=/i.test(JSON.stringify(row)))) throw new Error("evaluation detail is oversized or contains secret-like content");
    if (input.kind === "measured" && input.evaluation) this.recordMeasuredEvaluation(run, input.evaluation);
    const next: HarnessEvaluationRun = { ...run, state: input.kind, ...(input.evaluation ? { evaluation: input.evaluation } : {}), evidence_ids: [...(input.evidence_ids ?? [])], ...(input.detail ? { detail: input.detail.slice(0, 32) } : {}), ...(input.reason ? { reason: input.reason.slice(0, 512) } : {}), completed_at: this.clock() };
    this.evaluationRuns.set(id, next); this.persist(); return next;
  }
  failEvaluation(id: string, reason: string): HarnessEvaluationRun { return this.settleEvaluation(id, { kind: "unmeasured", reason }); }
  listEvaluationRuns(campaignId: string): readonly HarnessEvaluationRun[] { return [...this.evaluationRuns.values()].filter((run) => run.campaign_id === campaignId).sort((a,b) => b.requested_at.localeCompare(a.requested_at)); }
  getEvaluationRun(id: string): HarnessEvaluationRun | null { return this.evaluationRuns.get(id) ?? null; }
  quarantineRevision(id: string, actor: string, reason: string, evidence_ids: readonly string[]): HarnessRevision {
    const record = this.required(this.revisions, id, "harness revision");
    if (record.status !== "active") throw new Error("only active harness revisions may be quarantined");
    if (!actor.trim() || !reason.trim() || evidence_ids.length === 0) throw new Error("quarantine requires an independent actor, reason, and evaluation evidence");
    if (actor === record.proposed_by || actor === record.approved_by) throw new Error("quarantine decision maker must be independent of proposer and activator");
    const measured = [...this.evaluationRuns.values()].filter((run) => run.revision_id === id && run.state === "measured" && run.evaluation !== undefined
      && this.validMeasuredEvaluationEvidence(run, run.evidence_ids, run.evaluation));
    const evidenceRuns = evidence_ids.map((evidence) => measured.find((run) => run.evidence_ids.includes(evidence)) ?? null);
    if (evidenceRuns.some((run) => run === null)) throw new Error("quarantine evidence must belong to a settled measured evaluation for this revision");
    // The evaluator identity comes from the run whose evidence was selected,
    // not from the mutable revision projection. A manual observation clears
    // that projection but must not let the evaluator self-quarantine.
    if (evidenceRuns.some((run) => run!.evaluator_id === actor)) throw new Error("quarantine decision maker must be independent of the selected evaluator");
    const next: HarnessRevision = { ...record, status: "quarantined", quarantine: { decided_by: actor, reason: reason.slice(0, 512), evidence_ids: [...evidence_ids], decided_at: this.clock() } };
    this.revisions.set(id, next); this.persist(); return next;
  }

  rollbackRevision(id: string, actor: string): HarnessRevision {
    const record = this.required(this.revisions, id, "harness revision");
    if (record.status !== "active") throw new Error("only active harness revisions may be rolled back");
    const rolled: HarnessRevision = { ...record, status: "rolled_back", rollback_of: `${actor}:${new Date().toISOString()}`, evaluation: { ...record.evaluation, rollback_count: record.evaluation.rollback_count + 1 } };
    this.revisions.set(id, rolled); this.persist(); return rolled;
  }

  promoteRevision(id: string, human_approver: string): HarnessRevision {
    const record = this.required(this.revisions, id, "harness revision");
    // Revision fields are projections and may include a legacy/manual
    // observation.  Promotion authority is the latest durable measured run,
    // whose evidence is revalidated against this exact revision every time.
    const run = this.latestMeasuredEvaluationRun(id);
    if (!run || !run.evaluation || !this.validMeasuredEvaluationEvidence(run, run.evidence_ids, run.evaluation)) {
      throw new Error("promotion requires a durable measured hermetic evaluation run with bound evidence");
    }
    // A subsequent legacy/manual observation intentionally clears the
    // revision's evaluator projection.  Do not resurrect the older run: the
    // operator must request a fresh canonical evaluation after any conflicting
    // observation before promotion can proceed.
    if (record.evaluation_by !== run.evaluator_id || !sameEvaluation(record.evaluation, run.evaluation)) {
      throw new Error("promotion requires the current canonical evaluation projection from its measured run");
    }
    if (human_approver === run.evaluator_id) throw new Error("human promoter must be distinct from evaluator");
    const gate = checkHarnessPromotion({ revision: { ...record, evaluation: run.evaluation, evaluation_by: run.evaluator_id }, human_approver });
    if (gate.result !== "pass") throw new Error(gate.detail);
    const promoted: HarnessRevision = { ...record, evaluation: run.evaluation, evaluation_by: run.evaluator_id, promotion: { approved_by_human: human_approver, approved_at: new Date().toISOString() } };
    this.revisions.set(id, promoted); this.persist(); return promoted;
  }

  /**
   * Persist the dispatch claim before a separately composed native child can
   * start.  This is deliberately one child per active descriptor/node pair:
   * a descriptor cannot become an unbounded or recursive spawn mechanism.
   */
  requestSubagentExecution(input: {
    id: string; campaign_id: string; parent_node_id: string; revision_id: string;
    requested_by: string; child_session_id: string; worktree_node_id: string;
  }): DeclarativeSubagentExecution {
    const revision = this.required(this.revisions, input.revision_id, "harness revision");
    if (revision.campaign_id !== input.campaign_id || revision.component !== "subagent_descriptor" || revision.status !== "active" || isExpired(revision, this.clock())) {
      throw new Error("declarative subagent execution requires an active independently approved descriptor revision");
    }
    const descriptor = revision.patch.descriptor as NonExecutableSubagentDescriptor;
    this.requireNonExecutableDescriptor(input.campaign_id, revision.patch);
    if (descriptor.max_children !== 1) throw new Error("v1 declarative subagent execution requires max_children exactly 1");
    if (!input.id.trim() || !input.parent_node_id.trim() || !input.requested_by.trim() || !input.child_session_id.trim() || !input.worktree_node_id.trim()) throw new Error("declarative subagent execution requires stable identity and lineage");
    const existing = this.executions.get(input.id);
    if (existing) return existing;
    const duplicate = [...this.executions.values()].find((execution) => execution.campaign_id === input.campaign_id
      && execution.parent_node_id === input.parent_node_id && execution.revision_id === input.revision_id);
    if (duplicate) return duplicate;
    const execution: DeclarativeSubagentExecution = Object.freeze({
      ...input, revision_created_at: revision.created_at, requested_at: this.clock(), state: "requested", evidence_ids: Object.freeze([...revision.source_event_ids]),
    });
    this.executions.set(execution.id, execution); this.persist(); return execution;
  }

  completeSubagentExecution(input: { id: string; result_artifact_id: string; result_provenance: DeclarativeSubagentExecution["result_provenance"]; evidence_ids: readonly string[] }): DeclarativeSubagentExecution {
    const execution = this.required(this.executions, input.id, "declarative subagent execution");
    if (execution.state !== "requested") return execution;
    this.requireArtifact(input.result_artifact_id, execution.campaign_id);
    const next: DeclarativeSubagentExecution = Object.freeze({ ...execution, state: "completed", result_artifact_id: input.result_artifact_id, result_provenance: input.result_provenance, evidence_ids: Object.freeze([...new Set([...execution.evidence_ids, ...input.evidence_ids, input.result_artifact_id])]), completed_at: this.clock() });
    this.executions.set(next.id, next); this.persist(); return next;
  }

  failSubagentExecution(id: string, reason: string): DeclarativeSubagentExecution {
    const execution = this.required(this.executions, id, "declarative subagent execution");
    if (execution.state !== "requested") return execution;
    const next: DeclarativeSubagentExecution = Object.freeze({ ...execution, state: "failed", failure_reason: reason.slice(0, 512), completed_at: this.clock() });
    this.executions.set(next.id, next); this.persist(); return next;
  }

  listSubagentExecutions(campaign_id: string): readonly DeclarativeSubagentExecution[] {
    return [...this.executions.values()].filter((execution) => execution.campaign_id === campaign_id).sort((a, b) => b.requested_at.localeCompare(a.requested_at));
  }

  /**
   * Sample approved campaign-local overlays at a loop checkpoint. Expiry is
   * durably projected before any material is returned, so a restarted runner
   * cannot resurrect a stale active revision. Only fold artifacts, playbook
   * guidance, and supplemental prompts are enacted. The remaining allowlisted
   * components stay explicit, unapplied dispositions until a real isolated
   * retriever/executor adapter exists.
   */
  checkpoint(input: { campaign_id: string; node_id: string; as_of?: string; /** Evaluation-only subtraction; never adds an overlay. */ exclude_revision_ids?: readonly string[] }): GovernedOverlayCheckpointProjection {
    const asOf = input.as_of ?? this.clock();
    this.expireActiveOverlays(asOf);
    const overlays = this.overlays(input.campaign_id, asOf);
    const specialist_context: string[] = [];
    const critic_context: string[] = [];
    const specialist_prompt_fragments: string[] = [];
    const critic_prompt_fragments: string[] = [];
    const applied_overlay_ids: string[] = [];
    const unapplied_overlays: Array<{ id: string; reason: string }> = [];

    for (const fold of overlays.active_folds) {
      const stored = this.artifacts.get(fold.output_artifact.id);
      if (!stored) {
        // This should be unreachable because proposal validation requires it,
        // but a corrupted/restored state must fail closed rather than inject a
        // fabricated substitute.
        unapplied_overlays.push({ id: fold.id, reason: "fold output artifact is unavailable" });
        continue;
      }
      if (stored.ref.campaign_id !== fold.campaign_id) {
        // Same fail-closed posture as the missing-artifact case above: proposal
        // validation requires same-campaign ownership, but restored/corrupted
        // state must never be allowed to inject another campaign's content.
        unapplied_overlays.push({ id: fold.id, reason: "fold output artifact belongs to a different campaign" });
        continue;
      }
      const content = boundedOverlayText(stored.content);
      if (stored.ref.visibility === "campaign") specialist_context.push(content);
      critic_context.push(content);
      applied_overlay_ids.push(fold.id);
    }
    for (const delta of overlays.active_playbook) {
      const guidance = readGuidance(delta.patch);
      if (!guidance) {
        unapplied_overlays.push({ id: delta.id, reason: "playbook patch has no typed guidance fragment" });
        continue;
      }
      specialist_prompt_fragments.push(guidance.specialist);
      critic_prompt_fragments.push(guidance.critic);
      applied_overlay_ids.push(delta.id);
    }
    const excluded = new Set(input.exclude_revision_ids ?? []);
    for (const revision of overlays.active_harness_revisions) {
      // The evaluator obtains its control arm by subtracting exactly the
      // selected active revision from the same checkpoint compositor used by
      // production dispatch. This is intentionally a removal-only switch.
      if (excluded.has(revision.id)) continue;
      if (revision.component === "supplemental_prompt") {
        const guidance = readGuidance(revision.patch);
        if (!guidance) {
          unapplied_overlays.push({ id: revision.id, reason: "supplemental prompt has no typed fragment" });
          continue;
        }
        specialist_prompt_fragments.push(guidance.specialist);
        critic_prompt_fragments.push(guidance.critic);
        applied_overlay_ids.push(revision.id);
      } else if (revision.component === "retrieval_policy") {
        const adapter = this.adapters?.retrieval_index;
        if (!adapter || !this.adapters?.capabilities.has("context.retrieve")) {
          unapplied_overlays.push({ id: revision.id, reason: "no capability-gated isolated retrieval/index adapter is configured" });
          continue;
        }
        try {
          const policy = retrievalPolicy(revision.patch);
          if (!policy) throw new Error("retrieval policy is malformed");
          const results = adapter.retrieve({ campaign_id: input.campaign_id, node_id: input.node_id, revision_id: revision.id, index_ids: policy.index_ids, max_results: policy.max_results });
          this.appendReferencedArtifacts(results.map((result) => result.artifact_id), input.campaign_id, specialist_context, critic_context);
          applied_overlay_ids.push(revision.id);
        } catch (error) {
          unapplied_overlays.push({ id: revision.id, reason: `isolated retrieval/index adapter declined: ${error instanceof Error ? error.message : String(error)}` });
        }
      } else {
        const adapter = this.adapters?.declarative_subagent;
        if (!adapter || !this.adapters?.capabilities.has("subagent.describe")) {
          unapplied_overlays.push({ id: revision.id, reason: "no capability-gated declarative-subagent adapter is configured" });
          continue;
        }
        try {
          const descriptor = revision.patch.descriptor as NonExecutableSubagentDescriptor;
          const prepared = adapter.prepare({ campaign_id: input.campaign_id, node_id: input.node_id, revision_id: revision.id, descriptor });
          // The descriptor's own `allowed_context_artifact_ids` is the
          // authority for what this subagent may see, not whatever the
          // adapter chose to prepare. An adapter that returns a reference
          // outside that declared allowlist must be refused entirely, the
          // same as any other malformed adapter result.
          const allowed = new Set(descriptor.allowed_context_artifact_ids);
          if (prepared.artifact_ids.some((id) => !allowed.has(id))) {
            throw new Error("adapter referenced an artifact outside the descriptor's allowed_context_artifact_ids");
          }
          this.appendReferencedArtifacts(prepared.artifact_ids, input.campaign_id, specialist_context, critic_context);
          applied_overlay_ids.push(revision.id);
        } catch (error) {
          unapplied_overlays.push({ id: revision.id, reason: `declarative-subagent adapter declined: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
    }
    return { checkpoint_at: asOf, specialist_context, critic_context, specialist_prompt_fragments, critic_prompt_fragments, applied_overlay_ids, unapplied_overlays };
  }

  overlays(campaign_id: string, as_of = this.clock()): GovernedContextOverlays {
    const active = <T extends { campaign_id: string; status: string; expires_at: string }>(map: Map<string, T>): T[] =>
      [...map.values()].filter((record) => record.campaign_id === campaign_id && record.status === "active" && !isExpired(record, as_of));
    const revisions = active(this.revisions);
    return {
      campaign_id, active_folds: active(this.folds), active_playbook: active(this.playbook), active_harness_revisions: revisions,
      declarative_subagent_executions: [...this.listSubagentExecutions(campaign_id)],
      rollbackable_ids: [...active(this.folds).map((r) => r.id), ...revisions.map((r) => r.id)],
    };
  }

  list(campaign_id: string): { folds: FoldRecord[]; playbook: PlaybookDelta[]; revisions: HarnessRevision[]; executions: DeclarativeSubagentExecution[] } {
    const ofCampaign = <T extends { campaign_id: string }>(map: Map<string, T>) => [...map.values()].filter((item) => item.campaign_id === campaign_id);
    return { folds: ofCampaign(this.folds), playbook: ofCampaign(this.playbook), revisions: ofCampaign(this.revisions), executions: [...this.listSubagentExecutions(campaign_id)] };
  }

  newId(prefix: string): string { return `${prefix}_${randomUUID()}`; }

  /**
   * An artifact id existing in the global content-addressed store is not
   * enough: a governed record for campaign A must never be able to reference
   * an artifact actually owned by campaign B, or checkpoint() would inject B's
   * content into A's specialist/critic context.
   */
  private requireArtifact(id: string, campaignId: string): void {
    const stored = this.artifacts.get(id);
    if (!stored) throw new Error(`fold references unknown context artifact ${id}`);
    if (stored.ref.campaign_id !== campaignId) throw new Error(`fold references context artifact ${id} from a different campaign`);
  }
  private requireValidLifetime(record: { created_at: string; expires_at: string }): void {
    const created = Date.parse(record.created_at); const expires = Date.parse(record.expires_at);
    if (!Number.isFinite(created) || !Number.isFinite(expires) || expires <= created) throw new Error("governed overlay requires a valid future expiry");
  }
  private requireCritic(approver: string): void { if (approver !== this.criticActor) throw new Error(`local activation requires distinct critic ${this.criticActor}`); }
  private requireMessageRanges(campaignId: string, ranges: readonly MessageRangeRef[]): void {
    // Standalone service instances are useful for isolated tests and import/replay
    // tooling. Production composition always supplies this port; when present it
    // is the sole authority for deciding whether a referenced message exists.
    if (!this.messageEvidence) return;
    for (const range of ranges) {
      if (!range.context_id.trim() || !range.thread_id.trim() || !range.start_communication_id.trim() || !range.end_communication_id.trim() || !Number.isSafeInteger(range.start_byte) || !Number.isSafeInteger(range.end_byte) || range.start_byte < 0 || range.end_byte < range.start_byte) throw new Error("fold message range is invalid");
      if (!this.messageEvidence.hasMessageRange(campaignId, range)) throw new Error(`fold references unknown durable message range ${range.start_communication_id}..${range.end_communication_id}`);
    }
  }
  private requireNonExecutableDescriptor(campaignId: string, patch: Record<string, unknown>): void {
    const descriptor = patch.descriptor as Partial<NonExecutableSubagentDescriptor> | undefined;
    if (!descriptor || typeof descriptor.role !== "string" || typeof descriptor.objective !== "string" || descriptor.recursive_delegation !== false
      || !Array.isArray(descriptor.allowed_context_artifact_ids) || !Array.isArray(descriptor.allowed_message_ranges)
      || !Number.isSafeInteger(descriptor.max_children) || (descriptor.max_children ?? -1) < 0) {
      throw new Error("subagent descriptor must be declarative, bounded, and forbid recursive delegation");
    }
    if (["command", "commands", "code", "executable", "skill", "tool"].some((key) => key in patch)) throw new Error("subagent descriptor may not include executable fields");
    for (const artifactId of descriptor.allowed_context_artifact_ids) if (typeof artifactId !== "string") throw new Error("subagent descriptor artifact ids must be strings");
    for (const artifactId of descriptor.allowed_context_artifact_ids as string[]) this.requireArtifact(artifactId, campaignId);
    this.requireMessageRanges(campaignId, descriptor.allowed_message_ranges as MessageRangeRef[]);
  }
  private requireRetrievalPolicy(patch: Record<string, unknown>): void {
    if (!retrievalPolicy(patch)) throw new Error("retrieval policy may only declare campaign-local index ids and a result bound from 1 through 100");
  }
  /** Read only own campaign artifacts, bound result count and byte contribution. */
  private appendReferencedArtifacts(ids: readonly string[], campaignId: string, specialist: string[], critic: string[]): void {
    if (ids.length > 16 || ids.some((id) => typeof id !== "string" || !id.trim())) throw new Error("adapter returned invalid or excessive artifact references");
    // Validate every reference before appending any content. A single bad
    // reference must reject the whole overlay atomically — content from the
    // earlier, valid ids must never reach specialist/critic context while the
    // overlay as a whole is reported unapplied.
    const resolved = ids.map((id) => {
      const stored = this.artifacts.get(id);
      if (!stored || stored.ref.campaign_id !== campaignId) throw new Error(`adapter referenced unavailable or cross-campaign artifact ${id}`);
      return stored;
    });
    for (const stored of resolved) {
      const content = boundedOverlayText(stored.content);
      if (stored.ref.visibility === "campaign") specialist.push(content);
      critic.push(content);
    }
  }
  private expireActiveOverlays(asOf: string): void {
    let changed = false;
    const expire = <T extends { status: string; expires_at: string }>(map: Map<string, T>): void => {
      for (const [id, record] of map) {
        if (record.status === "active" && isExpired(record, asOf)) {
          map.set(id, { ...record, status: "expired" });
          changed = true;
        }
      }
    };
    expire(this.folds); expire(this.playbook); expire(this.revisions);
    if (changed) this.persist();
  }
  private required<T>(map: Map<string, T>, id: string, noun: string): T { const found = map.get(id); if (!found) throw new Error(`${noun} ${id} was not found`); return found; }
  private recordMeasuredEvaluation(run: HarnessEvaluationRun, evaluation: RevisionEvaluation): HarnessRevision {
    const record = this.required(this.revisions, run.revision_id, "harness revision");
    const next: HarnessRevision = { ...record, evaluation: { ...evaluation, rollback_count: record.evaluation.rollback_count }, evaluation_by: run.evaluator_id };
    this.revisions.set(run.revision_id, next); this.persist(); return next;
  }
  private latestMeasuredEvaluationRun(revisionId: string): HarnessEvaluationRun | null {
    // Map insertion order is durable state order.  A retry is inserted after
    // its predecessor, even when an injected clock gives both attempts the
    // same timestamp, so timestamp ties cannot select stale authority.
    const runs = [...this.evaluationRuns.values()];
    for (let index = runs.length - 1; index >= 0; index -= 1) {
      const run = runs[index]!;
      if (run.revision_id === revisionId && run.state === "measured") return run;
    }
    return null;
  }
  private validMeasuredEvaluationEvidence(run: HarnessEvaluationRun, evidenceIds: readonly string[], evaluation: RevisionEvaluation): boolean {
    const valid = (id: string, partition?: "replay" | "holdout"): boolean => {
      if (!validEvidenceId(id)) return false;
      const stored = this.artifacts.get(id); const artifact = stored?.ref;
      if (stored === undefined || artifact === undefined) return false;
      return artifact.campaign_id === run.campaign_id && artifact.visibility === "critic_only"
        && artifact.media_type === "application/vnd.arbor.overlay-evaluation+json" && validGeneratedProvenance(artifact.provenance)
        && validOverlayEvaluationArtifact(stored.content, run.revision_id, run.id, partition);
    };
    const supplied = new Set(evidenceIds);
    return evidenceIds.length > 0 && new Set(evidenceIds).size === evidenceIds.length
      && evaluation.replay_evidence_ids.length > 0 && evaluation.holdout_evidence_ids.length > 0
      && new Set(evaluation.replay_evidence_ids).size === evaluation.replay_evidence_ids.length
      && new Set(evaluation.holdout_evidence_ids).size === evaluation.holdout_evidence_ids.length
      && evidenceIds.every((id) => valid(id))
      && evaluation.replay_evidence_ids.every((id) => supplied.has(id) && valid(id, "replay"))
      && evaluation.holdout_evidence_ids.every((id) => supplied.has(id) && valid(id, "holdout"));
  }
  private restore(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!isRecord(parsed) || parsed.schema_version !== 1) {
        this.restoreDiagnosticsList.push({ kind: "file", id: null, reason: "persisted governed-context state is not a recognized schema_version 1 record" });
        return;
      }
      for (const item of arrayField(parsed, "artifacts")) {
        if (validStoredArtifact(item)) this.artifacts.set(item.ref.id, item);
        else this.restoreDiagnosticsList.push({ kind: "artifact", id: recordId(item, "ref"), reason: "malformed or content-address-mismatched artifact record" });
      }
      for (const item of arrayField(parsed, "folds")) {
        if (validFoldRecord(item)) this.folds.set(item.id, item);
        else this.restoreDiagnosticsList.push({ kind: "fold", id: recordId(item), reason: "malformed fold record" });
      }
      for (const item of arrayField(parsed, "playbook")) {
        if (validPlaybookDelta(item)) this.playbook.set(item.id, item);
        else this.restoreDiagnosticsList.push({ kind: "playbook", id: recordId(item), reason: "malformed playbook delta record" });
      }
      for (const item of arrayField(parsed, "revisions")) {
        if (validHarnessRevision(item)) this.revisions.set(item.id, item);
        else this.restoreDiagnosticsList.push({ kind: "harness_revision", id: recordId(item), reason: "malformed harness revision record" });
      }
      for (const item of arrayField(parsed, "executions")) {
        if (validDeclarativeSubagentExecution(item)) this.executions.set(item.id, item);
        else this.restoreDiagnosticsList.push({ kind: "subagent_execution", id: recordId(item), reason: "malformed declarative subagent execution record" });
      }
      let reconciledRunningEvaluation = false;
      for (const item of arrayField(parsed, "evaluation_runs")) {
        if (!validRun(item, this.revisions, this.artifacts)) {
          this.restoreDiagnosticsList.push({ kind: "evaluation_run", id: recordId(item), reason: "malformed or evidence-inconsistent evaluation run record" });
          continue;
        }
        // A persisted running evaluator has no live native session or abort
        // controller after restart. Never resurrect it or leave it claiming
        // progress forever; a fresh catalog operation may explicitly retry.
        const restored = item.state === "running"
          ? { ...item, state: "unmeasured" as const, reason: "evaluation interrupted by process restart", completed_at: this.clock() }
          : item;
        if (item.state === "running") reconciledRunningEvaluation = true;
        this.evaluationRuns.set(restored.id, restored);
      }
      if (reconciledRunningEvaluation) this.persist();
    } catch (error) {
      this.restoreDiagnosticsList.push({ kind: "file", id: null, reason: `persisted governed-context state could not be parsed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  private persist(): void {
    if (!this.path) return;
    const state: PersistedContextState = { schema_version: 1, artifacts: [...this.artifacts.values()], folds: [...this.folds.values()], playbook: [...this.playbook.values()], revisions: [...this.revisions.values()], executions: [...this.executions.values()], evaluation_runs: [...this.evaluationRuns.values()] };
    atomicOverwriteFile(this.path, `${JSON.stringify(state)}\n`);
  }
}
function validEvidenceId(value: unknown): value is string { return typeof value === "string" && /^ctx_[a-f0-9]{64}$/.test(value); }
function validOverlayEvaluationArtifact(content: string, revisionId: string, runId: string, expectedPartition?: "replay" | "holdout"): boolean {
  if (Buffer.byteLength(content, "utf8") > 65_536) return false;
  try {
    const artifact: unknown = JSON.parse(content);
    if (!isRecord(artifact) || artifact.schema_version !== 1 || artifact.revision_id !== revisionId || artifact.evaluation_run_id !== runId
      || typeof artifact.scenario_id !== "string" || artifact.scenario_id.trim().length === 0
      || (artifact.partition !== "replay" && artifact.partition !== "holdout")) return false;
    return expectedPartition === undefined || artifact.partition === expectedPartition;
  } catch { return false; }
}
function validEvaluation(value: unknown): value is RevisionEvaluation { if (!isRecord(value) || !Array.isArray(value.replay_evidence_ids) || !Array.isArray(value.holdout_evidence_ids)) return false; const item = value as unknown as RevisionEvaluation; return ["improved", "unchanged", "regressed", "not_yet_measured"].includes(item.outcome) && typeof item.fidelity_ratio === "number" && item.fidelity_ratio >= 0 && item.fidelity_ratio <= 1 && [item.main_model_tokens, item.child_model_tokens, item.latency_ms].every((n) => Number.isSafeInteger(n) && n! >= 0) && typeof item.regression_detected === "boolean" && item.replay_evidence_ids.every(validEvidenceId) && item.holdout_evidence_ids.every(validEvidenceId); }
function validRun(value: unknown, revisions: Map<string, HarnessRevision>, artifacts: Map<string, { ref: ContextArtifactRef; content: string }>): value is HarnessEvaluationRun {
  if (!isRecord(value) || !Array.isArray(value.evidence_ids)) return false;
  const run = value as unknown as HarnessEvaluationRun;
  const base = typeof run.id === "string" && typeof run.revision_id === "string" && typeof run.campaign_id === "string" && typeof run.evaluator_id === "string" && typeof run.requested_at === "string" && ["running", "measured", "unmeasured", "failed"].includes(run.state) && revisions.get(run.revision_id)?.campaign_id === run.campaign_id && run.evidence_ids.every(validEvidenceId) && (!run.evaluation || validEvaluation(run.evaluation)) && (!run.detail || Array.isArray(run.detail) && run.detail.length <= 32 && run.detail.every((row) => Buffer.byteLength(JSON.stringify(row), "utf8") <= 4_096 && !/(?:secret|api[_-]?key|token)=/i.test(JSON.stringify(row))));
  if (!base || run.state !== "measured" || !run.evaluation || run.evaluation.outcome === "not_yet_measured" || run.evidence_ids.length === 0) return base && run.state !== "measured";
  const valid = (id: string, partition?: "replay" | "holdout") => {
    const stored = artifacts.get(id); const artifact = stored?.ref;
    return stored !== undefined && artifact !== undefined && artifact.campaign_id === run.campaign_id && artifact.visibility === "critic_only" && artifact.media_type === "application/vnd.arbor.overlay-evaluation+json" && validGeneratedProvenance(artifact.provenance) && validOverlayEvaluationArtifact(stored.content, run.revision_id, run.id, partition);
  };
  const supplied = new Set(run.evidence_ids);
  return run.evidence_ids.every((id) => valid(id)) && run.evaluation.replay_evidence_ids.length > 0 && run.evaluation.holdout_evidence_ids.length > 0
    && run.evaluation.replay_evidence_ids.every((id) => supplied.has(id) && valid(id, "replay"))
    && run.evaluation.holdout_evidence_ids.every((id) => supplied.has(id) && valid(id, "holdout"));
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function arrayField(value: Record<string, unknown>, key: string): readonly unknown[] { return Array.isArray(value[key]) ? value[key] as readonly unknown[] : []; }
function validStoredArtifact(value: unknown): value is { ref: ContextArtifactRef; content: string } {
  if (!isRecord(value) || typeof value.content !== "string" || !isRecord(value.ref)) return false;
  const ref = value.ref;
  const hash = createHash("sha256").update(Buffer.from(value.content, "utf8")).digest("hex");
  return ref.id === `ctx_${hash}` && ref.sha256 === hash && ref.byte_length === Buffer.byteLength(value.content, "utf8")
    && typeof ref.campaign_id === "string" && ref.campaign_id.trim().length > 0 && (ref.visibility === "campaign" || ref.visibility === "critic_only")
    && typeof ref.media_type === "string" && ref.media_type.trim().length > 0 && isProvenance(ref.provenance);
}
function isProvenance(value: unknown): boolean { return isRecord(value) && (value.tag === "verified" || value.tag === "claimed" || value.tag === "critic_approved" || value.tag === "generated"); }
const PROJECTION_STATUSES = ["proposed", "active", "rejected", "rolled_back", "quarantined", "expired"];
/** WA-30: extracts a best-effort id from an otherwise-malformed record for diagnostics, never for state. */
function recordId(value: unknown, nested?: "ref"): string | null {
  if (!isRecord(value)) return null;
  const target = nested === undefined ? value : value[nested];
  return isRecord(target) && typeof target.id === "string" ? target.id : null;
}
function validFoldRecord(value: unknown): value is FoldRecord {
  if (!isRecord(value)) return false;
  const item = value as unknown as FoldRecord;
  return typeof item.id === "string" && item.id.trim().length > 0
    && typeof item.campaign_id === "string" && item.campaign_id.trim().length > 0
    && typeof item.task_id === "string" && typeof item.node_id === "string"
    && (item.scale === "granular" || item.scale === "deep")
    && Array.isArray(item.source_event_ids) && Array.isArray(item.source_message_ranges)
    && Array.isArray(item.retained_claims) && Array.isArray(item.omitted_artifacts)
    && isRecord(item.output_artifact) && typeof (item.output_artifact as { id?: unknown }).id === "string"
    && isRecord(item.measures) && typeof item.measures.expected_token_savings === "number"
    && typeof item.proposed_by === "string" && isProvenance(item.provenance)
    && typeof item.created_at === "string" && typeof item.expires_at === "string"
    && PROJECTION_STATUSES.includes(item.status);
}
function validPlaybookDelta(value: unknown): value is PlaybookDelta {
  if (!isRecord(value)) return false;
  const item = value as unknown as PlaybookDelta;
  return typeof item.id === "string" && item.id.trim().length > 0
    && typeof item.campaign_id === "string" && typeof item.task_id === "string"
    && ["add", "revise", "supersede", "retract"].includes(item.kind)
    && isRecord(item.patch) && Array.isArray(item.source_event_ids) && Array.isArray(item.source_message_ranges)
    && typeof item.observed_outcome === "string" && Array.isArray(item.counter_evidence)
    && typeof item.proposed_by === "string" && isProvenance(item.provenance)
    && typeof item.created_at === "string" && typeof item.expires_at === "string"
    && PROJECTION_STATUSES.includes(item.status);
}
/** Lenient counterpart to `validEvaluation`: a `HarnessRevision.evaluation` is always present, so its
 * numeric measures are legitimately `null` before the revision has ever been measured. */
function validRevisionEvaluation(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.replay_evidence_ids) || !Array.isArray(value.holdout_evidence_ids)) return false;
  const item = value as unknown as RevisionEvaluation;
  const numberOrNull = (n: unknown): boolean => n === null || (Number.isSafeInteger(n) && (n as number) >= 0);
  return ["improved", "unchanged", "regressed", "not_yet_measured"].includes(item.outcome)
    && (item.fidelity_ratio === null || (typeof item.fidelity_ratio === "number" && item.fidelity_ratio >= 0 && item.fidelity_ratio <= 1))
    && numberOrNull(item.main_model_tokens) && numberOrNull(item.child_model_tokens) && numberOrNull(item.latency_ms)
    && typeof item.regression_detected === "boolean" && Number.isSafeInteger(item.rollback_count) && item.rollback_count >= 0
    && item.replay_evidence_ids.every((id) => typeof id === "string") && item.holdout_evidence_ids.every((id) => typeof id === "string");
}
function validHarnessRevision(value: unknown): value is HarnessRevision {
  if (!isRecord(value)) return false;
  const item = value as unknown as HarnessRevision;
  return typeof item.id === "string" && item.id.trim().length > 0
    && typeof item.campaign_id === "string" && typeof item.task_id === "string"
    && typeof item.component === "string" && item.component.trim().length > 0 && isRecord(item.patch)
    && Array.isArray(item.source_event_ids) && Array.isArray(item.source_message_ranges)
    && typeof item.expected_benefit === "string" && typeof item.proposed_by === "string"
    && isProvenance(item.provenance) && typeof item.created_at === "string" && typeof item.expires_at === "string"
    && PROJECTION_STATUSES.includes(item.status) && validRevisionEvaluation(item.evaluation);
}
function validDeclarativeSubagentExecution(value: unknown): value is DeclarativeSubagentExecution {
  if (!isRecord(value)) return false;
  const item = value as unknown as DeclarativeSubagentExecution;
  return typeof item.id === "string" && item.id.trim().length > 0
    && typeof item.campaign_id === "string" && typeof item.parent_node_id === "string"
    && typeof item.revision_id === "string" && typeof item.revision_created_at === "string"
    && typeof item.requested_by === "string" && typeof item.requested_at === "string"
    && ["requested", "completed", "failed"].includes(item.state)
    && typeof item.child_session_id === "string" && typeof item.worktree_node_id === "string"
    && Array.isArray(item.evidence_ids);
}
function validGeneratedProvenance(value: unknown): boolean { return isRecord(value) && value.tag === "generated" && typeof value.generator === "string" && value.generator.trim().length > 0 && typeof value.input_hash === "string" && value.input_hash.trim().length > 0; }
function sameEvaluation(left: RevisionEvaluation, right: RevisionEvaluation): boolean { return JSON.stringify(left) === JSON.stringify(right); }

/** A malformed timestamp is never treated as indefinitely valid. */
function isExpired(record: { expires_at: string }, asOf: string): boolean {
  const expiry = Date.parse(record.expires_at);
  const checkpoint = Date.parse(asOf);
  return !Number.isFinite(expiry) || !Number.isFinite(checkpoint) || expiry <= checkpoint;
}

/** Keep enacted text bounded even when imported durable state predates schema checks. */
function boundedOverlayText(value: string): string { return value.slice(0, 8_192); }

/**
 * The one textual overlay schema accepted at enactment. `guidance` applies to
 * both roles; role-specific fields may narrow it. Other arbitrary patches can
 * remain auditable playbook data, but cannot silently become executable prompt
 * authority.
 */
function readGuidance(patch: Record<string, unknown>): { specialist: string; critic: string } | null {
  const shared = typeof patch.guidance === "string" ? boundedOverlayText(patch.guidance) : "";
  const specialist = typeof patch.specialist_fragment === "string" ? boundedOverlayText(patch.specialist_fragment) : shared;
  const critic = typeof patch.critic_fragment === "string" ? boundedOverlayText(patch.critic_fragment) : shared;
  return specialist.trim() || critic.trim() ? { specialist, critic } : null;
}

function retrievalPolicy(patch: Record<string, unknown>): { index_ids: readonly string[]; max_results: number } | null {
  const allowed = new Set(["index_ids", "max_results", "query_scope"]);
  if (Object.keys(patch).some((key) => !allowed.has(key))) return null;
  if (!Array.isArray(patch.index_ids) || patch.index_ids.length === 0 || !patch.index_ids.every((id) => typeof id === "string" && id.trim().length > 0)) return null;
  if (!Number.isSafeInteger(patch.max_results) || (patch.max_results as number) < 1 || (patch.max_results as number) > 100) return null;
  if (patch.query_scope !== undefined && patch.query_scope !== "campaign") return null;
  return { index_ids: patch.index_ids as string[], max_results: patch.max_results as number };
}
