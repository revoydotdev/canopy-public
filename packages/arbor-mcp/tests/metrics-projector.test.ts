import { describe, expect, it } from "vitest";
import { EvidenceLedger, type TelemetryObservationInput } from "@arbor/audit";
import { projectTelemetry } from "../src/metrics-projector.js";

function source(ledger: EvidenceLedger, campaignId = "campaign"): string {
  return ledger.record({ campaign_id: campaignId, node_id: "node", timestamp: "2026-08-01T00:00:00.000Z",
    action_description: "source", action_category: "test", specialist_agent: "seed", critic_agent: null,
    node_state_before: "expanding", node_state_after: "verified", provenance: { tag: "verified", cmd: "test", exit: 0, stdout_hash: "sha256:test" },
    specialist_output: null, critic_verdict_approved: true, critic_root_cause: null, score_before: 0, score_after: 1,
    gates: [], kb_entries_written: [] });
}

function base(witness: string, overrides: Partial<TelemetryObservationInput>): TelemetryObservationInput {
  return { campaign_id: "campaign", node_id: "node", operation_id: "op", epoch: 1, phase: "expand", outcome: "success",
    type: "phase_timing", duration_ms: 50, source_evidence_id: witness, idempotency_key: "one",
    provenance: { tag: "verified", cmd: "test", exit: 0, stdout_hash: "sha256:test" }, timestamp: "2026-08-01T00:00:01.000Z",
    ...overrides } as TelemetryObservationInput;
}

function contextSources() {
  const sources = ["system_instructions", "project_instructions", "task", "repository_graph", "code", "tool_output", "trajectory", "memory", "critic_feedback", "human_input"] as const;
  return sources.map((contextSource) => {
    const offered_tokens = contextSource === "task" ? 60 : contextSource === "repository_graph" ? 40 : 0;
    const retained_tokens = contextSource === "task" ? 30 : contextSource === "repository_graph" ? 30 : 0;
    return { source: contextSource, offered_tokens, retained_tokens,
      cache_class: (["system_instructions", "project_instructions", "repository_graph", "memory"] as const).includes(contextSource as never) ? "stable" as const : "dynamic" as const,
      disposition: offered_tokens === 0 ? "absent" as const : "mixed" as const,
      reason: "fixture", provenance: { tag: "generated" as const, generator: "fixture", input_hash: contextSource }, evidence_pointer: `fixture:${contextSource}` };
  });
}

describe("ledger-derived telemetry projection", () => {
  it("rebuilds byte-equivalent counters, histograms, costs, and evidence pointers", () => {
    const ledger = new EvidenceLedger(); const witness = source(ledger);
    ledger.recordTelemetryObservation(base(witness, {}));
    ledger.recordTelemetryObservation(base(witness, { idempotency_key: "two", duration_ms: 501 }));
    ledger.recordTelemetryObservation(base(witness, { idempotency_key: "usage", type: "usage_cost", provider: "openai", agent_id: "seed-1",
      model_family: "gpt", input_tokens: 100, output_tokens: 25, cache_read_tokens: 75, cache_write_tokens: 4,
      cost: { kind: "priced", minor_units: 31, currency: "USD", minor_unit_exponent: 6, price_source_id: "prices:2026-08" } }));
    const first = projectTelemetry(ledger, "campaign");
    expect(JSON.stringify(projectTelemetry(ledger, "campaign"))).toBe(JSON.stringify(first));
    expect(first).toMatchObject({ source_record_count: 3,
      phase_histograms: [{ count: 2, sum_ms: 551, max_ms: 501 }],
      usage_cost: [{ tags: { phase: "expand", agent: "seed-1" }, calls: 1, input_tokens: 100, cache_read_tokens: 75, cost_minor_units: 31,
        price_source_ids: ["prices:2026-08"] }] });
    expect(first.usage_cost[0].evidence[0]).toEqual({ record_id: expect.stringMatching(/^telemetry_/), content_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it("keeps unpriced usage-cost series separate from priced ones, never fabricating a zero amount", () => {
    const ledger = new EvidenceLedger(); const witness = source(ledger);
    ledger.recordTelemetryObservation(base(witness, { idempotency_key: "priced", type: "usage_cost", provider: "openai",
      model_family: "gpt", input_tokens: 10, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0,
      cost: { kind: "priced", minor_units: 5, currency: "USD", minor_unit_exponent: 2, price_source_id: "p:1" } }));
    ledger.recordTelemetryObservation(base(witness, { idempotency_key: "unpriced", type: "usage_cost", provider: "openai",
      model_family: "gpt", input_tokens: 8, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0,
      cost: { kind: "unpriced", reason: "no price schedule wired" } }));
    const projection = projectTelemetry(ledger, "campaign");
    expect(projection.usage_cost).toHaveLength(2);
    const priced = projection.usage_cost.find((row) => row.tags.pricing === "priced");
    const unpriced = projection.usage_cost.find((row) => row.tags.pricing === "unpriced");
    expect(priced).toMatchObject({ calls: 1, input_tokens: 10, cost_minor_units: 5 });
    expect(unpriced).toMatchObject({ calls: 1, input_tokens: 8 });
    expect(unpriced && "unpriced_reasons" in unpriced ? unpriced.unpriced_reasons : null).toEqual(["no price schedule wired"]);
    expect(unpriced && "cost_minor_units" in unpriced).toBe(false);
  });

  it("projects context and tool economization as evidence-linked bounded series", () => {
    const ledger = new EvidenceLedger(); const witness = source(ledger);
    ledger.recordTelemetryObservation(base(witness, { idempotency_key: "context:1", type: "context_economy",
      offered_tokens: 100, retained_tokens: 60, pruned_tokens: 40, indexed_reference_tokens: 30,
      stable_prefix_tokens: 30, dynamic_tokens: 30, per_source: contextSources() }));
    ledger.recordTelemetryObservation(base(witness, { idempotency_key: "context:2", type: "context_economy",
      offered_tokens: 100, retained_tokens: 60, pruned_tokens: 40, indexed_reference_tokens: 30,
      stable_prefix_tokens: 30, dynamic_tokens: 30, per_source: contextSources() }));
    ledger.recordTelemetryObservation(base(witness, { idempotency_key: "tools:1", type: "tool_economy",
      offered_calls: 5, host_executions: 3, reused_reads: 2, avoided_output_bytes: 8_192 }));
    const projection = projectTelemetry(ledger, "campaign");
    expect(projection.context_economy).toEqual([expect.objectContaining({ observations: 2, offered_tokens: 200,
      retained_tokens: 120, pruned_tokens: 80, indexed_reference_tokens: 60, stable_prefix_tokens: 60,
      dynamic_tokens: 60, evidence: [expect.any(Object), expect.any(Object)] })]);
    expect(projection.tool_economy).toEqual([expect.objectContaining({ observations: 1, offered_calls: 5,
      host_executions: 3, reused_reads: 2, avoided_output_bytes: 8_192, evidence: [expect.any(Object)] })]);
  });

  it("rejects record and series cardinality instead of silently truncating", () => {
    const ledger = new EvidenceLedger(); const witness = source(ledger);
    ledger.recordTelemetryObservation(base(witness, {}));
    ledger.recordTelemetryObservation(base(witness, { idempotency_key: "second", phase: "critic" }));
    expect(() => projectTelemetry(ledger, "campaign", { limit: 1 })).toThrow("limit is 1");
    expect(() => projectTelemetry(ledger, "campaign", { max_series: 1 })).toThrow("metric series");
    expect(() => projectTelemetry(ledger, "campaign", { max_series: 1_025 })).toThrow("max_series");
  });

  it("rejects a missing campaign and lower-bound option values before reading ledger state", () => {
    const ledger = new EvidenceLedger();
    expect(() => projectTelemetry(ledger, "   ")).toThrow("requires a campaign");
    expect(() => projectTelemetry(ledger, "campaign", { limit: 0 })).toThrow("limit must be from 1 to 10000");
    expect(() => projectTelemetry(ledger, "campaign", { max_series: 0 })).toThrow("max_series must be from 1 to 1024");
  });

  it("keeps a foreign campaign out and aggregates absent-agent usage under the honest unattributed series", () => {
    const ledger = new EvidenceLedger(); const witness = source(ledger);
    ledger.recordTelemetryObservation(base(source(ledger, "other"), { idempotency_key: "foreign", campaign_id: "other" }));
    ledger.recordTelemetryObservation(base(witness, { idempotency_key: "priced-a", type: "usage_cost", provider: "openai",
      model_family: "gpt", input_tokens: 2, output_tokens: 3, cache_read_tokens: 4, cache_write_tokens: 5,
      cost: { kind: "priced", minor_units: 7, currency: "USD", minor_unit_exponent: 2, price_source_id: "prices:b" } }));
    ledger.recordTelemetryObservation(base(witness, { idempotency_key: "priced-b", type: "usage_cost", provider: "openai",
      model_family: "gpt", input_tokens: 11, output_tokens: 13, cache_read_tokens: 17, cache_write_tokens: 19,
      cost: { kind: "priced", minor_units: 23, currency: "USD", minor_unit_exponent: 2, price_source_id: "prices:a" } }));

    const projection = projectTelemetry(ledger, "campaign");
    expect(projection.source_record_count).toBe(2);
    expect(projection.phase_histograms).toEqual([]);
    expect(projection.usage_cost).toEqual([expect.objectContaining({
      calls: 2, input_tokens: 13, output_tokens: 16, cache_read_tokens: 21, cache_write_tokens: 24,
      cost_minor_units: 30, price_source_ids: ["prices:a", "prices:b"],
      tags: expect.objectContaining({ agent: "unattributed", pricing: "priced" }),
    })]);
  });

});
