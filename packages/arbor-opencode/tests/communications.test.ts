import { describe, expect, it } from "vitest";
import { CampaignManager } from "@arbor/mcp";
import type { Action, CapabilityContext, ScoreContext } from "@arbor/core";
import {
  appendSelectionCommunications,
  type SelectionCommunication,
  type SelectionCommunicationPort,
} from "@arbor/campaign-support";
import { DEFAULT_LOOP_CONFIG, runCampaign, type CampaignLoopConfig, type GovernedOverlayCheckpointPort, type LoopExecutor } from "../src/loop.js";

const checkpoint = "2026-08-01T12:00:00.000Z";
const root: Action = { description: "plan", estimated_gain: 10, estimated_cost: 1, category: "root", delegate_to: "crown" };
const leaf: Action = { description: "implement", estimated_gain: 5, estimated_cost: 1, category: "code", delegate_to: "seed" };
const score: ScoreContext = { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 10, total_visits: 2 };
const specialist: CapabilityContext = { tier: "specialist" };
const critic: CapabilityContext = { tier: "critic" };

function communication(id: string, tier: "specialist" | "critic", content: string): SelectionCommunication {
  return {
    id,
    timestamp: "2026-08-01T11:00:00.000Z",
    communication: {
      author_node_id: "root",
      kind: "steer",
      payload: { content, provenance: { tag: "claimed", claimant: "human" } },
      capability_tier: tier,
      as_of: "2026-08-01T10:59:00.000Z",
      correlation_id: "corr-1",
      acknowledges_communication_id: null,
      retracts_communication_id: null,
    },
  };
}

function manager(id: string): CampaignManager {
  const result = new CampaignManager();
  result.startCampaign(id, "plan.md", root);
  result.branch(id, "root", [leaf]);
  return result;
}

function config(port?: SelectionCommunicationPort): CampaignLoopConfig {
  return {
    max_iterations: 1,
    specialist_base_prompt: DEFAULT_LOOP_CONFIG.specialist_base_prompt,
    critic_base_prompt: DEFAULT_LOOP_CONFIG.critic_base_prompt,
    specialist_cap: specialist,
    critic_cap: critic,
    score_ctx: () => score,
    use_worktrees: false,
    branch_actions: () => null,
    communications: port,
    communication_limit: 2,
    communication_clock: () => checkpoint,
  };
}

function capturingExecutor(prompts: string[]): LoopExecutor {
  return {
    async specialize({ prompt }) {
      prompts.push(prompt);
      return { output: "done", provenance: { tag: "verified", cmd: "test", exit: 0, stdout_hash: "sha256:test" }, token_usage: { kind: "unavailable", reason: "test fixture" } };
    },
    async review({ prompt }) {
      prompts.push(prompt);
      return { approved: true, rationale: "approved", token_usage: { kind: "unavailable", reason: "test fixture" } };
    },
  };
}

describe("selection-checkpoint communications", () => {
  it("injects capability-projected facts with provenance, freshness, and correlation", async () => {
    const specialistFact = communication("comm-specialist", "specialist", "public steering");
    const criticFact = communication("comm-critic", "critic", "critic-only concern");
    const calls: Parameters<SelectionCommunicationPort["projectSelection"]>[0][] = [];
    const port: SelectionCommunicationPort = {
      projectSelection(query) {
        calls.push(query);
        return query.tier === "critic" ? [specialistFact, criticFact] : [specialistFact];
      },
    };
    const prompts: string[] = [];

    await runCampaign({ manager: manager("cap"), campaign_id: "cap", executor: capturingExecutor(prompts), config: config(port) });

    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.as_of === checkpoint && call.limit === 2)).toBe(true);
    expect(prompts[0]).toContain("public steering");
    expect(prompts[0]).not.toContain("critic-only concern");
    expect(prompts[1]).toContain("critic-only concern");
    expect(prompts[0]).toContain('"correlation_id": "corr-1"');
    expect(prompts[0]).toContain('"provenance"');
    expect(prompts[0]).toContain('"checkpoint_at": "2026-08-01T12:00:00.000Z"');
  });

  it("preserves fan-out and restart-equivalent replay without delivery state", async () => {
    const shared = communication("fanout", "specialist", "applies to both recipients");
    const port: SelectionCommunicationPort = { projectSelection: () => [shared] };
    const first: string[] = [];
    const replay: string[] = [];

    await runCampaign({ manager: manager("first"), campaign_id: "first", executor: capturingExecutor(first), config: config(port) });
    await runCampaign({ manager: manager("replay"), campaign_id: "replay", executor: capturingExecutor(replay), config: config(port) });

    expect(first[0]).toContain("applies to both recipients");
    expect(replay[0]).toContain("applies to both recipients");
    expect(first[0]?.slice(first[0].indexOf("Selection-checkpoint"))).toBe(replay[0]?.slice(replay[0].indexOf("Selection-checkpoint")));
  });

  it("does not modify or block prompts when no messages exist", async () => {
    const base = "base prompt";
    expect(appendSelectionCommunications(base, { checkpoint_at: checkpoint, communications: [] })).toBe(base);
    const prompts: string[] = [];
    const port: SelectionCommunicationPort = { projectSelection: () => [] };

    const report = await runCampaign({ manager: manager("empty"), campaign_id: "empty", executor: capturingExecutor(prompts), config: config(port) });

    expect(report.verified).toBe(1);
    expect(prompts.every((prompt) => !prompt.includes("Selection-checkpoint communications"))).toBe(true);
  });

  it("samples governed overlays once at selection and enacts only their bounded prompt/context fields", async () => {
    const calls: Parameters<GovernedOverlayCheckpointPort["checkpoint"]>[0][] = [];
    const overlays: GovernedOverlayCheckpointPort = {
      checkpoint(input) {
        calls.push(input);
        return {
          checkpoint_at: input.as_of,
          specialist_context: ["folded specialist evidence"],
          critic_context: ["folded critic evidence"],
          specialist_prompt_fragments: ["use the accepted playbook"],
          critic_prompt_fragments: ["review the accepted playbook"],
          applied_overlay_ids: ["fold-1", "prompt-1"],
          unapplied_overlays: [{ id: "retrieval-1", reason: "no isolated retrieval/index adapter is configured" }],
        };
      },
    };
    const prompts: string[] = [];
    const events: string[] = [];
    const executor = capturingExecutor(prompts);
    executor.log = (event) => events.push(event.type);

    await runCampaign({ manager: manager("governed"), campaign_id: "governed", executor, config: { ...config(), governed_context: overlays } });

    expect(calls).toEqual([{ campaign_id: "governed", node_id: expect.any(String), as_of: checkpoint }]);
    expect(prompts[0]).toContain("folded specialist evidence");
    expect(prompts[0]).toContain("use the accepted playbook");
    expect(prompts[0]).not.toContain("folded critic evidence");
    expect(prompts[1]).toContain("folded critic evidence");
    expect(prompts[1]).toContain("review the accepted playbook");
    expect(events).toContain("governed_overlay_checkpoint");
  });

  it("bounds adversarial payloads while retaining full-content evidence metadata", () => {
    const huge = communication("huge/id", "specialist", `${"x".repeat(80_000)}\n${"line\n".repeat(2_000)}`);
    const rendered = appendSelectionCommunications("base", {
      checkpoint_at: checkpoint,
      communications: [huge],
    }, { max_bytes: 2_000, max_lines: 30, max_tokens_estimate: 500 });

    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(2_006);
    expect(rendered).toContain("…[output abbreviated]…");
    expect(rendered).not.toContain("x".repeat(10_000));
  });
});
