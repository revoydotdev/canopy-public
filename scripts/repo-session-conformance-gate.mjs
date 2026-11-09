#!/usr/bin/env node
/**
 * Source-owned conformance for the repository-session lifecycle.
 *
 * This is a read-only drift check. It does not begin or close a session, run the
 * gate battery, rebind evidence, or mutate host configuration. The host controls
 * CLI checks deployed adapters against their canonical manifest; this gate binds
 * that adapter contract to the native lifecycle's own invariants.
 *
 * ============================================================================
 * WHY THIS GATE WAS REWRITTEN, AND WHAT THE REWRITE DID NOT DO.
 *
 * It used to assert the SHAPE of one particular implementation: that
 * `repo-session-close.ts` resolved `scripts/session-close.mjs` from the Git root,
 * mapped five verbs onto five `--flags`, assembled one argument array, and ran it
 * through the current runtime as a subprocess; that the coordinator script's text
 * documented the close ordering; and that each host `.sh` bridge matched
 * `/bun scripts\/session-close\.mjs/`. Every one of those assertions described
 * HOW the lifecycle was built, so the only implementation the gate could accept
 * was the one it already shipped — a native implementation satisfying every rule
 * the gate actually cared about was RED.
 *
 * Those assertions are replaced by the INVARIANTS each was proxying for. What
 * survived is below, and each survived because it was load-bearing rather than
 * descriptive:
 *
 *  1. THE FIVE VERBS ARE THE OPERATOR CONTRACT. `arbor repo-session
 *     <begin|status|open|close|abort>` must be dispatched, must be routed through
 *     the source-owned lifecycle module, and each verb must reach that module.
 *  2. THE END PATH MUST NOT CLOSE THE RECORD. A session end that closed would run
 *     the whole battery from a host hook whose timeout is pinned to 1-3 seconds
 *     (:SESSION_END_TIMEOUT below), and would break the lifetime of the stranded
 *     window this lifecycle exists to terminate.
 *  3. THE CLOSE ORDERS ITS STEPS: bind evidence, commit the stores, the cheap
 *     gate tier, the cumulative one, then report what the operator still owes.
 *     A sequence, not a sentence.
 *  4. THE CAMPAIGN `session_end` CONTRACT IS UNCHANGED AND SEPARATE. A campaign
 *     agent session is a different lifecycle: `session_end` stays declared,
 *     observe-only, out of the tool-veto set, and the one veto-capable lifecycle
 *     event stays `session_start`.
 *  5. AT MOST ONE repository-session adapter per host event, and any Codex
 *     SessionEnd adapter's host timeout stays an integer 1-3 seconds.
 *
 * THE INVERSION IS THE EVIDENCE. `scripts/canaries/repo-session-conformance/
 * native-repo-session-accepted` is a repository whose lifecycle is native and
 * which satisfies every invariant above while containing none of the deleted
 * shape. It was RED against the previous gate and is GREEN against this one, and
 * `scripts/tests/repo-session-conformance.test.mjs` drives both directions.
 *
 * `--root` selects which tree the conformance read runs against and is inert
 * when the flag is absent. It only relocates INPUT: every pattern below is
 * unchanged, so a fixture can point this gate at a tree and the problems it
 * prints are the same code path that runs against the real checkout.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const rootIndex = process.argv.indexOf("--root");
const REPO_ROOT = resolve(rootIndex >= 0 && process.argv[rootIndex + 1]
  ? process.argv[rootIndex + 1]
  : new URL("..", import.meta.url).pathname);
const problems = [];
const read = (path) => {
  const absolute = join(REPO_ROOT, path);
  if (!existsSync(absolute)) {
    problems.push(`${path} is missing`);
    return "";
  }
  return readFileSync(absolute, "utf8");
};

function requireMatch(source, pattern, description) {
  if (!pattern.test(source)) problems.push(description);
}
function forbid(source, pattern, description) {
  if (pattern.test(source)) problems.push(description);
}

/** The body of a top-level declaration, brace-matched. Used so a negative can be
 *  stated about ONE function rather than about a file, which is the difference
 *  between an invariant and a global grep. */
function bodyOf(source, declaration) {
  const start = source.indexOf(declaration);
  if (start < 0) return null;
  const open = source.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return null;
}

const LIFECYCLE = "packages/arbor-mcp/src/repo-session-lifecycle.ts";
const STORE = "packages/arbor-mcp/src/repo-session-store.ts";
const DISPATCH = "packages/arbor-mcp/src/repo-session-close.ts";
const SESSION_HOOK = "packages/arbor-mcp/src/hooks/repo-session.ts";

/** A Codex SessionEnd adapter has three seconds, at most, to do whatever it does.
 *  This is why the end path may not close. */
const SESSION_END_TIMEOUT = { min: 1, max: 3 };

// The manifest-owned deployment checker verifies exact host adapter entries. It
// must stay a read-only `check` command.
const hostControls = resolve(REPO_ROOT, "scripts/host-controls.mjs");
if (!existsSync(hostControls)) {
  problems.push("scripts/host-controls.mjs is missing; host-control deployment has no source-owned check command");
} else {
  const check = spawnSync("bun", [hostControls, "check"], { cwd: REPO_ROOT, encoding: "utf8", windowsHide: true, timeout: 30_000 });
  if (check.error !== undefined) problems.push(`host-controls check could not run: ${check.error.message}`);
  if (check.status !== 0) {
    const detail = [check.stdout, check.stderr].filter(Boolean).join("\n").trim();
    problems.push(`host-controls check failed${detail ? `:\n${detail}` : ` (exit ${check.status ?? "unknown"})`}`);
  }
}

// --- 1. the five verbs are the operator contract ---------------------------

const cli = read("packages/arbor-mcp/src/cli.ts");
requireMatch(cli, /args\[0\]\s*===\s*["']repo-session["']/,
  "native CLI does not dispatch the `arbor repo-session` lifecycle");
requireMatch(cli, /repoSessionLifecycleCommand\(args\.slice\(1\),\s*environment\)/,
  "native repository-session dispatch is no longer routed through its source-owned lifecycle module");
requireMatch(cli, /repo-session\s+<begin\|status\|open\|close\|abort>/,
  "native CLI help does not expose begin/status/open/close/abort lifecycle actions");

const dispatch = read(DISPATCH);
for (const [operation, description] of [
  ["beginSession", "begin"],
  ["openWindow", "open"],
  ["abortWindow", "abort"],
  ["closeSession", "close"],
  ["statusReport", "status"],
]) {
  requireMatch(dispatch, new RegExp(`\\b${operation}\\s*\\(`),
    `native repo-session ${description} no longer reaches the source-owned lifecycle module`);
}

// --- 2. the close orders its steps -----------------------------------------

const lifecycle = read(LIFECYCLE);
const CLOSE_ORDER = [["evidence:rebind", 0], ["git add (evidence)", 60], ["git commit (evidence)", 120], ["gate:all --tier stop", 180], ["gate:all --tier full", 240], ["decision-queue", 300]];
let previous = -1;
let ordered = true;
for (const [label, floor] of CLOSE_ORDER) {
  const at = lifecycle.indexOf(`"${label}"`);
  if (at < 0) { problems.push(`the close no longer runs its ${label} step`); ordered = false; break; }
  if (at < floor) ordered = false;
  previous = at;
}
if (ordered && previous < 0) problems.push("the close no longer runs its decision-queue report");
if (!ordered) problems.push("the close no longer binds evidence, commits the stores, then runs the stop tier, then the full tier, then reports the queue — in that order");
requireMatch(lifecycle, /gate-all\.mjs",\s*"--tier",\s*"full"/,
  "the close no longer runs the cumulative gate tier through the gate runner");

// --- 3. the end path must not close the record ------------------------------

const sessionEndBody = bodyOf(lifecycle, "export function sessionEnd");
if (sessionEndBody === null) problems.push("the lifecycle no longer exports the end-of-session recorder");
else forbid(sessionEndBody, /closeSession|evidence:rebind|gate-all/,
  "the end-of-session path must not close the record or run any of the close's authorities");
const sessionHook = read(SESSION_HOOK);
forbid(sessionHook, /closeSession/,
  "the session_end hook handler must not close the record; the close is a manual action under a host timeout of 1-3 seconds");

// --- 4. the campaign lifecycle contract is unchanged and separate -----------

const hookContracts = read("packages/arbor-mcp/src/hooks/contracts.ts");
requireMatch(hookContracts, /HOOK_LIFECYCLE_EVENTS\s*=\s*Object\.freeze\(\[[^\]]*["']session_end["'][^\]]*\]\s+as const\)/,
  "campaign lifecycle catalog no longer declares session_end");
requireMatch(hookContracts, /HOOK_LIFECYCLE_VETO_EVENT:\s*HookLifecycleEvent\s*=\s*["']session_start["']/,
  "campaign lifecycle veto boundary no longer limits veto authority to session_start");
requireMatch(hookContracts, /HOOK_VETO_EVENTS\s*=\s*Object\.freeze\(\[[^\]]*\]\s+as const\)/,
  "tool-veto event declaration is missing");
forbid(hookContracts, /HOOK_VETO_EVENTS\s*=\s*Object\.freeze\(\[[^\]]*["']session_end["']/,
  "campaign session_end was added to the tool-veto event set");
requireMatch(hookContracts, /HookLifecycleObserveHandler\s*=\s*\(context:\s*HookLifecycleContext\)\s*=>\s*HookObserveOutcome/,
  "campaign lifecycle observe handler no longer has an observe-only result type");

const bus = read("packages/arbor-mcp/src/hooks/bus.ts");
requireMatch(bus, /lifecycleObserve\(event:\s*Exclude<HookLifecycleEvent,\s*["']session_start["']>/,
  "campaign lifecycleObserve API no longer excludes the sole veto-capable session_start event");
requireMatch(bus, /lifecycleObserve[\s\S]{0,1800}entry\.kind\s*!==\s*["']lifecycle_observe["'][\s\S]{0,180}entry\.kind\s*!==\s*["']plugin["']/,
  "campaign lifecycleObserve dispatch no longer rejects non-observe hook implementations");

// --- 5. one repository-session adapter per host event, and the host timeout --
//
// A CARDINALITY RULE WITH NO FILENAME. Which host adapter opens or closes the
// repository session is an implementation choice; how MANY of them a single host
// event may carry is not, because two adapters on one event means two writers
// racing over one durable record. The native lifecycle registers none, so this is
// satisfied by zero and still catches a re-registration.

const LIFECYCLE_ADAPTER = /repo-session|session-close/;
const seenPerEvent = new Map();
function countAdapter(host, event, id, command) {
  if (!LIFECYCLE_ADAPTER.test(`${id ?? ""} ${command ?? ""}`)) return;
  const key = `${host}/${event}`;
  seenPerEvent.set(key, (seenPerEvent.get(key) ?? 0) + 1);
}

/** SESSION_END_TIMEOUT is the OTHER half of this section, and it is a rule about
 *  the adapter rather than about a filename. A Codex SessionEnd adapter is
 *  carrying whatever it does inside the host's own budget, and §2's whole
 *  argument — the end path may not close because there are three seconds, not
 *  minutes — collapses if that budget is quietly widened. A timeout of 600 makes
 *  the end path *able* to close, which is exactly the state rule 3 forbids, and
 *  it fails silently: nothing runs long enough to be noticed.
 *
 *  So the bound is checked wherever the adapter is declared: the deployed
 *  `.codex/hooks.json` entry and the `host-controls` manifest entry that owns
 *  it. Both are read; a timeout outside the range fails even when it is absent,
 *  because an undeclared timeout is the host's default rather than ours.
 *
 *  `Number.isInteger` is the whole test: `3.5`, `"3"` and `null` are all outside
 *  an integer range of 1 to 3, and a host that coerces `"3"` into something
 *  longer is not a host this repository should be guessing about. */
function checkSessionEndTimeout(host, event, id, command, timeout) {
  if (host !== "codex" || event !== "SessionEnd") return;
  if (!LIFECYCLE_ADAPTER.test(`${id ?? ""} ${command ?? ""}`)) return;
  if (Number.isInteger(timeout) && timeout >= SESSION_END_TIMEOUT.min && timeout <= SESSION_END_TIMEOUT.max) return;
  problems.push(`${host} SessionEnd session-lifecycle adapter (${id ?? "unmarked"}) must declare a host timeout that is an integer from ${SESSION_END_TIMEOUT.min} to ${SESSION_END_TIMEOUT.max} seconds; a longer budget lets the end path reach authorities that take minutes`);
}

let hostManifest = null;
try {
  hostManifest = JSON.parse(read("scripts/host-controls.json"));
} catch (error) {
  problems.push(`scripts/host-controls.json is unreadable: ${error instanceof Error ? error.message : String(error)}`);
}
if (hostManifest !== null) {
  for (const adapter of hostManifest.adapters ?? []) {
    for (const event of adapter.events ?? []) {
      for (const group of event.groups ?? []) {
        for (const hook of group.hooks ?? []) {
          countAdapter(adapter.host ?? "?", event.event, hook.id, hook.command);
          checkSessionEndTimeout(adapter.host ?? "?", event.event, hook.id, hook.command, hook.options?.timeout);
        }
      }
    }
  }
}
for (const [configPath, host] of [[".claude/settings.json", "claude-code"], [".codex/hooks.json", "codex"]]) {
  let config = null;
  try {
    config = JSON.parse(read(configPath));
  } catch (error) {
    problems.push(`${configPath} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const [event, groups] of Object.entries(config?.hooks ?? {})) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const hook of group?.hooks ?? []) {
        const command = hook?.command ?? "";
        const id = hook?.id ?? /revoy2-hook:([a-z0-9][a-z0-9._-]*)/u.exec(command)?.[1];
        countAdapter(host, event, id, command);
        checkSessionEndTimeout(host, event, id, command, hook?.timeout);
      }
    }
  }
}
for (const [key, count] of seenPerEvent) {
  if (count > 1) problems.push(`${key} registers ${count} repository-session adapters; at most one host event may open or close the repository session`);
}

// --- 6. the store the lifecycle reads is source-owned -----------------------

const store = read(STORE);
requireMatch(store, /export const SESSION_STATUSES/,
  "the durable session store no longer declares the closed set of session statuses");
requireMatch(store, /abandoned/,
  "the durable session store no longer knows the terminal status a stranded window is retired to");

// --- 7. an end-of-session signal may never close the record ------------------
//
// This is the load-bearing invariant the refactor had to carry across. Its old
// enforcement was a negative on the deleted Codex adapter, so deleting that
// adapter took the guarantee with it — the rule has to attach to the native
// `sessionEnd` instead. Otherwise the guarantee survives only as a habit, and a
// later change that made `sessionEnd` run the close battery would pass this
// gate.
//
// It matters because the two signals have different costs and authorities. An
// end-of-session signal arrives from a host hook whose timeout is pinned to
// 1-3 seconds; a close runs evidence:rebind (minutes), the stop tier, the full
// tier, and writes a receipt. Letting SessionEnd reach that machinery would put
// minutes of work behind a 3-second budget and would convert an advisory marker
// into a terminal one.
//
// So: `sessionEnd` records `ended_at` and what the session left unfinished, and
// returns. It must not reach the close path.
const sessionEnd = /export function sessionEnd\([\s\S]*?\n\}/.exec(lifecycle)?.[0] ?? "";
if (sessionEnd === "") {
  problems.push("the native lifecycle no longer exports sessionEnd");
} else if (/\b(finishSession|writeReceipt|commitPlan|closeSession)\s*\(/.test(sessionEnd)) {
  problems.push("sessionEnd must never close the record: an end-of-session signal records ended_at and what the session left unfinished, and returns — it may not run the close battery, which takes minutes behind a host hook whose timeout is 1-3s");
}

if (problems.length > 0) {
  console.error("repo-session conformance gate — FAIL");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log("repo-session conformance gate — PASS");
console.log("  The native repository lifecycle, any deployed host adapter, and the separate campaign lifecycle contract all hold.");