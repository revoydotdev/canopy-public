import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { canonicalizeForHash } from "@arbor/core";
import { mp4FfmpegArgs, projectCampaignTreePublication, safeOutputRoot, validateGeneratorWorktree } from "../campaign-tree-publication.mjs";

const HASH_A = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const REVISION = "0123456789abcdef0123456789abcdef01234567";

function hash(value) { return createHash("sha256").update(canonicalizeForHash(value)).digest("hex"); }

function tree() {
  return {
    campaign_id: "campaign-publication-test", root_id: "root",
    nodes: [
      { id: "root", parent_id: null, created_at: "2026-08-22T00:00:00.000Z", state: "claimed", action_description: "private root task" },
      { id: "child", parent_id: "root", created_at: "2026-08-22T00:00:01.000Z", state: "failed", action_description: "private child task" },
    ],
  };
}

function audit() {
  return sealRecords([
    { kind: "trace", id: "trace-1", campaign_id: "campaign-publication-test", node_id: "child", timestamp: "2026-08-22T00:00:02.000Z", node_state_before: "pending", node_state_after: "expanding", specialist_output: "private output" },
    { kind: "trace", id: "trace-2", campaign_id: "campaign-publication-test", node_id: "child", timestamp: "2026-08-22T00:00:03.000Z", node_state_before: "expanding", node_state_after: "failed", specialist_output: "private output" },
  ]);
}

function sealRecords(records) {
  let previous = null;
  return records.map((record) => {
    const { content_hash: _contentHash, previous_hash: _previousHash, ...body } = record;
    const unhashed = { ...body, previous_hash: previous };
    const content_hash = hash(unhashed);
    previous = content_hash;
    return { ...unhashed, content_hash };
  });
}

function tip(records) {
  const unhashed = { kind: "arbor_audit_tip_sentinel", version: 1, campaign_id: "campaign-publication-test", record_count: records.length, tip_hash: records.at(-1)?.content_hash ?? null };
  return { ...unhashed, content_hash: hash(unhashed) };
}

function source() { return { tree_sha256: HASH_A, audit_sha256: HASH_B, audit_tip_sha256: HASH_A, generator_revision: REVISION }; }

describe("campaign-tree public projection", () => {
  it("emits only public-safe observed topology and reduced audit transitions", () => {
    const records = audit();
    const fixture = projectCampaignTreePublication(tree(), records, tip(records), REVISION, source());
    expect(fixture).toMatchObject({ kind: "revoy2.campaign-tree-hero-events", campaign_id: "campaign-publication-test", source_revision: REVISION, root: { id: "root" }, nodes: [{ id: "child", parent_id: "root", final_state: "failed" }] });
    expect(fixture.events.map((event) => event.kind)).toEqual(["campaign_started", "branch_created", "selected", "rejected"]);
    expect(fixture.source.audit_chain_head).toBe(`sha256:${records.at(-1).content_hash}`);
    expect(fixture.generator_revision).toBe(REVISION);
    expect(JSON.stringify(fixture)).not.toContain("private root task");
    expect(JSON.stringify(fixture)).not.toContain("private output");
  });

  it("projects telemetry-backed selection and an explicit unverified claim without inventing rejection", () => {
    const records = sealRecords([
      { kind: "telemetry_observation", id: "select-1", campaign_id: "campaign-publication-test", node_id: "child", timestamp: "2026-08-22T00:00:02.000Z", observation: { type: "phase_timing", phase: "select", outcome: "success" } },
      { kind: "trace", id: "claim-1", campaign_id: "campaign-publication-test", node_id: "child", timestamp: "2026-08-22T00:00:03.000Z", node_state_before: "awaiting_review", node_state_after: "claimed" },
    ]);
    const claimedTree = tree();
    claimedTree.nodes[1].state = "claimed";
    const fixture = projectCampaignTreePublication(claimedTree, records, tip(records), REVISION, source());
    expect(fixture.events.map((event) => event.kind)).toEqual(["campaign_started", "branch_created", "selected", "claimed"]);
    expect(fixture.events.some((event) => event.kind === "rejected" || event.kind === "backtracked")).toBe(false);
  });

  it("fails closed on campaign, node, and ledger-chain mismatches", () => {
    const records = audit();
    expect(() => projectCampaignTreePublication(tree(), [{ ...records[0], campaign_id: "other-campaign" }], tip(records), REVISION, source())).toThrow(/does not belong/);
    expect(() => projectCampaignTreePublication(tree(), [{ ...records[0], node_id: "missing-node" }], tip(records), REVISION, source())).toThrow(/unknown tree node/);
    const broken = audit();
    const changed = { ...broken[1], previous_hash: broken[1].content_hash };
    const { content_hash: _ignored, ...unhashed } = changed;
    changed.content_hash = hash(unhashed);
    broken[1] = changed;
    expect(() => projectCampaignTreePublication(tree(), broken, tip(broken), REVISION, source())).toThrow(/hash chain breaks/);
  });

  it("rejects record tampering and a ledger truncated below its sealed tip", () => {
    const tampered = audit();
    tampered[0].specialist_output = "altered private output";
    expect(() => projectCampaignTreePublication(tree(), tampered, tip(audit()), REVISION, source())).toThrow(/content hash does not match/);
    const complete = audit();
    expect(() => projectCampaignTreePublication(tree(), complete.slice(0, 1), tip(complete), REVISION, source())).toThrow(/record_count/);
  });

  it("anchors the sentinel to validated ledger order, not display timestamp order", () => {
    const records = audit();
    records[0].timestamp = "2026-08-22T00:00:04.000Z";
    const nonmonotonic = sealRecords(records);
    expect(() => projectCampaignTreePublication(tree(), nonmonotonic, tip(nonmonotonic), REVISION, source())).not.toThrow();
  });

  it("rejects an unsafe publication root before creating it", () => {
    const unsafe = join("/tmp", "campaign-tree-publication-must-not-exist");
    expect(existsSync(unsafe)).toBe(false);
    expect(() => safeOutputRoot(unsafe)).toThrow(/remain under \/mnt\/sda2/);
    expect(existsSync(unsafe)).toBe(false);
  });

  it("requires an in-transaction H.264 yuv420p derivative", () => {
    expect(mp4FfmpegArgs("campaign-tree.webm", "campaign-tree.mp4")).toEqual([
      "-hide_banner", "-loglevel", "error", "-y", "-i", "campaign-tree.webm", "-map", "0:v:0", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "campaign-tree.mp4",
    ]);
  });

  it("binds a clean generator revision and rejects dirty worktrees or unknown source commits", () => {
    const worktree = mkdtempSync(join(tmpdir(), "campaign-tree-generator-"));
    try {
      execFileSync("git", ["init", "-q", worktree]);
      writeFileSync(join(worktree, "tracked.txt"), "clean\n");
      execFileSync("git", ["-C", worktree, "add", "tracked.txt"]);
      execFileSync("git", ["-C", worktree, "-c", "user.email=test@example.invalid", "-c", "user.name=Campaign Test", "commit", "-qm", "initial"]);
      const revision = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      expect(validateGeneratorWorktree(worktree, revision, worktree)).toEqual({ generator_revision: revision });
      expect(() => validateGeneratorWorktree(worktree, "f".repeat(40), worktree)).toThrow(/does not resolve/);
      expect(() => validateGeneratorWorktree(worktree, revision, dirname(worktree))).toThrow(/repository executing/);
      writeFileSync(join(worktree, "tracked.txt"), "dirty\n");
      expect(() => validateGeneratorWorktree(worktree, revision, worktree)).toThrow(/tracked changes/);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });
});
