/** Redacted durable native-harness session inventory and status projection. */
import { clipDisplay, renderTable } from "../widgets.js";
import type { TableColumn } from "../widgets.js";
import { buildOperatorViewModel } from "../operator-view-model.js";
import type { EventView } from "../operator-view-model.js";
import { renderOperatorEvent } from "../operator-event-render.js";
import type { RowIdentity, ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";
const rec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function isList(v: unknown): v is { sessions: readonly Record<string, unknown>[]; next_cursor?: string | null } { return rec(v) && Array.isArray(v.sessions) && (v.next_cursor === undefined || v.next_cursor === null || typeof v.next_cursor === "string"); }
function isInspect(v: unknown): v is Record<string, unknown> { return rec(v) && typeof v.session_id === "string" && typeof v.state === "string" && "latest_sequence" in v; }
function isEvents(v: unknown): v is { session_id: string; events: readonly Record<string, unknown>[] } { return rec(v) && typeof v.session_id === "string" && Array.isArray(v.events); }
function isAttach(v: unknown): v is { session: Record<string, unknown>; events: readonly Record<string, unknown>[]; live: boolean; pending_steering: number; next_after_sequence: number } { return rec(v) && rec(v.session) && typeof v.session.session_id === "string" && Array.isArray(v.events) && typeof v.live === "boolean" && typeof v.pending_steering === "number" && typeof v.next_after_sequence === "number"; }
function isUnavailable(v: unknown): v is { availability: "unavailable"; reason: string } { return rec(v) && v.availability === "unavailable" && typeof v.reason === "string"; }
function modelIdentity(value: unknown): { model: string; revision: string } {
  if (!rec(value) || typeof value.provider_id !== "string" || typeof value.model_id !== "string") return { model: "unreported", revision: "unreported" };
  const model = `${value.provider_id}/${value.model_id}`;
  if (typeof value.revision === "string" && value.revision.trim()) return { model, revision: `observed ${value.revision}` };
  if (typeof value.configured_revision === "string" && value.configured_revision.trim()) return { model, revision: `configured ${value.configured_revision}; unobserved` };
  return { model, revision: "unobserved / unpinned" };
}
function project(v: { sessions: readonly Record<string, unknown>[]; next_cursor?: string | null }): Omit<ScreenProjection, "variant"> {
  const rows = v.sessions.slice(0, 200).map((s) => {
    const identity = modelIdentity(s.model_identity);
    return { id: typeof s.session_id === "string" ? s.session_id : "?", connector: typeof s.connector_id === "string" ? s.connector_id : "?", execution: typeof s.execution_kind === "string" ? s.execution_kind : "?", profile: typeof s.profile_id === "string" ? s.profile_id : "?", model: identity.model, revision: identity.revision, state: typeof s.state === "string" ? s.state : "?", recovery: rec(s.recovery) && s.recovery.kind === "recovery_required" ? "required" : "—", sequence: typeof s.latest_sequence === "number" ? String(s.latest_sequence) : "?", terminal: rec(s.terminal) && typeof s.terminal.cause === "string" ? s.terminal.cause : "—", provenance: rec(s.terminal) && rec(s.terminal.provenance) && typeof s.terminal.provenance.tag === "string" ? s.terminal.provenance.tag : "—", diagnostics: Array.isArray(s.diagnostics) ? String(s.diagnostics.length) : "0" };
  });
  return { screen: "harness-sessions", caption: `Harness sessions (${rows.length})${v.next_cursor ? " · next page: command palette" : " · end of stable list"}`, rows, columns: [{ key: "id", title: "Session", width: 20 }, { key: "connector", title: "Connector", width: 14 }, { key: "execution", title: "Execution", width: 18 }, { key: "profile", title: "Profile", width: 18 }, { key: "model", title: "Model", width: 22 }, { key: "revision", title: "Revision", width: 24 }, { key: "state", title: "State", width: 16 }, { key: "recovery", title: "Recovery", width: 10 }, { key: "sequence", title: "Seq", width: 6 }, { key: "terminal", title: "Terminal", width: 14 }, { key: "provenance", title: "Prov", width: 10 }, { key: "diagnostics", title: "Diag", width: 5 }], row_ids: rows.map((r) => r.id === "?" ? null : { id: r.id, context: { interruptible: r.terminal === "—" ? "yes" : "no" } }) };
}

function sessionListColumns(projection: ScreenProjection, width: number): readonly TableColumn[] {
  const narrow = ["id", "state"];
  const compact = ["id", "model", "state", "recovery"];
  const regular = ["id", "connector", "model", "state", "recovery", "terminal"];
  const preferred = width < 58 ? narrow : width < 92 ? compact : width < 132 ? regular : projection.columns.map((column) => column.key);
  const byKey = new Map(projection.columns.map((column) => [column.key, column]));
  const selected = preferred.flatMap((key) => {
    const column = byKey.get(key);
    return column === undefined ? [] : [column];
  });
  // Reserve the inter-column spaces first, then give every visible field an
  // equal width. This guarantees a session row fits the terminal geometry;
  // the status/model fields remain reachable through the selected session's
  // inspect view when the terminal cannot fit the full inventory.
  const columns = selected.filter((_column, index) => width - (selected.length - 1) >= (index + 1) * 4 + (selected.length - 1));
  const safeColumns = columns.length > 0 ? columns : selected.slice(0, 1);
  const cellWidth = Math.max(1, Math.floor((width - Math.max(0, safeColumns.length - 1)) / safeColumns.length));
  return safeColumns.map((column) => ({ ...column, width: Math.max(1, Math.min(column.width, cellWidth)) }));
}
function inspectProject(v: Record<string, unknown>): Omit<ScreenProjection, "variant"> {
  const terminal = rec(v.terminal) ? v.terminal : null;
  const recovery = rec(v.recovery) ? v.recovery : null;
  const recoveryValue = recovery?.kind === "recovery_required"
    ? `required — no automatic replay (${String(recovery.reason ?? "checkpoint incomplete")})`
    : "not required";
  const toolAudits = Array.isArray(v.tool_audits) ? v.tool_audits.filter(rec) : [];
  const artifacts = Array.isArray(v.artifacts) ? v.artifacts.filter(rec) : [];
  const latestArtifact = artifacts.at(-1);
  const latestToolAudit = toolAudits.at(-1);
  const identity = modelIdentity(v.model_identity);
  const availability = (kind: string): string => {
    const continuations = rec(v.continuations) ? v.continuations : rec(v.continuation) ? v.continuation : null;
    const candidate = continuations?.[kind] ?? v[`${kind}_availability`];
    if (candidate === true || (rec(candidate) && (candidate.available === true || candidate.availability === "available"))) return "available";
    if (rec(candidate) && typeof candidate.reason === "string") return `unavailable: ${candidate.reason}`;
    return "unavailable: not advertised";
  };
  const rows = [
    { field: "Session", value: String(v.session_id) }, { field: "State", value: String(v.state) },
    { field: "Connector", value: String(v.connector_id ?? "revoy-native") }, { field: "Execution", value: String(v.execution_kind ?? "?") }, { field: "Profile", value: String(v.profile_id ?? "?") },
    { field: "Provider/model", value: identity.model }, { field: "Model revision", value: identity.revision },
    { field: "Latest sequence", value: String(v.latest_sequence) }, { field: "Recovery", value: recoveryValue }, { field: "Terminal", value: terminal === null ? "—" : String(terminal.cause ?? "?") },
    { field: "Tool audit records", value: String(toolAudits.length) }, { field: "Latest tool outcome", value: latestToolAudit === undefined ? "—" : `${String(latestToolAudit.outcome ?? "?")} / ${String(latestToolAudit.effect ?? "?")}` },
    { field: "Latest action scope", value: latestToolAudit === undefined || !rec(latestToolAudit.action_scope) ? "—" : String(latestToolAudit.action_scope.status ?? "?") },
    { field: "Evidence manifests", value: String(artifacts.length) },
    { field: "Latest evidence artifact", value: latestArtifact === undefined ? "—" : `${String(latestArtifact.artifact_id ?? "?")} (${String(latestArtifact.storage ?? "?")})` },
    { field: "Artifact continuation", value: "not supported — fresh admission required" },
    { field: "Resume", value: availability("resume") }, { field: "Fork", value: availability("fork") }, { field: "Respawn", value: availability("respawn") },
  ];
  return { screen: "harness-sessions", caption: `Harness session ${String(v.session_id)}`, rows, columns: [{ key: "field", title: "Field", width: 18 }, { key: "value", title: "Value", width: 54 }], row_ids: rows.map(() => null) };
}
function eventsProject(v: { session_id: string; events: readonly Record<string, unknown>[] }): Omit<ScreenProjection, "variant"> {
  const rows = v.events.slice(0, 200).map((event) => ({ sequence: String(event.sequence ?? "?"), kind: String(event.kind ?? "?"), at: String(event.occurred_at ?? "?"), payload: JSON.stringify(event.payload ?? { redacted: true }) }));
  return { screen: "harness-sessions", caption: `Redacted events for ${v.session_id} (${rows.length})`, rows, columns: [{ key: "sequence", title: "Seq", width: 6 }, { key: "kind", title: "Kind", width: 20 }, { key: "at", title: "At", width: 24 }, { key: "payload", title: "Payload", width: 38 }], row_ids: rows.map(() => null) };
}
function attachProject(
  v: { session: Record<string, unknown>; events: readonly Record<string, unknown>[]; live: boolean; pending_steering: number; next_after_sequence: number },
  input: { width: number; height: number },
): Omit<ScreenProjection, "variant"> {
  const sessionId = String(v.session.session_id);
  const terminal = rec(v.session.terminal) ? v.session.terminal : null;
  const state = terminal === null ? (v.live ? "live" : "not live") : `terminal (${String(terminal.cause ?? "recorded")})`;
  // Attached events are canonical native-session evidence. Project them with
  // the shared operator grammar, not the raw kind/payload table used by the
  // separate durable-events inspection route. That keeps parentage,
  // lifecycle, actor, bounded detail, and truth/source identity visible
  // without giving this screen a second event model.
  const view = buildOperatorViewModel({
    session_attach: v,
    viewport: { columns: input.width, rows: input.height },
    now_ms: 0,
    limits: { max_rows: 200, max_detail_chars: 1_000, max_attention: 20 },
  });
  const rows = view.document.map((event) => ({ event }));
  // The attached event is canonically identified, but its available controls
  // (inspect/steer/interrupt) target its owning session. Keep that valid
  // session identity as the actionable row id and retain the exact event id
  // in context for stable focus and future event-scoped inspection.
  const rowIds = view.document.map((event): RowIdentity => ({ id: sessionId, context: { attached_event_id: event.id } }));
  return {
    screen: "harness-sessions",
    caption: `Attached ${sessionId}: ${state}; ${view.freshness.canonical_rows} canonical event(s), ${view.attention.length} attention item(s), next cursor ${v.next_after_sequence}, pending steering ${v.pending_steering}`,
    rows,
    columns: [],
    row_ids: rowIds,
  };
}
function renderAttach(p: ScreenProjection, width: number, height: number, color: boolean, offset?: number): readonly string[] {
  const lines = [clipDisplay(p.caption ?? "Attached harness session", width)];
  const bodyHeight = Math.max(0, height - lines.length);
  const start = offset === undefined
    ? Math.max(0, p.rows.length - Math.max(1, bodyHeight))
    : Math.min(Math.max(0, offset), p.rows.length);
  for (const row of p.rows.slice(start)) {
    if (lines.length >= height) break;
    const event = row.event;
    if (typeof event !== "object" || event === null) continue;
    lines.push(...renderOperatorEvent(event as EventView, width, color, { max_detail_lines: 2, show_source: true }));
  }
  return lines.slice(0, height);
}
/**
 * The session *inventory* needs a width-aware column subset so a wide row
 * cannot overflow a compact terminal. Every other variant declares the columns
 * its own rows actually carry: the events projection has no id/state/connector
 * fields and the inspect projection has no id at all, so applying the inventory
 * policy to them selected zero columns and renderTable threw.
 */
function variantColumns(projection: ScreenProjection, width: number): readonly TableColumn[] {
  if (projection.variant === "sessions") return sessionListColumns(projection, width);
  return projection.columns.map((column): TableColumn => ({ ...column, width: Math.min(column.width, Math.max(4, Math.floor(width / Math.max(1, projection.columns.length)))) }));
}
function render(p: ScreenProjection, width: number, height: number, color: boolean, offset?: number, selectedId?: string): readonly string[] { if (!p.rows.length) return [clipDisplay(p.caption ?? "No durable harness sessions", width)]; if (p.variant === "attach") return renderAttach(p, width, height, color, offset); try { return [clipDisplay(p.caption ?? "Harness sessions", width), ...renderTable(p.rows, variantColumns(p, width), { height: Math.max(1, height - 1), offset, selected_id: selectedId, row_ids: p.row_ids, line_width: width })]; } catch { return [clipDisplay("(render error)", width)]; } }
export const harnessSessionsScreen: ScreenModule = { id: "harness-sessions" as ScreenId, title: "Harness Sessions", required_capabilities: ["harness.session.read"], surface: {
  commands: ["harness.session.interrupt", "harness.session.steer", "harness.session.resume", "harness.session.fork", "harness.session.respawn"],
  // Continuation availability is composed into the Console aggregate. This
  // screen does not falsely declare a standalone query it never issues; an
  // inspect response may still carry producer-advertised continuation facts.
  queries: ["harness.session.list", "harness.session.inspect", "harness.session.events", "harness.session.attach"],
}, ...buildScreenPipeline([
  defineVariant({ tag: "sessions", match: isList, project, render: (p, c) => render(p, c.width, c.height, c.color === true, c.scroll_offset, c.selected_id) }),
  defineVariant({ tag: "inspect", match: isInspect, project: inspectProject, render: (p, c) => render(p, c.width, c.height, c.color === true, c.scroll_offset, c.selected_id) }),
  defineVariant({ tag: "events", match: isEvents, project: eventsProject, render: (p, c) => render(p, c.width, c.height, c.color === true, c.scroll_offset, c.selected_id) }),
  defineVariant({ tag: "attach", match: isAttach, project: (v, input) => attachProject(v, input), render: (p, c) => render(p, c.width, c.height, c.color === true, c.scroll_offset, c.selected_id) }),
  defineVariant({ tag: "unavailable", match: isUnavailable, project: (v) => ({ screen: "harness-sessions", rows: [], columns: [{ key: "status", title: "Status", width: 20 }], caption: `Harness sessions unavailable: ${v.reason}` }), render: (p, c) => [clipDisplay(p.caption ?? "Harness sessions unavailable", c.width)] }),
], { emptyProjection: () => ({ screen: "harness-sessions", rows: [], columns: [{ key: "status", title: "Status", width: 20 }], caption: "Awaiting harness session projection" }) }) };
