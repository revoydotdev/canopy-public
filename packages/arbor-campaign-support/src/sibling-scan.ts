/**
 * arbor-opencode/sibling-scan — X-1 sibling-site completeness scan
 * (patch-overfitting #1, arXiv 1909.13694 / clone-maintenance analogs).
 *
 * Bench T2 ground truth: a specialist fixed 1 of 2 identical planted sites;
 * the declared tests passed and the critic approved anyway. This module
 * gives the loop a cheap, bounded, silently-degrading check for that shape:
 * after the specialist settles and before critic dispatch, scan the diff for
 * old-side lines the specialist modified, then check whether that exact text
 * still appears elsewhere in the tracked tree.
 *
 * This is GENERATED evidence, not verification: it never blocks, retries, or
 * asserts the remaining sites are actually bugs — it only gives the critic a
 * pointer to go look. Provenance stays honest by construction: the result is
 * a plain string appended to the critic prompt, never a claimed/verified
 * tag, never fed back into `recordResult`.
 */

import { spawnSync } from "node:child_process";

const MAX_PATTERNS = 20;
const MAX_NOTE_LOCATIONS = 5;
const MIN_PATTERN_NON_WHITESPACE_CHARS = 12;
const DEFAULT_WALL_BUDGET_MS = 2_000;

export interface SiblingScanOptions {
  /** Total wall-clock budget for the whole scan (diff + all grep calls). Defaults to 2s. Exposed for tests. */
  readonly wallBudgetMs?: number;
}

/** One remaining occurrence of a modified pattern; structurally mirrors arbor-mcp's `FlaggedSiblingSite` (dependency direction forbids importing it there from here or vice versa). */
export interface SiblingSite {
  readonly pattern: string;
  readonly file: string;
  readonly line: number;
}

/**
 * Structured scan results (ADR-066 amplifier input): the remaining
 * occurrences of old-side patterns the diff modified. Empty on nothing
 * found, non-git worktree, or exhausted budget — all degrade identically
 * and silently, per spec.
 */
export function computeSiblingSites(worktreePath: string, options: SiblingScanOptions = {}): readonly SiblingSite[] {
  try {
    const deadline = Date.now() + (options.wallBudgetMs ?? DEFAULT_WALL_BUDGET_MS);
    const diff = runGit(worktreePath, ["diff", "--unified=0"], remaining(deadline));
    if (diff === null) return [];
    const patterns = extractReplacedLinePatterns(diff);
    if (patterns.length === 0) return [];
    const sites: SiblingSite[] = [];
    for (const pattern of patterns) {
      if (Date.now() >= deadline) break;
      const grepOutput = runGitGrep(worktreePath, pattern, remaining(deadline));
      if (grepOutput === null) continue;
      for (const match of grepOutput.split("\n")) {
        if (match.trim().length === 0) continue;
        const parsed = parseLocation(match);
        if (parsed !== null) sites.push({ pattern, file: parsed.file, line: parsed.line });
      }
    }
    return sites;
  } catch {
    return [];
  }
}

/**
 * Returns a critic-prompt note when the diff modified a line pattern that
 * still occurs elsewhere in the tracked tree, or `""` when the scan finds
 * nothing, isn't applicable (non-git worktree), or the bounded budget was
 * exhausted before it could complete — all three degrade identically and
 * silently, per spec.
 */
export function computeSiblingSiteNote(worktreePath: string, options: SiblingScanOptions = {}): string {
  const sites = computeSiblingSites(worktreePath, options);
  if (sites.length === 0) return "";
  const locations: string[] = [];
  for (const site of sites) {
    const location = `${site.file}:${site.line}`;
    if (!locations.includes(location) && locations.length < MAX_NOTE_LOCATIONS) locations.push(location);
  }
  return `\n\nSibling-site scan: ${sites.length} occurrence(s) of a pattern this change modified remain unchanged at ${locations.join(", ")} — verify the fix is complete across all sites or explain why the remaining sites are out of scope.`;
}

/**
 * Y-3 (BLINDSPOT-MANIFEST class 5, applicability signal): every changed file
 * in the node's own diff, regardless of whether any sibling site was found
 * for it -- `computeSiblingSites` only returns files that HAD a remaining
 * occurrence, which is exactly the ambiguity Y-3 exists to remove (a diff
 * touching only Python files produces the same empty result as a diff that
 * genuinely has no sibling sites left). `[]` on a non-git worktree or
 * exhausted budget, same silent-degradation posture as the rest of this
 * module.
 */
export function computeDiffChangedFiles(worktreePath: string, options: SiblingScanOptions = {}): readonly string[] {
  try {
    const deadline = Date.now() + (options.wallBudgetMs ?? DEFAULT_WALL_BUDGET_MS);
    const output = runGit(worktreePath, ["diff", "--name-only"], remaining(deadline));
    if (output === null) return [];
    return [...new Set(output.split("\n").map((line) => line.trim()).filter((line) => line.length > 0))];
  } catch {
    return [];
  }
}

/**
 * Y-3: file extensions the sibling-scan/amplifier/mutation-probe advisory
 * pipeline can meaningfully analyze. `computeSiblingSites` itself is a
 * plain `git grep -F` text match and works over any language, but the two
 * analyzers downstream of it in `loop.ts` (arbor-mcp's `probeMutations`'
 * string-level mutation operators and `amplifySiblingSites`' Node/JS test
 * runner -- see each module's own `assess*Applicability`, which this
 * mirrors rather than imports per this file's established
 * dependency-direction posture) are JS/TS-shaped. A diff touching only,
 * say, `.py` files degrades the WHOLE advisory pipeline to silent nothing
 * today; this lets the loop say so explicitly instead.
 */
const ANALYZER_APPLICABLE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"]);

/** Additive alongside this module's existing string-returning functions; never a replacement for them. */
export interface AnalyzerApplicability {
  readonly applicable: boolean;
  /** Present only when `applicable` is `false` -- explains WHY, so a caller can tell "not analyzed" from "analyzed, found nothing." */
  readonly reason?: string;
}

/** Whether the JS/TS-shaped downstream analyzers (mutation probe, generated-oracle amplifier) can apply to ANY of the given changed files, purely by extension. */
export function assessAnalyzerApplicability(changedFiles: readonly string[]): AnalyzerApplicability {
  if (changedFiles.length === 0) return { applicable: false, reason: "no changed files in this node's diff to assess" };
  const extensionOf = (file: string): string => {
    const dot = file.lastIndexOf(".");
    return dot === -1 ? "" : file.slice(dot).toLowerCase();
  };
  const hasApplicableFile = changedFiles.some((file) => ANALYZER_APPLICABLE_EXTENSIONS.has(extensionOf(file)));
  if (hasApplicableFile) return { applicable: true };
  const observedExtensions = [...new Set(changedFiles.map((file) => extensionOf(file) || "(no extension)"))].sort();
  return {
    applicable: false,
    reason: `the mutation-probe and generated-oracle amplifier are JS/TS-shaped and none of the ${changedFiles.length} changed file(s) match a JS/TS extension -- observed: ${observedExtensions.join(", ")}`,
  };
}

function remaining(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

/** `null` on any non-zero exit, timeout, or spawn error — the caller treats that as "nothing usable". */
function runGit(worktreePath: string, args: readonly string[], timeoutMs: number): string | null {
  if (timeoutMs <= 0) return null;
  const result = spawnSync("git", ["-C", worktreePath, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    timeout: timeoutMs,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

/** `git grep` exits 1 (not an error) when a pattern has zero matches; only that and 0 are usable. */
function runGitGrep(worktreePath: string, pattern: string, timeoutMs: number): string | null {
  if (timeoutMs <= 0) return null;
  const result = spawnSync("git", ["-C", worktreePath, "grep", "-F", "--line-number", "-e", pattern], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    timeout: timeoutMs,
  });
  if (result.error) return null;
  if (result.status === 1) return ""; // no matches, not an error
  if (result.status !== 0) return null;
  return result.stdout;
}

/**
 * Old-side (`-`) lines from a unified diff, excluding `---` file headers,
 * trimmed, deduped, and filtered to a minimum non-whitespace length so
 * one-character noise (a stray brace, a blank line) never becomes a
 * "pattern". Bounded to `MAX_PATTERNS` entries in encounter order.
 */
function extractReplacedLinePatterns(diffOutput: string): string[] {
  const seen = new Set<string>();
  const patterns: string[] = [];
  for (const line of diffOutput.split("\n")) {
    if (patterns.length >= MAX_PATTERNS) break;
    if (!line.startsWith("-") || line.startsWith("---")) continue;
    const candidate = line.slice(1).trim();
    if (candidate.replace(/\s/g, "").length < MIN_PATTERN_NON_WHITESPACE_CHARS) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    patterns.push(candidate);
  }
  return patterns;
}

/** `git grep -n` output lines are `path:line:content`. */
function parseLocation(matchLine: string): { file: string; line: number } | null {
  const firstColon = matchLine.indexOf(":");
  if (firstColon < 0) return null;
  const secondColon = matchLine.indexOf(":", firstColon + 1);
  if (secondColon < 0) return null;
  const line = Number(matchLine.slice(firstColon + 1, secondColon));
  if (!Number.isSafeInteger(line) || line <= 0) return null;
  return { file: matchLine.slice(0, firstColon), line };
}
