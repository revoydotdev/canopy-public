/**
 * verification-evidence-honesty.test.ts — the path that turns a self-attested
 * claim into machine evidence must report what actually happened.
 *
 * WHY THIS EXISTS. Across two real 60-minute campaigns `loop.node_verified`
 * was zero: no campaign had ever been run with a verification command, so
 * every success stopped at `claimed`. Before switching that on for a demo,
 * the path was swept — and almost its entire failure surface was inorganic,
 * failing or misreporting for reasons unrelated to whether the specialist's
 * work was correct:
 *
 *   - stderr was piped but never read. Compilers, linters and test runners
 *     report failures on stderr, so a failed verification could produce an
 *     opaque `claimed` with no diagnostic text at all. Worse, an unread pipe
 *     fills: a chatty command blocks on write until the timeout kills it.
 *   - a non-zero exit, a command that could not be spawned, and a command
 *     that hung all resolved the same `{ ok: false }`, indistinguishable
 *     downstream — no code, no kind, nothing like the closed `NodeError`
 *     union that dispatch failures get.
 *   - the worktree was checked with a non-empty-string test rather than for
 *     existence, so a removed worktree became an ENOENT that collapsed to
 *     `claimed`.
 *   - the staged arm hardcoded `exit: 0` on pass and `null` on failure, and
 *     the `verified` provenance hardcoded `exit: 0` rather than reading the
 *     real code — a field that was not evidence of what it claimed.
 *   - stdout accumulated unbounded.
 *
 * These tests drive the real functions against real commands. Nothing here is
 * mocked: `false`, `exit 3` and a nonexistent binary are genuine failures of
 * the three distinct kinds.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Action } from "@arbor/core";
import { runVerification, runStagedVerification, createOpenCodeLoopExecutor } from "../src/opencode-executor.js";

const FAKE_OPENCODE_BIN = join(dirname(fileURLToPath(import.meta.url)), "fixtures/fake-opencode.mjs");

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "arbor-verify-")); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe("runVerification distinguishes the ways a check can fail", () => {
  it("passes a command that exits 0 and reports the real exit code", async () => {
    const result = await runVerification("exit 0", dir, 10_000);
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("passed");
    expect(result.exit).toBe(0);
  });

  it("reports a genuine test failure as `failed`, carrying the real exit code", async () => {
    // This is the only failure kind that says anything about the work.
    const result = await runVerification("exit 3", dir, 10_000);
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("failed");
    expect(result.exit).toBe(3);
  });

  it("reports a missing verification binary as a harness fault, not as a test failure", async () => {
    // The command runs under `shell: true`, so a missing binary never reaches
    // spawn's error path — the shell starts fine and exits 127. Calling that
    // a test failure would accuse the specialist's work of a typo in
    // `--verification-cmd`.
    const result = await runVerification("/nonexistent/definitely-not-a-binary --run", dir, 10_000);
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("spawn_failed");
    expect(result.exit).toBe(127);
  });

  it("reports a hung command as `timed_out` rather than as a failing test", async () => {
    const result = await runVerification("sleep 30", dir, 400);
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("timed_out");
  });

  it("refuses a worktree that does not exist instead of producing an opaque failure", async () => {
    const result = await runVerification("exit 0", join(dir, "no-such-worktree"), 10_000);
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("worktree_missing");
  });

  it("captures stderr so a failure carries its diagnostic", async () => {
    // Without this a failing `tsc` or `vitest` produced no readable reason.
    const result = await runVerification("echo 'error TS2322: type mismatch' >&2; exit 2", dir, 10_000);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("TS2322");
  });

  it("drains a chatty stderr rather than deadlocking on a full pipe", async () => {
    // stderr was piped and never read: once the OS pipe buffer filled the
    // child blocked on write and only the timeout ended it. Well over one
    // buffer's worth, with a generous timeout — if this test times out
    // instead of passing, the drain regressed.
    const result = await runVerification("yes 'noisy diagnostic line' | head -c 400000 >&2; exit 0", dir, 20_000);
    expect(result.kind).toBe("passed");
  });

  it("bounds captured output so a runaway command cannot exhaust memory", async () => {
    const result = await runVerification("yes 'x' | head -c 5000000", dir, 20_000);
    expect(result.stdout.length).toBeLessThan(2_000_000);
  });
});

describe("runStagedVerification reports each stage honestly", () => {
  it("records the real exit code of a failing stage rather than null", async () => {
    const result = await runStagedVerification(["exit 0", "exit 7"], dir, 10_000);
    expect(result.ok).toBe(false);
    const failing = result.stageResults.at(-1);
    expect(failing?.exit).toBe(7);
  });

  it("stops at the first failing stage (ordered, fail-fast)", async () => {
    const result = await runStagedVerification(["exit 5", "exit 0"], dir, 10_000);
    expect(result.ok).toBe(false);
    expect(result.stageResults).toHaveLength(1);
  });

  it("distinguishes a stage that could not run from a stage that failed", async () => {
    const result = await runStagedVerification(["/nonexistent/not-a-binary"], dir, 10_000);
    expect(result.ok).toBe(false);
    expect(result.stageResults.at(-1)?.kind).toBe("spawn_failed");
  });

  it("surfaces the failing stage's stderr in the combined output", async () => {
    const result = await runStagedVerification(["echo 'boom' >&2; exit 1"], dir, 10_000);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("boom");
  });
});

/**
 * The composed path — the one that turns "campaigns run" into a non-zero
 * `loop.node_verified` — had no test in either arm. Every existing
 * `createOpenCodeLoopExecutor.specialize` test passes `worktree_path: ""`,
 * which structurally bypasses the verification branch entirely, so the branch
 * that produces `verified` provenance had never once executed under CI.
 */
describe("specialize composes verification into provenance", () => {
  let work: string;
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "arbor-verify-e2e-"));
    writeFileSync(join(work, "arbor.jsonc"), JSON.stringify({ agents: {} }), "utf8");
  });
  afterAll(() => { rmSync(work, { recursive: true, force: true }); });

  function executorWith(cmds: readonly string[]): ReturnType<typeof createOpenCodeLoopExecutor> {
    return createOpenCodeLoopExecutor(
      { pushDevtoolsLine: () => {} } as never,
      () => {},
      "c-verify",
      { opencodeBin: FAKE_OPENCODE_BIN, timeoutMs: 20_000, configDir: work, verificationCmds: cmds },
    );
  }

  const action: Action = {
    description: "probe action", estimated_gain: 1, estimated_cost: 1,
    category: "testing", delegate_to: "seed",
  };

  const dispatch = {
    campaign_id: "c-verify", node_id: "n1", action,
    prompt: "do the work", specialist_agent: "seed",
  };

  it("raises provenance to verified when the command actually passes in the worktree", async () => {
    process.env.FAKE_OPENCODE_STDOUT = "work complete";
    const result = await executorWith(["exit 0"]).specialize({ ...dispatch, worktree_path: work });
    expect(result.provenance.tag).toBe("verified");
  });

  it("carries the real exit code rather than a hardcoded 0", async () => {
    process.env.FAKE_OPENCODE_STDOUT = "work complete";
    const result = await executorWith(["exit 0"]).specialize({ ...dispatch, worktree_path: work });
    expect(result.provenance).toMatchObject({ tag: "verified", exit: 0 });
  });

  it("stays claimed — never verified — when the command fails", async () => {
    // The central provenance rule: an LLM answer is never laundered into
    // machine evidence by a check that did not pass.
    process.env.FAKE_OPENCODE_STDOUT = "work complete";
    const result = await executorWith(["exit 1"]).specialize({ ...dispatch, worktree_path: work });
    expect(result.provenance.tag).toBe("claimed");
  });

  it("reports staged breadth when more than one command is configured", async () => {
    // `arbor run` parsed --verification-cmd as last-wins, so this arm was
    // unreachable from the entrypoint the demo reel drives.
    process.env.FAKE_OPENCODE_STDOUT = "work complete";
    const result = await executorWith(["exit 0", "exit 0"]).specialize({ ...dispatch, worktree_path: work });
    expect(result.provenance).toMatchObject({ tag: "verified", check: { breadth: "subset" } });
  });

  it("stays claimed when the worktree is gone rather than reporting a verified check", async () => {
    process.env.FAKE_OPENCODE_STDOUT = "work complete";
    const result = await executorWith(["exit 0"]).specialize({ ...dispatch, worktree_path: join(work, "vanished") });
    expect(result.provenance.tag).toBe("claimed");
  });
});
