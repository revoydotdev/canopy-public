import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RepoFlightDeliveryAdapter, type RepoFlightDeliveryState, type RepoFlightDeliveryTransitionInput, type RepoFlightSentInput } from "../src/repo-flight-delivery.js";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function directory(): string { const path = mkdtempSync(join(tmpdir(), "repo-flight-delivery-")); directories.push(path); return path; }

function sent(overrides: Partial<RepoFlightSentInput> = {}): RepoFlightSentInput {
  return {
    event_id: "delivery-event:sent:1", idempotency_key: "delivery-idem:sent:1", occurred_at: "2026-08-28T13:00:00.000Z",
    delivery_id: "delivery:1",
    message: { id: "message:1", conversation_id: "parent-child:root:child", recipient_node_ids: ["child"], as_of: "2026-08-28T12:59:59.000Z" },
    thread_version: "message:1", target_recipient_node_id: "child", target_instance_id: "agent:v1:child",
    repo_run_id: "repo-run:1", operation_id: "operation:1", operation_attempt_id: "attempt:1",
    ...overrides,
  };
}

function transition(from: RepoFlightDeliveryState, to: Exclude<RepoFlightDeliveryState, "sent">, sequence: number): RepoFlightDeliveryTransitionInput {
  return {
    event_id: `delivery-event:${sequence}`, idempotency_key: `delivery-idem:${sequence}`, occurred_at: `2026-08-28T13:00:0${sequence}.000Z`,
    delivery_id: "delivery:1", expected_state: from, to, actor_instance_id: "agent:v1:child",
  };
}

describe("RepoFlightDeliveryAdapter", () => {
  it("projects the causal receipt chain and keeps acknowledgement distinct from completion", () => {
    const adapter = new RepoFlightDeliveryAdapter();
    expect(adapter.recordSent(sent())).toMatchObject({ ok: true, projection: { state: "sent", thread_version: "message:1", target_instance_id: "agent:v1:child", operation_attempt_id: "attempt:1" } });
    expect(adapter.transition(transition("sent", "claimed", 1))).toMatchObject({ ok: true, projection: { state: "claimed" } });
    expect(adapter.transition(transition("claimed", "delivered", 2))).toMatchObject({ ok: true, projection: { state: "delivered" } });
    const acknowledged = adapter.transition(transition("delivered", "acknowledged", 3));
    expect(acknowledged).toMatchObject({ ok: true, projection: { state: "acknowledged", acknowledged: true, completion: null } });
    expect(adapter.transition(transition("acknowledged", "applied", 4))).toMatchObject({ ok: true, projection: { state: "applied", acknowledged: true, completion: { outcome: "applied", actor_instance_id: "agent:v1:child" } } });
  });

  it("replays exact retries and rejects semantic duplicates with a new key", () => {
    const adapter = new RepoFlightDeliveryAdapter();
    const first = sent();
    expect(adapter.recordSent(first)).toMatchObject({ ok: true, replayed: false });
    expect(adapter.recordSent(first)).toMatchObject({ ok: true, replayed: true });
    const claim = transition("sent", "claimed", 1);
    expect(adapter.transition(claim)).toMatchObject({ ok: true, replayed: false });
    expect(adapter.transition(claim)).toMatchObject({ ok: true, replayed: true });
    expect(adapter.transition({ ...claim, event_id: "delivery-event:claim:duplicate", idempotency_key: "delivery-idem:claim:duplicate" })).toMatchObject({ ok: false, code: "duplicate_transition" });
    expect(adapter.list()).toHaveLength(1);
  });

  it("rejects out-of-order and illegal transitions", () => {
    const adapter = new RepoFlightDeliveryAdapter();
    expect(adapter.transition(transition("sent", "claimed", 1))).toMatchObject({ ok: false, code: "out_of_order" });
    expect(adapter.recordSent(sent()).ok).toBe(true);
    expect(adapter.transition(transition("sent", "delivered", 2))).toMatchObject({ ok: false, code: "illegal_transition" });
    expect(adapter.transition(transition("claimed", "delivered", 3))).toMatchObject({ ok: false, code: "out_of_order" });
    expect(adapter.inspect("delivery:1")?.state).toBe("sent");
  });

  it("binds only an actual ConversationBus recipient and rejects open schema", () => {
    const adapter = new RepoFlightDeliveryAdapter();
    expect(adapter.recordSent(sent({ target_recipient_node_id: "stranger" }))).toMatchObject({ ok: false, code: "invalid_input" });
    expect(adapter.recordSent(sent({ thread_version: "message:stale" }))).toMatchObject({ ok: false, code: "invalid_input" });
    expect(adapter.recordSent({ ...sent(), ungoverned_payload: "secret" } as RepoFlightSentInput)).toMatchObject({ ok: false, code: "invalid_input" });
    expect(adapter.list()).toEqual([]);
  });

  it("accepts a full bus projection but persists no payload preview", () => {
    const persistence_dir = directory();
    const adapter = new RepoFlightDeliveryAdapter({ persistence_dir });
    const input = sent();
    const message = { ...input.message, payload_preview: { content: "token=must-not-persist", provenance_tag: "claimed", evidence_refs: [] }, kind: "steer", capability_tier: "orchestrator" };
    expect(adapter.recordSent({ ...input, message })).toMatchObject({ ok: true });
    const durable = readFileSync(join(persistence_dir, "repo-flight-delivery.jsonl"), "utf8");
    expect(durable).not.toContain("must-not-persist");
    expect(durable).not.toContain("payload_preview");
    expect(adapter.inspect("delivery:1")).not.toHaveProperty("message");
  });

  it("durably replays the same bounded projection and fails closed on a corrupt tail", () => {
    const persistence_dir = directory();
    const first = new RepoFlightDeliveryAdapter({ persistence_dir });
    expect(first.recordSent(sent()).ok).toBe(true);
    expect(first.transition(transition("sent", "claimed", 1)).ok).toBe(true);
    const replayed = new RepoFlightDeliveryAdapter({ persistence_dir });
    expect(replayed.replayDiagnostics()).toEqual([]);
    expect(replayed.inspect("delivery:1")).toEqual(first.inspect("delivery:1"));
    appendFileSync(join(persistence_dir, "repo-flight-delivery.jsonl"), "{\"version\":1", "utf8");
    const corrupt = new RepoFlightDeliveryAdapter({ persistence_dir });
    expect(corrupt.inspect("delivery:1")?.state).toBe("claimed");
    expect(corrupt.isAppendable()).toBe(false);
    expect(corrupt.transition(transition("claimed", "delivered", 2))).toMatchObject({ ok: false, code: "corrupt_store" });
  });

  it("does not lose a receipt when another controller advances the journal", () => {
    const persistence_dir = directory();
    const first = new RepoFlightDeliveryAdapter({ persistence_dir });
    const stale = new RepoFlightDeliveryAdapter({ persistence_dir });
    expect(first.recordSent(sent()).ok).toBe(true);
    expect(stale.recordSent(sent({ delivery_id: "delivery:2", event_id: "delivery-event:sent:2", idempotency_key: "delivery-idem:sent:2" }))).toMatchObject({ ok: false, code: "concurrent_advance" });
    expect(new RepoFlightDeliveryAdapter({ persistence_dir }).list().map((value) => value.delivery_id)).toEqual(["delivery:1"]);
  });

  it("rejects target receipts from another agent instance and time-regressing events", () => {
    const adapter = new RepoFlightDeliveryAdapter();
    expect(adapter.recordSent(sent()).ok).toBe(true);
    expect(adapter.transition({ ...transition("sent", "claimed", 1), actor_instance_id: "agent:v1:other" })).toMatchObject({ ok: false, code: "actor_mismatch" });
    expect(adapter.transition({ ...transition("sent", "claimed", 1), occurred_at: "2026-08-28T12:00:00.000Z" })).toMatchObject({ ok: false, code: "out_of_order" });
    expect(adapter.inspect("delivery:1")?.state).toBe("sent");
  });
});
