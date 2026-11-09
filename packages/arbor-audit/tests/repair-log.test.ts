import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EvidenceLedger,
  saveLedger,
  loadLedger,
  loadLedgerResult,
  loadRepairLogResult,
  performSanctionedRepair,
} from "../src/index.js";
import type { Provenance, NodeState, GateRecord } from "@arbor/core";

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "arbor-audit-repair-log-"));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
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

describe("performSanctionedRepair: the gate cannot be bypassed", () => {
  it("ATTACK: refuses a repair with no reason, actor, or git_head", () => {
    buildAndSave(tempDir, "camp1", 5);
    const replacement = new EvidenceLedger();
    replacement.record(makePacket({ campaign_id: "camp1", node_id: "n0" }));

    expect(() => performSanctionedRepair(tempDir, "camp1", replacement, { reason: "", actor: "op", git_head: "abc" }))
      .toThrow("non-empty reason, actor, and git_head");
    expect(() => performSanctionedRepair(tempDir, "camp1", replacement, { reason: "fix", actor: "", git_head: "abc" }))
      .toThrow("non-empty reason, actor, and git_head");
    expect(() => performSanctionedRepair(tempDir, "camp1", replacement, { reason: "fix", actor: "op", git_head: "" }))
      .toThrow("non-empty reason, actor, and git_head");
    expect(() => performSanctionedRepair(tempDir, "camp1", replacement, { reason: "   ", actor: "op", git_head: "abc" }))
      .toThrow("non-empty reason, actor, and git_head");

    // No repair was recorded and the ledger is untouched by any of the refused attempts.
    expect(loadRepairLogResult(tempDir, "camp1").value).toHaveLength(0);
    expect(loadLedgerResult(tempDir, "camp1").value?.getCampaign("camp1")).toHaveLength(5);
  });

  it("refuses to install a replacement ledger that does not itself pass verifyIntegrity()", () => {
    buildAndSave(tempDir, "camp1", 3);
    const brokenReplacement = new EvidenceLedger();
    brokenReplacement.fromJSONL(JSON.stringify({
      kind: "trace", id: "trace_1", previous_hash: "forged-parent-does-not-exist", content_hash: "whatever",
      campaign_id: "camp1", node_id: "n0", timestamp: "2026-08-01T00:00:00.000Z",
    }));
    expect(() => performSanctionedRepair(tempDir, "camp1", brokenReplacement, { reason: "fix", actor: "op", git_head: "abc" }))
      .toThrow("does not itself pass verifyIntegrity()");
  });

  it("HELD: performs a legitimate truncate-and-replay repair, recorded with reason+actor+git_head", () => {
    buildAndSave(tempDir, "camp1", 5);
    // Simulate the scenario the repair path exists for: the tail was corrupted/tampered.
    const ledgerPath = join(tempDir, "audit", "camp1.jsonl");
    const lines = readFileSync(ledgerPath, "utf-8").trim().split("\n");
    writeFileSync(ledgerPath, `${lines.slice(0, 3).join("\n")}\n`); // truncate to 3

    // Build a valid replacement reflecting the truncated-but-still-valid prefix.
    const replacement = new EvidenceLedger();
    replacement.fromJSONL(lines.slice(0, 3).join("\n"));
    expect(replacement.verifyIntegrity().valid).toBe(true);

    const repairRecord = performSanctionedRepair(tempDir, "camp1", replacement, {
      reason: "tail was corrupted by a disk fault; replaying the last 3 valid packets",
      actor: "operator:alice",
      git_head: "abc1234",
    });

    expect(repairRecord.repair).toMatchObject({
      campaign_id: "camp1",
      reason: "tail was corrupted by a disk fault; replaying the last 3 valid packets",
      actor: "operator:alice",
      git_head: "abc1234",
      before: { record_count: 3 }, // rawLedgerTip saw the ALREADY-truncated file (3 lines)
      after: { record_count: 3 },
    });

    // Post-repair, verification reports intact WITH the repair visible, never pristine.
    const result = loadLedgerResult(tempDir, "camp1");
    expect(result.valid).toBe(true);
    expect(result.tip_status).toBe("intact"); // sentinel now agrees with the repaired ledger
    expect(result.repairs_recorded).toBe(1);
    expect(result.summary).toBe("intact, with 1 recorded repair");
  });

  it("D2: a verified chain with sanctioned repairs is never reported as pristine", () => {
    buildAndSave(tempDir, "camp1", 2);
    const replacement = new EvidenceLedger();
    replacement.record(makePacket({ campaign_id: "camp1", node_id: "only-record" }));
    performSanctionedRepair(tempDir, "camp1", replacement, { reason: "operator-requested reset", actor: "op", git_head: "deadbeef" });
    performSanctionedRepair(tempDir, "camp1", replacement, { reason: "second repair", actor: "op", git_head: "deadbeef" });

    const result = loadLedgerResult(tempDir, "camp1");
    expect(result.repairs_recorded).toBe(2);
    expect(result.summary).toBe("intact, with 2 recorded repairs");
    expect(result.summary).not.toBe("intact");
  });
});

describe("repair log: itself an append-only hash chain", () => {
  it("chains successive repairs with previous_hash", () => {
    buildAndSave(tempDir, "camp1", 1);
    const replacement = new EvidenceLedger();
    replacement.record(makePacket({ campaign_id: "camp1", node_id: "x" }));
    performSanctionedRepair(tempDir, "camp1", replacement, { reason: "r1", actor: "op", git_head: "h1" });
    performSanctionedRepair(tempDir, "camp1", replacement, { reason: "r2", actor: "op", git_head: "h2" });

    const log = loadRepairLogResult(tempDir, "camp1");
    expect(log.diagnostics).toHaveLength(0);
    expect(log.value).toHaveLength(2);
    expect(log.value?.[0].previous_hash).toBeNull();
    expect(log.value?.[1].previous_hash).toBe(log.value?.[0].content_hash);
  });

  it("ATTACK: mutating a repair log entry's content without recomputing its hash is detected", () => {
    buildAndSave(tempDir, "camp1", 1);
    const replacement = new EvidenceLedger();
    replacement.record(makePacket({ campaign_id: "camp1", node_id: "x" }));
    performSanctionedRepair(tempDir, "camp1", replacement, { reason: "legit reason", actor: "op", git_head: "h1" });

    const repairPath = join(tempDir, "audit-repairs", "camp1.jsonl");
    const record = JSON.parse(readFileSync(repairPath, "utf-8").trim()) as { repair: { reason: string } };
    record.repair.reason = "a repair log that can be edited to hide a repair is theatre";
    writeFileSync(repairPath, `${JSON.stringify(record)}\n`);

    // A single read is load-bearing here: quarantine-on-corrupt (like the
    // ledger's own quarantine) MOVES the bad file aside, so a second read
    // afterward would find nothing left to complain about. Go through
    // loadLedgerResult (the combined, real-caller path) exactly once.
    const combined = loadLedgerResult(tempDir, "camp1");
    expect(combined.valid).toBe(false);
    expect(combined.diagnostics[0]).toMatchObject({ code: "integrity_failure" });
    expect(combined.diagnostics[0].message).toContain("content hash does not match");
  });

  it("ATTACK: reordering repair log entries breaks the predecessor-hash chain", () => {
    buildAndSave(tempDir, "camp1", 1);
    const replacement = new EvidenceLedger();
    replacement.record(makePacket({ campaign_id: "camp1", node_id: "x" }));
    performSanctionedRepair(tempDir, "camp1", replacement, { reason: "r1", actor: "op", git_head: "h1" });
    performSanctionedRepair(tempDir, "camp1", replacement, { reason: "r2", actor: "op", git_head: "h2" });

    const repairPath = join(tempDir, "audit-repairs", "camp1.jsonl");
    const lines = readFileSync(repairPath, "utf-8").trim().split("\n");
    writeFileSync(repairPath, `${[lines[1], lines[0]].join("\n")}\n`);

    const log = loadRepairLogResult(tempDir, "camp1");
    expect(log.diagnostics[0]?.message).toContain("invalid predecessor hash");
  });
});

describe("repair ordering: evidence survives even if the tip-move step fails", () => {
  it("the repair record is durable BEFORE the ledger file is replaced, so a crash between the two leaves proof a repair was attempted", () => {
    buildAndSave(tempDir, "camp1", 2);
    const replacement = new EvidenceLedger();
    replacement.record(makePacket({ campaign_id: "camp1", node_id: "x" }));

    // Real (not mocked) fault injection: strip write permission from the
    // `audit/` directory so the atomic ledger-replace step's temp-file
    // creation genuinely fails with EACCES, simulating a crash between
    // "repair log written+fsynced" and "tip (the ledger file) actually
    // moved". The repair log lives in a SEPARATE directory (`audit-repairs/`)
    // and is appended via plain appendFileSync before this point is ever
    // reached, so it is unaffected — this isolates exactly the ordering
    // guarantee under test.
    const auditDir = join(tempDir, "audit");
    fs.chmodSync(auditDir, 0o500);
    try {
      expect(() => performSanctionedRepair(tempDir, "camp1", replacement, { reason: "r1", actor: "op", git_head: "h1" }))
        .toThrow();
    } finally {
      fs.chmodSync(auditDir, 0o700); // restore so afterEach's rmSync can clean up
    }

    // Evidence that a repair was ATTEMPTED survives the crash, even though it never completed.
    const log = loadRepairLogResult(tempDir, "camp1");
    expect(log.value).toHaveLength(1);
    expect(log.value?.[0].repair.reason).toBe("r1");

    // The ledger itself was never actually replaced (the crash happened before rename).
    const result = loadLedgerResult(tempDir, "camp1");
    expect(result.value?.getCampaign("camp1")).toHaveLength(2);

    // ...and the store now FAILS CLOSED rather than reading as intact. The
    // crash left the repair log ahead of its seal, which is exactly the shape
    // a forged repair record would have — an attacker appending a fabricated
    // repair to legitimize a truncation produces the same "log ahead of seal"
    // state. Before the repair log was sealed, both read as plain "intact".
    // This mirrors the pre-existing treatment of a ledger ahead of its
    // sentinel: the benign crash and the malicious forge are not
    // distinguishable from inside the store, so the safe reading wins and a
    // human is required. `arbor-mcp ledger repair` is the recovery path — it
    // reads via loadLedgerResult and re-seals both chains.
    expect(result.valid).toBe(false);
    expect(result.tip_status).toBe("sentinel_inconsistent");
    expect(result.tip_detail).toContain("repair log tip");
    expect(() => loadLedger(tempDir, "camp1")).toThrow();
  });
});
