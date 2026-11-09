import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationRegistry, RuntimeEventStream, TaskSupervisor } from "@arbor/core";
import { CampaignManager } from "../src/manager.js";
import { ArborRuntime } from "../src/runtime.js";
import type { RecoveryLeaseAuthority } from "../src/recovery-service.js";

describe("ArborRuntime composition", () => {
  it("owns exactly the injected canonical services and exposes a read-only snapshot", () => {
    const manager = new CampaignManager();
    const supervisor = new TaskSupervisor();
    const events = new RuntimeEventStream("test-runtime");
    supervisor.register({ id: "task-1", operation_id: "op-1", kind: "campaign", owner_scope_id: "scope-1" });
    const runtime = new ArborRuntime({ manager, supervisor, event_stream: events });

    expect(runtime.manager).toBe(manager);
    expect(runtime.supervisor).toBe(supervisor);
    expect(runtime.operations).toBeInstanceOf(OperationRegistry);
    expect(runtime.eventStream).toBe(events);
    const snapshot = runtime.snapshot();
    expect(snapshot).toMatchObject({ ok: true, value: { cursor: { stream_id: "test-runtime", sequence: 0 } } });
    if (snapshot.value !== null) {
      expect(snapshot.value.value.campaigns).toEqual([]);
      expect(snapshot.value.value.tasks).toEqual([expect.objectContaining({ id: "task-1" })]);
    }
  });

  it("starts lifecycle participants once and is idempotent after startup", async () => {
    const calls: string[] = [];
    const runtime = new ArborRuntime({
      lifecycle: [{ name: "persistence", start: () => { calls.push("start"); }, close: () => { calls.push("close"); } }],
    });

    await expect(runtime.start()).resolves.toMatchObject({ ok: true, value: { state: "started", healthy: true } });
    await expect(runtime.start()).resolves.toMatchObject({ ok: true, value: { state: "started" } });
    expect(calls).toEqual(["start"]);
    await expect(runtime.close()).resolves.toMatchObject({ ok: true, value: { state: "closed" } });
    expect(calls).toEqual(["start", "close"]);
  });

  it("reports partial startup failure and closes already-started participants in reverse order", async () => {
    const calls: string[] = [];
    const runtime = new ArborRuntime({
      lifecycle: [
        { name: "first", start: () => { calls.push("first:start"); }, close: () => { calls.push("first:close"); } },
        { name: "broken", start: () => { calls.push("broken:start"); throw new Error("offline"); } },
      ],
    });

    const result = await runtime.start();
    expect(result.ok).toBe(false);
    expect(result.value).toMatchObject({ state: "failed", healthy: false });
    expect(result.failures).toContainEqual(expect.objectContaining({ code: "unavailable", source: "broken", diagnostic: "offline" }));
    expect(calls).toEqual(["first:start", "broken:start", "first:close"]);
  });

  it("continues closing after a participant failure and retains structured diagnostics", async () => {
    const calls: string[] = [];
    const runtime = new ArborRuntime({
      lifecycle: [
        { name: "first", start: () => undefined, close: () => { calls.push("first"); } },
        { name: "second", start: () => undefined, close: () => { calls.push("second"); throw new Error("teardown failed"); } },
      ],
    });
    await runtime.start();
    const result = await runtime.close();
    expect(result.ok).toBe(false);
    expect(result.value).toMatchObject({ state: "failed" });
    expect(result.failures).toContainEqual(expect.objectContaining({ source: "second", summary: "runtime participant failed to close" }));
    expect(calls).toEqual(["second", "first"]);
  });

  it("persists the complete supervisor projection on checkpoint and close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-runtime-"));
    try {
      const supervisor = new TaskSupervisor();
      supervisor.register({ id: "done", operation_id: "op-done", kind: "campaign", owner_scope_id: "scope" });
      supervisor.start("done");
      supervisor.complete("done");
      supervisor.register({ id: "live", operation_id: "op-live", kind: "campaign", owner_scope_id: "scope" });
      supervisor.start("live");
      const runtime = new ArborRuntime({ supervisor, persistence_dir: dir });
      expect(runtime.checkpointSupervisor()).toMatchObject({ ok: true });
      await expect(runtime.close()).resolves.toMatchObject({ ok: true, value: { state: "closed" } });

      const restarted = new ArborRuntime({ persistence_dir: dir });
      expect(restarted.supervisor.get("done")).toMatchObject({ state: "completed", cleanup: "pending" });
      expect(restarted.supervisor.get("live")).toMatchObject({ state: "started" });
      expect(restarted.health()).toMatchObject({ reconciliation_tasks: [expect.objectContaining({ id: "live", state: "started" })] });
      // `started` is restored as a record only; no runtime start or worker dispatch occurred.
      expect(restarted.health().state).toBe("new");
      expect(() => restarted.supervisor.reportProgress("live", 0.6)).toThrow(/requires reconciliation/);
      await restarted.start();
      expect(restarted.health().healthy).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces quarantined supervisor snapshots in health and snapshot projections", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-runtime-"));
    try {
      const supervisorDir = join(dir, "supervisor");
      mkdirSync(supervisorDir, { recursive: true });
      writeFileSync(join(supervisorDir, "tasks.json"), "{");
      const runtime = new ArborRuntime({ persistence_dir: dir });
      expect(runtime.health()).toMatchObject({
        persistence_diagnostics: [expect.objectContaining({ artifact: "supervisor_snapshot", code: "invalid_json" })],
        failures: [expect.objectContaining({ code: "corrupt_data", source: "supervisor_persistence" })],
      });
      const snapshot = runtime.snapshot();
      expect(snapshot.value?.value.lifecycle.persistence_diagnostics).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores operation records as reconciliation evidence and checkpoints them on close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-runtime-"));
    try {
      const operations = new OperationRegistry();
      operations.accept({ metadata: { operation_id: "op-live", idempotency_key: "key", correlation_id: "corr", actor_id: "operator", requested_at: "2026-08-01T12:00:00.000Z" }, capability: "campaign.write", fingerprint: "f" });
      operations.start("op-live", "task-live");
      const runtime = new ArborRuntime({ operations, persistence_dir: dir });
      expect(runtime.checkpointOperations()).toMatchObject({ ok: true });
      await runtime.close();
      const restarted = new ArborRuntime({ persistence_dir: dir });
      expect(restarted.health().reconciliation_operations).toMatchObject([expect.objectContaining({ operation_id: "op-live", state: "running" })]);
      expect(restarted.operations.requiresReconciliation("op-live")).toBe(true);
      expect(() => restarted.operations.complete("op-live", "unsafe")).toThrow(/requires reconciliation/);
      expect(restarted.snapshot().value?.value.operations).toEqual([expect.objectContaining({ operation_id: "op-live" })]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("leaves recoveryService null without a lease authority (G-03: no default worktree touch)", () => {
    expect(new ArborRuntime().recoveryService).toBeNull();
  });

  it("never writes token-epoch/native-campaign-budget state under the process cwd without persistence_dir (no default worktree touch)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "arbor-runtime-cwd-probe-"));
    const original = process.cwd();
    process.chdir(cwd);
    try {
      // eslint-disable-next-line no-new
      new ArborRuntime();
      expect(existsSync(join(cwd, ".arbor"))).toBe(false);
    } finally {
      process.chdir(original);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("composes a real RecoveryService from the manager/supervisor plus an injected lease authority (G-03)", () => {
    const manager = new CampaignManager();
    const supervisor = new TaskSupervisor();
    const leaseLog: string[] = [];
    const leases: RecoveryLeaseAuthority = {
      resolveOldLease: () => { leaseLog.push("resolve-old"); return "inactive"; },
      acquireFresh: () => { leaseLog.push("acquire"); return { ok: true, lease_id: "fresh-lease" }; },
      checkIsolation: () => { leaseLog.push("isolation"); return { worktree_isolated: true, starting_commit_correct: true }; },
      releaseFresh: () => { leaseLog.push("release"); },
    };
    const action = { description: "work", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed" };
    manager.startCampaign("campaign", "plan.md", action);
    const root = manager.getCampaignSnapshot("campaign")!.root_id;
    const [node] = manager.branch("campaign", root, [action]);
    const runtime = new ArborRuntime({ manager, supervisor, recovery_leases: leases });

    expect(runtime.recoveryService).not.toBeNull();
    const result = runtime.recoveryService!.execute({
      operation_id: "recover-1", idempotency_key: "recover-key", campaign_id: "campaign", node_id: node,
      prior_operation_id: "crashed-op", expected_version: manager.getCampaignVersion("campaign"),
      action: "retry", actor_id: "crown", actor_role: "crown", reason: "process crashed",
    });
    expect(result).toEqual({ status: "ready", operation_id: "recover-1", lease_id: "fresh-lease", task_id: "recovery:recover-1" });
    expect(leaseLog).toEqual(["resolve-old", "acquire", "isolation"]);
    // Real collaborators, not a hand-assembled RecoveryService: the manager
    // durably transitioned the node and the supervisor registered the task.
    expect(manager.getNodeInfo("campaign", node)?.state).toBe("pending");
    expect(supervisor.get("recovery:recover-1")).toMatchObject({ state: "accepted" });
  });
});
