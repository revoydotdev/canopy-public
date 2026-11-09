/**
 * Live interactive-session screen (ADR-107 decision 3).
 *
 * This leaf is deliberately only a bounded projection over
 * `harness.session.list`/`harness.session.attach` values, restricted to
 * still-live (attachable, non-terminal) sessions. It has no
 * `LiveNativeSessionRegistry`, campaign-manager, or connector import and
 * therefore cannot turn a turn, steering message, or interruption into
 * execution authority by itself — every command it declares is dispatched by
 * the composition root through RuntimePort, exactly like `task-composer.ts`.
 *
 * A session's first message already ran through `TaskComposer`/admission
 * before this screen ever sees it (see `arbor session start`); this screen
 * only ever steers or interrupts an already-admitted, already-live session.
 */
import { clipDisplay, renderTable, wrapDisplay } from "../widgets.js";
import type { TableColumn } from "../widgets.js";
import { buildOperatorViewModel } from "../operator-view-model.js";
import type { EventView } from "../operator-view-model.js";
import { renderOperatorEvent } from "../operator-event-render.js";
import type { FrontierLiveEdgeState } from "../frontier-live-edge.js";
import type { RowIdentity, ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";

const rec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isList(v: unknown): v is { sessions: readonly Record<string, unknown>[]; next_cursor?: string | null } {
  return rec(v) && Array.isArray(v.sessions) && (v.next_cursor === undefined || v.next_cursor === null || typeof v.next_cursor === "string");
}
function isAttach(v: unknown): v is Record<string, unknown> & { session: Record<string, unknown> } {
  // Keep this predicate deliberately shallow. `buildOperatorViewModel` owns
  // malformed-event handling so a bad canonical event becomes a visible,
  // bounded diagnostic rather than dropping into the generic screen fallback.
  return rec(v) && rec(v.session) && typeof v.session.session_id === "string";
}
function isUnavailable(v: unknown): v is { availability: "unavailable"; reason: string } {
  return rec(v) && v.availability === "unavailable" && typeof v.reason === "string";
}

/** A "live session" is one still attachable — no terminal recorded. */
function isLiveRow(session: Record<string, unknown>): boolean {
  return session.attachable === true && (session.terminal === null || session.terminal === undefined);
}

function projectList(v: { sessions: readonly Record<string, unknown>[]; next_cursor?: string | null }): Omit<ScreenProjection, "variant"> {
  const live = v.sessions.filter(isLiveRow).slice(0, 200);
  const rows = live.map((s) => ({
    id: typeof s.session_id === "string" ? s.session_id : "?",
    connector: typeof s.connector_id === "string" ? s.connector_id : "?",
    state: typeof s.state === "string" ? s.state : "?",
    pending: typeof s.pending_steering === "number" ? String(s.pending_steering) : "0",
    sequence: typeof s.latest_sequence === "number" ? String(s.latest_sequence) : "?",
  }));
  return {
    screen: "live-session",
    caption: rows.length
      ? `Live sessions (${rows.length}) — select one and attach to steer or interrupt it turn-by-turn`
      : "No live sessions — start one with `arbor session start` and it appears here while it runs",
    rows,
    columns: [
      { key: "connector", title: "Connector", width: 14 },
      { key: "state", title: "State", width: 16 },
      { key: "pending", title: "Pending", width: 9 },
      { key: "sequence", title: "Seq", width: 6 },
    ],
    row_ids: rows.map((r) => r.id === "?" ? null : { id: r.id, context: { interruptible: "yes" } }),
  };
}

function terminalStatus(session: Record<string, unknown>, view: ReturnType<typeof buildOperatorViewModel>, live: boolean): string {
  const canonicalTerminal = view.document.find((row) => row.source === "canonical_session" && row.kind === "terminal");
  if (canonicalTerminal !== undefined) return `terminal (${canonicalTerminal.lifecycle})`;
  const terminal = rec(session.terminal) ? session.terminal : null;
  if (terminal !== null) {
    const state = typeof terminal.state === "string" ? terminal.state : typeof terminal.cause === "string" ? terminal.cause : "recorded";
    return `terminal (${state})`;
  }
  return live ? "live" : "not live";
}

function projectAttach(v: Record<string, unknown> & { session: Record<string, unknown> }, input: { width: number; height: number }): Omit<ScreenProjection, "variant"> {
  const sessionId = String(v.session.session_id);
  const live = v.live === true;
  const pending = typeof v.pending_steering === "number" && Number.isSafeInteger(v.pending_steering) && v.pending_steering >= 0 ? v.pending_steering : 0;
  const view = buildOperatorViewModel({
    session_attach: v,
    output_list: v.output_list,
    viewport: { columns: input.width, rows: input.height },
    // ScreenModule projection receives no clock. Freshness is not rendered
    // until composition supplies one; a deterministic value avoids inventing
    // a wall-clock observation in this pure screen leaf.
    now_ms: 0,
    limits: { max_rows: 200, max_detail_chars: 1_000, max_attention: 20 },
  });
  const state = terminalStatus(v.session, view, live);
  // Keep the canonical event as the event document, rather than flattening
  // it into a screen-local table schema. The shared renderer owns the event
  // silhouette, parentage, lifecycle, source/truth label, and bounded detail.
  const rows = view.document.map((event) => ({ event }));
  // A control acts on the owning session, while inspection/focus must retain
  // the precise canonical event. Both identities therefore remain available
  // without falsely making an event-scoped command target.
  const rowIds = view.document.map((event): RowIdentity => ({ id: sessionId, context: { attached_event_id: event.id } }));
  const action = state.startsWith("terminal")
    ? "terminal record retained; no active control is implied; Ctrl+S returns to the session list"
    : live
      ? "following live tail; Ctrl+S returns to the session list; steer and interrupt remain governed"
      : "await a canonical live-status update";
  return {
    screen: "live-session",
    // Keep the operator action on its own line. At standard widths the old
    // single caption clipped precisely the live-control/terminal-cleanup fact
    // an operator needed to distinguish active from settled work.
    caption: `Session ${sessionId}: ${state} · ${view.freshness.canonical_rows} canonical event(s) · ${view.attention.length} attention item(s) · ${pending} steering message(s) pending\n${action}`,
    rows,
    columns: [],
    row_ids: rowIds,
  };
}

function renderAttach(p: ScreenProjection, width: number, height: number, color: boolean, offset?: number, liveEdge?: FrontierLiveEdgeState): readonly string[] {
  const history = liveEdge?.mode === "scrollback" ? `HISTORY · ${liveEdge.unseen_meaningful_events} new · End return to live · ` : "";
  const captionLines = String(p.caption ?? "Live session").split("\n");
  if (history) captionLines[0] = `${history}${captionLines[0] ?? "Live session"}`;
  const renderedCaption = captionLines.flatMap((line) => wrapDisplay(line, width));
  const lines = [...renderedCaption];
  const availableLines = Math.max(0, height - lines.length);
  const renderedEvents = p.rows.map((row) => {
    const event = row.event;
    return typeof event === "object" && event !== null
      ? renderOperatorEvent(event as EventView, width, color, { max_detail_lines: 2, show_source: true })
      : [];
  });
  // Event documents have variable-height rows. At the live edge, select the
  // tail by rendered line count so richer event silhouettes cannot leave the
  // newest canonical events below the viewport.
  let start = offset === undefined ? renderedEvents.length : Math.min(Math.max(0, offset), renderedEvents.length);
  if (offset === undefined) {
    let used = 0;
    while (start > 0) {
      const next = renderedEvents[start - 1]!;
      if (used > 0 && used + next.length > availableLines) break;
      used += next.length;
      start -= 1;
      if (used >= availableLines) break;
    }
  }
  for (const eventLines of renderedEvents.slice(start)) {
    if (lines.length >= height) break;
    lines.push(...eventLines);
    if (lines.length >= height) break;
  }
  return lines.slice(0, height);
}

function render(p: ScreenProjection, width: number, height: number, color: boolean, offset?: number, selectedId?: string, liveEdge?: FrontierLiveEdgeState): readonly string[] {
  if (!p.rows.length) return [clipDisplay(p.caption ?? "No live sessions", width)];
  if (p.variant === "attach") return renderAttach(p, width, height, color === true, offset, liveEdge);
  return [
    clipDisplay(p.caption ?? "Live sessions", width),
    ...renderTable(p.rows, p.columns.map((c): TableColumn => ({ ...c, width: Math.min(c.width, Math.max(4, Math.floor(width / Math.max(1, p.columns.length)))) })), { height: Math.max(1, height - 1), offset, selected_id: selectedId, row_ids: p.row_ids }),
  ];
}

function projectUnavailable(v: { availability: "unavailable"; reason: string }): Omit<ScreenProjection, "variant"> {
  return {
    screen: "live-session",
    rows: [{ reason: v.reason }],
    columns: [{ key: "reason", title: "Reason", width: 80 }],
    caption: "Live session unavailable",
  };
}

function renderUnavailable(p: ScreenProjection, width: number): readonly string[] {
  const reason = String(p.rows[0]?.reason ?? "runtime did not provide a reason");
  return [
    clipDisplay(p.caption ?? "Live session unavailable", width),
    clipDisplay(`Reason: ${reason}`, width),
    clipDisplay("Recovery: reopen Live Session to refresh", width),
  ];
}

export const liveSessionScreen: ScreenModule = {
  id: "live-session" as ScreenId,
  title: "Live Session",
  required_capabilities: ["harness.session.read"],
  surface: {
    commands: ["harness.session.steer", "harness.session.interrupt"],
    queries: ["harness.session.list", "harness.session.attach", "output.list"],
  },
  ...buildScreenPipeline([
    defineVariant({ tag: "sessions", match: isList, project: projectList, render: (p, c) => render(p, c.width, c.height, c.color === true, c.scroll_offset, c.selected_id, c.live_edge) }),
    defineVariant({ tag: "attach", match: isAttach, project: projectAttach, render: (p, c) => render(p, c.width, c.height, c.color === true, c.scroll_offset, c.selected_id, c.live_edge) }),
    defineVariant({ tag: "unavailable", match: isUnavailable, project: projectUnavailable, render: (p, c) => renderUnavailable(p, c.width) }),
  ], { emptyProjection: () => ({ screen: "live-session", rows: [], columns: [{ key: "status", title: "Status", width: 20 }], caption: "Awaiting live session projection" }) }),
};
