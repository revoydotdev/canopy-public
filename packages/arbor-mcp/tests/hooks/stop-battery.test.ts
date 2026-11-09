/**
 * The native replacement for `scripts/hooks/gate-stop.sh` + its no-progress
 * circuit breaker `scripts/hooks/stop-guard.mjs`.
 *
 * The eight properties asserted here are the eight ways this guard can be
 * silently wrong, and each one is a defect class this repository has actually
 * shipped rather than one invented for the test:
 *
 *  1. THE DEFERRAL, PER STATE. `gate:stop-budget` is RED on this tree — a
 *     measured median of ~30s against a 25000 ms ceiling that may only ever
 *     FALL — so the battery is unaffordable per turn and affordable ONLY
 *     because it stands down for a session window. The asymmetry is ADR-160
 *     §4's explicit choice and the easiest thing to get wrong: `closing` is
 *     deliberately NOT deferred while `closing-stale` is, because a stale
 *     window has no actor left to close it and its deferral can never
 *     end on its own. Every other state falls through to the battery.
 *  2. THE CACHE KEY MOVES. A verdict cached on anything other than what the
 *     battery measures is a stale-verdict machine; the brief's own floor is
 *     HEAD oid + dirty-path count + the tier/advisory fingerprint.
 *  3. THE REFUSAL REACHES THE MODEL. A refusal whose text never arrives is a
 *     refusal that cannot be acted on — asserted through the real
 *     `NativeHarnessWorker`, not through the gate in isolation.
 *  4. THE BREAKER FIRES. Three identical fingerprints release.
 *  5. A DIFFERENT FINGERPRINT DOES NOT INHERIT A RELEASE.
 *  6. AN UNNAMEABLE FAILURE BLOCKS, and is inert to the counter — the 31
 *     historical releases that all shared `sha256("[]")` (ADR-154).
 *  7. THE BOUND VS THE BUDGET. `MAX_TURN_GATE_REFUSALS` is 2 and the breaker's
 *     threshold is 3; whichever is not clamped is the one that silently stops
 *     being reachable.
 *  8. NO TURN EVER WAITS FOR THE MEASUREMENT. `vi-graph-debt`'s header records
 *     what a synchronous handler cost this suite (4/4 -> 2/4 on the native
 *     production e2e's wall clock); nothing here may reintroduce it.
 *
 * Harness rules, from the brief and this repo's own traps: a temp git repo per
 * case, `vi.spyOn(process, "cwd")` and NEVER `process.chdir` (vitest runs in
 * worker threads), and `./node_modules/.bin/vitest` rather than `npx`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CapabilitySupport } from "@arbor/harness";
import { NativeSessionEngine } from "@arbor/harness";
import {
  NativeHarnessWorker,
  type NativeHarnessWorkerOptions,
  type NativeModelPort,
  type NativeTurnBoundary,
} from "@arbor/harness";
import type { ExecutionPolicy, SessionStartRequest } from "@arbor/harness";

import {
  DEFAULT_MAX_NO_PROGRESS,
  NATIVE_TURN_REFUSAL_BUDGET,
  computeFingerprint,
  effectiveMaxNoProgress,
  evaluate,
  isUnnameableFailure,
  buildReleaseMessage,
  readMaxNoProgress,
  measureStopBattery,
  parseRedGates,
  stopGuardStateDir,
  stopBatteryTurnGate,
  type RedGate,
  type StopBatteryOutcome,
} from "../../src/hooks/stop-battery.js";

// --- battery fixtures -----------------------------------------------------

/** gate-all.mjs's human-readable blocking failure section. */
const FAILING_OUTPUT = [
  "gate:all — 1 of 17 gate(s) FAILED:",
  "",
  "  gate:typecheck-tests (exit 1):",
  "    error TS1234: something broke",
  "",
  "Re-run with: bun run gate:all --tier stop",
].join("\n");

const FAILING_OUTPUT_TWO = [
  "gate:all — 2 of 17 gate(s) FAILED:",
  "",
  "  gate:build (exit 2):",
  "    boom",
  "",
  "  gate:typecheck-tests (exit 1):",
  "    error TS1234: something broke",
].join("\n");

const ADVISORY_ONLY_OUTPUT = [
  "gate:all — 0 of 17 gate(s) FAILED:",
  "",
  "gate:all — 1 advisory gate(s) are red (not failing the battery):",
  "",
  "  gate:vi-findings (exit 1):",
  "    advisory because: requires a RECORDED HUMAN VERDICT per finding",
  "",
  "Re-run with: bun run gate:all --tier stop",
].join("\n");

/** A battery that failed before any gate reported: roster drift, unknown tier, a crash. */
const UNNAMEABLE_OUTPUT = [
  "gate:all — FAILED: roster drift: 2 gate(s) have no tier",
  "",
  "Re-run with: bun run gate:all --tier stop",
].join("\n");

const GREEN_OUTPUT = "gate:all — 17 of 17 gate(s) passed in 1234ms.";

// --- a stub battery, as a real command the handler spawns ----------------

/**
 * The shell made the whole battery overridable with `ARBOR_STOP_GATE_BATTERY_CMD`
 * so its process tests could stub 37 real gates. That seam is preserved
 * verbatim — including the deliberate word-split, because a test override may
 * be a multi-token command. This fixture writes an invocation marker and
 * answers with a scripted exit code and body.
 */
interface BatteryFixture { readonly cmd: string; readonly marker: string; }

function batteryFixture(dir: string, exitCode: number, body: string, name = "battery"): BatteryFixture {
  const script = join(dir, `${name}.mjs`);
  const marker = join(dir, `${name}-invocations`);
  writeFileSync(script, [
    'import { appendFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(marker)}, "x\\n");`,
    `process.stdout.write(${JSON.stringify(body)});`,
    `process.exit(${exitCode});`,
    "",
  ].join("\n"));
  return Object.freeze({ cmd: `bun ${script}`, marker });
}

const installBattery = (dir: string, exitCode: number, body: string, name?: string): BatteryFixture => batteryFixture(dir, exitCode, body, name);
const invocations = (marker: string): number => {
  try { return readFileSync(marker, "utf8").split("\n").filter((line) => line !== "").length; }
  catch { return 0; }
};

// --- repo harness ---------------------------------------------------------

const repoRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".."));

let root = "";
let fixtureDir = "";
let stateDir = "";
let git: ReturnType<typeof installGit>;

function installGit(dir: string) {
  const run = (...args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "t@example.com");
  run("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "one\n");
  run("add", "a.txt");
  run("commit", "-q", "-m", "root");
  return run;
}

/** The per-case guard state directory, deliberately outside `root`. */
const guardDir = (): string => stateDir;

/** Every environment variable the two scripts honoured, resolved per case. */
const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...process.env, ...over });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "arbor-stop-root-"));
  fixtureDir = mkdtempSync(join(tmpdir(), "arbor-stop-fixture-"));
  git = installGit(root);
  // The guard's own state lives OUTSIDE the repo under test. Writing it inside
  // would dirty the very tree the cache is keyed on, so every verdict would be
  // stale the moment it was written -- a self-invalidating cache.
  stateDir = mkdtempSync(join(tmpdir(), "arbor-stop-state-"));
  // The handler resolves the governed root through process.cwd(). vitest runs
  // in worker threads, so process.chdir is unavailable AND unsafe here.
  vi.spyOn(process, "cwd").mockReturnValue(root);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  rmSync(fixtureDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

// --- the worker, for the "reaches the model" assertions -----------------

class TestClock {
  constructor(private current = 1_700_000_000_000) {}
  now(): number { return this.current; }
}

const capabilities: readonly CapabilitySupport[] = [
  "streaming", "interruption", "resumption", "forking", "ephemeral_sessions", "structured_output", "tool_policy", "workspace_isolation", "approval_mediation", "usage_reporting", "artifact_capture", "remote_transport",
].map((capability) => ({
  capability,
  grade: "native",
  evidence: { implementation_id: "native-reference", observed_at: "2026-08-09T00:00:00.000Z", detail: "native conformance" },
})) as readonly CapabilitySupport[];

const policy: ExecutionPolicy = {
  filesystem: "read_only", approvals: "always", tool_allow: [], tool_deny: [], workspace_roots: ["/workspace"],
  max_wall_clock_ms: 3_600_000, max_events: 200, network_allowed: false, ambient_plugins_allowed: false,
  user_configuration_allowed: false, inherited_credentials_allowed: false,
};

const start = (sessionId: string): SessionStartRequest => ({
  session_id: sessionId, policy, required_capabilities: [], lineage: { kind: "new" }, ephemeral: false,
});

/** Records every prompt the worker composed, so "reached the model" is provable and not inferred. */
const promptsSeen = (prompts: string[]): NativeModelPort => ({
  async run(request) { prompts.push(request.prompt); return { text: [], tool_calls: [], final_message: "the answer" }; },
});

/**
 * Drives the real `NativeHarnessWorker` with the real `turn_gate`, so the
 * budget interaction and the model-facing text are the shipped ones.
 */
const runWorker = async (gate: NativeHarnessWorkerOptions["turn_gate"], sessionId: string, maxTurns = 8) => {
  const prompts: string[] = [];
  const engine = new NativeSessionEngine({ clock: new TestClock(), capabilities });
  const worker = new NativeHarnessWorker({ session_engine: engine, model: promptsSeen(prompts), turn_gate: gate });
  const result = await worker.run({ start: start(sessionId), prompt: "do the work", max_turns: maxTurns });
  return { result, prompts, diagnostics: engine.observe(sessionId).flatMap((e) => e.kind === "diagnostic" ? [String(e.payload.code)] : []) };
};


/**
 * The measurement is out of band, so the FIRST consultation legitimately defers
 * while the battery settles. That is not a gap to hide in each case: it is the
 * property that keeps the turn off the measurement's wall clock. `settle`
 * advances the gate until it has something to judge, which is what a session's
 * second turn sees.
 */
/**
 * Whether a verdict exists on disk, without consuming a refusal. The turn gate's
 * own consultation IS the judgement, so polling it would spend the budget this
 * helper exists to protect. The state file is the non-consuming witness.
 */
const batteryMeasured = (sessionId: string, e: NodeJS.ProcessEnv): boolean => {
  const file = join(stopGuardStateDir(process.cwd(), e, sessionId), `${sessionId}.json`);
  if (!existsSync(file)) return false;
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  return typeof parsed === "object" && parsed !== null && (parsed as { verdict?: unknown }).verdict !== null;
};

const settle = async (sessionId: string, e: NodeJS.ProcessEnv, tries = 12): Promise<void> => {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    await measureStopBattery({ event: "turn_end", hook_id: "h", version: "1.0.0", session_id: sessionId, summary: "s", detail: {} } as never, e);
    // The observer never advances the counter, so a verdict here always
    // arrives with a CLEAN breaker and the first gate call sees the block.
    if (batteryMeasured(sessionId, e)) return;
    await new Promise((resolve) => { setTimeout(resolve, 15); });
  }
  throw new Error(`the battery never produced a verdict for ${sessionId}`);
};

/** A tree move, because the verdict is cached on the measured inputs: swapping the
 *  battery under a session that has already been judged reads the CACHED verdict
 *  for the previous battery. The old suite's harness re-measured on every call. */
let treeStep = 0;
const moveTree = (): void => {
  treeStep += 1;
  writeFileSync(join(root, `step-${treeStep}.txt`), `${treeStep}\n`);
  git("add", `step-${treeStep}.txt`);
  git("commit", "-q", "-m", `step ${treeStep}`);
};

/** The breaker's persisted state, read the way the release gate reads the journal. */
const breakerOf = (sessionId: string, e: NodeJS.ProcessEnv): { fingerprint: string | null; consecutive_count: number; released: boolean } =>
  (JSON.parse(readFileSync(join(stopGuardStateDir(process.cwd(), e, sessionId), `${sessionId}.json`), "utf8")) as { breaker: { fingerprint: string | null; consecutive_count: number; released: boolean } }).breaker;

/** The release journal, as `gate:stop-guard-releases` reads it. Absent is `[]`,
 *  which is a different fact from "present and empty". */
const releases = (e: NodeJS.ProcessEnv): Record<string, unknown>[] => {
  try { return readFileSync(join(stopGuardStateDir(process.cwd(), e), "releases.jsonl"), "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>); }
  catch { return []; }
};

/** Whether a judgement is available, without consuming one. */
const judged = async (sessionId: string, e: NodeJS.ProcessEnv): Promise<StopBatteryOutcome> => {
  const outcome = await stopBatteryTurnGate(sessionId, e);
  expect(outcome.decision, `the gate deferred: ${outcome.deferral ?? ""}`).not.toBe("deferred");
  return outcome;
};

describe("the stop-tier battery deferral — ADR-160 §4's asymmetry", () => {
  // The battery is affordable ONLY because it stands down. Each of these is a
  // separate assertion because `closing` being wrong in EITHER direction is a
  // real regression: deferring it re-imposes the per-turn tax the deferral
  // exists to remove, and NOT deferring a stale window keeps charging a
  // session whose deferral can never end.
  const DEFERRED: readonly string[] = ["open 3 uncommitted source path(s); commits and gates are deferred to the session close",
    "closed-green close receipt green at abc12345", "closing-stale commit window open since 2026-09-01 with no live actor to close it"];
  const OWED: readonly string[] = ["none no session record", "closing commit window open", "closed-red closed, but HEAD moved or the receipt is red"];

  it.each(DEFERRED)("defers the battery for window state %s and runs nothing", async (windowState) => {
    const battery = installBattery(fixtureDir, 1, FAILING_OUTPUT);
    const outcome = await stopBatteryTurnGate("s-deferred", env({ ARBOR_SESSION_WINDOW_STATE: windowState, ARBOR_STOP_GATE_BATTERY_CMD: battery.cmd, ARBOR_STOP_GUARD_STATE_DIR: stateDir }));

    expect(outcome.decision).toBe("deferred");
    // The whole affordability argument, as an assertion: a deferred window
    // must not have spawned the battery even once.
    expect(invocations(battery.marker)).toBe(0);
  });

  it.each(OWED)("OWES the battery for window state %s and runs it", async (windowState) => {
    const battery = installBattery(fixtureDir, 1, FAILING_OUTPUT);
    const sessionId = `s-owed-${windowState.split(" ")[0]}`;
    const e = env({ ARBOR_SESSION_WINDOW_STATE: windowState, ARBOR_STOP_GATE_BATTERY_CMD: battery.cmd, ARBOR_STOP_GUARD_STATE_DIR: stateDir });
    await settle(sessionId, e);
    const outcome = await judged(sessionId, e);

    // The asymmetry: `closing` is ADR-160 §4's explicit choice and is NOT
    // deferred. If this ever asserts `deferred`, a live-actor window lost its
    // veto; if it ever asserts `blocked` for closing-stale, every stranded
    // session on the machine pays the battery on every turn forever.
    expect(outcome.decision).toBe("blocked");
    expect(outcome.refusal).toContain("gate:typecheck-tests");
  });
});

describe("the refusal, the breaker, and the budget", () => {
  it("blocks a red battery on the turn gate, and the text reaches the model", async () => {
    const battery = installBattery(fixtureDir, 1, FAILING_OUTPUT);
    const e = env({ ARBOR_SESSION_WINDOW_STATE: "none no session record", ARBOR_STOP_GATE_BATTERY_CMD: battery.cmd, ARBOR_STOP_GUARD_STATE_DIR: stateDir });
    // The measurement is pre-measured out of band, which is what a session
    // looks like after its first turn boundary has fired the observer.
    await settle("s-refusal", e);
    const gate = (boundary: NativeTurnBoundary) => stopBatteryTurnGate(boundary.session_id, e).then((o) => o.refusal);

    const { result, prompts, diagnostics } = await runWorker(gate, "s-refusal", 8);
    // Block first, then the breaker's escape valve: the model is told the gates
    // are red and, on the repeat, that it is an escape valve and not a pass.
    expect(diagnostics.filter((code) => code === "turn_gate_refused").length).toBeGreaterThanOrEqual(1);
    expect(result.session.state).toBe("completed");
    // A refusal whose text never arrives is a refusal that cannot be acted on.
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts.some((prompt) => prompt.includes("BLOCKING") && prompt.includes("gate:typecheck-tests"))).toBe(true);
    // The verdict named the battery's own remedy, as the block message always did.
    expect(prompts.some((prompt) => prompt.includes("bun run gate:all --tier stop"))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("escape valve"))).toBe(true);
  });

  it("defers the turn whose boundary STARTS the measurement, and refuses the next one", async () => {
    const battery = installBattery(fixtureDir, 1, FAILING_OUTPUT);
    const e = env({ ARBOR_SESSION_WINDOW_STATE: "none no session record", ARBOR_STOP_GATE_BATTERY_CMD: battery.cmd, ARBOR_STOP_GUARD_STATE_DIR: stateDir });
    const seen: StopBatteryOutcome["decision"][] = [];
    const gate = (boundary: NativeTurnBoundary) => stopBatteryTurnGate(boundary.session_id, e)
      .then((outcome) => { seen.push(outcome.decision); return outcome.refusal; });

    await runWorker(gate, "s-defer-then-block", 8);

    // Nothing is judged before the battery settles, and the settle is one
    // battery rather than one per turn. This is the property that keeps the
    // turn off the measurement's wall clock, asserted rather than assumed.
    expect(seen[0]).toBe("deferred");
    expect(invocations(battery.marker)).toBeLessThanOrEqual(2);
  });

  it("blocks the first identical failure, then releases once the fingerprint repeats past the threshold", async () => {
    const battery = installBattery(fixtureDir, 1, FAILING_OUTPUT);
    const decisions: StopBatteryOutcome["decision"][] = [];
    const e = env({ ARBOR_SESSION_WINDOW_STATE: "none no session record", ARBOR_STOP_GATE_BATTERY_CMD: battery.cmd, ARBOR_STOP_GUARD_STATE_DIR: stateDir });
    await settle("s-breaker", e);
    const gate = () => stopBatteryTurnGate("s-breaker", e)
      .then((outcome) => { decisions.push(outcome.decision); return outcome.refusal; });

    await runWorker(gate, "s-breaker");

    // Threshold 1, not 3: the turn gate's own refusal budget is 2, and a
    // release needs count > threshold, so 3 would need a third refusal the
    // budget cannot pay for. Clamped to budget-1 the release lands on the last
    // refusal that CAN be paid for.
    expect(effectiveMaxNoProgress(env())).toBe(NATIVE_TURN_REFUSAL_BUDGET - 1);
    expect(decisions).toContain("blocked");
    expect(decisions).toContain("released");
    // The release says plainly that it is not a pass, which is the property
    // the whole breaker exists to preserve.
    expect(decisions).toContain("released");
  });

  it("keeps a release granted for one fingerprint, and does not let a DIFFERENT fingerprint inherit it", async () => {
    const battery = installBattery(fixtureDir, 1, FAILING_OUTPUT);
    const second = installBattery(fixtureDir, 1, FAILING_OUTPUT_TWO);
    const stateDir = guardDir();
    const base = { ARBOR_SESSION_WINDOW_STATE: "none no session record", ARBOR_STOP_GATE_BATTERY_CMD: battery.cmd, ARBOR_STOP_GUARD_STATE_DIR: stateDir };

    const e = env(base);
    await settle("s-stay", e);

    // Same fingerprint: block, then release on the repeat.
    expect((await judged("s-stay", e)).decision).toBe("blocked");
    expect((await stopBatteryTurnGate("s-stay", e)).decision).toBe("released");
    // stayedReleased: a release already granted STAYS granted, and the counter
    // keeps incrementing. Re-arming here is what wedged sessions before.
    const again = await stopBatteryTurnGate("s-stay", e);
    expect(again.decision).toBe("released");
    expect(again.refusal ?? "").toContain("escape valve");

    // A different fingerprint is a different failure. It must not inherit the
    // release the FIRST fingerprint was granted, so it starts from zero and
    // blocks again — a release is permission for one failure, not amnesty.
    const otherEnv = env({ ...base, ARBOR_STOP_GATE_BATTERY_CMD: second.cmd });
    await settle("s-other", otherEnv);
    const other = await judged("s-other", otherEnv);
    expect(other.decision).toBe("blocked");
    expect(other.refusal ?? "").toContain("gate:build");
  });

  it("blocks an unnameable failure with its OWN message, and never lets it release", async () => {
    const battery = installBattery(fixtureDir, 1, UNNAMEABLE_OUTPUT);
    const base = { ARBOR_SESSION_WINDOW_STATE: "none no session record", ARBOR_STOP_GATE_BATTERY_CMD: battery.cmd, ARBOR_STOP_GUARD_STATE_DIR: stateDir };
    const e = env(base);
    await settle("s-unnameable", e);
    const first = await judged("s-unnameable", e);
    expect(first.decision).toBe("blocked");
    // Its own message, not the generic block text: the operator has to be told
    // that NOTHING was checked, which is a different problem with a different fix.
    expect(first.refusal).toContain("reported no failing");
    expect(first.refusal).toContain("will never release");
    // Four more identical attempts. The 31 historical releases all shared
    // sha256("[]") (ADR-154) — this is the assertion that cohort can never recur.
    for (let attempt = 0; attempt < 4; attempt += 1) expect((await stopBatteryTurnGate("s-unnameable", e)).decision).toBe("blocked");
  });

  it("cannot be blocked forever by a permanently red battery", async () => {
    const battery = installBattery(fixtureDir, 1, FAILING_OUTPUT);
    const refused: number[] = [];
    const e = env({ ARBOR_SESSION_WINDOW_STATE: "none no session record", ARBOR_STOP_GATE_BATTERY_CMD: battery.cmd, ARBOR_STOP_GUARD_STATE_DIR: stateDir });
    await settle("s-forever", e);
    const gate = (boundary: NativeTurnBoundary) => stopBatteryTurnGate(boundary.session_id, e)
      .then((outcome) => { if (outcome.refusal !== null) refused.push(boundary.turn); return outcome.refusal; });

    const { result, diagnostics } = await runWorker(gate, "s-forever", 20);

    // A permanently-red battery must not spend the whole turn budget.
    expect(refused.length).toBeLessThan(20);
    expect(result.session.state).toBe("completed");
    // And the moment it stopped being consulted is a named state, not silence.
    expect(diagnostics).toContain("turn_gate_budget_exhausted");
  });

  it("records the release in the journal the release gate reads, so a quiet journal is distinguishable from an honest one", async () => {
    const battery = installBattery(fixtureDir, 1, FAILING_OUTPUT);
    const stateDir = guardDir();
    const e = env({ ARBOR_SESSION_WINDOW_STATE: "none no session record", ARBOR_STOP_GATE_BATTERY_CMD: battery.cmd, ARBOR_STOP_GUARD_STATE_DIR: stateDir });
    await settle("s-journal", e);
    await stopBatteryTurnGate("s-journal", e);
    await stopBatteryTurnGate("s-journal", e);
    const journal = readFileSync(join(stateDir, "releases.jsonl"), "utf8").split("\n").filter((line) => line !== "");
    expect(journal).toHaveLength(1);
    const entry = JSON.parse(journal[0] ?? "{}") as Record<string, unknown>;
    expect(entry).toMatchObject({ session_id: "s-journal", schema_version: 1 });
    // The clamp is ATTRIBUTED, so the smaller budget silently disabling the
    // larger threshold is visible in the record rather than invisible.
    expect(entry.configured_max_no_progress).toBe(DEFAULT_MAX_NO_PROGRESS);
    expect(entry.effective_max_no_progress).toBe(effectiveMaxNoProgress(env()));
    // WHICH GATES, on the line itself. This is the field ADR-154's "the
    // sha256(\"[]\") cohort can never recur" argument rests on: a release that
    // does not record the failing set cannot be distinguished from one that
    // released having proved nothing was checked. Asserted against the NATIVE
    // guard's own output, because `scripts/tests/stop-guard-releases-gate.test.mjs`
    // only proves it against its own fixtures.
    expect(entry.blocking_gates).toEqual([{ gate: "gate:typecheck-tests", exit_code: "1" }]);
    expect(entry.fingerprint).toBe(computeFingerprint([{ gate: "gate:typecheck-tests", exit_code: "1" }]));
    expect(entry.consecutive_count).toBe(2);
  });

  it("clears the breaker on a green battery, so a later failure starts from zero", async () => {
    const failing = installBattery(fixtureDir, 1, FAILING_OUTPUT, "red");
    const green = installBattery(fixtureDir, 0, GREEN_OUTPUT, "green");
    const base = { ARBOR_SESSION_WINDOW_STATE: "none no session record", ARBOR_STOP_GUARD_STATE_DIR: stateDir };
    const red = env({ ...base, ARBOR_STOP_GATE_BATTERY_CMD: failing.cmd });
    await settle("s-rearm", red);
    expect((await judged("s-rearm", red)).decision).toBe("blocked");
    // Advance the streak so a stale count would be visible: the count must be
    // observable above zero before the green run, not merely asserted after.
    expect(breakerOf("s-rearm", red).consecutive_count).toBe(1);

    moveTree();
    const ok = env({ ...base, ARBOR_STOP_GATE_BATTERY_CMD: green.cmd });
    await settle("s-rearm", ok);
    expect((await judged("s-rearm", ok)).decision).toBe("allowed");
    // A green battery is PROGRESS, and progress is the one thing the breaker's
    // premise rests on: the session can fix things again, so nothing is stuck.
    expect(breakerOf("s-rearm", ok)).toMatchObject({ consecutive_count: 0, fingerprint: null, released: false });

    // And the next identical failure blocks again rather than inheriting the streak.
    moveTree();
    const stale = env({ ...base, ARBOR_STOP_GATE_BATTERY_CMD: failing.cmd });
    await settle("s-rearm", stale);
    expect((await judged("s-rearm", stale)).decision).toBe("blocked");
    expect(breakerOf("s-rearm", stale).consecutive_count).toBe(1);
  });

  it("writes no release line for an unnameable failure, so it cannot be mistaken for a granted escape", async () => {
    const battery = installBattery(fixtureDir, 1, UNNAMEABLE_OUTPUT);
    const e = env({ ARBOR_SESSION_WINDOW_STATE: "none no session record", ARBOR_STOP_GATE_BATTERY_CMD: battery.cmd, ARBOR_STOP_GUARD_STATE_DIR: stateDir });
    await settle("s-no-release", e);
    for (let attempt = 0; attempt < 5; attempt += 1) expect((await stopBatteryTurnGate("s-no-release", e)).decision).toBe("blocked");
    // `judgeVerdict` returns before the append, so the file is never created.
    expect(existsSync(join(stateDir, "releases.jsonl"))).toBe(false);
    expect(releases(e)).toEqual([]);
  });

  it("keeps an unnameable failure out of the counter entirely, so it can seed nothing", async () => {
    const real = installBattery(fixtureDir, 1, FAILING_OUTPUT, "real");
    const drift = installBattery(fixtureDir, 1, UNNAMEABLE_OUTPUT, "drift");
    const sessionId = "s-inert";
    const base = { ARBOR_SESSION_WINDOW_STATE: "none no session record", ARBOR_STOP_GUARD_STATE_DIR: stateDir };
    const red = env({ ...base, ARBOR_STOP_GATE_BATTERY_CMD: real.cmd });
    const unnameable = env({ ...base, ARBOR_STOP_GATE_BATTERY_CMD: drift.cmd });

    await settle(sessionId, unnameable);
    expect((await judged(sessionId, unnameable)).decision).toBe("blocked");
    // INERT: the counter is not merely not-advancing, it is UNTOUCHED — still no
    // fingerprint, still zero. An unnameable failure has nothing to repeat, so
    // it never becomes a streak that a later judgement can ride.
    expect(breakerOf(sessionId, unnameable)).toMatchObject({ fingerprint: null, consecutive_count: 0 });
    for (let attempt = 0; attempt < 3; attempt += 1) expect((await stopBatteryTurnGate(sessionId, unnameable)).decision).toBe("blocked");
    expect(breakerOf(sessionId, unnameable)).toMatchObject({ fingerprint: null, consecutive_count: 0 });

    // And it seeds nothing for a real failure afterwards: the first real failure
    // is a first failure, not the second.
    moveTree();
    await settle(sessionId, red);
    expect((await judged(sessionId, red)).decision).toBe("blocked");
    expect(breakerOf(sessionId, red).consecutive_count).toBe(1);
  });
});

describe("the cache is keyed on what the battery measures", () => {
  it("reuses one verdict across turns over an unchanged tree", async () => {
    const battery = installBattery(fixtureDir, 0, GREEN_OUTPUT);
    const base = { ARBOR_SESSION_WINDOW_STATE: "none no session record", ARBOR_STOP_GATE_BATTERY_CMD: battery.cmd, ARBOR_STOP_GUARD_STATE_DIR: stateDir };
    const e = env(base);
    await settle("s-cache", e);
    expect((await judged("s-cache", e)).decision).toBe("allowed");
    expect((await stopBatteryTurnGate("s-cache", e)).decision).toBe("allowed");
    expect((await stopBatteryTurnGate("s-cache", e)).decision).toBe("allowed");
    // Three turns, one measurement. A per-turn battery is what gate:stop-budget
    // says this repository cannot afford.
    expect(invocations(battery.marker)).toBe(1);
  });

  it("re-measures when HEAD moves, so a green verdict never outlives the commit that made it green", async () => {
    const battery = installBattery(fixtureDir, 0, GREEN_OUTPUT);
    const base = { ARBOR_SESSION_WINDOW_STATE: "none no session record", ARBOR_STOP_GATE_BATTERY_CMD: battery.cmd, ARBOR_STOP_GUARD_STATE_DIR: stateDir };
    const e = env(base);
    await settle("s-head", e);
    expect((await judged("s-head", e)).decision).toBe("allowed");
    writeFileSync(join(root, "b.txt"), "two\n");
    git("add", "b.txt");
    git("commit", "-q", "-m", "second");
    await settle("s-head", e);
    expect((await judged("s-head", e)).decision).toBe("allowed");
    expect(invocations(battery.marker)).toBe(2);
  });

  it("re-measures when the dirty-path count moves, so an edited tree is never judged on a clean tree's verdict", async () => {
    const battery = installBattery(fixtureDir, 0, GREEN_OUTPUT);
    const base = { ARBOR_SESSION_WINDOW_STATE: "none no session record", ARBOR_STOP_GATE_BATTERY_CMD: battery.cmd, ARBOR_STOP_GUARD_STATE_DIR: stateDir };
    const e = env(base);
    await settle("s-dirty", e);
    expect((await judged("s-dirty", e)).decision).toBe("allowed");
    writeFileSync(join(root, "c.txt"), "three\n");
    await settle("s-dirty", e);
    expect((await judged("s-dirty", e)).decision).toBe("allowed");
    // One uncommitted path is a different measured state from zero, and a gate
    // cleared over the first has proved nothing about the second.
    expect(invocations(battery.marker)).toBe(2);
  });

  it("re-measures when the tier/advisory fingerprint moves", async () => {
    const battery = installBattery(fixtureDir, 0, GREEN_OUTPUT);
    const base = { ARBOR_SESSION_WINDOW_STATE: "none no session record", ARBOR_STOP_GATE_BATTERY_CMD: battery.cmd, ARBOR_STOP_GUARD_STATE_DIR: stateDir };
    await settle("s-tier", env(base));
    const first = await judged("s-tier", env(base));
    expect(first.decision).toBe("allowed");
    // A different advisory set is a different battery, so its verdict is not
    // transferable even over an identical tree.
    const tierEnv = env({ ...base, ARBOR_STOP_BATTERY_ADVISORY: "hook-default-ci" });
    await settle("s-tier", tierEnv);
    const second = await judged("s-tier", tierEnv);
    expect(second.decision).toBe("allowed");
    expect(invocations(battery.marker)).toBe(2);
  });
});

describe("the pure decision surface, ported from the deleted module", () => {
  it("splits blocking from advisory so a blocking gate is never read as advisory", () => {
    const parsed = parseRedGates(`${FAILING_OUTPUT}\n\n${ADVISORY_ONLY_OUTPUT}`);
    expect(parsed.blocking.map((entry: RedGate) => entry.gate)).toEqual(["gate:typecheck-tests"]);
    expect(parsed.advisory.map((entry: RedGate) => entry.gate)).toEqual(["gate:vi-findings"]);
  });

  it("reads ADR-113's SHARED CAUSE group shape as well as the solitary header", () => {
    const grouped = ["gate:all — 2 of 17 gate(s) FAILED:", "",
      "  SHARED CAUSE — held evidence transaction txn-1 is active (covers: 2 gates):",
      "    - gate:adr-acceptance-staged (exit 1)", "    - gate:obligations (exit 1)"].join("\n");
    expect(parseRedGates(grouped).blocking.map((entry: RedGate) => entry.gate)).toEqual(["gate:adr-acceptance-staged", "gate:obligations"]);
  });

  it("treats an advisory-red battery as green, and reports it without vetoing", () => {
    expect(computeFingerprint([])).toBe(computeFingerprint([]));
    const parsed = parseRedGates(ADVISORY_ONLY_OUTPUT);
    expect(parsed.blocking).toHaveLength(0);
    // Advisory gates never fail the exit code, so they never name a blocking
    // fingerprint — the release gate's empty-set class stays about the BLOCKING set.
    expect(isUnnameableFailure(parsed.blocking)).toBe(true);
  });

  it("classifies the two failure kinds the shell distinguished", () => {
    expect(isUnnameableFailure([])).toBe(true);
    expect(isUnnameableFailure(parseRedGates(FAILING_OUTPUT).blocking)).toBe(false);
  });

  it("resets the counter on a change of fingerprint, which is progress", () => {
    const prior = { fingerprint: "a", consecutive_count: 2, released: false };
    expect(evaluate(prior, "b", 3)).toMatchObject({ released: false, consecutiveCount: 1 });
    expect(evaluate(null, "a", 3)).toMatchObject({ released: false, consecutiveCount: 1 });
  });

  it("declares which of the two bounds governs, and why, without either becoming unreachable", () => {
    // The turn gate can refuse at most MAX_TURN_GATE_REFUSALS times, so an
    // unclamped 3 would be a release nothing could ever reach; a clamp the
    // other way would let a 2-refusal budget disable a 3-release guarantee.
    expect(effectiveMaxNoProgress(env())).toBeLessThanOrEqual(NATIVE_TURN_REFUSAL_BUDGET);
    expect(effectiveMaxNoProgress(env({ ARBOR_STOP_GUARD_MAX_NO_PROGRESS: "1" }))).toBe(1);
    // An operator may still RAISE the threshold only as far as the budget
    // allows; a lower threshold is honoured as asked.
    expect(effectiveMaxNoProgress(env({ ARBOR_STOP_GUARD_MAX_NO_PROGRESS: "not-a-number" }))).toBe(effectiveMaxNoProgress(env()));
  });
});

describe("the ported pure-function surface of the deleted module", () => {
  const ROSTER_DRIFT_OUTPUT = [
    "gate:all — ROSTER DRIFT (no gates were run):",
    "",
    "  gate:example is declared in package.json but has no tier in scripts/gate-all.mjs GATE_TIERS.",
    "",
    "No gates ran. A green battery over a wrong roster proves nothing.",
  ].join("\n");

  it("reads the configured threshold, and falls back on anything invalid", () => {
    expect(DEFAULT_MAX_NO_PROGRESS).toBe(3);
    expect(readMaxNoProgress({})).toBe(3);
    expect(readMaxNoProgress({ ARBOR_STOP_GUARD_MAX_NO_PROGRESS: "5" })).toBe(5);
    expect(readMaxNoProgress({ ARBOR_STOP_GUARD_MAX_NO_PROGRESS: "not-a-number" })).toBe(3);
    expect(readMaxNoProgress({ ARBOR_STOP_GUARD_MAX_NO_PROGRESS: "0" })).toBe(3);
    expect(readMaxNoProgress({ ARBOR_STOP_GUARD_MAX_NO_PROGRESS: "-1" })).toBe(3);
  });

  it("fingerprints the sorted failing set, so input order cannot mask a change", () => {
    const pair = [{ gate: "gate:b", exit_code: "1" }, { gate: "gate:a", exit_code: "2" }];
    expect(computeFingerprint(pair)).toBe(computeFingerprint([...pair].reverse()));
    expect(computeFingerprint([{ gate: "gate:a", exit_code: "1" }])).not.toBe(computeFingerprint([{ gate: "gate:c", exit_code: "1" }]));
    // An exit-code change is a DIFFERENT failure, so it must not collide.
    expect(computeFingerprint([{ gate: "gate:a", exit_code: "1" }])).not.toBe(computeFingerprint([{ gate: "gate:a", exit_code: "2" }]));
  });

  it("releases only after the threshold, and re-arms only on a real change", () => {
    let state = null;
    const seen: boolean[] = [];
    // The PAIR, not the boolean alone: `released` only means something next to the
    // count that earned it. A counter that jumped to the threshold, or that sat at
    // 1 while reporting four releases, would satisfy a boolean assertion and fail
    // the deleted module's own sequence, which pinned both at every step.
    const counted: { released: boolean; consecutiveCount: number }[] = [];
    for (let i = 0; i < 4; i += 1) {
      const { nextState, released, consecutiveCount } = evaluate(state, "fp-a", 3);
      seen.push(released);
      counted.push({ released, consecutiveCount });
      state = nextState;
    }
    expect(seen).toEqual([false, false, false, true]);
    expect(counted).toEqual([
      { released: false, consecutiveCount: 1 },
      { released: false, consecutiveCount: 2 },
      { released: false, consecutiveCount: 3 },
      { released: true, consecutiveCount: 4 },
    ]);
    // stayedReleased, then re-arm on a genuine change — the two properties the
    // deleted module's own suite pinned, carried across unchanged.
    expect(evaluate(state, "fp-a", 3).released).toBe(true);
    expect(evaluate(state, "fp-b", 3)).toMatchObject({ released: false, consecutiveCount: 1 });
  });

  it("states the release's own terms: which gates, that it is not a pass, and what to do", () => {
    const parsed = parseRedGates(FAILING_OUTPUT_TWO);
    const message = buildReleaseMessage({
      output: FAILING_OUTPUT_TWO, blocking: parsed.blocking, advisory: parseRedGates(ADVISORY_ONLY_OUTPUT).advisory,
      consecutiveCount: 4, maxNoProgress: 3, configuredMaxNoProgress: 3,
    });
    expect(message).toMatch(/RELEASED/);
    expect(message).toMatch(/4 consecutive times \(threshold 3\)/);
    expect(message).toMatch(/NOT complete/);
    expect(message).toMatch(/must NOT be reported/);
    expect(message).toMatch(/gate:build \(exit 2\).*BLOCKING gate/);
    // An operator-gated advisory must name the mechanism, since the whole
    // reason it is advisory is that no model may resolve it.
    expect(message).toMatch(/gate:vi-findings \(exit 1\).*operator verdict/);
    // The EXACT triage invocation, not just "operator verdict". The advisory
    // mechanism is only useful if it names the command that clears it, and
    // `vi-findings.mjs` is the one a model must not be left to guess at — a
    // model cannot record its own operator verdict.
    expect(message).toMatch(/vi-findings\.mjs --triage/);
  });

  it("names the clamp in the release when the budget is what forced it", () => {
    const parsed = parseRedGates(FAILING_OUTPUT);
    const message = buildReleaseMessage({
      output: FAILING_OUTPUT, blocking: parsed.blocking, advisory: [],
      consecutiveCount: 2, maxNoProgress: 1, configuredMaxNoProgress: 3,
    });
    expect(message).toMatch(/clamped from a configured 3/);
    expect(message).toMatch(/escape valve, NOT a pass/);
  });

  it("parses a roster-drift battery to no gates at all — the unnameable precondition", () => {
    const parsed = parseRedGates(ROSTER_DRIFT_OUTPUT);
    expect(parsed.blocking).toEqual([]);
    expect(parsed.advisory).toEqual([]);
    expect(isUnnameableFailure(parsed.blocking)).toBe(true);
  });

  it("finds every gate in an ADR-113 SHARED CAUSE group, not just the classic header", () => {
    const grouped = ["gate:all — 3 of 17 gate(s) FAILED:", "",
      "  SHARED CAUSE — held evidence transaction txn-shared is active (covers: 2 gates):",
      "    - gate:adr-acceptance-staged (exit 1)", "    - gate:obligations (exit 1)",
      "", "  gate:typecheck-tests (exit 1):", "    error TS1234: something broke"].join("\n");
    const { blocking, advisory } = parseRedGates(grouped);
    // ORDER IS NOT ASSERTED: the fingerprint sorts the set, and the deleted
    // module's own suite asserted containment for exactly this reason.
    expect(blocking.map((entry: RedGate) => entry.gate).sort()).toEqual(["gate:adr-acceptance-staged", "gate:obligations", "gate:typecheck-tests"]);
    expect(advisory).toEqual([]);
  });

  it("honours the escape hatch rather than inviting wholesale disabling", async () => {
    const battery = installBattery(fixtureDir, 1, FAILING_OUTPUT);
    const note = await measureStopBattery({ event: "turn_end", hook_id: "h", version: "1.0.0", session_id: "s-skip", summary: "s", detail: {} } as never,
      env({ ARBOR_SKIP_STOP_GATES: "1", ARBOR_STOP_GATE_BATTERY_CMD: battery.cmd, ARBOR_STOP_GUARD_STATE_DIR: stateDir }));
    expect(note?.note).toContain("ARBOR_SKIP_STOP_GATES");
    expect(invocations(battery.marker)).toBe(0);
  });

  it("resolves the same state directory as the release gate that reads it", async () => {
    // Two languages, one path. If they drifted, `gate:stop-guard-releases`
    // would read an empty journal forever and report honestly on nothing —
    // exactly the "goes quiet" failure the devolution audit predicted.
    const module = await import(pathToFileURL(join(repoRoot, "scripts", "lib", "stop-guard-state.mjs")).href) as { resolveStateDir: (r: string, e?: NodeJS.ProcessEnv) => string };
    expect(stopGuardStateDir(root, env({}))).toBe(module.resolveStateDir(root, {}));
    expect(stopGuardStateDir(root, env({ ARBOR_STOP_GUARD_STATE_DIR: "/tmp/x" }))).toBe("/tmp/x");
  });
});

describe("the turn gate never blocks the turn on the measurement", () => {
  // THE REGRESSION THIS EXISTS TO PREVENT. `vi-graph-debt.ts` records that a
  // synchronous handler spending `git` subprocesses on the turn boundary took
  // the native production e2e from 4/4 to 2/4 on its wall-clock budget. A first
  // version of this gate re-measured and re-checked the window state in line,
  // and the same suite measured 32s against a 13.9s baseline. The gate must now
  // read ONLY what the observer measured out of band — no battery, no
  // repository-session read, no `git` — and these two assertions are what keeps it
  // that way.
  it("starts nothing: a gate call over a settled verdict spawns no battery at all", async () => {
    const battery = installBattery(fixtureDir, 1, FAILING_OUTPUT);
    const e = env({ ARBOR_SESSION_WINDOW_STATE: "none no session record", ARBOR_STOP_GATE_BATTERY_CMD: battery.cmd, ARBOR_STOP_GUARD_STATE_DIR: stateDir });
    await settle("s-no-spawn", e);
    const afterMeasurement = invocations(battery.marker);
    expect(afterMeasurement).toBeGreaterThan(0);

    for (let turn = 0; turn < 5; turn += 1) await stopBatteryTurnGate("s-no-spawn", e);

    // Five turns of judging, zero additional batteries. The verdict is read.
    expect(invocations(battery.marker)).toBe(afterMeasurement);
  });

  it("defers when the observer has measured nothing, rather than measuring in line", async () => {
    const battery = installBattery(fixtureDir, 1, FAILING_OUTPUT);
    const e = env({ ARBOR_SESSION_WINDOW_STATE: "none no session record", ARBOR_STOP_GATE_BATTERY_CMD: battery.cmd, ARBOR_STOP_GUARD_STATE_DIR: stateDir });
    const outcome = await stopBatteryTurnGate("s-never-measured", e);
    expect(outcome.decision).toBe("deferred");
    // The measurement belongs to the `turn_end` observer. A gate that reached
    // for the battery itself would put ~30s back on the turn's critical path.
    // The battery fixture is what makes this observable: a spawned battery
    // writes a marker line, so "spawned nothing" is a count and not an absence.
    expect(invocations(battery.marker)).toBe(0);
    // ...and it must STILL be nothing after the turn is over, i.e. the gate
    // did not leave a detached measurement running behind the turn.
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    expect(invocations(battery.marker)).toBe(0);
  });

  it("honours the observer's window stand-down without re-reading the window itself", async () => {
    const battery = installBattery(fixtureDir, 1, FAILING_OUTPUT);
    const e = env({ ARBOR_SESSION_WINDOW_STATE: "none no session record", ARBOR_STOP_GATE_BATTERY_CMD: battery.cmd, ARBOR_STOP_GUARD_STATE_DIR: stateDir });
    await settle("s-standdown", e);
    // Flip the window to a deferring state and let the observer record it.
    await measureStopBattery({ event: "turn_end", hook_id: "h", version: "1.0.0", session_id: "s-standdown", summary: "s", detail: {} } as never,
      env({ ...e, ARBOR_SESSION_WINDOW_STATE: "open 3 uncommitted source path(s)" }));
    const outcome = await stopBatteryTurnGate("s-standdown", env({ ...e, ARBOR_SESSION_WINDOW_STATE: "open 3 uncommitted source path(s)" }));
    expect(outcome.decision).toBe("deferred");
    expect(outcome.deferral).toContain("open");
  });
});

describe("Arboretum M2 — scheduled by declared inputs, with owned baseline debt", () => {
  /** A battery that records the argv it was given, one JSON line per invocation. */
  const argvBattery = (exitCode: number, body: string): { readonly cmd: string; readonly argvLog: string } => {
    const script = join(fixtureDir, "argv-battery.mjs");
    const argvLog = join(fixtureDir, "argv.jsonl");
    writeFileSync(script, [
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
      `process.stdout.write(${JSON.stringify(body)});`,
      `process.exit(${exitCode});`,
      "",
    ].join("\n"));
    return Object.freeze({ cmd: `bun ${script}`, argvLog });
  };
  const argvSeen = (log: string): string[][] => readFileSync(log, "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as string[]);
  const skipOf = (argv: readonly string[]): string[] => {
    const index = argv.indexOf("--skip");
    return index < 0 ? [] : (argv[index + 1] ?? "").split(",");
  };

  /** A repository whose profile declares inputs for one stop gate and not another. */
  const installProfile = (): void => {
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "fixture", scripts: { "gate:docs": "true", "gate:undeclared": "true" } }, null, 2)}\n`);
    execFileSync("mkdir", ["-p", join(root, "scripts"), join(root, "docs"), join(root, "decisions")]);
    writeFileSync(join(root, "scripts", "execution-profile.json"), `${JSON.stringify({ gates: {
      "gate:docs": { contexts: { stop: true }, inputs: ["docs/**"] },
      "gate:undeclared": { contexts: { stop: true } },
    } }, null, 2)}\n`);
    writeFileSync(join(root, "docs", "a.md"), "a\n");
    writeFileSync(join(root, "decisions", "ADR-001-owner.md"), "# ADR-001: owner\n");
    git("add", "-A");
    git("commit", "-q", "-m", "profile");
  };

  const ownDebt = (gate: string): void => {
    execFileSync("mkdir", ["-p", join(root, "scripts", "stop-guard")]);
    const head = git("rev-parse", "HEAD").trim();
    writeFileSync(join(root, "scripts", "stop-guard", "debt.json"), `${JSON.stringify({ schema_version: 1, kind: "revoy2.stop_baseline_debt", entries: [
      { gate, owner: "ADR-001", reason: "red before this session", opened_at: "2026-10-06T00:00:00.000Z", opened_at_revision: head, observed_exit_code: 1 },
    ] }, null, 2)}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "own debt");
  };

  it("schedules out a declared gate whose inputs are untouched, never an undeclared one, and schedules it back in when its input changes", async () => {
    installProfile();
    const battery = argvBattery(0, GREEN_OUTPUT);
    const e = env({ ARBOR_SESSION_WINDOW_STATE: "none no session record", ARBOR_STOP_GATE_BATTERY_CMD: battery.cmd, ARBOR_STOP_GUARD_STATE_DIR: stateDir });
    await settle("s-scope", e);
    expect(skipOf(argvSeen(battery.argvLog)[0] ?? [])).toEqual(["gate:docs"]);

    writeFileSync(join(root, "docs", "a.md"), "edited\n");
    await measureStopBattery({ event: "turn_end", hook_id: "h", version: "1.0.0", session_id: "s-scope", summary: "s", detail: {} } as never, e);
    const second = argvSeen(battery.argvLog)[1] ?? [];
    expect(second).toContain("--tier");
    expect(second).not.toContain("--skip");
  });

  it("keeps a committed change in the changed set: the base is the session's FIRST measurement, not HEAD", async () => {
    installProfile();
    const battery = argvBattery(0, GREEN_OUTPUT);
    const e = env({ ARBOR_SESSION_WINDOW_STATE: "none no session record", ARBOR_STOP_GATE_BATTERY_CMD: battery.cmd, ARBOR_STOP_GUARD_STATE_DIR: stateDir });
    await settle("s-base", e);
    writeFileSync(join(root, "docs", "a.md"), "committed edit\n");
    git("commit", "-q", "-am", "edit docs");
    await measureStopBattery({ event: "turn_end", hook_id: "h", version: "1.0.0", session_id: "s-base", summary: "s", detail: {} } as never, e);
    expect(skipOf(argvSeen(battery.argvLog)[1] ?? [])).toEqual([]);
  });

  it("ARBOR_STOP_BATTERY_SCOPE=all runs the whole tier", async () => {
    installProfile();
    const battery = argvBattery(0, GREEN_OUTPUT);
    const e = env({ ARBOR_SESSION_WINDOW_STATE: "none no session record", ARBOR_STOP_GATE_BATTERY_CMD: battery.cmd, ARBOR_STOP_GUARD_STATE_DIR: stateDir, ARBOR_STOP_BATTERY_SCOPE: "all" });
    await settle("s-all", e);
    expect(argvSeen(battery.argvLog)[0]).not.toContain("--skip");
  });

  it("allows a turn whose only blocking red is owned baseline debt", async () => {
    installProfile();
    ownDebt("gate:typecheck-tests");
    const battery = installBattery(fixtureDir, 1, FAILING_OUTPUT);
    const e = env({ ARBOR_SESSION_WINDOW_STATE: "none no session record", ARBOR_STOP_GATE_BATTERY_CMD: battery.cmd, ARBOR_STOP_GUARD_STATE_DIR: stateDir });
    await settle("s-owned", e);
    const outcome = await judged("s-owned", e);
    expect(outcome.decision).toBe("allowed");
    expect(outcome.refusal).toBeNull();
  });

  it("still blocks an unowned red beside owned debt, names only the unowned one as the session's, and renders the debt as one line", async () => {
    installProfile();
    ownDebt("gate:typecheck-tests");
    const battery = installBattery(fixtureDir, 1, FAILING_OUTPUT_TWO);
    const e = env({ ARBOR_SESSION_WINDOW_STATE: "none no session record", ARBOR_STOP_GATE_BATTERY_CMD: battery.cmd, ARBOR_STOP_GUARD_STATE_DIR: stateDir });
    await settle("s-mixed", e);
    const outcome = await judged("s-mixed", e);
    expect(outcome.decision).toBe("blocked");
    expect(outcome.refusal).toContain("gate:build");
    expect(outcome.refusal).toContain("gate:typecheck-tests (exit 1) owned by ADR-001");
    // The breaker fingerprints the session's reds only, so owned debt cannot
    // make two different session failures look like the same one.
    expect(breakerOf("s-mixed", e).fingerprint).toBe(computeFingerprint([{ gate: "gate:build", exit_code: "2" }]));
  });

  it("a debt entry whose owner record does not exist owns nothing, so the red blocks", async () => {
    installProfile();
    ownDebt("gate:typecheck-tests");
    rmSync(join(root, "decisions", "ADR-001-owner.md"));
    git("commit", "-q", "-am", "drop the owner");
    const battery = installBattery(fixtureDir, 1, FAILING_OUTPUT);
    const e = env({ ARBOR_SESSION_WINDOW_STATE: "none no session record", ARBOR_STOP_GATE_BATTERY_CMD: battery.cmd, ARBOR_STOP_GUARD_STATE_DIR: stateDir });
    await settle("s-unowned", e);
    expect((await judged("s-unowned", e)).decision).toBe("blocked");
  });
});
