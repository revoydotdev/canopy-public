import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EvidenceLedger, MEMORY_FACT_MAX_CONTENT_BYTES, MEMORY_FACT_MAX_TAG_BYTES,
  MEMORY_FACT_MAX_TAGS, type MemoryFactInput,
} from "../src/audit.js";
import { loadLedgerResult, saveLedger } from "../src/persist.js";

function source(ledger: EvidenceLedger, campaign = "campaign", node = "root"): string {
  return ledger.record({ campaign_id: campaign, node_id: node, timestamp: "2026-08-01T00:00:00.000Z",
    action_description: "observed", action_category: "test", specialist_agent: "seed", critic_agent: null,
    node_state_before: "expanding", node_state_after: "failed", provenance: { tag: "claimed", claimant: "seed" },
    specialist_output: null, critic_verdict_approved: null, critic_root_cause: null, score_before: 0, score_after: 0,
    gates: [], kb_entries_written: [] });
}

function fact(source_evidence_id: string, overrides: Partial<MemoryFactInput> = {}): MemoryFactInput {
  return { campaign_id: "campaign", node_id: "child", scope: { kind: "campaign" }, type: "failure_mode",
    content: "avoid the observed failure", provenance: { tag: "claimed", claimant: "seed" },
    tier: "specialist_visible", source_evidence_id, idempotency_key: "fact-1", tags: ["failure"],
    timestamp: "2026-08-01T00:00:01.000Z", ...overrides };
}

describe("ledger-witnessed memory facts", () => {
  it("is idempotent, conflict-safe, and durable across restart", () => {
    const ledger = new EvidenceLedger(); const witness = source(ledger);
    const id = ledger.recordMemoryFact(fact(witness));
    expect(ledger.recordMemoryFact(fact(witness))).toBe(id);
    expect(() => ledger.recordMemoryFact(fact(witness, { content: "different" }))).toThrow("conflicting");
    const dir = mkdtempSync(join(tmpdir(), "arbor-memory-")); saveLedger(ledger, dir, "campaign");
    const restored = loadLedgerResult(dir, "campaign");
    expect(restored.diagnostics).toEqual([]);
    expect(restored.value?.getMemoryFacts("campaign")).toHaveLength(1);
  });

  it("rejects missing and cross-campaign source evidence", () => {
    const ledger = new EvidenceLedger();
    expect(() => ledger.recordMemoryFact(fact("missing"))).toThrow("not witnessed");
    const other = source(ledger, "other");
    expect(() => ledger.recordMemoryFact(fact(other))).toThrow("not witnessed in campaign campaign");
  });

  it("accepts cross-campaign scope only through an explicit promotion record", () => {
    const ledger = new EvidenceLedger(); const witness = source(ledger);
    const id = ledger.recordMemoryFact(fact(witness, {
      scope: { kind: "cross_campaign" }, idempotency_key: "promoted-failure",
    }));
    expect(ledger.getMemoryFacts("campaign").find((record) => record.id === id)?.fact.scope)
      .toEqual({ kind: "cross_campaign" });
  });

  it("refuses imported-memory laundering and detects a tampered import on replay", () => {
    const ledger = new EvidenceLedger();
    const verifiedWitness = ledger.record({ campaign_id: "source", node_id: "root", timestamp: "2026-08-01T00:00:00.000Z",
      action_description: "verified source", action_category: "test", specialist_agent: "seed", critic_agent: "lenticel",
      node_state_before: "expanding", node_state_after: "verified", provenance: { tag: "verified", cmd: "test", exit: 0, stdout_hash: "sha256:source" },
      specialist_output: null, critic_verdict_approved: true, critic_root_cause: null, score_before: 0, score_after: 1, gates: [], kb_entries_written: [] });
    const sourceFact = ledger.recordMemoryFact(fact(verifiedWitness, {
      campaign_id: "source", node_id: "root", idempotency_key: "verified-source",
      provenance: { tag: "verified", cmd: "test", exit: 0, stdout_hash: "sha256:source" }, content: "portable verified fact",
    }));
    const imported = fact(verifiedWitness, {
      campaign_id: "target", node_id: "root", idempotency_key: "target-import",
      provenance: { tag: "verified", cmd: "test", exit: 0, stdout_hash: "sha256:source" }, content: "portable verified fact",
      imported_from: { campaign_id: "source", memory_fact_id: sourceFact, requested_by: "crown", approved_by: "lenticel" },
    });
    expect(() => ledger.recordMemoryFact({ ...imported, content: "rewritten" })).toThrow("preserve source evidence");
    expect(() => ledger.recordMemoryFact({ ...imported, imported_from: { ...imported.imported_from!, requested_by: "critic_only" }, tier: "critic_only" })).toThrow("preserve source evidence");
    const importedId = ledger.recordMemoryFact(imported);
    const rows = ledger.toJSONL().split("\n");
    const tampered = JSON.parse(rows.at(-1)!) as { fact: { content: string } }; tampered.fact.content = "rewritten";
    const replay = new EvidenceLedger(); replay.fromJSONL([...rows.slice(0, -1), JSON.stringify(tampered)].join("\n"));
    expect(replay.verifyIntegrity()).toMatchObject({ valid: false, error: expect.stringMatching(/invalid memory import/) });
    expect(importedId).toMatch(/^memory_/);
  });

  it("prevents visibility laundering through typed restricted witnesses", () => {
    const ledger = new EvidenceLedger(); const witness = source(ledger);
    const restrictedFact = ledger.recordMemoryFact(fact(witness, { tier: "critic_only", idempotency_key: "restricted" }));
    expect(() => ledger.recordMemoryFact(fact(restrictedFact, { idempotency_key: "launder-fact" }))).toThrow("cannot downgrade");
    expect(() => ledger.recordMemoryFact(fact(restrictedFact, { idempotency_key: "derived-secret", tier: "critic_only" }))).not.toThrow();

    const restrictedCommunication = ledger.recordNodeCommunication({ campaign_id: "campaign", node_id: "child",
      author_node_id: "critic", recipient_node_id: "child", other_recipient_node_ids: [], kind: "report",
      payload: { content: "private reasoning", provenance: { tag: "claimed", claimant: "critic" } },
      capability_tier: "critic", trigger_turn: false, as_of: "iter:1", correlation_id: "review",
      idempotency_key: "private-message", acknowledges_communication_id: null, retracts_communication_id: null });
    expect(() => ledger.recordMemoryFact(fact(restrictedCommunication, { idempotency_key: "launder-message" }))).toThrow("cannot downgrade");
    expect(() => ledger.recordMemoryFact(fact(restrictedCommunication, { idempotency_key: "private-memory", tier: "critic_only" }))).not.toThrow();
  });

  it("detects a structurally valid hash chain that downgrades typed witness visibility", () => {
    const ledger = new EvidenceLedger(); const witness = source(ledger);
    const restricted = ledger.recordMemoryFact(fact(witness, { tier: "critic_only", idempotency_key: "secret" }));
    ledger.recordMemoryFact(fact(restricted, { tier: "critic_only", idempotency_key: "derived" }));
    const rows = ledger.toJSONL().split("\n");
    // Exercise replay validation independently of content-hash failure by using
    // the append API to build the valid prefix, then importing the forbidden row.
    const forbidden = JSON.parse(rows[2]) as { fact: { tier: string } }; forbidden.fact.tier = "specialist_visible";
    const replay = new EvidenceLedger(); replay.fromJSONL([rows[0], rows[1], JSON.stringify(forbidden)].join("\n"));
    expect(replay.verifyIntegrity().error).toMatch(/downgrades a restricted memory witness/);
  });

  it("detects tampering and rejects witness reordering on replay", () => {
    const ledger = new EvidenceLedger(); const witness = source(ledger); ledger.recordMemoryFact(fact(witness));
    const rows = ledger.toJSONL().split("\n");
    const reordered = new EvidenceLedger(); reordered.fromJSONL([rows[1], rows[0]].join("\n"));
    expect(reordered.verifyIntegrity()).toMatchObject({ valid: false });
    const changed = JSON.parse(rows[1]) as { fact: { content: string } }; changed.fact.content = "tampered";
    const tampered = new EvidenceLedger(); tampered.fromJSONL([rows[0], JSON.stringify(changed)].join("\n"));
    expect(tampered.verifyIntegrity()).toMatchObject({ valid: false });
  });

  it("enforces UTF-8 content and tag bounds at their exact boundaries", () => {
    const ledger = new EvidenceLedger(); const witness = source(ledger);
    expect(() => ledger.recordMemoryFact(fact(witness, { content: "é".repeat(MEMORY_FACT_MAX_CONTENT_BYTES / 2) }))).not.toThrow();
    expect(() => ledger.recordMemoryFact(fact(witness, { idempotency_key: "oversize", content: `${"a".repeat(MEMORY_FACT_MAX_CONTENT_BYTES)}é` }))).toThrow("UTF-8 bytes");
    expect(() => ledger.recordMemoryFact(fact(witness, { idempotency_key: "tags", tags: Array.from({ length: MEMORY_FACT_MAX_TAGS + 1 }, (_, i) => `t${i}`) }))).toThrow("tag");
    expect(() => ledger.recordMemoryFact(fact(witness, { idempotency_key: "tag-bytes", tags: [`é${"a".repeat(MEMORY_FACT_MAX_TAG_BYTES - 1)}`] }))).toThrow("byte bounds");
  });

  it("quarantines a tampered durable memory fact", () => {
    const ledger = new EvidenceLedger(); const witness = source(ledger); ledger.recordMemoryFact(fact(witness));
    const dir = mkdtempSync(join(tmpdir(), "arbor-memory-tamper-")); saveLedger(ledger, dir, "campaign");
    const path = join(dir, "audit", "campaign.jsonl");
    writeFileSync(path, readFileSync(path, "utf8").replace("avoid the observed failure", "changed"));
    expect(loadLedgerResult(dir, "campaign")).toMatchObject({ value: expect.any(EvidenceLedger), diagnostics: [{ code: "integrity_failure" }] });
  });
});
