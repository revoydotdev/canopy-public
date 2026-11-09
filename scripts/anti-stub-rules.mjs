#!/usr/bin/env node
/**
 * scripts/anti-stub-rules.mjs — shared, unit-testable rule bodies for the
 * Phase 6.5 static anti-stub gate (scripts/anti-stub.mjs).
 *
 * Rules 1-3 and Rule 4's stream-parameter arm live inline in anti-stub.mjs;
 * Rule 2 needs cross-file schema-key lookups. Rule 4's local subprocess
 * provenance analysis and Rule 5 are factored here for focused regression
 * tests against synthetic or real source files. Rule 4 accepts the existing
 * program's checker so identifier identity remains scope-aware; Rule 5 is
 * syntax-only and needs no checker.
 *
 * Rule 5 — tautological test. Two independently-detected, narrow syntactic
 * shapes, chosen because they are exactly the two shapes ROADMAP.md's G-24
 * register row documents as having actually shipped and gone undetected in
 * this repository (arbor-opencode/tests/loop.test.ts, fixed 2026-08-04):
 *
 *   5a. `expect(<expr>.length).toBeGreaterThanOrEqual(0)` (or the
 *       `.toBeGreaterThan(-1)` equivalent) — an assertion on an array/string
 *       `.length` or a `Map`/`Set` `.size` that can never fail, because
 *       length/size is never negative in JS. Scoped deliberately to
 *       `.length`/`.size` receivers only — a bare `toBeGreaterThanOrEqual(0)`
 *       on a domain-typed numeric field (a token count, an iteration
 *       counter) is NOT tautological in the same sense: unlike `.length`,
 *       nothing in the language prevents that field from going negative if
 *       the computation producing it were wrong, so the assertion is real
 *       and narrowing the rule this way avoids flagging the many genuine
 *       non-negativity sanity checks already in this codebase (e.g.
 *       loop-executor-contract.test.ts's `usage.input_tokens`).
 *
 *   5b. A real `expect(...)` assertion inside an `if (<bareIdentifier>) { }`
 *       block that has no `else` — so when the guard is false, the block
 *       (and every assertion inside it) never runs, and the test still
 *       passes having asserted nothing for that branch. Scoped to a bare
 *       identifier condition specifically (not a general boolean
 *       expression like `e.type === "foo"`) because that narrower shape is
 *       exactly the G-24 pattern (`if (auto) { ... }`, where `auto` came
 *       from an `Array.prototype.find` that can return `undefined`) and
 *       because the general form is the same AST shape used throughout this
 *       codebase's legitimate "for (const e of events) if (e.type === X)"
 *       event-correlation idiom — flagging every instance of that idiom
 *       would bury the rule in false positives for a widely-used, otherwise
 *       sound pattern. A prior `expect(<guard>).toBeDefined()` /
 *       `.not.toBeUndefined()` / `.toBeTruthy()` earlier in the same block
 *       is treated as establishing the guard is unconditionally true, so
 *       the finding is suppressed (the assertion is no longer vacuous).
 *
 * Known, disclosed limitation (not covered by either shape): a second
 * historical tautological test existed in this repository — the original
 * "routes selection through NodeCard capability routing" test in
 * arbor-opencode/tests/loop.test.ts (fixed the same day as G-24, commit
 * 651294f) — whose assertions (`report.campaign_id`, `report.verified > 0`,
 * `report.halted === true`) were each individually real and each
 * individually failable, but held identically regardless of whether the
 * capability-routing behavior the test's name claims to verify ever ran.
 * That is a *semantic* non-discrimination defect — the assertions don't
 * distinguish the claimed behavior from its absence — not a *syntactic*
 * tautology, and detecting it mechanically would require understanding
 * what property a test's name asserts versus what its body actually
 * exercises, which is not a static-analysis problem these two rules (or any
 * reasonably precise AST rule) can solve. This is named here rather than
 * silently left uncovered: Rule 5 catches the G-24 shape by construction,
 * not every shape "tautological test" could mean.
 *
 * Conservative bias (stated explicitly; D4b, §24.2 P8) — same ADR-117
 * direction as registration-integrity.mjs: prefer silence over a false
 * accusation. Both rules below are deliberately narrower than the shape
 * they could catch — 5a is scoped to exactly
 * `.length|.size` + `toBeGreaterThanOrEqual(0)`/`toBeGreaterThan(-1)` rather
 * than any always-true comparison, and 5b is scoped to a bare-identifier
 * guard specifically (see `guardEstablishedEarlier`'s own doc comment:
 * "this only needs to suppress the false-positive case, not catch every
 * possible prior assertion") — because the wider shape would flag this
 * codebase's real, sound `if (guard) { ... }`/event-correlation idioms. The
 * disclosed limitation above (the semantic non-discrimination shape) is the
 * same policy applied at the level of "what this file doesn't attempt at
 * all," not just per-rule scoping.
 */

import ts from "typescript";

const CHILD_PROCESS_MODULES = new Set(["child_process", "node:child_process"]);
const CHILD_PROCESS_TEXT_APIS = new Set(["execSync", "execFileSync"]);
const CHILD_PROCESS_RESULT_APIS = new Set(["spawn", "spawnSync", "fork"]);
const CHILD_PROCESS_CALLBACK_APIS = new Set(["exec", "execFile"]);
const NODE_REQUIRE_DECLARATION_RE = /(?:^|[\\/])node_modules[\\/]@types[\\/]node[\\/]module\.d\.ts$/;

function isNodeBuiltinRequire(identifier, checker) {
  const symbol = checker.getSymbolAtLocation(identifier);
  return (symbol?.declarations ?? []).some((declaration) =>
    ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name) && declaration.name.text === "require" &&
    declaration.type?.getText(declaration.getSourceFile()) === "NodeJS.Require" &&
    NODE_REQUIRE_DECLARATION_RE.test(declaration.getSourceFile().fileName.replace(/\\/g, "/")));
}

/** Resolve imported child_process names without treating an unrelated local
 * function named `exec` or a regular-expression `.exec()` as a process call. */
function childProcessBindings(sourceFile, checker) {
  const named = new Map();
  const namespaces = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!CHILD_PROCESS_MODULES.has(statement.moduleSpecifier.text)) continue;
    if (statement.importClause?.isTypeOnly) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(checker.getSymbolAtLocation(bindings.name));
    else if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (!element.isTypeOnly) named.set(checker.getSymbolAtLocation(element.name), element.propertyName?.text ?? element.name.text);
      }
    }
  }

  // CommonJS equivalents: `const cp = require(...)` and
  // `const { spawnSync: run } = require(...)`, including nested scopes. The
  // checker must resolve the callee to Node's ambient require declaration;
  // a local function/parameter named `require` is not treated as a builtin.
  function isChildProcessRequire(expression) {
    return ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) &&
      isNodeBuiltinRequire(expression.expression, checker) && expression.arguments.length === 1 &&
      ts.isStringLiteral(expression.arguments[0]) && CHILD_PROCESS_MODULES.has(expression.arguments[0].text);
  }
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.initializer && isChildProcessRequire(node.initializer)) {
      if (ts.isIdentifier(node.name)) namespaces.add(checker.getSymbolAtLocation(node.name));
      else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (element.dotDotDotToken || !ts.isIdentifier(element.name)) continue;
          const api = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
          named.set(checker.getSymbolAtLocation(element.name), api);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { named, namespaces };
}

function childProcessApi(expression, bindings, checker) {
  if (ts.isIdentifier(expression)) return bindings.named.get(checker.getSymbolAtLocation(expression));
  if (ts.isPropertyAccessExpression(expression)) {
    if (ts.isIdentifier(expression.expression) && bindings.namespaces.has(checker.getSymbolAtLocation(expression.expression))) {
      return expression.name.text;
    }
    if (ts.isCallExpression(expression.expression) && ts.isIdentifier(expression.expression.expression) &&
        isNodeBuiltinRequire(expression.expression.expression, checker) && expression.expression.arguments.length === 1 &&
        ts.isStringLiteral(expression.expression.arguments[0]) && CHILD_PROCESS_MODULES.has(expression.expression.arguments[0].text)) {
      return expression.name.text;
    }
  }
  return undefined;
}

function isJsonParseCall(node) {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "parse" && ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "JSON";
}

/**
 * Find JSON.parse calls whose input has a local, syntactic path from a
 * child_process output. This deliberately replaces the old file-wide
 * "imports child_process + contains JSON.parse" fallback: reading an owned
 * JSON/JSONL file in a module that happens to run a subprocess is unrelated.
 *
 * The analysis is single-file and conservative. It follows direct synchronous
 * output, spawn result stdout/stderr, simple local aliases, exec callback
 * output parameters, and data callbacks on a spawned child's stdout/stderr.
 * It does not attempt interprocedural or arbitrary dataflow analysis.
 */
export function findSubprocessOutputJsonParses(sourceFile, checker) {
  if (!checker) throw new TypeError("findSubprocessOutputJsonParses requires a TypeScript checker");
  const bindings = childProcessBindings(sourceFile, checker);
  const processResults = new Set();
  const processText = new Set();
  const declarations = [];
  const calls = [];

  function functionLikeFor(argument) {
    while (ts.isParenthesizedExpression(argument) || ts.isAsExpression(argument) || ts.isTypeAssertionExpression(argument)) argument = argument.expression;
    if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) return argument;
    if (!ts.isIdentifier(argument)) return undefined;
    const symbol = checker.getSymbolAtLocation(argument);
    for (const declaration of symbol?.declarations ?? []) {
      if (ts.isFunctionDeclaration(declaration)) return declaration;
      if (ts.isVariableDeclaration(declaration) && declaration.initializer &&
          (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) return declaration.initializer;
    }
    return undefined;
  }

  function markCallbackParameters(argument, indexes) {
    const callback = functionLikeFor(argument);
    if (!callback) return false;
    let changed = false;
    for (const index of indexes) {
      const parameter = callback.parameters[index];
      if (!parameter || !ts.isIdentifier(parameter.name)) continue;
      const symbol = checker.getSymbolAtLocation(parameter.name);
      if (symbol && !processText.has(symbol)) {
        processText.add(symbol);
        changed = true;
      }
    }
    return changed;
  }

  function visit(node) {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    if (ts.isCallExpression(node)) {
      calls.push(node);
      const api = childProcessApi(node.expression, bindings, checker);
      if (api && CHILD_PROCESS_CALLBACK_APIS.has(api)) {
        for (const argument of node.arguments) markCallbackParameters(argument, [1, 2]);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  function expressionKind(expression) {
    while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
      expression = expression.expression;
    }
    if (ts.isIdentifier(expression)) {
      const symbol = checker.getSymbolAtLocation(expression);
      if (symbol && processText.has(symbol)) return "text";
      if (symbol && processResults.has(symbol)) return "result";
      return undefined;
    }
    if (ts.isCallExpression(expression)) {
      const api = childProcessApi(expression.expression, bindings, checker);
      if (api && CHILD_PROCESS_TEXT_APIS.has(api)) return "text";
      if (api && CHILD_PROCESS_RESULT_APIS.has(api)) return "result";
      if (ts.isIdentifier(expression.expression) && expression.expression.text === "String" && expression.arguments.length === 1) {
        return expressionKind(expression.arguments[0]) === "text" ? "text" : undefined;
      }
      if (ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === "toString") {
        return expressionKind(expression.expression.expression) === "text" ? "text" : undefined;
      }
      return undefined;
    }
    if (ts.isPropertyAccessExpression(expression) && (expression.name.text === "stdout" || expression.name.text === "stderr")) {
      return expressionKind(expression.expression) === "result" ? "text" : undefined;
    }
    return undefined;
  }

  // Follow simple aliases to a fixed point so declaration order does not
  // affect the result, and keep destructured spawnSync output explicit.
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (!declaration.initializer) continue;
      const kind = expressionKind(declaration.initializer);
      if (ts.isIdentifier(declaration.name)) {
        const set = kind === "text" ? processText : kind === "result" ? processResults : undefined;
        const symbol = checker.getSymbolAtLocation(declaration.name);
        if (set && symbol && !set.has(symbol)) {
          set.add(symbol);
          changed = true;
        }
      } else if (kind === "result" && ts.isObjectBindingPattern(declaration.name)) {
        for (const element of declaration.name.elements) {
          if (element.dotDotDotToken || !ts.isIdentifier(element.name)) continue;
          const property = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
          const symbol = checker.getSymbolAtLocation(element.name);
          if ((property === "stdout" || property === "stderr") && symbol && !processText.has(symbol)) {
            processText.add(symbol);
            changed = true;
          }
        }
      }
    }
    for (const call of calls) {
      if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "on" ||
          call.arguments.length < 2 || !ts.isStringLiteral(call.arguments[0]) || call.arguments[0].text !== "data") continue;
      const stream = call.expression.expression;
      if (!ts.isPropertyAccessExpression(stream) || (stream.name.text !== "stdout" && stream.name.text !== "stderr") ||
          expressionKind(stream.expression) !== "result") continue;
      changed = markCallbackParameters(call.arguments[1], [0]) || changed;
    }
  }

  const findings = [];
  for (const call of calls) {
    if (!isJsonParseCall(call) || call.arguments.length === 0) continue;
    if (expressionKind(call.arguments[0]) === "text") findings.push(call);
  }
  return findings;
}

/** Parse a TS/TSX snippet into a source file with parent pointers set (no
 * ts.Program needed — Rule 5 never needs the type checker). */
export function parseSnippet(text, fileName = "snippet.test.ts") {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TS);
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** True if `node` is `expect(...)` — a CallExpression whose callee is the
 * bare identifier `expect`. */
function isExpectCall(node) {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "expect";
}

/** Given the receiver expression of a matcher's final property access (e.g.
 * for `expect(X).toBeGreaterThanOrEqual(0)`, the receiver of
 * `.toBeGreaterThanOrEqual` is `expect(X)`; for the negated
 * `expect(X).not.toBeGreaterThanOrEqual(0)`, it's `expect(X).not`), walk
 * back down through any `.not`/property-access links to the root
 * `expect(X)` call and return `X`. */
function expectArgOf(receiverExpr) {
  let expr = receiverExpr;
  while (ts.isPropertyAccessExpression(expr)) expr = expr.expression;
  if (isExpectCall(expr)) return expr.arguments[0];
  return undefined;
}

// ---------------------------------------------------------------------------
// Rule 5a — expect(<expr>.length|.size).toBeGreaterThanOrEqual(0) / toBeGreaterThan(-1)
// ---------------------------------------------------------------------------

function isMinusOne(node) {
  return (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand) &&
    node.operand.text === "1"
  );
}

function isZero(node) {
  return ts.isNumericLiteral(node) && node.text === "0";
}

export function checkLengthTautology(sourceFile) {
  const findings = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const matcher = node.expression.name.text;
      const isGte0 = matcher === "toBeGreaterThanOrEqual" && node.arguments.length === 1 && isZero(node.arguments[0]);
      const isGtNeg1 = matcher === "toBeGreaterThan" && node.arguments.length === 1 && isMinusOne(node.arguments[0]);
      if (isGte0 || isGtNeg1) {
        const asserted = expectArgOf(node.expression.expression);
        if (asserted && ts.isPropertyAccessExpression(asserted) && (asserted.name.text === "length" || asserted.name.text === "size")) {
          findings.push({
            line: lineOf(sourceFile, node),
            text: node.getText(sourceFile).replace(/\s+/g, " ").trim().slice(0, 160),
            receiver: asserted.name.text,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return findings;
}

// ---------------------------------------------------------------------------
// Rule 5b — expect(...) inside `if (<bareIdentifier>) { }` with no else,
// where the guard identifier isn't already established as defined earlier
// in the same block.
// ---------------------------------------------------------------------------

function blockStatements(node) {
  if (ts.isBlock(node)) return node.statements;
  return [node]; // single-statement `if (x) expect(...)` with no braces
}

function containsExpectCall(node) {
  let found = false;
  function visit(n) {
    if (found) return;
    if (isExpectCall(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return found;
}

/** Does an earlier sibling statement in `siblings` (before `beforeIndex`)
 * already assert the guard identifier is defined/truthy? A narrow,
 * text-based check deliberately kept simple: this only needs to suppress
 * the false-positive case, not catch every possible prior assertion. */
function guardEstablishedEarlier(siblings, beforeIndex, sourceFile, guardName) {
  const DEFINED_RE = new RegExp(
    `expect\\(\\s*${guardName}\\s*\\)\\s*\\.(?:toBeDefined|toBeTruthy|not\\.toBeUndefined|not\\.toBeNull)\\s*\\(`,
  );
  for (let i = 0; i < beforeIndex; i++) {
    if (DEFINED_RE.test(siblings[i].getText(sourceFile))) return true;
  }
  return false;
}

export function checkVacuousGuardedAssertion(sourceFile) {
  const findings = [];
  function visit(node, enclosingBlockStatements, indexInBlock) {
    if (ts.isIfStatement(node) && !node.elseStatement && ts.isIdentifier(node.expression)) {
      const guardName = node.expression.text;
      if (containsExpectCall(node.thenStatement)) {
        const established =
          enclosingBlockStatements !== undefined &&
          guardEstablishedEarlier(enclosingBlockStatements, indexInBlock, sourceFile, guardName);
        if (!established) {
          findings.push({
            line: lineOf(sourceFile, node),
            guard: guardName,
            text: node.getText(sourceFile).split("\n")[0].trim().slice(0, 160),
          });
        }
      }
    }
    if (ts.isBlock(node)) {
      node.statements.forEach((stmt, i) => visit(stmt, node.statements, i));
    } else {
      ts.forEachChild(node, (child) => visit(child, enclosingBlockStatements, indexInBlock));
    }
  }
  visit(sourceFile, undefined, -1);
  return findings;
}

export function checkTautologicalTest(sourceFile) {
  return {
    lengthTautology: checkLengthTautology(sourceFile),
    vacuousGuardedAssertion: checkVacuousGuardedAssertion(sourceFile),
  };
}
