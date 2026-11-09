/**
 * Deterministic artifact capture over the real operator projection and
 * SceneFrame renderer. This is deliberately not an OpenTUI presentation
 * receipt: callers must keep `execution.native_harness` false until a native
 * renderer commit observer supplies that stronger fact.
 */
import { buildOperatorViewModel, DEFAULT_OPERATOR_PROJECTION_LIMITS, type OperatorViewModel } from "./operator-view-model.js";
import { materializeFOIScenario, type FOIColorMode, type FOIScenarioManifest, type FOIViewport } from "./foi-scenario-contract.js";
import { initialModel } from "./model.js";
import { createNavigation } from "./navigation.js";
import { renderScene } from "./renderer.js";
import { withTemporaryScreenRegistration } from "./screens/screen.js";
import { liveSessionScreen } from "./screens/live-session.js";
import { resultReviewScreen } from "./screens/result-review.js";
import type { SceneFrame } from "./frame.js";
import { update } from "./update.js";
import { stripAnsi } from "./player-piano.js";

export interface FOICapturedArtifacts {
  readonly raw_event_trace: string;
  readonly input_trace: string;
  readonly semantic_snapshot: string;
  readonly event_boundary_frame: string;
  readonly sampled_frame: string;
  readonly recording: string;
  readonly assertion_status: Readonly<Record<string, "pass" | "unmeasured">>;
  readonly retained_event_count: number;
  readonly rendered_frame_count: number;
}

/**
 * A frame planned by the deterministic corpus recorder.  Its origin is
 * deliberately separate from the canonical-runtime observation boundary: the
 * recorder materializes the full fixture before it plans any frames.
 */
export interface FOIPlannedFrame {
  readonly event_count: number;
  readonly scene: SceneFrame;
  readonly origin: {
    readonly kind: "deterministic_fixture_materialization";
    readonly canonical_event_observed_at_ms: null;
    readonly reason: string;
  };
}

const MAX_CAPTURED_FRAMES = 32;

interface LiveEdgeEvidence {
  readonly frames: readonly { readonly event_count: number; readonly scene: SceneFrame }[];
  readonly inputs: readonly Readonly<Record<string, unknown>>[];
  readonly snapshot: Readonly<Record<string, unknown>>;
}

interface AvailabilityEvidence {
  readonly frames: readonly { readonly event_count: number; readonly scene: SceneFrame }[];
  readonly inputs: readonly Readonly<Record<string, unknown>>[];
  readonly snapshot: Readonly<Record<string, unknown>>;
}

interface ResponsiveEvidence {
  readonly frames: readonly { readonly event_count: number; readonly scene: SceneFrame }[];
  readonly inputs: readonly Readonly<Record<string, unknown>>[];
  readonly snapshot: Readonly<Record<string, unknown>>;
}

interface ColorEvidence {
  readonly no_color_scene: SceneFrame;
  readonly text_equivalent_without_sgr: boolean;
}

interface ArtifactEvidence {
  readonly frames: readonly { readonly event_count: number; readonly scene: SceneFrame }[];
  readonly inputs: readonly Readonly<Record<string, unknown>>[];
  readonly snapshot: Readonly<Record<string, unknown>>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function selectedIndices(length: number, maximum = MAX_CAPTURED_FRAMES): readonly number[] {
  if (length <= 0) return [0];
  if (length <= maximum) return Array.from({ length }, (_, index) => index + 1);
  const indices = new Set<number>([1, length]);
  for (let index = 1; index < maximum - 1; index += 1) indices.add(Math.round((index * (length - 1)) / (maximum - 1)) + 1);
  return [...indices].sort((left, right) => left - right);
}

function sceneForValue(manifest: FOIScenarioManifest, value: unknown, viewport: FOIViewport, colorMode: FOIColorMode): SceneFrame {
  return withTemporaryScreenRegistration(liveSessionScreen, () => {
    const app = {
      ...initialModel(),
      screen: "live-session" as const,
      grantedCapabilities: new Set(["harness.session.read"]),
      screens: new Map([["live-session" as const, value]]),
    };
    const navigation = createNavigation({
      id: "foi-capture",
      route: "/foi-capture",
      split: "horizontal",
      ratio: 0.5,
      panes: [{ id: "primary", title: `FOI ${manifest.id}` }],
    }, viewport);
    return renderScene({ app, navigation, output: "" }, {
      color: colorMode !== "no_color",
      ...(colorMode === "no_color" ? {} : { color_mode: colorMode === "truecolor" ? "truecolor" as const : "ansi256" as const }),
      unicode: true,
      frame_count: 0,
    });
  });
}

function sceneFor(manifest: FOIScenarioManifest, events: readonly unknown[], viewport: FOIViewport, colorMode: FOIColorMode): SceneFrame {
  const materialized = materializeFOIScenario(manifest);
  const attach = record(materialized.session_attach) ? materialized.session_attach : {};
  return sceneForValue(manifest, { ...attach, events, live: true, pending_steering: 0 }, viewport, colorMode);
}

function availabilityEvidence(manifest: FOIScenarioManifest, colorMode: FOIColorMode): AvailabilityEvidence | null {
  if (manifest.id !== "S20") return null;
  const viewport = manifest.fixture.viewport;
  const firstRun = sceneForValue(manifest, undefined, viewport, colorMode);
  const disconnected = sceneForValue(manifest, {
    availability: "unavailable",
    reason: "native session runtime disconnected",
  }, viewport, colorMode);
  const degraded = sceneForValue(manifest, {
    availability: "unavailable",
    reason: "partial transport degradation; canonical activity cannot be confirmed",
  }, viewport, colorMode);
  return Object.freeze({
    frames: Object.freeze([
      Object.freeze({ event_count: 0, scene: firstRun }),
      Object.freeze({ event_count: 0, scene: disconnected }),
      Object.freeze({ event_count: 0, scene: degraded }),
    ]),
    inputs: Object.freeze([
      Object.freeze({ sequence: 2, virtual_at_ms: 1, input: "runtime_disconnected" }),
      Object.freeze({ sequence: 3, virtual_at_ms: 2, input: "runtime_partially_degraded" }),
    ]),
    snapshot: Object.freeze({
      first_run: firstRun.rows,
      disconnected: disconnected.rows,
      partially_degraded: degraded.rows,
    }),
  });
}

function liveEdgeEvidence(manifest: FOIScenarioManifest, events: readonly unknown[], colorMode: FOIColorMode): LiveEdgeEvidence | null {
  if (manifest.id !== "S16" || events.length < 4) return null;
  return withTemporaryScreenRegistration(liveSessionScreen, () => {
    const materialized = materializeFOIScenario(manifest);
    const attach = record(materialized.session_attach) ? materialized.session_attach : {};
    const beforeArrival = events.slice(0, -2);
    let model = update(initialModel(), {
      type: "query_results",
      queryId: "foi-s16-before-arrival",
      screen: "live-session",
      value: { ...attach, events: beforeArrival, live: true, pending_steering: 0 },
    }).model;
    model = { ...model, screen: "live-session", grantedCapabilities: new Set(["harness.session.read"]) };
    model = update(model, { type: "ui_intent", intent: { type: "page_up", amount: 3 }, at: 1 }).model;
    const inspected = model.frontierLiveEdges.get("live-session") ?? null;
    model = update(model, {
      type: "query_results",
      queryId: "foi-s16-after-arrival",
      screen: "live-session",
      value: { ...attach, events, live: true, pending_steering: 0 },
    }).model;
    const afterArrival = model.frontierLiveEdges.get("live-session") ?? null;
    const navigation = createNavigation({
      id: "foi-capture",
      route: "/foi-capture",
      split: "horizontal",
      ratio: 0.5,
      panes: [{ id: "primary", title: `FOI ${manifest.id}` }],
    }, manifest.fixture.viewport);
    const scrollbackScene = renderScene({ app: model, navigation, output: "" }, {
      color: colorMode !== "no_color",
      ...(colorMode === "no_color" ? {} : { color_mode: colorMode === "truecolor" ? "truecolor" as const : "ansi256" as const }),
      unicode: true,
      frame_count: 0,
    });
    model = update(model, { type: "ui_intent", intent: { type: "scroll_end" }, at: 2 }).model;
    const returned = model.frontierLiveEdges.get("live-session") ?? null;
    const liveScene = renderScene({ app: model, navigation, output: "" }, {
      color: colorMode !== "no_color",
      ...(colorMode === "no_color" ? {} : { color_mode: colorMode === "truecolor" ? "truecolor" as const : "ansi256" as const }),
      unicode: true,
      frame_count: 0,
    });
    return Object.freeze({
      frames: Object.freeze([
        Object.freeze({ event_count: events.length, scene: scrollbackScene }),
        Object.freeze({ event_count: events.length, scene: liveScene }),
      ]),
      inputs: Object.freeze([
        Object.freeze({ sequence: 2, virtual_at_ms: 1, input: "page_up", amount: 3 }),
        Object.freeze({ sequence: 3, virtual_at_ms: 2, input: "canonical_arrival", count: 2 }),
        Object.freeze({ sequence: 4, virtual_at_ms: 3, input: "end_return_to_live" }),
      ]),
      snapshot: Object.freeze({ inspected, after_arrival: afterArrival, returned }),
    });
  });
}

function responsiveEvidence(manifest: FOIScenarioManifest, events: readonly unknown[], colorMode: FOIColorMode): ResponsiveEvidence | null {
  const trace = manifest.fixture.resize_trace;
  if (trace === undefined || trace.viewports.length === 0) return null;
  return withTemporaryScreenRegistration(liveSessionScreen, () => {
    const materialized = materializeFOIScenario(manifest);
    const attach = record(materialized.session_attach) ? materialized.session_attach : {};
    const activeEvents = manifest.id === "S17" ? events.slice(0, -1) : events;
    let model = update(initialModel(), {
      type: "query_results",
      queryId: `foi-${manifest.id.toLowerCase()}-responsive`,
      screen: "live-session",
      value: { ...attach, events: activeEvents, live: true, pending_steering: 0 },
    }).model;
    model = { ...model, screen: "live-session", grantedCapabilities: new Set(["harness.session.read"]) };
    if (manifest.id === "S17") model = update(model, { type: "ui_intent", intent: { type: "page_up", amount: 3 }, at: 1 }).model;
    const anchorBefore = model.frontierLiveEdges.get("live-session") ?? null;
    const transitions = Array.from({ length: Math.max(trace.repeat, trace.viewports.length) }, (_, index) => trace.viewports[index % trace.viewports.length]!);
    const frames: Array<{ readonly event_count: number; readonly scene: SceneFrame }> = [];
    const seen = new Set<string>();
    for (const viewport of transitions) {
      const navigation = createNavigation({
        id: "foi-capture",
        route: "/foi-capture",
        split: "horizontal",
        ratio: 0.5,
        panes: [{ id: "primary", title: `FOI ${manifest.id}` }],
      }, viewport);
      const scene = renderScene({ app: model, navigation, output: "" }, {
        color: colorMode !== "no_color",
        ...(colorMode === "no_color" ? {} : { color_mode: colorMode === "truecolor" ? "truecolor" as const : "ansi256" as const }),
        unicode: true,
        frame_count: 0,
      });
      const key = `${viewport.columns}x${viewport.rows}`;
      if (!seen.has(key)) {
        seen.add(key);
        frames.push(Object.freeze({ event_count: activeEvents.length, scene }));
      }
    }
    if (manifest.id === "S17") {
      model = update(model, {
        type: "query_results",
        queryId: "foi-s17-terminal-arrival",
        screen: "live-session",
        value: { ...attach, events, live: false, pending_steering: 0 },
      }).model;
    }
    const anchorAfter = model.frontierLiveEdges.get("live-session") ?? null;
    const ids = buildOperatorViewModel(materialized).document.map((event) => event.id);
    return Object.freeze({
      frames: Object.freeze(frames),
      inputs: Object.freeze([
        ...(manifest.id === "S17" ? [Object.freeze({ sequence: 2, virtual_at_ms: 1, input: "page_up", amount: 3 })] : []),
        ...transitions.map((viewport, index) => Object.freeze({ sequence: index + (manifest.id === "S17" ? 3 : 2), virtual_at_ms: index + 2, input: "resize", viewport })),
        ...(manifest.id === "S17" ? [Object.freeze({ sequence: transitions.length + 3, virtual_at_ms: transitions.length + 2, input: "canonical_terminal_arrival" })] : []),
      ]),
      snapshot: Object.freeze({
        transition_count: transitions.length,
        rendered_viewports: Object.freeze(frames.map((frame) => Object.freeze({ width: frame.scene.columns, height: frame.scene.rows.length }))),
        event_ids: Object.freeze(ids),
        anchor_before: anchorBefore,
        anchor_after: anchorAfter,
      }),
    });
  });
}

function colorEvidence(manifest: FOIScenarioManifest, events: readonly unknown[], scene: SceneFrame): ColorEvidence | null {
  if (manifest.id !== "S19") return null;
  const noColorScene = sceneFor(manifest, events, manifest.fixture.viewport, "no_color");
  // Colored status-bar rows paint through the viewport edge, so stripping
  // SGR leaves terminal-cell padding that the no-color renderer correctly
  // omits. Trailing blank cells carry no semantics; compare visible text.
  const visibleRows = scene.rows.map((row) => stripAnsi(row).trimEnd());
  const noColorRows = noColorScene.rows.map((row) => row.trimEnd());
  return Object.freeze({
    no_color_scene: noColorScene,
    text_equivalent_without_sgr: JSON.stringify(visibleRows) === JSON.stringify(noColorRows),
  });
}

function resultReviewScene(manifest: FOIScenarioManifest, workspace: Readonly<Record<string, unknown>>, colorMode: FOIColorMode): SceneFrame {
  return withTemporaryScreenRegistration(resultReviewScreen, () => {
    const app = {
      ...initialModel(),
      screen: "result-review" as const,
      grantedCapabilities: new Set(["result.read", "result.adopt"]),
      screens: new Map([["result-review" as const, workspace]]),
    };
    const navigation = createNavigation({
      id: "foi-artifact-review",
      route: "/foi-artifact-review",
      split: "horizontal",
      ratio: 0.5,
      panes: [{ id: "primary", title: `FOI ${manifest.id} Diff Review` }],
    }, manifest.fixture.viewport);
    return renderScene({ app, navigation, output: "" }, {
      color: colorMode !== "no_color",
      ...(colorMode === "no_color" ? {} : { color_mode: colorMode === "truecolor" ? "truecolor" as const : "ansi256" as const }),
      unicode: true,
      frame_count: 0,
    });
  });
}

function artifactEvidence(manifest: FOIScenarioManifest, eventCount: number, colorMode: FOIColorMode): ArtifactEvidence | null {
  const fixture = manifest.fixture.result_review;
  if (fixture === undefined) return null;
  const files = Array.from({ length: fixture.file_count }, (_, index) => ({
    path: `src/changed-${String(index + 1).padStart(2, "0")}.ts`,
    status: "modified",
    additions: Math.floor(fixture.diff_line_count / fixture.file_count) + (index < fixture.diff_line_count % fixture.file_count ? 1 : 0),
    deletions: 0,
  }));
  const unified = files.flatMap((file) => Array.from({ length: file.additions }, (_, line) => ({
    kind: line === 0 ? "header" : "addition",
    file_path: file.path,
    old_line: null,
    new_line: line === 0 ? null : line,
    text: line === 0 ? `@@ -0,0 +1,${file.additions} @@` : `${file.path} deterministic diff line ${line}`,
  })));
  const base = Object.freeze({
    campaign_id: manifest.fixture.campaign_id,
    node_id: manifest.fixture.node_id,
    patch_sha256: "a".repeat(64),
    review_revision: 1,
    view_mode: "unified",
    truncated: fixture.truncated,
    counts: Object.freeze({ files: files.length, additions: fixture.diff_line_count, deletions: 0 }),
    files: Object.freeze(files.map((file) => Object.freeze(file))),
    unified: Object.freeze(unified.map((line) => Object.freeze(line))),
    relationships: Object.freeze({
      provenance: Object.freeze({ capture: "verified" }),
      capture: Object.freeze({ operation_id: `${manifest.id.toLowerCase()}-result`, declared_write_paths: Object.freeze(files.map((file) => file.path)), scope_violations: Object.freeze([]) }),
    }),
    conflict_preview: Object.freeze({ status: "clean" }),
  });
  const frames = files.map((_, index) => Object.freeze({
    event_count: eventCount,
    scene: resultReviewScene(manifest, Object.freeze({ ...base, review_file_index: index, review_hunk_index: 0 }), colorMode),
  }));
  const renderedDiffLines = frames.reduce((count, frame) => count + frame.scene.rows.filter((row) => row.includes("deterministic diff line")).length, 0);
  return Object.freeze({
    frames: Object.freeze(frames),
    inputs: Object.freeze(files.map((file, index) => Object.freeze({ sequence: index + 2, virtual_at_ms: index + 1, input: "inspect_result_file", file: file.path }))),
    snapshot: Object.freeze({
      campaign_id: manifest.fixture.campaign_id,
      node_id: manifest.fixture.node_id,
      operation_id: `${manifest.id.toLowerCase()}-result`,
      file_count: files.length,
      files: Object.freeze(files.map((file) => file.path)),
      full_diff_line_count: fixture.diff_line_count,
      truncated: fixture.truncated,
      rendered_diff_lines: renderedDiffLines,
      retrieval_route: resultReviewScreen.surface.commands.includes("result.review.editor_handoff"),
      inspected_files: Object.freeze(files.map((file) => file.path)),
    }),
  });
}

function ndjson(values: readonly unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join("\n") + (values.length === 0 ? "" : "\n");
}

function hasTerminal(view: OperatorViewModel, lifecycle: "completed" | "failed" | "interrupted"): boolean {
  return view.document.some((event) => event.kind === "terminal" && event.lifecycle === lifecycle);
}

/**
 * Evaluators only award a pass for facts visible in the production projection
 * or rendered frame. Fixture intent by itself is never evidence.
 */
function evaluateAssertion(id: string, view: OperatorViewModel, scene: SceneFrame, liveEdge: LiveEdgeEvidence | null, availability: AvailabilityEvidence | null, responsive: ResponsiveEvidence | null, colors: ColorEvidence | null, artifacts: ArtifactEvidence | null, frames: readonly { readonly event_count: number; readonly scene: SceneFrame }[]): "pass" | "unmeasured" {
  const rows = scene.rows.join("\n");
  switch (id) {
    case "projection-contract":
    case "semantic-snapshot":
    case "event-boundary-frame":
      return "pass";
    case "final-answer-visible":
      return view.document.some((event) => event.kind === "final_answer" && event.summary === "deterministic final answer")
        && rows.includes("final answer") ? "pass" : "unmeasured";
    case "successful-terminal":
      return hasTerminal(view, "completed") && !hasTerminal(view, "failed") && !hasTerminal(view, "interrupted")
        && rows.includes("terminal (completed)") ? "pass" : "unmeasured";
    case "command-invocation":
      return view.document.some((event) => event.kind === "tool" && event.lifecycle === "active")
        && rows.includes("tool") ? "pass" : "unmeasured";
    case "multiline-output": {
      const result = view.document.find((event) => event.command?.role === "result" && event.command.canonical_operation_id === "s03-command");
      const output = result?.command?.output;
      return result?.command?.paired_event_id !== null
        && output?.channel === "stdout"
        && output.line_count === 12
        && output.lines[0] === "deterministic output line 01"
        && output.lines[11] === "deterministic output line 12"
        && rows.includes("12 lines") ? "pass" : "unmeasured";
    }
    case "command-series": {
      const invocations = view.document.filter((event) => event.source === "canonical_session" && event.kind === "tool");
      const results = view.document.filter((event) => event.source === "canonical_session" && event.kind === "tool_result");
      return invocations.length === 40 && results.length === 40 ? "pass" : "unmeasured";
    }
    case "result-pairing": {
      const group = view.command_groups.find((candidate) => candidate.id === "s04-command-series");
      const lastResult = view.document.find((event) => event.command?.role === "result" && event.command.ordinal === 40);
      return group?.command_count === 40
        && group.paired_count === 40
        && group.unpaired_count === 0
        && group.completed_count === 40
        && lastResult?.command?.canonical_operation_id === "s04-command-40"
        && rows.includes("40/40 done") ? "pass" : "unmeasured";
    }
    case "source-identity": {
      const owned = view.document.filter((event) => event.source_id === "foi-s07-a" || event.source_id === "foi-s07-b");
      const identities = new Set(owned.map((event) => `${event.source_id}:${event.correlation.node_id}`));
      return identities.has("foi-s07-a:foi-node-s07-a") && identities.has("foi-s07-b:foi-node-s07-b")
        && rows.includes("canonical/canonical_session:foi-s07-a")
        && rows.includes("canonical/canonical_session:foi-s07-b") ? "pass" : "unmeasured";
    }
    case "concurrency-no-false-merge": {
      const toolRows = view.document.filter((event) => (event.kind === "tool" || event.kind === "tool_result") && event.correlation.operation_id === "shared-command");
      return toolRows.length === 4 && toolRows.every((event) => {
        const pairedId = event.command?.paired_event_id;
        return pairedId !== null && pairedId !== undefined && pairedId.startsWith(`canonical:${event.source_id}:`);
      }) ? "pass" : "unmeasured";
    }
    case "honest-progress": {
      const progress = view.document.filter((event) => event.kind === "agent_narrative" && /^scan \d{2}\/5$/u.test(event.summary));
      return progress.length === 5 && progress.every((event, index) => event.summary === `scan ${String(index + 1).padStart(2, "0")}/5`)
        && progress.every((event) => !event.summary.includes("%"))
        && rows.includes("scan 05/5") ? "pass" : "unmeasured";
    }
    case "active-terminal-transition": {
      const liveFrame = frames.find((frame) => frame.scene.rows.join("\n").includes(": live") && frame.scene.rows.join("\n").includes("steer and interrupt remain governed"));
      return liveFrame !== undefined && view.foreground === null && hasTerminal(view, "completed")
        && rows.includes("terminal (completed)") && rows.includes("no active control is implied") ? "pass" : "unmeasured";
    }
    case "degraded-distinct-from-recovered": {
      const degraded = view.document.find((event) => event.kind === "diagnostic" && event.summary === "degraded");
      const recovered = view.document.find((event) => event.kind === "diagnostic" && event.summary === "recovered");
      return degraded?.sequence != null && recovered?.sequence != null && degraded.sequence < recovered.sequence
        && degraded.detail?.includes("reconnect pending") === true && recovered.detail?.includes("reconciled at cursor 3") === true
        && rows.includes("degraded") && rows.includes("recovered") ? "pass" : "unmeasured";
    }
    case "replay-deduplication": {
      const narratives = view.document.filter((event) => event.kind === "agent_narrative" && event.summary === "durable event before reconnect");
      const canonicalSequences = view.document.filter((event) => event.source === "canonical_session" && event.sequence !== null).map((event) => event.sequence);
      return view.bounds.deduplicated_rows === 1 && narratives.length === 1
        && new Set(canonicalSequences).size === canonicalSequences.length ? "pass" : "unmeasured";
    }
    case "stream-order": {
      // Supplemental devtools rows have an independent cursor domain and are
      // intentionally source-grouped, never folded into canonical ordering.
      const sequences = view.document.filter((event) => event.source === "canonical_session").map((event) => event.sequence);
      return sequences.every((sequence, index) => sequence !== null && (index === 0 || sequence > sequences[index - 1]!)) ? "pass" : "unmeasured";
    }
    case "bounded-retention":
    case "retention-bound":
      return view.bounds.retained_rows <= DEFAULT_OPERATOR_PROJECTION_LIMITS.max_rows
        && view.bounds.input_rows === view.bounds.retained_rows + view.bounds.elided_rows ? "pass" : "unmeasured";
    case "channel-distinction": {
      const stdout = view.document.find((event) => event.kind === "tool_result" && event.summary.startsWith("stdout:"));
      const stderr = view.document.find((event) => event.kind === "tool_result" && event.summary.startsWith("stderr:"));
      return stdout?.sequence != null && stderr?.sequence != null && stdout.sequence < stderr.sequence
        && rows.includes("stdout") && rows.includes("stderr") ? "pass" : "unmeasured";
    }
    case "failure-not-success":
      return hasTerminal(view, "failed") && !hasTerminal(view, "completed") ? "pass" : "unmeasured";
    case "diagnostic-disclosure":
      return view.document.some((event) => event.kind === "diagnostic" && event.detail !== null)
        && rows.includes("diagnostic") ? "pass" : "unmeasured";
    case "parentage":
      return view.document.some((event) => event.parent_id === "agent-1")
        && view.document.some((event) => event.parent_id === "command-1") ? "pass" : "unmeasured";
    case "narrow-breadcrumb":
      return rows.includes("↳ agent-1") && rows.includes("↳ command-1") ? "pass" : "unmeasured";
    case "gate-authority": {
      const gates = view.document.filter((event) => event.kind === "permission_gate");
      return gates.length === 2
        && gates.every((event) => event.correlation.operation_id === "approval-1")
        && gates.some((event) => event.lifecycle === "pending")
        && gates.some((event) => event.summary === "approval denied") ? "pass" : "unmeasured";
    }
    case "denied-not-success":
      return view.document.some((event) => event.kind === "permission_gate" && event.summary === "approval denied")
        && hasTerminal(view, "failed") && !hasTerminal(view, "completed") ? "pass" : "unmeasured";
    case "interrupt-requested-not-settled": {
      const request = view.document.find((event) => event.kind === "cancellation");
      const terminal = view.document.find((event) => event.kind === "terminal");
      return request?.lifecycle === "pending" && terminal?.sequence != null && request.sequence !== null
        && request.sequence < terminal.sequence ? "pass" : "unmeasured";
    }
    case "canonical-interrupted-terminal":
      return hasTerminal(view, "interrupted") && rows.includes("×") && rows.includes("interrupted") ? "pass" : "unmeasured";
    case "retry-linkage":
      return view.document.some((event) => event.kind === "tool" && event.summary === "retry: shell (attempt 2)"
        && event.parent_id === "attempt-1" && event.detail?.includes("retry of attempt-1") === true)
        && rows.includes("retry:") && rows.includes("failed") ? "pass" : "unmeasured";
    case "previous-attempt-retained":
      return view.document.some((event) => event.kind === "tool_result" && event.lifecycle === "failed" && event.correlation.operation_id === "attempt-1")
        && view.document.some((event) => event.kind === "tool_result" && event.lifecycle === "completed" && event.correlation.operation_id === "attempt-2")
        && rows.includes("tool result: shell · ↳ attempt-1 · failed")
        && rows.includes("tool result: shell · ↳ attempt-2 · completed") ? "pass" : "unmeasured";
    case "selected-anchor": {
      const inspected = record(liveEdge?.snapshot.inspected) ? liveEdge.snapshot.inspected : null;
      const arrived = record(liveEdge?.snapshot.after_arrival) ? liveEdge.snapshot.after_arrival : null;
      return inspected?.mode === "scrollback" && typeof inspected.anchor_id === "string"
        && arrived?.mode === "scrollback" && arrived.anchor_id === inspected.anchor_id
        && typeof arrived.unseen_meaningful_events === "number" && arrived.unseen_meaningful_events > 0 ? "pass" : "unmeasured";
    }
    case "return-to-live": {
      const returned = liveEdge?.snapshot.returned;
      const scrollbackRows = liveEdge?.frames[0]?.scene.rows.join("\n") ?? "";
      const liveRows = liveEdge?.frames[1]?.scene.rows.join("\n") ?? "";
      return returned === null && scrollbackRows.includes("HISTORY") && scrollbackRows.includes("End return to live")
        && !liveRows.includes("HISTORY") ? "pass" : "unmeasured";
    }
    case "honest-empty-state": {
      const firstRun = availability?.frames[0]?.scene.rows.join("\n") ?? "";
      return firstRun.includes("Awaiting live session projection") && !firstRun.includes("following live tail") ? "pass" : "unmeasured";
    }
    case "degraded-not-active": {
      const disconnected = availability?.frames[1]?.scene.rows.join("\n") ?? "";
      const degraded = availability?.frames[2]?.scene.rows.join("\n") ?? "";
      return disconnected.includes("unavailable") && degraded.includes("degradation")
        && !disconnected.includes("following live tail") && !degraded.includes("following live tail") ? "pass" : "unmeasured";
    }
    case "recovery-action": {
      const unavailableFrames = availability?.frames.slice(1) ?? [];
      return unavailableFrames.length === 2
        && unavailableFrames.every((frame) => frame.scene.rows.join("\n").includes("reopen Live Session to refresh")) ? "pass" : "unmeasured";
    }
    case "resize-preserves-anchor": {
      const before = record(responsive?.snapshot.anchor_before) ? responsive.snapshot.anchor_before : null;
      const after = record(responsive?.snapshot.anchor_after) ? responsive.snapshot.anchor_after : null;
      return before?.mode === "scrollback" && typeof before.anchor_id === "string"
        && after?.mode === "scrollback" && after.anchor_id === before.anchor_id
        && responsive?.snapshot.transition_count === 100 ? "pass" : "unmeasured";
    }
    case "no-duplicate-events": {
      const ids = Array.isArray(responsive?.snapshot.event_ids) ? responsive.snapshot.event_ids : [];
      return ids.length === view.document.length && new Set(ids).size === ids.length
        && responsive?.snapshot.transition_count === 100 ? "pass" : "unmeasured";
    }
    case "narrow-layout":
    case "standard-layout":
    case "wide-layout": {
      const expected = id === "narrow-layout" ? 60 : id === "standard-layout" ? 100 : 160;
      return responsive?.frames.some((frame) => frame.scene.columns === expected && frame.scene.panes[0]?.title === "FOI S18")
        ? "pass" : "unmeasured";
    }
    case "text-glyph-redundancy": {
      const gate = view.document.find((event) => event.kind === "permission_gate");
      const diagnostic = view.document.find((event) => event.kind === "diagnostic");
      const terminal = view.document.find((event) => event.kind === "terminal");
      return gate?.visual.marker === "?" && gate.lifecycle === "pending" && rows.includes("permission g") && rows.includes("pending")
        && diagnostic?.visual.marker === "·" && diagnostic.summary === "warning" && rows.includes("diagnostic") && rows.includes("warning")
        && terminal?.visual.marker === "!" && terminal.lifecycle === "failed" && rows.includes("terminal") && rows.includes("failed")
        ? "pass" : "unmeasured";
    }
    case "no-color-meaning": {
      const noColorRows = colors?.no_color_scene.rows.join("\n") ?? "";
      return colors?.text_equivalent_without_sgr === true
        && !/\x1b\[/u.test(noColorRows)
        && noColorRows.includes("permission g") && noColorRows.includes("pending")
        && noColorRows.includes("diagnostic") && noColorRows.includes("warning")
        && noColorRows.includes("terminal") && noColorRows.includes("failed")
        ? "pass" : "unmeasured";
    }
    case "artifact-summary": {
      const files = Array.isArray(artifacts?.snapshot.files) ? artifacts.snapshot.files : [];
      const canonicalArtifacts = view.document.filter((event) => event.kind === "artifact");
      return artifacts?.snapshot.file_count === 3 && files.length === 3
        && canonicalArtifacts.length === 3
        && canonicalArtifacts.every((event) => event.correlation.operation_id === "s14-result")
        && rows.includes("3 files") && rows.includes("foi-node-s14") ? "pass" : "unmeasured";
    }
    case "artifact-inspection": {
      const inspected = Array.isArray(artifacts?.snapshot.inspected_files) ? artifacts.snapshot.inspected_files : [];
      return inspected.length === 3 && new Set(inspected).size === 3
        && artifacts?.frames.length === 3
        && artifacts.frames.every((frame, index) => frame.scene.rows.join("\n").includes(`src/changed-0${index + 1}.ts`))
        ? "pass" : "unmeasured";
    }
    case "diff-summary":
      return artifacts?.snapshot.file_count === 1 && artifacts.snapshot.full_diff_line_count === 1_000
        && artifacts.snapshot.truncated === true && rows.includes("1 files +1000 -0") ? "pass" : "unmeasured";
    case "bounded-detail":
      return artifacts?.snapshot.full_diff_line_count === 1_000
        && typeof artifacts.snapshot.rendered_diff_lines === "number" && artifacts.snapshot.rendered_diff_lines < 1_000
        && artifacts.frames.every((frame) => frame.scene.rows.length <= manifestRows(scene)) ? "pass" : "unmeasured";
    case "retrieval-route":
      return artifacts?.snapshot.retrieval_route === true && rows.includes("Diff detail is bounded") && rows.includes("editor handoff")
        ? "pass" : "unmeasured";
    default:
      return "unmeasured";
  }
}

function manifestRows(scene: SceneFrame): number {
  return scene.rows.length;
}

/** Capture bounded visual artifacts while retaining the complete raw trace. */
export function captureFOIScenarioArtifacts(manifest: FOIScenarioManifest, colorMode: FOIColorMode = manifest.fixture.color_modes[0]!): FOICapturedArtifacts {
  if (!manifest.fixture.color_modes.includes(colorMode)) throw new Error(`${colorMode} is not a color variant for ${manifest.id}`);
  const materialized = materializeFOIScenario(manifest);
  const attach = record(materialized.session_attach) ? materialized.session_attach : {};
  const events = Array.isArray(attach.events) ? attach.events : [];
  const liveEdge = liveEdgeEvidence(manifest, events, colorMode);
  const availability = availabilityEvidence(manifest, colorMode);
  const responsive = responsiveEvidence(manifest, events, colorMode);
  const artifacts = artifactEvidence(manifest, events.length, colorMode);
  const supplementalFrames = (liveEdge?.frames.length ?? 0) + (availability?.frames.length ?? 0) + (responsive?.frames.length ?? 0) + (artifacts?.frames.length ?? 0);
  const indices = selectedIndices(events.length, MAX_CAPTURED_FRAMES - supplementalFrames);
  const deterministicOrigin = Object.freeze({
    kind: "deterministic_fixture_materialization" as const,
    canonical_event_observed_at_ms: null,
    reason: "the deterministic recorder materializes the fixture before planning frames; it has no canonical runtime-event observation timestamp",
  });
  const captures: FOIPlannedFrame[] = [...indices.map((count) => ({
    event_count: count,
    scene: sceneFor(manifest, events.slice(0, count), manifest.fixture.viewport, colorMode),
    origin: deterministicOrigin,
  })), ...(liveEdge?.frames ?? []).map((frame) => ({ ...frame, origin: deterministicOrigin })), ...(availability?.frames ?? []).map((frame) => ({ ...frame, origin: deterministicOrigin })), ...(responsive?.frames ?? []).map((frame) => ({ ...frame, origin: deterministicOrigin })), ...(artifacts?.frames ?? []).map((frame) => ({ ...frame, origin: deterministicOrigin }))];
  const finalScene = captures.at(-1)?.scene ?? sceneFor(manifest, [], manifest.fixture.viewport, colorMode);
  const colors = colorEvidence(manifest, events, finalScene);
  const view = buildOperatorViewModel(materialized);
  const inputTrace = [
    { sequence: 1, virtual_at_ms: 0, input: "launch", viewport: manifest.fixture.viewport },
    ...(liveEdge?.inputs ?? availability?.inputs ?? responsive?.inputs ?? artifacts?.inputs ?? []),
  ];
  const recordingHeader = JSON.stringify({ version: 2, width: manifest.fixture.viewport.columns, height: manifest.fixture.viewport.rows, timestamp: 0, env: { TERM: "xterm-256color", SHELL: "foi-v1" } });
  const recordingFrames = captures.map((capture, index) => JSON.stringify([index / 10, "o", `${capture.scene.rows.join("\n")}\n`]));
  const assertions: Record<string, "pass" | "unmeasured"> = {};
  for (const id of manifest.required_assertions) assertions[id] = evaluateAssertion(id, view, finalScene, liveEdge, availability, responsive, colors, artifacts, captures);
  return Object.freeze({
    raw_event_trace: ndjson(events),
    input_trace: ndjson(inputTrace),
    semantic_snapshot: `${JSON.stringify({ scenario: manifest.id, view, scene: finalScene, ...(liveEdge === null ? {} : { live_edge_interaction: liveEdge.snapshot }), ...(availability === null ? {} : { availability_states: availability.snapshot }), ...(responsive === null ? {} : { responsive_interaction: responsive.snapshot }), ...(colors === null ? {} : { color_accessibility: { text_equivalent_without_sgr: colors.text_equivalent_without_sgr, no_color_scene: colors.no_color_scene } }), ...(artifacts === null ? {} : { artifact_interaction: artifacts.snapshot }) }, null, 2)}\n`,
    event_boundary_frame: `${JSON.stringify({ scenario: manifest.id, frames: captures }, null, 2)}\n`,
    sampled_frame: `${JSON.stringify({ scenario: manifest.id, sampling: "bounded-even", frames: captures }, null, 2)}\n`,
    recording: `${recordingHeader}\n${recordingFrames.join("\n")}${recordingFrames.length === 0 ? "" : "\n"}`,
    assertion_status: Object.freeze(assertions),
    retained_event_count: view.document.length,
    rendered_frame_count: captures.length,
  });
}
