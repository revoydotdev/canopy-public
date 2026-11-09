#!/usr/bin/env bun
/**
 * A02/A06 fixture — a real, standalone OS process that runs one campaign
 * through the production `createCliRuntime` composition with an offline
 * OpenAI-compatible provider that fails: every odd specialist request is a
 * retryable HTTP 503, every even one a terminal HTTP 402 whose typed error
 * message carries planted credentials. After the campaign job settles it
 * prints what the operator surfaces showed (`settled:<json>`) and then
 * idles, so the parent test can SIGKILL it and read the same surfaces from
 * a fresh runtime that has only the durable records. Not itself a test: it
 * is driven by `../provider-failure-restart.test.ts`.
 *
 * Usage: provider-failure-campaign-worker.ts <repo> <campaignId>
 */
import { CAMPAIGN_RUN_JOB_KIND } from "../../../src/runtime.js";
import { RuntimeCatalogRouter } from "../../../src/runtime-catalog.js";
import { createCliRuntime } from "../../../src/cli.js";
import { buildRunReport } from "../../../src/run-report.js";
import { PLANTED } from "./provider-failure-planted.js";

const [repo, campaignId] = process.argv.slice(2);
if (repo === undefined || campaignId === undefined) throw new Error("usage: provider-failure-campaign-worker.ts <repo> <campaignId>");

let specialistCalls = 0;
globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const body = JSON.parse(String(init?.body)) as { messages?: readonly { role: string; content: unknown }[] };
  const system = String(body.messages?.find((message) => message.role === "system")?.content ?? "");
  if (system.includes("Role: critic-reviewer")) return new Response("critic must not be reached", { status: 500 });
  specialistCalls += 1;
  if (specialistCalls % 2 === 1) {
    return new Response(JSON.stringify({ error: { type: "server_error", message: "upstream overloaded" } }), { status: 503, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({
    error: {
      type: "insufficient_quota",
      code: "insufficient_quota",
      message: `You exceeded your current quota for key ${PLANTED.sk}; api_key=${PLANTED.api_key} Authorization: Bearer ${PLANTED.bearer} {"raw":"${PLANTED.body_marker}"}`,
    },
    // Untyped body fields are never extracted by the adapter.
    debug: { echoed_request_key: PLANTED.api_key, raw: PLANTED.body_marker },
  }), { status: 402, headers: { "content-type": "application/json" } });
}) as typeof fetch;

process.env.ARBOR_NATIVE_API_KEY = PLANTED.api_key;
const runtime = createCliRuntime(repo);
delete process.env.ARBOR_NATIVE_API_KEY;
const router = new RuntimeCatalogRouter(runtime);
const meta = (id: string) => ({ operation_id: id, idempotency_key: id, actor_id: "operator", correlation_id: id, requested_at: "2026-10-06T00:00:00.000Z", session: {} });
async function command(id: string, payload: Record<string, unknown>): Promise<void> {
  const result = await router.dispatchCommand({ schema_version: 1, metadata: meta(id), command: payload } as never) as { ok: boolean };
  if (!result.ok) throw new Error(`${id} failed: ${JSON.stringify(result)}`);
}
function query<T>(payload: Record<string, unknown>): T {
  const result = router.executeQuery({ schema_version: 1, query_id: `q-${String(payload.kind)}`, query: payload } as never);
  if (!result.ok) throw new Error(`${String(payload.kind)} failed: ${JSON.stringify(result)}`);
  return result.value as T;
}

await command(`${campaignId}-start`, { kind: "campaign.start", campaign_id: campaignId, plan_path: "plan.md", root_action: { description: "Provider failure fixture root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" } });
await command(`${campaignId}-branch`, { kind: "tree.branch", campaign_id: campaignId, node_id: "root", actions: [{ description: "Plan the provider failure fixture", estimated_gain: 2, estimated_cost: 1, category: "architecture", delegate_to: "seed", execution_role: "architect" }] });
await command(`${campaignId}-job`, { kind: "job.submit", id: `${campaignId}-job`, operation_id: `${campaignId}-job`, job_kind: CAMPAIGN_RUN_JOB_KIND, owner_scope_id: campaignId, idempotency_key: `${campaignId}-job` });

const deadline = Date.now() + 30_000;
for (;;) {
  const job = query<{ jobs: readonly { id: string; state: string }[] }>({ kind: "job.list", include_terminal: true }).jobs.find((entry) => entry.id === `${campaignId}-job`);
  if (job !== undefined && ["completed", "failed", "cancelled"].includes(job.state)) break;
  if (Date.now() > deadline) throw new Error("campaign job did not settle");
  await new Promise((resolve) => setTimeout(resolve, 20));
}

const sessions = query<{ sessions: readonly { session_id: string }[] }>({ kind: "harness.session.list", campaign_id: campaignId, limit: 50 }).sessions;
const surfaces = sessions.map((session) => ({
  session_id: session.session_id,
  attach: query({ kind: "harness.session.attach", session_id: session.session_id, after_sequence: 0, limit: 200 }),
  inspect: query({ kind: "harness.session.inspect", session_id: session.session_id }),
}));
const report = buildRunReport(runtime, campaignId);
process.stdout.write(`settled:${JSON.stringify({ specialist_calls: specialistCalls, surfaces, session_failures: report.ok ? report.value.session_failures : null })}\n`);
// Stay alive until the parent kills this process: no graceful shutdown path
// gets a chance to flush anything the durable journal did not already hold.
setInterval(() => undefined, 60_000);
