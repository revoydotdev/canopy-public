/** Durable causal delivery receipts projected over ConversationBus messages. */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BusMessageProjection } from "./conversation-bus.js";

export const REPO_FLIGHT_DELIVERY_STATES = ["sent", "claimed", "delivered", "acknowledged", "applied", "declined", "expired", "dead_lettered"] as const;
export type RepoFlightDeliveryState = (typeof REPO_FLIGHT_DELIVERY_STATES)[number];
export type RepoFlightTerminalDeliveryState = Extract<RepoFlightDeliveryState, "applied" | "declined" | "expired" | "dead_lettered">;

export interface RepoFlightDeliveryBinding {
  readonly delivery_id: string;
  readonly message_id: string;
  readonly conversation_id: string;
  /** ConversationBus CAS cursor observed when the delivery was bound. */
  readonly thread_version: string;
  readonly target_recipient_node_id: string;
  readonly target_instance_id: string;
  readonly repo_run_id: string;
  readonly operation_id: string;
  readonly operation_attempt_id: string;
  readonly message_as_of: string;
}

export interface RepoFlightDeliveryProjection extends RepoFlightDeliveryBinding {
  readonly state: RepoFlightDeliveryState;
  readonly revision: number;
  readonly sent_at: string;
  readonly updated_at: string;
  /** Receipt only: acknowledgement never implies completion. */
  readonly acknowledged: boolean;
  readonly completion: { readonly outcome: RepoFlightTerminalDeliveryState; readonly actor_instance_id: string; readonly occurred_at: string } | null;
}

export interface RepoFlightSentInput {
  readonly event_id: string;
  readonly idempotency_key: string;
  readonly occurred_at: string;
  readonly delivery_id: string;
  readonly message: Pick<BusMessageProjection, "id" | "conversation_id" | "recipient_node_ids" | "as_of">;
  readonly thread_version: string;
  readonly target_recipient_node_id: string;
  readonly target_instance_id: string;
  readonly repo_run_id: string;
  readonly operation_id: string;
  readonly operation_attempt_id: string;
}

export interface RepoFlightDeliveryTransitionInput {
  readonly event_id: string;
  readonly idempotency_key: string;
  readonly occurred_at: string;
  readonly delivery_id: string;
  readonly expected_state: RepoFlightDeliveryState;
  readonly to: Exclude<RepoFlightDeliveryState, "sent">;
  readonly actor_instance_id: string;
}

export type RepoFlightDeliveryResult =
  | { readonly ok: true; readonly replayed: boolean; readonly projection: RepoFlightDeliveryProjection }
  | { readonly ok: false; readonly code: "invalid_input" | "idempotency_conflict" | "duplicate_delivery" | "duplicate_transition" | "out_of_order" | "illegal_transition" | "actor_mismatch" | "corrupt_store" | "concurrent_advance" | "write_failed"; readonly reason: string };

type SentBody = { readonly kind: "delivery.sent"; readonly binding: RepoFlightDeliveryBinding };
type TransitionBody = { readonly kind: "delivery.transitioned"; readonly delivery_id: string; readonly expected_state: RepoFlightDeliveryState; readonly to: Exclude<RepoFlightDeliveryState, "sent">; readonly actor_instance_id: string };
type DeliveryBody = SentBody | TransitionBody;
type DeliveryEvent = DeliveryBody & {
  readonly version: 1; readonly sequence: number; readonly event_id: string; readonly idempotency_key: string;
  readonly occurred_at: string; readonly previous_hash: `sha256:${string}` | null; readonly event_hash: `sha256:${string}`;
};
type DeliveryDiagnostic = { readonly code: "malformed_line" | "invalid_event" | "broken_hash_chain" | "reduction_failed" | "write_failed"; readonly line?: number; readonly message: string };

const LEGAL: Readonly<Record<RepoFlightDeliveryState, ReadonlySet<RepoFlightDeliveryState>>> = Object.freeze({
  sent: states("claimed", "expired", "dead_lettered"),
  claimed: states("delivered", "expired", "dead_lettered"),
  delivered: states("acknowledged", "expired", "dead_lettered"),
  acknowledged: states("applied", "declined", "expired", "dead_lettered"),
  applied: states(), declined: states(), expired: states(), dead_lettered: states(),
});

/**
 * This class records delivery/apply receipts for existing ConversationBus
 * message identities. It deliberately contains no mailbox, pending counter,
 * message payload, dispatch callback, or retry queue.
 */
export class RepoFlightDeliveryAdapter {
  private readonly file: string | null;
  private readonly journal: DeliveryEvent[] = [];
  private readonly projections = new Map<string, RepoFlightDeliveryProjection>();
  private readonly idempotency = new Map<string, DeliveryEvent>();
  private readonly eventIds = new Set<string>();
  private readonly diagnostics: DeliveryDiagnostic[] = [];
  private corrupt = false;

  constructor(options: { readonly persistence_dir?: string } = {}) {
    this.file = options.persistence_dir === undefined ? null : join(options.persistence_dir, "repo-flight-delivery.jsonl");
    this.restore();
  }

  isDurable(): boolean { return this.file !== null; }
  isAppendable(): boolean { return !this.corrupt; }
  replayDiagnostics(): readonly DeliveryDiagnostic[] { return structuredClone(this.diagnostics); }
  inspect(deliveryId: string): RepoFlightDeliveryProjection | null { const value = this.projections.get(deliveryId); return value === undefined ? null : structuredClone(value); }
  list(repoRunId?: string, limit = 200): readonly RepoFlightDeliveryProjection[] {
    const boundedLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 1_000) : 200;
    return [...this.projections.values()].filter((value) => repoRunId === undefined || value.repo_run_id === repoRunId)
      .sort((a, b) => a.delivery_id.localeCompare(b.delivery_id)).slice(0, boundedLimit).map((value) => structuredClone(value));
  }

  recordSent(input: RepoFlightSentInput): RepoFlightDeliveryResult {
    if (!validSentInput(input)) return failure("invalid_input", "sent receipt does not bind a valid ConversationBus message and target");
    const body: SentBody = Object.freeze({ kind: "delivery.sent", binding: Object.freeze({
      delivery_id: input.delivery_id, message_id: input.message.id, conversation_id: input.message.conversation_id!,
      thread_version: input.thread_version, target_recipient_node_id: input.target_recipient_node_id,
      target_instance_id: input.target_instance_id, repo_run_id: input.repo_run_id, operation_id: input.operation_id,
      operation_attempt_id: input.operation_attempt_id, message_as_of: input.message.as_of,
    }) });
    return this.append(input.event_id, input.idempotency_key, input.occurred_at, body);
  }

  transition(input: RepoFlightDeliveryTransitionInput): RepoFlightDeliveryResult {
    if (!validTransitionInput(input)) return failure("invalid_input", "delivery transition does not satisfy the closed schema");
    return this.append(input.event_id, input.idempotency_key, input.occurred_at, Object.freeze({
      kind: "delivery.transitioned", delivery_id: input.delivery_id, expected_state: input.expected_state, to: input.to, actor_instance_id: input.actor_instance_id,
    }));
  }

  private append(eventId: string, idempotencyKey: string, occurredAt: string, body: DeliveryBody): RepoFlightDeliveryResult {
    if (this.corrupt) return failure("corrupt_store", "delivery receipt journal failed replay validation and is read-only");
    const semantic = stableJson({ event_id: eventId, idempotency_key: idempotencyKey, occurred_at: occurredAt, body });
    const prior = this.idempotency.get(idempotencyKey);
    if (prior !== undefined) return semanticEvent(prior) === semantic
      ? { ok: true, replayed: true, projection: structuredClone(this.projections.get(deliveryIdOf(prior))!) }
      : failure("idempotency_conflict", "idempotency key names a different delivery receipt");
    if (this.eventIds.has(eventId)) return failure("idempotency_conflict", "event_id has already been used");

    const sequence = this.journal.length + 1;
    const withoutHash = Object.freeze({ version: 1 as const, sequence, event_id: eventId, idempotency_key: idempotencyKey, occurred_at: occurredAt, previous_hash: this.journal.at(-1)?.event_hash ?? null, ...body });
    const event: DeliveryEvent = Object.freeze({ ...withoutHash, event_hash: sha256(withoutHash) });
    const current = this.projections.get(deliveryIdOf(event));
    const reduced = reduce(current, event);
    if (!reduced.ok) return reduced.result;
    const persistence = this.persist([...this.journal, event]);
    if (persistence === "stale") return failure("concurrent_advance", "delivery journal advanced in another controller; reopen and retry");
    if (persistence === "failed") return failure("write_failed", "delivery receipt could not be durably appended");
    this.accept(event, reduced.projection);
    return { ok: true, replayed: false, projection: structuredClone(reduced.projection) };
  }

  private accept(event: DeliveryEvent, projection: RepoFlightDeliveryProjection): void {
    this.journal.push(event); this.projections.set(projection.delivery_id, projection);
    this.idempotency.set(event.idempotency_key, event); this.eventIds.add(event.event_id);
  }

  private restore(): void {
    if (this.file === null || !existsSync(this.file)) return;
    try {
      if (!lstatSync(this.file).isFile()) { this.failReplay("invalid_event", "delivery journal is not a regular file"); return; }
      const lines = readFileSync(this.file, "utf8").split("\n"); if (lines.at(-1) === "") lines.pop();
      for (let index = 0; index < lines.length; index += 1) {
        let parsed: unknown; try { parsed = JSON.parse(lines[index]!); } catch { this.failReplay("malformed_line", "delivery journal contains malformed JSON", index + 1); return; }
        if (!validStoredEvent(parsed)) { this.failReplay("invalid_event", "delivery journal contains an invalid event", index + 1); return; }
        const event = parsed; const { event_hash, ...withoutHash } = event;
        if (event.sequence !== this.journal.length + 1 || event.previous_hash !== (this.journal.at(-1)?.event_hash ?? null) || sha256(withoutHash) !== event_hash) { this.failReplay("broken_hash_chain", "delivery journal hash chain is invalid", index + 1); return; }
        if (this.idempotency.has(event.idempotency_key) || this.eventIds.has(event.event_id)) { this.failReplay("invalid_event", "delivery journal reuses an event identity", index + 1); return; }
        const reduced = reduce(this.projections.get(deliveryIdOf(event)), event);
        if (!reduced.ok) { this.failReplay("reduction_failed", "delivery journal cannot be deterministically reduced", index + 1); return; }
        this.accept(event, reduced.projection);
      }
    } catch { this.failReplay("invalid_event", "delivery journal is unreadable"); }
  }

  private failReplay(code: DeliveryDiagnostic["code"], message: string, line?: number): void { this.corrupt = true; this.diagnostics.push(Object.freeze({ code, message, ...(line === undefined ? {} : { line }) })); }

  private persist(events: readonly DeliveryEvent[]): "ok" | "stale" | "failed" {
    if (this.file === null) return "ok";
    let temporary: string | null = null, lock: string | null = null, lockFd: number | null = null, lockOwned = false;
    try {
      const directory = dirname(this.file); mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!lstatSync(directory).isDirectory()) return "failed"; chmodSync(directory, 0o700);
      lock = `${this.file}.lock`; lockFd = openSync(lock, "wx", 0o600); lockOwned = true;
      writeFileSync(lockFd, `${JSON.stringify({ pid: process.pid })}\n`, "utf8"); fsyncSync(lockFd);
      const expected = serialize(this.journal), observed = existsSync(this.file) ? readFileSync(this.file, "utf8") : "";
      if (expected !== observed) return "stale";
      temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temporary, serialize(events), { encoding: "utf8", mode: 0o600, flag: "wx" });
      const fileFd = openSync(temporary, "r"); try { fsyncSync(fileFd); } finally { closeSync(fileFd); }
      renameSync(temporary, this.file); temporary = null; chmodSync(this.file, 0o600);
      const directoryFd = openSync(directory, "r"); try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      return "ok";
    } catch { this.diagnostics.push(Object.freeze({ code: "write_failed", message: "delivery journal append failed" })); return "failed"; }
    finally {
      if (lockFd !== null) { try { closeSync(lockFd); lockFd = null; } catch { /* retain lock on uncertain close */ } }
      if (lockOwned && lockFd === null && lock !== null && existsSync(lock)) { try { unlinkSync(lock); } catch { /* retained lock fails closed */ } }
      if (temporary !== null && existsSync(temporary)) { try { unlinkSync(temporary); } catch { /* diagnostic already retained */ } }
    }
  }
}

function reduce(current: RepoFlightDeliveryProjection | undefined, event: DeliveryEvent): { ok: true; projection: RepoFlightDeliveryProjection } | { ok: false; result: RepoFlightDeliveryResult } {
  if (event.kind === "delivery.sent") {
    if (current !== undefined) return { ok: false, result: failure("duplicate_delivery", "delivery_id is already bound") };
    return { ok: true, projection: Object.freeze({ ...event.binding, state: "sent", revision: 0, sent_at: event.occurred_at, updated_at: event.occurred_at, acknowledged: false, completion: null }) };
  }
  if (current === undefined) return { ok: false, result: failure("out_of_order", "delivery must be sent before it can transition") };
  if (Date.parse(event.occurred_at) < Date.parse(current.updated_at)) return { ok: false, result: failure("out_of_order", "delivery transition predates its causal predecessor") };
  if (event.expected_state !== current.state) {
    const code = LEGAL[current.state].has(event.to) ? "out_of_order" : current.state === event.to ? "duplicate_transition" : "out_of_order";
    return { ok: false, result: failure(code, `expected ${event.expected_state}, found ${current.state}`) };
  }
  if (!LEGAL[current.state].has(event.to)) return { ok: false, result: failure(current.state === event.to ? "duplicate_transition" : "illegal_transition", `transition ${current.state} -> ${event.to} is not permitted`) };
  if (event.to !== "expired" && event.to !== "dead_lettered" && event.actor_instance_id !== current.target_instance_id) return { ok: false, result: failure("actor_mismatch", "target-bound receipt was emitted by a different agent instance") };
  const terminal = isTerminal(event.to) ? Object.freeze({ outcome: event.to, actor_instance_id: event.actor_instance_id, occurred_at: event.occurred_at }) : null;
  return { ok: true, projection: Object.freeze({ ...current, state: event.to, revision: current.revision + 1, updated_at: event.occurred_at, acknowledged: current.acknowledged || event.to === "acknowledged", completion: terminal }) };
}

function validSentInput(value: unknown): value is RepoFlightSentInput {
  if (!exact(value, ["event_id", "idempotency_key", "occurred_at", "delivery_id", "message", "thread_version", "target_recipient_node_id", "target_instance_id", "repo_run_id", "operation_id", "operation_attempt_id"])) return false;
  if (![value.event_id, value.idempotency_key, value.delivery_id, value.thread_version, value.target_recipient_node_id, value.target_instance_id, value.repo_run_id, value.operation_id, value.operation_attempt_id].every(id) || !instant(value.occurred_at)) return false;
  // The source is an existing ConversationBus projection, which deliberately
  // carries more fields (including a bounded payload preview). Validate the
  // causal identity fields we consume and persist none of the remaining bus
  // projection, rather than inventing a second message schema or mailbox.
  if (!record(value.message) || !id(value.message.id) || !id(value.message.conversation_id) || !instant(value.message.as_of)) return false;
  return value.thread_version === value.message.id && Date.parse(value.occurred_at) >= Date.parse(value.message.as_of)
    && Array.isArray(value.message.recipient_node_ids) && value.message.recipient_node_ids.length > 0 && value.message.recipient_node_ids.length <= 256
    && value.message.recipient_node_ids.every(id) && value.message.recipient_node_ids.includes(value.target_recipient_node_id as string);
}

function validTransitionInput(value: unknown): value is RepoFlightDeliveryTransitionInput {
  return exact(value, ["event_id", "idempotency_key", "occurred_at", "delivery_id", "expected_state", "to", "actor_instance_id"])
    && [value.event_id, value.idempotency_key, value.delivery_id, value.actor_instance_id].every(id) && instant(value.occurred_at)
    && state(value.expected_state) && state(value.to) && value.to !== "sent";
}

function validBinding(value: unknown): value is RepoFlightDeliveryBinding {
  return exact(value, ["delivery_id", "message_id", "conversation_id", "thread_version", "target_recipient_node_id", "target_instance_id", "repo_run_id", "operation_id", "operation_attempt_id", "message_as_of"])
    && [value.delivery_id, value.message_id, value.conversation_id, value.thread_version, value.target_recipient_node_id, value.target_instance_id, value.repo_run_id, value.operation_id, value.operation_attempt_id].every(id) && instant(value.message_as_of);
}

function validStoredEvent(value: unknown): value is DeliveryEvent {
  if (!exact(value, ["version", "sequence", "event_id", "idempotency_key", "occurred_at", "previous_hash", "event_hash", "kind"], value && typeof value === "object" && (value as { kind?: unknown }).kind === "delivery.sent" ? ["binding"] : ["delivery_id", "expected_state", "to", "actor_instance_id"])) return false;
  if (value.version !== 1 || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1 || !id(value.event_id) || !id(value.idempotency_key) || !instant(value.occurred_at) || !(value.previous_hash === null || digest(value.previous_hash)) || !digest(value.event_hash)) return false;
  if (value.kind === "delivery.sent") return validBinding(value.binding);
  return value.kind === "delivery.transitioned" && id(value.delivery_id) && state(value.expected_state) && state(value.to) && value.to !== "sent" && id(value.actor_instance_id);
}

function exact(value: unknown, required: readonly string[], variant: readonly string[] = []): value is Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) return false; const allowed = [...required, ...variant]; const keys = Object.keys(value); return required.every((key) => Object.hasOwn(value, key)) && variant.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.includes(key)); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function id(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value); }
function instant(value: unknown): value is string { return typeof value === "string" && value.length <= 64 && !Number.isNaN(Date.parse(value)); }
function state(value: unknown): value is RepoFlightDeliveryState { return typeof value === "string" && (REPO_FLIGHT_DELIVERY_STATES as readonly string[]).includes(value); }
function digest(value: unknown): value is `sha256:${string}` { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value); }
function states(...values: RepoFlightDeliveryState[]): ReadonlySet<RepoFlightDeliveryState> { return new Set(values); }
function isTerminal(value: RepoFlightDeliveryState): value is RepoFlightTerminalDeliveryState { return value === "applied" || value === "declined" || value === "expired" || value === "dead_lettered"; }
function deliveryIdOf(event: DeliveryEvent): string { return event.kind === "delivery.sent" ? event.binding.delivery_id : event.delivery_id; }
function failure(code: Extract<RepoFlightDeliveryResult, { ok: false }>["code"], reason: string): RepoFlightDeliveryResult { return { ok: false, code, reason }; }
function semanticEvent(event: DeliveryEvent): string { const { version: _v, sequence: _s, previous_hash: _p, event_hash: _h, ...rest } = event; const { event_id, idempotency_key, occurred_at, ...body } = rest; return stableJson({ event_id, idempotency_key, occurred_at, body }); }
function serialize(events: readonly DeliveryEvent[]): string { return events.length === 0 ? "" : `${events.map(stableJson).join("\n")}\n`; }
function sha256(value: unknown): `sha256:${string}` { return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`; }
function stableJson(value: unknown): string { return JSON.stringify(sortJson(value)); }
function sortJson(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortJson); if (typeof value !== "object" || value === null) return value; return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortJson(item)])); }
