import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_SESSION_JOURNAL_REFUSED_EVENT, HARNESS_SESSION_JOURNAL_REFUSED_FIELD, HarnessSessionJournal, redactHarnessSessionEvent } from "../src/harness-session-journal.js";
import { HOOK_ALL_EVENTS, type HookEvent } from "../src/hooks/contracts.js";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("HarnessSessionJournal", () => {
  it("retains only opaque operation joins in redacted tool-result projections", () => {
    const operation = `sha256:${"a".repeat(64)}`;
    const source = `sha256:${"b".repeat(64)}`;
    const projected = redactHarnessSessionEvent({
      session_id: "s1", sequence: 3, occurred_at: "2026-09-23T00:00:00.000Z", kind: "tool_result",
      payload: {
        tool: "file.read", success: true, operation_id: operation, reused_from_operation_id: source,
        result_summary: "sensitive summary must not be durable",
        evidence: { outcome: "succeeded", stage: "execution", code: "memoized_read", effect: "observed", action_scope: { status: "not_required" } },
      },
    });
    expect(projected.payload).toMatchObject({ operation_id: operation, reused_from_operation_id: source });
    expect(JSON.stringify(projected)).not.toContain("sensitive summary");
  });

  it("durably replays bounded runtime hook invocation evidence", () => {
    const persistence_dir = mkdtempSync(join(tmpdir(), "arbor-hook-journal-"));
    dirs.push(persistence_dir);
    const journal = new HarnessSessionJournal({ persistence_dir });
    expect(journal.recordHookFired({
      hook_id: "deny-shell", version: "1.0.0", kind: "veto", event: "tool_preflight",
      decision: "deny", evidence_ref: "tool=shell.execute", at: "2026-08-12T00:00:00.000Z",
    })).toBe(true);
    expect(new HarnessSessionJournal({ persistence_dir }).hookInvocations()).toEqual([
      expect.objectContaining({ hook_id: "deny-shell", event: "tool_preflight", decision: "deny" }),
    ]);
  });

  it("durably records an inject firing, the fourth HookFiredRecord kind", () => {
    const persistence_dir = mkdtempSync(join(tmpdir(), "arbor-hook-inject-journal-"));
    dirs.push(persistence_dir);
    const journal = new HarnessSessionJournal({ persistence_dir });
    // Refusing this kind made `on_fired` throw
    // "runtime hook evidence could not be durably recorded" out of
    // `injectForSession`, which took the whole session down — a failure that
    // could only surface once the inject lane had an activated descriptor.
    expect(journal.recordHookFired({
      hook_id: "session-governance-orient", version: "1.0.0", kind: "inject", event: "session_start",
      decision: "observed", evidence_ref: "session_start injected=governance-orient lane=ADVISORY",
      at: "2026-08-12T00:00:00.000Z", derived_from: ["posture:0123456789abcdef"],
    })).toBe(true);
    expect(new HarnessSessionJournal({ persistence_dir }).hookInvocations()).toEqual([
      expect.objectContaining({ hook_id: "session-governance-orient", event: "session_start", derived_from: ["posture:0123456789abcdef"] }),
    ]);
  });

  it("durably records a firing on EVERY event the bus declares, and refuses one it does not", () => {
    // The event test used to be a hand-typed array of ten names while
    // `HOOK_ALL_EVENTS` held fifteen, so `tool_write` and `turn_end` were
    // refused here — and a refused firing makes the composition site's
    // `on_fired` THROW "runtime hook evidence could not be durably recorded"
    // out of the dispatch that produced it, taking the session down. Deriving
    // the test from the catalog is the fix; this asserts the derivation cannot
    // silently fall back to being a second copy.
    const persistence_dir = mkdtempSync(join(tmpdir(), "arbor-hook-event-journal-"));
    dirs.push(persistence_dir);
    const journal = new HarnessSessionJournal({ persistence_dir });
    for (const event of HOOK_ALL_EVENTS) {
      expect(journal.recordHookFired({
        hook_id: `probe-${event}`, version: "1.0.0", kind: "observe", event,
        decision: "observed", evidence_ref: `probe ${event}`, at: "2026-08-12T00:00:00.000Z",
      })).toBe(true);
    }
    expect(journal.recordHookFired({
      hook_id: "probe-imaginary", version: "1.0.0", kind: "observe", event: "not_an_event" as HookEvent,
      decision: "observed", evidence_ref: "probe", at: "2026-08-12T00:00:00.000Z",
    })).toBe(false);
    expect(new HarnessSessionJournal({ persistence_dir }).hookInvocations()).toHaveLength(HOOK_ALL_EVENTS.length);
  });

  it("durably replays redacted session observations", () => {
    const persistence_dir = mkdtempSync(join(tmpdir(), "arbor-harness-journal-"));
    dirs.push(persistence_dir);
    const journal = new HarnessSessionJournal({ persistence_dir });
    journal.recordStarted({ session_id: "s1", campaign_id: "c1", node_id: "n1", operation: "specialize", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "heartwood", state: "running", latest_sequence: 0 });
    journal.record({
      operation: "specialize", campaign_id: "c1", node_id: "n1",
      connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "documentation-writer",
      inspection: {
        session_id: "s1", state: "completed", latest_sequence: 2, capabilities: [], lineage: { kind: "new" }, ephemeral: true,
        policy: { filesystem: "read_only", approvals: "never", tool_allow: [], tool_deny: [], workspace_roots: [persistence_dir], max_wall_clock_ms: 1_000, max_events: 10, network_allowed: false, ambient_plugins_allowed: false, user_configuration_allowed: false, inherited_credentials_allowed: false },
        terminal: { state: "completed", cause: "completed", message: "done", result: "claimed", provenance: { tag: "claimed", claimant: "worker" } },
      },
      events: [
        { protocol_version: "1", session_id: "s1", sequence: 1, occurred_at: "2026-08-09T00:00:00.000Z", kind: "model_text", payload: { text: "API_KEY=supersecretvalue", phase: "final" } },
        { protocol_version: "1", session_id: "s1", sequence: 2, occurred_at: "2026-08-09T00:00:01.000Z", kind: "terminal", payload: { state: "completed", cause: "completed", message: "done", result: "claimed", provenance: { tag: "claimed", claimant: "worker" } } },
      ],
    });
    const raw = readFileSync(join(persistence_dir, "harness-sessions.ndjson"), "utf8");
    expect(raw).not.toContain("supersecretvalue");
    const artifact = journal.artifactsFor("s1");
    expect(artifact).toEqual([expect.objectContaining({
      artifact_id: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      kind: "session_evidence_manifest", storage: "durable",
      provenance: { tag: "generated", generator: "revoy-native-session-journal", input_hash: expect.stringMatching(/^sha256:/) },
    })]);
    const artifactFile = join(persistence_dir, "harness-session-artifacts", `${artifact[0]!.artifact_id.slice("sha256:".length)}.json`);
    expect(statSync(join(persistence_dir, "harness-session-artifacts")).mode & 0o777).toBe(0o700);
    expect(statSync(artifactFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(artifactFile, "utf8")).not.toContain("supersecretvalue");
    const replayed = new HarnessSessionJournal({ persistence_dir });
    expect(replayed.inspect("s1")).toMatchObject({ state: "completed", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "heartwood" });
    expect(replayed.events("s1")).toHaveLength(2);
    expect(replayed.events("s1")[0]?.payload).toEqual({ text: "API_KEY=[REDACTED]", phase: "final" });
    expect(replayed.artifactsFor("s1")).toEqual(artifact);
    // The actual catalog path used by TUI and Web exposes only immutable
    // bounded, redacted operator text and immutable artifact metadata, never
    // raw secrets, tool content, or a resume handle.
    const inspected = new RuntimeCatalogRouter(new ArborRuntime({ harness_sessions: replayed })).executeQuery({
      schema_version: 1, query_id: "artifact-inspect", query: { kind: "harness.session.inspect", session_id: "s1" },
    });
    expect(inspected).toMatchObject({ ok: true, value: { artifacts: [expect.objectContaining({ artifact_id: artifact[0]!.artifact_id, storage: "durable" })] } });
  });

  it("does not expose a missing or tampered durable artifact on replay", () => {
    const persistence_dir = mkdtempSync(join(tmpdir(), "arbor-harness-artifact-integrity-"));
    dirs.push(persistence_dir);
    const journal = new HarnessSessionJournal({ persistence_dir });
    journal.record({
      operation: "review", campaign_id: "c", node_id: "n", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "lenticel",
      inspection: {
        session_id: "artifact-integrity", state: "completed", latest_sequence: 1, capabilities: [], lineage: { kind: "new" }, ephemeral: true,
        policy: { filesystem: "read_only", approvals: "never", tool_allow: [], tool_deny: [], workspace_roots: [], max_wall_clock_ms: 1_000, max_events: 10, network_allowed: false, ambient_plugins_allowed: false, user_configuration_allowed: false, inherited_credentials_allowed: false },
        terminal: { state: "completed", cause: "completed", message: "done", result: "claimed", provenance: { tag: "claimed", claimant: "worker" } },
      },
      events: [{ protocol_version: "1", session_id: "artifact-integrity", sequence: 1, occurred_at: "2026-08-09T00:00:00.000Z", kind: "terminal", payload: { state: "completed", cause: "completed", message: "done", result: "claimed", provenance: { tag: "claimed", claimant: "worker" } } }],
    });
    const artifact = journal.artifactsFor("artifact-integrity")[0]!;
    writeFileSync(join(persistence_dir, "harness-session-artifacts", `${artifact.artifact_id.slice("sha256:".length)}.json`), '{"forged":true}', "utf8");
    const replayed = new HarnessSessionJournal({ persistence_dir });
    expect(replayed.artifactsFor("artifact-integrity")).toEqual([]);
    expect(replayed.replayDiagnostics()).toEqual(expect.arrayContaining([expect.objectContaining({ code: "invalid_entry" })]));
  });

  it("fails closed for a content-correct artifact made group/world readable", () => {
    const persistence_dir = mkdtempSync(join(tmpdir(), "arbor-harness-artifact-permissions-"));
    dirs.push(persistence_dir);
    const journal = new HarnessSessionJournal({ persistence_dir });
    journal.record({
      operation: "review", campaign_id: "c", node_id: "n", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "lenticel",
      inspection: {
        session_id: "artifact-private", state: "completed", latest_sequence: 1, capabilities: [], lineage: { kind: "new" }, ephemeral: true,
        policy: { filesystem: "read_only", approvals: "never", tool_allow: [], tool_deny: [], workspace_roots: [], max_wall_clock_ms: 1_000, max_events: 10, network_allowed: false, ambient_plugins_allowed: false, user_configuration_allowed: false, inherited_credentials_allowed: false },
        terminal: { state: "completed", cause: "completed", message: "done", result: "claimed", provenance: { tag: "claimed", claimant: "worker" } },
      },
      events: [{ protocol_version: "1", session_id: "artifact-private", sequence: 1, occurred_at: "2026-08-09T00:00:00.000Z", kind: "terminal", payload: { state: "completed", cause: "completed", message: "done", result: "claimed", provenance: { tag: "claimed", claimant: "worker" } } }],
    });
    const artifact = journal.artifactsFor("artifact-private")[0]!;
    chmodSync(join(persistence_dir, "harness-session-artifacts", `${artifact.artifact_id.slice("sha256:".length)}.json`), 0o644);
    const replayed = new HarnessSessionJournal({ persistence_dir });
    expect(replayed.artifactsFor("artifact-private")).toEqual([]);
    expect(replayed.replayDiagnostics()).toEqual(expect.arrayContaining([expect.objectContaining({ code: "invalid_entry" })]));
  });

  it("refuses a symlinked artifact directory rather than redirecting capture", () => {
    const persistence_dir = mkdtempSync(join(tmpdir(), "arbor-harness-artifact-symlink-"));
    const redirected = mkdtempSync(join(tmpdir(), "arbor-harness-artifact-redirected-"));
    dirs.push(persistence_dir, redirected);
    symlinkSync(redirected, join(persistence_dir, "harness-session-artifacts"));
    const journal = new HarnessSessionJournal({ persistence_dir });
    expect(journal.record({
      operation: "review", campaign_id: "c", node_id: "n", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "lenticel",
      inspection: {
        session_id: "artifact-symlink", state: "completed", latest_sequence: 1, capabilities: [], lineage: { kind: "new" }, ephemeral: true,
        policy: { filesystem: "read_only", approvals: "never", tool_allow: [], tool_deny: [], workspace_roots: [], max_wall_clock_ms: 1_000, max_events: 10, network_allowed: false, ambient_plugins_allowed: false, user_configuration_allowed: false, inherited_credentials_allowed: false },
        terminal: { state: "completed", cause: "completed", message: "done", result: "claimed", provenance: { tag: "claimed", claimant: "worker" } },
      },
      events: [{ protocol_version: "1", session_id: "artifact-symlink", sequence: 1, occurred_at: "2026-08-09T00:00:00.000Z", kind: "terminal", payload: { state: "completed", cause: "completed", message: "done", result: "claimed", provenance: { tag: "claimed", claimant: "worker" } } }],
    })).toBe(false);
    expect(journal.artifactsFor("artifact-symlink")).toEqual([]);
    expect(journal.replayDiagnostics()).toEqual(expect.arrayContaining([expect.objectContaining({ code: "write_failed" })]));
  });

  it("retains the executor's composed role when completion is observed before a live-start record", () => {
    const journal = new HarnessSessionJournal();
    journal.record({
      operation: "specialize", campaign_id: "c", node_id: "n",
      connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "architect",
      inspection: {
        session_id: "late-start", state: "completed", latest_sequence: 1, capabilities: [], lineage: { kind: "new" }, ephemeral: true,
        policy: { filesystem: "read_only", approvals: "never", tool_allow: [], tool_deny: [], workspace_roots: [], max_wall_clock_ms: 1_000, max_events: 10, network_allowed: false, ambient_plugins_allowed: false, user_configuration_allowed: false, inherited_credentials_allowed: false },
        terminal: { state: "completed", cause: "completed", message: "done", result: "claimed", provenance: { tag: "claimed", claimant: "worker" } },
      },
      events: [],
    });
    expect(journal.inspect("late-start")).toMatchObject({ profile_id: "architect", connector_id: "revoy-native", execution_kind: "direct_native" });
  });

  it("projects configured and response-observed revision identity from lifecycle evidence", () => {
    const journal = new HarnessSessionJournal();
    expect(journal.recordStarted({ session_id: "revision", campaign_id: "c", node_id: "n", operation: "review", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "lenticel", state: "running", latest_sequence: 0 })).toBe(true);
    expect(journal.recordEvent({
      session_id: "revision", sequence: 1, occurred_at: "2026-08-09T00:00:00.000Z", kind: "lifecycle",
      payload: { state: "started", ephemeral: true, model_identity: { provider_id: "openrouter", model_id: "openai/gpt-5.6-luna", configured_revision: "fp_expected", revision: "fp_observed" } },
    })).toBe(true);
    expect(journal.events("revision")[0]?.payload).toMatchObject({ model_identity: { provider_id: "openrouter", model_id: "openai/gpt-5.6-luna", configured_revision: "fp_expected", revision: "fp_observed" } });
    expect(journal.inspect("revision")).toMatchObject({ model_identity: { provider_id: "openrouter", model_id: "openai/gpt-5.6-luna", configured_revision: "fp_expected", revision: "fp_observed" } });
  });

  it("migrates pre-reconciliation v1 starts into a recovery-required checkpoint", () => {
    const persistence_dir = mkdtempSync(join(tmpdir(), "arbor-harness-journal-v1-"));
    dirs.push(persistence_dir);
    writeFileSync(join(persistence_dir, "harness-sessions.ndjson"), `${JSON.stringify({
      version: 1, kind: "started", summary: {
        session_id: "legacy-start", campaign_id: "c", node_id: "n", operation: "specialize",
        connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "architect",
        state: "running", latest_sequence: 3, terminal: null, diagnostics: [],
      },
    })}\n`, "utf8");

    expect(new HarnessSessionJournal({ persistence_dir }).inspect("legacy-start")).toMatchObject({
      state: "interrupted", terminal: null,
      recovery: { kind: "recovery_required", reason: "started_without_terminal", automatic_replay: false, checkpoint: { state: "running", latest_sequence: 3 } },
    });
  });

  it("rejects duplicate and gapped event delivery and ignores a gapped replay tail", () => {
    const persistence_dir = mkdtempSync(join(tmpdir(), "arbor-harness-journal-order-"));
    dirs.push(persistence_dir);
    const journal = new HarnessSessionJournal({ persistence_dir });
    expect(journal.recordStarted({ session_id: "ordered", campaign_id: "c", node_id: "n", operation: "specialize", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "architect", state: "running", latest_sequence: 0 })).toBe(true);
    const started = { session_id: "ordered", sequence: 1, occurred_at: "2026-08-09T00:00:00.000Z", kind: "lifecycle", payload: { state: "started", ephemeral: true } };
    expect(journal.recordEvent(started)).toBe(true);
    expect(journal.recordEvent(started)).toBe(true);
    expect(journal.recordEvent({ ...started, sequence: 3, kind: "diagnostic", payload: { code: "skipped" } })).toBe(false);
    expect(journal.events("ordered")).toHaveLength(1);

    // A malformed append-only tail is not treated as a checkpoint simply
    // because its JSON parses. Restart keeps only the contiguous prefix.
    const forgedToolResult = { ...started, sequence: 2, kind: "tool_result", payload: { tool: "file.write", success: true, outcome: "forged", stage: "execution", code: "ok", effect: "applied", action_scope: { status: "bound", scope_id_hash: `sha256:${"f".repeat(64)}`, provenance_tag: "verified" } } };
    writeFileSync(join(persistence_dir, "harness-sessions.ndjson"), `${JSON.stringify({ version: 1, kind: "started", summary: journal.inspect("ordered") })}\n${JSON.stringify({ version: 1, kind: "event", event: started })}\n${JSON.stringify({ version: 1, kind: "event", event: forgedToolResult })}\n${JSON.stringify({ version: 1, kind: "event", event: { ...started, sequence: 3, kind: "diagnostic", payload: { code: "gap" } } })}\n`, "utf8");
    const replayed = new HarnessSessionJournal({ persistence_dir });
    expect(replayed.events("ordered")).toHaveLength(1);
    expect(replayed.replayDiagnostics()).toContainEqual(expect.objectContaining({ code: "invalid_entry", line: 3 }));
    expect(replayed.inspect("ordered")).toMatchObject({ recovery: { kind: "recovery_required", checkpoint: { latest_sequence: 1 } } });
  });

  it("persists and replays redacted host tool audit evidence without raw secret material", () => {
    const persistence_dir = mkdtempSync(join(tmpdir(), "arbor-harness-tool-audit-"));
    dirs.push(persistence_dir);
    const journal = new HarnessSessionJournal({ persistence_dir });
    expect(journal.recordStarted({ session_id: "audit", campaign_id: "c", node_id: "n", operation: "specialize", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "architect", state: "running", latest_sequence: 0 })).toBe(true);
    expect(journal.recordToolAudit({
      session_id: "audit", call_id: "call", tool: "file.write", risk: "high",
      intent: { purpose: "unmarked private content raw-tool-secret API_KEY=supersecretvalue", provenance_tag: "generated" },
      action_scope: { status: "bound", scope_id_hash: `sha256:${"a".repeat(64)}`, provenance_tag: "verified" },
      outcome: "succeeded", stage: "execution", code: "ok", effect: "applied", confinement: "os_confined", summary: "unmarked private output raw-tool-secret API_KEY=supersecretvalue",
    })).toBe(true);
    expect(journal.recordToolAudit({
      session_id: "audit", call_id: "call", tool: "file.write", risk: "high",
      intent: { purpose: "unmarked private content raw-tool-secret API_KEY=supersecretvalue", provenance_tag: "generated" },
      action_scope: { status: "bound", scope_id_hash: `sha256:${"a".repeat(64)}`, provenance_tag: "verified" },
      outcome: "succeeded", stage: "execution", code: "ok", effect: "applied", confinement: "os_confined", summary: "unmarked private output raw-tool-secret API_KEY=supersecretvalue",
    })).toBe(true);
    const raw = readFileSync(join(persistence_dir, "harness-sessions.ndjson"), "utf8");
    expect(raw).toContain(`sha256:${"a".repeat(64)}`);
    expect(raw).not.toContain("raw-tool-secret");
    expect(raw).not.toContain("supersecretvalue");
    const replayed = new HarnessSessionJournal({ persistence_dir });
    expect(replayed.toolAudits("audit")).toEqual([expect.objectContaining({ tool: "file.write", intent: { purpose_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/), provenance_tag: "generated" }, outcome: "succeeded", effect: "applied", summary: "redacted" })]);
  });

  it("ignores reordered/orphan records, duplicate starts, and post-finish event tails on replay", () => {
    const persistence_dir = mkdtempSync(join(tmpdir(), "arbor-harness-journal-orphan-"));
    dirs.push(persistence_dir);
    const summary = { session_id: "orphan", campaign_id: "c", node_id: "n", operation: "specialize", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "architect", state: "running", latest_sequence: 0, terminal: null, recovery: { kind: "not_required" }, diagnostics: [] };
    const event = { session_id: "orphan", sequence: 1, occurred_at: "2026-08-09T00:00:00.000Z", kind: "lifecycle", payload: { state: "started", ephemeral: true } };
    writeFileSync(join(persistence_dir, "harness-sessions.ndjson"), [
      { version: 1, kind: "event", event },
      { version: 1, kind: "started", summary },
      { version: 1, kind: "event", event },
      { version: 1, kind: "started", summary },
      { version: 1, kind: "finished", session_id: "orphan", state: "running", latest_sequence: 1, terminal: null },
      { version: 1, kind: "event", event: { ...event, sequence: 2, kind: "diagnostic", payload: { code: "after-finish" } } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
    const replayed = new HarnessSessionJournal({ persistence_dir });
    expect(replayed.events("orphan")).toEqual([expect.objectContaining({ sequence: 1 })]);
    expect(replayed.replayDiagnostics()).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "invalid_entry", line: 1 }),
      expect.objectContaining({ code: "invalid_entry", line: 4 }),
      expect.objectContaining({ code: "invalid_entry", line: 6 }),
    ]));
  });

  it("accepts composed panel session identities without relaxing bounded audit atoms", () => {
    const sessionId = `campaign-${"a".repeat(48)}:panel:lenticel:${"b".repeat(48)}:review:${"c".repeat(48)}`;
    const journal = new HarnessSessionJournal();
    expect(sessionId.length).toBeGreaterThan(128);
    expect(journal.recordStarted({ session_id: sessionId, campaign_id: "campaign", node_id: "panel:lenticel", operation: "review", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "critic-reviewer", state: "running", latest_sequence: 0 })).toBe(true);
    expect(journal.recordOperationCheckpoint({ session_id: sessionId, operation_id: `${sessionId}:provider:1:1`, operation_kind: "provider", operation: "provider", effect_kind: "provider", repeatable: false, phase: "prepared", idempotency_key_hash: null, acknowledged_by: null, outcome: null, effect: null, compensation_id: null, occurred_at: "2026-08-22T00:00:00.000Z" })).toBe(true);
    expect(journal.recordToolAudit({ session_id: sessionId, call_id: "call", tool: "file.read", risk: "low", intent: null, action_scope: { status: "not_required" }, outcome: "succeeded", stage: "execution", code: "ok", effect: "observed", confinement: "application_validated", summary: "bounded" })).toBe(true);
  });
});

describe("D6 (UCT Stage 0 pilot 4): a projection the journal cannot accept verbatim never breaks the chronology", () => {
  const refusedToolResult = (tool: unknown, sequence: number) => ({
    session_id: "d6", sequence, occurred_at: "2026-10-07T00:00:00.000Z", kind: "tool_result",
    payload: { tool, success: false, operation_id: `sha256:${"a".repeat(64)}`, evidence: { outcome: "refused", stage: "audit", code: "tool_not_composed", effect: "none", action_scope: { status: "not_required" } } },
  });

  it("persists a non-atom tool name as a typed placeholder at its own sequence, and replays it", () => {
    const persistence_dir = mkdtempSync(join(tmpdir(), "arbor-journal-d6-"));
    dirs.push(persistence_dir);
    const journal = new HarnessSessionJournal({ persistence_dir });
    expect(journal.recordStarted({ session_id: "d6", campaign_id: "c", node_id: "n", operation: "specialize", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "specialist-executor", state: "running", latest_sequence: 0 })).toBe(true);
    // The names the D6 reproduction showed refused, plus a non-string.
    const names: unknown[] = ["run shell", "bash<arg_key>cmd</arg_key>", "x".repeat(129), 42];
    names.forEach((tool, index) => expect(journal.recordEvent(refusedToolResult(tool, index + 1))).toBe(true));
    // The chronology stays contiguous: the next event lands at the next sequence.
    expect(journal.recordEvent({ session_id: "d6", sequence: names.length + 1, occurred_at: "2026-10-07T00:00:01.000Z", kind: "diagnostic", payload: { code: "after_refusal" } })).toBe(true);
    const events = journal.events("d6");
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
    for (const event of events.slice(0, 4)) {
      expect(event).toMatchObject({ kind: "tool_result", payload: { tool: expect.stringMatching(/^journal_refused\.[a-f0-9]{16}$/), success: false, outcome: "refused", code: "tool_not_composed", [HARNESS_SESSION_JOURNAL_REFUSED_FIELD]: ["tool"] } });
    }
    const raw = readFileSync(join(persistence_dir, "harness-sessions.ndjson"), "utf8");
    expect(raw).not.toContain("arg_key");
    expect(raw).not.toContain("run shell");
    expect(journal.inspect("d6")?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([...names.map(() => HARNESS_SESSION_JOURNAL_REFUSED_FIELD), "after_refusal"]);
    const replayed = new HarnessSessionJournal({ persistence_dir });
    expect(replayed.replayDiagnostics()).toEqual([]);
    expect(replayed.events("d6")).toEqual(events);
    expect(replayed.inspect("d6")?.diagnostics).toEqual(journal.inspect("d6")?.diagnostics);
  });

  it("replaces a projection it cannot repair field by field with a journal_refused_event diagnostic that carries no unvalidated claim", () => {
    const journal = new HarnessSessionJournal({});
    expect(journal.recordStarted({ session_id: "d6", campaign_id: "c", node_id: "n", operation: "specialize", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "specialist-executor", state: "running", latest_sequence: 0 })).toBe(true);
    const forged = { session_id: "d6", sequence: 1, occurred_at: "2026-10-07T00:00:00.000Z", kind: "tool_result", payload: { tool: "file.write", success: true, evidence: { outcome: "forged", stage: "execution", code: "ok", effect: "applied", action_scope: { status: "bound", scope_id_hash: `sha256:${"f".repeat(64)}`, provenance_tag: "verified" } } } };
    expect(journal.recordEvent(forged)).toBe(true);
    expect(journal.events("d6")).toEqual([{ session_id: "d6", sequence: 1, occurred_at: "2026-10-07T00:00:00.000Z", kind: "diagnostic", payload: { code: HARNESS_SESSION_JOURNAL_REFUSED_EVENT, refused_kind: "tool_result", [HARNESS_SESSION_JOURNAL_REFUSED_FIELD]: ["payload"] } }]);
    // Ordering is still enforced: only a projection is repaired, never a gap.
    expect(journal.recordEvent(refusedToolResult("shell", 3))).toBe(false);
  });

  it("keeps a malformed tool-audit atom as a valid bounded label instead of refusing the audit", () => {
    const journal = new HarnessSessionJournal({});
    expect(journal.recordStarted({ session_id: "d6", campaign_id: "c", node_id: "n", operation: "specialize", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "specialist-executor", state: "running", latest_sequence: 0 })).toBe(true);
    expect(journal.recordToolAudit({ session_id: "d6", call_id: "call", tool: "bash<arg_key>", risk: "low", intent: null, action_scope: { status: "not_required" }, outcome: "refused", stage: "audit", code: "tool not composed", effect: "none", confinement: "application_validated", summary: "bounded" })).toBe(true);
    expect(journal.toolAudits("d6")).toEqual([expect.objectContaining({ tool: expect.stringMatching(/^journal_refused\.[a-f0-9]{16}$/), code: expect.stringMatching(/^journal_refused\.[a-f0-9]{16}$/) })]);
  });
});
