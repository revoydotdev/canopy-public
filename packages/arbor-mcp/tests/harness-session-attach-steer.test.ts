import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionInspection } from "@arbor/harness";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";

const policy = { filesystem: "read_only" as const, approvals: "never" as const, tool_allow: [], tool_deny: [], workspace_roots: ["/workspace"], max_wall_clock_ms: 10_000, max_events: 16, network_allowed: false, ambient_plugins_allowed: false, user_configuration_allowed: false, inherited_credentials_allowed: false };
const metadata = (id: string) => ({ operation_id: id, idempotency_key: id, actor_id: "operator", requested_at: "2026-08-20T00:00:00.000Z", session: {} });

describe("canonical session attach and steering", () => {
  it("attaches to one live tail and queues bounded redacted steering for its next safe turn", async () => {
    const runtime = new ArborRuntime();
    const controller = new AbortController();
    const inspection: SessionInspection = { session_id: "live-1", state: "running", policy, capabilities: [], lineage: { kind: "new" }, ephemeral: false, latest_sequence: 1, terminal: null };
    const events: readonly SessionEvent[] = [{ protocol_version: "1", session_id: "live-1", sequence: 1, occurred_at: "2026-08-20T00:00:00.000Z", kind: "lifecycle", payload: { state: "started", lineage: { kind: "new" }, ephemeral: false } }];
    runtime.nativeSessionRegistry.register({ session_id: "live-1", campaign_id: "campaign-1", node_id: "node-1", operation: "specialize", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "architect", controller, inspect: () => inspection, events: (after = 0) => events.filter((event) => event.sequence > after) });
    const router = new RuntimeCatalogRouter(runtime);
    expect(router.executeQuery({ schema_version: 1, query_id: "attach", query: { kind: "harness.session.attach", session_id: "live-1", after_sequence: 0, limit: 20 } })).toMatchObject({ ok: true, capability: "harness.session.read", value: { live: true, pending_steering: 0, next_after_sequence: 1, session: { session_id: "live-1" }, events: [{ sequence: 1 }] } });
    expect(await router.dispatchCommand({ schema_version: 1, metadata: metadata("steer-1"), command: { kind: "harness.session.steer", session_id: "live-1", message: "Use API_KEY=supersecretvalue only as a test marker", provenance: { tag: "claimed", claimant: "operator" } } })).toMatchObject({ ok: true, capability: "harness.session.write", value: { accepted: true, operation_id: "steer-1" } });
    expect(runtime.nativeSessionRegistry.inspect("live-1")).toMatchObject({ pending_steering: 1, attachable: true });
    expect(runtime.nativeSessionRegistry.drain("live-1")).toEqual([{ message_id: "steer-1", text: "Use API_KEY=[REDACTED] only as a test marker", provenance: { tag: "claimed", claimant: "operator" } }]);
    expect(runtime.nativeSessionRegistry.inspect("live-1")).toMatchObject({ pending_steering: 0 });
  });
});
