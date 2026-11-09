import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { taskComposerPlanningPrompt } from "../src/cli.js";

describe("task-composer planner authority guidance", () => {
  it("keeps planner restrictions out of child scopes and preserves executable recovery", () => {
    const prompt = taskComposerPlanningPrompt({ task: "repair the CLI", answers: {}, parent_campaign_id: null, evidence_ids: [] });
    expect(prompt).toContain("These restrictions apply to the planner only");
    expect(prompt).toContain("non-mutating repository inspection commands/tools");
    expect(prompt).toContain("root_action must contain the union of child write_paths and command_argv");
    expect(prompt).toContain("never direct execution of the test source");
    expect(prompt).toContain("bounded repository-context capsule");
    expect(prompt).toContain("Do not return a discovery-only action");
  });

  it("tells the planner what was wrong when ADR-117 §3 retries a schema-invalid proposal", () => {
    const base = { task: "repair the CLI", answers: {}, parent_campaign_id: null, evidence_ids: [] };
    // Without this the retry re-sends a byte-identical prompt and re-rolls the
    // same deterministic parse failure at full planning cost.
    const retried = taskComposerPlanningPrompt({ ...base, retry_context: "actions[0].estimated_gain must be a number" });
    expect(retried).toContain("actions[0].estimated_gain must be a number");
    expect(retried).toContain("did not reach the operator");
    // The first attempt carries no rejection notice.
    expect(taskComposerPlanningPrompt(base)).not.toContain("did not reach the operator");
    expect(taskComposerPlanningPrompt({ ...base, retry_context: "   " })).not.toContain("did not reach the operator");
  });

  it("tells the planner that ADR-119 intent entries exist, so a scaffold step is expressible", () => {
    // ADR-119 widened command_argv to accept {argv_prefix, purpose}, but this
    // prompt still described the shape as "exactly" the old literal-only union,
    // so no planner could ever emit one -- the capability was reachable from
    // schema through bind to ledger, and unreachable from the one producer.
    const prompt = taskComposerPlanningPrompt({ task: "build an astro site", answers: {}, parent_campaign_id: null, evidence_ids: [] });
    expect(prompt).toContain("argv_prefix");
    expect(prompt).toContain("purpose");
    expect(prompt).not.toContain("command_argv:string[][]}.");
    // The literal form must stay the default; intents are the narrow exception.
    expect(prompt).toContain("normally an exact literal argv array");
  });

  it("grounds every connector planner with the shared production repository graph", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../src/cli.ts"), "utf8");
    expect(source.match(/repository_graph: repositoryGraphIndex/g)).toHaveLength(3);
    for (const constructor of ["createClaudeCodeTaskPlanner", "createCodexTaskPlanner", "createOpenCodeTaskPlanner"]) {
      const start = source.indexOf(`${constructor}({`);
      expect(start).toBeGreaterThan(-1);
      expect(source.slice(start, start + 320)).toContain("repository_graph: repositoryGraphIndex");
    }
  });
});
