/**
 * Pure, testable keyboard handler for the TUI cockpit.
 *
 * Maps raw key strings to typed intents (screen change, command dispatch,
 * interrupt, quit). No side effects beyond the callbacks — fully testable
 * without a terminal.
 *
 * Bindings: digits `0`-`9` select `options.screens[digit]` (bounds-checked
 * against its length); `d` always focuses the `devtools` screen; `i`
 * interrupts; `h` issues the halt command; Enter selects; `q`/Ctrl-C quits.
 * `d` is deliberately independent of `options.screens` — callers (e.g.
 * `demo.ts`) may fill every digit slot 0-9 with other screens and still
 * need a real, non-digit way to reach `devtools`, mirroring the same
 * mnemonic key `default-catalog.ts`'s richer `InputCatalog` already binds
 * `devtools` to for the interactive TUI.
 */
import type { ScreenId } from "./screens/screen.js";

export interface KeyboardHandlerOptions {
  onScreenChange: (screen: ScreenId) => void;
  onCommand: (kind: string) => void;
  onInterrupt: () => void;
  onQuit: () => void;
  screens: readonly ScreenId[];
}

export function createKeyboardHandler(options: KeyboardHandlerOptions): (key: string) => void {
  return (key: string): void => {
    if (key === "\u0003" || key === "q") { options.onQuit(); return; }
    if (key === "i") { options.onInterrupt(); return; }
    if (key === "h") { options.onCommand("halt"); return; }
    if (key === "\r" || key === "\n") { options.onCommand("select"); return; }
    // Real, discoverable keystroke for `devtools` — not gated on
    // `options.screens` (unlike the digit bindings below) because a caller
    // may use all ten digit slots for other screens, exactly as demo.ts
    // does, and still needs a genuine way to reach devtools.
    if (key === "d") { options.onScreenChange("devtools"); return; }
    const digit = parseInt(key, 10);
    if (!isNaN(digit) && digit >= 0 && digit < options.screens.length) {
      options.onScreenChange(options.screens[digit]);
    }
  };
}

export function attachKeyboardInput(
  stdin: NodeJS.ReadableStream,
  handler: (key: string) => void,
): () => void {
  const onData = (chunk: Buffer | string): void => {
    const text = chunk.toString();
    for (const ch of text) handler(ch);
  };
  stdin.on("data", onData);
  const tty = stdin as NodeJS.ReadableStream & { setRawMode?: (m: boolean) => void };
  if (tty.setRawMode) { try { tty.setRawMode(true); } catch { /* non-tty */ } }
  return () => {
    stdin.off("data", onData);
    if (tty.setRawMode) { try { tty.setRawMode(false); } catch { /* ignore */ } }
  };
}
