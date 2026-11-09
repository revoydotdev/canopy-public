import { describe, expect, it } from "vitest";
import { EffectClassifier } from "../src/recovery/effect-classifier.js";
import { buildContinuationPlan } from "../src/recovery/continuation-plan.js";
import { boundRecoveryFailureEvidence, RECOVERY_MAX_FAILURE_ARGV_TOKENS, RECOVERY_MAX_STDERR_EXCERPT_BYTES, type RecoveryOperationCheckpoint } from "../src/recovery/contracts.js";
import type { HarnessSessionSummary } from "../src/harness-session-journal.js";

/**
 * S02 (audit/2026-09-06-remediation): "Retry context contains changed-file
 * deltas but evidence: [], with only the normalized command_exit_nonzero
 * diagnosis. The worker lacks the failed argv, exit detail, and bounded
 * stderr needed for targeted repair." These tests prove the bounded
 * evidence actually reaches the retry-facing surface (`ContinuationPlan
 * .admitted_context`), not merely that the type compiles.
 */

const session: HarnessSessionSummary = {
  session_id: "s1", campaign_id: "c1", node_id: "n1", operation: "specialize", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "architect",
  lineage: { kind: "new" }, state: "interrupted", latest_sequence: 2, terminal: null, model_identity: null,
  recovery: { kind: "recovery_required", reason: "started_without_terminal", automatic_replay: false, checkpoint: { state: "running", latest_sequence: 2 } }, diagnostics: [],
};

function checkpoint(phase: RecoveryOperationCheckpoint["phase"], override: Partial<RecoveryOperationCheckpoint> = {}): RecoveryOperationCheckpoint {
  return {
    session_id: "s1", operation_id: "op1", operation_kind: "tool", operation: "shell.execute", phase,
    effect_kind: "shell", repeatable: false, idempotency_key_hash: null, acknowledged_by: null,
    outcome: null, effect: null, compensation_id: null, occurred_at: "2026-08-12T00:00:00.000Z", ...override,
  };
}

describe("S02 boundRecoveryFailureEvidence", () => {
  it("caps argv length and stderr byte size regardless of what the caller passes", () => {
    const longArgv = Array.from({ length: 100 }, (_, i) => `token-${i}`);
    const longStderr = "x".repeat(RECOVERY_MAX_STDERR_EXCERPT_BYTES * 4);
    const bounded = boundRecoveryFailureEvidence({ command_argv: longArgv, exit_code: 1, stderr: longStderr });
    expect(bounded.command_argv.length).toBe(RECOVERY_MAX_FAILURE_ARGV_TOKENS);
    expect(Buffer.byteLength(bounded.stderr_excerpt ?? "", "utf8")).toBeLessThanOrEqual(RECOVERY_MAX_STDERR_EXCERPT_BYTES);
    expect(bounded.exit_code).toBe(1);
  });

  it("preserves null stderr distinctly from an empty string", () => {
    expect(boundRecoveryFailureEvidence({ command_argv: ["bun", "build"], exit_code: 1, stderr: null }).stderr_excerpt).toBeNull();
    expect(boundRecoveryFailureEvidence({ command_argv: ["bun", "build"], exit_code: 1, stderr: "" }).stderr_excerpt).toBe("");
  });
});

describe("S02 EffectClassifier surfaces bounded failure evidence", () => {
  it("attaches failure_evidence and embeds it in the reason for an indeterminate operation", () => {
    const evidence = boundRecoveryFailureEvidence({ command_argv: ["bun", "build"], exit_code: 1, stderr: "error: Missing entrypoints" });
    const result = EffectClassifier.classify({
      session,
      checkpoints: [checkpoint("prepared", { failure_evidence: evidence }), checkpoint("dispatched", { failure_evidence: evidence })],
      tool_audits: [],
    });
    expect(result[0]).toMatchObject({ classification: "indeterminate", failure_evidence: evidence });
    expect(result[0]!.reason).toContain("bun build");
    expect(result[0]!.reason).toContain("exit=1");
    expect(result[0]!.reason).toContain("Missing entrypoints");
  });

  it("omits failure_evidence entirely (not merely null) when no checkpoint carried one", () => {
    const result = EffectClassifier.classify({ session, checkpoints: [checkpoint("prepared"), checkpoint("dispatched")], tool_audits: [] });
    expect(result[0]).not.toHaveProperty("failure_evidence");
  });

  it("carries failure evidence through to a durable settled observed-failed classification", () => {
    const evidence = boundRecoveryFailureEvidence({ command_argv: ["npm", "test"], exit_code: 127, stderr: "command not found" });
    const result = EffectClassifier.classify({
      session,
      checkpoints: [checkpoint("prepared"), checkpoint("dispatched"), checkpoint("settled", { outcome: "failed", effect: "none", failure_evidence: evidence })],
      tool_audits: [],
    });
    expect(result[0]).toMatchObject({ classification: "observed-failed", failure_evidence: evidence });
  });
});

describe("S02 ContinuationPlan admitted_context carries retry-informing evidence", () => {
  it("includes the bounded argv/exit/stderr in a context fact a retry can read", () => {
    const evidence = boundRecoveryFailureEvidence({ command_argv: ["bun", "install"], exit_code: 1, stderr: "error: lockfile mismatch" });
    const plan = buildContinuationPlan({
      session,
      checkpoints: [checkpoint("prepared", { failure_evidence: evidence }), checkpoint("dispatched", { failure_evidence: evidence })],
      tool_audits: [],
    });
    const operationFact = plan.admitted_context.find((fact) => fact.kind === "decision" && fact.reference_id === "operation:op1");
    expect(operationFact).toBeDefined();
    expect(operationFact!.summary).toContain("bun install");
    expect(operationFact!.summary).toContain("exit=1");
    expect(operationFact!.summary).toContain("lockfile mismatch");
    // The operation requires an explicit disposition (indeterminate), which is
    // exactly the retry-authoring moment this evidence exists to inform.
    expect(plan.requires_disposition).toContain("op1");
  });
});
