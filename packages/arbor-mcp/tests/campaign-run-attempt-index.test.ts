import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CampaignRunAttemptIndex } from "../src/campaign-run-attempt-index.js";

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "arbor-campaign-run-attempts-"));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("CampaignRunAttemptIndex", () => {
  it("is ephemeral without a persistence dir and durable with one", () => withTempDir((dir) => {
    const ephemeral = new CampaignRunAttemptIndex();
    expect(ephemeral.isAvailable()).toBe(false);
    const durable = new CampaignRunAttemptIndex({ persistence_dir: dir });
    expect(durable.isAvailable()).toBe(true);
  }));

  it("records a normal attempt at ordinal 1 with no predecessor", () => withTempDir((dir) => {
    const index = new CampaignRunAttemptIndex({ persistence_dir: dir });
    const result = index.recordAttempt({ campaign_id: "c1", operation_id: "op-1", supervisor_task_id: "task-1" }, "none");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.replayed).toBe(false);
    expect(result.attempt.attempt_ordinal).toBe(1);
    expect(result.attempt.supersedes_attempt_id).toBeNull();
    expect(result.attempt.refusal).toBeNull();
    expect(result.attempt.campaign_id).toBe("c1");
    expect(existsSync(join(dir, "campaign-run-attempts", "attempts.json"))).toBe(true);
  }));

  it("is idempotent for a transport replay of the same operation_id", () => withTempDir((dir) => {
    const index = new CampaignRunAttemptIndex({ persistence_dir: dir });
    const first = index.recordAttempt({ campaign_id: "c1", operation_id: "op-1", supervisor_task_id: "task-1" }, "none");
    const replay = index.recordAttempt({ campaign_id: "c1", operation_id: "op-1", supervisor_task_id: "task-1" }, "none");
    expect(first.ok && replay.ok).toBe(true);
    if (!first.ok || !replay.ok) return;
    expect(replay.replayed).toBe(true);
    expect(replay.attempt.attempt_id).toBe(first.attempt.attempt_id);
    expect(index.list("c1")).toHaveLength(1);
  }));

  it("refuses a new attempt while the latest is still runnable, but allows it once terminal or reconciliation-required", () => withTempDir((dir) => {
    const index = new CampaignRunAttemptIndex({ persistence_dir: dir });
    index.recordAttempt({ campaign_id: "c1", operation_id: "op-1", supervisor_task_id: "task-1" }, "none");
    const blocked = index.recordAttempt({ campaign_id: "c1", operation_id: "op-2", supervisor_task_id: "task-2" }, "runnable");
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.reason).toMatch(/runnable/);
    expect(index.list("c1")).toHaveLength(1);

    const superseding = index.recordAttempt({ campaign_id: "c1", operation_id: "op-2", supervisor_task_id: "task-2" }, "terminal");
    expect(superseding.ok).toBe(true);
    if (!superseding.ok) return;
    expect(superseding.attempt.attempt_ordinal).toBe(2);
    expect(superseding.attempt.supersedes_attempt_id).toBe(index.byOperationId("op-1")!.attempt_id);

    const afterReconciliation = index.recordAttempt({ campaign_id: "c1", operation_id: "op-3", supervisor_task_id: "task-3" }, "reconciliation_required");
    expect(afterReconciliation.ok).toBe(true);
    if (!afterReconciliation.ok) return;
    expect(afterReconciliation.attempt.attempt_ordinal).toBe(3);
    expect(afterReconciliation.attempt.supersedes_attempt_id).toBe(superseding.attempt.attempt_id);
  }));

  it("records a durable refusal with no fake task and does not block a later admitted attempt", () => withTempDir((dir) => {
    const index = new CampaignRunAttemptIndex({ persistence_dir: dir });
    const refusal = index.recordRefusal({ campaign_id: "c1", operation_id: "op-1", code: "no_campaign_runner_configured", diagnostic_ref: null });
    expect(refusal.ok).toBe(true);
    if (!refusal.ok) return;
    expect(refusal.attempt.supervisor_task_id).toBeNull();
    expect(refusal.attempt.refusal).toEqual({ code: "no_campaign_runner_configured", diagnostic_ref: null, terminal_at: refusal.attempt.created_at });
    expect(refusal.attempt.attempt_ordinal).toBe(1);

    const admitted = index.recordAttempt({ campaign_id: "c1", operation_id: "op-2", supervisor_task_id: "task-1" }, "terminal");
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.attempt.attempt_ordinal).toBe(2);
    expect(admitted.attempt.supersedes_attempt_id).toBe(refusal.attempt.attempt_id);
  }));

  it("keeps campaigns independently ordinal-scoped", () => withTempDir((dir) => {
    const index = new CampaignRunAttemptIndex({ persistence_dir: dir });
    index.recordAttempt({ campaign_id: "c1", operation_id: "op-1", supervisor_task_id: "task-1" }, "none");
    const other = index.recordAttempt({ campaign_id: "c2", operation_id: "op-2", supervisor_task_id: "task-2" }, "none");
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(other.attempt.attempt_ordinal).toBe(1);
    expect(other.attempt.supersedes_attempt_id).toBeNull();
  }));

  it("durably round-trips across a fresh index instance over the same persistence dir", () => withTempDir((dir) => {
    const first = new CampaignRunAttemptIndex({ persistence_dir: dir });
    first.recordAttempt({ campaign_id: "c1", operation_id: "op-1", supervisor_task_id: "task-1" }, "none");
    first.recordAttempt({ campaign_id: "c1", operation_id: "op-2", supervisor_task_id: "task-2" }, "terminal");

    const reopened = new CampaignRunAttemptIndex({ persistence_dir: dir });
    expect(reopened.loadDiagnostics()).toEqual([]);
    expect(reopened.list("c1")).toHaveLength(2);
    expect(reopened.latestFor("c1")?.attempt_ordinal).toBe(2);
  }));

  it("quarantine-diagnoses a corrupt attempt file rather than throwing", () => withTempDir((dir) => {
    const first = new CampaignRunAttemptIndex({ persistence_dir: dir });
    first.recordAttempt({ campaign_id: "c1", operation_id: "op-1", supervisor_task_id: "task-1" }, "none");
    writeFileSync(join(dir, "campaign-run-attempts", "attempts.json"), "{ not json");

    const reopened = new CampaignRunAttemptIndex({ persistence_dir: dir });
    expect(reopened.list()).toHaveLength(0);
    expect(reopened.loadDiagnostics()).toContainEqual(expect.objectContaining({ code: "invalid_json" }));
  }));

  it("rejects a malformed admission input", () => withTempDir((dir) => {
    const index = new CampaignRunAttemptIndex({ persistence_dir: dir });
    const result = index.recordAttempt({ campaign_id: "", operation_id: "op-1", supervisor_task_id: "task-1" }, "none");
    expect(result.ok).toBe(false);
  }));

  it("does not persist to disk when composed without a persistence dir", () => {
    const index = new CampaignRunAttemptIndex();
    const result = index.recordAttempt({ campaign_id: "c1", operation_id: "op-1", supervisor_task_id: "task-1" }, "none");
    expect(result.ok).toBe(true);
    expect(index.list("c1")).toHaveLength(1);
  });
});
