import { afterEach, describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { RuntimePortAdapter } from "../src/tui-adapter.js";
import { resolvePersistenceDir } from "../src/cli.js";
import { runTui } from "../src/tui.js";
import { HeadlessHarness, clearRegisteredScreens, installScreens } from "@arbor/tui";

let tempDir: string | undefined;
afterEach(() => {
  clearRegisteredScreens();
  if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function makeHarness(runtime: ArborRuntime): HeadlessHarness {
  const adapter = new RuntimePortAdapter(new RuntimeCatalogRouter(runtime, { require_local_session: true }), () => runtime.operations.list().length);
  return new HeadlessHarness({
    client: { connect: () => {}, disconnect: () => {}, requestSnapshot: () => {}, close: () => {}, interruptCampaign: () => {} },
    terminal: { restore: () => {} },
    clock: { now: () => 100 },
    telemetrySource: { fetch: async () => ({ campaign_id: "c1", source_record_count: 0, counters: [], phase_histograms: [], usage_cost: [], context_economy: [], tool_economy: [] }) },
    runtime: {
      command: (request: Parameters<RuntimePortAdapter["command"]>[0]) => adapter.command(request) as never,
      query: (request: Parameters<RuntimePortAdapter["query"]>[0]) => adapter.query(request) as never,
      activeOperationCount: () => adapter.activeOperationCount(),
    } as never,
  });
}

describe("operator form → canonical RuntimePort", () => {
  it("sends a durable parent/child reply through the TUI form, catalog router, and restartable ledger", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-tui-thread-form-"));
    const runtime = new ArborRuntime({ persistence_dir: tempDir });
    runtime.manager.startCampaign("thread-campaign", "plan.md", { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" });
    const [child] = runtime.manager.branch("thread-campaign", "root", [{ description: "child", estimated_gain: 1, estimated_cost: 1, category: "work", delegate_to: "seed" }]);
    if (!child) throw new Error("branch did not create a child");
    installScreens();
    const harness = makeHarness(runtime);
    await harness.dispatch({ type: "screen_changed", screen: "tree" });
    await harness.dispatch({ type: "ui_intent", intent: { type: "issue_query", queryId: "tree", request: { kind: "campaign.tree", query_id: "tree", params: { campaign_id: "thread-campaign", limit: 20 } } }, at: 1 });
    // The root is initially selected; move to the actual child before opening
    // the relation-scoped pane. This is the same real selection state the
    // production TUI refresh closure reads.
    await harness.dispatch({ type: "ui_intent", intent: { type: "select_tree_node", direction: 1 }, at: 3 });
    expect(harness.model.selection.get("tree")?.id).toBe(child);
    await harness.dispatch({ type: "screen_changed", screen: "threads" });
    await harness.dispatch({ type: "ui_intent", intent: { type: "issue_query", queryId: "thread", request: { kind: "bus.thread.history", query_id: "thread", params: { campaign_id: "thread-campaign", parent_node_id: "root", child_node_id: child, limit: 200 } } }, at: 5 });
    await harness.dispatch({ type: "ui_intent", intent: { type: "open_operator_form", command: "bus.thread.send" }, at: 6 });
    expect(harness.model.overlay).toMatchObject({ kind: "operator_form", fields: { expected_thread_version: "origin", from_node_id: child } });
    // Content is the seventh field in the typed, projection-derived form.
    for (let at = 7; at < 13; at++) await harness.dispatch({ type: "ui_intent", intent: { type: "operator_form_next_field", direction: 1 }, at });
    await harness.dispatch({ type: "ui_intent", intent: { type: "operator_form_input", value: "Ready for the next task" }, at: 13 });
    await harness.dispatch({ type: "ui_intent", intent: { type: "submit_operator_form" }, at: 14 });
    const beforeRestart = await (new RuntimePortAdapter(new RuntimeCatalogRouter(runtime))).query({ kind: "bus.thread.history", query_id: "after-send", params: { campaign_id: "thread-campaign", parent_node_id: "root", child_node_id: child, limit: 20 } });
    expect(beforeRestart).toMatchObject({ ok: true, value: { version: expect.any(String), messages: [expect.objectContaining({ author_node_id: child, delivery: "acknowledged", payload_preview: expect.objectContaining({ content: "Ready for the next task" }) })] } });
    await runtime.close();
    const restored = new ArborRuntime({ persistence_dir: tempDir }); await restored.start();
    const afterRestart = new RuntimeCatalogRouter(restored).executeQuery({ schema_version: 1, query_id: "after-restart", query: { kind: "bus.thread.history", campaign_id: "thread-campaign", parent_node_id: "root", child_node_id: child, limit: 20 } });
    expect(afterRestart).toMatchObject({ ok: true, value: { messages: [expect.objectContaining({ payload_preview: expect.objectContaining({ content: "Ready for the next task" }) })] } });
    await restored.close();
  });

  it("submits an entered job through the actual catalog router and scheduler", async () => {
    const runtime = new ArborRuntime();
    const harness = makeHarness(runtime);
    await harness.dispatch({ type: "ui_intent", intent: { type: "open_operator_form", command: "job.submit" }, at: 1 });
    await harness.dispatch({ type: "ui_intent", intent: { type: "operator_form_input", value: "operator-job" }, at: 2 });
    await harness.dispatch({ type: "ui_intent", intent: { type: "operator_form_next_field", direction: 1 }, at: 3 });
    await harness.dispatch({ type: "ui_intent", intent: { type: "operator_form_input", value: "operator-scope" }, at: 4 });
    await harness.dispatch({ type: "ui_intent", intent: { type: "submit_operator_form" }, at: 5 });

    expect(harness.model.overlay).toBeNull();
    const submitted = runtime.jobScheduler.view({ include_terminal: true }).jobs;
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ kind: "operator-job", owner_scope_id: "operator-scope" });
  });

  it("accepts raw keyboard form input through runTui and persists the submitted job", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-tui-form-"));
    const persistenceDir = resolvePersistenceDir(tempDir);
    const stdin = new PassThrough();
    let output = "";
    const stdout = new PassThrough(); stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const stderr = new PassThrough(); stderr.on("data", () => {});
    const done = runTui({ cwd: tempDir, persistence_dir: persistenceDir, stdin, stdout, stderr });
    await expect.poll(() => output, { timeout: 15_000 }).toContain("Esc blur");

    // Console owns the keyboard from its first frame (tui.ts), so release it
    // before the bare command key.
    const beforeBlur = output.length;
    stdin.write("\u001b");
    await expect.poll(() => output.slice(beforeBlur), { timeout: 5_000 }).toContain("Enter focus");
    // s opens job.submit; Tab advances the typed form; Enter dispatches it.
    stdin.write("sraw-job\traw-scope\n");
    await new Promise((resolve) => setTimeout(resolve, 120));
    stdin.end();
    expect(await done).toBe(0);

    const verify = new ArborRuntime({ persistence_dir: persistenceDir, devtools_logger: { persistence_dir: persistenceDir, disable_fsync: true } });
    await verify.start();
    expect(verify.jobScheduler.view({ include_terminal: true }).jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "raw-job", owner_scope_id: "raw-scope" }),
    ]));
    await verify.close();
  });

  it("uses selected output plus a durable approved disclosure for raw review", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-tui-raw-review-"));
    const runtime = new ArborRuntime({ persistence_dir: tempDir });
    const router = new RuntimeCatalogRouter(runtime);
    const captured = await router.dispatchCommand({
      schema_version: 1, metadata: { operation_id: "capture-1", idempotency_key: "capture-1", correlation_id: "capture-1", actor_id: "seed", requested_at: "2026-08-08T00:00:00.000Z" },
      command: { kind: "output.capture", artifact: { campaign_id: "c1", node_id: "n1", stream: "stdout", media_type: "text/plain", provenance: { tag: "claimed", claimant: "seed" } }, content: "approved raw material" },
    });
    if (!captured.ok || !captured.value.accepted || !("output" in captured.value)) throw new Error("capture failed");
    const evidenceId = captured.value.output.descriptor.id;
    const requested = runtime.approvals.request({ request_id: "raw-review", idempotency_key: "raw-review", action: "output.raw", subject: "incident review", resource_id: evidenceId, proposer: "external-operator", rationale: "investigate evidence", expires_at: "2099-01-01T00:00:00.000Z" });
    if (!requested.ok) throw new Error(requested.error);
    const approved = runtime.approvals.approve({ request_id: "raw-review", actor: "external-auditor", clock: runtime.approvals.now() });
    if (!approved.ok) throw new Error(approved.error);

    const harness = makeHarness(runtime);
    await harness.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "output" }, at: 1 });
    await harness.dispatch({ type: "ui_intent", intent: { type: "issue_query", queryId: "outputs", request: { kind: "output.list", query_id: "outputs", params: {} } }, at: 2 });
    expect(harness.model.selection.get("output")?.id).toBe(evidenceId);
    await harness.dispatch({ type: "ui_intent", intent: { type: "open_operator_form", command: "output.raw" }, at: 3 });
    expect(harness.model.overlay).toMatchObject({ kind: "operator_form", fields: { evidence_id: evidenceId } });
    await harness.dispatch({ type: "ui_intent", intent: { type: "operator_form_next_field", direction: 1 }, at: 4 });
    await harness.dispatch({ type: "ui_intent", intent: { type: "operator_form_input", value: "raw-review" }, at: 5 });
    await harness.dispatch({ type: "ui_intent", intent: { type: "submit_operator_form" }, at: 6 });
    expect(harness.model.screens.get("output")).toMatchObject({ evidence_id: evidenceId, content: "approved raw material" });
  });

  // IS-05/DEF-08 closure check: `screens/output.ts`'s own comment claims
  // `output.descriptor` "has no live caller yet" and that wiring one is a
  // `tui.ts` change out of scope for that file. That undersells what's
  // already real: the SAME `view_selected_row_detail` intent this suite's
  // raw-review test above rides in on (via the selection it seeds) already
  // has an `output` branch in update.ts that dispatches output.descriptor
  // off the selected row's evidence_id -- no approval needed, unlike
  // output.raw. Enter (VIEW_ROW_DETAIL_ACTION_ID, tui.ts:1111) is the real
  // production trigger; this proves the whole path, not just the reducer.
  it("uses the selected output row to render output.descriptor's real record, no approval required (IS-05/DEF-08)", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-tui-output-descriptor-"));
    const runtime = new ArborRuntime({ persistence_dir: tempDir });
    const router = new RuntimeCatalogRouter(runtime);
    const captured = await router.dispatchCommand({
      schema_version: 1, metadata: { operation_id: "capture-2", idempotency_key: "capture-2", correlation_id: "capture-2", actor_id: "seed", requested_at: "2026-08-08T00:00:00.000Z" },
      command: { kind: "output.capture", artifact: { campaign_id: "c1", node_id: "n1", stream: "stdout", media_type: "text/plain", provenance: { tag: "claimed", claimant: "seed" } }, content: "descriptor-only preview material" },
    });
    if (!captured.ok || !captured.value.accepted || !("output" in captured.value)) throw new Error("capture failed");
    const evidenceId = captured.value.output.descriptor.id;

    const harness = makeHarness(runtime);
    await harness.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "output" }, at: 1 });
    await harness.dispatch({ type: "ui_intent", intent: { type: "issue_query", queryId: "outputs", request: { kind: "output.list", query_id: "outputs", params: {} } }, at: 2 });
    expect(harness.model.selection.get("output")?.id).toBe(evidenceId);

    await harness.dispatch({ type: "ui_intent", intent: { type: "view_selected_row_detail" }, at: 3 });
    expect(harness.model.screens.get("output")).toMatchObject({ descriptor: { id: evidenceId } });
    // Descriptor reads never disclose blob content (roadmap 4B.3) -- only
    // an approved output.raw query (tested above) can, which is why this
    // must NOT carry a `content` field the way the raw-review result does.
    expect(harness.model.screens.get("output")).not.toHaveProperty("content");
  });

  it("halts only after a matching independently-decided approval and confirmation", async () => {
    const runtime = new ArborRuntime();
    runtime.manager.startCampaign("halt-campaign", "plan.md", { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" });
    const requested = runtime.approvals.request({ request_id: "halt-review", idempotency_key: "halt-review", action: "campaign.halt", subject: "emergency stop", resource_id: "halt-campaign", proposer: "external-operator", rationale: "safety stop", expires_at: "2099-01-01T00:00:00.000Z" });
    if (!requested.ok) throw new Error(requested.error);
    const approved = runtime.approvals.approve({ request_id: "halt-review", actor: "external-auditor", clock: runtime.approvals.now() });
    if (!approved.ok) throw new Error(approved.error);
    const harness = makeHarness(runtime);
    await harness.dispatch({ type: "ui_intent", intent: { type: "open_operator_form", command: "campaign.halt" }, at: 1 });
    await harness.dispatch({ type: "ui_intent", intent: { type: "operator_form_input", value: "halt-campaign" }, at: 2 });
    await harness.dispatch({ type: "ui_intent", intent: { type: "operator_form_next_field", direction: 1 }, at: 3 });
    await harness.dispatch({ type: "ui_intent", intent: { type: "operator_form_input", value: "halt-review" }, at: 4 });
    await harness.dispatch({ type: "ui_intent", intent: { type: "submit_operator_form" }, at: 5 });
    expect(runtime.manager.getCampaignSnapshot("halt-campaign")?.halted).toBe(false);
    await harness.dispatch({ type: "ui_intent", intent: { type: "confirm_pending_action" }, at: 6 });
    expect(runtime.manager.getCampaignSnapshot("halt-campaign")).toMatchObject({ halted: true, halt_reason: "manual" });
  });

  it("records this cockpit as proposer and cannot approve its own selected request", async () => {
    const runtime = new ArborRuntime();
    const harness = makeHarness(runtime);
    await harness.dispatch({ type: "ui_intent", intent: { type: "open_operator_form", command: "approval.request" }, at: 1 });
    for (const [value, at] of [["campaign.halt", 2], ["halt campaign", 3], ["c1", 4], ["safety review", 5], ["2099-01-01T00:00:00.000Z", 6]] as const) {
      await harness.dispatch({ type: "ui_intent", intent: { type: "operator_form_input", value }, at });
      await harness.dispatch({ type: "ui_intent", intent: { type: "operator_form_next_field", direction: 1 }, at });
    }
    await harness.dispatch({ type: "ui_intent", intent: { type: "submit_operator_form" }, at: 7 });
    const [requested] = runtime.approvals.list({});
    expect(requested).toMatchObject({ proposer: expect.stringMatching(/^local-session:/), status: "pending" });
    await harness.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "approvals" }, at: 8 });
    await harness.dispatch({ type: "ui_intent", intent: { type: "issue_query", queryId: "approvals", request: { kind: "approval.list", query_id: "approvals", params: {} } }, at: 9 });
    expect(harness.model.selection.get("approvals")?.id).toBe(requested.request_id);
    await harness.dispatch({ type: "ui_intent", intent: { type: "approve_selected" }, at: 10 });
    expect(runtime.approvals.get(requested.request_id)?.status).toBe("pending");
  });
});
