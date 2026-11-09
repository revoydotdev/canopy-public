import { describe, expect, it, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fix 4: `vi-refresh.mjs --force` forwards `--force` to the extraction step
 * only, and `--check --force` together is rejected before either the check
 * or a real extraction runs.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VI_REFRESH = join(REPO_ROOT, "scripts/vi-refresh.mjs");

function run(args, opts = {}) {
  const result = spawnSync(process.execPath, [VI_REFRESH, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    ...opts,
  });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("vi-refresh --check --force", () => {
  it("is rejected before doing any work — a check must never overwrite", () => {
    const { code, out } = run(["--check", "--force"]);
    expect(code).toBe(1);
    expect(out).toContain("mutually exclusive");
  });
});

/**
 * `vi-refresh.mjs` computes its REPO_ROOT from its own file location
 * (`dirname(fileURLToPath(import.meta.url))/..`), and step 1's extractor
 * path is likewise resolved relative to that root. So to observe the actual
 * composed argv without running the real (expensive, network/bun-dependent)
 * six-step pipeline, this copies the real, just-edited vi-refresh.mjs into a
 * fixture tree at `scripts/vi-refresh.mjs` and substitutes a stub in place
 * of the vendored vi-extract-ts.mjs that records the argv it received and
 * exits non-zero — which is enough to observe step 1's composed argv without
 * needing steps 2-6 (vi-emit, verify-against-gate, vi-validate, vi-render)
 * to exist at all.
 */
let fixture;

afterEach(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
  fixture = undefined;
});

function buildFixture() {
  const dir = mkdtempSync(join(tmpdir(), "vi-refresh-force-"));
  mkdirSync(join(dir, "scripts/reachability"), { recursive: true });
  mkdirSync(join(dir, "scripts/lib"), { recursive: true });
  mkdirSync(join(dir, ".claude/skills/repository-visual-intelligence/scripts"), { recursive: true });

  copyFileSync(VI_REFRESH, join(dir, "scripts/vi-refresh.mjs"));
  // vi-refresh.mjs imports the project-profile seam (ADR-073's --root
  // follow-up) — the fixture needs a real copy for the module graph to
  // resolve, same as any other of vi-refresh.mjs's real dependencies.
  copyFileSync(join(REPO_ROOT, "scripts/lib/project-profile.mjs"), join(dir, "scripts/lib/project-profile.mjs"));
  copyFileSync(join(REPO_ROOT, "scripts/lib/vi-input-binding.mjs"), join(dir, "scripts/lib/vi-input-binding.mjs"));
  // vi-refresh now has a real common-dir writer-lease dependency. The fixture
  // copies its production module graph rather than pretending the standalone
  // entry point has no concurrency authority.
  copyFileSync(join(REPO_ROOT, "scripts/evidence-transaction.mjs"), join(dir, "scripts/evidence-transaction.mjs"));
  copyFileSync(join(REPO_ROOT, "scripts/enforcement-control-plane.mjs"), join(dir, "scripts/enforcement-control-plane.mjs"));
  // ADR-091 gave enforcement-control-plane.mjs a real dependency on the shared
  // finalization progress reporter; the fixture copies it for the same reason
  // it copies every other real edge of the module graph.
  copyFileSync(join(REPO_ROOT, "scripts/finalization-progress.mjs"), join(dir, "scripts/finalization-progress.mjs"));
  copyFileSync(join(REPO_ROOT, "scripts/lib/governance-plan.mjs"), join(dir, "scripts/lib/governance-plan.mjs"));
  writeFileSync(join(dir, "scripts/reachability/entry-points.json"), "{}\n");

  const stub = join(dir, ".claude/skills/repository-visual-intelligence/scripts/vi-extract-ts.mjs");
  writeFileSync(
    stub,
    "#!/usr/bin/env node\n" +
    "import { writeFileSync } from \"node:fs\";\n" +
    "writeFileSync(process.env.RECORD_ARGV_TO, JSON.stringify(process.argv.slice(2)));\n" +
    "process.exit(1);\n",
  );
  chmodSync(stub, 0o755);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "fixture"], { cwd: dir });
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-qm", "fixture"], { cwd: dir });
  return dir;
}

function receivedArgv(dir, force) {
  const recordFile = join(dir, "received-argv.json");
  const result = spawnSync(process.execPath, [
    join(dir, "scripts/vi-refresh.mjs"), ...(force ? ["--force"] : []),
  ], {
    cwd: dir,
    encoding: "utf-8",
    env: { ...process.env, RECORD_ARGV_TO: recordFile },
  });
  expect(existsSync(recordFile), `stub extractor never ran:\n${result.stdout}${result.stderr}`).toBe(true);
  return JSON.parse(readFileSync(recordFile, "utf-8"));
}

describe("vi-refresh --force forwarding", () => {
  it("forwards --force to the extraction step when passed", () => {
    fixture = buildFixture();
    expect(receivedArgv(fixture, true)).toContain("--force");
  });

  it("does not forward --force when not passed", () => {
    fixture = buildFixture();
    expect(receivedArgv(fixture, false)).not.toContain("--force");
  });
});
