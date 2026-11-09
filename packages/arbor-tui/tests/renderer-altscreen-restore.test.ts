/**
 * renderer-altscreen-restore.test.ts — the alternate screen must be left even
 * when nobody calls restore().
 *
 * WHY. `runTui`'s crash path (`runCrashBoundary` in arbor-mcp/src/tui.ts) never
 * calls `renderer.restore()`; only the graceful `finish()` does. Before the
 * alternate screen landed that was cosmetic, because the TUI was already
 * painting into the normal buffer. With it, an uncaught failure would strand
 * the operator inside the alternate buffer with no shell prompt and a terminal
 * that looks hung — a worse outcome than the crash itself.
 *
 * The renderer is what mutates the terminal, so the renderer owns undoing it,
 * rather than trusting every present and future caller to remember.
 */
import { describe, it, expect } from "vitest";
import { StdoutRenderer } from "../src/renderer.js";

const LEAVE_ALT_SCREEN = "[?1049l";

function fakeStream(chunks: string[]): never {
  return { write: (chunk: string) => { chunks.push(chunk); return true; } } as never;
}

describe("alternate screen restoration", () => {
  it("registers an exit-time safety net while entered, and removes it on restore", () => {
    const before = process.listenerCount("exit");
    const chunks: string[] = [];
    const renderer = new StdoutRenderer(fakeStream(chunks), {});
    renderer.enter();
    expect(process.listenerCount("exit")).toBe(before + 1);
    renderer.restore();
    expect(process.listenerCount("exit")).toBe(before);
    expect(chunks.join("")).toContain(LEAVE_ALT_SCREEN);
  });

  it("leaves the alternate screen when only the exit handler runs", () => {
    // Simulates the crash path: enter(), then process exit without restore().
    const chunks: string[] = [];
    const renderer = new StdoutRenderer(fakeStream(chunks), {});
    renderer.enter();
    chunks.length = 0;
    const handlers = process.listeners("exit");
    handlers[handlers.length - 1]?.call(process, 1);
    expect(chunks.join("")).toContain(LEAVE_ALT_SCREEN);
    renderer.restore();
  });

  it("does not leak a listener across repeated enter/restore cycles", () => {
    const before = process.listenerCount("exit");
    const renderer = new StdoutRenderer(fakeStream([]), {});
    for (let i = 0; i < 5; i += 1) { renderer.enter(); renderer.restore(); }
    expect(process.listenerCount("exit")).toBe(before);
  });

  it("registers nothing when the alternate screen was never entered", () => {
    // `clear_screen: false` opts out of the alternate screen entirely, so
    // there is nothing to undo and no handler to install.
    const before = process.listenerCount("exit");
    const renderer = new StdoutRenderer(fakeStream([]), { clear_screen: false });
    renderer.enter();
    expect(process.listenerCount("exit")).toBe(before);
    renderer.restore();
  });
});
