/**
 * Y-1 (ADR-066, lineage-scoped diff union): `lineage_paths_for_node`'s union
 * with the current diff, at the real `WorktreeMachineVerifier`. Mirrors
 * `scope-enforcement-adversarial.test.ts`'s fixture style exactly, adding
 * only the new seam under test.
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
function worktree(): string { const directory = mkdtempSync(join(tmpdir(), "arbor-scope-lineage-")); directories.push(directory); return directory; }
function input(path: string) { return { campaign_id: "campaign", node_id: "node", specialist_agent: "seed", session_id: "session", worktree_path: path, final_message: "done", history: [] }; }

const fixedPort: MachineVerificationCommandPort = { async run() { return { kind: "exited", exit: 0, stdout: Buffer.from("out"), stderr: Buffer.alloc(0) }; } };

describe("WorktreeMachineVerifier — Y-1 lineage_paths_for_node union", () => {
  it("absent lineage_paths_for_node is byte-identical to pre-Y-1 behavior", async () => {
    const directory = worktree();
    const scope: DeclaredWriteScope = { paths: ["lib/decorator.js"], enforcement: "audit" };
    const verifier = new WorktreeMachineVerifier({
      command: { argv: ["verify"], network: "unrestricted" }, command_port: fixedPort,
      write_scope_for_node: () => scope, git_status_for_scope: () => " M lib/decorator.js\n",
    });
    const outcome = await verifier.verifyOutcome(input(directory), new AbortController().signal);
    expect(outcome).toMatchObject({ outcome: "verified" });
    if (outcome.outcome === "verified") expect(outcome.out_of_scope_observation).toBeUndefined();
  });

  it("unions lineage paths with the current diff -- a lineage path outside the declared scope flags even though the CURRENT node never touched it", async () => {
    const directory = worktree();
    const scope: DeclaredWriteScope = { paths: ["lib/b.js"], enforcement: "audit" };
    const verifier = new WorktreeMachineVerifier({
      command: { argv: ["verify"], network: "unrestricted" }, command_port: fixedPort,
      write_scope_for_node: () => scope, git_status_for_scope: () => " M lib/b.js\n", // current node's own diff is entirely in-scope
      lineage_paths_for_node: () => ["lib/a.js"], // an ancestor's already-written path, outside THIS node's declared scope
    });
    const outcome = await verifier.verifyOutcome(input(directory), new AbortController().signal);
    expect(outcome).toMatchObject({
      outcome: "verified",
      out_of_scope_observation: { declared: ["lib/b.js"], observed_out_of_scope: ["lib/a.js"], enforcement: "audit" },
    });
  });

  it("a split-write lineage smuggling attempt -- authored/block tier -- fails closed via the union, even with an innocuous current diff", async () => {
    const directory = worktree();
    const scope: DeclaredWriteScope = { paths: ["lib/b.js"], enforcement: "block" };
    const verifier = new WorktreeMachineVerifier({
      command: { argv: ["verify"], network: "unrestricted" }, command_port: fixedPort,
      write_scope_for_node: () => scope, git_status_for_scope: () => " M lib/b.js\n",
      lineage_paths_for_node: () => ["lib/a.js"],
    });
    const outcome = await verifier.verifyOutcome(input(directory), new AbortController().signal);
    expect(outcome).toEqual({
      outcome: "failed",
      code: "write_scope_violation",
      out_of_scope_observation: { declared: ["lib/b.js"], observed_out_of_scope: ["lib/a.js"], enforcement: "blocked" },
    });
  });

  it("a lineage path already covered by the declared scope contributes nothing", async () => {
    const directory = worktree();
    const scope: DeclaredWriteScope = { paths: ["lib/a.js", "lib/b.js"], enforcement: "audit" };
    const verifier = new WorktreeMachineVerifier({
      command: { argv: ["verify"], network: "unrestricted" }, command_port: fixedPort,
      write_scope_for_node: () => scope, git_status_for_scope: () => " M lib/b.js\n",
      lineage_paths_for_node: () => ["lib/a.js"],
    });
    const outcome = await verifier.verifyOutcome(input(directory), new AbortController().signal);
    expect(outcome).toMatchObject({ outcome: "verified" });
    if (outcome.outcome === "verified") expect(outcome.out_of_scope_observation).toBeUndefined();
  });

  it("no declared scope at all: lineage_paths_for_node never invents enforcement on its own", async () => {
    const directory = worktree();
    const verifier = new WorktreeMachineVerifier({
      command: { argv: ["verify"], network: "unrestricted" }, command_port: fixedPort,
      write_scope_for_node: () => null, git_status_for_scope: () => " M lib/anything.js\n",
      lineage_paths_for_node: () => ["lib/a.js"],
    });
    const outcome = await verifier.verifyOutcome(input(directory), new AbortController().signal);
    expect(outcome).toEqual({
      outcome: "verified",
      message: expect.any(String),
      provenance: expect.any(Object),
      command_argv: ["verify"],
      // The verifier's sanitized output tail is review evidence for the critic.
      output_tail: "out",
    });
  });

  it("the status query failing (no diff to bind) also skips the lineage union, exactly like pre-Y-1 best-effort degrade", async () => {
    const directory = worktree();
    const scope: DeclaredWriteScope = { paths: ["lib/b.js"], enforcement: "block" };
    const verifier = new WorktreeMachineVerifier({
      command: { argv: ["verify"], network: "unrestricted" }, command_port: fixedPort,
      write_scope_for_node: () => scope, git_status_for_scope: () => null,
      lineage_paths_for_node: () => ["lib/a.js"],
    });
    const outcome = await verifier.verifyOutcome(input(directory), new AbortController().signal);
    expect(outcome).toMatchObject({ outcome: "verified" });
    if (outcome.outcome === "verified") expect(outcome.out_of_scope_observation).toBeUndefined();
  });
});
