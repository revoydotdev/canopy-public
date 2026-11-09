import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SKILL_MAX_TURN_BUDGET, SkillCatalog, SkillCatalogError, skillPatternMatches } from "../../src/skills/catalog.js";

const descriptor = (overrides: Record<string, unknown> = {}) => ({
  schema_version: 1, skill_id: "add-test", version: "1.2.0", role: "specialist-executor",
  instruction: "Add the smallest relevant regression test.", allowed_tools: ["file.read", "file.write"],
  write_path_patterns: ["packages/**/*.test.ts"], structured_output: null, ...overrides,
});
const bytes = (value: unknown): string => JSON.stringify(value);

describe("SkillCatalog", () => {
  it("loads a valid frozen descriptor from the governed directory", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-skills-")); const directory = join(root, ".arbor", "skills"); mkdirSync(directory, { recursive: true });
    try {
      writeFileSync(join(directory, "add-test@1.2.0.json"), bytes(descriptor()));
      const catalog = SkillCatalog.fromDirectory(directory); const skill = catalog.resolve("add-test", "1.2.0");
      expect(skill).toMatchObject({ skill_id: "add-test", version: "1.2.0", role: "specialist-executor" }); expect(Object.isFrozen(skill)).toBe(true); expect(catalog.diagnostics()).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ["tool_escalation", { allowed_tools: ["critic.approve"] }],
    ["path_escalation", { role: "documentation-writer", allowed_tools: ["file.read"], write_path_patterns: ["packages/**/*.ts"] }],
    ["version", { version: "01.2.0" }],
    ["role", { role: "oracle" }],
    ["role", { role: "__proto__" }],
    ["contract", { structured_output: "arbitrary.schema" }],
    ["contract", { inputs: ["bad-name"] }],
    ["contract", { max_turns: 65 }],
  ])("rejects %s descriptors with a typed error", (code, override) => {
    const catalog = new SkillCatalog();
    try { catalog.register(bytes(descriptor(override))); throw new Error("expected validation failure"); }
    catch (error) { expect(error).toBeInstanceOf(SkillCatalogError); expect((error as SkillCatalogError).code).toBe(code); }
  });

  it("treats changed bytes for one immutable identity as a conflict", () => {
    const catalog = new SkillCatalog(); catalog.register(bytes(descriptor()));
    expect(() => catalog.register(bytes(descriptor({ instruction: "Changed without a version bump." })))).toThrowError(expect.objectContaining({ code: "immutable_conflict" }));
    expect(() => catalog.register(bytes(descriptor({ instruction: "Replacement without a plugin owner." })), "in-memory.json", undefined, undefined, true)).toThrowError(expect.objectContaining({ code: "immutable_conflict" }));
  });

  it("freezes declared input names and a bounded reduction-only turn budget", () => {
    const serialized = bytes(descriptor({ inputs: ["target_path"], max_turns: 3 }));
    const skill = new SkillCatalog().register(serialized);
    expect(skill.inputs).toEqual(["target_path"]);
    expect(Object.isFrozen(skill.inputs)).toBe(true);
    expect(skill.max_turns).toBe(3);
    expect(skill.descriptor_hash).toBe(createHash("sha256").update(serialized).digest("hex"));
  });

  it("admits exactly the turn budgets in [1, SKILL_MAX_TURN_BUDGET] and rejects everything outside as a contract error", () => {
    for (const ok of [1, 2, SKILL_MAX_TURN_BUDGET]) expect(new SkillCatalog().register(bytes(descriptor({ max_turns: ok }))).max_turns).toBe(ok);
    for (const bad of [0, -1, 1.5, SKILL_MAX_TURN_BUDGET + 1, Number.MAX_SAFE_INTEGER, "3", null]) {
      expect(() => new SkillCatalog().register(bytes(descriptor({ max_turns: bad })))).toThrowError(expect.objectContaining({ code: "contract" }));
    }
  });

  it("fails closed when plugin activation throws while preserving unrelated skills", () => {
    const catalog = new SkillCatalog();
    catalog.register(bytes(descriptor({ skill_id: "broken-plugin" })), "broken-plugin@1.2.0.json", () => { throw new Error("plugin activation unavailable"); }, "broken-plugin");
    catalog.register(bytes(descriptor({ skill_id: "local-skill" })), "local-skill@1.2.0.json");

    expect(catalog.resolve("broken-plugin", "1.2.0")).toBeNull();
    expect(catalog.list().map((skill) => skill.skill_id)).toEqual(["local-skill"]);
    expect(catalog.diagnostics()).toMatchObject([{ source: "broken-plugin@1.2.0", code: "malformed", message: "plugin activation unavailable" }]);
  });

  it("captures malformed governed files as bounded diagnostics and exposes no skill", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-skills-bad-")); const directory = join(root, ".arbor", "skills"); mkdirSync(directory, { recursive: true });
    try {
      writeFileSync(join(directory, "broken@1.0.0.json"), "{not-json"); const catalog = SkillCatalog.fromDirectory(directory);
      expect(catalog.list()).toEqual([]); expect(catalog.diagnostics()).toMatchObject([{ source: "broken@1.0.0.json", code: "malformed" }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("matches bounded glob patterns without admitting traversal", () => {
    expect(skillPatternMatches("packages/**/*.test.ts", "packages/arbor-mcp/tests/catalog.test.ts")).toBe(true);
    expect(skillPatternMatches("packages/**/*.test.ts", "src/escape.test.ts")).toBe(false);
    expect(skillPatternMatches("packages/**/*.test.ts", "packages/../escape.test.ts")).toBe(false);
  });
});
