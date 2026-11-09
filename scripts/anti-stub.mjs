#!/usr/bin/env node
/**
 * scripts/anti-stub.mjs — Phase 6.5 static anti-stub rules.
 *
 * Usage:
 *   bun scripts/anti-stub.mjs             # report-only, always exits 0
 *   bun scripts/anti-stub.mjs --blocking  # exits non-zero if any rule fires
 *   bun scripts/anti-stub.mjs --json      # machine-readable report on stdout
 *   bun run gate:anti-stub                # report-only, wired via package.json
 *
 * Status: REPORT-ONLY BY DEFAULT; `--blocking` fails on UNTRIAGED findings.
 *
 * This block used to carry a hand-written finding count. It was wrong twice —
 * it claimed 10 when the gate reported 11, then 11 when it reported 10 — which
 * is the Unwitnessed-claim shape living inside the gate built to find it. The
 * count is now derived and printed by the gate itself; the per-finding
 * verdicts live in the TRIAGE table below, keyed by rule + file + symbol so
 * they survive edits that move line numbers.
 *
 * Blanket `--blocking` on total findings was never viable: most current
 * findings are false positives (a JSON.parse inside `fromJSONL` is the
 * function's job, not scraped control flow), so it would fail the build
 * permanently and be switched straight back off. Blocking on UNTRIAGED
 * findings instead means the gate can stay on: the known set is judged once,
 * and anything new fails until a human judges it too.
 *
 * What it does
 * ------------
 * Five AST rules for the residue ROADMAP.md §6.5 says the type system
 * (§6.4) cannot reach on its own. Each is a heuristic, static, single-file
 * or single-schema analysis — not a full points-to/dataflow engine — and is
 * documented as such at each rule's implementation. A finding here is a
 * *lead*, not an automatic verdict; the human report accompanying this
 * wave's dispatch triages genuine hits from false positives.
 *
 * 1. No placeholder literal in a ledger record. A call to a ledger-record
 *    authoring function (name matching /^(record|persist|append)[A-Z]/,
 *    e.g. `recordCompactionLifecycle`) whose object-literal argument has a
 *    top-level property that (a) looks like an identifier/pointer field
 *    (`*_id`, `*_hash`, `*_pointer`) and is initialized to `""`, or (b)
 *    looks like a measured quantity (`*cost*`, `*amount*`, `*count*`,
 *    `*bytes*`, `*duration*`, `*tokens*`) and is initialized to the literal
 *    `0`, or (c) is initialized to `null`.
 *
 * 2. No config key without a reader. Every leaf key in
 *    `arbor-config/src/schema.ts`'s `CONFIG_JSON_SCHEMA` must appear as a
 *    property/element access somewhere under `packages/*\/src` outside
 *    `arbor-config/src` itself (a schema module reading its own key back
 *    doesn't count as a runtime reader). Leaf key = a schema property with
 *    no nested `properties`/`additionalProperties.properties` of its own.
 *
 * 3. No TODO standing in for behavior. A `TODO`/`FIXME` comment whose
 *    innermost enclosing function-like declaration has a "trivial" body —
 *    at most one statement, and that statement is a bare `return` (no
 *    value, or a literal/undefined), or a `throw`.
 *
 * 4. No text-scraped control flow. A `JSON.parse(...)` call that consumes
 *    locally-traceable output from a `node:child_process` API, or a parse
 *    inside a parser helper whose parameter is named like a subprocess
 *    stream (`raw`, `stdout`, `stderr`, `output`, `response`). The first arm
 *    follows direct output, spawn result streams, simple aliases, and output
 *    callbacks; it does not report unrelated JSON reads just because their
 *    file also imports child_process.
 *
 * 5. No tautological test (packages/*\/tests, not src — the only rule here
 *    that scans tests). Two narrow, independently-detected syntactic
 *    shapes; logic lives in scripts/anti-stub-rules.mjs (unit-tested there
 *    against synthetic fixtures reproducing the exact historical instance,
 *    scripts/tests/anti-stub-rule5.test.mjs) because it needs no
 *    cross-file/type-checker context:
 *      5a. `expect(<expr>.length|.size).toBeGreaterThanOrEqual(0)` (or the
 *          `.toBeGreaterThan(-1)` equivalent) — never fails; length/size is
 *          never negative.
 *      5b. A real `expect(...)` assertion inside `if (<bareIdentifier>) {}`
 *          with no `else` and no prior `expect(<identifier>).toBeDefined()`
 *          (or equivalent) establishing the guard — the assertion never
 *          runs when the guard is false, and the test passes regardless.
 *    Both shapes are exactly what shipped and went undetected as
 *    ROADMAP.md's G-24 (arbor-opencode/tests/loop.test.ts, fixed 2026-08-04,
 *    commit af9caa8) — see anti-stub-rules.mjs's header comment for the full
 *    rationale, scoping, and the one known tautological-test shape (the
 *    original 4D.3 capability-routing test, a *semantic* non-discrimination
 *    defect rather than a syntactic one) this rule does not and cannot
 *    mechanically catch.
 *
 * Conservative bias (stated explicitly; D4b, §24.2 P8) — each rule is
 * individually SCOPED to prefer silence over a false accusation (same
 * ADR-117 direction as registration-integrity.mjs): Rule 5b's bare-identifier
 * restriction, the guard-established-earlier suppression, and Rule 1's
 * identifier-shape narrowing all exist specifically to avoid flagging
 * genuine, widely-used patterns (see each rule's own "why this shape" note
 * above for the exact false-positive it was built to avoid). But that
 * per-rule design intent has NOT yet delivered a false-accusation-free gate
 * in practice: of this gate's current real findings, most are confirmed
 * false positives on individual inspection (see "Status" above for the
 * itemized count) — an honest gap between intent and current precision,
 * not a claim this header papers over. That gap is exactly why this gate
 * defaults to REPORT-ONLY rather than blocking: it cannot yet honestly
 * claim the "false-DEAD is not acceptable" guarantee its own rule design
 * aims at, so it does not enforce blocking until each finding is
 * individually triaged (`--blocking` is opt-in, never default).
 *
 * Constraints honored
 * --------------------
 * - TypeScript compiler API only (already a devDependency). No new
 *   dependency of any kind.
 * - No .codegraph/ or revoy.lsp MCP tools — clean checkout + `bun install`.
 *
 * `--root` and the profile seam (Roadmap 23 B2, ADR-073 follow-up)
 * -------------------------------------------------------------------
 * The package-collection walk below (Rules 1/3/4 over `<source-root>/*\/src`,
 * Rule 5 over `<source-root>/*\/tests`) used to hardcode a single literal
 * `packages` directory. It now walks every root in `profileOrDefaults(ROOT)
 * .source_roots` (`profileOrDefaults` never throws and falls back to
 * `["packages"]` for a repo with no `arbor.profile.jsonc`, so this repo's
 * default invocation is unchanged). `--root <path>` (or `--root=<path>`)
 * lets the gate target a different project entirely, defaulting to this
 * script's own `__dirname/..` — see `scripts/tests/anti-stub-root.test.mjs`
 * for the parity and real-retargeting proof.
 *
 * Rule 2's `arbor-config/src/schema.ts` path and Rule 2's known-package
 * TRIAGE entries deliberately stay literal: they name a specific package by
 * name (arbor-config, arbor-mcp, ...), which is business logic about THIS
 * repo's packages, not the `packages/` source-root prefix ADR-073 scoped
 * this follow-up to de-literalize. Only the source-root *prefix* on those
 * paths is now profile-derived; the package name after it is unchanged.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { parseSnippet, checkLengthTautology, checkVacuousGuardedAssertion, findSubprocessOutputJsonParses } from "./anti-stub-rules.mjs";
import { profileOrDefaults } from "./lib/project-profile.mjs";
import {
  loadWaiverFile, validateWaiverEntry, isWaiverExpired,
  addWaiverEntry, renewWaiverEntry, writeWaiverFile, findWaiverEntry, WAIVER_SCHEMAS,
} from "./lib/waiver-store.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolvePath(__dirname, "..");

/** `--triage <path>` override — see its use-site below for why. */
function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}

/** Same contract as scripts/project-conform.mjs's `resolveRootArg`. */
export function resolveRootArg(argv, fallback = DEFAULT_ROOT) {
  const inline = argv.find((a) => a.startsWith("--root="));
  if (inline !== undefined) {
    const value = inline.slice("--root=".length);
    if (value === "") throw new Error("--root requires a path");
    return resolvePath(value);
  }
  const index = argv.indexOf("--root");
  if (index === -1) return resolvePath(fallback);
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error("--root requires a path");
  return resolvePath(value);
}

let REPO_ROOT;
try {
  REPO_ROOT = resolveRootArg(process.argv.slice(2));
} catch (error) {
  console.error(`anti-stub: ${error.message}`);
  process.exit(2);
}
const JSON_OUTPUT = process.argv.includes("--json");
const BLOCKING = process.argv.includes("--blocking");
/**
 * `--triage` is dual-purposed, deliberately disambiguated by the presence of
 * `--verdict` rather than by a second flag name:
 *   - `--triage <path>` (no `--verdict`) — the PRE-EXISTING fixture override
 *     letting a test point this gate at a throwaway triage store
 *     (scripts/tests/anti-stub-triage-expiry.test.mjs), unchanged below.
 *   - `--triage <rule>::<file>::<symbol> --verdict <v> --reason "..."` — the
 *     authoring verb (see runTriageVerb below), mirroring completion-depth.mjs's
 *     `--triage` surface. A path override never passes `--verdict`, and the
 *     verb always must, so the two never collide in practice.
 */
const TRIAGE_VERB = process.argv.includes("--triage") && process.argv.includes("--verdict");
const SOURCE_ROOTS = profileOrDefaults(REPO_ROOT).source_roots;

// ---------------------------------------------------------------------------
// 1. Collect source files (same walk as reachability.mjs: each profile
//    source root's */src, excluding tests and .d.ts).
// ---------------------------------------------------------------------------

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
}

const packagesDirs = SOURCE_ROOTS.map((sourceRoot) => join(REPO_ROOT, sourceRoot));
const srcFiles = [];
for (const packagesDir of packagesDirs) {
  let pkgEntries;
  try {
    pkgEntries = readdirSync(packagesDir);
  } catch {
    continue; // this source root doesn't exist under REPO_ROOT — skip
  }
  for (const pkg of pkgEntries) {
    const srcDir = join(packagesDir, pkg, "src");
    try {
      if (statSync(srcDir).isDirectory()) walk(srcDir, srcFiles);
    } catch {
      // no src/ — skip
    }
  }
}

const rootTsconfigPath = join(REPO_ROOT, "tsconfig.json");
const rootTsconfigJson = ts.readConfigFile(rootTsconfigPath, ts.sys.readFile).config;
const parsed = ts.parseJsonConfigFileContent(
  { ...rootTsconfigJson, files: [], include: undefined, exclude: undefined },
  ts.sys,
  REPO_ROOT,
);
const compilerOptions = { ...parsed.options, noEmit: true, declaration: false, sourceMap: false, composite: false, incremental: false };
const program = ts.createProgram(srcFiles, compilerOptions);
// Force the binder to run (sets .parent on every node) — without this,
// ts.createProgram alone parses but does not bind, so `.parent` is
// undefined and every enclosing-function walk (rules 3 and 4) silently
// fails to find anything above the node itself.
const checker = program.getTypeChecker();

function relPath(fileName) {
  return relative(REPO_ROOT, fileName).replace(/\\/g, "/");
}

const findings = { rule1: [], rule2: [], rule3: [], rule4_strong: [], rule4_weak: [], rule5_length: [], rule5_guard: [] };

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

// ---------------------------------------------------------------------------
// Rule 1 — placeholder literal in a ledger record.
// ---------------------------------------------------------------------------

const LEDGER_CALL_RE = /^(record|persist|append)[A-Z]/;
const ID_FIELD_RE = /(_id|_hash|_pointer)$/;
const MEASURED_FIELD_RE = /(cost|amount|count|bytes|duration|tokens)/i;

function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return undefined;
}

function checkRule1(sourceFile, node) {
  if (!ts.isCallExpression(node)) return;
  const name = calleeName(node.expression);
  if (!name || !LEDGER_CALL_RE.test(name)) return;
  const arg = node.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return;
  for (const prop of arg.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
    const field = prop.name.text;
    const init = prop.initializer;
    let hit;
    if (init.kind === ts.SyntaxKind.NullKeyword) hit = "null";
    else if (ts.isStringLiteral(init) && init.text === "" && ID_FIELD_RE.test(field)) hit = 'empty string ""';
    else if (ts.isNumericLiteral(init) && init.text === "0" && MEASURED_FIELD_RE.test(field)) hit = "literal 0";
    if (hit) {
      findings.rule1.push({
        file: relPath(sourceFile.fileName),
        line: lineOf(sourceFile, prop),
        call: name,
        field,
        value: hit,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Rule 3 — TODO/FIXME standing in for behavior.
// ---------------------------------------------------------------------------

function findEnclosingFunction(node) {
  let n = node.parent;
  while (n) {
    if (
      ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n) ||
      ts.isFunctionExpression(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n)
    ) {
      return n;
    }
    n = n.parent;
  }
  return undefined;
}

function isTrivialBody(fn) {
  const body = fn.body;
  if (!body) return true; // no body at all (overload signature) — nothing to implement here
  if (ts.isBlock(body)) {
    const stmts = body.statements.filter((s) => !ts.isEmptyStatement(s));
    if (stmts.length === 0) return true;
    if (stmts.length > 1) return false;
    const only = stmts[0];
    if (ts.isThrowStatement(only)) return true;
    if (ts.isReturnStatement(only)) {
      if (!only.expression) return true;
      if (only.expression.kind === ts.SyntaxKind.UndefinedKeyword) return true;
      if (ts.isIdentifier(only.expression) && only.expression.text === "undefined") return true;
      // A literal return (string/number/bool/null) from an otherwise-empty
      // body is still "trivial" in the sense this rule cares about: no real
      // work happens between entry and the return.
      if (
        ts.isStringLiteral(only.expression) || ts.isNumericLiteral(only.expression) ||
        only.expression.kind === ts.SyntaxKind.TrueKeyword || only.expression.kind === ts.SyntaxKind.FalseKeyword ||
        only.expression.kind === ts.SyntaxKind.NullKeyword
      ) {
        return true;
      }
    }
    return false;
  }
  return false; // concise arrow body `=> expr` is never "trivial" in this sense
}

function checkRule3(sourceFile) {
  const text = sourceFile.getFullText();
  const commentRanges = [];
  // Walk every token's leading trivia for TODO/FIXME — cheaper and more
  // reliable across the whole file than per-node getLeadingCommentRanges.
  const TODO_RE = /\b(TODO|FIXME)\b/;
  ts.forEachChild(sourceFile, function visit(node) {
    const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
    for (const r of ranges) {
      const commentText = text.slice(r.pos, r.end);
      if (TODO_RE.test(commentText)) commentRanges.push({ range: r, node });
    }
    ts.forEachChild(node, visit);
  });
  for (const { range, node } of commentRanges) {
    const fn = findEnclosingFunction(node);
    if (!fn) continue; // TODO outside any function body — not this rule's concern
    if (isTrivialBody(fn)) {
      const pos = sourceFile.getLineAndCharacterOfPosition(range.pos).line + 1;
      findings.rule3.push({
        file: relPath(sourceFile.fileName),
        line: pos,
        comment: text.slice(range.pos, range.end).trim().slice(0, 160),
        function: fn.name && ts.isIdentifier(fn.name) ? fn.name.text : "(anonymous)",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Rule 4 — text-scraped control flow (JSON.parse over subprocess output).
// ---------------------------------------------------------------------------

const STREAM_PARAM_RE = /^(raw|stdout|stderr|output|response)$/i;

function checkRule4(sourceFile, node, subprocessOutputParses) {
  if (!ts.isCallExpression(node)) return;
  if (!ts.isPropertyAccessExpression(node.expression)) return;
  if (node.expression.name.text !== "parse") return;
  if (!ts.isIdentifier(node.expression.expression) || node.expression.expression.text !== "JSON") return;
  const fn = findEnclosingFunction(node);
  const paramNames = fn ? fn.parameters.filter((p) => ts.isIdentifier(p.name)).map((p) => p.name.text) : [];
  const strongHit = paramNames.some((p) => STREAM_PARAM_RE.test(p));
  const entry = {
    file: relPath(sourceFile.fileName),
    line: lineOf(sourceFile, node),
    function: fn?.name && ts.isIdentifier(fn.name) ? fn.name.text : "(anonymous/arrow)",
    parameters: paramNames,
  };
  if (strongHit) findings.rule4_strong.push(entry);
  else if (subprocessOutputParses.has(node)) findings.rule4_weak.push(entry);
}

// ---------------------------------------------------------------------------
// Run rules 1, 3, 4 over every tracked source file.
// ---------------------------------------------------------------------------

const trackedFileSet = new Set(srcFiles.map((f) => resolvePath(f)));
for (const sourceFile of program.getSourceFiles()) {
  if (!trackedFileSet.has(resolvePath(sourceFile.fileName))) continue;
  const subprocessOutputParses = new Set(findSubprocessOutputJsonParses(sourceFile, checker));
  checkRule3(sourceFile);
  ts.forEachChild(sourceFile, function visit(node) {
    checkRule1(sourceFile, node);
    checkRule4(sourceFile, node, subprocessOutputParses);
    ts.forEachChild(node, visit);
  });
}

// ---------------------------------------------------------------------------
// Rule 5 — tautological test. Scans each profile source root's */tests, not
// src. Single-file, no type-checker needed, so each file is parsed
// standalone (no full ts.Program over the whole tests/ tree) via the shared
// logic in anti-stub-rules.mjs.
// ---------------------------------------------------------------------------

const testFiles = [];
for (const packagesDir of packagesDirs) {
  let pkgEntries;
  try {
    pkgEntries = readdirSync(packagesDir);
  } catch {
    continue;
  }
  for (const pkg of pkgEntries) {
    const testsDir = join(packagesDir, pkg, "tests");
    try {
      if (statSync(testsDir).isDirectory()) walk(testsDir, testFiles);
    } catch {
      // no tests/ — skip
    }
  }
}

for (const file of testFiles) {
  const text = readFileSync(file, "utf-8");
  const snippetSourceFile = parseSnippet(text, file);
  for (const f of checkLengthTautology(snippetSourceFile)) {
    findings.rule5_length.push({ file: relPath(file), line: f.line, text: f.text, receiver: f.receiver });
  }
  for (const f of checkVacuousGuardedAssertion(snippetSourceFile)) {
    findings.rule5_guard.push({ file: relPath(file), line: f.line, guard: f.guard, text: f.text });
  }
}

// ---------------------------------------------------------------------------
// Rule 2 — config key without a reader.
// ---------------------------------------------------------------------------

function collectSchemaLeafKeys(schemaObjectLiteral) {
  const leaves = new Set();
  function walkSchemaNode(node) {
    if (!ts.isObjectLiteralExpression(node)) return;
    const propertiesProp = node.properties.find(
      (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "properties",
    );
    const additionalProp = node.properties.find(
      (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "additionalProperties",
    );
    if (propertiesProp && ts.isPropertyAssignment(propertiesProp) && ts.isObjectLiteralExpression(propertiesProp.initializer)) {
      for (const entry of propertiesProp.initializer.properties) {
        if (!ts.isPropertyAssignment(entry) || !ts.isIdentifier(entry.name)) continue;
        const key = entry.name.text;
        const value = entry.initializer;
        if (ts.isObjectLiteralExpression(value)) {
          const hasNested = value.properties.some(
            (p) =>
              ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) &&
              (p.name.text === "properties" || p.name.text === "additionalProperties"),
          );
          if (hasNested) walkSchemaNode(value);
          else leaves.add(key);
        } else {
          leaves.add(key);
        }
      }
    }
    if (additionalProp && ts.isPropertyAssignment(additionalProp) && ts.isObjectLiteralExpression(additionalProp.initializer)) {
      walkSchemaNode(additionalProp.initializer);
    }
  }
  walkSchemaNode(schemaObjectLiteral);
  return leaves;
}

let schemaLeafKeys = new Set();
const schemaFileAbs = resolvePath(REPO_ROOT, SOURCE_ROOTS[0], "arbor-config/src/schema.ts");
for (const sourceFile of program.getSourceFiles()) {
  if (resolvePath(sourceFile.fileName) !== schemaFileAbs) continue;
  ts.forEachChild(sourceFile, function visit(node) {
    if (
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "CONFIG_JSON_SCHEMA" &&
      node.initializer
    ) {
      let init = node.initializer;
      if (ts.isAsExpression(init)) init = init.expression;
      schemaLeafKeys = collectSchemaLeafKeys(init);
    }
    ts.forEachChild(node, visit);
  });
}

const arborConfigSrc = resolvePath(REPO_ROOT, SOURCE_ROOTS[0], "arbor-config/src");
const readerCounts = new Map([...schemaLeafKeys].map((k) => [k, 0]));

for (const sourceFile of program.getSourceFiles()) {
  const abs = resolvePath(sourceFile.fileName);
  if (!trackedFileSet.has(abs)) continue;
  if (abs.startsWith(arborConfigSrc)) continue; // schema reading its own key back isn't a runtime reader
  ts.forEachChild(sourceFile, function visit(node) {
    if (ts.isPropertyAccessExpression(node) && readerCounts.has(node.name.text)) {
      readerCounts.set(node.name.text, readerCounts.get(node.name.text) + 1);
    } else if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression ?? node)) {
      const key = node.argumentExpression && ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined;
      if (key && readerCounts.has(key)) readerCounts.set(key, readerCounts.get(key) + 1);
    }
    ts.forEachChild(node, visit);
  });
}

for (const [key, count] of readerCounts) {
  if (count === 0) findings.rule2.push({ key, reason: "no property/element access to this schema leaf key found outside arbor-config/src" });
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

const totalFindings =
  findings.rule1.length + findings.rule2.length + findings.rule3.length + findings.rule4_strong.length +
  findings.rule4_weak.length + findings.rule5_length.length + findings.rule5_guard.length;

// ---------------------------------------------------------------------------
// Triage.
//
// WHY THIS IS DATA. This file's header has carried a hand-written finding
// count three times and been wrong twice — it said 10 when the gate reported
// 11, then 11 when it reported 10. A number in prose that nothing checks is
// the Unwitnessed-claim shape, inside the gate whose job is finding exactly
// that. The count is now DERIVED, and the triage that explains it lives in
// scripts/anti-stub/triage.json where it can be matched against real
// findings.
//
// scripts/anti-stub/triage.json IS THE WAIVER STORE (migrated off the inline
// JS array literal this file used to carry, onto the same
// scripts/lib/waiver-store.mjs primitive reachability.mjs's allowlist and
// branch-accounting.mjs's dispositions now share — one schema, one
// validator, one CRUD surface across all three). Keyed by rule + file +
// symbol, deliberately NOT by line number: line numbers drift on every edit
// above them, so a line-keyed suppression silently stops matching and
// quietly re-flags a known-good finding (or worse, starts suppressing a
// different one).
//
// A finding NOT in this table is UNTRIAGED, and --blocking fails on it. That
// is the whole point: nobody has to re-triage the known set to notice
// something new, which is what made a blanket --blocking unusable — most
// current findings are false positives, so blanket blocking would fail the
// build permanently and be turned straight back off.
//
// A verdict's shelf life — only `accepted_tradeoff` is dated:
//   - `false_positive` says the HEURISTIC IS WRONG at this site — a
//     JSON.parse inside `fromJSONL` is the function's job. That does not
//     rot; re-dating it would manufacture recurring work with no decision to
//     make. The shared schema (WAIVER_SCHEMAS["anti-stub"].requiresExpiry)
//     encodes exactly this: expiry is required only when verdict ===
//     "accepted_tradeoff".
//   - `accepted_tradeoff` says the finding is REAL and we are living with
//     it. An expired one reads as untriaged, so `--blocking` fails until a
//     human re-judges it.
// ---------------------------------------------------------------------------

// `--triage <path>` lets a test point this gate at a throwaway triage store
// (a genuinely lapsed or malformed entry) without touching the real one —
// same reason reachability.mjs's `--allowlist` and branch-accounting.mjs's
// `--dispositions` overrides exist. In TRIAGE_VERB mode `--triage`'s value is
// a finding key, not a path, so the conventional store path is used instead
// (overridable for tests via REVOY2_ANTI_STUB_TRIAGE_PATH, the same env-var
// override convention completion-depth.mjs and store-freshness-gate.mjs use
// for their own stores).
const TRIAGE_PATH = TRIAGE_VERB
  ? (process.env.REVOY2_ANTI_STUB_TRIAGE_PATH ? resolvePath(process.env.REVOY2_ANTI_STUB_TRIAGE_PATH) : join(__dirname, "anti-stub", "triage.json"))
  : (argValue("--triage") ?? join(__dirname, "anti-stub", "triage.json"));
const { entries: TRIAGE, error: triageFileError } = loadWaiverFile(TRIAGE_PATH);
if (triageFileError) {
  // Fail closed, same posture as the other two stores: an unreadable triage
  // file must not silently mean "everything is triaged".
  console.error(`anti-stub: ${triageFileError}`);
  process.exit(2);
}

/** The symbol-ish identity a finding carries, whichever field the rule that produced it uses. */
function findingSymbol(finding) {
  return finding.function ?? finding.call ?? finding.key ?? finding.guard ?? finding.receiver ?? "";
}

/** Stable identity for a finding: rule + file + the symbol it was found in. */
function findingKey(rule, finding) {
  return `${rule}::${finding.file}::${findingSymbol(finding)}`;
}

/**
 * `bun scripts/anti-stub.mjs --triage <rule>::<file>::<symbol> --verdict
 * <false_positive|accepted_tradeoff> --reason "..." [--expires <ISO date>]`
 *
 * Mirrors completion-depth.mjs's `--triage` surface exactly: same flag
 * names, same "missing arg -> usage, exit 2" / "unknown verdict -> exit 2" /
 * "unknown id -> exit 2" shape (see completion-depth.mjs's triageOne). The
 * one difference is what an id IS — completion-depth keeps its own
 * findings.jsonl store of record, so an id there is a row in that file.
 * anti-stub keeps no findings-of-record file (findings are always a LIVE
 * scan, per this run); an id here is the composite key findingKey() already
 * builds against that live scan, and "unknown id" means no CURRENT finding
 * carries it — this run's scan, not a stale prior one, is what is asked.
 *
 * Writes through the shared scripts/lib/waiver-store.mjs primitive this file
 * already reads through (add for a first verdict on a key, renew for a
 * changed one), so scripts/anti-stub/triage.json is never hand-edited —
 * the footgun this verb exists to remove.
 */
function runTriageVerb() {
  const findingKeyArg = argValue("--triage");
  const verdict = argValue("--verdict");
  const reason = argValue("--reason");
  const expires = argValue("--expires");
  if (!findingKeyArg || !verdict || !reason) {
    console.error(
      'Usage: anti-stub.mjs --triage <rule>::<file>::<symbol> --verdict <false_positive|accepted_tradeoff> --reason "..." [--expires <ISO date>]',
    );
    return 2;
  }
  const schema = WAIVER_SCHEMAS["anti-stub"];
  if (!schema.verdicts.includes(verdict)) {
    console.error(`anti-stub --triage: invalid verdict '${verdict}' — must be one of ${schema.verdicts.join(", ")}`);
    return 2;
  }

  let matched;
  for (const [rule, list] of Object.entries(findings)) {
    const finding = list.find((f) => findingKey(rule, f) === findingKeyArg);
    if (finding) { matched = { rule, finding }; break; }
  }
  if (!matched) {
    console.error(
      `anti-stub --triage: no current finding with key '${findingKeyArg}' — run \`bun scripts/anti-stub.mjs\` (no --triage) to list current finding keys`,
    );
    return 2;
  }

  const keyValues = { rule: matched.rule, file: matched.finding.file, symbol: findingSymbol(matched.finding) };
  const candidate = { ...keyValues, verdict, reason, ...(expires ? { expires } : {}) };
  const { ok: validCandidate, errors } = validateWaiverEntry(candidate, "anti-stub");
  if (!validCandidate) {
    console.error(`anti-stub --triage: invalid entry: ${errors.join("; ")}`);
    return 2;
  }

  const existing = findWaiverEntry(TRIAGE, keyValues, "anti-stub");
  const nextEntries = existing
    ? renewWaiverEntry(TRIAGE, keyValues, { verdict, reason, ...(expires ? { expires } : {}) }, "anti-stub")
    : addWaiverEntry(TRIAGE, candidate, "anti-stub");
  writeWaiverFile(TRIAGE_PATH, nextEntries, { version: 1 });
  console.log(`anti-stub --triage — ${findingKeyArg}: ${verdict}`);
  return 0;
}

const TRIAGE_KEYS = new Map(TRIAGE.map((entry) => [`${entry.rule}::${entry.file}::${entry.symbol}`, entry]));

const TODAY = new Date().toISOString().slice(0, 10);

// Every entry is validated up front (not just the ones a live finding
// happens to hit) — same posture the inline array had before migration: a
// malformed TRIAGE entry (an accepted_tradeoff with no/invalid expires, a
// missing reason, an unrecognized verdict, ...) is a CONFIGURATION ERROR,
// not a silent pass, and is rejected via the same shared
// scripts/lib/waiver-store.mjs validator reachability.mjs and
// branch-accounting.mjs now use for their own stores.
for (const entry of TRIAGE) {
  const { ok: validEntry, errors } = validateWaiverEntry(entry, "anti-stub");
  if (!validEntry) {
    console.error(
      `anti-stub: TRIAGE entry ${entry.rule ?? "?"}::${entry.file ?? "?"}::${entry.symbol ?? "?"} is invalid: ${errors.join("; ")}.`,
    );
    process.exit(2);
  }
}

/** True when this verdict no longer counts as a judgement. */
function verdictLapsed(entry) {
  return isWaiverExpired(entry, "anti-stub", TODAY);
}

if (TRIAGE_VERB) {
  process.exitCode = runTriageVerb();
} else {
  const untriaged = [];
  const lapsed = [];
  for (const [rule, list] of Object.entries(findings)) {
    for (const finding of list) {
      const entry = TRIAGE_KEYS.get(findingKey(rule, finding));
      if (!entry) untriaged.push({ rule, ...finding });
      else if (verdictLapsed(entry)) lapsed.push({ rule, ...finding, expired: entry.expires });
    }
  }
  for (const item of lapsed) untriaged.push(item);

  if (JSON_OUTPUT) {
    console.log(JSON.stringify({ blocking: BLOCKING, totalFindings, triaged: totalFindings - untriaged.length, untriaged, findings }, null, 2));
  } else {
    console.log(
      `anti-stub gate (6.5) — REPORT-ONLY${BLOCKING ? " (--blocking requested)" : ""} — ${srcFiles.length} source files + ${testFiles.length} test files scanned\n`,
    );

    console.log(`Rule 1 — placeholder literal in a ledger record: ${findings.rule1.length} finding(s)`);
    for (const f of findings.rule1) console.log(`  - ${f.file}:${f.line}  ${f.call}({ ${f.field}: ${f.value} })`);
    console.log("");

    console.log(`Rule 2 — config key without a reader: ${findings.rule2.length} finding(s)`);
    for (const f of findings.rule2) console.log(`  - schema key "${f.key}": ${f.reason}`);
    console.log("");

    console.log(`Rule 3 — TODO standing in for behavior: ${findings.rule3.length} finding(s)`);
    for (const f of findings.rule3) console.log(`  - ${f.file}:${f.line}  in ${f.function}(): ${f.comment}`);
    console.log("");

    console.log(`Rule 4 — text-scraped control flow (strong: parse fn takes a stream-shaped param): ${findings.rule4_strong.length} finding(s)`);
    for (const f of findings.rule4_strong) console.log(`  - ${f.file}:${f.line}  in ${f.function}(${f.parameters.join(", ")})`);
    console.log(`Rule 4 — text-scraped control flow (weak: JSON.parse input traces to child_process output): ${findings.rule4_weak.length} finding(s)`);
    for (const f of findings.rule4_weak) console.log(`  - ${f.file}:${f.line}  in ${f.function}(${f.parameters.join(", ")})`);
    console.log("");

    console.log(`Rule 5a — tautological test (expect(<expr>.length|.size).toBeGreaterThanOrEqual(0)/toBeGreaterThan(-1)): ${findings.rule5_length.length} finding(s)`);
    for (const f of findings.rule5_length) console.log(`  - ${f.file}:${f.line}  ${f.text}`);
    console.log(`Rule 5b — tautological test (expect(...) vacuously guarded by if (<identifier>) with no else): ${findings.rule5_guard.length} finding(s)`);
    for (const f of findings.rule5_guard) console.log(`  - ${f.file}:${f.line}  ${f.text}`);
    console.log("");

    console.log(`${totalFindings} total finding(s) across all 5 rules; ${totalFindings - untriaged.length} triaged, ${untriaged.length} untriaged.`);
    if (untriaged.length > 0) {
      console.log("\nUNTRIAGED — each needs a verdict via --triage <rule>::<file>::<symbol> --verdict <v> --reason \"...\", or a fix:");
      for (const finding of untriaged) {
        console.log(`  - [${finding.rule}] ${finding.file}:${finding.line ?? "?"}  ${findingSymbol(finding)}  (key: ${findingKey(finding.rule, finding)})`);
      }
    }
    console.log(
      BLOCKING
        ? (untriaged.length === 0 ? "PASS (--blocking: no untriaged findings)" : "FAIL (--blocking: untriaged findings)")
        : "REPORT-ONLY (not failing the build — run with --blocking to fail on UNTRIAGED findings)",
    );
  }

  // --blocking fails on UNTRIAGED findings only. Blanket blocking on
  // totalFindings would fail the build on 9 known false positives and be
  // disabled again within a day; blocking on "something appeared that nobody has
  // judged" is a gate that can actually stay on.
  process.exitCode = BLOCKING && untriaged.length > 0 ? 1 : 0;
}
