#!/usr/bin/env node
/**
 * scripts/remedy-coverage-gate.mjs — ADR-113 decision 2/3: the remedy floor.
 *
 * WHAT THIS IS NOT. This is not a generic classifier that reads all 48
 * `gate:*` scripts and decides which ones "have a remedy". A first pass at
 * that (grepping every gate's source for the word "remedy" or a backtick
 * command span) was tried and thrown away: it flagged the large majority of
 * gates as remedy-less, directly contradicting Finding (b)'s own audit
 * ("most gates already state a remedy; a real minority don't") — because
 * "does this failure text read as actionable to a human" is a judgment call,
 * not a mechanical property like "does this markdown file have a heading
 * named Alternatives" (`adr-sections.mjs`'s `ALTERNATIVES_FLOOR`, the shape
 * this gate is asked to mirror). A heuristic that overcounts is worse than
 * an honest curated list: it would fail this gate on gates the ADR's own
 * human audit already cleared, training people to add fake "Remedy:" noise
 * just to satisfy a regex.
 *
 * WHAT THIS IS. `EXEMPT_GATES` below is the curated set Finding (b) named —
 * each entry cites the exact source location and carries a `verify(text)`
 * predicate written against that gate's REAL current source text (the same
 * text `gate-all.mjs`'s `tailOutput` would show verbatim if the gate were
 * running red right now). This is "real gate output" in the sense decision 3
 * requires — grounded in the actual print statements a failure would emit,
 * not a `remedy: true|false` field living in a separate manifest that could
 * drift the instant the printed text changes (the rejected alternative). It
 * differs from a bare self-reported flag in the way that matters: every run
 * of this gate re-reads the cited file and re-checks the predicate, so a
 * stale entry — the source changed shape, or the gate gained a `Remedy:`
 * line — is a reported PROBLEM, not a silently-trusted claim.
 *
 * THE RATCHET (decision 2). `FLOOR = 7`, the counted figure Finding (b)
 * established. This gate fails if `EXEMPT_GATES.length` exceeds the floor —
 * a contributor may not add an eighth remedy-less gate to this list to make
 * room for a new gate; they must either give the new gate a `Remedy:` line
 * (this corpus's convention — see `store-freshness-gate.mjs`'s
 * `printRemedy`/`REMEDY_COMMAND` and `adr-trace.mjs`'s `printRemedy`) or
 * close an existing exempt entry first. The floor may only fall.
 *
 * THE HONEST LIMIT. This gate does NOT catch a brand-new gate that ships
 * with no remedy text and is never added to `EXEMPT_GATES` — it enforces the
 * direction of the KNOWN list, not exhaustive discovery over the other ~41
 * gates Finding (b)'s audit already cleared. Widening coverage to every gate
 * would require either spawning all 48 real gates on a real failure (this
 * repository has no mechanism to force each one red on demand, and doing so
 * would risk exactly the kind of state corruption ADR-078 exists to avoid)
 * or a mechanical detector precise enough not to relitigate the whole
 * corpus — neither exists today. That gap is deliberately left open rather
 * than papered over with a heuristic proven, above, to be wrong.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { enumerateGates } from "./gate-all.mjs";

// `--repo` is a fixture seam only (see `guard:canaries`). `auditRemedyCoverage`
// already took `declaredGates` as a parameter; `loadSource` was the only thing
// that had to be pointed somewhere. Absent the flag, unchanged.
function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}
const REPO_ROOT = argValue("--repo") ? resolvePath(argValue("--repo")) : resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const JSON_OUT = process.argv.includes("--json");

/**
 * Ratchet floor. Lower it only as an entry below is closed (the gate gains a
 * `Remedy:` line and its entry is removed); never raise it to make room for
 * a newly-added remedy-less gate. Set at Finding (b)'s counted figure (7);
 * this gate independently confirms only the subset it can cite exact source
 * text for (see header) — running under the floor is expected and fine, only
 * exceeding it fails.
 */
export const FLOOR = 7;

/**
 * Curated, source-verified remedy-less gates (ADR-113 Finding (b)). Each
 * `verify` predicate is written against the file's CURRENT text, not a
 * memorized description of it — re-read scripts/remedy-coverage-gate.mjs.
 */
export const EXEMPT_GATES = Object.freeze([
  {
    gate: "gate:hook-liveness",
    file: "scripts/hook-liveness-gate.mjs",
    citation: "hook-liveness-gate.mjs:53",
    verify: (text) =>
      /no \.hook-liveness\/hook-manifest\.json; nothing declares what these hooks should do/.test(text) &&
      !/remedy\s*:/i.test(text),
  },
  {
    gate: "gate:liveness",
    file: "scripts/liveness-gate.ts",
    citation: "liveness-gate.ts:60-61",
    verify: (text) =>
      /consumer drift could not be determined — the screen source was unreadable, so nothing is known/.test(text) &&
      !/remedy\s*:/i.test(text),
  },
  {
    gate: "gate:entrypoint-reachability",
    file: "scripts/entrypoint-reachability.mjs",
    citation: "entrypoint-reachability.mjs:284-289",
    verify: (text) =>
      /Do not act on this report until the rule is re-mirrored\./.test(text) &&
      !/remedy\s*:/i.test(text),
  },
  {
    gate: "gate:adr-registry",
    file: "scripts/adr-registry.mjs",
    citation: "adr-registry.mjs:29-34",
    // Every outcome — success or failure — is a bare JSON.stringify of the
    // result; there is no human-formatted path at all, so no "Remedy:" line
    // can exist here by construction.
    verify: (text) =>
      /console\.log\(JSON\.stringify\(result, null, 2\)\)/.test(text) &&
      /console\.error\(JSON\.stringify\(\{ ok: false, error:/.test(text) &&
      !/remedy\s*:/i.test(text),
  },
  {
    gate: "gate:project-registry",
    file: "packages/arbor-mcp/src/project-registry.ts",
    citation: "project-registry.ts:363-378 (formatProjectRegistryReport)",
    verify: (text) =>
      /for \(const f of v\.failures\) lines\.push\(`\s*\[\$\{f\.code\}\] \$\{f\.detail\}`\)/.test(text) &&
      !/remedy\s*:/i.test(text),
  },
]);

/** Read a repo-relative file's text, or null if it no longer exists. */
function loadSource(relPath) {
  const abs = resolvePath(REPO_ROOT, relPath);
  return existsSync(abs) ? readFileSync(abs, "utf-8") : null;
}

/**
 * The audit: re-verify every exempt entry against real, current source text,
 * check the roster hasn't drifted (an exempt gate that no longer exists in
 * package.json is stale), and check the count against the floor.
 */
export function auditRemedyCoverage({ declaredGates = enumerateGates(REPO_ROOT), exempt = EXEMPT_GATES } = {}) {
  const problems = [];
  const staleEntries = [];
  const confirmed = [];

  for (const entry of exempt) {
    if (!declaredGates.includes(entry.gate)) {
      staleEntries.push(entry.gate);
      continue;
    }
    const text = loadSource(entry.file);
    if (text === null) {
      problems.push(`${entry.gate}: exempt entry cites ${entry.file}, which no longer exists — update or remove the entry`);
      continue;
    }
    if (entry.verify(text)) {
      confirmed.push(entry.gate);
    } else {
      problems.push(
        `${entry.gate}: exempt entry at ${entry.citation} no longer matches current source — either the gate ` +
          `gained a remedy (remove the entry and lower FLOOR) or the source changed shape (update the citation/verify predicate)`,
      );
    }
  }

  const overFloor = exempt.length > FLOOR;
  return {
    ok: problems.length === 0 && staleEntries.length === 0 && !overFloor,
    floor: FLOOR,
    exempt_count: exempt.length,
    confirmed_remedy_less: confirmed,
    stale_entries: staleEntries,
    problems,
    over_floor: overFloor,
  };
}

function main() {
  const report = auditRemedyCoverage();

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }

  console.log(
    `gate:remedy-coverage — ${report.exempt_count} gate(s) exempt from carrying a remedy line (floor ${report.floor}, ratchet only)`,
  );
  for (const gate of report.confirmed_remedy_less) {
    console.log(`  EXEMPT  ${gate} — confirmed remedy-less by inspecting its real current source text`);
  }

  if (report.stale_entries.length > 0) {
    console.log(`\n${report.stale_entries.length} exempt entry(ies) name a gate no longer in package.json:`);
    for (const gate of report.stale_entries) console.log(`  ${gate}`);
    console.log("  Remedy: remove the stale entry from EXEMPT_GATES in scripts/remedy-coverage-gate.mjs.");
  }

  if (report.problems.length > 0) {
    console.log(`\n${report.problems.length} problem(s):`);
    for (const problem of report.problems) console.log(`  ${problem}`);
    console.log("  Remedy: re-read the cited source in scripts/remedy-coverage-gate.mjs's EXEMPT_GATES, then");
    console.log("  either update the entry's citation/verify predicate (still remedy-less, text changed shape)");
    console.log("  or remove the entry entirely (it now prints an actionable next step).");
  }

  if (report.over_floor) {
    console.log(
      `\nFAIL — ${report.exempt_count} gate(s) are exempt from the remedy requirement, above the floor of ${report.floor}.`,
    );
    console.log("  Remedy: give the newly-added gate an actionable `Remedy:` line (see store-freshness-gate.mjs's");
    console.log("  printRemedy/REMEDY_COMMAND or adr-trace.mjs's printRemedy for the convention) instead of adding");
    console.log("  it to EXEMPT_GATES, or close an existing exempt entry first — the floor may only fall, never");
    console.log("  rise to make room for a new remedy-less gate.");
  }

  if (report.ok) console.log("\nPASS");
  return report.ok ? 0 : 1;
}

if (resolvePath(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
