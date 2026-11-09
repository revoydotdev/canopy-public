/**
 * a2a-wire.ts — the A2A v1.0.0 conformance seam.
 *
 * WHAT THIS RECONCILES. revoy2's `a2a-contracts.ts` types are an INTERNAL
 * projection layer, and they match no released A2A version: they use snake_case
 * ids (`id`, `task_id`), lower-case task states (`"completed"`), and a `kind`
 * discriminator on parts including an invented `"evidence_ref"` kind. That was
 * fine while nothing transmitted them, and wrong the moment anything does.
 *
 * The authoritative spec (a2a-protocol.org, v1.0.0, Linux Foundation) says:
 *   - `spec/a2a.proto` is the single normative definition; JSON is a
 *     serialization of it, with three official bindings (JSON-RPC 2.0, gRPC,
 *     HTTP+JSON/REST).
 *   - `TaskState` is SCREAMING_SNAKE_CASE: TASK_STATE_SUBMITTED, _WORKING,
 *     _COMPLETED, _FAILED, _CANCELED, _INPUT_REQUIRED, _REJECTED,
 *     _AUTH_REQUIRED, _UNSPECIFIED.
 *   - `Message` carries `messageId`, `contextId`, `taskId`, `role`
 *     (ROLE_USER / ROLE_AGENT / ROLE_UNSPECIFIED), `parts`, and optional
 *     `metadata`, `extensions`, `referenceTaskIds`.
 *   - `Part` is a one-of over `text` / `raw` / `url` / `data`, with an optional
 *     per-part `metadata`. The `kind` discriminator was REMOVED in v1.0.0 —
 *     a documented breaking change, and precisely the field revoy2 relies on.
 *
 * HOW THE BESPOKE PART SURVIVES — the point of this module. A2A v1.0.0 has a
 * first-class extension mechanism: `AgentCard.extensions` and
 * `Message.extensions` carry extension URIs, and `metadata` objects hang off
 * Task, Message and Part. Vendor data is SUPPOSED to live there. So revoy2's
 * evidence reference does not have to be dropped to become conformant, and does
 * not have to break conformance to be kept:
 *
 *   internal  { kind: "evidence_ref", evidence_ref: "trace_7" }
 *   wire      { data: { evidence_ref: "trace_7" },
 *               metadata: { "arbor.dev/evidence-ref": "trace_7" } }
 *             + EVIDENCE_REF_EXTENSION_URI declared in Message.extensions
 *
 * A stock A2A client parses that as an ordinary DataPart and ignores what it
 * does not know — no conformance violation, nothing lost on the wire. A client
 * that recognises the extension URI reads the evidence reference and can follow
 * it back to the ledger record that authorises the claim. The bespoke
 * capability becomes DISCOVERABLE rather than proprietary, which is strictly
 * better than either dropping it or shipping an invented `kind`.
 *
 * DIRECTION AND AUTHORITY. This module is pure translation and holds no state.
 * It never decides task state: `deriveA2ATaskFromCommunications` does that from
 * ledger-witnessed records, and this module only renames the result for the
 * wire. An inbound wire task state is deliberately NOT trusted — see
 * `taskStateFromWire`'s note — because accepting it would make a remote peer an
 * authority over revoy2's ledger, which is the one thing 4D.6 forbids.
 */

import { compareCodeUnits } from "@arbor/core";
import type { A2AMessage, A2APart, A2ATask, A2ATaskState } from "./a2a-contracts.js";

/**
 * The URI identifying revoy2's evidence-reference extension.
 *
 * A2A extensions are URI-identified rather than type-tagged, so this string IS
 * the contract: a peer that knows it can read `metadata` for a ledger evidence
 * id, and a peer that does not still parses the message correctly.
 *
 * This follows A2A's official URI-plus-version convention. The official
 * Timestamp extension is the closest structural analogue because it also
 * augments ordinary Message/Artifact metadata without adding a new wire shape.
 * `arbor.dev` is deliberately revoy2's vendor namespace: this is not an
 * `a2aproject` official extension and does not claim to be one. Reference:
 * https://a2a-protocol.org/latest/topics/extensions/
 */
export const EVIDENCE_REF_EXTENSION_URI = "https://arbor.dev/a2a/extensions/evidence-ref/v1";

/** Metadata key carrying the evidence id, on both Part.metadata and Message.metadata. */
export const EVIDENCE_REF_METADATA_KEY = "arbor.dev/evidence-ref";

/** A2A v1.0.0 `TaskState`, exactly as it appears on the wire. */
export type WireTaskState =
  | "TASK_STATE_UNSPECIFIED"
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_INPUT_REQUIRED"
  | "TASK_STATE_REJECTED"
  | "TASK_STATE_AUTH_REQUIRED";

/** A2A v1.0.0 `Role`. */
export type WireRole = "ROLE_UNSPECIFIED" | "ROLE_USER" | "ROLE_AGENT";

/**
 * A2A v1.0.0 `Part`: a one-of over text/raw/url/data with optional metadata.
 * No `kind` discriminator — v1.0.0 removed it.
 */
export interface WirePart {
  readonly text?: string;
  readonly raw?: string;
  readonly url?: string;
  readonly data?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
}

/** A2A v1.0.0 `Message`. */
export interface WireMessage {
  readonly messageId: string;
  readonly contextId?: string;
  readonly taskId: string;
  readonly role: WireRole;
  readonly parts: readonly WirePart[];
  readonly extensions?: readonly string[];
  readonly metadata?: Record<string, unknown>;
  readonly referenceTaskIds?: readonly string[];
}

/** A2A v1.0.0 `Task`, in the subset revoy2 projects. */
export interface WireTask {
  readonly id: string;
  readonly contextId?: string;
  readonly status: { readonly state: WireTaskState };
  readonly metadata?: Record<string, unknown>;
}

/** A2A v1.0.0 `AgentCard`, in the subset revoy2 publishes. */
export interface WireAgentCard {
  readonly name: string;
  readonly description: string;
  readonly skills: readonly { readonly id: string; readonly name: string }[];
  readonly extensions: readonly { readonly uri: string; readonly required: boolean }[];
  readonly metadata: Record<string, unknown>;
}

const TASK_STATE_TO_WIRE: Readonly<Record<A2ATaskState, WireTaskState>> = Object.freeze({
  submitted: "TASK_STATE_SUBMITTED",
  working: "TASK_STATE_WORKING",
  input_required: "TASK_STATE_INPUT_REQUIRED",
  completed: "TASK_STATE_COMPLETED",
  canceled: "TASK_STATE_CANCELED",
  failed: "TASK_STATE_FAILED",
});

/**
 * Wire states revoy2 can represent internally. `TASK_STATE_REJECTED` and
 * `TASK_STATE_AUTH_REQUIRED` are real v1.0.0 states with no internal
 * counterpart; they are mapped to `failed` and `input_required` respectively
 * rather than silently dropped, and `wireStateIsLossy` reports when that
 * narrowing happened so a caller can tell an exact round trip from an
 * approximate one.
 */
const WIRE_TO_TASK_STATE: Readonly<Record<WireTaskState, A2ATaskState>> = Object.freeze({
  TASK_STATE_UNSPECIFIED: "submitted",
  TASK_STATE_SUBMITTED: "submitted",
  TASK_STATE_WORKING: "working",
  TASK_STATE_COMPLETED: "completed",
  TASK_STATE_FAILED: "failed",
  TASK_STATE_CANCELED: "canceled",
  TASK_STATE_INPUT_REQUIRED: "input_required",
  TASK_STATE_REJECTED: "failed",
  TASK_STATE_AUTH_REQUIRED: "input_required",
});

/** True when `taskStateFromWire` had to narrow — the round trip is approximate, not exact. */
export function wireStateIsLossy(state: WireTaskState): boolean {
  const internal = WIRE_TO_TASK_STATE[state];
  return internal === undefined || TASK_STATE_TO_WIRE[internal] !== state;
}

export function taskStateToWire(state: A2ATaskState): WireTaskState {
  const wire = TASK_STATE_TO_WIRE[state];
  if (wire === undefined) throw new Error(`unmappable internal task state: ${String(state)}`);
  return wire;
}

/**
 * Translate a wire state inward.
 *
 * This exists for rendering and diagnostics, NOT for accepting a peer's claim
 * about a task revoy2 owns. Task state for revoy2-owned tasks is always
 * recomputed from ledger-witnessed records; a remote peer that could set it
 * would be a second authority over the ledger, which 4D.6 forbids outright.
 */
export function taskStateFromWire(state: WireTaskState): A2ATaskState {
  const internal = WIRE_TO_TASK_STATE[state];
  if (internal === undefined) throw new Error(`unknown A2A task state: ${String(state)}`);
  return internal;
}

/** Internal part -> conformant v1.0.0 Part. */
export function partToWire(part: A2APart): WirePart {
  if (part.kind === "text") return { text: part.text ?? "" };
  const reference = part.evidence_ref ?? "";
  // A DataPart, which every v1.0.0 client can parse, plus per-part metadata
  // under the extension's key so a peer that knows the URI can find it without
  // reaching into `data`'s shape.
  return {
    data: { [EVIDENCE_REF_METADATA_KEY]: reference },
    metadata: { [EVIDENCE_REF_METADATA_KEY]: reference },
  };
}

/** Conformant v1.0.0 Part -> internal part, recovering the extension when present. */
export function partFromWire(part: WirePart): A2APart {
  const fromMetadata = part.metadata?.[EVIDENCE_REF_METADATA_KEY];
  const fromData = part.data?.[EVIDENCE_REF_METADATA_KEY];
  const reference = typeof fromMetadata === "string" ? fromMetadata : typeof fromData === "string" ? fromData : undefined;
  if (reference !== undefined) return { kind: "evidence_ref", evidence_ref: reference };
  if (typeof part.text === "string") return { kind: "text", text: part.text };
  // A raw/url/data part from a peer that does not speak our extension. It is
  // representable only as text internally; naming it explicitly is better than
  // dropping the part and pretending the message was empty.
  if (typeof part.url === "string") return { kind: "text", text: part.url };
  if (typeof part.raw === "string") return { kind: "text", text: part.raw };
  return { kind: "text", text: part.data === undefined ? "" : JSON.stringify(part.data) };
}

/**
 * Internal message -> conformant v1.0.0 Message.
 *
 * `role` is ROLE_AGENT: every message revoy2 emits is authored by a node, never
 * by a human user. The extension URI is declared only when a part actually
 * carries an evidence reference, so a plain text exchange stays a plain
 * conformant message with no extension noise.
 */
export function messageToWire(message: A2AMessage): WireMessage {
  const parts = message.parts.map(partToWire);
  const carriesEvidence = parts.some((part) => part.metadata?.[EVIDENCE_REF_METADATA_KEY] !== undefined);
  const recipients = [...message.recipient_node_refs].sort(compareCodeUnits);
  return {
    messageId: message.id,
    taskId: message.task_id,
    contextId: message.task_id,
    role: "ROLE_AGENT",
    parts,
    ...(carriesEvidence ? { extensions: [EVIDENCE_REF_EXTENSION_URI] } : {}),
    metadata: {
      "arbor.dev/author-node-ref": message.author_node_ref,
      "arbor.dev/recipient-node-refs": recipients,
      "arbor.dev/as-of": message.as_of,
      ...(message.task === undefined ? {} : { "arbor.dev/task-state": taskStateToWire(message.task.state) }),
    },
  };
}

/**
 * Conformant v1.0.0 Message -> internal message.
 *
 * Fields A2A has no place for (author, recipients, as_of) are read back from
 * the `arbor.dev/*` metadata this module wrote. A message from a peer that does
 * not set them still converts: the caller supplies the fallbacks, because
 * inventing an author here would fabricate provenance.
 */
export function messageFromWire(
  wire: WireMessage,
  fallback: { readonly author_node_ref: string; readonly as_of: string },
): A2AMessage {
  const meta = wire.metadata ?? {};
  const author = typeof meta["arbor.dev/author-node-ref"] === "string"
    ? (meta["arbor.dev/author-node-ref"] as string)
    : fallback.author_node_ref;
  const rawRecipients = meta["arbor.dev/recipient-node-refs"];
  const recipients = Array.isArray(rawRecipients)
    ? rawRecipients.filter((entry): entry is string => typeof entry === "string")
    : [];
  const asOf = typeof meta["arbor.dev/as-of"] === "string" ? (meta["arbor.dev/as-of"] as string) : fallback.as_of;
  return {
    id: wire.messageId,
    task_id: wire.taskId,
    author_node_ref: author,
    recipient_node_refs: [...recipients].sort(compareCodeUnits),
    parts: wire.parts.map(partFromWire),
    as_of: asOf,
  };
}

/** Internal task -> conformant v1.0.0 Task. */
export function taskToWire(task: A2ATask): WireTask {
  return {
    id: task.id,
    contextId: task.id,
    status: { state: taskStateToWire(task.state) },
    metadata: { "arbor.dev/node-ref": task.node_ref },
  };
}
