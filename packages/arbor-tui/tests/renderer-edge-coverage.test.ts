import { describe, expect, it } from "vitest";
import {
  StdoutRenderer,
  createNavigation,
  initialModel,
  renderScene,
  type AppModel,
  type InputCatalog,
  type RenderProjection,
} from "../src/index.js";
import { paintScene } from "../src/renderer.js";
import { textOnlyFrame } from "./support/render-harness.js";

function projection(app: AppModel, columns = 80, rows = 24, output = "fallback output"): RenderProjection {
  return {
    app,
    output,
    navigation: createNavigation({
      id: "renderer-edge", route: "/renderer-edge", split: "horizontal", ratio: 0.5,
      panes: [{ id: "primary", title: "Primary" }],
    }, { columns, rows }),
  };
}

const catalog: InputCatalog = { actions: [{
  id: "job.retry",
  title: "Retry selected job",
  description: "Retry the selected failed job",
  source: "command",
  discovery: { authority: "operator", effect: "dispatches job.retry" },
  bindings: [{ keys: ["r"], scope: "screen", description: "retry" }],
}] };

describe("renderer structured edge contracts", () => {
  it("reports console chronology and responsive composer metadata at every height tier", () => {
    const base = initialModel();
    const withoutInput = { ...base, screen: "console" as const, screens: new Map([["console" as const, {}]]) };
    expect(renderScene(projection(withoutInput)).panes[0]).toMatchObject({
      content_alignment: "top", chronology: { placement: "top", sticky_bottom: false },
    });
    expect(renderScene(projection(withoutInput)).panes[0]?.composer).toBeUndefined();

    for (const [rows, maxVisibleRows] of [[40, 6], [28, 4], [18, 2], [8, 1]] as const) {
      const app = {
        ...base,
        screen: "console" as const,
        screens: new Map([["console" as const, { console_input: {
          text: "queue this", cursor: 99, focused: true, action: "queue", interrupt_available: true,
        } }]]),
      };
      expect(renderScene(projection(app, 100, rows)).panes[0]?.composer).toEqual({
        kind: "console", focused: true, cursor: 10, text: "queue this", action: "queue",
        interrupt_available: true, max_visible_rows: maxVisibleRows,
      });
    }

    const malformed = {
      ...base,
      screen: "console" as const,
      screens: new Map([["console" as const, { console_input: { text: 4, cursor: -5, action: "other" } }]]),
    };
    expect(renderScene(projection(malformed)).panes[0]?.composer).toMatchObject({ text: "", cursor: 0, focused: false, action: "send", interrupt_available: false });
  });

  it("renders unavailable, empty-result, filtered, selected, compact, and expanded help states", () => {
    const help = { ...initialModel(), screen: "jobs" as const, overlay: { kind: "help" as const, query: "", selected_index: 9, expanded: false } };
    expect(paintScene(renderScene(projection(help, 80, 12)))).toContain("Help catalog unavailable");

    const empty = paintScene(renderScene({ ...projection(help, 80, 12), help_catalog: { actions: [] } }));
    expect(empty).toContain("No matching commands");
    expect(empty).toContain("Esc close");

    const selected = paintScene(renderScene({ ...projection(help, 120, 18), help_catalog: catalog, palette_pending_chord: ["g"] }));
    expect(selected).toContain("Retry selected job");
    expect(selected).toContain("operator");

    const filtered = { ...help, overlay: { kind: "help" as const, query: "missing", selected_index: 0, expanded: true } };
    const filteredText = paintScene(renderScene({ ...projection(filtered, 60, 10), help_catalog: catalog }));
    expect(filteredText).toContain("filter: missing_");
    expect(filteredText).toContain("No matching commands");
    expect(filteredText).toContain("Tab contextual");
  });

  it("renders confirmation and both task/non-task form treatments including detail and errors", () => {
    const confirm = { ...initialModel(), overlay: { kind: "confirm" as const, title: "Delete node", detail: "This cannot be undone", pendingAction: { kind: "tree.prune" as const, params: {} } } };
    expect(paintScene(renderScene(projection(confirm)))).toContain("Enter to confirm");

    const ordinary = { ...initialModel(), overlay: {
      kind: "operator_form" as const, command: "job.submit" as const, title: "Submit job", detail: "Operator-selected queue",
      fields: { job_kind: "test", owner_scope_id: "campaign-1" }, active_field: "owner_scope_id", field_cursor: 10, error: "queue paused",
    } };
    const ordinaryText = paintScene(renderScene(projection(ordinary)));
    expect(ordinaryText).toContain("Question: Operator-selected queue");
    expect(ordinaryText).toContain("! queue paused");
    expect(ordinaryText).toContain("Tab field");

    const task = { ...initialModel(), overlay: {
      kind: "operator_form" as const, command: "taskcomposer.submit" as const, title: "What should Revoy change?",
      fields: { task: "Add recovery coverage" }, active_field: "task", field_cursor: 21, error: null,
    } };
    const taskText = paintScene(renderScene(projection(task)));
    expect(taskText).toContain("REVOY2  /  NATIVE COCKPIT");
    expect(taskText).toContain("Enter start task");
  });

  it("keeps multiline compose position visible with editor, Vim, error, and narrow clipping", () => {
    const app = { ...initialModel(), overlay: {
      kind: "compose" as const, record_id: "question-1", question: "Explain",
      options: [{ id: "yes", text: "Proceed", is_other: false }],
      buffer: "\nabcdef", cursor: 2, error: "choose an option", external_editor_request_id: "editor-1",
      editor: { mode: "normal" as const },
    } };
    const wide = paintScene(renderScene(projection(app, 80, 10)));
    expect(wide).toContain("editor open");
    expect(wide).toContain("choose an option");
    const plain = paintScene(renderScene(projection(app, 18, 10)));
    expect(plain).toContain("Options:");
    expect(plain).toContain("NORMAL");
    expect(plain.split("\n").every((row) => row.length <= 18)).toBe(true);
    const colored = paintScene(renderScene(projection(app, 18, 10), { color: true }), { color: true });
    expect(colored).toContain("\u001b[7m");
  });

  it("handles empty workspace geometry and tiny zero-row terminals explicitly", () => {
    const normal = projection(initialModel(), 8, 3);
    const emptyNavigation = { ...normal.navigation, workspaces: [] };
    const scene = renderScene({ ...normal, navigation: emptyNavigation });
    expect(scene.rows.join("\n")).toContain("No work");
    expect(scene.panes).toEqual([]);
    const zeroBase = projection(initialModel(), 1, 1);
    const zeroNavigation = { ...zeroBase.navigation, terminal: { columns: 0, rows: 0 } };
    const zero = renderScene({ ...zeroBase, navigation: zeroNavigation });
    expect(zero).toMatchObject({ columns: 0, rows: [], status_row: null });
    expect(zero.panes).toEqual([expect.objectContaining({ id: "primary", columns: 0, rows: 0, paint_rows: 0, content: [] })]);
  });

  it("keeps stdout terminal ownership and row diffing idempotent without clear-screen escape pollution", () => {
    const writes: string[] = [];
    const renderer = new StdoutRenderer({ write: (value) => { writes.push(value); } }, { clear_screen: false, synchronized_output: true });
    renderer.enter();
    renderer.enter();
    renderer.render(textOnlyFrame("alpha\nbeta"));
    const afterFirst = writes.length;
    renderer.render(textOnlyFrame("alpha\nbeta"));
    expect(writes).toHaveLength(afterFirst);
    // "alpha" has one fewer row than "alpha\nbeta" -- a real SceneFrame's row
    // count only changes on an actual terminal resize (renderScene always
    // emits exactly `terminal.rows` lines), so this is a resize signal, not
    // an ordinary content diff: StdoutRenderer full-repaints rather than
    // selectively erasing the row that "disappeared" (see
    // stdout-renderer-resize-repaint.test.ts for the defect this closes).
    renderer.render(textOnlyFrame("alpha"));
    expect(writes.at(-1)).toContain("\u001b[?2026h");
    expect(writes.at(-1)).toContain("alpha");
    expect(writes.at(-1)).not.toContain("\u001b[2;1H\u001b[K");
    renderer.restore();
    renderer.restore();
    expect(writes.join("")).not.toContain("\u001b[?1049h");
    expect(writes.join("")).not.toContain("\u001b[?1049l");
  });
});

describe("palette detail line at narrow widths (EC-052)", () => {
  it("marks a cut Selected line instead of clipping it silently", () => {
    const help = { ...initialModel(), screen: "jobs" as const, overlay: { kind: "help" as const, query: "", selected_index: 0, expanded: true } };
    const long = { actions: [{ ...catalog.actions[0]!, description: "Review campaigns; they appear after approved plan submission and stay until archived by the operator" }] };
    const text = paintScene(renderScene({ ...projection(help, 80, 14), help_catalog: long }));
    const line = text.split("\n").find((row) => row.includes("Selected · "));
    expect(line).toBeDefined();
    expect(line).toContain("…");
    expect(line).not.toMatch(/submi\s*$/u);
    const wide = paintScene(renderScene({ ...projection(help, 200, 14), help_catalog: long })).split("\n").find((row) => row.includes("Selected · "));
    expect(wide).toContain("archived by the operator");
    expect(wide).not.toContain("…");
  });
});
