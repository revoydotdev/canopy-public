#!/usr/bin/env bun
/**
 * test-baseline — answer "is this failure mine, or was it already there?"
 *
 * WHY THIS EXISTS. A repository with thousands of tests and a handful of
 * permanently-red ones has no way to tell a new failure from an old one. On
 * 2026-08-27 six agents faced that question in one session and answered it four
 * different ways: import-graph reasoning (wrong twice), restoring originals via
 * `git show`, trusting a list pasted into a brief, and hand-building a frozen
 * worktree. Only the last two are sound, and only one is cheap.
 *
 * WHAT IT DOES. Runs the same test selection twice — once in this working tree,
 * once in a frozen worktree pinned to a baseline revision — and reports only the
 * DIFFERENCE between the two failure sets. A failure present in both is not
 * yours. A failure present only here is.
 *
 * WHY A WORKTREE AND NOT A STASH. `git stash` mutates the tree an agent is
 * working in, and this repository forbids agents every git write for exactly
 * that reason. A separate worktree is read-only with respect to the caller's
 * work, and can be reused across runs.
 *
 * THE BASELINE SET IS CACHED. Re-running the baseline suite on every invocation
 * would double the cost of every test run, which is how a correct tool becomes
 * one nobody uses. The failure set is keyed by {revision, selection} and reused
 * until either changes.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = process.env.REPO_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");

function git(args, { cwd = REPO_ROOT, allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

const COMMON_DIR = (() => {
  const dir = git(["rev-parse", "--git-common-dir"]);
  return dir.startsWith("/") ? dir : join(REPO_ROOT, dir);
})();
const BASELINE_ROOT = join(COMMON_DIR, "arbor", "test-baseline");
const BASELINE_TREE = join(BASELINE_ROOT, "tree");
const CACHE_PATH = join(BASELINE_ROOT, "failures.json");

/** Parse `--flag value` pairs out of argv, leaving the rest as the vitest selection. */
function parseArgs(argv) {
  const selection = [];
  let ref = "HEAD";
  let json = false;
  let refresh = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--ref") { ref = argv[++i] ?? "HEAD"; continue; }
    if (arg === "--json") { json = true; continue; }
    if (arg === "--refresh-baseline") { refresh = true; continue; }
    if (arg === "--help" || arg === "-h") return { help: true, selection, ref, json, refresh };
    selection.push(arg);
  }
  return { help: false, selection, ref, json, refresh };
}

/**
 * Run vitest with the JSON reporter and return the set of test FILES that did
 * not fully pass. File granularity, not test granularity, because that is the
 * unit an agent can act on and the unit vitest reports reliably even when a
 * suite crashes during collection.
 */
function failingFiles(cwd, selection) {
  const bin = join(cwd, "node_modules/.bin/vitest");
  if (!existsSync(bin)) throw new Error(`vitest is not installed in ${cwd} — run \`bun install\` there first`);
  const result = spawnSync(
    process.versions.bun ? "node" : process.execPath,
    [bin, "run", "--reporter=json", ...selection],
    { cwd, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 },
  );
  const start = result.stdout.indexOf("{");
  if (start === -1) {
    throw new Error(`vitest produced no JSON report in ${cwd}. Treating this as unknown rather than as a pass.\n${result.stderr.slice(0, 2000)}`);
  }
  let report;
  try {
    report = JSON.parse(result.stdout.slice(start));
  } catch (error) {
    throw new Error(`vitest's JSON report was unparseable in ${cwd}: ${error instanceof Error ? error.message : String(error)}`);
  }
  // File granularity is the unit an agent acts on, but a file failing in BOTH
  // trees still hides whether a change made it worse. Carry the per-file
  // failing-test COUNT too: a file failing 6 at the baseline and 5 here has
  // been improved, and reporting only "pre-existing" buries both directions.
  const failed = new Map();
  for (const file of report.testResults ?? []) {
    if (file.status === "passed") continue;
    const name = String(file.name).replace(`${cwd}/`, "");
    failed.set(name, (file.assertionResults ?? []).filter((a) => a.status === "failed").length);
  }
  return failed;
}

/** Create or re-point the frozen baseline worktree, preserving its node_modules. */
function ensureBaselineTree(revision) {
  mkdirSync(BASELINE_ROOT, { recursive: true });
  if (!existsSync(join(BASELINE_TREE, ".git"))) {
    // A stale directory with no .git (an interrupted previous run) would make
    // `worktree add` refuse; clear it rather than failing the caller.
    if (existsSync(BASELINE_TREE)) rmSync(BASELINE_TREE, { recursive: true, force: true });
    git(["worktree", "add", "--detach", BASELINE_TREE, revision]);
  } else {
    const at = git(["rev-parse", "HEAD"], { cwd: BASELINE_TREE });
    if (at !== revision) git(["checkout", "--detach", revision], { cwd: BASELINE_TREE });
  }
  // node_modules is gitignored, so it survives a checkout and only needs
  // installing once per baseline tree — this is what keeps repeat runs cheap.
  if (!existsSync(join(BASELINE_TREE, "node_modules/.bin/vitest"))) {
    process.stderr.write("[test-baseline] installing dependencies in the baseline worktree (one time)...\n");
    const install = spawnSync("bun", ["install", "--frozen-lockfile"], { cwd: BASELINE_TREE, encoding: "utf-8" });
    if (install.status !== 0) throw new Error(`bun install failed in the baseline worktree:\n${install.stderr?.slice(0, 2000) ?? ""}`);
  }
  return BASELINE_TREE;
}

function readCache() {
  if (!existsSync(CACHE_PATH)) return {};
  try { return JSON.parse(readFileSync(CACHE_PATH, "utf-8")); } catch { return {}; }
}

function cacheKey(revision, selection) {
  return `${revision}::${selection.length ? selection.join(" ") : "<all>"}`;
}

function main() {
  const { help, selection, ref, json, refresh } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log(`usage: bun run test:baseline [--ref <rev>] [--refresh-baseline] [--json] [<vitest selection>...]

Runs the selection here and at <rev> (default HEAD), then reports only the
difference. Exits non-zero when a failure exists here that does not exist at the
baseline — that failure is yours.

  --ref <rev>            baseline revision (default: HEAD)
  --refresh-baseline     re-measure the baseline instead of using the cache
  --json                 machine-readable output

  bun run test:baseline packages/arbor-core
  bun run test:baseline --ref origin/main`);
    return 0;
  }

  const revision = git(["rev-parse", ref]);
  const key = cacheKey(revision, selection);
  const cache = readCache();

  process.stderr.write(`[test-baseline] measuring the working tree...\n`);
  const here = failingFiles(REPO_ROOT, selection);

  let baseline;
  if (!refresh && cache[key] && typeof cache[key] === "object" && !Array.isArray(cache[key])) {
    baseline = new Map(Object.entries(cache[key]));
    process.stderr.write(`[test-baseline] baseline for ${revision.slice(0, 12)} read from cache (${baseline.size} known failure(s)); --refresh-baseline to re-measure\n`);
  } else {
    const tree = ensureBaselineTree(revision);
    process.stderr.write(`[test-baseline] measuring the baseline at ${revision.slice(0, 12)}...\n`);
    baseline = failingFiles(tree, selection);
    cache[key] = Object.fromEntries([...baseline.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
    mkdirSync(BASELINE_ROOT, { recursive: true });
    writeFileSync(CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, "utf-8");
  }

  const introduced = [...here.keys()].filter((f) => !baseline.has(f)).sort();
  const repaired = [...baseline.keys()].filter((f) => !here.has(f)).sort();
  // A file failing in both trees splits by whether its failing-test count
  // moved. "worsened" is a regression hiding inside an already-red file --
  // exactly what file-level reporting alone misses.
  const shared = [...here.keys()].filter((f) => baseline.has(f)).sort();
  const worsened = shared.filter((f) => here.get(f) > baseline.get(f));
  const improved = shared.filter((f) => here.get(f) < baseline.get(f));
  const preExisting = shared.filter((f) => here.get(f) === baseline.get(f));

  if (json) {
    console.log(JSON.stringify({
      ok: introduced.length === 0 && worsened.length === 0,
      baseline_revision: revision,
      selection,
      introduced,
      worsened: worsened.map((f) => ({ file: f, baseline: baseline.get(f), here: here.get(f) })),
      improved: improved.map((f) => ({ file: f, baseline: baseline.get(f), here: here.get(f) })),
      pre_existing: preExisting, repaired,
    }, null, 2));
    return introduced.length === 0 && worsened.length === 0 ? 0 : 1;
  }

  console.log(`test-baseline — working tree vs ${revision.slice(0, 12)}`);
  console.log(`  selection: ${selection.length ? selection.join(" ") : "<entire suite>"}`);
  console.log("");
  if (preExisting.length) {
    console.log(`  ${preExisting.length} pre-existing failure(s) — NOT yours, present at the baseline too:`);
    for (const f of preExisting) console.log(`    · ${f}`);
    console.log("");
  }
  if (repaired.length) {
    console.log(`  ${repaired.length} failure(s) the working tree REPAIRS:`);
    for (const f of repaired) console.log(`    ✓ ${f}`);
    console.log("");
  }
  if (improved.length) {
    console.log(`  ${improved.length} already-failing file(s) the working tree IMPROVES:`);
    for (const f of improved) console.log(`    \u2713 ${f}  (${baseline.get(f)} failing at baseline, ${here.get(f)} here)`);
    console.log("");
  }
  if (worsened.length) {
    console.log(`  ${worsened.length} already-failing file(s) that got WORSE -- a regression hiding inside a red file:`);
    for (const f of worsened) console.log(`    \u2717 ${f}  (${baseline.get(f)} failing at baseline, ${here.get(f)} here)`);
    console.log("");
  }
  if (introduced.length === 0 && worsened.length === 0) {
    console.log("  0 introduced failure(s). Nothing here fails that did not already fail at the baseline.");
    console.log("");
    console.log("PASS");
    return 0;
  }
  console.log(`  ${introduced.length} INTRODUCED failure(s) — these are yours:`);
  for (const f of introduced) console.log(`    ✗ ${f}`);
  console.log("");
  console.log("FAIL");
  return 1;
}

try {
  process.exit(main());
} catch (error) {
  console.error(`test-baseline — ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
