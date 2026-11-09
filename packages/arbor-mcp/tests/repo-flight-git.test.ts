import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeManager } from "@arbor/campaign-support";
import { createRepoFlightWorkspaceSnapshot, isRepoFlightProvisionedWorkspace, probeRepoFlightGitCandidate, probeRepoFlightQuiescentConfinement, runRepoFlightGateCommand } from "../src/repo-flight-git.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "repo-flight-git-"));
  roots.push(root);
  run(root, ["init", "-q"]); run(root, ["config", "user.email", "flight@example.invalid"]); run(root, ["config", "user.name", "Flight Test"]);
  writeFileSync(join(root, "tracked.txt"), "one\n"); run(root, ["add", "tracked.txt"]); run(root, ["commit", "-qm", "initial"]);
  return root;
}

function run(root: string, argv: string[]): void { const result = spawnSync("git", argv, { cwd: root, encoding: "utf8" }); if (result.status !== 0) throw new Error(result.stderr); }

describe("repo flight Git adapter", () => {
  it("reports quiescent confinement from an actual host capability probe", () => {
    const result = probeRepoFlightQuiescentConfinement();
    expect(typeof result.available).toBe("boolean");
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("binds committed, staged, modified, and untracked content without changing Git", () => {
    const root = repository();
    const clean = probeRepoFlightGitCandidate(root);
    writeFileSync(join(root, "tracked.txt"), "two\n");
    const modified = probeRepoFlightGitCandidate(root, clean.base_oid);
    expect(modified.tree_digest).not.toBe(clean.tree_digest);
    expect(modified.index_digest).toBe(clean.index_digest);
    run(root, ["add", "tracked.txt"]);
    const staged = probeRepoFlightGitCandidate(root, clean.base_oid);
    expect(staged.tree_digest).not.toBe(modified.tree_digest);
    expect(staged.index_digest).not.toBe(clean.index_digest);
    writeFileSync(join(root, "new.txt"), "untracked\n");
    const untracked = probeRepoFlightGitCandidate(root, clean.base_oid);
    expect(untracked.tree_digest).not.toBe(staged.tree_digest);
    expect(untracked.head_oid).toBe(clean.head_oid);
  });

  it("binds a dirty patch larger than the subprocess output ceiling without buffering it", () => {
    const root = repository();
    const clean = probeRepoFlightGitCandidate(root);
    writeFileSync(join(root, "tracked.txt"), Buffer.alloc(65 * 1024 * 1024, 0x61));
    const dirty = probeRepoFlightGitCandidate(root, clean.base_oid);
    expect(dirty.tree_digest).not.toBe(clean.tree_digest);
    expect(dirty.index_digest).toBe(clean.index_digest);
  });

  it("constructs an independently cleanable Git snapshot with exact workspace content", () => {
    const root = repository();
    writeFileSync(join(root, "tracked.txt"), "dirty\n");
    writeFileSync(join(root, "new.txt"), "new\n");
    const candidate = probeRepoFlightGitCandidate(root);
    const snapshot = createRepoFlightWorkspaceSnapshot(root, candidate);
    expect(readFileSync(join(snapshot.root, "tracked.txt"), "utf8")).toBe("dirty\n");
    expect(readFileSync(join(snapshot.root, "new.txt"), "utf8")).toBe("new\n");
    expect(spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: snapshot.root, encoding: "utf8" }).stdout.trim()).toBe("true");
    snapshot.cleanup();
    snapshot.cleanup();
    expect(existsSync(snapshot.root)).toBe(false);
    expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("dirty\n");
  });

  it("admits only an exactly leased and registered Revoy detached worktree", () => {
    const root = repository();
    const base = probeRepoFlightGitCandidate(root).base_oid;
    const manager = new WorktreeManager({ repoRoot: root });
    const lease = manager.acquireLease({ campaign_id: "campaign-flight", node_id: "node-flight", specialist: "seed" });
    if (!lease) throw new Error(manager.lastAcquireFailure ?? "lease unavailable");
    try {
      expect(probeRepoFlightGitCandidate(lease.path).git_common_dir).not.toBe(probeRepoFlightGitCandidate(root).git_common_dir);
      expect(isRepoFlightProvisionedWorkspace(root, lease.path, { campaign_id: "campaign-flight", node_id: "node-flight", base_oid: base })).toBe(true);
      expect(isRepoFlightProvisionedWorkspace(root, lease.path, { campaign_id: "campaign-other", node_id: "node-flight", base_oid: base })).toBe(false);
      expect(isRepoFlightProvisionedWorkspace(root, lease.path, { campaign_id: "campaign-flight", node_id: "node-flight", base_oid: "f".repeat(40) })).toBe(false);
    } finally { manager.releaseLease("node-flight"); }
  });

  it("runs argv without expansion and reports process-group timeouts", () => {
    const root = repository();
    const literal = runRepoFlightGateCommand(root, { gate_id: "literal", argv: ["printf", "%s", "$HOME"], timeout_ms: 2_000, read_only: true });
    expect(literal).toMatchObject({ exit_code: 0, stdout: "$HOME", timed_out: false });
    const timeout = runRepoFlightGateCommand(root, { gate_id: "timeout", argv: ["sleep", "2"], timeout_ms: 100, read_only: true });
    expect(timeout.timed_out).toBe(true);
    expect(timeout.exit_code).toBe(124);
  });

  it("mechanically mounts the live repository read-only for quiescent gates", () => {
    const root = repository();
    const attempted = runRepoFlightGateCommand(root, { gate_id: "readonly", argv: ["sh", "-c", "printf changed > tracked.txt"], timeout_ms: 2_000, read_only: true }, "quiescent");
    expect(attempted.exit_code).not.toBe(0);
    expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("one\n");
  });
});
