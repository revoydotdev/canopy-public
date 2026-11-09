import { describe, expect, it } from "vitest";
import { PILOT_WORKFLOWS, workflowForAction, workflowPaletteActions } from "../src/pilot-workflows.js";
import { buildDefaultCatalog } from "../src/default-catalog.js";
import { installScreens } from "../src/screens/install.js";
import { getScreen } from "../src/screens/screen.js";

describe("pilot workflow catalog", () => {
  it("covers every operator journey family with unique, executable routes", () => {
    installScreens();
    const categories = new Set(PILOT_WORKFLOWS.map((workflow) => workflow.category));
    expect(categories).toEqual(new Set(["project", "plan", "supervise", "intervene", "recover", "delegate", "govern", "integrate", "finish"]));
    expect(new Set(PILOT_WORKFLOWS.map((workflow) => workflow.id)).size).toBe(PILOT_WORKFLOWS.length);
    const actions = new Set(buildDefaultCatalog().actions.map((action) => action.id));
    for (const workflow of PILOT_WORKFLOWS) {
      expect(workflow.title.trim()).not.toBe("");
      expect(workflow.outcome.trim()).not.toBe("");
      if (workflow.route.kind === "screen") expect(getScreen(workflow.route.screen)?.id).toBe(workflow.route.screen);
      if (workflow.route.kind === "action") expect(actions.has(workflow.route.action_id)).toBe(true);
      if (workflow.route.kind === "cli") expect(workflow.route.command).toMatch(/^arbor /);
    }
  });

  it("adds every interactive journey as a resolvable palette alias", () => {
    const interactive = PILOT_WORKFLOWS.filter((workflow) => workflow.route.kind !== "cli");
    const actions = workflowPaletteActions();
    expect(actions).toHaveLength(interactive.length);
    for (const action of actions) expect(workflowForAction(action.id)?.route.kind).not.toBe("cli");
    expect(workflowForAction("workflow:not-real")).toBeNull();
    expect(workflowForAction("focus:projects")).toBeNull();
  });
});
