import { describe, expect, it } from "vitest";
import { initialModel } from "../src/model.js";
import { update } from "../src/update.js";
import { treeScreen } from "../src/screens/tree.js";
import { outputScreen } from "../src/screens/output.js";

function seeded(screen: "operations" | "output" | "communications", value: unknown) {
  const focused = update(initialModel(), { type: "screen_changed", screen }).model;
  return update(focused, { type: "query_results", queryId: "list", screen, value }).model;
}

describe("selected information detail flows", () => {
  it("uses only a selected operation identity to request operation.get", () => {
    const result = update(seeded("operations", [{ operation_id: "op-1", state: "running", capability: "campaign.write" }]), {
      type: "ui_intent", intent: { type: "view_selected_row_detail" }, at: 1,
    });
    expect(result.effects).toEqual([{ type: "run_query", request: { kind: "operation.get", query_id: "tui:detail:operations:1", params: { operation_id: "op-1" } } }]);
  });

  it("uses only an output evidence identity to request its descriptor", () => {
    const result = update(seeded("output", [{ status: "ok", record: { id: "out_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } }]), {
      type: "ui_intent", intent: { type: "view_selected_row_detail" }, at: 2,
    });
    expect(result.effects).toEqual([{ type: "run_query", request: { kind: "output.descriptor", query_id: "tui:detail:output:2", params: { evidence_id: "out_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } } }]);
  });

  it("uses the selected communication's projection context to request node history", () => {
    const result = update(seeded("communications", { campaign_id: "c1", node_id: "n1", communications: [{ id: "message-1", kind: "report" }] }), {
      type: "ui_intent", intent: { type: "view_selected_row_detail" }, at: 3,
    });
    expect(result.effects).toEqual([{ type: "run_query", request: { kind: "communication.history", query_id: "tui:detail:communications:3", params: { campaign_id: "c1", node_id: "n1", limit: 100 } } }]);
  });

  it("renders the real descriptor envelope and preserves no-preview disclosure", () => {
    const projection = outputScreen.project({ descriptor: { id: "out_a", byte_count: 12 } }, { width: 80, height: 10 });
    expect(projection.rows).toMatchObject([{ evidence_id: "out_a", preview_chars: "0", truncated: "no" }]);
  });

  it("carries every persisted gate checkpoint and every critic check in tree detail", () => {
    const projection = treeScreen.project({ campaign_id: "c1", decomposed: 2, nodes: [{
      id: "n1", state: "failed", gate_records: [
        { gate: "isolation", result: "pass", checked_at: "2026-08-08T00:00:00.000Z", detail: "isolated" },
        { gate: "evidence", result: "bypass", checked_at: "2026-08-08T00:01:00.000Z", detail: "late", bypass_evidence_deficit: "trace missing" },
      ],
      critic_verdict: { approved: false, critic: "lenticel", rationale: "tests failed", measurement_validated: true, guardrails_enforced: true, introspection_passed: false, stability_ok: true,
        checks: [{ name: "root_cause", passed: true, detail: "identified" }, { name: "measurement_validation", passed: true, detail: "clean" }, { name: "guardrail_enforcement", passed: true, detail: "in scope" }, { name: "introspection", passed: false, detail: "contradiction" }, { name: "stability_monitoring", passed: true, detail: "stable" }],
      },
    }] }, { width: 200, height: 30 });
    expect(projection.caption).toContain("decomposed 2");
    const detail = projection.rows[0]._inspector as Record<string, string>;
    expect(detail.gate_history).toContain("#1 isolation=pass");
    expect(detail.gate_history).toContain("#2 evidence=bypass");
    expect(detail.critic).toContain("root_cause=true");
    expect(detail.critic).toContain("introspection=false");
  });
});
