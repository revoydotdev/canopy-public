/**
 * T2.3b end-to-end proof, driven over real raw stdin through the real
 * `runTui` entry point (pattern: tui-keyboard-scrolling.test.ts /
 * task-intake-filesystem-e2e.test.ts's `runtime_factory` seeding):
 *
 *   - the task-composer form (`operator_form`) is a real cursor
 *     buffer: opening it with Enter, typing "ab", pressing Left, then
 *     typing "X" lands "aXb" in the field — not "abX" (insert-at-cursor,
 *     not always-append).
 *   - The interviews screen's compose overlay (`userinput.answer`) is a
 *     real MULTILINE cursor buffer: Shift/Alt+Enter (this codebase's kitty
 *     CSI-u encoding, `input-terminal.ts`) inserts a literal newline, shown
 *     by the renderer's `line n/m` hint growing.
 *   - A bracketed paste with an embedded newline lands as real separate
 *     lines in the compose buffer, not the old newline->space reflow.
 */
import { describe, expect, it, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArborRuntime } from "../src/runtime.js";
import { resolvePersistenceDir } from "../src/cli.js";
import { runTui } from "../src/tui.js";
import { clearRegisteredScreens } from "@arbor/tui";
import type { Action } from "@arbor/core";

const ESC = String.fromCharCode(27);
const rootAction: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };

function stripAnsi(text: string): string {
  return text.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "gu"), "");
}

async function settle(ms = 80): Promise<void> { await new Promise((resolve) => setTimeout(resolve, ms)); }

/**
 * Deadline-bounded poll for rendered content, reusing the deadline idiom this
 * file already uses. A fixed delay before a content assertion reads the frame
 * before the real `runTui` has progressed once the 300+ file suite contends
 * for workers; `ok` must be exactly the condition the assertions require, so
 * the poll can only ever wait longer, never assert less.
 */
async function waitFor(read: () => string, label: string, ok: (text: string) => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = read();
    if (ok(text)) return;
    if (Date.now() > deadline) throw new Error(`${label} never rendered\n${text.slice(-1200)}`);
    await settle(20);
  }
}

describe("compose/operator-form cursor editing over real stdin (T2.3b)", () => {
  let tempDir = "";
  afterEach(() => {
    clearRegisteredScreens();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("task form: type 'ab', Left, type 'X' -> field reads 'aXb', not 'abX'", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-tui-compose-"));
    const persistenceDir = resolvePersistenceDir(tempDir);
    const runtime = new ArborRuntime({ persistence_dir: persistenceDir, devtools_logger: { persistence_dir: persistenceDir, disable_fsync: true } });

    const stdin = new PassThrough();
    let out = "";
    const stdout = new PassThrough(); stdout.on("data", (d: Buffer) => { out += d.toString(); });
    Object.assign(stdout, { rows: 30, columns: 100, isTTY: false });
    const stderr = new PassThrough(); stderr.on("data", () => {});

    const donePromise = runTui({ cwd: tempDir, stdin, stdout, stderr, frame_interval_ms: 10, runtime_factory: () => runtime });
    const deadline = Date.now() + 10_000;
    while (!stripAnsi(out).includes("revoy2 console")) {
      if (Date.now() > deadline) throw new Error("unified Console did not render");
      await settle(20);
    }

    stdin.write("\u000e"); // Ctrl+N opens the governed task form Cockpit's Enter used to.
    while (!stripAnsi(out).includes("WHAT SHOULD REVOY CHANGE?")) {
      if (Date.now() > deadline) throw new Error("Ctrl+N did not open the task composer form");
      await settle(20);
    }
    stdin.write("ab");
    await settle(80);
    stdin.write(`${ESC}[D`); // Left arrow
    await settle(80);
    stdin.write("X");
    const read = (): string => stripAnsi(out);
    // The insert-at-cursor result IS the assertion, so wait for that exact
    // render rather than a fixed delay; the negative below then reads the same
    // buffer, in which "aX_b" is already proven present.
    await waitFor(read, "insert-at-cursor edit did not render", (t) => t.includes("aX_b"));

    const frame = stripAnsi(out);
    expect(frame).toContain("aX_b"); // Cursor remains after the inserted X, before b.
    expect(frame).not.toContain("abX");

    stdin.write(`${ESC}`); // Escape cancels the form
    await settle(150);
    stdin.end();
    const code = await donePromise;
    expect(code).toBe(0);
  }, 40_000);

  it("interviews compose overlay: Shift+Enter inserts a real newline; a bracketed paste with an embedded newline lands as separate lines", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-tui-compose-multiline-"));
    const persistenceDir = resolvePersistenceDir(tempDir);
    const runtime = new ArborRuntime({ persistence_dir: persistenceDir, devtools_logger: { persistence_dir: persistenceDir, disable_fsync: true } });

    const stdin = new PassThrough();
    let out = "";
    const stdout = new PassThrough(); stdout.on("data", (d: Buffer) => { out += d.toString(); });
    Object.assign(stdout, { rows: 30, columns: 100, isTTY: false });
    const stderr = new PassThrough(); stderr.on("data", () => {});

    const donePromise = runTui({ cwd: tempDir, stdin, stdout, stderr, frame_interval_ms: 10, runtime_factory: () => runtime });
    await settle(200);

    runtime.manager.startCampaign("c1", "plan.md", rootAction);
    runtime.manager.askForUserInput({
      campaign_id: "c1", node_id: "root", operation_id: "op-ask-1",
      question: "Proceed with the migration?",
      options: [{ id: "yes", text: "Yes", is_other: false }, { id: "no", text: "No", is_other: false }],
      authority: "lead", blocking: "blocking", requester_role: "crown",
      idempotency_key: "ask-1", as_of: new Date().toISOString(),
    });

    // Console owns the keyboard from its first frame (tui.ts), so release
    // it before driving a bare navigation key.
    stdin.write("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 60));
    stdin.write("i"); await settle(200); // focus:interviews -- issues userinput.list
    stdin.write("a"); await settle(150); // arm_answer
    const read = (): string => stripAnsi(out);

    stdin.write("first line");
    await waitFor(read, "compose overlay did not accept the first line", (t) => t.includes("first line"));

    // Shift+Enter, this codebase's kitty CSI-u encoding for a modified
    // Enter (input-terminal.ts's `[13;2u` entry) -- inserts a literal `\n`,
    // never submits.
    stdin.write(`${ESC}[13;2u`);
    await waitFor(read, "Shift+Enter did not render a second buffer line", (t) => t.includes("line 2/2"));
    let frame = stripAnsi(out);
    expect(frame).toContain("line 2/2");
    // Negative asserted only after "line 2/2" is proven present, so the buffer
    // it reads has already advanced past the one-line state it forbids.
    expect(frame).not.toContain("Proceed with the migration? · line 1/1");

    stdin.write("second line");
    await waitFor(read, "second buffer line did not render", (t) => t.includes("second line"));

    // A bracketed paste (`ESC[200~...ESC[201~`) whose payload itself
    // contains an embedded newline must land as one more real line (the
    // buffer already had 2 lines; the paste's own embedded `\n` adds a
    // third), inserted at the cursor as one edit — not reflowed to one line
    // with the newline replaced by a space.
    stdin.write(`${ESC}[200~pasted-one\npasted-two${ESC}[201~`);
    // The paste's LAST line is the positive marker, so both pasted lines and
    // "line 3/3" are already proven present before any assertion below.
    await waitFor(read, "bracketed paste did not land as separate lines", (t) => t.includes("pasted-two"));
    frame = stripAnsi(out);
    expect(frame).toContain("line 3/3");
    expect(frame).not.toContain("pasted-one pasted-two"); // old space-reflow behavior
    // Landed at the cursor, directly after "second line" -- no invented gap.
    expect(frame).toContain("second linepasted-one");
    expect(frame).toContain("pasted-two");

    stdin.write(`${ESC}`); // Escape cancels the compose overlay
    await settle(150);
    stdin.end();
    const code = await donePromise;
    expect(code).toBe(0);
  }, 90_000);

  it("Console owns one multiline reducer buffer: Shift+Enter and bracketed paste add lines without submitting", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-tui-console-multiline-"));
    const persistenceDir = resolvePersistenceDir(tempDir);
    const runtime = new ArborRuntime({ persistence_dir: persistenceDir, devtools_logger: { persistence_dir: persistenceDir, disable_fsync: true } });
    const stdin = new PassThrough();
    let out = "";
    const stdout = new PassThrough(); stdout.on("data", (d: Buffer) => { out += d.toString(); });
    Object.assign(stdout, { rows: 24, columns: 80, isTTY: false });
    const stderr = new PassThrough(); stderr.on("data", () => {});

    const donePromise = runTui({ cwd: tempDir, stdin, stdout, stderr, frame_interval_ms: 10, runtime_factory: () => runtime });
    const deadline = Date.now() + 10_000;
    while (!stripAnsi(out).includes("revoy2 console")) {
      if (Date.now() > deadline) throw new Error("Console did not render");
      await settle(20);
    }
    // Console starts focused; an empty Enter intentionally blurs it.
    const read = (): string => stripAnsi(out);
    // The strip pane is two rows tall and follows the cursor, so a burst of
    // writes coalesced into one input event renders only the LAST lines and
    // "first" is never emitted at all. Rendering each line before sending the
    // next is what makes the three toContain assertions below deterministic.
    stdin.write("first");
    await waitFor(read, "the Console strip did not render the first line", (t) => t.includes("\u276f first"));
    stdin.write(`${ESC}[13;2u`); // Shift+Enter — insert, never submit.
    stdin.write("second");
    // "❯" prefixes the strip's first VISIBLE row, so this is the two-line
    // state: "❯ first" above a "second" row.
    await waitFor(read, "the Console strip did not render the second line", (t) => /\u276f first[\s\S]*second/.test(t));
    stdin.write(`${ESC}[200~\nthird${ESC}[201~`); // one atomic multiline paste.
    // The window now scrolls to "❯ second" / "third", which together prove
    // all three lines reached the strip — the state the not.toContain below
    // forbids regressing into the operator form.
    await waitFor(read, "the Console strip did not render the pasted line", (t) => /\u276f second[\s\S]*third/.test(t));

    const frame = stripAnsi(out);
    expect(frame).toContain("first");
    expect(frame).toContain("second");
    expect(frame).toContain("third");
    expect(frame).toContain("Shift+Enter newline");
    expect(frame).not.toContain("What should Revoy change?");

    stdin.write(`${ESC}`); // blur without moving the buffer into a form.
    await settle(80);
    stdin.end();
    expect(await donePromise).toBe(0);
  }, 60_000);
});
