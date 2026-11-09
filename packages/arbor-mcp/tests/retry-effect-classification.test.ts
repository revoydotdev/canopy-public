import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action } from "@arbor/core";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import type { RecoveryContinuationAdmissionAuthority, RecoveryLeaseAuthority } from "../src/recovery-service.js";

// WA-31: `job.retry`/`task.retry` (both `idempotency: "required"` in
// RUNTIME_CATALOG) must consult the same conservative effect classifier the
// recovery flow authorizes continuations from before re-dispatching a task —
// never blindly retry over a spawned effect nobody durably observed the
// outcome of.

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const metadata = { operation_id: "op-1", idempotency_key: "key-1", correlation_id: "correlation-1", actor_id: "operator", requested_at: "2026-08-01T00:00:00.000Z" };

const root: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
const child: Action = { description: "work", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed" };

const leases: RecoveryLeaseAuthority = {
  resolveOldLease: () => "inactive",
  acquireFresh: () => ({ ok: true, lease_id: "lease-1" }),
  checkIsolation: () => ({ worktree_isolated: true, starting_commit_correct: true }),
  releaseFresh: () => {},
};
const admissions: RecoveryContinuationAdmissionAuthority = { admit: () => [] };

const checkpointBase = {
  operation_id: "provider-1", operation_kind: "provider" as const, operation: "reference-model",
  effect_kind: "provider" as const, repeatable: false, idempotency_key_hash: null, acknowledged_by: null,
  compensation_id: null,
};

/**
 * Builds two campaigns behind one persistence dir, then restarts (the only
 * way a harness session becomes durably `recovery_required`):
 *  - "blocked-campaign" has a session whose only checkpoint evidence
 *    crossed the effect boundary (`dispatched`) with no terminal settlement
 *    and no compensation contract — an INDETERMINATE effect.
 *  - "clean-campaign" has a session whose checkpoint evidence durably
 *    settled `succeeded` — an observed-complete effect, not indeterminate.
 */
function seedRestartedRuntime(): ArborRuntime {
  const persistence_dir = mkdtempSync(join(tmpdir(), "arbor-retry-classification-"));
  dirs.push(persistence_dir);
  const first = new ArborRuntime({ persistence_dir, recovery_leases: leases, recovery_continuation_admissions: admissions });

  first.manager.startCampaign("blocked-campaign", "plan.md", root);
  const blockedRootId = first.manager.getCampaignSnapshot("blocked-campaign")!.root_id;
  const blockedNode = first.manager.branch("blocked-campaign", blockedRootId, [child])[0]!;
  first.manager.expandNode("blocked-campaign", blockedNode, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
  first.harnessSessions!.recordStarted({
    session_id: "blocked-session", campaign_id: "blocked-campaign", node_id: blockedNode, operation: "specialize",
    connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "architect", state: "running", latest_sequence: 0,
  });
  for (const phase of ["prepared", "dispatched"] as const) {
    first.harnessSessions!.recordOperationCheckpoint({
      ...checkpointBase, session_id: "blocked-session", phase, outcome: null, effect: null, occurred_at: "2026-08-22T00:00:00.000Z",
    });
  }

  first.manager.startCampaign("clean-campaign", "plan.md", root);
  const cleanRootId = first.manager.getCampaignSnapshot("clean-campaign")!.root_id;
  const cleanNode = first.manager.branch("clean-campaign", cleanRootId, [child])[0]!;
  first.manager.expandNode("clean-campaign", cleanNode, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
  first.harnessSessions!.recordStarted({
    session_id: "clean-session", campaign_id: "clean-campaign", node_id: cleanNode, operation: "specialize",
    connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "architect", state: "running", latest_sequence: 0,
  });
  for (const phase of ["prepared", "dispatched"] as const) {
    first.harnessSessions!.recordOperationCheckpoint({
      ...checkpointBase, session_id: "clean-session", phase, outcome: null, effect: null, occurred_at: "2026-08-22T00:00:00.000Z",
    });
  }
  first.harnessSessions!.recordOperationCheckpoint({
    ...checkpointBase, session_id: "clean-session", phase: "settled", outcome: "succeeded", effect: "observed", occurred_at: "2026-08-22T00:01:00.000Z",
  });

  // Simulated process restart: both harness sessions are reconciled as
  // `interrupted`/`recovery_required` purely from durable evidence.
  return new ArborRuntime({ persistence_dir, recovery_leases: leases, recovery_continuation_admissions: admissions });
}

describe("job.retry/task.retry consult the effect classifier (WA-31)", () => {
  it("refuses job.retry over an indeterminate effect but retries once effects are settled", async () => {
    const restarted = seedRestartedRuntime();
    const router = new RuntimeCatalogRouter(restarted);

    restarted.jobScheduler.submit({ id: "blocked-job", operation_id: "blocked-job:operation", kind: "test.retry-probe", owner_scope_id: "blocked-campaign", idempotency_key: "blocked-submit" });
    restarted.supervisor.fail("blocked-job");
    restarted.supervisor.completeCleanup("blocked-job");

    restarted.jobScheduler.submit({ id: "clean-job", operation_id: "clean-job:operation", kind: "test.retry-probe", owner_scope_id: "clean-campaign", idempotency_key: "clean-submit" });
    restarted.supervisor.fail("clean-job");
    restarted.supervisor.completeCleanup("clean-job");

    const blockedRetry = await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "blocked-retry", idempotency_key: "blocked-retry" }, command: { kind: "job.retry", job_id: "blocked-job" } });
    expect(blockedRetry).toMatchObject({ ok: true, value: { accepted: false, error: { code: "conflict", summary: expect.stringContaining("indeterminate") } } });
    expect(restarted.supervisor.get("blocked-job")).toMatchObject({ state: "failed" });

    const cleanRetry = await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "clean-retry", idempotency_key: "clean-retry" }, command: { kind: "job.retry", job_id: "clean-job" } });
    expect(cleanRetry).toMatchObject({ ok: true, value: { accepted: true } });
    expect(restarted.supervisor.get("clean-job")).toMatchObject({ state: "retrying" });
  });

  it("refuses task.retry over an indeterminate effect but retries once effects are settled", async () => {
    const restarted = seedRestartedRuntime();
    const router = new RuntimeCatalogRouter(restarted);

    restarted.supervisor.register({ id: "blocked-task", operation_id: "blocked-task:operation", kind: "sibling.spawn", owner_scope_id: "blocked-campaign" });
    restarted.supervisor.start("blocked-task");
    restarted.supervisor.fail("blocked-task");
    restarted.supervisor.completeCleanup("blocked-task");

    restarted.supervisor.register({ id: "clean-task", operation_id: "clean-task:operation", kind: "sibling.spawn", owner_scope_id: "clean-campaign" });
    restarted.supervisor.start("clean-task");
    restarted.supervisor.fail("clean-task");
    restarted.supervisor.completeCleanup("clean-task");

    const blockedRetry = await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "blocked-task-retry", idempotency_key: "blocked-task-retry" }, command: { kind: "task.retry", task_id: "blocked-task" } });
    expect(blockedRetry).toMatchObject({ ok: true, value: { accepted: false, error: { code: "conflict", summary: expect.stringContaining("indeterminate") } } });
    expect(restarted.supervisor.get("blocked-task")).toMatchObject({ state: "failed" });

    const cleanRetry = await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "clean-task-retry", idempotency_key: "clean-task-retry" }, command: { kind: "task.retry", task_id: "clean-task" } });
    expect(cleanRetry).toMatchObject({ ok: true, value: { accepted: true } });
    expect(restarted.supervisor.get("clean-task")).toMatchObject({ state: "retrying" });
  });
});
