import { describe, expect, it, vi } from "vitest";
import {
  deriveEvaluationProof,
  formatCost,
  freezeTelemetrySnapshot,
  HeadlessHarness,
  initialModel,
  PHASE_DURATION_BUCKETS_MS,
  renderTelemetryCounters,
  renderContextEconomy,
  renderEvaluationProof,
  renderTelemetryEvidence,
  renderTelemetryPhaseHistogram,
  renderTelemetryUsageCost,
  renderToolEconomy,
  renderTelemetryView,
  update,
  type TelemetrySnapshot,
  type UsageCostRow,
  type PhaseHistogramRow,
  type MetricCounterRow,
  type ContextEconomyRow,
  type ToolEconomyRow,
} from "../src/index.js";
import { telemetryScreen } from "../src/screens/telemetry.js";
import type { RuntimePort } from "../src/runtime-port.js";

const inertRuntime: RuntimePort = {
  command: async () => ({ ok: false, error: { code: "unavailable", summary: "test runtime is inactive" }, capability: null }),
  query: async () => ({ ok: false, error: { code: "unavailable", summary: "test runtime is inactive" }, capability: null }),
  activeOperationCount: () => 0,
};

function makeSnapshot(overrides: Partial<TelemetrySnapshot> = {}): TelemetrySnapshot {
  return {
    campaign_id: "camp-1",
    source_record_count: 5,
    counters: [
      {
        name: "arbor.phase.observations",
        campaign_id: "camp-1",
        node_id: "node-1",
        tags: { phase: "plan", outcome: "OK" },
        value: 42,
        evidence: [{ record_id: "r1", content_hash: "abc" }],
      },
      {
        name: "arbor.provider.calls",
        campaign_id: "camp-1",
        node_id: "node-1",
        tags: { provider: "openai", phase: "expand", outcome: "OK" },
        value: 156,
        evidence: [{ record_id: "r2", content_hash: "def" }],
      },
    ],
    phase_histograms: [
      {
        name: "arbor.phase.duration_ms",
        campaign_id: "camp-1",
        node_id: "node-1",
        tags: { phase: "plan", outcome: "OK" },
        count: 10,
        sum_ms: 4500,
        max_ms: 1200,
        buckets: [0, 2, 3, 2, 1, 1, 0, 1, 10],
        evidence: [{ record_id: "r1", content_hash: "abc" }],
      },
    ],
    usage_cost: [
      {
        name: "arbor.provider.usage_cost",
        campaign_id: "camp-1",
        node_id: "node-1",
        tags: {
          provider: "openai",
          model_family: "gpt-4o",
          phase: "expand",
          agent: "seed",
          pricing: "priced",
          currency: "USD",
          minor_unit_exponent: "2",
        },
        calls: 156,
        input_tokens: 12_345_678,
        output_tokens: 9_876_543,
        cache_read_tokens: 234_567,
        cache_write_tokens: 89_012,
        cost_minor_units: 45_678,
        price_source_ids: ["openai-pricing:v1"],
        evidence: [{ record_id: "r3", content_hash: "ghi" }],
      },
    ],
    context_economy: [{
      name: "arbor.context.economy", campaign_id: "camp-1", node_id: "node-1",
      tags: { phase: "expand", outcome: "success" }, observations: 2,
      offered_tokens: 1_000, retained_tokens: 600, pruned_tokens: 400,
      indexed_reference_tokens: 200, stable_prefix_tokens: 300, dynamic_tokens: 300,
      evidence: [{ record_id: "r4", content_hash: "jkl" }],
    }],
    tool_economy: [{
      name: "arbor.tool.economy", campaign_id: "camp-1", node_id: "node-1",
      tags: { phase: "expand", outcome: "success" }, observations: 2,
      offered_calls: 8, host_executions: 5, reused_reads: 3, avoided_output_bytes: 12_288,
      evidence: [{ record_id: "r5", content_hash: "mno" }],
    }],
    ...overrides,
  };
}

describe("telemetry projection into model", () => {
  it("projects received snapshot into model immutably", () => {
    const snapshot = makeSnapshot();
    const event = { type: "telemetry_received" as const, snapshot };
    const result = update(initialModel(), event);
    expect(result.model.telemetrySnapshot).not.toBeNull();
    expect(result.model.telemetrySnapshot!.campaign_id).toBe("camp-1");
    expect(result.model.telemetrySnapshot!.source_record_count).toBe(5);
    expect(result.effects).toEqual([]);
    expect(initialModel().telemetrySnapshot).toBeNull();
  });

  it("emits a fetch_telemetry effect for telemetry_requested", () => {
    // "view_telemetry" (UiIntent) used to duplicate this exact effect but
    // had no production caller (DEF-02) -- deleted. telemetry_requested is
    // the real production trigger, dispatched by tui.ts on active-campaign
    // change.
    const result = update(initialModel(), {
      type: "telemetry_requested",
      campaignId: "camp-1",
      at: 100,
    });
    expect(result.effects).toEqual([{ type: "fetch_telemetry", campaignId: "camp-1" }]);
    expect(result.model.telemetryCampaignId).toBe("camp-1");
  });

  it("keeps one transient telemetry notice and removes it after every response", () => {
    const first = update(initialModel(), { type: "telemetry_requested", campaignId: "camp-1", at: 100 });
    const repeated = update(first.model, { type: "telemetry_requested", campaignId: "camp-1", at: 101 });
    expect(repeated.model.notifications.filter((item) => item.id === "telemetry:fetch")).toHaveLength(1);
    const received = update(repeated.model, { type: "telemetry_received", snapshot: makeSnapshot() });
    expect(received.model.notifications.some((item) => item.id === "telemetry:fetch")).toBe(false);
    const requestedAgain = update(received.model, { type: "telemetry_requested", campaignId: "camp-1", at: 102 });
    const identical = update(requestedAgain.model, { type: "telemetry_received", snapshot: makeSnapshot() });
    expect(identical.model.notifications.some((item) => item.id === "telemetry:fetch")).toBe(false);
  });

  it("is idempotent on repeated identical snapshots", () => {
    const snapshot = makeSnapshot();
    const first = update(initialModel(), { type: "telemetry_received", snapshot });
    const second = update(first.model, { type: "telemetry_received", snapshot });
    // Model doesn't change — reference equality on the snapshot fields
    expect(second.model.telemetrySnapshot).toBe(first.model.telemetrySnapshot);
    expect(second.effects).toEqual([]);
  });

  it("replaces snapshot on different campaign data", () => {
    const first = update(initialModel(), { type: "telemetry_received", snapshot: makeSnapshot() });
    const second = update(first.model, {
      type: "telemetry_received",
      snapshot: makeSnapshot({ source_record_count: 99 }),
    });
    expect(second.model.telemetrySnapshot).not.toBe(first.model.telemetrySnapshot);
    expect(second.model.telemetrySnapshot!.source_record_count).toBe(99);
  });

  it("is deterministic — same event yields identical result", () => {
    const model = initialModel();
    const event = { type: "telemetry_received" as const, snapshot: makeSnapshot() };
    const a = update(model, event);
    const b = update(model, event);
    expect(a).toEqual(b);
  });

  it("blocks telemetry requests while shutting down", () => {
    const shutting = update(initialModel(), {
      type: "ui_intent",
      intent: { type: "request_shutdown" },
      at: 1,
    });
    const result = update(shutting.model, {
      type: "telemetry_requested",
      campaignId: "camp-1",
      at: 2,
    });
    expect(result.effects).toEqual([]);
  });
});

describe("telemetry source port integration", () => {
  it("calls telemetrySource.fetch and dispatches telemetry_received", async () => {
    const snapshot = makeSnapshot();
    const telemetrySource = {
      fetch: vi.fn().mockResolvedValue(snapshot),
    };
    const client = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      requestSnapshot: vi.fn(),
      close: vi.fn(),
      interruptCampaign: vi.fn(),
    };
    const terminal = { restore: vi.fn() };
    const harness = new HeadlessHarness({ client, terminal, telemetrySource, clock: { now: () => 42 }, runtime: inertRuntime });

    await harness.dispatch({
      type: "telemetry_requested",
      campaignId: "camp-1",
      at: harness.now(),
    });

    expect(telemetrySource.fetch).toHaveBeenCalledWith("camp-1");
    expect(harness.model.telemetrySnapshot).not.toBeNull();
    expect(harness.model.telemetrySnapshot!.campaign_id).toBe("camp-1");
  });

  it("raises error on telemetry fetch failure", async () => {
    const telemetrySource = {
      fetch: vi.fn().mockRejectedValue(new Error("ledger inaccessible")),
    };
    const client = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      requestSnapshot: vi.fn(),
      close: vi.fn(),
      interruptCampaign: vi.fn(),
    };
    const terminal = { restore: vi.fn() };
    const harness = new HeadlessHarness({ client, terminal, telemetrySource, clock: { now: () => 1 }, runtime: inertRuntime });

    await harness.dispatch({
      type: "telemetry_requested",
      campaignId: "camp-1",
      at: 1,
    });

    expect(harness.model.diagnostics).toEqual([
      expect.objectContaining({
        fingerprint: "telemetry:fetch-failed",
        message: "ledger inaccessible",
        source: "telemetry",
      }),
    ]);
  });
});

describe("formatCost", () => {
  it("formats minor units with exponent 0", () => {
    expect(formatCost(1500, 0, "JPY")).toBe("1500 JPY");
  });

  it("formats minor units with exponent 2 (cents)", () => {
    expect(formatCost(45678, 2, "USD")).toBe("456.78 USD");
  });

  it("formats minor units with exponent 3", () => {
    expect(formatCost(1000, 3, "BTC")).toBe("1.000 BTC");
  });

  it("handles zero cost", () => {
    expect(formatCost(0, 2, "USD")).toBe("0.00 USD");
  });

  it("handles very small fractional cost (pads correctly)", () => {
    expect(formatCost(5, 2, "USD")).toBe("0.05 USD");
  });

  it("rejects non-safe integers and invalid exponents", () => {
    expect(() => formatCost(1.5, 2, "USD")).toThrow("safe integer");
    expect(() => formatCost(100, -1, "USD")).toThrow("safe integer");
    expect(() => formatCost(100, 2, "")).toThrow("non-empty");
  });
});

describe("bounded telemetry widgets", () => {
  it("renders phase histogram with bounded width and height", () => {
    const rows: readonly PhaseHistogramRow[] = [
      {
        name: "arbor.phase.duration_ms",
        campaign_id: "c",
        node_id: "n",
        tags: { phase: "plan", outcome: "OK" },
        count: 10,
        sum_ms: 4500,
        max_ms: 1200,
        buckets: Array<number>(PHASE_DURATION_BUCKETS_MS.length + 1).fill(0).map((_, i) => i),
        evidence: [],
      },
    ];
    const result = renderTelemetryPhaseHistogram(rows, { width: 50, height: 3 });
    expect(result).toHaveLength(2);
    expect(result.every((line) => displayWidth(line) <= 50)).toBe(true);
  });

  it("renders usage cost with exact integer cost formatting", () => {
    const rows: readonly UsageCostRow[] = [
      {
        name: "arbor.provider.usage_cost",
        campaign_id: "c",
        node_id: "n",
        tags: {
          provider: "openai",
          model_family: "gpt-4o",
          phase: "expand",
          agent: "seed",
          pricing: "priced",
          currency: "USD",
          minor_unit_exponent: "2",
        },
        calls: 156,
        input_tokens: 12_345_678,
        output_tokens: 9_876_543,
        cache_read_tokens: 234_567,
        cache_write_tokens: 89_012,
        cost_minor_units: 45_678,
        price_source_ids: ["p1"],
        evidence: [],
      },
    ];
    const result = renderTelemetryUsageCost(rows, { width: 132, height: 3 });
    expect(result).toHaveLength(2);
    expect(result[1]).toContain("456.78 USD");
    expect(result[1]).toContain("seed");
    expect(result[1]).toContain("expand");
  });

  it("renders counters as bounded list", () => {
    const rows: readonly MetricCounterRow[] = [
      {
        name: "arbor.phase.observations",
        campaign_id: "c",
        node_id: "n",
        tags: { phase: "plan" },
        value: 42,
        evidence: [],
      },
    ];
    const result = renderTelemetryCounters(rows, { width: 60, height: 3 });
    expect(result).toHaveLength(2);
    expect(result[1]).toContain("42");
  });

  it("renders evidence-backed context and tool economy rows", () => {
    const snapshot = makeSnapshot();
    const context = renderContextEconomy(snapshot.context_economy as readonly ContextEconomyRow[], { width: 100, height: 3 });
    expect(context.join("\n")).toContain("600/1000");
    expect(context.join("\n")).toContain("400");
    const tools = renderToolEconomy(snapshot.tool_economy as readonly ToolEconomyRow[], { width: 100, height: 3 });
    expect(tools.join("\n")).toContain("12288");
    expect(tools.join("\n")).toContain("3");
  });

  it("renders evidence pointers bounded", () => {
    const evidence = [
      { record_id: "rec-001", content_hash: "sha256:ab12" },
      { record_id: "rec-002", content_hash: "sha256:cd34" },
    ];
    const result = renderTelemetryEvidence(evidence, { width: 40, height: 4 });
    expect(result).toHaveLength(3);
    expect(result[1]).toContain("rec-001");
    expect(result[2]).toContain("rec-002");
  });

  it("renders composite telemetry view with all sections", () => {
    const snapshot = makeSnapshot();
    const result = renderTelemetryView(snapshot, { width: 120, height: 40 });
    expect(result[0]).toContain("Telemetry:");
    expect(result[0]).toContain("camp-1");
    expect(result.join("\n")).toContain("Evidence pointers");
    expect(result.join("\n")).toContain("Evaluation & proof");
    expect(result.join("\n")).toContain("Context economy");
    expect(result.join("\n")).toContain("Tool economy");
  });

  it("projects only telemetry-backed latency/cost and keeps other evaluation claims explicitly unavailable", () => {
    const proof = deriveEvaluationProof(makeSnapshot());
    expect(proof.latency).toMatchObject({ state: "observed", label: "Phase latency", evidence_records: 1 });
    expect(proof.cost).toMatchObject({ state: "observed", label: "Cost", detail: expect.stringContaining("456.78 USD") });
    for (const metric of [proof.completion, proof.recovery, proof.evidence_completeness, proof.interventions]) {
      expect(metric.state).toBe("unavailable");
    }
    expect(renderEvaluationProof(proof, { width: 200, height: 8 }).join("\n")).toContain("no terminal campaign-outcome series");
  });

  it("does not fabricate price, latency, or evidence completeness when their series are absent", () => {
    const proof = deriveEvaluationProof(makeSnapshot({ counters: [], phase_histograms: [], usage_cost: [], context_economy: [], tool_economy: [] }));
    expect(proof.latency).toMatchObject({ state: "unavailable", reason: "no phase-timing series is projected" });
    expect(proof.cost).toMatchObject({ state: "unavailable", reason: "no provider usage-cost series is projected" });
    expect(proof.evidence_completeness).toMatchObject({ state: "unavailable", reason: expect.stringContaining("no expected evidence set") });
  });

  it("projects the frozen ledger snapshot through the installed telemetry screen", () => {
    const projection = telemetryScreen.project(makeSnapshot(), { width: 100, height: 20 });
    expect(telemetryScreen.render({ projection, width: 100, height: 20 }).join("\n")).toContain("Telemetry: campaign=camp-1");
  });

  it("clips Unicode characters in metric rows", () => {
    const rows: readonly UsageCostRow[] = [
      {
        name: "arbor.provider.usage_cost",
        campaign_id: "c",
        node_id: "n",
        tags: {
          provider: "microsoft",
          model_family: "gpt-4o",
          phase: "critic",
          agent: "lenticel",
          pricing: "priced",
          currency: "JPY",
          minor_unit_exponent: "0",
        },
        calls: 1,
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_minor_units: 999_999_999,
        price_source_ids: [],
        evidence: [],
      },
    ];
    const result = renderTelemetryUsageCost(rows, { width: 60, height: 3 });
    expect(result.every((line) => displayWidth(line) <= 60)).toBe(true);
  });

  it("handles empty datasets gracefully", () => {
    const empty = makeSnapshot({ counters: [], phase_histograms: [], usage_cost: [], context_economy: [], tool_economy: [] });
    const result = renderTelemetryView(empty, { width: 80, height: 10 });
    expect(result.join("\n")).toContain("Evaluation & proof");
    expect(result.join("\n")).toContain("unavailable");
  });
});

describe("freeze telemetry snapshot", () => {
  it("freezes nested objects and arrays", () => {
    const snapshot = makeSnapshot();
    const frozen = freezeTelemetrySnapshot(snapshot);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.counters)).toBe(true);
    expect(Object.isFrozen(frozen.counters[0].tags)).toBe(true);
    expect(Object.isFrozen(frozen.counters[0].evidence)).toBe(true);
    expect(Object.isFrozen(frozen.context_economy[0].tags)).toBe(true);
    expect(Object.isFrozen(frozen.tool_economy[0].evidence)).toBe(true);
  });

  it("prevents mutation of the frozen snapshot", () => {
    const snapshot = makeSnapshot();
    const frozen = freezeTelemetrySnapshot(snapshot);
    expect(() => {
      (frozen as any).source_record_count = 999;
    }).toThrow();
  });
});

describe("consumer cannot mutate shared projection", () => {
  it("update returns a structurally independent snapshot", () => {
    const snapshot = makeSnapshot();
    const result = update(initialModel(), { type: "telemetry_received", snapshot });
    const stored = result.model.telemetrySnapshot!;
    expect(Object.isFrozen(stored)).toBe(true);
    // Original snapshot is not mutated
    expect(snapshot.source_record_count).toBe(5);
  });
});

function displayWidth(value: string): number {
  let width = 0;
  for (const c of [...value]) {
    width += c.charCodeAt(0) > 127 ? 2 : 1;
  }
  return width;
}
