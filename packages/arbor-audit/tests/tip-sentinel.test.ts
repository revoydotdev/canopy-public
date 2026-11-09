import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EvidenceLedger,
  saveLedger,
  loadLedger,
  loadLedgerResult,
  writeTipSentinel,
  readTipSentinelResult,
  classifyTipStatus,
} from "../src/index.js";
import { AuditIntegrityError } from "../src/audit.js";
import { atomicOverwriteFile } from "../src/atomic-write.js";
import type { Provenance, NodeState, GateRecord } from "@arbor/core";

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "arbor-audit-tip-sentinel-"));
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
    kb_entries_written: ["kb_1"],
    ...overrides,
  };
}

function tipPath(dir: string, campaignId: string): string {
  return join(dir, "audit-tips", `${campaignId}.json`);
}

describe("writeTipSentinel + readTipSentinelResult", () => {
  it("atomically writes binary auxiliary artifacts without coercing their bytes", () => {
    const path = join(tempDir, "binary-artifact");
    atomicOverwriteFile(path, new Uint8Array([0, 1, 127, 255]));
    expect(readFileSync(path)).toEqual(Buffer.from([0, 1, 127, 255]));
  });

  it("round-trips a sentinel", () => {
    writeTipSentinel(tempDir, "camp1", 3, "abc123");
    const result = readTipSentinelResult(tempDir, "camp1");
    expect(result.corrupt).toBe(false);
    expect(result.value).toMatchObject({ campaign_id: "camp1", record_count: 3, tip_hash: "abc123" });
  });

  it("reports missing (not corrupt) when no sentinel file exists", () => {
    const result = readTipSentinelResult(tempDir, "does-not-exist");
    expect(result).toEqual({ value: null, corrupt: false, registered: false, error: null });
  });

  it("rejects record_count 0 with a non-null tip_hash", () => {
    expect(() => writeTipSentinel(tempDir, "camp1", 0, "should-be-null")).toThrow(
      "tip_hash must be null if and only if record_count is 0",
    );
  });

  it("rejects a positive record_count with a null tip_hash", () => {
    expect(() => writeTipSentinel(tempDir, "camp1", 2, null)).toThrow(
      "tip_hash must be null if and only if record_count is 0",
    );
  });

  it("detects a tampered sentinel file as corrupt, not missing", () => {
    writeTipSentinel(tempDir, "camp1", 2, "realhash");
    const path = tipPath(tempDir, "camp1");
    const sentinel = JSON.parse(readFileSync(path, "utf-8")) as { record_count: number };
    sentinel.record_count = 999; // mutate without recomputing content_hash
    writeFileSync(path, `${JSON.stringify(sentinel)}\n`);

    const result = readTipSentinelResult(tempDir, "camp1");
    expect(result.value).toBeNull();
    expect(result.corrupt).toBe(true);
    expect(result.error).toContain("content hash does not match");
  });

  it("later writes atomically overwrite earlier ones", () => {
    writeTipSentinel(tempDir, "camp1", 1, "hash-1");
    writeTipSentinel(tempDir, "camp1", 2, "hash-2");
    const result = readTipSentinelResult(tempDir, "camp1");
    expect(result.value).toMatchObject({ record_count: 2, tip_hash: "hash-2" });
  });
});

describe("classifyTipStatus", () => {
  it("reports sentinel_missing when there is no sentinel", () => {
    expect(classifyTipStatus(3, "tip", { value: null, corrupt: false, registered: false, error: null })).toMatchObject({
      status: "sentinel_missing",
    });
  });

  it("reports intact when count and tip agree", () => {
    expect(
      classifyTipStatus(2, "tiphash", { value: { kind: "arbor_audit_tip_sentinel", version: 1, campaign_id: "c", record_count: 2, tip_hash: "tiphash", content_hash: "x" }, corrupt: false, registered: false, error: null }),
    ).toEqual({ status: "intact", detail: null });
  });

  it("reports tail_truncated when the ledger has fewer records than the sentinel expects", () => {
    const result = classifyTipStatus(1, "one-hash", {
      value: { kind: "arbor_audit_tip_sentinel", version: 1, campaign_id: "c", record_count: 3, tip_hash: "three-hash", content_hash: "x" },
      corrupt: false, registered: false, error: null,
    });
    expect(result.status).toBe("tail_truncated");
    expect(result.detail).toContain("ledger has 1 record(s)");
    expect(result.detail).toContain("sentinel attests to 3");
  });

  it("reports sentinel_inconsistent when the ledger is AHEAD of its sentinel (crash between the two writes)", () => {
    const result = classifyTipStatus(5, "new-hash", {
      value: { kind: "arbor_audit_tip_sentinel", version: 1, campaign_id: "c", record_count: 3, tip_hash: "stale-hash", content_hash: "x" },
      corrupt: false, registered: false, error: null,
    });
    expect(result.status).toBe("sentinel_inconsistent");
  });

  it("reports sentinel_inconsistent when the sentinel file itself is corrupt", () => {
    const result = classifyTipStatus(2, "hash", { value: null, corrupt: true, registered: false, error: "tampered" });
    expect(result.status).toBe("sentinel_inconsistent");
    expect(result.detail).toContain("tampered");
  });
});

describe("saveLedger + loadLedgerResult: tip sentinel integration", () => {
  it("bootstraps and keeps the sentinel in sync across successive saves", () => {
    const ledger = new EvidenceLedger();
    ledger.record(makePacket({ node_id: "n1" }));
    saveLedger(ledger, tempDir, "camp1");
    expect(loadLedgerResult(tempDir, "camp1")).toMatchObject({ valid: true, tip_status: "intact", summary: "intact" });

    ledger.record(makePacket({ node_id: "n2" }));
    saveLedger(ledger, tempDir, "camp1");
    const result = loadLedgerResult(tempDir, "camp1");
    expect(result).toMatchObject({ valid: true, tip_status: "intact" });
    expect(result.value?.getCampaign("camp1")).toHaveLength(2);
  });

  it("THE FIX: tail truncation is now caught at load time via the tip sentinel, distinct from a missing sentinel", () => {
    const ledger = new EvidenceLedger();
    for (let i = 0; i < 5; i++) ledger.record(makePacket({ node_id: `n${i}`, action_description: `action ${i}` }));
    saveLedger(ledger, tempDir, "camp1");

    // Sanity: before truncation, everything is intact.
    expect(loadLedgerResult(tempDir, "camp1")).toMatchObject({ valid: true, tip_status: "intact" });

    // Attack: drop the last two lines of the ledger file. The remaining
    // prefix is still a perfectly self-consistent hash chain (this is
    // exactly attack 12 in audit-ledger-attacks.test.ts), so
    // EvidenceLedger.verifyIntegrity() alone would report valid: true.
    const ledgerPath = join(tempDir, "audit", "camp1.jsonl");
    const lines = readFileSync(ledgerPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(5);
    writeFileSync(ledgerPath, `${lines.slice(0, 3).join("\n")}\n`);

    const inMemoryCheck = new EvidenceLedger();
    inMemoryCheck.fromJSONL(readFileSync(ledgerPath, "utf-8"));
    expect(inMemoryCheck.verifyIntegrity()).toMatchObject({ valid: true, packet_count: 3 }); // continuity alone is blind to this

    // The tip-sentinel-aware load is NOT blind to it.
    const result = loadLedgerResult(tempDir, "camp1");
    expect(result.valid).toBe(false);
    expect(result.tip_status).toBe("tail_truncated");
    expect(result.summary).toContain("tail truncated");
    expect(() => loadLedger(tempDir, "camp1")).toThrow(AuditIntegrityError);
    expect(() => loadLedger(tempDir, "camp1")).toThrow(/tip sentinel/);
  });

  it("a legacy ledger with no sentinel reports sentinel_missing and still verifies (backward compatibility)", () => {
    // Simulate a ledger written before this feature shipped: write the
    // JSONL directly, bypassing saveLedger (which would create a sentinel).
    const ledger = new EvidenceLedger();
    ledger.record(makePacket({ node_id: "n1" }));
    const auditDir = join(tempDir, "audit");
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(join(auditDir, "camp1.jsonl"), `${ledger.toJSONL()}\n`);

    const result = loadLedgerResult(tempDir, "camp1");
    expect(result.valid).toBe(true); // must not fail-open ledgers predating this feature
    expect(result.tip_status).toBe("sentinel_missing"); // but must not silently claim "intact" either
    expect(result.summary).toContain("tip sentinel not yet established");
    // loadLedger (the fail-closed compatibility wrapper) must not throw here.
    expect(() => loadLedger(tempDir, "camp1")).not.toThrow();
  });

  it("concurrent-write safety: interleaved saves to the same campaign never leave a corrupt sentinel", () => {
    // Not a true multi-process race, but exercises the same atomic
    // temp-then-rename path repeatedly with rapidly changing content, which
    // is what the atomicOverwriteFile helper exists to make safe.
    for (let i = 0; i < 20; i++) {
      writeTipSentinel(tempDir, "camp1", i + 1, `hash-${i}`);
    }
    const result = readTipSentinelResult(tempDir, "camp1");
    expect(result.corrupt).toBe(false);
    expect(result.value).toMatchObject({ record_count: 20, tip_hash: "hash-19" });
  });
});
