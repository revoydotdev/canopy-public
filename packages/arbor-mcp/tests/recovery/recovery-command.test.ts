import { describe, expect, it } from "vitest";
import type { ArborRuntime } from "../../src/runtime.js";
import { runRecoveryCommand } from "../../src/recovery/recovery-command.js";
import type { ContinuationPlan } from "../../src/recovery/continuation-plan.js";
import { FRESH_ADMISSION_KINDS } from "../../src/recovery/contracts.js";

const plan: ContinuationPlan = { campaign_id: "campaign", node_id: "node", source_session_id: "source", source_checkpoint: 4, source_model_identity: { provider_id: "fixture", model_id: "model", configured_revision: "r1", revision: "r1" }, classifications: [{ operation_id: "read", operation: "file.read", classification: "safely-idempotent", automatic_continuation: true, reason: "read only", evidence_ids: ["operation:read:dispatched"] }], classification_fingerprint: `sha256:${"a".repeat(64)}`, required_admissions: FRESH_ADMISSION_KINDS, admitted_context: [], requires_disposition: [], automatic_continuation_allowed: true };

function runtime(log: string[]): ArborRuntime {
  const authorization = { authorization_id: "placeholder", idempotency_key: "key", campaign_id: "campaign", node_id: "node", source_session_id: "source", source_checkpoint: 4, new_session_id: "continuation:placeholder", classification_fingerprint: plan.classification_fingerprint, effects: [{ operation_id: "read", operation: "file.read", classification: "safely-idempotent" as const }], dispositions: [], admissions: FRESH_ADMISSION_KINDS.map((kind) => ({ kind, admitted: true, evidence_id: kind, reason: "fresh" })), context: [], actor_id: "operator", authorized_at: "2026-08-12T00:00:00.000Z" };
  return {
    recoveryService: {
      previewContinuation: () => { log.push("preview"); return [plan]; },
      prepareContinuation: (_campaign: string, _node: string, request: { authorization_id: string }) => { log.push("prepare"); return { status: "ready", plan, authorization: { ...authorization, authorization_id: request.authorization_id, new_session_id: `continuation:${request.authorization_id}` }, lease_id: "lease", task_id: "recovery", replayed: false }; },
    },
    manager: { getRecoverableNodes: () => [{ campaign_id: "campaign", node_id: "node", state: "interrupted", prior_operation_id: "crash", expected_version: "v1" }] },
    runPreparedContinuation: (_campaign: string, authorizationId: string) => { log.push("campaign.run"); return { ok: true, task_id: `campaign-run:${authorizationId}`, dispatched: true }; },
  } as unknown as ArborRuntime;
}

describe("recover command", () => {
  it("previews classifications and fresh admissions without mutation", () => {
    const log: string[] = [];
    expect(runRecoveryCommand({ runtime: runtime(log), campaign_id: "campaign", authorize: false, actor_id: "operator", reason: "preview", dispositions: [] })).toEqual({ ok: true, authorized: false, plans: [plan] });
    expect(log).toEqual(["preview"]);
  });

  it("authorizes preparation before submitting the canonical supervised campaign.run", () => {
    const log: string[] = [];
    expect(runRecoveryCommand({ runtime: runtime(log), campaign_id: "campaign", node_id: "node", authorize: true, actor_id: "operator", reason: "continue", dispositions: [], now: () => "2026-08-12T00:00:00.000Z" })).toMatchObject({ ok: true, authorized: true, session_id: expect.stringMatching(/^continuation:continuation-/), dispatched: true });
    expect(log).toEqual(["preview", "prepare", "campaign.run"]);
  });
});
