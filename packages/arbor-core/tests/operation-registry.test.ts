import { describe, expect, it } from "vitest";
import { OperationRegistry, OperationRegistryError } from "../src/operation-registry.js";

const clock = () => new Date("2026-08-01T12:00:00.000Z");
const registration = { metadata: { operation_id: "op-1", idempotency_key: "key-1", correlation_id: "corr", actor_id: "operator", requested_at: "2026-08-01T11:00:00.000Z" }, capability: "campaign.write", fingerprint: "sha:one" };

describe("OperationRegistry", () => {
  it("accepts idempotently, links tasks, and hides terminal records by default", () => {
    const registry = new OperationRegistry({ clock });
    expect(registry.accept(registration)).toMatchObject({ state: "accepted" });
    expect(registry.accept(registration)).toMatchObject({ operation_id: "op-1" });
    expect(() => registry.accept({ ...registration, fingerprint: "sha:other" })).toThrow("idempotency");
    registry.start("op-1", "task-1"); registry.complete("op-1", "done");
    expect(registry.list()).toEqual([]);
    expect(registry.list(true)).toMatchObject([expect.objectContaining({ task_id: "task-1", state: "completed" })]);
  });

  it("restores active records as reconciliation-only and retains bounded tombstones after pruning", () => {
    const active = { operation_id: "op-live", idempotency_key: "key-live", fingerprint: "f", correlation_id: "c", actor_id: "a", capability: "x", state: "running" as const, task_id: "task", result_summary: null, error: null, accepted_at: "2026-08-01T11:00:00.000Z", completed_at: null };
    const restored = new OperationRegistry({ restored_records: [active] });
    expect(restored.requiresReconciliation("op-live")).toBe(true);
    expect(() => restored.complete("op-live", "unsafe")).toThrow("requires reconciliation");

    const registry = new OperationRegistry({ clock, terminal_retention: 0, tombstone_retention: 1 });
    registry.accept(registration); registry.complete("op-1", "done");
    expect(registry.get("op-1")).toBeUndefined();
    expect(() => registry.accept(registration)).toThrow(OperationRegistryError);
    expect(registry.pruneTombstones()).toEqual(["key-1"]);
    expect(registry.accept(registration)).toMatchObject({ operation_id: "op-1" });
  });
});
