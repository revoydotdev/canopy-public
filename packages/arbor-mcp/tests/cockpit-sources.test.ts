import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArborRuntime } from "../src/runtime.js";
import { createCockpitTelemetrySource } from "../src/cockpit-sources.js";
import type { Action } from "@arbor/core";

const rootAction: Action = {
  description: "execute plan",
  estimated_gain: 100,
  estimated_cost: 1,
  category: "root",
  delegate_to: "crown",
};
const refactorAction: Action = {
  description: "refactor module",
  estimated_gain: 50,
  estimated_cost: 10,
  category: "refactor",
  delegate_to: "seed",
};
const ctx = { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 100, total_visits: 5 };

describe("createCockpitTelemetrySource (prod-stub fix)", () => {
  let dir: string;
  let runtime: ArborRuntime;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cockpit-tele-"));
    runtime = new ArborRuntime({ persistence_dir: dir, devtools_logger: { persistence_dir: dir, disable_fsync: true } });
    await runtime.start();
  });
  afterEach(async () => {
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns a real projection (non-zero source_record_count) once observations exist", async () => {
    const manager = runtime.manager;
    manager.startCampaign("c1", "plan.md", rootAction);
    // Produce a real audit trace so the telemetry observation has witnessed source evidence.
    const [nid] = manager.branch("c1", "root", [refactorAction]);
    manager.expandNode("c1", nid, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
    manager.recordResult("c1", nid, {
      specialist_output: "ok", specialist_agent: "seed",
      provenance: { tag: "verified", cmd: "npx vitest run", exit: 0, stdout_hash: "sha256:test"},
      critic_agent: "lenticel", critic_approved: true, critic_rationale: "ok", score_ctx: ctx,
    });
    const witness = manager.getLatestEvidenceId("c1");
    if (!witness) throw new Error("expected a witnessed evidence record after recordResult");
    manager.recordTelemetryObservation({
      campaign_id: "c1", node_id: nid, operation_id: "op:1", epoch: 1,
      type: "phase_timing", phase: "select", outcome: "success", duration_ms: 42,
      source_evidence_id: witness, idempotency_key: "t:1", provenance: { tag: "claimed", claimant: "test" },
    });

    const source = createCockpitTelemetrySource(runtime);
    const snap = await source.fetch("c1");
    expect(snap.source_record_count).toBeGreaterThan(0);
    expect(snap.campaign_id).toBe("c1");
    expect(snap.phase_histograms.length).toBeGreaterThan(0);
  });

  it("returns an empty snapshot (not a throw) for a campaign with no telemetry", async () => {
    const source = createCockpitTelemetrySource(runtime);
    const snap = await source.fetch("no-such-campaign");
    expect(snap.source_record_count).toBe(0);
    expect(snap.counters).toEqual([]);
    expect(snap.phase_histograms).toEqual([]);
  });

  it("rejects (fail-visible) instead of returning a fabricated empty snapshot when the projection itself fails", async () => {
    // A genuine projection fault (metrics-projector.ts's AuditIntegrityError
    // path — empty campaign id, untrusted ledger, or over-limit projection)
    // must not be indistinguishable from real emptiness. Simulate that fault
    // directly against `manager.projectTelemetry` rather than trying to
    // corrupt the on-disk ledger from a test.
    const failing = {
      manager: {
        projectTelemetry() {
          throw new Error("cannot project untrusted telemetry ledger: simulated integrity failure");
        },
      },
    } as unknown as Parameters<typeof createCockpitTelemetrySource>[0];
    const source = createCockpitTelemetrySource(failing);
    await expect(source.fetch("c1")).rejects.toThrow(/simulated integrity failure/);
  });
});
