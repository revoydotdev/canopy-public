import { DEFAULT_OUTPUT_POLICY, abbreviateOutput, type OutputBudget } from "@arbor/core";
import { layoutWorkspace, type NavigationModel, type PaneRect } from "./navigation.js";
import type { AppModel, Notification } from "./types.js";
import { availableScreens } from "./screens/screen.js";
import { TerminalPainter, paintTargetFromRenderFn } from "./painter.js";
import { renderStatusBar, deriveStatusBarZones, type StatusBarZones } from "./status-bar.js";
import { computeShellLayout, type ShellLayoutRect, type ShellRailRequest } from "./layout.js";
import {
  DEFAULT_NOTIFICATION_BAND_ROWS,
  paletteContextForModel,
  paletteDisclosure,
  paletteFooterHint,
  paletteView,
  renderNotificationBand,
  renderPaletteRows,
  windowedNotifications,
} from "./overlays.js";
import type { InputCatalog } from "./input-catalog.js";
import type { ColorMode, RunTheme } from "./theme.js";
import { clipDisplay, displayCells, displayWidth, sanitizeUntrustedTerminalText, wrapDisplay } from "./widgets.js";
import { clipLabelWithEllipsis } from "./screens/region.js";
import type { FramePane, SceneFrame } from "./frame.js";
import { cursorLineInfo } from "./text-buffer.js";
import { vimModeLabel } from "./terminal-editor.js";
import { clipAnsi, spliceAnsiColumn, stripAnsi } from "./player-piano.js";
import { consoleScreen, consoleInspectorDiagnostics } from "./screens/console.js";
import { projectResponsiveSidebar, renderResponsiveSidebar, sidebarDocumentRows, sidebarAdrRows, resolveRailRenderOptions, RESPONSIVE_SIDEBAR_WIDTH, type ResponsiveSidebarProjection } from "./responsive-sidebar.js";
import { projectUctHeader, type UctHeaderNode } from "./uct-header.js";
import { stackHorizontal } from "./screens/region.js";
import { contextMenuItems, M7_THEME_TOKENS } from "./interaction-polish.js";
import { focusBorderGlyphs, semanticGlyph } from "./theme.js";

export interface RenderProjection {
  readonly app: AppModel;
  readonly navigation: NavigationModel;
  /** Already-authorized display material. Raw evidence retrieval is not a TUI concern. */
  readonly output: string | RenderOutput;
  /** The live, configured command catalog used by the model-owned help overlay. */
  readonly help_catalog?: InputCatalog;
  /** Incomplete catalog chord owned by the one input router, for truthful footer hints. */
  readonly palette_pending_chord?: readonly string[];
}
export interface RenderOutput { readonly content: string; readonly evidence_pointer?: string; }

/**
 * One drawn frame, carrying both the flattened text a `string`-only renderer
 * (`StdoutRenderer`) paints and the structured `SceneFrame` a structure-aware
 * renderer (`OpenTuiRenderer`, ADR-037) needs for hit-testing or a native
 * scroll region. `text` is byte-identical to what `renderTerminalFrame` has
 * always produced — `paintScene` is the same `TerminalPainter` composition,
 * only extracted so `TuiShell` can build the scene once and hand both forms
 * to `render()` instead of computing the scene twice.
 */
export interface RenderedFrame {
  readonly text: string;
  readonly scene: SceneFrame;
}

/**
 * `RendererPort.render`'s input (ADR-037; supersedes ADR-011 O4's
 * string-only contract). Every draw through `TuiShell` sends this structured
 * frame. A no-pane scene is the explicit full-viewport fallback for a
 * renderer that has no pane geometry to compose; a bare string is not a
 * renderer input and therefore cannot silently discard scene identity.
 */
export type RenderInput = RenderedFrame;

/**
 * A renderer-owned presentation boundary. `committed` may fire only when the
 * native renderer reports that the requested frame was actually committed;
 * disposing or replacing the renderer before that point must call
 * `abandoned` instead. A completed `render()` invocation is not a commit.
 */
export interface RendererCommitObserver {
  committed(): void;
  abandoned(reason: string): void;
}

export interface RendererPort {
  enter(): void | Promise<void>;
  /** Optional out-of-band delivery for newly-visible operator notifications. */
  publishNotifications?(notifications: readonly Notification[]): void | Promise<void>;
  render(frame: RenderInput): void | Promise<void>;
  /** Optional stronger path implemented only by renderers with a real commit event. */
  renderObserved?(frame: RenderInput, observer: RendererCommitObserver): void | Promise<void>;
  restore(): void | Promise<void>;
}

export interface FrameOptions {
  readonly color?: boolean;
  readonly unicode?: boolean;
  readonly render_budget?: OutputBudget;
  /** Injected frame clock (timerCadence) for player-piano animation. */
  readonly frame_count?: number;
  /** Optional semantic palette, threaded to every colored frame surface. */
  readonly theme?: RunTheme;
  /**
   * Color-emission tier (OT-6): degrades truecolor SGR to a 256-color
   * approximation when the terminal's captured `TerminalCapabilities.rgb` is
   * false but `.ansi256` is true. Only consulted when `color` is true — a
   * `NO_COLOR`/non-TTY frame (`color: false`) never reaches an emitter at
   * all, regardless of this field. Defaults to `"truecolor"` (the pre-OT-6
   * behavior) when omitted.
   */
  readonly color_mode?: ColorMode;
  /**
   * Injected wall clock for expiring transient footer notifications. Omit for
   * a timeless deterministic snapshot; TuiShell supplies it in live use.
   */
  readonly notification_now_ms?: number;
}

/**
 * Console is the only screen whose primary pane has a persistent, typed
 * composer. This reads the model-owned screen projection, never terminal
 * strings, so native renderers can learn focus/action/alignment without
 * creating a second input authority.
 */
function consolePaneMetadata(app: AppModel, pane: PaneRect): Pick<FramePane, "content_alignment" | "chronology" | "composer"> {
  if (app.screen !== "console") return {};
  const raw = app.screens.get("console");
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const input = (raw as Record<string, unknown>).console_input;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {
    content_alignment: "top",
    chronology: { placement: "top", sticky_bottom: false },
  };
  const value = input as Record<string, unknown>;
  const text = typeof value.text === "string" ? value.text : "";
  const cursor = typeof value.cursor === "number" && Number.isSafeInteger(value.cursor) ? Math.max(0, Math.min(value.cursor, text.length)) : text.length;
  const visibleRows = pane.rows >= 34 ? 6 : pane.rows >= 22 ? 4 : pane.rows >= 12 ? 2 : 1;
  return {
    content_alignment: "top",
    chronology: { placement: "top", sticky_bottom: false },
    composer: {
      kind: "console",
      focused: value.focused === true,
      cursor,
      text,
      action: value.action === "answer" ? "answer" : value.action === "queue" ? "queue" : "send",
      interrupt_available: value.interrupt_available === true,
      max_visible_rows: visibleRows,
    },
  };
}

/**
 * Builds the canonical typed Frame (4F.5) — the scene every FramePainter
 * paints. Same composition `renderTerminalFrame` always did; extracted so
 * TerminalPainter/JsonPainter/SsePainter share one scene-building path.
 */
export function renderScene(projection: RenderProjection, options: FrameOptions = {}): SceneFrame {
  const productWorkspace = projection.navigation.workspaces.at(-1);
  if (productWorkspace?.panes.length === 1 && productWorkspace.panes[0]?.id === "main") {
    return renderCockpitScene(projection, options);
  }
  const { columns, rows } = projection.navigation.terminal;
  const canvas = Array.from({ length: rows }, () => Array<string>(columns).fill(" "));
  const layout = layoutWorkspace(projection.navigation);
  const workspace = projection.navigation.workspaces.at(-1);
  // Computed before the pane loop (not after) because a pane's structurally
  // reported height needs it: `layoutWorkspace` sizes every pane against the
  // full terminal with no notion of a status bar, so a pane reaching the
  // terminal's last row claims that row in its own rect — but the status-bar
  // write below (4F.4) always overwrites that exact row afterward,
  // regardless of which pane's layout claimed it. `drawPane` still paints
  // that pane using its real, un-narrowed rect (visually correct: the status
  // bar overwrite is what actually makes the row show the status bar, not a
  // pane-size change) — only the FramePane rect this function *reports* is
  // narrowed, so a hit-test against the status row resolves to no pane
  // rather than a false positive against whichever pane's layout reached it.
  // Every screen, including Console, reserves the same full-width status row.
  // The native renderer, hit-test model, and keyboard recorder all consume
  // this shared geometry; Console's composer metadata controls its document
  // alignment but must not remove the operator-critical activity footer.
  const statusRow: number | null = rows > 0 ? rows - 1 : null;
  // The persistent notification band (roadmap gap: AppModel.notifications is
  // a real bounded ring — interrupt/branch/prune all append to it — that
  // nothing painted before this). Reserved directly above the status row,
  // exactly like the status row reserves its own space against
  // layoutWorkspace's pane sizing (see that row's own comment below for why
  // pane narrowing happens here rather than at layout time). Bounded by
  // whatever room genuinely exists above the status row so it can never
  // paint over or past it on a very short terminal. Collapses to zero rows
  // when the ring is empty — an ops cockpit with no active incidents shows
  // no incident chrome (absence is a value, not a default), so every scene
  // with an empty ring renders byte-identical to before this band existed.
  const notificationWindow = windowedNotifications(projection.app.notifications, {
    max_rows: DEFAULT_NOTIFICATION_BAND_ROWS,
    available_rows: statusRow ?? 0,
    now_ms: options.notification_now_ms,
  });
  const notificationLines = renderNotificationBand(notificationWindow, { width: columns, color: options.color === true, theme: options.theme, color_mode: options.color_mode });
  const bandRows = notificationLines.length;
  const bandTop: number | null = statusRow !== null && bandRows > 0 ? statusRow - bandRows : null;
  const reservedTop: number | null = bandTop ?? statusRow;
  const panes: FramePane[] = [];
  for (const pane of layout.panes) {
    // Pane-level focus only adds visible chrome when there is a real choice:
    // a one-pane workspace is already unambiguous and should keep its stable
    // title and frame (including the product's single-pane viewport).
    const focused = (workspace?.panes.length ?? 0) > 1
      && projection.navigation.focus?.kind === "pane"
      && projection.navigation.focus.id === pane.id;
    const baseTitle = workspace?.panes.find((item) => item.id === pane.id)?.title ?? pane.id;
    // At tiny widths the border itself remains focused, while a marker would
    // consume the only title characters that fit inside the frame.
    const title = focused && pane.columns >= 8
      ? `${semanticGlyph("focus", options.unicode !== false)} ${baseTitle}`
      : baseTitle;
    const reservedOverlap = reservedTop !== null ? Math.max(0, pane.y + pane.rows - reservedTop) : 0;
    // Render the screen against the pane height that remains interactive after
    // the ambient notification/status rows are reserved. The border still
    // paints from the original rectangle below, but asking a screen to render
    // at the larger height and clipping afterward drops its anchored last
    // line (notably Console's composer footer) in native and flat frames.
    const contentPane = reservedOverlap === 0 ? pane : { ...pane, rows: pane.rows - reservedOverlap };
    const content = pane === layout.panes[0] ? primaryPaneContent(projection, contentPane, options) : "";
    drawPane(canvas, pane, title, content, options.unicode !== false, focused);
    // Mirrors drawPane's own interior guard/clip exactly (via
    // resolveContentLine, the single source of truth both this array and
    // drawPane's canvas write share) so a structure-aware renderer's
    // per-pane content matches what the flattened canvas actually painted
    // into that pane's interior, column width included, not an
    // independently-derived approximation of it (audit finding: this array
    // used to carry the raw unclipped line — a screen or the default output
    // excerpt can both produce a line wider than the pane, and nothing here
    // ever bounded it to what drawPane really drew). Content clipping uses
    // the pane's real (un-narrowed) row count — the status-bar/notification-
    // band overwrite lands on the pane's own trailing rows, never reshaping
    // its interior (drawPane's interior spans rows 1..rows-2; the reserved
    // rows this narrows away are always the pane's last one or few rows).
    const interiorWidth = Math.max(0, pane.columns - 2);
    const paneContent = pane.columns < 2 || pane.rows < 2
      ? []
      : content.split("\n").slice(0, Math.max(0, pane.rows - 2)).map((line) => {
        const resolved = resolveContentLine(line, interiorWidth);
        return resolved.styled ?? resolved.plain;
      });
    panes.push({
      id: pane.id, x: pane.x, y: pane.y, columns: pane.columns, rows: pane.rows - reservedOverlap, title,
      paint_rows: pane.rows,
      content: paneContent,
      ...(pane === layout.panes[0] ? { interaction_regions: workspaceInspectorRegions(projection.app, contentPane) } : {}),
      ...(pane === layout.panes[0] ? consolePaneMetadata(projection.app, pane) : {}),
    });
  }
  // Compose overlay cursor (T2.3b, RV-TUI-14 / FP-19): a real inverse-video
  // cell, painted only when color is enabled. `drawPane`'s canvas is a
  // per-display-cell grid (`put`/`displayCells`, widgets.ts) that treats
  // every codepoint — including an embedded ANSI SGR byte — as its own
  // one-column cell, so raw SGR text cannot flow through the normal
  // `content` -> `drawPane` -> `clip`/`put` path without being shredded.
  // This mirrors the status-bar/notification-band convention already used
  // above: paint the plain (uncolored) row through `drawPane` like every
  // other pane content row, then directly overwrite that one already-drawn
  // row with a colored variant, splicing the styled interior back between
  // the border characters `drawPane` already placed either side of it.
  if (layout.panes[0] !== undefined && options.color === true) {
    paintComposeCursor(canvas, projection.app, layout.panes[0], columns);
  }
  if (layout.mode === "empty") put(canvas, 0, 0, clip("No workspace", columns));
  if (bandTop !== null) {
    // Unbordered by construction (`bordered: false`) — an ambient strip, not
    // a fourth workspace pane — and painted the same way the status row is
    // (direct row assignment, not put()/clip(), since a colored line embeds
    // SGR that those treat as one-column characters each). Still a real
    // FramePane so hitTestFrame resolves a click against it exactly like any
    // other pane — the geometry a future click-to-dismiss handler needs
    // (see overlays.ts's notificationDismissIntent) is correct from the
    // start, even though no caller wires the click itself yet.
    const boundedNotificationLines = notificationLines.map((line) => boundedPlainRow(line.plain, columns));
    panes.push({
      id: "notifications", x: 0, y: bandTop, columns, rows: bandRows, title: "Notifications", bordered: false,
      content: boundedNotificationLines.map((line) => line.replace(/\s+$/u, "")),
    });
    notificationLines.forEach((line, index) => {
      const plain = boundedNotificationLines[index]!;
      const text = options.color === true ? boundedStyledRow(line.styled, line.plain, columns) : plain;
      canvas[bandTop + index] = [text, ...Array<string>(Math.max(0, columns - 1)).fill("")];
    });
  }
  // 4F.4: a real, full-width status-bar zone (campaign · phase · events ·
  // budget/epoch · model) replaces the old bare `put()` of `connection.status`,
  // which only overwrote as many cells as the text needed and left a pane's
  // bottom-border fill bleeding through to the right of it. The status bar can
  // carry palette SGR codes (ADR-020), so it is assigned directly into the row
  // rather than through `put()`/`clip()`, which treat every character
  // (including ANSI escapes) as one column.
  if (statusRow !== null) {
    const statusOptions = { columns, frame_count: options.frame_count ?? 0, theme: options.theme, color_mode: options.color_mode };
    const plain = renderStatusBar(projection.app, { ...statusOptions, color: false });
    const statusBar = options.color === true
      ? boundedStyledRow(renderStatusBar(projection.app, { ...statusOptions, color: true }), plain, columns)
      : boundedPlainRow(plain, columns);
    canvas[statusRow] = [statusBar, ...Array<string>(Math.max(0, columns - 1)).fill("")];
  }
  return { columns, rows: canvas.map((line) => line.join("").replace(/\s+$/u, "")), panes, status_row: statusRow };
}

/** How many logical lines the console composer buffer currently holds, for `computeShellLayout`'s anchored composer height. */
function composerLineCount(raw: Record<string, unknown>): number {
  const input = raw.console_input;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return 1;
  const text = (input as Record<string, unknown>).text;
  return typeof text === "string" ? Math.max(1, text.split("\n").length) : 1;
}

/** Last non-empty path segment, for a repo-identity line that never floods the left zone with a full absolute path. */
function pathTail(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments.at(-1) ?? path;
}

/**
 * Header left zone (ui-spec §2.2/§4): repository, then run/campaign id.
 * Bounded to the zone's real interior height so a caller with only one
 * interior row (folded/compressed headers) still gets the single highest-
 * priority line rather than an overflowing list.
 */
function headerLeftLines(sidebar: ResponsiveSidebarProjection, zones: StatusBarZones, height: number): readonly string[] {
  const lines: string[] = [];
  if (sidebar.project.repository_root !== undefined) lines.push(`repo ${pathTail(sidebar.project.repository_root)}`);
  lines.push(`run ${zones.campaign}`);
  return lines.slice(0, Math.max(0, height));
}

/**
 * Header right zone: gate/approval blockers first, then active-work count,
 * then runtime health (ui-spec §2.2's "blockers > active work > identity"
 * priority, applied to this zone's own content).
 */
function headerRightLines(app: AppModel, zones: StatusBarZones, height: number): readonly string[] {
  const blockers: string[] = [];
  if (zones.attention !== STATUS_BAR_ZONE_PLACEHOLDER && zones.attention !== "0") blockers.push(`! attention ${zones.attention}`);
  if (app.connection.status === "degraded") blockers.push(`! degraded: ${app.connection.reason}`);
  const activeWork: string[] = [];
  if (zones.phase !== STATUS_BAR_ZONE_PLACEHOLDER) activeWork.push(`active ${zones.phase} #${zones.attempt}`);
  if (zones.verified !== STATUS_BAR_ZONE_PLACEHOLDER) activeWork.push(`verified ${zones.verified}`);
  const health = [`conn ${app.connection.status}${zones.events !== STATUS_BAR_ZONE_PLACEHOLDER ? ` · events ${zones.events}` : ""}`];
  return [...blockers, ...activeWork, ...health, focusBreadcrumb(app)].slice(0, Math.max(0, height));
}

/**
 * `focus › tab › item` (ui-spec §3's breadcrumb, simplified to what this
 * model can prove: `AppModel.selection` carries a stable id, not a row
 * index/total, so this reports the id rather than fabricating a `k/N`
 * count no screen here computes). Lowest priority in the right zone, so it
 * drops first on a short zone.
 */
function focusBreadcrumb(app: AppModel): string {
  const selection = app.selection.get(app.screen);
  const item = selection?.id === undefined ? "" : ` · ${selection.id}`;
  return `${app.focus.zone} › ${app.focus.rail_tab}${item}`;
}

const STATUS_BAR_ZONE_PLACEHOLDER = "—";

/** UCT band label when there is nothing real to draw (ui-spec §5): never an empty decorative graph. */
function uctAbsenceLabel(app: AppModel): string {
  return app.telemetryCampaignId === null ? "UCT: no live campaign" : "UCT: awaiting tree";
}

/** Product shell: one geometry authority for flat paint, native paint and input. `computeShellLayout` (layout.ts) owns every rect this function paints. */
function renderCockpitScene(projection: RenderProjection, options: FrameOptions): SceneFrame {
  const { columns, rows } = projection.navigation.terminal;
  const canvas = Array.from({ length: rows }, () => Array<string>(columns).fill(" "));
  const context = projection.app.screens.get("console");
  const projected = consoleScreen.project(context, { width: columns, height: rows });
  const projectedSidebar = projected.rows.find((row) => row.region === "sidebar")?.projection as ResponsiveSidebarProjection | undefined
    ?? projectResponsiveSidebar({ width: columns, visibility: "auto" });
  const raw = typeof context === "object" && context !== null && !Array.isArray(context) ? context as Record<string, unknown> : {};
  // The rail's own explicit open/closed request (ui-spec §2.1: drawer/
  // compressed only open when asked). Docked ignores this except as an
  // explicit close override (§2.3 has no docked-close case; this is this
  // renderer's own minimal addition, documented in the M2 report).
  const railRequest: ShellRailRequest = raw.sidebar_visibility === "shown" ? "open" : raw.sidebar_visibility === "hidden" ? "closed" : "auto";
  const shellLayout = computeShellLayout({ columns, rows, rail: railRequest, composer_lines: composerLineCount(raw) });

  // A narrow inspector overlays the transcript, but must not cover an
  // active form's editable text. Suspend only that presentation: retain
  // the operator's visibility preference and selection for form dismissal.
  const suspendOverlay = projection.app.overlay?.kind === "operator_form";
  const railRect: ShellLayoutRect | null = shellLayout.rail;
  const railOverlayRect: ShellLayoutRect | null = suspendOverlay ? null : shellLayout.rail_overlay;
  const activeRailRect = railRect ?? railOverlayRect;
  const railMode: ResponsiveSidebarProjection["mode"] = railRect !== null ? "docked" : railOverlayRect !== null ? "overlay" : "hidden";
  const sidebar: ResponsiveSidebarProjection = { ...projectedSidebar, mode: railMode };

  const mainWidth = shellLayout.transcript.columns;
  const bodyTop = shellLayout.transcript.y;
  const bodyRows = shellLayout.transcript.rows + shellLayout.composer.rows;
  const panes: FramePane[] = [];
  const overlayRegions: readonly PaneRect[] = activeRailRect !== null && railMode === "overlay"
    ? [{ id: "workspace-inspector", x: activeRailRect.x, y: activeRailRect.y, columns: activeRailRect.columns, rows: activeRailRect.rows }]
    : [];
  const putBlock = (rect: ShellLayoutRect, lines: readonly string[]): void => {
    for (let index = 0; index < Math.min(rect.rows, lines.length); index++) {
      const y = rect.y + index;
      if (y < 0 || y >= rows) continue;
      const existing = canvas[y]!.join("");
      const prefix = boundedStyledRow(clipAnsi(existing, rect.x), stripAnsi(clipAnsi(existing, rect.x)), rect.x);
      const line = lines[index]!;
      const value = options.color === true ? boundedStyledRow(line, stripAnsi(line), rect.columns) : boundedPlainRow(stripAnsi(line), rect.columns);
      canvas[y] = [prefix + value + " ".repeat(Math.max(0, columns - rect.x - rect.columns))];
    }
  };

  // ---- Header (framed top band: left | graph | right), ui-spec §2.2 ----
  if (shellLayout.header !== null) {
    const unicode = options.unicode !== false;
    const frame = unicode
      ? { h: "─", v: "│", tl: "┌", tr: "┐", bl: "└", br: "┘", topTee: "┬", bottomTee: "┴" }
      : { h: "-", v: "|", tl: "+", tr: "+", bl: "+", br: "+", topTee: "+", bottomTee: "+" };
    const headerRect = shellLayout.header;
    // Separator columns between zones, ui-spec §2.2's "two 1-col
    // separators": `layout.ts`'s `headerZones` already reserves exactly
    // these columns (`header_graph.x` sits one column right of
    // `header_left`'s own right edge, and `header_right.x` one column right
    // of `header_graph`'s), so this derives them from the painted rects
    // rather than re-deriving `headerZones`' own arithmetic a second time.
    const separatorColumns: number[] = [];
    if (shellLayout.header_left !== null && shellLayout.header_graph !== null && shellLayout.header_left.x + shellLayout.header_left.columns < shellLayout.header_graph.x) {
      separatorColumns.push(shellLayout.header_graph.x - 1);
    }
    if (shellLayout.header_right !== null && shellLayout.header_graph !== null && shellLayout.header_graph.x + shellLayout.header_graph.columns < shellLayout.header_right.x) {
      separatorColumns.push(shellLayout.header_right.x - 1);
    }
    const withTees = (glyph: string, tee: string): string => {
      const cells = glyph.repeat(columns).split("");
      for (const x of separatorColumns) if (x >= 0 && x < columns) cells[x] = tee;
      return cells.join("");
    };
    // Content for the "header" backdrop pane below, in the pane's OWN local
    // columns (0..headerRect.columns), built alongside the identical
    // full-width `canvas` rows the flat stdout path already painted here.
    // OpenTuiRenderer paints `SceneFrame.rows` for the string fallback but
    // `FramePane.content` for a structured scene (ADR-037) — a pane pushed
    // with `content: []` (the prior code) is an opaque box with nothing in
    // it, so the border/tee/divider glyphs painted onto `canvas` below never
    // reached the native renderer at all (a real OpenTUI capture at 120x40
    // caught this: row 0 blank, no left/right/divider border). Populating
    // this pane's own content with the same border glyphs makes the frame
    // part of what OpenTUI actually paints, while `canvas`/`rows` (the
    // stdout path) are computed exactly as before.
    const headerContent: string[] = Array.from({ length: headerRect.rows }, () => " ".repeat(Math.max(0, headerRect.columns)));
    const sliceLocal = (row: readonly string[]): string => row.slice(headerRect.x, headerRect.x + headerRect.columns).join("");
    if (headerRect.rows >= 1) {
      const top = withTees(frame.h, frame.topTee).split("");
      top[0] = frame.tl; top[Math.max(0, columns - 1)] = frame.tr;
      canvas[headerRect.y] = [top.join("")];
      headerContent[0] = sliceLocal(top);
    }
    if (headerRect.rows >= 2) {
      const bottom = withTees(frame.h, frame.bottomTee).split("");
      bottom[0] = frame.bl; bottom[Math.max(0, columns - 1)] = frame.br;
      canvas[headerRect.y + headerRect.rows - 1] = [bottom.join("")];
      headerContent[headerRect.rows - 1] = sliceLocal(bottom);
    }
    // Interior rows: left/right outer border plus the zone dividers, in the
    // pane's own local columns — the same cells the border/divider loops
    // below paint onto `canvas` in global columns, mirrored here so the
    // backdrop pane carries them too.
    for (let localY = 1; localY < headerRect.rows - 1; localY += 1) {
      const cells = Array<string>(Math.max(0, headerRect.columns)).fill(" ");
      if (cells.length >= 1) cells[0] = frame.v;
      if (cells.length >= 2) cells[cells.length - 1] = frame.v;
      for (const x of separatorColumns) {
        const localX = x - headerRect.x;
        if (localX >= 0 && localX < cells.length) cells[localX] = frame.v;
      }
      headerContent[localY] = cells.join("");
    }
    // Pushed FIRST, before the zone sub-panes: a structure-aware renderer
    // (OpenTuiRenderer) paints one opaque box per pane in array order (later
    // = higher z-index), so a full-header decorative pane pushed AFTER its
    // own sub-zones would black out everything underneath it. Pushing it
    // first makes it a backdrop the real zone panes paint over, exactly like
    // the flat canvas already does by construction (this is what a real
    // OpenTUI capture at 120x40 caught: the header zones existed in the flat
    // text scene but were fully hidden behind this pane's own black box).
    panes.push({ id: "header", ...headerRect, title: "Header", bordered: false, content: headerContent });
    const zones = deriveStatusBarZones(projection.app, options.frame_count ?? 0);
    if (shellLayout.header_left !== null) {
      const lines = headerLeftLines(sidebar, zones, shellLayout.header_left.rows).map((line) => clipLabelWithEllipsis(line, shellLayout.header_left!.columns));
      putBlock(shellLayout.header_left, lines);
      panes.push({ id: "header-left", ...shellLayout.header_left, title: "Identity", bordered: false, content: lines });
    }
    if (shellLayout.header_right !== null) {
      const lines = headerRightLines(projection.app, zones, shellLayout.header_right.rows).map((line) => clipLabelWithEllipsis(line, shellLayout.header_right!.columns));
      putBlock(shellLayout.header_right, lines);
      panes.push({ id: "header-right", ...shellLayout.header_right, title: "Status", bordered: false, content: lines });
    }
    if (shellLayout.header_graph !== null) {
      const graphRect = shellLayout.header_graph;
      const uctRow = projected.rows.find((row) => row.region === "uct");
      const nodes = Array.isArray(uctRow?.nodes) ? uctRow.nodes as readonly UctHeaderNode[] : [];
      let graphLines: readonly string[];
      let graphTitle: string | null = null;
      if (nodes.length === 0) {
        graphLines = [clipDisplay(uctAbsenceLabel(projection.app), graphRect.columns)];
      } else {
        const playback = projection.app.uctPlayback;
        const scoped = playback.campaign_id === projection.app.telemetryCampaignId;
        // `framed: false` — the header band above already drew the ONE
        // frame ui-spec §2.2/§5 and ADR-162 decision 2 call for. Letting
        // `projectUctHeader` also draw its own box here double-framed the
        // band and cost it two of the interior rows it was owed (a real
        // 80x24 capture showed 4 content rows instead of 6; a compressed
        // 70x20 capture showed 0 instead of 2). The title/metrics text it
        // would have drawn on its own border comes back via `hero.title`
        // and is spliced into the band's shared top border segment below.
        const hero = projectUctHeader(
          { nodes, backtracks: scoped ? playback.pending : [], dropped_backtracks: scoped ? playback.dropped : 0 },
          { width: graphRect.columns, height: Math.max(1, graphRect.rows), color: options.color, theme: options.theme, color_mode: options.color_mode, presentation: "hero", now_ms: options.notification_now_ms, framed: false },
        );
        graphLines = hero.lines;
        graphTitle = hero.title;
      }
      putBlock(graphRect, graphLines);
      panes.push({ id: "uct-graph", ...graphRect, title: "UCT", bordered: false, content: graphLines, interaction_regions: overlayRegions });
      if (graphTitle !== null && graphTitle.length > 0) {
        const decoratedTitle = ` ${graphTitle} `;
        if (headerRect.rows >= 2) {
          // Splice the title into the band's own top border row, over the
          // graph zone's column span only — never touching the outer
          // border columns or the zone-separator tees `withTees` placed.
          const clippedTitle = clipDisplay(decoratedTitle, graphRect.columns);
          if (displayWidth(clippedTitle) > 0) {
            const topRow = (canvas[headerRect.y]?.[0] ?? "").split("");
            for (let i = 0; i < clippedTitle.length && graphRect.x + i < topRow.length; i += 1) {
              topRow[graphRect.x + i] = clippedTitle[i]!;
            }
            canvas[headerRect.y] = [topRow.join("")];
            const localTop = (headerContent[0] ?? "").split("");
            const localStart = graphRect.x - headerRect.x;
            for (let i = 0; i < clippedTitle.length && localStart + i < localTop.length; i += 1) {
              localTop[localStart + i] = clippedTitle[i]!;
            }
            headerContent[0] = localTop.join("");
          }
        } else if (graphRect.rows > 1) {
          // Fallback (ui-spec §2.2 double-frame remediation): no distinct
          // border row exists to hold the title (the unframed 1-row header
          // case), so it takes the graph zone's own first interior row
          // instead of being dropped.
          const withTitle = [clipDisplay(graphTitle, graphRect.columns), ...graphLines.slice(1)];
          putBlock(graphRect, withTitle);
          panes[panes.length - 1] = { ...panes[panes.length - 1]!, content: withTitle };
        }
      }
    }
    // Vertical dividers between zones, drawn AFTER every zone's own
    // `putBlock` call: `putBlock` blank-pads from its rect's right edge to
    // the full row width (so a shorter line doesn't leave stale trailing
    // text), which would erase a divider painted before it. Drawn last, a
    // divider overwrites exactly its own reserved gap column (ui-spec
    // §2.2's "two 1-col separators" — `layout.ts`'s `headerZones` already
    // leaves these columns out of every zone's own rect) without clipping
    // either zone's real content.
    // `spliceAnsiColumn`, not a raw `string[]` index: under `color: true` a
    // zone's own content (status glyphs, UCT node colors) embeds `[...m`
    // SGR sequences, which a plain character-index splice counts as visible
    // columns — shifting every divider/border to the wrong cell (a real
    // 120×36 colored capture put a stray `│` inside the UCT graph, row 3).
    for (const x of separatorColumns) {
      if (x < 0 || x >= columns) continue;
      for (let y = headerRect.y + 1; y < headerRect.y + headerRect.rows - 1; y += 1) {
        const row = canvas[y];
        if (row === undefined) continue;
        canvas[y] = [spliceAnsiColumn(row.join(""), x, frame.v)];
      }
    }
    // Outer left/right border columns for every interior row. The top/bottom
    // rows already carry their corners via `tl`/`tr`/`bl`/`br` above; zone
    // rects are inset by one column on each side (`layout.ts`'s
    // `buildFullHeader`) precisely so this vertical never gets overwritten
    // by zone text painted afterward.
    if (columns >= 1) {
      for (let y = headerRect.y + 1; y < headerRect.y + headerRect.rows - 1; y += 1) {
        const row = canvas[y];
        if (row === undefined) continue;
        let line = spliceAnsiColumn(row.join(""), 0, frame.v);
        if (columns >= 2) line = spliceAnsiColumn(line, columns - 1, frame.v);
        canvas[y] = [line];
      }
    }
  }

  // ---- Warning row (minimal only), ui-spec §2.4 ----
  if (shellLayout.warning !== null) {
    const text = clipDisplay(`terminal ${columns}x${rows} below 60x16 · focus ${projection.app.focus.zone} (F6)`, columns);
    putBlock(shellLayout.warning, [text]);
    panes.push({ id: "warning", ...shellLayout.warning, title: "Warning", bordered: false, content: [text] });
  }

  // ---- Transcript/main + notification band, ui-spec §2.3 ----
  const notificationWindow = windowedNotifications(projection.app.notifications, {
    max_rows: DEFAULT_NOTIFICATION_BAND_ROWS,
    available_rows: shellLayout.transcript.rows, now_ms: options.notification_now_ms,
  });
  const notificationLines = mainWidth > 0 && shellLayout.transcript.rows > 0 ? renderNotificationBand(notificationWindow, {
    width: mainWidth, color: options.color === true, theme: options.theme, color_mode: options.color_mode,
  }) : [];

  let bodyProjection = projection;
  if (mainWidth > 0 && bodyRows > 0) {
    const pane: PaneRect = { id: "main", x: 0, y: bodyTop, columns: mainWidth, rows: bodyRows };
    const screens = new Map(projection.app.screens);
    screens.set("console", { ...raw, sidebar_visibility: "hidden", shell_owns_uct: true });
    bodyProjection = { ...projection, app: { ...projection.app, screens } };
    const content = primaryPaneContent(bodyProjection, pane, options);
    const title = projection.navigation.workspaces.at(-1)?.panes[0]?.title ?? "revoy2";
    drawPane(canvas, pane, title, content, options.unicode !== false);
    const width = Math.max(0, pane.columns - 2);
    const composerMeta = consolePaneMetadata(bodyProjection.app, pane);
    // The composer's anchored rect (ui-spec §2.3) is attached to "main"'s own
    // own composer metadata, never as a second sibling FramePane at the same
    // coordinates: OpenTuiRenderer paints one opaque box per pane, so a
    // same-rect sibling would black out the composer text "main" already
    // drew (a real OpenTUI capture at 120x40 caught exactly this).
    const composer = composerMeta.composer !== undefined && shellLayout.composer.rows > 0
      ? { composer: { ...composerMeta.composer, anchor: shellLayout.composer } }
      : {};
    panes.push({ ...pane, title, content: content.split("\n").slice(0, Math.max(0, pane.rows - 2)).map((line) => {
      const resolved = resolveContentLine(line, width);
      return resolved.styled ?? resolved.plain;
    }), interaction_regions: overlayRegions, ...composerMeta, ...composer });
    if (options.color === true) paintComposeCursor(canvas, bodyProjection.app, pane, columns);
  }
  if (notificationLines.length > 0) {
    const bandRows = notificationLines.length;
    const bandRect: ShellLayoutRect = { x: 0, y: shellLayout.composer.y - bandRows, columns: mainWidth, rows: bandRows };
    const lines = notificationLines.map((line) => options.color === true ? line.styled : line.plain);
    putBlock(bandRect, lines);
    panes.push({ id: "notifications", ...bandRect, title: "Notifications", bordered: false, content: lines, interaction_regions: overlayRegions });
  }

  // ---- Rail (docked) or rail overlay (drawer/compressed, explicit open), ui-spec §2.3/§4 ----
  if (activeRailRect !== null) {
    const lines = renderResponsiveSidebar(sidebar, { width: activeRailRect.columns, height: activeRailRect.rows, color: options.color, theme: options.theme, color_mode: options.color_mode,
      supplemental_lines: consoleInspectorDiagnostics(projected, activeRailRect.columns) });
    const railOptions = resolveRailRenderOptions({ width: activeRailRect.columns, color: options.color, theme: options.theme, color_mode: options.color_mode });
    panes.push({ id: "workspace-inspector", ...activeRailRect, title: "Inspector", bordered: false, content: lines, inspector_document_rows: sidebarDocumentRows(sidebar, activeRailRect.rows),
      inspector_adr_rows: sidebarAdrRows(sidebar, activeRailRect.rows, railOptions.width, railOptions.theme, railOptions.mode) });
    putBlock(activeRailRect, lines);
  }

  return {
    columns, rows: canvas.map((line) => line.join("").replace(/\s+$/u, "")), panes,
    status_row: null, status_columns: mainWidth, layout_class: shellLayout.layout_class,
  };
}

/**
 * Paints a `SceneFrame`'s flat rows to ANSI terminal text — the exact
 * composition `renderTerminalFrame` has always produced (TerminalPainter's
 * own docstring: "a refactor-extraction, not a behavior change" yielding
 * "byte-identical output"). Extracted from `renderTerminalFrame` (ADR-037)
 * so `TuiShell` can build the scene once per draw and hand both the text and
 * the scene to `render()`, instead of `renderScene` running twice per frame.
 * The synchronous capture is safe because TerminalPainter's paint() writes
 * through the target synchronously for a string sink.
 */
export function paintScene(scene: SceneFrame, options: FrameOptions = {}): string {
  let painted = "";
  new TerminalPainter({ ...(options.color === true ? { color: true } : {}) })
    .paint(scene, paintTargetFromRenderFn((value) => { painted = value; }));
  return painted;
}


function workspaceInspectorRegions(app: RenderProjection["app"], pane: PaneRect): readonly PaneRect[] {
  if (app.overlay !== null) return [];
  const context = app.screens.get("console");
  const width = Math.max(0, pane.columns - 2);
  const height = Math.max(0, pane.rows - 2);
  if (context === undefined || width === 0 || height === 0) return [];
  const sidebar = consoleScreen.project(context, { width, height }).rows.find((row) => row.region === "sidebar")?.projection as ResponsiveSidebarProjection | undefined;
  if (sidebar === undefined || sidebar.mode === "hidden") return [];
  const columns = Math.min(RESPONSIVE_SIDEBAR_WIDTH, width);
  return [{ id: "workspace-inspector", x: pane.x + 1 + width - columns, y: pane.y + 1, columns, rows: height }];
}

function primaryPaneContent(projection: RenderProjection, pane: PaneRect, options: FrameOptions): string {
  const help = helpOverlay(projection, pane, options);
  if (help !== null) return help;
  const compose = composeOverlayContent(projection.app, pane);
  if (compose !== null) return options.color === true ? compose.text : plainComposeCursorText(compose);
  const confirmation = confirmationOverlay(projection.app, pane);
  if (confirmation !== null) return confirmation;
  const operatorForm = operatorFormOverlay(projection.app, pane);
  if (operatorForm !== null) return operatorForm;
  // Reuse the Console-owned context projection and the single sidebar
  // renderer. Other screens must not invent a second document/tab store.
  if (projection.app.screen !== "console") {
    const context = projection.app.screens.get("console");
    if (context !== undefined) {
      const width = Math.max(1, pane.columns - 2);
      const height = Math.max(1, pane.rows - 2);
      const projected = consoleScreen.project(context, { width, height });
      const sidebar = projected.rows.find((row) => row.region === "sidebar")?.projection as ResponsiveSidebarProjection | undefined;
      if (sidebar !== undefined && sidebar.mode !== "hidden") {
        const railWidth = Math.min(RESPONSIVE_SIDEBAR_WIDTH, width);
        const primaryWidth = Math.max(0, width - railWidth - 1);
        const rail = renderResponsiveSidebar(sidebar, {
          width: railWidth, height, color: options.color === true,
          theme: options.theme, color_mode: options.color_mode,
        });
        if (primaryWidth === 0) return rail.join("\n");
        const primary = resolveActiveScreen(projection.app, sidebar.mode === "overlay" ? pane : { ...pane, columns: primaryWidth + 2 }, options) ?? "";
        return stackHorizontal([
          { id: "screen", lines: primary.split("\n").map((line) => clipDisplay(line, primaryWidth)), weight: primaryWidth },
          { id: "inspector", lines: rail, weight: railWidth },
        ], { total_width: width, color: options.color === true }).slice(0, height).join("\n");
      }
    }
  }
  const screenContent = resolveActiveScreen(projection.app, pane, options);
  if (screenContent !== null) return screenContent;
  const source = typeof projection.output === "string" ? { content: projection.output } : projection.output;
  const excerpt = abbreviateOutput(sanitizeUntrustedTerminalText(source.content), options.render_budget ?? DEFAULT_OUTPUT_POLICY.render);
  const evidence = source.evidence_pointer === undefined ? undefined : sanitizeUntrustedTerminalText(source.evidence_pointer).trim();
  return `${excerpt.text}${evidence ? `\n[evidence: ${evidence}]` : ""}`;
}

/**
 * Help is an AppModel overlay, not a raw-loop-local render escape hatch.  The
 * catalog remains composition-owned (it may include local keymap overrides),
 * while query, expansion, and cancel state remain reducer-owned and are drawn through the
 * same SceneFrame as every other operator surface.
 */
function helpOverlay(projection: RenderProjection, pane: PaneRect, options: FrameOptions): string | null {
  const help = projection.app.overlay?.kind === "help" ? projection.app.overlay : null;
  if (help === null) return null;
  const width = Math.max(1, pane.columns - 2);
  const height = Math.max(1, pane.rows - 2);
  if (projection.help_catalog === undefined) return "Help catalog unavailable";
  const context = paletteContextForModel(projection.app);
  const paletteOptions = {
    query: help.query,
    expanded: help.expanded,
    contextual: true,
    context,
    limit: 200,
    // Reserve the same rows the footer/detail block below occupies, so the
    // bounded contextual set fills the list area instead of stopping at 12
    // with the rest of the pane blank.
    contextual_limit: Math.max(1, height - 6),
  } as const;
  const view = paletteView(projection.help_catalog, paletteOptions);
  // Contextual help is also the live context menu (Shift+F10/right-click).
  // Derive its rows from the same catalogue and current authorization facts;
  // this keeps the visible mouse menu and keyboard palette on one action id.
  const menuItems = contextMenuItems(projection.help_catalog, view.items.map((item) => item.action_id), { disabled: context.disabled_reasons });
  const selectedIndex = view.items.length === 0 ? 0 : Math.min(help.selected_index, view.items.length - 1);
  const selected = view.items[selectedIndex];
  const reserved = selected === undefined ? 4 : 6;
  const listHeight = Math.max(1, height - reserved);
  const rendered = renderPaletteRows(projection.help_catalog, {
    ...paletteOptions,
    width,
    selected_index: selectedIndex,
    compact_rows: true,
    color: options.color === true,
    theme: options.theme,
    color_mode: options.color_mode,
  });
  // Group labels are rows too, so the window follows the selected ROW, not the item index.
  const selectedRow = Math.max(0, rendered.findIndex((row) => row.selected));
  const start = Math.max(0, Math.min(selectedRow - listHeight + 1, Math.max(0, rendered.length - listHeight)));
  const rows = rendered.slice(start, start + listHeight).map((row) => options.color === true ? row.styled : row.plain);
  const compact = width < 100;
  // `effectFor` (overlays.ts) has no per-action effect for most of the
  // catalogue and falls back to a category default: every `focus:` action
  // reports "Focuses this screen" while its own description already reads
  // "Focus the <name> screen", and every ordinary command reports "Runs the
  // registered action", which states nothing at all. Rendering those spent a
  // line of a bounded overlay to repeat the line above it, so a generic effect
  // is dropped and a real, action-supplied one is still shown.
  const GENERIC_EFFECTS = new Set(["Focuses this screen", "Opens command discovery", "Runs the registered action"]);
  const selectedMenu = selected === undefined ? undefined : menuItems.find((item) => item.action_id === selected.action_id);
  const selectedDetail = selected === undefined ? ["No matching commands."] : [
    // Marked, not silent: at 80 columns this read "…after approved plan submi" (EC-052).
    clipLabelWithEllipsis(`Selected · ${selected.title} — ${selected.description}`, width),
    clipLabelWithEllipsis([
      selected.keys.join(", ") || "no shortcut",
      selectedMenu?.reason ?? selected.authority_or_reason,
      ...(GENERIC_EFFECTS.has(selected.effect) ? [] : [selected.effect]),
    ].join(" · "), width),
  ];
  return [
    clipDisplay(`${M7_THEME_TOKENS.focus.glyph} Command palette · ${context.screen} · ${context.lifecycle}${help.query ? ` · filter: ${help.query}_` : " · contextual"} · context menu`, width),
    ...rows,
    ...selectedDetail,
    clipDisplay(paletteDisclosure(view, { compact }), width),
    clipDisplay(paletteFooterHint({ pending_chord: projection.palette_pending_chord, focus: `${context.screen} → palette`, compact }), width),
    clipDisplay(`Tab ${help.expanded ? "contextual" : "all commands"} · Esc close`, width),
  ].slice(0, height).join("\n");
}

/** ANSI reverse-video on/off, built via char code (matches overlays.ts's own NOTIFICATION_ESC convention — never a bare literal escape byte in source). */
const REVERSE_VIDEO_ESC = String.fromCharCode(27);
const REVERSE_VIDEO_ON = `${REVERSE_VIDEO_ESC}[7m`;
const REVERSE_VIDEO_OFF = `${REVERSE_VIDEO_ESC}[27m`;

interface ComposeOverlayContent {
  /** Plain (uncolored) content: question header, hard-wrapped buffer rows, footer hint. Byte-identical between color and non-color draws. */
  readonly text: string;
  /** 0-based index into `text.split("\n")` of the row the cursor sits on. */
  readonly cursorRow: number;
  /** 0-based column within that row. */
  readonly cursorColumn: number;
}

/**
 * Hard-wraps `text` at `width`, one output row per `width`-wide chunk of
 * each `\n`-delimited paragraph — the 80-column contract's "long lines wrap
 * in the overlay" requirement. Never collapses to zero rows: an empty
 * buffer still renders one empty row (the cursor's home).
 */
function wrapBufferRows(text: string, width: number): string[] {
  const rows: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) { rows.push(""); continue; }
    for (let i = 0; i < paragraph.length; i += width) rows.push(paragraph.slice(i, i + width));
  }
  return rows.length === 0 ? [""] : rows;
}

/**
 * Where `cursor` (a `text-buffer.ts` offset) lands in `wrapBufferRows`'
 * output — the single source of truth both the plain-text cursor marker and
 * the colored inverse-video overwrite key off, so they can never disagree
 * about which wrapped row/column the cursor is really on.
 */
function cursorWrapPosition(text: string, cursor: number, width: number): { rowIndex: number; column: number } {
  const target = Math.max(0, Math.min(cursor, text.length));
  const paragraphs = text.split("\n");
  let consumed = 0;
  let rowIndex = 0;
  for (let p = 0; p < paragraphs.length; p += 1) {
    const paragraph = paragraphs[p]!;
    const paragraphStart = consumed;
    const paragraphEnd = paragraphStart + paragraph.length;
    const chunkCount = paragraph.length === 0 ? 1 : Math.ceil(paragraph.length / width);
    if (target <= paragraphEnd || p === paragraphs.length - 1) {
      const within = Math.max(0, Math.min(target - paragraphStart, paragraph.length));
      const chunkIndex = Math.min(chunkCount - 1, Math.floor(within / width));
      const column = Math.min(width - 1, within - chunkIndex * width);
      return { rowIndex: rowIndex + chunkIndex, column };
    }
    rowIndex += chunkCount;
    consumed = paragraphEnd + 1;
  }
  return { rowIndex: 0, column: 0 };
}

/**
 * Renders the interviews screen's `userinput.answer` compose mode in place
 * of normal screen content — an operator typing blind into an invisible
 * buffer would not be a real, usable control (A-3 remediation). Multiline
 * (T2.3b, RV-TUI-14 / FP-19): the buffer is a real cursor/multiline
 * text-buffer (`text-buffer.ts`), hard-wrapped to the pane's width, with a
 * `line n/m` hint once it holds more than one logical line. The returned
 * `text` never itself contains cursor styling — `primaryPaneContent`
 * (non-color) and `paintComposeCursor` (color, below) each apply that
 * separately against the same `cursorRow`/`cursorColumn`.
 */
function composeOverlayContent(app: AppModel, pane: PaneRect): ComposeOverlayContent | null {
  // AppModel.compose (three-field overlay era) is superseded by the single
  // AppModel.overlay slot (wave2/tui-input-model, types.ts) — this reads the
  // new shape; the rendered behavior for a "compose" overlay is unchanged.
  if (app.overlay?.kind !== "compose") return null;
  const overlay = app.overlay;
  const width = Math.max(1, pane.columns - 2);
  const cursor = overlay.cursor ?? overlay.buffer.length;
  const info = cursorLineInfo({ text: overlay.buffer, cursor });
  const lineHint = info.lineCount > 1 ? ` · line ${info.line + 1}/${info.lineCount}` : "";
  const pending = overlay.external_editor_request_id === undefined ? "" : " · editor open";
  const bufferRows = wrapBufferRows(overlay.buffer, width);
  const { rowIndex, column } = cursorWrapPosition(overlay.buffer, cursor, width);
  const optionRows = overlay.options === undefined || overlay.options.length === 0
    ? []
    : [clipDisplay(`Options: ${overlay.options.map((option) => `${option.id} — ${option.text}`).join(" · ")}`, width)];
  const errorRows = overlay.error === undefined ? [] : [clipDisplay(`! ${overlay.error}`, width)];
  const rows = [
    clipDisplay(`Answering: ${overlay.question}${lineHint}${pending}`, width),
    ...optionRows,
    ...bufferRows,
    ...errorRows,
    clipDisplay(`[${vimModeLabel(overlay.editor)}] Enter to submit, Shift+Enter for a new line, Esc to cancel · Ctrl+V vim · Ctrl+E external editor`, width),
  ];
  // Question plus any options rows precede the editable buffer.
  return { text: rows.join("\n"), cursorRow: 1 + optionRows.length + rowIndex, cursorColumn: column };
}

/**
 * Non-color fallback: a plain, non-destructive `[x]` marker bracketing the
 * character at the cursor, on the exact row `composeOverlayContent` reports
 * — real terminals with `NO_COLOR`/no truecolor still show where the cursor
 * is, just without a true reverse-video cell.
 */
function plainComposeCursorText(compose: ComposeOverlayContent): string {
  const rows = compose.text.split("\n");
  const target = rows[compose.cursorRow];
  if (target === undefined) return compose.text;
  const column = Math.min(compose.cursorColumn, target.length);
  rows[compose.cursorRow] = `${target.slice(0, column)}[${target[column] ?? " "}]${target.slice(column + 1)}`;
  return rows.join("\n");
}

/**
 * Colored path: overwrites the already-`drawPane`-painted cursor row with an
 * identical row except the cursor's cell wears real reverse video, splicing
 * the styled interior back between the two border characters `drawPane`
 * already wrote either side of it (the same "direct row assignment, not
 * put()/clip()" idiom `renderScene`'s status-bar/notification-band writes
 * already use, for the identical reason: an embedded SGR byte is not a
 * single display cell to `put()`/`displayCells`).
 */
function paintComposeCursor(canvas: string[][], app: AppModel, pane: PaneRect, totalColumns: number): void {
  const compose = composeOverlayContent(app, pane);
  if (compose === null) return;
  // A cursor row past what drawPane actually painted (the pane's content is
  // clipped to `pane.rows - 2` rows) has nothing to overwrite — mirrors that
  // same truncation rather than painting past the pane's real interior.
  if (compose.cursorRow >= Math.max(0, pane.rows - 2)) return;
  const row = pane.y + 1 + compose.cursorRow;
  const existingRow = canvas[row];
  if (existingRow === undefined) return;
  const width = Math.max(1, pane.columns - 2);
  const interiorStart = pane.x + 1;
  const existingText = existingRow.join("");
  const prefix = existingText.slice(0, interiorStart);
  const interior = existingText.slice(interiorStart, interiorStart + width);
  const suffix = existingText.slice(interiorStart + width);
  const column = Math.min(compose.cursorColumn, Math.max(0, interior.length - 1));
  const before = interior.slice(0, column);
  const atCell = interior[column] ?? " ";
  const after = interior.slice(column + 1);
  const styledInterior = `${before}${REVERSE_VIDEO_ON}${atCell}${REVERSE_VIDEO_OFF}${after}`;
  canvas[row] = [prefix + styledInterior + suffix, ...Array<string>(Math.max(0, totalColumns - 1)).fill("")];
}

/**
 * Renders an armed destructive confirmation (`tree.prune`, wave1/tui-contracts)
 * in place of normal screen content — the same "blind action" concern the
 * `userinput.answer` compose overlay above addresses for typing: an operator
 * must see what they are about to confirm before Enter/Escape resolves it.
 */
function confirmationOverlay(app: AppModel, pane: PaneRect): string | null {
  // AppModel.confirmation (three-field overlay era) is superseded by the
  // single AppModel.overlay slot (wave2/tui-input-model, types.ts) — reads
  // the new shape; the rendered behavior for a "confirm" overlay is
  // unchanged.
  if (app.overlay?.kind !== "confirm") return null;
  const width = Math.max(1, pane.columns - 2);
  return [
    clipDisplay(app.overlay.title, width),
    clipDisplay(app.overlay.detail, width),
    clipDisplay("(Enter to confirm, Esc to cancel)", width),
  ].join("\n");
}

/**
 * Renders an operator-authored command form in place of screen content. The
 * reducer owns the schema and validation; this is deliberately only a
 * faithful projection of that typed state, so no renderer default can become
 * an unreviewed command value.
 */
function operatorFormOverlay(app: AppModel, pane: PaneRect): string | null {
  const form = app.overlay?.kind === "operator_form" ? app.overlay : null;
  if (form === null) return null;
  const width = Math.max(1, pane.columns - 2);
  const taskForm = form.command.startsWith("taskcomposer.");
  const fields = Object.entries(form.fields).flatMap(([name, value]) => {
    const marker = name === form.active_field ? ">" : " ";
    const cursor = Math.max(0, Math.min(value.length, form.field_cursor ?? value.length));
    const visibleValue = name === form.active_field
      ? `${value.slice(0, cursor)}_${value.slice(cursor)}`
      : value;
    const label = taskForm && name === "task" ? form.task_mode === "answer" ? "question" : "task" : name.replaceAll("_", " ");
    return `${marker} ${label}: ${visibleValue}`.split("\n").flatMap((line) => wrapDisplay(line, width));
  });
  return [
    ...(taskForm ? [
      clipDisplay("REVOY2  /  NATIVE COCKPIT", width),
      "─".repeat(width),
      clipDisplay(form.task_mode === "answer" ? "Ask a question. Read-only answer; no tools, executable plan, or campaign." : "Describe the outcome. Revoy2 plans, checks, and starts safe work by default.", width),
      "",
    ] : []),
    clipDisplay(form.title.toUpperCase(), width),
    ...(form.reference_attachments ?? []).flatMap((attachment) => wrapDisplay(`Reference snapshot: ${attachment.display_name}`, width)),
    ...(form.detail === undefined ? [] : [...wrapDisplay(`Question: ${form.detail}`, width), ""]),
    ...fields,
    ...(form.error === null ? [] : [clipDisplay(`! ${form.error}`, width)]),
    "",
    clipDisplay(form.task_mode === "answer" ? "Enter ask   Esc cancel" : taskForm ? "Enter start task   Esc cancel   Ctrl+P commands" : "Tab field   Enter submit   Esc cancel", width),
  ].join("\n");
}

function resolveActiveScreen(app: AppModel, pane: PaneRect, options: FrameOptions): string | null {
  const module = availableScreens(app.grantedCapabilities).find((candidate) => candidate.id === app.screen);
  if (!module) return null;
  const width = Math.max(1, pane.columns - 2);
  const height = Math.max(1, pane.rows - 2);
  try {
    const raw = app.screens.get(module.id);
    const projected = module.project(raw, { width, height, granted_capabilities: app.grantedCapabilities, read_model: app.readModel, uct_reader: app.uctReader });
    const rows = module.render({
      projection: projected,
      width,
      height,
      frame_count: options.frame_count,
      color: options.color === true,
      unicode: options.unicode !== false,
      theme: options.theme,
      color_mode: options.color_mode,
      transitions: app.devtoolsTransitions,
      // AppModel.selectedNode (tree-only) is superseded by the per-screen
      // AppModel.selection map (wave2/tui-input-model, operator-selection.ts's
      // ScreenSelection) — reads the active screen's own selection entry.
      selected_id: app.selection.get(app.screen)?.id,
      scroll_offset: app.scrollOffsets.get(app.screen),
      live_edge: app.frontierLiveEdges.get(app.screen),
    });
    return rows.join("\n");
  } catch (err) {
    // A registered screen that throws must not silently collapse to the generic
    // output pane — that hides the failure and makes a broken screen look like
    // "no screen active". Surface it as an explicit inline error marker so the
    // operator can see which screen failed and why, instead of a blank pane.
    const message = err instanceof Error ? err.message : String(err);
    return [
      clipDisplay(`! ${module.id} render error`, width),
      clipDisplay(`  ${message.replace(/\s*\n\s*/g, " ")}`, width),
    ].join("\n");
  }
}

function boundedPlainRow(value: string, columns: number): string {
  const clipped = clipDisplay(value, columns);
  return clipped + " ".repeat(Math.max(0, columns - displayWidth(clipped)));
}

/** Keep color only when its paired plain row proves the visible-width contract. */
function boundedStyledRow(styled: string, plain: string, columns: number): string {
  return displayWidth(plain) === columns ? styled : boundedPlainRow(plain, columns);
}

function drawPane(canvas: string[][], pane: PaneRect, title: string, content: string, unicode: boolean, focused = false): void {
  if (pane.columns < 2 || pane.rows < 2) { put(canvas, pane.x, pane.y, clip(title, pane.columns)); return; }
  const border = focusBorderGlyphs(unicode, focused);
  const glyph = unicode
    ? { ...border, tl: focused ? "╔" : "┌", tr: focused ? "╗" : "┐", bl: focused ? "╚" : "└", br: focused ? "╝" : "┘" }
    : { ...border, tl: "+", tr: "+", bl: "+", br: "+" };
  put(canvas, pane.x, pane.y, glyph.tl + glyph.horizontal.repeat(Math.max(0, pane.columns - 2)) + glyph.tr);
  put(canvas, pane.x, pane.y + pane.rows - 1, glyph.bl + glyph.horizontal.repeat(Math.max(0, pane.columns - 2)) + glyph.br);
  for (let row = 1; row < pane.rows - 1; row += 1) {
    put(canvas, pane.x, pane.y + row, glyph.vertical);
    put(canvas, pane.x + pane.columns - 1, pane.y + row, glyph.vertical);
  }
  put(canvas, pane.x + 2, pane.y, clip(` ${title} `, Math.max(0, pane.columns - 4)));
  const contentRows = content.split("\n").slice(0, Math.max(0, pane.rows - 2));
  const width = Math.max(0, pane.columns - 2);
  contentRows.forEach((line, index) => {
    const resolved = resolveContentLine(line, width);
    put(canvas, pane.x + 1, pane.y + index + 1, resolved.plain);
    if (resolved.styled !== null) overwriteColoredContentRow(canvas, pane, index, resolved.styled, width);
  });
}

/**
 * What `drawPane` actually paints for one content line: the plain (SGR-
 * stripped) text, clipped to `width` the ordinary display-cell-safe way,
 * plus — only when that stripping+clipping needed no truncation at all, so
 * the colored variant's real characters land in exactly the same columns —
 * the ANSI-aware clipped colored variant. `renderScene`'s `FramePane.content`
 * (below) calls this too, so a structure-aware renderer sees the identical
 * per-line decision `drawPane` made, not an independently-derived
 * approximation of it (this function's own single source of truth is what
 * makes that guarantee possible).
 *
 * A colored screen's content line may already carry embedded SGR (e.g.
 * campaigns.ts's nodeStateColor rows), already clipped to this exact
 * interior width by the screen's own ANSI-aware clipAnsi call. `put()`'s
 * per-display-cell canvas (`displayCells`) has no notion of a zero-width
 * escape byte — it treats every codepoint, escape bytes included, as its own
 * one-column cell — so writing a colored line through it directly shifts
 * every real glyph past the escape bytes' column count, running the row past
 * its interior width and losing whatever trails off the canvas edge
 * (frequently the line's own closing reset — audit finding). Splicing the
 * colored variant back in only once the plain geometry is already proven
 * safe mirrors `paintComposeCursor`'s own established "direct row
 * assignment, not put()/clip()" idiom, for the identical reason.
 */
function resolveContentLine(line: string, width: number): { plain: string; styled: string | null } {
  const plainLine = stripAnsi(line);
  const clippedPlain = clip(plainLine, width);
  if (plainLine === line || plainLine !== clippedPlain) return { plain: clippedPlain, styled: null };
  return { plain: clippedPlain, styled: clipAnsi(line, width) };
}

/** See `resolveContentLine`'s own doc comment: splices an already-verified-
 * safe colored content line over the plain interior `drawPane` just
 * painted, exactly like `paintComposeCursor` splices the cursor cell. */
function overwriteColoredContentRow(canvas: string[][], pane: PaneRect, rowIndex: number, styledLine: string, width: number): void {
  const row = pane.y + 1 + rowIndex;
  const existingRow = canvas[row];
  if (existingRow === undefined) return;
  const interiorStart = pane.x + 1;
  const existingText = existingRow.join("");
  const prefix = existingText.slice(0, interiorStart);
  const suffix = existingText.slice(interiorStart + width);
  canvas[row] = [prefix + styledLine + suffix, ...Array<string>(Math.max(0, existingRow.length - 1)).fill("")];
}
/**
 * Cell-width-aware canvas write (4F.9): wide glyphs occupy a head cell plus an
 * empty continuation cell; combining marks/ZWJ/VS16 arrive pre-folded via
 * displayCells. Overwriting half of an existing wide glyph blanks its orphaned
 * partner cell so the row never gains or loses a display column.
 */
function put(canvas: string[][], x: number, y: number, value: string): void {
  const row = canvas[y]; if (!row) return;
  const cells = displayCells(value);
  for (const [offset, cell] of cells.entries()) {
    const index = x + offset;
    if (index < 0 || index >= row.length) continue;
    // A wide head whose continuation would fall off the row edge cannot fit.
    if (cell !== "" && offset + 1 < cells.length && cells[offset + 1] === "" && index === row.length - 1) { row[index] = " "; continue; }
    const old = row[index];
    if (cell !== "" && old === "" && index > 0 && displayWidth(row[index - 1] ?? "") === 2) row[index - 1] = " ";
    if (displayWidth(old) === 2 && offset === cells.length - 1 && index + 1 < row.length && row[index + 1] === "") row[index + 1] = " ";
    row[index] = cell;
  }
}
const clip = clipDisplay;

/** Real-terminal renderer: diffs frames and writes only changed rows (frame-diffing, 4F.3). */
export class StdoutRenderer implements RendererPort {
  private entered = false;
  /** Removes the alternate screen if the process exits without a graceful restore(). */
  private exitGuard: (() => void) | null = null;
  private previous: readonly string[] | null = null;
  /** Geometry of the last painted frame (`render()`'s columns + row count), used to detect a resize between frames. */
  private previousGeometry: { readonly columns: number; readonly rows: number } | null = null;

  constructor(
    private readonly stream: { write(value: string): unknown },
    private readonly options: { clear_screen?: boolean; synchronized_output?: boolean } = {},
  ) {}

  enter(): void {
    if (this.entered) return;
    // `\u001b[?1049h` switches into the terminal's alternate screen buffer
    // (the same `smcup` mechanism a full-screen editor uses) so the TUI
    // paints into its own buffer instead of scrollback — without it, the
    // shell command and boot noise that preceded launch sit above the
    // cockpit for the entire session. Gated by the exact same
    // `clear_screen` option the pre-existing `\u001b[2J\u001b[H` clear
    // already used, so `MemoryRenderer`-based tests (a separate class, never
    // constructed with this option at all) are unaffected either way.
    if (this.options.clear_screen !== false) {
      this.stream.write("\u001b[?1049h\u001b[2J\u001b[H");
      // Leaving the alternate buffer cannot depend on a caller remembering to
      // call restore(). `runTui`'s crash path (`runCrashBoundary`) does not:
      // only the graceful `finish()` does. Before the alternate screen that was
      // cosmetic; with it, an uncaught failure would strand the operator inside
      // a buffer with no shell prompt, on a terminal that looks hung — worse
      // than the crash being reported. The renderer mutates the terminal, so
      // the renderer undoes it.
      this.exitGuard = () => { this.restore(); };
      process.once("exit", this.exitGuard);
    }
    this.entered = true;
    this.previous = null;
    this.previousGeometry = null;
  }

  /**
   * Emits one frame atomically when the caller enabled synchronized output.
   *
   * DEC private mode 2026 (`?2026h` begin / `?2026l` end) asks the terminal to
   * buffer everything between the markers and present it in a single update.
   * Without it a multi-row diff is painted incrementally and a fast update can
   * be observed mid-repaint — the tearing that reads as "flicker". This is a
   * property of how the bytes reach the terminal, not of any widget or layout
   * code above it, which is why it lives here and nowhere else.
   *
   * An unsupported terminal ignores an unknown private mode, so the markers are
   * harmless where 2026 is absent. They are still NOT unconditional: a captured,
   * piped, or recorded stream is not a terminal at all, and the bytes would be
   * pollution in a golden frame or a tmux acceptance recording. The caller —
   * which alone knows whether `stream` is a real TTY — decides, and the default
   * is off so every existing capture stays byte-identical.
   */
  private wrapSynchronized(payload: string): string {
    if (this.options.synchronized_output !== true) return payload;
    return `\u001b[?2026h${payload}\u001b[?2026l`;
  }

  render(frame: RenderInput): void {
    if (!this.entered) this.enter();
    const text = frame.text;
    const rows = text.split("\n");
    const geometry = { columns: frame.scene.columns, rows: rows.length };
    // A real terminal resize is an out-of-band event: the physical terminal
    // reflows or clears its own buffer independent of any byte this renderer
    // ever sent, so the diff cache below (`this.previous`, built entirely
    // from bytes *we* wrote) no longer describes what is actually on screen.
    // Trusting it after a geometry change would skip repainting any row whose
    // freshly computed text happens to match what we last computed for that
    // index — even though the physical cell the terminal now shows there is
    // whatever its own resize handling left behind, not that text. Detecting
    // the size change and forcing an unconditional full repaint (like the
    // very first frame) is the only way to guarantee the screen matches the
    // model right after a resize, independent of coincidental text equality.
    const resized = this.previousGeometry !== null
      && (this.previousGeometry.columns !== geometry.columns || this.previousGeometry.rows !== geometry.rows);
    if (this.previous === null || resized) {
      // The last row already occupies the terminal's bottom row. A newline
      // would scroll the frame while leaving the diff cache unshifted.
      const terminator = this.options.clear_screen === false ? "\n" : "";
      // Only a real resize (not the first frame, where enter() already
      // cleared) needs its own explicit clear — and only when the alternate
      // screen/clear convention is enabled at all, so a `clear_screen: false`
      // stream (append-only capture, MemoryRenderer-style test doubles) never
      // gains bytes it did not already emit.
      const clear = resized && this.options.clear_screen !== false ? "\u001b[2J\u001b[H" : "";
      this.stream.write(this.wrapSynchronized(`${clear}\u001b[0m${text}\u001b[0m${terminator}`));
      this.previous = rows;
      this.previousGeometry = geometry;
      return;
    }
    let out = "\u001b[0m";
    let changed = false;
    const count = Math.max(rows.length, this.previous.length);
    for (let y = 0; y < count; y++) {
      const cur = rows[y] ?? "";
      if (cur === (this.previous[y] ?? "")) continue;
      changed = true;
      // `\u001b[K` erases from the cursor to the end of the line, so the row's
      // old tail is cleared without writing a single padding space. The
      // previous implementation right-padded to the longest raw row `.length`
      // first, which measured SGR escape bytes as if they were visible columns:
      // a colored row could be padded by hundreds of spaces it did not need,
      // and the padding was pure output bloat because it never affected the
      // equality test above (padding both sides to one width cannot turn a
      // difference into a match, nor a match into a difference).
      out += `\u001b[${y + 1};1H${cur}\u001b[K`;
    }
    if (changed) this.stream.write(this.wrapSynchronized(out + "\u001b[0m"));
    this.previous = rows;
    this.previousGeometry = geometry;
  }

  restore(): void {
    if (!this.entered) return;
    // Clear the alternate buffer for tidiness, then `\u001b[?1049l` leaves it
    // and restores the terminal's original screen and scrollback — the
    // `rmcup` half of the pair `enter()` opened. Same `clear_screen` gate as
    // the original clear, so restoring terminal state stays a single
    // opt-out, not two independently toggleable behaviors.
    if (this.options.clear_screen !== false) this.stream.write("\u001b[2J\u001b[H\u001b[?1049l");
    // Idempotent: restore() may run from the exit guard, from the graceful
    // path, or both. Dropping the guard here keeps repeated enter/restore
    // cycles from accumulating listeners.
    if (this.exitGuard !== null) {
      process.removeListener("exit", this.exitGuard);
      this.exitGuard = null;
    }
    this.entered = false;
    this.previous = null;
    this.previousGeometry = null;
  }
}
