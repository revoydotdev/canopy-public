import { describe, expect, it } from "vitest";
import { a2aScreen } from "../src/screens/a2a.js";
import { approvalsScreen } from "../src/screens/approvals.js";
import { controlScreen } from "../src/screens/control.js";
import { kbScreen } from "../src/screens/kb.js";
import { nativeBudgetScreen } from "../src/screens/native-budget.js";
import { surveillanceScreen } from "../src/screens/surveillance.js";
import { telemetryScreen } from "../src/screens/telemetry.js";

const context = { width: 100, height: 12, scroll_offset: 0 };

describe("operational screens preserve uncertainty under degraded inputs", () => {
  it("distinguishes unconfigured, empty, malformed, and populated A2A states", () => {
    const custom = a2aScreen.project({ campaign_id: "c", cards: [], configured: false, message: "signing unavailable" }, context);
    expect(custom.caption).toBe("signing unavailable");
    const fallback = a2aScreen.project({ campaign_id: "c", cards: [], configured: false, message: "  " }, context);
    expect(fallback.caption).toContain("not configured");
    const cards = a2aScreen.project({ campaign_id: "c", cards: [{}, { node_ref: "n", role: "seed", tier: "claimed", skills: ["read", "write"], signature: "s" }] }, context);
    expect(cards.rows[0]).toEqual({ node_ref: "?", role: "?", tier: "?", skills: "?", signature: "?" });
    expect(cards.row_ids).toEqual([null, { id: "n" }]);
    expect(a2aScreen.project(null, context).variant).toBe("empty");
    expect(a2aScreen.project({ campaign_id: "c", cards: null }, context).variant).toBe("empty");
  });

  it("renders every approval action/status and only offers persistent memory for canonical fingerprints", () => {
    const fingerprint = `sha256:${"a".repeat(64)}`;
    const records = [
      { request_id: "p", action: "campaign.halt", subject: "c", status: "pending", proposer: "seed", expires_at: "2026-08-30T12:34:56Z", action_fingerprint: fingerprint },
      { request_id: "a", action: "recovery.abandon", subject: "r", status: "approved", decided_by: "lenticel", expires_at: "soon" },
      { request_id: "r", action: "output.raw", subject: "o", status: "rejected", expires_at: null },
      { request_id: "e", action: "permission.grant", subject: "g", status: "expired" },
      { action: "unknown", status: 4 },
    ];
    const projection = approvalsScreen.project({ records }, context);
    expect(projection.rows.map((row) => row.action)).toEqual(expect.arrayContaining([
      "HALT campaign · c", "ABANDON recovery · r", "DISCLOSE raw output · o", "GRANT permission · g", "OTHER action · ?",
    ]));
    expect(projection.rows.map((row) => row.proposal)).toEqual(expect.arrayContaining(["◔ pending", "✓ approved", "✗ rejected", "⊘ expired", "? ?"]));
    expect(String(projection.rows[0]?.memory)).toContain("persistent (survives restart)");
    expect(String(projection.rows[1]?.memory)).toContain("persistent unavailable");
    expect(projection.rows[0]?.expires).toBe("2026-08-30T12:34");
    expect(projection.row_ids?.at(-1)).toBeNull();
    expect(approvalsScreen.project({ records: null }, context).variant).toBe("empty");
  });

  it("keeps surveillance findings bounded and labels missing facts", () => {
    const projection = surveillanceScreen.project({ findings: [{}, { dedup_key: "d", severity: "high", kind: "drift", summary: "observed" }] }, context);
    expect(projection.rows[0]).toEqual({ severity: "?", kind: "?", summary: "?" });
    expect(projection.row_ids).toEqual([null, { id: "d" }]);
    expect(surveillanceScreen.project({ findings: [] }, context).caption).toBe("no surveillance findings");
    expect(surveillanceScreen.project([], context).variant).toBe("empty");
  });

  it("renders all KB entry families and explicit redaction without inventing details", () => {
    const projection = kbScreen.project([
      { id: "redacted", value: null },
      { id: "failure", value: { type: "failure_mode", failure_mode: "timeout", root_cause: "lease" } },
      { id: "fallback", value: { type: "failure_mode", value: "fallback" } },
      { id: "parameter", value: { type: "parameter_finding", parameter: "limit", validated_value: "32" } },
      { id: "success", value: { type: "success_pattern", value: "retry once" } },
      { id: "unknown", value: { type: "new_kind" } },
    ], context);
    expect(projection.rows.map((row) => row.detail)).toEqual(expect.arrayContaining([
      "[redacted: capability_required]", "timeout (cause: lease)", "fallback", "limit = 32", "retry once", "?",
    ]));
    // EC-012: empty captions name their subject and what creates a record.
    expect(kbScreen.project([], context).caption).toContain("No knowledge entries yet");
    expect(kbScreen.project([{}], context).variant).toBe("empty");
  });

  it("shows budget cost uncertainty, scale, sign, and absent allocation separately", () => {
    const projection = nativeBudgetScreen.project({
      availability: "configured", campaign_id: "c", revision: 3,
      configured: { max_cost: { kind: "unpriced" } }, consumed_cost: { kind: "priced", minor_units: 5, currency: "USD", minor_unit_exponent: 0 },
      reserved_cost: { kind: "priced", minor_units: -5, currency: "USD", minor_unit_exponent: 2 }, remaining_cost: { kind: "other" },
      remaining_tokens: null,
    }, context);
    expect(projection.rows).toEqual(expect.arrayContaining([
      { field: "Token ceiling", value: "not configured" },
      { field: "Tokens remaining", value: "not configured" },
      { field: "Cost ceiling", value: "unpriced: reason unavailable" },
      { field: "Cost consumed", value: "5 USD" },
      { field: "Cost reserved", value: "-0.05 USD" },
      { field: "Cost remaining", value: "unavailable" },
    ]));
    expect(nativeBudgetScreen.project({ availability: "configured", campaign_id: "c" }, context).variant).toBe("empty");
  });

  it("fails telemetry shape validation at each required collection boundary", () => {
    const base = { campaign_id: "c", source_record_count: 0, counters: [], phase_histograms: [], usage_cost: [], context_economy: [], tool_economy: [] };
    expect(telemetryScreen.project(base, context).variant).toBe("telemetry");
    for (const malformed of [null, { ...base, campaign_id: 4 }, { ...base, source_record_count: 0.5 }, { ...base, counters: null }, { ...base, tool_economy: null }]) {
      expect(telemetryScreen.project(malformed, context).variant).toBe("empty");
    }
  });

  it("projects disabled, offline status, truncated discovery, and redacted inbox control states", () => {
    const disabled = controlScreen.project({ availability: "disabled" }, context);
    expect(controlScreen.render({ projection: disabled, ...context }).join("\n")).toContain("Distributed control is disabled");

    const status = controlScreen.project({ availability: "configured", kind: "control.status", updated_at: null, value: { coordinator: { error: "timeout" }, registration: {}, bridge: { outbox_pending: Number.NaN } } }, context);
    expect(status.caption).toContain("pending");
    expect(status.rows[0]).toMatchObject({ host: "authority", coordinator: "offline: timeout", heartbeat: "not registered", bridge: "disabled", outbox: "—" });

    const discover = controlScreen.project({ availability: "configured", kind: "control.discover", value: { truncated: true, hosts: [null, { host_id: "host", capabilities: ["tools", 4] }, {}] } }, context);
    expect(discover.caption).toContain("2+ shown");
    expect(discover.rows[0]?.capabilities).toBe("tools");
    expect(discover.row_ids).toEqual([{ id: "host" }, null]);

    const inbox = controlScreen.project({ availability: "configured", kind: "control.inbox", value: { truncated: true, messages: [{ message_id: "m", claimed: true }, { claimed: false }] } }, context);
    expect(inbox.caption).toContain("payload bodies never projected");
    expect(inbox.rows.map((row) => row.claimed)).toEqual(["yes", "no"]);
    expect(controlScreen.project({ availability: "configured", kind: "unknown", value: {} }, context).variant).toBe("empty");
  });
});
