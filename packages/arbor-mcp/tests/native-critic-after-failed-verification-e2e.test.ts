/**
 * UCT Stage 0 re-pilot "Critic contract failure" (O1), driven through the
 * production CLI composition (`createCliRuntime`) with only the provider faked
 * at `fetch`: when the sandboxed acceptance command has ALREADY failed, a
 * critic whose review then fails as malformed (corrections spent) must not
 * park the node and strand the campaign. The failure is proven by the machine,
 * so the node fails and the campaign ends for its own reason. When the
 * acceptance command PASSED, ADR-184 parking is unchanged: the node stays
 * `awaiting_review` with its candidate kept.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action } from "@arbor/core";
import { CAMPAIGN_RUN_JOB_KIND } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { createCliRuntime } from "../src/cli.js";
import { buildRunReport } from "../src/run-report.js";

const rootAction: Action = { description: "Root critic-after-verification fixture", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
const patchAction = (exitCode: number): Action => ({
  description: "Patch the module under an acceptance command", estimated_gain: 3, estimated_cost: 1, category: "implementation", delegate_to: "seed",
  high_risk_tool_scope: {
    write_paths: ["src/target.ts"],
    command_argv: [[process.execPath, "-e", `require('fs').readFileSync('src/target.ts'); process.exit(${exitCode})`]],
  },
});

const metadata = { actor_id: "operator", correlation_id: "native-critic-after-verification", requested_at: "2026-10-07T00:00:00.000Z", session: {} };

function sse(payloads: readonly unknown[]): Response {
  return new Response(`${payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("")}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}
function systemPrompt(body: Record<string, unknown>): string {
  return String((body.messages as readonly Record<string, unknown>[]).find((message) => message.role === "system")?.content ?? "");
}
function priorToolResults(body: Record<string, unknown>): number {
  return (body.messages as readonly Record<string, unknown>[]).filter((message) => typeof message.content === "string" && message.content.includes("Tool file.")).length;
}
async function waitUntil(predicate: () => boolean, timeoutMs = 25_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for the campaign job");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function runCampaign(exitCode: number) {
  const repo = mkdtempSync(join(tmpdir(), "arbor-native-critic-after-verification-"));
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.ARBOR_NATIVE_API_KEY;
  const criticBodies: string[] = [];
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/target.ts"), "export const target = 'before';\n", "utf8");
  writeFileSync(join(repo, "arbor.jsonc"), JSON.stringify({
    native: { mode: "native", adapter_id: "openai-compatible", provider_id: "fixture-provider", base_url: "http://native-provider.invalid/v1", model: "default-native-model" },
    agents: { seed: { model: "specialist-model" }, lenticel: { model: "critic-model" } },
  }), "utf8");
  spawnSync("git", ["init", "-q", repo], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "config", "user.name", "Critic after verification test"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "commit", "-qm", "fixture"], { stdio: "ignore" });
  process.env.ARBOR_NATIVE_API_KEY = "native-test-secret";
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = String(init?.body);
    const body = JSON.parse(raw) as Record<string, unknown>;
    const role = systemPrompt(body);
    const usage = { prompt_tokens: 11, completion_tokens: 5 };
    if (role.includes("Role: critic-reviewer")) {
      criticBodies.push(raw);
      // The critic only ever answers in prose: its corrections are spent and
      // the review fails as malformed_critic_verdict.
      return sse([{ choices: [{ delta: { content: "The change looks right to me." }, finish_reason: "stop" }], usage }]);
    }
    if (!role.includes("Role: specialist-executor")) throw new Error(`unexpected native role: ${role}`);
    if (priorToolResults(body) === 0) {
      return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "patch-target", function: { name: "file.patch", arguments: JSON.stringify({ path: "src/target.ts", expected: "target = 'before'", replacement: "target = 'after'" }) } }] }, finish_reason: "tool_calls" }], usage }]);
    }
    return sse([{ choices: [{ delta: { content: "target module patched" }, finish_reason: "stop" }], usage }]);
  }) as typeof fetch;
  const runtime = createCliRuntime(repo);
  const router = new RuntimeCatalogRouter(runtime);
  const campaignId = `native-critic-after-verification-${exitCode}`;
  expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "start", idempotency_key: "start" }, command: { kind: "campaign.start", campaign_id: campaignId, plan_path: "plan.md", root_action: rootAction } })).toMatchObject({ ok: true });
  expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "branch", idempotency_key: "branch" }, command: { kind: "tree.branch", campaign_id: campaignId, node_id: "root", actions: [patchAction(exitCode)] } })).toMatchObject({ ok: true });
  const jobId = `${campaignId}-job`;
  expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "submit", idempotency_key: "submit" }, command: { kind: "job.submit", id: jobId, operation_id: "submit", job_kind: CAMPAIGN_RUN_JOB_KIND, owner_scope_id: campaignId, idempotency_key: "submit" } })).toMatchObject({ ok: true, value: { dispatched: true } });
  await waitUntil(() => {
    const result = router.executeQuery({ schema_version: 1, query_id: "jobs", query: { kind: "job.list", include_terminal: true } });
    return result.ok && (result.value as { jobs: readonly { id: string; state: string }[] }).jobs.some((job) => job.id === jobId && job.state === "completed");
  });
  return {
    runtime, campaignId, criticBodies,
    cleanup: () => {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.ARBOR_NATIVE_API_KEY; else process.env.ARBOR_NATIVE_API_KEY = previousKey;
      spawnSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" });
      rmSync(repo, { recursive: true, force: true });
    },
  };
}

describe("malformed native critic after machine verification (O1)", () => {
  it("fails the node on its failed acceptance command instead of parking it, so the campaign does not halt stranded_work", async () => {
    const { runtime, campaignId, criticBodies, cleanup } = await runCampaign(3);
    try {
      expect(criticBodies.length).toBeGreaterThan(1);
      const snapshot = runtime.manager.getCampaignSnapshot(campaignId)!;
      const node = snapshot.nodes.find((candidate) => candidate.action_description === patchAction(3).description)!;
      expect(node.state).toBe("failed");
      expect(snapshot.nodes.some((candidate) => candidate.state === "awaiting_review")).toBe(false);
      const report = buildRunReport(runtime, campaignId);
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      expect(report.value.campaign.halt_reason).not.toBe("stranded_work");
    } finally {
      cleanup();
    }
  }, 40_000);

  it("still parks awaiting_review with the candidate kept when the acceptance command passed (ADR-184)", async () => {
    const { runtime, campaignId, cleanup } = await runCampaign(0);
    try {
      const snapshot = runtime.manager.getCampaignSnapshot(campaignId)!;
      const node = snapshot.nodes.find((candidate) => candidate.action_description === patchAction(0).description)!;
      expect(node.state).toBe("awaiting_review");
      expect(runtime.manager.getNodeInfo(campaignId, node.id)?.candidate).toMatchObject({ specialist_output: expect.stringContaining("target module patched"), review_status: "awaiting_review" });
      const report = buildRunReport(runtime, campaignId);
      expect(report.ok && report.value.campaign.halt_reason).toBe("stranded_work");
    } finally {
      cleanup();
    }
  }, 40_000);
});
