/**
 * Swappable renderer backends (roadmap 4F.5; clean-room-informed —
 * `docs/terminal-emulator-clean-room-report.md`'s "decoupled core/backends"
 * fruit, never its GPU/texture-atlas mechanisms).
 *
 * `Frame` is the canonical, renderer-agnostic scene the TUI's rendering
 * pipeline produces each draw: a fixed-size grid of already-composed text
 * rows (panes, borders, status line), with no ANSI control codes baked in.
 * `renderer.ts#renderScene` builds one from a `RenderProjection`.
 *
 * A `FramePainter` paints that same typed `Frame` to a different target:
 * `TerminalPainter` for the ANSI terminal (wired into `renderer.ts`'s
 * `renderTerminalFrame`, the shared implementation `TuiShell` draws through),
 * `SsePainter` for the web dashboard (`arbor-mcp/src/webui.ts`). Both consume
 * the identical `Frame` — the model/scene layer is 1:1 shared code across
 * terminal and web.
 *
 * A third backend, `JsonPainter` (canonical-JSON, for the MCP resource
 * `arbor://frame`), was retired 2026-08-06. `arbor-mcp/src/frame-resource.ts`
 * already serves that resource correctly by returning a plain `Frame` object
 * straight through the generic MCP resource-serialization path — the same
 * convention every other `arbor://` resource in `resources.ts` uses — and
 * never routed through this module's sink-based `PaintTarget` abstraction at
 * all. `JsonPainter` had no caller consistent with that design, and the one
 * genuine caller (wiring `frame-resource.ts` to build through it instead)
 * lives in `@arbor/mcp`, outside this package.
 */

/** Canonical, renderer-agnostic frame: a fixed grid of composed text rows. */
export interface Frame {
  readonly columns: number;
  readonly rows: readonly string[];
}

/** Sink a `FramePainter` writes its painted output to. */
export interface PaintTarget {
  write(value: string): void | Promise<void>;
}

/** Paints a typed `Frame` to a target. Terminal/SSE backends both implement this. */
export interface FramePainter {
  paint(frame: Frame, target: PaintTarget): void | Promise<void>;
}

/** ESC (0x1B) built via char code, not a source literal, to avoid encoding ambiguity. */
const ESC = String.fromCharCode(27);
const ANSI_RESET = `${ESC}[0m`;

/**
 * ANSI terminal backend. Produces byte-identical output to the pre-4F.5
 * `renderTerminalFrame` string (rows joined by newlines, optionally wrapped
 * in an SGR reset pair) — this is a refactor-extraction, not a behavior
 * change.
 */
export class TerminalPainter implements FramePainter {
  constructor(private readonly options: { readonly color?: boolean } = {}) {}

  paint(frame: Frame, target: PaintTarget): void | Promise<void> {
    const joined = frame.rows.join("\n");
    const out = this.options.color === true ? `${ANSI_RESET}${joined}${ANSI_RESET}` : joined;
    return target.write(out);
  }
}

/** Stable canonical JSON encoding: same key order/shape every call for the same frame. */
export function encodeFrameAsJson(frame: Frame): string {
  return JSON.stringify({ columns: frame.columns, rows: frame.rows });
}

/** SSE backend: frames the same canonical JSON payload as a `frame` server-sent event. */
export class SsePainter implements FramePainter {
  paint(frame: Frame, target: PaintTarget): void | Promise<void> {
    return target.write(`event: frame\ndata: ${encodeFrameAsJson(frame)}\n\n`);
  }
}

/** Adapts a flattened-text sink as a `PaintTarget`; this is not a RendererPort. */
export function paintTargetFromRenderFn(render: (frame: string) => void | Promise<void>): PaintTarget {
  return { write: (value) => render(value) };
}
