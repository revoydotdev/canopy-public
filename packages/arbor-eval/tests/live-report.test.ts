/**
 * arbor-eval/tests/live-report — O4 roundtrip: the report includes both
 * arms' raw per-seed results, not only the aggregate verdict.
 */
import { describe, expect, it } from "vitest";
import { generateLiveAblationReport } from "../src/live-report.js";
import type { LiveAblationReport } from "../src/live-ablation.js";

function report(overrides: Partial<LiveAblationReport> = {}): LiveAblationReport {
  return {
    schema: "arbor.live-ablation/v2",
    generated_at: "2026-08-26T00:00:00.000Z",
    model: { provider_id: "fixture-provider", model_id: "fixture-model" },
    runs_per_arm_per_task: 2,
    max_calls_per_run: 3,
    task_results: [
      {
        task_id: "t1", held_out: false, arm: "governed_tree",
        runs: [
          { seed: 111, arm: "governed_tree", task_id: "t1", success: true, calls_used: 1, attempts: [{ attempt: 0, verification: { cmd_label: "node verify.mjs", ran: true, exit_code: 0, stdout: "1 test passed\n", stderr: "", stdout_hash: "sha256:aaa", spawn_error: null, duration_ms: 12 }, success: true, usage_and_cost: null }] },
          { seed: 222, arm: "governed_tree", task_id: "t1", success: false, calls_used: 3, attempts: [] },
        ],
        n: 2, successes: 1, success_rate: 0.5, confidence_interval_95: [0.1, 0.9], verdict_pass: false,
      },
      {
        task_id: "t1", held_out: false, arm: "ungoverned_linear",
        runs: [
          { seed: 333, arm: "ungoverned_linear", task_id: "t1", success: false, calls_used: 3, attempts: [] },
          { seed: 444, arm: "ungoverned_linear", task_id: "t1", success: false, calls_used: 3, attempts: [] },
        ],
        n: 2, successes: 0, success_rate: 0, confidence_interval_95: [0, 0.6], verdict_pass: false,
      },
    ],
    calibration: { governed_tree: 0.5, governed_linear: 0.25, ungoverned_linear: 0 },
    held_out: { governed_tree: 0, governed_linear: 0, ungoverned_linear: 0 },
    falsifiability: [
      {
        claim: "search", triggered: false, treatment_arm: "governed_tree", baseline_arm: "governed_linear",
        treatment_success_rate: 0, baseline_success_rate: 0, delta: 0,
        detail: "no held-out tasks in this synthetic fixture", recommended_obligation: null,
      },
      {
        claim: "governance", triggered: false, treatment_arm: "governed_linear", baseline_arm: "ungoverned_linear",
        treatment_success_rate: 0, baseline_success_rate: 0, delta: 0,
        detail: "no held-out tasks in this synthetic fixture", recommended_obligation: null,
      },
    ],
    ...overrides,
  };
}

describe("generateLiveAblationReport", () => {
  it("prints raw per-seed results for BOTH arms, not only the aggregate success rate", () => {
    const text = generateLiveAblationReport(report());
    // Aggregate is present...
    expect(text).toContain("| governed_tree | 0.5 |");
    expect(text).toContain("| ungoverned_linear | 0 |");
    // ...but so is every individual seed for both arms — a losing arm's raw
    // results are exactly as visible as a winning one.
    expect(text).toContain("111");
    expect(text).toContain("222");
    expect(text).toContain("333");
    expect(text).toContain("444");
    expect(text).toMatch(/#### t1 — governed_tree/);
    expect(text).toMatch(/#### t1 — ungoverned_linear/);
  });

  it("prints the governance and search effects, so neither claim can be read without the other", () => {
    const text = generateLiveAblationReport(report());
    expect(text).toContain("Governance effect");
    expect(text).toContain("Search effect");
    // governed_linear 0.25 - ungoverned_linear 0 = 0.25; governed_tree 0.5 - governed_linear 0.25 = 0.25
    expect(text).toContain("**0.25**");
  });

  it("surfaces EVERY triggered falsifiability finding with its recommended obligation prose", () => {
    const text = generateLiveAblationReport(report({
      falsifiability: [
        {
          claim: "search", triggered: true, treatment_arm: "governed_tree", baseline_arm: "governed_linear",
          treatment_success_rate: 0.3, baseline_success_rate: 0.3, delta: 0,
          detail: "held-out governed_linear matched governed_tree",
          recommended_obligation: "File against decisions/ADR-002-*.md: ...",
        },
        {
          claim: "governance", triggered: true, treatment_arm: "governed_linear", baseline_arm: "ungoverned_linear",
          treatment_success_rate: 0.2, baseline_success_rate: 0.5, delta: -0.3,
          detail: "held-out ungoverned_linear beat governed_linear",
          recommended_obligation: "File against decisions/ADR-006-*.md: ...",
        },
      ],
    }));
    expect(text).toContain("**TRIGGERED**");
    expect(text).toContain("ADR-002");
    // The governance finding must be exactly as visible as the search one.
    expect(text).toContain("ADR-006");
    expect(text).toContain("### governance: governed_linear vs ungoverned_linear");
  });
});
