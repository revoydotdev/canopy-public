/**
 * M7 interaction policy.
 *
 * This module contains the small, renderer-independent policies that keep the
 * cockpit terse while retaining operator truth: background work is folded by
 * stable identity, turn summaries always expose urgent outcomes, contextual
 * menus reuse the input catalogue, and reading anchors survive refreshes.
 * Nothing here owns execution or grants authority.
 */

import type { InputCatalog, UiAction } from "./input-catalog.js";
import type { AppModel } from "./types.js";
import { semanticGlyph } from "./theme.js";

export type BackgroundStatusKind = "active" | "waiting" | "approval" | "failure" | "success" | "blocked" | "idle";

export interface BackgroundStatus {
  readonly id: string;
  readonly label: string;
  readonly kind: BackgroundStatusKind;
  readonly detail?: string;
  readonly updated_at?: number;
}

export interface BackgroundStatusSummary {
  readonly rows: readonly BackgroundStatus[];
  readonly counts: Readonly<Record<BackgroundStatusKind, number>>;
  readonly urgent: boolean;
  readonly line: string;
}

const STATUS_ORDER: readonly BackgroundStatusKind[] = ["failure", "approval", "blocked", "active", "waiting", "success", "idle"];

function shape(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}

function rows(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  const source = shape(value);
  if (source === null) return [];
  return ["items", "records", "tasks", "jobs", "sessions", "requests"].flatMap((key) => Array.isArray(source[key]) ? source[key].flatMap((item) => shape(item) === null ? [] : [shape(item)!]) : []);
}

/** Project the live Console screen into the bounded status aggregator. */
export function backgroundStatusesFromModel(app: AppModel): readonly BackgroundStatus[] {
  const console = shape(app.screens.get("console"));
  if (console === null) return [];
  const result: BackgroundStatus[] = [];
  for (const [field, label] of [["tasks", "task"], ["jobs", "job"], ["sessions", "session"]] as const) {
    for (const item of rows(console[field])) {
      const id = typeof item.id === "string" ? item.id : typeof item.task_id === "string" ? item.task_id : typeof item.job_id === "string" ? item.job_id : null;
      if (id === null) continue;
      const state = String(item.state ?? item.status ?? "idle").toLowerCase();
      const kind: BackgroundStatusKind = state.includes("fail") || state.includes("error") || state.includes("reject") ? "failure"
        : state.includes("approv") || state.includes("question") || state.includes("clarif") ? "approval"
        : state.includes("block") ? "blocked"
        : ["running", "active", "starting", "expanding", "planning", "queued", "accepted"].includes(state) ? "active"
        : ["waiting", "pending", "retrying"].includes(state) ? "waiting"
        : ["completed", "succeeded", "verified", "done"].includes(state) ? "success" : "idle";
      result.push({ id, label: `${label} ${id.slice(-12)}`, kind, detail: typeof item.reason === "string" ? item.reason : undefined });
    }
  }
  return result;
}

/** The terse live row used by the renderer for urgent background work. */
export function backgroundStatusLine(app: AppModel, width = 96): string | null {
  const summary = aggregateBackgroundStatus(backgroundStatusesFromModel(app), { max_rows: 3, width });
  return summary.urgent ? summary.line : null;
}

/** Compact turn-boundary projection for a terminal session, shown by the live status row. */
export function turnBoundaryLine(app: AppModel, width = 96): string | null {
  const console = shape(app.screens.get("console"));
  const attach = console === null ? null : shape(console.session_attach);
  const session = attach === null ? null : shape(attach.session);
  const terminal = session === null ? null : shape(session.terminal);
  if (terminal === null) return null;
  const cause = String(terminal.cause ?? terminal.state ?? "unknown").toLowerCase();
  const outcome: TurnOutcome = cause === "completed" || cause === "succeeded" ? "completed"
    : cause === "failed" ? "failed" : cause === "interrupted" ? "blocked" : "unknown";
  const summary = summarizeTurnBoundary({
    outcome,
    changes: typeof terminal.summary === "string" ? [terminal.summary] : undefined,
    verification: typeof terminal.verification === "string" ? [terminal.verification] : undefined,
    blocker: outcome === "failed" || outcome === "blocked" ? String(terminal.reason ?? terminal.message ?? "review the terminal result") : undefined,
  });
  return clean(summary.join(" · "), width);
}

function clean(value: string, limit: number): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").trim().slice(0, limit);
}

/** Fold repeated background updates without changing row order on every tick. */
export function aggregateBackgroundStatus(input: readonly BackgroundStatus[], options: { readonly max_rows?: number; readonly width?: number } = {}): BackgroundStatusSummary {
  const latest = new Map<string, BackgroundStatus>();
  const order: string[] = [];
  for (const item of input) {
    const id = clean(item.id, 160);
    if (id === "") continue;
    if (!latest.has(id)) order.push(id);
    latest.set(id, { ...item, id, label: clean(item.label, 80), ...(item.detail === undefined ? {} : { detail: clean(item.detail, 240) }) });
  }
  const rows = order.map((id) => latest.get(id)!).sort((left, right) => {
    const priority = STATUS_ORDER.indexOf(left.kind) - STATUS_ORDER.indexOf(right.kind);
    return priority || order.indexOf(left.id) - order.indexOf(right.id);
  });
  const counts = Object.fromEntries(STATUS_ORDER.map((kind) => [kind, rows.filter((row) => row.kind === kind).length])) as Record<BackgroundStatusKind, number>;
  const maxRows = options.max_rows ?? 4;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 32) throw new Error("max_rows must be from 1 to 32");
  const visible = rows.slice(0, maxRows);
  const suffix = rows.length > visible.length ? ` +${rows.length - visible.length} more` : "";
  const line = clean(visible.map((row) => `${row.label}:${row.kind}`).join(" · ") + suffix, options.width ?? 240);
  return Object.freeze({ rows: Object.freeze(visible), counts: Object.freeze(counts), urgent: counts.failure > 0 || counts.approval > 0 || counts.blocked > 0, line });
}

export type TurnOutcome = "completed" | "failed" | "waiting" | "blocked" | "running" | "unknown";
export interface TurnBoundaryInput {
  readonly outcome: TurnOutcome;
  readonly changes?: readonly string[];
  readonly verification?: readonly string[];
  readonly approval_needed?: string;
  readonly blocker?: string;
  readonly evidence?: readonly string[];
}

/**
 * Deterministic 3–8 line turn summary. Failure, approval, and blockers are
 * mandatory when present; compactness never erases an urgent operator choice.
 */
export function summarizeTurnBoundary(input: TurnBoundaryInput): readonly string[] {
  const lines: string[] = [`Outcome: ${input.outcome}`];
  const append = (label: string, values: readonly string[] | undefined, limit: number): void => {
    const useful = (values ?? []).map((value) => clean(value, 220)).filter(Boolean).slice(0, limit);
    for (const value of useful) lines.push(`${label}: ${value}`);
  };
  append("Changed", input.changes, 2);
  append("Verified", input.verification, 2);
  append("Evidence", input.evidence, 1);
  if (input.approval_needed !== undefined && clean(input.approval_needed, 220) !== "") lines.push(`Approval needed: ${clean(input.approval_needed, 220)}`);
  if (input.blocker !== undefined && clean(input.blocker, 220) !== "") lines.push(`Blocker: ${clean(input.blocker, 220)}`);
  return Object.freeze(lines.slice(0, 8));
}

export interface ReadingAnchor { readonly item_id: string; readonly offset: number; readonly selected: boolean; }
export interface ReadingAnchorResult { readonly anchor: ReadingAnchor | null; readonly newer_available: boolean; }

/** Keep the selected document and offset stable across background refreshes. */
export function preserveReadingAnchor(anchor: ReadingAnchor | null, refreshedIds: readonly string[], previousIds: readonly string[] = []): ReadingAnchorResult {
  if (anchor === null) return { anchor: null, newer_available: false };
  const index = refreshedIds.indexOf(anchor.item_id);
  if (index >= 0) return { anchor, newer_available: refreshedIds.length > previousIds.length && index < refreshedIds.length - 1 };
  if (refreshedIds.length === 0) return { anchor: null, newer_available: false };
  const oldIndex = Math.max(0, previousIds.indexOf(anchor.item_id));
  const fallback = refreshedIds[Math.min(oldIndex, refreshedIds.length - 1)]!;
  return { anchor: { ...anchor, item_id: fallback, offset: 0 }, newer_available: refreshedIds.length > previousIds.length };
}

export interface ReaderFocusSnapshot { readonly zone: string; readonly rail_tab: string; readonly selection_id: string | null; }

/** Closing a reader returns the exact pre-reader focus/selection snapshot. */
export function restoreReaderFocus(snapshot: ReaderFocusSnapshot, current: ReaderFocusSnapshot): ReaderFocusSnapshot {
  return { zone: snapshot.zone, rail_tab: snapshot.rail_tab, selection_id: snapshot.selection_id ?? current.selection_id };
}

export interface ContextMenuItem {
  readonly action_id: string;
  readonly title: string;
  readonly keys: readonly string[];
  readonly enabled: boolean;
  readonly reason: string;
}

/** Context menus are a projection of the same catalogue used by keyboard/palette routing. */
export function contextMenuItems(catalog: InputCatalog, actionIds: readonly string[], options: { readonly authorized?: readonly string[]; readonly disabled?: Readonly<Record<string, string>> } = {}): readonly ContextMenuItem[] {
  const selected = new Set(actionIds);
  const authorized = options.authorized === undefined ? null : new Set(options.authorized);
  return Object.freeze(catalog.actions.filter((action) => selected.has(action.id)).map((action) => {
    const bindings = action.bindings.filter((binding) => binding.keys.length > 0).flatMap((binding) => [binding.keys.join(" ")]);
    const denied = options.disabled?.[action.id] ?? (authorized !== null && !authorized.has(action.id) ? "authorization is not available in the current state" : undefined);
    return { action_id: action.id, title: action.title, keys: Object.freeze([...new Set(bindings)]), enabled: denied === undefined, reason: denied ?? action.discovery?.authority ?? "available through the governed action registry" };
  }));
}

/** Semantic tokens are labels/glyphs first; color is an optional enhancement. */
export const M7_THEME_TOKENS = Object.freeze({
  neutral: { label: "neutral", glyph: semanticGlyph("muted", true) },
  active: { label: "active", glyph: semanticGlyph("active", true) },
  success: { label: "success", glyph: semanticGlyph("success", true) },
  waiting: { label: "waiting", glyph: semanticGlyph("waiting", true) },
  failure: { label: "failure", glyph: semanticGlyph("failure", true) },
  selection: { label: "selected", glyph: semanticGlyph("selection", true) },
  focus: { label: "focused", glyph: semanticGlyph("focus", true) },
} as const);

export type { UiAction };
