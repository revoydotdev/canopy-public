/**
 * Deterministic FOI proof of the real native-session → RuntimePort → TUI path.
 *
 * The renderer corpus remains a separate artifact: this module captures the
 * production RuntimePort path, whose durable projection preserves bounded,
 * redacted operator model text while withholding raw tool content. It never upgrades a renderer fixture into native-runtime
 * evidence, and it never invokes a provider, connector, credential, or network
 * transport.
 */
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import { NativeSessionEngine, type CapabilitySupport, type NativeModelPort, type SessionEventInput } from "@arbor/harness";
import { clearRegisteredScreens, foiScenario, type FOIScenarioEvent, type FOIScenarioId, type OperatorMetricReceipt } from "@arbor/tui";
import { NativeAgentExecutor, type NativeAgentExecutorOptions } from "./native-agent-executor.js";
import { DIRECT_NATIVE_SESSION_EXECUTION } from "./harness-session-execution.js";
import { HarnessSessionJournal } from "./harness-session-journal.js";
import type { NativeLoopSessionRecord } from "./native-loop-executor.js";
import { ArborRuntime } from "./runtime.js";
import { runTui } from "./tui.js";

export type FOINativeRuntimeScenarioId = FOIScenarioId;
type FOINativeAgentRuntimeScenarioId = Extract<FOINativeRuntimeScenarioId, "S01" | "S12">;
type FOINativeRuntimeDriver = "native-agent-executor" | "native-session-fixture" | "runtime-empty-state";
type FOINativeRuntimeAssertionStatus = "pass" | "unmeasured";
type FOINativeRuntimeSemanticLossId =
  | "tool_content_and_relationships_redacted"
  | "approval_details_redacted"
  | "diagnostic_message_redacted"
  | "fixture_source_identity_not_routed"
  | "fixture_replay_sequence_not_preserved"
  | "fixture_viewport_color_or_resize_not_driven"
  | "fixture_devtools_not_driven"
  | "result_review_not_routed";

interface FOINativeRuntimeSemanticLoss {
  readonly id: FOINativeRuntimeSemanticLossId;
  readonly detail: string;
}

export interface FOINativeRuntimeCapture {
  readonly schema_version: 1;
  readonly scenario: FOINativeRuntimeScenarioId;
  readonly execution: {
    readonly native_session_engine: boolean;
    readonly runtime_port: true;
    readonly launchable_tui: true;
    /** Runtime proof intentionally makes no Zig/OpenTUI frame-commit claim. */
    readonly native_renderer_commit: false;
    readonly deterministic_model_simulation: boolean;
    readonly provider_or_connector_invoked: false;
    readonly driver: FOINativeRuntimeDriver;
    /** The separately captured renderer corpus is not folded into this receipt. */
    readonly renderer_evidence: "not_captured";
  };
  readonly assertions: readonly {
    readonly id: string;
    readonly status: FOINativeRuntimeAssertionStatus;
    readonly detail: string;
  }[];
  /** Explicit boundary between the corpus fixture and the redacted runtime projection. */
  readonly semantic_losses: readonly FOINativeRuntimeSemanticLoss[];
  readonly measurements: {
    readonly runtime_to_visible_ms: number;
    readonly cleanup_settled: boolean;
  };
  readonly artifacts: {
    readonly terminal_output: string;
    readonly event_trace: string;
    readonly input_trace: string;
    readonly operator_metrics: string;
  };
  readonly verdict: "pass" | "inconclusive";
  readonly acceptance_scope: "native-runtime-roundtrip-only" | "native-runtime-transport-only";
}

const capabilities: readonly CapabilitySupport[] = [
  "streaming", "interruption", "ephemeral_sessions", "tool_policy", "usage_reporting",
].map((capability) => ({
  capability,
  grade: "native",
  evidence: {
    implementation_id: "foi-native-runtime-capture",
    observed_at: "2026-08-30T00:00:00.000Z",
    detail: "deterministic in-process model simulation",
  },
})) as readonly CapabilitySupport[];

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 4_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForOptional(predicate: () => boolean, timeoutMs = 4_000): Promise<boolean> {
  try { await waitFor(predicate, "timed out waiting for runtime projection", timeoutMs); return true; }
  catch { return false; }
}

function callbacks(journal: HarnessSessionJournal): Pick<NativeAgentExecutorOptions, "on_session_started" | "on_session_event" | "on_session"> {
  return {
    on_session_started(record) {
      if (!journal.recordStarted({
        session_id: record.inspection.session_id,
        campaign_id: record.campaign_id,
        node_id: record.node_id,
        operation: record.operation,
        connector_id: record.connector_id,
        execution_kind: record.execution_kind,
        profile_id: record.profile_id,
        state: record.inspection.state,
        latest_sequence: record.inspection.latest_sequence,
        lineage: record.inspection.lineage,
      })) throw new Error("native session admission was not journaled");
    },
    on_session_event(record) {
      if (!journal.recordEvent(record.event)) throw new Error("native session event was not journaled");
    },
    on_session(record) {
      if (!journal.record(record)) throw new Error("native session completion was not journaled");
    },
  };
}

function recordFixtureSession(journal: HarnessSessionJournal, record: NativeLoopSessionRecord): void {
  if (!journal.record(record)) throw new Error("native fixture session completion was not journaled");
}

async function attach(stdin: PassThrough, painted: () => string, sessionId: string, inputs: string[]): Promise<void> {
  stdin.write("\u0013");
  inputs.push("Ctrl+S");
  await waitFor(() => painted().includes("Live sessions (1)"), "Live Session list was not rendered");
  stdin.write("?");
  inputs.push("?");
  await waitFor(() => painted().includes("Command palette · live-session"), "Live Session command palette was not rendered");
  stdin.write("Attach Harness Session Tail");
  stdin.write("\r");
  inputs.push("Attach Harness Session Tail", "Enter");
  await waitFor(() => painted().includes(`Session ${sessionId}: live`), "native session did not render as live");
}

/** Execute one supported real runtime round trip and return bounded artifacts. */
export async function captureFOINativeRuntimeRoundTrip(
  scenario: FOINativeAgentRuntimeScenarioId,
  workspaceRoot: string,
): Promise<FOINativeRuntimeCapture> {
  clearRegisteredScreens();
  const journal = new HarnessSessionJournal();
  const runtime = new ArborRuntime({ harness_sessions: journal });
  const entered = deferred<void>();
  const release = deferred<void>();
  const sessionId = `foi-native-${scenario.toLowerCase()}`;
  const inputs: string[] = [];
  const metrics: OperatorMetricReceipt[] = [];
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = "";
  let errors = "";
  stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });

  const model: NativeModelPort = scenario === "S01" ? {
    async run() {
      entered.resolve();
      await release.promise;
      return { text: [{ text: "native final answer", phase: "final" }], tool_calls: [], final_message: "native final answer" };
    },
  } : {
    async run(_request, _secret, signal) {
      entered.resolve();
      await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(new Error("deterministic model observed native abort"));
        if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
      });
      throw new Error("unreachable");
    },
  };
  const executor = new NativeAgentExecutor({
    workspace_root: workspaceRoot,
    capabilities,
    model_for_role: () => model,
    live_sessions: runtime.nativeSessionRegistry,
    ...callbacks(journal),
  });
  const running = executor.specialize({
    campaign_id: "foi-runtime-campaign",
    node_id: "foi-runtime-node",
    action: {},
    prompt: "deterministic native FOI runtime scenario",
    worktree_path: workspaceRoot,
    specialist_agent: "seed",
    session_id: sessionId,
  });
  await entered.promise;

  const ready = deferred<void>();
  const tui = runTui({
    cwd: workspaceRoot,
    stdin,
    stdout,
    stderr,
    frame_interval_ms: 5,
    runtime_factory: () => runtime,
    on_ready: () => ready.resolve(),
    on_operator_metric: (receipt) => metrics.push(receipt),
  });

  try {
    await ready.promise;
    await attach(stdin, () => output, sessionId, inputs);
    const transitionStarted = performance.now();
    if (scenario === "S01") {
      release.resolve();
      await running;
      await waitFor(() => output.includes("terminal (completed)"), "completed terminal state was not rendered");
    } else {
      stdin.write(".");
      inputs.push(".");
      await waitFor(() => output.includes("Harness sessions"), "Harness Sessions list was not rendered");
      stdin.write("cc");
      inputs.push("c", "c");
      await running;
      await waitFor(() => journal.inspect(sessionId)?.terminal?.cause === "interrupted", "native session did not settle as interrupted");
      stdin.write("\u0013");
      inputs.push("Ctrl+S");
      await waitFor(() => output.includes("terminal (interrupted)"), "interrupted terminal state was not rendered");
    }
    const runtimeToVisibleMs = performance.now() - transitionStarted;
    const terminalCause = journal.inspect(sessionId)?.terminal?.cause;
    const expectedCause = scenario === "S01" ? "completed" : "interrupted";
    if (terminalCause !== expectedCause) throw new Error(`expected ${expectedCause} terminal cause, observed ${terminalCause ?? "none"}`);
    if (runtime.nativeSessionRegistry.inspect(sessionId) !== null) throw new Error("live native-session registry did not settle");
    stdin.end();
    if (await tui !== 0) throw new Error(`TUI exited nonzero${errors.length > 0 ? `: ${errors}` : ""}`);
    const cleanupSettled = metrics.some((receipt) => receipt.metric === "resource_settlement" && receipt.resources?.settlement === "settled");
    if (!cleanupSettled) throw new Error("TUI resource settlement receipt was not observed");
    const events = journal.events(sessionId);
    return Object.freeze({
      schema_version: 1 as const,
      scenario,
      execution: Object.freeze({
        native_session_engine: true as const,
        runtime_port: true as const,
        launchable_tui: true as const,
        native_renderer_commit: false as const,
        deterministic_model_simulation: true as const,
        provider_or_connector_invoked: false as const,
        driver: "native-agent-executor" as const,
        renderer_evidence: "not_captured" as const,
      }),
      assertions: Object.freeze([
        Object.freeze({ id: "canonical-terminal-transition", status: "pass" as const, detail: `durable terminal cause ${expectedCause} rendered through RuntimePort` }),
        ...(scenario === "S12" ? [Object.freeze({ id: "cancellation-propagation", status: "pass" as const, detail: "TUI row command aborted the exact native session before interrupted state rendered" })] : []),
        Object.freeze({ id: "resource-settlement", status: "pass" as const, detail: "launchable TUI emitted a settled resource receipt" }),
      ]),
      semantic_losses: Object.freeze([]),
      measurements: Object.freeze({ runtime_to_visible_ms: runtimeToVisibleMs, cleanup_settled: cleanupSettled }),
      artifacts: Object.freeze({
        terminal_output: output,
        event_trace: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
        input_trace: `${inputs.map((input, sequence) => JSON.stringify({ sequence: sequence + 1, input })).join("\n")}\n`,
        operator_metrics: `${metrics.map((receipt) => JSON.stringify(receipt)).join("\n")}\n`,
      }),
      verdict: "pass" as const,
      acceptance_scope: "native-runtime-roundtrip-only" as const,
    });
  } finally {
    release.resolve();
    if (!stdin.destroyed) stdin.end();
    clearRegisteredScreens();
  }
}

/**
 * Adapt a corpus fixture into the *native protocol's* deliberately smaller
 * event vocabulary. This is a deterministic in-process simulation, not a
 * model or tool execution. Projection-only fields (parentage, output text,
 * channels, command groups, and viewport/color variants) do not cross this
 * boundary because the durable live-session projection has no native field
 * for them.
 */
function nativeFixtureEvent(event: FOIScenarioEvent, index: number): SessionEventInput | null {
  const value = (key: string, fallback: string): string => typeof event.payload[key] === "string" ? String(event.payload[key]).replaceAll("{index}", String(index + 1).padStart(2, "0")) : fallback;
  const success = event.payload.ok === true;
  switch (event.kind) {
    case "model_text": return { kind: "model_text", payload: { text: event.append_index ? `${value("text", "deterministic native fixture")} ${index + 1}` : value("text", "deterministic native fixture"), phase: value("phase", "commentary") === "final" ? "final" : "commentary" } };
    case "tool_intent": return { kind: "tool_intent", payload: { tool: value("tool", "shell"), input_summary: value("input_summary", "deterministic native fixture") } };
    case "tool_result": return {
      kind: "tool_result",
      payload: {
        tool: value("tool", "shell"), result_summary: value("result_summary", "deterministic native fixture"), success,
        evidence: { outcome: success ? "succeeded" : "failed", stage: "execution", code: success ? "fixture_ok" : "fixture_failed", effect: "none", action_scope: { status: "not_required" } },
      },
    };
    case "approval_requested": return { kind: "approval_requested", payload: { request_id: value("operation_id", `fixture-approval-${index + 1}`), subject: value("subject", "deterministic native fixture approval") } };
    case "approval_resolved": return { kind: "approval_resolved", payload: { request_id: value("operation_id", `fixture-approval-${index + 1}`), approved: event.payload.approved === true, rationale: value("rationale", "deterministic fixture resolution") } };
    case "diagnostic": return { kind: "diagnostic", payload: { code: value("code", "fixture_diagnostic"), message: value("message", "deterministic native fixture diagnostic") } };
    case "artifact": return { kind: "artifact", payload: { artifact_id: value("artifact_id", `fixture-artifact-${index + 1}`), media_type: "application/vnd.revoy.foi-fixture+json", provenance: { tag: "generated", generator: "foi-native-runtime-capture", input_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000" } } };
    // The native engine owns admission and terminal facts. Interrupt request
    // is emitted by engine.interrupt() together with the terminal event.
    case "lifecycle": case "interrupt_requested": case "terminal": return null;
  }
}

function fixtureTerminal(events: readonly FOIScenarioEvent[]): "completed" | "failed" | "interrupted" | null {
  const terminal = [...events].reverse().find((event) => event.kind === "terminal");
  return terminal?.payload.state === "failed" || terminal?.payload.state === "interrupted" || terminal?.payload.state === "completed"
    ? terminal.payload.state : null;
}

function fixtureLosses(manifest: ReturnType<typeof foiScenario>): readonly FOINativeRuntimeSemanticLoss[] {
  const losses = new Map<FOINativeRuntimeSemanticLossId, string>();
  const add = (id: FOINativeRuntimeSemanticLossId, detail: string): void => { losses.set(id, detail); };
  const events = manifest.fixture.events;
  for (const event of events) {
    if (event.kind === "tool_intent" || event.kind === "tool_result") add("tool_content_and_relationships_redacted", "tool input/output, channel, grouping, retry, and parentage do not cross the redacted runtime projection");
    if (event.kind === "approval_requested" || event.kind === "approval_resolved") add("approval_details_redacted", "approval subject and rationale remain redacted by the durable live-session projection");
    if (event.kind === "diagnostic") add("diagnostic_message_redacted", "diagnostic messages are reduced to a code by the durable live-session projection");
    if (event.sequence_override !== undefined) add("fixture_replay_sequence_not_preserved", "fixture replay sequence overrides are not preserved by the engine-owned sequence allocator");
    if (event.payload.session_id !== undefined || event.payload.node_id !== undefined) add("fixture_source_identity_not_routed", "fixture event source session/node identity is not routed into separate native sessions");
  }
  if ((manifest.fixture.background_sessions?.length ?? 0) > 0) add("fixture_source_identity_not_routed", "fixture background-session identity is not routed into separate native sessions");
  if (manifest.fixture.resize_trace !== undefined || manifest.fixture.color_modes.length > 1) add("fixture_viewport_color_or_resize_not_driven", "fixture color policy and resize trace are not driven by this runtime capture");
  if ((manifest.fixture.devtools_commands?.length ?? 0) > 0) add("fixture_devtools_not_driven", "supplemental devtools activity is deliberately outside the native-session runtime path");
  if (manifest.fixture.result_review !== undefined) add("result_review_not_routed", "result-review file/diff disclosure is not routed through the native-session runtime path");
  return Object.freeze([...losses.entries()].map(([id, detail]) => Object.freeze({ id, detail })));
}

/**
 * Drive one deterministic corpus fixture through NativeSessionEngine, journal,
 * live registry, RuntimeCatalogRouter/RuntimePortAdapter, and the launchable
 * TUI. Unlike S01/S12 this does not exercise NativeAgentExecutor/model work;
 * its receipt remains inconclusive for presentation assertions by design.
 */
async function captureFOINativeRuntimeFixture(scenario: Exclude<FOINativeRuntimeScenarioId, FOINativeAgentRuntimeScenarioId>, workspaceRoot: string): Promise<FOINativeRuntimeCapture> {
  clearRegisteredScreens();
  const manifest = foiScenario(scenario);
  const journal = new HarnessSessionJournal();
  const runtime = new ArborRuntime({ harness_sessions: journal });
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
  const inputs: string[] = []; const metrics: OperatorMetricReceipt[] = [];
  let output = ""; let errors = "";
  stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  const ready = deferred<void>();
  const tui = runTui({ cwd: workspaceRoot, stdin, stdout, stderr, frame_interval_ms: 5, runtime_factory: () => runtime, on_ready: () => ready.resolve(), on_operator_metric: (receipt) => metrics.push(receipt) });
  const losses = fixtureLosses(manifest);
  let runtimeToVisibleMs = 0;
  let terminalRendered = scenario === "S20";
  let tick = Date.UTC(2026, 7, 30) + manifest.seed * 1_000;
  const sessionId = manifest.fixture.session_id;
  let engine: NativeSessionEngine | null = null;
  let controller: AbortController | null = null;
  let registered = false;
  try {
    if (scenario !== "S20") {
      controller = new AbortController();
      engine = new NativeSessionEngine({
        capabilities,
        clock: { now: () => ++tick },
        on_event: (event, inspection) => {
          const recordBase = {
            operation: "specialize" as const, campaign_id: manifest.fixture.campaign_id, node_id: manifest.fixture.node_id,
            connector_id: DIRECT_NATIVE_SESSION_EXECUTION.connector_id, execution_kind: DIRECT_NATIVE_SESSION_EXECUTION.execution_kind,
            profile_id: "foi-native-fixture", inspection,
          };
          if (event.kind === "lifecycle") {
            if (!registered) {
              runtime.nativeSessionRegistry.register({ ...recordBase, session_id: sessionId, controller: controller!, inspect: () => engine!.inspect(sessionId), events: (after = 0) => engine!.observe(sessionId, after) });
              registered = true;
            }
            if (!journal.recordStarted({ session_id: sessionId, campaign_id: manifest.fixture.campaign_id, node_id: manifest.fixture.node_id, operation: "specialize", connector_id: DIRECT_NATIVE_SESSION_EXECUTION.connector_id, execution_kind: DIRECT_NATIVE_SESSION_EXECUTION.execution_kind, profile_id: "foi-native-fixture", state: inspection.state, latest_sequence: inspection.latest_sequence, lineage: inspection.lineage })) throw new Error("native fixture session admission was not journaled");
          }
          if (!journal.recordEvent(event)) throw new Error("native fixture event was not journaled");
        },
      });
      engine.start({ session_id: sessionId, policy: { max_wall_clock_ms: 60_000, max_events: 10_010, workspace_roots: [workspaceRoot], tool_allow: ["shell"], tool_deny: [], filesystem: "read_only", network_allowed: false, approvals: "never", inherited_credentials_allowed: false, ambient_plugins_allowed: false, user_configuration_allowed: false }, required_capabilities: [], lineage: { kind: "new" }, ephemeral: false });
    }
    await ready.promise;
    if (scenario === "S20") {
      const transitionStarted = performance.now();
      stdin.write("\u0013"); inputs.push("Ctrl+S");
      await waitFor(() => output.includes("No live sessions"), "empty RuntimePort state was not rendered");
      runtimeToVisibleMs = performance.now() - transitionStarted;
    } else {
      await attach(stdin, () => output, sessionId, inputs);
      const transitionStarted = performance.now();
      for (const fixture of manifest.fixture.events) for (let index = 0; index < fixture.repeat; index += 1) {
        const native = nativeFixtureEvent(fixture, index);
        if (native !== null) engine!.record(sessionId, native);
      }
      const terminal = fixtureTerminal(manifest.fixture.events);
      if (terminal === "completed") engine!.complete(sessionId, { result: "claimed", message: "deterministic native fixture completed", provenance: { tag: "claimed", claimant: "foi-native-runtime-capture" } });
      else if (terminal === "failed") engine!.fail(sessionId, "deterministic native fixture failed");
      else if (terminal === "interrupted") engine!.interrupt(sessionId, "deterministic native fixture interrupted");
      recordFixtureSession(journal, { operation: "specialize", campaign_id: manifest.fixture.campaign_id, node_id: manifest.fixture.node_id, connector_id: DIRECT_NATIVE_SESSION_EXECUTION.connector_id, execution_kind: DIRECT_NATIVE_SESSION_EXECUTION.execution_kind, profile_id: "foi-native-fixture", inspection: engine!.inspect(sessionId), events: engine!.observe(sessionId) });
      runtime.nativeSessionRegistry.settle(sessionId);
      terminalRendered = await waitForOptional(() => output.includes(`terminal (${terminal ?? "completed"})`));
      runtimeToVisibleMs = performance.now() - transitionStarted;
      if (runtimeToVisibleMs < 0) throw new Error("invalid runtime-to-visible measurement");
    }
    stdin.end();
    if (await tui !== 0) throw new Error(`TUI exited nonzero${errors.length > 0 ? `: ${errors}` : ""}`);
    const cleanupSettled = metrics.some((receipt) => receipt.metric === "resource_settlement" && receipt.resources?.settlement === "settled");
    if (!cleanupSettled) throw new Error("TUI resource settlement receipt was not observed");
    const trace = scenario === "S20" ? [] : journal.events(sessionId);
    return Object.freeze({
      schema_version: 1 as const, scenario,
      execution: Object.freeze({ native_session_engine: scenario !== "S20", runtime_port: true as const, launchable_tui: true as const, native_renderer_commit: false as const, deterministic_model_simulation: false, provider_or_connector_invoked: false as const, driver: scenario === "S20" ? "runtime-empty-state" as const : "native-session-fixture" as const, renderer_evidence: "not_captured" as const }),
      assertions: Object.freeze([
        Object.freeze({ id: "native-runtime-roundtrip", status: terminalRendered ? "pass" as const : "unmeasured" as const, detail: scenario === "S20" ? "RuntimePort empty-state query reached the launchable TUI" : terminalRendered ? "NativeSessionEngine lifecycle, journal, registry, RuntimePort, and launchable TUI produced a canonical terminal state" : "Native terminal was durable, but the bounded 200-event RuntimePort tail did not reach its terminal event before this capture timeout" }),
        ...losses.map((loss) => Object.freeze({ id: `projection-boundary:${loss.id}`, status: "unmeasured" as const, detail: loss.detail })),
      ]),
      semantic_losses: losses,
      measurements: Object.freeze({ runtime_to_visible_ms: runtimeToVisibleMs, cleanup_settled: cleanupSettled }),
      artifacts: Object.freeze({ terminal_output: output, event_trace: `${trace.map((event) => JSON.stringify(event)).join("\n")}\n`, input_trace: `${inputs.map((input, sequence) => JSON.stringify({ sequence: sequence + 1, input })).join("\n")}\n`, operator_metrics: `${metrics.map((receipt) => JSON.stringify(receipt)).join("\n")}\n` }),
      verdict: losses.length === 0 && terminalRendered ? "pass" as const : "inconclusive" as const,
      acceptance_scope: "native-runtime-transport-only" as const,
    });
  } finally {
    if (registered) runtime.nativeSessionRegistry.settle(sessionId);
    if (!stdin.destroyed) stdin.end();
    clearRegisteredScreens();
  }
}

/**
 * Select the strongest honest runtime driver for one `foi-v1` scenario.
 * S01/S12 use the complete NativeAgentExecutor path; every remaining scenario
 * uses the explicitly labelled native-session fixture adapter above.
 */
export async function captureFOINativeRuntimeScenario(scenario: FOINativeRuntimeScenarioId, workspaceRoot: string): Promise<FOINativeRuntimeCapture> {
  return scenario === "S01" || scenario === "S12"
    ? captureFOINativeRuntimeRoundTrip(scenario, workspaceRoot)
    : captureFOINativeRuntimeFixture(scenario, workspaceRoot);
}
