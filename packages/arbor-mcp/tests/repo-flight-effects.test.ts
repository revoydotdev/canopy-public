import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalService } from "../src/approval-service.js";
import { RepoFlightAuthority, type RepoFlightCandidateBinding } from "../src/repo-flight-authority.js";
import { approvalResourceId, RepoFlightEffectExecutor, type RepoFlightEffectRequest } from "../src/repo-flight-effects.js";

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const sha = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
const candidate: RepoFlightCandidateBinding = { base_oid: "a".repeat(40), head_oid: "b".repeat(40), tree_digest: sha("c"), index_digest: sha("d") };
function temp(label: string): string { const path = mkdtempSync(join(tmpdir(), `repo-flight-${label}-`)); roots.push(path); return path; }

function setup() {
  let current = candidate;
  const authority = new RepoFlightAuthority({ persistence_dir: temp("effect-authority"), repository_id: "revoy2", policy_version: "policy-v1", signing_secret: "s".repeat(64) });
  const approvals = new ApprovalService({ persistence_dir: temp("effect-approvals"), clock: () => "2026-08-28T12:00:00.000Z" });
  const effectPath = temp("effects");
  const executor = new RepoFlightEffectExecutor({ persistence_dir: effectPath, authority, approval_lookup: (id) => approvals.get(id), candidate_probe: () => current, now: () => new Date("2026-08-28T12:00:00.000Z") });
  return { authority, approvals, executor, effectPath, setCandidate: (value: RepoFlightCandidateBinding) => { current = value; } };
}

function grant(authority: RepoFlightAuthority, approvalId: string | null) {
  return authority.acquire({ request_id: `grant:${approvalId ?? "none"}`, repo_run_id: "run:one", instance_id: "worker", principal_chain: ["human:owner", "agent:worker"], operations: ["path.write"], resources: [{ kind: "path.write", key: "src", path_mode: "subtree" }], candidate, policy_version: "policy-v1", approval_id: approvalId, ttl_ms: 60_000, max_uses: 1 });
}

function request(token: string, approvalId: string | null, required = approvalId !== null): RepoFlightEffectRequest {
  return { transaction_id: "effect:one", idempotency_key: "effect-key:one", repo_run_id: "run:one", instance_id: "worker", clearance_token: token, operation: "path.write", resources: [{ kind: "path.write", key: "src/a.ts" }], candidate, effect_digest: sha("e"), policy_version: "policy-v1", approval_id: approvalId, approval_required: required };
}

function approvalTarget(authority: RepoFlightAuthority, input: RepoFlightEffectRequest): string {
  const approvalId = input.approval_id;
  if (approvalId === null) throw new Error("approval id is absent");
  const fence = authority.approvalFence({ token: input.clearance_token, repo_run_id: input.repo_run_id, instance_id: input.instance_id, candidate: input.candidate, policy_version: input.policy_version, approval_id: approvalId });
  if (!fence.ok) throw new Error(fence.summary);
  return approvalResourceId(input, fence.fence_digest);
}

function approve(approvals: ApprovalService, authority: RepoFlightAuthority, input: RepoFlightEffectRequest, proposer = "worker") {
  const approvalId = input.approval_id!;
  const target = approvalTarget(authority, input);
  const created = approvals.request({ request_id: approvalId, idempotency_key: `approval-key:${approvalId}`, action: "permission.grant", subject: "repository effect", resource_id: target, proposer, rationale: "operator-authorized write", expires_at: "2026-08-28T13:00:00.000Z", lease_scope: { operation: "permission.grant", capability: input.operation, target, reversible: true, systems_touched: ["revoy2"], policy_version: input.policy_version, actor: input.instance_id, session_id: input.repo_run_id } });
  if (!created.ok) throw new Error(created.error);
  const decided = approvals.approve({ request_id: approvalId, actor: "human:operator", clock: "2026-08-28T12:00:00.000Z" });
  if (!decided.ok) throw new Error(decided.error);
}

describe("repo flight effect closure", () => {
  it("revalidates a distinct approval and clearance immediately before one effect", () => {
    const env = setup();
    try {
      const acquired = grant(env.authority, "approval:one");
      if (!acquired.ok) throw new Error(acquired.summary);
      const input = request(acquired.token, "approval:one");
      approve(env.approvals, env.authority, input);
      let calls = 0;
      const result = env.executor.execute(input, () => { calls++; env.setCandidate({ ...candidate, tree_digest: sha("f") }); return { outcome: "applied", result_digest: sha("1") }; });
      expect(result).toMatchObject({ ok: true, idempotent: false, record: { status: "applied", approval_id: "approval:one", authorization_receipt: expect.stringMatching(/^sha256:/), post_candidate: { tree_digest: sha("f") } } });
      expect(env.executor.execute(input, () => { calls++; return { outcome: "applied", result_digest: sha("1") }; })).toMatchObject({ ok: true, idempotent: true });
      expect(calls).toBe(1);
    } finally { env.executor.close(); env.authority.close(); }
  });

  it("rejects absent, mismatched, self-approved, and stale-scope approval authority before dispatch", () => {
    const cases = ["absent", "mismatch", "self", "scope"] as const;
    for (const kind of cases) {
      const env = setup();
      try {
        const approvalId = kind === "absent" ? null : `approval:${kind}`;
        const acquired = grant(env.authority, approvalId);
        if (!acquired.ok) throw new Error(acquired.summary);
        const input = { ...request(acquired.token, approvalId, true), transaction_id: `effect:${kind}`, idempotency_key: `effect-key:${kind}` };
        if (kind === "mismatch") approve(env.approvals, env.authority, { ...input, effect_digest: sha("9") });
        if (kind === "self") {
          const target = approvalTarget(env.authority, input);
          const created = env.approvals.request({ request_id: approvalId!, idempotency_key: `approval-key:${approvalId}`, action: "permission.grant", subject: "effect", resource_id: target, proposer: "worker", rationale: "self", expires_at: "2026-08-28T13:00:00.000Z", lease_scope: { operation: "permission.grant", capability: input.operation, target, reversible: true, systems_touched: ["revoy2"], policy_version: input.policy_version, actor: input.instance_id, session_id: input.repo_run_id } });
          expect(created.ok).toBe(true);
          expect(env.approvals.approve({ request_id: approvalId!, actor: "worker", clock: "2026-08-28T12:00:00.000Z" })).toMatchObject({ ok: false, code: "permission" });
        }
        if (kind === "scope") {
          const target = approvalTarget(env.authority, input);
          const created = env.approvals.request({ request_id: approvalId!, idempotency_key: `approval-key:${approvalId}`, action: "permission.grant", subject: "effect", resource_id: target, proposer: "worker", rationale: "stale scope", expires_at: "2026-08-28T13:00:00.000Z", lease_scope: { operation: "permission.grant", capability: input.operation, target, reversible: true, systems_touched: ["revoy2"], policy_version: "policy-v0", actor: input.instance_id, session_id: input.repo_run_id } });
          if (!created.ok) throw new Error(created.error);
          const decided = env.approvals.approve({ request_id: approvalId!, actor: "human:operator", clock: "2026-08-28T12:00:00.000Z" });
          if (!decided.ok) throw new Error(decided.error);
        }
        let called = false;
        expect(env.executor.execute(input, () => { called = true; return { outcome: "applied", result_digest: sha("1") }; })).toMatchObject({ ok: false, record: { status: "rejected" } });
        expect(called).toBe(false);
      } finally { env.executor.close(); env.authority.close(); }
    }
  });

  it("fails closed when the candidate changes after clearance", () => {
    const env = setup();
    try {
      const acquired = grant(env.authority, null);
      if (!acquired.ok) throw new Error(acquired.summary);
      env.setCandidate({ ...candidate, tree_digest: sha("0") });
      let called = false;
      expect(env.executor.execute(request(acquired.token, null, false), () => { called = true; return { outcome: "applied", result_digest: sha("1") }; })).toMatchObject({ ok: false, code: "candidate_changed", record: { status: "rejected" } });
      expect(called).toBe(false);
    } finally { env.executor.close(); env.authority.close(); }
  });

  it("cannot use a clearance issued by another repository authority", () => {
    const first = new RepoFlightAuthority({ persistence_dir: temp("repository-a-authority"), repository_id: `repo:v1:${"a".repeat(64)}`, policy_version: "policy-v1", signing_secret: "a".repeat(64) });
    const second = new RepoFlightAuthority({ persistence_dir: temp("repository-b-authority"), repository_id: `repo:v1:${"b".repeat(64)}`, policy_version: "policy-v1", signing_secret: "b".repeat(64) });
    const approvals = new ApprovalService({ persistence_dir: temp("repository-b-approvals"), clock: () => "2026-08-28T12:00:00.000Z" });
    const executor = new RepoFlightEffectExecutor({ persistence_dir: temp("repository-b-effects"), authority: second, approval_lookup: (id) => approvals.get(id), candidate_probe: () => candidate, now: () => new Date("2026-08-28T12:00:00.000Z") });
    try {
      const acquired = first.acquire({ request_id: "cross-repo:grant", repo_run_id: "run:one", instance_id: "worker", principal_chain: ["worker"], operations: ["path.write"], resources: [{ kind: "path.write", key: "src", path_mode: "subtree" }], candidate, policy_version: "policy-v1", ttl_ms: 60_000, max_uses: 1 });
      if (!acquired.ok) throw new Error(acquired.summary);
      let called = false;
      expect(executor.execute(request(acquired.token, null, false), () => { called = true; return { outcome: "applied", result_digest: sha("1") }; })).toMatchObject({ ok: false, code: "unauthorized", record: { status: "rejected" } });
      expect(called).toBe(false);
    } finally { executor.close(); second.close(); first.close(); }
  });

  it("does not transfer an approval to a successor fencing epoch", () => {
    const env = setup();
    try {
      const first = grant(env.authority, "approval:fenced");
      if (!first.ok) throw new Error(first.summary);
      const firstInput = { ...request(first.token, "approval:fenced"), transaction_id: "effect:first-fence", idempotency_key: "effect-key:first-fence" };
      approve(env.approvals, env.authority, firstInput);
      env.authority.release(first.token, "successor test");
      const second = env.authority.acquire({ request_id: "grant:successor", repo_run_id: "run:one", instance_id: "worker", principal_chain: ["human:owner", "agent:worker"], operations: ["path.write"], resources: [{ kind: "path.write", key: "src", path_mode: "subtree" }], candidate, policy_version: "policy-v1", approval_id: "approval:fenced", ttl_ms: 60_000, max_uses: 1 });
      if (!second.ok) throw new Error(second.summary);
      const successor = { ...request(second.token, "approval:fenced"), transaction_id: "effect:successor-fence", idempotency_key: "effect-key:successor-fence" };
      let called = false;
      expect(env.executor.execute(successor, () => { called = true; return { outcome: "applied", result_digest: sha("7") }; })).toMatchObject({ ok: false, code: "unauthorized" });
      expect(called).toBe(false);
    } finally { env.executor.close(); env.authority.close(); }
  });

  it("holds an ambiguous dispatch until a named operator certifies applied or no-effect", () => {
    const env = setup();
    const acquired = grant(env.authority, null);
    if (!acquired.ok) throw new Error(acquired.summary);
    const input = request(acquired.token, null, false);
    try {
      expect(env.executor.execute(input, () => { throw new Error("provider connection lost"); })).toMatchObject({ ok: false, code: "ambiguous", record: { status: "ambiguous" } });
      expect(env.executor.execute(input, () => ({ outcome: "applied", result_digest: sha("2") }))).toMatchObject({ ok: false, code: "ambiguous" });
      expect(env.executor.reconcile({ transaction_id: input.transaction_id, outcome: "no_effect", result_digest: sha("3"), certified_by: "human:operator" })).toMatchObject({ ok: true, record: { status: "no_effect", reconciled_by: "human:operator" } });
    } finally { env.executor.close(); env.authority.close(); }
  });

  it("restores ambiguous terminal state without redispatch", () => {
    const env = setup();
    const acquired = grant(env.authority, null);
    if (!acquired.ok) throw new Error(acquired.summary);
    const input = request(acquired.token, null, false);
    expect(env.executor.execute(input, () => ({ outcome: "ambiguous", result_digest: sha("4") }))).toMatchObject({ ok: false, code: "ambiguous" });
    env.executor.close();
    const restored = new RepoFlightEffectExecutor({ persistence_dir: env.effectPath, authority: env.authority, approval_lookup: (id) => env.approvals.get(id), candidate_probe: () => candidate });
    let called = false;
    try {
      expect(restored.execute(input, () => { called = true; return { outcome: "applied", result_digest: sha("5") }; })).toMatchObject({ ok: false, code: "ambiguous" });
      expect(called).toBe(false);
    } finally { restored.close(); env.authority.close(); }
  });

  it("settles no-effect when authorization committed but the effect journal crashed before dispatch", () => {
    const env = setup();
    const acquired = grant(env.authority, null);
    if (!acquired.ok) throw new Error(acquired.summary);
    const input = request(acquired.token, null, false);
    const original = env.authority.authorizeEffect.bind(env.authority);
    (env.authority as unknown as { authorizeEffect: typeof env.authority.authorizeEffect }).authorizeEffect = ((authorization: Parameters<typeof original>[0]) => {
      const result = original(authorization);
      if (!result.ok) return result;
      throw new Error("simulated crash after authority commit");
    }) as typeof env.authority.authorizeEffect;
    expect(() => env.executor.execute(input, () => ({ outcome: "applied", result_digest: sha("8") }))).toThrow("simulated crash");
    env.executor.close();
    (env.authority as unknown as { authorizeEffect: typeof env.authority.authorizeEffect }).authorizeEffect = original;
    const restored = new RepoFlightEffectExecutor({ persistence_dir: env.effectPath, authority: env.authority, approval_lookup: (id) => env.approvals.get(id), candidate_probe: () => candidate });
    let called = false;
    try {
      expect(restored.execute(input, () => { called = true; return { outcome: "applied", result_digest: sha("9") }; })).toMatchObject({ ok: true, idempotent: true, record: { status: "no_effect", terminal_reason: expect.stringContaining("before durable dispatch") } });
      expect(called).toBe(false);
    } finally { restored.close(); env.authority.close(); }
  });
});
