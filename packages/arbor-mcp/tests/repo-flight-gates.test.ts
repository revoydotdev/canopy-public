import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RepoFlightAuthority, type RepoFlightCandidateBinding } from "../src/repo-flight-authority.js";
import { RepoFlightGateCoordinator, type RepoFlightGatePlanRequest } from "../src/repo-flight-gates.js";

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

const sha = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
const candidate: RepoFlightCandidateBinding = { base_oid: "a".repeat(40), head_oid: "b".repeat(40), tree_digest: sha("c"), index_digest: sha("d") };

function temp(label: string): string {
  const path = mkdtempSync(join(tmpdir(), `repo-flight-${label}-`));
  roots.push(path);
  return path;
}

function request(id: string, mode: "snapshot" | "quiescent" = "snapshot"): RepoFlightGatePlanRequest {
  return {
    request_id: `request:${id}`,
    plan_id: `plan:${id}`,
    repo_run_id: "run:one",
    instance_id: "controller",
    mode,
    candidate,
    profile_digest: sha("e"),
    commands: [{ gate_id: "typecheck", argv: ["bun", "run", "tests:typecheck"], timeout_ms: 30_000, read_only: true }],
    drain_ttl_ms: 12_345,
  };
}

function setup(overrides: Partial<ConstructorParameters<typeof RepoFlightGateCoordinator>[0]> = {}) {
  const authority = new RepoFlightAuthority({ persistence_dir: temp("authority"), repository_id: "revoy2", policy_version: "policy-v1", signing_secret: "s".repeat(64) });
  const gatePath = temp("gates");
  const calls: string[] = [];
  const coordinator = new RepoFlightGateCoordinator({
    persistence_dir: gatePath,
    repository_root: "/repo",
    authority,
    candidate_probe: () => candidate,
    snapshot_factory: () => ({ root: "/snapshot", cleanup: () => calls.push("cleanup") }),
    run_command: (root, command) => { calls.push(`${root}:${command.gate_id}`); return { exit_code: 0, signal: null, duration_ms: 4, stdout: "ok", stderr: "" }; },
    ...overrides,
  });
  return { authority, coordinator, gatePath, calls };
}

describe("repo flight gate coordinator", () => {
  it("runs snapshot gates against the snapshot and stores only bounded output evidence", () => {
    const { authority, coordinator, calls } = setup();
    try {
      const admitted = coordinator.request(request("snapshot"));
      expect(admitted).toMatchObject({ ok: true, plan: { status: "ready" } });
      const result = coordinator.run("plan:snapshot");
      expect(result).toMatchObject({ ok: true, plan: { status: "terminal", outcome: "pass", candidate_verified_before: true, candidate_verified_after: true } });
      if (!result.ok) throw new Error(result.summary);
      expect(result.plan.attempts[0]).toMatchObject({ output_digest: expect.stringMatching(/^sha256:/), summary: "gate passed" });
      expect(JSON.stringify(result.plan)).not.toContain("stdout");
      expect(calls).toEqual(["/snapshot:typecheck", "cleanup"]);
    } finally { coordinator.close(); authority.close(); }
  });

  it("emits durable-shaped timing telemetry and marks unsupported host metrics unavailable", () => {
    const observations: unknown[] = [];
    const telemetry = { record: (value: unknown) => { observations.push(value); return { ok: true as const, observation: value as never, replayed: false }; } };
    const { authority, coordinator } = setup({ telemetry });
    try {
      expect(coordinator.request(request("observed"))).toMatchObject({ ok: true });
      expect(coordinator.run("plan:observed")).toMatchObject({ ok: true, plan: { outcome: "pass" } });
      expect(observations).toEqual([expect.objectContaining({
        observation_id: "gate:plan:observed",
        repo_run_id: "run:one",
        stage: "validation",
        measurements: expect.objectContaining({ wall_ms: 4, cpu_ms: "unavailable", peak_rss_bytes: "unavailable", io_read_bytes: "unavailable", io_write_bytes: "unavailable" }),
      })]);
    } finally { coordinator.close(); authority.close(); }
  });

  it("reruns an identical request under a new identity rather than reusing stale toolchain state", () => {
    const { authority, coordinator, calls } = setup();
    try {
      expect(coordinator.request(request("first")).ok).toBe(true);
      expect(coordinator.run("plan:first")).toMatchObject({ ok: true, plan: { outcome: "pass" } });
      const replay = coordinator.request(request("second"));
      expect(replay).toMatchObject({ ok: true, plan: { status: "ready", outcome: null } });
      expect(coordinator.run("plan:second")).toMatchObject({ ok: true, plan: { outcome: "pass" } });
      expect(calls.filter((value) => value.includes("typecheck"))).toHaveLength(2);
    } finally { coordinator.close(); authority.close(); }
  });

  it("drains known writers, blocks newcomers, and runs only after acknowledgement and release", () => {
    const { authority, coordinator } = setup();
    try {
      const writer = authority.acquire({ request_id: "writer", repo_run_id: "run:writer", instance_id: "writer", principal_chain: ["writer"], operations: ["path.write"], resources: [{ kind: "path.write", key: "src/a.ts" }], candidate, policy_version: "policy-v1", ttl_ms: 60_000, max_uses: 1 });
      if (!writer.ok) throw new Error(writer.summary);
      expect(coordinator.request(request("quiet", "quiescent"))).toMatchObject({ ok: true, plan: { status: "draining", blocker_ids: ["writer"] } });
      expect(authority.acquire({ request_id: "late", repo_run_id: "run:late", instance_id: "late", principal_chain: ["late"], operations: ["path.write"], resources: [{ kind: "path.write", key: "src/b.ts" }], candidate, policy_version: "policy-v1", ttl_ms: 60_000, max_uses: 1 })).toMatchObject({ ok: false, blocked_by: ["gate-drain:plan:quiet"] });
      expect(coordinator.activate("plan:quiet")).toMatchObject({ ok: false, code: "not_ready" });
      expect(coordinator.acknowledge("plan:quiet", "writer")).toMatchObject({ ok: true });
      authority.release(writer.token, "checkpointed");
      expect(coordinator.activate("plan:quiet")).toMatchObject({ ok: true, plan: { status: "ready" } });
      expect(coordinator.run("plan:quiet")).toMatchObject({ ok: true, plan: { outcome: "pass" } });
    } finally { coordinator.close(); authority.close(); }
  });

  it("fails closed when the candidate changes or snapshot construction fails", () => {
    let current = candidate;
    const first = setup({ candidate_probe: () => current });
    try {
      expect(first.coordinator.request(request("changed")).ok).toBe(true);
      current = { ...candidate, tree_digest: sha("f") };
      expect(first.coordinator.run("plan:changed")).toMatchObject({ ok: false, code: "candidate_changed", plan: { outcome: "indeterminate" } });
    } finally { first.coordinator.close(); first.authority.close(); }

    const second = setup({ snapshot_factory: () => { throw new Error("snapshot unavailable"); } });
    try {
      expect(second.coordinator.request(request("broken")).ok).toBe(true);
      expect(second.coordinator.run("plan:broken")).toMatchObject({ ok: false, code: "runner_failed", summary: "snapshot unavailable", plan: { outcome: "indeterminate" } });
    } finally { second.coordinator.close(); second.authority.close(); }
  });

  it("restores terminal plans and refuses a second controller for one durable root", () => {
    const { authority, coordinator, gatePath } = setup();
    expect(coordinator.request(request("durable")).ok).toBe(true);
    expect(() => new RepoFlightGateCoordinator({ persistence_dir: gatePath, repository_root: "/repo", authority, candidate_probe: () => candidate, snapshot_factory: () => ({ root: "/snapshot", cleanup: () => {} }), run_command: () => ({ exit_code: 0, signal: null, duration_ms: 1, stdout: "", stderr: "" }) })).toThrow(/already owned|unavailable/);
    expect(coordinator.run("plan:durable")).toMatchObject({ ok: true });
    coordinator.close();
    const restored = new RepoFlightGateCoordinator({ persistence_dir: gatePath, repository_root: "/repo", authority, candidate_probe: () => candidate, snapshot_factory: () => ({ root: "/snapshot", cleanup: () => {} }), run_command: () => ({ exit_code: 0, signal: null, duration_ms: 1, stdout: "", stderr: "" }) });
    try { expect(restored.inspect("plan:durable")).toMatchObject({ status: "terminal", outcome: "pass" }); }
    finally { restored.close(); authority.close(); }
  });
});
