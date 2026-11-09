import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";

const action = { description: "work", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed" };

describe("canonical runtime interruption", () => {
  it("persists request, supervisor acknowledgement, and state before replaying idempotently after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-interrupt-runtime-"));
    try {
      const runtime = new ArborRuntime({ persistence_dir: directory });
      runtime.manager.startCampaign("camp", "plan.md", action);
      const root = runtime.manager.getCampaignSnapshot("camp")!.root_id;
      runtime.manager.branch("camp", root, [action]);
      const child = runtime.manager.getCampaignSnapshot("camp")!.nodes.find((node) => node.parent_id === root)!.id;
      runtime.supervisor.register({ id: "worker", operation_id: "worker-op", kind: `node_expansion:${child}`, owner_scope_id: "camp" });
      runtime.supervisor.start("worker");
      const router = new RuntimeCatalogRouter(runtime);
      const command = envelope(runtime, child);
      await expect(router.dispatchCommand(command)).resolves.toMatchObject({ ok: true, value: { accepted: true } });
      expect(runtime.manager.getNodeInfo("camp", child)?.state).toBe("interrupted");
      expect(runtime.supervisor.get("worker")?.state).toBe("cancelled");
      expect(runtime.manager.getAuditRecords("camp").filter((record) => record.kind === "interruption")
        .map((record) => record.kind === "interruption" && record.interruption.phase))
        .toEqual(["requested", "acknowledged", "state_applied"]);
      expect(runtime.manager.auditCampaign("camp").failed).toBe(0);

      const restarted = new ArborRuntime({ persistence_dir: directory });
      const replay = await new RuntimeCatalogRouter(restarted).dispatchCommand(command);
      expect(replay).toMatchObject({ ok: true, value: { accepted: true } });
      expect(restarted.manager.getNodeInfo("camp", child)?.state).toBe("interrupted");
      expect(restarted.manager.getAuditRecords("camp").filter((record) => record.kind === "interruption")).toHaveLength(3);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("rejects stale versions and capability denial without changing the node", async () => {
    const runtime = new ArborRuntime();
    runtime.manager.startCampaign("cap", "plan.md", action);
    const root = runtime.manager.getCampaignSnapshot("cap")!.root_id;
    const node = runtime.manager.branch("cap", root, [action])[0];
    const command = envelope(runtime, node);
    command.metadata.expected_version = "stale";
    await expect(new RuntimeCatalogRouter(runtime).dispatchCommand(command)).resolves.toMatchObject({ ok: true, value: { accepted: false, error: { code: "conflict" } } });
    const denied = envelope(runtime, node, "denied-op");
    await expect(new RuntimeCatalogRouter(runtime, { granted_capabilities: new Set() }).dispatchCommand(denied))
      .resolves.toMatchObject({ ok: false, error: { code: "permission" } });
    expect(runtime.manager.getNodeInfo("cap", node)?.state).toBe("pending");
  });

  it("survives kill/restart as typed evidence and cannot be confused with critic approval, failure, or liveness — all three ledger phases survive and the node is counted in zero test counts except interrupted", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-interrupt-survival-"));
    try {
      const first = new ArborRuntime({ persistence_dir: directory });
      first.manager.startCampaign("survive", "plan.md", action);
      const root = first.manager.getCampaignSnapshot("survive")!.root_id;
      first.manager.branch("survive", root, [action]);
      const child = first.manager.getCampaignSnapshot("survive")!.nodes.find((node) => node.parent_id === root)!.id;
      first.manager.expandNode("survive", child, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
      first.supervisor.register({ id: "w", operation_id: "w-op", kind: `node_expansion:${child}`, owner_scope_id: "survive" });
      first.supervisor.start("w");
      await new RuntimeCatalogRouter(first).dispatchCommand(envelope(first, child));
      expect(first.manager.getNodeInfo("survive", child)?.state).toBe("interrupted");

      const restarted = new ArborRuntime({ persistence_dir: directory });
      const node = restarted.manager.getNodeInfo("survive", child);
      expect(node?.state).toBe("interrupted");

      // The interrupted node is typed evidence — it must NOT be counted in verified, claimed, or failed.
      const stats = restarted.manager.auditCampaign("survive");
      expect(stats.verified).toBe(0);
      expect(stats.claimed).toBe(0);
      expect(stats.failed).toBe(0);

      // All three interruption ledger phases survive restart.
      const interruptions = restarted.manager.getAuditRecords("survive").filter((r) => r.kind === "interruption");
      expect(interruptions.map((r) => r.kind === "interruption" && r.interruption.phase)).toEqual(["requested", "acknowledged", "state_applied"]);

      // The interrupted node is not selectable (not confused with pending/liveness).
      expect(restarted.manager.selectNode("survive", { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 100, total_visits: 5 })).toBeNull();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("composes one persistence-rooted token epoch repository into loop ports", () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-token-runtime-"));
    try {
      const runtime = new ArborRuntime({ persistence_dir: directory });
      expect(runtime.loopPorts.token_epochs).toBe(runtime.tokenEpochs);
      const epoch = runtime.tokenEpochs.ensure({ campaign_id: "c", node_id: "n", expansion_id: "attempt-1", capability: { provider_id: "provider", model_id: "model", context_capacity: 100, max_output_tokens: 10, source: "runtime" }, reserved_output_tokens: 10, requested_output_tokens: 5, prefill: { tokens: 5, source: "character_fallback", characters_per_token: 4 } });
      expect(new ArborRuntime({ persistence_dir: directory }).tokenEpochs.get("c", "n", "attempt-1")?.epoch_id).toBe(epoch.epoch_id);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

function envelope(runtime: ArborRuntime, node: string, operation = "interrupt-op") {
  return {
    schema_version: 1 as const,
    metadata: { operation_id: operation, idempotency_key: operation, correlation_id: "corr", actor_id: "operator", requested_at: new Date().toISOString(), expected_version: runtime.manager.getCampaignVersion(runtime.manager.getActiveCampaignId()!) },
    command: { kind: "tree.interrupt" as const, campaign_id: runtime.manager.getActiveCampaignId()!, node_id: node, scope: "subtree" as const, reason: "operator stop", provenance: { tag: "claimed" as const, claimant: "operator" } },
  };
}
