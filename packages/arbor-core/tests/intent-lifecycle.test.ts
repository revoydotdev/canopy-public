import { describe, expect, it } from "vitest";
import {
  appendIntentLifecycleRecord,
  parseIntentLedger,
  serializeIntentLedger,
  type IntentDecision,
  type IntentLifecycleRecord,
} from "../src/index.js";

const decision: IntentDecision = {
  schema_version: 1,
  decision_id: "decision-1",
  intent_id: "intent-1",
  actor_id: "operator-1",
  requested_at: "2026-09-13T12:00:00.000Z",
  request_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  summary: "implement the lifecycle record",
  classification: "build",
  confidence: "high",
  disposition: "admit",
  route_category: "seed-quick",
  rationale: "bounded implementation task",
  requires_plan: true,
  requires_review: true,
  refusal: null,
};

const base = { schema_version: 1 as const, intent_id: "intent-1", decision_id: "decision-1", occurred_at: "2026-09-13T12:00:01.000Z", actor_id: "crown", correlation_id: "corr-1" };
const decided: IntentLifecycleRecord = { ...base, record_id: "record-0", sequence: 0, phase: "intent", kind: "intent.decided", decision };
const planned: IntentLifecycleRecord = { ...base, record_id: "record-1", sequence: 1, phase: "plan", kind: "intent.planned", plan_id: "plan-1", action_ids: ["action-1"], plan_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
const reviewed: IntentLifecycleRecord = { ...base, record_id: "record-2", sequence: 2, phase: "review", kind: "intent.reviewed", reviewer_id: "lenticel", verdict: "approved", rationale: "scope and checks are sufficient" };
const dispatched: IntentLifecycleRecord = { ...base, record_id: "record-3", sequence: 3, phase: "dispatch", kind: "intent.dispatched", operation_id: "op-1", agent_id: "seed", worktree_id: "wt-1" };
const verified: IntentLifecycleRecord = { ...base, record_id: "record-4", sequence: 4, phase: "verify", kind: "intent.verified", operation_id: "op-1", verification: { tag: "verified", cmd: "bun test", exit: 0, stdout_hash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" }, summary: "tests passed" };

describe("intent lifecycle ledger", () => {
  it("accepts and round-trips the complete intent through verification path", () => {
    let ledger = null;
    for (const record of [decided, planned, reviewed, dispatched, verified]) {
      const result = appendIntentLifecycleRecord(ledger, record);
      expect(result.ok).toBe(true);
      if (result.ok) ledger = result.ledger;
    }
    expect(ledger).not.toBeNull();
    const restored = parseIntentLedger(JSON.parse(serializeIntentLedger(ledger!)));
    expect(restored).toEqual(ledger);
  });

  it("records an explicit refusal and rejects any later stage", () => {
    const first = appendIntentLifecycleRecord(null, decided);
    expect(first.ok).toBe(true);
    const refusal: IntentLifecycleRecord = { ...base, record_id: "record-1", sequence: 1, phase: "refusal", kind: "intent.refused", from_phase: "intent", refusal: { code: "ambiguous", reason: "operator clarification is required", retryable: true } };
    const refused = appendIntentLifecycleRecord(first.ok ? first.ledger : null, refusal);
    expect(refused.ok).toBe(true);
    const after = appendIntentLifecycleRecord(refused.ok ? refused.ledger : null, planned);
    expect(after).toMatchObject({ ok: false, violations: expect.arrayContaining([expect.objectContaining({ code: "terminal" })]) });
  });

  it("rejects gaps, phase skips, mismatched identities, and malformed persisted records", () => {
    const first = appendIntentLifecycleRecord(null, decided);
    expect(first.ok).toBe(true);
    const gap = appendIntentLifecycleRecord(first.ok ? first.ledger : null, { ...reviewed, sequence: 2 });
    expect(gap).toMatchObject({ ok: false, violations: expect.arrayContaining([expect.objectContaining({ code: "sequence" })]) });
    expect(parseIntentLedger({ schema_version: 1, intent_id: "intent-1", decision_id: "decision-1", records: [{ ...decided, decision: { ...decision, classification: "invented" } }] })).toBeNull();
    expect(parseIntentLedger({ schema_version: 1, intent_id: "other", decision_id: "decision-1", records: [decided] })).toBeNull();
  });
});
