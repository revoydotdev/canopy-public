import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { AUDIT_TEMPLATES, renderArchetypeSkill, skillPath } from "@arbor/prompts";
import { auditCommand } from "../src/audit-command.js";
import { EXIT_CODES } from "../src/exit-codes.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

function environment(): {
  env: { cwd: string; stdout: { write(t: string): void }; stderr: { write(t: string): void } };
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    env: { cwd: REPO_ROOT, stdout: { write: (t) => { out.push(t); } }, stderr: { write: (t) => { err.push(t); } } },
    out,
    err,
  };
}

describe("arbor-mcp audit — the operator surface for fan-out templates", () => {
  it("lists every shipped template", () => {
    const { env, out } = environment();
    expect(auditCommand(["list"], env)).toBe(EXIT_CODES.SUCCESS);
    for (const template of AUDIT_TEMPLATES) expect(out.join("")).toContain(template.id);
  });

  it("describes a template's fan, lenses and tooling", () => {
    const { env, out } = environment();
    expect(auditCommand(["show", "forensic-four"], env)).toBe(EXIT_CODES.SUCCESS);
    const text = out.join("");
    expect(text).toContain("Fan width: 1 x 4");
    expect(text).toContain("Constitutional and Contract Auditor");
    expect(text).toContain("Runtime, Data, and Evidence Auditor");
    // Tool availability is surfaced, so an operator can see how much of a
    // lens's instrumentation actually exists before dispatching it.
    expect(text).toMatch(/tools\s+: \d+ available, \d+ proposed/);
  });

  it("renders a dispatch prompt for a named archetype", () => {
    const { env, out } = environment();
    expect(auditCommand(["prompt", "forensic-four", "resilience"], env)).toBe(EXIT_CODES.SUCCESS);
    expect(out.join("")).toContain("Agent 3 of 4: State, Time, and Resilience Auditor");
  });

  it("treats unknown templates, archetypes and actions as USAGE, never FAILURE", () => {
    // A mistyped invocation is the caller's error, not a crash. Conflating
    // them is the collapse the exit-code registry exists to prevent.
    const { env } = environment();
    expect(auditCommand([], env)).toBe(EXIT_CODES.USAGE);
    expect(auditCommand(["frobnicate"], env)).toBe(EXIT_CODES.USAGE);
    expect(auditCommand(["show", "no-such-template"], env)).toBe(EXIT_CODES.USAGE);
    expect(auditCommand(["prompt", "forensic-four", "no-such-archetype"], env)).toBe(EXIT_CODES.USAGE);
    expect(auditCommand(["prompt", "no-such-template", "structural"], env)).toBe(EXIT_CODES.USAGE);
  });
});

describe("generated SKILL.md files stay in sync with their source", () => {
  it("every archetype's skill exists on disk", () => {
    for (const template of AUDIT_TEMPLATES) {
      for (const archetype of template.archetypes) {
        const path = resolve(REPO_ROOT, skillPath(template, archetype));
        expect(existsSync(path), `missing ${skillPath(template, archetype)}`).toBe(true);
      }
    }
  });

  it("the checked-in bytes match a fresh render, exactly", () => {
    // Claude Code reads skills from disk and cannot call a renderer, so these
    // are generated artifacts committed to the repo. A generated artifact
    // whose regeneration is not diff-checked is just a copy that has not
    // drifted yet — this is the check that keeps it honest.
    for (const template of AUDIT_TEMPLATES) {
      for (const archetype of template.archetypes) {
        const relative = skillPath(template, archetype);
        const onDisk = readFileSync(resolve(REPO_ROOT, relative), "utf8");
        expect(onDisk, `${relative} is stale — run \`arbor-mcp audit sync\``)
          .toBe(renderArchetypeSkill(template, archetype.id));
      }
    }
  });

  it("`audit sync --check` reports success when the files match", () => {
    const { env, out } = environment();
    expect(auditCommand(["sync", "--check"], env)).toBe(EXIT_CODES.SUCCESS);
    expect(out.join("")).toContain("match their source");
  });

  it("`audit sync --check` is a real gate: it returns VIOLATION when a file is missing", () => {
    // Pointed at a directory with no generated skills, every file "differs".
    // A drift check that only ever passes would be decoration.
    const out: string[] = [];
    const err: string[] = [];
    const code = auditCommand(["sync", "--check"], {
      cwd: resolve(REPO_ROOT, "packages"),
      stdout: { write: (t) => { out.push(t); } },
      stderr: { write: (t) => { err.push(t); } },
    });
    expect(code).toBe(EXIT_CODES.VIOLATION);
    expect(err.join("")).toContain("differ from their source");
    expect(err.join("")).toContain("audit sync");
  });
});
