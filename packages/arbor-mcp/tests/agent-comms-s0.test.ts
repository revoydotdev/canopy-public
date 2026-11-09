/**
 * Agent-communications Stage S0 hardening (docs/research/agent-comms): answered
 * user input reaches the asking session, async questions do not halt the loop,
 * thread/peer content is redacted on write, the peer-grant store survives
 * growth, and the connector relay's idempotency key is per attempt.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Action } from "@arbor/core";
import { NativeHarnessWorker, NativeSessionEngine, type NativeConversationEntry, type NativeModelPort, type NativeToolPort, type NativeToolRequest } from "@arbor/harness";
import { ArborRuntime } from "../src/runtime.js";
import { CampaignManager } from "../src/manager.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { createNativeUserInputToolPort, createNativeBusThreadToolPorts } from "../src/native-tool-host.js";
import { NativePeerChannelService, type NativePeerRelationshipGrant } from "../src/native-peer-channel.js";
import { postConnectorBusThreadReport, resolveConnectorBusThreadEdge, type NativeBusThreadScope } from "../src/native-bus-thread-contracts.js";

const root: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const PLANTED_KEY = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD";

function campaign(): { runtime: ArborRuntime; child: string; sibling: string } {
  const runtime = new ArborRuntime();
  runtime.manager.startCampaign("campaign", "plan.md", root);
  const [child, sibling] = runtime.manager.branch("campaign", "root", [{ ...root, description: "a", delegate_to: "seed" }, { ...root, description: "b", delegate_to: "seed" }]);
  return { runtime, child: child!, sibling: sibling! };
}

const policy = (tools: string[]) => ({
  filesystem: "read_only" as const, approvals: "never" as const, tool_allow: tools, tool_deny: [], workspace_roots: ["/workspace"],
  max_wall_clock_ms: 5_000, max_events: 64, network_allowed: false, ambient_plugins_allowed: false, user_configuration_allowed: false, inherited_credentials_allowed: false,
});

describe("userinput.ask answers reach the asking session (item 2)", () => {
  it("delivers the operator's answer, labelled and redacted, at the asking session's next turn boundary; an async ask does not block the loop", async () => {
    const { runtime, child } = campaign();
    const router = new RuntimeCatalogRouter(runtime);
    const sessionId = "ask-session";
    const engine = new NativeSessionEngine({ clock: { now: () => 1_700_000_000_000 }, capabilities: [] });
    const controller = new AbortController();
    const askPort = createNativeUserInputToolPort({ router, campaign_id: "campaign", node_id: child, session_id: sessionId });
    const noop: NativeToolPort = { tool: "noop.tool", recovery_protection: () => ({ effect_kind: "read_only", repeatable: true, idempotency_key_hash: null, acknowledged_by: null }), execute: async () => ({ result_summary: "ok", model_output: "{}", evidence: { outcome: "succeeded", stage: "execution", code: "ok", effect: "observed", action_scope: { status: "not_required" } } }) } as unknown as NativeToolPort;
    runtime.nativeSessionRegistry.register({ session_id: sessionId, campaign_id: "campaign", node_id: child, operation: "specialize", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "test", controller, inspect: () => engine.inspect(sessionId), events: () => engine.observe(sessionId) } as never);

    let turn = 0;
    let historyAtTurn3: readonly NativeConversationEntry[] = [];
    let asyncDidNotBlock = false;
    const model: NativeModelPort = {
      async run(request) {
        turn += 1;
        if (turn === 1) return { text: [], tool_calls: [{ call_id: "ask-1", tool: "userinput.ask", input: { question: "Which database?", options: [{ id: "pg", text: "Postgres" }] }, input_summary: "ask", risk: "low" }], final_message: null };
        if (turn === 2) {
          const asked = runtime.manager.getUserInputs("campaign", child);
          expect(asked).toHaveLength(1);
          expect(asked[0]!.question.origin_session_id).toBe(sessionId);
          // The async question is open yet the loop's blocking gate is clear.
          asyncDidNotBlock = !runtime.manager.awaitingUserInput("campaign") && runtime.manager.awaitingUserInput("campaign", undefined, "any");
          const answered = await router.dispatchCommand({
            schema_version: 1, metadata: { operation_id: "answer-1", idempotency_key: "answer-1", correlation_id: "c", actor_id: "operator", requested_at: new Date().toISOString() },
            command: { kind: "userinput.answer", record_id: asked[0]!.id, answer: { option_id: "pg", custom_text: `use ${PLANTED_KEY}`, answered_by: "human", answered_at: new Date().toISOString() } },
          } as never);
          expect(answered).toMatchObject({ ok: true, value: { accepted: true } });
          return { text: [], tool_calls: [{ call_id: "noop-1", tool: "noop.tool", input: {}, input_summary: "noop", risk: "low" }], final_message: null };
        }
        historyAtTurn3 = request.history;
        return { text: [], tool_calls: [], final_message: "done" };
      },
    };
    const worker = new NativeHarnessWorker({ session_engine: engine, model, tools: [askPort, noop], steering: runtime.nativeSessionRegistry });
    const result = await worker.run({ start: { session_id: sessionId, policy: policy(["userinput.ask", "noop.tool"]), required_capabilities: [], lineage: { kind: "new" }, ephemeral: false }, prompt: "work", max_turns: 5 });
    expect(result.session.state).toBe("completed");
    expect(asyncDidNotBlock).toBe(true);

    const delivered = historyAtTurn3.filter((entry) => entry.kind === "human_input");
    expect(delivered).toHaveLength(1);
    const text = (delivered[0] as { text: string }).text;
    expect(text).toContain("Operator answer to your userinput.ask question");
    expect(text).toContain("Chosen option pg: Postgres");
    expect(text).toContain("provenance claimed");
    expect(text).not.toContain(PLANTED_KEY);
    expect(runtime.manager.awaitingUserInput("campaign", undefined, "any")).toBe(false);
  });

  it("a blocking question still gates the loop, and an answer for a session that is gone is durable but undelivered", async () => {
    const { runtime, child } = campaign();
    const router = new RuntimeCatalogRouter(runtime);
    const ask = (blocking: "blocking" | "async", id: string) => router.dispatchCommand({
      schema_version: 1, metadata: { operation_id: id, idempotency_key: id, correlation_id: "c", actor_id: "operator", requested_at: new Date().toISOString() },
      command: { kind: "userinput.ask", campaign_id: "campaign", node_id: child, question: { operation_id: id, question: "q?", options: [{ id: "a", text: "A", is_other: false }], authority: "lead", blocking, requester_role: "taproot", origin_session_id: "gone-session", idempotency_key: id, as_of: new Date().toISOString() } },
    } as never);
    const blocking = await ask("blocking", "ask-blocking") as unknown as { value: { record_id: string } };
    expect(runtime.manager.awaitingUserInput("campaign")).toBe(true);
    const answer = await router.dispatchCommand({
      schema_version: 1, metadata: { operation_id: "ans", idempotency_key: "ans", correlation_id: "c", actor_id: "operator", requested_at: new Date().toISOString() },
      command: { kind: "userinput.answer", record_id: blocking.value.record_id, answer: { option_id: "a", custom_text: "", answered_by: "human", answered_at: new Date().toISOString() } },
    } as never);
    expect(answer).toMatchObject({ ok: true, value: { accepted: true } });
    expect(runtime.manager.awaitingUserInput("campaign")).toBe(false);
    expect(runtime.manager.getUserInputs("campaign", child)).toHaveLength(1);
  });
});

describe("thread and peer content is redacted on write (item 6)", () => {
  const contentsOf = (manager: CampaignManager) => manager.getAuditRecords("campaign").flatMap((record) => record.kind === "node_communication" ? [record.communication.payload.content] : []);

  it("a child's bus.thread.send with a planted key lands redacted in the ledger", async () => {
    const { runtime, child } = campaign();
    const router = new RuntimeCatalogRouter(runtime);
    const scope: NativeBusThreadScope = { campaign_id: "campaign", parent_node_id: "root", child_node_id: child, capability_tier: "specialist", provenance: { tag: "claimed", claimant: "test" } };
    const ports = createNativeBusThreadToolPorts({ router, resolve_scope: () => scope });
    const send = ports.find((port) => port.tool === "bus.thread.send")!;
    const request: NativeToolRequest = { session_id: "s", turn: 1, call_id: "c", input: { message_kind: "report", content: `found it: ${PLANTED_KEY}`, expected_thread_version: "origin" }, workspace_roots: [], filesystem: "read_only", intent_evidence: [], network_allowed: false };
    const response = await send.execute(request, null, new AbortController().signal);
    expect(response.evidence.outcome).toBe("succeeded");
    const stored = contentsOf(runtime.manager);
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toContain(PLANTED_KEY);
    expect(stored[0]).toContain("[REDACTED]");
    expect(JSON.stringify(runtime.manager.getParentChildThread("campaign", "root", child))).not.toContain(PLANTED_KEY);
  });

  it("a sibling peer.query with a planted key lands redacted in the ledger", () => {
    const { runtime, child, sibling } = campaign();
    const service = new NativePeerChannelService(runtime.manager);
    service.grant({ kind: "peer.grant", grant_id: "g", campaign_id: "campaign", parent_node_id: "root", left_node_id: child, right_node_id: sibling, capabilities: ["query", "reply"], capability_tier: "specialist", max_disclosure_bytes: 4096, expires_at: new Date(Date.now() + 3_600_000).toISOString(), provenance: { tag: "claimed", claimant: "parent" } }, { kind: "parent", actor_id: "root", campaign_id: "campaign", node_id: "root", capability_tier: "orchestrator" });
    const result = service.query({ kind: "peer.query", grant_id: "g", query_id: "q1", from_node_id: child, to_node_id: sibling, expected_version: "origin", content: `token: ${PLANTED_KEY}` }, "peer-idem-1", new Date().toISOString(), { kind: "peer", actor_id: child, campaign_id: "campaign", node_id: child, capability_tier: "specialist" });
    expect(result.accepted).toBe(true);
    const stored = contentsOf(runtime.manager);
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toContain(PLANTED_KEY);
  });
});

describe("peer-grant store growth (item 4)", () => {
  function grant(index: number, expiresAt: string): NativePeerRelationshipGrant {
    return { schema_version: 1, grant_id: `g-${index}`, campaign_id: "campaign", parent_node_id: "root", left_node_id: "l", right_node_id: "r", capabilities: ["query"], capability_tier: "specialist", max_disclosure_bytes: 1024, expires_at: expiresAt, granted_at: new Date().toISOString(), provenance: { tag: "claimed", claimant: "parent" } };
  }

  it("loads 300 live grants without refusing to boot (the old cap threw past 256)", () => {
    const dir = mkdtempSync(join(tmpdir(), "peer-store-")); dirs.push(dir);
    const live = new Date(Date.now() + 3_600_000).toISOString();
    writeFileSync(join(dir, "native-peer-grants.json"), JSON.stringify(Array.from({ length: 300 }, (_, i) => grant(i, live))));
    const service = new NativePeerChannelService(campaign().runtime.manager, { persistence_dir: dir });
    expect(service.list()).toHaveLength(300);
  });

  it("prunes grants expired beyond retention at load and rewrites the store; recently expired ones stay readable", () => {
    const dir = mkdtempSync(join(tmpdir(), "peer-store-")); dirs.push(dir);
    const longDead = new Date(Date.now() - 3 * 24 * 3_600_000).toISOString();
    const justExpired = new Date(Date.now() - 3_600_000).toISOString();
    const live = new Date(Date.now() + 3_600_000).toISOString();
    const file = join(dir, "native-peer-grants.json");
    writeFileSync(file, JSON.stringify([...Array.from({ length: 257 }, (_, i) => grant(i, longDead)), grant(1000, justExpired), grant(1001, live)]));
    const service = new NativePeerChannelService(campaign().runtime.manager, { persistence_dir: dir });
    expect(service.list().map((g) => g.grant_id)).toEqual(["g-1000", "g-1001"]);
    expect((JSON.parse(readFileSync(file, "utf8")) as unknown[]).length).toBe(2);
  });

  it("still rejects a structurally malformed store", () => {
    const dir = mkdtempSync(join(tmpdir(), "peer-store-")); dirs.push(dir);
    writeFileSync(join(dir, "native-peer-grants.json"), JSON.stringify({ not: "an array" }));
    expect(() => new NativePeerChannelService(campaign().runtime.manager, { persistence_dir: dir })).toThrow(/malformed/);
  });
});

describe("connector relay idempotency is per attempt (item 5)", () => {
  it("a retried node's second report is recorded rather than lost or conflicting; an identical replay adds nothing", async () => {
    const { runtime, child } = campaign();
    const edge = resolveConnectorBusThreadEdge(runtime, { campaign_id: "campaign", node_id: child }, "claude-code")!;
    const correlation_id = `claude-code:campaign:${child}`;
    const first = await postConnectorBusThreadReport(runtime, edge, { message_kind: "report", content: "attempt 1 failed", correlation_id });
    const retry = await postConnectorBusThreadReport(runtime, edge, { message_kind: "report", content: "attempt 2 completed", correlation_id });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(retry.ok, JSON.stringify(retry)).toBe(true);
    // An identical replay never mints a third record (it is either deduped or refused by the version check).
    await postConnectorBusThreadReport(runtime, edge, { message_kind: "report", content: "attempt 2 completed", correlation_id });
    const contents = runtime.manager.getParentChildThread("campaign", "root", child).messages.map((m) => (m.payload_preview as { content?: string }).content);
    expect(contents).toEqual(["attempt 1 failed", "attempt 2 completed"]);
  });
});
