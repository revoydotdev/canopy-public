/**
 * Jobs/scheduler backend (roadmap 4C, item 16).
 *
 * A bounded FIFO job queue whose jobs map 1:1 to canonical supervised tasks.
 * Dispatch/cancel/retry delegate to the TaskSupervisor's native transitions;
 * pause/resume is a queue-level DISPATCH THROTTLE only (it gates whether new
 * job.submit calls are accepted while dispatching), never a durable task
 * state and never a second authority over already-running work. A paused
 * queue never cancels or halts in-flight tasks. Active counts derive from
 * live/reconciled supervised state — idle paused states cannot wedge.
 *
 * idempotency and bounds are part of the contract: a job carries a stable
 * id + operation_id; re-queueing the same idempotency key is either a replay
 * (same payload) or a conflict (different payload).
 */

import { compareCodeUnits } from "@arbor/core";
import type { TaskSupervisor } from "@arbor/core";

export type JobState = "queued" | "started" | "retrying" | "cancel_requested" | "cancelled" | "failed" | "completed" | "timed_out";

export interface Job {
  id: string;
  operation_id: string;
  kind: string;
  owner_scope_id: string;
  state: JobState;
  progress: number;
  /** The idempotency key used at submission; the supervisor does not store it, so it is present only in the submit acknowledgement. */
  idempotency_key?: string;
}

export interface JobSubmitInput {
  id: string;
  operation_id: string;
  kind: string;
  owner_scope_id: string;
  idempotency_key: string;
}

export interface JobQueueView {
  jobs: readonly Job[];
  queue_paused: boolean;
  enqueued: number;
  active: number;
}

export interface JobSchedulerOptions {
  max_queued_jobs?: number;
}

const MAX_QUEUED_JOBS = 1_000;
const MAX_KIND_BYTES = 256;
const MAX_ID_BYTES = 512;

/** Map a supervised task to its job view; paused states stay projection-only. */
function toJob(task: {
  id: string; operation_id: string; kind: string; owner_scope_id: string; state: string; progress: number | null;
}): Job {
  return { id: task.id, operation_id: task.operation_id, kind: task.kind, owner_scope_id: task.owner_scope_id, state: task.state as JobState, progress: task.progress ?? 0 };
}

export class JobScheduler {
  private readonly maxQueued: number;
  private paused = false;
  private readonly queue: string[] = [];

  constructor(private readonly supervisor: TaskSupervisor, options: JobSchedulerOptions = {}) {
    this.maxQueued = options.max_queued_jobs ?? MAX_QUEUED_JOBS;
    if (!Number.isSafeInteger(this.maxQueued) || this.maxQueued < 1 || this.maxQueued > 100_000) throw new Error("max_queued_jobs must be an integer from 1 through 100000");
  }

  /** True when the queue accepts new submits (pause is a dispatch throttle). */
  get accepting(): boolean { return !this.paused; }

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }

  /** Side-effect-free admission preflight; safe under the runtime's single-writer boundary. */
  preflightSubmit(input: JobSubmitInput): { ok: true } | { ok: false; error: string } {
    const invalid = validateSubmit(input);
    if (invalid.length) return { ok: false, error: invalid.join("; ") };
    if (this.paused) return { ok: false, error: "queue is paused (dispatch throttle) — resume to accept new jobs" };
    const existing = this.supervisor.list({ include_terminal: true }).find((task) => task.operation_id === input.operation_id);
    if (existing && !(existing.kind === input.kind && existing.owner_scope_id === input.owner_scope_id && existing.id === input.id)) return { ok: false, error: `operation ${input.operation_id} is already registered for a different job` };
    if (!existing && this.queue.length >= this.maxQueued) return { ok: false, error: `job queue is full (${this.maxQueued})` };
    return { ok: true };
  }

  /**
   * Submit a job. Dispatch gates:
   *  - a paused queue rejects new submits (throttle, not cancellation);
   *  - the queue is bounded so idle jobs cannot grow without limit.
   */
  submit(input: JobSubmitInput): { ok: true; job: Job; dispatched: boolean } | { ok: false; error: string } {
    const preflight = this.preflightSubmit(input);
    if (!preflight.ok) return preflight;
    const existing = this.supervisor.list({ include_terminal: true }).find((task) => task.operation_id === input.operation_id);
    if (existing) {
      if (existing.kind === input.kind && existing.owner_scope_id === input.owner_scope_id && existing.id === input.id) return { ok: true, job: toJob(existing), dispatched: false };
      return { ok: false, error: `operation ${input.operation_id} is already registered for a different job` };
    }
    if (this.queue.length >= this.maxQueued) return { ok: false, error: `job queue is full (${this.maxQueued})` };
    const task = this.supervisor.register({ id: input.id, operation_id: input.operation_id, kind: input.kind, owner_scope_id: input.owner_scope_id });
    this.queue.push(task.id);
    const started = this.supervisor.start(task.id);
    return { ok: true, job: toJob(started), dispatched: true };
  }

  cancel(jobId: string): { ok: true; job: Job } | { ok: false; error: string } {
    const task = this.supervisor.get(jobId);
    if (!task) return { ok: false, error: `job ${jobId} was not found` };
    const requested = this.supervisor.requestCancellation(task.id);
    return { ok: true, job: toJob(requested) };
  }

  retry(jobId: string): { ok: true; job: Job } | { ok: false; error: string } {
    const task = this.supervisor.get(jobId);
    if (!task) return { ok: false, error: `job ${jobId} was not found` };
    const retried = this.supervisor.retry(task.id);
    return { ok: true, job: toJob(retried) };
  }

  view(details: { include_terminal?: boolean } = {}): JobQueueView {
    const tasks = this.supervisor.list({ include_terminal: details.include_terminal ?? false });
    const jobs = tasks.map(toJob).sort((left, right) => compareCodeUnits(left.id, right.id));
    const active = tasks.filter((task) => task.state !== "completed" && task.state !== "failed" && task.state !== "cancelled" && task.state !== "timed_out").length;
    return { jobs, queue_paused: this.paused, enqueued: this.queue.length, active };
  }
}

function validateSubmit(input: JobSubmitInput): string[] {
  const failures: string[] = [];
  if (!text(input.id) || input.id.length > MAX_ID_BYTES) failures.push("job id must be a non-empty bounded string");
  if (!text(input.operation_id)) failures.push("operation_id must be non-empty");
  if (!text(input.kind) || input.kind.length > MAX_KIND_BYTES) failures.push("job kind must be a non-empty bounded string");
  if (!text(input.owner_scope_id)) failures.push("owner_scope_id must be non-empty");
  if (!text(input.idempotency_key)) failures.push("idempotency_key must be non-empty");
  return failures;
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
