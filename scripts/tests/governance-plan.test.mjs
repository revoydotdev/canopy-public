import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GovernancePlanRefusal,
  assertGovernanceConsumerReady,
  createGovernanceProducerPlan,
} from "../lib/governance-plan.mjs";
import { acquireEvidenceTransaction, evidenceTransactionStatus } from "../evidence-transaction.mjs";

// Throwaway repos live entirely under the OS tmp dir, never this checkout's
// own `.git/arbor/evidence-refresh/` — ADR-078 forbids a test whose verdict
// ranges over live-repo lock state.
const dirs = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
function fixtureRepo() {
  const repo = mkdtempSync(join(tmpdir(), "revoy2-governance-plan-test-"));
  dirs.push(repo);
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: repo });
  writeFileSync(join(repo, "tracked.txt"), "one\n");
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync("git", ["commit", "-qm", "fixture"], { cwd: repo });
  return repo;
}

describe("governance producer plan", () => {
  it("emits a deterministic producer -> normalization -> commit transcript", () => {
    const plan = createGovernanceProducerPlan({ name: "fixture" });
    for (const phase of ["producer", "normalization", "commit"]) {
      plan.start(phase);
      plan.succeed(phase);
    }
    expect(plan.events()).toEqual([
      { schema_version: 1, kind: "revoy2.governance_producer_plan", name: "fixture", sequence: 1, phase: "producer", status: "started" },
      { schema_version: 1, kind: "revoy2.governance_producer_plan", name: "fixture", sequence: 2, phase: "producer", status: "succeeded" },
      { schema_version: 1, kind: "revoy2.governance_producer_plan", name: "fixture", sequence: 3, phase: "normalization", status: "started" },
      { schema_version: 1, kind: "revoy2.governance_producer_plan", name: "fixture", sequence: 4, phase: "normalization", status: "succeeded" },
      { schema_version: 1, kind: "revoy2.governance_producer_plan", name: "fixture", sequence: 5, phase: "commit", status: "started" },
      { schema_version: 1, kind: "revoy2.governance_producer_plan", name: "fixture", sequence: 6, phase: "commit", status: "succeeded" },
    ]);
  });

  it("refuses a commit before normalization", () => {
    const plan = createGovernanceProducerPlan();
    expect(() => plan.start("commit")).toThrow(GovernancePlanRefusal);
    expect(() => plan.start("commit")).toThrow(/producer is required next/);
  });

  it("refuses a consumer while an evidence producer is incomplete", () => {
    expect(() => assertGovernanceConsumerReady({
      consumer: "fixture gate",
      evidenceStatus: { ok: true, held: true, transaction_id: "tx-1", phase: "normalization" },
    })).toThrow(/refuses derived governance evidence/);
  });

  it("returns a machine-readable ready status after atomic publication", () => {
    expect(assertGovernanceConsumerReady({ consumer: "fixture gate", evidenceStatus: { ok: true, held: false } })).toEqual({
      schema_version: 1,
      kind: "revoy2.governance_producer_plan",
      consumer: "fixture gate",
      phase: "consumer",
      status: "ready",
    });
  });

  // ADR-101 rule 2: the consumer refusal must embed the same holder-pid and
  // heartbeat-age summary evidenceTransactionStatus computes, not a shorter
  // one recomposed from transaction_id/phase alone — that terser message is
  // exactly what let an agent misread a live sibling's healthy lock as
  // malformed and delete it. This drives a real evidence transaction lease
  // in a throwaway repo (never this checkout's own `.git/arbor/`) and reads
  // the actual refusal text a consumer gate gets.
  it("names the holder pid and heartbeat age in a real held-transaction refusal", () => {
    const repo = fixtureRepo();
    const lease = acquireEvidenceTransaction({ repo, transactionId: "governance-plan-test-tx" });
    try {
      const evidenceStatus = evidenceTransactionStatus({ repo });
      expect(evidenceStatus.held).toBe(true);
      let refusal;
      try {
        assertGovernanceConsumerReady({ consumer: "fixture gate", evidenceStatus });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(GovernancePlanRefusal);
      expect(refusal.message).toMatch(new RegExp(`pid ${process.pid} \\(owner: `));
      expect(refusal.message).toMatch(/heartbeat \d+s ago/);
    } finally {
      lease.release();
    }
  });
});
