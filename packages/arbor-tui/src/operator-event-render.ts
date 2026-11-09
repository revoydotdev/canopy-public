/**
 * Shared bounded rendering for an OperatorViewModel event.
 *
 * This is presentation only: lifecycle, parentage, source identity, output
 * detail, and action eligibility remain facts supplied by operator-view-model.
 * Keeping it here lets ordinary command/history surfaces use the same grammar
 * as the Console without creating a second event model.
 */

import { ANSI } from "./player-piano.js";
import { deriveTheme, toForegroundSgr, type RunTheme, type ColorMode } from "./theme.js";
import type { EventView } from "./operator-view-model.js";
import { clipDisplay, displayWidth, wrapDisplay } from "./widgets.js";

export interface OperatorEventRenderOptions {
  readonly theme?: RunTheme;
  readonly color_mode?: ColorMode;
  /** Conversation view; exact identities remain in the event and detail inspector. */
  readonly compact?: boolean;
  /** Detail remains bounded by the view model; this bounds only visible rows. */
  readonly max_detail_lines?: number;
  /** Command History needs the durable source label even in its compact mode. */
  readonly show_source?: boolean;
}

const THEME = deriveTheme(undefined);

function tone(event: EventView): "success" | "warning" | "danger" | "muted" | "accent" | "info" {
  if (event.failure?.level === "session" || event.lifecycle === "interrupted") return "danger";
  if (event.lifecycle === "failed") return "warning";
  if (event.importance === "attention" || event.lifecycle === "pending") return "warning";
  if (event.lifecycle === "active") return "accent";
  if (event.kind === "tool" || event.kind === "tool_result") return "info";
  if (event.lifecycle === "completed") return "success";
  return "muted";
}

function toneSgr(value: ReturnType<typeof tone>, options: OperatorEventRenderOptions): string {
  return toForegroundSgr((options.theme ?? THEME).colors[value], options.color_mode);
}

function glyph(event: EventView): string {
  if (event.lifecycle === "failed") return "!";
  if (event.lifecycle === "interrupted") return "×";
  if (event.kind === "tool") return "│";
  if (event.kind === "tool_result") return "└";
  if (event.form === "file_read") return "R";
  if (event.form === "file_write") return "W";
  if (event.form === "patch_diff") return "Δ";
  if (event.form === "search_results") return "⌕";
  if (event.form === "shell_command") return "$";
  if (event.form === "verification_result") return "T";
  if (event.form === "retry") return "↻";
  if (event.form === "session_notification") return "i";
  if (event.kind === "artifact") return "Δ";
  if (event.kind === "permission_gate") return "?";
  if (event.kind === "cancellation") return "■";
  if (event.lifecycle === "completed") return "✓";
  return event.visual.marker;
}

function formLabel(event: EventView): string {
  switch (event.form) {
    case "file_read": return "file read";
    case "file_write": return "file write";
    case "patch_diff": return "patch/diff";
    case "search_results": return "search results";
    case "shell_command": return "shell command";
    case "verification_result": return "verification result";
    case "retry": return "retry";
    case "session_notification": return "session notification";
    case "generic": return event.kind.replaceAll("_", " ");
  }
}

/** Render a truthful, cell-bounded event silhouette with optional detail. */
export function renderOperatorEvent(
  event: EventView,
  width: number,
  color: boolean,
  options: OperatorEventRenderOptions = {},
): readonly string[] {
  const source = event.truth === "canonical" ? `canonical/${event.source}:${event.source_id}` : event.truth === "supplemental" ? `supplemental/${event.source}:${event.source_id}` : `unavailable/${event.source}:${event.source_id}`;
  const consequentialDetail = event.detail !== null && event.detail !== event.summary
    && ["tool", "tool_result", "permission_gate", "cancellation", "diagnostic", "terminal", "artifact", "test", "status"].includes(event.kind)
    ? event.detail
    : null;
  const failureDetail = event.failure === null ? null
    : `${event.failure.level} failure · ${event.failure.classification}`
      + `${event.failure.stage === null ? "" : ` · stage ${event.failure.stage}`}`
      + `${event.failure.effect === null ? "" : ` · effect ${event.failure.effect}`}`
      + ` · retry safety ${event.failure.retry_safe === null ? "not reported" : event.failure.retry_safe ? "reported safe" : "reported unsafe"}`
      + ` · wider task ${event.failure.wider_task_running === null ? "not reported" : event.failure.wider_task_running ? "running" : "not running"}`;
  const label = formLabel(event);
  const parent = event.parent_id === null ? "" : ` · ↳ ${event.parent_id}`;
  const retry = event.retry === null ? "" : ` · ↻ retry${event.retry.attempt === null ? "" : ` #${event.retry.attempt}`} of ${event.retry.previous_operation_id}`;
  const stale = event.stale ? " · history" : "";
  const action = event.actions.find((candidate) => candidate.enabled);
  const actionHint = action === undefined ? "" : ` · ${action.label}`;
  const sourceLabel = options.show_source === false ? "" : ` · ${source}`;
  const compactSource = event.source === "canonical_session" && event.truth === "canonical"
    ? "" : ` · ${event.truth}/${event.source}`;
  const compactState = event.kind === "tool" || event.kind === "tool_result" ? ` · ${event.lifecycle}` : "";
  const primary = options.compact === true
    ? `${glyph(event)} ${event.summary}${compactState}${stale}${compactSource}${actionHint}`
    : `${event.parent_id === null ? "" : "  "}${glyph(event)} ${event.summary}${parent}${retry} · ${event.lifecycle}${stale} · ${label} · ${event.actor}${sourceLabel}${actionHint}`;
  const primaryLines = wrapDisplay(primary, width).slice(0, 2);
  const joinedDetail = [consequentialDetail, options.compact === true ? null : failureDetail].filter((value): value is string => value !== null).join("\n");
  const detailLines = joinedDetail.length === 0 ? []
    : wrapDisplay(joinedDetail, Math.max(1, width - 2))
      .slice(0, Math.max(0, options.max_detail_lines ?? 2))
      .map((line) => `  ${line}`);
  const wrapped = [...primaryLines, ...detailLines];
  return wrapped.map((line, index) => {
    const value = index === 0 || line.startsWith("  ") ? line : `  ${line}`;
    const clipped = clipDisplay(value, width);
    // Scene composition cannot infer the printable width of an SGR-wrapped
    // string. Pad before applying color so pane borders remain aligned and
    // the colored/no-color renderings retain identical terminal cells.
    const padded = clipped + " ".repeat(Math.max(0, width - displayWidth(clipped)));
    return color ? `${toneSgr(tone(event), options)}${padded}${ANSI.reset}` : padded;
  });
}
