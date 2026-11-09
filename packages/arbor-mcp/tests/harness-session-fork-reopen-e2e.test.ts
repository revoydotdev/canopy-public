/**
 * A session fork reopens a campaign that halted because its search ran out
 * (`no_nodes`, `converged`) and is refused, with its ADR-179 typed remedy,
 * for every other halt (operator decision 2026-10-06; ADR-043 amendment,
 * fork reopen).
 *
 * Everything after the provider boundary is production code: the real
 * `createCliRuntime` composition, its `RuntimeCatalogRouter` commands and
 * queries, the supervised campaign job, `NativeAgentExecutor` and the native
 * worker. Only `fetch` is replaced, by a deterministic offline
 * OpenAI-compatible provider, so no request leaves the process.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action } from "@arbor/core";
import { CAMPAIGN_RUN_JOB_KIND } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { createCliRuntime } from "../src/cli.js";

const rootAction: Action = { description: "Root reopen fixture", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
const architectAction = (description: string): Action => ({ description, estimated_gain: 2, estimated_cost: 1, category: "architecture", delegate_to: "seed", execution_role: "architect" });

const meta = (id: string) => ({ operation_id: id, idempotency_key: id, actor_id: "operator", correlation_id: id, requested_at: "2026-10-06T00:00:00.000Z", session: {} });
const generated = (id: string) => ({ tag: "generated" as const, generator: "fork-reopen-e2e", input_hash: `sha256:${id}` });

type Body = Record<string, unknown>;
interface ChatMessage { readonly role: string; readonly content: unknown }
const chat = (body: Body): readonly ChatMessage[] => body.messages as readonly ChatMessage[];
const systemPrompt = (body: Body): string => String(chat(body).find((message) => message.role === "system")?.content ?? "");
const sse = (content: string): Response => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }], usage: { prompt_tokens: 11, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });

function approval(): string {
  const check = (name: string) => ({ name, passed: true, detail: "fixture" });
  return JSON.stringify({
    approved: true, rationale: "bounded fixture review passed", root_cause: null, measurement_validated: true, guardrails_enforced: true, introspection_passed: true, stability_ok: true,
    checks: ["root_cause", "measurement_validation", "guardrail_enforcement", "introspection", "stability_monitoring"].map(check),
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

async function waitUntil(predicate: () => boolean, message: string, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const repos: string[] = [];
const originalFetch = globalThis.fetch;
const previousKey = process.env.ARBOR_NATIVE_API_KEY;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousKey === undefined) delete process.env.ARBOR_NATIVE_API_KEY; else process.env.ARBOR_NATIVE_API_KEY = previousKey;
  for (const repo of repos.splice(0)) {
    spawnSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" });
    rmSync(repo, { recursive: true, force: true });
  }
});

type Answer = (body: Body, call: number) => Promise<string>;

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "arbor-fork-reopen-e2e-"));
  repos.push(repo);
  writeFileSync(join(repo, "arbor.jsonc"), JSON.stringify({
    native: { mode: "native", adapter_id: "openai-compatible", provider_id: "fixture-provider", base_url: "http://native-provider.invalid/v1", model: "default-native-model" },
  }), "utf8");
  spawnSync("git", ["init", "-q", repo], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "config", "user.name", "Fork reopen test"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "commit", "-qm", "fixture"], { stdio: "ignore" });
  return repo;
}

/** The production runtime over `repo`, with an offline provider whose critic always approves. */
function compose(repo: string, answer: Answer) {
  const specialistBodies: Body[] = [];
  process.env.ARBOR_NATIVE_API_KEY = "native-test-secret";
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as Body;
    if (systemPrompt(body).includes("Role: critic-reviewer")) return sse(approval());
    specialistBodies.push(body);
    return sse(await answer(body, specialistBodies.length));
  }) as typeof fetch;
  const runtime = createCliRuntime(repo);
  delete process.env.ARBOR_NATIVE_API_KEY;
  return { runtime, router: new RuntimeCatalogRouter(runtime), specialistBodies };
}

type Router = RuntimeCatalogRouter;
async function command(router: Router, id: string, payload: Record<string, unknown>, expectedVersion?: string) {
  return router.dispatchCommand({ schema_version: 1, metadata: { ...meta(id), ...(expectedVersion === undefined ? {} : { expected_version: expectedVersion }) }, command: payload } as never);
}
function query<T>(router: Router, payload: Record<string, unknown>): T {
  const result = router.executeQuery({ schema_version: 1, query_id: `q-${String(payload.kind)}`, query: payload } as never);
  if (!result.ok) throw new Error(`${String(payload.kind)} failed: ${JSON.stringify(result)}`);
  return result.value as T;
}
interface SessionRow { readonly session_id: string; readonly node_id: string; readonly operation: string; readonly state: string }
const sessions = (router: Router, campaignId: string): readonly SessionRow[] => query<{ sessions: readonly SessionRow[] }>(router, { kind: "harness.session.list", campaign_id: campaignId, limit: 50 }).sessions;
function jobState(router: Router, jobId: string): string | null {
  return query<{ jobs: readonly { id: string; state: string }[] }>(router, { kind: "job.list", include_terminal: true }).jobs.find((job) => job.id === jobId)?.state ?? null;
}
const availability = (router: Router, sessionId: string) => query<{ fork: boolean; reason: string }>(router, { kind: "harness.session.availability", session_id: sessionId });
const fork = (router: Router, id: string, sessionId: string) => command(router, id, { kind: "harness.session.fork", session_id: sessionId, reason: "try another direction", dispositions: [], provenance: generated(id) });

async function startCampaign(router: Router, campaignId: string, actions: readonly Action[], config?: Record<string, unknown>): Promise<void> {
  expect(await command(router, `${campaignId}-start`, { kind: "campaign.start", campaign_id: campaignId, plan_path: "plan.md", root_action: rootAction, ...(config === undefined ? {} : { config }) })).toMatchObject({ ok: true });
  expect(await command(router, `${campaignId}-branch`, { kind: "tree.branch", campaign_id: campaignId, node_id: "root", actions })).toMatchObject({ ok: true });
}
async function runToCompletion(router: Router, campaignId: string, jobId: string): Promise<void> {
  expect(await command(router, jobId, { kind: "job.submit", id: jobId, operation_id: jobId, job_kind: CAMPAIGN_RUN_JOB_KIND, owner_scope_id: campaignId, idempotency_key: jobId })).toMatchObject({ ok: true, value: { accepted: true, dispatched: true } });
  await waitUntil(() => ["completed", "failed", "cancelled"].includes(jobState(router, jobId) ?? ""), `${jobId} settled`);
}

/** A single-node campaign run until it halts `no_nodes`, plus its completed specialist session. */
async function haltedNoNodes(router: Router, runtime: ReturnType<typeof compose>["runtime"], campaignId: string) {
  await startCampaign(router, campaignId, [architectAction("Plan the only node")]);
  await runToCompletion(router, campaignId, `${campaignId}-job`);
  expect(runtime.manager.getCampaignSnapshot(campaignId)).toMatchObject({ halted: true, halt_reason: "no_nodes" });
  const source = sessions(router, campaignId).find((row) => row.operation === "specialize" && row.state === "completed")!;
  expect(source).toBeDefined();
  return source;
}

describe("a session fork reopens a no_nodes or converged halt and no other", { timeout: 60_000 }, () => {
  it("reopens a no_nodes halt: a typed operator transition, a dispatched child, and budget carried on", async () => {
    const { runtime, router, specialistBodies } = compose(initRepo(), async () => "plan complete");
    const campaignId = "reopen-no-nodes";
    const source = await haltedNoNodes(router, runtime, campaignId);
    const before = runtime.manager.getCampaignSnapshot(campaignId)!;
    const elapsedBefore = runtime.manager.haltStatus(campaignId).elapsed_seconds;
    const requestsBefore = specialistBodies.length;

    expect(availability(router, source.session_id)).toMatchObject({ fork: true, reason: expect.stringContaining("reopens this no_nodes halt") });
    expect(await fork(router, "fork-reopen-1", source.session_id)).toMatchObject({ ok: true, value: { accepted: true, operation_id: "fork-reopen-1" } });

    // (a) the typed, attributable transition, naming the operator, the halt
    // it overrides and the forked child it was made for.
    const child = runtime.manager.getCampaignSnapshot(campaignId)!.nodes.find((node) => node.parent_id === source.node_id)!;
    expect(child).toBeDefined();
    const reopens = runtime.manager.getCampaignReopens(campaignId);
    expect(reopens).toHaveLength(1);
    expect(reopens[0]).toMatchObject({ kind: "campaign_reopen", node_id: child.id, reopen: { phase: "reopened", actor: "operator", authority: "operator", overridden_halt_reason: "no_nodes", source_session_id: source.session_id, operation_id: "fork-reopen-1" } });

    // (b)+(c) the halt cleared and selection dispatched the forked child as a
    // fresh continuation session.
    await waitUntil(() => sessions(router, campaignId).some((row) => row.node_id === child.id && row.operation === "specialize" && row.state === "completed"), "forked child session completed");
    const forked = sessions(router, campaignId).find((row) => row.node_id === child.id && row.operation === "specialize")!;
    expect(forked.session_id).toMatch(/^continuation:fork-[0-9a-f]{32}$/);
    expect(specialistBodies.length).toBe(requestsBefore + 1);

    // The reopened run settles on its own halt; nothing was reverted, and
    // neither the campaign clock nor its iteration count started over.
    await waitUntil(() => runtime.manager.getCampaignSnapshot(campaignId)!.halted, "reopened campaign halted again");
    const after = runtime.manager.getCampaignSnapshot(campaignId)!;
    expect(after.iterations_completed).toBeGreaterThan(before.iterations_completed);
    expect(runtime.manager.haltStatus(campaignId).elapsed_seconds).toBeGreaterThanOrEqual(elapsedBefore);
    expect(runtime.manager.getCampaignReopens(campaignId).map((record) => record.reopen.phase)).toEqual(["reopened"]);
  });

  it("reopens a converged halt without re-halting on convergence before the forked child runs", async () => {
    const { runtime, router } = compose(initRepo(), async () => "plan complete");
    const campaignId = "reopen-converged";
    await startCampaign(router, campaignId, [architectAction("Plan the converged node")], { convergence_iterations: 1 });
    await runToCompletion(router, campaignId, `${campaignId}-job`);
    const halted = runtime.manager.getCampaignSnapshot(campaignId)!;
    expect(halted).toMatchObject({ halted: true, halt_reason: "converged" });
    expect(halted.iterations_without_kb_entry).toBeGreaterThanOrEqual(1);
    const source = sessions(router, campaignId).find((row) => row.operation === "specialize" && row.state === "completed")!;

    expect(availability(router, source.session_id)).toMatchObject({ fork: true, reason: expect.stringContaining("reopens this converged halt") });
    expect(await fork(router, "fork-reopen-converged", source.session_id)).toMatchObject({ ok: true, value: { accepted: true } });
    const child = runtime.manager.getCampaignSnapshot(campaignId)!.nodes.find((node) => node.parent_id === source.node_id)!;
    expect(runtime.manager.getCampaignReopens(campaignId)[0]).toMatchObject({
      node_id: child.id,
      reopen: { phase: "reopened", overridden_halt_reason: "converged", iterations_without_kb_entry: { before: halted.iterations_without_kb_entry, after: 0 } },
    });

    // Had the counter stayed at convergence_iterations, the loop's first halt
    // check would have re-halted `converged` with the child still pending.
    await waitUntil(() => sessions(router, campaignId).some((row) => row.node_id === child.id && row.operation === "specialize" && row.state === "completed"), "forked child session completed");
    await waitUntil(() => runtime.manager.getCampaignSnapshot(campaignId)!.halted, "reopened campaign halted again");
    expect(runtime.manager.getNodeInfo(campaignId, child.id)?.state).not.toBe("pending");
  });

  it("refuses a fork after a manual halt, with the planner's typed remedy, and creates nothing", async () => {
    const holdB = deferred();
    const bStarted = deferred();
    const { runtime, router } = compose(initRepo(), async (body) => {
      if (JSON.stringify(body).includes("Plan fixture B")) { bStarted.resolve(); await holdB.promise; return "B never finishes"; }
      return "plan complete";
    });
    const campaignId = "refuse-manual";
    await startCampaign(router, campaignId, [architectAction("Plan fixture A"), architectAction("Plan fixture B")]);
    expect(await command(router, "manual-job", { kind: "job.submit", id: "manual-job", operation_id: "manual-job", job_kind: CAMPAIGN_RUN_JOB_KIND, owner_scope_id: campaignId, idempotency_key: "manual-job" })).toMatchObject({ ok: true });
    await bStarted.promise;
    const nodeA = runtime.manager.getCampaignSnapshot(campaignId)!.nodes.find((node) => node.action_description === "Plan fixture A")!.id;
    await waitUntil(() => ["verified", "claimed"].includes(runtime.manager.getNodeInfo(campaignId, nodeA)?.state ?? ""), "node A terminal");
    expect(runtime.manager.manualHalt(campaignId, { requested_by: "operator", auditor_agent: "auditor", auditor_agrees: true, operation_id: "manual-halt" })).toMatchObject({ ok: true });
    holdB.resolve();
    await waitUntil(() => ["completed", "failed", "cancelled"].includes(jobState(router, "manual-job") ?? ""), "manual run settled");
    expect(runtime.manager.getCampaignSnapshot(campaignId)).toMatchObject({ halted: true, halt_reason: "manual" });

    const source = sessions(router, campaignId).find((row) => row.node_id === nodeA && row.operation === "specialize")!;
    const nodesBefore = runtime.manager.getCampaignSnapshot(campaignId)!.nodes.length;
    expect(availability(router, source.session_id)).toMatchObject({ fork: false, reason: expect.stringContaining("manual") });
    const refused = await fork(router, "fork-manual", source.session_id);
    expect(refused).toMatchObject({ ok: false, error: { code: "conflict", gate_refusal: { state: "refused", gate: "admission", code: "fork_halt_not_reopenable", correcting_actor: "campaign_planner", corrective_action: "repair_plan_or_config" } } });
    expect(runtime.manager.getCampaignSnapshot(campaignId)!.nodes).toHaveLength(nodesBefore);
    expect(runtime.manager.getCampaignSnapshot(campaignId)).toMatchObject({ halted: true, halt_reason: "manual" });
    expect(runtime.harnessSessions?.continuationByIdempotencyKey("fork-manual") ?? null).toBeNull();
    expect(runtime.manager.getCampaignReopens(campaignId)).toHaveLength(0);
  });

  it("refuses a fork from a NON-halted campaign whose child no selection would ever pick, with the same typed remedy", async () => {
    // B holds the loop open (campaign not halted) while C stays pending. A is
    // pruned after it completes, so a fork child under A hangs below a dead
    // node and is not the only pending node: the live run would never pick it.
    const holdB = deferred();
    const bStarted = deferred();
    const { runtime, router } = compose(initRepo(), async (body) => {
      if (JSON.stringify(body).includes("Plan fixture B")) { bStarted.resolve(); await holdB.promise; return "B never finishes"; }
      return "plan complete";
    });
    const campaignId = "refuse-unselectable-open";
    await startCampaign(router, campaignId, [architectAction("Plan fixture A"), architectAction("Plan fixture B"), architectAction("Plan fixture C")]);
    expect(await command(router, "open-job", { kind: "job.submit", id: "open-job", operation_id: "open-job", job_kind: CAMPAIGN_RUN_JOB_KIND, owner_scope_id: campaignId, idempotency_key: "open-job" })).toMatchObject({ ok: true });
    await bStarted.promise;
    const nodeA = runtime.manager.getCampaignSnapshot(campaignId)!.nodes.find((node) => node.action_description === "Plan fixture A")!.id;
    await waitUntil(() => ["verified", "claimed"].includes(runtime.manager.getNodeInfo(campaignId, nodeA)?.state ?? ""), "node A terminal");
    runtime.manager.prune(campaignId, nodeA);
    expect(runtime.manager.getCampaignSnapshot(campaignId)).toMatchObject({ halted: false });

    const source = sessions(router, campaignId).find((row) => row.node_id === nodeA && row.operation === "specialize")!;
    const nodesBefore = runtime.manager.getCampaignSnapshot(campaignId)!.nodes.length;
    const refused = await fork(router, "fork-unselectable-open", source.session_id);
    expect(refused).toMatchObject({ ok: false, error: { code: "conflict", gate_refusal: { state: "refused", gate: "admission", code: "fork_child_unselectable", correcting_actor: "campaign_planner", corrective_action: "repair_plan_or_config" } } });
    expect(runtime.manager.getCampaignSnapshot(campaignId)!.nodes).toHaveLength(nodesBefore);
    expect(runtime.harnessSessions?.continuationByIdempotencyKey("fork-unselectable-open") ?? null).toBeNull();
    expect(runtime.manager.getCampaignReopens(campaignId)).toHaveLength(0);

    holdB.resolve();
    await waitUntil(() => ["completed", "failed", "cancelled"].includes(jobState(router, "open-job") ?? ""), "open run settled");
  });

  it("refuses a fork after a budget halt, with the operator's raise_budget remedy, and never resets budget", async () => {
    // A's model call outlasts the campaign's max_seconds, so the loop's next
    // halt check halts the campaign budget_exhausted with B still pending.
    const { runtime, router } = compose(initRepo(), async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      return "plan complete";
    });
    const campaignId = "refuse-budget";
    await startCampaign(router, campaignId, [architectAction("Plan fixture A"), architectAction("Plan fixture B")], { max_seconds: 2 });
    await runToCompletion(router, campaignId, "budget-job");
    expect(runtime.manager.getCampaignSnapshot(campaignId)).toMatchObject({ halted: true, halt_reason: "budget_exhausted" });

    const source = sessions(router, campaignId).find((row) => row.operation === "specialize" && row.state === "completed")!;
    const nodesBefore = runtime.manager.getCampaignSnapshot(campaignId)!.nodes.length;
    expect(availability(router, source.session_id)).toMatchObject({ fork: false, reason: expect.stringContaining("budget_exhausted") });
    const refused = await fork(router, "fork-budget", source.session_id);
    expect(refused).toMatchObject({ ok: false, error: { code: "conflict", gate_refusal: { state: "refused", gate: "budget", code: "fork_halt_not_reopenable", correcting_actor: "operator", corrective_action: "raise_budget" } } });
    expect(runtime.manager.getCampaignSnapshot(campaignId)!.nodes).toHaveLength(nodesBefore);
    expect(runtime.manager.getCampaignSnapshot(campaignId)).toMatchObject({ halted: true, halt_reason: "budget_exhausted" });
    expect(runtime.harnessSessions?.continuationByIdempotencyKey("fork-budget") ?? null).toBeNull();
    expect(runtime.manager.getCampaignReopens(campaignId)).toHaveLength(0);
  });

  it("refuses a reopen that the elapsed budget would re-halt at once, even for a no_nodes halt", async () => {
    const repo = initRepo();
    const { runtime, router } = compose(repo, async () => "plan complete");
    const campaignId = "refuse-rehalt";
    await startCampaign(router, campaignId, [architectAction("Plan the only node")], { max_seconds: 600 });
    await runToCompletion(router, campaignId, `${campaignId}-job`);
    expect(runtime.manager.getCampaignSnapshot(campaignId)).toMatchObject({ halted: true, halt_reason: "no_nodes" });
    const source = sessions(router, campaignId).find((row) => row.operation === "specialize" && row.state === "completed")!;
    // The halted campaign's budget runs out while it sits halted.
    const realNow = Date.now;
    Date.now = () => realNow() + 601_000;
    try {
      expect(availability(router, source.session_id)).toMatchObject({ fork: false, reason: expect.stringContaining("budget_exhausted") });
      expect(await fork(router, "fork-rehalt", source.session_id)).toMatchObject({ ok: false, error: { gate_refusal: { gate: "budget", code: "fork_reopen_would_rehalt", corrective_action: "raise_budget" } } });
    } finally { Date.now = realNow; }
    expect(runtime.manager.getCampaignSnapshot(campaignId)).toMatchObject({ halted: true, halt_reason: "no_nodes" });
    expect(runtime.manager.getCampaignReopens(campaignId)).toHaveLength(0);
  });

  it("survives a crash between the reopen and the fork's dispatch: restart keeps a runnable child open, or restores the halt when none is left", async () => {
    const repo = initRepo();
    const first = compose(repo, async () => "plan complete");
    const campaignId = "reopen-crash";
    const source = await haltedNoNodes(first.router, first.runtime, campaignId);

    // The process dies inside the fork after the reopen is durable and
    // before the continuation is admitted: nothing after `reopenForFork`
    // runs, cleanup included.
    const crash = new Error("simulated process death");
    const service = first.runtime.recoveryService!;
    service.prepareFork = () => { throw crash; };
    first.runtime.manager.revertForkReopen = () => { throw crash; };
    expect(await fork(first.router, "fork-crash", source.session_id)).toMatchObject({ ok: false });
    expect(first.runtime.manager.getCampaignReopens(campaignId).map((record) => record.reopen.phase)).toEqual(["reopened"]);
    const child = first.runtime.manager.getCampaignSnapshot(campaignId)!.nodes.find((node) => node.parent_id === source.node_id)!;

    // Restart: the child was branched before the reopen, so the reopened
    // campaign still has a pending node and stays open — and a run selects
    // and dispatches it rather than re-halting.
    const second = compose(repo, async () => "plan complete");
    expect(second.runtime.manager.getCampaignSnapshot(campaignId)).toMatchObject({ halted: false });
    expect(second.runtime.manager.getNodeInfo(campaignId, child.id)?.state).toBe("pending");
    await runToCompletion(second.router, campaignId, "after-restart-job");
    expect(second.runtime.manager.getNodeInfo(campaignId, child.id)?.state).toMatch(/^(verified|claimed)$/);

    // The other side of the window: the reopened campaign is left with no
    // runnable node before the process dies — here the operator prunes the
    // stranded child; equally, the child runs to completion and the process
    // dies before the loop records its next halt. Restart must not leave an
    // open campaign with nothing to run.
    const campaign2 = "reopen-crash-pruned";
    const source2 = await haltedNoNodes(second.router, second.runtime, campaign2);
    second.runtime.recoveryService!.prepareFork = () => { throw crash; };
    second.runtime.manager.revertForkReopen = () => { throw crash; };
    expect(await fork(second.router, "fork-crash-2", source2.session_id)).toMatchObject({ ok: false });
    const child2 = second.runtime.manager.getCampaignSnapshot(campaign2)!.nodes.find((node) => node.parent_id === source2.node_id)!;
    expect(await command(second.router, "prune-child-2", { kind: "tree.prune", campaign_id: campaign2, node_id: child2.id }, second.runtime.manager.getCampaignVersion(campaign2))).toMatchObject({ ok: true });
    expect(second.runtime.manager.getCampaignSnapshot(campaign2)).toMatchObject({ halted: false });

    const third = compose(repo, async () => "plan complete");
    expect(third.runtime.manager.getCampaignSnapshot(campaign2)).toMatchObject({ halted: true, halt_reason: "no_nodes" });
    expect(third.runtime.manager.getCampaignReopens(campaign2).map((record) => record.reopen.phase)).toEqual(["reopened", "reverted"]);
    expect(third.runtime.manager.getCampaignReopens(campaign2)[1]!.reopen.reason).toContain("restart reconciliation");
    // The campaign that kept its runnable child is untouched by reconciliation.
    expect(third.runtime.manager.getCampaignReopens(campaignId).map((record) => record.reopen.phase)).toEqual(["reopened"]);
  });
});
