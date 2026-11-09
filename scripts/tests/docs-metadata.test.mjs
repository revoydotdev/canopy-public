import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { validateFiles } from "../docs-metadata.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TEMP = mkdtempSync(join(tmpdir(), "docs-metadata-"));
afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

function write(relativePath, content) {
  const path = join(TEMP, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return relativePath;
}

function header(overrides = {}) {
  const fields = {
    "Artifact kind": "roadmap",
    Status: "active",
    Revision: "1",
    "As-of commit": "4dee3523a38a4fc0cdb8ece02c14332ed735c155 (2026-09-22)",
    Authority: "Defines release sequencing.",
    "Evidence scope": "mixed — current corpus observation and target intent",
    Supersedes: "none",
    "Superseded by": "none",
    Owner: "maintainers",
    "Review trigger": "release candidate",
    ...overrides,
  };
  return `# Test artifact\n\n${Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n")}\n\nBody.\n`;
}

describe("durable artifact metadata", () => {
  it("accepts the documented header, ordered fields, local links, and a date-tagged revision", () => {
    write("docs/linked.md", "# Linked target\n");
    const file = write("docs/roadmap.md", `${header()}\nSee [the linked target](linked.md#linked-target).\n`);
    const report = validateFiles(TEMP, [file]);
    expect(report.issues).toEqual([]);
    expect(report.classified).toBe(1);
  });

  it("reports duplicate kind fields, malformed metadata, unsupported status, and unresolved links", () => {
    const file = write("bad.md", [
      "# Broken artifact",
      "Artifact kind: roadmap",
      "Artifact kind: audit",
      "Status: complete",
      "Revision 2",
      "As-of commit: not-a-revision",
      "Authority:",
      "Evidence scope: observed",
      "Supersedes: none",
      "Superseded by: [missing](absent.md)",
      "Owner: maintainers",
      "Review trigger: release",
      "",
    ].join("\n"));
    const report = validateFiles(TEMP, [file]);
    const codes = report.issues.map((issue) => issue.code);
    expect(codes).toContain("duplicate-kind");
    expect(codes).toContain("unknown-status");
    expect(codes).toContain("malformed-header-line");
    expect(codes).toContain("unresolved-local-link");
    expect(codes).toContain("invalid-revision-id");
  });

  it("keeps unclassified legacy Markdown distinct from malformed metadata and can require classification", () => {
    const file = write("legacy.md", "# Historical note\n\nNo durable metadata yet.\n");
    expect(validateFiles(TEMP, [file]).issues).toEqual([]);
    expect(validateFiles(TEMP, [file], { requireHeaders: true }).issues.map((issue) => issue.code)).toEqual(["unclassified-artifact"]);
  });

  it("excludes the handoff template from classification even when headers are required", () => {
    const template = write("docs/roadmaps/handoffs/TEMPLATE.md", "# Roadmap handoff template\n\nBranch: `feature/<slug>`\n");
    const other = write("docs/roadmaps/handoffs/real.md", "# Real handoff\n\nBranch: `feature/x`\n");
    const report = validateFiles(TEMP, ["docs/roadmaps/handoffs"], { requireHeaders: true });
    expect(report.results.map((result) => result.path)).toEqual([other]);
    expect(report.issues.map((issue) => issue.path)).toEqual([other]);
    expect(validateFiles(TEMP, [template], { requireHeaders: true })).toMatchObject({ files: 0, issues: [] });
  });

  it("checks the actual canonical planning set without asserting that legacy files are already classified", () => {
    const report = validateFiles(REPO_ROOT, [
      "docs/roadmap-1.0.0-and-documentation-governance.md",
      "ROADMAP.md",
      "docs/roadmaps",
    ]);
    expect(report.classified).toBeGreaterThan(0);
    expect(report.issues).toEqual([]);
  });
});
