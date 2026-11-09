#!/usr/bin/env node
/**
 * scripts/stop-budget-gate.mjs — ADR-156: the Stop tier's budget is measured,
 * and it only goes down.
 *
 * WHY THIS EXISTS. The three-tier split in ADR-074 is defined by cost: the
 * `stop` tier is the set cheap enough to run at every turn boundary, and its
 * boundary was drawn from a real measurement -- "17 gates, ~3.7s wall". Nothing
 * ever re-measured it. `cost_class` is a declaration, and declarations do not
 * decay visibly, so every gate added with `cost_class: "stop"` taxed every turn
 * boundary for free. Measured on 2026-09-02: 37 gates, ~14s. Three times the
 * documented budget, and the only timing assertion in the whole gate test
 * corpus was `expect(gate.duration_ms).toBeGreaterThanOrEqual(0)`.
 *
 * WHAT IT DOES NOT DO. It does not police individual gates, and it is not an
 * argument that the tier is too expensive. 14s at a turn boundary may well be
 * worth paying -- that is the premise of this harness. The defect was that
 * nobody chose it, nothing reported it, and nothing stopped it becoming 30s.
 *
 * WHY A MEDIAN OVER A SERIES. Wall clock on a developer workstation is noisy.
 * Judging one reading either flaps under ordinary load or needs a ceiling so
 * loose it proves nothing. `gate-all.mjs` keeps the last ten totals per tier;
 * this reads their median and needs `min_samples` of them before it will judge
 * at all.
 *
 * WHY IT READS THE PREVIOUS RUN. This gate runs INSIDE the stop battery, so it
 * cannot see the run it is part of. It judges the series up to and including
 * the last completed run, which is what a ratchet needs: the question is
 * whether the tier has grown, not what this instant cost.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const BUDGET_PATH = resolvePath(REPO_ROOT, "scripts", "gate-budget", "stop-budget.json");
const DEFAULT_COSTS_PATH = resolvePath(REPO_ROOT, ".arbor", "enforcement", "measured-costs.json");

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

/**
 * `--costs` redirects the recorded series the gate judges. Its presence is
 * recorded, not just its value: a caller that names a file and gets silence
 * back has been handed a verdict about nothing, and text mode used to be
 * indistinguishable from a real one.
 */
export function resolveCostsPath(argv = []) {
  const substituted = argValue(argv, "--costs");
  return { path: substituted ?? DEFAULT_COSTS_PATH, substituted: Boolean(substituted) };
}

/**
 * The measured series, read with the same discipline `readBudget` applies to
 * the ceiling: an unreadable input is a fact about the input, never a
 * permissive default. The three states are kept apart because they mean
 * different things — a series nobody has recorded yet is an unseeded clone, a
 * corrupt file is a defect, and a caller-named file that is not there is a
 * caller error. Collapsing any of them into "no samples, carry on" is what
 * made this ratchet vacuous.
 */
export function readCosts(path, { substituted = false } = {}) {
  if (!existsSync(path)) {
    return {
      ok: false,
      // An unseeded clone is the expected state of a fresh checkout (`.arbor/`
      // is gitignored, and gate-all.mjs records the series only AFTER the
      // roster has run), so it is disclosed loudly but is not a blocker. A
      // file the caller explicitly named is a different thing: that is a
      // request for a series that is not there, and it fails.
      blocking: substituted,
      error: `no measured-cost series at ${path}${substituted ? " (the --costs path you named)" : " (this clone's stop battery has not recorded one yet)"}`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    return { ok: false, blocking: true, error: `measured costs are unreadable: ${String(error)}` };
  }
  const series = parsed?.tiers?.stop?.recent_totals_ms;
  if (series !== undefined && !Array.isArray(series)) {
    return { ok: false, blocking: true, error: `measured costs are malformed: tiers.stop.recent_totals_ms is ${typeof series}, not an array` };
  }
  return { ok: true, blocking: false, series: series ?? [], path };
}

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export function readBudget(path = BUDGET_PATH) {
  if (!existsSync(path)) return { ok: false, error: `stop budget missing: ${path}` };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!Number.isFinite(parsed.ceiling_ms) || parsed.ceiling_ms <= 0) {
      return { ok: false, error: "stop budget ceiling_ms must be a positive number" };
    }
    return { ok: true, ceilingMs: parsed.ceiling_ms, minSamples: Number.isInteger(parsed.min_samples) ? parsed.min_samples : 3, raw: parsed };
  } catch (error) {
    // An unreadable budget is a blocker, never a permissive default.
    return { ok: false, error: `stop budget is unreadable: ${String(error)}` };
  }
}

/**
 * The verdict as a pure function of the recorded series and the ceiling, so
 * both directions are provable without running a battery.
 */
export function auditStopBudget({ recentTotalsMs, ceilingMs, minSamples = 3 }) {
  const samples = (recentTotalsMs ?? []).filter((value) => Number.isFinite(value));
  if (samples.length < minSamples) {
    return {
      ok: true,
      verdict: "insufficient_samples",
      samples: samples.length,
      min_samples: minSamples,
      median_ms: median(samples),
      ceiling_ms: ceilingMs,
    };
  }
  const medianMs = median(samples);
  return {
    ok: medianMs <= ceilingMs,
    verdict: medianMs <= ceilingMs ? "within_budget" : "over_budget",
    samples: samples.length,
    min_samples: minSamples,
    median_ms: medianMs,
    ceiling_ms: ceilingMs,
  };
}

function printRemedy(result, budget) {
  console.error("");
  console.error("Remedy:");
  console.error(`  The stop tier's median wall clock is ${result.median_ms}ms against a ceiling of ${result.ceiling_ms}ms.`);
  console.error("  This tier runs at EVERY turn boundary, so its cost is paid on every stop.");
  console.error("");
  console.error("  Find what grew:");
  console.error("");
  console.error("    bun scripts/enforcement-audit.mjs | sort -k6 -n");
  console.error("");
  console.error("  Then either move the expensive gate to the `fast` or `full` cost_class in");
  console.error("  scripts/execution-profile.json, or make it cheaper. Raising ceiling_ms in");
  console.error("  scripts/gate-budget/stop-budget.json is a deliberate, reviewable edit that");
  console.error("  must carry its reason -- the ceiling is a ratchet and is meant to fall.");
  void budget;
}

/**
 * The verdict, as a pure function of what could be read. `measured: false`
 * means the ratchet observed nothing — which is a distinct outcome from
 * `within_budget`, not a quiet version of it, and it is deliberately never
 * reported through the `insufficient_samples` path: that verdict means "we
 * have too few real measurements", and reusing it for "we have no file" is
 * what made a missing costs file indistinguishable from a healthy one.
 */
export function evaluateStopBudget({ costs, ceilingMs, minSamples = 3, costsPath, substituted }) {
  const disclosure = { costs: costsPath, costs_substituted: substituted };
  if (!costs.ok) {
    return {
      ok: false,
      measured: false,
      verdict: "costs_unavailable",
      blocking: costs.blocking,
      error: costs.error,
      samples: 0,
      min_samples: minSamples,
      median_ms: null,
      ceiling_ms: ceilingMs,
      ...disclosure,
    };
  }
  return { measured: true, ...auditStopBudget({ recentTotalsMs: costs.series, ceilingMs, minSamples }), ...disclosure };
}

export function main(argv = process.argv.slice(2)) {
  const jsonOut = argv.includes("--json");
  const budget = readBudget();
  if (!budget.ok) {
    if (jsonOut) console.log(JSON.stringify({ ok: false, error: budget.error }, null, 2));
    else console.error(`gate:stop-budget — ${budget.error}`);
    return 1;
  }

  const { path: costsPath, substituted } = resolveCostsPath(argv);
  const result = evaluateStopBudget({ costs: readCosts(costsPath, { substituted }), ceilingMs: budget.ceilingMs, minSamples: budget.minSamples, costsPath, substituted });

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : result.blocking ? 1 : 0;
  }

  // Every text-mode line names the series it judged, and a substituted series
  // says so out loud. A text-mode green that might be judging a fixture is
  // not a verdict anyone can act on.
  const source = substituted ? `SUBSTITUTED SERIES ${result.costs}` : result.costs;
  if (!result.measured) {
    console.log(`gate:stop-budget — NOT MEASURED (${result.verdict}): ${result.error}`);
    console.log(`  series judged: ${source}`);
    if (!result.blocking) {
      console.log("  The ratchet did not run, so this is not a pass. It means the stop tier's cost is");
      console.log("  currently unverified. Seed it with: bun scripts/gate-all.mjs --tier stop");
    } else {
      console.error(`gate:stop-budget — the recorded series is unusable: ${result.error}`);
    }
    return result.blocking ? 1 : 0;
  }

  if (result.verdict === "insufficient_samples") {
    console.log(
      `gate:stop-budget — ${result.samples} of ${result.min_samples} sample(s) recorded so far; ` +
        `not judging yet (ceiling ${result.ceiling_ms}ms). Run the stop battery a few times to seed it.`,
    );
    console.log(`  series judged: ${source}`);
    return 0;
  }

  console.log(
    `gate:stop-budget — stop tier median ${result.median_ms}ms over ${result.samples} run(s), ` +
      `ceiling ${result.ceiling_ms}ms.`,
  );
  console.log(`  series judged: ${source}`);
  if (!result.ok) {
    console.error(`gate:stop-budget — the stop tier is over budget: ${result.median_ms}ms > ${result.ceiling_ms}ms.`);
    printRemedy(result, budget);
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
