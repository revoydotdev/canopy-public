import { describe, expect, it } from "vitest";
import { composeRolePrompt, nativeRoleProfile, resolveEnvironmentSnapshot } from "../src/index.js";

const verified = { tag: "verified" as const, cmd: "bun test", exit: 0, stdout_hash: "sha256:fixture" };
const approved = { tag: "critic_approved" as const, critic: "lenticel", rationale: "scope reviewed" };

describe("revoy-native role profiles", () => {
  it("makes Architect a planning-only, self-non-approving authority bundle", () => {
    const profile = nativeRoleProfile("architect");
    expect(profile).toMatchObject({ role_id: "architect", phase: "planning", self_approval_forbidden: true });
    expect(profile.tool_policy.implementation_writes_forbidden).toBe(true);
    expect(profile.tool_policy.documentation_path_patterns).toContain("docs/**/*.md");
  });

  it("composes scoped instructions and provenance-bearing evidence without treating them as campaign evidence", () => {
    const composed = composeRolePrompt({
      role_id: "architect",
      task: "plan the migration",
      repo_instructions: { source_paths: ["/worktree/AGENTS.md"], content: "Run the narrow test before the full suite.", truncated: false },
      context_evidence: [{ evidence_id: "user-1", kind: "user_request", content: "Migrate without a behavior change.", provenance: approved }],
      governed_instructions: [{ instruction_id: "scope-1", text: "Do not alter public APIs.", provenance: approved }],
      governed_artifacts: [{ artifact_id: "test-1", media_type: "text/plain", content: "Existing suite passes.", provenance: verified }],
    });

    expect(composed.prompt).toContain("PLANNING, not implementation");
    expect(composed.prompt).toContain("Scoped repository instructions (read-only context; not campaign evidence)");
    expect(composed.prompt).toContain("[user-1] user_request; provenance=critic_approved");
    expect(composed.prompt).toContain("[scope-1] provenance=critic_approved");
    expect(composed.prompt).toContain("[test-1] text/plain; provenance=verified");
    expect(composed.prompt).toContain("cite IDs");
  });

  it("gives Documentation Writer source-validation and uncertainty obligations while forbidding implementation work", () => {
    const composed = composeRolePrompt({
      role_id: "documentation-writer",
      task: "document the native session lifecycle",
      context_evidence: [{ evidence_id: "source-1", kind: "repository_fact", content: "The session engine has terminal inspection.", provenance: verified }],
    });

    expect(composed.profile.phase).toBe("execution");
    expect(composed.prompt).toContain("testable projection of current behavior");
    expect(composed.prompt).toContain("cite its evidence ID or mark it unknown");
    expect(composed.prompt).toContain("Reconcile conflicts");
    expect(composed.prompt).toContain("Never change implementation code");
  });

  it("gives execution roles a bounded-turn working discipline that biases toward acting, not endless exploration", () => {
    for (const role_id of ["architect", "documentation-writer", "specialist-executor"] as const) {
      const composed = composeRolePrompt({ role_id, task: "do the task" });
      expect(composed.prompt).toContain("bounded turn budget");
      expect(composed.prompt).toContain("Do the work with your tools");
    }
    // The critic reviews rather than acts; it must not inherit the act-first discipline.
    expect(composeRolePrompt({ role_id: "critic-reviewer", task: "review" }).prompt).not.toContain("bounded turn budget");
  });

  it("holds both the executor writing a check and the critic judging it to the same oracle-authoring rules", () => {
    const executor = composeRolePrompt({ role_id: "specialist-executor", task: "implement and verify" }).prompt;
    const critic = composeRolePrompt({ role_id: "critic-reviewer", task: "review" }).prompt;
    for (const prompt of [executor, critic]) {
      expect(prompt).toContain("proves only the oracle it actually declares");
      expect(prompt).toContain("independently of the implementation under test");
      expect(prompt).toContain("negative control");
      expect(prompt).toContain("not evidence by itself");
    }
  });

  it("rejects duplicate or provenance-free caller context instead of silently composing ambiguous authority", () => {
    const duplicate = [{ evidence_id: "same", kind: "user_request" as const, content: "one", provenance: approved }, { evidence_id: "same", kind: "user_request" as const, content: "two", provenance: approved }];
    expect(() => composeRolePrompt({ role_id: "architect", task: "plan", context_evidence: duplicate })).toThrow("duplicate context evidence_id");
    expect(() => composeRolePrompt({ role_id: "architect", task: "plan", context_evidence: [{ evidence_id: "bad", kind: "user_request", content: "unsupported", provenance: {} as never }] })).toThrow("context provenance is required");
  });

  // ADR-103 wired call-time-resolved environment (cwd/platform/date/git
  // status) into the opencode agent path only. These cases close that gap
  // for the native path (ADR-099 made native the default): an injected git
  // runner keeps this deterministic and off the live repository, per the
  // contract's ADR-078 note (no test here drives the real checkout's git).
  it("renders no environment block when the caller supplies none, matching repo_instructions' opt-in shape", () => {
    const composed = composeRolePrompt({ role_id: "architect", task: "plan the migration" });
    expect(composed.prompt).not.toContain("Environment (observed at composition time");
  });

  it("renders the resolved environment snapshot -- cwd, platform, observed_at provenance -- when the caller supplies one", () => {
    const environment = resolveEnvironmentSnapshot("/workspace/fixture-worktree", {
      runGitStatus: () => "## main...origin/main\n M packages/arbor-prompts/src/role-profiles.ts\n",
      now: () => new Date("2026-08-26T12:00:00.000Z"),
    });
    const composed = composeRolePrompt({ role_id: "specialist-executor", task: "implement the change", environment });

    expect(composed.prompt).toContain("Environment (observed at composition time — context only, may be stale)");
    expect(composed.prompt).toContain("cwd: /workspace/fixture-worktree");
    expect(composed.prompt).toContain(`platform: ${process.platform}`);
    expect(composed.prompt).toContain("branch=main");
    expect(composed.prompt).toContain("dirty=true");
    expect(composed.prompt).toContain("Environment observed at 2026-08-26T12:00:00.000Z");
  });

  it("renders a failed git read as explicitly absent, never a silently omitted or stale-reused block", () => {
    const environment = resolveEnvironmentSnapshot("/workspace/no-git", {
      runGitStatus: () => null,
      now: () => new Date("2026-08-26T12:00:00.000Z"),
    });
    const composed = composeRolePrompt({ role_id: "critic-reviewer", task: "review", environment });
    expect(composed.prompt).toContain("git: (unavailable — git status failed, timed out, or this is not a repository)");
  });
});
