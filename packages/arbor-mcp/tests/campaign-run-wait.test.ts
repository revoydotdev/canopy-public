/**
 * `arbor task confirm --wait` needs an awaitable handle on the exact
 * supervised `campaign.run` job `runCampaignJob` already drives — see
 * `ArborRuntime.awaitCampaignRun` (runtime.ts). Before this, `runCampaignJob`
 * discarded its `campaignRunner.run(...)` promise entirely
 * (`void ...then(...)`), so a CLI invocation that submitted a job via
 * `taskcomposer.confirm` and then exited immediately killed the campaign
 * mid-execution.
 *
 * These tests drive the real `RuntimeCatalogRouter` job.submit path (the
 * same one `campaign-job-runner.test.ts` exercises) so the supervised task
 * lifecycle is genuine, never mocked. Only the `CampaignRunner` — the one
 * seam every real transport (CLI/MCP/webui/TUI) injects — is a fake, exactly
 * like `campaign-job-runner.test.ts`'s own doubles.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Action } from "@arbor/core";
import { runCampaign, type CampaignLoopConfig, type LoopExecutor } from "@arbor/opencode";
import { WorktreeManager } from "@arbor/campaign-support";
import { CampaignManager } from "../src/manager.js";
import { ArborRuntime, CAMPAIGN_RUN_JOB_KIND, type CampaignRunner, type CampaignRunOutcome } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { awaitConfirmedCampaign, taskResultExitCode, formatTaskConfirmSummary } from "../src/cli.js";
import { EXIT_CODES } from "../src/exit-codes.js";

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

/** Drives the real tree-search loop to completion, exactly like campaign-job-runner.test.ts's own runner. */
function deterministicCampaignRunner(manager: CampaignManager): { runner: CampaignRunner; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    runner: {
      async run(campaignId, signal): Promise<CampaignRunOutcome> {
        calls.push(campaignId);
        const report = await runCampaign({ manager, campaign_id: campaignId, executor: deterministicExecutor(), config: loopConfig(), signal });
        return { halted: report.halted, halt_reason: report.halt_reason, cancelled: report.cancelled, awaiting_user_input: report.awaiting_user_input };
      },
    },
  };
}

/** Blocks forever until the test resolves it — proves `awaitCampaignRun` genuinely waits on completion rather than returning a stale/fabricated value. */
function deferredCampaignRunner(): { runner: CampaignRunner; calls: string[]; resolve: (outcome: CampaignRunOutcome) => void } {
  const calls: string[] = [];
  let resolveFn!: (outcome: CampaignRunOutcome) => void;
  return {
    calls,
    resolve: (outcome) => resolveFn(outcome),
    runner: {
      run(campaignId): Promise<CampaignRunOutcome> {
        calls.push(campaignId);
        return new Promise<CampaignRunOutcome>((resolve) => { resolveFn = resolve; });
      },
    },
  };
}

/** A genuine operational failure — the executor/provider itself throws — never a cancellation. */
function rejectingCampaignRunner(): { runner: CampaignRunner; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    runner: {
      async run(campaignId): Promise<CampaignRunOutcome> {
        calls.push(campaignId);
        throw new Error(`simulated operational failure token=VERY_SECRET_VALUE ${"x".repeat(1_000)}`);
      },
    },
  };
}

/** Never settles the specialist dispatch until the loop's AbortSignal fires — same helper shape as campaign-job-runner.test.ts. */
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

describe("ArborRuntime.awaitCampaignRun (task confirm --wait's awaitable handle)", () => {
  it("returns a populated verified campaign_result for a deterministic task run", async () => {
    const manager = new CampaignManager();
    const runner: CampaignRunner = {
      async run(campaignId, signal) {
        const executor: LoopExecutor = {
          async specialize() { return { output: "verified", provenance: { tag: "verified", cmd: "fixture-check", exit: 0, stdout_hash: "sha256:test" }, token_usage: { kind: "unavailable", reason: "fixture" } }; },
          review: approvingReview(),
        };
        const report = await runCampaign({ manager, campaign_id: campaignId, executor, config: { ...loopConfig(), execution_strategy: { kind: "first_verified" } }, signal });
        return { halted: report.halted, halt_reason: report.halt_reason, cancelled: report.cancelled, awaiting_user_input: report.awaiting_user_input };
      },
    };
    const runtime = new ArborRuntime({ manager, campaign_runner: runner });
    const router = new RuntimeCatalogRouter(runtime);
    const campaignId = "wait-verified";
    const jobId = "job-wait-verified";
    await router.dispatchCommand(startCommand(campaignId));
    await router.dispatchCommand(branchCommand(campaignId));
    await router.dispatchCommand(submitJobCommand(campaignId, jobId));

    const result = await awaitConfirmedCampaign(runtime, undefined, { ok: true, value: { draft: { campaign_id: campaignId, job_id: jobId } } });
    expect(result).toMatchObject({ campaign_result: { campaign_id: campaignId, job_id: jobId, task_state: "completed", halted: true, halt_reason: "verified_result", best_node_state: "verified" } });
  });

  it("(a) resolves once the fake CampaignRunner completes, reflecting the terminal task state", async () => {
    const manager = new CampaignManager();
    const { runner, resolve } = deferredCampaignRunner();
    const runtime = new ArborRuntime({ manager, campaign_runner: runner });
    const router = new RuntimeCatalogRouter(runtime);
    const campaignId = "wait-a";

    await router.dispatchCommand(startCommand(campaignId));
    await router.dispatchCommand(branchCommand(campaignId));
    const submitted = await router.dispatchCommand(submitJobCommand(campaignId, "job-wait-a"));
    expect(submitted).toMatchObject({ ok: true, value: { dispatched: true } });

    // Not settled yet: the fake runner's promise is still pending.
    resolve({ halted: true, halt_reason: "manual", cancelled: false, awaiting_user_input: false });

    await expect(runtime.awaitCampaignRun(campaignId)).resolves.toEqual({ task_state: "completed", cancelled: false });
    expect(jobState(router, "job-wait-a")).toBe("completed");
  });

  it("(b) a failing runner surfaces as a failed terminal task state to the waiter, not a hang or unhandled rejection", async () => {
    const manager = new CampaignManager();
    const { runner, calls } = rejectingCampaignRunner();
    const runtime = new ArborRuntime({ manager, campaign_runner: runner });
    const router = new RuntimeCatalogRouter(runtime);
    const campaignId = "wait-b";

    await router.dispatchCommand(startCommand(campaignId));
    await router.dispatchCommand(branchCommand(campaignId));
    await router.dispatchCommand(submitJobCommand(campaignId, "job-wait-b"));

    // `.resolves` fails the assertion outright if the returned promise ever
    // rejects instead — this is the direct proof the waiter never sees an
    // unhandled rejection or a thrown error for an operational failure.
    const settlement = await runtime.awaitCampaignRun(campaignId);
    expect(settlement).toMatchObject({ task_state: "failed", diagnostic: { code: "campaign_run_failed" } });
    expect(settlement.diagnostic?.summary).toContain("simulated operational failure");
    expect(settlement.diagnostic?.summary).not.toContain("VERY_SECRET_VALUE");
    expect(settlement.diagnostic?.summary.length).toBeLessThanOrEqual(512);
    expect(runtime.health().campaign_run_diagnostics).toEqual([
      expect.objectContaining({ campaign_id: campaignId, code: "campaign_run_failed" }),
    ]);
    expect(calls).toEqual([campaignId]);
    expect(jobState(router, "job-wait-b")).toBe("failed");
  });

  it("(c) awaiting an already-settled campaign returns its final state without starting a second run", async () => {
    const manager = new CampaignManager();
    const { runner, calls } = deterministicCampaignRunner(manager);
    const runtime = new ArborRuntime({ manager, campaign_runner: runner });
    const router = new RuntimeCatalogRouter(runtime);
    const campaignId = "wait-c";

    await router.dispatchCommand(startCommand(campaignId));
    await router.dispatchCommand(branchCommand(campaignId));
    await router.dispatchCommand(submitJobCommand(campaignId, "job-wait-c"));
    await waitUntil(() => jobState(router, "job-wait-c") === "completed");

    const callsBeforeSecondWait = calls.length;
    await expect(runtime.awaitCampaignRun(campaignId)).resolves.toEqual({ task_state: "completed", cancelled: false });
    // Calling it again still returns the same settled outcome, still with no
    // additional invocation of the runner — no re-run, no second authority.
    await expect(runtime.awaitCampaignRun(campaignId)).resolves.toEqual({ task_state: "completed", cancelled: false });
    expect(calls.length).toBe(callsBeforeSecondWait);
    expect(calls).toEqual([campaignId]);
  });

  it("awaitCampaignRun on a campaign id that never had a tracked run resolves immediately with a null task_state", async () => {
    const runtime = new ArborRuntime({ manager: new CampaignManager() });
    await expect(runtime.awaitCampaignRun("never-submitted")).resolves.toEqual({ task_state: null, cancelled: false });
  });

  it("WA-12: a run that settles with CampaignRunOutcome.cancelled=true never reads as a completion — settlement, terminal_outcome, and exit code all reflect the cancellation", async () => {
    const manager = new CampaignManager();
    // Mirrors loop.test.ts:821-849's contract: the real loop leaves
    // `halted: false` on cancellation (the campaign itself stays resumable
    // — see manager.ts's `cancelledRuns` doc), so this stub reproduces
    // exactly that shape rather than a synthetic halted-and-cancelled one.
    const runner: CampaignRunner = {
      async run(): Promise<CampaignRunOutcome> {
        return { halted: false, halt_reason: null, cancelled: true, awaiting_user_input: false };
      },
    };
    const runtime = new ArborRuntime({ manager, campaign_runner: runner });
    const router = new RuntimeCatalogRouter(runtime);
    const campaignId = "wait-cancelled";
    const jobId = "job-wait-cancelled";
    await router.dispatchCommand(startCommand(campaignId));
    await router.dispatchCommand(branchCommand(campaignId));
    await router.dispatchCommand(submitJobCommand(campaignId, jobId));

    const settlement = await runtime.awaitCampaignRun(campaignId);
    expect(settlement).toMatchObject({ task_state: "cancelled", cancelled: true });
    expect(jobState(router, jobId)).toBe("cancelled");

    const result = await awaitConfirmedCampaign(runtime, undefined, { ok: true, value: { draft: { campaign_id: campaignId, job_id: jobId } } });
    expect((result as { campaign_result: { terminal_outcome: unknown; task_state: unknown } }).campaign_result).toMatchObject({
      terminal_outcome: "cancelled", task_state: "cancelled",
    });
    expect(taskResultExitCode(result)).not.toBe(EXIT_CODES.SUCCESS);
  });

  it("WA-12: interrupt()'s eager acknowledgeCancellationSubtree no longer gets silently overwritten back to completed", async () => {
    // Reproduces the actual root cause live-bench-observed: `runtime.interrupt()`
    // (the canonical SIGINT/tree.interrupt path) synchronously requests AND
    // acknowledges cancellation on the supervised campaign.run task — well
    // before `campaignRunner.run(...)` itself resolves. Before this fix,
    // `runCampaignJob`'s finalize only recognized `task.state ===
    // "cancel_requested"`, missed the already-terminal "cancelled" state, and
    // called `supervisor.complete(taskId)`, which overwrote it to "completed".
    const manager = new CampaignManager();
    const executor: LoopExecutor = {
      specialize: (params) => new Promise((_resolve, reject) => {
        params.signal?.addEventListener("abort", () => reject(params.signal!.reason instanceof Error ? params.signal!.reason : new Error("aborted")));
      }),
      review: approvingReview(),
    };
    const runner: CampaignRunner = {
      async run(campaignId, signal): Promise<CampaignRunOutcome> {
        const report = await runCampaign({ manager, campaign_id: campaignId, executor, config: loopConfig(), signal });
        return { halted: report.halted, halt_reason: report.halt_reason, cancelled: report.cancelled, awaiting_user_input: report.awaiting_user_input };
      },
    };
    const runtime = new ArborRuntime({ manager, campaign_runner: runner });
    const router = new RuntimeCatalogRouter(runtime);
    const campaignId = "wait-interrupt-cancel";
    const jobId = "job-interrupt-cancel";
    await router.dispatchCommand(startCommand(campaignId));
    await router.dispatchCommand(branchCommand(campaignId));
    await router.dispatchCommand(submitJobCommand(campaignId, jobId));

    await waitUntil(() => (manager.getCampaignSnapshot(campaignId)?.nodes ?? []).some((node) => node.state === "expanding"));
    const activeNode = manager.getCampaignSnapshot(campaignId)!.nodes.find((node) => node.state === "expanding")!.id;
    runtime.interrupt({
      campaign_id: campaignId, node_id: activeNode, operation_id: "test-interrupt-1", scope: "subtree",
      reason: "operator interrupt", expected_version: manager.getCampaignVersion(campaignId),
      provenance: { tag: "claimed", claimant: "test-operator" },
    });

    const settlement = await runtime.awaitCampaignRun(campaignId);
    expect(settlement.task_state).toBe("cancelled");
    expect(jobState(router, jobId)).toBe("cancelled");
  });

  it("(d) the default (no --wait) dispatch path remains non-blocking: job.submit returns without awaiting the runner", async () => {
    const manager = new CampaignManager();
    const runtime = new ArborRuntime({ manager, campaign_runner: blockingCampaignRunner(manager) });
    const router = new RuntimeCatalogRouter(runtime);
    const campaignId = "wait-d";

    await router.dispatchCommand(startCommand(campaignId));
    await router.dispatchCommand(branchCommand(campaignId));
    const submitted = await router.dispatchCommand(submitJobCommand(campaignId, "job-wait-d"));

    // The dispatch itself already resolved even though `blockingCampaignRunner`
    // never will on its own — proof `runCampaignJob` is still fire-and-forget
    // by default, exactly as before. `awaitCampaignRun` is opt-in only.
    expect(submitted).toMatchObject({ ok: true, value: { dispatched: true, job: { state: "started" } } });
    expect(jobState(router, "job-wait-d")).toBe("started");

    // Clean up the still-live job so it does not leak an unhandled rejection
    // once the test process tears down: cancel it and let it settle.
    await router.dispatchCommand({
      schema_version: 1 as const,
      metadata: { ...metadata, operation_id: "wait-d-cancel-op", idempotency_key: "wait-d-cancel-key" },
      command: { kind: "job.cancel" as const, job_id: "job-wait-d" },
    });
    await waitUntil(() => jobState(router, "job-wait-d") === "cancelled");
  });
});

describe("B1(cli)/U6 — honest exit codes and campaign_result for awaitConfirmedCampaign", () => {
  it("(c) taskResultExitCode reports PARTIAL, not SUCCESS, for a confirmed campaign that halted no_nodes with zero verified nodes", async () => {
    const manager = new CampaignManager();
    const runner: CampaignRunner = {
      async run(campaignId) {
        // Exactly the false-completion shape the B1 defect names: halted,
        // reason no_nodes, and nothing ever reached `verified` — reproduced
        // directly via the manager's own auto-halt authority (the same call
        // the canonical loop makes at loop.ts's no_nodes branch) rather than
        // depending on that off-limits file's scheduling internals.
        manager.completeAutoHalt(campaignId, "no_nodes");
        return { halted: true, halt_reason: "no_nodes", cancelled: false, awaiting_user_input: false };
      },
    };
    const runtime = new ArborRuntime({ manager, campaign_runner: runner });
    const router = new RuntimeCatalogRouter(runtime);
    const campaignId = "wait-hollow-halt";
    const jobId = "job-wait-hollow-halt";
    await router.dispatchCommand(startCommand(campaignId));
    await router.dispatchCommand(submitJobCommand(campaignId, jobId));

    const result = await awaitConfirmedCampaign(runtime, undefined, { ok: true, value: { draft: { campaign_id: campaignId, job_id: jobId } } });
    expect(result).toMatchObject({
      campaign_result: {
        campaign_id: campaignId, job_id: jobId, task_state: "completed", job_state: "settled",
        halted: true, halt_reason: "no_nodes", verified_nodes: 0, terminal_outcome: "failed",
      },
    });
    // The false-completion regression this defect is named for: this used to
    // read `task_state: "completed"` and exit 0 as if the run had succeeded.
    expect(taskResultExitCode(result)).toBe(EXIT_CODES.PARTIAL);
  });

  it("WA-41: a stubbed no_nodes campaign halt publishes to the notification inbox", async () => {
    // Before this fix, only native-session completion
    // (`recordSessionCompletionUx`) ever reached the notification inbox — a
    // supervised campaign run's own terminal halt (`completeAutoHalt`, the
    // exact call every real auto-halt path in loop.ts makes) never did.
    const manager = new CampaignManager();
    const runtime = new ArborRuntime({ manager });
    const router = new RuntimeCatalogRouter(runtime);
    const campaignId = "wait-halt-notify";
    await router.dispatchCommand(startCommand(campaignId));

    manager.completeAutoHalt(campaignId, "no_nodes");

    const notices = router.executeQuery({ schema_version: 1, query_id: "notifications-after-halt", query: { kind: "notification.list", project_id: campaignId } } as never);
    expect(notices).toMatchObject({
      ok: true,
      value: { notifications: [{ severity: "error", title: expect.stringContaining("no_nodes"), body: expect.stringContaining(campaignId) }] },
    });
    // Secret-free: only the halt reason and node counts, never free-text
    // node content, ever reach the notification body.
    if (notices.ok) {
      const body = (notices.value as { notifications: readonly { body: string }[] }).notifications[0]!.body;
      expect(body).not.toContain("specialist_output");
    }
  });

  it("WA-40: an isolation-gate refusal before any specialist runs populates run_diagnostic and appears in the --wait settlement summary", async () => {
    // Real git, real WorktreeManager, real isolation gate — the exact
    // "uncommitted product changes" refusal shape worktree.test.ts's own
    // "refuses a stale HEAD..." test proves at the WorktreeManager layer;
    // here it is driven through the whole supervised campaign.run path so
    // the settlement a real `task confirm --wait` caller sees is proven,
    // not just the isolated acquireLease call.
    const repo = mkdtempSync(join(tmpdir(), "arbor-wa40-"));
    spawnSync("git", ["init", "-q", repo], { stdio: "ignore" });
    spawnSync("git", ["-C", repo, "config", "user.email", "t@t"], { stdio: "ignore" });
    spawnSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "ignore" });
    writeFileSync(join(repo, "x.txt"), "hi\n");
    spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
    spawnSync("git", ["-C", repo, "commit", "-qm", "init"], { stdio: "ignore" });
    // Uncommitted product change: acquireLease refuses every node's isolation gate.
    writeFileSync(join(repo, "x.txt"), "dirty\n");
    try {
      const manager = new CampaignManager();
      const worktrees = new WorktreeManager({ repoRoot: repo });
      const executor = { async specialize() { throw new Error("must not run — isolation gate refuses before dispatch"); }, async review() { throw new Error("must not run"); } } as unknown as LoopExecutor;
      const runner: CampaignRunner = {
        async run(campaignId, signal): Promise<CampaignRunOutcome> {
          const report = await runCampaign({ manager, campaign_id: campaignId, executor, config: { ...loopConfig(), use_worktrees: true }, worktrees, signal });
          return { halted: report.halted, halt_reason: report.halt_reason, cancelled: report.cancelled, awaiting_user_input: report.awaiting_user_input };
        },
      };
      const runtime = new ArborRuntime({ manager, campaign_runner: runner });
      const router = new RuntimeCatalogRouter(runtime);
      const campaignId = "wait-isolation-gate";
      const jobId = "job-wait-isolation-gate";
      await router.dispatchCommand(startCommand(campaignId));
      await router.dispatchCommand(branchCommand(campaignId));
      await router.dispatchCommand(submitJobCommand(campaignId, jobId));

      const result = await awaitConfirmedCampaign(runtime, undefined, { ok: true, value: { draft: { campaign_id: campaignId, job_id: jobId } } });
      const campaignResult = (result as { campaign_result: { run_diagnostic: { summary: string } | null } }).campaign_result;
      expect(campaignResult.run_diagnostic?.summary).toContain("uncommitted product changes");
      expect(campaignResult.run_diagnostic?.summary).toContain("x.txt");
      expect(taskResultExitCode(result)).not.toBe(EXIT_CODES.SUCCESS);
      expect(formatTaskConfirmSummary(result)).toContain("Diagnostic: ");
      expect(formatTaskConfirmSummary(result)).toContain("uncommitted product changes");
    } finally {
      spawnSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("(d) awaitConfirmedCampaign reports job_state failed with diagnostics when the run job itself failed, and taskResultExitCode is FAILURE", async () => {
    const manager = new CampaignManager();
    const { runner } = rejectingCampaignRunner();
    const runtime = new ArborRuntime({ manager, campaign_runner: runner });
    const router = new RuntimeCatalogRouter(runtime);
    const campaignId = "wait-job-failed";
    const jobId = "job-wait-job-failed";
    await router.dispatchCommand(startCommand(campaignId));
    await router.dispatchCommand(branchCommand(campaignId));
    await router.dispatchCommand(submitJobCommand(campaignId, jobId));

    const result = await awaitConfirmedCampaign(runtime, undefined, { ok: true, value: { draft: { campaign_id: campaignId, job_id: jobId } } });
    expect(result).toMatchObject({ campaign_result: { campaign_id: campaignId, job_id: jobId, task_state: "failed", job_state: "failed" } });
    expect((result as { campaign_result: { run_diagnostic?: { summary?: string } } }).campaign_result.run_diagnostic?.summary).toContain("simulated operational failure");
    expect(taskResultExitCode(result)).toBe(EXIT_CODES.FAILURE);
  });

  it("(U6) never falls back to the bare envelope on an internal throw: campaign_result.error is embedded and taskResultExitCode is FAILURE", async () => {
    // A deliberately fake runtime surface whose read paths throw, proving the
    // catch branch (not a real reachable failure mode of `getCampaignSnapshot`,
    // which returns null rather than throwing) genuinely reports rather than
    // propagates.
    const throwingRuntime = {
      manager: { getCampaignSnapshot() { throw new Error("simulated snapshot failure VERY_SECRET_TOKEN"); } },
      awaitCampaignRun: async () => ({ task_state: "completed" as const }),
    } as unknown as ArborRuntime;
    const confirmResult = { ok: true, value: { draft: { campaign_id: "camp-throw", job_id: "job-throw" } } };

    const result = await awaitConfirmedCampaign(throwingRuntime, undefined, confirmResult);
    expect(result).toMatchObject({
      ok: true, value: { draft: { campaign_id: "camp-throw", job_id: "job-throw" } },
      campaign_result: { campaign_id: "camp-throw", job_id: "job-throw", error: expect.stringContaining("simulated snapshot failure") },
    });
    expect(taskResultExitCode(result)).toBe(EXIT_CODES.FAILURE);
  });
});
