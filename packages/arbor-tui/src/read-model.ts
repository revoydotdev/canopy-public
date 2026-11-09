/**
 * TUI read-side event projection (M1.3, ADR-011). Pure, deterministic
 * folding of canonical `RuntimeEventEnvelope`s into a bounded read model the
 * TUI can render from, without re-querying the whole product surface on
 * every poll. This module owns no transport, no clock, and no I/O — it is a
 * reducer over `@arbor/core`'s own cursor/envelope contracts, reused rather
 * than redefined (see `runtime-port.ts`'s `RuntimeEventSource`, which is the
 * transport seam that feeds this).
 *
 * Watermark semantics (mirrors `RuntimeEventStream.resume`'s own cursor
 * discipline so a read model can never silently diverge from the canonical
 * stream):
 *   - the watermark is the cursor of the last envelope actually applied;
 *   - a cursor from a different `stream_id` is rejected outright — a read
 *     model bound to one runtime/stream must never absorb another one's
 *     events;
 *   - `sequence <= watermark.sequence` is a duplicate: counted, ignored;
 *   - `sequence > watermark.sequence + 1` is a gap: the model flips to
 *     `resync_required` and stops applying further envelopes in the SAME
 *     batch and every batch after, until a fresh `applySnapshot` re-seeds it;
 *   - `stream.truncated` always forces `resync_required` for the same reason
 *     a gap does — the stream itself declares its own history unreliable
 *     past that point.
 * A model with no watermark yet (`emptyReadModel`, never snapshotted) treats
 * the missing watermark as sequence 0 — the same "from the beginning" cursor
 * convention `tui.ts`'s diagnostics screen already uses for `event.resume`.
 */
import type {
  RuntimeCursor,
  RuntimeEvent,
  RuntimeEventEnvelope,
  RuntimeError,
  SupervisorTask,
  SupervisorTaskState,
} from "@arbor/core";

export const TUI_READ_MODEL_VERSION = 1 as const;
export type TuiReadModelVersion = typeof TUI_READ_MODEL_VERSION;
const MAX_EVENT_TAIL = 1_000;

/** Latest known gate result for one (campaign, node, gate) triple. */
export interface GateResultView {
  readonly campaign_id: string;
  readonly node_id: string | null;
  readonly gate: string;
  readonly result: "pass" | "fail" | "bypass";
  readonly bypass_evidence_deficit?: string;
}

/** Latest known state for one (campaign, node) tree position. */
export interface TreeNodeView {
  readonly campaign_id: string;
  readonly node_id: string;
  readonly state: string;
}

/** Latest known outcome for one operation id. */
export interface OperationOutcomeView {
  readonly operation_id: string;
  readonly accepted: boolean;
  readonly error?: RuntimeError;
}

export type ReadModelStatus = "ok" | "resync_required";

/**
 * Bounded projection maps. Each is capped independently (see the `*_BOUND`
 * constants below) by evicting the OLDEST inserted key once a NEW key would
 * push the map past its bound — a plain insertion-order LRU, deterministic
 * given a fixed sequence of envelopes. Updating an already-present key never
 * evicts (it is not a new key), so a hot, frequently-updated id is never
 * penalized for being touched often.
 */
export interface TuiReadModel {
  readonly version: TuiReadModelVersion;
  readonly stream_id: string;
  readonly watermark: RuntimeCursor | null;
  readonly status: ReadModelStatus;
  /** Ordered canonical envelopes retained since the last snapshot, for screens that fold their own bounded semantic projections. */
  readonly eventTail: readonly RuntimeEventEnvelope[];
  readonly tasks: ReadonlyMap<string, SupervisorTask>;
  readonly operations: ReadonlyMap<string, OperationOutcomeView>;
  readonly gates: ReadonlyMap<string, GateResultView>;
  readonly treeNodes: ReadonlyMap<string, TreeNodeView>;
  /**
   * Terminal tombstones: task id -> the retry_attempt it was last known
   * terminal at, for tasks EVICTED from `tasks`. Eviction must not erase the
   * terminal-state protection `taskUpdateAllowed` gives a live entry, or a
   * late stale event for an evicted completed task would resurrect it. A
   * tombstone is one number per id, so it can be kept far longer than a full
   * task record. Beyond `max_terminal_tombstones` the protection relies on
   * the canonical stream's own ordering (ADR-161, residuals).
   */
  readonly terminalAttempts: ReadonlyMap<string, number>;
  /**
   * The id of the task most recently touched by an applied `task.changed`
   * event, for the M2 Inspect tab's "most recent operation/task" surface
   * (ui-spec §4). `Map` iteration order does not move an updated key, so
   * this is tracked explicitly rather than assumed from `tasks`' own order.
   * `null` until the first task event lands.
   */
  readonly lastTaskId: string | null;
  /**
   * The cursor sequence `applySnapshot` last re-seeded at, while no task has
   * yet been observed since. `applySnapshot` never decodes a real snapshot
   * into these maps (ADR-161, residuals), so an empty `tasks` map right
   * after a resync means "not yet known", not "nothing is running" — the
   * Inspect tab (`responsive-sidebar.ts`) must say so explicitly. Cleared
   * the moment a real `task.changed` event is folded, because that is
   * positive evidence again.
   */
  readonly resyncedAtSeq: number | null;
}

export interface ApplyOutcome {
  readonly applied: number;
  readonly duplicates: number;
  readonly rejected_foreign_stream: number;
  readonly gap_detected: boolean;
  readonly truncated: boolean;
  readonly resync_required: boolean;
}

/** Documented bounds — see the class doc comment above for the eviction rule. */
export const TUI_READ_MODEL_BOUNDS = Object.freeze({
  max_tasks: 4_096,
  max_operations: 4_096,
  max_gate_results: 4_096,
  max_tree_nodes: 8_192,
  max_terminal_tombstones: 65_536,
} as const);

const TERMINAL_TASK_STATES: ReadonlySet<SupervisorTaskState> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

export function emptyReadModel(streamId: string): TuiReadModel {
  return {
    version: TUI_READ_MODEL_VERSION,
    stream_id: streamId,
    watermark: null,
    status: "ok",
    eventTail: [],
    tasks: new Map(),
    operations: new Map(),
    gates: new Map(),
    treeNodes: new Map(),
    terminalAttempts: new Map(),
    lastTaskId: null,
    resyncedAtSeq: null,
  };
}

/**
 * Re-seed the model at a fresh cursor from a canonical snapshot. This is the
 * only place projection maps are ever cleared — every prior projected fact
 * predates the snapshot boundary and is superseded by it. `seed` is the
 * opaque snapshot value `RuntimeEventStream.resume`/`event.resume` returns;
 * this module does not currently know how to decode a canonical runtime
 * snapshot's task/gate/tree shape into these projections (no producer wires
 * that today), so it is accepted for forward-compatibility but not yet
 * read — the model starts EMPTY at the snapshot's cursor and repopulates
 * as `applyEnvelopes` folds subsequent events. Flag this to the lead:
 * a real snapshot-to-projection decoder is a follow-up, not silently done
 * here.
 */
export function applySnapshot(model: TuiReadModel, cursor: RuntimeCursor, seed: unknown): TuiReadModel {
  void model;
  void seed;
  return {
    version: TUI_READ_MODEL_VERSION,
    stream_id: cursor.stream_id,
    watermark: cursor,
    status: "ok",
    eventTail: [],
    tasks: new Map(),
    operations: new Map(),
    gates: new Map(),
    treeNodes: new Map(),
    terminalAttempts: new Map(),
    lastTaskId: null,
    resyncedAtSeq: cursor.sequence,
  };
}

function withBoundedSet<K, V>(map: ReadonlyMap<K, V>, key: K, value: V, bound: number): Map<K, V> {
  const next = new Map(map);
  const isNewKey = !next.has(key);
  next.set(key, value);
  if (isNewKey) {
    while (next.size > bound) {
      const oldest = next.keys().next();
      if (oldest.done) break;
      next.delete(oldest.value);
    }
  }
  return next;
}

/**
 * Insert/update a task, recording a tombstone for every terminal task the
 * bound evicts and dropping the tombstone of a task that is live again.
 */
function withTask(model: TuiReadModel, task: SupervisorTask): TuiReadModel {
  const tasks = new Map(model.tasks);
  const terminalAttempts = new Map(model.terminalAttempts);
  const isNewKey = !tasks.has(task.id);
  tasks.set(task.id, task);
  terminalAttempts.delete(task.id);
  if (isNewKey) {
    while (tasks.size > TUI_READ_MODEL_BOUNDS.max_tasks) {
      const oldest = tasks.entries().next();
      if (oldest.done) break;
      const [id, evicted] = oldest.value;
      tasks.delete(id);
      if (TERMINAL_TASK_STATES.has(evicted.state)) {
        terminalAttempts.set(id, evicted.retry_attempt);
        while (terminalAttempts.size > TUI_READ_MODEL_BOUNDS.max_terminal_tombstones) {
          const stale = terminalAttempts.keys().next();
          if (stale.done) break;
          terminalAttempts.delete(stale.value);
        }
      }
    }
  }
  return { ...model, tasks, terminalAttempts, lastTaskId: task.id, resyncedAtSeq: null };
}

function gateKey(campaignId: string, nodeId: string | null, gate: string): string {
  return `${campaignId}\u0000${nodeId ?? ""}\u0000${gate}`;
}

function treeNodeKey(campaignId: string, nodeId: string): string {
  return `${campaignId}\u0000${nodeId}`;
}

/** False when applying `incoming` would resurrect terminal state (live entry or evicted tombstone). */
function taskUpdateAllowed(existing: SupervisorTask | undefined, tombstone: number | undefined, incoming: SupervisorTask): boolean {
  if (existing === undefined) {
    if (tombstone === undefined) return true;
    return incoming.retry_attempt > tombstone || (incoming.retry_attempt === tombstone && TERMINAL_TASK_STATES.has(incoming.state));
  }
  // A lower retry_attempt is stale information arriving late; never let it
  // overwrite a higher attempt's already-known state.
  if (incoming.retry_attempt < existing.retry_attempt) return false;
  // Same attempt: once terminal, that attempt stays terminal. A later
  // non-terminal event for the SAME attempt is a stale re-delivery (or an
  // out-of-order duplicate) and must not resurrect it.
  if (incoming.retry_attempt === existing.retry_attempt && TERMINAL_TASK_STATES.has(existing.state) && !TERMINAL_TASK_STATES.has(incoming.state)) {
    return false;
  }
  return true;
}

function applyEvent(model: TuiReadModel, event: RuntimeEvent): TuiReadModel {
  switch (event.kind) {
    case "task.changed": {
      const existing = model.tasks.get(event.task.id);
      if (!taskUpdateAllowed(existing, model.terminalAttempts.get(event.task.id), event.task)) return model;
      return withTask(model, event.task);
    }
    case "operation.accepted": {
      const value: OperationOutcomeView = { operation_id: event.accepted_operation_id, accepted: true };
      return { ...model, operations: withBoundedSet(model.operations, event.accepted_operation_id, value, TUI_READ_MODEL_BOUNDS.max_operations) };
    }
    case "operation.rejected": {
      const operationId = event.error.operation_id;
      if (operationId === undefined) return model; // nothing to key the outcome by
      const value: OperationOutcomeView = { operation_id: operationId, accepted: false, error: event.error };
      return { ...model, operations: withBoundedSet(model.operations, operationId, value, TUI_READ_MODEL_BOUNDS.max_operations) };
    }
    case "gate.recorded": {
      const key = gateKey(event.campaign_id, event.node_id, event.gate);
      const value: GateResultView = {
        campaign_id: event.campaign_id,
        node_id: event.node_id,
        gate: event.gate,
        result: event.result,
        ...(event.bypass_evidence_deficit === undefined ? {} : { bypass_evidence_deficit: event.bypass_evidence_deficit }),
      };
      return { ...model, gates: withBoundedSet(model.gates, key, value, TUI_READ_MODEL_BOUNDS.max_gate_results) };
    }
    case "tree.node_changed": {
      const key = treeNodeKey(event.campaign_id, event.node_id);
      const value: TreeNodeView = { campaign_id: event.campaign_id, node_id: event.node_id, state: event.state };
      return { ...model, treeNodes: withBoundedSet(model.treeNodes, key, value, TUI_READ_MODEL_BOUNDS.max_tree_nodes) };
    }
    default:
      // campaign.changed, kb.entry_added, audit.evidence_recorded,
      // taskcomposer.changed, tree.decomposed, stream.truncated: not part of
      // the M1.3 projection surface (stream.truncated is handled by the
      // watermark/resync logic in applyEnvelopes, before this switch runs).
      return model;
  }
}

/**
 * Fold a batch of envelopes into `model`. Never throws; every rejection is
 * counted in the returned outcome instead. Once `status` is
 * `resync_required` (either already, or flipped mid-batch), no further
 * envelope in THIS OR ANY LATER call is applied until a fresh
 * `applySnapshot` resets it — that is the whole point of the flag.
 */
export function applyEnvelopes(model: TuiReadModel, envelopes: readonly RuntimeEventEnvelope[]): { model: TuiReadModel; outcome: ApplyOutcome } {
  if (model.status === "resync_required") {
    return { model, outcome: { applied: 0, duplicates: 0, rejected_foreign_stream: 0, gap_detected: false, truncated: false, resync_required: true } };
  }
  let current = model;
  let applied = 0;
  let duplicates = 0;
  let rejectedForeignStream = 0;
  let gapDetected = false;
  let truncated = false;
  for (const envelope of envelopes) {
    if (envelope.cursor.stream_id !== current.stream_id) {
      rejectedForeignStream++;
      continue;
    }
    const watermarkSequence = current.watermark?.sequence ?? 0;
    if (envelope.cursor.sequence <= watermarkSequence) {
      duplicates++;
      continue;
    }
    if (envelope.cursor.sequence > watermarkSequence + 1) {
      gapDetected = true;
      current = { ...current, status: "resync_required" };
      break;
    }
    current = applyEvent(current, envelope.event);
    current = {
      ...current,
      watermark: envelope.cursor,
      eventTail: [...current.eventTail, envelope].slice(-MAX_EVENT_TAIL),
    };
    applied++;
    if (envelope.event.kind === "stream.truncated") {
      truncated = true;
      current = { ...current, status: "resync_required" };
      break;
    }
  }
  return {
    model: current,
    outcome: {
      applied,
      duplicates,
      rejected_foreign_stream: rejectedForeignStream,
      gap_detected: gapDetected,
      truncated,
      resync_required: current.status === "resync_required",
    },
  };
}

/** Structured task/operation state for the M2 Inspect rail tab (ui-spec §4). */
export interface InspectTaskSummary {
  readonly task_id: string;
  readonly operation_id: string;
  readonly kind: string;
  readonly owner_scope_id: string;
  readonly retry_attempt: number;
  readonly state: SupervisorTaskState;
  readonly started_at: string | null;
  readonly deadline_at: string | null;
}

/** One latest gate result scoped to the Inspect tab's selected campaign/node. */
export interface InspectGateSummary {
  readonly gate: string;
  readonly node_id: string | null;
  readonly result: "pass" | "fail" | "bypass";
}

/**
 * Everything the Inspect tab needs from the read model, computed once so the
 * render layer (`responsive-sidebar.ts`) never reaches into `TuiReadModel`'s
 * maps itself. `resync_required` must never be paired with a truthy `task` —
 * `resyncNote` is the only thing Inspect may say instead (never "nothing
 * running": a resync means the projection cannot yet PROVE nothing is
 * running, which is a different, weaker claim).
 */
export interface InspectSummary {
  readonly status: ReadModelStatus;
  readonly watermark_seq: number;
  readonly resync_note: string | null;
  readonly task: InspectTaskSummary | null;
  readonly gates: readonly InspectGateSummary[];
}

/**
 * Scope for the "latest gate results for its campaign/node" requirement
 * (ui-spec §4): a `SupervisorTask` carries no campaign/node identity of its
 * own (`runtime-contracts.ts`'s `SupervisorTask`), so the caller supplies the
 * currently-selected campaign/node (already known to the composition root
 * via `telemetryCampaignId`/tree selection) rather than this module guessing
 * a linkage it cannot prove.
 */
export interface InspectScope {
  readonly task_id?: string;
  readonly campaign_id?: string;
  readonly node_id?: string;
}

/**
 * Pure projection from the bounded read model to the Inspect tab's exact
 * displayed facts (ui-spec §4: owner/kind, operation/task ids, retry_attempt,
 * lifecycle state, latest gate results for its campaign/node,
 * started/deadline, watermark seq, resync state).
 */
export function summarizeForInspect(model: TuiReadModel, scope: InspectScope = {}): InspectSummary {
  const watermarkSeq = model.watermark?.sequence ?? 0;
  if (model.status === "resync_required") {
    return {
      status: "resync_required",
      watermark_seq: watermarkSeq,
      resync_note: `resync required — history before seq ${watermarkSeq} not shown`,
      task: null,
      gates: [],
    };
  }
  const selectedTask = (scope.task_id !== undefined ? model.tasks.get(scope.task_id) : undefined)
    ?? (model.lastTaskId !== null ? model.tasks.get(model.lastTaskId) : undefined);
  const task: InspectTaskSummary | null = selectedTask === undefined ? null : {
    task_id: selectedTask.id,
    operation_id: selectedTask.operation_id,
    kind: selectedTask.kind,
    owner_scope_id: selectedTask.owner_scope_id,
    retry_attempt: selectedTask.retry_attempt,
    state: selectedTask.state,
    started_at: selectedTask.started_at,
    deadline_at: selectedTask.deadline_at,
  };
  const gates: InspectGateSummary[] = scope.campaign_id === undefined ? [] : [...model.gates.values()]
    .filter((gate) => gate.campaign_id === scope.campaign_id && (scope.node_id === undefined || gate.node_id === scope.node_id))
    .map((gate) => ({ gate: gate.gate, node_id: gate.node_id, result: gate.result }));
  const resyncNote = model.resyncedAtSeq === null ? null
    : `resynced — history before seq ${model.resyncedAtSeq} not shown`;
  return { status: "ok", watermark_seq: watermarkSeq, resync_note: resyncNote, task, gates };
}
