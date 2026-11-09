import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasVacuousPackageScript, isLiteralNoopScript } from "../src/verification-script-vacuity.js";
import { WorktreeMachineVerifier, type MachineVerificationCommandPort } from "../src/worktree-machine-verifier.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(scripts: Record<string, string>) {
  const path = mkdtempSync(join(tmpdir(), "revoy-vacuous-")); dirs.push(path);
  writeFileSync(join(path, "package.json"), JSON.stringify({ scripts }));
  return { campaign_id: "campaign", node_id: "node", specialist_agent: "seed", session_id: "session", worktree_path: path, final_message: "All tests pass", history: [] };
}
describe("vacuous verification script guard", () => {
  it.each(["bun --version && echo 'Check passed: Bun is available'", "echo 'Build complete: TypeScript modules are ready for execution'", "true", ":"])("recognizes literal no-op: %s", (script) => {
    expect(isLiteralNoopScript(script)).toBe(true);
  });
  it.each(["bun test", "bun --version && bun test", "echo $(bun test)", "echo 'code' > source.ts", "node -e 'runChecks()'"])("does not classify substantive or unknown syntax: %s", (script) => {
    expect(isLiteralNoopScript(script)).toBe(false);
  });
  it("does not ignore potentially substantive lifecycle hooks or alternate argv", () => {
    const input = fixture({ check: "echo done", precheck: "bun test" });
    expect(hasVacuousPackageScript(["bun", "run", "check"], input.worktree_path)).toBe(false);
    expect(hasVacuousPackageScript(["bun", "run", "--cwd", "other", "check"], input.worktree_path)).toBe(false);
  });
  it("rejects the real pilot script before dispatch and without fabricated exit evidence", async () => {
    const input = fixture({ check: "bun --version && echo 'Check passed: Bun is available'" });
    let calls = 0;
    const command_port: MachineVerificationCommandPort = { async run() { calls++; return { kind: "exited", exit: 0, stdout: Buffer.from("Check passed"), stderr: Buffer.alloc(0) }; } };
    const verifier = new WorktreeMachineVerifier({ command: { argv: ["bun", "run", "check"], network: "unrestricted" }, command_port });
    const outcome = await verifier.verifyOutcome(input, new AbortController().signal);
    expect(outcome).toMatchObject({ outcome: "failed", code: "verification_vacuous" });
    expect(outcome).not.toHaveProperty("exit");
    expect(calls).toBe(0);
  });
  it("does not upgrade a vacuous opportunistic check through an outputs fallback", async () => {
    const input = fixture({ check: "echo passed" });
    let calls = 0;
    const command_port: MachineVerificationCommandPort = { async run() { calls++; return { kind: "exited", exit: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; } };
    const verifier = new WorktreeMachineVerifier({ command: { argv: ["outputs-check"], network: "unrestricted", strength: "outputs_check" },
      opportunistic_command_for_node: () => ({ argv: ["bun", "run", "check"], network: "unrestricted" }), command_port });
    expect(await verifier.verifyOutcome(input, new AbortController().signal)).toMatchObject({ outcome: "failed", code: "verification_vacuous" });
    expect(calls).toBe(0);
  });
  it("retains execution for a substantive script", async () => {
    const input = fixture({ check: "bun test" });
    let calls = 0;
    const command_port: MachineVerificationCommandPort = { async run() { calls++; return { kind: "exited", exit: 0, stdout: Buffer.from("test evidence"), stderr: Buffer.alloc(0) }; } };
    const verifier = new WorktreeMachineVerifier({ command: { argv: ["bun", "run", "check"], network: "unrestricted" }, command_port });
    expect(await verifier.verifyOutcome(input, new AbortController().signal)).toMatchObject({ outcome: "verified" });
    expect(calls).toBe(1);
  });
});
