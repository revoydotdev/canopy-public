/**
 * WA-32/J3-20 — `arbor command`'s structured `execution_role`/`allowed_tools`/
 * `skill_id` handoff on `taskcomposer.submit`.
 */
import { describe, expect, it } from "vitest";
import type { TokenUsageResult } from "@arbor/core";
import { CampaignManager } from "../src/manager.js";
import { TaskComposer } from "../src/task-composer.js";
import { validateTaskComposerCommand } from "../src/task-composer-contracts.js";

const governedProposal = JSON.stringify({
  summary: "implement the requested change", assumptions: [], questions: [],
  root_action: { description: "deliver the task", estimated_gain: 1, estimated_cost: 1, category: "delivery", delegate_to: "crown" },
  actions: [{ description: "implement and verify", estimated_gain: 1, estimated_cost: 1, category: "delivery", delegate_to: "seed" }],
  acceptance_checks: ["tests pass"], acceptance_mapping: [{ criterion: "tests pass", action_descriptions: ["implement and verify"] }], risk_notes: [],
});
function usage(inputTokens: number, outputTokens: number): TokenUsageResult {
  return { input_tokens: inputTokens, output_tokens: outputTokens, cached_input_tokens: 0, cache_write_input_tokens: 0, counter_source: "provider_counter" };
}
const planner = { plan: async () => ({ raw_proposal: governedProposal, session_id: "plan-session", model_identity: "native-test", usage: usage(10, 5) }) };

describe("validateTaskComposerCommand — submit command binding", () => {
  it("accepts a well-formed binding and rejects an unknown execution_role", () => {
    const ok = validateTaskComposerCommand({ kind: "taskcomposer.submit", task: "t", source: "cli", idempotency_key: "k", command: { name: "doc-fix", execution_role: "documentation-writer", allowed_tools: ["file.read"], skill_id: null } });
    expect(ok.ok).toBe(true);
    const bad = validateTaskComposerCommand({ kind: "taskcomposer.submit", task: "t", source: "cli", idempotency_key: "k", command: { name: "doc-fix", execution_role: "not-a-role", allowed_tools: [], skill_id: null } });
    expect(bad).toMatchObject({ ok: false });
  });
});

describe("TaskComposer — honoring a command's execution_role", () => {
  it("stamps a governed (planner-produced) proposal's root_action and actions with the command's Action-representable execution_role", async () => {
    const composer = new TaskComposer({ manager: new CampaignManager(), planner });
    const draft = await composer.submit({
      kind: "taskcomposer.submit", task: "Document the new endpoint", source: "cli", idempotency_key: "doc-cmd-1",
      command: { name: "doc-fix", execution_role: "documentation-writer", allowed_tools: ["file.read", "file.write"], skill_id: null },
    });
    expect(draft.status).toBe("proposed");
    expect(draft.proposal?.root_action.execution_role).toBe("documentation-writer");
    expect(draft.proposal?.actions.every((action) => action.execution_role === "documentation-writer")).toBe(true);
  });

  it("stamps a direct-tier synthetic proposal the same way", async () => {
    const composer = new TaskComposer({ manager: new CampaignManager() });
    const draft = await composer.submit({
      kind: "taskcomposer.submit", task: "Read the config and report", source: "cli", idempotency_key: "doc-cmd-2", tier_override: "direct",
      command: { name: "architect-review", execution_role: "architect", allowed_tools: ["file.read"], skill_id: null },
    });
    expect(draft.status).toBe("proposed");
    expect(draft.proposal?.root_action.execution_role).toBe("architect");
  });

  it("leaves the proposal's execution_role unset for a role Action cannot represent (specialist-executor/critic-reviewer)", async () => {
    const composer = new TaskComposer({ manager: new CampaignManager(), planner });
    const draft = await composer.submit({
      kind: "taskcomposer.submit", task: "Implement the change", source: "cli", idempotency_key: "spec-cmd-1",
      command: { name: "implement", execution_role: "specialist-executor", allowed_tools: ["shell.execute"], skill_id: null },
    });
    expect(draft.proposal?.root_action.execution_role).toBeUndefined();
  });
});
