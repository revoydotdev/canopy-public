#!/usr/bin/env node
/**
 * scripts/project-conform.mjs — `gate:project-conform`. Evaluates every
 * element of `scripts/lib/conformance-spec.mjs`'s `CONFORMANCE_SPEC` against
 * this repo's strictly loaded `arbor.profile.jsonc` and
 * exits non-zero if any `required` or `required_via_profile` element is
 * unmet. `optional` elements are reported but never block.
 *
 * Usage:
 *   bun scripts/project-conform.mjs          # human-readable report
 *   bun scripts/project-conform.mjs --json    # machine-readable report
 *   bun scripts/project-conform.mjs --fix     # mechanically safe repairs only
 *   bun run gate:project-conform              # wired via package.json
 *
 * `--fix` scope, deliberately narrow: it may only create a missing required
 * directory and drop a `.gitkeep` inside it. It NEVER invents file content
 * (a missing `decisions/README.md`, an unmet marker, or a missing script
 * wiring are all reported, never fabricated). Anything `--fix` cannot repair
 * is listed under "could not fix" so the run stays honest about what changed.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFORMANCE_SPEC, resolveElementTargets } from "./lib/conformance-spec.mjs";
import { DEFAULT_PROFILE, loadProjectProfile } from "./lib/project-profile.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, "..");
const JSON_OUTPUT = process.argv.includes("--json");
const FIX = process.argv.includes("--fix");

/**
 * Roadmap 23 W1. `evaluateConformance` has always taken a repo root; only
 * `main` hardcoded this checkout, so the gate could not be pointed at another
 * project even though the library underneath it was already multi-project.
 *
 * `--root <path>` (or `--root=<path>`) supplies that root explicitly. Absent
 * the flag the value is REPO_ROOT, so the default invocation is byte-identical
 * to the previous behavior — the parity that `tests/project-conform-root.test.mjs`
 * asserts rather than assumes.
 *
 * Returns an absolute path. A `--root` with no value is a usage error, not a
 * silent fall back to this repo: mis-resolving the root is exactly the failure
 * that would let a gate report green about files it never read.
 */
export function resolveRootArg(argv, fallback = REPO_ROOT) {
  const inline = argv.find((a) => a.startsWith("--root="));
  if (inline !== undefined) {
    const value = inline.slice("--root=".length);
    if (value === "") throw new Error("--root requires a path");
    return resolvePath(value);
  }
  const index = argv.indexOf("--root");
  if (index === -1) return resolvePath(fallback);
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error("--root requires a path");
  return resolvePath(value);
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function readPackageJson(repoRoot) {
  const path = join(repoRoot, "package.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function checkTarget(repoRoot, kind, target, element, packageJson) {
  const abs = join(repoRoot, target);
  switch (kind) {
    case "dir":
      return existsSync(abs) && statSync(abs).isDirectory()
        ? { ok: true }
        : { ok: false, reason: `directory "${target}" not found` };
    case "file":
      return existsSync(abs) && statSync(abs).isFile()
        ? { ok: true }
        : { ok: false, reason: `file "${target}" not found` };
    case "script":
      return packageJson?.scripts && Object.prototype.hasOwnProperty.call(packageJson.scripts, target)
        ? { ok: true }
        : { ok: false, reason: `package.json has no "${target}" script` };
    case "marker": {
      if (!existsSync(abs) || !statSync(abs).isFile()) return { ok: false, reason: `file "${target}" not found` };
      const text = readFileSync(abs, "utf-8");
      return text.includes(element.marker)
        ? { ok: true }
        : { ok: false, reason: `"${target}" does not contain the ${element.marker} marker` };
    }
    default:
      return { ok: false, reason: `unknown element kind "${kind}"` };
  }
}

/**
 * Evaluates every `CONFORMANCE_SPEC` element against `repoRoot`. Returns one
 * result per element: `{ id, kind, requirement, remedy, targets, ok,
 * failures }`. This is the single evaluation path both the CLI report below
 * and any future scaffolder should call — it is what makes the spec a real
 * single source of truth rather than just an unused data structure.
 */
export function evaluateConformance(repoRoot = REPO_ROOT) {
  let profile;
  try {
    profile = loadProjectProfile(repoRoot);
  } catch (error) {
    const issues = Array.isArray(error?.errors) && error.errors.length > 0
      ? error.errors
      : [{ path: "arbor.profile.jsonc", message: error instanceof Error ? error.message : String(error) }];
    const absentBootstrap = issues.length === 1
      && issues[0]?.path === "arbor.profile.jsonc"
      && issues[0]?.message === "file does not exist";
    if (absentBootstrap) {
      // A genuinely unprofiled repository still needs the complete default
      // conformance report so --fix can create safe directory requirements.
      // The profile-file element remains blocking. Only a present-but-invalid
      // declaration is forbidden from silently falling back to defaults.
      profile = DEFAULT_PROFILE;
    } else {
      return [{
        id: "project-profile-validity",
        kind: "file",
        requirement: "required",
        remedy: "repair arbor.profile.jsonc so it parses and satisfies the declared project-profile schema",
        targets: ["arbor.profile.jsonc"],
        ok: false,
        failures: issues.map((issue) => ({
          target: typeof issue.path === "string" && issue.path.length > 0 ? issue.path : "arbor.profile.jsonc",
          reason: typeof issue.message === "string" ? issue.message : "invalid project profile",
        })),
      }];
    }
  }
  const packageJson = readPackageJson(repoRoot);
  const results = [];
  for (const element of CONFORMANCE_SPEC) {
    const targets = resolveElementTargets(element, profile);
    if (targets.length === 0) {
      const ok = element.requirement === "optional";
      results.push({
        id: element.id,
        kind: element.kind,
        requirement: element.requirement,
        remedy: element.remedy,
        targets: [],
        ok,
        failures: ok ? [] : [{ target: null, reason: "profile does not declare a target for this element" }],
      });
      continue;
    }
    const checks = targets.map((t) => ({ target: t, ...checkTarget(repoRoot, element.kind, t, element, packageJson) }));
    const ok = checks.every((c) => c.ok);
    results.push({
      id: element.id,
      kind: element.kind,
      requirement: element.requirement,
      remedy: element.remedy,
      targets,
      ok,
      failures: checks.filter((c) => !c.ok),
    });
  }
  return results;
}

/**
 * `--fix`'s entire repair vocabulary: create a missing `dir`-kind element's
 * target directory (recursively) and drop an empty `.gitkeep` inside it.
 * Anything else — a missing file, an unmet marker, an unwired script — is
 * reported as unfixable rather than fabricated. Exported for direct testing.
 */
export function attemptFix(repoRoot, result) {
  if (result.ok) return { attempted: false };
  if (result.kind !== "dir") return { attempted: false, reason: "not mechanically fixable (would require inventing content)" };
  if (result.targets.length === 0) return { attempted: false, reason: "no target to create" };
  let fixedAny = false;
  for (const failure of result.failures) {
    if (failure.target === null) continue;
    const abs = join(repoRoot, failure.target);
    try {
      mkdirSync(abs, { recursive: true });
      writeFileSync(join(abs, ".gitkeep"), "");
      fixedAny = true;
    } catch (error) {
      return { attempted: true, ok: false, reason: error.message };
    }
  }
  return { attempted: true, ok: fixedAny };
}

function main() {
  let root;
  try {
    root = resolveRootArg(process.argv);
  } catch (error) {
    console.error(`project-conform: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  let results = evaluateConformance(root);
  const fixes = [];
  if (FIX) {
    for (const result of results) {
      if (!result.ok && result.requirement !== "optional") {
        const outcome = attemptFix(root, result);
        if (outcome.attempted) fixes.push({ id: result.id, ...outcome });
      }
    }
    if (fixes.some((f) => f.ok)) results = evaluateConformance(root);
  }

  const blocking = results.filter((r) => !r.ok && r.requirement !== "optional");
  const ok = blocking.length === 0;

  if (JSON_OUTPUT) {
    console.log(JSON.stringify({ ok, results, fixes }, null, 2));
  } else {
    console.log(`project-conform gate — ${results.length} element(s) checked, ${blocking.length} unmet required element(s)\n`);
    for (const result of results) {
      const marker = result.ok ? "OK" : result.requirement === "optional" ? "skip" : "FAIL";
      console.log(`[${marker}] ${result.id} (${result.requirement})`);
      if (!result.ok && result.requirement !== "optional") {
        for (const failure of result.failures) console.log(`    - ${failure.target ?? "(no target)"}: ${failure.reason}`);
        console.log(`    remedy: ${result.remedy}`);
      }
    }
    if (fixes.length) {
      console.log("\n--fix:");
      for (const f of fixes) console.log(`  ${f.id}: ${f.ok ? "fixed" : `could not fix (${f.reason ?? "not mechanically fixable"})`}`);
    }
    console.log("");
    console.log(ok ? "PASS" : "FAIL");
  }

  // Not process.exit(): see reachability.mjs's identical note — stdout can be
  // a pipe, and process.exit() right after a large console.log can truncate
  // the write mid-flush.
  process.exitCode = ok ? 0 : 1;
}

if (isDirectExecution()) {
  main();
}
