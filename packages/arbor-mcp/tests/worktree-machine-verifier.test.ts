import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorktreeMachineVerifier,
  type MachineVerificationCommandPort,
  type DeclaredWriteScope,
} from "../src/worktree-machine-verifier.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function worktree(): string { const directory = mkdtempSync(join(tmpdir(), "arbor-verifier-")); directories.push(directory); return directory; }
function input(path: string) { return { campaign_id: "campaign", node_id: "node", specialist_agent: "seed", session_id: "session", worktree_path: path, final_message: "I ran tests", history: [] }; }

describe("WorktreeMachineVerifier", () => {
  it("derives verified provenance only from an independently observed zero exit and stdout hash", async () => {
    const directory = worktree();
    const verifier = new WorktreeMachineVerifier({ command: { argv: [process.execPath, "-e", "process.stdout.write('proof')"], network: "unrestricted" } });

    const result = await verifier.verify(input(directory), new AbortController().signal);

    expect(result).toEqual({
      message: `machine verification passed: ${process.execPath} -e ${JSON.stringify("process.stdout.write('proof')")}`,
      command_argv: [process.execPath, "-e", "process.stdout.write('proof')"],
      provenance: {
        tag: "verified", cmd: `${process.execPath} -e ${JSON.stringify("process.stdout.write('proof')")}`, exit: 0,
        stdout_hash: `sha256:${createHash("sha256").update("proof").digest("hex")}`,
        check: { kind: "shell_command", breadth: "single" },
        strength: "command_executed",
      },
    });
  });

  it("fails closed for nonzero exit, cancellation, and missing worktrees", async () => {
    const directory = worktree();
    const verifier = new WorktreeMachineVerifier({ command: { argv: [process.execPath, "-e", "process.exit(7)"], network: "unrestricted" } });
    expect(await verifier.verify(input(directory), new AbortController().signal)).toBeNull();

    const controller = new AbortController(); controller.abort();
    expect(await verifier.verify(input(directory), controller.signal)).toBeNull();
    expect(await verifier.verify(input("relative-worktree"), new AbortController().signal)).toBeNull();
  });

  it("fails closed when an explicit Vitest command exits zero without matching tests", async () => {
    const directory = worktree();
    const port: MachineVerificationCommandPort = { async run() {
      return { kind: "exited", exit: 0, stdout: Buffer.from("\nNo test files found, exiting with code 0\n"), stderr: Buffer.alloc(0) };
    } };
    const verifier = new WorktreeMachineVerifier({
      command: { argv: ["bunx", "vitest", "run", "tests/absent.test.ts"], network: "unrestricted" },
      command_port: port,
    });

    expect(await verifier.verifyOutcome(input(directory), new AbortController().signal)).toEqual({
      outcome: "failed",
      code: "verification_vacuous",
      exit: 0,
      diagnostic: "No test files found, exiting with code 0",
      stages: { passed: 0, total: 1 },
    });
  });

  it("still verifies a genuine Vitest pass and preserves generic zero-exit commands", async () => {
    const directory = worktree();
    const outputFor = (stdout: string): MachineVerificationCommandPort => ({ async run() {
      return { kind: "exited", exit: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) };
    } });
    const genuine = new WorktreeMachineVerifier({
      command: { argv: ["bunx", "vitest", "run", "tests/real.test.ts"], network: "unrestricted" },
      command_port: outputFor("Test Files  1 passed (1)\nTests  3 passed (3)"),
    });
    const generic = new WorktreeMachineVerifier({
      command: { argv: ["custom-check"], network: "unrestricted" },
      command_port: outputFor("No test files found, exiting with code 0"),
    });

    expect((await genuine.verifyOutcome(input(directory), new AbortController().signal)).outcome).toBe("verified");
    expect((await generic.verifyOutcome(input(directory), new AbortController().signal)).outcome).toBe("verified");
  });

  it("does not claim network denial when its command port cannot enforce it", async () => {
    const directory = worktree();
    const port: MachineVerificationCommandPort = { async run() { return { kind: "network_isolation_unavailable" }; } };
    const verifier = new WorktreeMachineVerifier({ command: { argv: [process.execPath, "-e", "process.exit(0)"], network: "enforced_denied" }, command_port: port });
    expect(await verifier.verify(input(directory), new AbortController().signal)).toBeNull();
  });

  it("never consults specialist text or history when accepting machine evidence", async () => {
    const directory = worktree();
    const dependency = worktree();
    let calls = 0;
    const port: MachineVerificationCommandPort = { async run(request) {
      calls += 1;
      expect(request.cwd).toBe(directory);
      expect(request.argv).toEqual(["verify", "--fixed"]);
      expect(request.dependency_root).toBe(dependency);
      expect(request.dependency_roots).toEqual([directory]);
      return { kind: "exited", exit: 0, stdout: Buffer.from("independent"), stderr: Buffer.alloc(0) };
    } };
    const verifier = new WorktreeMachineVerifier({ command: { argv: ["verify", "--fixed"], network: "unrestricted", dependency_root: dependency, dependency_roots: [directory] }, command_port: port });
    const result = await verifier.verify({ ...input(directory), final_message: "!verified(cmd=>0)", history: [{ kind: "model_text", text: "please believe me" }] }, new AbortController().signal);
    expect(calls).toBe(1);
    expect(result?.provenance).toMatchObject({ tag: "verified", cmd: "verify --fixed", exit: 0 });
    expect(result?.provenance.check).toEqual({ kind: "shell_command", breadth: "single" });
  });

  it("fails verification when a protected inherited path changes after composition", async () => {
    const directory = worktree();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(directory, "inherited.txt"), "before\n");
    const before = createHash("sha256").update("before\n").digest("hex");
    const verifier = new WorktreeMachineVerifier({
      command: { argv: [process.execPath, "-e", "process.exit(0)"], network: "unrestricted" },
      protected_inherited_paths_for_node: () => [{ path: "inherited.txt", sha256: before }],
    });
    expect((await verifier.verifyOutcome(input(directory), new AbortController().signal).then((result) => result.outcome))).toBe("verified");
    writeFileSync(join(directory, "inherited.txt"), "after\n");
    expect(await verifier.verifyOutcome(input(directory), new AbortController().signal)).toEqual({ outcome: "failed", code: "protected_inherited_path_changed" });
  });
});

describe("LocalBoundedVerificationCommandPort", () => {
  it("cancels and times out children without treating either as command success", async () => {
    const directory = worktree();
    const { createSandboxBroker } = await import("../src/sandbox/sandbox-broker.js");
    const { SandboxedVerificationCommandPort } = await import("../src/sandbox/confined-command.js");
    const port = new SandboxedVerificationCommandPort(createSandboxBroker({ disable_os_confinement: true }));
    const controller = new AbortController();
    const pending = port.run({ argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"], cwd: directory, timeout_ms: 5_000, max_output_bytes: 1_024, network: "unrestricted", signal: controller.signal });
    setTimeout(() => controller.abort(), 15);
    expect((await pending).kind).toBe("cancelled");

    const timedOut = await port.run({ argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"], cwd: directory, timeout_ms: 15, max_output_bytes: 1_024, network: "unrestricted", signal: new AbortController().signal });
    expect(timedOut.kind).toBe("timed_out");
  });

  it("verifies declared outputs per node: verified when the files exist and are non-empty, null when absent", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const check = 'const s=require("node:fs").statSync;for(const p of process.argv.slice(1)){try{const st=s(p);if(!st.isFile()||st.size===0)process.exit(1)}catch{process.exit(1)}}';
    const verifier = new WorktreeMachineVerifier({
      command_for_node: (i) => i.node_id === "no-outputs" ? null : { argv: [process.execPath, "-e", check, "docs/native-doctor.md"], network: "unrestricted", timeout_ms: 30_000 },
    });

    // Produced the declared output → verified.
    const good = worktree();
    mkdirSync(join(good, "docs"), { recursive: true });
    writeFileSync(join(good, "docs", "native-doctor.md"), "# doctor\n");
    const okResult = await verifier.verify(input(good), new AbortController().signal);
    expect(okResult?.provenance.tag).toBe("verified");

    // Declared output missing → not verified (null, stays claimed).
    const empty = worktree();
    expect(await verifier.verify(input(empty), new AbortController().signal)).toBeNull();

    // A node that declared no outputs has nothing to machine-verify here.
    expect(await verifier.verify({ ...input(good), node_id: "no-outputs" }, new AbortController().signal)).toBeNull();
  });

  it("requires either a static command or a per-node command builder", () => {
    expect(() => new WorktreeMachineVerifier({})).toThrow("requires either a static command or command_for_node");
  });
});

describe("WorktreeMachineVerifier — E-2 verifyOutcome (failed vs. not-attempted)", () => {
  it("reports outcome 'failed' for a command that ran but exited nonzero -- distinct from not-attempted", async () => {
    const directory = worktree();
    const verifier = new WorktreeMachineVerifier({ command: { argv: [process.execPath, "-e", "process.exit(7)"], network: "unrestricted" } });
    expect(await verifier.verifyOutcome(input(directory), new AbortController().signal)).toEqual({ outcome: "failed", code: "command_exit_nonzero", exit: 7, stages: { passed: 0, total: 1 } });
  });

  it("retains only a bounded, path-normalized, credential-redacted failure diagnostic", async () => {
    const directory = worktree();
    const secret = "sk-abcdefghijklmnopqrstuvwx";
    const command = `process.stderr.write(${JSON.stringify(`\u001b[31m${directory}/src/lib.rs\u001b[0m\ntoken=${secret}\nerror[E0599]: no method named read_u40`)});process.exit(7)`;
    const verifier = new WorktreeMachineVerifier({ command: { argv: [process.execPath, "-e", command], network: "unrestricted" } });
    const outcome = await verifier.verifyOutcome(input(directory), new AbortController().signal);
    expect(outcome).toMatchObject({ outcome: "failed", code: "command_exit_nonzero", exit: 7 });
    if (outcome.outcome === "failed") {
      expect(outcome.diagnostic).toContain("<worktree>/src/lib.rs");
      expect(outcome.diagnostic).toContain("token=[REDACTED]");
      expect(outcome.diagnostic).toContain("error[E0599]: no method named read_u40");
      expect(outcome.diagnostic).not.toContain(directory);
      expect(outcome.diagnostic).not.toContain(secret);
      expect(outcome.diagnostic).not.toContain("\u001b");
      expect(Array.from(outcome.diagnostic ?? "").length).toBeLessThanOrEqual(2_048);
    }
  });

  it("reports outcome 'not_attempted' for an aborted signal, a missing worktree, and no declared command", async () => {
    const directory = worktree();
    const verifier = new WorktreeMachineVerifier({
      command_for_node: (i) => i.node_id === "no-outputs" ? null : { argv: [process.execPath, "-e", "process.exit(0)"], network: "unrestricted" },
    });
    const controller = new AbortController(); controller.abort();
    expect(await verifier.verifyOutcome(input(directory), controller.signal)).toEqual({ outcome: "not_attempted" });
    expect(await verifier.verifyOutcome(input("relative-worktree"), new AbortController().signal)).toEqual({ outcome: "not_attempted" });
    expect(await verifier.verifyOutcome({ ...input(directory), node_id: "no-outputs" }, new AbortController().signal)).toEqual({ outcome: "not_attempted" });
  });

  it("reports outcome 'verified' with the same message/provenance verify() would return", async () => {
    const directory = worktree();
    const verifier = new WorktreeMachineVerifier({ command: { argv: [process.execPath, "-e", "process.exit(0)"], network: "unrestricted" } });
    const outcome = await verifier.verifyOutcome(input(directory), new AbortController().signal);
    const legacy = await verifier.verify(input(directory), new AbortController().signal);
    expect(outcome.outcome).toBe("verified");
    if (outcome.outcome === "verified") expect({ message: outcome.message, provenance: outcome.provenance, command_argv: outcome.command_argv }).toEqual(legacy);
  });
});

describe("WorktreeMachineVerifier — E-4 verification-strength typing", () => {
  it("defaults to command_executed when the composition declares no strength", async () => {
    const directory = worktree();
    const verifier = new WorktreeMachineVerifier({ command: { argv: [process.execPath, "-e", "process.exit(0)"], network: "unrestricted" } });
    const result = await verifier.verify(input(directory), new AbortController().signal);
    expect(result && "provenance" in result ? result.provenance.strength : null).toBe("command_executed");
  });

  it("propagates an explicitly declared command_executed strength (a real acceptance command ran)", async () => {
    const directory = worktree();
    const verifier = new WorktreeMachineVerifier({ command: { argv: [process.execPath, "-e", "process.exit(0)"], network: "unrestricted", strength: "command_executed" } });
    const result = await verifier.verify(input(directory), new AbortController().signal);
    expect(result && "provenance" in result ? result.provenance.strength : null).toBe("command_executed");
  });

  it("propagates an explicitly declared outputs_check strength (only declared-output existence was checked)", async () => {
    const directory = worktree();
    const verifier = new WorktreeMachineVerifier({ command: { argv: [process.execPath, "-e", "process.exit(0)"], network: "unrestricted", strength: "outputs_check" } });
    const result = await verifier.verify(input(directory), new AbortController().signal);
    expect(result && "provenance" in result ? result.provenance.strength : null).toBe("outputs_check");
  });
});

describe("WorktreeMachineVerifier — G-SCOPE declared-write-scope enforcement (ab3 bench)", () => {
  const scopedVerifier = (statusStdout: string | null, scope: DeclaredWriteScope | null) => {
    const calls: string[][] = [];
    let statusQueries = 0;
    const port = {
      async run(request: { argv: readonly string[] }) {
        calls.push([...request.argv]);
        return { kind: "exited" as const, exit: 0, stdout: Buffer.from("ok"), stderr: Buffer.alloc(0) };
      },
    };
    const verifier = new WorktreeMachineVerifier({
      command: { argv: ["verify", "--fixed"], network: "unrestricted" },
      write_scope_for_node: () => scope,
      git_status_for_scope: () => { statusQueries += 1; return statusStdout; },
      command_port: port,
    });
    return { verifier, calls, statusQueried: () => statusQueries };
  };
  const blocked = (paths: readonly string[]): DeclaredWriteScope => ({ paths, enforcement: "block" });

  it("fails verification when the worktree diff includes a path outside the declared scope", async () => {
    const directory = worktree();
    const { verifier, calls } = scopedVerifier(" M test/decorator.test.js\n M package.json\n", blocked(["test/decorator.test.js"]));
    expect(await verifier.verifyOutcome(input(directory), new AbortController().signal)).toEqual({
      outcome: "failed",
      code: "write_scope_violation",
      out_of_scope_observation: { declared: ["test/decorator.test.js"], observed_out_of_scope: ["package.json"], enforcement: "blocked" },
    });
    // The scope check must fail fast — the verification command never runs.
    expect(calls).toHaveLength(0);
  });

  it("verifies when every tracked change (including both rename sides) is declared", async () => {
    const directory = worktree();
    const { verifier } = scopedVerifier("R  old.txt -> docs/new.md\n", blocked(["old.txt", "docs/new.md"]));
    const outcome = await verifier.verifyOutcome(input(directory), new AbortController().signal);
    expect(outcome.outcome).toBe("verified");
    if (outcome.outcome === "verified") expect(outcome.out_of_scope_observation).toBeUndefined();
  });

  it("exempts only harness-owned untracked artifacts and blocks undeclared new product files", async () => {
    const directory = worktree();
    const { verifier } = scopedVerifier(" M declared.js\n?? .arbor-session/log.jsonl\n?? undeclared-new-file.md\n", blocked(["declared.js"]));
    expect(await verifier.verifyOutcome(input(directory), new AbortController().signal)).toEqual({
      outcome: "failed",
      code: "write_scope_violation",
      out_of_scope_observation: { declared: ["declared.js"], observed_out_of_scope: ["undeclared-new-file.md"], enforcement: "blocked" },
    });
  });

  it("applies no enforcement when no scope is declared (null or empty)", async () => {
    const directory = worktree();
    for (const scope of [null, blocked([])]) {
      const { verifier, statusQueried } = scopedVerifier(" M anything.js\n", scope);
      const outcome = await verifier.verifyOutcome(input(directory), new AbortController().signal);
      expect(outcome.outcome).toBe("verified");
      expect(statusQueried()).toBe(0);
    }
  });

  it("skips enforcement when no status can be taken (not a git checkout / git unavailable)", async () => {
    const directory = worktree();
    const { verifier } = scopedVerifier(null, blocked(["declared.js"]));
    const outcome = await verifier.verifyOutcome(input(directory), new AbortController().signal);
    expect(outcome.outcome).toBe("verified");
  });
});

describe("WorktreeMachineVerifier — Y-1 audit-tier scope enforcement (mined scopes)", () => {
  const auditVerifier = (statusStdout: string | null, paths: readonly string[], commandExit = 0) => {
    const port = { async run() { return { kind: "exited" as const, exit: commandExit, stdout: Buffer.from("ok"), stderr: Buffer.alloc(0) }; } };
    return new WorktreeMachineVerifier({
      command: { argv: ["verify", "--fixed"], network: "unrestricted" },
      write_scope_for_node: () => ({ paths, enforcement: "audit" }),
      git_status_for_scope: () => statusStdout,
      command_port: port,
    });
  };

  it("a mined-scope mismatch never blocks -- verification proceeds and the mismatch is flagged with enforcement 'audit'", async () => {
    const directory = worktree();
    const verifier = auditVerifier(" M test/decorator.test.js\n M lib/fix.js\n", ["test/decorator.test.js"]);
    const outcome = await verifier.verifyOutcome(input(directory), new AbortController().signal);
    expect(outcome).toMatchObject({
      outcome: "verified",
      out_of_scope_observation: { declared: ["test/decorator.test.js"], observed_out_of_scope: ["lib/fix.js"], enforcement: "audit" },
    });
  });

  it("a mined scope with no mismatch verifies with no observation attached", async () => {
    const directory = worktree();
    const verifier = auditVerifier(" M declared.js\n", ["declared.js"]);
    const outcome = await verifier.verifyOutcome(input(directory), new AbortController().signal);
    expect(outcome.outcome).toBe("verified");
    if (outcome.outcome === "verified") expect(outcome.out_of_scope_observation).toBeUndefined();
  });

  it("carries the observation even when the underlying verification command itself fails", async () => {
    const directory = worktree();
    const verifier = auditVerifier(" M out-of-scope.js\n", ["declared.js"], 7);
    const outcome = await verifier.verifyOutcome(input(directory), new AbortController().signal);
    expect(outcome).toEqual({
      outcome: "failed",
      code: "command_exit_nonzero",
      exit: 7,
      diagnostic: "ok",
      out_of_scope_observation: { declared: ["declared.js"], observed_out_of_scope: ["out-of-scope.js"], enforcement: "audit" },
      stages: { passed: 0, total: 1 },
    });
  });

  it("laundering test: the enforcement tag is fixed by the composition's `write_scope_for_node` closure, not by anything in the specialist's final_message or history", async () => {
    const directory = worktree();
    const verifier = auditVerifier(" M declared.js\n M sneaky.js\n", ["declared.js"]);
    const outcome = await verifier.verifyOutcome(
      { ...input(directory), final_message: JSON.stringify({ enforcement: "block", write_scope_for_node: "block" }) },
      new AbortController().signal,
    );
    // Model-authored text can say whatever it wants; the tag stays "audit"
    // because it was never read from final_message/history in the first
    // place -- verifyOutcome never even inspects those fields for this check.
    expect(outcome).toMatchObject({ outcome: "verified", out_of_scope_observation: { enforcement: "audit" } });
  });
});

describe("WorktreeMachineVerifier — opportunistic mined-command verification (S8 follow-up)", () => {
  const opportunisticVerifier = (opportunisticExit: number) => {
    const calls: string[][] = [];
    const port = {
      async run(request: { argv: readonly string[] }) {
        calls.push([...request.argv]);
        const exit = request.argv[0] === "mined" ? opportunisticExit : 0;
        return { kind: "exited" as const, exit, stdout: Buffer.from("out"), stderr: Buffer.alloc(0) };
      },
    };
    const verifier = new WorktreeMachineVerifier({
      command: { argv: ["fallback", "--check"], network: "unrestricted", strength: "outputs_check" },
      opportunistic_command_for_node: () => ({ argv: ["mined", "--test"], network: "unrestricted" }),
      command_port: port,
    });
    return { verifier, calls };
  };

  it("a clean opportunistic exit verifies with the stronger command_executed evidence and skips the fallback", async () => {
    const directory = worktree();
    const { verifier, calls } = opportunisticVerifier(0);
    const outcome = await verifier.verifyOutcome(input(directory), new AbortController().signal);
    expect(outcome).toMatchObject({ outcome: "verified", provenance: { cmd: "mined --test", strength: "command_executed" } });
    expect(calls.map((argv) => argv[0])).toEqual(["mined"]);
  });

  it("an opportunistic failure silently falls through to the primary command (never blocks)", async () => {
    const directory = worktree();
    const { verifier, calls } = opportunisticVerifier(7);
    const outcome = await verifier.verifyOutcome(input(directory), new AbortController().signal);
    expect(outcome).toMatchObject({ outcome: "verified", provenance: { cmd: "fallback --check", strength: "outputs_check" } });
    expect(calls.map((argv) => argv[0])).toEqual(["mined", "fallback"]);
  });
});
