import {
  RUNTIME_CONTRACT_VERSION,
  validateRuntimeEvent,
  type RuntimeCursor,
  type RuntimeEventEnvelope,
} from "./runtime-contracts.js";

/** A bounded, transport-neutral log of canonical runtime events. */
export class RuntimeEventStream {
  private readonly events: RuntimeEventEnvelope[] = [];
  private readonly knownIds = new Set<string>();
  private readonly subscribers = new Map<string, Subscriber>();
  private nextSequence = 0;
  private nextSubscriberId = 0;

  constructor(readonly streamId: string, readonly capacity = 1_000) {
    if (!streamId.trim()) throw new Error("event stream id must be non-empty");
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("event stream capacity must be a positive integer");
  }

  /**
   * Assign the next cursor and append an immutable event. Producers do not get
   * to select sequence numbers, which makes out-of-order publication invalid
   * by construction.
   */
  publish(event: Omit<RuntimeEventEnvelope, "cursor" | "schema_version">): RuntimeEventEnvelope {
    if (this.knownIds.has(event.id)) throw new EventStreamError("duplicate_event", `event ${event.id} was already published`);
    const envelope: RuntimeEventEnvelope = {
      ...structuredClone(event),
      schema_version: RUNTIME_CONTRACT_VERSION,
      cursor: { stream_id: this.streamId, sequence: this.nextSequence + 1 },
    };
    const validation = validateRuntimeEvent(envelope);
    if (!validation.ok) throw new EventStreamError("invalid_event", validation.violations.map((v) => `${v.path}: ${v.message}`).join("; "));
    this.nextSequence++;
    this.knownIds.add(envelope.id);
    this.events.push(envelope);
    if (this.events.length > this.capacity) {
      const evicted = this.events.shift();
      if (evicted) this.knownIds.delete(evicted.id);
    }
    for (const subscriber of this.subscribers.values()) subscriber.enqueue(envelope);
    return structuredClone(envelope);
  }

  /** Return a cursor-consistent snapshot marker supplied by the canonical runtime. */
  snapshot<T>(value: T): RuntimeSnapshot<T> {
    return { cursor: this.cursor(), value: structuredClone(value) };
  }

  /** Resume strictly after cursor, or explicitly require a resnapshot on a gap. */
  resume<T>(cursor: RuntimeCursor | null, snapshot: T): RuntimeResumeResult<T> {
    if (cursor === null) return { kind: "snapshot", snapshot: this.snapshot(snapshot) };
    if (cursor.stream_id !== this.streamId) return this.resync("wrong_stream", snapshot);
    if (cursor.sequence > this.nextSequence) return this.resync("ahead", snapshot);
    const earliest = this.events[0]?.cursor.sequence ?? this.nextSequence + 1;
    if (cursor.sequence < earliest - 1) return this.resync("gap", snapshot);
    return {
      kind: "events",
      cursor: this.cursor(),
      events: this.events.filter((event) => event.cursor.sequence > cursor.sequence).map((event) => structuredClone(event)),
    };
  }

  subscribe(options: RuntimeSubscriptionOptions = {}): RuntimeEventSubscription {
    const maxPending = options.max_pending ?? this.capacity;
    if (!Number.isSafeInteger(maxPending) || maxPending < 1) throw new Error("max_pending must be a positive integer");
    const id = `subscriber_${(++this.nextSubscriberId).toString(36)}`;
    const subscriber = new Subscriber(id, maxPending, () => this.subscribers.delete(id));
    this.subscribers.set(id, subscriber);
    return subscriber;
  }

  cursor(): RuntimeCursor {
    return { stream_id: this.streamId, sequence: this.nextSequence };
  }

  private resync<T>(reason: RuntimeResyncReason, snapshot: T): RuntimeResumeResult<T> {
    return { kind: "resync", reason, snapshot: this.snapshot(snapshot) };
  }
}

export class EventStreamError extends Error {
  constructor(readonly code: "duplicate_event" | "invalid_event", message: string) {
    super(message);
    this.name = "EventStreamError";
  }
}

export interface RuntimeSnapshot<T> {
  cursor: RuntimeCursor;
  value: T;
}

export type RuntimeResyncReason = "wrong_stream" | "ahead" | "gap" | "duplicate_id" | "out_of_order";

export type RuntimeResumeResult<T> =
  | { kind: "snapshot"; snapshot: RuntimeSnapshot<T> }
  | { kind: "events"; cursor: RuntimeCursor; events: RuntimeEventEnvelope[] }
  | { kind: "resync"; reason: RuntimeResyncReason; snapshot: RuntimeSnapshot<T> };

export interface RuntimeSubscriptionOptions {
  /** Control events are never silently discarded: a full queue closes the subscriber. */
  max_pending?: number;
}

export interface RuntimeEventSubscription {
  readonly id: string;
  poll(limit?: number): RuntimeEventEnvelope[];
  status(): RuntimeSubscriptionStatus;
  close(): void;
}

export interface RuntimeSubscriptionStatus {
  closed: boolean;
  reason: "closed" | "backpressure" | null;
  pending: number;
}

class Subscriber implements RuntimeEventSubscription {
  private readonly queue: RuntimeEventEnvelope[] = [];
  private closed = false;
  private reason: "closed" | "backpressure" | null = null;

  constructor(readonly id: string, private readonly maxPending: number, private readonly onClose: () => void) {}

  enqueue(event: RuntimeEventEnvelope): void {
    if (this.closed) return;
    if (this.queue.length >= this.maxPending) {
      this.closed = true;
      this.reason = "backpressure";
      this.queue.length = 0;
      this.onClose();
      return;
    }
    this.queue.push(structuredClone(event));
  }

  poll(limit = this.queue.length): RuntimeEventEnvelope[] {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("poll limit must be a non-negative integer");
    return this.queue.splice(0, limit).map((event) => structuredClone(event));
  }

  status(): RuntimeSubscriptionStatus {
    return { closed: this.closed, reason: this.reason, pending: this.queue.length };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.reason = "closed";
    this.queue.length = 0;
    this.onClose();
  }
}
