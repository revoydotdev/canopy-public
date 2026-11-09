/**
 * UCT Stage 0 (2026-10-07), `more-itertools-divide#0/a0`: machine
 * verification passed, and the reviewed-tier critic (Lenticel, the only
 * panel member) answered `approved: true` with its `introspection` check
 * failed -- a contradiction the native verdict contract refuses. The
 * correction turn told it only "did not satisfy revoy.native.critic-verdict.v1",
 * so it re-sent the same verdict until its corrections ran out; the node was
 * parked `awaiting_review`, the one-shot loop halted `stranded_work`, and the
 * snapshot validator, which did not know that halt reason, quarantined the
 * campaign on the next load (`arbor report`: not_found).
 *
 * Driven through the production CLI composition (`createCliRuntime`): real
 * worktrees, verifier, native worker and critic contract. Only the provider
 * is faked, at `fetch`; nothing here reaches a live model.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action } from "@arbor/core";
import { CAMPAIGN_RUN_JOB_KIND } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { createCliRuntime } from "../src/cli.js";
import { buildRunReport } from "../src/run-report.js";

const rootAction: Action = { description: "Root critic-correction fixture", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
const patchAction: Action = {
  description: "Patch the divide module", estimated_gain: 3, estimated_cost: 1, category: "implementation", delegate_to: "seed",
  high_risk_tool_scope: { write_paths: ["src/divide.ts"], command_argv: [] },
};
const metadata = { actor_id: "operator", correlation_id: "native-critic-correction", requested_at: "2026-10-07T00:00:00.000Z", session: {} };
const CONTRADICTION_REASON = "approved is true but checks[introspection] failed";

function sse(payloads: readonly unknown[]): Response {
  return new Response(`${payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("")}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}
/** The live critic's verdict shape: an approval whose introspection check failed, or the resolved form. */
function verdictJson(introspection: boolean): string {
  return JSON.stringify({
    approved: true, rationale: "The diff implements divide and the harness-captured acceptance run passed.", root_cause: null,
    measurement_validated: true, guardrails_enforced: true, introspection_passed: introspection, stability_ok: true,
    checks: [
      { name: "root_cause", passed: true, detail: "No root cause remains: divide is implemented." },
      { name: "measurement_validation", passed: true, detail: "The harness-captured acceptance command passed." },
      { name: "guardrail_enforcement", passed: true, detail: "One file changed; no test was weakened." },
      { name: "introspection", passed: introspection, detail: "The specialist did not run the suite itself; the harness run covers it." },
      { name: "stability_monitoring", passed: true, detail: "No new failures." },
      { name: "completeness", passed: true, detail: "Every documented case is handled." },
    ],
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

/**
 * Runs one single-node reviewed campaign through `createCliRuntime`. The
 * critic answers with the contradictory approval; `resolves` decides whether
 * it settles the contradiction once the correction turn names it.
 */
async function runCampaign(resolves: boolean, critic?: { readonly campaignId: string; readonly reply: (raw: string) => string }): Promise<{ repo: string; campaignId: string; criticBodies: string[]; cleanup: () => void }> {
  const repo = mkdtempSync(join(tmpdir(), "arbor-native-critic-correction-"));
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.ARBOR_NATIVE_API_KEY;
  const criticBodies: string[] = [];
  const cleanup = (): void => {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.ARBOR_NATIVE_API_KEY; else process.env.ARBOR_NATIVE_API_KEY = previousKey;
    spawnSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" });
    rmSync(repo, { recursive: true, force: true });
  };
  try {
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src/divide.ts"), "export const divide = 'before';\n", "utf8");
    writeFileSync(join(repo, "arbor.jsonc"), JSON.stringify({
      native: { mode: "native", adapter_id: "openai-compatible", provider_id: "fixture-provider", base_url: "http://native-provider.invalid/v1", model: "default-native-model" },
      agents: { seed: { model: "specialist-model" }, lenticel: { model: "critic-model" } },
    }), "utf8");
    spawnSync("git", ["init", "-q", repo], { stdio: "ignore" });
    spawnSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"], { stdio: "ignore" });
    spawnSync("git", ["-C", repo, "config", "user.name", "Critic correction test"], { stdio: "ignore" });
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
        // A critic that can act on a named contradiction resolves it; the
        // generic refusal gave it nothing to act on.
        return sse([{ choices: [{ delta: { content: critic === undefined ? verdictJson(resolves && raw.includes(CONTRADICTION_REASON)) : critic.reply(raw) } }], usage }]);
      }
      if (!role.includes("Role: specialist-executor")) throw new Error(`unexpected native role: ${role}`);
      if (priorToolResults(body) === 0) {
        return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "patch-divide", function: { name: "file.patch", arguments: JSON.stringify({ path: "src/divide.ts", expected: "divide = 'before'", replacement: "divide = 'after'" }) } }] } }], usage }]);
      }
      return sse([{ choices: [{ delta: { content: "divide module patched" } }], usage }]);
    }) as typeof fetch;

    const runtime = createCliRuntime(repo);
    const router = new RuntimeCatalogRouter(runtime);
    const campaignId = critic?.campaignId ?? (resolves ? "critic-correction-resolves" : "critic-correction-stranded");
    expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "start", idempotency_key: "start" }, command: { kind: "campaign.start", campaign_id: campaignId, plan_path: "plan.md", root_action: rootAction } })).toMatchObject({ ok: true });
    expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "branch", idempotency_key: "branch" }, command: { kind: "tree.branch", campaign_id: campaignId, node_id: "root", actions: [patchAction] } })).toMatchObject({ ok: true });
    expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "submit", idempotency_key: "submit" }, command: { kind: "job.submit", id: `${campaignId}-job`, operation_id: "submit", job_kind: CAMPAIGN_RUN_JOB_KIND, owner_scope_id: campaignId, idempotency_key: "submit" } })).toMatchObject({ ok: true, value: { dispatched: true } });
    await waitUntil(() => {
      const result = router.executeQuery({ schema_version: 1, query_id: "jobs", query: { kind: "job.list", include_terminal: true } });
      return result.ok && (result.value as { jobs: readonly { id: string; state: string }[] }).jobs.some((job) => job.id === `${campaignId}-job` && job.state === "completed");
    });
    globalThis.fetch = originalFetch;
    return { repo, campaignId, criticBodies, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/**
 * D7 (UCT Stage 0 pilot 4): the live critic's first JSON reply keyed `checks`
 * by name and its second used `evidence` for `detail`; each correction named
 * one defect, so both corrections went on the shape. Both defects at once.
 */
function nameKeyedEvidenceVerdict(): string {
  const valid = JSON.parse(verdictJson(true)) as { checks: { name: string; passed: boolean; detail: string }[] };
  return JSON.stringify({ ...valid, checks: Object.fromEntries(valid.checks.map((check) => [check.name, { passed: check.passed, evidence: check.detail }])) });
}
const NAME_KEYED_REASON = "checks must be an array of {name, passed, detail} objects, not an object keyed by check name";

describe("native critic correction and stranded-work persistence (UCT Stage 0)", () => {
  it("D7: shows a tool-less critic the checks schema, and a name-keyed verdict is corrected in one turn", async () => {
    const { repo, campaignId, criticBodies, cleanup } = await runCampaign(true, {
      campaignId: "critic-shape-one-correction",
      // The critic fixes exactly what it is told: a correction that names the
      // name-keyed shape gets the array form; anything else gets the same reply.
      reply: (raw) => raw.includes(NAME_KEYED_REASON) ? verdictJson(true) : nameKeyedEvidenceVerdict(),
    });
    try {
      expect(criticBodies.length).toBe(2);
      const first = JSON.parse(criticBodies[0]!) as Record<string, unknown>;
      const firstPrompt = JSON.stringify(first.messages);
      // The review prompt states the shape and the example, and that no tools exist.
      expect(firstPrompt).toContain("checks: an ARRAY of objects, each exactly");
      expect(firstPrompt).toContain("never an object keyed by check name");
      expect(firstPrompt).toContain("No tools are available in this review");
      expect(first.tools ?? []).toEqual([]);
      // The single correction carries the shape defect for the whole payload.
      expect(criticBodies[1]).toContain(NAME_KEYED_REASON);
      const report = buildRunReport(createCliRuntime(repo), campaignId);
      expect(report.ok).toBe(true);
      const node = report.ok ? report.value.campaign.nodes.find((candidate) => candidate.action_description === patchAction.description) : undefined;
      expect(node).toMatchObject({ state: "verified" });
    } finally {
      cleanup();
    }
  }, 40_000);

  it("names the approval/check contradiction in the correction turn, so the critic can resolve it and the node verifies", async () => {
    const { repo, campaignId, criticBodies, cleanup } = await runCampaign(true);
    try {
      expect(criticBodies.length).toBe(2);
      expect(criticBodies[1]).toContain(CONTRADICTION_REASON);
      const report = buildRunReport(createCliRuntime(repo), campaignId);
      expect(report.ok).toBe(true);
      const node = report.ok ? report.value.campaign.nodes.find((candidate) => candidate.action_description === patchAction.description) : undefined;
      expect(node).toMatchObject({ state: "verified" });
    } finally {
      cleanup();
    }
  }, 40_000);

  it("keeps a stranded_work halt readable: a fresh runtime reports the parked campaign instead of quarantining it", async () => {
    const { repo, campaignId, criticBodies, cleanup } = await runCampaign(false);
    try {
      // The critic never resolves: its corrections are spent and the node is
      // parked with its candidate (ADR-184 §3), which strands the one-shot run.
      expect(criticBodies.length).toBeGreaterThan(1);
      expect(criticBodies.at(-1)).toContain(CONTRADICTION_REASON);
      // A fresh process composition reloads the snapshot from disk, exactly
      // as `arbor report` does after `arbor task` exits.
      const report = buildRunReport(createCliRuntime(repo), campaignId);
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      expect(report.value.campaign).toMatchObject({ halted: true, halt_reason: "stranded_work" });
      expect(report.value.campaign.nodes.find((candidate) => candidate.action_description === patchAction.description)).toMatchObject({ state: "awaiting_review" });
      const quarantine = join(repo, ".arbor", "quarantine");
      expect(existsSync(quarantine) ? readdirSync(quarantine).filter((name) => name.startsWith(campaignId)) : []).toEqual([]);
    } finally {
      cleanup();
    }
  }, 40_000);
});
