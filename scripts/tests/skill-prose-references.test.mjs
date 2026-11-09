import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fix 3, part 2: gate the prose. `.claude/skills/revoy2-visual-intelligence/SKILL.md`
 * used to tell readers to run three scripts that no longer exist
 * (`baseline.mjs`, `extract-intent.mjs`, `extract-exceptions.mjs`) — a skill
 * whose entire doctrine is "prose drifts, derive instead" carrying an
 * unexecutable pipeline in its own prose. This scans that file, plus the
 * vendored `repository-visual-intelligence` skill's markdown, for the same
 * class of dangling reference and fails loudly if one resolves to nothing.
 *
 * DELIBERATELY CONSERVATIVE. A false failure on prose (flagging a reference
 * that is actually fine) is worse than a miss, so this only matches four
 * narrow, unambiguous forms — a repo-relative `scripts/<name>.(mjs|ts)` path,
 * the `$S/<name>` / `$VI/<name>` shorthand this skill's own Pipeline section
 * uses, and a `bun run <name>` / `npm run <name>` invocation — and skips
 * anything that looks like an illustrative placeholder (`<...>` or `NNN`).
 * Bare filenames mentioned in prose without a path (e.g. "vi-render.mjs
 * implements four views") are NOT matched: they read as naming a tool, not
 * asserting a resolvable path, and matching them would make ordinary prose
 * about the parent skill's own file layout fail this gate.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGE_SCRIPTS = new Set(
  Object.keys(JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")).scripts ?? {}),
);

/** The parent skill's own scripts dir — the fixed meaning of `$VI` everywhere it appears. */
const VI_SCRIPTS_DIR = ".claude/skills/repository-visual-intelligence/scripts";

function walkMarkdown(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir).sort()) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walkMarkdown(abs, acc);
    else if (entry.endsWith(".md")) acc.push(abs);
  }
  return acc;
}

/** The topmost `.claude/skills/<name>` directory a file lives under, or REPO_ROOT if none. */
function skillDirOf(absFile) {
  const rel = absFile.slice(REPO_ROOT.length + 1);
  const m = rel.match(/^\.claude\/skills\/([^/]+)\//);
  return m ? join(REPO_ROOT, ".claude/skills", m[1]) : REPO_ROOT;
}

function isPlaceholder(token) {
  return token.includes("<") || /\bNNN\b/.test(token);
}

/** Every referenced script path or `run` script name found in one file's text. */
function findReferences(text) {
  const refs = [];

  for (const m of text.matchAll(/(?:[\w.-]+\/)*scripts\/[\w./-]+\.(?:mjs|ts)/g)) {
    if (!isPlaceholder(m[0])) refs.push({ kind: "path", token: m[0] });
  }
  for (const m of text.matchAll(/\$(?:S|VI)\/[\w.-]+/g)) {
    if (!isPlaceholder(m[0])) refs.push({ kind: "var-path", token: m[0] });
  }
  for (const m of text.matchAll(/\b(?:bun|npm) run ([a-zA-Z0-9:_-]+)/g)) {
    if (!isPlaceholder(m[1])) refs.push({ kind: "run-script", token: m[1] });
  }
  return refs;
}

function resolves(ref, absFile) {
  const skillDir = skillDirOf(absFile);
  if (ref.kind === "path") {
    return existsSync(join(REPO_ROOT, ref.token)) || existsSync(join(skillDir, ref.token));
  }
  if (ref.kind === "var-path") {
    const rest = ref.token.slice(ref.token.indexOf("/") + 1);
    const base = ref.token.startsWith("$VI/") ? join(REPO_ROOT, VI_SCRIPTS_DIR) : join(skillDir, "scripts");
    return existsSync(join(base, rest));
  }
  // run-script
  return PACKAGE_SCRIPTS.has(ref.token);
}

const TARGET_FILES = [
  join(REPO_ROOT, ".claude/skills/revoy2-visual-intelligence/SKILL.md"),
  ...walkMarkdown(join(REPO_ROOT, ".claude/skills/repository-visual-intelligence")),
];

/**
 * Scripts that once existed and were absorbed (into vi-emit/vi-refresh) —
 * citing one as runnable is the exact drift that motivated this gate, and
 * bare-name mentions of them slipped past the four path-shaped patterns
 * above (five `baseline.mjs` citations survived the first prose repair).
 * A tombstone is zero-false-positive where general bare-name resolution is
 * not: prose legitimately discusses deleted files as stale-example warnings.
 * When a script is absorbed, add its name here in the same change.
 */
const TOMBSTONED_SCRIPTS = ["baseline.mjs", "extract-intent.mjs", "extract-exceptions.mjs"];

describe("skill prose references resolve to real files/scripts", () => {
  it("scanned at least the revoy2-visual-intelligence and vendored skill docs", () => {
    expect(TARGET_FILES.length).toBeGreaterThan(5);
  });

  for (const file of TARGET_FILES) {
    const rel = file.slice(REPO_ROOT.length + 1);
    it(`${rel} — every scripts/$S//$VI/run-script reference resolves`, () => {
      const text = readFileSync(file, "utf-8");
      const refs = findReferences(text);
      const dangling = refs.filter((r) => !resolves(r, file));
      expect(
        dangling,
        `dangling reference(s) in ${rel}:\n` +
          dangling.map((r) => `  [${r.kind}] ${r.token}`).join("\n"),
      ).toEqual([]);
    });

    it(`${rel} — no absorbed (tombstoned) script is cited as live`, () => {
      // A mention explaining that the script WAS retired is provenance, not
      // drift — exempt lines carrying retirement language. Everything else
      // reads as citing a runnable tool that no longer exists.
      const retirementContext = /retired|absorbed|gone|replaced|no longer|used to be|deleted/i;
      const lines = readFileSync(file, "utf-8").split("\n");
      const cited = [];
      for (const [i, line] of lines.entries()) {
        if (retirementContext.test(line)) continue;
        for (const name of TOMBSTONED_SCRIPTS) {
          if (line.includes(name)) cited.push(`line ${i + 1}: ${name}`);
        }
      }
      expect(
        cited,
        `${rel} cites absorbed script(s) as live: ${cited.join("; ")} — ` +
          "point the prose at bun run vi:refresh / bun scripts/vi-emit.ts instead",
      ).toEqual([]);
    });
  }
});
