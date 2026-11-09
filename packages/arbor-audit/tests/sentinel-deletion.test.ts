import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceLedger } from "../src/audit.js";
import { loadLedger, loadLedgerResult, saveLedger } from "../src/persist.js";
import type { NodeState, Provenance } from "@arbor/core";

/**
 * The attack the D1 suite did not try.
 *
 * Every existing tip-sentinel test either truncates the ledger while leaving
 * an established sentinel in place (correctly caught as `tail_truncated`), or
 * exercises a ledger that never had one. None deletes an *established*
 * sentinel — which is strictly easier than the raw-truncation attack already
 * disclosed as a structural limit, and which laundered the truncation
 * completely, because `sentinel_missing` is treated as `valid: true` for
 * legacy-ledger compatibility.
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

describe("attack 19: deleting an established tip sentinel must not launder a truncation", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "arbor-sentinel-del-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function seed(): { ledgerFile: string; sentinelFile: string } {
    const ledger = new EvidenceLedger();
    for (let index = 0; index < 5; index += 1) ledger.record(makePacket({ node_id: `n${index}` }));
    saveLedger(ledger, dir, "camp1");
    return { ledgerFile: join(dir, "audit", "camp1.jsonl"), sentinelFile: join(dir, "audit-tips", "camp1.json") };
  }

  function truncate(ledgerFile: string, keep: number): void {
    const lines = readFileSync(ledgerFile, "utf8").trimEnd().split("\n");
    writeFileSync(ledgerFile, `${lines.slice(0, keep).join("\n")}\n`, "utf8");
  }

  it("baseline: truncation with the sentinel left in place is caught", () => {
    const { ledgerFile, sentinelFile } = seed();
    expect(existsSync(sentinelFile)).toBe(true);
    truncate(ledgerFile, 3);
    expect(loadLedgerResult(dir, "camp1").tip_status).toBe("tail_truncated");
    expect(() => loadLedger(dir, "camp1")).toThrow();
  });

  it("HELD: deleting the sentinel after truncation is caught, not laundered as sentinel_missing", () => {
    const { ledgerFile, sentinelFile } = seed();
    truncate(ledgerFile, 3);
    unlinkSync(sentinelFile);
    expect(existsSync(sentinelFile)).toBe(false);

    const result = loadLedgerResult(dir, "camp1");
    // The substance: a ledger that once had a sentinel must never silently
    // downgrade to the legacy "never had one" state. Downgrading makes
    // deleting a file a complete bypass of the entire D1 mechanism.
    expect(result.tip_status).not.toBe("sentinel_missing");
    expect(result.valid).toBe(false);
    expect(() => loadLedger(dir, "camp1")).toThrow();
  });

  it("HELD: deleting the sentinel from an UNtruncated ledger is still a violation", () => {
    const { sentinelFile } = seed();
    unlinkSync(sentinelFile);
    // Even with the ledger intact, the anchor's disappearance is evidence of
    // tampering. Reporting "intact" here would mean an attacker can always
    // reset the mechanism to its pre-feature state at will.
    const result = loadLedgerResult(dir, "camp1");
    expect(result.tip_status).not.toBe("sentinel_missing");
    expect(result.valid).toBe(false);
  });

  it("HELD (attack 21): deleting the SHARED manifest as well does not launder the truncation", () => {
    // Found by an independent audit. The manifest was introduced to close
    // attack 19 (delete one campaign's sentinel), and had the same weakness one
    // level up: deleting it cost one more plain unlink — no forging, no hash
    // recomputation — and because it is shared across every campaign in the
    // store, that single deletion deregistered all of them at once. A ledger
    // truncated from 5 records to 2 read back as
    // `{valid: true, tip_status: "sentinel_missing"}`.
    const { ledgerFile, sentinelFile } = seed();
    truncate(ledgerFile, 2);
    unlinkSync(join(dir, "audit-tips", "manifest.json"));
    unlinkSync(sentinelFile);

    const result = loadLedgerResult(dir, "camp1");
    expect(result.tip_status).not.toBe("sentinel_missing");
    expect(result.valid).toBe(false);
    expect(() => loadLedger(dir, "camp1")).toThrow();
  });

  it("removing the whole audit-tips/ directory is the acknowledged structural limit, not a bug", () => {
    // Stated so the boundary is witnessed rather than implied: with no anchor
    // outside the store, a store stripped of audit-tips/ entirely is
    // indistinguishable from one that never sealed anything. That is the
    // documented ceiling (REPORTED, not PREVENTED — ADR-025). This test exists
    // to make the limit explicit and to fail loudly if someone later claims
    // this case is covered.
    const { ledgerFile } = seed();
    truncate(ledgerFile, 2);
    rmSync(join(dir, "audit-tips"), { recursive: true, force: true });

    const result = loadLedgerResult(dir, "camp1");
    expect(result.tip_status).toBe("sentinel_missing");
    expect(result.valid).toBe(true); // the known limit
  });

  it("a genuinely legacy ledger (no sentinel ever established) still verifies", () => {
    // The compatibility case this must not break: ledgers written before D1
    // existed have no sentinel and no evidence one was ever created.
    const ledger = new EvidenceLedger();
    ledger.record(makePacket());
    const result = loadLedgerResult(dir, "camp1");
    expect(result.tip_status).toBe("sentinel_missing");
    expect(result.valid).toBe(true);
    expect(ledger.verifyIntegrity().valid).toBe(true);
  });
});
