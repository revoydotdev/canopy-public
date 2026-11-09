/** In-memory control plane for actively executing revoy-native sessions. */
import { redactNativeText, type NativeSessionModelIdentity, type NativeSessionSteeringMessage, type SessionEvent, type SessionInspection, type SessionLineage } from "@arbor/harness";
import type { Provenance } from "@arbor/core";
import type { HarnessSessionConnectorId, HarnessSessionExecutionKind } from "./harness-session-execution.js";
import { deriveHarnessSessionFailure, extractHarnessSessionModelIdentity, redactHarnessSessionEvent, type HarnessSessionFailureChronology } from "./harness-session-journal.js";

export interface LiveNativeSessionRegistration {
  readonly session_id: string;
  readonly campaign_id: string;
  readonly node_id: string;
  readonly operation: "specialize" | "review";
  /** Actual execution path, not merely the revoy-owned supervisory lifecycle. */
  readonly connector_id: HarnessSessionConnectorId;
  readonly execution_kind: HarnessSessionExecutionKind;
  readonly profile_id: string;
  /** The session-owned signal passed through the native worker and connector. */
  readonly controller: AbortController;
  readonly inspect: () => SessionInspection;
  readonly events: (after_sequence?: number) => readonly SessionEvent[];
}

export interface LiveNativeSessionView {
  readonly session_id: string;
  readonly campaign_id: string;
  readonly node_id: string;
  readonly operation: "specialize" | "review";
  readonly connector_id: HarnessSessionConnectorId;
  readonly execution_kind: HarnessSessionExecutionKind;
  readonly profile_id: string;
  readonly lineage: SessionLineage;
  readonly state: string;
  readonly latest_sequence: number;
  readonly latest_event_at?: string;
  readonly terminal: SessionInspection["terminal"];
  /** Redacted lifecycle identity; null means no identity was observed. */
  readonly model_identity: NativeSessionModelIdentity | null;
  /** A live controller has no restart-recovery disposition. */
  readonly recovery: Readonly<{ kind: "not_required" }>;
  readonly diagnostics: readonly [];
  /** Same derivation the durable journal replays after a restart. */
  readonly failure?: HarnessSessionFailureChronology;
  readonly pending_steering: number;
  readonly attachable: true;
}

export type LiveNativeSessionInterruptResult =
  | { readonly kind: "interrupted"; readonly session: LiveNativeSessionView }
  | { readonly kind: "already_requested"; readonly session: LiveNativeSessionView }
  | { readonly kind: "not_found" };
export type LiveNativeSessionSteerResult =
  | { readonly kind: "queued"; readonly message_id: string; readonly pending: number }
  | { readonly kind: "not_found" }
  | { readonly kind: "terminal" }
  | { readonly kind: "full" };

/**
 * Bound on the live text-delta preview buffer (ADR-104 Decision 3/O4). A
 * long specialist turn can stream far more text than any operator view
 * needs to see at once; keeping only the trailing window is what makes
 * `pushDelta` safe to call once per token for the life of a turn without
 * the registry accumulating an unbounded transcript. Deliberately larger
 * than `arbor-tui`'s own `MAX_PREVIEW_CHARS` (2,000) display ceiling — this
 * buffer is the upstream source the screen trims further, not the display
 * bound itself, so it stays a fixed-size read no matter how long the turn
 * runs.
 */
const MAX_LIVE_PREVIEW_CHARS = 4_000;

/**
 * Process-local by design: an AbortController cannot survive a restart. The
 * separate HarnessSessionJournal owns durable, redacted historical evidence.
 */
export class LiveNativeSessionRegistry {
  private readonly sessions = new Map<string, LiveNativeSessionRegistration>();
  private readonly steering = new Map<string, NativeSessionSteeringMessage[]>();
  /** Bounded trailing-window text buffer per live session; see `pushDelta`/`preview`. */
  private readonly previews = new Map<string, string>();

  register(session: LiveNativeSessionRegistration): void {
    if (this.sessions.has(session.session_id)) throw new Error(`live native session ${session.session_id} is already registered`);
    this.sessions.set(session.session_id, session);
    this.steering.set(session.session_id, []);
  }

  settle(sessionId: string): void { this.sessions.delete(sessionId); this.steering.delete(sessionId); this.previews.delete(sessionId); }

  /**
   * Append one streamed text fragment to a live session's bounded preview
   * (ADR-104 Decision 1/3). A no-op for a session that is not (or no longer)
   * registered — a delta racing `settle()` must not resurrect state for a
   * session an operator can no longer see or interrupt. Text is redacted
   * with the same policy `steer()` applies to operator-authored text before
   * it enters this process-local, non-durable buffer.
   */
  pushDelta(sessionId: string, text: string): void {
    if (!this.sessions.has(sessionId) || text.length === 0) return;
    const combined = (this.previews.get(sessionId) ?? "") + redactNativeText(text);
    this.previews.set(sessionId, combined.length > MAX_LIVE_PREVIEW_CHARS ? combined.slice(combined.length - MAX_LIVE_PREVIEW_CHARS) : combined);
  }

  /** The current bounded trailing-window preview for a live session, or `null` when nothing has streamed yet (or the session is not live). */
  preview(sessionId: string): string | null {
    return this.previews.get(sessionId) ?? null;
  }

  steer(sessionId: string, messageId: string, text: string, provenance: Provenance): LiveNativeSessionSteerResult {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return { kind: "not_found" };
    if (session.inspect().terminal !== null || session.controller.signal.aborted) return { kind: "terminal" };
    const inbox = this.steering.get(sessionId)!;
    if (inbox.some((message) => message.message_id === messageId)) return { kind: "queued", message_id: messageId, pending: inbox.length };
    if (inbox.length >= 32) return { kind: "full" };
    inbox.push(Object.freeze({ message_id: messageId, text: redactNativeText(text), provenance: Object.freeze({ ...provenance }) }));
    return { kind: "queued", message_id: messageId, pending: inbox.length };
  }

  drain(sessionId: string): readonly NativeSessionSteeringMessage[] {
    const inbox = this.steering.get(sessionId);
    if (inbox === undefined || inbox.length === 0) return Object.freeze([]);
    const messages = Object.freeze(inbox.splice(0).map((message) => Object.freeze({ ...message, provenance: Object.freeze({ ...message.provenance }) })));
    return messages;
  }

  list(): readonly LiveNativeSessionView[] {
    return [...this.sessions.values()]
      .map((session) => this.view(session))
      .sort((left, right) => right.session_id.localeCompare(left.session_id));
  }

  inspect(sessionId: string): LiveNativeSessionView | null {
    const session = this.sessions.get(sessionId);
    return session === undefined ? null : this.view(session);
  }

  events(sessionId: string, afterSequence = 0): readonly SessionEvent[] | null {
    const session = this.sessions.get(sessionId);
    return session === undefined ? null : session.events(afterSequence);
  }

  interrupt(sessionId: string, reason: string): LiveNativeSessionInterruptResult {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return { kind: "not_found" };
    const view = this.view(session);
    if (session.controller.signal.aborted) return { kind: "already_requested", session: view };
    session.controller.abort(reason);
    return { kind: "interrupted", session: this.view(session) };
  }

  private view(session: LiveNativeSessionRegistration): LiveNativeSessionView {
    const inspection = session.inspect();
    // The same redactor/validator the durable journal uses is the only path
    // from a live model event to this operator projection. In particular a
    // configured alias is not displayed as a provider-observed revision.
    const events = session.events(0);
    const latestEvent = events.at(-1);
    const redacted = events.map(redactHarnessSessionEvent);
    const failure = deriveHarnessSessionFailure(redacted);
    const model_identity = redacted
      .map(extractHarnessSessionModelIdentity)
      .find((identity): identity is NativeSessionModelIdentity => identity !== null) ?? null;
    return Object.freeze({
      session_id: session.session_id,
      campaign_id: session.campaign_id,
      node_id: session.node_id,
      operation: session.operation,
      connector_id: session.connector_id,
      execution_kind: session.execution_kind,
      profile_id: session.profile_id,
      lineage: inspection.lineage,
      // AbortController is the live control-plane fact. The native worker
      // publishes the terminal interruption at its next safe boundary.
      state: session.controller.signal.aborted && inspection.terminal === null ? "interrupt_requested" : inspection.state,
      latest_sequence: inspection.latest_sequence,
      ...(latestEvent === undefined ? {} : { latest_event_at: latestEvent.occurred_at }),
      terminal: inspection.terminal,
      model_identity,
      recovery: Object.freeze({ kind: "not_required" as const }),
      diagnostics: [] as const,
      ...(failure === null ? {} : { failure }),
      pending_steering: this.steering.get(session.session_id)?.length ?? 0,
      attachable: true as const,
    });
  }
}
