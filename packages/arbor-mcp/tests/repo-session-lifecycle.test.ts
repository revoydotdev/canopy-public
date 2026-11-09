/**
 * The native repository-session lifecycle: the state machine, the five verbs, the
 * end path, and the one hand-copied constant this port had to carry.
 *
 * WHAT IS REAL HERE AND WHAT IS INJECTED. The store, the transitions, the commit
 * window, the stranded-window rule and both derived views run against a REAL Git
 * repository in a temp directory, because their whole subject is what the durable
 * record and `git status` say. The close's five authorities are injected as a
 * recording runner: what this file pins is the ORDER, the refusal to skip a step,
 * the commit-window asymmetry, and the receipt — the real steps are the
 * repository's own scripts and have their own tests.
 *
 * `process.chdir` does not exist in a vitest worker thread, so the one handler
 * that reads the session's own working directory (`currentGovernedRoot`) is driven
 * with a spied `process.cwd` rather than a real directory change.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repoSessionAssertWindowCommand, repoSessionLifecycleCommand, repoSessionReconcileCommand } from "../src/repo-session-close.js";
import { abortWindow, assertWindow, beginSession, closeSession, commitPlan, isStranded, openWindow, reconcileStrandedWindow, sessionEnd, statusReport, windowState, type CloseStep } from "../src/repo-session-lifecycle.js";
import { EVIDENCE_STORE_PREFIXES, SESSION_STATUSES, readSession, sessionsDir } from "../src/repo-session-store.js";
import { repoSessionEndHandler, repoSessionOpenHandler } from "../src/hooks/repo-session.js";
import type { HookInjectContext, HookLifecycleContext } from "../src/hooks/contracts.js";

const NOW = "2026-09-30T12:00:00.000Z";
const hoursBefore = (hours: number): string => new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();

let repo = "";
const git = (...args: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, encoding: "utf8" });
const commitAll = (message: string): void => { git("add", "-A"); git("commit", "-q", "-m", message); };
const receipts = (): readonly string[] => readFileSync(join(sessionsDir(repo) as string, "receipts.jsonl"), "utf8").trim().split("\n");

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "repo-session-"));
  git("init", "-q", "-b", "master");
  writeFileSync(join(repo, "README.md"), "seed\n");
  commitAll("chore: seed");
});
afterEach(() => { vi.restoreAllMocks(); rmSync(repo, { recursive: true, force: true }); });

interface Step { readonly label: string; readonly argv: readonly string[]; readonly env: Readonly<Record<string, string>> }

/** A recording runner. The two git steps are performed for real, because the tree
 *  state the close inspects afterwards has to be true. `env` is RECORDED because
 *  the close runs every step with the commit window open — the assertion that
 *  commits are unfrozen for the WHOLE close, not just the first step, cannot be
 *  made without it. */
function recordingRunner(fail: (label: string) => boolean = () => false, queueOk = true): { run: CloseStep; calls: Step[] } {
  const calls: Step[] = [];
  const run: CloseStep = (label, argv, env = {}) => {
    calls.push({ label, argv, env });
    const identity = { ...process.env, ...env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    if (label === "git add (evidence)" || label === "git commit (evidence)") {
      const out = execFileSync(argv[0] as string, argv.slice(1), { cwd: repo, encoding: "utf8", env: identity });
      return { label, ok: true, status: 0, duration_ms: 1, tail: out };
    }
    if (label === "evidence:rebind") {
      mkdirSync(join(repo, ".claim-ledger"), { recursive: true });
      writeFileSync(join(repo, ".claim-ledger", "store.json"), '{"bound":"now"}\n');
    }
    const ok = !fail(label);
    return {
      label, ok, status: ok ? 0 : 1, duration_ms: 1, tail: ok ? "" : `${label} said no`,
      ...(label === "decision-queue" ? { json: JSON.stringify({ ok: queueOk, lapsed: 0, due_soon: 0, hazards: 0, flagged_proposed: 0, operator_calls: queueOk ? 0 : 1 }) } : {}),
    };
  };
  return { run, calls };
}

/** A real `Writable`, because the command's environment type is the real one. */
function capture(): { sink: Writable; text(): string } {
  let text = "";
  const sink = new Writable({ write(chunk, _encoding, done) { text += String(chunk); done(); } });
  return { sink, text: () => text };
}
const sinkOf = (): Writable => capture().sink;

describe("the state machine: open -> closing -> closed", () => {
  it("refuses a commit while the session is open, allows it once the window is open, and is inert without a session", () => {
    expect(assertWindow(repo, {})).toMatchObject({ allowed: true, reason: expect.stringContaining("no agent session record") });
    beginSession(repo, "s1");
    // The asymmetry this whole design rests on: `open` DEFERS, `closing` does not.
    expect(assertWindow(repo, {})).toMatchObject({ allowed: false });
    expect(assertWindow(repo, {}).reason).toContain("arbor repo-session open");
    expect(assertWindow(repo, { ARBOR_COMMIT_WINDOW: "1" })).toMatchObject({ allowed: true });
    openWindow(repo, "s1");
    expect(assertWindow(repo, {})).toMatchObject({ allowed: true });
    expect(readSession(repo)?.status).toBe("closing");
  });

  it("refuses while any OTHER session is still open, and again when the store cannot be scanned", () => {
    // An unvouchable candidate is not the same as an open one, and the difference
    // is which message the operator gets.
    const dir = sessionsDir(repo) as string;
    mkdirSync(join(dir, "broken"), { recursive: true });
    writeFileSync(join(dir, "broken", "state.json"), "{not json", "utf8");
    expect(assertWindow(repo, {})).toMatchObject({ allowed: false });
    expect(assertWindow(repo, {}).reason).toContain("could not complete the durable session scan");
    beginSession(repo, "s1");
    expect(assertWindow(repo, {}).reason).toContain("open session s1 still defer commits");
  });

  it("tells the turn boundary to stand down while open, and after a green close at HEAD", () => {
    expect(windowState(repo).state).toBe("none");
    beginSession(repo, "s1");
    writeFileSync(join(repo, "notes.md"), "x\n");
    expect(windowState(repo)).toMatchObject({ state: "open" });
    expect(windowState(repo).detail).toContain("1 uncommitted source path");
    commitAll("docs: notes");
    const receipt = closeSession({ repo, sessionId: "s1", run: recordingRunner().run, log: () => {} });
    expect(receipt.ok).toBe(true);
    expect(windowState(repo).state).toBe("closed-green");
    writeFileSync(join(repo, "more.md"), "y\n");
    commitAll("docs: more");
    // The second derived view: HEAD moved past a green receipt, so the battery is owed again.
    expect(windowState(repo).state).toBe("closed-red");
  });

  it("resumes a live session and reopens a terminal one", () => {
    beginSession(repo, "s1");
    expect(beginSession(repo, "s1").resumed_at).toBeDefined();
    openWindow(repo, "s1");
    abortWindow(repo, "s1");
    expect(readSession(repo)).toMatchObject({ status: "open", commit_window: null });
    expect(SESSION_STATUSES).toContain("abandoned");
  });
});

describe("closeSession — one contiguous process", () => {
  it("refuses to close over uncommitted source and hands back the commit plan, running nothing", () => {
    beginSession(repo, "s1");
    writeFileSync(join(repo, "x.ts"), "export {};\n");
    const { run, calls } = recordingRunner();
    const receipt = closeSession({ repo, sessionId: "s1", run, log: () => {} });
    expect(receipt).toMatchObject({ ok: false, status: "source_commit_required" });
    expect(receipt.source_paths).toContain("x.ts");
    expect(receipt.remedy).toContain("arbor repo-session close");
    expect(calls).toEqual([]);
  });

  it("binds evidence, commits the stores, runs the stop tier, then the full tier, then the queue", () => {
    beginSession(repo, "s1");
    const { run, calls } = recordingRunner();
    const receipt = closeSession({ repo, sessionId: "s1", run, label: "pilot", log: () => {} });
    expect(receipt.ok).toBe(true);
    expect(calls.map((call) => call.label)).toEqual(["evidence:rebind", "git add (evidence)", "git commit (evidence)", "gate:all --tier stop", "gate:all --tier full", "decision-queue"]);
    expect(calls.find((call) => call.label === "gate:all --tier stop")?.argv).toEqual(expect.arrayContaining(["--tier", "stop"]));
    expect(calls.find((call) => call.label === "gate:all --tier full")?.argv).toEqual(expect.arrayContaining(["--tier", "full"]));
    // EVERY step, not the first one: the close's own two `git commit`s would be
    // refused by this repository's pre-commit hook while a window is open, so a
    // single un-frozen step is enough to make the whole close fail at step two.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.env.ARBOR_COMMIT_WINDOW === "1")).toBe(true);
    // Only evidence prefixes are staged, and only the ones that exist on disk.
    expect(calls[1]?.argv).toContain("--");
    expect(calls[1]?.argv.filter((arg) => arg.endsWith("/"))).toEqual([".claim-ledger/"]);
    expect(git("log", "-1", "--format=%s")).toContain("chore(evidence): bind stores at session close — pilot");
    expect(git("status", "--porcelain").trim()).toBe("");
    expect(readSession(repo, "s1")?.status).toBe("closed");
    expect(existsSync(readSession(repo, "s1")?.receipt?.path as string)).toBe(true);
    expect(receipts()).toHaveLength(1);
    expect(receipt.push_allowed).toBe(true);
  });

  it("stops at the first red step and leaves the window open for the fix", () => {
    beginSession(repo, "s1");
    const { run, calls } = recordingRunner((label) => label === "gate:all --tier stop");
    expect(closeSession({ repo, sessionId: "s1", run, log: () => {} })).toMatchObject({ ok: false, status: "stop_tier_red" });
    expect(calls.map((call) => call.label)).not.toContain("gate:all --tier full");
    expect(readSession(repo, "s1")?.status).toBe("closing");
    // `closing` still ALLOWS: a red step must not turn into a refused commit.
    expect(assertWindow(repo, {}).allowed).toBe(true);
  });

  it("names a red rebind as its own status, before any commit is attempted", () => {
    beginSession(repo, "s1");
    const { run, calls } = recordingRunner((label) => label === "evidence:rebind");
    expect(closeSession({ repo, sessionId: "s1", run, log: () => {} }).status).toBe("rebind_failed");
    expect(calls).toHaveLength(1);
  });

  it("reports owed interviews as push-blocking without deciding anything", () => {
    beginSession(repo, "s1");
    const receipt = closeSession({ repo, sessionId: "s1", run: recordingRunner(() => false, false).run, log: () => {} });
    expect(receipt.ok).toBe(true);
    expect(receipt.push_allowed).toBe(false);
    expect(receipt.next).toContain("bun run interview:record");
    expect(receipt.next).not.toContain("/revoy2-interview");
  });

  it("records a session end with what it left unfinished", () => {
    beginSession(repo, "s1");
    writeFileSync(join(repo, "left.md"), "x\n");
    expect(sessionEnd(repo, "s1")?.unfinished).toMatchObject({ status: "open", source_paths: ["left.md"] });
  });
});

describe("the end path records and never closes", () => {
  const lifecycleContext = (sessionId: string): HookLifecycleContext =>
    ({ event: "session_end", hook_id: "repo-session-end", version: "1.0.0", session_id: sessionId, campaign_id: "c-1", node_id: null, role: null, outcome: "completed" });

  it("records the end and leaves the record open, with no receipt written", () => {
    vi.spyOn(process, "cwd").mockReturnValue(repo);
    beginSession(repo, "s1");
    openWindow(repo, "s1");
    const outcome = repoSessionEndHandler(lifecycleContext("s1")) as { note?: string };
    expect(outcome.note).toContain("s1");
    expect(readSession(repo, "s1")?.ended_at).toBeDefined();
    // The negative, as an observable fact: nothing was closed, so there is no
    // receipt, the status is unchanged, and no authority was run.
    expect(existsSync(join(sessionsDir(repo) as string, "receipts.jsonl"))).toBe(false);
    expect(readSession(repo, "s1")?.status).toBe("closing");
  });

  it("reports honestly when there is no record to end", () => {
    vi.spyOn(process, "cwd").mockReturnValue(repo);
    expect((repoSessionEndHandler(lifecycleContext("nope")) as { note?: string }).note).toContain("no durable session record");
  });

  it("opens the record at session start and joins it rather than opening a second", () => {
    vi.spyOn(process, "cwd").mockReturnValue(repo);
    const context = (sessionId: string): HookInjectContext => ({ ...lifecycleContext(sessionId), event: "session_start", turn: 0 });
    const first = repoSessionOpenHandler(context("child-a"));
    expect((first as { body: string }).body).toContain("arbor repo-session close");
    expect(readSession(repo)?.session_id).toBe("child-a");
    // A second native session in the same checkout does not open a second record.
    expect(repoSessionOpenHandler(context("child-b"))).toBeNull();
    expect(readSession(repo, "child-b")).toBeNull();
  });
});

describe("reconcileStrandedWindow — the terminator for a window nobody will close", () => {
  it("separates a live window from one whose session ended with it open, and from one past the TTL", () => {
    beginSession(repo, "s1");
    openWindow(repo, "s1", hoursBefore(1));
    expect(windowState(repo, NOW)).toMatchObject({ state: "closing" });
    sessionEnd(repo, "s1", hoursBefore(0.5));
    expect(windowState(repo, NOW)).toMatchObject({ state: "closing-stale" });
    expect(isStranded(readSession(repo)!, NOW)).toBe(true);

    beginSession(repo, "s2");
    openWindow(repo, "s2", hoursBefore(23));
    expect(isStranded(readSession(repo, "s2")!, NOW)).toBe(false);
    beginSession(repo, "s3");
    openWindow(repo, "s3", hoursBefore(25));
    expect(isStranded(readSession(repo, "s3")!, NOW)).toBe(true);
  });

  it("does not retire a window opened deliberately on an ALREADY-ended session", () => {
    beginSession(repo, "s1");
    sessionEnd(repo, "s1", hoursBefore(5));
    // `openWindow` spreads the prior record, so `ended_at` predates this window.
    openWindow(repo, "s1", hoursBefore(1));
    expect(isStranded(readSession(repo, "s1")!, NOW)).toBe(false);
  });

  it("writes a red abandonment receipt, moves the session to a terminal status, and runs no close at all", () => {
    beginSession(repo, "s1");
    openWindow(repo, "s1", hoursBefore(2));
    sessionEnd(repo, "s1", hoursBefore(1));
    const { run, calls } = recordingRunner();
    const result = reconcileStrandedWindow({ repo, sessionId: "s1", at: NOW });
    expect(result.changed).toBe(true);
    // ADR-160's rejected alternative: no runner exists on this call to inject one
    // into, and the receipt carries an empty step list.
    expect(typeof run).toBe("function");
    expect(calls).toEqual([]);
    if (!result.changed) throw new Error("expected a changed reconcile");
    expect(result.receipt.steps).toEqual([]);
    expect(result.receipt).toMatchObject({ ok: false, status: "window_abandoned" });
    expect(result.receipt.remedy).toContain("arbor repo-session close");
    // The receipt the operator reads while the window is retired still carries the
    // commit plan: this is the ONLY artifact naming what is left uncommitted, since
    // nothing here ran a step that would have committed or reported it.
    expect(result.receipt.plan?.source).toEqual([]);
    expect(readSession(repo, "s1")?.status).toBe("abandoned");
  });

  it("is idempotent, leaves a live window untouched, and keeps commits allowed afterwards", () => {
    beginSession(repo, "s1");
    openWindow(repo, "s1", hoursBefore(1));
    const before = readSession(repo);
    expect(reconcileStrandedWindow({ repo, sessionId: "s1", at: NOW })).toMatchObject({ changed: false });
    expect(readSession(repo)).toEqual(before);

    beginSession(repo, "s2");
    openWindow(repo, "s2", hoursBefore(2));
    sessionEnd(repo, "s2", hoursBefore(1));
    expect(reconcileStrandedWindow({ repo, sessionId: "s2", at: NOW })).toMatchObject({ changed: true });
    const after = readSession(repo, "s2");
    expect(reconcileStrandedWindow({ repo, sessionId: "s2", at: NOW })).toMatchObject({ changed: false });
    expect(readSession(repo, "s2")).toEqual(after);

    // The retired status must not fall out of the scan whitelist: an unrecognised
    // status makes the scan incomplete, and incomplete REFUSES.
    expect(assertWindow(repo, {})).toMatchObject({ allowed: true });
    expect(windowState(repo, NOW).state).toBe("closed-red");
    expect(beginSession(repo, "s2")).toMatchObject({ status: "open", commit_window: null });
  });
});

describe("the operator surface: five verbs, plus the two internal entries", () => {
  const run = (...args: string[]): { code: number; stdout: string; stderr: string } => {
    const stdout = capture();
    const stderr = capture();
    const code = repoSessionLifecycleCommand(args, { cwd: repo, stdout: stdout.sink, stderr: stderr.sink });
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  };

  it("reaches all five, each against the native module", () => {
    expect(run("begin", "--session", "verbs").stdout).toContain("session verbs: open");
    expect(run("open", "--session", "verbs").stdout).toContain("commit window open");
    expect(readSession(repo, "verbs")?.status).toBe("closing");
    expect(run("status").stdout).toContain("window: closing");
    expect(run("abort", "--session", "verbs").stdout).toContain("commit window closed");
    expect(readSession(repo, "verbs")?.status).toBe("open");
    // `close` over uncommitted source refuses and runs NO authority, which is both
    // the real behaviour and the only way to reach this verb from a test at all.
    writeFileSync(join(repo, "pending.ts"), "export {};\n");
    const closed = run("close", "--session", "verbs");
    expect(closed.code).toBe(1);
    expect(closed.stdout).toContain("source_commit_required");
  });

  it("refuses an unknown verb, an unknown flag, a missing value, and a repeated flag", () => {
    expect(run("nope").stderr).toContain("Unknown repo-session action");
    expect(run("status", "--wat").stderr).toContain("Unknown repo-session status argument");
    expect(run("open", "--session").stderr).toContain("--session requires a value");
    expect(run("open", "--session", "a", "--session", "b").stderr).toContain("may be supplied only once");
    // `--json` is a status/begin/close option and nothing else.
    expect(run("open", "--json").stderr).toContain("Unknown repo-session open argument");
  });

  it("answers the pre-commit question with an exit code inside a Canopy harness run", () => {
    const governed = { ARBOR_GOVERNED_RUN: "1" };
    beginSession(repo, "s1");
    const refused = capture();
    expect(repoSessionAssertWindowCommand({ cwd: repo, env: governed, stdout: sinkOf(), stderr: refused.sink })).not.toBe(0);
    expect(refused.text()).toContain("pre-commit refused:");
    openWindow(repo, "s1");
    expect(repoSessionAssertWindowCommand({ cwd: repo, env: governed, stdout: sinkOf(), stderr: sinkOf() })).toBe(0);
  });

  it("never refuses outside a Canopy harness run, even with a session that defers commits (ADR-177)", () => {
    beginSession(repo, "s1");
    const quiet = capture();
    expect(repoSessionAssertWindowCommand({ cwd: repo, env: { ARBOR_GOVERNED_RUN: "" }, stdout: sinkOf(), stderr: quiet.sink })).toBe(0);
    expect(quiet.text()).toBe("");
  });

  it("retires a stranded window through the internal reconcile entry, exit 0 either way", () => {
    const reconcile = (...args: string[]): number => repoSessionReconcileCommand(args, { cwd: repo, stdout: sinkOf(), stderr: sinkOf() });
    expect(reconcile("--session", "s1")).toBe(0);
    beginSession(repo, "s1");
    openWindow(repo, "s1", hoursBefore(2));
    sessionEnd(repo, "s1", hoursBefore(1));
    expect(reconcile("--session", "s1")).toBe(0);
    expect(readSession(repo, "s1")?.status).toBe("abandoned");
  });
});

describe("the evidence-prefix list is the one this port had to copy", () => {
  it("matches the authority that owns it, and is not the store-provenance list", () => {
    // `scripts/evidence-transaction.mjs` still stages evidence for its own
    // transaction and exports the same four whole-directory prefixes. A package
    // cannot import a script, so this IS a second hand-typed list — and this
    // assertion is what stops the two from drifting apart silently.
    const source = readFileSync(new URL("../../../scripts/evidence-transaction.mjs", import.meta.url), "utf8");
    const declared = /export const EVIDENCE_PATH_PREFIXES = Object\.freeze\(\[([^\]]*)\]\)/u.exec(source)?.[1] ?? "";
    const authority = [...declared.matchAll(/"([^"]+)"/gu)].map((match) => match[1] as string);
    expect(EVIDENCE_STORE_PREFIXES).toEqual(authority);

    // It answers "what may be staged as evidence", which is a whole directory or
    // nothing. The store-provenance list answers "which rebuild invalidates
    // which store" and must stay separate: it splits .visual-intelligence/.
    const generated = /export const GENERATED_EVIDENCE_PREFIXES = \[([^\]]*)\]/u.exec(readFileSync(new URL("../../../scripts/lib/store-provenance.mjs", import.meta.url), "utf8"))?.[1] ?? "";
    expect(generated).toContain(".visual-intelligence/observed/");
    expect(EVIDENCE_STORE_PREFIXES).toContain(".visual-intelligence/");
  });
});

describe("the commit plan groups uncommitted source by the decision that governs it", () => {
  it("groups a repository with no decisions directory as ungoverned rather than inventing a trailer", () => {
    beginSession(repo, "s1");
    writeFileSync(join(repo, "orphan.ts"), "export {};\n");
    const plan = commitPlan(repo);
    expect(plan.source).toEqual(["orphan.ts"]);
    expect(plan.groups.map((group) => group.trailer)).toEqual(["ungoverned"]);
    expect(statusReport(repo).plan.groups).toHaveLength(1);
  });
});