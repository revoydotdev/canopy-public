/**
 * language-support.mjs — ADR-143: which languages a gate can measure, which
 * languages a repository actually contains, and what to do about the gap.
 *
 * WHY THIS EXISTS. This battery is presented as a general model for governed
 * autonomous work, and it is not general: a census on 2026-08-27 found that of
 * 51 gates, 26 read only artifacts, 7 read the VI graph, 9 glob source paths
 * and 7 parse TypeScript through the compiler API. That distribution is fine.
 * What is not fine is that NOTHING SAYS SO — a gate that parses TypeScript and
 * a gate that reads markdown both report `PASS`. Point this battery at a Python
 * repository and most of it goes green while measuring nothing, which is the
 * failure this repository has repeatedly named as worse than having no gate:
 * a safeguard that is documented but not wired, printing confidence it has not
 * earned.
 *
 * So: a gate declares what it can measure, a repository declares what it
 * contains, and a gate that cannot measure a repository's language returns
 * `unsupported` — a third verdict, never folded into `pass`.
 *
 * The detection half exists because revoy2 writes code. A campaign can
 * introduce a language the profile does not name, and an autonomous harness
 * that can add a language it cannot govern is a harness whose governance is
 * optional in practice.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

/**
 * Extension → language id. Deliberately small and explicit: an extension census
 * is a heuristic, and a long speculative table would produce confident nonsense
 * about languages nobody is writing here.
 */
const EXTENSION_LANGUAGE = Object.freeze({
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
  ".py": "python", ".rs": "rust", ".go": "go", ".rb": "ruby", ".java": "java",
  ".kt": "kotlin", ".swift": "swift", ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp",
  ".hpp": "cpp", ".cs": "csharp", ".php": "php", ".ex": "elixir", ".exs": "elixir",
  ".sh": "shell", ".bash": "shell", ".zsh": "shell",
});

/** The LSP server each known language is scaffolded against (ADR-090's client drives all of them). */
const LSP_SERVERS = Object.freeze({
  typescript: "typescript-language-server --stdio",
  javascript: "typescript-language-server --stdio",
  python: "pyright-langserver --stdio",
  rust: "rust-analyzer",
  go: "gopls",
  ruby: "solargraph stdio",
  java: "jdtls",
  kotlin: "kotlin-language-server",
  swift: "sourcekit-lsp",
  c: "clangd",
  cpp: "clangd",
  csharp: "omnisharp -lsp",
  php: "intelephense --stdio",
  elixir: "elixir-ls",
  shell: "bash-language-server start",
});

const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", "target", "vendor", "__pycache__", ".venv"]);

/** Strip `//` and `/* *​/` comments so a .jsonc profile parses as JSON. */
function parseJsonc(text) {
  return JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1"));
}

/** Read `arbor.profile.jsonc`, tolerating its absence (a repo may not have one yet). */
export function readProfile(repoRoot) {
  const path = join(repoRoot, "arbor.profile.jsonc");
  if (!existsSync(path)) return null;
  try { return parseJsonc(readFileSync(path, "utf-8")); } catch { return null; }
}

/**
 * The languages a repository DECLARES it contains.
 *
 * Accepts both ADR-073's original singular `language` and ADR-143's plural
 * `languages`, because polyglot is the normal case and the singular form is
 * still in the wild. A repo declaring neither declares nothing — which is a
 * finding, not a default.
 */
export function declaredLanguages(repoRoot) {
  const profile = readProfile(repoRoot);
  if (profile === null) return [];
  if (Array.isArray(profile.languages)) {
    return profile.languages.map((entry) => (typeof entry === "string" ? entry : entry?.id)).filter((id) => typeof id === "string");
  }
  return typeof profile.language === "string" ? [profile.language] : [];
}

/** Source roots to census, defaulting to the repo root when the profile names none. */
function sourceRoots(repoRoot) {
  const profile = readProfile(repoRoot);
  const roots = Array.isArray(profile?.source_roots) && profile.source_roots.length > 0 ? profile.source_roots : ["."];
  return roots.map((root) => join(repoRoot, root)).filter((path) => existsSync(path));
}

/** Count source files by language under the declared source roots. */
export function censusLanguages(repoRoot) {
  const counts = {};
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) walk(full);
        continue;
      }
      const language = EXTENSION_LANGUAGE[extname(entry.name)];
      if (language !== undefined) counts[language] = (counts[language] ?? 0) + 1;
    }
  };
  for (const root of sourceRoots(repoRoot)) {
    try { if (statSync(root).isDirectory()) walk(root); } catch { /* unreadable root is not a language finding */ }
  }
  return counts;
}

/**
 * Languages present in the source roots that the profile does not declare.
 *
 * The materiality floor is why detection reports rather than installs: one
 * vendored fixture or a single example file is not a language this repository
 * has taken on, and proposing a pack for it would train its reader to dismiss
 * the finding.
 */
export function undeclaredLanguages(repoRoot, { floor = 3 } = {}) {
  const declared = new Set(declaredLanguages(repoRoot));
  return Object.entries(censusLanguages(repoRoot))
    .filter(([language, files]) => !declared.has(language) && files >= floor)
    .map(([language, files]) => ({ language, files }))
    .sort((a, b) => b.files - a.files);
}

/**
 * Resolve whether a gate can measure a repository's languages.
 *
 * Four verdicts, and the distinction between them is the whole point:
 *   supported   — the gate reads artifacts, or a pack covers every language
 *   partial     — a pack covers some languages; `uncovered` names the rest
 *   unsupported — no pack covers any declared language; the gate measured nothing
 *   undeclared  — the gate is absent from the manifest
 *
 * `undeclared` exists so omission cannot be a silent pass. A new gate that
 * never adds its manifest entry would otherwise inherit "agnostic" by default,
 * which is exactly the assumption this module was written to remove.
 */
export function resolveGateSupport({ gate, manifest, languages }) {
  const entry = manifest?.[gate];
  if (entry === undefined) {
    return { gate, verdict: "undeclared", reason: `${gate} is absent from scripts/gate-manifest.json — declare its language support` };
  }
  if (entry.support === "language_agnostic" || entry.support === "graph_derived") {
    return { gate, verdict: "supported", reason: entry.support };
  }
  const covered = new Set(entry.languages ?? []);
  const uncovered = languages.filter((language) => !covered.has(language));
  if (uncovered.length === 0) return { gate, verdict: "supported", reason: "every declared language has a pack" };
  if (uncovered.length === languages.length) {
    return { gate, verdict: "unsupported", uncovered, reason: `${gate} has no pack for ${uncovered.join(", ")} — it measured nothing` };
  }
  return { gate, verdict: "partial", uncovered, reason: `${gate} does not cover ${uncovered.join(", ")}` };
}

/**
 * Scaffold a candidate language pack for a detected language.
 *
 * ADVISORY BY CONSTRUCTION. There is deliberately no input that can make the
 * result blocking — not a parameter, not an option, not an override. A pack
 * that could promote itself would let the harness certify its own governance
 * coverage, which is the same shape `gate:vi-findings` already refuses when it
 * forbids a model triaging its own findings. Scaffolding is mechanical and
 * should not wait for a human; granting a pack authority is a decision and
 * must.
 */
export function scaffoldLanguagePack({ language, files }) {
  return Object.freeze({
    id: language,
    mode: "advisory",
    advisory_reason:
      "scaffolded automatically on detection; promotion to blocking is an operator decision recorded in decisions/interviews.jsonl (ADR-143 Decision 6)",
    detected_files: files,
    lsp_server: LSP_SERVERS[language] ?? null,
    globs: Object.entries(EXTENSION_LANGUAGE).filter(([, id]) => id === language).map(([ext]) => `**/*${ext}`),
    commands: { typecheck: null, test: null, coverage: null },
    /**
     * What the pack can answer. LSP-derived facts port cleanly; syntactic
     * judgements do not, and a pack must say which it lacks rather than
     * approximate — ADR-143 Decision 7.
     */
    capabilities: {
      symbols: LSP_SERVERS[language] !== undefined,
      references: LSP_SERVERS[language] !== undefined,
      call_hierarchy: LSP_SERVERS[language] !== undefined,
      stub_heuristics: false,
    },
  });
}
