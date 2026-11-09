import { describe, expect, it } from "vitest";
import { harnessConnectorsScreen } from "../src/screens/harness-connectors.js";
import { harnessEvaluationsScreen } from "../src/screens/harness-evaluations.js";
import { harnessSessionsScreen } from "../src/screens/harness-sessions.js";
import { harnessReadinessScreen } from "../src/screens/harness-readiness.js";
import { nativeBudgetScreen } from "../src/screens/native-budget.js";
import { capabilitiesScreen } from "../src/screens/capabilities.js";

const context = { width: 120, height: 12, scroll_offset: 0 };

describe("harness operator screens", () => {
  it("projects and renders connector inventory with bounded capability evidence", () => {
    const projection = harnessConnectorsScreen.project({
      connectors: [{ connector_id: "native", health: "ready", implementation_version: "1", supported_upstream_range: "1.x", capabilities: [{ capability: "tools", grade: "application_validated" }], diagnostic: "ok" }],
      selected_execution: { kind: "direct_native", connector_id: "native", readiness: "ready", reason: null },
      requirements: [{ capability: "tools", minimum_grade: "application_validated" }],
    }, context);
    expect(projection.rows[0]).toMatchObject({ connector: "native", health: "ready" });
    expect(projection.caption).toContain("direct dispatch admitted");
    expect(harnessConnectorsScreen.render({ projection, ...context }).join("\n")).toContain("native");

    const degraded = harnessConnectorsScreen.project({ connectors: [{ capabilities: null }], selected_execution: { reason: 3 }, requirements: [] }, context);
    expect(degraded.caption).toContain("unreported");
    expect(degraded.row_ids).toEqual([null]);
    const empty = harnessConnectorsScreen.project(null, context);
    expect(harnessConnectorsScreen.render({ projection: empty, ...context })[0]).toContain("Awaiting");
  });

  it("projects evaluation lists and bounded run detail", () => {
    expect(harnessEvaluationsScreen.surface.queries).not.toContain("harness.evaluation.candidates");
    expect(harnessEvaluationsScreen.surface.commands).not.toContain("harness.evaluation.start");
    const runs = harnessEvaluationsScreen.project([{
      id: "run-1", revision_id: "rev-1", state: "completed", evaluator_id: "eval-1", requested_at: "now",
      evidence_ids: ["e1"], evaluation: { outcome: "passed", regression_detected: false },
    }, { id: 2, revision_id: null, evaluation: null }], context);
    expect(runs.variant).toBe("runs");
    expect(runs.rows[0]).toMatchObject({ outcome: "passed", regression: "no", evidence: "1" });
    expect(runs.row_ids?.[1]).toBeNull();
    expect(harnessEvaluationsScreen.render({ projection: runs, ...context }).join("\n")).toContain("rev-1");

    const detail = harnessEvaluationsScreen.project({
      id: "run-1", revision_id: "rev-1", campaign_id: "campaign-1", state: "completed", evaluator_id: "eval-1",
      completed_at: "later", reason: "stable", evidence_ids: ["e1"], evaluation: { outcome: "passed", regression_detected: false, latency_ms: 4 },
    }, context);
    expect(detail.variant).toBe("detail");
    expect(detail.rows.some((row) => row.field === "Latency ms" && row.value === "4")).toBe(true);
    expect(harnessEvaluationsScreen.render({ projection: detail, ...context }).join("\n")).toContain("Latency ms");
    expect(harnessEvaluationsScreen.project({ id: "incomplete" }, context).variant).toBe("empty");
  });

  it("projects session list, inspection, events, and typed unavailability", () => {
    expect(harnessSessionsScreen.surface.queries).not.toContain("harness.session.availability");
    const sessions = harnessSessionsScreen.project({ sessions: [{
      session_id: "session-1", connector_id: "native", execution_kind: "direct", profile_id: "safe", state: "completed", latest_sequence: 3,
      model_identity: { provider_id: "provider", model_id: "model", revision: "r1" }, recovery: { kind: "recovery_required" },
      terminal: { cause: "completed", provenance: { tag: "verified" } }, diagnostics: ["bounded"],
    }, { session_id: 4, model_identity: { provider_id: "p", model_id: "m", configured_revision: "r2" } }] }, context);
    expect(sessions.rows[0]).toMatchObject({ id: "session-1", revision: "observed r1", recovery: "required", provenance: "verified" });
    expect(sessions.row_ids?.[1]).toBeNull();
    expect(harnessSessionsScreen.render({ projection: sessions, ...context }).join("\n")).toContain("native");
    const compactInventory = harnessSessionsScreen.render({ projection: sessions, width: 72, height: 10, selected_id: "session-1" }).join("\n");
    expect(compactInventory).toContain("Session");
    expect(compactInventory).toContain("session-1");
    expect(compactInventory.split("\n").every((line) => [...line].length <= 72)).toBe(true);

    const inspect = harnessSessionsScreen.project({
      session_id: "session-1", state: "interrupted", latest_sequence: 4,
      model_identity: { provider_id: "provider", model_id: "model" }, recovery: { kind: "recovery_required", reason: "incomplete" },
      tool_audits: [{ outcome: "allowed", effect: "read", action_scope: { status: "matched" } }],
      artifacts: [{ artifact_id: "artifact-1", storage: "inline" }], terminal: { cause: "interrupt" },
    }, context);
    expect(inspect.rows.some((row) => row.field === "Recovery" && String(row.value).includes("incomplete"))).toBe(true);

    const events = harnessSessionsScreen.project({ session_id: "session-1", events: [{ sequence: 1, kind: "started", occurred_at: "now", payload: { redacted: true } }] }, context);
    expect(events.variant).toBe("events");
    expect(harnessSessionsScreen.render({ projection: events, ...context }).join("\n")).toContain("started");

    const attached = harnessSessionsScreen.project({ session: { session_id: "session-1", terminal: null }, events: [{ sequence: 4, kind: "model_text", occurred_at: "now", payload: { text: "canonical attached narrative", phase: "final" } }], live: true, pending_steering: 1, next_after_sequence: 4 }, context);
    expect(attached.variant).toBe("attach");
    expect(attached.columns).toEqual([]);
    expect(attached.rows[0]).toMatchObject({ event: { kind: "final_answer", lifecycle: "observed", summary: "canonical attached narrative", source: "canonical_session", source_id: "session-1" } });
    expect(attached.row_ids).toEqual([{ id: "session-1", context: { attached_event_id: "canonical:session-1:4" } }]);
    const attachedText = harnessSessionsScreen.render({ projection: attached, ...context }).join("\n");
    expect(attachedText).toContain("Attached session-1: live");
    expect(attachedText).toContain("final answer");
    expect(attachedText).toContain("canonical/canonical_session");
    expect(attachedText).not.toContain('"payload"');
    const narrowText = harnessSessionsScreen.render({ projection: harnessSessionsScreen.project({ session: { session_id: "session-1", terminal: null }, events: [{ sequence: 4, kind: "model_text", occurred_at: "now", payload: { text: "canonical attached narrative", phase: "final" } }], live: true, pending_steering: 1, next_after_sequence: 4 }, { width: 60, height: 12 }), width: 60, height: 12 }).join("\n");
    const wideText = harnessSessionsScreen.render({ projection: harnessSessionsScreen.project({ session: { session_id: "session-1", terminal: null }, events: [{ sequence: 4, kind: "model_text", occurred_at: "now", payload: { text: "canonical attached narrative", phase: "final" } }], live: true, pending_steering: 1, next_after_sequence: 4 }, { width: 160, height: 24 }), width: 160, height: 24 }).join("\n");
    expect(narrowText.split("\n").every((line) => [...line].length <= 60)).toBe(true);
    expect(wideText).toContain("canonical/canonical_session");

    const unavailable = harnessSessionsScreen.project({ availability: "unavailable", reason: "not composed" }, context);
    expect(harnessSessionsScreen.render({ projection: unavailable, ...context })[0]).toContain("not composed");
    expect(harnessSessionsScreen.project(undefined, context).variant).toBe("empty");
  });

  it("renders readiness, allocation, and catalog projections without inventing authority", () => {
    const readiness = harnessReadinessScreen.project({
      execution: { kind: "native", reason: "configured" }, adapter: { adapter_id: "openai-compatible", availability: "available" },
      credential: { present: false }, model_revision: { readiness: "unpinned" }, pricing: { readiness: "configured" }, budget: { readiness: "configured" },
      missing_requirements: [{ code: "credential", action: "set environment overlay" }],
    }, context);
    expect(readiness.rows.some((row) => row.concern === "Credential" && row.status === "absent")).toBe(true);
    expect(harnessReadinessScreen.render({ projection: readiness, ...context }).join("\n")).toContain("credential");
    expect(readiness.caption).toContain("1 setup blocker");
    const narrowReadiness = harnessReadinessScreen.render({ projection: readiness, width: 60, height: 12, scroll_offset: 0 }).join("\n");
    expect(narrowReadiness).toContain("• Credential: absent");
    expect(narrowReadiness).toContain("next: Set ARBOR_NATIVE_API_KEY");
    expect(narrowReadiness.split("\n").every((line) => [...line].length <= 60)).toBe(true);
    expect(harnessReadinessScreen.project({ execution: null }, context).variant).toBe("empty");

    const budget = nativeBudgetScreen.project({
      availability: "configured", campaign_id: "campaign-1", revision: 2,
      configured: { max_tokens: 100, max_cost: { kind: "priced", minor_units: 123, currency: "USD", minor_unit_exponent: 2 } },
      consumed_tokens: 10, reserved_tokens: 5, remaining_tokens: 85,
      consumed_cost: { kind: "unpriced", reason: "not observed" }, reserved_cost: null,
      remaining_cost: { kind: "priced", minor_units: -5, currency: "USD", minor_unit_exponent: 0 }, reservations: [{}],
    }, context);
    expect(budget.rows.some((row) => row.field === "Cost ceiling" && row.value === "1.23 USD")).toBe(true);
    expect(nativeBudgetScreen.render({ projection: budget, ...context }).join("\n")).toContain("Campaign");
    const unconfigured = nativeBudgetScreen.project({ availability: "unconfigured", campaign_id: "campaign-2" }, context);
    expect(nativeBudgetScreen.render({ projection: unconfigured, ...context }).join("\n")).toContain("not configured");

    const capabilities = capabilitiesScreen.project({ catalog: [
      { kind: "campaign.start", action_class: "preview-confirm", minimum_tier: "heartwood", supported: true },
      { supported: false },
    ] }, context);
    expect(capabilities.rows[1]).toEqual({ kind: "?", class: "?", tier: "never", state: "unavailable" });
    expect(capabilitiesScreen.render({ projection: capabilities, ...context }).join("\n")).toContain("campaign.start");
    expect(capabilitiesScreen.project(null, context).variant).toBe("empty");
  });
});
