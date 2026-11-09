import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Action } from "@arbor/core";
import { CampaignManager } from "../src/manager.js";
import { ArborRuntime } from "../src/runtime.js";
import { ManagerSelectionCommunicationAdapter, ManagerScoreContextAdapter } from "../src/loop-adapters.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function persistenceRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "arbor-loop-adapters-"));
  directories.push(directory);
  return directory;
}

const root: Action = {
  description: "root",
  estimated_gain: 1,
  estimated_cost: 1,
  category: "root",
  delegate_to: "crown",
};

describe("canonical loop adapters", () => {
  it("restores communication projections and output evidence through one runtime owner", async () => {
    const persistence = persistenceRoot();
    const manager = new CampaignManager({ persistence_dir: persistence });
    manager.startCampaign("campaign", "plan.md", root);
    const runtime = new ArborRuntime({ manager, persistence_dir: persistence });
    expect(runtime.loopPorts.communications).toBe(runtime.selectionCommunications);
    expect(runtime.loopPorts.output_evidence).toBe(runtime.outputCapture);
    const before = runtime.eventStream.cursor().sequence;
    manager.recordNodeCommunication({
      campaign_id: "campaign",
      node_id: "root",
      author_node_id: "crown",
      recipient_node_id: "root",
      other_recipient_node_ids: [],
      kind: "steer",
      payload: { content: "check durable state", provenance: { tag: "claimed", claimant: "operator" } },
      capability_tier: "specialist",
      trigger_turn: false,
      as_of: "2026-08-01T00:00:00.000Z",
      correlation_id: "corr",
      idempotency_key: "communication-one",
      acknowledges_communication_id: null,
      retracts_communication_id: null,
      timestamp: "2026-08-01T00:00:00.000Z",
    });
    expect(runtime.selectionCommunications.projectSelection({
      campaign_id: "campaign", node_id: "root", tier: "specialist", limit: 10, as_of: "2026-08-01T00:00:01.000Z",
    })).toHaveLength(1);
    expect(runtime.eventStream.cursor().sequence).toBe(before + 1);

    const captured = await runtime.outputCapture.capture({
      campaign_id: "campaign", node_id: "root", kind: "specialist", content: "full model output",
      provenance: { tag: "claimed", claimant: "seed" },
    });
    await runtime.close();

    const restarted = new ArborRuntime({ persistence_dir: persistence });
    expect(restarted.selectionCommunications.projectSelection({
      campaign_id: "campaign", node_id: "root", tier: "specialist", limit: 10, as_of: "2026-08-01T00:00:01.000Z",
    })).toHaveLength(1);
    const replay = await restarted.outputCapture.capture({
      campaign_id: "campaign", node_id: "root", kind: "specialist", content: "full model output",
      provenance: { tag: "claimed", claimant: "seed" },
    });
    expect(replay).toEqual(captured);
    const id = captured.evidence_pointer.split("/").at(-1);
    expect(id && restarted.outputEvidence?.verify(id)).toMatchObject({ stream: "model", byte_count: 17 });
  });

  it("enforces adapter authority before manager capability projection", () => {
    const manager = new CampaignManager();
    manager.startCampaign("campaign", "plan.md", root);
    const specialist = new ManagerSelectionCommunicationAdapter(manager, "specialist");
    expect(() => specialist.projectSelection({
      campaign_id: "campaign", node_id: "root", tier: "critic", limit: 1, as_of: new Date().toISOString(),
    })).toThrow(/exceeds adapter authority/);
  });

  it("derives a live score context with real regression rates from observed outcomes", () => {
    const manager = new CampaignManager();
    manager.startCampaign("ctx-campaign", "plan.md", {
      description: "root",
      estimated_gain: 1,
      estimated_cost: 1,
      category: "root",
      delegate_to: "crown",
    });
    const [okNode] = manager.branch("ctx-campaign", "root", [{
      description: "ok", estimated_gain: 10, estimated_cost: 2, category: "ok", delegate_to: "seed",
    }]);
    const [failNode] = manager.branch("ctx-campaign", "root", [{
      description: "fail", estimated_gain: 5, estimated_cost: 2, category: "fail", delegate_to: "seed",
    }]);
    for (const nodeId of [okNode, failNode]) {
      manager.expandNode("ctx-campaign", nodeId, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
    }
    manager.recordResult("ctx-campaign", okNode, {
      specialist_output: "done", specialist_agent: "seed",
      provenance: { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test"},
      critic_agent: "lenticel", critic_approved: true, critic_rationale: "approved",
      score_ctx: { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 0, total_visits: 0 },
    });
    manager.recordResult("ctx-campaign", failNode, {
      specialist_output: "broken", specialist_agent: "seed",
      provenance: { tag: "claimed", claimant: "seed" },
      critic_agent: "lenticel", critic_approved: false, critic_rationale: "bad", critic_root_cause: "test regression",
      score_ctx: { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 0, total_visits: 0 },
    });

    const adapter = new ManagerScoreContextAdapter(manager);
    const ctx = adapter.score_ctx("ctx-campaign");
    // Two leaves were visited (expanded): one verified, one failed. The failed
    // one must surface as a real accuracy-regression signal, never a hardcoded 0.
    expect(ctx.total_visits).toBeGreaterThanOrEqual(2);
    expect(ctx.accuracy_regression_rate).toBeGreaterThan(0);
    expect(ctx.accuracy_regression_rate).toBeLessThanOrEqual(1);
    expect(ctx.best_known).toBeGreaterThan(0);
    // best_known stays on the selection-score scale (ADR-131): it is the best
    // verified node's score, not the measured reward best_score now carries.
    const snapshot = manager.getCampaignSnapshot("ctx-campaign")!;
    const verifiedScores = snapshot.nodes.filter((node) => node.state === "verified").map((node) => node.score);
    expect(ctx.best_known).toBe(Math.max(...verifiedScores));
    expect(snapshot.best_score).toBe(1);
    expect(adapter.score_ctx("missing")).toEqual({ accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 0, total_visits: 0 });
  });

  it("clamps output to provider metadata, tags its source, and never fabricates estimates", async () => {
    const unavailable = new ArborRuntime().modelCapabilities;
    expect(unavailable.resolveOutputLimit({ requested_max_output_tokens: 4_000 })).toEqual({
      requested_max_output_tokens: 4_000,
      effective_max_output_tokens: 4_000,
      limit_source: "requested",
      provider_max_output_tokens: null,
    });
    expect(await unavailable.estimateTokens({ content: "not guessed" })).toBeNull();

    const runtime = new ArborRuntime({ model_capabilities: {
      maxOutputTokens: () => ({ value: 1_024, source: "runtime" }),
      estimateTokens: ({ content }) => content === "provider counted" ? 3 : 0,
    } });
    expect(runtime.modelCapabilities.resolveOutputLimit({ requested_max_output_tokens: 4_000 })).toEqual({
      requested_max_output_tokens: 4_000,
      effective_max_output_tokens: 1_024,
      limit_source: "runtime",
      provider_max_output_tokens: 1_024,
    });
    expect(await runtime.modelCapabilities.estimateTokens({ content: "provider counted" })).toEqual({ value: 3, source: "provider" });
    expect(runtime.modelCapabilities.resolveContextCapacity({ model: "known" })).toBeNull();
    const withContext = new ArborRuntime({ model_capabilities: {
      maxOutputTokens: () => ({ value: 1_024, source: "runtime" }),
      contextCapacity: () => ({ value: 32_000, source: "runtime" }),
    } });
    expect(withContext.modelCapabilities.resolveContextCapacity({ model: "known" })).toEqual({ value: 32_000, source: "runtime" });
  });
});

describe("ManagerTelemetryAdapter.recordRaceOutcome (ADR-067 / bench v5 regression)", () => {
  it("journals a race observation against a real ledger — the empty-witness shape the ledger refuses must never come back", async () => {
    const { CampaignManager } = await import("../src/manager.js");
    const { ManagerTelemetryAdapter } = await import("../src/loop-adapters.js");
    const mgr = new CampaignManager();
    mgr.startCampaign("race-c1", "p.md", { description: "root", estimated_gain: 1, estimated_cost: 1, category: "general", delegate_to: "seed" });
    // startCampaign's admission gate checkpoint is the prior evidence the
    // ledger demands as the observation's witness — the exact guard the
    // loop's own `getLatestEvidenceId` call satisfies in production.
    const witness = mgr.getLatestEvidenceId("race-c1");
    expect(witness).not.toBeNull();
    const adapter = new ManagerTelemetryAdapter(mgr);
    const id = adapter.recordRaceOutcome({
      campaign_id: "race-c1", node_id: "root", operation_id: "race-c1:root:race", epoch: 1,
      source_evidence_id: witness!,
      forked_at_ms: 20000, winner: "fork", loser_wall_ms: 31000, cancelled: true,
    });
    expect(typeof id).toBe("string");
    const observations = mgr.getTelemetryObservations("race-c1").filter((record) => record.observation.type === "race_outcome");
    expect(observations).toHaveLength(1);
    expect(observations[0]?.observation).toMatchObject({ winner: "fork", forked_at_ms: 20000, cancelled: true });
  });
});
