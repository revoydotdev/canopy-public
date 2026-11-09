import { describe, expect, it } from "vitest";
import {
  createIntentAdmissionState,
  resetIntentTurn,
  transitionIntentAdmission,
  validateIntentAdmission,
  type IntentDecision,
} from "../src/index.js";

const decision: IntentDecision = {
  schema_version: 1,
  decision_id: "decision-1",
  intent_id: "intent-1",
  actor_id: "operator-1",
  requested_at: "2026-09-13T12:00:00.000Z",
  request_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  summary: "implement the widget",
  classification: "build",
  confidence: "high",
  disposition: "admit",
  route_category: "seed-quick",
  rationale: "bounded implementation task",
  requires_plan: true,
  requires_review: true,
  refusal: null,
};

const admitted = { request: "Implement the widget", turn_id: "turn-1", scope: [{ kind: "path" as const, value: "packages/arbor-core/src/widget.ts" }] };

describe("deterministic intent admission", () => {
  it("requires an explicit verb and concrete scope", () => {
    expect(validateIntentAdmission({ decision, ...admitted }).ok).toBe(true);
    expect(validateIntentAdmission({ decision, ...admitted, request: "please help" })).toMatchObject({ ok: false, disposition: "clarify" });
    expect(validateIntentAdmission({ decision, ...admitted, scope: [] })).toMatchObject({ ok: false, blockers: [{ code: "insufficient_scope" }] });
  });

  it("blocks pending Oracle work and never mutates input", () => {
    const result = validateIntentAdmission({ decision, ...admitted, dependencies: [{ id: "oracle-1", owner: "oracle", status: "pending", blocking: true }] });
    expect(result).toMatchObject({ ok: false, disposition: "clarify", blockers: [{ code: "pending_dependency" }] });
  });

  it("fails closed for malformed scope and dependency values", () => {
    expect(validateIntentAdmission({ decision, ...admitted, scope: undefined as never })).toMatchObject({ ok: false, blockers: [{ code: "insufficient_scope" }] });
    expect(validateIntentAdmission({ decision, ...admitted, dependencies: [{ id: 1 } as never] })).toMatchObject({ ok: false, blockers: [{ code: "invalid" }] });
  });

  it("enforces the durable intent → plan → review → dispatch → verify order", () => {
    let state = createIntentAdmissionState(decision, "turn-1");
    const apply = (event: Parameters<typeof transitionIntentAdmission>[1]) => {
      const result = transitionIntentAdmission(state, event);
      expect(result.ok).toBe(true);
      if (result.ok) state = result.state;
    };
    apply({ kind: "admit", ...admitted });
    apply({ kind: "plan", turn_id: "turn-1", plan_id: "plan-1", action_ids: ["action-1"] });
    apply({ kind: "review", turn_id: "turn-1", reviewer_id: "lenticel", verdict: "approved", rationale: "scope is sufficient" });
    apply({ kind: "dispatch", turn_id: "turn-1", operation_id: "op-1", agent_id: "seed", worktree_id: null });
    apply({ kind: "verify", turn_id: "turn-1", operation_id: "op-1", verification: { tag: "claimed", claimant: "seed" }, summary: "completed" });
    expect(state.phase).toBe("verified");
    expect(transitionIntentAdmission(state, { kind: "dispatch", turn_id: "turn-1", operation_id: "op-2", agent_id: "seed", worktree_id: null })).toMatchObject({ ok: false, error: { code: "order" } });
  });

  it("rejects stale turns and resets blockers for a new turn", () => {
    const state = createIntentAdmissionState(decision, "turn-1");
    expect(transitionIntentAdmission(state, { kind: "admit", ...admitted, turn_id: "old-turn" })).toMatchObject({ ok: false, error: { code: "stale" } });
    const blocked = transitionIntentAdmission(state, { kind: "admit", ...admitted, dependencies: [{ id: "oracle-1", owner: "oracle", status: "pending", blocking: true }] });
    expect(blocked.ok).toBe(true);
    if (blocked.ok) {
      const reset = resetIntentTurn(blocked.state, decision, "turn-2");
      expect(reset).toMatchObject({ phase: "intent", turn_id: "turn-2", blockers: [], reset_from: { turn_id: "turn-1" } });
    }
  });
});
