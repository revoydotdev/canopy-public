/**
 * Wave 1 Lane A — "the loop as a job". Drives the real
 * `RuntimeCatalogRouter` (never internal calls) to prove:
 *   1. job.submit(CAMPAIGN_RUN_JOB_KIND) genuinely starts the tree-search loop.
 *   2. job.cancel reaches a live loop and stops the in-flight dispatch.
 *   3. tree.interrupt targeting the actively-expanding node reaches the same
 *      live loop (there is no finer-grained per-node signal — see runtime.ts).
 *   4. run state (running/halted/completed/cancelled) is observable purely
 *      through the existing job.list / campaign.snapshot catalog queries.
 *   5. a crashed job never auto-resumes; an operator must recover the stuck
 *      node and submit a fresh job (ADR-012).
 *
 * The LoopExecutor (specialist/critic dispatch) is the one injected seam —
 * exactly the mode loop.ts's own doc comment describes for unit tests. The
 * manager/supervisor/runtime/router underneath are always real instances,
 * never mocked.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action } from "@arbor/core";
import { runCampaign, type CampaignLoopConfig, type LoopExecutor } from "@arbor/opencode";
import { CampaignManager } from "../src/manager.js";
import { ArborRuntime, CAMPAIGN_RUN_JOB_KIND, type CampaignRunner, type CampaignRunOutcome } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import type { RecoveryLeaseAuthority } from "../src/recovery-service.js";

const root: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
const metadata = { operation_id: "op-1", idempotency_key: "key-1", correlation_id: "correlation-1", actor_id: "operator", requested_at: "2026-08-01T00:00:00.000Z" };

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

function approvingReview(): LoopExecutor["review"] {
  return async () => ({ approved: true, rationale: "looks good", critic_agent: "critic", measurement_validated: true, token_usage: { kind: "unavailable", reason: "test executor" } });
}

function deterministicExecutor(): LoopExecutor {
  return {
    async specialize() {
      return { output: "done", provenance: { tag: "claimed", claimant: "seed" }, token_usage: { kind: "unavailable", reason: "test executor" } };
    },
    review: approvingReview(),
  };
}

function deterministicCampaignRunner(manager: CampaignManager): CampaignRunner {
  return {
    async run(campaignId, signal): Promise<CampaignRunOutcome> {
      const report = await runCampaign({ manager, campaign_id: campaignId, executor: deterministicExecutor(), config: loopConfig(), signal });
      return { halted: report.halted, halt_reason: report.halt_reason, cancelled: report.cancelled, awaiting_user_input: report.awaiting_user_input };
    },
  };
}

/** Blocks the specialist dispatch until the loop's own AbortSignal fires — lets a test catch a run genuinely mid-flight. */
function blockingCampaignRunner(manager: CampaignManager): CampaignRunner {
  const executor: LoopExecutor = {
    specialize: (params) => new Promise((_resolve, reject) => {
      params.signal?.addEventListener("abort", () => reject(params.signal!.reason instanceof Error ? params.signal!.reason : new Error("aborted")));
    }),
    review: approvingReview(),
  };
  return {
    async run(campaignId, signal): Promise<CampaignRunOutcome> {
      const report = await runCampaign({ manager, campaign_id: campaignId, executor, config: loopConfig(), signal });
      return { halted: report.halted, halt_reason: report.halt_reason, cancelled: report.cancelled, awaiting_user_input: report.awaiting_user_input };
    },
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function jobState(router: RuntimeCatalogRouter, jobId: string): string | undefined {
  const jobs = router.executeQuery({ schema_version: 1, query_id: "jobs", query: { kind: "job.list", include_terminal: true } });
  if (!jobs.ok) return undefined;
  return (jobs.value as { jobs: { id: string; state: string }[] }).jobs.find((j) => j.id === jobId)?.state;
}

function startCommand(campaignId: string) {
  return { schema_version: 1 as const, metadata: { ...metadata, operation_id: `${campaignId}:start`, idempotency_key: `${campaignId}:start` }, command: { kind: "campaign.start" as const, campaign_id: campaignId, plan_path: "plan.md", root_action: root } };
}
function branchCommand(campaignId: string) {
  return { schema_version: 1 as const, metadata: { ...metadata, operation_id: `${campaignId}:branch`, idempotency_key: `${campaignId}:branch` }, command: { kind: "tree.branch" as const, campaign_id: campaignId, node_id: "root", actions: [{ ...root, description: "child" }] } };
}
function submitJobCommand(campaignId: string, jobId: string) {
  return { schema_version: 1 as const, metadata: { ...metadata, operation_id: `${jobId}:op`, idempotency_key: `${jobId}:key` }, command: { kind: "job.submit" as const, id: jobId, operation_id: `${jobId}:op`, job_kind: CAMPAIGN_RUN_JOB_KIND, owner_scope_id: campaignId, idempotency_key: `${jobId}:key` } };
}

function retryJobCommand(jobId: string) {
  return { schema_version: 1 as const, metadata: { ...metadata, operation_id: `${jobId}:retry`, idempotency_key: `${jobId}:retry` }, command: { kind: "job.retry" as const, job_id: jobId } };
}

describe("campaign.run as a supervised job (Wave 1 Lane A)", () => {
  it("drives campaign.start -> job.submit(campaign.run) -> observe -> halt through the real catalog router", async () => {
    const manager = new CampaignManager();
    const runtime = new ArborRuntime({ manager, campaign_runner: deterministicCampaignRunner(manager) });
    const router = new RuntimeCatalogRouter(runtime);
    const campaignId = "roundtrip";

    await expect(router.dispatchCommand(startCommand(campaignId))).resolves.toMatchObject({ ok: true, value: { accepted: true } });
    await expect(router.dispatchCommand(branchCommand(campaignId))).resolves.toMatchObject({ ok: true, value: { accepted: true } });

    const submitted = await router.dispatchCommand(submitJobCommand(campaignId, "job-1"));
    expect(submitted).toMatchObject({ ok: true, value: { accepted: true, dispatched: true, job: { state: "started" } } });

    await waitUntil(() => jobState(router, "job-1") === "completed");

    const jobs = router.executeQuery({ schema_version: 1, query_id: "jobs", query: { kind: "job.list", include_terminal: true } });
    expect(jobs).toMatchObject({ ok: true, value: { jobs: [{ id: "job-1", state: "completed" }] } });

    const snapshot = router.executeQuery({ schema_version: 1, query_id: "snap", query: { kind: "campaign.snapshot", campaign_id: campaignId } });
    expect(snapshot).toMatchObject({ ok: true, value: { halted: true, iterations_completed: 1 } });
  });

  it("job.cancel reaches a live campaign.run job and stops the in-flight dispatch", async () => {
    const manager = new CampaignManager();
    const runtime = new ArborRuntime({ manager, campaign_runner: blockingCampaignRunner(manager) });
    const router = new RuntimeCatalogRouter(runtime);
    const campaignId = "cancel-live";

    await router.dispatchCommand(startCommand(campaignId));
    await router.dispatchCommand(branchCommand(campaignId));
    const submitted = await router.dispatchCommand(submitJobCommand(campaignId, "job-2"));
    expect(submitted).toMatchObject({ ok: true, value: { dispatched: true } });

    const cancel = { schema_version: 1 as const, metadata: { ...metadata, operation_id: "cancel-op", idempotency_key: "cancel-key" }, command: { kind: "job.cancel" as const, job_id: "job-2" } };
    await expect(router.dispatchCommand(cancel)).resolves.toMatchObject({ ok: true, value: { accepted: true, job: { state: "cancel_requested" } } });

    await waitUntil(() => jobState(router, "job-2") === "cancelled");
  });

  it("job.retry re-dispatches a settled campaign.run after explicit operator recovery", async () => {
    const manager = new CampaignManager();
    let attempts = 0;
    const runner: CampaignRunner = {
      async run(): Promise<CampaignRunOutcome> {
        attempts += 1;
        if (attempts === 1) throw new Error("transient connector failure");
        return { halted: true, halt_reason: "complete", cancelled: false, awaiting_user_input: false };
      },
    };
    const runtime = new ArborRuntime({ manager, campaign_runner: runner });
    const router = new RuntimeCatalogRouter(runtime);
    const campaignId = "retry-live";

    await router.dispatchCommand(startCommand(campaignId));
    await router.dispatchCommand(branchCommand(campaignId));
    await router.dispatchCommand(submitJobCommand(campaignId, "job-retry"));
    await waitUntil(() => jobState(router, "job-retry") === "failed");

    await expect(router.dispatchCommand(retryJobCommand("job-retry"))).resolves.toMatchObject({
      ok: true,
      value: { accepted: true, job: { state: "retrying" } },
    });
    await waitUntil(() => jobState(router, "job-retry") === "completed");
    expect(attempts).toBe(2);
    expect(runtime.supervisor.get("job-retry")?.retry_attempt).toBe(1);
  });

  it("tree.interrupt targeting the actively-expanding node reaches the live campaign.run job (no finer-grained per-node signal exists)", async () => {
    const manager = new CampaignManager();
    const runtime = new ArborRuntime({ manager, campaign_runner: blockingCampaignRunner(manager) });
    const router = new RuntimeCatalogRouter(runtime);
    const campaignId = "interrupt-live";

    await router.dispatchCommand(startCommand(campaignId));
    await router.dispatchCommand(branchCommand(campaignId));
    const childId = manager.getCampaignSnapshot(campaignId)!.nodes.find((n) => n.parent_id === "root")!.id;
    await router.dispatchCommand(submitJobCommand(campaignId, "job-3"));

    await waitUntil(() => manager.getNodeInfo(campaignId, childId)?.state === "expanding");

    const interrupt = {
      schema_version: 1 as const,
      metadata: { ...metadata, operation_id: "interrupt-op", idempotency_key: "interrupt-key", expected_version: manager.getCampaignVersion(campaignId) },
      command: { kind: "tree.interrupt" as const, campaign_id: campaignId, node_id: childId, scope: "subtree" as const, reason: "operator stop", provenance: { tag: "claimed" as const, claimant: "operator" } },
    };
    await expect(router.dispatchCommand(interrupt)).resolves.toMatchObject({ ok: true, value: { accepted: true } });

    await waitUntil(() => jobState(router, "job-3") === "cancelled");
  });
});

describe("resume-mid-flight (Wave 1 Lane A todo 6)", () => {
  it("never auto-resumes a crashed campaign.run job; an operator must recover the stuck node and submit a fresh job", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-campaign-job-resume-"));
    try {
      const leases: RecoveryLeaseAuthority = {
        resolveOldLease: () => "inactive",
        acquireFresh: () => ({ ok: true, lease_id: "fresh-lease" }),
        checkIsolation: () => ({ worktree_isolated: true, starting_commit_correct: true }),
        releaseFresh: () => {},
      };
      const campaignId = "resume-live";

      // --- Process 1: submit a job, let it get stuck mid-expansion, "crash". ---
      const box1: { current: ArborRuntime | null } = { current: null };
      const runtime1 = new ArborRuntime({
        persistence_dir: dir,
        recovery_leases: leases,
        campaign_runner: { run: (id, signal) => blockingCampaignRunner(box1.current!.manager).run(id, signal) },
      });
      box1.current = runtime1;
      const router1 = new RuntimeCatalogRouter(runtime1);

      await router1.dispatchCommand(startCommand(campaignId));
      await router1.dispatchCommand(branchCommand(campaignId));
      const childId = runtime1.manager.getCampaignSnapshot(campaignId)!.nodes.find((n) => n.parent_id === "root")!.id;
      const submitted = await router1.dispatchCommand(submitJobCommand(campaignId, "job-crash"));
      expect(submitted).toMatchObject({ ok: true, value: { dispatched: true } });

      await waitUntil(() => runtime1.manager.getNodeInfo(campaignId, childId)?.state === "expanding");

      // Simulate a crash: durably checkpoint the in-flight state (the same
      // durability job.submit's own dispatch path now performs after every
      // mutation), then abandon runtime1 without a clean close/shutdown —
      // runtime1's blocked run is simply never awaited again.
      runtime1.checkpointSupervisor();
      runtime1.checkpointOperations();

      // --- Process 2: restart against the same persistence root. ---
      const box2: { current: ArborRuntime | null } = { current: null };
      const runtime2 = new ArborRuntime({
        persistence_dir: dir,
        recovery_leases: leases,
        campaign_runner: { run: (id, signal) => deterministicCampaignRunner(box2.current!.manager).run(id, signal) },
      });
      box2.current = runtime2;

      // The crashed job never auto-resumes: it is restored as reconciliation
      // evidence only, exactly like every other in-flight supervised task
      // (ADR-012 — recovery is operator-authorized, never an automatic
      // startup mutation). Nothing in ArborRuntime's constructor/start() ever
      // calls runCampaignJob.
      expect(runtime2.supervisor.get("job-crash")).toMatchObject({ state: "started" });
      expect(runtime2.health().reconciliation_tasks).toMatchObject([expect.objectContaining({ id: "job-crash", state: "started" })]);
      expect(() => runtime2.supervisor.reportProgress("job-crash", 0.5)).toThrow(/requires reconciliation/);
      // The campaign's own tree state survived independently in
      // CampaignManager's own durable projection, exactly where the crash
      // left it — the loop-as-job wrapper adds no second, parallel store.
      expect(runtime2.manager.getNodeInfo(campaignId, childId)?.state).toBe("expanding");

      // Every real CLI transport (server.ts, webui.ts, tui.ts) wires
      // `recovery_service: runtime.recoveryService` explicitly — the router
      // never reads it off the runtime implicitly.
      const router2 = new RuntimeCatalogRouter(runtime2, { recovery_service: runtime2.recoveryService ?? undefined });

      // Operator-authorized recovery (ADR-012, pre-existing recovery.retry):
      // un-stick the node the crash abandoned.
      const recover = {
        schema_version: 1 as const,
        metadata: { ...metadata, operation_id: "recover-op", idempotency_key: "recover-key", expected_version: runtime2.manager.getCampaignVersion(campaignId) },
        command: { kind: "recovery.retry" as const, campaign_id: campaignId, node_id: childId, prior_operation_id: "job-crash:op", reason: "process crashed mid-flight", lease: { lease_id: "stale", worktree_id: "worktree", expires_at: "2026-08-02T00:00:00.000Z" } },
      };
      await expect(router2.dispatchCommand(recover)).resolves.toMatchObject({ ok: true, value: { accepted: true } });
      expect(runtime2.manager.getNodeInfo(campaignId, childId)?.state).toBe("pending");

      // Operator submits a fresh job for the same campaign; the loop resumes
      // tree search from durable manager state under a different task id —
      // the stuck "job-crash" task is left untouched as a permanent audit
      // trace, never retried or mutated.
      const resubmit = await router2.dispatchCommand(submitJobCommand(campaignId, "job-resumed"));
      expect(resubmit).toMatchObject({ ok: true, value: { accepted: true, dispatched: true } });

      await waitUntil(() => jobState(router2, "job-resumed") === "completed");
      expect(runtime2.manager.getCampaignSnapshot(campaignId)).toMatchObject({ halted: true });
      expect(runtime2.supervisor.get("job-crash")).toMatchObject({ state: "started" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
