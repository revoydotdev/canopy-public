/**
 * Small, deterministic Vim-style editor state for TUI text overlays.
 *
 * This deliberately owns only text editing. Starting a real external editor
 * needs a process/filesystem authority, which belongs to the composition
 * root; `types.ts` exposes a typed effect/event seam for that boundary.
 */
import {
  deleteForward,
  insertText,
  moveCursor,
  type CursorMovement,
} from "./text-buffer.js";

export type EditorMode = "insert" | "normal";

export interface VimEditorState {
  readonly mode: EditorMode;
  /** First `d` of the supported `dd` delete-line command. */
  readonly pending_delete?: boolean;
}

export interface VimEditResult {
  readonly text: string;
  readonly cursor: number;
  readonly editor: VimEditorState;
  /** False lets the caller use its ordinary insert-mode text route. */
  readonly handled: boolean;
}

const insert = (text: string, cursor: number, value: string, editor: VimEditorState): VimEditResult => {
  const next = insertText({ text, cursor }, value);
  return { ...next, editor, handled: true };
};

const move = (text: string, cursor: number, movement: CursorMovement, editor: VimEditorState): VimEditResult => {
  const next = moveCursor({ text, cursor }, movement);
  return { ...next, editor, handled: true };
};

function deleteLine(text: string, cursor: number): { text: string; cursor: number } {
  const bounded = Math.min(Math.max(0, cursor), text.length);
  const start = text.lastIndexOf("\n", Math.max(0, bounded - 1)) + 1;
  const newline = text.indexOf("\n", bounded);
  const end = newline < 0 ? text.length : newline + 1;
  return { text: text.slice(0, start) + text.slice(end), cursor: Math.min(start, text.length - (end - start)) };
}

/**
 * Apply one key according to a deliberately compact, discoverable Vim subset:
 * `Esc`, `i/a/I/A/o/O`, `h/j/k/l`, `0/$`, `w/b`, `x`, and `dd`.
 *
 * Insert-mode printable text is intentionally unhandled: the existing input
 * route retains ownership of paste normalization and character insertion.
 */
export function applyVimKey(
  text: string,
  cursor: number,
  editor: VimEditorState | undefined,
  key: string,
  multiline = true,
): VimEditResult {
  const current: VimEditorState = editor ?? { mode: "insert" };
  const clear = { mode: current.mode } as VimEditorState;
  if (key === "\u001b") return { text, cursor, editor: { mode: "normal" }, handled: true };
  if (current.mode === "insert") return { text, cursor, editor: current, handled: false };

  if (current.pending_delete) {
    if (key === "d") {
      const next = deleteLine(text, cursor);
      return { ...next, editor: { mode: "normal" }, handled: true };
    }
    // `d` is only a prefix here. A second unrelated key is deliberately
    // consumed rather than leaking into global navigation mid-edit.
    return { text, cursor, editor: { mode: "normal" }, handled: true };
  }

  switch (key) {
    case "i": return { text, cursor, editor: { mode: "insert" }, handled: true };
    case "a": {
      const next = moveCursor({ text, cursor }, "right");
      return { ...next, editor: { mode: "insert" }, handled: true };
    }
    case "I": {
      const next = moveCursor({ text, cursor }, "home");
      return { ...next, editor: { mode: "insert" }, handled: true };
    }
    case "A": {
      const next = moveCursor({ text, cursor }, "end");
      return { ...next, editor: { mode: "insert" }, handled: true };
    }
    case "o": {
      if (!multiline) return { text, cursor, editor: { mode: "normal" }, handled: true };
      const atEnd = moveCursor({ text, cursor }, "end");
      return insert(atEnd.text, atEnd.cursor, "\n", { mode: "insert" });
    }
    case "O": {
      if (!multiline) return { text, cursor, editor: { mode: "normal" }, handled: true };
      const atStart = moveCursor({ text, cursor }, "home");
      const next = insertText(atStart, "\n");
      return { text: next.text, cursor: atStart.cursor, editor: { mode: "insert" }, handled: true };
    }
    case "h": return move(text, cursor, "left", clear);
    case "j": return move(text, cursor, "down", clear);
    case "k": return move(text, cursor, "up", clear);
    case "l": return move(text, cursor, "right", clear);
    case "0": return move(text, cursor, "home", clear);
    case "$": return move(text, cursor, "end", clear);
    case "w": return move(text, cursor, "word_right", clear);
    case "b": return move(text, cursor, "word_left", clear);
    case "x": {
      const next = deleteForward({ text, cursor });
      return { ...next, editor: clear, handled: true };
    }
    case "d": return { text, cursor, editor: { mode: "normal", pending_delete: true }, handled: true };
    default: return { text, cursor, editor: clear, handled: true };
  }
}

/** Returns the reducer intent only when Vim owns the key (normal mode or Esc). */
export function vimKeyIsOwned(editor: VimEditorState | undefined, key: string): boolean {
  return editor !== undefined && (key === "\u001b" || editor.mode === "normal");
}

/** Stable, human-readable status used by the renderer and terminal adapter. */
export function vimModeLabel(editor: VimEditorState | undefined): string {
  if (editor?.pending_delete) return "NORMAL d";
  return editor?.mode === "normal" ? "NORMAL" : "INSERT";
}
