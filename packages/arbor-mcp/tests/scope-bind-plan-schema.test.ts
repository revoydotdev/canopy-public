/**
 * ADR-119 Decision §1: `command_argv` gains a second, alternative shape --
 * a plan-time intent (`argv_prefix`/`purpose`) -- alongside the existing
 * literal argv array. Exercised at every plan-time validation layer a
 * provider-authored proposal actually passes through: the native
 * structured-output contract, `normalizeProviderPlan`, and
 * `validateTaskComposerProposal`/`task-composer-contracts.ts`'s
 * `validateAction`.
 */
import { describe, expect, it } from "vitest";
import { NATIVE_TASK_PLAN_CONTRACT, normalizeProviderPlan } from "../src/native-task-plan-contract.js";
import { validateTaskComposerProposal } from "../src/task-composer-contracts.js";

const intentEntry = { argv_prefix: ["npm", "create"], purpose: "scaffold a project whose exact name is only known at runtime" };

const action = {
  description: "Scaffold a new site", estimated_gain: 1, estimated_cost: 1, category: "scaffold", delegate_to: "seed",
  constraints: null, execution_role: null, skill_id: null, skill_version: null,
  high_risk_tool_scope: { write_paths: [], command_argv: [intentEntry] },
  decomposition_depth: null, depends_on: null,
};

function plan(rootAction: unknown = action, actions: unknown[] = [action]) {
  return { summary: "s", assumptions: [], questions: [], root_action: rootAction, actions, acceptance_checks: ["x"], acceptance_mapping: [{ criterion: "x", action_descriptions: [(actions[0] as { description: string }).description] }], risk_notes: [] };
}

describe("ADR-119: plan-time intent entries validate end to end through the structured-output contract", () => {
  it("a literal-full-argv declaration is unaffected: the ordinary case validates exactly as before", () => {
    const literalAction = { ...action, high_risk_tool_scope: { write_paths: [], command_argv: [["npm", "test"]] } };
    expect(NATIVE_TASK_PLAN_CONTRACT.validate(plan(literalAction, [literalAction]))).toEqual({ valid: true });
  });

  it("an intent entry validates through NATIVE_TASK_PLAN_CONTRACT and survives normalizeProviderPlan unchanged", () => {
    const value = plan();
    expect(NATIVE_TASK_PLAN_CONTRACT.validate(value)).toEqual({ valid: true });
    const normalized = normalizeProviderPlan(value) as { root_action: { high_risk_tool_scope: { command_argv: unknown[] } } };
    expect(normalized.root_action.high_risk_tool_scope.command_argv).toEqual([intentEntry]);
  });

  it("validateTaskComposerProposal admits an intent entry and round-trips it exactly through validateAction", () => {
    const result = validateTaskComposerProposal(normalizeProviderPlan(plan()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.root_action.high_risk_tool_scope).toEqual({ write_paths: [], command_argv: [intentEntry] });
  });

  it("a mixed literal + intent command_argv list validates and preserves both entries in order", () => {
    const mixed = { ...action, high_risk_tool_scope: { write_paths: [], command_argv: [["npm", "test"], intentEntry] } };
    const value = plan(mixed, [mixed]);
    expect(NATIVE_TASK_PLAN_CONTRACT.validate(value)).toEqual({ valid: true });
    const result = validateTaskComposerProposal(normalizeProviderPlan(value));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.root_action.high_risk_tool_scope).toEqual({ write_paths: [], command_argv: [["npm", "test"], intentEntry] });
  });

  it("rejects an intent entry missing purpose (structurally invalid, not silently dropped)", () => {
    const malformed = { ...action, high_risk_tool_scope: { write_paths: [], command_argv: [{ argv_prefix: ["npm", "create"] }] } };
    expect(NATIVE_TASK_PLAN_CONTRACT.validate(plan(malformed, [malformed]))).toMatchObject({ valid: false });
  });

  it("rejects an intent entry with an empty argv_prefix", () => {
    const malformed = { ...action, high_risk_tool_scope: { write_paths: [], command_argv: [{ argv_prefix: [], purpose: "x" }] } };
    expect(NATIVE_TASK_PLAN_CONTRACT.validate(plan(malformed, [malformed]))).toMatchObject({ valid: false });
  });
});
