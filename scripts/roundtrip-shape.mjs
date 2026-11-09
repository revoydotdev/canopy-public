#!/usr/bin/env node
/**
 * scripts/roundtrip-shape.mjs — Phase 6.3 roundtrip-conformance, semantic
 * half. Shared, unit-tested logic; wired into scripts/docs-truth.mjs.
 *
 * The gap this closes (see audit/20-gate-honesty.md's 6.3 row): 6.3's
 * mechanism is real and automated for RUNTIME_CATALOG-dispatched kinds
 * (packages/arbor-mcp/tests/roundtrip/manifest.test.ts checks every
 * `landed` entry's exact `it(...)` title genuinely exists in its target
 * file — "non-vaporware"). For every *other* ✅ tranche's `roundtrip=`
 * proof comment in ROADMAP.md, docs-truth.mjs previously checked only that
 * the cited file exists and that the file's whole-file vitest run status
 * was "passed" — a naming convention with no check that a cited test is
 * actually a roundtrip in 6.3's own defined sense ("driving it from an
 * outermost entry point, through the ledger, and back out through a
 * projection... a roundtrip that never leaves the module is not a
 * roundtrip"). This module adds that semantic check, without touching the
 * manifest (packages/**, out of this lane's ownership) and without
 * requiring any change to ROADMAP.md's existing `roundtrip=<file>` syntax
 * (it names a file, not a specific test, so the check operates over the
 * whole file — see `evaluateRoundtripFile` below for exactly what that
 * means for precision).
 *
 * What "real roundtrip shape" means here, mechanically
 * ------------------------------------------------------
 * Two independent, low-false-positive signals, chosen to be provable
 * against this repo's actual cited files (see the header comment in
 * scripts/tests/roundtrip-shape.test.mjs for the calibration runs):
 *
 * 1. **Boundary-crossing evidence.** The file must call at least two
 *    DISTINCT non-assertion, non-builtin operations — either a bare call
 *    to a name imported from outside "vitest"/"node:*" (a src-exported
 *    function), or a `receiver.method(...)` call whose method name is not
 *    a known vitest matcher / common JS/Node builtin (see EXCLUDED_METHODS
 *    below). A test that only ever calls one such operation cannot have
 *    written something and separately read it back — "a roundtrip that
 *    never leaves the module is not a roundtrip," made syntactic: a
 *    single-operation test is definitionally not driving something THROUGH
 *    a boundary and back.
 *
 * 2. **Non-tautological assertion.** Reuses the anti-stub Rule 5 detectors
 *    (scripts/anti-stub-rules.mjs) — a file where literally every
 *    `expect(...)` call is a length/size tautology or a vacuously-guarded
 *    assertion cannot be asserting real payload substance, which 6.3
 *    explicitly requires ("the assertion must include payload substance,
 *    not just record presence").
 *
 * What this deliberately does NOT attempt: understanding whether the
 * asserted substance actually corresponds to the *specific* capability the
 * proof comment claims (that is the harder, semantic-non-discrimination
 * defect the original 4D.3 capability-routing test had — see
 * anti-stub-rules.mjs's header comment for why that is not mechanically
 * checkable by a static rule). This check proves a cited file COULD be a
 * real roundtrip (crosses a boundary, asserts real substance); it does not
 * and cannot prove the assertion is about the claimed property.
 *
 * Conservative bias (stated explicitly; D4b, §24.2 P8) — same ADR-117
 * direction as registration-integrity.mjs and anti-stub-rules.mjs: "two
 * independent, LOW-FALSE-POSITIVE signals" (above) means this module is
 * built to prefer silence over a false accusation. Concretely: the
 * EXCLUDED_METHODS list exists specifically so ordinary data-shuffling
 * (`.map`, `.filter`, `.get`, ...) and vitest matcher chains don't count as
 * "operations," which would otherwise make nearly every test file look like
 * it crosses two boundaries whether or not it really does. Note this is the
 * OPPOSITE direction from docs-truth.mjs, the gate that calls into this
 * module: docs-truth.mjs itself is fail-closed (an ambiguous symbol lookup
 * is treated as no-match), but the semantic judgment it delegates to here —
 * "is this actually a roundtrip" — is deliberately built to under-detect
 * rather than over-accuse. The two postures compose safely because they
 * apply to different questions (does the proof comment resolve at all, vs.
 * does the resolved file's *content* look like a real roundtrip), not to
 * the same one.
 */

import { readFileSync } from "node:fs";
import ts from "typescript";
import { checkLengthTautology, checkVacuousGuardedAssertion } from "./anti-stub-rules.mjs";

// vitest/jest matcher names and common JS/Node builtin methods — excluded so
// they don't count as "operations" (they're assertion machinery or generic
// data-shuffling, not calls into a src-exported capability).
const EXCLUDED_METHODS = new Set([
  // vitest/expect chain
  "toBe", "toEqual", "toStrictEqual", "toMatch", "toMatchObject", "toContain", "toContainEqual",
  "toHaveLength", "toHaveProperty", "toBeDefined", "toBeUndefined", "toBeNull", "toBeTruthy",
  "toBeFalsy", "toBeGreaterThan", "toBeGreaterThanOrEqual", "toBeLessThan", "toBeLessThanOrEqual",
  "toBeCloseTo", "toBeInstanceOf", "toBeNaN", "toThrow", "toThrowError", "toHaveBeenCalled",
  "toHaveBeenCalledWith", "toHaveBeenCalledTimes", "not", "resolves", "rejects",
  // common JS/Node builtins that shuffle data without crossing an app boundary
  "push", "pop", "shift", "unshift", "slice", "splice", "concat", "join", "split", "trim",
  "replace", "replaceAll", "map", "filter", "find", "findIndex", "some", "every", "sort",
  "reduce", "forEach", "includes", "indexOf", "lastIndexOf", "keys", "values", "entries",
  "has", "get", "set", "add", "delete", "clear", "toString", "valueOf", "then", "catch",
  "finally", "close", "test", "exec", "match", "repeat", "padStart", "padEnd", "toISOString",
  "toFixed", "flat", "flatMap", "toJSON", "toLowerCase", "toUpperCase",
]);

const EXCLUDED_IMPORT_SOURCES = /^(vitest|node:)/;

function importedOperationNames(sourceFile) {
  const names = new Set();
  ts.forEachChild(sourceFile, (node) => {
    if (!ts.isImportDeclaration(node)) return;
    if (!ts.isStringLiteral(node.moduleSpecifier)) return;
    if (EXCLUDED_IMPORT_SOURCES.test(node.moduleSpecifier.text)) return;
    const clause = node.importClause;
    if (!clause) return;
    if (clause.name) names.add(clause.name.text); // default import
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) names.add(el.name.text);
    }
  });
  return names;
}

/** Distinct operation-call names: bare calls to an imported (non-test,
 * non-builtin) symbol, plus `x.method(...)` calls whose method name isn't a
 * known matcher/builtin. Deliberately coarse — a lead, not a proof, exactly
 * like the anti-stub rules this reuses. */
export function distinctOperationCalls(sourceFile) {
  const imported = importedOperationNames(sourceFile);
  const found = new Set();
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && imported.has(callee.text)) {
        found.add(callee.text);
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
        const method = callee.name.text;
        if (!EXCLUDED_METHODS.has(method) && method !== "expect") found.add(method);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

function allExpectCallCount(sourceFile) {
  let n = 0;
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "expect") n++;
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return n;
}

/**
 * Evaluate a single roundtrip test file's source text for the two signals
 * above. Returns `{ ok, reasons }` — `reasons` is a list of human-readable
 * failure explanations (empty when `ok`).
 */
export function evaluateRoundtripShape(sourceText, fileName) {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const reasons = [];

  const ops = distinctOperationCalls(sourceFile);
  if (ops.size < 2) {
    reasons.push(
      `only ${ops.size} distinct operation call(s) found (${[...ops].join(", ") || "none"}) — ` +
        `no evidence this file drives more than one operation, so it cannot be shown to write ` +
        `something and separately read it back through a projection`,
    );
  }

  const totalExpects = allExpectCallCount(sourceFile);
  const tautological = checkLengthTautology(sourceFile).length + checkVacuousGuardedAssertion(sourceFile).length;
  if (totalExpects > 0 && tautological >= totalExpects) {
    reasons.push(`every expect(...) call in this file (${totalExpects}) is a tautological assertion (anti-stub Rule 5 shape)`);
  }

  return { ok: reasons.length === 0, reasons, distinctOperationCount: ops.size, totalExpects, tautologicalCount: tautological };
}

/** Convenience wrapper for docs-truth.mjs: reads the file from disk. */
export function evaluateRoundtripFile(absPath) {
  const text = readFileSync(absPath, "utf-8");
  return evaluateRoundtripShape(text, absPath);
}
