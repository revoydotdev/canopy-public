import { describe, expect, it } from "vitest";
import { StdoutRenderer, TuiShell, createNavigation, initialModel, type CadencePort, type RenderProjection } from "../src/index.js";
import { MemoryRenderer } from "./support/render-harness.js";

function projection(columns = 40, rows = 8, output = "hello"): RenderProjection {
  const app = {
    ...initialModel(),
    screen: "tree" as const,
    screens: new Map([["tree", {
      campaign_id: "campaign-pacing",
      halted: false,
      nodes: [{ id: "node-pacing", state: "expanding", action_description: "pacing work", visit_count: 1 }],
    }]]),
  } as RenderProjection["app"];
  return {
    app, output,
    navigation: createNavigation({
      id: "main", route: "/", split: "horizontal", ratio: 0.5,
      panes: [{ id: "output", title: "Output" }],
    }, { columns, rows }),
  };
}

class RecordingCadence implements CadencePort {
  scheduled: Array<{ delay: number; callback: () => void }> = [];
  schedule(delayMs: number, callback: () => void): unknown {
    const entry = { delay: delayMs, callback };
    this.scheduled.push(entry);
    return entry;
  }
  cancel(handle: unknown): void { this.scheduled = this.scheduled.filter((entry) => entry !== handle); }
  async fire(delay: number): Promise<void> {
    const index = this.scheduled.findIndex((entry) => entry.delay === delay);
    if (index < 0) throw new Error(`no timer scheduled at ${delay}ms`);
    const [entry] = this.scheduled.splice(index, 1);
    entry.callback();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("4F.10 frame pacing — two clocks", () => {
  const options = (renderer: MemoryRenderer | StdoutRenderer, cadence: CadencePort, animate: boolean) => ({
    renderer,
    projection: () => projection(),
    cadence,
    frame_interval_ms: 16,
    animation_interval_ms: 120,
    signals: { subscribe: () => () => {} },
    animate,
  });

  it("animation clock runs on its own interval, advances the spinner, and perpetuates", async () => {
    const renderer = new MemoryRenderer();
    const cadence = new RecordingCadence();
    const shell = new TuiShell(options(renderer, cadence, true));
    await shell.start();
    expect(renderer.frames).toHaveLength(1);
    expect(cadence.scheduled.map((entry) => entry.delay)).toEqual([120]);
    await cadence.fire(120);
    expect(renderer.frames).toHaveLength(2);
    expect(renderer.frames[1]).not.toBe(renderer.frames[0]);
    expect(cadence.scheduled.map((entry) => entry.delay)).toEqual([120]);
    await shell.stop();
  });

  it("a change draw is not swallowed by a hot animation timer and leaves the spinner phase untouched", async () => {
    const renderer = new MemoryRenderer();
    const cadence = new RecordingCadence();
    const shell = new TuiShell(options(renderer, cadence, true));
    await shell.start();
    shell.invalidate();
    expect(cadence.scheduled.map((entry) => entry.delay).sort((a, b) => a - b)).toEqual([16, 120]);
    await cadence.fire(16);
    expect(renderer.frames).toHaveLength(2);
    expect(renderer.frames[1]).toBe(renderer.frames[0]);
    await cadence.fire(120);
    expect(renderer.frames[2]).not.toBe(renderer.frames[1]);
    await shell.stop();
  });

  it("stop cancels both clocks", async () => {
    const cadence = new RecordingCadence();
    const shell = new TuiShell(options(new MemoryRenderer(), cadence, true));
    await shell.start();
    shell.invalidate();
    expect(cadence.scheduled).toHaveLength(2);
    await shell.stop();
    expect(cadence.scheduled).toHaveLength(0);
  });

  it("a non-animated shell schedules no animation timer", async () => {
    const cadence = new RecordingCadence();
    const shell = new TuiShell(options(new MemoryRenderer(), cadence, false));
    await shell.start();
    expect(cadence.scheduled).toHaveLength(0);
    await shell.stop();
  });

  it("an animation tick repaints only the animated row through the frame-diff renderer", async () => {
    const writes: string[] = [];
    const renderer = new StdoutRenderer({ write: (value: string) => { writes.push(value); } }, { clear_screen: false });
    const cadence = new RecordingCadence();
    const shell = new TuiShell(options(renderer, cadence, true));
    await shell.start();
    const before = writes.length;
    await cadence.fire(120);
    expect(writes).toHaveLength(before + 1);
    const rowUpdates = writes[writes.length - 1].match(/\[\d+;1H/gu) ?? [];
    expect(rowUpdates).toHaveLength(1);
    expect(rowUpdates[0]).toBe("[8;1H");
    await shell.stop();
  });

  it("rejects a non-positive animation interval", () => {
    expect(() => new TuiShell({ ...options(new MemoryRenderer(), new RecordingCadence(), true), animation_interval_ms: 0 })).toThrow();
  });
});
