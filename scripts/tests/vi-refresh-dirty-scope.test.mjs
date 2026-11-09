import { describe, expect, it, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirtyExtractionScopePaths, formatDirtyScopeRefusal } from "../vi-refresh.mjs";

/**
 * CD-BR-05 (high) — the clean-worktree extraction rule held only by luck.
 *
 * The graph was correct only because extraction happened to run in a clean
 * worktree at a pinned revision. Re-extracting from a dirty checkout makes
 * every citation into a changed file silently wrong — the graph still builds,
 * every gate still passes, and nothing in the artifact says so. The old
 * behaviour counted dirty paths at the very BOTTOM of `main()`, after the
 * graph had already been written, and only printed a NOTE.
 *
 * ORACLE DISCIPLINE — stated honestly, because the honest version is weaker
 * than the usual one. The outcomes below were declared in
 * `.omo/graph-remediation/evidence/todo-23-DECLARED-EXPECTED-SET.txt`, which
 * states the scope BY HAND out of `arbor.profile.jsonc` and the committed
 * `scripts/lib/vi-input-binding.mjs` predicates, and hand-predicts that MAIN's
 * 58 dirty paths split 56 in-scope / 2 out. That hand count is falsifiable and
 * it was stated before any run. It is NOT a blind pre-registration in the sense
 * todos 8/11/14/15/17/18/21 achieved: this guard and this file were already
 * present as uncommitted changes in the worktree when the todo was resumed, so
 * the author had read the implementation first. An earlier draft of this
 * docblock claimed the expected set "was written BEFORE scripts/vi-refresh.mjs
 * was edited" and cited a file that did not exist on disk — a false citation
 * about a false provenance claim, which is the exact shape this plan exists to
 * kill. The compensating control is the mutation test: the guard is deleted,
 * every refusal assertion below is required to go red, and the file restored
 * byte-identically. D1 is the control that must stay GREEN throughout.
 *
 * The profile below is a LITERAL, not a read of the real `arbor.profile.jsonc`:
 * if the guard were tested against a profile it also reads at runtime, a change
 * to that file would silently move the oracle along with the instrument.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VI_REFRESH = join(REPO_ROOT, "scripts", "vi-refresh.mjs");

const PROFILE = Object.freeze({
  source_roots: ["packages"],
  citation_roots: ["packages", "scripts"],
  governance: {
    decisions_dir: "decisions",
    evidence_stores: [".claim-ledger", ".completion-depth", ".determinism-baseline", ".visual-intelligence"],
  },
});

const fixtures = [];

/** A real git repo with a real `git status` — the guard reads porcelain, not a fixture. */
function makeRepo({ omit = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "vi-dirty-scope-"));
  fixtures.push(dir);
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "arbor.profile.jsonc"), `${JSON.stringify(PROFILE, null, 2)}\n`);
  for (const p of [
    "packages/arbor-core/src/a.ts",
    "scripts/reachability.mjs",
    "scripts/reachability/entry-points.json",
    "decisions/ADR-001-x.md",
    "README.md",
    "docs/some.md",
    "packages/arbor-core/.claim-ledger/out.json",
  ]) {
    if (omit.includes(p)) continue;
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), "original\n");
  }
  git("add", "-A");
  git("commit", "-qm", "base");

  return {
    dir,
    dirty: (p) => writeFileSync(join(dir, p), "changed\n"),
    untracked: (p) => {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), "new\n");
    },
    stage: (p) => git("add", "--", p),
    remove: (p) => git("rm", "-q", "--", p),
    scope: () => dirtyExtractionScopePaths({ root: dir, toolRoot: dir, profile: PROFILE }),
    all: () => execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: dir, encoding: "utf8" })
      .split("\n").filter((l) => l.trim()).length,
  };
}

/**
 * Run the REAL entry point end to end. The guard fires before any extractor, so
 * a fixture needs no package layout — only a real git state.
 */
function runRefresh(args) {
  try {
    const stdout = execFileSync("node", [VI_REFRESH, ...args], {
      cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status ?? 1, stdout: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CD-BR-05 — extraction refuses a tree dirty IN THE EXTRACTION SCOPE", () => {
  // D1. THE REQUIRED CONTROL. A gate that cannot succeed fails closed forever,
  // which is the same defect wearing a safety hat.
  it("D1 clean tree is NOT refused", () => {
    expect(makeRepo().scope()).toEqual([]);
  });

  // D11. D1 exercises the exported predicate; this one exercises the REAL
  // entry point, because "the function returns []" and "the program lets a
  // clean tree through" are different claims and only the second is the rule.
  // The fixture is stripped of its entry-points file on purpose: the guard
  // sits BEFORE that check, so the run must sail past the guard and stop at
  // the next thing instead — naming that next stop is what makes "it was not
  // the guard that stopped it" a checkable statement rather than a hope.
  it("D11 the real entry point lets a CLEAN tree through the guard", () => {
    // Built WITHOUT the entry-points file on purpose: the guard sits BEFORE that
    // check, so a clean tree must sail past the guard and stop at the next
    // thing instead. Naming that next stop is what makes "it was not the guard
    // that stopped it" a checkable statement rather than a hope. The tree is
    // clean in the full sense — `git status` empty — so the guard has no
    // legitimate reason to fire.
    const r = makeRepo({ omit: ["scripts/reachability/entry-points.json"] });
    const { code, stdout } = runRefresh(["--root", r.dir, "--check"]);
    expect(stdout, "a clean tree must never be refused").not.toContain("REFUSED");
    expect(stdout).toContain("canonical root set missing");
    expect(code).toBe(1);
  });

  it("D2 modified source under packages/ is refused", () => {
    const r = makeRepo();
    r.dirty("packages/arbor-core/src/a.ts");
    expect(r.scope()).toEqual(["packages/arbor-core/src/a.ts"]);
  });

  it("D3 a modified reachability input is refused", () => {
    const r = makeRepo();
    r.dirty("scripts/reachability/entry-points.json");
    expect(r.scope()).toEqual(["scripts/reachability/entry-points.json"]);
  });

  it("D4 a modified ADR in the decisions corpus is refused", () => {
    const r = makeRepo();
    r.dirty("decisions/ADR-001-x.md");
    expect(r.scope()).toEqual(["decisions/ADR-001-x.md"]);
  });

  it("D5 a modified arbor.profile.jsonc is refused", () => {
    const r = makeRepo();
    r.dirty("arbor.profile.jsonc");
    expect(r.scope()).toEqual(["arbor.profile.jsonc"]);
  });

  it("D7 an UNTRACKED in-scope file is refused, not just modifications", () => {
    const r = makeRepo();
    r.untracked("packages/arbor-core/src/new.ts");
    expect(r.scope()).toEqual(["packages/arbor-core/src/new.ts"]);
  });

  it("D8 a STAGED but uncommitted in-scope change is refused", () => {
    const r = makeRepo();
    r.dirty("packages/arbor-core/src/a.ts");
    r.stage("packages/arbor-core/src/a.ts");
    expect(r.scope()).toEqual(["packages/arbor-core/src/a.ts"]);
  });

  it("D9 a DELETED in-scope path is refused", () => {
    const r = makeRepo();
    r.remove("packages/arbor-core/src/a.ts");
    expect(r.scope()).toEqual(["packages/arbor-core/src/a.ts"]);
  });
});

describe("CD-BR-05 — the guard is SCOPED, not blanket", () => {
  // D12. This is the only control that can tell a scoped guard from a blanket
  // `porcelain.length > 0`: both pass D1, and a blanket guard would refuse here
  // on a dirty README — which is not an input to extraction and cannot change
  // one node of the graph.
  it("D12 dirt OUTSIDE the extraction scope is not refused", () => {
    const r = makeRepo();
    r.dirty("README.md");
    r.dirty("docs/some.md");
    expect(r.all()).toBe(2);
    expect(r.scope()).toEqual([]);
  });

  it("D12b out-of-scope and in-scope dirt together reports ONLY the in-scope paths", () => {
    const r = makeRepo();
    r.dirty("README.md");
    r.dirty("packages/arbor-core/src/a.ts");
    r.dirty("docs/some.md");
    expect(r.all()).toBe(3);
    // Set equality both ways + pinned count — NOT membership, which survives
    // deletion from the expected set (redemption #6 in this plan).
    expect(r.scope()).toEqual(["packages/arbor-core/src/a.ts"]);
    expect(r.scope()).toHaveLength(1);
  });

  // D10. Not a weakening: `vi-refresh.mjs` already subtracts these everywhere
  // else, because evidence:rebind leaves each producer's derived store
  // uncommitted. A guard that ignored the subtraction would refuse on a
  // legitimately dirty tree — the failure mode this todo names.
  it("D10 a configured evidence store inside the scope is not source drift", () => {
    const r = makeRepo();
    r.dirty("packages/arbor-core/src/generated.json");
    const store = "packages/arbor-core/src/generated.json";
    // Load-bearing: with the store declared, the path is excluded...
    expect(dirtyExtractionScopePaths({
      root: r.dir, toolRoot: r.dir,
      profile: { ...PROFILE, governance: { ...PROFILE.governance, evidence_stores: [store] } },
    })).toEqual([]);
    // ...and it is the DECLARATION doing the work, not the scope: the same
    // path is in scope the moment the store is not configured.
    expect(r.scope()).toEqual([store]);
  });

  // Honest limit, asserted rather than implied. revoy2's four configured
  // stores are all at the REPO ROOT while the scope is packages/ + scripts/ +
  // decisions/ + 7 literals + 2 skill dirs, so for THIS profile the subtraction
  // never overlaps the scope at all — it is defensive, not load-bearing. A
  // first draft of this test asserted otherwise using a store nested under
  // packages/, which does not exist in this repository; that test would have
  // passed for the wrong reason, so it was removed rather than kept as
  // coverage. D10 above exercises the mechanism under a profile where it does
  // overlap, which is the only honest way to give it a control.
  it("D10b MEASURED: revoy2's own evidence stores do not overlap the extraction scope", () => {
    const overlap = PROFILE.governance.evidence_stores.filter((store) => {
      const probe = `${store}/probe.json`;
      return dirtyExtractionScopePaths({
        root: (() => { const r = makeRepo(); r.untracked(probe); return r.dir; })(),
        toolRoot: null,
        profile: PROFILE,
      }).includes(probe);
    });
    expect(overlap).toEqual([]);
  });
});

describe("CD-BR-05 — the refusal text (scripts/README.md gate rule 1)", () => {
  const paths = ["packages/a/src/one.ts", "packages/b/src/two.ts", "scripts/reachability/entry-points.json"];
  const text = formatDirtyScopeRefusal({ inScope: paths, outOfScopeCount: 2, toolRootIsForeign: false });

  it("D16 names every in-scope dirty path verbatim", () => {
    for (const p of paths) expect(text).toContain(p);
  });

  it("D16b names the CAUSE, not just 'FAIL'", () => {
    expect(text).toMatch(/REFUSED/);
    expect(text).toMatch(/EXTRACTION SCOPE/);
  });

  it("D16c contains exactly ONE remedy command, and it is the stash", () => {
    const commands = text.split("\n").filter((line) => /^\s{2,}\S/.test(line) && /\bgit\b|\bbun\b|\bnpm\b|\bnode\b/.test(line));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("git stash push -u --");
  });

  it("D16d states how many out-of-scope paths were deliberately NOT refused", () => {
    expect(text).toContain("2 dirty path(s) in this checkout that are");
  });

  it("D16d2 the out-of-scope count is never negative across two checkouts", () => {
    // A foreign --root makes the in-scope set span two checkouts. Subtracting
    // that union from one checkout's total printed "-1 dirty path(s)"; the
    // first version of this file asserted the arithmetic instead of the text,
    // so the bug shipped. Assert the count is reported verbatim.
    const t = formatDirtyScopeRefusal({ inScope: paths, outOfScopeCount: 0, toolRootIsForeign: true });
    expect(t).toContain("0 dirty path(s) in this checkout that are");
    expect(t).not.toMatch(/-\d+ dirty path/);
  });

  it("D16e truncation is stated, never silent", () => {
    const many = Array.from({ length: 45 }, (_, i) => `packages/p${i}/src/f.ts`);
    const t = formatDirtyScopeRefusal({ inScope: many, outOfScopeCount: 0, toolRootIsForeign: false });
    expect(t).toContain("and 5 more");
  });
});

describe("CD-BR-05 — no flag bypasses the guard (plan QA-failure clause)", () => {
  // D13/D14/D15/D17. A guard bypassable by a flag is decorative.
  it("D17 every accepted flag still refuses a dirty in-scope tree", () => {
    const r = makeRepo();
    r.dirty("packages/arbor-core/src/a.ts");
    for (const args of [["--root", r.dir], ["--root", r.dir, "--check"], ["--root", r.dir, "--force"]]) {
      const { code, stdout } = runRefresh(args);
      expect(code, `expected refusal for ${JSON.stringify(args)}`).toBe(1);
      expect(stdout).toContain("REFUSED");
      expect(stdout).toContain("packages/arbor-core/src/a.ts");
      expect(stdout).toContain("git stash push -u --");
    }
  });

  it("D15 --force does not let a dirty OUT-of-scope tree be blamed", () => {
    // Asserted on WHICH paths are named, not on whether a refusal happened at
    // all: a foreign --root also checks this checkout's tool-side scope, which
    // is legitimately dirty while this guard is being written. The scoped-vs-
    // blanket question is answered by the README's absence from the refusal —
    // which holds whether or not the tool side is dirty.
    const r = makeRepo();
    r.dirty("README.md");
    const { stdout } = runRefresh(["--root", r.dir, "--force"]);
    expect(stdout).not.toContain("README.md");
    expect(stdout).not.toContain("'README.md'");
  });
});
