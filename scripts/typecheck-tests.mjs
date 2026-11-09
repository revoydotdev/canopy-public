#!/usr/bin/env node
/**
 * scripts/typecheck-tests.mjs — G-23 test type-check gate.
 *
 * Usage:
 *   bun scripts/typecheck-tests.mjs          # human-readable report, exits non-zero on error
 *   bun scripts/typecheck-tests.mjs --json   # machine-readable report on stdout
 *   bun run gate:typecheck-tests             # wired via package.json, blocking
 *
 * Why this exists
 * ----------------
 * Every `packages/*\/tsconfig.json` sets `exclude: ["tests/**"]`, so `bun run
 * build` (the whole-repo `tsc --build`, ROADMAP.md's G-19 note on why that is
 * THE typecheck) never type-checks a single test file, and vitest transpiles
 * with esbuild rather than checking types. G-23 (ROADMAP.md Verified gap
 * register) found this let `arbor-opencode/tests/loop.test.ts` carry a class
 * extending the wrong base shape and a wrong-arity constructor call, both
 * passing at runtime, undetected. Wave 1 rewrote roughly 50 fixtures against
 * new type invariants (Phase 6.4's anti-stub types) validated only by
 * runtime behavior, so the compile-time guarantee 6.4 exists to provide
 * never reached the tests that exercise it.
 *
 * What it does
 * ------------
 * For every `packages/<pkg>/tsconfig.tests.json` (a sibling to that
 * package's `tsconfig.json`, scoped to this gate — see the file itself for
 * why it is a separate config rather than editing the build config), runs
 * `tsc -p <config> --noEmit` and aggregates the diagnostics. A package
 * without a `tsconfig.tests.json` FAILS THE GATE (it used to be silently
 * skipped, which let a new package ship entirely unchecked while the gate
 * still reported PASS — see the fail-closed block below).
 *
 * Why a separate tsconfig.tests.json per package, not one edit to the
 * existing tsconfig.json
 * ------------------------------------------------------------------
 * The existing `packages/*\/tsconfig.json` is `composite: true` with
 * `declaration: true` — it is the config `tsc --build` uses to emit
 * `dist/`. Simply dropping its `tests/**` exclude would pull test files into
 * the declaration build, either emitting `.d.ts` files for test fixtures
 * into `dist/` (polluting the published package shape) or erroring outright
 * (composite projects require every input file to be part of the emitted
 * output set). `tsconfig.tests.json` extends the same root config, includes
 * both `src/**` and `tests/**`, and sets `noEmit: true` with
 * `composite: false` — a type-check-only view with zero emit surface, wired
 * into its own gate rather than into `bun run build`.
 *
 * Status: BLOCKING. The full backlog this gate found on its first run (103
 * errors across 9 of the 10 packages — see the wave dispatch report for the
 * itemized list) was triaged and fixed entirely inside `packages/*\/tests/**`
 * before this gate landed; none of it required a `packages/*\/src/**` change
 * (a handful of findings that pointed at a genuine src-level seam gap were
 * reported instead of silently patched around — see the same report). No
 * type was weakened to reach green.
 *
 * Conservative bias (stated explicitly; D4b, §24.2 P8) — FAIL-CLOSED, same
 * direction as docs-truth.mjs and reachability.mjs's ambiguous-resolution
 * case: a package with no `tsconfig.tests.json` FAILS rather than being
 * skipped ("it used to be silently skipped, which let a new package ship
 * entirely unchecked while the gate still reported PASS" — above). Absence
 * of the expected config is treated as a violation, not as "nothing to
 * check here" — the missing-config case is exactly the shape that let
 * `arbor-opencode/tests/loop.test.ts` ship type-unsound before this gate
 * existed, so this gate refuses to reproduce it by silently skipping the
 * next new package the same way.
 *
 * `--root` and the profile seam (Roadmap 23 B2, ADR-073's named follow-up).
 * The convention this gate checks — "every immediate subdirectory of a
 * source root that carries its own `tsconfig.tests.json`" — is not specific
 * to a `packages/` layout; it generalizes cleanly to
 * `profileOrDefaults(root).source_roots`, so packages are now collected
 * across every declared source root rather than a hardcoded `packages/`
 * literal (this repo's own profile declares exactly one, `["packages"]`, so
 * the default invocation is byte-for-byte the prior behavior).
 * `tscBin`/`cwd` resolve from `root` too: a sibling project's own installed
 * `tsc` is the one that should type-check its own tests, not this repo's.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { profileOrDefaults } from "./lib/project-profile.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, "..");
const JSON_OUTPUT = process.argv.includes("--json");

/** Same contract as scripts/project-conform.mjs's `resolveRootArg`. */
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

let ROOT;
try {
  ROOT = resolveRootArg(process.argv.slice(2));
} catch (error) {
  console.error(`typecheck-tests: ${error.message}`);
  process.exit(2);
}

const SOURCE_ROOTS = profileOrDefaults(ROOT).source_roots;

/** `{ sourceRoot, name }` for every immediate subdirectory of every declared
 * source root, sorted for determinism (source root, then package name). */
const packages = SOURCE_ROOTS.flatMap((sourceRoot) => {
  const dir = join(ROOT, sourceRoot);
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return []; // a declared source root that does not exist has nothing to check here
  }
  return names
    .filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .map((name) => ({ sourceRoot, name }));
}).sort((a, b) => (a.sourceRoot === b.sourceRoot ? a.name.localeCompare(b.name) : a.sourceRoot.localeCompare(b.sourceRoot)));

const tscBin = join(ROOT, "node_modules", ".bin", "tsc");

const results = [];
if (packages.length === 0) {
  results.push({
    package: "<source-root-census>",
    config: SOURCE_ROOTS.join(", ") || "<none>",
    ok: false,
    errors: [
      `source-root census is empty — none of the declared source roots (${SOURCE_ROOTS.join(", ") || "<none>"}) contained a package to type-check. `
      + "Refuse to report PASS for an empty test-typechecking subject.",
    ],
  });
}
for (const { sourceRoot, name } of packages) {
  // Bare package name, matching prior output exactly for revoy2's single
  // declared source root ("packages") — parity with pre-migration output,
  // not just with the implicit-vs-explicit --root invocations of this file.
  const pkg = name;
  const configPath = join(ROOT, sourceRoot, name, "tsconfig.tests.json");
  try {
    statSync(configPath);
  } catch {
    // FAIL CLOSED. This used to `continue`, silently skipping the package — so a
    // new workspace member got zero test typechecking while the gate still
    // printed PASS. That is the Unwitnessed-claim shape inside the gate built to
    // prevent it, and it happened: `packages/arbor-governance` was added and
    // silently unchecked until the omission was noticed by hand. A missing
    // config is now a build failure, not an absence.
    results.push({
      package: pkg,
      config: relative(ROOT, configPath).replace(/\\/g, "/"),
      ok: false,
      errors: [
        `${relative(ROOT, configPath).replace(/\\/g, "/")}(1,1): error TS0000: missing tsconfig.tests.json — `
        + `every package under ${sourceRoot}/ must have one or its tests are never typechecked. `
        + `Copy the shape from packages/arbor-core/tsconfig.tests.json.`,
      ],
    });
    continue;
  }

  const relConfig = relative(ROOT, configPath).replace(/\\/g, "/");
  let stdout = "";
  let ok = true;
  try {
    stdout = execFileSync(tscBin, ["-p", relConfig, "--noEmit"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    ok = false;
    stdout = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    // A failed spawn frequently has no compiler-shaped TS diagnostic at all
    // (for example a worktree without node_modules/.bin/tsc).  Preserve that
    // failure as a gate diagnostic instead of later mistaking an empty output
    // for zero compiler errors.
    if (!/ error TS\d+:/.test(stdout)) {
      const detail = err instanceof Error ? err.message : String(err);
      stdout += `\n${relConfig}(1,1): error TS0000: could not invoke TypeScript compiler at ${relative(ROOT, tscBin).replace(/\\/g, "/")}: ${detail}`;
    }
  }

  const errors = stdout
    .split("\n")
    .filter((line) => / error TS\d+:/.test(line));

  results.push({ package: pkg, config: relConfig, ok: ok && errors.length === 0, errors });
}

export function typecheckResultsPass(typecheckResults) {
  return typecheckResults.length > 0 && typecheckResults.every((result) => result.ok && result.errors.length === 0);
}

const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0);
const failingPackages = results.filter((r) => !r.ok);

if (JSON_OUTPUT) {
  console.log(JSON.stringify({ blocking: true, totalErrors, results }, null, 2));
} else {
  console.log(`typecheck-tests gate (G-23) — BLOCKING — ${results.length} package(s) checked\n`);
  for (const r of results) {
    if (r.errors.length === 0) {
      console.log(`  PASS  ${r.package}`);
    } else {
      console.log(`  FAIL  ${r.package} (${r.errors.length} error(s))`);
      for (const line of r.errors) console.log(`          ${line.trim()}`);
    }
  }
  console.log("");
  console.log(
    totalErrors === 0
      ? `PASS — 0 type errors across ${results.length} package(s)' tests/`
      : `FAIL — ${totalErrors} type error(s) across ${failingPackages.length} package(s). See ROADMAP.md G-23.`,
  );
}

process.exitCode = typecheckResultsPass(results) ? 0 : 1;
