import { describe, expect, it } from "vitest";
import { TaskSupervisor } from "@arbor/core";
import { HarnessSessionJournal } from "../../src/harness-session-journal.js";
import { RecoveryService, type ContinuationPreparationRequest, type RecoveryCampaignPort, type RecoveryContinuationAdmissionAuthority, type RecoveryLeaseAuthority } from "../../src/recovery-service.js";
import { FRESH_ADMISSION_KINDS, type FreshAdmissionKind, type FreshAdmissionResult } from "../../src/recovery/contracts.js";

function sourceJournal(): HarnessSessionJournal {
  const journal = new HarnessSessionJournal();
  journal.recordStarted({ session_id: "source", campaign_id: "campaign", node_id: "node", operation: "specialize", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "architect", state: "running", latest_sequence: 0 });
  // A settled provider checkpoint, in the exact shape
  // `native-agent-executor.ts` records (prepared -> dispatched -> settled).
  //
  // Without it the effect classifier cannot prove the provider request crossed
  // the dispatch boundary, so it emits an indeterminate `pre-dispatch`
  // classification and `prepareContinuation` demands an operator disposition.
  // That is correct fail-closed behaviour, but it is a DIFFERENT test: these
  // cases are about the fresh-admission dimension (connector, credential,
  // budget, worktree, policy), which is only reachable once the session has
  // durable proof its provider call completed. Do not delete this checkpoint to
  // "simplify" the fixture, and do not relax the expectations to accept
  // `blocked` -- that would silently weaken the recovery safety property.
  const provider = { session_id: "source", operation_id: "source:provider:1:1", operation_kind: "provider", operation: "openrouter", effect_kind: "provider", repeatable: false, idempotency_key_hash: null, acknowledged_by: null, compensation_id: null } as const;
  journal.recordOperationCheckpoint({ ...provider, phase: "prepared", outcome: null, effect: null, occurred_at: "2026-08-12T00:00:00.000Z" });
  journal.recordOperationCheckpoint({ ...provider, phase: "dispatched", outcome: null, effect: null, occurred_at: "2026-08-12T00:00:00.500Z" });
  journal.recordOperationCheckpoint({ ...provider, phase: "settled", outcome: "succeeded", effect: "observed", occurred_at: "2026-08-12T00:00:01.000Z" });
  journal.reconcileOrphanedSessions(); return journal;
}
function authority(log: string[], denied?: FreshAdmissionKind): RecoveryContinuationAdmissionAuthority {
  return { admit: (input) => { log.push("admit"); return FRESH_ADMISSION_KINDS.map((kind): FreshAdmissionResult => ({ kind, admitted: kind !== denied, evidence_id: kind === "worktree" ? input.isolation.lease_id : `${kind}:fresh`, reason: kind === denied ? "revoked in test" : "freshly checked" })); } };
}
function leases(log: string[]): RecoveryLeaseAuthority {
  return {
    resolveOldLease: () => { log.push("resolve-old"); return "inactive"; }, acquireFresh: () => { log.push("acquire"); return { ok: true, lease_id: "lease-new" }; },
    checkIsolation: () => { log.push("isolation"); return { worktree_isolated: true, starting_commit_correct: true }; }, releaseFresh: () => { log.push("release"); },
  };
}
function campaign(log: string[]): RecoveryCampaignPort {
  return { readNode: (_campaignId, nodeId) => ({ campaign_id: "campaign", node_id: nodeId, state: nodeId === "fork-child" ? "pending" : "interrupted", prior_operation_id: nodeId === "fork-child" ? null : "crash-op", version: "revision-1" }), persistRetryTransition: () => { log.push("persist"); return { ok: true }; } };
}
const request: ContinuationPreparationRequest = { authorization_id: "auth", idempotency_key: "key", operation_id: "recovery-op", prior_operation_id: "crash-op", expected_version: "revision-1", actor_id: "operator", actor_role: "operator", reason: "continue", dispositions: [], authorized_at: "2026-08-12T00:00:00.000Z" };

describe("RecoveryService.prepareContinuation", () => {
  it("orders reconciliation, every fresh admission, durable authorization, tree transition, then supervised readiness", () => {
    const log: string[] = []; const journal = sourceJournal();
    const original = journal.activateContinuationAuthorization.bind(journal);
    // Observe `activateContinuationAuthorization`, the step that actually makes
    // the authorization durable. `RecoveryService` calls the stage/activate
    // primitives directly and nothing in src calls the composed
    // `recordContinuationAuthorization` helper, so patching that left
    // "authorize-durable" permanently absent from the log and made this
    // ordering assertion unsatisfiable.
    Object.defineProperty(journal, "activateContinuationAuthorization", { value: (value: Parameters<HarnessSessionJournal["activateContinuationAuthorization"]>[0]) => { log.push("authorize-durable"); return original(value); } });
    const supervisor = new TaskSupervisor();
    const service = new RecoveryService(campaign(log), supervisor, leases(log), 100, { journal, admissions: authority(log) });
    expect(service.prepareContinuation("campaign", "node", request)).toMatchObject({ status: "ready", authorization: { new_session_id: "continuation:auth" }, replayed: false });
    expect(log).toEqual(["resolve-old", "acquire", "isolation", "admit", "persist", "authorize-durable"]);
    expect(supervisor.get("recovery:recovery-op")).toMatchObject({ state: "accepted" });
    expect(journal.pendingContinuation("campaign", "node")).toMatchObject({ authorization_id: "auth" });
  });

  it.each(FRESH_ADMISSION_KINDS)("fails closed when fresh %s admission is denied", (kind) => {
    const log: string[] = []; const journal = sourceJournal();
    const service = new RecoveryService(campaign(log), new TaskSupervisor(), leases(log), 100, { journal, admissions: authority(log, kind) });
    expect(service.prepareContinuation("campaign", "node", { ...request, idempotency_key: `key-${kind}`, authorization_id: `auth-${kind}` })).toMatchObject({ status: "blocked", reason: expect.stringContaining(kind) });
    expect(log).toEqual(["resolve-old", "acquire", "isolation", "admit", "release"]);
    expect(journal.continuationByIdempotencyKey(`key-${kind}`)).toBeNull();
  });

  it("refuses to replay a durable authorization without re-confirming lease and supervisor liveness, and still conflicts changed identity reuse", () => {
    const log: string[] = []; const journal = sourceJournal();
    const service = new RecoveryService(campaign(log), new TaskSupervisor(), leases(log), 100, { journal, admissions: authority(log) });
    expect(service.prepareContinuation("campaign", "node", request)).toMatchObject({ status: "ready", replayed: false });
    // ADR-012 Alternatives 2, explicitly REJECTED: "Let the previous Specialist
    // resume by default. Rejected: process and lease liveness cannot be inferred
    // after a crash, and it would bypass fresh isolation evidence." Its resume
    // matrix names "Isolation passed, a lease exists, or an old result may be
    // accepted" as the outcome that must NOT happen. So a durable authorization
    // is NOT proof of a live lease or a registered supervisor task: replay must
    // re-confirm both, and this fixture has neither, so it fails closed.
    expect(service.prepareContinuation("campaign", "node", request)).toMatchObject({ status: "blocked", reason: expect.stringContaining("cannot establish a current isolated lease and registered supervisor task") });
    // A changed identity under the same idempotency key is still a conflict,
    // decided before any liveness question.
    expect(service.prepareContinuation("campaign", "node", { ...request, actor_id: "other" })).toMatchObject({ status: "conflict" });
  });

  it("keeps the new session unobservable and releases fresh isolation when authorization persistence fails", () => {
    const log: string[] = []; const journal = sourceJournal(); const supervisor = new TaskSupervisor();
    // Inject on `stageContinuationAuthorization`, NOT the composed
    // `recordContinuationAuthorization`. `RecoveryService` calls the stage and
    // activate primitives directly, and nothing in src calls the composed
    // helper at all -- so patching it made this test vacuous: the injected
    // failure never fired, and the case only "passed" because the flow was
    // blocked earlier at the disposition gate and never reached persistence at
    // all. It is the first persistence step, so it is the seam that decides
    // whether the authorization becomes durable.
    Object.defineProperty(journal, "stageContinuationAuthorization", { value: () => { log.push("authorization-write-failed"); return { ok: false, conflict: false, reason: "injected persistence failure" }; } });
    const service = new RecoveryService(campaign(log), supervisor, leases(log), 100, { journal, admissions: authority(log) });
    expect(service.prepareContinuation("campaign", "node", request)).toEqual({ status: "blocked", reason: "injected persistence failure" });
    // No "persist" here on purpose. The durable authorization is STAGED before
    // the tree transition is persisted, and the `finally` block cancels the
    // staged authorization when the run does not become ready -- so a stage
    // that fails must never leave a persisted tree transition behind. The
    // previous expectation asserted "persist" ran first, which pinned an order
    // that persisted a transition this path then rolled back.
    expect(log).toEqual(["resolve-old", "acquire", "isolation", "admit", "authorization-write-failed", "release"]);
    expect(journal.pendingContinuation("campaign", "node")).toBeNull();
    expect(supervisor.list({ include_terminal: true })).toEqual([]);
  });

  it("requires an explicit disposition for an indeterminate in-flight effect", () => {
    const log: string[] = []; const journal = sourceJournal();
    journal.recordOperationCheckpoint({ session_id: "source", operation_id: "shell-call", operation_kind: "tool", operation: "shell.execute", phase: "prepared", effect_kind: "shell", repeatable: false, idempotency_key_hash: null, acknowledged_by: null, outcome: null, effect: null, compensation_id: null, occurred_at: "2026-08-12T00:00:00.000Z" });
    journal.recordOperationCheckpoint({ session_id: "source", operation_id: "shell-call", operation_kind: "tool", operation: "shell.execute", phase: "dispatched", effect_kind: "shell", repeatable: false, idempotency_key_hash: null, acknowledged_by: null, outcome: null, effect: null, compensation_id: null, occurred_at: "2026-08-12T00:00:01.000Z" });
    const service = new RecoveryService(campaign(log), new TaskSupervisor(), leases(log), 100, { journal, admissions: authority(log) });
    expect(service.prepareContinuation("campaign", "node", request)).toMatchObject({ status: "blocked", reason: expect.stringContaining("explicit disposition") });
    expect(log).toEqual([]);
    expect(service.prepareContinuation("campaign", "node", { ...request, dispositions: [{ operation_id: "shell-call", decision: "retry", reason: "operator verified external state" }] })).toMatchObject({ status: "ready" });
  });

  it("covers resume, respawn, and a replayed fork with fresh admissions and explicit effect disposition", () => {
    const log: string[] = []; const journal = sourceJournal();
    journal.recordOperationCheckpoint({ session_id: "source", operation_id: "external-write", operation_kind: "tool", operation: "shell.execute", phase: "prepared", effect_kind: "shell", repeatable: false, idempotency_key_hash: null, acknowledged_by: null, outcome: null, effect: null, compensation_id: null, occurred_at: "2026-08-12T00:00:00.000Z" });
    journal.recordOperationCheckpoint({ session_id: "source", operation_id: "external-write", operation_kind: "tool", operation: "shell.execute", phase: "dispatched", effect_kind: "shell", repeatable: false, idempotency_key_hash: null, acknowledged_by: null, outcome: null, effect: null, compensation_id: null, occurred_at: "2026-08-12T00:00:01.000Z" });
    const service = new RecoveryService(campaign(log), new TaskSupervisor(), leases(log), 100, { journal, admissions: authority(log) });
    const dispositions = [{ operation_id: "external-write", decision: "accept_observed" as const, reason: "operator confirmed the external effect" }];
    const resume = service.prepareContinuation("campaign", "node", { ...request, authorization_id: "resume-auth", idempotency_key: "resume-key", operation_id: "resume-op", dispositions, continuation_kind: "resume" });
    const respawn = service.prepareContinuation("campaign", "node", { ...request, authorization_id: "respawn-auth", idempotency_key: "respawn-key", operation_id: "respawn-op", dispositions, continuation_kind: "respawn" });
    const forkJournal = sourceJournal();
    forkJournal.recordEvent({ session_id: "source", sequence: 1, occurred_at: "2026-08-12T00:00:01.000Z", kind: "terminal", payload: { state: "completed", cause: "completed" } });
    const forkService = new RecoveryService(campaign(log), new TaskSupervisor(), leases(log), 100, { journal: forkJournal, admissions: authority(log) });
    const plan = forkService.previewSession("source");
    expect(plan).not.toBeNull();
    const forkRequest = { ...request, authorization_id: "fork-auth", idempotency_key: "fork-key", operation_id: "fork-op", expected_version: "revision-1", dispositions: [], continuation_kind: "fork" as const };
    const fork = forkService.prepareFork(plan!, "fork-child", forkRequest);
    const replay = forkService.prepareFork(plan!, "fork-child", forkRequest);
    expect(resume).toMatchObject({ status: "ready", authorization: { continuation_kind: "resume" } });
    expect(respawn).toMatchObject({ status: "ready", authorization: { continuation_kind: "respawn" } });
    if (resume.status === "ready") expect(resume.authorization.admissions).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "worktree", admitted: true })]));
    if (respawn.status === "ready") expect(respawn.authorization.admissions).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "approval", admitted: true })]));
    expect(fork).toMatchObject({ status: "ready", authorization: { continuation_kind: "fork", node_id: "fork-child" }, replayed: false });
    // ADR-012: replay must re-confirm lease + supervisor liveness, so a second
    // identical fork request fails closed rather than replaying on the strength of
    // the durable record alone.
    expect(replay).toMatchObject({ status: "blocked", reason: expect.stringContaining("cannot establish a current isolated lease and registered supervisor task") });
    expect(log.filter((item) => item === "admit")).toHaveLength(3);
  });
});
