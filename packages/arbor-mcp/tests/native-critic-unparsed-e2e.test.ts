/**
 * UCT Stage 0 Revision 2.2 pilot (docs/research/uct-search/stage0-pilot3-report-2026-10-07.md),
 * driven end to end through the production CLI composition (`createCliRuntime`):
 * real worktrees, the real sandboxed verifier, the real native worker and
 * critic contract. Only the provider is faked, at `fetch`.
 *
 * - H7: six correct, self-verified candidates were stranded because the
 *   critic's first reply was prose, which ended the review with no correction
 *   turn. A prose reply now gets the same bounded corrections as JSON the
 *   contract refused, so a critic that then sends a verdict verifies the node;
 *   one that never does leaves it parked `awaiting_review` with its candidate
 *   kept, as ADR-184 parks a malformed verdict.
 * - H6: a specialist turn cut off at the output-token limit after reasoning
 *   only was ended as "no progress". It is now continued, so the specialist
 *   gets to act.
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

const rootAction: Action = { description: "Root unparsed-critic fixture", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
const correctedPatch: Action = {
  description: "Patch the module whose critic answers in prose first", estimated_gain: 3, estimated_cost: 1, category: "implementation", delegate_to: "seed",
  high_risk_tool_scope: { write_paths: ["src/corrected.ts"], command_argv: [] },
};
const proseForeverPatch: Action = {
  description: "Patch the module whose critic only answers in prose", estimated_gain: 2, estimated_cost: 1, category: "implementation", delegate_to: "seed",
  high_risk_tool_scope: { write_paths: ["src/prose.ts"], command_argv: [] },
};

const metadata = { actor_id: "operator", correlation_id: "native-critic-unparsed", requested_at: "2026-10-07T00:00:00.000Z", session: {} };
const CUT_OFF_NOTE = "cut off at the output-token limit";
const CORRECTION = "your reply was not a JSON object";

function sse(payloads: readonly unknown[]): Response {
  return new Response(`${payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("")}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}
function approval(text: string): string {
  return JSON.stringify({
    approved: true, rationale: text, root_cause: null, measurement_validated: true, guardrails_enforced: true, introspection_passed: true, stability_ok: true,
    checks: ["root_cause", "measurement_validation", "guardrail_enforcement", "introspection", "stability_monitoring"].map((name) => ({ name, passed: true, detail: text })),
    confidence: 0.9,
  });
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

describe("native critic prose replies and cut-off specialist turns (H7/H6)", () => {
  it("corrects a prose critic reply into a verdict, parks a node whose critic never sends one, and continues a cut-off specialist turn", async () => {
    const repo = mkdtempSync(join(tmpdir(), "arbor-native-critic-unparsed-"));
    const originalFetch = globalThis.fetch;
    const previousKey = process.env.ARBOR_NATIVE_API_KEY;
    const criticBodies: string[] = [];
    const correctedSpecialistBodies: string[] = [];
    const cutOffSent = new Set<string>();
    try {
      mkdirSync(join(repo, "src"));
      writeFileSync(join(repo, "src/corrected.ts"), "export const corrected = 'before';\n", "utf8");
      writeFileSync(join(repo, "src/prose.ts"), "export const prose = 'before';\n", "utf8");
      writeFileSync(join(repo, "arbor.jsonc"), JSON.stringify({
        native: { mode: "native", adapter_id: "openai-compatible", provider_id: "fixture-provider", base_url: "http://native-provider.invalid/v1", model: "default-native-model" },
        agents: { seed: { model: "specialist-model" }, lenticel: { model: "critic-model" } },
      }), "utf8");
      spawnSync("git", ["init", "-q", repo], { stdio: "ignore" });
      spawnSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"], { stdio: "ignore" });
      spawnSync("git", ["-C", repo, "config", "user.name", "Unparsed critic test"], { stdio: "ignore" });
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
          // A prose reply, as Laguna's critic sent in the pilot. The corrected
          // node's critic sends its verdict once it is told its reply was not JSON.
          const corrected = raw.includes("corrected module patched") && raw.includes(CORRECTION);
          return sse([{ choices: [{ delta: { content: corrected ? approval("the diff patches the module and the check passed") : "The change looks right to me: it patches the module and the check passed." }, finish_reason: "stop" }], usage }]);
        }
        if (!role.includes("Role: specialist-executor")) throw new Error(`unexpected native role: ${role}`);
        const assigned = (action: Action): boolean => raw.includes(`Action: ${action.description}\\n`);
        const target = assigned(correctedPatch) ? { id: "corrected", path: "src/corrected.ts", from: "corrected = 'before'", to: "corrected = 'after'", done: "corrected module patched" }
          : assigned(proseForeverPatch) ? { id: "prose", path: "src/prose.ts", from: "prose = 'before'", to: "prose = 'after'", done: "prose module patched" }
          : null;
        if (target === null) throw new Error("unexpected specialist action");
        if (target.id === "corrected") {
          correctedSpecialistBodies.push(raw);
          // H6: the first specialist turn spends its whole output budget
          // reasoning and is cut off with no content and no tool call.
          if (!cutOffSent.has(target.id)) {
            cutOffSent.add(target.id);
            return sse([{ choices: [{ delta: { reasoning: "Let me consider every path through the module before acting. ".repeat(8) }, finish_reason: "length" }], usage: { prompt_tokens: 11, completion_tokens: 8_000 } }]);
          }
        }
        if (priorToolResults(body) === 0) {
          return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: `patch-${target.id}`, function: { name: "file.patch", arguments: JSON.stringify({ path: target.path, expected: target.from, replacement: target.to }) } }] }, finish_reason: "tool_calls" }], usage }]);
        }
        return sse([{ choices: [{ delta: { content: target.done }, finish_reason: "stop" }], usage }]);
      }) as typeof fetch;

      const runtime = createCliRuntime(repo);
      const router = new RuntimeCatalogRouter(runtime);
      const campaignId = "native-critic-unparsed";
      expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "start", idempotency_key: "start" }, command: { kind: "campaign.start", campaign_id: campaignId, plan_path: "plan.md", root_action: rootAction } })).toMatchObject({ ok: true });
      expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "branch", idempotency_key: "branch" }, command: { kind: "tree.branch", campaign_id: campaignId, node_id: "root", actions: [correctedPatch, proseForeverPatch] } })).toMatchObject({ ok: true });
      expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "submit", idempotency_key: "submit" }, command: { kind: "job.submit", id: "native-critic-unparsed-job", operation_id: "submit", job_kind: CAMPAIGN_RUN_JOB_KIND, owner_scope_id: campaignId, idempotency_key: "submit" } })).toMatchObject({ ok: true, value: { dispatched: true } });
      await waitUntil(() => {
        const result = router.executeQuery({ schema_version: 1, query_id: "jobs", query: { kind: "job.list", include_terminal: true } });
        return result.ok && (result.value as { jobs: readonly { id: string; state: string }[] }).jobs.some((job) => job.id === "native-critic-unparsed-job" && job.state === "completed");
      });

      const snapshot = runtime.manager.getCampaignSnapshot(campaignId)!;
      const corrected = snapshot.nodes.find((node) => node.action_description === correctedPatch.description)!;
      const proseForever = snapshot.nodes.find((node) => node.action_description === proseForeverPatch.description)!;

      // H6: the cut-off turn was continued with a note, and the specialist acted.
      expect(correctedSpecialistBodies.length).toBeGreaterThan(2);
      expect(correctedSpecialistBodies[0]).not.toContain(CUT_OFF_NOTE);
      expect(correctedSpecialistBodies[1]).toContain(CUT_OFF_NOTE);

      // H7: the prose reply got a correction turn naming what to send, and
      // the critic's verdict then verified the node.
      const correctedCritics = criticBodies.filter((body) => body.includes("corrected module patched"));
      expect(correctedCritics).toHaveLength(2);
      expect(correctedCritics[0]).not.toContain(CORRECTION);
      expect(correctedCritics[1]).toContain("malformed_critic_verdict: your reply was not a JSON object (the reply was prose with no JSON value)");
      expect(corrected).toMatchObject({ state: "verified", critic_verdict: { approved: true } });

      // A critic that never sends a verdict spends the bounded corrections and
      // the review fails as malformed output: the node is parked awaiting
      // review with its candidate kept, never failed as a rejection.
      const proseCritics = criticBodies.filter((body) => body.includes("prose module patched"));
      expect(proseCritics.length).toBe(3);
      expect(proseForever.state).toBe("awaiting_review");
      expect(proseForever.critic_verdict).toBeNull();
      expect(runtime.manager.getNodeInfo(campaignId, proseForever.id)?.candidate).toMatchObject({
        specialist_output: expect.stringContaining("prose module patched"),
        review_status: "awaiting_review",
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.ARBOR_NATIVE_API_KEY; else process.env.ARBOR_NATIVE_API_KEY = previousKey;
      spawnSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" });
      rmSync(repo, { recursive: true, force: true });
    }
  }, 40_000);
});
