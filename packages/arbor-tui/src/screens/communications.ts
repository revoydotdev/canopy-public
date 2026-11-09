/**
 * Communications screen (roadmap 4C, item 19).
 *
 * Bounded, provenance-typed node-communication view: request/response/
 * broadcast/handoff records with acknowledgement/retraction, correlation
 * and history. Capability-tier redaction is STRUCTURAL: a consumer whose
 * tier cannot read a communication does not receive the payload field at
 * all — it is absent from the projection, not hidden in render.
 *
 * Message authority remains the backend; the screen holds only a bounded
 * cursor-windowed cache. Control only for the real catalog capability
 * `communication.record` (supported:true); queries communication.selection
 * and communication.history.
 *
 * Leaf module. Depends only on @arbor/core (via widgets) and the
 * runtime-port/screen contracts — never @arbor/mcp/@arbor/audit.
 */

import { clipDisplay } from "../widgets.js";
import type { TableColumn } from "../widgets.js";
import type { RowIdentity, ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";
import { emptyCaption, unrecognisedCaption } from "./empty-state.js";
import { renderCausalMessageDocument, type CausalMessageDocumentRow } from "./message-document.js";

const MAX_ROWS = 100;
const MAX_CONTENT_BYTES = 512;

const TIER_ORDER = ["orchestrator", "auditor", "critic", "specialist"] as const;
type Tier = "orchestrator" | "auditor" | "critic" | "specialist";

function tierRank(tier: string): number {
  const index = TIER_ORDER.indexOf(tier as Tier);
  return index === -1 ? TIER_ORDER.length : index;
}

function isSelectionShape(result: unknown): result is { communications?: readonly Record<string, unknown>[]; consumer_tier?: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    "communications" in result &&
    Array.isArray((result as { communications?: unknown }).communications)
  );
}

function isCommunicationsArray(result: unknown): result is readonly Record<string, unknown>[] {
  return (
    Array.isArray(result) &&
    result.length > 0 &&
    typeof result[0] === "object" &&
    result[0] !== null
  );
}

/** Structural redaction by consumer tier: forbidden payload is ABSENT. */
function redactByTier(
  record: Record<string, unknown>,
  consumerTier: string | undefined,
): Readonly<Record<string, unknown>> {
  // `communication.selection` returns a WRAPPER per message --
  // `{kind: "node_communication", id, timestamp, communication: {...}}` -- and
  // every field read below (author, recipient, payload, capability_tier, ack,
  // retract, correlation) lives on the inner object. Reading them off the
  // wrapper silently produced `unknown -> unknown` with no content, and made
  // `capability_tier` fall back to "specialist" for every message regardless
  // of what it actually carried. The visible tell was this screen rendering
  // the wrapper's kind ("node_communication") where `bus.ts`, which reads the
  // same records correctly, renders the message kind ("report").
  const inner = typeof record.communication === "object" && record.communication !== null
    ? record.communication as Record<string, unknown>
    : record;
  const communication = inner;
  const commTier = typeof communication.capability_tier === "string" ? communication.capability_tier : "specialist";
  // A consumer holding an equal-or-higher tier may read the payload; otherwise
  // the payload field is structurally absent (not blanked).
  const canRead = consumerTier !== undefined && tierRank(consumerTier) <= tierRank(commTier);

  // An absence must name its CAUSE (EC-016). These fields rendered a bare "?",
  // which conflates "withheld at your tier" with "genuinely unknown" -- two
  // opposite facts about the operator's own authority. The payload below
  // already distinguishes itself ("payload structurally unavailable to this
  // consumer tier"); the endpoints said nothing, so `? → ?` read as missing
  // data when it actually meant the reader lacks the tier to be told. Same
  // WA-59 convention `governance.ts` and eight sibling screens already follow.
  const absent = canRead ? "unknown" : "redacted";
  const row: Record<string, unknown> = {
    id: typeof record.id === "string" ? record.id : typeof communication.id === "string" ? communication.id : absent,
    kind: typeof communication.kind === "string" ? communication.kind : absent,
    tier: commTier,
    author: typeof communication.author_node_id === "string" ? communication.author_node_id : absent,
    recipient: typeof communication.recipient_node_id === "string" ? communication.recipient_node_id : absent,
    ack: typeof communication.acknowledges_communication_id === "string" ? "yes" : "no",
    retracts: typeof communication.retracts_communication_id === "string" ? "yes" : "no",
    causal: causalRelationship(communication),
  };

  if (canRead) {
    const payload = (communication.payload ?? {}) as Record<string, unknown>;
    const content = typeof payload.content === "string" ? payload.content : "";
    row.content = clipDisplay(content, MAX_CONTENT_BYTES);
    row.correlation = typeof communication.correlation_id === "string" ? communication.correlation_id : "—";
  }
  // else: content/correlation are absent from the projected row entirely.

  return row;
}

function rowCountCaption(caption: string, count: number): string {
  return count > 0 ? `${caption} (${count})` : `no ${caption.toLowerCase()}`;
}

function projectCommunications(
  communications: readonly Record<string, unknown>[],
  limit: number,
  consumerTier?: string,
  source = "communication.selection",
): Omit<ScreenProjection, "variant"> {
  const sliced = communications.slice(0, limit);
  const bounded = sliced.map((comm) => ({ ...redactByTier(comm, consumerTier), source }));
  const columns: TableColumn[] = [
    { key: "id", title: "Msg", width: 12, truncate: "middle" },
    { key: "kind", title: "Kind", width: 8 },
    { key: "tier", title: "Tier", width: 10 },
    { key: "author", title: "From", width: 12 },
    { key: "recipient", title: "To", width: 12 },
    { key: "ack", title: "Ack", width: 4 },
    { key: "retracts", title: "Ret", width: 5 },
  ];
  // content/correlation columns only appear when any row is structurally readable
  const hasContent = bounded.some((row) => "content" in row);
  if (hasContent) {
    columns.push({ key: "content", title: "Content", width: 30 });
    columns.push({ key: "correlation", title: "Corr", width: 10 });
  }

  return {
    screen: "communications",
    rows: bounded,
    columns,
    caption: `${rowCountCaption("Communications", bounded.length)} · canonical/${source} · source order`,
    row_ids: sliced.map((comm): RowIdentity | null => (typeof comm.id === "string" ? { id: comm.id } : null)),
  };
}

function causalRelationship(communication: Record<string, unknown>): string {
  const links = [
    typeof communication.parent_communication_id === "string" ? `parent ${communication.parent_communication_id}` : null,
    typeof communication.reply_to_communication_id === "string" ? `reply ${communication.reply_to_communication_id}` : null,
    typeof communication.acknowledges_communication_id === "string" ? `acknowledges ${communication.acknowledges_communication_id}` : null,
    typeof communication.retracts_communication_id === "string" ? `retracts ${communication.retracts_communication_id}` : null,
  ].filter((value): value is string => value !== null);
  return links.length === 0 ? "no declared causal handoff" : links.join(" · ");
}

function documentRows(projection: ScreenProjection): readonly CausalMessageDocumentRow[] {
  return projection.rows.map((row) => ({
    id: typeof row.id === "string" ? row.id : "unknown",
    kind: typeof row.kind === "string" ? row.kind : "message",
    actor: typeof row.author === "string" ? row.author : "unknown",
    recipients: typeof row.recipient === "string" ? row.recipient : "unknown",
    source: typeof row.source === "string" ? row.source : "communication.selection",
    truth: "canonical",
    relationship: typeof row.causal === "string" ? row.causal : "no declared causal handoff",
    status: typeof row.ack === "string" || typeof row.retracts === "string"
      ? `ack ${row.ack === "yes" ? "declared" : "none"}; retract ${row.retracts === "yes" ? "declared" : "none"}`
      : null,
    detail: typeof row.content === "string" ? row.content : "payload structurally unavailable to this consumer tier",
  }));
}

function renderCommunicationsDocument(
  projection: ScreenProjection,
  width: number,
  height: number,
  offset?: number,
): readonly string[] {
  if (projection.rows.length === 0) return [clipDisplay("(no communications)", width)];
  return renderCausalMessageDocument(projection.caption ?? "Communications", documentRows(projection), width, height, offset);
}

function emptyProjection(reason: "empty" | "unrecognised"): Omit<ScreenProjection, "variant"> {
  return {
    screen: "communications",
    rows: [],
    columns: [{ key: "id", title: "ID", width: 10, truncate: "middle" }],
    caption: reason === "empty"
      ? emptyCaption({ what: "No communications loaded", how: "select a node, then reopen Communications (5)" })
      : unrecognisedCaption("Communications"),
  };
}

export interface CommunicationsScreenOptions {
  /** Consumer capability tier; undefined means low-tier default (structural redaction). */
  consumerTier?: string;
}

const COMMUNICATIONS_VARIANTS = [
  defineVariant({
    tag: "selection",
    match: isSelectionShape,
    // The envelope declares the tier it was gated at (`runtime-catalog.ts`).
    // Preferring it keeps the view from re-deciding access: an operator whose
    // query already ran at "orchestrator" must not be redacted a second time
    // by a screen option that no production caller sets.
    project: (shape, input) => projectCommunications(shape.communications ?? [], MAX_ROWS, shape.consumer_tier ?? input.consumerTier, "communication.selection"),
    render: (projection, ctx) => renderCommunicationsDocument(projection, ctx.width, ctx.height, ctx.scroll_offset),
  }),
  defineVariant({
    tag: "array",
    match: isCommunicationsArray,
    project: (shape, input) => projectCommunications(shape, MAX_ROWS, input.consumerTier, "communication.history"),
    render: (projection, ctx) => renderCommunicationsDocument(projection, ctx.width, ctx.height, ctx.scroll_offset),
  }),
];

export const communicationsScreen: ScreenModule = {
  id: "communications" as ScreenId,
  title: "Communications",
  required_capabilities: ["communication.read", "communication.write"],

  surface: {
    commands: ["communication.record"],
    // `communication.history` has no live caller (`tui.ts`'s
    // `refreshScreenData` only ever issues `communication.selection`), but —
    // unlike `interviews.ts`'s removed `userinput.awaiting` — its real
    // return shape (`{campaign_id, node_id, as_of, communications}`,
    // `runtime-catalog.ts`'s `communication.history` case) already matches
    // this screen's "selection" variant exactly, so it renders correctly the
    // moment something issues it. Kept declared; wiring an actual "browse
    // full node history" trigger is a `tui.ts` change, out of scope here.
    queries: ["communication.selection", "communication.history"],
  },

  ...buildScreenPipeline(COMMUNICATIONS_VARIANTS, { emptyProjection }),
};
