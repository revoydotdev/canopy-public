/**
 * D6 (UCT Stage 0 pilot 4, semver-eval a3): after 26 specialist turns the
 * model wrote its chat-template tool-call syntax as a tool name. The worker
 * recorded that raw name as canonical tool-result evidence, the session
 * journal refused it, the CLI threw "native session event could not be
 * durably recorded", and `arbor task` exited `campaign_run_failed`: the
 * candidate worktree was removed and none of the attempt's usage reached the
 * audit log.
 *
 * Driven through the production CLI composition (`createCliRuntime`): real
 * worktrees, verifier, native worker, session journal and critic contract.
 * Only the provider is faked, at `fetch`; nothing here reaches a live model.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action } from "@arbor/core";
import { CAMPAIGN_RUN_JOB_KIND } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { createCliRuntime } from "../src/cli.js";
import { buildRunReport } from "../src/run-report.js";

const rootAction: Action = { description: "Root malformed-tool-name fixture", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
const patchAction: Action = {
  description: "Patch the divide module", estimated_gain: 3, estimated_cost: 1, category: "implementation", delegate_to: "seed",
  high_risk_tool_scope: { write_paths: ["src/divide.ts"], command_argv: [] },
};
const metadata = { actor_id: "operator", correlation_id: "native-malformed-tool-name", requested_at: "2026-10-07T00:00:00.000Z", session: {} };
/** Laguna's text-form tool call, observed as a tool name. */
const MALFORMED_TOOL = "shell<arg_key>cmd</arg_key><arg_value>cargo test</arg_value>";
const CAMPAIGN_ID = "malformed-tool-name";

function sse(payloads: readonly unknown[]): Response {
  return new Response(`${payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("")}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}
function verdictJson(): string {
  return JSON.stringify({
    approved: true, rationale: "The diff implements divide and the harness-captured acceptance run passed.", root_cause: null,
    measurement_validated: true, guardrails_enforced: true, introspection_passed: true, stability_ok: true,
    checks: [
      { name: "root_cause", passed: true, detail: "No root cause remains: divide is implemented." },
      { name: "measurement_validation", passed: true, detail: "The harness-captured acceptance command passed." },
      { name: "guardrail_enforcement", passed: true, detail: "One file changed; no test was weakened." },
      { name: "introspection", passed: true, detail: "The specialist recovered from a refused tool name and patched the module." },
      { name: "stability_monitoring", passed: true, detail: "No new failures." },
    ],
    confidence: 0.9,
  });
}
function systemPrompt(body: Record<string, unknown>): string {
  return String((body.messages as readonly Record<string, unknown>[]).find((message) => message.role === "system")?.content ?? "");
}
/** Prior tool results the worker replayed to the provider (native tool results render as `Tool <name> ... returned:`). */
function toolMessages(body: Record<string, unknown>): number {
  return (body.messages as readonly Record<string, unknown>[]).filter((message) => message.role === "tool" || (typeof message.content === "string" && /^Tool .* returned:/.test(message.content))).length;
}
async function waitUntil(predicate: () => boolean, timeoutMs = 25_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for the campaign job");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe("a malformed model tool name never ends the campaign (D6)", () => {
  it("refuses the name back to the model, journals a bounded label, and the candidate and usage survive", async () => {
    const repo = mkdtempSync(join(tmpdir(), "arbor-native-malformed-tool-"));
    const originalFetch = globalThis.fetch;
    const previousKey = process.env.ARBOR_NATIVE_API_KEY;
    const specialistBodies: Record<string, unknown>[] = [];
    try {
      mkdirSync(join(repo, "src"));
      writeFileSync(join(repo, "src/divide.ts"), "export const divide = 'before';\n", "utf8");
      writeFileSync(join(repo, "arbor.jsonc"), JSON.stringify({
        native: { mode: "native", adapter_id: "openai-compatible", provider_id: "fixture-provider", base_url: "http://native-provider.invalid/v1", model: "default-native-model" },
        agents: { seed: { model: "specialist-model" }, lenticel: { model: "critic-model" } },
      }), "utf8");
      spawnSync("git", ["init", "-q", repo], { stdio: "ignore" });
      spawnSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"], { stdio: "ignore" });
      spawnSync("git", ["-C", repo, "config", "user.name", "Malformed tool test"], { stdio: "ignore" });
      spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
      spawnSync("git", ["-C", repo, "commit", "-qm", "fixture"], { stdio: "ignore" });

      process.env.ARBOR_NATIVE_API_KEY = "native-test-secret";
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const role = systemPrompt(body);
        const usage = { prompt_tokens: 11, completion_tokens: 5 };
        if (role.includes("Role: critic-reviewer")) return sse([{ choices: [{ delta: { content: verdictJson() } }], usage }]);
        if (!role.includes("Role: specialist-executor")) throw new Error(`unexpected native role: ${role}`);
        specialistBodies.push(body);
        const prior = toolMessages(body);
        if (prior === 0) {
          return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "text-form", function: { name: MALFORMED_TOOL, arguments: "{}" } }] } }], usage }]);
        }
        if (prior === 1) {
          return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "patch-divide", function: { name: "file.patch", arguments: JSON.stringify({ path: "src/divide.ts", expected: "divide = 'before'", replacement: "divide = 'after'" }) } }] } }], usage }]);
        }
        return sse([{ choices: [{ delta: { content: "divide module patched" } }], usage }]);
      }) as typeof fetch;

      const runtime = createCliRuntime(repo);
      const router = new RuntimeCatalogRouter(runtime);
      expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "start", idempotency_key: "start" }, command: { kind: "campaign.start", campaign_id: CAMPAIGN_ID, plan_path: "plan.md", root_action: rootAction } })).toMatchObject({ ok: true });
      expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "branch", idempotency_key: "branch" }, command: { kind: "tree.branch", campaign_id: CAMPAIGN_ID, node_id: "root", actions: [patchAction] } })).toMatchObject({ ok: true });
      expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "submit", idempotency_key: "submit" }, command: { kind: "job.submit", id: `${CAMPAIGN_ID}-job`, operation_id: "submit", job_kind: CAMPAIGN_RUN_JOB_KIND, owner_scope_id: CAMPAIGN_ID, idempotency_key: "submit" } })).toMatchObject({ ok: true, value: { dispatched: true } });
      let jobState = "";
      await waitUntil(() => {
        const result = router.executeQuery({ schema_version: 1, query_id: "jobs", query: { kind: "job.list", include_terminal: true } });
        jobState = result.ok ? (result.value as { jobs: readonly { id: string; state: string }[] }).jobs.find((job) => job.id === `${CAMPAIGN_ID}-job`)?.state ?? "" : "";
        return jobState === "completed" || jobState === "failed";
      });
      globalThis.fetch = originalFetch;

      // The campaign was not killed: no run-failure diagnostic, and the job completed.
      expect(jobState).toBe("completed");
      expect(runtime.health().campaign_run_diagnostics.filter((diagnostic) => diagnostic.campaign_id === CAMPAIGN_ID)).toEqual([]);
      // The model was told, in-session, that the name is not a tool, and recovered.
      expect(specialistBodies.length).toBeGreaterThanOrEqual(3);
      expect(JSON.stringify(specialistBodies[1]!.messages)).toContain("is not available for this session. Available tools:");
      // The candidate survived to review and verification.
      const report = buildRunReport(createCliRuntime(repo), CAMPAIGN_ID);
      expect(report.ok).toBe(true);
      const node = report.ok ? report.value.campaign.nodes.find((candidate) => candidate.action_description === patchAction.description) : undefined;
      expect(node).toMatchObject({ state: "verified" });
      // The journal holds the whole chronology, with a bounded label in place of the raw name.
      const journal = readFileSync(join(repo, ".arbor", "harness-sessions.ndjson"), "utf8");
      expect(journal).not.toContain("arg_key");
      expect(journal).toMatch(/"kind":"tool_result","payload":\{"tool":"malformed_tool_name\.[a-f0-9]{16}"/);
      // The specialist's usage reached the durable audit record.
      const usageRecords = filesUnder(join(repo, ".arbor")).filter((path) => !path.endsWith("harness-sessions.ndjson"))
        .flatMap((path) => readFileSync(path, "utf8").split("\n"))
        .filter((line) => line.includes(`${CAMPAIGN_ID}:`) && line.includes(":specialist") && line.includes("input_tokens"));
      expect(usageRecords.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.ARBOR_NATIVE_API_KEY; else process.env.ARBOR_NATIVE_API_KEY = previousKey;
      spawnSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" });
      rmSync(repo, { recursive: true, force: true });
    }
  }, 40_000);
});
