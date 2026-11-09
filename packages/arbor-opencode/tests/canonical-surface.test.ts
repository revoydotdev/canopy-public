import { describe, expect, it } from "vitest";
import { ArborRuntime, ManagerTelemetryAdapter } from "@arbor/mcp";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action, CapabilityContext, ScoreContext } from "@arbor/core";
import { modelCapabilityTokenBridge } from "@arbor/campaign-support";
import { runCampaign, DEFAULT_LOOP_CONFIG, type CampaignLoopConfig, type LoopExecutor } from "../src/loop.js";

const rootAction: Action = {
  description: "execute plan",
  estimated_gain: 100,
  estimated_cost: 1,
  category: "root",
  delegate_to: "crown",
};

const refactorAction: Action = {
  description: "refactor auth module",
  estimated_gain: 50,
  estimated_cost: 10,
  category: "refactor",
  delegate_to: "seed",
};

const ctx: ScoreContext = {
  accuracy_regression_rate: 0,
  crash_regression_rate: 0,
  best_known: 100,
  total_visits: 5,
};

const specialistCap: CapabilityContext = { tier: "specialist" };
const criticCap: CapabilityContext = { tier: "critic" };

function approvingExecutor(): LoopExecutor & { specialized: string[]; reviewed: string[] } {
  const specialized: string[] = [];
  const reviewed: string[] = [];
  return {
    specialized,
    reviewed,
    async specialize({ node_id }) {
      specialized.push(node_id);
      return { output: "work complete", provenance: { tag: "verified", cmd: "npx vitest run", exit: 0, stdout_hash: "sha256:test" }, token_usage: { kind: "unavailable", reason: "test fixture" } };
    },
    async review({ node_id }) {
      reviewed.push(node_id);
      return { approved: true, rationale: "approved", measurement_validated: true, token_usage: { kind: "unavailable", reason: "test fixture" } };
    },
    log() {},
  };
}

describe("canonical surface convergence — OpenCode loop", () => {
  it("composes canonical loop ports from ArborRuntime into CampaignLoopConfig", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-canonical-opencode-"));
    try {
      const runtime = new ArborRuntime({ persistence_dir: dir, model_capabilities: {
        maxOutputTokens: () => ({ value: 8_192, source: "runtime" }),
        contextCapacity: () => ({ value: 200_000, source: "runtime" }),
      } });
      const manager = runtime.manager;
      manager.startCampaign("camp1", "plan.md", rootAction);
      manager.branch("camp1", "root", [refactorAction]);

      // Composed inline, the way a real launcher does it. The deleted
      // composeCanonicalLoopConfig helper only restated these assignments;
      // doing it here is what proves the ports are structurally usable.
      const canonical = {
        communications: runtime.loopPorts.communications,
        output_evidence: runtime.loopPorts.output_evidence,
        interruptions: runtime.loopPorts.interruptions,
        telemetry: runtime.loopPorts.telemetry,
        score_ctx: runtime.loopPorts.score_ctx,
        modelCapabilities: runtime.modelCapabilities,
      };

      expect(canonical.communications).toBeDefined();
      expect(canonical.output_evidence).toBeDefined();
      expect(canonical.interruptions).toBeDefined();
      expect(canonical.telemetry).toBeInstanceOf(ManagerTelemetryAdapter);
      expect(canonical.modelCapabilities).toBe(runtime.modelCapabilities);

      // Verify structural match: ports can be passed to runCampaign.
      const config: CampaignLoopConfig = {
        max_iterations: 5,
        specialist_base_prompt: DEFAULT_LOOP_CONFIG.specialist_base_prompt,
        critic_base_prompt: DEFAULT_LOOP_CONFIG.critic_base_prompt,
        specialist_cap: specialistCap,
        critic_cap: criticCap,
        score_ctx: () => ctx,
        use_worktrees: false,
        branch_actions: () => null,
        communications: canonical.communications,
        output_evidence: canonical.output_evidence,
        interruptions: canonical.interruptions,
        telemetry: canonical.telemetry,
      };

      const executor = approvingExecutor();
      const report = await runCampaign({ manager, campaign_id: "camp1", executor, config });
      expect(report.iterations).toBeGreaterThanOrEqual(0);
      expect(report.halted).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("modelCapabilityTokenBridge routes provider metadata and falls back without fabricating a counter", () => {
    const nullBridge = modelCapabilityTokenBridge({
      resolveOutputLimit: () => ({ effective_max_output_tokens: 128_000, limit_source: "snapshot" }),
      resolveContextCapacity: () => ({ value: 224_000, source: "snapshot" }),
      estimateTokens: async () => null,
    });
    expect(nullBridge.counter_id).toBe("arbor-runtime-model-capability");
    const cap = nullBridge.capability({ campaign_id: "c", node_id: "n" });
    expect(cap).toMatchObject({
      provider_id: "arbor-runtime",
      model_id: "default",
      max_output_tokens: 128_000,
      source: "snapshot",
    });

    const liveRuntime = new ArborRuntime({ model_capabilities: {
      maxOutputTokens: () => ({ value: 8_192, source: "runtime" }),
      contextCapacity: () => ({ value: 200_000, source: "runtime" }),
      estimateTokens: ({ content }) => content.length,
    } });
    const liveBridge = modelCapabilityTokenBridge(liveRuntime.modelCapabilities, "openai", "gpt-4");
    const liveCap = liveBridge.capability({ campaign_id: "c", node_id: "n" });
    expect(liveCap).toMatchObject({
      provider_id: "openai",
      model_id: "gpt-4",
      max_output_tokens: 8_192,
      source: "runtime",
    });
  });

  it("G-34: modelCapabilityTokenBridge actually feeds the model id to the provider — the lazy cache is warmed for a named model, not left dark", async () => {
    // Before the fix, `capability()`/`count()` called `resolveOutputLimit`/
    // `estimateTokens` without a `model`, so a provider keyed by model
    // (like `OpenCodeProviderCapabilityAdapter`, which returns `null` for
    // `model: undefined` and only warms its cache for a named model) could
    // never be reached even though this bridge already accepted a real
    // `modelId` parameter. Assert the provider actually observes it.
    const seenModels: (string | undefined)[] = [];
    const runtime = new ArborRuntime({
      model_capabilities: {
        maxOutputTokens: (input) => {
          seenModels.push(input.model);
          return { value: 4_096, source: "runtime" };
        },
        contextCapacity: () => ({ value: 200_000, source: "runtime" }),
        estimateTokens: (input) => {
          seenModels.push(input.model);
          return input.content.length;
        },
      },
    });
    const bridge = modelCapabilityTokenBridge(runtime.modelCapabilities, "anthropic", "claude-opus-4");
    const cap = await bridge.capability({ campaign_id: "c", node_id: "n" });
    expect(cap).toBeDefined();
    expect(bridge.count).toBeDefined();
    await bridge.count!("some text to count", cap!);
    expect(seenModels).toEqual(["claude-opus-4", "claude-opus-4"]);
  });

  it("injects live provider metadata through canonical adapter and emits telemetry without breaking the loop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-provider-meta-"));
    try {
      const telemetryCalls: string[] = [];
      const runtime = new ArborRuntime({
        persistence_dir: dir,
        model_capabilities: {
          maxOutputTokens: () => ({ value: 4_096, source: "runtime" }),
        },
      });
      // Override telemetry for test observation
      const originalTelemetry = runtime.loopPorts.telemetry;
      runtime.loopPorts.telemetry = {
        recordPhaseTiming(input) {
          telemetryCalls.push(`phase:${input.phase}:${input.outcome}`);
          return originalTelemetry?.recordPhaseTiming(input) ?? "";
        },
        // Mirrors the real port rather than stubbing it out: a double that
        // silently drops a method the production adapter implements would
        // hide exactly the wiring this file exists to observe.
        recordPhaseMessage(input) {
          telemetryCalls.push(`phase-message:${input.node_id}:${input.phase}`);
          return originalTelemetry?.recordPhaseMessage?.(input) ?? "";
        },
        recordUsageCost(input) {
          telemetryCalls.push(`cost:${input.phase}:${input.provider}`);
          return originalTelemetry?.recordUsageCost(input) ?? "";
        },
        recordRoleModelIdentity(input) {
          telemetryCalls.push(`model:${input.role}:${input.model_id}`);
          return originalTelemetry?.recordRoleModelIdentity(input) ?? "";
        },
        recordRaceOutcome(input) {
          telemetryCalls.push(`race:${input.winner}:${input.threshold_source ?? "none"}`);
          return originalTelemetry?.recordRaceOutcome(input) ?? "";
        },
        recordNodeCostAttribution(input) {
          telemetryCalls.push(`node-cost:${input.node_id}:${input.pruning_signal}`);
          return originalTelemetry?.recordNodeCostAttribution(input) ?? "";
        },
        recordContextEconomy(input) {
          telemetryCalls.push(`context:${input.node_id}:${input.phase}`);
          return originalTelemetry?.recordContextEconomy(input) ?? "";
        },
        recordToolEconomy(input) {
          telemetryCalls.push(`tools:${input.node_id}:${input.reused_reads}`);
          return originalTelemetry?.recordToolEconomy(input) ?? "";
        },
      };

      const manager = runtime.manager;
      manager.startCampaign("prov1", "plan.md", rootAction);
      manager.branch("prov1", "root", [refactorAction]);

      const canonical = {
        communications: runtime.loopPorts.communications,
        output_evidence: runtime.loopPorts.output_evidence,
        interruptions: runtime.loopPorts.interruptions,
        telemetry: runtime.loopPorts.telemetry,
        score_ctx: runtime.loopPorts.score_ctx,
        modelCapabilities: runtime.modelCapabilities,
      };

      const config: CampaignLoopConfig = {
        max_iterations: 5,
        specialist_base_prompt: DEFAULT_LOOP_CONFIG.specialist_base_prompt,
        critic_base_prompt: DEFAULT_LOOP_CONFIG.critic_base_prompt,
        specialist_cap: specialistCap,
        critic_cap: criticCap,
        use_worktrees: false,
        branch_actions: () => null,
        ...canonical,
      };

      const executor = approvingExecutor();
      const report = await runCampaign({ manager, campaign_id: "prov1", executor, config });
      expect(report.halted).toBeDefined();
      // Telemetry should have been emitted during the loop.
      expect(telemetryCalls.filter((c) => c.startsWith("phase:")).length).toBeGreaterThan(0);
      expect(telemetryCalls.filter((c) => c.includes("success")).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
