import { describe, expect, it } from "vitest";
import { SupervisorInvariantError, TaskSupervisor } from "../src/task-supervisor.js";

const clock = (() => {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 1, 12, 0, tick++));
})();

function supervisor(retention = 10): TaskSupervisor {
  return new TaskSupervisor({ clock, terminal_retention: retention });
}

describe("TaskSupervisor registration and listing", () => {
  it("is idempotent by operation ID and lists only active work by default", () => {
    const tasks = supervisor();
    const input = { id: "t1", operation_id: "op1", kind: "campaign", owner_scope_id: "campaign-1" };
    expect(tasks.register(input)).toMatchObject({ id: "t1", state: "accepted" });
    expect(tasks.register(input)).toMatchObject({ id: "t1", state: "accepted" });
    expect(() => tasks.register({ ...input, id: "replacement" })).toThrow(SupervisorInvariantError);

    tasks.start("t1");
    tasks.complete("t1");
    expect(tasks.list()).toEqual([]);
    expect(tasks.list({ include_terminal: true })).toHaveLength(1);
  });

  it("records monotonic progress clocks, equal-time sequence order, and liveness-only heartbeats", () => {
    const times = [
      "2026-08-01T12:00:00.000Z", "2026-08-01T12:00:01.000Z", "2026-08-01T12:00:01.000Z",
      "2026-08-01T12:00:01.000Z", "2026-08-01T12:00:02.000Z", "2026-08-01T12:00:00.500Z",
    ].map((value) => new Date(value));
    const tasks = new TaskSupervisor({ clock: () => times.shift()!, terminal_retention: 10 });
    tasks.register({ id: "clocked", operation_id: "op-clocked", kind: "campaign", owner_scope_id: "scope" });
    tasks.start("clocked");
    expect(tasks.reportProgress("clocked", 0.25)).toMatchObject({ progress: 0.25, last_progress_at: "2026-08-01T12:00:01.000Z", progress_sequence: 1 });
    expect(tasks.reportProgress("clocked", 0.5)).toMatchObject({ progress: 0.5, last_progress_at: "2026-08-01T12:00:01.000Z", progress_sequence: 2 });
    expect(tasks.reportProgress("clocked", 0.5)).toMatchObject({ progress: 0.5, last_progress_at: "2026-08-01T12:00:01.000Z", progress_sequence: 3 });
    const heartbeat = tasks.reportHeartbeat("clocked");
    expect(heartbeat).toMatchObject({ progress: 0.5, last_progress_at: "2026-08-01T12:00:01.000Z", last_heartbeat_at: "2026-08-01T12:00:02.000Z", progress_sequence: 3 });
    expect(() => tasks.reportProgress("clocked", 0.75)).toThrow("progress observation time cannot move backwards");
    expect(tasks.get("clocked")).toMatchObject({ progress: 0.5, progress_sequence: 3, last_heartbeat_at: "2026-08-01T12:00:02.000Z" });
  });

  it("does not advance deadlines by itself and keeps its clock injected", () => {
    const tasks = supervisor();
    tasks.register({ id: "t1", operation_id: "op1", kind: "campaign", owner_scope_id: "scope", deadline_at: "2020-01-01T00:00:00.000Z" });
    expect(tasks.get("t1")?.state).toBe("accepted");
    tasks.timeout("t1");
    expect(tasks.get("t1")?.state).toBe("timed_out");
  });
});

describe("TaskSupervisor cancellation and parent cleanup", () => {
  it("propagates requests parent-first and acknowledgements child-first exactly once", () => {
    const tasks = supervisor();
    tasks.register({ id: "parent", operation_id: "op-parent", kind: "campaign", owner_scope_id: "scope" });
    tasks.register({ id: "z-child", operation_id: "op-z", kind: "worker", owner_scope_id: "scope", parent_id: "parent" });
    tasks.register({ id: "a-child", operation_id: "op-a", kind: "worker", owner_scope_id: "scope", parent_id: "parent" });
    tasks.register({ id: "grandchild", operation_id: "op-g", kind: "tool", owner_scope_id: "scope", parent_id: "a-child" });
    for (const id of ["parent", "z-child", "a-child", "grandchild"]) tasks.start(id);
    expect(tasks.requestCancellationSubtree("parent")).toEqual(["parent", "a-child", "grandchild", "z-child"]);
    expect(tasks.requestCancellationSubtree("parent")).toEqual([]);
    expect(tasks.acknowledgeCancellationSubtree("parent")).toEqual(["grandchild", "a-child", "z-child", "parent"]);
    expect(tasks.acknowledgeCancellationSubtree("parent")).toEqual([]);
  });

  it("requests cancellation once, aborts the signal, and requires acknowledgement", () => {
    const tasks = supervisor();
    tasks.register({ id: "t1", operation_id: "op1", kind: "agent", owner_scope_id: "scope" });
    tasks.start("t1");
    const signal = tasks.signalFor("t1");
    expect(signal.aborted).toBe(false);
    expect(tasks.requestCancellation("t1").state).toBe("cancel_requested");
    expect(signal.aborted).toBe(true);
    expect(tasks.requestCancellation("t1").state).toBe("cancel_requested");
    expect(() => tasks.complete("t1")).toThrow("must acknowledge cancellation");
    expect(tasks.acknowledgeCancellation("t1")).toMatchObject({ state: "cancelled", cleanup: "pending" });
    expect(tasks.acknowledgeCancellation("t1").state).toBe("cancelled");
  });

  it("cancels children when a parent terminates and prevents parent cleanup/removal from orphaning them", () => {
    const tasks = supervisor();
    tasks.register({ id: "parent", operation_id: "op-parent", kind: "campaign", owner_scope_id: "scope" });
    tasks.register({ id: "child", operation_id: "op-child", kind: "worker", owner_scope_id: "scope", parent_id: "parent" });
    tasks.start("parent");
    tasks.start("child");
    tasks.complete("parent");

    expect(tasks.get("child")).toMatchObject({ state: "cancel_requested" });
    expect(() => tasks.completeCleanup("parent")).toThrow("children must be terminal");
    tasks.acknowledgeCancellation("child");
    tasks.completeCleanup("child");
    expect(() => tasks.remove("parent")).toThrow("fully-cleaned");
    tasks.completeCleanup("parent");
    expect(() => tasks.remove("parent")).toThrow("remove children");
    tasks.remove("child");
    tasks.remove("parent");
    expect(tasks.list({ include_terminal: true })).toEqual([]);
  });
});

describe("TaskSupervisor retry and terminal retention", () => {
  it("requires cleanup before retry and replaces the abort controller for the new attempt", () => {
    const tasks = supervisor();
    tasks.register({ id: "t1", operation_id: "op1", kind: "worker", owner_scope_id: "scope" });
    tasks.start("t1");
    const firstSignal = tasks.signalFor("t1");
    tasks.fail("t1");
    expect(() => tasks.retry("t1")).toThrow("cleanup must complete");
    tasks.completeCleanup("t1");
    expect(tasks.retry("t1")).toMatchObject({ state: "retrying", retry_attempt: 1 });
    expect(tasks.signalFor("t1")).not.toBe(firstSignal);
    tasks.start("t1");
    expect(tasks.get("t1")?.state).toBe("started");
  });

  it("refuses a subtask retry after its own or an ancestor deadline", () => {
    const now = new Date("2026-08-01T12:00:01.000Z");
    const tasks = new TaskSupervisor({ clock: () => now });
    tasks.register({
      id: "parent", operation_id: "op-parent", kind: "campaign", owner_scope_id: "scope",
      deadline_at: "2026-08-01T12:00:00.000Z",
    });
    tasks.register({ id: "child", operation_id: "op-child", kind: "worker", owner_scope_id: "scope", parent_id: "parent" });
    tasks.start("parent");
    tasks.start("child");
    tasks.fail("child");
    tasks.completeCleanup("child");

    expect(() => tasks.retry("child")).toThrow("after parent's deadline");

    const ownDeadline = new TaskSupervisor({ clock: () => now });
    ownDeadline.register({
      id: "task", operation_id: "op-task", kind: "worker", owner_scope_id: "scope",
      deadline_at: "2026-08-01T12:00:00.000Z",
    });
    ownDeadline.fail("task");
    ownDeadline.completeCleanup("task");
    expect(() => ownDeadline.retry("task")).toThrow("after task's deadline");
  });

  it("prunes only safe terminal leaves, including bounded automatic retention", () => {
    const tasks = supervisor(1);
    tasks.register({ id: "one", operation_id: "op1", kind: "worker", owner_scope_id: "scope" });
    tasks.register({ id: "two", operation_id: "op2", kind: "worker", owner_scope_id: "scope" });
    tasks.complete("one");
    tasks.completeCleanup("one");
    tasks.complete("two");
    tasks.completeCleanup("two");
    expect(tasks.list({ include_terminal: true }).map((task) => task.id)).toEqual(["two"]);

    const family = supervisor();
    family.register({ id: "parent", operation_id: "op3", kind: "worker", owner_scope_id: "scope" });
    family.register({ id: "child", operation_id: "op4", kind: "worker", owner_scope_id: "scope", parent_id: "parent" });
    family.complete("parent");
    family.acknowledgeCancellation("child");
    family.completeCleanup("child");
    family.completeCleanup("parent");
    const ids = family.prune();
    expect(ids).toContain("child");
    expect(family.get("parent")).toBeDefined();
    expect(family.prune()).toContain("parent");
  });
});

describe("TaskSupervisor durable restoration", () => {
  it("atomically restores exact snapshots but marks active records reconciliation-only", () => {
    const active = {
      id: "active", operation_id: "op-active", kind: "worker", owner_scope_id: "scope", parent_id: null,
      state: "started" as const, started_at: "2026-08-01T12:00:00.000Z", deadline_at: "2026-08-01T13:00:00.000Z",
      progress: 0.4, last_progress_at: "2026-08-01T11:59:30.000Z", last_heartbeat_at: "2026-08-01T11:59:45.000Z", progress_sequence: 7, retry_attempt: 2, cleanup: null,
    };
    const terminal = {
      id: "done", operation_id: "op-done", kind: "worker", owner_scope_id: "scope", parent_id: null,
      state: "completed" as const, started_at: "2026-08-01T11:00:00.000Z", deadline_at: null,
      progress: 1, last_progress_at: null, last_heartbeat_at: null, progress_sequence: 0, retry_attempt: 0, cleanup: "completed" as const,
    };
    const tasks = supervisor();
    expect(tasks.restore([active, terminal])).toEqual({ restored_task_ids: ["active", "done"], reconciliation_required_task_ids: ["active"] });
    expect(tasks.get("active")).toEqual(active);
    expect(tasks.requiresReconciliation("active")).toBe(true);
    expect(tasks.requiresReconciliation("done")).toBe(false);
    expect(tasks.signalFor("active").aborted).toBe(false);
    expect(() => tasks.requestCancellation("active")).toThrow("requires reconciliation");
    expect(() => tasks.acknowledgeCancellation("active")).toThrow("requires reconciliation");
    expect(tasks.reconciliationTasks()).toEqual([active]);
  });

  it("normalizes legacy restored task snapshots without fabricating observation times", () => {
    const legacy: Record<string, unknown> = {
      id: "legacy", operation_id: "op-legacy", kind: "worker", owner_scope_id: "scope", parent_id: null,
      state: "started", started_at: "2026-08-01T12:00:00.000Z", deadline_at: null,
      progress: 0.4, retry_attempt: 0, cleanup: null,
    };
    const tasks = supervisor();
    tasks.restore([legacy as unknown as import("../src/runtime-contracts.js").SupervisorTask]);
    expect(tasks.get("legacy")).toMatchObject({ last_progress_at: null, last_heartbeat_at: null, progress_sequence: 0 });
  });

  it("rejects invalid snapshots atomically, including duplicates, parent errors, cycles, and lifecycle contradictions", () => {
    const valid = {
      id: "one", operation_id: "op-one", kind: "worker", owner_scope_id: "scope", parent_id: null,
      state: "accepted" as const, started_at: null, deadline_at: null, progress: null, last_progress_at: null, last_heartbeat_at: null, progress_sequence: 0, retry_attempt: 0, cleanup: null,
    };
    const brokenParent = { ...valid, id: "two", operation_id: "op-two", parent_id: "missing" };
    const tasks = supervisor();
    expect(() => tasks.restore([valid, brokenParent])).toThrow("unknown parent");
    expect(tasks.list({ include_terminal: true })).toEqual([]);
    expect(() => tasks.restore([{ ...valid, id: "a", operation_id: "a", parent_id: "b" }, { ...valid, id: "b", operation_id: "b", parent_id: "a" }])).toThrow("parent cycle");
    expect(() => tasks.restore([{ ...valid, id: "bad", operation_id: "bad", started_at: "2026-08-01T00:00:00.000Z" }])).toThrow("invalid lifecycle");
    expect(() => tasks.restore([valid, { ...valid }])).toThrow("duplicate restored task");
  });

  it("retains bounded operation tombstones through removal, then permits explicit release", () => {
    const tasks = new TaskSupervisor({ clock, operation_tombstone_retention: 1 });
    const registration = { id: "one", operation_id: "op-one", kind: "worker", owner_scope_id: "scope" };
    tasks.register(registration);
    tasks.complete("one");
    tasks.completeCleanup("one");
    tasks.remove("one");
    expect(() => tasks.register(registration)).toThrow("tombstone retention");
    expect(tasks.pruneOperationTombstones()).toEqual(["op-one"]);
    expect(tasks.register(registration)).toMatchObject({ id: "one", operation_id: "op-one" });
  });
});

describe("TaskSupervisor child lease reconciliation", () => {
  it("releases a completed child lease before admitting the next sibling", () => {
    const tasks = new TaskSupervisor({ clock, sibling_bounds: { maxNestingDepth: 4, maxSimultaneousSiblings: 1 } });
    tasks.register({ id: "parent", operation_id: "parent-op", kind: "campaign", owner_scope_id: "scope" });
    tasks.register({ id: "child-a", operation_id: "a-op", kind: "worker", owner_scope_id: "scope", parent_id: "parent" });
    expect(tasks.siblingLeases("parent")).toMatchObject([{ task_id: "child-a", parent_id: "parent" }]);
    expect(() => tasks.register({ id: "child-b", operation_id: "b-op", kind: "worker", owner_scope_id: "scope", parent_id: "parent" })).toThrow(/maxSimultaneousSiblings/);
    tasks.complete("child-a");
    expect(tasks.siblingLeases("parent")).toEqual([]);
    tasks.register({ id: "child-b", operation_id: "b-op", kind: "worker", owner_scope_id: "scope", parent_id: "parent" });
  });

  it("reconciles crashed restored descendants as a subtree and releases every slot", () => {
    const restored = new TaskSupervisor({ clock, sibling_bounds: { maxNestingDepth: 4, maxSimultaneousSiblings: 2 } });
    restored.restore([
      { id: "parent", operation_id: "parent-op", kind: "campaign", owner_scope_id: "scope", parent_id: null, state: "started", started_at: "2026-08-01T12:00:00.000Z", deadline_at: null, progress: 0.4, last_progress_at: null, last_heartbeat_at: null, progress_sequence: 0, retry_attempt: 0, cleanup: null },
      { id: "child-a", operation_id: "a-op", kind: "worker", owner_scope_id: "scope", parent_id: "parent", state: "started", started_at: "2026-08-01T12:00:01.000Z", deadline_at: null, progress: 0.2, last_progress_at: null, last_heartbeat_at: null, progress_sequence: 0, retry_attempt: 0, cleanup: null },
      { id: "child-b", operation_id: "b-op", kind: "worker", owner_scope_id: "scope", parent_id: "parent", state: "started", started_at: "2026-08-01T12:00:02.000Z", deadline_at: null, progress: 0.1, last_progress_at: null, last_heartbeat_at: null, progress_sequence: 0, retry_attempt: 0, cleanup: null },
    ]);
    expect(restored.siblingLeases("parent")).toHaveLength(2);
    expect(() => restored.register({ id: "late", operation_id: "late-op", kind: "worker", owner_scope_id: "scope", parent_id: "parent" })).toThrow(/requires reconciliation/);
    expect(restored.reconcile("parent", "failed").map((task) => task.id)).toEqual(["child-a", "child-b", "parent"]);
    expect(restored.siblingLeases("parent")).toEqual([]);
    expect(restored.reconciliationTasks()).toEqual([]);
    for (const id of ["child-a", "child-b", "parent"]) restored.completeCleanup(id);
  });

  it("turns expired restored work into timed-out terminal records without reviving it", () => {
    const restored = new TaskSupervisor({ clock: () => new Date("2026-08-01T12:00:10.000Z") });
    restored.restore([
      { id: "parent", operation_id: "parent-op", kind: "campaign", owner_scope_id: "scope", parent_id: null, state: "started", started_at: "2026-08-01T12:00:00.000Z", deadline_at: "2026-08-01T12:00:05.000Z", progress: 0.4, last_progress_at: null, last_heartbeat_at: null, progress_sequence: 0, retry_attempt: 0, cleanup: null },
      { id: "child", operation_id: "child-op", kind: "worker", owner_scope_id: "scope", parent_id: "parent", state: "started", started_at: "2026-08-01T12:00:01.000Z", deadline_at: "2026-08-01T12:00:20.000Z", progress: 0.2, last_progress_at: null, last_heartbeat_at: null, progress_sequence: 0, retry_attempt: 0, cleanup: null },
    ]);
    expect(restored.reconcileExpired()).toEqual(["child", "parent"]);
    expect(restored.get("parent")).toMatchObject({ state: "timed_out", cleanup: "pending" });
    expect(restored.get("child")).toMatchObject({ state: "timed_out", cleanup: "pending" });
    expect(() => restored.reconcile("parent", "failed")).not.toThrow();
  });
});
