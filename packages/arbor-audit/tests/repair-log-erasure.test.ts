import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceLedger } from "../src/audit.js";
import { loadLedgerResult, saveLedger } from "../src/persist.js";
import { performSanctionedRepair } from "../src/repair-log.js";
import type { NodeState, Provenance } from "@arbor/core";

/**
 * The open question the independent audit flagged but did not attack: the
 * repair log resists middle-deletion (its chain breaks) but is itself a
 * self-describing chain with no external anchor. D2's core property is that
 * "a verified chain that has had sanctioned repairs must not report as
 * pristine" — which fails completely if the repair log's tail, or the whole
 * file, can simply be removed.
 */
function makePacket(overrides: Record<string, unknown> = {}) {
  return {
    campaign_id: "camp1",
    node_id: "node_1",
    timestamp: "2026-08-01T00:00:00.000Z",
    action_description: "test action",
    action_category: "test",
    specialist_agent: "seed",
    critic_agent: null,
    node_state_before: "expanding" as NodeState,
    node_state_after: "verified" as NodeState,
    provenance: { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test" } as Provenance,
    specialist_output: "done",
    critic_verdict_approved: true,
    critic_root_cause: null,
    score_before: 0,
    score_after: 42,
    gates: [],
    kb_entries_written: [],
    ...overrides,
  };
}

describe("attack 20: erasing the repair log must not restore a pristine verdict", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "arbor-repair-erase-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /** Seed a ledger, truncate it, then repair it under attribution. */
  function seedRepairedLedger(): string {
    const ledger = new EvidenceLedger();
    for (let index = 0; index < 5; index += 1) ledger.record(makePacket({ node_id: `n${index}` }));
    saveLedger(ledger, dir, "camp1");

    const ledgerFile = join(dir, "audit", "camp1.jsonl");
    const lines = readFileSync(ledgerFile, "utf8").trimEnd().split("\n");
    writeFileSync(ledgerFile, `${lines.slice(0, 3).join("\n")}\n`, "utf8");

    const surviving = loadLedgerResult(dir, "camp1").value;
    if (!surviving) throw new Error("expected surviving records to replay");
    performSanctionedRepair(dir, "camp1", surviving, {
      reason: "tail lost to an interrupted write",
      actor: "operator",
      git_head: "0".repeat(40),
    });
    return join(dir, "audit-repairs", "camp1.jsonl");
  }

  it("baseline: a repaired ledger reports its repair and is never plain 'intact'", () => {
    seedRepairedLedger();
    const result = loadLedgerResult(dir, "camp1");
    expect(result.valid).toBe(true);
    expect(result.repairs_recorded).toBe(1);
    expect(result.summary).toContain("1 recorded repair");
  });

  it("HELD: deleting the whole repair log does not restore a pristine verdict", () => {
    const repairFile = seedRepairedLedger();
    unlinkSync(repairFile);

    const result = loadLedgerResult(dir, "camp1");
    // The substance of D2. If erasing one file returns the ledger to
    // "intact" with zero repairs, then the requirement to record a reason is
    // decorative: an attacker repairs, then deletes the evidence of it.
    expect(result.summary).not.toBe("intact");
    expect(result.valid).toBe(false);
  });

  it("HELD: truncating the repair log's tail is caught, not silently shorter", () => {
    const repairFile = seedRepairedLedger();
    // Add a second repair so there is a tail to remove.
    const surviving = loadLedgerResult(dir, "camp1").value;
    if (!surviving) throw new Error("expected records");
    performSanctionedRepair(dir, "camp1", surviving, {
      reason: "second sanctioned repair",
      actor: "operator",
      git_head: "1".repeat(40),
    });
    expect(loadLedgerResult(dir, "camp1").repairs_recorded).toBe(2);

    const lines = readFileSync(repairFile, "utf8").trimEnd().split("\n");
    writeFileSync(repairFile, `${lines.slice(0, 1).join("\n")}\n`, "utf8");

    const result = loadLedgerResult(dir, "camp1");
    // The surviving prefix is a valid chain of length 1, exactly the
    // self-describing-chain problem the ledger's own tip sentinel exists for.
    expect(result.valid).toBe(false);
  });
});
