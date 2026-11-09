import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import { attachKeyboardInput, createKeyboardHandler } from "../src/keyboard.js";
import type { ScreenId } from "../src/screens/screen.js";

const screens: readonly ScreenId[] = ["campaigns", "diagnostics", "tasks", "devtools"];

describe("createKeyboardHandler", () => {
  it("maps digits 0-9 to screen changes", () => {
    let changed: string | null = null;
    const handler = createKeyboardHandler({
      onScreenChange: (s) => { changed = s; },
      onCommand: () => {},
      onInterrupt: () => {},
      onQuit: () => {},
      screens,
    });
    handler("0"); expect(changed).toBe("campaigns");
    handler("1"); expect(changed).toBe("diagnostics");
    handler("3"); expect(changed).toBe("devtools");
  });

  it("ignores digit beyond screen count", () => {
    let changed = false;
    const handler = createKeyboardHandler({
      onScreenChange: () => { changed = true; },
      onCommand: () => {},
      onInterrupt: () => {},
      onQuit: () => {},
      screens,
    });
    handler("9"); expect(changed).toBe(false);
  });

  it("q and Ctrl-C trigger quit", () => {
    let quits = 0;
    const handler = createKeyboardHandler({
      onScreenChange: () => {}, onCommand: () => {}, onInterrupt: () => {},
      onQuit: () => { quits++; },
      screens,
    });
    handler("q"); expect(quits).toBe(1);
    handler("\u0003"); expect(quits).toBe(2);
  });

  it("i triggers interrupt", () => {
    let interrupted = false;
    const handler = createKeyboardHandler({
      onScreenChange: () => {}, onCommand: () => {},
      onInterrupt: () => { interrupted = true; },
      onQuit: () => {}, screens,
    });
    handler("i"); expect(interrupted).toBe(true);
  });

  it("h triggers halt command", () => {
    let cmd: string | null = null;
    const handler = createKeyboardHandler({
      onScreenChange: () => {},
      onCommand: (k) => { cmd = k; },
      onInterrupt: () => {}, onQuit: () => {}, screens,
    });
    handler("h"); expect(cmd).toBe("halt");
  });

  it("Enter triggers select command", () => {
    let cmd: string | null = null;
    const handler = createKeyboardHandler({
      onScreenChange: () => {},
      onCommand: (k) => { cmd = k; },
      onInterrupt: () => {}, onQuit: () => {}, screens,
    });
    handler("\r"); expect(cmd).toBe("select");
    handler("\n"); expect(cmd).toBe("select");
  });

  // A2-residual: `devtools` must be reachable through a real, non-digit
  // keystroke — the digit slots (0-9) are fully claimed by other screens in
  // real usage (demo.ts's `demoScreens`), so `d` is bound independently of
  // `options.screens` and must work even when "devtools" is absent from it.
  it("d always focuses devtools, independent of the configured screens list", () => {
    let changed: string | null = null;
    const handler = createKeyboardHandler({
      onScreenChange: (s) => { changed = s; },
      onCommand: () => {},
      onInterrupt: () => {},
      onQuit: () => {},
      screens: ["campaigns", "diagnostics", "tasks", "operations", "output", "communications", "config", "agents", "jobs", "approvals"],
    });
    handler("d");
    expect(changed).toBe("devtools");
  });

  it("unknown key is a no-op (no throw)", () => {
    const handler = createKeyboardHandler({
      onScreenChange: () => {}, onCommand: () => {}, onInterrupt: () => {}, onQuit: () => {},
      screens,
    });
    expect(() => handler("z")).not.toThrow();
    expect(() => handler("")).not.toThrow();
  });

  it("attaches and restores raw terminal input without retaining a data listener", () => {
    const stdin = new EventEmitter() as EventEmitter & NodeJS.ReadableStream & { setRawMode: ReturnType<typeof vi.fn> };
    stdin.setRawMode = vi.fn();
    const received: string[] = [];
    const detach = attachKeyboardInput(stdin, (key) => received.push(key));
    stdin.emit("data", Buffer.from("i\n"));
    expect(received).toEqual(["i", "\n"]);
    expect(stdin.setRawMode).toHaveBeenCalledWith(true);

    detach();
    stdin.emit("data", "q");
    expect(received).toEqual(["i", "\n"]);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
  });
});
