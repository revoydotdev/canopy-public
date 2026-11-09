/**
 * Deterministic Frontier Operator Interface (`foi-v1`) scenario and evidence
 * contract.  This is deliberately TUI-owned: it describes fixtures accepted
 * by the existing pure operator projection, rather than becoming a second
 * event bus, task store, recorder, or lifecycle authority.
 *
 * A manifest is a plan for a contract-faithful run.  An evidence receipt is
 * different: it may honestly be inconclusive, but it cannot be a pass until
 * every required assertion and measurement is actually measured and passes.
 */

import type { OperatorProjectionInput } from "./operator-view-model.js";

export const FOI_CORPUS_ID = "foi-v1" as const;
export const FOI_EVIDENCE_SCHEMA_VERSION = 1 as const;
const MAX_FOI_FIXTURE_EVENTS = 10_000;
const MAX_FOI_EVIDENCE_ITEMS = 64;
const MAX_FOI_EVIDENCE_PATH_LENGTH = 240;

export type FOIScenarioId =
  | "S01" | "S02" | "S03" | "S04" | "S05"
  | "S06" | "S07" | "S08" | "S09" | "S10"
  | "S11" | "S12" | "S13" | "S14" | "S15"
  | "S16" | "S17" | "S18" | "S19" | "S20";

export type FOIColorMode = "truecolor" | "ansi256" | "reduced" | "no_color";
export type FOIPresentationContract = "native-session-runtime-port" | "native-session-runtime-port-plus-devtools";
export type FOIEvidenceVerdict = "pass" | "fail" | "inconclusive";
export type FOIEvidenceStatus = "pass" | "fail" | "planned" | "unmeasured";
export type FOIMeasurementStatus = "measured" | "planned" | "unmeasured";

export interface FOIViewport {
  readonly columns: number;
  readonly rows: number;
}

export interface FOIScenarioEvent {
  /** Existing canonical `SessionEvent` kind; no display-only event kinds. */
  readonly kind: "lifecycle" | "model_text" | "tool_intent" | "tool_result" | "approval_requested" | "approval_resolved" | "interrupt_requested" | "diagnostic" | "artifact" | "terminal";
  /** Number of canonical events to emit; bounded by `MAX_FOI_FIXTURE_EVENTS`. */
  readonly repeat: number;
  /** Structural canonical payload, retained only for deterministic test input. */
  readonly payload: Readonly<Record<string, string | number | boolean>>;
  /** Adds a stable suffix to each repeated text payload; it never reads a clock. */
  readonly append_index?: boolean;
  /** Emits an exact replay sequence for recovery tests; ordinary fixtures omit it. */
  readonly sequence_override?: number;
}

export interface FOIResizeTrace {
  readonly repeat: number;
  readonly viewports: readonly FOIViewport[];
}

export interface FOIScenarioFixture {
  readonly session_id: string;
  readonly campaign_id: string;
  readonly node_id: string;
  readonly viewport: FOIViewport;
  readonly color_modes: readonly FOIColorMode[];
  readonly events: readonly FOIScenarioEvent[];
  /** Additional independently identified sessions for concurrency scenarios. */
  readonly background_sessions?: readonly Readonly<{ session_id: string; node_id: string; state: string }>[];
  readonly resize_trace?: FOIResizeTrace;
  /** Supplemental process-local detail is explicit and never canonical truth. */
  readonly devtools_commands?: readonly string[];
  /** Declarative input for the production result-review projection in S14/S15. */
  readonly result_review?: Readonly<{
    file_count: number;
    diff_line_count: number;
    truncated: boolean;
  }>;
}

export interface FOIScenarioManifest {
  readonly id: FOIScenarioId;
  readonly corpus: typeof FOI_CORPUS_ID;
  readonly seed: number;
  /** Fixtures are deterministic simulations, not live-provider evidence. */
  readonly simulation: true;
  readonly story: string;
  readonly presentation_contract: FOIPresentationContract;
  readonly fixture: FOIScenarioFixture;
  /** Required identifiers make omission detectable in an evidence receipt. */
  readonly required_assertions: readonly string[];
}

export interface FOIEvidenceAssertion {
  readonly id: string;
  readonly status: FOIEvidenceStatus;
  /** Relative artifact location or a bounded machine-readable check name. */
  readonly evidence: string;
}

export interface FOIMeasuredValue {
  readonly status: "measured";
  readonly value: number;
  readonly unit: "ms" | "bytes" | "count";
}

export interface FOIUnmeasuredValue {
  readonly status: "planned" | "unmeasured";
  readonly reason: string;
}

export type FOIMetricReceipt = FOIMeasuredValue | FOIUnmeasuredValue;

export interface FOICleanupReceipt {
  readonly status: FOIMeasurementStatus;
  readonly reason?: string;
  readonly subscriptions?: number;
  readonly timers?: number;
  readonly subprocesses?: number;
  readonly handles?: number;
  readonly terminal_mode_residue?: number;
}

export interface FOIEvidenceMeasurements {
  readonly event_to_visible_ms: FOIMetricReceipt;
  readonly input_to_render_ms: FOIMetricReceipt;
  readonly render_ms: FOIMetricReceipt;
  readonly memory_bytes: FOIMetricReceipt;
  readonly queue_high_water: FOIMetricReceipt;
  readonly cleanup: FOICleanupReceipt;
}

export interface FOIEvidenceArtifacts {
  readonly raw_event_trace: string;
  readonly input_trace: string;
  readonly semantic_snapshots: readonly string[];
  readonly event_boundary_frames: readonly string[];
  readonly sampled_frames: readonly string[];
  readonly recording: string;
  readonly checksums: string;
}

export interface FOIScenarioEvidence {
  readonly schema_version: typeof FOI_EVIDENCE_SCHEMA_VERSION;
  readonly run_id: string;
  readonly scenario: {
    readonly id: FOIScenarioId;
    readonly corpus: typeof FOI_CORPUS_ID;
    readonly seed: number;
    readonly simulation: boolean;
    readonly story: string;
    readonly viewport: FOIViewport;
    readonly color_mode: FOIColorMode;
  };
  readonly provenance: {
    readonly source_set: "INDEPENDENT-DESIGN";
    readonly source_exposure: string;
    readonly presentation_contract: FOIPresentationContract;
  };
  readonly execution: {
    readonly command: readonly string[];
    readonly source_revision: string;
    readonly started_at: string;
    readonly finished_at: string;
    readonly virtual_clock: boolean;
    /** A pass must be from the native harness, not a fixture-only run. */
    readonly native_harness: boolean;
  };
  readonly artifacts: FOIEvidenceArtifacts;
  readonly assertions: readonly FOIEvidenceAssertion[];
  readonly measurements: FOIEvidenceMeasurements;
  readonly verdict: FOIEvidenceVerdict;
}

export interface FOIEvidenceValidation {
  /** The receipt has a valid, bounded shape and consistent scenario binding. */
  readonly valid: boolean;
  /** All evidence needed for an honest PASS is present and measured. */
  readonly can_pass: boolean;
  readonly errors: readonly string[];
}

type UnknownRecord = Readonly<Record<string, unknown>>;

const SCENARIO_IDS: readonly FOIScenarioId[] = Object.freeze([
  "S01", "S02", "S03", "S04", "S05", "S06", "S07", "S08", "S09", "S10",
  "S11", "S12", "S13", "S14", "S15", "S16", "S17", "S18", "S19", "S20",
]);

const STANDARD: FOIViewport = Object.freeze({ columns: 100, rows: 30 });
const NARROW: FOIViewport = Object.freeze({ columns: 60, rows: 20 });
const WIDE: FOIViewport = Object.freeze({ columns: 160, rows: 48 });
const ALL_COLORS: readonly FOIColorMode[] = Object.freeze(["truecolor", "ansi256", "reduced", "no_color"]);
const DEFAULT_ASSERTIONS = Object.freeze(["projection-contract", "semantic-snapshot", "event-boundary-frame"]);

function freezeEvent(event: FOIScenarioEvent): FOIScenarioEvent {
  return Object.freeze({ ...event, payload: Object.freeze({ ...event.payload }) });
}

function freezeFixture(fixture: FOIScenarioFixture): FOIScenarioFixture {
  return Object.freeze({
    ...fixture,
    viewport: Object.freeze({ ...fixture.viewport }),
    color_modes: Object.freeze([...fixture.color_modes]),
    events: Object.freeze(fixture.events.map(freezeEvent)),
    ...(fixture.background_sessions === undefined ? {} : {
      background_sessions: Object.freeze(fixture.background_sessions.map((session) => Object.freeze({ ...session }))),
    }),
    ...(fixture.resize_trace === undefined ? {} : {
      resize_trace: Object.freeze({
        repeat: fixture.resize_trace.repeat,
        viewports: Object.freeze(fixture.resize_trace.viewports.map((viewport) => Object.freeze({ ...viewport }))),
      }),
    }),
    ...(fixture.devtools_commands === undefined ? {} : { devtools_commands: Object.freeze([...fixture.devtools_commands]) }),
    ...(fixture.result_review === undefined ? {} : { result_review: Object.freeze({ ...fixture.result_review }) }),
  });
}

function scenario(id: FOIScenarioId, story: string, events: readonly FOIScenarioEvent[], overrides: Partial<Omit<FOIScenarioFixture, "session_id" | "campaign_id" | "node_id" | "events">> = {}, assertions: readonly string[] = DEFAULT_ASSERTIONS): FOIScenarioManifest {
  const fixture = freezeFixture({
    session_id: `foi-${id.toLowerCase()}`,
    campaign_id: "foi-campaign",
    node_id: `foi-node-${id.toLowerCase()}`,
    viewport: overrides.viewport ?? STANDARD,
    color_modes: overrides.color_modes ?? Object.freeze(["truecolor"]),
    events,
    ...(overrides.background_sessions === undefined ? {} : { background_sessions: overrides.background_sessions }),
    ...(overrides.resize_trace === undefined ? {} : { resize_trace: overrides.resize_trace }),
    ...(overrides.devtools_commands === undefined ? {} : { devtools_commands: overrides.devtools_commands }),
    ...(overrides.result_review === undefined ? {} : { result_review: overrides.result_review }),
  });
  return Object.freeze({
    id,
    corpus: FOI_CORPUS_ID,
    seed: Number(id.slice(1)),
    simulation: true,
    story,
    presentation_contract: fixture.devtools_commands === undefined ? "native-session-runtime-port" : "native-session-runtime-port-plus-devtools",
    fixture,
    required_assertions: Object.freeze([...assertions]),
  });
}

const lifecycle = (): FOIScenarioEvent => ({ kind: "lifecycle", repeat: 1, payload: { state: "started" } });
const terminal = (state: "completed" | "failed" | "interrupted"): FOIScenarioEvent => ({ kind: "terminal", repeat: 1, payload: { state, message: `foi ${state}` } });
const text = (repeat = 1, append_index = false): FOIScenarioEvent => ({ kind: "model_text", repeat, append_index, payload: { text: "deterministic streaming response", phase: "commentary" } });
const tool = (ok: boolean, detail: string): readonly FOIScenarioEvent[] => [
  { kind: "tool_intent", repeat: 1, payload: { tool: "shell", input_summary: "deterministic command" } },
  { kind: "tool_result", repeat: 1, payload: { tool: "shell", ok, result_summary: detail } },
];

/** Exactly the required S01–S20 corpus, with fixed seeds and virtual fixtures. */
export const FOI_V1_SCENARIOS: readonly FOIScenarioManifest[] = Object.freeze([
  scenario("S01", "short successful request", [lifecycle(), text(), { kind: "model_text", repeat: 1, payload: { text: "deterministic final answer", phase: "final" } }, terminal("completed")], {}, ["projection-contract", "final-answer-visible", "successful-terminal", "semantic-snapshot", "event-boundary-frame"]),
  scenario("S02", "continuous long response", [lifecycle(), text(1_000, true), terminal("completed")], { devtools_commands: ["stream delta receipt"] }, ["projection-contract", "stream-order", "bounded-retention", "semantic-snapshot", "event-boundary-frame"]),
  scenario("S03", "one command with multiple output lines", [
    lifecycle(),
    { kind: "tool_intent", repeat: 1, payload: { tool: "shell", operation_id: "s03-command", input_summary: "printf '%s\\n' deterministic-line-{01..12}" } },
    { kind: "tool_result", repeat: 1, payload: { tool: "shell", operation_id: "s03-command", parent_id: "s03-command", channel: "stdout", ok: true, result_summary: "deterministic output line 01\ndeterministic output line 02\ndeterministic output line 03\ndeterministic output line 04\ndeterministic output line 05\ndeterministic output line 06\ndeterministic output line 07\ndeterministic output line 08\ndeterministic output line 09\ndeterministic output line 10\ndeterministic output line 11\ndeterministic output line 12" } },
    terminal("completed"),
  ], { devtools_commands: ["printf command-output"] }, ["projection-contract", "command-invocation", "multiline-output", "successful-terminal", "semantic-snapshot", "event-boundary-frame"]),
  scenario("S04", "many short commands under one operation", [
    lifecycle(),
    { kind: "tool_intent", repeat: 40, payload: { tool: "shell", operation_id: "s04-command-{index}", command_group_id: "s04-command-series", input_summary: "printf short-command-{index}" } },
    { kind: "tool_result", repeat: 40, payload: { tool: "shell", operation_id: "s04-command-{index}", command_group_id: "s04-command-series", parent_id: "s04-command-{index}", channel: "stdout", ok: true, result_summary: "short command {index} completed" } },
    terminal("completed"),
  ], { devtools_commands: ["command-1", "command-2", "command-3"] }, ["projection-contract", "command-series", "result-pairing", "successful-terminal", "semantic-snapshot", "event-boundary-frame"]),
  scenario("S05", "command output with ordered stdout and stderr", [lifecycle(), { kind: "tool_intent", repeat: 1, payload: { tool: "shell", input_summary: "deterministic command", operation_id: "command-1" } }, { kind: "tool_result", repeat: 1, payload: { tool: "shell", ok: true, channel: "stdout", result_summary: "deterministic stdout" } }, { kind: "tool_result", repeat: 1, payload: { tool: "shell", ok: false, channel: "stderr", result_summary: "deterministic stderr; exit 1" } }, terminal("failed")], { color_modes: ALL_COLORS, devtools_commands: ["command stdout", "command stderr"] }, ["projection-contract", "channel-distinction", "failure-not-success", "semantic-snapshot", "event-boundary-frame"]),
  scenario("S06", "nested agent, tool, command, output, and result", [lifecycle(), { kind: "model_text", repeat: 1, payload: { text: "parent agent work", phase: "commentary", operation_id: "agent-1" } }, { kind: "tool_intent", repeat: 1, payload: { tool: "shell", input_summary: "nested command", operation_id: "command-1", parent_id: "agent-1" } }, { kind: "tool_result", repeat: 1, payload: { tool: "shell", ok: true, result_summary: "nested result", operation_id: "result-1", parent_id: "command-1" } }, { kind: "model_text", repeat: 1, payload: { text: "nested final", phase: "final", parent_id: "agent-1" } }, terminal("completed")], { viewport: NARROW, devtools_commands: ["nested command"] }, ["projection-contract", "parentage", "narrow-breadcrumb", "semantic-snapshot", "event-boundary-frame"]),
  scenario("S07", "concurrent interleaved work with stable ownership", [
    lifecycle(),
    { kind: "model_text", repeat: 1, payload: { session_id: "foi-s07-a", node_id: "foi-node-s07-a", text: "agent A inspecting routes", phase: "commentary" } },
    { kind: "model_text", repeat: 1, payload: { session_id: "foi-s07-b", node_id: "foi-node-s07-b", text: "agent B inspecting tests", phase: "commentary" } },
    { kind: "tool_intent", repeat: 1, payload: { session_id: "foi-s07-a", node_id: "foi-node-s07-a", tool: "shell", operation_id: "shared-command", input_summary: "agent A command" } },
    { kind: "tool_intent", repeat: 1, payload: { session_id: "foi-s07-b", node_id: "foi-node-s07-b", tool: "shell", operation_id: "shared-command", input_summary: "agent B command" } },
    { kind: "tool_result", repeat: 1, payload: { session_id: "foi-s07-a", node_id: "foi-node-s07-a", tool: "shell", operation_id: "shared-command", ok: true, result_summary: "agent A result" } },
    { kind: "tool_result", repeat: 1, payload: { session_id: "foi-s07-b", node_id: "foi-node-s07-b", tool: "shell", operation_id: "shared-command", ok: true, result_summary: "agent B result" } },
    terminal("completed"),
  ], { background_sessions: [{ session_id: "foi-s07-b", node_id: "foi-node-s07-b", state: "running" }], devtools_commands: ["agent-a command", "agent-b command"] }, ["projection-contract", "source-identity", "concurrency-no-false-merge", "semantic-snapshot", "event-boundary-frame"]),
  scenario("S08", "long-running work with factual progress", [lifecycle(), { kind: "model_text", repeat: 5, payload: { text: "scan {index}/5", phase: "commentary", operation_id: "s08-scan" } }, terminal("completed")], { devtools_commands: ["phase=scan processed=5/5"] }, ["projection-contract", "honest-progress", "active-terminal-transition", "semantic-snapshot", "event-boundary-frame"]),
  scenario("S09", "failure with concise summary and bounded diagnostics", [lifecycle(), ...tool(false, "command failed"), { kind: "diagnostic", repeat: 1, payload: { code: "deterministic_failure", message: "inspectable diagnostic" } }, terminal("failed")], { color_modes: ALL_COLORS }, ["projection-contract", "failure-not-success", "diagnostic-disclosure", "semantic-snapshot", "event-boundary-frame"]),
  scenario("S10", "retry that preserves the previous failed attempt", [
    lifecycle(),
    { kind: "tool_intent", repeat: 1, payload: { tool: "shell", input_summary: "deterministic command", operation_id: "attempt-1", attempt: 1 } },
    { kind: "tool_result", repeat: 1, payload: { tool: "shell", ok: false, result_summary: "attempt one failed", operation_id: "attempt-1", parent_id: "attempt-1" } },
    { kind: "tool_intent", repeat: 1, payload: { tool: "shell", input_summary: "deterministic command", operation_id: "attempt-2", parent_id: "attempt-1", retry_of: "attempt-1", attempt: 2 } },
    { kind: "tool_result", repeat: 1, payload: { tool: "shell", ok: true, result_summary: "attempt two succeeded", operation_id: "attempt-2", parent_id: "attempt-2" } },
    terminal("completed"),
  ], { devtools_commands: ["retry_of=attempt-1"] }, ["projection-contract", "retry-linkage", "previous-attempt-retained", "semantic-snapshot", "event-boundary-frame"]),
  scenario("S11", "permission gate with granted and denied evidence", [lifecycle(), { kind: "approval_requested", repeat: 1, payload: { operation_id: "approval-1", subject: "deterministic approval" } }, { kind: "approval_resolved", repeat: 1, payload: { operation_id: "approval-1", approved: false, rationale: "denied for fixture" } }, terminal("failed")], { color_modes: ALL_COLORS }, ["projection-contract", "gate-authority", "denied-not-success", "semantic-snapshot", "event-boundary-frame"]),
  scenario("S12", "cancellation while stream activity is present", [lifecycle(), text(3, true), { kind: "interrupt_requested", repeat: 1, payload: { reason: "deterministic interrupt" } }, terminal("interrupted")], {}, ["projection-contract", "interrupt-requested-not-settled", "canonical-interrupted-terminal", "semantic-snapshot", "event-boundary-frame"]),
  scenario("S13", "degraded transport followed by reconciliation", [
    lifecycle(),
    { kind: "diagnostic", repeat: 1, payload: { code: "degraded", message: "transport degraded; reconnect pending" } },
    { kind: "model_text", repeat: 1, payload: { text: "durable event before reconnect", phase: "commentary" } },
    { kind: "model_text", repeat: 1, sequence_override: 3, payload: { text: "durable event before reconnect", phase: "commentary" } },
    { kind: "diagnostic", repeat: 1, payload: { code: "recovered", message: "transport recovered; reconciled at cursor 3" } },
    terminal("completed"),
  ], { devtools_commands: ["replay cursor=3"] }, ["projection-contract", "degraded-distinct-from-recovered", "replay-deduplication", "semantic-snapshot", "event-boundary-frame"]),
  scenario("S14", "operation changing multiple files", [lifecycle(), { kind: "artifact", repeat: 3, append_index: true, payload: { artifact_id: "changed-file", operation_id: "s14-result" } }, terminal("completed")], { result_review: { file_count: 3, diff_line_count: 6, truncated: false } }, ["projection-contract", "artifact-summary", "artifact-inspection", "semantic-snapshot", "event-boundary-frame"]),
  scenario("S15", "large diff with progressive disclosure", [lifecycle(), { kind: "artifact", repeat: 1, payload: { artifact_id: "deterministic-1000-line-diff", operation_id: "s15-result" } }, terminal("completed")], { result_review: { file_count: 1, diff_line_count: 1_000, truncated: true } }, ["projection-contract", "diff-summary", "bounded-detail", "retrieval-route", "semantic-snapshot", "event-boundary-frame"]),
  scenario("S16", "long transcript stress and retention", [lifecycle(), text(9_998, true), terminal("completed")], {}, ["projection-contract", "retention-bound", "selected-anchor", "return-to-live", "measurement-receipt", "semantic-snapshot", "event-boundary-frame"]),
  scenario("S17", "resize storm during active streaming", [lifecycle(), text(10, true), terminal("completed")], { resize_trace: { repeat: 100, viewports: [STANDARD, NARROW, WIDE] } }, ["projection-contract", "resize-preserves-anchor", "no-duplicate-events", "semantic-snapshot", "event-boundary-frame"]),
  scenario("S18", "narrow, standard, and wide compositions", [lifecycle(), text(), ...tool(true, "responsive nested result"), terminal("completed")], { viewport: NARROW, resize_trace: { repeat: 1, viewports: [NARROW, STANDARD, WIDE] } }, ["projection-contract", "narrow-layout", "standard-layout", "wide-layout", "semantic-snapshot", "event-boundary-frame"]),
  scenario("S19", "reduced and no-color semantic rendering", [lifecycle(), { kind: "approval_requested", repeat: 1, payload: { subject: "color-independent gate" } }, { kind: "diagnostic", repeat: 1, payload: { code: "warning", message: "color-independent warning" } }, terminal("failed")], { color_modes: ALL_COLORS }, ["projection-contract", "text-glyph-redundancy", "no-color-meaning", "semantic-snapshot", "event-boundary-frame"]),
  scenario("S20", "empty, first-run, disconnected, and partially degraded state", [], {}, ["projection-contract", "honest-empty-state", "degraded-not-active", "recovery-action", "semantic-snapshot", "event-boundary-frame"]),
]);

const scenarioById = new Map(FOI_V1_SCENARIOS.map((item) => [item.id, item] as const));

export function foiScenario(id: FOIScenarioId): FOIScenarioManifest {
  return scenarioById.get(id)!;
}

function assertFixture(manifest: FOIScenarioManifest): void {
  let count = 0;
  for (const event of manifest.fixture.events) {
    if (!Number.isSafeInteger(event.repeat) || event.repeat < 1) throw new Error(`${manifest.id} event repeat must be a positive safe integer`);
    count += event.repeat;
    if (count > MAX_FOI_FIXTURE_EVENTS) throw new Error(`${manifest.id} exceeds the ${MAX_FOI_FIXTURE_EVENTS} event fixture bound`);
  }
  if (!Number.isSafeInteger(manifest.fixture.viewport.columns) || manifest.fixture.viewport.columns < 1 || !Number.isSafeInteger(manifest.fixture.viewport.rows) || manifest.fixture.viewport.rows < 1) {
    throw new Error(`${manifest.id} has an invalid viewport`);
  }
}

/**
 * Materialize a fixture into the existing TUI projection input.  It has a
 * fixed virtual timestamp/sequence and does not manufacture lifecycle facts
 * outside the canonical event fixture.
 */
export function materializeFOIScenario(manifest: FOIScenarioManifest): OperatorProjectionInput {
  assertFixture(manifest);
  const events: Array<Record<string, unknown>> = [];
  let sequence = 0;
  for (const event of manifest.fixture.events) {
    for (let index = 0; index < event.repeat; index += 1) {
      const payload: Record<string, string | number | boolean> = { ...event.payload };
      for (const [key, value] of Object.entries(payload)) {
        if (typeof value === "string" && value.includes("{index}")) payload[key] = value.replaceAll("{index}", String(index + 1).padStart(2, "0"));
      }
      if (event.append_index && typeof payload.text === "string") payload.text = `${payload.text} ${index + 1}`;
      if (event.append_index && typeof payload.input_summary === "string") payload.input_summary = `${payload.input_summary} ${index + 1}`;
      if (event.append_index && typeof payload.result_summary === "string") payload.result_summary = `${payload.result_summary} ${index + 1}`;
      if (event.append_index && typeof payload.artifact_id === "string") payload.artifact_id = `${payload.artifact_id}-${index + 1}`;
      sequence += 1;
      const emittedSequence = event.sequence_override ?? sequence;
      events.push({
        sequence: emittedSequence,
        occurred_at: new Date(Date.UTC(2026, 7, 30) + emittedSequence).toISOString(),
        kind: event.kind,
        payload,
      });
    }
  }
  const devtools = manifest.fixture.devtools_commands;
  const background = manifest.fixture.background_sessions;
  return Object.freeze({
    viewport: Object.freeze({ ...manifest.fixture.viewport }),
    now_ms: manifest.seed * 1_000,
    session_attach: Object.freeze({
      session: Object.freeze({ session_id: manifest.fixture.session_id, campaign_id: manifest.fixture.campaign_id, node_id: manifest.fixture.node_id }),
      events: Object.freeze(events.map((event) => Object.freeze({ ...event, payload: Object.freeze({ ...(event.payload as Record<string, unknown>) }) }))),
    }),
    session_list: Object.freeze({
      sessions: Object.freeze([
        Object.freeze({ session_id: manifest.fixture.session_id, campaign_id: manifest.fixture.campaign_id, node_id: manifest.fixture.node_id, state: "running", terminal: null, pending_steering: 0 }),
        ...(background ?? []).map((session) => Object.freeze({ ...session, campaign_id: manifest.fixture.campaign_id, terminal: null, pending_steering: 0 })),
      ]),
    }),
    selected_session_id: manifest.fixture.session_id,
    ...(devtools === undefined ? {} : {
      devtools_stream: Object.freeze({
        campaign_id: manifest.fixture.campaign_id,
        lines: Object.freeze(devtools.map((command, index) => Object.freeze({
          seq: index + 1,
          ts: `2026-08-30T00:01:${String(index).padStart(2, "0")}.000Z`,
          event_kind: "loop.tool_call",
          campaign_id: manifest.fixture.campaign_id,
          node_id: manifest.fixture.node_id,
          loop_event: Object.freeze({ command }),
        }))),
      }),
    }),
  });
}

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown, maximum = MAX_FOI_EVIDENCE_PATH_LENGTH): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : null;
}

function path(value: unknown): string | null {
  const candidate = string(value);
  return candidate !== null && !candidate.startsWith("/") && !candidate.includes("\\") && !candidate.split("/").includes("..") ? candidate : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function array(value: unknown, maximum = MAX_FOI_EVIDENCE_ITEMS): readonly unknown[] | null {
  return Array.isArray(value) && value.length > 0 && value.length <= maximum ? value : null;
}

function metricCanPass(value: unknown, field: string, errors: string[]): boolean {
  if (!record(value)) {
    errors.push(`${field} measurement is missing`);
    return false;
  }
  if (value.status !== "measured") {
    errors.push(`${field} is ${String(value.status ?? "unmeasured")}, not measured`);
    return false;
  }
  if (finite(value.value) === null || finite(value.value)! < 0 || (value.unit !== "ms" && value.unit !== "bytes" && value.unit !== "count")) {
    errors.push(`${field} measured value is invalid`);
    return false;
  }
  return true;
}

function artifactsAreBounded(value: unknown, errors: string[]): boolean {
  if (!record(value)) {
    errors.push("artifacts is missing");
    return false;
  }
  let valid = true;
  for (const field of ["raw_event_trace", "input_trace", "recording", "checksums"] as const) {
    if (path(value[field]) === null) {
      errors.push(`artifacts.${field} must be a bounded relative path`);
      valid = false;
    }
  }
  for (const field of ["semantic_snapshots", "event_boundary_frames", "sampled_frames"] as const) {
    const values = array(value[field]);
    if (values === null || values.some((item) => path(item) === null)) {
      errors.push(`artifacts.${field} must contain 1-${MAX_FOI_EVIDENCE_ITEMS} bounded relative paths`);
      valid = false;
    }
  }
  return valid;
}

/**
 * Validate an untrusted machine-readable evidence receipt.  `valid` allows
 * an honestly inconclusive record.  `can_pass` is stricter and is required
 * whenever the receipt declares verdict `pass`.
 */
export function validateFOIScenarioEvidence(value: unknown): FOIEvidenceValidation {
  const errors: string[] = [];
  if (!record(value)) return Object.freeze({ valid: false, can_pass: false, errors: Object.freeze(["evidence receipt must be an object"]) });

  let valid = true;
  const fail = (message: string): void => { valid = false; errors.push(message); };
  if (value.schema_version !== FOI_EVIDENCE_SCHEMA_VERSION) fail("schema_version must be 1");
  if (string(value.run_id, 80) === null || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(value.run_id as string)) fail("run_id is invalid");

  const scenarioValue = record(value.scenario) ? value.scenario : null;
  const id = scenarioValue === null || !SCENARIO_IDS.includes(scenarioValue.id as FOIScenarioId) ? null : scenarioValue.id as FOIScenarioId;
  const manifest = id === null ? null : scenarioById.get(id) ?? null;
  if (scenarioValue === null || manifest === null) {
    fail("scenario must name an foi-v1 S01-S20 manifest entry");
  } else {
    if (scenarioValue.corpus !== FOI_CORPUS_ID) fail("scenario.corpus must be foi-v1");
    if (scenarioValue.seed !== manifest.seed || scenarioValue.simulation !== manifest.simulation || scenarioValue.story !== manifest.story) fail("scenario identity does not match its immutable manifest");
    const viewport = record(scenarioValue.viewport) ? scenarioValue.viewport : null;
    if (viewport === null || integer(viewport.columns) === null || integer(viewport.columns)! < 1 || integer(viewport.rows) === null || integer(viewport.rows)! < 1) {
      fail("scenario.viewport must contain positive safe integers");
    } else {
      const allowedViewports = [manifest.fixture.viewport, ...(manifest.fixture.resize_trace?.viewports ?? [])];
      if (!allowedViewports.some((allowed) => allowed.columns === viewport.columns && allowed.rows === viewport.rows)) fail("scenario.viewport is not a manifest variant");
    }
    if (scenarioValue.color_mode !== "truecolor" && scenarioValue.color_mode !== "ansi256" && scenarioValue.color_mode !== "reduced" && scenarioValue.color_mode !== "no_color") {
      fail("scenario.color_mode is invalid");
    } else if (!manifest.fixture.color_modes.includes(scenarioValue.color_mode)) {
      fail("scenario.color_mode is not a manifest variant");
    }
  }

  const provenance = record(value.provenance) ? value.provenance : null;
  if (provenance === null || provenance.source_set !== "INDEPENDENT-DESIGN" || string(provenance.source_exposure) === null) {
    fail("provenance must record INDEPENDENT-DESIGN and bounded source exposure");
  }
  if (provenance !== null && manifest !== null && provenance.presentation_contract !== manifest.presentation_contract) fail("provenance.presentation_contract does not match the manifest");

  const execution = record(value.execution) ? value.execution : null;
  if (execution === null) {
    fail("execution is missing");
  } else {
    const command = array(execution.command);
    if (command === null || command.some((part) => string(part) === null)) fail("execution.command must contain 1-64 bounded strings");
    if (string(execution.source_revision, 128) === null || string(execution.started_at) === null || string(execution.finished_at) === null) fail("execution revision and timestamps are required");
    if (execution.virtual_clock !== true) fail("execution.virtual_clock must be true for foi-v1");
  }
  if (!artifactsAreBounded(value.artifacts, errors)) valid = false;

  const assertionValues = array(value.assertions);
  let assertionsPass = true;
  if (assertionValues === null) {
    fail("assertions must contain 1-64 bounded entries");
    assertionsPass = false;
  } else {
    const seen = new Set<string>();
    for (const assertion of assertionValues) {
      if (!record(assertion) || string(assertion.id, 120) === null || string(assertion.evidence) === null || (assertion.status !== "pass" && assertion.status !== "fail" && assertion.status !== "planned" && assertion.status !== "unmeasured")) {
        fail("assertion is malformed");
        assertionsPass = false;
        continue;
      }
      if (seen.has(assertion.id as string)) {
        fail(`assertion ${assertion.id as string} is duplicated`);
        assertionsPass = false;
      }
      seen.add(assertion.id as string);
      if (assertion.status !== "pass") {
        errors.push(`assertion ${assertion.id as string} is ${assertion.status as string}, not pass`);
        assertionsPass = false;
      }
    }
    if (manifest !== null) for (const required of manifest.required_assertions) {
      if (!seen.has(required)) {
        errors.push(`required assertion ${required} is missing`);
        assertionsPass = false;
      }
    }
  }

  const measurements = record(value.measurements) ? value.measurements : null;
  let measurementsPass = true;
  if (measurements === null) {
    fail("measurements is missing");
    measurementsPass = false;
  } else {
    for (const field of ["event_to_visible_ms", "input_to_render_ms", "render_ms", "memory_bytes", "queue_high_water"] as const) {
      if (!metricCanPass(measurements[field], `measurements.${field}`, errors)) measurementsPass = false;
    }
    const cleanup = record(measurements.cleanup) ? measurements.cleanup : null;
    if (cleanup === null || cleanup.status !== "measured") {
      errors.push("measurements.cleanup is unmeasured, not measured");
      measurementsPass = false;
    } else {
      for (const field of ["subscriptions", "timers", "subprocesses", "handles", "terminal_mode_residue"] as const) {
        const residue = integer(cleanup[field]);
        if (residue === null || residue < 0) {
          errors.push(`measurements.cleanup.${field} is invalid`);
          measurementsPass = false;
        } else if (residue !== 0) {
          errors.push(`measurements.cleanup.${field} is ${residue}, not zero`);
          measurementsPass = false;
        }
      }
    }
  }

  const canPass = valid && assertionsPass && measurementsPass && execution?.native_harness === true;
  if (value.verdict !== "pass" && value.verdict !== "fail" && value.verdict !== "inconclusive") fail("verdict is invalid");
  if (value.verdict === "pass" && !canPass) fail("pass verdict requires every required assertion and measurement to pass from the native harness");
  return Object.freeze({ valid, can_pass: canPass, errors: Object.freeze([...errors]) });
}
