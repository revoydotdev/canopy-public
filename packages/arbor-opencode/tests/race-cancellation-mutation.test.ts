/**
 * Y-1 (BLINDSPOT-MANIFEST class 1, "cancellation × mutation"): loop-level
 * interaction test. `race.ts` forks a second attempt into a second
 * isolated worktree and aborts the LOSING attempt's own `AbortController`
 * once a winner is decided (ADR-067). This suite proves that abort
 * propagation is real end-to-end: a specialist attempt that is in the
 * middle of a mutate/verify/restore cycle over a REAL file in its worktree
 * (the exact shape `mutation-probe.ts`'s per-mutant loop and
 * `test-amplifier.ts`'s per-site loop both use) leaves that file
 * byte-identical and its generated-test litter cleaned up when `race.ts`
 * cancels it as the loser -- driven through the real `AbortController`
 * `race.ts` constructs and aborts, not a mocked callback.
 *
 * `arbor-opencode` may not import `arbor-mcp` (dependency direction is
 * forbidden the other way — see `sibling-scan.ts`'s doc comment), so the
 * fake `LoopExecutor.specialize()` here structurally mirrors
 * `probeMutations`'s write/await/finally-restore shape inline rather than
 * calling the real module; the point under test is that `race.ts`'s abort
 * actually reaches an in-flight specialist attempt and does so before that
 * attempt observably completes its restore, not the mutation operators
 * themselves (those are covered directly in
 * `arbor-mcp/tests/substrate-cancellation-mutation.test.ts`).
 */
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { raceSpecialize, type RaceSpecializeInput } from "../src/race.js";
import { WorktreeManager } from "@arbor/campaign-support";
import type { LoopExecutor, SpecialistResult } from "../src/loop.js";

const usage = { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0, cache_write_input_tokens: 0, counter_source: "provider_counter" as const };

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function freshDir(prefix: string): string { const directory = mkdtempSync(join(tmpdir(), prefix)); directories.push(directory); return directory; }

const ORIGINAL_SITE_CONTENT = "if (x < 10) {\n  return true;\n}\n";
const MUTANT_SITE_CONTENT = "if (x <= 10) {\n  return true;\n}\n";

/**
 * A fake specialist attempt that mirrors `probeMutations`'s per-mutant
 * discipline exactly: write the mutant, write a disposable generated-test
 * marker file, then wait on a "verification command" that never resolves on
 * its own -- the ONLY way it settles is the incoming `AbortSignal` firing,
 * exactly like a race-aborted `command_port.run(...)` call. Restoration and
 * generated-file cleanup both live in an unconditional `finally`.
 */
function mutatingAttempt(label: string, log: { events: string[] }, onMutated?: () => void): LoopExecutor["specialize"] {
  return async (params) => {
    const siteFile = join(params.worktree_path, "site.ts");
    const generatedFile = join(params.worktree_path, ".generated-marker.test.ts");
    mkdirSync(params.worktree_path, { recursive: true });
    writeFileSync(siteFile, ORIGINAL_SITE_CONTENT, "utf-8");

    const originalContent = readFileSync(siteFile, "utf-8");
    writeFileSync(siteFile, MUTANT_SITE_CONTENT, "utf-8");
    writeFileSync(generatedFile, "test('killer', () => {});", "utf-8");
    log.events.push(`${label}:mutated`);
    onMutated?.();
    try {
      await new Promise<void>((_resolve, reject) => {
        const signal = params.signal;
        if (signal?.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        // Deliberately never resolves on its own -- forces this attempt's
        // completion to go through the real abort path, never a timer race.
      });
    } catch {
      // Command-port-shaped abort rejection -- caught here exactly like
      // both `probeMutations` and (post-fix) `amplifySiblingSites` catch it.
    } finally {
      writeFileSync(siteFile, originalContent, "utf-8");
      try { rmSync(generatedFile); } catch { /* best-effort, mirrors delete_file's disposability */ }
      log.events.push(`${label}:restored`);
    }

    return {
      output: label,
      provenance: { tag: "claimed", claimant: params.specialist_agent },
      token_usage: usage,
      deferred_verification: undefined,
    } satisfies SpecialistResult;
  };
}

/** Verifies immediately -- used for the WINNING attempt so the race resolves without any timer. */
function verifyingAttempt(label: string): LoopExecutor["specialize"] {
  return async (params) => ({
    output: label,
    provenance: { tag: "claimed", claimant: params.specialist_agent },
    token_usage: usage,
    deferred_verification: Promise.resolve({ provenance: { tag: "verified" as const, cmd: "test", exit: 0, stdout_hash: "sha256:x" } }),
  });
}

/**
 * Dispatches immediately (so it never blocks the fork threshold from
 * elapsing) but its `deferred_verification` only settles once the caller
 * explicitly resolves the returned gate -- deterministic sequencing without
 * any wall-clock assumption about "verifies after N ms".
 */
function gatedVerifyingAttempt(label: string): { specialize: LoopExecutor["specialize"]; resolveVerified: () => void } {
  let resolveVerified!: () => void;
  const gate = new Promise<SpecialistResult["deferred_verification"] extends Promise<infer T> | undefined ? T : never>((resolve) => {
    resolveVerified = () => resolve({ provenance: { tag: "verified" as const, cmd: "test", exit: 0, stdout_hash: "sha256:x" } });
  });
  return {
    resolveVerified,
    specialize: async (params) => ({
      output: label,
      provenance: { tag: "claimed", claimant: params.specialist_agent },
      token_usage: usage,
      deferred_verification: gate,
    }),
  };
}

describe("raceSpecialize — a real AbortController cancellation reaches an in-flight mutate/restore attempt", () => {
  it("the LOSING primary attempt's worktree file is restored byte-identically, and its generated marker is gone, once race.ts aborts it", async () => {
    const repoRoot = freshDir("arbor-race-repo-");
    const primaryPath = freshDir("arbor-race-primary-");
    const log = { events: [] as string[] };

    const executor: LoopExecutor = {
      // Attempt 1 (primary) is the loser here: it hangs on its "verification
      // command" until aborted. Attempt 2 (fork) verifies immediately.
      specialize: (params) => (params.worktree_path === primaryPath
        ? mutatingAttempt("primary", log)(params)
        : verifyingAttempt("fork")(params)),
      async review() { throw new Error("not used"); },
    };

    const worktrees = new WorktreeManager({ repoRoot }, true);
    const input: RaceSpecializeInput = {
      executor,
      baseParams: {
        campaign_id: "camp1",
        node_id: "n1",
        action: { description: "do it", estimated_gain: 10, estimated_cost: 1, category: "refactor", delegate_to: "seed" },
        prompt: "do the thing",
        specialist_agent: "seed",
      } as RaceSpecializeInput["baseParams"],
      primaryWorktreePath: primaryPath,
      worktrees,
      campaign_id: "camp1",
      node_id: "n1",
      specialist_agent: "seed",
      forkThresholdMs: 5,
    };

    const result = await raceSpecialize(input);

    expect(result.outcome?.telemetry.winner).toBe("fork");
    expect(result.outcome?.telemetry.cancelled).toBe(true);
    expect(log.events).toContain("primary:mutated");
    expect(log.events).toContain("primary:restored");

    // The invariant Y-1 exists to prove: the loser's worktree file is
    // byte-identical to the original once the race concludes, and its
    // disposable generated-test marker did not survive the abort.
    expect(readFileSync(join(primaryPath, "site.ts"), "utf-8")).toBe(ORIGINAL_SITE_CONTENT);
    expect(existsSync(join(primaryPath, ".generated-marker.test.ts"))).toBe(false);
  }, 10_000);

  it("the LOSING fork attempt's worktree file is restored byte-identically when the primary wins instead", async () => {
    const repoRoot = freshDir("arbor-race-repo-");
    const primaryPath = freshDir("arbor-race-primary-");
    const log = { events: [] as string[] };
    let forkPath: string | null = null;

    // Primary dispatches immediately but its verification stays PENDING
    // until this test explicitly resolves it -- only once the fork attempt
    // has actually started mutating its own file. This proves the fork
    // really did dispatch and begin work (never skipped), while keeping the
    // eventual "primary wins" outcome deterministic rather than a timing
    // race against the fork threshold.
    const primary = gatedVerifyingAttempt("primary");

    const executor: LoopExecutor = {
      specialize: (params) => {
        if (params.worktree_path === primaryPath) return primary.specialize(params);
        forkPath = params.worktree_path;
        return mutatingAttempt("fork", log, () => primary.resolveVerified())(params);
      },
      async review() { throw new Error("not used"); },
    };

    const worktrees = new WorktreeManager({ repoRoot }, true);
    const input: RaceSpecializeInput = {
      executor,
      baseParams: {
        campaign_id: "camp1",
        node_id: "n2",
        action: { description: "do it", estimated_gain: 10, estimated_cost: 1, category: "refactor", delegate_to: "seed" },
        prompt: "do the thing",
        specialist_agent: "seed",
      } as RaceSpecializeInput["baseParams"],
      primaryWorktreePath: primaryPath,
      worktrees,
      campaign_id: "camp1",
      node_id: "n2",
      specialist_agent: "seed",
      // Primary's own verification is gated (see above), so it cannot
      // resolve before the threshold no matter its value; this only bounds
      // how long the fork waits to be dispatched.
      forkThresholdMs: 5,
    };

    const result = await raceSpecialize(input);

    // Primary verified before the fork's own verification could ever land
    // (it never resolves on its own), so primary wins and the fork is the
    // cancelled loser.
    expect(result.outcome?.telemetry.winner).toBe("primary");
    expect(result.outcome?.telemetry.cancelled).toBe(true);
    expect(forkPath).not.toBeNull();
    expect(log.events).toContain("fork:mutated");
    expect(log.events).toContain("fork:restored");
    expect(readFileSync(join(forkPath!, "site.ts"), "utf-8")).toBe(ORIGINAL_SITE_CONTENT);
    expect(existsSync(join(forkPath!, ".generated-marker.test.ts"))).toBe(false);
  }, 10_000);
});
