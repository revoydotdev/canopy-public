import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeadlessHarness, harnessSessionsScreen } from "@arbor/tui";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { RuntimePortAdapter } from "../src/tui-adapter.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function harness(runtime: ArborRuntime): HeadlessHarness {
  return new HeadlessHarness({
    client: { connect: () => {}, disconnect: () => {}, requestSnapshot: () => {}, close: () => {}, interruptCampaign: () => {} },
    terminal: { restore: () => {} },
    clock: { now: () => 1 },
    telemetrySource: { fetch: async () => ({ campaign_id: "campaign", source_record_count: 0, counters: [], phase_histograms: [], usage_cost: [], context_economy: [], tool_economy: [] }) },
    runtime: new RuntimePortAdapter(new RuntimeCatalogRouter(runtime)) as never,
  });
}

describe("durable native-session restart reconciliation", () => {
  it("derives a redacted recovery-required checkpoint without replaying provider or tool work", async () => {
    const persistence_dir = mkdtempSync(join(tmpdir(), "arbor-harness-restart-"));
    dirs.push(persistence_dir);
    const beforeCrash = new ArborRuntime({ persistence_dir });
    beforeCrash.harnessSessions!.recordStarted({
      session_id: "crashed-native", campaign_id: "campaign", node_id: "node", operation: "specialize",
      connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "documentation-writer",
      state: "running", latest_sequence: 7,
    });
    const journalFile = join(persistence_dir, "harness-sessions.ndjson");
    const beforeRestart = readFileSync(journalFile, "utf8");

    // Construction is the simulated process restart. It has no live executor,
    // model port, tool port, or credential lease to call.
    const restarted = new ArborRuntime({ persistence_dir });
    const router = new RuntimeCatalogRouter(restarted);
    const expectedRecovery = {
      kind: "recovery_required", reason: "started_without_terminal", automatic_replay: false,
      checkpoint: { state: "running", latest_sequence: 7 },
    };

    expect(restarted.nativeSessionRegistry.list()).toEqual([]);
    expect(restarted.inspectHarnessSession("crashed-native")).toMatchObject({
      session_id: "crashed-native", state: "interrupted", terminal: null, recovery: expectedRecovery,
    });
    expect(restarted.harnessSessionEvents("crashed-native")).toEqual([]);
    // Reconciliation is a derived read model, never an auto-written terminal
    // record or hidden retry side effect.
    expect(readFileSync(journalFile, "utf8")).toBe(beforeRestart);

    expect(router.executeQuery({ schema_version: 1, query_id: "restart-list", query: { kind: "harness.session.list", limit: 20 } })).toMatchObject({
      ok: true, value: { sessions: [expect.objectContaining({ session_id: "crashed-native", recovery: expectedRecovery })] },
    });
    expect(router.executeQuery({ schema_version: 1, query_id: "restart-inspect", query: { kind: "harness.session.inspect", session_id: "crashed-native" } })).toMatchObject({
      ok: true, value: expect.objectContaining({ state: "interrupted", terminal: null, recovery: expectedRecovery }),
    });
    expect(await router.dispatchCommand({
      schema_version: 1,
      metadata: { operation_id: "no-live-interrupt", idempotency_key: "no-live-interrupt", actor_id: "operator", requested_at: "2026-08-09T00:00:00.000Z", session: {} },
      command: { kind: "harness.session.interrupt", session_id: "crashed-native", reason: "operator observes stale checkpoint", provenance: { tag: "generated", generator: "test", input_hash: "sha256:restart" } },
    })).toMatchObject({ ok: false, error: { code: "unavailable" } });

    const ui = harness(restarted);
    await ui.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "harness-sessions" }, at: 1 });
    await ui.dispatch({ type: "ui_intent", intent: { type: "issue_query", queryId: "restart-sessions", request: { kind: "harness.session.list", query_id: "restart-sessions", params: { limit: 20 } } }, at: 2 });
    expect(harnessSessionsScreen.project(ui.model.screens.get("harness-sessions"), { width: 120, height: 20 })).toMatchObject({
      rows: [expect.objectContaining({ id: "crashed-native", state: "interrupted", recovery: "required" })],
    });
  });

  it("previews then durably classifies an expanding node after a hard process loss without replaying work", () => {
    const persistence_dir = mkdtempSync(join(tmpdir(), "arbor-hard-crash-restart-")); dirs.push(persistence_dir);
    const first = new ArborRuntime({ persistence_dir });
    first.manager.startCampaign("hard-crash", "plan.md", { description: "resume me", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed" });
    const root = first.manager.getCampaignSnapshot("hard-crash")!.root_id;
    const node = first.manager.branch("hard-crash", root, [{ description: "resume me", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed" }])[0]!;
    first.manager.expandNode("hard-crash", node, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
    first.harnessSessions!.recordStarted({ session_id: "lost-worker", campaign_id: "hard-crash", node_id: node, operation: "specialize", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "architect", state: "running", latest_sequence: 0 });
    for (const phase of ["prepared", "dispatched"] as const) first.harnessSessions!.recordOperationCheckpoint({ session_id: "lost-worker", operation_id: "provider-1", operation_kind: "provider", operation: "reference-model", phase, effect_kind: "provider", repeatable: false, idempotency_key_hash: null, acknowledged_by: null, outcome: null, effect: null, compensation_id: null, occurred_at: "2026-08-22T00:00:00.000Z" });

    const restarted = new ArborRuntime({ persistence_dir });
    expect(restarted.manager.getNodeInfo("hard-crash", node)?.state).toBe("expanding");
    expect(restarted.sessionContinuationRequirements("lost-worker")).toEqual([expect.objectContaining({ operation_id: "provider-1", classification: "indeterminate" })]);
    expect(restarted.sessionContinuationAvailability("lost-worker").resume).toBe(false);
    expect(restarted.reconcileHarnessSessionCrash("lost-worker", false)).toMatchObject({ ok: true, applied: false });
    expect(restarted.manager.getNodeInfo("hard-crash", node)?.state).toBe("expanding");
    expect(restarted.reconcileHarnessSessionCrash("lost-worker", true)).toMatchObject({ ok: true, applied: true });
    expect(restarted.manager.getNodeInfo("hard-crash", node)?.state).toBe("interrupted");
    expect(restarted.manager.getAuditRecords("hard-crash").filter((record) => record.kind === "interruption")).toHaveLength(3);
    expect(new ArborRuntime({ persistence_dir }).manager.getNodeInfo("hard-crash", node)?.state).toBe("interrupted");
  });
});
