/**
 * scripts/tests/adr-resolve.test.mjs — the path -> governing-ADR resolver.
 *
 * Built on a throwaway repository so the three substrates are under test
 * control: commits carrying trailers, ADR files carrying proof comments, and a
 * registry that allocates some numbers and not others. The generalist case —
 * a repository with no registry at all — is asserted to resolve to
 * `ungoverned` with an empty trailer, because the guard that consumes this
 * must never manufacture a demand on a repository that has no decisions.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { resolveAdrsForPaths, formatResolution, proofPaths, recordStatuses } from "../adr-resolve.mjs";

function git(repo, ...args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, encoding: "utf-8" });
}

function commit(repo, files, message) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text, "utf-8");
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
}

let governed;
let bare;

beforeAll(() => {
  governed = mkdtempSync(join(tmpdir(), "adr-resolve-governed-"));
  git(governed, "init", "-q", "-b", "master");
  mkdirSync(join(governed, "decisions"), { recursive: true });
  writeFileSync(join(governed, "decisions", "registry.json"), JSON.stringify({ schema_version: 1, next_available: 5, reserved: [], allocations: [
    { number: 1, slug: "one" }, { number: 2, slug: "two" }, { number: 3, slug: "three" }, { number: 4, slug: "four" },
  ] }), "utf-8");
  writeFileSync(join(governed, "decisions", "ADR-001-one.md"), "# One\n\n**Status:** Accepted\n\n<!-- proof: symbol=x file=packages/a/src/x.ts roundtrip=packages/a/tests/x.test.ts -->\n", "utf-8");
  writeFileSync(join(governed, "decisions", "ADR-002-two.md"), "# Two\n\n**Status:** Accepted\n", "utf-8");
  writeFileSync(join(governed, "decisions", "ADR-003-three.md"), "# Three\n\n**Status:** Superseded\n", "utf-8");
  writeFileSync(join(governed, "decisions", "ADR-004-four.md"), "# Four\n\n**Status:** Accepted\n", "utf-8");
  commit(governed, { "README.md": "seed\n" }, "chore: seed");
  commit(governed, { "packages/a/src/x.ts": "export const x = 1;\n" }, "feat: x\n\nADR: 001");
  commit(governed, { "packages/a/src/y.ts": "export const y = 1;\n" }, "feat: y\n\nADR: 002");
  commit(governed, { "packages/a/src/y.ts": "export const y = 2;\n" }, "fix: y again\n\nADR: 002");
  commit(governed, { "packages/b/src/z.ts": "export const z = 1;\n" }, "feat: z under a superseded record\n\nADR: 003");
  commit(governed, { "packages/c/src/w.ts": "export const w = 1;\n" }, "feat: w cites a number the registry never allocated\n\nADR: 099");

  bare = mkdtempSync(join(tmpdir(), "adr-resolve-bare-"));
  git(bare, "init", "-q", "-b", "master");
  commit(bare, { "packages/lib/index.ts": "export {};\n" }, "feat: anything");
});

afterAll(() => {
  rmSync(governed, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
});

describe("resolveAdrsForPaths", () => {
  it("resolves a path from its history and its obligation proof, uniquely", () => {
    const result = resolveAdrsForPaths({ repo: governed, paths: ["packages/a/src/x.ts"] });
    expect(result.governed).toBe(true);
    expect(result.per_path[0].candidates[0]).toMatchObject({ adr: 1 });
    expect(result.per_path[0].candidates[0].reasons.join(" ")).toMatch(/latest commit/);
    expect(result.per_path[0].candidates[0].reasons.join(" ")).toMatch(/obligation proof/);
    expect(result.suggestion).toEqual({ adrs: [1], confidence: "unique", trailer: "ADR: 001" });
  });

  it("weights repeated citation, and lists every governed path in one trailer", () => {
    const result = resolveAdrsForPaths({ repo: governed, paths: ["packages/a/src/x.ts", "packages/a/src/y.ts", "docs/notes.md"] });
    expect(result.per_path[1].candidates[0]).toMatchObject({ adr: 2 });
    expect(result.per_path[2]).toMatchObject({ governed: false, candidates: [] });
    expect(result.suggestion.trailer).toBe("ADR: 001, 002");
  });

  it("never suggests a superseded record or an unallocated number", () => {
    const superseded = resolveAdrsForPaths({ repo: governed, paths: ["packages/b/src/z.ts"] });
    expect(superseded.per_path[0].candidates.map((c) => c.adr)).not.toContain(3);
    const unallocated = resolveAdrsForPaths({ repo: governed, paths: ["packages/c/src/w.ts"] });
    expect(unallocated.per_path[0].candidates.map((c) => c.adr)).not.toContain(99);
    expect(unallocated.suggestion.confidence).toBe("ambiguous");
    expect(unallocated.suggestion.trailer).toBeNull();
  });

  it("falls back to the nearest ancestor for a new file, as weak evidence only", () => {
    const result = resolveAdrsForPaths({ repo: governed, paths: ["packages/a/src/new-file.ts"] });
    const candidates = result.per_path[0].candidates;
    expect(candidates.map((c) => c.adr).sort()).toEqual([1, 2]);
    expect(candidates.every((c) => c.reasons[0].startsWith("claimed for"))).toBe(true);
    // Below the confident score: shown, never auto-filled.
    expect(result.suggestion.trailer).toBeNull();
    expect(formatResolution(result)).toContain("no confident trailer");
  });

  it("reports an unregistered repository as ungoverned with an empty trailer", () => {
    const result = resolveAdrsForPaths({ repo: bare, paths: ["packages/lib/index.ts"] });
    expect(result.governed).toBe(false);
    expect(result.suggestion).toEqual({ adrs: [], confidence: "ungoverned", trailer: null });
    expect(formatResolution(result)).toMatch(/ungoverned: no decision registry/);
  });

  it("reads proof paths and statuses from the decision files", () => {
    expect([...proofPaths(governed, "decisions").get(1)]).toEqual(["packages/a/src/x.ts", "packages/a/tests/x.test.ts"]);
    expect(recordStatuses(governed, "decisions").get(3)).toBe("superseded");
  });
});
