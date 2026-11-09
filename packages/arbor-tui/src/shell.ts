import { paintScene, renderScene, type FrameOptions, type RendererPort, type RenderProjection } from "./renderer.js";
import type { SceneFrame } from "./frame.js";
import { resizeTerminal, type TerminalSize } from "./navigation.js";
import type { FrontierInstrumentation, LatencyObservation } from "./frontier-instrumentation.js";

export interface CadencePort {
  schedule(delayMs: number, callback: () => void): unknown;
  cancel(handle: unknown): void;
}
export interface SignalPort { subscribe(callback: () => void): () => void; }
export const TUI_SHELL_RESOURCE_IDS = Object.freeze({
  signal_subscription: "tui-shell:signal-subscription",
  resize_subscription: "tui-shell:resize-subscription",
  change_timer: "tui-shell:change-timer",
  animation_timer: "tui-shell:animation-timer",
});
export interface TuiShellOptions {
  readonly renderer: RendererPort;
  readonly projection: () => RenderProjection;
  readonly cadence: CadencePort;
  readonly frame_interval_ms?: number;
  readonly signals?: SignalPort;
  /**
   * Static options, or a thunk re-read on every draw. A thunk is what makes
   * live command-palette theme switching a genuine full-frame repaint: since
   * `draw()` always rebuilds the whole `SceneFrame` from scratch (never an
   * incremental patch — `StdoutRenderer`'s diffing is an output-layer
   * optimization only, not a partial re-render), simply reading the current
   * theme here on the next `invalidate()`-driven draw is sufficient. A plain
   * object remains supported and behaves exactly as before (every existing
   * caller/test).
   */
  readonly frame?: FrameOptions | (() => FrameOptions);
  /** Self-perpetuating animation clock on the cadence (player-piano animation). */
  readonly animate?: boolean;
  /**
   * Animation clock period (4F.10) — independent of the change clock's
   * `frame_interval_ms` coalescing window. Only animated cells differ between
   * ticks, so the frame-diff renderer keeps everything else static.
   */
  readonly animation_interval_ms?: number;
  /**
   * Live terminal-size source, polled on every draw and applied to the
   * projection's navigation model via `resizeTerminal` before painting.
   * Defaults to `defaultTerminalSize` (reads `process.stdout.columns`/`rows`,
   * `undefined` on a non-TTY stream). Before this, the navigation terminal
   * size supplied once at `createNavigation` time was never revisited for the
   * life of the process — resizing the operator's real terminal window had no
   * effect until restart. Override for deterministic tests.
   */
  readonly terminal_size?: () => TerminalSize | undefined;
  /**
   * Fires on a real terminal resize (Node's `stdout.on("resize")`, SIGWINCH)
   * so the shell redraws immediately instead of waiting for an unrelated
   * invalidation. Defaults to `createProcessResizeSignalPort`. A non-tty
   * stream never emits `resize`, so this is inert outside a real terminal.
   */
  readonly resize_signals?: SignalPort;
  /** Wall clock for live transient-notification expiry; inject in tests. */
  readonly clock?: () => number;
  /** Optional bounded measurements at the real projection/renderer boundary. */
  readonly instrumentation?: FrontierInstrumentation;
  /** Correlates the next draw with bounded canonical events and operator inputs. */
  readonly render_latency_observations?: () => readonly LatencyObservation[];
  /** Receives the exact rendered text/scene after each renderer commit. */
  readonly render_observer?: (frame: { readonly text: string; readonly scene: SceneFrame }) => void;
}

/** Reads the real controlling terminal's live dimensions; `undefined` off a non-TTY stream. */
export function defaultTerminalSize(processLike: NodeJS.Process = process): TerminalSize | undefined {
  const columns = processLike.stdout?.columns;
  const rows = processLike.stdout?.rows;
  if (typeof columns !== "number" || typeof rows !== "number" || columns < 1 || rows < 1) return undefined;
  return { columns, rows };
}

/**
 * Real terminal-resize SignalPort. Node forwards SIGWINCH as stdout's
 * `resize`, but Bun can update `columns`/`rows` without emitting that stream
 * event. Subscribe to both sources; `invalidate()` coalesces a duplicate pair
 * into one frame while either source alone still repaints the viewport.
 */
export function createProcessResizeSignalPort(processLike: NodeJS.Process = process): SignalPort {
  const subscribers = new Set<() => void>();
  const handler = () => { for (const callback of [...subscribers]) callback(); };
  processLike.stdout?.on("resize", handler);
  processLike.on("SIGWINCH", handler);
  return {
    subscribe(callback) {
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
        if (subscribers.size === 0) {
          processLike.stdout?.removeListener("resize", handler);
          processLike.removeListener("SIGWINCH", handler);
        }
      };
    },
  };
}

/** Real process-signal SignalPort: forwards SIGINT/SIGTERM to every subscriber. */
export function createProcessSignalPort(processLike: NodeJS.Process = process): SignalPort {
  const subscribers = new Set<() => void>();
  const handler = () => { for (const callback of [...subscribers]) callback(); };
  processLike.on("SIGINT", handler);
  processLike.on("SIGTERM", handler);
  return {
    subscribe(callback) {
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
        if (subscribers.size === 0) {
          processLike.removeListener("SIGINT", handler);
          processLike.removeListener("SIGTERM", handler);
        }
      };
    },
  };
}

/**
 * Minimal shell: owns terminal enter/restore and paces drawing with two
 * independent clocks (4F.10) — a change clock (invalidations coalesced to one
 * draw per `frame_interval_ms`) and an animation clock (a self-perpetuating
 * `animation_interval_ms` timer that alone advances the spinner phase). A
 * change draw never advances the animation, and a hot animation timer never
 * swallows an invalidation.
 */
export class TuiShell {
  private entered = false;
  private stopped = false;
  private suspended = false;
  private pendingChange: unknown | null = null;
  private pendingAnimation: unknown | null = null;
  private drawInFlight: Promise<void> | null = null;
  private redrawRequested = false;
  private unsubscribe: (() => void) | null = null;
  private resizeUnsubscribe: (() => void) | null = null;
  private frameCount = 0;
  private lastScene: SceneFrame | null = null;
  private readonly signals: SignalPort;
  private readonly resizeSignals: SignalPort;
  private readonly terminalSize: () => TerminalSize | undefined;
  private readonly animationInterval: number;
  private readonly clock: () => number;

  constructor(private readonly options: TuiShellOptions) {
    const interval = options.frame_interval_ms ?? 16;
    if (!Number.isSafeInteger(interval) || interval < 1) throw new Error("frame_interval_ms must be a positive safe integer");
    this.animationInterval = options.animation_interval_ms ?? 120;
    if (!Number.isSafeInteger(this.animationInterval) || this.animationInterval < 1) throw new Error("animation_interval_ms must be a positive safe integer");
    this.signals = options.signals ?? createProcessSignalPort();
    this.resizeSignals = options.resize_signals ?? createProcessResizeSignalPort();
    this.terminalSize = options.terminal_size ?? defaultTerminalSize;
    this.clock = options.clock ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.entered) return;
    this.entered = true;
    try {
      await this.options.renderer.enter();
      this.unsubscribe = this.signals.subscribe(() => { if (!this.suspended) void this.stop(); }) ?? null;
      if (this.unsubscribe !== null) this.options.instrumentation?.observeResourceAcquired(TUI_SHELL_RESOURCE_IDS.signal_subscription, "subscription");
      this.resizeUnsubscribe = this.resizeSignals.subscribe(() => this.invalidate()) ?? null;
      if (this.resizeUnsubscribe !== null) this.options.instrumentation?.observeResourceAcquired(TUI_SHELL_RESOURCE_IDS.resize_subscription, "subscription");
      await this.drawSerialized();
      this.scheduleAnimation();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  invalidate(): void {
    if (!this.entered || this.stopped || this.suspended || this.pendingChange !== null) return;
    this.pendingChange = this.options.cadence.schedule(this.options.frame_interval_ms ?? 16, () => {
      this.options.instrumentation?.observeResourceReleased(TUI_SHELL_RESOURCE_IDS.change_timer);
      this.pendingChange = null;
      void this.drawSerialized().catch(() => this.stop());
    });
    this.options.instrumentation?.observeResourceAcquired(TUI_SHELL_RESOURCE_IDS.change_timer, "timer");
  }

  /** Draw the current projection now and resolve only after its renderer commit. */
  async flush(): Promise<void> {
    await this.drawSerialized();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const activeDraw = this.drawInFlight;
    if (this.pendingChange !== null) { this.options.cadence.cancel(this.pendingChange); this.pendingChange = null; this.options.instrumentation?.observeResourceReleased(TUI_SHELL_RESOURCE_IDS.change_timer); }
    if (this.pendingAnimation !== null) { this.options.cadence.cancel(this.pendingAnimation); this.pendingAnimation = null; this.options.instrumentation?.observeResourceReleased(TUI_SHELL_RESOURCE_IDS.animation_timer); }
    this.redrawRequested = false;
    if (this.unsubscribe !== null) { this.unsubscribe(); this.unsubscribe = null; this.options.instrumentation?.observeResourceReleased(TUI_SHELL_RESOURCE_IDS.signal_subscription); }
    if (this.resizeUnsubscribe !== null) { this.resizeUnsubscribe(); this.resizeUnsubscribe = null; this.options.instrumentation?.observeResourceReleased(TUI_SHELL_RESOURCE_IDS.resize_subscription); }
    // Never restore terminal ownership underneath an asynchronous commit that
    // already began. A rejected draw is still settled before restoration; its
    // original failure remains owned by the draw caller.
    if (activeDraw !== null) await activeDraw.catch(() => undefined);
    if (this.entered && !this.suspended) await this.options.renderer.restore();
    this.suspended = false;
  }

  /** Temporarily yield terminal ownership to a composition-root subprocess. */
  async suspend(): Promise<void> {
    if (!this.entered || this.stopped || this.suspended) return;
    this.suspended = true;
    if (this.pendingChange !== null) { this.options.cadence.cancel(this.pendingChange); this.pendingChange = null; this.options.instrumentation?.observeResourceReleased(TUI_SHELL_RESOURCE_IDS.change_timer); }
    if (this.pendingAnimation !== null) { this.options.cadence.cancel(this.pendingAnimation); this.pendingAnimation = null; this.options.instrumentation?.observeResourceReleased(TUI_SHELL_RESOURCE_IDS.animation_timer); }
    this.redrawRequested = false;
    await this.options.renderer.restore();
  }

  /** Re-enter and repaint after a bounded terminal-owner handoff. */
  async resume(): Promise<void> {
    if (!this.entered || this.stopped || !this.suspended) return;
    await this.options.renderer.enter();
    this.suspended = false;
    await this.drawSerialized();
    this.scheduleAnimation();
  }

  private async draw(): Promise<void> {
    if (this.stopped || this.suspended) return;
    const projection = this.options.projection();
    const latency = this.options.render_latency_observations?.() ?? [];
    for (const observation of latency) this.options.instrumentation?.observeProjection(observation);
    const liveSize = this.terminalSize();
    const navigation = liveSize ? resizeTerminal(projection.navigation, liveSize) : projection.navigation;
    const baseFrame = typeof this.options.frame === "function" ? this.options.frame() : this.options.frame;
    const options = {
      ...baseFrame,
      frame_count: this.frameCount,
      notification_now_ms: baseFrame?.notification_now_ms ?? this.clock(),
    };
    // Builds the structured scene once (ADR-037) and hands both the flattened
    // text (what StdoutRenderer paints) and the scene itself (what a
    // structure-aware renderer hit-tests/scrolls against) to render() — the
    // scene is no longer computed and then thrown away before the port
    // boundary, and it is not computed twice per draw either.
    const scene = renderScene({ ...projection, navigation }, options);
    this.lastScene = scene;
    const invocation = this.options.instrumentation?.beginRendererInvocation();
    await this.options.renderer.publishNotifications?.(projection.app.notifications);
    const rendered = { text: paintScene(scene, options), scene };
    if (this.options.renderer.renderObserved !== undefined) {
      await this.options.renderer.renderObserved(rendered, {
        committed: () => {
          for (const observation of latency) this.options.instrumentation?.observeRendererCommit(observation);
        },
        abandoned: (reason) => {
          for (const observation of latency) this.options.instrumentation?.rendererCommitInconclusive(observation, reason);
        },
      });
    } else {
      await this.options.renderer.render(rendered);
    }
    this.options.render_observer?.(rendered);
    if (invocation !== undefined) this.options.instrumentation?.observeRendererInvocation(invocation);
    if (this.options.renderer.renderObserved === undefined) {
      for (const observation of latency) {
        this.options.instrumentation?.rendererCommitInconclusive(
          observation,
          "renderer invocation completed, but no terminal-present commit observer is installed",
        );
      }
    }
  }

  /**
   * The most recently drawn scene, or `null` before the first draw.
   *
   * A pointer click arrives as absolute terminal coordinates and means nothing
   * without the pane rectangles it landed in, which only the last drawn frame
   * knows. Exposing the scene here — rather than recomputing one at click time
   * — is what makes the hit-test agree with what the operator actually saw:
   * a scene rebuilt from current state could already reflect a refresh that
   * landed between the draw and the click.
   */
  scene(): SceneFrame | null {
    return this.lastScene;
  }

  /**
   * A terminal renderer is a single consumer. If it is slow, additional
   * change/animation ticks request one trailing repaint instead of starting
   * overlapping commits against the same terminal. The trailing draw reads a
   * fresh projection, so collapsing intermediate frames cannot hide the
   * latest canonical state.
   */
  private async drawSerialized(): Promise<void> {
    if (this.stopped || this.suspended) return;
    if (this.drawInFlight !== null) {
      this.redrawRequested = true;
      await this.drawInFlight;
      return;
    }
    const operation = this.drainDraws();
    this.drawInFlight = operation;
    try {
      await operation;
    } finally {
      if (this.drawInFlight === operation) this.drawInFlight = null;
    }
  }

  private async drainDraws(): Promise<void> {
    do {
      this.redrawRequested = false;
      await this.draw();
    } while (this.redrawRequested && !this.stopped && !this.suspended);
  }

  private scheduleAnimation(): void {
    if (this.options.animate !== true || this.stopped || this.pendingAnimation !== null) return;
    this.pendingAnimation = this.options.cadence.schedule(this.animationInterval, () => {
      this.options.instrumentation?.observeResourceReleased(TUI_SHELL_RESOURCE_IDS.animation_timer);
      this.pendingAnimation = null;
      this.frameCount += 1;
      void this.drawSerialized().then(() => this.scheduleAnimation()).catch(() => this.stop());
    });
    this.options.instrumentation?.observeResourceAcquired(TUI_SHELL_RESOURCE_IDS.animation_timer, "timer");
  }
}

export const timerCadence: CadencePort = {
  schedule: (delayMs, callback) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
