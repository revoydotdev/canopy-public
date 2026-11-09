/**
 * packages/arbor-mcp/tests/project-registry-cli.test.ts — Roadmap 23 W2
 * (ADR-076): the operator surface. Proves `arbor project enroll` records a
 * registry entry with discharge established at that moment, and that
 * `arbor project registry list|verify` are real, wired commands rather than
 * grammar that merely parses.
 *
 * Uses `main()` directly with real temp directories, matching
 * `project-cli.test.ts`'s convention. The GOVERNING cwd (where the registry
 * lives, under `<cwd>/.arbor/project-registry.json`) is kept deliberately
 * separate from the ENROLLED project's own path, so a defect that reads or
 * writes the wrong directory would be caught rather than accidentally
 * matching by coincidence.
 */

import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { main } from "../src/cli.js";
import { EXIT_CODES } from "../src/exit-codes.js";
import { enrollProject } from "../src/project-lifecycle.js";
import { resolveProjectRevision } from "../src/project-registry.js";

function output(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  let captured = "";
  stream.on("data", (chunk) => { captured += chunk.toString(); });
  return { stream, text: () => captured };
}

/** A real, freshly-scaffolded, git-backed, conformant project — built
 * directly (not through the CLI) so these tests exercise the CLI's
 * registration WIRING rather than re-proving W4's scaffold correctness.
 * `enrollProject(dir, { mode: "new" })` itself `git init`s and makes the
 * initial commit for a target it scaffolds from nothing (Roadmap 23 §6 L2,
 * `ensureNewProjectGitRepo` in `project-lifecycle.ts`), so no manual git
 * setup is needed here. */
function buildFixtureProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "project-registry-cli-fixture-"));
  enrollProject(dir, { mode: "new" });
  return dir;
}

describe("arbor project enroll — registers a discharged entry", () => {
  it("a re-enroll of an already-scaffolded, git-backed project registers it and reports so", async () => {
    const governingCwd = mkdtempSync(join(tmpdir(), "project-registry-cli-governing-"));
    const projectDir = buildFixtureProject();
    try {
      const enrollOut = output();
      const code = await main(["project", "enroll", projectDir, "--json"], {
        cwd: governingCwd, stdin: new PassThrough(), stdout: enrollOut.stream, stderr: new PassThrough(),
      });
      expect(code).toBe(EXIT_CODES.SUCCESS);
      const parsed = JSON.parse(enrollOut.text());
      expect(parsed.registry.registered).toBe(true);
      expect(parsed.registry.entry.path).toBe(projectDir);

      // Written under the GOVERNING cwd, not the enrolled project's own dir.
      const registryPath = join(governingCwd, ".arbor", "project-registry.json");
      expect(existsSync(registryPath)).toBe(true);
      const onDisk = JSON.parse(readFileSync(registryPath, "utf8"));
      expect(onDisk.entries).toHaveLength(1);
      expect(onDisk.entries[0].path).toBe(projectDir);
      expect(onDisk.entries[0]).not.toHaveProperty("conformant");
    } finally {
      rmSync(governingCwd, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("enrollment without a resulting profile (existing empty dir) still succeeds and registers nothing", async () => {
    // Regression guard for the pre-existing project-cli.test.ts behavior:
    // a profile-less enrollment must not turn into a CONFLICT because of the
    // registry wiring added alongside it.
    const governingCwd = mkdtempSync(join(tmpdir(), "project-registry-cli-governing-"));
    const emptyTarget = mkdtempSync(join(tmpdir(), "project-registry-cli-empty-"));
    try {
      const code = await main(["project", "enroll", emptyTarget], {
        cwd: governingCwd, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      });
      expect(code).toBe(EXIT_CODES.SUCCESS);
      expect(existsSync(join(governingCwd, ".arbor", "project-registry.json"))).toBe(false);
    } finally {
      rmSync(governingCwd, { recursive: true, force: true });
      rmSync(emptyTarget, { recursive: true, force: true });
    }
  });
});

describe("arbor project registry list|verify", () => {
  it("list and verify report a healthy registry, then verify fails after real drift and the entry survives", async () => {
    const governingCwd = mkdtempSync(join(tmpdir(), "project-registry-cli-governing-"));
    const projectDir = buildFixtureProject();
    try {
      expect(await main(["project", "enroll", projectDir], {
        cwd: governingCwd, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      })).toBe(EXIT_CODES.SUCCESS);

      const listOut = output();
      expect(await main(["project", "registry", "list", "--json"], {
        cwd: governingCwd, stdin: new PassThrough(), stdout: listOut.stream, stderr: new PassThrough(),
      })).toBe(EXIT_CODES.SUCCESS);
      const listed = JSON.parse(listOut.text());
      expect(listed.entries).toHaveLength(1);
      expect(listed.entries[0].path).toBe(projectDir);

      const verifyOut = output();
      expect(await main(["project", "registry", "verify", "--json"], {
        cwd: governingCwd, stdin: new PassThrough(), stdout: verifyOut.stream, stderr: new PassThrough(),
      })).toBe(EXIT_CODES.SUCCESS);
      expect(JSON.parse(verifyOut.text()).ok).toBe(true);

      // Real drift: break a required conformance element in the governed
      // project after registration.
      rmSync(join(projectDir, "decisions", "registry.json"));

      const verifyAfterOut = output();
      const verifyCode = await main(["project", "registry", "verify", "--json"], {
        cwd: governingCwd, stdin: new PassThrough(), stdout: verifyAfterOut.stream, stderr: new PassThrough(),
      });
      expect(verifyCode).toBe(EXIT_CODES.VIOLATION);
      const report = JSON.parse(verifyAfterOut.text());
      expect(report.ok).toBe(false);
      expect(report.verifications[0].failures.some((f: { code: string }) => f.code === "conformance_failed")).toBe(true);

      // The entry itself is untouched, not pruned.
      const listAfterOut = output();
      await main(["project", "registry", "list", "--json"], {
        cwd: governingCwd, stdin: new PassThrough(), stdout: listAfterOut.stream, stderr: new PassThrough(),
      });
      expect(JSON.parse(listAfterOut.text()).entries).toHaveLength(1);
    } finally {
      rmSync(governingCwd, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("list on a never-registered governing dir reports zero entries, not an error", async () => {
    const governingCwd = mkdtempSync(join(tmpdir(), "project-registry-cli-governing-"));
    try {
      const listOut = output();
      expect(await main(["project", "registry", "list", "--json"], {
        cwd: governingCwd, stdin: new PassThrough(), stdout: listOut.stream, stderr: new PassThrough(),
      })).toBe(EXIT_CODES.SUCCESS);
      expect(JSON.parse(listOut.text()).entries).toEqual([]);

      const verifyOut = output();
      expect(await main(["project", "registry", "verify", "--json"], {
        cwd: governingCwd, stdin: new PassThrough(), stdout: verifyOut.stream, stderr: new PassThrough(),
      })).toBe(EXIT_CODES.SUCCESS);
      expect(JSON.parse(verifyOut.text())).toMatchObject({ ok: true, entry_count: 0 });
    } finally {
      rmSync(governingCwd, { recursive: true, force: true });
    }
  });

  it("rejects an unknown registry action and an unknown flag as usage errors", async () => {
    const governingCwd = mkdtempSync(join(tmpdir(), "project-registry-cli-governing-"));
    try {
      for (const args of [["project", "registry"], ["project", "registry", "bogus"], ["project", "registry", "list", "--wat"]]) {
        const err = output();
        expect(await main(args, { cwd: governingCwd, stdin: new PassThrough(), stdout: new PassThrough(), stderr: err.stream })).toBe(EXIT_CODES.USAGE);
        expect(err.text()).toContain("Usage: arbor project");
      }
    } finally {
      rmSync(governingCwd, { recursive: true, force: true });
    }
  });
});

describe("enroll exit code separates a failed discharge from nothing-to-claim", () => {
  /**
   * Regression: registration originally made `enroll` exit CONFLICT whenever
   * an entry was not recorded. That conflated two different outcomes, and the
   * one it got wrong used to be the most common first run there is -- `--new`
   * against a fresh directory had no commits, so no revision to claim
   * provenance from, while the project it just created was fully conformant.
   * Scripted use would have read a correct enrollment as a failure.
   *
   * Roadmap 23 §6 L2 closed that specific case at its source: `--new`
   * against a target it scaffolds from nothing now `git init`s and commits
   * it, so the single most natural first command registers cleanly instead
   * of only reporting a refusal. This test now proves THAT — the happy path
   * is SUCCESS *and* registered. `no_revision` itself is still a real,
   * reachable refusal code (proved directly in
   * `project-registry.test.ts` — a conformant project that genuinely has no
   * git history); this suite only proves the CLI no longer routes the
   * common case through it.
   */
  it("exits SUCCESS and registers when --new scaffolds a target from nothing", async () => {
    const governingCwd = mkdtempSync(join(tmpdir(), "enroll-norev-gov-"));
    const target = mkdtempSync(join(tmpdir(), "enroll-norev-"));
    try {
      const out = output();
      const code = await main(["project", "enroll", target, "--new", "--json"], {
        cwd: governingCwd, stdin: new PassThrough(), stdout: out.stream, stderr: new PassThrough(),
      });
      expect(code).toBe(EXIT_CODES.SUCCESS);
      const parsed = JSON.parse(out.text());
      // The overlay genuinely succeeded...
      expect(parsed.inspection.state).toBe("ready");
      // ...git provenance was established as part of that same scaffold...
      expect(existsSync(join(target, ".git"))).toBe(true);
      // ...and there was nothing left to refuse: registration succeeded.
      expect(parsed.registry.registered).toBe(true);
      expect(parsed.registry.refusal).toBeUndefined();
      expect(parsed.registry.entry.path).toBe(target);
    } finally {
      rmSync(governingCwd, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("never re-initializes a target that already has its own git history", async () => {
    const governingCwd = mkdtempSync(join(tmpdir(), "enroll-existing-gov-"));
    const target = buildFixtureProject();
    // A distinct, real prior history the enroll must not disturb: `--new`
    // preserves an already-scaffolded project's own .arbor manifest and
    // arbor.profile.jsonc (both already exist), so nothing new is derived —
    // this proves the git side of that same "never overwrite" contract by
    // asserting the original commit survives untouched (not just that HEAD
    // still points at the same branch name).
    const beforeRevision = resolveProjectRevision(target);
    expect(beforeRevision).toMatch(/^[0-9a-f]{40}$/);
    try {
      const out = output();
      const code = await main(["project", "enroll", target, "--new", "--json"], {
        cwd: governingCwd, stdin: new PassThrough(), stdout: out.stream, stderr: new PassThrough(),
      });
      expect(code).toBe(EXIT_CODES.SUCCESS);
      expect(resolveProjectRevision(target)).toBe(beforeRevision);
    } finally {
      rmSync(governingCwd, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});
