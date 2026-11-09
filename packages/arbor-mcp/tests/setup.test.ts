import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { setupProject } from "../src/setup.js";
import { loadProjectEnvironment } from "../src/project-env.js";

describe("project setup", () => {
  it("previews, creates, and then preserves local config without writing secrets", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-setup-"));
    try {
      expect(setupProject(root, true).files.map((file) => file.disposition)).toEqual(["would_create", "would_create"]);
      expect(setupProject(root).files.map((file) => file.disposition)).toEqual(["created", "created"]);
      const env = readFileSync(join(resolvePersistence(root), ".env"), "utf8");
      expect(env).toContain("OPENROUTER_API_KEY");
      expect(env).not.toMatch(/OPENROUTER_API_KEY=\S+/);
      writeFileSync(join(root, "arbor.jsonc"), "operator-owned", "utf8");
      expect(setupProject(root).files.map((file) => file.disposition)).toEqual(["preserved", "preserved"]);
      expect(readFileSync(join(root, "arbor.jsonc"), "utf8")).toBe("operator-owned");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // CD-E-24. The signing-secret exposure is separately recorded as RESIDUAL (mode 0o600,
  // re-verified on load) and is deliberately not "fixed" here. The defect is that `arbor setup`
  // materialised the project `.env` at the REPO ROOT — the one secret sink outside the
  // persistence containment guard every other campaign write goes through.
  it("contains the .env sink inside the resolved persistence root, never at the repo root", () => {
    const repo = mkdtempSync(join(tmpdir(), "arbor-setup-contain-"));
    try {
      const persistence = resolvePersistence(repo, "campaigns/persist");
      const result = setupProject(repo, false, persistence);
      const env = result.files.find((file) => file.path.endsWith(".env"))!;

      // The sink is inside the persistence root...
      expect(env.path).toBe(join(persistence, ".env"));
      expect(relative(resolve(repo), resolve(env.path)).startsWith("..")).toBe(false);
      expect(existsSync(env.path)).toBe(true);
      // ...and NOT at the repo root, which is the CD-E-24 defect.
      expect(existsSync(join(repo, ".env"))).toBe(false);
      // The sink keeps the 0o600 mode it always had.
      expect(statSync(env.path).mode & 0o777).toBe(0o600);

      // `arbor.jsonc` deliberately stays at the project root: loader.ts reads <dir>/arbor.jsonc.
      // Only the SECRET moves. Asserting it, because moving it would break config loading.
      expect(result.files.find((file) => file.path.endsWith("arbor.jsonc"))!.path).toBe(join(repo, "arbor.jsonc"));

      // A file nobody reads is the "persisted nothing" defect. The reader must follow the
      // writer, so drive the real round trip: what setup writes is what the loader consumes.
      writeFileSync(env.path, "ARBOR_NATIVE_API_KEY=contained\n", "utf8");
      const target: NodeJS.ProcessEnv = {};
      expect(loadProjectEnvironment(repo, target, persistence).path).toBe(env.path);
      expect(target.ARBOR_NATIVE_API_KEY).toBe("contained");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  // The contained sink must not orphan an operator who already has a repo-root .env with a
  // real key in it. Silently preferring the empty new template would drop that credential.
  it("still honours a pre-existing repo-root .env so containment is not silent data loss", () => {
    const repo = mkdtempSync(join(tmpdir(), "arbor-setup-legacy-"));
    try {
      const persistence = resolvePersistence(repo);
      writeFileSync(join(repo, ".env"), "ARBOR_NATIVE_API_KEY=legacy-operator-key\n", "utf8");
      const target: NodeJS.ProcessEnv = {};
      const result = loadProjectEnvironment(repo, target, persistence);
      expect(result.path).toBe(join(repo, ".env"));
      expect(target.ARBOR_NATIVE_API_KEY).toBe("legacy-operator-key");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

/** The persistence root the product resolves: `resolvePersistenceDir(cwd, configured)`. */
function resolvePersistence(cwd: string, configured?: string): string {
  return resolve(cwd, configured ?? ".arbor");
}
