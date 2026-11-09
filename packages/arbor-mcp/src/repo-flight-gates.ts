import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalizeForHash, acquireWriterLock, type WriterLockHandle } from "@arbor/core";
import { RepoFlightAuthority, type RepoFlightCandidateBinding } from "./repo-flight-authority.js";
import type { RepoFlightTelemetryStore } from "./repo-flight-telemetry.js";

export type RepoFlightGateExecutionMode = "snapshot" | "quiescent";
export type RepoFlightGateOutcome = "pass" | "fail" | "indeterminate" | "bypass";
export type RepoFlightGateStatus = "requested" | "draining" | "ready" | "running" | "terminal";

export interface RepoFlightGateCommand {
  readonly gate_id: string;
  readonly argv: readonly string[];
  readonly timeout_ms: number;
  readonly read_only: boolean;
}

export interface RepoFlightGatePlanRequest {
  readonly request_id: string;
  readonly plan_id: string;
  readonly repo_run_id: string;
  readonly instance_id: string;
  readonly mode: RepoFlightGateExecutionMode;
  readonly candidate: RepoFlightCandidateBinding;
  readonly profile_digest: `sha256:${string}`;
  readonly commands: readonly RepoFlightGateCommand[];
  readonly drain_ttl_ms?: number;
}

export interface RepoFlightGateAttempt {
  readonly gate_id: string;
  readonly started_at: string;
  readonly finished_at: string;
  readonly outcome: Exclude<RepoFlightGateOutcome, "bypass">;
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly duration_ms: number;
  readonly output_digest: `sha256:${string}`;
  readonly summary: string;
}

export interface RepoFlightGatePlan {
  readonly schema_version: 1;
  readonly plan_id: string;
  readonly request_id: string;
  readonly repo_run_id: string;
  readonly instance_id: string;
  readonly mode: RepoFlightGateExecutionMode;
  readonly candidate: RepoFlightCandidateBinding;
  readonly profile_digest: `sha256:${string}`;
  readonly commands: readonly RepoFlightGateCommand[];
  readonly status: RepoFlightGateStatus;
  readonly outcome: RepoFlightGateOutcome | null;
  readonly requested_at: string;
  readonly updated_at: string;
  readonly drain_id: string | null;
  readonly blocker_ids: readonly string[];
  readonly attempts: readonly RepoFlightGateAttempt[];
  readonly candidate_verified_before: boolean;
  readonly candidate_verified_after: boolean;
  readonly cache_key: `sha256:${string}`;
  readonly terminal_reason: string | null;
  readonly authority_ttl_ms: number;
}

export type RepoFlightGateResult =
  | { readonly ok: true; readonly plan: RepoFlightGatePlan; readonly idempotent?: boolean; readonly cached?: boolean }
  | { readonly ok: false; readonly code: "invalid" | "conflict" | "not_ready" | "candidate_changed" | "runner_failed"; readonly summary: string; readonly blockers?: readonly string[]; readonly plan?: RepoFlightGatePlan };

export interface RepoFlightGateRunnerResult { readonly exit_code: number | null; readonly signal: string | null; readonly duration_ms: number; readonly stdout: string; readonly stderr: string; readonly timed_out?: boolean }
export interface RepoFlightSnapshotHandle { readonly root: string; readonly cleanup: () => void }

export interface RepoFlightGateCoordinatorOptions {
  readonly persistence_dir: string;
  readonly repository_root: string;
  readonly authority: RepoFlightAuthority;
  readonly candidate_probe: (baseOid?: string) => RepoFlightCandidateBinding;
  readonly snapshot_factory: (candidate: RepoFlightCandidateBinding) => RepoFlightSnapshotHandle;
  readonly run_command: (root: string, command: RepoFlightGateCommand, mode: RepoFlightGateExecutionMode) => RepoFlightGateRunnerResult;
  readonly telemetry?: Pick<RepoFlightTelemetryStore, "record">;
  readonly now?: () => Date;
}

interface GateState { readonly schema_version: 1; plans: RepoFlightGatePlan[]; requests: Record<string, { fingerprint: `sha256:${string}`; plan_id: string }> }

export class RepoFlightGateCoordinator {
  private readonly path: string;
  private readonly lock: WriterLockHandle;
  private readonly now: () => Date;
  private state: GateState;
  private closed = false;

  constructor(private readonly options: RepoFlightGateCoordinatorOptions) {
    mkdirSync(options.persistence_dir, { recursive: true });
    const acquired = acquireWriterLock(options.persistence_dir, { holder: "repo-flight-gates" });
    if (!acquired.ok) throw new Error(acquired.detail);
    this.lock = acquired.lock;
    this.path = join(options.persistence_dir, "repo-flight-gates.json");
    this.now = options.now ?? (() => new Date());
    try { this.state = this.restore(); } catch (error) { this.lock.release(); throw error; }
  }

  close(): void { if (!this.closed) { this.closed = true; this.lock.release(); } }

  request(input: RepoFlightGatePlanRequest): RepoFlightGateResult {
    this.assertOpen();
    const normalized = normalizeRequest(input);
    if (!normalized.ok) return normalized;
    const request = normalized.value;
    const fingerprint = digest(request);
    const previous = this.state.requests[request.request_id];
    if (previous) {
      if (previous.fingerprint !== fingerprint) return { ok: false, code: "conflict", summary: "gate request id was reused with different content" };
      const plan = this.required(previous.plan_id);
      return { ok: true, plan: clonePlan(plan), idempotent: true };
    }
    if (this.state.plans.some((plan) => plan.plan_id === request.plan_id)) return { ok: false, code: "conflict", summary: "gate plan id is already used" };
    const now = this.now().toISOString();
    const cacheKey = digest({ candidate: request.candidate, profile_digest: request.profile_digest, commands: request.commands });
    let plan = basePlan(request, now, cacheKey);
    if (request.mode === "snapshot") {
      const clearance = this.options.authority.acquire({ request_id: `gate-clearance:${request.request_id}`, repo_run_id: request.repo_run_id, instance_id: request.instance_id, principal_chain: [request.instance_id], operations: ["gate.snapshot"], resources: [{ kind: "gate.snapshot", key: cacheKey }], candidate: request.candidate, policy_version: this.options.authority.currentPolicyVersion(), ttl_ms: request.drain_ttl_ms ?? 60_000, max_uses: 1 });
      if (!clearance.ok) return { ok: false, code: "conflict", summary: clearance.summary, blockers: clearance.blocked_by };
      plan = freezePlan({ ...plan, status: "ready" });
    } else {
      const drainId = `gate-drain:${request.plan_id}`;
      const drain = this.options.authority.beginDrain({ request_id: `gate-drain:${request.request_id}`, drain_id: drainId, repo_run_id: request.repo_run_id, instance_id: request.instance_id, candidate: request.candidate, ttl_ms: request.drain_ttl_ms ?? 60_000 });
      if (!drain.ok) return { ok: false, code: drain.code === "candidate_changed" ? "candidate_changed" : "conflict", summary: drain.summary, blockers: drain.blockers };
      plan = freezePlan({ ...plan, status: drain.drain.blocker_instance_ids.length ? "draining" : "ready", drain_id: drainId, blocker_ids: drain.drain.blocker_instance_ids });
    }
    this.saveNew(request.request_id, fingerprint, plan);
    return { ok: true, plan: clonePlan(plan) };
  }

  acknowledge(planId: string, instanceId: string): RepoFlightGateResult {
    this.assertOpen();
    const plan = this.required(planId);
    if (plan.mode !== "quiescent" || !plan.drain_id) return { ok: false, code: "invalid", summary: "plan has no quiescence drain" };
    const result = this.options.authority.acknowledgeDrain({ drain_id: plan.drain_id, instance_id: instanceId });
    if (!result.ok) return { ok: false, code: result.code === "not_ready" ? "not_ready" : "invalid", summary: result.summary, blockers: result.blockers };
    const updated = this.replace(plan.plan_id, { blocker_ids: result.drain.blocker_instance_ids.filter((id) => !result.drain.acknowledged_instance_ids.includes(id)), updated_at: this.now().toISOString() });
    return { ok: true, plan: clonePlan(updated), idempotent: result.idempotent };
  }

  activate(planId: string): RepoFlightGateResult {
    this.assertOpen();
    const plan = this.required(planId);
    if (plan.mode === "snapshot") return { ok: true, plan: clonePlan(plan), idempotent: plan.status === "ready" };
    if (!plan.drain_id) return { ok: false, code: "invalid", summary: "quiescent plan has no drain" };
    const drainRequest = this.options.authority.beginDrain({ request_id: `gate-drain:${plan.request_id}`, drain_id: plan.drain_id, repo_run_id: plan.repo_run_id, instance_id: plan.instance_id, candidate: plan.candidate, ttl_ms: plan.authority_ttl_ms });
    if (!drainRequest.ok) return { ok: false, code: "conflict", summary: drainRequest.summary, blockers: drainRequest.blockers };
    const current = this.options.candidate_probe(plan.candidate.base_oid);
    const activated = this.options.authority.activateQuiescence({ drain_id: plan.drain_id, token: drainRequest.token, candidate: current });
    if (!activated.ok) return { ok: false, code: activated.code === "candidate_changed" ? "candidate_changed" : "not_ready", summary: activated.summary, blockers: activated.blockers, plan: clonePlan(plan) };
    const updated = this.replace(plan.plan_id, { status: "ready", blocker_ids: [], candidate_verified_before: true, updated_at: this.now().toISOString() });
    return { ok: true, plan: clonePlan(updated) };
  }

  run(planId: string): RepoFlightGateResult {
    this.assertOpen();
    let plan = this.required(planId);
    if (plan.status !== "ready") return { ok: false, code: "not_ready", summary: `gate plan is ${plan.status}`, blockers: plan.blocker_ids, plan: clonePlan(plan) };
    const before = this.options.candidate_probe(plan.candidate.base_oid);
    if (!candidateEqual(before, plan.candidate)) return this.terminalFailure(plan, "candidate_changed", "repository candidate changed before gate execution", "indeterminate", false);
    plan = this.replace(plan.plan_id, { status: "running", candidate_verified_before: true, updated_at: this.now().toISOString() });
    let snapshot: RepoFlightSnapshotHandle | null = null;
    const attempts: RepoFlightGateAttempt[] = [];
    try {
      try { snapshot = plan.mode === "snapshot" ? this.options.snapshot_factory(plan.candidate) : { root: this.options.repository_root, cleanup: () => {} }; }
      catch (error) { return this.terminalFailure(plan, "runner_failed", error instanceof Error ? error.message : "snapshot creation failed", "indeterminate", false); }
      for (const command of plan.commands) {
        const started = this.now();
        let result: RepoFlightGateRunnerResult;
        try { result = this.options.run_command(snapshot.root, command, plan.mode); }
        catch (error) { result = { exit_code: null, signal: null, duration_ms: 0, stdout: "", stderr: error instanceof Error ? error.message : "gate runner threw", timed_out: false }; }
        const output = `${result.stdout}\n${result.stderr}`.slice(0, 1_000_000);
        const outcome: Exclude<RepoFlightGateOutcome, "bypass"> = result.timed_out || result.exit_code === null ? "indeterminate" : result.exit_code === 0 ? "pass" : "fail";
        attempts.push(Object.freeze({ gate_id: command.gate_id, started_at: started.toISOString(), finished_at: this.now().toISOString(), outcome, exit_code: result.exit_code, signal: result.signal, duration_ms: result.duration_ms, output_digest: digest(output), summary: outcome === "pass" ? "gate passed" : outcome === "fail" ? `gate exited ${result.exit_code}` : result.timed_out ? "gate timed out" : "gate outcome unavailable" }));
        if (outcome !== "pass") break;
      }
      const after = this.options.candidate_probe(plan.candidate.base_oid);
      const unchanged = candidateEqual(after, plan.candidate);
      const outcome: RepoFlightGateOutcome = !unchanged ? "indeterminate" : attempts.every((attempt) => attempt.outcome === "pass") ? "pass" : attempts.some((attempt) => attempt.outcome === "fail") ? "fail" : "indeterminate";
      const updated = this.replace(plan.plan_id, { status: "terminal", outcome, attempts: Object.freeze(attempts), candidate_verified_after: unchanged, terminal_reason: unchanged ? `gate plan ${outcome}` : "repository candidate changed during gate execution", updated_at: this.now().toISOString() });
      this.releaseAuthority(updated);
      this.recordTelemetry(updated);
      return { ok: true, plan: clonePlan(updated) };
    } finally { try { snapshot?.cleanup(); } catch { /* cleanup is best-effort after the durable terminal record */ } }
  }

  inspect(planId: string): RepoFlightGatePlan | null { const plan = this.state.plans.find((candidate) => candidate.plan_id === planId); return plan ? clonePlan(plan) : null; }

  private terminalFailure(plan: RepoFlightGatePlan, code: "candidate_changed" | "runner_failed", summary: string, outcome: RepoFlightGateOutcome, verifiedAfter: boolean): RepoFlightGateResult {
    const updated = this.replace(plan.plan_id, { status: "terminal", outcome, candidate_verified_after: verifiedAfter, terminal_reason: summary, updated_at: this.now().toISOString() });
    this.releaseAuthority(updated);
    this.recordTelemetry(updated);
    return { ok: false, code, summary, plan: clonePlan(updated) };
  }

  private recordTelemetry(plan: RepoFlightGatePlan): void {
    if (this.options.telemetry === undefined) return;
    const firstStarted = plan.attempts.length === 0 ? Date.parse(plan.updated_at) : Date.parse(plan.attempts[0]!.started_at);
    const queueMs = Math.max(0, firstStarted - Date.parse(plan.requested_at));
    const wallMs = plan.attempts.reduce((total, attempt) => total + attempt.duration_ms, 0);
    const result = this.options.telemetry.record({
      schema_version: 1,
      kind: "revoy2.repo_flight.stage_telemetry",
      observation_id: `gate:${plan.plan_id}`,
      repo_run_id: plan.repo_run_id,
      stage: "validation",
      resource_class: "standard",
      observed_at: plan.updated_at,
      measurements: { queue_ms: queueMs, wall_ms: wallMs, cpu_ms: "unavailable", peak_rss_bytes: "unavailable", io_read_bytes: "unavailable", io_write_bytes: "unavailable", cache_hits: 0, cache_misses: 1 },
      dependencies: { dependency_count: 0, blocked_dependency_count: 0, critical_path_ms: wallMs, critical_path_digest: digest(plan.commands.map((command) => command.gate_id)) },
    });
    if (!result.ok) throw new Error(`gate telemetry append failed: ${result.reason}`);
  }

  private releaseAuthority(plan: RepoFlightGatePlan): void {
    if (plan.mode === "snapshot") {
      const clearance = this.options.authority.acquire({ request_id: `gate-clearance:${plan.request_id}`, repo_run_id: plan.repo_run_id, instance_id: plan.instance_id, principal_chain: [plan.instance_id], operations: ["gate.snapshot"], resources: [{ kind: "gate.snapshot", key: plan.cache_key }], candidate: plan.candidate, policy_version: this.options.authority.currentPolicyVersion(), ttl_ms: plan.authority_ttl_ms, max_uses: 1 });
      if (clearance.ok) this.options.authority.release(clearance.token, `gate plan ${plan.plan_id} terminal`);
      return;
    }
    if (!plan.drain_id) return;
    const drain = this.options.authority.beginDrain({ request_id: `gate-drain:${plan.request_id}`, drain_id: plan.drain_id, repo_run_id: plan.repo_run_id, instance_id: plan.instance_id, candidate: plan.candidate, ttl_ms: plan.authority_ttl_ms });
    if (drain.ok) this.options.authority.releaseDrain(drain.token, `gate plan ${plan.plan_id} terminal`);
  }

  private saveNew(requestId: string, fingerprint: `sha256:${string}`, plan: RepoFlightGatePlan): void { this.state.plans.push(plan); this.state.requests[requestId] = { fingerprint, plan_id: plan.plan_id }; this.persist(); }
  private replace(planId: string, patch: Partial<RepoFlightGatePlan>): RepoFlightGatePlan { const index = this.state.plans.findIndex((plan) => plan.plan_id === planId); if (index < 0) throw new Error("gate plan disappeared"); const updated = freezePlan({ ...this.state.plans[index]!, ...patch }); this.state.plans[index] = updated; this.persist(); return updated; }
  private required(planId: string): RepoFlightGatePlan { const plan = this.state.plans.find((candidate) => candidate.plan_id === planId); if (!plan) throw new Error(`gate plan ${planId} was not found`); return plan; }
  private restore(): GateState { if (!existsSync(this.path)) return { schema_version: 1, plans: [], requests: {} }; const value: unknown = JSON.parse(readFileSync(this.path, "utf8")); if (!record(value) || value.schema_version !== 1 || !Array.isArray(value.plans) || !record(value.requests) || value.plans.some((plan) => !validPlan(plan))) throw new Error("repo flight gate state is malformed"); return value as GateState; }
  private persist(): void { durableWrite(this.path, `${canonicalizeForHash(this.state)}\n`); }
  private assertOpen(): void { if (this.closed) throw new Error("repo flight gate coordinator is closed"); }
}

function basePlan(request: RepoFlightGatePlanRequest, now: string, cacheKey: `sha256:${string}`): RepoFlightGatePlan {
  return freezePlan({ schema_version: 1, plan_id: request.plan_id, request_id: request.request_id, repo_run_id: request.repo_run_id, instance_id: request.instance_id, mode: request.mode, candidate: request.candidate, profile_digest: request.profile_digest, commands: request.commands, status: "requested", outcome: null, requested_at: now, updated_at: now, drain_id: null, blocker_ids: [], attempts: [], candidate_verified_before: false, candidate_verified_after: false, cache_key: cacheKey, terminal_reason: null, authority_ttl_ms: request.drain_ttl_ms ?? 60_000 });
}

function normalizeRequest(input: RepoFlightGatePlanRequest): { ok: true; value: RepoFlightGatePlanRequest } | { ok: false; code: "invalid"; summary: string } {
  if (![input.request_id, input.plan_id, input.repo_run_id, input.instance_id].every((value) => atom(value, 256)) || !["snapshot", "quiescent"].includes(input.mode) || !candidateValid(input.candidate) || !digestValue(input.profile_digest) || !Array.isArray(input.commands) || input.commands.length < 1 || input.commands.length > 256) return { ok: false, code: "invalid", summary: "gate plan request is malformed or oversized" };
  const commands: RepoFlightGateCommand[] = [];
  for (const command of input.commands) {
    if (!atom(command.gate_id, 128) || !Array.isArray(command.argv) || command.argv.length < 1 || command.argv.length > 64 || command.argv.some((arg: unknown) => typeof arg !== "string" || Buffer.byteLength(arg) > 4096 || arg.includes("\0")) || !Number.isSafeInteger(command.timeout_ms) || command.timeout_ms < 100 || command.timeout_ms > 3_600_000 || typeof command.read_only !== "boolean") return { ok: false, code: "invalid", summary: "gate command is malformed" };
    if (!command.read_only) return { ok: false, code: "invalid", summary: "gate commands must declare read-only repository behavior" };
    commands.push(Object.freeze({ ...command, argv: Object.freeze([...command.argv]) }));
  }
  if (new Set(commands.map((command) => command.gate_id)).size !== commands.length) return { ok: false, code: "invalid", summary: "gate ids must be unique within a plan" };
  return { ok: true, value: Object.freeze({ ...input, candidate: Object.freeze({ ...input.candidate }), commands: Object.freeze(commands) }) };
}

function freezePlan(plan: RepoFlightGatePlan): RepoFlightGatePlan { return Object.freeze({ ...plan, candidate: Object.freeze({ ...plan.candidate }), commands: Object.freeze(plan.commands.map((command) => Object.freeze({ ...command, argv: Object.freeze([...command.argv]) }))), blocker_ids: Object.freeze([...plan.blocker_ids]), attempts: Object.freeze(plan.attempts.map((attempt) => Object.freeze({ ...attempt }))) }); }
function clonePlan(plan: RepoFlightGatePlan): RepoFlightGatePlan { return structuredClone(plan); }
function validPlan(value: unknown): value is RepoFlightGatePlan { return record(value) && value.schema_version === 1 && atom(value.plan_id, 256) && atom(value.request_id, 256) && atom(value.repo_run_id, 256) && atom(value.instance_id, 256) && ["snapshot", "quiescent"].includes(value.mode) && candidateValid(value.candidate) && digestValue(value.profile_digest) && digestValue(value.cache_key) && Array.isArray(value.commands) && ["requested", "draining", "ready", "running", "terminal"].includes(value.status) && (value.outcome === null || ["pass", "fail", "indeterminate", "bypass"].includes(value.outcome)) && Array.isArray(value.blocker_ids) && Array.isArray(value.attempts) && Number.isSafeInteger(value.authority_ttl_ms) && value.authority_ttl_ms >= 1_000 && value.authority_ttl_ms <= 86_400_000; }
function candidateValid(value: unknown): value is RepoFlightCandidateBinding { return record(value) && gitOid(value.base_oid) && gitOid(value.head_oid) && digestValue(value.tree_digest) && (value.index_digest === undefined || value.index_digest === null || digestValue(value.index_digest)); }
function candidateEqual(left: RepoFlightCandidateBinding, right: RepoFlightCandidateBinding): boolean { return candidateValid(right) && canonicalizeForHash(left) === canonicalizeForHash(right); }
function digest(value: unknown): `sha256:${string}` { return `sha256:${createHash("sha256").update(canonicalizeForHash(value)).digest("hex")}`; }
function digestValue(value: unknown): value is `sha256:${string}` { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value); }
function gitOid(value: unknown): value is string { return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value); }
function atom(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= max && !/[\0\r\n]/u.test(value); }
function record(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function durableWrite(path: string, content: string): void { mkdirSync(dirname(path), { recursive: true }); const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`; const file = openSync(temporary, "wx", 0o600); try { writeFileSync(file, content, "utf8"); fsyncSync(file); } finally { closeSync(file); } renameSync(temporary, path); const directory = openSync(dirname(path), "r"); try { fsyncSync(directory); } finally { closeSync(directory); } }
