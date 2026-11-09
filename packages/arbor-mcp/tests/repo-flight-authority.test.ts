import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RepoFlightAuthority,
  canonicalResourceId,
  resourcesConflict,
  type RepoFlightCandidateBinding,
  type RepoFlightClearanceRequest,
  type RepoFlightResource,
} from "../src/repo-flight-authority.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const sha = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
const candidate: RepoFlightCandidateBinding = {
  base_oid: "a".repeat(40),
  head_oid: "b".repeat(40),
  tree_digest: sha("c"),
  index_digest: sha("d"),
};

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "repo-flight-authority-"));
  roots.push(value);
  return value;
}

function authority(path = root(), now: () => Date = () => new Date("2026-08-28T12:00:00.000Z")): RepoFlightAuthority {
  return new RepoFlightAuthority({ persistence_dir: path, repository_id: "revoy2", policy_version: "policy-v1", signing_secret: "s".repeat(64), now });
}

function request(id: string, instance: string, resources: readonly RepoFlightResource[], patch: Partial<RepoFlightClearanceRequest> = {}): RepoFlightClearanceRequest {
  return {
    request_id: id,
    repo_run_id: `run:${instance}`,
    instance_id: instance,
    principal_chain: ["human:operator", `agent:${instance}`],
    operations: [...new Set(resources.map((resource) => resource.kind))],
    resources,
    candidate,
    policy_version: "policy-v1",
    ttl_ms: 60_000,
    max_uses: 2,
    ...patch,
  };
}

describe("repo flight clearance authority", () => {
  it("grants disjoint paths concurrently and refuses overlapping exact/subtree claims", () => {
    const service = authority();
    try {
      const first = service.acquire(request("request-a", "instance-a", [{ kind: "path.write", key: "packages/a", path_mode: "subtree" }]));
      const disjoint = service.acquire(request("request-b", "instance-b", [{ kind: "path.write", key: "packages/b", path_mode: "subtree" }]));
      const overlap = service.acquire(request("request-c", "instance-c", [{ kind: "path.write", key: "packages/a/src/index.ts" }]));
      expect(first.ok).toBe(true);
      expect(disjoint.ok).toBe(true);
      expect(overlap).toMatchObject({ ok: false, code: "conflict", blocked_by: [(first as { grant: { grant_id: string } }).grant.grant_id] });
    } finally { service.close(); }
  });

  it("makes quiescence conflict with every mutator while snapshots remain concurrent", () => {
    const service = authority();
    try {
      const writer = service.acquire(request("writer", "writer", [{ kind: "path.write", key: "src/a.ts" }]));
      const snapshot = service.acquire(request("snapshot", "checker", [{ kind: "gate.snapshot", key: sha("e") }]));
      const quiescence = service.acquire(request("quiet", "controller", [{ kind: "gate.quiescence", key: "repository" }]));
      expect(writer.ok).toBe(true);
      expect(snapshot.ok).toBe(true);
      expect(quiescence).toMatchObject({ ok: false, code: "conflict" });
    } finally { service.close(); }
  });

  it("revalidates holder, candidate, scope, signature and use bound immediately before effect", () => {
    const service = authority();
    try {
      const granted = service.acquire(request("effect", "worker", [{ kind: "path.write", key: "src", path_mode: "subtree" }], { max_uses: 1 }));
      if (!granted.ok) throw new Error(granted.summary);
      const base = { token: granted.token, repo_run_id: "run:worker", instance_id: "worker", operation: "path.write" as const, resources: [{ kind: "path.write" as const, key: "src/a.ts" }], candidate, effect_digest: sha("f"), policy_version: "policy-v1", approval_id: null };
      expect(service.authorizeEffect({ ...base, instance_id: "intruder" })).toMatchObject({ ok: false, code: "unauthorized" });
      expect(service.authorizeEffect({ ...base, candidate: { ...candidate, tree_digest: sha("0") } })).toMatchObject({ ok: false, code: "candidate_changed" });
      expect(service.authorizeEffect({ ...base, token: `${granted.token}tampered` })).toMatchObject({ ok: false, code: "unauthorized" });
      expect(service.authorizeEffect(base)).toMatchObject({ ok: true, use_number: 1 });
      expect(service.authorizeEffect(base)).toMatchObject({ ok: false, code: "exhausted" });
    } finally { service.close(); }
  });

  it("fences a released holder before a successor acquires the same resource", () => {
    const service = authority();
    try {
      const resource = [{ kind: "git.ref" as const, key: "refs/heads/main" }];
      const first = service.acquire(request("first", "old", resource));
      if (!first.ok) throw new Error(first.summary);
      expect(service.release(first.token, "session ended")).toMatchObject({ status: "released" });
      const second = service.acquire(request("second", "new", resource));
      expect(second.ok).toBe(true);
      expect(service.authorizeEffect({ token: first.token, repo_run_id: "run:old", instance_id: "old", operation: "git.ref", resources: resource, candidate, effect_digest: sha("1"), policy_version: "policy-v1", approval_id: null })).toMatchObject({ ok: false, code: "unauthorized" });
      if (!second.ok) throw new Error(second.summary);
      expect(second.grant.fences[0]!.fencing_epoch).toBeGreaterThan(first.grant.fences[0]!.fencing_epoch);
    } finally { service.close(); }
  });

  it("expires without treating TTL as effect authority", () => {
    let clock = new Date("2026-08-28T12:00:00.000Z");
    const service = authority(root(), () => clock);
    try {
      const granted = service.acquire(request("expires", "worker", [{ kind: "path.write", key: "a.ts" }], { ttl_ms: 1_000 }));
      if (!granted.ok) throw new Error(granted.summary);
      clock = new Date("2026-08-28T12:00:01.001Z");
      expect(service.authorizeEffect({ token: granted.token, repo_run_id: "run:worker", instance_id: "worker", operation: "path.write", resources: [{ kind: "path.write", key: "a.ts" }], candidate, effect_digest: sha("2"), policy_version: "policy-v1", approval_id: null })).toMatchObject({ ok: false, code: "expired" });
    } finally { service.close(); }
  });

  it("renews only a live holder on the same candidate, policy, and fence and invalidates the prior token", () => {
    let clock = new Date("2026-08-28T12:00:00.000Z");
    const service = authority(root(), () => clock);
    try {
      const granted = service.acquire(request("renewable", "worker", [{ kind: "path.write", key: "a.ts" }], { ttl_ms: 2_000, max_uses: 1 }));
      if (!granted.ok) throw new Error(granted.summary);
      clock = new Date("2026-08-28T12:00:01.000Z");
      const renewal = service.renew({ request_id: "renewal:one", token: granted.token, repo_run_id: "run:worker", instance_id: "worker", candidate, policy_version: "policy-v1", ttl_ms: 10_000 });
      expect(renewal).toMatchObject({ ok: true, idempotent: false, grant: { grant_id: granted.grant.grant_id, expires_at: "2026-08-28T12:00:11.000Z" } });
      if (!renewal.ok) throw new Error(renewal.summary);
      expect(renewal.token).not.toBe(granted.token);
      expect(service.authorizeEffect({ token: granted.token, repo_run_id: "run:worker", instance_id: "worker", operation: "path.write", resources: [{ kind: "path.write", key: "a.ts" }], candidate, effect_digest: sha("6"), policy_version: "policy-v1", approval_id: null })).toMatchObject({ ok: false, code: "unauthorized" });
      expect(service.renew({ request_id: "renewal:one", token: granted.token, repo_run_id: "run:worker", instance_id: "worker", candidate, policy_version: "policy-v1", ttl_ms: 10_000 })).toMatchObject({ ok: true, idempotent: true, token: renewal.token });
      expect(service.renew({ request_id: "renewal:changed", token: renewal.token, repo_run_id: "run:worker", instance_id: "worker", candidate: { ...candidate, tree_digest: sha("5") }, policy_version: "policy-v1", ttl_ms: 10_000 })).toMatchObject({ ok: false, code: "conflict" });
    } finally { service.close(); }
  });

  it("persists grants and returns the same signed clearance for an idempotent request", () => {
    const path = root();
    const firstService = authority(path);
    const input = request("stable", "worker", [{ kind: "path.write", key: "a.ts" }]);
    const first = firstService.acquire(input);
    if (!first.ok) throw new Error(first.summary);
    firstService.close();
    const restored = authority(path);
    try {
      const replay = restored.acquire(input);
      expect(replay).toMatchObject({ ok: true, idempotent: true, token: first.token, grant: { grant_id: first.grant.grant_id } });
      expect(restored.acquire({ ...input, ttl_ms: 2_000 })).toMatchObject({ ok: false, code: "conflict" });
    } finally { restored.close(); }
  });

  it("rejects stale policy requests and fences active grants when policy changes", () => {
    const path = root();
    const first = authority(path);
    const stale = request("stale-request", "worker", [{ kind: "path.write", key: "a.ts" }], { policy_version: "old-policy" });
    expect(first.acquire(stale)).toMatchObject({ ok: false, code: "conflict" });
    const granted = first.acquire(request("policy-grant", "worker", [{ kind: "path.write", key: "a.ts" }]));
    if (!granted.ok) throw new Error(granted.summary);
    first.close();
    const rotated = new RepoFlightAuthority({ persistence_dir: path, repository_id: "revoy2", policy_version: "policy-v2", signing_secret: "s".repeat(64) });
    try {
      expect(rotated.currentPolicyVersion()).toBe("policy-v2");
      expect(rotated.inspect()).toContainEqual(expect.objectContaining({ grant_id: granted.grant.grant_id, status: "revoked", terminal_reason: "authority policy version changed" }));
      expect(rotated.authorizeEffect({ token: granted.token, repo_run_id: "run:worker", instance_id: "worker", operation: "path.write", resources: [{ kind: "path.write", key: "a.ts" }], candidate, effect_digest: sha("8"), policy_version: "policy-v2", approval_id: null })).toMatchObject({ ok: false, code: "unauthorized" });
    } finally { rotated.close(); }
  });

  it("drains acknowledged mutators, blocks newcomers, and activates only on the unchanged candidate", () => {
    const service = authority();
    try {
      const writer = service.acquire(request("writer-drain", "writer", [{ kind: "path.write", key: "src/a.ts" }]));
      if (!writer.ok) throw new Error(writer.summary);
      const drain = service.beginDrain({ request_id: "drain-request", drain_id: "drain:one", repo_run_id: "run:controller", instance_id: "controller", candidate, ttl_ms: 60_000 });
      if (!drain.ok) throw new Error(drain.summary);
      expect(drain.drain.blocker_instance_ids).toEqual(["writer"]);
      expect(service.acquire(request("late-writer", "late", [{ kind: "path.write", key: "src/b.ts" }]))).toMatchObject({ ok: false, code: "conflict", blocked_by: ["drain:one"] });
      expect(service.activateQuiescence({ drain_id: "drain:one", token: drain.token, candidate })).toMatchObject({ ok: false, code: "not_ready" });
      expect(service.acknowledgeDrain({ drain_id: "drain:one", instance_id: "writer" })).toMatchObject({ ok: true });
      service.release(writer.token, "drain acknowledged and checkpointed");
      expect(service.activateQuiescence({ drain_id: "drain:one", token: drain.token, candidate: { ...candidate, tree_digest: sha("9") } })).toMatchObject({ ok: false, code: "candidate_changed" });
      const active = service.activateQuiescence({ drain_id: "drain:one", token: drain.token, candidate });
      expect(active).toMatchObject({ ok: true, drain: { status: "quiesced" } });
      if (!active.ok) throw new Error(active.summary);
      expect(service.releaseDrain(active.token)).toMatchObject({ status: "released" });
      expect(service.acquire(request("after-drain", "next", [{ kind: "path.write", key: "src/b.ts" }]))).toMatchObject({ ok: true });
    } finally { service.close(); }
  });

  it("allows a no-blocker drain to become quiescent without fabricated acknowledgements", () => {
    const service = authority();
    try {
      const drain = service.beginDrain({ request_id: "empty-request", drain_id: "drain:empty", repo_run_id: "run:controller", instance_id: "controller", candidate, ttl_ms: 60_000 });
      if (!drain.ok) throw new Error(drain.summary);
      expect(service.activateQuiescence({ drain_id: drain.drain.drain_id, token: drain.token, candidate })).toMatchObject({ ok: true, drain: { blocker_grant_ids: [], acknowledged_instance_ids: [], status: "quiesced" } });
    } finally { service.close(); }
  });

  it("rejects a second authority process for the same durable root", () => {
    const path = root();
    const first = authority(path);
    try { expect(() => authority(path)).toThrow(/already owned|unavailable/); }
    finally { first.close(); }
  });

  it("consults enrolled holder identity both at grant and immediately before effect", () => {
    let admitted = false;
    const service = new RepoFlightAuthority({ persistence_dir: root(), repository_id: "revoy2", policy_version: "policy-v1", signing_secret: "s".repeat(64), holder_admission: () => ({ ok: admitted, summary: "session is fenced", ...(admitted ? { governance_attestation_digest: sha("8") } : {}) }) });
    try {
      const input = request("identity-bound", "worker", [{ kind: "path.write", key: "a.ts" }], { max_uses: 1 });
      expect(service.acquire(input)).toMatchObject({ ok: false, code: "conflict", summary: "session is fenced" });
      admitted = true;
      const granted = service.acquire(input);
      if (!granted.ok) throw new Error(granted.summary);
      admitted = false;
      expect(service.authorizeEffect({ token: granted.token, repo_run_id: "run:worker", instance_id: "worker", operation: "path.write", resources: [{ kind: "path.write", key: "a.ts" }], candidate, effect_digest: sha("7"), policy_version: "policy-v1", approval_id: null })).toMatchObject({ ok: false, code: "unauthorized", summary: "session is fenced" });
    } finally { service.close(); }
  });
});

describe("repo flight resource compatibility", () => {
  it("uses canonical path boundaries and stable resource identities", () => {
    expect(resourcesConflict({ kind: "path.write", key: "a", path_mode: "subtree" }, { kind: "path.write", key: "ab/file" })).toBe(false);
    expect(resourcesConflict({ kind: "path.write", key: "a", path_mode: "subtree" }, { kind: "path.write", key: "a/file" })).toBe(true);
    expect(resourcesConflict({ kind: "gate.snapshot", key: "candidate" }, { kind: "git.head", key: "HEAD" })).toBe(false);
    expect(resourcesConflict({ kind: "git.stash", key: "global" }, { kind: "path.write", key: "a.ts" })).toBe(true);
    expect(canonicalResourceId("revoy2", { kind: "path.write", key: "src/a.ts" })).toBe("repo-flight:v1:revoy2:path.write:exact:src%2Fa.ts");
    expect(() => canonicalResourceId("revoy2", { kind: "path.write", key: "../escape" })).toThrow();
  });
});
