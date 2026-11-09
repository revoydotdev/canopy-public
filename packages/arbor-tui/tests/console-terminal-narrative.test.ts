import { describe, expect, it } from "vitest";
import { initialModel } from "../src/model.js";
import { deriveConsoleActivityNarrative } from "../src/status-bar.js";

function narrative(terminal: unknown, campaigns: readonly unknown[] = []) {
  const app = initialModel();
  return deriveConsoleActivityNarrative({
    ...app,
    screens: new Map(app.screens).set("console", {
      campaigns: { items: campaigns },
      session_attach: { live: false, session: { terminal }, events: [] },
    }),
  });
}

describe("Console terminal outcome narrative", () => {
  it.each([
    ["failed", "Session failed"],
    ["interrupted", "Session interrupted"],
    ["wall_clock_limit", "time limit reached"],
    ["event_limit", "event limit reached"],
    ["unknown", "outcome unavailable"],
  ])("does not call %s a completion", (cause, text) => {
    const result = narrative({ cause });
    expect(result.text).toContain(text);
    expect(result.text).not.toContain("Completion");
    expect(result.active).toBe(false);
  });

  it("does not infer success from a terminal record missing its cause", () => {
    expect(narrative({})).toEqual({ text: "Session ended — outcome unavailable", active: false });
  });

  it("reserves completion wording for completed sessions and retains the halted verification guard", () => {
    expect(narrative({ cause: "completed" })).toEqual({ text: "Completion ready for review", active: false });
    expect(narrative({ cause: "completed" }, [{ halted: true, verified_nodes: 0 }]))
      .toEqual({ text: "Halted — nothing verified", active: false });
  });
});
