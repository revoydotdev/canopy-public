/**
 * Optional wake-up delivery for durable parent/child threads.
 *
 * The audit ledger is the only message authority.  This adapter receives a
 * durable cursor *after* an append succeeds and may wake a connected client;
 * it cannot acknowledge, alter, or create a message.  Consumers must replay
 * `bus.thread.history` from the supplied version, which makes duplicate or
 * missed notifications harmless across reconnects.
 */
export interface ParentChildThreadPushEvent {
  readonly campaign_id: string;
  readonly thread_id: string;
  /** Durable ledger record that changed the thread.  Safe as a de-dup key. */
  readonly message_id: string;
  /** CAS cursor after the append; clients replay history rather than trust push payloads. */
  readonly version: string;
  readonly parent_node_id: string;
  readonly child_node_id: string;
  readonly reason: "message_appended" | "acknowledgement_appended";
}

/**
 * A best-effort, side-effect-only delivery optimization.  Implementations
 * must be idempotent by `(thread_id, message_id)` and must never become a
 * source of message state.  Throwing/rejecting deliberately has no effect on
 * the already-durable command acknowledgement.
 */
export interface ParentChildThreadPushAdapter {
  notify(event: ParentChildThreadPushEvent): void | Promise<void>;
}
