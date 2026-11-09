import { describe, it, expect, afterEach } from "vitest";
import {
  registerScreen,
  clearRegisteredScreens,
  getScreen,
  availableScreens,
} from "../src/screens/screen.js";
import { displayWidth } from "../src/widgets.js";
import { campaignsScreen } from "../src/screens/campaigns.js";
import { diagnosticsScreen } from "../src/screens/diagnostics.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function cj<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

// Width gauge using same NFC logic as production displayWidth
function w(line: string): number {
  return displayWidth(line);
}

// ── campaign list fixtures ───────────────────────────────────────────────────

const campaignListPayload = cj([
  { id: "camp-01", plan_path: "plans/Refactor TUI Shell", halted: false, root_node_state: "expanding", total_nodes: 42, verified_nodes: 10 },
  { id: "camp-02", plan_path: "plans/Audit Evidence Ledger", halted: true, halt_reason: "dormant", root_node_state: "pending", total_nodes: 7, verified_nodes: 0 },
  { id: "camp-03", plan_path: "plans/Tree Pruning Heuristic", halted: true, halt_reason: "completed", root_node_state: "verified", total_nodes: 128, verified_nodes: 91 },
]);

// ── event timeline fixtures ──────────────────────────────────────────────────
//
// The real `event.resume` contract: `{kind: "events", cursor, events:
// RuntimeEventEnvelope[]}`, where each envelope nests its payload under
// `.event` and carries `occurred_at` (ISO 8601) + `cursor.sequence`
// (monotonic integer) — never a flat `{at, kind, node_id, details}` record.

function envelope(
  sequence: number,
  occurredAt: string,
  event: Record<string, unknown>,
): Record<string, unknown> {
  return {
    schema_version: 1,
    id: `evt-${sequence}`,
    cursor: { stream_id: "campaign-x", sequence },
    occurred_at: occurredAt,
    correlation_id: `corr-${sequence}`,
    event,
    redacted: false,
  };
}

function eventsResult(events: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    kind: "events",
    cursor: { stream_id: "campaign-x", sequence: events.length },
    events,
  };
}

const eventPayload = cj(
  eventsResult([
    envelope(3, "2026-08-04T00:00:00.800Z", { kind: "tree.node_changed", campaign_id: "camp-1", node_id: "root", state: "pending" }),
    envelope(4, "2026-08-04T00:00:01.000Z", { kind: "tree.node_changed", campaign_id: "camp-1", node_id: "n1", state: "expanding" }),
    envelope(5, "2026-08-04T00:00:01.200Z", { kind: "tree.node_changed", campaign_id: "camp-1", node_id: "root", state: "verified" }),
    envelope(6, "2026-08-04T00:00:01.300Z", { kind: "tree.node_changed", campaign_id: "camp-1", node_id: "n2", state: "claimed" }),
    envelope(7, "2026-08-04T00:00:01.400Z", { kind: "gate.recorded", campaign_id: "camp-1", node_id: "n1", gate: "uct", result: "fail" }),
    envelope(8, "2026-08-04T00:00:01.500Z", { kind: "tree.node_changed", campaign_id: "camp-1", node_id: "n4", state: "failed" }),
  ]),
);

const eventWithUnicode = cj(
  eventsResult([
    envelope(1, "2026-08-04T00:00:01.000Z", { kind: "tree.node_changed", campaign_id: "日本語", node_id: "日本語", state: "ノード作成" }),
    envelope(2, "2026-08-04T00:00:01.100Z", { kind: "tree.node_changed", campaign_id: "camp-1", node_id: "n2", state: "🚀 launched specialist" }),
    envelope(3, "2026-08-04T00:00:01.200Z", { kind: "gate.recorded", campaign_id: "camp-1", node_id: "n3", gate: "critic", result: "pass" }),
  ]),
);

// ── test isolation ───────────────────────────────────────────────────────────

afterEach(() => {
  clearRegisteredScreens();
});

// ═══════════════════════════════════════════════════════════════════════════════
// campaigns screen
// ═══════════════════════════════════════════════════════════════════════════════

describe("campaigns screen — module shape", () => {
  it("has correct id, title, required_capabilities", () => {
    expect(campaignsScreen.id).toBe("campaigns");
    expect(campaignsScreen.title).toBe("Campaigns");
    expect(campaignsScreen.required_capabilities).toEqual(["campaign.read"]);
  });

  it("surface declares only its canonical list and halt controls", () => {
    const s = campaignsScreen.surface;
    expect(s.commands).toEqual(["campaign.halt"]);
    expect(s.queries).toEqual(["campaign.list"]);
  });
});

describe("campaigns screen — registration / availability", () => {
  it("registers and retrieves via registry", () => {
    registerScreen(campaignsScreen);
    const fetched = getScreen("campaigns");
    expect(fetched.id).toBe("campaigns");
    expect(fetched.required_capabilities).toEqual(["campaign.read"]);
  });

  it("is available when campaign.read is granted", () => {
    registerScreen(campaignsScreen);
    const av = availableScreens(new Set(["campaign.read"]));
    expect(av.map((m) => m.id)).toContain("campaigns");
  });

  it("is NOT available when campaign.read is absent", () => {
    registerScreen(campaignsScreen);
    const av = availableScreens(new Set(["tree.read"]));
    expect(av.map((m) => m.id)).not.toContain("campaigns");
  });

  it("is NOT available when no capabilities are granted", () => {
    registerScreen(campaignsScreen);
    const av = availableScreens(new Set([]));
    expect(av).toHaveLength(0);
  });

  it("cannot register without required capabilities (registry validation)", () => {
    expect(() =>
      registerScreen({
        ...campaignsScreen,
        required_capabilities: [],
      }),
    ).toThrow(/required capabilities/);
  });
});

describe("campaigns screen — projection shape", () => {
  it("projects campaign list rows with expected columns", () => {
    const p = campaignsScreen.project(campaignListPayload, { width: 100, height: 20 });
    expect(p.screen).toBe("campaigns");
    expect(p.rows).toHaveLength(3);
    expect(p.rows[0].id).toBe("camp-01");
    expect(p.rows[0].name).toBe("Refactor TUI Shell");
    // Status is derived, not passed through: a running campaign shows its root
    // node's live state, a halted one shows why it stopped. `campaign.list`
    // has no `status` field — asserting one was how the projection came to
    // read four field names the runtime never returns.
    expect(p.rows[0].status).toBe("expanding");
    expect(p.rows[1].status).toBe("dormant");
    expect(p.rows[2].status).toBe("completed");
    expect(p.rows[0].nodes).toBe("42");
    expect(p.rows[0].verified).toBe("10");
    const keys = p.columns.map((c) => c.key);
    expect(keys).toEqual(["id", "name", "status", "nodes", "verified"]);
  });

  // Rewritten in wave 2. This previously asserted `rows.length <= height`,
  // which was the defect, not the contract: coupling projection to viewport
  // height meant the rows below the fold did not exist to scroll to, so
  // `widgets.ts`'s offset parameters were dead. Projection is now bounded by
  // the screen's own cardinality cap and windowed at render time by
  // `scroll_offset`.
  //
  // The assertion that matters is therefore the opposite of the old one: the
  // projection must NOT collapse to the viewport, and must still be bounded.
  it("bounds campaign list rows by cardinality cap, independent of viewport height", () => {
    const bigList = Array.from({ length: 300 }, (_, i) => ({
      id: `c-${i}`,
      plan_path: `plans/Campaign ${i}.md`,
      status: "active",
      total_nodes: i,
      verified_nodes: 0,
    }));
    const p = campaignsScreen.project(bigList, { width: 100, height: 5 });
    expect(p.rows.length).toBeGreaterThan(5);
    expect(p.rows.length).toBeLessThan(300);
    // Same input, taller viewport — projection is height-independent now.
    const tall = campaignsScreen.project(bigList, { width: 100, height: 80 });
    expect(tall.rows.length).toBe(p.rows.length);
  });

  it("carries row_ids keyed by campaign id", () => {
    const list = campaignsScreen.project(campaignListPayload, { width: 100, height: 20 });
    expect(list.row_ids?.[0]).toEqual({ id: "camp-01" });
  });
});

describe("campaigns screen — deterministic render", () => {
  it("renders campaign list deterministically", () => {
    const p = campaignsScreen.project(campaignListPayload, { width: 100, height: 10 });
    const r1 = campaignsScreen.render({ projection: p, width: 120, height: 10 });
    const r2 = campaignsScreen.render({ projection: p, width: 120, height: 10 });
    expect(r1).toEqual(r2);
  });

  it("campaign list render includes caption and header", () => {
    const p = campaignsScreen.project(campaignListPayload, { width: 100, height: 10 });
    const lines = campaignsScreen.render({ projection: p, width: 100, height: 10 });
    expect(lines[0]).toContain("Campaigns");
    expect(lines.length).toBeGreaterThan(1);
  });

});

describe("campaigns screen — bound enforcement", () => {
  it("width 30 clips all lines to display width", () => {
    const p = campaignsScreen.project(campaignListPayload, { width: 100, height: 10 });
    const lines = campaignsScreen.render({ projection: p, width: 30, height: 10 });
    for (const line of lines) {
      expect(w(line)).toBeLessThanOrEqual(30);
    }
  });

});

describe("campaigns screen — empty / unknown payloads", () => {
  it("null payload → empty projection (never throws)", () => {
    const p = campaignsScreen.project(null, { width: 80, height: 10 });
    expect(p.rows).toHaveLength(0);
    expect(p.caption).toContain("Campaign data unavailable");
  });

  it("undefined payload → empty projection", () => {
    const p = campaignsScreen.project(undefined, { width: 80, height: 10 });
    expect(p.rows).toHaveLength(0);
  });

  it("empty array is a real empty campaign list, not an unavailable result", () => {
    const p = campaignsScreen.project([], { width: 80, height: 10 });
    const lines = campaignsScreen.render({ projection: p, width: 80, height: 5 });
    expect(lines[0]).toContain("no campaigns");
  });

  it("unknown scalar → empty projection", () => {
    const p = campaignsScreen.project(42, { width: 80, height: 10 });
    expect(p.rows).toHaveLength(0);
  });

  it("unknown object without nodes → empty projection", () => {
    const p = campaignsScreen.project({ foo: "bar" }, { width: 80, height: 10 });
    expect(p.rows).toHaveLength(0);
  });

  it("campaign.tree payloads are rejected because Tree owns topology", () => {
    const p = campaignsScreen.project({ campaign_id: "c1", nodes: [] }, { width: 80, height: 10 });
    expect(p.rows).toHaveLength(0);
    expect(p.variant).toBe("empty");
    expect(p.caption).toContain("Campaign data unavailable");
  });

  it("rendering empty projection never throws", () => {
    const p = campaignsScreen.project(null, { width: 80, height: 10 });
    const lines = campaignsScreen.render({ projection: p, width: 80, height: 5 });
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.every((l) => w(l) <= 80)).toBe(true);
  });
});

describe("campaigns screen — Unicode clipping", () => {
  it("clips wide Unicode characters in campaign list", () => {
    const uniPayload = [{ id: "c1", name: "日本語テスト", status: "active", node_count: 1, verified_count: 0 }];
    const p = campaignsScreen.project(uniPayload, { width: 100, height: 10 });
    const lines = campaignsScreen.render({ projection: p, width: 40, height: 10 });
    for (const line of lines) {
      expect(w(line)).toBeLessThanOrEqual(40);
    }
  });

});

describe("campaigns screen — capability and authority", () => {
  it("screen is offered with campaign.read alone", () => {
    registerScreen(campaignsScreen);
    const av = availableScreens(new Set(["campaign.read"]));
    expect(av.map((m) => m.id)).toContain("campaigns");
  });

  it("screen not offered when campaign.read capability is absent", () => {
    registerScreen(campaignsScreen);
    const av = availableScreens(new Set(["tree.read"]));
    expect(av.map((m) => m.id)).not.toContain("campaigns");
  });

  it("extra capabilities do not block availability", () => {
    registerScreen(campaignsScreen);
    const av = availableScreens(new Set(["campaign.read", "tree.read", "campaign.write", "tree.interrupt"]));
    expect(av.map((m) => m.id)).toContain("campaigns");
  });

  it("surface owns campaign halt but no tree mutation authority", () => {
    expect(campaignsScreen.surface.commands).toEqual(["campaign.halt"]);
    expect(campaignsScreen.required_capabilities).not.toContain("campaign.write");
    expect(campaignsScreen.required_capabilities).not.toContain("tree.write");
  });

  it("diagnostics screen: only event.read required, no commands", () => {
    expect(diagnosticsScreen.required_capabilities).toEqual(["event.read"]);
    expect(diagnosticsScreen.surface.commands).toHaveLength(0);
    expect(diagnosticsScreen.surface.queries).toEqual(["event.resume"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// diagnostics screen
// ═══════════════════════════════════════════════════════════════════════════════

describe("diagnostics screen — module shape", () => {
  it("has correct id, title, required_capabilities", () => {
    expect(diagnosticsScreen.id).toBe("diagnostics");
    expect(diagnosticsScreen.title).toBe("Diagnostics");
    expect(diagnosticsScreen.required_capabilities).toEqual(["event.read"]);
  });

  it("surface declares only event.resume query, no commands", () => {
    expect(diagnosticsScreen.surface.commands).toEqual([]);
    expect(diagnosticsScreen.surface.queries).toEqual(["event.resume"]);
  });
});

describe("diagnostics screen — registration / availability", () => {
  it("registers and retrieves via registry", () => {
    registerScreen(diagnosticsScreen);
    const fetched = getScreen("diagnostics");
    expect(fetched.id).toBe("diagnostics");
  });

  it("available only when event.read is granted", () => {
    registerScreen(diagnosticsScreen);
    expect(availableScreens(new Set(["event.read"])).map((m) => m.id)).toContain("diagnostics");
    expect(availableScreens(new Set([])).map((m) => m.id)).not.toContain("diagnostics");
    expect(availableScreens(new Set(["campaign.read"])).map((m) => m.id)).not.toContain("diagnostics");
  });
});

describe("diagnostics screen — projection shape", () => {
  it("projects events with causal ordering (sorted by cursor.sequence)", () => {
    const p = diagnosticsScreen.project(eventPayload, { width: 100, height: 20 });
    expect(p.screen).toBe("diagnostics");
    expect(p.rows).toHaveLength(6);
    // First should be the earliest (sequence 3, root pending)
    expect(p.rows[0].at).toBe("00:00:00");
    expect(p.rows[0].kind).toBe("tree.node_changed");
    expect(p.rows[0].node_id).toBe("root");
    expect(p.rows[0].summary).toBe("tree.node_changed · node root");
    expect(p.rows[0].detail).toBe("-> pending");
    expect(p.rows[0].source).toBe("canonical/event.resume");
    // Last should be the latest (sequence 8, n4 failed)
    expect(p.rows[5].node_id).toBe("n4");
    expect(p.rows[5].detail).toBe("-> failed");
    expect(p.rows[5].state).toBe("failed");
  });

  it("produces the shared diagnostic grammar columns", () => {
    const p = diagnosticsScreen.project(eventPayload, { width: 100, height: 20 });
    const keys = p.columns.map((c) => c.key);
    expect(keys).toEqual(["summary", "state", "source"]);
  });

  it("caption reflects event count", () => {
    const p = diagnosticsScreen.project(eventPayload, { width: 100, height: 20 });
    expect(p.caption).toContain("Events: 6");
  });

  it("derives node_id and details per RuntimeEvent kind (gate.recorded)", () => {
    const p = diagnosticsScreen.project(eventPayload, { width: 100, height: 20 });
    const gateRow = p.rows.find((r) => r.kind === "gate.recorded");
    expect(gateRow?.node_id).toBe("n1");
    expect(gateRow?.detail).toBe("uct: fail");
    expect(gateRow?.state).toBe("attention");
  });

  it("handles a kind with no node_id (campaign.changed) gracefully", () => {
    const payload = cj(eventsResult([envelope(1, "2026-08-04T00:00:00.000Z", { kind: "campaign.changed", campaign_id: "camp-1", change: "created" })]));
    const p = diagnosticsScreen.project(payload, { width: 100, height: 10 });
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0].node_id).toBe("-");
    expect(p.rows[0].detail).toBe("camp-1 created");
  });

  it("handles an unrecognized event kind gracefully, and renders it visibly rather than blank", () => {
    // A kind describeEvent's switch has no case for — either malformed input
    // or a future RuntimeEvent variant this screen hasn't been updated for —
    // must never render the SAME blank {node_id:"-", details:""} a real,
    // legitimately detail-less event (e.g. campaign.changed with no node)
    // could also produce: that would make "unknown to the screen" and "real,
    // empty-detail event" indistinguishable.
    const payload = cj(eventsResult([envelope(1, "2026-08-04T00:00:00.000Z", { kind: "unknown.thing" })]));
    const p = diagnosticsScreen.project(payload, { width: 100, height: 10 });
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0].node_id).toBe("-");
    expect(p.rows[0].detail).toBe("unhandled event kind: unknown.thing");
  });

  it("handles a missing event kind gracefully", () => {
    const payload = cj(eventsResult([envelope(1, "2026-08-04T00:00:00.000Z", {})]));
    const p = diagnosticsScreen.project(payload, { width: 100, height: 10 });
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0].node_id).toBe("-");
    expect(p.rows[0].detail).toBe("unhandled event kind");
  });

  it("a bare event array (not the real {kind:'events', events} shape) is not mistaken for the real contract", () => {
    // G-31-class regression guard: the real payload is an object, never a
    // top-level array of flat records.
    const bareArray = cj([{ at: 42, kind: "bare" }]);
    const p = diagnosticsScreen.project(bareArray, { width: 100, height: 10 });
    expect(p.rows).toHaveLength(0);
    expect(p.caption).toBe("No events");
  });

  it("carries row_ids keyed by the envelope's own id (RuntimeEventEnvelope.id)", () => {
    const payload = cj(eventsResult([envelope(1, "2026-08-04T00:00:00.000Z", { kind: "campaign.changed", campaign_id: "camp-1", change: "created" })]));
    const p = diagnosticsScreen.project(payload, { width: 100, height: 10 });
    expect(p.row_ids).toEqual([{ id: "evt-1" }]);
  });

  it("falls back to cursor.sequence for row identity when the envelope has no id", () => {
    const noId = { schema_version: 1, cursor: { stream_id: "s", sequence: 7 }, occurred_at: "2026-08-04T00:00:00.000Z", event: { kind: "campaign.changed", campaign_id: "c", change: "created" } };
    const p = diagnosticsScreen.project({ kind: "events", cursor: { stream_id: "s", sequence: 1 }, events: [noId] }, { width: 100, height: 10 });
    expect(p.row_ids).toEqual([{ id: "7" }]);
  });
});

describe("diagnostics screen — deterministic render", () => {
  it("renders identical projections identically", () => {
    const p = diagnosticsScreen.project(eventPayload, { width: 100, height: 20 });
    const r1 = diagnosticsScreen.render({ projection: p, width: 120, height: 10 });
    const r2 = diagnosticsScreen.render({ projection: p, width: 120, height: 10 });
    expect(r1).toEqual(r2);
  });

  it("keeps a canonical terminal failure expanded in the primary diagnostic document", () => {
    const projection = diagnosticsScreen.project(
      eventsResult([envelope(1, "2026-08-04T00:00:00.000Z", { kind: "tree.node_changed", campaign_id: "camp-1", node_id: "n1", state: "failed" })]),
      { width: 100, height: 10 },
    );
    const rendered = diagnosticsScreen.render({ projection, width: 100, height: 10 }).join("\n");
    expect(rendered).toContain("canonical/event.resume");
    expect(rendered).toContain("failed");
    expect(rendered).toContain("-> failed");
  });

  it("includes source-labelled diagnostic document header", () => {
    const p = diagnosticsScreen.project(eventPayload, { width: 100, height: 20 });
    const lines = diagnosticsScreen.render({ projection: p, width: 120, height: 10 });
    expect(lines[0]).toContain("Events:");
    expect(lines[0]).toContain("canonical/event.resume");
    expect(lines.length).toBeGreaterThan(1);
  });
});

describe("diagnostics screen — bound enforcement", () => {
  it("height 4 → at most 4 lines", () => {
    const p = diagnosticsScreen.project(eventPayload, { width: 100, height: 20 });
    const lines = diagnosticsScreen.render({ projection: p, width: 100, height: 4 });
    expect(lines.length).toBeLessThanOrEqual(4);
  });

  it("width 30 clips all lines", () => {
    const p = diagnosticsScreen.project(eventPayload, { width: 100, height: 20 });
    const lines = diagnosticsScreen.render({ projection: p, width: 30, height: 10 });
    for (const line of lines) {
      expect(w(line)).toBeLessThanOrEqual(30);
    }
  });

  it("bounded by cardinality cap (500)", () => {
    const big = eventsResult(
      Array.from({ length: 600 }, (_, i) => envelope(i, new Date(1_800_000_000_000 + i * 1000).toISOString(), { kind: "tree.node_changed", campaign_id: "camp-1", node_id: `n${i}`, state: "pending" })),
    );
    const p = diagnosticsScreen.project(cj(big), { width: 100, height: 100 });
    expect(p.rows.length).toBeLessThanOrEqual(500);
    expect(p.rows.length).toBe(500);
  });
});

describe("diagnostics screen — empty / unknown payloads", () => {
  it("null → empty projection", () => {
    const p = diagnosticsScreen.project(null, { width: 80, height: 10 });
    expect(p.rows).toHaveLength(0);
    expect(p.caption).toBe("No events");
  });

  it("undefined → empty projection", () => {
    const p = diagnosticsScreen.project(undefined, { width: 80, height: 10 });
    expect(p.rows).toHaveLength(0);
  });

  it("empty array (not the real event.resume shape) → renders the fallback no-events line", () => {
    const p = diagnosticsScreen.project([], { width: 80, height: 10 });
    expect(p.caption).toBe("No events");
    const lines = diagnosticsScreen.render({ projection: p, width: 80, height: 5 });
    expect(lines[0]).toContain("No events");
  });

  it("a real, empty event.resume dispatch (`{kind:'events', events:[]}`) renders distinctly from the never-dispatched fallback", () => {
    // The same bug class already guarded against in operations.ts/output.ts:
    // a genuinely empty result from a real dispatch must not collapse into
    // the same text as "no query was ever issued" — otherwise the operator
    // (and this suite) cannot tell a freshly booted, event-free runtime from
    // a diagnostics screen that was never wired at all.
    const p = diagnosticsScreen.project(cj(eventsResult([])), { width: 80, height: 10 });
    expect(p.rows).toHaveLength(0);
    expect(p.caption).toBe("Events: 0");
    const lines = diagnosticsScreen.render({ projection: p, width: 80, height: 5 });
    expect(lines[0]).toContain("Events: 0");
    expect(lines[0]).not.toBe("No events");
  });

  it("unknown scalar → empty projection", () => {
    const p = diagnosticsScreen.project(42, { width: 80, height: 10 });
    expect(p.rows).toHaveLength(0);
  });

  it("unknown object → empty projection", () => {
    const p = diagnosticsScreen.project({ foo: "bar" }, { width: 80, height: 10 });
    expect(p.rows).toHaveLength(0);
  });

  it("rendering empty projection never throws", () => {
    const p = diagnosticsScreen.project(null, { width: 80, height: 10 });
    const lines = diagnosticsScreen.render({ projection: p, width: 80, height: 5 });
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.every((l) => w(l) <= 80)).toBe(true);
  });
});

describe("diagnostics screen — Unicode clipping", () => {
  it("clips Unicode event data within width", () => {
    const p = diagnosticsScreen.project(eventWithUnicode, { width: 100, height: 20 });
    const lines = diagnosticsScreen.render({ projection: p, width: 40, height: 10 });
    for (const line of lines) {
      expect(w(line)).toBeLessThanOrEqual(40);
    }
  });

  it("emojis in details do not break width bounds", () => {
    const emojiEvents = cj(eventsResult([envelope(1, "2026-08-04T00:00:00.100Z", { kind: "tree.node_changed", campaign_id: "c1", node_id: "n1", state: "🚀🔥💥" })]));
    const p = diagnosticsScreen.project(emojiEvents, { width: 100, height: 20 });
    const lines = diagnosticsScreen.render({ projection: p, width: 30, height: 10 });
    for (const line of lines) {
      expect(w(line)).toBeLessThanOrEqual(30);
    }
  });

  it("formats occurred_at (ISO 8601) as wall-clock HH:MM:SS (UTC)", () => {
    const payload = cj(eventsResult([envelope(1, "2026-08-04T02:05:30.000Z", { kind: "tree.node_changed", campaign_id: "c1", node_id: "n1", state: "pending" })]));
    const p = diagnosticsScreen.project(payload, { width: 100, height: 10 });
    expect(p.rows[0].at).toBe("02:05:30");
  });

  it("unparseable occurred_at renders as ?", () => {
    const payload = cj(eventsResult([envelope(1, "not-a-date", { kind: "tree.node_changed", campaign_id: "c1", node_id: "n1", state: "pending" })]));
    const p = diagnosticsScreen.project(payload, { width: 100, height: 10 });
    expect(p.rows[0].at).toBe("?");
  });
});

describe("diagnostics screen — causal ordering", () => {
  it("sorts out-of-order events by ascending cursor.sequence", () => {
    const unsorted = cj(
      eventsResult([
        envelope(3, "2026-08-04T00:00:03.000Z", { kind: "tree.node_changed", campaign_id: "c1", node_id: "c", state: "pending" }),
        envelope(1, "2026-08-04T00:00:01.000Z", { kind: "tree.node_changed", campaign_id: "c1", node_id: "a", state: "pending" }),
        envelope(2, "2026-08-04T00:00:02.000Z", { kind: "tree.node_changed", campaign_id: "c1", node_id: "b", state: "pending" }),
      ]),
    );
    const p = diagnosticsScreen.project(unsorted, { width: 100, height: 10 });
    expect(p.rows.map((r) => r.node_id)).toEqual(["a", "b", "c"]);
  });

  it("stable sort on equal sequence (by original index)", () => {
    const eq = cj(
      eventsResult([
        envelope(1, "2026-08-04T00:00:01.000Z", { kind: "tree.node_changed", campaign_id: "c1", node_id: "first", state: "pending" }),
        envelope(1, "2026-08-04T00:00:01.000Z", { kind: "tree.node_changed", campaign_id: "c1", node_id: "second", state: "pending" }),
        envelope(1, "2026-08-04T00:00:01.000Z", { kind: "tree.node_changed", campaign_id: "c1", node_id: "third", state: "pending" }),
      ]),
    );
    const p = diagnosticsScreen.project(eq, { width: 100, height: 10 });
    expect(p.rows.map((r) => r.node_id)).toEqual(["first", "second", "third"]);
  });

  it("events missing a cursor sort to the end", () => {
    const withMissingCursor = eventsResult([
      { schema_version: 1, id: "evt-b", occurred_at: "2026-08-04T00:00:02.000Z", correlation_id: "c-b", event: { kind: "tree.node_changed", campaign_id: "c1", node_id: "b", state: "pending" }, redacted: false },
      { schema_version: 1, id: "evt-no-cursor", occurred_at: "2026-08-04T00:00:00.500Z", correlation_id: "c-no", event: { kind: "tree.node_changed", campaign_id: "c1", node_id: "no_cursor", state: "pending" }, redacted: false },
      envelope(1, "2026-08-04T00:00:01.000Z", { kind: "tree.node_changed", campaign_id: "c1", node_id: "a", state: "pending" }),
    ]);
    // give "evt-b" a real cursor so only "evt-no-cursor" is missing one
    const events = withMissingCursor.events as Record<string, unknown>[];
    events[0]!.cursor = { stream_id: "campaign-x", sequence: 2 };
    const p = diagnosticsScreen.project(cj(withMissingCursor), { width: 100, height: 10 });
    expect(p.rows.map((r) => r.node_id)).toEqual(["a", "b", "no_cursor"]);
  });
});

describe("diagnostics screen — typed trace records, not conflated", () => {
  it("does not include evidence-like columns", () => {
    const p = diagnosticsScreen.project(eventPayload, { width: 100, height: 20 });
    const keys = p.columns.map((c) => c.key);
    expect(keys).not.toContain("evidence");
    expect(keys).not.toContain("hash");
    expect(keys).not.toContain("provenance");
  });

  it("event rows retain a source-labelled diagnostic grammar without evidence fields", () => {
    const p = diagnosticsScreen.project(eventPayload, { width: 100, height: 20 });
    for (const row of p.rows) {
      const rowKeys = Object.keys(row);
      expect(rowKeys).toEqual(["at", "kind", "node_id", "source", "state", "summary", "detail"]);
    }
  });

  it("evidence data in the envelope's event payload is NOT projected into rows", () => {
    const withEvidence = cj(
      eventsResult([envelope(1, "2026-08-04T00:00:00.100Z", { kind: "audit.evidence_recorded", campaign_id: "c1", evidence_id: "ev-1", hash: "abc123", provenance: "verified" })]),
    );
    const p = diagnosticsScreen.project(withEvidence, { width: 100, height: 10 });
    expect(Object.keys(p.rows[0])).not.toContain("evidence");
    expect(Object.keys(p.rows[0])).not.toContain("hash");
    expect(Object.keys(p.rows[0])).not.toContain("provenance");
  });
});

describe("both screens — shared registry isolation", () => {
  it("both can be registered and queried together", () => {
    registerScreen(campaignsScreen);
    registerScreen(diagnosticsScreen);
    expect(getScreen("campaigns").id).toBe("campaigns");
    expect(getScreen("diagnostics").id).toBe("diagnostics");
  });

  it("availableScreens filters both correctly", () => {
    registerScreen(campaignsScreen);
    registerScreen(diagnosticsScreen);

    // Grant both
    const both = availableScreens(new Set(["campaign.read", "tree.read", "event.read"]));
    expect(both.map((m) => m.id)).toContain("campaigns");
    expect(both.map((m) => m.id)).toContain("diagnostics");

    // Grant campaigns only
    const cmpa = availableScreens(new Set(["campaign.read", "tree.read"]));
    expect(cmpa.map((m) => m.id)).toContain("campaigns");
    expect(cmpa.map((m) => m.id)).not.toContain("diagnostics");

    // Grant diagnostics only
    const diag = availableScreens(new Set(["event.read"]));
    expect(diag.map((m) => m.id)).not.toContain("campaigns");
    expect(diag.map((m) => m.id)).toContain("diagnostics");

    // Grant nothing
    const none = availableScreens(new Set([]));
    expect(none).toHaveLength(0);
  });
});
