import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  loadProjectProfile,
  profileOrDefaults,
  validateProfile,
  DEFAULT_PROFILE,
  ProjectProfileError,
} from "../lib/project-profile.mjs";

const dirs = [];
function tempRepo() {
  const root = mkdtempSync(join(tmpdir(), "arbor-profile-"));
  dirs.push(root);
  return root;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe("profileOrDefaults — never throws (the non-negotiable back-compat seam)", () => {
  it("returns DEFAULT_PROFILE for a repo with no arbor.profile.jsonc at all", () => {
    const root = tempRepo();
    expect(profileOrDefaults(root)).toEqual(DEFAULT_PROFILE);
  });

  it("returns DEFAULT_PROFILE for a repo whose profile file is invalid JSONC", () => {
    const root = tempRepo();
    writeFileSync(join(root, "arbor.profile.jsonc"), "{ not: valid json");
    expect(profileOrDefaults(root)).toEqual(DEFAULT_PROFILE);
  });

  it("returns DEFAULT_PROFILE for a repo whose profile fails validation", () => {
    const root = tempRepo();
    writeFileSync(join(root, "arbor.profile.jsonc"), JSON.stringify({ source_roots: "not-an-array" }));
    expect(profileOrDefaults(root)).toEqual(DEFAULT_PROFILE);
  });

  it("never throws even when the repo path itself does not exist", () => {
    expect(() => profileOrDefaults(join(tmpdir(), "arbor-profile-does-not-exist-at-all"))).not.toThrow();
  });
});

describe("loadProjectProfile — strict loader", () => {
  it("throws a structured ProjectProfileError when the file is missing", () => {
    const root = tempRepo();
    try {
      loadProjectProfile(root);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectProfileError);
      expect(error.errors).toEqual([{ path: "arbor.profile.jsonc", message: "file does not exist" }]);
    }
  });

  it("throws a structured error (not a bare string) on invalid JSONC", () => {
    const root = tempRepo();
    writeFileSync(join(root, "arbor.profile.jsonc"), "{ broken");
    try {
      loadProjectProfile(root);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectProfileError);
      expect(Array.isArray(error.errors)).toBe(true);
      expect(error.errors[0].path).toBe("arbor.profile.jsonc");
    }
  });

  it("strips // line comments, /* block */ comments, and trailing commas", () => {
    const root = tempRepo();
    writeFileSync(
      root + "/arbor.profile.jsonc",
      `{
        // a line comment
        "project_id": "demo", /* inline block */
        "source_roots": ["src",], // trailing comma
      }`,
    );
    const profile = loadProjectProfile(root);
    expect(profile.project_id).toBe("demo");
    expect(profile.source_roots).toEqual(["src"]);
  });

  it("merges a partial profile against documented defaults per-field, not all-or-nothing", () => {
    const root = tempRepo();
    writeFileSync(join(root, "arbor.profile.jsonc"), JSON.stringify({ project_id: "demo" }));
    const profile = loadProjectProfile(root);
    expect(profile.project_id).toBe("demo");
    expect(profile.source_roots).toEqual(DEFAULT_PROFILE.source_roots);
    expect(profile.governance).toEqual(DEFAULT_PROFILE.governance);
  });

  it("returns a frozen (and deeply frozen) profile", () => {
    const root = tempRepo();
    writeFileSync(join(root, "arbor.profile.jsonc"), JSON.stringify({ project_id: "demo" }));
    const profile = loadProjectProfile(root);
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.governance)).toBe(true);
    expect(Object.isFrozen(profile.source_roots)).toBe(true);
  });

  it("loads this repository's real arbor.profile.jsonc", () => {
    const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const profile = loadProjectProfile(repoRoot);
    expect(profile.project_id).toBe("revoy2");
    expect(profile.source_roots).toEqual(["packages"]);
  });
});

describe("validateProfile — structured errors, not thrown strings", () => {
  it("returns an empty array for a valid profile", () => {
    expect(validateProfile({ project_id: "demo" })).toEqual([]);
  });

  it("reports schema_version other than 1", () => {
    const errors = validateProfile({ schema_version: 2 });
    expect(errors).toContainEqual({ path: "schema_version", message: expect.stringContaining("must be 1") });
  });

  it("reports a non-array source_roots with its path, not a thrown string", () => {
    const errors = validateProfile({ source_roots: "packages" });
    expect(errors.some((e) => e.path === "source_roots")).toBe(true);
  });

  it("reports an empty source_roots array as invalid", () => {
    const errors = validateProfile({ source_roots: [] });
    expect(errors.some((e) => e.path === "source_roots")).toBe(true);
  });

  it("reports a non-string commands value with its dotted path", () => {
    const errors = validateProfile({ commands: { typecheck: 123 } });
    expect(errors).toContainEqual({ path: "commands.typecheck", message: expect.any(String) });
  });

  it("reports a non-object top-level value", () => {
    expect(validateProfile(null)[0].path).toBe("$");
    expect(validateProfile([1, 2])[0].path).toBe("$");
  });
});
