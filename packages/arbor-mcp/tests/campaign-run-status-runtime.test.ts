/**
 * ADR-093: drives the real `ArborRuntime.runCampaignJob` (the sole choke
 * point every canonical dispatch path funnels through) and
 * `ArborRuntime.getCampaignRunStatus` end to end — never the attempt index
 * or projector's internals directly. Persistence lives in its own throwaway
 * tmp directory per ADR-078 (never the repo's real `.arbor/`), so this never
 * races a sibling agent's concurrent checkout state.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action } from "@arbor/core";
import { runCampaign, type CampaignLoopConfig, type LoopExecutor } from "@arbor/opencode";
import { CampaignManager } from "../src/manager.js";
import { loadSupervisorSnapshot } from "../src/supervisor-persist.js";
import { ArborRuntime, CAMPAIGN_RUN_JOB_KIND, type CampaignRunner, type CampaignRunOutcome } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";

const root: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
const metadata = { operation_id: "op-1", idempotency_key: "key-1", correlation_id: "correlation-1", actor_id: "operator", requested_at: "2026-08-01T00:00:00.000Z" };

function loopConfig(): CampaignLoopConfig {
  return {
    max_iterations: 10, specialist_base_prompt: "specialist", critic_base_prompt: "critic",
    specialist_cap: { tier: "specialist" }, critic_cap: { tier: "critic" },
    score_ctx: () => ({ accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 100, total_visits: 1 }),
    use_worktrees: false, branch_actions: () => null,
  };
}

function approvingReview(): LoopExecutor["review"] {
  return async () => ({ approved: true, rationale: "looks good", critic_agent: "critic", measurement_validated: true, token_usage: { kind: "unavailable", reason: "test executor" } });
}

function deterministicCampaignRunner(manager: CampaignManager): CampaignRunner {
  const executor: LoopExecutor = {
    async specialize() { return { output: "done", provenance: { tag: "claimed", claimant: "seed" }, token_usage: { kind: "unavailable", reason: "test executor" } }; },
    review: approvingReview(),
  };
  return {
    async run(campaignId, signal): Promise<CampaignRunOutcome> {
      const report = await runCampaign({ manager, campaign_id: campaignId, executor, config: loopConfig(), signal });
      return { halted: report.halted, halt_reason: report.halt_reason, cancelled: report.cancelled, awaiting_user_input: report.awaiting_user_input };
    },
  };
}

/** Drives a real loop heartbeat through the runner callback supplied by ArborRuntime. */
function heartbeatCampaignRunner(manager: CampaignManager): CampaignRunner {
  return {
    async run(campaignId, signal, onHeartbeat): Promise<CampaignRunOutcome> {
      const executor: LoopExecutor = {
        async specialize() {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { output: "done", provenance: { tag: "claimed", claimant: "seed" }, token_usage: { kind: "unavailable", reason: "test executor" } };
        },
        review: approvingReview(),
        log(event) { if (event.type === "dispatch_heartbeat") onHeartbeat?.(); },
      };
      const report = await runCampaign({ manager, campaign_id: campaignId, executor, config: { ...loopConfig(), dispatch_heartbeat_ms: 1 }, signal });
      return { halted: report.halted, halt_reason: report.halt_reason, cancelled: report.cancelled, awaiting_user_input: report.awaiting_user_input };
    },
  };
}

/** Blocks the specialist dispatch until the loop's own AbortSignal fires. */
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

function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "arbor-campaign-run-status-"));
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
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

describe("ArborRuntime campaign-run attempt wiring (ADR-093)", () => {
  it("appends a durable attempt before job.submit makes the run observable, and getCampaignRunStatus reads it back terminal", () => withTempDir(async (dir) => {
    const manager = new CampaignManager({ persistence_dir: dir });
    const runtime = new ArborRuntime({ manager, persistence_dir: dir, campaign_runner: deterministicCampaignRunner(manager) });
    const router = new RuntimeCatalogRouter(runtime);
    const campaignId = "attempt-wiring";

    expect(runtime.campaignRunAttempts.isAvailable()).toBe(true);
    await router.dispatchCommand(startCommand(campaignId));
    await router.dispatchCommand(branchCommand(campaignId));
    const submitted = await router.dispatchCommand(submitJobCommand(campaignId, "job-1"));
    expect(submitted).toMatchObject({ ok: true, value: { dispatched: true } });

    const attempts = runtime.campaignRunAttempts.list(campaignId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.attempt_ordinal).toBe(1);
    expect(attempts[0]!.supervisor_task_id).toBe("job-1");

    const jobsQuery = () => router.executeQuery({ schema_version: 1, query_id: "jobs", query: { kind: "job.list", include_terminal: true } });
    await waitUntil(() => {
      const result = jobsQuery();
      return result.ok && (result.value as { jobs: { id: string; state: string }[] }).jobs.find((j) => j.id === "job-1")?.state === "completed";
    });

    const status = runtime.getCampaignRunStatus(campaignId);
    expect(status.ephemeral).toBe(false);
    expect(status.integrity_errors).toEqual([]);
    expect(status.latest).toHaveLength(1);
    expect(status.latest[0]).toMatchObject({ campaign_id: campaignId, attempt_ordinal: 1, state: "terminal", outcome: "completed", is_latest: true });
  }));

  it("checkpoints and publishes a task.changed heartbeat from a live loop dispatch", () => withTempDir(async (dir) => {
    const manager = new CampaignManager({ persistence_dir: dir });
    const runtime = new ArborRuntime({ manager, persistence_dir: dir, campaign_runner: heartbeatCampaignRunner(manager) });
    const router = new RuntimeCatalogRouter(runtime);
    const campaignId = "heartbeat-wiring";
    const subscription = runtime.eventStream.subscribe();
    const observed: ReturnType<typeof subscription.poll> = [];

    await router.dispatchCommand(startCommand(campaignId));
    await router.dispatchCommand(branchCommand(campaignId));
    await router.dispatchCommand(submitJobCommand(campaignId, "heartbeat-job"));

    let heartbeat: (typeof observed)[number] | undefined;
    await waitUntil(() => {
      observed.push(...subscription.poll());
      heartbeat = observed.find((envelope) => envelope.event.kind === "task.changed"
        && envelope.event.task.id === "heartbeat-job"
        && envelope.event.task.last_heartbeat_at !== null);
      return heartbeat !== undefined;
    });
    expect(heartbeat).toMatchObject({ event: { kind: "task.changed", task: {
      id: "heartbeat-job", state: "started", progress: null, progress_sequence: 0,
      last_progress_at: null, last_heartbeat_at: expect.any(String),
    } } });
    expect(loadSupervisorSnapshot(dir).value?.tasks.find((task) => task.id === "heartbeat-job")).toMatchObject({
      state: "started", progress_sequence: 0, last_progress_at: null, last_heartbeat_at: expect.any(String),
    });
    subscription.close();
  }));

  it("records a durable refusal with no fake task when no campaign runner is configured", () => withTempDir(async (dir) => {
    const manager = new CampaignManager({ persistence_dir: dir });
    const runtime = new ArborRuntime({ manager, persistence_dir: dir }); // no campaign_runner
    const router = new RuntimeCatalogRouter(runtime);
    const campaignId = "refusal-wiring";

    await router.dispatchCommand(startCommand(campaignId));
    await router.dispatchCommand(branchCommand(campaignId));
    const submitted = await router.dispatchCommand(submitJobCommand(campaignId, "job-refused"));
    expect(submitted.ok).toBe(true);

    const attempts = runtime.campaignRunAttempts.list(campaignId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.supervisor_task_id).toBeNull();
    expect(attempts[0]!.refusal?.code).toBe("no_campaign_runner_configured");

    const status = runtime.getCampaignRunStatus(campaignId);
    expect(status.latest[0]).toMatchObject({ state: "refused", reason: "no_campaign_runner_configured" });
  }));

  it("hydrates an orphaned attempt as reconciliation-required after a restart, without treating it as a surviving worker", () => withTempDir(async (dir) => {
    const managerA = new CampaignManager({ persistence_dir: dir });
    const runtimeA = new ArborRuntime({ manager: managerA, persistence_dir: dir, campaign_runner: blockingCampaignRunner(managerA) });
    const routerA = new RuntimeCatalogRouter(runtimeA);
    const campaignId = "restart-wiring";

    await routerA.dispatchCommand(startCommand(campaignId));
    await routerA.dispatchCommand(branchCommand(campaignId));
    const submitted = await routerA.dispatchCommand(submitJobCommand(campaignId, "job-orphan"));
    expect(submitted).toMatchObject({ ok: true, value: { dispatched: true } });
    // The task is genuinely mid-flight (blockingCampaignRunner never resolves on its own).

    // Simulate a process restart: a fresh runtime over the same persistence dir, no live worker survives.
    const managerB = new CampaignManager({ persistence_dir: dir });
    const runtimeB = new ArborRuntime({ manager: managerB, persistence_dir: dir, campaign_runner: blockingCampaignRunner(managerB) });

    const status = runtimeB.getCampaignRunStatus(campaignId);
    expect(status.latest).toHaveLength(1);
    expect(status.latest[0]).toMatchObject({ reconciliation_required: true, worker_liveness: "unknown_after_restart" });
    expect(status.latest[0]!.state).not.toBe("terminal");
  }));

  it("a subsequent admitted attempt supersedes the prior latest by ordinal/link without mutating its terminal record", () => withTempDir(async (dir) => {
    const manager = new CampaignManager({ persistence_dir: dir });
    const runtime = new ArborRuntime({ manager, persistence_dir: dir, campaign_runner: deterministicCampaignRunner(manager) });
    const router = new RuntimeCatalogRouter(runtime);
    const campaignId = "supersede-wiring";

    await router.dispatchCommand(startCommand(campaignId));
    await router.dispatchCommand(branchCommand(campaignId));
    await router.dispatchCommand(submitJobCommand(campaignId, "job-first"));
    const jobsQuery = (id: string) => {
      const result = router.executeQuery({ schema_version: 1, query_id: "jobs", query: { kind: "job.list", include_terminal: true } });
      return result.ok ? (result.value as { jobs: { id: string; state: string }[] }).jobs.find((j) => j.id === id)?.state : undefined;
    };
    await waitUntil(() => jobsQuery("job-first") === "completed");

    const firstAttempt = runtime.campaignRunAttempts.latestFor(campaignId)!;
    expect(firstAttempt.attempt_ordinal).toBe(1);

    // A fresh continuation run re-branches and resubmits, admitted once the prior task is terminal.
    await router.dispatchCommand(branchCommand(campaignId));
    await router.dispatchCommand(submitJobCommand(campaignId, "job-second"));
    await waitUntil(() => jobsQuery("job-second") === "completed");

    const secondAttempt = runtime.campaignRunAttempts.byOperationId("job-second:op")!;
    expect(secondAttempt.attempt_ordinal).toBe(2);
    expect(secondAttempt.supersedes_attempt_id).toBe(firstAttempt.attempt_id);

    // The prior attempt's own record is untouched.
    expect(runtime.campaignRunAttempts.get(firstAttempt.attempt_id)).toEqual(firstAttempt);
    const status = runtime.getCampaignRunStatus(campaignId);
    expect(status.attempts.find((s) => s.attempt_id === firstAttempt.attempt_id)!.is_latest).toBe(false);
    expect(status.attempts.find((s) => s.attempt_id === secondAttempt.attempt_id)!.is_latest).toBe(true);
  }));
});
