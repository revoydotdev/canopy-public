import { describe, expect, it } from "vitest";
import { createNavigation, deriveConsoleActivityNarrative, deriveStatusBarZones, deriveTheme, DEFAULT_DARK_PALETTE, DEFAULT_LIGHT_PALETTE, checkLegibility, displayWidth, footerTheme, formatCost, initialModel, renderStatusBar, spinnerGlyph, StdoutRenderer, STATUS_BAR_PLACEHOLDER, type AppModel, type TelemetrySnapshot, type UsageCostRow } from "../src/index.js";
import { renderStructuredFrame, renderTerminalFrame } from "./support/render-harness.js";

const ESC = String.fromCharCode(27);
const ANSI_SGR = new RegExp(ESC + String.raw`\[[0-9;]*m`, "g");

function usageCost(overrides: {
  model_family?: string;
  cost_minor_units?: number;
  currency?: string;
  minor_unit_exponent?: string;
} = {}): UsageCostRow {
  return {
    name: "arbor.provider.usage_cost",
    campaign_id: "camp-01",
    node_id: "n1",
    tags: {
      provider: "anthropic",
      model_family: overrides.model_family ?? "claude-sonnet",
      phase: "expand",
      agent: "seed",
      pricing: "priced",
      currency: overrides.currency ?? "USD",
      minor_unit_exponent: overrides.minor_unit_exponent ?? "2",
    },
    calls: 1,
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_minor_units: overrides.cost_minor_units ?? 100,
    price_source_ids: [],
    evidence: [],
  };
}

function unpricedUsageCost(overrides: { model_family?: string; reason?: string } = {}): UsageCostRow {
  return {
    name: "arbor.provider.usage_cost",
    campaign_id: "camp-01",
    node_id: "n1",
    tags: {
      provider: "anthropic",
      model_family: overrides.model_family ?? "claude-sonnet",
      phase: "expand",
      agent: "seed",
      pricing: "unpriced",
    },
    calls: 1,
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    unpriced_reasons: [overrides.reason ?? "no price schedule wired"],
    evidence: [],
  };
}

function snapshot(overrides: Partial<TelemetrySnapshot> = {}): TelemetrySnapshot {
  return {
    campaign_id: "camp-01",
    source_record_count: 0,
    counters: [],
    phase_histograms: [],
    usage_cost: [],
    context_economy: [],
    tool_economy: [],
    ...overrides,
  };
}

function nav(columns: number, rows: number) {
  return createNavigation(
    { id: "main", route: "/", split: "horizontal", ratio: 0.5, panes: [{ id: "output", title: "Output" }] },
    { columns, rows },
  );
}

function treeNode(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "node_1",
    state: "pending",
    depth: 0,
    ...overrides,
  };
}

function treeResult(campaignId: string, nodes: readonly Record<string, unknown>[], terminal: Record<string, unknown> = {}) {
  return { campaign_id: campaignId, decomposed: nodes.length, nodes, ...terminal };
}

describe("status-bar zone content (4F.4)", () => {
  it("renders labeled em-dash placeholders when no campaign/telemetry data is available", () => {
    const zones = deriveStatusBarZones(initialModel(), 0);
    expect(zones.campaign).toBe(STATUS_BAR_PLACEHOLDER);
    expect(zones.events).toBe(STATUS_BAR_PLACEHOLDER);
    expect(zones.budget).toBe(STATUS_BAR_PLACEHOLDER);
    expect(zones.model).toBe(STATUS_BAR_PLACEHOLDER);
    // epoch is a real AppModel field (4F.2) and is never a placeholder.
    expect(zones.epoch).toBe("0");
    expect(zones.activity).toBe("idle");
    expect(zones.fidelity).toBe("████████");
    expect(zones.active).toBe(STATUS_BAR_PLACEHOLDER);
    expect(zones.attempt).toBe(STATUS_BAR_PLACEHOLDER);
    expect(zones.phase).toBe(STATUS_BAR_PLACEHOLDER);
    expect(zones.verified).toBe(STATUS_BAR_PLACEHOLDER);
    expect(zones.attention).toBe(STATUS_BAR_PLACEHOLDER);
    expect(zones.closed).toBe(STATUS_BAR_PLACEHOLDER);
    expect(zones.last).toBe(STATUS_BAR_PLACEHOLDER);
  });

  it("uses telemetryCampaignId for the campaign zone when set", () => {
    const app: AppModel = { ...initialModel(), telemetryCampaignId: "camp-42" };
    expect(deriveStatusBarZones(app, 0).campaign).toBe("camp-42");
  });

  it("falls back to the telemetry snapshot's own campaign_id when telemetryCampaignId is unset", () => {
    const app: AppModel = { ...initialModel(), telemetrySnapshot: snapshot({ campaign_id: "camp-from-snapshot" }) };
    expect(deriveStatusBarZones(app, 0).campaign).toBe("camp-from-snapshot");
  });

  it("derives the events zone from telemetry source_record_count", () => {
    const app: AppModel = { ...initialModel(), telemetrySnapshot: snapshot({ source_record_count: 17 }) };
    expect(deriveStatusBarZones(app, 0).events).toBe("17");
  });

  it("derives the model zone from usage-cost model_family tags, deduping repeats", () => {
    const app: AppModel = {
      ...initialModel(),
      telemetrySnapshot: snapshot({ usage_cost: [usageCost({ model_family: "claude-sonnet" }), usageCost({ model_family: "claude-sonnet" })] }),
    };
    expect(deriveStatusBarZones(app, 0).model).toBe("claude-sonnet");
  });

  it("joins distinct model families when multiple providers billed the campaign", () => {
    const app: AppModel = {
      ...initialModel(),
      telemetrySnapshot: snapshot({ usage_cost: [usageCost({ model_family: "claude-sonnet" }), usageCost({ model_family: "gpt-5" })] }),
    };
    expect(deriveStatusBarZones(app, 0).model).toBe("claude-sonnet+gpt-5");
  });

  it("sums cost_minor_units across usage-cost rows sharing a currency for the budget zone", () => {
    const app: AppModel = {
      ...initialModel(),
      telemetrySnapshot: snapshot({ usage_cost: [usageCost({ cost_minor_units: 150 }), usageCost({ cost_minor_units: 350 })] }),
    };
    expect(deriveStatusBarZones(app, 0).budget).toBe(formatCost(500, 2, "USD"));
  });

  it("renders the budget zone as a placeholder — never a fabricated $0 — when every usage-cost row is unpriced", () => {
    const app: AppModel = {
      ...initialModel(),
      telemetrySnapshot: snapshot({ usage_cost: [unpricedUsageCost(), unpricedUsageCost()] }),
    };
    expect(deriveStatusBarZones(app, 0).budget).toBe(STATUS_BAR_PLACEHOLDER);
  });

  it("sums only the priced rows for the budget zone when priced and unpriced rows are mixed", () => {
    const app: AppModel = {
      ...initialModel(),
      telemetrySnapshot: snapshot({ usage_cost: [usageCost({ cost_minor_units: 150 }), unpricedUsageCost()] }),
    };
    expect(deriveStatusBarZones(app, 0).budget).toBe(formatCost(150, 2, "USD"));
  });

  it("advances the activity-spinner glyph deterministically with frame_count (never Date.now()/random)", () => {
    const app: AppModel = {
      ...initialModel(),
      telemetryCampaignId: "camp-active",
      screens: new Map([["tree", treeResult("camp-active", [treeNode({ id: "n1", state: "expanding" })])]]),
    };
    expect(deriveStatusBarZones(app, 3).activity).toBe(spinnerGlyph(3));
    expect(deriveStatusBarZones(app, 3).activity).toBe(deriveStatusBarZones(app, 3).activity);
    expect(deriveStatusBarZones(app, 3).activity).not.toBe(deriveStatusBarZones(app, 4).activity);
  });

  it("reports the model's own monotonic epoch (4F.2), never a placeholder", () => {
    const app: AppModel = { ...initialModel(), epoch: 9 };
    expect(deriveStatusBarZones(app, 0).epoch).toBe("9");
  });

  it("renders Console as a truthful narrative activity line instead of dashboard telemetry", () => {
    const app: AppModel = { ...initialModel(), epoch: 4, telemetryCampaignId: "camp-9" };
    const row = renderStatusBar(app, { columns: 130, frame_count: 0, color: false });
    expect(row).toContain("Idle — describe what you want changed");
    expect(row).not.toContain("campaign");
    expect(row).not.toContain("activity");
    expect(row).not.toContain("events");
    expect(row).not.toContain("model");
    expect(row).not.toContain("fidelity");
    expect(row).not.toContain("budget");
    expect(row).not.toContain("epoch");
  });

  it("EC-053: a task restored without a live worker is interrupted, not Working", () => {
    const orphan: AppModel = { ...initialModel(), screens: new Map([["console", { tasks: { items: [{ id: "t1", state: "started", interrupted: true }] } }]]) };
    expect(deriveConsoleActivityNarrative(orphan)).toEqual({ text: "Resumed — 1 task interrupted, see Recovery", active: false });
    const mixed: AppModel = { ...initialModel(), screens: new Map([["console", { tasks: { items: [{ id: "t1", state: "started", interrupted: true }, { id: "t2", state: "started" }] } }]]) };
    expect(deriveConsoleActivityNarrative(mixed)).toEqual({ text: "Working", active: true });
  });

  it("uses only canonical Console state for planning, thinking, buffering, and a real clarification", () => {
    const planning: AppModel = { ...initialModel(), screens: new Map([["console", { fresh_launch_planning: true, drafts: { items: [{ status: "planning" }] } }]]) };
    expect(deriveConsoleActivityNarrative(planning)).toEqual({ text: "Planning your request", active: true });
    const thinking: AppModel = { ...initialModel(), screens: new Map([["console", { session_attach: { live: true, events: [{ kind: "model_text" }] } }]]) };
    expect(deriveConsoleActivityNarrative(thinking)).toEqual({ text: "Thinking", active: true });
    const buffering: AppModel = { ...initialModel(), screens: new Map([["console", { session_attach: { live: true, events: [] } }]]) };
    expect(deriveConsoleActivityNarrative(buffering)).toEqual({ text: "Buffering live output", active: true });
    const noQuestion: AppModel = { ...initialModel(), screens: new Map([["console", { drafts: { items: [{ status: "awaiting_clarification", proposal: { questions: [] } }] } }]]) };
    expect(deriveConsoleActivityNarrative(noQuestion)).toEqual({ text: "Reconciling clarification state", active: true });
    const question: AppModel = { ...initialModel(), screens: new Map([["console", { drafts: { items: [{ status: "awaiting_clarification", proposal: { questions: [{ question: "Which package?", answer: null }] } }] } }]]) };
    expect(deriveConsoleActivityNarrative(question)).toEqual({ text: "Waiting for your answer", active: false });
  });

  it("throws on a non-safe-integer or negative columns value", () => {
    expect(() => renderStatusBar(initialModel(), { columns: -1 })).toThrow();
    expect(() => renderStatusBar(initialModel(), { columns: 1.5 })).toThrow();
  });

  it("is always exactly `columns` display-width wide, plain or styled (full-row coverage, no bleed-through)", () => {
    for (const columns of [0, 1, 6, 40, 80, 120]) {
      const plain = renderStatusBar(initialModel(), { columns, color: false });
      expect(displayWidth(plain)).toBe(columns);
      const styled = renderStatusBar(initialModel(), { columns, color: true });
      expect(displayWidth(styled.replace(ANSI_SGR, ""))).toBe(columns);
    }
  });

  // OT-6: color_mode only changes the SGR encoding, never the display width
  // or whether color emits at all (that stays gated on `color: boolean`).
  it("color_mode degrades the SGR encoding without changing display width", () => {
    const columns = 120;
    const truecolor = renderStatusBar(initialModel(), { columns, color: true, color_mode: "truecolor" });
    const ansi256 = renderStatusBar(initialModel(), { columns, color: true, color_mode: "ansi256" });
    expect(displayWidth(truecolor.replace(ANSI_SGR, ""))).toBe(columns);
    expect(displayWidth(ansi256.replace(ANSI_SGR, ""))).toBe(columns);
    expect(truecolor).toMatch(/\[38;2;/);
    expect(truecolor).not.toMatch(/\[38;5;/);
    expect(ansi256).toMatch(/\[38;5;/);
    expect(ansi256).not.toMatch(/\[38;2;/);
  });

  it("color: false never emits any SGR regardless of color_mode (NO_COLOR/mono contract)", () => {
    const row = renderStatusBar(initialModel(), { columns: 80, color: false, color_mode: "ansi256" });
    expect(row).not.toMatch(ANSI_SGR);
  });
});

describe("execution-status projection (active/attempt/phase/verified)", () => {
  it("derives the active node, its attempt (visit_count) and phase (state) from the node in the \"expanding\" state", () => {
    const app: AppModel = {
      ...initialModel(),
      telemetryCampaignId: "camp-1",
      screens: new Map([["tree", treeResult("camp-1", [
        treeNode({ id: "n1", state: "verified" }),
        treeNode({ id: "n2", state: "expanding", visit_count: 3, action_description: "Wire the retry path" }),
        treeNode({ id: "n3", state: "pending" }),
      ])]]),
    };
    const zones = deriveStatusBarZones(app, 0);
    expect(zones.active).toBe("Wire the retry path");
    expect(zones.attempt).toBe("3");
    expect(zones.phase).toBe("expanding");
    expect(zones.verified).toBe("1/3");
  });

  it("falls back to the node id when no action_description is present", () => {
    const app: AppModel = {
      ...initialModel(),
      telemetryCampaignId: "camp-1",
      screens: new Map([["tree", treeResult("camp-1", [treeNode({ id: "n2", state: "expanding", visit_count: 1 })])]]),
    };
    expect(deriveStatusBarZones(app, 0).active).toBe("n2");
  });

  it("renders em-dash placeholders for active/attempt/phase when no node is expanding, but a real fraction for verified", () => {
    const app: AppModel = {
      ...initialModel(),
      telemetryCampaignId: "camp-1",
      screens: new Map([["tree", treeResult("camp-1", [
        treeNode({ id: "n1", state: "verified" }),
        treeNode({ id: "n2", state: "verified" }),
      ])]]),
    };
    const zones = deriveStatusBarZones(app, 0);
    expect(zones.active).toBe(STATUS_BAR_PLACEHOLDER);
    expect(zones.attempt).toBe(STATUS_BAR_PLACEHOLDER);
    expect(zones.phase).toBe(STATUS_BAR_PLACEHOLDER);
    expect(zones.verified).toBe("2/2");
  });

  it("replaces an obsolete root-recovery node with the durable halted no_nodes state", () => {
    const app: AppModel = {
      ...initialModel(),
      telemetryCampaignId: "camp-1",
      screens: new Map([["tree", treeResult("camp-1", [
        treeNode({ id: "root", state: "expanding", action_description: "root recovery" }),
        treeNode({ id: "child-1", state: "failed" }),
        treeNode({ id: "child-2", state: "failed" }),
      ], { halted: true, halt_reason: "no_nodes" })]]),
    };
    const zones = deriveStatusBarZones(app, 0);
    expect(zones.active).toBe("halted (no_nodes)");
    expect(zones.phase).toBe("halted");
    expect(zones.attempt).toBe(STATUS_BAR_PLACEHOLDER);
    expect(zones.verified).toBe("0/3");
  });

  it("renders a genuine 0/0 for an empty but fetched tree, never a placeholder", () => {
    const app: AppModel = {
      ...initialModel(),
      telemetryCampaignId: "camp-1",
      screens: new Map([["tree", treeResult("camp-1", [])]]),
    };
    expect(deriveStatusBarZones(app, 0).verified).toBe("0/0");
  });

  it("never fabricates a value from an unrelated screen's query result", () => {
    const app: AppModel = {
      ...initialModel(),
      screens: new Map([["campaigns", [{ id: "c1" }]]]),
    };
    const zones = deriveStatusBarZones(app, 0);
    expect(zones.active).toBe(STATUS_BAR_PLACEHOLDER);
    expect(zones.verified).toBe(STATUS_BAR_PLACEHOLDER);
  });

  it("marks the projection unavailable rather than stale when the fetched tree belongs to a campaign the model has since left", () => {
    const app: AppModel = {
      ...initialModel(),
      // The operator is now viewing camp-2, but the last-fetched tree result
      // still belongs to camp-1 — a genuine campaign-change race, not yet
      // resolved by the next campaign.tree poll.
      telemetryCampaignId: "camp-2",
      screens: new Map([["tree", treeResult("camp-1", [treeNode({ id: "n2", state: "expanding", visit_count: 4 })])]]),
    };
    const zones = deriveStatusBarZones(app, 0);
    expect(zones.active).toBe(STATUS_BAR_PLACEHOLDER);
    expect(zones.attempt).toBe(STATUS_BAR_PLACEHOLDER);
    expect(zones.phase).toBe(STATUS_BAR_PLACEHOLDER);
    expect(zones.verified).toBe(STATUS_BAR_PLACEHOLDER);
  });

  it("trusts the fetched tree's own campaign_id when the model has no current-campaign signal yet", () => {
    const app: AppModel = {
      ...initialModel(),
      telemetryCampaignId: null,
      screens: new Map([["tree", treeResult("camp-1", [treeNode({ id: "n2", state: "expanding", visit_count: 2 })])]]),
    };
    expect(deriveStatusBarZones(app, 0).active).toBe("n2");
  });

  it("surfaces terminal count and the latest durable reason", () => {
    const app: AppModel = {
      ...initialModel(),
      telemetryCampaignId: "camp-1",
      screens: new Map([["tree", treeResult("camp-1", [
        treeNode({ id: "n1", state: "failed", outcome: { kind: "error", error: { message: "verifier exited 1" } } }),
        treeNode({ id: "n2", state: "interrupted", outcome: { kind: "interrupted", message: "operator stopped work" } }),
      ])]]),
    };
    const zones = deriveStatusBarZones(app, 0);
    expect(zones.closed).toBe("2");
    expect(zones.last).toBe("interrupted: operator stopped work");
  });

  it("surfaces only observed attention queues without inventing unknown counts", () => {
    const app: AppModel = {
      ...initialModel(),
      screens: new Map([
        ["interviews", { records: [{ id: "i1" }, { id: "i2" }] }],
        ["recovery", { campaign_id: "camp-1", nodes: [{ node_id: "r1" }] }],
        ["task-composer", { drafts: [{ proposal: { questions: [{ id: "q1", answer: null }, { id: "q2", answer: "done" }] } }] }],
      ]),
    };
    expect(deriveStatusBarZones(app, 0).attention).toBe("I2/R1/C1");
  });

  it("does not count append-only interview records whose durable answers exist", () => {
    const base = initialModel();
    const screens = new Map(base.screens);
    screens.set("interviews", {
      records: [{ id: "answered" }, { id: "pending" }],
      answered_record_ids: ["answered"],
    });
    expect(deriveStatusBarZones({ ...base, screens }, 0).attention).toBe("I1");
    screens.set("interviews", {
      records: [{ id: "answered" }],
      answered_record_ids: ["answered"],
    });
    expect(deriveStatusBarZones({ ...base, screens }, 0).attention).toBe("0");
  });

  it("falls back to the active screen's own nested tree field when the top-level \"tree\" key was never fetched (ADR-123)", () => {
    const app: AppModel = {
      ...initialModel(),
      screen: "console",
      telemetryCampaignId: "camp-1",
      screens: new Map([["console", {
        tree: treeResult("camp-1", [treeNode({ id: "n2", state: "expanding", visit_count: 3, action_description: "Wire retries" })]),
      }]]),
    };
    const zones = deriveStatusBarZones(app, 0);
    expect(zones.active).toBe("Wire retries");
    expect(zones.attempt).toBe("3");
    expect(zones.phase).toBe("expanding");
    expect(zones.verified).toBe("0/1");
  });

  it("prefers the dedicated Tree screen's own top-level projection over the active screen's nested fallback when both are fresh", () => {
    const app: AppModel = {
      ...initialModel(),
      screen: "console",
      telemetryCampaignId: "camp-1",
      screens: new Map<AppModel["screen"], unknown>([
        ["tree", treeResult("camp-1", [treeNode({ id: "top", state: "expanding", visit_count: 1 })])],
        ["console", { tree: treeResult("camp-1", [treeNode({ id: "nested", state: "expanding", visit_count: 9 })]) }],
      ]),
    };
    expect(deriveStatusBarZones(app, 0).active).toBe("top");
  });

  it("does not leak a stale campaign's tree through the active screen's nested fallback", () => {
    const app: AppModel = {
      ...initialModel(),
      screen: "console",
      telemetryCampaignId: "camp-2",
      screens: new Map([["console", { tree: treeResult("camp-1", [treeNode({ id: "n2", state: "expanding", visit_count: 3 })]) }]]),
    };
    const zones = deriveStatusBarZones(app, 0);
    expect(zones.active).toBe(STATUS_BAR_PLACEHOLDER);
    expect(zones.verified).toBe(STATUS_BAR_PLACEHOLDER);
  });

  it("does not fall back to a screen other than the currently active one", () => {
    const app: AppModel = {
      ...initialModel(),
      screen: "tree",
      telemetryCampaignId: "camp-1",
      screens: new Map([["console", { tree: treeResult("camp-1", [treeNode({ id: "n2", state: "expanding", visit_count: 3 })]) }]]),
    };
    const zones = deriveStatusBarZones(app, 0);
    expect(zones.active).toBe(STATUS_BAR_PLACEHOLDER);
    expect(zones.verified).toBe(STATUS_BAR_PLACEHOLDER);
  });
});

describe("execution-status row omission when unavailable (ADR-123 Decision 2)", () => {
  it("omits active/phase/attempt/verified from the wide row entirely rather than rendering em-dashes, when no source is fetched", () => {
    const row = renderStatusBar(initialModel(), { columns: 160, frame_count: 0, color: false });
    expect(row).toContain("Idle — describe what you want changed");
    expect(row).not.toContain("active");
    expect(row).not.toContain("phase");
    expect(row).not.toContain("attempt");
    expect(row).not.toContain("verified");
  });

  it("keeps execution state out of the Console footer even when a genuine 0/0 result is fetched", () => {
    const app: AppModel = {
      ...initialModel(),
      telemetryCampaignId: "camp-1",
      screens: new Map([["tree", treeResult("camp-1", [])]]),
    };
    const row = renderStatusBar(app, { columns: 160, frame_count: 0, color: false });
    expect(row).toContain("Idle — describe what you want changed");
    expect(row).not.toContain("verified");
  });

  it("omits the execution-status tokens from the compact row without leaving a dangling separator", () => {
    const plain = renderStatusBar(initialModel(), { columns: 80, frame_count: 0, color: false });
    const styled = renderStatusBar(initialModel(), { columns: 80, frame_count: 0, color: true });
    expect(plain).not.toMatch(/·\s*·/);
    expect(styled.replace(ANSI_SGR, "")).toBe(plain);
  });
});

// A real, full-length composer UUID (36 chars) — long enough that, together
// with its "campaign " label, it alone would eat roughly half of an
// 80-column row if the wide, labeled layout were used unconditionally.
const LONG_CAMPAIGN_ID = "8f14e45f-ceea-467e-bd3a-9b73f3ea7f0e";

describe("status-bar narrow/wide layouts", () => {
  const wideApp: AppModel = {
    ...initialModel(),
    screen: "tree",
    epoch: 4,
    telemetryCampaignId: LONG_CAMPAIGN_ID,
    screens: new Map([["tree", treeResult(LONG_CAMPAIGN_ID, [treeNode({ id: "n2", state: "expanding", visit_count: 2, action_description: "Wire retries" })])]]),
  };

  it("shows the full zone set — including the low-priority model/fidelity zones — once the row is wide enough", () => {
    const row = renderStatusBar(wideApp, { columns: 160, frame_count: 0, color: false });
    expect(row).toContain(`campaign ${LONG_CAMPAIGN_ID}`);
    expect(row).toContain("active Wire retries");
    expect(row).toContain("attempt 2");
    expect(row).toContain("phase expanding");
    expect(row).toContain("verified 0/1");
    expect(row).toContain("events");
    expect(row).toContain("model");
    expect(row).toContain("fidelity");
    // epoch is no longer rendered by default (internal model-version counter).
    expect(row).not.toContain("epoch");
  });

  it("keeps the wide, labeled, full-UUID row just above the compact breakpoint (97 columns)", () => {
    const row = renderStatusBar(wideApp, { columns: 97, frame_count: 0, color: false });
    expect(row).toContain(`campaign ${LONG_CAMPAIGN_ID}`);
    expect(row).toContain("phase expanding");
  });

  it("switches to the compact row at the breakpoint itself (96 columns) — no labeled full-UUID campaign zone", () => {
    const row = renderStatusBar(wideApp, { columns: 96, frame_count: 0, color: false });
    expect(row).not.toContain(`campaign ${LONG_CAMPAIGN_ID}`);
    expect(row).not.toContain("campaign ");
  });

  it("renders an adaptive compact row at 80 columns — stable short campaign id, activity glyph, bounded active label, phase, compact attempt and verified progress, never the clipped-off full UUID", () => {
    const row = renderStatusBar(wideApp, { columns: 80, frame_count: 0, color: false });
    expect(displayWidth(row)).toBe(80);
    // Stable leading slice of the campaign id (not the full 36-char UUID).
    expect(row).toContain(LONG_CAMPAIGN_ID.slice(0, 8));
    expect(row).not.toContain(LONG_CAMPAIGN_ID);
    expect(row).toContain(spinnerGlyph(0));
    expect(row).toContain("Wire retries");
    expect(row).toContain("expanding");
    expect(row).toContain("#2");
    expect(row).toContain("✓0/1");
    // No labeled wide-row zones leak into the compact row.
    expect(row).not.toContain("campaign ");
    expect(row).not.toContain("attempt ");
    expect(row).not.toContain("verified ");
    expect(row).not.toContain("phase ");
    expect(row).not.toContain("fidelity");
    expect(row).not.toContain("events");
    expect(row).not.toContain("model");
    expect(row).not.toContain("budget");
    expect(row).not.toContain("epoch");
  });

  it("uses the discriminating draft prefix for real composer campaign ids", () => {
    const campaignId = "composer-draft-e89d7dcc-f7af-497f-9ab1-6b49a816c4e1";
    const app: AppModel = {
      ...wideApp,
      telemetryCampaignId: campaignId,
      screens: new Map([["tree", treeResult(campaignId, [treeNode({ id: "n2", state: "expanding", visit_count: 2, action_description: "Wire retries" })])]]),
    };
    const row = renderStatusBar(app, { columns: 80, frame_count: 0, color: false });
    expect(row).toContain("e89d7dcc");
    expect(row).not.toContain("composer");
    expect(row).toContain("expanding");
    expect(row).toContain("#2");
    expect(row).toContain("✓0/1");
  });

  it("prioritizes campaign/activity/active-execution zones over events/epoch/model/fidelity when narrow", () => {
    const row = renderStatusBar(wideApp, { columns: 44, frame_count: 0, color: false });
    expect(row).toContain(LONG_CAMPAIGN_ID.slice(0, 8));
    expect(row).toContain("Wire");
    // Still exactly `columns` wide — clipping never breaks the full-row contract.
    expect(displayWidth(row)).toBe(44);
    expect(row).not.toContain("fidelity");
  });

  it("bounds a long active-node label so narrow rows still show phase, attempt, and verified progress", () => {
    const longLabelApp: AppModel = {
      ...initialModel(),
      screen: "tree",
      telemetryCampaignId: LONG_CAMPAIGN_ID,
      screens: new Map([["tree", treeResult(LONG_CAMPAIGN_ID, [
        treeNode({
          id: "n2",
          state: "expanding",
          visit_count: 2,
          action_description: "Investigate and remediate the extremely long-winded root-cause description that would otherwise crowd out every other zone",
        }),
      ])]]),
    };
    // Wide enough for the wide row's full labeled zone set, including the
    // full-length campaign UUID, even with the active label at its bound.
    const row = renderStatusBar(longLabelApp, { columns: 180, frame_count: 0, color: false });
    expect(row).toContain("phase expanding");
    expect(row).toContain("attempt 2");
    expect(row).toContain("verified 0/1");
  });

  it("bounds a long active-node label in the compact row at 80 columns, so phase/attempt/verified still show", () => {
    const longLabelApp: AppModel = {
      ...initialModel(),
      screen: "tree",
      telemetryCampaignId: LONG_CAMPAIGN_ID,
      screens: new Map([["tree", treeResult(LONG_CAMPAIGN_ID, [
        treeNode({
          id: "n2",
          state: "expanding",
          visit_count: 2,
          action_description: "Investigate and remediate the extremely long-winded root-cause description that would otherwise crowd out every other zone",
        }),
      ])]]),
    };
    const row = renderStatusBar(longLabelApp, { columns: 80, frame_count: 0, color: false });
    expect(displayWidth(row)).toBe(80);
    expect(row).toContain("expanding");
    expect(row).toContain("#2");
    expect(row).toContain("✓0/1");
  });

  it("preserves the interrupt-confirmation hint ahead of the execution-status zones in a narrow row", () => {
    const armedApp: AppModel = {
      ...wideApp,
      repeatConfirmation: { token: "t1", action_key: "interrupt", hint: "press again to interrupt", expires_at: 1000, fired: false },
    };
    const row = renderStatusBar(armedApp, { columns: 54, frame_count: 0, color: false });
    expect(row).toContain("press again to interrupt");
    expect(row).not.toContain("fidelity");
  });

  it("preserves the interrupt-confirmation hint in the compact row at exactly 80 columns", () => {
    const armedApp: AppModel = {
      ...wideApp,
      repeatConfirmation: { token: "t1", action_key: "interrupt", hint: "press again to interrupt", expires_at: 1000, fired: false },
    };
    const row = renderStatusBar(armedApp, { columns: 80, frame_count: 0, color: false });
    expect(displayWidth(row)).toBe(80);
    expect(row).toContain("press again to interrupt");
  });

  it("stays exactly `columns` wide across narrow and wide layouts with color on", () => {
    for (const columns of [20, 40, 80, 96, 97, 160]) {
      const styled = renderStatusBar(wideApp, { columns, color: true });
      expect(displayWidth(styled.replace(ANSI_SGR, ""))).toBe(columns);
    }
  });
});

describe("status-bar palette contract (ADR-020)", () => {
  it("uses only colors sourced from the footer theme — never a hardcoded bypass", () => {
    const output = renderStatusBar(initialModel(), { columns: 60, frame_count: 0, color: true });
    const footer = footerTheme(deriveTheme(undefined));
    const pattern = new RegExp(ESC + String.raw`\[(?:38|48);2;(\d+);(\d+);(\d+)m`, "g");
    const codes = [...output.matchAll(pattern)].map((match) => `${match[1]},${match[2]},${match[3]}`);
    expect(codes.length).toBeGreaterThan(0);
    const allowed = [footer.background, footer.text, footer.accent].map((color) => color.join(","));
    for (const code of codes) expect(allowed).toContain(code);
  });

  it("derives dark-mode SGR codes matching DEFAULT_DARK_PALETTE by default", () => {
    const output = renderStatusBar(initialModel(), { columns: 60, color: true });
    expect(output).toContain(`${ESC}[48;2;${DEFAULT_DARK_PALETTE.background.join(";")}m`);
    expect(output).toContain(`${ESC}[38;2;${DEFAULT_DARK_PALETTE.text.join(";")}m`);
    expect(output).toContain(`${ESC}[38;2;${DEFAULT_DARK_PALETTE.accent.join(";")}m`);
  });

  it("switches to the light palette when given a light RunTheme", () => {
    const output = renderStatusBar(initialModel(), { columns: 60, color: true, theme: deriveTheme("light") });
    expect(output).toContain(`${ESC}[48;2;${DEFAULT_LIGHT_PALETTE.background.join(";")}m`);
    expect(output).not.toContain(`${ESC}[48;2;${DEFAULT_DARK_PALETTE.background.join(";")}m`);
  });

  it("holds the ADR-020 legibility contract: the derived theme's text role passes the contrast floor", () => {
    expect(checkLegibility(deriveTheme(undefined), 4.5).lowContrast).not.toContain("text");
    expect(checkLegibility(deriveTheme("light"), 4.5).lowContrast).not.toContain("text");
  });

  it("emits no ANSI escapes at all when color is disabled", () => {
    const output = renderStatusBar(initialModel(), { columns: 60, color: false });
    expect(output).not.toContain(ESC);
  });
});

describe("status-bar frame-diff throttling (4F.3)", () => {
  it("repaints nothing when the model and frame clock are unchanged (idle)", () => {
    const out: string[] = [];
    const renderer = new StdoutRenderer({ write: (value: string) => { out.push(value); } }, { clear_screen: false });
    const projection = { app: initialModel(), output: "body", navigation: nav(40, 6) };
    renderer.render(renderStructuredFrame(projection, { frame_count: 2, color: false }));
    out.length = 0;
    renderer.render(renderStructuredFrame(projection, { frame_count: 2, color: false }));
    expect(out.join("")).toBe("");
  });

  it("does not repaint an idle status bar merely because the frame clock advances", () => {
    const out: string[] = [];
    const renderer = new StdoutRenderer({ write: (value: string) => { out.push(value); } }, { clear_screen: false });
    const projection = { app: initialModel(), output: "body", navigation: nav(40, 6) };
    renderer.render(renderStructuredFrame(projection, { frame_count: 0, color: false }));
    out.length = 0;
    renderer.render(renderStructuredFrame(projection, { frame_count: 1, color: false }));
    expect(out.join("")).toBe("");
  });

  it("stays a clean row diff when the status bar carries palette SGR codes (color on)", () => {
    const out: string[] = [];
    const renderer = new StdoutRenderer({ write: (value: string) => { out.push(value); } }, { clear_screen: false });
    const activeApp: AppModel = {
      ...initialModel(),
      screen: "tree",
      telemetryCampaignId: "camp-active",
      screens: new Map([["tree", treeResult("camp-active", [treeNode({ id: "n1", state: "expanding" })])]]),
    };
    const projection = { app: activeApp, output: "body", navigation: nav(40, 6) };
    renderer.render(renderStructuredFrame(projection, { frame_count: 0, color: true }));
    out.length = 0;
    renderer.render(renderStructuredFrame(projection, { frame_count: 1, color: true }));
    expect(out.join("")).toContain(`${ESC}[6;1H`);
  });

  it("re-derives a changed status bar when campaign identity changes at a fixed frame_count", () => {
    const out: string[] = [];
    const renderer = new StdoutRenderer({ write: (value: string) => { out.push(value); } }, { clear_screen: false });
    const navigation = nav(130, 6);
    const first = { ...initialModel(), screen: "tree" as const, telemetryCampaignId: "campaign-a" };
    renderer.render(renderStructuredFrame({ app: first, output: "body", navigation }, { frame_count: 0, color: false }));
    out.length = 0;
    renderer.render(renderStructuredFrame({ app: { ...first, telemetryCampaignId: "campaign-b" }, output: "body", navigation }, { frame_count: 0, color: false }));
    expect(out.join("")).toContain(`${ESC}[6;1H`);
  });
});

describe("replaces the scraped `connected────────` strip (ROADMAP 4F.4)", () => {
  it("the bottom row is a full-width status bar and never leaks stray pane-border fill", () => {
    const frame = renderTerminalFrame(
      { app: { ...initialModel(), screen: "tree" }, output: "x", navigation: nav(30, 5) },
      { frame_count: 0, color: false },
    );
    const lastRow = frame.split("\n").at(-1) ?? "";
    expect(lastRow).not.toContain("─");
    expect(lastRow).toContain("new session");
  });

  it("keeps Console's narrative activity footer on the final viewport row", () => {
    const frame = renderTerminalFrame({ app: initialModel(), output: "x", navigation: nav(30, 5) }, { frame_count: 0, color: false });
    const lastRow = frame.split("\n").at(-1) ?? "";
    expect(lastRow.startsWith(" · Idle — describe what you wa")).toBe(true);
    expect(lastRow).not.toMatch(/^└─+┘$/u);
  });

  it("no longer prints the raw connection.status word on the frame's last row", () => {
    const app: AppModel = { ...initialModel(), connection: { status: "connected", cursor: "c1" } };
    const frame = renderTerminalFrame({ app, output: "x", navigation: nav(30, 5) }, { frame_count: 0, color: false });
    const lastRow = frame.split("\n").at(-1) ?? "";
    expect(lastRow).not.toContain("connected");
  });
});

describe("compact status bar marks a truncated NAME but not a hash identity (EC-037)", () => {
  const compact = (campaign: string): string =>
    renderStatusBar({ ...initialModel(), screen: "tree", telemetryCampaignId: campaign } as AppModel,
      { columns: 80, frame_count: 0, color: false });

  it("marks a campaign name that was cut", () => {
    // `seed-campaign` rendered as `seed-cam`, which an operator cannot tell
    // from a campaign actually named `seed-cam`.
    const row = compact("seed-campaign");
    expect(row).toContain("\u2026");
    expect(row).not.toMatch(/seed-cam[^\u2026]/);
  });

  it("leaves a UUID's leading hex block unmarked — it is a complete short identity", () => {
    const row = compact("8f14e45f-ceea-467e-bd3a-9b73f3ea7f0e");
    expect(row).toContain("8f14e45f");
  });

  it("leaves a short name that fits entirely alone", () => {
    const row = compact("alpha");
    expect(row).toContain("alpha");
    expect(row).not.toContain("alpha\u2026");
  });
});
