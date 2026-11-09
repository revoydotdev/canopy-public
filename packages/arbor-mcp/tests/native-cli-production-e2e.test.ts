import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action } from "@arbor/core";
import { CAMPAIGN_RUN_JOB_KIND } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { createCliRuntime } from "../src/cli.js";

const rootAction: Action = {
  description: "Root native role-routing fixture",
  estimated_gain: 1,
  estimated_cost: 1,
  category: "root",
  delegate_to: "crown",
};

const architectAction: Action = {
  description: "Produce an implementation-ready architecture plan",
  estimated_gain: 2,
  estimated_cost: 1,
  category: "architecture",
  delegate_to: "seed",
  execution_role: "architect",
};

const documentationAction: Action = {
  description: "Document the bounded native role-routing behavior",
  estimated_gain: 1,
  estimated_cost: 1,
  category: "documentation",
  delegate_to: "seed",
  execution_role: "documentation-writer",
  high_risk_tool_scope: { write_paths: ["docs/native-role-routing.md"], command_argv: [] },
};

const codingPatchAction: Action = {
  description: "Patch the bounded native workflow module",
  estimated_gain: 1,
  estimated_cost: 1,
  category: "implementation",
  delegate_to: "seed",
  high_risk_tool_scope: { write_paths: ["src/native-workflow.ts"], command_argv: [] },
};

const rejectedCodingAction: Action = {
  description: "Produce a deliberately rejected coding proposal",
  estimated_gain: 1,
  estimated_cost: 1,
  category: "implementation",
  delegate_to: "seed",
};

const metadata = {
  actor_id: "operator",
  correlation_id: "native-cli-e2e",
  requested_at: "2026-08-09T00:00:00.000Z",
  session: {},
};

interface ProviderRequest {
  readonly url: string;
  readonly authorization: string | null;
  readonly body: Record<string, unknown>;
}

function sse(payloads: readonly unknown[]): Response {
  const body = `${payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function approvalJson(): string {
  return JSON.stringify({
    approved: true,
    rationale: "bounded native review passed",
    root_cause: null,
    measurement_validated: true,
    guardrails_enforced: true,
    introspection_passed: true,
    stability_ok: true,
    checks: [
      { name: "root_cause", passed: true, detail: "no blocker" },
      { name: "measurement_validation", passed: true, detail: "machine verification is independently observed" },
      { name: "guardrail_enforcement", passed: true, detail: "reviewer has no tools" },
      { name: "introspection", passed: true, detail: "bounded context reviewed" },
      { name: "stability_monitoring", passed: true, detail: "no instability observed" },
    ],
  });
}

function rejectionJson(): string {
  return JSON.stringify({
    approved: false,
    rationale: "fixture critic rejected this bounded proposal",
    root_cause: "fixture_rejection",
    measurement_validated: true,
    guardrails_enforced: true,
    introspection_passed: true,
    stability_ok: true,
    checks: [
      { name: "root_cause", passed: false, detail: "the proposal is intentionally rejected" },
      { name: "measurement_validation", passed: true, detail: "machine verification was observed" },
      { name: "guardrail_enforcement", passed: true, detail: "write scope was bounded" },
      { name: "introspection", passed: true, detail: "reviewer inspected the artifact" },
      { name: "stability_monitoring", passed: true, detail: "no runtime instability observed" },
    ],
  });
}

function messages(body: Record<string, unknown>): readonly Record<string, unknown>[] {
  return body.messages as readonly Record<string, unknown>[];
}

function systemPrompt(body: Record<string, unknown>): string {
  return String(messages(body).find((message) => message.role === "system")?.content ?? "");
}

function toolResults(body: Record<string, unknown>): readonly string[] {
  return messages(body)
    .map((message) => message.content)
    .filter((content): content is string => typeof content === "string" && content.includes("Tool file."));
}

/**
 * Bound for the hermetic coding-workflow job. Unloaded this test takes ~9-10s
 * here and ~11-12s once the critic captures a per-session diff (the change
 * author's measurement), so the old 10s bound flaked under full-suite load.
 * 30s is roughly 3x the measured unloaded median; it is a deadlock guard, not a
 * performance assertion. HERMETIC_WORKFLOW_TEST_TIMEOUT_MS must stay above it
 * so a stuck job reports the descriptive wait error, not a bare vitest timeout.
 */
const HERMETIC_WORKFLOW_WAIT_MS = 30_000;
const HERMETIC_WORKFLOW_TEST_TIMEOUT_MS = 45_000;

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for production campaign job");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("native CLI production composition", () => {
  it("executes a hermetic native coding workflow through architect, documentation, governed patch, verifier, critic, durable session artifacts, and a rejected/backtracked sibling", async () => {
    const repo = mkdtempSync(join(tmpdir(), "arbor-native-cli-e2e-"));
    const originalFetch = globalThis.fetch;
    const previousKey = process.env.ARBOR_NATIVE_API_KEY;
    const requests: ProviderRequest[] = [];
    let rejectNextCritic = false;
    try {
      mkdirSync(join(repo, "src"));
      writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { build: "node -e \"process.stdout.write('fixture build passed')\"" } }), "utf8");
      writeFileSync(join(repo, "src/native-workflow.ts"), "export const workflow = 'before';\n", "utf8");
      writeFileSync(join(repo, "arbor.jsonc"), JSON.stringify({
        native: {
          mode: "native", adapter_id: "openai-compatible", provider_id: "fixture-provider", base_url: "http://native-provider.invalid/v1", model: "default-native-model",
          // Exercise the configured transport path through the real CLI
          // composition, not merely config validation. The workflow below
          // makes specialist and critic provider calls and must still finish
          // with these bounded values forwarded to every model adapter.
          transport: { timeout_ms: 12_000, max_response_bytes: 4_194_304 },
          usage_budget: { estimate_authority: "fixture-upper-bound", estimate_max_input_tokens: 20_000, estimate_max_output_tokens: 2_048, max_campaign_tokens: 300_000 },
        },
        agents: { seed: { model: "specialist-model" }, lenticel: { model: "critic-model" } },
      }), "utf8");
      spawnSync("git", ["init", "-q", repo], { stdio: "ignore" });
      spawnSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"], { stdio: "ignore" });
      spawnSync("git", ["-C", repo, "config", "user.name", "Native CLI test"], { stdio: "ignore" });
      spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
      spawnSync("git", ["-C", repo, "commit", "-qm", "fixture"], { stdio: "ignore" });

      process.env.ARBOR_NATIVE_API_KEY = "native-test-secret";
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const request = { url: String(input), authorization: new Headers(init?.headers).get("authorization"), body };
        requests.push(request);
        expect(request.url).toBe("http://native-provider.invalid/v1/chat/completions");
        const role = systemPrompt(body);
        if (role.includes("Role: critic-reviewer")) {
          const rejected = rejectNextCritic;
          rejectNextCritic = false;
          return sse([{ choices: [{ delta: { content: rejected ? rejectionJson() : approvalJson() } }], usage: { prompt_tokens: 13, completion_tokens: 7 } }]);
        }
        const priorToolResults = toolResults(body);
        if (role.includes("Role: architect")) {
          return sse([{ choices: [{ delta: { content: "architecture plan complete" } }], usage: { prompt_tokens: 17, completion_tokens: 5 } }]);
        }
        if (role.includes("Role: documentation-writer")) {
          if (priorToolResults.length === 0) {
            // This is a documentation-only path admitted by the immutable
            // host policy, not a model-supplied glob or arbitrary source path.
            return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "docs-markdown-write", function: { name: "file.write", arguments: JSON.stringify({ path: "docs/native-role-routing.md", content: "# Native role routing\n", create: true }) } }] } }], usage: { prompt_tokens: 13, completion_tokens: 4 } }]);
          }
          return sse([{ choices: [{ delta: { content: "documentation update complete" } }], usage: { prompt_tokens: 17, completion_tokens: 5 } }]);
        }
        if (role.includes("Role: specialist-executor")) {
          const coding = JSON.stringify(body).includes(codingPatchAction.description);
          if (!coding) {
            rejectNextCritic = true;
            return sse([{ choices: [{ delta: { content: "rejected coding output" } }], usage: { prompt_tokens: 11, completion_tokens: 3 } }]);
          }
          if (priorToolResults.length === 0) {
            return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "coding-exact-patch", function: { name: "file.patch", arguments: JSON.stringify({ path: "src/native-workflow.ts", expected: "workflow = 'before'", replacement: "workflow = 'after'" }) } }] } }], usage: { prompt_tokens: 15, completion_tokens: 4 } }]);
          }
          return sse([{ choices: [{ delta: { content: "coding patch complete" } }], usage: { prompt_tokens: 18, completion_tokens: 5 } }]);
        }
        throw new Error(`unexpected native role: ${role}`);
      }) as typeof fetch;

      const runtime = createCliRuntime(repo);
      // Admission/readiness is a composition-time decision.  The process
      // environment is deliberately disturbed after composition to prove a
      // dispatched native campaign retains the opaque startup overlay rather
      // than silently becoming an OpenCode fallback on a later env reread.
      delete process.env.ARBOR_NATIVE_API_KEY;
      const router = new RuntimeCatalogRouter(runtime);
      const campaignId = "native-cli-e2e";
      expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "start", idempotency_key: "start" }, command: { kind: "campaign.start", campaign_id: campaignId, plan_path: "plan.md", root_action: rootAction } })).toMatchObject({ ok: true, value: { accepted: true } });
      expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "branch", idempotency_key: "branch" }, command: { kind: "tree.branch", campaign_id: campaignId, node_id: "root", actions: [architectAction, documentationAction, codingPatchAction, rejectedCodingAction] } })).toMatchObject({ ok: true, value: { accepted: true } });
      expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "submit", idempotency_key: "submit" }, command: { kind: "job.submit", id: "native-cli-job", operation_id: "submit", job_kind: CAMPAIGN_RUN_JOB_KIND, owner_scope_id: campaignId, idempotency_key: "submit" } })).toMatchObject({ ok: true, value: { accepted: true, dispatched: true } });

      await waitUntil(() => {
        const result = router.executeQuery({ schema_version: 1, query_id: "jobs", query: { kind: "job.list", include_terminal: true } });
        return result.ok && (result.value as { jobs: readonly { id: string; state: string }[] }).jobs.some((job) => job.id === "native-cli-job" && job.state === "completed");
      }, HERMETIC_WORKFLOW_WAIT_MS);

      const snapshot = runtime.manager.getCampaignSnapshot(campaignId)!;
      const architect = snapshot.nodes.find((node) => node.action_description === architectAction.description)!;
      const documentation = snapshot.nodes.find((node) => node.action_description === documentationAction.description)!;
      const coding = snapshot.nodes.find((node) => node.action_description === codingPatchAction.description)!;
      const rejected = snapshot.nodes.find((node) => node.action_description === rejectedCodingAction.description)!;
      // Verification is now a per-node declared-outputs check (a real command,
      // exit 0). The architect is a planner: it declares no file output, so it
      // has nothing to machine-verify and is critic-approved `claimed` — the
      // old static `bun run build` verifier wrongly marked it verified. The
      // documentation and coding nodes produce their declared files and so
      // reach machine-verified. The exact cmd string is an internal detail.
      expect(architect).toMatchObject({ state: "claimed", provenance: { tag: "claimed" } });
      expect(documentation).toMatchObject({ state: "verified", provenance: { tag: "verified", exit: 0 } });
      expect(coding).toMatchObject({ state: "verified", provenance: { tag: "verified", exit: 0 } });
      expect(rejected).toMatchObject({ state: "failed", critic_verdict: { approved: false, root_cause: expect.stringContaining("fixture_rejection") } });
      expect(runtime.manager.getNodeInfo(campaignId, architect.id)!.action.execution_role).toBe("architect");
      expect(runtime.manager.getNodeInfo(campaignId, documentation.id)!.action.execution_role).toBe("documentation-writer");
      expect(coding.high_risk_tool_scope).toMatchObject({ declared: true, write_path_count: 1, command_argv_count: 0 });
      expect(requests.map((request) => request.body.model)).toEqual(expect.arrayContaining(["specialist-model", "critic-model"]));
      expect(requests.every((request) => request.authorization === "Bearer native-test-secret")).toBe(true);
      const architectRequests = requests.filter((request) => systemPrompt(request.body).includes("Role: architect"));
      const documentationRequests = requests.filter((request) => systemPrompt(request.body).includes("Role: documentation-writer"));
      const codingRequests = requests.filter((request) => systemPrompt(request.body).includes("Role: specialist-executor") && JSON.stringify(request.body).includes(codingPatchAction.description));
      const criticRequests = requests.filter((request) => systemPrompt(request.body).includes("Role: critic-reviewer"));
      expect(architectRequests).toHaveLength(1);
      expect(documentationRequests).toHaveLength(2);
      expect(codingRequests).toHaveLength(2);
      expect(toolResults(documentationRequests[1]!.body).join("\n")).toContain('"outcome":"succeeded"');
      expect(toolResults(codingRequests[1]!.body).join("\n")).toContain('"outcome":"succeeded"');
      // ADR-062: production campaigns now configure one bounded critic-block
      // retry by default (`createProductionCampaignLoopConfig`'s
      // `critic_retry: { max_retries: 1 }`). Without it the rejected sibling
      // gets exactly 1 critic call (architect 1 + documentation 2 + coding 2
      // + rejected 1 = 5); the bounded retry re-dispatches it to the
      // specialist and critic exactly once more before it fails terminally.
      expect(criticRequests).toHaveLength(6);
      expect(runtime.manager.getNodeInfo(campaignId, rejected.id)!.critic_retry_count).toBe(1);
      expect(criticRequests.every((request) => (request.body.response_format as { json_schema?: { name?: string; strict?: boolean } }).json_schema?.name === "revoy_native_critic_verdict" && (request.body.response_format as { json_schema?: { strict?: boolean } }).json_schema?.strict === true)).toBe(true);
      expect([...architectRequests, ...documentationRequests].every((request) => request.body.response_format === undefined)).toBe(true);
      const sessions = runtime.harnessSessions?.list();
      expect(sessions).toEqual(expect.arrayContaining([
        expect.objectContaining({ connector_id: "revoy-native", execution_kind: "direct_native", operation: "specialize", profile_id: "architect" }),
        expect.objectContaining({ connector_id: "revoy-native", execution_kind: "direct_native", operation: "specialize", profile_id: "documentation-writer" }),
        expect.objectContaining({ connector_id: "revoy-native", execution_kind: "direct_native", operation: "review" }),
      ]));
      const codingSession = sessions!.find((session) => session.node_id === coding.id && session.operation === "specialize")!;
      const sessionDetail = router.executeQuery({ schema_version: 1, query_id: "coding-session-detail", query: { kind: "harness.session.inspect", session_id: codingSession.session_id } });
      expect(sessionDetail).toMatchObject({ ok: true, value: {
        artifacts: [expect.objectContaining({ kind: "session_evidence_manifest", storage: "durable" })],
        tool_audits: [expect.objectContaining({ tool: "file.patch", outcome: "succeeded", action_scope: expect.objectContaining({ status: "bound", provenance_tag: "generated" }) })],
      } });
      const budget = runtime.nativeCampaignBudget.snapshot(campaignId);
      expect(budget).toMatchObject({ campaign_id: campaignId, reserved_tokens: 0 });
      expect(budget?.consumed_tokens).toBeGreaterThan(0);
      expect(budget?.reservations.every((reservation) => reservation.state === "settled")).toBe(true);
      expect(JSON.stringify(sessions)).not.toContain("native-test-secret");
      expect(JSON.stringify(sessionDetail)).not.toContain("native-test-secret");
      expect(JSON.stringify(sessionDetail)).not.toContain("src/native-workflow.ts");
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.ARBOR_NATIVE_API_KEY; else process.env.ARBOR_NATIVE_API_KEY = previousKey;
      spawnSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" });
      rmSync(repo, { recursive: true, force: true });
    }
  }, HERMETIC_WORKFLOW_TEST_TIMEOUT_MS);

  it("turns an OpenAI-compatible native human request into a lead-governed durable interview and can restart after the canonical answer", async () => {
    const repo = mkdtempSync(join(tmpdir(), "arbor-native-human-e2e-"));
    const originalFetch = globalThis.fetch;
    const previousKey = process.env.ARBOR_NATIVE_API_KEY;
    let specialistTurns = 0;
    try {
      writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { build: "node -e \"process.stdout.write('fixture build passed')\"" } }), "utf8");
      writeFileSync(join(repo, "arbor.jsonc"), JSON.stringify({
        native: { mode: "native", adapter_id: "openai-compatible", provider_id: "fixture-provider", base_url: "http://native-provider.invalid/v1", model: "default-native-model" },
        agents: { seed: { model: "specialist-model" }, lenticel: { model: "critic-model" } },
      }), "utf8");
      spawnSync("git", ["init", "-q", repo], { stdio: "ignore" });
      spawnSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"], { stdio: "ignore" });
      spawnSync("git", ["-C", repo, "config", "user.name", "Native CLI test"], { stdio: "ignore" });
      spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
      spawnSync("git", ["-C", repo, "commit", "-qm", "fixture"], { stdio: "ignore" });

      process.env.ARBOR_NATIVE_API_KEY = "native-human-secret";
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const role = systemPrompt(body);
        if (role.includes("Role: critic-reviewer")) return sse([{ choices: [{ delta: { content: approvalJson() } }], usage: { prompt_tokens: 3, completion_tokens: 3 } }]);
        if (!role.includes("Role: specialist-executor")) throw new Error(`unexpected native role: ${role}`);
        specialistTurns += 1;
        if (specialistTurns === 1) {
          const tools = body.tools as readonly { function?: { name?: string } }[];
          expect(tools.map((tool) => tool.function?.name)).toContain("request_human_input");
          return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "need-scope", function: { name: "request_human_input", arguments: JSON.stringify({ request_id: "scope", question: "Which approved scope should I implement?", reason: "the request is ambiguous" }) } }] } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }]);
        }
        return sse([{ choices: [{ delta: { content: "completed after governed restart" } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }]);
      }) as typeof fetch;

      const runtime = createCliRuntime(repo);
      const router = new RuntimeCatalogRouter(runtime);
      const campaignId = "native-human-e2e";
      expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "human-start", idempotency_key: "human-start" }, command: { kind: "campaign.start", campaign_id: campaignId, plan_path: "plan.md", root_action: rootAction } })).toMatchObject({ ok: true });
      expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "human-branch", idempotency_key: "human-branch" }, command: { kind: "tree.branch", campaign_id: campaignId, node_id: "root", actions: [{ ...architectAction, execution_role: undefined }] } })).toMatchObject({ ok: true });
      expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "human-submit", idempotency_key: "human-submit" }, command: { kind: "job.submit", id: "native-human-job", operation_id: "human-submit", job_kind: CAMPAIGN_RUN_JOB_KIND, owner_scope_id: campaignId, idempotency_key: "human-submit" } })).toMatchObject({ ok: true, value: { dispatched: true } });
      await waitUntil(() => {
        const result = router.executeQuery({ schema_version: 1, query_id: "human-job", query: { kind: "job.list", include_terminal: true } });
        return result.ok && (result.value as { jobs: readonly { id: string; state: string }[] }).jobs.some((job) => job.id === "native-human-job" && job.state === "completed");
      });

      const interviews = router.executeQuery({ schema_version: 1, query_id: "human-interviews", query: { kind: "userinput.list", campaign_id: campaignId, limit: 10 } });
      expect(interviews).toMatchObject({ ok: true });
      if (!interviews.ok) throw new Error("userinput.list failed");
      const record = (interviews.value as { records: readonly { id: string; question: Record<string, unknown> }[] }).records[0]!;
      expect(record.question).toMatchObject({
        question: "Which approved scope should I implement?", authority: "lead", blocking: "blocking", requester_role: "seed",
        origin_session_id: expect.stringContaining(`${campaignId}:`),
      });
      expect(record.question).not.toHaveProperty("answered_by");
      const sourceSession = String(record.question.origin_session_id);
      expect(runtime.harnessSessions?.events(sourceSession).map((event) => event.payload)).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "human_input_requested" }),
        expect.objectContaining({ code: "human_input_handed_off" }),
      ]));

      expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "human-answer", idempotency_key: "human-answer" }, command: { kind: "userinput.answer", record_id: record.id, answer: { option_id: null, custom_text: "Implement the approved internal scope.", answered_by: "operator", answered_at: "2026-08-09T00:00:01.000Z" } } })).toMatchObject({ ok: true, value: { accepted: true } });
      expect(router.executeQuery({ schema_version: 1, query_id: "human-awaiting", query: { kind: "userinput.awaiting", campaign_id: campaignId } })).toMatchObject({ ok: true, value: { awaiting: false } });
      expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "human-restart", idempotency_key: "human-restart" }, command: { kind: "job.submit", id: "native-human-restart", operation_id: "human-restart", job_kind: CAMPAIGN_RUN_JOB_KIND, owner_scope_id: campaignId, idempotency_key: "human-restart" } })).toMatchObject({ ok: true, value: { dispatched: true } });
      await waitUntil(() => {
        const result = router.executeQuery({ schema_version: 1, query_id: "human-restart-job", query: { kind: "job.list", include_terminal: true } });
        return result.ok && (result.value as { jobs: readonly { id: string; state: string }[] }).jobs.some((job) => job.id === "native-human-restart" && job.state === "completed");
      });
      // The architect is a planner with no declared file output, so it is
      // critic-approved `claimed`, not machine-verified (see the workflow test).
      expect(runtime.manager.getCampaignSnapshot(campaignId)?.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ action_description: architectAction.description, state: "claimed" })]));
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.ARBOR_NATIVE_API_KEY; else process.env.ARBOR_NATIVE_API_KEY = previousKey;
      spawnSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("executes only an independently activated declarative descriptor as one fixed no-tools native child and persists lineage/evidence", async () => {
    const repo = mkdtempSync(join(tmpdir(), "arbor-native-subagent-e2e-"));
    const originalFetch = globalThis.fetch; const previousKey = process.env.ARBOR_NATIVE_API_KEY;
    try {
      writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { build: "node -e \"process.stdout.write('fixture build passed')\"" } }), "utf8");
      writeFileSync(join(repo, "arbor.jsonc"), JSON.stringify({ native: { mode: "native", adapter_id: "openai-compatible", provider_id: "fixture-provider", base_url: "http://native-provider.invalid/v1", model: "fixture-model" } }), "utf8");
      spawnSync("git", ["init", "-q", repo], { stdio: "ignore" }); spawnSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"], { stdio: "ignore" }); spawnSync("git", ["-C", repo, "config", "user.name", "Native CLI test"], { stdio: "ignore" }); spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" }); spawnSync("git", ["-C", repo, "commit", "-qm", "fixture"], { stdio: "ignore" });
      process.env.ARBOR_NATIVE_API_KEY = "subagent-secret";
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body.tools).toBeUndefined();
        expect(systemPrompt(body)).toContain("Role: specialist-executor");
        return sse([{ choices: [{ delta: { content: "bounded child analysis" } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }]);
      }) as typeof fetch;
      const runtime = createCliRuntime(repo); const router = new RuntimeCatalogRouter(runtime); const campaignId = "native-subagent-e2e";
      await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "sub-start", idempotency_key: "sub-start" }, command: { kind: "campaign.start", campaign_id: campaignId, plan_path: "plan.md", root_action: rootAction } });
      runtime.manager.recordBusMessage({ campaign_id: campaignId, node_id: "root", author_node_id: "parent", recipient_node_id: "child", other_recipient_node_ids: [], kind: "delegate", payload: { content: "descriptor source", provenance: { tag: "claimed", claimant: "seed" } }, capability_tier: "specialist", trigger_turn: false, as_of: "2026-08-09T00:00:00.000Z", correlation_id: "subagent", idempotency_key: "subagent-source", acknowledges_communication_id: null, retracts_communication_id: null, conversation_id: "parent-child" });
      const messageId = runtime.manager.getAuditRecords(campaignId).find((record) => record.kind === "node_communication")!.id;
      const context = runtime.governedContext.captureArtifact({ campaign_id: campaignId, media_type: "text/plain", producer: "seed", visibility: "campaign", provenance: { tag: "claimed", claimant: "seed" }, content: "bounded approved context" });
      const revision = { id: "descriptor-native", campaign_id: campaignId, task_id: "task", component: "subagent_descriptor" as const, patch: { descriptor: { role: "seed", objective: "Inspect only the approved context", allowed_context_artifact_ids: [context.id], allowed_message_ranges: [], max_children: 1, recursive_delegation: false } }, source_event_ids: ["source-event"], source_message_ranges: [{ context_id: "parent-child", thread_id: "root", start_communication_id: messageId, end_communication_id: messageId, start_byte: 0, end_byte: 1 }], expected_benefit: "bounded independent analysis", proposed_by: "seed", provenance: { tag: "claimed", claimant: "seed" }, created_at: "2026-08-09T00:00:00.000Z", expires_at: "2030-01-01T00:00:00.000Z" };
      expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "sub-propose", idempotency_key: "sub-propose" }, command: { kind: "harness.propose", revision } })).toMatchObject({ ok: true, value: { accepted: true } });
      expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, actor_id: "lenticel", operation_id: "sub-approve", idempotency_key: "sub-approve" }, command: { kind: "harness.approve", revision_id: revision.id } })).toMatchObject({ ok: true, value: { accepted: true } });
      expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "sub-execute", idempotency_key: "sub-execute" }, command: { kind: "subagent.execute", campaign_id: campaignId, parent_node_id: "root", revision_id: revision.id } })).toMatchObject({ ok: true, value: { accepted: true } });
      await waitUntil(() => {
        const result = router.executeQuery({ schema_version: 1, query_id: "subagent-runs", query: { kind: "subagent.executions", campaign_id: campaignId } });
        return result.ok && (result.value as readonly { state: string }[]).some((item) => item.state === "completed");
      });
      const executions = router.executeQuery({ schema_version: 1, query_id: "subagent-runs-final", query: { kind: "subagent.executions", campaign_id: campaignId } });
      expect(executions).toMatchObject({ ok: true, value: [expect.objectContaining({ state: "completed", revision_id: revision.id, parent_node_id: "root", child_session_id: expect.stringContaining("native:subagent:"), result_artifact_id: expect.stringMatching(/^ctx_/), evidence_ids: expect.arrayContaining(["source-event"]) })] });
      expect(runtime.harnessSessions?.list(campaignId)).toEqual(expect.arrayContaining([expect.objectContaining({ operation: "specialize", profile_id: "specialist-executor", node_id: expect.stringMatching(/^subagent-/) })]));
    } finally { globalThis.fetch = originalFetch; if (previousKey === undefined) delete process.env.ARBOR_NATIVE_API_KEY; else process.env.ARBOR_NATIVE_API_KEY = previousKey; spawnSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" }); rmSync(repo, { recursive: true, force: true }); }
  });

  it("lets an OpenAI-compatible native specialist invoke only its host-provisioned peer query tool", async () => {
    const repo = mkdtempSync(join(tmpdir(), "arbor-native-peer-e2e-"));
    const originalFetch = globalThis.fetch; const previousKey = process.env.ARBOR_NATIVE_API_KEY;
    const leftAction: Action = { description: "Ask the sibling for its bounded status", estimated_gain: 1, estimated_cost: 1, category: "analysis", delegate_to: "seed" };
    const rightAction: Action = { ...leftAction, description: "Receive the bounded sibling status" };
    let leftNode = ""; let grantId = ""; let peerToolCalls = 0;
    try {
      writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { build: "node -e \"process.stdout.write('fixture build passed')\"" } }), "utf8");
      writeFileSync(join(repo, "arbor.jsonc"), JSON.stringify({ native: { mode: "native", adapter_id: "openai-compatible", provider_id: "fixture-provider", base_url: "http://native-provider.invalid/v1", model: "fixture-model" }, agents: { seed: { model: "specialist-model" }, lenticel: { model: "critic-model" } } }), "utf8");
      spawnSync("git", ["init", "-q", repo], { stdio: "ignore" }); spawnSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"], { stdio: "ignore" }); spawnSync("git", ["-C", repo, "config", "user.name", "Native CLI test"], { stdio: "ignore" }); spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" }); spawnSync("git", ["-C", repo, "commit", "-qm", "fixture"], { stdio: "ignore" });
      process.env.ARBOR_NATIVE_API_KEY = "native-peer-secret";
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>; const role = systemPrompt(body);
        if (role.includes("Role: critic-reviewer")) return sse([{ choices: [{ delta: { content: approvalJson() } }], usage: { prompt_tokens: 3, completion_tokens: 3 } }]);
        if (!role.includes("Role: specialist-executor")) throw new Error(`unexpected native role: ${role}`);
        const tools = body.tools as readonly { function?: { name?: string; parameters?: { properties?: { peer_node_id?: { enum?: readonly string[] } } } } }[] | undefined;
        const peerTool = tools?.find((tool) => tool.function?.name === "peer_query");
        if (peerTool !== undefined && peerToolCalls === 0) {
          const target = peerTool.function?.parameters?.properties?.peer_node_id?.enum?.[0]; if (!target) throw new Error("peer tool omitted its bounded endpoint enum");
          peerToolCalls += 1;
          return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "native-peer-query", function: { name: peerTool.function!.name!, arguments: JSON.stringify({ grant_id: grantId, peer_node_id: target, expected_version: "origin", content: "What is your bounded status?" }) } }] } }], usage: { prompt_tokens: 4, completion_tokens: 3 } }]);
        }
        return sse([{ choices: [{ delta: { content: "peer-aware specialist completed" } }], usage: { prompt_tokens: 4, completion_tokens: 3 } }]);
      }) as typeof fetch;
      const runtime = createCliRuntime(repo); const router = new RuntimeCatalogRouter(runtime); const campaignId = "native-peer-e2e";
      expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "peer-start", idempotency_key: "peer-start" }, command: { kind: "campaign.start", campaign_id: campaignId, plan_path: "plan.md", root_action: rootAction } })).toMatchObject({ ok: true, value: { accepted: true } });
      expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "peer-branch", idempotency_key: "peer-branch" }, command: { kind: "tree.branch", campaign_id: campaignId, node_id: "root", actions: [leftAction, rightAction] } })).toMatchObject({ ok: true, value: { accepted: true } });
      const children = runtime.manager.getCampaignSnapshot(campaignId)!.nodes.filter((node) => node.parent_id === "root"); leftNode = children.find((node) => node.action_description === leftAction.description)!.id;
      const provisioned = runtime.nativePeerChannels.provisionFromParentAuthority(campaignId, leftNode); expect(provisioned).toHaveLength(1); grantId = provisioned[0]!.grant_id;
      expect(await router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "peer-submit", idempotency_key: "peer-submit" }, command: { kind: "job.submit", id: "native-peer-job", operation_id: "peer-submit", job_kind: CAMPAIGN_RUN_JOB_KIND, owner_scope_id: campaignId, idempotency_key: "peer-submit" } })).toMatchObject({ ok: true, value: { dispatched: true } });
      await waitUntil(() => { const result = router.executeQuery({ schema_version: 1, query_id: "peer-job", query: { kind: "job.list", include_terminal: true } }); return result.ok && (result.value as { jobs: readonly { id: string; state: string }[] }).jobs.some((job) => job.id === "native-peer-job" && job.state === "completed"); });
      expect(peerToolCalls).toBe(1);
      expect(runtime.nativePeerChannels.history({ kind: "peer.history", grant_id: grantId }, { kind: "parent", actor_id: "peer-parent", campaign_id: campaignId, node_id: "root", capability_tier: "orchestrator" })).toMatchObject({ messages: expect.arrayContaining([expect.objectContaining({ kind: "clarify", author_node_id: expect.stringMatching(/^node_/) })]) });
    } finally { globalThis.fetch = originalFetch; if (previousKey === undefined) delete process.env.ARBOR_NATIVE_API_KEY; else process.env.ARBOR_NATIVE_API_KEY = previousKey; spawnSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" }); rmSync(repo, { recursive: true, force: true }); }
  });
});
