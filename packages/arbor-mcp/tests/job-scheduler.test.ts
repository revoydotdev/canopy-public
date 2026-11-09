import { describe, it, expect } from "vitest";
import { JobScheduler } from "../src/job-scheduler.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { ArborRuntime } from "../src/runtime.js";
import { CampaignManager } from "../src/manager.js";
import { TaskSupervisor } from "@arbor/core";

function makeRuntime(): { supervisor: TaskSupervisor; scheduler: JobScheduler; runtime: ArborRuntime } {
  const manager = new CampaignManager();
  const supervisor = new TaskSupervisor();
  const scheduler = new JobScheduler(supervisor);
  const runtime = new ArborRuntime({ manager, supervisor, job_scheduler: scheduler });
  return { supervisor, scheduler, runtime };
}

function submitRequest(id: string, op: string) {
  return {
    schema_version: 1 as const,
    metadata: { operation_id: `meta-${id}`, idempotency_key: `ik-${id}`, actor_id: "operator", correlation_id: "c1", requested_at: "2026-08-01T00:00:00.000Z" },
    command: { kind: "job.submit" as const, id, operation_id: op, job_kind: "specialist.expand", owner_scope_id: "c1", idempotency_key: `ik-${id}` },
  };
}

describe("JobScheduler service", () => {
  it("submits a job and it becomes supervised + started", async () => {
    const { scheduler, supervisor } = makeRuntime();
    const result = scheduler.submit({ id: "j1", operation_id: "op-1", kind: "specialist.expand", owner_scope_id: "c1", idempotency_key: "ik-1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dispatched).toBe(true);
      expect(result.job.id).toBe("j1");
      expect(supervisor.get("j1")?.state).toBe("started");
    }
  });

  it("is idempotent on replay and conflicts on different payload", async () => {
    const { scheduler } = makeRuntime();
    const first = scheduler.submit({ id: "j1", operation_id: "op-1", kind: "specialist.expand", owner_scope_id: "c1", idempotency_key: "ik-1" });
    const replay = scheduler.submit({ id: "j1", operation_id: "op-1", kind: "specialist.expand", owner_scope_id: "c1", idempotency_key: "ik-1" });
    const conflict = scheduler.submit({ id: "j2", operation_id: "op-1", kind: "other.kind", owner_scope_id: "other", idempotency_key: "ik-2" });
    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.dispatched).toBe(false);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error).toMatch(/different job/);
  });

  it("pause is a dispatch throttle that does not cancel running work", async () => {
    const { scheduler, supervisor } = makeRuntime();
    scheduler.submit({ id: "j1", operation_id: "op-1", kind: "specialist.expand", owner_scope_id: "c1", idempotency_key: "ik-1" });
    scheduler.pause();
    expect(scheduler.accepting).toBe(false);
    const blocked = scheduler.submit({ id: "j2", operation_id: "op-2", kind: "specialist.expand", owner_scope_id: "c1", idempotency_key: "ik-2" });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toMatch(/paused/);
    // running job is untouched by the pause
    expect(supervisor.get("j1")?.state).toBe("started");
    scheduler.resume();
    expect(scheduler.accepting).toBe(true);
    expect(scheduler.submit({ id: "j2", operation_id: "op-2", kind: "specialist.expand", owner_scope_id: "c1", idempotency_key: "ik-2" }).ok).toBe(true);
  });

  it("cancel requests cancellation; retry retries a failed job", async () => {
    const { scheduler, supervisor } = makeRuntime();
    scheduler.submit({ id: "j1", operation_id: "op-1", kind: "specialist.expand", owner_scope_id: "c1", idempotency_key: "ik-1" });
    const cancelled = scheduler.cancel("j1");
    expect(cancelled.ok).toBe(true);
    supervisor.acknowledgeCancellation("j1");
    expect(supervisor.get("j1")?.state).toBe("cancelled");

    // retry requires a live (non-terminal) task that can be retried
    scheduler.submit({ id: "j2", operation_id: "op-2", kind: "specialist.expand", owner_scope_id: "c1", idempotency_key: "ik-2" });
    supervisor.fail("j2");
    supervisor.completeCleanup("j2");
    const retried = scheduler.retry("j2");
    expect(retried.ok).toBe(true);
    expect(supervisor.get("j2")?.state).toBe("retrying");

    expect(scheduler.cancel("missing").ok).toBe(false);
    expect(scheduler.retry("missing").ok).toBe(false);
  });

  it("bounds the queued jobs", async () => {
    const supervisor = new TaskSupervisor();
    const scheduler = new JobScheduler(supervisor, { max_queued_jobs: 2 });
    for (let i = 0; i < 100; i += 1) {
      const result = scheduler.submit({ id: `j${i}`, operation_id: `op${i}`, kind: "specialist.expand", owner_scope_id: "c1", idempotency_key: `ik${i}` });
      if (!result.ok) {
        expect(result.error).toMatch(/full|paused/);
        return;
      }
    }
    throw new Error("expected the queue to fill");
  });
});

describe("catalog job surface", () => {
  it("submit/cancel/retry/pause/resume/list round-trip through the router", async () => {
    const { runtime } = makeRuntime();
    const router = new RuntimeCatalogRouter(runtime);
    const submit = await router.dispatchCommand(submitRequest("j1", "op-1"));
    expect(submit.ok).toBe(true);
    if (submit.ok) expect(submit.value).toMatchObject({ accepted: true });

    const list = router.executeQuery({ schema_version: 1, query_id: "jobs", query: { kind: "job.list" } });
    expect(list.ok).toBe(true);
    if (list.ok) expect((list.value as { jobs: unknown[] }).jobs.length).toBe(1);

    const pause = await router.dispatchCommand({ schema_version: 1, metadata: { operation_id: "p1", idempotency_key: "pk1", actor_id: "a", correlation_id: "c", requested_at: "2026-08-01T00:00:00.000Z" }, command: { kind: "job.pause" } });
    expect(pause.ok).toBe(true);
    expect(router.executeQuery({ schema_version: 1, query_id: "q", query: { kind: "job.list" } })).toMatchObject({ ok: true });
    const resume = await router.dispatchCommand({ schema_version: 1, metadata: { operation_id: "r1", idempotency_key: "rk1", actor_id: "a", correlation_id: "c", requested_at: "2026-08-01T00:00:00.000Z" }, command: { kind: "job.resume" } });
    expect(resume.ok).toBe(true);
  });

  it("enforces job.write capability for commands", async () => {
    const { runtime } = makeRuntime();
    const router = new RuntimeCatalogRouter(runtime, { granted_capabilities: new Set(["campaign.read"]) });
    const result = await router.dispatchCommand(submitRequest("j1", "op-1"));
    // command rejections surface as ok:true with value.accepted:false + error
    expect(result.ok).toBe(true);
    const value = result.ok ? result.value as { accepted?: boolean; error?: { code?: string } } : null;
    if (value?.accepted === false) {
      expect(value.error?.code).toBe("permission");
    } else {
      throw new Error("expected a rejected command with accepted:false");
    }
  });

  it("rejects malformed job envelopes at validation", async () => {
    const { runtime } = makeRuntime();
    const router = new RuntimeCatalogRouter(runtime);
    const bad = await router.dispatchCommand({ schema_version: 1, metadata: { operation_id: "m", idempotency_key: "ik", actor_id: "a", correlation_id: "c", requested_at: "2026-08-01T00:00:00.000Z" }, command: { kind: "job.submit", id: "", operation_id: "", job_kind: "", owner_scope_id: "", idempotency_key: "" } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("validation");
  });
});
