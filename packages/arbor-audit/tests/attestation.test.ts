/**
 * attestation.test.ts — E-6, ledger head attestation (CAVA arXiv 2607.13716).
 *
 * Proves the three behaviors the manifest asks for: attestation appended on
 * settle, verify passes clean, verify FAILS against a truncated/rewritten
 * ledger with the attestation present.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EvidenceLedger,
  saveLedger,
  appendLedgerHeadAttestation,
  latestLedgerHeadAttestation,
  readLedgerHeadAttestations,
  classifyLedgerAttestation,
} from "../src/index.js";
import type { Provenance, NodeState, GateRecord } from "@arbor/core";

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "arbor-audit-attestation-"));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makePacket(overrides: Record<string, unknown> = {}) {
  return {
    campaign_id: "camp1",
    node_id: "node_1",
    timestamp: "2026-08-01T00:00:00.000Z",
    action_description: "test action",
    action_category: "test",
    specialist_agent: "seed",
    critic_agent: "lenticel",
    node_state_before: "expanding" as NodeState,
    node_state_after: "verified" as NodeState,
    provenance: { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test" } as Provenance,
    specialist_output: "done",
    critic_verdict_approved: true,
    critic_root_cause: null,
    score_before: 0,
    score_after: 42,
    gates: [] as GateRecord[],
    kb_entries_written: [] as string[],
    ...overrides,
  };
}

function seedLedger(dir: string, campaignId: string, count: number): EvidenceLedger {
  const ledger = new EvidenceLedger();
  for (let i = 0; i < count; i++) ledger.record(makePacket({ campaign_id: campaignId, node_id: `node_${i}` }));
  saveLedger(ledger, dir, campaignId);
  return ledger;
}

describe("appendLedgerHeadAttestation", () => {
  it("appends a durable, self-hashed row outside the per-campaign audit store", () => {
    const ledger = seedLedger(tempDir, "camp1", 3);
    const records = ledger.getRecords("camp1");
    const record = appendLedgerHeadAttestation(tempDir, "camp1", records.at(-1)!.content_hash, records.length);

    expect(record.campaign_id).toBe("camp1");
    expect(record.entry_count).toBe(3);
    expect(record.ledger_head_hash).toBe(records.at(-1)!.content_hash);

    // Lives OUTSIDE audit/ and audit-tips/.
    const raw = readFileSync(join(tempDir, "attestation", "heads.jsonl"), "utf-8");
    expect(raw.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(raw.trim())).toMatchObject({ kind: "arbor_ledger_head_attestation", campaign_id: "camp1" });
  });

  it("accumulates multiple rows for repeated settles of the same campaign", () => {
    appendLedgerHeadAttestation(tempDir, "camp1", "h1", 1, "2026-08-01T00:00:00.000Z");
    appendLedgerHeadAttestation(tempDir, "camp1", "h2", 2, "2026-08-02T00:00:00.000Z");
    const { rows } = readLedgerHeadAttestations(tempDir, "camp1");
    expect(rows).toHaveLength(2);
    expect(latestLedgerHeadAttestation(tempDir, "camp1")?.entry_count).toBe(2);
  });

  it("keeps attestations for different campaigns independent", () => {
    appendLedgerHeadAttestation(tempDir, "camp1", "h1", 1);
    appendLedgerHeadAttestation(tempDir, "camp2", "h2", 1);
    expect(readLedgerHeadAttestations(tempDir, "camp1").rows).toHaveLength(1);
    expect(readLedgerHeadAttestations(tempDir, "camp2").rows).toHaveLength(1);
  });

  it("rejects an inconsistent entry_count/head pairing", () => {
    expect(() => appendLedgerHeadAttestation(tempDir, "camp1", null, 1)).toThrow(/null if and only if/);
    expect(() => appendLedgerHeadAttestation(tempDir, "camp1", "h1", 0)).toThrow(/null if and only if/);
  });
});

describe("classifyLedgerAttestation", () => {
  it("reports unattested when no attestation row exists yet", () => {
    const ledger = seedLedger(tempDir, "camp1", 2);
    const result = classifyLedgerAttestation(tempDir, "camp1", ledger.getRecords("camp1"));
    expect(result.status).toBe("unattested");
  });

  it("passes clean against the exact ledger it attested", () => {
    const ledger = seedLedger(tempDir, "camp1", 3);
    const records = ledger.getRecords("camp1");
    appendLedgerHeadAttestation(tempDir, "camp1", records.at(-1)!.content_hash, records.length);
    const result = classifyLedgerAttestation(tempDir, "camp1", records);
    expect(result.status).toBe("attested");
    expect(result.detail).toBeNull();
  });

  it("still passes when the ledger has legitimately grown since the last attestation", () => {
    const ledger = seedLedger(tempDir, "camp1", 2);
    const firstRecords = ledger.getRecords("camp1");
    appendLedgerHeadAttestation(tempDir, "camp1", firstRecords.at(-1)!.content_hash, firstRecords.length);

    // Campaign resumed, ledger grows, then re-halts without a fresh attestation call in this test.
    ledger.record(makePacket({ campaign_id: "camp1", node_id: "node_extra" }));
    const grownRecords = ledger.getRecords("camp1");
    const result = classifyLedgerAttestation(tempDir, "camp1", grownRecords);
    expect(result.status).toBe("attested");
  });

  it("FAILS a truncated ledger even though its own hash chain still verifies", () => {
    const ledger = seedLedger(tempDir, "camp1", 5);
    const records = ledger.getRecords("camp1");
    appendLedgerHeadAttestation(tempDir, "camp1", records.at(-1)!.content_hash, records.length);

    // Truncate the on-disk ledger to 3 records, dropping the tail after it was attested.
    const filePath = join(tempDir, "audit", "camp1.jsonl");
    const lines = readFileSync(filePath, "utf-8").trim().split("\n");
    writeFileSync(filePath, `${lines.slice(0, 3).join("\n")}\n`, "utf-8");

    const truncated = new EvidenceLedger();
    truncated.fromJSONL(readFileSync(filePath, "utf-8"));
    expect(truncated.verifyIntegrity().valid).toBe(true); // the chain itself still verifies — this is the whole point

    const result = classifyLedgerAttestation(tempDir, "camp1", truncated.getRecords("camp1"));
    expect(result.status).toBe("attestation_mismatch");
    expect(result.detail).toMatch(/fewer records/);
  });

  it("FAILS a rewritten ledger whose tail was replaced with different content", () => {
    const ledger = seedLedger(tempDir, "camp1", 3);
    const records = ledger.getRecords("camp1");
    appendLedgerHeadAttestation(tempDir, "camp1", records.at(-1)!.content_hash, records.length);

    // Rewrite from scratch with the same record count but different content — a
    // resourceful attacker who recomputes the whole chain, not a naive truncation.
    const rewritten = new EvidenceLedger();
    for (let i = 0; i < 3; i++) {
      rewritten.record(makePacket({ campaign_id: "camp1", node_id: `rewritten_${i}`, action_description: "forged" }));
    }
    const rewrittenRecords = rewritten.getRecords("camp1");
    expect(rewrittenRecords).toHaveLength(3);

    const result = classifyLedgerAttestation(tempDir, "camp1", rewrittenRecords);
    expect(result.status).toBe("attestation_mismatch");
    expect(result.detail).toMatch(/rewritten/);
  });
});
