/**
 * The native replacement for `scripts/hooks/gate-stop.sh` (deleted in this
 * commit) and its no-progress circuit breaker `scripts/hooks/stop-guard.mjs`
 * (deleted in this commit).
 *
 * ============================================================================
 * THE TWO HALVES, AND WHY THEY ARE TWO. The refusal a turn needs is the
 * worker's `turn_gate` (`arbor-harness/src/native-worker.ts`), which is
 * consulted immediately before the single `complete(...)` call and whose text is
 * fed back to the model. The measurement a refusal must be based on is the
 * `turn_end` observe event, whose whole property is that it costs the turn
 * nothing. Splitting them is the affordability argument made structural:
 *
 *   - MEASURE, out of band, bounded, cached — `stopBatteryMeasure`.
 *   - JUDGE, in line, cheap, synchronous fs — `stopBatteryTurnGate`.
 *
 * The measurement NEVER runs inside the gate. `gate:stop-budget` is RED on this
 * tree (a measured median of ~30s against a 25000 ms ceiling that may only
 * ever FALL), and `vi-graph-debt.ts`'s header records what a synchronous handler
 * cost this suite: it took the native production e2e from 4/4 to 2/4 on its
 * wall-clock budget. A guard that made the model wait 30s to learn the gates
 * are red would be unaffordable and would be turned off.
 *
 * ============================================================================
 * THE DEFERRAL IS WHAT MAKES IT AFFORDABLE, AND IT IS DECIDED PER STATE.
 * `windowState()` reports one of `none`, `open`,
 * `closing`, `closing-stale`, `closed-green`, `closed-red`. Exactly three of
 * those six stand the battery down, and the asymmetry is ADR-160 §4's explicit
 * choice rather than an oversight:
 *
 *   - `open`         — commits and gates are deferred to the session close, so
 *                      the battery runs there once as one contiguous process.
 *   - `closed-green` — the close receipt is already green AT HEAD; re-running
 *                      proves nothing new.
 *   - `closing-stale`— the window's actor is gone or its TTL lapsed, so the
 *                      deferral can never END on its own. Left in the
 *                      fall-through it charges every such session forever.
 *   - `closing`      — NOT deferred. A live actor still exists to run
 *                      `--finish`, which is precisely the case the deferral
 *                      was for, so the veto stays. This is the single easiest
 *                      thing to get wrong in either direction and each half has
 *                      its own test.
 *
 * ============================================================================
 * THE CACHE KEY IS WHAT THE BATTERY MEASURES, OR THE VERDICT IS A LIE. Three
 * inputs, all measured, none of them wall-clock: the HEAD oid, the uncommitted
 * dirty-path COUNT, and the tier/advisory fingerprint. A time-based TTL is
 * exactly the defect the brief names — a gate cleared at 10:00 says nothing
 * about the commit that landed at 10:01, and a verdict that outlives its inputs
 * is worse than no verdict because it is confident. The count rather than the
 * path SET is deliberate and is the one place this is coarser than it could be:
 * `gate:all`'s stop tier reasons over the whole worktree, so two different
 * trees of the same cardinality can in principle produce different verdicts.
 * The dirty COUNT is retained as an additional key so an edit that leaves the
 * count unchanged still cannot ride a verdict measured before it.
 *
 * AT MOST ONE BATTERY IS IN FLIGHT PER SESSION. Without that, N concurrent
 * turn boundaries spawn N copies of a 37-gate battery — a stampede, which is
 * strictly worse than the per-turn cost this whole design exists to remove. A
 * turn that arrives while a battery is in flight is DEFERRED, and says so.
 *
 * ============================================================================
 * ARBORETUM M2: SCHEDULED BY INPUTS, WITH OWNED BASELINE DEBT. The measuring
 * half records the session's base (HEAD at its first measurement), computes
 * the paths changed since it, and passes every stop gate whose DECLARED inputs
 * (`inputs` in `scripts/execution-profile.json`, widened by the gate's own
 * import closure) none of those paths touch as `--skip`. A gate with no
 * declaration always runs. A blocking red that `scripts/stop-guard/debt.json`
 * owns is attributed to the baseline: it is rendered as one line and does not
 * refuse the turn, while any red it does not own still does. The scheduling
 * and the debt rules live in `stop-battery-scope.ts`.
 *
 * ============================================================================
 * NOTHING IS EVER SILENTLY DROPPED. Three states produce no refusal, and each
 * is distinguishable in the ledger and carries its own message:
 *   - deferred (window stand-down, battery in flight, no verdict yet)
 *   - allowed (green)
 *   - released (the breaker granted an escape valve)
 * Anything else — a battery that failed to name a gate, one that exceeded its
 * own bound, one whose spawn died — BLOCKS with a message naming the failure
 * class. A guard that fails open is the defect class this bus exists to
 * eliminate, so the failure direction here is always the expensive one.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { GitAdapter } from "../git-workspace-projection.js";
import { windowState } from "../repo-session-lifecycle.js";
import { HOOK_MAX_NOTE_BYTES } from "./contracts.js";
import { currentGovernedRoot } from "./governance-tropisms.js";
import {
  attributeBaselineDebt, changedPathsSince, changedSetDigest, loadBaselineDebt, parsePorcelainZ, readScheduleInputs, renderOwnedDebt, scheduleStopGates,
} from "./stop-battery-scope.js";
import type { ChangedPathSet, OwnedRed, StopSchedule } from "./stop-battery-scope.js";
import type { HookObserveContext, HookObserveHandler, HookObserveOutcome } from "./contracts.js";

// --- the bounds, and where each one comes from ---------------------------

/**
 * The breaker's threshold as the deleted module read it. It is the CONFIGURED
 * value only; `effectiveMaxNoProgress` is what the breaker actually applies.
 */
export const DEFAULT_MAX_NO_PROGRESS = 3;

/**
 * `NativeHarnessWorkerOptions.turn_gate` refuses a turn under
 * `MAX_TURN_GATE_REFUSALS`, which is `2` in `arbor-harness/src/native-worker.ts`
 * and is deliberately the same magnitude as that file's
 * `MAX_STRUCTURED_RETRIES`. Duplicated here as a named constant rather than
 * imported because `@arbor/harness` must not be imported from the other
 * direction for this, and because the CLAMP is the point: see
 * `effectiveMaxNoProgress`.
 */
export const NATIVE_TURN_REFUSAL_BUDGET = 2;

/**
 * The battery's own wall-clock bound. This is the repo's ratcheted
 * `gate:stop-budget` ceiling (`scripts/gate-budget/stop-budget.json`), read as
 * a constant rather than re-derived, and it is NOT a weakening of that ratchet:
 * exceeding it is a MEASUREMENT FAILURE, which blocks with its own message and
 * never releases. The ceiling itself is untouched by this commit.
 *
 * The honest consequence, stated rather than hidden: the stop tier currently
 * measures ~30s against this 25000 ms ceiling, so the overrun path is the
 * COMMON path on this tree today, not a theoretical one. That is what
 * `gate:stop-budget` is RED about, and this module reports the same condition
 * as a block rather than pretending to a green.
 */
export const STOP_BATTERY_TIMEOUT_MS = 25_000;

/** The tier and advisory set the deleted script always ran. Both are cache keys. */
const BATTERY_TIER = "stop";
const BATTERY_ADVISORY = "hook-default";

// --- the script's own types, carried across ------------------------------

export interface RedGate {
  readonly gate: string;
  readonly exit_code: string;
}

/** What `windowState()` reports, as the string the shell's `case` matched. */
export type WindowState = "none" | "open" | "closing" | "closing-stale" | "closed-green" | "closed-red";

/** Exactly the three states ADR-160 §4 and the 2026-09-29 amendment stand down. */
const DEFERRED_STATES: readonly WindowState[] = Object.freeze(["open", "closed-green", "closing-stale"]);

export function windowStateIsDeferred(state: string): boolean {
  return (DEFERRED_STATES as readonly string[]).includes(state);
}

export interface BatteryRun {
  readonly status: number;
  readonly output: string;
}

export type StopBatteryDecision = "allowed" | "blocked" | "released" | "deferred";

export interface StopBatteryOutcome {
  readonly decision: StopBatteryDecision;
  /** The text handed to the model. `null` whenever nothing is refused. */
  readonly refusal: string | null;
  /** Set only for `deferred`, and always names WHICH deferral. */
  readonly deferral: string | null;
}

const ALLOW: StopBatteryOutcome = Object.freeze({ decision: "allowed", refusal: null, deferral: null });
const defer = (why: string): StopBatteryOutcome => Object.freeze({ decision: "deferred", refusal: null, deferral: why });

// --- parsing gate-all.mjs's human-readable failure report ----------------

/**
 * Ported from `parseRedGates` in the deleted module, unchanged in behaviour.
 *
 * Blocking failures print under "N of M gate(s) FAILED:"; advisory-red gates
 * print separately under "advisory gate(s) are red" and never move the exit
 * code. Splitting on the advisory header FIRST is what keeps a blocking gate
 * from being misread as advisory, and vice versa. ADR-113 decision 1 also
 * collapses same-cause failures into one "SHARED CAUSE" header with indented
 * list-item lines, so both shapes are matched and the extracted set — and
 * therefore the fingerprint — is identical either way.
 */
export function parseRedGates(output: string | null | undefined): { readonly blocking: readonly RedGate[]; readonly advisory: readonly RedGate[] } {
  const text = output ?? "";
  const advisoryHeader = text.match(/^.*advisory gate\(s\) are red.*$/m);
  const splitIndex = advisoryHeader?.[0] === undefined ? text.length : text.indexOf(advisoryHeader[0]);
  const extract = (chunk: string): readonly RedGate[] => {
    const gates: RedGate[] = [];
    for (const match of chunk.matchAll(/^ {2}(\S+) \(exit (-?\d+|null)\):$/gm)) gates.push(Object.freeze({ gate: match[1] as string, exit_code: match[2] as string }));
    for (const match of chunk.matchAll(/^ {4}- (\S+) \(exit (-?\d+|null)\)$/gm)) gates.push(Object.freeze({ gate: match[1] as string, exit_code: match[2] as string }));
    return Object.freeze(gates);
  };
  return Object.freeze({ blocking: extract(text.slice(0, splitIndex)), advisory: extract(text.slice(splitIndex)) });
}

/** Stable hash of the sorted blocking-failure set. A change here is progress. */
export function computeFingerprint(blocking: readonly RedGate[]): string {
  const sorted = [...blocking].map(({ gate, exit_code }) => `${gate}:${exit_code}`).sort();
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

/**
 * A non-zero battery that named no blocking gate. A named predicate rather than
 * `length === 0` because it is a distinct FAILURE CLASS, not an empty list, and
 * conflating the two is what produced the 31 historical releases that all
 * shared `sha256("[]")` (ADR-154).
 */
export function isUnnameableFailure(blocking: readonly RedGate[] | null | undefined): boolean {
  return (blocking ?? []).length === 0;
}

/** The configured threshold, as the deleted module's `readMaxNoProgress` read it. */
export function readMaxNoProgress(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ARBOR_STOP_GUARD_MAX_NO_PROGRESS;
  if (raw === undefined || raw === "") return DEFAULT_MAX_NO_PROGRESS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_NO_PROGRESS;
}

/**
 * WHICH BOUND GOVERNS, and why. The worker's `turn_gate` can refuse at most
 * `NATIVE_TURN_REFUSAL_BUDGET` times per session run, so a threshold above it
 * is a release nothing can ever reach: the breaker's "cannot block forever"
 * guarantee would rest on a counter the mechanism cannot advance past 2, and
 * the smaller number would have silently disabled the larger one.
 *
 * So the BUDGET governs and the threshold is clamped down to it. Both numbers
 * are recorded on the release journal entry, so the clamp is ATTRIBUTED rather
 * than a threshold that quietly became a different threshold. An operator may
 * still set a LOWER value, and a higher one is honoured only as far as the
 * budget allows.
 */
export function effectiveMaxNoProgress(env: NodeJS.ProcessEnv = process.env): number {
  // STRICTLY below the budget, not at it. Releasing needs `consecutive_count >
  // maxNoProgress`, so a threshold EQUAL to the budget is unreachable: the
  // budget is spent refusing, and the next turn the gate is no longer consulted
  // at all. One less is what makes the release land on the last refusal the
  // budget can actually pay for.
  return Math.max(1, Math.min(readMaxNoProgress(env), NATIVE_TURN_REFUSAL_BUDGET - 1));
}

// --- the messages, carried across verbatim in substance ------------------

/** Known escape mechanisms for the gates that are advisory (operator-gated) today. */
const ADVISORY_MECHANISMS = new Map<string, string>([
  ["gate:vi-findings", "operator verdict — triage the finding(s) with `bun scripts/vi-findings.mjs --triage <finding_id> --verdict <verdict> --reason \"...\"`; a model cannot record this verdict on its own behalf."],
  ["gate:hollow-parity", "operator verdict per D42 — wire the surface to a product path or record an explicit api-only disposition with a reason; this is not fixable by re-running anything."],
  ["gate:store-freshness", "not an operator verdict — it is red because the working tree is dirty; commit or refresh the evidence stores and it clears on its own."],
]);

const advisoryMechanism = (gate: string): string => ADVISORY_MECHANISMS.get(gate)
  ?? "operator verdict — this gate is advisory because a model resolving it would fabricate the human decision it exists to prove; if it reflects an owed decision, ask it natively (`bun run interview:pack`, AskUserQuestion or `arbor interview`) and record it with `bun run interview:record`, or use the gate's own triage command.";

export function buildBlockMessage(output: string): string {
  return [
    "BLOCKING: the stop-tier gate battery is red. Do not report this work as",
    "complete until these pass or you state explicitly which are pre-existing",
    "and why they are out of scope.",
    "",
    output,
    "",
    "Re-run with: bun run gate:all --tier stop",
  ].join("\n");
}

/** Its own message, because "nothing was checked" is a different problem with a different fix. */
export function buildUnnameableFailureMessage(output: string): string {
  return [
    "BLOCKING: the stop-tier gate battery exited non-zero but reported no failing",
    "gate, so it failed BEFORE any gate reported. Nothing was checked.",
    "",
    "The no-progress circuit breaker does not apply here and will never release",
    "this: it can only judge repetition of a KNOWN set of red gates, and there is",
    "no such set to repeat. This blocks every time until the battery itself runs.",
    "",
    "Likely causes, in the order worth checking:",
    "  - roster drift: a gate:* in package.json with no tier in scripts/gate-all.mjs",
    "    GATE_TIERS, or the reverse. The battery deliberately runs NO gates in this",
    "    state, because a green battery over a wrong roster proves nothing.",
    "  - an unrecognized --tier or execution-context name passed to the battery.",
    "  - the battery process itself crashed before printing a failure section.",
    "",
    "Battery output:",
    "",
    output,
    "",
    "Re-run with: bun run gate:all --tier stop",
  ].join("\n");
}

/**
 * A battery that could not be MEASURED, as distinct from one that measured
 * red. Named separately because the two have different remedies: this one says
 * the measurement itself failed and how long it was given, so an operator does
 * not go looking for a red gate that was never named.
 */
export function buildMeasurementFailureMessage(reason: string, boundMs: number): string {
  return [
    "BLOCKING: the stop-tier gate battery could not be MEASURED, so nothing was judged.",
    "",
    `Reason: ${reason}`,
    "",
    `It was given ${boundMs} ms — this repository's own ratcheted ceiling from`,
    "scripts/gate-budget/stop-budget.json. Exceeding that ceiling is the condition",
    "`gate:stop-budget` reports, and it is deliberately NOT treated as a pass: a",
    "battery that did not finish has proved nothing about the gates.",
    "",
    "This blocks until the battery completes inside its bound. Run it by hand to",
    "see where the time goes:",
    "",
    "Re-run with: bun run gate:all --tier stop",
  ].join("\n");
}

export function buildReleaseMessage(args: {
  readonly output: string;
  readonly blocking: readonly RedGate[];
  readonly advisory: readonly RedGate[];
  readonly consecutiveCount: number;
  readonly maxNoProgress: number;
  readonly configuredMaxNoProgress: number;
}): string {
  const lines: string[] = [];
  lines.push(`STOP GUARD RELEASED: this session hit the same gate-battery failure ${args.consecutiveCount} consecutive times (threshold ${args.maxNoProgress}${args.maxNoProgress === args.configuredMaxNoProgress ? "" : `, clamped from a configured ${args.configuredMaxNoProgress} because the turn gate can only refuse ${NATIVE_TURN_REFUSAL_BUDGET} times`}), so this turn is no longer refused.`);
  lines.push("This is an escape valve, NOT a pass: the work is NOT complete and must NOT be reported as");
  lines.push("complete or done. The gates below are still red:");
  lines.push("");
  for (const { gate, exit_code } of args.blocking) {
    lines.push(`  - ${gate} (exit ${exit_code}) — BLOCKING gate. Its remedy is in the battery output below; re-run \`bun run gate:all --tier stop\` after applying it.`);
  }
  for (const { gate, exit_code } of args.advisory) {
    lines.push(`  - ${gate} (exit ${exit_code}) — advisory gate, ${advisoryMechanism(gate)}`);
  }
  lines.push("");
  lines.push("Full battery output for reference:");
  lines.push("");
  lines.push(args.output);
  return lines.join("\n");
}

// --- the breaker's pure decision, ported unchanged ------------------------

export interface BreakerState {
  readonly fingerprint: string | null;
  readonly consecutive_count: number;
  readonly released: boolean;
}

export const EMPTY_BREAKER_STATE: BreakerState = Object.freeze({ fingerprint: null, consecutive_count: 0, released: false });

export interface BreakerDecision {
  readonly nextState: BreakerState;
  readonly released: boolean;
  readonly consecutiveCount: number;
}

/**
 * Ported verbatim from `evaluate` in the deleted module. `stayedReleased` is
 * load-bearing: a release already granted for a fingerprint STAYS granted and
 * the counter keeps incrementing, so the breaker never re-arms on a failure it
 * already declared unfixable by this session.
 */
export function evaluate(prior: BreakerState | null, fingerprint: string, maxNoProgress: number): BreakerDecision {
  const stayedReleased = prior !== null && prior.fingerprint === fingerprint && prior.released;
  const consecutiveCount = stayedReleased || (prior !== null && prior.fingerprint === fingerprint) ? prior.consecutive_count + 1 : 1;
  const released = stayedReleased || consecutiveCount > maxNoProgress;
  return Object.freeze({ nextState: Object.freeze({ fingerprint, consecutive_count: consecutiveCount, released }), released, consecutiveCount });
}

// --- the persisted verdict ------------------------------------------------

/**
 * What a battery run produced, cached on the inputs it measured. Persisted
 * per session beside the breaker's own state so the JUDGING half never has to
 * spawn anything: the measurement is out of band, and the file is the handoff
 * between the two halves.
 */
export interface CachedVerdict {
  /** HEAD oid + uncommitted dirty-path count + tier + advisory, joined. */
  readonly measured: string;
  readonly status: number;
  readonly output: string;
  readonly blocking: readonly RedGate[];
  readonly advisory: readonly RedGate[];
  /** Set only when the battery could not be measured at all. */
  readonly measurement_failure: string | null;
  readonly measured_at: string;
  /**
   * Arboretum M2. The blocking reds an owned `scripts/stop-guard/debt.json`
   * entry covers. A subset of `blocking`, which keeps every parsed red so the
   * output and the record can never disagree about what was red. Absent on a
   * verdict persisted before M2, which reads as no owned debt.
   */
  readonly owned_debt?: readonly OwnedRed[];
  /** The gates this measurement scheduled out as `--skip`, by declared inputs. */
  readonly scheduled_out?: readonly string[];
}

interface StopGuardFile {
  readonly verdict: CachedVerdict | null;
  readonly breaker: BreakerState;
  /** The window state that last stood the battery down, for the ledger note. */
  readonly deferred_by: string | null;
  /**
   * The inputs measured on the LAST turn boundary, written by the observer in
   * the same tick it wrote `verdict`. The gate compares the two instead of
   * re-measuring: the observer has just measured, so a disagreement means the
   * verdict was overtaken, and re-measuring here would cost two `git` spawns
   * on every single turn to learn the same thing.
   */
  readonly measured: string | null;
  /**
   * Arboretum M2. HEAD at this session's first measurement: the base its
   * changed-path set is diffed from. Recorded once and never moved, so a
   * commit the session makes stays in its changed set.
   */
  readonly base: string | null;
}

const EMPTY_FILE: StopGuardFile = Object.freeze({ verdict: null, breaker: EMPTY_BREAKER_STATE, deferred_by: null, measured: null, base: null });

// --- state location -------------------------------------------------------

/**
 * Where the breaker's per-session state and release journal live, under the git
 * COMMON dir so it is shared across worktrees and never in the working tree.
 *
 * `ARBOR_STOP_GUARD_STATE_DIR` is honoured exactly as the deleted module
 * honoured it, and `scripts/lib/stop-guard-state.mjs` resolves the same path for
 * `gate:stop-guard-releases`, which reads `releases.jsonl` from here. Two
 * implementations of one path in two languages is a drift risk that would make
 * the release gate read an empty journal forever and report honestly on nothing,
 * so `stop-battery.test.ts` pins the two to the same directory.
 */
const stateDirs = new Map<string, string>();

export function stopGuardStateDir(root: string, env: NodeJS.ProcessEnv = process.env, sessionId = ""): string {
  const override = env.ARBOR_STOP_GUARD_STATE_DIR;
  if (override !== undefined && override !== "") return override;
  // Resolving this costs two `git` spawns, so it is memoized PER SESSION. The
  // turn gate consults the state on every turn and must not pay it per turn —
  // three `git` subprocesses on a turn boundary is the exact cost that took
  // the native production e2e from 4/4 to 2/4 (see vi-graph-debt.ts).
  const memo = sessionId === "" ? "" : stateDirs.get(sessionId) ?? "";
  if (memo !== "") return memo;
  const resolved = join(new GitAdapter(root).common_dir, "arbor", "stop-guard");
  if (sessionId !== "") stateDirs.set(sessionId, resolved);
  return resolved;
}

// --- the measurement ------------------------------------------------------

/** One in-flight battery per session. An unbounded per-turn spawn is a stampede. */
const inFlight = new Map<string, Promise<unknown>>();

export const batteryCommand = (env: NodeJS.ProcessEnv, skip: readonly string[] = []): readonly string[] => {
  const override = env.ARBOR_STOP_GATE_BATTERY_CMD;
  // Word-split deliberately: the deleted script's own override could be a
  // multi-token command, and a test override still needs to be one.
  const argv = override !== undefined && override.trim() !== "" ? override.trim().split(/\s+/) : ["bun", "scripts/gate-all.mjs"];
  // `--skip` only when something is scheduled out, so an unscoped battery's
  // argv is byte-identical to the pre-M2 one.
  const scoped = skip.length > 0 ? ["--skip", skip.join(",")] : [];
  return Object.freeze([...argv, "--tier", BATTERY_TIER, "--advisory", env.ARBOR_STOP_BATTERY_ADVISORY ?? BATTERY_ADVISORY, ...scoped]);
};

const runBattery = (root: string, env: NodeJS.ProcessEnv, skip: readonly string[] = []): Promise<BatteryRun> => new Promise((resolve) => {
  const argv = batteryCommand(env, skip);
  const child = spawn(argv[0] as string, argv.slice(1), { cwd: root, env, shell: false });
  let output = "";
  let settled = false;
  const finish = (status: number): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(Object.freeze({ status, output: output.slice(0, STOP_BATTERY_OUTPUT_BYTES) }));
  };
  const timer = setTimeout(() => { child.kill("SIGKILL"); finish(124); }, STOP_BATTERY_TIMEOUT_MS);
  const collect = (chunk: Buffer | string): void => { if (output.length < STOP_BATTERY_OUTPUT_BYTES) output += chunk.toString(); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.on("error", (error: Error) => { output += `\nstop-battery: the battery could not be spawned: ${error.message}`; finish(127); });
  child.on("close", (code) => finish(code ?? 1));
});

/**
 * How much battery output is kept. Bounded because it is persisted per session
 * and interpolated into model-facing text, and because the block message is
 * itself sliced again to the harness's `TURN_GATE_REASON_BYTES`.
 */
const STOP_BATTERY_OUTPUT_BYTES = 16 * 1024;

/**
 * The REGISTRY entry's bound, which governs the ledger NOTE and nothing else.
 * It is the battery's own ceiling plus slack for the window-state read, so
 * crossing it drops a note the handler has already made durable: the verdict
 * is written to the per-session state file by the handler itself, and the
 * over-run inside the handler's spawn is already a BLOCKING measurement
 * failure. The two bounds are therefore independent on purpose — a handler
 * that exceeded this one has still produced a verdict.
 */
export const STOP_BATTERY_HANDLER_BOUND_MS = STOP_BATTERY_TIMEOUT_MS + 5_000;

export function batteryTimeoutSignal(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.ARBOR_STOP_BATTERY_TIMEOUT_MS ?? "", 10);
  return Number.isInteger(raw) && raw > 0 ? raw : STOP_BATTERY_TIMEOUT_MS;
}

/** Whether input scoping is on. `ARBOR_STOP_BATTERY_SCOPE=all` runs the whole tier, explicitly and on the record. */
export const batteryScopeIsAll = (env: NodeJS.ProcessEnv): boolean => (env.ARBOR_STOP_BATTERY_SCOPE ?? "").trim() === "all";

export interface TreeMeasurement {
  /** The cache key: HEAD, dirty count, tier, advisory, and the changed-set digest. */
  readonly key: string;
  readonly head: string | null;
  readonly changed: ChangedPathSet;
}

/**
 * The measured inputs. M2 adds the changed-path set's digest to the key, which
 * is strictly finer than the dirty COUNT it sits beside: two trees with the
 * same number of dirty paths but different paths now schedule, and so cache,
 * separately. No wall clock is among the inputs, on purpose: a TTL would let a
 * verdict outlive the commit that made it green.
 */
export function measureTree(git: GitAdapter, env: NodeJS.ProcessEnv, base: string | null): TreeMeasurement {
  const head = git.run(["rev-parse", "HEAD"]);
  const oid = head.ok ? head.stdout.trim() : `unresolved(${head.exit_code})`;
  const status = git.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const dirty = status.ok ? parsePorcelainZ(status.stdout).length : -1;
  const changed = head.ok && status.ok
    ? changedPathsSince(git, git.repository_root, base, oid, status.stdout)
    : Object.freeze({ paths: Object.freeze([]), complete: false, problems: Object.freeze([head.ok ? "git status failed" : "HEAD did not resolve"]) });
  const scope = batteryScopeIsAll(env) ? "all" : changedSetDigest(changed);
  return Object.freeze({
    key: [oid, String(dirty), BATTERY_TIER, env.ARBOR_STOP_BATTERY_ADVISORY ?? BATTERY_ADVISORY, scope].join("|"),
    head: head.ok ? oid : null,
    changed,
  });
}

/** The schedule for one measurement, or run-everything with the reason. */
function scheduleFor(root: string, env: NodeJS.ProcessEnv, changed: ChangedPathSet): StopSchedule {
  if (batteryScopeIsAll(env)) return Object.freeze({ skip: Object.freeze([]), undeclared: Object.freeze([]), ran_everything_because: "ARBOR_STOP_BATTERY_SCOPE=all" });
  const inputs = readScheduleInputs(root);
  if (inputs === null) return Object.freeze({ skip: Object.freeze([]), undeclared: Object.freeze([]), ran_everything_because: "scripts/execution-profile.json or package.json is unreadable" });
  return scheduleStopGates({ root, profile: inputs.profile, packageJson: inputs.packageJson, changed });
}

const readWindowState = (root: string, env: NodeJS.ProcessEnv): string => {
  const override = env.ARBOR_SESSION_WINDOW_STATE;
  if (override !== undefined && override.trim() !== "") return override.trim().split(/\s+/)[0] as string;
  return windowState(root).state;
};

const batteryIsSkipped = (env: NodeJS.ProcessEnv): boolean => (env.ARBOR_SKIP_STOP_GATES ?? "") !== "";

// --- persistence ----------------------------------------------------------

const readFile = (dir: string, sessionId: string): StopGuardFile => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, `${sessionId}.json`), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return EMPTY_FILE;
    const record = parsed as Partial<StopGuardFile>;
    return Object.freeze({
      verdict: typeof record.verdict === "object" && record.verdict !== null ? record.verdict as CachedVerdict : null,
      breaker: typeof record.breaker === "object" && record.breaker !== null ? record.breaker as BreakerState : EMPTY_BREAKER_STATE,
      deferred_by: typeof record.deferred_by === "string" ? record.deferred_by : null,
      measured: typeof record.measured === "string" ? record.measured : null,
      base: typeof record.base === "string" ? record.base : null,
    });
  } catch { return EMPTY_FILE; }
};

const writeFile = (dir: string, sessionId: string, file: StopGuardFile): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.json`), `${JSON.stringify(file, null, 2)}\n`);
};

const appendRelease = (dir: string, entry: Record<string, unknown>): void => {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "releases.jsonl"), `${JSON.stringify(entry)}\n`);
};

// --- the two halves -------------------------------------------------------

/**
 * The MEASURING half: reach a battery without the turn waiting for it, and
 * cache what it found against what it measured.
 *
 * Async is load-bearing for the same reason it is in `vi-graph-debt.ts`: this
 * reads the repository-session window state and then the battery itself, and a synchronous
 * handler would spend both on the turn boundary's stack. Returning the promise
 * is what makes the bus record `pending=` now and settle out of band under the
 * handler's declared `timeout_ms`.
 */
export function measureStopBattery(context: HookObserveContext, env: NodeJS.ProcessEnv = process.env): Promise<HookObserveOutcome> {
  if (context.event !== "turn_end") return Promise.resolve(undefined);
  const sessionId = context.session_id;
  if (sessionId === null || sessionId === "") return Promise.resolve(undefined);
  const root = currentGovernedRoot();
  return (async (): Promise<HookObserveOutcome> => {
    if (batteryIsSkipped(env)) {
      // The script's own escape hatch, deliberately explicit and deliberately
      // logged: a guard with no bypass gets bypassed by disabling it wholesale.
      return { note: "stop-battery: skipped via ARBOR_SKIP_STOP_GATES" };
    }
    const windowState = readWindowState(root, env);
    if (windowStateIsDeferred(windowState)) {
      const dir = stopGuardStateDir(root, env, sessionId);
      const prior = readFile(dir, sessionId);
      writeFile(dir, sessionId, Object.freeze({ verdict: prior.verdict, breaker: prior.breaker, deferred_by: windowState, measured: prior.measured, base: prior.base }));
      // Not `void`. A stand-down that produced no trace is indistinguishable
      // from a guard that was never wired, which is this repository's most
      // repeated defect.
      return { note: `stop-battery: deferred — window ${windowState}; gates and commits run at the session close`, derived_from: [`window:${windowState}`] };
    }

    const running = inFlight.get(sessionId);
    if (running !== undefined) {
      return { note: "stop-battery: a battery is already in flight for this session; this turn is deferred, not judged" };
    }

    let git: GitAdapter;
    try { git = new GitAdapter(root); }
    catch (error) {
      return { note: `stop-battery: could not resolve the repository: ${error instanceof Error ? error.message : "unknown error"}`, derived_from: ["measure:unresolved"] };
    }
    const dir = stopGuardStateDir(root, env, sessionId);
    const prior = readFile(dir, sessionId);
    const tree = measureTree(git, env, prior.base);
    const measured = tree.key;
    // The base is fixed at the session's first measurement and never moved.
    const base = prior.base ?? tree.head;
    // A cache hit is a note saying which measurement it is reporting, so a
    // reader can tell "nothing to do" from "reporting a stale measurement".
    if (prior.verdict !== null && prior.verdict.measured === measured) {
      return { note: `stop-battery: ${verdictSummary(prior.verdict)} (cached on head+dirty-count+tier+changed-set)`, derived_from: [`verdict:${measured}`] };
    }

    const schedule = scheduleFor(root, env, tree.changed);
    const skip = schedule.skip.map((entry) => entry.gate);
    const work = (async (): Promise<CachedVerdict> => {
      const run = await runBattery(root, env, skip);
      const { blocking, advisory } = parseRedGates(run.output);
      // The battery READS the debt record and never writes it. Attribution is
      // by gate name against an entry that names an existing decision record.
      const { owned } = attributeBaselineDebt(blocking, loadBaselineDebt(root).entries);
      return Object.freeze({
        measured, status: run.status, output: run.output, blocking, advisory,
        owned_debt: owned,
        scheduled_out: Object.freeze(skip),
        // A spawn that died or a run that blew the bound is a MEASUREMENT
        // failure, which is a distinct class from a red battery and gets its
        // own message rather than being folded into "gates are red".
        measurement_failure: run.status === 124 ? `it did not finish inside ${batteryTimeoutSignal(env)} ms` : run.status === 127 ? "the battery process could not be spawned" : null,
        measured_at: new Date().toISOString(),
      });
    })();
    inFlight.set(sessionId, work);
    try {
      const verdict = await work;
      // The observer RECORDS and never JUDGES. Advancing the breaker's counter
      // here would consume refusals the model never saw, because a measurement
      // is not a refusal: the same battery is measured once and then consulted
      // by every turn it covers. The breaker belongs to the gate alone.
      writeFile(dir, sessionId, Object.freeze({ verdict, breaker: EMPTY_BREAKER_STATE, deferred_by: null, measured, base }));
      const summary = verdictSummary(verdict);
      const scope = schedule.ran_everything_because !== null
        ? `; whole tier (${schedule.ran_everything_because})`
        : `; ${skip.length} scheduled out by inputs, ${schedule.undeclared.length} undeclared always run`;
      return {
        note: `stop-battery: ${summary}${scope}${verdict.status === 0 || verdict.measurement_failure === null ? "" : " — the turn gate will refuse on this"}`,
        derived_from: [`verdict:${measured}`, `fingerprint:${computeFingerprint(unownedBlocking(verdict))}`],
      };
    } catch (error) {
      return { note: `stop-battery: the battery handler failed: ${error instanceof Error ? error.message : "unknown error"}` };
    } finally {
      inFlight.delete(sessionId);
    }
  })();
}

/** Whether a battery is currently running for a session. */
export const batteryInFlight = (sessionId: string): boolean => inFlight.has(sessionId);

/** The blocking reds no owned debt entry covers: the ones that are this session's. */
export function unownedBlocking(verdict: CachedVerdict): readonly RedGate[] {
  const owned = new Set((verdict.owned_debt ?? []).map((entry) => entry.gate));
  return verdict.blocking.filter((entry) => !owned.has(entry.gate));
}

function verdictSummary(verdict: CachedVerdict): string {
  if (verdict.measurement_failure !== null) return `unmeasured (${verdict.measurement_failure})`;
  if (verdict.status === 0) return `green${verdict.advisory.length > 0 ? ` (${verdict.advisory.length} advisory red)` : ""}`;
  const owned = verdict.owned_debt ?? [];
  const unowned = unownedBlocking(verdict);
  if (unowned.length === 0 && owned.length > 0) return `green but for owned baseline debt (${owned.map((entry) => `${entry.gate}→${entry.owner}`).join(", ")})`;
  return `red (${unowned.length} blocking: ${unowned.map((entry) => entry.gate).join(", ") || "none named"}${owned.length > 0 ? `; ${owned.length} owned baseline debt` : ""})`;
}

interface Judgement {
  readonly nextState: BreakerState;
  readonly released: boolean;
  readonly consecutiveCount: number;
  readonly outcome: StopBatteryOutcome;
}

/**
 * The JUDGING half, as a pure function of a verdict and the prior breaker
 * state. Shared by the observer (which caches the decision it reached) and the
 * turn gate (which is what the model actually feels), so the two can never
 * disagree about whether a turn is refused.
 */
function judgeVerdict(verdict: CachedVerdict, prior: BreakerState, env: NodeJS.ProcessEnv): Judgement {
  const bound = batteryTimeoutSignal(env);
  if (verdict.measurement_failure !== null) {
    // Fail CLOSED and stay out of the counter entirely: a battery that named
    // nothing has no fingerprint to repeat, so advancing the counter would
    // recreate the sha256("[]") cohort ADR-154 records.
    return Object.freeze({ nextState: prior, released: false, consecutiveCount: prior.consecutive_count, outcome: Object.freeze({ decision: "blocked", refusal: buildMeasurementFailureMessage(verdict.measurement_failure, bound), deferral: null }) });
  }
  if (verdict.status === 0) {
    // Green, or advisory-red only. Checked BEFORE the unnameable predicate,
    // because a healthy battery names no blocking gate by definition and
    // would otherwise take the unnameable branch on every ordinary turn.
    return Object.freeze({ nextState: EMPTY_BREAKER_STATE, released: false, consecutiveCount: 0, outcome: ALLOW });
  }
  // Arboretum M2: a red battery whose EVERY blocking red is covered by an owned
  // debt entry is the baseline's, not the session's. It allows, and resets the
  // breaker exactly as green does, because there is no session failure to
  // repeat. A single unowned red still blocks below, judged on the unowned set.
  const owned = verdict.owned_debt ?? [];
  const blocking = unownedBlocking(verdict);
  if (owned.length > 0 && blocking.length === 0) {
    return Object.freeze({ nextState: EMPTY_BREAKER_STATE, released: false, consecutiveCount: 0, outcome: ALLOW });
  }
  // Only a RED battery can be unnameable. `isUnnameableFailure` means "it failed
  // before any gate reported", which requires a non-zero exit.
  if (isUnnameableFailure(blocking)) {
    return Object.freeze({ nextState: prior, released: false, consecutiveCount: prior.consecutive_count, outcome: Object.freeze({ decision: "blocked", refusal: buildUnnameableFailureMessage(verdict.output), deferral: null }) });
  }
  const configured = readMaxNoProgress(env);
  const maxNoProgress = effectiveMaxNoProgress(env);
  const fingerprint = computeFingerprint(blocking);
  const decision = evaluate(prior, fingerprint, maxNoProgress);
  const debtLines = renderOwnedDebt(owned);
  const withDebt = (text: string): string => debtLines === "" ? text : `${text}\n\n${debtLines}`;
  if (decision.released) {
    return Object.freeze({
      nextState: decision.nextState, released: true, consecutiveCount: decision.consecutiveCount,
      outcome: Object.freeze({
        decision: "released",
        refusal: withDebt(buildReleaseMessage({ output: verdict.output, blocking, advisory: verdict.advisory, consecutiveCount: decision.consecutiveCount, maxNoProgress, configuredMaxNoProgress: configured })),
        deferral: null,
      }),
    });
  }
  return Object.freeze({ nextState: decision.nextState, released: false, consecutiveCount: decision.consecutiveCount, outcome: Object.freeze({ decision: "blocked", refusal: withDebt(buildBlockMessage(verdict.output)), deferral: null }) });
}

/**
 * THE REFUSAL the worker consults. It never spawns anything: it reads the
 * verdict the observer measured out of band, and it re-uses that verdict for
 * every turn the measurement still covers. Returns `null` — which the worker
 * treats identically to a clean check — when the battery is deferred, in
 * flight, or has not reported yet.
 */
export async function stopBatteryTurnGate(sessionId: string, env: NodeJS.ProcessEnv = process.env): Promise<StopBatteryOutcome> {
  if (sessionId === "") return ALLOW;
  if (batteryIsSkipped(env)) return defer("skipped via ARBOR_SKIP_STOP_GATES");
  // IT SPAWNS NOTHING. Not the battery, not `git`.
  // Everything this gate reads was measured out of band by the observer in the
  // same tick, and this function runs IN LINE on the turn's critical path, so a
  // spawn here is the "three git subprocesses per turn boundary" cost that
  // `vi-graph-debt.ts` records as having taken the native production e2e from
  // 4/4 to 2/4. It is also why this gate is wired only alongside a hook bus:
  // the observer is what starts a measurement, and there is no observer without
  // a bus.
  if (batteryInFlight(sessionId)) return defer("a battery is in flight for this session");
  const dir = stopGuardStateDir(currentGovernedRoot(), env, sessionId);
  const file = readFile(dir, sessionId);
  if (file.deferred_by !== null) return defer(`window ${file.deferred_by}`);
  if (file.verdict === null) return defer("no battery verdict has been measured for this session yet");
  // The observer records what it measured alongside the verdict it measured it
  // for, so this comparison costs a field read and no subprocess.
  if (file.measured !== file.verdict.measured) return defer("the working tree moved since the verdict was measured");
  const judgement = judgeVerdict(file.verdict, file.breaker, env);
  if (judgement.nextState !== file.breaker) writeFile(dir, sessionId, Object.freeze({ verdict: file.verdict, breaker: judgement.nextState, deferred_by: file.deferred_by, measured: file.measured, base: file.base }));
  if (judgement.released) {
    appendRelease(dir, {
      schema_version: 1,
      session_id: sessionId,
      fingerprint: computeFingerprint(unownedBlocking(file.verdict)),
      consecutive_count: judgement.consecutiveCount,
      configured_max_no_progress: readMaxNoProgress(env),
      effective_max_no_progress: effectiveMaxNoProgress(env),
      released_at: new Date().toISOString(),
      blocking_gates: unownedBlocking(file.verdict),
      advisory_red_gates: file.verdict.advisory,
    });
  }
  return judgement.outcome;
}

/** The `turn_end` observe handler. Registered as `observe.stop-battery`. */
export const stopBatteryObserver: HookObserveHandler = (context) => measureStopBattery(context);

export { HOOK_MAX_NOTE_BYTES };