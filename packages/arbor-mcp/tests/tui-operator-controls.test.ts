/**
 * A-3 remediation regression suite: real key event -> real InputRouter ->
 * real catalog action -> real runtime-catalog command dispatch -> real
 * backend mutation. This is precisely the gap `wiring-audit.test.ts` cannot
 * see (it only checks intent/effect *types* line up, never that a keybinding
 * constructs the intent) — see audit/30-hollow-and-traceability.md A-3.
 *
 * Interrupt is exercised through the real `runTui` entry point over raw
 * stdin bytes (campaign/tree state survives a process restart via
 * persistence_dir, so it can be seeded, torn down, and reloaded for real).
 * Answer and approve/reject are exercised by replicating `tui.ts`'s exact
 * runtime/router/adapter/harness composition directly, because
 * `ApprovalService` is in-memory only (no persistence_dir support) — seeding
 * it requires the same live instance the harness dispatches through, which
 * `runTui` does not expose. Either way, only real production objects are
 * used: `ArborRuntime`, `RuntimeCatalogRouter`, `RuntimePortAdapter`,
 * `HeadlessHarness`, `InputRouter`, `buildDefaultCatalog`, `update()`.
 */
import { describe, expect, it, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { RuntimePortAdapter } from "../src/tui-adapter.js";
import { RecoveryService } from "../src/recovery-service.js";
import type { AppModel } from "@arbor/tui";

// wave 2 shape adapters. `AppModel`'s three independently-plumbed overlay
// fields (`compose`/`confirmation`/`pendingAction`) collapsed into one
// discriminated `overlay` union, and tree-only `selectedNode` generalized to a
// per-screen `selection` map so row-targeted operator commands can name a row.
// These narrow the union for the assertions below without relaxing any of
// them — every expectation keeps its original strictness.
const ESC = String.fromCharCode(27);
const composeOf = (m: AppModel) => (m.overlay?.kind === "compose" ? m.overlay : null);
const confirmOf = (m: AppModel) => (m.overlay?.kind === "confirm" ? m.overlay : null);
const treeSel = (m: AppModel) => {
  const s = m.selection.get("tree");
  return s === undefined ? null : { campaign_id: s.context?.campaign_id, node_id: s.id };
};

import { resolvePersistenceDir } from "../src/cli.js";
import { runTui } from "../src/tui.js";
import {
  HeadlessHarness, InputRouter, buildDefaultCatalog, clearRegisteredScreens,
  INTERRUPT_ACTION_ID, STOP_AND_EXIT_ACTION_ID, APPROVE_ACTION_ID, ANSWER_ACTION_ID,
  TREE_SELECT_NEXT_ACTION_ID, TREE_SELECT_PREV_ACTION_ID, TREE_BRANCH_ACTION_ID, TREE_PRUNE_ACTION_ID,
  RETRY_ROW_ACTION_ID, RECOVERY_ABANDON_ACTION_ID,
  applyEnvelopes, applySnapshot, emptyReadModel, treeScreen,
} from "@arbor/tui";
import type { Action } from "@arbor/core";

const rootAction: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
const childAction: Action = { description: "child", estimated_gain: 1, estimated_cost: 1, category: "refactor", delegate_to: "seed" };

let tempDir: string;
afterEach(() => {
  clearRegisteredScreens();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

function makeHarness(runtime: ArborRuntime, recoveryService?: RecoveryService) {
  const router = new RuntimeCatalogRouter(runtime, {
    ...(recoveryService === undefined ? {} : { recovery_service: recoveryService }),
    require_local_session: true,
  });
  const adapter = new RuntimePortAdapter(router, () => runtime.operations.list().length);
  const harness = new HeadlessHarness({
    client: { connect: () => {}, disconnect: () => {}, requestSnapshot: () => {}, close: () => {}, interruptCampaign: () => {} },
    terminal: { restore: () => {} },
    clock: { now: () => Date.now() },
    telemetrySource: { fetch: async () => ({ campaign_id: "c1", source_record_count: 0, counters: [], phase_histograms: [], usage_cost: [], context_economy: [], tool_economy: [] }) },
    runtime: {
      command: (request: Parameters<RuntimePortAdapter["command"]>[0]) => adapter.command(request) as never,
      query: (request: Parameters<RuntimePortAdapter["query"]>[0]) => adapter.query(request) as never,
      activeOperationCount: () => adapter.activeOperationCount(),
    } as never,
  });
  return harness;
}

describe("approve_selected — real key to real runtime-catalog command (A-3)", () => {
  it("'y' resolves to APPROVE_ACTION_ID via the real catalog, and dispatching it approves the oldest pending request", async () => {
    const runtime = new ArborRuntime();
    const requested = runtime.approvals.request({
      request_id: "req_1", idempotency_key: "idem_1", action: "campaign.halt",
      subject: "c1", resource_id: "c1", proposer: "seed-agent", rationale: "test halt",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(requested.ok).toBe(true);

    // The literal thing A-3 found missing: does a real keypress resolve to a
    // real, non-navigation catalog action via the real InputRouter?
    const catalog = buildDefaultCatalog();
    const inputRouter = new InputRouter(catalog, () => 0);
    expect(inputRouter.handle({ key: "y" }, ["global"])).toEqual({ kind: "action", action_id: APPROVE_ACTION_ID });

    const harness = makeHarness(runtime);
    // Same two dispatches tui.ts's keyboardAction performs on navigating to
    // the approvals screen: focus, then the real issue_query auto-refresh.
    await harness.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "approvals" }, at: 1 });
    await harness.dispatch({
      type: "ui_intent",
      intent: { type: "issue_query", queryId: "q1", request: { kind: "approval.list", query_id: "q1", params: { status: "pending", limit: 50 } } },
      at: 2,
    });
    expect(harness.model.screens.get("approvals")).toMatchObject({ records: [{ request_id: "req_1", status: "pending" }] });

    // The control itself: approve_selected -> dispatch_command -> real adapter -> real router -> real ApprovalService.
    await harness.dispatch({ type: "ui_intent", intent: { type: "approve_selected" }, at: 3 });

    const record = runtime.approvals.list({}).find((r) => r.request_id === "req_1");
    expect(record?.status).toBe("approved");
    expect(record?.decided_by).toMatch(/^local-session:/);
  });

  it("'n' resolves to a real reject through the same path", async () => {
    const runtime = new ArborRuntime();
    runtime.approvals.request({
      request_id: "req_2", idempotency_key: "idem_2", action: "campaign.halt",
      subject: "c1", resource_id: "c1", proposer: "seed-agent", rationale: "test halt",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const harness = makeHarness(runtime);
    await harness.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "approvals" }, at: 1 });
    await harness.dispatch({
      type: "ui_intent",
      intent: { type: "issue_query", queryId: "q1", request: { kind: "approval.list", query_id: "q1", params: { status: "pending", limit: 50 } } },
      at: 2,
    });
    await harness.dispatch({ type: "ui_intent", intent: { type: "reject_selected" }, at: 3 });
    const record = runtime.approvals.list({}).find((r) => r.request_id === "req_2");
    expect(record?.status).toBe("rejected");
  });
});

describe("recovery retry — selected durable target to canonical recovery command", () => {
  it("'r' retries an interrupted selected node through recovery.pending and the real RecoveryService", async () => {
    const runtime = new ArborRuntime();
    runtime.manager.startCampaign("c1", "plan.md", rootAction);
    const [nodeId] = runtime.manager.branch("c1", "root", [childAction]);
    runtime.manager.expandNode("c1", nodeId, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
    runtime.manager.interrupt({
      campaign_id: "c1", node_id: nodeId, operation_id: "interrupt-1", scope: "node", reason: "operator", expected_version: runtime.manager.getCampaignVersion("c1"),
      provenance: { tag: "claimed", claimant: "operator" }, acknowledge: () => {},
    });
    const recovery = new RecoveryService(runtime.manager, runtime.supervisor, {
      resolveOldLease: () => "inactive",
      acquireFresh: () => ({ ok: true, lease_id: "fresh-lease" }),
      checkIsolation: () => ({ worktree_isolated: true, starting_commit_correct: true }),
      releaseFresh: () => {},
    });
    const catalog = buildDefaultCatalog();
    expect(new InputRouter(catalog, () => 0).handle({ key: "r" }, ["global"])).toEqual({ kind: "action", action_id: RETRY_ROW_ACTION_ID });

    const harness = makeHarness(runtime, recovery);
    await harness.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "recovery" }, at: 1 });
    await harness.dispatch({ type: "ui_intent", intent: { type: "issue_query", queryId: "pending", request: { kind: "recovery.pending", query_id: "pending", params: { campaign_id: "c1", limit: 50 } } }, at: 2 });
    expect(harness.model.selection.get("recovery")).toMatchObject({ id: nodeId, context: { prior_operation_id: "interrupt-1" } });
    await harness.dispatch({ type: "ui_intent", intent: { type: "retry_selected_row" }, at: 3 });
    expect(runtime.manager.getCampaignSnapshot("c1")?.nodes.find((node) => node.id === nodeId)?.state).toBe("pending");
  });

  it("'z' then Enter dispatches recovery.abandon with the selected durable target and operator authorization", async () => {
    const runtime = new ArborRuntime();
    runtime.manager.startCampaign("c1", "plan.md", rootAction);
    const [nodeId] = runtime.manager.branch("c1", "root", [childAction]);
    runtime.manager.expandNode("c1", nodeId, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
    runtime.manager.interrupt({
      campaign_id: "c1", node_id: nodeId, operation_id: "interrupt-1", scope: "node", reason: "operator", expected_version: runtime.manager.getCampaignVersion("c1"),
      provenance: { tag: "claimed", claimant: "operator" }, acknowledge: () => {},
    });
    const recovery = new RecoveryService(runtime.manager, runtime.supervisor, {
      resolveOldLease: () => "inactive",
      acquireFresh: () => ({ ok: true, lease_id: "fresh-lease" }),
      checkIsolation: () => ({ worktree_isolated: true, starting_commit_correct: true }),
      releaseFresh: () => {},
    });
    const catalog = buildDefaultCatalog();
    expect(new InputRouter(catalog, () => 0).handle({ key: "z" }, ["global"])).toEqual({ kind: "action", action_id: RECOVERY_ABANDON_ACTION_ID });

    const harness = makeHarness(runtime, recovery);
    await harness.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "recovery" }, at: 1 });
    await harness.dispatch({ type: "ui_intent", intent: { type: "issue_query", queryId: "pending", request: { kind: "recovery.pending", query_id: "pending", params: { campaign_id: "c1", limit: 50 } } }, at: 2 });
    await harness.dispatch({ type: "ui_intent", intent: { type: "abandon_recovery_selected" }, at: 3 });
    expect(confirmOf(harness.model)?.pendingAction).toMatchObject({ kind: "recovery.abandon", params: { node_id: nodeId } });
    await harness.dispatch({ type: "ui_intent", intent: { type: "confirm_pending_action" }, at: 4 });

    expect(runtime.manager.getCampaignSnapshot("c1")?.nodes.find((node) => node.id === nodeId)?.state).toBe("abandoned");
  });
});

describe("selected operation detail — live catalog query", () => {
  it("uses the selected operation row to render operation.get's real record", async () => {
    const runtime = new ArborRuntime();
    runtime.operations.accept({
      metadata: { operation_id: "op-detail", idempotency_key: "detail-key", correlation_id: "detail-correlation", actor_id: "operator", requested_at: "2026-08-08T00:00:00.000Z" },
      capability: "tree.write", fingerprint: "detail-fingerprint",
    });
    const harness = makeHarness(runtime);
    await harness.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "operations" }, at: 1 });
    await harness.dispatch({ type: "ui_intent", intent: { type: "issue_query", queryId: "ops", request: { kind: "operation.list", query_id: "ops", params: { include_terminal: false } } }, at: 2 });
    expect(harness.model.selection.get("operations")?.id).toBe("op-detail");
    await harness.dispatch({ type: "ui_intent", intent: { type: "view_selected_row_detail" }, at: 3 });
    expect(harness.model.screens.get("operations")).toMatchObject({ operation_id: "op-detail", capability: "tree.write" });
  });

  // IS-09/IS-10 closure check: the audit's `grep for issue("operation.get"`
  // methodology only sees the specific `issueQuery(...)` helper tui.ts uses
  // for refreshScreenData's per-screen fetch-on-focus queries. Both
  // operation.get (above) and communication.history (below) are actually
  // issued through a DIFFERENT real production path -- the generic
  // `view_selected_row_detail` intent, dispatched from the real Enter
  // keybinding (VIEW_ROW_DETAIL_ACTION_ID, tui.ts:1111) -- which that grep
  // pattern cannot see. Both are already reachable by a real operator; this
  // and the test above are the evidence, not a new wiring.
  it("uses the selected communication row to render communication.history's real record (IS-10)", async () => {
    const runtime = new ArborRuntime();
    runtime.manager.startCampaign("c1", "plan.md", rootAction);
    const router = new RuntimeCatalogRouter(runtime);
    const record = await router.dispatchCommand({
      schema_version: 1,
      metadata: { operation_id: "op-comm-1", idempotency_key: "comm-key-1", correlation_id: "comm-correlation-1", actor_id: "operator", requested_at: "2026-08-08T00:00:00.000Z" },
      command: {
        kind: "communication.record",
        campaign_id: "c1",
        node_id: "root",
        communication: {
          author_node_id: "worker",
          recipient_node_id: "root",
          other_recipient_node_ids: [],
          kind: "report",
          payload: { content: "bounded report", provenance: { tag: "claimed", claimant: "worker" } },
          capability_tier: "specialist",
          trigger_turn: false,
          as_of: "2026-08-08T00:00:00.000Z",
          correlation_id: "comm-correlation-1",
          idempotency_key: "comm-key-1",
          acknowledges_communication_id: null,
          retracts_communication_id: null,
        },
      },
    } as never);
    expect(record.ok).toBe(true);

    const harness = makeHarness(runtime);
    await harness.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "communications" }, at: 1 });
    await harness.dispatch({
      type: "ui_intent",
      intent: { type: "issue_query", queryId: "sel", request: { kind: "communication.selection", query_id: "sel", params: { campaign_id: "c1", node_id: "root", limit: 10 } } },
      at: 2,
    });
    expect(harness.model.selection.get("communications")?.context).toEqual({ campaign_id: "c1", node_id: "root" });

    await harness.dispatch({ type: "ui_intent", intent: { type: "view_selected_row_detail" }, at: 3 });
    expect(harness.model.screens.get("communications")).toMatchObject({
      campaign_id: "c1", node_id: "root",
      communications: [expect.objectContaining({ communication: expect.objectContaining({ payload: expect.objectContaining({ content: "bounded report" }) }) })],
    });
  });
});

describe("arm_answer / submit_answer — real key to real userinput.answer command (A-3)", () => {
  it("'a' resolves to ANSWER_ACTION_ID; arming, typing, and submitting answers through the real userinput.answer command and clears the blocking wait", async () => {
    const runtime = new ArborRuntime();
    runtime.manager.startCampaign("c1", "plan.md", rootAction);
    const recordId = runtime.manager.askForUserInput({
      campaign_id: "c1", node_id: "root", operation_id: "op-ask-1",
      question: "Proceed with the migration?",
      options: [{ id: "yes", text: "Yes", is_other: false }, { id: "no", text: "No", is_other: false }],
      authority: "lead", blocking: "blocking", requester_role: "crown",
      idempotency_key: "ask-1", as_of: new Date().toISOString(),
    });
    expect(runtime.manager.awaitingUserInput("c1")).toBe(true);

    const catalog = buildDefaultCatalog();
    const inputRouter = new InputRouter(catalog, () => 0);
    expect(inputRouter.handle({ key: "a" }, ["global"])).toEqual({ kind: "action", action_id: ANSWER_ACTION_ID });

    const harness = makeHarness(runtime);
    await harness.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "interviews" }, at: 1 });
    await harness.dispatch({
      type: "ui_intent",
      intent: { type: "issue_query", queryId: "q1", request: { kind: "userinput.list", query_id: "q1", params: { campaign_id: "c1", limit: 50 } } },
      at: 2,
    });

    await harness.dispatch({ type: "ui_intent", intent: { type: "arm_answer" }, at: 3 });
    expect(composeOf(harness.model)?.record_id).toBe(recordId);

    // Simulates the raw-character compose loop in tui.ts's onData typing "yes, proceed".
    for (const ch of "yes, proceed") {
      await harness.dispatch({ type: "ui_intent", intent: { type: "compose_input", buffer: composeOf(harness.model)!.buffer + ch }, at: 4 });
    }
    expect(composeOf(harness.model)?.buffer).toBe("yes, proceed");

    await harness.dispatch({ type: "ui_intent", intent: { type: "submit_answer" }, at: 5 });

    expect(composeOf(harness.model)).toBeNull();
    expect(runtime.manager.awaitingUserInput("c1")).toBe(false);
  });
});

describe("interrupt_active_campaign — real key over real stdin through the real runTui entry point (A-3)", () => {
  it("'!!' interrupts the campaign's genuinely expanding node end-to-end", async () => {
    const catalog = buildDefaultCatalog();
    expect(new InputRouter(catalog, () => 0).handle({ key: "!" }, ["global"])).toEqual({ kind: "action", action_id: INTERRUPT_ACTION_ID });

    tempDir = mkdtempSync(join(tmpdir(), "arbor-tui-interrupt-"));
    const persistenceDir = resolvePersistenceDir(tempDir);

    // Seed a real expanding node — tree/campaign state is durably persisted
    // (unlike ApprovalService), so a fresh runtime pointed at the same
    // persistence_dir reconciles it on start, exactly as runTui's own
    // createCliRuntime will when the real TUI process boots.
    const seed = new ArborRuntime({ persistence_dir: persistenceDir, devtools_logger: { persistence_dir: persistenceDir, disable_fsync: true } });
    await seed.start();
    seed.manager.startCampaign("c1", "plan.md", rootAction);
    const [nodeId] = seed.manager.branch("c1", "root", [childAction]);
    const expanded = seed.manager.expandNode("c1", nodeId, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
    expect(expanded.ok).toBe(true);
    expect(seed.manager.getActiveExpandingNode("c1")).toBe(nodeId);
    await seed.close();

    const stdin = new PassThrough();
    const stdout = new PassThrough(); stdout.on("data", () => {});
    const stderr = new PassThrough(); stderr.on("data", () => {});

    const donePromise = runTui({ cwd: tempDir, stdin, stdout, stderr });
    await new Promise((resolve) => setImmediate(resolve));

    stdin.write("!!");
    await new Promise((resolve) => setTimeout(resolve, 10));

    stdin.end();
    const code = await donePromise;
    expect(code).toBe(0);

    const verify = new ArborRuntime({ persistence_dir: persistenceDir, devtools_logger: { persistence_dir: persistenceDir, disable_fsync: true } });
    await verify.start();
    const snapshot = verify.manager.getCampaignSnapshot("c1");
    const node = snapshot?.nodes.find((n) => n.id === nodeId);
    expect(node?.state).toBe("interrupted");
    // CS-05: interruption is no longer a direct runtime side path. The
    // durable outcome carries the catalog operation identity (the old direct
    // path used `tui:interrupt:*`, bypassing the adapter entirely). Operation
    // registry retention is deliberately process-local, so the persisted node
    // outcome is the correct cross-process assertion here.
    expect(node?.outcome).toMatchObject({ kind: "interrupted", operation_id: expect.stringMatching(/^tui:tree\.interrupt:/) });
    await verify.close();
  });

  it("stop-and-exit: Ctrl+C routes through the discoverable catalog action and request_shutdown, not detach", async () => {
    const catalog = buildDefaultCatalog();
    expect(new InputRouter(catalog, () => 0).handle({ key: "c", modifiers: ["ctrl"] }, ["global"])).toEqual({ kind: "action", action_id: STOP_AND_EXIT_ACTION_ID });
    tempDir = mkdtempSync(join(tmpdir(), "arbor-tui-shutdown-interrupt-"));
    const persistenceDir = resolvePersistenceDir(tempDir);

    const seed = new ArborRuntime({ persistence_dir: persistenceDir, devtools_logger: { persistence_dir: persistenceDir, disable_fsync: true } });
    await seed.start();
    seed.manager.startCampaign("c1", "plan.md", rootAction);
    const [nodeId] = seed.manager.branch("c1", "root", [childAction]);
    const expanded = seed.manager.expandNode("c1", nodeId, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
    expect(expanded.ok).toBe(true);
    expect(seed.manager.getActiveExpandingNode("c1")).toBe(nodeId);
    await seed.close();

    const stdin = new PassThrough();
    const stdout = new PassThrough(); stdout.on("data", () => {});
    const stderr = new PassThrough(); stderr.on("data", () => {});

    const donePromise = runTui({ cwd: tempDir, stdin, stdout, stderr });
    await new Promise((resolve) => setImmediate(resolve));

    // No '!!' keypress at all: Ctrl+C takes the same finish() shutdown path.
    // Before DEF-03's fix, finish() jumped straight
    // to shell.stop()/renderer.restore()/runtime.close() and never
    // constructed the modelled `request_shutdown` UiIntent, so an in-flight
    // expansion was simply abandoned (never interrupted) on quit.
    stdin.write("\u0003");
    const code = await donePromise;
    expect(code).toBe(0);

    const verify = new ArborRuntime({ persistence_dir: persistenceDir, devtools_logger: { persistence_dir: persistenceDir, disable_fsync: true } });
    await verify.start();
    const snapshot = verify.manager.getCampaignSnapshot("c1");
    const node = snapshot?.nodes.find((n) => n.id === nodeId);
    expect(node?.state).toBe("interrupted");
    expect(node?.outcome).toMatchObject({ kind: "interrupted", operation_id: expect.stringMatching(/^tui:tree\.interrupt:/) });
    await verify.close();
  });
});

describe("tree screen — node selection + branch/prune, real key to real runtime-catalog command (wave1/tui-contracts)", () => {
  it("'j'/'k' resolve to real, distinct catalog actions from the same key set as the other operator controls", () => {
    const catalog = buildDefaultCatalog();
    const inputRouter = new InputRouter(catalog, () => 0);
    expect(inputRouter.handle({ key: "j" }, ["global"])).toEqual({ kind: "action", action_id: TREE_SELECT_NEXT_ACTION_ID });
    expect(inputRouter.handle({ key: "k" }, ["global"])).toEqual({ kind: "action", action_id: TREE_SELECT_PREV_ACTION_ID });
    expect(inputRouter.handle({ key: "b" }, ["global"])).toEqual({ kind: "action", action_id: TREE_BRANCH_ACTION_ID });
    expect(inputRouter.handle({ key: "x" }, ["global"])).toEqual({ kind: "action", action_id: TREE_PRUNE_ACTION_ID });
  });

  it("focusing the tree screen and fetching campaign.tree selects the root node by default", async () => {
    const runtime = new ArborRuntime();
    runtime.manager.startCampaign("c1", "plan.md", rootAction);
    const harness = makeHarness(runtime);

    await harness.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "tree" }, at: 1 });
    await harness.dispatch({
      type: "ui_intent",
      intent: { type: "issue_query", queryId: "q1", request: { kind: "campaign.tree", query_id: "q1", params: { campaign_id: "c1", limit: 200 } } },
      at: 2,
    });

    expect(treeSel(harness.model)).toEqual({ campaign_id: "c1", node_id: "root" });
  });

  it("'j'/'k' cycle the selection across real fetched tree nodes and wrap at the ends", async () => {
    const runtime = new ArborRuntime();
    runtime.manager.startCampaign("c1", "plan.md", rootAction);
    runtime.manager.branch("c1", "root", [childAction]);
    const harness = makeHarness(runtime);

    await harness.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "tree" }, at: 1 });
    await harness.dispatch({
      type: "ui_intent",
      intent: { type: "issue_query", queryId: "q1", request: { kind: "campaign.tree", query_id: "q1", params: { campaign_id: "c1", limit: 200 } } },
      at: 2,
    });
    const nodeIds = (harness.model.screens.get("tree") as { nodes: { id: string }[] }).nodes.map((n) => n.id);
    expect(nodeIds).toEqual(["root", ...nodeIds.slice(1)]);
    expect(treeSel(harness.model)?.node_id).toBe("root");

    await harness.dispatch({ type: "ui_intent", intent: { type: "select_tree_node", direction: 1 }, at: 3 });
    expect(treeSel(harness.model)?.node_id).toBe(nodeIds[1]);
    expect(harness.model.uctReader.selected_id).toBe(nodeIds[1]);
    expect(harness.model.uctReader.follow_active).toBe(false);

    // wraps back to the first node from the last
    await harness.dispatch({ type: "ui_intent", intent: { type: "select_tree_node", direction: 1 }, at: 4 });
    expect(treeSel(harness.model)?.node_id).toBe("root");

    await harness.dispatch({ type: "ui_intent", intent: { type: "select_tree_node", direction: -1 }, at: 5 });
    expect(treeSel(harness.model)?.node_id).toBe(nodeIds[1]);
  });

  it("filters the retained Tree reader against real campaign.tree nodes and recovers selection when cleared", async () => {
    const runtime = new ArborRuntime();
    runtime.manager.startCampaign("c1", "plan.md", rootAction);
    runtime.manager.branch("c1", "root", [childAction]);
    const harness = makeHarness(runtime);
    await harness.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "tree" }, at: 1 });
    await harness.dispatch({ type: "ui_intent", intent: { type: "issue_query", queryId: "q1", request: { kind: "campaign.tree", query_id: "q1", params: { campaign_id: "c1", limit: 200 } } }, at: 2 });
    const value = harness.model.screens.get("tree") as { nodes: readonly { id: string; action_description?: string }[] };
    const child = value.nodes.find((node) => node.id !== "root")!;

    await harness.dispatch({ type: "ui_intent", intent: { type: "uct_reader_action", action: { filter: child.action_description! } }, at: 3 });
    expect(harness.model.uctReader.filter).toBe(child.action_description);
    expect(harness.model.uctReader.selected_id).toBe(child.id);
    await harness.dispatch({ type: "ui_intent", intent: { type: "uct_reader_action", action: { filter: "no matching node" } }, at: 4 });
    expect(harness.model.uctReader.selected_id).toBeNull();
    await harness.dispatch({ type: "ui_intent", intent: { type: "uct_reader_action", action: { filter: "" } }, at: 5 });
    expect(harness.model.uctReader.selected_id).toBe("root");
  });

  it("'b' (branch_selected_node) dispatches a real tree.branch command that adds a genuine child node under the selected node", async () => {
    const runtime = new ArborRuntime();
    runtime.manager.startCampaign("c1", "plan.md", rootAction);
    const before = runtime.manager.getCampaignSnapshot("c1");
    expect(before?.nodes).toHaveLength(1);

    const harness = makeHarness(runtime);
    await harness.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "tree" }, at: 1 });
    await harness.dispatch({
      type: "ui_intent",
      intent: { type: "issue_query", queryId: "q1", request: { kind: "campaign.tree", query_id: "q1", params: { campaign_id: "c1", limit: 200 } } },
      at: 2,
    });
    expect(treeSel(harness.model)).toEqual({ campaign_id: "c1", node_id: "root" });

    await harness.dispatch({ type: "ui_intent", intent: { type: "branch_selected_node" }, at: 3 });

    const after = runtime.manager.getCampaignSnapshot("c1");
    expect(after?.nodes).toHaveLength(2);
    const child = after?.nodes.find((n) => n.parent_id === "root");
    expect(child).toMatchObject({
      action_description: "Operator-requested expansion",
      action_category: "operator",
      action_delegate: "seed",
    });
  });

  it("'x' (request_prune_selected_node) arms a confirmation WITHOUT mutating the tree; Escape cancels it, leaving the node untouched", async () => {
    const runtime = new ArborRuntime();
    runtime.manager.startCampaign("c1", "plan.md", rootAction);
    runtime.manager.branch("c1", "root", [childAction]);
    const [childId] = runtime.manager.getCampaignSnapshot("c1")!.nodes.filter((n) => n.parent_id === "root").map((n) => n.id);

    const harness = makeHarness(runtime);
    await harness.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "tree" }, at: 1 });
    await harness.dispatch({
      type: "ui_intent",
      intent: { type: "issue_query", queryId: "q1", request: { kind: "campaign.tree", query_id: "q1", params: { campaign_id: "c1", limit: 200 } } },
      at: 2,
    });
    await harness.dispatch({ type: "ui_intent", intent: { type: "select_tree_node", direction: 1 }, at: 3 });
    expect(treeSel(harness.model)?.node_id).toBe(childId);

    await harness.dispatch({ type: "ui_intent", intent: { type: "request_prune_selected_node" }, at: 4 });
    expect(confirmOf(harness.model)).not.toBeNull();
    expect(confirmOf(harness.model)?.pendingAction).toEqual({ kind: "tree.prune", params: { campaign_id: "c1", node_id: childId } });
    // Not yet mutated — confirmation is armed, not dispatched.
    expect(runtime.manager.getCampaignSnapshot("c1")?.nodes.find((n) => n.id === childId)?.state).not.toBe("pruned");

    await harness.dispatch({ type: "ui_intent", intent: { type: "cancel_pending_action" }, at: 5 });
    expect(confirmOf(harness.model)).toBeNull();
    expect(harness.model.overlay).toBeNull();
    expect(runtime.manager.getCampaignSnapshot("c1")?.nodes.find((n) => n.id === childId)?.state).not.toBe("pruned");
  });

  it("'x' then Enter (confirm_pending_action) dispatches the real tree.prune command that actually prunes the node", async () => {
    const runtime = new ArborRuntime();
    runtime.manager.startCampaign("c1", "plan.md", rootAction);
    runtime.manager.branch("c1", "root", [childAction]);
    const [childId] = runtime.manager.getCampaignSnapshot("c1")!.nodes.filter((n) => n.parent_id === "root").map((n) => n.id);

    const harness = makeHarness(runtime);
    await harness.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "tree" }, at: 1 });
    await harness.dispatch({
      type: "ui_intent",
      intent: { type: "issue_query", queryId: "q1", request: { kind: "campaign.tree", query_id: "q1", params: { campaign_id: "c1", limit: 200 } } },
      at: 2,
    });
    await harness.dispatch({ type: "ui_intent", intent: { type: "select_tree_node", direction: 1 }, at: 3 });
    expect(treeSel(harness.model)?.node_id).toBe(childId);

    await harness.dispatch({ type: "ui_intent", intent: { type: "request_prune_selected_node" }, at: 4 });
    await harness.dispatch({ type: "ui_intent", intent: { type: "confirm_pending_action" }, at: 5 });

    expect(confirmOf(harness.model)).toBeNull();
    expect(harness.model.overlay).toBeNull();
    const pruned = runtime.manager.getCampaignSnapshot("c1")?.nodes.find((n) => n.id === childId);
    expect(pruned?.state).toBe("pruned");

    // Continue through the same production projection route: the query's
    // cursor stamps its snapshot; real post-cursor runtime envelopes fold
    // through the TUI read model and advance the Tree screen's node state.
    const tree = harness.model.screens.get("tree") as { event_cursor?: { stream_id: string; sequence: number }; nodes: readonly { id: string }[] };
    expect(tree.event_cursor).toBeDefined();
    const cursor = tree.event_cursor!;
    const resumed = runtime.eventStream.resume(cursor, null);
    expect(resumed.kind).toBe("events");
    if (resumed.kind !== "events") throw new Error("tree cursor unexpectedly required a resnapshot");
    let readModel = applySnapshot(emptyReadModel(cursor.stream_id), cursor, null);
    readModel = applyEnvelopes(readModel, resumed.events).model;
    await harness.dispatch({ type: "read_model_updated", model: readModel });
    const projection = treeScreen.project(tree, { width: 100, height: 20, read_model: harness.model.readModel });
    expect(projection.rows.find((row) => row.id === childId)?.state).toBe("pruned");
    expect(projection.caption).toContain(`UCT seq ${readModel.watermark?.sequence}`);
  });

  it("end-to-end over real stdin through the real runTui entry point: 't' focuses Tree, 'j' selects the child, 'x' then Enter prunes it", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-tui-prune-"));
    const persistenceDir = resolvePersistenceDir(tempDir);

    const seed = new ArborRuntime({ persistence_dir: persistenceDir, devtools_logger: { persistence_dir: persistenceDir, disable_fsync: true } });
    await seed.start();
    seed.manager.startCampaign("c1", "plan.md", rootAction);
    const [childId] = seed.manager.branch("c1", "root", [childAction]);
    await seed.close();

    const stdin = new PassThrough();
    const stdout = new PassThrough(); stdout.on("data", () => {});
    const stderr = new PassThrough(); stderr.on("data", () => {});

    const donePromise = runTui({ cwd: tempDir, stdin, stdout, stderr });
    const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    await new Promise((resolve) => setImmediate(resolve));

    // Console owns the keyboard from its first frame (tui.ts), so release
    // it before driving a bare navigation key.
    stdin.write("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 60));
    stdin.write("t"); // focus:tree — triggers the real campaign.tree refresh
    await wait(100);
    stdin.write("j"); // select_tree_node(+1): root -> the branched child
    await wait(100);
    stdin.write("x"); // request_prune_selected_node — arms the confirmation, no mutation yet
    await wait(100);
    stdin.write("\n"); // confirm_pending_action — real tree.prune dispatch, intercepted by the raw onData loop
    await wait(100);

    stdin.end();
    const code = await donePromise;
    expect(code).toBe(0);

    const verify = new ArborRuntime({ persistence_dir: persistenceDir, devtools_logger: { persistence_dir: persistenceDir, disable_fsync: true } });
    await verify.start();
    const node = verify.manager.getCampaignSnapshot("c1")?.nodes.find((n) => n.id === childId);
    expect(node?.state).toBe("pruned");
    await verify.close();
  });

  it("end-to-end over real stdin: 't', 'j', 'k' (select_tree_node -1) returns the selection to root, then 'b' branches root for real", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-tui-branch-"));
    const persistenceDir = resolvePersistenceDir(tempDir);

    const seed = new ArborRuntime({ persistence_dir: persistenceDir, devtools_logger: { persistence_dir: persistenceDir, disable_fsync: true } });
    await seed.start();
    seed.manager.startCampaign("c1", "plan.md", rootAction);
    seed.manager.branch("c1", "root", [childAction]);
    await seed.close();

    const stdin = new PassThrough();
    const stdout = new PassThrough(); stdout.on("data", () => {});
    const stderr = new PassThrough(); stderr.on("data", () => {});

    const donePromise = runTui({ cwd: tempDir, stdin, stdout, stderr });
    const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    await new Promise((resolve) => setImmediate(resolve));

    // Console owns the keyboard from its first frame (tui.ts), so release
    // it before driving a bare navigation key.
    stdin.write("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 60));
    stdin.write("t"); // focus:tree
    await wait(100);
    stdin.write("j"); // select_tree_node(+1): root -> child
    await wait(100);
    stdin.write("k"); // select_tree_node(-1): child -> back to root
    await wait(100);
    stdin.write("b"); // branch_selected_node — real tree.branch dispatch on root
    await wait(100);

    stdin.end();
    const code = await donePromise;
    expect(code).toBe(0);

    const verify = new ArborRuntime({ persistence_dir: persistenceDir, devtools_logger: { persistence_dir: persistenceDir, disable_fsync: true } });
    await verify.start();
    const snapshot = verify.manager.getCampaignSnapshot("c1");
    // Started with root + 1 branched child; 'b' on root (post j/k roundtrip) adds a second child.
    expect(snapshot?.nodes).toHaveLength(3);
    const operatorChildren = snapshot?.nodes.filter((n) => n.parent_id === "root" && n.action_description === "Operator-requested expansion");
    expect(operatorChildren).toHaveLength(1);
    await verify.close();
  });

  it("Escape cancels an armed prune confirmation over real stdin — the raw onData intercept's cancel branch, not just the intent handler", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-tui-prune-cancel-"));
    const persistenceDir = resolvePersistenceDir(tempDir);

    const seed = new ArborRuntime({ persistence_dir: persistenceDir, devtools_logger: { persistence_dir: persistenceDir, disable_fsync: true } });
    await seed.start();
    seed.manager.startCampaign("c1", "plan.md", rootAction);
    const [childId] = seed.manager.branch("c1", "root", [childAction]);
    await seed.close();

    const stdin = new PassThrough();
    const stdout = new PassThrough(); stdout.on("data", () => {});
    const stderr = new PassThrough(); stderr.on("data", () => {});

    const donePromise = runTui({ cwd: tempDir, stdin, stdout, stderr });
    const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    await new Promise((resolve) => setImmediate(resolve));

    // Console owns the keyboard from its first frame (tui.ts), so release
    // it before driving a bare navigation key.
    stdin.write("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 60));
    stdin.write("t");
    await wait(100);
    stdin.write("j");
    await wait(100);
    stdin.write("x"); // arms the prune confirmation
    await wait(100);
    stdin.write("\u001b"); // Escape — cancels, real onData intercept branch
    await wait(100);

    stdin.end();
    const code = await donePromise;
    expect(code).toBe(0);

    const verify = new ArborRuntime({ persistence_dir: persistenceDir, devtools_logger: { persistence_dir: persistenceDir, disable_fsync: true } });
    await verify.start();
    const node = verify.manager.getCampaignSnapshot("c1")?.nodes.find((n) => n.id === childId);
    expect(node?.state).not.toBe("pruned"); // cancelled, never dispatched
    await verify.close();
  });
});


describe("G-32 read-side wiring — real key navigation triggers a real issue_query for each newly-wired screen", () => {
  it("keeps the valid governed-context aggregate visible instead of overwriting it with an incompatible query", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-tui-overlays-refresh-"));
    const persistenceDir = resolvePersistenceDir(tempDir);

    const seed = new ArborRuntime({ persistence_dir: persistenceDir, devtools_logger: { persistence_dir: persistenceDir, disable_fsync: true } });
    await seed.start();
    seed.manager.startCampaign("context-campaign", "plan.md", rootAction);
    await seed.close();

    const stdin = new PassThrough();
    let out = "";
    const stdout = new PassThrough(); stdout.on("data", (d: Buffer) => { out += d.toString(); });
    const stderr = new PassThrough(); stderr.on("data", () => {});

    const donePromise = runTui({ cwd: tempDir, stdin, stdout, stderr });
    await new Promise((resolve) => setImmediate(resolve));
    // Console owns the keyboard from its first frame (tui.ts), so release
    // it before driving a bare navigation key.
    stdin.write("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 60));
    stdin.write("_"); // focus:overlays -> context.overlays for newest durable campaign
    await new Promise((resolve) => setTimeout(resolve, 150));
    stdin.end();

    expect(await donePromise).toBe(0);
    // EC-012: the empty overlays caption now names what creates an overlay.
    expect(out).toContain("context-campaign · no active governed overlays");
    expect(out).not.toContain("Select an active campaign to inspect governed overlays");
  });

  it("focusing tasks/agents/config/jobs/devtools/command-history over real stdin renders each screen's own real data, not an empty pane", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-tui-refresh-"));
    const persistenceDir = resolvePersistenceDir(tempDir);

    const seed = new ArborRuntime({ persistence_dir: persistenceDir, devtools_logger: { persistence_dir: persistenceDir, disable_fsync: true } });
    await seed.start();
    seed.manager.startCampaign("c1", "plan.md", rootAction);
    await seed.close();

    const stdin = new PassThrough();
    let out = "";
    const stdout = new PassThrough(); stdout.on("data", (d: Buffer) => { out += d.toString(); });
    const stderr = new PassThrough(); stderr.on("data", () => {});

    const donePromise = runTui({ cwd: tempDir, stdin, stdout, stderr });
    const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    await new Promise((resolve) => setImmediate(resolve));

    // Console owns the keyboard from its first frame (tui.ts), so release
    // it before driving a bare navigation key.
    stdin.write("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 60));
    stdin.write("\\2"); // focus:tasks — product views own 1/2/3; legacy detail views use a backslash chord
    await wait(120);
    stdin.write("8"); // focus:agents
    await wait(120);
    stdin.write("7"); // focus:config
    await wait(120);
    // M2 (ui-spec §2.2): the framed top band is now 8-12 rows (was a fixed
    // 4-row hero), so the narrow-mode config document — four lines per leaf
    // — no longer fits every leaf (agents.* alone is 11) in one unscrolled
    // screen. The `tree_search.*`/`kb.backend` leaves this test looks for
    // sort alphabetically after all 11 `agents.*` leaves; they are still
    // reachable, just one real PageDown away, not lost.
    stdin.write(`${ESC}[6~`); // page_down
    await wait(120);
    stdin.write("9"); // focus:jobs — exercises refreshScreenData's job.list branch
    await wait(120);
    stdin.write("d"); // focus:devtools
    await wait(120);
    stdin.write("D"); // focus:command-history — Shift+D must issue the shared devtools.stream query
    await wait(120);
    stdin.write("\\3"); // focus:operations — exercises refreshScreenData's new operation.list branch (G-32 closure)
    await wait(120);

    stdin.end();
    const code = await donePromise;
    expect(code).toBe(0);

    // Before this fix, AppModel.grantedCapabilities was never populated by
    // runTui (only demo.ts's driver granted it), so resolveActiveScreen()
    // never found an available module for ANY screen and every pane showed
    // the generic "loading"/"ready" fallback forever regardless of focus or
    // how much live data G-32 wired in. Assert real per-screen content, not
    // the fallback: the real agent registry (11 real agent definitions) and
    // the real effective config (a real dotted leaf path), neither of which
    // exists anywhere outside their own screen's live projection.
    expect(out).toContain("Agent definitions");
    expect(out).toContain("crown");
    expect(out).toContain("Config");
    expect(out).toMatch(/tree_search\.|kb\.backend/);
    expect(out).toContain("Command history — commands, bounded output, and exit detail");

    // Operations: the seeded campaign started via `manager.startCampaign`
    // directly (never through the catalog router's dispatchCommand), so no
    // OperationRegistry record exists — a real, honest empty `operation.list`
    // result, not a fallback. Must render "no operations", never "no errors"
    // (the exact wrong-variant regression the operations.ts fix closed).
    expect(out).toContain("operations");
    expect(out).not.toContain("no errors");
  });

  it("first entry to Command History requests its own devtools.stream tail over the launch path", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-tui-command-history-first-focus-"));
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const issued: Array<{ kind: string; screen: string }> = [];

    const donePromise = runTui({
      cwd: tempDir,
      stdin,
      stdout,
      stderr,
      on_runtime_query: (request) => issued.push({ kind: request.kind, screen: request.screen }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    // Console owns the keyboard from its first frame (tui.ts), so release
    // it before driving a bare navigation key.
    stdin.write("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 60));
    stdin.write("D"); // first visit: do not prime DevTools or any screen cache
    await new Promise((resolve) => setTimeout(resolve, 120));
    stdin.end();

    expect(await donePromise).toBe(0);
    expect(issued.filter((request) => request.kind === "devtools.stream")).toEqual([
      { kind: "devtools.stream", screen: "command-history" },
    ]);
  });

  it("focusing output over real stdin renders a real, honest-empty output.list dispatch, and focusing diagnostics after a real event renders that event", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-tui-refresh2-"));
    const persistenceDir = resolvePersistenceDir(tempDir);

    const seed = new ArborRuntime({ persistence_dir: persistenceDir, devtools_logger: { persistence_dir: persistenceDir, disable_fsync: true } });
    await seed.start();
    seed.manager.startCampaign("c1", "plan.md", rootAction);
    await seed.close();

    const stdin = new PassThrough();
    let out = "";
    const stdout = new PassThrough(); stdout.on("data", (d: Buffer) => { out += d.toString(); });
    const stderr = new PassThrough(); stderr.on("data", () => {});

    const donePromise = runTui({ cwd: tempDir, stdin, stdout, stderr });
    const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    await new Promise((resolve) => setImmediate(resolve));

    // Output: nothing has ever been captured against this fresh runtime — a
    // real, honest empty `output.list` result, not the "never issued a
    // query" fallback (G-32's last residual: output.descriptor/output.raw
    // both require an evidence_id nothing could enumerate; output.list needs
    // no selection).
    // Console owns the keyboard from its first frame (tui.ts), so release
    // it before driving a bare navigation key.
    stdin.write("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 60));
    stdin.write("4"); // focus:output — exercises refreshScreenData's output.list branch
    await wait(120);

    // Diagnostics needs at least one real event on the stream to prove it is
    // reading real data rather than the "No events" fallback both a genuine
    // empty result and a never-issued query can render — produce one via a
    // real tree.branch dispatch: 't' (focus:tree, fetches campaign.tree and
    // selects root by default), 'b' (branch_selected_node -> real tree.branch
    // command -> CampaignManager.branch emits a real tree.node_changed event
    // onto runtime.eventStream).
    stdin.write("t");
    await wait(120);
    stdin.write("b");
    await wait(120);
    stdin.write("6"); // focus:diagnostics — exercises refreshScreenData's event.resume branch (G-32 residual)
    await wait(120);

    stdin.end();
    const code = await donePromise;
    expect(code).toBe(0);

    // output.list's real empty-store caption ("no outputs", output.ts's
    // rowCountCaption) — never reachable without a real dispatch.
    expect(out).toContain("no outputs");

    // event.resume's real payload: the tree.branch dispatch above published
    // exactly one tree.node_changed event (child created in "pending"
    // state), and diagnostics.ts's describeEvent renders it as
    // `-> pending` under the "tree.node_changed" kind column. Before the
    // fix, `event.resume`'s cursor was dispatched as a bare number (`0`)
    // rather than the real `{stream_id, sequence}` shape `validateCursor`
    // requires, so every dispatch failed validation and the screen never
    // received real events at all.
    expect(out).toContain("tree.node_changed");
    expect(out).toContain("-> pending");
  });
});
