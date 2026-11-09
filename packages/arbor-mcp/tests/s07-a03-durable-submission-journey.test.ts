/**
 * A03 closure (audit/2026-09-06-remediation/manifest.md): "Complete real
 * keyboard/paste/editor/mouse and durable submission journeys remain
 * obligations." This is the keyboard/paste/multiline/editor half, driven
 * end-to-end over real raw stdin through the real `runTui` entry point --
 * not the reducer directly (pattern: tui-compose-multiline-editing.test.ts,
 * tui.test.ts's "Console input strip ... submits the real governed
 * task-composer request").
 *
 * One continuous journey, matching the manifest's own preference for one
 * assertions-bearing journey over several fragments:
 *
 *   real keystrokes -> Shift+Enter multiline -> a bracketed paste with an
 *   embedded newline -> Ctrl+E hands the WHOLE buffer to a REAL external
 *   editor process (a real `/bin/sh` script, not an injected double) that
 *   overwrites it -> Enter submits -> the submission is verified durable
 *   two independent ways: (1) `.arbor/task-composer/drafts.json` on disk
 *   after the process exits, and (2) a fresh `ArborRuntime` opened against
 *   the same persistence directory, queried through the real
 *   `taskcomposer.list` catalog query.
 *
 * "The keystroke was received" is not the obligation here; the buffer
 * surviving three different composition mechanisms intact, then landing as
 * a real persisted draft that a brand new process can read back, is.
 */
import { describe, expect, it, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArborRuntime } from "../src/runtime.js";
import { resolvePersistenceDir } from "../src/cli.js";
import { runTui } from "../src/tui.js";

const ESC = String.fromCharCode(27);

function stripAnsi(text: string): string {
  return text.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "gu"), "");
}

async function waitUntil(predicate: () => boolean, message: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("A03: durable submission through keyboard, paste, multiline, and a real external editor (runTui, T2.3b)", () => {
  let tempDir = "";
  let editorScriptDir = "";
  const savedEditor = process.env.EDITOR;
  const savedVisual = process.env.VISUAL;

  afterEach(() => {
    if (savedEditor === undefined) delete process.env.EDITOR; else process.env.EDITOR = savedEditor;
    if (savedVisual === undefined) delete process.env.VISUAL; else process.env.VISUAL = savedVisual;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    if (editorScriptDir) rmSync(editorScriptDir, { recursive: true, force: true });
  });

  it("keyboard + Shift+Enter + bracketed paste + a real external editor round trip, then a durable, independently-readable submission", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-tui-a03-"));
    editorScriptDir = mkdtempSync(join(tmpdir(), "arbor-tui-a03-editor-"));

    // A REAL external process, not an injected `spawn_editor` double
    // (`editTuiTextExternally`'s own unit test at tui-external-editor.test.ts
    // already covers the injected boundary in isolation; this journey proves
    // the real `$EDITOR` handoff through `runTui` itself). It ignores the
    // draft it is handed and overwrites it with fixed, multi-line content --
    // deterministic without needing an interactive editor.
    const editorScript = join(editorScriptDir, "fake-editor.sh");
    writeFileSync(editorScript, [
      "#!/bin/sh",
      "cat > \"$1\" <<'EOF'",
      "Final text from the real external editor",
      "second line survives the editor round trip",
      "EOF",
    ].join("\n"), "utf8");
    delete process.env.VISUAL;
    process.env.EDITOR = `/bin/sh ${editorScript}`;

    const stdin = new PassThrough();
    let out = "";
    const stdout = new PassThrough(); stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    Object.assign(stdout, { rows: 30, columns: 100, isTTY: false });
    const stderr = new PassThrough(); stderr.on("data", () => {});

    const donePromise = runTui({ cwd: tempDir, stdin, stdout, stderr, frame_interval_ms: 10 });
    await waitUntil(() => stripAnsi(out).includes("revoy2 console"), "Console did not render", 15_000);

    // Real keyboard entry, one character at a time -- not a bulk write that
    // would bypass the per-keystroke reducer path a paste or a fast typist
    // both exercise.
    for (const char of "Investigate the flaky CI test") {
      stdin.write(char);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await waitUntil(() => stripAnsi(out).includes("Investigate the flaky CI test"), "typed text did not land in the composer", 5_000);

    // Shift+Enter (kitty CSI-u encoding, input-terminal.ts) inserts a real
    // newline without submitting.
    stdin.write(`${ESC}[13;2u`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const char of "and stabilize the pipeline") {
      stdin.write(char);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await waitUntil(() => stripAnsi(out).includes("and stabilize the pipeline"), "second typed line did not land after Shift+Enter", 5_000);

    // A bracketed paste whose payload itself carries an embedded newline
    // must land as real separate lines inserted at the cursor, not a
    // silent submit and not a newline->space reflow.
    stdin.write(`${ESC}[200~pasted incident context\nsecond pasted line${ESC}[201~`);
    await waitUntil(() => stripAnsi(out).includes("second pasted line"), "bracketed paste did not land", 5_000);
    const beforeEditor = stripAnsi(out);
    expect(beforeEditor).toContain("Investigate the flaky CI test");
    expect(beforeEditor).toContain("and stabilize the pipeline");
    expect(beforeEditor).toContain("pasted incident context");
    expect(beforeEditor).toContain("second pasted line");
    expect(beforeEditor).not.toContain("What should Revoy change?"); // Console's own buffer, never promoted to the form overlay.

    // Ctrl+E hands the WHOLE composed buffer (keyboard + Shift+Enter line +
    // pasted lines) to the real external editor, which replaces it wholesale.
    // `out` is reset first so the assertion below reads only the redraw the
    // editor round trip actually produced, not the whole scrollback (which
    // would still literally contain the pre-editor text from earlier frames).
    out = "";
    stdin.write("\u0005");
    // The composer is a short viewport pinned to its LAST lines, so the
    // editor's first line scrolls out of view as soon as the second lands.
    // Wait on what the composer actually shows; the durable submission below
    // proves the whole two-line text came back.
    await waitUntil(() => stripAnsi(out).includes("second line survives the editor round trip"), "the real external editor's content did not return to the composer", 10_000);
    const afterEditor = stripAnsi(out);
    // The suspend/resume handoff around the real external process (`shell.
    // suspend()`/`shell.resume()`) legitimately repaints the pre-editor
    // screen once more before the editor actually runs, so the raw
    // concatenated delta can contain the old text in that transitional
    // repaint. What must never happen is the old draft surviving into (or
    // after) the frame that carries the editor's own returned content --
    // slice from that marker onward.
    const afterEditorTail = afterEditor.slice(afterEditor.indexOf("second line survives the editor round trip"));
    expect(afterEditorTail).not.toContain("Investigate the flaky CI test");
    expect(afterEditorTail).not.toContain("pasted incident context");

    // Enter submits the real governed task-composer request -- the same
    // path tui.test.ts's "Console input strip" submission test proves, now
    // reached via composition instead of a single flat write.
    stdin.write("\n");
    const submittedTask = "Final text from the real external editor\nsecond line survives the editor round trip";
    const draftsPath = join(tempDir, ".arbor", "task-composer", "drafts.json");
    await waitUntil(() => {
      try {
        const parsed = JSON.parse(readFileSync(draftsPath, "utf8")) as { drafts?: readonly { task?: string; source?: string }[] };
        return (parsed.drafts ?? []).some((d) => d.task === submittedTask && d.source === "tui");
      } catch {
        return false;
      }
    }, "no real draft with the composed (keyboard+paste+editor) text was durably persisted", 30_000);

    stdin.write(`${ESC}`);
    stdin.end();
    expect(await donePromise).toBe(0);

    // The submission must survive after the process that made it has
    // already exited -- observable by an entirely independent runtime
    // instance through the real catalog query, not merely a file on disk
    // this same process wrote.
    const persistenceDir = resolvePersistenceDir(tempDir);
    const reopened = new ArborRuntime({ persistence_dir: persistenceDir, devtools_logger: { persistence_dir: persistenceDir, disable_fsync: true } });
    await reopened.start();
    const listed = reopened.taskComposer.query({ kind: "taskcomposer.list", limit: 100 });
    expect(listed).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ task: submittedTask, source: "tui" })]),
    });
    await reopened.close();
  }, 60_000);
});
