/**
 * Staged verification (`{ stages: [...] }`): an ordered, sequential,
 * fail-fast plan of independently-timed-out verification commands, added so
 * a compound acceptance lane (e.g. revoy2's own `bun run build && bun run
 * test:all && bun run gate:all`) is not forced to fit inside one opaque
 * `WorktreeVerificationCommand`'s single timeout budget. Real process
 * execution throughout (no fake command ports) -- `true`/`false`/`sleep`-
 * equivalent Node one-liners, matching this file's sibling
 * `worktree-machine-verifier.test.ts`'s style.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeMachineVerifier } from "../src/worktree-machine-verifier.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function worktree(): string { const directory = mkdtempSync(join(tmpdir(), "arbor-verifier-staged-")); directories.push(directory); return directory; }
function input(path: string) { return { campaign_id: "campaign", node_id: "node", specialist_agent: "seed", session_id: "session", worktree_path: path, final_message: "ran it", history: [] }; }

/** exit 0 immediately -- the `true` of this test suite. */
const pass = (label: string) => ({ argv: [process.execPath, "-e", "process.exit(0)"] as [string, ...string[]], network: "unrestricted" as const, display: label });
/** exit 1 immediately -- the `false` of this test suite. */
const fail = (label: string) => ({ argv: [process.execPath, "-e", "process.exit(1)"] as [string, ...string[]], network: "unrestricted" as const, display: label });
/** never exits on its own -- the `sleep` of this test suite, for proving a per-stage timeout. */
const hang = (label: string, timeout_ms: number) => ({ argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"] as [string, ...string[]], network: "unrestricted" as const, display: label, timeout_ms });

describe("WorktreeMachineVerifier — staged verification", () => {
  it("runs every stage in order and verifies with per-stage evidence for all of them", async () => {
    const verifier = new WorktreeMachineVerifier({ command: { stages: [pass("build"), pass("test"), pass("gate")] } });
    const outcome = await verifier.verifyOutcome(input(worktree()), new AbortController().signal);

    expect(outcome.outcome).toBe("verified");
    if (outcome.outcome !== "verified") return;
    expect(outcome.provenance.cmd).toBe("build && test && gate");
    expect(outcome.stage_results).toHaveLength(3);
    expect(outcome.stage_results?.map((s) => [s.display, s.outcome, s.exit])).toEqual([
      ["build", "passed", 0], ["test", "passed", 0], ["gate", "passed", 0],
    ]);
    for (const stage of outcome.stage_results ?? []) expect(stage.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("fails fast: a failing middle stage stops the plan before the next stage ever runs", async () => {
    const verifier = new WorktreeMachineVerifier({ command: { stages: [pass("build"), fail("test"), pass("gate")] } });
    const outcome = await verifier.verifyOutcome(input(worktree()), new AbortController().signal);

    expect(outcome).toMatchObject({ outcome: "failed", code: "command_exit_nonzero", exit: 1 });
    if (outcome.outcome !== "failed") return;
    // Only the attempted stages appear -- "gate" never ran.
    expect(outcome.stage_results?.map((s) => s.display)).toEqual(["build", "test"]);
    expect(outcome.stage_results).toEqual([
      expect.objectContaining({ display: "build", outcome: "passed" }),
      expect.objectContaining({ display: "test", outcome: "failed", exit: 1 }),
    ]);
  });

  it("reports {passed,total} stage progress on failure: a declared stage is one entry of the plan (ADR-185)", async () => {
    const run = async (command: NonNullable<ConstructorParameters<typeof WorktreeMachineVerifier>[0]["command"]>) =>
      new WorktreeMachineVerifier({ command }).verifyOutcome(input(worktree()), new AbortController().signal);
    // 2 of 3: the third stage fails; fail-fast leaves nothing after it.
    expect(await run({ stages: [pass("a"), pass("b"), fail("c")] })).toMatchObject({ outcome: "failed", stages: { passed: 2, total: 3 } });
    // Fail at the first of three: later stages never ran and count as not passed.
    expect(await run({ stages: [fail("a"), pass("b"), pass("c")] })).toMatchObject({ outcome: "failed", stages: { passed: 0, total: 3 } });
    // A bare command is a plan of exactly one stage, and reports without opting into stage_results.
    const bare = await run(fail("solo"));
    expect(bare).toMatchObject({ outcome: "failed", stages: { passed: 0, total: 1 } });
    expect(bare).not.toHaveProperty("stage_results");
    // A timeout is a failed stage like any other.
    expect(await run({ stages: [pass("a"), hang("b", 50)] })).toMatchObject({ outcome: "failed", code: "command_timed_out", stages: { passed: 1, total: 2 } });
  });

  it("reports no stage progress on a verified outcome", async () => {
    const outcome = await new WorktreeMachineVerifier({ command: { stages: [pass("a"), pass("b")] } }).verifyOutcome(input(worktree()), new AbortController().signal);
    expect(outcome.outcome).toBe("verified");
    expect(outcome).not.toHaveProperty("stages");
  });

  it("bounds each stage by its OWN timeout independently -- a fast first stage does not borrow budget from a slow second one, and a hung stage times out on its own budget without the whole plan being declared failed for a different reason", async () => {
    const verifier = new WorktreeMachineVerifier({
      command: { stages: [pass("fast-build"), hang("hung-test", 50)] },
    });
    const outcome = await verifier.verifyOutcome(input(worktree()), new AbortController().signal);

    expect(outcome).toMatchObject({ outcome: "failed", code: "command_timed_out" });
    if (outcome.outcome !== "failed") return;
    expect(outcome.stage_results).toEqual([
      expect.objectContaining({ display: "fast-build", outcome: "passed", timed_out: false }),
      expect.objectContaining({ display: "hung-test", outcome: "failed", timed_out: true }),
    ]);
  });

  it("keeps a bare single command's outcome byte-for-byte unstaged (no stage_results key at all)", async () => {
    const verifier = new WorktreeMachineVerifier({ command: pass("solo") });
    const outcome = await verifier.verifyOutcome(input(worktree()), new AbortController().signal);
    expect(outcome.outcome).toBe("verified");
    expect(outcome).not.toHaveProperty("stage_results");
  });

  it("derives a staged plan per node via command_for_node, same as the single-command seam", async () => {
    const verifier = new WorktreeMachineVerifier({
      command_for_node: (i) => i.node_id === "solo" ? pass("only") : { stages: [pass("a"), pass("b")] },
    });
    const staged = await verifier.verifyOutcome(input(worktree()), new AbortController().signal);
    expect(staged.outcome).toBe("verified");
    if (staged.outcome === "verified") expect(staged.stage_results).toHaveLength(2);

    const single = await verifier.verifyOutcome({ ...input(worktree()), node_id: "solo" }, new AbortController().signal);
    expect(single.outcome).toBe("verified");
    if (single.outcome === "verified") expect(single.stage_results).toBeUndefined();
  });

  it("rejects an empty stages array rather than silently treating it as nothing to verify", () => {
    expect(() => new WorktreeMachineVerifier({ command: { stages: [] } })).toThrow("non-empty");
  });

  it("rejects an empty stages array from command_for_node at verification time, not construction", async () => {
    const verifier = new WorktreeMachineVerifier({ command_for_node: () => ({ stages: [] }) });
    await expect(verifier.verifyOutcome(input(worktree()), new AbortController().signal)).rejects.toThrow("non-empty");
  });

  it("honors a configured max_timeout_ms ceiling higher than the previously-hardcoded 900_000ms default", async () => {
    // Proves options.max_timeout_ms is actually load-bearing: a per-stage
    // timeout_ms above the OLD hardcoded ceiling is accepted rather than
    // throwing, when the verifier is configured with a higher ceiling.
    const verifier = new WorktreeMachineVerifier({
      command: { stages: [pass("build")] },
      max_timeout_ms: 2_000_000,
    });
    const withHigherStage = new WorktreeMachineVerifier({
      command: { argv: pass("build").argv, network: "unrestricted", timeout_ms: 1_000_000 },
      max_timeout_ms: 2_000_000,
    });
    const outcome = await withHigherStage.verifyOutcome(input(worktree()), new AbortController().signal);
    expect(outcome.outcome).toBe("verified");
    void verifier; // constructed only to prove staged commands accept the same option
  });

  it("still rejects a per-stage timeout_ms above the configured ceiling, at verification time", async () => {
    const verifier = new WorktreeMachineVerifier({
      command: { argv: pass("build").argv, network: "unrestricted", timeout_ms: 5_000_000 },
      max_timeout_ms: 1_000_000,
    });
    await expect(verifier.verifyOutcome(input(worktree()), new AbortController().signal)).rejects.toThrow("verification timeout_ms");
  });
});
