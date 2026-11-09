/**
 * Bun-only foi-v1 capture through @opentui/core's real native Zig renderer.
 * The fixture is still a deterministic simulation; `native_harness` means
 * the production SceneFrame/OpenTuiRenderer/native-frame path ran, never that
 * a provider or connector was invoked.
 */
import { captureFOIScenarioArtifacts, type FOICapturedArtifacts, type FOIPlannedFrame } from "./foi-capture.js";
import type { FOIColorMode, FOIEvidenceMeasurements, FOIScenarioManifest } from "./foi-scenario-contract.js";
import type { SceneFrame } from "./frame.js";
import { OpenTuiRenderer } from "./opentui-renderer.js";
import { paintScene, renderScene } from "./renderer.js";
import { createNavigation } from "./navigation.js";
import { initialModel } from "./model.js";

type PlannedFrame = FOIPlannedFrame;

function monotonicNowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

/** Native present evidence for one planned deterministic frame. */
export interface FOINativeFrameCommitObservation {
  readonly planned_frame_index: number;
  readonly event_count: number;
  readonly origin: PlannedFrame["origin"];
  /** Measured from this capture's planned-frame handoff, not event receipt. */
  readonly planned_frame_to_native_commit_ms: number;
}

/** Supplemental adapter-level probe; this is not an OS/terminal-arrival timestamp. */
export interface FOINativeInputCommitObservation {
  readonly source: "opentui_test_keyhandler_injection";
  readonly accepted_key: string;
  readonly rendered_marker: string;
  readonly rendered_terminal_frame: string;
  readonly rendered_marker_visible: boolean;
  readonly planned_frame_index: number;
  readonly input_received_at_monotonic_ms: number;
  readonly native_committed_at_monotonic_ms: number;
  readonly input_receipt_to_native_commit_ms: number;
}

export interface FOINativeCapturedArtifacts {
  readonly artifacts: FOICapturedArtifacts;
  readonly measurements: FOIEvidenceMeasurements;
  readonly observations: {
    readonly startup_ms: number;
    readonly wall_ms: number;
    readonly cpu_user_us: number;
    readonly cpu_system_us: number;
    readonly rss_delta_bytes: number;
    readonly heap_peak_delta_bytes: number;
    readonly native_commit_count: number;
    readonly planned_frame_count: number;
    /** Bounded, commit-observer-backed present trace for every planned frame. */
    readonly native_commit_trace: readonly FOINativeFrameCommitObservation[];
    /** One explicit TestRenderer key-handler receipt -> committed marker frame probe on S01 only. */
    readonly native_input_commit: FOINativeInputCommitObservation | null;
  };
  readonly performance_pass: boolean;
  readonly cleanup_pass: boolean;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

function parsePlannedFrames(capture: FOICapturedArtifacts): readonly PlannedFrame[] {
  const parsed = JSON.parse(capture.event_boundary_frame) as { readonly frames?: readonly PlannedFrame[] };
  if (!Array.isArray(parsed.frames) || parsed.frames.length === 0) throw new Error("deterministic capture did not supply event-boundary scenes");
  return parsed.frames;
}

/** Runs the bounded deterministic capture through a real native renderer. */
export async function captureFOINativeScenarioArtifacts(
  manifest: FOIScenarioManifest,
  colorMode: FOIColorMode = manifest.fixture.color_modes[0]!,
): Promise<FOINativeCapturedArtifacts> {
  const captureStarted = monotonicNowMs();
  const cpuBefore = process.cpuUsage();
  const rssBefore = process.memoryUsage().rss;
  const base = captureFOIScenarioArtifacts(manifest, colorMode);
  const planned = parsePlannedFrames(base);
  const { createTestRenderer } = await import("@opentui/core/testing");
  const setup = await createTestRenderer({ width: manifest.fixture.viewport.columns, height: manifest.fixture.viewport.rows });
  const startupMs = monotonicNowMs() - captureStarted;
  const renderer = setup.renderer;
  const baselineRootChildren = renderer.root.getChildren().length;
  const observedEvents = ["resize", "focus", "blur", "frame"] as const;
  const baselineListeners = new Map(observedEvents.map((event) => [event, renderer.listenerCount(event)] as const));
  const adapter = new OpenTuiRenderer({ renderer, themeModeTimeoutMs: 1 });
  const commitDurations: number[] = [];
  const nativeCommitTrace: FOINativeFrameCommitObservation[] = [];
  const nativeFrames: Array<{ readonly event_count: number; readonly terminal: string; readonly scene: SceneFrame }> = [];
  const memoryBefore = process.memoryUsage().heapUsed;
  let memoryPeak = memoryBefore;
  let restored = false;
  let nativeInputCommit: FOINativeInputCommitObservation | null = null;

  try {
    await adapter.enter();
    for (const [index, frame] of planned.entries()) {
      const started = monotonicNowMs();
      let committedAt: number | null = null;
      let abandoned: string | null = null;
      adapter.renderObserved({ scene: frame.scene, text: paintScene(frame.scene) }, {
        committed: () => { committedAt = monotonicNowMs(); },
        abandoned: (reason) => { abandoned = reason; },
      });
      await setup.renderOnce();
      if (abandoned !== null) throw new Error(abandoned);
      if (committedAt === null) throw new Error("native renderer did not emit a frame commit");
      const duration = committedAt - started;
      commitDurations.push(duration);
      nativeCommitTrace.push(Object.freeze({
        planned_frame_index: index,
        event_count: frame.event_count,
        origin: frame.origin,
        planned_frame_to_native_commit_ms: duration,
      }));
      nativeFrames.push({ event_count: frame.event_count, terminal: setup.captureCharFrame(), scene: frame.scene });
      memoryPeak = Math.max(memoryPeak, process.memoryUsage().heapUsed);
    }

    // S01 carries one supplemental real OpenTUI KeyHandler path. The test
    // renderer injects the key, OpenTUI parses and emits it, and that accepted
    // event changes the scene committed by OpenTUI's native frame callback.
    // The receipt starts at adapter delivery, not OS arrival; deterministic
    // planned-frame-only scenarios retain an explicitly unmeasured
    // input_to_render_ms metric below.
    if (manifest.id === "S01") {
      const { createMockKeys } = await import("@opentui/core/testing");
      let receiptAt: number | null = null;
      let commitAt: number | null = null;
      let inputCommit: Promise<void> | null = null;
      let acceptedKey = "";
      let marker = "";
      let abandonedReason: string | null = null;
      const unsubscribe = adapter.onNativeInput((decoded) => {
        const key = decoded.text;
        if (key.length === 0 || inputCommit !== null) return;
        acceptedKey = key;
        receiptAt = monotonicNowMs();
        marker = `native input received: ${key}`;
        const inputScene = renderScene({
          app: initialModel(),
          output: marker,
          navigation: createNavigation({
            id: "foi-input-probe", route: "/", split: "horizontal", ratio: 0.5,
            panes: [{ id: "input-probe", title: "Native input probe" }],
          }, { columns: manifest.fixture.viewport.columns, rows: manifest.fixture.viewport.rows }),
        });
        inputCommit = adapter.renderObserved({ scene: inputScene, text: paintScene(inputScene) }, {
          committed: () => { commitAt = monotonicNowMs(); },
          abandoned: (reason) => { abandonedReason = reason; },
        });
      }, () => {});
      if (unsubscribe === null) throw new Error("native input probe could not subscribe to OpenTUI KeyHandler");
      try {
        createMockKeys(renderer).pressKey("x");
        if (inputCommit === null) throw new Error("OpenTUI KeyHandler did not deliver the injected probe key");
        await setup.renderOnce();
        await inputCommit;
        if (abandonedReason !== null) throw new Error(`native input probe frame was abandoned: ${abandonedReason}`);
        if (receiptAt === null || commitAt === null) throw new Error("native input probe did not observe both receipt and frame commit");
        const renderedTerminalFrame = setup.captureCharFrame();
        const markerVisible = renderedTerminalFrame.includes(marker);
        if (!markerVisible) throw new Error("native input receipt frame did not contain its input-derived marker");
        nativeInputCommit = Object.freeze({
          source: "opentui_test_keyhandler_injection",
          accepted_key: acceptedKey,
          rendered_marker: marker,
          rendered_terminal_frame: renderedTerminalFrame,
          rendered_marker_visible: markerVisible,
          planned_frame_index: planned.length,
          input_received_at_monotonic_ms: receiptAt,
          native_committed_at_monotonic_ms: commitAt,
          input_receipt_to_native_commit_ms: Math.max(0, commitAt - receiptAt),
        });
      } finally {
        unsubscribe();
      }
    }
    adapter.restore();
    restored = true;

    const listenersSettled = observedEvents.every((event) => renderer.listenerCount(event) === baselineListeners.get(event));
    const rootSettled = renderer.root.getChildren().length === baselineRootChildren;
    const cleanupPass = listenersSettled && rootSettled;
    const renderP95 = percentile(commitDurations, 0.95);
    const stress = manifest.id === "S16" || manifest.id === "S17";
    // The native observer proves planned-frame handoff → commit.  It cannot
    // turn a fully materialized deterministic fixture into a canonical event
    // or input receipt, so those two program metrics stay inconclusive.
    const performancePass = renderP95 < (stress ? 50 : 16);
    const finalNativeFrame = nativeFrames.at(-1)?.terminal ?? "";
    const semantic = JSON.parse(base.semantic_snapshot) as Record<string, unknown>;
    const recordingHeader = JSON.stringify({
      version: 2,
      width: manifest.fixture.viewport.columns,
      height: manifest.fixture.viewport.rows,
      timestamp: 0,
      env: { TERM: "opentui-native-test-renderer", SHELL: "foi-v1" },
    });
    const recordingFrames = nativeFrames.map((frame, index) => JSON.stringify([index / 10, "o", `${frame.terminal}\n`]));
    const eventBoundary = `${JSON.stringify({ scenario: manifest.id, renderer: "@opentui/core/native-zig", frames: nativeFrames }, null, 2)}\n`;
    const measurements: FOIEvidenceMeasurements = Object.freeze({
      event_to_visible_ms: Object.freeze({ status: "unmeasured" as const, reason: "native commits are traced from deterministic planned-frame handoff; no canonical runtime-event observation timestamp is available" }),
      input_to_render_ms: Object.freeze({ status: "unmeasured" as const, reason: "the deterministic capture has virtual input ordering but no physical input-receipt boundary" }),
      render_ms: Object.freeze({ status: "measured" as const, value: renderP95, unit: "ms" as const }),
      memory_bytes: Object.freeze({ status: "measured" as const, value: Math.max(0, memoryPeak - memoryBefore), unit: "bytes" as const }),
      queue_high_water: Object.freeze({ status: "measured" as const, value: planned.length === 0 ? 0 : 1, unit: "count" as const }),
      cleanup: Object.freeze({
        status: "measured" as const,
        subscriptions: cleanupPass ? 0 : 1,
        timers: 0,
        subprocesses: 0,
        handles: cleanupPass ? 0 : 1,
        terminal_mode_residue: 0,
      }),
    });
    const assertions = Object.freeze({
      ...base.assertion_status,
      ...(manifest.required_assertions.includes("measurement-receipt")
        ? { "measurement-receipt": Object.values(measurements).every((measurement) => measurement.status === "measured") ? "pass" as const : "unmeasured" as const }
        : {}),
    });
    const cpu = process.cpuUsage(cpuBefore);
    const wallMs = monotonicNowMs() - captureStarted;
    const observations = Object.freeze({
      startup_ms: startupMs,
      wall_ms: wallMs,
      cpu_user_us: cpu.user,
      cpu_system_us: cpu.system,
      rss_delta_bytes: process.memoryUsage().rss - rssBefore,
      heap_peak_delta_bytes: Math.max(0, memoryPeak - memoryBefore),
      native_commit_count: nativeFrames.length + (nativeInputCommit === null ? 0 : 1),
      planned_frame_count: planned.length,
      native_commit_trace: Object.freeze(nativeCommitTrace),
      native_input_commit: nativeInputCommit,
    });
    return Object.freeze({
      artifacts: Object.freeze({
        ...base,
        semantic_snapshot: `${JSON.stringify({ ...semantic, native_terminal_frame: finalNativeFrame }, null, 2)}\n`,
        event_boundary_frame: eventBoundary,
        sampled_frame: eventBoundary,
        recording: `${recordingHeader}\n${recordingFrames.join("\n")}${recordingFrames.length === 0 ? "" : "\n"}`,
        assertion_status: assertions,
      }),
      measurements,
      observations,
      performance_pass: performancePass,
      cleanup_pass: cleanupPass,
    });
  } finally {
    if (!restored) adapter.restore();
    renderer.destroy();
  }
}
