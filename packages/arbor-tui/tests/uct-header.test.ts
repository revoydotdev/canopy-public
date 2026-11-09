import { describe, expect, it } from "vitest";
import { projectUctHeader, recentUctBacktracks } from "../src/uct-header.js";
import { displayWidth } from "../src/widgets.js";
import { stripAnsi } from "../src/player-piano.js";

const tree = {
  nodes: [
    { id: "root", label: "Plan", parent_id: null, state: "claimed", visit_count: 2 },
    { id: "design", label: "Design", parent_id: "root", state: "verified", visit_count: 1 },
    { id: "wire", label: "Wire", parent_id: "root", state: "expanding", visit_count: 1 },
    { id: "review", label: "Review", parent_id: "wire", state: "awaiting_review", visit_count: 1 },
    { id: "failed", label: "Failed", parent_id: "wire", state: "failed", visit_count: 1 },
  ],
} as const;

function plain(lines: readonly string[]): readonly string[] {
  return lines.map(stripAnsi);
}

describe("UCT header", () => {
  it("animates only recent exact reverse edges and expires without replay", () => {
    const at = Date.parse("2026-09-05T12:00:00Z");
    const line = { campaign_id: "current", synthetic: false, event_kind: "loop.backtracked", ts: new Date(at).toISOString(), loop_event: { node_id: "child", parent_id: "root" } };
    const backtracks = recentUctBacktracks({ lines: [line, line, { ...line, synthetic: true }, { ...line, campaign_id: "unrelated" }, { ...line, campaign_id: null }] }, at + 300, "current");
    expect(backtracks).toHaveLength(1);
    expect(recentUctBacktracks({ lines: [line] }, at + 300)).toEqual([]);
    const input = { nodes: [{ id: "root", state: "claimed" }, { id: "child", parent_id: "root", state: "failed" }], backtracks };
    const early = projectUctHeader(input, { width: 80, height: 4, presentation: "hero", now_ms: at + 300 });
    const later = projectUctHeader(input, { width: 80, height: 4, presentation: "hero", now_ms: at + 900 });
    expect(early.lines[1]).toContain("‹");
    expect(later.lines[1]!.indexOf("‹")).toBeLessThan(early.lines[1]!.indexOf("‹"));
    expect(early.lines[1]).toContain("×");
    expect(projectUctHeader(input, { width: 80, height: 4, now_ms: at + 1_500 }).lines.join("")).not.toContain("‹");
    expect(recentUctBacktracks({ lines: [line] }, at - 1, "current")).toEqual([]);
    expect(recentUctBacktracks({ lines: [line] }, at + 1_500, "current")).toEqual([]);
    expect(projectUctHeader({ ...input, edges: [] }, { width: 80, height: 4, now_ms: at + 300 }).lines.join("")).not.toContain("‹");
  });
  it("actually plots every counted dot when depth exceeds terminal columns", () => {
    const nodes = Array.from({ length: 100 }, (_, i) => ({ id: `deep${i}`, parent_id: i === 0 ? null : `deep${i - 1}`, state: "pending" }));
    const result = projectUctHeader({ nodes }, { width: 40, height: 4, presentation: "hero" });
    let dots = 0;
    for (const glyph of result.lines.join("")) {
      const code = glyph.codePointAt(0)!;
      if (code >= 0x2800 && code <= 0x28ff) dots += (code - 0x2800).toString(2).replace(/0/g, "").length;
    }
    expect(result.metrics.encoding).toBe("braille");
    expect(dots).toBe(100);
    expect(dots).toBe(result.metrics.rendered_node_count);
    for (const line of result.lines) expect(displayWidth(line)).toBeLessThanOrEqual(40);
  });
  it("uses the hero width for sparse named states and contracts as ranks increase", () => {
    const chain = (count: number) => ({ nodes: Array.from({ length: count }, (_, i) => ({
      id: `n${i}`, parent_id: i === 0 ? null : `n${i - 1}`, state: i === 0 ? "claimed" : "pending", label: `Task ${i}`,
    })) });
    const sparse = projectUctHeader(chain(2), { width: 100, height: 4, presentation: "hero" });
    const dense = projectUctHeader(chain(12), { width: 100, height: 4, presentation: "hero" });
    expect(sparse.metrics.rank_band_width).toBe(49);
    expect(dense.metrics.rank_band_width).toBeLessThan(sparse.metrics.rank_band_width);
    expect(sparse.lines.join("\n")).toContain("claimed: Task 0");
    expect(sparse.lines.join("\n")).toContain("pending: Task 1");
    expect(sparse.lines.join("\n")).toContain("snapshot");
    expect(sparse.metrics).toMatchObject({ node_count: 2, plottable_edge_count: 1, rendered_node_count: 2 });
    for (const line of [...sparse.lines, ...dense.lines]) expect(displayWidth(stripAnsi(line))).toBeLessThanOrEqual(100);
  });
  it("projects the exact canonical parent_id graph without inventing nodes or edges", () => {
    const projection = projectUctHeader(tree, { width: 80, height: 8 });

    expect(projection.metrics).toMatchObject({
      node_count: 5,
      edge_count: 4,
      plottable_edge_count: 4,
      unresolvable_edge_count: 0,
      rendered_node_count: 5,
      elided_node_count: 0,
      encoding: "direct",
    });
    const output = plain(projection.lines).join("\n");
    // Claimed / verified / expanding / review / failed are all the actual
    // source states, not a generic "busy" decoration.
    for (const glyph of ["◉", "●", "◆", "×"]) expect(output).toContain(glyph);
    expect(output).toMatch(/[─╲╱│]/u);
  });

  it("uses an explicit edge list as the complete relationship source", () => {
    const projection = projectUctHeader({ ...tree, edges: [{ from: "root", to: "design" }] }, { width: 80, height: 8 });
    expect(projection.metrics.edge_count).toBe(1);
    expect(projection.metrics.plottable_edge_count).toBe(1);

    const noEdges = projectUctHeader({ ...tree, edges: [] }, { width: 80, height: 8 });
    expect(noEdges.metrics.edge_count).toBe(0);
    expect(noEdges.metrics.plottable_edge_count).toBe(0);
  });

  it("reports unresolved supplied endpoints instead of reconnecting them by depth or order", () => {
    const projection = projectUctHeader({
      ...tree,
      edges: [{ from: "missing", to: "design" }, { from: "root", to: "design" }],
    }, { width: 80, height: 8 });
    expect(projection.metrics.edge_count).toBe(2);
    expect(projection.metrics.plottable_edge_count).toBe(1);
    expect(projection.metrics.unresolvable_edge_count).toBe(1);
  });

  it("expands at natural scale, then deterministically shrinks rank and row spacing at the boundary", () => {
    const deep = {
      nodes: Array.from({ length: 11 }, (_, index) => ({
        id: `n${index}`,
        parent_id: index === 0 ? null : `n${index - 1}`,
        state: "pending" as const,
      })),
    };
    const wide = projectUctHeader(deep, { width: 80, height: 8 });
    const narrow = projectUctHeader(deep, { width: 18, height: 8 });
    expect(wide.metrics.rank_band_width).toBe(4);
    expect(narrow.metrics.rank_band_width).toBe(1);
    expect(narrow.metrics.rendered_node_count).toBe(11);

    const fanout = {
      nodes: Array.from({ length: 7 }, (_, index) => ({ id: `fan-${index}`, parent_id: null, state: "pending" as const })),
    };
    expect(projectUctHeader(fanout, { width: 80, height: 12 }).metrics.row_spacing).toBe(2);
    expect(projectUctHeader(fanout, { width: 80, height: 5 }).metrics.row_spacing).toBe(1);
  });

  it("uses Braille topology compression before it truthfully elides physical overflow", () => {
    const braille = projectUctHeader({
      nodes: Array.from({ length: 40 }, (_, index) => ({ id: `n${index}`, parent_id: null, state: "pending" as const })),
    }, { width: 60, height: 4 });
    expect(braille.metrics).toMatchObject({ encoding: "braille", rendered_node_count: 40, elided_node_count: 0 });
    expect(plain(braille.lines).join("")).toMatch(/[\u2801-\u28ff]/u);

    const overflow = projectUctHeader({
      nodes: Array.from({ length: 70 }, (_, index) => ({ id: `n${index}`, parent_id: null, state: "pending" as const })),
    }, { width: 60, height: 4 });
    expect(overflow.metrics).toMatchObject({ encoding: "elided", rendered_node_count: 64, elided_node_count: 6 });
  });

  it("keeps a 20k-node chain stack-safe and physically bounded via LOD", () => {
    const nodes = Array.from({ length: 20_000 }, (_, index) => ({
      id: `node-${index}`,
      parent_id: index === 0 ? null : `node-${index - 1}`,
      state: "pending" as const,
    }));
    const projection = projectUctHeader({ nodes }, { width: 80, height: 8, presentation: "hero" });
    expect(projection.metrics).toMatchObject({
      node_count: 20_000,
      encoding: "elided",
      rendered_node_count: 3_744,
      elided_node_count: 16_256,
    });
    expect(projection.lines).toHaveLength(8);
    for (const line of plain(projection.lines)) expect(displayWidth(line)).toBeLessThanOrEqual(80);
  });

  it("flanks the bounded graph with only supplied governance facts and honors color/no-color", () => {
    const projection = projectUctHeader({
      ...tree,
      governance: [
        { id: "admission", label: "ADMIT", value: "pass", tone: "success" as const },
        { id: "evidence", label: "EVID", value: "pending", tone: "warning" as const },
      ],
    }, { width: 100, height: 8, color: true });
    expect(projection.metrics.signal_columns).toEqual([18, 18]);
    expect(projection.lines.join("")).toContain("\u001b[");
    const output = plain(projection.lines).join("\n");
    expect(output).toContain("ADMIT pass");
    expect(output).toContain("EVID pending");

    const uncolored = projectUctHeader(tree, { width: 80, height: 8, color: false }).lines;
    expect(uncolored.join("")).not.toContain("\u001b[");
  });

  it("never exceeds its allotted terminal rectangle", () => {
    const lines = projectUctHeader(tree, { width: 48, height: 6 }).lines;
    expect(lines).toHaveLength(6);
    for (const line of plain(lines)) expect(displayWidth(line)).toBeLessThanOrEqual(48);
  });

  // Regression for the double-framed UCT band: an embedding caller (the M2
  // shell band, ui-spec §2.2/§5) already draws the ONE frame around its
  // header; `framed: false` must hand the graph the FULL interior instead
  // of spending two more rows/columns on a second nested box, and must
  // still surface the border title/metrics text via `title` so the
  // embedding caller can place it in its own frame.
  it("hands the full rectangle to the graph and reports its title separately when framed: false", () => {
    const framed = projectUctHeader({ ...tree }, { width: 80, height: 8, presentation: "hero" });
    const unframed = projectUctHeader({ ...tree }, { width: 80, height: 8, presentation: "hero", framed: false });

    // The framed projection still draws its own box (back-compat) — no
    // regression to the Console screen's standalone frontier header.
    expect(framed.lines[0]).toMatch(/^┌/);
    expect(framed.lines[0]).toContain("UCT · 5 nodes");

    // The unframed projection draws no box at all: every requested row is
    // graph interior, never wrapped in the │ left/right border columns the
    // framed rendering adds (interior fan spines legitimately draw box
    // glyphs like ─/│/┬/└ as part of the graph itself, so the box is
    // distinguished by structure — no wrapping columns — not by glyph).
    expect(unframed.lines).toHaveLength(8);
    for (const line of plain(unframed.lines)) {
      expect(line.startsWith("│")).toBe(false);
      expect(line.endsWith("│")).toBe(false);
    }
    // At 8 rows, the framed rendering only had 6 interior rows to draw the
    // graph into (8 - 2 for its own top/bottom border); unframed gets all
    // 8 — exactly the two rows the double frame was losing.
    expect(unframed.metrics.graph_height).toBe(8);
    expect(framed.metrics.graph_height).toBe(6);

    // The would-be border title/metrics text is still available for the
    // embedding caller to place in the band's own frame.
    expect(unframed.title).toContain("UCT · 5 nodes");
    expect(unframed.title).not.toMatch(/[┌┐└┘│─]/);
  });

  it("gives a compressed 2-row band its full interior with framed: false (previously 0 rows)", () => {
    const unframed = projectUctHeader({ ...tree }, { width: 30, height: 2, framed: false });
    expect(unframed.lines).toHaveLength(2);
    expect(unframed.metrics.graph_height).toBe(2);
    for (const line of plain(unframed.lines)) expect(displayWidth(line)).toBeLessThanOrEqual(30);
  });
});
