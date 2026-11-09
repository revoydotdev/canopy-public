import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupervisorTask } from "@arbor/core";
import { loadSupervisorSnapshot, saveSupervisorSnapshot } from "../src/supervisor-persist.js";

function task(overrides: Partial<SupervisorTask> = {}): SupervisorTask {
  return {
    id: "task-1", operation_id: "op-1", kind: "node.expand", owner_scope_id: "campaign-1", parent_id: null,
    state: "started", started_at: "2026-08-01T12:00:00.000Z", deadline_at: "2026-08-01T13:00:00.000Z",
    progress: 0.5, last_progress_at: null, last_heartbeat_at: null, progress_sequence: 0, retry_attempt: 2, cleanup: null, ...overrides,
  };
}

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "arbor-supervisor-"));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("supervisor persistence", () => {
  it("atomically round-trips versioned tasks, operation identity, and cleanup state", () => withTempDir((dir) => {
    const tasks = [task({ state: "cancel_requested", cleanup: null, last_progress_at: "2026-08-01T12:00:30.000Z", last_heartbeat_at: "2026-08-01T12:00:45.000Z", progress_sequence: 4 }), task({ id: "task-2", operation_id: "op-2", state: "cancelled", cleanup: "failed", progress: null })];
    saveSupervisorSnapshot(tasks, dir, "2026-08-01T12:01:00.000Z");
    const loaded = loadSupervisorSnapshot(dir);
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.value).toEqual({ schema_version: 1, saved_at: "2026-08-01T12:01:00.000Z", tasks });
    expect(loaded.reconciliation).toEqual([tasks[0]]);
    expect(existsSync(join(dir, "supervisor", "tasks.json"))).toBe(true);
  }));

  it("loads legacy snapshots and normalizes absent observation clocks", () => withTempDir((dir) => {
    saveSupervisorSnapshot([task()], dir);
    const path = join(dir, "supervisor", "tasks.json");
    const snapshot = JSON.parse(readFileSync(path, "utf-8"));
    delete snapshot.tasks[0].last_progress_at;
    delete snapshot.tasks[0].last_heartbeat_at;
    delete snapshot.tasks[0].progress_sequence;
    writeFileSync(path, JSON.stringify(snapshot));
    expect(loadSupervisorSnapshot(dir).reconciliation[0]).toMatchObject({ last_progress_at: null, last_heartbeat_at: null, progress_sequence: 0 });
  }));

  it("does not expose mutable snapshot records", () => withTempDir((dir) => {
    saveSupervisorSnapshot([task()], dir);
    const loaded = loadSupervisorSnapshot(dir);
    loaded.value!.tasks[0].state = "completed";
    expect(loadSupervisorSnapshot(dir).value!.tasks[0].state).toBe("started");
  }));

  it("quarantines malformed snapshots with a diagnostic", () => withTempDir((dir) => {
    const path = join(dir, "supervisor", "tasks.json");
    saveSupervisorSnapshot([task()], dir);
    writeFileSync(path, "{");
    const loaded = loadSupervisorSnapshot(dir);
    expect(loaded.value).toBeNull();
    expect(loaded.diagnostics).toContainEqual(expect.objectContaining({ artifact: "supervisor_snapshot", code: "invalid_json", quarantined_path: expect.any(String) }));
    expect(existsSync(loaded.diagnostics[0].quarantined_path!)).toBe(true);
  }));

  it("quarantines unsupported versions and invalid operation identity", () => withTempDir((dir) => {
    saveSupervisorSnapshot([task()], dir);
    const path = join(dir, "supervisor", "tasks.json");
    const value = JSON.parse(readFileSync(path, "utf-8"));
    value.schema_version = 99;
    writeFileSync(path, JSON.stringify(value));
    expect(loadSupervisorSnapshot(dir).diagnostics[0].code).toBe("unsupported_version");

    saveSupervisorSnapshot([task()], dir);
    const duplicate = JSON.parse(readFileSync(path, "utf-8"));
    duplicate.tasks.push({ ...duplicate.tasks[0], id: "task-2" });
    writeFileSync(path, JSON.stringify(duplicate));
    expect(loadSupervisorSnapshot(dir).diagnostics[0].code).toBe("invalid_shape");
  }));

  it("quarantines abandoned temporary writes without treating them as a live worker", () => withTempDir((dir) => {
    saveSupervisorSnapshot([task({ state: "accepted", started_at: null })], dir);
    const temporary = join(dir, "supervisor", ".tasks.crash.tmp");
    writeFileSync(temporary, "partial");
    const loaded = loadSupervisorSnapshot(dir);
    expect(loaded.value?.tasks).toHaveLength(1);
    expect(loaded.reconciliation).toEqual([task({ state: "accepted", started_at: null })]);
    expect(loaded.diagnostics).toContainEqual(expect.objectContaining({ artifact: "temporary_file", quarantined_path: expect.any(String) }));
  }));

  it("leaves a temporary snapshot owned by a live writer in place during concurrent recovery", () => withTempDir((dir) => {
    saveSupervisorSnapshot([task()], dir);
    const temporary = join(dir, "supervisor", ".tasks.4321.tmp");
    writeFileSync(temporary, "partial while writer is active");

    const loaded = loadSupervisorSnapshot(dir, { process_alive: (pid) => pid === 4321 });

    expect(existsSync(temporary)).toBe(true);
    expect(loaded.diagnostics).toContainEqual(expect.objectContaining({
      artifact: "temporary_file", code: "writer_active", path: temporary,
    }));
  }));

  it("quarantines a numeric-PID temporary snapshot only after its writer is gone", () => withTempDir((dir) => {
    saveSupervisorSnapshot([task()], dir);
    const temporary = join(dir, "supervisor", ".tasks.4321.tmp");
    writeFileSync(temporary, "partial after writer exit");

    const loaded = loadSupervisorSnapshot(dir, { process_alive: () => false });

    expect(existsSync(temporary)).toBe(false);
    expect(loaded.diagnostics).toContainEqual(expect.objectContaining({
      artifact: "temporary_file", code: "invalid_shape", quarantined_path: expect.any(String),
    }));
  }));
});
