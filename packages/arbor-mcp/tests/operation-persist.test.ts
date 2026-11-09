import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOperationSnapshot, saveOperationSnapshot } from "../src/operation-persist.js";
import { OperationRegistry, type OperationRecord } from "@arbor/core";

function operation(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    operation_id: "operation-1", idempotency_key: "idempotency-1", fingerprint: "fingerprint-1", capability: "campaign.start",
    actor_id: "operator", correlation_id: "correlation-1", accepted_at: "2026-08-01T12:00:00.000Z",
    state: "running", task_id: "task-1", result_summary: null, error: null, completed_at: null, ...overrides,
  };
}
function withTempDir(run: (dir: string) => void): void { const dir = mkdtempSync(join(tmpdir(), "arbor-operation-")); try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); } }

describe("operation registry persistence", () => {
  it("atomically round-trips operation and idempotency identities while flagging active records for reconciliation", () => withTempDir((dir) => {
    const records = [operation(), operation({ operation_id: "operation-2", idempotency_key: "idempotency-2", fingerprint: "fingerprint-2", state: "completed", result_summary: "done", completed_at: "2026-08-01T12:01:00.000Z" })];
    saveOperationSnapshot(records, dir, "2026-08-01T12:02:00.000Z");
    const loaded = loadOperationSnapshot(dir);
    expect(loaded.value).toEqual({ schema_version: 1, saved_at: "2026-08-01T12:02:00.000Z", operations: records });
    expect(loaded.reconciliation).toEqual([records[0]]);
    const registry = new OperationRegistry();
    expect(registry.restore(loaded.value!.operations)).toEqual(["operation-1"]);
    expect(registry.get("operation-1")?.idempotency_key).toBe("idempotency-1");
    expect(registry.requiresReconciliation("operation-1")).toBe(true);
    expect(existsSync(join(dir, "operations", "registry.json"))).toBe(true);
  }));

  it("rejects duplicate operation/idempotency identities without weakening validation", () => withTempDir((dir) => {
    expect(() => saveOperationSnapshot([operation(), operation({ operation_id: "operation-2" })], dir)).toThrow("duplicate");
    expect(() => saveOperationSnapshot([operation({ state: "completed", completed_at: null })], dir)).toThrow("terminal operation");
  }));

  it("quarantines malformed and unsupported snapshots", () => withTempDir((dir) => {
    saveOperationSnapshot([operation()], dir);
    const path = join(dir, "operations", "registry.json");
    writeFileSync(path, "{");
    expect(loadOperationSnapshot(dir).diagnostics[0]).toMatchObject({ artifact: "operation_snapshot", code: "invalid_json", quarantined_path: expect.any(String) });
    saveOperationSnapshot([operation()], dir);
    const value = JSON.parse(readFileSync(path, "utf-8")); value.schema_version = 9; writeFileSync(path, JSON.stringify(value));
    expect(loadOperationSnapshot(dir).diagnostics[0].code).toBe("unsupported_version");
  }));

  it("quarantines abandoned write temps without treating them as active operations", () => withTempDir((dir) => {
    saveOperationSnapshot([operation({ state: "accepted" })], dir);
    writeFileSync(join(dir, "operations", ".registry.crash.tmp"), "partial");
    const loaded = loadOperationSnapshot(dir);
    expect(loaded.reconciliation).toEqual([operation({ state: "accepted" })]);
    expect(loaded.diagnostics).toContainEqual(expect.objectContaining({ artifact: "temporary_file", quarantined_path: expect.any(String) }));
  }));
});
