/**
 * DevTools screen (ADR-021 devtools inspector projection).
 *
 * Renders the live `devtools.stream` activity stream + campaign status as a
 * bounded, color-coded, scrolling strip. The stream is the integration
 * contract supplied by the runtime adapter (see player-piano.ts for the
 * structural mirror); this screen consumes it structurally and degrades
 * gracefully on any null/unknown/empty shape.
 *
 * Player-piano polish lives here and in player-piano.ts: a pulsing "●
 * streaming" header dot, per-event-class ANSI coloring, a rotating spinner for
 * in-flight nodes, and a short-lived inverse flash when a node flips state
 * (verified/failed/claimed). All animation derives from (state, frame_count) —
 * the frame clock is injected by the shell, the transition map is folded by
 * the model/update cadence. Nothing here is mutable renderer state.
 *
 * Leaf module. Depends only on @arbor/core (via widgets) and the
 * runtime-port/screen contracts — never @arbor/mcp.
 */

import { clipDisplay, displayWidth } from "../widgets.js";
import type { RowIdentity, ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";
import { emptyCaption, unrecognisedCaption } from "./empty-state.js";
import {
  ANSI,
  clipAnsi,
  colorize,
  eventClassColor,
  eventKindClass,
  flashStyle,
  isDevToolsStreamShape,
  type DevToolsStreamShape,
  type NodeTransition,
} from "../player-piano.js";

/** Hard cap on the activity strip — never unbounded growth. */
const MAX_LINES = 100;

function rowCountCaption(caption: string, count: number): string {
  return count > 0 ? `${caption} (${count})` : `no ${caption.toLowerCase()}`;
}

function emptyProjection(reason: "empty" | "unrecognised"): Omit<ScreenProjection, "variant"> {
  return {
    screen: "devtools",
    rows: [],
    columns: [{ key: "event_kind", title: "Event", width: 24 }],
    caption: reason === "empty"
      ? emptyCaption({ what: "No devtools activity yet", how: "follow it with `arbor devtools tail`" })
      : unrecognisedCaption("DevTools"),
  };
}

function projectDevTools(shape: DevToolsStreamShape, limit: number): Omit<ScreenProjection, "variant"> {
  // Most recent `limit` lines, oldest first — newest at the bottom (live feel).
  const bounded = shape.lines.slice(-limit).map((line) => ({
    seq: line.seq,
    ts: line.ts,
    event_kind: line.event_kind,
    campaign_id: line.campaign_id ?? "",
    node_id: line.node_id ?? "",
    node_state: line.node_state ?? "",
    synthetic: line.synthetic,
    loop_event: line.loop_event,
  }));

  return {
    screen: "devtools",
    rows: bounded,
    columns: [
      { key: "seq", title: "Seq", width: 6 },
      // `synthetic` was read into every row and never rendered — a backfilled
      // event (replayed/reconstructed, not live-observed) looked identical to
      // a real one. `renderLine`/`renderRichRow` below now prefix a `~`
      // marker on a synthetic row's line.
      { key: "synthetic", title: "Syn", width: 3 },
      { key: "ts", title: "Time", width: 14 },
      { key: "event_kind", title: "Event", width: 24 },
      { key: "campaign_id", title: "Campaign", width: 12 },
      { key: "node_id", title: "Node", width: 12 },
      { key: "node_state", title: "State", width: 10 },
    ],
    caption: rowCountCaption("DevTools stream", bounded.length),
    // Each ring line's `seq` is a monotonic per-stream sequence number — a
    // real, stable identity, even though this screen issues no commands.
    row_ids: bounded.map((line): RowIdentity => ({ id: String(line.seq) })),
  };
}

/**
 * Pad a clipped field to exactly `width` display columns. Was `clipped.length`
 * (UTF-16 code units) — under-pads a BMP wide glyph (e.g. a CJK campaign/node
 * id, displayWidth 2 but length 1), misaligning every column after it in that
 * row relative to the header and every ascii-only row. Design-bar audit fix
 * (4F wide-glyph alignment discipline): use `displayWidth`, never `.length`.
 */
function padField(value: string, width: number): string {
  const clipped = clipDisplay(value, width);
  return clipped + " ".repeat(Math.max(0, width - displayWidth(clipped)));
}

/** `~` for a backfilled/reconstructed event, a blank cell for a live-observed one. */
function syntheticMark(row: Readonly<Record<string, unknown>>): string {
  return row.synthetic === true ? "~" : " ";
}

function renderLine(
  row: Readonly<Record<string, unknown>>,
  width: number,
  color: boolean,
  transitions: ReadonlyMap<string, NodeTransition> | undefined,
): string {
  const seq = String(row.seq ?? "");
  const ts = String(row.ts ?? "");
  const kind = String(row.event_kind ?? "");
  const campaign = String(row.campaign_id ?? "");
  const node = String(row.node_id ?? "");
  const state = String(row.node_state ?? "");
  const eventClass = eventKindClass(kind);

  const plain = `${padField(seq, 5)}${syntheticMark(row)} ${padField(ts, 12)} ${padField(kind, 22)} ${padField(campaign, 10)} ${padField(node, 10)} ${padField(state, 8)}`;
  const clipped = clipDisplay(plain, width);
  if (!color) return clipped;

  const classColor = eventClassColor(eventClass, state || undefined);
  const transition = node !== "" ? transitions?.get(node) : undefined;
  if (transition !== undefined && transition.frames_remaining > 0) {
    return clipAnsi(`${flashStyle(transition.state, transition.frames_remaining)}${clipped}${ANSI.reset}`, width);
  }
  return classColor !== "" ? clipAnsi(`${classColor}${clipped}${ANSI.reset}`, width) : clipped;
}

function eventPayload(row: Readonly<Record<string, unknown>>): unknown {
  return row["loop_event"];
}

/** Wrapped (width-aware) body lines for a rich row, e.g. an inference trace's response text. */
function wrapBody(text: string, width: number, limit: number): string[] {
  const out: string[] = [];
  for (const rawLine of String(text).split("\n")) {
    const line = clipDisplay(rawLine, width);
    if (line === "") out.push("");
    else out.push(...chunk(line, width));
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

function chunk(line: string, width: number): string[] {
  const out: string[] = [];
  let rest = line;
  while (rest.length > 0 && out.length < 100) {
    out.push(clipDisplay(rest, width));
    rest = rest.slice(out[out.length - 1].length);
  }
  return out;
}

/** Scrollable rich view for a row's content: emits [header, ...body] render lines. */
function renderRichRow(
  row: Readonly<Record<string, unknown>>,
  width: number,
  color: boolean,
  bodyHeight: number,
): string[] {
  const kind = String(row.event_kind ?? "");
  const mark = row.synthetic === true ? "~" : "";
  const payload = eventPayload(row) as Record<string, unknown> | null;
  if (payload !== null && typeof payload === "object") {
    if (kind === "loop.inference_trace") {
      const phase = String(payload["phase"] ?? "");
      const model = String(payload["model"] ?? "");
      const ok = payload["ok"] === true;
      const text = String(payload["response_preview"] ?? payload["response_full"] ?? "");
      const headerText = `${mark}◆ ${phase} · ${model} · ${ok ? "ok" : "fail"} · ${text.length}B`;
      const header = color ? clipAnsi(`${ANSI.bold}${ANSI.cyan}${headerText}${ANSI.reset}`, width) : clipDisplay(headerText, width);
      return [header, ...wrapBody(text, width, Math.max(0, bodyHeight - 1))];
    }
    if (kind === "loop.diff") {
      const headerText = `${mark}▽ diff · ${String(payload["path"] ?? "")} · ${String(payload["additions"] ?? 0)}+/${String(payload["deletions"] ?? 0)}-`;
      const header = color ? clipAnsi(`${ANSI.bold}${ANSI.cyan}${headerText}${ANSI.reset}`, width) : clipDisplay(headerText, width);
      const body = String(payload["diff"] ?? "").split("\n").slice(0, Math.max(0, bodyHeight - 1)).map((line) => {
        if (line.startsWith("+")) return color ? clipAnsi(`${ANSI.green}${line}${ANSI.reset}`, width) : clipDisplay(line, width);
        if (line.startsWith("-")) return color ? clipAnsi(`${ANSI.red}${line}${ANSI.reset}`, width) : clipDisplay(line, width);
        if (line.startsWith("@@")) return color ? clipAnsi(`${ANSI.cyan}${line}${ANSI.reset}`, width) : clipDisplay(line, width);
        return clipDisplay(line, width);
      });
      return [header, ...body];
    }
    if (kind === "loop.tool_call") {
      const tool = String(payload["tool"] ?? "");
      const args = String(payload["args"] ?? "");
      const parent = typeof payload["parent_id"] === "string" ? ` · ↳ ${payload["parent_id"]}` : "";
      const lifecycle = payload["ok"] === false ? "failed" : payload["ok"] === true ? "completed" : "observed";
      const headerText = `${mark}⚙ ${tool} · ${lifecycle}${parent}${args ? ` · ${clipDisplay(args, Math.max(8, width - 20))}` : ""} · supplemental/devtools`;
      const header = color ? clipAnsi(`${ANSI.bold}${ANSI.yellow}${headerText}${ANSI.reset}`, width) : clipDisplay(headerText, width);
      const stdout = String(payload["stdout"] ?? "");
      const stderr = String(payload["stderr"] ?? "");
      const output = [
        ...(stdout === "" ? [] : [`[stdout]\n${stdout}`]),
        ...(stderr === "" ? [] : [`[stderr]\n${stderr}`]),
      ].join("\n");
      const body = output !== "" ? wrapBody(output, width, Math.max(0, bodyHeight - 1)) : [];
      return [header, ...body];
    }
    return [renderLine(row, width, color, undefined)];
  }
  return [renderLine(row, width, color, undefined)];
}

function renderHeader(
  projection: ScreenProjection,
  width: number,
  frame_count: number,
  color: boolean,
): string {
  const last = projection.rows.at(-1);
  const count = projection.rows.length;
  const dot = frame_count % 2 === 0 ? "●" : "○";
  const campaign = last ? String(last.campaign_id ?? "") : "";
  const lastKind = last ? String(last.event_kind ?? "") : "";
  const lastState = last ? String(last.node_state ?? "") : "";

  const dotText = color ? colorize(dot, count > 0 ? ANSI.green : ANSI.dim) : dot;
  const campaignText = campaign !== "" ? ` campaign:${clipDisplay(campaign, 12)}` : "";
  const lastText =
    lastKind !== ""
      ? ` last:${color ? colorize(clipDisplay(lastKind, 20), eventClassColor(eventKindClass(lastKind), lastState || undefined) || ANSI.bold) : clipDisplay(lastKind, 20)}`
      : "";
  const base = `${dotText} streaming${campaignText} ·${count} events${lastText}`;
  return color ? clipAnsi(base, width) : clipDisplay(base, width);
}

function renderDevTools(
  projection: ScreenProjection,
  width: number,
  height: number,
  frame_count: number,
  color: boolean,
  transitions: ReadonlyMap<string, NodeTransition> | undefined,
  offset?: number,
): readonly string[] {
  const header = renderHeader(projection, width, frame_count, color);
  if (projection.rows.length === 0) {
    return [header, clipDisplay("(no devtools activity yet — waiting for stream)", width)];
  }
  const bodyHeight = Math.max(0, height - 1);
  // This screen has no single widgets.ts call to hand an `offset` to (rich
  // rows expand to a variable number of output lines each, unlike a table's
  // fixed one-row-per-line shape) — window the source rows by offset first,
  // matching widgets.ts's own `boundedOffset` clamp semantics.
  const windowStart = Math.min(Math.max(0, offset ?? 0), projection.rows.length);
  const windowed = projection.rows.slice(windowStart);
  const lines: string[] = [];
  for (const row of windowed) {
    const kind = String(row.event_kind ?? "");
    const isRich = kind === "loop.inference_trace" || kind === "loop.diff" || kind === "loop.tool_call";
    if (isRich) {
      lines.push(...renderRichRow(row, width, color, bodyHeight));
    } else {
      lines.push(renderLine(row, width, color, transitions));
    }
    if (lines.length >= bodyHeight) break;
  }
  return [header, ...lines.slice(0, bodyHeight)];
}

const DEVTOOLS_VARIANTS = [
  defineVariant({
    tag: "stream",
    match: isDevToolsStreamShape,
    project: (shape) => projectDevTools(shape, MAX_LINES),
    render: (projection, ctx) =>
      renderDevTools(projection, ctx.width, ctx.height, ctx.frame_count ?? 0, ctx.color === true, ctx.transitions, ctx.scroll_offset),
  }),
];

export const devtoolsScreen: ScreenModule = {
  id: "devtools" as ScreenId,
  title: "DevTools",
  required_capabilities: ["devtools.read"],

  surface: {
    commands: [],
    queries: ["devtools.stream"],
  },

  ...buildScreenPipeline(DEVTOOLS_VARIANTS, { emptyProjection, shortCircuitEmptyRows: false }),
};
