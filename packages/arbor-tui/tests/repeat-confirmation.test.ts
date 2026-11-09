import { describe, expect, it } from "vitest";
import { initialModel, renderStatusBar, update } from "../src/index.js";

describe("interrupt/cancel repeat confirmation", () => {
  it("arms visibly, fires on two presses, ignores a third, and clears by token", () => {
    const first = update(initialModel(), { type: "ui_intent", intent: { type: "interrupt_active_campaign" }, at: 100 });
    expect(first.effects).toEqual([{ type: "schedule_repeat_confirmation_clear", token: "interrupt:active-campaign:100", at: 2100 }]);
    expect(renderStatusBar(first.model, { columns: 120 })).toContain("press again to interrupt");

    const second = update(first.model, { type: "ui_intent", intent: { type: "interrupt_active_campaign" }, at: 200 });
    expect(second.effects).toEqual([{ type: "interrupt_campaign" }]);
    expect(second.model.repeatConfirmation?.fired).toBe(true);
    expect(update(second.model, { type: "ui_intent", intent: { type: "interrupt_active_campaign" }, at: 300 }).effects).toEqual([]);

    const stale = update(second.model, { type: "repeat_confirmation_elapsed", token: "wrong" });
    expect(stale.model.repeatConfirmation).not.toBeNull();
    expect(update(second.model, { type: "repeat_confirmation_elapsed", token: "interrupt:active-campaign:100" }).model.repeatConfirmation).toBeNull();
  });

  it("re-arms after the window rather than executing the expired action", () => {
    const first = update(initialModel(), { type: "ui_intent", intent: { type: "interrupt_active_campaign" }, at: 100 });
    const expired = update(first.model, { type: "ui_intent", intent: { type: "interrupt_active_campaign" }, at: 2101 });
    expect(expired.effects).toEqual([{ type: "schedule_repeat_confirmation_clear", token: "interrupt:active-campaign:2101", at: 4101 }]);
    expect(expired.model.repeatConfirmation?.fired).toBe(false);
  });
});
