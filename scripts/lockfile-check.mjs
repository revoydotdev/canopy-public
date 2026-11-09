#!/usr/bin/env node
/**
 * scripts/lockfile-check.mjs — G-28 lockfile-drift gate.
 *
 * Usage:
 *   bun scripts/lockfile-check.mjs          # human-readable report, exits non-zero on drift
 *   bun scripts/lockfile-check.mjs --json    # machine-readable report on stdout
 *   bun run gate:lockfile                   # wired via package.json
 *
 * Why this exists
 * ----------------
 * A workspace lockfile entry can drift from its package manifest without an
 * ordinary install making the mismatch obvious. The committed bun.lock is the
 * source of installation truth; this gate checks it structurally rather than
 * relying on installation to reveal drift.
 *
 * Bun migration (2026-08-07) — ported from package-lock.json to bun.lock
 * ------------------------------------------------------------------------
 * The same drift class G-28 caught is still possible under Bun
 * — a workspace `package.json` can gain a dependency without anyone
 * re-running `bun install` to refresh `bun.lock` — so this gate is ported,
 * not dropped. Three real format differences from package-lock.json,
 * verified empirically against a real `bun install` run before porting:
 *
 *   1. `bun.lock` is JSONC: valid JSON plus trailing commas before a
 *      closing `}`/`]`. It has no comments in practice, so stripping
 *      trailing commas (`parseBunLock` below) is sufficient to make it
 *      standard-JSON-parseable.
 *   2. `bun.lock` never records a `license` field on any workspace entry
 *      (root or member) — confirmed absent even when the manifest declares
 *      one. There is nothing to compare it against, so it is dropped from
 *      `COMPARED_FIELDS` rather than kept and permanently flagged as drift.
 *   3. `bun.lock` never records `version` on the *root* workspace entry
 *      (key `""`) specifically — confirmed absent even though root
 *      `package.json` has `"version": "0.2.0"`. Member workspaces DO record
 *      `version`. This is root-only and handled as a special case below,
 *      not a blanket drop of the field.
 *   4. npm's `peerDependenciesMeta: { pkg: { optional: true } }` becomes
 *      Bun's `optionalPeers: ["pkg", ...]` — a different field name and
 *      shape carrying the same fact (which peers are optional). Compared
 *      via a dedicated set-equality check, not the generic field diff.
 *
 * `bin` path strings are compared as Bun records them: bun.lock preserves the
 * manifest string exactly (verified: `"./src/cli.ts"` in both).
 *
 * What it does
 * ------------
 * For the root manifest and every `packages/<dir>` workspace listed in the
 * root `workspaces` array, compares each of `name`, `version`,
 * `dependencies`, `devDependencies`, `peerDependencies`,
 * `optionalDependencies`, and `bin` between the live `package.json` and the
 * corresponding entry in `bun.lock`'s `workspaces` map (`workspaces[""]`
 * for the root, `workspaces["packages/<dir>"]` for a workspace), plus the
 * dedicated `peerDependenciesMeta` / `optionalPeers` check. Any field
 * present in one but not the other, or differing in value, is reported as
 * drift.
 *
 * This is a comparison, not a re-resolution: it does not shell out to bun
 * or touch node_modules, so it runs identically in CI and locally, and it
 * is blind to genuine third-party dependency-tree drift (that class is
 * what `bun install --frozen-lockfile`'s own integrity check already
 * catches for registry packages — see the note above for why local
 * workspace packages need this separate check).
 *
 * Conservative bias (stated explicitly; D4b, §24.2 P8) — FAIL-CLOSED by
 * construction, with no ambiguity branch to have a direction at all: this
 * is an exact, order-insensitive deep-equality comparison of plain JSON
 * fields (`deepEqual` above), so there is no "could not determine" case the
 * way an AST-resolution gate has. Any field present in one side and absent
 * from the other, or differing in value, is reported — every detected
 * difference is real drift, not a heuristic lead. This is the same
 * direction as typecheck-tests.mjs and eval-regression-gate.ts (deterministic
 * comparison gates: report every detected delta, full stop) and the
 * opposite of registration-integrity.mjs's AST-heuristic gates (which do
 * have a genuine "can't tell" case and choose silence there).
 *
 * `--root` (Roadmap 23 B2, ADR-073 follow-up) — this gate never actually
 * hardcoded a `packages/` prefix: it already derives every workspace path
 * from the root `package.json`'s own `workspaces` array, which is the
 * genuinely portable source of truth for "what workspaces exist" (a Rust
 * or Python sibling with a differently-shaped manifest would need a
 * different lockfile gate entirely, not a source-root swap). What WAS
 * hardcoded, and is fixed here, is `REPO_ROOT` itself: it was derived from
 * `__dirname/..` with no override, so this gate could only ever check the
 * checkout it lives in. `--root <path>` (or `--root=<path>`) now supplies
 * that root explicitly; absent the flag, the value is this script's own
 * `__dirname/..`, so default invocation is byte-identical to before (see
 * `scripts/tests/lockfile-check-root.test.mjs`, which proves that parity
 * and proves a fixture root's own `package.json`/`bun.lock` drive the
 * verdict).
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolvePath(__dirname, "..");

/**
 * Same contract as scripts/project-conform.mjs's `resolveRootArg`: absent
 * `--root`, returns `fallback` (a resolved default invocation, byte-for-byte
 * identical to prior behavior). A `--root` given no value is a usage error,
 * not a silent fall back to this repo — the failure Roadmap 23 §5 names.
 */
export function resolveRootArg(argv, fallback = DEFAULT_ROOT) {
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

const COMPARED_FIELDS = [
  "name",
  "version",
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "bin",
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

/** bun.lock is JSON plus trailing commas before a closing `}`/`]` — strip them, then parse as standard JSON. */
function readBunLock(path) {
  const text = readFileSync(path, "utf-8");
  const stripped = text.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped);
}

function pick(obj, fields) {
  const out = {};
  for (const field of fields) {
    if (obj[field] !== undefined) out[field] = obj[field];
  }
  return out;
}

/** Kept for defense in depth; bun.lock preserves manifest bin paths verbatim (unlike npm's package-lock.json, which strips a leading "./"). */
function normalizePathValue(value) {
  return typeof value === "string" ? value.replace(/^\.\//, "") : value;
}

/** Order-insensitive deep equality for the plain-JSON shapes package.json/bun.lock use. */
function deepEqual(a, b) {
  const na = normalizePathValue(a);
  const nb = normalizePathValue(b);
  if (na === nb) return true;
  if (typeof na !== typeof nb || na === null || nb === null) return false;
  if (typeof na !== "object") return false;
  if (Array.isArray(na) !== Array.isArray(nb)) return false;
  if (Array.isArray(na)) {
    if (na.length !== nb.length) return false;
    return na.every((v, i) => deepEqual(v, nb[i]));
  }
  const aKeys = Object.keys(na).sort();
  const bKeys = Object.keys(nb).sort();
  if (aKeys.length !== bKeys.length || !aKeys.every((k, i) => k === bKeys[i])) return false;
  return aKeys.every((k) => deepEqual(na[k], nb[k]));
}

/** Names of peers a manifest's peerDependenciesMeta marks optional — the fact bun.lock's optionalPeers array records. */
function optionalPeerNames(peerDependenciesMeta) {
  if (!peerDependenciesMeta) return [];
  return Object.keys(peerDependenciesMeta)
    .filter((name) => peerDependenciesMeta[name]?.optional === true)
    .sort();
}

/**
 * Evaluates the gate against `repoRoot` and returns `{ ok, targetsChecked,
 * violations }` — pure with respect to process state (no argv/env reads, no
 * stdout, no process.exit), so it is directly unit-testable and directly
 * reusable by `main()` below without re-deriving anything.
 */
export function evaluateLockfileDrift(repoRoot) {
  const rootPkg = readJson(join(repoRoot, "package.json"));
  const lock = readBunLock(join(repoRoot, "bun.lock"));
  const lockWorkspaces = lock.workspaces ?? {};

  const targets = [{ label: "root", pkgPath: "package.json", lockKey: "" }];
  for (const workspacePath of rootPkg.workspaces ?? []) {
    targets.push({
      label: workspacePath,
      pkgPath: join(workspacePath, "package.json"),
      lockKey: workspacePath,
    });
  }

  const violations = [];

  for (const target of targets) {
    const manifest = readJson(join(repoRoot, target.pkgPath));
    const lockEntry = lockWorkspaces[target.lockKey];
    if (lockEntry === undefined) {
      violations.push({ workspace: target.label, reason: `bun.lock has no "workspaces"["${target.lockKey}"] entry at all — run bun install to regenerate` });
      continue;
    }
    const expected = pick(manifest, COMPARED_FIELDS);
    const actual = pick(lockEntry, COMPARED_FIELDS);
    for (const field of COMPARED_FIELDS) {
      // bun.lock never records `version` on the root workspace entry (key ""),
      // even though root package.json has one — verified empirically, not a
      // drift signal. Member workspaces DO record version and are still checked.
      if (field === "version" && target.lockKey === "") continue;
      const inManifest = expected[field] !== undefined;
      const inLock = actual[field] !== undefined;
      if (!inManifest && !inLock) continue;
      if (inManifest !== inLock || !deepEqual(expected[field], actual[field])) {
        violations.push({
          workspace: target.label,
          reason: `field "${field}" differs between ${target.pkgPath} and bun.lock workspaces["${target.lockKey}"]`,
          manifest: expected[field] ?? null,
          lockfile: actual[field] ?? null,
        });
      }
    }

    // peerDependenciesMeta (manifest) <-> optionalPeers (bun.lock): same fact,
    // different shape. Compared as a sorted name set, not a generic field diff.
    const expectedOptionalPeers = optionalPeerNames(manifest.peerDependenciesMeta);
    const actualOptionalPeers = [...(lockEntry.optionalPeers ?? [])].sort();
    if (!deepEqual(expectedOptionalPeers, actualOptionalPeers)) {
      violations.push({
        workspace: target.label,
        reason: `optional peer set differs between ${target.pkgPath} (peerDependenciesMeta) and bun.lock workspaces["${target.lockKey}"] (optionalPeers)`,
        manifest: expectedOptionalPeers,
        lockfile: actualOptionalPeers,
      });
    }
  }

  return { ok: violations.length === 0, targetsChecked: targets.length, violations };
}

function main() {
  let repoRoot;
  try {
    repoRoot = resolveRootArg(process.argv.slice(2));
  } catch (error) {
    console.error(`lockfile-check: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  const jsonOutput = process.argv.includes("--json");
  const { ok, targetsChecked, violations } = evaluateLockfileDrift(repoRoot);

  if (jsonOutput) {
    console.log(JSON.stringify({ ok, targetsChecked, violations }, null, 2));
  } else {
    console.log(`lockfile-check gate — ${targetsChecked} manifest(s) checked against bun.lock\n`);
    if (violations.length) {
      console.log(`${violations.length} drift violation(s):`);
      for (const v of violations) {
        console.log(`  - ${v.workspace}: ${v.reason}`);
        if ("manifest" in v) {
          console.log(`      package.json:  ${JSON.stringify(v.manifest)}`);
          console.log(`      bun.lock:      ${JSON.stringify(v.lockfile)}`);
        }
      }
      console.log("\nRun `bun install` at the repo root to regenerate bun.lock, then commit it.");
      console.log("");
    }
    console.log(ok ? "PASS" : "FAIL");
  }

  process.exitCode = ok ? 0 : 1;
}

if (isDirectExecution()) main();
