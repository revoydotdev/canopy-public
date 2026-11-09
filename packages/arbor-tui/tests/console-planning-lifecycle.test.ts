import { describe, expect, it } from "vitest";
import { initialModel } from "../src/model.js";
import { consoleScreen } from "../src/screens/console.js";
import { deriveConsoleActivityNarrative } from "../src/status-bar.js";

function snapshot(status: string) {
  return {
    captured_at: "2026-09-05T09:00:00.000Z",
    fresh_launch_planning: true,
    drafts: { items: [{ id: "draft-live-transition", task: "Build the observatory site", status }] },
    campaigns: { items: [] },
    sidebar_visibility: "hidden",
  };
}

describe("Console planning lifecycle", () => {
  it("leaves planning on a failed refresh without requiring a new model or restart", () => {
    const app = initialModel();
    const size = { width: 120, height: 24 };
    const before = snapshot("planning");
    expect(consoleScreen.project(before, size).variant).toBe("planning");
    expect(deriveConsoleActivityNarrative({ ...app, screens: new Map(app.screens).set("console", before) }).active).toBe(true);
    const after = {
      ...snapshot("failed"),
      session_attach: { live: false, session: { terminal: { cause: "failed" } }, events: [] },
    };
    const projection = consoleScreen.project(after, size);
    expect(projection.variant).not.toBe("planning");
    expect(consoleScreen.render({ projection, ...size }).join("\n")).not.toContain("Planning your request");
    expect(deriveConsoleActivityNarrative({ ...app, screens: new Map(app.screens).set("console", after) }))
      .toEqual({ text: "Session failed — review the error before retrying", active: false });
  });

  it.each(["failed", "cancelled", "rejected", "proposed", "awaiting_clarification"])("does not advertise %s as active planning", (status) => {
    const app = initialModel();
    const raw = snapshot(status);
    expect(consoleScreen.project(raw, { width: 120, height: 24 }).variant).not.toBe("planning");
    expect(deriveConsoleActivityNarrative({ ...app, screens: new Map(app.screens).set("console", raw) }).text)
      .not.toBe("Planning your request");
  });
});
