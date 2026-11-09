/**
 * Compact, pure UCT-search header projection.
 *
 * This is deliberately a graph renderer rather than another view over
 * `TreeRow`: `TreeRow` carries a display depth but not an edge.  The header
 * accepts the canonical `campaign.tree` node fields (including `parent_id`)
 * directly, or an exact edge list supplied by a caller.  It never derives
 * parentage from display order or depth, and it never creates a decorative
 * node to make a sparse tree look busy.
 *
 * A terminal cell is finite.  The renderer first compresses the exact node
 * set into Unicode Braille dots (eight addressable positions per cell) before
 * it elides anything.  The returned metrics make that degradation explicit;
 * a host can offer the full Tree screen when the supplied graph exceeds even
 * that physical capacity.
 */

import { clipDisplay, displayWidth, sanitizeUntrustedTerminalText } from "./widgets.js";
import { stripAnsi } from "./player-piano.js";
import { deriveTheme, toForegroundSgr, type ColorMode, type RunTheme } from "./theme.js";

export type UctHeaderNodeState =
  | "pending"
  | "expanding"
  | "verified"
  | "claimed"
  | "failed"
  | "pruned"
  | "interrupted"
  | "abandoned"
  | "awaiting_review"
  | (string & {});

/** The structural subset returned by the canonical `campaign.tree` query. */
export interface UctHeaderNode {
  readonly id: string;
  readonly parent_id?: string | null;
  readonly action_description?: string;
  readonly label?: string;
  readonly state: UctHeaderNodeState;
  readonly visit_count?: number;
}

/** An exact edge supplied by a transport that already exposes edge records. */
export interface UctHeaderEdge {
  readonly from: string;
  readonly to: string;
}

export type UctGovernanceTone = "success" | "warning" | "danger" | "neutral";

/**
 * A terse, already-authoritative governance fact.  `tone` is supplied by the
 * caller; this renderer never turns a count, label, or missing value into a
 * governance verdict on its own.
 */
export interface UctGovernanceSignal {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly tone: UctGovernanceTone;
}

export interface UctHeaderInput {
  readonly nodes: readonly UctHeaderNode[];
  /**
   * When present, this is the whole edge source of truth.  When omitted, one
   * edge is projected for each node whose canonical `parent_id` names another
   * supplied node.  No relationship is ever inferred from row depth/order.
   */
  readonly edges?: readonly UctHeaderEdge[];
  readonly governance?: readonly UctGovernanceSignal[];
  readonly backtracks?: readonly UctBacktrack[];
  readonly dropped_backtracks?: number;
}

/** Exact observed reverse traversal, not a transition inferred from state. */
export interface UctBacktrack {
  readonly from: string;
  readonly to: string;
  readonly occurred_at_ms: number;
  readonly playback_at_ms?: number;
}

export const BACKTRACK_DISPLAY_MS = 1_500;

/** Accept only real timestamped backtrack payloads from the existing stream. */
export function recentUctBacktracks(stream: unknown, nowMs: number, campaignId: string | null = null): readonly UctBacktrack[] {
  if (campaignId === null || !Number.isFinite(nowMs) || typeof stream !== "object" || stream === null) return [];
  const lines = (stream as { lines?: unknown }).lines;
  if (!Array.isArray(lines)) return [];
  const seen = new Set<string>();
  const result: UctBacktrack[] = [];
  for (const value of lines) {
    if (typeof value !== "object" || value === null) continue;
    const line = value as Record<string, unknown>;
    // Node identities such as "root" can recur across campaigns. A matching
    // edge alone does not authorize attributing another campaign's movement.
    if (line.campaign_id !== campaignId) continue;
    if (line.synthetic !== false || line.event_kind !== "loop.backtracked" || typeof line.ts !== "string") continue;
    const payload = line.loop_event;
    if (typeof payload !== "object" || payload === null) continue;
    const event = payload as Record<string, unknown>;
    if (typeof event.node_id !== "string" || typeof event.parent_id !== "string") continue;
    const occurred = Date.parse(line.ts);
    const age = nowMs - occurred;
    if (!Number.isFinite(occurred) || age < 0 || age >= BACKTRACK_DISPLAY_MS) continue;
    const key = JSON.stringify([event.node_id, event.parent_id, occurred]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ from: event.node_id, to: event.parent_id, occurred_at_ms: occurred });
  }
  return result;
}

export interface UctHeaderOptions {
  readonly width: number;
  readonly height: number;
  readonly theme?: RunTheme;
  readonly color?: boolean;
  readonly color_mode?: ColorMode;
  /** Full-width product surface; compact remains available to embedded views. */
  readonly presentation?: "compact" | "hero";
  readonly now_ms?: number;
  /**
   * Draws the graph's own `┌─┐/│ │/└─┘` box around its output. Defaults to
   * `true` for back-compat callers (e.g. the Console screen's standalone
   * frontier header) that are not already embedded inside another frame.
   *
   * The M2 shell band (ui-spec §2.2/§5, ADR-162 decision 2) owns the ONE
   * frame around its header; a caller that embeds this graph inside that
   * band's already-bordered interior passes `false` here so the full
   * interior goes to the graph instead of drawing a second nested box
   * around it — that double frame was consuming rows the interior was
   * supposed to have (`4/24` instead of `6/24`, `0/20` instead of `2/20`).
   * The would-be border title/metrics text is still returned via `title`
   * for the caller to place in its own frame instead.
   */
  readonly framed?: boolean;
}

export interface UctHeaderMetrics {
  readonly node_count: number;
  readonly edge_count: number;
  readonly plottable_edge_count: number;
  readonly unresolvable_edge_count: number;
  readonly rendered_node_count: number;
  readonly elided_node_count: number;
  /**
   * Widest branching factor over parents whose children are all plottable —
   * the number that says this is a SEARCH and not a list.
   *
   * Reported at every encoding, including `braille` and `elided` where the
   * spine itself cannot be drawn. That is the point: the fan is the fact, the
   * spine is only one way of showing it, and a fact that disappears when the
   * drawing does was never really reported.
   */
  readonly fan_max: number;
  readonly encoding: "direct" | "braille" | "elided";
  /** Natural 4-column rank bands shrink to this value when width is bounded. */
  readonly rank_band_width: number;
  /** Natural 2-row node spacing shrinks to this value when height is bounded. */
  readonly row_spacing: number;
  readonly graph_width: number;
  readonly graph_height: number;
  readonly signal_columns: readonly [number, number];
}

export interface UctHeaderProjection {
  readonly lines: readonly string[];
  readonly metrics: UctHeaderMetrics;
  /**
   * The border title/metrics text ("UCT · N nodes · snapshot · direct"),
   * always computed but only drawn inline (inside the graph's own box) when
   * `framed !== false`. An embedding caller that supplies `framed: false`
   * reads this instead, to place in the ONE frame it already owns.
   */
  readonly title: string;
}

type Tone = UctGovernanceTone | "accent" | "muted";

interface CanonicalNode {
  readonly id: string;
  readonly label: string;
  readonly state: UctHeaderNodeState;
  readonly visit_count: number;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Cell {
  glyph: string;
  tone: Tone;
  node: boolean;
}

const NATURAL_RANK_BAND_WIDTH = 4;
const NATURAL_ROW_SPACING = 2;
/**
 * Share of the graph canvas the direct renderer may fill with node glyphs
 * before handing over to the braille field.
 *
 * The pre-existing capacity test asks only whether the TALLEST RANK fits its
 * column. A deep, narrow tree passes that at any size — 121 nodes at 60x4 kept
 * rendering "direct" and produced a solid wall of glyphs with no room left for
 * the edges and spines that carry the actual meaning. Legibility here is not
 * about any one rank fitting; it is about the interstices surviving, and they
 * are the first thing crowding destroys.
 *
 * A quarter is where the fan spine and its runs still have somewhere to go. Past
 * it the braille field says strictly more: eight sub-positions per cell carry
 * the same population in an eighth of the room, and `fan_max` keeps reporting
 * the branching factor the spine can no longer draw.
 */
const DIRECT_INK_CEILING = 0.25;
const BRAILLE_BITS = [0x01, 0x08, 0x02, 0x10, 0x04, 0x20, 0x40, 0x80] as const;

function positive(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function pad(value: string, width: number): string {
  const visible = displayWidth(stripAnsi(value));
  return visible >= width ? value : `${value}${" ".repeat(width - visible)}`;
}

function clipped(value: string, width: number): string {
  return clipDisplay(sanitizeUntrustedTerminalText(value), Math.max(0, width));
}

function dedupeNodes(nodes: readonly UctHeaderNode[]): readonly CanonicalNode[] {
  const seen = new Set<string>();
  const result: CanonicalNode[] = [];
  for (const node of nodes) {
    if (typeof node.id !== "string" || node.id.length === 0 || seen.has(node.id)) continue;
    seen.add(node.id);
    result.push({
      id: node.id,
      label: typeof node.label === "string" && node.label.length > 0
        ? node.label
        : typeof node.action_description === "string" && node.action_description.length > 0
          ? node.action_description
          : node.id,
      state: node.state,
      visit_count: typeof node.visit_count === "number" && Number.isFinite(node.visit_count) ? node.visit_count : 0,
    });
  }
  return result;
}

function exactEdges(input: UctHeaderInput, nodeIds: ReadonlySet<string>): readonly UctHeaderEdge[] {
  const candidates = input.edges ?? input.nodes.flatMap((node) =>
    typeof node.parent_id === "string" ? [{ from: node.parent_id, to: node.id }] : [],
  );
  const seen = new Set<string>();
  const edges: UctHeaderEdge[] = [];
  for (const edge of candidates) {
    if (typeof edge.from !== "string" || typeof edge.to !== "string") continue;
    const key = `${edge.from}\u0000${edge.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Keep unresolved edges in the source count; they are not silently turned
    // into a connection to some other node.  Drawing needs two real endpoints.
    if (nodeIds.has(edge.from) && nodeIds.has(edge.to) && edge.from !== edge.to) edges.push(edge);
  }
  return edges;
}

function sourceEdgeCount(input: UctHeaderInput): number {
  const candidates = input.edges ?? input.nodes.flatMap((node) =>
    typeof node.parent_id === "string" ? [{ from: node.parent_id, to: node.id }] : [],
  );
  const seen = new Set<string>();
  for (const edge of candidates) {
    if (typeof edge.from !== "string" || typeof edge.to !== "string") continue;
    seen.add(`${edge.from}\u0000${edge.to}`);
  }
  return seen.size;
}

/** A parent-edge-only rank assignment; cycles stay in rank zero rather than being invented into a tree. */
function ranks(nodes: readonly CanonicalNode[], edges: readonly UctHeaderEdge[]): ReadonlyMap<string, number> {
  const parentByChild = new Map<string, string>();
  for (const edge of edges) if (!parentByChild.has(edge.to)) parentByChild.set(edge.to, edge.from);
  const result = new Map<string, number>();
  // Walk paths iteratively: a 20k-node chain must reach LOD without
  // overflowing the JS call stack or repeatedly scanning the path.
  for (const node of nodes) {
    if (result.has(node.id)) continue;
    const path: string[] = [];
    const positions = new Map<string, number>();
    let current: string | undefined = node.id;
    while (current !== undefined && !result.has(current) && !positions.has(current)) {
      positions.set(current, path.length);
      path.push(current);
      current = parentByChild.get(current);
    }
    if (current !== undefined && positions.has(current)) {
      const cycleStart = positions.get(current)!;
      for (const cycleId of path.slice(cycleStart)) result.set(cycleId, 0);
      path.length = cycleStart;
    }
    let rank = current === undefined ? 0 : (result.get(current) ?? 0) + 1;
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const id = path[index]!;
      if (!result.has(id)) result.set(id, rank++);
    }
  }
  return result;
}

function stateTone(state: UctHeaderNodeState): Tone {
  switch (state) {
    case "verified":
      return "success";
    case "claimed":
    case "expanding":
    case "awaiting_review":
      return "warning";
    case "failed":
    case "interrupted":
      return "danger";
    case "pending":
    case "pruned":
    case "abandoned":
      return "muted";
    default:
      return "muted";
  }
}

function nodeGlyph(state: UctHeaderNodeState): string {
  switch (state) {
    // `expanding` and `verified` were BOTH "●", separated only by tone — and
    // `options.color` is optional, so on a monochrome render work in progress
    // was drawn as finished work. Frame p040 of the 2026-08-29 reel shows the
    // header reading `◉───●` while the campaign reported `nodes 0/2` verified.
    case "expanding": return "◐";
    case "awaiting_review": return "◆";
    case "verified": return "●";
    case "claimed": return "◉";
    case "failed": return "×";
    case "interrupted": return "!";
    case "pruned": return "·";
    case "abandoned": return "·";
    case "pending": return "○";
    default: return "?";
  }
}

function toneSgr(tone: Tone, theme: RunTheme, mode: ColorMode): string {
  switch (tone) {
    case "success": return toForegroundSgr(theme.colors.success, mode);
    case "warning": return toForegroundSgr(theme.colors.warning, mode);
    case "danger": return toForegroundSgr(theme.colors.danger, mode);
    case "accent": return toForegroundSgr(theme.colors.accent, mode);
    case "neutral":
    case "muted": return toForegroundSgr(theme.colors.muted, mode);
  }
}

function decorate(value: string, tone: Tone, color: boolean, theme: RunTheme, mode: ColorMode): string {
  return color ? `${toneSgr(tone, theme, mode)}${value}\u001b[0m` : value;
}

function blankCanvas(width: number, height: number): Cell[][] {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => ({ glyph: " ", tone: "muted" as Tone, node: false })));
}

function put(canvas: Cell[][], point: Point, glyph: string, tone: Tone, node = false): void {
  const row = canvas[point.y];
  if (!row || point.x < 0 || point.x >= row.length) return;
  const cell = row[point.x]!;
  if (node || !cell.node) {
    cell.glyph = glyph;
    cell.tone = tone;
    cell.node = node;
  }
}

function drawEdge(canvas: Cell[][], from: Point, to: Point): void {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  if (steps === 0) return;
  for (let step = 1; step < steps; step += 1) {
    const x = Math.round(from.x + (dx * step) / steps);
    const y = Math.round(from.y + (dy * step) / steps);
    const glyph = dy === 0 ? "─" : dx === 0 ? "│" : dy > 0 ? "╲" : "╱";
    put(canvas, { x, y }, glyph, "accent");
  }
}

function signalColumns(width: number, height: number, count: number): readonly [number, number] {
  if (width < 54 || height < 3 || count === 0) return [0, 0];
  const each = width >= 100 ? 18 : width >= 72 ? 14 : 10;
  return [each, each];
}

function directPositions(
  nodes: readonly CanonicalNode[],
  rankById: ReadonlyMap<string, number>,
  rankBandWidth: number,
  graphHeight: number,
  rowSpacing: number,
): ReadonlyMap<string, Point> {
  const grouped = new Map<number, CanonicalNode[]>();
  for (const node of nodes) {
    const rank = rankById.get(node.id) ?? 0;
    const group = grouped.get(rank);
    if (group) group.push(node);
    else grouped.set(rank, [node]);
  }
  const points = new Map<string, Point>();
  for (const [rank, group] of grouped) {
    for (let index = 0; index < group.length; index += 1) {
      const slot = index * rowSpacing;
      const x = rank * rankBandWidth + (Math.floor(slot / graphHeight) % rankBandWidth);
      const y = slot % graphHeight;
      points.set(group[index]!.id, { x, y });
    }
  }
  return points;
}

/**
 * Children per parent, from the already-exact edge list.
 *
 * Deliberately derived from `exactEdges` rather than from a `children_ids`
 * field on the wire: those edges are the ones this renderer will actually draw,
 * so a fan counted here can never claim a branch the graph does not show. It
 * also means the fan costs no new data — nothing has to be threaded through
 * `uctNodes` for it.
 */
function childrenByParent(edges: readonly UctHeaderEdge[]): ReadonlyMap<string, string[]> {
  const map = new Map<string, string[]>();
  for (const edge of edges) {
    const children = map.get(edge.from);
    if (children) children.push(edge.to);
    else map.set(edge.from, [edge.to]);
  }
  return map;
}

/** Widest branching factor observed, whatever the encoding ends up being. */
function widestFan(edges: readonly UctHeaderEdge[]): number {
  let widest = 0;
  for (const children of childrenByParent(edges).values()) widest = Math.max(widest, children.length);
  return widest;
}

/**
 * The sibling spine: one interstitial column, immediately right of a parent,
 * carrying the fan of alternatives that parent opened.
 *
 * WHY A SPINE AND NOT N DIAGONALS. `drawEdge` draws each parent→child link
 * independently, so a three-way branch renders as three diverging strokes that
 * read as three unrelated relationships. The spine says the true thing instead:
 * one decision point, several alternatives considered from it. The information
 * lives in the space BETWEEN the nodes, which is otherwise inert.
 *
 * Occupies column `parent.x + 1` only — inside the existing 4-wide rank band
 * (node at 0, spine at 1, edge run at 2–3), so it costs no new cells. Below a
 * 3-wide band there is no interstitial column to draw in and the spine is
 * skipped; `fan_max` still reports the branching factor as a number, so the
 * fact survives the geometry that cannot show it.
 */
function drawFanSpine(
  canvas: Cell[][],
  parent: Point,
  childPoints: readonly Point[],
): boolean {
  if (childPoints.length < 2) return false;
  const spineX = parent.x + 1;
  const row = canvas[0];
  if (!row || spineX < 0 || spineX >= row.length) return false;

  // Siblings that did not all land in one column are not a drawable fan.
  // `directPositions` packs a rank column-major, so once a rank outgrows the
  // graph height the surplus wraps into the next column — and a spine drawn
  // through only the ones that fit would show a two-way branch where the search
  // actually made a three-way one. Refuse, let the per-edge strokes render, and
  // let `fan_max` carry the real branching factor as a number. A drawing that
  // silently narrows the fan is worse than no drawing.
  const columns = new Set(childPoints.map((point) => point.x));
  if (columns.size !== 1) return false;
  // Every sibling must also occupy its own row, or the spine would attach twice
  // at one point and imply fewer alternatives than were considered.
  if (new Set(childPoints.map((point) => point.y)).size !== childPoints.length) return false;

  const ys = childPoints.map((point) => point.y);
  const top = Math.min(parent.y, ...ys);
  const bottom = Math.max(parent.y, ...ys);
  const childYs = new Set(ys);

  for (let y = top; y <= bottom; y += 1) {
    const isChild = childYs.has(y);
    const glyph = y === bottom
      ? (isChild ? "└" : "│")
      : isChild
        ? (y === parent.y ? "┬" : "├")
        : "│";
    put(canvas, { x: spineX, y }, glyph, "accent");
  }
  // The parent's own row gets the tee that opens the fan, even when no child
  // shares it — otherwise the spine appears to start from nothing.
  if (!childYs.has(parent.y) && parent.y >= top && parent.y <= bottom) {
    put(canvas, { x: spineX, y: parent.y }, "┬", "accent");
  }
  // Short runs from the spine out to each child, so a child is never left
  // floating beside a column it is not visibly attached to.
  for (const child of childPoints) {
    for (let x = spineX + 1; x < child.x; x += 1) put(canvas, { x, y: child.y }, "─", "accent");
  }
  return true;
}

function renderDirect(
  nodes: readonly CanonicalNode[],
  edges: readonly UctHeaderEdge[],
  rankById: ReadonlyMap<string, number>,
  width: number,
  height: number,
  rankBandWidth: number,
  rowSpacing: number,
): { readonly canvas: Cell[][]; readonly positions: ReadonlyMap<string, Point> } {
  const canvas = blankCanvas(width, height);
  const positions = directPositions(nodes, rankById, rankBandWidth, height, rowSpacing);

  // A parent with two or more PLOTTED children gets a spine; everything else
  // keeps the existing per-edge stroke. `spined` records which parents were
  // drawn that way so their edges are not then over-drawn as diagonals on top.
  const spined = new Set<string>();
  if (rankBandWidth >= 3) {
    for (const [parentId, childIds] of childrenByParent(edges)) {
      const from = positions.get(parentId);
      if (!from) continue;
      const childPoints = childIds.flatMap((id) => { const point = positions.get(id); return point ? [point] : []; });
      if (drawFanSpine(canvas, from, childPoints)) spined.add(parentId);
    }
  }
  for (const edge of edges) {
    if (spined.has(edge.from)) continue;
    const from = positions.get(edge.from); const to = positions.get(edge.to);
    if (from && to) drawEdge(canvas, from, to);
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const [id, point] of positions) {
    const node = byId.get(id)!;
    put(canvas, point, nodeGlyph(node.state), stateTone(node.state), true);
  }
  return { canvas, positions };
}

function renderBraille(
  nodes: readonly CanonicalNode[],
  edges: readonly UctHeaderEdge[],
  rankById: ReadonlyMap<string, number>,
  width: number,
  height: number,
  rankBandWidth: number,
): { readonly canvas: Cell[][]; readonly rendered: number } {
  const canvas = blankCanvas(width, height);
  const grouped = new Map<number, CanonicalNode[]>();
  for (const node of nodes) {
    const rank = rankById.get(node.id) ?? 0;
    const group = grouped.get(rank);
    if (group) group.push(node);
    else grouped.set(rank, [node]);
  }
  const bits = Array.from({ length: height }, () => Array.from({ length: width }, () => 0));
  const representative = new Map<string, Point>();
  let rendered = 0;
  for (const [rank, group] of grouped) {
    const subWidth = rankBandWidth * 2;
    const capacity = subWidth * height * 4;
    for (let index = 0; index < Math.min(group.length, capacity); index += 1) {
      const xSub = index % subWidth;
      const ySub = Math.floor(index / subWidth);
      const x = rank * rankBandWidth + Math.floor(xSub / 2);
      const y = Math.floor(ySub / 4);
      const bit = BRAILLE_BITS[(ySub % 4) * 2 + (xSub % 2)]!;
      bits[y]![x]! |= bit;
      representative.set(group[index]!.id, { x, y });
      rendered += 1;
    }
  }
  // Lines remain exact endpoint relationships; where dense dots overwrite a
  // line cell the metrics still report the edge as supplied, never as a fake
  // connection.  Braille is a topology-density mode, not a state claim.
  for (const edge of edges) {
    const from = representative.get(edge.from); const to = representative.get(edge.to);
    if (from && to) drawEdge(canvas, from, to);
  }
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const value = bits[y]![x]!;
    if (value !== 0) put(canvas, { x, y }, String.fromCodePoint(0x2800 + value), "accent", true);
  }
  return { canvas, rendered };
}

function canvasLine(cells: readonly Cell[], color: boolean, theme: RunTheme, mode: ColorMode): string {
  if (!color) return cells.map((cell) => cell.glyph).join("");
  let result = "";
  let tone: Tone | undefined;
  for (const cell of cells) {
    if (tone !== cell.tone) {
      if (tone !== undefined) result += "\u001b[0m";
      result += toneSgr(cell.tone, theme, mode);
      tone = cell.tone;
    }
    result += cell.glyph;
  }
  return `${result}\u001b[0m`;
}

function signalText(signal: UctGovernanceSignal, width: number): string {
  return clipped(`${signal.label} ${signal.value}`.trim(), width);
}

/**
 * Returns a compact, deterministic graph projection plus measurable adaptive
 * layout facts.  `renderUctHeader` is the convenience form for consumers that
 * only need terminal rows.
 */
export function projectUctHeader(input: UctHeaderInput, options: UctHeaderOptions): UctHeaderProjection {
  const width = positive(options.width);
  const height = positive(options.height);
  const theme = options.theme ?? deriveTheme(undefined);
  const color = options.color === true;
  const mode = options.color_mode ?? "truecolor";
  const nodes = dedupeNodes(input.nodes);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = exactEdges(input, nodeIds);
  const sourceEdges = sourceEdgeCount(input);
  const signals = input.governance ?? [];
  const [leftSignalWidth, rightSignalWidth] = signalColumns(width, height, signals.length);
  const graphWidth = Math.max(1, leftSignalWidth > 0
    ? width - leftSignalWidth - rightSignalWidth - 4
    : width);
  const framed = options.framed !== false;
  const graphHeight = Math.max(1, framed ? height - 2 : height);
  const rankById = ranks(nodes, edges);
  const maxRank = nodes.reduce((max, node) => Math.max(max, rankById.get(node.id) ?? 0), 0);
  const rankCount = Math.max(1, maxRank + 1);
  const innerWidth = Math.max(1, framed ? graphWidth - 2 : graphWidth);
  // Depth can exceed the physical columns even at one column per rank.
  // Fold only the drawing coordinates into bounded rank buckets; exact edge
  // identities remain unchanged and this case must use density encoding.
  const layoutRanks = rankCount > innerWidth
    ? new Map([...rankById].map(([id, rank]) => [id, Math.floor(rank * innerWidth / rankCount)]))
    : rankById;
  const rankBandWidth = Math.max(1, Math.min(options.presentation === "hero" ? innerWidth : NATURAL_RANK_BAND_WIDTH, Math.floor(innerWidth / rankCount) || 1));
  const directCapacity = rankBandWidth * graphHeight;
  const perRank = new Map<number, number>();
  for (const node of nodes) {
    const rank = layoutRanks.get(node.id) ?? 0;
    perRank.set(rank, (perRank.get(rank) ?? 0) + 1);
  }
  const maxRankPopulation = Math.max(0, ...perRank.values());
  // Row spacing is chosen to KEEP THE FAN DRAWABLE, not only to fit the rank.
  //
  // The airy spacing exists so a chain does not look cramped, but it is a
  // preference, not a requirement — and spending it on blank rows while a fan
  // gets bounced to braille has the priority backwards. A 6-way fan needs 11
  // rows at spacing 2 and 6 at spacing 1: the same information, drawn tighter.
  // Compress first; hand over to the field only when even the tight spacing
  // cannot show the branching.
  const fan = widestFan(edges);
  const fanSpanAt = (spacing: number) => (fan > 1 ? (fan - 1) * spacing + 1 : 1);
  const rankFitsAt = (spacing: number) => maxRankPopulation * spacing <= directCapacity;
  const rowSpacing = rankFitsAt(NATURAL_ROW_SPACING) && fanSpanAt(NATURAL_ROW_SPACING) <= graphHeight
    ? NATURAL_ROW_SPACING
    : 1;
  // Three independent reasons to leave the direct renderer.
  const rankFits = rankFitsAt(rowSpacing);
  // Too crowded to read as a graph, even if every rank technically fits.
  const inkShare = nodes.length / Math.max(1, innerWidth * graphHeight);
  // The branching can no longer be DRAWN. A fan whose siblings do not all fit
  // in one column gets no spine (drawFanSpine refuses rather than narrow it),
  // and what renders instead is a tangle of diagonals that communicates less
  // about the search's structure than the braille field does — the diagonals
  // say "some things are connected somehow", the field at least says how much
  // is where. Direct rendering earns its place by showing the branching; when
  // it stops being able to, that IS the threshold.
  // N siblings sit at y = 0, rowSpacing, 2*rowSpacing … so the span they need
  // is (N-1)*rowSpacing + 1 rows, not N*rowSpacing. Getting this wrong by one
  // row pushed a perfectly drawable three-way fan into braille. By here the
  // spacing has already been compressed if that is what let the fan fit, so a
  // failure now means even the tight layout cannot show it.
  const fanFits = fanSpanAt(rowSpacing) <= graphHeight;
  const directPossible = rankCount <= innerWidth && rankFits && fanFits && inkShare <= DIRECT_INK_CEILING;
  const brailleCapacity = directCapacity * 8;
  const braillePossible = maxRankPopulation <= brailleCapacity;
  const encoding: UctHeaderMetrics["encoding"] = directPossible ? "direct" : braillePossible ? "braille" : "elided";
  let canvas: Cell[][];
  let renderedNodeCount = nodes.length;
  const nowMs = options.now_ms;
  const backtracks = Number.isFinite(nowMs) ? (input.backtracks ?? []).filter((event) => {
    const age = nowMs! - (event.playback_at_ms ?? event.occurred_at_ms);
    return age >= 0 && age < BACKTRACK_DISPLAY_MS && edges.some((edge) => edge.from === event.to && edge.to === event.from);
  }) : [];
  if (encoding === "direct") {
    const direct = renderDirect(nodes, edges, layoutRanks, innerWidth, graphHeight, rankBandWidth, rowSpacing);
    canvas = direct.canvas;
    const children = childrenByParent(edges);
    for (const event of backtracks) {
      const from = direct.positions.get(event.from);
      const to = direct.positions.get(event.to);
      if (!from || !to) continue;
      // Follow the same orthogonal spine as the drawn fan, not a diagonal
      // shortcut that would imply movement across unrelated alternatives.
      const route = (children.get(event.to)?.length ?? 0) > 1 && rankBandWidth >= 3
        ? [from, { x: to.x + 1, y: from.y }, { x: to.x + 1, y: to.y }, to]
        : [from, to];
      const lengths = route.slice(1).map((point, i) => Math.max(Math.abs(point.x - route[i]!.x), Math.abs(point.y - route[i]!.y)));
      const total = lengths.reduce((sum, length) => sum + length, 0);
      let distance = Math.floor(total * (nowMs! - (event.playback_at_ms ?? event.occurred_at_ms)) / BACKTRACK_DISPLAY_MS);
      for (let i = 0; i < lengths.length; i++) {
        const length = lengths[i]!;
        if (distance > length) { distance -= length; continue; }
        if (length === 0) continue;
        const start = route[i]!; const end = route[i + 1]!;
        const point = { x: Math.round(start.x + (end.x - start.x) * distance / length), y: Math.round(start.y + (end.y - start.y) * distance / length) };
        // Preserve authoritative node-state glyphs at both endpoints.
        put(canvas, point, end.x < start.x ? "‹" : end.y < start.y ? "↑" : "↓", "warning");
        break;
      }
    }
  } else {
    const braille = renderBraille(nodes, edges, layoutRanks, innerWidth, graphHeight, rankBandWidth);
    canvas = braille.canvas;
    renderedNodeCount = braille.rendered;
  }

  const graphRows = canvas.map((row) => canvasLine(row, color, theme, mode));
  // A sparse chain earns readable task/state labels in the otherwise empty
  // second row. Branching/dense fields keep all their rows for exact topology.
  // Labels describe snapshots only; no motion is inferred from node states.
  if (options.presentation === "hero" && encoding === "direct" && maxRankPopulation === 1 && graphHeight >= 2 && rankBandWidth >= 12) {
    const byRank = new Map(nodes.map((node) => [rankById.get(node.id) ?? 0, node]));
    const labels = Array.from({ length: rankCount }, (_, rank) => {
      const node = byRank.get(rank);
      const label = node ? `${node.state}: ${node.label}` : "";
      return decorate(pad(clipped(label, rankBandWidth - 2), rankBandWidth), node ? stateTone(node.state) : "muted", color, theme, mode);
    }).join("");
    graphRows[1] = pad(labels, innerWidth);
  }
  const visibleSignals = signals.slice(0, graphHeight * 2);
  const leftSignals = visibleSignals.filter((_, index) => index % 2 === 0);
  const rightSignals = visibleSignals.filter((_, index) => index % 2 === 1);
  const borderTitle = nodes.length === 0 ? " UCT · no tree " : options.presentation === "hero"
    ? ` UCT · ${nodes.length} nodes · ${backtracks.length > 0 ? `backtrack playback ${backtracks.length}` : "snapshot"}${(input.dropped_backtracks ?? 0) > 0 ? ` · ${input.dropped_backtracks} playback dropped` : ""} · ${encoding}${renderedNodeCount < nodes.length ? ` · ${nodes.length - renderedNodeCount} elided` : ""} `
    : ` UCT · ${nodes.length} nodes `;
  const lines: string[] = [];
  if (framed) {
    const top = graphWidth === 1
      ? "·"
      : `┌${clipped(borderTitle, Math.max(0, graphWidth - 2))}${"─".repeat(Math.max(0, graphWidth - 2 - displayWidth(clipped(borderTitle, Math.max(0, graphWidth - 2)))))}┐`;
    const bottom = graphWidth === 1 ? "·" : `└${"─".repeat(Math.max(0, graphWidth - 2))}┘`;
    for (let row = 0; row < height; row += 1) {
      const left = leftSignalWidth > 0 && row > 0 && row <= leftSignals.length
        ? decorate(pad(signalText(leftSignals[row - 1]!, leftSignalWidth), leftSignalWidth), leftSignals[row - 1]!.tone, color, theme, mode)
        : " ".repeat(leftSignalWidth);
      const right = rightSignalWidth > 0 && row > 0 && row <= rightSignals.length
        ? decorate(pad(signalText(rightSignals[row - 1]!, rightSignalWidth), rightSignalWidth), rightSignals[row - 1]!.tone, color, theme, mode)
        : " ".repeat(rightSignalWidth);
      const graph = row === 0
        ? top
        : row === height - 1
          ? bottom
          : graphWidth === 1
            ? graphRows[row - 1] ?? " "
            : `│${graphRows[row - 1] ?? ""}│`;
      const separator = leftSignalWidth > 0 ? "  " : "";
      lines.push(`${left}${separator}${graph}${separator}${right}`);
    }
  } else {
    // No own box: the embedding caller (the M2 shell band, ui-spec
    // §2.2/§5) already owns the ONE frame around this content and reads
    // `title` separately (see below), so every row here is graph
    // interior — nothing is spent on a second nested border.
    for (let row = 0; row < height; row += 1) {
      const left = leftSignalWidth > 0 && row < leftSignals.length
        ? decorate(pad(signalText(leftSignals[row]!, leftSignalWidth), leftSignalWidth), leftSignals[row]!.tone, color, theme, mode)
        : " ".repeat(leftSignalWidth);
      const right = rightSignalWidth > 0 && row < rightSignals.length
        ? decorate(pad(signalText(rightSignals[row]!, rightSignalWidth), rightSignalWidth), rightSignals[row]!.tone, color, theme, mode)
        : " ".repeat(rightSignalWidth);
      const graph = pad(graphRows[row] ?? "", graphWidth);
      const separator = leftSignalWidth > 0 ? "  " : "";
      lines.push(`${left}${separator}${graph}${separator}${right}`);
    }
  }
  return {
    lines,
    title: borderTitle.trim(),
    metrics: {
      node_count: nodes.length,
      edge_count: sourceEdges,
      plottable_edge_count: edges.length,
      unresolvable_edge_count: Math.max(0, sourceEdges - edges.length),
      rendered_node_count: renderedNodeCount,
      elided_node_count: Math.max(0, nodes.length - renderedNodeCount),
      fan_max: widestFan(edges),
      encoding,
      rank_band_width: rankBandWidth,
      row_spacing: rowSpacing,
      graph_width: graphWidth,
      graph_height: graphHeight,
      signal_columns: [leftSignalWidth, rightSignalWidth],
    },
  };
}
