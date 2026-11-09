import { describe, it, expect } from "vitest";
import {
  resolveEnvironmentSnapshot, parseGitStatusPorcelain, formatEnvironmentSnapshot, ENVIRONMENT_CONTEXT_BYTE_BUDGET,
} from "../src/environment-context.js";

// ADR-103: `resolveEnvironmentSnapshot` shells to git through an injectable
// `runGitStatus` seam. Tests drive that fake exclusively — never the real
// repository's git — so assertions stay deterministic under this repo's own
// operating condition (ADR-078: several agents committing into one checkout
// concurrently). Contract §3: no test here reads REPO_ROOT or the live
// checkout's actual git state.

describe("parseGitStatusPorcelain", () => {
  it("parses a clean branch with no upstream", () => {
    const snapshot = parseGitStatusPorcelain("## main\n");
    expect(snapshot).toEqual({ branch: "main", head: "main", dirty: false, ahead_behind: null });
  });

  it("parses a dirty working tree", () => {
    const snapshot = parseGitStatusPorcelain("## main\n M src/foo.ts\n?? new-file.ts\n");
    expect(snapshot.dirty).toBe(true);
    expect(snapshot.branch).toBe("main");
  });

  it("parses ahead/behind against an upstream", () => {
    const snapshot = parseGitStatusPorcelain("## feature...origin/feature [ahead 2, behind 1]\n");
    expect(snapshot).toEqual({ branch: "feature", head: "feature", dirty: false, ahead_behind: { ahead: 2, behind: 1 } });
  });

  it("parses ahead-only", () => {
    const snapshot = parseGitStatusPorcelain("## feature...origin/feature [ahead 3]\n");
    expect(snapshot.ahead_behind).toEqual({ ahead: 3, behind: 0 });
  });

  it("parses behind-only", () => {
    const snapshot = parseGitStatusPorcelain("## feature...origin/feature [behind 4]\n");
    expect(snapshot.ahead_behind).toEqual({ ahead: 0, behind: 4 });
  });

  it("parses a tracked branch with no divergence as null ahead_behind", () => {
    const snapshot = parseGitStatusPorcelain("## feature...origin/feature\n");
    expect(snapshot).toEqual({ branch: "feature", head: "feature", dirty: false, ahead_behind: null });
  });

  it("parses detached HEAD as branch: null, head: 'HEAD'", () => {
    const snapshot = parseGitStatusPorcelain("## HEAD (no branch)\n M src/foo.ts\n");
    expect(snapshot).toEqual({ branch: null, head: "HEAD", dirty: true, ahead_behind: null });
  });

  it("parses an unborn branch (no commits yet)", () => {
    const snapshot = parseGitStatusPorcelain("## No commits yet on main\n");
    expect(snapshot).toEqual({ branch: "main", head: null, dirty: false, ahead_behind: null });
  });

  it("degrades to all-null/false on unparseable output rather than throwing", () => {
    const snapshot = parseGitStatusPorcelain("not a porcelain header\n");
    expect(snapshot).toEqual({ branch: null, head: null, dirty: false, ahead_behind: null });
  });
});

describe("resolveEnvironmentSnapshot — ADR-103", () => {
  it("composes cwd, platform, date, and git from an injected runner", () => {
    const fixedNow = new Date("2026-08-26T12:00:00.000Z");
    const snapshot = resolveEnvironmentSnapshot("/some/worktree", {
      runGitStatus: () => "## main...origin/main\n",
      now: () => fixedNow,
    });
    expect(snapshot.cwd).toBe("/some/worktree");
    expect(snapshot.platform).toBe(process.platform);
    expect(snapshot.date).toBe("2026-08-26T12:00:00.000Z");
    expect(snapshot.observed_at).toBe("2026-08-26T12:00:00.000Z");
    expect(snapshot.git).toEqual({ branch: "main", head: "main", dirty: false, ahead_behind: null });
  });

  it("resolves git: null — never a thrown error — when the injected runner reports failure", () => {
    const snapshot = resolveEnvironmentSnapshot("/some/worktree", { runGitStatus: () => null });
    expect(snapshot.git).toBeNull();
  });

  it("resolves git: null when the injected runner throws (simulated timeout/missing binary)", () => {
    const snapshot = resolveEnvironmentSnapshot("/some/worktree", {
      runGitStatus: () => {
        throw new Error("simulated ETIMEDOUT");
      },
    });
    expect(snapshot.git).toBeNull();
  });

  it("resolves call-time, not cached: two calls with different injected clocks produce different observed_at", () => {
    const first = resolveEnvironmentSnapshot("/wt", { runGitStatus: () => "## main\n", now: () => new Date("2026-08-26T10:00:00.000Z") });
    const second = resolveEnvironmentSnapshot("/wt", { runGitStatus: () => "## main\n", now: () => new Date("2026-08-26T10:05:00.000Z") });
    expect(first.observed_at).not.toBe(second.observed_at);
  });

  it("reflects a git status change between two calls — no stale cached snapshot reused", () => {
    let call = 0;
    const runGitStatus = () => (call++ === 0 ? "## main\n" : "## main\n M dirtied-by-a-concurrent-session.ts\n");
    const first = resolveEnvironmentSnapshot("/wt", { runGitStatus });
    const second = resolveEnvironmentSnapshot("/wt", { runGitStatus });
    expect(first.git?.dirty).toBe(false);
    expect(second.git?.dirty).toBe(true);
  });
});

describe("formatEnvironmentSnapshot — ADR-103 staleness honesty", () => {
  const snapshot = resolveEnvironmentSnapshot("/wt", {
    runGitStatus: () => "## main...origin/main [ahead 1]\n M dirty.ts\n",
    now: () => new Date("2026-08-26T09:30:00.000Z"),
  });

  it("always includes the observed_at provenance timestamp", () => {
    const rendered = formatEnvironmentSnapshot(snapshot);
    expect(rendered).toContain("Environment observed at 2026-08-26T09:30:00.000Z");
    expect(rendered).toContain("may be stale if the repository has changed since");
  });

  it("renders a failed git read as explicitly absent, not silently omitted", () => {
    const failed = resolveEnvironmentSnapshot("/wt", { runGitStatus: () => null, now: () => new Date("2026-08-26T09:30:00.000Z") });
    const rendered = formatEnvironmentSnapshot(failed);
    expect(rendered).toContain("git: (unavailable");
    expect(rendered).not.toContain("branch=");
  });

  it("renders resolved git fields inline", () => {
    const rendered = formatEnvironmentSnapshot(snapshot);
    expect(rendered).toContain("branch=main");
    expect(rendered).toContain("dirty=true");
    expect(rendered).toContain("ahead 1, behind 0");
  });

  it("truncates deterministically at the byte budget rather than blowing past it", () => {
    const rendered = formatEnvironmentSnapshot(snapshot, 40);
    expect(Buffer.byteLength(rendered, "utf-8")).toBeLessThanOrEqual(40 + 60);
    expect(rendered).toContain("truncated");
  });

  it("rejects a non-positive or non-integer byte budget rather than misbehaving silently", () => {
    expect(() => formatEnvironmentSnapshot(snapshot, 0)).toThrow(/positive integer/);
    expect(() => formatEnvironmentSnapshot(snapshot, -1)).toThrow(/positive integer/);
    expect(() => formatEnvironmentSnapshot(snapshot, 1.5)).toThrow(/positive integer/);
  });

  it("does not truncate when content fits well within the default budget", () => {
    const rendered = formatEnvironmentSnapshot(snapshot);
    expect(rendered).not.toContain("truncated");
    expect(Buffer.byteLength(rendered, "utf-8")).toBeLessThan(ENVIRONMENT_CONTEXT_BYTE_BUDGET);
  });
});

describe("git rendering edges that must not fabricate a value", () => {
  it("renders a detached head as explicitly unknown rather than inventing a branch", () => {
    const snapshot = resolveEnvironmentSnapshot("/tmp/does-not-matter", {
      now: () => new Date("2026-08-26T00:00:00.000Z"),
      runGitStatus: () => "## HEAD (no branch)\n M src/foo.ts\n",
    });
    const rendered = formatEnvironmentSnapshot(snapshot);
    expect(rendered).toContain("(detached or unknown)");
    expect(rendered).toContain("dirty=true");
  });

  it("yields a null branch when the porcelain header carries only an upstream segment", () => {
    const snapshot = parseGitStatusPorcelain("## ...origin/main\n");
    expect(snapshot.branch).toBeNull();
    expect(snapshot.head).toBeNull();
    expect(formatEnvironmentSnapshot({
      cwd: "/w", platform: "linux", date: "2026-08-26", observed_at: "2026-08-26T00:00:00.000Z", git: snapshot,
    })).toContain("(detached or unknown)");
  });
})
