import { describe, expect, it } from "vitest";
import type { CampaignRunAttempt } from "../src/campaign-run-attempt-index.js";
import { projectCampaignRunStatus, type CampaignRunStatusCampaignFact } from "../src/campaign-run-status-projection.js";
import type { SupervisorTask } from "@arbor/core";
import {
  PROJECTION_FRESHNESS_CATALOG,
  isRegisteredProjectionClass,
  projectCampaignRunStatusLifecycle,
  resolveProjectionFreshnessPolicy,
} from "../src/projection-lifecycle-catalog.js";
import { initialProjectionLifecycle, type ProjectionClock } from "../src/projection-lifecycle.js";

function fakeClock(startIso: string): ProjectionClock & { advanceMs: (ms: number) => void } {
  let current = Date.parse(startIso);
  return { now: () => new Date(current).toISOString(), advanceMs: (ms: number) => { current += ms; } };
}

const REQUIRED_CLASSES = [
  "campaign.run.status",
  "evidence.transaction",
  "finalization.progress",
  "approvals.queue",
  "interviews.queue",
  "recovery.diagnostics",
  "governance.snapshot",
  "diagnostics.liveness",
] as const;

describe("PROJECTION_FRESHNESS_CATALOG (ADR-094 Decision §1 / §5.6)", () => {
  it("registers a freshness policy for every Decision §5.6 representative projection class", () => {
    for (const cls of REQUIRED_CLASSES) {
      expect(isRegisteredProjectionClass(cls)).toBe(true);
      const policy = resolveProjectionFreshnessPolicy(cls);
      expect(policy.projection_class).toBe(cls);
      expect(policy.fresh_for_ms).toBeGreaterThanOrEqual(0);
      expect(policy.max_poll_age_ms).toBeLessThanOrEqual(policy.fresh_for_ms === 0 ? 0 : Infinity);
    }
  });

  it("a polling declared maximum age never exceeds its own freshness budget (Decision §2)", () => {
    for (const policy of Object.values(PROJECTION_FRESHNESS_CATALOG)) {
      expect(policy.max_poll_age_ms).toBeLessThanOrEqual(policy.fresh_for_ms);
    }
  });

  it("throws rather than inventing a budget for an unregistered class", () => {
    expect(() => resolveProjectionFreshnessPolicy("not.a.registered.class")).toThrow(/no registered ADR-094 freshness policy/);
  });
});

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

describe("projectCampaignRunStatusLifecycle — ADR-093's projection carried in the ADR-094 envelope", () => {
  it("wraps a real CampaignRunStatusProjection as the envelope's domain value without reshaping it", () => {
    const status = projectCampaignRunStatus({
      attempts: [attempt()],
      tasks: [task()],
      campaigns: [campaign()],
      reconciliation_required_task_ids: new Set<string>(),
      campaign_run_diagnostics: new Map(),
      ephemeral: false,
    });

    const clock = fakeClock("2026-08-25T18:00:00.000Z");
    const initial = initialProjectionLifecycle<typeof status>("campaign.run.status");
    const wrapped = projectCampaignRunStatusLifecycle(initial, { status, clock, transport: "connected" });

    expect(wrapped.lifecycle).toBe("ready");
    expect(wrapped.projection_id).toBe("campaign.run.status");
    expect(wrapped.value).toBe(status);
    expect(wrapped.fresh_for_ms).toBe(PROJECTION_FRESHNESS_CATALOG["campaign.run.status"].fresh_for_ms);
    expect(wrapped.expires_at).toBe(new Date(Date.parse(clock.now()) + PROJECTION_FRESHNESS_CATALOG["campaign.run.status"].fresh_for_ms).toISOString());
  });

  it("can carry an explicit required resync alongside a fresh successful value", () => {
    const status = projectCampaignRunStatus({
      attempts: [], tasks: [], campaigns: [],
      reconciliation_required_task_ids: new Set<string>(),
      campaign_run_diagnostics: new Map(),
      ephemeral: true,
    });
    const clock = fakeClock("2026-08-25T18:00:00.000Z");
    const initial = initialProjectionLifecycle<typeof status>("campaign.run.status");
    const wrapped = projectCampaignRunStatusLifecycle(initial, { status, clock, transport: "connected", resync: "required" });
    expect(wrapped.lifecycle).toBe("ready");
    expect(wrapped.resync).toBe("required");
    expect(wrapped.value?.ephemeral).toBe(true);
  });
});
