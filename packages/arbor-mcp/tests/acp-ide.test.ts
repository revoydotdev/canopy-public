import { PassThrough, Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeEventStream } from "@arbor/core";
import { AcpIdeJourney, createAcpIdeRuntimePort, type AcpIdeDraft, type AcpIdeRuntimePort, type AcpIdeVerifiedResult } from "../src/acp-ide.js";
import { runAcpIdeStdio } from "../src/acp-ide-stdio.js";
import { CampaignManager } from "../src/manager.js";
import { ArborRuntime } from "../src/runtime.js";
import { main } from "../src/cli.js";

function draft(overrides: Partial<AcpIdeDraft> = {}): AcpIdeDraft {
  return { draft_id: "draft-1", revision: 2, status: "admitted", campaign_id: "campaign-1", job_id: "job-1", questions: [], ...overrides };
}

function verified(): AcpIdeVerifiedResult {
  return { campaign_id: "campaign-1", node_id: "node-1", summary: "checked", files: ["packages/arbor-mcp/src/acp-ide.ts"], provenance: { tag: "verified", cmd: "bun run test", exit: 0, stdout_hash: "sha256:test" } };
}

function runtime(): { port: AcpIdeRuntimePort; stream: RuntimeEventStream; calls: string[]; setDraft(value: AcpIdeDraft): void; setResults(value: readonly AcpIdeVerifiedResult[]): void } {
  const stream = new RuntimeEventStream("acp-test"); const calls: string[] = []; let current = draft(); let results: readonly AcpIdeVerifiedResult[] = [];
  return {
    stream, calls, setDraft(value) { current = value; }, setResults(value) { results = value; },
    port: {
      async submitIdeTask(input) { calls.push(`submit:${input.task}:${input.auto_confirm}`); return current; },
      async answerTaskComposerQuestion(input) { calls.push(`answer-plan:${input.question_id}:${input.expected_revision}`); return current; },
      async answerCampaignQuestion(input) { calls.push(`answer-campaign:${input.record_id}`); },
      async cancelPlanning(input) { calls.push(`cancel-plan:${input.draft_id}:${input.expected_revision}`); return { ...current, status: "cancelled" }; },
      async cancelCampaign(input) { calls.push(`cancel-campaign:${input.campaign_id}:${input.idempotency_key}`); },
      subscribeRuntimeEvents(sink) { const subscription = stream.subscribe(); const timer = setInterval(() => subscription.poll().forEach(sink), 1); return () => { clearInterval(timer); subscription.close(); }; },
      pendingCampaignQuestions() { return []; },
      verifiedResults() { return results; },
    },
  };
}

async function request(journey: AcpIdeJourney, value: unknown) { return journey.dispatch(value); }
async function setup(journey: AcpIdeJourney) { await request(journey, { method: "initialize", protocol_version: 1, client_name: "VS Code" }); await request(journey, { method: "session/new", session_id: "ide-1" }); }

describe("ACP IDE journey", () => {
  it("maps IDE task submission, canonical progress, operator questions, and only verified result handoff", async () => {
    const fake = runtime();
    fake.setDraft(draft({ status: "awaiting_clarification", campaign_id: null, job_id: null, questions: [{ question_id: "scope", question: "Which package?", revision: 2, authority: "taskcomposer" }] }));
    const journey = new AcpIdeJourney(fake.port); await setup(journey);
    await expect(request(journey, { method: "session/prompt", session_id: "ide-1", prompt: "Add ACP", idempotency_key: "prompt-1" })).resolves.toMatchObject({ ok: true, result: { status: "awaiting_clarification" } });
    expect(fake.calls).toContain("submit:Add ACP:true");
    let events = await request(journey, { method: "session/events", session_id: "ide-1" });
    expect(events.ok && (events.result.events as readonly unknown[]).some((event) => typeof event === "object" && event !== null && (event as { method?: string }).method === "session/request_permission")).toBe(true);
    fake.setDraft(draft({ questions: [] }));
    await expect(request(journey, { method: "session/question/answer", session_id: "ide-1", question_id: "scope", expected_revision: 2, answer: "arbor-mcp" })).resolves.toMatchObject({ ok: true });
    expect(fake.calls).toContain("answer-plan:scope:2");
    fake.setResults([verified()]);
    fake.stream.publish({ id: "event-1", occurred_at: "2026-08-24T00:00:00.000Z", correlation_id: "campaign-1", redacted: false, event: { kind: "tree.node_changed", campaign_id: "campaign-1", node_id: "node-1", state: "verified" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    events = await request(journey, { method: "session/events", session_id: "ide-1" });
    expect(events.ok && (events.result.events as readonly unknown[]).some((event) => typeof event === "object" && event !== null && (event as { method?: string }).method === "session/update")).toBe(true);
    expect(events.ok && (events.result.events as readonly unknown[]).some((event) => typeof event === "object" && event !== null && (event as { method?: string }).method === "session/result")).toBe(true);
    await expect(request(journey, { method: "session/result", session_id: "ide-1" })).resolves.toMatchObject({ ok: true, result: { result: { node_id: "node-1" } } });
    journey.close();
  });

  it("fails malformed or stale requests closed and uses the canonical cancellation port", async () => {
    const fake = runtime(); const journey = new AcpIdeJourney(fake.port);
    await expect(request(journey, { method: "session/new", session_id: "ide-1" })).resolves.toMatchObject({ ok: false, error: { code: "not_initialized" } });
    await setup(journey);
    await expect(request(journey, { method: "session/prompt", session_id: "ide-1", prompt: "x", idempotency_key: "bad key spaces" })).resolves.toMatchObject({ ok: false, error: { code: "invalid_request" } });
    await request(journey, { method: "session/prompt", session_id: "ide-1", prompt: "run", idempotency_key: "prompt-2" });
    await expect(request(journey, { method: "session/question/answer", session_id: "ide-1", question_id: "wrong", expected_revision: 1, answer: "no" })).resolves.toMatchObject({ ok: false, error: { code: "governance" } });
    await expect(request(journey, { method: "session/cancel", session_id: "ide-1", reason: "operator stopped" })).resolves.toMatchObject({ ok: true, result: { cancelled: true } });
    expect(fake.calls).toContain("cancel-campaign:campaign-1:acp-cancel:ide-1:campaign-1");
    journey.close();
  });

  it("speaks ACP v1 JSON-RPC on stdio and refuses client-owned MCP authority", async () => {
    const fake = runtime(); const journey = new AcpIdeJourney(fake.port); const output: string[] = [];
    async function* lines() {
      yield [
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"VS Code","version":"1"}}}',
        '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/workspace","mcpServers":[]}}',
        '{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"revoy-1","prompt":[{"type":"text","text":"Add ACP"}]}}',
        '{"jsonrpc":"2.0","id":4,"method":"session/new","params":{"cwd":"/workspace","mcpServers":[{"name":"client-owned"}]}}',
        "not-json",
      ].join("\n") + "\n";
    }
    await runAcpIdeStdio(journey, { [Symbol.asyncIterator]: lines }, { write(chunk) { output.push(chunk); } });
    const messages = output.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(messages).toContainEqual(expect.objectContaining({ jsonrpc: "2.0", id: 1, result: expect.objectContaining({ protocolVersion: 1, agentCapabilities: {} }) }));
    expect(messages).toContainEqual(expect.objectContaining({ jsonrpc: "2.0", id: 2, result: { sessionId: "revoy-1" } }));
    expect(messages).toContainEqual(expect.objectContaining({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } }));
    expect(messages).toContainEqual(expect.objectContaining({ jsonrpc: "2.0", id: 4, error: expect.objectContaining({ code: -32003 }) }));
    expect(messages).toContainEqual(expect.objectContaining({ jsonrpc: "2.0", id: null, error: expect.objectContaining({ code: -32700 }) }));
    journey.close();
  });

  it("starts the production ACP composition from the CLI", async () => {
    const root = mkdtempSync(join(tmpdir(), "revoy-acp-cli-"));
    const persistence = join(root, ".arbor");
    const boundRuntime = new ArborRuntime({ manager: new CampaignManager() });
    const stdout = new PassThrough(); const stderr = new PassThrough(); let output = "";
    stdout.on("data", (chunk) => { output += chunk.toString(); });
    try {
      await expect(main(["acp"], {
        cwd: root, persistence_dir: persistence,
        stdin: Readable.from(['{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"VS Code","version":"1"}}}\n']), stdout, stderr,
        runtime_factory: () => boundRuntime,
      })).resolves.toBe(0);
      expect(JSON.parse(output)).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "revoy" } } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("binds the production port to TaskComposer, RuntimeEventStream, the user-input ledger, interruption, and verified-result service", async () => {
    const manager = new CampaignManager();
    const proposal = JSON.stringify({ summary: "implement", assumptions: [], questions: [], root_action: { description: "root", estimated_gain: 1, estimated_cost: 1, category: "delivery", delegate_to: "crown" }, actions: [{ description: "implement", estimated_gain: 1, estimated_cost: 1, category: "delivery", delegate_to: "seed" }], acceptance_checks: [], acceptance_mapping: [], risk_notes: [] });
    const runtime = new ArborRuntime({ manager, task_composer_planner: { plan: async () => ({ raw_proposal: proposal, session_id: "planner", model_identity: "test", usage: { kind: "unavailable", reason: "test" } }) } });
    const port = createAcpIdeRuntimePort(runtime);
    const received: string[] = []; const unsubscribe = port.subscribeRuntimeEvents((event) => received.push(event.id));
    const submitted = await port.submitIdeTask({ task: "Add IDE support", idempotency_key: "ide-submit", auto_confirm: false });
    expect(runtime.taskComposer.get(submitted.draft_id)?.source).toBe("ide");
    expect(submitted.status).toBe("proposed");

    const admitted = manager.admitCampaignPlan({ id: "ide-campaign", plan_path: ".arbor/ide.json", root_action: { description: "root", estimated_gain: 1, estimated_cost: 1, category: "delivery", delegate_to: "crown" }, actions: [{ description: "change", estimated_gain: 1, estimated_cost: 1, category: "delivery", delegate_to: "seed" }] });
    if (!admitted.ok) throw new Error("test campaign admission failed");
    const recordId = manager.askForUserInput({ campaign_id: admitted.campaign_id, node_id: admitted.child_ids[0]!, operation_id: "ide-question", question: "Proceed?", options: [{ id: "yes", text: "Yes", is_other: false }], authority: "delegated_needs_input", blocking: "async", requester_role: "seed", idempotency_key: "ide-question", as_of: "2026-08-24T00:00:00.000Z" });
    expect(port.pendingCampaignQuestions(admitted.campaign_id)).toMatchObject([{ record_id: recordId, authority: "campaign" }]);
    await port.answerCampaignQuestion({ record_id: recordId, answer: "yes" });
    expect(manager.answeredUserInputIds(admitted.campaign_id)).toContain(recordId);

    runtime.resultVerification.record({ campaign_id: admitted.campaign_id, node_id: admitted.child_ids[0]!, checks: [], files: ["packages/arbor-mcp/src/acp-ide.ts"], diffstat: { additions: 1, deletions: 0, files_changed: 1 }, confidence: "verified", absence_reason: null, provenance: { tag: "verified", cmd: "bun run test", exit: 0, stdout_hash: "sha256:test" }, idempotency_key: "ide-result" });
    expect(port.verifiedResults(admitted.campaign_id)).toMatchObject([{ node_id: admitted.child_ids[0], provenance: { tag: "verified" } }]);

    expect(manager.expandNode(admitted.campaign_id, admitted.child_ids[0]!, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true })).toMatchObject({ ok: true });
    await port.cancelCampaign({ campaign_id: admitted.campaign_id, reason: "IDE cancelled", idempotency_key: "ide-cancel" });
    expect(manager.getNodeInfo(admitted.campaign_id, admitted.child_ids[0]!)?.state).toBe("interrupted");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(received.length).toBeGreaterThan(0);
    unsubscribe();
  });
});
