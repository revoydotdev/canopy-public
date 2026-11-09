import { describe, it, expect, afterEach } from "vitest";
import { existsSync, statSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EXIT_CODES } from "../src/exit-codes.js";
import { fileURLToPath } from "node:url";
import type { LoopExecutor, SpecialistResult, CriticResult } from "@arbor/opencode";
import type { Action, DecomposerPort, DecompositionResult } from "@arbor/core";
import { Writable } from "node:stream";
import { DeprecatedHarnessRefusal } from "../src/canopy-lane-policy.js";
import {
  evaluateTargetSafety,
  checkTargetIsolationSafety,
  planSelfhostWorktree,
  runSelfhostCampaign,
  exitCodeForOutcome,
  selfhostMain,
  resolvePrimaryCheckout,
  resolveHarnessSourceCheckout,
  FORBIDDEN_WORKER_BASENAME_PATTERN,
} from "../src/selfhost.js";

/** Captures everything written to a Writable as a single string — for
 * asserting on `selfhostMain`'s stdout/stderr without touching the real
 * process streams. */
function captureStream(): { stream: Writable; text: () => string } {
  let buf = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, text: () => buf };
}

// ============================================================
// TEST HELPERS — real, throwaway git repos (hermetic: local git only, no
// network), mirroring the pattern arbor-opencode/tests/worktree.test.ts
// already uses for this repo's real-worktree tests.
// ============================================================

const liveRepos: string[] = [];

function makeRepo(options: { branch?: string; parentDir?: string; dirName?: string } = {}): string {
  const parent = options.parentDir ?? mkdtempSync(join(tmpdir(), "arbor-selfhost-"));
  const repo = options.dirName ? join(parent, options.dirName) : parent;
  mkdirSync(repo, { recursive: true });
  spawnSync("git", ["init", "-q", repo], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "config", "user.email", "t@t"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "ignore" });
  writeFileSync(join(repo, "README.md"), "selfhost test fixture\n");
  spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "commit", "-qm", "init"], { stdio: "ignore" });
  if (options.branch) {
    spawnSync("git", ["-C", repo, "branch", "-m", options.branch], { stdio: "ignore" });
  }
  liveRepos.push(repo);
  return repo;
}

function currentBranch(repo: string): string {
  const res = spawnSync("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8" });
  return res.stdout.trim();
}

function branchExists(repo: string, branch: string): boolean {
  const res = spawnSync("git", ["-C", repo, "rev-parse", "--verify", `refs/heads/${branch}`], { stdio: "ignore" });
  return res.status === 0;
}

/** Writes one fixture ADR record into `<repo>/decisions/<filename>`, committing
 * it so it is visible to `deriveBacklog` (which reads the working tree, not
 * the index — commit isn't strictly required, but keeps the fixture repo
 * consistent with the rest of this file's real-git-repo style). */
function writeDecisionRecord(repo: string, filename: string, body: string): void {
  const dir = join(repo, "decisions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), body);
  spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "commit", "-qm", `add ${filename}`], { stdio: "ignore" });
}

const BUILDABLE_FIXTURE = [
  "# ADR-900: Fixture Buildable Record",
  "",
  "**Status:** Accepted",
  "**Date:** 2026-08-04",
  "",
  "## Context",
  "",
  "Some context.",
  "",
  "## Decision",
  "",
  "We will build a real thing: a widget factory in packages/example/src/widget.ts.",
  "",
  "## Consequences",
  "",
  "Things happen.",
  "",
].join("\n");

const NOT_APPLICABLE_FIXTURE = [
  "# ADR-901: Fixture Non-Goal",
  "",
  "**Status:** Accepted",
  "**Date:** 2026-08-04",
  "",
  "## Context",
  "",
  "Some context.",
  "",
  "## Decision",
  "",
  "No. We will not build this.",
  "",
  "## Consequences",
  "",
  "Things do not happen.",
  "",
  "## Test implications",
  "",
  "None directly - this ADR does not introduce a mechanism.",
  "",
].join("\n");

const BACKLOG_AT = "2026-08-05T00:00:00.000Z";

afterEach(() => {
  while (liveRepos.length > 0) {
    const repo = liveRepos.pop()!;
    spawnSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" });
    rmSync(repo, { recursive: true, force: true });
  }
});

/** A fake LoopExecutor that must NEVER be invoked — used to prove dry-run dispatches nothing. */
function throwingExecutor(): LoopExecutor {
  return {
    async specialize(): Promise<SpecialistResult> {
      throw new Error("specialize() must never be called in this test");
    },
    async review(): Promise<CriticResult> {
      throw new Error("review() must never be called in this test");
    },
  };
}

/** A fast, deterministic, hermetic executor: always approves, captures the worktree path it was given. */
function makeApprovingExecutor(captured: { worktreePaths: string[]; specializeCalls: number }): LoopExecutor {
  return {
    async specialize(params): Promise<SpecialistResult> {
      captured.specializeCalls++;
      captured.worktreePaths.push(params.worktree_path);
      return {
        output: `test fake handled: ${params.action.description}`,
        provenance: { tag: "claimed", claimant: params.specialist_agent },
        token_usage: { kind: "unavailable", reason: "selfhost.test.ts hermetic fake — no real provider call" },
      };
    },
    async review(): Promise<CriticResult> {
      return {
        approved: true,
        rationale: "approved by hermetic test fake",
        critic_agent: "lenticel",
        measurement_validated: true,
        token_usage: { kind: "unavailable", reason: "selfhost.test.ts hermetic fake — no real provider call" },
      };
    },
  };
}

/** An executor whose specialize() always reports a classified timeout — never a genuine result — so
 * FAULT_MATRIX's timeout -> "decompose" recovery is what the loop must reach, not a retry/abandon path. */
function makeAlwaysTimingOutExecutor(): LoopExecutor {
  return {
    async specialize(): Promise<SpecialistResult> {
      return {
        output: "",
        provenance: { tag: "claimed", claimant: "selfhost.test.ts hermetic fake" },
        token_usage: { kind: "unavailable", reason: "selfhost.test.ts hermetic fake — no real provider call" },
        error: {
          kind: "timeout",
          provenance: { tag: "claimed", claimant: "selfhost.test.ts hermetic fake" },
          message: "opencode run timed out after 60000ms",
          elapsed_ms: 60_000,
          partial_output: null,
          usage: { kind: "unavailable", reason: "test fixture" },
        },
      };
    },
    async review(): Promise<CriticResult> {
      throw new Error("review() should never be reached — the node timed out before producing output");
    },
  };
}

/** A hermetic DecomposerPort stub that always proposes the same fixed set of children. */
function makeDecomposerStub(children: Action[]): DecomposerPort {
  return {
    async decompose(): Promise<DecompositionResult> {
      return { ok: true, children };
    },
  };
}

/** An executor whose specialize() never resolves on its own — only the caller's AbortSignal ends it. */
function makeHangingExecutor(): LoopExecutor {
  return {
    specialize(params): Promise<SpecialistResult> {
      return new Promise((_resolve, reject) => {
        const onAbort = (): void => reject(params.signal?.reason instanceof Error ? params.signal.reason : new Error("aborted"));
        if (params.signal?.aborted) { onAbort(); return; }
        params.signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    async review(): Promise<CriticResult> {
      throw new Error("review() should never be reached — specialize() never resolves");
    },
  };
}

// ============================================================
// PURE GUARD LOGIC — no filesystem or git access.
// ============================================================

describe("evaluateTargetSafety (pure)", () => {
  it("refuses a target on the master branch", () => {
    const result = evaluateTargetSafety({ resolvedPath: "/some/path", branch: "master" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("forbidden_branch");
  });

  it("refuses a target on the main branch", () => {
    const result = evaluateTargetSafety({ resolvedPath: "/some/path", branch: "main" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("forbidden_branch");
  });

  it("refuses the primary checkout path even on a safe branch", () => {
    // Explicit forbiddenPaths keeps this a pure test of the decision core,
    // independent of where the suite happens to run.
    const result = evaluateTargetSafety(
      { resolvedPath: "/somewhere/primary", branch: "feat/whatever" },
      { forbiddenPaths: ["/somewhere/primary"] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("forbidden_primary_checkout");
  });

  it("derives the primary checkout from git rather than a hardcoded path", () => {
    // The defect this replaced: a literal home path that matched nothing off
    // one machine, silently disabling this guard layer.
    const primary = resolvePrimaryCheckout(process.cwd());
    expect(primary).not.toBeNull();
    // From any linked worktree, the derived value is the checkout that owns
    // the shared git dir — i.e. the real primary, not the worktree itself.
    // Asserted structurally rather than by excluding one machine's path: a
    // primary checkout's `.git` is a DIRECTORY, a linked worktree's `.git` is
    // a FILE pointing into it. That discriminates on any machine, whereas the
    // string-exclusion this replaced passed vacuously everywhere but one box —
    // the same environment-dependent blindness the guard's own doc comment
    // warns about, reproduced in the test meant to protect it.
    expect(existsSync(join(primary as string, ".git"))).toBe(true);
    expect(statSync(join(primary as string, ".git")).isDirectory()).toBe(true);
  });

  it("resolvePrimaryCheckout returns null outside a repo, and null never widens what is allowed", () => {
    expect(resolvePrimaryCheckout(tmpdir())).toBeNull();
    // With no forbidden path contributed, master is STILL refused — the
    // branch check is an independent defense, so an undeterminable primary
    // checkout degrades this layer without opening a bypass.
    const result = evaluateTargetSafety({ resolvedPath: "/anywhere", branch: "master" }, { forbiddenPaths: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("forbidden_branch");
  });

  it("refuses a revoy2-w4* worker checkout basename", () => {
    expect(FORBIDDEN_WORKER_BASENAME_PATTERN.test("revoy2-w4a")).toBe(true);
    const result = evaluateTargetSafety({ resolvedPath: "/home/x/revoy2-w4b", branch: "feat/whatever" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("forbidden_worker_checkout");
  });

  it("refuses when the branch could not be determined (not a git repo)", () => {
    const result = evaluateTargetSafety({ resolvedPath: "/some/path", branch: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("target_not_a_git_repo");
  });

  it("allows a safe branch, safe path, safe basename", () => {
    const result = evaluateTargetSafety({ resolvedPath: "/home/x/revoy2-gov", branch: "feat/adr-governance-control-plane" });
    expect(result.ok).toBe(true);
  });

  it("honours an injected forbidden-paths override (test-only substitute for the real primary checkout)", () => {
    const fake = "/tmp/fake-primary-checkout";
    const refused = evaluateTargetSafety({ resolvedPath: fake, branch: "safe" }, { forbiddenPaths: [fake] });
    expect(refused.ok).toBe(false);
    const allowed = evaluateTargetSafety({ resolvedPath: "/tmp/other", branch: "safe" }, { forbiddenPaths: [fake] });
    expect(allowed.ok).toBe(true);
  });
});

// ============================================================
// IO SHELL — realpath + real `git rev-parse` against real temp repos.
// ============================================================

describe("checkTargetIsolationSafety (real git)", () => {
  it("refuses a real repo checked out on master", () => {
    const repo = makeRepo({ branch: "master" });
    expect(currentBranch(repo)).toBe("master");
    const result = checkTargetIsolationSafety(repo);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("forbidden_branch");
  });

  it("allows a real repo checked out on a safe feature branch", () => {
    const repo = makeRepo({ branch: "feat/selfhost-test" });
    const result = checkTargetIsolationSafety(repo);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.branch).toBe("feat/selfhost-test");
  });

  it("refuses a directory that is not a git repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-selfhost-notgit-"));
    liveRepos.push(dir);
    const result = checkTargetIsolationSafety(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("target_not_a_git_repo");
  });

  it("refuses a nonexistent path", () => {
    const result = checkTargetIsolationSafety(join(tmpdir(), "arbor-selfhost-does-not-exist-xyz"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("target_not_a_git_repo");
  });

  it("refuses a revoy2-w4* worker checkout on disk", () => {
    const parent = mkdtempSync(join(tmpdir(), "arbor-selfhost-"));
    const repo = makeRepo({ branch: "feat/x", parentDir: parent, dirName: "revoy2-w4a" });
    const result = checkTargetIsolationSafety(repo);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("forbidden_worker_checkout");
  });
});

// ============================================================
// planSelfhostWorktree — deterministic given a runId.
// ============================================================

describe("planSelfhostWorktree", () => {
  it("is a pure function of (targetPath, runId) — same inputs, same outputs", () => {
    const a = planSelfhostWorktree("/x/y", "fixed-run-id");
    const b = planSelfhostWorktree("/x/y", "fixed-run-id");
    expect(a).toEqual(b);
    expect(a.branch).toBe("arbor/selfhost/fixed-run-id");
    expect(a.path).toBe(join("/x/y", ".worktrees", "selfhost-fixed-run-id"));
  });

  it("never collides with the manager's own per-node lease naming (arbor/<campaign_id>/<node_id>)", () => {
    const runId = "r1";
    const plan = planSelfhostWorktree("/x/y", runId);
    const campaignId = `selfhost-${runId}`; // matches runSelfhostCampaign's campaignId derivation
    const examplePerNodeLeaseBranch = `arbor/${campaignId}/some-node-id`;
    expect(plan.branch).toBe("arbor/selfhost/r1");
    expect(plan.branch).not.toBe(examplePerNodeLeaseBranch);
    expect(examplePerNodeLeaseBranch.startsWith(plan.branch)).toBe(false);
  });
});

// ============================================================
// runSelfhostCampaign — end to end, against real throwaway repos.
// ============================================================

describe("runSelfhostCampaign — identity collision is a CONFLICT, not a failure", () => {
  it("refuses when the run's branch is already taken, and does not disturb it", () => {
    const repo = makeRepo({ branch: "feat/safe" });
    // Claim the identity first, exactly as an earlier run would have.
    const taken = spawnSync("git", ["branch", "arbor/selfhost/collide-branch"], { cwd: repo, encoding: "utf-8" });
    expect(taken.status).toBe(0);

    return runSelfhostCampaign({
      targetRepo: repo,
      task: "should never run",
      maxIterations: 5,
      maxSeconds: 30,
      runId: "collide-branch",
      executorOverride: throwingExecutor(),
    }).then((outcome) => {
      expect(outcome.kind).toBe("identity_conflict");
      if (outcome.kind === "identity_conflict") expect(outcome.detail).toContain("already exists");
      // CONFLICT, never FAILURE: the system worked and the answer is "taken".
      expect(exitCodeForOutcome(outcome)).toBe(EXIT_CODES.CONFLICT);
      // The pre-existing branch is untouched — refusing must not mutate it.
      const still = spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/arbor/selfhost/collide-branch"], { cwd: repo, encoding: "utf-8" });
      expect(still.status).toBe(0);
      expect(existsSync(join(repo, ".worktrees", "selfhost-collide-branch"))).toBe(false);
    });
  });

  it("refuses when the worktree path already exists", () => {
    const repo = makeRepo({ branch: "feat/safe" });
    const path = join(repo, ".worktrees", "selfhost-collide-path");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "sentinel.txt"), "an earlier run left this", "utf8");

    return runSelfhostCampaign({
      targetRepo: repo,
      task: "should never run",
      maxIterations: 5,
      maxSeconds: 30,
      runId: "collide-path",
      executorOverride: throwingExecutor(),
    }).then((outcome) => {
      expect(outcome.kind).toBe("identity_conflict");
      expect(exitCodeForOutcome(outcome)).toBe(EXIT_CODES.CONFLICT);
      // Nothing in the existing directory was touched. Reusing it would
      // interleave two runs' writes with no coordination.
      expect(readFileSync(join(path, "sentinel.txt"), "utf8")).toBe("an earlier run left this");
    });
  });

  it("a clean identity still runs — the check does not refuse everything", () => {
    // A conflict detector that always fires is not a detector.
    const repo = makeRepo({ branch: "feat/safe" });
    return runSelfhostCampaign({
      targetRepo: repo,
      task: "plan only",
      maxIterations: 5,
      maxSeconds: 30,
      dryRun: true,
      runId: "no-collision",
      executorOverride: throwingExecutor(),
    }).then((outcome) => {
      expect(outcome.kind).toBe("dry_run");
      expect(exitCodeForOutcome(outcome)).toBe(EXIT_CODES.SUCCESS);
    });
  });
});

describe("selfhost exit codes carry meaning", () => {
  it("an isolation refusal is VIOLATION — the gate worked, the answer is no", () => {
    const repo = makeRepo({ branch: "master" });
    return runSelfhostCampaign({
      targetRepo: repo,
      task: "should never run",
      maxIterations: 5,
      maxSeconds: 30,
      runId: "exit-refused",
      executorOverride: throwingExecutor(),
    }).then((outcome) => {
      expect(exitCodeForOutcome(outcome)).toBe(EXIT_CODES.VIOLATION);
      // The distinction that matters: a refusal must not read as a crash.
      expect(exitCodeForOutcome(outcome)).not.toBe(EXIT_CODES.FAILURE);
    });
  });

  it("no two outcome kinds collapse onto a single ambiguous code", () => {
    const codes = new Map<string, number>([
      ["refused", EXIT_CODES.VIOLATION],
      ["identity_conflict", EXIT_CODES.CONFLICT],
      ["worktree_failed", EXIT_CODES.FAILURE],
      ["dry_run", EXIT_CODES.SUCCESS],
    ]);
    expect(new Set(codes.values()).size).toBe(codes.size);
  });
});

describe("runSelfhostCampaign — isolation refusals (must be able to fail)", () => {
  it("refuses a target on master and creates nothing on disk", () => {
    const repo = makeRepo({ branch: "master" });
    return runSelfhostCampaign({
      targetRepo: repo,
      task: "should never run",
      maxIterations: 5,
      maxSeconds: 30,
      runId: "refused-master",
      executorOverride: throwingExecutor(),
    }).then((outcome) => {
      expect(outcome.kind).toBe("refused");
      if (outcome.kind === "refused") expect(outcome.error.kind).toBe("forbidden_branch");
      expect(existsSync(join(repo, ".worktrees"))).toBe(false);
    });
  });

  it("refuses the primary checkout path via an injected guard override", () => {
    const repo = makeRepo({ branch: "feat/safe" });
    return runSelfhostCampaign({
      targetRepo: repo,
      task: "should never run",
      maxIterations: 5,
      maxSeconds: 30,
      runId: "refused-primary",
      guard: { forbiddenPaths: [repo] }, // stand-in for the real primary-checkout constant
      executorOverride: throwingExecutor(),
    }).then((outcome) => {
      expect(outcome.kind).toBe("refused");
      if (outcome.kind === "refused") expect(outcome.error.kind).toBe("forbidden_primary_checkout");
      expect(existsSync(join(repo, ".worktrees"))).toBe(false);
    });
  });

  it("refuses a revoy2-w4* worker checkout path", () => {
    const parent = mkdtempSync(join(tmpdir(), "arbor-selfhost-"));
    const repo = makeRepo({ branch: "feat/safe", parentDir: parent, dirName: "revoy2-w4c" });
    return runSelfhostCampaign({
      targetRepo: repo,
      task: "should never run",
      maxIterations: 5,
      maxSeconds: 30,
      runId: "refused-worker",
      executorOverride: throwingExecutor(),
    }).then((outcome) => {
      expect(outcome.kind).toBe("refused");
      if (outcome.kind === "refused") expect(outcome.error.kind).toBe("forbidden_worker_checkout");
      expect(existsSync(join(repo, ".worktrees"))).toBe(false);
    });
  });

  it("refuses the real, harness-source-derived checkout on this machine", () => {
    // D2: the default forbidden path is now derived from where the RUNNING
    // CODE was loaded from (`resolveHarnessSourceCheckout`), not from
    // `process.cwd()` -- see the two directional tests below for why that
    // distinction is load-bearing.
    const harness = resolveHarnessSourceCheckout();
    if (!harness || !existsSync(harness)) return; // environment-dependent; skip gracefully elsewhere
    const result = checkTargetIsolationSafety(harness);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind === "forbidden_primary_checkout" || result.error.kind === "forbidden_branch").toBe(true);
  });

  // ============================================================
  // D2: default forbidden path must track where the running code was
  // loaded from, not `process.cwd()` -- a dogfood-clone regression
  // (2026-08-24) where `arbor-mcp selfhost --target .`, invoked from inside
  // a disposable clone, always refused with forbidden_primary_checkout: the
  // clone's own primary checkout (derived from cwd) trivially equalled the
  // resolved target on every invocation of this shape.
  // ============================================================
  describe("D2: default forbidden path tracks the running code, not process.cwd()", () => {
    it("does not forbid a target merely because it equals process.cwd() (the disposable-clone-invoked-from-inside-it shape)", () => {
      const repo = makeRepo({ branch: "feat/dogfood-clone" });
      const originalCwd = process.cwd();
      process.chdir(repo);
      try {
        // Simulates `cd <disposable-clone> && arbor-mcp selfhost --target .`:
        // cwd and the resolved target are the same disposable clone, but the
        // running code (this test process) was loaded from the real harness
        // checkout, not from inside `repo` -- so the default guard must not
        // treat `repo` as forbidden.
        const result = checkTargetIsolationSafety(repo);
        expect(result.ok).toBe(true);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it("still refuses the real harness source checkout regardless of process.cwd()", () => {
      const harness = resolveHarnessSourceCheckout();
      if (!harness || !existsSync(harness)) return; // environment-dependent; skip gracefully elsewhere
      const repo = makeRepo({ branch: "feat/somewhere-else" });
      const originalCwd = process.cwd();
      process.chdir(repo);
      try {
        // cwd is now a completely unrelated repo, but the target IS the
        // real harness checkout -- must still refuse.
        const result = checkTargetIsolationSafety(harness);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.kind === "forbidden_primary_checkout" || result.error.kind === "forbidden_branch").toBe(true);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });
});

describe("runSelfhostCampaign — dry run", () => {
  it("composes the full plan but dispatches nothing to a model and creates no worktree", async () => {
    const repo = makeRepo({ branch: "feat/dry-run" });
    const outcome = await runSelfhostCampaign({
      targetRepo: repo,
      task: "dry run task",
      maxIterations: 3,
      maxSeconds: 10,
      dryRun: true,
      runId: "dry-1",
      executorOverride: throwingExecutor(), // if this were ever called, the promise would reject and the test would fail
    });
    expect(outcome.kind).toBe("dry_run");
    if (outcome.kind !== "dry_run") return;
    expect(outcome.plan.dry_run).toBe(true);
    expect(outcome.plan.worktree_branch).toBe("arbor/selfhost/dry-1");
    expect(outcome.plan.max_iterations).toBe(3);
    expect(outcome.plan.max_seconds).toBe(10);
    expect(existsSync(outcome.plan.worktree_path)).toBe(false);
    expect(existsSync(join(repo, ".worktrees"))).toBe(false);
  });

  it("is deterministic given the same runId", async () => {
    const repo = makeRepo({ branch: "feat/dry-run-2" });
    const a = await runSelfhostCampaign({ targetRepo: repo, task: "t", maxIterations: 1, maxSeconds: 1, dryRun: true, runId: "dry-det" });
    const b = await runSelfhostCampaign({ targetRepo: repo, task: "t", maxIterations: 1, maxSeconds: 1, dryRun: true, runId: "dry-det" });
    expect(a).toEqual(b);
  });
});

describe("runSelfhostCampaign — real bounded run (hermetic fake executor)", () => {
  it("creates and uses a worktree distinct from the invocation cwd, then cleans it up", async () => {
    const repo = makeRepo({ branch: "feat/real-run" });
    const captured = { worktreePaths: [] as string[], specializeCalls: 0 };
    const outcome = await runSelfhostCampaign({
      targetRepo: repo,
      task: "a small safe task",
      maxIterations: 1,
      maxSeconds: 30,
      runId: "real-1",
      executorOverride: makeApprovingExecutor(captured),
    });
    expect(outcome.kind).toBe("ran");
    if (outcome.kind !== "ran") return;

    expect(captured.specializeCalls).toBeGreaterThan(0);
    for (const path of captured.worktreePaths) {
      expect(path).not.toBe(repo);
      expect(path).not.toBe(process.cwd());
      expect(path.startsWith(join(outcome.plan.worktree_path, ".worktrees"))).toBe(true);
    }
    // Cleaned up by default (keepWorktree not set).
    expect(existsSync(outcome.plan.worktree_path)).toBe(false);
    expect(branchExists(repo, outcome.plan.worktree_branch)).toBe(false);
  });

  it("keeps the worktree on disk when keepWorktree is set, and never touches a branch it did not create", async () => {
    const repo = makeRepo({ branch: "feat/real-run-2" });

    const first = await runSelfhostCampaign({
      targetRepo: repo, task: "t1", maxIterations: 1, maxSeconds: 30,
      runId: "keep-a", keepWorktree: true,
      executorOverride: makeApprovingExecutor({ worktreePaths: [], specializeCalls: 0 }),
    });
    expect(first.kind).toBe("ran");
    if (first.kind !== "ran") return;
    expect(existsSync(first.plan.worktree_path)).toBe(true);
    expect(branchExists(repo, first.plan.worktree_branch)).toBe(true);

    const second = await runSelfhostCampaign({
      targetRepo: repo, task: "t2", maxIterations: 1, maxSeconds: 30,
      runId: "keep-b", keepWorktree: false,
      executorOverride: makeApprovingExecutor({ worktreePaths: [], specializeCalls: 0 }),
    });
    expect(second.kind).toBe("ran");
    if (second.kind !== "ran") return;
    // Its own worktree/branch is cleaned up...
    expect(existsSync(second.plan.worktree_path)).toBe(false);
    expect(branchExists(repo, second.plan.worktree_branch)).toBe(false);
    // ...but the FIRST run's kept branch/worktree is untouched.
    expect(existsSync(first.plan.worktree_path)).toBe(true);
    expect(branchExists(repo, first.plan.worktree_branch)).toBe(true);

    // Manual teardown of the intentionally-kept first worktree.
    spawnSync("git", ["-C", repo, "worktree", "remove", "--force", first.plan.worktree_path], { stdio: "ignore" });
    spawnSync("git", ["-C", repo, "branch", "-D", first.plan.worktree_branch], { stdio: "ignore" });
  });

  // ============================================================
  // D1: a verified, critic-approved node's worktree diff must survive lease
  // release as an adoptable capture (2026-08-24 dogfood: `captures: []`
  // always, because selfhost's CampaignLoopConfig never set `result_capture`
  // — `composeLoopConfigPorts` deliberately does not carry it; see
  // `selfhost.ts`'s own wiring comment for why it is wired per-caller here,
  // the same way `cli.ts`'s `createProductionCampaignLoopConfig` wires it).
  // ============================================================
  it("D1: captures a verified node's worktree diff so it survives lease release and is adoptable", async () => {
    const repo = makeRepo({ branch: "feat/result-capture" });
    const executor: LoopExecutor = {
      async specialize(params): Promise<SpecialistResult> {
        // A real file write in the worktree is what result_capture must
        // durably record — a text summary alone proves nothing about D1.
        writeFileSync(join(params.worktree_path, "captured.txt"), "produced by the specialist\n", "utf8");
        return {
          output: "wrote captured.txt",
          provenance: { tag: "verified", cmd: "true", exit: 0, stdout_hash: `sha256:${"a".repeat(64)}`, check: { kind: "shell_command", breadth: "single" } },
          token_usage: { kind: "unavailable", reason: "selfhost.test.ts hermetic fake — no real provider call" },
        };
      },
      async review(): Promise<CriticResult> {
        return {
          approved: true,
          rationale: "approved by hermetic test fake",
          critic_agent: "lenticel",
          measurement_validated: true,
          token_usage: { kind: "unavailable", reason: "selfhost.test.ts hermetic fake — no real provider call" },
        };
      },
    };

    const outcome = await runSelfhostCampaign({
      targetRepo: repo,
      task: "produce a small verifiable file",
      maxIterations: 3,
      maxSeconds: 30,
      runId: "capture-1",
      keepWorktree: true, // capture lives under <worktree>/.arbor — inspect it before any teardown removes it
      executorOverride: executor,
    });
    expect(outcome.kind).toBe("ran");
    if (outcome.kind !== "ran") return;
    expect(outcome.report.verified).toBeGreaterThan(0);

    const persistenceDir = join(outcome.plan.worktree_path, ".arbor");
    const { listCapturedResults, bestVerifiedResult } = await import("../src/result-adoption.js");
    const captures = listCapturedResults(persistenceDir, outcome.plan.campaign_id);
    expect(captures.length).toBeGreaterThan(0);
    expect(captures.some((record) => record.files.includes("captured.txt"))).toBe(true);

    const best = bestVerifiedResult(persistenceDir, outcome.plan.campaign_id);
    expect(best).not.toBeNull();
    expect(best?.verified).toBe(true);
    expect(best?.files).toContain("captured.txt");

    // Manual teardown of the intentionally-kept worktree.
    spawnSync("git", ["-C", repo, "worktree", "remove", "--force", outcome.plan.worktree_path], { stdio: "ignore" });
    spawnSync("git", ["-C", repo, "branch", "-D", outcome.plan.worktree_branch], { stdio: "ignore" });
  });

  it("honours the iteration cap: stops at max_iterations with pending work still available", async () => {
    const repo = makeRepo({ branch: "feat/cap-test" });
    const outcome = await runSelfhostCampaign({
      targetRepo: repo,
      task: "capped task",
      maxIterations: 1,
      maxSeconds: 60,
      runId: "cap-1",
      executorOverride: makeApprovingExecutor({ worktreePaths: [], specializeCalls: 0 }),
    });
    expect(outcome.kind).toBe("ran");
    if (outcome.kind !== "ran") return;
    expect(outcome.report.iterations).toBe(1);
    expect(outcome.report.halted).toBe(true);
    expect(outcome.report.halt_reason).toBe("max_iterations");
  });

  it("honours the wall-clock cap: aborts a hanging executor within the bound, never reaching max_iterations", async () => {
    const repo = makeRepo({ branch: "feat/wallclock-test" });
    const started = Date.now();
    const outcome = await runSelfhostCampaign({
      targetRepo: repo,
      task: "hangs forever",
      maxIterations: 1000, // deliberately far above what the wall clock will allow
      maxSeconds: 0.3,
      runId: "wallclock-1",
      executorOverride: makeHangingExecutor(),
    });
    const elapsedMs = Date.now() - started;
    expect(outcome.kind).toBe("ran");
    if (outcome.kind !== "ran") return;
    expect(outcome.report.cancelled).toBe(true);
    expect(outcome.report.iterations).toBeLessThan(1000);
    // Generous upper bound: proves the wall clock — not the 1000-iteration
    // cap — ended the run. The hanging executor would otherwise never return.
    expect(elapsedMs).toBeLessThan(15_000);
  });

  it("honours an external abort signal: cleans up the throwaway worktree/branch instead of leaving it orphaned", async () => {
    // Regression coverage for a real defect found while dispatching a live run
    // (2026-08-05): a hard-killed process skips every `finally`, including
    // worktree cleanup. `externalSignal` is how `selfhostMain` forwards a real
    // OS SIGINT/SIGTERM into the SAME cooperative-cancel path the wall-clock
    // timer uses, so cleanup still runs instead of orphaning the worktree.
    const repo = makeRepo({ branch: "feat/external-abort-test" });
    const external = new AbortController();
    const runPromise = runSelfhostCampaign({
      targetRepo: repo,
      task: "hangs until externally aborted",
      maxIterations: 1000,
      maxSeconds: 60, // far longer than this test should take — external abort must end it, not the wall clock
      runId: "external-abort-1",
      executorOverride: makeHangingExecutor(),
      externalSignal: external.signal,
    });
    external.abort(new Error("test-driven external cancellation"));
    const outcome = await runPromise;

    expect(outcome.kind).toBe("ran");
    if (outcome.kind !== "ran") return;
    expect(outcome.report.cancelled).toBe(true);
    expect(existsSync(outcome.plan.worktree_path)).toBe(false);
    expect(branchExists(repo, outcome.plan.worktree_branch)).toBe(false);
  });
});

// ============================================================
// DECOMPOSER WIRING (G-08) — regression coverage for a real gap found while
// verifying the decompose route end-to-end: `demo.ts`'s real-executor path
// set `config.decomposer`, but `runSelfhostCampaign`'s own CampaignLoopConfig
// never did, so FAULT_MATRIX's timeout -> "decompose" recovery was silently
// inert for every `arbor-mcp selfhost` run. Proven here the same way the rest
// of this file proves real behavior: a hermetic fake executor that always
// times out, plus a hermetic fake DecomposerPort, driven through the REAL
// campaign loop (not a mock of the loop itself).
// ============================================================

describe("runSelfhostCampaign — decomposer wiring (G-08 timeout -> decompose)", () => {
  it("wires a DecomposerPort into CampaignLoopConfig: a timed-out node is split instead of just failing", async () => {
    const repo = makeRepo({ branch: "feat/decompose-wiring-test" });
    const children: Action[] = [
      { description: "child A", estimated_gain: 3, estimated_cost: 1, category: "maintenance", delegate_to: "seed" },
      { description: "child B", estimated_gain: 3, estimated_cost: 1, category: "maintenance", delegate_to: "seed" },
    ];

    const outcome = await runSelfhostCampaign({
      targetRepo: repo,
      task: "an epic too large for one specialist pass",
      maxIterations: 1,
      maxSeconds: 30,
      runId: "decompose-wiring-1",
      executorOverride: makeAlwaysTimingOutExecutor(),
      decomposerOverride: makeDecomposerStub(children),
    });

    expect(outcome.kind).toBe("ran");
    if (outcome.kind !== "ran") return;
    // The only way this is nonzero is if `config.decomposer` was actually
    // wired and FAULT_MATRIX's dispatch at loop.ts reached it.
    expect(outcome.report.decomposed).toBeGreaterThan(0);
    expect(outcome.report.failed).toBe(0);
  });

  it("without a decomposerOverride, the opencode decomposer is reached only on the admitted opencode-direct lane", () => {
    // Same style as the "static safety audit" block below: proves the
    // wiring without requiring a live opencode binary. Canopy-only (amends
    // ADR-061): the opencode decomposer used to be the unconditional last
    // resort, so a native-lane campaign silently decomposed through a
    // connector. It is now gated on the recorded deprecated-lane admission.
    const path = fileURLToPath(new URL("../src/selfhost.ts", import.meta.url));
    const source = readFileSync(resolve(path), "utf8");
    expect(source).toMatch(/decomposer:\s*\n?\s*options\.decomposerOverride\s*\?\?\s*\n?\s*integrationDecomposer\s*\?\?\s*\n?\s*\(openCodeAdmission === undefined \? undefined : createOpenCodeDecomposer/);
    expect(source).toMatch(/admitDeprecatedHarnessLane\("opencode"/);
  });
});

// ============================================================
// STATIC SAFETY AUDIT — never push, never merge, never delete a foreign branch.
// ============================================================

describe("selfhost.ts source — static safety audit", () => {
  it("never shells out to `git push` or `git merge`", () => {
    const path = fileURLToPath(new URL("../src/selfhost.ts", import.meta.url));
    const source = readFileSync(resolve(path), "utf8");
    // Looks for an actual git argv entry, not prose mentioning the words.
    expect(source).not.toMatch(/"push"/);
    expect(source).not.toMatch(/"merge"/);
  });

  it("only ever removes a branch/worktree derived from its own generated plan (never a caller-supplied path)", () => {
    const path = fileURLToPath(new URL("../src/selfhost.ts", import.meta.url));
    const source = readFileSync(resolve(path), "utf8");
    const removeCallMatch = source.match(/function removeSelfhostWorktree[\s\S]*?\n}/);
    expect(removeCallMatch).not.toBeNull();
    const body = removeCallMatch![0];
    expect(body).toContain("plan.path");
    expect(body).toContain("plan.branch");
    // No other identifiers are passed as the branch/path to remove.
    expect(body).not.toMatch(/targetRepo|options\./);
  });
});

// ============================================================
// TRACK B3 — task selection from the real derived governance backlog.
// ============================================================

describe("runSelfhostCampaign — fromBacklog (Track B3)", () => {
  it("dry-run selects a real backlog item deriving from a real POL-04 finding, and dispatches nothing", async () => {
    const repo = makeRepo({ branch: "feat/backlog-dry-run" });
    writeDecisionRecord(repo, "ADR-900-fixture-buildable.md", BUILDABLE_FIXTURE);
    writeDecisionRecord(repo, "ADR-901-fixture-nongoal.md", NOT_APPLICABLE_FIXTURE);

    const outcome = await runSelfhostCampaign({
      targetRepo: repo,
      task: "this string must be ignored — fromBacklog overrides it",
      maxIterations: 1,
      maxSeconds: 5,
      dryRun: true,
      runId: "backlog-dry-1",
      fromBacklog: true,
      backlogAt: BACKLOG_AT,
      executorOverride: throwingExecutor(),
    });

    expect(outcome.kind).toBe("dry_run");
    if (outcome.kind !== "dry_run") return;

    const selection = outcome.plan.backlog_selection;
    expect(selection).toBeDefined();
    // The buildable record, never the not_applicable one.
    expect(selection?.record_id).toBe("revoy2:ADR-900");
    expect(selection?.finding_rule_id).toBe("POL-04");
    expect(selection?.finding_detail).toContain("revoy2:ADR-900");
    expect(selection?.total_backlog_items).toBe(2); // both POL-04 findings, only one selected
    expect(selection?.selection_reason).toContain("author_obligations");

    // The dispatched task IS the rendered brief for that item, not the
    // hand-passed (and ignored) `task` string.
    expect(outcome.plan.task).toContain("ADR-900");
    expect(outcome.plan.task).toContain("## Obligations");
    expect(outcome.plan.task).not.toContain("must be ignored");

    // Dry run still creates nothing.
    expect(existsSync(join(repo, ".worktrees"))).toBe(false);
  });

  it("never selects a not_applicable item even when it sorts first among filenames", async () => {
    const repo = makeRepo({ branch: "feat/backlog-skip-na" });
    // Filename order deliberately puts the not_applicable record first.
    writeDecisionRecord(repo, "ADR-800-fixture-nongoal.md", NOT_APPLICABLE_FIXTURE.replace("ADR-901", "ADR-800"));
    writeDecisionRecord(repo, "ADR-950-fixture-buildable.md", BUILDABLE_FIXTURE.replace("ADR-900", "ADR-950"));

    const outcome = await runSelfhostCampaign({
      targetRepo: repo,
      task: "ignored",
      maxIterations: 1,
      maxSeconds: 5,
      dryRun: true,
      runId: "backlog-dry-2",
      fromBacklog: true,
      backlogAt: BACKLOG_AT,
      executorOverride: throwingExecutor(),
    });

    expect(outcome.kind).toBe("dry_run");
    if (outcome.kind !== "dry_run") return;
    expect(outcome.plan.backlog_selection?.record_id).toBe("revoy2:ADR-950");
  });

  it("reports backlog_empty (and dispatches nothing) when every remaining item is not_applicable", async () => {
    const repo = makeRepo({ branch: "feat/backlog-empty" });
    writeDecisionRecord(repo, "ADR-901-fixture-nongoal.md", NOT_APPLICABLE_FIXTURE);

    const outcome = await runSelfhostCampaign({
      targetRepo: repo,
      task: "ignored",
      maxIterations: 1,
      maxSeconds: 5,
      dryRun: true,
      runId: "backlog-empty-1",
      fromBacklog: true,
      backlogAt: BACKLOG_AT,
      executorOverride: throwingExecutor(),
    });

    expect(outcome.kind).toBe("backlog_empty");
    if (outcome.kind !== "backlog_empty") return;
    expect(outcome.total_backlog_items).toBe(1);
    expect(existsSync(join(repo, ".worktrees"))).toBe(false);
  });

  it("reports backlog_derivation_failed (not a throw) when the target has no decisions/ directory", async () => {
    const repo = makeRepo({ branch: "feat/backlog-no-decisions" });

    const outcome = await runSelfhostCampaign({
      targetRepo: repo,
      task: "ignored",
      maxIterations: 1,
      maxSeconds: 5,
      dryRun: true,
      runId: "backlog-nofail-1",
      fromBacklog: true,
      backlogAt: BACKLOG_AT,
      executorOverride: throwingExecutor(),
    });

    expect(outcome.kind).toBe("backlog_derivation_failed");
    if (outcome.kind !== "backlog_derivation_failed") return;
    expect(outcome.error.code).toBe("unavailable");
  });

  it("throws synchronously when fromBacklog is set without backlogAt (caller programming error, same class as missing max_iterations)", async () => {
    const repo = makeRepo({ branch: "feat/backlog-no-at" });
    await expect(
      runSelfhostCampaign({
        targetRepo: repo,
        task: "ignored",
        maxIterations: 1,
        maxSeconds: 5,
        dryRun: true,
        runId: "backlog-noat-1",
        fromBacklog: true,
        executorOverride: throwingExecutor(),
      }),
    ).rejects.toThrow(/backlogAt is required/);
  });

  it("an item satisfied between runs (an Obligations section authored) is not re-selected on the next derivation — proves selection is never stale/cached", async () => {
    const repo = makeRepo({ branch: "feat/backlog-satisfied" });
    writeDecisionRecord(repo, "ADR-902-fixture-buildable.md", BUILDABLE_FIXTURE.replace("ADR-900", "ADR-902"));

    const first = await runSelfhostCampaign({
      targetRepo: repo,
      task: "ignored",
      maxIterations: 1,
      maxSeconds: 5,
      dryRun: true,
      runId: "backlog-sat-1",
      fromBacklog: true,
      backlogAt: BACKLOG_AT,
      executorOverride: throwingExecutor(),
    });
    expect(first.kind).toBe("dry_run");
    if (first.kind !== "dry_run") return;
    expect(first.plan.backlog_selection?.record_id).toBe("revoy2:ADR-902");

    // Simulate the campaign's own claimed outcome: the record now carries a
    // real "## Obligations" section, so POL-04 no longer fires for it.
    writeDecisionRecord(
      repo,
      "ADR-902-fixture-buildable.md",
      BUILDABLE_FIXTURE.replace("ADR-900", "ADR-902") +
        "\n## Obligations\n\n### O1 — the widget factory exists\n\n<!-- proof: symbol=widgetFactory file=packages/example/src/widget.ts -->\n",
    );

    const second = await runSelfhostCampaign({
      targetRepo: repo,
      task: "ignored",
      maxIterations: 1,
      maxSeconds: 5,
      dryRun: true,
      runId: "backlog-sat-2",
      fromBacklog: true,
      backlogAt: BACKLOG_AT,
      executorOverride: throwingExecutor(),
    });
    // Nothing buildable remains — the satisfied record dropped out of the
    // backlog entirely (it no longer carries a POL-04 finding at all), it was
    // not merely skipped in favor of something else.
    expect(second.kind).toBe("backlog_empty");
    if (second.kind !== "backlog_empty") return;
    expect(second.total_backlog_items).toBe(0);
  });
});

describe("selfhostMain — CLI argv wiring for --run-id and --from-backlog", () => {
  it("--run-id pins the worktree branch/path so a caller (e.g. demo-window.sh) can predict them ahead of the run", async () => {
    const repo = makeRepo({ branch: "feat/cli-run-id" });
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await selfhostMain(
      ["selfhost", "--dry-run", "--max-iterations", "1", "--max-seconds", "5", "--target", repo, "--run-id", "pinned-demo-id"].slice(1),
      { cwd: repo, stdout: stdout.stream, stderr: stderr.stream },
    );

    expect(code).toBe(0);
    expect(stdout.text()).toContain("arbor/selfhost/pinned-demo-id");
    expect(stdout.text()).toContain(join(".worktrees", "selfhost-pinned-demo-id"));
    expect(stderr.text()).toBe("");
  });

  it("D4: repeatable --verification-cmd parses without a usage error (each occurrence one ordered stage)", async () => {
    const repo = makeRepo({ branch: "feat/cli-staged-verify" });
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await selfhostMain(
      [
        "--dry-run", "--max-iterations", "1", "--max-seconds", "5", "--target", repo,
        "--verification-cmd", "bun run build",
        "--verification-cmd", "bun x vitest run some.test.ts",
      ],
      { cwd: repo, stdout: stdout.stream, stderr: stderr.stream },
    );

    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(stderr.text()).toBe("");
    expect(stdout.text()).toContain("DRY RUN");
  });

  it("--from-backlog through the real CLI argv path selects and prints a real backlog item", async () => {
    const repo = makeRepo({ branch: "feat/cli-from-backlog" });
    writeDecisionRecord(repo, "ADR-903-fixture-buildable.md", BUILDABLE_FIXTURE.replace("ADR-900", "ADR-903"));
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await selfhostMain(
      ["--dry-run", "--max-iterations", "1", "--max-seconds", "5", "--target", repo, "--from-backlog", "--backlog-at", BACKLOG_AT],
      { cwd: repo, stdout: stdout.stream, stderr: stderr.stream },
    );

    expect(code).toBe(0);
    expect(stdout.text()).toContain("revoy2:ADR-903");
    expect(stdout.text()).toContain("backlog selection");
    expect(stderr.text()).toBe("");
  });

  it("exits 1 and reports the class of failure when --from-backlog finds nothing but not_applicable items", async () => {
    const repo = makeRepo({ branch: "feat/cli-backlog-empty" });
    writeDecisionRecord(repo, "ADR-904-fixture-nongoal.md", NOT_APPLICABLE_FIXTURE.replace("ADR-901", "ADR-904"));
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await selfhostMain(
      ["--dry-run", "--max-iterations", "1", "--max-seconds", "5", "--target", repo, "--from-backlog", "--backlog-at", BACKLOG_AT],
      { cwd: repo, stdout: stdout.stream, stderr: stderr.stream },
    );

    // "Nothing to dispatch" is a legitimate outcome, not a tool failure — exit 0.
    expect(code).toBe(0);
    expect(stdout.text()).toContain("NOTHING to dispatch");
  });

  // ============================================================
  // D3: selfhost always runs the opencode connector — it must SAY SO rather
  // than silently ignoring an operator's ARBOR_HARNESS_INTEGRATION, the way
  // every other surface (cli.ts, doctor.ts) honors it.
  // ============================================================
  describe("D3: ARBOR_HARNESS_INTEGRATION divergence is surfaced, never silent", () => {
    const originalEnv = process.env.ARBOR_HARNESS_INTEGRATION;
    afterEach(() => {
      if (originalEnv === undefined) delete process.env.ARBOR_HARNESS_INTEGRATION;
      else process.env.ARBOR_HARNESS_INTEGRATION = originalEnv;
    });

    it("D3 closed: a non-opencode ARBOR_HARNESS_INTEGRATION is honoured through the registry, so no 'no effect' warning is emitted", async () => {
      const repo = makeRepo({ branch: "feat/d3-honoured" });
      process.env.ARBOR_HARNESS_INTEGRATION = "claude-code";
      const stdout = captureStream();
      const stderr = captureStream();

      const code = await selfhostMain(
        ["--dry-run", "--max-iterations", "1", "--max-seconds", "5", "--target", repo],
        { cwd: repo, stdout: stdout.stream, stderr: stderr.stream },
      );

      expect(code).toBe(0);
      expect(stderr.text()).not.toContain("has no effect here");
      expect(stderr.text()).not.toContain("always dispatches");
    });

    it("the help text names the integration switch instead of the old opencode-only executor", async () => {
      const stdout = captureStream();
      const stderr = captureStream();
      await selfhostMain(["--help"], { cwd: process.cwd(), stdout: stdout.stream, stderr: stderr.stream });
      expect(stdout.text()).toContain("ARBOR_HARNESS_INTEGRATION selects");
      expect(stdout.text()).toContain("verification.acceptance_commands");
    });

    it("stays silent when ARBOR_HARNESS_INTEGRATION is unset or already opencode", async () => {
      const repo = makeRepo({ branch: "feat/d3-quiet" });
      delete process.env.ARBOR_HARNESS_INTEGRATION;
      const stdout = captureStream();
      const stderr = captureStream();

      const code = await selfhostMain(
        ["--dry-run", "--max-iterations", "1", "--max-seconds", "5", "--target", repo],
        { cwd: repo, stdout: stdout.stream, stderr: stderr.stream },
      );

      expect(code).toBe(0);
      expect(stderr.text()).toBe("");
    });

    it("--help states that the connector lanes are deprecated and how to opt in", async () => {
      const stdout = captureStream();
      const stderr = captureStream();
      const code = await selfhostMain(["--help"], { cwd: process.cwd(), stdout: stdout.stream, stderr: stderr.stream });
      expect(code).toBe(0);
      expect(stdout.text()).toContain("ARBOR_HARNESS_INTEGRATION");
      expect(stdout.text()).toContain("Canopy harness (revoy-native)");
      expect(stdout.text()).toContain("DEPRECATED until after 1.0.0");
      expect(stdout.text()).toContain("connectors.allow_deprecated");
    });
  });
});

describe("runSelfhostCampaign — Canopy-only lane policy (amends ADR-061)", () => {
  it("refuses the opencode-direct path that --verification-cmd forces when connectors.allow_deprecated is not set, and leaves no worktree", async () => {
    const repo = makeRepo({ branch: "feat/canopy-refusal" });
    let caught: unknown;
    try {
      await runSelfhostCampaign({
        targetRepo: repo, task: "a small safe task", maxIterations: 1, maxSeconds: 30, runId: "canopy-refusal",
        verificationCmds: ["true"], dependencyProvisioning: { enabled: false },
      });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(DeprecatedHarnessRefusal);
    expect((caught as DeprecatedHarnessRefusal).refusal).toMatchObject({ code: "deprecated_harness_lane", correcting_actor: "operator", corrective_action: "grant_capability" });
    expect((caught as DeprecatedHarnessRefusal).site).toBe("selfhost --verification-cmd");
    expect(existsSync(join(repo, ".worktrees", "selfhost-canopy-refusal"))).toBe(false);
  });
});

/** Adds a `file:`-dependency bun project to an already-committed fixture repo, offline (no network). */
function addBunProject(repo: string): void {
  mkdirSync(join(repo, "local-pkg"), { recursive: true });
  writeFileSync(join(repo, "local-pkg", "package.json"), JSON.stringify({ name: "local-pkg", version: "1.0.0" }));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0", dependencies: { "local-pkg": "file:./local-pkg" } }));
  writeFileSync(join(repo, "bun.lock"), JSON.stringify({
    lockfileVersion: 1, configVersion: 1,
    workspaces: { "": { name: "proj", dependencies: { "local-pkg": "file:./local-pkg" } } },
    packages: { "local-pkg": ["local-pkg@file:./local-pkg", {}] },
  }));
  spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "commit", "-qm", "add bun project"], { stdio: "ignore" });
}

/** Same shape, but the declared dependency does not exist on disk -- install fails deterministically, offline. */
function addBrokenBunProject(repo: string): void {
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0", dependencies: { "missing-pkg": "file:./missing-pkg" } }));
  writeFileSync(join(repo, "bun.lock"), JSON.stringify({
    lockfileVersion: 1, configVersion: 1,
    workspaces: { "": { name: "proj", dependencies: { "missing-pkg": "file:./missing-pkg" } } },
    packages: { "missing-pkg": ["missing-pkg@file:./missing-pkg", {}] },
  }));
  spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "commit", "-qm", "add broken bun project"], { stdio: "ignore" });
}

describe("runSelfhostCampaign — throwaway worktree dependency provisioning", () => {
  it("installs the target repo's own dependencies into the throwaway worktree before dispatch", async () => {
    const repo = makeRepo({ branch: "feat/provision-1" });
    addBunProject(repo);

    const outcome = await runSelfhostCampaign({
      targetRepo: repo, task: "t", maxIterations: 1, maxSeconds: 30, runId: "provision-1",
      executorOverride: makeApprovingExecutor({ worktreePaths: [], specializeCalls: 0 }),
    });

    expect(outcome.kind).toBe("ran");
    if (outcome.kind !== "ran") return;
    expect(outcome.dependency_provisioning).toMatchObject({ status: "installed", ecosystem: "bun" });
  });

  it("skips (typed, not silent) when the target repo has no recognized lockfile", async () => {
    const repo = makeRepo({ branch: "feat/provision-2" });

    const outcome = await runSelfhostCampaign({
      targetRepo: repo, task: "t", maxIterations: 1, maxSeconds: 30, runId: "provision-2",
      executorOverride: makeApprovingExecutor({ worktreePaths: [], specializeCalls: 0 }),
    });

    expect(outcome.kind).toBe("ran");
    if (outcome.kind !== "ran") return;
    expect(outcome.dependency_provisioning).toEqual({ status: "skipped", reason: "no_lockfile" });
  });

  it("skips installation entirely when dependencyProvisioning.enabled is false", async () => {
    const repo = makeRepo({ branch: "feat/provision-3" });
    addBunProject(repo);

    const outcome = await runSelfhostCampaign({
      targetRepo: repo, task: "t", maxIterations: 1, maxSeconds: 30, runId: "provision-3",
      dependencyProvisioning: { enabled: false },
      executorOverride: makeApprovingExecutor({ worktreePaths: [], specializeCalls: 0 }),
    });

    expect(outcome.kind).toBe("ran");
    if (outcome.kind !== "ran") return;
    expect(outcome.dependency_provisioning).toEqual({ status: "disabled" });
  });

  it("fails the worktree honestly (never a half-usable worktree) when the install fails, cleaning up worktree and branch", async () => {
    const repo = makeRepo({ branch: "feat/provision-4" });
    addBrokenBunProject(repo);

    const outcome = await runSelfhostCampaign({
      targetRepo: repo, task: "t", maxIterations: 1, maxSeconds: 30, runId: "provision-4",
      executorOverride: makeApprovingExecutor({ worktreePaths: [], specializeCalls: 0 }),
    });

    expect(outcome.kind).toBe("worktree_failed");
    if (outcome.kind !== "worktree_failed") return;
    expect(outcome.error).toContain("dependency install failed");
    expect(existsSync(outcome.plan.worktree_path)).toBe(false);
    expect(branchExists(repo, outcome.plan.worktree_branch)).toBe(false);
  });

  it("selfhostMain accepts --skip-dependency-install and --dependency-install-timeout-ms as recognized flags", async () => {
    // Dry-run: proves the CLI parses and forwards the flags without hitting
    // "unknown selfhost flag" (dry-run stops before any dispatch, so this
    // stays hermetic — a full non-dry-run CLI invocation would need a real
    // `opencode` binary, which selfhostMain's production path always uses).
    const repo = makeRepo({ branch: "feat/provision-cli" });
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await selfhostMain(
      ["--dry-run", "--max-iterations", "1", "--max-seconds", "30", "--target", repo, "--run-id", "provision-cli",
        "--skip-dependency-install", "--dependency-install-timeout-ms", "5000"],
      { cwd: repo, stdout: stdout.stream, stderr: stderr.stream },
    );

    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(stderr.text()).toBe("");
  });
});

/** Commits a syntactically-valid but semantically-invalid arbor.jsonc into a
 * fixture repo, so the throwaway worktree checks it out on `git worktree
 * add` and `createCliRuntime` trips over it while composing the runtime —
 * a synchronous throw with no filesystem or git side effect of its own. */
function addInvalidConfig(repo: string): void {
  writeFileSync(join(repo, "arbor.jsonc"), JSON.stringify({ tree_search: { min_score: "not-a-number" } }));
  spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "commit", "-qm", "add invalid config"], { stdio: "ignore" });
}

describe("runSelfhostCampaign — worktree/branch cleanup when runtime composition throws", () => {
  it("does not orphan the throwaway worktree/branch when createCliRuntime throws synchronously", async () => {
    const repo = makeRepo({ branch: "feat/runtime-throw-1" });
    addInvalidConfig(repo);

    await expect(runSelfhostCampaign({
      targetRepo: repo, task: "t", maxIterations: 1, maxSeconds: 30, runId: "runtime-throw-1",
      executorOverride: makeApprovingExecutor({ worktreePaths: [], specializeCalls: 0 }),
    })).rejects.toThrow(/Invalid Arbor config/);

    const plan = planSelfhostWorktree(repo, "runtime-throw-1");
    expect(existsSync(plan.path)).toBe(false);
    expect(branchExists(repo, plan.branch)).toBe(false);
  });
});

describe("runSelfhostCampaign — runId confinement (a path-traversal runId must never compute a path outside the target repo)", () => {
  it("planSelfhostWorktree: proves the underlying hazard — a '..'-laden runId computes a path outside the target repo", () => {
    const repo = "/tmp/arbor-selfhost-example";
    const plan = planSelfhostWorktree(repo, "../../../../escape-marker");
    // If this ever starts failing because the escape stops landing outside
    // `repo`, the validation below in `runSelfhostCampaign` may have become
    // redundant, but it is still the enforcement point — this test only
    // documents why it exists.
    expect(plan.path.startsWith(repo)).toBe(false);
  });

  it("refuses a runId containing path-traversal/separator characters before any worktree is planned or created", async () => {
    const repo = makeRepo({ branch: "feat/runid-traversal" });

    await expect(runSelfhostCampaign({
      targetRepo: repo, task: "t", maxIterations: 1, maxSeconds: 5, dryRun: true,
      runId: "../../../../escape-marker",
    })).rejects.toThrow(/runId/);
  });
});
