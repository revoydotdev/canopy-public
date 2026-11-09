import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SKILL_MAX_BUNDLE_BYTES,
  SKILL_MAX_BUNDLE_FILES,
  SkillCatalog,
} from "../../src/skills/catalog.js";

const roots: string[] = [];

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function fixture(files: Readonly<Record<string, string>> = {
  "SKILL.md": "---\nname: paper\ndescription: Research safely\n---\n\nRoute through the relevant station. token=hidden-value\n",
  "references/code.md": "Supporting reference that is loaded only on demand.",
}, overrides: Readonly<Record<string, unknown>> = {}): { readonly root: string; readonly skills: string; readonly bundle: string; readonly descriptor: Record<string, unknown> } {
  const root = mkdtempSync(join(tmpdir(), "arbor-skill-bundle-"));
  roots.push(root);
  const skills = join(root, ".arbor", "skills");
  const bundle = join(root, ".claude", "skills", "paper");
  mkdirSync(skills, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const target = join(bundle, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  const descriptor = {
    schema_version: 1,
    skill_id: "paper",
    version: "1.0.0",
    role: "specialist-executor",
    bundle: ".claude/skills/paper",
    bundle_files: Object.entries(files).map(([path, content]) => ({ path, sha256: sha256(content) })),
    allowed_tools: ["file.read"],
    write_path_patterns: [],
    structured_output: null,
    ...overrides,
  };
  return { root, skills, bundle, descriptor };
}

function load(input: ReturnType<typeof fixture>): SkillCatalog {
  writeFileSync(join(input.skills, "paper@1.0.0.json"), JSON.stringify(input.descriptor));
  return SkillCatalog.fromDirectory(input.skills);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SkillCatalog bundle descriptors (ADR-150)", () => {
  it("composes only the redacted SKILL.md body and records every governed file hash", () => {
    const input = fixture();
    const catalog = load(input);
    const skill = catalog.resolve("paper", "1.0.0");

    expect(catalog.diagnostics()).toEqual([]);
    expect(skill).toMatchObject({
      bundle: ".claude/skills/paper",
      allowed_tools: ["file.read"],
      bundle_files: [
        { path: "references/code.md", sha256: sha256("Supporting reference that is loaded only on demand.") },
        { path: "SKILL.md", sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) },
      ],
    });
    expect(skill?.instruction).toContain("Route through the relevant station.");
    expect(skill?.instruction).not.toContain("name: paper");
    expect(skill?.instruction).not.toContain("hidden-value");
    expect(skill?.instruction).toContain("token=[REDACTED]");
    expect(skill?.instruction).not.toContain("Supporting reference");
    expect(Object.isFrozen(skill?.bundle_files)).toBe(true);
  });

  it("fails closed when a governed bundle file changes after catalog admission", () => {
    const input = fixture();
    const catalog = load(input);
    expect(catalog.resolve("paper", "1.0.0")).not.toBeNull();

    writeFileSync(join(input.bundle, "references", "code.md"), "Changed after descriptor admission.");

    expect(catalog.resolve("paper", "1.0.0")).toBeNull();
    expect(catalog.list()).toEqual([]);
    expect(catalog.diagnostics()).toMatchObject([{ source: "paper@1.0.0", code: "bundle_integrity" }]);
  });

  it.each([
    ["tool_escalation", { allowed_tools: ["critic.approve"] }],
    ["path_escalation", { role: "documentation-writer", allowed_tools: ["file.read"], write_path_patterns: ["packages/**/*.ts"] }],
  ])("applies the unchanged %s authority reduction in bundle mode", (code, override) => {
    const catalog = load(fixture(undefined, override));
    expect(catalog.resolve("paper", "1.0.0")).toBeNull();
    expect(catalog.diagnostics()).toMatchObject([{ code }]);
  });

  it.each([
    ["bundle_identity", { bundle: ".claude/skills/not-paper" }],
    ["bundle_traversal", { bundle: "../paper" }],
    ["bundle_missing", { bundle_files: [{ path: "references/code.md", sha256: sha256("Supporting reference that is loaded only on demand.") }] }],
    ["bundle_integrity", { bundle_files: [{ path: "SKILL.md", sha256: `sha256:${"0".repeat(64)}` }, { path: "references/code.md", sha256: sha256("Supporting reference that is loaded only on demand.") }] }],
  ])("reports %s with a dedicated bundle diagnostic", (code, override) => {
    const catalog = load(fixture(undefined, override));
    expect(catalog.resolve("paper", "1.0.0")).toBeNull();
    expect(catalog.diagnostics()).toMatchObject([{ code }]);
  });

  it("refuses a missing bundle directory and a symlink before reading either", () => {
    const missing = fixture();
    rmSync(missing.bundle, { recursive: true, force: true });
    expect(load(missing).diagnostics()).toMatchObject([{ code: "bundle_missing" }]);

    const linked = fixture();
    const target = join(linked.root, "outside.md");
    writeFileSync(target, "outside");
    symlinkSync(target, join(linked.bundle, "linked.md"));
    linked.descriptor.bundle_files = [
      ...(linked.descriptor.bundle_files as Array<Record<string, unknown>>),
      { path: "linked.md", sha256: sha256("outside") },
    ];
    expect(load(linked).diagnostics()).toMatchObject([{ code: "bundle_symlink" }]);
  });

  it("enforces both file-count and total-byte ceilings", () => {
    const tooMany = Object.fromEntries(Array.from({ length: SKILL_MAX_BUNDLE_FILES + 1 }, (_, index) => [index === 0 ? "SKILL.md" : `references/${index}.md`, "x"]));
    expect(load(fixture(tooMany)).diagnostics()).toMatchObject([{ code: "bundle_bound" }]);

    const tooLarge = fixture({ "SKILL.md": "x".repeat(SKILL_MAX_BUNDLE_BYTES + 1) });
    expect(load(tooLarge).diagnostics()).toMatchObject([{ code: "bundle_bound" }]);
  });

  it("keeps inline and bundle bodies mutually exclusive", () => {
    const input = fixture();
    input.descriptor.instruction = "ambiguous";
    expect(load(input).diagnostics()).toMatchObject([{ code: "malformed" }]);
  });
});
