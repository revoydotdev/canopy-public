/**
 * Y-3 (least-privilege #6, ToolPrivBench-style adversarial corpus):
 * end-to-end assertions of the full graduated scope-enforcement matrix
 * against the REAL `WorktreeMachineVerifier`, with injected seams only for
 * `git_status_for_scope` (fake porcelain text) and `command_port` (fake
 * process results) -- exactly the fixture style
 * `worktree-machine-verifier.test.ts` already uses for G-SCOPE and the
 * opportunistic mined-command tier. No new production code; this is a pure
 * test corpus over the Y-1/Y-2 seams and the pre-existing opportunistic/
 * non-git/untracked-addition behavior.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorktreeMachineVerifier,
  type DeclaredWriteScope,
  type MachineVerificationCommandPort,
} from "../src/worktree-machine-verifier.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function worktree(): string { const directory = mkdtempSync(join(tmpdir(), "arbor-scope-adversarial-")); directories.push(directory); return directory; }
function input(path: string) { return { campaign_id: "campaign", node_id: "node", specialist_agent: "seed", session_id: "session", worktree_path: path, final_message: "done", history: [] }; }

/** A verifier wired exactly the way cli.ts's createDeclaredOutputsVerifier wires the real one, minus the manager lookup. */
function buildVerifier(options: {
  readonly statusStdout: string | null;
  readonly scope: DeclaredWriteScope | null;
  readonly primaryExit?: number;
  readonly opportunistic?: { argv: readonly [string, ...string[]]; exit: number } | null;
  readonly commandArgv?: readonly string[];
}) {
  const calls: string[][] = [];
  const port: MachineVerificationCommandPort = {
    async run(request) {
      calls.push([...request.argv]);
      const isOpportunistic = options.opportunistic !== undefined && options.opportunistic !== null
        && request.argv[0] === options.opportunistic.argv[0];
      const exit = isOpportunistic ? options.opportunistic!.exit : options.primaryExit ?? 0;
      return { kind: "exited", exit, stdout: Buffer.from("out"), stderr: Buffer.alloc(0) };
    },
  };
  const verifier = new WorktreeMachineVerifier({
    command: { argv: (options.commandArgv ?? ["verify", "--fixed"]) as [string, ...string[]], network: "unrestricted" },
    ...(options.opportunistic ? { opportunistic_command_for_node: () => ({ argv: options.opportunistic!.argv, network: "unrestricted" as const }) } : {}),
    write_scope_for_node: () => options.scope,
    git_status_for_scope: () => options.statusStdout,
    command_port: port,
  });
  return { verifier, calls };
}

describe("scope enforcement matrix — G-SCOPE (authored, block tier)", () => {
  it("authored + clean diff -> verified", async () => {
    const directory = worktree();
    const { verifier } = buildVerifier({ statusStdout: " M lib/decorator.js\n", scope: { paths: ["lib/decorator.js"], enforcement: "block" } });
    const outcome = await verifier.verifyOutcome(input(directory), new AbortController().signal);
    expect(outcome.outcome).toBe("verified");
    if (outcome.outcome === "verified") expect(outcome.out_of_scope_observation).toBeUndefined();
  });

  it("authored + out-of-scope write -> failed, carrying a 'blocked' observation", async () => {
    const directory = worktree();
    const { verifier, calls } = buildVerifier({ statusStdout: " M lib/decorator.js\n M package.json\n", scope: { paths: ["lib/decorator.js"], enforcement: "block" } });
    const outcome = await verifier.verifyOutcome(input(directory), new AbortController().signal);
    expect(outcome).toEqual({
      outcome: "failed",
      code: "write_scope_violation",
      out_of_scope_observation: { declared: ["lib/decorator.js"], observed_out_of_scope: ["package.json"], enforcement: "blocked" },
    });
    expect(calls).toHaveLength(0); // fails fast, before any verification command runs
  });
});

describe("scope enforcement matrix — Y-1 (mined, audit tier)", () => {
  it("mined + out-of-scope write -> still verified, carrying an 'audit' observation (never blocks)", async () => {
    const directory = worktree();
    const { verifier } = buildVerifier({ statusStdout: " M test/decorator.test.js\n M lib/decorator.js\n", scope: { paths: ["test/decorator.test.js"], enforcement: "audit" } });
    const outcome = await verifier.verifyOutcome(input(directory), new AbortController().signal);
    expect(outcome).toMatchObject({
      outcome: "verified",
      out_of_scope_observation: { declared: ["test/decorator.test.js"], observed_out_of_scope: ["lib/decorator.js"], enforcement: "audit" },
    });
  });

  it("mined garbage opportunistic command never blocks -- falls back to the primary (outputs-check-shaped) verification", async () => {
    const directory = worktree();
    const { verifier, calls } = buildVerifier({
      statusStdout: " M test/decorator.test.js\n",
      scope: { paths: ["test/decorator.test.js"], enforcement: "audit" },
      opportunistic: { argv: ["garbage-mined-cmd"], exit: 127 },
      commandArgv: ["fallback", "--outputs-check"],
    });
    const outcome = await verifier.verifyOutcome(input(directory), new AbortController().signal);
    expect(outcome).toMatchObject({ outcome: "verified", provenance: { cmd: "fallback --outputs-check" } });
    expect(calls.map((argv) => argv[0])).toEqual(["garbage-mined-cmd", "fallback"]);
  });
});

describe("scope enforcement matrix — structural edge cases (Y-3)", () => {
  it("rename smuggling: both the old and new side of a git rename are checked against the declared scope", async () => {
    const directory = worktree();
    const { verifier } = buildVerifier({ statusStdout: "R  test/decorator.test.js -> lib/decorator.js\n", scope: { paths: ["test/decorator.test.js"], enforcement: "block" } });
    const outcome = await verifier.verifyOutcome(input(directory), new AbortController().signal);
    // Only the new side ("lib/decorator.js") was undeclared -- both sides
    // were checked (the old side alone matches, proving the rename's
    // components were parsed rather than treated as one opaque token).
    expect(outcome).toEqual({
      outcome: "failed",
      code: "write_scope_violation",
      out_of_scope_observation: { declared: ["test/decorator.test.js"], observed_out_of_scope: ["lib/decorator.js"], enforcement: "blocked" },
    });
  });

  it("rename smuggling: verifies when both sides of the rename are declared", async () => {
    const directory = worktree();
    const { verifier } = buildVerifier({ statusStdout: "R  test/decorator.test.js -> lib/decorator.js\n", scope: { paths: ["test/decorator.test.js", "lib/decorator.js"], enforcement: "block" } });
    const outcome = await verifier.verifyOutcome(input(directory), new AbortController().signal);
    expect(outcome.outcome).toBe("verified");
  });

  it("exempts harness-owned additions but applies the configured tier to undeclared product additions", async () => {
    const directory = worktree();
    const statusStdout = " M declared.js\n?? .arbor-session/log.jsonl\n?? new-undeclared-file.md\n";
    const blocked = await buildVerifier({ statusStdout, scope: { paths: ["declared.js"], enforcement: "block" } }).verifier.verifyOutcome(input(directory), new AbortController().signal);
    expect(blocked).toEqual({ outcome: "failed", code: "write_scope_violation", out_of_scope_observation: { declared: ["declared.js"], observed_out_of_scope: ["new-undeclared-file.md"], enforcement: "blocked" } });
    const audited = await buildVerifier({ statusStdout, scope: { paths: ["declared.js"], enforcement: "audit" } }).verifier.verifyOutcome(input(directory), new AbortController().signal);
    expect(audited).toMatchObject({ outcome: "verified", out_of_scope_observation: { declared: ["declared.js"], observed_out_of_scope: ["new-undeclared-file.md"], enforcement: "audit" } });
  });

  it("non-git worktree (no status can be taken) skips enforcement under both tiers", async () => {
    const directory = worktree();
    for (const enforcement of ["block", "audit"] as const) {
      const { verifier } = buildVerifier({ statusStdout: null, scope: { paths: ["declared.js"], enforcement } });
      const outcome = await verifier.verifyOutcome(input(directory), new AbortController().signal);
      expect(outcome.outcome).toBe("verified");
    }
  });

  it("no scope declared applies no enforcement regardless of what changed", async () => {
    const directory = worktree();
    const { verifier, calls } = buildVerifier({ statusStdout: " M anything.js\n M more.js\n", scope: null });
    const outcome = await verifier.verifyOutcome(input(directory), new AbortController().signal);
    expect(outcome.outcome).toBe("verified");
    expect(calls).toHaveLength(1); // the primary command still ran -- only the scope gate was skipped
  });
});
