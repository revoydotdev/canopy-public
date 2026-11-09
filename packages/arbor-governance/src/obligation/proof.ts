/**
 * obligation/proof.ts — resolve one `<!-- proof: ... -->` comment against the
 * real working tree.
 *
 * Grammar reused verbatim from `scripts/docs-truth.mjs` (Phase 6.7's ROADMAP.md
 * gate — see its header comment, lines 1-120): `symbol=`, `file=`, `roundtrip=`
 * as bare `key=value` tokens inside an HTML comment. This module deliberately
 * reuses the field NAMES and the field-parsing shape (`docs-truth.mjs`'s
 * `parseProofComment`) but reimplements resolution rather than importing
 * `docs-truth.mjs` directly, for three reasons: (1) that script hard-codes
 * ROADMAP.md-specific concepts (tranche headings, the G-27 rollup rule) that do
 * not apply to an ADR's obligations; (2) it resolves `symbol=` via
 * `scripts/reachability.mjs`'s full TS-checker reachability graph, which is a
 * heavier and differently-scoped question ("is this reachable from an entry
 * point?") than what this module asks ("is this symbol actually declared or
 * exported in this file?"); (3) `scripts/*.mjs` is explicitly out of this
 * package's ownership and out of the workspace's typechecked graph (ADR-027's
 * own "Alternatives considered" #4) — this needs to be `.ts`, tested, and typed.
 * Where the underlying question is identical (does a cited path exist; does a
 * cited roundtrip file get collected), the same real-filesystem checks are
 * applied, just written directly against `node:fs` here instead of shelling
 * out to a sibling script.
 *
 * THE HONEST CEILING, stated once here because every other module in this
 * package inherits it: a resolving `roundtrip=` proves that a named test file
 * EXISTS ON DISK and IS COLLECTED by vitest's configured `include` globs. It
 * does NOT prove the test passes, and it does NOT prove the test exercises the
 * obligation it is cited against. This module never spawns vitest — checking
 * pass/fail is out of scope by design (see coverage.ts's `attests` field,
 * which encodes exactly this ceiling in the returned type rather than leaving
 * it as a comment only a maintainer might read).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, relative as relativePath, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { Confidence, EvidenceRef, GovernanceResult } from "../contracts.js";
import type { ObligationProofComment } from "./parse.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** Tool identity stamped on every EvidenceRef this module produces (no version
 * registry exists yet in this package, so "@1" is a literal schema generation
 * marker, not a semver claim). */
export const PRODUCER_ID = "arbor-governance/obligation-resolver@1";

export function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ---------------------------------------------------------------------------
// Repo root + vitest include-glob resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the repository root by walking up from this module's own location
 * (not `process.cwd()` — this package must resolve correctly regardless of
 * the caller's working directory) until a directory containing both
 * `decisions/` plus a `package.json` or `.git` is found (NOT a test-runner
 * config — see the block below). Bounded to 10 levels so a
 * moved or vendored copy of this package fails loudly instead of walking to
 * the filesystem root.
 */
export function resolveRepoRoot(startDir: string = MODULE_DIR): string {
  // startDir is injectable so the marker logic is testable against other
  // repository shapes; production callers pass nothing and get MODULE_DIR.
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    // Repo-root markers deliberately EXCLUDE any test-runner config. Requiring
    // vitest.config.ts here coupled root resolution to one runner in one
    // language, so this module threw before any glob logic ran if @arbor/
    // governance were consumed from a repo that uses jest, or vitest with a
    // .js config, or no JS at all. `decisions/` is the marker that actually
    // matters to a governance package; package.json/.git corroborate it so a
    // stray `decisions/` directory deeper in a tree cannot masquerade as root.
    if (
      existsSync(resolvePath(dir, "decisions"))
      && (existsSync(resolvePath(dir, "package.json")) || existsSync(resolvePath(dir, ".git")))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not resolve repo root by walking up from ${startDir}`);
}

/**
 * Reads vitest.config.ts's own `include` glob array — the actual source of
 * truth for "will vitest ever run this file" — rather than hard-coding the
 * two patterns known at the time this module was written. If the config's
 * shape changes, this adapts; a hard-coded pair would silently drift stale.
 */
/**
 * Config filenames vitest itself accepts, in its own resolution order. The
 * previous implementation hardcoded `vitest.config.ts`, so it threw ENOENT on a
 * genuine vitest repo whose config merely used a different extension — and
 * vitest also falls back to `vite.config.*` when no vitest config exists.
 */
export const VITEST_CONFIG_CANDIDATES: readonly string[] = [
  "vitest.config.ts", "vitest.config.mts", "vitest.config.cts",
  "vitest.config.js", "vitest.config.mjs", "vitest.config.cjs",
  "vite.config.ts", "vite.config.mts", "vite.config.cts",
  "vite.config.js", "vite.config.mjs", "vite.config.cjs",
];

export function readVitestIncludeGlobs(repoRoot: string): string[] {
  const configPath = VITEST_CONFIG_CANDIDATES
    .map((name) => resolvePath(repoRoot, name))
    .find((candidate) => existsSync(candidate));
  if (configPath === undefined) {
    // Deliberately an error, not an empty array: [] would mean "this config
    // collects nothing", which would report every roundtrip as a false proof.
    // The caller turns this throw into state:"unverifiable", which is the
    // honest answer for a repo whose runner we cannot read.
    throw new Error(
      `no vitest/vite config found under ${repoRoot} (tried ${VITEST_CONFIG_CANDIDATES.length} candidates: `
      + `${VITEST_CONFIG_CANDIDATES.join(", ")}) — test collection cannot be verified for this repository`,
    );
  }
  const text = readFileSync(configPath, "utf-8");
  const includeMatch = /include:\s*\[([^\]]*)\]/.exec(text);
  if (!includeMatch) return [];
  return [...includeMatch[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
}

/** Minimal glob-to-RegExp translation covering exactly the shapes vitest's own
 * `include` config here uses (`**`, `*`, literal path segments) — not a
 * general-purpose glob library, since a repo-relative path-matching subset is
 * all this ever needs to evaluate. */
function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++; // consume second '*'
        if (glob[i + 1] === "/") {
          pattern += "(?:.*/)?";
          i++; // consume the following '/'
        } else {
          pattern += ".*";
        }
      } else {
        pattern += "[^/]*";
      }
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      pattern += "\\" + c;
    } else {
      pattern += c;
    }
  }
  return new RegExp(`^${pattern}$`);
}

export function isCollectedByVitest(repoRelativePath: string, includeGlobs: readonly string[]): boolean {
  return includeGlobs.some((g) => globToRegExp(g).test(repoRelativePath));
}

// ---------------------------------------------------------------------------
// Symbol resolution (textual/AST-lite — see module header for why not the TS checker)
// ---------------------------------------------------------------------------

function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function directExportRegExp(name: string): RegExp {
  return new RegExp(
    `^export\\s+(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?(?:abstract\\s+)?(?:function\\*?|class|interface|type|enum|const|let|var)\\s+${escapeForRegExp(name)}\\b`,
    "m",
  );
}

const EXPORT_LIST_RE = /^export\s*\{([^}]*)\}/gm;

/**
 * Textual check for whether `name` is declared or exported in one file's
 * source text. "declared" = a direct top-level `export function/class/const/
 * .../` statement naming it. "reexported" = it appears only in an `export {
 * ... }` list (possibly `export { X as Y } from "./elsewhere"`), which proves
 * the name is exported from this file's surface without proving this file is
 * where it's actually implemented. Deliberately NOT a full TypeScript-checker
 * resolution (that would require depending on the `typescript` package from
 * this package's own `src/`, which is not a declared dependency here) — this
 * is the "defensible textual/AST-lite check" the brief calls for, and callers
 * are expected to grade confidence accordingly (see resolveProofComment).
 */
export function symbolAppearsInFile(name: string, absPath: string): "declared" | "reexported" | "absent" {
  const text = readFileSync(absPath, "utf-8");
  if (directExportRegExp(name).test(text)) return "declared";

  EXPORT_LIST_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXPORT_LIST_RE.exec(text))) {
    const items = m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const item of items) {
      const parts = item.split(/\s+as\s+/);
      const exportedName = (parts.length > 1 ? parts[1] : parts[0]).trim();
      if (exportedName === name) return "reexported";
    }
  }
  return "absent";
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);

/** Searches every `packages/*\/src/**\/*.ts` file for a declaration/export of
 * `name`, mirroring `scripts/reachability.mjs`'s own scope. Used only when a
 * proof comment omits `file=`; returns every matching file so an ambiguous
 * match can be reported honestly instead of picked arbitrarily. */
export function findSymbolAcrossRepo(name: string, repoRoot: string): string[] {
  const matches: string[] = [];
  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = resolvePath(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        if (symbolAppearsInFile(name, full) !== "absent") matches.push(relativePath(repoRoot, full));
      }
    }
  }
  const packagesDir = resolvePath(repoRoot, "packages");
  let pkgs: string[];
  try {
    pkgs = readdirSync(packagesDir);
  } catch {
    pkgs = [];
  }
  for (const pkg of pkgs) {
    const srcDir = resolvePath(packagesDir, pkg, "src");
    try {
      if (statSync(srcDir).isDirectory()) walk(srcDir);
    } catch {
      // package has no src/ — nothing to scan
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Field + comment resolution
// ---------------------------------------------------------------------------

export type FieldResolutionState = "resolved" | "missing" | "unverifiable";

export interface FieldResolution {
  field: "symbol" | "file" | "roundtrip";
  value: string | null;
  state: FieldResolutionState;
  /** How confident this resolution is. `unverifiable` results are typically
   * `low`/`medium`; a definite `missing` or `resolved` is typically `high` —
   * but `unverifiable` must NEVER be reported as `resolved` regardless of
   * confidence. Confidence grades certainty WITHIN a state, not across it. */
  confidence: Confidence;
  detail: string;
  evidence: readonly EvidenceRef[];
}

export interface ProofResolution {
  raw: string;
  symbol: FieldResolution;
  /** null when the proof comment omitted `file=` (it is an optional field in
   * the grammar) — distinct from a `file=` that was given but doesn't exist. */
  file: FieldResolution | null;
  roundtrip: FieldResolution;
  /** True iff every present field resolved. A missing optional `file=` is not
   * present, so it cannot block this; an unresolved `file=` that WAS given
   * does block it, because `symbol=`'s own resolution was conditioned on it. */
  fully_resolved: boolean;
}

export interface ResolveProofOptions {
  repoRoot?: string;
  /** ISO-8601 timestamp stamped on every EvidenceRef this resolution produces.
   * Deliberately a REQUIRED, caller-supplied value, never `new Date()` read
   * internally: resolution must be a pure function of (proof comment, repo
   * content, at) so "same input => byte-identical report" (required by this
   * package's determinism tests) is achievable. A caller wanting a live
   * timestamp supplies one explicitly; the impurity stays visible at the call
   * site instead of hiding inside this function. */
  at: string;
}

function missingField(field: FieldResolution["field"], detail: string): FieldResolution {
  return { field, value: null, state: "missing", confidence: "high", detail, evidence: [] };
}

/**
 * Resolves one already-parsed proof comment against the real working tree.
 * Never throws — any unexpected failure (a read error, an unresolvable repo
 * root) is returned as a `GovernanceResult` error.
 */
export function resolveProofComment(
  proof: ObligationProofComment,
  options: ResolveProofOptions,
): GovernanceResult<ProofResolution> {
  try {
    const repoRoot = options.repoRoot ?? resolveRepoRoot();
    const at = options.at;

    // --- file= (optional) ---
    let fileResolution: FieldResolution | null = null;
    let fileAbsPath: string | null = null;
    let fileGiven = false;
    let fileOk = true;
    if (proof.file !== undefined) {
      fileGiven = true;
      const abs = resolvePath(repoRoot, proof.file);
      if (existsSync(abs) && statSync(abs).isFile()) {
        const text = readFileSync(abs, "utf-8");
        const lineCount = text.split("\n").length;
        fileAbsPath = abs;
        fileResolution = {
          field: "file",
          value: proof.file,
          state: "resolved",
          confidence: "high",
          detail: `${proof.file} exists (${lineCount} lines)`,
          evidence: [{ kind: "code_location", ref: proof.file, producer: PRODUCER_ID, at, content_hash: hashContent(text) }],
        };
      } else {
        fileOk = false;
        fileResolution = {
          field: "file",
          value: proof.file,
          state: "missing",
          confidence: "high",
          detail: `${proof.file} does not exist under the repository root`,
          evidence: [],
        };
      }
    }

    // --- symbol= ---
    let symbolResolution: FieldResolution;
    if (!proof.symbol) {
      symbolResolution = missingField("symbol", "proof comment has no symbol= field");
    } else if (fileGiven && !fileOk) {
      symbolResolution = {
        field: "symbol",
        value: proof.symbol,
        state: "unverifiable",
        confidence: "low",
        detail: `cannot verify symbol "${proof.symbol}" because file= "${proof.file}" does not exist`,
        evidence: [],
      };
    } else if (fileGiven && fileAbsPath) {
      const kind = symbolAppearsInFile(proof.symbol, fileAbsPath);
      symbolResolution =
        kind === "absent"
          ? {
              field: "symbol",
              value: proof.symbol,
              state: "missing",
              confidence: "high",
              detail: `"${proof.symbol}" is not declared or exported in ${proof.file}`,
              evidence: [],
            }
          : {
              field: "symbol",
              value: proof.symbol,
              state: "resolved",
              confidence: kind === "declared" ? "high" : "medium",
              detail: `"${proof.symbol}" is ${kind === "declared" ? "directly declared" : "re-exported"} in ${proof.file}`,
              evidence: [{ kind: "code_location", ref: proof.file!, producer: PRODUCER_ID, at }],
            };
    } else {
      const matches = findSymbolAcrossRepo(proof.symbol, repoRoot);
      if (matches.length === 0) {
        symbolResolution = {
          field: "symbol",
          value: proof.symbol,
          state: "missing",
          confidence: "high",
          detail: `"${proof.symbol}" is not declared or exported anywhere under packages/*/src`,
          evidence: [],
        };
      } else if (matches.length > 1) {
        symbolResolution = {
          field: "symbol",
          value: proof.symbol,
          state: "unverifiable",
          confidence: "medium",
          detail: `"${proof.symbol}" is declared/exported in ${matches.length} files (${matches.join(", ")}) — disambiguate with file=`,
          evidence: [],
        };
      } else {
        symbolResolution = {
          field: "symbol",
          value: proof.symbol,
          state: "resolved",
          confidence: "medium",
          detail: `"${proof.symbol}" found in ${matches[0]} (no file= given — a repo-wide textual match, weaker than a disambiguated one)`,
          evidence: [{ kind: "code_location", ref: matches[0], producer: PRODUCER_ID, at }],
        };
      }
    }

    // --- roundtrip= ---
    let roundtripResolution: FieldResolution;
    if (!proof.roundtrip) {
      roundtripResolution = missingField("roundtrip", "proof comment has no roundtrip= field");
    } else {
      const abs = resolvePath(repoRoot, proof.roundtrip);
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        roundtripResolution = {
          field: "roundtrip",
          value: proof.roundtrip,
          state: "missing",
          confidence: "high",
          detail: `${proof.roundtrip} does not exist under the repository root`,
          evidence: [],
        };
      } else {
        let globs: string[] | null = null;
        let globError: string | null = null;
        try {
          globs = readVitestIncludeGlobs(repoRoot);
        } catch (err) {
          globError = err instanceof Error ? err.message : String(err);
        }
        if (globs === null) {
          roundtripResolution = {
            field: "roundtrip",
            value: proof.roundtrip,
            state: "unverifiable",
            confidence: "low",
            detail: `could not read/parse vitest.config.ts's include patterns: ${globError}`,
            evidence: [],
          };
        } else if (isCollectedByVitest(proof.roundtrip, globs)) {
          const text = readFileSync(abs, "utf-8");
          roundtripResolution = {
            field: "roundtrip",
            value: proof.roundtrip,
            state: "resolved",
            confidence: "high",
            detail: `${proof.roundtrip} exists and matches a vitest.config.ts include glob`,
            evidence: [{ kind: "code_location", ref: proof.roundtrip, producer: PRODUCER_ID, at, content_hash: hashContent(text) }],
          };
        } else {
          // The subtle false-proof case: the file is real, but vitest will
          // never collect it, so the "roundtrip" it names is never run —
          // a claim indistinguishable from a fabricated one until checked.
          roundtripResolution = {
            field: "roundtrip",
            value: proof.roundtrip,
            state: "missing",
            confidence: "high",
            detail: `${proof.roundtrip} exists on disk but is not matched by any vitest.config.ts include glob — a test that is never collected is a false proof`,
            evidence: [],
          };
        }
      }
    }

    const fully_resolved =
      symbolResolution.state === "resolved" &&
      roundtripResolution.state === "resolved" &&
      (fileResolution === null || fileResolution.state === "resolved");

    return {
      ok: true,
      capability: "governance.obligation.resolveProof",
      value: { raw: proof.raw, symbol: symbolResolution, file: fileResolution, roundtrip: roundtripResolution, fully_resolved },
    };
  } catch (err) {
    return {
      ok: false,
      error: { code: "internal", message: `failed to resolve proof comment: ${err instanceof Error ? err.message : String(err)}` },
      capability: "governance.obligation.resolveProof",
    };
  }
}
