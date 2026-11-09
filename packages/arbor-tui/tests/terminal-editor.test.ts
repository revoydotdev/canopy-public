import { describe, expect, it } from "vitest";
import { initialModel } from "../src/model.js";
import { applyVimKey, vimKeyIsOwned, vimModeLabel } from "../src/terminal-editor.js";
import { update } from "../src/update.js";

describe("Vim-style terminal editor", () => {
  it("keeps insert text with the existing route and enters normal mode on Escape", () => {
    expect(applyVimKey("draft", 5, undefined, "x")).toMatchObject({ handled: false, editor: { mode: "insert" } });
    expect(applyVimKey("draft", 5, undefined, "\u001b")).toMatchObject({ handled: true, editor: { mode: "normal" } });
    expect(vimKeyIsOwned(undefined, "\u001b")).toBe(false);
    expect(vimKeyIsOwned({ mode: "insert" }, "\u001b")).toBe(true);
    expect(vimKeyIsOwned({ mode: "normal" }, "j")).toBe(true);
    expect(vimKeyIsOwned({ mode: "insert" }, "j")).toBe(false);
  });

  it("supports keyboard-first normal movements, insert points, deletion, and dd", () => {
    const normal = { mode: "normal" } as const;
    expect(applyVimKey("one\ntwo", 5, normal, "k")).toMatchObject({ cursor: 1, editor: normal });
    expect(applyVimKey("one two", 0, normal, "w")).toMatchObject({ cursor: 3 });
    expect(applyVimKey("one", 0, normal, "A")).toMatchObject({ cursor: 3, editor: { mode: "insert" } });
    expect(applyVimKey("one", 1, normal, "x")).toMatchObject({ text: "oe", cursor: 1 });
    const prefix = applyVimKey("one\ntwo\nthree", 5, normal, "d");
    expect(prefix).toMatchObject({ editor: { mode: "normal", pending_delete: true } });
    expect(applyVimKey(prefix.text, prefix.cursor, prefix.editor, "d")).toMatchObject({ text: "one\nthree", cursor: 4, editor: { mode: "normal" } });
  });

  it("makes o/O multiline-only, preserving single-line command fields", () => {
    expect(applyVimKey("line", 1, { mode: "normal" }, "o")).toMatchObject({ text: "line\n", cursor: 5, editor: { mode: "insert" } });
    expect(applyVimKey("line", 1, { mode: "normal" }, "o", false)).toMatchObject({ text: "line", cursor: 1, editor: { mode: "normal" } });
  });

  it("covers every normal-mode insertion point and movement without leaking a key", () => {
    const normal = { mode: "normal" } as const;
    const text = "one two\nxyz";
    const cases = [
      ["i", 5, 5, "insert"],
      ["a", 5, 6, "insert"],
      ["I", 5, 0, "insert"],
      ["A", 2, 7, "insert"],
      ["h", 5, 4, "normal"],
      ["l", 5, 6, "normal"],
      ["0", 9, 8, "normal"],
      ["$", 9, 11, "normal"],
      ["w", 0, 3, "normal"],
      ["b", 7, 4, "normal"],
      ["j", 2, 10, "normal"],
      ["k", 10, 2, "normal"],
    ] as const;
    for (const [key, cursor, expected, mode] of cases) {
      expect(applyVimKey(text, cursor, normal, key)).toMatchObject({ text, cursor: expected, handled: true, editor: { mode } });
    }
  });

  it("opens a line above at the exact current-line start and blocks O for single-line fields", () => {
    const normal = { mode: "normal" } as const;
    expect(applyVimKey("one\ntwo", 6, normal, "O")).toMatchObject({ text: "one\n\ntwo", cursor: 4, editor: { mode: "insert" }, handled: true });
    expect(applyVimKey("one", 1, normal, "O", false)).toEqual({ text: "one", cursor: 1, editor: normal, handled: true });
  });

  it("deletes first, middle, and final lines and clamps malformed cursors", () => {
    const pending = { mode: "normal", pending_delete: true } as const;
    expect(applyVimKey("one\ntwo\nthree", 1, pending, "d")).toMatchObject({ text: "two\nthree", cursor: 0 });
    expect(applyVimKey("one\ntwo\nthree", 5, pending, "d")).toMatchObject({ text: "one\nthree", cursor: 4 });
    expect(applyVimKey("one\ntwo\nthree", 99, pending, "d")).toMatchObject({ text: "one\ntwo\n", cursor: 8 });
    expect(applyVimKey("one", -5, pending, "d")).toMatchObject({ text: "", cursor: 0 });
  });

  it("consumes an invalid delete suffix and unknown normal keys without changing text", () => {
    const pending = { mode: "normal", pending_delete: true } as const;
    expect(applyVimKey("draft", 3, pending, "x")).toEqual({ text: "draft", cursor: 3, editor: { mode: "normal" }, handled: true });
    expect(applyVimKey("draft", 3, { mode: "normal" }, "q")).toEqual({ text: "draft", cursor: 3, editor: { mode: "normal" }, handled: true });
    expect(applyVimKey("", 0, { mode: "normal" }, "x")).toMatchObject({ text: "", cursor: 0, handled: true });
  });

  it("renders stable mode labels including the pending delete prefix", () => {
    expect(vimModeLabel(undefined)).toBe("INSERT");
    expect(vimModeLabel({ mode: "insert" })).toBe("INSERT");
    expect(vimModeLabel({ mode: "normal" })).toBe("NORMAL");
    expect(vimModeLabel({ mode: "normal", pending_delete: true })).toBe("NORMAL d");
  });
});

describe("editor reducer seams", () => {
  const question = { id: "q", status: "awaiting", question: { question: "Explain the change" } };
  const armed = () => {
    const focused = update(initialModel(), { type: "screen_changed", screen: "interviews" }).model;
    const queried = update(focused, { type: "query_results", queryId: "interviews", screen: "interviews", value: { records: [question] } }).model;
    return update(queried, { type: "ui_intent", intent: { type: "arm_answer" }, at: 1 }).model;
  };

  it("toggles Vim mode and applies normal commands only to the compose buffer", () => {
    const text = update(armed(), { type: "ui_intent", intent: { type: "compose_insert", text: "one\ntwo" }, at: 2 }).model;
    const normal = update(text, { type: "ui_intent", intent: { type: "toggle_vim_mode" }, at: 3 }).model;
    const up = update(normal, { type: "ui_intent", intent: { type: "vim_key", key: "k" }, at: 4 }).model;
    expect(up.overlay).toMatchObject({ kind: "compose", cursor: 3, editor: { mode: "normal" } });
  });

  it("requests an external editor through a correlated, text-only effect and accepts only its own result", () => {
    const started = update(armed(), { type: "ui_intent", intent: { type: "open_external_editor" }, at: 10 });
    expect(started.effects).toEqual([{ type: "open_external_editor", request_id: "tui:external-editor:10", title: "Explain the change", text: "", language: "markdown", max_chars: 8192 }]);
    expect(started.model.overlay).toMatchObject({ external_editor_request_id: "tui:external-editor:10" });
    const stale = update(started.model, { type: "external_editor_result", request_id: "other", text: "wrong", at: 11 });
    expect(stale.model).toBe(started.model);
    const returned = update(started.model, { type: "external_editor_result", request_id: "tui:external-editor:10", text: "edited\ntext", at: 12 });
    expect(returned.model.overlay).toMatchObject({ kind: "compose", buffer: "edited\ntext", cursor: 11 });
    expect(returned.model.overlay).not.toHaveProperty("external_editor_request_id");
  });
});
