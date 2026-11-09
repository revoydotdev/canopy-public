import { access, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { editTuiTextExternally, overlayEditorKeyIntent, parseEditorCommand } from "../src/tui.js";

describe("TUI external editor composition boundary", () => {
  it("parses editor argv without invoking a shell", () => {
    expect(parseEditorCommand(`code --wait "profile name"`)).toEqual(["code", "--wait", "profile name"]);
    expect(parseEditorCommand("  ")).toBeNull();
    expect(() => parseEditorCommand(`code "unterminated`)).toThrow("unterminated");
    expect(() => parseEditorCommand("code\n--wait")).toThrow("control character");
  });

  it("uses a 0600 temporary file, bounded argv dispatch, cleanup, and terminal resume", async () => {
    const lifecycle: string[] = [];
    let draftPath = "";
    const result = await editTuiTextExternally({ text: "before", max_chars: 32 }, {
      cwd: process.cwd(),
      env: { VISUAL: `editor-bin --wait "named profile"` },
      suspend: () => { lifecycle.push("suspend"); },
      resume: () => { lifecycle.push("resume"); },
      spawn_editor: async (command, args) => {
        lifecycle.push("spawn");
        expect(command).toBe("editor-bin");
        expect(args.slice(0, -1)).toEqual(["--wait", "named profile"]);
        draftPath = args.at(-1)!;
        expect((await stat(draftPath)).mode & 0o777).toBe(0o600);
        expect(await readFile(draftPath, "utf8")).toBe("before");
        await writeFile(draftPath, "after\ntext", "utf8");
        return 0;
      },
    });
    expect(result).toBe("after\ntext");
    expect(lifecycle).toEqual(["suspend", "spawn", "resume"]);
    await expect(access(dirname(draftPath))).rejects.toThrow();
  });

  it("resumes and cleans up after a refused editor result", async () => {
    const resume = vi.fn();
    await expect(editTuiTextExternally({ text: "before", max_chars: 3 }, {
      cwd: process.cwd(), env: { EDITOR: "editor" }, suspend: vi.fn(), resume,
      spawn_editor: async (_command, args) => { await writeFile(args.at(-1)!, "too long", "utf8"); return 0; },
    })).rejects.toThrow("exceeds 3 characters");
    expect(resume).toHaveBeenCalledOnce();
  });
});

describe("TUI editor key routing", () => {
  it("routes control toggles, external edit, navigation, and Vim-owned keys deterministically", () => {
    expect(overlayEditorKeyIntent("compose", undefined, { key: "v", modifiers: ["ctrl"] })).toEqual({ type: "toggle_vim_mode" });
    expect(overlayEditorKeyIntent("compose", undefined, { key: "e", modifiers: ["ctrl"] })).toEqual({ type: "open_external_editor" });
    expect(overlayEditorKeyIntent("operator_form", undefined, { key: "e", modifiers: ["ctrl"] })).toBeNull();
    expect(overlayEditorKeyIntent("compose", { mode: "normal" }, { key: "k" })).toEqual({ type: "vim_key", key: "k" });
    expect(overlayEditorKeyIntent("compose", { mode: "insert" }, { key: "left" })).toEqual({ type: "compose_move", movement: "left" });
    expect(overlayEditorKeyIntent("compose", { mode: "insert" }, { key: "escape" })).toEqual({ type: "vim_key", key: "\u001b" });
  });
});
