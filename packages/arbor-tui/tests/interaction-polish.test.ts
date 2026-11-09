import { describe, expect, it } from "vitest";
import {
  aggregateBackgroundStatus, backgroundStatusLine, buildDefaultCatalog, contextMenuItems, initialModel,
  M7_THEME_TOKENS, preserveReadingAnchor, restoreReaderFocus, renderStatusBar, summarizeTurnBoundary, turnBoundaryLine,
} from "../src/index.js";

describe("M7 terse interaction policy", () => {
  it("folds background updates by identity while retaining urgent states", () => {
    const summary = aggregateBackgroundStatus([
      { id: "shell", label: "Shell", kind: "active" },
      { id: "approval", label: "Gate", kind: "approval" },
      { id: "shell", label: "Shell", kind: "success" },
      { id: "failure", label: "Worker", kind: "failure", detail: "failed" },
    ]);
    expect(summary.rows.map((row) => `${row.id}:${row.kind}`)).toEqual(["failure:failure", "approval:approval", "shell:success"]);
    expect(summary.urgent).toBe(true);
    expect(summary.counts.failure).toBe(1);
  });

  it("renders an urgent live Console background status in the real status row", () => {
    const app = initialModel();
    const console = { tasks: { items: [{ id: "task-42", state: "failed", reason: "gate" }] } };
    const live = { ...app, screens: new Map(app.screens).set("console", console) };
    expect(backgroundStatusLine(live)).toContain("failure");
    expect(renderStatusBar(live, { columns: 120 })).toContain("failure");
  });

  it("renders a bounded turn-boundary summary for a terminal live session", () => {
    const app = initialModel();
    const console = { session_attach: { session: { terminal: { cause: "failed", reason: "gate failed" } } } };
    const live = { ...app, screens: new Map(app.screens).set("console", console) };
    expect(turnBoundaryLine(live)).toContain("Outcome: failed");
    expect(renderStatusBar(live, { columns: 120 })).toContain("Outcome: failed");
  });

  it("keeps turn summaries bounded without hiding approvals or blockers", () => {
    const lines = summarizeTurnBoundary({ outcome: "blocked", changes: ["updated reader"], verification: ["12 tests pass"], evidence: ["capture-7"], approval_needed: "publish ADR", blocker: "gate is unresolved" });
    expect(lines).toEqual([
      "Outcome: blocked", "Changed: updated reader", "Verified: 12 tests pass", "Evidence: capture-7",
      "Approval needed: publish ADR", "Blocker: gate is unresolved",
    ]);
    expect(lines.length).toBeLessThanOrEqual(8);
  });

  it("preserves reading identity and exposes newer content instead of snapping", () => {
    const result = preserveReadingAnchor({ item_id: "b", offset: 14, selected: true }, ["a", "b", "c"], ["a", "b"]);
    expect(result.anchor).toEqual({ item_id: "b", offset: 14, selected: true });
    expect(result.newer_available).toBe(true);
  });

  it("restores the reader's pre-open focus and selection", () => {
    expect(restoreReaderFocus({ zone: "rail", rail_tab: "adrs", selection_id: "adr-7" }, { zone: "reader", rail_tab: "adrs", selection_id: "adr-8" })).toEqual({ zone: "rail", rail_tab: "adrs", selection_id: "adr-7" });
  });

  it("projects contextual actions from the same keyboard catalogue with authorization reasons", () => {
    const catalog = buildDefaultCatalog();
    const action = catalog.actions.find((candidate) => candidate.id === "focus:tree")!;
    const items = contextMenuItems(catalog, [action.id], { authorized: [] });
    expect(items[0]).toMatchObject({ action_id: action.id, enabled: false });
    expect(items[0]?.keys.length).toBeGreaterThan(0);
    expect(items[0]?.reason).toContain("authorization");
  });

  it("ships monochrome-safe semantic carriers", () => {
    expect(M7_THEME_TOKENS.failure.glyph).toBe("!");
    expect(M7_THEME_TOKENS.selection.glyph).toBe("›");
  });
});
