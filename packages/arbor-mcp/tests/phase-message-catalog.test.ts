/**
 * ADR-016: end-to-end proof that a real campaign run journals a specialist's
 * completed output as a `final` ledger phase message, and that the
 * `phase_message.list` catalog kind — the only surface that can read one
 * back — returns it. This drives the real `runCampaign` loop
 * (`@arbor/opencode`) against the real `CampaignManager`/`EvidenceLedger`
 * through the same `ManagerTelemetryAdapter` `ArborRuntime` wires into
 * `arbor run` (runtime.ts's `loopPorts.telemetry`); only the executor (the
 * opencode-CLI transport boundary) is a fake, exactly like the sibling
 * `campaign-run-wait.test.ts`/`campaign-job-runner.test.ts` real-loop tests.
 */
import { describe, expect, it } from "vitest";
import type { Action } from "@arbor/core";
import { runCampaign, type CampaignLoopConfig, type LoopExecutor } from "@arbor/opencode";
import { CampaignManager } from "../src/manager.js";
import { ManagerTelemetryAdapter } from "../src/loop-adapters.js";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter, RUNTIME_CATALOG } from "../src/runtime-catalog.js";

const root: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
const child: Action = { description: "refactor auth module", estimated_gain: 50, estimated_cost: 10, category: "refactor", delegate_to: "seed" };
const SPECIALIST_OUTPUT = "specialist observed real work: implemented the feature, tests pass";

function loopConfig(manager: CampaignManager): CampaignLoopConfig {
  return {
    max_iterations: 1,
    specialist_base_prompt: "specialist",
    critic_base_prompt: "critic",
    specialist_cap: { tier: "specialist" },
    critic_cap: { tier: "critic" },
    score_ctx: () => ({ accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 100, total_visits: 1 }),
    use_worktrees: false,
    branch_actions: () => null,
    // The real bridge from loop telemetry onto the canonical manager ledger —
    // exactly what `runtime.ts`'s `loopPorts.telemetry` wires for `arbor run`.
    telemetry: new ManagerTelemetryAdapter(manager),
  };
}

function realisticExecutor(): LoopExecutor {
  return {
    async specialize() {
      return {
        output: SPECIALIST_OUTPUT,
        provenance: { tag: "verified", cmd: "npm test", exit: 0, stdout_hash: "sha256:test" },
        token_usage: { kind: "unavailable", reason: "test executor" },
      };
    },
    async review() {
      return { approved: true, rationale: "looks good", token_usage: { kind: "unavailable", reason: "test executor" } };
    },
  };
}

describe("phase message evidence — end to end (ADR-016)", () => {
  it("a real campaign run durably records a `final` phase message the query kind returns", async () => {
    const manager = new CampaignManager();
    manager.startCampaign("camp1", "plan.md", root);
    manager.branch("camp1", "root", [child]);
    const router = new RuntimeCatalogRouter(new ArborRuntime({ manager }));

    const report = await runCampaign({ manager, campaign_id: "camp1", executor: realisticExecutor(), config: loopConfig(manager) });
    expect(report.iterations).toBeGreaterThan(0);

    // Read directly off the manager — the durable ledger authority.
    const direct = manager.getPhaseMessages("camp1");
    expect(direct).toHaveLength(1);
    expect(direct[0].message.phase).toBe("final");
    expect(direct[0].message.content).toBe(SPECIALIST_OUTPUT);
    const nodeId = direct[0].node_id;

    // The catalog declares the read surface, supported and capability-gated.
    const entry = RUNTIME_CATALOG.find((e) => e.kind === "phase_message.list" && e.direction === "query");
    expect(entry).toMatchObject({ supported: true, capability: "phase_message.read" });

    // Read it back through the same catalog surface an operator/agent uses.
    const result = router.executeQuery({
      schema_version: 1, query_id: "q1",
      query: { kind: "phase_message.list", campaign_id: "camp1", node_id: nodeId },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const projection = result.value as { records: Array<{ node_id: string; message: { phase: string; content: string } }> };
    expect(projection.records).toHaveLength(1);
    expect(projection.records[0].node_id).toBe(nodeId);
    expect(projection.records[0].message.phase).toBe("final");
    expect(projection.records[0].message.content).toBe(SPECIALIST_OUTPUT);

    // Also visible in the general per-campaign audit ledger projection.
    const auditRecords = manager.getAuditRecords("camp1");
    expect(auditRecords.some((r) => r.kind === "phase_message")).toBe(true);
  });

  it("filters by phase and by an unrelated node", async () => {
    const manager = new CampaignManager();
    manager.startCampaign("camp1", "plan.md", root);
    manager.branch("camp1", "root", [child]);
    const router = new RuntimeCatalogRouter(new ArborRuntime({ manager }));
    await runCampaign({ manager, campaign_id: "camp1", executor: realisticExecutor(), config: loopConfig(manager) });

    const wrongNode = router.executeQuery({
      schema_version: 1, query_id: "q2",
      query: { kind: "phase_message.list", campaign_id: "camp1", node_id: "no-such-node" },
    });
    expect(wrongNode.ok).toBe(true);
    if (!wrongNode.ok) throw new Error("unreachable");
    expect((wrongNode.value as { records: unknown[] }).records).toHaveLength(0);

    const wrongPhase = router.executeQuery({
      schema_version: 1, query_id: "q3",
      query: { kind: "phase_message.list", campaign_id: "camp1", phase: "commentary" },
    });
    expect(wrongPhase.ok).toBe(true);
    if (!wrongPhase.ok) throw new Error("unreachable");
    expect((wrongPhase.value as { records: unknown[] }).records).toHaveLength(0);
  });

  it("rejects the query without the phase_message.read capability", async () => {
    const manager = new CampaignManager();
    manager.startCampaign("camp1", "plan.md", root);
    const denied = new RuntimeCatalogRouter(new ArborRuntime({ manager }), { granted_capabilities: new Set(["campaign.read"]) });
    const result = denied.executeQuery({
      schema_version: 1, query_id: "q1", query: { kind: "phase_message.list", campaign_id: "camp1" },
    });
    expect(result.ok).toBe(false);
  });

  it("validates a malformed phase_message query", async () => {
    const manager = new CampaignManager();
    manager.startCampaign("camp1", "plan.md", root);
    const router = new RuntimeCatalogRouter(new ArborRuntime({ manager }));
    const result = router.executeQuery({
      schema_version: 1, query_id: "q1", query: { kind: "phase_message.list", campaign_id: "" },
    });
    expect(result.ok).toBe(false);
  });
});
