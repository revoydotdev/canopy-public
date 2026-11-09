#!/usr/bin/env node
/**
 * scripts/finalization-progress.mjs — ADR-091: streaming progress for
 * finalization gates.
 *
 * This is an OBSERVATION protocol, not a second scheduling/timeout/approval
 * authority. `execution-profile.json`, `runDeadlineProcess`, and
 * `executeGateDag` (scripts/enforcement-control-plane.mjs) remain the sole
 * authorities for what runs, for how long, and whether it passed. This module
 * only turns their already-known plan and already-observed child state into a
 * bounded, structured, replayable event stream, and renders that same stream
 * two ways (`renderProgressHuman` / `renderProgressNdjson`) without either
 * renderer deciding independently what is worth showing.
 *
 * `createProgressReporter` takes an injectable `clock` so tests can drive it
 * with a fake monotonic clock instead of real wall-clock time; production
 * callers pass no `clock` and get `Date.now()`.
 */

import { randomUUID } from "node:crypto";

export const PROGRESS_SCHEMA_VERSION = 1;
export const PROGRESS_EVENT_KIND = "revoy2.finalization_progress";
export const HEARTBEAT_INTERVAL_MS = 5000;

/** Closed vocabulary for schema version 1 (Decision §2). */
export const PROGRESS_EVENTS = Object.freeze([
  "run_started",
  "stage_planned",
  "stage_started",
  "heartbeat",
  "stage_terminal",
  "run_terminal",
]);

/** Terminal outcomes a `stage_terminal`/`run_terminal` event may carry (Decision §2). */
export const PROGRESS_OUTCOMES = Object.freeze(["succeeded", "failed", "timed_out", "cancelled", "refused"]);

const ALLOWED_CHILD_KEYS = Object.freeze(["role", "command_id", "pid", "process_group_id"]);
const FORBIDDEN_CHILD_KEYS = Object.freeze(["argv", "args", "env", "environment", "cwd", "credentials", "stdout", "stderr"]);

/** `gate:typecheck-tests` -> `gate/typecheck-tests` (Decision §1). */
export function gateStageId(gateName) {
  return `gate/${String(gateName).replace(/^gate:/, "")}`;
}

function stageProjection(stage) {
  return Object.freeze({
    id: stage.id,
    kind: stage.kind,
    ordinal: stage.ordinal,
    phase_id: stage.phase_id ?? null,
    wave: stage.wave ?? null,
  });
}

/**
 * Builds one bounded, sequenced event stream for a single finalization/pre-push
 * run. The reporter owns the only sequence counter and the only heartbeat
 * cadence decision; callers describe what happened, the reporter decides what
 * (and when) that becomes a numbered event.
 */
export function createProgressReporter({
  workflowId,
  context,
  runId = randomUUID(),
  clock = () => Date.now(),
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
  onEvent,
}) {
  if (typeof onEvent !== "function") throw new Error("createProgressReporter requires an onEvent sink");
  const startedAt = clock();
  let sequence = 0;
  let terminal = false;
  let heartbeatBaseline = startedAt;
  const stages = new Map();
  let realTimer = null;

  function elapsedSince(t0) {
    return Math.max(0, Math.round(clock() - t0));
  }

  function release(event, extra) {
    if (terminal) throw new Error(`finalization progress reporter: cannot emit ${event} after run_terminal has been released`);
    sequence += 1;
    const full = Object.freeze({
      schema_version: PROGRESS_SCHEMA_VERSION,
      kind: PROGRESS_EVENT_KIND,
      run_id: runId,
      sequence,
      event,
      workflow_id: workflowId,
      context,
      elapsed_ms: elapsedSince(startedAt),
      ...extra,
    });
    onEvent(full);
    if (event === "run_terminal") terminal = true;
    return full;
  }

  const RUN_STAGE = Object.freeze({ id: "run", kind: "run", ordinal: 0, phase_id: null, wave: null });

  function runStarted() {
    return release("run_started", {
      stage: RUN_STAGE,
      deadline_ms: null,
      remaining_ms: null,
      deadline_reason: "unbounded_setup",
      liveness: "runner_alive",
    });
  }

  /**
   * stage: {id, kind, phase_id, wave, deadline_ms?, deadline_reason?}. `ordinal`
   * is always assigned here from call order (`stages.size`), never taken from
   * the caller: that is what keeps ordinals globally monotonic and collision-free
   * when several callers (finalize.mjs's phases, executeGateDag's gates) plan
   * stages into one shared reporter.
   */
  function planStage(stage) {
    if (!stage || typeof stage.id !== "string" || stage.id.length === 0) throw new Error("planStage requires a stable stage.id");
    const existing = stages.get(stage.id);
    const record = { ...stage, ordinal: existing?.ordinal ?? stages.size + 1, status: "planned", child: null, startedAt: null, exitedPendingWave: false, stdoutBytes: 0, stderrBytes: 0 };
    stages.set(stage.id, record);
    return release("stage_planned", {
      stage: stageProjection(record),
      deadline_ms: record.deadline_ms ?? null,
      remaining_ms: record.deadline_ms ?? null,
      ...(record.deadline_ms == null ? { deadline_reason: record.deadline_reason ?? "unbounded_setup" } : {}),
      liveness: "runner_alive",
    });
  }

  function requireStage(id, kindFallback = "phase") {
    let stage = stages.get(id);
    if (!stage) {
      stage = { id, kind: kindFallback, ordinal: stages.size + 1, phase_id: null, wave: null, status: "planned", child: null, startedAt: null, exitedPendingWave: false, stdoutBytes: 0, stderrBytes: 0 };
      stages.set(id, stage);
    }
    return stage;
  }

  function startStage(id, { deadline_ms = null, deadline_reason = null, child = null, kind = "phase" } = {}) {
    const stage = requireStage(id, kind);
    stage.status = "active";
    stage.startedAt = clock();
    stage.deadline_ms = deadline_ms ?? stage.deadline_ms ?? null;
    stage.deadline_reason = stage.deadline_ms == null ? (deadline_reason ?? stage.deadline_reason ?? "unbounded_setup") : null;
    stage.child = child ? Object.freeze({ ...child }) : null;
    stages.set(id, stage);
    const elapsed = elapsedSince(stage.startedAt);
    return release("stage_started", {
      stage: stageProjection(stage),
      deadline_ms: stage.deadline_ms,
      remaining_ms: stage.deadline_ms == null ? null : Math.max(0, stage.deadline_ms - elapsed),
      ...(stage.deadline_ms == null ? { deadline_reason: stage.deadline_reason } : {}),
      liveness: "runner_alive",
      ...(stage.child ? { child: stage.child } : {}),
    });
  }

  /** Attaches child identity after `startStage` when a spawn only succeeds slightly later. */
  function attachChild(id, child) {
    const stage = stages.get(id);
    if (!stage) return;
    stage.child = Object.freeze({ ...child });
    stages.set(id, stage);
  }

  function observeChildBytes(id, { stdout = 0, stderr = 0 } = {}) {
    const stage = stages.get(id);
    if (!stage) return;
    stage.stdoutBytes = (stage.stdoutBytes ?? 0) + stdout;
    stage.stderrBytes = (stage.stderrBytes ?? 0) + stderr;
    stages.set(id, stage);
  }

  /** A child of a still-open wave exited; the terminal event is deliberately withheld until the wave barrier (Decision §2). */
  function markExitedPendingWave(id) {
    const stage = stages.get(id);
    if (!stage) return;
    stage.exitedPendingWave = true;
    stages.set(id, stage);
  }

  function activeStages() {
    return [...stages.values()].filter((stage) => stage.status === "active").sort((a, b) => a.ordinal - b.ordinal);
  }

  /**
   * Emits at most one aggregate heartbeat per elapsed interval, for the whole
   * run (Decision §3). Skips missed intervals instead of bursting catch-up
   * heartbeats. Returns null when no heartbeat was due (or none is warranted).
   */
  function heartbeatIfDue(force = false) {
    if (terminal) return null;
    const now = clock();
    if (!force && now - heartbeatBaseline < heartbeatIntervalMs) return null;
    const missed = Math.floor((now - heartbeatBaseline) / heartbeatIntervalMs);
    if (missed >= 1) heartbeatBaseline += missed * heartbeatIntervalMs;
    else if (force) heartbeatBaseline = now;
    const active = activeStages();
    if (active.length === 0 && !force) return null;
    const stagesReport = active.map((stage) => {
      const elapsed = elapsedSince(stage.startedAt ?? startedAt);
      const remaining = stage.deadline_ms == null ? null : Math.max(0, stage.deadline_ms - elapsed);
      return Object.freeze({
        stage: stageProjection(stage),
        elapsed_ms: elapsed,
        deadline_ms: stage.deadline_ms,
        remaining_ms: remaining,
        child_state: stage.exitedPendingWave ? "exited_pending_wave" : stage.child ? "running" : null,
        child: stage.child ?? null,
        stdout_bytes: stage.stdoutBytes ?? 0,
        stderr_bytes: stage.stderrBytes ?? 0,
      });
    });
    return release("heartbeat", {
      stage: RUN_STAGE,
      deadline_ms: null,
      remaining_ms: null,
      liveness: "runner_alive",
      stages: Object.freeze(stagesReport),
    });
  }

  function stageTerminal(id, { outcome, reason_code, exit_code = null, child = null } = {}) {
    if (!PROGRESS_OUTCOMES.includes(outcome)) throw new Error(`stageTerminal: invalid outcome ${outcome}`);
    const stage = requireStage(id);
    const elapsed = elapsedSince(stage.startedAt ?? startedAt);
    stage.status = "terminal";
    stage.exitedPendingWave = false;
    if (child) stage.child = Object.freeze({ ...child });
    stages.set(id, stage);
    return release("stage_terminal", {
      stage: stageProjection(stage),
      deadline_ms: stage.deadline_ms ?? null,
      remaining_ms: stage.deadline_ms == null ? null : Math.max(0, stage.deadline_ms - elapsed),
      liveness: "runner_alive",
      outcome,
      reason_code,
      exit_code,
      ...(stage.child ? { child: stage.child } : {}),
    });
  }

  /** Exactly one per run, including a refusal or a setup failure before any gate executed (Decision §2). */
  function runTerminal({ outcome, reason_code, exit_code = null }) {
    if (!PROGRESS_OUTCOMES.includes(outcome)) throw new Error(`runTerminal: invalid outcome ${outcome}`);
    return release("run_terminal", {
      stage: RUN_STAGE,
      deadline_ms: null,
      remaining_ms: null,
      liveness: "runner_alive",
      outcome,
      reason_code,
      exit_code,
    });
  }

  /** Real-time production use only: a fake-clock test drives `heartbeatIfDue` manually instead. */
  function startRealHeartbeat(pollMs = 1000) {
    if (realTimer || terminal) return;
    realTimer = setInterval(() => {
      try { heartbeatIfDue(false); } catch { /* reporter already terminal; nothing more to emit */ }
    }, pollMs);
    realTimer.unref?.();
  }

  function stopRealHeartbeat() {
    if (realTimer) { clearInterval(realTimer); realTimer = null; }
  }

  return Object.freeze({
    runId,
    runStarted,
    planStage,
    startStage,
    attachChild,
    observeChildBytes,
    markExitedPendingWave,
    heartbeatIfDue,
    stageTerminal,
    runTerminal,
    startRealHeartbeat,
    stopRealHeartbeat,
    get sequenceCount() { return sequence; },
    get isTerminal() { return terminal; },
  });
}

/** Human rendering: one line, exposing exactly the fields Decision §4 requires. */
export function renderProgressHuman(event) {
  const stageId = event.stage?.id ?? "run";
  const parts = [
    `#${event.sequence}`,
    event.event,
    stageId,
    `elapsed=${event.elapsed_ms}ms`,
    `deadline=${event.deadline_ms == null ? "null" : `${event.deadline_ms}ms`}`,
    `remaining=${event.remaining_ms == null ? "null" : `${event.remaining_ms}ms`}`,
  ];
  if (event.outcome) parts.push(`outcome=${event.outcome}`);
  if (event.reason_code) parts.push(`reason=${event.reason_code}`);
  return parts.join(" ");
}

const HUMAN_LINE_RE =
  /^#(\d+) (\S+) (\S+) elapsed=(\d+)ms deadline=(null|\d+ms) remaining=(null|\d+ms)(?: outcome=(\S+))?(?: reason=(\S+))?$/;

/** The inverse of `renderProgressHuman`, used only to prove human/NDJSON semantic parity (Decision §4/O3). */
export function parseHumanProgressLine(line) {
  const match = HUMAN_LINE_RE.exec(line);
  if (!match) return null;
  const [, sequence, event, stageId, elapsed, deadline, remaining, outcome, reason_code] = match;
  return Object.freeze({
    sequence: Number(sequence),
    event,
    stageId,
    elapsed_ms: Number(elapsed),
    deadline_ms: deadline === "null" ? null : Number(deadline.replace("ms", "")),
    remaining_ms: remaining === "null" ? null : Number(remaining.replace("ms", "")),
    outcome: outcome ?? null,
    reason_code: reason_code ?? null,
  });
}

/** NDJSON rendering: the semantic event object itself, one JSON document per line, no reformatting. */
export function renderProgressNdjson(event) {
  return JSON.stringify(event);
}

/** `auto`: human on an interactive TTY, NDJSON otherwise (Decision §4). */
export function selectProgressRenderer(mode, isTTY) {
  if (mode === "human") return renderProgressHuman;
  if (mode === "json") return renderProgressNdjson;
  if (mode !== "auto") throw new Error(`unknown --progress mode ${mode}`);
  return isTTY ? renderProgressHuman : renderProgressNdjson;
}

function childProblems(child, where) {
  if (child == null) return [];
  const problems = [];
  if (typeof child !== "object") return [`${where}: child must be an object`];
  for (const key of Object.keys(child)) {
    if (FORBIDDEN_CHILD_KEYS.includes(key)) problems.push(`${where}: child leaks forbidden field ${key}`);
    if (!ALLOWED_CHILD_KEYS.includes(key)) problems.push(`${where}: child has unrecognized field ${key}`);
  }
  return problems;
}

/**
 * Validates one already-released event stream against Decision §1-§4. This is
 * the "protocol validator" `gate:finalization-progress` (Decision §5) runs
 * against a fixture stream, and the same function a future replay/log reader
 * can reuse to reject a corrupted or hand-edited stream.
 */
export function validateProgressStream(events, { heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS, gateDeadlines = null } = {}) {
  const problems = [];
  if (!Array.isArray(events) || events.length === 0) return Object.freeze({ ok: false, problems: ["event stream is empty"] });

  let runId = null;
  let expectedSequence = 1;
  let sawRunStarted = false;
  let sawRunTerminal = false;
  let lastHeartbeatElapsed = null;
  const plannedOrdinals = [];
  const openStages = new Map();

  for (const [index, event] of events.entries()) {
    const where = `event[${index}] (sequence ${event?.sequence})`;
    if (sawRunTerminal) { problems.push(`${where}: emitted after run_terminal`); continue; }
    if (!event || typeof event !== "object") { problems.push(`${where}: not an object`); continue; }
    if (event.schema_version !== PROGRESS_SCHEMA_VERSION) problems.push(`${where}: schema_version must be ${PROGRESS_SCHEMA_VERSION}`);
    if (event.kind !== PROGRESS_EVENT_KIND) problems.push(`${where}: kind must be ${PROGRESS_EVENT_KIND}`);
    if (typeof event.run_id !== "string" || event.run_id.length === 0) problems.push(`${where}: run_id must be a non-empty string`);
    else if (runId === null) runId = event.run_id;
    else if (event.run_id !== runId) problems.push(`${where}: run_id ${event.run_id} does not match stream run_id ${runId}`);
    if (!Number.isInteger(event.sequence) || event.sequence <= 0) problems.push(`${where}: sequence must be a positive integer`);
    else if (event.sequence !== expectedSequence) problems.push(`${where}: sequence ${event.sequence} is not strictly increasing from ${expectedSequence}`);
    expectedSequence = (event.sequence ?? expectedSequence) + 1;
    if (!PROGRESS_EVENTS.includes(event.event)) problems.push(`${where}: unknown event ${event.event}`);
    if (typeof event.workflow_id !== "string" || event.workflow_id.length === 0) problems.push(`${where}: workflow_id required`);
    if (typeof event.context !== "string" || event.context.length === 0) problems.push(`${where}: context required`);
    if (!event.stage || typeof event.stage.id !== "string") problems.push(`${where}: stage.id required`);
    if (!Number.isInteger(event.elapsed_ms) || event.elapsed_ms < 0) problems.push(`${where}: elapsed_ms must be a non-negative integer`);
    if (event.deadline_ms !== null && !(Number.isFinite(event.deadline_ms) && event.deadline_ms >= 0)) problems.push(`${where}: deadline_ms must be null or a non-negative number`);
    if (event.remaining_ms !== null && !(Number.isFinite(event.remaining_ms) && event.remaining_ms >= 0)) problems.push(`${where}: remaining_ms must be null or a non-negative number`);
    if ((event.deadline_ms === null) !== (event.remaining_ms === null)) problems.push(`${where}: deadline_ms and remaining_ms must be null together`);
    if (event.deadline_ms === null && ["stage_planned", "stage_started"].includes(event.event) && typeof event.deadline_reason !== "string") {
      problems.push(`${where}: an unbounded stage requires deadline_reason`);
    }
    if (typeof event.liveness !== "string") problems.push(`${where}: liveness required`);
    problems.push(...childProblems(event.child, where));

    if (event.event === "run_started") {
      if (sawRunStarted) problems.push(`${where}: multiple run_started events`);
      sawRunStarted = true;
    }
    if (event.event === "stage_planned") {
      plannedOrdinals.push(event.stage?.ordinal ?? -1);
    }
    if (event.event === "stage_started") {
      openStages.set(event.stage?.id, event);
      if (gateDeadlines && event.stage?.kind === "gate") {
        const expected = gateDeadlines[event.stage.id] ?? null;
        if (expected !== null && event.deadline_ms !== expected) {
          problems.push(`${where}: gate deadline_ms ${event.deadline_ms} does not match execution profile timeout_ms ${expected} for ${event.stage.id}`);
        }
      }
    }
    if (event.event === "stage_terminal") {
      if (!PROGRESS_OUTCOMES.includes(event.outcome)) problems.push(`${where}: stage_terminal outcome must be one of ${PROGRESS_OUTCOMES.join(", ")}`);
      if (typeof event.reason_code !== "string" || event.reason_code.length === 0) problems.push(`${where}: stage_terminal requires reason_code`);
      if (!("exit_code" in event)) problems.push(`${where}: stage_terminal requires an exit_code key (null when unobservable)`);
      openStages.delete(event.stage?.id);
    }
    if (event.event === "heartbeat") {
      if (!Array.isArray(event.stages)) problems.push(`${where}: heartbeat requires a stages array`);
      else for (const stage of event.stages) problems.push(...childProblems(stage.child, `${where} heartbeat stage ${stage?.stage?.id}`));
      if (lastHeartbeatElapsed !== null && event.elapsed_ms - lastHeartbeatElapsed < heartbeatIntervalMs) {
        problems.push(`${where}: heartbeat cadence violation, only ${event.elapsed_ms - lastHeartbeatElapsed}ms since the previous heartbeat (bound is ${heartbeatIntervalMs}ms)`);
      }
      lastHeartbeatElapsed = event.elapsed_ms;
    }
    if (event.event === "run_terminal") {
      if (!PROGRESS_OUTCOMES.includes(event.outcome)) problems.push(`${where}: run_terminal outcome must be one of ${PROGRESS_OUTCOMES.join(", ")}`);
      if (typeof event.reason_code !== "string" || event.reason_code.length === 0) problems.push(`${where}: run_terminal requires reason_code`);
      if (!("exit_code" in event)) problems.push(`${where}: run_terminal requires an exit_code key (null when unobservable)`);
      sawRunTerminal = true;
    }
  }

  if (!sawRunStarted) problems.push("stream never emitted run_started");
  if (!sawRunTerminal) problems.push("stream never emitted a terminal run_terminal");
  for (let index = 1; index < plannedOrdinals.length; index += 1) {
    if (plannedOrdinals[index] < plannedOrdinals[index - 1]) problems.push("stage_planned events were not released in ascending profile-derived ordinal order");
  }
  for (const id of openStages.keys()) problems.push(`stage ${id} started but never reached a stage_terminal before run_terminal`);

  return Object.freeze({ ok: problems.length === 0, problems: Object.freeze(problems) });
}
