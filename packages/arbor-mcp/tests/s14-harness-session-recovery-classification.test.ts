import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskSupervisor } from "@arbor/core";
import { HarnessSessionJournal } from "../src/harness-session-journal.js";
import { RecoveryService, type RecoveryCampaignPort, type RecoveryContinuationAdmissionAuthority, type RecoveryLeaseAuthority } from "../src/recovery-service.js";

/** Minimal, honest fakes for the two dependencies `previewContinuation`/`previewSession` never call — only `prepare*` (fork/continuation authorization) touches leases/admissions/campaign reads. */
const unusedLeases: RecoveryLeaseAuthority = {
  resolveOldLease: () => { throw new Error("not exercised by this test"); },
  acquireFresh: () => { throw new Error("not exercised by this test"); },
  checkIsolation: () => { throw new Error("not exercised by this test"); },
  releaseFresh: () => { throw new Error("not exercised by this test"); },
};
const unusedAdmissions: RecoveryContinuationAdmissionAuthority = {
  admit: () => { throw new Error("not exercised by this test"); },
};
const unusedCampaign: RecoveryCampaignPort = {
  readNode: () => { throw new Error("not exercised by this test"); },
};

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

/**
 * S14 (audit/2026-09-06-remediation, "Harness continuations"): live testing
 * (`scripts/live/s14-harness-continuations.mjs`) proved that a genuinely
 * live-interrupted session (real `tree.interrupt` -> real AbortController
 * cancellation -> the native worker's `interrupted()` result, which settles
 * a real terminal `{state: "interrupted", cause: "interrupted"}`) could
 * NEVER be resumed or respawned before this fix: `record`/`reduceEvent`
 * unconditionally forced `recovery: NO_HARNESS_SESSION_RECOVERY` the moment
 * ANY terminal was observed, and `RecoveryService.previewSession`/
 * `previewContinuation` require `recovery.kind === "recovery_required"` --
 * a state the journal only ever produced via `reconcileOrphanedSessions()`
 * (crash-orphan reconciliation at process restart), never for an in-process
 * graceful interrupt. This pins the corrected classification directly
 * through the real `HarnessSessionJournal` -> `RecoveryService` seam (no
 * internal registry/journal object is hand-built beyond real production
 * classes), and locks in that a normal completed/failed terminal is
 * unaffected (still not recoverable without a genuine crash orphan).
 */
describe("harness session recovery classification (S14 live-interrupt fix)", () => {
  function inspectionFor(sessionId: string, terminal: { state: "interrupted" | "completed" | "failed"; cause: "interrupted" | "completed" | "failed"; message: string; result?: "claimed" | "verified" | "failed" } | null) {
    return {
      session_id: sessionId, state: (terminal?.state ?? "running") as "running" | "interrupted" | "completed" | "failed", latest_sequence: 2, capabilities: [],
      lineage: { kind: "new" as const }, ephemeral: true,
      policy: { filesystem: "read_only" as const, approvals: "never" as const, tool_allow: [], tool_deny: [], workspace_roots: [], max_wall_clock_ms: 1_000, max_events: 10, network_allowed: false, ambient_plugins_allowed: false, user_configuration_allowed: false, inherited_credentials_allowed: false },
      terminal,
    };
  }

  it("marks a real live-interrupted session recovery_required, distinct from the crash-orphan reasons", () => {
    const persistence_dir = mkdtempSync(join(tmpdir(), "arbor-s14-recovery-"));
    dirs.push(persistence_dir);
    const journal = new HarnessSessionJournal({ persistence_dir });
    journal.recordStarted({ session_id: "s-interrupted", campaign_id: "c1", node_id: "n1", operation: "specialize", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "seed", state: "running", latest_sequence: 0 });
    journal.record({
      operation: "specialize", campaign_id: "c1", node_id: "n1", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "seed",
      inspection: inspectionFor("s-interrupted", { state: "interrupted", cause: "interrupted", message: "execution aborted" }),
      events: [{ protocol_version: "1", session_id: "s-interrupted", sequence: 1, occurred_at: "2026-09-06T00:00:00.000Z", kind: "terminal", payload: { state: "interrupted", cause: "interrupted", message: "execution aborted" } }],
    });

    const summary = journal.inspect("s-interrupted");
    expect(summary?.terminal).toMatchObject({ state: "interrupted", cause: "interrupted" });
    expect(summary?.recovery).toEqual({
      kind: "recovery_required", reason: "interrupted_with_terminal", automatic_replay: false,
      checkpoint: { state: "interrupted", latest_sequence: 2 },
    });

    // This is the exact predicate `RecoveryService.previewContinuation`
    // (recovery-service.ts) filters on -- assert through the real service,
    // not by re-deriving its condition.
    const service = new RecoveryService(unusedCampaign, new TaskSupervisor(), unusedLeases, 100, { journal, admissions: unusedAdmissions });
    const plans = service.previewContinuation("c1", "n1");
    expect(plans).toHaveLength(1);
    expect(plans[0]?.source_session_id).toBe("s-interrupted");
    expect(service.previewSession("s-interrupted")?.source_session_id).toBe("s-interrupted");
  });

  it("does not mark a normal completed terminal recovery_required (no regression)", () => {
    const persistence_dir = mkdtempSync(join(tmpdir(), "arbor-s14-recovery-completed-"));
    dirs.push(persistence_dir);
    const journal = new HarnessSessionJournal({ persistence_dir });
    journal.recordStarted({ session_id: "s-completed", campaign_id: "c1", node_id: "n1", operation: "specialize", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "seed", state: "running", latest_sequence: 0 });
    journal.record({
      operation: "specialize", campaign_id: "c1", node_id: "n1", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "seed",
      inspection: inspectionFor("s-completed", { state: "completed", cause: "completed", message: "done", result: "verified" }),
      events: [],
    });
    expect(journal.inspect("s-completed")?.recovery).toEqual({ kind: "not_required" });

    const service = new RecoveryService(unusedCampaign, new TaskSupervisor(), unusedLeases, 100, { journal, admissions: unusedAdmissions });
    // `previewContinuation` (what resume/respawn gate on) correctly excludes
    // it -- not recovery-required.
    expect(service.previewContinuation("c1", "n1")).toEqual([]);
    // `previewSession` (what FORK gates on) builds a plan for ANY terminal
    // source regardless of recovery disposition -- this is correct,
    // unrelated production behavior this fix must not disturb.
    expect(service.previewSession("s-completed")?.source_session_id).toBe("s-completed");
  });

  it("does not mark a normal failed terminal recovery_required (no regression)", () => {
    const persistence_dir = mkdtempSync(join(tmpdir(), "arbor-s14-recovery-failed-"));
    dirs.push(persistence_dir);
    const journal = new HarnessSessionJournal({ persistence_dir });
    journal.recordStarted({ session_id: "s-failed", campaign_id: "c1", node_id: "n1", operation: "specialize", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "seed", state: "running", latest_sequence: 0 });
    journal.record({
      operation: "specialize", campaign_id: "c1", node_id: "n1", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "seed",
      inspection: inspectionFor("s-failed", { state: "failed", cause: "failed", message: "specialist failed" }),
      events: [],
    });
    expect(journal.inspect("s-failed")?.recovery).toEqual({ kind: "not_required" });
  });

  it("still classifies a genuine crash orphan under its own restart reason, not the live-interrupt reason", () => {
    const persistence_dir = mkdtempSync(join(tmpdir(), "arbor-s14-recovery-orphan-"));
    dirs.push(persistence_dir);
    const journal = new HarnessSessionJournal({ persistence_dir });
    journal.recordStarted({ session_id: "s-orphan", campaign_id: "c1", node_id: "n1", operation: "specialize", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "seed", state: "running", latest_sequence: 0 });
    // No terminal is ever recorded -- this is what a crashed process leaves
    // behind. Reopening the journal reconciles it, matching `runtime.ts`'s
    // constructor-time `reconcileOrphanedSessions()` call.
    const reopened = new HarnessSessionJournal({ persistence_dir });
    expect(reopened.inspect("s-orphan")?.recovery).toMatchObject({ kind: "recovery_required", reason: "started_without_terminal" });
  });
});
