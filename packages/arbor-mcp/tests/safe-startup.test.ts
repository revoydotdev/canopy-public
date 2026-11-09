import { describe, expect, it } from "vitest";
import { SafeStartupController, planSafeStartup, type SafeStartupParticipant } from "../src/safe-startup.js";

const participants: readonly SafeStartupParticipant[] = [
  { id: "governance.audit", kind: "governance", trust: "builtin" },
  { id: "native.core", kind: "integration", trust: "builtin" },
  { id: "plugin.untrusted", kind: "integration", trust: "untrusted" },
  { id: "project.hooks", kind: "customization", trust: "trusted" },
];

describe("safe-mode startup", () => {
  it("keeps governance and required built-ins while excluding untrusted integrations and customizations", () => {
    const plan = planSafeStartup(participants, true);
    expect(plan.active.map((participant) => participant.id)).toEqual(["governance.audit", "native.core"]);
    expect(plan.skipped.map(({ participant, reason }) => `${participant.id}:${reason}`)).toEqual([
      "plugin.untrusted:untrusted_integration",
      "project.hooks:customization",
    ]);
    expect(plan.diagnostics[0]).toMatchObject({ code: "safe_mode_active" });
  });

  it("starts only the safe participant set and emits actionable diagnostics", async () => {
    const events: string[] = [];
    const controller = new SafeStartupController(participants.map((participant) => ({
      ...participant,
      start: () => { events.push(`start:${participant.id}`); },
      close: () => { events.push(`close:${participant.id}`); },
    })), true);
    await controller.start();
    await controller.close();
    expect(events).toEqual(["start:governance.audit", "start:native.core", "close:native.core", "close:governance.audit"]);
    expect(controller.diagnostics().map((diagnostic) => diagnostic.code)).toContain("participant_started");
    expect(controller.diagnostics().map((diagnostic) => diagnostic.code)).toContain("participant_closed");
  });

  it("fails closed and rolls back already-started participants", async () => {
    const events: string[] = [];
    const controller = new SafeStartupController([
      { id: "governance.audit", kind: "governance", trust: "builtin", start: () => { events.push("start:governance"); }, close: () => { events.push("close:governance"); } },
      { id: "native.core", kind: "integration", trust: "builtin", start: () => { throw new Error("broken native"); } },
    ], true);
    await expect(controller.start()).rejects.toThrow("broken native");
    expect(events).toEqual(["start:governance", "close:governance"]);
    expect(controller.diagnostics()).toContainEqual(expect.objectContaining({ code: "participant_start_failed", participant_id: "native.core" }));
  });
});
