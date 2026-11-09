import { describe, expect, it } from "vitest";
import { crownPrompt, seedPrompt, stomaPrompt, resolveEnvironmentSnapshot } from "../src/index.js";
import type { ArborEnvironmentSnapshot } from "../src/index.js";

// ADR-103, O1/O3 roundtrip: `environmentBlock` is the sibling of
// `repoInstructionsBlock` in the real `PromptContext` render path every
// prompt function calls — and unlike `repoInstructionsBlock` (root/plan
// level only), it renders at every depth, including a leaf (Seed) and a
// read-only consultant (Stoma). The snapshot here is hand-built rather than
// resolved from the live checkout's git, per contract §3 — this test proves
// rendering behaviour, not git plumbing (see environment-context.test.ts for
// that, driven entirely through an injected runner).

const SNAPSHOT: ArborEnvironmentSnapshot = {
  cwd: "/worktrees/campaign-42",
  platform: "linux",
  date: "2026-08-26T08:00:00.000Z",
  git: { branch: "codex/queue-cleanup", head: "codex/queue-cleanup", dirty: true, ahead_behind: { ahead: 1, behind: 0 } },
  observed_at: "2026-08-26T08:00:00.000Z",
};

const GIT_UNAVAILABLE_SNAPSHOT: ArborEnvironmentSnapshot = {
  cwd: "/worktrees/campaign-42",
  platform: "linux",
  date: "2026-08-26T08:05:00.000Z",
  git: null,
  observed_at: "2026-08-26T08:05:00.000Z",
};

describe("environment block — ADR-103", () => {
  it("is absent when no environment snapshot is provided", () => {
    expect(crownPrompt()).not.toContain("<environment");
  });

  it("frames the environment block as non-authoritative context, mirroring foreground/repo-instructions", () => {
    const prompt = crownPrompt({ environment: SNAPSHOT });
    expect(prompt).toContain('<environment instruction-authority="context-only">');
  });

  it("renders for a root/plan-level prompt (Crown)", () => {
    const prompt = crownPrompt({ environment: SNAPSHOT });
    expect(prompt).toContain("cwd: /worktrees/campaign-42");
    expect(prompt).toContain("branch=codex/queue-cleanup");
  });

  it("renders for a leaf prompt too (Seed) — unlike repoInstructionsBlock, environment is not root-only", () => {
    const prompt = seedPrompt({ environment: SNAPSHOT });
    expect(prompt).toContain('<environment instruction-authority="context-only">');
    expect(prompt).toContain("cwd: /worktrees/campaign-42");
  });

  it("renders for a prompt with no taskDescription/foreground plumbing at all (Stoma)", () => {
    const prompt = stomaPrompt({ environment: SNAPSHOT });
    expect(prompt).toContain('<environment instruction-authority="context-only">');
  });

  it("always states its own observed_at provenance inline — staleness is declared, not implicit", () => {
    const prompt = crownPrompt({ environment: SNAPSHOT });
    expect(prompt).toContain("Environment observed at 2026-08-26T08:00:00.000Z");
    expect(prompt).toContain("may be stale if the repository has changed since");
  });

  it("renders a failed git read as explicitly absent, never a silently-reused prior snapshot", () => {
    const prompt = crownPrompt({ environment: GIT_UNAVAILABLE_SNAPSHOT });
    expect(prompt).toContain("git: (unavailable");
    expect(prompt).not.toContain("branch=codex/queue-cleanup");
  });

  it("roundtrips through the real resolveEnvironmentSnapshot seam (injected runner, no live-checkout git)", () => {
    const snapshot = resolveEnvironmentSnapshot("/worktrees/roundtrip", {
      runGitStatus: () => "## main\n",
      now: () => new Date("2026-08-26T08:10:00.000Z"),
    });
    const prompt = crownPrompt({ environment: snapshot });
    expect(prompt).toContain("cwd: /worktrees/roundtrip");
    expect(prompt).toContain("Environment observed at 2026-08-26T08:10:00.000Z");
  });
});
