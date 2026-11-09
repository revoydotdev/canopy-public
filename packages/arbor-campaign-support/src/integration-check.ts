/**
 * Governed by ADR-023: worktree isolation plus the ledger bound blast radius,
 * so a release must never destroy work the target does not already contain.
 *
 * arbor-campaign-support/integration-check — is branch/commit B's content
 * already present in target T?
 *
 * Clean-room reimplementation of worktrunk's data-safety "integration
 * ladder" concept: prefer the failing/conservative answer, branch on git's
 * exit codes and plumbing output (never parse human-readable messages), and
 * treat every unresolved case as "not integrated" so a caller deciding
 * whether to destroy B's worktree never mistakes "I couldn't prove it's
 * safe" for "it's safe". This file is written from the rung DESCRIPTIONS
 * only (see `worktree.ts`'s `releaseLease`/`reclaimOrphan` callers) — no
 * code from any other project was read or copied to produce it.
 *
 * Rungs, weakest to strongest proof, each one tried only if the previous one
 * did not already prove integration:
 *
 *   1. `same_commit`         — B and T are literally the same commit.
 *   2. `ancestor`             — B is a fast-forward ancestor of T
 *                               (`merge-base --is-ancestor`).
 *   3. `no_added_changes`     — B introduced no content beyond its merge-base
 *                               with T (three-dot `T...B` is empty).
 *   4. `trees_match`          — B's tree and T's tree are byte-identical,
 *                               regardless of commit history (handles a
 *                               plain rebase/reset that reproduces the same
 *                               content under a different commit id).
 *   5. `merge_adds_nothing`   — merging T and B produces T's own tree, i.e.
 *                               T already has everything B has (handles a
 *                               squash-merge where T later advanced on files
 *                               B never touched).
 *   6. `patch_id_match`       — B's whole diff from the merge-base has the
 *                               same `git patch-id --stable` as some commit
 *                               already on T's first-parent line since the
 *                               merge-base (handles a squash-merge where T
 *                               re-applied B's exact change as one commit).
 *
 * If none of these hold, the result is `not_integrated`. Any git failure
 * that isn't one of the rungs' own documented exit codes — a spawn error, a
 * timeout, an unparseable ref — makes the whole result `unknown`. Callers
 * MUST treat `unknown` the same as `not_integrated` (fail closed): this
 * module only ever proves integration, never disproves it.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { sanitizedGitEnv } from "./worktree.js";

/** The rung that proved B's content is already present in T. */
export type IntegrationRung =
  | "same_commit"
  | "ancestor"
  | "no_added_changes"
  | "trees_match"
  | "merge_adds_nothing"
  | "patch_id_match";

/**
 * The overall classification (`integrated`'s specific rung, `not_integrated`,
 * or `unknown`) — useful on its own for audit trails, distinct from the
 * discriminated `IntegrationCheckResult` a caller branches on.
 */
export type IntegrationClassification = IntegrationRung | "not_integrated" | "unknown";

export type IntegrationCheckResult =
  | { status: "integrated"; rung: IntegrationRung; detail: string }
  | { status: "not_integrated"; detail: string }
  | { status: "unknown"; detail: string };

export interface IntegrationCheckInput {
  /** Directory to run every git command in. Must be able to resolve both `branch` and `target`. */
  cwd: string;
  /** The commit/ref (B) being checked for integration. */
  branch: string;
  /** The commit/ref (T) B is checked against. Defaults to `HEAD` resolved in `cwd`. */
  target?: string;
  /** Per-invocation ceiling for every git subprocess. */
  gitTimeoutMs?: number;
  /**
   * Bound on how far back T's first-parent history is walked for
   * `patch_id_match`, since that history can be arbitrarily long. A real
   * squash-merge of B's content lands within a handful of commits of the
   * merge-base; 200 is generous headroom without risking an unbounded walk
   * on a large, old repository.
   */
  patchIdWalkCap?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_PATCH_ID_WALK_CAP = 200;
/** Git 2.38 (2022-10) added `git merge-tree --write-tree`; older git only has the legacy stdout-only mode. */
const MERGE_TREE_WRITE_TREE_MIN_VERSION: [number, number] = [2, 38];

function integrated(rung: IntegrationRung, detail: string): IntegrationCheckResult {
  return { status: "integrated", rung, detail };
}
function unknown(detail: string): IntegrationCheckResult {
  return { status: "unknown", detail };
}
function notIntegrated(detail: string): IntegrationCheckResult {
  return { status: "not_integrated", detail };
}

interface GitOutcome {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(cwd: string, args: string[], timeoutMs: number, input?: string): GitOutcome {
  let result: SpawnSyncReturns<string>;
  try {
    result = spawnSync("git", args, {
      cwd,
      stdio: "pipe",
      encoding: "utf-8",
      env: sanitizedGitEnv(),
      timeout: timeoutMs,
      input,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return { ok: false, status: null, stdout: "", stderr: "" };
  }
  if (result.error) return { ok: false, status: result.status, stdout: "", stderr: String(result.error) };
  return { ok: true, status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function resolveCommit(cwd: string, ref: string, timeoutMs: number): string | null {
  const res = run(cwd, ["rev-parse", "--verify", `${ref}^{commit}`], timeoutMs);
  if (!res.ok || res.status !== 0) return null;
  const sha = res.stdout.trim();
  return sha.length > 0 ? sha : null;
}

function resolveTree(cwd: string, commit: string, timeoutMs: number): string | null {
  const res = run(cwd, ["rev-parse", "--verify", `${commit}^{tree}`], timeoutMs);
  if (!res.ok || res.status !== 0) return null;
  const tree = res.stdout.trim();
  return tree.length > 0 ? tree : null;
}

/** `merge-base T B` (order does not matter for a plain merge-base). null = no common ancestor. undefined = failure. */
function mergeBase(cwd: string, a: string, b: string, timeoutMs: number): string | null | undefined {
  const res = run(cwd, ["merge-base", a, b], timeoutMs);
  if (!res.ok) return undefined;
  if (res.status === 0) {
    const sha = res.stdout.trim();
    return sha.length > 0 ? sha : undefined;
  }
  if (res.status === 1) return null; // no common ancestor — a real, non-error outcome
  return undefined;
}

function gitSupportsMergeTreeWriteTree(cwd: string, timeoutMs: number): boolean {
  const res = run(cwd, ["--version"], timeoutMs);
  if (!res.ok || res.status !== 0) return false;
  const match = /git version (\d+)\.(\d+)/.exec(res.stdout);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const [minMajor, minMinor] = MERGE_TREE_WRITE_TREE_MIN_VERSION;
  return major > minMajor || (major === minMajor && minor >= minMinor);
}

/**
 * Classify whether `input.branch`'s content is already present in
 * `input.target` (default: `HEAD` resolved in `input.cwd`). See the module
 * doc comment for the rung ladder and the fail-closed contract.
 */
export function checkIntegration(input: IntegrationCheckInput): IntegrationCheckResult {
  const timeoutMs = input.gitTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cap = input.patchIdWalkCap ?? DEFAULT_PATCH_ID_WALK_CAP;
  const { cwd } = input;

  const bSha = resolveCommit(cwd, input.branch, timeoutMs);
  if (bSha === null) return unknown(`could not resolve branch/commit "${input.branch}" in ${cwd}`);
  const tSha = resolveCommit(cwd, input.target ?? "HEAD", timeoutMs);
  if (tSha === null) return unknown(`could not resolve target "${input.target ?? "HEAD"}" in ${cwd}`);

  // 1. same_commit
  if (bSha === tSha) return integrated("same_commit", `${bSha} is exactly the target commit`);

  // 2. ancestor (fast-forward)
  const ancestorCheck = run(cwd, ["merge-base", "--is-ancestor", bSha, tSha], timeoutMs);
  if (!ancestorCheck.ok) return unknown(`git merge-base --is-ancestor could not be run: ${ancestorCheck.stderr}`);
  if (ancestorCheck.status === 0) return integrated("ancestor", `${bSha} is a fast-forward ancestor of ${tSha}`);
  if (ancestorCheck.status !== 1) {
    return unknown(`git merge-base --is-ancestor exited ${ancestorCheck.status}: ${ancestorCheck.stderr}`);
  }

  // Shared setup for the two rungs that need a merge-base of T and B. `null`
  // (no common ancestor) means those two rungs simply do not apply; that is
  // not a failure, so evaluation continues down the ladder.
  const base = mergeBase(cwd, tSha, bSha, timeoutMs);
  if (base === undefined) return unknown("git merge-base T B could not be computed");

  // 3. no_added_changes: three-dot `T...B` (== two-dot `base..B`) is empty.
  if (base !== null) {
    const diffTree = run(cwd, ["diff-tree", "--quiet", base, bSha], timeoutMs);
    if (!diffTree.ok) return unknown(`git diff-tree could not be run: ${diffTree.stderr}`);
    if (diffTree.status === 0) {
      return integrated("no_added_changes", `B added no content beyond its merge-base ${base} with T`);
    }
    if (diffTree.status !== 1) return unknown(`git diff-tree --quiet exited ${diffTree.status}: ${diffTree.stderr}`);
  }

  // 4. trees_match: identical content regardless of history.
  const bTree = resolveTree(cwd, bSha, timeoutMs);
  const tTree = resolveTree(cwd, tSha, timeoutMs);
  if (bTree === null || tTree === null) return unknown("could not resolve B's or T's tree object");
  if (bTree === tTree) return integrated("trees_match", `B's tree ${bTree} is byte-identical to T's tree`);

  // 5. merge_adds_nothing: a hypothetical merge of T and B produces T's own
  // tree (T already has everything B has, possibly under a squash-merge
  // where T advanced on other files after absorbing B).
  if (gitSupportsMergeTreeWriteTree(cwd, timeoutMs)) {
    const merge = run(cwd, ["merge-tree", "--write-tree", tSha, bSha], timeoutMs);
    if (merge.ok && merge.status === 0) {
      const resultTree = merge.stdout.trim().split(/\s+/)[0];
      if (resultTree && resultTree === tTree) {
        return integrated("merge_adds_nothing", `merging B into T yields T's own tree ${tTree} unchanged`);
      }
      // Merge succeeded but changed T's tree — B genuinely adds content; not this rung.
    } else if (merge.ok && merge.status !== 1) {
      // 0 = clean merge, 1 = conflicts (a legitimate "no" for this rung).
      // Anything else is a real git failure.
      return unknown(`git merge-tree --write-tree exited ${merge.status}: ${merge.stderr}`);
    } else if (!merge.ok) {
      return unknown("git merge-tree --write-tree could not be run");
    }
  }

  // 6. patch_id_match: B's whole diff from the merge-base matches some
  // commit's patch-id already on T's first-parent line since the merge-base
  // (a squash-merge that re-applied B's exact change as one commit).
  if (base !== null) {
    const bDiff = run(cwd, ["diff", base, bSha], timeoutMs);
    if (!bDiff.ok || bDiff.status !== 0) return unknown(`git diff base..B could not be computed: ${bDiff.stderr}`);
    if (bDiff.stdout.trim().length > 0) {
      const bPatchId = run(cwd, ["patch-id", "--stable"], timeoutMs, bDiff.stdout);
      if (!bPatchId.ok || bPatchId.status !== 0) return unknown("git patch-id could not be run on B's diff");
      const bId = bPatchId.stdout.trim().split(/\s+/)[0];
      if (bId) {
        const history = run(
          cwd,
          ["log", "--first-parent", "-p", `--max-count=${cap}`, `${base}..${tSha}`],
          timeoutMs,
        );
        if (!history.ok || history.status !== 0) return unknown(`git log --first-parent -p T's history could not be computed: ${history.stderr}`);
        if (history.stdout.trim().length > 0) {
          const tPatchIds = run(cwd, ["patch-id", "--stable"], timeoutMs, history.stdout);
          if (!tPatchIds.ok || tPatchIds.status !== 0) return unknown("git patch-id could not be run on T's history");
          for (const line of tPatchIds.stdout.split("\n")) {
            const [id, commit] = line.trim().split(/\s+/);
            if (id && id === bId) {
              return integrated(
                "patch_id_match",
                `B's diff from merge-base ${base} matches the patch-id of ${commit ?? "a commit"} on T within the last ${cap} first-parent commits`,
              );
            }
          }
        }
      }
    }
  }

  return notIntegrated(`no rung proved ${bSha} is already present in ${tSha}`);
}
