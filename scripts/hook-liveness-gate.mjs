#!/usr/bin/env node
/**
 * scripts/hook-liveness-gate.mjs — has each hook stopped varying?
 *
 *   node scripts/hook-liveness-gate.mjs [--json]
 *
 * THE PROBLEM. Every other gate in this repository asks whether the CODE is
 * right. None asks whether the things doing the asking are still working. Hooks
 * fail in a uniquely quiet way: they keep emitting a confident verdict long
 * after they stopped measuring anything, and because the verdict looks like
 * output, nobody investigates. This repository has three recorded instances:
 *
 *   - `vi-freshness.sh` reported `DIVERGED — 42 uncommitted path(s)` at every
 *     session start against a tree with ZERO uncommitted paths, for ~42
 *     sessions. Its tracker was append-only and nothing cleared it.
 *   - `vi-freshness-gate.mjs` printed "…and is not degraded" on every run from
 *     a check that read a manifest key no manifest has ever contained. It could
 *     not have fired.
 *   - `VENDOR.md` promised `gate:vi-vendor` would detect edits to vendored
 *     files. The script did not exist; a 65-line divergence went unreported.
 *
 * All three are the same shape: a signal that cannot vary, presented as a
 * signal that does. This gate asks the one question that catches that shape —
 * *has this hook's output stopped depending on anything?*
 *
 * WHY THIS IS REPORT-ONLY, PERMANENTLY. A rot verdict is a statistical claim
 * over a local, machine-specific invocation history. It is a strong hint and a
 * weak proof: a hook can legitimately return the same verdict twenty times
 * because the repository genuinely did not change. Blocking a push on that
 * would be blocking on an inference, and this whole line of work exists to stop
 * dressing inference as fact.
 *
 * WHY THIS HAS NO CI JOB, deliberately breaking the one-job-per-gate convention.
 * CI never fires a Claude Code hook. `.hook-liveness/invocations.jsonl` is
 * gitignored session-local state, so in CI this gate would read an empty file
 * and print a clean result forever — a check that cannot fail, reported as a
 * check that passed. That is precisely defect #2 above. A vacuous green job
 * would be worse than no job, so there is no job.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(argValue("--repo") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const DIR = join(REPO_ROOT, ".hook-liveness");
const MANIFEST = join(DIR, "hook-manifest.json");
const LOG = join(DIR, "invocations.jsonl");
const JSON_OUT = process.argv.includes("--json");

// `--repo <path>` exists so this gate can be run against a fixture repository
// rather than only its own checkout (branch-accounting.mjs sets the precedent).
// Inert when absent: with no flag the root is exactly what it always was.
function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}

function main() {
  if (!existsSync(MANIFEST)) {
    console.error("hook-liveness — no .hook-liveness/hook-manifest.json; nothing declares what these hooks should do");
    return 2;
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const rule = manifest.rot_rule ?? { window: 20, min_samples: 10 };

  const invocations = existsSync(LOG)
    ? readFileSync(LOG, "utf8").split("\n").filter((l) => l.trim()).flatMap((l) => {
        try { return [JSON.parse(l)]; } catch { return []; }
      })
    : [];

  const byHook = new Map();
  for (const rec of invocations) {
    if (!rec?.hook_id) continue;
    if (!byHook.has(rec.hook_id)) byHook.set(rec.hook_id, []);
    byHook.get(rec.hook_id).push(rec);
  }

  const results = [];
  for (const declared of manifest.hooks ?? []) {
    const all = byHook.get(declared.hook_id) ?? [];
    const mode = declared.expect_variability;

    // Which invocations count. `conditional` hooks are silent by design most of
    // the time, and counting that silence would flag every working guard — so
    // only the times the hook actually said something are applicable.
    const applicable = mode === "always" ? all
      : mode === "conditional" ? all.filter((r) => (r.stdout_bytes ?? 0) > 0)
      : [];

    const window = applicable.slice(-rule.window);
    const distinct = new Set(window.map((r) => r.verdict_hash));

    let verdict;
    let detail;
    if (all.length === 0 && mode === "conditional") {
      // A `conditional` hook's SILENCE is deliberately not recorded — it is
      // outside the applicable set by definition, and writing it on every tool
      // use cost more than the hook itself. An empty history therefore means
      // "never decided anything", which is NOT "never ran" and must not be
      // reported as if it were.
      verdict = "NO-DECISIONS";
      detail = "no recorded decisions — this hook's silence is not logged by design, so this is not evidence it never ran";
    } else if (all.length === 0) {
      verdict = "NEVER-FIRED";
      detail = "registered but never observed running — install the hooks (`bun run vi:install-hooks`) or it is not wired";
    } else if (mode === "never") {
      verdict = "EXEMPT";
      detail = "declared expect_variability: never — rot detection does not apply";
    } else if (window.length < rule.min_samples) {
      verdict = "INSUFFICIENT";
      detail = `${window.length}/${rule.min_samples} applicable sample(s) — not enough history to judge`;
    } else if (distinct.size === 1) {
      verdict = "SUSPECTED-ROTTED";
      detail = `${window.length} applicable invocation(s), all with an identical verdict — this hook may have stopped reading real state`;
    } else {
      verdict = "LIVE";
      detail = `${distinct.size} distinct verdict(s) across ${window.length} applicable invocation(s)`;
    }

    results.push({
      hook_id: declared.hook_id, event: declared.event, expect_variability: mode,
      fired: all.length, applicable: applicable.length,
      distinct_verdicts: distinct.size, verdict, detail,
      last_excerpt: window.length ? (window[window.length - 1].verdict_excerpt ?? null) : null,
    });
  }

  // Drift in the other direction: something fired that nothing declares. A hook
  // with no manifest entry has no expected-variability, so it cannot be judged
  // at all — an unjudgeable hook is a gap, not a pass.
  const declaredIds = new Set((manifest.hooks ?? []).map((h) => h.hook_id));
  const undeclared = [...byHook.keys()].filter((id) => !declaredIds.has(id));

  const report = {
    manifest_version: manifest.version ?? null,
    rot_rule: rule,
    invocations_recorded: invocations.length,
    hooks: results,
    undeclared_hooks: undeclared,
    strength: "REPORTED, never BLOCKING, and never in CI — see this file's header.",
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  console.log(`hook-liveness — ${results.length} declared hook(s), ${invocations.length} invocation(s) recorded`);
  console.log("");
  for (const r of results) {
    console.log(`  ${r.verdict.padEnd(17)} ${r.hook_id.padEnd(24)} ${r.event}`);
    console.log(`  ${" ".repeat(17)} ${r.detail}`);
    if (r.verdict === "SUSPECTED-ROTTED" && r.last_excerpt) {
      console.log(`  ${" ".repeat(17)} unchanging output: ${r.last_excerpt.slice(0, 90)}`);
    }
  }
  if (undeclared.length) {
    console.log("");
    console.log(`  ${undeclared.length} hook(s) fired but are not declared in hook-manifest.json, so nothing can judge them:`);
    for (const id of undeclared) console.log(`    ${id}`);
  }

  console.log("");
  console.log("  Strength: REPORTED, not PREVENTED, and deliberately never BLOCKING. A rot verdict is");
  console.log("  a statistical claim over local invocation history — a hook can legitimately repeat a");
  console.log("  verdict because the repository did not change. It is a lead to investigate, not proof.");
  console.log("  There is no CI job for this on purpose: CI never fires a Claude Code hook, so a CI run");
  console.log("  would read an empty log and report a clean result forever — a check that cannot fail,");
  console.log("  which is the exact defect class this gate exists to catch.");
  console.log("");
  console.log("REPORT-ONLY");
  return 0;
}

process.exitCode = main();
