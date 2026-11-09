/**
 * catalog.ts — the ONE reader for the runtime catalog.
 *
 * WHY THIS EXISTS. Three consumers needed the catalog's entry list and each
 * shipped its own parser, and they did not agree:
 *
 *   - `packages/arbor-governance/src/counts/derive.ts` counted distinct `kind`
 *     literals, followed the alias with a regex scan over every source file.
 *   - `scripts/lib/tui-catalog-parity/catalog-parser.mjs` followed the alias as
 *     a same-file identifier, then a relative or `@arbor/*` import.
 *   - `scripts/registration-integrity.mjs` followed neither: it stopped at the
 *     alias, found an `Identifier` where it wanted an array literal, and
 *     reported `gate:registration-integrity` red with
 *     "'RUNTIME_CATALOG' is not initialized with an array literal" — the
 *     documented gap this module closes.
 *
 * Two parsers reached the manifest and one did not, and nothing in the
 * repository could make that visible: each consumer derived its own number and
 * reported it in its own vocabulary. A count that three gates compute three
 * ways can disagree silently, which is exactly the drift
 * `scripts/guard-canaries.mjs`'s census exists to expose.
 *
 * WHY `packages/` AND NOT `scripts/lib/`. `scripts/*.mjs` already import
 * `@arbor/governance` (adr-citations.mjs, adr-status-audit.mjs, adr-proof.mjs),
 * and `packages/arbor-mcp/src/project-registry.ts` records the inverse rule
 * explicitly: importing `scripts/lib` from a package inverts the package
 * boundary. So the shared reader lives in the package the two `.mjs` consumers
 * can already reach, and gains no new package dependency — `typescript` is
 * already one of `@arbor/governance`'s.
 *
 * Purity: structural only. `ts.createSourceFile` (no `Program`, no
 * type-checker) plus `readFileSync`; it never imports or executes the module
 * it reads, and it never falls back to a remembered count.
 *
 * UNMEASURED, NOT ZERO. When the entry file cannot be read, or the symbol
 * cannot be resolved to an array literal, the result is
 * `{ measured: false }` — never an empty entry list. An empty list and an
 * unreadable source are different facts, and a gate that cannot tell them apart
 * reports a passing gate for a broken reader. This is the same
 * absence-as-zero defect `derive.ts` documents; it is why the read is a
 * discriminated union rather than an array.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import ts from "typescript";

/** The exported symbol every consumer is asking about. */
export const CATALOG_SYMBOL = "RUNTIME_CATALOG";

/**
 * A catalog entry as read structurally. `direction` is absent when the entry
 * does not declare one: the three former parsers disagreed on whether such an
 * entry counts (see `catalogKinds` and `isDispatchableDirection` below), so
 * the reader keeps the fact and lets each consumer apply its own rule.
 */
export interface RuntimeCatalogEntry {
  kind: string;
  direction?: string;
  supported: boolean;
  /** 1-indexed line of the entry's opening `{` in the file the literal was found in. */
  line: number;
}

export interface CatalogMeasured {
  measured: true;
  entries: RuntimeCatalogEntry[];
  /** File the array literal was actually read from — not necessarily `catalogPath`. */
  entryPath: string | null;
}

export interface CatalogUnmeasured {
  measured: false;
  /**
   * `unreadable` — the entry file does not exist or could not be read. No
   * measurement was ever started.
   * `unresolved` — a file was read but `RUNTIME_CATALOG` did not resolve to an
   * array literal within the hop bound. The shape is not understood.
   */
  code: "unreadable" | "unresolved";
  reason: string;
}

export type CatalogRead = CatalogMeasured | CatalogUnmeasured;

export interface ReadRuntimeCatalogOptions {
  /** Repository root; `catalogPath` and `sourceRoots` are resolved against it. */
  repoRoot: string;
  /** Absolute, or repo-relative, path to the module declaring the symbol. */
  catalogPath: string;
  /** Directories holding `<root>/<package>/src` trees (ADR-073 `source_roots`). */
  sourceRoots?: readonly string[];
  /** Overridable for tests; defaults to `RUNTIME_CATALOG`. */
  symbolName?: string;
}

/**
 * Alias hops are bounded so a self- or mutually-referential alias terminates
 * instead of hanging the gate. Sixteen is far past any real chain (the live
 * one is one hop: a same-file identifier into a cross-package import).
 */
const MAX_ALIAS_HOPS = 16;

// ---------------------------------------------------------------------------
// AST helpers.
// ---------------------------------------------------------------------------

function parseTs(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TS);
}

/**
 * Strip the type-only wrappers TypeScript puts around a value. The manifest
 * closes `] as const satisfies readonly RuntimeCatalogKind[]` — the array sits
 * under BOTH an `AsExpression` and a `SatisfiesExpression` — and one of the
 * three former parsers peeled only `as`, holding a `SatisfiesExpression` and
 * reporting zero entries.
 */
function unwrapExpression(expr: ts.Expression): ts.Expression {
  if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isTypeAssertionExpression(expr)) {
    return unwrapExpression(expr.expression);
  }
  if (ts.isParenthesizedExpression(expr)) return unwrapExpression(expr.expression);
  return expr;
}

function findVariableInitializer(sourceFile: ts.SourceFile, name: string): ts.Expression | undefined {
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) return decl.initializer;
    }
  }
  return undefined;
}

/**
 * If `name` is bound by a top-level named import, return the module specifier
 * and the name it was imported under. This is the second way a catalog is an
 * alias rather than a literal: `runtime-catalog.ts` re-exports a symbol
 * `RUNTIME_CATALOG_MANIFEST` it imported from `@arbor/core`.
 */
function findImportBinding(
  sourceFile: ts.SourceFile,
  name: string,
): { module: string; imported: string } | undefined {
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const clause = stmt.importClause;
    if (!clause || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
    for (const element of clause.namedBindings.elements) {
      if (element.name.text !== name) continue;
      return { module: stmt.moduleSpecifier.text, imported: element.propertyName?.text ?? element.name.text };
    }
  }
  return undefined;
}

function stringProp(obj: ts.ObjectLiteralExpression, name: string): string | undefined {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === name && ts.isStringLiteral(prop.initializer)) {
      return prop.initializer.text;
    }
  }
  return undefined;
}

function boolProp(obj: ts.ObjectLiteralExpression, name: string): boolean | undefined {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === name) {
      if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) return true;
      if (prop.initializer.kind === ts.SyntaxKind.FalseKeyword) return false;
    }
  }
  return undefined;
}

/**
 * Pull every entry out of an already-resolved array literal. An element counts
 * when it is an object literal declaring a string `kind`; `direction` is
 * carried through when present and left undefined when not, because two of the
 * three former parsers required a `direction` and one did not.
 */
function extractEntries(sourceFile: ts.SourceFile, arrayLiteral: ts.ArrayLiteralExpression): RuntimeCatalogEntry[] {
  const entries: RuntimeCatalogEntry[] = [];
  for (const element of arrayLiteral.elements) {
    if (!ts.isObjectLiteralExpression(element)) continue;
    const kind = stringProp(element, "kind");
    if (kind === undefined) continue;
    entries.push({
      kind,
      direction: stringProp(element, "direction"),
      supported: boolProp(element, "supported") === true,
      line: sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile)).line + 1,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Module resolution.
// ---------------------------------------------------------------------------

/** Resolve a relative module specifier to a file on disk, trying the usual extensions. */
function resolveModuleFile(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolvePath(dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, `${base}.mts`, `${base}/index.ts`]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolve a bare workspace specifier (`@arbor/core`) to the file in that
 * package's `src` that declares the named export. The manifest moved to
 * `@arbor/core` and `arbor-mcp/src/runtime-catalog.ts` only re-exports it, so
 * without this hop the reader stops at a file that holds no array literal.
 *
 * The package directory is not always the bare specifier tail (`@arbor/core` is
 * `packages/arbor-core`, `@arbor/mcp` is `packages/arbor-mcp`), so both are
 * tried — a new package cannot silently fall out of the reader's view.
 */
function resolveWorkspacePackageFile(
  repoRoot: string,
  sourceRoots: readonly string[],
  specifier: string,
  exportedName: string,
): string | undefined {
  if (!specifier.startsWith("@arbor/")) return undefined;
  const name = specifier.slice("@arbor/".length);
  for (const root of sourceRoots) {
    for (const dir of [join(repoRoot, root, name, "src"), join(repoRoot, root, `arbor-${name}`, "src")]) {
      if (!existsSync(dir)) continue;
      let candidates: string[];
      try {
        candidates = readdirSync(dir).filter((file) => file.endsWith(".ts")).sort();
      } catch {
        continue;
      }
      for (const file of candidates) {
        const full = join(dir, file);
        let text: string;
        try {
          text = readFileSync(full, "utf8");
        } catch {
          continue;
        }
        if (!new RegExp(`export\\s+const\\s+${exportedName}\\b`).test(text)) continue;
        const initializer = findVariableInitializer(parseTs(full, text), exportedName);
        if (initializer === undefined) continue;
        if (ts.isArrayLiteralExpression(unwrapExpression(initializer))) return full;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The reader.
// ---------------------------------------------------------------------------

type Document = { path: string; source: string };

function resolveCatalog(
  first: Document | undefined,
  load: (path: string) => string | undefined,
  repoRoot: string | undefined,
  sourceRoots: readonly string[],
  symbolName: string,
): CatalogRead {
  if (first === undefined) {
    return { measured: false, code: "unreadable", reason: "runtime catalog file could not be read" };
  }
  let current: Document | undefined = first;
  let name = symbolName;
  for (let hop = 0; hop < MAX_ALIAS_HOPS; hop++) {
    const sourceFile = parseTs(current.path, current.source);
    const initializer = findVariableInitializer(sourceFile, name);
    if (initializer !== undefined) {
      const unwrapped = unwrapExpression(initializer);
      // An empty array literal bound to the name is a real, empty catalog: it is
      // a measurement of zero, not a missing measurement.
      if (ts.isArrayLiteralExpression(unwrapped)) {
        return { measured: true, entries: extractEntries(sourceFile, unwrapped), entryPath: current.path };
      }
      if (ts.isIdentifier(unwrapped)) {
        name = unwrapped.text;
        continue;
      }
      return { measured: false, code: "unresolved", reason: `'${symbolName}' is not initialized with an array literal` };
    }
    const binding = findImportBinding(sourceFile, name);
    if (binding === undefined) {
      return { measured: false, code: "unresolved", reason: `no top-level '${symbolName}' declaration or import found in ${current.path}` };
    }
    const target: string | undefined = resolveModuleFile(current.path, binding.module)
      ?? (repoRoot === undefined ? undefined : resolveWorkspacePackageFile(repoRoot, sourceRoots, binding.module, binding.imported));
    if (target === undefined) {
      return { measured: false, code: "unresolved", reason: `cannot resolve '${binding.module}' imported by ${current.path}` };
    }
    const next = load(target);
    if (next === undefined) {
      return { measured: false, code: "unresolved", reason: `alias hop target could not be read: ${target}` };
    }
    current = { path: target, source: next };
    name = binding.imported;
  }
  return { measured: false, code: "unresolved", reason: `'${symbolName}' did not resolve to an array literal within ${MAX_ALIAS_HOPS} alias hops` };
}

/**
 * Read the runtime catalog, following the `RUNTIME_CATALOG` alias — a
 * same-file identifier hop, then a relative or `@arbor/*` import hop — and
 * report `measured: false` rather than an entry list when it cannot.
 */
export function readRuntimeCatalog(options: ReadRuntimeCatalogOptions): CatalogRead {
  const { repoRoot, sourceRoots = ["packages"], symbolName = CATALOG_SYMBOL } = options;
  const path = isAbsolute(options.catalogPath) ? options.catalogPath : join(repoRoot, options.catalogPath);
  const load = (target: string): string | undefined => {
    try {
      return readFileSync(target, "utf8");
    } catch {
      return undefined;
    }
  };
  const first = load(path);
  return resolveCatalog(first === undefined ? undefined : { path, source: first }, load, repoRoot, sourceRoots, symbolName);
}

/**
 * Read the catalog out of ONE in-memory document, with no cross-file hops.
 * This is the shape the two pure gate checks were unit-tested against
 * (synthetic source text, no repository on disk); it shares every line of the
 * alias-following logic with `readRuntimeCatalog` through `resolveCatalog`.
 */
export function readCatalogFromSource(source: string, fileName: string, symbolName: string = CATALOG_SYMBOL): CatalogRead {
  const path = join("/", "virtual", fileName);
  return resolveCatalog({ path, source }, () => undefined, undefined, [], symbolName);
}

// ---------------------------------------------------------------------------
// Count shape.
// ---------------------------------------------------------------------------

/**
 * The distinct `kind` values, sorted. `derive.ts` counted a SET of kinds
 * rather than entries, which is a different number the moment a kind repeats;
 * the difference is preserved here as a named view instead of being flattened
 * into the entry count.
 */
export function catalogKinds(read: CatalogMeasured): string[] {
  return [...new Set(read.entries.map((entry) => entry.kind))].sort();
}

/**
 * `true` for the two directions the runtime router can actually dispatch.
 * `scripts/tui-catalog-parity.mjs` counted only these; an entry with any other
 * `direction` is read but not dispatched, and the parity gate's dispositions
 * describe dispatchable surface, so the filter is preserved rather than
 * dropped into the shared entry list.
 */
export function isDispatchableDirection(direction: string | undefined): boolean {
  return direction === "command" || direction === "query";
}
