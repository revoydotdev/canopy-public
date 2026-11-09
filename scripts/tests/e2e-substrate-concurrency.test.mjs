/**
 * e2e-substrate-concurrency (Y-2, BLINDSPOT-MANIFEST class 6 — cross-process
 * shared state). Two class-6 defects were already proven live in this
 * session's own history: per-worktree `registry.json` copies defeating the
 * shared lock, and `install-git-hooks` writing into the shared `.git/hooks`.
 * This suite drives the REAL substrate — real `git worktree add`, real
 * concurrent Node processes racing a shared clone, real filesystem appends —
 * and asserts invariants that must hold under ANY interleaving, never a
 * specific ordering (per the manifest's anti-flake rule):
 *
 *   (a) two worktrees acquiring node leases never both hold the same lease
 *       key -- including the `--race-fork` synthetic key `race.ts` mints.
 *   (b) concurrent appends to `.hook-liveness/invocations.jsonl` never
 *       produce an interleaved/corrupt line -- every line must parse as JSON.
 *   (c) two campaigns writing evidence stores concurrently never corrupt a
 *       store's manifest -- the shared `audit-tips/manifest.json` stays
 *       valid JSON at every observation AND does not silently lose either
 *       campaign's registration.
 *
 * No sleeps, no wall-clock racing: each scenario spawns genuinely concurrent
 * OS processes (`spawn`, never `spawnSync`) against one shared clone and
 * waits on real process exit, so the interleaving is whatever the real
 * substrate actually produces -- exactly what "real substrate" concurrency
 * testing means per the manifest.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

let scratch;
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), "arbor-substrate-concurrency-")); });
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  for (const path of runnerPaths.splice(0)) rmSync(path, { force: true });
});

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function seedRepo() {
  const repo = mkdtempSync(join(tmpdir(), "arbor-substrate-repo-"));
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: repo });
  git(repo, "config", "user.email", "e2e@test.invalid");
  git(repo, "config", "user.name", "E2E");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  return repo;
}

/**
 * Writes a small runner script under `scratch` and executes it via `bun`
 * from `REPO_ROOT` (so `@arbor/opencode`/`@arbor/audit` workspace imports
 * resolve exactly as they do for the real harness) as a genuinely
 * concurrent child process. Returns the still-running child; callers
 * `await exit(child)`.
 */
const RUNNERS_DIR = join(REPO_ROOT, "scripts", "tests", ".e2e-substrate-runners");
const runnerPaths = [];

/**
 * `bun`'s module resolution walks up from the SCRIPT'S OWN path looking for
 * `node_modules`, not from `cwd` -- a runner written under `/tmp` never
 * resolves `@arbor/opencode`/`@arbor/audit` no matter what `cwd` is passed.
 * Runner scripts are therefore written under the repo tree itself (cleaned
 * up in `afterEach` below), exactly where the real harness's own code lives.
 */
function spawnRunner(name, source) {
  mkdirSync(RUNNERS_DIR, { recursive: true });
  const scriptPath = join(RUNNERS_DIR, `${name}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(scriptPath, source, "utf-8");
  runnerPaths.push(scriptPath);
  // `bun`, not `node`: `@arbor/opencode`/`@arbor/audit` are TS-source
  // workspace packages with no build step (see each package.json's `exports`
  // pointing straight at `src/index.ts`) -- exactly how the real harness
  // resolves them, and `bun` is this repo's runtime throughout (bunx tsc,
  // bunx vitest).
  return spawn("bun", [scriptPath], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
}

function exit(child) {
  return new Promise((resolveExit) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolveExit({ code, stdout, stderr }));
  });
}

/**
 * Barrier prelude injected into a runner's source: the child busy-spins
 * (synchronously -- no `setTimeout`/sleep, which would hand control back to
 * the event loop and defeat the point) on a `readyFile`/`goFile` pair so its
 * critical section starts as close to the OTHER process's as this substrate
 * allows, rather than depending on OS scheduling of two independently-timed
 * process starts (which mostly serializes them well apart, see the
 * measurement in this suite's own commit history). The PARENT waits for
 * every child's ready-file to exist, then drops the go-file once -- so all
 * children release together.
 */
function barrierPrelude(readyFile, goFile) {
  return `
import { writeFileSync, existsSync } from "node:fs";
writeFileSync(${JSON.stringify(readyFile)}, "ready");
const barrierDeadline = Date.now() + 20_000;
// A 1ms Atomics.wait between polls (synchronous, no event-loop yield) keeps
// the wait tight enough for a real cross-process race while not pinning a
// CPU core doing back-to-back stat() syscalls -- a truly tight spin was
// measured to starve the PARENT process's own barrier-release polling on a
// loaded machine, timing the whole test out before either child ever saw
// the go-file.
const barrierPad = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(${JSON.stringify(goFile)})) {
  if (Date.now() > barrierDeadline) throw new Error("barrier timed out waiting for go-file");
  Atomics.wait(barrierPad, 0, 0, 1);
}
`;
}

async function releaseBarrier(readyFiles, goFile) {
  const deadline = Date.now() + 20_000;
  while (!readyFiles.every((f) => existsSync(f))) {
    if (Date.now() > deadline) throw new Error("timed out waiting for all runners to reach the barrier");
    // A tight `setImmediate` re-poll here pegs this PARENT process's own CPU
    // core running "as fast as possible" -- measured to starve the CHILD
    // `bun` processes of scheduling entirely on a loaded machine (this repo
    // runs a heavy always-on stack per its own operating notes), so the
    // children's ready-files never appeared and this function timed out
    // every time. A 5ms real poll interval costs nothing here (the barrier
    // only needs millisecond-scale precision, not microsecond) and lets the
    // OS scheduler actually give the children CPU time.
    await new Promise((r) => setTimeout(r, 5));
  }
  writeFileSync(goFile, "go");
}

/**
 * Races two real, barrier-synchronized `bun` processes calling
 * `WorktreeManager.acquireLease` for the SAME `node_id` against the SAME
 * repo, `trials` times over (fresh `node_id` per trial so a genuine
 * acquisition never blocks the next trial). Returns every trial's pair of
 * results.
 */
async function raceLeaseAcquisitions(repo, nodeIdPrefix, trials) {
  const outcomes = [];
  for (let trial = 0; trial < trials; trial++) {
    const nodeId = `${nodeIdPrefix}-${trial}`;
    const resultA = join(scratch, `result-a-${trial}.json`);
    const resultB = join(scratch, `result-b-${trial}.json`);
    const readyA = join(scratch, `ready-a-${trial}`);
    const readyB = join(scratch, `ready-b-${trial}`);
    const goFile = join(scratch, `go-${trial}`);
    const runner = (resultFile, readyFile) => `${barrierPrelude(readyFile, goFile)}
import { WorktreeManager } from "@arbor/opencode";
const wm = new WorktreeManager({ repoRoot: ${JSON.stringify(repo)} });
let lease = null;
let error = null;
try {
  lease = wm.acquireLease({ campaign_id: "camp1", node_id: ${JSON.stringify(nodeId)}, specialist: "seed" });
} catch (e) {
  error = e instanceof Error ? e.message : String(e);
}
writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ acquired: lease !== null, path: lease?.path ?? null, error }));
`;
    const childA = spawnRunner(`lease-a-${trial}`, runner(resultA, readyA));
    const childB = spawnRunner(`lease-b-${trial}`, runner(resultB, readyB));
    await releaseBarrier([readyA, readyB], goFile);
    const [a, b] = await Promise.all([exit(childA), exit(childB)]);
    const resA = JSON.parse(readFileSync(resultA, "utf-8"));
    const resB = JSON.parse(readFileSync(resultB, "utf-8"));
    outcomes.push({ trial, nodeId, a: { code: a.code, stderr: a.stderr, ...resA }, b: { code: b.code, stderr: b.stderr, ...resB } });
  }
  return outcomes;
}

describe("e2e: (a) two concurrent lease acquisitions never both hold the same key", () => {
  it("real git worktrees, real barrier-synchronized concurrent processes, same node_id -- at most one succeeds, across repeated trials", async () => {
    const repo = seedRepo();
    try {
      const outcomes = await raceLeaseAcquisitions(repo, "concurrency-n1", 5);
      const violations = outcomes.filter((o) => o.a.acquired === true && o.b.acquired === true);
      // The invariant Y-2(a) exists to prove: never two holders of the same
      // lease key, even when two real OS processes race `acquireLease` for
      // it against the same shared clone, barrier-synchronized to close the
      // window as tightly as the real substrate allows, repeated across
      // several trials to raise confidence the invariant genuinely holds
      // rather than the race simply never firing once.
      expect(violations).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 120_000);

  it("the same invariant holds for the `--race-fork` synthetic lease key race.ts mints", async () => {
    const repo = seedRepo();
    try {
      const outcomes = await raceLeaseAcquisitions(repo, "concurrency-n2--race-fork", 5);
      const violations = outcomes.filter((o) => o.a.acquired === true && o.b.acquired === true);
      expect(violations).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("e2e: (b) concurrent appends to .hook-liveness/invocations.jsonl never interleave a corrupt line", () => {
  it("many real concurrent processes appending single-line JSON records -- every line in the final file parses", async () => {
    const logDir = join(scratch, ".hook-liveness");
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, "invocations.jsonl");

    const PROCESSES = 8;
    const LINES_PER_PROCESS = 25;
    const runner = (label) => `
import { appendFileSync } from "node:fs";
for (let i = 0; i < ${LINES_PER_PROCESS}; i++) {
  const record = { hook_id: "e2e-probe", verdict_hash: "h" + i, label: ${JSON.stringify(label)}, seq: i, padding: "x".repeat(200) };
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(record) + "\\n");
}
`;
    const children = Array.from({ length: PROCESSES }, (_, i) => spawnRunner(`liveness-${i}`, runner(`p${i}`)));
    const results = await Promise.all(children.map(exit));
    for (const result of results) expect(result.code).toBe(0);

    const lines = readFileSync(logPath, "utf-8").split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(PROCESSES * LINES_PER_PROCESS);
    const parseFailures = [];
    for (const line of lines) {
      try { JSON.parse(line); } catch (error) { parseFailures.push({ line, error: String(error) }); }
    }
    // The invariant Y-2(b) exists to prove: `appendFileSync`'s single-call,
    // O_APPEND write discipline (see decisions-precommit-gate.mjs) is
    // sufficient for this file's actual write pattern (one syscall per
    // record, each well under a page) -- no interleaved/corrupt line ever
    // lands even under real concurrent process contention.
    expect(parseFailures).toEqual([]);
  }, 30_000);
});

/**
 * Runs `TRIALS` barrier-synchronized pairs of concurrent `writeTipSentinel`
 * calls for two brand-new campaign ids each, against one shared `storeDir`.
 * A background watcher samples `audit-tips/manifest.json` throughout every
 * trial so a transient half-written/corrupt observation would be caught
 * even if the FINAL state happened to look fine.
 */
async function raceEvidenceStoreWrites(storeDir, trials) {
  const manifestPath = join(storeDir, "audit-tips", "manifest.json");
  let watching = true;
  const observedCorruption = [];
  const watcher = (async () => {
    while (watching) {
      if (existsSync(manifestPath)) {
        try { JSON.parse(readFileSync(manifestPath, "utf-8")); } catch (error) {
          observedCorruption.push(String(error));
        }
      }
      await new Promise((r) => setImmediate(r));
    }
  })();

  const expectedCampaigns = [];
  for (let trial = 0; trial < trials; trial++) {
    const campaignA = `campaign-alpha-${trial}`;
    const campaignB = `campaign-beta-${trial}`;
    expectedCampaigns.push(campaignA, campaignB);
    const readyA = join(scratch, `ready-evidence-a-${trial}`);
    const readyB = join(scratch, `ready-evidence-b-${trial}`);
    const goFile = join(scratch, `go-evidence-${trial}`);
    const runner = (campaignId, readyFile) => `${barrierPrelude(readyFile, goFile)}
import { writeTipSentinel } from "@arbor/audit";
writeTipSentinel(${JSON.stringify(storeDir)}, ${JSON.stringify(campaignId)}, 1, "sha256:" + ${JSON.stringify(campaignId)});
`;
    const childA = spawnRunner(`evidence-a-${trial}`, runner(campaignA, readyA));
    const childB = spawnRunner(`evidence-b-${trial}`, runner(campaignB, readyB));
    await releaseBarrier([readyA, readyB], goFile);
    const [a, b] = await Promise.all([exit(childA), exit(childB)]);
    if (a.code !== 0 || b.code !== 0) throw new Error(`trial ${trial} runner failed: a=${JSON.stringify(a)} b=${JSON.stringify(b)}`);
  }

  watching = false;
  await watcher;
  return { manifestPath, observedCorruption, expectedCampaigns };
}

describe("e2e: (c) two campaigns writing evidence stores concurrently must not corrupt the shared manifest", () => {
  it("audit-tips/manifest.json bytes stay valid JSON at every observation, across repeated barrier-synchronized trials", async () => {
    const storeDir = join(scratch, "store");
    mkdirSync(storeDir, { recursive: true });
    const { observedCorruption, manifestPath, expectedCampaigns } = await raceEvidenceStoreWrites(storeDir, 5);

    // `atomicOverwriteFile`'s temp+rename discipline (packages/arbor-audit/
    // src/atomic-write.ts) makes this hold: no reader, including this
    // suite's own background watcher, ever observes a partially-written or
    // malformed manifest, even under real concurrent process contention.
    expect(observedCorruption).toEqual([]);

    // Each campaign's own per-campaign sentinel is written correctly
    // regardless of the manifest race documented below -- this isolates
    // that any loss (see the next `it`) is in the SHARED manifest only.
    for (const campaignId of expectedCampaigns) {
      const sentinel = JSON.parse(readFileSync(join(storeDir, "audit-tips", `${campaignId}.json`), "utf-8"));
      expect(sentinel.campaign_id).toBe(campaignId);
    }
    expect(existsSync(manifestPath)).toBe(true);
  }, 120_000);

  // FIXED AT INTEGRATION (was a real, reproducible lost update).
  //
  // `registerInManifest` (packages/arbor-audit/src/tip-sentinel.ts) did a
  // classic unlocked read-modify-write of the SHARED `audit-tips/
  // manifest.json`: read the current `campaigns` Set, add the caller's own id,
  // `atomicOverwriteFile` the whole set back. `atomicOverwriteFile` makes each
  // individual write atomic and corruption-free (see the passing `it` above),
  // but did nothing about two concurrent callers computing their new set from
  // the SAME stale read -- whichever overwrite landed last silently dropped
  // every OTHER campaign that registered in between, and a dropped entry
  // silently DEREGISTERS a campaign, which is precisely the bypass the
  // manifest exists to prevent (see `readManifest`'s note on attack 19).
  //
  // This is BLINDSPOT-MANIFEST class 6's shape ("per-worktree registry.json
  // copies defeating the shared lock"), here in `arbor-audit` rather than
  // `arbor-opencode`'s lease store -- which Y-2(a) proves does NOT have the
  // problem, because `acquireLease`'s git-level worktree/branch creation is
  // the real mutual-exclusion gate there, not the lease-file write.
  //
  // The fix is the lock-free option of the two Y proposed: each attempt
  // re-reads, re-adds, rewrites, then VERIFIES its own entry survived, so a
  // racer that clobbered it is observed on the next read and both entries
  // converge. Deliberately not a lockfile: this runs on every seal, and a lock
  // outliving a crashed writer would wedge sealing for the whole store.
  it("never silently drops a campaign's registration from the shared manifest under a real concurrent race", async () => {
    const storeDir = join(scratch, "store-lost-update");
    mkdirSync(storeDir, { recursive: true });
    const { manifestPath, expectedCampaigns } = await raceEvidenceStoreWrites(storeDir, 5);
    const finalManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(new Set(finalManifest.campaigns)).toEqual(new Set(expectedCampaigns));
  }, 120_000);
});
