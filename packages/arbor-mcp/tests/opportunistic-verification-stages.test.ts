import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeMachineVerifier, type MachineVerificationCommandPort } from "../src/worktree-machine-verifier.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup(fail?: string) {
  const path = mkdtempSync(join(tmpdir(), "revoy-opportunistic-stages-")); dirs.push(path);
  const calls: string[] = [];
  const command_port: MachineVerificationCommandPort = { async run(request) {
    const command = request.argv.join(" "); calls.push(command);
    return { kind: "exited", exit: command === fail ? 1 : 0, stdout: Buffer.from(command), stderr: Buffer.alloc(0) };
  } };
  const verifier = new WorktreeMachineVerifier({ command: { argv: ["outputs"], network: "unrestricted", strength: "outputs_check" },
    opportunistic_command_for_node: () => ({ stages: ["check", "test", "build"].map((name) => ({ argv: ["bun", "run", name] as [string, ...string[]], network: "unrestricted" as const })) }), command_port });
  return { calls, verifier, input: { campaign_id: "campaign", node_id: "node", specialist_agent: "seed", session_id: "session", worktree_path: path, final_message: "All tests pass", history: [] } };
}
describe("opportunistic verification retains all stages", () => {
  it("requires every declared stage before stronger evidence and records each result", async () => {
    const { verifier, input, calls } = setup();
    const outcome = await verifier.verifyOutcome(input, new AbortController().signal);
    expect(calls).toEqual(["bun run check", "bun run test", "bun run build"]);
    expect(outcome).toMatchObject({ outcome: "verified", provenance: { strength: "command_executed", cmd: "bun run check && bun run test && bun run build" },
      stage_results: [{ outcome: "passed" }, { outcome: "passed" }, { outcome: "passed" }] });
  });
  it("does not award stronger evidence when a later stage fails", async () => {
    const { verifier, input, calls } = setup("bun run test");
    expect(await verifier.verifyOutcome(input, new AbortController().signal)).toMatchObject({ outcome: "verified", provenance: { strength: "outputs_check", cmd: "outputs" } });
    expect(calls).toEqual(["bun run check", "bun run test", "outputs"]);
  });
  it("propagates a vacuous later stage without falling back", async () => {
    const { verifier, input, calls } = setup();
    writeFileSync(join(input.worktree_path, "package.json"), JSON.stringify({ scripts: { check: "bun test", test: "bun test", build: "echo 'Build complete'" } }));
    const outcome = await verifier.verifyOutcome(input, new AbortController().signal);
    expect(outcome).toMatchObject({ outcome: "failed", code: "verification_vacuous", stage_results: [{ outcome: "passed" }, { outcome: "passed" }, { outcome: "failed", exit: null }] });
    expect(calls).toEqual(["bun run check", "bun run test"]);
  });
});
