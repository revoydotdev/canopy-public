/**
 * durable-before-observable.test.ts — a failed fsync must leave no observable evidence.
 *
 * THE DEFECT THIS CLOSES. `persistGateCheckpoint`, `persistRecoveryDecision`,
 * and `persistTelemetryObservation` recorded straight into the caller's
 * ledger and only then called `saveLedger`, which can throw (stale chain,
 * discontinuous chain, or plain I/O — ENOSPC, EACCES). When it threw, the
 * packet stayed resident in the caller's ledger for the life of the process
 * while nothing of it reached disk.
 *
 * WHY THAT IS A GATE FAILURE AND NOT A TIDINESS ISSUE.
 * `recordGovernedTransition` resolves its prerequisite through the IN-MEMORY
 * `getGateCheckpoints`, and refuses with "missing DURABLE ... gate checkpoint".
 * So a failed fsync on a gate checkpoint left the process authorizing an
 * ADR-006 governed transition against evidence a restart would erase — the
 * checkpoint being the very thing that gates the transition.
 *
 * `manager.ts` already applied the staging discipline for node_communication,
 * compaction_lifecycle and interruption, in its own words: "Stage persistent
 * writes so a failed fsync cannot make evidence observable only in memory."
 * These wrappers were the sites it was never applied to. (A fourth wrapper,
 * `persistCompactionLifecycle`, briefly existed for parity but was never
 * wired into `manager.ts` and has since been deleted as unreachable — see
 * persist.ts's `persistStaged` doc comment.)
 *
 * The fault is real, not mocked: a read-only ledger FILE, so `appendFileSync`
 * raises a genuine EACCES. (Directory-level chmod, as repair-log.test.ts uses
 * for its rename-ordering case, does NOT block an append to an existing file —
 * verified while writing this, and the reason the first attempt at this test
 * proved nothing.) Like that precedent, these cases assume the suite does not
 * run as root, for whom file permissions are advisory.
 */

import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceLedger, persistGateCheckpoint, persistTelemetryObservation, type TelemetryObservationInput } from "../src/index.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function root(): string { const d = mkdtempSync(join(tmpdir(), "arbor-durable-")); dirs.push(d); return d; }

const gate = { gate: "evidence" as const, result: "pass" as const, checked_at: "2026-08-01T12:00:00.000Z", detail: "ok" };
const checkpoint = (operationId: string) => ({
  campaign_id: "c1", node_id: "node_1", transition: "node_verification" as const,
  operation_id: operationId, gate, timestamp: "2026-08-01T12:00:00.000Z",
});

/** Records actually durable on disk for a campaign. */
function onDisk(dir: string, campaign: string): number {
  return readFileSync(join(dir, "audit", `${campaign}.jsonl`), "utf8").split("\n").filter(Boolean).length;
}

describe("staged persistence — evidence is never observable before it is durable", () => {
  it("leaves the caller's ledger untouched when the gate-checkpoint fsync fails", () => {
    const dir = root();
    const ledger = new EvidenceLedger();
    persistGateCheckpoint(ledger, dir, checkpoint("op-1"));
    const live = ledger;
    expect(live.getGateCheckpoints("c1")).toHaveLength(1);

    const file = join(dir, "audit", "c1.jsonl");
    chmodSync(file, 0o400);
    try {
      expect(() => persistGateCheckpoint(live, dir, checkpoint("op-2"))).toThrow(/EACCES/);
    } finally {
      chmodSync(file, 0o600);
    }

    // The whole point: memory agrees with disk after the failure.
    expect(live.getGateCheckpoints("c1").map((record) => record.checkpoint.operation_id)).toEqual(["op-1"]);
    expect(onDisk(dir, "c1")).toBe(1);
  });

  it("refuses the governed transition whose checkpoint never reached disk", () => {
    // The impact, not just the mechanism: before staging, this transition was
    // PERMITTED on a checkpoint that existed only in memory.
    const dir = root();
    const live = new EvidenceLedger();
    persistGateCheckpoint(live, dir, checkpoint("op-1"));

    const file = join(dir, "audit", "c1.jsonl");
    chmodSync(file, 0o400);
    try { expect(() => persistGateCheckpoint(live, dir, checkpoint("op-2"))).toThrow(); }
    finally { chmodSync(file, 0o600); }

    expect(() => live.recordGovernedTransition("node_verification", "op-2", {
      campaign_id: "c1", node_id: "node_1", timestamp: "2026-08-01T12:00:00.000Z",
      action_description: "a", action_category: "test", specialist_agent: "s", critic_agent: null,
      node_state_before: "expanding", node_state_after: "verified",
      provenance: { tag: "claimed", claimant: "s" }, specialist_output: "o",
      critic_verdict_approved: true, critic_root_cause: null, score_before: 0, score_after: 1,
      gates: [], kb_entries_written: [],
    })).toThrow(/missing durable/);

    // ...and still permits the one that IS durable, so this is not a blanket refusal.
    expect(live.recordGovernedTransition("node_verification", "op-1", {
      campaign_id: "c1", node_id: "node_1", timestamp: "2026-08-01T12:00:00.000Z",
      action_description: "a", action_category: "test", specialist_agent: "s", critic_agent: null,
      node_state_before: "expanding", node_state_after: "verified",
      provenance: { tag: "claimed", claimant: "s" }, specialist_output: "o",
      critic_verdict_approved: true, critic_root_cause: null, score_before: 0, score_after: 1,
      gates: [], kb_entries_written: [],
    })).toMatch(/^trace_/);
  });

  it("merges the record into the caller's ledger on success", () => {
    // A fix that simply never recorded anything would pass the cases above.
    const dir = root();
    const ledger = new EvidenceLedger();
    expect(persistGateCheckpoint(ledger, dir, checkpoint("op-1"))).toMatch(/^trace_/);
    expect(ledger.getGateCheckpoints("c1")).toHaveLength(1);
    expect(onDisk(dir, "c1")).toBe(1);
  });

  it("stages telemetry observations the same way", () => {
    const dir = root();
    const seeded = new EvidenceLedger();
    persistGateCheckpoint(seeded, dir, checkpoint("op-1"));
    const observation: TelemetryObservationInput = {
      campaign_id: "c1", node_id: "node_1", operation_id: "op-telemetry", epoch: 1,
      type: "phase_timing", phase: "expand", outcome: "success", duration_ms: 42,
      source_evidence_id: seeded.getGateCheckpoints("c1")[0].id, idempotency_key: "telemetry-1",
      provenance: { tag: "verified", cmd: "clock", exit: 0, stdout_hash: "sha256:test" },
      timestamp: "2026-08-01T12:00:00.000Z",
    };
    const before = seeded.getRecords().length;

    const file = join(dir, "audit", "c1.jsonl");
    chmodSync(file, 0o400);
    try { expect(() => persistTelemetryObservation(seeded, dir, observation)).toThrow(/EACCES/); }
    finally { chmodSync(file, 0o600); }

    expect(seeded.getRecords()).toHaveLength(before);
    expect(onDisk(dir, "c1")).toBe(before);
  });
});
