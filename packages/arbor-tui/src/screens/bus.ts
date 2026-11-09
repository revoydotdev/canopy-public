/** Campaign-wide conversation bus history (`bus.history` — durable, conversation-scoped). */
import { clipDisplay } from "../widgets.js";
import type { RowIdentity, ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";
import { emptyCaption, unrecognisedCaption } from "./empty-state.js";
import { renderCausalMessageDocument, type CausalMessageDocumentRow } from "./message-document.js";

const MAX_ROWS = 200;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

interface BusMessageRow {
  readonly id?: unknown;
  readonly conversation_id?: unknown;
  readonly author_node_id?: unknown;
  readonly recipient_node_ids?: unknown;
  readonly kind?: unknown;
  readonly as_of?: unknown;
  readonly payload_preview?: unknown;
  readonly parent_communication_id?: unknown;
  readonly reply_to_communication_id?: unknown;
  readonly acknowledges_communication_id?: unknown;
  readonly retracts_communication_id?: unknown;
  readonly ack_required?: unknown;
}

function isBusHistory(value: unknown): value is { campaign_id: string; conversations: unknown; ungrouped: unknown; as_of: string } {
  return isRecord(value) && typeof value.campaign_id === "string" && typeof value.as_of === "string" && "conversations" in value && Array.isArray(value.ungrouped);
}

/**
 * Flattens durable conversation lanes without manufacturing a campaign-wide
 * chronology. Each bucket retains its producer order; the screen labels each
 * row with its conversation lane instead of sorting unrelated conversations
 * by timestamps.
 */
function flattenMessages(value: { conversations: unknown; ungrouped: unknown }): readonly BusMessageRow[] {
  const grouped: BusMessageRow[] = [];
  const conversations = value.conversations;
  if (conversations instanceof Map) {
    for (const messages of conversations.values()) if (Array.isArray(messages)) grouped.push(...(messages as BusMessageRow[]));
  } else if (isRecord(conversations)) {
    for (const messages of Object.values(conversations)) if (Array.isArray(messages)) grouped.push(...(messages as BusMessageRow[]));
  }
  const ungrouped = Array.isArray(value.ungrouped) ? (value.ungrouped as BusMessageRow[]) : [];
  return [...grouped, ...ungrouped];
}

function causalRelationship(message: BusMessageRow): string {
  const links = [
    typeof message.parent_communication_id === "string" ? `parent ${message.parent_communication_id}` : null,
    typeof message.reply_to_communication_id === "string" ? `reply ${message.reply_to_communication_id}` : null,
    typeof message.acknowledges_communication_id === "string" ? `acknowledges ${message.acknowledges_communication_id}` : null,
    typeof message.retracts_communication_id === "string" ? `retracts ${message.retracts_communication_id}` : null,
  ].filter((value): value is string => value !== null);
  return links.length === 0 ? "no declared causal handoff" : links.join(" · ");
}

function project(value: { campaign_id: string; conversations: unknown; ungrouped: unknown; as_of: string }): Omit<ScreenProjection, "variant"> {
  const messages = flattenMessages(value).slice(0, MAX_ROWS);
  return {
    screen: "bus",
    caption: messages.length ? `Conversation bus (${messages.length}) · canonical/bus.history · conversation lanes` : "no bus messages",
    columns: [
      { key: "conversation", title: "Conversation", width: 16 },
      { key: "kind", title: "Kind", width: 10 },
      { key: "author", title: "From", width: 14 },
      { key: "recipients", title: "To", width: 18 },
      { key: "content", title: "Content", width: 40 },
    ],
    rows: messages.map((message) => {
      const preview = isRecord(message.payload_preview) ? message.payload_preview : {};
      const recipients = Array.isArray(message.recipient_node_ids) ? message.recipient_node_ids.filter((id): id is string => typeof id === "string").join(",") : "?";
      return {
        id: typeof message.id === "string" ? message.id : "?",
        conversation: typeof message.conversation_id === "string" ? message.conversation_id : "(ungrouped)",
        kind: typeof message.kind === "string" ? message.kind : "?",
        author: typeof message.author_node_id === "string" ? message.author_node_id : "?",
        recipients,
        content: clipDisplay(typeof preview.content === "string" ? preview.content : "?", 200),
        causal: causalRelationship(message),
        receipt: message.ack_required === true ? "ack required" : "ack not required",
      };
    }),
    row_ids: messages.map((message): RowIdentity | null => (typeof message.id === "string" ? { id: message.id } : null)),
  };
}

function documentRows(projection: ScreenProjection): readonly CausalMessageDocumentRow[] {
  return projection.rows.map((row) => ({
    id: typeof row.id === "string" ? row.id : "?",
    kind: typeof row.kind === "string" ? row.kind : "message",
    actor: typeof row.author === "string" ? row.author : "?",
    recipients: typeof row.recipients === "string" ? row.recipients : "?",
    source: "bus.history",
    truth: "canonical",
    relationship: `${typeof row.conversation === "string" ? `lane ${row.conversation}` : "lane unavailable"} · ${typeof row.causal === "string" ? row.causal : "no declared causal handoff"}`,
    status: typeof row.receipt === "string" ? row.receipt : null,
    detail: typeof row.content === "string" ? row.content : null,
  }));
}
function render(projection: ScreenProjection, width: number, height: number, offset?: number): readonly string[] {
  if (!projection.rows.length) return [clipDisplay(projection.caption ?? "Conversation bus", width)];
  return renderCausalMessageDocument(projection.caption ?? "Conversation bus", documentRows(projection), width, height, offset);
}

export const busScreen: ScreenModule = {
  id: "bus" as ScreenId, title: "Bus", required_capabilities: ["bus.read", "bus.write"],
  surface: { commands: ["bus.record"], queries: ["bus.history"] },
  ...buildScreenPipeline([defineVariant({ tag: "history", match: isBusHistory, project, render: (p, c) => render(p, c.width, c.height, c.scroll_offset) })], {
    emptyProjection: (reason) => ({
      screen: "bus",
      rows: [],
      columns: [{ key: "conversation", title: "Conversation", width: 16 }],
      caption: reason === "empty"
        ? emptyCaption({ what: "No conversation bus history", how: "select an active campaign, then reopen Bus (ctrl+d)" })
        : unrecognisedCaption("Bus"),
    }),
  }),
};
