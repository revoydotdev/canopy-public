import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRepoInstructions, REPO_INSTRUCTIONS_BYTE_BUDGET } from "../src/repo-instructions.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "arbor-repo-instructions-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveRepoInstructions — ADR-022 (G-10)", () => {
  it("returns an empty scope when neither file exists", () => {
    const scope = resolveRepoInstructions(root);
    expect(scope).toEqual({ source_paths: [], content: "", truncated: false });
  });

  it("resolves AGENTS.md alone", () => {
    writeFileSync(join(root, "AGENTS.md"), "Follow the repo conventions.", "utf8");
    const scope = resolveRepoInstructions(root);
    expect(scope.source_paths).toEqual([join(root, "AGENTS.md")]);
    expect(scope.content).toContain("Follow the repo conventions.");
    expect(scope.truncated).toBe(false);
  });

  it("resolves CLAUDE.md alone", () => {
    writeFileSync(join(root, "CLAUDE.md"), "Use conventional commits.", "utf8");
    const scope = resolveRepoInstructions(root);
    expect(scope.source_paths).toEqual([join(root, "CLAUDE.md")]);
    expect(scope.content).toContain("Use conventional commits.");
  });

  it("composes both files in AGENTS.md -> CLAUDE.md precedence order when both exist", () => {
    writeFileSync(join(root, "AGENTS.md"), "AGENTS-CONTENT", "utf8");
    writeFileSync(join(root, "CLAUDE.md"), "CLAUDE-CONTENT", "utf8");
    const scope = resolveRepoInstructions(root);
    expect(scope.source_paths).toEqual([join(root, "AGENTS.md"), join(root, "CLAUDE.md")]);
    const agentsIdx = scope.content.indexOf("AGENTS-CONTENT");
    const claudeIdx = scope.content.indexOf("CLAUDE-CONTENT");
    expect(agentsIdx).toBeGreaterThanOrEqual(0);
    expect(claudeIdx).toBeGreaterThan(agentsIdx);
  });

  it("never walks above the worktree root — a parent AGENTS.md is invisible", () => {
    const nested = join(root, "nested-worktree");
    mkdirSync(nested);
    writeFileSync(join(root, "AGENTS.md"), "PARENT-SHOULD-NOT-APPEAR", "utf8");
    const scope = resolveRepoInstructions(nested);
    expect(scope).toEqual({ source_paths: [], content: "", truncated: false });
  });

  it("is a no-op (not an error) for a blank worktree path", () => {
    expect(resolveRepoInstructions("")).toEqual({ source_paths: [], content: "", truncated: false });
  });

  it("is deterministic for a fixed worktree state — repeated calls produce byte-identical output", () => {
    writeFileSync(join(root, "AGENTS.md"), "stable content", "utf8");
    const a = resolveRepoInstructions(root);
    const b = resolveRepoInstructions(root);
    expect(a).toEqual(b);
  });

  it("truncates deterministically at the byte budget rather than blowing past it", () => {
    writeFileSync(join(root, "AGENTS.md"), "x".repeat(500), "utf8");
    const scope = resolveRepoInstructions(root, 100);
    expect(scope.truncated).toBe(true);
    expect(Buffer.byteLength(scope.content, "utf-8")).toBeLessThanOrEqual(150); // header + budget + truncation notice
    expect(scope.content).toContain("truncated");
  });

  it("rejects a non-positive or non-integer byte budget rather than misbehaving silently", () => {
    writeFileSync(join(root, "AGENTS.md"), "content", "utf8");
    expect(() => resolveRepoInstructions(root, 0)).toThrow(/positive integer/);
    expect(() => resolveRepoInstructions(root, -1)).toThrow(/positive integer/);
    expect(() => resolveRepoInstructions(root, 1.5)).toThrow(/positive integer/);
  });

  it("returns short content unchanged when it fits within the byte budget", () => {
    writeFileSync(join(root, "AGENTS.md"), "abc", "utf8");
    const scope = resolveRepoInstructions(root, REPO_INSTRUCTIONS_BYTE_BUDGET);
    expect(scope.truncated).toBe(false);
    expect(scope.content).toContain("abc");
  });

  it("stops before a section header it cannot fit, rather than emitting a headerless fragment", () => {
    // Budget admits AGENTS.md's section but exhausts before CLAUDE.md's header
    // fits — the loop must break cleanly and report truncation, never push a
    // source path whose content was not actually included.
    writeFileSync(join(root, "AGENTS.md"), "a".repeat(40), "utf8");
    writeFileSync(join(root, "CLAUDE.md"), "c".repeat(40), "utf8");
    const scope = resolveRepoInstructions(root, 60);
    expect(scope.truncated).toBe(true);
    expect(scope.content).not.toContain("ccc");
    // Only the section actually emitted is claimed as a source.
    expect(scope.source_paths.length).toBeLessThan(2);
  });

  it("does not truncate when content fits well within the default budget", () => {
    writeFileSync(join(root, "AGENTS.md"), "short", "utf8");
    const scope = resolveRepoInstructions(root);
    expect(scope.truncated).toBe(false);
    expect(Buffer.byteLength(scope.content, "utf-8")).toBeLessThan(REPO_INSTRUCTIONS_BYTE_BUDGET);
  });
});
