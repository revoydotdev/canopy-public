import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilitySupport } from "@arbor/harness";
import { NativeAgentExecutor } from "../src/native-agent-executor.js";
import type { RecoveryOperationCheckpoint } from "../src/recovery/contracts.js";

const capabilities: readonly CapabilitySupport[] = (
  ["streaming", "interruption", "ephemeral_sessions", "tool_policy", "usage_reporting"] as const
).map((capability) => ({
  capability,
  grade: "native" as const,
  evidence: { implementation_id: "s05-recovery-failure-evidence-test", observed_at: "2026-09-06T00:00:00.000Z", detail: "fixture" },
}));

/**
 * S02/Gap 2 (audit/2026-09-06-remediation): `RecoveryFailureEvidence` was
 * defined, bounded, and threaded all the way to `ContinuationPlan
 * .admitted_context` (see `s02-recovery-failure-evidence.test.ts`), but
 * nothing ever constructed one in production — a real failed shell command
 * left `failure_evidence` permanently absent. This test drives the REAL
 * native tool host through `NativeAgentExecutor.specialize` (the same
 * `repository_tools`-wired path `native-agent-executor.test.ts`'s
 * "permits a real verification.run to execute" test uses), makes the
 * command actually fail with real stderr, and asserts the checkpoint
 * delivered to `record_recovery_operation` — the one channel
 * `EffectClassifier`/`buildContinuationPlan` read from — carries the
 * bounded evidence. Proves the producer, not merely the consumer.
 */
describe("S02 native-tool-host populates failure_evidence for a real failed command", () => {
  it("attaches bounded argv/exit/stderr to the settled recovery checkpoint for a real nonzero-exit verification.run", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-native-recovery-failure-evidence-"));
    const commandArgv = [process.execPath, "-e", "process.stderr.write('boom: missing entrypoint'); process.exit(3)"];
    const checkpoints: RecoveryOperationCheckpoint[] = [];
    try {
      const executor = new NativeAgentExecutor({
        workspace_root: root,
        capabilities,
        allow_unisolated_shell_network: true,
        approvals: { async decide() { return { approved: true, rationale: "test approval" }; } },
        repository_tools: { allowed_commands: [process.execPath] },
        record_recovery_operation: (checkpoint) => { checkpoints.push(checkpoint); },
        high_risk_scope_for_session: ({ campaign_id, node_id, session_id, worktree_path }) => ({
          scope_id: "recovery-failure-evidence-scope", campaign_id, node_id, session_id, worktree_root: worktree_path,
          provenance: { tag: "generated", generator: "s05-recovery-failure-evidence-test", input_hash: "sha256:fixture" },
          write_paths: [], command_argv: [commandArgv],
        }),
        model_for_role: () => ({ async run() {
          return { text: [], tool_calls: [{ call_id: "verify", tool: "verification.run", input: { argv: commandArgv }, input_summary: "run verification", risk: "high" }], final_message: null };
        } }),
      });

      const result = await executor.specialize({ campaign_id: "c", node_id: "recovery-failure-evidence", action: {}, prompt: "verify", worktree_path: root, specialist_agent: "seed" });

      // The plan is provably rejected FOR THE REASON UNDER TEST (the command
      // really ran and really failed), not for some unrelated setup mistake.
      expect(result.error).toBeDefined();

      const settled = checkpoints.find((checkpoint) => checkpoint.operation === "verification.run" && checkpoint.phase === "settled");
      expect(settled).toBeDefined();
      expect(settled?.outcome).toBe("failed");
      expect(settled?.failure_evidence).toBeDefined();
      expect(settled?.failure_evidence?.command_argv).toEqual(commandArgv);
      expect(settled?.failure_evidence?.exit_code).toBe(3);
      expect(settled?.failure_evidence?.stderr_excerpt).toContain("boom: missing entrypoint");

      // No other checkpoint on this operation fabricates evidence before the
      // command actually settled.
      const prepared = checkpoints.find((checkpoint) => checkpoint.operation === "verification.run" && checkpoint.phase === "prepared");
      expect(prepared?.failure_evidence).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
