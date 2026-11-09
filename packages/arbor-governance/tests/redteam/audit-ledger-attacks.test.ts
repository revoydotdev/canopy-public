/**
 * tests/redteam/audit-ledger-attacks.test.ts — adversarial probes against
 * arbor-audit's `EvidenceLedger` (packages/arbor-audit/src/audit.ts).
 *
 * Sub-Agent 4 / ADR governance control plane, Part A (ledger attacks, items
 * 9-15 of the brief). All ledger state is constructed in-memory; nothing here
 * touches `.arbor/` or any on-disk ledger. Every probe runs the attack for
 * real against `EvidenceLedger` and `verifyIntegrity()` and asserts the
 * actual, observed outcome.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceLedger, saveLedger, loadLedger, loadLedgerResult, AuditIntegrityError, type TracePacket } from "@arbor/audit";
import { canonicalizeForHash } from "@arbor/core";
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
    provenance: { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test" } as Provenance,
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

function buildLedger(n: number, campaignId = "camp1"): EvidenceLedger {
  const ledger = new EvidenceLedger();
  for (let i = 0; i < n; i++) {
    ledger.record(makePacket({ campaign_id: campaignId, node_id: `node_${i}`, action_description: `action ${i}` }));
  }
  return ledger;
}

describe("redteam/audit-ledger: attack 9 — mutate a record's content after append", () => {
  it("HELD: mutating a persisted packet's content is detected by verifyIntegrity()", () => {
    const ledger = buildLedger(3);
    const rows = ledger.toJSONL().split("\n");
    const altered = JSON.parse(rows[1]) as { score_after: number };
    altered.score_after = 9999; // mutate a real field without recomputing content_hash
    rows[1] = JSON.stringify(altered);

    const tampered = new EvidenceLedger();
    tampered.fromJSONL(rows.join("\n"));
    const result = tampered.verifyIntegrity();
    expect(result.valid).toBe(false);
    expect(result.error).toContain("content hash does not match");
  });
});

describe("redteam/audit-ledger: attack 10 — reorder two records", () => {
  it("HELD: swapping two same-campaign records breaks the predecessor-hash chain", () => {
    const ledger = buildLedger(4);
    const rows = ledger.toJSONL().split("\n");
    [rows[1], rows[2]] = [rows[2], rows[1]];

    const reordered = new EvidenceLedger();
    reordered.fromJSONL(rows.join("\n"));
    const result = reordered.verifyIntegrity();
    expect(result.valid).toBe(false);
    expect(result.error).toContain("invalid predecessor hash");
  });
});

describe("redteam/audit-ledger: attack 11 — delete a middle record", () => {
  it("HELD: removing a middle record breaks the successor's predecessor-hash pointer", () => {
    const ledger = buildLedger(4);
    const rows = ledger.toJSONL().split("\n");
    rows.splice(1, 1); // delete the 2nd record; the 3rd's previous_hash now dangles

    const truncated = new EvidenceLedger();
    truncated.fromJSONL(rows.join("\n"));
    const result = truncated.verifyIntegrity();
    expect(result.valid).toBe(false);
    expect(result.error).toContain("invalid predecessor hash");
  });
});

describe("redteam/audit-ledger: attack 12 — truncate the tail (the interesting one)", () => {
  it("VULNERABLE: dropping the LAST N records of a campaign's chain is UNDETECTABLE by verifyIntegrity()", () => {
    // Build a 5-record campaign chain, then drop the last two records
    // entirely (not mutate — remove). The remaining prefix is a perfectly
    // self-consistent hash chain: every surviving record's previous_hash
    // correctly points at its surviving predecessor, because nothing after
    // the cut is left to expose a broken pointer.
    //
    // verifyIntegrity() re-walks ONLY what is present. It has no external
    // "expected tip" to compare against, so a truncated ledger validates as
    // fully `valid: true` — indistinguishable from a legitimately shorter
    // ledger. This is the real, structural weakness of an unsealed
    // hash-chain-only design: a per-record seal (previous_hash + content_hash)
    // proves CONTINUITY of what is present, but proves NOTHING about
    // COMPLETENESS unless the verifier is separately handed the last known
    // good tip hash (or record count) from an out-of-band source.
    const ledger = buildLedger(5);
    const fullRows = ledger.toJSONL().split("\n");
    expect(fullRows).toHaveLength(5);

    const truncatedRows = fullRows.slice(0, 3); // drop the last two records
    const truncated = new EvidenceLedger();
    truncated.fromJSONL(truncatedRows.join("\n"));

    const result = truncated.verifyIntegrity();
    expect(result.valid).toBe(true); // <-- the vulnerability: no error, no signal
    expect(result.packet_count).toBe(3);

    // Confirm this is a genuine information loss, not a benign no-op: the
    // truncated ledger's tip hash differs from the full ledger's real tip,
    // and nothing in the public API surfaces that mismatch without an
    // external expected-tip value to compare against.
    const fullTip = (JSON.parse(fullRows[4]) as { content_hash: string }).content_hash;
    const truncatedTip = (JSON.parse(truncatedRows[2]) as { content_hash: string }).content_hash;
    expect(truncatedTip).not.toBe(fullTip);
    // But verifyIntegrity()'s result object carries no tip_hash field at all
    // to let a caller notice this on their own.
    expect(Object.keys(result)).toEqual(["valid", "packet_count", "error"]);
  });

  it("control: truncating everything down to zero records also validates (empty chain is trivially valid)", () => {
    const empty = new EvidenceLedger();
    empty.fromJSONL(""); // import nothing
    const result = empty.verifyIntegrity();
    expect(result).toEqual({ valid: true, packet_count: 0, error: null });
  });
});

describe("redteam/audit-ledger: attack 12b — the SAME tail truncation, exercised at the real disk persistence layer (Track D1 fix)", () => {
  // Attack 12 above shows the permanent, structural fact about the
  // IN-MEMORY chain: EvidenceLedger.verifyIntegrity() alone cannot see
  // completeness, and that will always be true — it is disk-agnostic by
  // design. Track D1 does not change verifyIntegrity(); it adds an EXTERNAL,
  // per-campaign tip sentinel at the persistence layer (persist.ts /
  // tip-sentinel.ts) that the SAME attack cannot touch, because it lives in
  // a separate file (`audit-tips/<campaign>.json`) from the ledger
  // (`audit/<campaign>.jsonl`). This probe runs the identical attack — drop
  // the last N lines of a real, on-disk ledger file — through the real
  // production load path (`loadLedgerResult`/`loadLedger`) instead of a bare
  // in-memory `fromJSONL`.
  let tempDir: string;
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), "arbor-governance-redteam-audit-tip-")); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("BEFORE THE FIX (no sentinel ever written): a raw-truncated ledger file loads as if nothing happened", () => {
    // Simulate a ledger that predates Track D1 entirely: write the JSONL
    // directly, bypassing saveLedger (which now also writes a sentinel).
    const ledger = buildLedger(5);
    const rows = ledger.toJSONL().split("\n");
    const auditDir = join(tempDir, "audit");
    mkdirSync(auditDir, { recursive: true });
    // Truncate to 3 records — no sentinel exists to catch this, by construction.
    writeFileSync(join(auditDir, "camp1.jsonl"), `${rows.slice(0, 3).join("\n")}\n`);

    const result = loadLedgerResult(tempDir, "camp1");
    expect(result.value?.getCampaign("camp1")).toHaveLength(3); // loads "successfully"
    expect(result.valid).toBe(true); // VULNERABLE, exactly like attack 12, absent a sentinel
    expect(result.tip_status).toBe("sentinel_missing"); // but NOT silently reported as "intact" either — see below
  });

  it("HELD: once a sentinel exists (any real saveLedger call), the identical truncation is caught and loadLedger fails closed", () => {
    const ledger = buildLedger(5);
    saveLedger(ledger, tempDir, "camp1"); // this is what creates/maintains the sentinel

    const ledgerPath = join(tempDir, "audit", "camp1.jsonl");
    const fullLines = readFileSync(ledgerPath, "utf-8").trim().split("\n");
    expect(fullLines).toHaveLength(5);
    writeFileSync(ledgerPath, `${fullLines.slice(0, 3).join("\n")}\n`); // drop the last 2 records

    // The in-memory check alone still can't see it (attack 12's point, restated).
    const inMemory = new EvidenceLedger();
    inMemory.fromJSONL(readFileSync(ledgerPath, "utf-8"));
    expect(inMemory.verifyIntegrity()).toMatchObject({ valid: true, packet_count: 3 });

    // The persistence-layer check, which now consults the external sentinel, is not fooled.
    const result = loadLedgerResult(tempDir, "camp1");
    expect(result.valid).toBe(false);
    expect(result.tip_status).toBe("tail_truncated");
    expect(result.summary).toContain("tail truncated");

    // And the fail-closed compatibility wrapper (the one `saveLedger` itself
    // uses before appending) refuses to hand back the truncated ledger at all.
    expect(() => loadLedger(tempDir, "camp1")).toThrow(AuditIntegrityError);
  });

  it("sentinel_missing is never collapsed into 'intact': the report always distinguishes the two", () => {
    // Legacy ledger: written before this feature existed, never through saveLedger.
    const ledger = buildLedger(2);
    mkdirSync(join(tempDir, "audit"), { recursive: true });
    writeFileSync(join(tempDir, "audit", "legacy.jsonl"), `${ledger.toJSONL()}\n`);

    const legacy = loadLedgerResult(tempDir, "legacy");
    expect(legacy.valid).toBe(true); // must not fail-open every pre-existing ledger
    expect(legacy.tip_status).toBe("sentinel_missing"); // but the gap is visible, not swallowed
    expect(legacy.summary).not.toBe("intact"); // distinguishable from a genuinely verified-complete chain
  });
});

describe("redteam/audit-ledger: attack 13 — splice a record from campaign A into campaign B's chain", () => {
  it("HELD: forging a record's campaign_id without recomputing its content_hash is caught", () => {
    // The cheap version of this attack: take a genuine campaign-A record and
    // relabel its campaign_id to B without recomputing content_hash. Since
    // campaign_id is part of the hashed payload, this is just a mutation
    // (attack 9's case) and is caught the same way.
    const ledgerA = buildLedger(2, "campA");
    const rowsA = ledgerA.toJSONL().split("\n");
    const stolen = JSON.parse(rowsA[0]) as { campaign_id: string; previous_hash: string | null };
    stolen.campaign_id = "campB";
    stolen.previous_hash = null; // pretend it's B's first record

    const ledgerB = buildLedger(1, "campB");
    const rowsB = ledgerB.toJSONL().split("\n");
    const spliced = new EvidenceLedger();
    spliced.fromJSONL([JSON.stringify(stolen), ...rowsB].join("\n"));
    const result = spliced.verifyIntegrity();
    expect(result.valid).toBe(false);
    expect(result.error).toContain("content hash does not match");
  });

  it("STRUCTURAL LIMIT: a record forged from scratch with a recomputed hash for the target campaign is NOT distinguishable from a genuine one", () => {
    // The realistic version of the splice attack: an attacker who can
    // recompute SHA-256 (the hash function is public and unkeyed — there is
    // no HMAC/signature) copies the *content* of a campaign-A record into a
    // brand-new record object stamped with campaign_id "campB", chains its
    // previous_hash correctly onto B's real tip, and recomputes content_hash
    // honestly for that forged object. verifyIntegrity() can only prove
    // internal self-consistency of the hash chain; it has no way to prove
    // that a well-formed, correctly-chained record's content is *authentic*
    // (i.e., that the campaign_id it claims is the campaign_id under which
    // the underlying evidence actually occurred). This is not a bug in
    // verifyIntegrity() — it is the fundamental limit of an unsigned hash
    // chain: it detects ACCIDENTAL corruption/reordering/truncation, not a
    // deliberate forgery by an actor who controls the export/import path.
    const ledgerA = buildLedger(1, "campA");
    const rowsA = ledgerA.toJSONL().split("\n");
    const stolenContent = JSON.parse(rowsA[0]) as TracePacket;

    const ledgerB = buildLedger(1, "campB");
    const rowsB = ledgerB.toJSONL().split("\n");
    const bTip = (JSON.parse(rowsB[0]) as { content_hash: string }).content_hash;

    // Forge a new record: same evidentiary content as A's record, but
    // legitimately re-hashed as if it belonged to B's chain.
    const forged = new EvidenceLedger();
    forged.fromJSONL(rowsB.join("\n"));
    const forgedId = forged.recordGateCheckpoint({
      campaign_id: "campB",
      node_id: stolenContent.node_id,
      transition: "campaign_start",
      operation_id: "forged-op",
      gate: { gate: "admission", result: "pass", detail: "forged from campA evidence", checked_at: "2026-08-01T00:00:00.000Z" },
    });
    expect(forgedId).toBeTruthy();
    // The forged ledger is fully internally valid — verifyIntegrity() cannot
    // see through the forgery, confirming the structural limit stated above.
    expect(forged.verifyIntegrity()).toMatchObject({ valid: true });
    void bTip;
  });
});

describe("redteam/audit-ledger: attack 14 — previous_hash points at a nonexistent parent", () => {
  it("HELD: an orphaned previous_hash (no packet produced that hash) is detected", () => {
    const ledger = buildLedger(1, "campC");
    const rows = ledger.toJSONL().split("\n");
    const orphan = JSON.parse(rows[0]) as { id: string; previous_hash: string | null; content_hash: string };
    orphan.id = "trace_orphan";
    orphan.previous_hash = "sha256-does-not-exist-anywhere";
    // Recompute content_hash honestly for the forged previous_hash so this
    // probes the predecessor-pointer check specifically, not the
    // content-hash check from attack 9.
    const { content_hash: _drop, ...unhashed } = orphan as { content_hash: string } & Record<string, unknown>;
    orphan.content_hash = createHash("sha256").update(canonicalizeForHash(unhashed)).digest("hex");

    const spliced = new EvidenceLedger();
    spliced.fromJSONL([JSON.stringify(orphan), rows[0]].join("\n"));
    // fromJSONL dedupes by id; orphan has a distinct id from rows[0] so both enter.
    const result = spliced.verifyIntegrity();
    expect(result.valid).toBe(false);
    expect(result.error).toContain("invalid predecessor hash");
  });
});

describe("redteam/audit-ledger: attack 15 — replay the same event twice", () => {
  it("VULNERABLE: record() (TracePacket) has NO idempotency key — replaying the same action creates two distinct ledger entries", () => {
    // Unlike every other record*() method on EvidenceLedger (checkpoint,
    // recovery decision, node communication, memory fact, phase message,
    // compaction lifecycle, telemetry, request_user_input — all of which
    // take an explicit idempotency_key/operation_id and dedupe on it), the
    // base `record()` path for TracePacket has no such field. A caller that
    // retries after a transient failure (network blip, process restart)
    // with byte-identical inputs gets TWO separate, distinctly-hashed
    // packets chained one after another, not one deduplicated entry.
    const ledger = new EvidenceLedger();
    const packet = makePacket({ action_description: "expand node X", node_id: "nodeX" });
    const id1 = ledger.record(packet);
    const id2 = ledger.record(packet); // exact same input, replayed
    expect(id1).not.toBe(id2);
    expect(ledger.verifyIntegrity()).toMatchObject({ valid: true, packet_count: 2 });
    const records = ledger.getCampaign("camp1");
    expect(records).toHaveLength(2);
    expect(records[0].action_description).toBe(records[1].action_description);
    // Contrast: recordGateCheckpoint on the same operation_id IS idempotent.
    const gate = { gate: "admission" as const, result: "pass" as const, detail: "ok", checked_at: "2026-08-01T00:00:00.000Z" };
    const gid1 = ledger.recordGateCheckpoint({ campaign_id: "camp1", node_id: "nodeX", transition: "campaign_start", operation_id: "op-1", gate });
    const gid2 = ledger.recordGateCheckpoint({ campaign_id: "camp1", node_id: "nodeX", transition: "campaign_start", operation_id: "op-1", gate });
    expect(gid1).toBe(gid2); // dedupes, unlike record()
  });
});

describe("redteam/audit-ledger: attack 15b — the SAME replay, now with an idempotency_key (Track D2b fix)", () => {
  it("HELD: supplying idempotency_key turns the exact same replay into a detectable no-op, not a second entry", () => {
    const ledger = new EvidenceLedger();
    const packet = makePacket({ action_description: "expand node X", node_id: "nodeX", idempotency_key: "expand-nodeX-attempt-1" });
    const id1 = ledger.record(packet);
    const id2 = ledger.record(packet); // exact same input, replayed — e.g. after an ambiguous network failure
    expect(id2).toBe(id1); // fixed: same id, not a distinct one
    expect(ledger.getCampaign("camp1")).toHaveLength(1); // fixed: one entry, not two
    expect(ledger.verifyIntegrity()).toMatchObject({ valid: true, packet_count: 1 });
  });

  it("HELD: a retry under the same key with genuinely different content is a loud conflict, never a silent double-write or overwrite", () => {
    const ledger = new EvidenceLedger();
    ledger.record(makePacket({ node_id: "nodeX", idempotency_key: "expand-nodeX-attempt-1", score_after: 1 }));
    expect(() =>
      ledger.record(makePacket({ node_id: "nodeX", idempotency_key: "expand-nodeX-attempt-1", score_after: 2 })),
    ).toThrow("conflicting trace packet for idempotency key expand-nodeX-attempt-1");
    expect(ledger.getCampaign("camp1")).toHaveLength(1);
    expect(ledger.getCampaign("camp1")[0].score_after).toBe(1); // the attacker's differing value never lands
  });

  it("omitting idempotency_key preserves the exact pre-fix behavior (deliberate, backward-compatible default)", () => {
    // Every packet recorded before this field existed had no key at all;
    // record() must keep behaving exactly as attack 15 (above) documents
    // when a caller doesn't opt in.
    const ledger = new EvidenceLedger();
    const packet = makePacket({ action_description: "expand node Y", node_id: "nodeY" });
    const id1 = ledger.record(packet);
    const id2 = ledger.record(packet);
    expect(id1).not.toBe(id2);
    expect(ledger.getCampaign("camp1")).toHaveLength(2);
  });
});

describe("redteam/audit-ledger: fromJSONL import gaps", () => {
  it("VULNERABLE: fromJSONL silently accepts the FIRST of two conflicting records sharing an id, with no conflict error", () => {
    // Contrast with arbor-kb's KnowledgeBase.fromJSONL, which explicitly
    // throws KBIntegrityError on a duplicate id with different content
    // (kb.ts line ~343-345). EvidenceLedger.fromJSONL has no such check: it
    // simply skips any packet whose id is already present, regardless of
    // whether the content differs.
    const ledger = buildLedger(1, "campX");
    const rows = ledger.toJSONL().split("\n");
    const original = JSON.parse(rows[0]) as { id: string; score_after: number };
    const poisoned = { ...original, score_after: 999999 }; // same id, different content

    const target = new EvidenceLedger();
    const firstCount = target.fromJSONL(JSON.stringify(original));
    expect(firstCount).toBe(1);
    // No throw, no error signal — the conflicting record is just dropped.
    const secondCount = target.fromJSONL(JSON.stringify(poisoned));
    expect(secondCount).toBe(0);
    expect(target.verifyIntegrity()).toMatchObject({ valid: true });
    const stored = target.getCampaign("campX")[0];
    expect(stored.score_after).toBe(original.score_after); // poisoned value never wins, but silently
  });

  it("VULNERABLE: verifyIntegrity() is not called automatically by fromJSONL — a caller who forgets to call it accepts tampered data", () => {
    const ledger = buildLedger(3);
    const rows = ledger.toJSONL().split("\n");
    const altered = JSON.parse(rows[1]) as { score_after: number };
    altered.score_after = -1;
    rows[1] = JSON.stringify(altered);

    const tampered = new EvidenceLedger();
    const importedCount = tampered.fromJSONL(rows.join("\n"));
    // Import itself succeeds silently; nothing forces the caller to verify.
    expect(importedCount).toBe(3);
    expect(tampered.getCampaign("camp1")).toHaveLength(3); // tampered data is fully readable
    // Only an explicit, separate verifyIntegrity() call catches it.
    expect(tampered.verifyIntegrity().valid).toBe(false);
  });
});
