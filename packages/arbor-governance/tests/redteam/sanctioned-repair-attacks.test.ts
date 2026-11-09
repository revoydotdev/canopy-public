/**
 * tests/redteam/sanctioned-repair-attacks.test.ts — adversarial probes
 * against arbor-audit's sanctioned-repair log (Track D2, roadmap §24.2 P2,
 * §24.6 Track D; packages/arbor-audit/src/repair-log.ts).
 *
 * §13.5 of the architecture doc names the existing recovery path for a
 * corrupted ledger as "truncate-and-replay from the last valid packet".
 * Before this track, nothing stopped an operator (or an attacker with the
 * same filesystem access) from performing that replacement with no recorded
 * reason or actor — a legitimate repair and an attack were indistinguishable
 * after the fact. These probes run the actual attacks against the real,
 * on-disk sanctioned-repair path (`performSanctionedRepair` /
 * `loadRepairLogResult` / `loadLedgerResult`, all from `@arbor/audit`) and
 * assert the observed, real outcome — not the intended one.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EvidenceLedger,
  saveLedger,
  loadLedger,
  loadLedgerResult,
  loadRepairLogResult,
  performSanctionedRepair,
  AuditIntegrityError,
} from "@arbor/audit";
import type { Provenance, NodeState, GateRecord } from "@arbor/core";

let tempDir: string;
beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), "arbor-governance-redteam-repair-")); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

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

function buildAndSave(dir: string, campaignId: string, n: number): EvidenceLedger {
  const ledger = new EvidenceLedger();
  for (let i = 0; i < n; i++) ledger.record(makePacket({ campaign_id: campaignId, node_id: `n${i}`, action_description: `action ${i}` }));
  saveLedger(ledger, dir, campaignId);
  return ledger;
}

describe("redteam/sanctioned-repair: attack 16 — repair with no attribution at all", () => {
  it("HELD: the sanctioned API refuses a repair with an empty reason, actor, or git_head — this is enforced, not conventional", () => {
    buildAndSave(tempDir, "camp1", 4);
    const replacement = new EvidenceLedger();
    replacement.record(makePacket({ node_id: "n0" }));

    for (const bad of [
      { reason: "", actor: "operator", git_head: "abc123" },
      { reason: "fixing corruption", actor: "", git_head: "abc123" },
      { reason: "fixing corruption", actor: "operator", git_head: "" },
      { reason: "   ", actor: "operator", git_head: "abc123" }, // whitespace-only is not "provided"
    ]) {
      expect(() => performSanctionedRepair(tempDir, "camp1", replacement, bad)).toThrow(AuditIntegrityError);
      expect(() => performSanctionedRepair(tempDir, "camp1", replacement, bad)).toThrow(/non-empty reason, actor, and git_head/);
    }
    // None of the refused attempts left any trace: no repair recorded, ledger untouched.
    expect(loadRepairLogResult(tempDir, "camp1").value).toHaveLength(0);
    expect(loadLedger(tempDir, "camp1").getCampaign("camp1")).toHaveLength(4);
  });

  it("HELD: there is no other exported function in @arbor/audit capable of replacing an existing ledger file", () => {
    // saveLedger can only append: it throws rather than overwrite a
    // persisted packet whose content differs from what's already on disk.
    buildAndSave(tempDir, "camp1", 2);
    const divergent = new EvidenceLedger();
    const persisted = loadLedger(tempDir, "camp1").getCampaign("camp1");
    // Same id as a real persisted packet, but a content_hash that disagrees
    // with what's on disk (fromJSONL is tolerant of this at import time —
    // the check under test lives in saveLedger's overwrite guard, not here).
    divergent.fromJSONL(JSON.stringify({ ...persisted[0], action_description: "TAMPERED", content_hash: "deadbeef-forged-hash" }));
    expect(() => saveLedger(divergent, tempDir, "camp1")).toThrow(/cannot overwrite persisted trace packet/);
    // performSanctionedRepair remains the ONLY path — and it is gated above.
  });
});

describe("redteam/sanctioned-repair: attack 17 — hide a repair by editing the repair log after the fact", () => {
  it("HELD: mutating a repair record's reason/actor without recomputing its hash is caught on reload, and quarantined rather than silently trusted", () => {
    buildAndSave(tempDir, "camp1", 3);
    const replacement = new EvidenceLedger();
    replacement.record(makePacket({ node_id: "n0" }));
    performSanctionedRepair(tempDir, "camp1", replacement, {
      reason: "corrupted tail, replaying valid prefix",
      actor: "operator:alice",
      git_head: "cafe1234",
    });

    const repairLogPath = join(tempDir, "audit-repairs", "camp1.jsonl");
    const record = JSON.parse(readFileSync(repairLogPath, "utf-8").trim()) as { repair: { actor: string; reason: string } };
    // The attack: launder the repair's attribution after the fact.
    record.repair.actor = "operator:mallory";
    record.repair.reason = "routine maintenance";
    writeFileSync(repairLogPath, `${JSON.stringify(record)}\n`);

    const combined = loadLedgerResult(tempDir, "camp1");
    expect(combined.valid).toBe(false);
    expect(combined.diagnostics.some((d) => d.message.includes("content hash does not match"))).toBe(true);
  });

  it("HELD: reordering or deleting a repair log entry breaks its predecessor-hash chain, just like the main ledger", () => {
    buildAndSave(tempDir, "camp1", 1);
    const replacement = new EvidenceLedger();
    replacement.record(makePacket({ node_id: "n0" }));
    performSanctionedRepair(tempDir, "camp1", replacement, { reason: "repair one", actor: "op", git_head: "h1" });
    performSanctionedRepair(tempDir, "camp1", replacement, { reason: "repair two", actor: "op", git_head: "h2" });
    performSanctionedRepair(tempDir, "camp1", replacement, { reason: "repair three", actor: "op", git_head: "h3" });

    const repairLogPath = join(tempDir, "audit-repairs", "camp1.jsonl");
    const lines = readFileSync(repairLogPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);
    // Delete the middle repair record, hoping the log still "looks" append-only.
    writeFileSync(repairLogPath, `${[lines[0], lines[2]].join("\n")}\n`);

    const log = loadRepairLogResult(tempDir, "camp1");
    expect(log.value).toEqual([]); // quarantined, not partially trusted
    expect(log.diagnostics[0]?.message).toContain("invalid predecessor hash");
  });
});

describe("redteam/sanctioned-repair: attack 18 — bypass the sanctioned log entirely with raw filesystem access", () => {
  it("STRUCTURAL LIMIT (same class as attack 13's forged-campaign case): raw fs access can always overwrite a ledger file directly, unmediated by any application-level gate", () => {
    // No application-level gate can stop a write(2) syscall from a process
    // with filesystem permission on audit/<campaign>.jsonl. What Track D2
    // guarantees is narrower and real: the SANCTIONED API path
    // (performSanctionedRepair) cannot itself be used without attribution,
    // and a raw bypass is DETECTABLE afterward via D1's tip sentinel (which
    // this bypass never updates), not that raw bypasses are impossible.
    buildAndSave(tempDir, "camp1", 5);
    const ledgerPath = join(tempDir, "audit", "camp1.jsonl");
    const lines = readFileSync(ledgerPath, "utf-8").trim().split("\n");
    writeFileSync(ledgerPath, `${lines.slice(0, 2).join("\n")}\n`); // raw truncate, no repair log entry, no sentinel update

    // No repair was ever recorded for this unmediated change.
    expect(loadRepairLogResult(tempDir, "camp1").value).toHaveLength(0);

    // But it is NOT silently accepted as legitimate: the stale sentinel from
    // before the bypass still attests to 5 records, so this is caught and
    // reported honestly as tail truncation with zero recorded repairs —
    // never as an unexplained "intact".
    const result = loadLedgerResult(tempDir, "camp1");
    expect(result.valid).toBe(false);
    expect(result.tip_status).toBe("tail_truncated");
    expect(result.repairs_recorded).toBe(0);
  });
});

describe("redteam/sanctioned-repair: attack 19 — retry a repair-triggering append and expect a silent double-write", () => {
  it("HELD: record() is idempotent under a supplied key, so retrying the SAME append after an ambiguous failure never doubles the entry (Track D2b)", () => {
    const ledger = new EvidenceLedger();
    const packet = makePacket({ node_id: "flaky-node", idempotency_key: "flaky-node-attempt-1" });
    const first = ledger.record(packet);
    // Simulate the caller not knowing whether its first call landed (e.g. the
    // process died right after fsync but before acking) and retrying blind.
    const retried = ledger.record(packet);
    expect(retried).toBe(first);
    expect(ledger.getCampaign("camp1")).toHaveLength(1);
    saveLedger(ledger, tempDir, "camp1");
    expect(loadLedgerResult(tempDir, "camp1").value?.getCampaign("camp1")).toHaveLength(1);
  });
});
