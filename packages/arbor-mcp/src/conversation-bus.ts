/**
 * Conversation bus projection (Phase 4D.2).
 *
 * The bus is a *projection* over the audit ledger's NodeCommunicationRecord
 * chain, NOT a mailbox, queue, or pending count (Commandment III). "Is there
 * a new message?" is answered by replaying durable records, never by reading
 * a cached marker that can wedge (the confirmed omo/opencode bug class).
 *
 * Messages are grouped by `conversation_id` into ordered runs recoverable by
 * replay. Capability tiers are enforced structurally at projection time — a
 * specialist-tier reader cannot see critic-tier bus messages (Commandment IV).
 *
 * Phase 4D.2 closure adds two more reconciliations, both computed fresh on
 * every call from the same replayed record set — never cached, never a
 * counter that can go stale:
 *
 *   - **Double-promote conflicts.** Two live (non-retracted) `promote`
 *     records in the same conversation that name the same
 *     `parent_communication_id` (the record being promoted) are a race, not
 *     a fact to silently resolve last-write-wins. Both stay in the ledger
 *     (append-only — nothing is rejected or hidden) and both are marked
 *     `promote_conflict: true`; the conflict itself is surfaced structurally
 *     via `ConversationBusProjection.promote_conflicts`, so no consumer can
 *     read "the" promoted outcome without also seeing the conflict.
 *   - **Steer-before-ack timing.** A `steer` record acknowledges the
 *     `delegate` record it targets via `acknowledges_communication_id`. Its
 *     timing relative to the sibling's own first acknowledgement of that
 *     delegate is exposed as a closed, discriminated `SteerTiming` union —
 *     `before_ack` and `after_ack` carry different, type-incompatible
 *     shapes, so a consumer cannot treat the two as interchangeable without
 *     an explicit discriminant check (Commandment IX: no open strings).
 */

import { compareCodeUnits } from "@arbor/core";
import type { NodeCommunication, NodeCommunicationRecord } from "@arbor/audit";

export type BusMessageKind = "delegate" | "report" | "retract" | "steer" | "reply" | "clarify" | "promote";
export type BusCapabilityTier = NodeCommunication["capability_tier"];

/**
 * Where a `steer` record sits relative to the target delegate's own first
 * acknowledgement. A closed, discriminated union rather than a boolean or
 * runtime string comparison — `before_ack` structurally cannot carry an
 * `ack_communication_id` (there is none yet), so a consumer that destructures
 * one shape can never accidentally read a field the other shape doesn't have.
 *
 *   - `before_ack`: the steer targets a real delegate in this projection, but
 *     no acknowledgement from the delegate's recipient precedes it — this is
 *     the Codex `interrupt_agent`-style case, interrupting a sibling that has
 *     not yet engaged.
 *   - `after_ack`: the sibling had already acknowledged the delegate before
 *     the steer arrived.
 *   - `unlinked`: the steer's `acknowledges_communication_id` does not
 *     resolve to a `delegate` record visible in this projection (missing,
 *     wrong kind, or tier-redacted) — distinguished from `before_ack` because
 *     "no delegate to steer" and "delegate not yet acknowledged" are
 *     different facts and must not collapse into one.
 */
export type SteerTiming =
  | { readonly status: "before_ack"; readonly delegate_communication_id: string }
  | { readonly status: "after_ack"; readonly delegate_communication_id: string; readonly ack_communication_id: string }
  | { readonly status: "unlinked" };

/**
 * Two or more live `promote` records in one conversation naming the same
 * `target_communication_id` — a genuine double-promote race, not a retry
 * (retries share an idempotency_key and never produce two ledger records;
 * see `CampaignManager.recordNodeCommunication`). Detected fresh from the
 * replayed record set on every projection; never cached.
 */
export interface PromoteConflict {
  readonly conversation_id: string | null;
  readonly target_communication_id: string;
  readonly communication_ids: readonly string[];
}

export interface BusMessageProjection {
  readonly id: string;
  readonly timestamp: string;
  readonly conversation_id: string | null;
  readonly parent_communication_id: string | null;
  readonly reply_to_communication_id: string | null;
  readonly author_node_id: string;
  readonly recipient_node_ids: readonly string[];
  readonly kind: BusMessageKind;
  readonly capability_tier: BusCapabilityTier;
  readonly payload_preview: { readonly content: string; readonly provenance_tag: string; readonly evidence_refs: readonly string[] };
  readonly as_of: string;
  readonly acknowledges_communication_id: string | null;
  readonly retracts_communication_id: string | null;
  /** Transport purpose; legacy records project as notify. */
  readonly intent: NonNullable<NodeCommunication["intent"]>;
  readonly ack_required: boolean;
  readonly deadline_at: string | null;
  /** True when this message is one of ≥2 live promotes racing on the same target (see `PromoteConflict`). */
  readonly promote_conflict: boolean;
  /** Non-null only for `kind: "steer"`; see `SteerTiming`. */
  readonly steer_timing: SteerTiming | null;
  /** Verified remote-session attribution when the durable message entered via
   * the opt-in ingress; identifiers only, never a signature or key. */
  readonly remote_attribution: { readonly session_id: string; readonly key_id: string; readonly certificate_id: string; readonly integrity: string; readonly proof_digest?: `sha256:${string}` } | null;
}

export interface ConversationBusProjection {
  readonly campaign_id: string;
  /** Conversation id → ordered message projections. */
  readonly conversations: ReadonlyMap<string, readonly BusMessageProjection[]>;
  /** Messages without a conversation_id (legacy / non-conversational). */
  readonly ungrouped: readonly BusMessageProjection[];
  readonly as_of: string;
  /** Every double-promote conflict detected in this projection, across all conversations and the ungrouped bucket. */
  readonly promote_conflicts: readonly PromoteConflict[];
}

export interface ParentChildThreadProjection {
  readonly campaign_id: string;
  readonly thread_id: string;
  readonly parent_node_id: string;
  readonly child_node_id: string;
  /** Set by the manager from current campaign/node state, never caller input. */
  readonly can_accept_direct_input?: boolean;
  /** CAS cursor: `origin` before the first message, then the latest ledger id. */
  readonly version: string;
  /** Ordered by `(as_of, ledger id)` and durably recoverable after restart. */
  readonly messages: readonly (BusMessageProjection & { readonly delivery: "pending" | "acknowledged" | "timed_out" })[];
  /** A visible durable needs-attention record is actionable, never inferred from a cached counter. */
  readonly needs_attention_message_ids: readonly string[];
  readonly as_of: string;
}

/** Stable identity shared by both directions of one direct parent/child thread. */
export function parentChildThreadId(parentNodeId: string, childNodeId: string): string {
  return `parent-child:${parentNodeId}:${childNodeId}`;
}

/**
 * Project delivery solely from durable messages. A message is acknowledged
 * only when one of its recipients later authors a record that names it; an
 * arbitrary third party cannot advance delivery state.
 */
export function projectParentChildThread(
  records: readonly NodeCommunicationRecord[],
  options: { campaign_id: string; parent_node_id: string; child_node_id: string; as_of?: string; limit?: number; tier?: BusCapabilityTier },
): ParentChildThreadProjection {
  const thread_id = parentChildThreadId(options.parent_node_id, options.child_node_id);
  const bus = projectConversationBus(records, { ...options, conversation_id: thread_id });
  const messages = bus.conversations.get(thread_id) ?? [];
  const byId = new Map(messages.map((message) => [message.id, message]));
  const acknowledged = new Set<string>();
  for (const candidate of messages) {
    const target = candidate.acknowledges_communication_id;
    if (!target) continue;
    const delivered = byId.get(target);
    if (delivered?.recipient_node_ids.includes(candidate.author_node_id)) acknowledged.add(target);
  }
  const at = options.as_of ?? bus.as_of;
  const now = Date.parse(at);
  const projectDelivery = (message: BusMessageProjection): "pending" | "acknowledged" | "timed_out" => {
    if (acknowledged.has(message.id) || !message.ack_required) return "acknowledged";
    return message.deadline_at !== null && !Number.isNaN(now) && Date.parse(message.deadline_at) <= now ? "timed_out" : "pending";
  };
  return Object.freeze({
    campaign_id: options.campaign_id,
    thread_id,
    parent_node_id: options.parent_node_id,
    child_node_id: options.child_node_id,
    version: messages.at(-1)?.id ?? "origin",
    messages: Object.freeze(messages.map((message) => Object.freeze({ ...message, delivery: projectDelivery(message) }))),
    needs_attention_message_ids: Object.freeze(messages.filter((message) => message.intent === "needs_attention").map((message) => message.id)),
    as_of: bus.as_of,
  });
}

export interface ProjectConversationBusOptions {
  readonly campaign_id: string;
  readonly as_of?: string;
  readonly limit?: number;
  readonly conversation_id?: string;
  /** Capability tier filter — structurally redacts higher-tier messages from lower-tier readers. */
  readonly tier?: BusCapabilityTier;
}

const TIER_RANK: ReadonlyMap<BusCapabilityTier, number> = new Map<BusCapabilityTier, number>([
  ["specialist", 0],
  ["critic", 1],
  ["auditor", 2],
  ["orchestrator", 3],
]);

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const PAYLOAD_PREVIEW_BYTES = 512;

function tierCanSee(readerTier: BusCapabilityTier, messageTier: BusCapabilityTier): boolean {
  // A reader can see messages at their tier OR below. A specialist (rank 0)
  // cannot see critic/auditor/orchestrator messages. An orchestrator (rank 3)
  // sees everything.
  return TIER_RANK.get(readerTier)! >= TIER_RANK.get(messageTier)!;
}

function toProjection(record: NodeCommunicationRecord): BusMessageProjection {
  const comm = record.communication;
  const previewText = [...comm.payload.content].slice(0, PAYLOAD_PREVIEW_BYTES).join("");
  return Object.freeze({
    id: record.id,
    timestamp: record.timestamp,
    conversation_id: comm.conversation_id ?? null,
    parent_communication_id: comm.parent_communication_id ?? null,
    reply_to_communication_id: comm.reply_to_communication_id ?? null,
    author_node_id: comm.author_node_id,
    recipient_node_ids: Object.freeze([comm.recipient_node_id, ...comm.other_recipient_node_ids]),
    kind: comm.kind as BusMessageKind,
    capability_tier: comm.capability_tier,
    payload_preview: Object.freeze({
      content: previewText,
      provenance_tag: comm.payload.provenance.tag,
      evidence_refs: Object.freeze([...(comm.payload.evidence_refs ?? [])]),
    }),
    as_of: comm.as_of,
    acknowledges_communication_id: comm.acknowledges_communication_id,
    retracts_communication_id: comm.retracts_communication_id,
    intent: comm.intent ?? "notify",
    ack_required: comm.ack_required ?? false,
    deadline_at: comm.deadline_at ?? null,
    remote_attribution: comm.remote_attribution === undefined ? null : Object.freeze({
      session_id: comm.remote_attribution.session_id,
      key_id: comm.remote_attribution.key_id,
      certificate_id: comm.remote_attribution.certificate_id,
      integrity: comm.remote_attribution.integrity,
      ...(comm.remote_attribution.proof_digest === undefined ? {} : { proof_digest: comm.remote_attribution.proof_digest }),
    }),
    // Placeholders — filled in by annotateBucket() once messages are grouped
    // into their conversation, since both reconciliations are relative to
    // the other messages in the same conversation.
    promote_conflict: false,
    steer_timing: null,
  });
}

/**
 * Per-conversation (or the ungrouped bucket) reconciliation pass. Pure over
 * its `bucket` argument — no module-level state, no memoization — so calling
 * it twice with the same input always returns the same output, and calling
 * it again after `bucket` reflects new replayed records reflects the change
 * immediately. That purity is what makes "never stale" true by construction
 * rather than merely true today: there is no cache to invalidate.
 */
function annotateBucket(
  bucket: readonly BusMessageProjection[],
  conversationId: string | null,
): { readonly messages: readonly BusMessageProjection[]; readonly conflicts: readonly PromoteConflict[] } {
  // --- double-promote conflicts ---
  // A promote is "live" unless some other record in the bucket explicitly
  // retracts it (retracts_communication_id) — the existing, general
  // retract mechanism; no new field. Two live promotes are only comparable
  // as "the same target" when both carry the same non-null
  // parent_communication_id (the record being promoted); a promote with no
  // parent link cannot be proven to race anything, so it is never grouped.
  const retractedIds = new Set<string>();
  for (const m of bucket) if (m.retracts_communication_id) retractedIds.add(m.retracts_communication_id);

  const liveByTarget = new Map<string, string[]>();
  for (const m of bucket) {
    if (m.kind !== "promote" || retractedIds.has(m.id)) continue;
    const target = m.parent_communication_id;
    if (!target) continue;
    const group = liveByTarget.get(target);
    if (group) group.push(m.id);
    else liveByTarget.set(target, [m.id]);
  }
  const conflicts: PromoteConflict[] = [];
  const conflictedIds = new Set<string>();
  for (const [target, ids] of liveByTarget) {
    if (ids.length < 2) continue;
    conflicts.push(Object.freeze({
      conversation_id: conversationId,
      target_communication_id: target,
      communication_ids: Object.freeze([...ids]),
    }));
    for (const id of ids) conflictedIds.add(id);
  }

  // --- steer-before-ack timing ---
  // delegate id -> the set of node ids allowed to acknowledge it (its
  // recipients). A record acknowledges a delegate only if authored by one of
  // those recipients — a stray acknowledges_communication_id pointing at a
  // delegate's id from an unrelated author does not count.
  const delegateRecipients = new Map<string, ReadonlySet<string>>();
  for (const m of bucket) if (m.kind === "delegate") delegateRecipients.set(m.id, new Set(m.recipient_node_ids));

  // delegate id -> index (within bucket order) of its first valid ack.
  const ackIndexByDelegate = new Map<string, number>();
  bucket.forEach((m, index) => {
    const target = m.acknowledges_communication_id;
    if (!target) return;
    const recipients = delegateRecipients.get(target);
    if (!recipients || !recipients.has(m.author_node_id)) return;
    if (!ackIndexByDelegate.has(target)) ackIndexByDelegate.set(target, index);
  });

  const messages = bucket.map((m, index) => {
    let steerTiming: SteerTiming | null = null;
    if (m.kind === "steer") {
      const delegateId = m.acknowledges_communication_id;
      if (!delegateId || !delegateRecipients.has(delegateId)) {
        steerTiming = Object.freeze({ status: "unlinked" } as const);
      } else {
        const ackIndex = ackIndexByDelegate.get(delegateId);
        steerTiming = ackIndex !== undefined && ackIndex < index
          ? Object.freeze({ status: "after_ack", delegate_communication_id: delegateId, ack_communication_id: bucket[ackIndex]!.id } as const)
          : Object.freeze({ status: "before_ack", delegate_communication_id: delegateId } as const);
      }
    }
    return Object.freeze({ ...m, promote_conflict: conflictedIds.has(m.id), steer_timing: steerTiming });
  });

  return { messages: Object.freeze(messages), conflicts: Object.freeze(conflicts) };
}

/**
 * Pure projection over NodeCommunicationRecord[]. Filters by campaign, as_of,
 * conversation_id, and capability tier. Bounds the result. Deterministic.
 */
export function projectConversationBus(
  records: readonly NodeCommunicationRecord[],
  options: ProjectConversationBusOptions,
): ConversationBusProjection {
  if (!options.campaign_id.trim()) throw new Error("campaign_id must be non-empty");
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit must be a safe integer from 1 through ${MAX_LIMIT}`);
  }
  const asOfNs = options.as_of === undefined ? Number.POSITIVE_INFINITY : Date.parse(options.as_of);
  if (Number.isNaN(asOfNs)) throw new Error("as_of must be ISO-parseable when provided");

  const tierFilter = options.tier;

  const filtered = records
    .filter((record) => record.kind === "node_communication" && record.campaign_id === options.campaign_id)
    .filter((record) => Date.parse(record.communication.as_of) <= asOfNs)
    .filter((record) => tierFilter === undefined || tierCanSee(tierFilter, record.communication.capability_tier))
    .filter((record) => options.conversation_id === undefined || (record.communication.conversation_id ?? null) === options.conversation_id)
    .sort((a, b) => compareCodeUnits(a.communication.as_of, b.communication.as_of) || compareCodeUnits(a.id, b.id))
    // Newest N, not oldest N: the window's tail is the thread version (the CAS
    // cursor), so an oldest-first window froze every limited reader's version
    // at message `limit` once a thread outgrew it.
    .slice(-limit)
    .map(toProjection);

  const conversations = new Map<string, BusMessageProjection[]>();
  const ungrouped: BusMessageProjection[] = [];
  for (const msg of filtered) {
    if (msg.conversation_id === null) {
      ungrouped.push(msg);
    } else {
      const bucket = conversations.get(msg.conversation_id);
      if (bucket === undefined) conversations.set(msg.conversation_id, [msg]);
      else bucket.push(msg);
    }
  }

  // Reconcile each conversation (and the ungrouped bucket) independently,
  // then freeze. Every call recomputes from `records` — nothing here is
  // stored between calls.
  const frozenConversations = new Map<string, readonly BusMessageProjection[]>();
  const allConflicts: PromoteConflict[] = [];
  for (const [id, bucket] of conversations) {
    const { messages, conflicts } = annotateBucket(bucket, id);
    frozenConversations.set(id, messages);
    allConflicts.push(...conflicts);
  }
  const { messages: annotatedUngrouped, conflicts: ungroupedConflicts } = annotateBucket(ungrouped, null);
  allConflicts.push(...ungroupedConflicts);

  return Object.freeze({
    campaign_id: options.campaign_id,
    conversations: frozenConversations,
    ungrouped: annotatedUngrouped,
    as_of: options.as_of ?? new Date().toISOString(),
    promote_conflicts: Object.freeze(allConflicts),
  });
}
