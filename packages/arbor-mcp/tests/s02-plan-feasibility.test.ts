import { describe, expect, it } from "vitest";
import { NATIVE_TASK_PLAN_CONTRACT, assessPlanFeasibility, normalizeProviderPlan } from "../src/native-task-plan-contract.js";
import { validateTaskComposerProposal } from "../src/task-composer-contracts.js";

/**
 * S02 (audit/2026-09-06-remediation): pre-execution plan-feasibility
 * admission. Every rejection assertion here checks the SPECIFIC reason text
 * (via `kind` and a distinguishing substring), never a bare `valid === false`
 * — a naive `ok === false` check would also pass for an unrelated schema
 * failure and hide a dead feasibility guard (the exact failure mode flagged
 * in this remediation's brief).
 */

const rootCoordinator = {
  description: "Coordinate the single child action below.", estimated_gain: 1, estimated_cost: 1, category: "maintenance", delegate_to: "seed",
  constraints: [], execution_role: "architect", skill_id: null, skill_version: null, high_risk_tool_scope: null, decomposition_depth: null,
};

function planWith(action: Record<string, unknown>, opts?: { readonly criterion?: string }) {
  const criterion = opts?.criterion ?? "typo is corrected";
  return {
    summary: "s", assumptions: [], questions: [], root_action: rootCoordinator, actions: [action],
    acceptance_checks: [criterion], acceptance_mapping: [{ criterion, action_descriptions: [action.description] }],
    risk_notes: [],
  };
}

function action(overrides: Record<string, unknown>) {
  return {
    description: "do the thing", estimated_gain: 1, estimated_cost: 1, category: "maintenance", delegate_to: "seed",
    constraints: [], execution_role: null, skill_id: null, skill_version: null, decomposition_depth: null,
    ...overrides,
  };
}

describe("S02 plan feasibility: acceptance-authority mismatch", () => {
  it("rejects a criterion that demands verification when no mapped action declares any command authority", () => {
    const plan = planWith(action({ high_risk_tool_scope: { write_paths: ["src/models/reservation.ts"], command_argv: [] } }), { criterion: "verify the reservation model compiles" });
    const result = NATIVE_TASK_PLAN_CONTRACT.validate(plan);
    expect(result.valid).toBe(false);
    expect(result).not.toBe(undefined);
    if (!result.valid) {
      expect(result.reason).toContain("plan feasibility (acceptance_authority_missing)");
      expect(result.reason).toContain("verify the reservation model compiles");
      expect(result.reason).toContain("command_argv authority");
    }
    // Confirm this is really the feasibility gate firing, not schema failure:
    expect(validateTaskComposerProposal(normalizeProviderPlan(plan)).ok).toBe(true);
  });

  it("admits the same shape once the mapped action declares a real command", () => {
    const plan = planWith(action({ high_risk_tool_scope: { write_paths: ["src/models/reservation.ts"], command_argv: [["bun", "test", "tests/reservations.test.ts"]] } }), { criterion: "verify the reservation model compiles" });
    expect(NATIVE_TASK_PLAN_CONTRACT.validate(plan)).toEqual({ valid: true });
  });

  it("does not fire for a criterion with no verification verb", () => {
    const plan = planWith(action({ high_risk_tool_scope: { write_paths: ["README.md"], command_argv: [] } }), { criterion: "typo is corrected" });
    expect(NATIVE_TASK_PLAN_CONTRACT.validate(plan)).toEqual({ valid: true });
  });
});

describe("S02 plan feasibility: unsatisfiable command", () => {
  it("rejects bare `bun build` with no entrypoints", () => {
    const plan = planWith(action({ high_risk_tool_scope: { write_paths: [], command_argv: [["bun", "build"]] } }));
    const result = NATIVE_TASK_PLAN_CONTRACT.validate(plan);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("plan feasibility (unsatisfiable_command)");
      expect(result.reason).toContain("Missing entrypoints");
    }
  });

  it("admits `bun build` once an entrypoint is declared", () => {
    const plan = planWith(action({ high_risk_tool_scope: { write_paths: [], command_argv: [["bun", "build", "src/index.ts"]] } }));
    expect(NATIVE_TASK_PLAN_CONTRACT.validate(plan)).toEqual({ valid: true });
  });

  it("never flags an ADR-119 intent entry (final argv is genuinely unknowable at plan time)", () => {
    const plan = planWith(action({ high_risk_tool_scope: { write_paths: [], command_argv: [{ argv_prefix: ["bun", "build"], purpose: "produce a distributable bundle" }] } }));
    expect(NATIVE_TASK_PLAN_CONTRACT.validate(plan)).toEqual({ valid: true });
  });
});

describe("S02 plan feasibility: declared write scope incomplete", () => {
  it("rejects `bun install` when write_paths omits bun.lock", () => {
    const plan = planWith(action({ high_risk_tool_scope: { write_paths: ["package.json", "tsconfig.json"], command_argv: [["bun", "install"]] } }));
    const result = NATIVE_TASK_PLAN_CONTRACT.validate(plan);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("plan feasibility (declared_write_scope_incomplete)");
      expect(result.reason).toContain("bun.lock");
    }
  });

  it("admits `bun install` once bun.lock is declared", () => {
    const plan = planWith(action({ high_risk_tool_scope: { write_paths: ["package.json", "bun.lock"], command_argv: [["bun", "install"]] } }));
    expect(NATIVE_TASK_PLAN_CONTRACT.validate(plan)).toEqual({ valid: true });
  });

  it("does not require a lockfile when a frozen-lockfile install is declared", () => {
    const plan = planWith(action({ high_risk_tool_scope: { write_paths: ["package.json"], command_argv: [["bun", "install", "--frozen-lockfile"]] } }));
    expect(NATIVE_TASK_PLAN_CONTRACT.validate(plan)).toEqual({ valid: true });
  });

  it("rejects npm install without package-lock.json, and pnpm install without pnpm-lock.yaml", () => {
    const npmPlan = planWith(action({ high_risk_tool_scope: { write_paths: ["package.json"], command_argv: [["npm", "install"]] } }));
    const npmResult = NATIVE_TASK_PLAN_CONTRACT.validate(npmPlan);
    expect(npmResult.valid).toBe(false);
    if (!npmResult.valid) expect(npmResult.reason).toContain("package-lock.json");

    const pnpmPlan = planWith(action({ high_risk_tool_scope: { write_paths: ["package.json"], command_argv: [["pnpm", "install"]] } }));
    const pnpmResult = NATIVE_TASK_PLAN_CONTRACT.validate(pnpmPlan);
    expect(pnpmResult.valid).toBe(false);
    if (!pnpmResult.valid) expect(pnpmResult.reason).toContain("pnpm-lock.yaml");
  });

  it("never broadens authority: assessPlanFeasibility only reports, it never rewrites write_paths or command_argv", () => {
    const plan = planWith(action({ high_risk_tool_scope: { write_paths: ["package.json"], command_argv: [["bun", "install"]] } }));
    const before = JSON.stringify(plan);
    const validated = validateTaskComposerProposal(normalizeProviderPlan(plan));
    expect(validated.ok).toBe(true);
    if (validated.ok) assessPlanFeasibility(validated.value);
    expect(JSON.stringify(plan)).toBe(before);
  });
});

/**
 * `native-task-plan-contract.ts`'s `normalizeProviderPlan` copies the union
 * of every child action's `high_risk_tool_scope` onto `root_action` (root
 * recovery, pre-existing, unchanged by this fix). Before this fix,
 * `literalCommandsOf` walked `root_action` FIRST, so a rejection built from
 * the first matching command named the root coordinator instead of the
 * child action that actually declared it. Two actions are used deliberately
 * (per the remediation brief): a single-action plan's root ends up with an
 * IDENTICAL scope to its only child either way, which would not distinguish
 * "found the right action" from "found the only action that happens to be
 * both". A second, unrelated action proves the fix picks the correct one
 * out of more than one candidate.
 */
describe("S02 plan feasibility: hoisted root-recovery scope names the real declaring action", () => {
  it("blames the child action that declared bun install, not the root coordinator root recovery copied it onto", () => {
    const installAction = action({ description: "install deps", high_risk_tool_scope: { write_paths: ["package.json"], command_argv: [["bun", "install"]] } });
    const readmeAction = action({ description: "write the README", high_risk_tool_scope: { write_paths: ["README.md"], command_argv: [] } });
    const criterion = "dependencies are installed";
    const plan = {
      summary: "s", assumptions: [], questions: [],
      root_action: rootCoordinator, // high_risk_tool_scope: null — root recovery supplies it entirely from the children below.
      actions: [installAction, readmeAction],
      acceptance_checks: [criterion], acceptance_mapping: [{ criterion, action_descriptions: [installAction.description] }],
      risk_notes: [],
    };
    // Confirm this is really the feasibility gate firing on the hoisted
    // command, not a schema failure, and confirm root recovery really did
    // hoist the child's command onto root_action.
    const normalized = validateTaskComposerProposal(normalizeProviderPlan(plan));
    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.value.root_action.description).toBe(rootCoordinator.description);
      expect(normalized.value.root_action.high_risk_tool_scope?.command_argv).toContainEqual(["bun", "install"]);
    }

    const result = NATIVE_TASK_PLAN_CONTRACT.validate(plan);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("plan feasibility (declared_write_scope_incomplete)");
      expect(result.reason).toContain(`action "${installAction.description}" declares command [bun install]`);
      expect(result.reason).not.toContain(`action "${rootCoordinator.description}"`);
    }
  });
});
