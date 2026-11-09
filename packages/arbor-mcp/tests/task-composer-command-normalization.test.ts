import { describe, expect, it } from "vitest";

import { normalizePlannerDeclaredCommandArgv } from "../src/task-composer.js";
import type { TaskComposerProposal } from "../src/task-composer-contracts.js";

function proposal(command: string[][], writePaths = ["src/workflow.rs"]): TaskComposerProposal {
  const action = {
    description: "Implement the bounded change",
    estimated_gain: 2,
    estimated_cost: 1,
    category: "general",
    delegate_to: "seed",
    constraints: [],
    high_risk_tool_scope: { write_paths: writePaths, command_argv: command },
    depends_on: [],
  };
  return { summary: "Bounded change", assumptions: [], questions: [], root_action: action, actions: [action], acceptance_checks: [], risk_notes: [] };
}

describe("planner command argv normalization", () => {
  it("restores an exact operator-declared command flattened into one token", () => {
    const normalized = normalizePlannerDeclaredCommandArgv(
      proposal([["cargo test --quiet"]]),
      "Repair src/workflow.rs. Verify by running: cargo test --quiet.",
    );
    expect(normalized.root_action.high_risk_tool_scope?.command_argv).toEqual([["cargo", "test", "--quiet"]]);
    expect(normalized.actions[0]?.high_risk_tool_scope?.command_argv).toEqual([["cargo", "test", "--quiet"]]);
  });

  it("does not split model-authored commands absent from the operator task", () => {
    const original = proposal([["cargo publish --allow-dirty"]]);
    const normalized = normalizePlannerDeclaredCommandArgv(original, "Repair src/workflow.rs. Verify by running: cargo test --quiet.");
    expect(normalized.root_action.high_risk_tool_scope?.command_argv).toEqual([
      ["cargo publish --allow-dirty"],
      ["cargo", "test", "--quiet"],
    ]);
  });

  it("restores literal operator scope omitted from an atomic plan", () => {
    const omitted = proposal([], []);
    const normalized = normalizePlannerDeclaredCommandArgv(omitted, "Repair src/workflow.rs. Verify by running: cargo test --quiet.");
    expect(normalized.root_action.high_risk_tool_scope).toEqual({ write_paths: ["src/workflow.rs"], command_argv: [["cargo", "test", "--quiet"]] });
    expect(normalized.actions[0]?.high_risk_tool_scope).toEqual({ write_paths: ["src/workflow.rs"], command_argv: [["cargo", "test", "--quiet"]] });
  });

  it("narrows planner scope to an operator-authored exact write allowlist", () => {
    const overbroad = proposal([], ["index.html", "styles.css", "app.js", "README.md", "tests/site.test.mjs", "package.json"]);
    const task = "Create exactly index.html, styles.css, app.js, and README.md; do not modify tests/site.test.mjs or package.json. Verify with: node --test tests/site.test.mjs.";
    const normalized = normalizePlannerDeclaredCommandArgv(overbroad, task);
    const expected = { write_paths: ["index.html", "styles.css", "app.js", "README.md"], command_argv: [["node", "--test", "tests/site.test.mjs"]] };
    expect(normalized.root_action.high_risk_tool_scope).toEqual(expected);
    expect(normalized.actions[0]?.high_risk_tool_scope).toEqual(expected);
  });

  it("binds a command-only validator to its immediate mutable prerequisite", () => {
    const implementation = proposal([], ["src/workflow.rs"]).actions[0]!;
    const validation = {
      ...implementation,
      description: "Validate the bounded change",
      high_risk_tool_scope: { write_paths: [], command_argv: [["cargo", "test"], ["cargo", "check", "--no-default-features"]] },
      depends_on: [implementation.description],
    };
    const multi = { ...proposal([], ["src/workflow.rs"]), actions: [implementation, validation] };
    const normalized = normalizePlannerDeclaredCommandArgv(multi, "Add the bounded workflow change.");
    expect(normalized.actions[0]?.high_risk_tool_scope?.command_argv).toEqual([
      ["cargo", "test"], ["cargo", "check", "--no-default-features"],
    ]);
    expect(normalized.actions[1]).toEqual(validation);
  });
});
