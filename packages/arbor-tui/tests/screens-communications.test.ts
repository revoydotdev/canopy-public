import { describe, it, expect, afterEach } from "vitest";
import { communicationsScreen } from "../src/screens/communications.js";
import { registerScreen, clearRegisteredScreens, getScreen, availableScreens } from "../src/screens/screen.js";
import { displayWidth } from "../src/widgets.js";

afterEach(() => clearRegisteredScreens());

function render(result: unknown, consumerTier?: string, width = 80, height = 20): readonly string[] {
  const projection = communicationsScreen.project(result, { width, height, consumerTier });
  return communicationsScreen.render({ projection, width, height });
}

function comm(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "m1",
    kind: "delegate",
    capability_tier: "orchestrator",
    author_node_id: "a",
    recipient_node_id: "b",
    acknowledges_communication_id: null,
    retracts_communication_id: null,
    payload: { content: "hello world" },
    correlation_id: "corr-1",
    ...overrides,
  };
}

describe("communications screen", () => {
  it("is registered and exposes record control with declared capabilities", () => {
    registerScreen(communicationsScreen);
    const mod = getScreen("communications");
    expect(mod.title).toBe("Communications");
    expect(mod.required_capabilities).toEqual(["communication.read", "communication.write"]);
    expect(mod.surface.commands).toContain("communication.record");
    expect(mod.surface.queries).toContain("communication.selection");
    expect(mod.surface.queries).toContain("communication.history");
  });

  it("projects communications from a selection-shaped result", () => {
    const projection = communicationsScreen.project({ communications: [comm()] }, { width: 80, height: 10 });
    expect(projection.rows[0]).toMatchObject({ id: "m1", kind: "delegate", author: "a", recipient: "b" });
    expect(projection.caption).toContain("1");
  });

  it("carries row_ids keyed by message id", () => {
    const projection = communicationsScreen.project({ communications: [comm()] }, { width: 80, height: 10 });
    expect(projection.row_ids).toEqual([{ id: "m1" }]);
  });

  // `communication.history`'s real return shape (`{campaign_id, node_id,
  // as_of, communications}` — runtime-catalog.ts) is structurally identical
  // to `communication.selection`'s, so it already renders via this same
  // "selection" variant with no code changes needed here.
  it("renders communication.history's real shape via the same selection variant", () => {
    const historyShape = { campaign_id: "c1", node_id: "n1", as_of: "2026-08-07T00:00:00.000Z", communications: [comm({ id: "h1" })] };
    const projection = communicationsScreen.project(historyShape, { width: 80, height: 10 });
    expect(projection.variant).toBe("selection");
    expect(projection.rows[0]).toMatchObject({ id: "h1" });
  });

  it("renders deterministically and bound-by-height", () => {
    const rows = Array.from({ length: 40 }, (_, i) => comm({ id: `m${i}`, kind: "report" }));
    const out = render({ communications: rows }, undefined, 100, 10);
    expect(out.length).toBeLessThanOrEqual(11);
    expect(out).toEqual(render({ communications: rows }, undefined, 100, 10));
  });

  it("sticks to the bounded cursor window — never projects past MAX_ROWS", () => {
    const rows = Array.from({ length: 500 }, (_, i) => comm({ id: `m${i}` }));
    const projection = communicationsScreen.project({ communications: rows }, { width: 100, height: 60 });
    expect(projection.rows.length).toBeLessThanOrEqual(100);
  });

  it("STRUCTURALLY redacts payload for a lower-tier consumer", () => {
    const msg = comm({ capability_tier: "critic" });
    const projection = communicationsScreen.project({ communications: [msg] }, { width: 80, height: 10, consumerTier: "specialist" });
    const row = projection.rows[0];
    expect("content" in row).toBe(false);
    expect("correlation" in row).toBe(false);
    // structural: the field is ABSENT, not blanked to ""
    expect(row.content).toBeUndefined();
  });

  it("includes payload for a same-or-higher-tier consumer", () => {
    const msg = comm({ capability_tier: "critic" });
    const projection = communicationsScreen.project({ communications: [msg] }, { width: 80, height: 10, consumerTier: "orchestrator" });
    const row = projection.rows[0];
    expect("content" in row).toBe(true);
    expect(row.content).toBe("hello world");
  });

  it("surface acknowledgement/retraction records", () => {
    const rows = [
      comm({ id: "m1" }),
      comm({ id: "m2", acknowledges_communication_id: "m1", retracts_communication_id: null }),
      comm({ id: "m3", acknowledges_communication_id: null, retracts_communication_id: "m1" }),
    ];
    const projection = communicationsScreen.project({ communications: rows }, { width: 80, height: 10 });
    const line = render({ communications: rows }, undefined, 120, 10).join("\n");
    expect(projection.rows[1].ack).toBe("yes");
    expect(projection.rows[2].retracts).toBe("yes");
    expect(line).toContain("Communications (3)");
  });

  it("clips widths and Unicode-aware", () => {
    const out = render({ communications: [comm({ id: "m-very-long-identifier-value-here" })] }, undefined, 30, 5);
    for (const line of out) expect(displayWidth(line)).toBeLessThanOrEqual(31);
  });

  it("degrades gracefully on null/unknown/empty", () => {
    expect(() => render(null)).not.toThrow();
    expect(() => render({ weird: 1 })).not.toThrow();
    expect(() => render([])).not.toThrow();
    expect(render(null)[0]).toContain("No communications loaded");
  });

  it("is absent without its capabilities", () => {
    registerScreen(communicationsScreen);
    expect(availableScreens(new Set(["communication.read"])).some((s) => s.id === "communications")).toBe(false);
    expect(availableScreens(new Set(["communication.read", "communication.write"])).some((s) => s.id === "communications")).toBe(true);
  });
});

/**
 * The fixtures above are FLAT. `communication.selection` does not return flat
 * records -- it returns a wrapper per message, `{kind: "node_communication",
 * id, timestamp, communication: {...}}`, with every meaningful field on the
 * inner object. Because no test used that shape, the screen read author,
 * recipient, payload and capability_tier off the wrapper (where they do not
 * exist) and still passed: it rendered `redacted -> redacted` with no content
 * for every message, to every operator, while `bus.ts` showed the same records
 * in full.
 *
 * The record below is copied verbatim from a live
 * `RuntimeCatalogRouter.executeQuery({kind: "communication.selection"})`
 * against a seeded campaign, so this suite now pins the shape the product
 * actually emits.
 */
describe("communications screen — the real communication.selection shape", () => {
  const wrapped = {
    kind: "node_communication",
    id: "communication_3",
    campaign_id: "seed-campaign",
    node_id: "root",
    timestamp: "2026-09-02T17:56:21.163Z",
    previous_hash: "c2dab62f",
    content_hash: "49c7675a",
    communication: {
      author_node_id: "worker",
      recipient_node_id: "root",
      other_recipient_node_ids: [],
      kind: "report",
      payload: { content: "seeded broadcast for surface piloting", provenance: { tag: "claimed", claimant: "worker" } },
      capability_tier: "specialist",
      trigger_turn: false,
      as_of: "2026-09-02T17:56:21.162Z",
      correlation_id: "seed-bus-1",
      idempotency_key: "seed-bus-1",
      acknowledges_communication_id: null,
      retracts_communication_id: null,
      conversation_id: "seed-conversation",
    },
  };

  it("renders the endpoints, message kind and payload an entitled operator is allowed to see", () => {
    const lines = render({ communications: [wrapped], consumer_tier: "orchestrator" }, undefined, 120, 20).join("\n");
    expect(lines).toContain("worker");
    expect(lines).toContain("root");
    expect(lines).toContain("seeded broadcast for surface piloting");
    // The message kind, not the wrapper's "node_communication".
    expect(lines).toContain("report");
    expect(lines).not.toContain("redacted");
  });

  it("takes the consumer tier from the envelope, so an unset screen option cannot redact an entitled operator", () => {
    // No `consumerTier` argument: production never passes one. The envelope's
    // own declared tier must govern.
    const lines = render({ communications: [wrapped], consumer_tier: "orchestrator" }, undefined, 120, 20).join("\n");
    expect(lines).not.toContain("payload structurally unavailable");
  });

  it("still redacts structurally when the envelope was built for a tier that may not read the payload", () => {
    const restricted = { ...wrapped, communication: { ...wrapped.communication, capability_tier: "orchestrator" } };
    const lines = render({ communications: [restricted], consumer_tier: "specialist" }, undefined, 120, 20).join("\n");
    // Structural redaction withholds the PAYLOAD; the endpoints stay visible
    // as routing metadata. Verified against the rendered screen rather than
    // assumed -- an earlier version of this test asserted the endpoints were
    // redacted too, which the product does not do and should not be asked to.
    expect(lines).toContain("payload structurally unavailable to this consumer tier");
    expect(lines).not.toContain("seeded broadcast for surface piloting");
    expect(lines).toContain("worker");
  });
});
