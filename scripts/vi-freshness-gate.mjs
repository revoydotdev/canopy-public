#!/usr/bin/env node
/**
 * scripts/vi-freshness-gate.mjs — bound how stale the last local graph build may be.
 *
 * THE PROBLEM THIS SOLVES, and the one it deliberately does not.
 *
 * `.visual-intelligence/graph/` (nodes/edges/evidence, ~28MB) is gitignored
 * and never committed — proven to be a pure, deterministic function of
 * committed source, so a fresh clone/worktree regenerates it byte-identically
 * on demand rather than paying git history's storage cost for something with
 * no historical governance value (see `gate:vi-reproducible`). What IS
 * committed is `.visual-intelligence/manifest.json`: small, metadata-only.
 * Committed generated artifacts go stale, and this manifest's declared
 * revision had drifted seven commits and two packages behind before anything
 * said so in a way that mattered — the problem this gate exists for is
 * unchanged by moving the large bytes out of git history. A SessionStart hook
 * did report `DIVERGED`, every session, and was read and moved past — the
 * same shape as POL-04 firing 29 times against an unwitnessed ADR corpus and
 * never once being acted on. A signal nothing blocks on is a signal that gets
 * skimmed.
 *
 * WHY THIS IS A BUDGET AND NOT AN EQUALITY CHECK. The obvious gate is
 * "regenerate and require byte-equality with HEAD". That is a stronger claim
 * and the wrong mechanism here, for two independent reasons:
 *
 *   1. It would require every feature branch touching `packages/*` to
 *      regenerate a 17MB `edges.jsonl`. This repository routinely runs three
 *      parallel agent lanes; three regenerated 17MB JSONL files merging into
 *      one branch is a conflict nobody resolves by hand. The artifact must
 *      have ONE writer — the same conclusion ADR-029 reached for persistence
 *      directories and ADR-027 reached for the governance ledger, both of
 *      which serialise writes rather than trying to merge them.
 *
 *   2. Regeneration needs the upstream extractor, which is a skill install and
 *      not a repository dependency. A gate that cannot run in CI is not a gate.
 *
 * So this measures DISTANCE, using git, the manifest, AND the graph bytes
 * where they exist, and runs anywhere. It answers "how far behind is the
 * graph, does the committed manifest describe the bytes beside it, and is every
 * reachability edge labelled honestly", not "is the graph exactly right". It is
 * honest about being the weaker check: see the strength note printed on every
 * run.
 *
 * WHAT IT REFUSES TO ACCEPT AS PASSING:
 *   - a manifest whose revision is not an ancestor of HEAD (the graph
 *     describes a branch that was never merged, or a tree that never existed —
 *     distance is undefined, not zero)
 *   - `tree_state: "dirty"` (the graph describes a working tree no commit has,
 *     so its revision is a claim nothing can check)
 *   - no declared entry-point root set, or ANY recorded `extraction_gaps`
 *     entry (a graph with no reachability edges is the exact silent
 *     degradation `vi-refresh` exists to prevent). Both are read from fields
 *     the extractor actually writes — see the note at the check itself for the
 *     earlier version of this that read a key no manifest ever had.
 *   - `manifest.counts` that do not match the line counts of the graph files
 *     beside them. This is CD-BR-04 and it is why this gate reads BYTES.
 *   - `CD-BR-04` / `CD-CD-02`: reachability edges whose `evidence_type` claims
 *     AST-call evidence, or whose `confidence` claims "high". Those labels live
 *     in the graph BYTES, not in the manifest, which is why this check reads
 *     `graph/edges.jsonl` when it is present — see `checkReachabilityLabelling`.
 *
 * WHY IT NOW READS THE GRAPH FILES (CD-BR-04). Until this revision the gate
 * read `manifest.json` and nothing else. A gate that reads a summary of a
 * thing rather than the thing can only ever assert that the summary is
 * internally well-formed — never that it matches reality. So the exact defect
 * this gate exists to catch, a manifest whose `counts` describe a graph
 * generation other than the one on disk, was structurally invisible to it: the
 * gate consumed those counts to reason and had no way to check them. The
 * disagreement is real and is on all three artifacts — the committed manifest
 * records nodes 36,132 / edges 110,106 / evidence 48,117 while the graph beside
 * it held 35,816 / 133,087 / 47,955, and the edges gap is NEGATIVE, so this is
 * not one artifact drifting in one direction: these are two generations.
 *
 * `graph/` being gitignored is not a reason to skip this. The bytes are on
 * disk in every checkout that has run `vi:refresh`, which is every checkout
 * whose graph anyone is reading; they are merely not in git. When there is no
 * graph at all every byte-reading check here says NOT OBSERVED in those words
 * and does not claim agreement — an absent observation is a distinct state from
 * an observation that found nothing, and conflating the two is how this
 * repository's gates have gone green six times already.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hasRegenerationMarker, regenerationMarkerPath } from "./lib/store-provenance.mjs";
import { validateEvidenceSnapshotBinding } from "./evidence-transaction.mjs";
import { profileOrDefaults } from "./lib/project-profile.mjs";
import { computeViInputBinding } from "./lib/vi-input-binding.mjs";
import { compareManifestCountsToGraphBytes } from "./lib/vi-manifest-counts.mjs";
import { checkReachabilityLabelling, reportReachabilityLabelling } from "./lib/vi-reachability-labelling.mjs";

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

const REPO_ROOT = resolve(argValue(process.argv, "--repo") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const MANIFEST = join(REPO_ROOT, ".visual-intelligence", "manifest.json");
const GRAPH_DIR = join(REPO_ROOT, ".visual-intelligence", "graph");
const GRAPH_EDGES = join(GRAPH_DIR, "edges.jsonl");

/**
 * How many commits the graph may lag HEAD before this fails.
 *
 * Ratchet DOWN as automation improves, never up to accommodate neglect. A
 * budget rather than zero because the graph has one writer by design, so it
 * legitimately trails by however many commits land between refreshes.
 */
const ADVISORY_COMMITS_BEHIND = 25;

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT }).toString().trim();
}

// `CD-BR-04` / `CD-CD-02` — the reachability labelling check — now lives in
// `lib/vi-reachability-labelling.mjs`, alongside the counts check in
// `lib/vi-manifest-counts.mjs`. Extracted for the same reason and by the same
// route: this module ends in `process.exit(main())` at module scope, so a test
// cannot import it to exercise a check in isolation, and the only prior evidence
// that the labelling check could fire was a worker's manual sandbox mutation.
function main() {
  if (hasRegenerationMarker(REPO_ROOT)) {
    console.error(
      `vi-freshness gate — FAIL: evidence regeneration transaction marker exists at ${regenerationMarkerPath(REPO_ROOT)}; ` +
      "complete or explicitly recover the interrupted transaction before trusting the graph",
    );
    return 1;
  }
  if (!existsSync(MANIFEST)) {
    console.error("vi-freshness gate — FAIL: no .visual-intelligence/manifest.json; the graph has never been built");
    return 1;
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  } catch (error) {
    console.error(`vi-freshness gate — FAIL: manifest is unparseable: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const graphRev = manifest.repo_revision;
  const head = git(["rev-parse", "HEAD"]);
  const failures = [];

  console.log("vi-freshness gate — how far the last local graph build trails HEAD");
  console.log(`  graph revision: ${String(graphRev).slice(0, 12)}`);
  console.log(`  HEAD:           ${head.slice(0, 12)}`);

  let behind = null;
  let known = false;
  try {
    git(["cat-file", "-e", `${graphRev}^{commit}`]);
    known = true;
  } catch {
    failures.push(`graph revision ${String(graphRev).slice(0, 12)} is not a commit in this repository`);
  }

  if (known) {
    let ancestor = false;
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", graphRev, head], { cwd: REPO_ROOT });
      ancestor = true;
    } catch {
      ancestor = false;
    }
    if (!ancestor) {
      // Distance is undefined here, not large. A graph built on an abandoned
      // branch describes a tree that is not in this history at all.
      failures.push(
        `graph revision is not an ancestor of HEAD — it describes a tree not in this history ` +
        `(built on an unmerged branch, or rebased away)`,
      );
    } else {
      behind = Number.parseInt(git(["rev-list", "--count", `${graphRev}..${head}`]), 10);
      console.log(`  commits behind: ${behind} (advisory threshold ${ADVISORY_COMMITS_BEHIND})`);
      if (behind > ADVISORY_COMMITS_BEHIND) {
        console.log(`  ADVISORY: graph provenance is ${behind} commits behind HEAD; exact input identity below remains authoritative.`);
      }
    }
  }

  if (manifest.tree_state === "dirty") {
    // The ordinary dirty-tree rejection remains the default. The only narrow
    // exception is a committed transaction binding whose source-tree digest
    // still matches this checkout and whose base candidate is reachable.
    const snapshot = validateEvidenceSnapshotBinding(REPO_ROOT);
    if (!snapshot.ok || snapshot.binding?.candidate_oid !== graphRev) {
      failures.push(
        "graph was built from a dirty working tree without a matching immutable evidence-transaction snapshot — " +
        "its recorded revision describes a state no commit has, so the distance above is not checkable",
      );
    } else {
      console.log(`  transaction snapshot: ${snapshot.binding.transaction_id} binds the same non-evidence source digest`);
    }
  }

  // THIS CHECK USED TO BE VACUOUS. It read
  //   `manifest.planes?.derived?.reachability ?? manifest.reachability`
  // and neither key exists in any manifest the extractor can produce: the
  // extractor's `reachability` field lives on its `summary` object, which is
  // printed to stdout and never written into manifest.json. The expression was
  // always `undefined`, the `=== "unavailable"` test never fired, and every run
  // printed "…and is not degraded" on the strength of a check that could not
  // fail. A safeguard that is documented but not wired is worse than none.
  //
  // The signals the extractor DOES write are these two, and both are checked.
  const entrypoints = manifest.entrypoints ?? {};
  const roots = Array.isArray(entrypoints.roots) ? entrypoints.roots : [];
  if (entrypoints.source !== "declared" || roots.length === 0) {
    failures.push(
      `graph declares no entry-point root set (entrypoints.source=${JSON.stringify(entrypoints.source ?? null)}, ` +
      `roots=${roots.length}) — it was built without the canonical root set, which silently drops ` +
      "every reachability edge (`bun run vi:refresh` passes it correctly)",
    );
  }
  // CD-BR-03, second half. This used to be
  //   `.find((g) => g?.scope === "reachability")`
  // which honours exactly one of the scopes the schema permits and silently
  // ignores every other. A manifest is therefore free to record a gap naming
  // the failure this gate most needs to hear about — the counts describing a
  // different graph generation — and this gate would print nothing at all.
  // `extraction_gaps` is documented as "every part of the repository this run
  // could not analyze. Never omit — silence reads as coverage." A gate that
  // reads one entry out of that list and drops the rest reproduces that silence.
  // Every recorded gap now fails, whatever its scope. (todo18's
  // reachability-scoped `.find(...)` is a strict subset of this loop, so the
  // union keeps the stronger form and loses no check.)
  for (const gap of manifest.extraction_gaps ?? []) {
    const scope = gap?.scope ?? "unstated";
    const reason = gap?.reason ?? "unstated";
    // The cause and the remedy, not the manifest's own essay: gate rule 1 in
    // scripts/README.md. The full `detail` stays in the manifest for whoever
    // reads it there.
    failures.push(
      `graph records an extraction gap (scope: ${scope}, reason: ${reason}) — ` +
      `resolve with: ${gap?.resolves_with ?? `declare how the ${scope} gap is resolved`} ` +
      `(full detail in .visual-intelligence/manifest.json extraction_gaps[].detail)`,
    );
  }

  // CD-BR-04 / CD-CD-02 — the FIRST byte-reading check, and the only one the
  // manifest cannot contribute to at all: labels are not metadata, they are
  // payload. Runs before the counts check below.
  reportReachabilityLabelling(checkReachabilityLabelling(GRAPH_EDGES), failures);

  const expectedBinding = computeViInputBinding(REPO_ROOT, { profile: profileOrDefaults(REPO_ROOT), toolRoot: REPO_ROOT });
  if (!manifest.input_binding) {
    failures.push("graph has no input_binding; run `bun run vi:refresh` to bind the generated plane to exact producer inputs");
  } else if (manifest.input_binding.content_hash !== expectedBinding.content_hash
    || manifest.input_binding.paths_digest !== expectedBinding.paths_digest
    || manifest.input_binding.path_count !== expectedBinding.path_count) {
    failures.push(
      `graph input binding differs from current producer inputs ` +
      `(recorded ${manifest.input_binding.content_hash ?? "absent"}, current ${expectedBinding.content_hash}) — run \`bun run vi:refresh\``,
    );
  } else {
    console.log(`  exact input binding: ${expectedBinding.content_hash} (${expectedBinding.path_count} paths)`);
  }

  // CD-BR-04 — the counts-vs-bytes check. Everything above reasons FROM
  // `manifest.counts`; nothing above could notice that those counts describe a
  // graph that is not the one on disk. This check opens the graph files, and it
  // is the one the "two generations" defect was invisible to.
  const bytes = compareManifestCountsToGraphBytes(manifest, GRAPH_DIR);
  console.log("  counts vs graph bytes:");
  for (const a of bytes.artifacts) {
    const disk = a.onDisk === null ? `${a.file} unreadable` : String(a.onDisk);
    console.log(
      `    ${a.name}: manifest ${a.recorded ?? "absent"} (from manifest.counts) vs ` +
      `disk ${disk} (line count of graph/${a.file})` +
      (a.delta === null || a.delta === 0 ? "" : ` — delta ${a.delta > 0 ? "+" : ""}${a.delta}`),
    );
  }
  if (bytes.state === "agreed") {
    console.log("    compared and agreed: manifest.counts describes the graph on disk");
  } else if (bytes.state === "not_observed") {
    // The count sources in this repository are NOT interchangeable, and the
    // reader of this line is exactly the reader the plan says has been bitten
    // by that. Name it: nothing was compared.
    console.log(
      `    NOT OBSERVED: ${bytes.reason}. manifest.counts is therefore UNVERIFIED — it states what the\n` +
      "    run that wrote it produced, and nothing here confirms the files beside it agree. This is\n" +
      "    an absence of observation, not an observation of agreement.",
    );
  } else if (bytes.state === "incomplete") {
    failures.push(`${bytes.reason} — restore the full graph with \`bun run vi:refresh\``);
  } else {
    const detail = bytes.artifacts
      .filter((a) => a.delta !== 0)
      .map((a) => `${a.name} manifest ${a.recorded} vs disk ${a.onDisk} (delta ${a.delta})`)
      .join("; ");
    failures.push(
      `manifest.counts do not describe the graph on disk — ${detail}. ` +
      "These cannot come from one run: writeJsonl returns the count it wrote and that value becomes " +
      "`counts`, so a single run's counts and files always agree. Fix with: `bun run vi:refresh` in a " +
      `clean worktree at ${String(graphRev).slice(0, 12)}, then commit the regenerated manifest.json in the same commit`,
    );
  }

  // CD-BR-02. `history.first_seen_carried` and `history.unchanged_since_prior`
  // are incremented inside one loop over the same prior records, so they
  // overlap and MUST NOT be summed. The manifest now records the overlap; if
  // it does not, say so rather than let a reader assume the counters partition
  // the record set.
  const history = manifest.history ?? {};
  if (history.basis === "carried_forward") {
    const overlap = history.overlap;
    const counted =
      overlap && typeof overlap === "object"
        ? Object.entries(overlap).filter(([, v]) => Number.isFinite(v))
        : [];
    if (counted.length > 0) {
      console.log(
        `  history counters overlap and are NOT disjoint: ` +
        counted.map(([k, v]) => `${k} ${v}`).join(", ") +
        ` — never sum first_seen_carried with unchanged_since_prior` +
        (history.overlap_basis?._kind ? ` (recorded as: ${history.overlap_basis._kind})` : ""),
      );
    } else {
      console.log(
        "  NOTE: manifest records no overlap for first_seen_carried / unchanged_since_prior. They " +
        "are incremented over the same record set and are not disjoint, so the overlap is UNKNOWN here " +
        "and the two must not be summed.",
      );
    }
  }

  // `history.basis` distinguishes a graph whose provenance is real from one that
  // was rebuilt from scratch and therefore states no history at all. Not a
  // failure — a rebuild is legitimate — but it must not pass silently, because
  // every `first_seen` in such a graph is the rebuild revision, not history.
  if (manifest.history?.basis === "rebuilt_from_scratch") {
    console.log(
      "  NOTE: graph was rebuilt from scratch — every first_seen equals its build revision and " +
      "states no history. This is legitimate; it is not evidence that 8,000 records are new.",
    );
  }

  console.log("");
  console.log(
    "  Strength: BLOCKING exact input identity, plus TWO BLOCKING byte-level agreements — " +
    "manifest.counts against the graph files on disk, and the labelling of every reachable_from " +
    "edge against the two labels an inference may not carry. The first proves the committed manifest " +
    "describes the graph beside it rather than some other generation; the second proves a consumer " +
    "parsing edges.jsonl cannot read an inferred edge as compiler-grade AST evidence (CD-CD-02). " +
    "gate:vi-reproducible/gate:vi-prepush-policy separately regenerate and verify the graph builds " +
    "cleanly from those inputs. Commit distance is advisory only. When no graph is on disk neither " +
    "byte check passes: the counts comparison says NOT OBSERVED and the reachability labelling says " +
    "NOT CHECKED, each in its own words, and neither is an assumed agreement.",
  );
  console.log("");

  if (failures.length === 0) {
    console.log("PASS");
    return 0;
  }
  for (const failure of failures) console.log(`FAIL — ${failure}`);
  return 1;
}

process.exit(main());
