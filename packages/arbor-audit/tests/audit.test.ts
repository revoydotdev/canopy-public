import { describe, it, expect } from "vitest";
import { EvidenceLedger, validateGateCheckpoint } from "../src/audit.js";
import type { Provenance, NodeState, GateRecord } from "@arbor/core";

function makePacket(overrides: Partial<Parameters<EvidenceLedger["record"]>[0]> = {}) {
  return {
    campaign_id: "camp1",
    node_id: "node_1",
    timestamp: new Date().toISOString(),
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

describe("EvidenceLedger record + getCampaign", () => {
  it("records a trace packet and retrieves it by campaign", () => {
    const ledger = new EvidenceLedger();
    const id = ledger.record(makePacket());
    expect(id).toBeDefined();

    const campaign = ledger.getCampaign("camp1");
    expect(campaign).toHaveLength(1);
    expect(campaign[0].node_id).toBe("node_1");
  });

  it("records multiple packets for the same campaign", () => {
    const ledger = new EvidenceLedger();
    ledger.record(makePacket({ node_id: "node_1" }));
    ledger.record(makePacket({ node_id: "node_2", node_state_after: "failed" }));

    const campaign = ledger.getCampaign("camp1");
    expect(campaign).toHaveLength(2);
  });
});

describe("EvidenceLedger record idempotency (Track D2b)", () => {
  it("ATTACK WITHOUT FIX: replaying record() with no idempotency_key creates two distinct entries", () => {
    // Documents the pre-existing, still-supported behavior when a caller
    // opts out of idempotency entirely (omits the key). This is not a bug —
    // it is the exact backward-compatible default every packet recorded
    // before this field existed already relies on.
    const ledger = new EvidenceLedger();
    const packet = makePacket({ node_id: "nodeX" });
    const id1 = ledger.record(packet);
    const id2 = ledger.record(packet);
    expect(id1).not.toBe(id2);
    expect(ledger.getCampaign("camp1")).toHaveLength(2);
  });

  it("FIX HOLDS: replaying record() with the same idempotency_key and identical content is a detectable no-op", () => {
    const ledger = new EvidenceLedger();
    const packet = makePacket({ node_id: "nodeX", idempotency_key: "expand-nodeX-attempt-1" });
    const id1 = ledger.record(packet);
    const id2 = ledger.record(packet); // exact retry, e.g. after an ambiguous network failure
    expect(id2).toBe(id1);
    expect(ledger.getCampaign("camp1")).toHaveLength(1);
    expect(ledger.verifyIntegrity()).toMatchObject({ valid: true, packet_count: 1 });
  });

  it("FIX HOLDS: a retry under the same key with different content is a loud conflict, never a silent overwrite", () => {
    const ledger = new EvidenceLedger();
    ledger.record(makePacket({ node_id: "nodeX", idempotency_key: "expand-nodeX-attempt-1", score_after: 42 }));
    expect(() =>
      ledger.record(makePacket({ node_id: "nodeX", idempotency_key: "expand-nodeX-attempt-1", score_after: 999 })),
    ).toThrow("conflicting trace packet for idempotency key expand-nodeX-attempt-1");
    // The original record is untouched — no silent overwrite occurred.
    expect(ledger.getCampaign("camp1")).toHaveLength(1);
    expect(ledger.getCampaign("camp1")[0].score_after).toBe(42);
  });

  it("scopes idempotency keys per campaign, not globally", () => {
    const ledger = new EvidenceLedger();
    const id1 = ledger.record(makePacket({ campaign_id: "campA", node_id: "n1", idempotency_key: "same-key" }));
    const id2 = ledger.record(makePacket({ campaign_id: "campB", node_id: "n1", idempotency_key: "same-key" }));
    expect(id1).not.toBe(id2);
    expect(ledger.getCampaign("campA")).toHaveLength(1);
    expect(ledger.getCampaign("campB")).toHaveLength(1);
  });

  it("rejects a blank idempotency_key rather than silently treating it as absent", () => {
    const ledger = new EvidenceLedger();
    expect(() => ledger.record(makePacket({ idempotency_key: "   " }))).toThrow(
      "idempotency_key must be a non-empty string",
    );
  });

  it("round-trips an idempotency_key through JSONL and still verifies", () => {
    const ledger = new EvidenceLedger();
    ledger.record(makePacket({ node_id: "nodeX", idempotency_key: "key-1" }));
    const restored = new EvidenceLedger();
    restored.fromJSONL(ledger.toJSONL());
    expect(restored.verifyIntegrity()).toMatchObject({ valid: true, packet_count: 1 });
    expect(restored.getCampaign("camp1")[0].idempotency_key).toBe("key-1");
  });

  it("a legacy packet with no idempotency_key at all still verifies (backward compatibility)", () => {
    const ledger = new EvidenceLedger();
    ledger.record(makePacket({ node_id: "legacy" })); // no idempotency_key field
    expect(ledger.verifyIntegrity()).toMatchObject({ valid: true, packet_count: 1 });
    expect(ledger.getCampaign("camp1")[0].idempotency_key).toBeUndefined();
  });
});

describe("EvidenceLedger getNode", () => {
  it("returns the packet for a specific node", () => {
    const ledger = new EvidenceLedger();
    ledger.record(makePacket({ node_id: "node_1" }));
    ledger.record(makePacket({ node_id: "node_2" }));

    const packet = ledger.getNode("camp1", "node_1");
    expect(packet).not.toBeNull();
    expect(packet!.node_id).toBe("node_1");
  });

  it("returns null for a non-existent node", () => {
    const ledger = new EvidenceLedger();
    expect(ledger.getNode("camp1", "nonexistent")).toBeNull();
  });
});

describe("EvidenceLedger getBypasses", () => {
  it("returns only packets with bypassed gates", () => {
    const ledger = new EvidenceLedger();
    ledger.record(makePacket({ node_id: "node_1", gates: [] }));
    ledger.record(makePacket({
      node_id: "node_2",
      gates: [{
        gate: "isolation",
        result: "bypass",
        checked_at: new Date().toISOString(),
        detail: "worktree check unavailable",
        bypass_evidence_deficit: "need git integration",
      }],
    }));

    const bypasses = ledger.getBypasses("camp1");
    expect(bypasses).toHaveLength(1);
    expect(bypasses[0].node_id).toBe("node_2");
  });

  it("returns empty when no bypasses exist", () => {
    const ledger = new EvidenceLedger();
    ledger.record(makePacket());
    expect(ledger.getBypasses("camp1")).toHaveLength(0);
  });
});

describe("EvidenceLedger JSONL round-trip", () => {
  it("serializes and re-imports preserving all packets", () => {
    const ledger1 = new EvidenceLedger();
    ledger1.record(makePacket({ node_id: "node_1" }));
    ledger1.record(makePacket({ node_id: "node_2", node_state_after: "failed" }));

    const jsonl = ledger1.toJSONL();

    const ledger2 = new EvidenceLedger();
    const imported = ledger2.fromJSONL(jsonl);
    expect(imported).toBe(2);

    const campaign = ledger2.getCampaign("camp1");
    expect(campaign).toHaveLength(2);
  });

  it("fromJSONL is idempotent", () => {
    const ledger1 = new EvidenceLedger();
    ledger1.record(makePacket());
    const jsonl = ledger1.toJSONL();

    const ledger2 = new EvidenceLedger();
    ledger2.fromJSONL(jsonl);
    const second = ledger2.fromJSONL(jsonl);
    expect(second).toBe(0);
  });
});

describe("EvidenceLedger integrity", () => {
  it("builds a valid hash chain across trace packets", () => {
    const ledger = new EvidenceLedger();
    ledger.record(makePacket({ node_id: "n1" }));
    ledger.record(makePacket({ node_id: "n2" }));

    const packets = ledger.getCampaign("camp1");
    expect(packets[0].previous_hash).toBeNull();
    expect(packets[1].previous_hash).toBe(packets[0].content_hash);
    expect(ledger.verifyIntegrity()).toEqual({ valid: true, packet_count: 2, error: null });
  });

  it("maintains independent chains for interleaved campaigns", () => {
    const ledger = new EvidenceLedger();
    ledger.record(makePacket({ campaign_id: "camp1", node_id: "a1" }));
    ledger.record(makePacket({ campaign_id: "camp2", node_id: "b1" }));
    ledger.record(makePacket({ campaign_id: "camp1", node_id: "a2" }));

    const firstCampaign = ledger.getCampaign("camp1");
    const secondCampaign = ledger.getCampaign("camp2");
    expect(firstCampaign[1].previous_hash).toBe(firstCampaign[0].content_hash);
    expect(secondCampaign[0].previous_hash).toBeNull();
    expect(ledger.verifyIntegrity().valid).toBe(true);
  });

  it("detects a tampered packet after JSONL import", () => {
    const source = new EvidenceLedger();
    source.record(makePacket({ node_id: "n1" }));
    source.record(makePacket({ node_id: "n2" }));
    const rows = source.toJSONL().split("\n");
    const altered = JSON.parse(rows[0]) as { action_description: string };
    altered.action_description = "tampered action";
    rows[0] = JSON.stringify(altered);

    const imported = new EvidenceLedger();
    imported.fromJSONL(rows.join("\n"));
    expect(imported.verifyIntegrity()).toMatchObject({ valid: false });
    expect(imported.verifyIntegrity().error).toContain("content hash does not match");
  });

  it("preserves a gate snapshot when the caller later mutates its input", () => {
    const ledger = new EvidenceLedger();
    const gates: GateRecord[] = [{
      gate: "evidence",
      result: "bypass",
      checked_at: new Date().toISOString(),
      detail: "original evidence deficit",
      bypass_evidence_deficit: "verification unavailable",
    }];
    ledger.record(makePacket({ gates }));
    gates[0].detail = "mutated after audit record";

    expect(ledger.getCampaign("camp1")[0].gates[0].detail).toBe("original evidence deficit");
    expect(ledger.verifyIntegrity().valid).toBe(true);
  });
});

describe("EvidenceLedger gate checkpoints", () => {
  const gate = {
    gate: "evidence" as const,
    result: "pass" as const,
    checked_at: "2026-08-01T12:00:00.000Z",
    detail: "verification command completed",
  };

  it("records, replays, and deduplicates a durable pre-transition checkpoint", () => {
    const ledger = new EvidenceLedger();
    const input = {
      campaign_id: "camp1",
      node_id: "node_1",
      transition: "node_verification" as const,
      operation_id: "verify-node-1-attempt-1",
      gate,
      failures: [],
      unresolved: ["provenance source temporarily unavailable"],
    };
    const id = ledger.recordGateCheckpoint(input);
    expect(ledger.recordGateCheckpoint(input)).toBe(id);

    const checkpoints = ledger.getGateCheckpoints("camp1");
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].checkpoint).toEqual({
      transition: "node_verification",
      operation_id: "verify-node-1-attempt-1",
      gate,
      failures: [],
      unresolved: ["provenance source temporarily unavailable"],
    });
    expect(new EvidenceLedger().fromJSONL(ledger.toJSONL())).toBe(1);
  });

  it("requires a checkpoint before recording the governed transition", () => {
    const ledger = new EvidenceLedger();
    const packet = makePacket({ node_id: "node_1" });
    expect(() => ledger.recordGovernedTransition("node_verification", "op-1", packet))
      .toThrow("missing durable evidence gate checkpoint");

    ledger.recordGateCheckpoint({
      campaign_id: "camp1",
      node_id: "node_1",
      transition: "node_verification",
      operation_id: "op-1",
      gate,
    });
    expect(ledger.recordGovernedTransition("node_verification", "op-1", packet)).toBeDefined();
    expect(ledger.getCampaign("camp1")).toHaveLength(1);
    expect(ledger.getRecords("camp1")).toHaveLength(2);
  });

  it("rejects wrong gate type and conflicting replay for a transition", () => {
    const ledger = new EvidenceLedger();
    expect(() => ledger.recordGateCheckpoint({
      campaign_id: "camp1",
      node_id: "node_1",
      transition: "node_verification",
      operation_id: "op-1",
      gate: { ...gate, gate: "isolation" },
    })).toThrow("requires evidence gate evidence");

    ledger.recordGateCheckpoint({
      campaign_id: "camp1",
      node_id: "node_1",
      transition: "node_verification",
      operation_id: "op-1",
      gate,
    });
    expect(() => ledger.recordGateCheckpoint({
      campaign_id: "camp1",
      node_id: "node_1",
      transition: "node_verification",
      operation_id: "op-1",
      gate: { ...gate, detail: "different result evidence" },
    })).toThrow("conflicting gate checkpoint");
  });

  it("does not let a failed checkpoint authorize its transition", () => {
    const ledger = new EvidenceLedger();
    ledger.recordGateCheckpoint({
      campaign_id: "camp1",
      node_id: "node_1",
      transition: "node_verification",
      operation_id: "op-failed",
      gate: { ...gate, result: "fail", detail: "verification command failed" },
    });
    expect(() => ledger.recordGovernedTransition(
      "node_verification",
      "op-failed",
      makePacket({ node_id: "node_1" }),
    )).toThrow("durable evidence gate failed");
  });

  it("detects checkpoint tampering during replay", () => {
    const source = new EvidenceLedger();
    source.recordGateCheckpoint({
      campaign_id: "camp1",
      node_id: "node_1",
      transition: "node_verification",
      operation_id: "op-1",
      gate,
    });
    const tampered = JSON.parse(source.toJSONL()) as { checkpoint: { operation_id: string } };
    tampered.checkpoint.operation_id = "tampered";
    const imported = new EvidenceLedger();
    imported.fromJSONL(JSON.stringify(tampered));
    expect(imported.verifyIntegrity()).toMatchObject({ valid: false });
  });
});

describe("adversarial gate checkpoint validation", () => {
  const checkpoint = (deficit: string) => ({
    campaign_id: "camp1", node_id: "node1", operation_id: "op1", transition: "node_expansion" as const,
    gate: { gate: "isolation" as const, result: "bypass" as const, checked_at: "2026-09-23T00:00:00.000Z", detail: "probe unavailable", bypass_evidence_deficit: deficit },
  });

  it.each(["", "  \n\t"])("rejects a bypass whose evidence deficit is %j", (deficit) => {
    expect(() => validateGateCheckpoint(checkpoint(deficit))).toThrow(/invalid gate record/);
  });

  it("accepts a bypass only when a specific deficit survives checkpoint validation", () => {
    expect(() => validateGateCheckpoint(checkpoint("worktree proof unavailable"))).not.toThrow();
  });
});

describe("EvidenceLedger recovery decisions", () => {
  function decision(overrides: Partial<Parameters<EvidenceLedger["recordRecoveryDecision"]>[0]> = {}) {
    return {
      campaign_id: "camp1",
      node_id: "node_1",
      recovery_operation_id: "recover-node-1-attempt-2",
      decision: "retry" as const,
      actor: "crown",
      authority: "crown" as const,
      reason: "specialist process ended without a terminal trace",
      prior_operation_id: "expand-node-1-attempt-1",
      new_operation_id: "expand-node-1-attempt-2",
      expected_version: "v1",
      observed_version: "v1",
      lease: { previous: "inactive" as const, new_lease_id: "lease-2" },
      isolation: { result: "pass" as const, checkpoint_operation_id: "expand-node-1-attempt-2", evidence_deficit: null },
      outcome: "authorized" as const,
      ...overrides,
    };
  }

  it("records a discriminated recovery authority record without fabricating a trace", () => {
    const ledger = new EvidenceLedger();
    const id = ledger.recordRecoveryDecision(decision());
    expect(id).toMatch(/^recovery_/);
    expect(ledger.getCampaign("camp1")).toEqual([]);
    expect(ledger.getRecoveryDecisions("camp1", "node_1")).toMatchObject([{
      kind: "recovery_decision", decision: { outcome: "authorized", actor: "crown" },
    }]);
    expect(ledger.verifyIntegrity().valid).toBe(true);
  });

  it("is idempotent by recovery operation and rejects a conflicting decision", () => {
    const ledger = new EvidenceLedger();
    const input = decision();
    expect(ledger.recordRecoveryDecision(input)).toBe(ledger.recordRecoveryDecision({ ...input, timestamp: "2026-08-01T12:01:00.000Z" }));
    expect(() => ledger.recordRecoveryDecision({ ...input, outcome: "blocked" })).toThrow("conflicting recovery decision");
  });

  it("replays in the campaign hash chain and detects decision tampering or reordering", () => {
    const source = new EvidenceLedger();
    source.record(makePacket({ node_id: "before" }));
    source.recordRecoveryDecision(decision());
    source.record(makePacket({ node_id: "after" }));
    const rows = source.toJSONL().split("\n");
    const imported = new EvidenceLedger();
    imported.fromJSONL(rows.join("\n"));
    expect(imported.verifyIntegrity().valid).toBe(true);

    const tamperedRows = [...rows];
    const tampered = JSON.parse(tamperedRows[1]) as { decision: { outcome: string } };
    tampered.decision.outcome = "blocked";
    tamperedRows[1] = JSON.stringify(tampered);
    const altered = new EvidenceLedger();
    altered.fromJSONL(tamperedRows.join("\n"));
    expect(altered.verifyIntegrity()).toMatchObject({ valid: false });

    const reordered = new EvidenceLedger();
    reordered.fromJSONL([rows[1], rows[0], rows[2]].join("\n"));
    expect(reordered.verifyIntegrity()).toMatchObject({ valid: false });
  });
});

describe("EvidenceLedger stats", () => {
  it("returns correct counts per outcome", () => {
    const ledger = new EvidenceLedger();
    ledger.record(makePacket({ node_id: "n1", node_state_after: "verified" }));
    ledger.record(makePacket({ node_id: "n2", node_state_after: "claimed" }));
    ledger.record(makePacket({ node_id: "n3", node_state_after: "failed" }));
    ledger.record(makePacket({ node_id: "n4", node_state_after: "pruned" }));

    const stats = ledger.stats("camp1");
    expect(stats.total).toBe(4);
    expect(stats.verified).toBe(1);
    expect(stats.claimed).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.pruned).toBe(1);
    expect(stats.bypassed).toBe(0);
  });
});
