/**
 * Harness continuations at the outermost surface (remediation manifest,
 * "Harness continuations"; live receipt
 * `scripts/live/s14-harness-continuations-receipt.json`, whose
 * `steer_takes_effect` and `fork_fresh_identity` arrows were false).
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

const rootAction: Action = { description: "Root continuation fixture", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
const architectAction = (description: string): Action => ({ description, estimated_gain: 2, estimated_cost: 1, category: "architecture", delegate_to: "seed", execution_role: "architect" });

const meta = (id: string) => ({ operation_id: id, idempotency_key: id, actor_id: "operator", correlation_id: id, requested_at: "2026-10-06T00:00:00.000Z", session: {} });
const generated = (id: string) => ({ tag: "generated" as const, generator: "continuations-e2e", input_hash: `sha256:${id}` });

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

async function waitUntil(predicate: () => boolean, message: string, timeoutMs = 15_000): Promise<void> {
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

/**
 * A real repository plus the production runtime, with an offline provider:
 * every critic call approves, every specialist call is answered by `answer`.
 */
function compose(answer: (body: Body, call: number) => Promise<string>) {
  const repo = mkdtempSync(join(tmpdir(), "arbor-continuations-e2e-"));
  repos.push(repo);
  writeFileSync(join(repo, "arbor.jsonc"), JSON.stringify({
    // One model for every role: continuation admission compares the source
    // session's model with the configured native model (see the report).
    native: { mode: "native", adapter_id: "openai-compatible", provider_id: "fixture-provider", base_url: "http://native-provider.invalid/v1", model: "default-native-model" },
  }), "utf8");
  spawnSync("git", ["init", "-q", repo], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "config", "user.name", "Continuations test"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "commit", "-qm", "fixture"], { stdio: "ignore" });
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
interface SessionRow { readonly session_id: string; readonly node_id: string; readonly operation: string; readonly state: string; readonly lineage?: Record<string, unknown> }
const sessions = (router: Router, campaignId: string): readonly SessionRow[] => query<{ sessions: readonly SessionRow[] }>(router, { kind: "harness.session.list", campaign_id: campaignId, limit: 50 }).sessions;
function jobState(router: Router, jobId: string): string | null {
  return query<{ jobs: readonly { id: string; state: string }[] }>(router, { kind: "job.list", include_terminal: true }).jobs.find((job) => job.id === jobId)?.state ?? null;
}

async function startCampaign(router: Router, campaignId: string, actions: readonly Action[]): Promise<void> {
  expect(await command(router, `${campaignId}-start`, { kind: "campaign.start", campaign_id: campaignId, plan_path: "plan.md", root_action: rootAction })).toMatchObject({ ok: true });
  expect(await command(router, `${campaignId}-branch`, { kind: "tree.branch", campaign_id: campaignId, node_id: "root", actions })).toMatchObject({ ok: true });
}
async function runJob(router: Router, campaignId: string, jobId: string): Promise<void> {
  expect(await command(router, jobId, { kind: "job.submit", id: jobId, operation_id: jobId, job_kind: CAMPAIGN_RUN_JOB_KIND, owner_scope_id: campaignId, idempotency_key: jobId })).toMatchObject({ ok: true, value: { accepted: true, dispatched: true } });
}

describe("harness continuations through the production runtime", () => {
  it("delivers an operator steer to the running model as a provenance-tagged operator message on its next turn", async () => {
    const gate = deferred();
    const firstRequest = deferred();
    const { runtime, router, specialistBodies } = compose(async (_body, call) => {
      if (call === 1) { firstRequest.resolve(); await gate.promise; return "first draft"; }
      return "final answer";
    });
    const campaignId = "steer-e2e";
    await startCampaign(router, campaignId, [architectAction("Plan the steering fixture")]);
    await runJob(router, campaignId, "steer-job");

    // The steer is issued while turn 1's provider call is in flight and that
    // turn then returns a FINAL result: the case where an accepted steer used
    // to be dropped, because no later turn existed to drain it.
    await firstRequest.promise;
    const live = sessions(router, campaignId).find((row) => row.operation === "specialize")!;
    expect(runtime.nativeSessionRegistry.inspect(live.session_id)).not.toBeNull();
    const steer = await command(router, "steer-1", { kind: "harness.session.steer", session_id: live.session_id, message: "Mention the word PINEAPPLE in the plan.", provenance: generated("steer-1") });
    expect(steer).toMatchObject({ ok: true, value: { accepted: true, operation_id: "steer-1" } });
    gate.resolve();
    await waitUntil(() => jobState(router, "steer-job") === "completed", "steer campaign job completed");

    expect(specialistBodies).toHaveLength(2);
    expect(JSON.stringify(specialistBodies[0])).not.toContain("PINEAPPLE");
    const steered = chat(specialistBodies[1]!).filter((message) => typeof message.content === "string" && message.content.includes("PINEAPPLE"));
    expect(steered).toHaveLength(1);
    // A user turn naming the operator and the steer's provenance, never a
    // tool result, and after the model's superseded first answer.
    expect(steered[0]!.role).toBe("user");
    expect(steered[0]!.content).toContain("Operator steering (message steer-1, provenance generated)");
    expect(steered[0]!.content).not.toMatch(/^Tool /);
    const turn2 = chat(specialistBodies[1]!);
    expect(turn2.findIndex((message) => message.role === "assistant" && message.content === "first draft")).toBeLessThan(turn2.indexOf(steered[0]!));

    // The durable journal, the same `harness.session.attach` query the live
    // receipt read after the session settled, carries the delivery proof.
    const attached = query<{ live: boolean; events: readonly { kind: string; payload: { code?: string } }[] }>(router, { kind: "harness.session.attach", session_id: live.session_id, after_sequence: 0, limit: 200 });
    expect(attached.live).toBe(false);
    expect(attached.events.filter((event) => event.kind === "diagnostic" && event.payload.code === "operator_steering_received")).toHaveLength(1);
    expect(attached.events.some((event) => event.payload.code === "operator_steering_undelivered")).toBe(false);
  });

  it("forks a terminal session into a fresh session identity with a lineage pointer to its parent and its own lease", async () => {
    const holdB = deferred();
    const bStarted = deferred();
    const { runtime, router, specialistBodies } = compose(async (body) => {
      if (JSON.stringify(body).includes("Plan fixture B")) { bStarted.resolve(); await holdB.promise; return "B never finishes"; }
      return "plan complete";
    });
    const campaignId = "fork-e2e";
    await startCampaign(router, campaignId, [architectAction("Plan fixture A"), architectAction("Plan fixture B")]);
    await runJob(router, campaignId, "fork-job");

    // A finishes; B is interrupted mid-call through the real tree.interrupt
    // control, which ends the run without halting the campaign.
    await bStarted.promise;
    const snapshot = () => runtime.manager.getCampaignSnapshot(campaignId)!;
    const nodeA = snapshot().nodes.find((node) => node.action_description === "Plan fixture A")!.id;
    const nodeB = snapshot().nodes.find((node) => node.action_description === "Plan fixture B")!.id;
    await waitUntil(() => ["verified", "claimed"].includes(runtime.manager.getNodeInfo(campaignId, nodeA)?.state ?? ""), "node A terminal");
    expect(await command(router, "interrupt-b", { kind: "tree.interrupt", campaign_id: campaignId, node_id: nodeB, scope: "node", reason: "stop B", partial_evidence_ids: [], provenance: generated("interrupt-b") }, runtime.manager.getCampaignVersion(campaignId))).toMatchObject({ ok: true });
    holdB.resolve();
    await waitUntil(() => runtime.manager.getNodeInfo(campaignId, nodeB)?.state === "interrupted" && ["completed", "failed", "cancelled"].includes(jobState(router, "fork-job") ?? ""), "node B interrupted and the run settled");
    expect(snapshot().halted).toBe(false);

    const source = sessions(router, campaignId).find((row) => row.node_id === nodeA && row.operation === "specialize")!;
    expect(query<{ fork: boolean }>(router, { kind: "harness.session.availability", session_id: source.session_id })).toMatchObject({ fork: true });
    const requestsBefore = specialistBodies.length;
    const fork = await command(router, "fork-1", { kind: "harness.session.fork", session_id: source.session_id, reason: "explore an alternative", dispositions: [], provenance: generated("fork-1") });
    expect(fork).toMatchObject({ ok: true, value: { accepted: true, operation_id: "fork-1" } });

    const childOf = () => snapshot().nodes.find((node) => node.parent_id === nodeA);
    await waitUntil(() => {
      const child = childOf();
      return child !== undefined && sessions(router, campaignId).some((row) => row.node_id === child.id && row.operation === "specialize" && row.state === "completed");
    }, "forked child session completed");
    const child = childOf()!;
    const forked = sessions(router, campaignId).find((row) => row.node_id === child.id && row.operation === "specialize")!;
    // Fresh identity: a new session id on a new node, linked to the parent
    // session by lineage, not by reuse.
    expect(child.id).not.toBe(nodeA);
    expect(forked.session_id).not.toBe(source.session_id);
    expect(forked.session_id).toMatch(/^continuation:fork-[0-9a-f]{32}$/);
    const inspected = query<{ lineage: Record<string, unknown> }>(router, { kind: "harness.session.inspect", session_id: forked.session_id });
    expect(inspected.lineage).toMatchObject({ kind: "continuation", continuation_kind: "fork", source_session_id: source.session_id });
    expect(specialistBodies.length).toBe(requestsBefore + 1);
    // Its authority is its own: a durable fork authorization naming the
    // parent as source, the new session, the new node, and a freshly
    // acquired worktree lease, not the parent's.
    const authorization = runtime.harnessSessions?.continuationByIdempotencyKey("fork-1");
    expect(authorization).toMatchObject({ continuation_kind: "fork", source_session_id: source.session_id, new_session_id: forked.session_id, node_id: child.id });
    const lease = authorization!.admissions.find((admission) => admission.kind === "worktree");
    expect(lease).toMatchObject({ admitted: true });
    expect(lease!.evidence_id.length).toBeGreaterThan(0);
    // The parent is untouched: still terminal, still its own node's session.
    expect(runtime.manager.getNodeInfo(campaignId, nodeA)?.state).toMatch(/^(verified|claimed)$/);
    expect(query<{ session_id: string; node_id: string; state: string }>(router, { kind: "harness.session.inspect", session_id: source.session_id })).toMatchObject({ node_id: nodeA, state: "completed" });
  });

  // A fork from a halted campaign — reopened for a no_nodes or converged
  // halt, refused with a typed remedy for any other — is covered end to end
  // in harness-session-fork-reopen-e2e.test.ts.
});
