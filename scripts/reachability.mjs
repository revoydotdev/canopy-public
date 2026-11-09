#!/usr/bin/env node
/**
 * scripts/reachability.mjs — Phase 6.2 reachability gate.
 *
 * Usage:
 *   bun scripts/reachability.mjs          # human-readable report, exits non-zero on violation
 *   bun scripts/reachability.mjs --json   # machine-readable report on stdout
 *   bun run gate:reachability             # wired via package.json
 *
 * What it does
 * ------------
 * Walks the static import/reference graph of every `packages/*\/src/**\/*.ts`
 * file, rooted at the entry points declared in
 * scripts/reachability/entry-points.json (Phase 6.1's manifest), and reports
 * every *exported, value-producing* symbol that is not reachable from a root
 * without passing through a test file (test files are never part of the
 * graph in the first place, so this falls out for free).
 *
 * How reachability is computed
 * -----------------------------
 * Two kinds of graph nodes:
 *   - a "declaration" node: one top-level function/class/enum/const/let
 *     declaration in a source file (its id is `path::name`).
 *   - a "module root" node per file (id `path::<module>`), standing for
 *     "this file has been loaded/imported". Its outgoing edges are:
 *       (a) every other file it imports for runtime effect (import type is
 *           excluded — it erases and never executes), and
 *       (b) whatever top-level, non-declaration statements reference (e.g.
 *           `if (isDirectExecution()) { void main(...) }` at the bottom of
 *           a CLI file).
 *
 * An edge `A -> B` means "A being reachable makes B reachable": it is built
 * by walking every identifier inside A's body/initializer/statements and
 * resolving it with the TypeScript checker (following import aliases and
 * re-export chains to their origin) to some other declaration or module
 * root in the graph.
 *
 * Entry points seed the initial reachable set per scripts/reachability/entry-points.json:
 *   - kind "process-entry": the whole file's module-root is a root (the file
 *     runs top to bottom as the program's own entry).
 *   - kind "library-export": the module-root is a root (import side effects
 *     still fire), AND the specific named export is *also* a root directly
 *     (an external host calls it, so its body is exercised even though
 *     nothing in this repo calls it).
 *
 * BFS from the roots over the edges gives the reachable set. Any exported,
 * value-producing declaration not in that set is a violation, unless it is
 * allowlisted (scripts/reachability/allowlist.json) with a non-expired date.
 *
 * Deliberately excluded from the "exported symbol" checklist: interfaces,
 * type aliases, and anything whose declarations are 100% type-only — a type
 * cannot be "unreached" in the runtime sense this gate cares about.
 *
 * Conservative bias (stated explicitly; D4b, §24.2 P8) — FAIL-CLOSED, the
 * opposite direction from registration-integrity.mjs's later ADR-117
 * adoption. When this gate cannot fully resolve a declaration (the
 * `resolvable: false` case in the checklist below), it treats the symbol as
 * UNREACHABLE and reports a violation rather than staying silent — i.e. a
 * missed/ambiguous resolution is treated as a real defect, not waved
 * through. That is the right default for THIS gate specifically: its whole
 * purpose is catching dead code, and an unresolvable declaration is rare
 * enough, and important enough if it really is dead, that it belongs in
 * front of a human rather than silently dropped.
 *
 * Naming note, not a logic bug: the human-readable report below labels this
 * "reported conservatively" (line ~599). Read literally against
 * registration-integrity.mjs's later, explicit ADR-117 framing ("false-LIVE
 * is acceptable, false-DEAD is not... prefer silence over a false
 * accusation"), "conservative" there means the opposite of what it means
 * here: registration-integrity.mjs's "conservative" leans toward silence
 * (tolerating a missed violation to avoid a false accusation); this gate's
 * "conservative" leans toward flagging (tolerating a possible false
 * accusation to avoid missing a real one). Both postures are individually
 * coherent for what each gate does, but the shared English word papers over
 * a real, opposite bias — flagged here rather than quietly left for a
 * reader to assume consistency that isn't there.
 *
 * Constraints honored
 * --------------------
 * - TypeScript compiler API only (`typescript`, already a devDependency).
 *   No new dependency of any kind.
 * - No .codegraph/ or revoy.lsp MCP tools — this must run from a clean
 *   checkout with only `bun install`, headless, in CI.
 * - Exits 0 when clean, 1 when a violation is found (or the allowlist has an
 *   expired entry).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { loadWaiverFile, isWaiverExpired, validateWaiverEntry } from "./lib/waiver-store.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolvePath(__dirname, "..");
const repoFlagIndex = process.argv.indexOf("--repo");
const REPO_ROOT = repoFlagIndex >= 0 && process.argv[repoFlagIndex + 1]
  ? resolvePath(process.argv[repoFlagIndex + 1])
  : DEFAULT_REPO_ROOT;
const JSON_OUTPUT = process.argv.includes("--json");
// `--allowlist <path>` exists so this gate can be tested against a throwaway
// allowlist file with a genuinely expired/malformed entry, the same reason
// branch-accounting.mjs's `--dispositions` override exists — without an
// injectable path the only way to prove this gate FAILS on an expired entry
// would be to expire a real entry in the real repo.
function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}

// ---------------------------------------------------------------------------
// 1. Collect source files: every packages/*/src/**/*.ts, excluding tests.
// ---------------------------------------------------------------------------

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
}

const packagesDir = join(REPO_ROOT, "packages");
const srcFiles = [];
for (const pkg of readdirSync(packagesDir)) {
  const srcDir = join(packagesDir, pkg, "src");
  try {
    if (statSync(srcDir).isDirectory()) walk(srcDir, srcFiles);
  } catch {
    // package has no src/ — nothing to scan
  }
}

// ---------------------------------------------------------------------------
// 2. Build a TS Program over exactly those files (no tests, no dist).
// ---------------------------------------------------------------------------

const rootTsconfigPath = join(REPO_ROOT, "tsconfig.json");
const rootTsconfigJson = ts.readConfigFile(rootTsconfigPath, ts.sys.readFile).config;
const parsed = ts.parseJsonConfigFileContent(
  { ...rootTsconfigJson, files: [], include: undefined, exclude: undefined },
  ts.sys,
  REPO_ROOT,
);
const compilerOptions = {
  ...parsed.options,
  noEmit: true,
  declaration: false,
  declarationMap: false,
  sourceMap: false,
  composite: false,
  incremental: false,
};

const program = ts.createProgram(srcFiles, compilerOptions);
const checker = program.getTypeChecker();

function relPath(fileName) {
  return relative(REPO_ROOT, fileName).replace(/\\/g, "/");
}

const trackedFileSet = new Set(srcFiles.map((f) => resolvePath(f)));
function isTracked(sourceFile) {
  return trackedFileSet.has(resolvePath(sourceFile.fileName));
}

// ---------------------------------------------------------------------------
// 3. Pass 1 — collect declaration nodes and module-root nodes per file.
// ---------------------------------------------------------------------------

/** @typedef {{ id: string, file: string, name: string, exported: boolean, scanRoots: ts.Node[] }} DeclNode */

/** id -> DeclNode | { id, file, kind: 'moduleRoot', scanRoots } */
const nodes = new Map();
/** AST declaration node -> graph id, for mapping checker declarations back to nodes */
const astNodeToId = new Map();
/** file (relPath) -> module root id */
const moduleRootId = (file) => `${file}::<module>`;
/** edges: id -> Set<id> */
const edges = new Map();

function addEdge(from, to) {
  if (!edges.has(from)) edges.set(from, new Set());
  edges.get(from).add(to);
}

function declId(file, name) {
  return `${file}::${name}`;
}

const TYPE_ONLY_KINDS = new Set([
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
]);

for (const sourceFile of program.getSourceFiles()) {
  if (!isTracked(sourceFile)) continue;
  const file = relPath(sourceFile.fileName);
  const rootId = moduleRootId(file);
  const moduleRootScanRoots = [];
  nodes.set(rootId, { id: rootId, file, kind: "moduleRoot", scanRoots: moduleRootScanRoots });

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      const id = declId(file, stmt.name.text);
      nodes.set(id, { id, file, name: stmt.name.text, kind: "decl", scanRoots: [stmt] });
      astNodeToId.set(stmt, id);
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      const id = declId(file, stmt.name.text);
      nodes.set(id, { id, file, name: stmt.name.text, kind: "decl", scanRoots: [stmt] });
      astNodeToId.set(stmt, id);
    } else if (ts.isEnumDeclaration(stmt)) {
      const id = declId(file, stmt.name.text);
      nodes.set(id, { id, file, name: stmt.name.text, kind: "decl", scanRoots: [stmt] });
      astNodeToId.set(stmt, id);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const id = declId(file, decl.name.text);
          const scanRoot = decl.initializer ?? decl;
          nodes.set(id, { id, file, name: decl.name.text, kind: "decl", scanRoots: [scanRoot] });
          astNodeToId.set(decl, id);
        }
        // destructured top-level const/let (rare, none expected here) falls
        // through and is picked up by the module-root scan below instead.
      }
    } else if (TYPE_ONLY_KINDS.has(stmt.kind)) {
      // no runtime declaration — not part of the call graph
    } else if (ts.isExportAssignment(stmt)) {
      // `export default <expr>;`
      const id = declId(file, "default");
      nodes.set(id, { id, file, name: "default", kind: "decl", scanRoots: [stmt.expression] });
      astNodeToId.set(stmt, id);
    } else if (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) {
      // handled in the module-linkage pass below (still evaluated as part of
      // loading this module, but they hold no identifiers worth resolving
      // for the reference graph — the checker-based export walk in pass 3
      // follows re-export aliases directly).
    } else {
      // any other top-level statement (if/try/expression/etc.) — its
      // references belong to the module root.
      moduleRootScanRoots.push(stmt);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Module-linkage edges: importing/re-exporting a module evaluates it.
// ---------------------------------------------------------------------------

function resolveModuleSpecifier(sourceFile, moduleSpecifierText) {
  const resolved = ts.resolveModuleName(
    moduleSpecifierText,
    sourceFile.fileName,
    compilerOptions,
    ts.sys,
  );
  const resolvedFile = resolved.resolvedModule?.resolvedFileName;
  if (!resolvedFile) return undefined;
  const abs = resolvePath(resolvedFile);
  if (!trackedFileSet.has(abs)) return undefined;
  return relPath(abs);
}

/**
 * Every scan root already collected for `file` in Pass 1 (module-root
 * side-effect statements plus every declaration's body/initializer), PLUS
 * the local-name half of a bare re-export (`export { Foo };` — no `from`),
 * which Pass 1 deliberately excludes from scanRoots but which is a genuine
 * reference to a local binding. This is the same "does anything in this
 * file actually use that name" surface bun/tsc use to decide whether an
 * import survives to runtime; see importClauseUsesAnyValue below.
 */
function fileUsageScanRoots(sourceFile, file) {
  const roots = [];
  for (const node of nodes.values()) {
    if (node.file === file) roots.push(...node.scanRoots);
  }
  for (const stmt of sourceFile.statements) {
    if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) roots.push(el.propertyName ?? el.name);
    }
  }
  return roots;
}

/**
 * An import with no `import type` keyword is still elided at runtime by
 * bun/tsc/esbuild-family transpilers when every binding it introduces is
 * only ever referenced in a type position (or never referenced at all) —
 * transpilers make this call per-file, without cross-file type info,
 * exactly like the check below. Verified against real `bun build` output:
 * `import { Shape } from "./x"` used only as `(x: Shape)` compiles away
 * entirely, so treating it as "always evaluates the target module" (the
 * prior behavior here) manufactures a module-load edge that never fires at
 * runtime — which can cascade into falsely marking that module's own
 * top-level side effects, and whatever they reference, reachable.
 */
function importClauseUsesAnyValue(sourceFile, file, clause) {
  const localSymbols = [];
  if (clause.name) {
    const s = checker.getSymbolAtLocation(clause.name);
    if (s) localSymbols.push(s);
  }
  if (clause.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings)) {
      const s = checker.getSymbolAtLocation(clause.namedBindings.name);
      if (s) localSymbols.push(s);
    } else if (ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        if (el.isTypeOnly) continue;
        const s = checker.getSymbolAtLocation(el.name);
        if (s) localSymbols.push(s);
      }
    }
  }
  if (localSymbols.length === 0) return false;
  let usedAsValue = false;
  function visit(node) {
    if (usedAsValue) return;
    if (ts.isIdentifier(node) && !isDeclarationNamePosition(node) && !isTypeOnlyReference(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol && localSymbols.includes(symbol)) {
        usedAsValue = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  for (const root of fileUsageScanRoots(sourceFile, file)) visit(root);
  return usedAsValue;
}

for (const sourceFile of program.getSourceFiles()) {
  if (!isTracked(sourceFile)) continue;
  const file = relPath(sourceFile.fileName);
  const fromId = moduleRootId(file);
  for (const stmt of sourceFile.statements) {
    let specifier;
    let typeOnly = false;
    if (ts.isImportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      specifier = stmt.moduleSpecifier.text;
      typeOnly = !!stmt.importClause?.isTypeOnly;
      if (!typeOnly && stmt.importClause) {
        typeOnly = !importClauseUsesAnyValue(sourceFile, file, stmt.importClause);
      }
    } else if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      specifier = stmt.moduleSpecifier.text;
      typeOnly = !!stmt.isTypeOnly;
    }
    if (!specifier || typeOnly) continue;
    const target = resolveModuleSpecifier(sourceFile, specifier);
    if (target) addEdge(fromId, moduleRootId(target));
  }
}

// ---------------------------------------------------------------------------
// 5. Reference edges: walk every scan root's identifiers, resolve via the
//    checker, and connect to whatever declaration/module-root they name.
// ---------------------------------------------------------------------------

/**
 * Walk up from any declaration node to the granular unit Pass 1 registered
 * in astNodeToId: a top-level FunctionDeclaration/ClassDeclaration/
 * EnumDeclaration/ExportAssignment, or a VariableDeclaration (which is
 * *not* directly parented by SourceFile — it sits inside a
 * VariableDeclarationList inside a VariableStatement, and a single
 * VariableStatement can declare several distinct bindings, e.g.
 * `export const a = 1, b = 2;`. Stopping at the VariableDeclaration itself
 * keeps `a` and `b` distinguishable instead of collapsing them onto their
 * shared VariableStatement.
 */
function findDeclarationUnit(node) {
  let n = node;
  while (n && !ts.isSourceFile(n)) {
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isClassDeclaration(n) ||
      ts.isEnumDeclaration(n) ||
      ts.isVariableDeclaration(n) ||
      ts.isExportAssignment(n)
    ) {
      return n;
    }
    n = n.parent;
  }
  return undefined;
}

function resolveIdentifierToNodeId(identifier) {
  let symbol = checker.getSymbolAtLocation(identifier);
  if (!symbol) return undefined;
  while (symbol.flags & ts.SymbolFlags.Alias) {
    const aliased = checker.getAliasedSymbol(symbol);
    if (aliased === symbol) break;
    symbol = aliased;
  }
  const decls = symbol.getDeclarations();
  if (!decls || decls.length === 0) return undefined;
  for (const d of decls) {
    const unit = findDeclarationUnit(d);
    const id = unit && astNodeToId.get(unit);
    if (id) return id;
  }
  return undefined;
}

function isDeclarationNamePosition(identifier) {
  const p = identifier.parent;
  if (!p) return false;
  if ((ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isEnumDeclaration(p)) && p.name === identifier) return true;
  if (ts.isVariableDeclaration(p) && p.name === identifier) return true;
  if (ts.isPropertyAssignment(p) && p.name === identifier) return true; // object literal key
  if ((ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isMethodSignature(p)) && p.name === identifier) return true;
  if (ts.isParameter(p) && p.name === identifier) return true;
  return false;
}

/**
 * `const { tuimain } = await import("./tui.js");` — a dynamic import. The
 * checker resolves the destructured binding's own symbol (the new local
 * variable), not the origin export, so the normal identifier-resolution
 * path in resolveIdentifierToNodeId never finds tui.ts's `tuimain`. Detect
 * the pattern directly and wire the destructured names to the target
 * module's exports of the same name.
 */
function dynamicImportSpecifier(expr) {
  let e = expr;
  if (ts.isAwaitExpression(e)) e = e.expression;
  if (
    ts.isCallExpression(e) &&
    e.expression.kind === ts.SyntaxKind.ImportKeyword &&
    e.arguments.length > 0 &&
    ts.isStringLiteral(e.arguments[0])
  ) {
    return e.arguments[0].text;
  }
  return undefined;
}

// A dynamic `import("./x.js")` evaluates the target's top-level code exactly
// like a static import would — link the module roots unconditionally.
function scanDynamicImportCall(fromId, sourceFile, node) {
  if (!ts.isCallExpression(node)) return;
  if (node.expression.kind !== ts.SyntaxKind.ImportKeyword) return;
  if (node.arguments.length === 0 || !ts.isStringLiteral(node.arguments[0])) return;
  const target = resolveModuleSpecifier(sourceFile, node.arguments[0].text);
  if (target) addEdge(fromId, moduleRootId(target));
}

// `const { tuimain } = await import("./tui.js")` — additionally wire the
// destructured names to the specific exports they read, since the checker
// resolves the binding to the new local variable rather than tui.ts's
// `tuimain` (see resolveIdentifierToNodeId's normal path, which this
// pattern defeats).
function scanDynamicImportDestructure(fromId, sourceFile, node) {
  if (!ts.isVariableDeclaration(node) || !node.initializer) return;
  const specifierText = dynamicImportSpecifier(node.initializer);
  if (!specifierText || !ts.isObjectBindingPattern(node.name)) return;
  const target = resolveModuleSpecifier(sourceFile, specifierText);
  if (!target) return;
  for (const element of node.name.elements) {
    if (element.dotDotDotToken) continue; // rest element — not a named export reference
    const propertyName = element.propertyName && ts.isIdentifier(element.propertyName)
      ? element.propertyName.text
      : ts.isIdentifier(element.name)
        ? element.name.text
        : undefined;
    if (propertyName) addEdge(fromId, declId(target, propertyName));
  }
}

/**
 * A class/function/const referenced only in a *type* position — `: Foo`,
 * `Array<Foo>`, a return-type annotation — never runs Foo's own body. TS
 * merges a class's value and type meaning into one symbol, so the checker
 * happily resolves `RecoveryService` from `recovery_service?: RecoveryService`
 * to the same symbol a `new RecoveryService()` call would — without this
 * check, a type annotation alone would (wrongly) count as "constructed".
 * That is exactly how G-03 was findable at all: RecoveryService is named in
 * a field type but never instantiated outside tests.
 */
function isTypeOnlyReference(identifier) {
  let node = identifier;
  while (node.parent && ts.isQualifiedName(node.parent) && (node.parent.left === node || node.parent.right === node)) {
    node = node.parent;
  }
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isTypeReferenceNode(parent) && parent.typeName === node) return true;
  if (ts.isTypeQueryNode(parent)) return true; // `typeof X` read in a type position
  if (ts.isImportTypeNode(parent)) return true;
  if (
    ts.isExpressionWithTypeArguments(parent) &&
    parent.expression === node &&
    ts.isHeritageClause(parent.parent)
  ) {
    // `class C implements Base {}` or `interface I extends Base {}` never
    // reads Base as a value — implements/extends-on-an-interface erase
    // completely at emit. Only `class C extends Base {}` actually evaluates
    // Base (as the expression whose value becomes the constructor's
    // prototype chain) when the class declaration itself runs, so that is
    // the sole heritage shape left as a real reference. Without this check,
    // a class named only in an `implements` clause looked "constructed" —
    // the same class-of-bug isTypeOnlyReference's docstring describes for
    // bare type annotations (RecoveryService), just via a different node
    // shape the checker also merges value+type meaning for.
    const heritageClause = parent.parent;
    const isRealClassExtends =
      heritageClause.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(heritageClause.parent);
    if (!isRealClassExtends) return true;
  }
  return false;
}

function scan(fromId, root) {
  const sourceFile = root.getSourceFile();
  function visit(node) {
    if (ts.isIdentifier(node) && !isDeclarationNamePosition(node) && !isTypeOnlyReference(node)) {
      const targetId = resolveIdentifierToNodeId(node);
      if (targetId && targetId !== fromId) addEdge(fromId, targetId);
    }
    scanDynamicImportCall(fromId, sourceFile, node);
    if (ts.isVariableDeclaration(node)) scanDynamicImportDestructure(fromId, sourceFile, node);
    ts.forEachChild(node, visit);
  }
  visit(root);
}

for (const node of nodes.values()) {
  for (const root of node.scanRoots) scan(node.id, root);
}

// ---------------------------------------------------------------------------
// 6. Entry points (6.1 manifest) -> initial reachable roots.
// ---------------------------------------------------------------------------

// `--entry-points <path>` is deliberately injectable for the reachability
// contract tests.  In particular, ADR-083's communication proof must fail if
// a named public root is removed rather than quietly reducing the root set.
const manifestPath = argValue("--entry-points") ?? join(__dirname, "reachability", "entry-points.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

const roots = [];
const rootWarnings = [];
const rootsByEntryPoint = new Map();
for (const entry of manifest.entryPoints) {
  const entryRoots = [];
  const absFile = resolvePath(REPO_ROOT, entry.file);
  if (!trackedFileSet.has(absFile)) {
    rootWarnings.push(`entry point "${entry.id}" file not found under packages/*/src: ${entry.file}`);
    rootsByEntryPoint.set(entry.id, entryRoots);
    continue;
  }
  const file = relPath(absFile);
  const moduleRoot = moduleRootId(file);
  roots.push(moduleRoot);
  entryRoots.push(moduleRoot);
  if (entry.kind === "library-export") {
    if (!entry.symbol) {
      rootWarnings.push(`entry point "${entry.id}" is kind library-export but declares no symbol`);
      continue;
    }
    const id = declId(file, entry.symbol);
    if (!nodes.has(id)) {
      rootWarnings.push(`entry point "${entry.id}" names symbol "${entry.symbol}" not found as a top-level declaration in ${entry.file}`);
      rootsByEntryPoint.set(entry.id, entryRoots);
      continue;
    }
    roots.push(id);
    entryRoots.push(id);
  } else if (entry.kind !== "process-entry") {
    rootWarnings.push(`entry point "${entry.id}" has unknown kind "${entry.kind}"`);
  }
  rootsByEntryPoint.set(entry.id, entryRoots);
}

// ---------------------------------------------------------------------------
// 7. BFS reachability.
// ---------------------------------------------------------------------------

const reachable = new Set();
const queue = [...roots];
for (const r of roots) reachable.add(r);
while (queue.length) {
  const current = queue.shift();
  for (const next of edges.get(current) ?? []) {
    if (!reachable.has(next)) {
      reachable.add(next);
      queue.push(next);
    }
  }
}

function closureFrom(seedIds) {
  const reached = new Set(seedIds);
  const pending = [...seedIds];
  while (pending.length) {
    const current = pending.shift();
    for (const next of edges.get(current) ?? []) {
      if (!reached.has(next)) {
        reached.add(next);
        pending.push(next);
      }
    }
  }
  return reached;
}

// Keep a result for EVERY public root, rather than only the union used by the
// historical dead-export check.  This is the executable form of "reachable
// from which entry point?"; it is also the data ADR-083's focused proof uses.
const perEntryPointReachability = [...rootsByEntryPoint.entries()]
  .map(([id, entryRoots]) => ({ id, root_ids: [...entryRoots].sort(), reached: closureFrom(entryRoots) }))
  .sort((a, b) => a.id.localeCompare(b.id));

// ---------------------------------------------------------------------------
// 7b. ADR-083 — one bidirectional mechanism, scoped to one tree edge.
// ---------------------------------------------------------------------------

// The manifest names locations, but it is not allowed to redefine ADR-083's
// obligations.  Keeping this contract in the blocking checker makes a
// subtraction (for example, dropping send from `scoped_ports`) a failure,
// rather than a smaller proof that happens to pass.
const ADR_083_CANONICAL = Object.freeze({
  mechanism: Object.freeze({ id: "parent-child-ledger", native_tool_factory_file: "packages/arbor-mcp/src/native-tool-host.ts" }),
  required_entry_points: Object.freeze(["arbor-mcp-cli"]),
  scoped_ports: Object.freeze(["bus.thread.ack", "bus.thread.send", "sibling.status"]),
  scope_checked_ports: Object.freeze(["bus.thread.ack", "bus.thread.send"]),
  landmarks: Object.freeze([
    "packages/arbor-mcp/src/cli.ts::nativeBusThreadForSession",
    "packages/arbor-mcp/src/native-agent-executor.ts::NativeAgentExecutor",
    "packages/arbor-mcp/src/native-tool-host.ts::createNativeBusThreadToolPorts",
    "packages/arbor-mcp/src/native-tool-host.ts::busThreadScopeMismatch",
    "packages/arbor-mcp/src/runtime-catalog.ts::RuntimeCatalogRouter",
    "packages/arbor-mcp/src/manager.ts::CampaignManager",
    "packages/arbor-mcp/src/conversation-bus.ts::parentChildThreadId",
    "packages/arbor-mcp/src/conversation-bus.ts::projectParentChildThread",
  ]),
  scope_resolver: Object.freeze({ file: "packages/arbor-mcp/src/cli.ts", symbol: "nativeBusThreadForSession" }),
  factory: Object.freeze({
    symbol: "createNativeBusThreadToolPorts",
    scope_check_symbol: "busThreadScopeMismatch",
    scope_fields: Object.freeze(["campaign_id", "parent_node_id", "child_node_id"]),
    port_handlers: Object.freeze({ "bus.thread.send": "busThreadSend", "bus.thread.ack": "busThreadAck", "sibling.status": "siblingStatus" }),
  }),
});

function sameStringSet(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

/** Return the static declarations of native tool names, in deterministic order. */
function nativeToolEmissions() {
  const emissions = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (!isTracked(sourceFile)) continue;
    function visit(node) {
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "tool" && ts.isStringLiteral(node.initializer)) {
        emissions.push({ file: relPath(sourceFile.fileName), tool: node.initializer.text });
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  return emissions.sort((a, b) => a.tool.localeCompare(b.tool) || a.file.localeCompare(b.file));
}

function sourceFileFor(file) {
  const sourceFile = program.getSourceFile(resolvePath(REPO_ROOT, file));
  return sourceFile ?? null;
}

function objectProperty(object, name) {
  return object.properties.find((property) => ts.isPropertyAssignment(property)
    && ((ts.isIdentifier(property.name) && property.name.text === name)
      || (ts.isStringLiteral(property.name) && property.name.text === name)));
}

function topLevelFunction(sourceFile, name) {
  return sourceFile.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name) ?? null;
}

function callsNamed(root, name) {
  let found = false;
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) found = true;
    if (!found) ts.forEachChild(node, visit);
  }
  visit(root);
  return found;
}

function propertyAccesses(root, objectName, propertyName) {
  let found = false;
  function visit(node) {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === objectName && node.name.text === propertyName) found = true;
    if (!found) ts.forEachChild(node, visit);
  }
  visit(root);
  return found;
}

function hasScopeResolverShape(sourceFile, resolver) {
  const fn = topLevelFunction(sourceFile, resolver.symbol);
  if (fn === null) return `ADR-083 scope resolver function is absent: ${resolver.symbol}`;
  let readsParentId = false;
  let returnsTrustedEdge = false;
  function visit(node) {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "parent_id") readsParentId = true;
    if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
      const scope = objectProperty(node.expression, "scope");
      if (scope && ts.isObjectLiteralExpression(scope.initializer)) {
        const parent = objectProperty(scope.initializer, "parent_node_id");
        const child = objectProperty(scope.initializer, "child_node_id");
        if (parent && ts.isIdentifier(parent.initializer) && child
          && propertyAccesses(child.initializer, "scope", "node_id")) returnsTrustedEdge = true;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(fn);
  if (!readsParentId) return "ADR-083 scope resolver does not derive an edge from parent_id";
  if (!returnsTrustedEdge) return "ADR-083 scope resolver does not return parent_node_id + child_node_id from trusted scope";
  return null;
}

function hasScopeCheckShape(sourceFile, factory) {
  const fn = topLevelFunction(sourceFile, factory.scope_check_symbol);
  if (fn === null) return `ADR-083 scope check function is absent: ${factory.scope_check_symbol}`;
  const foundFields = new Set();
  function conditionChecksField(condition, field) {
    let found = false;
    function visit(node) {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
        for (const side of [node.left, node.right]) {
          if (ts.isPropertyAccessExpression(side) && ts.isIdentifier(side.expression)
            && side.expression.text === "scope" && side.name.text === field) found = true;
        }
      }
      if (!found) ts.forEachChild(node, visit);
    }
    visit(condition);
    return found;
  }
  function containsRefusalReturn(node) {
    let found = false;
    function visit(candidate) {
      if (ts.isReturnStatement(candidate) && candidate.expression && ts.isStringLiteral(candidate.expression) && candidate.expression.text.length > 0) found = true;
      if (!found) ts.forEachChild(candidate, visit);
    }
    visit(node);
    return found;
  }
  function visit(node) {
    if (ts.isIfStatement(node) && containsRefusalReturn(node.thenStatement)) {
      for (const field of factory.scope_fields) if (conditionChecksField(node.expression, field)) foundFields.add(field);
    }
    ts.forEachChild(node, visit);
  }
  visit(fn);
  const missing = factory.scope_fields.filter((field) => !foundFields.has(field));
  return missing.length ? `ADR-083 scope check does not fail closed for: ${missing.join(", ")}` : null;
}

function factoryPortBindings(factoryNode) {
  const bindings = [];
  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const tool = objectProperty(node, "tool");
      const execute = objectProperty(node, "execute");
      if (tool && ts.isStringLiteral(tool.initializer) && execute) {
        const handlers = [];
        function collect(candidate) {
          if (ts.isCallExpression(candidate) && ts.isIdentifier(candidate.expression)) handlers.push(candidate.expression.text);
          ts.forEachChild(candidate, collect);
        }
        collect(execute.initializer);
        bindings.push({ tool: tool.initializer.text, handlers: handlers.sort() });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(factoryNode);
  return bindings.sort((a, b) => a.tool.localeCompare(b.tool));
}

function validateCommunicationProofSchema(config) {
  const errors = [];
  if (config === null || typeof config !== "object" || Array.isArray(config)) return ["ADR-083 communicationProof must be an object"];
  if (config.version !== 1) errors.push("ADR-083 communicationProof.version must be 1");
  if (!Array.isArray(config.mechanisms) || config.mechanisms.some((item) => item === null || typeof item !== "object" || typeof item.id !== "string" || typeof item.native_tool_factory_file !== "string")) {
    errors.push("ADR-083 communicationProof.mechanisms must contain mechanism objects with id and native_tool_factory_file");
  }
  if (!Array.isArray(config.required_entry_points) || config.required_entry_points.length === 0 || config.required_entry_points.some((id) => typeof id !== "string")) {
    errors.push("ADR-083 communicationProof.required_entry_points must be a non-empty string array");
  }
  if (!Array.isArray(config.scoped_ports) || config.scoped_ports.length === 0 || config.scoped_ports.some((port) => typeof port !== "string")) {
    errors.push("ADR-083 communicationProof.scoped_ports must be a non-empty string array");
  } else if (new Set(config.scoped_ports).size !== config.scoped_ports.length) {
    errors.push("ADR-083 communicationProof.scoped_ports must not duplicate a port emission");
  }
  if (!Array.isArray(config.scope_checked_ports) || config.scope_checked_ports.length === 0 || config.scope_checked_ports.some((port) => typeof port !== "string")) {
    errors.push("ADR-083 communicationProof.scope_checked_ports must be a non-empty string array");
  } else if (Array.isArray(config.scoped_ports) && config.scope_checked_ports.some((port) => !config.scoped_ports.includes(port))) {
    errors.push("ADR-083 communicationProof.scope_checked_ports must be a subset of scoped_ports");
  }
  if (!Array.isArray(config.landmarks) || config.landmarks.length === 0 || config.landmarks.some((landmark) => landmark === null || typeof landmark !== "object" || typeof landmark.id !== "string")) {
    errors.push("ADR-083 communicationProof.landmarks must be a non-empty array of { id } objects");
  }
  const resolver = config.scope_resolver;
  if (resolver === null || typeof resolver !== "object" || Array.isArray(resolver) || typeof resolver.file !== "string" || typeof resolver.symbol !== "string") {
    errors.push("ADR-083 communicationProof.scope_resolver must name a file and symbol");
  }
  const factory = config.factory;
  if (factory === null || typeof factory !== "object" || Array.isArray(factory)
    || typeof factory.symbol !== "string" || typeof factory.scope_check_symbol !== "string"
    || !Array.isArray(factory.scope_fields) || factory.scope_fields.some((field) => typeof field !== "string")
    || factory.scope_fields.length === 0 || factory.port_handlers === null || typeof factory.port_handlers !== "object" || Array.isArray(factory.port_handlers)) {
    errors.push("ADR-083 communicationProof.factory must name a factory, scope check, scope fields, and port handlers");
  } else if (!sameStringSet(Object.keys(factory.port_handlers), config.scoped_ports ?? [])) {
    errors.push("ADR-083 communicationProof.factory.port_handlers keys must exactly cover scoped_ports");
  }
  return errors;
}

function validateCanonicalCommunicationContract(config) {
  const errors = [];
  if (config.version !== 1) errors.push("ADR-083 communicationProof does not match the canonical version");
  if (!sameStringSet(config.required_entry_points, ADR_083_CANONICAL.required_entry_points)) errors.push("ADR-083 communicationProof.required_entry_points does not match the canonical contract");
  if (!sameStringSet(config.scoped_ports, ADR_083_CANONICAL.scoped_ports)) errors.push("ADR-083 communicationProof.scoped_ports does not match the canonical contract");
  if (!sameStringSet(config.scope_checked_ports, ADR_083_CANONICAL.scope_checked_ports)) errors.push("ADR-083 communicationProof.scope_checked_ports does not match the canonical contract");
  if (!sameStringSet(config.landmarks.map((landmark) => landmark.id), ADR_083_CANONICAL.landmarks)) errors.push("ADR-083 communicationProof.landmarks does not match the canonical contract");
  const mechanism = config.mechanisms[0];
  if (config.mechanisms.length !== 1 || mechanism?.id !== ADR_083_CANONICAL.mechanism.id || mechanism?.native_tool_factory_file !== ADR_083_CANONICAL.mechanism.native_tool_factory_file) {
    errors.push("ADR-083 communicationProof.mechanisms does not match the canonical contract");
  }
  if (config.scope_resolver.file !== ADR_083_CANONICAL.scope_resolver.file || config.scope_resolver.symbol !== ADR_083_CANONICAL.scope_resolver.symbol) {
    errors.push("ADR-083 communicationProof.scope_resolver does not match the canonical contract");
  }
  const factory = config.factory;
  if (factory.symbol !== ADR_083_CANONICAL.factory.symbol || factory.scope_check_symbol !== ADR_083_CANONICAL.factory.scope_check_symbol
    || !sameStringSet(factory.scope_fields, ADR_083_CANONICAL.factory.scope_fields)
    || Object.keys(factory.port_handlers).some((port) => factory.port_handlers[port] !== ADR_083_CANONICAL.factory.port_handlers[port])) {
    errors.push("ADR-083 communicationProof.factory does not match the canonical contract");
  }
  return errors;
}

/**
 * A narrow, deliberately checkable ADR-083 proof.  It does not infer that
 * arbitrary future string-named transports are impossible.  It proves the
 * defined native child communication surface: one declared mechanism, one
 * parent-derived scope resolver, exactly one emitter for each exposed port,
 * and a per-public-entry-point path to the canonical landmarks.
 */
function analyzeCommunicationProof(config) {
  if (config === undefined) return null;
  const errors = validateCommunicationProofSchema(config);
  if (errors.length) return Object.freeze({ ok: false, mechanism: null, required_entry_points: [], landmarks: [], scoped_port_emissions: [], entry_points: [], errors: errors.sort() });
  errors.push(...validateCanonicalCommunicationContract(config));
  const mechanisms = Array.isArray(config.mechanisms) ? config.mechanisms : [];
  if (mechanisms.length !== 1) errors.push(`ADR-083 requires exactly one declared mechanism; found ${mechanisms.length}`);
  const mechanism = mechanisms[0];
  if (!mechanism || mechanism.id !== "parent-child-ledger") errors.push("ADR-083's sole mechanism must be parent-child-ledger");

  const landmarks = Array.isArray(config.landmarks) ? config.landmarks : [];
  const landmarkIds = landmarks.map((landmark) => landmark.id).filter((id) => typeof id === "string").sort();
  if (landmarkIds.length === 0) errors.push("ADR-083 communication proof declares no canonical landmarks");
  for (const id of landmarkIds) if (!nodes.has(id)) errors.push(`ADR-083 canonical landmark is absent: ${id}`);

  const requiredRootIds = Array.isArray(config.required_entry_points) ? [...config.required_entry_points].sort() : [];
  if (requiredRootIds.length === 0) errors.push("ADR-083 communication proof declares no required entry point");
  const perEntryPoint = perEntryPointReachability.map((entry) => {
    const required = requiredRootIds.includes(entry.id);
    const reaches = landmarkIds.filter((id) => entry.reached.has(id));
    const missing = required ? landmarkIds.filter((id) => !entry.reached.has(id)) : [];
    if (required && missing.length) errors.push(`ADR-083 entry point ${entry.id} cannot reach: ${missing.join(", ")}`);
    return Object.freeze({ id: entry.id, root_ids: entry.root_ids, reachable_node_count: entry.reached.size, required, reaches, missing });
  });
  for (const rootId of requiredRootIds) {
    if (!rootsByEntryPoint.has(rootId)) errors.push(`ADR-083 required entry point is absent from entry-points.json: ${rootId}`);
  }

  const portNames = [...config.scoped_ports].sort();
  const factoryFile = typeof mechanism?.native_tool_factory_file === "string" ? mechanism.native_tool_factory_file : "";
  const emissions = nativeToolEmissions().filter((emission) => portNames.includes(emission.tool));
  for (const port of portNames) {
    const matches = emissions.filter((emission) => emission.tool === port);
    if (matches.length !== 1) errors.push(`ADR-083 scoped port ${port} must have exactly one native-tool emission; found ${matches.length}`);
    else if (matches[0].file !== factoryFile) errors.push(`ADR-083 scoped port ${port} is emitted outside the canonical factory file: ${matches[0].file}`);
  }

  // AST checks (not text fragments) bind the trusted scope to the campaign
  // tree and bind each model-supplied endpoint to a fail-closed comparison.
  const scopeSource = sourceFileFor(config.scope_resolver.file);
  if (scopeSource === null) errors.push("ADR-083 scope-resolver source file is missing");
  else {
    const shapeError = hasScopeResolverShape(scopeSource, config.scope_resolver);
    if (shapeError) errors.push(shapeError);
  }
  const hostSource = factoryFile ? sourceFileFor(factoryFile) : null;
  if (hostSource === null) errors.push("ADR-083 native-tool factory source file is missing");
  else {
    const factoryNode = topLevelFunction(hostSource, config.factory.symbol);
    if (factoryNode === null) errors.push(`ADR-083 native-tool factory is absent: ${config.factory.symbol}`);
    else {
      const bindings = factoryPortBindings(factoryNode);
      const emittedByFactory = bindings.map((binding) => binding.tool);
      if (JSON.stringify(emittedByFactory) !== JSON.stringify(portNames)) errors.push(`ADR-083 canonical factory emits ${emittedByFactory.join(", ") || "no scoped ports"}, expected ${portNames.join(", ")}`);
      for (const [port, handler] of Object.entries(config.factory.port_handlers)) {
        const binding = bindings.find((candidate) => candidate.tool === port);
        if (!portNames.includes(port) || typeof handler !== "string" || binding === undefined || !binding.handlers.includes(handler)) {
          errors.push(`ADR-083 canonical factory does not bind ${port} to ${String(handler)}`);
        }
      }
    }
    const scopeError = hasScopeCheckShape(hostSource, config.factory);
    if (scopeError) errors.push(scopeError);
    for (const port of config.scope_checked_ports) {
      const handler = config.factory.port_handlers[port];
      const handlerNode = typeof handler === "string" ? topLevelFunction(hostSource, handler) : null;
      if (handlerNode === null || !callsNamed(handlerNode, config.factory.scope_check_symbol)) errors.push(`ADR-083 scoped handler ${String(handler)} does not invoke ${config.factory.scope_check_symbol}`);
    }
  }

  return Object.freeze({
    ok: errors.length === 0,
    mechanism: mechanism?.id ?? null,
    required_entry_points: requiredRootIds,
    landmarks: landmarkIds,
    scoped_port_emissions: emissions,
    entry_points: perEntryPoint,
    errors: errors.sort(),
  });
}

const communicationProof = analyzeCommunicationProof(manifest.communicationProof);

// ---------------------------------------------------------------------------
// 8. Enumerate exported, value-producing symbols per file (the checklist).
// ---------------------------------------------------------------------------

function isValueProducing(symbol) {
  const decls = symbol.getDeclarations();
  if (!decls || decls.length === 0) return false;
  return decls.some((d) => !TYPE_ONLY_KINDS.has(d.kind));
}

function ultimateSymbol(symbol) {
  let s = symbol;
  while (s.flags & ts.SymbolFlags.Alias) {
    const aliased = checker.getAliasedSymbol(s);
    if (aliased === s) break;
    s = aliased;
  }
  return s;
}

const checklist = [];
for (const sourceFile of program.getSourceFiles()) {
  if (!isTracked(sourceFile)) continue;
  if (!ts.isExternalModule(sourceFile)) continue;
  const file = relPath(sourceFile.fileName);
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) continue;
  const exportsOfModule = checker.getExportsOfModule(moduleSymbol);
  for (const exported of exportsOfModule) {
    const ultimate = ultimateSymbol(exported);
    if (!isValueProducing(ultimate)) continue;
    const decls = ultimate.getDeclarations();
    const unit = findDeclarationUnit(decls[0]) ?? decls[0];
    const id = astNodeToId.get(unit);
    const declFile = relPath(decls[0].getSourceFile().fileName);
    checklist.push({
      name: exported.name,
      file: declFile,
      exportedFrom: file,
      id,
      reachable: id ? reachable.has(id) : false,
      resolvable: !!id,
    });
  }
}

// de-duplicate by (id) — the same underlying declaration can be re-exported
// from multiple barrel files; report it once, against its origin file.
const seen = new Set();
const dedupedChecklist = [];
for (const item of checklist) {
  const key = item.id ?? `${item.file}::${item.name}`;
  if (seen.has(key)) continue;
  seen.add(key);
  dedupedChecklist.push(item);
}

// ---------------------------------------------------------------------------
// 9. Allowlist.
// ---------------------------------------------------------------------------

// `--allowlist <path>` lets a test point this gate at a throwaway allowlist
// file (a genuinely expired or malformed entry) without touching the real
// one — same reason branch-accounting.mjs's `--dispositions` override exists.
const allowlistPath = argValue("--allowlist") ?? join(__dirname, "reachability", "allowlist.json");
// loadWaiverFile treats a MISSING file as an empty store (matches this
// gate's prior behavior exactly: no allowlist yet -> nothing allowlisted).
// An UNPARSEABLE file is never authority to waive a finding.  It remains in
// the report for diagnosis and now fails the gate explicitly; treating it as
// an empty store while returning PASS would make the waiver authority itself
// unverifiable.
const { entries: allowlistEntries, error: allowlistFileError } = loadWaiverFile(allowlistPath);
const allowlist = { entries: allowlistEntries };

const today = new Date().toISOString().slice(0, 10);
function findAllowlistEntry(file, name) {
  return allowlist.entries.find((e) => e.file === file && e.symbol === name);
}

// ---------------------------------------------------------------------------
// 10. Report.
// ---------------------------------------------------------------------------

const unreached = dedupedChecklist.filter((c) => !c.reachable);
const violations = [];
const allowlisted = [];
const expired = [];
const malformed = [];

for (const item of unreached) {
  const entry = findAllowlistEntry(item.file, item.name);
  if (!entry) {
    violations.push(item);
    continue;
  }
  const { ok: validEntry, errors: entryErrors } = validateWaiverEntry(entry, "reachability");
  if (!validEntry) {
    // A malformed allowlist entry (missing reason, unparseable expires, ...)
    // is treated the same as no entry at all: it does NOT waive the
    // violation. Reported separately so the remedy is "fix the entry", not
    // "fix the symbol".
    malformed.push({ item, entry, errors: entryErrors });
    continue;
  }
  if (isWaiverExpired(entry, "reachability", today)) {
    expired.push({ item, entry });
    continue;
  }
  allowlisted.push({ item, entry });
}

const staleAllowlistEntries = allowlist.entries.filter(
  (e) => !unreached.some((u) => u.file === e.file && u.name === e.symbol),
);

export function reachabilityVerdict({ violations, expired, malformed, staleAllowlistEntries, allowlistFileError, rootWarnings, communicationProof }) {
  return violations.length === 0 && expired.length === 0 && malformed.length === 0
    && staleAllowlistEntries.length === 0 && allowlistFileError === null && rootWarnings.length === 0
    && (communicationProof === null || communicationProof.ok);
}

const ok = reachabilityVerdict({ violations, expired, malformed, staleAllowlistEntries, allowlistFileError, rootWarnings, communicationProof });

if (JSON_OUTPUT) {
  console.log(
    JSON.stringify(
      {
        ok,
        totalExportedSymbolsChecked: dedupedChecklist.length,
        violations,
        expiredAllowlistEntries: expired,
        malformedAllowlistEntries: malformed,
        allowlisted,
        staleAllowlistEntries,
        allowlistFileError,
        rootWarnings,
        // ADR-083: stable, per-entry-point proof output.  `reached` sets and
        // source positions never escape this report, so JSON remains
        // deterministic and suitable for a blocking profile gate.
        communicationProof,
        // Full checklist (name/file/reachable), added for Phase 6.7's
        // docs-truth gate: it needs to answer "does this symbol exist, and
        // is it reachable?" for an arbitrary symbol named in a ROADMAP.md
        // proof comment, which the violations-only fields above cannot
        // answer for a symbol that already passes (violations only lists
        // failures). Kept minimal (no scanRoots/ids) to stay small.
        checklist: dedupedChecklist.map((c) => ({ name: c.name, file: c.file, reachable: c.reachable })),
      },
      null,
      2,
    ),
  );
} else {
  console.log(`reachability gate — ${dedupedChecklist.length} exported symbols checked, ${srcFiles.length} source files scanned\n`);

  if (rootWarnings.length) {
    console.log("entry-point manifest warnings:");
    for (const w of rootWarnings) console.log(`  ! ${w}`);
    console.log("");
  }

  if (communicationProof !== null) {
    console.log(`ADR-083 communication proof — ${communicationProof.mechanism ?? "no mechanism"}`);
    for (const entry of communicationProof.entry_points) {
      const status = entry.required ? (entry.missing.length === 0 ? "required: PASS" : "required: FAIL") : "observed";
      console.log(`  ${entry.id}  ${status}  ${entry.reaches.length}/${communicationProof.landmarks.length} landmarks  ${entry.reachable_node_count} nodes`);
    }
    for (const emission of communicationProof.scoped_port_emissions) console.log(`  emits ${emission.tool}  ${emission.file}`);
    if (communicationProof.errors.length) {
      console.log("  violations:");
      for (const error of communicationProof.errors) console.log(`    - ${error}`);
    }
    console.log("");
  }

  if (violations.length) {
    console.log(`${violations.length} unreachable exported symbol(s):`);
    for (const v of violations) {
      console.log(`  - ${v.name}  (${v.file})${v.resolvable ? "" : "  [could not resolve declaration — reported conservatively]"}`);
    }
    console.log("");
  }

  if (expired.length) {
    console.log(`${expired.length} allowlist entr${expired.length === 1 ? "y has" : "ies have"} expired:`);
    for (const { item, entry } of expired) {
      console.log(`  - ${item.name}  (${item.file})  expired ${entry.expires}  [${entry.gap ?? entry.adr ?? "no reference"}]`);
    }
    console.log("");
  }

  if (malformed.length) {
    console.log(`${malformed.length} allowlist entr${malformed.length === 1 ? "y is" : "ies are"} malformed (not waiving the violation):`);
    for (const { item, entry, errors } of malformed) {
      console.log(`  - ${item.name}  (${item.file})  ${errors.join("; ")}`);
    }
    console.log("");
  }

  if (allowlistFileError) {
    console.log(`note: ${allowlistFileError} — treated as an empty allowlist.\n`);
  }

  if (allowlisted.length) {
    console.log(`${allowlisted.length} allowlisted (not failing the gate):`);
    for (const { item, entry } of allowlisted) {
      console.log(`  - ${item.name}  (${item.file})  expires ${entry.expires}  [${entry.gap ?? entry.adr ?? "no reference"}] — ${entry.reason}`);
    }
    console.log("");
  }

  if (staleAllowlistEntries.length) {
    console.log(`note: ${staleAllowlistEntries.length} allowlist entr${staleAllowlistEntries.length === 1 ? "y is" : "ies are"} now unused (symbol is reachable or no longer exists) — safe to remove:`);
    for (const e of staleAllowlistEntries) console.log(`  - ${e.symbol}  (${e.file})`);
    console.log("");
  }

  console.log(ok ? "PASS" : "FAIL");
}

// Not process.exit(): stdout can be a pipe (piped to another process, or
// captured by spawnSync as this gate's own docs-truth.mjs consumer does),
// and Node's stdout writes to a pipe are asynchronous — calling
// process.exit() immediately after a large console.log can truncate the
// write mid-flush (observed: JSON output silently cut at a 64 KiB pipe
// boundary). Setting exitCode and letting the process end naturally lets
// the pending write drain first.
process.exitCode = ok ? 0 : 1;
