import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrollProject, inspectProjectOverlay, repairProjectOverlay } from "../src/project-lifecycle.js";

describe("project enrollment lifecycle", () => {
  it("previews and idempotently enrolls without creating credentials", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-enroll-"));
    try {
      const preview = enrollProject(root, { dry_run: true, now: "2026-08-13T00:00:00.000Z" });
      expect(preview.changes.some((item) => item.disposition === "would_create")).toBe(true);
      expect(existsSync(join(root, ".arbor"))).toBe(false);

      const applied = enrollProject(root, { now: "2026-08-13T00:00:00.000Z" });
      expect(applied.inspection.state).toBe("ready");
      expect(existsSync(join(root, ".env"))).toBe(false);
      expect(readFileSync(join(root, ".arbor", "project.json"), "utf8")).not.toMatch(/api.?key|token|secret/i);

      const repeated = enrollProject(root);
      // The overlay itself is fully idempotent ("preserved"). The temp dir
      // used here is not a git repo, so profile derivation legitimately and
      // idempotently refuses on every call — "refused" is the stable,
      // repeatable outcome for a target this under-specified, not a
      // regression. See project-lifecycle-profile.test.ts for the cases
      // where a profile is actually derived or scaffolded.
      expect(repeated.changes.every((item) => item.disposition === "preserved" || item.disposition === "refused")).toBe(true);
      expect(repeated.profile.disposition).toBe("refused");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("detects and repairs missing overlay structure while preserving policy", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-repair-"));
    try {
      enrollProject(root);
      rmSync(join(root, ".arbor", "skills"), { recursive: true });
      writeFileSync(join(root, "arbor.jsonc"), "operator-owned", "utf8");
      expect(inspectProjectOverlay(root).state).toBe("incomplete");
      expect(repairProjectOverlay(root).dry_run).toBe(true);
      expect(existsSync(join(root, ".arbor", "skills"))).toBe(false);
      expect(repairProjectOverlay(root, true).inspection.state).toBe("ready");
      expect(readFileSync(join(root, "arbor.jsonc"), "utf8")).toBe("operator-owned");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reconciles a moved root and refuses malformed manifests", () => {
    const parent = mkdtempSync(join(tmpdir(), "arbor-move-"));
    const original = join(parent, "old");
    const moved = join(parent, "new");
    try {
      mkdirSync(original);
      enrollProject(original);
      renameSync(original, moved);
      expect(inspectProjectOverlay(moved).state).toBe("moved");
      expect(repairProjectOverlay(moved, true).inspection.state).toBe("ready");
      writeFileSync(join(moved, ".arbor", "project.json"), "{}", "utf8");
      expect(inspectProjectOverlay(moved).state).toBe("invalid");
      expect(() => repairProjectOverlay(moved, true)).toThrow(/invalid and was not modified/i);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it("creates a new project only when new mode is explicit", () => {
    const parent = mkdtempSync(join(tmpdir(), "arbor-new-"));
    const root = join(parent, "product");
    try {
      expect(() => enrollProject(root)).toThrow(/Use --new/);
      expect(enrollProject(root, { mode: "new" }).inspection.state).toBe("ready");
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it("does not treat files at required directory paths as a healthy overlay", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-shape-"));
    try {
      enrollProject(root);
      rmSync(join(root, ".arbor", "skills"), { recursive: true });
      writeFileSync(join(root, ".arbor", "skills"), "not a directory", "utf8");
      const inspected = inspectProjectOverlay(root);
      expect(inspected.state).toBe("incomplete");
      expect(inspected.findings.find((item) => item.path.endsWith("/skills"))?.repairable).toBe(false);
      expect(() => repairProjectOverlay(root, true)).toThrow(/not a directory/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
