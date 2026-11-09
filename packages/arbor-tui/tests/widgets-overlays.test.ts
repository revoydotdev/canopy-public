import { describe, expect, it } from "vitest";
import { wrapDisplay } from "../src/widgets.js";
import { buildDefaultCatalog } from "../src/default-catalog.js";
import { workflowPaletteActions } from "../src/pilot-workflows.js";
import {
  boundedNotifications,
  clipDisplay,
  displayWidth,
  initialModel,
  paletteContextForModel,
  paletteDisclosure,
  paletteFooterHint,
  paletteView,
  renderPaletteRows,
  notificationDismissIntent,
  renderNotificationBand,
  windowedNotifications,
  renderStreamViewport,
  renderTable,
  renderTree,
  type InputCatalog,
} from "../src/index.js";

const catalog: InputCatalog = {
  actions: [
    { id: "confirm", title: "Confirm", description: "Apply the action", bindings: [{ scope: "modal", keys: ["enter"], description: "Confirm" }] },
    { id: "cancel", title: "Cancel", description: "Close the modal", bindings: [{ scope: "modal", keys: ["escape"], description: "Cancel" }] },
    { id: "refresh", title: "Refresh", description: "Reload data", bindings: [{ scope: "global", keys: ["r"], description: "Refresh" }] },
  ],
};

describe("scrolling past the end keeps a real page (EC-043)", () => {
  const rows = Array.from({ length: 188 }, (_, i) => ({ kind: `capability-${i + 1}` }));
  const columns = [{ key: "kind", title: "Kind", width: 20 }];

  it("clamps a far-past-the-end offset to the last full page instead of emptying the table", () => {
    // Paging to the bottom of Capabilities rendered a blank table captioned
    // "0-188 of 188": offset reached rows.length, so slice() returned nothing.
    const out = renderTable(rows, columns, { height: 42, offset: 10_000, line_width: 120 });
    const header = out[0]!;
    expect(header).toContain("188-188 of 188");
    // At least one real row stays on screen — never the blank table.
    expect(out[1]).toContain("capability-188");
  });

  it("still reports a normal window from the top", () => {
    expect(renderTable(rows, columns, { height: 42, offset: 0, line_width: 120 })[0]).toContain("1-41 of 188");
  });

  it("does not clamp when every row already fits", () => {
    const few = rows.slice(0, 5);
    expect(renderTable(few, columns, { height: 42, offset: 0, line_width: 120 })[0]).toContain("1-5 of 5");
  });
});

describe("renderTable truncation is visible and identifier-safe (EC-023)", () => {
  const ids = [{ id: "communication_3" }, { id: "communication_4" }];

  it("keeps two identifiers that share a long prefix distinguishable", () => {
    // The Audit screen rendered BOTH of these as "communicatio": same width,
    // same visible text, two different evidence records.
    const [, first, second] = renderTable(ids, [{ key: "id", title: "ID", width: 12, truncate: "middle" }], { height: 3 });
    expect(first).not.toEqual(second);
    expect(first).toContain("3");
    expect(second).toContain("4");
    expect(first).toContain("\u2026");
  });

  it("without middle truncation the same two identifiers collide, which is why the mode exists", () => {
    const [, first, second] = renderTable(ids, [{ key: "id", title: "ID", width: 12 }], { height: 3 });
    expect(first).toEqual(second);
  });

  it("never exceeds the declared column width when it adds the marker", () => {
    for (const width of [2, 3, 8, 12, 20]) {
      const [, row] = renderTable(ids, [{ key: "id", title: "ID", width, truncate: "middle" }], { height: 2 });
      expect(displayWidth(row)).toBe(width);
    }
  });
});

describe("bounded TUI widgets", () => {
  it("clips by terminal columns, including wide and combining characters", () => {
    expect(displayWidth("界a")).toBe(3);
    expect(displayWidth("e\u0301")).toBe(1);
    expect(clipDisplay("界ab", 3)).toBe("界a");
  });

  it("bounds table, tree, and stream output", () => {
    // A cut cell ends in an ellipsis: silent clipping made two different Audit
    // records both read "communicatio" (EC-023). "State"/"running" lose their
    // last character to the marker, which is the point -- the operator can see
    // the value is incomplete.
    expect(renderTable([{ name: "alpha", state: "running" }], [{ key: "name", title: "Name", width: 5 }, { key: "state", title: "State", width: 4 }], { height: 2 })).toEqual(["Name  Sta\u2026", "alpha run\u2026"]);
    expect(renderTree([{ id: "n", label: "child", depth: 1, has_children: true }], { width: 7, height: 1 })).toEqual(["└─▶ ch…"]);
    expect(renderStreamViewport("one\ntwo\nthree", { width: 5, height: 2 })).toEqual(["two", "three"]);
  });
});

describe("catalog-derived overlays", () => {
  it("derives palette and help entries from the input catalog", () => {
    expect(paletteView(catalog, { query: "reload" }).items.map((item) => item.action_id)).toEqual(["refresh"]);
    expect(renderPaletteRows(catalog, { width: 40, limit: 2, scope: "modal" })).toHaveLength(2);
  });

  it("marks exactly the selected palette row and exposes compact categories", () => {
    const rows = renderPaletteRows(catalog, { width: 100, limit: 3, selected_index: 1 }).map((row) => row.plain);
    expect(rows.filter((row) => row.startsWith("›"))).toHaveLength(1);
    expect(rows[1]).toMatch(/^›\[command\]/);
    expect(rows[0]).toMatch(/^ \[command\]/);
  });

  // T3 (TUI key-routing/palette sweep): typing a bound keystroke (e.g. the
  // digit a screen navigation action is actually bound to) must find that
  // action, not just an action whose title/description happens to contain
  // that literal substring. Before this fix, the palette view only searched
  // title/description/id — a catalog action bound to key "9" with no digit
  // in its title/description never matched a "9" query at all, so the
  // rendered filtered list and the "Enter runs first match" selection could
  // silently disagree with whatever the operator actually typed.
  it("matches a query against a bound keystroke, not just title/description/id text", () => {
    const navCatalog: InputCatalog = {
      actions: [
        { id: "focus:cockpit", title: "Cockpit", description: "Focus the cockpit screen", bindings: [{ scope: "global", keys: ["2"], description: "Cockpit" }] },
        { id: "focus:jobs", title: "Jobs", description: "Focus the jobs screen", bindings: [{ scope: "global", keys: ["9"], description: "Jobs" }] },
      ],
    };
    const items = paletteView(navCatalog, { query: "9" }).items;
    expect(items.map((item) => item.action_id)).toEqual(["focus:jobs"]);
  });

  // The render path (`renderPaletteRows`) and the Enter-runs-first-match path
  // (`paletteView(catalog, { query, limit: 1 }).items[0]`, mirrored from
  // `packages/arbor-mcp/src/tui.ts`) must resolve to the identical top row
  // for the same query — this is the single source of truth both paths share.
  it("keeps the rendered filtered top row and the first-match selection in agreement", () => {
    const navCatalog: InputCatalog = {
      actions: [
        { id: "focus:dashboard", title: "Dashboard", description: "Focus the dashboard screen", bindings: [{ scope: "global", keys: ["1"], description: "Dashboard" }] },
        { id: "focus:jobs", title: "Jobs", description: "Focus the jobs screen", bindings: [{ scope: "global", keys: ["9"], description: "Jobs" }] },
        { id: "focus:cockpit", title: "Cockpit", description: "Focus the cockpit screen", bindings: [{ scope: "global", keys: ["2"], description: "Cockpit" }] },
      ],
    };
    const rendered = paletteView(navCatalog, { query: "9", limit: 200 }).items;
    const selected = paletteView(navCatalog, { query: "9", limit: 1 }).items[0];
    expect(rendered[0]?.action_id).toBe("focus:jobs");
    expect(selected?.action_id).toBe(rendered[0]?.action_id);
  });

  it("bounds contextual discovery while preserving complete search and explicit expansion", () => {
    const many: InputCatalog = {
      actions: Array.from({ length: 18 }, (_, index) => ({
        id: index === 16 ? "cmd:approval.approve" : `focus:screen-${index}`,
        title: index === 16 ? "Approve Request" : `Screen ${String(index).padStart(2, "0")}`,
        description: index === 16 ? "Approve the selected pending request (approvals screen)" : `Focus screen ${index}`,
        bindings: [{ scope: "global" as const, keys: [`f${index}`], description: "route" }],
      })),
    };
    const initial = paletteView(many, { contextual: true, limit: 50, context: { screen: "screen-1", lifecycle: "attention" } });
    expect(initial.items).toHaveLength(12);
    expect(initial.complete_catalog_count).toBe(18);
    expect(paletteDisclosure(initial)).toContain("type to search or expand all");
    expect(paletteView(many, { contextual: true, expanded: true, limit: 50 }).items).toHaveLength(18);
    expect(paletteView(many, { contextual: true, query: "approve", limit: 50 }).items.map((item) => item.action_id)).toEqual(["cmd:approval.approve"]);
  });

  it("derives one truthful lifecycle context for render, movement, and execution", () => {
    const base = initialModel();
    const attention = {
      ...base,
      screen: "console" as const,
      screens: new Map(base.screens).set("console", {
        approvals: { records: [{ id: "approval-1", status: "pending" }] },
        sessions: { sessions: [{ id: "session-1", state: "running" }] },
      }),
    };
    expect(paletteContextForModel(attention)).toMatchObject({ screen: "console", has_selection: false, lifecycle: "attention" });
    const active = {
      ...attention,
      screens: new Map(base.screens).set("console", { sessions: { sessions: [{ id: "session-1", state: "running" }] } }),
    };
    expect(paletteContextForModel(active).lifecycle).toBe("active");
    expect(paletteContextForModel(active).disabled_reasons).toEqual({
      "focus:result-review": "no captured result is ready to review",
    });

    const withCapture = {
      ...active,
      screens: new Map(active.screens).set("console", {
        sessions: { sessions: [{ id: "session-1", state: "running" }] },
        result_review: { capture: { campaign_id: "c1", node_id: "n1", patch_sha256: "a".repeat(64), files: ["src/a.ts"], scope_violations: [] } },
      }),
    };
    expect(paletteContextForModel(withCapture).disabled_reasons).toBeUndefined();
  });

  it("renders selected palette rows truthfully in monochrome and color", () => {
    const context = { disabled_reasons: { refresh: "no active connection" } };
    const plain = renderPaletteRows(catalog, { width: 120, limit: 3, selected_index: 2, context });
    const styled = renderPaletteRows(catalog, { width: 120, limit: 3, selected_index: 2, context, color: true });
    expect(plain.filter((row) => row.selected)).toHaveLength(1);
    expect(plain[2]?.plain.startsWith("›")).toBe(true);
    expect(plain[2]?.plain).toContain("Runs the registered action");
    expect(plain.find((row) => row.action_id === "refresh")?.plain).toContain("Unavailable: no active connection");
    expect(paletteView(catalog, { context }).items.find((item) => item.action_id === "refresh")?.enabled).toBe(false);
    expect(paletteView(catalog).items.every((item) => item.enabled)).toBe(true);
    expect(styled[2]?.styled).toContain(String.fromCharCode(27));
    expect(renderPaletteRows(catalog, { width: 120, limit: 3, selected_index: 2, color: true })[2]?.styled).toContain(String.fromCharCode(27));
    expect(paletteFooterHint({ focus: "palette", pending_chord: ["g"], compact: true })).toContain("waiting for g");
  });

  it("keeps palette discovery legible at the 80x24 and 120x40 acceptance widths", () => {
    for (const width of [80, 120]) {
      const rows = renderPaletteRows(catalog, { width, limit: 3, selected_index: 1, contextual: true, context: { screen: "dashboard" } });
      expect(rows).toHaveLength(3);
      expect(rows[1]?.plain.startsWith("›")).toBe(true);
      expect(rows.every((row) => displayWidth(row.plain) <= width)).toBe(true);
      expect(paletteDisclosure(paletteView(catalog, { contextual: true, limit: 3 }), { compact: width === 80 })).toContain(width === 80 ? "search/all" : "Showing");
    }
  });

  it("bounds notification rendering", () => {
    expect(boundedNotifications([
      { id: "1", severity: "info", message: "first", createdAt: Date.parse("2026-01-01T00:00:00.000Z") },
      { id: "2", severity: "error", message: "second message", createdAt: Date.parse("2026-01-01T00:00:01.000Z") },
    // The cut is marked (EC-055a); a silent "seco" was the defect, not the contract.
    ], { limit: 1, width: 12 })).toEqual(["[error] sec…"]);
  });

  it("keeps notification rendering and click dismissal tied to the displayed window", () => {
    const notifications = [
      { id: "1", severity: "info" as const, message: "first", createdAt: 1 },
      { id: "2", severity: "error" as const, message: "second", createdAt: 2 },
    ];
    const windowed = windowedNotifications(notifications, { max_rows: 1, available_rows: 2 });
    expect(renderNotificationBand(windowed, { width: 20, color: true })[0]).toMatchObject({ id: "2", plain: "[error] second      " });
    expect(notificationDismissIntent({ pane_id: "notifications", row_in_pane: 0, column_in_pane: 0 }, windowed)).toEqual({ type: "dismiss_notification", id: "2" });
    expect(notificationDismissIntent({ pane_id: "notifications", row_in_pane: 1, column_in_pane: 0 }, windowed)).toBeNull();
    expect(notificationDismissIntent({ pane_id: "main", row_in_pane: 0, column_in_pane: 0 }, windowed)).toBeNull();
  });

  it("removes elapsed transient failures from the footer while retaining durable notices", () => {
    const windowed = windowedNotifications([
      { id: "provider-failure", severity: "error", message: "historical provider failure", createdAt: 10, expiresAt: 20 },
      { id: "operator-action", severity: "info", message: "campaign paused", createdAt: 21 },
    ], { max_rows: 3, available_rows: 3, now_ms: 30 });
    expect(windowed.map((notification) => notification.id)).toEqual(["operator-action"]);
  });
});

describe("wrapDisplay breaks an overlong token instead of clipping it (EC-055e)", () => {
  it("keeps every character of a path wider than the line", () => {
    const path = "/mnt/sda2/revoy2/pilot/sweep-20260903T1522/degraded-readonly/run-01/project/.arbor";
    const lines = wrapDisplay(`EACCES: permission denied, mkdir ${path}`, 30);
    expect(lines.every((line) => displayWidth(line) <= 30)).toBe(true);
    expect(lines.join("")).toContain(path.replace(/ /gu, ""));
  });
  it("still wraps ordinary prose at word boundaries", () => {
    expect(wrapDisplay("the quick brown fox", 10)).toEqual(["the quick", "brown fox"]);
  });
});

describe("notification band marks a cut message (EC-055a)", () => {
  it("ends a message wider than the band with an ellipsis", () => {
    const [line] = boundedNotifications([{ id: "n1", severity: "error", message: "Durable audit state failed its integrity check and was quarantined; records it held are no longer readable.", createdAt: 0 }], { limit: 1, width: 60 });
    expect(displayWidth(line!)).toBeLessThanOrEqual(60);
    expect(line!.endsWith("…")).toBe(true);
    expect(line).toContain("[error] Durable audit state");
  });
});

describe("palette suggested hoist (EC-003, positive half)", () => {
  const full = buildDefaultCatalog();
  it("marks actions with an authored contextual signal as suggested, and hoists them under a label", () => {
    // Idle Console: the screen's own actions and Help carry a signal; most of the catalogue does not.
    const context = { screen: "console" as const, lifecycle: "idle" as const, has_selection: false };
    const view = paletteView(full, { contextual: true, context, limit: 40 });
    const suggested = view.items.filter((item) => item.suggested).map((item) => item.action_id);
    expect(suggested).toContain("focus:console");
    expect(view.items.some((item) => !item.suggested)).toBe(true);
    // Suggested items come first, as one block.
    const firstOther = view.items.findIndex((item) => !item.suggested);
    expect(view.items.slice(0, firstOther).every((item) => item.suggested)).toBe(true);
    const rows = renderPaletteRows(full, { contextual: true, context, limit: 40, width: 80, selected_index: 0, compact_rows: true });
    expect(rows[0]).toMatchObject({ header: true, action_id: null, plain: "Suggested now" });
    expect(rows[1]?.selected).toBe(true);
    expect(rows.some((row) => row.header === true && row.plain.startsWith("Everything else"))).toBe(true);
  });
  it("adds no labels to a filtered or expanded view, nor when every contextual item is suggested", () => {
    const context = { screen: "console" as const, lifecycle: "idle" as const, has_selection: false };
    const attention = { screen: "console" as const, lifecycle: "attention" as const, has_selection: false };
    const busy = renderPaletteRows(full, { contextual: true, context: attention, limit: 40, width: 80 });
    if (paletteView(full, { contextual: true, context: attention, limit: 40 }).items.every((item) => item.suggested)) expect(busy.some((row) => row.header)).toBe(false);
    expect(renderPaletteRows(full, { contextual: true, context, query: "gov", width: 80 }).some((row) => row.header)).toBe(false);
    expect(renderPaletteRows(full, { contextual: true, context, expanded: true, width: 80 }).some((row) => row.header)).toBe(false);
  });
});

describe("palette suggests workflows by authored lifecycle phase", () => {
  // tui.ts composes the catalogue as builtins + workflows + project commands; mirror the first two.
  const full = { actions: [...buildDefaultCatalog().actions, ...workflowPaletteActions()] };
  it("a greenfield Console suggests project and plan workflows, not finish ones", () => {
    const context = { screen: "console" as const, lifecycle: "idle" as const, has_selection: false, empty_families: ["campaign", "session", "attention", "recovery", "result"] as const };
    const suggested = paletteView(full, { contextual: true, context, limit: 40 }).items.filter((item) => item.suggested).map((item) => item.action_id);
    expect(suggested).toContain("workflow:plan.new");
    expect(suggested.some((id) => id.startsWith("workflow:plan.") || id.startsWith("workflow:project."))).toBe(true);
    expect(suggested.some((id) => id.startsWith("workflow:finish."))).toBe(false);
  });
  it("an attention state suggests intervene workflows", () => {
    const context = { screen: "console" as const, lifecycle: "attention" as const, has_selection: false };
    const view = paletteView(full, { contextual: true, context, limit: 60 });
    const intervene = view.items.filter((item) => item.action_id.startsWith("workflow:intervene."));
    expect(intervene.length).toBeGreaterThan(0);
    expect(intervene.every((item) => item.suggested)).toBe(true);
  });
});
