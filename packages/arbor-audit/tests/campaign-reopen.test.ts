import { describe, it, expect } from "vitest";
import { AuditIntegrityError, EvidenceLedger, type CampaignReopenInput } from "../src/audit.js";

const reopened: CampaignReopenInput = {
  campaign_id: "c1", node_id: "child", operation_id: "fork-1", phase: "reopened", actor: "operator", authority: "operator",
  overridden_halt_reason: "no_nodes", source_session_id: "session-1", reason: "try another direction",
  iterations_without_kb_entry: { before: 2, after: 0 }, timestamp: "2026-10-06T00:00:00.000Z",
};

describe("campaign_reopen ledger records", () => {
  it("chains a reopen and its revert, replays idempotently, and survives a JSONL round trip", () => {
    const ledger = new EvidenceLedger();
    const id = ledger.recordCampaignReopen(reopened);
    expect(ledger.recordCampaignReopen(reopened)).toBe(id);
    ledger.recordCampaignReopen({ ...reopened, phase: "reverted", reason: "the fork did not reach dispatch" });
    expect(ledger.getCampaignReopens("c1").map((record) => record.reopen.phase)).toEqual(["reopened", "reverted"]);
    expect(ledger.verifyIntegrity()).toMatchObject({ valid: true });

    const reloaded = new EvidenceLedger();
    reloaded.fromJSONL(ledger.toJSONL());
    expect(reloaded.verifyIntegrity()).toMatchObject({ valid: true, packet_count: 2 });
    expect(reloaded.getCampaignReopens("c1")[0]).toMatchObject({ kind: "campaign_reopen", node_id: "child", reopen: { actor: "operator", overridden_halt_reason: "no_nodes" } });
  });

  it("refuses conflicting replays, a revert with no reopen, and halts a fork may not reopen", () => {
    const ledger = new EvidenceLedger();
    expect(() => ledger.recordCampaignReopen({ ...reopened, phase: "reverted" })).toThrow(AuditIntegrityError);
    ledger.recordCampaignReopen(reopened);
    expect(() => ledger.recordCampaignReopen({ ...reopened, actor: "someone-else" })).toThrow(/conflicting campaign reopen/);
    for (const reason of ["budget_exhausted", "manual", "verified_result"]) {
      expect(() => ledger.recordCampaignReopen({ ...reopened, operation_id: `fork-${reason}`, overridden_halt_reason: reason as never })).toThrow(AuditIntegrityError);
    }
    expect(() => ledger.recordCampaignReopen({ ...reopened, operation_id: "fork-up", iterations_without_kb_entry: { before: 0, after: 1 } })).toThrow(AuditIntegrityError);
    expect(() => ledger.recordCampaignReopen({ ...reopened, operation_id: "fork-crown", authority: "crown" as never })).toThrow(AuditIntegrityError);
  });

  it("fails integrity verification for a tampered reopen record", () => {
    const ledger = new EvidenceLedger();
    ledger.recordCampaignReopen(reopened);
    const tampered = new EvidenceLedger();
    tampered.fromJSONL(ledger.toJSONL().replace('"overridden_halt_reason":"no_nodes"', '"overridden_halt_reason":"budget_exhausted"'));
    expect(tampered.verifyIntegrity()).toMatchObject({ valid: false, error: expect.stringContaining("invalid campaign reopen") });
  });
});
