import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureWorktreeResult } from "../src/result-adoption.js";
import { ResultReviewWorkspaceService } from "../src/result-review-workspace.js";

function repo(): string { const root = mkdtempSync(join(tmpdir(), "result-review-repo-")); execFileSync("git", ["init", "-q"], { cwd: root }); execFileSync("git", ["config", "user.email", "review@test.invalid"], { cwd: root }); execFileSync("git", ["config", "user.name", "Review test"], { cwd: root }); writeFileSync(join(root, "seed.txt"), "one\ntwo\n", "utf8"); execFileSync("git", ["add", "-A"], { cwd: root }); execFileSync("git", ["commit", "-qm", "base"], { cwd: root }); return root; }

describe("ResultReviewWorkspaceService", () => {
  it("builds real unified/side-by-side review, CAS comments, conflict preview, revision request, and durable editor continuity", () => {
    const target = repo(); const worktree = repo(); const persistence = mkdtempSync(join(tmpdir(), "result-review-store-"));
    try {
      writeFileSync(join(worktree, "seed.txt"), "one changed\ntwo\nthree\n", "utf8"); mkdirSync(join(worktree, "src")); writeFileSync(join(worktree, "src", "new.ts"), "export const value = 1;\n", "utf8");
      const capture = captureWorktreeResult({ campaign_id: "campaign", node_id: "node", worktree_path: worktree, verified: true, score: 0.95, persistence_dir: persistence }); if (!capture) throw new Error("fixture did not capture");
      const service = new ResultReviewWorkspaceService({ persistence_dir: persistence, clock: () => "2030-01-01T00:00:00.000Z" });
      const first = service.inspect({ persistence_dir: persistence, workspace_root: target, campaign_id: "campaign", node_id: "node", critic_verdict: { approved: true, critic_agent: "lenticel", rationale: "verified change" }, verification: { campaign_id: "campaign", node_id: "node", checks: [{ command: ["bun", "test"], exit_status: 0, duration_ms: 10, summary: "pass", provenance: { tag: "verified", cmd: "bun test", exit: 0, stdout_hash: "sha256:test" } }], files: capture.files, diffstat: { additions: 3, deletions: 1, files_changed: 2 }, confidence: "verified", absence_reason: null, provenance: { tag: "verified", cmd: "bun test", exit: 0, stdout_hash: "sha256:test" }, captured_at: "2030-01-01T00:00:00.000Z" } });
      expect(first).toMatchObject({ counts: { files: 2, additions: 3, deletions: 1 }, conflict_preview: { status: "clean" }, relationships: { critic: { status: "available", verdict: { approved: true, critic_agent: "lenticel" } }, verification: { confidence: "verified" } } });
      expect(first.side_by_side.some((row) => row.kind === "changed")).toBe(true); expect(first.file_tree.some((entry) => entry.path === "src" && entry.kind === "directory")).toBe(true);
      expect(() => service.addComment({ campaign_id: "campaign", node_id: "node", expected_patch_sha256: capture.patch_sha256, expected_revision: 1, file_path: "outside.txt", line: 1, side: "new", body: "not part of this capture", author_id: "reviewer" })).toThrow(/captured file/);
      const commented = service.addComment({ campaign_id: "campaign", node_id: "node", expected_patch_sha256: capture.patch_sha256, expected_revision: 1, file_path: "seed.txt", line: 1, side: "new", body: "Explain this change", author_id: "reviewer" });
      expect(commented.revision).toBe(2); expect(() => service.addComment({ campaign_id: "campaign", node_id: "node", expected_patch_sha256: capture.patch_sha256, expected_revision: 1, file_path: "seed.txt", line: 1, side: "new", body: "stale", author_id: "reviewer" })).toThrow(/revision changed/);
      const requested = service.requestRevision({ campaign_id: "campaign", node_id: "node", expected_patch_sha256: capture.patch_sha256, expected_revision: 2, reason: "Address the inline concern", author_id: "reviewer", comment_ids: [commented.comments[0]!.id] }); expect(requested.revision_requests).toHaveLength(1);
      expect(() => service.createEditorHandoff({ campaign_id: "campaign", node_id: "node", expected_patch_sha256: capture.patch_sha256, expected_revision: 3, workspace_root: target, file_path: "outside.txt", line: 1, editor: "vscode" })).toThrow(/captured file/);
      const handed = service.createEditorHandoff({ campaign_id: "campaign", node_id: "node", expected_patch_sha256: capture.patch_sha256, expected_revision: 3, workspace_root: target, file_path: "seed.txt", line: 1, editor: "vscode" }); expect(handed.editor_sessions[0]).toMatchObject({ editor: "vscode", file_path: "seed.txt", line: 1 });
      const restored = new ResultReviewWorkspaceService({ persistence_dir: persistence }).inspect({ persistence_dir: persistence, workspace_root: target, campaign_id: "campaign", node_id: "node" }); expect(restored).toMatchObject({ review_revision: 4, counts: { comments: 1, revision_requests: 1 }, editor_sessions: [{ id: handed.editor_sessions[0]!.id }] });
      writeFileSync(join(worktree, "src", "new.ts"), "export const value = 2;\n", "utf8");
      const replacement = captureWorktreeResult({ campaign_id: "campaign", node_id: "node", worktree_path: worktree, verified: true, score: 0.96, persistence_dir: persistence });
      expect(replacement?.patch_sha256).not.toBe(capture.patch_sha256);
      expect(() => service.addComment({ campaign_id: "campaign", node_id: "node", expected_patch_sha256: capture.patch_sha256, expected_revision: 4, file_path: "seed.txt", line: 1, side: "new", body: "stale manifest comment", author_id: "reviewer" })).toThrow(/manifest changed/);
      writeFileSync(join(target, "seed.txt"), "operator divergence\n", "utf8"); expect(service.inspect({ persistence_dir: persistence, workspace_root: target, campaign_id: "campaign", node_id: "node" }).conflict_preview.status).toBe("conflict");
    } finally { rmSync(target, { recursive: true, force: true }); rmSync(worktree, { recursive: true, force: true }); rmSync(persistence, { recursive: true, force: true }); }
  });
});
