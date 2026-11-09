/**
 * ADR-073 (Y-3b) regression: `scripts/docs-truth.mjs` and
 * `scripts/registration-integrity.mjs` were migrated from a hardcoded
 * `packages/` prefix to `profileOrDefaults(REPO_ROOT).source_roots`. Since
 * this repo's `arbor.profile.jsonc` declares `source_roots: ["packages"]`
 * (the same value `DEFAULT_PROFILE` falls back to for an unprofiled repo),
 * both scripts must produce BYTE-IDENTICAL `--json` output whether or not
 * `arbor.profile.jsonc` is present on disk. This test proves that directly
 * against a real repository checkout — no mock — by running each script
 * twice: once with the profile file in place, and once with it temporarily
 * moved aside.
 *
 * ADR-078 case 1/2 hybrid: this used to rename the LIVE `arbor.profile.jsonc`
 * at REPO_ROOT out from under the shared checkout for the ~30-60s each
 * `runScriptTwice` window lasts. Any concurrent reader of that file — another
 * agent's gate run, another test file — would see it missing for real during
 * that window, not because of anything it did. Proven directly below (see
 * the reproduction script in the commit that introduced this fix) by reading
 * the live path mid-rename from a second process and observing ENOENT.
 * Fixed by freezing a `git worktree --detach` snapshot at module load (the
 * `gate-failure-modes.test.mjs` idiom) and renaming *that* copy's profile
 * file instead — the shared checkout's own `arbor.profile.jsonc` is never
 * touched.
 */
import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { arborMcpSrcPaths } from "../registration-integrity.mjs";
// docs-truth.mjs deliberately is NOT imported here: it runs its entire gate
// at module top-level (no `main()`/isDirectExecution() guard — see its own
// header comment), so importing it as an ES module would execute the whole
// gate (including a `bun scripts/reachability.mjs` spawn and, when the real
// ROADMAP.md has roundtrip proofs to verify, a `vitest run` spawn) as an
// import side effect. `checkPathCitation`'s profile-derived behavior is
// proven the same way the rest of this file proves it: running the real CLI
// twice and diffing --json output.

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SNAPSHOT_PARENT = mkdtempSync(join(dirname(REPO_ROOT), ".docs-truth-portability-snapshot-"));
const SNAPSHOT_DIR = join(SNAPSHOT_PARENT, "repo");
execFileSync("git", ["worktree", "add", "-q", "--detach", SNAPSHOT_DIR, "HEAD"], { cwd: REPO_ROOT });
execFileSync("cp", ["-al", join(REPO_ROOT, "node_modules"), join(SNAPSHOT_DIR, "node_modules")]);
const SNAPSHOT_PROFILE_PATH = join(SNAPSHOT_DIR, "arbor.profile.jsonc");

afterAll(() => {
  spawnSync("git", ["worktree", "remove", "--force", SNAPSHOT_DIR], { cwd: REPO_ROOT });
  rmSync(SNAPSHOT_PARENT, { recursive: true, force: true });
});

function runScriptTwice(scriptRelPath) {
  const scriptPath = join(SNAPSHOT_DIR, scriptRelPath);
  expect(existsSync(SNAPSHOT_PROFILE_PATH)).toBe(true);

  const withProfile = spawnSync(process.execPath, [scriptPath, "--json"], { cwd: SNAPSHOT_DIR, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });

  const movedAsidePath = `${SNAPSHOT_PROFILE_PATH}.movedaside-for-test`;
  renameSync(SNAPSHOT_PROFILE_PATH, movedAsidePath);
  let withoutProfile;
  try {
    withoutProfile = spawnSync(process.execPath, [scriptPath, "--json"], { cwd: SNAPSHOT_DIR, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  } finally {
    renameSync(movedAsidePath, SNAPSHOT_PROFILE_PATH);
  }

  return { withProfile, withoutProfile };
}

describe("registration-integrity.mjs — byte-identical with and without arbor.profile.jsonc", () => {
  it("produces identical --json stdout on this repo", () => {
    const { withProfile, withoutProfile } = runScriptTwice("scripts/registration-integrity.mjs");
    expect(withProfile.status).toBe(withoutProfile.status);
    expect(withProfile.stdout).toBe(withoutProfile.stdout);
  }, 30_000);
});

describe("docs-truth.mjs — byte-identical with and without arbor.profile.jsonc", () => {
  it("produces identical --json stdout on this repo", () => {
    const { withProfile, withoutProfile } = runScriptTwice("scripts/docs-truth.mjs");
    expect(withProfile.status).toBe(withoutProfile.status);
    expect(withProfile.stdout).toBe(withoutProfile.stdout);
  }, 60_000);
});

describe("arborMcpSrcPaths — profile-derived, matches the previous hardcoded packages/ prefix", () => {
  it("resolves the well-known arbor-mcp source paths under a single source root", () => {
    expect(arborMcpSrcPaths(["packages"])).toEqual({
      cli: "packages/arbor-mcp/src/cli.ts",
      tools: "packages/arbor-mcp/src/tools.ts",
      devtools: "packages/arbor-mcp/src/devtools.ts",
      server: "packages/arbor-mcp/src/server.ts",
      runtimeCatalog: "packages/arbor-mcp/src/runtime-catalog.ts",
    });
  });

  it("uses only the first declared source root", () => {
    expect(arborMcpSrcPaths(["crates", "packages"]).cli).toBe("crates/arbor-mcp/src/cli.ts");
  });
});
