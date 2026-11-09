#!/usr/bin/env node
/**
 * scripts/gate-all.mjs — the single enumerating gate battery (ADR-074).
 *
 * Usage:
 *   bun run gate:all                  # every gate, every tier
 *   bun run gate:all --tier stop      # ~4.5s drift checks (Stop-hook budget)
 *   bun run gate:all --tier fast      # stop + seconds-each gates (~27s)
 *   bun scripts/gate-all.mjs --json   # machine-readable report
 *   bun scripts/gate-all.mjs --list   # print the roster and exit
 *   bun scripts/gate-all.mjs --tier stop --skip gate:a,gate:b
 *                                     # schedule named gates out (Arboretum M2)
 *
 * Tiers are CUMULATIVE: `--tier fast` includes the stop gates.
 *
 * WHY THIS EXISTS. On 2026-08-15 `gate:typecheck-tests` was found failing on
 * master with 14 accumulated type errors. The gate was not broken, not
 * unwired, and not silent: it existed, it ran, and it printed an exact
 * remedy. It had simply never been in the battery anyone actually ran,
 * because `tsc --build` does not cover test files and the operator's mental
 * roster of "the gates" had been assembled by hand. Fourteen errors piled up
 * across three merges, one of them real contract drift (a telemetry port
 * mock never updated after ADR-067/071 widened it).
 *
 * The lesson is not "add another gate" — the roster itself was the defect. A
 * battery assembled from memory drifts no matter how disciplined the memory.
 * So this script never hardcodes which gates exist: it ENUMERATES them from
 * package.json at run time, and treats the roster as the thing under test.
 *
 * THE ANTI-DRIFT INVARIANT. Every `gate:*` script in package.json must be
 * classified in GATE_TIERS below. A gate present in package.json but absent
 * from GATE_TIERS is a hard failure, as is the reverse. This inverts the
 * failure mode that caused the incident: adding a gate without deciding when
 * it runs now BREAKS the battery loudly, where previously it silently ran
 * nowhere. Classification is a deliberate one-line act; omission is not an
 * option the system offers.
 *
 * WHY TIERS. A Stop hook has a few seconds of social budget, not a few
 * minutes. Tiering exists solely so the cheap majority can run as a mandatory
 * end condition while the expensive remainder stays explicit. Tier
 * assignments below are measured, not guessed (see `--json` `duration_ms`).
 *
 * WHY SEQUENTIAL. Gates shell out to git, mutate the index, and hash the
 * working tree (see store-provenance's `git ls-files -co`). Running them
 * concurrently makes them observe each other's scratch state — the exact
 * interference class that broke the store-freshness fixtures on 2026-08-15.
 *
 * AND WHY THE PARALLEL SCHEDULER IS NOT THE ANSWER HERE. `planGateDag` runs
 * gates in parallel waves under per-resource-class caps, and pre-commit,
 * pre-push and CI all use it, so this loop reads at first like a missed
 * optimisation. It is not. Those contexts run inside `runImmutableBattery`,
 * which does `git worktree add --detach` into a temp dir and then
 * `freezeTrackedInputs` chmods every tracked file read-only. Concurrency is
 * safe there because the tree is ISOLATED AND FROZEN — the resource caps bound
 * contention, they do not create isolation.
 *
 * This battery cannot have that. Its entire job is to report on the live,
 * dirty working tree the agent is editing right now; run it against a frozen
 * snapshot of HEAD and it answers a different question. So the choice is not
 * "sequential or the good scheduler", it is "sequential, or concurrent gates
 * racing on one mutable checkout". Measured cost of the safe option is in
 * `.arbor/enforcement/measured-costs.json` and bounded by `gate:stop-budget`
 * (ADR-156); spend it there, not here.
 *
 * A narrower parallelism — only gates proven to read committed state and touch
 * nothing — is possible in principle, but it needs a per-gate declaration that
 * does not exist today, and `mutability: read_only` is not it: that says a gate
 * does not write EVIDENCE, not that it writes no scratch file.
 *
 * COST CLASS IS NOT THE WHOLE STORY (2026-08-24). A gate's `cost_class` says
 * how expensive it is, not where it is ALLOWED to run — that is the profile's
 * own `contexts.<name>` boolean per execution-profile.json. `tierRoster`
 * below intersects the two for any tier name that is also a real execution
 * context (only "stop" today, since the Stop hook literally runs `--tier
 * stop`); see its doc comment for the incident this closes.
 */

import { spawnSync } from "node:child_process";
import { declaredLanguages, resolveGateSupport } from "./lib/language-support.mjs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { EXECUTION_CONTEXTS, loadExecutionProfile, selectedGates } from "./enforcement-control-plane.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}

const REPO_ROOT = resolvePath(argValue("--repo") ?? resolvePath(__dirname, ".."));
const jsonMode = process.argv.includes("--json");
const listMode = process.argv.includes("--list");
const tier = argValue("--tier") ?? "all";


/**
 * Tier assignment for every gate. Three tiers, with boundaries drawn from
 * MEASURED durations (2026-08-15 sweep, recorded in each comment) rather
 * than intuition:
 *
 *   stop — sub-second-ish, ~4.5s for all 17 together. Cheap enough to be a
 *          mandatory end condition on every Stop. These are the drift
 *          detectors: staleness, registry integrity, roster/lockfile
 *          agreement, orphaned state.
 *   fast — seconds each, ~23s together. Too slow to spend on every Stop,
 *          cheap enough to run before a commit or push.
 *   full — runs a suite, type-check, coverage pass, or eval; minutes.
 *
 * The stop/fast boundary is empirical: five gates (claim-ledger 8.8s,
 * docs-truth 8.6s, reachability 2.8s, liveness 1.8s, anti-stub 1.4s)
 * accounted for 23 of the 27 seconds the original two-tier `fast` took,
 * while the other 17 gates together cost 4.4s.
 *
 * `gate:all` itself is excluded by construction, not listed here.
 */
const EXECUTION_PROFILE = loadExecutionProfile(resolvePath(__dirname, "execution-profile.json"));
/**
 * ADR-143: which languages each gate can measure, and which this repo declares.
 * A gate that cannot read this repository's languages must not be able to
 * report PASS -- see `annotateSupport`.
 */
const GATE_MANIFEST = (() => {
  try { return JSON.parse(readFileSync(resolvePath(__dirname, "gate-manifest.json"), "utf-8")).gates ?? {}; }
  catch { return {}; }
})();
const REPO_LANGUAGES = declaredLanguages(REPO_ROOT);
// ADR-074's former handwritten table is now a compatibility projection of the
// single execution profile. Gate scheduling may not drift from CI/pre-push.
const GATE_TIERS = Object.freeze(Object.fromEntries(
  Object.entries(EXECUTION_PROFILE.gates)
    .filter(([name]) => name !== "gate:all")
    .map(([name, entry]) => [name, entry.cost_class]),
));

// Exported so `enforcement-control-plane.mjs --verify` can prove gate-all
// obeys the profile it claims to (see that module's `auditGateAllTierAgreement`).
export const TIER_NAMES = ["stop", "fast", "full"];

/**
 * Gates whose verdict depends on UNCOMMITTED working-tree state, and which
 * therefore go red during perfectly normal mid-task work.
 *
 * store-freshness compares the evidence stores against a content hash of
 * `git ls-files -co --exclude-standard`, so editing any tracked file — or
 * adding any un-ignored new one — turns it red until the stores are
 * refreshed AND committed. That is correct as a release condition and
 * intolerable as a per-Stop blocking condition.
 *
 * This set is not a policy decision, only the mechanical fact. Callers
 * decide what to do with it via `--advisory` (the Stop hook passes these
 * when the tree is dirty; a pre-push run does not).
 */
const DIRTY_SENSITIVE = new Set(["gate:store-freshness"]);

/**
 * Gates the Stop hook runs and reports but never vetoes on, each with the
 * reason it cannot be a blocking end condition.
 *
 * This is NOT a way to quiet an inconvenient gate. Every gate here still runs
 * on every Stop, still prints its full remedy, and still fails `gate:all`
 * everywhere else — pre-push, CI, and any manual run. What is relaxed is only
 * the veto, and only where a veto would be either meaningless or unfixable by
 * the party the hook is talking to.
 *
 * The failure mode being avoided is specific: a hook that blocks on something
 * the model cannot legitimately resolve does not produce a fix, it produces a
 * bypass — and a disabled hook checks nothing at all.
 */
const HOOK_ADVISORY = new Map([
  [
    "gate:store-freshness",
    "verdict depends on uncommitted working-tree state, so it is red throughout all normal mid-task work",
  ],
  [
    "gate:vi-findings",
    "requires a RECORDED HUMAN VERDICT per finding, with a reason and an expiry; a model triaging its own findings " +
      "would fabricate exactly the human decision this gate exists to prove",
  ],
  [
    "gate:hollow-parity",
    "surface-scoped reachability is red by design until D42 dispositions the MCP-generic-only catalog kinds " +
      "(each needs an operator verdict: wire to a product surface, or declare api-only with a reason)",
  ],
]);

// gate:decision-queue was listed above until 2026-08-19, on the reasoning that
// "an agent cannot hold an interview with itself mid-task". That reasoning was
// WRONG and the exemption is removed. The agent does not interview itself — it
// asks the OPERATOR through the question surface, which is exactly how the
// first interview under ADR-081 was run. A decision only a human can make is
// therefore resolvable at Stop, so relaxing the veto bought nothing and let
// operator-call items accrue indefinitely behind a warning nobody had to act
// on. See the record superseding ADR-081's scheduling clause.

/**
 * `--advisory <gate,gate>` runs the named gates and reports their result but
 * excludes them from the exit code. Two named expansions exist:
 * `dirty-sensitive` (DIRTY_SENSITIVE) and `hook-default` (HOOK_ADVISORY, what
 * the Stop hook passes on a dirty tree). A gate is never silently skipped —
 * an advisory gate still runs and still prints, it just cannot fail the
 * battery.
 */
const advisoryArg = argValue("--advisory");
const advisoryGates = new Set(
  advisoryArg === null
    ? []
    : advisoryArg === "dirty-sensitive"
      ? DIRTY_SENSITIVE
      : advisoryArg === "hook-default"
        ? HOOK_ADVISORY.keys()
        : advisoryArg.split(",").map((name) => name.trim()).filter((name) => name.length > 0),
);

/**
 * `--skip <gate,gate>` (Arboretum M2): gates the CALLER scheduled out because
 * none of their declared inputs changed. The native stop battery
 * (`packages/arbor-mcp/src/hooks/stop-battery-scope.ts`) is the caller that
 * decides; this battery keeps sole ownership of the roster and only honours
 * the list. A skipped gate is printed as SKIP and reported in `--json`, never
 * dropped silently, and a name that is not a declared gate is refused rather
 * than ignored, because a misspelt skip would otherwise read as a scheduled-out
 * gate that never existed.
 */
const skipArg = argValue("--skip");
export function parseSkipList(value) {
  return value === null ? [] : [...new Set(value.split(",").map((name) => name.trim()).filter((name) => name.length > 0))];
}
const skipGates = new Set(parseSkipList(skipArg));

/**
 * The measured-costs tier key a run records under. A run with gates scheduled
 * out must not feed `tiers.stop`, which `gate:stop-budget` (ADR-156) reads as
 * the cost of the WHOLE tier: scoped totals there would lower the median by
 * running less, not by getting cheaper. They are kept under `<tier>:scoped`.
 */
export function measuredCostsTier(tierName, skipped) {
  return skipped.length > 0 ? `${tierName}:scoped` : tierName;
}

/**
 * Gate scripts declared in package.json, excluding this battery itself.
 * Exported so the anti-drift invariant is provable directly rather than only
 * through a subprocess — this function and `auditRoster` ARE the decision
 * ADR-074 records, so they are the surface a proof should bind to.
 */
export function enumerateGates(repoRoot = REPO_ROOT) {
  const pkg = JSON.parse(readFileSync(resolvePath(repoRoot, "package.json"), "utf-8"));
  return Object.keys(pkg.scripts ?? {})
    .filter((name) => name.startsWith("gate:") && name !== "gate:all")
    .sort();
}

/**
 * The anti-drift check, and the whole point of this module: returns a list of
 * human-readable problems; empty means the roster and the classification
 * agree exactly. `classified` is injectable so a test can prove the invariant
 * in BOTH directions without mutating the real tier table.
 */
export function auditRoster(declared, classified = Object.keys(GATE_TIERS)) {
  const problems = [];
  for (const name of declared) {
    if (!classified.includes(name)) {
      problems.push(
        `${name} is declared in package.json but has no tier in scripts/gate-all.mjs GATE_TIERS. ` +
          `Add \`"${name}": "fast",\` (or "full" if it runs a suite/type-check/eval) — this is the ` +
          `check that keeps a new gate from silently running nowhere.`,
      );
    }
  }
  for (const name of classified) {
    if (!declared.includes(name)) {
      problems.push(
        `${name} has a tier in scripts/gate-all.mjs GATE_TIERS but no longer exists in package.json. ` +
          `Remove its GATE_TIERS entry.`,
      );
    }
  }
  return problems;
}

/**
 * The roster for one `--tier` value: cost_class cumulative budget, intersected
 * with the profile's `contexts.<tier>` boolean whenever the tier name is
 * ALSO a real execution context (today, only "stop" — the Stop hook runs
 * `--tier stop` and IS the "stop" context). "fast" and "full" are cost-budget
 * labels, not contexts the profile declares, so no such intersection applies
 * to them; the roster there stays cost_class-only, matching the ad hoc/manual
 * nature of those runs.
 *
 * WHY THIS EXISTS (2026-08-24). gate:organization-enrollment declares
 * cost_class "stop" but `contexts.stop: false` (reason:
 * authenticated_ci_authority_required — it needs a CI-supplied GH_TOKEN). The
 * battery selected it into the stop tier by cost_class alone, so every Stop
 * hook run raw-crashed on a missing token for a gate the profile had already
 * and explicitly excluded from that exact context. `selectedGates` from
 * enforcement-control-plane.mjs (the same function `enforcement-battery.mjs`
 * uses for prepush/CI) is the one authoritative source for "which gates run
 * in context X" — this reuses it rather than re-deriving a second, divergent
 * answer to the same question.
 */
export function tierRoster(tier, { profile = EXECUTION_PROFILE, declared = enumerateGates(), tierNames = TIER_NAMES, tiers = GATE_TIERS } = {}) {
  const contextAllowed = EXECUTION_CONTEXTS.includes(tier)
    ? new Set(selectedGates(profile, tier).map((entry) => entry.name))
    : null;
  // A name that is an execution CONTEXT but not a tier gets no cost budget at
  // all: the roster is exactly what that context selects. Without this,
  // `indexOf` returned -1 and every gate was filtered out, so `--tier prepush`
  // ran NOTHING and exited clean — the worst possible answer for a preview.
  // The sixteen prepush/CI-only gates were unpreviewable in practice, which
  // makes the push the first moment they ever execute. "stop" is unaffected
  // because it is both a tier and a context, so it keeps intersecting the two.
  const contextOnly = contextAllowed !== null && !tierNames.includes(tier);
  const budget = tier === "all" || contextOnly ? tierNames.length - 1 : tierNames.indexOf(tier);
  return declared.filter((name) => {
    if (tierNames.indexOf(tiers[name]) > budget) return false;
    return contextAllowed === null || contextAllowed.has(name);
  });
}

function runGate(name) {
  const started = Date.now();
  const result = spawnSync("bun", ["run", name], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const duration_ms = Date.now() - started;
  const status = result.error ? null : result.status;
  const support = resolveGateSupport({ gate: name, manifest: GATE_MANIFEST, languages: REPO_LANGUAGES });
  return {
    support,
    gate: name,
    tier: GATE_TIERS[name],
    advisory: advisoryGates.has(name),
    dirty_sensitive: DIRTY_SENSITIVE.has(name),
    // ADR-143 Decision 2: a gate with no pack for this repo's languages
    // measured nothing, and a gate that cannot see is not a gate that agrees.
    // `undeclared` is equally not a pass -- omission must not be how a new gate
    // skips its manifest entry.
    ok: status === 0 && support.verdict !== "unsupported" && support.verdict !== "undeclared",
    exit_code: status,
    duration_ms,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    spawn_error: result.error ? String(result.error.message) : null,
  };
}

/** The last non-empty lines of a gate's output — enough to see the remedy it printed. */
function tailOutput(run, lines = 12) {
  const combined = `${run.stdout}\n${run.stderr}`
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  return combined.slice(-lines);
}

/**
 * ADR-113 decision 1. `assertGovernanceConsumerReady`
 * (scripts/lib/governance-plan.mjs:76-103) is the single real precondition
 * five stop-tier gates share; while a transaction is held, every one of them
 * throws the exact same `GovernancePlanRefusal("producer_incomplete", ...)`
 * text, differing only by which gate name is running. This battery already
 * holds every gate's full stdout/stderr in one process before printing
 * anything, so it is the one place that can notice five near-identical
 * paragraphs are one cause and say so once — `assertGovernanceConsumerReady`
 * itself cannot, since it runs inside its own gate's separate `spawnSync`
 * child with no view of the other four gates' outcomes (see the ADR's
 * "Alternatives" section).
 *
 * The extractor below matches ONLY that one message shape (the literal
 * "refuses derived governance evidence while transaction ... is active"
 * fragment governance-plan.mjs emits). A future second cause of correlated
 * failures needs its own extractor added here, not automatic coverage — the
 * ADR is explicit that this is a per-cause opt-in, not a generic clusterer.
 */
const PRODUCER_INCOMPLETE_RE = /refuses derived governance evidence while transaction (\S+) is active/;

/** The held-transaction id a run's output names, or null if it names none. */
export function producerIncompleteTransactionId(run) {
  const combined = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  const match = combined.match(PRODUCER_INCOMPLETE_RE);
  return match ? match[1] : null;
}

/**
 * Groups a list of failing runs so every run whose output names the SAME held
 * transaction lands in one group; every other run keeps its own single-run
 * group. Order is preserved (first-seen order of each transaction id), so the
 * printed report reads the same top-to-bottom order the battery ran gates in.
 */
export function groupFailuresByCause(failures) {
  const groups = [];
  const byTransaction = new Map();
  for (const run of failures) {
    const transactionId = producerIncompleteTransactionId(run);
    if (transactionId === null) {
      groups.push({ cause: null, transaction_id: null, runs: [run] });
      continue;
    }
    let group = byTransaction.get(transactionId);
    if (!group) {
      group = { cause: "producer_incomplete", transaction_id: transactionId, runs: [] };
      byTransaction.set(transactionId, group);
      groups.push(group);
    }
    group.runs.push(run);
  }
  return groups;
}

/**
 * Prints one failure section (the blocking list or the advisory list) with
 * same-cause runs collapsed to one "SHARED CAUSE" entry. A group of exactly
 * one run — including a producer_incomplete failure with no sibling this run
 * — prints in the original one-line-per-gate form, so a genuinely solitary
 * failure is never dressed up as a cluster. `stop-guard.mjs`'s
 * `parseRedGates` reads BOTH shapes: the classic `  gate (exit N):` header
 * and the grouped `    - gate (exit N)` list item, so the circuit breaker's
 * fingerprint is unaffected by which shape a given run prints in.
 */
export function printFailureSection(failures, annotate = () => null) {
  for (const group of groupFailuresByCause(failures)) {
    if (group.cause === null || group.runs.length === 1) {
      for (const run of group.runs) {
        console.error(`\n  ${run.gate} (exit ${run.exit_code}):`);
        const note = annotate(run);
        if (note) console.error(`    advisory because: ${note}`);
        for (const line of tailOutput(run)) console.error(`    ${line}`);
      }
      continue;
    }
    console.error(
      `\n  SHARED CAUSE — held evidence transaction ${group.transaction_id} is active (covers: ${group.runs.length} gates):`,
    );
    for (const run of group.runs) {
      console.error(`    - ${run.gate} (exit ${run.exit_code})`);
      const note = annotate(run);
      if (note) console.error(`      advisory because: ${note}`);
    }
    console.error("");
    for (const line of tailOutput(group.runs[0])) console.error(`    ${line}`);
  }
}

/**
 * Where the battery records what its gates actually cost.
 *
 * WHY THIS EXISTS. ADR-147 decision 9 says timing is part of the receipt and
 * not folklore, and `scripts/enforcement-audit.mjs` renders a
 * `last_duration_ms` column for every contract. Nothing local ever fed it: the
 * only producer was CI's aggregate report, which is gitignored and kept for 30
 * days, so on any working clone all 57 contracts read `unmeasured`. Meanwhile
 * the stop tier's own budget -- the empirical figure the whole three-tier
 * design rests on -- had drifted from a documented 17 gates at ~3.7s to 36
 * gates at ~11.8s, with no test and no receipt to notice.
 *
 * WHY A SEPARATE FILE FROM THE CI AGGREGATE REPORT. `aggregate-report.json` is
 * the input to `validateAggregateExecutionReport` and the attestation chain. A
 * local partial run must never overwrite it, or a Stop battery on a laptop
 * could stand in for the authenticated CI verdict. This file is local
 * measurement only; the audit command reads both and prefers the CI figure.
 *
 * Best-effort throughout. A battery that cannot write its receipt still
 * reports its verdict -- the verdict is the point, the receipt is bookkeeping.
 */
export const MEASURED_COSTS_PATH = resolvePath(__dirname, "..", ".arbor", "enforcement", "measured-costs.json");

export function mergeMeasuredCosts(previous, { tier, runs, at }) {
  const gates = { ...(previous?.gates ?? {}) };
  for (const run of runs) {
    // Merge per gate, never replace the map: a stop-tier run must not blank the
    // measurement of a gate that only runs at prepush or in CI.
    gates[run.gate] = { duration_ms: run.duration_ms, tier, measured_at: at };
  }
  const tiers = { ...(previous?.tiers ?? {}) };
  const total = runs.reduce((sum, run) => sum + run.duration_ms, 0);
  // A short rolling series, not a single reading. Wall clock on a developer
  // workstation is noisy -- a busy box, a cold cache -- and a budget judged on
  // one spiky run either flaps or has to be set so loose it proves nothing.
  const recent = [...(previous?.tiers?.[tier]?.recent_totals_ms ?? []), total].slice(-10);
  tiers[tier] = {
    gate_count: runs.length,
    total_duration_ms: total,
    recent_totals_ms: recent,
    measured_at: at,
  };
  return { schema_version: 1, kind: "revoy2.gate_measured_costs", gates, tiers };
}

function recordMeasuredCosts({ tier, runs }) {
  if (runs.length === 0) return;
  try {
    let previous = null;
    try { previous = JSON.parse(readFileSync(MEASURED_COSTS_PATH, "utf-8")); } catch { previous = null; }
    const merged = mergeMeasuredCosts(previous, { tier, runs, at: new Date().toISOString() });
    mkdirSync(dirname(MEASURED_COSTS_PATH), { recursive: true });
    writeFileSync(MEASURED_COSTS_PATH, `${JSON.stringify(merged, null, 2)}\n`);
  } catch {
    // Bookkeeping must never change a verdict.
  }
}

function main() {
  // `--tier` accepts a cost tier OR an execution-context name. The context
  // form is a PREVIEW: it selects exactly what that context would run, at
  // whatever cost, which is the only way to see the sixteen prepush/CI-only
  // gates before the push itself becomes the first thing that runs them.
  // Rejecting context names here is what made the tierRoster fix inert: the
  // roster knew how to build a prepush selection and this check refused the
  // argument before it was ever asked.
  if (tier !== "all" && !TIER_NAMES.includes(tier) && !EXECUTION_CONTEXTS.includes(tier)) {
    console.error(`gate:all — unknown --tier "${tier}". Expected a tier (${TIER_NAMES.join(", ")}, all) or an execution context (${EXECUTION_CONTEXTS.join(", ")}).`);
    process.exit(2);
  }
  const declared = enumerateGates();
  const rosterProblems = auditRoster(declared);

  if (listMode) {
    // Honour --tier here too. It used to be accepted and silently discarded,
    // so `--list --tier prepush` printed all 51 gates and looked like a
    // preview of a roster it was not actually showing.
    for (const name of tierRoster(tier, { declared })) console.log(`${GATE_TIERS[name] ?? "UNCLASSIFIED"}\t${name}`);
    process.exit(rosterProblems.length > 0 ? 1 : 0);
  }

  // A drifted roster is itself a gate failure, and it is reported BEFORE any
  // gate runs: if the roster is wrong, a green battery proves nothing.
  if (rosterProblems.length > 0) {
    const report = { ok: false, roster_problems: rosterProblems, gates: [] };
    if (jsonMode) console.log(JSON.stringify(report, null, 2));
    else {
      console.error("gate:all — ROSTER DRIFT (no gates were run):");
      for (const problem of rosterProblems) console.error(`  - ${problem}`);
    }
    process.exit(1);
  }

  // Tiers are cumulative budgets, not disjoint sets: `--tier fast` runs the
  // stop gates too. A cheaper tier passing is always implied by a costlier
  // one passing, and an operator asking for "fast" never means "skip the
  // 4-second drift checks". `tierRoster` additionally intersects with the
  // profile's `contexts.<tier>` boolean where the tier name is a real
  // execution context (see its doc comment) — cost_class alone is not enough.
  const unknownSkips = [...skipGates].filter((name) => !declared.includes(name));
  if (unknownSkips.length > 0) {
    console.error(`gate:all — --skip names gate(s) that are not declared in package.json: ${unknownSkips.join(", ")}. No gates were run.`);
    process.exit(2);
  }
  const roster = tierRoster(tier, { declared });
  const selected = roster.filter((name) => !skipGates.has(name));
  const skipped = roster.filter((name) => skipGates.has(name));
  if (!jsonMode) for (const name of skipped) console.log(`SKIP  ${name}  [scheduled out — no declared input changed]`);
  const runs = [];
  for (const name of selected) {
    const run = runGate(name);
    runs.push(run);
    if (!jsonMode) {
      const unmeasured = run.support.verdict === "unsupported" || run.support.verdict === "undeclared";
      const mark = unmeasured ? "N/A " : run.ok ? "PASS" : run.advisory ? "WARN" : "FAIL";
      const suffix = unmeasured
        ? `  [${run.support.verdict} — ${run.support.reason}]`
        : run.advisory && !run.ok ? "  [advisory — does not fail the battery]" : "";
      console.log(`${mark}  ${name}  (${run.duration_ms}ms)${suffix}`);
    }
  }

  const failures = runs.filter((run) => !run.ok && !run.advisory);
  const advisoryFailures = runs.filter((run) => !run.ok && run.advisory);
  // Self-disclosure: a gate this run never touched but which DOES run at
  // prepush or CI is exactly the invisibility the 2026-08-24 incident was
  // caused by — a roster nobody looked at running gates nobody previewed. This
  // never vetoes anything; it only names what this run could not have caught.
  const selectedSet = new Set(selected);
  // A gate scheduled out by --skip is reported under SKIP, not here.
  const invisibleHere = declared.filter((name) => !selectedSet.has(name) && !skipGates.has(name)
    && (EXECUTION_PROFILE.gates[name]?.contexts?.prepush === true || EXECUTION_PROFILE.gates[name]?.contexts?.ci === true));
  recordMeasuredCosts({ tier: measuredCostsTier(tier, skipped), runs });

  const report = {
    ok: failures.length === 0,
    tier,
    roster_problems: [],
    gate_count: runs.length,
    failure_count: failures.length,
    advisory_failure_count: advisoryFailures.length,
    total_duration_ms: runs.reduce((sum, run) => sum + run.duration_ms, 0),
    invisible_here: invisibleHere,
    skipped,
    gates: runs.map(({ stdout: _stdout, stderr: _stderr, ...rest }) => ({
      ...rest,
      output_tail: tailOutput({ stdout: _stdout, stderr: _stderr }),
    })),
  };

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else if (failures.length > 0) {
    console.error(`\ngate:all — ${failures.length} of ${runs.length} gate(s) FAILED:`);
    printFailureSection(failures);
  } else {
    console.log(`\ngate:all — ${runs.length} gate(s) passed in ${report.total_duration_ms}ms.${skipped.length > 0 ? ` ${skipped.length} scheduled out by unchanged inputs.` : ""}`);
  }

  if (!jsonMode && invisibleHere.length > 0) {
    console.log(`\n${invisibleHere.length} gate(s) run only at prepush/CI and were not previewed here: ${invisibleHere.join(", ")}`);
  }

  // Advisory failures print in BOTH the pass and fail paths: an advisory gate
  // that is red is still information the operator needs, it just isn't a veto.
  if (!jsonMode && advisoryFailures.length > 0) {
    console.error(`\ngate:all — ${advisoryFailures.length} advisory gate(s) are red (not failing the battery):`);
    printFailureSection(advisoryFailures, (run) => HOOK_ADVISORY.get(run.gate) ?? null);
  }

  process.exit(report.ok ? 0 : 1);
}

// Only run the battery when invoked as a CLI. Importing this module (to prove
// `auditRoster`, or to reuse the roster elsewhere) must never spawn 27 gates.
if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
