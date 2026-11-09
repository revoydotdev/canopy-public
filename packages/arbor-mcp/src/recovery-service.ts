import type { NodeState, TaskSupervisor } from "@arbor/core";
import type { HarnessSessionJournal, HarnessSessionSummary } from "./harness-session-journal.js";
import { buildContinuationPlan, validateContinuationDispositions, type ContinuationCapableExecutor, type ContinuationPlan } from "./recovery/continuation-plan.js";
import { FRESH_ADMISSION_KINDS, type ContinuationAuthorization, type FreshAdmissionResult, type RecoveryDisposition } from "./recovery/contracts.js";

export type RecoveryActorRole = "crown" | "operator" | "auditor" | "specialist" | "critic";
export type RecoveryAction = "retry" | "abandon";

export interface RecoveryNodeView {
  campaign_id: string;
  node_id: string;
  state: NodeState;
  /** Authoritative originating operation for an interrupted state; null for states without interruption evidence. */
  prior_operation_id: string | null;
  /** Durable snapshot revision, not a client-local timestamp. */
  version: string;
}

export interface RecoveryRequest {
  operation_id: string;
  idempotency_key: string;
  campaign_id: string;
  node_id: string;
  prior_operation_id: string;
  expected_version: string;
  action: RecoveryAction;
  actor_id: string;
  actor_role: RecoveryActorRole;
  reason: string;
}

export interface RecoveryLeaseAuthority {
  resolveOldLease(input: Pick<RecoveryRequest, "campaign_id" | "node_id" | "prior_operation_id">): "inactive" | "released" | "active" | "ambiguous";
  acquireFresh(input: Pick<RecoveryRequest, "campaign_id" | "node_id" | "operation_id">): { ok: true; lease_id: string } | { ok: false; detail: string };
  checkIsolation(input: { campaign_id: string; node_id: string; operation_id: string; lease_id: string }): { worktree_isolated: boolean; starting_commit_correct: boolean };
  releaseFresh(lease_id: string, reason: string): void;
}

/** The only mutation port recovery may call; it must durably checkpoint isolation first. */
export interface RecoveryCampaignPort {
  readNode(campaignId: string, nodeId: string): RecoveryNodeView | null;
  persistRetryTransition?: (input: {
    request: RecoveryRequest;
    lease_id: string;
    isolation: { worktree_isolated: boolean; starting_commit_correct: boolean; lease_acquired: true };
  }) => { ok: true } | { ok: false; detail: string };
  persistAbandonment?: (input: { request: RecoveryRequest; old_lease_state: "inactive" | "released" }) => { ok: true } | { ok: false; detail: string };
}

export type RecoveryResult =
  | { status: "ready"; operation_id: string; lease_id: string; task_id: string }
  | { status: "abandoned"; operation_id: string }
  | { status: "planned"; reason: string; required_integration: string }
  | { status: "blocked"; reason: string }
  | { status: "conflict"; reason: string };

export interface RecoveryContinuationAdmissionAuthority {
  admit(input: {
    readonly plan: ContinuationPlan;
    readonly new_session_id: string;
    readonly isolation: { readonly lease_id: string; readonly worktree_isolated: true; readonly starting_commit_correct: true };
  }): readonly FreshAdmissionResult[];
}

type RecoveryContinuationContext = Readonly<{
  journal: HarnessSessionJournal;
  /** Fresh admission is required to authorize a continuation, but is not
   * required merely to detect and refuse an unsafe direct retry. */
  admissions?: RecoveryContinuationAdmissionAuthority;
}>;

export interface ContinuationPreparationRequest {
  readonly authorization_id: string;
  readonly idempotency_key: string;
  readonly operation_id: string;
  readonly prior_operation_id: string;
  readonly expected_version: string;
  readonly actor_id: string;
  readonly actor_role: RecoveryActorRole;
  readonly reason: string;
  readonly dispositions: readonly RecoveryDisposition[];
  readonly authorized_at: string;
  readonly continuation_kind?: "resume" | "fork" | "respawn";
}

export type ForkPreparationRequest = Omit<ContinuationPreparationRequest, "prior_operation_id">;

export type ContinuationPreparationResult =
  | { readonly status: "ready"; readonly plan: ContinuationPlan; readonly authorization: ContinuationAuthorization; readonly lease_id: string; readonly task_id: string; readonly replayed: boolean }
  | { readonly status: "blocked" | "conflict"; readonly reason: string }
  /**
   * WA-18: the durable admission machinery below is otherwise fully capable
   * of preparing this continuation, but the connector that would actually
   * run it does not declare continuation support — dispatching anyway would
   * silently re-run the raw prompt and drop `admitted_context`, while still
   * reporting `accepted: true`. Typed and named, never conflated with
   * `blocked` (a policy/precondition refusal) or a plain boolean.
   */
  | { readonly status: "unavailable"; readonly reason: string; readonly connector_id: string };

/**
 * ADR-012 recovery orchestrator. It creates no result provenance, critic
 * verdict, KB entry, trace, or terminal node state. Those remain normal loop
 * responsibilities after this service has durably prepared a fresh attempt.
 *
 * Concretely: a `retry` transitions the node back to `pending` (via
 * `RecoveryCampaignPort.persistRetryTransition`) under a fresh lease. The
 * canonical loop's own selection (`arbor-core`'s `selectNode`, invoked every
 * iteration through `CampaignManager.selectNode`/`expandNode`) scans the
 * whole tree for `pending` nodes with no special case for a recovered one —
 * so the very next iteration re-selects and re-expands it through the same
 * isolation gate and specialist/critic pipeline as any other node. A
 * bespoke redispatch composition living outside that loop would be a second
 * dispatch authority racing the canonical one over the same node, which is
 * exactly what this codebase's single-authority principle (ADR-011, and the
 * "never a second authority" rule applied elsewhere to A2A/4D.6) forbids. An
 * earlier `redispatchRecoveredNode` helper attempted that bespoke path; it
 * was removed for this reason once `RecoveryService` was wired into the
 * router (G-03) and never had a caller to begin with.
 */
export class RecoveryService {
  private readonly idempotency = new Map<string, { fingerprint: string; result: RecoveryResult }>();
  private readonly order: string[] = [];

  constructor(
    private readonly campaign: RecoveryCampaignPort,
    private readonly supervisor: TaskSupervisor,
    private readonly leases: RecoveryLeaseAuthority,
    private readonly idempotencyCapacity = 100,
    private readonly continuation?: RecoveryContinuationContext,
    /**
     * WA-18: the executor continuation dispatch will actually run through,
     * if the composition root has one to declare. `undefined` (the default,
     * and the state every existing composition of `RecoveryService` is in
     * today) means "unknown" — this service does not fabricate a refusal it
     * has no data for, so behavior is unchanged until a caller wires this.
     */
    private readonly executor?: ContinuationCapableExecutor,
  ) {
    if (!Number.isSafeInteger(idempotencyCapacity) || idempotencyCapacity < 1) throw new Error("idempotencyCapacity must be a positive integer");
  }

  /** WA-18: the one refusal both `prepareFork` and `prepareContinuation` share. */
  private executorRefusal(): { readonly status: "unavailable"; readonly reason: string; readonly connector_id: string } | null {
    if (this.executor === undefined || this.executor.continuation_support === "native") return null;
    return { status: "unavailable", reason: `continuation requires an executor that declares continuation support; connector "${this.executor.connector_id}" declares "${this.executor.continuation_support}"`, connector_id: this.executor.connector_id };
  }

  previewContinuation(campaignId: string, nodeId?: string): readonly ContinuationPlan[] {
    if (this.continuation === undefined) return [];
    return this.continuation.journal.list(campaignId, 1_000)
      .filter((session) => session.recovery.kind === "recovery_required" && (nodeId === undefined || session.node_id === nodeId))
      .map((session) => this.projectSession(session));
  }

  /** Build a plan for a terminal source or a restart-classified nonterminal crash orphan. */
  previewSession(sessionId: string): ContinuationPlan | null {
    if (this.continuation === undefined) return null;
    const session = this.continuation.journal.inspect(sessionId);
    if (session === null || (session.terminal === null && session.recovery.kind !== "recovery_required")) return null;
    return this.projectSession(session);
  }

  /** Rebuild a read projection from the journal's current source revision. */
  private projectSession(session: HarnessSessionSummary): ContinuationPlan {
    if (this.continuation === undefined) throw new Error("durable continuation journal is not configured");
    return buildContinuationPlan({
      session,
      checkpoints: this.continuation.journal.operationCheckpoints(session.session_id),
      tool_audits: this.continuation.journal.toolAudits(session.session_id, 1_000),
      events: this.continuation.journal.events(session.session_id, 0, 1_000),
      artifacts: this.continuation.journal.artifactsFor(session.session_id, 64),
    });
  }

  /**
   * Plans are read projections, not capabilities. Re-read their source before
   * preparing a continuation so a checkpoint, state, or effect change after
   * preview cannot be authorized from stale classifications.
   */
  private refreshPlan(plan: ContinuationPlan, expectedState: "terminal" | "recovery_required"): ContinuationPlan | null {
    const journal = this.continuation?.journal;
    if (journal === undefined) return null;
    const session = journal.inspect(plan.source_session_id);
    if (session === null || session.campaign_id !== plan.campaign_id || session.node_id !== plan.node_id) return null;
    if (expectedState === "terminal" ? session.terminal === null : session.recovery.kind !== "recovery_required") return null;
    const current = this.projectSession(session);
    return sameContinuationProjection(plan, current) ? current : null;
  }

  /**
   * Admit a terminal source as context for a real, already-created pending
   * child. This never mutates the source or creates dispatch authority; the
   * caller still submits the canonical campaign.run after durable admission.
   */
  prepareFork(plan: ContinuationPlan, targetNodeId: string, request: ForkPreparationRequest): ContinuationPreparationResult {
    try {
      const refusal = this.executorRefusal(); if (refusal !== null) return refusal;
      if (this.continuation === undefined) return { status: "blocked", reason: "durable continuation journal and admission authority are not configured" };
      if (this.continuation.admissions === undefined) return { status: "blocked", reason: "fresh continuation admission authority is not configured" };
      if (request.actor_role !== "operator" && request.actor_role !== "auditor") return { status: "blocked", reason: `${request.actor_role} cannot authorize a session fork` };
      if (this.refreshPlan(plan, "terminal") === null) return { status: "conflict", reason: "source session projection is stale or no longer terminal" };
      const dispositionError = validateContinuationDispositions(plan, request.dispositions);
      if (dispositionError !== null) return { status: "blocked", reason: dispositionError };
      const durablePrior = this.continuation.journal.continuationByIdempotencyKey(request.idempotency_key);
      if (durablePrior !== null) {
        const same = durablePrior.authorization_id === request.authorization_id && durablePrior.campaign_id === plan.campaign_id
          && durablePrior.node_id === targetNodeId && durablePrior.source_session_id === plan.source_session_id
          && durablePrior.classification_fingerprint === plan.classification_fingerprint && durablePrior.actor_id === request.actor_id
          && durablePrior.continuation_kind === "fork" && JSON.stringify(durablePrior.dispositions) === JSON.stringify(request.dispositions);
        if (!same) return { status: "conflict", reason: "idempotency key names a different continuation authorization" };
        return { status: "blocked", reason: "durable fork authorization replay cannot establish a current isolated lease and registered supervisor task" };
      }
      const node = this.campaign.readNode(plan.campaign_id, targetNodeId);
      if (node === null) return { status: "blocked", reason: "fork target node was not found" };
      if (node.version !== request.expected_version) return { status: "conflict", reason: "snapshot version no longer matches expected_version" };
      if (node.state !== "pending") return { status: "blocked", reason: `fork target state ${node.state} is not pending` };
      const acquired = this.leases.acquireFresh({ campaign_id: plan.campaign_id, node_id: targetNodeId, operation_id: request.operation_id });
      if (!acquired.ok) return { status: "blocked", reason: acquired.detail };
      let ready = false;
      let stagedAuthorization = false;
      const taskId = `recovery:${request.operation_id}`;
      try {
        const isolation = this.leases.checkIsolation({ campaign_id: plan.campaign_id, node_id: targetNodeId, operation_id: request.operation_id, lease_id: acquired.lease_id });
        if (!isolation.worktree_isolated || !isolation.starting_commit_correct) return { status: "blocked", reason: "fresh isolation check failed" };
        const newSessionId = `continuation:${request.authorization_id}`;
        const targetPlan = Object.freeze({ ...plan, node_id: targetNodeId });
        const admissions = this.continuation.admissions.admit({ plan: targetPlan, new_session_id: newSessionId, isolation: { lease_id: acquired.lease_id, worktree_isolated: true, starting_commit_correct: true } });
        const admissionError = validateAdmissions(admissions);
        if (admissionError !== null) return { status: "blocked", reason: admissionError };
        if (this.refreshPlan(plan, "terminal") === null) return { status: "conflict", reason: "source session changed while the fork was being admitted" };
        const currentTarget = this.campaign.readNode(plan.campaign_id, targetNodeId);
        if (currentTarget === null || currentTarget.version !== request.expected_version || currentTarget.state !== "pending") {
          return { status: "conflict", reason: "fork target changed while the continuation was being admitted" };
        }
        const authorization: ContinuationAuthorization = Object.freeze({
          authorization_id: request.authorization_id, idempotency_key: request.idempotency_key,
          campaign_id: plan.campaign_id, node_id: targetNodeId, source_session_id: plan.source_session_id,
          source_checkpoint: plan.source_checkpoint, new_session_id: newSessionId, continuation_kind: "fork",
          classification_fingerprint: plan.classification_fingerprint,
          effects: Object.freeze(plan.classifications.map((item) => Object.freeze({ operation_id: item.operation_id, operation: item.operation, classification: item.classification }))),
          dispositions: Object.freeze(request.dispositions.map((item) => Object.freeze({ ...item }))),
          admissions: Object.freeze(admissions.map((item) => Object.freeze({ ...item }))), context: plan.admitted_context,
          actor_id: request.actor_id, authorized_at: request.authorized_at,
        });
        const staged = this.continuation.journal.stageContinuationAuthorization(authorization);
        if (!staged.ok) return { status: staged.conflict ? "conflict" : "blocked", reason: staged.reason };
        stagedAuthorization = true;
        const task = this.supervisor.register({ id: taskId, operation_id: request.operation_id, kind: "recovery.fork", owner_scope_id: plan.campaign_id });
        if (task.state !== "accepted") return { status: "blocked", reason: `recovery supervisor task is ${task.state}, not accepted` };
        const activated = this.continuation.journal.activateContinuationAuthorization(request.authorization_id);
        if (!activated.ok) return { status: activated.conflict ? "conflict" : "blocked", reason: activated.reason };
        ready = true;
        return { status: "ready", plan: targetPlan, authorization: activated.record, lease_id: acquired.lease_id, task_id: task.id, replayed: staged.replayed || activated.replayed };
      } finally {
        if (!ready) {
          this.cancelStagedAuthorization(stagedAuthorization, request.authorization_id);
          this.unregisterAcceptedTask(taskId);
          this.releaseLease(acquired.lease_id, "fork preparation did not reach ready");
        }
      }
    } catch (error) { return { status: "blocked", reason: error instanceof Error ? error.message : String(error) }; }
  }

  /** ADR-043: reconcile, freshly admit, durably authorize, then make the node selectable. */
  prepareContinuation(campaignId: string, nodeId: string, request: ContinuationPreparationRequest): ContinuationPreparationResult {
    try {
      const refusal = this.executorRefusal(); if (refusal !== null) return refusal;
      if (this.continuation === undefined) return { status: "blocked", reason: "durable continuation journal and admission authority are not configured" };
      if (this.continuation.admissions === undefined) return { status: "blocked", reason: "fresh continuation admission authority is not configured" };
      if (request.actor_role !== "operator" && request.actor_role !== "auditor") return { status: "blocked", reason: `${request.actor_role} cannot authorize crash continuation` };
      const plan = this.previewContinuation(campaignId, nodeId)[0];
      if (plan === undefined) return { status: "blocked", reason: "no interrupted durable session was found for the campaign node" };
      if (this.refreshPlan(plan, "recovery_required") === null) return { status: "conflict", reason: "source session projection is stale or no longer recoverable" };
      const dispositionError = validateContinuationDispositions(plan, request.dispositions);
      if (dispositionError !== null) return { status: "blocked", reason: dispositionError };
      const durablePrior = this.continuation.journal.continuationByIdempotencyKey(request.idempotency_key);
      if (durablePrior !== null) {
        const same = durablePrior.authorization_id === request.authorization_id && durablePrior.campaign_id === campaignId && durablePrior.node_id === nodeId
          && durablePrior.classification_fingerprint === plan.classification_fingerprint && durablePrior.actor_id === request.actor_id
          && JSON.stringify(durablePrior.dispositions) === JSON.stringify(request.dispositions);
        if (!same) return { status: "conflict", reason: "idempotency key names a different continuation authorization" };
        // The durable authorization alone cannot prove that the isolated
        // worktree lease and accepted supervisor task still exist. In
        // particular, after restart the old admission evidence is not a live
        // lease. Never turn this replay shortcut into a new ready result.
        return { status: "blocked", reason: "durable continuation authorization replay cannot establish a current isolated lease and registered supervisor task" };
      }
      const node = this.campaign.readNode(campaignId, nodeId);
      if (node === null) return { status: "blocked", reason: "campaign or node was not found" };
      if (node.version !== request.expected_version) return { status: "conflict", reason: "snapshot version no longer matches expected_version" };
      if (node.state !== "interrupted" && node.state !== "expanding" && node.state !== "pending") return { status: "blocked", reason: `node state ${node.state} is not recoverable` };
      if (node.state === "interrupted" && node.prior_operation_id !== request.prior_operation_id) {
        return { status: "conflict", reason: "prior_operation_id does not match the interrupted node outcome" };
      }
      if (!this.campaign.persistRetryTransition) return { status: "blocked", reason: "manager cannot durably prepare a retry transition" };

      const oldLease = this.leases.resolveOldLease({ campaign_id: campaignId, node_id: nodeId, prior_operation_id: request.prior_operation_id });
      if (oldLease !== "inactive" && oldLease !== "released") return { status: "blocked", reason: `old lease is ${oldLease}; continuation is unsafe` };
      const acquired = this.leases.acquireFresh({ campaign_id: campaignId, node_id: nodeId, operation_id: request.operation_id });
      if (!acquired.ok) return { status: "blocked", reason: acquired.detail };
      let ready = false;
      let stagedAuthorization = false;
      const taskId = `recovery:${request.operation_id}`;
      try {
        const isolation = this.leases.checkIsolation({ campaign_id: campaignId, node_id: nodeId, operation_id: request.operation_id, lease_id: acquired.lease_id });
        if (!isolation.worktree_isolated || !isolation.starting_commit_correct) return { status: "blocked", reason: "fresh isolation check failed" };
        const newSessionId = `continuation:${request.authorization_id}`;
        const admissions = this.continuation.admissions.admit({ plan, new_session_id: newSessionId, isolation: { lease_id: acquired.lease_id, worktree_isolated: true, starting_commit_correct: true } });
        const admissionError = validateAdmissions(admissions);
        if (admissionError !== null) return { status: "blocked", reason: admissionError };
        if (this.refreshPlan(plan, "recovery_required") === null) return { status: "conflict", reason: "source session changed while the continuation was being admitted" };
        const authorization: ContinuationAuthorization = Object.freeze({
          authorization_id: request.authorization_id, idempotency_key: request.idempotency_key,
          campaign_id: campaignId, node_id: nodeId, source_session_id: plan.source_session_id,
          source_checkpoint: plan.source_checkpoint, new_session_id: newSessionId,
          continuation_kind: request.continuation_kind ?? "resume",
          classification_fingerprint: plan.classification_fingerprint,
          effects: Object.freeze(plan.classifications.map((item) => Object.freeze({ operation_id: item.operation_id, operation: item.operation, classification: item.classification }))),
          dispositions: Object.freeze(request.dispositions.map((item) => Object.freeze({ ...item }))),
          admissions: Object.freeze(admissions.map((item) => Object.freeze({ ...item }))), context: plan.admitted_context,
          actor_id: request.actor_id, authorized_at: request.authorized_at,
        });
        const recoveryRequest: RecoveryRequest = { operation_id: request.operation_id, idempotency_key: request.idempotency_key, campaign_id: campaignId, node_id: nodeId, prior_operation_id: request.prior_operation_id, expected_version: request.expected_version, action: "retry", actor_id: request.actor_id, actor_role: request.actor_role, reason: request.reason };
        // Reserve the complete authorization without granting dispatch
        // authority. Only publish it as active after the pending tree
        // transition and the accepted supervisor task are both durable.
        const stagedResult = this.continuation.journal.stageContinuationAuthorization(authorization);
        if (!stagedResult.ok) return { status: stagedResult.conflict ? "conflict" : "blocked", reason: stagedResult.reason };
        stagedAuthorization = true;
        const persisted = this.campaign.persistRetryTransition({ request: recoveryRequest, lease_id: acquired.lease_id, isolation: { ...isolation, lease_acquired: true } });
        if (!persisted.ok) return { status: "blocked", reason: persisted.detail };
        const task = this.supervisor.register({ id: taskId, operation_id: request.operation_id, kind: "recovery.retry", owner_scope_id: campaignId });
        if (task.state !== "accepted") return { status: "blocked", reason: `recovery supervisor task is ${task.state}, not accepted` };
        const activatedAuthorization = this.continuation.journal.activateContinuationAuthorization(request.authorization_id);
        if (!activatedAuthorization.ok) return { status: activatedAuthorization.conflict ? "conflict" : "blocked", reason: activatedAuthorization.reason };
        ready = true;
        return { status: "ready", plan, authorization: activatedAuthorization.record, lease_id: acquired.lease_id, task_id: task.id, replayed: stagedResult.replayed || activatedAuthorization.replayed };
      } finally {
        if (!ready) {
          this.cancelStagedAuthorization(stagedAuthorization, request.authorization_id);
          this.unregisterAcceptedTask(taskId);
          this.releaseLease(acquired.lease_id, "continuation preparation did not reach ready");
        }
      }
    } catch (error) { return { status: "blocked", reason: error instanceof Error ? error.message : String(error) }; }
  }

  private cancelStagedAuthorization(staged: boolean, authorizationId: string): void {
    if (!staged || this.continuation === undefined) return;
    try { this.continuation.journal.cancelContinuationAuthorization(authorizationId); } catch { /* cleanup must not replace the preparation refusal */ }
  }

  private unregisterAcceptedTask(taskId: string): void {
    try {
      const task = this.supervisor.get(taskId);
      if (task?.state === "accepted") this.supervisor.unregister(taskId);
    } catch { /* task may have advanced or disappeared during compensation */ }
  }

  private releaseLease(leaseId: string, reason: string): void {
    try { this.leases.releaseFresh(leaseId, reason); } catch { /* preserve the preparation outcome */ }
  }

  execute(request: RecoveryRequest): RecoveryResult {
    try {
      const invalid = validate(request);
      if (invalid) return { status: "blocked", reason: invalid };
      const fingerprint = JSON.stringify(request);
      const prior = this.idempotency.get(request.idempotency_key);
      if (prior) return prior.fingerprint === fingerprint ? structuredClone(prior.result) : { status: "conflict", reason: "idempotency key names a different recovery decision" };
      const result = this.perform(request);
      this.remember(request.idempotency_key, fingerprint, result);
      return structuredClone(result);
    } catch (error) {
      return { status: "blocked", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private perform(request: RecoveryRequest): RecoveryResult {
    if (!authorized(request)) return { status: "blocked", reason: `${request.actor_role} is not authorized to ${request.action} interrupted work` };
    const node = this.campaign.readNode(request.campaign_id, request.node_id);
    if (!node) return { status: "blocked", reason: "campaign or node was not found" };
    if (node.version !== request.expected_version) return { status: "conflict", reason: "snapshot version no longer matches expected_version" };
    // A normal operator recovery starts from an interrupted node. `pending`
    // and `expanding` remain accepted for crash-reconciliation paths, but
    // excluding `interrupted` here made the catalog's own documented recovery
    // target impossible to act on.
    if (node.state !== "interrupted" && node.state !== "expanding" && node.state !== "pending") return { status: "blocked", reason: `node state ${node.state} is not recoverable` };
    if (node.state === "interrupted" && node.prior_operation_id !== request.prior_operation_id) {
      return { status: "conflict", reason: "prior_operation_id does not match the interrupted node outcome" };
    }

    // `recovery.retry` is a tree/lease recovery request, not the ADR-043
    // crash-continuation authorization. If a durable harness session exists
    // for this node, the retry must go through
    // `prepareContinuation`, which refreshes the effect classification,
    // validates explicit dispositions, obtains fresh admissions, and records
    // the authorization before making the node selectable. This also applies
    // when admissions are not composed: absence of the continuation path
    // cannot silently turn an interrupted session into a blind retry.
    if (request.action === "retry" && this.continuation !== undefined) {
      const durableSession = this.continuation.journal.list(request.campaign_id, Number.MAX_SAFE_INTEGER)
        .find((session) => session.node_id === request.node_id);
      if (durableSession !== undefined) {
        return { status: "blocked", reason: "durable session requires reconciliation and explicit authorization through the continuation path" };
      }
    }

    if (request.action === "abandon") {
      if (!this.campaign.persistAbandonment) return planned("persistAbandonment", "a typed non-selectable recovery state is required before abandonment can mutate the tree");
      const oldLease = this.leases.resolveOldLease(request);
      if (oldLease !== "inactive" && oldLease !== "released") return { status: "blocked", reason: `old lease is ${oldLease}; operator resolution is required` };
      const persisted = this.campaign.persistAbandonment({ request, old_lease_state: oldLease });
      return persisted.ok ? { status: "abandoned", operation_id: request.operation_id } : { status: "blocked", reason: persisted.detail };
    }

    if (!this.campaign.persistRetryTransition) return planned("persistRetryTransition", "manager must durably record fresh isolation evidence and the authorized recovery transition");
    const oldLease = this.leases.resolveOldLease(request);
    if (oldLease !== "inactive" && oldLease !== "released") return { status: "blocked", reason: `old lease is ${oldLease}; retry is unsafe` };
    const acquired = this.leases.acquireFresh(request);
    if (!acquired.ok) return { status: "blocked", reason: acquired.detail };
    // Pre-initialized so a throw before assignment still releases the lease in finally.
    let state: "pending" | "ready" = "pending";
    let result: RecoveryResult;
    try {
      const isolation = this.leases.checkIsolation({ campaign_id: request.campaign_id, node_id: request.node_id, operation_id: request.operation_id, lease_id: acquired.lease_id });
      if (!isolation.worktree_isolated || !isolation.starting_commit_correct) {
        result = { status: "blocked", reason: "fresh isolation check failed" };
      } else {
        const persisted = this.campaign.persistRetryTransition({ request, lease_id: acquired.lease_id, isolation: { ...isolation, lease_acquired: true } });
        if (!persisted.ok) {
          result = { status: "blocked", reason: persisted.detail };
        } else {
          const task = this.supervisor.register({ id: `recovery:${request.operation_id}`, operation_id: request.operation_id, kind: "recovery.retry", owner_scope_id: request.campaign_id });
          result = { status: "ready", operation_id: request.operation_id, lease_id: acquired.lease_id, task_id: task.id };
          state = "ready";
        }
      }
      return result;
    } finally {
      if (state !== "ready") {
        this.leases.releaseFresh(acquired.lease_id, "recovery attempt did not reach ready");
      }
    }
  }

  private remember(key: string, fingerprint: string, result: RecoveryResult): void {
    this.idempotency.set(key, { fingerprint, result: structuredClone(result) });
    this.order.push(key);
    if (this.order.length > this.idempotencyCapacity) this.idempotency.delete(this.order.shift()!);
  }
}

function validateAdmissions(admissions: readonly FreshAdmissionResult[]): string | null {
  if (admissions.length !== FRESH_ADMISSION_KINDS.length || new Set(admissions.map((item) => item.kind)).size !== FRESH_ADMISSION_KINDS.length) return "fresh admission authority did not return every required authority exactly once";
  for (const kind of FRESH_ADMISSION_KINDS) {
    const admission = admissions.find((item) => item.kind === kind);
    if (admission === undefined || !admission.admitted) return `${kind} fresh admission failed${admission?.reason ? `: ${admission.reason}` : ""}`;
    if (!admission.evidence_id.trim() || !admission.reason.trim()) return `${kind} fresh admission lacks bounded evidence`;
  }
  return null;
}

function authorized(request: RecoveryRequest): boolean {
  return request.action === "retry"
    ? request.actor_role === "crown" || request.actor_role === "operator" || request.actor_role === "auditor"
    : request.actor_role === "operator" || request.actor_role === "auditor";
}

function planned(required_integration: string, reason: string): RecoveryResult {
  return { status: "planned", required_integration, reason };
}

function sameContinuationProjection(left: ContinuationPlan, right: ContinuationPlan): boolean {
  // The plan is a bounded read model. Compare the checkpoint and classifier
  // fingerprint explicitly, then bind the remaining projection payload so a
  // stale or altered context cannot be carried into a durable authorization.
  return left.campaign_id === right.campaign_id
    && left.node_id === right.node_id
    && left.source_session_id === right.source_session_id
    && left.source_checkpoint === right.source_checkpoint
    && left.classification_fingerprint === right.classification_fingerprint
    && JSON.stringify(left) === JSON.stringify(right);
}

function validate(request: RecoveryRequest): string | null {
  for (const [name, value] of Object.entries(request)) if (typeof value === "string" && !value.trim()) return `${name} must be non-empty`;
  return null;
}
