import { compareCodeUnits } from "./ordering.js";
import type { OperationMetadata, RuntimeError } from "./runtime-contracts.js";

export type OperationState = "accepted" | "running" | "completed" | "rejected" | "failed" | "cancelled";

export interface OperationRecord {
  operation_id: string;
  idempotency_key: string;
  fingerprint: string;
  correlation_id: string;
  actor_id: string;
  capability: string;
  state: OperationState;
  task_id: string | null;
  result_summary: string | null;
  error: RuntimeError | null;
  accepted_at: string;
  completed_at: string | null;
  /** Present only for requests accepted by the explicit remote ingress. */
  remote_session?: NonNullable<OperationMetadata["remote_session"]>;
}

export interface OperationRegistration {
  metadata: OperationMetadata;
  capability: string;
  fingerprint: string;
}

export interface OperationRegistryOptions {
  clock?: () => Date;
  terminal_retention?: number;
  tombstone_retention?: number;
  restored_records?: readonly OperationRecord[];
}

export class OperationRegistryError extends Error { constructor(message: string) { super(message); this.name = "OperationRegistryError"; } }
const terminal = new Set<OperationState>(["completed", "rejected", "failed", "cancelled"]);

/** In-memory canonical command identity and outcome registry; persistence is injected by callers. */
export class OperationRegistry {
  private readonly records = new Map<string, OperationRecord>();
  private readonly idempotency = new Map<string, string>();
  private readonly tombstones = new Map<string, string>();
  private readonly tombstoneOrder: string[] = [];
  private readonly reconciliation = new Set<string>();
  private readonly now: () => Date;
  private readonly retention: number;
  private readonly tombstoneRetention: number;

  constructor(options: OperationRegistryOptions = {}) {
    this.now = options.clock ?? (() => new Date());
    this.retention = options.terminal_retention ?? 100;
    this.tombstoneRetention = options.tombstone_retention ?? this.retention;
    if (!Number.isSafeInteger(this.retention) || this.retention < 0 || !Number.isSafeInteger(this.tombstoneRetention) || this.tombstoneRetention < 0) throw new OperationRegistryError("retention values must be non-negative safe integers");
    if (options.restored_records) this.restore(options.restored_records);
  }

  accept(input: OperationRegistration): OperationRecord {
    this.text(input.metadata.operation_id, "operation_id"); this.text(input.metadata.idempotency_key, "idempotency_key"); this.text(input.capability, "capability"); this.text(input.fingerprint, "fingerprint");
    const priorId = this.idempotency.get(input.metadata.idempotency_key);
    if (priorId) { const prior = this.must(priorId); if (prior.fingerprint !== input.fingerprint) throw new OperationRegistryError("idempotency key names a different operation"); return this.copy(prior); }
    if (this.tombstones.has(input.metadata.idempotency_key)) throw new OperationRegistryError("idempotency key is protected by terminal tombstone retention");
    if (this.records.has(input.metadata.operation_id)) throw new OperationRegistryError("operation_id is already registered");
    const record: OperationRecord = { operation_id: input.metadata.operation_id, idempotency_key: input.metadata.idempotency_key, fingerprint: input.fingerprint, correlation_id: input.metadata.correlation_id, actor_id: input.metadata.actor_id, capability: input.capability, state: "accepted", task_id: null, result_summary: null, error: null, accepted_at: input.metadata.requested_at, completed_at: null, ...(input.metadata.remote_session === undefined ? {} : { remote_session: structuredClone(input.metadata.remote_session) }) };
    this.records.set(record.operation_id, record); this.idempotency.set(record.idempotency_key, record.operation_id); return this.copy(record);
  }

  start(id: string, taskId: string): OperationRecord { const record = this.live(id); this.text(taskId, "task_id"); if (record.state !== "accepted" && record.state !== "running") throw new OperationRegistryError("only accepted operations can start"); record.state = "running"; record.task_id = taskId; return this.copy(record); }
  complete(id: string, summary: string): OperationRecord { return this.finish(id, "completed", summary, null); }
  fail(id: string, error: RuntimeError): OperationRecord { return this.finish(id, "failed", error.summary, error); }
  reject(id: string, error: RuntimeError): OperationRecord { return this.finish(id, "rejected", error.summary, error); }
  cancel(id: string, summary: string): OperationRecord { return this.finish(id, "cancelled", summary, null); }
  get(id: string): OperationRecord | undefined { const value = this.records.get(id); return value && this.copy(value); }
  list(includeTerminal = false): OperationRecord[] { return [...this.records.values()].filter((record) => includeTerminal || !terminal.has(record.state)).map((record) => this.copy(record)); }
  requiresReconciliation(id: string): boolean { this.must(id); return this.reconciliation.has(id); }

  restore(records: readonly OperationRecord[]): string[] {
    if (this.records.size || this.tombstones.size) throw new OperationRegistryError("restore requires an empty registry without tombstones");
    const staged = new Map<string, OperationRecord>(); const keys = new Set<string>();
    for (const record of records) { this.validate(record); if (staged.has(record.operation_id) || keys.has(record.idempotency_key)) throw new OperationRegistryError("restored operations contain duplicate identity"); staged.set(record.operation_id, structuredClone(record)); keys.add(record.idempotency_key); }
    for (const [id, record] of staged) { this.records.set(id, record); this.idempotency.set(record.idempotency_key, id); if (!terminal.has(record.state)) this.reconciliation.add(id); }
    return [...this.reconciliation];
  }

  prune(limit = Number.MAX_SAFE_INTEGER): string[] { const candidates = [...this.records.values()].filter((record) => terminal.has(record.state)).sort((a, b) => compareCodeUnits(a.completed_at ?? "", b.completed_at ?? "")); const removed: string[] = []; for (const record of candidates) { if (removed.length >= limit) break; this.records.delete(record.operation_id); this.idempotency.delete(record.idempotency_key); this.reconciliation.delete(record.operation_id); this.remember(record); removed.push(record.operation_id); } return removed; }
  pruneTombstones(limit = Number.MAX_SAFE_INTEGER): string[] { const removed: string[] = []; while (removed.length < limit && this.tombstoneOrder.length) { const key = this.tombstoneOrder.shift()!; if (this.tombstones.delete(key)) removed.push(key); } return removed; }

  private finish(id: string, state: Extract<OperationState, "completed" | "rejected" | "failed" | "cancelled">, summary: string, error: RuntimeError | null): OperationRecord { const record = this.live(id); this.text(summary, "result summary"); if (terminal.has(record.state)) { if (record.state === state) return this.copy(record); throw new OperationRegistryError("cannot change terminal operation outcome"); } record.state = state; record.result_summary = summary; record.error = error && structuredClone(error); record.completed_at = this.now().toISOString(); this.trim(); return this.copy(record); }
  private trim(): void { const excess = this.list(true).filter((record) => terminal.has(record.state)).length - this.retention; if (excess > 0) this.prune(excess); }
  private remember(record: OperationRecord): void { if (!this.tombstoneRetention) return; this.tombstones.set(record.idempotency_key, record.fingerprint); this.tombstoneOrder.push(record.idempotency_key); while (this.tombstoneOrder.length > this.tombstoneRetention) this.pruneTombstones(1); }
  private live(id: string): OperationRecord { const record = this.must(id); if (this.reconciliation.has(id)) throw new OperationRegistryError("restored active operation requires reconciliation"); return record; }
  private must(id: string): OperationRecord { const record = this.records.get(id); if (!record) throw new OperationRegistryError(`unknown operation ${id}`); return record; }
  private copy(record: OperationRecord): OperationRecord { return structuredClone(record); }
  private text(value: string, field: string): void { if (!value.trim()) throw new OperationRegistryError(`${field} must be non-empty`); }
  private validate(record: OperationRecord): void { this.text(record.operation_id, "operation_id"); this.text(record.idempotency_key, "idempotency_key"); this.text(record.fingerprint, "fingerprint"); this.text(record.correlation_id, "correlation_id"); this.text(record.actor_id, "actor_id"); this.text(record.capability, "capability"); if (record.remote_session !== undefined) { this.text(record.remote_session.session_id, "remote_session.session_id"); this.text(record.remote_session.key_id, "remote_session.key_id"); this.text(record.remote_session.certificate_id, "remote_session.certificate_id"); this.text(record.remote_session.nonce, "remote_session.nonce"); this.text(record.remote_session.issued_at, "remote_session.issued_at"); if (record.remote_session.integrity !== "ed25519") throw new OperationRegistryError("remote_session.integrity must be ed25519"); } if (!terminal.has(record.state) && record.completed_at !== null) throw new OperationRegistryError("active restored operation cannot have completed_at"); if (terminal.has(record.state) && record.completed_at === null) throw new OperationRegistryError("terminal restored operation requires completed_at"); }
}
