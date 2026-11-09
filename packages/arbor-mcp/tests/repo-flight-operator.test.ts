import { describe, expect, it, vi } from "vitest";
import { RepoFlightOperatorService, isRepoFlightOperatorCommandEnvelope, isRepoFlightOperatorQueryEnvelope, type RepoFlightOperatorOptions } from "../src/repo-flight-operator.js";
import { evaluateRepoFlightProfile } from "../src/repo-flight-profile.js";
import { RUNTIME_CATALOG, RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { ArborRuntime } from "../src/runtime.js";

const profile = evaluateRepoFlightProfile({
  schema_version: 1, repository_id: `repo:v1:${"a".repeat(64)}`, required_providers: ["codex"],
  providers: {
    claude: { launch_interceptor: true, identity_enrollment: true, mutation_interceptor: true },
    codex: { launch_interceptor: true, identity_enrollment: true, mutation_interceptor: true },
    opencode: { launch_interceptor: true, identity_enrollment: true, mutation_interceptor: true },
    native: { launch_interceptor: true, identity_enrollment: true, mutation_interceptor: true },
  },
  controls: { stores: { authority: true, enrollment: true, lifecycle: true }, canonical_shared_checkout: "mechanical_read_only", unmanaged_sessions_present: false, raw_shell_mutation_interceptor: true, gate_broker: true, effect_interceptor: true, approval_closure: true, a2a_receipt_adapter: true, adoption_fencing: true },
});

const session = {
  instance_id: `agent:v1:${"b".repeat(64)}`, repository_id: "repo:v1:test", worktree: "/repo/worktree", provider: "codex", provider_session_ref: `sha256:${"c".repeat(64)}`,
  revoy_session_id: "revoy:1", repo_run_id: "repo-run:1", pid: 42, process_identity_ref: `sha256:${"d".repeat(64)}`, campaign_id: null, node_id: null, task_id: "task:1",
  state: "live", fenced: false, heartbeat_at: "2026-08-28T13:00:00.000Z", control_channel: "connected", write_intents: [], gate_intents: [], disposition_reason: null,
} as const;

const candidate = { base_oid: "a".repeat(40), head_oid: "b".repeat(40), tree_digest: `sha256:${"c".repeat(64)}` as const };
const grant = {
  schema_version: 1, grant_id: "grant:1", request_id: "clearance-request:1", request_fingerprint: `sha256:${"d".repeat(64)}`, repository_id: "repo:1", repo_run_id: "repo-run:1", instance_id: session.instance_id,
  principal_chain: [session.instance_id], operations: ["git.ref"], resources: [{ kind: "git.ref", key: "refs/heads/main" }], candidate, policy_version: "policy:1", approval_id: null,
  issued_at: "2026-08-28T13:00:00.000Z", expires_at: "2026-08-28T14:00:00.000Z", max_uses: 1, uses: 0, status: "active", terminal_reason: null,
  fences: [{ resource_id: "resource:1", fencing_epoch: 1, resource_version: 1 }], sequence: 1,
} as const;
const drain = {
  schema_version: 1, drain_id: "drain:1", request_id: "drain-request:1", repo_run_id: "repo-run:1", instance_id: session.instance_id, repository_id: "repo:1", candidate,
  requested_at: "2026-08-28T13:00:00.000Z", expires_at: "2026-08-28T14:00:00.000Z", status: "draining", blocker_grant_ids: [], blocker_instance_ids: [], acknowledged_instance_ids: [], fencing_epoch: 1, resource_version: 1, terminal_reason: null,
} as const;
const gate = {
  schema_version: 1, plan_id: "gate-plan:1", request_id: "gate-request:1", repo_run_id: "repo-run:1", instance_id: session.instance_id, mode: "snapshot", candidate,
  profile_digest: profile.profile_digest, commands: [{ gate_id: "tests", argv: ["sh", "-c", "token=must-not-project"], timeout_ms: 1000, read_only: true }], status: "ready", outcome: null,
  requested_at: "2026-08-28T13:00:00.000Z", updated_at: "2026-08-28T13:00:00.000Z", drain_id: null, blocker_ids: [], attempts: [], candidate_verified_before: false,
  candidate_verified_after: false, cache_key: `sha256:${"e".repeat(64)}`, terminal_reason: null, authority_ttl_ms: 60000,
} as const;

function options(): RepoFlightOperatorOptions {
  const authority = {
    acquire: vi.fn(() => ({ ok: true as const, token: "signed-token=must-not-project", grant, idempotent: false })),
    renew: vi.fn(() => ({ ok: true as const, token: "renewed-token=must-not-project", grant, idempotent: false })),
    beginDrain: vi.fn(() => ({ ok: true as const, token: "drain-token=must-not-project", drain, idempotent: false })),
    acknowledgeDrain: vi.fn(() => ({ ok: true as const, token: "hidden", drain, idempotent: false })),
    activateQuiescence: vi.fn(() => ({ ok: true as const, token: "hidden", drain: { ...drain, status: "quiesced" as const }, idempotent: false })),
    releaseDrain: vi.fn(() => ({ ...drain, status: "released" as const })), revoke: vi.fn(() => ({ ...grant, status: "revoked" as const })),
    inspect: vi.fn(() => [grant]), inspectDrains: vi.fn(() => [drain]),
  };
  const run = { repo_run_id: "repo-run:1", phase: "verifying" as const, revision: 3 };
  return {
    lifecycle: { snapshot: () => ({ version: 1, sequence: 1, head_hash: null, snapshot_hash: `sha256:${"f".repeat(64)}`, runs: [run] }) } as never,
    enrollment: { projections: () => [session], transition: vi.fn(() => ({ ...session, state: "draining" })) } as never,
    authority: authority as never,
    gates: { request: vi.fn(() => ({ ok: true, plan: gate })), acknowledge: vi.fn(() => ({ ok: true, plan: gate })), activate: vi.fn(() => ({ ok: true, plan: gate })), run: vi.fn(() => ({ ok: true, plan: gate })), inspect: vi.fn(() => gate) } as never,
    deliveries: { list: vi.fn(() => [{ delivery_id: "delivery:1", repo_run_id: "repo-run:1", state: "acknowledged" }]), recordSent: vi.fn(() => ({ ok: true, projection: { delivery_id: "delivery:1", state: "sent" } })), transition: vi.fn(() => ({ ok: true, projection: { delivery_id: "delivery:1", state: "claimed" } })) } as never,
    effects: { inspect: vi.fn(() => [{ transaction_id: "effect:1", repo_run_id: "repo-run:1", status: "ambiguous" }]), reconcile: vi.fn((input) => ({ ok: true, record: { transaction_id: input.transaction_id, status: input.outcome, reconciled_by: input.certified_by }, idempotent: false })) } as never,
    run_control: { create: vi.fn((input) => ({ ...run, repo_run_id: input.repo_run_id, phase: "planned", revision: 0 })), transition: vi.fn((repoRunId, to) => ({ ...run, repo_run_id: repoRunId, phase: to, revision: 4 })) } as never,
    profile, now: () => new Date("2026-08-28T13:30:00.000Z"),
  };
}

const metadata = { operation_id: "operator:1", idempotency_key: "operator-idem:1", correlation_id: "operator-correlation:1", actor_id: session.instance_id, requested_at: "2026-08-28T13:30:00.000Z" };

describe("RepoFlightOperatorService", () => {
  it("projects bounded aggregate status without credentials", () => {
    const result = new RepoFlightOperatorService(options()).executeQuery({ schema_version: 1, query_id: "status:1", query: { kind: "repo.flight.status" } });
    expect(result).toMatchObject({ ok: true, value: { deployment: { status: "enforced" }, repo_runs: { total: 1, by_phase: { verifying: 1 } }, sessions: { total: 1, by_state: { live: 1 } }, clearances: { active: 1 }, drains: { active: 1 }, deliveries: { by_state: { acknowledged: 1 } } } });
    expect(JSON.stringify(result)).not.toContain("token");
  });

  it("projects gates without argv or raw command payloads", () => {
    const result = new RepoFlightOperatorService(options()).executeQuery({ schema_version: 1, query_id: "gate:1", query: { kind: "repo.flight.gate", plan_id: "gate-plan:1" } });
    expect(result).toMatchObject({ ok: true, value: { commands: [{ gate_id: "tests", timeout_ms: 1000, read_only: true }] } });
    expect(JSON.stringify(result)).not.toContain("must-not-project");
    expect(JSON.stringify(result)).not.toContain("argv");
  });

  it("returns clearance projections but never the authority bearer token", () => {
    const result = new RepoFlightOperatorService(options()).executeCommand({ schema_version: 1, metadata, command: { kind: "repo.flight.clearance.request", request: { request_id: "clearance-request:1" } } });
    expect(result).toMatchObject({ ok: true, value: { accepted: true, operation_id: "operator:1", projection: { grant_id: "grant:1" } } });
    expect(JSON.stringify(result)).not.toContain("signed-token");
  });

  it("keeps drain credentials internal across request and activation", () => {
    const configured = options();
    const service = new RepoFlightOperatorService(configured);
    expect(service.executeCommand({ schema_version: 1, metadata, command: { kind: "repo.flight.drain.request", request: { request_id: "drain-request:1" } } })).toMatchObject({ ok: true, value: { accepted: true } });
    const activated = service.executeCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "operator:2" }, command: { kind: "repo.flight.drain.activate", drain_id: "drain:1", candidate } });
    expect(activated).toMatchObject({ ok: true, value: { accepted: true, projection: { status: "quiesced" } } });
    expect(configured.authority.activateQuiescence).toHaveBeenCalledWith(expect.objectContaining({ token: "drain-token=must-not-project" }));
    expect(JSON.stringify(activated)).not.toContain("drain-token");
  });

  it("projects run/effect state and binds ambiguity reconciliation to the authenticated actor metadata", () => {
    const configured = options(), service = new RepoFlightOperatorService(configured);
    expect(service.executeQuery({ schema_version: 1, query_id: "effects:1", query: { kind: "repo.flight.effects", status: "ambiguous" } })).toMatchObject({ ok: true, value: [{ transaction_id: "effect:1" }] });
    expect(service.executeQuery({ schema_version: 1, query_id: "runs:1", query: { kind: "repo.flight.runs", phase: "verifying" } })).toMatchObject({ ok: true, value: [{ repo_run_id: "repo-run:1" }] });
    const reconciled = service.executeCommand({ schema_version: 1, metadata, command: { kind: "repo.flight.effect.reconcile", transaction_id: "effect:1", outcome: "no_effect", result_digest: `sha256:${"a".repeat(64)}` } });
    expect(reconciled).toMatchObject({ ok: true, value: { accepted: true, projection: { reconciled_by: session.instance_id } } });
    expect(configured.effects!.reconcile).toHaveBeenCalledWith(expect.objectContaining({ certified_by: session.instance_id }));
  });

  it("creates and compare-before-transitions repository runs through explicit envelopes", () => {
    const configured = options(), service = new RepoFlightOperatorService(configured);
    expect(service.executeCommand({ schema_version: 1, metadata, command: { kind: "repo.flight.run.create", repo_run_id: "repo-run:2" } })).toMatchObject({ ok: true, value: { accepted: true, projection: { repo_run_id: "repo-run:2", phase: "planned" } } });
    expect(service.executeCommand({ schema_version: 1, metadata, command: { kind: "repo.flight.run.transition", repo_run_id: "repo-run:1", to: "awaiting_review", expected_revision: 2 } })).toMatchObject({ ok: true, value: { accepted: false, error: { summary: expect.stringContaining("found 3") } } });
    expect(service.executeCommand({ schema_version: 1, metadata, command: { kind: "repo.flight.run.transition", repo_run_id: "repo-run:1", to: "awaiting_review", expected_revision: 3 } })).toMatchObject({ ok: true, value: { accepted: true, projection: { phase: "awaiting_review" } } });
  });

  it("rejects open envelopes and invalid bounds", () => {
    expect(isRepoFlightOperatorQueryEnvelope({ schema_version: 1, query_id: "q", query: { kind: "repo.flight.sessions", limit: 1001 } })).toBe(false);
    expect(isRepoFlightOperatorCommandEnvelope({ schema_version: 1, metadata, command: { kind: "repo.flight.gate.run", plan_id: "gate-plan:1", signing_secret: "no" } })).toBe(false);
    expect(new RepoFlightOperatorService(options()).executeQuery({ schema_version: 1, query_id: "q", query: { kind: "repo.flight.sessions", limit: 1001 } })).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("catalogs every operator kind with read/write separation", () => {
    const catalog = RUNTIME_CATALOG.filter((entry) => entry.kind.startsWith("repo.flight."));
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.every((entry) => !entry.supported)).toBe(true);
    expect(catalog.every((entry) => entry.direction === "query" || entry.direction === "command")).toBe(true);
  });

  it("keeps the generic catalog unsupported while the authenticated operator service remains callable", async () => {
    const query = { schema_version: 1 as const, query_id: "status:runtime", query: { kind: "repo.flight.status" as const } };
    const command = { schema_version: 1 as const, metadata, command: { kind: "repo.flight.clearance.request" as const, request: { request_id: "clearance-request:1" } as never } };
    const absent = new RuntimeCatalogRouter(new ArborRuntime());
    expect(absent.executeQuery(query)).toMatchObject({ ok: false, capability: "repo.flight.read", error: { code: "unavailable" } });
    expect(await absent.dispatchCommand(command)).toMatchObject({ ok: false, capability: "repo.flight.write", error: { code: "unavailable" } });

    const operator = new RepoFlightOperatorService(options());
    const composed = new RuntimeCatalogRouter(new ArborRuntime());
    expect(composed.executeQuery(query)).toMatchObject({ ok: false, capability: "repo.flight.read", error: { code: "unavailable" } });
    expect(await composed.dispatchCommand(command)).toMatchObject({ ok: false, capability: "repo.flight.write", error: { code: "unavailable" } });
    expect(operator.executeQuery(query)).toMatchObject({ ok: true, capability: "repo.flight.read", value: { deployment: { status: "enforced" } } });
    expect(operator.executeCommand(command)).toMatchObject({ ok: true, capability: "repo.flight.write", value: { accepted: true, projection: { grant_id: "grant:1" } } });
  });

  it("refuses the unsupported generic route before invoking an operator", async () => {
    const operator = new RepoFlightOperatorService(options());
    const querySpy = vi.spyOn(operator, "executeQuery");
    const commandSpy = vi.spyOn(operator, "executeCommand");
    const query = { schema_version: 1 as const, query_id: "status:denied", query: { kind: "repo.flight.status" as const } };
    const command = { schema_version: 1 as const, metadata, command: { kind: "repo.flight.clearance.request" as const, request: { request_id: "clearance-request:1" } as never } };
    const denied = new RuntimeCatalogRouter(new ArborRuntime(), { granted_capabilities: new Set() });
    expect(denied.executeQuery(query)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await denied.dispatchCommand(command)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(querySpy).not.toHaveBeenCalled(); expect(commandSpy).not.toHaveBeenCalled();

    const localProofRequired = new RuntimeCatalogRouter(new ArborRuntime(), { require_local_session: true });
    expect(await localProofRequired.dispatchCommand(command)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(commandSpy).not.toHaveBeenCalled();
  });

  it("does not let generic catalog composition manufacture Flight transport identity", async () => {
    const command = { schema_version: 1 as const, metadata: { ...metadata, actor_id: "spoofed-agent" }, command: { kind: "repo.flight.effect.reconcile" as const, transaction_id: "effect:1", outcome: "no_effect" as const, result_digest: `sha256:${"a".repeat(64)}` as const } };
    expect(await new RuntimeCatalogRouter(new ArborRuntime()).dispatchCommand(command)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const trusted = new RuntimeCatalogRouter(new ArborRuntime());
    expect(await trusted.dispatchCommand(command)).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
});
