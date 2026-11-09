/**
 * Command History screen — bounded bash/tool history on demand, `Shift+D` (ADR-121/ADR-020).
 *
 * WHY THIS EXISTS. The operator's complaint was concrete: unlike Codex or
 * Claude Code, this cockpit had zero UI representation of commands being
 * run, and no on-demand keystroke to see full command history with output
 * and exit codes. `narration.ts`'s live activity line now surfaces a terse
 * one-liner per command as it happens (ADR-121's "narrates, not echoes"
 * discipline — never fabricated progress, only real events), but a terse
 * line is deliberately lossy: it clips a long command and cannot show
 * output at all. This screen is the other half — a bounded, scrollable
 * record an operator opens on demand. Full raw bytes remain governed by the
 * canonical output-descriptor/retrieval path when that authority exists.
 *
 * It is NOT a second data source. It reuses the exact same `devtools.stream`
 * query `devtools.ts` already owns and issues on focus — the runtime has
 * emitted `loop.tool_call` lines since before this file existed (see
 * `opencode-executor.ts`'s critic/specialist dispatch calls); this screen
 * simply projects the SAME stream filtered down to command rows, rendered
 * for reading instead of scanning. `opencode-event-stream.ts`'s parser (once
 * wired into `opencode-executor.ts`) is what turns a `loop.tool_call` line
 * from a single harness-level dispatch record into one row per real command
 * the agent ran — this screen renders whatever shape actually arrives,
 * degrading gracefully on the older, coarser dispatch-only lines (no
 * `exit`/`command` fields) exactly as it does on the richer per-command ones.
 *
 * Reuses `player-piano.ts`'s existing event-class vocabulary
 * (`eventKindClass`/`eventClassColor`) rather than inventing a parallel
 * scheme — the "command" class added there is the same tone `narration.ts`
 * uses for its terse line, so the live line and this full history can never
 * disagree about what counts as a command.
 */
import { clipDisplay } from "../widgets.js";
import type { RowIdentity, ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";
import { emptyCaption, unrecognisedCaption } from "./empty-state.js";
import { isDevToolsStreamShape, type DevToolsStreamShape } from "../player-piano.js";
import { buildOperatorViewModel, type EventView } from "../operator-view-model.js";
import { renderOperatorEvent } from "../operator-event-render.js";

/** Hard cap on retained history rows — never unbounded growth (mirrors devtools.ts's MAX_LINES discipline). */
const MAX_ROWS = 200;
/** Visible detail per command; the underlying shared projection is bounded too. */
const MAX_BODY_LINES_PER_ROW = 12;

function emptyProjection(reason: "empty" | "unrecognised"): Omit<ScreenProjection, "variant"> {
  return {
    screen: "command-history",
    rows: [],
    columns: [{ key: "summary", title: "Command", width: 40 }],
    caption: reason === "empty"
      ? emptyCaption({ what: "No command history yet", how: "commands appear here as specialists/critics run" })
      : unrecognisedCaption("Command History"),
  };
}

function projectCommandHistory(shape: DevToolsStreamShape, limit: number): Omit<ScreenProjection, "variant"> {
  // The supplemental DevTools feed remains explicitly supplemental, but its
  // command rows go through the one OperatorViewModel grammar used by the
  // Console. This preserves lifecycle, parentage, source labels, bounded
  // stdout/stderr detail, and malformed-input handling without a second model.
  const document = buildOperatorViewModel({
    devtools_stream: shape,
    viewport: { columns: 120, rows: 40 },
    now_ms: 0,
    limits: { max_rows: MAX_ROWS, max_detail_chars: 4_000, max_attention: MAX_ROWS },
  }).document;
  const bounded = document.filter((event) => event.event_kind === "loop.tool_call").slice(-limit)
    .map((event) => ({
      event,
      seq: event.sequence ?? "?",
      ts: event.occurred_at ?? "",
      node_id: event.correlation.node_id ?? "",
      summary: event.summary,
    }));
  return {
    screen: "command-history",
    rows: bounded,
    columns: [
      { key: "ts", title: "Time", width: 14 },
      { key: "node_id", title: "Node", width: 12 },
      { key: "summary", title: "Command", width: 40 },
    ],
    caption: bounded.length > 0 ? `Command history (${bounded.length})` : "no command history",
    row_ids: bounded.map((line): RowIdentity => ({ id: line.event.id })),
  };
}

function renderCommandHistory(
  projection: ScreenProjection,
  width: number,
  height: number,
  color: boolean,
  offset?: number,
): readonly string[] {
  const header = `Command history — commands, bounded output, and exit detail (${projection.rows.length})`;
  const headerLine = clipDisplay(header, width);
  if (projection.rows.length === 0) {
    return [headerLine, clipDisplay("(no commands recorded yet — waiting for specialist/critic activity)", width)];
  }
  const bodyHeight = Math.max(0, height - 1);
  const windowStart = Math.min(Math.max(0, offset ?? 0), projection.rows.length);
  const windowed = projection.rows.slice(windowStart);
  const lines: string[] = [];
  for (const row of windowed) {
    const event = row.event;
    if (typeof event !== "object" || event === null) continue;
    lines.push(...renderOperatorEvent(event as EventView, width, color, { max_detail_lines: MAX_BODY_LINES_PER_ROW, show_source: true }));
    lines.push(""); // blank separator between commands
    if (lines.length >= bodyHeight) break;
  }
  return [headerLine, ...lines.slice(0, bodyHeight)];
}

const COMMAND_HISTORY_VARIANTS = [
  defineVariant({
    tag: "stream",
    match: isDevToolsStreamShape,
    project: (shape) => projectCommandHistory(shape, MAX_ROWS),
    render: (projection, ctx) =>
      renderCommandHistory(projection, ctx.width, ctx.height, ctx.color === true, ctx.scroll_offset),
  }),
];

export const commandHistoryScreen: ScreenModule = {
  id: "command-history" as ScreenId,
  title: "Command History",
  required_capabilities: ["devtools.read"],

  surface: {
    commands: [],
    queries: ["devtools.stream"],
  },

  ...buildScreenPipeline(COMMAND_HISTORY_VARIANTS, { emptyProjection, shortCircuitEmptyRows: false }),
};
