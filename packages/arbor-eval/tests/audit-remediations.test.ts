import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBenchmark, computeSeed } from "../src/benchmark.js";
import { runBaseline } from "../src/baseline.js";
import { validateRunManifest } from "../src/trajectory-metrics.js";
import { createPrefixReuseLedger, loadPrefixReuseLedgerResult, reconcileReuseLedgerTemporaryFiles } from "../src/reuse-ledger.js";
import type { EvalTask } from "../src/types.js";

function validManifest() {
  return {
    schema: "arbor.eval-run-manifest/v3",
    campaign_id: "eval",
    environment_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    run_date: "2026-08-20T00:00:00.000Z",
    models: [{ role: "specialist", model_id: "model" }],
    sampling_rule: "fixed",
    aggregation_rule: "mean",
    cost: {
      input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0,
      tool_calls: 0, wall_clock_ms: 1, priced: [], unpriced_calls: 0,
      by_phase: [], by_role: [], by_agent: [],
    },
    context_economy: {
      observations: 0, offered_tokens: 0, retained_tokens: 0, pruned_tokens: 0,
      indexed_reference_tokens: 0, stable_prefix_tokens: 0, dynamic_tokens: 0,
      retention_ratio: null, by_source: [],
    },
    tool_economy: { observations: 0, offered_calls: 0, host_executions: 0, reused_reads: 0, avoided_output_bytes: 0, reuse_ratio: null },
    cache_economy: { eligible_input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cache_read_ratio: null, cache_write_ratio: null },
    efficiency: {
      effective_token_policy: { input: 1, cache_read: 0.1, cache_write: 1.25, output: 4, unit: "weighted_token" },
      effective_tokens: 5, verified_progress_units: 0, verified_progress_per_effective_token: 0,
    },
    failures: [],
  };
}

describe("audit remediations", () => {
  it("uses deterministic but independent seed streams for Arbor and its baseline", () => {
    const observed: number[] = [];
    const task: EvalTask = {
      id: "paired", description: "paired seed fixture", branchCount: 1,
      rootAction: { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" },
      branchActionGenerator: () => ({ description: "branch", estimated_gain: 1, estimated_cost: 1, category: "refactor", delegate_to: "seed" }),
      outcomeGenerator: (_branch, seed) => { observed.push(seed); return { success: true, rationale: "ok" }; },
      expectedGoodOutcome: "ok",
    };

    runBaseline([task], 1);
    const baselineSeed = observed[0];
    expect(baselineSeed).toBe(computeSeed("paired:baseline", 0));
    observed.length = 0;
    runBenchmark([task], 1, 1);
    const arborSeed = observed[0];
    expect(arborSeed).toBe(computeSeed("paired", 0));
    expect(arborSeed).not.toBe(baselineSeed);
  });

  it("rejects malformed nested manifest fields instead of asserting a false type", () => {
    expect(validateRunManifest(validManifest())).toBe(true);
    expect(validateRunManifest({ ...validManifest(), models: [{ role: "operator", model_id: "model" }] })).toBe(false);
    expect(validateRunManifest({ ...validManifest(), failures: [{ category: "failure", count: 1, node_ids: [] }] })).toBe(false);
    expect(validateRunManifest({ ...validManifest(), cost: { ...validManifest().cost, priced: [{ currency: "USD" }] } })).toBe(false);
    expect(validateRunManifest({ ...validManifest(), context_economy: { ...validManifest().context_economy, by_source: [{ source: "kb", offered_tokens: 2, retained_tokens: 1, pruned_tokens: 0, retention_ratio: 0.5 }] } })).toBe(false);
  });

  it("rejects ledger IDs that could escape the persistence directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-eval-audit-"));
    try {
      expect(() => createPrefixReuseLedger("../escape", { now: "2026-08-20T00:00:00.000Z" })).toThrow(/ledger_id/);
      expect(() => loadPrefixReuseLedgerResult("../escape", dir)).toThrow(/ledger_id/);
      expect(() => reconcileReuseLedgerTemporaryFiles(dir, "../escape")).toThrow(/ledger_id/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
