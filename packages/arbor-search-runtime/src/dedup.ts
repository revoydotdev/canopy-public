// arbor-search-runtime/dedup — transposition: identical attempts are one candidate.
// Governing records: ADR-186 (search policy core and the @arbor/search-runtime package), ADR-185 (reward is measured and provenance-typed).
//
// An attempt's digest is the `git write-tree` OID of its worktree index after
// its changes are staged. Two attempts at one step with the same digest made
// the same patch, so the second one is not verified or reviewed again: it is
// reported as a LINK to the first (`duplicate_of`), carrying only its own
// attempt id and its own generation cost. The core excludes linked attempts
// from every posterior tally, and the first attempt's `!verified` provenance
// stays with the first attempt. Digests are exact: no whitespace or line-ending
// normalisation, so a whitespace-only difference is a distinct candidate.
//
// The git call lives behind `AttemptDigestPort`; this module never shells out
// except in `createGitTreeDigestPort`, the one real implementation.

import { execFile } from "node:child_process";
import type { SearchRewardInput } from "@arbor/core";
import type { SearchAttemptDispatcher, SearchAttemptRequest } from "./driver.js";

/** Computes the content digest of an attempt's worktree. Implemented over git by `createGitTreeDigestPort`. */
export interface AttemptDigestPort {
  digest(worktreePath: string): Promise<string>;
}

/** What an attempt left behind before it was verified. */
export interface ProducedAttempt {
  readonly worktree_path: string;
  /** Provider-measured cost of producing the attempt (generation only). */
  readonly cost_usd: number;
}

/** The two phases of an attempt, split so the digest can gate the expensive second phase. */
export interface TwoPhaseAttemptRunner {
  produce(request: SearchAttemptRequest): Promise<ProducedAttempt>;
  /** Verify/review the produced attempt. `cost_usd` of the result must be the attempt's TOTAL cost (production included). */
  verify(request: SearchAttemptRequest, produced: ProducedAttempt): Promise<SearchRewardInput>;
}

interface Original {
  readonly attempt_id: string;
  readonly outcome: Promise<SearchRewardInput>;
}

/**
 * Wrap a two-phase runner as a dispatcher that verifies each distinct tree once
 * per step. Registry state is per step id, so unrelated steps never transpose.
 */
export function createDedupingDispatcher(input: {
  readonly runner: TwoPhaseAttemptRunner;
  readonly digests: AttemptDigestPort;
}): SearchAttemptDispatcher {
  const seen = new Map<string, Original>();
  return {
    async dispatch(request) {
      const produced = await input.runner.produce(request);
      const digest = await input.digests.digest(produced.worktree_path);
      const key = `${request.step_id}\u0000${digest}`;
      const original = seen.get(key);
      if (original === undefined) {
        const outcome = input.runner.verify(request, produced);
        seen.set(key, { attempt_id: request.attempt_id, outcome });
        try {
          return await outcome;
        } catch (error) {
          // A failed verification is no outcome to link to: let a retry verify afresh.
          seen.delete(key);
          throw error;
        }
      }
      const first = await original.outcome;
      return {
        attempt_id: request.attempt_id,
        reward: first.reward,
        verification: null,
        cost_usd: produced.cost_usd,
        duplicate_of: { attempt_id: original.attempt_id, digest },
      };
    },
  };
}

export interface GitTreeDigestOptions {
  /** Pathspecs (relative to the worktree) left out of staging, e.g. operational directories. Tracked files there keep their HEAD content in the index. */
  readonly exclude?: readonly string[];
  readonly timeoutMs?: number;
}

function git(cwd: string, args: readonly string[], timeoutMs: number): Promise<string> {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    // An inherited GIT_DIR / GIT_INDEX_FILE would aim these calls at the wrong repository.
    if (!name.startsWith("GIT_")) env[name] = value;
  }
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { env, timeout: timeoutMs, encoding: "utf-8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr.trim() || error.message}`));
      else resolve(stdout.trim());
    });
  });
}

/** The real port: stage everything (`git add -A`), then `git write-tree`. Byte-exact; the OID is the digest. */
export function createGitTreeDigestPort(options: GitTreeDigestOptions = {}): AttemptDigestPort {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const exclude = (options.exclude ?? []).map((path) => `:(exclude)${path}`);
  return {
    async digest(worktreePath) {
      await git(worktreePath, ["add", "-A", "--", ".", ...exclude], timeoutMs);
      const oid = await git(worktreePath, ["write-tree"], timeoutMs);
      if (!/^[0-9a-f]{40,64}$/.test(oid)) throw new Error(`git write-tree returned a non-OID: ${oid}`);
      return oid;
    },
  };
}
