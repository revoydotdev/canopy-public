#!/usr/bin/env node
/**
 * scripts/registration-integrity.mjs — registration-integrity gate.
 *
 * Usage:
 *   node scripts/registration-integrity.mjs          # human-readable report, exits non-zero on violation
 *   node scripts/registration-integrity.mjs --json   # machine-readable report on stdout
 *   bun run gate:registration-integrity              # wired: package.json `check` + CI
 *
 * (This line previously read "NOT YET WIRED". It was false from the commit
 * that wrote it — the same commit added the script to package.json's `check`.
 * A stale comment inside the gate whose job is catching stale registrations
 * is the exact defect shape this file detects, found by an independent audit.)
 *
 * What this closes
 * -----------------
 * Every other gate in this repo (reachability, docs-truth, anti-stub) asks
 * "does this code path get *exercised*?" None of them asks the narrower,
 * cheaper, and surprisingly common question this gate exists for: "was this
 * thing *registered* at all?" — a module, subcommand, MCP tool, or catalog
 * kind that was written, plausibly looks finished, and is simply never
 * plugged into the thing that would call it. A real instance of exactly this
 * defect shape was found in this repo while this gate was being written:
 * `packages/arbor-mcp/src/cli.ts`'s direct-execution guard compared
 * `import.meta.url` against a `pathToFileURL(process.argv[1])` derived path —
 * true only when node runs the bundle directly, false under every loader
 * (`vite-node`, `tsx`) that preserves `import.meta.url` but rewrites
 * `argv[1]`. The guard never fired, `main()` never ran, and the CLI exited 0
 * with **no output** — a silent success on a plausible invocation, strictly
 * worse than a crash. (See `cli.ts`'s `isDirectExecution` doc comment for the
 * fixed version and exactly why the old one failed.)
 *
 * Five checks, each static AST/text analysis over source files already in
 * this repo — never an import or execution of the module under test (see
 * "Constraints honored" below):
 *
 *   1. Dead entrypoints — a `scripts/reachability/entry-points.json`
 *      process-entry file with no top-level executable statement at all, a
 *      top-level guard `if` whose body never calls anything (inert even if
 *      the condition is ever true), or a top-level `main`/`run`/`serve`
 *      declaration never invoked anywhere in its own file.
 *   2. Unregistered CLI subcommands — a command cli.ts's `main()` actually
 *      dispatches on `args[N] === "..."` with no matching line in its own
 *      `--help` text, and the inverse (a `--help`-advertised command with no
 *      dispatch branch).
 *   3. MCP tool registration drift — a tool-shaped object declared in
 *      tools.ts/devtools.ts but never included in the array its
 *      `defineTools`/`defineDevToolsTools` returns (and the inverse: the
 *      returned array spreading/referencing an identifier that resolves to
 *      nothing in the file); plus server.ts actually capturing and later
 *      reading each `defineTools`/`defineDevToolsTools` call's result.
 *   4. Catalog/union drift — a `RUNTIME_CATALOG` (runtime-catalog.ts) kind
 *      marked `supported: true` with no dispatch reference anywhere in the
 *      file (no `case "kind":` in a switch over `....kind`, no
 *      `catalogEntry("kind", ...)` call, no `x.kind === "kind"` compare —
 *      directly, or via a same-domain/same-direction sibling that IS
 *      referenced; see the "Group-live inference" note below), and the
 *      inverse (a dispatch reference to a kind absent from the catalog
 *      entirely). The declared entries come from the ONE shared reader
 *      (`readRuntimeCatalog` in `@arbor/governance`); only the dispatch
 *      reference scan is local, because the references live in the router
 *      file the reader does not read.
 *   5. Orphaned scripts — a `scripts/*.mjs` file whose own header doc-comment
 *      calls itself a "gate" but has no `gate:*` entry in package.json's
 *      `scripts` block referencing it, and the inverse (a `gate:*` entry
 *      pointing at a `scripts/*.mjs` file that does not exist).
 *
 * Policy (ADR-117, adopted from revoy-spec): false-LIVE is acceptable,
 * false-DEAD is not. Every check below is written to prefer silence over a
 * false accusation — see each check's own "why this shape" note for the
 * specific false-positive it was built to avoid. This is why check 4 groups
 * kinds by (domain, direction) rather than flagging every individually-
 * unreferenced kind: `compaction.list`/`userinput.list`/`userinput.ask`/
 * `communication.history`/`output.descriptor` are all real, live,
 * `supported: true` catalog kinds whose *only* wiring is the implicit `else`
 * branch of a two-variant `if (envelope.query.kind === "<sibling>") {...}
 * else {...}` — genuinely dispatched, but with zero literal occurrence of
 * their own kind string anywhere outside the catalog array itself. A naive
 * per-kind "is this literal referenced anywhere" check flags exactly these
 * five as false positives (verified empirically while building this gate).
 * Grouping by (domain, direction) and treating one confirmed-live sibling as
 * evidence for the whole group removes that false-positive class while
 * still catching the shape this gate exists for: an entire new
 * domain/direction pairing added to the catalog with *zero* wiring anywhere
 * (the historical G-29 shape — `foreground.derive`/`nodecard.resolve`/
 * `a2a.cards`, correctly `supported: false` with a documented reason, are
 * the only reason this trades any individual-kind precision at all, and
 * `supported: false` entries are excluded from the check entirely: the
 * catalog's own flag IS the allowlist).
 *
 * Known, disclosed limitation (check 1): a guard that exists, has a
 * non-empty call-containing body, and STILL never fires because its
 * condition is always false at runtime (the exact historical cli.ts shape —
 * `import.meta.url` vs. a loader-rewritten `argv[1]`) is NOT detectable by
 * this check. Proving that requires knowing which loader will run the file,
 * which is a runtime fact, not a static one. This is a deliberate, disclosed
 * miss under the false-DEAD-is-not-acceptable policy above, not an
 * oversight — see the header of `isDirectExecution` in cli.ts for the fixed
 * version's own account of exactly this gap.
 *
 * Constraints honored
 * --------------------
 * - TypeScript compiler API only (`typescript`, already a devDependency), used
 *   purely syntactically (`ts.createSourceFile`, no `Program`/type-checker) —
 *   fast, and needs no `tsconfig` resolution.
 * - No new dependency of any kind.
 * - Never imports or executes any analyzed module (cli.ts, tools.ts,
 *   devtools.ts, runtime-catalog.ts, or any scripts/*.mjs gate) — every file
 *   is read with `readFileSync` and parsed as text/AST only. Importing a CLI
 *   entrypoint to "check" it would itself run the CLI, which is exactly the
 *   kind of unsafe shortcut this gate's own existence argues against.
 * - Deterministic: no timestamps, no wall-clock-dependent output, no
 *   directory-listing order dependence (all listings are sorted).
 * - Exits via `process.exitCode`, not `process.exit()` — same reasoning as
 *   reachability.mjs: stdout can be a pipe, and `process.exit()` immediately
 *   after a large `console.log` can truncate the write mid-flush.
 * - The exported check functions (`checkDeadEntrypoints`, `checkCliDispatch`,
 *   `checkToolRegistration`, `checkCatalogDispatchDrift`,
 *   `checkOrphanedScripts`) are pure: given source text (and, for check 1, a
 *   caller-supplied `readFile`), they return a violations array with no
 *   filesystem or process access — this is what makes them unit-testable
 *   against synthetic fixtures without touching this repo's real files, and
 *   why the whole scan/report/exit sequence below is gated behind
 *   `isDirectExecution()`, exactly the pattern check 1 itself rewards.
 */

import { readFileSync, readdirSync, statSync, realpathSync, existsSync } from "node:fs";
import { join, dirname, relative, resolve as resolvePath, basename } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { readRuntimeCatalog } from "@arbor/governance";
import { profileOrDefaults } from "./lib/project-profile.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// `--root` selects which tree the five checks read, and is inert when the flag
// is absent. Every check function was already a pure function of file TEXT, so
// this only relocates input — `guard:canaries` can then point the battery at a
// fixture. The `entry-points.json` manifest below is deliberately NOT under
// `--root`: it stays relative to this script, so check 1 always reads the real
// manifest and its extra finding against a fixture is an honest statement that
// the fixture is not a revoy2 checkout, not a defect in the seam.
const rootIndex = process.argv.indexOf("--root");
const REPO_ROOT = resolvePath(rootIndex >= 0 && process.argv[rootIndex + 1] ? process.argv[rootIndex + 1] : join(__dirname, ".."));
const JSON_OUTPUT = process.argv.includes("--json");

// ---------------------------------------------------------------------------
// Shared AST helpers.
// ---------------------------------------------------------------------------

function parseTs(fileName, text) {
  const kind = fileName.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, /* setParentNodes */ true, kind);
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** True if `node`'s subtree contains at least one call expression anywhere. */
function containsCallExpression(node) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isCallExpression(n)) { found = true; return; }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** Every string literal value of a given property name in an object literal, if present. */
function stringProp(obj, name) {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === name) {
      if (ts.isStringLiteral(prop.initializer)) return prop.initializer.text;
    }
  }
  return undefined;
}

function hasProp(obj, name) {
  return obj.properties.some((prop) => ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === name);
}

// ---------------------------------------------------------------------------
// Check 1 — dead entrypoints.
// ---------------------------------------------------------------------------

/** ExpressionStatement or IfStatement top-level — the only shapes that run code at load time. */
function isExecutableTopLevelStatement(stmt) {
  return ts.isExpressionStatement(stmt) || ts.isIfStatement(stmt);
}

function findTopLevelNamedFunctionLike(sourceFile, name) {
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) return stmt;
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          return decl;
        }
      }
    }
  }
  return undefined;
}

/** Any call expression anywhere in the file whose callee is the bare identifier `name`. */
function isIdentifierCalledAnywhere(sourceFile, name) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) { found = true; return; }
    ts.forEachChild(n, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * entries: the parsed `entryPoints` array from scripts/reachability/entry-points.json.
 * readFile: (relPath) => string | null — null means "file not found", silently
 * skipped (a missing entry-point file is reachability.mjs's own violation to
 * report; this gate does not duplicate it and will not report it as "dead"
 * without ever having seen its contents — that would be a false-DEAD guess).
 */
export function checkDeadEntrypoints(entries, readFile) {
  const violations = [];
  for (const entry of entries) {
    if (entry.kind !== "process-entry") continue;
    const text = readFile(entry.file);
    if (text === null || text === undefined) continue;
    const sourceFile = parseTs(entry.file, text);

    const executable = sourceFile.statements.filter(isExecutableTopLevelStatement);
    if (executable.length === 0) {
      violations.push({
        id: entry.id,
        file: entry.file,
        reason: "process-entry file has no top-level executable statement (only declarations/imports) — nothing runs when this file is loaded as an entry",
      });
      continue;
    }

    for (const stmt of executable) {
      if (ts.isIfStatement(stmt) && !containsCallExpression(stmt.thenStatement)) {
        violations.push({
          id: entry.id,
          file: entry.file,
          reason: `top-level guard at line ${lineOf(sourceFile, stmt)} has an empty/no-call body — cannot have any effect even if its condition is ever true`,
        });
      }
    }

    for (const name of ["main", "run", "serve"]) {
      const decl = findTopLevelNamedFunctionLike(sourceFile, name);
      if (!decl) continue;
      if (!isIdentifierCalledAnywhere(sourceFile, name)) {
        violations.push({
          id: entry.id,
          file: entry.file,
          reason: `defines '${name}' at line ${lineOf(sourceFile, decl)} but never invokes it anywhere in its own file`,
        });
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Check 2 — unregistered CLI subcommands (packages/arbor-mcp/src/cli.ts).
// ---------------------------------------------------------------------------

/**
 * Decompose an `if` test built from `args[N] === "literal"` comparisons
 * joined by `&&`/`||` into an OR-of-ANDs of `{ index, literal }` conditions.
 * Any sub-expression that isn't exactly this shape contributes nothing
 * (returns `[]` for that branch) rather than guessing — an unrecognized
 * condition shape must never manufacture a dispatch key that isn't real.
 */
function decomposeArgsCondition(expr) {
  if (ts.isParenthesizedExpression(expr)) return decomposeArgsCondition(expr.expression);
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (op === ts.SyntaxKind.BarBarToken) {
      return [...decomposeArgsCondition(expr.left), ...decomposeArgsCondition(expr.right)];
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      const leftBranches = decomposeArgsCondition(expr.left);
      const rightBranches = decomposeArgsCondition(expr.right);
      if (leftBranches.length === 0 || rightBranches.length === 0) return [];
      return leftBranches.flatMap((lb) => rightBranches.map((rb) => [...lb, ...rb]));
    }
    if (op === ts.SyntaxKind.EqualsEqualsEqualsToken) {
      const pair = matchArgsIndexLiteral(expr.left, expr.right) ?? matchArgsIndexLiteral(expr.right, expr.left);
      return pair ? [[pair]] : [];
    }
  }
  return [];
}

/** Matches `args[N]` against a string literal in either operand order. */
function matchArgsIndexLiteral(elementSide, literalSide) {
  if (
    ts.isElementAccessExpression(elementSide) &&
    ts.isIdentifier(elementSide.expression) &&
    elementSide.expression.text === "args" &&
    ts.isNumericLiteral(elementSide.argumentExpression) &&
    ts.isStringLiteral(literalSide)
  ) {
    return { index: Number(elementSide.argumentExpression.text), literal: literalSide.text };
  }
  return undefined;
}

/** Every string-literal argument passed to `environment.stderr.write(...)` inside `node`. */
/**
 * The literal text a help-line argument contributes, or null if it contributes
 * none.
 *
 * Template literals matter here. A help line written as
 *   `  arbor ledger <${LEDGER_ACTIONS.join("|")}> ...`
 * is a TemplateExpression, not a StringLiteral, so the original
 * `ts.isStringLiteral` check skipped it entirely and the gate reported the
 * `ledger` dispatch as undocumented — a false positive that appeared the moment
 * the help line started deriving its subcommand list from the same constant the
 * dispatch checks, which is precisely the drift-proof shape we want to reward.
 *
 * Substitutions are replaced by a placeholder rather than dropped, so the
 * surrounding literal spans keep their spacing and the leading
 * `  arbor <command>` shape the caller's regex depends on stays intact. What
 * the substitution evaluates to is not knowable statically and is not what this
 * gate is asking about — it asks whether the command is mentioned at all.
 */
function literalTextOf(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => `\u2026${span.literal.text}`).join("");
  }
  return null;
}

function collectStderrWrites(node) {
  const writes = [];
  const visit = (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "write" &&
      n.arguments.length > 0
    ) {
      const text = literalTextOf(n.arguments[0]);
      if (text !== null) writes.push(text);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return writes;
}

const CLI_META_TOKENS = new Set(["--help", "-h"]);

/**
 * cliSourceText: the full text of packages/arbor-mcp/src/cli.ts (or any file
 * following the same `export (async) function main(args = ...)` + top-level
 * `if (args[0] === "...")` dispatch shape with a `--help`/no-args usage
 * branch writing to `environment.stderr`).
 */
export function checkCliDispatch(cliSourceText) {
  const sourceFile = parseTs("cli.ts", cliSourceText);
  const mainFn = findTopLevelNamedFunctionLike(sourceFile, "main");
  if (!mainFn || !mainFn.body || !ts.isBlock(mainFn.body)) {
    // No recognizable `main` dispatch function — nothing this check knows
    // how to evaluate. Per the false-DEAD policy, absence of the expected
    // shape is reported as a diagnostic, never as a fabricated violation.
    return { violations: [], dispatched: [], declared: [], note: "no top-level main(args) function found" };
  }

  const dispatched = [];
  let helpBranchWrites = [];
  for (const stmt of mainFn.body.statements) {
    if (!ts.isIfStatement(stmt)) continue;
    const branches = decomposeArgsCondition(stmt.expression);
    for (const branch of branches) {
      if (branch.length === 0) continue;
      const sorted = [...branch].sort((a, b) => a.index - b.index);
      const key = sorted.map((c) => c.literal).join(" ");
      dispatched.push(key);
    }
    // The usage/help branch: any branch whose sole/first literal is a known
    // meta flag, or an unconditioned `args.length === 0` (which decomposes
    // to no branches at all — checked separately below via text content).
    const looksLikeHelp = branches.some((b) => b.some((c) => c.index === 0 && CLI_META_TOKENS.has(c.literal)))
      || /args\.length\s*===\s*0/.test(stmt.expression.getText(sourceFile));
    if (looksLikeHelp) helpBranchWrites = [...helpBranchWrites, ...collectStderrWrites(stmt.thenStatement)];
  }

  const helpText = helpBranchWrites.join("");
  const declared = new Set();
  for (const line of helpText.split("\n")) {
    const m = line.match(/^\s*arbor(?:-mcp)?\s+(--?[A-Za-z][A-Za-z-]*|[a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/);
    if (!m) continue;
    declared.add(m[2] ? `${m[1]} ${m[2]}` : m[1]);
  }
  for (const m of helpText.matchAll(/`(--?[A-Za-z][A-Za-z-]*|[a-z][a-z-]*)`/g)) declared.add(m[1]);

  const violations = [];
  const dispatchedSet = new Set(dispatched.filter((key) => !CLI_META_TOKENS.has(key)));
  // A top-level dispatcher may intentionally own its subcommand grammar
  // inside the branch (`command list`, `plugin install`). Treat a documented
  // child as evidence for its dispatched parent, and vice versa. The gate is
  // deliberately conservative under ADR-117: it must not call a real nested
  // dispatcher dead merely because this cheap pass only decomposes `args` in
  // main's top-level conditions.
  //
  // Naming note, not a logic bug: "conservative" here leans toward silence —
  // tolerating a possible missed violation to avoid a false accusation
  // (ADR-117: "false-LIVE is acceptable, false-DEAD is not"). reachability.mjs
  // uses the same word for the opposite bias — it leans toward flagging an
  // unresolvable declaration rather than staying silent. See reachability.mjs's
  // header comment (~line 65) for the full cross-reference; both postures are
  // individually correct for what each gate does, the shared English word
  // just papers over opposite defaults.
  const matchesCommand = (key, candidates) => candidates.has(key)
    || [...candidates].some((candidate) => candidate.startsWith(`${key} `) || key.startsWith(`${candidate} `));
  for (const key of dispatchedSet) {
    if (!matchesCommand(key, declared)) {
      violations.push({ kind: "undocumented-dispatch", command: key, reason: `main() dispatches "${key}" but no --help line or backtick mention documents it` });
    }
  }
  for (const line of helpText.split("\n")) {
    const m = line.match(/^\s*arbor(?:-mcp)?\s+(--?[A-Za-z][A-Za-z-]*|[a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?\s/);
    if (!m) continue;
    const key = m[2] ? `${m[1]} ${m[2]}` : m[1];
    if (!matchesCommand(key, dispatchedSet)) {
      violations.push({ kind: "undispatched-help-line", command: key, reason: `--help documents "arbor ${key}" but main() has no dispatch branch for it` });
    }
  }
  return { violations, dispatched: [...dispatchedSet].sort(), declared: [...declared].sort() };
}

// ---------------------------------------------------------------------------
// Check 3 — MCP tool registration drift (tools.ts, devtools.ts, server.ts).
// ---------------------------------------------------------------------------

/** The array literal a `return [...]` statement resolves to, anywhere inside `fnBody`. */
function findReturnedArrayLiteral(fnBody) {
  let found;
  const visit = (n) => {
    if (found) return;
    if (ts.isReturnStatement(n) && n.expression && ts.isArrayLiteralExpression(n.expression)) { found = n.expression; return; }
    if (ts.isFunctionLike(n) && n !== fnBody) return; // don't descend into nested function bodies
    ts.forEachChild(n, visit);
  };
  visit(fnBody);
  return found;
}

/** Identifiers referenced as bare elements or spread elements of an array literal. */
function arrayReferencedIdentifiers(arrayLiteral) {
  const names = new Set();
  for (const el of arrayLiteral.elements) {
    if (ts.isIdentifier(el)) names.add(el.text);
    if (ts.isSpreadElement(el) && ts.isIdentifier(el.expression)) names.add(el.expression.text);
  }
  return names;
}

function topLevelImportedNames(sourceFile) {
  const names = new Set();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
    const clause = stmt.importClause;
    if (clause.name) names.add(clause.name.text);
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) names.add(el.name.text);
    }
  }
  return names;
}

/**
 * A tool-shaped standalone declaration: `const X = { name: "...", description: ... , ... };`
 * at the TOP LEVEL of the file (deliberately not a repo-wide object-literal
 * scan — nested helper objects deep in validation logic are common in this
 * file and are not tool declarations; scoping to top-level consts keeps this
 * check precise).
 */
function topLevelToolShapedConsts(sourceFile) {
  const found = [];
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (
        ts.isIdentifier(decl.name) && decl.initializer && ts.isObjectLiteralExpression(decl.initializer) &&
        hasProp(decl.initializer, "name") && hasProp(decl.initializer, "description")
      ) {
        const name = stringProp(decl.initializer, "name");
        found.push({ identifier: decl.name.text, name: name ?? decl.name.text, node: decl });
      }
    }
  }
  return found;
}

/**
 * fileText: full source of tools.ts or devtools.ts.
 * exportedFnName: "defineTools" or "defineDevToolsTools".
 */
function analyzeToolDefinitionFile(fileText, fileLabel, exportedFnName) {
  const violations = [];
  const sourceFile = parseTs(fileLabel, fileText);
  const fn = findTopLevelNamedFunctionLike(sourceFile, exportedFnName);
  if (!fn || !fn.body) {
    violations.push({ file: fileLabel, reason: `no top-level function '${exportedFnName}' found — cannot verify tool registration` });
    return violations;
  }
  const returnedArray = findReturnedArrayLiteral(fn.body);
  if (!returnedArray) {
    violations.push({ file: fileLabel, reason: `'${exportedFnName}' has no 'return [...]' array literal — cannot verify which tools are registered` });
    return violations;
  }

  const referencedIdentifiers = arrayReferencedIdentifiers(returnedArray);
  const standaloneTools = topLevelToolShapedConsts(sourceFile);
  for (const tool of standaloneTools) {
    if (!referencedIdentifiers.has(tool.identifier)) {
      violations.push({
        file: fileLabel,
        reason: `tool '${tool.name}' is declared as 'const ${tool.identifier}' (line ${lineOf(sourceFile, tool.node)}) but is never included (by identifier or spread) in '${exportedFnName}'s returned array`,
      });
    }
  }

  const knownLocalNames = new Set([...standaloneTools.map((t) => t.identifier), ...topLevelImportedNames(sourceFile)]);
  for (const name of referencedIdentifiers) {
    if (!knownLocalNames.has(name)) {
      violations.push({
        file: fileLabel,
        reason: `'${exportedFnName}'s returned array references '${name}', which is not a top-level declaration or import in this file`,
      });
    }
  }
  return violations;
}

/**
 * Verify server.ts actually captures each of `defineTools`/`defineDevToolsTools`'s
 * call result (rather than discarding it) and reads the captured
 * name again elsewhere (rather than capturing it once and never consulting
 * it again — a "registered but never dispatched" drift).
 */
function analyzeServerWiring(serverText) {
  const violations = [];
  const sourceFile = parseTs("server.ts", serverText);

  for (const fnName of ["defineTools", "defineDevToolsTools"]) {
    let call;
    const visit = (n) => {
      if (call) return;
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === fnName) { call = n; return; }
      ts.forEachChild(n, visit);
    };
    visit(sourceFile);
    if (!call) {
      violations.push({ file: "server.ts", reason: `'${fnName}' is never called — tools it declares are entirely unregistered` });
      continue;
    }

    const parent = call.parent;
    let captureKind; // "this-property" | "variable"
    let captureName;
    if (
      ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === call &&
      ts.isPropertyAccessExpression(parent.left) && parent.left.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      captureKind = "this-property";
      captureName = parent.left.name.text;
    } else if (ts.isVariableDeclaration(parent) && parent.initializer === call && ts.isIdentifier(parent.name)) {
      captureKind = "variable";
      captureName = parent.name.text;
    } else {
      violations.push({ file: "server.ts", reason: `'${fnName}(...)' is called but its result is discarded (not assigned to 'this.<field>' or a variable) — its tools are unregistered` });
      continue;
    }

    let otherReferences = 0;
    const visitRefs = (n) => {
      if (captureKind === "this-property" && ts.isPropertyAccessExpression(n) && n.expression.kind === ts.SyntaxKind.ThisKeyword && n.name.text === captureName) {
        if (n !== parent.left) otherReferences++;
      }
      if (captureKind === "variable" && ts.isIdentifier(n) && n.text === captureName && n !== parent.name) {
        otherReferences++;
      }
      ts.forEachChild(n, visitRefs);
    };
    visitRefs(sourceFile);
    if (otherReferences === 0) {
      const label = captureKind === "this-property" ? `this.${captureName}` : captureName;
      violations.push({ file: "server.ts", reason: `'${fnName}(...)' is captured as '${label}' but never read again anywhere in the file — its tools are registered but never dispatched` });
    }
  }
  return violations;
}

export function checkToolRegistration(toolsText, devtoolsText, serverText) {
  return [
    ...analyzeToolDefinitionFile(toolsText, "tools.ts", "defineTools"),
    ...analyzeToolDefinitionFile(devtoolsText, "devtools.ts", "defineDevToolsTools"),
    ...analyzeServerWiring(serverText),
  ];
}

// ---------------------------------------------------------------------------
// Check 4 — catalog/union drift (packages/arbor-mcp/src/runtime-catalog.ts).
// ---------------------------------------------------------------------------

/** Every `.kind`-discriminated static reference to a string literal, anywhere in the file. */
function collectKindReferences(sourceFile) {
  const refs = new Set();
  const domainPrefixes = new Set();
  const isKindAccess = (n) => ts.isPropertyAccessExpression(n) && n.name.text === "kind";
  const visit = (n) => {
    if (ts.isSwitchStatement(n) && isKindAccess(n.expression)) {
      for (const clause of n.caseBlock.clauses) {
        if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression)) refs.add(clause.expression.text);
      }
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "catalogEntry" && n.arguments.length > 0 && ts.isStringLiteral(n.arguments[0])) {
      refs.add(n.arguments[0].text);
    }
    if (
      ts.isCallExpression(n)
      && ts.isPropertyAccessExpression(n.expression)
      && n.expression.name.text === "startsWith"
      && isKindAccess(n.expression.expression)
      && n.arguments.length > 0
      && ts.isStringLiteral(n.arguments[0])
      && n.arguments[0].text.endsWith(".")
    ) {
      domainPrefixes.add(n.arguments[0].text);
    }
    if (
      ts.isBinaryExpression(n) &&
      (n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken || n.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      if (ts.isStringLiteral(n.left) && isKindAccess(n.right)) refs.add(n.left.text);
      else if (ts.isStringLiteral(n.right) && isKindAccess(n.left)) refs.add(n.right.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sourceFile);
  return { refs, domainPrefixes };
}

/**
 * Compare the catalog's declared entries against the `.kind` dispatch
 * references in `catalogSourceText`.
 *
 * `catalog` is a read from the ONE shared reader
 * (`readRuntimeCatalog`, `@arbor/governance` — see
 * `packages/arbor-governance/src/counts/catalog.ts`). This function used to do
 * its own parse and it could not follow the alias: `runtime-catalog.ts` is
 * `export const RUNTIME_CATALOG = RUNTIME_CATALOG_MANIFEST;`, an Identifier, so
 * it reported "'RUNTIME_CATALOG' is not initialized with an array literal" on a
 * perfectly healthy catalog and the gate was red. The entries come from the
 * reader; only the dispatch-reference scan is local, because references live in
 * the ROUTER file that the reader does not and should not read.
 *
 * The two are deliberately asymmetric and that is the shape being checked: the
 * manifest declares, `runtime-catalog.ts` dispatches. An unmeasured `catalog` is
 * a finding, never an empty entry list — an empty list would silently satisfy
 * the inverse check and make this gate pass because its reader was broken.
 */
export function checkCatalogDispatchDrift(catalogSourceText, catalog) {
  const sourceFile = parseTs("runtime-catalog.ts", catalogSourceText);
  if (!catalog.measured) {
    return { violations: [{ reason: `runtime catalog could not be read (${catalog.code}): ${catalog.reason}` }], entries: [] };
  }
  // Entries without a `direction` are read but not dispatchable, so they cannot
  // be matched against a dispatch reference. Same rule the parity gate applies
  // via the shared `isDispatchableDirection`, narrowed here to "has one".
  const entries = catalog.entries.filter((entry) => entry.direction !== undefined);

  const { refs: directRefs, domainPrefixes } = collectKindReferences(sourceFile);
  const allKinds = new Set(entries.map((e) => e.kind));
  const groupKey = (e) => `${e.kind.split(".")[0]}::${e.direction}`;
  const groups = new Map();
  for (const entry of entries) {
    const key = groupKey(entry);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  const violations = [];
  for (const entry of entries) {
    if (!entry.supported) continue; // supported:false is the catalog's own allowlist declaration
    if (directRefs.has(entry.kind)) continue;
    if ([...domainPrefixes].some((prefix) => entry.kind.startsWith(prefix))) continue;
    const siblingLive = groups.get(groupKey(entry)).some((sibling) => sibling.kind !== entry.kind && directRefs.has(sibling.kind));
    if (siblingLive) continue;
    violations.push({
      kind: entry.kind,
      reason: `RUNTIME_CATALOG marks "${entry.kind}" supported:true, but neither it nor any same-domain/same-direction sibling is referenced by a '.kind' switch case, catalogEntry(...) call, or '.kind ===' comparison anywhere in the file`,
    });
  }
  for (const ref of directRefs) {
    // Runtime catalog kinds are namespaced (`domain.operation`). Bare
    // discriminants in this file belong to result unions such as
    // `selected`, `unavailable`, and `measured`, not dispatch commands.
    if (!ref.includes(".")) continue;
    if (!allKinds.has(ref)) {
      violations.push({ kind: ref, reason: `a '.kind' dispatch reference to "${ref}" exists, but no RUNTIME_CATALOG entry declares that kind` });
    }
  }
  return { violations, entries };
}

// ---------------------------------------------------------------------------
// Check 5 — orphaned scripts (scripts/*.mjs vs. package.json's gate:* scripts).
// ---------------------------------------------------------------------------

function extractHeaderComment(text) {
  const m = text.match(/\/\*\*([\s\S]*?)\*\//);
  return m ? m[1] : "";
}

/**
 * Every `gate:<name>` token mentioned in a "bun run gate:<name>" line inside
 * a header comment — the exact convention every existing gate's own "Usage:"
 * block already follows (`bun run gate:reachability`, `bun run
 * gate:docs-truth`, ...). A library/utility script (anti-stub-rules.mjs,
 * roundtrip-shape.mjs — pure exports, no CLI "Usage:" section of their own;
 * install-git-hooks.mjs — a real CLI, but documents `node
 * scripts/install-git-hooks.mjs` directly, never a `gate:` name, because it
 * is a setup action, not a correctness check) never contains this pattern
 * for itself, so this signal is precise without relying on a loose "does the
 * word 'gate' appear anywhere in this file's prose" match, which produced
 * false positives against exactly those two library files during this
 * check's own development (both mention "gate" — describing a *different*
 * file — deep in their header prose).
 */
function selfDeclaredGateNames(headerText) {
  const names = new Set();
  for (const m of headerText.matchAll(/bun run (gate:[\w:-]+)/g)) names.add(m[1]);
  return names;
}

/**
 * scriptFiles: [{ basename: "foo.mjs", text: "<full file contents>" }, ...]
 * packageJsonScripts: package.json's parsed "scripts" object.
 */
export function checkOrphanedScripts(scriptFiles, packageJsonScripts) {
  const violations = [];

  for (const file of scriptFiles) {
    const header = extractHeaderComment(file.text);
    const declaredNames = selfDeclaredGateNames(header);
    for (const name of declaredNames) {
      const command = packageJsonScripts[name];
      if (command === undefined) {
        violations.push({ file: file.basename, reason: `header documents "bun run ${name}" but package.json has no "${name}" script at all` });
      } else if (!command.includes(`scripts/${file.basename}`)) {
        violations.push({ file: file.basename, reason: `header documents "bun run ${name}", but package.json's "${name}" script does not reference scripts/${file.basename} (got: ${command})` });
      }
    }
  }

  // Inverse: a gate:* entry pointing at a scripts/*.mjs file that isn't there.
  for (const [scriptName, command] of Object.entries(packageJsonScripts)) {
    if (!scriptName.startsWith("gate:")) continue;
    const m = command.match(/scripts\/([\w.-]+\.mjs)/);
    if (!m) continue; // gate: entry doesn't target a scripts/*.mjs file (e.g. vite-node .ts, vitest) — out of scope
    const targetBasename = m[1];
    if (!scriptFiles.some((f) => f.basename === targetBasename)) {
      violations.push({ file: targetBasename, reason: `package.json script "${scriptName}" references scripts/${targetBasename}, which does not exist` });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Direct-execution guard (self-application of check 1's own bar) + main().
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
  const abs = join(REPO_ROOT, relPath);
  if (!existsSync(abs)) return null;
  return readFileSync(abs, "utf-8");
}

/**
 * `packages/arbor-mcp/src/*` well-known file paths, derived from the
 * profile's `source_roots` (ADR-073) instead of a hardcoded `packages/`
 * prefix. `sourceRoots` is `profileOrDefaults(REPO_ROOT).source_roots`;
 * since that falls back to `["packages"]` for a repo with no
 * arbor.profile.jsonc, this is byte-identical to the previous hardcoded
 * paths on this repo either way. Exported for direct testing.
 */
export function arborMcpSrcPaths(sourceRoots) {
  const [root] = sourceRoots;
  return {
    cli: `${root}/arbor-mcp/src/cli.ts`,
    tools: `${root}/arbor-mcp/src/tools.ts`,
    devtools: `${root}/arbor-mcp/src/devtools.ts`,
    server: `${root}/arbor-mcp/src/server.ts`,
    runtimeCatalog: `${root}/arbor-mcp/src/runtime-catalog.ts`,
  };
}

function listScriptsMjs() {
  return readdirSync(join(REPO_ROOT, "scripts"))
    .filter((name) => name.endsWith(".mjs"))
    .sort()
    .map((name) => ({ basename: name, text: readFileSync(join(REPO_ROOT, "scripts", name), "utf-8") }));
}

function main() {
  const report = { ok: true, checks: {} };
  const sourceRoots = profileOrDefaults(REPO_ROOT).source_roots;
  const srcPaths = arborMcpSrcPaths(sourceRoots);

  // Check 1
  const manifestPath = join(__dirname, "reachability", "entry-points.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  report.checks.deadEntrypoints = checkDeadEntrypoints(manifest.entryPoints, readRepoFile);

  // Check 2
  const cliText = readRepoFile(srcPaths.cli);
  report.checks.cliDispatch = cliText ? checkCliDispatch(cliText).violations : [{ reason: `${srcPaths.cli} not found` }];

  // Check 3
  const toolsText = readRepoFile(srcPaths.tools);
  const devtoolsText = readRepoFile(srcPaths.devtools);
  const serverText = readRepoFile(srcPaths.server);
  report.checks.toolRegistration =
    toolsText && devtoolsText && serverText
      ? checkToolRegistration(toolsText, devtoolsText, serverText)
      : [{ reason: `tools.ts, devtools.ts, or server.ts not found under ${srcPaths.tools.replace(/\/tools\.ts$/, "")}` }];

  // Check 4
  const catalogText = readRepoFile(srcPaths.runtimeCatalog);
  const catalogRead = readRuntimeCatalog({
    repoRoot: REPO_ROOT,
    catalogPath: srcPaths.runtimeCatalog,
    sourceRoots,
  });
  report.checks.catalogDispatchDrift = checkCatalogDispatchDrift(catalogText ?? "", catalogRead).violations;

  // Check 5
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8"));
  report.checks.orphanedScripts = checkOrphanedScripts(listScriptsMjs(), packageJson.scripts ?? {});

  const totalViolations = Object.values(report.checks).reduce((n, v) => n + v.length, 0);
  report.ok = totalViolations === 0;
  report.totalViolations = totalViolations;

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`registration-integrity gate — ${totalViolations} violation(s) across 5 checks\n`);
    for (const [name, violations] of Object.entries(report.checks)) {
      console.log(`${name}: ${violations.length} violation(s)`);
      for (const v of violations) {
        const label = v.id ?? v.command ?? v.kind ?? v.file ?? "";
        console.log(`  - ${label ? `${label}: ` : ""}${v.reason}`);
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
