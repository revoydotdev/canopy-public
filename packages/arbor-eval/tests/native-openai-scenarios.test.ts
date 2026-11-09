/**
 * Hermetic end-to-end proof for the revoy-native composition seam.
 *
 * The OpenAI-compatible endpoint below is an in-process `fetch` fixture. No
 * socket, provider SDK, ambient API key, or clock is used. The scenarios
 * exercise the public @arbor/mcp surface rather than recreating adapter or
 * worker behavior in the eval package.
 */
import { describe, expect, it } from "vitest";
import { NativeAgentExecutor, composeNativeRole, createOpenAICompatibleModelPort } from "@arbor/mcp";

const observedAt = "2026-08-09T00:00:00.000Z";
const apiKey = "eval-opaque-provider-key";
const retainedSecret = "token=tool-output-secret-value";

const capabilities = ["streaming", "interruption", "ephemeral_sessions", "tool_policy", "approval_mediation", "usage_reporting"].map((capability) => ({
  capability: capability as "streaming" | "interruption" | "ephemeral_sessions" | "tool_policy" | "approval_mediation" | "usage_reporting",
  grade: "native" as const,
  evidence: { implementation_id: "eval-openai-compatible-fixture", observed_at: observedAt, detail: "in-process SSE fixture" },
}));

function sse(...events: readonly string[]): Response {
  return new Response(events.map((event) => `data: ${event}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function modelWithResponses(responses: readonly Response[], requests: RequestInit[]) {
  let cursor = 0;
  return createOpenAICompatibleModelPort({
    fetch: async (_url, init) => {
      requests.push(init ?? {});
      const response = responses[cursor++];
      if (!response) throw new Error("mock OpenAI-compatible fixture received an unexpected request");
      return response;
    },
    base_url: "https://mock-provider.invalid",
    provider_id: "mock-openai-compatible",
    model_id: "mock-native-model",
    observed_at: observedAt,
    credential_required: false,
    tools: [{ name: "repository.search", description: "search a bounded repository", parameters: { type: "object" }, risk: "low" }],
  });
}

describe("hermetic revoy-native OpenAI-compatible eval scenarios", () => {
  it("composes least-authority Architect, Documentation Writer, and coding roles", () => {
    const available = ["repository.search", "file.read", "file.write", "file.patch", "shell.execute", "verification.run", "git.status", "git.diff"];
    const architect = composeNativeRole({ role_id: "architect", task: "map the migration", available_tools: available });
    const docsReadOnly = composeNativeRole({ role_id: "documentation-writer", task: "document current behavior", available_tools: available });
    const docsBounded = composeNativeRole({ role_id: "documentation-writer", task: "document current behavior", available_tools: available, documentation_path_policy_enforced: true });
    const coding = composeNativeRole({ role_id: "specialist-executor", task: "implement the bounded change", available_tools: available, permitted_extension_tools: ["file.write", "file.patch"] });

    expect(architect.profile.allowed_tools).toContain("repository.search");
    expect(architect.profile.allowed_tools).not.toContain("file.write");
    expect(docsReadOnly.profile.allowed_tools).not.toContain("file.patch");
    expect(docsBounded.documentation_writes_admitted).toBe(true);
    expect(docsBounded.profile.allowed_tools).toContain("file.write");
    expect(coding.profile.allowed_tools).toEqual(expect.arrayContaining(["file.write", "file.patch"]));
    expect(architect.prompt).toContain("PLANNING");
    expect(docsBounded.prompt).toContain("DOCUMENTATION EXECUTION");
    expect(coding.prompt).toContain("bounded EXECUTION");
  });

  it("runs a mocked SSE tool campaign, keeps tool secrets out of events, and records measured usage", async () => {
    const requests: RequestInit[] = [];
    const model = modelWithResponses([
      sse(
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "search-", function: { name: "repository.search", arguments: '{"query":"native"}' } }] } }], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 80, cache_creation_tokens: 10 } } }),
        "[DONE]",
      ),
      sse(
        JSON.stringify({ choices: [{ delta: { content: "bounded coding result" } }], usage: { prompt_tokens: 21, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 14 } } }),
        "[DONE]",
      ),
    ], requests);
    const records: Array<{ inspection: { state: string }; events: readonly unknown[] }> = [];
    let toolCredential: string | null | undefined;
    const executor = new NativeAgentExecutor({
      workspace_root: "/workspace",
      capabilities,
      model_for_role: () => model,
      model_credential_for_session: () => ({ lease_id: "eval-model-lease", async inject(recipient) { return recipient(apiKey); } }),
      specialist_tools: () => [{
        tool: "repository.search",
        async execute(_request, secret) {
          toolCredential = secret;
          return { result_summary: `fixture retained ${retainedSecret}`, model_output: `model-only ${retainedSecret}`, evidence: { outcome: "succeeded", stage: "execution", code: "ok", effect: "observed", action_scope: { status: "not_required" } } };
        },
      }],
      on_session(record) { records.push(record); },
    });

    const result = await executor.specialize({ campaign_id: "eval", node_id: "coding", action: {}, prompt: "implement safely", worktree_path: "/workspace", specialist_agent: "seed" });

    expect(result.provenance).toEqual({ tag: "claimed", claimant: "seed" });
    // One expansion is one session, so this is the cumulative measured total
    // over both turns: input (100-80-10)+(21-14)=17, output 5+8=13, read 80+14=94, write 10.
    expect(result.token_usage).toEqual({ input_tokens: 17, output_tokens: 13, cached_input_tokens: 94, cache_write_input_tokens: 10, counter_source: "provider_counter" });
    expect(toolCredential).toBeNull(); // model lease is not automatically shared with tools
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.headers)).toEqual(expect.arrayContaining([
      expect.objectContaining({ authorization: `Bearer ${apiKey}` }),
    ]));
    expect(requests.map((request) => String(request.body)).join("\n")).not.toContain(apiKey);

    const retainedEvents = JSON.stringify(records[0]!.events);
    expect(records[0]!.inspection.state).toBe("completed");
    expect(retainedEvents).toContain("[REDACTED]");
    expect(retainedEvents).not.toContain(retainedSecret);
    expect(retainedEvents).not.toContain(apiKey);
  });

  it("preserves claimed completion until an independent verifier supplies verified provenance", async () => {
    const claimedRequests: RequestInit[] = [];
    const claimed = new NativeAgentExecutor({
      workspace_root: "/workspace", capabilities,
      model_for_role: () => modelWithResponses([sse(JSON.stringify({ choices: [{ delta: { content: "model says done" } }] }), "[DONE]")], claimedRequests),
    });
    const verifiedRequests: RequestInit[] = [];
    const verified = new NativeAgentExecutor({
      workspace_root: "/workspace", capabilities,
      model_for_role: () => modelWithResponses([sse(JSON.stringify({ choices: [{ delta: { content: "model says done" } }] }), "[DONE]")], verifiedRequests),
      specialist_verification: {
        async verify() { return { message: "independent check passed", provenance: { tag: "verified", cmd: "bun test", exit: 0, stdout_hash: "sha256:eval" } }; },
      },
    });

    const input = { campaign_id: "eval", node_id: "provenance", action: {}, prompt: "finish", worktree_path: "/workspace", specialist_agent: "seed" };
    await expect(claimed.specialize(input)).resolves.toMatchObject({ provenance: { tag: "claimed", claimant: "seed" } });
    // The specialist's own report reaches review alongside the independent
    // result; the verifier's message never replaces it.
    const verifiedResult = await verified.specialize(input);
    expect(verifiedResult).toMatchObject({ provenance: { tag: "verified", cmd: "bun test", exit: 0, stdout_hash: "sha256:eval" } });
    expect(verifiedResult.output.startsWith("model says done\n\nHARNESS EVIDENCE")).toBe(true);
    expect(verifiedResult.output).toContain("Machine verification: passed (command: bun test, exit 0");
  });

  it("settles a mocked provider request as interrupted when the operator aborts", async () => {
    let requestStarted: (() => void) | undefined;
    const model = createOpenAICompatibleModelPort({
      fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        requestStarted?.();
        (init?.signal as AbortSignal | undefined)?.addEventListener("abort", () => reject(new Error("fixture request aborted")), { once: true });
      }),
      base_url: "https://mock-provider.invalid", provider_id: "mock-openai-compatible", model_id: "interrupt-model", observed_at: observedAt, credential_required: false,
    });
    const records: Array<{ inspection: { state: string }; events: readonly unknown[] }> = [];
    const executor = new NativeAgentExecutor({ workspace_root: "/workspace", capabilities, model_for_role: () => model, on_session(record) { records.push(record); } });
    const controller = new AbortController();
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    const pending = executor.specialize({ campaign_id: "eval", node_id: "interrupt", action: {}, prompt: "wait", worktree_path: "/workspace", specialist_agent: "seed", signal: controller.signal });

    await started;
    controller.abort("operator stop");
    await expect(pending).rejects.toThrow("native specialist operation aborted");
    expect(records[0]!.inspection.state).toBe("interrupted");
    expect(JSON.stringify(records[0]!.events)).toContain("interrupt_requested");
  });
});
