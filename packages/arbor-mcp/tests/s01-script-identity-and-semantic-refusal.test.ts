import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvedPackageScriptIdentity } from "../src/verification-script-vacuity.js";
import { WorktreeMachineVerifier, type MachineVerificationCommandPort, type SpecialistWorktreeVerificationInput } from "../src/worktree-machine-verifier.js";

// S01 (audit/2026-09-06-remediation/manifest.md): "Keep the original API
// result disqualified as functional acceptance evidence... bind original
// acceptance obligations and actual script identity... The literal guard is
// incomplete by design and does not establish semantic correctness."
//
// This file drives the REAL WorktreeMachineVerifier surface end to end
// (verifyOutcome), never internals. It proves two separate things:
//   1. the acceptance evidence a verified result carries is now bound to the
//      content of the script that actually ran (obligation closed here);
//   2. a claimed success message never substitutes for that evidence -- see
//      the "UNPROVEN BY DESIGN" case below, which PREVIOUSLY pinned exactly
//      this gap (a `node -e "process.exit(0)"` package script earning
//      `verified`) as demonstrated-but-unclosed. S13
//      (`verification-script-vacuity.ts`'s `vacuousInlineCheckReason`) closes
//      this specific demonstration: a package script that resolves to a bare
//      inline interpreter invocation (`-e`/`-c`/`--eval`) touching nothing
//      that could be evidence about the repository is now refused, the same
//      `verification_vacuous` code the literal-noop guard already used, with
//      a diagnostic naming the missing relationship. The case name and
//      comment are kept (not deleted) so the history of what was proven and
//      when stays legible; the residual, still-NOT-closed scope is recorded
//      in `s13-semantic-relationship-guard.test.ts`.

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function worktreeWithScripts(scripts: Record<string, string>): string {
  const path = mkdtempSync(join(tmpdir(), "revoy-s01-"));
  dirs.push(path);
  writeFileSync(join(path, "package.json"), JSON.stringify({ scripts }));
  return path;
}

function input(worktree_path: string, final_message: string): SpecialistWorktreeVerificationInput {
  return { campaign_id: "campaign", node_id: "node", specialist_agent: "seed", session_id: "session", worktree_path, final_message, history: [] };
}

function sha256(text: string): string { return createHash("sha256").update(text, "utf8").digest("hex"); }

const passingPort: MachineVerificationCommandPort = {
  async run() { return { kind: "exited", exit: 0, stdout: Buffer.from("ok"), stderr: Buffer.alloc(0) }; },
};

describe("S01: acceptance is bound to the actual script identity that ran", () => {
  it("resolvedPackageScriptIdentity hashes the exact resolved script body, not the script name", () => {
    const directory = worktreeWithScripts({ test: "bun test --run" });
    const identity = resolvedPackageScriptIdentity(["bun", "run", "test"], directory);
    expect(identity).toEqual({ script_name: "test", sha256: sha256("bun test --run") });
  });

  it("records the resolved script identity on the stage result and binds it into the persisted acceptance label", async () => {
    const directory = worktreeWithScripts({ test: "bun test --run" });
    const verifier = new WorktreeMachineVerifier({ command: { stages: [{ argv: ["bun", "run", "test"], network: "unrestricted" }] }, command_port: passingPort });

    const outcome = await verifier.verifyOutcome(input(directory, "I ran the tests"), new AbortController().signal);

    expect(outcome.outcome).toBe("verified");
    if (outcome.outcome !== "verified") throw new Error("unreachable");
    const expectedHash = sha256("bun test --run");
    expect(outcome.stage_results).toEqual([
      expect.objectContaining({ script_identity: { script_name: "test", sha256: expectedHash } }),
    ]);
    // The bound identity travels inside `provenance.cmd` -- the exact field
    // critic, memory and UI projections read as acceptance evidence -- so a
    // consumer of the persisted record can see which script content earned
    // this result without re-reading the worktree.
    expect(outcome.provenance.cmd).toContain(expectedHash.slice(0, 16));
    expect(outcome.message).toContain(expectedHash.slice(0, 16));
  });

  it("a later edit to the script changes the bound identity on the next run -- a stale record cannot be mistaken for the current script", async () => {
    const directory = worktreeWithScripts({ test: "bun test --run" });
    const verifier = new WorktreeMachineVerifier({ command: { argv: ["bun", "run", "test"], network: "unrestricted" }, command_port: passingPort });
    const first = await verifier.verify(input(directory, "done"), new AbortController().signal);
    expect(first?.provenance.cmd).toContain(sha256("bun test --run").slice(0, 16));

    writeFileSync(join(directory, "package.json"), JSON.stringify({ scripts: { test: "bun test --run --coverage" } }));
    const second = await verifier.verify(input(directory, "done"), new AbortController().signal);

    expect(second?.provenance.cmd).toContain(sha256("bun test --run --coverage").slice(0, 16));
    expect(second?.provenance.cmd).not.toEqual(first?.provenance.cmd);
  });

  it("two nodes whose package.json names the same script differently cannot share one acceptance label -- no cross-node inheritance", async () => {
    const nodeA = worktreeWithScripts({ test: "bun test --run" });
    const nodeB = worktreeWithScripts({ test: "node -e \"process.exit(0)\"" });
    const verifier = new WorktreeMachineVerifier({ command: { argv: ["bun", "run", "test"], network: "unrestricted" }, command_port: passingPort });

    const resultA = await verifier.verify(input(nodeA, "done"), new AbortController().signal);
    const resultB = await verifier.verify(input(nodeB, "done"), new AbortController().signal);

    expect(resultA?.provenance.cmd).not.toEqual(resultB?.provenance.cmd);
  });
});

describe("S01: a claimed result never authorizes verified adoption on its own", () => {
  it("refuses verified provenance for a recognized-vacuous script regardless of how confident the final message is", async () => {
    const directory = worktreeWithScripts({ check: "echo 'All acceptance criteria satisfied'" });
    let commandRan = false;
    const port: MachineVerificationCommandPort = { async run() { commandRan = true; return { kind: "exited", exit: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; } };
    const verifier = new WorktreeMachineVerifier({ command: { argv: ["bun", "run", "check"], network: "unrestricted" }, command_port: port });

    const outcome = await verifier.verifyOutcome(
      input(directory, "All tests pass, the feature is complete and fully verified end to end."),
      new AbortController().signal,
    );

    // Assert WHY, not just that it failed: the specific vacuity guard fired,
    // not an unrelated argv/schema/timeout rejection, and the command that
    // would have laundered a fabricated exit code never even ran.
    expect(outcome).toMatchObject({ outcome: "failed", code: "verification_vacuous" });
    expect(commandRan).toBe(false);
  });

  it("PREVIOUSLY UNPROVEN, NOW CLOSED: a package script that resolves to a bare inline-interpreter no-op no longer earns `verified`", async () => {
    // `process.exit(0)` is not in the closed literal-noop grammar
    // (`isLiteralNoopScript`), so `hasVacuousPackageScript` alone returns
    // false. This test used to assert the command was dispatched anyway and
    // earned `verified` -- exactly the manifest's "The literal guard is
    // incomplete by design and does not establish semantic correctness."
    // `vacuousInlineCheckReason` (S13, `verification-script-vacuity.ts`)
    // closes this specific demonstration: `node -e "process.exit(0)"` is an
    // inline interpreter invocation that references no declared write path
    // and touches no filesystem/module primitive, so it is refused before
    // dispatch with the SAME `verification_vacuous` code the literal-noop
    // guard already used -- see `s13-semantic-relationship-guard.test.ts`
    // for the specific-reason assertions and the still-open residual scope.
    const directory = worktreeWithScripts({ check: "node -e \"process.exit(0)\"" });
    let commandRan = false;
    const port: MachineVerificationCommandPort = { async run() { commandRan = true; return { kind: "exited", exit: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; } };
    const verifier = new WorktreeMachineVerifier({ command: { argv: ["bun", "run", "check"], network: "unrestricted" }, command_port: port });

    const outcome = await verifier.verifyOutcome(input(directory, "Everything is fully verified."), new AbortController().signal);

    expect(outcome).toMatchObject({ outcome: "failed", code: "verification_vacuous" });
    expect(commandRan).toBe(false);
  });
});
