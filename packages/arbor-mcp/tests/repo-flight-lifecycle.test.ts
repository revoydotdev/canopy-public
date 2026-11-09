import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { governanceAdmissionAttestationDigest, issueGovernanceAdmissionAttestation } from "@arbor/governance";
import type { RepoFlightEventInput, RepoFlightPhase } from "../src/repo-flight-contracts.js";
import { RepoFlightLifecycleStore } from "../src/repo-flight-store.js";

const temporaryDirectories: string[] = [];
const governanceKey = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function directory(): string { const value = mkdtempSync(join(tmpdir(), "repo-flight-lifecycle-")); temporaryDirectories.push(value); return value; }
function digest(character: string): `sha256:${string}` { return `sha256:${character.repeat(64)}`; }
function oid(character: string): string { return character.repeat(40); }
function created(overrides: Partial<RepoFlightEventInput> = {}): RepoFlightEventInput {
  return {
    event_id: "event:create:1",
    idempotency_key: "idem:create:1",
    occurred_at: "2026-08-28T12:00:00.000Z",
    body: {
      kind: "repo_run.created",
      payload: {
        repo_run_id: "repo-run:1",
        repository: { repository_id: `repo:v1:${"a".repeat(64)}`, git_common_dir: "/repo/.git", worktree_root: "/repo", canonical_remote: "ssh://example.invalid/repo.git" },
        base_oid: oid("b"), operation_id: "operation:1", correlation_id: "correlation:1", work_class: "decision_bound",
        input_digest: digest("1"), scope_digest: digest("2"), workspace_lineage_digest: digest("3"),
        profile_version: "profile:1", policy_version: "policy:1", proposer_identity: "agent:proposer",
      },
    },
    ...overrides,
  };
}
function transition(revision: number, from: RepoFlightPhase, to: RepoFlightPhase, suffix = `${revision + 1}`): RepoFlightEventInput {
  return {
    event_id: `event:transition:${suffix}`,
    idempotency_key: `idem:transition:${suffix}`,
    occurred_at: `2026-08-28T12:00:${String(revision + 1).padStart(2, "0")}.000Z`,
    body: { kind: "repo_run.transitioned", payload: { repo_run_id: "repo-run:1", expected_revision: revision, from, to } },
  };
}
function governanceAttempt(revision: number): RepoFlightEventInput {
  const attestation = issueGovernanceAdmissionAttestation({ schema_version: 1, canonical_payload_version: "revoy.governance-admission.v1", attestation_id: "attestation:1", repository_id: `repo:v1:${"a".repeat(64)}`, repo_run_id: "repo-run:1", work_class: "decision_bound", admission_base_oid: oid("b"), input_digest: digest("1"), scope_digest: digest("2"), workspace_lineage_digest: digest("3"), proposer_identity: "agent:proposer", issuer_identity: "governance:issuer", acceptor_identity: "human:acceptor", profile_version: "profile:1", policy_version: "policy:1", issued_at: "2026-08-28T12:00:00.000Z", expires_at: "2026-08-28T13:00:00.000Z", key_id: "governance:key", trust_root_ref: "trust:1", separation_policy_version: "separation:1", separation_policy_digest: digest("4"), revocation_epoch: 1, facts: { kind: "decision_bound", adr_id: "ADR-152", adr_content_id: "content:152", adr_status: "Accepted", acceptance_commit_oid: oid("1"), interview_receipt_digest: digest("5"), acceptance_receipt_digest: digest("6"), active_deferral: false } }, governanceKey);
  return { event_id: "event:governance:1", idempotency_key: "idem:governance:1", occurred_at: "2026-08-28T12:00:02.000Z", body: { kind: "repo_run.governance_attempted", payload: { repo_run_id: "repo-run:1", expected_revision: revision, attempt_id: "governance-attempt:1", attestation_id: "attestation:1", attestation_digest: governanceAdmissionAttestationDigest(attestation), issuer_identity: "governance:issuer", key_id: "governance:key", verified_at: "2026-08-28T12:00:02.000Z", expires_at: "2026-08-28T13:00:00.000Z", outcome: "verified", refusal_code: null, attestation } } };
}
function admit(store: RepoFlightLifecycleStore, bindings: Record<string, unknown> = {}): void {
  expect(store.append(transition(0, "planned", "awaiting_governance", "awaiting-governance")).ok).toBe(true);
  expect(store.append(governanceAttempt(1)).ok).toBe(true);
  const attempt = store.inspect("repo-run:1")!.governance_attempts.at(-1)!;
  expect(store.append({ ...transition(2, "awaiting_governance", "governance_authorized", "governance-authorized"), body: { kind: "repo_run.transitioned", payload: { repo_run_id: "repo-run:1", expected_revision: 2, from: "awaiting_governance", to: "governance_authorized", bindings: { active_governance_attempt_id: "governance-attempt:1", governance_attestation_digest: attempt.attestation_digest } } } }).ok).toBe(true);
  expect(store.append({ ...transition(3, "governance_authorized", "admitted", "admitted"), body: { kind: "repo_run.transitioned", payload: { repo_run_id: "repo-run:1", expected_revision: 3, from: "governance_authorized", to: "admitted", ...(Object.keys(bindings).length === 0 ? {} : { bindings }) } } }).ok).toBe(true);
}

describe("RepoFlightLifecycleStore", () => {
  it("reduces the production lifecycle and retains immutable authority references", () => {
    const store = new RepoFlightLifecycleStore();
    expect(store.append(created()).ok).toBe(true);
    admit(store, { session_id: "session:1" });
    expect(store.append({ ...transition(4, "admitted", "workspace_leased"), body: { kind: "repo_run.transitioned", payload: { repo_run_id: "repo-run:1", expected_revision: 4, from: "admitted", to: "workspace_leased", bindings: { worktree_id: "worktree:1", worktree_path: "/repo-worktrees/1", lease_id: "lease:1", fence_token: 7 } } } }).ok).toBe(true);
    expect(store.append(transition(5, "workspace_leased", "session_started")).ok).toBe(true);
    expect(store.append({ ...transition(6, "session_started", "candidate_ready"), body: { kind: "repo_run.transitioned", payload: { repo_run_id: "repo-run:1", expected_revision: 6, from: "session_started", to: "candidate_ready", bindings: { candidate_oid: oid("c"), tree_digest: digest("d") } } } }).ok).toBe(true);
    expect(store.append({ ...transition(7, "candidate_ready", "verifying"), body: { kind: "repo_run.transitioned", payload: { repo_run_id: "repo-run:1", expected_revision: 7, from: "candidate_ready", to: "verifying", bindings: { gate_attempt_id: "gate:1", evidence_ref: "evidence:1" } } } }).ok).toBe(true);
    expect(store.append(transition(8, "verifying", "awaiting_review")).ok).toBe(true);
    expect(store.append({ ...transition(9, "awaiting_review", "awaiting_acceptance"), body: { kind: "repo_run.transitioned", payload: { repo_run_id: "repo-run:1", expected_revision: 9, from: "awaiting_review", to: "awaiting_acceptance", bindings: { approval_ref: "approval:1" } } } }).ok).toBe(true);
    expect(store.append(transition(10, "awaiting_acceptance", "adoptable")).ok).toBe(true);
    expect(store.append({ ...transition(11, "adoptable", "adopted"), body: { kind: "repo_run.transitioned", payload: { repo_run_id: "repo-run:1", expected_revision: 11, from: "adoptable", to: "adopted", bindings: { adoption_ref: "adoption:1" } } } }).ok).toBe(true);

    const state = store.inspect("repo-run:1");
    expect(state).toMatchObject({ phase: "adopted", revision: 12, operation_id: "operation:1", correlation_id: "correlation:1", work_class: "decision_bound" });
    expect(state?.bindings).toMatchObject({ session_id: "session:1", fence_token: 7, candidate_oid: oid("c"), gate_attempt_ids: ["gate:1"], evidence_refs: ["evidence:1"], approval_refs: ["approval:1"], adoption_refs: ["adoption:1"] });
  });

  it("replays idempotently and produces the same deterministic snapshot", () => {
    const persistence_dir = directory();
    const first = new RepoFlightLifecycleStore({ persistence_dir });
    expect(first.append(created())).toMatchObject({ ok: true, replayed: false });
    const next = transition(0, "planned", "awaiting_governance");
    expect(first.append(next)).toMatchObject({ ok: true, replayed: false });
    expect(first.append(next)).toMatchObject({ ok: true, replayed: true });
    expect(first.events()).toHaveLength(2);

    const replayed = new RepoFlightLifecycleStore({ persistence_dir });
    expect(replayed.replayDiagnostics()).toEqual([]);
    expect(replayed.snapshot()).toEqual(first.snapshot());
    expect(replayed.append(next)).toMatchObject({ ok: true, replayed: true });
    expect(replayed.events()).toHaveLength(2);
    const lines = readFileSync(join(persistence_dir, "repo-flight-lifecycle.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("fails closed on a corrupt tail while preserving the valid prefix for inspection", () => {
    const persistence_dir = directory();
    const first = new RepoFlightLifecycleStore({ persistence_dir });
    expect(first.append(created()).ok).toBe(true);
    appendFileSync(join(persistence_dir, "repo-flight-lifecycle.jsonl"), "{\"version\":1", "utf8");

    const replayed = new RepoFlightLifecycleStore({ persistence_dir });
    expect(replayed.inspect("repo-run:1")?.phase).toBe("planned");
    expect(replayed.isAppendable()).toBe(false);
    expect(replayed.replayDiagnostics()).toEqual([expect.objectContaining({ code: "malformed_line", line: 2 })]);
    expect(replayed.append(transition(0, "planned", "awaiting_governance"))).toMatchObject({ ok: false, code: "corrupt_store" });
  });

  it("rejects illegal, stale, conflicting, and schema-open transitions without appending", () => {
    const store = new RepoFlightLifecycleStore();
    expect(store.append(created()).ok).toBe(true);
    expect(store.append(transition(0, "planned", "adopted"))).toMatchObject({ ok: false, code: "illegal_transition" });
    expect(store.append(transition(1, "planned", "awaiting_governance", "stale"))).toMatchObject({ ok: false, code: "revision_conflict" });
    const awaiting = transition(0, "planned", "awaiting_governance");
    expect(store.append(awaiting).ok).toBe(true);
    expect(store.append({ ...awaiting, body: { kind: "repo_run.transitioned", payload: { repo_run_id: "repo-run:1", expected_revision: 0, from: "planned", to: "failed" } } })).toMatchObject({ ok: false, code: "idempotency_conflict" });
    expect(store.append({ ...transition(1, "awaiting_governance", "failed", "open"), unexpected: true } as RepoFlightEventInput)).toMatchObject({ ok: false, code: "invalid_event" });
    expect(store.events()).toHaveLength(2);
  });

  it("does not allow a bound fence or candidate identity to be changed", () => {
    const store = new RepoFlightLifecycleStore();
    expect(store.append(created()).ok).toBe(true);
    admit(store, { fence_token: 1 });
    expect(store.append({ ...transition(4, "admitted", "workspace_leased"), body: { kind: "repo_run.transitioned", payload: { repo_run_id: "repo-run:1", expected_revision: 4, from: "admitted", to: "workspace_leased", bindings: { fence_token: 2 } } } })).toMatchObject({ ok: false, code: "invalid_event" });
    expect(store.inspect("repo-run:1")?.bindings.fence_token).toBe(1);
  });

  it("detects a second controller's durable advance instead of losing an append", () => {
    const persistence_dir = directory();
    const first = new RepoFlightLifecycleStore({ persistence_dir });
    const stale = new RepoFlightLifecycleStore({ persistence_dir });
    expect(first.append(created())).toMatchObject({ ok: true });
    expect(stale.append(created({ event_id: "event:create:stale", idempotency_key: "idem:create:stale" }))).toMatchObject({ ok: false, code: "revision_conflict" });
    const replayed = new RepoFlightLifecycleStore({ persistence_dir });
    expect(replayed.events()).toHaveLength(1);
    expect(replayed.inspect("repo-run:1")?.operation_id).toBe("operation:1");
  });

  it("fails closed without removing a lock owned by another controller", () => {
    const persistence_dir = directory();
    const lock = join(persistence_dir, "repo-flight-lifecycle.jsonl.lock");
    writeFileSync(lock, "other-controller\n", "utf8");
    const store = new RepoFlightLifecycleStore({ persistence_dir });
    expect(store.append(created())).toMatchObject({ ok: false, code: "write_failed" });
    expect(existsSync(lock)).toBe(true);
    expect(store.events()).toEqual([]);
  });
});
