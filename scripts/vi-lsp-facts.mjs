#!/usr/bin/env node
/** ADR-090 LSP projection stage; the vendored graph-shape adapter stays immutable. */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { LspClient, viLspRegistration } from "./lib/lsp-client.mjs";
import { makeEdge, makeNode, writeEdges, writeNodes } from "../.claude/skills/repository-visual-intelligence/scripts/lib/graph.mjs";

export const LSP_FACT_PROJECTION = "semantic-symbol-call-reference-reachability";
// A full-repository tsserver can still be indexing when the first call-
// hierarchy request arrives. The prior generic-client default (20s) was
// shorter than a clean CI checkout needs for this 24k-node corpus, causing a
// healthy server to fail before its first answer. Keep the generic client
// default—and its fast failure tests—unchanged; this projection owns the
// larger, bounded deadline appropriate to its workload.
const FULL_CORPUS_LSP_REQUEST_TIMEOUT_MS = 60_000;
const argv = process.argv.slice(2);
const option = (name) => { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1]; };
const root = resolve(option("--root") ?? process.cwd());
const graph = resolve(option("--graph") ?? join(root, ".visual-intelligence/graph"));
const language = option("--language") ?? "typescript";
const registration = viLspRegistration(language);
const readJsonl = (path) => readFileSync(path, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const nodesPath = join(graph, "nodes.jsonl"), edgesPath = join(graph, "edges.jsonl");
const nodes = readJsonl(nodesPath), oldEdges = readJsonl(edgesPath);
const evidence = new Map(readJsonl(join(graph, "evidence.jsonl")).map((record) => [record.id, record]));
const manifestPath = join(graph, "..", "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")), revision = manifest.repo_revision;
const supported = (path) => registration.extensions.includes(extname(path ?? ""));
const files = nodes.filter((node) => (node.kind === "file" || node.kind === "test") && supported(node.repository_path));
if (!files.length) throw new Error(`ADR-090: no ${language} files in scope`);
const fileByPath = new Map(files.map((node) => [node.repository_path, node]));
const textByPath = new Map(files.map((node) => [node.repository_path, readFileSync(join(root, node.repository_path), "utf8")]));
const sourceFileByPath = new Map(
  [...textByPath].map(([path, text]) => [path, ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)]),
);
const graphSymbols = nodes.filter((node) => (node.kind === "symbol" || node.kind === "type") && supported(node.repository_path));
const graphSymbolIds = new Set(graphSymbols.map((node) => node.id));
// An LSP edge is admissible only when both of its endpoints have an exact,
// unambiguous canonical graph identity.  In particular, do not turn an
// unmodelled method into an edge to its containing class: that changes the
// meaning of the LSP answer.  Keep all candidates so a malformed/legacy graph
// with duplicate location identities is detected as ambiguous rather than
// depending on JSONL input order.
const graphSymbolsByLocation = new Map();
for (const node of graphSymbols) {
  const source = evidence.get(node.source_evidence?.[0]);
  if (source?.repository_path && source.line_start) {
    const key = `${source.repository_path}:${source.line_start}:${node.name}`;
    const candidates = graphSymbolsByLocation.get(key) ?? [];
    candidates.push(node);
    graphSymbolsByLocation.set(key, candidates);
  }
}

const CALLABLE_KINDS = new Set([5, 6, 9, 12]); // Class, Method, Constructor, Function.
const CONSTRUCTOR_KINDS = new Set([5, 9]); // Class, Constructor.
const rangesByPath = new Map();
function repoPath(uri) {
  const path = relative(root, fileURLToPath(uri)).replaceAll("\\", "/");
  return path.startsWith("../") || path === ".." ? undefined : path;
}
function flattenSymbols(items, parent = undefined, output = []) {
  for (const item of items ?? []) {
    const current = item.location
      ? { ...item, uri: item.location.uri, range: item.location.range, selectionRange: item.location.range, _parent: parent }
      : { ...item, _parent: parent };
    output.push(current);
    flattenSymbols(item.children, current, output);
  }
  return output;
}
function contains(range, point) {
  return (range.start.line < point.line || (range.start.line === point.line && range.start.character <= point.character))
    && (range.end.line > point.line || (range.end.line === point.line && range.end.character >= point.character));
}
const rangeSize = (range) => (range.end.line - range.start.line) * 1_000_000 + range.end.character - range.start.character;
function referenceOwner(uri, point) {
  const path = repoPath(uri);
  if (!path) return undefined;
  const entries = (rangesByPath.get(path) ?? []).filter((entry) => contains(entry.range, point))
    .sort((left, right) => rangeSize(left.range) - rangeSize(right.range));
  // Local declarations are graph-shape inventory, not execution owners. A
  // reference in `const x = LIVE_VALUE` belongs to the enclosing callable;
  // at module scope it belongs to the file. This matches the independent
  // reachability gate's execution granularity.
  return entries.find((entry) => CALLABLE_KINDS.has(entry.item.kind))?.node ?? fileByPath.get(path);
}
function moduleLinkKind(path, point) {
  const lines = textByPath.get(path)?.split("\n") ?? [];
  for (let line = point.line; line >= Math.max(0, point.line - 50); line -= 1) {
    const source = lines[line] ?? "";
    if (line === point.line && /^\s*export\s+(?:const|let|var|function|class|async)\b/.test(source)) return null;
    if (line < point.line && /^\s*$/.test(source)) return null;
    // Imports and re-exports establish file/module graph shape; they do not
    // execute the referenced symbol. Do not match `export function/class/const`
    // because references in those declaration bodies are runtime wiring.
    if (/^\s*import\s+type\b/.test(source)) return "type-import";
    if (/^\s*import\b/.test(source)) return "import";
    if (/^\s*export\s+(?:type\s+)?(?:\{|\*)/.test(source)) return "re-export";
    if (line < point.line && /[;{}]\s*$/.test(source)) return null;
  }
  return null;
}
function exactNode(item) {
  if (!item?.uri) return undefined;
  const path = repoPath(item.uri), line = (item.selectionRange ?? item.range)?.start?.line;
  if (path === undefined || line === undefined) return undefined;
  const candidates = graphSymbolsByLocation.get(`${path}:${line + 1}:${item.name}`) ?? [];
  return candidates.length === 1 ? candidates[0] : undefined;
}
function exactNodeAt(path, line, name) {
  const candidates = graphSymbolsByLocation.get(`${path}:${line}:${name}`) ?? [];
  return candidates.length === 1 ? candidates[0] : undefined;
}
function namedDeclarationOwner(path, declaration, sourceFile) {
  if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration) || ts.isConstructorDeclaration(declaration)) {
    const name = ts.isConstructorDeclaration(declaration) ? "constructor" : declaration.name?.getText(sourceFile);
    if (!name) return undefined;
    return exactNodeAt(path, sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile)).line + 1, name);
  }
  // Arrow/function expressions do not have a direct graph identity. Their
  // containing variable declaration does, so bind a nested local only when
  // that exact declaration is represented in the canonical graph.
  if (ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) {
    let parent = declaration.parent;
    while (parent && !ts.isVariableDeclaration(parent)) parent = parent.parent;
    if (!parent || !ts.isIdentifier(parent.name)) return undefined;
    return exactNodeAt(path, sourceFile.getLineAndCharacterOfPosition(parent.getStart(sourceFile)).line + 1, parent.name.text);
  }
  return undefined;
}
function executionScopeOwnerForLocal(node) {
  if (node.attributes?.declaration !== "VariableDeclaration" || node.attributes.exported === true) return undefined;
  const source = evidence.get(node.source_evidence?.[0]);
  if (!source?.repository_path || !source.line_start || !node.name) return undefined;
  const sourceFile = sourceFileByPath.get(source.repository_path);
  if (!sourceFile) return undefined;
  const matches = [];
  const visit = (current) => {
    if (
      ts.isVariableDeclaration(current) &&
      ts.isIdentifier(current.name) &&
      current.name.text === node.name &&
      sourceFile.getLineAndCharacterOfPosition(current.getStart(sourceFile)).line + 1 === source.line_start
    ) matches.push(current);
    ts.forEachChild(current, visit);
  };
  visit(sourceFile);
  if (matches.length !== 1) return undefined;
  for (let parent = matches[0].parent; parent; parent = parent.parent) {
    if (!ts.isFunctionLike(parent)) continue;
    const owner = namedDeclarationOwner(source.repository_path, parent, sourceFile);
    // Exact lexical containment and an exact canonical identity are both
    // required. File-level locals and unrepresented anonymous scopes retain
    // their current unknown reachability rather than borrowing a nearby root.
    if (owner) return owner.id;
  }
  return undefined;
}
const itemPosition = (item) => (item.selectionRange ?? item.range).start;
const taskKey = (task) => { const point = itemPosition(task.item); return `${task.node.id}:${task.item.uri}:${point.line}:${point.character}:${task.item.kind}`; };
async function bounded(label, items, limit, operation) {
  let next = 0, completed = 0;
  const results = new Array(items.length);
  process.stdout.write(`[vi-lsp] ${label}: 0/${items.length}\n`);
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      // Network/LSP response timing is intentionally allowed to vary.  Store
      // each answer by its pre-sorted task index, then merge below in that
      // order so timing cannot choose an edge's surviving evidence location.
      results[index] = await operation(items[index]);
      completed += 1;
      if (completed === items.length || completed % 250 === 0) process.stdout.write(`[vi-lsp] ${label}: ${completed}/${items.length}\n`);
    }
  }));
  return results;
}
// `high` is the default because a compiler-grade `calls`/`references`/
// `instantiates` edge IS a resolved fact. Reachability is not, and says so by
// overriding it (see the reachable_from emission below) — CD-CD-02. Overriding
// is now possible at all only because this literal stopped being unconditional.
const edge = (fields) => makeEdge({ ...fields, discovery: "derived", confidence: fields.confidence ?? "high", first_seen: revision, last_verified: revision, attributes: { lsp: true, language, backend_regime: registration.soundness, identity_mapping: "exact_graph_symbol", ...fields.attributes } });
const byteCompare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const rangeLocation = (uri, range) => {
  const path = repoPath(uri);
  return path && range ? `${path}:${range.start.line + 1}:${range.start.character + 1}` : "LSP location unavailable";
};
const edgeOrder = (left, right) => byteCompare(`${left.id}\u0000${left.evidence_location ?? ""}`, `${right.id}\u0000${right.evidence_location ?? ""}`);

const client = new LspClient({
  command: registration.command,
  rootPath: root,
  requestTimeoutMs: FULL_CORPUS_LSP_REQUEST_TIMEOUT_MS,
  backendExitPattern: registration.backendExitPattern,
});
client.start();
try {
  // The server must use this checkout's installed compiler even when the
  // analyzed workspace is an isolated temporary fixture without node_modules.
  const tsserverPath = realpathSync(join(dirname(fileURLToPath(import.meta.url)), "../node_modules/typescript/lib/tsserver.js"));
  await client.initialize({ tsserverPath });
  const documents = [], semanticTasks = [];
  // A non-exported `VariableDeclaration` inside a callable is an inventory
  // node, not an independently callable unit. Its initializer is potentially
  // evaluated whenever that callable runs, so static reachability inherits
  // only from an exact AST-contained canonical callable (never file scope).
  const executionScopeOwnerByLocalId = new Map();
  let unmappedDocumentSymbols = 0;
  for (const file of [...files].sort((left, right) => byteCompare(left.repository_path, right.repository_path))) {
    const absolute = join(root, file.repository_path), uri = pathToFileURL(absolute).href;
    client.didOpen(absolute, registration.languageIds[extname(file.repository_path)], textByPath.get(file.repository_path));
    const response = await client.documentSymbol(absolute);
    if (!Array.isArray(response)) throw new Error(`LSP returned no document symbols for ${file.repository_path}`);
    const items = flattenSymbols(response).map((item) => ({ ...item, uri: item.uri ?? uri }));
    // Establish exact graph-backed ranges first, then use them for LSP-only children.
    for (const item of items) {
      const node = exactNode(item);
      if (!node || !item.range) continue;
      if (!rangesByPath.has(file.repository_path)) rangesByPath.set(file.repository_path, []);
      rangesByPath.get(file.repository_path).push({ node, range: item.range, item });
    }
    let mappedInDocument = 0;
    for (const item of items) {
      const node = exactNode(item);
      if (node && graphSymbolIds.has(node.id)) { semanticTasks.push({ item, node }); mappedInDocument += 1; }
      else unmappedDocumentSymbols += 1;
    }
    documents.push({ file: file.repository_path, symbols: items.length, mapped: mappedInDocument });
  }

  for (const node of graphSymbols) {
    const owner = executionScopeOwnerForLocal(node);
    if (owner) executionScopeOwnerByLocalId.set(node.id, owner);
  }

  const uniqueTasks = [...new Map(semanticTasks.map((task) => [taskKey(task), task])).values()].sort((left, right) => byteCompare(taskKey(left), taskKey(right)));
  const callableTasks = uniqueTasks.filter((task) => CALLABLE_KINDS.has(task.item.kind));
  // A hierarchical document-symbol response includes locals, parameters,
  // methods, and properties. Querying references for every child turns one
  // module declaration into hundreds of serial tsserver searches. Query every
  // top-level semantic declaration plus graph-backed nested callables: call
  // hierarchy does not report a call made inside an unmodelled returned arrow
  // as a call owned by its enclosing factory, while references can still bind
  // the exact nested target to that exact canonical owner. Nested non-callable
  // locals remain honest symbol-existence facts, not fabricated reachability
  // verdicts.
  const referenceTasks = uniqueTasks.filter((task) => !task.item._parent || CALLABLE_KINDS.has(task.item.kind));
  const representedNodeIds = new Set(uniqueTasks.map((task) => task.node.id));
  const reachabilityNodeIds = new Set([...callableTasks, ...referenceTasks].map((task) => task.node.id));
  const projected = new Map();
  let externalCallTargets = 0, unmappedCallTargets = 0, externalReferences = 0;

  const callOutcomes = await bounded("call hierarchy", callableTasks, 12, async (task) => {
    const path = repoPath(task.item.uri);
    if (!path) return { edges: [], external: 0, unmapped: 0 };
    const prepared = await client.prepareCallHierarchy(join(root, path), itemPosition(task.item));
    if (!Array.isArray(prepared) || prepared.length === 0) return { edges: [], external: 0, unmapped: 0 };
    // prepareCallHierarchy is allowed to return multiple items at one cursor.
    // Query only the exact graph identity requested, never an arbitrary first
    // item (notably important at overloaded declarations).
    const sourceItems = prepared.filter((item) => exactNode(item)?.id === task.node.id)
      .sort((left, right) => byteCompare(rangeLocation(left.uri, left.selectionRange ?? left.range), rangeLocation(right.uri, right.selectionRange ?? right.range)));
    if (sourceItems.length !== 1) return { edges: [], external: 0, unmapped: 0 };
    const records = [], seen = new Set();
    let external = 0, unmapped = 0;
    for (const call of (await client.outgoingCalls(sourceItems[0])) ?? []) {
      const target = exactNode(call.to);
      if (!target) {
        const targetPath = call.to?.uri ? repoPath(call.to.uri) : undefined;
        // Filesystem ancestry is not the analysis boundary: dependencies in
        // node_modules live below root but are deliberately outside the graph.
        // An in-scope, LSP-resolved symbol without a canonical identity is a
        // reported coverage gap, not permission to substitute its container.
        if (targetPath !== undefined && fileByPath.has(targetPath)) unmapped += 1;
        else external += 1;
        continue;
      }
      if (target.id === task.node.id) continue;
      reachabilityNodeIds.add(target.id);
      const locations = (call.fromRanges?.length ? call.fromRanges : [undefined])
        .map((range) => rangeLocation(task.item.uri, range)).sort(byteCompare);
      const record = edge({ source: task.node.id, target: target.id, relation: CONSTRUCTOR_KINDS.has(call.to.kind) ? "instantiates" : "calls", evidence_type: "lsp_call_hierarchy", evidence_location: locations[0] });
      if (!seen.has(record.id)) { records.push(record); seen.add(record.id); }
    }
    return { edges: records.sort(edgeOrder), external, unmapped };
  });
  for (const outcome of callOutcomes) {
    externalCallTargets += outcome.external;
    unmappedCallTargets += outcome.unmapped;
    for (const record of outcome.edges) if (!projected.has(record.id)) projected.set(record.id, record);
  }

  // Reference tasks cover every graph-backed LSP symbol, not only callables.
  const referenceOutcomes = await bounded("references", referenceTasks, 12, async (task) => {
    const path = repoPath(task.item.uri);
    if (!path) return { edges: [], external: 0 };
    const records = [], seen = new Set();
    let external = 0;
    const addReference = (reference) => {
      const referencePath = repoPath(reference.uri);
      const declarationRange = task.item.selectionRange ?? task.item.range;
      if (reference.uri === task.item.uri && declarationRange && contains(declarationRange, reference.range.start)) return;
      const owner = referenceOwner(reference.uri, reference.range.start);
      if (!owner) { external += 1; return; }
      if (owner.id === task.node.id) return;
      if (graphSymbolIds.has(owner.id)) reachabilityNodeIds.add(owner.id);
      const record = edge({ source: owner.id, target: task.node.id, relation: "references", evidence_type: "lsp_references", evidence_location: rangeLocation(reference.uri, reference.range), attributes: { identity_mapping: "exact_target_canonical_owner" } });
      if (!seen.has(record.id)) { records.push(record); seen.add(record.id); }
    };
    for (const reference of (await client.references(join(root, path), itemPosition(task.item), false)) ?? []) {
      const referencePath = repoPath(reference.uri);
      const linkKind = referencePath ? moduleLinkKind(referencePath, reference.range.start) : null;
      // LSP already resolves ordinary import aliases to their actual uses.
      // Import/re-export declarations themselves describe module shape and do
      // not establish symbol execution reachability.
      if (linkKind) continue;
      addReference(reference);
    }
    return { edges: records.sort(edgeOrder), external };
  });
  for (const outcome of referenceOutcomes) {
    externalReferences += outcome.external;
    for (const record of outcome.edges) if (!projected.has(record.id)) projected.set(record.id, record);
  }

  // Every answer above is in hand; refuse to project them if the server's
  // backend died at any point. Its later answers were empty, not "no
  // references", and a BFS over them silently drops most of the repository
  // from reachability (see TSSERVER_BACKEND in lib/lsp-client.mjs).
  client.assertHealthy();

  const replacedRelations = new Set(["calls", "references", "instantiates", "reachable_from"]);
  const baseEdges = oldEdges.filter((record) => !replacedRelations.has(record.relation));
  const adjacency = new Map();
  for (const record of [...baseEdges, ...projected.values()]) {
    if (record.relation === "contains" || record.relation === "tests" || record.attributes?.type_only) continue;
    if (!adjacency.has(record.source)) adjacency.set(record.source, []);
    adjacency.get(record.source).push(record.target);
  }
  const queue = [...(manifest.entrypoints?.roots ?? [])], reached = new Set(queue);
  while (queue.length > 0) for (const target of adjacency.get(queue.shift()) ?? []) if (!reached.has(target)) { reached.add(target); queue.push(target); }
  // The lexical scope relation is a reachability inheritance, not an edge in
  // the program call graph.  A local's initializer may be branch-conditional,
  // so this is the same potential-reachability over-approximation used for
  // ordinary calls; it never claims the local executed on every run.
  const reachedLocalDeclarations = new Map();
  for (const [local, owner] of executionScopeOwnerByLocalId) {
    if (reached.has(owner)) {
      reached.add(local);
      reachedLocalDeclarations.set(local, owner);
    }
  }
  const entrypoint = nodes.find((node) => node.kind === "entrypoint")?.id;
  if (!entrypoint) throw new Error("ADR-090: no entrypoint node");
  for (const source of reached) {
    const lexicalOwner = reachedLocalDeclarations.get(source);
    const record = edge({
      source,
      target: entrypoint,
      relation: "reachable_from",
      // CD-CD-02, the half that is live in a FRESH build. The extractor's own
      // BFS edges are replaced wholesale by `replacedRelations` above, so in a
      // clean `vi:refresh` this loop emits the ENTIRE reachable_from population
      // — measured 19,439 of 19,439 at revision 08322433. It already named
      // itself honestly in `evidence_type`; what it did not do was stop calling
      // the result `confidence: "high"`. The adjacency is compiler-resolved, but
      // reachability is still a BFS OVER-APPROXIMATION of it: a `references`
      // edge is not an execution, a call inside a branch that never runs counts,
      // and `runtime_observed` is "unknown" on every one of these. `medium` is
      // the honest ceiling; `high` is reserved for the individual resolved call
      // and reference edges this same helper emits.
      confidence: "medium",
      evidence_type: lexicalOwner ? "lsp_lexical_scope_reachability" : "lsp_semantic_reachability",
      evidence_location: lexicalOwner ? `LSP lexical scope of ${lexicalOwner}` : "LSP-projected BFS",
      attributes: lexicalOwner
        ? { identity_mapping: "lexical_scope_owner", execution_scope_owner: lexicalOwner }
        : { identity_mapping: "canonical_bfs" },
    });
    projected.set(record.id, record);
  }

  const projectedNodes = nodes.map((node) => {
    if (!graphSymbolIds.has(node.id)) return node;
    const represented = reachabilityNodeIds.has(node.id);
    return makeNode({ ...node,
      implementation_status: represented ? (reached.has(node.id) ? "wired_but_unverified" : "implemented_but_unreachable") : "unknown",
      defect_shape: represented && !reached.has(node.id) ? "unreached" : null,
      confidence: represented ? "high" : node.confidence,
      attributes: { ...node.attributes, static_fact_authority: represented ? "lsp" : (representedNodeIds.has(node.id) ? "lsp_symbol_only" : "lsp_unrepresented"), lsp_language: language, lsp_backend_regime: registration.soundness },
    });
  });
  writeNodes(nodesPath, projectedNodes);
  writeEdges(edgesPath, [...baseEdges, ...projected.values()]);
  const projectedEdges = [...projected.values()];
  const facts = {
    schema_version: 1, source: "lsp", language, backend_regime: registration.soundness, fact_regime: LSP_FACT_PROJECTION,
    symbol_existence: { status: "computed", files: documents.length, mapped_semantic_items: uniqueTasks.length, represented_graph_nodes: representedNodeIds.size, unmapped_document_symbols: unmappedDocumentSymbols, documents },
    call_hierarchy: { status: "projected", calls: projectedEdges.filter((record) => record.relation === "calls").length, instantiates: projectedEdges.filter((record) => record.relation === "instantiates").length, external_targets_skipped: externalCallTargets, in_scope_targets_unmapped: unmappedCallTargets },
    references: { status: "projected", tasks: referenceTasks.length, scope: "top-level-semantic-declarations-and-nested-callables", edges: projectedEdges.filter((record) => record.relation === "references").length, external_locations_skipped: externalReferences },
    reachability: { status: "projected", nodes: reached.size, lexical_scope_inherited: reachedLocalDeclarations.size },
  };
  writeFileSync(join(graph, "lsp-facts.json"), `${JSON.stringify(facts, null, 2)}\n`);
  manifest.lsp_static_facts = {
    source: "scripts/vi-lsp-facts.mjs", language, backend_regime: registration.soundness,
    fact_regime: facts.fact_regime, symbol_existence: "computed", call_hierarchy: "projected",
    references: "projected", reachability: "projected", canonical_edges: "projected",
    identity_mapping: "exact-only", in_scope_target_policy: "coverage-debt", fallback: "none",
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
} finally {
  await client.shutdown();
}
