import { describe, expect, it } from "vitest";
import type { ExecutionPolicy } from "../src/protocol.js";
import type { CapabilitySupport } from "../src/capabilities.js";
import { HarnessAdmissionError, HarnessSessionError, NativeSessionEngine, isToolPermitted } from "../src/native-session.js";

class TestClock {
  constructor(private current = 1_700_000_000_000) {}
  now(): number { return this.current; }
  advance(milliseconds: number): void { this.current += milliseconds; }
}

const capabilities: readonly CapabilitySupport[] = [
  "streaming", "interruption", "resumption", "forking", "ephemeral_sessions", "structured_output", "tool_policy", "workspace_isolation", "approval_mediation", "usage_reporting", "artifact_capture", "remote_transport",
].map((capability) => ({ capability, grade: "native", evidence: { implementation_id: "native-reference", observed_at: "2026-08-09T00:00:00.000Z", detail: "native conformance" } })) as readonly CapabilitySupport[];

function policy(overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
  return {
    filesystem: "read_only",
    approvals: "always",
    tool_allow: ["read", "build"],
    tool_deny: [],
    workspace_roots: ["/workspace"],
    max_wall_clock_ms: 100,
    max_events: 10,
    network_allowed: false,
    ambient_plugins_allowed: false,
    user_configuration_allowed: false,
    inherited_credentials_allowed: false,
    ...overrides,
  };
}

function engine(clock = new TestClock()): NativeSessionEngine {
  return new NativeSessionEngine({ clock, capabilities });
}

describe("NativeSessionEngine", () => {
  it("admits cross-process continuation lineage only through a fresh durable authority callback", () => {
    const lineage = { kind: "continuation" as const, source_session_id: "crashed", checkpoint: 7, authorization_id: "auth-1" };
    expect(() => engine().start({ session_id: "continued", policy: policy(), required_capabilities: [], lineage, ephemeral: true })).toThrow(/lacks fresh durable authority/);
    const harness = new NativeSessionEngine({ clock: new TestClock(), capabilities, continuation_authority: (candidate, sessionId) => candidate.authorization_id === "auth-1" && sessionId === "continued" });
    expect(harness.start({ session_id: "continued", policy: policy(), required_capabilities: [], lineage, ephemeral: true }).lineage).toEqual(lineage);
  });
  it("records configured and observed model revision identity as content-free lifecycle evidence", () => {
    const harness = engine();
    harness.start({
      session_id: "revision", policy: policy(), required_capabilities: [], lineage: { kind: "new" }, ephemeral: true,
      model_identity: { provider_id: "fixture", model_id: "fixture-model", configured_revision: "fp_expected", revision: "fp_observed" },
    });
    expect(harness.observe("revision")[0]).toMatchObject({ kind: "lifecycle", payload: { model_identity: { provider_id: "fixture", model_id: "fixture-model", configured_revision: "fp_expected", revision: "fp_observed" } } });
  });

  it("creates immutable policy snapshots and ordered replay checkpoints", () => {
    const clock = new TestClock();
    const harness = engine(clock);
    const callerOwnedAllow = ["read", "build"];
    const requestPolicy = policy({ tool_allow: callerOwnedAllow });
    harness.start({ session_id: "s1", policy: requestPolicy, required_capabilities: [{ capability: "streaming", minimum_grade: "governed" }], lineage: { kind: "new" }, ephemeral: false });
    callerOwnedAllow.push("write");
    clock.advance(1);
    harness.record("s1", { kind: "model_text", payload: { text: "working", phase: "commentary" } });
    const replay = harness.observe("s1", 1);
    expect(replay.map((event) => event.sequence)).toEqual([2]);
    expect(replay[0]?.occurred_at).toBe("2023-11-14T22:13:20.001Z");
    expect(harness.inspect("s1").policy.tool_allow).toEqual(["read", "build"]);
    expect(Object.isFrozen(harness.inspect("s1").policy)).toBe(true);
  });

  it("fails admission when enforcement is missing or only externally observed", () => {
    const clock = new TestClock();
    const observed = capabilities.map((evidence) => evidence.capability === "streaming" ? { ...evidence, grade: "observed" as const } : evidence);
    const harness = new NativeSessionEngine({ clock, capabilities: observed });
    expect(() => harness.start({ session_id: "s1", policy: policy(), required_capabilities: [{ capability: "streaming", minimum_grade: "governed" }], lineage: { kind: "new" }, ephemeral: false })).toThrow(HarnessAdmissionError);
    expect(() => harness.start({ session_id: "s2", policy: policy(), required_capabilities: [{ capability: "streaming", minimum_grade: "observed" }], lineage: { kind: "new" }, ephemeral: false })).not.toThrow();
  });

  it("uses deny precedence for tools and rejects unsafe policy combinations", () => {
    expect(isToolPermitted(policy({ tool_deny: ["build"] }), "build")).toBe(false);
    const harness = engine();
    harness.start({ session_id: "s1", policy: policy({ tool_deny: ["build"] }), required_capabilities: [], lineage: { kind: "new" }, ephemeral: false });
    expect(() => harness.record("s1", { kind: "tool_intent", payload: { tool: "build", input_summary: "compile" } })).toThrow(HarnessSessionError);
    expect(() => harness.start({ session_id: "s2", policy: policy({ network_allowed: true, approvals: "never" }), required_capabilities: [], lineage: { kind: "new" }, ephemeral: false })).toThrow(HarnessAdmissionError);
  });

  it("settles cooperative interruption once and rejects later mutation", () => {
    const harness = engine();
    harness.start({ session_id: "s1", policy: policy(), required_capabilities: [], lineage: { kind: "new" }, ephemeral: false });
    const inspection = harness.interrupt("s1", "operator requested stop");
    expect(inspection.state).toBe("interrupted");
    expect(harness.observe("s1").map((event) => event.kind)).toEqual(["lifecycle", "interrupt_requested", "terminal"]);
    expect(() => harness.record("s1", { kind: "model_text", payload: { text: "late", phase: "final" } })).toThrow(HarnessSessionError);
  });

  it("prioritizes terminal interruption over event-limit failure", () => {
    const harness = engine();
    harness.start({ session_id: "tight", policy: policy({ max_events: 2 }), required_capabilities: [], lineage: { kind: "new" }, ephemeral: false });
    expect(harness.interrupt("tight", "stop").terminal).toMatchObject({ state: "interrupted", cause: "interrupted" });
  });

  it("preserves supplied provenance without upgrading a claimed completion", () => {
    const harness = engine();
    harness.start({ session_id: "s1", policy: policy(), required_capabilities: [], lineage: { kind: "new" }, ephemeral: false });
    const completed = harness.complete("s1", { result: "claimed", message: "done", provenance: { tag: "claimed", claimant: "seed" } });
    expect(completed.state).toBe("completed");
    expect(completed.terminal).toMatchObject({ result: "claimed", provenance: { tag: "claimed", claimant: "seed" } });

    harness.start({ session_id: "failed", policy: policy(), required_capabilities: [], lineage: { kind: "new" }, ephemeral: false });
    expect(harness.complete("failed", { result: "failed", message: "blocked", provenance: { tag: "claimed", claimant: "seed" } }).terminal)
      .toMatchObject({ state: "failed", cause: "failed", result: "failed" });
  });

  it("records deterministic bounds as provenance-free operational terminal causes", () => {
    const clock = new TestClock();
    const harness = engine(clock);
    harness.start({ session_id: "time", policy: policy(), required_capabilities: [], lineage: { kind: "new" }, ephemeral: false });
    clock.advance(101);
    expect(harness.inspect("time").terminal).toEqual({ state: "failed", cause: "wall_clock_limit", message: "session wall-clock limit exceeded" });

    harness.start({ session_id: "events", policy: policy({ max_events: 2 }), required_capabilities: [], lineage: { kind: "new" }, ephemeral: false });
    harness.record("events", { kind: "diagnostic", payload: { code: "one", message: "one" } });
    expect(harness.inspect("events").terminal?.cause).toBe("event_limit");
  });

  it("makes resume and fork explicit, validates checkpoint, and forbids ephemeral recovery", () => {
    const harness = engine();
    harness.start({ session_id: "source", policy: policy(), required_capabilities: [], lineage: { kind: "new" }, ephemeral: false });
    harness.complete("source", { result: "verified", message: "checked", provenance: { tag: "verified", cmd: "bun test", exit: 0, stdout_hash: "sha256:ok" } });
    harness.start({ session_id: "resumed", policy: policy(), required_capabilities: [], lineage: { kind: "resume", source_session_id: "source", checkpoint: 2 }, ephemeral: false });
    harness.start({ session_id: "forked", policy: policy(), required_capabilities: [], lineage: { kind: "fork", source_session_id: "source", checkpoint: 1 }, ephemeral: false });
    harness.start({ session_id: "short", policy: policy(), required_capabilities: [], lineage: { kind: "new" }, ephemeral: true });
    expect(() => harness.start({ session_id: "bad", policy: policy(), required_capabilities: [], lineage: { kind: "resume", source_session_id: "short", checkpoint: 1 }, ephemeral: false })).toThrow("ephemeral");
    expect(() => harness.start({ session_id: "too-far", policy: policy(), required_capabilities: [], lineage: { kind: "fork", source_session_id: "source", checkpoint: 99 }, ephemeral: false })).toThrow("checkpoint");
  });
});
