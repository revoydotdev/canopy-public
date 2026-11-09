import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";

/** Recognizes only a closed, literal subset. False means unknown, not meaningful. */
export function isLiteralNoopScript(script: string): boolean {
  const parts = script.trim().split(/\s*(?:&&|;|\r?\n)\s*/u);
  return parts.length > 0 && parts.every((part) =>
    /^(?:true|:|(?:bun|node|npm|pnpm|yarn)\s+(?:--version|-v))$/u.test(part)
    || /^echo(?:\s+(?:'[^'\r\n]*'|"[^"$`\\\r\n]*"|[A-Za-z0-9_ .:!/-]+))?$/u.test(part));
}

/**
 * Resolves the exact `scripts[name]` text a `<pm> run <name>` argv is about
 * to execute, reading the same bounded, symlink-resolved `package.json` as
 * `hasVacuousPackageScript`. Returns `null` when the argv is not a bare
 * package-manager run invocation, or `package.json` cannot be read or does
 * not declare that script -- unknown identity is never fabricated.
 */
export function resolvePackageScript(argv: readonly string[], cwd: string): { readonly name: string; readonly script: string } | null {
  if (argv.length !== 3 || !["bun", "npm", "pnpm", "yarn"].includes(basename(argv[0] ?? "")) || argv[1] !== "run") return null;
  try {
    const root = realpathSync(cwd);
    const path = realpathSync(join(root, "package.json"));
    if (!path.startsWith(`${root}${sep}`) || statSync(path).size > 256 * 1024) return null;
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null || !("scripts" in value)
      || typeof value.scripts !== "object" || value.scripts === null) return null;
    const scripts = value.scripts as Record<string, unknown>;
    const name = argv[2]!;
    const script = scripts[name];
    return typeof script === "string" ? { name, script } : null;
  } catch { return null; }
}

/** Read-only preflight for exact package-manager run argv, not a shell evaluator. */
export function hasVacuousPackageScript(argv: readonly string[], cwd: string): boolean {
  if (argv.length !== 3 || !["bun", "npm", "pnpm", "yarn"].includes(basename(argv[0] ?? "")) || argv[1] !== "run") return false;
  try {
    const root = realpathSync(cwd);
    const path = realpathSync(join(root, "package.json"));
    if (!path.startsWith(`${root}${sep}`) || statSync(path).size > 256 * 1024) return false;
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null || !("scripts" in value)
      || typeof value.scripts !== "object" || value.scripts === null) return false;
    const scripts = value.scripts as Record<string, unknown>;
    const name = argv[2]!;
    // Lifecycle hooks may perform substantive checks; don't classify them by
    // inspecting only the wrapper. Likewise unsupported syntax stays unknown.
    if ([scripts[`pre${name}`], scripts[`post${name}`]].some((hook) => typeof hook === "string" && hook.trim().length > 0)) return false;
    return typeof scripts[name] === "string" && isLiteralNoopScript(scripts[name]);
  } catch { return false; }
}

/**
 * S01 (P0 verification integrity): the acceptance obligation a `verified`
 * provenance carries must be bound to the identity of the SCRIPT that
 * actually ran, not merely the command NAME. `bun run test` names a script;
 * it does not name its content. Without this, a result earned against one
 * `scripts.test` body could be presented as evidence for a differently
 * edited (or entirely different node's) `scripts.test` sharing the same
 * name, and editing the script after the fact would leave no trace on the
 * provenance the command produced. Returns `null` for anything other than a
 * resolvable bare package-manager run invocation -- ordinary argv (e.g. a
 * direct `bun test` or `node script.js`) already carries its own identity in
 * `command_argv` and needs no separate binding here.
 */
export function resolvedPackageScriptIdentity(argv: readonly string[], cwd: string): { readonly script_name: string; readonly sha256: string } | null {
  const resolved = resolvePackageScript(argv, cwd);
  return resolved === null ? null : { script_name: resolved.name, sha256: createHash("sha256").update(resolved.script, "utf8").digest("hex") };
}

/**
 * S13 (manifest S01 residual): "The literal guard is incomplete by design and
 * does not establish semantic correctness." `isLiteralNoopScript` recognizes
 * only a fixed grammar of trivially-inert commands (`true`, `:`, `echo`, a
 * version query); `node -e "process.exit(0)"` falls outside it, genuinely
 * runs, genuinely exits zero, and proves nothing. It is not a shell script at
 * all -- it is arbitrary inline code handed directly to an interpreter's
 * `-e`/`-c`/`--eval` flag, so it can never be judged by shell-grammar
 * matching. What CAN be judged, in a closed and bounded way, is whether that
 * inline code has any defensible relationship to the repository it claims to
 * verify:
 *   - When the caller supplies this node's declared write paths, the code
 *     (or the surrounding command line, for paths passed as trailing argv)
 *     must reference at least one of them -- the concrete "did it exercise a
 *     declared write path?" signal from the manifest.
 *   - Absent any declared scope, the code must at least touch the
 *     filesystem, a relative module, or spawn a subprocess -- the weakest
 *     possible "this touches the repository, not just the language runtime"
 *     bar.
 * A command that is NOT an inline interpreter invocation (a real test
 * runner, build tool, or script file) is untouched by this function --
 * `vacuousInlineCheckReason` returns `null` for it immediately, so a
 * legitimate `bun test`, `vitest run`, or `npm run build` is never at risk of
 * over-refusal from this guard.
 *
 * Scope, deliberately matching `hasVacuousPackageScript`/
 * `resolvedPackageScriptIdentity`: this only inspects a bare `<pm> run
 * <name>` argv's RESOLVED SCRIPT TEXT, never a direct argv the composition
 * itself constructed. The composition's own argv (e.g. `cli.ts`'s
 * dependency-free declared-outputs check, or any of this module's own
 * plumbing tests) is immutable, harness-authored input -- not something a
 * specialist can rewrite by editing `package.json` -- so it carries none of
 * the risk this guard exists to catch and must never be second-guessed by
 * it. `package.json` inside the admitted worktree, by contrast, is exactly
 * what a specialist can rewrite before its own "verification" runs.
 */
const INLINE_SHELL_INVOCATION = /^(?:node|bun|python3?|ruby)\s+(?:-e|-c|--eval)\s+(.+)$/su;
/**
 * Closed allowlist of primitives that could only matter if the code touches
 * something outside the language runtime itself: a relative/absolute
 * `require`/`import` of a project file (not a bare builtin/package name), an
 * explicit filesystem read/write/stat, or spawning a subprocess.
 */
const FS_TOUCH_PATTERN = new RegExp([
  String.raw`require\(\s*['"](?:\.{1,2}\/|\/)[^'"]+['"]\s*\)`,
  String.raw`from\s+['"](?:\.{1,2}\/|\/)[^'"]+['"]`,
  String.raw`require\(\s*['"](?:node:)?(?:child_process|fs|fs\/promises)['"]\s*\)`,
  String.raw`\b(?:readFileSync|writeFileSync|existsSync|statSync|lstatSync|readdirSync|accessSync|createReadStream|createWriteStream|open)\s*\(`,
  String.raw`\bexecSync\s*\(|\bspawnSync\s*\(`,
  String.raw`\bopen\s*\(\s*['"](?:\.{1,2}\/|\/)`,
].join("|"), "u");

function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Extracts the inline code from one `&&`/`;`/newline-separated shell segment of a resolved package script, or `null` if that segment is not an inline interpreter invocation. */
function extractInlineCodeFromShellSegment(segment: string): string | null {
  const match = segment.trim().match(INLINE_SHELL_INVOCATION);
  return match ? stripMatchingQuotes(match[1]!) : null;
}

function referencesDeclaredPath(haystack: string, declaredPaths: readonly string[]): boolean {
  return declaredPaths.some((path) => haystack.includes(path) || haystack.includes(basename(path)));
}

function inlineVacuityMessage(declaredPaths: readonly string[]): string {
  return declaredPaths.length > 0
    ? `Command is an inline interpreter invocation ("-e"/"-c"/"--eval") that does not reference any of this node's declared write paths (${declaredPaths.join(", ")}); it cannot establish that the declared change was exercised.`
    : "Command is an inline interpreter invocation (\"-e\"/\"-c\"/\"--eval\") that references no file, module, or filesystem primitive; it cannot establish anything about the repository's state.";
}

/** `null` when the code has a defensible relationship to the repository (see module doc); otherwise the specific reason it does not. */
function evaluateInlineCode(code: string, pathSearchText: string, declaredPaths: readonly string[]): string | null {
  if (code.trim().length === 0) return inlineVacuityMessage(declaredPaths);
  if (declaredPaths.length > 0) return referencesDeclaredPath(pathSearchText, declaredPaths) ? null : inlineVacuityMessage(declaredPaths);
  return FS_TOUCH_PATTERN.test(code) ? null : inlineVacuityMessage(declaredPaths);
}

/**
 * `null` when `argv` (or, for a bare package-manager run, the script it
 * resolves to) is not classifiable as a semantically-empty inline
 * interpreter invocation; otherwise the specific relationship that is
 * missing. `declaredPaths` should be this node's declared write scope when
 * the caller has one (see `WorktreeMachineVerifierOptions.write_scope_for_node`)
 * -- passing `[]` falls back to the weaker generic filesystem-touch bar.
 * A compound (`&&`/`;`) resolved script is classified vacuous only when
 * EVERY segment is either an already-recognized literal no-op or a
 * non-touching inline invocation -- a single substantive segment (a real
 * test runner, a script file, anything not shaped like `-e`/`-c`/`--eval`)
 * means real work may be happening and this guard stands down.
 */
export function vacuousInlineCheckReason(argv: readonly string[], cwd: string, declaredPaths: readonly string[] = []): string | null {
  const resolved = resolvePackageScript(argv, cwd);
  if (resolved === null) return null;
  const segments = resolved.script.trim().split(/\s*(?:&&|;|\r?\n)\s*/u).filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  let sawInlineInvocation = false;
  for (const segment of segments) {
    if (isLiteralNoopScript(segment)) continue;
    const code = extractInlineCodeFromShellSegment(segment);
    if (code === null) return null; // a non-trivial, non-inline segment: real work may be happening
    sawInlineInvocation = true;
    if (evaluateInlineCode(code, resolved.script, declaredPaths) === null) return null;
  }
  return sawInlineInvocation ? inlineVacuityMessage(declaredPaths) : null;
}
