import { describe, expect, it, afterEach, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * scripts/tests/vi-decisions-dir-portability.test.mjs — the acceptance test
 * for the LAST residue of ADR-073's follow-up (Roadmap 23 §5's own words:
 * "a harness that *accepts* a second project and quietly checks the wrong
 * files... every gate green, every guarantee void").
 *
 * `scripts/vi-emit.ts` already derives its decisions corpus and waiver
 * store from `--root` (see `vi-refresh-cross-contamination.test.mjs`), but
 * until this change it did so by joining `root` with the LITERAL string
 * `"decisions"` and the literal `scripts/reachability/allowlist.json` — a
 * foreign project whose `arbor.profile.jsonc` names a different decisions
 * directory (`governance.decisions_dir`) was silently ignored: its ADR
 * corpus would simply never be found, producing an EMPTY intent graph that
 * looks exactly like a conformant project with zero decisions on record.
 * That is the precise "green about files it never read" failure this
 * roadmap's §5 names — a fixture with an unconventional decisions
 * directory is the only thing that can prove it is now closed.
 *
 * This fixture's decisions directory is named `adr/`, not `decisions/` —
 * deliberately non-conventional — and its profile declares
 * `governance.decisions_dir: "adr"`. It invokes `scripts/vi-emit.ts`
 * directly (the file whose two hardcodings this change removes), not the
 * full six-step `vi-refresh.mjs` pipeline, since vi-emit.ts is the only
 * step that reads the decisions corpus.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VI_EMIT = join(REPO_ROOT, "scripts/vi-emit.ts");

/**
 * The "TEETH" test below used to `writeFileSync` a reverted copy of
 * `packages/arbor-governance/src/vi/intent.ts` and `.../exceptions.ts`
 * directly over the LIVE files at REPO_ROOT for the duration of a `bun
 * vi-emit.ts` subprocess call, restoring the originals in a `finally`. In a
 * repository whose normal mode is concurrent agents committing into this
 * same checkout (any sibling reading, typechecking, or editing either file
 * during that window — including this very session's own sibling agent,
 * which owns `src/` this batch — would observe the reverted, temporarily
 * broken source, and a crash between the write and the `finally` would
 * leave it that way permanently), this is the same live-mutation hazard
 * `docs-truth-registration-integrity-portability.test.mjs` was fixed for
 * (ADR-078 case 1/2 hybrid) — except mutating source instead of renaming a
 * config file. Fixed the same way: a frozen `git worktree --detach`
 * snapshot at module load (the `gate-failure-modes.test.mjs` idiom), with
 * both the mutation and the `vi-emit.ts` run confined to that private copy.
 * REPO_ROOT's own `packages/` and `scripts/` are never written to.
 */
const SNAPSHOT_PARENT = mkdtempSync(join(dirname(REPO_ROOT), ".vi-decisions-dir-snapshot-"));
const SNAPSHOT_DIR = join(SNAPSHOT_PARENT, "repo");
execFileSync("git", ["worktree", "add", "-q", "--detach", SNAPSHOT_DIR, "HEAD"], { cwd: REPO_ROOT });
execFileSync("cp", ["-al", join(REPO_ROOT, "node_modules"), join(SNAPSHOT_DIR, "node_modules")]);
const SNAPSHOT_VI_EMIT = join(SNAPSHOT_DIR, "scripts/vi-emit.ts");

afterAll(() => {
  spawnSync("git", ["worktree", "remove", "--force", SNAPSHOT_DIR], { cwd: REPO_ROOT });
  rmSync(SNAPSHOT_PARENT, { recursive: true, force: true });
});

function git(repo, ...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

let fixture;

afterEach(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
  fixture = undefined;
});

function buildFixture() {
  const dir = mkdtempSync(join(tmpdir(), "vi-emit-decisions-dir-"));
  git(dir, "init", "-q", "-b", "master");
  git(dir, "config", "user.email", "fixture@fixture.test");
  git(dir, "config", "user.name", "fixture");

  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "riverstone-fixture" }));
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");

  // The load-bearing part of this fixture: a decisions directory named
  // "adr", not "decisions" — and a profile that says so.
  writeFileSync(
    join(dir, "arbor.profile.jsonc"),
    JSON.stringify(
      {
        schema_version: 1,
        project_id: "riverstone",
        language: "typescript",
        source_roots: ["libs"],
        governance: {
          decisions_dir: "adr",
          evidence_stores: [".visual-intelligence"],
          arbor_dir: ".arbor",
          allowlist_path: "governance/waivers.json",
        },
      },
      null,
      2,
    ),
  );

  const srcDir = join(dir, "libs/widget/src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, "index.ts"), "export function riverstoneOnlySymbol() { return 1; }\n");

  // Its own waiver store, at the profile's non-default `allowlist_path`.
  mkdirSync(join(dir, "governance"), { recursive: true });
  writeFileSync(join(dir, "governance/waivers.json"), JSON.stringify({ version: 1, entries: [] }));

  // The record this test exists to prove gets picked up: under "adr/", not
  // "decisions/". A project with only a conventional "decisions/" reader
  // would find nothing here and silently emit zero records.
  const decisionsDir = join(dir, "adr");
  mkdirSync(decisionsDir, { recursive: true });
  writeFileSync(
    join(decisionsDir, "ADR-001-riverstone-fixture-decision.md"),
    [
      "# ADR-001: Riverstone Fixture Decision",
      "",
      "**Status:** Accepted",
      "**Date:** 2026-08-18",
      "",
      "## Context",
      "",
      "This record exists only inside the decisions-dir-portability fixture,",
      "under a directory named `adr/`, never `decisions/`.",
      "",
      "## Decision",
      "",
      "Prove buildIntentGraph/extractExceptions honor governance.decisions_dir.",
      "",
      "## Consequences",
      "",
      "None outside this fixture.",
      "",
    ].join("\n"),
  );

  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture base");
  return dir;
}

function runEmit(root) {
  return spawnSync("bun", [VI_EMIT, "--root", root], { cwd: REPO_ROOT, encoding: "utf-8" });
}

function runEmitFromSnapshot(root) {
  return spawnSync("bun", [SNAPSHOT_VI_EMIT, "--root", root], { cwd: SNAPSHOT_DIR, encoding: "utf-8" });
}

describe("vi-emit.ts --root — non-conventional decisions_dir portability (ADR-073 follow-up, last residue)", () => {
  it("picks up an ADR record from a profile-declared decisions_dir other than 'decisions'", () => {
    fixture = buildFixture();

    const result = runEmit(fixture);
    expect(result.status, `vi-emit --root ${fixture} failed:\n${result.stdout}${result.stderr}`).toBe(0);

    const nodes = readFileSync(join(fixture, ".visual-intelligence/graph/nodes.jsonl"), "utf-8")
      .split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
    const adrNode = nodes.find((n) => n.kind === "record" && n.name === "ADR-001");

    // POSITIVE: the record living under adr/, not decisions/, was found.
    expect(adrNode).toBeDefined();
    expect(adrNode.qualified_name).toBe("Riverstone Fixture Decision");
    expect(adrNode.id).toBe("rec:riverstone:ADR-001");

    // The waiver store step also honored the non-default allowlist_path.
    const exceptionsPath = join(fixture, ".visual-intelligence/exceptions/exceptions.jsonl");
    expect(existsSync(exceptionsPath)).toBe(true);
  }, 60_000);

  it("TEETH: reverting decisionsDir threading in buildIntentGraph/extractExceptions makes this fixture's graph come up EMPTY of its own ADR record", () => {
    fixture = buildFixture();

    const intentPath = join(SNAPSHOT_DIR, "packages/arbor-governance/src/vi/intent.ts");
    const exceptionsSrcPath = join(SNAPSHOT_DIR, "packages/arbor-governance/src/vi/exceptions.ts");
    const intentOriginal = readFileSync(intentPath, "utf-8");
    const exceptionsOriginal = readFileSync(exceptionsSrcPath, "utf-8");

    try {
      // Revert the seam: force the literal "decisions" regardless of the
      // option passed in — exactly what this change removed.
      const intentReverted = intentOriginal.replace(
        'const decisionsDirName = options.decisionsDir ?? "decisions";',
        'const decisionsDirName = "decisions";',
      );
      expect(intentReverted, "revert pattern did not match intent.ts — test is stale").not.toBe(intentOriginal);
      writeFileSync(intentPath, intentReverted);

      const exceptionsReverted = exceptionsOriginal.replace(
        "const decisionsDir = options.decisionsDir ?? DECISIONS_DIR;",
        "const decisionsDir = DECISIONS_DIR;",
      );
      expect(exceptionsReverted, "revert pattern did not match exceptions.ts — test is stale").not.toBe(exceptionsOriginal);
      writeFileSync(exceptionsSrcPath, exceptionsReverted);

      const result = runEmitFromSnapshot(fixture);

      // With the seam reverted, buildIntentGraph forces the literal
      // "decisions" regardless of the fixture's declared "adr" — and this
      // fixture (deliberately) has no directory of that name, so the run
      // fails outright rather than silently emitting an empty-but-green
      // graph. Either failure mode (hard error, or a graph missing its own
      // ADR record) is the regression this test exists to catch; this
      // fixture's shape happens to produce the loud one. Assert the loud
      // failure explicitly, and where a graph WAS written anyway, confirm
      // it is missing the fixture's own record either way.
      if (result.status === 0) {
        const nodes = readFileSync(join(fixture, ".visual-intelligence/graph/nodes.jsonl"), "utf-8")
          .split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
        const adrNode = nodes.find((n) => n.kind === "record" && n.name === "ADR-001");
        expect(adrNode).toBeUndefined();
      } else {
        expect(result.stderr + result.stdout).toContain("decisions");
      }
    } finally {
      writeFileSync(intentPath, intentOriginal);
      writeFileSync(exceptionsSrcPath, exceptionsOriginal);
    }
  }, 60_000);
});
