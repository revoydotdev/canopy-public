/**
 * packages/arbor-mcp/tests/project-registry.test.ts — Roadmap 23 W2,
 * ADR-076's six binding requirements, proven one test per requirement
 * against real temp-directory fixtures (no mocks — matching this repo's
 * `project-conform-root.test.mjs` convention that a mocked filesystem
 * cannot prove a gate is wired to reality).
 *
 * Fixtures are real, git-backed, freshly-scaffolded projects built with
 * `enrollProject(dir, { mode: "new" })` — the same mechanism Roadmap 23 W4
 * already proved produces a conformant project
 * (`scripts/tests/project-conform-enrollment.test.mjs`). This suite reuses
 * that guarantee rather than re-deriving it. Since Roadmap 23 §6 L2,
 * `enrollProject(dir, { mode: "new" })` itself `git init`s and makes the
 * initial commit for a target it scaffolds from nothing (see
 * `ensureNewProjectGitRepo` in `project-lifecycle.ts`), so fixtures get a
 * real, non-synthesized `verified_at_revision` for free — this suite no
 * longer git-inits fixtures itself.
 */

import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { enrollProject } from "../src/project-lifecycle.js";
import {
  computeProfileHash,
  evaluateProjectRegistry,
  loadProjectRegistry,
  registerProject,
  resolveProjectRevision,
  runConformanceCheck,
  verifyRegistryEntry,
} from "../src/project-registry.js";

/** A real, freshly-scaffolded, git-backed, conformant project. `enrollProject`
 * itself performs the `git init` + initial commit for a `--new` scaffold
 * (Roadmap 23 §6 L2), so no manual git setup is needed here. */
function buildFixtureProject(): string {
  const dir = mktempFixtureDir();
  enrollProject(dir, { mode: "new" });
  return dir;
}

function mktempFixtureDir(): string {
  return mkdtempSync(join(tmpdir(), "project-registry-fixture-"));
}

function mkTempPersistenceDir(): string {
  return mkdtempSync(join(tmpdir(), "project-registry-persistence-"));
}

describe("project-registry — fixture sanity", () => {
  it("a freshly-scaffolded --new project is conformant and has a real revision", () => {
    const dir = buildFixtureProject();
    try {
      const conformance = runConformanceCheck(dir);
      expect(conformance.ok).toBe(true);
      expect(conformance.reasons).toEqual([]);
      expect(resolveProjectRevision(dir)).toMatch(/^[0-9a-f]{40}$/);
      expect(computeProfileHash(dir)).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ADR-076 requirement 6 — a registry with zero entries passes", () => {
  it("an empty/absent registry evaluates ok with zero entries", () => {
    const persistenceDir = mkTempPersistenceDir();
    try {
      const registry = loadProjectRegistry(persistenceDir);
      expect(registry.entries).toEqual([]);
      const report = evaluateProjectRegistry(persistenceDir);
      expect(report.ok).toBe(true);
      expect(report.entry_count).toBe(0);
      expect(report.verifications).toEqual([]);
    } finally {
      rmSync(persistenceDir, { recursive: true, force: true });
    }
  });

  it("Roadmap 23 §6 L1 — distinguishes an absent registry file from one that legitimately holds zero entries", () => {
    // No `project-registry.json` was ever written under this persistence
    // dir (the fresh-clone / CI-runner state, since `.arbor/` is
    // gitignored): `present` must be false even though `entry_count` is 0
    // in both cases.
    const absentDir = mkTempPersistenceDir();
    try {
      expect(existsSync(join(absentDir, "project-registry.json"))).toBe(false);
      const absentReport = evaluateProjectRegistry(absentDir);
      expect(absentReport.entry_count).toBe(0);
      expect(absentReport.present).toBe(false);
      expect(absentReport.ok).toBe(true); // still a vacuous pass — see the field's own doc comment for why `ok` does not change

      // Registering and then de-registering (by writing an explicit empty
      // registry file) is a DIFFERENT state: the operator's tooling has
      // touched this persistence dir, and zero is a real count, not an
      // absence.
      writeFileSync(join(absentDir, "project-registry.json"), `${JSON.stringify({ schema_version: 1, entries: [] }, null, 2)}\n`);
      const presentEmptyReport = evaluateProjectRegistry(absentDir);
      expect(presentEmptyReport.entry_count).toBe(0);
      expect(presentEmptyReport.present).toBe(true);
      expect(presentEmptyReport.ok).toBe(true);
    } finally {
      rmSync(absentDir, { recursive: true, force: true });
    }
  });
});

describe("a registered, conformant, in-date project passes", () => {
  it("registerProject establishes discharge and evaluateProjectRegistry passes immediately", () => {
    const projectDir = buildFixtureProject();
    const persistenceDir = mkTempPersistenceDir();
    try {
      const outcome = registerProject(persistenceDir, projectDir, "fixture-project");
      expect(outcome.registered).toBe(true);
      expect(outcome.reasons).toEqual([]);
      expect(outcome.entry?.project_id).toBe("fixture-project");
      expect(outcome.entry?.path).toBe(projectDir);

      const report = evaluateProjectRegistry(persistenceDir);
      expect(report.ok).toBe(true);
      expect(report.entry_count).toBe(1);
      expect(report.verifications[0].ok).toBe(true);
      expect(report.verifications[0].failures).toEqual([]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(persistenceDir, { recursive: true, force: true });
    }
  });

  it("ADR-076 requirement 1 — the entry records an assertion, never 'conformant' as a standing property", () => {
    const projectDir = buildFixtureProject();
    const persistenceDir = mkTempPersistenceDir();
    try {
      const outcome = registerProject(persistenceDir, projectDir, "fixture-project");
      const entry = outcome.entry!;
      expect(Object.keys(entry).sort()).toEqual(
        ["expires", "path", "profile_hash", "project_id", "verified_at", "verified_at_revision"].sort(),
      );
      expect(entry).not.toHaveProperty("conformant");
      expect(entry).not.toHaveProperty("ok");
      expect(entry).not.toHaveProperty("status");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(persistenceDir, { recursive: true, force: true });
    }
  });
});

describe("ADR-076 requirement 2 — discharge is a re-run, not a read", () => {
  it("verifyRegistryEntry re-executes project-conform against the live path rather than trusting the stored claim", () => {
    const projectDir = buildFixtureProject();
    const persistenceDir = mkTempPersistenceDir();
    try {
      const outcome = registerProject(persistenceDir, projectDir, "fixture-project");
      // Break the project's ACTUAL conformance after registration by deleting
      // a required element the entry has no way to know about (it only
      // stores a profile hash, not a full checklist snapshot).
      rmSync(join(projectDir, "decisions", "registry.json"));

      const verification = verifyRegistryEntry(outcome.entry!);
      expect(verification.ok).toBe(false);
      expect(verification.failures.some((f) => f.code === "conformance_failed")).toBe(true);
      expect(verification.failures.find((f) => f.code === "conformance_failed")?.detail).toContain("decisions-registry");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(persistenceDir, { recursive: true, force: true });
    }
  });
});

describe("ADR-076 requirement 3 — an expired entry fails the gate", () => {
  it("fails even though the underlying project remains fully conformant", () => {
    const projectDir = buildFixtureProject();
    const persistenceDir = mkTempPersistenceDir();
    try {
      const outcome = registerProject(persistenceDir, projectDir, "fixture-project");
      expect(outcome.registered).toBe(true);
      // The project itself is untouched and still conformant — only the
      // clock has moved past the entry's expiry.
      const verification = verifyRegistryEntry(outcome.entry!, { now: "2099-01-01T00:00:00.000Z" });
      expect(verification.ok).toBe(false);
      expect(verification.failures).toEqual([{ code: "expired", detail: expect.stringContaining("expired") }]);
      expect(runConformanceCheck(projectDir).ok).toBe(true);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(persistenceDir, { recursive: true, force: true });
    }
  });
});

describe("ADR-076 requirement 4 — a drifted profile_hash is a failure, not an auto-update", () => {
  it("fails discharge and never rewrites the stored hash", () => {
    const projectDir = buildFixtureProject();
    const persistenceDir = mkTempPersistenceDir();
    try {
      const outcome = registerProject(persistenceDir, projectDir, "fixture-project");
      const originalHash = outcome.entry!.profile_hash;

      // Drift the profile after registration.
      const profilePath = join(projectDir, "arbor.profile.jsonc");
      writeFileSync(profilePath, `${readFileSync(profilePath, "utf8")}\n// drifted\n`);

      const verification = verifyRegistryEntry(outcome.entry!);
      expect(verification.ok).toBe(false);
      expect(verification.failures.some((f) => f.code === "profile_drifted")).toBe(true);

      // Re-running verification (which is all a gate ever does) must not
      // have silently rewritten the persisted entry to the new hash.
      const reloaded = loadProjectRegistry(persistenceDir);
      expect(reloaded.entries[0].profile_hash).toBe(originalHash);
      expect(reloaded.entries[0].profile_hash).not.toBe(computeProfileHash(projectDir));
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(persistenceDir, { recursive: true, force: true });
    }
  });
});

describe("ADR-076 requirement 5 — an unreachable path is reported and fails, never pruned", () => {
  it("fails discharge and the entry is still present afterward", () => {
    const projectDir = buildFixtureProject();
    const persistenceDir = mkTempPersistenceDir();
    try {
      const outcome = registerProject(persistenceDir, projectDir, "fixture-project");
      expect(outcome.registered).toBe(true);

      // The registered path vanishes (project deleted, moved, or a bad disk).
      rmSync(projectDir, { recursive: true, force: true });
      expect(existsSync(projectDir)).toBe(false);

      const report = evaluateProjectRegistry(persistenceDir);
      expect(report.ok).toBe(false);
      expect(report.entry_count).toBe(1);
      expect(report.verifications[0].ok).toBe(false);
      expect(report.verifications[0].failures).toEqual([
        { code: "path_unreachable", detail: expect.stringContaining(projectDir) },
      ]);

      // Never silently pruned: the entry is exactly as present as before.
      const reloaded = loadProjectRegistry(persistenceDir);
      expect(reloaded.entries).toHaveLength(1);
      expect(reloaded.entries[0].path).toBe(projectDir);
    } finally {
      rmSync(persistenceDir, { recursive: true, force: true });
    }
  });
});

describe("registerProject refuses rather than fabricates", () => {
  it("refuses when there is no arbor.profile.jsonc to hash", () => {
    const dir = mktempFixtureDir();
    const persistenceDir = mkTempPersistenceDir();
    try {
      const outcome = registerProject(persistenceDir, dir, "no-profile");
      expect(outcome.registered).toBe(false);
      expect(outcome.entry).toBeNull();
      expect(outcome.reasons[0]).toMatch(/arbor\.profile\.jsonc/);
      expect(loadProjectRegistry(persistenceDir).entries).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(persistenceDir, { recursive: true, force: true });
    }
  });

  it("refuses when the project has no git revision to attribute the claim to", () => {
    // Since Roadmap 23 §6 L2, `enrollProject(dir, { mode: "new" })` itself
    // `git init`s a target it scaffolds from nothing, so that path no
    // longer reaches `registerProject` without a revision on the normal
    // happy path. The refusal this test proves is still real: a project
    // that is conformant (profile plus everything it declares) but is not,
    // or is no longer, a git repository must not have provenance
    // fabricated for it. Simulated here by scaffolding a real conformant
    // fixture and then removing `.git` — everything conformance checks stays
    // real; only the revision becomes unresolvable.
    const dir = buildFixtureProject();
    const persistenceDir = mkTempPersistenceDir();
    try {
      rmSync(join(dir, ".git"), { recursive: true, force: true });
      expect(existsSync(join(dir, "arbor.profile.jsonc"))).toBe(true);
      expect(resolveProjectRevision(dir)).toBeNull();
      expect(runConformanceCheck(dir).ok).toBe(true);

      const outcome = registerProject(persistenceDir, dir, "ungitted-project");
      expect(outcome.registered).toBe(false);
      expect(outcome.refusal).toBe("no_revision");
      expect(outcome.reasons[0]).toMatch(/git revision/);
      expect(loadProjectRegistry(persistenceDir).entries).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(persistenceDir, { recursive: true, force: true });
    }
  });

  it("--new git-inits and commits a target it scaffolds from nothing, so registration succeeds", () => {
    const dir = mktempFixtureDir();
    const persistenceDir = mkTempPersistenceDir();
    try {
      enrollProject(dir, { mode: "new" });
      expect(existsSync(join(dir, "arbor.profile.jsonc"))).toBe(true);
      expect(existsSync(join(dir, ".git"))).toBe(true);
      expect(resolveProjectRevision(dir)).toMatch(/^[0-9a-f]{40}$/);

      const outcome = registerProject(persistenceDir, dir, "freshly-scaffolded-project");
      expect(outcome.registered).toBe(true);
      expect(outcome.entry).not.toBeNull();
      expect(loadProjectRegistry(persistenceDir).entries).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(persistenceDir, { recursive: true, force: true });
    }
  });

  it("re-registering (upsert by project_id) is the explicit re-enrollment act that clears drift", () => {
    const projectDir = buildFixtureProject();
    const persistenceDir = mkTempPersistenceDir();
    try {
      const first = registerProject(persistenceDir, projectDir, "fixture-project");
      const profilePath = join(projectDir, "arbor.profile.jsonc");
      writeFileSync(profilePath, `${readFileSync(profilePath, "utf8")}\n// drifted\n`);
      expect(verifyRegistryEntry(first.entry!).ok).toBe(false);

      // Explicit re-registration, not the gate, is what may update the hash.
      const second = registerProject(persistenceDir, projectDir, "fixture-project");
      expect(second.registered).toBe(true);
      expect(second.entry!.profile_hash).not.toBe(first.entry!.profile_hash);
      expect(second.entry!.profile_hash).toBe(computeProfileHash(projectDir));

      const reloaded = loadProjectRegistry(persistenceDir);
      expect(reloaded.entries).toHaveLength(1);
      expect(verifyRegistryEntry(reloaded.entries[0]).ok).toBe(true);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(persistenceDir, { recursive: true, force: true });
    }
  });
});
