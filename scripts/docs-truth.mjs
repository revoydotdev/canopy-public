#!/usr/bin/env node
/**
 * scripts/docs-truth.mjs — Phase 6.7 docs-truth gate.
 *
 * Usage:
 *   bun scripts/docs-truth.mjs          # human-readable report, exits non-zero on violation
 *   bun scripts/docs-truth.mjs --json   # machine-readable report on stdout
 *   bun run gate:docs-truth             # wired via package.json
 *
 * What it does
 * ------------
 * ROADMAP.md's own rule (see its "Rule for this document" callout near the
 * top) is: "A tranche is ✅ only when a non-test caller reaches it on a real
 * run." This gate makes that rule machine-checked instead of asserted. Every
 * ✅ tranche must carry at least one proof comment:
 *
 *   <!-- proof: symbol=NAME roundtrip=path/to.test.ts -->
 *   <!-- proof: symbol=NAME file=path/to/src.ts roundtrip=path/to.test.ts -->
 *
 * For every such comment this gate asserts, in order:
 *   1. `symbol` names a real top-level exported declaration under
 *      packages/*\/src (per the Phase 6.2 reachability checklist — the
 *      symbol "exists" in the same sense that gate already enumerates). If
 *      the name is ambiguous (declared in more than one file), `file=` must
 *      disambiguate it.
 *   2. That declaration is *reachable* per the Phase 6.2 gate — i.e. the
 *      same static graph, not a second implementation of it.
 *   3. `roundtrip` names a test file that exists.
 *   4. That file has a *verifiable roundtrip shape* (scripts/roundtrip-shape.mjs):
 *      it drives at least two distinct operations (evidence of a write
 *      crossing a boundary and a separate read projecting it back out, not
 *      a unit test that never leaves the module under test) and its
 *      assertions are not exclusively tautological (reuses the anti-stub
 *      Rule 5 detectors). This is the general-case counterpart to
 *      RUNTIME_CATALOG kinds' own "non-vaporware" check in
 *      packages/arbor-mcp/tests/roundtrip/manifest.test.ts, which already
 *      verifies the named `it(...)` block genuinely exists for those —
 *      before this, every OTHER ✅ tranche's `roundtrip=` citation was a
 *      naming convention only: file-exists plus the whole file's vitest
 *      status being "passed" said nothing about whether the file was
 *      actually a roundtrip in 6.3's own defined sense. See
 *      roundtrip-shape.mjs's header comment for exactly what this can and
 *      cannot prove.
 *   5. The file passes (`vitest run`).
 *
 * A ✅ tranche with zero proof comments, or any proof comment that fails one
 * of the five checks above, is a gate failure.
 *
 * What counts as a "✅ tranche"
 * ------------------------------
 * A markdown heading (## or ###) whose title contains "✅", OR whose first
 * paragraph immediately below it opens with "**Status:**" followed by "✅"
 * (allowing a status line like "**Status (2026-08-02):**" — the parenthetical
 * date doesn't change what's being asserted).
 *
 * A claimed heading is only required to carry its own proof if it is a
 * *leaf* claim — i.e. it has no descendant headings (before the next heading
 * of equal-or-shallower level), or every one of its descendant headings is
 * itself claimed ✅ (G-27 fix, see below). A phase header like
 * "## Phase 4F: ... — ✅ COMPLETE" that rolls up thirteen ### sub-tranches,
 * each independently proven ✅, does not need a fourteenth proof of its own —
 * the roll-up is derived from its children, not a separate claim. This
 * mirrors how the reachability gate treats a barrel re-export: the proof
 * belongs at the concrete declaration, not every place that repeats the
 * claim.
 *
 * G-27 fix (2026-08-04, wave 3): the rollup exemption used to trigger when
 * *any* descendant was still claimed ✅, never checking whether *all* of
 * them were — so a rollup heading could keep asserting "✅ COMPLETE" forever
 * after one of its own children was downgraded to 🟡, and the gate would
 * never notice because the rollup was still "exempted" by its other,
 * still-claimed siblings. (This is exactly how the Phase 4F heading
 * "✅ COMPLETE — all thirteen items landed and green" coexisted undetected
 * with its own downgraded child 4F.7 until a human caught it.) The rule now
 * requires *all* descendant headings in range to be claimed for the
 * exemption to apply; a rollup with even one non-claimed descendant is no
 * longer exempt and must carry its own proof comment — which a rollup
 * asserting a false aggregate typically won't have, so it fails loudly as
 * "no proof comment" instead of silently passing.
 *
 * One narrow, named exclusion: the "## Completed foundation ✅" table near
 * the top of the document is a historical rollup of capabilities detailed
 * (and separately proven) later in the document as their own tranches; the
 * heading is followed by a markdown table, not tranche prose, so there is no
 * single symbol+test that could honestly stand for fourteen unrelated table
 * rows. Requiring a proof comment there would force exactly the kind of
 * fabricated, table-wide "citation" this gate exists to prevent. See
 * EXCLUDED_HEADINGS below.
 *
 * Conservative bias (stated explicitly; D4b, §24.2 P8) — FAIL-CLOSED. This
 * gate's whole purpose is refusing an Unwitnessed claim ("a document
 * asserts a state nothing can contradict"), so an unresolved or ambiguous
 * proof is treated as NO proof, not a pass: an ambiguous symbol match with
 * no disambiguating `file=` is `found: false` (line ~283/561), not silently
 * accepted as a match. A tranche that cannot be fully verified fails rather
 * than being waved through — the opposite direction from
 * registration-integrity.mjs's "prefer silence over a false accusation,"
 * and deliberately so: for a truth gate, a false PASS (an unproven ✅
 * standing unchallenged) is the exact failure mode this gate exists to
 * close, so it is treated as strictly worse than an occasional false
 * accusation.
 *
 * One disclosed, narrow exception where this gate accepts a false-negative
 * risk instead: NEGATION_RE's absence-exemption (§6.5, "a row can
 * legitimately name a file that does NOT exist... a known, narrow
 * false-negative risk, documented rather than hidden" — see that comment
 * for the exact scenario). That single carve-out trades a small, named
 * false-negative surface for not blocking the common, legitimate "this file
 * was deleted, that's the fix" narration shape. It is the one place in this
 * gate where the general fail-closed bias is knowingly relaxed, and it was
 * already disclosed inline before this pass — restated here rather than
 * left for D4b to have to rediscover.
 *
 * Constraints honored
 * --------------------
 * - No new dependency: reuses `node scripts/reachability.mjs --json` (spawned
 *   as a subprocess, since that script calls process.exit at module scope)
 *   and the committed Vitest binary's JSON reporter (already a devDependency).
 * - No .codegraph/ or revoy.lsp MCP tools — clean checkout + `bun install`
 *   only, so this runs headless in CI.
 *
 * Gap-register row validation (Q3, 2026-08-04)
 * ---------------------------------------------
 * Everything above only ever validated ROADMAP.md's ✅ *tranche headings*.
 * The "Verified gap register" table (G-01..G-32) had no gate at all — four
 * rows (G-02, G-09, G-17, G-30) drifted 8-12 commits past their own fixes,
 * caught only by a manual audit. That is the exact Unwitnessed-claim shape
 * this gate exists to close, one section of the same document down. This
 * script now also validates every register row in the "## Verified gap
 * register" section, three ways:
 *
 *   1. **Cited evidence must exist.** Every backtick-quoted `path/to/file.ts`
 *      or `path/to/file.ts:123-456` token in a row's Gap/Evidence/Fix-or-Note
 *      cells must resolve to a real file (tried relative to the repo root,
 *      then with each profile-declared source root prefixed — `packages/`
 *      by default — since citations conventionally drop it) — and, if a
 *      line or line range is given, the file must actually
 *      have that many lines. Bare filenames with no directory (e.g.
 *      `webui.ts:29`, common in this register's elided-shared-prefix prose)
 *      are resolved against an index of every file under the repo (minus
 *      node_modules/.git/dist) by basename; ambiguous matches (>1 file with
 *      that basename) skip the line-range check but still count as "exists".
 *      This is what would have caught G-17 citing two files deleted eight
 *      commits earlier.
 *   2. **Every G-NN mentioned anywhere in ROADMAP.md must have a register
 *      row**, and every row must be uniquely numbered. G-20 is a documented,
 *      deliberate non-allocation (a `| — | **G-20 was never allocated.**
 *      ... |` sentinel row, not a normal row) — this is encoded as a known
 *      exception, not flagged, and a *real* row later claiming G-20 would be
 *      flagged as a violation of that reservation.
 *   3. **Reachability-consistency, where mechanically checkable.** For rows
 *      that are not marked CLOSED, if the Gap/Evidence text contains both an
 *      "unreachable"-shaped phrase (no caller(s), zero callers, never
 *      called, unreachable, ...) and a backtick bare-identifier symbol name
 *      in the same cell, and the 6.2 reachability checklist reports that
 *      exact symbol as `reachable: true`, that is a contradiction and is
 *      flagged. This is a narrow, best-effort heuristic — deliberately
 *      scoped to avoid false positives on historical ("used to have no
 *      caller, now fixed") prose inside CLOSED rows, which this check
 *      leaves alone.
 *
 * D54 documentation-register validation (2026-08-24)
 * ---------------------------------------------------
 * The product-quality audit, the TUI census, and the reconciled
 * operator-decision rows are bounded registers too. Every PQ and reconciled
 * decision row now carries one `docs-truth` state declaration with a
 * resolvable source citation; every TUI census row needs a terminal
 * source-cited `closure:` annotation. This is integrity enforcement, not an
 * attempt to infer product behavior from prose: it blocks missing/duplicate
 * declarations and deleted citations, while changed behavior still requires
 * focused roundtrips and human review.
 */

import { readFileSync, existsSync, statSync, readdirSync, mkdtempSync, openSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve as resolvePath, basename as pathBasename, relative as relativePath, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { evaluateRoundtripFile } from "./roundtrip-shape.mjs";
import { profileOrDefaults } from "./lib/project-profile.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
/**
 * `--repo <path>` re-points every root-relative input this gate reads (its
 * ROADMAP.md, the reachability child it spawns, the citation resolver, the
 * vitest child) at another checkout, so it can be run against a fixture.
 * Inert when absent: with no flag the root is exactly what it always was.
 */
function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}
const REPO_ROOT = resolvePath(argValue("--repo") ?? resolvePath(__dirname, ".."));

// Profile-derived source roots (ADR-073): a cited path like "foo/bar.ts" is
// also tried with each source root prefixed ("packages/foo/bar.ts" today).
// `profileOrDefaults` never throws and falls back to `["packages"]` for a
// repo with no arbor.profile.jsonc, so this is byte-identical to the
// previous hardcoded `packages/` prefix on this repo either way.
const SOURCE_ROOTS = profileOrDefaults(REPO_ROOT).source_roots;

// Bun runtime migration (docs/bun-migration-plan.md): vitest's worker pool
// depends on Node's worker_threads semantics (e.g. `node:sqlite`) that Bun's
// shim does not fully provide — confirmed empirically: `bun
// node_modules/.bin/vitest run ...` reports spurious failures
// (`No such built-in module: node:sqlite`, plus a timing-sensitive test
// timeout) that do not occur under Node. This gate itself is runtime-portable
// and may run under either `node` or `bun`, but the vitest child process it
// spawns below must always run under Node regardless of which runtime is
// executing this file, or its roundtrip verdicts are unreliable.
const VITEST_RUNNER = process.versions.bun ? "node" : process.execPath;
// TypeScript's compiler host used by reachability is a Node contract. Bun's
// compatibility shim currently leaves `ts.sys` undefined, so `bun run
// gate:docs-truth` used to fail before validating a single claim. The same
// Node choice already governs the Vitest child above.
const REACHABILITY_RUNNER = process.versions.bun ? "node" : process.execPath;

// This gate's vitest child (below) runs test files whose fixtures shell raw
// git commands against their own throwaway repos (e.g. demo.test.ts's "a2"
// fixture). Those calls inherit this process's env by default; if GIT_DIR/
// GIT_WORK_TREE is ever set in the ambient environment this gate itself
// inherits (this repo's own tooling never sets them, but a pre-push hook
// runs in a box with many concurrent git-shelling processes), an unsanitized
// child env lets a "git init <tmpdir>" fixture call silently redirect onto
// THIS repo instead — reproduced live during this session's own push (see
// scripts/tests/setup-sanitize-git-env.mjs for the full incident writeup and
// the primary fix, vitest's own setupFiles). Stripped here too as defense in
// depth, since this is the one place that controls the child's env directly.
const GIT_SCOPE_ENV_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"];
function sanitizedGitEnv() {
  const env = { ...process.env };
  for (const key of GIT_SCOPE_ENV_VARS) delete env[key];
  return env;
}
const ROADMAP_PATH = resolvePath(REPO_ROOT, "ROADMAP.md");
const JSON_OUTPUT = process.argv.includes("--json");

// Headings that are historical rollups of tranches proven independently
// elsewhere in the document — see the header comment above.
const EXCLUDED_HEADINGS = new Set(["Completed foundation"]);

// ---------------------------------------------------------------------------
// 1. Parse ROADMAP.md into a heading list with claim + body-range info.
// ---------------------------------------------------------------------------

const raw = readFileSync(ROADMAP_PATH, "utf-8");
const lines = raw.split("\n");

const HEADING_RE = /^(#{2,3})\s+(.+?)\s*$/;
const STATUS_RE = /^\*\*Status(?:\s*\([^)]*\))?:\*\*\s*(.*)$/;

/** @typedef {{ level: number, title: string, line: number, claimed: boolean }} Heading */
const headings = [];
for (let i = 0; i < lines.length; i++) {
  const m = HEADING_RE.exec(lines[i]);
  if (!m) continue;
  const level = m[1].length;
  const title = m[2];
  headings.push({ level, title, line: i, claimed: false, claimReason: "" });
}

for (let h = 0; h < headings.length; h++) {
  const heading = headings[h];
  if (heading.title.includes("✅")) {
    heading.claimed = true;
    heading.claimReason = "heading title";
    continue;
  }
  // Immediate first paragraph below the heading, stopping at the next
  // heading of ANY level (so a child ### doesn't get credited to its ##
  // parent's claim, and vice versa).
  const nextHeadingLine = headings[h + 1]?.line ?? lines.length;
  let p = heading.line + 1;
  while (p < nextHeadingLine && lines[p].trim() === "") p++;
  if (p >= nextHeadingLine) continue;
  const paraLines = [];
  while (p < nextHeadingLine && lines[p].trim() !== "") {
    paraLines.push(lines[p]);
    p++;
  }
  const statusMatch = STATUS_RE.exec(paraLines[0] ?? "");
  if (statusMatch && statusMatch[1].trim().startsWith("✅")) {
    heading.claimed = true;
    heading.claimReason = "Status: paragraph";
  }
}

// ---------------------------------------------------------------------------
// 2. For each claimed heading, compute its body range and whether it's a
//    leaf claim (no claimed descendant at a deeper level).
// ---------------------------------------------------------------------------

function bodyEndIndex(h) {
  // First heading at or above this heading's level, after it.
  for (let i = h + 1; i < headings.length; i++) {
    if (headings[i].level <= headings[h].level) return headings[i].line;
  }
  return lines.length;
}

const tranches = [];
for (let h = 0; h < headings.length; h++) {
  const heading = headings[h];
  if (!heading.claimed) continue;
  if (EXCLUDED_HEADINGS.has(heading.title.replace(/\s*✅\s*$/, "").trim())) continue;
  const end = bodyEndIndex(h);
  const descendants = headings.filter(
    (other, oh) => oh > h && other.line < end && other.level > heading.level,
  );
  // G-27 fix: exempt this rollup from its own proof only when it HAS
  // descendants AND every one of them is itself claimed ✅ — not merely
  // "at least one still is". A rollup with zero descendants is a leaf claim
  // and needs its own proof regardless.
  if (descendants.length > 0 && descendants.every((d) => d.claimed)) continue; // rollup — proof lives at the (fully claimed) leaves
  // A heading that reaches here either has no descendants (a true leaf) or
  // has at least one non-claimed descendant (a contradicting rollup, G-27).
  // Either way its OWN proof-scanning range must stop before its first
  // child heading — otherwise a contradicting rollup would silently inherit
  // a child leaf's <!-- proof: ... --> comment (found later in the same
  // line range) as if it justified the rollup's own claim, defeating the
  // fix above by a different route.
  const ownBodyEnd = descendants[0]?.line ?? end;
  tranches.push({ title: heading.title, line: heading.line, bodyStart: heading.line + 1, bodyEnd: ownBodyEnd });
}

// ---------------------------------------------------------------------------
// 3. Extract proof comments from each leaf tranche's body.
// ---------------------------------------------------------------------------

const PROOF_RE = /<!--\s*proof:(.*?)-->/g;

function parseProofComment(inner) {
  const fields = {};
  const tokenRe = /(\w+)=(\S+)/g;
  let m;
  while ((m = tokenRe.exec(inner))) fields[m[1]] = m[2];
  return fields;
}

for (const tranche of tranches) {
  tranche.proofs = [];
  const bodyText = lines.slice(tranche.bodyStart, tranche.bodyEnd).join("\n");
  let m;
  PROOF_RE.lastIndex = 0;
  while ((m = PROOF_RE.exec(bodyText))) {
    tranche.proofs.push(parseProofComment(m[1]));
  }
}

// ---------------------------------------------------------------------------
// 4. Reachability checklist (symbol exists + is reachable), via 6.2's gate.
// ---------------------------------------------------------------------------

const reachResult = spawnSync(REACHABILITY_RUNNER, [resolvePath(REPO_ROOT, "scripts/reachability.mjs"), "--json"], {
  cwd: REPO_ROOT,
  encoding: "utf-8",
  maxBuffer: 64 * 1024 * 1024,
});
let checklist = [];
try {
  checklist = JSON.parse(reachResult.stdout).checklist ?? [];
} catch {
  console.error("docs-truth: could not parse `node scripts/reachability.mjs --json` output — is the 6.2 gate broken?");
  console.error(reachResult.stdout?.slice(0, 2000));
  console.error(reachResult.stderr?.slice(0, 2000));
  process.exit(1);
}

function findSymbol(name, file) {
  const matches = checklist.filter((c) => c.name === name && (file === undefined || c.file === file));
  if (matches.length === 0) return { found: false };
  if (matches.length > 1) return { found: false, ambiguous: true, matches };
  return { found: true, entry: matches[0] };
}

// ---------------------------------------------------------------------------
// 5. Validate every proof comment's symbol + reachability; collect roundtrip
//    test files to run once, batched.
// ---------------------------------------------------------------------------

const violations = [];
const roundtripFilesNeeded = new Set();

for (const tranche of tranches) {
  if (tranche.proofs.length === 0) {
    violations.push({ tranche: tranche.title, line: tranche.line + 1, reason: "no proof comment" });
    continue;
  }
  for (const proof of tranche.proofs) {
    const label = `${tranche.title} (line ${tranche.line + 1})`;
    if (!proof.symbol) {
      violations.push({ tranche: tranche.title, line: tranche.line + 1, reason: `proof comment missing symbol= — ${label}` });
      continue;
    }
    if (!proof.roundtrip) {
      violations.push({ tranche: tranche.title, line: tranche.line + 1, reason: `proof comment missing roundtrip= — ${label}` });
      continue;
    }
    const lookup = findSymbol(proof.symbol, proof.file);
    if (!lookup.found) {
      const reason = lookup.ambiguous
        ? `symbol "${proof.symbol}" is declared in ${lookup.matches.length} files — disambiguate with file= (${label})`
        : `symbol "${proof.symbol}"${proof.file ? ` in ${proof.file}` : ""} does not exist under packages/*/src (${label})`;
      violations.push({ tranche: tranche.title, line: tranche.line + 1, reason });
      continue;
    }
    if (!lookup.entry.reachable) {
      violations.push({
        tranche: tranche.title,
        line: tranche.line + 1,
        reason: `symbol "${proof.symbol}" (${lookup.entry.file}) exists but is not reachable per the 6.2 gate (${label})`,
      });
      continue;
    }
    const roundtripAbs = resolvePath(REPO_ROOT, proof.roundtrip);
    if (!existsSync(roundtripAbs)) {
      violations.push({ tranche: tranche.title, line: tranche.line + 1, reason: `roundtrip test file "${proof.roundtrip}" does not exist (${label})` });
      continue;
    }
    // 6.3 semantic check (see scripts/roundtrip-shape.mjs's header comment
    // for the full rationale): a cited roundtrip must be verifiable as one
    // — driving more than a single operation and asserting something
    // non-tautological — not merely a file that exists under the right
    // name. This is the general-case counterpart to the RUNTIME_CATALOG
    // manifest's own "non-vaporware" check
    // (packages/arbor-mcp/tests/roundtrip/manifest.test.ts), applied here
    // to every other ✅ tranche's roundtrip= citation.
    const shape = evaluateRoundtripFile(roundtripAbs);
    if (!shape.ok) {
      violations.push({
        tranche: tranche.title,
        line: tranche.line + 1,
        reason: `roundtrip test file "${proof.roundtrip}" does not have a verifiable roundtrip shape (${label}): ${shape.reasons.join("; ")}`,
      });
      continue;
    }
    roundtripFilesNeeded.add(proof.roundtrip);
  }
}

// ---------------------------------------------------------------------------
// 6. Run every referenced roundtrip test file once, batched, via vitest's
//    JSON reporter, and check each one passed.
// ---------------------------------------------------------------------------

const testFileStatus = new Map(); // relPath -> "passed" | "failed" | undefined (didn't run)

if (roundtripFilesNeeded.size > 0) {
  const files = [...roundtripFilesNeeded];
  // Bun's child_process compatibility layer drops captured output from a Node
  // child in this exact Node -> Vitest-worker path. Give the child real file
  // descriptors instead; Node writes the JSON reporter output normally and
  // this parent reads the same bytes on either runtime.
  //
  // The report goes to its own --outputFile, not stdout: a roundtrip test that
  // prints to stdout (a CLI test echoing `arbor run` usage, say) lands in the
  // same stream as the reporter, and one stray line made the whole report
  // unparseable while every test in it had passed.
  const vitestOutputDir = mkdtempSync(join(tmpdir(), "revoy2-docs-truth-vitest-"));
  const reportPath = join(vitestOutputDir, "report.json");
  const stdoutPath = join(vitestOutputDir, "stdout.log");
  const stderrPath = join(vitestOutputDir, "stderr.log");
  const stdoutFd = openSync(stdoutPath, "w");
  const stderrFd = openSync(stderrPath, "w");
  spawnSync(
    VITEST_RUNNER,
    [resolvePath(REPO_ROOT, "node_modules/.bin/vitest"), "run", "--reporter=json", `--outputFile=${reportPath}`, ...files],
    { cwd: REPO_ROOT, stdio: ["ignore", stdoutFd, stderrFd], maxBuffer: 256 * 1024 * 1024, env: sanitizedGitEnv() },
  );
  closeSync(stdoutFd);
  closeSync(stderrFd);
  const vitestReport = existsSync(reportPath) ? readFileSync(reportPath, "utf-8") : "";
  const vitestStdout = readFileSync(stdoutPath, "utf-8");
  const vitestStderr = readFileSync(stderrPath, "utf-8");
  rmSync(vitestOutputDir, { recursive: true, force: true });
  let report;
  try {
    report = JSON.parse(vitestReport);
  } catch {
    console.error("docs-truth: could not parse `vitest run --reporter=json` output for roundtrip files.");
    console.error(vitestStdout.slice(0, 4000));
    console.error(vitestStderr.slice(0, 4000));
    process.exit(1);
  }
  for (const testResult of report.testResults ?? []) {
    const rel = testResult.name.startsWith(REPO_ROOT) ? testResult.name.slice(REPO_ROOT.length + 1) : testResult.name;
    testFileStatus.set(rel, testResult.status);
  }
}

for (const tranche of tranches) {
  for (const proof of tranche.proofs) {
    if (!proof.symbol || !proof.roundtrip) continue;
    if (!roundtripFilesNeeded.has(proof.roundtrip)) continue; // already a violation above
    const status = testFileStatus.get(proof.roundtrip);
    if (status === undefined) {
      violations.push({
        tranche: tranche.title,
        line: tranche.line + 1,
        reason: `roundtrip test file "${proof.roundtrip}" did not run under vitest (path mismatch?) (${tranche.title}, line ${tranche.line + 1})`,
      });
    } else if (status !== "passed") {
      violations.push({
        tranche: tranche.title,
        line: tranche.line + 1,
        reason: `roundtrip test file "${proof.roundtrip}" did not pass (status: ${status}) (${tranche.title}, line ${tranche.line + 1})`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 6.5. Gap-register row validation (Q3) — see header comment for the design.
// ---------------------------------------------------------------------------

const REGISTER_HEADING_RE = /^##\s+Verified gap register\s*$/;
const NEXT_TOP_HEADING_RE = /^##\s+/;
const ROW_RE = /^\|\s*(\*\*G-(\d+)\*\*|—)\s*\|(.*)\|\s*$/;
const PATH_EXT = "(?:ts|tsx|mjs|js|json|md|yml|yaml|sh)";
const PATH_TOKEN_RE = new RegExp(`^([\\w.\\-/]+\\.${PATH_EXT})(?::(\\d+)(?:-(\\d+))?)?$`);
const BARE_SYMBOL_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNREACHABLE_PHRASE_RE = /\b(?:no (?:live |production )?callers?|zero callers|never (?:called|invoked)|unreachable)\b/i;
// A row can legitimately name a file that does NOT exist, on purpose — e.g.
// G-17 narrates "hashline.ts... are deleted" as the resolution itself. A
// sentence containing one of these phrases is describing an intentional
// absence, not citing live evidence, so path tokens inside it are exempt
// from the existence check (they are still exempt from nothing else: a
// row citing a *different*, unrelated missing file in the same sentence as
// an unrelated "deleted" claim about a third file would incorrectly pass —
// a known, narrow false-negative risk, documented rather than hidden).
const NEGATION_RE = /\b(?:is|are|were|was)\s+deleted\b|\bdeleted\b|\bdoes not exist\b|\bno longer exists?\b|\babsent\b|\bremoved\b|\bnothing ingests\b|\breturns nothing\b|\bzero references\b/i;

let registerStart = -1;
let registerEnd = lines.length;
for (let i = 0; i < lines.length; i++) {
  if (REGISTER_HEADING_RE.test(lines[i])) {
    registerStart = i + 1;
    for (let j = registerStart; j < lines.length; j++) {
      if (NEXT_TOP_HEADING_RE.test(lines[j])) {
        registerEnd = j;
        break;
      }
    }
    break;
  }
}

const registerRows = []; // { id: number|null, neverAllocated: boolean, line, cells: string[] }
if (registerStart >= 0) {
  for (let i = registerStart; i < registerEnd; i++) {
    const m = ROW_RE.exec(lines[i]);
    if (!m) continue;
    const rest = m[3];
    if (/^\s*---/.test(rest)) continue; // separator row
    const cells = rest.split("|").map((c) => c.trim());
    // Table shape is `| ID | Gap | Evidence | Fix-or-Note | Prevented by |`
    // for every row in both the Substrate and Absent sections.
    const [gap, evidence, fixOrNote, preventedBy] = cells;
    if (m[1] === "—") {
      // Only the documented G-20 sentinel is a legitimate "—" ID row.
      const neverAllocated = /G-20\b/.test(gap ?? "") && /never allocated/i.test(gap ?? "");
      registerRows.push({ id: null, neverAllocated, line: i, gap, evidence, fixOrNote, preventedBy });
    } else {
      registerRows.push({ id: Number(m[2]), neverAllocated: false, line: i, gap, evidence, fixOrNote, preventedBy });
    }
  }
}

// --- Check 2: every G-NN mentioned anywhere in ROADMAP.md has a row; every
//     row is uniquely numbered; G-20 stays reserved-not-allocated. ---

const mentionedNumbers = new Set();
for (const m of raw.matchAll(/G-(\d{2,3})\b/g)) mentionedNumbers.add(Number(m[1]));

const rowNumbers = registerRows.filter((r) => r.id !== null).map((r) => r.id);
const rowNumberCounts = new Map();
for (const n of rowNumbers) rowNumberCounts.set(n, (rowNumberCounts.get(n) ?? 0) + 1);

const neverAllocatedNumbers = new Set(registerRows.filter((r) => r.neverAllocated).map(() => 20));

for (const [n, count] of rowNumberCounts) {
  if (n === 20) {
    violations.push({
      tranche: "Verified gap register",
      line: registerRows.find((r) => r.id === 20).line + 1,
      reason: `G-20 is reserved as never-allocated (see the sentinel row) but a real row claims it`,
    });
  }
  if (count > 1) {
    violations.push({
      tranche: "Verified gap register",
      line: registerRows.find((r) => r.id === n).line + 1,
      reason: `G-${String(n).padStart(2, "0")} has ${count} register rows — IDs must be unique`,
    });
  }
}

const coveredNumbers = new Set([...rowNumbers, ...neverAllocatedNumbers]);
for (const n of [...mentionedNumbers].sort((a, b) => a - b)) {
  if (!coveredNumbers.has(n)) {
    violations.push({
      tranche: "Verified gap register",
      line: 0,
      reason: `G-${String(n).padStart(2, "0")} is referenced in ROADMAP.md but has no register row`,
    });
  }
}

// --- Check 1: cited file/path evidence must exist (and line ranges must be
//     in range). Build a basename index once, lazily, for bare-filename
//     citations that elide their shared directory prefix. ---

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".codegraph"]);
let basenameIndex = null;
function buildBasenameIndex() {
  const index = new Map(); // basename -> [relative paths]
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = resolvePath(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const rel = relativePath(REPO_ROOT, full);
        const list = index.get(entry.name) ?? [];
        list.push(rel);
        index.set(entry.name, list);
      }
    }
  }
  walk(REPO_ROOT);
  return index;
}

function lineCount(absPath) {
  return readFileSync(absPath, "utf-8").split("\n").length;
}

/** Resolves a cited path token to 0, 1, or >1 real files, and (if resolvable
 * to exactly one) whether a cited end-line is within that file's length. */
export function checkPathCitation(relPath, startLine, endLine) {
  const end = endLine ?? startLine;
  if (relPath.includes("/")) {
    const candidates = [relPath, ...SOURCE_ROOTS.map((root) => `${root}/${relPath}`)]
      .map((c) => resolvePath(REPO_ROOT, c))
      .filter((p) => existsSync(p) && statSync(p).isFile());
    if (candidates.length > 0) {
      if (end !== undefined && lineCount(candidates[0]) < Number(end)) {
        return { found: true, lineOutOfRange: true, file: relativePath(REPO_ROOT, candidates[0]), actualLines: lineCount(candidates[0]) };
      }
      return { found: true };
    }
    // Fall through to the basename index below: this register elides
    // intermediate directories too (e.g. "tests/foo.test.ts" for a file
    // that actually lives at "packages/some-pkg/tests/foo.test.ts"), not
    // just bare filenames with no directory at all.
  }
  // Bare filename, or a multi-segment path whose direct/packages-prefixed
  // guesses both missed — elided shared-prefix prose. Match by basename
  // anywhere in the repo rather than guessing the directory.
  basenameIndex ??= buildBasenameIndex();
  const matches = basenameIndex.get(pathBasename(relPath)) ?? [];
  if (matches.length === 0) return { found: false };
  if (matches.length > 1) return { found: true, ambiguous: true };
  if (end !== undefined && lineCount(resolvePath(REPO_ROOT, matches[0])) < Number(end)) {
    return { found: true, lineOutOfRange: true, file: matches[0], actualLines: lineCount(resolvePath(REPO_ROOT, matches[0])) };
  }
  return { found: true };
}

// ---------------------------------------------------------------------------
// 6.6. D54 documentation-register validation.
// ---------------------------------------------------------------------------

const DOCS_TRUTH_DECLARATION_RE = /<!--\s*docs-truth:\s*([^>]*?)-->/g;
const DECLARED_STATES = new Set(["open", "partial", "closed", "settled"]);

function parseDeclaration(inner) {
  const fields = {};
  for (const m of inner.matchAll(/(\w+)=([^\s]+)/g)) fields[m[1]] = m[2];
  return fields;
}

function readDocument(relPath) {
  return readFileSync(resolvePath(REPO_ROOT, relPath), "utf-8").split("\n");
}

function declarationsIn(linesForDocument, register) {
  const declarations = [];
  const text = linesForDocument.join("\n");
  DOCS_TRUTH_DECLARATION_RE.lastIndex = 0;
  let match;
  while ((match = DOCS_TRUTH_DECLARATION_RE.exec(text))) {
    const fields = parseDeclaration(match[1]);
    if (fields.register === register) declarations.push(fields);
  }
  return declarations;
}

function validateDeclaredRegister({ label, path, register, expectedStates }) {
  const documentLines = readDocument(path);
  const declarations = declarationsIn(documentLines, register);
  const byId = new Map();
  for (const declaration of declarations) {
    if (!declaration.id) {
      violations.push({ tranche: label, line: 0, reason: `${label} has a docs-truth declaration without id=` });
      continue;
    }
    const entries = byId.get(declaration.id) ?? [];
    entries.push(declaration);
    byId.set(declaration.id, entries);
  }
  for (const [id, state] of expectedStates) {
    const declarationsForId = byId.get(id) ?? [];
    if (declarationsForId.length !== 1) {
      violations.push({ tranche: label, line: 0, reason: `${label} must declare ${id} exactly once (found ${declarationsForId.length})` });
      continue;
    }
    const declaration = declarationsForId[0];
    if (!DECLARED_STATES.has(declaration.state)) {
      violations.push({ tranche: label, line: 0, reason: `${label} ${id} has invalid state=${declaration.state ?? "<missing>"}` });
    } else if (declaration.state !== state) {
      violations.push({ tranche: label, line: 0, reason: `${label} ${id} declares state=${declaration.state}, but its register row says ${state}` });
    }
    if (!declaration.evidence) {
      violations.push({ tranche: label, line: 0, reason: `${label} ${id} is missing evidence=` });
      continue;
    }
    const evidence = checkPathCitation(declaration.evidence);
    if (!evidence.found) {
      violations.push({ tranche: label, line: 0, reason: `${label} ${id} cites missing evidence "${declaration.evidence}"` });
    }
  }
  for (const id of byId.keys()) {
    if (!expectedStates.has(id)) {
      violations.push({ tranche: label, line: 0, reason: `${label} declares unknown ID ${id}` });
    }
  }
}

const productQualityLines = readDocument("docs/product-quality-audit-2026-08-20.md");
const productQualityStates = new Map();
for (const line of productQualityLines) {
  const match = /^\|\s*(PQ-\d{2})\s*\|\s*(open|partial|closed)\s*\|/.exec(line);
  if (match) productQualityStates.set(match[1], match[2]);
}
validateDeclaredRegister({
  label: "Product-quality register",
  path: "docs/product-quality-audit-2026-08-20.md",
  register: "pq",
  expectedStates: productQualityStates,
});

const OPERATOR_DECISION_STATES = new Map([
  ["D18", "partial"], ["D20", "open"], ["D24", "closed"], ["D25", "open"], ["D26", "open"],
  ["D28", "settled"], ["D29", "settled"], ["D30", "settled"], ["D32", "settled"], ["D33", "partial"],
]);
validateDeclaredRegister({
  label: "Operator-decision reconciliation",
  path: "docs/proposals/operator-decisions-2026-08-19.md",
  register: "operator-decisions",
  expectedStates: OPERATOR_DECISION_STATES,
});

const tuiCensusLines = readDocument("audit/tui-parity-census.md");
const TUI_ROW_RE = /^\|\s*((?:CS|IS|IQ|DEF|TH)-\d+[a-z]?)\s*\|/;
const TUI_CLOSURE_RE = /<!--\s*closure:\s*([\s\S]*?)-->/g;
const TUI_CLOSURE_STATE_RE = /^(?:OPEN|CLOSED|SUPERSEDED|STILL ACCURATE|VERIFIED CLOSED)\b/i;
const TUI_SOURCE_RE = /((?:packages|scripts)\/[\w./-]+\.(?:ts|tsx|mjs|js|json|md|yml|yaml|sh))/g;
for (let rowLine = 0; rowLine < tuiCensusLines.length; rowLine++) {
  const row = TUI_ROW_RE.exec(tuiCensusLines[rowLine]);
  if (!row) continue;
  let end = rowLine + 1;
  while (end < tuiCensusLines.length && !TUI_ROW_RE.test(tuiCensusLines[end])) end++;
  const following = tuiCensusLines.slice(rowLine + 1, end).join("\n");
  const closures = [];
  TUI_CLOSURE_RE.lastIndex = 0;
  let closure;
  while ((closure = TUI_CLOSURE_RE.exec(following))) closures.push(closure[1].trim());
  const label = `TUI census ${row[1]}`;
  if (closures.length === 0) {
    violations.push({ tranche: label, line: rowLine + 1, reason: `${label} has no closure annotation` });
    continue;
  }
  const terminal = closures.at(-1);
  if (!TUI_CLOSURE_STATE_RE.test(terminal)) {
    violations.push({ tranche: label, line: rowLine + 1, reason: `${label}'s terminal closure annotation has no recognized state` });
  }
  const citedPaths = [...terminal.matchAll(TUI_SOURCE_RE)].map((m) => m[1]);
  if (citedPaths.length === 0) {
    violations.push({ tranche: label, line: rowLine + 1, reason: `${label}'s terminal closure annotation has no source citation` });
  }
  for (const citedPath of citedPaths) {
    if (!checkPathCitation(citedPath).found) {
      violations.push({ tranche: label, line: rowLine + 1, reason: `${label} cites missing source "${citedPath}"` });
    }
  }
  rowLine = end - 1;
}

for (const row of registerRows) {
  if (row.id === null) continue; // sentinel row, nothing to cite-check
  const label = `G-${String(row.id).padStart(2, "0")}`;
  const citedCells = [row.gap, row.evidence, row.fixOrNote].filter(Boolean); // everything but "Prevented by"
  for (const cell of citedCells) {
    // Sentence-scoped, not cell-scoped: a "these files are deleted" claim in
    // one sentence shouldn't exempt an unrelated citation in the next one.
    const sentences = cell.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      const negated = NEGATION_RE.test(sentence);
      for (const m of sentence.matchAll(/`([^`]+)`/g)) {
        const inner = m[1];
        const pm = PATH_TOKEN_RE.exec(inner);
        if (!pm) continue;
        if (negated) continue; // intentionally-absent citation, e.g. G-17
        const [, relPath, startLine, endLine] = pm;
        const result = checkPathCitation(relPath, startLine, endLine);
        if (!result.found) {
          violations.push({
            tranche: "Verified gap register",
            line: row.line + 1,
            reason: `${label} cites "${inner}" as evidence, but no such file exists in the repository`,
          });
        } else if (result.lineOutOfRange) {
          violations.push({
            tranche: "Verified gap register",
            line: row.line + 1,
            reason: `${label} cites "${inner}", but ${result.file} only has ${result.actualLines} lines`,
          });
        }
      }
    }
  }

  // --- Check 3: reachability consistency for still-open rows. ---
  const statusText = row.gap ?? "";
  const isClosed = /^\*\*(?:CLOSED|RESOLVED|RATIFIED)\b/i.test(statusText);
  if (isClosed) continue;
  const openCellText = [row.gap, row.evidence].filter(Boolean).join(" ");
  if (!UNREACHABLE_PHRASE_RE.test(openCellText)) continue;
  for (const m of openCellText.matchAll(/`([^`]+)`/g)) {
    const inner = m[1];
    if (!BARE_SYMBOL_RE.test(inner)) continue;
    const hit = checklist.find((c) => c.name === inner && c.reachable === true);
    if (hit) {
      violations.push({
        tranche: "Verified gap register",
        line: row.line + 1,
        reason: `${label} claims "${inner}" is unreachable/has no callers, but the 6.2 reachability gate reports it reachable (${hit.file})`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 7. Report.
// ---------------------------------------------------------------------------

const ok = violations.length === 0;

/**
 * What this run actually OBSERVED, in the control plane's `observed_count: N`
 * convention (scripts/enforcement-control-plane.mjs:53). It is the count of
 * cited roundtrip files that ran and reported a status — not the count of
 * proofs parsed, and not the exit code.
 *
 * WHY THIS IS NOT IMPLIED BY THE EXIT CODE. The vitest block above is guarded
 * by `if (roundtripFilesNeeded.size > 0)`, so a ROADMAP edit that stopped
 * citing any roundtrip would make this gate skip every proof-bearing run and
 * report PASS having verified nothing. The failure this gate actually had was
 * the same shape from the other side: it exited 1 having produced no report,
 * and a gate that measured nothing had no channel to say so. A count the
 * control plane can compare against a declared floor is that channel.
 */
const observedCount = testFileStatus.size;

if (JSON_OUTPUT) {
  console.log(
    JSON.stringify(
      {
        ok,
        observed_count: observedCount,
        roundtripFilesCited: roundtripFilesNeeded.size,
        tranchesChecked: tranches.length,
        proofsChecked: tranches.reduce((n, t) => n + t.proofs.length, 0),
        registerRowsChecked: registerRows.filter((r) => r.id !== null).length,
        violations,
      },
      null,
      2,
    ),
  );
} else {
  console.log(
    `docs-truth gate — ${tranches.length} ✅ tranche(s) checked (leaf claims only; rollups skipped), ` +
      `${registerRows.filter((r) => r.id !== null).length} gap-register row(s) checked\n`,
  );
  if (violations.length) {
    console.log(`${violations.length} violation(s):`);
    for (const v of violations) console.log(`  - line ${v.line}: ${v.reason}`);
    console.log("");
  }
  // The exact line shape `parseGateObservedCount` matches, on its own line.
  console.log(`observed_count: ${observedCount}`);
  console.log(ok ? "PASS" : "FAIL");
}

process.exit(ok ? 0 : 1);
