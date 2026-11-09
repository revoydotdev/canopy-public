import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { TuiShell, createNavigation, createProcessResizeSignalPort, initialModel, type CadencePort, type SignalPort } from "../src/index.js";
import { MemoryRenderer } from "./support/render-harness.js";

class ManualCadence implements CadencePort {
  readonly callbacks: Array<() => void> = [];
  schedule(_delayMs: number, callback: () => void): unknown { this.callbacks.push(callback); return callback; }
  cancel(handle: unknown): void {
    const index = this.callbacks.indexOf(handle as () => void);
    if (index >= 0) this.callbacks.splice(index, 1);
  }
  tick(): void { this.callbacks.shift()?.(); }
}

describe("live resize while operator input is active", () => {
  it("observes SIGWINCH when Bun does not emit stdout resize and removes both listeners", () => {
    const processEvents = new EventEmitter();
    const stdoutEvents = new EventEmitter();
    const processLike = processEvents as unknown as NodeJS.Process;
    Object.assign(processLike, { stdout: stdoutEvents });
    const port = createProcessResizeSignalPort(processLike);
    let calls = 0;
    const unsubscribe = port.subscribe(() => { calls += 1; });
    processEvents.emit("SIGWINCH");
    stdoutEvents.emit("resize");
    expect(calls).toBe(2);
    unsubscribe();
    processEvents.emit("SIGWINCH");
    stdoutEvents.emit("resize");
    expect(calls).toBe(2);
  });

  it("coalesces a resize storm to the latest geometry without losing composer text, focus, or cursor", async () => {
    let resize = (): void => undefined;
    let resizeSubscribed = false;
    const resizeSignals: SignalPort = { subscribe: (callback) => { resize = callback; resizeSubscribed = true; return () => { resizeSubscribed = false; }; } };
    const renderer = new MemoryRenderer();
    const cadence = new ManualCadence();
    let terminal = { columns: 120, rows: 40 };
    const base = initialModel();
    const app = {
      ...base,
      screen: "console" as const,
      screens: new Map([["console" as const, { console_input: { text: "operator draft", cursor: 8, focused: true, action: "queue" } }]]),
    };
    const shell = new TuiShell({
      renderer, cadence, resize_signals: resizeSignals, signals: { subscribe: () => () => undefined },
      terminal_size: () => terminal,
      projection: () => ({
        app, output: "streaming",
        navigation: createNavigation({ id: "resize-input", route: "/", split: "horizontal", ratio: 0.5, panes: [{ id: "primary", title: "Primary" }] }, { columns: 120, rows: 40 }),
      }),
    });

    await shell.start();
    expect(renderer.scenes.at(-1)?.columns).toBe(120);
    for (let index = 0; index < 100; index += 1) {
      terminal = index % 2 === 0 ? { columns: 60, rows: 20 } : { columns: 160, rows: 48 };
      resize();
    }
    terminal = { columns: 72, rows: 22 };
    resize();
    expect(cadence.callbacks).toHaveLength(1);
    cadence.tick();
    for (let index = 0; index < 4; index += 1) await Promise.resolve();

    const scene = renderer.scenes.at(-1)!;
    expect(scene.columns).toBe(72);
    expect(scene.rows).toHaveLength(22);
    expect(scene.panes[0]?.composer).toMatchObject({ text: "operator draft", cursor: 8, focused: true, action: "queue" });
    expect(renderer.scenes).toHaveLength(2);
    await shell.stop();
    expect(resizeSubscribed).toBe(false);
  });
});
