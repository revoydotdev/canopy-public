import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import ts from "typescript";
import type { Provenance } from "@arbor/core";

const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SOURCE_EXTENSIONS = new Set([...TYPESCRIPT_EXTENSIONS, ".py", ".rs", ".go"]);
// `.worktrees` contains isolated campaign replicas of the same repository.
// Indexing them multiplies parse cost and can rank stale duplicate symbols
// ahead of the canonical checkout, degrading both economy and correctness.
const EXCLUDED_DIRECTORIES = new Set([".git", ".worktrees", "node_modules", "dist", "coverage", ".arbor", "target", "__pycache__", ".venv", "venv", "vendor"]);
const MAX_FILES = 5_000;
const MAX_RESULT_NODES = 80;
const MAX_TASK_SEEDS = 6;
const MAX_TASK_RESULT_NODES = 24;

export interface RepositoryGraphQuery {
  readonly path?: string;
  readonly symbol?: string;
  readonly depth?: number;
}

export interface VerifiedMemoryRetrievalSignal {
  readonly terms: readonly string[];
  readonly provenance: Provenance;
  readonly evidence_pointer: string;
}

export interface RepositoryRetrievalSignals {
  readonly changed_paths?: readonly string[];
  readonly memory?: readonly VerifiedMemoryRetrievalSignal[];
}

export interface RepositoryRetrievalStrategy {
  readonly changed_paths: boolean;
  readonly verified_memory: boolean;
  readonly structural_centrality: boolean;
}

export const DEFAULT_REPOSITORY_RETRIEVAL_STRATEGY: RepositoryRetrievalStrategy = Object.freeze({
  changed_paths: true,
  verified_memory: true,
  // Calibration found a recall regression when degree displaced a relevant
  // low-centrality file at the 24-node projection boundary. Keep the arm
  // measurable, but fail closed until held-out evidence supports promotion.
  structural_centrality: false,
});

export interface RepositoryGraphResult {
  readonly cache_hit: boolean;
  readonly index_digest: string;
  readonly files_indexed: number;
  readonly nodes: readonly { path: string; symbols: readonly string[] }[];
  readonly edges: readonly { from: string; to: string }[];
  readonly truncated: boolean;
}

interface IndexedFile {
  readonly path: string;
  readonly symbols: readonly string[];
  readonly imports: readonly string[];
}

interface CachedGraph {
  readonly fingerprint: string;
  readonly digest: string;
  readonly files: ReadonlyMap<string, IndexedFile>;
  readonly incoming: ReadonlyMap<string, readonly string[]>;
}

/** Process-local parsed graph cache; file metadata invalidates it deterministically. */
export class RepositoryGraphIndex {
  private cache = new Map<string, CachedGraph>();

  query(root: string, query: RepositoryGraphQuery): RepositoryGraphResult {
    const loaded = this.load(root); const { graph, cache_hit } = loaded;
    const depth = Math.min(3, Math.max(0, query.depth ?? 1));
    const seeds = selectSeeds(graph!, query);
    const selected = neighborhood(graph!, seeds, depth);
    const ordered = [...selected].sort().slice(0, MAX_RESULT_NODES);
    const kept = new Set(ordered);
    const edges = ordered.flatMap((path) => (graph!.files.get(path)?.imports ?? [])
      .filter((target) => kept.has(target))
      .map((target) => ({ from: path, to: target })));
    return Object.freeze({
      cache_hit,
      index_digest: graph!.digest,
      files_indexed: graph!.files.size,
      nodes: Object.freeze(ordered.map((path) => ({ path, symbols: graph!.files.get(path)?.symbols ?? [] }))),
      edges: Object.freeze(edges),
      truncated: selected.size > ordered.length || loaded.discovery_truncated,
    });
  }

  /** Deterministic task-ranked neighborhood; never copies source content. */
  queryTask(root: string, task: string, options: {
    readonly signals?: RepositoryRetrievalSignals;
    readonly strategy?: Partial<RepositoryRetrievalStrategy>;
  } = {}): RepositoryGraphResult {
    const loaded = this.load(root); const { graph, cache_hit } = loaded;
    const strategy = { ...DEFAULT_REPOSITORY_RETRIEVAL_STRATEGY, ...options.strategy };
    const taskTermSet = taskTerms(task);
    // Memory can refine retrieval only when it retains both verified
    // provenance and a durable evidence pointer. Claimed/generated memory is
    // ignored rather than converted into search authority.
    const memoryTerms = strategy.verified_memory
      ? taskTerms((options.signals?.memory ?? [])
        .filter((signal) => signal.provenance.tag === "verified" && signal.evidence_pointer.trim().length > 0)
        .flatMap((signal) => signal.terms)
        .join(" "))
      : [];
    const changedPaths = new Set(strategy.changed_paths
      ? (options.signals?.changed_paths ?? []).map(normalizeRepositoryPath).filter((path): path is string => path !== null && graph!.files.has(path))
      : []);
    const ranked = [...graph!.files.values()].map((file) => {
      const lexical = relevanceScore(file, taskTermSet);
      const memory = relevanceScore(file, memoryTerms);
      const changed = changedPaths.has(file.path) ? 1_000 : 0;
      const matched = lexical > 0 || memory > 0 || changed > 0;
      // Centrality is only a tie-breaker among already grounded candidates;
      // it can never pull an unrelated hub into an empty query.
      const degree = (file.imports.length + (graph!.incoming.get(file.path)?.length ?? 0));
      const centrality = strategy.structural_centrality && matched ? Math.log2(degree + 1) : 0;
      return { path: file.path, score: changed + lexical + memory * 0.75 + centrality };
    })
      .filter((row) => row.score > 0)
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
    const selected = neighborhood(graph!, new Set(ranked.slice(0, MAX_TASK_SEEDS).map((row) => row.path)), 1);
    const scores = new Map(ranked.map((row) => [row.path, row.score]));
    const ordered = [...selected].sort((left, right) => (scores.get(right) ?? 0) - (scores.get(left) ?? 0) || left.localeCompare(right)).slice(0, MAX_TASK_RESULT_NODES);
    const kept = new Set(ordered);
    return Object.freeze({
      cache_hit, index_digest: graph!.digest, files_indexed: graph!.files.size,
      nodes: Object.freeze(ordered.map((path) => ({ path, symbols: graph!.files.get(path)?.symbols ?? [] }))),
      edges: Object.freeze(ordered.flatMap((path) => (graph!.files.get(path)?.imports ?? []).filter((target) => kept.has(target)).map((target) => ({ from: path, to: target })))),
      truncated: selected.size > ordered.length || loaded.discovery_truncated,
    });
  }

  /** Full metadata-only corpus projection for diagnostics and controlled evaluation. */
  snapshot(root: string): RepositoryGraphResult {
    const loaded = this.load(root); const ordered = [...loaded.graph.files.keys()].sort(); const kept = new Set(ordered);
    return Object.freeze({
      cache_hit: loaded.cache_hit, index_digest: loaded.graph.digest, files_indexed: loaded.graph.files.size,
      nodes: Object.freeze(ordered.map((path) => ({ path, symbols: loaded.graph.files.get(path)?.symbols ?? [] }))),
      edges: Object.freeze(ordered.flatMap((path) => (loaded.graph.files.get(path)?.imports ?? []).filter((target) => kept.has(target)).map((target) => ({ from: path, to: target })))),
      truncated: loaded.discovery_truncated,
    });
  }

  private load(root: string): { readonly graph: CachedGraph; readonly cache_hit: boolean; readonly discovery_truncated: boolean } {
    const discovered = discover(root);
    const fingerprint = digest(discovered.map((entry) => `${entry.path}:${entry.size}:${entry.mtime}`).join("\n"));
    let graph = this.cache.get(root); const cache_hit = graph?.fingerprint === fingerprint;
    if (!cache_hit) { graph = build(root, discovered.map((entry) => entry.path), fingerprint); this.cache.set(root, graph); }
    return { graph: graph!, cache_hit, discovery_truncated: discovered.length >= MAX_FILES };
  }
}

function normalizeRepositoryPath(path: string): string | null {
  const normalized = path.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized.length > 0 && !normalized.startsWith("/") && !normalized.split("/").includes("..") ? normalized : null;
}

function taskTerms(task: string): readonly string[] {
  const raw = task.toLowerCase();
  const expanded = task.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  // Keep the raw token as well as its camel-case expansion. Acronyms such as
  // OpenAI otherwise become only `open`, `ai` and lose the exact filename
  // match against `openai-compatible.ts`.
  return [...new Set([raw, expanded].flatMap((form) => form.split(/[^a-z0-9@._/-]+/).flatMap((part) => part.split(/[./_-]+/)))
    .filter((term) => term.length >= 3 && !TASK_STOP_WORDS.has(term)))].slice(0, 40);
}
const TASK_STOP_WORDS = new Set(["the", "and", "for", "with", "from", "this", "that", "into", "then", "when", "should", "would", "could", "add", "fix", "make", "use", "using"]);
function relevanceScore(file: IndexedFile, terms: readonly string[]): number {
  const path = file.path.toLowerCase(); const symbols = file.symbols.map((symbol) => symbol.toLowerCase());
  let score = 0; let matchedTerms = 0;
  for (const term of terms) {
    const pathScore = path === term || path.endsWith(`/${term}`) ? 12 : path.includes(term) ? 4 : 0;
    const symbolScore = symbols.reduce((best, symbol) => Math.max(best, symbol === term ? 10 : symbol.includes(term) ? 6 : 0), 0);
    const termScore = Math.max(pathScore, symbolScore);
    if (termScore > 0) { matchedTerms++; score += termScore; }
  }
  // Distinct concept coverage beats a file that repeats one generic word in
  // many exported symbols. The bounded quadratic bonus is deterministic and
  // remains subordinate to exact path/symbol matches for small term sets.
  const normalizedPath = path.replace(/[^a-z0-9]+/g, " ").trim();
  const adjacentPhraseMatches = terms.slice(0, -1).filter((term, index) => normalizedPath.includes(`${term} ${terms[index + 1]}`)).length;
  return score + matchedTerms * matchedTerms * 2 + adjacentPhraseMatches * 20;
}

function discover(root: string): Array<{ path: string; size: number; mtime: number }> {
  const found: Array<{ path: string; size: number; mtime: number }> = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= MAX_FILES) return;
      if (entry.isSymbolicLink() || (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name))) continue;
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
        const stats = statSync(absolute);
        found.push({ path: relative(root, absolute).split("\\").join("/"), size: stats.size, mtime: stats.mtimeMs });
      }
    }
  };
  walk(root);
  return found;
}

function build(root: string, paths: readonly string[], fingerprint: string): CachedGraph {
  const pathSet = new Set(paths);
  const files = new Map<string, IndexedFile>();
  for (const path of paths) {
    const text = readFileSync(resolve(root, path), "utf8");
    const { symbols, imports } = analyzeFile(path, text, pathSet);
    files.set(path, Object.freeze({ path, symbols: Object.freeze([...new Set(symbols)].sort()), imports: Object.freeze([...new Set(imports)].sort()) }));
  }
  const incoming = new Map<string, string[]>();
  for (const file of files.values()) for (const target of file.imports) incoming.set(target, [...(incoming.get(target) ?? []), file.path]);
  const canonical = [...files.values()].map((file) => `${file.path}|${file.symbols.join(",")}|${file.imports.join(",")}`).join("\n");
  return { fingerprint, digest: digest(canonical), files, incoming };
}

function analyzeFile(path: string, text: string, paths: ReadonlySet<string>): { readonly symbols: string[]; readonly imports: string[] } {
  if (TYPESCRIPT_EXTENSIONS.has(extname(path))) {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, scriptKind(path));
    const imports: string[] = [];
    const symbols: string[] = [];
    for (const statement of source.statements) {
      const specifier = moduleSpecifier(statement);
      if (specifier?.startsWith(".")) {
        const target = resolveImport(path, specifier, paths);
        if (target) imports.push(target);
      }
      const name = declarationName(statement);
      if (name) symbols.push(name);
    }
    return { symbols, imports };
  }
  if (path.endsWith(".py")) return analyzePython(path, text, paths);
  if (path.endsWith(".rs")) return analyzeRust(path, text, paths);
  return analyzeGo(text);
}

function analyzePython(path: string, text: string, paths: ReadonlySet<string>): { symbols: string[]; imports: string[] } {
  const symbols = [...text.matchAll(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(|^class\s+([A-Za-z_]\w*)\b/gm)]
    .map((match) => match[1] ?? match[2]).filter((name): name is string => Boolean(name));
  const imports: string[] = [];
  for (const match of text.matchAll(/^from\s+(\.+)([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)?\s+import\s+/gm)) {
    const levels = match[1]!.length;
    const importerParts = path.split("/").slice(0, -1);
    const baseParts = importerParts.slice(0, Math.max(0, importerParts.length - (levels - 1)));
    const moduleParts = match[2]?.split(".") ?? [];
    const base = [...baseParts, ...moduleParts].join("/");
    const target = [`${base}.py`, `${base}/__init__.py`].find((candidate) => paths.has(candidate));
    if (target) imports.push(target);
  }
  return { symbols, imports };
}

function analyzeRust(path: string, text: string, paths: ReadonlySet<string>): { symbols: string[]; imports: string[] } {
  const symbols = [...text.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|type|mod)\s+([A-Za-z_]\w*)\b/gm)].map((match) => match[1]!);
  const directory = path.split("/").slice(0, -1).join("/");
  const imports = [...text.matchAll(/^\s*(?:pub\s+)?mod\s+([A-Za-z_]\w*)\s*;/gm)].flatMap((match) => {
    const base = directory.length > 0 ? `${directory}/${match[1]}` : match[1]!;
    const target = [`${base}.rs`, `${base}/mod.rs`].find((candidate) => paths.has(candidate));
    return target ? [target] : [];
  });
  return { symbols, imports };
}

function analyzeGo(text: string): { symbols: string[]; imports: string[] } {
  const declarations = [
    ...text.matchAll(/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/gm),
    ...text.matchAll(/^\s*type\s+([A-Za-z_]\w*)\s+/gm),
  ];
  return { symbols: declarations.map((match) => match[1]!).sort(), imports: [] };
}

function selectSeeds(graph: CachedGraph, query: RepositoryGraphQuery): Set<string> {
  if (query.path) {
    const normalized = query.path.replaceAll("\\", "/").replace(/^\.\//, "");
    return new Set([...graph.files.keys()].filter((path) => path === normalized || path.startsWith(`${normalized}/`)));
  }
  const needle = query.symbol?.trim().toLowerCase() ?? "";
  if (needle.length === 0) return new Set();
  return new Set([...graph.files.values()].filter((file) => file.symbols.some((symbol) => symbol.toLowerCase().includes(needle))).map((file) => file.path));
}

function neighborhood(graph: CachedGraph, seeds: ReadonlySet<string>, depth: number): Set<string> {
  const selected = new Set(seeds);
  let frontier = [...seeds];
  for (let level = 0; level < depth; level += 1) {
    const next: string[] = [];
    for (const path of frontier) {
      for (const adjacent of [...(graph.files.get(path)?.imports ?? []), ...(graph.incoming.get(path) ?? [])]) {
        if (!selected.has(adjacent)) { selected.add(adjacent); next.push(adjacent); }
      }
    }
    frontier = next;
  }
  return selected;
}

function moduleSpecifier(statement: ts.Statement): string | null {
  if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) return statement.moduleSpecifier.text;
  return null;
}

function declarationName(statement: ts.Statement): string | null {
  if (ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement)
    || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) return statement.name?.text ?? null;
  if (ts.isVariableStatement(statement)) {
    const names = statement.declarationList.declarations.map((declaration) => ts.isIdentifier(declaration.name) ? declaration.name.text : "").filter(Boolean);
    return names.length > 0 ? names.join(",") : null;
  }
  return null;
}

function resolveImport(importer: string, specifier: string, paths: ReadonlySet<string>): string | null {
  const base = resolve("/", importer, "..", specifier).slice(1).replaceAll("\\", "/");
  // NodeNext source commonly imports `./b.js` while the repository file is
  // `b.ts`; resolve both the literal runtime spelling and source variants.
  const withoutRuntimeExtension = /\.(?:js|jsx|mjs|cjs)$/.test(base) ? base.replace(/\.(?:js|jsx|mjs|cjs)$/, "") : base;
  const candidates = [base,
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].map((extension) => `${withoutRuntimeExtension}${extension}`),
    ...[".ts", ".tsx", ".js", ".jsx"].map((extension) => `${withoutRuntimeExtension}/index${extension}`)];
  return candidates.find((candidate) => paths.has(candidate)) ?? null;
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function digest(value: string): string { return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`; }
