import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeStage0, STAGE0_CRITERIA, stage0Verdict } from "../src/stage0/analysis.js";
import type { ArmSummary, Contrast } from "../src/stage0/analysis.js";
import { classifyAttempt, costOfSpans, findKey, usageSpansFromReport } from "../src/stage0/attempt.js";
import { appendLedger, groupUnits, parseLedger, readLedger } from "../src/stage0/ledger.js";
import { preregisteredUnitOrder, runUnits } from "../src/stage0/scheduler.js";
import type { Stage0Unit } from "../src/stage0/scheduler.js";
import { applyStub, insertBeforeClassEnd, jsMethodStubCandidate, pythonAllNames, pythonStubCandidates, rustStubCandidates } from "../src/stage0/stubs.js";
import type { Stage0AttemptRecord, Stage0Task } from "../src/stage0/types.js";
import { attempt } from "./stage0-fixtures.js";

const price = {
  input_minor_units_per_million_tokens: 21421,
  output_minor_units_per_million_tokens: 1320000,
  cache_read_minor_units_per_million_tokens: 16500,
  cache_write_minor_units_per_million_tokens: 21421,
  minor_unit_exponent: 6,
};

describe("Stage 0 ledger", () => {
  it("round-trips attempts and waves, filters by experiment and reports a torn last line", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage0-ledger-"));
    const path = join(dir, "ledger.jsonl");
    appendLedger(path, attempt({ task_id: "t", seed: 0, attempt_index: 0 }));
    appendLedger(path, { ...attempt({ task_id: "t", seed: 0, attempt_index: 0 }), experiment: "pilot" });
    appendLedger(path, { schema: "revoy2.stage0.wave.v1", experiment: "full", task_id: "t", seed: 0, wave: 0, attempt_indices: [0], started_at: "a", finished_at: "b", wall_ms: 5 });
    writeFileSync(path, `${readFileSync(path, "utf8")}{"schema":"revoy2.stage0.att`);
    const full = readLedger(path, "full");
    expect(full.attempts).toHaveLength(1);
    expect(full.waves).toHaveLength(1);
    expect(full.unparsed_lines).toEqual([4]);
    expect(readLedger(path).attempts).toHaveLength(2);
  });

  it("refuses a duplicate attempt instead of silently picking one", () => {
    const line = JSON.stringify(attempt({ task_id: "t", seed: 1, attempt_index: 2 }));
    expect(() => parseLedger(`${line}\n${line}\n`)).toThrow(/duplicate attempt/);
  });

  it("applies appended corrections to measurement fields only, never to the outcome", () => {
    const base = attempt({ task_id: "t", seed: 0, attempt_index: 0, cost_usd: 0 });
    const correction = {
      schema: "revoy2.stage0.correction.v1", experiment: "full", at: "x", task_id: "t", seed: 0, attempt_index: 0, reason: "r", evidence: ["e"],
      set: { cost_usd: 0.5, failure_class: "harness", verified_and_adopted: true },
    };
    const parsed = parseLedger(`${JSON.stringify(base)}\n${JSON.stringify(correction)}\n`);
    expect(parsed.attempts[0].cost_usd).toBe(0.5);
    expect(parsed.attempts[0].failure_class).toBe("harness");
    expect(parsed.attempts[0].verified_and_adopted).toBe(false);
    expect(parsed.corrections).toHaveLength(1);
  });

  it("groups units and orders their attempts", () => {
    const units = groupUnits([attempt({ task_id: "t", seed: 0, attempt_index: 1 }), attempt({ task_id: "t", seed: 0, attempt_index: 0 }), attempt({ task_id: "u", seed: 0, attempt_index: 0 })]);
    expect([...units.keys()]).toEqual(["t#0", "u#0"]);
    expect(units.get("t#0")?.map((a) => a.attempt_index)).toEqual([0, 1]);
  });
});

describe("Stage 0 scheduler", () => {
  it("orders units seed-major with members interleaved", () => {
    const order = preregisteredUnitOrder([["a1", "a2"], ["b1"]], [0, 1]);
    expect(order.map((u) => `${u.task_id}#${u.seed}`)).toEqual(["a1#0", "b1#0", "a2#0", "a1#1", "b1#1", "a2#1"]);
  });

  it("runs waves until each unit is derivable, resumes from the ledger, and records wave spans", async () => {
    const appended: unknown[] = [];
    const ran: string[] = [];
    let clock = 0;
    const result = await runUnits({
      experiment: "full",
      units: [{ task_id: "t", seed: 0 }, { task_id: "u", seed: 0 }],
      k: 4,
      max_budget: 8,
      usd_unit: 1,
      unit_concurrency: 1,
      deadline_ms: Number.POSITIVE_INFINITY,
      usd_ceiling: Number.POSITIVE_INFINITY,
      existing: [attempt({ task_id: "t", seed: 0, attempt_index: 0 })],
      runAttempt: async (unit: Stage0Unit, index: number, wave: number) => {
        ran.push(`${unit.task_id}/a${index}`);
        clock += 10;
        // "u" verifies on a5; "t" never verifies.
        return { ...attempt({ task_id: unit.task_id, seed: unit.seed, attempt_index: index, verified: unit.task_id === "u" && index === 5 }), wave };
      },
      append: (entry) => appended.push(entry),
      event: () => undefined,
      now: () => clock,
    });
    expect(ran.filter((r) => r.startsWith("t/"))).toEqual(["t/a1", "t/a2", "t/a3", "t/a4", "t/a5", "t/a6", "t/a7"]);
    expect(ran.filter((r) => r.startsWith("u/"))).toHaveLength(8);
    expect(result.completed_units).toBe(2);
    expect(result.stop_reason).toBe("all_units");
    expect(appended.filter((e) => (e as { schema: string }).schema === "revoy2.stage0.wave.v1")).toHaveLength(4);
  });

  it("starts no new unit after the deadline or the USD ceiling, but finishes a started one", async () => {
    let clock = 0;
    const result = await runUnits({
      experiment: "full",
      units: [{ task_id: "t", seed: 0 }, { task_id: "u", seed: 0 }],
      k: 4,
      max_budget: 4,
      usd_unit: 1,
      unit_concurrency: 1,
      deadline_ms: 5,
      usd_ceiling: Number.POSITIVE_INFINITY,
      existing: [],
      runAttempt: async (unit, index) => {
        clock = 10;
        return attempt({ task_id: unit.task_id, seed: unit.seed, attempt_index: index });
      },
      append: () => undefined,
      event: () => undefined,
      now: () => clock,
    });
    expect(result.completed_units).toBe(1);
    expect(result.skipped_units).toBe(1);
    expect(result.stop_reason).toBe("deadline");

    const capped = await runUnits({
      experiment: "full",
      units: [{ task_id: "t", seed: 0 }, { task_id: "u", seed: 0 }],
      k: 4,
      max_budget: 4,
      usd_unit: 1,
      unit_concurrency: 1,
      deadline_ms: Number.POSITIVE_INFINITY,
      usd_ceiling: 0.3,
      existing: [],
      runAttempt: async (unit, index) => attempt({ task_id: unit.task_id, seed: unit.seed, attempt_index: index }),
      append: () => undefined,
      event: () => undefined,
    });
    expect(capped.stop_reason).toBe("usd_ceiling");
    expect(capped.attempts_run).toBe(4);
  });
});

describe("Stage 0 attempt bookkeeping", () => {
  const report = {
    ledger: {
      records: [
        { observation: { type: "usage_cost", idempotency_key: "k1", agent_id: "seed", phase: "expand", input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost: { kind: "priced", minor_units: 21421, minor_unit_exponent: 6 } } },
        { observation: { type: "usage_cost", idempotency_key: "k1", agent_id: "seed", phase: "expand", input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost: { kind: "priced", minor_units: 21421, minor_unit_exponent: 6 } } },
        { observation: { type: "usage_cost", idempotency_key: "k2", agent_id: "critic", phase: "review", input_tokens: 0, output_tokens: 1_000_000, cache_read_tokens: 0, cache_write_tokens: 0, cost: { kind: "unpriced" } } },
        { observation: { type: "something_else" } },
      ],
    },
  };

  it("de-duplicates usage spans and re-prices unpriced spans separately", () => {
    const spans = usageSpansFromReport(report);
    expect(spans).toHaveLength(2);
    const cost = costOfSpans(spans, price);
    expect(cost.priced).toBeCloseTo(0.021421, 9);
    expect(cost.unpriced_estimate).toBeCloseTo(1.32, 9);
    expect(cost.unpriced_spans).toBe(1);
    expect(cost.tokens).toEqual({ input: 1_000_000, output: 1_000_000, cache_read: 0, cache_write: 0 });
  });

  it("findKey locates nested values", () => {
    expect(findKey({ ok: true, value: { a: [{ campaign_result: { campaign_id: "c" } }] } }, "campaign_result")).toEqual({ campaign_id: "c" });
    expect(findKey(null, "x")).toBeUndefined();
  });

  const base = { setup_failed: null, task_exit: 0, timed_out: false, campaign_id: "c", harness_verified: true, adopted: true, adopt_output: "", independent_exit: 0, protected_intact: true, stderr: "", refusals: {} };

  it("classifies the preregistered failure classes", () => {
    expect(classifyAttempt(base).failure_class).toBeNull();
    expect(classifyAttempt({ ...base, setup_failed: "clone failed" }).failure_class).toBe("capture");
    expect(classifyAttempt({ ...base, adopted: false, adopt_output: "halt scope_unadoptable" }).failure_class).toBe("capture");
    expect(classifyAttempt({ ...base, adopted: false }).failure_class).toBe("harness");
    expect(classifyAttempt({ ...base, independent_exit: 1 }).failure_class).toBe("harness");
    expect(classifyAttempt({ ...base, protected_intact: false }).failure_class).toBe("harness");
    const failed = { ...base, harness_verified: false, adopted: false, task_exit: 3 };
    expect(classifyAttempt(failed).failure_class).toBe("model");
    expect(classifyAttempt({ ...failed, timed_out: true }).failure_class).toBe("aborted");
    expect(classifyAttempt({ ...failed, campaign_id: null, task_exit: 1, stderr: "HTTP 429 rate limit" }).failure_class).toBe("provider");
    expect(classifyAttempt({ ...failed, campaign_id: null, task_exit: 1 }).failure_class).toBe("harness");
    expect(classifyAttempt({ ...failed, refusals: { "verification.run:command_not_allowlisted": 6 } }).failure_class).toBe("harness");
  });
});

describe("Stage 0 stub generators", () => {
  it("python: keeps the docstring and replaces the statements", () => {
    const source = 'def keep():\n    return 1\n\n\ndef target(x):\n    """Doc.\n\n    More.\n    """\n    y = x + 1\n    return y\n\n\n__all__ = ["target"]\n';
    const candidates = pythonStubCandidates(source);
    const target = candidates.find((c) => c.name === "target");
    expect(target?.body_lines).toBe(2);
    expect(applyStub(source, target!)).toContain('    """\n    raise NotImplementedError\n');
    expect(pythonAllNames(source)).toEqual(["target"]);
  });

  it("rust: replaces a method body and names its impl", () => {
    const source = "impl Display for Version {\n    fn fmt(&self, f: &mut Formatter) -> Result {\n        let a = 1;\n        write!(f, \"{}\", a)\n    }\n}\n";
    const [candidate] = rustStubCandidates(source);
    expect(candidate.symbol).toBe("Version::fmt");
    expect(candidate.context).toBe("impl Display for Version");
    expect(applyStub(source, candidate)).toBe("impl Display for Version {\n    fn fmt(&self, f: &mut Formatter) -> Result {\n        unimplemented!()\n    }\n}\n");
  });

  it("javascript: stubs a class method and inserts before the class end", () => {
    const source = "export default class Queue {\n\tpeek() {\n\t\treturn 1;\n\t}\n}\n";
    const candidate = jsMethodStubCandidate(source, "peek");
    expect(applyStub(source, candidate!)).toBe("export default class Queue {\n\tpeek() {\n\t\tthrow new Error('Not implemented');\n\t}\n}\n");
    expect(insertBeforeClassEnd(source, "\n\tx() {}\n")).toBe("export default class Queue {\n\tpeek() {\n\t\treturn 1;\n\t}\n\n\tx() {}\n}\n");
  });
});

describe("Stage 0 analysis and verdict", () => {
  const task = (id: string): Stage0Task => ({ id, member: "yocto-queue", language: "javascript", generator: "feature_injection", symbol: id, edit_paths: ["index.js"], task_text: "", acceptance: ["npm", "test"], protected_paths: [], split: "calibration" });

  it("derives every arm per unit and reports incomplete units separately", () => {
    const attempts: Stage0AttemptRecord[] = [];
    for (let t = 0; t < 6; t++) {
      for (let seed = 0; seed < 2; seed++) {
        // Even tasks verify on a1; odd tasks never verify.
        const n = t % 2 === 0 ? 4 : 8;
        for (let i = 0; i < n; i++) attempts.push(attempt({ task_id: `t${t}`, seed, attempt_index: i, verified: t % 2 === 0 && i === 1 }));
      }
    }
    attempts.push(attempt({ task_id: "t9", seed: 0, attempt_index: 0 }));
    const analysis = analyzeStage0([0, 1, 2, 3, 4, 5, 9].map((t) => task(`t${t}`)), attempts, [], {
      budget_levels: [1, 4, 8], k_wide: 4, usd_unit: 1, seeds: [0, 1], bootstrap_resamples: 300, bootstrap_seed: "t",
    });
    expect(analysis.units_complete).toBe(12);
    expect(analysis.units_incomplete).toEqual(["t9#0"]);
    const rate = (label: string) => analysis.arms.find((a) => a.arm === label)?.successes;
    expect(rate("current")).toBe(0);
    expect(rate("best_of_n@4")).toBe(6);
    expect(rate("kwide@8")).toBe(6);
    expect(analysis.hard_stratum.tasks).toHaveLength(6);
    expect(analysis.hard_stratum.bon8_unsolved_share).toBeCloseTo(0.5, 10);
  });

  const summary = (arm: string, cpv: number, fa: number, wall: number): ArmSummary => ({
    arm, units: 100, successes: 50,
    rate_wilson: { estimate: 0.5, lower: 0.4, upper: 0.6 },
    rate_task_bootstrap: { estimate: 0.5, lower: 0.4, upper: 0.6, resamples: 1, undefined_resamples: 0, seed: "s" },
    mean_cost_usd: 0.1,
    cost_per_verified: { estimate: cpv, lower: cpv, upper: cpv, resamples: 1, undefined_resamples: 0, seed: "s" },
    false_acceptance_rate: fa, mean_attempts: 1, median_wall_ms: wall, p90_wall_ms: wall,
  });
  const contrast = (a: string, b: string, lower: number): Contrast => ({ name: `${a} − ${b}`, a, b, difference: { estimate: lower + 0.1, lower, upper: lower + 0.2, resamples: 1, undefined_resamples: 0, seed: "s" } });

  it("passes best-of-N and K-wide only when every preregistered criterion holds", () => {
    const arms = [summary("current", 1, 0, 100), summary("best_of_n@4", 1.2, 0.01, 300), summary("kwide@4", 1.5, 0.01, 120)];
    const verdict = stage0Verdict(arms, [contrast("best_of_n@4", "current", 0.05)], { tasks: 10, unsolved_share: 0.2 }, [4, 8]);
    expect(verdict.bon_over_current).toBe("pass");
    expect(verdict.kwide_as_default).toBe("pass");
    expect(verdict.recommended_default).toBe("best_of_n+kwide");
    expect(verdict.abmcts_stage3_headroom).toBe("present");
  });

  it("fails on a CI touching zero, a cost blow-up, or a false-acceptance increase", () => {
    const arms = [summary("current", 1, 0, 100), summary("best_of_n@4", 1.2, 0.01, 300), summary("kwide@4", 1.5, 0.01, 120)];
    expect(stage0Verdict(arms, [contrast("best_of_n@4", "current", 0)], { tasks: 10, unsolved_share: 0.2 }, [4, 8]).bon_over_current).toBe("fail");
    const costly = [summary("current", 1, 0, 100), summary("best_of_n@4", STAGE0_CRITERIA.bon_cost_per_verified_max_ratio + 0.01, 0, 300)];
    expect(stage0Verdict(costly, [contrast("best_of_n@4", "current", 0.05)], { tasks: 10, unsolved_share: 0.2 }, [4, 8]).bon_over_current).toBe("fail");
    const unsafe = [summary("current", 1, 0, 100), summary("best_of_n@4", 1, 0.05, 300)];
    const verdict = stage0Verdict(unsafe, [contrast("best_of_n@4", "current", 0.05)], { tasks: 3, unsolved_share: 0.5 }, [4, 8]);
    expect(verdict.bon_over_current).toBe("fail");
    expect(verdict.recommended_default).toBe("current");
    expect(verdict.kwide_as_default).toBe("not_evaluated");
    expect(verdict.abmcts_stage3_headroom).toBe("absent");
  });

  it("keeps best-of-N sequential when K-wide does not cut wall time enough", () => {
    const arms = [summary("current", 1, 0, 100), summary("best_of_n@4", 1.2, 0, 300), summary("kwide@4", 1.3, 0, 290)];
    const verdict = stage0Verdict(arms, [contrast("best_of_n@4", "current", 0.05)], { tasks: 10, unsolved_share: 0.2 }, [4, 8]);
    expect(verdict.kwide_as_default).toBe("fail");
    expect(verdict.recommended_default).toBe("best_of_n");
  });
});
