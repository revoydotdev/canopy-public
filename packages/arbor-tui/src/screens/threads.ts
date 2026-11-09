/** Durable, relationship-scoped parent/child thread projection. */
import { clipDisplay } from "../widgets.js";
import type { RowIdentity, ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";
import { renderCausalMessageDocument, type CausalMessageDocumentRow } from "./message-document.js";

const MAX_ROWS = 200;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function isThread(value: unknown): value is { thread_id: string; parent_node_id: string; child_node_id: string; version: string; can_accept_direct_input?: boolean; messages: readonly Record<string, unknown>[] } {
  return isRecord(value) && typeof value.thread_id === "string" && typeof value.parent_node_id === "string" && typeof value.child_node_id === "string" && typeof value.version === "string" && Array.isArray(value.messages);
}
function causalRelationship(message: Record<string, unknown>): string {
  const links = [
    typeof message.parent_communication_id === "string" ? `parent ${message.parent_communication_id}` : null,
    typeof message.reply_to_communication_id === "string" ? `reply ${message.reply_to_communication_id}` : null,
    typeof message.acknowledges_communication_id === "string" ? `acknowledges ${message.acknowledges_communication_id}` : null,
    typeof message.retracts_communication_id === "string" ? `retracts ${message.retracts_communication_id}` : null,
  ].filter((value): value is string => value !== null);
  return links.length === 0 ? "no declared causal handoff" : links.join(" · ");
}

function project(value: { thread_id: string; parent_node_id: string; child_node_id: string; version: string; can_accept_direct_input?: boolean; messages: readonly Record<string, unknown>[] }): Omit<ScreenProjection, "variant"> {
  const messages = value.messages.slice(0, MAX_ROWS);
  const direct = value.can_accept_direct_input === true ? "direct input accepted" : "direct input unavailable";
  const attention = messages.filter((message) => message.intent === "needs_attention").length;
  const late = messages.filter((message) => message.delivery === "timed_out").length;
  return {
    screen: "threads",
    caption: `${value.parent_node_id} ↔ ${value.child_node_id} · canonical/bus.thread.history · ${direct} · attention ${attention} · late ${late} · CAS ${value.version}`,
    columns: [{ key: "from", title: "From", width: 12 }, { key: "to", title: "To", width: 12 }, { key: "intent", title: "Intent", width: 16 }, { key: "delivery", title: "Delivery", width: 14 }, { key: "receipt", title: "Receipt", width: 14 }, { key: "due", title: "Deadline", width: 18 }, { key: "trust", title: "Trust", width: 20 }, { key: "content", title: "Content", width: 38 }],
    rows: messages.map((message) => {
      const payload = isRecord(message.payload_preview) ? message.payload_preview : {};
      const recipients = Array.isArray(message.recipient_node_ids) ? message.recipient_node_ids.filter((id): id is string => typeof id === "string").join(",") : "?";
      const remote = isRecord(message.remote_attribution) ? message.remote_attribution : null;
      const delivery = typeof message.delivery === "string" ? message.delivery : "?";
      const receipt = delivery === "acknowledged" ? "recipient ack" : message.ack_required === true ? "awaiting ack" : "not required";
      return { id: typeof message.id === "string" ? message.id : "?", from: typeof message.author_node_id === "string" ? message.author_node_id : "?", to: recipients, intent: typeof message.intent === "string" ? message.intent : (typeof message.kind === "string" ? message.kind : "?"), delivery, receipt, due: typeof message.deadline_at === "string" ? message.deadline_at : "—", trust: remote === null ? "local" : `${typeof remote.integrity === "string" ? remote.integrity : "verified"}:${typeof remote.session_id === "string" ? remote.session_id : "?"}`, causal: causalRelationship(message), content: clipDisplay(typeof payload.content === "string" ? payload.content : "?", 180) };
    }),
    row_ids: messages.map((message): RowIdentity | null => typeof message.id === "string" ? { id: message.id, context: { parent_node_id: value.parent_node_id, child_node_id: value.child_node_id, expected_thread_version: value.version, author_node_id: typeof message.author_node_id === "string" ? message.author_node_id : "", ack_required: message.ack_required === true ? "true" : "false" } } : null),
  };
}
function documentRows(projection: ScreenProjection): readonly CausalMessageDocumentRow[] {
  return projection.rows.map((row) => ({
    id: typeof row.id === "string" ? row.id : "?",
    kind: typeof row.intent === "string" ? row.intent : "message",
    actor: typeof row.from === "string" ? row.from : "?",
    recipients: typeof row.to === "string" ? row.to : "?",
    source: "bus.thread.history",
    truth: "canonical",
    relationship: typeof row.causal === "string" ? row.causal : "no declared causal handoff",
    status: `${typeof row.delivery === "string" ? row.delivery : "delivery unavailable"}; ${typeof row.receipt === "string" ? row.receipt : "receipt unavailable"}`,
    detail: typeof row.content === "string" ? row.content : null,
  }));
}
function render(projection: ScreenProjection, width: number, height: number, offset?: number): readonly string[] {
  if (!projection.rows.length) return [clipDisplay(`${projection.caption ?? "Parent/child thread"}; no durable messages`, width)];
  return renderCausalMessageDocument(projection.caption ?? "Parent/child thread", documentRows(projection), width, height, offset);
}
export const threadsScreen: ScreenModule = {
  id: "threads" as ScreenId, title: "Parent/Child Threads", required_capabilities: ["bus.read", "bus.write"],
  surface: { commands: ["bus.thread.send", "bus.thread.ack"], queries: ["bus.thread.history"] },
  ...buildScreenPipeline([defineVariant({ tag: "thread", match: isThread, project, render: (p, c) => render(p, c.width, c.height, c.scroll_offset) })], {
    emptyProjection: () => ({ screen: "threads", rows: [], columns: [{ key: "from", title: "From", width: 12 }], caption: "No direct thread — select a non-root Tree node (t), then open Threads (:)" }),
  }),
};
