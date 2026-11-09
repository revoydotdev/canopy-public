/**
 * Review-safe remote-session lifecycle projection. The local runtime owns the
 * authority; this screen only reads its bounded, public-key-free status view.
 * Enrollment, rotation and revocation forms remain typed unavailable until a
 * campaign-control adapter can author their full authority-bearing envelopes.
 */
import { clipDisplay, renderTable } from "../widgets.js";
import type { TableColumn } from "../widgets.js";
import type { RowIdentity, ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";

const MAX_ROWS = 100;
/** Honest operational boundary: no counter or health query means no invented green state. */
export const TRUST_OPERATIONS_UNAVAILABLE = "Quota limits, replay-denial counters, and transport health are not projected by the typed catalog; no public listener is configured. Durable receipt state is in Parent/Child Threads; remote attribution evidence is in Evidence Ledger.";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function isSessionList(value: unknown): value is { sessions: readonly Record<string, unknown>[]; total: number } {
  return isRecord(value) && Array.isArray(value.sessions) && typeof value.total === "number";
}
function isSessionStatus(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.session_id === "string" && typeof value.state === "string";
}

function projectSessions(value: { sessions: readonly Record<string, unknown>[]; total: number }): Omit<ScreenProjection, "variant"> {
  const sessions = value.sessions.slice(0, MAX_ROWS);
  return {
    screen: "trust",
    caption: sessions.length === 0
      ? "No enrolled remote sessions. Use Enroll Remote Trust to add a host-issued certificate/key binding."
      : `Remote sessions (${sessions.length} of ${value.total}) · lifecycle-only view · ${TRUST_UNAVAILABLE}`,
    columns: [
      { key: "session", title: "Session", width: 20 }, { key: "actor", title: "Actor", width: 18 },
      { key: "state", title: "State", width: 10 }, { key: "expires", title: "Expires", width: 20 },
      { key: "edges", title: "Edges", width: 8 }, { key: "approval", title: "Approval", width: 10 },
      { key: "rotation", title: "Rotation", width: 14 }, { key: "revoked", title: "Revoked", width: 20 },
      { key: "key", title: "Key", width: 18 },
    ],
    rows: sessions.map((session) => ({
      session: typeof session.session_id === "string" ? session.session_id : "?",
      actor: typeof session.actor_id === "string" ? session.actor_id : "?",
      state: typeof session.state === "string" ? session.state : "?",
      expires: typeof session.expires_at === "string" ? session.expires_at : "?",
      edges: Array.isArray(session.thread_audiences) ? session.thread_audiences.length : "?",
      approval: session.approval_authority === true ? "granted" : "denied",
      rotation: Array.isArray(session.revoked_key_ids) ? `${session.revoked_key_ids.length} prior key(s)` : "not projected",
      revoked: typeof session.revoked_at === "string" ? session.revoked_at : "—",
      // This deliberately projects a key id only — never the enrolled PEM.
      key: typeof session.key_id === "string" ? session.key_id : "?",
    })),
    row_ids: sessions.map((session): RowIdentity | null => typeof session.session_id === "string" ? { id: session.session_id } : null),
  };
}

function projectSessionStatus(session: Record<string, unknown>): Omit<ScreenProjection, "variant"> {
  const audiences = Array.isArray(session.thread_audiences) ? session.thread_audiences.length : "not projected";
  const revokedKeys = Array.isArray(session.revoked_key_ids) ? session.revoked_key_ids.length : "not projected";
  const fields: ReadonlyArray<readonly [string, unknown]> = [
    ["Session", session.session_id], ["Actor", session.actor_id], ["State", session.state],
    ["Key id", session.key_id], ["Expires", session.expires_at], ["Revoked", session.revoked_at ?? "—"],
    ["Thread audiences", audiences], ["Approval authority", session.approval_authority === true ? "granted" : "denied"],
    ["Prior revoked keys", revokedKeys],
  ];
  return {
    screen: "trust",
    caption: `Remote trust status ${String(session.session_id)} · canonical trust.session.status · redacted lifecycle view`,
    columns: [{ key: "field", title: "Field", width: 24 }, { key: "value", title: "Value", width: 70 }],
    rows: fields.map(([field, value]) => ({ field, value: typeof value === "string" || typeof value === "number" ? value : "not projected" })),
    row_ids: fields.map(() => null),
  };
}

function render(projection: ScreenProjection, width: number, height: number, offset?: number): readonly string[] {
  // This is the production empty-state path for the Remote Trust screen. It
  // states the authoring prerequisite instead of letting the shared generic
  // empty renderer imply a mutable trust surface exists.
  if (projection.rows.length === 0) {
    return projection.variant === "sessions"
      ? [clipDisplay("No enrolled remote sessions", width), clipDisplay("Use Enroll Remote Trust to add a host-issued certificate/key binding.", width)]
      : [clipDisplay("No remote trust projection", width)];
  }
  const perColumn = Math.max(1, Math.floor((width - (projection.columns.length - 1)) / projection.columns.length));
  const columns: TableColumn[] = projection.columns.map((column) => ({ ...column, width: Math.min(column.width, perColumn) }));
  try { return [clipDisplay(projection.caption ?? "Remote Trust", width), clipDisplay(TRUST_OPERATIONS_UNAVAILABLE, width), ...renderTable(projection.rows, columns, { height: Math.max(1, height - 1), offset })]; }
  catch { return [clipDisplay("(render error)", width)]; }
}

export const trustScreen: ScreenModule = {
  id: "trust" as ScreenId,
  title: "Remote Trust",
  required_capabilities: ["trust.session.read", "trust.session.write"],
  surface: { commands: ["trust.session.enroll", "trust.session.rotate", "trust.session.revoke"], queries: ["trust.session.list", "trust.session.status"] },
  ...buildScreenPipeline([
    defineVariant({ tag: "sessions", match: isSessionList, project: projectSessions, render: (p, c) => render(p, c.width, c.height, c.scroll_offset) }),
    defineVariant({ tag: "status", match: isSessionStatus, project: projectSessionStatus, render: (p, c) => render(p, c.width, c.height, c.scroll_offset) }),
  ], {
    emptyProjection: () => ({ screen: "trust", rows: [], columns: [{ key: "session", title: "Session", width: 20 }], caption: "No remote trust projection. Enroll a host-issued binding to begin." }),
    shortCircuitEmptyRows: false,
  }),
};

export const TRUST_UNAVAILABLE = "Trust controls are available when the runtime grants trust.session.write.";
