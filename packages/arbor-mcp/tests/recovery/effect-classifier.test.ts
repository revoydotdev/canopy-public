import { describe, expect, it } from "vitest";
import { EffectClassifier } from "../../src/recovery/effect-classifier.js";
import type { RecoveryOperationCheckpoint } from "../../src/recovery/contracts.js";
import type { HarnessSessionSummary, HarnessSessionToolAuditProjection } from "../../src/harness-session-journal.js";

const session: HarnessSessionSummary = {
  session_id: "s1", campaign_id: "c1", node_id: "n1", operation: "specialize", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "architect",
  lineage: { kind: "new" }, state: "interrupted", latest_sequence: 2, terminal: null, model_identity: null,
  recovery: { kind: "recovery_required", reason: "started_without_terminal", automatic_replay: false, checkpoint: { state: "running", latest_sequence: 2 } }, diagnostics: [],
};
const checkpoint = (phase: RecoveryOperationCheckpoint["phase"], override: Partial<RecoveryOperationCheckpoint> = {}): RecoveryOperationCheckpoint => ({
  session_id: "s1", operation_id: "op1", operation_kind: "tool", operation: "file.patch", phase,
  effect_kind: "file_patch", repeatable: false, idempotency_key_hash: null, acknowledged_by: null,
  outcome: null, effect: null, compensation_id: null, occurred_at: "2026-08-12T00:00:00.000Z", ...override,
});
const classify = (checkpoints: readonly RecoveryOperationCheckpoint[], audits: readonly HarnessSessionToolAuditProjection[] = []) => EffectClassifier.classify({ session, checkpoints, tool_audits: audits });

describe("ADR-043 effect classifier", () => {
  it("distinguishes pre-dispatch, in-flight mutation, and independently read-only work", () => {
    expect(classify([checkpoint("prepared")])[0]).toMatchObject({ classification: "safely-idempotent", automatic_continuation: true });
    expect(classify([checkpoint("prepared"), checkpoint("dispatched")])[0]).toMatchObject({ classification: "indeterminate", automatic_continuation: false });
    expect(classify([checkpoint("prepared", { effect_kind: "read_only", repeatable: true }), checkpoint("dispatched", { effect_kind: "read_only", repeatable: true })])[0]).toMatchObject({ classification: "safely-idempotent", automatic_continuation: true });
  });

  it("requires a durable provider/tool acknowledgement before an idempotency key protects a repeatable write", () => {
    const key = `sha256:${"a".repeat(64)}`;
    expect(classify([checkpoint("prepared", { operation: "file.write", effect_kind: "file_write", repeatable: true, idempotency_key_hash: key }), checkpoint("dispatched", { operation: "file.write", effect_kind: "file_write", repeatable: true, idempotency_key_hash: key })])[0]).toMatchObject({ classification: "indeterminate" });
    expect(classify([
      checkpoint("prepared", { operation: "file.write", effect_kind: "file_write", repeatable: true, idempotency_key_hash: key }),
      checkpoint("idempotency_acknowledged", { operation: "file.write", effect_kind: "file_write", repeatable: true, idempotency_key_hash: key, acknowledged_by: "repository-host" }),
      checkpoint("dispatched", { operation: "file.write", effect_kind: "file_write", repeatable: true, idempotency_key_hash: key, acknowledged_by: "repository-host" }),
    ])[0]).toMatchObject({ classification: "safely-idempotent", automatic_continuation: true });
  });

  it("projects terminal settlement, durable post-effect audit, and compensation without guessing", () => {
    expect(classify([checkpoint("prepared"), checkpoint("dispatched"), checkpoint("settled", { outcome: "succeeded", effect: "applied" })])[0]).toMatchObject({ classification: "observed-complete" });
    expect(classify([checkpoint("prepared"), checkpoint("dispatched"), checkpoint("settled", { outcome: "failed", effect: "none" })])[0]).toMatchObject({ classification: "observed-failed" });
    expect(classify([checkpoint("prepared"), checkpoint("dispatched"), checkpoint("settled", { outcome: "failed", effect: "unknown" })])[0]).toMatchObject({ classification: "indeterminate", automatic_continuation: false });
    expect(classify([checkpoint("prepared"), checkpoint("dispatched"), checkpoint("compensation_available", { compensation_id: "undo-op1" })])[0]).toMatchObject({ classification: "compensatable", automatic_continuation: false });
    const audit: HarnessSessionToolAuditProjection = { session_id: "s1", call_id: "op1", tool: "file.patch", risk: "high", intent: null, action_scope: { status: "not_required" }, outcome: "succeeded", stage: "execution", code: "ok", effect: "applied", confinement: "application_validated", summary: "redacted" };
    expect(classify([checkpoint("prepared"), checkpoint("dispatched")], [audit])[0]).toMatchObject({ classification: "observed-complete" });
  });

  it("treats a legacy unmatched intent as indeterminate, never failed", () => {
    const result = EffectClassifier.classify({ session, checkpoints: [], tool_audits: [], events: [{ session_id: "s1", sequence: 2, occurred_at: "2026-08-12T00:00:00.000Z", kind: "tool_intent", payload: { tool: "shell.execute" } }] });
    // Two classifications, deliberately: the unmatched legacy intent, AND the
    // pre-dispatch provider uncertainty. The second is not redundant -- tool
    // evidence cannot establish whether a provider request crossed dispatch, so
    // it stays visible "even when other operations have classifications"
    // (effect-classifier.ts). A single-classification assertion here would let
    // a future edit drop the uncertainty that makes recovery fail closed.
    expect(result).toHaveLength(2);
    expect(result).toContainEqual(expect.objectContaining({ operation_id: "legacy-intent:1", classification: "indeterminate", automatic_continuation: false }));
    expect(result).toContainEqual(expect.objectContaining({ operation_id: "session:s1:pre-dispatch", classification: "indeterminate", automatic_continuation: false }));
    expect(result).not.toContainEqual(expect.objectContaining({ classification: "observed-failed" }));
  });
});
