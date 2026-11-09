/**
 * M6 Inspect reader and side-query lifecycle.
 *
 * Inspect is deliberately a read-side service.  It may query an injected
 * RuntimePort, but it has no shell, filesystem, or arbitrary command tools.
 * Side-query records, drafts, cancellation, and scheduling are separate from
 * the primary conversation and command queue.  A caller must invoke
 * `promote` explicitly before a side answer can become a governed command.
 */
import type {
  RuntimeCommandRequest,
  RuntimePort,
  RuntimeQueryRequest,
  RuntimeResult,
} from "./runtime-port.js";

export interface InspectClock { now(): string; }

export interface InspectActionState {
  readonly action_id: string;
  readonly owner: string | null;
  readonly attempt_id: string | null;
  readonly lifecycle: string;
  readonly gate_state: string | null;
  readonly dependencies: readonly string[];
  readonly dependency_details: readonly InspectDependencyView[];
  readonly started_at: string | null;
  readonly last_updated_at: string | null;
  readonly activity: readonly string[];
  readonly records: readonly string[];
  readonly evidence_ids: readonly string[];
  readonly evidence_details: readonly InspectEvidenceView[];
  readonly state: "known" | "unknown";
  readonly redacted_fields: readonly string[];
}

export interface InspectDependencyView {
  readonly id: string;
  readonly state: string;
  readonly action_id: string | null;
}

export interface InspectEvidenceView {
  readonly id: string;
  readonly kind: string;
  readonly as_of: string | null;
}

export interface InspectSnapshot {
  readonly snapshot_id: string;
  readonly as_of: string;
  readonly freshness: "fresh" | "stale" | "unknown";
  readonly evidence_ids: readonly string[];
  readonly actions: readonly InspectActionState[];
}

export interface InspectDraft {
  readonly draft_id: string;
  readonly text: string;
  readonly updated_at: string;
}

export type SideQueryStatus = "queued" | "running" | "completed" | "cancelled" | "rejected" | "failed";

export interface SideQueryAnswer {
  readonly kind: "deterministic" | "model" | "unknown";
  readonly text: string;
  readonly evidence_ids: readonly string[];
  readonly as_of: string;
}

export interface SideQueryRecord {
  readonly request_id: string;
  readonly question: string;
  readonly snapshot_id: string;
  readonly submitted_at: string;
  readonly finished_at: string | null;
  readonly status: SideQueryStatus;
  readonly answer: SideQueryAnswer | null;
  readonly error: string | null;
  readonly redacted_fields: readonly string[];
  readonly promoted_command_id: string | null;
}

export interface InspectRecordStore {
  append(record: SideQueryRecord): void;
  list(): readonly SideQueryRecord[];
}

/** A persistence seam whose implementation can be backed by an append-only JSONL file. */
export interface InspectRecordPersistence {
  read(): readonly string[];
  append(line: string): void;
}

/** Durable store implementation; it never chooses a filesystem or opens tools itself. */
export class DurableInspectRecordStore implements InspectRecordStore {
  private readonly records: SideQueryRecord[];
  constructor(private readonly persistence: InspectRecordPersistence) {
    this.records = persistence.read().flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line);
        return value !== null && typeof value === "object" && typeof (value as { request_id?: unknown }).request_id === "string"
          ? [value as SideQueryRecord] : [];
      } catch { return []; }
    });
  }
  append(record: SideQueryRecord): void {
    const frozen = Object.freeze({ ...record });
    this.records.push(frozen);
    this.persistence.append(JSON.stringify(frozen));
  }
  list(): readonly SideQueryRecord[] { return this.records.slice(); }
}

export class MemoryInspectRecordStore implements InspectRecordStore {
  private readonly records: SideQueryRecord[] = [];
  append(record: SideQueryRecord): void { this.records.push(Object.freeze({ ...record })); }
  list(): readonly SideQueryRecord[] { return this.records.slice(); }
}

export interface InspectModelInput {
  readonly question: string;
  readonly snapshot: InspectSnapshot;
  readonly signal: AbortSignal;
}

export type InspectModel = (input: InspectModelInput) => Promise<string>;

export interface InspectOptions {
  readonly clock?: InspectClock;
  readonly store?: InspectRecordStore;
  readonly max_concurrent?: number;
  readonly max_pending?: number;
  readonly max_question_bytes?: number;
  readonly model?: InspectModel;
}

export interface InspectActionResult {
  readonly ok: boolean;
  readonly snapshot?: InspectSnapshot;
  readonly error?: string;
}

const SENSITIVE_KEY = /(?:secret|token|password|passwd|api[_-]?key|credential|authorization|private[_-]?key|access[_-]?key)/i;
const MUTATION_REQUEST = /\b(?:change|modify|delete|remove|write|edit|run|execute|cancel|retry|branch|prune|send|submit|approve|reject|update)\b/i;

function text(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((v) => typeof v === "string" ? [v] : v !== null && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? [(v as { id: string }).id] : []).slice(0, 100) : [];
}
function dependencyViews(value: unknown): InspectDependencyView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [{ id: entry, state: "unknown", action_id: null }];
    if (entry === null || typeof entry !== "object" || typeof (entry as { id?: unknown }).id !== "string") return [];
    const item = entry as Record<string, unknown>;
    return [{ id: item.id as string, state: text(item.state ?? item.status) ?? "unknown", action_id: text(item.action_id ?? item.actionId) }];
  }).slice(0, 100);
}
function evidenceViews(value: unknown): InspectEvidenceView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [{ id: entry, kind: "unknown", as_of: null }];
    if (entry === null || typeof entry !== "object" || typeof (entry as { id?: unknown }).id !== "string") return [];
    const item = entry as Record<string, unknown>;
    return [{ id: item.id as string, kind: text(item.kind ?? item.type) ?? "unknown", as_of: text(item.as_of ?? item.asOf) }];
  }).slice(0, 100);
}
function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
function redactText(value: string, redacted: string[]): string {
  return value.replace(/\b(?:token|password|secret|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, (match) => { redacted.push("answer:text"); return match.replace(/[:=].*$/, ": [REDACTED]"); });
}

/** Redact before a value enters a side-query record or optional model. */
export function redactInspectValue(value: unknown, path = "root", redacted: string[] = []): unknown {
  if (Array.isArray(value)) return value.slice(0, 100).map((entry, index) => redactInspectValue(entry, `${path}[${index}]`, redacted));
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const entryPath = `${path}.${key}`;
      if (SENSITIVE_KEY.test(key)) { output[key] = "[REDACTED]"; redacted.push(entryPath); }
      else output[key] = redactInspectValue(entry, entryPath, redacted);
    }
    return output;
  }
  return typeof value === "string" && value.length > 4096 ? `${value.slice(0, 4096)}…` : value;
}

function freezeAction(action: InspectActionState): InspectActionState { return Object.freeze({ ...action, dependencies: Object.freeze([...action.dependencies]), dependency_details: Object.freeze(action.dependency_details.map((entry) => Object.freeze({ ...entry }))), activity: Object.freeze([...action.activity]), records: Object.freeze([...action.records]), evidence_ids: Object.freeze([...action.evidence_ids]), evidence_details: Object.freeze(action.evidence_details.map((entry) => Object.freeze({ ...entry }))), redacted_fields: Object.freeze([...action.redacted_fields]) }); }

function projectAction(actionId: string, raw: unknown): InspectActionState {
  const redacted: string[] = [];
  const safe = redactInspectValue(raw, "action", redacted) as Record<string, unknown>;
  const get = (...keys: string[]): unknown => keys.reduce<unknown>((current, key) => current ?? safe[key], undefined);
  const lifecycle = text(get("lifecycle", "state", "status")) ?? "unknown";
  const dependencyDetails = dependencyViews(get("dependencies", "dependency_ids"));
  const evidenceDetails = evidenceViews(get("evidence", "evidence_refs", "evidence_ids"));
  return freezeAction({
    action_id: actionId,
    owner: text(get("owner", "agent", "actor")),
    attempt_id: text(get("attempt_id", "attemptId")),
    lifecycle,
    gate_state: text(get("gate_state", "gateState", "gate")),
    dependencies: dependencyDetails.map((entry) => entry.id),
    dependency_details: dependencyDetails,
    started_at: text(get("started_at", "startedAt", "start_time")),
    last_updated_at: text(get("last_updated_at", "lastUpdatedAt", "updated_at")),
    activity: stringList(get("activity", "recent_activity", "events")),
    records: stringList(get("records", "record_ids")),
    evidence_ids: evidenceDetails.map((entry) => entry.id),
    evidence_details: evidenceDetails,
    state: raw === null || raw === undefined ? "unknown" : "known",
    redacted_fields: redacted,
  });
}

function unknownAnswer(question: string, snapshot: InspectSnapshot): SideQueryAnswer {
  return { kind: "unknown", text: `Unknown: no supported evidence answers “${question}” as of ${snapshot.as_of}.`, evidence_ids: snapshot.evidence_ids, as_of: snapshot.as_of };
}

function deterministicAnswer(question: string, snapshot: InspectSnapshot): SideQueryAnswer | null {
  const lower = question.toLowerCase();
  if (/\bhow many\b|\bcount\b/.test(lower)) return { kind: "deterministic", text: `${snapshot.actions.length} action(s) are present in the snapshot.`, evidence_ids: snapshot.evidence_ids, as_of: snapshot.as_of };
  if (/\b(owner|who owns)\b/.test(lower) && snapshot.actions.length === 1) {
    const owner = snapshot.actions[0]?.owner;
    if (owner) return { kind: "deterministic", text: `Owner: ${owner}.`, evidence_ids: [...snapshot.evidence_ids, ...snapshot.actions[0].evidence_ids], as_of: snapshot.as_of };
  }
  if (/\b(state|status|lifecycle)\b/.test(lower) && snapshot.actions.length === 1) return { kind: "deterministic", text: `Lifecycle: ${snapshot.actions[0].lifecycle}.`, evidence_ids: [...snapshot.evidence_ids, ...snapshot.actions[0].evidence_ids], as_of: snapshot.as_of };
  return null;
}

function cloneRecord(record: SideQueryRecord, patch: Partial<SideQueryRecord>): SideQueryRecord { return Object.freeze({ ...record, ...patch }); }

export class InspectService {
  private readonly clock: InspectClock;
  private readonly store: InspectRecordStore;
  private readonly maxConcurrent: number;
  private readonly maxQuestionBytes: number;
  private readonly maxPending: number;
  private readonly model?: InspectModel;
  private readonly drafts = new Map<string, InspectDraft>();
  private readonly snapshots = new Map<string, InspectSnapshot>();
  private readonly records = new Map<string, SideQueryRecord>();
  private readonly queue: string[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private readonly promotions = new Map<string, { readonly operation_id: string; readonly capability: string }>();
  private running = 0;
  private serial = 0;

  constructor(private readonly runtime: RuntimePort, options: InspectOptions = {}) {
    this.clock = options.clock ?? { now: () => new Date().toISOString() };
    this.store = options.store ?? new MemoryInspectRecordStore();
    this.maxConcurrent = Math.max(1, Math.min(8, options.max_concurrent ?? 2));
    this.maxPending = Math.max(1, Math.min(64, options.max_pending ?? 16));
    this.maxQuestionBytes = Math.max(256, Math.min(16_384, options.max_question_bytes ?? 4096));
    this.model = options.model;
    // Rehydrate the latest durable revision for each request.  Inspect records
    // are append-only, so a restart must recover the current lifecycle (and a
    // prior promotion) rather than silently treating every request as new.
    for (const record of this.store.list()) {
      this.records.set(record.request_id, record);
      if (record.promoted_command_id !== null) {
        this.promotions.set(record.request_id, {
          operation_id: record.promoted_command_id,
          // The only promotion route is taskcomposer.submit; retaining its
          // catalog capability makes a replay after restart observationally
          // identical to an in-process idempotent replay.
          capability: "taskcomposer.write",
        });
      }
    }
  }

  get draftsHistory(): readonly InspectDraft[] { return [...this.drafts.values()]; }
  get history(): readonly SideQueryRecord[] { return this.store.list(); }
  get(requestId: string): SideQueryRecord | null { return this.records.get(requestId) ?? null; }

  async inspectAction(actionId: string, params: Readonly<Record<string, unknown>> = {}): Promise<InspectActionResult> {
    if (!actionId || actionId.length > 256) return { ok: false, error: "action id is required and bounded" };
    const request: RuntimeQueryRequest = { kind: "inspect.action", query_id: this.nextId("inspect"), params: { ...params, action_id: actionId } };
    const result = await this.runtime.query(request);
    if (!result.ok) return { ok: false, error: result.error.summary };
  const raw = result.value;
  const action = projectAction(actionId, raw);
    const authoritative = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const asOf = text(authoritative.as_of ?? authoritative.observed_at ?? authoritative.updated_at ?? authoritative.last_updated_at) ?? this.clock.now();
    const observedAt = text(authoritative.as_of ?? authoritative.observed_at ?? authoritative.updated_at ?? authoritative.last_updated_at);
    const declaredFreshness = authoritative.freshness;
    const freshness = declaredFreshness === "fresh" || declaredFreshness === "stale" || declaredFreshness === "unknown"
      ? declaredFreshness
      : observedAt === null ? "unknown" : "fresh";
    const snapshot: InspectSnapshot = Object.freeze({ snapshot_id: text(authoritative.snapshot_id) ?? this.nextId("snapshot"), as_of: asOf, freshness, evidence_ids: action.evidence_ids, actions: [action] });
    this.snapshots.set(snapshot.snapshot_id, snapshot);
    return { ok: true, snapshot };
  }

  saveDraft(draftId: string, value: string): InspectDraft {
    if (!draftId || draftId.length > 128) throw new Error("draft id is required and bounded");
    if (byteLength(value) > this.maxQuestionBytes) throw new Error("side-query draft exceeds bound");
    const draft = Object.freeze({ draft_id: draftId, text: value, updated_at: this.clock.now() });
    this.drafts.set(draftId, draft);
    return draft;
  }

  ask(question: string, snapshot: InspectSnapshot): SideQueryRecord {
    if (byteLength(question) > this.maxQuestionBytes) throw new Error("side-query question exceeds bound");
    if (!this.snapshots.has(snapshot.snapshot_id)) this.snapshots.set(snapshot.snapshot_id, snapshot);
    const id = this.nextId("side");
    const mutation = MUTATION_REQUEST.test(question);
    const saturated = this.queue.length + this.running >= this.maxPending;
    const now = this.clock.now();
    const redactedFields: string[] = [];
    const safeQuestion = redactText(question, redactedFields);
    const rejected = mutation || saturated;
    const record: SideQueryRecord = Object.freeze({ request_id: id, question: safeQuestion, snapshot_id: snapshot.snapshot_id, submitted_at: now, finished_at: rejected ? now : null, status: rejected ? "rejected" : "queued", answer: null, error: mutation ? "mutation requests require explicit promotion through the governed workflow" : saturated ? "Inspect rate limit reached; primary execution is unaffected" : null, redacted_fields: redactedFields, promoted_command_id: null });
    this.records.set(id, record);
    this.store.append(record);
    if (!rejected) { this.queue.push(id); this.pump(); }
    return record;
  }

  cancel(requestId: string): SideQueryRecord | null {
    const record = this.records.get(requestId);
    if (!record || ["completed", "cancelled", "rejected", "failed"].includes(record.status)) return record ?? null;
    const controller = this.controllers.get(requestId);
    controller?.abort();
    const index = this.queue.indexOf(requestId);
    if (index >= 0) this.queue.splice(index, 1);
    return this.update(record, { status: "cancelled", finished_at: this.clock.now(), error: "cancelled by Inspect" });
  }

  /** Explicit promotion is the only path from side scope to the main queue. */
  async promote(requestId: string, reason: string, onSubmitted?: (operationId: string) => void): Promise<RuntimeResult<{ readonly request_id: string; readonly operation_id: string }>> {
    const record = this.records.get(requestId);
    if (!record || record.status !== "completed" || !record.answer) return { ok: false, error: { code: "validation", summary: "only a completed side answer may be promoted" }, capability: null };
    if (!reason.trim()) return { ok: false, error: { code: "validation", summary: "promotion reason is required" }, capability: null };
    const prior = this.promotions.get(requestId);
    if (prior !== undefined) { onSubmitted?.(prior.operation_id); return { ok: true, value: { request_id: requestId, operation_id: prior.operation_id }, capability: prior.capability }; }
    const operationId = this.nextId("promote");
    const task = `${record.answer.text}\n\nPromoted from Inspect side query ${requestId}. Operator reason: ${reason.trim()}`;
    const command: RuntimeCommandRequest = {
      kind: "taskcomposer.submit",
      metadata: { operation_id: operationId, idempotency_key: `${operationId}:promote` },
      params: {
        task,
        source: "tui",
        idempotency_key: `${operationId}:promote`,
        evidence_ids: record.answer.evidence_ids,
        mode: "execute",
        auto_confirm: false,
      },
    };
    onSubmitted?.(operationId);
    const result = await this.runtime.command(command);
    if (!result.ok) return result as RuntimeResult<{ readonly request_id: string; readonly operation_id: string }>;
    this.promotions.set(requestId, { operation_id: operationId, capability: result.capability });
    this.update(record, { promoted_command_id: operationId });
    return { ok: true, value: { request_id: requestId, operation_id: operationId }, capability: result.capability };
  }

  private nextId(prefix: string): string { this.serial += 1; return `inspect:${prefix}:${this.serial.toString(36)}`; }
  private update(record: SideQueryRecord, patch: Partial<SideQueryRecord>): SideQueryRecord {
    const updated = cloneRecord(record, patch); this.records.set(record.request_id, updated); this.store.append(updated); return updated;
  }
  private pump(): void {
    while (this.running < this.maxConcurrent && this.queue.length) {
      const requestId = this.queue.shift()!;
      const record = this.records.get(requestId); if (!record || record.status !== "queued") continue;
      void this.run(record);
    }
  }
  private async run(record: SideQueryRecord): Promise<void> {
    this.running += 1;
    const snapshot = this.snapshots.get(record.snapshot_id);
    const controller = new AbortController(); this.controllers.set(record.request_id, controller);
    const running = this.update(record, { status: "running" });
    try {
      if (!snapshot) throw new Error("snapshot is unavailable");
      const direct = deterministicAnswer(record.question, snapshot);
      let answer = direct;
      let redactedFields: string[] = [];
      let degradation: string | null = null;
      if (!answer && this.model) {
        try {
          const raw = await this.model({ question: record.question, snapshot, signal: controller.signal });
          const safe = redactInspectValue(raw, "answer", redactedFields);
          answer = { kind: "model", text: redactText(String(safe), redactedFields), evidence_ids: snapshot.evidence_ids, as_of: snapshot.as_of };
        } catch (error) {
          if (controller.signal.aborted) throw error;
          degradation = `model unavailable; deterministic fallback used (${error instanceof Error ? error.message : String(error)})`;
        }
      }
      if (!answer) answer = unknownAnswer(record.question, snapshot);
      if (controller.signal.aborted) throw new DOMException("cancelled", "AbortError");
      this.update(running, { status: "completed", finished_at: this.clock.now(), answer, redacted_fields: redactedFields, error: degradation });
    } catch (error) {
      if (controller.signal.aborted) this.update(this.records.get(record.request_id) ?? running, { status: "cancelled", finished_at: this.clock.now(), error: "cancelled by Inspect" });
      else this.update(this.records.get(record.request_id) ?? running, { status: "failed", finished_at: this.clock.now(), error: error instanceof Error ? error.message : String(error) });
    } finally { this.controllers.delete(record.request_id); this.running -= 1; this.pump(); }
  }
}

export function createInspectService(runtime: RuntimePort, options?: InspectOptions): InspectService { return new InspectService(runtime, options); }
