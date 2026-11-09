import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilitySupport } from "@arbor/harness";
import { NativeAgentExecutor } from "../src/native-agent-executor.js";
import type { RecoveryOperationCheckpoint } from "../src/recovery/contracts.js";
import type { SandboxBroker } from "../src/sandbox/contracts.js";

const capabilities: readonly CapabilitySupport[] = (
  ["streaming", "interruption", "ephemeral_sessions", "tool_policy", "usage_reporting"] as const
).map((capability) => ({
  capability,
  grade: "native" as const,
  evidence: { implementation_id: "s09-recovery-failure-evidence-remaining-modes-test", observed_at: "2026-09-06T00:00:00.000Z", detail: "fixture" },
}));

/**
 * Carried-forward Gap 1 (audit/2026-09-06-remediation manifest, S02): a
 * prior agent wired `boundRecoveryFailureEvidence` onto `native-tool-host
 * .ts`'s `command_exit_nonzero` throw (proved by
 * `s05-recovery-failure-evidence-producer.test.ts`), but timeout,
 * spawn-failure, and output-limited command failures still threw with no
 * argv/output captured -- a retry after one of those learned nothing. This
 * drives each of the three remaining `SandboxedCommandResult` failure kinds
 * through the REAL `NativeAgentExecutor.specialize()` path (a real child
 * process for timeout/output-limit; an injected broker only where a real
 * ENOENT is not reliably reachable through this box's OS confinement
 * wrapper — see that test's own comment) and asserts the settled recovery
 * checkpoint carries bounded evidence for each, exactly like the
 * nonzero-exit case.
 */
describe("native-tool-host populates failure_evidence for the remaining shell/verification failure modes", () => {
  async function runAndCollectCheckpoints(input: {
    readonly commandArgv: readonly string[];
    readonly allowedCommands: readonly string[];
    readonly toolInput: Record<string, unknown>;
    readonly maxCommandOutputBytes?: number;
    readonly commandTimeoutMs?: number;
    readonly sandboxBroker?: SandboxBroker;
  }): Promise<{ readonly result: Awaited<ReturnType<NativeAgentExecutor["specialize"]>>; readonly checkpoints: readonly RecoveryOperationCheckpoint[] }> {
    const root = mkdtempSync(join(tmpdir(), "arbor-native-recovery-failure-evidence-remaining-"));
    const checkpoints: RecoveryOperationCheckpoint[] = [];
    try {
      const executor = new NativeAgentExecutor({
        workspace_root: root,
        capabilities,
        allow_unisolated_shell_network: true,
        approvals: { async decide() { return { approved: true, rationale: "test approval" }; } },
        repository_tools: {
          allowed_commands: input.allowedCommands,
          ...(input.maxCommandOutputBytes === undefined ? {} : { max_command_output_bytes: input.maxCommandOutputBytes }),
          ...(input.commandTimeoutMs === undefined ? {} : { max_command_timeout_ms: input.commandTimeoutMs }),
          ...(input.sandboxBroker === undefined ? {} : { sandbox_broker: input.sandboxBroker }),
        },
        record_recovery_operation: (checkpoint) => { checkpoints.push(checkpoint); },
        high_risk_scope_for_session: ({ campaign_id, node_id, session_id, worktree_path }) => ({
          scope_id: "recovery-failure-evidence-remaining-scope", campaign_id, node_id, session_id, worktree_root: worktree_path,
          provenance: { tag: "generated", generator: "s09-recovery-failure-evidence-remaining-modes-test", input_hash: "sha256:fixture" },
          write_paths: [], command_argv: [input.commandArgv],
        }),
        model_for_role: () => ({ async run() {
          return { text: [], tool_calls: [{ call_id: "verify", tool: "verification.run", input: { argv: input.commandArgv, ...input.toolInput }, input_summary: "run verification", risk: "high" }], final_message: null };
        } }),
      });
      const result = await executor.specialize({ campaign_id: "c", node_id: "recovery-failure-evidence-remaining", action: {}, prompt: "verify", worktree_path: root, specialist_agent: "seed" });
      return { result, checkpoints };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("attaches bounded argv/stderr with a null exit_code to the settled checkpoint on a real timeout", async () => {
    const commandArgv = [process.execPath, "-e", "process.stderr.write('slow: still running'); setTimeout(() => {}, 60000)"];
    const { result, checkpoints } = await runAndCollectCheckpoints({
      commandArgv,
      allowedCommands: [process.execPath],
      toolInput: { timeout_ms: 200 },
    });

    expect(result.error).toBeDefined();
    const settled = checkpoints.find((checkpoint) => checkpoint.operation === "verification.run" && checkpoint.phase === "settled");
    expect(settled).toBeDefined();
    expect(settled?.outcome).toBe("failed");
    expect(settled?.failure_evidence).toBeDefined();
    expect(settled?.failure_evidence?.command_argv).toEqual(commandArgv);
    // No exit code exists for a process that never returned one -- modeled
    // honestly as `null`, never a fabricated sentinel.
    expect(settled?.failure_evidence?.exit_code).toBeNull();
    expect(settled?.failure_evidence?.stderr_excerpt).toContain("slow: still running");
  }, 15_000);

  it("attaches bounded argv with a null exit_code and no output to the settled checkpoint on a spawn failure", async () => {
    // A real ENOENT is not reliably reachable through this box's OS
    // confinement wrapper (a missing executable is instead reported as the
    // wrapper shell's own exit 127, an ordinary nonzero exit already
    // covered by `s05-recovery-failure-evidence-producer.test.ts`). A
    // spawn failure genuinely upstream of any wrapper — the broker itself
    // could not start the process at all — is exercised directly through
    // the same broker-injection seam `native-tool-host.test.ts` already
    // uses for this class of test, driven through the real `specialize()`
    // path so the assertion still proves the recovery-checkpoint consumer,
    // not just the host in isolation.
    const commandArgv = ["definitely-not-a-real-executable", "--flag"];
    const { result, checkpoints } = await runAndCollectCheckpoints({
      commandArgv,
      allowedCommands: ["definitely-not-a-real-executable"],
      toolInput: {},
      sandboxBroker: { confinement: "application_validated", diagnostic: "spawn-failure fixture", run: async () => ({ kind: "spawn_failed", confinement: "application_validated" }) },
    });

    expect(result.error).toBeDefined();
    const settled = checkpoints.find((checkpoint) => checkpoint.operation === "verification.run" && checkpoint.phase === "settled");
    expect(settled).toBeDefined();
    expect(settled?.outcome).toBe("failed");
    expect(settled?.failure_evidence).toBeDefined();
    expect(settled?.failure_evidence?.command_argv).toEqual(commandArgv);
    expect(settled?.failure_evidence?.exit_code).toBeNull();
    // The process never started: no stdout/stderr was ever produced, so
    // nothing is fabricated in its place.
    expect(settled?.failure_evidence?.stderr_excerpt).toBeNull();
  });

  it("attaches bounded argv/stderr with a null exit_code to the settled checkpoint on a real output-limit breach", async () => {
    const commandArgv = [process.execPath, "-e", "process.stderr.write('overflowing: '); process.stdout.write('x'.repeat(1_000_000));"];
    const { result, checkpoints } = await runAndCollectCheckpoints({
      commandArgv,
      allowedCommands: [process.execPath],
      toolInput: {},
      maxCommandOutputBytes: 64,
    });

    expect(result.error).toBeDefined();
    const settled = checkpoints.find((checkpoint) => checkpoint.operation === "verification.run" && checkpoint.phase === "settled");
    expect(settled).toBeDefined();
    expect(settled?.outcome).toBe("failed");
    expect(settled?.failure_evidence).toBeDefined();
    expect(settled?.failure_evidence?.command_argv).toEqual(commandArgv);
    expect(settled?.failure_evidence?.exit_code).toBeNull();
    expect(settled?.failure_evidence?.stderr_excerpt).toContain("overflowing");
  });
});
