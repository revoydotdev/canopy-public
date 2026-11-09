import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrefixReuseLedger, evaluateAnalytics, parseEvalAnalyticsFixture, recordPrefixReuseObservation, savePrefixReuseLedger } from "../src/index.js";
import { generateReport } from "../src/report.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() { return parseEvalAnalyticsFixture(JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/advanced-analytics.json", import.meta.url)), "utf8")) as unknown); }
function observation(operation_id: string) {
  return { operation_id, observed_at: "2026-08-10T00:00:00.000Z", observation_kind: "materialized" as const,
    prefix: { prefix_text: `prefix ${operation_id}`, prompt_template_id: "fixture", token_units: 3, byte_length: 10 },
    target: { cluster_id: "core", item_id: "q1", config_id: "alpha" }, marginal_cost_token_units: 3,
    marginal_cost: { kind: "unpriced" as const, reason: "fixture" }, provenance: { tag: "generated" as const, generator: "arbor-eval/test", input_hash: "sha256:fixture" } };
}

describe("advanced analytics production inputs", () => {
  it("binds generated provenance to loaded ledger content rather than its filesystem location", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-eval-analytics-")); dirs.push(dir);
    let ledger = createPrefixReuseLedger("state", { now: "2026-08-10T00:00:00.000Z" });
    ledger = recordPrefixReuseObservation(ledger, observation("one")); savePrefixReuseLedger(ledger, dir);
    const first = evaluateAnalytics(fixture(), { dir, id: "state" });
    ledger = recordPrefixReuseObservation(ledger, observation("two")); savePrefixReuseLedger(ledger, dir);
    const second = evaluateAnalytics(fixture(), { dir, id: "state" });
    expect(first.reuse_ledger?.totals.observation_count).toBe(1);
    expect(second.reuse_ledger?.totals.observation_count).toBe(2);
    expect(second.provenance.input_hash).not.toBe(first.provenance.input_hash);
    expect(generateReport({
      generatedAt: "2026-08-10T00:00:00.000Z",
      numTasks: 0,
      runsPerTask: 0,
      arborResults: [],
      baselineResults: [],
      comparisonSummary: "fixture comparison",
    }, second)).toContain("Persisted reuse ledger: state; diagnostics: 0.");
  });

  it("rejects non-ISO observed_at timestamps before evaluator execution", () => {
    const invalid = JSON.parse(JSON.stringify(fixture()));
    invalid.critic_reliability_samples[0].observed_at = "later";
    expect(() => parseEvalAnalyticsFixture(invalid)).toThrow("valid ISO observed_at timestamp");
  });

  it("replays explicitly supplied provenance-carrying observations only into the selected eval ledger", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-eval-analytics-")); dirs.push(dir);
    const input = JSON.parse(JSON.stringify(fixture()));
    input.reuse_ledger_observations = [observation("fixture-replay")];

    const first = evaluateAnalytics(parseEvalAnalyticsFixture(input), { dir, id: "fixture-replay" });
    const replay = evaluateAnalytics(parseEvalAnalyticsFixture(input), { dir, id: "fixture-replay" });

    expect(first.reuse_ledger?.totals.observation_count).toBe(1);
    expect(replay.reuse_ledger?.totals.observation_count).toBe(1);
    expect(replay.provenance.input_hash).toBe(first.provenance.input_hash);
  });

  it("rejects malformed replay observations before any ledger write", () => {
    const input = JSON.parse(JSON.stringify(fixture()));
    input.reuse_ledger_observations = [{ ...observation("malformed-replay"), provenance: { tag: "claimed", claimant: "" } }];
    expect(() => parseEvalAnalyticsFixture(input)).toThrow("reuse_ledger_observations");
  });

  it("accepts verified replay observations with optional checks and priced cost evidence", () => {
    const input = JSON.parse(JSON.stringify(fixture()));
    input.reuse_ledger_observations = [
      {
        ...observation("verified-without-check"),
        provenance: { tag: "verified", cmd: "bun test", exit: 0, stdout_hash: "sha256:verified-without-check" },
      },
      {
        ...observation("verified-priced-check"),
        marginal_cost: { kind: "priced", minor_units: 19, currency: "USD", minor_unit_exponent: 2, price_source_id: "fixture-price/v1" },
        provenance: {
          tag: "verified", cmd: "bun test", exit: 0, stdout_hash: "sha256:verified-priced-check",
          check: { kind: "shell_command", breadth: "suite" },
        },
      },
    ];

    expect(parseEvalAnalyticsFixture(input).reuse_ledger_observations).toHaveLength(2);
  });

  const invalidReplayObservations = [
    ["a blank operation id", { ...observation("valid"), operation_id: " " }],
    ["a non-ISO observation timestamp", { ...observation("valid"), observed_at: "2026-08-10" }],
    ["an unknown observation kind", { ...observation("valid"), observation_kind: "invented" }],
    ["a negative token cost", { ...observation("valid"), marginal_cost_token_units: -1 }],
    ["a missing prefix", { ...observation("valid"), prefix: null }],
    ["a blank prefix template id", { ...observation("valid"), prefix: { ...observation("valid").prefix, prompt_template_id: "" } }],
    ["a negative prefix byte length", { ...observation("valid"), prefix: { ...observation("valid").prefix, byte_length: -1 } }],
    ["a blank optional tool contract id", { ...observation("valid"), prefix: { ...observation("valid").prefix, tool_contract_id: " " } }],
    ["a blank optional model family", { ...observation("valid"), prefix: { ...observation("valid").prefix, model_family: " " } }],
    ["a blank optional context signature", { ...observation("valid"), prefix: { ...observation("valid").prefix, context_signature: " " } }],
    ["a missing target", { ...observation("valid"), target: null }],
    ["a blank target item id", { ...observation("valid"), target: { ...observation("valid").target, item_id: "" } }],
    ["a blank optional target variant id", { ...observation("valid"), target: { ...observation("valid").target, variant_id: " " } }],
    ["an unpriced cost without a reason", { ...observation("valid"), marginal_cost: { kind: "unpriced", reason: "" } }],
    ["a priced cost with a fractional minor-unit amount", { ...observation("valid"), marginal_cost: { kind: "priced", minor_units: 1.5, currency: "USD", minor_unit_exponent: 2, price_source_id: "fixture-price/v1" } }],
    ["a priced cost without a currency", { ...observation("valid"), marginal_cost: { kind: "priced", minor_units: 1, currency: "", minor_unit_exponent: 2, price_source_id: "fixture-price/v1" } }],
    ["a priced cost with a negative exponent", { ...observation("valid"), marginal_cost: { kind: "priced", minor_units: 1, currency: "USD", minor_unit_exponent: -1, price_source_id: "fixture-price/v1" } }],
    ["a priced cost without a source id", { ...observation("valid"), marginal_cost: { kind: "priced", minor_units: 1, currency: "USD", minor_unit_exponent: 2, price_source_id: "" } }],
    ["a verified provenance record with an invalid check", { ...observation("valid"), provenance: { tag: "verified", cmd: "bun test", exit: 0, stdout_hash: "sha256:fixture", check: { kind: "invalid" } } }],
    ["a critic-approved provenance record without a rationale", { ...observation("valid"), provenance: { tag: "critic_approved", critic: "reviewer", rationale: "" } }],
    ["a generated provenance record without an input hash", { ...observation("valid"), provenance: { tag: "generated", generator: "arbor-eval/test", input_hash: "" } }],
  ] as const;

  for (const [description, invalidObservation] of invalidReplayObservations) {
    it(`rejects replay observations with ${description}`, () => {
      const input = JSON.parse(JSON.stringify(fixture()));
      input.reuse_ledger_observations = [invalidObservation];
      expect(() => parseEvalAnalyticsFixture(input)).toThrow("reuse_ledger_observations");
    });
  }
});
