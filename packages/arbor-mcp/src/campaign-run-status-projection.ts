/**
 * ADR-093: the one canonical, durable campaign-run execution-status
 * projection.
 *
 * `projectCampaignRunStatus` is a pure read model over the existing
 * supervision (`TaskSupervisor`), job (`JobScheduler` — 1:1 with supervised
 * tasks per `job-scheduler.ts`'s own doc, so a task's state already IS the
 * job's dispatch state), campaign (`CampaignManager`), and native-session
 * (`HarnessSessionJournal`) authorities, joined against the durable
 * `CampaignRunAttemptIndex` (Decision §1's only new record). It never
 * re-executes work, never infers a live worker after restart, and never
 * mutates any of the authorities it reads.
 *
 * Every operator surface (CLI, TUI, web/API, runtime event stream, `arbor
 * task ... --wait`) must consume THIS function's output rather than
 * rejoining the authorities itself (Decision §4) — the CLI/TUI/web adapters
 * are out of this file's ownership this tranche (see the ADR-093
 * implementation report); this module is the seam they are required to call
 * through once wired.
 *
 * Progress and heartbeat timestamps are owned by TaskSupervisor, persisted
 * with each task, and projected with explicit ages relative to `as_of`. The
 * read model still never infers worker liveness from process presence after
 * restart; reconciliation remains an independent authority.
 */
import type { SupervisorTask, SupervisorTaskState, TerminalOutcome } from "@arbor/core";
import type { CampaignRunAttempt } from "./campaign-run-attempt-index.js";

const TERMINAL_TASK_STATES = new Set<SupervisorTaskState>(["completed", "failed", "cancelled", "timed_out"]);

/** True for any supervised task state Decision §1/§3 treat as no longer runnable. */
export function isTerminalSupervisorTaskState(state: SupervisorTaskState): boolean {
  return TERMINAL_TASK_STATES.has(state);
}

export type CampaignRunExecutionState =
  | "queued"
  | "started"
  | "progressed"
  | "heartbeat"
  | "cancel_requested"
  | "terminal"
  | "refused";

export type CampaignRunTerminalOutcome = "completed" | "failed" | "cancelled" | "timed_out";

export interface CampaignRunStatus {
  readonly attempt_id: string;
  readonly campaign_id: string;
  readonly attempt_ordinal: number;
  readonly supersedes_attempt_id: string | null;
  readonly is_latest: boolean;
  readonly state: CampaignRunExecutionState;
  readonly outcome: CampaignRunTerminalOutcome | null;
  /** Closed bounded refusal/failure code; never a raw stack trace or provider payload. */
  readonly reason: string | null;
  /** Opaque/redacted reference; never raw model/tool text, credentials, or paths. */
  readonly diagnostic_ref: string | null;
  readonly declared_deadline_at: string | null;
  readonly progress: number | null;
  readonly last_progress_at: string | null;
  readonly last_heartbeat_at: string | null;
  readonly progress_sequence: number;
  readonly progress_age_ms: number | null;
  readonly heartbeat_age_ms: number | null;
  readonly reconciliation_required: boolean;
  readonly worker_liveness: "tracked" | "unknown_after_restart" | "not_applicable";
  readonly campaign_halted: boolean;
  readonly campaign_resumable: boolean;
  readonly campaign_terminal_outcome: TerminalOutcome | "cancelled" | null;
  /** True only when this composition root has no persistence directory; never claims restart durability then. */
  readonly ephemeral: boolean;
}

export interface CampaignRunStatusIntegrityError {
  readonly attempt_id: string;
  readonly campaign_id: string;
  readonly code: "integrity_unavailable";
  readonly reason: string;
}

export interface CampaignRunStatusProjection {
  /** Deterministically ordered by campaign id then attempt ordinal (Decision §4). */
  readonly attempts: readonly CampaignRunStatus[];
  /** One entry per campaign id present in `attempts`: its highest-ordinal attempt. */
  readonly latest: readonly CampaignRunStatus[];
  readonly integrity_errors: readonly CampaignRunStatusIntegrityError[];
  readonly ephemeral: boolean;
  readonly as_of: string | null;
}

export interface CampaignRunStatusCampaignFact {
  readonly id: string;
  readonly halted: boolean;
  readonly terminal_outcome: TerminalOutcome | "cancelled";
}

export interface CampaignRunStatusDiagnostic {
  readonly code: string;
  readonly summary: string;
}

export interface ProjectCampaignRunStatusInput {
  readonly attempts: readonly CampaignRunAttempt[];
  readonly tasks: readonly SupervisorTask[];
  readonly reconciliation_required_task_ids: ReadonlySet<string>;
  readonly campaigns: readonly CampaignRunStatusCampaignFact[];
  /** Durable per-campaign run-failure diagnostic (`CampaignManager.getCampaignRunDiagnostic`), keyed by campaign id. */
  readonly campaign_run_diagnostics: ReadonlyMap<string, CampaignRunStatusDiagnostic>;
  /** Observation clock for age fields; absent means ages remain unavailable. */
  readonly as_of?: string;
  /** True when the composing `CampaignRunAttemptIndex` has no persistence directory. */
  readonly ephemeral: boolean;
  readonly campaign_id?: string;
}

/** The sole status constructor (Decision §4). Read-only: no dispatch, cancellation, recovery, approval, review, ledger, or session side effect. */
export function projectCampaignRunStatus(input: ProjectCampaignRunStatusInput): CampaignRunStatusProjection {
  const tasksById = new Map(input.tasks.map((task) => [task.id, task] as const));
  const campaignsById = new Map(input.campaigns.map((campaign) => [campaign.id, campaign] as const));
  const scoped = [...input.attempts]
    .filter((attempt) => input.campaign_id === undefined || attempt.campaign_id === input.campaign_id)
    .sort((a, b) => a.campaign_id.localeCompare(b.campaign_id) || a.attempt_ordinal - b.attempt_ordinal);

  const seenOrdinal = new Set<string>();
  const integrityErrors: CampaignRunStatusIntegrityError[] = [];
  const statuses: CampaignRunStatus[] = [];

  for (const attempt of scoped) {
    const ordinalKey = `${attempt.campaign_id}::${attempt.attempt_ordinal}`;
    if (seenOrdinal.has(ordinalKey)) {
      integrityErrors.push({ attempt_id: attempt.attempt_id, campaign_id: attempt.campaign_id, code: "integrity_unavailable", reason: `duplicate attempt_ordinal ${attempt.attempt_ordinal} for campaign ${attempt.campaign_id}` });
      continue;
    }
    seenOrdinal.add(ordinalKey);

    const campaign = campaignsById.get(attempt.campaign_id) ?? null;

    if (attempt.refusal !== null) {
      statuses.push(refusedStatus(attempt, campaign, input.ephemeral));
      continue;
    }

    const task = attempt.supervisor_task_id === null ? undefined : tasksById.get(attempt.supervisor_task_id);
    if (task === undefined) {
      integrityErrors.push({ attempt_id: attempt.attempt_id, campaign_id: attempt.campaign_id, code: "integrity_unavailable", reason: `attempt ${attempt.attempt_id} links missing supervisor task ${String(attempt.supervisor_task_id)}` });
      continue;
    }
    if (task.owner_scope_id !== attempt.campaign_id) {
      integrityErrors.push({ attempt_id: attempt.attempt_id, campaign_id: attempt.campaign_id, code: "integrity_unavailable", reason: `attempt ${attempt.attempt_id} links task ${task.id} owned by a different campaign (${task.owner_scope_id})` });
      continue;
    }

    const reconciliationRequired = input.reconciliation_required_task_ids.has(task.id);
    const diagnostic = task.state === "failed" ? input.campaign_run_diagnostics.get(attempt.campaign_id) ?? null : null;
    statuses.push(taskBackedStatus(attempt, task, campaign, reconciliationRequired, diagnostic, input.ephemeral, input.as_of));
  }

  const byCampaign = new Map<string, CampaignRunStatus>();
  for (const status of statuses) {
    const current = byCampaign.get(status.campaign_id);
    if (current === undefined || status.attempt_ordinal > current.attempt_ordinal) byCampaign.set(status.campaign_id, status);
  }
  const latestIds = new Set([...byCampaign.values()].map((status) => status.attempt_id));
  const withLatestFlag = statuses.map((status) => Object.freeze({ ...status, is_latest: latestIds.has(status.attempt_id) }));

  return Object.freeze({
    attempts: Object.freeze(withLatestFlag),
    latest: Object.freeze(withLatestFlag.filter((status) => status.is_latest)),
    integrity_errors: Object.freeze(integrityErrors),
    ephemeral: input.ephemeral,
    as_of: input.as_of ?? null,
  });
}

function refusedStatus(attempt: CampaignRunAttempt, campaign: CampaignRunStatusCampaignFact | null, ephemeral: boolean): CampaignRunStatus {
  return Object.freeze({
    attempt_id: attempt.attempt_id,
    campaign_id: attempt.campaign_id,
    attempt_ordinal: attempt.attempt_ordinal,
    supersedes_attempt_id: attempt.supersedes_attempt_id,
    is_latest: false,
    state: "refused" as const,
    outcome: null,
    reason: attempt.refusal!.code,
    diagnostic_ref: attempt.refusal!.diagnostic_ref,
    declared_deadline_at: null,
    progress: null,
    last_progress_at: null,
    last_heartbeat_at: null,
    progress_sequence: 0,
    progress_age_ms: null,
    heartbeat_age_ms: null,
    reconciliation_required: false,
    worker_liveness: "not_applicable" as const,
    campaign_halted: campaign?.halted ?? false,
    campaign_resumable: campaign === null ? false : !campaign.halted,
    campaign_terminal_outcome: campaign?.terminal_outcome ?? null,
    ephemeral,
  });
}

function taskBackedStatus(
  attempt: CampaignRunAttempt,
  task: SupervisorTask,
  campaign: CampaignRunStatusCampaignFact | null,
  reconciliationRequired: boolean,
  diagnostic: CampaignRunStatusDiagnostic | null,
  ephemeral: boolean,
  asOf?: string,
): CampaignRunStatus {
  const state = executionState(task);
  const outcome: CampaignRunTerminalOutcome | null = state === "terminal" ? (task.state as CampaignRunTerminalOutcome) : null;
  return Object.freeze({
    attempt_id: attempt.attempt_id,
    campaign_id: attempt.campaign_id,
    attempt_ordinal: attempt.attempt_ordinal,
    supersedes_attempt_id: attempt.supersedes_attempt_id,
    is_latest: false,
    state,
    outcome,
    reason: diagnostic?.code ?? null,
    diagnostic_ref: diagnostic === null ? null : diagnostic.summary,
    declared_deadline_at: task.deadline_at,
    progress: task.progress,
    last_progress_at: task.last_progress_at,
    last_heartbeat_at: task.last_heartbeat_at,
    progress_sequence: task.progress_sequence,
    progress_age_ms: observationAge(task.last_progress_at, asOf),
    heartbeat_age_ms: observationAge(task.last_heartbeat_at, asOf),
    reconciliation_required: reconciliationRequired,
    worker_liveness: reconciliationRequired ? "unknown_after_restart" : state === "terminal" ? "not_applicable" : "tracked",
    campaign_halted: campaign?.halted ?? false,
    campaign_resumable: campaign === null ? false : !campaign.halted,
    campaign_terminal_outcome: campaign?.terminal_outcome ?? null,
    ephemeral,
  });
}

function executionState(task: SupervisorTask): CampaignRunExecutionState {
  if (isTerminalSupervisorTaskState(task.state)) return "terminal";
  switch (task.state) {
    case "accepted": return "queued";
    case "cancel_requested": return "cancel_requested";
    case "started":
    case "retrying":
      if (task.last_heartbeat_at !== null && (task.last_progress_at === null || Date.parse(task.last_heartbeat_at) > Date.parse(task.last_progress_at))) return "heartbeat";
      if (task.last_progress_at !== null) return "progressed";
      return task.progress !== null && task.progress > 0 ? "progressed" : "started";
    default:
      return "started";
  }
}

function observationAge(observedAt: string | null, asOf?: string): number | null {
  if (observedAt === null || asOf === undefined) return null;
  const age = Date.parse(asOf) - Date.parse(observedAt);
  return Number.isFinite(age) && age >= 0 ? age : null;
}
