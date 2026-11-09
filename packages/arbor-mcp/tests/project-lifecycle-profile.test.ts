/**
 * packages/arbor-mcp/tests/project-lifecycle-profile.test.ts — Roadmap 23 W4:
 * closes the split brain between the enrollment surface
 * (`project-lifecycle.ts`) and ADR-073's conformance surface
 * (`scripts/project-conform.mjs`) described in
 * docs/roadmaps/23-multi-project-enrollment.md §2.5.
 *
 * These tests exercise `enrollProject`'s new profile derivation directly
 * (in-process, real temp directories — no mocks). The end-to-end acceptance
 * test (a real subprocess CLI invocation followed by a real
 * `project-conform.mjs --root` run) lives in
 * scripts/tests/project-conform-enrollment.test.mjs, which is the one that
 * actually proves the split brain is closed rather than merely proving this
 * module's internal wiring.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { enrollProject } from "../src/project-lifecycle.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function gitInit(root: string): void {
  execSync("git init -q", { cwd: root });
}

describe("enrollProject profile derivation (Roadmap 23 W4)", () => {
  it("--new scaffolds a full arbor.profile.jsonc plus package.json wiring, decisions corpus, and AGENTS.md marker", () => {
    const parent = tmp("arbor-profile-new-");
    const root = join(parent, "fresh");
    try {
      const result = enrollProject(root, { mode: "new" });
      expect(result.profile.disposition).toBe("created");
      expect(result.profile.refusals).toEqual([]);

      const profile = JSON.parse(readFileSync(join(root, "arbor.profile.jsonc"), "utf8").replace(/^\/\/.*\n/gm, ""));
      expect(profile.source_roots).toEqual(["src"]);
      expect(profile.commands).toEqual({ typecheck: "typecheck", test: "test", reachability: "gate:reachability" });
      expect(profile.language).toBeUndefined(); // omitted, never fabricated

      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      for (const script of ["typecheck", "test", "gate:reachability", "gate:adr-registry", "gate:project-conform"]) {
        expect(pkg.scripts).toHaveProperty(script);
      }

      expect(existsSync(join(root, "src"))).toBe(true);
      expect(existsSync(join(root, "decisions", "registry.json"))).toBe(true);
      expect(existsSync(join(root, "decisions", "README.md"))).toBe(true);
      expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("<!-- governance:adr_total -->");
      for (const store of [".claim-ledger", ".completion-depth", ".determinism-baseline", ".visual-intelligence"]) {
        expect(existsSync(join(root, store))).toBe(true);
      }

      // Scaffolded scripts are honest no-ops, not lies about functionality
      // that does not exist yet — and they are valid, runnable shell, not
      // just valid JSON strings (a real risk with nested quoting).
      for (const script of Object.values(pkg.scripts) as string[]) {
        const out = execSync(script, { cwd: root }).toString();
        expect(out).toMatch(/has no (source|decisions) yet|project-conform\.mjs/);
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("B5: documents the citation_roots key (ADR-080) in the scaffolded profile without setting it — fallback to source_roots is preserved", () => {
    const parent = tmp("arbor-profile-citation-roots-");
    const root = join(parent, "fresh");
    try {
      enrollProject(root, { mode: "new" });
      const raw = readFileSync(join(root, "arbor.profile.jsonc"), "utf8");
      expect(raw).toContain("citation_roots");
      expect(raw).toContain("ADR-080");
      expect(raw).toContain('same as source_roots');

      // Stripping "^//" lines (this file's own JSON-recovery convention,
      // used by the other tests in this suite) still yields strict JSON —
      // the note is a real comment, not smuggled-in JSON content.
      const profile = JSON.parse(raw.replace(/^\/\/.*\n/gm, ""));
      expect(profile).not.toHaveProperty("citation_roots"); // never guessed — the loader's own default applies
      expect(profile.source_roots).toEqual(["src"]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("derives (not guesses) a profile for an existing git repo from its real package.json and disk layout", () => {
    const root = tmp("arbor-profile-existing-");
    try {
      mkdirSync(join(root, "src"));
      gitInit(root);
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "existing-thing", scripts: { test: "echo real-test", typecheck: "echo real-typecheck" } }));

      const result = enrollProject(root, { mode: "backfill" });
      expect(result.profile.disposition).toBe("created");
      expect(result.profile.refusals).toEqual([{ field: "commands.reachability", reason: 'package.json declares no script named "gate:reachability" or "reachability"' }]);

      const profile = JSON.parse(readFileSync(join(root, "arbor.profile.jsonc"), "utf8").replace(/^\/\/.*\n/gm, ""));
      expect(profile.project_id).toBe("existing-thing");
      expect(profile.language).toBe("javascript");
      expect(profile.source_roots).toEqual(["src"]);
      expect(profile.commands).toEqual({ typecheck: "typecheck", test: "test" }); // reachability omitted, not guessed

      // Never fabricates governance file CONTENT for someone else's repo —
      // only the (mechanically safe, attemptFix-equivalent) empty directory.
      expect(existsSync(join(root, "decisions"))).toBe(true);
      expect(existsSync(join(root, "decisions", "registry.json"))).toBe(false);
      expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
      expect(existsSync(join(root, "package.json"))).toBe(true);
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      expect(pkg).not.toHaveProperty("private"); // package.json itself was never touched
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses entirely (writes nothing) for a target that is not a git repository", () => {
    const root = tmp("arbor-profile-nogit-");
    try {
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "no-git", scripts: { test: "x" } }));
      const result = enrollProject(root);
      expect(result.profile.disposition).toBe("refused");
      expect(result.profile.refusals[0]!.field).toBe("*");
      expect(result.profile.refusals[0]!.reason).toMatch(/not a git repository/);
      expect(existsSync(join(root, "arbor.profile.jsonc"))).toBe(false);
      expect(existsSync(join(root, "decisions"))).toBe(false); // total refusal seeds nothing
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses entirely for a git repo with no supported ecosystem manifest", () => {
    const root = tmp("arbor-profile-nopkg-");
    try {
      gitInit(root);
      const result = enrollProject(root);
      expect(result.profile.disposition).toBe("refused");
      expect(result.profile.refusals[0]!.reason).toMatch(/no readable supported manifest/);
      expect(existsSync(join(root, "arbor.profile.jsonc"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { language: "python", manifest: "pyproject.toml", contents: '[project]\nname = "sample"\n', sourceRoot: "src" },
    { language: "rust", manifest: "Cargo.toml", contents: '[package]\nname = "sample"\nversion = "0.1.0"\n', sourceRoot: "crates" },
    { language: "go", manifest: "go.mod", contents: "module example.test/sample\n\ngo 1.24\n", sourceRoot: "internal" },
  ])("derives a truthful $language profile without guessing commands", ({ language, manifest, contents, sourceRoot }) => {
    const root = tmp(`arbor-profile-${language}-`);
    try {
      gitInit(root);
      mkdirSync(join(root, sourceRoot));
      writeFileSync(join(root, manifest), contents);

      const result = enrollProject(root, { mode: "backfill" });
      expect(result.profile.disposition).toBe("created");
      expect(result.profile.refusals).toHaveLength(3);
      expect(result.profile.refusals.every((refusal) => refusal.reason.includes("refusing to guess"))).toBe(true);

      const profile = JSON.parse(readFileSync(join(root, "arbor.profile.jsonc"), "utf8").replace(/^\/\/.*\n/gm, ""));
      expect(profile.language).toBe(language);
      expect(profile.source_roots).toEqual([sourceRoot]);
      expect(profile.commands).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--dry-run writes nothing at all — directory tree is byte-identical before and after", () => {
    const root = tmp("arbor-profile-dryrun-");
    try {
      mkdirSync(join(root, "src"));
      gitInit(root);
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "dry", scripts: { test: "echo t", typecheck: "echo tc", "gate:reachability": "echo r" } }));

      const before = execSync(`find "${root}" -type f -exec sha256sum {} \\; | sort`).toString();
      const result = enrollProject(root, { dry_run: true });
      const after = execSync(`find "${root}" -type f -exec sha256sum {} \\; | sort`).toString();

      expect(after).toBe(before);
      expect(result.profile.disposition).toBe("would_create");
      expect(result.profile.refusals).toEqual([]);
      expect(existsSync(join(root, "arbor.profile.jsonc"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never clobbers a hand-authored arbor.profile.jsonc, and repeated enrollment is idempotent", () => {
    const root = tmp("arbor-profile-handauthored-");
    try {
      gitInit(root);
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "hand", scripts: { test: "echo t" } }));
      const handAuthored = `{\n  "schema_version": 1,\n  "project_id": "hand-authored-by-a-human",\n  "source_roots": ["custom-src"]\n}\n`;
      writeFileSync(join(root, "arbor.profile.jsonc"), handAuthored);

      const first = enrollProject(root);
      expect(first.profile.disposition).toBe("preserved");
      expect(readFileSync(join(root, "arbor.profile.jsonc"), "utf8")).toBe(handAuthored);

      const second = enrollProject(root);
      expect(second.profile.disposition).toBe("preserved");
      expect(readFileSync(join(root, "arbor.profile.jsonc"), "utf8")).toBe(handAuthored);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("repeated --new enrollment is idempotent (second call preserves everything the first call created)", () => {
    const parent = tmp("arbor-profile-new-repeat-");
    const root = join(parent, "fresh");
    try {
      enrollProject(root, { mode: "new" });
      const before = execSync(`find "${root}" -type f -exec sha256sum {} \\; | sort`).toString();
      const second = enrollProject(root, { mode: "new" });
      const after = execSync(`find "${root}" -type f -exec sha256sum {} \\; | sort`).toString();

      expect(after).toBe(before);
      expect(second.profile.disposition).toBe("preserved");
      expect(second.changes.every((c) => c.disposition === "preserved")).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
