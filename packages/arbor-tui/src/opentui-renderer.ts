import { copySelectedTerminalText } from "./selection-copy.js";
/**
 * OpenTUI-backed `RendererPort` (ADR-036, widened by ADR-037) — a SECOND
 * renderer implementation alongside `StdoutRenderer` (`renderer.ts`).
 *
 * Runtime requirement (verified, ADR-036): `@opentui/core`'s native render
 * library only binds under Bun. Constructing this class's renderer (`enter()`)
 * on Node throws "OpenTUI native FFI is not available for this runtime yet".
 * The module itself imports cleanly on Node (no top-level native call), so
 * importing this file does not by itself break a Node process — only
 * instantiating and entering the renderer does.
 *
 * ADR-036 shipped this adapter against `RendererPort.render(frame: string)`:
 * an already-composed, flat string with every pane/cell boundary discarded
 * before the port boundary, so the adapter could only display one opaque
 * `TextRenderable` and had no path to per-pane mouse hit-testing, a native
 * scroll region, or retained-widget diffing. ADR-037 widens the port
 * (`renderer.ts`'s `RenderInput = RenderedFrame`) to also carry a
 * `SceneFrame` (`frame.ts`) — the pane rectangles `layoutWorkspace` already
 * computes and `renderScene` used to throw away. This adapter now consumes
 * that structure for real:
 *
 *   - Given a `RenderedFrame`, it builds one `BoxRenderable` per pane,
 *     positioned/sized from the pane's real rectangle, with a `TextRenderable`
 *     child carrying that pane's own interior content — a native per-pane
 *     composition, not one blob standing in for the whole viewport.
 *   - Each pane's `BoxRenderable` carries a real `onMouseDown` handler.
 *     `@opentui/core`'s native hit-grid (not this module's own arithmetic)
 *     decides which `BoxRenderable` a click's absolute terminal coordinate
 *     belongs to and dispatches the event to it; the handler then translates
 *     the event's absolute `(x, y)` into that pane's local `(row, column)`.
 *     This is the concrete capability the string-only port made impossible
 *     (`tests/opentui-hit-test.test.ts` proves it against a real
 *     `@opentui/core/testing` renderer and a real synthetic mouse click, not
 *     a mock standing in for either).
 *
 * A structured scene with no panes is the explicit full-viewport fallback
 * used by direct renderer tests. Production help travels through the same
 * structured scene as every other overlay; a bare string cannot enter this
 * port and silently discard its scene identity.
 *
 * ADR-036's original limitation — `TextRenderable.content` accepts
 * `StyledText | string` but does not itself ANSI-parse a plain string, so a
 * colored frame's SGR bytes used to show as literal characters — is closed:
 * `ansi-styled-text.ts`'s `ansiToStyledText` converts every `content`
 * assignment below (the no-pane fallback, each pane's content, and the
 * status bar) through a real SGR parser before it reaches `TextRenderable`,
 * so a colored frame (`FrameOptions.color === true`) now paints native
 * fg/bg/attribute cells instead of escape bytes. An uncolored frame carries
 * no SGR and round-trips through the parser as a single unstyled chunk,
 * unchanged from before.
 *
 * A second, new honest limitation (ADR-037): the per-pane path renders each
 * pane's `content` (already height/width-clipped by `renderScene`, matching
 * exactly what the flattened canvas painted into that pane's interior) — it
 * does not yet feed unclamped/overflowing content through `ScrollBoxRenderable`
 * for a native scroll region. `SceneFrame` carries what a scroll region would
 * need (the pane rect, and — once a screen module stops pre-clipping to
 * `pane.rows - 2` — the pane's real content height), but wiring an actual
 * `ScrollBoxRenderable` is future work this record does not claim: this pass
 * proves hit-testing, not scrolling, is the one thing the wider port newly
 * allows. See ADR-037's "Alternatives considered" for why hit-testing was
 * chosen as this pass's demonstrated capability over scrolling.
 *
 * A bake-off against `StdoutRenderer` on an identical, populated scene
 * (real tree rows + a live status bar + a populated notification band —
 * `tests/opentui-bakeoff.test.ts`) found this adapter's per-pane path was
 * already faithful (borders, padding, and column alignment all survive: a
 * pane's `content` is the identical already-aligned string
 * `StdoutRenderer` paints, and `wrapMode: "none"` keeps it from being
 * reflowed), but two whole zones of `SceneFrame` were never read at all —
 * `scene.rows[status_row]` (the live status bar) and, before this pass,
 * nothing painted the notification band either since `renderer.ts` did not
 * yet reserve one. `syncStatusBar` below closes the first gap; the second
 * closes for free once `renderer.ts` starts emitting a `"notifications"`
 * `FramePane` (`bordered: false`), because this adapter already composes
 * every `scene.panes` entry generically.
 */
import {
  BoxRenderable,
  CliRenderEvents,
  createCliRenderer,
  decodePasteBytes,
  RGBA,
  TextRenderable,
  type CliRenderer,
  type CliRendererConfig,
  type KeyEvent,
  type KeyHandler,
  type MouseEvent as OpenTuiMouseEvent,
  type PasteEvent,
  type TerminalCapabilities,
  type ThemeMode,
} from "@opentui/core";
import { ansiToStyledText } from "./ansi-styled-text.js";
import { hitTestFrame, type PaneHit, type SceneFrame } from "./frame.js";
import type { RenderInput, RendererCommitObserver, RendererPort } from "./renderer.js";
import { decodeTerminalInput, SplitReplyHold, TerminalReplyFilter, type DecodedTerminalInput } from "./input-terminal.js";
import type { Notification, NotificationSeverity } from "./types.js";

/** A real mouse-wheel scroll `@opentui/core`'s native mouse pipeline resolved against a pane (OT-5). */
export interface PaneScroll {
  readonly pane_id: string;
  readonly direction: "up" | "down" | "left" | "right";
  readonly delta: number;
}

export type TerminalFocusState = "unknown" | "focused" | "blurred";
export type NotificationMechanism = "off" | "terminal";
export type NotificationCondition = "unfocused" | "always";

export interface TerminalProfileObservation {
  readonly capabilities: TerminalCapabilities | null;
  readonly theme_mode: ThemeMode;
  readonly theme_source: "terminal" | "timeout_default";
}

export interface TerminalNotificationObservation {
  readonly notification_id: string;
  readonly focus: TerminalFocusState;
  readonly emitted: boolean;
}

export interface OpenTuiRendererOptions {
  /** Forwarded to `createCliRenderer` when this adapter owns renderer construction. */
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly width?: number;
  readonly height?: number;
  readonly cliRendererConfig?: Omit<CliRendererConfig, "stdin" | "stdout" | "width" | "height">;
  /**
   * Inject an already-constructed `CliRenderer` (e.g. `@opentui/core/testing`'s
   * `createTestRenderer().renderer`) instead of having this adapter build one
   * via `createCliRenderer`. When supplied, `restore()` does not destroy it —
   * the injector owns that lifecycle (matches `createTestRenderer`'s own
   * `afterEach(() => renderer.destroy())` convention).
   */
  readonly renderer?: CliRenderer;
  /**
   * Fires on every real mouse-down `@opentui/core`'s native hit-grid routes
   * to one of this adapter's per-pane `BoxRenderable`s (ADR-037). Absent when
   * the caller has no use for pane hit-testing — this adapter still renders
   * correctly without it, the callback is purely an observation seam
   * (exactly how `tests/opentui-hit-test.test.ts` observes it).
   */
  readonly onPaneHit?: (hit: PaneHit) => void;
  /**
   * Fires on every real mouse-wheel scroll `@opentui/core`'s native mouse
   * pipeline routes to one of this adapter's per-pane `BoxRenderable`s
   * (OT-5). `direction`/`delta` mirror `ScrollInfo` (the native mouse
   * parser's own shape) so a caller can map it to a `scroll_by` intent the
   * same way it already does for the raw-SGR wheel path
   * (`input-terminal.ts#mouseEventToIntent`) without this package needing to
   * duplicate that mapping.
   */
  readonly onPaneScroll?: (scroll: PaneScroll) => void;
  readonly notificationMechanism?: NotificationMechanism;
  readonly notificationCondition?: NotificationCondition;
  readonly notificationMinimumSeverity?: NotificationSeverity;
  readonly notificationTitle?: string;
  readonly themeModeTimeoutMs?: number;
  readonly onTerminalProfile?: (observation: TerminalProfileObservation) => void;
  readonly onNotificationAttempt?: (observation: TerminalNotificationObservation) => void;
}

/**
 * OpenTUI's Kitty-keyboard events are semantic first: for named keys such
 * as Escape, `raw` is not guaranteed to contain the legacy byte sequence.
 * Normalize those keys before falling back to the raw/sequence decoder so
 * the native renderer has the same control contract as the stdout path.
 */
export function decodeOpenTuiKeyEvent(event: Pick<KeyEvent, "name" | "raw" | "sequence" | "ctrl" | "meta" | "shift">): DecodedTerminalInput {
  const name = event.name.toLowerCase();
  const empty = { mouse: [] as const };
  if (name === "escape" || name === "esc") return { keys: [], ...empty, text: "\u001b" };
  if (name === "enter" || name === "return") return { keys: [], ...empty, text: "\r" };
  if (name === "tab") {
    const modifiers = [event.ctrl ? "ctrl" : null, event.meta ? "alt" : null, event.shift ? "shift" : null]
      .filter((modifier): modifier is "ctrl" | "alt" | "shift" => modifier !== null);
    return modifiers.length === 0
      ? { keys: [], ...empty, text: "\t" }
      : { keys: [{ key: "tab", modifiers }], ...empty, text: "" };
  }
  if (name === "backspace") return { keys: [], ...empty, text: "\u007f" };
  if (["up", "down", "left", "right", "home", "end", "pageup", "pagedown", "delete"].includes(name)) {
    const modifiers = [event.ctrl ? "ctrl" : null, event.meta ? "alt" : null, event.shift ? "shift" : null]
      .filter((modifier): modifier is "ctrl" | "alt" | "shift" => modifier !== null);
    return { keys: [{ key: name, ...(modifiers.length === 0 ? {} : { modifiers }) }], ...empty, text: "" };
  }
  // Function keys (F1-F12; the catalog's own binding format, `default-
  // catalog.ts`'s "f6"/"shift+f6"/"shift+f10", is exactly this name) MUST be
  // decoded from OpenTUI's own semantic `name`+modifier fields, the same as
  // the named-key list above, rather than falling through to the legacy
  // `raw`/`sequence` decoder below: `useKittyKeyboard` (this file's
  // `enter()`) reports these as CSI-u sequences whose raw bytes are not the
  // legacy `\x1b[21;2~` form `decodeTerminalInput`'s table expects, so
  // Shift+F10 silently failed to decode into any key at all on a real
  // OpenTUI capture even though `name`/`shift` were always populated
  // correctly (verified against @opentui/core's own kitty key map).
  if (/^f(1[0-9]|2[0-4]|[1-9])$/u.test(name)) {
    const modifiers = [event.ctrl ? "ctrl" : null, event.meta ? "alt" : null, event.shift ? "shift" : null]
      .filter((modifier): modifier is "ctrl" | "alt" | "shift" => modifier !== null);
    return { keys: [{ key: name, ...(modifiers.length === 0 ? {} : { modifiers }) }], ...empty, text: "" };
  }
  // OpenTUI reports printable modified keys with the printable raw byte
  // (`p` for Ctrl+P) plus boolean modifier fields. Re-decoding only the raw
  // byte loses the modifier and turns palette/navigation chords into ordinary
  // text. Preserve the native semantic modifier contract before the legacy
  // decoder fallback; this keeps Ctrl+P identical across stdout and OpenTUI.
  const modifiers = [event.ctrl ? "ctrl" : null, event.meta ? "alt" : null, event.shift ? "shift" : null]
    .filter((modifier): modifier is "ctrl" | "alt" | "shift" => modifier !== null);
  if (modifiers.length > 0 && name.length === 1) {
    // Native keyboard events report the physical `/` key plus Shift for a
    // literal `?`. Normalize the produced character before the catalog sees
    // it, otherwise the documented `?` Help binding is unreachable on the
    // OpenTUI path even though the same key works through raw stdin.
    const key = event.shift && name === "/" ? "?" : name;
    return { keys: [{ key, modifiers }], ...empty, text: "" };
  }
  // Preserve an unmodified printable reported by OpenTUI as text.  Its raw
  // field is transport-oriented and may be a stale/coalesced sequence when a
  // PTY sends a fast literal burst; feeding that field back through the
  // terminal decoder can turn ordinary task prose into navigation actions.
  // The native event name is already the authoritative one-character key.
  if (name.length === 1 && !event.ctrl && !event.meta) {
    const text = event.shift && name >= "a" && name <= "z" ? name.toUpperCase()
      : event.shift && name === "/" ? "?" : name;
    return { keys: [], ...empty, text };
  }
  return decodeTerminalInput(event.raw || event.sequence);
}

const FRAME_TEXT_ID = "arbor-tui-frame";
const STATUS_BAR_ID = "arbor-tui-status-bar";
const paneBoxId = (id: string): string => `arbor-tui-pane-${id}`;
const paneContentId = (id: string): string => `arbor-tui-pane-${id}-content`;

/**
 * Real-terminal `RendererPort` backed by `@opentui/core`'s native Zig
 * renderer. `enter()`/`restore()` own the renderer's lifecycle exactly as
 * `StdoutRenderer` owns the raw stream's.
 */
export class OpenTuiRenderer implements RendererPort {
  private renderer: CliRenderer | null;
  private readonly ownsRenderer: boolean;
  /** Full-viewport fallback for a structured input whose scene has no panes. */
  private text: TextRenderable | null = null;
  /** The full-width status-bar row (`SceneFrame.status_row`), composed as its own `TextRenderable` — see `syncStatusBar`. */
  private statusBar: TextRenderable | null = null;
  private readonly paneBoxes = new Map<string, BoxRenderable>();
  private readonly paneContents = new Map<string, TextRenderable>();
  private readonly seenNotificationIds = new Set<string>();
  private readonly notificationObservations: TerminalNotificationObservation[] = [];
  private readonly pendingCommitObservers = new Set<RendererCommitObserver>();
  private focusState: TerminalFocusState = "unknown";
  private terminalProfile: TerminalProfileObservation | null = null;

  constructor(private readonly options: OpenTuiRendererOptions = {}) {
    this.renderer = options.renderer ?? null;
    this.ownsRenderer = options.renderer === undefined;
  }

  async enter(): Promise<void> {
    if (this.text !== null) return;
    if (this.renderer === null) {
      this.renderer = await createCliRenderer({
        stdin: this.options.stdin,
        stdout: this.options.stdout,
        width: this.options.width,
        height: this.options.height,
        exitOnCtrlC: false,
        // Ask the terminal for the kitty keyboard protocol, as OpenCode does
        // on this same library (`packages/tui/src/app.tsx`:
        // `useKittyKeyboard: {}`). Without it a terminal encodes Ctrl+A and
        // Ctrl+Shift+A as the identical byte 0x01, so all twelve
        // `ctrl+shift+<letter>` bindings in `default-catalog.ts` are
        // unreachable and ten of them silently invoke the Ctrl+<letter>
        // action instead -- Ctrl+Shift+C ("copy focused row") reaching
        // `cmd:tui.stop_and_exit` being the worst of them (EC-027).
        useKittyKeyboard: {},
        ...this.options.cliRendererConfig,
      });
    }
    const renderer = this.renderer;
    // Explicit opaque cells, not the terminal's default background token:
    // Ghostty may intentionally make its default background translucent.
    renderer.setBackgroundColor("#000000");
    this.text = new TextRenderable(renderer, {
      id: FRAME_TEXT_ID,
      position: "absolute",
      left: 0,
      top: 0,
      width: renderer.width,
      height: renderer.height,
      wrapMode: "none",
      bg: "#000000",
      content: "",
    });
    renderer.root.add(this.text);
    renderer.on("resize", this.onResize);
    renderer.on(CliRenderEvents.FOCUS, this.onFocus);
    renderer.on(CliRenderEvents.BLUR, this.onBlur);
    renderer.on(CliRenderEvents.FRAME, this.onFrameCommitted);
    const timeoutMs = this.options.themeModeTimeoutMs ?? (this.ownsRenderer ? 1_000 : 1);
    const observedTheme = await renderer.waitForThemeMode(timeoutMs);
    this.terminalProfile = {
      capabilities: renderer.capabilities,
      theme_mode: observedTheme ?? "dark",
      theme_source: observedTheme === null ? "timeout_default" : "terminal",
    };
    this.options.onTerminalProfile?.(this.terminalProfile);
  }

  publishNotifications(notifications: readonly Notification[]): void {
    for (const notification of notifications) {
      if (this.seenNotificationIds.has(notification.id)) continue;
      this.seenNotificationIds.add(notification.id);
      if (!this.shouldNotify(notification.severity) || this.renderer === null) continue;
      const emitted = this.renderer.triggerNotification(notification.message, this.options.notificationTitle ?? "revoy2");
      const observation = { notification_id: notification.id, focus: this.focusState, emitted } as const;
      this.notificationObservations.push(observation);
      if (this.notificationObservations.length > 100) this.notificationObservations.shift();
      this.options.onNotificationAttempt?.(observation);
    }
  }

  render(input: RenderInput): void {
    if (this.text === null || this.renderer === null) {
      throw new Error("OpenTuiRenderer.render called before enter()");
    }
    if (input.scene.panes.length === 0) {
      this.clearPanes();
      this.clearStatusBar();
      // Assignment, not `.add()`: TextRenderable.content replaces the whole
      // buffer (Text.d.ts's `set content`), matching StdoutRenderer's model
      // of one authoritative frame per draw rather than an accumulating log.
      this.text.content = ansiToStyledText(input.text);
      this.renderer.requestRender();
      return;
    }
    // A structured frame is rendered natively, pane by pane — the full-
    // viewport fallback text carries nothing while a structured frame is
    // active, so the two composition paths never draw on top of each other.
    this.text.content = "";
    this.syncPanes(input.scene);
    this.syncStatusBar(input.scene);
    this.renderer.requestRender();
  }

  /**
   * Binds one requested frame to OpenTUI's native `FRAME` event. OpenTUI may
   * coalesce multiple `requestRender()` calls into one native frame; that one
   * frame contains every pending mutation, so all observers queued before it
   * are committed together. Merely returning from `render()` never fires the
   * observer.
   */
  renderObserved(input: RenderInput, observer: RendererCommitObserver): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const observed: RendererCommitObserver = {
        committed: () => { observer.committed(); resolve(); },
        abandoned: (reason) => { observer.abandoned(reason); resolve(); },
      };
      this.pendingCommitObservers.add(observed);
      try {
        this.render(input);
      } catch (error) {
        this.pendingCommitObservers.delete(observed);
        observer.abandoned(`native renderer rejected the frame before commit: ${error instanceof Error ? error.message : String(error)}`);
        reject(error);
      }
    });
  }

  restore(): void {
    this.abandonPendingCommits("native renderer restored before the requested frame committed");
    this.clearPanes();
    this.clearStatusBar();
    if (this.text !== null) {
      this.renderer?.root.remove(this.text);
      this.text.destroy();
      this.text = null;
    }
    if (this.renderer !== null) {
      this.renderer.off("resize", this.onResize);
      this.renderer.off(CliRenderEvents.FOCUS, this.onFocus);
      this.renderer.off(CliRenderEvents.BLUR, this.onBlur);
      this.renderer.off(CliRenderEvents.FRAME, this.onFrameCommitted);
      if (this.ownsRenderer) this.renderer.destroy();
    }
    if (this.ownsRenderer) this.renderer = null;
  }

  /**
   * OpenTUI's own keyboard/paste pipeline (OT-2, ADR-036/037 follow-up).
   * `createCliRenderer`'s `setupTerminal()` puts `stdin` in raw mode and
   * attaches its own stdin listener — the renderer's own docstring calls
   * this "exclusive ownership" of the given stream. A caller MUST NOT also
   * attach a second raw `stdin.on("data", ...)` listener once this
   * `KeyHandler` is in use: Node delivers every `data` chunk to every
   * registered listener, so a second listener would double-parse each
   * keystroke past `enter()`, independently and uncoordinated with this one
   * (`packages/arbor-mcp/src/tui.ts`'s `runTuiUnsafe` is the one caller that
   * must branch on this — see its own doc comment). Returns `null` before
   * `enter()` has run.
   */
  keyInput(): KeyHandler | null { return this.renderer?.keyInput ?? null; }

  /**
   * Subscribes to this renderer's OWN keyboard/paste pipeline (OT-2) and
   * bridges it to the exact same `DecodedTerminalInput` shape
   * `input-terminal.ts#decodeTerminalInput` already produces for the raw
   * `stdin.on("data", ...)` path — so a caller (`arbor-mcp/src/tui.ts`) can
   * reuse its one existing decoded-input processing pipeline for both
   * renderers without ever importing `@opentui/core` itself (this package's
   * dependency boundary: `@arbor/mcp` depends on `@arbor/tui`, never
   * `@opentui/core` directly).
   *
   * `KeyEvent.raw` is the exact raw byte sequence OpenTUI's own parser
   * already isolated for that one key — running it back through
   * `decodeTerminalInput` is an adapter over an already-delivered, already-
   * isolated event, not a second competing parse of the live stream (the
   * double-parse this method exists to retire: see this class's own
   * `keyInput()` doc comment).
   *
   * Paste is bridged separately (`PasteEvent`/`decodePasteBytes`) rather
   * than folded into `onDecoded`'s `.text`: a real terminal paste can embed
   * literal newlines, and the per-character consumer of `.text` today
   * treats `\n`/`\r` as "submit/confirm" for whichever text overlay is
   * focused — silently truncating a pasted multi-line task description at
   * its first line. A caller that wants paste-safe insertion (append the
   * WHOLE pasted string to the focused buffer as one atomic edit, never
   * interpreting an embedded newline as Enter) needs the paste text
   * distinguished from ordinary keystrokes; this is exactly what
   * `onPaste` gives it.
   *
   * Returns `null` before `enter()` has run (same guard as `keyInput()`);
   * otherwise returns an unsubscribe function, mirroring the
   * `stdin.on`/`stdin.off` pairing the raw-stdin path already uses.
   */
  onNativeInput(onDecoded: (decoded: DecodedTerminalInput) => void, onPaste: (text: string) => void): (() => void) | null {
    const keyInput = this.keyInput();
    if (keyInput === null) return null;
    // OpenTUI deliberately holds a lone legacy ESC byte while it could still
    // become an Alt-prefixed sequence. During startup capability probing that
    // timeout can remain paused, making the first Escape appear dead until a
    // second key arrives. Observe ONLY a one-byte ESC chunk as a latency fast
    // lane; every other byte remains exclusively owned by OpenTUI. The later
    // semantic Escape emitted by its parser is counted and suppressed, so one
    // physical key still produces exactly one decoded action.
    const rawInput = this.options.stdin ?? (this.ownsRenderer ? process.stdin : null);
    let pendingRawEscapes = 0;
    let semanticEscapeThisTurn = false;
    const replyFilter = new TerminalReplyFilter();
    const deliver = (event: KeyEvent): void => {
      const decoded = decodeOpenTuiKeyEvent(event);
      if (decoded.text === "\u001b" && decoded.keys.length === 0) {
        semanticEscapeThisTurn = true;
        queueMicrotask(() => { semanticEscapeThisTurn = false; });
        // The ESC just went through as a keystroke. If a reply's introducer
        // follows after a gap, the hold below is what catches it (EC-048).
        splitHold.noteLoneEscape();
        if (pendingRawEscapes > 0) { pendingRawEscapes -= 1; return; }
      }
      onDecoded(decoded);
    };
    // A reply whose ESC arrived alone and whose payload trickles in afterwards
    // is invisible to `replyFilter` (same-burst grammar) and was typed into the
    // composer under this renderer (EC-048). Hold it on timing, exactly as the
    // raw-stdin path does (EC-044).
    const splitHold = new SplitReplyHold<KeyEvent>({
      textOf: (event) => event.raw || event.sequence || "",
      release: (events) => { for (const event of events) deliver(event); },
    });
    const onKeypress = (event: KeyEvent): void => {
      const renderer = this.renderer;
      if (renderer !== null && copySelectedTerminalText(event, {
        selectedText: () => renderer.getSelection()?.getSelectedText() ?? null,
        copyText: (text) => renderer.copyToClipboardOSC52(text),
      })) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      // A terminal capability reply reaches this path already shattered into
      // one printable keypress per byte (EC-010/EC-017). Reassemble and drop
      // it BEFORE decoding, on the raw bytes, because the introducer is not
      // always text: `parseKeypress` reports the `P` of tmux's XTVERSION
      // answer as Shift+p, so a filter reading `decoded.text` would miss it
      // and pass the rest of the payload through as typing.
      if (replyFilter.consume(event.raw || event.sequence || "")) return;
      if (splitHold.offer(event)) return;
      deliver(event);
    };
    const onRawData = (chunk: Buffer | string): void => {
      const raw = chunk.toString();
      if (raw !== "\u001b") return;
      queueMicrotask(() => {
        if (semanticEscapeThisTurn) return;
        pendingRawEscapes += 1;
        splitHold.noteLoneEscape();
        onDecoded({ keys: [], mouse: [], text: "\u001b" });
      });
    };
    const onPasteEvent = (event: PasteEvent): void => { onPaste(decodePasteBytes(event.bytes)); };
    keyInput.on("keypress", onKeypress);
    keyInput.on("paste", onPasteEvent);
    rawInput?.on("data", onRawData);
    return () => {
      splitHold.reset();
      keyInput.off("keypress", onKeypress);
      keyInput.off("paste", onPasteEvent);
      rawInput?.off("data", onRawData);
    };
  }

  terminalFocus(): TerminalFocusState { return this.focusState; }
  observedTerminalProfile(): TerminalProfileObservation | null { return this.terminalProfile; }
  observedNotificationAttempts(): readonly TerminalNotificationObservation[] { return this.notificationObservations.map((item) => ({ ...item })); }

  private readonly onFocus = (): void => { this.focusState = "focused"; };
  private readonly onBlur = (): void => { this.focusState = "blurred"; };
  private readonly onFrameCommitted = (): void => {
    const observers = [...this.pendingCommitObservers];
    this.pendingCommitObservers.clear();
    for (const observer of observers) observer.committed();
  };

  private abandonPendingCommits(reason: string): void {
    const observers = [...this.pendingCommitObservers];
    this.pendingCommitObservers.clear();
    for (const observer of observers) observer.abandoned(reason);
  }

  private shouldNotify(severity: NotificationSeverity): boolean {
    if ((this.options.notificationMechanism ?? "terminal") === "off") return false;
    const minimum = this.options.notificationMinimumSeverity ?? "warning";
    const rank: Record<NotificationSeverity, number> = { info: 0, warning: 1, error: 2 };
    if (rank[severity] < rank[minimum]) return false;
    return (this.options.notificationCondition ?? "unfocused") === "always" || this.focusState === "blurred";
  }

  /**
   * Creates/updates one `BoxRenderable` + interior `TextRenderable` per pane
   * in `scene.panes`, removes any pane renderable no longer present (a
   * workspace switch or resize can drop or add panes between draws), and
   * (re)attaches each box's `onMouseDown` to the pane's *current* rectangle
   * — captured in the closure at sync time, not read off `this` at event
   * time, so a hit reported mid-resize reflects the rectangle that was
   * actually on screen when this sync ran.
   */
  private syncPanes(scene: SceneFrame): void {
    const renderer = this.renderer;
    if (renderer === null) return;
    const seen = new Set<string>();
    for (const [paneIndex, pane] of scene.panes.entries()) {
      seen.add(pane.id);
      // `rows` deliberately excludes an ambient status/notification overlay
      // for hit testing, while the flattened stdout canvas still paints the
      // pane through that overlay and then overwrites it. Keep those two
      // geometries explicit: otherwise an anchored composer loses its final
      // `renderScene` has already removed the reserved notification/status
      // rows from `pane.rows`. Use that retained geometry for the native box
      // as well; using the optional pre-reservation paint height lets a pane's
      // bottom border cover the live status bar in the actual OpenTUI buffer.
      const paintRows = pane.rows;
      // `pane.bordered === false` (frame.ts, ADR-037 follow-up) marks an
      // ambient strip — the notification band — that is real, hit-testable
      // geometry but never a bordered box; every real workspace pane leaves
      // `bordered` unset and keeps the original size-only rule.
      const bordered = pane.columns >= 2 && paintRows >= 2 && pane.bordered !== false;
      let box = this.paneBoxes.get(pane.id);
      if (box === undefined) {
        box = new BoxRenderable(renderer, {
          id: paneBoxId(pane.id),
          position: "absolute",
          left: pane.x,
          top: pane.y,
          width: pane.columns,
          height: paintRows,
          border: bordered,
          title: pane.title,
          // Flat scene composition replaces blank cells too. A transparent
          // native box lets an overlaid inspector inherit underlying text.
          backgroundColor: RGBA.fromHex("#000000"),
        });
        renderer.root.add(box);
        this.paneBoxes.set(pane.id, box);
      } else {
        box.left = pane.x;
        box.top = pane.y;
        box.width = pane.columns;
        box.height = paintRows;
      }
      // Retained root children otherwise keep their creation order across
      // scene changes, which is not necessarily the current paint order.
      box.zIndex = paneIndex * 2;
      const onPaneMouseDown = (event: OpenTuiMouseEvent): void => {
        const hit = hitTestFrame(scene, { column: event.x, row: event.y });
        if (hit !== null) this.options.onPaneHit?.(hit);
      };
      const onPaneMouseScroll = (event: OpenTuiMouseEvent): void => {
        if (event.scroll === undefined) return;
        const hit = hitTestFrame(scene, { column: event.x, row: event.y });
        if (hit !== null) this.options.onPaneScroll?.({ pane_id: hit.pane_id, direction: event.scroll.direction, delta: event.scroll.delta });
      };
      // Registered on the box AND its content sibling, not the box alone:
      // both are added directly to `renderer.root` (not nested — see the
      // content block below), so a click on the *interior* hits the content
      // TextRenderable's own native hit-grid cell, not the box underneath
      // it, and mouse events do not bubble between root siblings (only up a
      // parent chain). One shared closure, two registrations, is simpler and
      // more robust than reasoning about nested-child coordinate offsets.
      box.onMouseDown = onPaneMouseDown;
      box.onMouseScroll = onPaneMouseScroll;

      const contentLeft = bordered ? pane.x + 1 : pane.x;
      const contentTop = bordered ? pane.y + 1 : pane.y;
      const contentWidth = Math.max(1, bordered ? pane.columns - 2 : pane.columns);
      const contentHeight = Math.max(1, bordered ? paintRows - 2 : paintRows);
      const contentText = ansiToStyledText(pane.content.join("\n"));
      let content = this.paneContents.get(pane.id);
      if (content === undefined) {
        content = new TextRenderable(renderer, {
          id: paneContentId(pane.id),
          position: "absolute",
          left: contentLeft,
          top: contentTop,
          width: contentWidth,
          height: contentHeight,
          wrapMode: "none",
          content: contentText,
        });
        renderer.root.add(content);
        this.paneContents.set(pane.id, content);
      } else {
        content.left = contentLeft;
        content.top = contentTop;
        content.width = contentWidth;
        content.height = contentHeight;
        content.content = contentText;
      }
      content.zIndex = paneIndex * 2 + 1;
      content.onMouseDown = onPaneMouseDown;
      content.onMouseScroll = onPaneMouseScroll;
    }
    for (const [id, box] of [...this.paneBoxes]) {
      if (seen.has(id)) continue;
      renderer.root.remove(box);
      box.destroy();
      this.paneBoxes.delete(id);
      const content = this.paneContents.get(id);
      if (content !== undefined) {
        renderer.root.remove(content);
        content.destroy();
        this.paneContents.delete(id);
      }
    }
  }

  /**
   * Composes the full-width status-bar row (`SceneFrame.status_row`) as its
   * own `TextRenderable`, sourced from the already-composed flat row
   * (`scene.rows[status_row]`) rather than re-deriving it — `renderer.ts`'s
   * `renderScene` is the single place that knows how to build that row
   * (campaign/phase/events/budget/epoch/model, ADR-020 palette), and this
   * adapter must not duplicate that composition, only display it. This is
   * what closes the bake-off gap against `StdoutRenderer`: before this, the
   * structured-frame path only ever consumed `scene.panes` and never read
   * `scene.rows` at all, so a real, live status bar existed in every scene
   * this adapter was handed and was simply never painted.
   *
   * Same as pane content (this file's top docstring): the row can carry
   * embedded SGR when the scene was built with `color: true`, and this path
   * runs it through `ansiToStyledText` before assigning it, so the row's
   * palette (ADR-020) paints as real native cells rather than literal escape
   * bytes.
   */
  private syncStatusBar(scene: SceneFrame): void {
    const renderer = this.renderer;
    if (renderer === null) return;
    if (scene.status_row === null) {
      this.clearStatusBar();
      return;
    }
    const text = ansiToStyledText(scene.rows[scene.status_row] ?? "");
    if (this.statusBar === null) {
      this.statusBar = new TextRenderable(renderer, {
        id: STATUS_BAR_ID,
        position: "absolute",
        left: 0,
        top: scene.status_row,
        width: scene.status_columns ?? scene.columns,
        height: 1,
        wrapMode: "none",
        content: text,
      });
      renderer.root.add(this.statusBar);
    } else {
      this.statusBar.top = scene.status_row;
      this.statusBar.width = scene.status_columns ?? scene.columns;
      this.statusBar.content = text;
    }
    this.statusBar.zIndex = scene.panes.length * 2;
  }

  private clearStatusBar(): void {
    if (this.statusBar === null) return;
    this.renderer?.root.remove(this.statusBar);
    this.statusBar.destroy();
    this.statusBar = null;
  }

  private clearPanes(): void {
    const renderer = this.renderer;
    for (const [id, box] of [...this.paneBoxes]) {
      if (renderer !== null) renderer.root.remove(box);
      box.destroy();
      this.paneBoxes.delete(id);
    }
    for (const [id, content] of [...this.paneContents]) {
      if (renderer !== null) renderer.root.remove(content);
      content.destroy();
      this.paneContents.delete(id);
    }
  }

  private readonly onResize = (): void => {
    if (this.text === null || this.renderer === null) return;
    this.text.width = this.renderer.width;
    this.text.height = this.renderer.height;
  };
}
