import { describe, expect, it } from "vitest";
import {
  RUNTIME_CONTRACT_VERSION,
  validateRuntimeCommand,
  validateRuntimeError,
  validateRuntimeEvent,
  validateRuntimeQuery,
  validateSupervisorTask,
  type ApplicationCommand,
  type ApplicationQuery,
  type RuntimeEvent,
} from "../src/runtime-contracts.js";
import type { Action } from "../src/index.js";

const metadata = { operation_id: "op-1", idempotency_key: "idem-1", correlation_id: "corr-1", actor_id: "operator-1", requested_at: "2026-08-01T12:00:00Z" };
const cursor = { stream_id: "runtime-1", sequence: 0 };
const task = { id: "task-1", operation_id: "op-1", kind: "campaign", owner_scope_id: "scope-1", parent_id: null, state: "started", started_at: "2026-08-01T12:00:00Z", deadline_at: null, progress: 0.5, last_progress_at: null, last_heartbeat_at: null, progress_sequence: 0, retry_attempt: 0, cleanup: null } as const;
const action: Action = { description: "implement", estimated_gain: 5, estimated_cost: 2, category: "feature", delegate_to: "seed", constraints: ["test"] };

describe("runtime contract command and query validation", () => {
  it("normalizes pre-clock supervisor records without inventing observation times", () => {
    const legacy: Record<string, unknown> = { ...task };
    delete legacy.last_progress_at;
    delete legacy.last_heartbeat_at;
    delete legacy.progress_sequence;
    expect(validateSupervisorTask(legacy)).toMatchObject({
      ok: true,
      value: { last_progress_at: null, last_heartbeat_at: null, progress_sequence: 0 },
    });
    expect(validateSupervisorTask({ ...task, progress_sequence: -1 }).ok).toBe(false);
    expect(validateSupervisorTask({ ...task, last_heartbeat_at: "not-a-time" }).ok).toBe(false);
  });

  it("normalizes legacy task.changed events at the event boundary", () => {
    const legacyTask: Record<string, unknown> = { ...task };
    delete legacyTask.last_progress_at;
    delete legacyTask.last_heartbeat_at;
    delete legacyTask.progress_sequence;
    const event = validateRuntimeEvent({
      schema_version: 1, id: "event-task", cursor, occurred_at: "2026-08-01T12:00:00Z",
      correlation_id: "corr", redacted: false, event: { kind: "task.changed", task: legacyTask },
    });
    expect(event).toMatchObject({ ok: true, value: { event: { task: { last_progress_at: null, last_heartbeat_at: null, progress_sequence: 0 } } } });
  });

  const commands: ApplicationCommand[] = [
    { kind: "campaign.start", campaign_id: "c", plan_path: "plan.md", root_action: action, config: { max_seconds: 10 }, plan_review: { plan_reviewed: true, resources_available: true } },
    { kind: "campaign.halt", campaign_id: "c", reason: "manual", approval_id: "approval-1" },
    { kind: "tree.branch", campaign_id: "c", node_id: "n", actions: [action] }, { kind: "tree.prune", campaign_id: "c", node_id: "n" },
    { kind: "operation.cancel", target_operation_id: "op" }, { kind: "task.retry", task_id: "t" },
    { kind: "recovery.retry", campaign_id: "c", node_id: "n", prior_operation_id: "old-op", reason: "lease was reconciled", lease: { lease_id: "fresh-lease", worktree_id: "worktree", expires_at: "2026-08-01T13:00:00Z" } },
    { kind: "recovery.abandon", campaign_id: "c", node_id: "n", prior_operation_id: "old-op", reason: "operator abandons unsafe retry", authorization: { authority: "operator", authorized_by: "operator-1", rationale: "lease state is ambiguous" } },
  ];
  const queries: ApplicationQuery[] = [
    { kind: "campaign.list", limit: 1 }, { kind: "campaign.snapshot", campaign_id: "c" }, { kind: "campaign.tree", campaign_id: "c", limit: 1 },
    { kind: "operation.get", operation_id: "op" }, { kind: "task.list", limit: 1 }, { kind: "event.resume", cursor },
  ];

  it("accepts every closed command and query variant", () => {
    for (const command of commands) expect(validateRuntimeCommand({ schema_version: RUNTIME_CONTRACT_VERSION, metadata: command.kind.startsWith("recovery.") ? { ...metadata, expected_version: "snapshot-1" } : metadata, command }).ok).toBe(true);
    for (const query of queries) expect(validateRuntimeQuery({ schema_version: RUNTIME_CONTRACT_VERSION, query_id: "q", query }).ok).toBe(true);
  });

  it("accepts recovery.retry with no lease — a client cannot know the fresh lease before the server mints it", () => {
    const command: ApplicationCommand = { kind: "recovery.retry", campaign_id: "c", node_id: "n", prior_operation_id: "old-op", reason: "lease was reconciled" };
    const result = validateRuntimeCommand({ schema_version: RUNTIME_CONTRACT_VERSION, metadata: { ...metadata, expected_version: "snapshot-1" }, command });
    expect(result.ok).toBe(true);
    if (result.ok) expect("lease" in result.value.command).toBe(false);
  });

  it("rejects recovery.retry when a supplied lease is malformed, but not for lacking one", () => {
    const base = { kind: "recovery.retry" as const, campaign_id: "c", node_id: "n", prior_operation_id: "old-op", reason: "lease was reconciled" };
    expect(validateRuntimeCommand({ schema_version: RUNTIME_CONTRACT_VERSION, metadata: { ...metadata, expected_version: "snapshot-1" }, command: { ...base, lease: { lease_id: "", worktree_id: "w", expires_at: "2026-08-01T13:00:00Z" } } }).ok).toBe(false);
  });

  it("rejects unknown versions, unknown discriminants, invalid IDs, and unsafe pagination", () => {
    expect(validateRuntimeCommand({ schema_version: 2, metadata, command: commands[0] }).ok).toBe(false);
    expect(validateRuntimeCommand({ schema_version: 1, metadata, command: { kind: "campaign.delete" } }).ok).toBe(false);
    expect(validateRuntimeCommand({ schema_version: 1, metadata: { ...metadata, idempotency_key: "" }, command: commands[0] }).ok).toBe(false);
    expect(validateRuntimeCommand({ schema_version: 1, metadata, command: { kind: "campaign.start", campaign_id: "c", plan_path: "plan.md", root_action: { ...action, delegate_to: "" } } }).ok).toBe(false);
    expect(validateRuntimeCommand({ schema_version: 1, metadata, command: { kind: "campaign.start", campaign_id: "c", plan_path: "plan.md", root_action: { ...action, execution_role: "unbounded" } } }).ok).toBe(false);
    expect(validateRuntimeCommand({ schema_version: 1, metadata, command: { kind: "campaign.start", campaign_id: "c", plan_path: "plan.md", root_action: { ...action, skill_id: "write-adr" } } }).ok).toBe(false);
    expect(validateRuntimeCommand({ schema_version: 1, metadata, command: { kind: "campaign.start", campaign_id: "c", plan_path: "plan.md", root_action: { ...action, skill_id: "write-adr", skill_version: "01.0.0" } } }).ok).toBe(false);
    expect(validateRuntimeCommand({ schema_version: 1, metadata, command: { kind: "campaign.start", campaign_id: "c", plan_path: "plan.md", root_action: { ...action, high_risk_tool_scope: { write_paths: ["docs/../escape.md"], command_argv: [] } } } }).ok).toBe(false);
    expect(validateRuntimeCommand({ schema_version: 1, metadata, command: { kind: "campaign.start", campaign_id: "c", plan_path: "plan.md", root_action: { ...action, high_risk_tool_scope: { write_paths: [], command_argv: [["tool", "\u0000"]] } } } }).ok).toBe(false);
    expect(validateRuntimeCommand({ schema_version: 1, metadata, command: { kind: "tree.branch", campaign_id: "c", node_id: "n", actions: [] } }).ok).toBe(false);
    expect(validateRuntimeCommand({ schema_version: 1, metadata, command: { kind: "campaign.halt", campaign_id: "c", reason: "manual", approval_id: "" } }).ok).toBe(false);
    expect(validateRuntimeCommand({ schema_version: 1, metadata, command: commands.find((command) => command.kind === "recovery.retry")! }).ok).toBe(false);
    expect(validateRuntimeCommand({ schema_version: 1, metadata: { ...metadata, expected_version: "snapshot-1" }, command: { kind: "recovery.abandon", campaign_id: "c", node_id: "n", prior_operation_id: "op", reason: "unsafe", authorization: { authority: "operator", authorized_by: "different-operator", rationale: "not actor" } } }).ok).toBe(false);
    expect(validateRuntimeQuery({ schema_version: 1, query_id: "q", query: { kind: "campaign.list", limit: 0 } }).ok).toBe(false);
    expect(validateRuntimeQuery({ schema_version: 1, query_id: "q", query: { kind: "event.resume", cursor: { stream_id: "r", sequence: -1 } } }).ok).toBe(false);
  });

  it("retains a closed, authority-neutral execution-role request on admitted actions", () => {
    const result = validateRuntimeCommand({ schema_version: 1, metadata, command: { kind: "campaign.start", campaign_id: "c", plan_path: "plan.md", root_action: { ...action, execution_role: "documentation-writer" } } });
    expect(result).toMatchObject({ ok: true, value: { command: { root_action: { execution_role: "documentation-writer" } } } });
  });

  it("retains an exact immutable skill identity on admitted actions", () => {
    const result = validateRuntimeCommand({ schema_version: 1, metadata, command: { kind: "campaign.start", campaign_id: "c", plan_path: "plan.md", root_action: { ...action, skill_id: "write-adr", skill_version: "1.2.0" } } });
    expect(result).toMatchObject({ ok: true, value: { command: { root_action: { skill_id: "write-adr", skill_version: "1.2.0" } } } });
  });

  it("retains only exact bounded durable high-risk declarations", () => {
    const result = validateRuntimeCommand({ schema_version: 1, metadata, command: { kind: "campaign.start", campaign_id: "c", plan_path: "plan.md", root_action: { ...action, high_risk_tool_scope: { write_paths: ["docs/runbook.md"], command_argv: [["git", "status", "--short"]] } } } });
    expect(result).toMatchObject({ ok: true, value: { command: { root_action: { high_risk_tool_scope: { write_paths: ["docs/runbook.md"] } } } } });
  });
});

describe("runtime event, error, and supervisor validation", () => {
  const error = { code: "unavailable", severity: "warning", recoverable: true, source: "runtime", summary: "offline" } as const;
  const events: RuntimeEvent[] = [
    { kind: "campaign.changed", campaign_id: "c", change: "created" }, { kind: "tree.node_changed", campaign_id: "c", node_id: "n", state: "pending" },
    { kind: "gate.recorded", campaign_id: "c", node_id: null, gate: "admission", result: "pass" }, { kind: "kb.entry_added", campaign_id: "c", entry_id: "k" },
    { kind: "audit.evidence_recorded", campaign_id: "c", evidence_id: "e" }, { kind: "operation.accepted", accepted_operation_id: "op" },
    { kind: "operation.rejected", error }, { kind: "task.changed", task }, { kind: "stream.truncated", stream_id: "logs", cursor, dropped_records: 1 },
  ];

  it("accepts every event variant and valid task/error shapes", () => {
    for (const event of events) expect(validateRuntimeEvent({ schema_version: 1, id: "event", cursor, occurred_at: "2026-08-01T12:00:00Z", correlation_id: "corr", redacted: false, event }).ok).toBe(true);
    expect(validateSupervisorTask(task).ok).toBe(true);
    expect(validateRuntimeError(error).ok).toBe(true);
  });

  it("rejects invalid task terminal data, error codes, event cursors, and unknown event kinds", () => {
    expect(validateSupervisorTask({ ...task, progress: 1.1 }).ok).toBe(false);
    expect(validateSupervisorTask({ ...task, state: "lost" }).ok).toBe(false);
    expect(validateRuntimeError({ ...error, code: "oops" }).ok).toBe(false);
    expect(validateRuntimeEvent({ schema_version: 1, id: "event", cursor: { ...cursor, sequence: -1 }, occurred_at: "2026-08-01T12:00:00Z", correlation_id: "corr", redacted: false, event: events[0] }).ok).toBe(false);
    expect(validateRuntimeEvent({ schema_version: 1, id: "event", cursor, occurred_at: "2026-08-01T12:00:00Z", correlation_id: "corr", redacted: false, event: { kind: "invented" } }).ok).toBe(false);
  });
});
