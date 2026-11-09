import { describe, expect, it } from "vitest";
import type { SupervisorTask } from "@arbor/core";
import type { CampaignRunAttempt } from "../src/campaign-run-attempt-index.js";
import { projectCampaignRunStatus, type CampaignRunStatusCampaignFact } from "../src/campaign-run-status-projection.js";

function task(overrides: Partial<SupervisorTask> = {}): SupervisorTask {
  return {
    id: "task-1", operation_id: "op-1", kind: "campaign.run", owner_scope_id: "c1", parent_id: null,
    state: "started", started_at: "2026-08-01T00:00:00.000Z", deadline_at: null,
    progress: null, last_progress_at: null, last_heartbeat_at: null, progress_sequence: 0, retry_attempt: 0, cleanup: null, ...overrides,
  };
}

function attempt(overrides: Partial<CampaignRunAttempt> = {}): CampaignRunAttempt {
  return {
    schema_version: 1, attempt_id: "crun_1", campaign_id: "c1", attempt_ordinal: 1,
    supervisor_task_id: "task-1", operation_id: "op-1", supersedes_attempt_id: null,
    created_at: "2026-08-01T00:00:00.000Z", refusal: null, ...overrides,
  };
}

function campaign(overrides: Partial<CampaignRunStatusCampaignFact> = {}): CampaignRunStatusCampaignFact {
  return { id: "c1", halted: false, terminal_outcome: "in_progress", ...overrides };
}

const baseInput = {
  reconciliation_required_task_ids: new Set<string>(),
  campaign_run_diagnostics: new Map<string, { code: string; summary: string }>(),
  ephemeral: false,
  as_of: "2026-08-01T00:01:00.000Z",
};

describe("projectCampaignRunStatus", () => {
  it("distinguishes queued from started, and a durable refusal carries no fake task", () => {
    const projection = projectCampaignRunStatus({
      ...baseInput,
      attempts: [
        attempt({ attempt_id: "crun_queued", supervisor_task_id: "task-queued" }),
        attempt({ attempt_id: "crun_started", attempt_ordinal: 2, campaign_id: "c2", operation_id: "op-2", supervisor_task_id: "task-started", supersedes_attempt_id: null }),
        attempt({ attempt_id: "crun_refused", attempt_ordinal: 1, campaign_id: "c3", operation_id: "op-3", supervisor_task_id: null, refusal: { code: "no_campaign_runner_configured", diagnostic_ref: null, terminal_at: "2026-08-01T00:00:00.000Z" } }),
      ],
      tasks: [
        task({ id: "task-queued", owner_scope_id: "c1", state: "accepted" }),
        task({ id: "task-started", owner_scope_id: "c2", state: "started" }),
      ],
      campaigns: [campaign({ id: "c1" }), campaign({ id: "c2" }), campaign({ id: "c3" })],
    });
    expect(projection.integrity_errors).toEqual([]);
    const byId = new Map(projection.attempts.map((s) => [s.attempt_id, s]));
    expect(byId.get("crun_queued")!.state).toBe("queued");
    expect(byId.get("crun_started")!.state).toBe("started");
    const refused = byId.get("crun_refused")!;
    expect(refused.state).toBe("refused");
    expect(refused.reason).toBe("no_campaign_runner_configured");
    expect(refused.outcome).toBeNull();
    expect(refused.worker_liveness).toBe("not_applicable");
  });

  it("distinguishes a recorded heartbeat from silence and reports bounded observation ages", () => {
    const projection = projectCampaignRunStatus({
      ...baseInput,
      attempts: [
        attempt({ attempt_id: "silent", supervisor_task_id: "silent-task" }),
        attempt({ attempt_id: "live", attempt_ordinal: 2, supervisor_task_id: "live-task", operation_id: "op-live" }),
      ],
      tasks: [
        task({ id: "silent-task", progress: null }),
        task({ id: "live-task", progress: 0.4, last_progress_at: "2026-08-01T00:00:30.000Z", last_heartbeat_at: "2026-08-01T00:00:45.000Z", progress_sequence: 3 }),
      ],
      campaigns: [campaign()],
    });
    expect(projection.attempts[0]).toMatchObject({ state: "started", last_progress_at: null, last_heartbeat_at: null, heartbeat_age_ms: null });
    expect(projection.attempts[1]).toMatchObject({
      state: "heartbeat", progress: 0.4, progress_sequence: 3,
      last_progress_at: "2026-08-01T00:00:30.000Z", last_heartbeat_at: "2026-08-01T00:00:45.000Z",
      progress_age_ms: 30_000, heartbeat_age_ms: 15_000,
    });
  });

  it("progress cannot appear to regress and reads directly off the supervisor snapshot", () => {
    const projection = projectCampaignRunStatus({
      ...baseInput,
      attempts: [attempt()],
      tasks: [task({ state: "started", progress: 0.4 })],
      campaigns: [campaign()],
    });
    expect(projection.attempts[0]!.state).toBe("progressed");
    expect(projection.attempts[0]!.progress).toBe(0.4);
  });

  it("produces distinct states for timeout, failure, refusal, completion, and cancel-request vs cancel-acknowledged", () => {
    const cases: Array<{ state: SupervisorTask["state"]; expected: string; outcome: string | null }> = [
      { state: "timed_out", expected: "terminal", outcome: "timed_out" },
      { state: "failed", expected: "terminal", outcome: "failed" },
      { state: "completed", expected: "terminal", outcome: "completed" },
      { state: "cancel_requested", expected: "cancel_requested", outcome: null },
      { state: "cancelled", expected: "terminal", outcome: "cancelled" },
    ];
    for (const testCase of cases) {
      const projection = projectCampaignRunStatus({
        ...baseInput,
        attempts: [attempt()],
        tasks: [task({ state: testCase.state })],
        campaigns: [campaign()],
      });
      expect(projection.attempts[0]!.state).toBe(testCase.expected);
      expect(projection.attempts[0]!.outcome).toBe(testCase.outcome);
    }
  });

  it("labels a restart-orphaned attempt reconciliation-required and preserves a prior terminal-cancelled attempt while its non-halted campaign stays resumable", () => {
    const projection = projectCampaignRunStatus({
      ...baseInput,
      reconciliation_required_task_ids: new Set(["task-orphan"]),
      attempts: [
        attempt({ attempt_id: "crun_cancelled", supervisor_task_id: "task-cancelled" }),
        attempt({ attempt_id: "crun_orphan", attempt_ordinal: 2, supervisor_task_id: "task-orphan", operation_id: "op-2", supersedes_attempt_id: "crun_cancelled" }),
      ],
      tasks: [
        task({ id: "task-cancelled", state: "cancelled" }),
        task({ id: "task-orphan", state: "started" }),
      ],
      campaigns: [campaign({ halted: false, terminal_outcome: "cancelled" })],
    });
    const cancelled = projection.attempts.find((s) => s.attempt_id === "crun_cancelled")!;
    expect(cancelled.state).toBe("terminal");
    expect(cancelled.outcome).toBe("cancelled");
    expect(cancelled.campaign_resumable).toBe(true);
    expect(cancelled.campaign_halted).toBe(false);

    const orphan = projection.attempts.find((s) => s.attempt_id === "crun_orphan")!;
    expect(orphan.reconciliation_required).toBe(true);
    expect(orphan.worker_liveness).toBe("unknown_after_restart");
    expect(orphan.state).toBe("started");
  });

  it("marks the highest-ordinal attempt latest and preserves the prior attempt's terminal record without mutation", () => {
    const projection = projectCampaignRunStatus({
      ...baseInput,
      attempts: [
        attempt({ attempt_id: "crun_1", attempt_ordinal: 1, supervisor_task_id: "task-1" }),
        attempt({ attempt_id: "crun_2", attempt_ordinal: 2, supervisor_task_id: "task-2", operation_id: "op-2", supersedes_attempt_id: "crun_1" }),
      ],
      tasks: [
        task({ id: "task-1", state: "cancelled" }),
        task({ id: "task-2", state: "started" }),
      ],
      campaigns: [campaign()],
    });
    const first = projection.attempts.find((s) => s.attempt_id === "crun_1")!;
    const second = projection.attempts.find((s) => s.attempt_id === "crun_2")!;
    expect(first.is_latest).toBe(false);
    expect(second.is_latest).toBe(true);
    expect(first.state).toBe("terminal");
    expect(first.outcome).toBe("cancelled");
    expect(second.supersedes_attempt_id).toBe("crun_1");
    expect(projection.latest.map((s) => s.attempt_id)).toEqual(["crun_2"]);
  });

  it("orders attempts deterministically by campaign id then ordinal, and marks ephemeral projections", () => {
    const projection = projectCampaignRunStatus({
      ...baseInput,
      ephemeral: true,
      attempts: [
        attempt({ attempt_id: "b2", campaign_id: "cb", attempt_ordinal: 2, supervisor_task_id: "tb2", operation_id: "op-b2" }),
        attempt({ attempt_id: "a1", campaign_id: "ca", attempt_ordinal: 1, supervisor_task_id: "ta1", operation_id: "op-a1" }),
        attempt({ attempt_id: "b1", campaign_id: "cb", attempt_ordinal: 1, supervisor_task_id: "tb1", operation_id: "op-b1" }),
      ],
      tasks: [
        task({ id: "tb2", owner_scope_id: "cb" }),
        task({ id: "ta1", owner_scope_id: "ca" }),
        task({ id: "tb1", owner_scope_id: "cb" }),
      ],
      campaigns: [campaign({ id: "ca" }), campaign({ id: "cb" })],
    });
    expect(projection.attempts.map((s) => s.attempt_id)).toEqual(["a1", "b1", "b2"]);
    expect(projection.attempts.every((s) => s.ephemeral)).toBe(true);
    expect(projection.ephemeral).toBe(true);
  });

  it("refuses an inconsistent join instead of choosing a convenient source: missing link and cross-campaign link fail closed", () => {
    const projection = projectCampaignRunStatus({
      ...baseInput,
      attempts: [
        attempt({ attempt_id: "crun_missing", supervisor_task_id: "task-missing" }),
        attempt({ attempt_id: "crun_cross", attempt_ordinal: 2, supervisor_task_id: "task-other-campaign", operation_id: "op-2" }),
      ],
      tasks: [task({ id: "task-other-campaign", owner_scope_id: "some-other-campaign" })],
      campaigns: [campaign()],
    });
    expect(projection.attempts).toEqual([]);
    expect(projection.integrity_errors).toHaveLength(2);
    expect(projection.integrity_errors.map((e) => e.attempt_id).sort()).toEqual(["crun_cross", "crun_missing"]);
    expect(projection.integrity_errors.every((e) => e.code === "integrity_unavailable")).toBe(true);
  });

  it("fails closed on a duplicate ordinal within one campaign", () => {
    const projection = projectCampaignRunStatus({
      ...baseInput,
      attempts: [
        attempt({ attempt_id: "crun_1", attempt_ordinal: 1, supervisor_task_id: "task-1" }),
        attempt({ attempt_id: "crun_2", attempt_ordinal: 1, supervisor_task_id: "task-2", operation_id: "op-2" }),
      ],
      tasks: [task({ id: "task-1" }), task({ id: "task-2" })],
      campaigns: [campaign()],
    });
    expect(projection.attempts).toHaveLength(1);
    expect(projection.integrity_errors).toContainEqual(expect.objectContaining({ attempt_id: "crun_2", code: "integrity_unavailable" }));
  });

  it("carries no raw secrets, stack, model/tool text, or paths — only closed codes and opaque references", () => {
    const projection = projectCampaignRunStatus({
      ...baseInput,
      campaign_run_diagnostics: new Map([["c1", { code: "campaign_run_failed", summary: "redacted summary only" }]]),
      attempts: [attempt()],
      tasks: [task({ state: "failed" })],
      campaigns: [campaign({ halted: true, terminal_outcome: "completed" })],
    });
    const status = projection.attempts[0]!;
    const serialized = JSON.stringify(status);
    expect(serialized).not.toMatch(/\/home\/|Bearer |api[_-]?key|sk-[a-zA-Z0-9]/i);
    expect(status.reason).toBe("campaign_run_failed");
    expect(status.diagnostic_ref).toBe("redacted summary only");
  });
});
