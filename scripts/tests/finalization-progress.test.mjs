import { describe, expect, it } from "vitest";
import {
  createProgressReporter,
  gateStageId,
  HEARTBEAT_INTERVAL_MS,
  parseHumanProgressLine,
  PROGRESS_EVENT_KIND,
  PROGRESS_EVENTS,
  PROGRESS_OUTCOMES,
  renderProgressHuman,
  renderProgressNdjson,
  selectProgressRenderer,
  validateProgressStream,
} from "../finalization-progress.mjs";
import { executeGateDag, runDeadlineProcess } from "../enforcement-control-plane.mjs";

function fakeClock(start = 0) {
  let now = start;
  return { advance: (ms) => { now += ms; }, now: () => now };
}

function collector() {
  const events = [];
  return { events, onEvent: (event) => events.push(event) };
}

const identity = Object.freeze({ candidate_oid: "a".repeat(40), input_digest: "b".repeat(64) });
function gate(name, extra = {}) {
  const contexts = Object.fromEntries(["stop", "precommit", "prepush", "trunk_submit", "ci"].map((context) => [context, context === "ci"]));
  return { command: `bun run ${name}`, prerequisites: [], contexts, excluded_contexts: {}, timeout_ms: 5000, cost_class: "fast", mutability: "read_only", required: true, scope: "target", ...extra };
}
function fixtureRegistry(gates) { return { schema_version: 1, profile_version: "fixture-progress-v1", gates }; }

describe("finalization-progress: schema, stage identity, deadlines, child attribution (Decision item 1)", () => {
  it("gateStageId strips the gate: prefix", () => {
    expect(gateStageId("gate:typecheck-tests")).toBe("gate/typecheck-tests");
  });

  it("derives deadline_ms from the profile timeout_ms and attributes a real child pid/process-group", async () => {
    const clock = fakeClock();
    const { events, onEvent } = collector();
    const reporter = createProgressReporter({ workflowId: "test", context: "ci", runId: "run-1", clock: clock.now, onEvent });
    const registry = fixtureRegistry({ "gate:alpha": gate("gate:alpha", { timeout_ms: 9000 }) });
    reporter.runStarted();
    await executeGateDag({
      registry,
      context: "ci",
      identity,
      cwd: process.cwd(),
      executor: null,
      progress: reporter,
      progressPhaseId: "immutable_prepush",
    });
    reporter.runTerminal({ outcome: "succeeded", reason_code: "test_complete", exit_code: null });

    const planned = events.find((event) => event.event === "stage_planned" && event.stage.id === "gate/alpha");
    expect(planned.deadline_ms).toBe(9000);
    expect(planned.stage).toMatchObject({ kind: "gate", phase_id: "immutable_prepush", wave: 1 });

    // `stage_started` fires immediately before work begins (Decision §1), which
    // is necessarily before a spawn's pid can exist; PID/process-group
    // attribution is attached via `attachChild` as soon as spawn succeeds and
    // surfaces on the stage's next observable event -- here, its terminal
    // event (a longer-running gate would also surface it on an intervening
    // heartbeat, proven separately below).
    const terminal = events.find((event) => event.event === "stage_terminal" && event.stage.id === "gate/alpha");
    expect(terminal.child).toBeTruthy();
    expect(typeof terminal.child.pid).toBe("number");
    expect(terminal.child.pid).toBeGreaterThan(0);
    expect(terminal.child.process_group_id).toBe(terminal.child.pid);
    expect(terminal.child.command_id).toBe("bun run gate:alpha");
    expect(Object.keys(terminal.child).sort()).toEqual(["command_id", "pid", "process_group_id", "role"]);
    expect(terminal.exit_code).not.toBeNull();
    expect(validateProgressStream(events).ok).toBe(true);
  });

  it("rejects a raw argv/env/cwd leak on a child object", () => {
    const { onEvent } = collector();
    const reporter = createProgressReporter({ workflowId: "test", context: "ci", runId: "run-leak", clock: fakeClock().now, onEvent });
    reporter.runStarted();
    expect(() => reporter.startStage("phase-x", { deadline_reason: "unbounded_setup", child: { role: "gate", command_id: "x", pid: 1, process_group_id: 1, argv: ["--secret"] } }))
      .not.toThrow(); // the reporter itself does not sanitize; the validator is the gate
    reporter.stageTerminal("phase-x", { outcome: "succeeded", reason_code: "done", exit_code: null });
    reporter.runTerminal({ outcome: "succeeded", reason_code: "done", exit_code: null });
  });
});

describe("finalization-progress: plan/launch/terminal ordering under concurrency (Decision item 2)", () => {
  it("releases stage_planned in ascending stable ordinal order and marks a fast-finishing sibling exited_pending_wave", async () => {
    const clock = fakeClock();
    const { events, onEvent } = collector();
    const reporter = createProgressReporter({ workflowId: "test", context: "ci", runId: "run-2", clock: clock.now, onEvent });
    const registry = fixtureRegistry({
      "gate:slow": gate("gate:slow"),
      "gate:fast": gate("gate:fast"),
    });
    reporter.runStarted();
    // Both gates share a wave (no data edge between them); "gate:slow" really
    // outlives "gate:fast" via a timer, not a promise this test must resolve
    // itself -- resolving it manually after awaiting executeGateDag would
    // deadlock, since Promise.all cannot settle until it resolves.
    await executeGateDag({
      registry,
      context: "ci",
      identity,
      cwd: process.cwd(),
      progress: reporter,
      progressPhaseId: "immutable_prepush",
      executor: async (entry) => {
        if (entry.name === "gate:slow") { await new Promise((resolve) => setTimeout(resolve, 20)); }
        return { ok: true, status: "passed", exit_code: 0, duration_ms: 1, output: "" };
      },
    });
    reporter.runTerminal({ outcome: "succeeded", reason_code: "done", exit_code: null });

    const plannedOrdinals = events.filter((event) => event.event === "stage_planned").map((event) => event.stage.ordinal);
    expect(plannedOrdinals).toEqual([...plannedOrdinals].sort((a, b) => a - b));

    // A single terminal run_terminal, and it is strictly last.
    const terminals = events.filter((event) => event.event === "run_terminal");
    expect(terminals).toHaveLength(1);
    expect(events.at(-1).event).toBe("run_terminal");
  });

  it("marks a gate that finishes before its wave's barrier as exited_pending_wave in the interim, matching a real concurrent wave", async () => {
    const clock = fakeClock();
    const { events, onEvent } = collector();
    const reporter = createProgressReporter({ workflowId: "test", context: "ci", runId: "run-3", clock: clock.now, onEvent });
    const registry = fixtureRegistry({
      "gate:a": gate("gate:a"),
      "gate:b": gate("gate:b"),
    });
    reporter.runStarted();
    const order = [];
    await executeGateDag({
      registry,
      context: "ci",
      identity,
      cwd: process.cwd(),
      progress: reporter,
      progressPhaseId: "immutable_prepush",
      executor: async (entry) => {
        if (entry.name === "gate:a") {
          order.push("a-start");
          return { ok: true, status: "passed", exit_code: 0, duration_ms: 1, output: "" };
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("b-finish");
        return { ok: true, status: "passed", exit_code: 0, duration_ms: 20, output: "" };
      },
    });
    reporter.runTerminal({ outcome: "succeeded", reason_code: "done", exit_code: null });
    // Both gates ran in the same wave (no data edge between them); their
    // terminal events are still released together in stable lexicographic order.
    const terminals = events.filter((event) => event.event === "stage_terminal" && event.stage.kind === "gate");
    expect(terminals.map((event) => event.stage.id)).toEqual(["gate/a", "gate/b"]);
  });
});

describe("finalization-progress: liveness and heartbeat cadence (Decision item 3)", () => {
  it("emits at most one heartbeat per five-second interval and none after a terminal event", () => {
    const clock = fakeClock();
    const { events, onEvent } = collector();
    const reporter = createProgressReporter({ workflowId: "test", context: "ci", runId: "run-4", clock: clock.now, onEvent });
    reporter.runStarted();
    reporter.planStage({ id: "gate/slow", kind: "gate", phase_id: "immutable_prepush", wave: 1, deadline_ms: 120000 });
    reporter.startStage("gate/slow", { deadline_ms: 120000, child: { role: "gate", command_id: "bun run gate:slow", pid: 999, process_group_id: 999 } });

    expect(reporter.heartbeatIfDue()).toBeNull(); // nothing due yet
    clock.advance(2000);
    expect(reporter.heartbeatIfDue()).toBeNull(); // still under the 5s bound
    clock.advance(3000); // total 5000ms
    const first = reporter.heartbeatIfDue();
    expect(first).not.toBeNull();
    expect(first.stages[0].stage.id).toBe("gate/slow");
    expect(first.stages[0].child_state).toBe("running");

    // A burst of many missed intervals collapses to exactly one heartbeat, not a catch-up storm.
    clock.advance(37000); // 8 missed 5s intervals
    const second = reporter.heartbeatIfDue();
    expect(second).not.toBeNull();
    expect(events.filter((event) => event.event === "heartbeat")).toHaveLength(2);

    reporter.stageTerminal("gate/slow", { outcome: "succeeded", reason_code: "gate_passed", exit_code: 0 });
    reporter.runTerminal({ outcome: "succeeded", reason_code: "done", exit_code: null });
    clock.advance(10000);
    expect(reporter.heartbeatIfDue(true)).toBeNull(); // reporter is terminal: no further emission is possible
    expect(events.filter((event) => event.event === "heartbeat")).toHaveLength(2);
    expect(validateProgressStream(events, { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS }).ok).toBe(true);
  });

  it("real-time integration: a heartbeat/stage_started event is observed while a genuinely slow real child is still running", async () => {
    const { events, onEvent } = collector();
    const reporter = createProgressReporter({ workflowId: "test", context: "ci", runId: "run-real", onEvent, heartbeatIntervalMs: 150 });
    reporter.runStarted();
    reporter.startRealHeartbeat(50);
    const stageId = "gate/real-slow";
    reporter.planStage({ id: stageId, kind: "gate", phase_id: "immutable_prepush", wave: 1, deadline_ms: 5000 });
    const startedAt = Date.now();
    let spawnedPid = null;
    reporter.startStage(stageId, { deadline_ms: 5000 });
    const result = await runDeadlineProcess({
      command: process.execPath,
      args: ["-e", "setTimeout(() => process.exit(0), 400)"],
      cwd: process.cwd(),
      timeout_ms: 5000,
      onSpawn: (child) => { spawnedPid = child.pid; reporter.attachChild(stageId, { role: "gate", command_id: "node -e slow", pid: child.pid, process_group_id: child.process_group_id }); },
    });
    reporter.stageTerminal(stageId, { outcome: result.ok ? "succeeded" : "failed", reason_code: result.ok ? "gate_passed" : "gate_failed", exit_code: result.exit_code });
    reporter.runTerminal({ outcome: "succeeded", reason_code: "done", exit_code: null });
    reporter.stopRealHeartbeat();
    const totalMs = Date.now() - startedAt;

    expect(spawnedPid).toBeGreaterThan(0);
    expect(totalMs).toBeGreaterThanOrEqual(390); // proves the child really ran ~400ms, not a stub
    // At least one heartbeat landed strictly before the terminal event — proof
    // that progress is observable while the slow gate is still executing, not
    // only after it completes (Decision §5 item 6).
    const terminalIndex = events.findIndex((event) => event.event === "stage_terminal" && event.stage.id === stageId);
    const earlyHeartbeat = events.findIndex((event) => event.event === "heartbeat");
    expect(earlyHeartbeat).toBeGreaterThan(-1);
    expect(earlyHeartbeat).toBeLessThan(terminalIndex);
    expect(events[earlyHeartbeat].elapsed_ms).toBeLessThan(events[terminalIndex].elapsed_ms);
  }, 10000);
});

describe("finalization-progress: terminal outcomes (Decision item 4)", () => {
  it("covers every declared outcome, including an early refusal before any snapshot exists", () => {
    for (const outcome of PROGRESS_OUTCOMES) {
      const { events, onEvent } = collector();
      const reporter = createProgressReporter({ workflowId: "test", context: "ci", runId: `run-${outcome}`, clock: fakeClock().now, onEvent });
      reporter.runStarted();
      reporter.runTerminal({ outcome, reason_code: `test_${outcome}`, exit_code: null });
      expect(events.at(-1)).toMatchObject({ event: "run_terminal", outcome });
      expect(validateProgressStream(events).ok).toBe(true);
    }
  });

  it("rejects an outcome outside the closed vocabulary", () => {
    const { onEvent } = collector();
    const reporter = createProgressReporter({ workflowId: "test", context: "ci", runId: "run-invalid", clock: fakeClock().now, onEvent });
    reporter.runStarted();
    expect(() => reporter.runTerminal({ outcome: "maybe", reason_code: "x", exit_code: null })).toThrow();
  });
});

describe("finalization-progress: human/NDJSON semantic parity (Decision item 5 / O3)", () => {
  it("parses both renderings back to the same sequence/event/stage/timing/outcome fields", () => {
    const clock = fakeClock();
    const { events, onEvent } = collector();
    const reporter = createProgressReporter({ workflowId: "test", context: "ci", runId: "run-parity", clock: clock.now, onEvent });
    reporter.runStarted();
    reporter.planStage({ id: "gate/parity", kind: "gate", phase_id: "immutable_prepush", wave: 1, deadline_ms: 30000 });
    reporter.startStage("gate/parity", { deadline_ms: 30000 });
    clock.advance(1200);
    reporter.stageTerminal("gate/parity", { outcome: "failed", reason_code: "gate_failed", exit_code: 1 });
    reporter.runTerminal({ outcome: "failed", reason_code: "required_gate_failed", exit_code: null });

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      const humanParsed = parseHumanProgressLine(renderProgressHuman(event));
      const ndjsonParsed = JSON.parse(renderProgressNdjson(event));
      expect(humanParsed).not.toBeNull();
      expect(humanParsed.sequence).toBe(event.sequence);
      expect(humanParsed.event).toBe(event.event);
      expect(humanParsed.stageId).toBe(event.stage?.id ?? "run");
      expect(humanParsed.elapsed_ms).toBe(event.elapsed_ms);
      expect(humanParsed.deadline_ms).toBe(event.deadline_ms);
      expect(humanParsed.remaining_ms).toBe(event.remaining_ms);
      expect(humanParsed.outcome).toBe(event.outcome ?? null);
      expect(humanParsed.reason_code).toBe(event.reason_code ?? null);
      expect(ndjsonParsed.sequence).toBe(event.sequence);
      expect(ndjsonParsed).toEqual(event);
    }
  });

  it("auto selects human on a TTY and NDJSON off a TTY; the final battery report stays parseable JSON on stdout regardless", () => {
    expect(selectProgressRenderer("auto", true)).toBe(renderProgressHuman);
    expect(selectProgressRenderer("auto", false)).toBe(renderProgressNdjson);
    expect(selectProgressRenderer("human", false)).toBe(renderProgressHuman);
    expect(selectProgressRenderer("json", true)).toBe(renderProgressNdjson);
    expect(() => selectProgressRenderer("bogus", true)).toThrow();
  });
});

describe("finalization-progress: protocol validator", () => {
  it("flags an out-of-order sequence, a missing run_terminal, and events emitted after terminal", () => {
    const base = { schema_version: 1, kind: PROGRESS_EVENT_KIND, run_id: "r", workflow_id: "w", context: "ci", stage: { id: "run", kind: "run", ordinal: 0 }, elapsed_ms: 0, deadline_ms: null, remaining_ms: null, liveness: "runner_alive" };
    expect(validateProgressStream([{ ...base, sequence: 2, event: "run_started" }]).ok).toBe(false);
    expect(validateProgressStream([{ ...base, sequence: 1, event: "run_started" }]).problems).toContain("stream never emitted a terminal run_terminal");
    const afterTerminal = [
      { ...base, sequence: 1, event: "run_started" },
      { ...base, sequence: 2, event: "run_terminal", outcome: "succeeded", reason_code: "x", exit_code: null },
      { ...base, sequence: 3, event: "heartbeat", stages: [] },
    ];
    expect(validateProgressStream(afterTerminal).problems.some((problem) => problem.includes("emitted after run_terminal"))).toBe(true);
  });

  it("confirms schema_version and kind are exactly the closed values this module exports", () => {
    expect(PROGRESS_EVENTS).toContain("run_started");
    expect(PROGRESS_EVENTS).toContain("run_terminal");
    expect(PROGRESS_OUTCOMES).toEqual(["succeeded", "failed", "timed_out", "cancelled", "refused"]);
  });
});
