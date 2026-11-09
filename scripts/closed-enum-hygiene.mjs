#!/usr/bin/env node
/**
 * scripts/closed-enum-hygiene.mjs — closed-enum hygiene gate (D4a).
 *
 * Usage:
 *   bun scripts/closed-enum-hygiene.mjs               # human-readable report, exits non-zero on violation
 *   bun scripts/closed-enum-hygiene.mjs --json        # machine-readable report on stdout
 *   bun scripts/closed-enum-hygiene.mjs --waivers <p> # point at a throwaway waiver store (tests only)
 *   bun run gate:closed-enum-hygiene                  # wired via package.json; included in `bun run check`
 *   bun run waiver add closed-enum-hygiene '{"check":"severityVocabulary","value":"...","reason":"...","expires":"YYYY-MM-DD"}'
 *   bun run waiver list closed-enum-hygiene           # CRUD via scripts/lib/waiver-store.mjs, same as
 *   bun run waiver remove closed-enum-hygiene '{"check":"...","value":"..."}' # reachability/anti-stub
 *
 * WAIVERS. A violation is a genuine, mechanically-detected set difference
 * (see "Conservative bias" below) — waiving one is a documented, dated
 * decision to accept a known drift rather than fix it immediately, keyed by
 * {check, value} through scripts/lib/waiver-store.mjs (the same primitive
 * reachability.mjs/branch-accounting.mjs/anti-stub.mjs/tui-catalog-parity.mjs
 * use). A waived violation is still printed (visibility), just excluded from
 * the blocking count; an expired or malformed waiver entry does NOT waive —
 * it blocks in its own right, so a stale waiver cannot silently keep hiding
 * real drift. Store: scripts/closed-enum-hygiene/waivers.json.
 *
 * What this closes
 * -----------------
 * revoy-spec's own hygiene test (tests/hygiene/test_adr_implementation_enum.py)
 * exists because of a measured failure: 27 of 159 records had `implementation`
 * values that drifted into free text ("Implemented", "Shipped", whole prose
 * sentences) before a gate closed it. Two hand-typed status axes rotted
 * exactly the way a closed enum prevents.
 *
 * revoy2's own status vector (DecisionStatus/ImplementationStatus/
 * VerificationStatus/ComplianceStatus in packages/arbor-governance/src/
 * contracts.ts) is COMPUTED, which structurally prevents that exact drift for
 * those fields (see "Already covered" below). But three real, currently
 * unenforced closed vocabularies were found in this repo that ARE asserted in
 * hand-typed prose and share revoy-spec's exact failure shape: a human writes
 * the value by hand in a document, and nothing checks it against the
 * vocabulary's own definition.
 *
 *   1. ADR decision-status prose. Every `decisions/*.md` file carries a
 *      hand-typed `**Status:** <word>` line (per
 *      docs/adr-governance-audit/terminology.md: "Today: one `**Status:**`
 *      line per ADR"). `DecisionStatus` (contracts.ts) is the closed
 *      vocabulary this line is supposed to draw from — draft/proposed/
 *      accepted/rejected/superseded — but nothing checked it before this
 *      gate. This is the closest analogue in this repo to revoy-spec's
 *      actual measured failure: a free-text status word, one per record,
 *      hand-typed by whoever wrote the file.
 *   2. The Severity vocabulary, independently RE-ASSERTED in prose.
 *      docs/adr-governance-audit/09-prior-art-and-self-hosting-roadmap.md
 *      §24.6.1 quotes contracts.ts's `Severity` union verbatim ("blocker" |
 *      "warning" | "informational") and says "only" — an explicit claim of
 *      completeness that silently goes stale the moment `Severity` gains,
 *      loses, or renames a member and nobody remembers to update the quote.
 *   3. The four defect shapes (Unreached / Hollow / Degraded seam /
 *      Unwitnessed claim) — a closed vocabulary with NO type-system backing
 *      at all (a pure audit/analysis term, unlike the vocabularies above),
 *      independently hand-authored in two places: ROADMAP.md's Phase 6 table
 *      and docs/adr-governance-audit/terminology.md's "Defect shape" row.
 *      Two independent hand-typed assertions of one set is exactly the "two
 *      hand-typed status axes" shape that rotted in revoy-spec.
 *
 * What was checked and found ALREADY covered (not duplicated here)
 * ------------------------------------------------------------------
 * - `ImplementationStatus`/`VerificationStatus`/`ComplianceStatus`: COMPUTED
 *   from obligation-proof resolution, never hand-set (contracts.ts's own doc
 *   comments say so) — structurally not a hand-typed-prose risk today, the
 *   same reason `DecisionStatus`'s siblings needed no gate here.
 * - ROADMAP.md's ✅/CLOSED/RESOLVED/RATIFIED tranche markers: cross-checked
 *   against real proof (test pass/fail, roundtrip status) by
 *   scripts/docs-truth.mjs already. A different vocabulary, same rigor — not
 *   re-implemented here.
 * - `Confidence`, `DiscoveryMethod`, `ArtifactKind`: real
 *   closed TS union types in contracts.ts, but referenced only inside
 *   packages/arbor-governance (out of this lane's file scope to instrument)
 *   or embedded in architecture-doc prose alongside qualifying annotations
 *   ("medium — proves a test exists, not that it tests this", "low today")
 *   that make exact-set extraction from that prose genuinely ambiguous.
 *   Forcing a check there risks exactly the false-accusation shape this
 *   gate's own stated policy (below) refuses to ship. Assessed, not gated —
 *   recorded here rather than silently skipped.
 * - `EnforcementMode` was listed above until 2026-08-19, described as
 *   "referenced only inside packages/arbor-governance". It was referenced
 *   nowhere at all — declaration and barrel re-export only — and has been
 *   deleted. The wording implied uses that did not exist, which is why the
 *   type survived: a reader checking this list would conclude it was in
 *   service. Recorded because the same shape (a stated reason asserting more
 *   than it can show) is tracked as D20.
 * - Gap-register CLOSED/OPEN/NARROWED classification words: free-form prose
 *   per G-NN row, not a closed vocabulary anywhere (no document declares the
 *   complete set the way the defect shapes or Severity are declared) — there
 *   is no "documented definition" to cross-check against, only usage. Not a
 *   closed-enum-hygiene candidate; a different gate's concern if one is ever
 *   written.
 *
 * Conservative bias (ADR-117, stated explicitly per §24.2 P8): a missed
 * drift is acceptable; a false accusation is not. Every check below only
 * fires on an exact, unambiguous set difference between two independently
 * extracted term lists — never a fuzzy/partial text match. This mirrors
 * registration-integrity.mjs's own stated bias ("prefer silence over a false
 * accusation") and deliberately trades detection of a near-miss typo (e.g. a
 * defect-shape label subtly misspelled somewhere other than the two
 * canonical definition sites this gate reads) for zero false positives on
 * this repo's real, noisy prose — this repo uses the bare word "shape" 20+
 * times for unrelated things ("HTTP shape", "OMO shape", "Entry shape"); a
 * looser match would have flagged all of them (verified empirically while
 * building this gate).
 *
 * Constraints honored (same as registration-integrity.mjs)
 * ----------------------------------------------------------
 * - TypeScript compiler API only (`typescript`, already a devDependency),
 *   used purely syntactically — no Program/type-checker, no tsconfig
 *   resolution.
 * - No new dependency of any kind.
 * - Never imports or executes any analyzed module (contracts.ts or any doc)
 *   — every file is read with readFileSync and parsed as text/AST only.
 * - Deterministic: no timestamps, no wall-clock dependence, sorted
 *   directory listings.
 * - Exits via process.exitCode, not process.exit() — stdout can be a pipe,
 *   and process.exit() right after a large console.log can truncate the
 *   write mid-flush.
 * - The exported check functions (`extractStringUnionType`,
 *   `checkAdrStatusVocabulary`, `checkSeverityVocabulary`,
 *   `checkDefectShapeVocabulary`, and their extraction helpers) are pure:
 *   given source text, they return a result with no filesystem or process
 *   access — unit-testable against synthetic fixtures without touching this
 *   repo's real files, which is what makes the whole scan/report/exit
 *   sequence below safe to gate behind isDirectExecution().
 */

import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { findWaiverEntry, isWaiverExpired, loadWaiverFile, validateWaiverEntry } from "./lib/waiver-store.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, "..");
const JSON_OUTPUT = process.argv.includes("--json");

// `--waivers <path>` mirrors reachability.mjs's `--allowlist` override — lets
// a test point this gate at a throwaway waiver store without touching the
// real one.
function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}
const WAIVERS_PATH = argValue("--waivers") ?? join(__dirname, "closed-enum-hygiene", "waivers.json");
const { entries: WAIVER_ENTRIES, error: waiverFileError } = loadWaiverFile(WAIVERS_PATH);

// ---------------------------------------------------------------------------
// Shared AST helper.
// ---------------------------------------------------------------------------

function parseTs(fileName, text) {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TS);
}

/**
 * Extract the string-literal members of a top-level `export type <typeName> =
 * "a" | "b" | ...;` declaration. Returns `{ members: null, error }` (never a
 * guessed/partial list) if the declaration is missing or is not a pure
 * string-literal union — the false-DEAD-avoidance policy this repo's other
 * gates already follow: an unrecognized shape is a diagnostic, not a
 * fabricated result.
 */
export function extractStringUnionType(sourceText, typeName) {
  const sourceFile = parseTs("contracts.ts", sourceText);
  for (const stmt of sourceFile.statements) {
    if (!ts.isTypeAliasDeclaration(stmt) || stmt.name.text !== typeName) continue;
    const type = stmt.type;
    if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) {
      return { members: [type.literal.text], error: null };
    }
    if (!ts.isUnionTypeNode(type)) {
      return { members: null, error: `type '${typeName}' is not a string-literal union` };
    }
    const members = [];
    for (const t of type.types) {
      if (!ts.isLiteralTypeNode(t) || !ts.isStringLiteral(t.literal)) {
        return { members: null, error: `type '${typeName}' has a non-string-literal member` };
      }
      members.push(t.literal.text);
    }
    return { members, error: null };
  }
  return { members: null, error: `no top-level type alias '${typeName}' found` };
}

// ---------------------------------------------------------------------------
// Check 1 — ADR decision-status prose (decisions/*.md `**Status:**` lines).
// ---------------------------------------------------------------------------

const STATUS_LINE_RE = /^\*\*Status(?:\s*\([^)]*\))?:\*\*\s*(.+)$/m;

/**
 * decisionFiles: [{ file: "decisions/ADR-NNN-*.md", text: "<full contents>" }]
 * decisionStatusMembers: the closed vocabulary (from contracts.ts's
 * DecisionStatus), compared case-insensitively since prose capitalizes it
 * ("Accepted") while the TS type does not ("accepted").
 *
 * Only the "value in use not in the enum" direction is checked. The reverse
 * (an enum member no ADR currently uses — e.g. "rejected"/"superseded" in a
 * corpus where every record so far is accepted or in flight) is normal,
 * expected, drift-free state, not a defect. Flagging it would itself be the
 * false accusation this gate's stated policy refuses to ship.
 */
export function checkAdrStatusVocabulary(decisionFiles, decisionStatusMembers) {
  const allowed = new Set(decisionStatusMembers.map((m) => m.toLowerCase()));
  const violations = [];
  for (const { file, text } of decisionFiles) {
    const match = STATUS_LINE_RE.exec(text);
    if (!match) continue; // no Status line found — not this gate's claim to make
    const word = match[1].trim().match(/^[A-Za-z][A-Za-z-]*/)?.[0];
    if (!word) continue;
    if (!allowed.has(word.toLowerCase())) {
      violations.push({
        file,
        value: word,
        reason: `"**Status:** ${word}" is not one of the documented DecisionStatus values (${decisionStatusMembers.join(", ")})`,
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Check 2 — Severity vocabulary: contracts.ts vs. its own prose re-quote.
// ---------------------------------------------------------------------------

const SEVERITY_ANCHOR = "Severity vocabulary:";
const SEVERITY_END_MARKER = ") only";

/**
 * Extract the backtick-quoted string-literal list from a "Severity
 * vocabulary: ... only" prose block (the exact phrasing used in
 * docs/adr-governance-audit/09-prior-art-and-self-hosting-roadmap.md
 * §24.6.1). Returns null if the anchor phrase isn't present — a doc that
 * stopped re-quoting the vocabulary entirely is not this check's claim to
 * make.
 */
export function extractDocSeverityQuote(docText) {
  const anchorIdx = docText.indexOf(SEVERITY_ANCHOR);
  if (anchorIdx === -1) return null;
  const endIdx = docText.indexOf(SEVERITY_END_MARKER, anchorIdx);
  if (endIdx === -1) return null;
  const block = docText.slice(anchorIdx, endIdx + SEVERITY_END_MARKER.length);
  return [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

/**
 * contractsSourceText: full source of packages/arbor-governance/src/contracts.ts.
 * docText: full source of the doc quoting Severity's vocabulary in prose.
 * Bidirectional: both sides independently claim to be a complete definition
 * of the same set ("only"), so a member present in one and absent from the
 * other is a genuine drift regardless of which side moved.
 */
export function checkSeverityVocabulary(contractsSourceText, docText) {
  const { members: codeMembers, error } = extractStringUnionType(contractsSourceText, "Severity");
  if (error) return [{ reason: `could not extract Severity from contracts.ts: ${error}` }];
  const docMembers = extractDocSeverityQuote(docText);
  if (docMembers === null) return []; // doc no longer re-quotes it at all — not this check's claim

  const violations = [];
  const codeSet = new Set(codeMembers);
  const docSet = new Set(docMembers);
  for (const m of codeMembers) {
    if (!docSet.has(m)) {
      violations.push({ value: m, reason: `Severity member "${m}" exists in contracts.ts but the doc's "Severity vocabulary: ... only" quote omits it — the quote is stale` });
    }
  }
  for (const m of docMembers) {
    if (!codeSet.has(m)) {
      violations.push({ value: m, reason: `the doc's "Severity vocabulary: ... only" quote lists "${m}", but contracts.ts's Severity type has no such member` });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Check 3 — the four defect shapes: ROADMAP.md vs. terminology.md.
// ---------------------------------------------------------------------------

const SHAPE_TABLE_ANCHOR = "**The four shapes, from the audit:**";
const SHAPE_TABLE_END = "### Strength ladder";

/** Extract the bolded first-column shape names from ROADMAP.md's Phase 6 table. */
export function extractRoadmapDefectShapes(roadmapText) {
  const start = roadmapText.indexOf(SHAPE_TABLE_ANCHOR);
  if (start === -1) return null;
  const end = roadmapText.indexOf(SHAPE_TABLE_END, start);
  const section = end === -1 ? roadmapText.slice(start) : roadmapText.slice(start, end);
  const shapes = [];
  for (const line of section.split("\n")) {
    const m = line.match(/^\|\s*\*\*([A-Za-z][A-Za-z ]*)\*\*\s*\|/);
    if (m) shapes.push(m[1].trim());
  }
  return shapes.length > 0 ? shapes : null;
}

/** Extract the backtick-quoted, "/"-separated shape list from terminology.md's "Defect shape" row. */
export function extractTerminologyDefectShapes(terminologyText) {
  const line = terminologyText.split("\n").find((l) => l.includes("**Defect shape**"));
  if (!line) return null;
  const m = line.match(/`([^`]+)`/);
  if (!m) return null;
  const shapes = m[1].split("/").map((s) => s.trim().replace(/\.$/, "")).filter(Boolean);
  return shapes.length > 0 ? shapes : null;
}

/** Bidirectional: two independent hand-authored assertions of the same closed set. */
export function checkDefectShapeVocabulary(roadmapText, terminologyText) {
  const roadmapShapes = extractRoadmapDefectShapes(roadmapText);
  const terminologyShapes = extractTerminologyDefectShapes(terminologyText);
  if (roadmapShapes === null || terminologyShapes === null) return []; // either source stopped asserting the vocabulary — not this check's claim

  const violations = [];
  const roadmapSet = new Set(roadmapShapes);
  const terminologySet = new Set(terminologyShapes);
  for (const s of roadmapShapes) {
    if (!terminologySet.has(s)) {
      violations.push({ value: s, reason: `ROADMAP.md's Phase 6 table declares defect shape "${s}", but terminology.md's "Defect shape" row omits it` });
    }
  }
  for (const s of terminologyShapes) {
    if (!roadmapSet.has(s)) {
      violations.push({ value: s, reason: `terminology.md's "Defect shape" row declares "${s}", but ROADMAP.md's Phase 6 table omits it` });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Direct-execution guard + main().
// ---------------------------------------------------------------------------

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolvePath(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function readRepoFile(relPath) {
  return readFileSync(join(REPO_ROOT, relPath), "utf-8");
}

function listDecisionFiles() {
  return readdirSync(join(REPO_ROOT, "decisions"))
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => ({ file: `decisions/${name}`, text: readFileSync(join(REPO_ROOT, "decisions", name), "utf-8") }));
}

/**
 * Split one check's raw violations against the waiver store, the same
 * three-way split reachability.mjs applies to its allowlist: an entry keyed
 * by {check, value} that validates and hasn't lapsed WAIVES the violation
 * (excluded from the blocking count, still reported for visibility); a
 * missing key finds none; an invalid or expired entry does NOT waive — it is
 * reported as its own finding so the remedy is "fix/renew the waiver", not
 * "fix the vocabulary".
 */
export function partitionAgainstWaivers(checkName, rawViolations, today, waiverEntries = WAIVER_ENTRIES) {
  const blocking = [];
  const waived = [];
  const expired = [];
  const malformed = [];
  for (const violation of rawViolations) {
    // A violation with no `value` (e.g. an extraction-error placeholder) can
    // never be keyed — it always blocks.
    if (typeof violation.value !== "string") {
      blocking.push(violation);
      continue;
    }
    const keyValues = { check: checkName, value: violation.value };
    const entry = findWaiverEntry(waiverEntries, keyValues, "closed-enum-hygiene");
    if (!entry) {
      blocking.push(violation);
      continue;
    }
    const { ok: validEntry, errors } = validateWaiverEntry(entry, "closed-enum-hygiene");
    if (!validEntry) {
      malformed.push({ violation, entry, errors });
      continue;
    }
    if (isWaiverExpired(entry, "closed-enum-hygiene", today)) {
      expired.push({ violation, entry });
      continue;
    }
    waived.push({ violation, entry });
  }
  return { blocking, waived, expired, malformed };
}

function main() {
  const report = { ok: true, checks: {}, waivers: {} };
  const today = new Date().toISOString().slice(0, 10);

  const contractsText = readRepoFile("packages/arbor-governance/src/contracts.ts");

  const { members: decisionStatusMembers, error: decisionStatusError } = extractStringUnionType(contractsText, "DecisionStatus");
  const rawChecks = {
    adrStatusVocabulary: decisionStatusError
      ? [{ reason: `could not extract DecisionStatus from contracts.ts: ${decisionStatusError}` }]
      : checkAdrStatusVocabulary(listDecisionFiles(), decisionStatusMembers),
    severityVocabulary: checkSeverityVocabulary(
      contractsText,
      readRepoFile("docs/adr-governance-audit/09-prior-art-and-self-hosting-roadmap.md"),
    ),
    defectShapeVocabulary: checkDefectShapeVocabulary(
      readRepoFile("ROADMAP.md"),
      readRepoFile("docs/adr-governance-audit/terminology.md"),
    ),
  };

  let totalViolations = 0;
  let totalUnwaived = 0; // malformed + expired waiver entries also block
  for (const [name, rawViolations] of Object.entries(rawChecks)) {
    const { blocking, waived, expired, malformed } = partitionAgainstWaivers(name, rawViolations, today);
    report.checks[name] = blocking.concat(expired.map((e) => e.violation), malformed.map((m) => m.violation));
    report.waivers[name] = { waived, expired, malformed };
    totalViolations += rawViolations.length;
    totalUnwaived += report.checks[name].length;
  }

  report.ok = totalUnwaived === 0 && !waiverFileError;
  report.totalViolations = totalViolations;
  report.totalUnwaived = totalUnwaived;
  report.waiverFileError = waiverFileError;

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`closed-enum-hygiene gate — ${totalUnwaived} unwaived violation(s) of ${totalViolations} total, across 3 checks\n`);
    if (waiverFileError) console.log(`! waiver store error: ${waiverFileError}\n`);
    for (const [name, violations] of Object.entries(report.checks)) {
      console.log(`${name}: ${violations.length} unwaived violation(s)`);
      for (const v of violations) {
        console.log(`  - ${v.file ? `${v.file}: ` : ""}${v.reason}`);
      }
      const { waived, expired, malformed } = report.waivers[name];
      for (const { violation, entry } of waived) {
        console.log(`  (waived until ${entry.expires}: ${violation.value} — ${entry.reason})`);
      }
      for (const { violation, entry } of expired) {
        console.log(`  ! waiver for "${violation.value}" expired ${entry.expires} — renew with \`bun run waiver renew closed-enum-hygiene\``);
      }
      for (const { violation, errors } of malformed) {
        console.log(`  ! waiver for "${violation.value}" is malformed: ${errors.join("; ")}`);
      }
    }
    console.log("");
    console.log(report.ok ? "PASS" : "FAIL");
  }

  // Not process.exit(): see reachability.mjs's identical note — stdout can be
  // a pipe, and process.exit() right after a large console.log can truncate
  // the write mid-flush.
  process.exitCode = report.ok ? 0 : 1;
}

if (isDirectExecution()) {
  main();
}
