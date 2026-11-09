import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WRITER_LOCK_FILENAME } from "@arbor/core";
import { afterEach, describe, expect, it } from "vitest";
import { RepoFlightAuthority, type RepoFlightCandidateBinding, type RepoFlightClearanceRequest, type RepoFlightResource } from "../src/repo-flight-authority.js";
import { RepoFlightDeliveryAdapter, type RepoFlightDeliveryState, type RepoFlightDeliveryTransitionInput, type RepoFlightSentInput } from "../src/repo-flight-delivery.js";
import { RepoFlightEnrollmentRegistry } from "../src/repo-flight-enrollment.js";
import { reconcileRepoFlightSession, createRepoFlightSessionManifest, type RepoFlightSessionManifestInput, type RepoFlightSessionRecord } from "../src/repo-flight-session.js";
import { RepoFlightLifecycleStore } from "../src/repo-flight-store.js";
import { exploreRepoFlightFaultModel } from "./models/repo-flight-fault-model.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
const candidate: RepoFlightCandidateBinding = { base_oid: "a".repeat(40), head_oid: "b".repeat(40), tree_digest: sha("c"), index_digest: sha("d") };
function temp(label: string): string { const root = mkdtempSync(join(tmpdir(), `repo-flight-fault-${label}-`)); roots.push(root); return root; }
function authority(root: string): RepoFlightAuthority { return new RepoFlightAuthority({ persistence_dir: root, repository_id: "revoy2", policy_version: "policy-v1", signing_secret: "s".repeat(64), now: () => new Date("2026-08-28T12:00:00.000Z") }); }
function clearance(requestId: string, instanceId: string, resources: readonly RepoFlightResource[]): RepoFlightClearanceRequest { return { request_id: requestId, repo_run_id: `run:${instanceId}`, instance_id: instanceId, principal_chain: ["human:operator", `agent:${instanceId}`], operations: [...new Set(resources.map((resource) => resource.kind))], resources, candidate, policy_version: "policy-v1", ttl_ms: 60_000, max_uses: 4 }; }

function sessionInput(): RepoFlightSessionManifestInput {
  const repository = temp("session"), git = join(repository, ".git"); mkdirSync(git);
  return { repository: { repository_root: repository, git_common_dir: git, worktree_root: repository, branch: "feature/fault", base_oid: "a".repeat(40), head_oid: "b".repeat(40) }, provider: "codex", provider_session_id: "provider-session", revoy_session_id: "revoy-session", repo_run_id: "repo-run-fault", pid: 777, process_start_token: "start-token-1", host_boot_id: "boot-1", campaign_id: "campaign", node_id: "node", task_id: "task", delegation: { parent_instance_id: null, delegation_id: null }, adapter_version: "1", write_intents: [], gate_intents: [], process_group: { pgid: 777, child_pids: [] } };
}
function sessionRecord(): RepoFlightSessionRecord { const manifest = createRepoFlightSessionManifest(sessionInput()); return Object.freeze({ manifest, state: "live", fenced: false, enrolled_at: "2026-08-28T12:00:00.000Z", heartbeat_at: "2026-08-28T12:00:00.000Z", control_channel: "connected", revision: 1, disposition_reason: null }); }

function sent(): RepoFlightSentInput { return { event_id: "event:sent", idempotency_key: "idem:sent", occurred_at: "2026-08-28T13:00:00.000Z", delivery_id: "delivery:ambiguous", message: { id: "message:1", conversation_id: "conversation:1", recipient_node_ids: ["node"], as_of: "2026-08-28T12:59:59.000Z" }, thread_version: "message:1", target_recipient_node_id: "node", target_instance_id: "agent:v1:target", repo_run_id: "run:delivery", operation_id: "operation:delivery", operation_attempt_id: "attempt:1" }; }
function deliveryTransition(from: RepoFlightDeliveryState, to: Exclude<RepoFlightDeliveryState, "sent">, sequence: number): RepoFlightDeliveryTransitionInput { return { event_id: `event:delivery:${sequence}`, idempotency_key: `idem:delivery:${sequence}`, occurred_at: `2026-08-28T13:00:0${sequence}.000Z`, delivery_id: "delivery:ambiguous", expected_state: from, to, actor_instance_id: "agent:v1:target" }; }

describe("repository Flight Director adversarial fault matrix", () => {
  it("keeps PID reuse ambiguous and fenced despite later heartbeat or death claims", () => {
    const enrolled = sessionRecord();
    const reused = reconcileRepoFlightSession(enrolled, { observed_at: "2026-08-28T12:00:01.000Z", pid_exists: true, process_start_token: "start-token-2", host_boot_id: "boot-1", control_channel: "connected" });
    expect(reused).toMatchObject({ state: "ambiguous", fenced: true });
    const heartbeat = reconcileRepoFlightSession(reused, { observed_at: "2026-08-28T12:00:02.000Z", pid_exists: true, process_start_token: "start-token-1", host_boot_id: "boot-1", control_channel: "connected" });
    expect(heartbeat).toMatchObject({ state: "ambiguous", fenced: true });
    const unboundDeath = reconcileRepoFlightSession(heartbeat, { observed_at: "2026-08-28T12:00:03.000Z", pid_exists: false, process_start_token: null, host_boot_id: null, control_channel: "disconnected" });
    expect(unboundDeath).toMatchObject({ state: "ambiguous", fenced: true });
  });

  it("refuses ambiguous lock takeover and preserves the foreign lock bytes", () => {
    const root = temp("lock"), lock = join(root, WRITER_LOCK_FILENAME); writeFileSync(lock, "unparseable-owner\n", "utf8");
    expect(() => authority(root)).toThrow(/could not be parsed|refusing/);
    expect(readFileSync(lock, "utf8")).toBe("unparseable-owner\n");
  });

  it("fails closed on truncated persistence and releases constructor locks for reviewed repair", () => {
    const authorityRoot = temp("authority-corrupt"), first = authority(authorityRoot); first.close();
    writeFileSync(join(authorityRoot, "repo-flight-authority.json"), "{\"schema_version\":1", "utf8");
    expect(() => authority(authorityRoot)).toThrow();

    const enrollmentRoot = temp("enrollment-corrupt"); writeFileSync(join(enrollmentRoot, "repo-flight-enrollment.json"), "{\"schema_version\":1", "utf8");
    expect(() => new RepoFlightEnrollmentRegistry({ persistence_dir: enrollmentRoot })).toThrow(/unreadable/);
    writeFileSync(join(enrollmentRoot, "repo-flight-enrollment.json"), JSON.stringify({ schema_version: 1, records: [] }), "utf8");
    const repaired = new RepoFlightEnrollmentRegistry({ persistence_dir: enrollmentRoot }); repaired.close();

    const lifecycleRoot = temp("lifecycle-corrupt"), lifecycle = new RepoFlightLifecycleStore({ persistence_dir: lifecycleRoot });
    const created = { event_id: "event:create", idempotency_key: "idem:create", occurred_at: "2026-08-28T12:00:00.000Z", body: { kind: "repo_run.created" as const, payload: { repo_run_id: "run:one", repository: { repository_id: `repo:v1:${"e".repeat(64)}` as const, git_common_dir: "/repo/.git", worktree_root: "/repo", canonical_remote: null }, base_oid: "f".repeat(40), operation_id: "operation:one", correlation_id: "correlation:one", work_class: "decision_bound" as const, input_digest: `sha256:${"1".repeat(64)}` as const, scope_digest: `sha256:${"2".repeat(64)}` as const, workspace_lineage_digest: `sha256:${"3".repeat(64)}` as const, profile_version: "profile:1", policy_version: "policy:1", proposer_identity: "agent:proposer" } } };
    expect(lifecycle.append(created).ok).toBe(true); appendFileSync(join(lifecycleRoot, "repo-flight-lifecycle.jsonl"), "{\"version\":1", "utf8");
    const replay = new RepoFlightLifecycleStore({ persistence_dir: lifecycleRoot });
    expect(replay.inspect("run:one")?.phase).toBe("planned"); expect(replay.isAppendable()).toBe(false);
  });

  it("rejects well-formed authority JSON whose idempotency graph is internally inconsistent", () => {
    const root = temp("authority-crossref"), service = authority(root);
    const granted = service.acquire(clearance("request:crossref", "worker", [{ kind: "path.write", key: "src/a.ts" }]));
    if (!granted.ok) throw new Error(granted.summary);
    service.close();
    const path = join(root, "repo-flight-authority.json");
    const state = JSON.parse(readFileSync(path, "utf8")) as { requests: Record<string, { fingerprint: string; grant_id: string }> };
    state.requests["request:crossref"]!.grant_id = "clearance:missing";
    writeFileSync(path, `${JSON.stringify(state)}\n`, "utf8");
    expect(() => authority(root)).toThrow(/internally inconsistent/);
  });

  it("rejects a prior fence after restart and advances the successor epoch", () => {
    const root = temp("fence"), resource: readonly RepoFlightResource[] = [{ kind: "git.ref", key: "refs/heads/main" }];
    const first = authority(root), old = first.acquire(clearance("request:old", "old", resource)); if (!old.ok) throw new Error(old.summary);
    expect(first.release(old.token, "holder finished")).toMatchObject({ status: "released" }); first.close();
    const restored = authority(root), successor = restored.acquire(clearance("request:new", "new", resource)); if (!successor.ok) throw new Error(successor.summary);
    expect(successor.grant.fences[0]!.fencing_epoch).toBeGreaterThan(old.grant.fences[0]!.fencing_epoch);
    expect(restored.authorizeEffect({ token: old.token, repo_run_id: "run:old", instance_id: "old", operation: "git.ref", resources: resource, candidate, effect_digest: sha("9"), policy_version: "policy-v1", approval_id: null })).toMatchObject({ ok: false, code: "unauthorized" });
    restored.close();
  });

  it("recovers an in-progress drain after controller crash without forgetting blockers", () => {
    const root = temp("drain"), first = authority(root), resources: readonly RepoFlightResource[] = [{ kind: "path.write", key: "src/a.ts" }];
    const writer = first.acquire(clearance("request:writer", "writer", resources)); if (!writer.ok) throw new Error(writer.summary);
    const drain = first.beginDrain({ request_id: "request:drain", drain_id: "drain:crash", repo_run_id: "run:controller", instance_id: "controller", candidate, ttl_ms: 60_000 }); if (!drain.ok) throw new Error(drain.summary);
    expect(first.acknowledgeDrain({ drain_id: "drain:crash", instance_id: "writer" })).toMatchObject({ ok: true }); first.close();
    const recovered = authority(root);
    expect(recovered.activateQuiescence({ drain_id: "drain:crash", token: drain.token, candidate })).toMatchObject({ ok: false, code: "not_ready", blockers: [writer.grant.grant_id] });
    expect(recovered.release(writer.token, "checkpoint recovered")).toMatchObject({ status: "released" });
    expect(recovered.activateQuiescence({ drain_id: "drain:crash", token: drain.token, candidate })).toMatchObject({ ok: true, drain: { status: "quiesced" } }); recovered.close();
  });

  it("serializes conflicting intents while preserving disjoint-path concurrency", () => {
    const service = authority(temp("intents"));
    const subtree = service.acquire(clearance("request:subtree", "agent-a", [{ kind: "path.write", key: "packages/a", path_mode: "subtree" }])); if (!subtree.ok) throw new Error(subtree.summary);
    expect(service.acquire(clearance("request:overlap", "agent-b", [{ kind: "path.write", key: "packages/a/src/index.ts" }]))).toMatchObject({ ok: false, code: "conflict", blocked_by: [subtree.grant.grant_id] });
    expect(service.acquire(clearance("request:disjoint", "agent-b", [{ kind: "path.write", key: "packages/b", path_mode: "subtree" }]))).toMatchObject({ ok: true });
    expect(service.acquire(clearance("request:git", "agent-c", [{ kind: "git.index", key: "repository" }]))).toMatchObject({ ok: true });
    expect(service.acquire(clearance("request:ref", "agent-d", [{ kind: "git.ref", key: "refs/heads/main" }]))).toMatchObject({ ok: false, code: "conflict" }); service.close();
  });

  it("preserves ambiguous delivery across restart and never equates delivery with application", () => {
    const root = temp("delivery"), first = new RepoFlightDeliveryAdapter({ persistence_dir: root });
    expect(first.recordSent(sent()).ok).toBe(true); expect(first.transition(deliveryTransition("sent", "claimed", 1)).ok).toBe(true); expect(first.transition(deliveryTransition("claimed", "delivered", 2)).ok).toBe(true);
    const recovered = new RepoFlightDeliveryAdapter({ persistence_dir: root });
    expect(recovered.inspect("delivery:ambiguous")).toMatchObject({ state: "delivered", acknowledged: false, completion: null });
    expect(recovered.transition(deliveryTransition("delivered", "applied", 3))).toMatchObject({ ok: false, code: "illegal_transition" });
    expect(recovered.transition(deliveryTransition("delivered", "expired", 4))).toMatchObject({ ok: true, projection: { state: "expired", completion: { outcome: "expired" } } });
  });

  it("exhaustively checks the finite fault model invariants", () => {
    const report = exploreRepoFlightFaultModel(10);
    expect(report.explored_states).toBeGreaterThan(100);
    expect(report.explored_transitions).toBeGreaterThan(report.explored_states);
    expect(report.violations).toEqual([]);
  });
});
