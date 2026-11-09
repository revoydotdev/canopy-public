/**
 * `inject.evidence-staleness` — the native replacement for the deleted
 * `scripts/hooks/evidence-staleness-nudge.{sh,mjs}`.
 *
 * THE CONDITION IS TWO-PART, and both parts are load-bearing:
 *
 *   1. HEAD's own commit touches `packages/` or `decisions/`. A commit that
 *      missed the graphed domain cannot have staled a store whose content hash
 *      covers the graphed domain, so mentioning it would cry wolf.
 *   2. `scripts/store-freshness-gate.mjs` — the SAME check `gate:store-freshness`
 *      and the stop tier already trust — reports at least one store not `ok`.
 *
 * The deleted hook was a PostToolUse nudge: the `.sh` wrapper decoded a Claude
 * Code payload, tested that the tool was a `Bash` call running `git commit`
 * (with the same `git` anchoring `git-write-guard.sh` used, so "gitcommit-thing"
 * never matched), and handed off. Parts 1 and 2 above ARE that decision; the
 * Bash-call trigger was a HOST detail, and the host's tool-call boundary is not
 * a moment revoy2 owns. The native seam is the turn boundary, so the nudge
 * lands on the next prompt rather than immediately after the commit tool call
 * — a real difference in TIMING, stated here rather than hidden.
 *
 * What did NOT change, and matters more: it is purely ADVISORY. The hook had no
 * veto in its host contract and this one has no decision field, so nothing
 * becomes unenforced either way — `gate:store-freshness` still blocks the
 * push. And it still never runs the rebind itself: `evidence:rebind` takes
 * minutes and holds the evidence lease, which is why this is a nudge and not
 * automation.
 *
 * The gate is SUBPROCESSED, not reimplemented, for the same reason the decision
 * queue is: a second freshness verdict would be a second implementation of an
 * invariant `gate:store-freshness` owns, and its drift would be silent.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HookCatalog } from "../../src/hooks/catalog.js";
import { GitAdapter } from "../../src/git-workspace-projection.js";
import {
  EVIDENCE_STALENESS_REMEDY,
  buildStalenessNudge,
  evidenceStalenessTropism,
  runStoreFreshness,
  type StoreFreshnessReport,
} from "../../src/hooks/evidence-staleness-tropism.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const STALE: StoreFreshnessReport = Object.freeze({
  ok: false,
  stores: Object.freeze([
    Object.freeze({ name: "claim-ledger", state: "fail" }),
    Object.freeze({ name: "vi-observed", state: "fail" }),
    Object.freeze({ name: "determinism-baseline", state: "advisory" }),
  ]),
});
const FRESH: StoreFreshnessReport = Object.freeze({
  ok: true,
  stores: Object.freeze([Object.freeze({ name: "claim-ledger", state: "ok" })]),
});

const git = (root: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" });

describe("inject.evidence-staleness", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "arbor-staleness-"));
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "test@example.invalid");
    git(root, "config", "user.name", "test");
  });

  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  /** A commit whose own diff is the named path, so HEAD's commit is the one under test. */
  const commit = (path: string, contents = "x\n"): void => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
    git(root, "add", "--", path);
    git(root, "commit", "-q", "-m", `add ${path}`);
  };

  describe("the two-part condition", () => {
    it("nudges when HEAD touched the graphed domain AND a store is stale", () => {
      commit("packages/a.ts");

      const tropism = evidenceStalenessTropism(root, () => STALE);

      expect(tropism).not.toBeNull();
      expect(tropism!.body).toContain("claim-ledger, vi-observed, determinism-baseline");
      expect(tropism!.body).toContain(EVIDENCE_STALENESS_REMEDY);
    });

    it("stays silent when the commit missed the graphed domain, however stale the stores are", () => {
      // Part 1 false. A `docs/` edit invalidates no store whose content hash
      // covers `packages/` and `decisions/`, so this is the crying-wolf case.
      commit("docs/readme.md");

      expect(evidenceStalenessTropism(root, () => STALE)).toBeNull();
    });

    it("stays silent when the commit touched the domain but every store is fresh", () => {
      // Part 2 false. Nothing went stale; the nudge would be noise.
      commit("decisions/ADR-001-x.md");

      expect(evidenceStalenessTropism(root, () => FRESH)).toBeNull();
    });

    it("stays silent when neither part holds", () => {
      commit("docs/readme.md");
      expect(evidenceStalenessTropism(root, () => FRESH)).toBeNull();
    });

    it("handles the initial commit, which has no parent to diff against", () => {
      // The deleted script's own edge case, and a real one: a repository's
      // first commit has no HEAD~1, and a handler that only knew how to diff
      // two revisions would report "not a commit touching the domain" on
      // exactly the commit most likely to have staled everything.
      commit("packages/first.ts");

      expect(evidenceStalenessTropism(root, () => STALE)).not.toBeNull();
    });

    it("measures HEAD's own commit, not the whole history", () => {
      commit("packages/first.ts");
      commit("docs/second.md");

      // The second commit missed the graphed domain, so the nudge stops —
      // which is correct even though an earlier commit still has un-rebound
      // stores, because the remedy (`evidence:rebind`) regenerates against
      // HEAD and covers every source commit since the last one.
      expect(evidenceStalenessTropism(root, () => STALE)).toBeNull();
    });

    it("declines to assert anything when the gate could not be read", () => {
      // The script's own rule: a broken check must not become a bogus nudge.
      // `null` is also what an unrunnable subprocess returns.
      commit("packages/a.ts");

      expect(evidenceStalenessTropism(root, () => null)).toBeNull();
    });
  });

  describe("the message", () => {
    it("names the stale stores, the remedy, and the ordering the header demanded", () => {
      const message = buildStalenessNudge(["claim-ledger", "vi-observed"]);

      expect(message).toContain("claim-ledger, vi-observed");
      expect(message).toContain(EVIDENCE_STALENESS_REMEDY);
      // The three things the deleted script's message existed to say: ONE
      // rebind covers the whole series, run it when the series is FINISHED,
      // and the rebind commit is separate or nobody else sees it.
      expect(message).toMatch(/one rebind covers every source commit/i);
      expect(message).toMatch(/SEPARATE/i);
      expect(message).toMatch(/does not auto-run/i);
    });

    it("says 'unknown' rather than an empty list when no store name could be read", () => {
      expect(buildStalenessNudge([])).toContain("unknown");
    });
  });

  describe("the tropism itself", () => {
    const build = (): NonNullable<ReturnType<typeof evidenceStalenessTropism>> => {
      commit("packages/a.ts");
      return evidenceStalenessTropism(root, () => STALE)!;
    };

    it("passes the catalog's §5.3 lints as ADVISORY, with no decision field at all", () => {
      const tropism = build();

      expect(new HookCatalog().validateTropism(tropism)).toBeNull();
      expect(tropism.lane).toBe("ADVISORY");
      expect(tropism.enforcing_ref).toBeNull();
      expect(tropism.provenance).toBe("generated");
    });

    it("moves its derivation when the stale set moves, and when HEAD moves", () => {
      const first = build();
      const sameStale = evidenceStalenessTropism(root, () => STALE)!;
      const fewerStale = evidenceStalenessTropism(root, () => ({ ok: false, stores: [{ name: "claim-ledger", state: "fail" }] }))!;

      // §5.3 rule 2 dedupes a scope whose derivation did not move, so a
      // constant here would make the nudge permanently silent — the failure
      // mode this lane is most able to hide, since a nudge that vanishes looks
      // exactly like a repository with nothing stale.
      expect(sameStale.derived_from).toEqual(first.derived_from);
      expect(fewerStale.derived_from).not.toEqual(first.derived_from);

      commit("packages/b.ts");
      const nextCommit = evidenceStalenessTropism(root, () => STALE)!;
      expect(nextCommit.derived_from).not.toEqual(first.derived_from);
    });
  });

  describe("the per-turn cost", () => {
    it("re-reads HEAD once per turn instead of re-deriving the same commit every time", () => {
      commit("packages/a.ts");
      const real = GitAdapter.prototype.run;
      let spawns = 0;
      vi.spyOn(GitAdapter.prototype, "run").mockImplementation(function counting(this: GitAdapter, args: readonly string[]) {
        spawns += 1;
        return real.call(this, args);
      });

      evidenceStalenessTropism(root, () => STALE);
      const first = spawns;
      spawns = 0;
      evidenceStalenessTropism(root, () => STALE);
      const second = spawns;

      // `HEAD~1` and the domain diff are functions of HEAD's own oid, so at an
      // unchanged HEAD they are the same answer every turn and must not be
      // re-derived. The only read a second turn genuinely needs is "did HEAD
      // move", because that is the one thing it cannot know without asking.
      // Uncached this handler ran ELEVEN `git` processes per turn (two
      // `GitAdapter` constructions plus three `rev-parse`s and two diffs) and
      // the 53897b9e cache covered only the 896 ms subprocess.
      expect(first).toBeGreaterThan(1);
      expect(second).toBe(1);
      expect(spawns).toBe(second);
    });

    it("re-derives when HEAD moves, so a cached verdict is never a stale one", () => {
      commit("packages/a.ts");
      expect(evidenceStalenessTropism(root, () => STALE)).not.toBeNull();

      // A commit that missed the graphed domain closes the nudge. Reading that
      // off a cache keyed on anything but HEAD would keep reporting it.
      commit("docs/readme.md");
      expect(evidenceStalenessTropism(root, () => STALE)).toBeNull();

      commit("packages/b.ts");
      expect(evidenceStalenessTropism(root, () => STALE)).not.toBeNull();
    });

    it("still moves its derivation when the STALE SET moves at an unchanged HEAD", () => {
      // The 53897b9e trap, kept as a test. A cache keyed on anything wider than
      // HEAD (a working-tree status of the store directories, say) freezes this
      // answer, and the gate compares COMMITTED store bytes to the WORKING TREE
      // — so a store edit with no commit changes the verdict. The report runner
      // is therefore never cached, only HEAD's own derived facts.
      commit("packages/a.ts");
      const first = evidenceStalenessTropism(root, () => STALE)!;
      const fewer = evidenceStalenessTropism(root, () => ({ ok: false, stores: [{ name: "claim-ledger", state: "fail" }] }))!;
      expect(fewer.derived_from).not.toEqual(first.derived_from);
    });

    it("does not memoize a verdict for a repository that has no commit yet", () => {
      // `headState` answers `null` before the first commit, and `null` is NOT
      // memoized: caching it would leave a repository that gains its first
      // commit permanently silent, which is the one repository most likely to
      // have staled everything.
      mkdirSync(join(root, "packages"), { recursive: true });
      writeFileSync(join(root, "packages", "pending.ts"), "x\n");
      git(root, "add", "--", "packages/pending.ts");
      expect(evidenceStalenessTropism(root, () => STALE)).toBeNull();
      commit("packages/a.ts");
      expect(evidenceStalenessTropism(root, () => STALE)).not.toBeNull();
    });
  });

  describe("the freshness gate it trusts", () => {
    it("subprocesses scripts/store-freshness-gate.mjs --json rather than reimplementing it", () => {
      const root = mkdtempSync(join(tmpdir(), "arbor-staleness-gate-"));
      try {
        mkdirSync(join(root, "scripts"), { recursive: true });
        const argvLog = join(root, "argv.json");
        writeFileSync(join(root, "scripts", "store-freshness-gate.mjs"), [
          `import { writeFileSync } from "node:fs";`,
          `writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));`,
          `console.log(JSON.stringify({ ok: false, stores: [{ name: "claim-ledger", state: "fail" }] }));`,
        ].join("\n"));

        const result = runStoreFreshness(root, join(root, "scripts", "store-freshness-gate.mjs"));

        expect(JSON.parse(JSON.stringify(result))).toEqual({ ok: false, stores: [{ name: "claim-ledger", state: "fail" }] });
        expect(JSON.parse(readFileSync(argvLog, "utf8"))).toEqual(["--json"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("returns nothing for a missing gate or unparseable output, rather than guessing", () => {
      const empty = mkdtempSync(join(tmpdir(), "arbor-staleness-none-"));
      try {
        expect(runStoreFreshness(empty, join(empty, "scripts", "store-freshness-gate.mjs"))).toBeNull();
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    });

    it("finds the real gate in this repository, so the default runner is wired", () => {
      // Existence only — never its verdict. A test that ran the real gate would
      // assert on repository state, which is a different test entirely.
      expect(runStoreFreshness(REPO_ROOT, join(REPO_ROOT, "scripts", "does-not-exist.mjs"))).toBeNull();
    });
  });
});
