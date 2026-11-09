import { describe, expect, it } from "vitest";
import { TaskSupervisor } from "@arbor/core";
import { HarnessSessionJournal } from "../src/harness-session-journal.js";
import { RecoveryService, type ContinuationPreparationRequest, type RecoveryCampaignPort, type RecoveryContinuationAdmissionAuthority, type RecoveryLeaseAuthority } from "../src/recovery-service.js";
import { FRESH_ADMISSION_KINDS, type FreshAdmissionResult } from "../src/recovery/contracts.js";
import type { ContinuationCapableExecutor } from "../src/recovery/continuation-plan.js";
import { createOpenCodeLoopExecutor, OPENCODE_LOOP_EXECUTOR_CONNECTOR_ID } from "../src/opencode-executor.js";

// WA-18: governed continuation context (`admitted_context`) was consumed
// only by the native connector. `opencode-executor.ts` had no way to say so,
// and `RecoveryService`'s continuation dispatch had no way to check —
// resume/fork/respawn would report `accepted: true` while quietly re-running
// the raw prompt through a connector that drops the admitted facts. This
// proves both halves: the real opencode executor's honest declaration, and
// the real dispatch refusal built on it.

function sourceJournal(): HarnessSessionJournal {
  const journal = new HarnessSessionJournal();
  journal.recordStarted({ session_id: "source", campaign_id: "campaign", node_id: "node", operation: "specialize", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "architect", state: "running", latest_sequence: 0 });
  // Settled provider checkpoint, matching the prepared -> dispatched -> settled
  // shape `native-agent-executor.ts` records. These cases assert the EXECUTOR
  // CAPABILITY dimension, which is only reachable once the session proves its
  // provider call completed; without it the classifier emits an indeterminate
  // pre-dispatch classification and `prepareContinuation` demands a
  // disposition, which is a different test entirely.
  const provider = { session_id: "source", operation_id: "source:provider:1:1", operation_kind: "provider", operation: "openrouter", effect_kind: "provider", repeatable: false, idempotency_key_hash: null, acknowledged_by: null, compensation_id: null } as const;
  journal.recordOperationCheckpoint({ ...provider, phase: "prepared", outcome: null, effect: null, occurred_at: "2026-08-12T00:00:00.000Z" });
  journal.recordOperationCheckpoint({ ...provider, phase: "dispatched", outcome: null, effect: null, occurred_at: "2026-08-12T00:00:00.500Z" });
  journal.recordOperationCheckpoint({ ...provider, phase: "settled", outcome: "succeeded", effect: "observed", occurred_at: "2026-08-12T00:00:01.000Z" });
  journal.reconcileOrphanedSessions();
  return journal;
}
function authority(): RecoveryContinuationAdmissionAuthority {
  return { admit: (input) => FRESH_ADMISSION_KINDS.map((kind): FreshAdmissionResult => ({ kind, admitted: true, evidence_id: kind === "worktree" ? input.isolation.lease_id : `${kind}:fresh`, reason: "freshly checked" })) };
}
function leases(): RecoveryLeaseAuthority {
  return {
    resolveOldLease: () => "inactive", acquireFresh: () => ({ ok: true, lease_id: "lease-new" }),
    checkIsolation: () => ({ worktree_isolated: true, starting_commit_correct: true }), releaseFresh: () => {},
  };
}
function campaign(): RecoveryCampaignPort {
  return { readNode: (_c, nodeId) => ({ campaign_id: "campaign", node_id: nodeId, state: "interrupted", prior_operation_id: "crash-op", version: "revision-1" }), persistRetryTransition: () => ({ ok: true }) };
}
const request: ContinuationPreparationRequest = { authorization_id: "auth", idempotency_key: "key", operation_id: "recovery-op", prior_operation_id: "crash-op", expected_version: "revision-1", actor_id: "operator", actor_role: "operator", reason: "continue", dispositions: [], authorized_at: "2026-08-12T00:00:00.000Z" };

describe("WA-18: continuation dispatch refuses a non-continuation-capable executor", () => {
  it("createOpenCodeLoopExecutor declares continuation_support: unsupported with a stable connector_id", () => {
    const executor = createOpenCodeLoopExecutor({ pushDevtoolsLine: () => {} } as never, () => {}, "c", { opencodeBin: "true" });
    expect(executor.continuation_support).toBe("unsupported");
    expect(executor.connector_id).toBe(OPENCODE_LOOP_EXECUTOR_CONNECTOR_ID);
  });

  it("prepareContinuation returns a typed unavailable status naming the connector when the executor is unsupported", () => {
    const journal = sourceJournal();
    const unsupported: ContinuationCapableExecutor = { connector_id: "opencode-cli-loop-executor", continuation_support: "unsupported" };
    const service = new RecoveryService(campaign(), new TaskSupervisor(), leases(), 100, { journal, admissions: authority() }, unsupported);
    const result = service.prepareContinuation("campaign", "node", request);
    expect(result).toMatchObject({ status: "unavailable", connector_id: "opencode-cli-loop-executor" });
    expect((result as { reason: string }).reason).toContain("opencode-cli-loop-executor");
    // No durable authorization or lease should be left behind by a refused dispatch.
    expect(journal.pendingContinuation("campaign", "node")).toBeNull();
  });

  it("prepareFork also refuses for an unsupported executor", () => {
    const journal = sourceJournal();
    journal.recordEvent({ session_id: "source", sequence: 1, occurred_at: "2026-08-12T00:00:01.000Z", kind: "terminal", payload: { state: "completed", cause: "completed" } });
    const unsupported: ContinuationCapableExecutor = { connector_id: "opencode-cli-loop-executor", continuation_support: "unsupported" };
    const service = new RecoveryService({ ...campaign(), readNode: (_c, nodeId) => ({ campaign_id: "campaign", node_id: nodeId, state: "pending", prior_operation_id: null, version: "revision-1" }) }, new TaskSupervisor(), leases(), 100, { journal, admissions: authority() }, unsupported);
    const plan = service.previewSession("source")!;
    const result = service.prepareFork(plan, "fork-child", { ...request, authorization_id: "fork-auth", idempotency_key: "fork-key" });
    expect(result).toMatchObject({ status: "unavailable", connector_id: "opencode-cli-loop-executor" });
  });

  it("is unchanged (still ready) when no executor capability is composed — the existing default", () => {
    const journal = sourceJournal();
    const service = new RecoveryService(campaign(), new TaskSupervisor(), leases(), 100, { journal, admissions: authority() });
    expect(service.prepareContinuation("campaign", "node", request)).toMatchObject({ status: "ready" });
  });

  it("rejects a mismatched interrupted operation before resolving or acquiring a lease", () => {
    const journal = sourceJournal();
    const log: string[] = [];
    const leaseAuthority: RecoveryLeaseAuthority = {
      resolveOldLease: () => { log.push("resolve"); return "inactive"; },
      acquireFresh: () => { log.push("acquire"); return { ok: true, lease_id: "lease-new" }; },
      checkIsolation: () => { log.push("isolation"); return { worktree_isolated: true, starting_commit_correct: true }; },
      releaseFresh: () => { log.push("release"); },
    };
    const service = new RecoveryService(campaign(), new TaskSupervisor(), leaseAuthority, 100, { journal, admissions: authority() });

    expect(service.prepareContinuation("campaign", "node", { ...request, prior_operation_id: "client-operation" })).toEqual({
      status: "conflict", reason: "prior_operation_id does not match the interrupted node outcome",
    });
    expect(log).toEqual([]);
    expect(journal.pendingContinuation("campaign", "node")).toBeNull();
  });

  it("a native-declaring executor is allowed through", () => {
    const journal = sourceJournal();
    const native: ContinuationCapableExecutor = { connector_id: "revoy-native", continuation_support: "native" };
    const service = new RecoveryService(campaign(), new TaskSupervisor(), leases(), 100, { journal, admissions: authority() }, native);
    expect(service.prepareContinuation("campaign", "node", request)).toMatchObject({ status: "ready" });
  });
});
