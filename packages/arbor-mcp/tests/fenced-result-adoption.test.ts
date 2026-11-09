import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DistributedControlClient, DistributedControlHttpHost, DistributedControlPlane, type DistributedHostGrant } from "../src/distributed-control-plane.js";
import { captureWorktreeResult, readScopeExpansion } from "../src/result-adoption.js";
import { FencedResultAdoptionService } from "../src/fenced-result-adoption.js";

const roots: string[] = []; afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const secret = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const grant = (prefix: string): DistributedHostGrant => ({ secret, routes: ["leases.manage", "adoptions.manage", "health.read"], resource_prefixes: [prefix], audiences: [], capabilities: [], expires_at: "2099-01-01T00:00:00.000Z" });

describe("fenced result adoption", () => {
  it("couples the real Git mutation to prepare, global commit, durable journal, and finalize", async () => {
    const root = mkdtempSync(join(tmpdir(), "revoy-fenced-adopt-")); roots.push(root); const repo = join(root, "repo"), work = join(root, "work"), persistence = join(root, "state"), control = join(root, "control");
    mkdirSync(repo); git(repo, ["init", "-q"]); git(repo, ["config", "user.email", "test@invalid"]); git(repo, ["config", "user.name", "test"]); writeFileSync(join(repo, "a.txt"), "base\n"); git(repo, ["add", "."]); git(repo, ["commit", "-qm", "base"]); execFileSync("git", ["clone", "-q", repo, work]); writeFileSync(join(work, "a.txt"), "changed\n");
    const capture = captureWorktreeResult({ campaign_id: "campaign", node_id: "node", worktree_path: work, verified: true, score: 1, declared_write_paths: ["a.txt"], persistence_dir: persistence })!;
    const prefix = "revoy-resource:v1:repository:repo-a:result:"; const plane = new DistributedControlPlane({ persistence_dir: control, host_grants: { host_a: grant(prefix) } }); const http = new DistributedControlHttpHost(plane, { enabled: true, host: "127.0.0.1", port: 0 }); const address = await http.start(); const client = new DistributedControlClient({ base_url: `${address.protocol}//${address.host}:${address.port}`, host_id: "host_a", secret });
    const service = new FencedResultAdoptionService({ client, persistence_dir: persistence, repository_id: "repo-a" }); const outcome = await service.adopt({ campaign_id: "campaign", node_id: "node", target_root: repo, expected_patch_sha256: capture.patch_sha256 });
    expect(outcome.ok && outcome.entry.state).toBe("finalized"); expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("changed\n"); expect(service.list()).toHaveLength(1);
    const health = await client.request<{ adoptions: { finalized: number } }>("GET", "/v1/health"); expect(health.ok && health.value.adoptions.finalized).toBe(1);
    await http.stop(); plane.close();
  });

  it("fences and journals reverse adoption through the same distributed mutation boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "revoy-fenced-revert-")); roots.push(root); const repo = join(root, "repo"), work = join(root, "work"), persistence = join(root, "state"), control = join(root, "control");
    mkdirSync(repo); git(repo, ["init", "-q"]); git(repo, ["config", "user.email", "test@invalid"]); git(repo, ["config", "user.name", "test"]); writeFileSync(join(repo, "a.txt"), "base\n"); git(repo, ["add", "."]); git(repo, ["commit", "-qm", "base"]); execFileSync("git", ["clone", "-q", repo, work]); writeFileSync(join(work, "a.txt"), "changed\n");
    const capture = captureWorktreeResult({ campaign_id: "campaign", node_id: "node", worktree_path: work, verified: true, score: 1, declared_write_paths: ["a.txt"], persistence_dir: persistence })!;
    const prefix = "revoy-resource:v1:repository:repo-a:result:"; const plane = new DistributedControlPlane({ persistence_dir: control, host_grants: { host_a: grant(prefix) } }); const http = new DistributedControlHttpHost(plane, { enabled: true, host: "127.0.0.1", port: 0 }); const address = await http.start(); const client = new DistributedControlClient({ base_url: `${address.protocol}//${address.host}:${address.port}`, host_id: "host_a", secret });
    const service = new FencedResultAdoptionService({ client, persistence_dir: persistence, repository_id: "repo-a" });
    expect((await service.adopt({ campaign_id: "campaign", node_id: "node", target_root: repo, expected_patch_sha256: capture.patch_sha256 })).ok).toBe(true);
    const reverted = await service.revert({ campaign_id: "campaign", node_id: "node", target_root: repo, expected_patch_sha256: capture.patch_sha256 });
    expect(reverted.ok && reverted.entry.action).toBe("revert"); expect(reverted.ok && reverted.entry.state).toBe("finalized"); expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("base\n"); expect(service.list().map((entry) => entry.action)).toEqual(["adopt", "revert"]);
    await http.stop(); plane.close();
  });

  it("fails closed before mutation when another host owns the canonical resource fence", async () => {
    const root = mkdtempSync(join(tmpdir(), "revoy-fenced-conflict-")); roots.push(root); const repo = join(root, "repo"), work = join(root, "work"), persistence = join(root, "state"), control = join(root, "control");
    mkdirSync(repo); git(repo, ["init", "-q"]); git(repo, ["config", "user.email", "test@invalid"]); git(repo, ["config", "user.name", "test"]); writeFileSync(join(repo, "a.txt"), "base\n"); git(repo, ["add", "."]); git(repo, ["commit", "-qm", "base"]); execFileSync("git", ["clone", "-q", repo, work]); writeFileSync(join(work, "a.txt"), "changed\n");
    const capture = captureWorktreeResult({ campaign_id: "campaign", node_id: "node", worktree_path: work, verified: true, score: 1, persistence_dir: persistence })!; const prefix = "revoy-resource:v1:repository:repo-a:result:";
    const plane = new DistributedControlPlane({ persistence_dir: control, host_grants: { host_a: grant(prefix), host_b: { ...grant(prefix), secret: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } } }); const http = new DistributedControlHttpHost(plane, { enabled: true, host: "127.0.0.1", port: 0 }); const address = await http.start(); const base = `${address.protocol}//${address.host}:${address.port}`; const a = new DistributedControlClient({ base_url: base, host_id: "host_a", secret }), b = new DistributedControlClient({ base_url: base, host_id: "host_b", secret: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
    const resource = `revoy-resource:v1:repository:repo-a:result:${await hash("campaign\0node")}`; expect((await b.request("POST", "/v1/leases/acquire", { request_id: "hold", resource_id: resource, ttl_ms: 60_000 })).ok).toBe(true);
    const outcome = await new FencedResultAdoptionService({ client: a, persistence_dir: persistence, repository_id: "repo-a" }).adopt({ campaign_id: "campaign", node_id: "node", target_root: repo, expected_patch_sha256: capture.patch_sha256 });
    expect(outcome.ok).toBe(false); expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("base\n");
    await http.stop(); plane.close();
  });

  it("quarantines commit-before-apply ambiguity and finalizes apply-before-response after restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "revoy-fenced-crash-")); roots.push(root); const repo = join(root, "repo"), work = join(root, "work"), persistence = join(root, "state"), control = join(root, "control");
    mkdirSync(repo); git(repo, ["init", "-q"]); git(repo, ["config", "user.email", "test@invalid"]); git(repo, ["config", "user.name", "test"]); writeFileSync(join(repo, "a.txt"), "base\n"); git(repo, ["add", "."]); git(repo, ["commit", "-qm", "base"]); execFileSync("git", ["clone", "-q", repo, work]); writeFileSync(join(work, "a.txt"), "changed\n");
    const capture = captureWorktreeResult({ campaign_id: "campaign", node_id: "node", worktree_path: work, verified: true, score: 1, persistence_dir: persistence })!; const prefix = "revoy-resource:v1:repository:repo-a:result:";
    const plane = new DistributedControlPlane({ persistence_dir: control, host_grants: { host_a: grant(prefix) } }); const http = new DistributedControlHttpHost(plane, { enabled: true, host: "127.0.0.1", port: 0 }); const address = await http.start(); const client = new DistributedControlClient({ base_url: `${address.protocol}//${address.host}:${address.port}`, host_id: "host_a", secret });
    const beforeApply = new FencedResultAdoptionService({ client, persistence_dir: persistence, repository_id: "repo-a", fault_after: "commit" });
    await expect(beforeApply.adopt({ campaign_id: "campaign", node_id: "node", target_root: repo, expected_patch_sha256: capture.patch_sha256 })).rejects.toThrow(/after distributed commit/);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("base\n");
    expect((await new FencedResultAdoptionService({ client, persistence_dir: persistence, repository_id: "repo-a" }).recover(repo))[0]).toMatchObject({ outcome: "quarantined" });
    await http.stop(); plane.close();

    const control2 = join(root, "control-2"), persistence2 = join(root, "state-2"), work2 = join(root, "work-2"); execFileSync("git", ["clone", "-q", repo, work2]); writeFileSync(join(work2, "a.txt"), "changed\n");
    const capture2 = captureWorktreeResult({ campaign_id: "campaign", node_id: "node", worktree_path: work2, verified: true, score: 1, persistence_dir: persistence2 })!;
    const plane2 = new DistributedControlPlane({ persistence_dir: control2, host_grants: { host_a: grant(prefix) } }); const http2 = new DistributedControlHttpHost(plane2, { enabled: true, host: "127.0.0.1", port: 0 }); const address2 = await http2.start(); const client2 = new DistributedControlClient({ base_url: `${address2.protocol}//${address2.host}:${address2.port}`, host_id: "host_a", secret });
    const afterApply = new FencedResultAdoptionService({ client: client2, persistence_dir: persistence2, repository_id: "repo-a", fault_after: "apply" });
    await expect(afterApply.adopt({ campaign_id: "campaign", node_id: "node", target_root: repo, expected_patch_sha256: capture2.patch_sha256 })).rejects.toThrow(/after local apply/);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("changed\n");
    expect((await new FencedResultAdoptionService({ client: client2, persistence_dir: persistence2, repository_id: "repo-a" }).recover(repo))[0]).toMatchObject({ outcome: "finalized" });
    await http2.stop(); plane2.close();
  });

  // WA-67 threaded through the fenced/distributed adoption path: a
  // command-verified capture whose diff exceeds a MINED declared write scope
  // is unadoptable via `adoptCapturedResult` without an explicit,
  // digest-bound `acknowledge_scope_expansion` — the fenced path must honor
  // the exact same gate (never silently widen scope just because a remote
  // coordinator is in play), and the acknowledgment must actually reach the
  // real Git mutation and its durable `ScopeExpansionRecord`.
  it("refuses a mined out-of-scope capture unacknowledged, and adopts it once acknowledged with the matching digest", async () => {
    const root = mkdtempSync(join(tmpdir(), "revoy-fenced-scope-")); roots.push(root); const repo = join(root, "repo"), work = join(root, "work"), persistence = join(root, "state"), control = join(root, "control");
    mkdirSync(repo); git(repo, ["init", "-q"]); git(repo, ["config", "user.email", "test@invalid"]); git(repo, ["config", "user.name", "test"]); writeFileSync(join(repo, "test.js"), "require('./lib.js');\n"); git(repo, ["add", "."]); git(repo, ["commit", "-qm", "base"]); execFileSync("git", ["clone", "-q", repo, work]);
    writeFileSync(join(work, "lib.js"), "module.exports = {};\n"); writeFileSync(join(work, "test.js"), "require('./lib.js');\nrequire('./lib.js');\n");
    const capture = captureWorktreeResult({ campaign_id: "campaign", node_id: "node", worktree_path: work, verified: true, score: 1, declared_write_paths: ["test.js"], scope_provenance: "mined", persistence_dir: persistence })!;
    expect(capture).toMatchObject({ verified: false, command_verified: true, scope_violations: ["lib.js"] });
    const prefix = "revoy-resource:v1:repository:repo-a:result:"; const plane = new DistributedControlPlane({ persistence_dir: control, host_grants: { host_a: grant(prefix) } }); const http = new DistributedControlHttpHost(plane, { enabled: true, host: "127.0.0.1", port: 0 }); const address = await http.start(); const client = new DistributedControlClient({ base_url: `${address.protocol}//${address.host}:${address.port}`, host_id: "host_a", secret });
    const service = new FencedResultAdoptionService({ client, persistence_dir: persistence, repository_id: "repo-a" });

    const refused = await service.adopt({ campaign_id: "campaign", node_id: "node", target_root: repo, expected_patch_sha256: capture.patch_sha256 });
    expect(refused.ok).toBe(false);
    if (!refused.ok) { expect(refused.reason).toContain("lib.js"); expect(refused.reason).toContain("acknowledge_scope_expansion"); }
    expect(existsSync(join(repo, "lib.js"))).toBe(false);
    expect(readScopeExpansion(persistence, "campaign", "node")).toBeNull();

    const badDigest = await service.adopt({ campaign_id: "campaign", node_id: "node", target_root: repo, expected_patch_sha256: "0".repeat(64), acknowledge_scope_expansion: true, acknowledged_by: "test-operator" });
    expect(badDigest.ok).toBe(false);
    expect(existsSync(join(repo, "lib.js"))).toBe(false);
    expect(readScopeExpansion(persistence, "campaign", "node")).toBeNull();

    const expanded = await service.adopt({ campaign_id: "campaign", node_id: "node", target_root: repo, expected_patch_sha256: capture.patch_sha256, acknowledge_scope_expansion: true, acknowledged_by: "test-operator" });
    expect(expanded.ok && expanded.entry.state).toBe("finalized");
    expect(readFileSync(join(repo, "lib.js"), "utf8")).toBe("module.exports = {};\n");
    const record = readScopeExpansion(persistence, "campaign", "node");
    expect(record).toMatchObject({ campaign_id: "campaign", node_id: "node", declared_write_paths: ["test.js"], acknowledged_paths: ["lib.js"], scope_provenance: "mined", acknowledged_by: "test-operator" });
    await http.stop(); plane.close();
  });

  it("never lets acknowledge_scope_expansion rescue a genuine verification failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "revoy-fenced-scope-fail-")); roots.push(root); const repo = join(root, "repo"), work = join(root, "work"), persistence = join(root, "state"), control = join(root, "control");
    mkdirSync(repo); git(repo, ["init", "-q"]); git(repo, ["config", "user.email", "test@invalid"]); git(repo, ["config", "user.name", "test"]); writeFileSync(join(repo, "a.txt"), "base\n"); git(repo, ["add", "."]); git(repo, ["commit", "-qm", "base"]); execFileSync("git", ["clone", "-q", repo, work]); writeFileSync(join(work, "a.txt"), "changed\n");
    const capture = captureWorktreeResult({ campaign_id: "campaign", node_id: "node", worktree_path: work, verified: false, score: 0, declared_write_paths: ["a.txt"], scope_provenance: "mined", persistence_dir: persistence })!;
    expect(capture.command_verified).toBe(false);
    const prefix = "revoy-resource:v1:repository:repo-a:result:"; const plane = new DistributedControlPlane({ persistence_dir: control, host_grants: { host_a: grant(prefix) } }); const http = new DistributedControlHttpHost(plane, { enabled: true, host: "127.0.0.1", port: 0 }); const address = await http.start(); const client = new DistributedControlClient({ base_url: `${address.protocol}//${address.host}:${address.port}`, host_id: "host_a", secret });
    const service = new FencedResultAdoptionService({ client, persistence_dir: persistence, repository_id: "repo-a" });
    const outcome = await service.adopt({ campaign_id: "campaign", node_id: "node", target_root: repo, expected_patch_sha256: capture.patch_sha256, acknowledge_scope_expansion: true, acknowledged_by: "test-operator" });
    expect(outcome.ok).toBe(false);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("base\n");
    expect(readScopeExpansion(persistence, "campaign", "node")).toBeNull();
    await http.stop(); plane.close();
  });
});

function git(root: string, args: string[]): void { execFileSync("git", args, { cwd: root, stdio: "pipe" }); }
async function hash(value: string): Promise<string> { const { createHash } = await import("node:crypto"); return createHash("sha256").update(value).digest("hex").slice(0, 32); }
