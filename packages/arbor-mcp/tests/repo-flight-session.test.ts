import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RepoFlightEnrollmentRegistry } from "../src/repo-flight-enrollment.js";
import { createRepoFlightSessionManifest, normalizeRepoFlightProvider, projectRepoFlightSession, reconcileRepoFlightSession, validateRepoFlightSessionManifest, type RepoFlightSessionManifestInput, type RepoFlightSessionRecord } from "../src/repo-flight-session.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(overrides: Partial<RepoFlightSessionManifestInput> = {}): RepoFlightSessionManifestInput {
  const root = mkdtempSync(join(tmpdir(), "repo-flight-session-")); roots.push(root);
  const git = join(root, ".git"); mkdirSync(git);
  return {
    repository: { repository_root: root, git_common_dir: git, worktree_root: root, branch: "feature/flight", base_oid: "a".repeat(40), head_oid: "b".repeat(40) },
    provider: "codex-cli", provider_session_id: "provider-session-1", revoy_session_id: "revoy-session-1", repo_run_id: "repo-run-1", pid: 4242, process_start_token: "linux-start-ticks-100", host_boot_id: "boot-2026-08-28", campaign_id: "campaign-1", node_id: "node-1", task_id: "task-1", adapter_version: "1.2.3",
    delegation: { parent_instance_id: null, delegation_id: "delegation-1" }, process_group: { pgid: 4242, child_pids: [4244, 4243, 4243] },
    write_intents: [{ operation: "modify", path: "packages/arbor-mcp/src/example.ts", purpose: "implement enrollment" }], gate_intents: [{ gate_id: "gate:typecheck", mode: "snapshot", purpose: "verify candidate" }],
    ...overrides,
  };
}

function record(input = fixture()): RepoFlightSessionRecord {
  return Object.freeze({ manifest: createRepoFlightSessionManifest(input), state: "live", fenced: false, enrolled_at: "2026-08-28T12:00:00.000Z", heartbeat_at: "2026-08-28T12:00:00.000Z", control_channel: "connected", revision: 1, disposition_reason: null });
}

describe("repo flight session identity and reconciliation", () => {
  it("normalizes only the closed provider vocabulary and builds deterministic canonical identities", () => {
    expect(["Claude Code", "anthropic-claude", "claude"].map(normalizeRepoFlightProvider)).toEqual(["claude", "claude", "claude"]);
    expect(normalizeRepoFlightProvider("OpenAI Codex")).toBe("codex");
    expect(normalizeRepoFlightProvider("open_code")).toBe("opencode");
    expect(normalizeRepoFlightProvider("revoy-native")).toBe("native");
    expect(() => normalizeRepoFlightProvider("generic-agent")).toThrow(/closed provider/);
    const input = fixture(), one = createRepoFlightSessionManifest(input), two = createRepoFlightSessionManifest({ ...input, provider: "openai-codex" });
    expect(one.instance_id).toBe(two.instance_id);
    expect(one.repository.repository_id).toMatch(/^repo:v1:[a-f0-9]{64}$/);
    expect(one.process_group.child_pids).toEqual([4243, 4244]);
  });

  it("rejects unknown fields, noncanonical identity bindings, traversal, and oversized declarations", () => {
    const manifest = createRepoFlightSessionManifest(fixture());
    expect(() => validateRepoFlightSessionManifest({ ...manifest, surprise: true })).toThrow(/unknown or missing/);
    expect(() => validateRepoFlightSessionManifest({ ...manifest, instance_id: `agent:v1:${"0".repeat(64)}` })).toThrow(/does not verify/);
    expect(() => createRepoFlightSessionManifest(fixture({ write_intents: [{ operation: "modify", path: "../outside", purpose: "bad" }] }))).toThrow(/repository-relative/);
    expect(() => createRepoFlightSessionManifest(fixture({ write_intents: Array.from({ length: 129 }, (_, index) => ({ operation: "modify" as const, path: `file-${index}`, purpose: "bounded" })) }))).toThrow(/bound/);
  });

  it("fences PID reuse and never promotes a heartbeat or missing probe into confirmed death", () => {
    const enrolled = record();
    expect(reconcileRepoFlightSession(enrolled, { observed_at: "2026-08-28T11:59:59.000Z", pid_exists: true, process_start_token: "stale-reused-pid", host_boot_id: enrolled.manifest.host_boot_id, control_channel: "connected" })).toBe(enrolled);
    const heartbeatOnly = reconcileRepoFlightSession(enrolled, { observed_at: "2026-08-28T12:05:00.000Z", pid_exists: null, process_start_token: null, host_boot_id: null, control_channel: "disconnected" });
    expect(heartbeatOnly).toMatchObject({ state: "disconnected", fenced: false });
    expect(heartbeatOnly.disposition_reason).toMatch(/cannot prove death/);
    const reused = reconcileRepoFlightSession(enrolled, { observed_at: "2026-08-28T12:05:01.000Z", pid_exists: true, process_start_token: "linux-start-ticks-999", host_boot_id: enrolled.manifest.host_boot_id, control_channel: "connected" });
    expect(reused).toMatchObject({ state: "ambiguous", fenced: true });
    const wrongBootDeath = reconcileRepoFlightSession(enrolled, { observed_at: "2026-08-28T12:05:02.000Z", pid_exists: false, process_start_token: null, host_boot_id: "different-boot", control_channel: "disconnected" });
    expect(wrongBootDeath).toMatchObject({ state: "ambiguous", fenced: true });
    const confirmed = reconcileRepoFlightSession(enrolled, { observed_at: "2026-08-28T12:05:03.000Z", pid_exists: false, process_start_token: null, host_boot_id: enrolled.manifest.host_boot_id, control_channel: "disconnected" });
    expect(confirmed).toMatchObject({ state: "dead_confirmed", fenced: true });
  });

  it("redacts secret-shaped intent text and projects only identity fingerprints", () => {
    const source = record(fixture({ provider_session_id: "provider-session-sensitive", process_start_token: "start-token-sensitive", write_intents: [{ operation: "modify", path: "safe/file.ts", purpose: "token=super-secret-value continue" }] }));
    const projection = projectRepoFlightSession(source), serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("super-secret-value");
    expect(serialized).not.toContain("provider-session-sensitive");
    expect(serialized).not.toContain("start-token-sensitive");
    expect(projection.write_intents[0]?.purpose).toContain("[REDACTED]");
    expect(projection.provider_session_ref).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

describe("durable repo flight enrollment", () => {
  it("persists deterministic enrollment and fences an old identity when a PID is reused", () => {
    const persistence = mkdtempSync(join(tmpdir(), "repo-flight-registry-")); roots.push(persistence); let time = Date.parse("2026-08-28T12:00:00.000Z");
    const firstInput = fixture(), registry = new RepoFlightEnrollmentRegistry({ persistence_dir: persistence, now: () => new Date(time) });
    const first = registry.enroll(firstInput); expect(registry.enroll(firstInput).manifest.instance_id).toBe(first.manifest.instance_id);
    time += 1_000;
    const second = registry.enroll({ ...firstInput, provider_session_id: "provider-session-2", revoy_session_id: "revoy-session-2", process_start_token: "linux-start-ticks-200" });
    expect(second.state).toBe("live");
    expect(registry.record(first.manifest.instance_id)).toMatchObject({ state: "ambiguous", fenced: true });
    expect(registry.projections().map((item) => item.instance_id)).toEqual([...registry.projections().map((item) => item.instance_id)].sort());
    registry.close();
    // Durable recovery must retain the process identity after a dead worker's
    // worktree has already disappeared.
    rmSync(firstInput.repository.repository_root, { recursive: true, force: true });
    const restored = new RepoFlightEnrollmentRegistry({ persistence_dir: persistence });
    expect(restored.record(first.manifest.instance_id)).toMatchObject({ state: "ambiguous", fenced: true });
    expect(restored.record(second.manifest.instance_id)).toMatchObject({ state: "live", fenced: false });
    restored.close();
    expect(JSON.parse(readFileSync(join(persistence, "repo-flight-enrollment.json"), "utf8"))).toMatchObject({ schema_version: 1 });
  });

  it("requires identity-bound heartbeats and an explicit drain before quiescence", () => {
    const persistence = mkdtempSync(join(tmpdir(), "repo-flight-registry-")); roots.push(persistence); const registry = new RepoFlightEnrollmentRegistry({ persistence_dir: persistence, now: () => new Date("2026-08-28T12:00:00.000Z") });
    const enrolled = registry.enroll(fixture());
    expect(() => registry.transition(enrolled.manifest.instance_id, "quiesced")).toThrow(/prior draining/);
    expect(registry.transition(enrolled.manifest.instance_id, "draining").state).toBe("draining");
    expect(registry.transition(enrolled.manifest.instance_id, "quiesced").state).toBe("quiesced");
    const reused = registry.heartbeat({ instance_id: enrolled.manifest.instance_id, process_start_token: "wrong-start", host_boot_id: enrolled.manifest.host_boot_id, control_channel: "connected" });
    expect(reused).toMatchObject({ state: "ambiguous", fenced: true });
    expect(registry.heartbeat({ instance_id: enrolled.manifest.instance_id, process_start_token: enrolled.manifest.process_start_token, host_boot_id: enrolled.manifest.host_boot_id, control_channel: "connected" })).toMatchObject({ state: "ambiguous", fenced: true });
    expect(() => registry.transition(enrolled.manifest.instance_id, "draining")).toThrow(/fenced/);
    registry.close();
  });

  it("fails closed when durable state has unknown fields", () => {
    const persistence = mkdtempSync(join(tmpdir(), "repo-flight-registry-")); roots.push(persistence); const registry = new RepoFlightEnrollmentRegistry({ persistence_dir: persistence }); registry.enroll(fixture()); registry.close();
    const path = join(persistence, "repo-flight-enrollment.json"), state = JSON.parse(readFileSync(path, "utf8"));
    state.unrecognized = true;
    writeFileSync(path, JSON.stringify(state));
    expect(() => new RepoFlightEnrollmentRegistry({ persistence_dir: persistence })).toThrow(/unknown schema/);
  });
});
