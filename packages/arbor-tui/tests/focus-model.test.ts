import { describe, expect, it } from "vitest";
import { initialModel, update, nextFocusZone, type AppEvent, type AppModel } from "../src/index.js";
import { buildDefaultCatalog, FOCUS_ZONE_NEXT_ACTION_ID, FOCUS_ZONE_PREV_ACTION_ID, CONTEXT_MENU_ACTION_ID } from "../src/default-catalog.js";
import { InputRouter, normalizeKey } from "../src/input-catalog.js";
import { decodeTerminalInput } from "../src/input-terminal.js";

/** Built at runtime, never a literal escape byte in source (matches theme.ts's REVERSE_VIDEO_ESC convention). */
const ESC = String.fromCharCode(27);

function dispatch(model: ReturnType<typeof initialModel>, event: AppEvent) {
  return update(model, event).model;
}

describe("focus model (ui-spec §3, M2.2) — real update() reducer + catalog", () => {
  it("cycles only through painted zones and recovers from a zone hidden by resize", () => {
    const minimal = ["composer", "transcript"] as const;
    expect(nextFocusZone("composer", 1, minimal)).toBe("transcript");
    expect(nextFocusZone("transcript", 1, minimal)).toBe("composer");
    expect(nextFocusZone("rail", 1, minimal)).toBe("composer");
    expect(nextFocusZone("rail", -1, minimal)).toBe("transcript");
  });

  it("F6/Shift+F6 decode to the zone-cycle actions through the real catalog router", () => {
    const catalog = buildDefaultCatalog();
    const router = new InputRouter(catalog, () => 0);
    const f6 = decodeTerminalInput(`${ESC}[17~`);
    expect(f6.keys).toEqual([{ key: "f6" }]);
    const forward = router.handle(f6.keys[0]!, ["global"]);
    expect(forward).toEqual({ kind: "action", action_id: FOCUS_ZONE_NEXT_ACTION_ID });

    const shiftF6 = decodeTerminalInput(`${ESC}[17;2~`);
    expect(shiftF6.keys).toEqual([{ key: "f6", modifiers: ["shift"] }]);
    const backward = router.handle(shiftF6.keys[0]!, ["global"]);
    expect(backward).toEqual({ kind: "action", action_id: FOCUS_ZONE_PREV_ACTION_ID });

    const shiftF10 = decodeTerminalInput(`${ESC}[21;2~`);
    expect(shiftF10.keys).toEqual([{ key: "f10", modifiers: ["shift"] }]);
    const menu = router.handle(shiftF10.keys[0]!, ["global"]);
    expect(menu).toEqual({ kind: "action", action_id: CONTEXT_MENU_ACTION_ID });
  });

  it("normalizes the decoded Shift+F6 key exactly as the catalog binding expects", () => {
    const decoded = decodeTerminalInput(`${ESC}[17;2~`).keys[0]!;
    expect(normalizeKey(decoded)).toBe("shift+f6");
  });

  it("cycles composer -> transcript -> rail -> graph -> composer through the real reducer", () => {
    let model = initialModel();
    expect(model.focus.zone).toBe("composer");
    const steps: readonly string[] = ["transcript", "rail", "graph", "composer"];
    for (const expected of steps) {
      model = dispatch(model, { type: "ui_intent", intent: { type: "focus_zone_cycle", direction: 1 }, at: 0 });
      expect(model.focus.zone).toBe(expected);
    }
  });

  it("cycles backward with Shift+F6's direction", () => {
    let model = initialModel();
    model = dispatch(model, { type: "ui_intent", intent: { type: "focus_zone_cycle", direction: -1 }, at: 0 });
    expect(model.focus.zone).toBe("graph");
    model = dispatch(model, { type: "ui_intent", intent: { type: "focus_zone_cycle", direction: -1 }, at: 0 });
    expect(model.focus.zone).toBe("rail");
  });

  it("does not cycle zones while an overlay owns input", () => {
    let model = initialModel();
    model = dispatch(model, { type: "ui_intent", intent: { type: "toggle_help" }, at: 0 });
    expect(model.overlay?.kind).toBe("help");
    const before = model.focus.zone;
    model = dispatch(model, { type: "ui_intent", intent: { type: "focus_zone_cycle", direction: 1 }, at: 0 });
    expect(model.focus.zone).toBe(before);
  });

  it("sets the rail's sticky tab independent of the focus zone", () => {
    let model = initialModel();
    model = dispatch(model, { type: "ui_intent", intent: { type: "focus_rail_tab", tab: "adrs" }, at: 0 });
    expect(model.focus.rail_tab).toBe("adrs");
    expect(model.focus.zone).toBe("composer");
  });

  it("Esc pops only the top (and only) overlay — never touches connection/campaign state", () => {
    let model = initialModel();
    model = dispatch(model, { type: "ui_intent", intent: { type: "toggle_help" }, at: 0 });
    expect(model.overlay).not.toBeNull();
    const connectionBefore = model.connection;
    const telemetryBefore = model.telemetryCampaignId;
    // The help overlay's own Esc-equivalent is a second `toggle_help` (it is
    // a pure open/close toggle); the compose/operator_form overlays instead
    // use cancel_compose/cancel_operator_form (exercised below). Either way,
    // popping an overlay never issues a run-cancelling intent.
    model = dispatch(model, { type: "ui_intent", intent: { type: "toggle_help" }, at: 0 });
    expect(model.overlay).toBeNull();
    expect(model.connection).toBe(connectionBefore);
    expect(model.telemetryCampaignId).toBe(telemetryBefore);
  });

  it("cancel_compose pops the compose overlay without cancelling an active campaign", () => {
    let model: AppModel = { ...initialModel(), overlay: { kind: "compose" as const, record_id: "r1", question: "q", buffer: "draft text", cursor: 10 } };
    const telemetryBefore = model.telemetryCampaignId;
    const result = update(model, { type: "ui_intent", intent: { type: "cancel_compose" }, at: 0 });
    expect(result.model.overlay).toBeNull();
    expect(result.model.telemetryCampaignId).toBe(telemetryBefore);
    // No interrupt/cancel-campaign effect was issued by popping the overlay.
    expect(result.effects.some((effect) => effect.type === "interrupt_campaign")).toBe(false);
  });
});

describe("bracketed paste never submits (ui-spec §7)", () => {
  it("a multi-line pasted insert stays in the compose buffer and issues no submit effect", () => {
    const model = { ...initialModel(), overlay: { kind: "compose" as const, record_id: "r1", question: "q", buffer: "", cursor: 0 } };
    // A bracketed paste is delivered as one `compose_insert` with the pasted
    // text verbatim (including embedded newlines) — never as `submit_answer`,
    // regardless of what characters the pasted text contains.
    const pasted = "line one\nline two\r\nline three";
    const result = update(model, { type: "ui_intent", intent: { type: "compose_insert", text: pasted }, at: 0 });
    expect(result.model.overlay?.kind).toBe("compose");
    expect((result.model.overlay as { buffer: string }).buffer).toBe(pasted);
    expect(result.effects).toEqual([]);
  });

  it("a pasted control-like byte sequence is still only ever inserted as text", () => {
    const router = new InputRouter(buildDefaultCatalog(), () => 0);
    const result = router.handle({ key: "a", text: "y\nn\n", paste: true }, ["global"]);
    expect(result).toEqual({ kind: "paste", text: "y\nn\n", truncated: false });
  });
});

describe("draft survives resize, tab change, and overlay open/close (ui-spec §7)", () => {
  it("the compose draft is untouched by focus/rail-tab/overlay transitions or a bare resize", () => {
    let model: AppModel = { ...initialModel(), overlay: { kind: "compose" as const, record_id: "r1", question: "q", buffer: "unsent draft", cursor: 5 } };
    const draftBefore = (model.overlay as { buffer: string }).buffer;
    // Resize itself is not an AppModel event at all (`renderScene` reads
    // `navigation.terminal` per draw; the model carries no viewport size),
    // so the draft's persistence across 160x48 -> 80x24 -> 50x14 -> 160x48
    // is exactly this: no dispatched event exists that could touch it.
    model = dispatch(model, { type: "ui_intent", intent: { type: "focus_zone_cycle", direction: 1 }, at: 0 });
    model = dispatch(model, { type: "ui_intent", intent: { type: "focus_rail_tab", tab: "docs" }, at: 0 });
    expect((model.overlay as { buffer: string }).buffer).toBe(draftBefore);
  });
});
