import { describe, expect, it } from "vitest";
import { skillPatternCoveredBy } from "../src/skills/catalog.js";
import { composeNativeRole, defaultNativeRoleFor } from "../src/native-role-composer.js";

const approved = { tag: "critic_approved" as const, critic: "lenticel", rationale: "scope reviewed" };

describe("composeNativeRole", () => {
  it("intersects role authority with host ports and fails closed on documentation writes without path enforcement", () => {
    const composition = composeNativeRole({
      role_id: "documentation-writer",
      task: "refresh the operator guide",
      available_tools: ["repository.search", "file.read", "file.write", "file.patch", "shell.execute"],
      governed_instructions: [{ instruction_id: "style", text: "Use concise prose.", provenance: approved }],
    });

    expect(composition.profile).toMatchObject({ role_id: "documentation-writer", allowed_tools: ["repository.search", "file.read"] });
    expect(composition.profile.allowed_tools).not.toContain("file.write");
    expect(composition.governed_context.instructions).toEqual([{ instruction_id: "style", text: "Use concise prose.", provenance: approved }]);
    expect(composition.documentation_writes_admitted).toBe(false);
  });

  it("admits documentation writes only when the composition root declares host path enforcement", () => {
    const composition = composeNativeRole({
      role_id: "documentation-writer",
      task: "refresh the operator guide",
      available_tools: ["file.read", "file.write", "file.patch"],
      documentation_path_policy_enforced: true,
    });

    expect(composition.profile.allowed_tools).toEqual(["file.read", "file.write", "file.patch"]);
    expect(composition.documentation_writes_admitted).toBe(true);
  });

  it("retains host-admitted write tools for the general Specialist profile", () => {
    const composition = composeNativeRole({
      role_id: "specialist-executor",
      task: "create the admitted implementation file",
      available_tools: ["file.read", "file.write", "file.patch"],
    });

    expect(composition.profile.allowed_tools).toEqual(["file.read", "file.write", "file.patch"]);
    expect(composition.documentation_writes_admitted).toBe(false);
  });

  it("maps ordinary campaign turns to least-authority defaults while retaining explicit clean-room modes", () => {
    expect(defaultNativeRoleFor({ operation: "review", agent: "lenticel" })).toBe("critic-reviewer");
    expect(defaultNativeRoleFor({ operation: "specialize", agent: "taproot" })).toBe("architect");
    expect(defaultNativeRoleFor({ operation: "specialize", agent: "documentation-writer" })).toBe("documentation-writer");
    expect(defaultNativeRoleFor({ operation: "specialize", agent: "seed" })).toBe("specialist-executor");
  });

  it("ADR-persona-authority-mapping-fails-closed: maps every read-only botanical agent to critic-reviewer for a specialize turn, never the write-capable specialist-executor default", () => {
    // opencode's own permissions.ts grants Heartwood/Seed full edit+write and
    // documents Lenticel/Burl/Xylem/Rhizome/Mycelium/Stoma as "read-only.
    // Cannot edit, cannot delegate." for the identical botanical name — the
    // native-role mapping must agree with that grant, not exceed it.
    expect(defaultNativeRoleFor({ operation: "specialize", agent: "heartwood" })).toBe("specialist-executor");
    for (const readOnlyAgent of ["lenticel", "burl", "xylem", "rhizome", "mycelium", "stoma"]) {
      expect(defaultNativeRoleFor({ operation: "specialize", agent: readOnlyAgent })).toBe("critic-reviewer");
    }
  });

  it("ADR-persona-authority-mapping-fails-closed: throws rather than silently granting write/shell authority for an agent it does not recognize", () => {
    // Crown/Cambium are orchestrators that never write code (agents.ts's own
    // DESCRIPTIONS) and are never a valid `specialize` delegate; a typo'd or
    // wholly unknown persona name must fail the same way, not fall through
    // to the most permissive profile.
    for (const unrecognized of ["crown", "cambium", "burll", "", "specialist-executor", "critic-reviewer"]) {
      expect(() => defaultNativeRoleFor({ operation: "specialize", agent: unrecognized })).toThrow(
        /no native role authority is defined/,
      );
    }
    // `review` stays total and safe regardless of agent — every critic turn
    // resolves to the read-only reviewer profile unconditionally.
    expect(defaultNativeRoleFor({ operation: "review", agent: "not-a-real-agent" })).toBe("critic-reviewer");
  });

  it("admits a host-composed specialist extension without giving the planning, documentation, or critic roles that escape hatch", () => {
    const specialist = composeNativeRole({
      role_id: "specialist-executor", task: "run the supplied verifier", available_tools: ["file.read", "task.verifier"],
      permitted_extension_tools: ["task.verifier", "not-hosted"],
    });
    const architect = composeNativeRole({
      role_id: "architect", task: "plan", available_tools: ["file.read", "task.verifier"],
      permitted_extension_tools: ["task.verifier"],
    });

    expect(specialist.profile.allowed_tools).toEqual(["file.read", "task.verifier"]);
    expect(architect.profile.allowed_tools).toEqual(["file.read"]);
  });

  it("intersects role, skill, and host tools and treats an injected overreach as no authority", () => {
    const reduced = composeNativeRole({ role_id: "specialist-executor", task: "test", available_tools: ["file.read", "file.write", "shell.execute"], permitted_extension_tools: ["file.read", "file.write", "shell.execute"], skill_allowed_tools: ["file.read", "file.write"], skill_write_path_patterns: ["packages/**/*.test.ts"] });
    const overreach = composeNativeRole({ role_id: "specialist-executor", task: "test", available_tools: ["file.read", "critic.approve"], permitted_extension_tools: ["critic.approve"], skill_allowed_tools: ["critic.approve"] });
    expect(reduced.profile.allowed_tools).toEqual(["file.read", "file.write"]); expect(reduced.effective_write_path_patterns).toEqual(["packages/**/*.test.ts"]);
    expect(overreach.profile.allowed_tools).toEqual([]);
  });

  it("preserves the reduction property for every subset of a fixed role/host universe", () => {
    const universe = ["file.read", "file.write", "shell.execute"];
    for (let hostMask = 0; hostMask < 8; hostMask += 1) for (let skillMask = 0; skillMask < 8; skillMask += 1) {
      const host = universe.filter((_, index) => (hostMask & (1 << index)) !== 0); const skill = universe.filter((_, index) => (skillMask & (1 << index)) !== 0);
      const composed = composeNativeRole({ role_id: "specialist-executor", task: "property", available_tools: host, skill_allowed_tools: skill });
      expect(composed.profile.allowed_tools.every((tool) => host.includes(tool) && skill.includes(tool))).toBe(true);
    }
  });

  it("preserves the reduction property for write-path patterns: a skill never adds a pattern the role would not already admit", () => {
    const universe = ["docs/**/*.md", "docs/guide.md", "packages/**/*.ts", "src/escape.md", "docs/../escape.md"];
    for (let mask = 0; mask < 1 << universe.length; mask += 1) {
      const skill = universe.filter((_, index) => (mask & (1 << index)) !== 0);
      // Documentation roles have a fixed path ceiling: every surviving pattern is covered by it.
      const ceiling = composeNativeRole({ role_id: "documentation-writer", task: "property", available_tools: ["file.read", "file.write"], documentation_path_policy_enforced: true });
      const docs = composeNativeRole({ role_id: "documentation-writer", task: "property", available_tools: ["file.read", "file.write"], documentation_path_policy_enforced: true, skill_write_path_patterns: skill });
      expect(docs.effective_write_path_patterns.every((pattern) => skill.includes(pattern))).toBe(true);
      expect(docs.effective_write_path_patterns.every((pattern) => ceiling.effective_write_path_patterns.some((parent) => skillPatternCoveredBy(pattern, parent)))).toBe(true);
      // Specialists: the skill list is the whole declaration, never extended with anything else.
      const specialist = composeNativeRole({ role_id: "specialist-executor", task: "property", available_tools: ["file.read", "file.write"], skill_write_path_patterns: skill });
      expect(specialist.effective_write_path_patterns).toEqual(skill);
    }
  });

  it("an empty skill write list removes every write pattern rather than falling back to the role default", () => {
    const docs = composeNativeRole({ role_id: "documentation-writer", task: "property", available_tools: ["file.write"], documentation_path_policy_enforced: true, skill_write_path_patterns: [] });
    expect(docs.effective_write_path_patterns).toEqual([]);
  });

  it("rechecks forged skill tool and write declarations against the role ceiling at composition", () => {
    const composed = composeNativeRole({
      role_id: "documentation-writer", task: "edit governed docs",
      available_tools: ["file.read", "file.write", "critic.approve"],
      permitted_extension_tools: ["critic.approve"],
      documentation_path_policy_enforced: true,
      // Deliberately bypass SkillCatalog's descriptor validator to exercise
      // the actual runtime boundary with a forged in-process skill object.
      skill_allowed_tools: ["file.write", "critic.approve"],
      skill_write_path_patterns: ["packages/**/*.ts"],
    });

    expect(composed.profile.allowed_tools).toEqual(["file.write"]);
    expect(composed.profile.allowed_tools).not.toContain("critic.approve");
    expect(composed.effective_write_path_patterns).toEqual([]);
  });
});
