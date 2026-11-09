/**
 * worktree-git-timeout.test.ts — a git invocation must not be able to hang the
 * whole harness.
 *
 * WHY THIS EXISTS. A one-hour publication capture recorded a single
 * `loop.specialist_dispatched` and then produced no further ledger event at
 * all. Nothing timed out, nothing failed, nothing halted. Every async budget
 * in the dispatch path was audited and found correct: `runOpenCode`'s
 * SIGKILL timer was verified to fire against a deliberately sleeping fake
 * binary, the diff/changes capture is bounded, and verification carries its
 * own independent budget.
 *
 * The reason none of them fired is that `WorktreeManager`'s `git()` / `gitAt()`
 * helpers called `spawnSync` with no `timeout`, and `acquireLease` runs
 * synchronously before a node's dispatch is logged. `spawnSync` blocks the
 * single JS thread outright — so a git process that never returns freezes the
 * event loop, and every correctly-implemented `setTimeout` kill-timer in the
 * process is simply never given the chance to run. An unbounded synchronous
 * subprocess is the one construct in this path capable of producing total
 * silence with no timeout ever firing.
 *
 * `dependency-provisioning.ts`, in the same package, already passed
 * `timeout: timeoutMs` to its own `spawnSync`. This is that same discipline
 * applied to the git helpers.
 *
 * The plausible trigger for the real incident was git lock contention: the
 * repository's HEAD was being committed and amended by an operator while a
 * campaign held it, which is exactly the condition under which `git worktree
 * add` or the object-database detach can block on another process's lock.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { WorktreeManager } from "@arbor/campaign-support";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A real git repository with one commit — the shape acquireLease expects. */
function realRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "arbor-wt-timeout-"));
  scratch.push(dir);
  const git = (...args: string[]): void => {
    const result = spawnSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf-8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  };
  git("init", "--quiet");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  git("commit", "--allow-empty", "--quiet", "-m", "root");
  return dir;
}

describe("git invocations are bounded", () => {
  it("fails the lease acquisition instead of blocking forever when git exceeds its budget", () => {
    // 1ms is below any real git invocation, so this exercises the timeout path
    // deterministically without needing to wedge a real git process.
    const repo = realRepo();
    const wt = new WorktreeManager({ repoRoot: repo, gitTimeoutMs: 1 });
    const lease = wt.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" });
    expect(lease).toBeNull();
  });

  it("reports the timeout as the reason rather than an unknown git error", () => {
    // The whole point of the incident was that nothing said what happened.
    // A budget that expires silently would repeat it.
    const repo = realRepo();
    const wt = new WorktreeManager({ repoRoot: repo, gitTimeoutMs: 1 });
    wt.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" });
    expect(wt.lastAcquireFailure).toMatch(/timed out|timeout/i);
  });

  it("still acquires normally under a realistic budget", () => {
    // The bound must not break the working path: a real git call is orders of
    // magnitude faster than this.
    const repo = realRepo();
    const wt = new WorktreeManager({ repoRoot: repo, gitTimeoutMs: 120_000 });
    const lease = wt.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" });
    expect(lease).not.toBeNull();
    expect(wt.isHeld("n1")).toBe(true);
    wt.releaseLease("n1");
  });

  it("applies a bounded default when no budget is configured", () => {
    // Every existing caller constructs WorktreeManager without this option,
    // so the default is what actually protects production.
    const repo = realRepo();
    const wt = new WorktreeManager({ repoRoot: repo });
    const lease = wt.acquireLease({ campaign_id: "c1", node_id: "n1", specialist: "seed" });
    expect(lease).not.toBeNull();
    wt.releaseLease("n1");
  });
});
