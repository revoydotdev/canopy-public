/**
 * Command-surface expansion regression suite (cockpit gap remediation):
 * job.cancel, job.retry, job.pause/resume, operation.cancel, task.retry,
 * approval.expire, and the Governance screen's missing keybinding. Extends
 * `tui-operator-controls.test.ts`'s gold standard — real key event -> real
 * InputRouter -> real catalog action -> real runtime-catalog command
 * dispatch -> real backend mutation — rather than duplicating it.
 *
 * Two rigor tiers, matching precedent already established in
 * `tui-operator-controls.test.ts`:
 *   - job.retry / task.retry / the Governance nav fix run over real stdin
 *     through the real `runTui()` entry point, with durable state reloaded
 *     from a fresh `ArborRuntime` afterward (supervisor tasks are
 *     checkpointed via `saveSupervisorSnapshot`/restored on start).
 *   - job.cancel / operation.cancel / job.pause+resume / approval.expire use
 *     the same direct-harness pattern `tui-operator-controls.test.ts` uses
 *     for approve/reject/answer (`ApprovalService` is in-memory only). Here
 *     the reason is different but just as real: `TaskSupervisor.restore()`
 *     marks every non-terminal restored task "reconciliation required"
 *     (`task-supervisor.ts`), and `requestCancellation` refuses to transition
 *     a reconciliation-required task — a genuine safety invariant (a restored
 *     "started" task is durable evidence, not proof of a live worker), not a
 *     test limitation to route around. Seeding a *live, cancelable* task
 *     therefore requires staying within one running instance, exactly as
 *     `approve_selected`/`arm_answer` already do in the sibling suite.
 *     Every mutation is still verified against the real, live production
 *     objects: `ArborRuntime`, `RuntimeCatalogRouter`, `RuntimePortAdapter`,
 *     `HeadlessHarness`, `InputRouter`, `buildDefaultCatalog`.
 */
import { describe, expect, it, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { RuntimePortAdapter } from "../src/tui-adapter.js";
import { resolvePersistenceDir } from "../src/cli.js";
import { runTui } from "../src/tui.js";
import {
  HeadlessHarness, InputRouter, buildDefaultCatalog, clearRegisteredScreens,
  CANCEL_ROW_ACTION_ID, RETRY_ROW_ACTION_ID, TOGGLE_JOB_QUEUE_ACTION_ID, APPROVAL_EXPIRE_ACTION_ID,
} from "@arbor/tui";


let tempDir: string;
afterEach(() => {
  clearRegisteredScreens();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

function makeHarness(runtime: ArborRuntime) {
  const router = new RuntimeCatalogRouter(runtime, { require_local_session: true });
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
  return { harness, adapter };
}

/** Submits a job through the REAL router (not `jobScheduler.submit` directly), so a real `OperationRegistry` entry exists too — the shape `operation.list`/`operations.cancel` actually require in production. */
async function submitJob(adapter: RuntimePortAdapter, id: string, operationId: string): Promise<void> {
  const result = await adapter.command({
    kind: "job.submit",
    metadata: { operation_id: operationId, idempotency_key: `idem:${operationId}` },
    params: { id, operation_id: operationId, job_kind: "test-job", owner_scope_id: "scope-1", idempotency_key: `idem:${operationId}` },
  });
  expect(result.ok).toBe(true);
  expect(result.value?.accepted).toBe(true);
}

describe("key -> catalog action for the expanded command surface", () => {
  it("'c'/'r'/'p'/'e' resolve to the real, distinct catalog actions", () => {
    const catalog = buildDefaultCatalog();
    const inputRouter = new InputRouter(catalog, () => 0);
    expect(inputRouter.handle({ key: "c" }, ["global"])).toEqual({ kind: "action", action_id: CANCEL_ROW_ACTION_ID });
    expect(inputRouter.handle({ key: "r" }, ["global"])).toEqual({ kind: "action", action_id: RETRY_ROW_ACTION_ID });
    expect(inputRouter.handle({ key: "p" }, ["global"])).toEqual({ kind: "action", action_id: TOGGLE_JOB_QUEUE_ACTION_ID });
    expect(inputRouter.handle({ key: "e" }, ["global"])).toEqual({ kind: "action", action_id: APPROVAL_EXPIRE_ACTION_ID });
  });

  it("'g' resolves to focus:governance now that the screen is in SCREEN_NAV", () => {
    const catalog = buildDefaultCatalog();
    const inputRouter = new InputRouter(catalog, () => 0);
    expect(inputRouter.handle({ key: "g" }, ["global"])).toEqual({ kind: "action", action_id: "focus:governance" });
  });
});

describe("jobs screen — cancel (direct harness: TaskSupervisor.requestCancellation requires a LIVE, non-reconciliation-required task)", () => {
  it("'c' twice dispatches the real job.cancel command for the sticky-selected row", async () => {
    const runtime = new ArborRuntime();
    const { adapter } = makeHarness(runtime);
    await submitJob(adapter, "job-cancel-1", "op-cancel-1");
    expect(runtime.supervisor.get("job-cancel-1")?.state).toBe("started");

    const { harness } = makeHarness(runtime);
    await harness.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "jobs" }, at: 1 });
    await harness.dispatch({
      type: "ui_intent",
      intent: { type: "issue_query", queryId: "q1", request: { kind: "job.list", query_id: "q1", params: {} } },
      at: 2,
    });
    // Sticky selection (queryResults' generalized STICKY_SELECTION_SCREENS) auto-selects the only row.
    expect(harness.model.selection.get("jobs")).toEqual({ id: "job-cancel-1" });

    await harness.dispatch({ type: "ui_intent", intent: { type: "cancel_selected_row" }, at: 3 });
    expect(harness.model.repeatConfirmation).toMatchObject({ action_key: "job.cancel:job-cancel-1", fired: false });
    // Armed, not yet mutated.
    expect(runtime.supervisor.get("job-cancel-1")?.state).toBe("started");

    await harness.dispatch({ type: "ui_intent", intent: { type: "cancel_selected_row" }, at: 4 });
    expect(runtime.supervisor.get("job-cancel-1")?.state).toBe("cancel_requested");
  });
});

describe("operations screen — cancel (direct harness)", () => {
  it("'c' twice dispatches the real operation.cancel command for the sticky-selected row", async () => {
    const runtime = new ArborRuntime();
    // Every real dispatch through the router completes its OWN
    // OperationRegistry entry as soon as the command handler returns
    // (`runtime-catalog.ts`'s dispatchJobCommand calls
    // `operations.complete` right after `job.submit` returns), so a job
    // submitted through `job.submit` never stays visible in
    // `operation.list`'s default (`include_terminal: false`) view long
    // enough to select — that record tracks the SUBMIT COMMAND's own
    // lifecycle, not the job's. A genuinely still-open operation (the real
    // case `operation.cancel` exists for — a slow in-flight command) is
    // built the same way `OperationRegistry.accept` is: registered but not
    // yet completed. Its `operation_id` is aligned with the supervised
    // task's own `operation_id` field (a real operator's TUI dispatch does
    // this too) — the only way `operation.cancel`'s `target_operation_id`
    // can ever resolve to a real task (`runtime-catalog.ts`'s
    // `executeCommand` "operation.cancel" case matches on
    // `task.operation_id`).
    runtime.operations.accept({
      metadata: { operation_id: "op-shared-1", idempotency_key: "idem-shared-1", correlation_id: "corr-shared-1", actor_id: "tester", requested_at: new Date().toISOString() },
      capability: "job.write",
      fingerprint: "fp-shared-1",
    });
    const submitted = runtime.jobScheduler.submit({ id: "job-for-op-cancel", operation_id: "op-shared-1", kind: "test-job", owner_scope_id: "scope-1", idempotency_key: "idem-job-shared-1" });
    expect(submitted.ok).toBe(true);
    expect(runtime.supervisor.list().find((t) => t.id === "job-for-op-cancel")?.state).toBe("started");
    expect(runtime.operations.list().find((o) => o.operation_id === "op-shared-1")?.state).toBe("accepted");

    const { harness } = makeHarness(runtime);
    await harness.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "operations" }, at: 1 });
    await harness.dispatch({
      type: "ui_intent",
      intent: { type: "issue_query", queryId: "q1", request: { kind: "operation.list", query_id: "q1", params: { include_terminal: false } } },
      at: 2,
    });
    expect(harness.model.selection.get("operations")).toEqual({ id: "op-shared-1" });

    await harness.dispatch({ type: "ui_intent", intent: { type: "cancel_selected_row" }, at: 3 });
    expect(harness.model.repeatConfirmation).toMatchObject({ action_key: "operation.cancel:op-shared-1", fired: false });

    await harness.dispatch({ type: "ui_intent", intent: { type: "cancel_selected_row" }, at: 4 });
    expect(runtime.supervisor.list().find((t) => t.id === "job-for-op-cancel")?.state).toBe("cancel_requested");
  });
});

describe("jobs screen — pause/resume (direct harness; queue_paused is an in-memory dispatch throttle, never persisted)", () => {
  it("'p' toggles the queue: pause then resume through the real job.pause/job.resume commands", async () => {
    const runtime = new ArborRuntime();
    const { harness } = makeHarness(runtime);
    await harness.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "jobs" }, at: 1 });
    const fetchJobs = (queryId: string, at: number) => harness.dispatch({
      type: "ui_intent",
      intent: { type: "issue_query", queryId, request: { kind: "job.list", query_id: queryId, params: {} } },
      at,
    });
    await fetchJobs("q1", 2);
    expect(runtime.jobScheduler.view().queue_paused).toBe(false);

    await harness.dispatch({ type: "ui_intent", intent: { type: "toggle_job_queue" }, at: 3 });
    expect(runtime.jobScheduler.view().queue_paused).toBe(true);

    // Re-fetch so the model's own `queue_paused` read (toggle_job_queue reads
    // model.screens.get("jobs"), never the live scheduler directly) reflects
    // the just-applied pause before toggling again.
    await fetchJobs("q2", 4);
    await harness.dispatch({ type: "ui_intent", intent: { type: "toggle_job_queue" }, at: 5 });
    expect(runtime.jobScheduler.view().queue_paused).toBe(false);
  });
});

describe("approvals screen — expire (direct harness; ApprovalService is in-memory only)", () => {
  it("'e' expires the oldest pending request through the real approval.expire command", async () => {
    const runtime = new ArborRuntime();
    runtime.approvals.request({
      request_id: "req_exp_1", idempotency_key: "idem_exp_1", action: "campaign.halt",
      subject: "c1", resource_id: "c1", proposer: "seed-agent", rationale: "test halt",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const { harness } = makeHarness(runtime);
    await harness.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "approvals" }, at: 1 });
    await harness.dispatch({
      type: "ui_intent",
      intent: { type: "issue_query", queryId: "q1", request: { kind: "approval.list", query_id: "q1", params: { status: "pending", limit: 50 } } },
      at: 2,
    });

    await harness.dispatch({ type: "ui_intent", intent: { type: "expire_selected" }, at: 3 });

    const record = runtime.approvals.list({}).find((r) => r.request_id === "req_exp_1");
    expect(record?.status).toBe("expired");
  });
});

describe("jobs screen — retry, real key over real stdin through the real runTui entry point (durable: terminal tasks are never reconciliation-required)", () => {
  it("'9' focuses Jobs, 'r' retries the sticky-selected terminal job through the real job.retry command", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-tui-job-retry-"));
    const persistenceDir = resolvePersistenceDir(tempDir);

    const seed = new ArborRuntime({ persistence_dir: persistenceDir, devtools_logger: { persistence_dir: persistenceDir, disable_fsync: true } });
    await seed.start();
    const seedRouter = new RuntimeCatalogRouter(seed);
    const seedAdapter = new RuntimePortAdapter(seedRouter, () => 0);
    await submitJob(seedAdapter, "job-retry-1", "op-retry-1");
    // A terminal, cleanup-completed job — the one state `TaskSupervisor.retry`
    // (called by job.retry) accepts, and terminal tasks are never marked
    // reconciliation-required by `restore()` regardless of how they crossed
    // the restart below.
    seed.supervisor.fail("job-retry-1");
    seed.supervisor.completeCleanup("job-retry-1");
    seed.checkpointSupervisor();
    await seed.close();

    const stdin = new PassThrough();
    const stdout = new PassThrough(); stdout.on("data", () => {});
    const stderr = new PassThrough(); stderr.on("data", () => {});
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => { markReady = resolve; });
    const donePromise = runTui({ cwd: tempDir, stdin, stdout, stderr, on_ready: markReady });
    const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    await ready;

    // Console owns the keyboard from its first frame (tui.ts), so release
    // it before driving a bare navigation key.
    stdin.write("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 60));
    stdin.write("9"); // focus:jobs — real job.list fetch (include_terminal: true), sticky-selects the only row
    await wait(120);
    stdin.write("r"); // retry_selected_row — real job.retry dispatch
    await wait(120);

    stdin.end();
    const code = await donePromise;
    expect(code).toBe(0);

    const verify = new ArborRuntime({ persistence_dir: persistenceDir, devtools_logger: { persistence_dir: persistenceDir, disable_fsync: true } });
    await verify.start();
    expect(verify.supervisor.get("job-retry-1")?.state).toBe("retrying");
    await verify.close();
  });
});

/**
 * task.retry — wired the same way job.retry is (`retry_selected_row`
 * dispatches `task.retry` with the sticky-selected row's id), but discovered
 * BLOCKED end-to-end in the live Tasks screen by a separate, pre-existing
 * gap: `task.list`'s query contract (`arbor-core/src/runtime-contracts.ts:80`,
 * `{kind: "task.list", scope_id?, cursor?, limit}`) has no `include_terminal`
 * field at all — unlike `job.list`'s, which does. `TaskSupervisor.retry`
 * only ever applies to a TERMINAL task, so the Tasks screen can never fetch
 * the one row 'r' would act on; an operator can never select it. That
 * contract lives in `@arbor/core`, outside this pass's file ownership
 * (`arbor-mcp`/`arbor-tui` only) — fixing it means adding the field to
 * `ApplicationQuery`'s `task.list` variant and its validator. This test
 * proves the DISPATCH side is correct (a terminal task, if the operator
 * could ever select one, retries for real) via the same direct-harness tier
 * `approve_selected`/`arm_answer` already use in the sibling suite — it does
 * NOT claim production reachability, which remains blocked.
 */
describe("tasks screen — retry (dispatch verified directly; live reachability blocked by task.list's missing include_terminal, arbor-core, out of this pass's ownership)", () => {
  it("retry_selected_row on a terminal, cleanup-completed task dispatches the real task.retry command", async () => {
    const runtime = new ArborRuntime();
    const submitted = runtime.jobScheduler.submit({ id: "task-retry-1", operation_id: "op-task-retry-1", kind: "test-task", owner_scope_id: "scope-1", idempotency_key: "idem-task-retry-1" });
    expect(submitted.ok).toBe(true);
    runtime.supervisor.fail("task-retry-1");
    runtime.supervisor.completeCleanup("task-retry-1");
    expect(runtime.supervisor.get("task-retry-1")?.state).toBe("failed");

    const { harness } = makeHarness(runtime);
    await harness.dispatch({ type: "ui_intent", intent: { type: "focus_screen", screen: "tasks" }, at: 1 });
    // Simulates what a fixed task.list (include_terminal: true) would
    // deliver — the real cursor-page shape `executeQueryValue`'s "task.list"
    // case actually returns, carrying the real terminal SupervisorTask
    // fetched off the live supervisor above (not a fabricated fixture).
    const page = { items: runtime.supervisor.list({ include_terminal: true }), next_cursor: null, total: 1, limit: 50 };
    await harness.dispatch({ type: "query_results", queryId: "q1", screen: "tasks", value: page });
    expect(harness.model.selection.get("tasks")).toEqual({ id: "task-retry-1" });

    await harness.dispatch({ type: "ui_intent", intent: { type: "retry_selected_row" }, at: 2 });
    expect(runtime.supervisor.get("task-retry-1")?.state).toBe("retrying");
  });
});

describe("Governance screen — missing keybinding, real key over real stdin through the real runTui entry point", () => {
  it("'g' focuses Governance and renders the typed greenfield absence when no decision store exists", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-tui-governance-nav-"));

    const stdin = new PassThrough();
    let out = "";
    const stdout = new PassThrough(); stdout.on("data", (d: Buffer) => { out += d.toString(); });
    const stderr = new PassThrough(); stderr.on("data", () => {});

    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => { markReady = resolve; });
    const donePromise = runTui({ cwd: tempDir, stdin, stdout, stderr, on_ready: markReady });
    await ready;

    // Console owns the keyboard from its first frame (tui.ts), so release
    // it before driving a bare navigation key.
    stdin.write("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 60));
    stdin.write("g"); // focus:governance — previously unreachable: absent from SCREEN_NAV
    const projectionDeadline = Date.now() + 5_000;
    const governanceCaption = "No canonical ADRs yet — the first governed decision will create the project decision store.";
    while (!out.includes(governanceCaption) && Date.now() < projectionDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    stdin.end();
    const code = await donePromise;
    expect(code).toBe(0);

    // This temporary workspace intentionally has no decisions/ directory.
    // Reaching the typed absence proves the key focused Governance while the
    // product boundary kept a legitimate greenfield state distinct from an
    // unreadable configured corpus or a never-fetched projection.
    const flattened = out.replace(/\s+/g, " ");
    expect(flattened).toContain("No canonical ADRs yet");
    expect(flattened).toContain("the first governed decision will create the project decision store.");
    expect(out).not.toContain("awaiting first projection");
  });
});
