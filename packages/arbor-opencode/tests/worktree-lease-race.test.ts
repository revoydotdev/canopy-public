/**
 * worktree-lease-race.test.ts — a genuine two-PROCESS race for the same
 * lease slot.
 *
 * Every other worktree test exercises `acquireLease` from a single process,
 * so it can only prove the code LOOKS exclusive, never that it IS exclusive
 * under real concurrency. `WorktreeManager.acquireLease` used to be a plain
 * check-then-act (`readLease` -> git/dependency work -> `writeFileSync`),
 * whose only incidental exclusivity came from `git worktree add` refusing a
 * second branch/path collision — a window wide enough for two real
 * processes to both pass the read and both eventually write a "winning"
 * lease file. The fix (`claimLeaseSlot`'s `O_CREAT|O_EXCL` claim, taken
 * before any git/filesystem work) is only proven by spawning independent OS
 * processes that race the exact same call, with a start barrier so they
 * genuinely overlap instead of running sequentially by accident of
 * scheduling.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function realRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "arbor-wt-race-"));
  scratch.push(dir);
  spawnSync("git", ["init", "-q", dir], { stdio: "ignore" });
  spawnSync("git", ["-C", dir, "config", "user.email", "t@t"], { stdio: "ignore" });
  spawnSync("git", ["-C", dir, "config", "user.name", "t"], { stdio: "ignore" });
  writeFileSync(join(dir, "x.txt"), "hi\n");
  spawnSync("git", ["-C", dir, "add", "-A"], { stdio: "ignore" });
  spawnSync("git", ["-C", dir, "commit", "-qm", "init"], { stdio: "ignore" });
  return dir;
}

const moduleUrl = pathToFileURL(join(process.cwd(), "packages/arbor-campaign-support/src/worktree.ts")).href;

/**
 * Child process script (run under `bun -e`): waits for `readyFile` to have
 * been observed by the parent (via its own `ready-<n>` marker) and for
 * `goFile` to appear, THEN calls `acquireLease` — so every child's call
 * lands inside the same short overlapping window instead of racing
 * scheduler luck across process spawn latency.
 */
const CHILD_SOURCE = `
  const payload = JSON.parse(process.argv[1]);
  const fs = require("node:fs");
  fs.writeFileSync(payload.readyFile, String(process.pid));
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(payload.goFile)) {
    if (Date.now() > deadline) { fs.writeFileSync(payload.outFile, JSON.stringify({ error: "timed out waiting for go file" })); process.exit(1); }
  }
  import(payload.moduleUrl).then(({ WorktreeManager }) => {
    const manager = new WorktreeManager({ repoRoot: payload.repoRoot });
    const lease = manager.acquireLease({ campaign_id: payload.campaignId, node_id: payload.nodeId, specialist: "racer-" + process.pid });
    fs.writeFileSync(payload.outFile, JSON.stringify({ pid: process.pid, won: lease !== null, lease, failure: manager.lastAcquireFailure }));
  }).catch((error) => {
    fs.writeFileSync(payload.outFile, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  });
`;

function spawnChild(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("bun", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code, stderr }));
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${description}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Race `childCount` real processes for the same node_id's lease. Returns each child's parsed result. */
async function raceForLease(repo: string, campaignId: string, nodeId: string, childCount: number): Promise<Array<{ pid: number; won: boolean; failure: string | null; lease: unknown; error?: string }>> {
  const coordDir = mkdtempSync(join(tmpdir(), "arbor-wt-race-coord-"));
  scratch.push(coordDir);
  const goFile = join(coordDir, "go");
  const readyFiles = Array.from({ length: childCount }, (_, i) => join(coordDir, `ready-${i}`));
  const outFiles = Array.from({ length: childCount }, (_, i) => join(coordDir, `out-${i}.json`));

  const runs = readyFiles.map((readyFile, i) => {
    const payload = { moduleUrl, repoRoot: repo, campaignId, nodeId, readyFile, goFile, outFile: outFiles[i] };
    return spawnChild(["-e", CHILD_SOURCE, JSON.stringify(payload)]);
  });

  // Every child must have announced readiness before the barrier drops, so
  // the acquireLease calls genuinely overlap instead of the first child
  // finishing (and releasing process/scheduler pressure) before the last
  // one even starts.
  await waitFor(() => readyFiles.every((f) => existsSync(f)), 15_000, "all children ready");
  writeFileSync(goFile, "go");

  const results = await Promise.all(runs);
  for (const [i, result] of results.entries()) {
    if (result.code !== 0) throw new Error(`race child ${i} exited ${result.code}: ${result.stderr}`);
  }

  return outFiles.map((f) => JSON.parse(readFileSync(f, "utf-8")));
}

/** Seed the "released/deactivated but still present" lease shape `reconcileLeases` produces. */
function seedInactiveLease(repo: string, campaignId: string, nodeId: string): void {
  const leasesDir = join(repo, ".arbor", "leases");
  mkdirSync(leasesDir, { recursive: true });
  writeFileSync(join(leasesDir, `${nodeId}.json`), JSON.stringify({
    node_id: nodeId, campaign_id: campaignId, branch: `arbor/${campaignId}/${nodeId}`, path: join(repo, ".worktrees", `${campaignId}-${nodeId}`),
    acquired_at: new Date(Date.now() - 60_000).toISOString(), acquired_by: "seed", starting_commit: "HEAD", active: false,
  }), "utf-8");
}

describe("WorktreeManager.acquireLease — real two-process race", () => {
  it("exactly one of several concurrently racing processes wins the same lease, repeated across iterations", async () => {
    const iterations = 4;
    const childCount = 3;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const repo = realRepo();
      const campaignId = `race-${iteration}`;
      const nodeId = "n1";

      const outcomes = await raceForLease(repo, campaignId, nodeId, childCount);
      expect(outcomes).toHaveLength(childCount);
      for (const outcome of outcomes) expect(outcome.error).toBeUndefined();

      const winners = outcomes.filter((o) => o.won);
      const losers = outcomes.filter((o) => !o.won);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(childCount - 1);
      for (const loser of losers) expect(loser.lease).toBeNull();

      // The winner's lease file parses and is active.
      const leaseFile = join(repo, ".arbor", "leases", `${nodeId}.json`);
      expect(existsSync(leaseFile)).toBe(true);
      const persisted = JSON.parse(readFileSync(leaseFile, "utf-8"));
      expect(persisted.active).toBe(true);
      expect(persisted.node_id).toBe(nodeId);

      // No phantom claim files or stray lease-adjacent junk survive a loser:
      // only the one real lease file exists in leasesDir, and it isn't a
      // leftover temp file from the atomic-write machinery.
      const leaseFiles = readdirSync(join(repo, ".arbor", "leases"));
      expect(leaseFiles).toEqual([`${nodeId}.json`]);

      spawnSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" });
    }
  }, 90_000);

  it("after a losing race, a fresh acquire on the SAME node still fails while the winner holds it, and succeeds once released", async () => {
    const repo = realRepo();
    const campaignId = "race-followup";
    const nodeId = "n1";
    const outcomes = await raceForLease(repo, campaignId, nodeId, 2);
    const winner = outcomes.find((o) => o.won);
    expect(winner).toBeDefined();

    // A third, ordinary (non-racing) acquire must still see the lease held.
    const { WorktreeManager } = await import("@arbor/campaign-support");
    const manager = new WorktreeManager({ repoRoot: repo });
    expect(manager.acquireLease({ campaign_id: campaignId, node_id: nodeId, specialist: "follow-up" })).toBeNull();

    expect(manager.releaseLease(nodeId)).toBe(true);
    const reacquired = manager.acquireLease({ campaign_id: campaignId, node_id: nodeId, specialist: "follow-up" });
    expect(reacquired).not.toBeNull();
    manager.releaseLease(nodeId);
  }, 30_000);

  it("exactly one of >=4 processes wins when the slot starts occupied by a pre-existing INACTIVE lease record, repeated across iterations", async () => {
    // The scenario an orchestrator review flagged as the double-win case in
    // the earlier (unlink-then-create) design: two or more racers observe
    // the SAME inactive record simultaneously and all try to replace it.
    // The per-slot mutex (`<node_id>.lock`) now serializes that replacement
    // entirely, but only a real multi-process race proves it holds under
    // genuine OS scheduling, not just under this file's own deterministic,
    // single-process lock tests (worktree-lease-claim.test.ts).
    const iterations = 3;
    const childCount = 4;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const repo = realRepo();
      const campaignId = `race-inactive-${iteration}`;
      const nodeId = "n1";
      seedInactiveLease(repo, campaignId, nodeId);

      const outcomes = await raceForLease(repo, campaignId, nodeId, childCount);
      expect(outcomes).toHaveLength(childCount);
      for (const outcome of outcomes) expect(outcome.error).toBeUndefined();

      const winners = outcomes.filter((o) => o.won);
      const losers = outcomes.filter((o) => !o.won);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(childCount - 1);
      for (const loser of losers) expect(loser.lease).toBeNull();

      // What's actually on disk at the end must agree with exactly one
      // winner: no phantom second active record, no leftover lock file, no
      // orphaned atomic-write temp file.
      const leaseFile = join(repo, ".arbor", "leases", `${nodeId}.json`);
      const persisted = JSON.parse(readFileSync(leaseFile, "utf-8"));
      expect(persisted.active).toBe(true);
      const winner = winners[0]!;
      expect(persisted.acquired_by).toBe(`racer-${winner.pid}`);
      const leaseFiles = readdirSync(join(repo, ".arbor", "leases"));
      expect(leaseFiles).toEqual([`${nodeId}.json`]);

      spawnSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" });
    }
  }, 90_000);
});
