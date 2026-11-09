/**
 * Interviews screen (Phase 4D.8, ADR-019 operator surface).
 *
 * Bounded view of in-flight user-interview ledger records from
 * `userinput.list`/`userinput.awaiting`. This is the TUI's operator-facing
 * half of a governed question: an unanswered `request_user_input` record is
 * projected here with its awaiting status, and the operator answers via the
 * `userinput.answer` command. The screen is LEAF and read-only-render — it
 * only *surfaces* the durable ledger record; it never mints or mutates a
 * question itself (approval-style checks-and-balances: ask authority stays
 * backend-scoped to the lead).
 *
 * Gated on `userinput.read` (render) + `userinput.write` (answer command) —
 * the screen is only offered when the transport grants both.
 *
 * Leaf module. Depends only on @arbor/core (via widgets) and the
 * runtime-port/screen contracts — never @arbor/mcp.
 */

import { clipDisplay, renderTable } from "../widgets.js";
import type { TableColumn } from "../widgets.js";
import type { RowIdentity, ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";
import { emptyCaption, unrecognisedCaption } from "./empty-state.js";

const MAX_ROWS = 200;

function isUserInputListShape(result: unknown): result is { records?: readonly Record<string, unknown>[]; answered_record_ids?: readonly string[] } {
  return typeof result === "object" && result !== null && "records" in result && Array.isArray((result as { records?: unknown }).records);
}

function authorityIcon(authority: string): string {
  switch (authority) {
    case "lead": return "◎";
    case "delegated_needs_input": return "…";
    default: return "?";
  }
}

function blockingIcon(blocking: string): string {
  return blocking === "blocking" ? "▣" : "☐";
}

function rowCountCaption(caption: string, count: number): string {
  return count > 0 ? `${caption} (${count})` : `no ${caption.toLowerCase()}`;
}

function questionRecordId(r: Record<string, unknown>): string {
  if (typeof r.id === "string") return r.id;
  const question = r.question as Record<string, unknown> | undefined;
  if (question && typeof question.operation_id === "string") return question.operation_id;
  return "?";
}

function questionText(r: Record<string, unknown>): string {
  const q = r.question as Record<string, unknown> | undefined;
  return q && typeof q.question === "string" ? q.question : "—";
}

function originSession(r: Record<string, unknown>): string {
  const q = r.question as Record<string, unknown> | undefined;
  // Keep the canonical session identity in the projection so an operator can
  // correlate it with Harness Sessions; the renderer, not the data model,
  // owns viewport clipping.
  return q && typeof q.origin_session_id === "string" ? q.origin_session_id : "—";
}

function projectInterviews(records: readonly Record<string, unknown>[], answeredRecordIds: readonly string[], limit: number): Omit<ScreenProjection, "variant"> {
  // Questions are immutable audit records; answers are appended separately.
  // Reconcile the list before projecting it so the operator sees a truthful
  // attention queue rather than every question ever asked.
  const answered = new Set(answeredRecordIds);
  const sliced = records.filter((record) => !answered.has(questionRecordId(record))).slice(0, limit);
  const bounded = sliced.map((r) => ({
    id: questionRecordId(r),
    question: clipDisplay(questionText(r), 40),
    authority: `${authorityIcon(typeof r.question === "object" && r.question !== null ? String((r.question as Record<string, unknown>).authority ?? "?") : "?")}`,
    blocking: blockingIcon(typeof r.question === "object" && r.question !== null ? String((r.question as Record<string, unknown>).blocking ?? "?") : "?"),
    requester: (r.question as Record<string, unknown>)?.requester_role as string ?? "—",
    session: originSession(r),
  }));

  return {
    screen: "interviews",
    rows: bounded,
    columns: [
      { key: "id", title: "Interview", width: 12, truncate: "middle" },
      { key: "question", title: "Question", width: 44 },
      { key: "authority", title: "Auth", width: 6 },
      { key: "blocking", title: "Blk", width: 4 },
      { key: "requester", title: "Requester", width: 12 },
      { key: "session", title: "Session", width: 36 },
    ],
    caption: rowCountCaption("Interviews", bounded.length),
    // `userinput.answer` needs `record_id` — `questionRecordId` is the same
    // resolution already used for the display `id` column; "?" means it
    // genuinely couldn't be resolved, so it maps to a typed absence here too.
    row_ids: sliced.map((r): RowIdentity | null => {
      const id = questionRecordId(r);
      return id === "?" ? null : { id };
    }),
  };
}

function renderInterviewsTable(projection: ScreenProjection, width: number, height: number, offset?: number): readonly string[] {
  const rows = projection.rows;
  if (rows.length === 0) {
    return [
      clipDisplay("(no pending interviews)", width),
      clipDisplay("Interviews appear when a governed delegate needs operator input.", width),
    ].slice(0, Math.max(1, height));
  }
  const cols: TableColumn[] = projection.columns.map((c) => ({ key: c.key, title: c.title, width: c.width }));
  try {
    const lines = renderTable(rows, cols, { height, offset });
    return [clipDisplay(projection.caption ?? "Interviews", width), ...lines];
  } catch {
    return [clipDisplay("(render error)", width)];
  }
}

function emptyProjection(reason: "empty" | "unrecognised"): Omit<ScreenProjection, "variant"> {
  return {
    screen: "interviews",
    rows: [],
    columns: [{ key: "id", title: "Interview", width: 10, truncate: "middle" }],
    caption: reason === "empty"
      ? emptyCaption({ what: "No pending interviews", how: "they appear when a delegate needs operator input" })
      : unrecognisedCaption("Interviews"),
  };
}

const INTERVIEWS_VARIANTS = [
  defineVariant({
    tag: "interviews",
    match: isUserInputListShape,
    project: (shape) => projectInterviews(shape.records ?? [], shape.answered_record_ids ?? [], MAX_ROWS),
    render: (projection, ctx) => renderInterviewsTable(projection, ctx.width, ctx.height, ctx.scroll_offset),
  }),
];

export const interviewsScreen: ScreenModule = {
  id: "interviews" as ScreenId,
  title: "Interviews",
  required_capabilities: ["userinput.read", "userinput.write"],

  surface: {
    commands: ["userinput.answer"],
    // `userinput.awaiting` was declared here with no real caller and, worse,
    // a real return shape (`{campaign_id, node_id, awaiting: boolean}` —
    // runtime-catalog.ts's `executeUserInputQuery`) this screen's own
    // `isUserInputListShape` (requires a `records` array) could never match:
    // it is not list data at all, just a single pending/not-pending flag.
    // `interview-selection.test.ts`'s own header explains the actual
    // resolution — the two query surfaces "disagreed" (`userinput.awaiting`
    // said false while a stale selection still named a target), fixed by
    // giving `userinput.list` an `answered_record_ids` field instead
    // (`operator-selection.ts`'s `latestInterview`) rather than by fixing
    // this one. Declaring it here was leftover, not a real contract.
    queries: ["userinput.list"],
  },

  ...buildScreenPipeline(INTERVIEWS_VARIANTS, { emptyProjection, shortCircuitEmptyRows: false }),
};
