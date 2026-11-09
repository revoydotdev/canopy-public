import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenCodeCampaignIntegration, createOpenCodeTaskPlanner, DEFAULT_OPENCODE_PLANNER_MODEL, parseOpenCodeJsonEvents, renderOpenCodePlanningPrompt } from "../src/integrations/opencode-campaign.js";
import { RepositoryGraphIndex } from "../src/repository-graph.js";
import { ARBOR_CRITIC_TRANSPORT_ENV, type NativeCriticPort } from "../src/native-critic-transport.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures/fake-opencode.mjs");
const saved = {
  stdout: process.env.FAKE_OPENCODE_STDOUT,
  stderr: process.env.FAKE_OPENCODE_STDERR,
  exit: process.env.FAKE_OPENCODE_EXIT,
};
const fixtureDirs: string[] = [];

afterEach(() => {
  while (fixtureDirs.length > 0) rmSync(fixtureDirs.pop()!, { recursive: true, force: true });
  for (const [key, value] of Object.entries({
    FAKE_OPENCODE_STDOUT: saved.stdout,
    FAKE_OPENCODE_STDERR: saved.stderr,
    FAKE_OPENCODE_EXIT: saved.exit,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("createOpenCodeTaskPlanner", () => {
  it("uses a stable schema-capable planner alias distinct from the coding default", () => {
    expect(DEFAULT_OPENCODE_PLANNER_MODEL).toBe("openrouter/~openai/gpt-mini-latest");
  });
  it("injects the bounded shared repository graph into the otherwise tool-free planning prompt", () => {
    const cwd = mkdtempSync(join(tmpdir(), "opencode-planner-context-"));
    fixtureDirs.push(cwd);
    writeFileSync(join(cwd, "queue.js"), "export class Queue { enqueue(value) {} }\n");
    const prompt = renderOpenCodePlanningPrompt({ cwd, repository_graph: new RepositoryGraphIndex(), planning_prompt: () => "plan queue changes" }, {
      draft_id: "draft-context", task: "add Queue enqueueAll", answers: {}, parent_campaign_id: null, evidence_ids: [],
    });
    expect(prompt).toContain("Task-ranked repository graph");
    expect(prompt).toContain("queue.js");
    expect(prompt).toContain("grounded repository signal");
  });
  it("returns a normalized, identity-bearing proposal through the read-only CLI seam", async () => {
    const proposal = JSON.stringify({
      summary: "repair rust planner",
      assumptions: [], questions: [],
      root_action: { description: "repair", estimated_gain: 1, estimated_cost: 1, category: "testing", delegate_to: "seed" },
      actions: [{ description: "removed child", estimated_gain: 1, estimated_cost: 1, category: "testing", delegate_to: "seed" }],
      acceptance_checks: ["cargo test"],
      acceptance_mapping: [{ criterion: "cargo test", action_descriptions: ["removed child"] }],
      risk_notes: [],
    });
    process.env.FAKE_OPENCODE_STDOUT = [
      JSON.stringify({ type: "text", sessionID: "ses-real", part: { type: "text", text: '{"diagnostic":true}\n' } }),
      JSON.stringify({ type: "text", sessionID: "ses-real", part: { type: "text", text: `final proposal:\n${proposal}` } }),
      JSON.stringify({ type: "step_finish", sessionID: "ses-real", part: { tokens: { input: 12, output: 8, cache: { read: 4, write: 2 } } } }),
    ].join("\n");
    const planner = createOpenCodeTaskPlanner({
      cwd: process.cwd(), opencode_bin: fixture, model: "provider/model",
      planning_prompt: (input) => `plan:${input.task}`,
    });
    const result = await planner.plan({ draft_id: "draft-1", task: "one atomic repair action", answers: {}, parent_campaign_id: null, evidence_ids: [] });
    expect(JSON.parse(result.raw_proposal)).toMatchObject({ summary: "repair rust planner", actions: [{ description: "repair" }] });
    expect(JSON.parse(result.raw_proposal).acceptance_mapping).toEqual([{ criterion: "cargo test", action_descriptions: ["repair"] }]);
    expect(result).toMatchObject({
      session_id: "ses-real",
      model_identity: "opencode/provider/model",
      usage: { input_tokens: 12, output_tokens: 8, cached_input_tokens: 4, cache_write_input_tokens: 2, counter_source: "provider_counter" },
    });
  });

  it("extracts split text, session identity, and the final provider counters", () => {
    const parsed = parseOpenCodeJsonEvents([
      JSON.stringify({ type: "text", sessionID: "ses-1", part: { text: "{\"ok\":" } }),
      "not-json diagnostic",
      JSON.stringify({ type: "text", sessionID: "ses-1", part: { text: "true}" } }),
      JSON.stringify({ type: "step_finish", sessionID: "ses-1", part: { tokens: { input: 5, output: 2, cache: { read: 1, write: 0 } } } }),
    ].join("\n"));
    expect(parsed).toEqual({
      text: '{"ok":true}', session_id: "ses-1",
      usage: { input_tokens: 5, output_tokens: 2, cached_input_tokens: 1, cache_write_input_tokens: 0, counter_source: "provider_counter" },
    });
  });

  it("fails closed when the connector process fails", async () => {
    process.env.FAKE_OPENCODE_EXIT = "7";
    process.env.FAKE_OPENCODE_STDERR = "provider unavailable";
    const planner = createOpenCodeTaskPlanner({ cwd: process.cwd(), opencode_bin: fixture, model: "provider/model", planning_prompt: () => "plan" });
    await expect(planner.plan({ draft_id: "draft-2", task: "repair", answers: {}, parent_campaign_id: null, evidence_ids: [] }))
      .rejects.toThrow("opencode run exited 7: provider unavailable");
  });

  it("refuses an already-aborted planning request without dispatch", async () => {
    const controller = new AbortController();
    controller.abort();
    const planner = createOpenCodeTaskPlanner({ cwd: process.cwd(), opencode_bin: fixture, model: "provider/model", planning_prompt: () => "plan" });
    await expect(planner.plan({ draft_id: "draft-3", task: "repair", answers: {}, parent_campaign_id: null, evidence_ids: [], signal: controller.signal }))
      .rejects.toThrow("aborted before dispatch");
  });
});

describe("createOpenCodeCampaignIntegration verification", () => {
  it("upgrades provenance only from the injected machine verifier and carries its evidence into review", async () => {
    process.env.FAKE_OPENCODE_STDOUT = "specialist finished";
    const calls: unknown[] = [];
    const integration = createOpenCodeCampaignIntegration({
      executor_options: { opencodeBin: fixture, specialistModel: "provider/model", timeoutMs: 5_000 },
      specialist_verification: {
        verify: async (input) => {
          calls.push(input);
          return { message: "cargo test --quiet exited 0", provenance: { tag: "verified", cmd: "cargo test --quiet", exit: 0, stdout_hash: "sha256:fixture" }, command_argv: ["cargo", "test", "--quiet"] };
        },
      },
    });
    const executor = integration.createExecutor({
      runtime: { nativeSessionRegistry: null, harnessSessions: null, recordSessionCompletionUx() {} } as never,
      adapter: { pushDevtoolsLine() {} } as never,
      campaign_id: "campaign", cwd: process.cwd(), connector: {} as never,
    });
    const result = await executor.specialize({ campaign_id: "campaign", node_id: "node", action: { description: "change", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed" }, prompt: "change it", worktree_path: process.cwd(), specialist_agent: "seed" });
    expect(result).toMatchObject({ provenance: { tag: "verified", cmd: "cargo test --quiet" }, verification_evidence: "cargo test --quiet exited 0" });
    expect(calls).toEqual([expect.objectContaining({ campaign_id: "campaign", node_id: "node", session_id: expect.stringMatching(/^campaign:node:specialize:/), history: [] })]);
  });
});

describe("createOpenCodeCampaignIntegration native critic wiring", () => {
  it("threads observers.native_critic into the composed panel reviewer's fast path", async () => {
    const savedTransport = process.env[ARBOR_CRITIC_TRANSPORT_ENV];
    process.env[ARBOR_CRITIC_TRANSPORT_ENV] = "native";
    try {
      const native_critic: NativeCriticPort = {
        ready: true,
        model_id: "gpt-fixture",
        async call() {
          return {
            ok: true,
            text: JSON.stringify({
              approved: true, rationale: "native approved", measurement_validated: true, guardrails_enforced: true, introspection_passed: true, stability_ok: true,
              checks: [
                { name: "root_cause", passed: true, detail: "no blocker" },
                { name: "measurement_validation", passed: true, detail: "evidence present" },
                { name: "guardrail_enforcement", passed: true, detail: "guardrails held" },
                { name: "introspection", passed: true, detail: "state inspected" },
                { name: "stability_monitoring", passed: true, detail: "stable" },
              ],
            }),
            usage: { kind: "unavailable", reason: "fixture" },
          };
        },
      };
      const integration = createOpenCodeCampaignIntegration({ native_critic });
      const reviewer = integration.createReviewer({
        runtime: { nativeSessionRegistry: null, harnessSessions: null, recordSessionCompletionUx() {} } as never,
        adapter: { pushDevtoolsLine() {} } as never,
        campaign_id: "campaign", cwd: process.cwd(), connector: {} as never,
      });
      const verdict = await reviewer("lenticel", { action_category: "testing", high_stakes: false, description: "probe action" });
      expect(verdict).toMatchObject({ approved: true, rationale: "native approved" });
    } finally {
      if (savedTransport === undefined) delete process.env[ARBOR_CRITIC_TRANSPORT_ENV];
      else process.env[ARBOR_CRITIC_TRANSPORT_ENV] = savedTransport;
    }
  });
});
