/**
 * arbor-eval/tests/live-ablation — drives `runLiveAblation` end to end
 * through its real CampaignManager/linear-loop/live-verification wiring,
 * with only the model port faked at the injection boundary (ADR-095's
 * explicit constraint for an unattended/no-credential test run: the live
 * path is exercised through a deterministic fake port; real-provider
 * network I/O is never invoked here — see `live-model-port.test.ts` for
 * the adapter-level proof that the real transport wiring itself works).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeModelPort, NativeModelResponse } from "@arbor/harness";
import { computeLiveSeed, evaluateFalsifiability, runLiveAblation, wilsonInterval, LIVE_ARMS } from "../src/live-ablation.js";
import type { LiveEvalTask } from "../src/live-tasks.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const CORRECT = "export function value() { return 42; }\n";
const BROKEN = "export function value() { return 0; }\n";
const VERIFY = "import { value } from \"./broken.mjs\";\nif (value() !== 42) { console.log(`FAIL value() = ${value()}`); process.exit(1); }\nconsole.log(\"1 test passed\"); process.exit(0);\n";

function makeTask(id: string, heldOut: boolean): LiveEvalTask {
  return {
    id,
    description: `synthetic task ${id}`,
    held_out: heldOut,
    target_relative_path: "broken.mjs",
    setup_fixture: (dir) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "broken.mjs"), BROKEN, "utf8"); writeFileSync(join(dir, "verify.mjs"), VERIFY, "utf8"); },
    verification: (dir) => ({ cmd: process.execPath, args: ["verify.mjs"], cwd: dir, timeout_ms: 10_000 }),
    prompt: (attempt) => `fix broken.mjs, attempt ${attempt}`,
  };
}

/** Injected deterministic fake port: `succeedsAtTurn` decides which attempt (by request.turn) returns the real fix. */
function fakePort(succeedsAtTurn: number | null): NativeModelPort {
  return {
    async run(request): Promise<NativeModelResponse> {
      const text = succeedsAtTurn !== null && request.prompt.includes(`attempt ${succeedsAtTurn}`) ? CORRECT : BROKEN;
      return { text: [], tool_calls: [], final_message: text };
    },
  };
}

const baseRunInput = {
  credential: "test-secret",
  provider_id: "fixture-provider",
  model_id: "fixture-model",
  runs_per_arm_per_task: 2,
  max_calls_per_run: 3,
  cost_ceiling_usd: 5,
  estimated_prompt_tokens_per_call: 100,
  max_output_tokens_per_call: 100,
  price_per_input_token_usd: 0.000001,
  price_per_output_token_usd: 0.000002,
};

function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "arbor-live-ablation-"));
  dirs.push(dir);
  return dir;
}

describe("runLiveAblation", () => {
  it("runs an explicitly selected ungoverned-only control lane without dispatching a governed arm", async () => {
    const prompts: string[] = [];
    const port: NativeModelPort = { async run(request) { prompts.push(request.prompt); return { text: [], tool_calls: [], final_message: CORRECT }; } };
    const report = await runLiveAblation({
      ...baseRunInput,
      arms: ["ungoverned_linear"],
      runs_per_arm_per_task: 1,
      tasks: [makeTask("linear-control", true)],
      model_port: port,
      workdir_root: workdir(),
    });
    expect(report.task_results).toHaveLength(1);
    expect(report.task_results[0]).toMatchObject({ arm: "ungoverned_linear", successes: 1 });
    expect(prompts).toEqual(["fix broken.mjs, attempt 0"]);
  });

  it("succeeds both arms when the injected port always returns a correct, verifiable fix", async () => {
    const alwaysCorrectPort: NativeModelPort = { async run() { return { text: [], tool_calls: [], final_message: CORRECT }; } };
    const succeeding = await runLiveAblation({ ...baseRunInput, tasks: [makeTask("always-fix", false)], model_port: alwaysCorrectPort, workdir_root: workdir() });
    expect(succeeding.task_results.every((r) => r.success_rate === 1)).toBe(true);
  });

  it("fails both arms when the injected port never returns a correct fix — never fabricates a verified success", async () => {
    const alwaysBrokenPort: NativeModelPort = { async run() { return { text: [], tool_calls: [], final_message: BROKEN }; } };
    const report = await runLiveAblation({ ...baseRunInput, tasks: [makeTask("never-fix", false)], model_port: alwaysBrokenPort, workdir_root: workdir() });
    for (const result of report.task_results) {
      expect(result.success_rate).toBe(0);
      for (const run of result.runs) {
        expect(run.success).toBe(false);
        expect(run.calls_used).toBe(baseRunInput.max_calls_per_run);
      }
    }
  });

  it("records an empty provider completion as a failed attempt instead of aborting the A/B sample", async () => {
    const emptyPort: NativeModelPort = { async run() { return { text: [], tool_calls: [], final_message: "" }; } };
    const report = await runLiveAblation({
      ...baseRunInput,
      runs_per_arm_per_task: 1,
      max_calls_per_run: 1,
      tasks: [makeTask("empty-completion", false)],
      model_port: emptyPort,
      workdir_root: workdir(),
    });
    expect(report.task_results).toHaveLength(LIVE_ARMS.length);
    expect(report.task_results.every((result) => result.successes === 0 && result.runs[0]?.calls_used === 1)).toBe(true);
  });

  it("both arms share the same task/verification command and reach the fix within the fixed budget when it lands on the first attempt", async () => {
    const port = fakePort(0); // correct fix on the very first call (turn 0) for both arms
    const report = await runLiveAblation({ ...baseRunInput, tasks: [makeTask("first-attempt-fix", false)], model_port: port, workdir_root: workdir() });
    for (const result of report.task_results) {
      expect(result.success_rate).toBe(1);
      for (const run of result.runs) expect(run.calls_used).toBe(1);
    }
  });

  it("ADR-131 O3: governed_tree selects out of insertion order once a real attempt fails, and governed_linear never does", async () => {
    // turn 2's call is the only one that returns the real fix. Every arm
    // must actually run real verification to discover that — nothing here
    // hands either arm the answer up front.
    const port = fakePort(2);
    const report = await runLiveAblation({
      ...baseRunInput,
      runs_per_arm_per_task: 1,
      max_calls_per_run: 3,
      tasks: [makeTask("out-of-order-fix", false)],
      model_port: port,
      workdir_root: workdir(),
    });
    const treeRun = report.task_results.find((r) => r.arm === "governed_tree")!.runs[0]!;
    const linearRun = report.task_results.find((r) => r.arm === "governed_linear")!.runs[0]!;

    // linear always tries attempts in strict insertion order — that is its
    // whole definition (a plain `for` loop, no selection at all).
    expect(linearRun.attempts.map((a) => a.attempt)).toEqual([0, 1, 2]);
    expect(linearRun.success).toBe(true);
    expect(linearRun.calls_used).toBe(3);

    // governed_tree must NOT follow that same fixed sequence: after attempt 0
    // fails, real-outcome feedback (ADR-131 Decision §2) makes a freshly
    // added, undiminished-gain sibling outscore the still-untried,
    // identically-scored seed sibling, so selection skips straight to it
    // rather than trying attempt 1 next. This is the exact case that was
    // impossible before the fix: every sibling scored identically, so
    // `selectNode` always broke ties by insertion order and reproduced
    // `linear`'s sequence exactly.
    expect(treeRun.attempts.map((a) => a.attempt)).not.toEqual([0, 1, 2]);
    expect(treeRun.attempts.map((a) => a.attempt)).not.toContain(1);
    expect(treeRun.success).toBe(true);
    // Selection divergence let governed_tree reach the fix in fewer real
    // verification calls than linear's fixed sequence needed.
    expect(treeRun.calls_used).toBeLessThan(linearRun.calls_used);
  });

  it("reports raw per-seed results for BOTH arms, never only an aggregate (ADR-095 Decision 4)", async () => {
    const port = fakePort(1);
    const report = await runLiveAblation({ ...baseRunInput, tasks: [makeTask("mid-fix", false)], model_port: port, workdir_root: workdir() });
    const arms = new Set(report.task_results.map((r) => r.arm));
    expect(arms).toEqual(new Set(["governed_tree", "governed_linear", "ungoverned_linear"]));
    for (const result of report.task_results) {
      expect(result.runs).toHaveLength(baseRunInput.runs_per_arm_per_task);
      for (const run of result.runs) expect(run.attempts.length).toBeGreaterThan(0);
    }
  });

  it("segregates held-out results from calibration results and never mixes them into one rate", async () => {
    const calibrationPort: NativeModelPort = { async run() { return { text: [], tool_calls: [], final_message: CORRECT }; } };
    const report = await runLiveAblation({
      ...baseRunInput,
      tasks: [makeTask("calib", false), makeTask("held", true)],
      model_port: calibrationPort,
      workdir_root: workdir(),
    });
    expect(report.calibration.governed_tree).toBe(1);
    expect(report.held_out.governed_tree).toBe(1);
    // every arm of the one held-out task, and every arm of the one calibration task
    expect(report.task_results.filter((r) => r.held_out)).toHaveLength(LIVE_ARMS.length);
    expect(report.task_results.filter((r) => !r.held_out)).toHaveLength(LIVE_ARMS.length);
  });

  it("refuses to start when the estimated cost exceeds the ceiling — enforced before any dispatch", async () => {
    const port: NativeModelPort = { async run() { throw new Error("must not be called"); } };
    await expect(runLiveAblation({ ...baseRunInput, tasks: [makeTask("t", false)], model_port: port, cost_ceiling_usd: 0.000001, workdir_root: workdir() }))
      .rejects.toThrow(/cost/);
  });
});

describe("evaluateFalsifiability — ADR-095 Decision 4, both claims", () => {
  const rates = (governed_tree: number, governed_linear: number, ungoverned_linear: number) =>
    ({ governed_tree, governed_linear, ungoverned_linear });

  it("returns one finding per pre-registered claim, always, triggered or not", () => {
    const findings = evaluateFalsifiability(rates(0.9, 0.6, 0.3));
    expect(findings.map((f) => f.claim)).toEqual(["search", "governance"]);
    for (const f of findings) expect(f.triggered).toBe(false);
  });

  it("triggers the SEARCH claim with a recommended obligation when the tree arm fails to beat governed linear", () => {
    const [search] = evaluateFalsifiability(rates(0.5, 0.5, 0.2), "2026-09-02");
    expect(search.triggered).toBe(true);
    expect(search.treatment_arm).toBe("governed_tree");
    expect(search.baseline_arm).toBe("governed_linear");
    expect(search.recommended_obligation).toContain("ADR-002");
    expect(search.recommended_obligation).toContain("2026-09-02");
  });

  it("triggers the GOVERNANCE claim when the gates do not pay for themselves", () => {
    // The arm the old instrument could not express at all.
    const governance = evaluateFalsifiability(rates(0.9, 0.4, 0.7), "2026-09-02")[1];
    expect(governance.triggered).toBe(true);
    expect(governance.treatment_arm).toBe("governed_linear");
    expect(governance.baseline_arm).toBe("ungoverned_linear");
    expect(governance.delta).toBeCloseTo(-0.3, 6);
    expect(governance.recommended_obligation).toContain("ADR-006");
  });

  it("treats a tie as a trigger — the extra machinery must earn its place", () => {
    const findings = evaluateFalsifiability(rates(0.5, 0.5, 0.5));
    expect(findings.every((f) => f.triggered)).toBe(true);
  });

  it("recommends nothing when both claims are supported", () => {
    const findings = evaluateFalsifiability(rates(0.9, 0.7, 0.4));
    expect(findings.every((f) => f.recommended_obligation === null)).toBe(true);
  });
});

describe("wilsonInterval", () => {
  it("returns [0,0] for zero trials", () => { expect(wilsonInterval(0, 0)).toEqual([0, 0]); });
  it("is a proper subset of [0,1] and contains the point estimate for a mixed result", () => {
    const [lo, hi] = wilsonInterval(2, 3);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
    expect(lo).toBeLessThanOrEqual(2 / 3);
    expect(hi).toBeGreaterThanOrEqual(2 / 3);
  });
});

describe("computeLiveSeed", () => {
  it("is deterministic for the same (task, arm, run) and differs across arms", () => {
    expect(computeLiveSeed("t1", "governed_tree", 0)).toBe(computeLiveSeed("t1", "governed_tree", 0));
    expect(computeLiveSeed("t1", "governed_tree", 0)).not.toBe(computeLiveSeed("t1", "ungoverned_linear", 0));
  });
});
