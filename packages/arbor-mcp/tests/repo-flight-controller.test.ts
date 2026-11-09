import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { issueGovernanceAdmissionAttestation } from "@arbor/governance";
import { RepoFlightController } from "../src/repo-flight-controller.js";
import { createRepoFlightExecutionPlan, signRepoFlightExecutionPlan } from "../src/repo-flight-execution-plan.js";
import { probeRepoFlightGitCandidate } from "../src/repo-flight-git.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
const governanceKeys = generateKeyPairSync("ed25519");
const governancePrivate = governanceKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const governancePublic = governanceKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
const executionKeys = generateKeyPairSync("ed25519");
const executionPrivate = executionKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const executionPublic = executionKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
const contexts = { stop: true, precommit: true, prepush: true, trunk_submit: true, ci: true };
const executionProfile = { schema_version: 1, profile_version: "execution:1", execution: { contexts: { stop: { max_readers: 2, failure_policy: "complete_all" }, precommit: { max_readers: 2, failure_policy: "fail_fast" }, prepush: { max_readers: 2, failure_policy: "fail_fast" }, trunk_submit: { max_readers: 1, failure_policy: "fail_fast" }, ci: { max_readers: 2, failure_policy: "complete_all" } }, gate_order: [{ id: "fast", gates: ["gate:test"] }], finalization: { phases: [] }, managed_hooks: {} }, gates: { "gate:test": { command: "bun run gate:test", prerequisites: [], contexts, excluded_contexts: {}, timeout_ms: 5_000, cost_class: "fast", mutability: "read_only", required: true, scope: "self" } } };

function temp(label: string): string { const root = mkdtempSync(join(tmpdir(), `repo-flight-controller-${label}-`)); roots.push(root); return root; }
function repo(): string { const root = temp("repo"); git(root, ["init", "-q"]); git(root, ["config", "user.email", "flight@example.invalid"]); git(root, ["config", "user.name", "Flight"]); writeFileSync(join(root, "a.txt"), "one\n"); git(root, ["add", "a.txt"]); git(root, ["commit", "-qm", "initial"]); return root; }
function git(root: string, argv: string[]): void { const result = spawnSync("git", argv, { cwd: root, encoding: "utf8" }); if (result.status !== 0) throw new Error(result.stderr); }
function controller(repository = repo(), persistence = temp("state")): RepoFlightController { return new RepoFlightController({ repository_root: repository, persistence_dir: persistence, policy_version: "policy-v1", signing_secret: "s".repeat(64), required_providers: ["native"], deployment: { canonical_shared_checkout: "advisory", unmanaged_sessions_present: false, raw_shell_mutation_interceptor: false }, now: () => new Date("2026-08-28T12:00:00.000Z"), governance_trust: () => ({ trust_root_ref: "trust:1", separation_policy_version: "separation:1", separation_policy_digest: sha("9"), revocation_epoch: 1, revoked_key_ids: new Set(), public_keys: new Map([["governance:key:1", governancePublic]]) }), execution_profile: executionProfile, execution_plan_trust: new Map([["profile-adapter", executionPublic]]) }); }
function authorize(service: RepoFlightController, repoRunId: string): void {
  const run = service.lifecycle.inspect(repoRunId)!;
  const facts = run.work_class === "decision_bound"
    ? { kind: "decision_bound" as const, adr_id: "ADR-152" as const, adr_content_id: "content:152", adr_status: "Accepted" as const, acceptance_commit_oid: "1".repeat(40), interview_receipt_digest: sha("2"), acceptance_receipt_digest: sha("3"), active_deferral: false as const }
    : { kind: "exploratory" as const, adr_id: null, adr_content_id: null, adr_status: "not_applicable" as const, acceptance_commit_oid: null, interview_receipt_digest: null, acceptance_receipt_digest: null, active_deferral: "not_applicable" as const };
  const warrant = issueGovernanceAdmissionAttestation({ schema_version: 1, canonical_payload_version: "revoy.governance-admission.v1", attestation_id: `attestation:${repoRunId}`, repository_id: run.repository.repository_id, repo_run_id: run.repo_run_id, work_class: run.work_class, admission_base_oid: run.base_oid, input_digest: run.input_digest, scope_digest: run.scope_digest, workspace_lineage_digest: run.workspace_lineage_digest, proposer_identity: run.proposer_identity, issuer_identity: "governance:issuer", acceptor_identity: "human:acceptor", profile_version: run.profile_version, policy_version: run.policy_version, issued_at: "2026-08-28T11:00:00.000Z", expires_at: "2026-08-29T11:00:00.000Z", key_id: "governance:key:1", trust_root_ref: "trust:1", separation_policy_version: "separation:1", separation_policy_digest: sha("9"), revocation_epoch: 1, facts }, governancePrivate);
  expect(service.authorizeGovernance(repoRunId, warrant)).toMatchObject({ phase: "admitted" });
}

describe("repo flight production composition", () => {
  it("binds lifecycle, enrollment, clearance, and effect authorization to one repo run", () => {
    const service = controller();
    try {
      expect(service.profile).toMatchObject({ status: "observed_only", missing_controls: expect.arrayContaining([expect.objectContaining({ control: "provider.native.launch" }), expect.objectContaining({ control: "shell.raw_mutation_interceptor" })]) });
      expect(service.createRun({ repo_run_id: "run:one", operation_id: "operation:one", correlation_id: "correlation:one" })).toMatchObject({ phase: "planned" });
      const enrolled = service.enroll({ repo_run_id: "run:one", provider: "native", provider_session_id: "provider:one", revoy_session_id: "revoy:one", pid: process.pid, campaign_id: null, node_id: null, task_id: "task:one", adapter_version: "1", write_intents: [{ operation: "modify", path: "a.txt", purpose: "test effect" }], gate_intents: [] });
      const candidate = probeRepoFlightGitCandidate(service.repository.worktree_root);
      const clearanceRequest = { request_id: "clearance:one", repo_run_id: "run:one", instance_id: enrolled.manifest.instance_id, principal_chain: ["human:operator", enrolled.manifest.instance_id], operations: ["path.write" as const], resources: [{ kind: "path.write" as const, key: "a.txt" }], candidate, policy_version: "policy-v1", ttl_ms: 60_000, max_uses: 1 };
      expect(service.authority.acquire(clearanceRequest)).toMatchObject({ ok: false, summary: expect.stringContaining("planned") });
      authorize(service, "run:one");
      const clearance = service.authority.acquire(clearanceRequest);
      if (!clearance.ok) throw new Error(clearance.summary);
      const effect = service.effects.execute({ transaction_id: "effect:one", idempotency_key: "effect-key:one", repo_run_id: "run:one", instance_id: enrolled.manifest.instance_id, clearance_token: clearance.token, operation: "path.write", resources: [{ kind: "path.write", key: "a.txt" }], candidate, effect_digest: sha("e"), policy_version: "policy-v1", approval_id: null, approval_required: false }, () => { writeFileSync(join(service.repository.worktree_root, "a.txt"), "two\n"); return { outcome: "applied", result_digest: sha("f") }; });
      expect(effect).toMatchObject({ ok: true, record: { status: "applied", post_candidate: { tree_digest: expect.not.stringMatching(candidate.tree_digest) } } });
      expect(service.operator.executeQuery({ schema_version: 1, query_id: "status:one", query: { kind: "repo.flight.status" } })).toMatchObject({ ok: true, value: { repo_runs: { total: 1 }, sessions: { total: 1 }, deployment: { status: "observed_only" } } });
    } finally { service.close(); }
  });

  it("runs a real snapshot gate under the director identity and leaves the checkout unchanged", () => {
    const service = controller();
    try {
      service.createRun({ repo_run_id: "run:gate", operation_id: "operation:gate", correlation_id: "correlation:gate" });
      authorize(service, "run:gate");
      const candidate = probeRepoFlightGitCandidate(service.repository.worktree_root);
      const requested = service.gates.request({ request_id: "gate-request:one", plan_id: "gate-plan:one", repo_run_id: "run:gate", instance_id: service.director_instance_id, mode: "snapshot", candidate, profile_digest: service.profile.profile_digest, commands: [{ gate_id: "git-clean", argv: ["git", "rev-parse", "--is-inside-work-tree"], timeout_ms: 5_000, read_only: true }] });
      expect(requested).toMatchObject({ ok: true, plan: { status: "ready" } });
      expect(service.gates.run("gate-plan:one")).toMatchObject({ ok: true, plan: { outcome: "pass", candidate_verified_after: true } });
      expect(probeRepoFlightGitCandidate(service.repository.worktree_root)).toMatchObject(candidate);
    } finally { service.close(); }
  });

  it("elects one controller and releases every acquired component lock on close", () => {
    const repository = repo(), persistence = temp("state");
    const first = controller(repository, persistence);
    expect(() => controller(repository, persistence)).toThrow(/already owned|unavailable/);
    first.close();
    const reopened = controller(repository, persistence);
    reopened.close();
  });

  it("schedules only a signed profile-derived read-only wave after shadow parity", () => {
    const service = controller();
    try {
      service.createRun({ repo_run_id: "run:plan", operation_id: "operation:plan", correlation_id: "correlation:plan" });
      authorize(service, "run:plan");
      const candidate = probeRepoFlightGitCandidate(service.repository.worktree_root);
      const planInput = { schema_version: 1 as const, context: "prepush" as const, candidate: { candidate_oid: candidate.head_oid, input_digest: candidate.tree_digest }, toolchain: { runtime_id: "bun", runtime_version: "1", platform: "linux", architecture: "x64", lockfile_digest: sha("7") } };
      const signed = signRepoFlightExecutionPlan(createRepoFlightExecutionPlan({ ...planInput, profile: executionProfile }), { issuer_id: "profile-adapter", private_key_pem: executionPrivate });
      expect(service.scheduleExecutionPlan({ repo_run_id: "run:plan", instance_id: service.director_instance_id, mode: "snapshot", plan_input: planInput, signed_plan: signed })).toMatchObject({ status: "ready", profile_digest: signed.profile.profile_digest, commands: [{ gate_id: "gate:test", argv: ["bun", "run", "gate:test"] }] });
      expect(() => service.scheduleExecutionPlan({ repo_run_id: "run:plan", instance_id: service.director_instance_id, mode: "snapshot", plan_input: planInput, signed_plan: { ...signed, candidate: { ...signed.candidate, input_digest: sha("8") } } })).toThrow();
    } finally { service.close(); }
  });

  it("keeps explicitly attested exploratory runs mechanically non-mutating", () => {
    const service = controller();
    try {
      service.createRun({ repo_run_id: "run:explore", operation_id: "operation:explore", correlation_id: "correlation:explore", work_class: "exploratory" });
      authorize(service, "run:explore");
      const candidate = probeRepoFlightGitCandidate(service.repository.worktree_root);
      expect(service.authority.acquire({ request_id: "explore:write", repo_run_id: "run:explore", instance_id: service.director_instance_id, principal_chain: [service.director_instance_id], operations: ["path.write"], resources: [{ kind: "path.write", key: "a.txt" }], candidate, policy_version: "policy-v1", ttl_ms: 60_000, max_uses: 1 })).toMatchObject({ ok: false, summary: expect.stringContaining("exploratory") });
    } finally { service.close(); }
  });
});
