import { describe, expect, it } from "vitest";
import {
  TuiShell,
  createNavigation,
  initialModel,
  type CadencePort,
  type RenderInput,
  type RenderProjection,
  type RendererPort,
} from "../src/index.js";

class ManualCadence implements CadencePort {
  readonly callbacks: Array<() => void> = [];
  schedule(_delayMs: number, callback: () => void): unknown {
    this.callbacks.push(callback);
    return callback;
  }
  cancel(handle: unknown): void {
    const index = this.callbacks.indexOf(handle as () => void);
    if (index >= 0) this.callbacks.splice(index, 1);
  }
  tick(): void {
    this.callbacks.shift()?.();
  }
}

class ControlledRenderer implements RendererPort {
  calls = 0;
  active = 0;
  maximumActive = 0;
  restores = 0;
  readonly events: string[] = [];
  blockNext = false;
  private releaseBlocked: (() => void) | null = null;

  enter(): void {}
  restore(): void { this.restores += 1; this.events.push("restore"); }
  async render(_input: RenderInput): Promise<void> {
    this.calls += 1;
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    this.events.push("render:start");
    try {
      if (this.blockNext) {
        this.blockNext = false;
        await new Promise<void>((resolve) => { this.releaseBlocked = resolve; });
      }
    } finally {
      this.active -= 1;
      this.events.push("render:end");
    }
  }
  release(): void {
    this.releaseBlocked?.();
    this.releaseBlocked = null;
  }
}

function projection(): RenderProjection {
  return {
    app: initialModel(),
    output: "slow-consumer",
    navigation: createNavigation({
      id: "slow-consumer", route: "/", split: "horizontal", ratio: 0.5,
      panes: [{ id: "primary", title: "Primary" }],
    }, { columns: 80, rows: 24 }),
  };
}

describe("TuiShell slow-consumer backpressure", () => {
  it("never overlaps renderer commits and collapses a flood into one trailing fresh frame", async () => {
    const cadence = new ManualCadence();
    const renderer = new ControlledRenderer();
    const shell = new TuiShell({ renderer, cadence, projection });
    await shell.start();
    expect(renderer.calls).toBe(1);

    renderer.blockNext = true;
    shell.invalidate();
    cadence.tick();
    await Promise.resolve();
    expect(renderer.active).toBe(1);

    for (let index = 0; index < 1_000; index += 1) {
      shell.invalidate();
      cadence.tick();
    }
    expect(renderer.calls).toBe(2);
    expect(renderer.maximumActive).toBe(1);

    renderer.release();
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    expect(renderer.calls).toBe(3);
    expect(renderer.maximumActive).toBe(1);
    expect(renderer.active).toBe(0);
    await shell.stop();
  });

  it("waits for an active commit before restoring terminal ownership", async () => {
    const cadence = new ManualCadence();
    const renderer = new ControlledRenderer();
    const shell = new TuiShell({ renderer, cadence, projection });
    await shell.start();

    renderer.blockNext = true;
    shell.invalidate();
    cadence.tick();
    await Promise.resolve();
    const stopping = shell.stop();
    await Promise.resolve();
    expect(renderer.restores).toBe(0);
    expect(renderer.active).toBe(1);

    renderer.release();
    await stopping;
    expect(renderer.restores).toBe(1);
    expect(renderer.events.slice(-2)).toEqual(["render:end", "restore"]);
  });
});
