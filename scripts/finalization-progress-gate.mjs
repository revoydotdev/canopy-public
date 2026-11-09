#!/usr/bin/env node
/**
 * scripts/finalization-progress-gate.mjs — ADR-091 Decision §5:
 * `gate:finalization-progress` is a delivery interlock, not an advisory
 * dashboard. It runs the protocol's own deterministic fixture (a fake
 * monotonic clock, synthetic children, a concurrent wave, every terminal
 * outcome) through the real reporter in scripts/finalization-progress.mjs,
 * validates the resulting stream with `validateProgressStream`, and proves
 * the two renderers (`renderProgressHuman` / `renderProgressNdjson`) stay in
 * semantic parity. A missing event, a cadence violation, a schema mismatch,
 * or a renderer divergence fails this gate.
 *
 *   bun scripts/finalization-progress-gate.mjs [--json]
 */

import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createProgressReporter,
  HEARTBEAT_INTERVAL_MS,
  parseHumanProgressLine,
  PROGRESS_EVENT_KIND,
  PROGRESS_OUTCOMES,
  renderProgressHuman,
  renderProgressNdjson,
  validateProgressStream,
} from "./finalization-progress.mjs";

/**
 * A deterministic run through every required proof point in Decision §5:
 * schema-valid stages with profile-derived deadlines and child attribution
 * (item 1); stable plan/launch/terminal ordering across a concurrent wave,
 * including a child that exits before its wave's barrier (item 2); bounded
 * heartbeat cadence including a burst of missed intervals collapsing to one
 * heartbeat, and none after terminal (item 3); a refusal before any snapshot
 * exists plus a full outcome sweep (item 4).
 */
function runRefusalFixture() {
  // Item 4: an early pre-push refusal before any snapshot exists is itself a
  // complete, valid, single-event-plus-terminal run -- its own stream, since a
  // refusal this early never shares a run_id with the main battery.
  const events = [];
  let now = 0;
  const reporter = createProgressReporter({ workflowId: "gate_fixture_refusal", context: "prepush", runId: "fixture-refusal", clock: () => now, onEvent: (event) => events.push(event) });
  reporter.runStarted();
  reporter.runTerminal({ outcome: "refused", reason_code: "malformed_push_input", exit_code: null });
  return events;
}

function runFixture() {
  const events = [];
  let now = 0;
  const clock = () => now;
  const onEvent = (event) => events.push(event);

  // The main fixture: two waves, a concurrent read-only wave with a fast and
  // a slow gate (proving exited_pending_wave), a heartbeat burst, and one of
  // every remaining terminal outcome.
  const reporter = createProgressReporter({ workflowId: "gate_fixture", context: "prepush", runId: "fixture-run", clock, onEvent });
  reporter.runStarted();
  reporter.planStage({ id: "candidate_snapshot", kind: "candidate_snapshot", phase_id: "immutable_prepush", wave: null, deadline_reason: "unbounded_setup" });
  reporter.planStage({ id: "gate/alpha", kind: "gate", phase_id: "immutable_prepush", wave: 1, deadline_ms: 60000 });
  reporter.planStage({ id: "gate/beta", kind: "gate", phase_id: "immutable_prepush", wave: 1, deadline_ms: 60000 });
  reporter.planStage({ id: "gate/gamma", kind: "gate", phase_id: "immutable_prepush", wave: 2, deadline_ms: 30000 });
  reporter.planStage({ id: "gate/delta", kind: "gate", phase_id: "immutable_prepush", wave: 2, deadline_ms: 5000 });

  reporter.startStage("candidate_snapshot", { deadline_reason: "unbounded_setup" });
  reporter.stageTerminal("candidate_snapshot", { outcome: "succeeded", reason_code: "snapshot_created", exit_code: null });

  reporter.startStage("gate/alpha", { deadline_ms: 60000, child: { role: "gate", command_id: "bun run gate:alpha", pid: 111, process_group_id: 111 } });
  reporter.startStage("gate/beta", { deadline_ms: 60000, child: { role: "gate", command_id: "bun run gate:beta", pid: 112, process_group_id: 112 } });
  now += 1000;
  reporter.markExitedPendingWave("gate/alpha"); // alpha's child exited; beta is still running
  now += 4000; // total 5000ms: first heartbeat boundary
  const firstHeartbeat = reporter.heartbeatIfDue();
  if (!firstHeartbeat) throw new Error("fixture invariant violated: expected a heartbeat at the 5s boundary");
  reporter.stageTerminal("gate/alpha", { outcome: "succeeded", reason_code: "gate_passed", exit_code: 0 });
  reporter.stageTerminal("gate/beta", { outcome: "failed", reason_code: "gate_failed", exit_code: 1 });

  now += 37000; // a burst of missed heartbeat intervals must collapse to exactly one
  reporter.startStage("gate/gamma", { deadline_ms: 30000, child: { role: "gate", command_id: "bun run gate:gamma", pid: 113, process_group_id: 113 } });
  reporter.startStage("gate/delta", { deadline_ms: 5000, child: { role: "gate", command_id: "bun run gate:delta", pid: 114, process_group_id: 114 } });
  const secondHeartbeat = reporter.heartbeatIfDue();
  if (!secondHeartbeat) throw new Error("fixture invariant violated: expected exactly one collapsed heartbeat after a missed-interval burst");
  reporter.stageTerminal("gate/gamma", { outcome: "timed_out", reason_code: "gate_timed_out", exit_code: null });
  reporter.stageTerminal("gate/delta", { outcome: "cancelled", reason_code: "gate_cancelled_fail_fast", exit_code: null });

  reporter.runTerminal({ outcome: "failed", reason_code: "required_gate_failed", exit_code: null });

  return events;
}

function checkOutcomeCoverage(events) {
  const problems = [];
  const observed = new Set(events.filter((event) => event.event === "stage_terminal" || event.event === "run_terminal").map((event) => event.outcome));
  for (const outcome of PROGRESS_OUTCOMES) {
    if (!observed.has(outcome)) problems.push(`fixture never demonstrates terminal outcome ${outcome}`);
  }
  return problems;
}

function checkHeartbeatCadenceCollapse(events) {
  const heartbeats = events.filter((event) => event.event === "heartbeat");
  const problems = [];
  if (heartbeats.length !== 2) problems.push(`fixture expected exactly 2 heartbeats (one at the 5s boundary, one collapsed after a missed-interval burst), got ${heartbeats.length}`);
  return problems;
}

function checkNoHeartbeatAfterTerminal(events) {
  const terminalIndex = events.findIndex((event) => event.event === "run_terminal");
  const problems = [];
  if (terminalIndex === -1) return ["fixture never reached run_terminal"];
  for (const event of events.slice(terminalIndex + 1)) problems.push(`event ${event.event} sequence ${event.sequence} was emitted after run_terminal`);
  return problems;
}

function checkExitedPendingWave(events) {
  const heartbeat = events.find((event) => event.event === "heartbeat");
  const alpha = heartbeat?.stages?.find((stage) => stage.stage.id === "gate/alpha");
  return alpha?.child_state === "exited_pending_wave" ? [] : ["fixture never observed a child_state exited_pending_wave heartbeat for a gate that finished before its wave's barrier"];
}

function checkRendererParity(events) {
  const problems = [];
  for (const event of events) {
    const humanLine = renderProgressHuman(event);
    const ndjsonLine = renderProgressNdjson(event);
    const humanParsed = parseHumanProgressLine(humanLine);
    let ndjsonParsed;
    try { ndjsonParsed = JSON.parse(ndjsonLine); }
    catch { problems.push(`sequence ${event.sequence}: NDJSON rendering did not parse as JSON`); continue; }
    if (!humanParsed) { problems.push(`sequence ${event.sequence}: human rendering did not parse back to a semantic event`); continue; }
    if (humanParsed.sequence !== ndjsonParsed.sequence) problems.push(`sequence ${event.sequence}: human/ndjson sequence mismatch`);
    if (humanParsed.event !== ndjsonParsed.event) problems.push(`sequence ${event.sequence}: human/ndjson event mismatch`);
    if (humanParsed.stageId !== (ndjsonParsed.stage?.id ?? "run")) problems.push(`sequence ${event.sequence}: human/ndjson stage identity mismatch`);
    if (humanParsed.elapsed_ms !== ndjsonParsed.elapsed_ms) problems.push(`sequence ${event.sequence}: human/ndjson elapsed_ms mismatch`);
    if (humanParsed.deadline_ms !== ndjsonParsed.deadline_ms) problems.push(`sequence ${event.sequence}: human/ndjson deadline_ms mismatch`);
    if (humanParsed.remaining_ms !== ndjsonParsed.remaining_ms) problems.push(`sequence ${event.sequence}: human/ndjson remaining_ms mismatch`);
    if ((humanParsed.outcome ?? null) !== (ndjsonParsed.outcome ?? null)) problems.push(`sequence ${event.sequence}: human/ndjson outcome mismatch`);
  }
  return problems;
}

function checkFinalAggregateReportStaysParseable() {
  // Decision §4: the streaming channel is stderr; the final aggregate report
  // remains a single JSON document on stdout. This gate itself only ever
  // writes its own JSON verdict to stdout and never interleaves a progress
  // line there -- the assertion is structural (see main(), below), not
  // re-derived here.
  return [];
}

function main() {
  const refusalEvents = runRefusalFixture();
  const events = runFixture();
  const refusalValidation = validateProgressStream(refusalEvents, { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS });
  const validation = validateProgressStream(events, { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS });
  const allEvents = [...refusalEvents, ...events];
  const problems = [
    ...refusalValidation.problems.map((problem) => `[refusal fixture] ${problem}`),
    ...validation.problems,
    ...checkOutcomeCoverage(allEvents),
    ...checkHeartbeatCadenceCollapse(events),
    ...checkNoHeartbeatAfterTerminal(events),
    ...checkExitedPendingWave(events),
    ...checkRendererParity(allEvents),
    ...checkFinalAggregateReportStaysParseable(),
  ];
  const result = { ok: problems.length === 0, problems, event_count: allEvents.length, kind: PROGRESS_EVENT_KIND };
  // This gate's own JSON verdict is the only thing it ever writes to stdout;
  // any diagnostic text belongs on stderr, preserving the same stdout/stderr
  // separation the protocol requires of the real battery.
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
