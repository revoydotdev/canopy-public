/**
 * scripts/tests/project-conform-enrollment.test.mjs — Roadmap 23 W4
 * acceptance test: docs/roadmaps/23-multi-project-enrollment.md §2.5 named
 * the defect as "enrollment never emits arbor.profile.jsonc, so an enrolled
 * project always fails conformance," and its acceptance criterion is the
 * B2.5 reproduction inverted:
 *
 *   `arbor project enroll <fresh dir> --new` followed by
 *   `project-conform.mjs --root <fresh dir>` must PASS.
 *
 * This drives the REAL CLI binary as a subprocess (not the in-process
 * function) against a REAL temp directory, then runs the REAL conformance
 * evaluator against that same directory — the same "prove it read the
 * second project's files" posture project-conform-root.test.mjs already
 * established for W1. A test that only calls `enrollProject` in-process and
 * asserts on its return value would not catch a CLI wiring gap (e.g. the
 * CLI silently swallowing the profile field); driving the actual binary is
 * what closes that gap.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { evaluateConformance } from "../project-conform.mjs";

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ARBOR_BIN = join(REPO_ROOT, "packages", "arbor-mcp", "bin", "arbor-mcp.mjs");

const dirs = [];
function tempParent() {
  const root = mkdtempSync(join(tmpdir(), "project-conform-enrollment-"));
  dirs.push(root);
  return root;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

/**
 * Run the real CLI with an ISOLATED governing cwd.
 *
 * The registry is written under `resolvePersistenceDir(environment.cwd, ...)`,
 * so spawning with this repository as cwd makes a test fixture register itself
 * into revoy2's own `.arbor/project-registry.json`. That was harmless only
 * while `--new` could not register at all; once it began initialising a git
 * repo and succeeding, these fixtures started writing production state, and
 * `gate:project-registry` then failed on entries whose fixture directories the
 * suite had already deleted — a real registration pointing at a real absence,
 * which is exactly what ADR-076 says the gate must report rather than prune.
 *
 * Each call gets its own throwaway governing directory, so the CLI's registry
 * writes land there and are cleaned up with everything else.
 */
function enroll(args) {
  const governingCwd = tempParent();
  const result = spawnSync("bun", [ARBOR_BIN, "project", "enroll", ...args], { encoding: "utf8", cwd: governingCwd });
  if (result.status === null) throw new Error(`arbor CLI did not exit: ${result.error?.message ?? "unknown spawn failure"}`);
  return result;
}

describe("enroll --new produces a conformant project (Roadmap 23 W4 acceptance)", () => {
  it("BEFORE/AFTER: reproduces the B2.5 defect state is closed — fresh enroll --new now PASSES project-conform --root", () => {
    const parent = tempParent();
    const target = join(parent, "fresh-project");

    const enrollResult = enroll([target, "--new", "--json"]);
    expect(enrollResult.status).toBe(0);
    const enrolled = JSON.parse(enrollResult.stdout);
    expect(enrolled.profile.disposition).toBe("created");
    expect(enrolled.profile.refusals).toEqual([]);

    const results = evaluateConformance(target);
    const blocking = results.filter((r) => !r.ok && r.requirement !== "optional");
    expect(blocking).toEqual([]); // ← the acceptance criterion, inverted from the B2.5 reproduction
  });

  it("--backfill on a non-conformant existing repo derives what it can and refuses the rest, never silently partial", () => {
    const parent = tempParent();
    const target = join(parent, "existing-project");
    mkdirSync(join(target, "src"), { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: target });
    writeFileSync(join(target, "package.json"), JSON.stringify({ name: "existing-project", scripts: { test: "echo t", typecheck: "echo tc" } }));

    const enrollResult = enroll([target, "--backfill", "--json"]);
    // CONFLICT, not SUCCESS: backfill did its job (see the profile assertions
    // below), but the resulting project genuinely does not conform, and the
    // registry's discharge therefore failed. `project status` already uses
    // CONFLICT for "not in the desired state"; a zero exit here would hide
    // non-conformance from any script driving enrollment. The complementary
    // case -- a refusal merely for want of provenance -- stays SUCCESS, and is
    // pinned in packages/arbor-mcp/tests/project-registry-cli.test.ts.
    expect(enrollResult.status).toBe(4);
    const enrolled = JSON.parse(enrollResult.stdout);
    expect(enrolled.registry.refusal).toBe("conformance_failed");
    expect(enrolled.profile.disposition).toBe("created");
    expect(enrolled.profile.refusals).toEqual([{ field: "commands.reachability", reason: 'package.json declares no script named "gate:reachability" or "reachability"' }]);

    const results = evaluateConformance(target);
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId["command-typecheck"].ok).toBe(true);
    expect(byId["command-test"].ok).toBe(true);
    expect(byId["command-reachability"].ok).toBe(false); // honestly unmet, not fabricated
    expect(byId["decisions-registry"].ok).toBe(false); // never fabricated for someone else's repo
  });

  it("--dry-run leaves the target directory byte-identical (nothing exists to check afterward)", () => {
    const parent = tempParent();
    const target = join(parent, "preview-only");

    const dryRun = enroll([target, "--new", "--dry-run", "--json"]);
    expect(dryRun.status).toBe(0);
    const preview = JSON.parse(dryRun.stdout);
    expect(preview.profile.disposition).toBe("would_create");

    // Nothing was created at all — the acceptance criterion cannot even be
    // evaluated because the target does not exist, which is the honest
    // state --dry-run promises.
    expect(() => readFileSync(join(target, "arbor.profile.jsonc"))).toThrow();
  });
});
