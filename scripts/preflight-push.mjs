#!/usr/bin/env node
/**
 * scripts/preflight-push.mjs — run the prepush-tier gate battery LOCALLY,
 * before `git push`, so a push failure is never a surprise.
 *
 *   bun run preflight-push [--candidate <sha>] [--json]
 *
 * WHY THIS EXISTS. `scripts/hooks/pre-push` already runs the full prepush
 * profile on every push — but only AT push time, in a detached snapshot
 * worktree, after a `git worktree add` + `bun install --frozen-lockfile` +
 * `bun run build` an agent cannot see coming. This session's pushes chronically
 * failed on gates invisible at the stop tier (gate:typecheck-tests,
 * gate:store-freshness, gate:vi-reproducible, reachability — see
 * scratchpad/governance-legibility-register.md, "PUSH CHRONIC-FAILURE ROOT
 * CAUSE"): the remote sat ~90 commits behind because nothing surfaced a
 * prepush-tier failure until the push itself refused. This script runs the
 * IDENTICAL battery an agent can invoke deliberately, ahead of the push, so
 * the failure (and its remedy) shows up while there is still time to fix it.
 *
 * WHAT IT ACTUALLY RUNS. `runImmutableBattery({ context: "prepush", candidate
 * })` from scripts/enforcement-control-plane.mjs — the SAME function
 * `bun run enforcement:prepush` (and therefore `scripts/hooks/pre-push`)
 * calls. It creates its own detached immutable snapshot worktree at
 * `candidate` (default HEAD), runs `bun install --frozen-lockfile` + `bun run
 * build` inside it, then executes every gate the prepush profile selects.
 * This is not an approximation of the real battery — it IS the real battery,
 * with one difference: it does not also validate the git remote/branch
 * plumbing scripts/hooks/pre-push checks before invoking it (candidate
 * resolution, tracked-branch identity, remote URL match), since those are
 * about which push is happening, not whether the code is ready to push.
 *
 * COST. A snapshot worktree + frozen install + full build is the same couple
 * of minutes the real pre-push hook costs. There is no fast-path here on
 * purpose — a "preflight" that skips the expensive parts is not preflight,
 * it is a different, weaker check that happens to share a name.
 *
 * OUTPUT. Per-gate PASS/FAIL, with each failing gate's own captured
 * output tailed underneath it — every gate in this repository already prints
 * its own exact remedy on failure (store-freshness-gate.mjs's `printRemedy`,
 * completion-depth.mjs's triage instructions, etc.), so this script does not
 * re-derive or duplicate remedy text; it surfaces the gate's own.
 */

import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { GREEN_GATE_STATUSES, runImmutableBattery } from "./enforcement-control-plane.mjs";

function flagValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

// The control plane owns this set: a gate reporting `unresolved` (it observed
// nothing on an input the profile declares non-empty) must not read as a pass here
// any more than it does in the blocking decision.
const PASSING_STATUSES = new Set(GREEN_GATE_STATUSES);

/** Stable human projection of the exact waves consumed by executeGateDag. */
export function formatExecutionPlan(plan) {
  const lines = [`gate execution plan (${plan.context}; reader width ${plan.max_readers})`];
  for (const wave of plan.waves ?? []) {
    lines.push(`  wave ${String(wave.wave).padStart(2, "0")} [${wave.mutability}] ${wave.gates.join(", ")}`);
  }
  return lines;
}

/** True when `report.status` names a failure that happened before any gate ran at all. */
function isSetupFailure(report) {
  return ["snapshot_setup_failed", "roster_invalid", "registry_outside_candidate"].includes(report.status);
}

/** Pure formatting of a completed (or setup-failed) battery report into printable lines. Testable without running any gate. */
export function formatReport(report) {
  const lines = [];
  if (isSetupFailure(report)) {
    lines.push(`FAIL — could not even prepare the candidate: ${report.status}`);
    if (report.detail) lines.push(report.detail);
    for (const problem of report.roster_problems ?? []) lines.push(`  - ${problem}`);
    return { lines, ok: false };
  }

  lines.push(`preflight-push — prepush-tier battery against candidate ${(report.candidate_oid ?? "?").slice(0, 12)}`);
  lines.push("");
  if (report.execution_plan) {
    lines.push(...formatExecutionPlan(report.execution_plan));
    lines.push("");
  }
  const failing = [];
  for (const gate of report.gates ?? []) {
    const passing = PASSING_STATUSES.has(gate.status);
    lines.push(`  ${passing ? "ok  " : "FAIL"} ${gate.gate}${passing ? "" : ` (${gate.status})`}`);
    if (!passing) {
      failing.push(gate.gate);
      const raw = (gate.output || gate.error || "(no output captured)").toString().trim();
      const tail = raw.split("\n").slice(-25).join("\n");
      for (const line of tail.split("\n")) lines.push(`         ${line}`);
      lines.push("");
    }
  }
  lines.push("");
  if (report.ok) {
    lines.push("PASS — safe to push.");
  } else {
    lines.push(
      `FAIL — ${failing.length} gate(s) would block \`git push\`: ${failing.join(", ")}. Fix the remedy printed above ` +
        "for each, then re-run `bun run preflight-push`.",
    );
    if (report.status === "identity_mismatch") {
      lines.push("(status: identity_mismatch — a gate mutated the candidate snapshot's tracked inputs while running; re-run.)");
    }
  }
  return { lines, ok: !!report.ok };
}

async function main() {
  const jsonOut = process.argv.includes("--json");
  const candidate = flagValue("--candidate", "HEAD");

  if (!jsonOut) {
    console.error(`preflight-push — running the real prepush-tier battery against candidate ${candidate}...`);
    console.error("  (a fresh detached snapshot worktree, `bun install --frozen-lockfile`, `bun run build`, then every prepush gate —");
    console.error("   this is the identical battery `git push` runs, so it costs the same couple of minutes.)");
    console.error("");
  }

  const report = await runImmutableBattery({ context: "prepush", candidate });

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }

  const { lines, ok } = formatReport(report);
  for (const line of lines) console.log(line);
  return ok ? 0 : 1;
}

// Mirrors the guard convention used elsewhere in scripts/ (e.g.
// entrypoint-reachability.mjs, completion-depth.mjs): importing this module
// for its exports (formatReport, in tests) must never run the CLI body.
if (process.argv[1] && resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
