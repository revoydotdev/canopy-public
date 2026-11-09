#!/usr/bin/env node
/**
 * scripts/guard-canaries.mjs — canary runner: proves each gate is ABLE TO FAIL.
 *
 * WHY THIS EXISTS. An audit of this repository's own gates (proposal
 * `docs/proposals/arboretum-coordination-plane.md` §7.1, finding R2) found that
 * nothing anywhere executed a gate body and asked whether it can fail.
 * Sixty-one gates run on every commit and every turn, and at least one of them
 * returns success unconditionally: `scripts/adr-status-audit.mjs` ends in
 * `process.exit(0)` on all three of its paths, including its own failure path.
 * That gate has never been red, so nothing in the repository knows its body
 * cannot fail. "Green" from such a gate is not evidence of anything, and no
 * amount of reading the source substitutes for having run it.
 *
 * WHAT A CANARY IS. A fixture directory under `scripts/canaries/<gate>/<name>/`
 * that is a minimal repository root, plus a declared expected failure reason in
 * `scripts/execution-profile.json`. The runner materializes the fixture into a
 * scratch directory and runs the gate against it. A gate that PASSES its own
 * canary is the defect: the canary is an input the gate was built to reject, so
 * a pass means the gate's body never inspected that input.
 *
 * FOUR CLASSIFICATIONS, NOT THREE, AND THAT IS DELIBERATE. The census has to
 * distinguish a gate that passed its canary (the false green this milestone
 * exists to find) from a canary that failed for a reason nobody declared —
 * usually a broken fixture, but also a gate whose failure mode moved.
 * Collapsing the second into either neighbour destroys the only signal that the
 * canary itself is wrong, so it is reported as `misfired` and is never counted
 * as `proven`.
 *
 * EVERY GATE IS LISTED. A gate with no declared canary is `unmigrated` and is
 * printed by name. Silently skipping it would reproduce the exact false green
 * this script was written to remove — a skipped gate is indistinguishable from
 * a passing one in any summary that shows only the interesting rows.
 *
 * WHY THE FIXTURE IS COPIED TO A SCRATCH DIRECTORY. Several gates write into
 * their input tree. Running them against the fixture in place would let a
 * canary dirty the repository it measures, and the second run of the same
 * canary would then measure the first run's damage.
 *
 * EVERY CANARY IS SPAWNED AS `bun run <gate>`, AND THAT IS NOT A CONVENTION.
 * A canary is evidence about the gate the control plane spawns, so the runner
 * fixes the spawn path itself. A profile entry cannot override it, and an entry
 * that tries is refused outright rather than honoured — see `runCanary`. The
 * only caller that spawns something else is `--self-test`, through a runner
 * parameter no profile can set, because a negative control has to be a gate that
 * cannot fail and no such package.json script exists.
 *
 * `gate:adr-status` is expected to report `unproven` on its own canary. That is
 * not a bug in this script; it is R2-01 being detected. The runner exits
 * non-zero while any gate is unproven, which is the intended behaviour until the
 * gate's body is fixed.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { loadExecutionProfile, parseGateObservedCount, runDeadlineProcess } from "./enforcement-control-plane.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, "..");
const CANARY_ROOT = join(__dirname, "canaries");
const PROFILE_PATH = join(__dirname, "execution-profile.json");

// The observation convention is the control plane's, imported rather than
// re-declared: a canary census and an enforcement run that each carried their own
// copy of "what counts as observed" would be free to disagree about the one fact
// this milestone is about.

/**
 * WHY THE AMBIENT GIT-SCOPE ENVIRONMENT IS STRIPPED, TWICE.
 *
 * This repository has a REPRODUCED incident, written up in
 * `scripts/tests/setup-sanitize-git-env.mjs`: an ambient `GIT_DIR` /
 * `GIT_WORK_TREE` / `GIT_COMMON_DIR` in a process's inherited environment makes
 * a fixture's `git init <tmpdir>` silently reuse the poisoned GIT_DIR instead of
 * creating a repository at the path the fixture named — and a later commit then
 * lands a real, tree-replacing commit on whatever branch that GIT_DIR's HEAD
 * points at. Two commits landed on the author's own checked-out branch that way.
 *
 * This runner is that incident's exact shape, twice over, which is why the strip
 * is here and not merely inherited by luck:
 *
 *   1. `initGitRepo` shells raw `git -C <scratch> init` with no explicit env.
 *      An ambient GIT_DIR would make the canary's own `git init` write into the
 *      REAL repository — the canary would be measuring the live repo it is
 *      supposed to be isolated from, and committing to it.
 *   2. `runDeadlineProcess` hands the gate `process.env` verbatim unless the
 *      canary declares an overlay, so every gate that itself shells git — and
 *      that is most of them — inherits the same poison.
 *
 * So the runner strips the six git-scope variables from the BASE environment
 * for both paths, and only then applies a canary's declared `env` overlay on top.
 *
 * DECISION, DELIBERATE: a declared `env` MAY still set `GIT_DIR` /
 * `GIT_WORK_TREE` — two real canaries do (`gate:claim-ledger-precommit` and
 * `gate:decisions-precommit` point git at a hand-built object store inside their
 * own fixture, which is the only way those two gates can be driven at all). The
 * strip is therefore applied to the INHERITED environment, never to the declared
 * one. Rejecting the key in the validator was the alternative and was rejected:
 * it forbids the two legitimate uses, and it is strictly weaker anyway, because
 * it only makes an inherited `GIT_DIR` a profile error rather than an impossible
 * event. What matters is that a `GIT_DIR` reaching a canary is now always one
 * somebody wrote down in a reviewed profile line, never one a neighbouring
 * process in a busy box happened to export.
 *
 * This is the third declaration of this list in the repository; the first two are
 * `scripts/docs-truth.mjs` (GIT_SCOPE_ENV_VARS) and
 * `scripts/tests/setup-sanitize-git-env.mjs`. It is not re-exported from
 * `docs-truth.mjs` because importing that module RUNS the gate, and deduplicating
 * all three is a change to files this fix does not own.
 */
const GIT_SCOPE_ENV_VARS = new Set([
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR",
  "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
]);

/** The ambient environment with the git-scope variables removed. Called per use, never snapshotted at import. */
function sanitizedEnv() {
  const env = { ...process.env };
  for (const key of GIT_SCOPE_ENV_VARS) delete env[key];
  return env;
}

/**
 * Classification is pure so a test can drive every branch without spawning a
 * gate. `expected_reason_matched` is reported alongside `classification` rather
 * than folded into it, because "failed for the declared reason" and "failed for
 * some other reason" are different facts about two different artifacts — the
 * gate, and the canary.
 */
export function classifyCanaryResult({ declared, exit_code, output, expected_failure_reason }) {
  if (!declared) {
    return Object.freeze({ classification: "unmigrated", reason: null, expected_reason_matched: null });
  }
  const expected_reason_matched = typeof expected_failure_reason === "string"
    && expected_failure_reason.length > 0
    && String(output ?? "").includes(expected_failure_reason);
  if (exit_code === 0) {
    return Object.freeze({
      classification: "unproven",
      reason: "gate passed a fixture it must reject; its body did not fail on the input it declares it checks",
      expected_reason_matched: false,
    });
  }
  if (expected_reason_matched) {
    return Object.freeze({ classification: "proven", reason: expected_failure_reason, expected_reason_matched: true });
  }
  return Object.freeze({
    classification: "misfired",
    reason: "gate failed, but not for the declared expected reason; the canary or the gate's failure mode has moved",
    expected_reason_matched: false,
  });
}

/** Parse a gate's self-reported observation count, or null when it reported none. */
export const parseObservedCount = parseGateObservedCount;

/**
 * The canary's own tri-state. A gate that declares `observes: { min: N }` is
 * saying this input is expected to be non-empty; observing fewer (or reporting
 * nothing) is `unresolved`, never `passed`. The control plane applies the same
 * rule to a real enforcement run; this is the same predicate for the canary
 * census, so the two cannot disagree about what `unresolved` means.
 */
export function canaryObservationStatus(entry, output) {
  const minimum = entry?.observes?.min;
  if (!Number.isSafeInteger(minimum) || minimum < 1) return null;
  const observed = parseObservedCount(output);
  if (observed === null) return "unresolved";
  return observed >= minimum ? null : "unresolved";
}

/**
 * A fixture is a synthetic corpus, but a gate's obligations resolve against real
 * source. A canary whose ADR declares a proof therefore needs the repository's
 * own `scripts/` and its vitest include patterns visible inside the scratch root,
 * or the roundtrip leg cannot resolve, the proof is not "fully resolved", and
 * the fixture would be asserting something the gate never actually checked.
 * Symlinked, not copied: these are read-only inputs to a read-only check, and a
 * copy per canary would buy nothing but staleness.
 */
function linkRepoPaths(root, paths) {
  for (const relative of paths) {
    const source = join(REPO_ROOT, relative);
    if (!existsSync(source)) continue;
    symlinkSync(source, join(root, relative), existsSync(source) && statSync(source).isDirectory() ? "dir" : "file");
  }
}

/**
 * Make a scratch root look enough like the repository for the gates that shell
 * out to git. Only fixtures declaring `git_repo: true` get one; the ADR corpus
 * gates read plain directories and must not be handed a git history their
 * canary never asked for.
 *
 * A `branch/` subdirectory of the fixture is held back from the base commit and
 * its CONTENTS are committed at the fixture root on a `canary` branch instead.
 * `adr-trace` measures commits since merge-base(HEAD, master), so a fixture that
 * only ever has `master` has no branch boundary to measure and passes
 * vacuously — a green that measured nothing. The contents must land at the
 * repository root, not under a `branch/` prefix: governed paths are matched by
 * root-relative prefix, so a file at `branch/packages/x.ts` is not a governed
 * path and the gate would correctly ignore it, making the canary pass for the
 * wrong reason. The branch commit must also change a real file — an empty commit
 * touches no governed path either.
 *
 * Everything here operates on the SCRATCH root. The fixture source is
 * read-only input: an earlier version of this function removed the held-back
 * payload from the fixture directory, which silently deleted its own fixture on
 * the first run and made the canary pass for a reason that had nothing to do
 * with the gate.
 */
function initGitRepo(root) {
  // Explicit sanitized env, not an inherited one: a raw `git -C <scratch> init`
  // is precisely the call shape that the ambient-GIT_DIR incident redirects onto
  // the real repository. See the GIT_SCOPE_ENV_VARS block above.
  const git = (...args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf-8", env: sanitizedEnv() });
  // Renamed aside rather than deleted: this is the SCRATCH copy, so the fixture
  // source is never touched, and the payload is still there to move back after
  // the base commit.
  const held = join(root, "branch");
  const parked = `${held}-parked`;
  const hasBranch = existsSync(held);
  if (hasBranch) renameSync(held, parked);
  git("init", "-q", "-b", "master", ".");
  git("config", "user.email", "canary@revoy2.invalid");
  git("config", "user.name", "guard-canaries");
  git("add", "-A");
  git("commit", "-qm", "canary fixture");
  if (hasBranch) {
    git("checkout", "-q", "-b", "canary");
    renameSync(parked, held);
    cpSync(held, root, { recursive: true });
    rmSync(held, { recursive: true, force: true });
    git("add", "-A");
    git("commit", "-qm", "feat: unclaimed governed change");
  }
}

/** Replaces `{repo}` in the declared args with the scratch root. Defaults to `--repo {repo}`. */
function canaryArgs(declared, scratch) {
  return (declared.args ?? ["--repo", "{repo}"]).map((value) => value.replaceAll("{repo}", scratch));
}

/** Same substitution for a declared env overlay. */
function substitutedEnv(declared, scratch) {
  return Object.fromEntries(
    Object.entries(declared).map(([key, value]) => [key, String(value).replaceAll("{repo}", scratch)]),
  );
}

export async function runCanary({ gate, entry, repo = REPO_ROOT, keepScratch = false, internalCommand = null }) {
  const declared = entry.canary ?? null;
  if (!declared) {
    return Object.freeze({
      gate, classification: "unmigrated", reason: null, expected_reason_matched: null,
      exit_code: null, duration_ms: 0, observed_count: null, observed_status: null, spawn_error: null,
    });
  }
  // WHY A PROFILE-DECLARED `command` IS REFUSED RATHER THAN IGNORED.
  //
  // The runner is the only component that knows the truth: a canary is evidence
  // about the gate `bun run <gate>`, spawned exactly the way the control plane
  // spawns it. A `command` key in a profile entry is a raw argv override, and
  // honouring it is a false-green generator — an audit demonstrated that
  // `["sh","-c","echo '<expected reason>'; exit 1"]` on `gate:adr-sections`
  // produced `proven` with `scripts/adr-sections.mjs` never executed. A comment
  // saying the key is "reserved for the negative control" is a CONVENTION, and a
  // convention is the only thing that was holding it: two hand-written blocks
  // were rejected for using `sh -c` to smuggle env vars, and that was the
  // reviewer catching them by eye. Nothing stopped the next edit.
  //
  // Ignoring the key instead of refusing it would be worse than either. Silently
  // running `bun run <gate>` when the profile asked for something else reports a
  // result for a canary nobody declared, and silently running the declared
  // command is the false green itself. So the canary is refused: nothing is
  // spawned, and the row is `misfired` — not `unproven`, because the gate never
  // ran and so cannot have passed its canary, and not `unmigrated`, because a
  // block WAS declared and it is wrong, which is a countable fact about the
  // profile rather than an absence. `misfired` also keeps `census.ok` false, so
  // the census stays red.
  //
  // The negative control's real answer is `internalCommand` below: a function
  // parameter, which a profile file structurally cannot set.
  if (declared.command !== undefined) {
    return Object.freeze({
      gate,
      classification: "misfired",
      reason: "canary declares a `command` spawn override; the runner spawns `bun run <gate>` for every canary and refuses to prove one that reaches its gate another way (nothing was run)",
      expected_reason_matched: false,
      exit_code: null, duration_ms: 0, observed_count: null, observed_status: null, spawn_error: null,
    });
  }
  const scratch = mkdtempSync(join(tmpdir(), `revoy2-canary-${gate.replace(/[^a-z0-9]+/gi, "-")}-`));
  try {
    cpSync(join(CANARY_ROOT, declared.fixture), scratch, { recursive: true });
    // `.arbor/` is gitignored, so a fixture whose gate reads `<root>/.arbor/**`
    // cannot commit that directory: a clean clone would have no fixture at all
    // (ENOENT on the copy above). Such a fixture commits it as `dot-arbor/` and
    // the scratch copy renames it into place.
    const parkedArbor = join(scratch, "dot-arbor");
    if (existsSync(parkedArbor)) renameSync(parkedArbor, join(scratch, ".arbor"));
    if (Array.isArray(declared.link_repo_paths)) linkRepoPaths(scratch, declared.link_repo_paths);
    if (declared.git_repo === true) initGitRepo(scratch);
    // `internalCommand` is the ONLY way to run something other than the gate, and
    // it arrives as a runner argument from `runCensus`, never from a profile. The
    // self-test uses it to run a scratch `process.exit(0)` script that is not a
    // package.json gate — the negative control needs a gate that cannot fail, and
    // `bun run <name>` can only reach real gates. An empty argv falls back rather
    // than spawning with an undefined command, so a caller's typo is a missed
    // override instead of a crash.
    const argv = internalCommand?.length > 0 ? internalCommand : ["bun", "run", gate];
    const started = Date.now();
    // Bounded well below the gate's own timeout: a canary runs against a
    // minimal fixture, so anything near the real budget means the gate is not
    // reading the fixture at all.
    const raw = await runDeadlineProcess({
      command: argv[0],
      args: [...argv.slice(1), ...canaryArgs(declared, scratch)],
      cwd: repo,
      // A gate that reads its corpus from an environment variable rather than a
      // flag (`gate:language-census` reads REPO_ROOT) can only be pointed at a
      // fixture this way. The base is `sanitizedEnv()` rather than `process.env`
      // (see GIT_SCOPE_ENV_VARS above), so a declared overlay stays an overlay
      // and never a replacement, and the production spawn path above is
      // unchanged — which is the part that has to stay honest.
      env: declared.env ? { ...sanitizedEnv(), ...substitutedEnv(declared.env, scratch) } : sanitizedEnv(),
      timeout_ms: Math.min(entry.timeout_ms ?? 120_000, 120_000),
    });
    const duration_ms = Date.now() - started;
    const output = raw.output ?? "";
    return Object.freeze({
      gate,
      ...classifyCanaryResult({ declared, exit_code: raw.exit_code, output, expected_failure_reason: declared.expected_failure_reason }),
      exit_code: raw.exit_code ?? null,
      duration_ms,
      observed_count: parseObservedCount(output),
      observed_status: canaryObservationStatus(entry, output),
      spawn_error: raw.error ?? null,
    });
  } finally {
    if (!keepScratch) rmSync(scratch, { recursive: true, force: true });
  }
}

const ORDER = Object.freeze({ proven: 0, misfired: 1, unproven: 2, unmigrated: 3 });

/**
 * The census. Every gate in the profile gets a row — `unmigrated` included —
 * so "not migrated" is a countable state an operator can see, never an absence.
 * Migration is incremental by design, and incremental is only honest when the
 * remainder is on the page.
 *
 * `internalCommands` maps a gate name to the argv the runner may spawn for it
 * INSTEAD of `bun run <gate>`. It is the negative control's channel, it is a
 * parameter rather than a profile key precisely so no profile can reach it, and
 * it exists because `--self-test` has to run a scratch `process.exit(0)` script
 * that is not a package.json gate. Absent key means the real spawn path.
 */
export async function runCensus({ profilePath = PROFILE_PATH, repo = REPO_ROOT, only = null, keepScratch = false, internalCommands = {} } = {}) {
  const registry = loadExecutionProfile(profilePath);
  const names = Object.keys(registry.gates).sort();
  const results = [];
  for (const gate of names) {
    if (only && !only.includes(gate)) continue;
    results.push(await runCanary({
      gate, entry: registry.gates[gate], repo, keepScratch,
      internalCommand: internalCommands[gate] ?? null,
    }));
  }
  const counts = { proven: 0, misfired: 0, unproven: 0, unmigrated: 0 };
  for (const result of results) counts[result.classification] += 1;
  const sorted = [...results].sort((left, right) => (
    ORDER[left.classification] - ORDER[right.classification] || left.gate.localeCompare(right.gate)
  ));
  return Object.freeze({
    schema_version: 1,
    kind: "revoy2.guard_canary_census",
    profile_version: registry.profile_version,
    gate_count: results.length,
    counts: Object.freeze(counts),
    // A gate that cannot fail, or a canary that is not testing what it claims,
    // is a false green, and both are non-zero. Unmigrated is NOT: migration is
    // incremental by design, and every unmigrated gate is printed for that
    // reason — a skipped gate is the failure mode this milestone removes.
    ok: counts.unproven === 0 && counts.misfired === 0,
    gates: Object.freeze(sorted),
  });
}

function printCensus(census) {
  const label = { proven: "PROVEN", misfired: "MISFIRED", unproven: "UNPROVEN", unmigrated: "unmigrated" };
  for (const gate of census.gates) {
    const detail = gate.classification === "unmigrated"
      ? "  (no canary declared yet)"
      : `  exit=${gate.exit_code} observed_count=${gate.observed_count ?? "none"}` +
        (gate.observed_status ? ` observation=${gate.observed_status}` : "") +
        `  ${gate.reason}`;
    console.log(`${label[gate.classification].padEnd(10)} ${gate.gate}${detail}`);
  }
  const { proven, misfired, unproven, unmigrated } = census.counts;
  console.log(`\nguard:canaries — ${census.gate_count} gate(s): ${proven} proven, ${unproven} unproven, ${misfired} misfired, ${unmigrated} unmigrated.`);
  if (unmigrated > 0) console.log(`  ${unmigrated} gate(s) have no canary and are therefore UNPROVEN BY ABSENCE — listed above, never skipped.`);
  if (unproven > 0) console.error(`  ${unproven} gate(s) PASSED their own canary. A green from these gates is not evidence.`);
  if (misfired > 0) console.error(`  ${misfired} canary(ies) failed for an undeclared reason — fix the fixture or the gate, then re-run.`);
}

/**
 * The negative control, and the reason the classification cannot be a rubber
 * stamp. A gate whose body is `process.exit(0)` is run against a canary that
 * declares it must fail. It cannot, so the census must say `unproven` — and
 * this runs the SAME `runCanary`/`runCensus` path the real census uses, over a
 * scratch profile, so the control exercises the runner rather than a parallel
 * code path that could agree with it by construction.
 *
 * The scratch canary block declares NO `command`. It used to, and that was the
 * only thing keeping the key honest; it now arrives as `internalCommands`
 * instead, which no profile can set. The control is therefore no longer evidence
 * of the convention it was protecting — it is a caller of the same internal
 * channel a profile cannot reach, so it still exercises the real spawn path and
 * still fails if `classifyCanaryResult` ever softens.
 */
async function selfTest(repo) {
  const scratch = mkdtempSync(join(tmpdir(), "revoy2-guard-selftest-"));
  try {
    const gateBody = join(scratch, "always-passes.mjs");
    writeFileSync(gateBody, "#!/usr/bin/env node\n// The defect under test: a gate body that cannot fail.\nprocess.exit(0);\n");
    const { gates } = JSON.parse(readFileSync(PROFILE_PATH, "utf-8"));
    const template = gates["gate:adr-sections"];
    const profile = {
      schema_version: 1,
      profile_version: "self-test",
      gates: {
        "gate:selftest-always-passes": {
          ...template,
          canary: {
            fixture: "adr-sections/stub-obligation",
            expected_failure_reason: "incomplete/stub section",
          },
        },
      },
    };
    const profilePath = join(scratch, "execution-profile.json");
    writeFileSync(profilePath, JSON.stringify(profile, null, 2));
    const census = await runCensus({
      profilePath,
      repo,
      internalCommands: { "gate:selftest-always-passes": ["bun", gateBody] },
    });
    const row = census.gates[0];
    const asExpected = row.classification === "unproven" && census.ok === false;
    console.log("guard:canaries --self-test — scratch gate whose body is process.exit(0), run against its declared canary:");
    console.log(`  ${row.classification}  ${row.gate}  ${row.reason}`);
    console.log(asExpected
      ? "  PASS — a gate that cannot fail is reported unproven, and the census is not ok."
      : `  FAIL — expected unproven with ok=false, got ${row.classification} with ok=${census.ok}.`);
    return asExpected ? 0 : 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) return selfTest(REPO_ROOT);
  const only = args.includes("--only")
    ? args[args.indexOf("--only") + 1].split(",").map((name) => name.trim()).filter(Boolean)
    : null;
  const census = await runCensus({ repo: REPO_ROOT, only, keepScratch: args.includes("--keep-scratch") });
  if (args.includes("--json")) console.log(JSON.stringify(census, null, 2));
  else printCensus(census);
  return census.ok ? 0 : 1;
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`guard:canaries — ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
