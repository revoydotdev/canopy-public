/**
 * arbor-audit/tests/hash-chain-integrity.test.ts — Phase 5.2 hash-chain validation.
 *
 * Asserts that the evidence ledger's append-only hash chain detects, on replay
 * via `verifyIntegrity()`:
 *
 *   - tampering (content mutation),
 *   - reordering (swapping packets),
 *   - duplication (inserting a copy),
 *   - middle truncation (removing a packet breaks the chain),
 *   - cross-campaign pointers (a witness referenced from another campaign).
 *
 * Also covers over-1,000-record cursor paging and snapshot stability on the
 * telemetry query path (bounded, deterministic — no wall-clock sleeps).
 */

import { describe, it, expect } from "vitest";
import { EvidenceLedger, type TelemetryObservationInput } from "../src/index.js";
import type { Provenance, NodeState, GateRecord } from "@arbor/core";

function makePacket(overrides: Partial<Parameters<EvidenceLedger["record"]>[0]> = {}) {
  return {
    campaign_id: "camp1",
    node_id: "node_1",
    timestamp: "2026-08-01T00:00:00.000Z",
    action_description: "refactor auth",
    action_category: "refactor",
    specialist_agent: "seed",
    critic_agent: "lenticel",
    node_state_before: "expanding" as NodeState,
    node_state_after: "verified" as NodeState,
    provenance: { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test"} as Provenance,
    specialist_output: "all tests passed",
    critic_verdict_approved: true,
    critic_root_cause: null,
    score_before: 0,
    score_after: 42,
    gates: [] as GateRecord[],
    kb_entries_written: ["kb_1"],
    ...overrides,
  };
}

/** Build a ledger with N packets in one campaign and return its JSONL. */
function buildLedger(n: number): EvidenceLedger {
  const ledger = new EvidenceLedger();
  for (let i = 0; i < n; i++) {
    ledger.record(makePacket({ node_id: `node_${i}`, action_description: `action ${i}` }));
  }
  return ledger;
}

describe("hash-chain integrity: valid ledger", () => {
  it("a freshly recorded ledger verifies as valid", () => {
    const ledger = buildLedger(3);
    expect(ledger.verifyIntegrity()).toMatchObject({ valid: true, packet_count: 3, error: null });
  });

  it("a JSONL round-trip preserves integrity", () => {
    const ledger = buildLedger(3);
    const restored = new EvidenceLedger();
    restored.fromJSONL(ledger.toJSONL());
    expect(restored.verifyIntegrity()).toEqual(ledger.verifyIntegrity());
  });
});

describe("hash-chain integrity: tamper detection", () => {
  it("detects a mutated packet on replay", () => {
    const ledger = buildLedger(3);
    const rows = ledger.toJSONL().split("\n");
    const altered = JSON.parse(rows[1]) as { action_description: string };
    altered.action_description = "tampered";
    rows[1] = JSON.stringify(altered);

    const tampered = new EvidenceLedger();
    tampered.fromJSONL(rows.join("\n"));
    expect(tampered.verifyIntegrity()).toMatchObject({
      valid: false,
      error: expect.stringContaining("content hash does not match"),
    });
  });

  it("detects a mutated provenance field on replay", () => {
    const ledger = buildLedger(2);
    const rows = ledger.toJSONL().split("\n");
    const altered = JSON.parse(rows[0]) as { provenance: { exit: number } };
    altered.provenance.exit = 1;
    rows[0] = JSON.stringify(altered);

    const tampered = new EvidenceLedger();
    tampered.fromJSONL(rows.join("\n"));
    expect(tampered.verifyIntegrity()).toMatchObject({ valid: false });
  });
});

describe("hash-chain integrity: reorder detection", () => {
  it("detects swapped packets on replay", () => {
    const ledger = buildLedger(3);
    const rows = ledger.toJSONL().split("\n");
    // Swap the first two packets.
    [rows[0], rows[1]] = [rows[1], rows[0]];

    const reordered = new EvidenceLedger();
    reordered.fromJSONL(rows.join("\n"));
    expect(reordered.verifyIntegrity()).toMatchObject({
      valid: false,
      error: expect.stringContaining("invalid predecessor hash"),
    });
  });
});

describe("hash-chain integrity: duplicate detection", () => {
  it("detects an inserted duplicate packet on replay", () => {
    const ledger = buildLedger(3);
    const rows = ledger.toJSONL().split("\n");
    // Insert a copy of the second packet with a NEW id (fromJSONL dedupes by
    // id, so a true duplicate must carry a distinct id to enter the chain).
    const copy = JSON.parse(rows[1]) as { id: string };
    copy.id = "trace_duplicate";
    rows.splice(2, 0, JSON.stringify(copy));

    const duplicated = new EvidenceLedger();
    duplicated.fromJSONL(rows.join("\n"));
    expect(duplicated.verifyIntegrity()).toMatchObject({
      valid: false,
      error: expect.stringContaining("invalid predecessor hash"),
    });
  });
});

describe("hash-chain integrity: truncation detection", () => {
  it("detects a middle truncation (removed packet breaks the chain)", () => {
    const ledger = buildLedger(4);
    const rows = ledger.toJSONL().split("\n");
    // Remove the second packet: the third packet's predecessor hash no longer
    // matches the running chain.
    rows.splice(1, 1);

    const truncated = new EvidenceLedger();
    truncated.fromJSONL(rows.join("\n"));
    expect(truncated.verifyIntegrity()).toMatchObject({
      valid: false,
      error: expect.stringContaining("invalid predecessor hash"),
    });
  });
});

describe("hash-chain integrity: cross-campaign pointer", () => {
  it("detects a memory fact whose witness lives in another campaign", () => {
    const ledger = new EvidenceLedger();
    // Witness in campaign A.
    const witnessA = ledger.record(makePacket({ campaign_id: "campA", node_id: "nodeA" }));
    // Attempt to journal a memory fact in campaign B referencing A's witness.
    expect(() =>
      ledger.recordMemoryFact({
        campaign_id: "campB",
        node_id: "nodeB",
        scope: { kind: "campaign" },
        type: "failure_mode",
        content: "cross-campaign leak",
        provenance: { tag: "verified", cmd: "test", exit: 0, stdout_hash: "sha256:test"},
        tier: "specialist_visible",
        source_evidence_id: witnessA,
        idempotency_key: "fact-1",
        tags: [],
      }),
    ).toThrow("not witnessed in campaign campB");
  });

  it("detects a cross-campaign witness on replay of a tampered ledger", () => {
    const ledger = new EvidenceLedger();
    const witnessA = ledger.record(makePacket({ campaign_id: "campA", node_id: "nodeA" }));
    // Legitimately journal a fact in campA.
    ledger.recordMemoryFact({
      campaign_id: "campA",
      node_id: "nodeA",
      scope: { kind: "campaign" },
      type: "failure_mode",
      content: "legit fact",
      provenance: { tag: "verified", cmd: "test", exit: 0, stdout_hash: "sha256:test"},
      tier: "specialist_visible",
      source_evidence_id: witnessA,
      idempotency_key: "fact-1",
      tags: [],
    });
    expect(ledger.verifyIntegrity()).toMatchObject({ valid: true });

    // Tamper: point the fact's witness at a non-existent id.
    const rows = ledger.toJSONL().split("\n");
    const factIndex = rows.findIndex((row) => row.includes('"kind":"memory_fact"'));
    const altered = JSON.parse(rows[factIndex]) as { fact: { source_evidence_id: string } };
    altered.fact.source_evidence_id = "does-not-exist";
    rows[factIndex] = JSON.stringify(altered);

    const tampered = new EvidenceLedger();
    tampered.fromJSONL(rows.join("\n"));
    expect(tampered.verifyIntegrity()).toMatchObject({
      valid: false,
      error: expect.stringContaining("missing or cross-campaign memory witness"),
    });
  });
});

describe("over-1,000-record cursor paging and snapshot stability", () => {
  function source(ledger: EvidenceLedger, campaign = "campaign"): string {
    return ledger.record({ campaign_id: campaign, node_id: "node", timestamp: "2026-08-01T00:00:00.000Z",
      action_description: "source", action_category: "test", specialist_agent: "seed", critic_agent: null,
      node_state_before: "expanding", node_state_after: "verified", provenance: { tag: "verified", cmd: "test", exit: 0, stdout_hash: "sha256:test"},
      specialist_output: null, critic_verdict_approved: true, critic_root_cause: null, score_before: 0, score_after: 1,
      gates: [], kb_entries_written: [] });
  }

  function timing(witness: string, i: number): TelemetryObservationInput {
    return { campaign_id: "campaign", node_id: "node", operation_id: `op-${i}`, epoch: 1, type: "phase_timing",
      phase: "expand", outcome: "success", duration_ms: i, source_evidence_id: witness, idempotency_key: `timing-${i}`,
      provenance: { tag: "verified", cmd: "clock", exit: 0, stdout_hash: "sha256:test"}, timestamp: "2026-08-01T00:00:00.000Z" };
  }

  it("pages through more than 1,000 telemetry records with a bounded limit", () => {
    const ledger = new EvidenceLedger();
    const witness = source(ledger);
    const total = 1_250;
    for (let i = 0; i < total; i++) ledger.recordTelemetryObservation(timing(witness, i));

    expect(ledger.verifyIntegrity()).toMatchObject({ valid: true, packet_count: total + 1 });

    // Page through with a bounded limit (default 1,000).
    const page1 = ledger.getTelemetryObservations("campaign", 1_000);
    expect(page1).toHaveLength(1_000);
    const page2 = ledger.getTelemetryObservations("campaign", 1_000);
    // Snapshot stability: repeated queries return identical detached results.
    expect(page2).toEqual(page1);
    // The last page (slice(-limit)) returns the most recent 1,000 — the tail.
    expect(page1[page1.length - 1].observation.operation_id).toBe(`op-${total - 1}`);
  });

  it("rejects out-of-range paging limits", () => {
    const ledger = new EvidenceLedger();
    const witness = source(ledger);
    ledger.recordTelemetryObservation(timing(witness, 0));
    expect(() => ledger.getTelemetryObservations("campaign", 0)).toThrow("limit must be from 1 to 10000");
    expect(() => ledger.getTelemetryObservations("campaign", 10_001)).toThrow("limit must be from 1 to 10000");
  });
});
