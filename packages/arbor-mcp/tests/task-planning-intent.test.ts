import { describe, expect, it } from "vitest";
import { requestsDeliberatePlanning } from "../src/task-planning-intent.js";
import { TaskComposer } from "../src/task-composer.js";
import { CampaignManager } from "../src/manager.js";
import { createHeuristicArbiterIntakePort } from "../src/arbiter-intake.js";

describe("explicit planning before heuristic admission", () => {
  it.each([
    "Plan and implement a local API in src/api.ts",
    "Before execution, ask me which persistence mode to use",
    "Produce a concise plan with four dependent work units",
    "This is an unresolved requirement; do not choose it",
  ])("retains the planning requirement: %s", (task) => {
    expect(requestsDeliberatePlanning(task)).toBe(true);
  });
  it.each(["Fix a typo in README.md", "Add a test in src/api.test.ts", "Explain the API in src/api.ts"])("keeps the shortcut eligible: %s", (task) => {
    expect(requestsDeliberatePlanning(task)).toBe(false);
  });
  it("uses canonical clarification without changing a reviewed tier or admitting work", async () => {
    const action = { description: "Implement the API in src/api.ts", estimated_gain: 1, estimated_cost: 1, category: "implementation", delegate_to: "seed" };
    let plannerCalls = 0;
    let admissions = 0;
    const composer = new TaskComposer({
      manager: new CampaignManager(),
      arbiter: createHeuristicArbiterIntakePort(),
      planner: { plan: async () => {
        plannerCalls += 1;
        return { raw_proposal: JSON.stringify({ summary: "Plan local API", assumptions: [],
          questions: [{ id: "storage", question: "In-memory or SQLite?" }],
          root_action: action, actions: [action], acceptance_checks: ["Tests pass"], risk_notes: [] }),
          session_id: "planning-session", model_identity: "test-model",
          usage: { kind: "unavailable" as const, reason: "test fixture" } };
      } },
      admission: { admit: async ({ campaign_id }) => { admissions += 1; return { campaign_id, job_id: "job" }; } },
    });
    const draft = await composer.submit({ kind: "taskcomposer.submit", source: "tui", auto_confirm: true,
      idempotency_key: "planning-prerequisite", task: "Plan and implement a local API in src/api.ts. Before execution ask me which storage mode to use." });
    expect(plannerCalls).toBe(1);
    expect(admissions).toBe(0);
    expect(draft.status).toBe("awaiting_clarification");
    expect(draft.arbiter_decision?.tier).toBe("reviewed");
    expect(draft.proposal?.questions[0]?.id).toBe("storage");
  });
});
