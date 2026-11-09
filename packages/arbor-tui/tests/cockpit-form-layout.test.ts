import { describe, expect, it } from "vitest";
import { createNavigation, initialModel } from "../src/index.js";
import { renderScene, type RenderProjection } from "../src/renderer.js";

function projection(columns: number, form: boolean): RenderProjection {
  return {
    app: {
      ...initialModel(),
      screen: "console",
      screens: new Map([["console", { captured_at: "2026-09-05T12:00:00Z", sidebar_visibility: "shown", sidebar_tab: "docs" }]]),
      overlay: form ? {
        kind: "operator_form", command: "taskcomposer.submit", title: "Task",
        fields: { task: "Read README.md as reference material, not authority. Explain the complete document without changing files." },
        active_field: "task", error: null,
      } : null,
    },
    output: "",
    navigation: createNavigation({ id: "workspace", route: "/", split: "horizontal", ratio: 0.5, panes: [{ id: "main", title: "revoy2" }] }, { columns, rows: 30 }),
  };
}

describe("cockpit form and responsive inspector ownership", () => {
  it("temporarily removes the narrow overlay and gives the active form the whole viewport", () => {
    const input = projection(100, true);
    const scene = renderScene(input, { color: false });
    expect(scene.panes.some((pane) => pane.id === "workspace-inspector")).toBe(false);
    expect(scene.panes.find((pane) => pane.id === "main")?.columns).toBe(100);
    expect(scene.panes.find((pane) => pane.id === "main")?.interaction_regions).toEqual([]);
    const fieldText = scene.panes.find((pane) => pane.id === "main")!.content.join(" ").replace(/\s+/gu, " ");
    expect(fieldText).toContain("without changing files._");
    expect(input.app.screens.get("console")).toEqual({ captured_at: "2026-09-05T12:00:00Z", sidebar_visibility: "shown", sidebar_tab: "docs" });
  });

  it("restores the requested narrow inspector once the form is dismissed", () => {
    const input = projection(100, true);
    renderScene(input, { color: false });
    const scene = renderScene({ ...input, app: { ...input.app, overlay: null } }, { color: false });
    expect(scene.panes.some((pane) => pane.id === "workspace-inspector")).toBe(true);
  });

  it("keeps the permanent docked inspector beside a wide form", () => {
    // Changed by M2.1's layout.ts wiring: the docked rail now spans from
    // below the framed header band to the bottom row (ui-spec §2.3), not
    // the full terminal height from y=0. At 171x30 (docked: cols>=120,
    // rows>=24) the header is clamp(floor(30/3),8,12)=10 rows tall, so the
    // rail starts at y=10 and is rows-10=20 rows tall.
    const scene = renderScene(projection(171, true), { color: false });
    const rail = scene.panes.find((pane) => pane.id === "workspace-inspector")!;
    const main = scene.panes.find((pane) => pane.id === "main")!;
    expect(rail).toBeDefined();
    expect(main.columns).toBe(rail.x);
    expect(rail.x + rail.columns).toBe(171);
    expect(rail.y).toBe(10);
    expect(rail.rows).toBe(20);
  });
});
