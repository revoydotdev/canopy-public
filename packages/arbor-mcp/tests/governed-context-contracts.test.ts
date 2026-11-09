import { describe, expect, it } from "vitest";
import {
  isGovernedContextCommandEnvelope,
  isGovernedContextQueryEnvelope,
  validateGovernedContextCommand,
  validateGovernedContextQuery,
} from "../src/governed-context-contracts.js";
import type { GovernedContextCommandEnvelope } from "../src/governed-context-contracts.js";
import type { Provenance } from "@arbor/core";

const provenance: Provenance = { tag: "claimed", claimant: "seed" };
const metadata = { operation_id: "operation", idempotency_key: "key", correlation_id: "correlation", actor_id: "seed", requested_at: "2026-08-08T00:00:00.000Z" };

describe("governed context canonical contracts", () => {
  it("recognizes every supported mutation kind and rejects malformed envelopes", () => {
    const commands: GovernedContextCommandEnvelope["command"][] = [
      { kind: "context.artifact.capture", artifact: { campaign_id: "c", media_type: "text/plain", producer: "seed", visibility: "campaign", provenance }, content: "text" },
      { kind: "fold.propose", proposal: { id: "fold", campaign_id: "c", task_id: "task", node_id: "n", scale: "granular", source_event_ids: ["event"], source_message_ranges: [{ context_id: "context", thread_id: "root", start_communication_id: "message", end_communication_id: "message", start_byte: 0, end_byte: 1 }], retained_claims: ["claim"], omitted_artifacts: [], output_artifact: { id: "ctx", sha256: "hash", media_type: "text/plain", byte_length: 1, campaign_id: "c", producer: "seed", visibility: "campaign", provenance }, measures: { expected_token_savings: 1 }, proposed_by: "seed", provenance, created_at: "2029-01-01T00:00:00.000Z", expires_at: "2030-01-01T00:00:00.000Z" } },
      { kind: "fold.approve", fold_id: "fold", fidelity_ratio: 1 }, { kind: "fold.rollback", fold_id: "fold" },
      { kind: "playbook.propose", delta: { id: "delta", campaign_id: "c", task_id: "task", kind: "add", patch: {}, source_event_ids: ["event"], source_message_ranges: [{ context_id: "context", thread_id: "root", start_communication_id: "message", end_communication_id: "message", start_byte: 0, end_byte: 1 }], observed_outcome: "helped", counter_evidence: [], proposed_by: "seed", provenance, created_at: "2029-01-01T00:00:00.000Z", expires_at: "2030-01-01T00:00:00.000Z" } },
      { kind: "playbook.approve", delta_id: "delta" },
      { kind: "harness.propose", revision: { id: "revision", campaign_id: "c", task_id: "task", component: "supplemental_prompt", patch: { guidance: "focus" }, source_event_ids: ["event"], source_message_ranges: [{ context_id: "context", thread_id: "root", start_communication_id: "message", end_communication_id: "message", start_byte: 0, end_byte: 1 }], expected_benefit: "help", proposed_by: "seed", provenance, created_at: "2029-01-01T00:00:00.000Z", expires_at: "2030-01-01T00:00:00.000Z" } },
      { kind: "harness.approve", revision_id: "revision" }, { kind: "harness.rollback", revision_id: "revision" },
      { kind: "harness.evaluate", revision_id: "revision", evaluation: { outcome: "improved", fidelity_ratio: 1, main_model_tokens: 1, child_model_tokens: 2, latency_ms: 3, regression_detected: false, rollback_count: 0, replay_evidence_ids: ["replay"], holdout_evidence_ids: ["holdout"] } },
      { kind: "harness.promote", revision_id: "revision", human_approver: "operator" },
      { kind: "subagent.execute", campaign_id: "c", parent_node_id: "node", revision_id: "revision" },
    ];
    for (const command of commands) {
      const envelope = { schema_version: 1 as const, metadata, command };
      expect(isGovernedContextCommandEnvelope(envelope)).toBe(true);
      expect(validateGovernedContextCommand(envelope)).toEqual([]);
    }
    expect(isGovernedContextCommandEnvelope({ schema_version: 2, metadata, command: commands[0] })).toBe(false);
    expect(isGovernedContextCommandEnvelope({ schema_version: 1, metadata: {}, command: { kind: "unknown" } })).toBe(false);
  });

  it("rejects invalid identities, incomplete payloads and non-finite fidelity", () => {
    const invalid = { schema_version: 1, metadata: { ...metadata, actor_id: "" }, command: { kind: "fold.approve", fold_id: "", fidelity_ratio: Number.NaN } } as unknown as GovernedContextCommandEnvelope;
    expect(validateGovernedContextCommand(invalid)).toEqual(expect.arrayContaining(["metadata identity fields are required", "fold approval requires id and fidelity ratio 0..1"]));
    const empty = { schema_version: 1, metadata, command: { kind: "harness.promote", revision_id: "", human_approver: "" } } as unknown as GovernedContextCommandEnvelope;
    expect(validateGovernedContextCommand(empty)).toEqual(expect.arrayContaining(["target id is required", "human approver is required"]));
  });

  it("recognizes bounded workspace and overlay queries and rejects missing selection", () => {
    for (const query of [
      { kind: "context.workspace", artifact_id: "ctx", offset: 0, max_bytes: 64, visibility: "campaign" },
      { kind: "context.overlays", campaign_id: "c" }, { kind: "context.governance", campaign_id: "c" }, { kind: "subagent.executions", campaign_id: "c" },
    ] as const) {
      const envelope = { schema_version: 1 as const, query_id: "query", query };
      expect(isGovernedContextQueryEnvelope(envelope)).toBe(true);
      expect(validateGovernedContextQuery(envelope)).toEqual([]);
    }
    expect(isGovernedContextQueryEnvelope({ schema_version: 1, query_id: "", query: { kind: "unknown" } })).toBe(false);
    expect(validateGovernedContextQuery({ schema_version: 1, query_id: "query", query: { kind: "context.workspace", artifact_id: "", visibility: "invalid" as "campaign" } })).toEqual(["workspace artifact id and visibility are required"]);
    expect(validateGovernedContextQuery({ schema_version: 1, query_id: "query", query: { kind: "context.overlays", campaign_id: "" } })).toEqual(["campaign_id is required"]);
  });
});
