import { describe, expect, it } from "vitest";
import { EvidenceLedger } from "@arbor/audit";
import { formatCostStatusLine, projectCostHud, renderCostStatusLine, ShellStatusLineRenderer } from "../src/cost/hud-projection.js";

function source(ledger: EvidenceLedger): string {
  return ledger.record({ campaign_id: "campaign", node_id: "node", timestamp: "2026-08-01T00:00:00.000Z",
    action_description: "source", action_category: "test", specialist_agent: "seed", critic_agent: null,
    node_state_before: "expanding", node_state_after: "verified", provenance: { tag: "verified", cmd: "test", exit: 0, stdout_hash: "sha256:test" },
    specialist_output: null, critic_verdict_approved: true, critic_root_cause: null, score_before: 0, score_after: 1,
    gates: [], kb_entries_written: [] });
}

describe("cost HUD projection", () => {
  it("re-derives list-rate estimate, context, and phase from ledger authority each render", async () => {
    const ledger = new EvidenceLedger(); const witness = source(ledger);
    ledger.recordTelemetryObservation({ campaign_id: "campaign", node_id: "node", operation_id: "assistant:1", epoch: 1,
      type: "usage_cost", phase: "critic", outcome: "success", source_evidence_id: witness, idempotency_key: "cost:1",
      provenance: { tag: "generated", generator: "test", input_hash: "one" }, provider: "openai", model_family: "gpt",
      input_tokens: 20, output_tokens: 5, cache_read_tokens: 60, cache_write_tokens: 15,
      cost: { kind: "priced", minor_units: 42, currency: "USD", minor_unit_exponent: 2, price_source_id: "fixture:v1" } });
    const projection = projectCostHud(ledger, "campaign", 200);
    expect(projection).toMatchObject({ estimate_label: "list-rate estimate", phase: "critic", context: { used_tokens: 100, total_tokens: 200, percent: 50 } });
    expect(formatCostStatusLine(projection)).toBe("USD 0.42 est. | context 100/200 (50.0%) | phase critic");
    expect(await renderCostStatusLine(projection, { render: (state) => JSON.stringify(state.context) })).toContain('"used_tokens":100');
    const shell = new ShellStatusLineRenderer(process.execPath, ["-e", "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(JSON.parse(s).phase))"]);
    expect(await renderCostStatusLine(projection, shell)).toBe("critic");
    expect(Object.keys(projection)).not.toContain("runningTotal");
  });
});
