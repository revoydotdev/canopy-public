import { describe, expect, it } from "vitest";
import {
  buildDefaultCatalog, applyKeymapOverrides, screenForAction, HELP_ACTION_ID,
  INTERRUPT_ACTION_ID, STOP_AND_EXIT_ACTION_ID, ANSWER_ACTION_ID, APPROVE_ACTION_ID, APPROVE_SESSION_ACTION_ID, APPROVE_PERSISTENT_ACTION_ID, REJECT_ACTION_ID,
  CAMPAIGN_HALT_ACTION_ID, JOB_SUBMIT_ACTION_ID, APPROVAL_REQUEST_ACTION_ID,
  USERINPUT_ASK_ACTION_ID, COMMUNICATION_RECORD_ACTION_ID, OUTPUT_CAPTURE_ACTION_ID,
  OUTPUT_RAW_ACTION_ID,
  ATTACH_HARNESS_SESSION_ACTION_ID, STEER_HARNESS_SESSION_ACTION_ID,
  RESUME_HARNESS_SESSION_ACTION_ID, FORK_HARNESS_SESSION_ACTION_ID, RESPAWN_HARNESS_SESSION_ACTION_ID,
} from "../src/default-catalog.js";
import { InputRouter, catalogConflicts } from "../src/input-catalog.js";
import { renderPaletteRows } from "../src/overlays.js";
import { availableScreens, clearRegisteredScreens } from "../src/screens/screen.js";
import { installScreens } from "../src/screens/install.js";

describe("buildDefaultCatalog", () => {
  it("produces a conflict-free catalog covering every registered screen", () => {
    clearRegisteredScreens();
    installScreens();
    try {
      const catalog = buildDefaultCatalog();
      expect(catalogConflicts(catalog)).toEqual([]);
      // Every screen actually offered by the registry (all but "telemetry",
      // which has no ScreenModule yet) has a default navigation action.
      for (const screen of availableScreens(new Set())) {
        expect(catalog.actions.some((action) => screenForAction(action.id) === screen.id)).toBe(true);
      }
      expect(new InputRouter(catalog, () => 0)).toBeInstanceOf(InputRouter);
    } finally {
      clearRegisteredScreens();
    }
  });

  it("routes every operator-authored command to a discoverable form action", () => {
    const router = new InputRouter(buildDefaultCatalog(), () => 0);
    const expected = [
      ["h", CAMPAIGN_HALT_ACTION_ID], ["s", JOB_SUBMIT_ACTION_ID], ["q", APPROVAL_REQUEST_ACTION_ID],
      ["u", USERINPUT_ASK_ACTION_ID], ["f", COMMUNICATION_RECORD_ACTION_ID], ["o", OUTPUT_CAPTURE_ACTION_ID], ["~", OUTPUT_RAW_ACTION_ID],
    ] as const;
    for (const [key, action_id] of expected) {
      expect(router.handle({ key }, ["global"])).toEqual({ kind: "action", action_id });
    }
  });

  it("routes a navigation keypress to its screen via screenForAction", () => {
    const catalog = buildDefaultCatalog();
    const router = new InputRouter(catalog, () => 0);
    const result = router.handle({ key: "t" }, ["global"]);
    expect(result).toEqual({ kind: "action", action_id: "focus:tree" });
    expect(result.kind === "action" ? screenForAction(result.action_id) : null).toBe("tree");
  });

  it("makes the local workflow discoverable through the same routed help entries", () => {
    const catalog = buildDefaultCatalog();
    const router = new InputRouter(catalog, () => 0);
    const routes = [
      ["t", "tree"], [":", "threads"], ["0", "approvals"],
      ["w", "recovery"], ["4", "output"], ["v", "audit"],
    ] as const;
    for (const [key, screen] of routes) {
      const result = router.handle({ key }, ["global"]);
      expect(result.kind === "action" ? screenForAction(result.action_id) : null).toBe(screen);
    }

    const help = renderPaletteRows(catalog, { width: 200, limit: 200 }).map((row) => row.plain).join("\n");
    expect(help).toContain("appear after approved plan submission");
    expect(help).toContain("select a non-root node before opening its thread");
    expect(help).toContain("independent deciders");
    expect(help).toContain("durable evidence ledger");
  });

  it("keeps specialist peer views reachable while describing them as contextual inspectors, not competing dashboards", () => {
    const catalog = buildDefaultCatalog();
    for (const screen of ["devtools", "diagnostics", "telemetry", "harness-sessions", "siblings", "bus", "a2a", "overlays", "kb"] as const) {
      const action = catalog.actions.find((candidate) => candidate.id === `focus:${screen}`);
      expect(action).toBeDefined();
      expect(action!.description).toContain("context");
    }
    // 40, not 43: dashboard/cockpit/projects were folded into Console (ADR-149 Decision 7).
    expect(catalog.actions.filter((candidate) => candidate.id.startsWith("focus:")).length).toBe(40);
  });

  it("routes the help keypress to the help action, which is not a navigation action", () => {
    const catalog = buildDefaultCatalog();
    const router = new InputRouter(catalog, () => 0);
    const result = router.handle({ key: "?" }, ["global"]);
    expect(result).toEqual({ kind: "action", action_id: HELP_ACTION_ID });
    expect(result.kind === "action" ? screenForAction(result.action_id) : "not-null").toBeNull();
  });

  // A-3 remediation: the operator command-surface controls must be real,
  // discoverable catalog actions — not hardcoded strings the keyboard loop
  // special-cases invisibly. "!" was previously unbound; "a"/"y"/"n" were
  // never claimed by any screen-nav default, so none of these collide.
  it("routes stop-and-exit, interrupt, answer, approve, and reject keypresses to real, non-navigation catalog actions", () => {
    const catalog = buildDefaultCatalog();
    const router = new InputRouter(catalog, () => 0);
    expect(router.handle({ key: "c", modifiers: ["ctrl"] }, ["global"])).toEqual({ kind: "action", action_id: STOP_AND_EXIT_ACTION_ID });
    expect(router.handle({ key: "!" }, ["global"])).toEqual({ kind: "action", action_id: INTERRUPT_ACTION_ID });
    expect(router.handle({ key: "a" }, ["global"])).toEqual({ kind: "action", action_id: ANSWER_ACTION_ID });
    expect(router.handle({ key: "y" }, ["global"])).toEqual({ kind: "action", action_id: APPROVE_ACTION_ID });
    expect(router.handle({ key: "y", modifiers: ["shift"] }, ["global"])).toEqual({ kind: "action", action_id: APPROVE_SESSION_ACTION_ID });
    expect(router.handle({ key: "y", modifiers: ["alt"] }, ["global"])).toEqual({ kind: "action", action_id: APPROVE_PERSISTENT_ACTION_ID });
    expect(router.handle({ key: "n" }, ["global"])).toEqual({ kind: "action", action_id: REJECT_ACTION_ID });
    for (const id of [STOP_AND_EXIT_ACTION_ID, INTERRUPT_ACTION_ID, ANSWER_ACTION_ID, APPROVE_ACTION_ID, APPROVE_SESSION_ACTION_ID, APPROVE_PERSISTENT_ACTION_ID, REJECT_ACTION_ID]) {
      expect(screenForAction(id)).toBeNull(); // not a screen-nav action
      const action = catalog.actions.find((a) => a.id === id)!;
      expect(action.source).toBe("command");
      expect(action.description.length).toBeGreaterThan(0); // surfaced in the help/palette overlay
    }
    const stopAndExit = catalog.actions.find((action) => action.id === STOP_AND_EXIT_ACTION_ID)!;
    expect(stopAndExit.title).toBe("Stop active work and exit");
    expect(stopAndExit.description).toContain("active expanding node");
    expect(stopAndExit.description).toContain("not a detach");
  });

  it("keeps harness recovery controls governed but palette-only when raw terminal input cannot represent Ctrl+Shift", () => {
    const catalog = buildDefaultCatalog();
    for (const id of [ATTACH_HARNESS_SESSION_ACTION_ID, STEER_HARNESS_SESSION_ACTION_ID, RESUME_HARNESS_SESSION_ACTION_ID, FORK_HARNESS_SESSION_ACTION_ID, RESPAWN_HARNESS_SESSION_ACTION_ID]) {
      const action = catalog.actions.find((candidate) => candidate.id === id)!;
      expect(action.bindings).toEqual([]);
      expect(action.description).toContain("Help palette");
      expect(action.source).toBe("command");
    }
    const help = renderPaletteRows(catalog, { width: 200, limit: 200 }).map((row) => row.plain).join("\n");
    expect(help).toContain("Attach Harness Session Tail");
    expect(help).toContain("Steer Attached Harness Session");
    expect(help).toContain("Resume Harness Session");
    expect(help).toContain("Fork Harness Session");
    expect(help).toContain("Respawn Harness Session");
    expect(help).not.toContain("ctrl+shift+h");
    expect(help).not.toContain("ctrl+shift+s");
    expect(help).not.toContain("ctrl+shift+g");
    expect(help).not.toContain("ctrl+shift+d");
    expect(help).not.toContain("ctrl+shift+b");
  });
});

describe("applyKeymapOverrides", () => {
  it("replaces a matched action's binding and reports unmatched overrides", () => {
    const catalog = buildDefaultCatalog();
    const { catalog: overridden, unmatched } = applyKeymapOverrides(catalog, [
      { description: "campaigns", keys: ["ctrl+shift+c"] },
      { description: "not a real action", keys: ["x"] },
    ]);
    const campaigns = overridden.actions.find((a) => a.id === "focus:campaigns")!;
    expect(campaigns.bindings).toEqual([{ scope: "global", keys: ["ctrl+shift+c"], description: "campaigns" }]);
    expect(unmatched).toEqual(["not a real action"]);
    // Untouched actions keep their default binding.
    const devtools = overridden.actions.find((a) => a.id === "focus:devtools")!;
    expect(devtools.bindings[0].keys).toEqual(["d"]);
  });

  it("keeps the overridden catalog conflict-free when the override key is genuinely unique", () => {
    const catalog = buildDefaultCatalog();
    const { catalog: overridden } = applyKeymapOverrides(catalog, [{ description: "help", keys: ["ctrl+h"] }]);
    expect(catalogConflicts(overridden)).toEqual([]);
  });
});
