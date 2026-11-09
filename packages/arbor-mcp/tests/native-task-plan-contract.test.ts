import { describe, expect, it } from "vitest";
import { NATIVE_TASK_PLAN_CONTRACT, NATIVE_TASK_PLAN_SCHEMA, normalizeProviderPlan } from "../src/native-task-plan-contract.js";
import { validateTaskComposerProposal } from "../src/task-composer-contracts.js";

const action = {
  description: "Write the operator guide", estimated_gain: 1, estimated_cost: 1, category: "documentation", delegate_to: "seed",
  constraints: ["documentation only"], execution_role: "documentation-writer", skill_id: "write-guide", skill_version: "1.0.0", high_risk_tool_scope: { write_paths: ["docs/guide.md"], command_argv: [] }, decomposition_depth: null,
};

describe("native task-plan structured contract", () => {
  it("normalizes provider null optionals before canonical proposal validation", () => {
    const value = { summary: "Write a guide", assumptions: [], questions: [], root_action: { ...action, execution_role: null, skill_id: null, skill_version: null, high_risk_tool_scope: null }, actions: [action], acceptance_checks: ["guide exists"], risk_notes: [] };
    expect(NATIVE_TASK_PLAN_CONTRACT.validate(value)).toEqual({ valid: true });
    expect(validateTaskComposerProposal(normalizeProviderPlan(value)).ok).toBe(true);
    expect(NATIVE_TASK_PLAN_SCHEMA.schema_id).toBe(NATIVE_TASK_PLAN_CONTRACT.schema_id);
    expect(NATIVE_TASK_PLAN_SCHEMA.schema.required).toContain("acceptance_mapping");
  });

  it("preserves an exact skill identity and rejects incomplete selection", () => {
    const value = { summary: "s", assumptions: [], questions: [], root_action: action, actions: [action], acceptance_checks: ["x"], risk_notes: [] };
    const normalized = normalizeProviderPlan(value) as { root_action: { skill_id: string; skill_version: string } };
    expect(normalized.root_action).toMatchObject({ skill_id: "write-guide", skill_version: "1.0.0" }); expect(NATIVE_TASK_PLAN_CONTRACT.validate(value)).toEqual({ valid: true });
    expect(NATIVE_TASK_PLAN_CONTRACT.validate({ ...value, root_action: { ...action, skill_version: null } })).toMatchObject({ valid: false });
  });

  it("normalizes equivalent or narrower high-risk scope shapes without manufacturing authority", () => {
    const equivalent = {
      ...action,
      high_risk_tool_scope: { write_paths: ["docs/guide.md"], command_argv: ["bun", "test"], read_paths: ["src"] },
    };
    const missingLists = { ...action, high_risk_tool_scope: {} };
    const malformed = { ...action, high_risk_tool_scope: { write_paths: ["docs/guide.md"], command_argv: [42] } };
    const normalized = normalizeProviderPlan({ summary: "s", assumptions: [], questions: [], root_action: equivalent, actions: [missingLists], acceptance_checks: ["x"], risk_notes: [] }) as { root_action: typeof action; actions: typeof action[] };
    expect(normalized.root_action.high_risk_tool_scope).toEqual({ write_paths: ["docs/guide.md"], command_argv: [["bun", "test"]] });
    expect(normalized.actions[0].high_risk_tool_scope).toEqual({ write_paths: [], command_argv: [] });
    expect(NATIVE_TASK_PLAN_CONTRACT.validate({ summary: "s", assumptions: [], questions: [], root_action: malformed, actions: [action], acceptance_checks: ["x"], risk_notes: [] })).toMatchObject({ valid: false });
  });

  it("gives root recovery exactly the union of already-admitted child scopes", () => {
    const inspect = { ...action, description: "inspect", execution_role: "architect", high_risk_tool_scope: null };
    const edit = { ...action, description: "edit", high_risk_tool_scope: { write_paths: ["src/a.ts"], command_argv: [] } };
    const validate = { ...action, description: "validate", high_risk_tool_scope: { write_paths: [], command_argv: [["bun", "test", "src/a.test.ts"]] } };
    const normalized = normalizeProviderPlan({ summary: "s", assumptions: [], questions: [], root_action: inspect, actions: [inspect, edit, validate], acceptance_checks: ["x"], acceptance_mapping: [{ criterion: "x", action_descriptions: ["validate"] }], risk_notes: [] }) as { root_action: typeof action };
    expect(normalized.root_action.high_risk_tool_scope).toEqual({ write_paths: ["src/a.ts"], command_argv: [["bun", "test", "src/a.test.ts"]] });
    expect(normalized.root_action.execution_role).toBeUndefined();
  });

  it("rejects a provider payload that cannot satisfy the durable action contract", () => {
    expect(NATIVE_TASK_PLAN_CONTRACT.validate({ summary: "not enough" })).toMatchObject({ valid: false });
  });

  it("coerces a non-role delegate_to to the loop's default agent so the run cannot crash on 'unknown foreground agent'", () => {
    // The campaign loop uses delegate_to verbatim as the botanical tree agent
    // and throws "unknown foreground agent <x>" for anything that is not a
    // real AgentRole. Providers plan in human vocabulary ("human"), so the
    // admission boundary must coerce it.
    const value = { summary: "s", assumptions: [], questions: [], root_action: { ...action, delegate_to: "human" }, actions: [{ ...action, delegate_to: "writer" }], acceptance_checks: ["x"], risk_notes: [] };
    const normalized = normalizeProviderPlan(value) as { root_action: { delegate_to: string }; actions: { delegate_to: string }[] };
    expect(normalized.root_action.delegate_to).toBe("seed");
    expect(normalized.actions[0].delegate_to).toBe("seed");
  });

  it("preserves a delegate_to that is already a valid botanical role", () => {
    const value = { summary: "s", assumptions: [], questions: [], root_action: { ...action, delegate_to: "taproot" }, actions: [{ ...action, delegate_to: "heartwood" }], acceptance_checks: ["x"], risk_notes: [] };
    const normalized = normalizeProviderPlan(value) as { root_action: { delegate_to: string }; actions: { delegate_to: string }[] };
    expect(normalized.root_action.delegate_to).toBe("taproot");
    expect(normalized.actions[0].delegate_to).toBe("heartwood");
  });

  it("neutralizes a model-supplied decomposition_depth on every initial-plan action, regardless of value", () => {
    // decompose-policy.ts documents itself as the SOLE setter of a positive
    // decomposition_depth, for FAULT_MATRIX's timeout -> "decompose" recovery
    // bookkeeping. A model that self-assigns a depth near the recovery
    // ceiling on a FRESH plan action pre-consumes the entire recovery budget
    // before any real decomposition happened.
    const selfAssignedDepth = { ...action, decomposition_depth: 2 };
    const value = {
      summary: "s", assumptions: [], questions: [],
      root_action: { ...selfAssignedDepth, decomposition_depth: 3 },
      actions: [selfAssignedDepth],
      acceptance_checks: ["x"], risk_notes: [],
    };
    const normalized = normalizeProviderPlan(value) as { root_action: { decomposition_depth?: number }; actions: { decomposition_depth?: number }[] };
    expect(normalized.root_action.decomposition_depth).toBeUndefined();
    expect(normalized.actions[0].decomposition_depth).toBeUndefined();
    expect(NATIVE_TASK_PLAN_CONTRACT.validate(value)).toEqual({ valid: true });
  });

  it("mechanically routes an effectful provider 'architect' action to the ordinary Specialist", () => {
    const effectfulArchitect = {
      ...action,
      category: "frontend implementation",
      execution_role: "architect",
      skill_id: null,
      skill_version: null,
      high_risk_tool_scope: { write_paths: ["index.html"], command_argv: [] },
    };
    const value = { summary: "s", assumptions: [], questions: [], root_action: effectfulArchitect, actions: [effectfulArchitect], acceptance_checks: ["x"], risk_notes: [] };
    const normalized = normalizeProviderPlan(value) as { root_action: { execution_role?: string; high_risk_tool_scope: unknown }; actions: { execution_role?: string; high_risk_tool_scope: unknown }[] };

    expect(normalized.root_action.execution_role).toBeUndefined();
    expect(normalized.actions[0].execution_role).toBeUndefined();
    expect(normalized.actions[0].high_risk_tool_scope).toEqual({ write_paths: ["index.html"], command_argv: [] });
    expect(NATIVE_TASK_PLAN_CONTRACT.validate(value)).toEqual({ valid: true });
  });

  it("treats provider job-title execution roles as ordinary Specialists without widening effect scope", () => {
    const implementationRole = {
      ...action,
      execution_role: "implementer",
      skill_id: null,
      skill_version: null,
      high_risk_tool_scope: { write_paths: ["src/workflow.rs"], command_argv: [["cargo", "test", "--quiet"]] },
    };
    const value = { summary: "s", assumptions: [], questions: [], root_action: implementationRole, actions: [implementationRole], acceptance_checks: ["x"], risk_notes: [] };
    const normalized = normalizeProviderPlan(value) as { actions: Array<{ execution_role?: string; high_risk_tool_scope: unknown }> };
    expect(normalized.actions[0].execution_role).toBeUndefined();
    expect(normalized.actions[0].high_risk_tool_scope).toEqual({ write_paths: ["src/workflow.rs"], command_argv: [["cargo", "test", "--quiet"]] });
    expect(NATIVE_TASK_PLAN_CONTRACT.validate(value)).toEqual({ valid: true });
  });

  it("admits a depends_on referencing a sibling action's description, and rejects nothing new for plans without it", () => {
    const investigate = { ...action, description: "investigate root cause", constraints: undefined, execution_role: null, skill_id: null, skill_version: null, high_risk_tool_scope: null, decomposition_depth: null };
    const synthesize = { ...investigate, description: "write the guide", depends_on: ["investigate root cause"] };
    const value = { summary: "s", assumptions: [], questions: [], root_action: investigate, actions: [investigate, synthesize], acceptance_checks: ["x"], risk_notes: [] };
    expect(NATIVE_TASK_PLAN_CONTRACT.validate(value)).toEqual({ valid: true });
  });
});
