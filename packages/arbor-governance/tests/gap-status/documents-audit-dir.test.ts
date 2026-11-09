import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveGapStatusScanDocuments, GAP_REGISTER_DOCUMENT } from "../../src/gap-status/documents.js";

/**
 * documents-audit-dir.test.ts — Roadmap 23 B2's acceptance test for
 * gap-status/documents.ts's `"audit"` literal. Following the precedent set
 * by commit 169f6699 for `ROADMAP.md`/`audit/10-gap-register.md` (revoy2's
 * own numbered-audit convention, not a `source_roots`-shaped structural
 * fact), this becomes a plain option — `auditDir` — defaulting to today's
 * literal, rather than a `source_roots` consumer or a new profile field.
 */

let tmpRoot: string | null = null;

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  }
});

function buildFixtureRepo(auditDirName: string): string {
  const root = mkdtempSync(join(tmpdir(), "arbor-governance-gap-status-audit-dir-"));
  const auditDir = join(root, auditDirName);
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(join(auditDir, "01-report.md"), "# Report one\n");
  writeFileSync(join(auditDir, "02-report.md"), "# Report two\n");
  writeFileSync(join(auditDir, "notes.txt"), "not markdown, excluded\n");
  return root;
}

describe("deriveGapStatusScanDocuments — audit dir portability (Roadmap 23 B2)", () => {
  it("with auditDir omitted, a fixture using a differently-named audit directory reports NO audit documents — the defect this option closes", () => {
    tmpRoot = buildFixtureRepo("reports");
    const docs = deriveGapStatusScanDocuments(tmpRoot);
    expect(docs).toEqual([GAP_REGISTER_DOCUMENT, "docs/release-readiness.md"]);
  });

  it("with auditDir: 'reports', the fixture's *.md reports are enumerated, sorted, and non-markdown files excluded", () => {
    tmpRoot = buildFixtureRepo("reports");
    const docs = deriveGapStatusScanDocuments(tmpRoot, { auditDir: "reports" });
    expect(docs).toEqual([GAP_REGISTER_DOCUMENT, "docs/release-readiness.md", "reports/01-report.md", "reports/02-report.md"]);
  });

  it("defaults to revoy2's own 'audit' directory when the option is omitted (real repo)", () => {
    const docs = deriveGapStatusScanDocuments(process.cwd());
    expect(docs.every((d) => !d.startsWith("audit/") || d.endsWith(".md"))).toBe(true);
    expect(docs.some((d) => d.startsWith("audit/"))).toBe(true);
  });
});
