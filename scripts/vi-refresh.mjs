#!/usr/bin/env node
/**
 * scripts/vi-refresh.mjs — the one standardized way to refresh the graph.
 *
 * WHY THIS EXISTS. Refreshing `.visual-intelligence/` was tribal knowledge
 * spread across a SKILL.md, and every part of that knowledge was individually
 * easy to get wrong in a way that produces a plausible-looking but *worse*
 * graph, silently:
 *
 *   1. THE MISSING ROOT SET. The committed graph's manifest records the
 *      extractor invocation as `vi-extract-ts --root . --include ...` — with no
 *      `--entrypoints`. Run exactly that and the extractor prints one warning
 *      line, emits ZERO reachability edges, and writes `reachability:
 *      unavailable` into the manifest. The graph still looks fine. This is why
 *      the graph went stale and stayed stale: refreshing it *degraded* it, so
 *      the safest thing anyone could do was leave it alone.
 *
 *      The committed graph declares four roots sourced from
 *      `.visual-intelligence/entry-points.json` — a file that is not in the
 *      repository and never was. The committed artifact was therefore not
 *      reproducible from committed inputs.
 *
 *      Fixed here by pointing the extractor at `scripts/reachability/
 *      entry-points.json`: the repository's canonical 6.2 root set, which the
 *      extractor already accepts verbatim (`{entryPoints: [{file, symbol}]}`).
 *      One source of truth for "where execution begins", not two.
 *
 *   2. THE DROPPED PLANE. `vi-extract-ts` establishes the `derived` plane and
 *      nothing else. Running it alone silently discards the `intended` plane
 *      that `extract-intent` builds from the ADR corpus — and a graph with one
 *      plane can inventory, but cannot detect drift, which is the entire point
 *      of having it. The waiver store likewise has to be re-ingested or every
 *      dated exception vanishes from the graph.
 *
 *   3. THE DROPPED VERIFICATION. Extraction is three steps; a refresh is six.
 *      This script used to stop after extraction while README.md and SKILL.md
 *      both documented four more — cross-check, validate, emit findings, render.
 *      The result: CI gated how far the graph trailed HEAD and nothing ever
 *      checked whether it was internally valid, `findings/` stayed empty while
 *      the query pack reported 457 ungoverned artifacts every run, and the
 *      rendered views on disk described an older graph than the committed one.
 *      Two competing definitions of "refresh" existed, one of them in the file
 *      that calls itself the standardized way to do it.
 *
 * So: six steps, in this order, or the result is not the artifact this
 * repository reviews. That ordering is now executable rather than described.
 *
 * WHAT THIS DOES NOT DO. It does not commit anything — the graph
 * (`.visual-intelligence/graph/`) is gitignored and purely local/regenerable,
 * never tracked. That was a deliberate reversal of this script's original
 * design, which committed a 28MB artifact specifically so CI could diff it:
 * concurrent regeneration on parallel branches produced textual conflicts in
 * a 17MB `edges.jsonl` nobody could resolve by hand, on a file proven to be a
 * pure, deterministic function of committed source (two clean serialized
 * runs against the same revision reproduce byte-identically — see
 * `gate:vi-reproducible`/`gate:vi-prepush-policy`, which verify exactly that
 * on every run). Gitignoring it removes the merge-conflict problem at its
 * root instead of coordinating around it. `.visual-intelligence/manifest.json`
 * (small, metadata-only) still IS committed — see `gate:vi-freshness`, which
 * reads only that file and never the graph bytes themselves.
 *
 * WHAT --force DOES. Forwarded to step 1 (vi-extract-ts) only. vi-extract-ts
 * refuses to overwrite a graph built with a different scope/config unless
 * told to — the guard that stops a mistaken `--include` from silently
 * discarding a graph built with a wider one. That guard also fires on a
 * legitimate committed config change (e.g. `scripts/reachability/
 * entry-points.json` growing a root), and without a way to pass `--force`
 * through, the standard path just died with vi-extract-ts's raw
 * execFileSync exit rather than the operator ever seeing its own "either
 * --out a different directory or --force" message. `--check` and `--force`
 * together are rejected: a check exists to prove reproducibility without
 * writing anything, and `--force` is a deliberate overwrite — the two
 * cannot both be true of the same run.
 *
 * THE --root SEAM (Roadmap 23 B2, ADR-073's named follow-up, the last of the
 * eight scripts) — NOW CLOSED. `--root <path>` (default: this checkout,
 * byte-identical to prior behavior) names the project the WHOLE six-step
 * pipeline analyzes: step 1 (vi-extract-ts) and step 4 (verify-against-gate)
 * already accepted `--root`; steps 2/3 (`scripts/vi-emit.ts`) and steps
 * 5.5/5.6 (`scripts/vi-findings.mjs`, `scripts/vi-observed-compare.mjs`) are
 * now forwarded `--root root` / the `REVOY2_VI_GRAPH_DIR` /
 * `REVOY2_VI_FINDINGS_DIR` / `REVOY2_VI_OBSERVED_DIR` env seam respectively.
 * `INCLUDE` is composed from `profileOrDefaults(root).source_roots` rather
 * than a hardcoded `packages/*` literal — for revoy2's own profile
 * (`source_roots: ["packages"]`) this composes back to the exact prior
 * string. This file used to stop after step 1 + the entry-points guard for
 * any foreign `root`, because `vi-emit.ts` computed its own `REPO_ROOT` from
 * its module location with NO override of any kind — feeding it a foreign
 * `root`'s derived plane would have silently merged this repo's `decisions/`
 * ADR corpus into another project's graph (the §5 failure mode). vi-emit.ts
 * now derives its decisions corpus, waiver input, id namespace, and output
 * paths from the SAME `root` this file resolves — see its own header for
 * exactly what changed. The two narrower limitations that remained after
 * that migration (`governance.decisions_dir` and the allowlist path were
 * hardcoded inside `@arbor/governance` itself) are now closed: `vi/intent.ts`,
 * `vi/exceptions.ts`, `vi/baseline.ts`, and `counts/derive.ts` all accept
 * both as options, defaulting to revoy2's own conventional values.
 *
 * A REMAINING, UNCLOSED BOUNDARY: step 4 (`verify-against-gate.mjs`, owned
 * by `.claude/skills/revoy2-visual-intelligence/scripts/`, outside this
 * migration's file ownership) already accepts `--root` and delegates to
 * `<root>/scripts/reachability.mjs --json` — genuinely portable to any
 * project that supplies its OWN conforming reachability gate at that path
 * (the cross-check is "does root's own gate agree with root's own derived
 * plane", never revoy2's gate against a foreign graph). A `root` with no
 * such script fails step 4 honestly with `verify-against-gate.mjs`'s own
 * "could not run the repository's reachability gate" message, exactly as it
 * would for any project genuinely missing that gate — this is a project
 * onboarding requirement, not a hardcoded-to-revoy2 defect, so it is not
 * something this pass papers over with a synthetic stop.
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { DEFAULT_PROFILE, profileOrDefaults } from "./lib/project-profile.mjs";
import { computeViInputBinding, targetInput, toolInput } from "./lib/vi-input-binding.mjs";
import { assertEvidenceProducerAuthority } from "./evidence-transaction.mjs";

const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));

/**
 * `--root <path>` (or `--root=<path>`) / absent → `fallback`. Same contract
 * as `scripts/project-conform.mjs`'s `resolveRootArg`: `--root` given no
 * value (or immediately followed by another flag) is a usage error, never a
 * silent fallback to this checkout — the dangerous direction, per Roadmap 23
 * §5, is an operator asking for another project and silently getting a
 * verdict about revoy2 instead.
 */
export function resolveRootArg(argv, fallback = REPO_ROOT) {
  const inline = argv.find((a) => a.startsWith("--root="));
  if (inline !== undefined) {
    const value = inline.slice("--root=".length);
    if (value === "") throw new Error("--root requires a path");
    return resolve(value);
  }
  const index = argv.indexOf("--root");
  if (index === -1) return resolve(fallback);
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error("--root requires a path");
  return resolve(value);
}

/**
 * The generic TypeScript adapter, vendored into this repository (ADR-031, MIT).
 *
 * It previously resolved out of `~/.claude/skills/`, which made refreshing a
 * property of one machine rather than of the repository: CI could not
 * regenerate, a fresh clone could not refresh, and the committed graph's
 * reproducibility could not be checked by anything. The skill now lives in
 * the repository as first-party source (ADR-031, superseded by ADR-176): a
 * verification tool the verifier does not have is not a verification tool.
 *
 * Anchored to THIS checkout (not `root`) deliberately: the vendored tooling
 * lives with the script that invokes it, regardless of which project's tree
 * `root` names.
 */
const SKILL_DIR = join(REPO_ROOT, ".claude/skills/repository-visual-intelligence/scripts");

const PROJECT_SCRIPTS = join(REPO_ROOT, ".claude/skills/revoy2-visual-intelligence/scripts");

/**
 * The canonical 6.2 root set's location, relative to whichever `root` is
 * being analyzed. Shared with `gate:reachability` — never duplicated. There
 * is no `arbor.profile.jsonc` field naming this path (the schema covers
 * `source_roots` and `governance`, not a reachability-entrypoints seam), so
 * — honestly, not by omission — this stays a literal convention name rather
 * than a profile-derived one.
 */
const ENTRY_POINTS = "scripts/reachability/entry-points.json";

/**
 * The scope the committed manifest declares, now composed from
 * `profileOrDefaults(root).source_roots` instead of a hardcoded `packages/*`
 * literal. For revoy2's own profile (`source_roots: ["packages"]`, the same
 * value `DEFAULT_PROFILE` supplies with no profile file present) this
 * composes back to the exact prior string, byte for byte.
 */
function deriveInclude(sourceRoots) {
  return sourceRoots.map((r) => `${r}/*/src/**,${r}/*/tests/**`).join(",");
}

/** The module-level default, used only by `verifyEntryPointsMaterialized`'s
 * own default parameter — derived from `DEFAULT_PROFILE`, not re-hardcoded. */
const INCLUDE = deriveInclude(DEFAULT_PROFILE.source_roots);

function run(label, file, args, quiet, override) {
  if (!quiet) process.stdout.write(`\n[vi-refresh] ${label}\n`);
  const command = override?.command ?? "node";
  const argv = override?.args ?? [file, ...args];
  const env = override?.env ? { ...process.env, ...override.env } : process.env;
  execFileSync(command, argv, { cwd: REPO_ROOT, stdio: quiet ? "pipe" : "inherit", env });
}

/**
 * Fields every extractor stamps with the repository revision.
 *
 * These make a raw byte comparison useless: regenerate one commit later and
 * every one of 8000+ records changes, so `--check` would report DIFFERS
 * permanently and mean nothing. Stripping them compares what the graph
 * actually asserts — which nodes, which edges, which evidence — rather than
 * when it was asserted. That is the comparison that catches the defect this
 * check exists for: an entry-point set silently dropping every reachability
 * edge changes structure, not provenance.
 */
const REVISION_STAMPED = new Set(["first_seen", "last_verified", "established_at_revision"]);

/**
 * A structural digest per graph file: each record with provenance stamps
 * removed, key-sorted for stability, then hashed as a sorted multiset so
 * record ORDER cannot masquerade as a semantic change either.
 */
function graphDigest(dir) {
  const out = {};
  for (const name of ["nodes.jsonl", "edges.jsonl", "evidence.jsonl"]) {
    const file = join(dir, name);
    if (!existsSync(file)) { out[name] = null; continue; }
    const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim().length > 0);
    const normalized = lines.map((line) => {
      const record = JSON.parse(line);
      for (const field of REVISION_STAMPED) delete record[field];
      return JSON.stringify(record, Object.keys(record).sort());
    }).sort();
    out[name] = createHash("sha256").update(normalized.join("\n")).digest("hex");
  }
  return out;
}

/**
 * GUARD — a declared entry point that silently fails to become a root must
 * stop the refresh, not degrade it quietly.
 *
 * Confirmed by direct code read (2026-08-15), vi-extract-ts.mjs:748-765
 * (vendored, ADR-031 — not editable from this file): for each entry in
 * `scripts/reachability/entry-points.json`, the extractor resolves `ep.file`
 * against its own in-scope file index. If that file was not picked up by
 * `--include`, or the path is stale/misspelled, the extractor does this and
 * nothing else:
 *
 *     if (!fid) { log(`  entrypoint not found in scope: ${relp}`); continue; }
 *
 * `log()` only prints when the CLI is run in verbose mode — `vi-refresh.mjs`
 * invokes it quiet by default (see `run()`'s `stdio: quiet ? "pipe" : ...`
 * — step 1 runs non-quiet, so today the line reaches stdout, but nothing
 * downstream reads it, parses it, or fails on it. A future `--quiet` default,
 * a log-line wording change, or a human skimming a long refresh transcript
 * all independently make this silent. The declared root set is reachability's
 * (6.2) entire definition (`entry-points.json`'s own `$schemaNote`) — losing
 * a root without a hard failure means every symbol/file reachable ONLY from
 * that root is subsequently reported "unreachable from any entrypoint" by
 * the `unreachable-production` / `isolated-components` findings, though it
 * never was. That is a false positive by construction, not a real finding,
 * and it is exactly the shape this guard exists to make loud.
 *
 * The check itself stays entirely OUTSIDE the vendored extractor: it re-reads
 * the same `entry-points.json` this refresh just fed to vi-extract-ts, then
 * cross-checks every declared entry's file (and symbol, when declared)
 * against `.visual-intelligence/manifest.json`'s `entrypoints.roots` — the
 * array vi-extract-ts itself writes from its internal `roots` list
 * (vi-extract-ts.mjs:940-942). A mismatch here is proof positive that a root
 * was dropped, independent of any vendored internals changing later.
 *
 * Parametrized over `repoRoot`/`entryPointsRelPath`/`includeGlob` (each
 * defaulting to this module's own constants) purely so
 * `scripts/tests/vi-refresh-entrypoints-guard.test.mjs` can point it at a
 * fixture tree without needing to fake this repository's whole package
 * layout — the logic exercised is identical either way.
 */
export function verifyEntryPointsMaterialized(
  repoRoot = REPO_ROOT,
  entryPointsRelPath = ENTRY_POINTS,
  includeGlob = INCLUDE,
) {
  const declaredRaw = JSON.parse(readFileSync(join(repoRoot, entryPointsRelPath), "utf8"));
  const declared = Array.isArray(declaredRaw)
    ? declaredRaw
    : declaredRaw.entryPoints ?? declaredRaw.entry_points ?? [];
  const manifestPath = join(repoRoot, ".visual-intelligence", "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const roots = new Set(manifest.entrypoints?.roots ?? []);

  const missing = [];
  for (const ep of declared) {
    const relp = ep.file ?? ep.path;
    if (!relp) continue; // entry-points.json entries without a file are not this guard's concern
    const fileRoot = `file:${relp}`;
    if (!roots.has(fileRoot)) {
      missing.push(
        `${ep.id ?? relp} — declared file root "${fileRoot}" is absent from ` +
        `manifest.entrypoints.roots (vi-extract-ts logs this as "entrypoint not found ` +
        `in scope" — check the path is correct and covered by --include "${includeGlob}")`,
      );
      continue;
    }
    if (ep.symbol) {
      const symbolSuffix = `::${relp}::${ep.symbol}`;
      const hasSymbolRoot = [...roots].some((r) => r.startsWith("sym:") && r.endsWith(symbolSuffix));
      if (!hasSymbolRoot) {
        missing.push(
          `${ep.id ?? relp} — declared symbol "${ep.symbol}" in ${relp} has no matching ` +
          `sym: root (the file root materialized, but the named export was not found — ` +
          `reachability degraded from that symbol to file-only for this entry)`,
        );
      }
    }
  }

  if (missing.length === 0) return null;
  return (
    `${missing.length} of ${declared.length} declared entry point(s) in ${entryPointsRelPath} did not ` +
    `materialize in ${manifestPath}:\n` +
    missing.map((m) => `    - ${m}`).join("\n") + "\n\n" +
    "  Reachability (6.2) is undefined for a root set that silently lost members: every\n" +
    "  symbol/file reachable ONLY from a dropped root now reads as \"unreachable from any\n" +
    "  entrypoint\" even though it never was. Fix the entry's path/scope/export name, or\n" +
    `  remove it from ${entryPointsRelPath} deliberately — then re-run.`
  );
}

/**
 * GUARD — refuse to extract from a tree whose EXTRACTION SCOPE is dirty
 * (CD-BR-05, high; IS-8).
 *
 * WHY. `git status` being non-empty used to be reported and not enforced, at
 * the very bottom of this file, as a NOTE. That is the worst possible place
 * for it: the graph has already been written by then. The graph was correct
 * only because one worker happened to use a clean worktree at a pinned
 * revision, and nothing recorded that. Re-extracting from a dirty checkout
 * makes every citation into a modified file silently wrong — `cli.ts` alone
 * carries 2,470 — while the graph still builds and every gate still passes.
 * There is no signal at all, downstream or in the artifact.
 *
 * WHY SCOPED, NOT BLANKET. A bare `porcelain.length > 0` refuses on a dirty
 * README. A README is not an input to extraction, so it cannot change one node
 * of the graph, and a gate that blocks correct work is a gate operators learn
 * to bypass — the failure mode `gate:vi-freshness` already has. The scope is
 * therefore `scripts/lib/vi-input-binding.mjs`'s own `targetInput` /
 * `toolInput` predicates: the exact set this pipeline hashes into
 * `manifest.input_binding`. One definition, already maintained, already
 * profile-aware, and the same set `gate:vi-freshness` compares against HEAD.
 *
 * WHY EVIDENCE STORES ARE SUBTRACTED. This is `vi-refresh.mjs`'s existing
 * invariant, not a new relaxation: step 1 already passes
 * `VI_EXTRA_OUTPUT_PREFIXES` and the end-of-run count already skips these,
 * because `evidence:rebind` leaves each producer's derived store uncommitted
 * and counting a sibling's derived output as source drift stamped the graph
 * `tree_state: "dirty"` on every refresh — a state no commit has, which
 * `gate:vi-freshness` then rejected. A guard that ignored the subtraction
 * would be stricter than the pipeline it guards and would refuse on a
 * legitimately dirty tree.
 *
 * WHY THERE IS NO OVERRIDE FLAG. The plan's QA-failure clause: a guard
 * bypassable by a flag is decorative. `--check` and `--force` are the only
 * other flags this script accepts and neither reaches this guard — they are
 * not consulted before it, so there is no flag that lets a dirty in-scope tree
 * extract. The remedy is `git stash push -u -- <paths>`, which is named in the
 * refusal text itself, per `scripts/README.md` gate rule 1. `--force` remains
 * what it always was: the vendored extractor's config-hash overwrite, not an
 * escape from this.
 */
function dirtyTreePaths(root) {
  // `-uall` because an untracked file under a tracked directory changes
  // extraction just as much as a modified one — the extractor globs the
  // filesystem, not `git ls-files`. Default porcelain collapses an untracked
  // *directory* to its top name, which would both miss the files inside it
  // and report a path that is not a real input.
  return execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((line) => line.trim().length > 0)
    // Porcelain is `XY path`; a rename is `R  old -> new` and the new path is
    // the one on disk that the extractor will read.
    .map((line) => line.slice(3).trim().split(" -> ").pop().trim())
    .filter((path) => path.length > 0);
}

/** Repo-relative dirty paths that are inputs to extraction, in stable order. */
export function dirtyExtractionScopePaths({ root, toolRoot, profile }) {
  const evidenceStores = profile?.governance?.evidence_stores ?? [];
  const isGenerated = (path) => evidenceStores.some((store) => path === store || path.startsWith(`${store}/`));
  const inScope = (paths, predicate) => paths
    .filter((path) => predicate(path, profile) && !isGenerated(path));
  const out = new Set([
    ...inScope(dirtyTreePaths(root), targetInput),
    ...inScope(toolRoot === root ? [] : dirtyTreePaths(toolRoot), toolInput),
  ]);
  return [...out].sort();
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The refusal message. Gate rule 1: name the cause, name the specific paths,
 * give ONE remedy command. Deeper rationale lives in this function's own
 * header, not in the operator's terminal.
 *
 * `outOfScopeCount` is counted in the TARGET checkout only and is never
 * derived by subtracting the union from a total — with a foreign `--root` the
 * in-scope set legitimately spans two checkouts, and that subtraction printed
 * a negative count.
 */
export function formatDirtyScopeRefusal({ inScope, outOfScopeCount, toolRootIsForeign }) {
  const shown = inScope.slice(0, 40);
  const remainder = inScope.length - shown.length;
  const remedy = `git stash push -u -- ${inScope.map(shellQuote).join(" ")}`;
  return (
    `REFUSED — ${inScope.length} uncommitted path(s) in the EXTRACTION SCOPE.\n\n` +
    `  Cause: the files this refresh reads as input are not in a commit, so the\n` +
    `  graph it is about to build would describe a state no commit has. Every\n` +
    `  citation into a changed file becomes silently wrong while the graph still\n` +
    `  builds and every gate still passes (CD-BR-05).\n\n` +
    `  Dirty, in scope:\n` +
    shown.map((path) => `    ${path}`).join("\n") +
    (remainder > 0 ? `\n    ... and ${remainder} more\n` : "\n") +
    `\n  Remedy (one command):\n    ${remedy}\n\n` +
    `  Or commit those paths first, or run this from a clean worktree checked out at\n` +
    `  the revision you intend to measure.\n\n` +
    `  Deliberately NOT refused: ${outOfScopeCount} dirty path(s) in this checkout that are\n` +
    `  outside the extraction scope, and any path under a configured evidence store (a\n` +
    `  sibling evidence producer's uncommitted derived output is not source drift).\n` +
    `  Neither can change this graph, and blocking them would train you to bypass\n` +
    `  the guard.` +
    (toolRootIsForeign
      ? `\n  This run also reads the extraction TOOLCHAIN from a different checkout, whose\n  own in-scope dirt is checked against the tool-side scope and is included above.`
      : "")
  );
}

/**
 * ADR-169/090 — the generated plane is written by a chain of stages (extract,
 * LSP facts, emit, ...) that each update `.visual-intelligence/` in place. A
 * stage that fails after an earlier one wrote (tsserver killed, a 60s LSP
 * request timeout under host load) used to leave a half-written graph on disk:
 * new nodes/edges beside the previous manifest. The next SUCCESSFUL refresh
 * then read that pair as its "prior generation" and, correctly, recorded a
 * `generation_mismatch` gap that gate:vi-freshness refuses.
 *
 * So the whole plane is one transaction. The prior plane is snapshotted before
 * any stage runs; `commit()` discards the snapshot only when every stage
 * succeeded; `rollback()` puts the previous graph, manifest, findings and views
 * back byte-for-byte. Both are idempotent and mutually exclusive: once either
 * has run the other is a no-op, so a stage's own explicit rollback followed by
 * the outer failure handler cannot restore twice (a second restore from a
 * deleted snapshot would delete the plane). The extractor's generation_mismatch
 * detection is untouched: a plane that is genuinely inconsistent on disk when a
 * run STARTS (hand edit, interrupted copy, a SIGKILL that skipped rollback)
 * still records the gap.
 */
export function beginPlaneTransaction({ visualIntelligenceDir, tmpRoot = tmpdir() }) {
  const existed = existsSync(visualIntelligenceDir);
  const backup = mkdtempSync(join(tmpRoot, "vi-refresh-"));
  const snapshot = join(backup, ".visual-intelligence");
  if (existed) cpSync(visualIntelligenceDir, snapshot, { recursive: true });
  let settled = false;
  return {
    backup,
    snapshot,
    get settled() { return settled; },
    rollback() {
      if (settled) return;
      settled = true;
      rmSync(visualIntelligenceDir, { recursive: true, force: true });
      if (existed) cpSync(snapshot, visualIntelligenceDir, { recursive: true });
      rmSync(backup, { recursive: true, force: true });
    },
    commit() {
      if (settled) return;
      settled = true;
      rmSync(backup, { recursive: true, force: true });
    },
  };
}

function main() {
  const transaction = { current: null };
  try {
    const code = mainPipeline(transaction);
    // Exit 0 is the only outcome that may keep what the stages wrote. A
    // `--check` run has already rolled itself back before returning.
    if (code === 0) transaction.current?.commit();
    else transaction.current?.rollback();
    return code;
  } catch (error) {
    transaction.current?.rollback();
    throw error;
  }
}

function mainPipeline(transaction) {
  // `--check` regenerates WITHOUT writing, so CI (or a fresh clone/worktree
  // with no local `.visual-intelligence/graph/` at all — the graph is
  // gitignored, never committed) can ask "does this reproduce cleanly from
  // committed inputs?" — the question that could not be asked at all while
  // the extractor lived outside the repository, and the one whose absence let
  // a graph with zero reachability edges sit unnoticed. When a prior local
  // copy DOES exist on disk (an ordinary dev machine that already ran
  // `vi:refresh` once), the structural comparison below is a bonus signal,
  // not the correctness bar — regeneration completing without violating any
  // of this script's own invariants (LSP facts availability, entry-point
  // materialization, etc., all checked above) is what "reproduces cleanly"
  // actually means now that there is no committed baseline to diff against.
  const check = process.argv.includes("--check");
  const force = process.argv.includes("--force");
  if (check && force) {
    console.error(
      "[vi-refresh] FAILED — --check and --force are mutually exclusive.\n" +
      "  --check proves the graph reproduces from committed source WITHOUT writing anything;\n" +
      "  --force is a deliberate overwrite. Run one or the other, not both.",
    );
    return 1;
  }

  let root;
  try {
    root = resolveRootArg(process.argv, REPO_ROOT);
  } catch (error) {
    console.error(`[vi-refresh] ${error.message}`);
    return 1;
  }
  const foreign = root !== REPO_ROOT;
  if (!check) assertEvidenceProducerAuthority(root);

  const profile = profileOrDefaults(root);
  const include = deriveInclude(profile.source_roots);

  // GUARD (CD-BR-05) — before ANY extractor runs, and deliberately not
  // reachable by `--check` or `--force`. Both are handled above and neither
  // is consulted here, so there is no flag that lets a dirty in-scope tree
  // produce a graph. A check that cannot fail is not a control, and a guard
  // with a bypass flag is decorative; this has neither escape.
  let dirtyInScope;
  let outOfScopeCount;
  try {
    const allRoot = dirtyTreePaths(root);
    dirtyInScope = dirtyExtractionScopePaths({ root, toolRoot: REPO_ROOT, profile });
    // Counted in the target checkout alone: with a foreign `--root` the
    // in-scope set spans two checkouts, so subtracting a union from one
    // checkout's total would print a negative.
    outOfScopeCount = allRoot.filter((path) => !dirtyInScope.includes(path)).length;
  } catch (error) {
    // Fail closed on the guard, not open on extraction: if the tree's state
    // cannot be read, this refresh cannot claim to have measured a commit.
    console.error(
      `[vi-refresh] FAILED — could not read git state for ${root}: ${error.message}\n` +
      `  The clean-worktree rule (CD-BR-05) cannot be evaluated, and extracting\n` +
      `  without evaluating it is the exact silent failure it exists to prevent.\n` +
      `  Remedy (one command): git -C ${shellQuote(root)} status --porcelain -uall`,
    );
    return 1;
  }
  if (dirtyInScope.length > 0) {
    console.error(
      `[vi-refresh] ${formatDirtyScopeRefusal({
        inScope: dirtyInScope,
        outOfScopeCount,
        toolRootIsForeign: root !== REPO_ROOT,
      })}\n`,
    );
    return 1;
  }
  // Derived from `governance.evidence_stores` rather than re-hardcoded —
  // falls back to the literal for a profile whose evidence_stores omits it
  // (including a bare-default repo with no arbor.profile.jsonc at all,
  // since `DEFAULT_PROFILE.governance.evidence_stores` already lists it).
  const viDirName = profile.governance.evidence_stores.find((s) => s.endsWith("visual-intelligence")) ?? ".visual-intelligence";
  const visualIntelligenceDir = join(root, viDirName);
  const graphDir = join(visualIntelligenceDir, "graph");
  const manifestPath = join(visualIntelligenceDir, "manifest.json");

  const tsExtractor = join(SKILL_DIR, "vi-extract-ts.mjs");
  if (!existsSync(tsExtractor)) {
    console.error(
      `[vi-refresh] FAILED — the TypeScript adapter is missing.\n` +
      `  expected: ${tsExtractor}\n\n` +
      `  This adapter is first-party source in the repository (ADR-176). If it is gone,\n` +
      `  the working tree is incomplete — restore it with \`git checkout -- .claude/skills/\`.\n` +
      `  Without it, a partial refresh would drop the derived plane entirely, which is\n` +
      `  worse than not refreshing at all — so this stops rather than producing one.`,
    );
    return 1;
  }
  const entryPointsAbs = join(root, ENTRY_POINTS);
  if (!existsSync(entryPointsAbs)) {
    console.error(`[vi-refresh] FAILED — canonical root set missing: ${join(root, ENTRY_POINTS)}`);
    return 1;
  }

  const visualIntelligenceDirExisted = existsSync(visualIntelligenceDir);
  // ADR-169: `.visual-intelligence/graph/` is gitignored, but its parent
  // `.visual-intelligence/` is not (manifest.json, findings/, observed/ etc.
  // stay committed) — so `visualIntelligenceDirExisted` is true in a fresh
  // worktree even though there is no prior graph to diff against. Check the
  // graph SUBdirectory specifically, or `graphDigest` returns an object with
  // all-null VALUES (truthy, not `=== null`), silently comparing against
  // that instead of taking the no-prior-graph branch below.
  const graphDirExisted = existsSync(graphDir);
  const before = check && graphDirExisted ? graphDigest(graphDir) : null;
  const beforeInputBinding = check && existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8")).input_binding ?? null
    : null;
  // Every run — not only `--check` — snapshots the whole generated plane and
  // restores it by filesystem copy rather than `git checkout`: a linked
  // worktree's git dir may be intentionally read-only even though its working
  // tree is writable. `--check` rolls back on success too (it must leave no
  // trace); a real refresh rolls back only on failure (see `main`).
  const plane = beginPlaneTransaction({ visualIntelligenceDir });
  transaction.current = plane;
  const restoreOrClear = () => plane.rollback();

  // 1. derived plane + reachability, from the canonical root set.
  try {
    // Tell the extractor about our SIBLING evidence stores. evidence:rebind
    // runs producers in sequence and leaves each one's derived store
    // uncommitted for the caller to commit, so by the time the graph is built
    // `.claim-ledger/` and `.completion-depth/` are sitting in `git status`.
    // Counting a sibling's derived output as source drift stamped the graph
    // `tree_state: "dirty"` on every refresh, which gate:vi-freshness then
    // rejected as "a state no commit has" — the chain poisoned its own next
    // run. The extractor already refuses to treat its OWN write as evidence
    // against itself; this is the same invariant, one step wider.
    run("1/3 derived plane (vi-extract-ts)", tsExtractor, [
      "--root", root,
      "--include", include,
      "--entrypoints", entryPointsAbs,
      ...(force ? ["--force"] : []),
    ], false, { env: { VI_EXTRA_OUTPUT_PREFIXES: profile.governance.evidence_stores.join(",") } });
  } catch (e) {
    // vi-extract-ts already printed its own reason to stderr (inherited
    // stdio, above) — most commonly its guardOverwrite refusal. Without this
    // catch, execFileSync's raw exception was the ONLY additional thing
    // printed: a Node stack trace with no pointer back to the flag that
    // fixes the ordinary case.
    console.error(`\n[vi-refresh] FAILED — vi-extract-ts exited non-zero (see its message above).`);
    if (!force) {
      console.error(
        "  If this is a refused overwrite — a committed config or entry-point change altered\n" +
        "  vi-extract-ts's config hash — re-run with `bun run vi:refresh -- --force` once you have\n" +
        "  confirmed the change is deliberate.",
      );
    }
    restoreOrClear();
    return 1;
  }

  // ADR-090: the vendored adapter supplies graph shape, while this owned
  // stage obtains TypeScript symbol facts through the uniform LSP client.
  // Missing servers fail this refresh; there is no silent compiler fallback.
  try {
    run("1.5/6 LSP static facts (ADR-090)", join(REPO_ROOT, "scripts", "vi-lsp-facts.mjs"), [
      "--root", root, "--graph", graphDir, "--language", "typescript",
    ]);
  } catch (error) {
    console.error("[vi-refresh] FAILED — LSP static facts were unavailable; graph was not accepted as LSP-sourced.");
    restoreOrClear();
    return 1;
  }
  const lspProjection = JSON.parse(readFileSync(join(visualIntelligenceDir, "manifest.json"), "utf8")).lsp_static_facts;
  if (lspProjection?.call_hierarchy !== "projected" || lspProjection?.references !== "projected" || lspProjection?.reachability !== "projected" || lspProjection?.canonical_edges !== "projected" || lspProjection?.identity_mapping !== "exact-only" || lspProjection?.in_scope_target_policy !== "coverage-debt") {
    console.error("[vi-refresh] FAILED — ADR-090 requires exact-identity LSP call/reference/reachability edges in the canonical graph.");
    restoreOrClear();
    return 1;
  }

  // GUARD — fail loudly, before anything else runs, if a declared root did
  // not materialize. See verifyEntryPointsMaterialized()'s header for why
  // this cannot be checked inside the vendored extractor itself.
  const droppedRoots = verifyEntryPointsMaterialized(root, ENTRY_POINTS, include);
  if (droppedRoots) {
    console.error(`\n[vi-refresh] FAILED — ${droppedRoots}`);
    // --check promises to leave no trace even on failure.
    restoreOrClear();
    return 1;
  }

  // 2+3. intended plane and the dated waiver store, from @arbor/governance's
  //    typed extractors (ADR-031's absorption). These replaced
  //    extract-intent.mjs and extract-exceptions.mjs, which carried their own
  //    ADR filename regex and status parsing while the package already owned
  //    scanDecisionsCorpus/parseRecord — two ADR parsers in one repository.
  //    Bun runs the TypeScript emitter directly; it is intentionally not
  //    coupled to Vitest's vite-node loader. `--root root` is forwarded now
  //    that vi-emit.ts derives its decisions corpus, waiver input, and
  //    output paths from a real `--root` seam instead of its own hardcoded
  //    REPO_ROOT — the boundary this file used to stop at. vi-emit.ts now
  //    also threads `governance.decisions_dir` / `governance.allowlist_path`
  //    from the target root's own profile into @arbor/governance's
  //    extractors — see vi-emit.ts's header for what changed.
  try {
    run("2/6 intended plane + exceptions (@arbor/governance vi/*)", null, [], false, {
      command: "bun",
      args: ["scripts/vi-emit.ts", "--root", root],
    });
  } catch (error) {
    restoreOrClear();
    throw error;
  }

  // --check compares extraction output only; the steps below verify and render,
  // and running them would write files --check has promised not to leave behind.
  if (!check) {
    // 4. cross-check the derived plane against the repository's OWN independent
    //    reachability implementation. Two implementations agreeing is the
    //    strongest evidence available that either is right; a disagreement is a
    //    finding about one of them. This was documented in README.md and SKILL.md
    //    and then omitted from the script that calls itself the one standardized
    //    way to refresh, so the cross-check ran only when someone did it by hand.
    run("4/6 cross-check vs gate:reachability", join(PROJECT_SCRIPTS, "verify-against-gate.mjs"), [
      "--root", root, "--graph", graphDir,
    ]);

    // 5. validate the graph and EMIT TIER-4 FINDINGS. Skipping this left CI
    //    gating the graph's distance from HEAD while nothing ever checked its
    //    internal integrity — dangling edges, duplicate ids, missing provenance.
    //    `--emit-findings` is what makes `findings/` non-empty; the interpretive
    //    tier is this skill's actual output, and it was going to the floor.
    run("5/6 validate + emit findings (vi-validate)", join(SKILL_DIR, "vi-validate.mjs"), [
      "--graph", graphDir, "--all",
      "--emit-findings", join(visualIntelligenceDir, "findings"),
    ]);

    // 5.5. stabilize finding ids (ADR-042 Half B) — the vendored validator
    //    above just wrote sequential VI-000X ids; rewrite them to stable
    //    content-addressed ids BEFORE the observed-plane comparison below, so
    //    findings born there share the same id scheme via the one
    //    authoritative function (vi-finding-id.mjs) rather than needing a
    //    second pass.
    // Both vi-findings.mjs and vi-observed-compare.mjs live in THIS checkout
    // (like SKILL_DIR/vi-emit.ts, the tool lives with the script that
    // invokes it) but must operate on `root`'s own findings/graph/observed
    // directories, not this checkout's — REVOY2_VI_FINDINGS_DIR/
    // REVOY2_VI_GRAPH_DIR/REVOY2_VI_OBSERVED_DIR are the real, already-tested
    // env seam both scripts already exposed (see scripts/tests/
    // vi-findings.test.mjs, vi-observed-compare.test.mjs). An explicit
    // --root/--dir flag was considered and rejected here: neither script's
    // own concept is "a project root" (they take absolute leaf directories,
    // not a root to resolve source layout from), so a second parsing
    // convention would only duplicate the seam that already exists and is
    // already exercised by fixture-isolated tests. For the non-foreign case
    // these compute to the exact same paths the scripts' own hardcoded
    // defaults would have used, so this is byte-identical to before.
    const findingsDir = join(visualIntelligenceDir, "findings");
    const observedDir = join(visualIntelligenceDir, "observed");
    const viDirsEnv = {
      REVOY2_VI_GRAPH_DIR: graphDir,
      REVOY2_VI_FINDINGS_DIR: findingsDir,
      REVOY2_VI_OBSERVED_DIR: observedDir,
    };

    run("5.5/6 stabilize finding ids (vi-findings --rewrite-ids)", join(REPO_ROOT, "scripts", "vi-findings.mjs"), ["--rewrite-ids"], false, { env: viDirsEnv });

    // 5.6. observed-plane comparison (ADR-042 Half A4) — additive, and only
    //    when an observed store exists: vi-observe.mjs is manual/expensive
    //    (off the critical path, like the determinism baseline), so most
    //    refreshes will not have a fresh one. Absence is reported, never
    //    silent.
    if (existsSync(observedDir)) {
      run("5.6/6 observed-vs-derived comparison (vi-observed-compare)", join(REPO_ROOT, "scripts", "vi-observed-compare.mjs"), [], false, { env: viDirsEnv });
    } else {
      process.stdout.write(`\n[vi-refresh] 5.6/6 observed plane absent — ${observedDir} does not exist, so no observed-vs-derived comparison was made (run \`bun run vi:observe\` first)\n`);
    }

    // 6. regenerate the views. They are gitignored and cheap, and leaving them
    //    behind meant the rendered diagrams on disk described an older graph than
    //    the committed one — with nothing anywhere comparing tier 3 to tier 2.
    for (const view of ["topology", "reachability", "status-matrix", "orphans"]) {
      run(`6/6 render view: ${view}`, join(SKILL_DIR, "vi-render.mjs"), [
        "--graph", graphDir, "--view", view,
      ], true);
    }
    process.stdout.write(`\n[vi-refresh] 6/6 rendered 4 view(s) into ${join(visualIntelligenceDir, "views")}/\n`);

    // The session-local dirty tracker is append-only and nothing else clears it.
    // Left alone it accumulated 42 already-committed paths and made the
    // SessionStart hook report DIVERGED forever — a permanent false alarm that
    // trained every reader to skim past the one time it would have been right.
    // The graph now describes this tree, so the tracked set is by definition
    // discharged.
    const dirtyFile = join(visualIntelligenceDir, ".dirty");
    if (existsSync(dirtyFile)) {
      writeFileSync(dirtyFile, "", "utf8");
      process.stdout.write(`[vi-refresh] cleared ${dirtyFile} (graph now describes this tree)\n`);
    }
  }

  // Bind the generated plane to its exact declared source/tool inputs. This
  // excludes generated evidence outputs, so the evidence commit cannot make
  // the graph stale merely by committing the graph itself.
  const manifestWithBinding = JSON.parse(readFileSync(manifestPath, "utf8"));
  const afterInputBinding = computeViInputBinding(root, { profile, toolRoot: REPO_ROOT });
  manifestWithBinding.input_binding = afterInputBinding;
  writeFileSync(manifestPath, `${JSON.stringify(manifestWithBinding, null, 2)}\n`);

  if (check) {
    const after = graphDigest(graphDir);
    // Restore the caller's original bytes: --check must leave no trace, or running it
    // would itself be the write it is meant to verify.
    restoreOrClear();

    if (before === null) {
      // The graph is gitignored and never committed — a fresh clone or
      // worktree legitimately has no prior local copy to diff against. That
      // is the expected, normal state now, not a defect: `git worktree add`
      // does not materialize an ignored path, so every isolated candidate
      // snapshot starts here. The correctness bar for this run was already
      // enforced above (LSP facts availability, entry-point materialization,
      // the input-binding write) — reaching this branch means regeneration
      // itself completed without violating any of those invariants.
      process.stdout.write(
        "\n[vi-refresh --check] FIRST-GENERATION — no local graph existed before this check (expected: the graph " +
        "is gitignored, never committed); regeneration completed cleanly and the bytes were removed\n",
      );
      return 0;
    }

    const differing = Object.keys(after).filter((name) => after[name] !== before[name]);
    if (JSON.stringify(beforeInputBinding) !== JSON.stringify(afterInputBinding)) differing.push("manifest.input_binding");
    if (differing.length === 0) {
      process.stdout.write("\n[vi-refresh --check] REPRODUCIBLE — the local graph regenerates with identical structure (provenance stamps excluded)\n");
      return 0;
    }
    process.stdout.write(
      `\n[vi-refresh --check] DIFFERS — ${differing.join(", ")}\n\n` +
      `  This means ONE of two things, and this check cannot tell them apart:\n` +
      `    (a) source changed since your local graph was built — run \`bun run vi:refresh\`; or\n` +
      `    (b) the graph does not reproduce from committed source, which is a defect in the\n` +
      `        pipeline rather than staleness.\n\n` +
      `  \`bun run gate:vi-freshness\` disambiguates: if it reports 0 commits behind, it is (b).\n`,
    );
    return 1;
  }

  // `root`'s own git state, not this checkout's — for a foreign `root` the
  // graph now describes THAT project's tree, and reporting REPO_ROOT's HEAD
  // here would be exactly the kind of "answers the wrong project's question"
  // failure Roadmap 23 §5 warns about.
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
  // Same correction as vi-observe.mjs: exclude every configured evidence
  // store, not only this one. A sibling producer's uncommitted output is not
  // source drift, and counting it made the graph report a dirty basis on
  // every run of the rebind chain.
  const evidenceStorePrefixes = profile.governance.evidence_stores;
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root })
    .toString()
    .split("\n")
    .filter((line) => line.trim() && !evidenceStorePrefixes.some((store) => line.includes(`${store}/`)))
    .length;

  process.stdout.write(
    foreign
      ? `\n[vi-refresh] done — ${root} now describes ${head.slice(0, 8)} (full six-step pipeline; this checkout's own graph was untouched)\n`
      : `\n[vi-refresh] done — graph now describes ${head.slice(0, 8)}\n`,
  );
  if (dirty > 0) {
    // Recorded, not blocked: refreshing from a dirty tree is legitimate while
    // iterating, but the resulting graph describes a state no commit has, and
    // committing it would make the manifest's revision a lie.
    process.stdout.write(
      `[vi-refresh] NOTE — ${dirty} uncommitted non-graph path(s). The graph now describes your\n` +
      `             working tree, not ${head.slice(0, 8)}. Commit the source first if you intend\n` +
      `             to commit this graph.\n`,
    );
  }
  return 0;
}

// Only run when invoked directly (`bun scripts/vi-refresh.mjs`, or the
// `vi:refresh`/`gate:vi-reproducible` package.json scripts that wrap it) —
// not when a test imports `verifyEntryPointsMaterialized` as a unit under
// test. Without this guard, importing this module for its one pure,
// side-effect-free export would still run the whole six-step refresh
// pipeline as an import side effect.
const isDirectInvocation = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectInvocation) process.exit(main());
