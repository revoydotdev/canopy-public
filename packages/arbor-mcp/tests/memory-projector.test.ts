import { describe, expect, it } from "vitest";
import { EvidenceLedger, type MemoryFactInput } from "@arbor/audit";
import { projectMemoryFacts, projectMemoryFactsPage } from "../src/memory-projector.js";

function source(ledger: EvidenceLedger, campaign = "campaign", node = "root"): string {
  return ledger.record({ campaign_id: campaign, node_id: node, timestamp: "2026-08-01T00:00:00.000Z",
    action_description: "source", action_category: "test", specialist_agent: "seed", critic_agent: null,
    node_state_before: "expanding", node_state_after: "verified", provenance: { tag: "verified", cmd: "test", exit: 0, stdout_hash: "sha256:test"},
    specialist_output: null, critic_verdict_approved: true, critic_root_cause: null, score_before: 0, score_after: 1,
    gates: [], kb_entries_written: [] });
}

function append(ledger: EvidenceLedger, witness: string, overrides: Partial<MemoryFactInput>): void {
  ledger.recordMemoryFact({ campaign_id: "campaign", node_id: "child", scope: { kind: "campaign" },
    type: "success_pattern", content: "bounded fact", provenance: { tag: "verified", cmd: "test", exit: 0, stdout_hash: "sha256:test"},
    tier: "specialist_visible", source_evidence_id: witness, idempotency_key: "fact", tags: ["memory"],
    timestamp: "2026-08-01T00:00:01.000Z", ...overrides });
}

describe("memory projector", () => {
  it("rebuilds an empty projection deterministically with evidence pointers", () => {
    const ledger = new EvidenceLedger(); const witness = source(ledger); append(ledger, witness, {});
    const request = { campaign_id: "campaign", node_ancestry: ["child", "root"], capability: { tier: "specialist" as const } };
    const first = projectMemoryFacts(ledger, request);
    const rebuiltFromEmpty = projectMemoryFacts(ledger, request);
    expect(rebuiltFromEmpty).toEqual(first);
    expect(first[0]).toMatchObject({ value: "bounded fact", provenance: { tag: "verified", stdout_hash: "sha256:test"},
      evidence_pointer: expect.stringMatching(/^audit:campaign:memory_/), source_evidence_pointer: `audit:campaign:${witness}` });
  });

  it("filters campaign, subtree, and critic-only facts without leakage", () => {
    const ledger = new EvidenceLedger(); const witness = source(ledger);
    append(ledger, witness, { idempotency_key: "campaign", content: "public" });
    append(ledger, witness, { idempotency_key: "inside", content: "inside", scope: { kind: "subtree", root_node_id: "root" } });
    append(ledger, witness, { idempotency_key: "outside", content: "outside", scope: { kind: "subtree", root_node_id: "sibling" } });
    append(ledger, witness, { idempotency_key: "secret", content: "critic reasoning", tier: "critic_only" });
    const specialist = projectMemoryFacts(ledger, { campaign_id: "campaign", node_ancestry: ["child", "root"], capability: { tier: "specialist" } });
    expect(specialist.map((entry) => entry.value)).toEqual(["public", "inside"]);
    expect(projectMemoryFacts(ledger, { campaign_id: "campaign", node_ancestry: ["child", "root"], capability: { tier: "critic" } }).map((entry) => entry.value))
      .toEqual(["public", "inside", "critic reasoning"]);
    expect(projectMemoryFacts(ledger, { campaign_id: "other", node_ancestry: ["root"], capability: { tier: "critic" } })).toEqual([]);
  });

  it("is bounded and refuses an untrusted chain", () => {
    const ledger = new EvidenceLedger(); const witness = source(ledger);
    append(ledger, witness, { idempotency_key: "one", content: "one" });
    append(ledger, witness, { idempotency_key: "two", content: "two" });
    expect(projectMemoryFacts(ledger, { campaign_id: "campaign", node_ancestry: [], capability: { tier: "auditor" }, limit: 1 }).map((entry) => entry.value)).toEqual(["two"]);
    const rows = ledger.toJSONL().split("\n"); const altered = JSON.parse(rows[1]) as { fact: { content: string } }; altered.fact.content = "tamper";
    const tampered = new EvidenceLedger(); tampered.fromJSONL([rows[0], JSON.stringify(altered), rows[2]].join("\n"));
    expect(() => projectMemoryFacts(tampered, { campaign_id: "campaign", node_ancestry: [], capability: { tier: "auditor" } })).toThrow("untrusted");
    expect(() => projectMemoryFacts(ledger, { campaign_id: "campaign", node_ancestry: [], capability: { tier: "auditor" }, limit: 1_001 })).toThrow("limit");
  });

  it("reuses only explicitly promoted patterns across campaigns and preserves source identity", () => {
    const sourceLedger = new EvidenceLedger();
    const sourceWitness = source(sourceLedger, "source-campaign", "source-root");
    append(sourceLedger, sourceWitness, {
      campaign_id: "source-campaign", node_id: "source-child", idempotency_key: "promoted",
      scope: { kind: "cross_campaign" }, content: "reuse this verified pattern",
    });
    append(sourceLedger, sourceWitness, {
      campaign_id: "source-campaign", node_id: "source-child", idempotency_key: "local",
      scope: { kind: "campaign" }, content: "source-specific detail",
    });
    append(sourceLedger, sourceWitness, {
      campaign_id: "source-campaign", node_id: "source-child", idempotency_key: "subtree",
      scope: { kind: "subtree", root_node_id: "source-root" }, content: "source branch detail",
    });

    const targetLedger = new EvidenceLedger(); source(targetLedger, "target-campaign", "target-root");
    const projected = projectMemoryFacts([sourceLedger, targetLedger], {
      campaign_id: "target-campaign", node_ancestry: ["target-root"], capability: { tier: "specialist" },
    });
    expect(projected.map((entry) => entry.value)).toEqual(["reuse this verified pattern"]);
    expect(projected[0]).toMatchObject({
      campaign_id: "target-campaign", source_campaign_id: "source-campaign", source_node_id: "source-child",
      evidence_pointer: expect.stringMatching(/^audit:source-campaign:memory_/),
      source_evidence_pointer: `audit:source-campaign:${sourceWitness}`,
      scope: { kind: "cross_campaign" },
    });
  });

  it("retains typed source identity when an independently-approved fact is imported into a target campaign", () => {
    const ledger = new EvidenceLedger(); const witness = source(ledger, "source");
    ledger.recordMemoryFact({
      campaign_id: "source", node_id: "root", scope: { kind: "campaign" }, type: "success_pattern", content: "source pattern",
      provenance: { tag: "verified", cmd: "test", exit: 0, stdout_hash: "sha256:test" }, tier: "specialist_visible",
      source_evidence_id: witness, idempotency_key: "source-fact", tags: ["memory"], timestamp: "2026-08-01T00:00:01.000Z",
    });
    const sourceFact = ledger.getMemoryFacts("source")[0]!;
    ledger.recordMemoryFact({
      campaign_id: "target", node_id: "root", scope: { kind: "campaign" }, type: "success_pattern", content: "source pattern",
      provenance: { tag: "verified", cmd: "test", exit: 0, stdout_hash: "sha256:test" }, tier: "specialist_visible",
      source_evidence_id: witness, idempotency_key: "target-import", tags: ["memory"], timestamp: "2026-08-01T00:00:01.000Z",
      imported_from: { campaign_id: "source", memory_fact_id: sourceFact.id, requested_by: "crown", approved_by: "lenticel" },
    });
    const projected = projectMemoryFacts(ledger, { campaign_id: "target", node_ancestry: ["root"], capability: { tier: "specialist" } });
    expect(projected[0]).toMatchObject({
      value: "source pattern",
      imported_from: { campaign_id: "source", memory_fact_id: sourceFact.id, requested_by: "crown", approved_by: "lenticel" },
    });
  });

  it("reuses an explicitly promoted failure while isolating an ordinary campaign failure", () => {
    const ledger = new EvidenceLedger(); const witness = source(ledger, "source");
    append(ledger, witness, { campaign_id: "source", type: "failure_mode", idempotency_key: "promoted-failure",
      scope: { kind: "cross_campaign" }, content: "portable failure warning" });
    append(ledger, witness, { campaign_id: "source", type: "failure_mode", idempotency_key: "local-failure",
      scope: { kind: "campaign" }, content: "campaign-specific warning" });
    expect(projectMemoryFacts(ledger, { campaign_id: "target", node_ancestry: [], capability: { tier: "specialist" } })
      .map((entry) => entry.value)).toEqual(["portable failure warning"]);
  });

  it("does not launder critic-only promoted facts and deduplicates semantic promotions deterministically", () => {
    const first = new EvidenceLedger(); const firstWitness = source(first, "a");
    append(first, firstWitness, { campaign_id: "a", scope: { kind: "cross_campaign" }, idempotency_key: "a-public", content: "same",
      provenance: { tag: "claimed", claimant: "source-a" } });
    append(first, firstWitness, { campaign_id: "a", scope: { kind: "cross_campaign" }, idempotency_key: "a-secret", content: "private", tier: "critic_only" });
    const second = new EvidenceLedger(); const secondWitness = source(second, "b");
    append(second, secondWitness, { campaign_id: "b", scope: { kind: "cross_campaign" }, idempotency_key: "b-public", content: "same" });

    const request = { campaign_id: "target", node_ancestry: [] as string[], capability: { tier: "specialist" as const } };
    const projected = projectMemoryFacts([second, first], request);
    expect(projected.map((entry) => entry.value)).toEqual(["same"]);
    expect(projected[0]?.source_campaign_id).toBe("a");
    expect(projected[0]?.provenance).toEqual({ tag: "claimed", claimant: "source-a" });
    expect(projectMemoryFacts([first, second], { ...request, capability: { tier: "critic" } }).map((entry) => entry.value))
      .toEqual(["same", "private"]);
  });

  it("paginates across campaign ledgers without silent truncation and binds cursors to a snapshot", () => {
    const ledgers = ["a", "b", "c"].map((campaign, index) => {
      const ledger = new EvidenceLedger(); const witness = source(ledger, campaign);
      append(ledger, witness, { campaign_id: campaign, idempotency_key: campaign,
        content: `pattern-${campaign}`, scope: { kind: "cross_campaign" },
        timestamp: `2026-08-01T00:00:0${index + 1}.000Z` });
      return ledger;
    });
    const request = { campaign_id: "target", node_ancestry: [] as string[], capability: { tier: "auditor" as const }, limit: 2 };
    const first = projectMemoryFactsPage(ledgers, request);
    // Captured before the toMatchObject assertion below: bun:test (1.3.14)
    // overwrites a matched field with its expect.any() matcher instance as a
    // side effect of the assertion — reproduced in isolation with a bare
    // object and no @arbor code involved (`expect({x:"a"}).toMatchObject({x:
    // expect.any(String)})` leaves `x` as `{}` afterward). Vitest does not
    // mutate the asserted object; reading the real cursor value first
    // sidesteps the bug without changing what is asserted.
    const firstCursor = first.next_cursor;
    expect(first).toMatchObject({ has_more: true, next_cursor: expect.any(String) });
    expect(first.entries.map((entry) => entry.value)).toEqual(["pattern-b", "pattern-c"]);
    const second = projectMemoryFactsPage(ledgers, { ...request, cursor: firstCursor! });
    expect(second).toMatchObject({ has_more: false, next_cursor: null });
    expect(second.entries.map((entry) => entry.value)).toEqual(["pattern-a"]);

    const changed = new EvidenceLedger(); const witness = source(changed, "d");
    append(changed, witness, { campaign_id: "d", idempotency_key: "d", content: "pattern-d", scope: { kind: "cross_campaign" } });
    expect(() => projectMemoryFactsPage([...ledgers, changed], { ...request, cursor: firstCursor! }))
      .toThrow("different snapshot");
  });
});
