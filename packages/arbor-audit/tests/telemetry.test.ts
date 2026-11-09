import { describe, expect, it } from "vitest";
import { EvidenceLedger, type TelemetryObservationInput } from "../src/index.js";

function source(ledger: EvidenceLedger, campaign = "campaign"): string {
  return ledger.record({ campaign_id: campaign, node_id: "node", timestamp: "2026-08-01T00:00:00.000Z",
    action_description: "source", action_category: "test", specialist_agent: "seed", critic_agent: null,
    node_state_before: "expanding", node_state_after: "verified", provenance: { tag: "verified", cmd: "test", exit: 0, stdout_hash: "sha256:test" },
    specialist_output: null, critic_verdict_approved: true, critic_root_cause: null, score_before: 0, score_after: 1,
    gates: [], kb_entries_written: [] });
}

function timing(witness: string, overrides: Partial<TelemetryObservationInput> = {}): TelemetryObservationInput {
  return { campaign_id: "campaign", node_id: "node", operation_id: "operation", epoch: 1, type: "phase_timing",
    phase: "expand", outcome: "success", duration_ms: 42, source_evidence_id: witness, idempotency_key: "timing-1",
    provenance: { tag: "verified", cmd: "clock", exit: 0, stdout_hash: "sha256:test" }, timestamp: "2026-08-01T00:00:01.000Z",
    ...overrides } as TelemetryObservationInput;
}

describe("telemetry audit observations", () => {
  it("is idempotent, conflict-aware, hash-chained, and replayable", () => {
    const ledger = new EvidenceLedger(); const witness = source(ledger);
    const id = ledger.recordTelemetryObservation(timing(witness));
    expect(ledger.recordTelemetryObservation(timing(witness, { timestamp: "2026-08-01T00:01:00.000Z" }))).toBe(id);
    expect(() => ledger.recordTelemetryObservation(timing(witness, { duration_ms: 43 }))).toThrow("conflicting telemetry");
    expect(ledger.verifyIntegrity()).toMatchObject({ valid: true, packet_count: 2 });
    const restored = new EvidenceLedger(); restored.fromJSONL(ledger.toJSONL());
    expect(restored.verifyIntegrity()).toEqual(ledger.verifyIntegrity());
    expect(restored.getTelemetryObservations("campaign")).toEqual(ledger.getTelemetryObservations("campaign"));
  });

  it("records exact token/cache/currency integers and rejects unknown catalogs", () => {
    const ledger = new EvidenceLedger(); const witness = source(ledger);
    ledger.recordTelemetryObservation({ ...timing(witness), type: "usage_cost", provider: "openai", model_family: "gpt",
      input_tokens: 100, output_tokens: 20, cache_read_tokens: 80, cache_write_tokens: 5,
      cost: { kind: "priced", minor_units: 123456, currency: "USD", minor_unit_exponent: 6, price_source_id: "price:v1" } });
    expect(ledger.getTelemetryObservations("campaign")[0].observation).toMatchObject({
      cost: { kind: "priced", minor_units: 123456, minor_unit_exponent: 6 }, cache_read_tokens: 80 });
    expect(() => ledger.recordTelemetryObservation({ ...timing(witness, { idempotency_key: "bad" }), phase: "prompt" as "expand" })).toThrow("invalid epoch, phase, or outcome");
    expect(() => ledger.recordTelemetryObservation({ ...timing(witness, { idempotency_key: "bad-cost" }), type: "usage_cost",
      provider: "vendor" as "openai", model_family: "gpt", input_tokens: 1, output_tokens: 1, cache_read_tokens: 0,
      cache_write_tokens: 0, cost: { kind: "priced", minor_units: 1, currency: "USD", minor_unit_exponent: 2, price_source_id: "v1" } })).toThrow("invalid catalog");
  });

  it("requires a non-empty reason on an unpriced usage_cost observation, never a fabricated zero", () => {
    const ledger = new EvidenceLedger(); const witness = source(ledger);
    ledger.recordTelemetryObservation({ ...timing(witness), type: "usage_cost", provider: "openai", model_family: "gpt",
      input_tokens: 10, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0,
      cost: { kind: "unpriced", reason: "no price schedule wired yet" } });
    expect(ledger.getTelemetryObservations("campaign")[0].observation).toMatchObject({
      cost: { kind: "unpriced", reason: "no price schedule wired yet" } });
    expect(() => ledger.recordTelemetryObservation({ ...timing(witness, { idempotency_key: "bad-unpriced" }), type: "usage_cost",
      provider: "openai", model_family: "gpt", input_tokens: 1, output_tokens: 1, cache_read_tokens: 0,
      cache_write_tokens: 0, cost: { kind: "unpriced", reason: "" } })).toThrow("requires a non-empty reason");
  });

  it("persists exact model identities separately for specialist and critic roles", () => {
    const ledger = new EvidenceLedger(); const witness = source(ledger);
    ledger.recordTelemetryObservation({ ...timing(witness), type: "role_model_identity", role: "specialist", model_id: "openai/gpt-5.6", idempotency_key: "model:1" });
    ledger.recordTelemetryObservation({ ...timing(witness), type: "role_model_identity", role: "critic", model_id: "anthropic/claude-opus-4.2", idempotency_key: "model:2" });
    expect(ledger.getTelemetryObservations("campaign").map((record) => record.observation)).toEqual([
      expect.objectContaining({ role: "specialist", model_id: "openai/gpt-5.6" }),
      expect.objectContaining({ role: "critic", model_id: "anthropic/claude-opus-4.2" }),
    ]);
  });

  it("persists first-class node cost attribution with an evidence-logged pruning signal", () => {
    const ledger = new EvidenceLedger(); const witness = source(ledger);
    ledger.recordTelemetryObservation({ campaign_id: "campaign", node_id: "node", operation_id: "node:cost", epoch: 1,
      type: "node_cost_attribution", phase: "backprop", outcome: "success", source_evidence_id: witness,
      idempotency_key: "node-cost:1", provenance: { tag: "generated", generator: "test", input_hash: "node" },
      total_cost: { kind: "priced", minor_units: 9, currency: "USD", minor_unit_exponent: 2, price_source_id: "fixture:v1" },
      total_tokens: { input: 1, output: 2, cache_read: 3, cache_write: 4 },
      top_cost_spans: [{ span_id: "specialist", kind: "specialist", input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4,
        cost: { kind: "priced", minor_units: 9, currency: "USD", minor_unit_exponent: 2, price_source_id: "fixture:v1" } }],
      redundant_tool_calls: [{ normalized_signature: "file.read:readme", count: 2 }], produced_verified_progress: false,
      pruning_signal: "expensive_unproductive" });
    expect(ledger.verifyIntegrity()).toMatchObject({ valid: true });
    expect(ledger.getTelemetryObservations("campaign")[0].observation).toMatchObject({ type: "node_cost_attribution", pruning_signal: "expensive_unproductive" });
  });

  it("persists context-economy token counts and rejects inconsistent totals", () => {
    const ledger = new EvidenceLedger(); const witness = source(ledger);
    const sources = ["system_instructions", "project_instructions", "task", "repository_graph", "code", "tool_output", "trajectory", "memory", "critic_feedback", "human_input"] as const;
    const per_source = sources.map((contextSource) => {
      const offered_tokens = contextSource === "task" ? 40 : contextSource === "memory" ? 20 : contextSource === "code" ? 40 : 0;
      const retained_tokens = contextSource === "memory" ? 20 : contextSource === "code" ? 40 : 0;
      const disposition = offered_tokens === 0 ? "absent" as const : retained_tokens === 0 ? "pruned" as const : contextSource === "code" ? "indexed" as const : "retained" as const;
      return { source: contextSource, offered_tokens, retained_tokens, cache_class: (["system_instructions", "project_instructions", "repository_graph", "memory"] as const).includes(contextSource as never) ? "stable" as const : "dynamic" as const,
        disposition, reason: `fixture ${disposition}`, provenance: { tag: "generated" as const, generator: "fixture", input_hash: contextSource }, evidence_pointer: `context-source:${contextSource}:fixture` };
    });
    ledger.recordTelemetryObservation({ campaign_id: "campaign", node_id: "node", operation_id: "node:context", epoch: 1,
      type: "context_economy", phase: "expand", outcome: "success", source_evidence_id: witness,
      idempotency_key: "context-economy:1", provenance: { tag: "generated", generator: "test", input_hash: "node" },
      offered_tokens: 100, retained_tokens: 60, pruned_tokens: 40,
      indexed_reference_tokens: 10, stable_prefix_tokens: 20, dynamic_tokens: 40, per_source });
    expect(ledger.verifyIntegrity()).toMatchObject({ valid: true });
    expect(ledger.getTelemetryObservations("campaign")[0].observation).toMatchObject({
      type: "context_economy", offered_tokens: 100, retained_tokens: 60, pruned_tokens: 40 });
    expect(() => ledger.recordTelemetryObservation({ campaign_id: "campaign", node_id: "node", operation_id: "node:context", epoch: 1,
      type: "context_economy", phase: "expand", outcome: "success", source_evidence_id: witness,
      idempotency_key: "context-economy:bad", provenance: { tag: "generated", generator: "test", input_hash: "node" },
      offered_tokens: 100, retained_tokens: 60, pruned_tokens: 999,
      indexed_reference_tokens: 10, stable_prefix_tokens: 20, dynamic_tokens: 40, per_source })).toThrow("invalid or inconsistent token counts");
    expect(() => ledger.recordTelemetryObservation({ campaign_id: "campaign", node_id: "node", operation_id: "node:context", epoch: 1,
      type: "context_economy", phase: "expand", outcome: "success", source_evidence_id: witness,
      idempotency_key: "context-economy:short-rows", provenance: { tag: "generated", generator: "test", input_hash: "node" },
      offered_tokens: 100, retained_tokens: 60, pruned_tokens: 40,
      indexed_reference_tokens: 10, stable_prefix_tokens: 20, dynamic_tokens: 40, per_source: per_source.slice(0, 4) }))
      .toThrow("exactly one row per context source");
    expect(() => ledger.recordTelemetryObservation({ campaign_id: "campaign", node_id: "node", operation_id: "node:context", epoch: 1,
      type: "context_economy", phase: "expand", outcome: "success", source_evidence_id: witness,
      idempotency_key: "context-economy:mismatched-sum", provenance: { tag: "generated", generator: "test", input_hash: "node" },
      offered_tokens: 100, retained_tokens: 60, pruned_tokens: 40,
      indexed_reference_tokens: 10, stable_prefix_tokens: 20, dynamic_tokens: 40,
      per_source: [...per_source.slice(0, 9), { ...per_source[9]!, offered_tokens: 5 }] }))
      .toThrow("does not sum to its aggregate totals");
  });

  it("persists tool reuse savings and rejects impossible accounting", () => {
    const ledger = new EvidenceLedger(); const witness = source(ledger);
    const base = { campaign_id: "campaign", node_id: "node", operation_id: "node:tools", epoch: 1,
      type: "tool_economy" as const, phase: "expand" as const, outcome: "success" as const, source_evidence_id: witness,
      provenance: { tag: "generated" as const, generator: "test", input_hash: "tools" },
      offered_calls: 4, host_executions: 2, reused_reads: 1, avoided_output_bytes: 4096 };
    ledger.recordTelemetryObservation({ ...base, idempotency_key: "tool-economy:1" });
    expect(ledger.getTelemetryObservations("campaign")[0]?.observation).toMatchObject({ type: "tool_economy", reused_reads: 1, avoided_output_bytes: 4096 });
    expect(() => ledger.recordTelemetryObservation({ ...base, idempotency_key: "tool-economy:bad", offered_calls: 1, host_executions: 1, reused_reads: 1 }))
      .toThrow("invalid or inconsistent counts");
  });

  it("requires prior same-campaign evidence and detects tampering", () => {
    const ledger = new EvidenceLedger(); const witness = source(ledger);
    expect(() => ledger.recordTelemetryObservation(timing("missing"))).toThrow("not prior evidence");
    const other = source(ledger, "other");
    expect(() => ledger.recordTelemetryObservation(timing(other))).toThrow("not prior evidence");
    ledger.recordTelemetryObservation(timing(witness));
    const rows = ledger.toJSONL().split("\n");
    const telemetryIndex = rows.findIndex((row) => row.includes('"kind":"telemetry_observation"'));
    const altered = JSON.parse(rows[telemetryIndex]) as { observation: { duration_ms: number } }; altered.observation.duration_ms = 99;
    rows[telemetryIndex] = JSON.stringify(altered);
    const tampered = new EvidenceLedger(); tampered.fromJSONL(rows.join("\n"));
    expect(tampered.verifyIntegrity()).toMatchObject({ valid: false, error: expect.stringContaining("content hash") });
  });
});
