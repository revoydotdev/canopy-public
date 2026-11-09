#!/usr/bin/env -S node
/**
 * scripts/adr-citations.mjs — ADR-130's gate: an ADR's prose citations are
 * checked, not decorative (gate:adr-citations).
 *
 * WHY THIS EXISTS. `gate:obligations` verifies that every `<!-- proof: ... -->`
 * triple resolves — but that is the ONLY part of an ADR it checks. The rest of
 * the document — Context, Decision, Consequences, Alternatives — is dense with
 * citations (`file.ts:123`, dependency versions, "`X` in `Y.ts`") that nothing
 * verifies. ADR-130's own Context names the live example this gate must catch:
 * `@opentui/core` cited as `0.5.1` in ADR-036 against an actual `0.5.3` in
 * `packages/arbor-tui/package.json`. See decisions/ADR-130-*.md for the full
 * rationale — this comment restates only what the code must do, not why.
 *
 * THE CHECKABLE SET (ADR-130 Decision 2 — bounded deliberately):
 *   - `path/to/file.ts` — the file exists.
 *   - `path/to/file.ts:N` — the file exists AND has at least N lines. Whether
 *     line N still contains the intended thing is not decidable and is not
 *     attempted (Decision 4).
 *   - A dependency version cited for a named package — matches that package's
 *     manifest.
 *   - `` `Symbol` in/at `file.ts` `` — resolves via the SAME machinery
 *     `gate:obligations` uses (`resolveProofComment` / `symbolAppearsInFile`
 *     from `@arbor/governance`), not a second resolver.
 *
 * OUT OF SCOPE, ON PURPOSE (Decision 3): counts and measurements ("51 files /
 * 668 tests"). A test count is a snapshot of a moving number; checking it
 * would mean either re-running the suite inside a docs gate or failing
 * constantly. Not attempted here.
 *
 * CONSERVATIVE BY DESIGN (Consequences). A zealous detector that flags
 * ordinary prose gets disabled within a week and then checks nothing — so
 * this gate ONLY looks inside backtick code spans (prose almost never wraps
 * plain English in backticks) and ONLY inside spans matching a narrow,
 * well-formed citation shape (a known source-file extension, a scoped/plain
 * npm package name, or the `` `Symbol` in/at `file` `` idiom this corpus
 * already uses — see ADR-035/066/103/108/114/115's real prose for that exact
 * idiom in the wild). Fenced code blocks (``` ... ```) are stripped before
 * scanning: illustrative example code is not a documentary citation. When a
 * span cannot be resolved to a citation with confidence, it is left alone —
 * a conservative miss is correct here (ADR-130 Consequences), a false flag is
 * not.
 *
 * RATCHET, NOT DAY-ONE BLOCKING (Decision 5). Same pattern as
 * `gate:adr-sections`'s `ALTERNATIVES_FLOOR`: this gate measures the current
 * count of unresolvable citations across the corpus, pins that as the floor,
 * and fails only on an increase. Paying down existing drift is deliberate,
 * separate work — not this gate's job to force in one commit.
 *
 * RETIRED/SUPERSEDED RECORDS ARE EXEMPT (Consequences). A record whose
 * `**Status:**` line begins `Retired`, `Superseded`, or `Rejected` describes a
 * repository that deliberately no longer exists and is skipped entirely — the
 * SAME Status-line convention `gate:adr-sections` already keys its own
 * retirement exemption on (see that gate's `RETIRED_STATUS_RE`) and that
 * `gate:adr-retirement-integrity` requires as the back-reference marker for a
 * superseded record. There is no second notion of "retired" invented here.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProofComment } from "@arbor/governance";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, "..");

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

// ---------------------------------------------------------------------------
// Corpus loading + retirement exemption (same Status-line convention as
// gate:adr-sections — see module header).
// ---------------------------------------------------------------------------

const ADR_FILE_RE = /^ADR-(\d+)-.+\.md$/;
const STATUS_RE = /^\*\*Status:\*\*\s*(.+)$/m;
const RETIRED_STATUS_RE = /^(Retired|Superseded|Rejected)\b/i;

export function loadAdrCorpus(decisionsDir) {
  const entries = readdirSync(decisionsDir);
  const adrs = [];
  for (const entry of entries) {
    const match = ADR_FILE_RE.exec(entry);
    if (!match) continue;
    const full = join(decisionsDir, entry);
    if (!statSync(full).isFile()) continue;
    adrs.push({ number: Number(match[1]), file: entry, text: readFileSync(full, "utf-8") });
  }
  adrs.sort((a, b) => a.number - b.number);
  return adrs;
}

export function parseStatus(text) {
  const match = STATUS_RE.exec(text);
  return match ? match[1].trim() : null;
}

export function isRetired(text) {
  const status = parseStatus(text);
  return status !== null && RETIRED_STATUS_RE.test(status);
}

// ---------------------------------------------------------------------------
// Fenced-code stripping — illustrative code blocks are not citations.
// ---------------------------------------------------------------------------

/** Blanks ``` ... ``` fenced blocks to same-length whitespace (preserving
 * line numbers/offsets for everything after) so citation regexes never see
 * example code. */
export function stripFencedCodeBlocks(text) {
  return text.replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, " "));
}

// ---------------------------------------------------------------------------
// Citation extraction — backtick code spans only, narrow well-formed shapes.
// ---------------------------------------------------------------------------

/** Extensions actually in use in this repository (source + docs + config) —
 * see the audit this gate's header cites. Deliberately a closed, known list:
 * an unrecognized "extension" is far more likely to be ordinary prose that
 * happens to contain a dot than a real citation. */
const KNOWN_EXTENSIONS =
  "ts|tsx|js|jsx|mjs|cjs|mts|cts|json|jsonc|md|mdx|yml|yaml|toml|py|sh|rs|go|css|scss|html|txt|lock";

const PATH_BODY = "[A-Za-z0-9_./-]+";

/** `` `Symbol` in/at/within `file.ext[:N]` `` — the idiom this corpus already
 * uses in the wild (ADR-035, ADR-066, ADR-103, ADR-108, ADR-114, ADR-115).
 * Consumed FIRST so the trailing file span is not also reported as a bare
 * file citation. */
const SYMBOL_AT_FILE_RE = new RegExp(
  "`([A-Za-z_][A-Za-z0-9_]*)`\\s+(?:in|at|within)\\s+`(" + PATH_BODY + "\\.(?:" + KNOWN_EXTENSIONS + "))(?::(\\d+))?`",
  "g",
);

/** `` `path/to/file.ext[:N]` `` — a bare file citation. */
const FILE_CITATION_RE = new RegExp("`(" + PATH_BODY + "\\.(?:" + KNOWN_EXTENSIONS + "))(?::(\\d+))?`", "g");

/** `` `@scope/pkg@X.Y.Z` `` or `` `pkg@X.Y.Z` `` — a dependency version claim. */
const VERSION_CITATION_RE = /`(@?[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)?)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)`/g;

/**
 * True for a path that is syntactically well-formed but, by its own shape,
 * is not actually a citation to a real repo path — the placeholder idioms
 * this corpus's own prose uses (measured against the live corpus while
 * calibrating this gate):
 *   - `path/to/...` — the standard "fill in a real path here" idiom (used
 *     literally as an example in ADR-078, ADR-110, and this gate's own
 *     ADR-130).
 *   - an ALL_CAPS_WITH_UNDERSCORES first segment (`REPO_ROOT/package.json`,
 *     `ARBOR_ORGANIZATION_CONFIG_DIR/arbor.jsonc`) — an environment-variable
 *     or template-token name substituted at runtime, never a real directory
 *     in this repository (every real top-level/`packages/*` directory name
 *     here is lowercase-kebab).
 *   - a literal `...` path segment (`.../lock/state.json`) — an explicit
 *     elision marker, not a path.
 * Excluding these is not a weaker check on real drift: none of them could
 * ever resolve to a real file, by construction, so treating them as
 * citations would only ever produce permanent, unfixable floor noise —
 * exactly the false-positive shape ADR-130's Consequences warns will get a
 * zealous gate disabled.
 */
function isPlaceholderPath(path) {
  if (/^path\/to\//.test(path)) return true;
  const segments = path.split("/");
  if (segments.some((seg) => seg === "...")) return true;
  const first = segments[0];
  if (/^[A-Z][A-Z0-9_]*$/.test(first) && first.includes("_")) return true;
  return false;
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === "\n") line += 1;
  return line;
}

/** Blanks a matched span (same length, whitespace) so later passes over the
 * same text cannot re-match it. */
function blank(text, start, end) {
  return text.slice(0, start) + " ".repeat(end - start) + text.slice(end);
}

/**
 * Extracts every citation from one ADR's raw text, in priority order:
 * symbol-at-file first (consumes both backtick spans), then version, then
 * bare file. Returns a flat list of `{ kind, line, ...fields }`.
 */
export function extractCitations(rawText) {
  let text = stripFencedCodeBlocks(rawText);
  const citations = [];

  SYMBOL_AT_FILE_RE.lastIndex = 0;
  let m;
  const symbolMatches = [];
  while ((m = SYMBOL_AT_FILE_RE.exec(text))) symbolMatches.push(m);
  for (const match of symbolMatches) {
    if (!isPlaceholderPath(match[2])) {
      citations.push({
        kind: "symbol-at-file",
        line: lineNumberAt(rawText, match.index),
        symbol: match[1],
        file: match[2],
        lineCited: match[3] ? Number(match[3]) : null,
        raw: match[0],
      });
    }
    text = blank(text, match.index, match.index + match[0].length);
  }

  VERSION_CITATION_RE.lastIndex = 0;
  const versionMatches = [];
  while ((m = VERSION_CITATION_RE.exec(text))) versionMatches.push(m);
  for (const match of versionMatches) {
    citations.push({
      kind: "dependency-version",
      line: lineNumberAt(rawText, match.index),
      pkg: match[1],
      version: match[2],
      raw: match[0],
    });
    text = blank(text, match.index, match.index + match[0].length);
  }

  FILE_CITATION_RE.lastIndex = 0;
  const fileMatches = [];
  while ((m = FILE_CITATION_RE.exec(text))) fileMatches.push(m);
  for (const match of fileMatches) {
    if (!isPlaceholderPath(match[1])) {
      citations.push({
        kind: "file",
        line: lineNumberAt(rawText, match.index),
        file: match[1],
        lineCited: match[2] ? Number(match[2]) : null,
        raw: match[0],
      });
    }
    text = blank(text, match.index, match.index + match[0].length);
  }

  citations.sort((a, b) => a.line - b.line);
  return citations;
}

// ---------------------------------------------------------------------------
// Resolution — file existence, symbol resolution (via @arbor/governance),
// dependency versions (via package.json manifests).
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".turbo", ".arbor", ".visual-intelligence", ".cache", ".claim-ledger", ".determinism-baseline", ".completion-depth"]);

/** Lazily-built basename -> [repo-relative paths] index, for citations that
 * name a bare filename with no directory (this corpus's real, observed
 * shape — e.g. "`tui.ts:26`", ADR-130's own Context). Built once per process. */
let basenameIndexCache = null;
export function buildBasenameIndex(repoRoot) {
  if (basenameIndexCache) return basenameIndexCache;
  const index = new Map();
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const rel = full.slice(repoRoot.length + 1);
        const list = index.get(entry.name) ?? [];
        list.push(rel);
        index.set(entry.name, list);
      }
    }
  }
  walk(repoRoot);
  basenameIndexCache = index;
  return index;
}

/** Package-directory names actually under `packages/` (e.g. "arbor-mcp"),
 * used to recognize this corpus's dominant citation shorthand — see
 * `candidatePathsFor`. Lazily read once per process. */
let packageDirNamesCache = null;
function packageDirNames(repoRoot) {
  if (packageDirNamesCache) return packageDirNamesCache;
  try {
    packageDirNamesCache = new Set(readdirSync(join(repoRoot, "packages")));
  } catch {
    packageDirNamesCache = new Set();
  }
  return packageDirNamesCache;
}

/** Test-only: force the next `buildBasenameIndex`/`packageDirNames` call to
 * rebuild — both caches are per-process, not per-repoRoot, so a test
 * switching fixture repos must reset both or risk resolving against a
 * stale prior root. */
export function resetBasenameIndexCache() {
  basenameIndexCache = null;
  packageDirNamesCache = null;
}

/**
 * Candidate repo-relative paths for a cited path. Handles two shapes this
 * corpus actually uses:
 *   - a bare filename ("tui.ts") — every file in the repo sharing that
 *     basename.
 *   - a path whose first segment already names a real `packages/*` directory
 *     ("arbor-mcp/src/x.ts") — BOTH the literal citation and the same path
 *     under `packages/` ("packages/arbor-mcp/src/x.ts"), because this
 *     corpus's dominant citation shorthand drops the `packages/` prefix
 *     entirely (measured: the large majority of this gate's raw path
 *     citations use this exact shorthand). Treating only the literal
 *     citation as the candidate would flag nearly the whole corpus as
 *     broken on a citation CONVENTION, not real drift — precisely the
 *     false-positive failure mode ADR-130's Consequences warns against.
 */
function candidatePathsFor(citedPath, repoRoot) {
  if (!citedPath.includes("/")) {
    const index = buildBasenameIndex(repoRoot);
    return index.get(citedPath) ?? [];
  }
  const firstSegment = citedPath.split("/")[0];
  if (firstSegment !== "packages" && packageDirNames(repoRoot).has(firstSegment)) {
    return [citedPath, `packages/${citedPath}`];
  }
  return [citedPath];
}

/**
 * Resolves a `path[:N]` citation against the working tree. Conservative for
 * a bare filename with multiple candidates: resolved if ANY candidate exists
 * and (when a line was cited) has enough lines — an ambiguous bare name is
 * not itself grounds to flag real drift as broken, nor to paper over it: if
 * NO candidate resolves, that is reported honestly.
 */
export function resolveFileCitation(citedPath, lineCited, repoRoot) {
  const candidates = candidatePathsFor(citedPath, repoRoot);
  if (candidates.length === 0) {
    return { ok: false, reason: `no file named "${citedPath}" exists anywhere in the repository` };
  }
  const checked = [];
  for (const rel of candidates) {
    const abs = resolvePath(repoRoot, rel);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      checked.push(`${rel}: does not exist`);
      continue;
    }
    if (!stat.isFile()) {
      checked.push(`${rel}: not a file`);
      continue;
    }
    if (lineCited === null) return { ok: true, resolvedPath: rel };
    const lineCount = readFileSync(abs, "utf-8").split("\n").length;
    if (lineCount >= lineCited) return { ok: true, resolvedPath: rel };
    checked.push(`${rel}: only ${lineCount} line(s), cited line ${lineCited}`);
  }
  return { ok: false, reason: checked.join("; ") };
}

/**
 * Resolves a `` `Symbol` in/at `file` `` citation, reusing
 * `resolveProofComment` — the SAME resolver `gate:obligations` calls — rather
 * than a second implementation (ADR-130 Decision 2). `roundtrip` is
 * deliberately omitted: a prose citation makes no roundtrip-test claim, and
 * `resolveProofComment` treats an absent `roundtrip` as `missing` without
 * affecting the `symbol`/`file` fields this gate actually reads.
 */
export function resolveSymbolAtFileCitation(symbol, citedFile, lineCited, repoRoot) {
  const candidates = candidatePathsFor(citedFile, repoRoot);
  if (candidates.length === 0) {
    return { ok: false, reason: `no file named "${citedFile}" exists anywhere in the repository` };
  }
  const checked = [];
  for (const rel of candidates) {
    if (lineCited !== null) {
      const fileCheck = resolveFileCitation(rel, lineCited, repoRoot);
      if (!fileCheck.ok) {
        checked.push(`${rel}: ${fileCheck.reason}`);
        continue;
      }
    }
    const result = resolveProofComment(
      { raw: `symbol=${symbol} file=${rel}`, symbol, file: rel },
      { repoRoot, at: new Date().toISOString() },
    );
    if (!result.ok) {
      checked.push(`${rel}: ${result.error.message}`);
      continue;
    }
    if (result.value.symbol.state === "resolved") return { ok: true, resolvedPath: rel };
    checked.push(`${rel}: ${result.value.symbol.detail}`);
  }
  return { ok: false, reason: checked.join("; ") };
}

/** Package manifests actually present in this repository. */
function loadManifests(repoRoot) {
  const manifestPaths = [join(repoRoot, "package.json")];
  const packagesDir = join(repoRoot, "packages");
  let pkgDirs = [];
  try {
    pkgDirs = readdirSync(packagesDir);
  } catch {
    pkgDirs = [];
  }
  for (const dir of pkgDirs) manifestPaths.push(join(packagesDir, dir, "package.json"));
  const manifests = [];
  for (const p of manifestPaths) {
    try {
      manifests.push({ path: p, json: JSON.parse(readFileSync(p, "utf-8")) });
    } catch {
      // no manifest at this path — fine, not every packages/* dir has one
    }
  }
  return manifests;
}

/**
 * Resolves a `pkg@version` citation against every manifest this repo carries
 * for that package. A package this repo does not actually depend on is left
 * unresolved-but-not-flagged (`skip: true`) — the gate can only check what it
 * can find, and a package genuinely absent from every manifest is not
 * evidence of drift, just evidence this citation is not about our tree.
 */
export function resolveVersionCitation(pkg, citedVersion, repoRoot) {
  const manifests = loadManifests(repoRoot);
  const hits = [];
  for (const manifest of manifests) {
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      const actual = manifest.json[field]?.[pkg];
      if (actual !== undefined) hits.push({ manifestPath: manifest.path, field, actual });
    }
  }
  if (hits.length === 0) return { ok: true, skip: true, reason: `"${pkg}" is not a dependency in any manifest this repository carries` };

  const normalize = (v) => v.replace(/^[\^~]/, "").trim();
  for (const hit of hits) {
    if (normalize(hit.actual) === citedVersion) return { ok: true, resolvedManifest: hit.manifestPath };
  }
  const actualList = hits.map((h) => `${normalize(h.actual)} (${h.manifestPath})`).join(", ");
  return { ok: false, reason: `"${pkg}" is cited as ${citedVersion} but the manifest says ${actualList}` };
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/**
 * Non-retired ADRs' unresolvable-citation count as measured against this
 * corpus on 2026-08-26, the day this gate was introduced (ADR-130 Decision
 * 5): 116, across 47 records, out of 1206 citations this gate could verify.
 * Lower this only as records genuinely fix a citation; never raise it to make
 * room for new drift (same discipline as `adr-sections.mjs`'s
 * `ALTERNATIVES_FLOOR`).
 *
 * Ratcheted to 1 on 2026-08-27: a full pass over every unresolvable citation
 * in the corpus (98 originally reported, 115 measured fresh against this
 * worktree's HEAD before the pass — see the ADR citation-drift paydown
 * session) found each one was either a stale path (fixed to the real
 * location), a citation of a real-but-uncommitted/runtime-only artifact
 * (de-formatted out of the checkable citation grammar with an honest note),
 * or a citation of a class-method/local-variable/type-discriminant symbol
 * the proof grammar cannot express (rewritten to name the real file without
 * the checkable `Symbol` in/at/within `file` idiom). The real achieved count
 * is 0, not 1 — this is pinned to 1, not 0, only because
 * `scripts/tests/adr-citations.test.mjs`'s "counts a broken file citation"
 * fixture test (outside this pass's file ownership) asserts headroom above
 * zero for its counting-mechanism check (a synthetic 1-citation fixture
 * expected to stay under the floor). Lowering to 0 requires that test to
 * stop depending on the live exported constant first.
 */
export const UNRESOLVABLE_CITATIONS_FLOOR = 1;

export function auditAdrCitations(text, repoRoot) {
  const citations = extractCitations(text);
  const results = [];
  for (const citation of citations) {
    let resolution;
    if (citation.kind === "file") {
      resolution = resolveFileCitation(citation.file, citation.lineCited, repoRoot);
    } else if (citation.kind === "symbol-at-file") {
      resolution = resolveSymbolAtFileCitation(citation.symbol, citation.file, citation.lineCited, repoRoot);
    } else {
      resolution = resolveVersionCitation(citation.pkg, citation.version, repoRoot);
    }
    results.push({ citation, resolution });
  }
  return results;
}

export function runCitationsAudit(decisionsDir, repoRoot) {
  const adrs = loadAdrCorpus(decisionsDir);
  const violations = [];
  let checkedCitations = 0;
  let lineCitedCount = 0;
  let unresolvableCount = 0;

  for (const adr of adrs) {
    if (isRetired(adr.text)) continue;

    const audited = auditAdrCitations(adr.text, repoRoot);
    const problems = [];
    for (const { citation, resolution } of audited) {
      if (resolution.skip) continue;
      checkedCitations += 1;
      if ((citation.kind === "file" || citation.kind === "symbol-at-file") && citation.lineCited !== null) {
        lineCitedCount += 1;
      }
      if (!resolution.ok) {
        unresolvableCount += 1;
        problems.push({
          line: citation.line,
          citation: citation.raw,
          kind: citation.kind,
          reason: resolution.reason,
        });
      }
    }
    if (problems.length > 0) violations.push({ file: adr.file, problems });
  }

  const overFloor = unresolvableCount > UNRESOLVABLE_CITATIONS_FLOOR;
  return {
    ok: !overFloor,
    adrsChecked: adrs.length,
    citationsChecked: checkedCitations,
    lineCitedCount,
    unresolvableCount,
    unresolvableFloor: UNRESOLVABLE_CITATIONS_FLOOR,
    overFloor,
    violations,
  };
}

function printRemedy(violation) {
  for (const problem of violation.problems) {
    console.log(`    line ${problem.line}: ${problem.citation}`);
    console.log(`      ${problem.reason}`);
    console.log(`      Remedy: fix or remove this citation in ${violation.file} so it resolves against the current tree, or if the ADR is genuinely Retired/Superseded/Rejected, update its Status line so this gate exempts it.`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const decisionsDir = argValue(argv, "--decisions-dir") ?? join(argValue(argv, "--repo") ?? REPO_ROOT, "decisions");
  const repoRoot = argValue(argv, "--repo") ?? REPO_ROOT;
  const jsonMode = argv.includes("--json");

  const report = runCitationsAudit(decisionsDir, repoRoot);

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`gate:adr-citations — ${report.adrsChecked} ADR(s) checked, ${report.citationsChecked} citation(s) verified`);
    // See scripts/guard-canaries.mjs: a gate that reports how much it observed
    // lets the profile turn an empty corpus into `unresolved`, not `passed`.
    console.log(`observed_count: ${report.adrsChecked}`);
    console.log(`  Unresolvable citations: ${report.unresolvableCount} (floor ${report.unresolvableFloor}, ratchet only)`);
    console.log(`  Line-number citations (advisory ratchet, not blocking): ${report.lineCitedCount}`);
    if (report.violations.length > 0) {
      console.log(`\n  ${report.violations.length} record(s) with an unresolvable citation:\n`);
      for (const violation of report.violations) {
        console.log(`  ${violation.file}`);
        printRemedy(violation);
      }
    }
    if (report.overFloor) {
      console.log(`\nFAIL — ${report.unresolvableCount} unresolvable citation(s), above the floor of ${report.unresolvableFloor}.`);
    }
    console.log(report.ok ? "\nPASS" : "\nFAIL");
  }

  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
