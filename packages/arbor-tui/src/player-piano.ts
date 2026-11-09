/**
 * Player-piano animation primitives for the TUI (roadmap 4C, ADR-021 devtools).
 *
 * Every animation here is PURE and DETERMINISTIC: it derives from
 * `(state, frame_count)` — never random, never `Date.now()`. The frame clock
 * is injected by the shell (timerCadence); the transition map is folded by the
 * model/update cadence (see update.ts) and is never mutable renderer state.
 *
 * The devtools.stream integration contract is mirrored here (the TUI never
 * imports @arbor/mcp — ADR-011). The runtime adapter supplies exactly this
 * shape; the screen consumes it structurally and degrades gracefully on any
 * unknown/empty shape.
 */

import { displayWidth } from "./widgets.js";
import { deriveTheme, toForegroundSgr, type RunTheme } from "./theme.js";

// ── devtools.stream integration contract (structural mirror) ────────────────

export interface DevToolsStreamLine {
  readonly seq: number;
  readonly ts: string;
  readonly event_kind: string;
  readonly campaign_id: string | null;
  readonly node_id: string | null;
  readonly node_state?: string;
  readonly synthetic: boolean;
  /** Rich per-event payload (inference text, diff, tool call) — structural mirror. */
  readonly loop_event?: unknown;
}

export interface DevToolsStreamShape {
  readonly campaign_id: string | null;
  readonly lines: readonly DevToolsStreamLine[];
}

export function isDevToolsStreamShape(result: unknown): result is DevToolsStreamShape {
  return (
    typeof result === "object" &&
    result !== null &&
    "lines" in result &&
    Array.isArray((result as { lines?: unknown }).lines)
  );
}

// ── ANSI color helpers ───────────────────────────────────────────────────────

/**
 * `bold`/`dim`/`inverse`/`reset` are text ATTRIBUTES, not colors — they carry
 * no RGB and so have nothing to derive from a theme; they stay raw SGR here,
 * same as ever.
 *
 * `red`/`green`/`yellow`/`magenta`/`cyan` WERE hardcoded 16-color SGR codes
 * with no relationship at all to theme.ts's light/dark `RunTheme` — a
 * terminal detected as light-mode still got the dark-tuned basic-16
 * palette, because nothing here ever consulted the theme. `buildAnsiPalette`
 * derives each from theme.ts's semantic state roles (danger/success/
 * warning/special/info) via `toForegroundSgr`, the same truecolor-SGR
 * primitive status-bar.ts's footer uses — so these colors are now a real
 * PROJECTION of the theme, not disconnected magic numbers, exactly like
 * every other themed surface in this package.
 *
 * This changes nothing about the determinism contract: `buildAnsiPalette` is
 * a pure function of its `theme` argument, computed once at module init for
 * the default export below — no `Date.now()`, no `Math.random()`, no
 * runtime terminal probing here. A caller wanting the light-mode variant (or
 * any other `RunTheme`) can call `buildAnsiPalette(theme)` directly; nothing
 * downstream that reads `ANSI.<name>` needs to change, since every existing
 * call site compares against `ANSI.<name>` itself (never a literal escape
 * string) — this is a value-level change only.
 */
export function buildAnsiPalette(theme: RunTheme = deriveTheme(undefined)) {
  return Object.freeze({
    reset: "\u001b[0m",
    bold: "\u001b[1m",
    dim: "\u001b[2m",
    inverse: "\u001b[7m",
    red: toForegroundSgr(theme.colors.danger),
    green: toForegroundSgr(theme.colors.success),
    yellow: toForegroundSgr(theme.colors.warning),
    magenta: toForegroundSgr(theme.colors.special),
    cyan: toForegroundSgr(theme.colors.info),
  } as const);
}

/** The default (dark-theme) palette every existing call site imports. */
export const ANSI = buildAnsiPalette();

export function colorize(text: string, code: string): string {
  return `${code}${text}${ANSI.reset}`;
}

/**
 * Strips every embedded SGR escape sequence, leaving only the visible
 * characters — the same pattern `screens/console.ts`'s own private
 * `ANSI_SGR_RE` already establishes for measuring a colored row against its
 * uncolored sibling, exposed here so a second caller (`renderer.ts`'s
 * `drawPane`, audit finding) does not need its own private copy.
 */
const SGR_ESCAPE_RE = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "gu");
export function stripAnsi(value: string): string {
  return value.replace(SGR_ESCAPE_RE, "");
}

/**
 * Clip a possibly-ANSI-colored string to `columns` display columns, treating
 * ANSI escape sequences as zero-width. Plain (uncolored) input behaves exactly
 * like `clipDisplay`.
 */
export function clipAnsi(value: string, columns: number): string {
  if (!Number.isSafeInteger(columns) || columns < 0) throw new Error("columns must be a non-negative safe integer");
  let result = "";
  let used = 0;
  let index = 0;
  while (index < value.length) {
    if (value.charCodeAt(index) === 0x1b) {
      const end = value.indexOf("m", index);
      if (end === -1) break;
      result += value.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    const character = value[index];
    const width = displayWidth(character);
    if (used + width > columns) break;
    result += character;
    used += width;
    index += 1;
  }
  return result;
}

/**
 * Overwrite ONE display column of a possibly-ANSI-colored row with
 * `replacement` (a single-width glyph), treating embedded SGR escapes as
 * zero-width so the substitution lands on the correct visible cell.
 *
 * `renderCockpitScene`'s header dividers/borders used to splice a plain
 * `string[]` index (`line[x] = frame.v`) into a row that, under
 * `color: true`, carries embedded `[...m` sequences: those bytes shift
 * every later display column left by the escape's own length, so the
 * splice's raw string index no longer lines up with its intended VISIBLE
 * column and the divider lands one or more cells off (a real 120×36 colored
 * capture put a stray `│` inside the UCT graph, row 3). This walks the row
 * exactly like `clipAnsi` — skipping escapes without counting them — so the
 * overwritten cell is the one the terminal actually paints at `column`,
 * regardless of how much SGR precedes it. Any SGR active at or before
 * `column` continues to apply after the splice (the replacement inherits it,
 * same as every other character in that run); this mirrors `clipAnsi`'s own
 * "escapes are inert, not resets" contract rather than reopening a fresh
 * SGR state around the inserted glyph.
 */
export function spliceAnsiColumn(value: string, column: number, replacement: string): string {
  if (!Number.isSafeInteger(column) || column < 0) throw new Error("column must be a non-negative safe integer");
  let result = "";
  let used = 0;
  let index = 0;
  let spliced = false;
  while (index < value.length) {
    if (value.charCodeAt(index) === 0x1b) {
      const end = value.indexOf("m", index);
      if (end === -1) break;
      result += value.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    const character = value[index]!;
    const width = displayWidth(character);
    if (!spliced && used === column) {
      result += replacement;
      spliced = true;
    } else {
      result += character;
    }
    used += width;
    index += 1;
  }
  // The target column sits past every real character this row carries (a
  // short/unpadded row) — append it, matching `clipAnsi`'s plain-index
  // behavior for a value shorter than the requested column.
  if (!spliced) result += " ".repeat(Math.max(0, column - used)) + replacement;
  return result;
}

// ── spinner ──────────────────────────────────────────────────────────────────

/**
 * Rotating in-flight glyph. Frame 0 is the static "◌" (the historical
 * expanding icon) so a non-animated render stays backward compatible; later
 * frames rotate through the player-piano cycle.
 */
const SPINNER_GLYPHS: readonly string[] = ["◌", "◐", "◓", "◑", "◒"];

export function spinnerGlyph(frame_count: number): string {
  const frame = Number.isSafeInteger(frame_count) && frame_count >= 0 ? frame_count : 0;
  return SPINNER_GLYPHS[frame % SPINNER_GLYPHS.length];
}

// ── node state → color ───────────────────────────────────────────────────────

export function nodeStateColor(state: string): string {
  switch (state) {
    case "verified":
      return ANSI.green;
    case "failed":
      return ANSI.red;
    case "claimed":
      return ANSI.yellow;
    case "expanding":
      return ANSI.cyan;
    case "pending":
      return ANSI.dim;
    case "awaiting_review":
      // Outstanding verdict — the same warning role a claim uses, since both
      // are "decided but not yet final", distinguished by glyph not colour.
      return ANSI.magenta;
    case "pruned":
    case "interrupted":
    case "abandoned":
      // Closed without a verdict. These rendered with NO colour at all until
      // 2026-08-27, making three distinct terminal outcomes indistinguishable
      // from unstyled text.
      return ANSI.dim;
    default:
      return "";
  }
}

// ── event classification (devtools activity strip) ───────────────────────────

export type DevToolsEventClass =
  | "dispatch"
  | "verified"
  | "failed"
  | "claimed"
  | "node_changed"
  | "halt"
  | "truncated"
  | "command"
  | "other";

export function eventKindClass(event_kind: string): DevToolsEventClass {
  if (event_kind === "stream.truncated") return "truncated";
  if (event_kind === "loop.halt") return "halt";
  if (event_kind === "loop.specialist_dispatched" || event_kind === "loop.critic_dispatched") return "dispatch";
  if (event_kind === "loop.node_verified") return "verified";
  if (event_kind === "loop.node_failed") return "failed";
  if (event_kind === "loop.node_claimed") return "claimed";
  if (event_kind === "tree.node_changed") return "node_changed";
  // A real command the agent ran (opencode-event-stream.ts's per-command
  // records, pushed one `loop.tool_call` line each) — distinct from
  // `dispatch` (a whole specialist/critic TURN starting) so the terse live
  // line and this file's history screen can tell "a turn began" from "a
  // command ran inside one", which were previously indistinguishable
  // because tool_call fell through to "other".
  if (event_kind === "loop.tool_call") return "command";
  return "other";
}

export function eventClassColor(eventClass: DevToolsEventClass, node_state?: string): string {
  switch (eventClass) {
    case "dispatch":
      return ANSI.cyan;
    case "verified":
      return ANSI.green;
    case "failed":
      return ANSI.red;
    case "claimed":
      return ANSI.yellow;
    case "halt":
      return ANSI.magenta;
    case "truncated":
      return ANSI.dim;
    case "command":
      // Matches devtools.ts's own hardcoded ANSI.yellow for a `loop.tool_call`
      // rich row header, so the terse live line and the raw devtools pane
      // agree on what color "a command ran" is.
      return ANSI.yellow;
    case "node_changed":
      return node_state !== undefined ? nodeStateColor(node_state) : "";
    default:
      return "";
  }
}

// ── transition flash (state-change highlight) ────────────────────────────────

export interface NodeTransition {
  readonly state: string;
  readonly frames_remaining: number;
}

export interface TransitionOptions {
  /** How many model-update frames a fresh flash stays fully lit. */
  readonly flash_frames?: number;
}

/** Node states that raise a visible transition flash when they appear. */
const FLASHABLE_STATES: ReadonlySet<string> = new Set(["verified", "failed", "claimed"]);

/** The flashable state a stream line represents, or null when it is not a transition. */
function flashableState(line: DevToolsStreamLine): string | null {
  if (line.node_id === null) return null;
  if (line.event_kind === "loop.node_verified" || line.event_kind === "loop.node_failed" || line.event_kind === "loop.node_claimed") {
    return line.node_state ?? line.event_kind.slice("loop.node_".length);
  }
  if (line.event_kind === "tree.node_changed" && line.node_state !== undefined && FLASHABLE_STATES.has(line.node_state)) {
    return line.node_state;
  }
  return null;
}

/**
 * Fold the transition map forward by one model update (the update cadence).
 *
 * Pure: given the same (previous, previousLines, lines) it returns the same
 * map. Existing flashes decay one frame per update; a node whose stream state
 * CHANGED to a flashable state (or that is new) raises a full-strength flash.
 * A persistent snapshot never re-raises — the flash is keyed to the state
 * transition, not to the line's continued presence. Flashes expire at zero
 * and are dropped. This is the "driven by the model/update cadence" contract —
 * the renderer only reads the folded map, never mutates it.
 */
export function deriveTransitions(
  previous: ReadonlyMap<string, NodeTransition>,
  previousLines: readonly DevToolsStreamLine[],
  lines: readonly DevToolsStreamLine[],
  options: TransitionOptions = {},
): ReadonlyMap<string, NodeTransition> {
  const flashFrames = options.flash_frames ?? 8;
  const next = new Map<string, NodeTransition>();

  // 1. Decay every existing flash by one frame (one update = one frame).
  for (const [nodeId, transition] of previous) {
    const remaining = transition.frames_remaining - 1;
    if (remaining > 0) next.set(nodeId, { state: transition.state, frames_remaining: remaining });
  }

  // 2. Raise a flash only when a node's stream state changed to a flashable
  // state (or the node is new) — never on a state that merely persists.
  const previousStates = streamStates(previousLines);
  const currentStates = streamStates(lines);
  for (const [nodeId, state] of currentStates) {
    if (previousStates.get(nodeId) !== state) {
      next.set(nodeId, { state, frames_remaining: flashFrames });
    }
  }

  return next;
}

/** The most recent flashable state per node in a stream snapshot. */
function streamStates(lines: readonly DevToolsStreamLine[]): ReadonlyMap<string, string> {
  const states = new Map<string, string>();
  for (const line of lines) {
    const state = flashableState(line);
    if (state !== null) states.set(line.node_id as string, state);
  }
  return states;
}

/** ANSI prefix that makes a flashing row visibly pop (inverse + state color). */
export function flashStyle(state: string, frames_remaining: number): string {
  if (frames_remaining <= 0) return "";
  const color = nodeStateColor(state) || ANSI.bold;
  return `${ANSI.inverse}${color}`;
}
