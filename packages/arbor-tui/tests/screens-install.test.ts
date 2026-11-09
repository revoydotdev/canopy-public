import { describe, it, expect, afterEach } from "vitest";
import { installScreens } from "../src/screens/install.js";
import { clearRegisteredScreens, availableScreens, getScreen, type ScreenId } from "../src/screens/screen.js";

afterEach(() => clearRegisteredScreens());

const ALL_CAPS = new Set([
  "campaign.read", "campaign.write", "tree.read", "tree.write", "tree.interrupt",
  "task.read", "task.retry", "operation.read", "operation.cancel",
  "recovery.read", "recovery.write", "recovery.abandon", "output.read", "output.capture",
  "communication.read", "communication.write", "event.read",
  "config.read", "agent.read", "job.read", "job.write",
  "approval.read", "approval.request", "approval.decide",
  "devtools.read", "telemetry.read",
  "compaction.read", "sibling.read", "surveillance.read", "capability.read", "trust.session.read", "trust.session.write",
  "bus.read", "bus.write",
  "context.read", "fold.write", "fold.approve", "fold.rollback", "playbook.write", "playbook.approve", "harness.write", "harness.approve", "harness.rollback", "harness.evaluate", "harness.promote", "harness.quarantine", "subagent.execute",
  "harness.connector.read",
  "a2a.read", "a2a.write",
  "control.read",
]);

/**
 * The exact screen set offered to a fully-capable operator. Both the
 * "offers screens only when granted" contents check and the registry-closedness
 * count derive from this one list, so adding a screen cannot leave a second
 * hardcoded number behind to go stale.
 */
const FULL_CAP_SCREEN_IDS = [
  "agents", "approvals", "campaigns", "communications", "config", "native-budget", "devtools", "command-history",
  "diagnostics", "jobs", "operations", "output", "tasks", "tree", "recovery", "compaction", "siblings", "surveillance",
  "capabilities", "threads", "bus", "a2a", "overlays", "telemetry", "trust", "harness-connectors", "harness-readiness",
  "harness-evaluations", "control", "console",
].sort();

describe("installed screen composition root", () => {
  it("registers all wired operational screens", () => {
    installScreens();
    for (const id of ["console", "campaigns", "tree", "diagnostics", "tasks", "operations", "output", "communications", "config", "native-budget", "agents", "jobs", "approvals", "interviews", "devtools", "command-history"] as const) {
      expect(getScreen(id).id).toBe(id);
    }
    for (const id of ["compaction", "siblings", "surveillance", "capabilities", "threads", "bus", "a2a", "overlays", "telemetry"] as const) expect(getScreen(id).id).toBe(id);
  });

  it("offers screens only when their required capabilities are granted", () => {
    installScreens();
    // Product surfaces intentionally share the campaign.read projection gate.
    // — tree also needs tree.write, so it stays absent here.
    const partial = availableScreens(new Set(["campaign.read", "tree.read"]));
    expect(partial.map((s) => s.id)).toEqual(["campaigns", "console", "native-budget"]);

    const full = availableScreens(ALL_CAPS);
    const ids = full.map((s) => s.id).sort();
    expect(ids).toEqual(FULL_CAP_SCREEN_IDS);

    const none = availableScreens(new Set([]));
    expect(none).toEqual([]);
  });

  it("never offers a screen whose required capability is absent", () => {
    installScreens();
    // tasks needs task.read; without it, tasks is absent entirely
    const withoutTasks = availableScreens(new Set(ALL_CAPS).difference(new Set(["task.read"])));
    expect(withoutTasks.some((s) => s.id === ("tasks" as ScreenId))).toBe(false);
    // communications needs both read+write; drop write → absent
    const withoutCommWrite = availableScreens(new Set(ALL_CAPS).difference(new Set(["communication.write"])));
    expect(withoutCommWrite.some((s) => s.id === ("communications" as ScreenId))).toBe(false);
    const readOnlyRecovery = availableScreens(new Set(["recovery.read"]));
    expect(readOnlyRecovery.map((screen) => screen.id)).toContain("recovery");
  });

  it("fails fast on double registration — the registry is a closed catalog", () => {
    installScreens();
    // registerScreen throws on duplicate id (closed-catalog discipline); re-installing would collide
    expect(() => installScreens()).toThrow(/already registered/);
    expect(availableScreens(ALL_CAPS).length).toBe(FULL_CAP_SCREEN_IDS.length);
  });

  it("screen surfaces only issue catalog-supported commands/queries", () => {
    installScreens();
    const catalogCommands = new Set(["campaign.start", "campaign.halt", "tree.branch", "tree.prune", "tree.interrupt", "operation.cancel", "task.retry", "recovery.retry", "recovery.abandon", "communication.record", "output.capture", "surveillance.scan", "bus.thread.send", "bus.thread.ack", "bus.record", "compaction.record", "a2a.send", "a2a.receive", "fold.propose", "fold.approve", "fold.rollback", "playbook.propose", "playbook.approve", "harness.propose", "harness.approve", "harness.rollback", "harness.evaluate", "harness.evaluation.start", "harness.promote", "harness.quarantine", "trust.session.enroll", "trust.session.rotate", "trust.session.revoke", "subagent.execute", "job.submit", "job.cancel", "job.retry", "job.pause", "job.resume", "approval.request", "approval.approve", "approval.reject", "approval.expire", "taskcomposer.submit", "harness.session.steer", "harness.session.interrupt"]);
    const catalogQueries = new Set(["campaign.list", "campaign.snapshot", "campaign.tree", "operation.get", "operation.list", "recovery.pending", "task.list", "event.resume", "communication.selection", "communication.history", "output.descriptor", "output.list", "output.raw", "surveillance.findings", "capability.introspect", "compaction.list", "compaction.guard", "sibling.status", "bus.thread.history", "bus.history", "a2a.cards", "context.overlays", "context.governance", "subagent.executions", "harness.evaluation.candidates", "harness.evaluation.runs", "harness.evaluation.detail", "harness.connector.inventory", "harness.native.readiness", "trust.session.list", "trust.session.status", "governance.snapshot", "config.get", "native.budget.get", "agent.list", "job.list", "approval.list", "userinput.list", "userinput.awaiting", "devtools.stream", "control.status", "control.discover", "control.inbox",
      // WA-55: Console's real `refreshProductSurface` composite fetch (packages/arbor-mcp/src/tui.ts).
      "taskcomposer.list", "doctor.get", "migration.inspect", "integration.list", "remote.inspect", "scheduler.inspect", "notification.list", "session.identity.search", "result.verification.list", "followup.list", "result.list", "result.inspect", "governance.backlog", "harness.session.list", "harness.session.availability", "harness.session.inspect", "harness.session.events", "harness.session.attach"]);
    for (const screen of availableScreens(ALL_CAPS)) {
      for (const command of screen.surface.commands) expect(catalogCommands.has(command)).toBe(true);
      for (const query of screen.surface.queries) expect(catalogQueries.has(query)).toBe(true);
    }
  });
});
