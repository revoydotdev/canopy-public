/**
 * Raw terminal byte decoding for mouse/wheel and multi-byte navigation keys
 * (wave2/tui-input-model, task 5/1).
 *
 * The live raw stdin loop (`packages/arbor-mcp/src/tui.ts`, outside this
 * package — a sibling lane's file) currently iterates a chunk one Unicode
 * code point at a time (`for (const ch of text) handler(ch)`), which is
 * correct only for single-byte input. A multi-byte CSI sequence — PageUp
 * (`ESC [ 5 ~`), Home/End, or an SGR mouse report (`ESC [ < Cb ; Cx ; Cy M`)
 * — would be shredded into unrelated single-character "keys" by that loop
 * today. Nothing currently recognizes these sequences anywhere in this
 * codebase.
 *
 * `decodeTerminalInput` is the pure, stateless (per-chunk) recognizer: it
 * scans a chunk, pulls out the CSI sequences it knows about, and returns
 * everything else verbatim as `text` for the existing per-character loop to
 * keep handling exactly as it does today (Enter, Escape, printable
 * characters, compose/confirm/help buffer editing). It does NOT buffer a
 * sequence split across two `data` chunks — real terminals deliver these
 * sequences atomically in one write in the overwhelming common case; a
 * chunk-spanning split degrades to each half being passed through as
 * ordinary text, not a crash or a hang.
 *
 * Click/press mouse events are recognized and returned (`MouseEvent`) but
 * `mouseEventToIntent` deliberately returns `null` for them: resolving a
 * terminal (x, y) to a screen row requires hit-test geometry only the
 * widened `RendererPort` (a sibling lane's concern) can supply. See that
 * function's doc comment for the exact interface this module needs from it.
 */
import type { KeyModifier, NormalizedKeyEvent } from "./input-catalog.js";
import type { UiIntent } from "./types.js";

export type MouseButton = "left" | "middle" | "right" | "none";

export type MouseAction =
  | { readonly kind: "wheel"; readonly direction: 1 | -1 }
  | { readonly kind: "press" | "release"; readonly button: MouseButton };

export interface MouseEvent {
  /** 1-based terminal column, as reported by the SGR mouse protocol. */
  readonly x: number;
  /** 1-based terminal row, as reported by the SGR mouse protocol. */
  readonly y: number;
  readonly action: MouseAction;
}

export interface DecodedTerminalInput {
  /** Normalized navigation and control keys recognized in this chunk. */
  readonly keys: readonly NormalizedKeyEvent[];
  /** Mouse press/release/wheel reports recognized this chunk (SGR protocol only). */
  readonly mouse: readonly MouseEvent[];
  /** Every byte not consumed by a recognized sequence, in original order — feed this to the existing per-character loop unchanged. */
  readonly text: string;
  readonly pastes?: readonly string[];
}

const ESC = String.fromCharCode(27);

/**
 * POSIX terminals encode Ctrl+A..Ctrl+Z as bytes 0x01..0x1a. The input
 * catalog uses semantic events (`{key: "n", modifiers: ["ctrl"]}`), so
 * passing those bytes through as text makes every Ctrl binding unreachable.
 * Enter (0x0a/0x0d), Tab (0x09), Escape, and Backspace remain text because
 * the live form/overlay loop owns their context-sensitive behavior.
 */
function controlKey(byte: string): NormalizedKeyEvent | null {
  const code = byte.charCodeAt(0);
  if (code < 1 || code > 26 || code === 9 || code === 10 || code === 13) return null;
  return { key: String.fromCharCode(96 + code), modifiers: ["ctrl"] };
}

/** xterm SGR mouse report: `ESC [ < Cb ; Cx ; Cy (M|m)` — M = press/wheel, m = release. */
const SGR_MOUSE_PREFIX = /^\[<(\d+);(\d+);(\d+)([Mm])/;

/**
 * Fixed CSI/SS3 sequences (minus the leading ESC, matched separately) for
 * the four navigation keys `default-catalog.ts` binds (`PAGE_UP_ACTION_ID`
 * etc.). Covers both the common VT220-style `~`-terminated forms and the
 * `H`/`F`/SS3 forms different terminals emit for Home/End — deliberately
 * narrow (exactly the four keys this codebase binds today), not a general
 * terminfo-grade key table.
 */
const CSI_KEY_SEQUENCES: readonly (readonly [rest: string, key: string, modifiers?: readonly KeyModifier[]])[] = [
  // Cursor keys, both the normal-mode CSI form (`ESC [ A`) and the
  // application-mode SS3 form (`ESC O A`) terminals emit after DECCKM.
  // Before these were listed, `ESC [ B` fell through the "unrecognized
  // escape" branch below as ESC + "[" + "B", and the "[" landed in the
  // navigation router as the Compaction-screen hotkey — every arrow key on
  // every list screen navigated to Compaction (audit 2026-08-23, WA-25).
  ["[A", "up"],
  ["[B", "down"],
  ["[C", "right"],
  ["[D", "left"],
  ["OA", "up"],
  ["OB", "down"],
  ["OC", "right"],
  ["OD", "left"],
  ["[5~", "pageup"],
  ["[6~", "pagedown"],
  ["[H", "home"],
  ["[1~", "home"],
  ["[7~", "home"],
  ["OH", "home"],
  ["[F", "end"],
  ["[4~", "end"],
  ["[8~", "end"],
  ["OF", "end"],
  // VT220 Delete (T2.3b, forward-delete in a text-editing overlay).
  ["[3~", "delete"],
  // xterm's modified-cursor-key encoding (`CSI 1 ; <mod> <letter>`), mod 5 =
  // Ctrl. Word-wise movement inside the compose/operator-form buffers
  // (T2.3b) — deliberately narrow to just Ctrl+Left/Right, the two this
  // codebase's editing model actually understands (`text-buffer.ts`'s
  // `word_left`/`word_right`), not a general modified-key table.
  ["[1;5D", "left", ["ctrl"]],
  ["[1;5C", "right", ["ctrl"]],
  // Kitty keyboard protocol's CSI-u form for a modified Enter (keycode 13):
  // `;2` = Shift, `;3` = Alt. Recognized as one normalized "newline" key —
  // see `decodeTerminalInput`'s own doc comment for the paired legacy
  // (ESC + CR) Alt+Enter encoding this module also recognizes.
  ["[13;2u", "newline"],
  ["[13;3u", "newline"],
  // Function-key zone cycling and the context menu (ui-spec §3): xterm's
  // VT220-style `CSI <n> ~` function-key encoding, plain and Shift-modified
  // (`;2`) — the same `CSI <n> ; <mod> ~` convention xterm already uses for
  // every function key from F5 up (F1-F4 use a different SS3/CSI-letter
  // encoding this codebase does not otherwise consume).
  // Canopy-debug reserves F8 for a screenshot and F9 for recording. Keep them
  // in the terminal decoder (rather than relying on OpenTUI's native names)
  // so the stdout renderer and a real piped smoke session exercise the same
  // exclusive capture path.
  ["[19~", "f8"],
  ["[20~", "f9"],
  ["[17~", "f6"],
  ["[17;2~", "f6", ["shift"]],
  ["[21~", "f10"],
  ["[21;2~", "f10", ["shift"]],
];

const TERMINAL_RESPONSE_PREFIX = /^\[(?:\??[0-9;>]*)$/;
const CSI_CONTROL_SEQUENCE = /^\[(?:[0-9;? >]*[ -/]*[@-~])/;
const STRING_CONTROL_SEQUENCE = /^[\]PX^_](?:[^\u0007\u001b]|\u001b(?!\\))*?(?:\u0007|\u001b\\)/;

/**
 * The introducers that open a DCS/OSC/SOS/PM/APC string control sequence
 * after `ESC`, and the terminator that closes one. Named here, beside
 * `STRING_CONTROL_SEQUENCE`, so the character-at-a-time reassembler below
 * and the whole-buffer regex above cannot drift apart.
 */
const STRING_CONTROL_INTRODUCERS = "]PX^_";
/**
 * Introducers a held burst may begin with: the string controls above plus
 * CSI. A cursor-position report `ESC [ 40 ; 120 R` split after its ESC
 * decoded as `[` (Compaction), `4` (Output), `0` (Approvals), `R` (Diff
 * Review) and walked an operator through four screens they never asked for
 * (EC-056). Both holds consult `classifyHeldBurst` so the grammar lives once.
 */
export const HELD_BURST_INTRODUCERS = "]PX^_[";
// Replies a terminal sends unprompted or in answer to a query, CSI-shaped:
// CPR, DA1/DA2, DECRPM, kitty keyboard flags, window/pixel size reports.
const CSI_REPLY = /^\[(?:\d+;\d+R|\?\d+(?:;\d+)*c|>\d+(?:;\d+)*c|\?\d+;\d+\$y|\?\d*u|\d+;\d+;\d+t|\d+;\d+t)$/u;
/**
 * Given the bytes that followed a lone ESC, decide whether they are a
 * terminal reply (drop), certainly not one (release as keystrokes), or still
 * incomplete (keep holding). A string control is complete at ST or BEL; a
 * CSI is complete at its final byte (0x40–0x7E) and is a reply only if it
 * matches a known report — anything else after `[` is an operator's chord.
 */
export function classifyHeldBurst(text: string): "reply" | "keystrokes" | "incomplete" {
  if (text.length === 0) return "incomplete";
  const introducer = text[0]!;
  if (STRING_CONTROL_INTRODUCERS.includes(introducer)) {
    return text.includes(BEL) || text.includes(`${ESC}\\`) ? "reply" : "incomplete";
  }
  if (introducer === "[") {
    const body = text.slice(1);
    const final = /[@-~]/u.exec(body);
    if (final === null) return body.length > 32 ? "keystrokes" : "incomplete";
    const sequence = text.slice(0, 1 + final.index + 1);
    return CSI_REPLY.test(sequence) ? "reply" : "keystrokes";
  }
  return "keystrokes";
}
const BEL = String.fromCharCode(7);

/**
 * Reassembles a terminal capability REPLY that has already been shattered
 * into one key event per character, so it can be dropped instead of typed.
 *
 * `decodeTerminalInput` never needs this: it sees the whole buffer and
 * `STRING_CONTROL_SEQUENCE` matches the reply in one piece. The OpenTUI
 * renderer path has no such buffer — `@opentui/core` owns stdin and its
 * `parseKeypress` reports each byte of a reply as an ordinary printable
 * keypress. Feeding tmux's real XTVERSION answer through that parser yields
 * the characters `>`, `|`, `t`, `m`, `u`, `x`, ` `, `3`, `.`, `7` — which is
 * exactly the `P>|tmux 3.7` that appeared inside an operator's composer.
 *
 * The fragmentation happens upstream of every widget, so no choice of text
 * widget avoids it and no startup-time gate bounds it: a terminal may answer
 * late, and answers again on reattach or resize.
 *
 * `ESC` itself is still delivered. It is the one byte that must stay
 * latency-free (see `onNativeInput`'s escape fast lane), and a stray Escape
 * cancels an overlay rather than corrupting a buffer.
 */
export class TerminalReplyFilter {
  private state: "idle" | "escape" | "string" = "idle";
  private escapeInString = false;

  /**
   * Feed the raw bytes of one key event. Returns true when the event belongs
   * to a capability reply and must not reach the application as input.
   */
  consume(raw: string): boolean {
    if (this.state === "string") {
      if (this.escapeInString) {
        this.escapeInString = false;
        if (raw === "\\") this.state = "idle";
        return true;
      }
      if (raw === ESC) { this.escapeInString = true; return true; }
      if (raw === BEL) { this.state = "idle"; return true; }
      return true;
    }
    if (this.state === "escape") {
      this.state = raw.length === 1 && STRING_CONTROL_INTRODUCERS.includes(raw) ? "string" : "idle";
      return this.state === "string";
    }
    if (raw === ESC) {
      this.state = "escape";
      // An introducer only counts as one when it arrives in the SAME
      // synchronous burst as its ESC. Otherwise pressing Escape and later
      // typing "P" would silently swallow the "P".
      queueMicrotask(() => { if (this.state === "escape") this.state = "idle"; });
    }
    return false;
  }

  reset(): void { this.state = "idle"; this.escapeInString = false; }
}

/**
 * Hold for a capability reply whose introducer arrives SPLIT from its ESC.
 *
 * `TerminalReplyFilter` recognises an introducer only in the same synchronous
 * burst as its ESC, because a real Escape followed later by "P" must not lose
 * the "P". But a terminal can deliver its reply one byte per chunk with a gap
 * after the ESC (tmux's XTVERSION answer arrived as ESC, ~30-60 ms, then
 * `P > | t m u x …`), and by then the ESC has been released as a keystroke and
 * every following byte decodes as printable text typed into the composer.
 * Measured live under the default renderer (EC-048); `tui.ts` fixed the same
 * shape on its raw-stdin path with a renewing hold (EC-044).
 *
 * The discriminator is timing plus grammar: a keystroke is one byte followed
 * by silence; a reply is a continuing stream that terminates the way replies
 * do. After a lone ESC, an item that begins a string control sequence
 * (`] P X ^ _`) or a CSI (`[`) is HELD; each further item renews the hold;
 * `classifyHeldBurst` drops a proven reply (ST/BEL, or a CSI report such as
 * a cursor-position `[40;120R`, EC-056), releases a proven chord at once (a
 * CSI that is not a report), and `quietMs` of silence releases anything still
 * ambiguous. So Escape then `]` (Siblings) is delayed by `quietMs`, never eaten.
 *
 * Generic over the item type so the bridge can hold OpenTUI `KeyEvent`s while
 * the grammar (introducers, terminators) stays defined once, here.
 */
export class SplitReplyHold<T> {
  private held: T[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private escapeSeenAt = -1;
  private readonly quietMs: number;
  private readonly escapeWindowMs: number;
  private readonly now: () => number;

  constructor(private readonly options: {
    readonly textOf: (item: T) => string;
    readonly release: (items: readonly T[]) => void;
    readonly quietMs?: number;
    readonly escapeWindowMs?: number;
    readonly now?: () => number;
  }) {
    this.quietMs = options.quietMs ?? 60;
    this.escapeWindowMs = options.escapeWindowMs ?? 250;
    this.now = options.now ?? Date.now;
  }

  /** A lone ESC was just delivered as a keystroke; the next item may be a reply's introducer. */
  noteLoneEscape(): void { this.escapeSeenAt = this.now(); }

  /** Returns true when the item was absorbed (held, or dropped as part of a proven reply). */
  offer(item: T): boolean {
    const text = this.options.textOf(item);
    if (this.timer !== null) {
      this.held.push(item);
      const verdict = classifyHeldBurst(this.held.map(this.options.textOf).join(""));
      if (verdict === "reply") { this.drop(); return true; }
      if (verdict === "keystrokes") { this.releaseNow(); return true; }
      this.renew();
      return true;
    }
    const recentEscape = this.escapeSeenAt >= 0 && this.now() - this.escapeSeenAt <= this.escapeWindowMs;
    this.escapeSeenAt = -1;
    if (recentEscape && text.length === 1 && HELD_BURST_INTRODUCERS.includes(text)) {
      this.held = [item];
      this.renew();
      return true;
    }
    return false;
  }

  get holding(): boolean { return this.timer !== null; }

  private renew(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const items = this.held;
      this.held = [];
      this.timer = null;
      if (items.length > 0) this.options.release(items);
    }, this.quietMs);
  }

  private drop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.held = [];
  }

  /** The burst proved to be keystrokes (a CSI that is not a report): deliver it at once. */
  private releaseNow(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const items = this.held;
    this.held = [];
    if (items.length > 0) this.options.release(items);
  }

  reset(): void { this.drop(); this.escapeSeenAt = -1; }
}

/**
 * Turn one printable character the per-character navigation loop is about
 * to route into a `NormalizedKeyEvent`. An uppercase ASCII letter is the
 * terminal's only encoding of Shift+letter, so it becomes
 * `{key: "r", modifiers: ["shift"]}` — which is what a `shift+r` binding in
 * `default-catalog.ts` normalizes to. Before this, "R" reached the router as
 * a bare "r" (the `cmd:row.retry` binding), so Shift+R could never open Diff
 * Review and instead armed a row retry (audit 2026-08-23, WA-24).
 */
export function navigationKeyFromChar(ch: string): NormalizedKeyEvent {
  if (ch.length === 1 && ch >= "A" && ch <= "Z") return { key: ch.toLowerCase(), modifiers: ["shift"] };
  return { key: ch };
}

/**
 * Parse one complete SGR mouse report (the full `ESC [ < ...` sequence,
 * including the leading ESC). Returns `null` for anything that isn't a
 * well-formed SGR sequence (including malformed coordinates) — never
 * guesses.
 */
export function parseMouseEvent(raw: string): MouseEvent | null {
  if (!raw.startsWith(ESC)) return null;
  const match = SGR_MOUSE_PREFIX.exec(raw.slice(ESC.length));
  if (!match) return null;
  const code = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  const released = match[4] === "m";
  if (!Number.isSafeInteger(code) || code < 0) return null;
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 1 || y < 1) return null;
  const buttonBits = code & 0b11;
  const isWheel = (code & 64) === 64;
  if (isWheel) {
    // SGR encodes wheel-up as button-bits 0, wheel-down as button-bits 1.
    // direction is the scroll-offset delta sign: up decreases the offset
    // (toward the top), down increases it.
    return { x, y, action: { kind: "wheel", direction: buttonBits === 0 ? -1 : 1 } };
  }
  const button: MouseButton = buttonBits === 0 ? "left" : buttonBits === 1 ? "middle" : buttonBits === 2 ? "right" : "none";
  return { x, y, action: { kind: released ? "release" : "press", button } };
}

/**
 * Scan one raw stdin chunk, pulling out recognized mouse/navigation-key
 * sequences and returning everything else as plain text for the existing
 * per-character loop.
 */
export function decodeTerminalInput(chunk: string): DecodedTerminalInput {
  const keys: NormalizedKeyEvent[] = [];
  const mouse: MouseEvent[] = [];
  let text = "";
  const pastes: string[] = [];
  let index = 0;
  while (index < chunk.length) {
    if (chunk.startsWith(`${ESC}[200~`, index)) {
      const end = chunk.indexOf(`${ESC}[201~`, index + 6);
      if (end >= 0) { pastes.push(chunk.slice(index + 6, end)); index = end + 6; continue; }
    }
    if (chunk[index] !== ESC) {
      const control = controlKey(chunk[index]);
      if (control === null) text += chunk[index];
      else keys.push(control);
      index += 1;
      continue;
    }
    const rest = chunk.slice(index);
    // Terminal capability probes answer on stdin with CSI reports (for
    // example DA `ESC[?1;2c`, cursor position `ESC[1;1R`, and window size
    // `ESC[4;140;44t`). They are protocol traffic, never operator keys;
    // letting their digits and letters reach the navigation router causes a
    // fresh Console to jump screens before the first real keystroke.
    const terminalResponse = /^\[(?:\??[0-9;>]*)(?:R|c|t)/.exec(rest.slice(ESC.length));
    if (terminalResponse !== null) {
      index += ESC.length + terminalResponse[0].length;
      continue;
    }
    const mouseMatch = SGR_MOUSE_PREFIX.exec(rest.slice(ESC.length));
    if (mouseMatch) {
      const full = ESC + mouseMatch[0];
      const parsed = parseMouseEvent(full);
      if (parsed) mouse.push(parsed);
      index += full.length;
      continue;
    }
    const keyMatch = CSI_KEY_SEQUENCES.find(([sequenceRest]) => rest.slice(ESC.length).startsWith(sequenceRest));
    if (keyMatch) {
      keys.push({ key: keyMatch[1], ...(keyMatch[2] === undefined ? {} : { modifiers: keyMatch[2] }) });
      index += ESC.length + keyMatch[0].length;
      continue;
    }
    const stringControl = STRING_CONTROL_SEQUENCE.exec(rest.slice(ESC.length));
    if (stringControl !== null) {
      index += ESC.length + stringControl[0].length;
      continue;
    }
    const csiControl = CSI_CONTROL_SEQUENCE.exec(rest.slice(ESC.length));
    if (csiControl !== null) {
      index += ESC.length + csiControl[0].length;
      continue;
    }
    // Legacy Alt+Enter: xterm's "8th-bit meta" convention prefixes a
    // modified key with a bare ESC (no `[`/`O` CSI/SS3 introducer), so
    // Alt+Enter arrives as `ESC` immediately followed by CR or LF. This is
    // the primary Alt+Enter/Shift+Enter encoding this module recognizes;
    // the kitty keyboard protocol's `CSI 13 ; 2|3 u` form above is the other
    // (a terminal in kitty extended-keyboard mode sends that instead).
    // Ambiguous only in the byte-identical case of a bare Escape keypress
    // immediately followed by a separate Enter keypress inside the same
    // input chunk — an edge case this module accepts, documented rather
    // than hidden, per this record's own scope note on terminal encodings
    // genuinely differing here.
    if (rest[ESC.length] === "\r" || rest[ESC.length] === "\n") {
      keys.push({ key: "newline" });
      index += ESC.length + 1;
      continue;
    }
    // Unrecognized escape byte (a bare Escape keypress, or a sequence this
    // module doesn't know) — pass through unchanged so the existing
    // "ch === ESC" handling in the raw stdin loop keeps working.
    text += chunk[index];
    index += 1;
  }
  return { keys, mouse, text, pastes };
}

const SGR_MOUSE_COMPLETE = /^\[<\d+;\d+;\d+[Mm]$/;
const MAX_PENDING_SEQUENCE_BYTES = 128;

/**
 * Stateful adapter for raw stdin streams. Node/Bun may split one terminal CSI
 * report over arbitrary data chunks, so callers that consume a stream rather
 * than OpenTUI's already-tokenized key events must retain an incomplete suffix
 * and call `flush()` after their normal Escape timeout or at stream end.
 */
export class TerminalInputDecoder {
  private pending = "";

  decode(chunk: string): DecodedTerminalInput {
    // A bare Escape is held for one decoder turn so an explicitly encoded
    // Alt+Enter can remain compatible. If the next transport chunk begins
    // with a newline, however, it is overwhelmingly the two ordinary keys
    // Escape then Enter (especially during startup replay), not one fused
    // Alt+Enter event. Preserve that event boundary here; same-chunk
    // ESC+newline remains handled by decodeTerminalInput's legacy path.
    if (this.pending === String.fromCharCode(27) && (chunk.startsWith("\r") || chunk.startsWith("\n"))) {
      this.pending = "";
      const escape = decodeTerminalInput(String.fromCharCode(27));
      const next = decodeTerminalInput(chunk);
      return {
        keys: [...escape.keys, ...next.keys],
        mouse: [...escape.mouse, ...next.mouse],
        text: escape.text + next.text,
        pastes: [...(escape.pastes ?? []), ...(next.pastes ?? [])],
      };
    }
    const input = this.pending + chunk;
    const incomplete = incompleteTerminalSuffix(input);
    if (incomplete !== null) {
      this.pending = incomplete;
      return decodeTerminalInput(input.slice(0, input.length - incomplete.length));
    }
    this.pending = "";
    return decodeTerminalInput(input);
  }

  flush(): DecodedTerminalInput {
    const input = this.pending;
    this.pending = "";
    return decodeTerminalInput(input);
  }
}

function incompleteTerminalSuffix(input: string): string | null {
  // Find the earliest still-open control sequence. Looking only at the last
  // ESC mistakes a string terminator (`ESC\`) for the start of a new escape
  // and exposes the whole preceding DCS/OSC payload to the app router.
  for (let start = 0; start < input.length; start += 1) {
    if (input[start] !== ESC) continue;
    const suffix = input.slice(start);
    if (suffix.length > MAX_PENDING_SEQUENCE_BYTES) continue;
    const rest = suffix.slice(ESC.length);
    if (rest.startsWith("]") || rest.startsWith("P") || rest.startsWith("X") || rest.startsWith("^") || rest.startsWith("_")) {
      if (STRING_CONTROL_SEQUENCE.exec(rest) === null) return suffix;
      continue;
    }
    if (CSI_KEY_SEQUENCES.some(([sequence]) => rest === sequence) || SGR_MOUSE_COMPLETE.test(rest)) continue;
    if (rest.length === 0 || CSI_KEY_SEQUENCES.some(([sequence]) => sequence.startsWith(rest))) return suffix;
    if (TERMINAL_RESPONSE_PREFIX.test(rest)) return suffix;
    if (/^\[(?:[0-9;? >]*[ -/]*)?$/.test(rest)) return suffix;
    if (rest.startsWith("[<") && /^\[<\d*(?:;\d*)?(?:;\d*)?[Mm]?$/.test(rest)) return suffix;
  }
  return null;
}

/** Wheel ticks move the active screen's scroll offset by this many lines per tick — a page is a much larger, explicit PageUp/PageDown action. */
const WHEEL_SCROLL_LINES = 3;

/**
 * Route one mouse event to a `UiIntent`, or `null` if this layer cannot
 * resolve one.
 *
 * Wheel events need no cross-lane input: they always target whichever
 * screen the caller has focused (`update.ts`'s `scroll_by` handler reads
 * `model.screen` itself), because today's renderer only ever puts live
 * screen content in the primary pane (`renderer.ts`'s `primaryPaneContent` —
 * `layout.panes[0]` is the only pane `resolveActiveScreen` is called for),
 * so "which screen is under the wheel" is not yet a meaningful question.
 *
 * Click/press events return `null` deliberately — hit-testing a terminal
 * (x, y) into "which screen row is this" needs frame geometry this package's
 * input layer does not have. The exact interface this needs from the
 * renderer-port lane: a function shaped like
 * `hitTest(x: number, y: number): { pane_id: string; row_in_content: number } | null`
 * (row_in_content already accounting for that pane's own scroll offset at
 * render time), callable by the composition root (`tui.ts`) once it has
 * both a `MouseEvent` and the last-rendered frame's geometry. Given that
 * result, resolving a concrete row id is this package's job again (the same
 * per-screen `id` extraction `operator-selection.ts`'s `treeNodeIds` already
 * does for the Tree screen), but the hit-test itself cannot be built here.
 */
export function mouseEventToIntent(event: MouseEvent): UiIntent | null {
  if (event.action.kind !== "wheel") return null;
  return { type: "scroll_by", lines: event.action.direction * WHEEL_SCROLL_LINES };
}
