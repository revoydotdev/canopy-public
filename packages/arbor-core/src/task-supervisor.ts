import { compareCodeUnits } from "./ordering.js";
import { validateSupervisorTask, type SupervisorTask, type SupervisorTaskState } from "./runtime-contracts.js";

/** A deterministic clock keeps supervision free of hidden timers and testable. */
export type SupervisorClock = () => Date;

export interface TaskSupervisorOptions {
  clock?: SupervisorClock;
  /** Maximum completed records retained when they can be safely discarded. */
  terminal_retention?: number;
  /** Bounded operation-ID history retained after task records are pruned. */
  operation_tombstone_retention?: number;
  /** Optional constructor hydration; it follows the same validation as restore(). */
  restored_tasks?: readonly SupervisorTask[];
  /** Sibling nesting + simultaneity bounds (Phase 4D.5). Defaults applied when omitted. */
  sibling_bounds?: SiblingBounds;
}

/** Hard caps on sibling nesting depth and simultaneity (Phase 4D.5, ADR-019). */
export interface SiblingBounds {
  /** Maximum chain depth of nested delegate→sibling spawns. */
  readonly maxNestingDepth: number;
  /** Maximum simultaneous active siblings per parent. */
  readonly maxSimultaneousSiblings: number;
}

/** A live child slot held by a non-terminal child task. */
export interface ChildConcurrencyLease {
  readonly lease_id: string;
  readonly task_id: string;
  readonly parent_id: string;
  readonly acquired_at: string;
}

export type ReconciliationDisposition = "failed" | "timed_out" | "cancelled";

export const DEFAULT_SIBLING_BOUNDS: SiblingBounds = Object.freeze({ maxNestingDepth: 4, maxSimultaneousSiblings: 8 });

export interface TaskRegistration {
  id: string;
  operation_id: string;
  kind: string;
  owner_scope_id: string;
  parent_id?: string | null;
  deadline_at?: string | null;
}

export interface TaskListOptions {
  scope_id?: string;
  /** Terminal tasks are deliberately hidden unless an operator asks for them. */
  include_terminal?: boolean;
}

export interface SupervisorRestoreResult {
  restored_task_ids: string[];
  reconciliation_required_task_ids: string[];
}

export class SupervisorInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupervisorInvariantError";
  }
}

const TERMINAL = new Set<SupervisorTaskState>(["cancelled", "failed", "completed", "timed_out"]);

function isTerminal(state: SupervisorTaskState): boolean {
  return TERMINAL.has(state);
}

/**
 * In-memory, dependency-free task state machine for a single runtime process.
 * The runtime is responsible for persistence/reconciliation; this class does no
 * I/O and only advances when its explicit methods are called.
 */
export class TaskSupervisor {
  private readonly tasks = new Map<string, SupervisorTask>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly operations = new Map<string, string>();
  private readonly operationTombstones = new Map<string, TaskRegistration>();
  private readonly tombstoneOrder: string[] = [];
  private readonly reconciliationRequired = new Set<string>();
  /** Explicit accounting prevents retry/restore paths from losing a child slot. */
  private readonly childLeases = new Map<string, ChildConcurrencyLease>();
  private readonly clock: SupervisorClock;
  private readonly terminalRetention: number;
  private readonly operationTombstoneRetention: number;
  private readonly siblingBounds: SiblingBounds;

  constructor(options: TaskSupervisorOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.terminalRetention = options.terminal_retention ?? 100;
    this.operationTombstoneRetention = options.operation_tombstone_retention ?? this.terminalRetention;
    if (!Number.isSafeInteger(this.terminalRetention) || this.terminalRetention < 0) {
      throw new SupervisorInvariantError("terminal_retention must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(this.operationTombstoneRetention) || this.operationTombstoneRetention < 0) {
      throw new SupervisorInvariantError("operation_tombstone_retention must be a non-negative safe integer");
    }
    const bounds = options.sibling_bounds ?? DEFAULT_SIBLING_BOUNDS;
    if (!Number.isSafeInteger(bounds.maxNestingDepth) || bounds.maxNestingDepth < 1) {
      throw new SupervisorInvariantError("sibling_bounds.maxNestingDepth must be a safe integer ≥1");
    }
    if (!Number.isSafeInteger(bounds.maxSimultaneousSiblings) || bounds.maxSimultaneousSiblings < 1) {
      throw new SupervisorInvariantError("sibling_bounds.maxSimultaneousSiblings must be a safe integer ≥1");
    }
    this.siblingBounds = Object.freeze({ ...bounds });
    if (options.restored_tasks !== undefined) this.restore(options.restored_tasks);
  }

  /** Returns the active sibling bounds (frozen). */
  getSiblingBounds(): SiblingBounds { return this.siblingBounds; }

  /**
   * Atomically hydrate durable task projections. Active records are intentionally
   * marked reconciliation-only: their AbortSignals are fresh local signals and
   * must not be mistaken for a worker that survived a process restart.
   */
  restore(tasks: readonly SupervisorTask[]): SupervisorRestoreResult {
    if (this.tasks.size > 0 || this.operations.size > 0 || this.operationTombstones.size > 0) {
      throw new SupervisorInvariantError("restore requires a supervisor with no live records or operation history");
    }
    const staged = new Map<string, SupervisorTask>();
    const stagedOperations = new Map<string, string>();
    const reconciliation: string[] = [];
    for (const input of tasks) {
      const validation = validateSupervisorTask(input);
      if (!validation.ok) throw new SupervisorInvariantError(`invalid restored task: ${validation.violations.map((violation) => `${violation.path} ${violation.message}`).join("; ")}`);
      if (staged.has(input.id)) throw new SupervisorInvariantError(`duplicate restored task ${input.id}`);
      if (stagedOperations.has(input.operation_id)) throw new SupervisorInvariantError(`duplicate restored operation ${input.operation_id}`);
      this.validateRestoredLifecycle(input);
      staged.set(input.id, { ...validation.value });
      stagedOperations.set(input.operation_id, input.id);
      if (!isTerminal(input.state)) reconciliation.push(input.id);
    }
    for (const task of staged.values()) {
      if (task.parent_id !== null) {
        const parent = staged.get(task.parent_id);
        if (parent === undefined) throw new SupervisorInvariantError(`restored task ${task.id} has an unknown parent`);
        if (parent.owner_scope_id !== task.owner_scope_id) throw new SupervisorInvariantError(`restored task ${task.id} does not share its parent's owner scope`);
      }
      this.assertNoParentCycle(task, staged);
    }
    // All validation happens before these assignments: invalid hydration leaves
    // an empty supervisor unchanged.
    for (const [id, task] of staged) {
      this.tasks.set(id, task);
      this.controllers.set(id, new AbortController());
      if (task.parent_id !== null && !isTerminal(task.state)) {
        this.childLeases.set(task.id, { lease_id: `task:${task.id}`, task_id: task.id, parent_id: task.parent_id, acquired_at: task.started_at ?? this.now() });
      }
    }
    for (const [operation, id] of stagedOperations) this.operations.set(operation, id);
    for (const id of reconciliation) this.reconciliationRequired.add(id);
    return { restored_task_ids: [...staged.keys()], reconciliation_required_task_ids: reconciliation };
  }

  /** True means this task is durable evidence, not proof of a live worker. */
  requiresReconciliation(id: string): boolean {
    this.mustGet(id);
    return this.reconciliationRequired.has(id);
  }

  reconciliationTasks(): SupervisorTask[] {
    return [...this.reconciliationRequired].map((id) => this.snapshot(this.mustGet(id)));
  }

  /** Returns the currently held child slots for a parent, in stable order. */
  siblingLeases(parentId: string): ChildConcurrencyLease[] {
    this.mustGet(parentId);
    return [...this.childLeases.values()]
      .filter((lease) => lease.parent_id === parentId)
      .sort((a, b) => compareCodeUnits(a.task_id, b.task_id))
      .map((lease) => ({ ...lease }));
  }

  /**
   * Reconcile a task whose durable record outlived its worker process. This is
   * intentionally explicit: a restart cannot infer success from a missing
   * process. The whole restored subtree is settled together so every child
   * slot is released and a parent cannot strand capacity behind a dead child.
   */
  reconcile(id: string, disposition: ReconciliationDisposition = "failed"): SupervisorTask[] {
    const task = this.mustGet(id);
    if (!this.reconciliationRequired.has(id)) {
      if (isTerminal(task.state)) return [this.snapshot(task)];
      throw new SupervisorInvariantError(`task ${id} is not awaiting reconciliation`);
    }
    const settled: SupervisorTask[] = [];
    const settle = (candidate: SupervisorTask): void => {
      for (const child of this.childrenOf(candidate.id).sort((a, b) => compareCodeUnits(a.id, b.id))) {
        if (!isTerminal(child.state)) settle(child);
      }
      if (isTerminal(candidate.state)) {
        this.reconciliationRequired.delete(candidate.id);
        this.releaseSiblingLease(candidate.id);
        return;
      }
      candidate.state = disposition;
      candidate.cleanup = "pending";
      this.reconciliationRequired.delete(candidate.id);
      this.releaseSiblingLease(candidate.id);
      settled.push(this.snapshot(candidate));
    };
    settle(task);
    return settled;
  }

  /** Reconcile all restored records whose recorded deadline has elapsed. */
  reconcileExpired(at: Date = this.clock()): string[] {
    const atMs = at.getTime();
    if (!Number.isFinite(atMs)) throw new SupervisorInvariantError("reconciliation time must be valid");
    const expired = this.reconciliationTasks()
      .filter((task) => task.deadline_at !== null && Date.parse(task.deadline_at) <= atMs)
      .sort((a, b) => compareCodeUnits(a.id, b.id));
    const settled: string[] = [];
    for (const task of expired) {
      if (!this.reconciliationRequired.has(task.id)) continue;
      settled.push(...this.reconcile(task.id, "timed_out").map((value) => value.id));
    }
    return settled;
  }

  /** Explicitly discard old retired-operation protections, oldest first. */
  pruneOperationTombstones(limit = Number.MAX_SAFE_INTEGER): string[] {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new SupervisorInvariantError("tombstone prune limit must be a non-negative safe integer");
    const removed: string[] = [];
    while (removed.length < limit && this.tombstoneOrder.length > 0) {
      const operationId = this.tombstoneOrder.shift()!;
      if (this.operationTombstones.delete(operationId)) removed.push(operationId);
    }
    return removed;
  }

  register(input: TaskRegistration): SupervisorTask {
    this.requireText(input.id, "task id");
    this.requireText(input.operation_id, "operation id");
    this.requireText(input.kind, "task kind");
    this.requireText(input.owner_scope_id, "owner scope id");
    if (input.deadline_at !== undefined && input.deadline_at !== null && Number.isNaN(Date.parse(input.deadline_at))) {
      throw new SupervisorInvariantError("deadline_at must be an ISO timestamp when provided");
    }
    const existingOperation = this.operations.get(input.operation_id);
    if (existingOperation !== undefined) {
      const existing = this.mustGet(existingOperation);
      if (!this.sameRegistration(existing, input)) throw new SupervisorInvariantError(`operation ${input.operation_id} is already registered for a different task`);
      return this.snapshot(existing);
    }
    if (this.operationTombstones.has(input.operation_id)) {
      throw new SupervisorInvariantError(`operation ${input.operation_id} was retired and remains protected by the tombstone retention policy`);
    }
    if (this.tasks.has(input.id)) throw new SupervisorInvariantError(`task ${input.id} is already registered with a different operation`);
    const parentId = input.parent_id ?? null;
    if (parentId !== null) {
      const parent = this.mustGet(parentId);
      if (parent.owner_scope_id !== input.owner_scope_id) throw new SupervisorInvariantError("a child must use its parent's owner scope");
      if (isTerminal(parent.state)) throw new SupervisorInvariantError("cannot add a child to a terminal parent");
      if (this.reconciliationRequired.has(parent.id)) throw new SupervisorInvariantError(`parent ${parent.id} requires reconciliation before accepting a child`);
      // Phase 4D.5 sibling bounds: enforce nesting depth + simultaneity.
      const depth = this.depthOf(parentId) + 1;
      if (depth > this.siblingBounds.maxNestingDepth) {
        throw new SupervisorInvariantError(`sibling nesting depth ${depth} exceeds maxNestingDepth ${this.siblingBounds.maxNestingDepth}`);
      }
      const siblings = this.siblingLeases(parentId);
      if (siblings.length >= this.siblingBounds.maxSimultaneousSiblings) {
        throw new SupervisorInvariantError(`parent ${parentId} already has ${siblings.length} active siblings; maxSimultaneousSiblings ${this.siblingBounds.maxSimultaneousSiblings} exceeded`);
      }
    }
    const task: SupervisorTask = {
      id: input.id, operation_id: input.operation_id, kind: input.kind, owner_scope_id: input.owner_scope_id,
      parent_id: parentId, state: "accepted", started_at: null, deadline_at: input.deadline_at ?? null,
      progress: null, last_progress_at: null, last_heartbeat_at: null, progress_sequence: 0,
      retry_attempt: 0, cleanup: null,
    };
    this.tasks.set(task.id, task);
    this.operations.set(task.operation_id, task.id);
    this.controllers.set(task.id, new AbortController());
    if (parentId !== null) this.acquireSiblingLease(task.id, parentId);
    return this.snapshot(task);
  }

  get(id: string): SupervisorTask | undefined {
    const task = this.tasks.get(id);
    return task === undefined ? undefined : this.snapshot(task);
  }

  /** Remove an unstarted registration during a failed higher-level transaction. */
  unregister(id: string): void {
    const task = this.mustGet(id);
    if (task.state !== "accepted" || this.hasChildren(id)) throw new SupervisorInvariantError("only an accepted task without children can be unregistered");
    this.tasks.delete(id); this.operations.delete(task.operation_id); this.controllers.delete(id); this.releaseSiblingLease(id);
  }

  signalFor(id: string): AbortSignal {
    this.mustGet(id);
    return this.controllers.get(id)!.signal;
  }

  list(options: TaskListOptions = {}): SupervisorTask[] {
    return [...this.tasks.values()]
      .filter((task) => (options.scope_id === undefined || task.owner_scope_id === options.scope_id) && (options.include_terminal === true || !isTerminal(task.state)))
      .map((task) => this.snapshot(task));
  }

  start(id: string): SupervisorTask {
    const task = this.mustGet(id);
    this.requireLive(id);
    if (task.state === "started") return this.snapshot(task);
    if (task.state !== "accepted" && task.state !== "retrying") throw new SupervisorInvariantError(`cannot start a ${task.state} task`);
    task.state = "started";
    task.started_at = this.now();
    return this.snapshot(task);
  }

  reportProgress(id: string, progress: number): SupervisorTask {
    const task = this.mustGet(id);
    this.requireLive(id);
    if (task.state !== "started" && task.state !== "retrying") throw new SupervisorInvariantError("progress is only valid for running tasks");
    if (!Number.isFinite(progress) || progress < 0 || progress > 1) throw new SupervisorInvariantError("progress must be between 0 and 1");
    if (task.progress !== null && progress < task.progress) throw new SupervisorInvariantError("progress cannot move backwards");
    const observedAt = this.now();
    this.assertObservationDoesNotMoveBackwards(task.last_progress_at, observedAt, "progress");
    task.progress = progress;
    task.last_progress_at = observedAt;
    task.progress_sequence += 1;
    return this.snapshot(task);
  }

  /** Record liveness without claiming that task progress advanced. */
  reportHeartbeat(id: string): SupervisorTask {
    const task = this.mustGet(id);
    this.requireLive(id);
    if (task.state !== "started" && task.state !== "retrying") throw new SupervisorInvariantError("heartbeat is only valid for running tasks");
    const observedAt = this.now();
    this.assertObservationDoesNotMoveBackwards(task.last_heartbeat_at, observedAt, "heartbeat");
    task.last_heartbeat_at = observedAt;
    return this.snapshot(task);
  }

  retry(id: string): SupervisorTask {
    const task = this.mustGet(id);
    if (!isTerminal(task.state)) throw new SupervisorInvariantError("only a terminal task can be retried");
    if (task.cleanup !== "completed") throw new SupervisorInvariantError("cleanup must complete before retrying a task");
    if (this.hasChildren(task.id)) throw new SupervisorInvariantError("a task with retained children cannot be retried");
    const retryStartedAt = this.now();
    this.assertRetryLineageIsAdmissible(task, retryStartedAt);
    if (task.parent_id !== null) this.acquireSiblingLease(task.id, task.parent_id);
    task.state = "retrying";
    task.started_at = retryStartedAt;
    task.progress = null;
    task.last_progress_at = null;
    task.last_heartbeat_at = null;
    task.retry_attempt += 1;
    task.cleanup = null;
    this.controllers.set(task.id, new AbortController());
    this.reconciliationRequired.delete(id);
    return this.snapshot(task);
  }

  complete(id: string): SupervisorTask { return this.terminate(id, "completed"); }
  fail(id: string): SupervisorTask { return this.terminate(id, "failed"); }
  timeout(id: string): SupervisorTask { return this.terminate(id, "timed_out"); }

  /** Request is idempotent; termination only occurs when the worker acknowledges it. */
  requestCancellation(id: string): SupervisorTask {
    this.requestCancellationSubtree(id);
    return this.snapshot(this.mustGet(id));
  }

  /** Deterministic parent-first propagation, returning every owned affected task once. */
  requestCancellationSubtree(id: string): string[] {
    const task = this.mustGet(id);
    this.requireLive(id);
    const affected: string[] = [];
    const request = (candidate: SupervisorTask): void => {
      this.requireLive(candidate.id);
      if (!isTerminal(candidate.state) && candidate.state !== "cancel_requested") {
        candidate.state = "cancel_requested";
        this.controllers.get(candidate.id)!.abort();
        affected.push(candidate.id);
      }
      for (const child of this.childrenOf(candidate.id).sort((a, b) => compareCodeUnits(a.id, b.id))) request(child);
    };
    request(task);
    return affected;
  }

  acknowledgeCancellation(id: string): SupervisorTask {
    const task = this.mustGet(id);
    this.requireLive(id);
    if (task.state === "cancelled") return this.snapshot(task);
    if (task.state !== "cancel_requested") throw new SupervisorInvariantError("cancellation must be requested before it can be acknowledged");
    const activeChild = this.childrenOf(id).find((child) => !isTerminal(child.state));
    if (activeChild) throw new SupervisorInvariantError(`cannot acknowledge parent cancellation while child ${activeChild.id} remains ${activeChild.state}`);
    task.state = "cancelled";
    task.cleanup = "pending";
    this.releaseSiblingLease(id);
    this.pruneRetainedTerminals();
    return this.snapshot(task);
  }

  /** Deterministic child-first acknowledgement prevents a cancelled parent hiding live descendants. */
  acknowledgeCancellationSubtree(id: string): string[] {
    this.mustGet(id);
    const acknowledged: string[] = [];
    const acknowledge = (candidate: SupervisorTask): void => {
      for (const child of this.childrenOf(candidate.id).sort((a, b) => compareCodeUnits(a.id, b.id))) acknowledge(child);
      if (candidate.state === "cancel_requested") {
        this.acknowledgeCancellation(candidate.id);
        acknowledged.push(candidate.id);
      }
    };
    acknowledge(this.mustGet(id));
    return acknowledged;
  }

  completeCleanup(id: string): SupervisorTask {
    const task = this.mustGet(id);
    if (!isTerminal(task.state)) throw new SupervisorInvariantError("cleanup is only valid for terminal tasks");
    if (task.cleanup === "completed") return this.snapshot(task);
    if (task.cleanup !== "pending") throw new SupervisorInvariantError("cleanup was not pending");
    if (this.childrenOf(id).some((child) => !isTerminal(child.state) || child.cleanup !== "completed")) {
      throw new SupervisorInvariantError("children must be terminal and cleaned before parent cleanup completes");
    }
    task.cleanup = "completed";
    this.pruneRetainedTerminals();
    return this.snapshot(task);
  }

  failCleanup(id: string): SupervisorTask {
    const task = this.mustGet(id);
    if (!isTerminal(task.state) || task.cleanup !== "pending") throw new SupervisorInvariantError("only pending terminal cleanup can fail");
    task.cleanup = "failed";
    return this.snapshot(task);
  }

  /** Removes one fully-cleaned terminal leaf; active work can never be orphaned. */
  remove(id: string): void {
    const task = this.mustGet(id);
    if (!isTerminal(task.state) || task.cleanup !== "completed") throw new SupervisorInvariantError("only fully-cleaned terminal tasks can be removed");
    if (this.hasChildren(id)) throw new SupervisorInvariantError("remove children before removing their parent");
    this.tasks.delete(id);
    this.controllers.delete(id);
    this.operations.delete(task.operation_id);
    this.reconciliationRequired.delete(id);
    this.releaseSiblingLease(id);
    this.rememberTombstone(task);
  }

  /** Explicitly prune safe terminal leaves, oldest first. Returns removed task IDs. */
  prune(limit = Number.MAX_SAFE_INTEGER): string[] {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new SupervisorInvariantError("prune limit must be a non-negative safe integer");
    const removed: string[] = [];
    for (const task of this.terminalLeaves()) {
      if (removed.length >= limit) break;
      this.remove(task.id);
      removed.push(task.id);
    }
    return removed;
  }

  private terminate(id: string, state: "completed" | "failed" | "timed_out"): SupervisorTask {
    const task = this.mustGet(id);
    this.requireLive(id);
    if (task.state === state) return this.snapshot(task);
    if (isTerminal(task.state)) throw new SupervisorInvariantError(`cannot change terminal task ${task.state} to ${state}`);
    if (task.state === "cancel_requested") throw new SupervisorInvariantError("a cancellation-requested task must acknowledge cancellation");
    let completedProgressAt: string | null = null;
    if (state === "completed" && task.progress !== 1) {
      const observedAt = this.now();
      this.assertObservationDoesNotMoveBackwards(task.last_progress_at, observedAt, "progress");
      completedProgressAt = observedAt;
    }
    task.state = state;
    if (completedProgressAt !== null) {
      task.progress = 1;
      task.last_progress_at = completedProgressAt;
      task.progress_sequence += 1;
    }
    task.cleanup = "pending";
    this.releaseSiblingLease(id);
    // A finished parent must not leave independently running descendants behind.
    for (const child of this.childrenOf(id)) this.requestCancellation(child.id);
    this.pruneRetainedTerminals();
    return this.snapshot(task);
  }

  private pruneRetainedTerminals(): void {
    const excess = this.list({ include_terminal: true }).filter((task) => isTerminal(task.state)).length - this.terminalRetention;
    if (excess > 0) this.prune(excess);
  }

  private terminalLeaves(): SupervisorTask[] {
    return [...this.tasks.values()]
      .filter((task) => isTerminal(task.state) && task.cleanup === "completed" && !this.hasChildren(task.id))
      .sort((a, b) => compareCodeUnits(a.started_at ?? "", b.started_at ?? "") || compareCodeUnits(a.id, b.id));
  }

  private childrenOf(id: string): SupervisorTask[] { return [...this.tasks.values()].filter((task) => task.parent_id === id); }
  private hasChildren(id: string): boolean { return this.childrenOf(id).length > 0; }
  /** Count ancestor chain length from this task upward to a root (depth 0 = no parent). */
  private depthOf(id: string): number {
    let depth = 0;
    let current: string | null = id;
    const seen = new Set<string>();
    while (current !== null) {
      if (seen.has(current)) break;
      seen.add(current);
      const task = this.tasks.get(current);
      current = task?.parent_id ?? null;
      if (current !== null) depth += 1;
    }
    return depth;
  }
  private mustGet(id: string): SupervisorTask { const task = this.tasks.get(id); if (task === undefined) throw new SupervisorInvariantError(`unknown task ${id}`); return task; }
  private now(): string { return this.clock().toISOString(); }
  private assertObservationDoesNotMoveBackwards(previous: string | null, current: string, label: string): void {
    if (previous !== null && Date.parse(current) < Date.parse(previous)) {
      throw new SupervisorInvariantError(`${label} observation time cannot move backwards`);
    }
  }
  private snapshot(task: SupervisorTask): SupervisorTask { return { ...task }; }
  private requireText(value: string, label: string): void { if (value.trim().length === 0) throw new SupervisorInvariantError(`${label} must be non-empty`); }
  private sameRegistration(task: SupervisorTask, input: TaskRegistration): boolean {
    return task.id === input.id && task.kind === input.kind && task.owner_scope_id === input.owner_scope_id
      && task.parent_id === (input.parent_id ?? null) && task.deadline_at === (input.deadline_at ?? null);
  }
  private requireLive(id: string): void {
    if (this.reconciliationRequired.has(id)) throw new SupervisorInvariantError(`task ${id} is restored evidence and requires reconciliation before it can transition`);
  }
  private acquireSiblingLease(taskId: string, parentId: string): void {
    if (this.childLeases.has(taskId)) return;
    const active = this.siblingLeases(parentId);
    if (active.length >= this.siblingBounds.maxSimultaneousSiblings) {
      throw new SupervisorInvariantError(`parent ${parentId} already has ${active.length} active siblings; maxSimultaneousSiblings ${this.siblingBounds.maxSimultaneousSiblings} exceeded`);
    }
    this.childLeases.set(taskId, { lease_id: `task:${taskId}`, task_id: taskId, parent_id: parentId, acquired_at: this.now() });
  }
  private releaseSiblingLease(taskId: string): void { this.childLeases.delete(taskId); }
  private assertRetryLineageIsAdmissible(task: SupervisorTask, retryStartedAt: string): void {
    const retryTime = Date.parse(retryStartedAt);
    let current: SupervisorTask | undefined = task;
    while (current !== undefined) {
      if (current.deadline_at !== null && Date.parse(current.deadline_at) <= retryTime) {
        throw new SupervisorInvariantError(`cannot retry task ${task.id} after ${current.id}'s deadline`);
      }
      if (current.id !== task.id && isTerminal(current.state)) {
        throw new SupervisorInvariantError(`cannot retry task ${task.id} under terminal ancestor ${current.id}`);
      }
      current = current.parent_id === null ? undefined : this.mustGet(current.parent_id);
    }
  }
  private validateRestoredLifecycle(task: SupervisorTask): void {
    if (task.state === "accepted" && (task.started_at !== null || task.progress !== null || task.cleanup !== null || task.retry_attempt !== 0)) {
      throw new SupervisorInvariantError(`restored accepted task ${task.id} has invalid lifecycle fields`);
    }
    if ((task.state === "started" || task.state === "retrying" || task.state === "cancel_requested") && task.cleanup !== null) {
      throw new SupervisorInvariantError(`restored active task ${task.id} cannot have cleanup state`);
    }
    if (task.state === "retrying" && task.retry_attempt === 0) throw new SupervisorInvariantError(`restored retrying task ${task.id} must have a retry attempt`);
    if (isTerminal(task.state) && task.cleanup === null) throw new SupervisorInvariantError(`restored terminal task ${task.id} must record cleanup state`);
  }
  private assertNoParentCycle(task: SupervisorTask, tasks: ReadonlyMap<string, SupervisorTask>): void {
    const seen = new Set<string>([task.id]);
    let parentId = task.parent_id;
    while (parentId !== null) {
      if (seen.has(parentId)) throw new SupervisorInvariantError(`restored task ${task.id} is part of a parent cycle`);
      seen.add(parentId);
      parentId = tasks.get(parentId)!.parent_id;
    }
  }
  private rememberTombstone(task: SupervisorTask): void {
    if (this.operationTombstoneRetention === 0) return;
    this.operationTombstones.set(task.operation_id, {
      id: task.id, operation_id: task.operation_id, kind: task.kind, owner_scope_id: task.owner_scope_id,
      parent_id: task.parent_id, deadline_at: task.deadline_at,
    });
    this.tombstoneOrder.push(task.operation_id);
    while (this.tombstoneOrder.length > this.operationTombstoneRetention) this.pruneOperationTombstones(1);
  }
}
