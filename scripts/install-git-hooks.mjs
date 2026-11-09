#!/usr/bin/env node
/**
 * scripts/install-git-hooks.mjs — installs revoy2's git hooks (ADR-025, and
 * the pre-commit ADR-authority/claim-ledger checks).
 *
 * Usage:
 *   bun scripts/install-git-hooks.mjs
 *
 * What it does
 * ------------
 * Installs a stable launcher for each checked-in hook under scripts/hooks/ in
 * this checkout's real git hooks directory, resolved via `git rev-parse
 * --git-path hooks`. The launcher resolves the current worktree and executes
 * its checked-in source, so an installed hook cannot silently become a stale
 * copy after a pull. This also works from a linked worktree (which shares a
 * hooks directory with its parent unless `core.hooksPath` overrides it).
 *
 * Why pre-push exists
 * --------------------
 * ROADMAP.md's strength ladder BLOCKED tier ("the build or CI refuses to
 * merge it") is unreachable on this repo today: it is private, on GitHub's
 * free plan, and branch protection returns 403 (`gh api
 * repos/.../branches/master/protection`). See ADR-025 for the full context
 * and the two routes to real BLOCKED (public repo, or a paid org plan) —
 * neither is something this script can do. What this script CAN do is give
 * real local refusal: a `pre-push` hook that runs a clean build plus the
 * nine blocking quality/freshness gates (listed by scripts/hooks/pre-push)
 * and aborts the push on any failure.
 *
 * Honesty note, load-bearing: this is NOT the BLOCKED tier. It only protects
 * pushes made from a machine that ran this installer, and it is bypassed by
 * `git push --no-verify` (a standard git escape hatch). Both facts are
 * repeated in the hook's own runtime output and in AGENTS.md — see ADR-025's
 * "Alternatives considered" #4 for why an overstated local hook would be the
 * same defect this remediation exists to fix, one layer down.
 *
 * Why pre-commit exists
 * -----------------------
 * The claim-ledger store's producer is manual but store-freshness-gate.mjs's
 * budget enforcement is automatic, so whoever runs the suite next after a
 * commit burst pays for someone else's un-refreshed commits. `pre-commit`
 * auto-refreshes it (scripts/claim-ledger-precommit.mjs) when it is trailing
 * by more than half its budget, and is a fast no-op otherwise.
 *
 * Safety: refuses to overwrite a pre-existing hook that isn't a copy of the
 * one this installer would put there (detected via each hook's own marker
 * comment) rather than silently clobbering something a contributor set up
 * themselves.
 */

import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve as resolvePath, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, "..");

/** Each hook this installer manages: its checked-in source and its own marker comment. */
export const MANAGED_HOOKS = Object.freeze([
  { name: "pre-push", marker: "revoy2-pre-push-hook-marker" },
  { name: "pre-commit", marker: "revoy2-pre-commit-hook-marker" },
  // commit-msg is the only hook that sees the message and the staged paths
  // together, before the commit exists — the one place the ADR-trailer rule
  // can be enforced while fixing it is still free. See scripts/hooks/commit-msg.
  { name: "commit-msg", marker: "revoy2-commit-msg-hook-marker" },
]);

export function gitHooksDir(repoRoot = REPO_ROOT) {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();
    return resolvePath(REPO_ROOT, out);
  } catch (e) {
    console.error("install-git-hooks: could not resolve the git hooks directory (`git rev-parse --git-path hooks` failed).");
    console.error(String(e));
    process.exit(1);
  }
}

export function managedLauncherSource(hook) {
  return `#!/bin/sh
# revoy2 ${hook.name} managed launcher — installed by scripts/install-git-hooks.mjs.
# ${hook.marker} (used by the installer to detect its own hook)
set -eu
repo_root="$(git rev-parse --show-toplevel)" || {
  echo "revoy2 ${hook.name}: cannot resolve this checkout's work tree." >&2
  exit 1
}
hook_source="$repo_root/scripts/hooks/${hook.name}"
# This launcher is reached through a global core.hooksPath by EVERY
# repository on the workstation. A checkout without this repository's own
# hook source is not ours to gate: a seed project's first commit (EC-022),
# the liveness gate's fixture repository, any unrelated clone. Exit 0, quietly.
[ -f "$hook_source" ] || exit 0
exec /bin/sh "$hook_source" "$@"
`;
}

export function installHook(hooksDir, hook, repoRoot = REPO_ROOT) {
  const hookSource = resolvePath(repoRoot, "scripts", "hooks", hook.name);
  const target = join(hooksDir, hook.name);
  const source = readFileSync(hookSource, "utf-8");
  const launcher = managedLauncherSource(hook);

  if (!source.includes(hook.marker)) {
    console.error(`install-git-hooks: ${hookSource} is missing its own marker comment — refusing to install (source tampered or moved?).`);
    return false;
  }

  if (existsSync(target)) {
    const existing = readFileSync(target, "utf-8");
    if (!existing.includes(hook.marker)) {
      console.error(`install-git-hooks: ${target} already exists and is not a revoy2 ${hook.name} hook.`);
      console.error("Remove or back it up manually, then re-run this installer, if you want revoy2's hook installed.");
      return false;
    }
    if (existing === launcher) {
      console.log(`install-git-hooks: ${target} is already up to date.`);
      return true;
    }
  }

  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(target, launcher, { mode: 0o755 });
  chmodSync(target, 0o755);
  console.log(`install-git-hooks: installed ${hook.name} hook at ${target}`);
  return true;
}

export function installMergeDriver(repoRoot = REPO_ROOT) {
  const command = "bun scripts/lib/union-sorted-jsonl-merge.mjs %O %A %B";
  execFileSync("git", ["config", "merge.union-sorted-jsonl.name", "revoy2 canonical JSONL union"], { cwd: repoRoot });
  execFileSync("git", ["config", "merge.union-sorted-jsonl.driver", command], { cwd: repoRoot });
  console.log("install-git-hooks: configured the union-sorted-jsonl merge driver.");
}

/**
 * A launcher this installer wrote into the operator's GLOBAL core.hooksPath
 * (marker-detected; nothing else there is touched) is refreshed from the
 * same template, so the copy every repository on the workstation runs
 * cannot drift from the one this checkout runs. On 2026-09-04 the global
 * copy was five days older than the template and refused the liveness
 * gate's fixture repository with a rule the template no longer had.
 */
export function refreshGlobalLaunchers() {
  let globalDir;
  try { globalDir = execFileSync("git", ["config", "--global", "core.hooksPath"], { encoding: "utf-8" }).trim(); } catch { return []; }
  if (!globalDir) return [];
  const refreshed = [];
  for (const hook of MANAGED_HOOKS) {
    const target = join(globalDir, hook.name);
    if (!existsSync(target)) continue;
    let current = "";
    try { current = readFileSync(target, "utf-8"); } catch { continue; }
    if (!current.includes(hook.marker)) continue;
    const launcher = managedLauncherSource(hook);
    if (current === launcher) continue;
    writeFileSync(target, launcher, { mode: 0o755 });
    refreshed.push(target);
  }
  return refreshed;
}

export function installGitHooks(repoRoot = REPO_ROOT) {
  const hooksDir = gitHooksDir(repoRoot);
  let ok = true;
  for (const hook of MANAGED_HOOKS) ok = installHook(hooksDir, hook, repoRoot) && ok;
  for (const target of refreshGlobalLaunchers()) console.log(`install-git-hooks: refreshed the global launcher ${target}.`);
  if (ok) installMergeDriver(repoRoot);

  if (ok) {
    console.log("  pre-push runs on every `git push`: the declarative revision-bound profile builds and gates one candidate snapshot.");
    console.log("  Bypass with `git push --no-verify` when you deliberately need to push past a red run.");
    console.log("  This is local-only enforcement, not the ladder's BLOCKED tier — see ADR-025.");
    console.log("  pre-commit refuses bundled ADR acceptance and auto-refreshes the claim ledger when needed.");
  }
  return ok;
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(installGitHooks() ? 0 : 1);
}
