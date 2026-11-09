/**
 * The native critic reviews the work, and a failed verifier says why.
 *
 * Defects found by the 2026-10-06 external cohort
 * (docs/release-acceptance-1.0.0/evidence/2026-10-06-external-cohort-native.md):
 *
 * - D2: a machine-verified native session's final message was replaced by the
 *   verifier's one-line receipt, and that line was all the critic received --
 *   no specialist report, no diff. Critics answered with schema placeholders
 *   (`"rationale": "placeholder"`) that were then counted as rejections.
 * - D4: the verifier's bounded failure output was computed and dropped, so
 *   neither the retrying specialist nor `arbor report` could see it.
 *
 * Driven through the production CLI composition (`createCliRuntime`): real
 * worktrees, the real sandboxed verifier, the real native worker and critic
 * contract. Only the provider is faked, at `fetch`.
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

const SECRET_IN_DIFF = "sk-fixtureLEAK0123456789abcdef";
const VERIFIER_ERROR = "fixture verifier: SSL peer certificate unable to get local issuer certificate";

const rootAction: Action = { description: "Root critic-evidence fixture", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
const reviewedPatch: Action = {
  description: "Patch the reviewed workflow module", estimated_gain: 3, estimated_cost: 1, category: "implementation", delegate_to: "seed",
  high_risk_tool_scope: { write_paths: ["src/reviewed.ts"], command_argv: [] },
};
const placeholderPatch: Action = {
  description: "Patch the placeholder-reviewed module", estimated_gain: 2, estimated_cost: 1, category: "implementation", delegate_to: "seed",
  high_risk_tool_scope: { write_paths: ["src/placeholder.ts"], command_argv: [] },
};
const failingVerification: Action = {
  description: "Patch the module whose acceptance command fails", estimated_gain: 1, estimated_cost: 1, category: "implementation", delegate_to: "seed",
  // An authored acceptance command that reads the declared path (so it is not
  // a vacuous inline check), prints a TLS-shaped error, and exits non-zero.
  high_risk_tool_scope: {
    write_paths: ["src/failing.ts"],
    command_argv: [[process.execPath, "-e", `require('fs').readFileSync('src/failing.ts'); process.stderr.write(${JSON.stringify(`${VERIFIER_ERROR}\n`)}); process.exit(3)`]],
  },
};

const metadata = { actor_id: "operator", correlation_id: "native-critic-evidence", requested_at: "2026-10-06T00:00:00.000Z", session: {} };

function sse(payloads: readonly unknown[]): Response {
  return new Response(`${payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("")}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}
function verdictJson(text: string): string {
  return JSON.stringify({
    approved: true, rationale: text, root_cause: null, measurement_validated: true, guardrails_enforced: true, introspection_passed: true, stability_ok: true,
    checks: [
      { name: "root_cause", passed: true, detail: text },
      { name: "measurement_validation", passed: true, detail: text },
      { name: "guardrail_enforcement", passed: true, detail: text },
      { name: "introspection", passed: true, detail: text },
      { name: "stability_monitoring", passed: true, detail: text },
    ],
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

describe("native critic evidence (D2/D4)", () => {
  it("gives the critic the specialist's report and a redacted diff, refuses placeholder verdicts as malformed, and keeps verifier output for retry and report", async () => {
    const repo = mkdtempSync(join(tmpdir(), "arbor-native-critic-evidence-"));
    const originalFetch = globalThis.fetch;
    const previousKey = process.env.ARBOR_NATIVE_API_KEY;
    const criticBodies: string[] = [];
    const failingSpecialistBodies: string[] = [];
    try {
      mkdirSync(join(repo, "src"));
      writeFileSync(join(repo, "src/reviewed.ts"), "export const reviewed = 'before';\n", "utf8");
      writeFileSync(join(repo, "src/placeholder.ts"), "export const placeholder = 'before';\n", "utf8");
      writeFileSync(join(repo, "src/failing.ts"), "export const failing = 'before';\n", "utf8");
      writeFileSync(join(repo, "arbor.jsonc"), JSON.stringify({
        native: { mode: "native", adapter_id: "openai-compatible", provider_id: "fixture-provider", base_url: "http://native-provider.invalid/v1", model: "default-native-model" },
        agents: { seed: { model: "specialist-model" }, lenticel: { model: "critic-model" } },
      }), "utf8");
      spawnSync("git", ["init", "-q", repo], { stdio: "ignore" });
      spawnSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"], { stdio: "ignore" });
      spawnSync("git", ["-C", repo, "config", "user.name", "Critic evidence test"], { stdio: "ignore" });
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
          // The placeholder node's critic answers with schema-shaped template
          // text on every attempt, including the bounded correction turns.
          return sse([{ choices: [{ delta: { content: raw.includes("placeholder module patched") ? verdictJson("placeholder") : verdictJson("reviewed the diff and the passing check") } }], usage }]);
        }
        if (!role.includes("Role: specialist-executor")) throw new Error(`unexpected native role: ${role}`);
        // Route on this session's own action line: sibling actions can
        // appear elsewhere in a specialist's context.
        const assigned = (action: Action): boolean => raw.includes(`Action: ${action.description}\\n`);
        const target = assigned(reviewedPatch) ? { id: "reviewed", path: "src/reviewed.ts", from: "reviewed = 'before'", to: `reviewed = 'after'; // api_key = ${SECRET_IN_DIFF}`, done: "reviewed module patched; VALIDATION EVIDENCE: declared output written" }
          : assigned(placeholderPatch) ? { id: "placeholder", path: "src/placeholder.ts", from: "placeholder = 'before'", to: "placeholder = 'after'", done: "placeholder module patched" }
          : assigned(failingVerification) ? { id: "failing", path: "src/failing.ts", from: "failing = 'before'", to: "failing = 'after'", done: "failing module patched" }
          : null;
        if (target === null) throw new Error("unexpected specialist action");
        if (target.path === "src/failing.ts") failingSpecialistBodies.push(raw);
        if (priorToolResults(body) === 0) {
          return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: `patch-${target.id}`, function: { name: "file.patch", arguments: JSON.stringify({ path: target.path, expected: target.from, replacement: target.to }) } }] } }], usage }]);
        }
        return sse([{ choices: [{ delta: { content: target.done } }], usage }]);
      }) as typeof fetch;

      const runtime = createCliRuntime(repo);
      const router = new RuntimeCatalogRouter(runtime);
      const campaignId = "native-critic-evidence";
      expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "start", idempotency_key: "start" }, command: { kind: "campaign.start", campaign_id: campaignId, plan_path: "plan.md", root_action: rootAction } })).toMatchObject({ ok: true });
      expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "branch", idempotency_key: "branch" }, command: { kind: "tree.branch", campaign_id: campaignId, node_id: "root", actions: [reviewedPatch, placeholderPatch, failingVerification] } })).toMatchObject({ ok: true });
      expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "submit", idempotency_key: "submit" }, command: { kind: "job.submit", id: "native-critic-evidence-job", operation_id: "submit", job_kind: CAMPAIGN_RUN_JOB_KIND, owner_scope_id: campaignId, idempotency_key: "submit" } })).toMatchObject({ ok: true, value: { dispatched: true } });
      await waitUntil(() => {
        const result = router.executeQuery({ schema_version: 1, query_id: "jobs", query: { kind: "job.list", include_terminal: true } });
        return result.ok && (result.value as { jobs: readonly { id: string; state: string }[] }).jobs.some((job) => job.id === "native-critic-evidence-job" && job.state === "completed");
      });

      const snapshot = runtime.manager.getCampaignSnapshot(campaignId)!;
      const reviewed = snapshot.nodes.find((node) => node.action_description === reviewedPatch.description)!;
      const placeholder = snapshot.nodes.find((node) => node.action_description === placeholderPatch.description)!;
      const failing = snapshot.nodes.find((node) => node.action_description === failingVerification.description)!;

      // D2(a): the critic received the specialist's own report AND the
      // harness-captured evidence -- not only the verifier's receipt.
      const reviewedCritic = criticBodies.find((body) => body.includes("reviewed module patched"));
      expect(reviewedCritic).toBeDefined();
      expect(reviewedCritic).toContain("HARNESS EVIDENCE");
      expect(reviewedCritic).toContain("Machine verification: passed");
      expect(reviewedCritic).toContain("Candidate diff (bounded, redacted; 1 file(s), +1/-1)");
      expect(reviewedCritic).toContain("-export const reviewed = 'before';");
      expect(reviewedCritic).toContain("+export const reviewed = 'after'");
      // Structural redaction applies to the diff before it reaches a model.
      expect(criticBodies.join("\n")).not.toContain(SECRET_IN_DIFF);
      expect(criticBodies.join("\n")).not.toContain("native-test-secret");
      // Provenance is unchanged by the richer input: the machine result is
      // the only source of `verified`, and the critic's approval stays a
      // critic verdict.
      expect(reviewed).toMatchObject({ state: "verified", provenance: { tag: "verified", exit: 0 }, critic_verdict: { approved: true } });

      // D2(b): a schema-shaped verdict of template text is malformed critic
      // output. The critic was told why and given its bounded corrections;
      // when they were spent, the review failed as malformed -- the node is
      // parked awaiting review with its candidate, never failed as rejected.
      const placeholderCritics = criticBodies.filter((body) => body.includes("placeholder module patched"));
      expect(placeholderCritics.length).toBeGreaterThan(1);
      expect(placeholderCritics.at(-1)).toContain("malformed_critic_verdict");
      expect(placeholder.state).toBe("awaiting_review");
      expect(placeholder.critic_verdict).toBeNull();

      // D4: the verifier's bounded output tail reached the critic, the node's
      // recorded failure, the retrying specialist's prompt, and the report.
      expect(criticBodies.find((body) => body.includes("failing module patched"))).toContain(VERIFIER_ERROR);
      expect(failingSpecialistBodies.length).toBeGreaterThan(1);
      expect(failingSpecialistBodies.at(-1)).toContain("machine verification failed: command_exit_nonzero (exit 3)");
      expect(failingSpecialistBodies.at(-1)).toContain(VERIFIER_ERROR);
      expect(failing.state).toBe("failed");
      const report = buildRunReport(runtime, campaignId);
      expect(report.ok).toBe(true);
      const reportedFailing = report.ok ? report.value.campaign.nodes.find((node) => node.id === failing.id) : undefined;
      expect(reportedFailing?.specialist_output).toContain(VERIFIER_ERROR);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.ARBOR_NATIVE_API_KEY; else process.env.ARBOR_NATIVE_API_KEY = previousKey;
      spawnSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" });
      rmSync(repo, { recursive: true, force: true });
    }
  }, 40_000);
});
