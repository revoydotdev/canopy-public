import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { vacuousInlineCheckReason } from "../src/verification-script-vacuity.js";
import { WorktreeMachineVerifier, type MachineVerificationCommandPort, type SpecialistWorktreeVerificationInput } from "../src/worktree-machine-verifier.js";

// S13 (audit/2026-09-06-remediation/manifest.md, S01 residual): "The literal
// guard is incomplete by design and does not establish semantic
// correctness." `s01-script-identity-and-semantic-refusal.test.ts` pinned
// one concrete demonstration of that gap -- a `node -e "process.exit(0)"`
// package script earning `verified` -- and this file closes it via
// `vacuousInlineCheckReason` in `verification-script-vacuity.ts`, wired into
// `WorktreeMachineVerifier.runPlan`.
//
// The design: a package script that resolves to a bare inline interpreter
// invocation (`-e`/`-c`/`--eval`) is not shell syntax the literal-noop
// grammar can classify, but it also cannot be evidence about THIS
// repository unless it demonstrably touches it -- either by referencing the
// node's own declared write scope (the strongest, plan-specific signal), or
// -- absent a declared scope -- by touching the filesystem, a relative
// module, or a subprocess at all. A command that is not this shape (a real
// test runner, build tool, or script file) is never inspected by this guard,
// so it cannot be over-refused.
//
// Scope is deliberately narrow, matching `hasVacuousPackageScript`: only a
// bare `<pm> run <name>` argv's RESOLVED script text is inspected. A direct
// argv the composition itself constructs (e.g. `cli.ts`'s dependency-free
// declared-outputs check) is harness-authored, not specialist-editable
// `package.json` content, and is never second-guessed by this guard.

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function worktreeWithScripts(scripts: Record<string, string>): string {
  const path = mkdtempSync(join(tmpdir(), "revoy-s13-"));
  dirs.push(path);
  writeFileSync(join(path, "package.json"), JSON.stringify({ scripts }));
  return path;
}

function input(worktree_path: string): SpecialistWorktreeVerificationInput {
  return { campaign_id: "campaign", node_id: "node", specialist_agent: "seed", session_id: "session", worktree_path, final_message: "done", history: [] };
}

const passingPort: MachineVerificationCommandPort = {
  async run() { return { kind: "exited", exit: 0, stdout: Buffer.from("ok"), stderr: Buffer.alloc(0) }; },
};

describe("S13: vacuousInlineCheckReason (unit)", () => {
  it("refuses a bare inline no-op with no declared scope, naming the missing filesystem/module relationship", () => {
    const directory = worktreeWithScripts({ check: "node -e \"process.exit(0)\"" });
    const reason = vacuousInlineCheckReason(["bun", "run", "check"], directory, []);
    expect(reason).toMatch(/references no file, module, or filesystem primitive/);
  });

  it("refuses a bare inline no-op that ignores a declared write path, naming the missing path relationship", () => {
    const directory = worktreeWithScripts({ check: "node -e \"process.exit(0)\"" });
    const reason = vacuousInlineCheckReason(["bun", "run", "check"], directory, ["src/greeting.ts"]);
    expect(reason).toMatch(/does not reference any of this node's declared write paths/);
    expect(reason).toContain("src/greeting.ts");
  });

  it("does not refuse a real test runner invocation -- this guard never inspects non-inline commands", () => {
    const directory = worktreeWithScripts({ check: "bun test --run" });
    expect(vacuousInlineCheckReason(["bun", "run", "check"], directory, [])).toBeNull();
    expect(vacuousInlineCheckReason(["bun", "run", "check"], directory, ["src/greeting.ts"])).toBeNull();
  });

  it("does not refuse an inline check that references its declared write path", () => {
    const directory = worktreeWithScripts({ check: "node -e \"require('node:assert').ok(require('./src/greeting.ts'))\"" });
    expect(vacuousInlineCheckReason(["bun", "run", "check"], directory, ["src/greeting.ts"])).toBeNull();
  });

  it("does not refuse an inline check that touches the filesystem, absent a declared scope", () => {
    const directory = worktreeWithScripts({ check: "node -e \"require('node:fs').statSync('./dist/output.js')\"" });
    expect(vacuousInlineCheckReason(["bun", "run", "check"], directory, [])).toBeNull();
  });

  it("ignores a direct, non-package argv entirely, even when it is an inline no-op -- that argv is harness-authored, not specialist-editable", () => {
    const directory = worktreeWithScripts({});
    expect(vacuousInlineCheckReason([process.execPath, "-e", "process.exit(0)"], directory, [])).toBeNull();
  });
});

describe("S13: WorktreeMachineVerifier.verifyOutcome end-to-end", () => {
  it("refuses verified provenance for the pinned semantic gap, without ever dispatching the command", async () => {
    const directory = worktreeWithScripts({ check: "node -e \"process.exit(0)\"" });
    let commandRan = false;
    const port: MachineVerificationCommandPort = { async run() { commandRan = true; return { kind: "exited", exit: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; } };
    const verifier = new WorktreeMachineVerifier({ command: { argv: ["bun", "run", "check"], network: "unrestricted" }, command_port: port });

    const outcome = await verifier.verifyOutcome(input(directory), new AbortController().signal);

    expect(outcome).toMatchObject({ outcome: "failed", code: "verification_vacuous" });
    if (outcome.outcome !== "failed") throw new Error("unreachable");
    expect(outcome.diagnostic).toMatch(/inline interpreter invocation/);
    expect(commandRan).toBe(false);
  });

  it("refuses a mined-scope opportunistic inline no-op check and falls through to the declared-outputs check instead of laundering it into verified work", async () => {
    const directory = worktreeWithScripts({ check: "node -e \"process.exit(0)\"" });
    const outputPath = join(directory, "output.txt");
    writeFileSync(outputPath, "produced");
    let opportunisticRan = false;
    const port: MachineVerificationCommandPort = {
      async run(request) {
        if (request.argv[0] === "bun") { opportunisticRan = true; return { kind: "exited", exit: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; }
        return { kind: "exited", exit: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    };
    const verifier = new WorktreeMachineVerifier({
      command: { argv: [process.execPath, "-e", "process.exit(0)", "output.txt"], network: "unrestricted", strength: "outputs_check" },
      opportunistic_command_for_node: () => ({ argv: ["bun", "run", "check"], network: "unrestricted" }),
      write_scope_for_node: () => ({ paths: ["output.txt"], enforcement: "audit" }),
      command_port: port,
    });

    const outcome = await verifier.verifyOutcome(input(directory), new AbortController().signal);

    // The opportunistic mined check is refused as vacuous (never dispatched)
    // and, per the module's existing S8 rule, a demonstrated vacuous check
    // must not fall through to the outputs check either -- an operator must
    // see the honest refusal, not a downgraded-but-silent "verified".
    expect(outcome).toMatchObject({ outcome: "failed", code: "verification_vacuous" });
    expect(opportunisticRan).toBe(false);
  });

  it("does not over-refuse: a genuine test-runner check for the same node still earns verified", async () => {
    const directory = worktreeWithScripts({ check: "bun test --run" });
    const verifier = new WorktreeMachineVerifier({
      command: { argv: ["bun", "run", "check"], network: "unrestricted" },
      write_scope_for_node: () => ({ paths: ["src/greeting.ts"], enforcement: "audit" }),
      command_port: passingPort,
    });

    const outcome = await verifier.verifyOutcome(input(directory), new AbortController().signal);

    expect(outcome.outcome).toBe("verified");
  });

  it("does not over-refuse: an inline check that genuinely references the declared write path still earns verified", async () => {
    const directory = worktreeWithScripts({ check: "node -e \"if (!require('node:fs').existsSync('./src/greeting.ts')) process.exit(1)\"" });
    const verifier = new WorktreeMachineVerifier({
      command: { argv: ["bun", "run", "check"], network: "unrestricted" },
      write_scope_for_node: () => ({ paths: ["src/greeting.ts"], enforcement: "audit" }),
      command_port: passingPort,
    });

    const outcome = await verifier.verifyOutcome(input(directory), new AbortController().signal);

    expect(outcome.outcome).toBe("verified");
  });

  it("RESIDUAL, STILL UNPROVEN: a script FILE (not an inline -e/-c/--eval invocation) that does nothing still earns verified -- this guard only reaches resolvable inline interpreter invocations", async () => {
    // This is the honestly-recorded remaining scope of the manifest's
    // finding: a specialist that writes a no-op *file* (`scripts/fake.sh`
    // containing only `exit 0`) and points a package script at it is not an
    // inline interpreter invocation, so `vacuousInlineCheckReason` never
    // inspects it, and generic shell-script-content evaluation is outside
    // this guard's closed-grammar design (arbitrary script content cannot be
    // safely classified without either false positives on real scripts or
    // false negatives on adversarial ones). It remains true, as it was
    // before S13, that this is not closed by the literal or inline guards.
    const directory = worktreeWithScripts({ check: "sh scripts/fake.sh" });
    mkdirSync(join(directory, "scripts"));
    writeFileSync(join(directory, "scripts", "fake.sh"), "#!/bin/sh\nexit 0\n");
    const verifier = new WorktreeMachineVerifier({ command: { argv: ["bun", "run", "check"], network: "unrestricted" }, command_port: passingPort });

    const outcome = await verifier.verifyOutcome(input(directory), new AbortController().signal);

    expect(outcome.outcome).toBe("verified");
  });
});
