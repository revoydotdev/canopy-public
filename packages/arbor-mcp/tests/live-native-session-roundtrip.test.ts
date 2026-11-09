import { describe, expect, it } from "vitest";
import type { LoopExecutor } from "@arbor/opencode";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { createNativeLoopExecutor } from "../src/native-loop-executor.js";
import { HarnessSessionJournal } from "../src/harness-session-journal.js";

const action = { description: "task", estimated_gain: 1, estimated_cost: 1, category: "code" as const, delegate_to: "seed" as const };
const metadata = (operation_id: string) => ({ operation_id, idempotency_key: operation_id, actor_id: "operator", requested_at: "2026-08-09T00:00:00.000Z", session: {} });
const interrupt = (session_id: string, operation_id: string) => ({ schema_version: 1 as const, metadata: metadata(operation_id), command: { kind: "harness.session.interrupt" as const, session_id, reason: "operator requested stop", provenance: { tag: "generated" as const, generator: "test", input_hash: "sha256:test" } } });

describe("live native session catalog round trip", () => {
  it("lists, inspects, redacts events, and aborts the exact live session without a node-interrupt fallback", async () => {
    const journal = new HarnessSessionJournal();
    const runtime = new ArborRuntime({ harness_sessions: journal });
    const router = new RuntimeCatalogRouter(runtime);
    let sessionId = "";
    let dispatched!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => { dispatched = resolve; });
    const downstream: LoopExecutor = {
      specialize({ signal }) {
        // The fallback connector cannot dispatch before the same durable
        // lifecycle checkpoint used by direct-native sessions exists.
        expect(journal.events(sessionId).map((event) => event.kind)).toEqual(["lifecycle"]);
        dispatched();
        return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("connector aborted")), { once: true }));
      },
      async review() { throw new Error("unused"); },
    };
    const executor = createNativeLoopExecutor({
      downstream,
      live_sessions: runtime.nativeSessionRegistry,
      on_session_started(record) {
        sessionId = record.inspection.session_id;
        expect(journal.recordStarted({ session_id: sessionId, campaign_id: record.campaign_id, node_id: record.node_id, operation: record.operation, connector_id: record.connector_id, execution_kind: record.execution_kind, profile_id: "seed", state: record.inspection.state, latest_sequence: record.inspection.latest_sequence })).toBe(true);
      },
      on_session_event(record) { if (!journal.recordEvent(record.event)) throw new Error("fixture failed to persist fallback event"); },
      on_session(record) { journal.record(record); },
    });

    const running = executor.specialize({ campaign_id: "campaign", node_id: "node", action, prompt: "implement", worktree_path: "/workspace", specialist_agent: "seed" });
    await dispatchStarted;
    expect(sessionId).not.toBe("");
    expect(journal.recordToolAudit({
      session_id: sessionId, call_id: "host-refusal", tool: "file.write", risk: "high", intent: null,
      action_scope: { status: "absent" }, outcome: "refused", stage: "audit", code: "action_scope_missing_or_stale", effect: "none", confinement: "application_validated", summary: "redacted host summary",
    })).toBe(true);
    expect(router.executeQuery({ schema_version: 1, query_id: "list", query: { kind: "harness.session.list", limit: 20 } })).toMatchObject({ ok: true, value: { sessions: [{ session_id: sessionId, state: "running" }] } });
    expect(router.executeQuery({ schema_version: 1, query_id: "inspect", query: { kind: "harness.session.inspect", session_id: sessionId } })).toMatchObject({ ok: true, value: { session_id: sessionId, connector_id: "opencode", execution_kind: "connector_fallback", tool_audits: [{ outcome: "refused", effect: "none", action_scope: { status: "absent" } }] } });
    expect(router.executeQuery({ schema_version: 1, query_id: "events", query: { kind: "harness.session.events", session_id: sessionId } })).toMatchObject({ ok: true, value: { session_id: sessionId, events: [{ kind: "lifecycle", payload: { state: "started", ephemeral: true } }] } });

    await expect(router.dispatchCommand(interrupt(sessionId, "stop-live"))).resolves.toMatchObject({ ok: true, value: { accepted: true, operation_id: "stop-live" } });
    await expect(running).rejects.toThrow("ended before connector returned a result");
    expect(journal.inspect(sessionId)).toMatchObject({ state: "interrupted", connector_id: "opencode", execution_kind: "connector_fallback", terminal: { cause: "interrupted" } });
    await expect(router.dispatchCommand(interrupt(sessionId, "stop-terminal"))).resolves.toMatchObject({ ok: false, error: { code: "conflict" } });
    await expect(router.dispatchCommand(interrupt("missing", "stop-missing"))).resolves.toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
});
