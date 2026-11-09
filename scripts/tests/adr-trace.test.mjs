import { describe, expect, it, beforeEach, afterEach, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseAdrReferences, buildTraceIndex, unclaimedCommits, backfillCandidates, governedPathPrefixes, knownAdrNumbers, miscitedCommits, pushedRange } from "../adr-trace.mjs";

const GATE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "adr-trace.mjs");

/**
 * Every case runs against a throwaway repository, per house convention
 * (`branch-accounting.test.mjs`) — proving the merge-base boundary and the
 * backfill report both require real branch topology and real commit
 * history, not a mock of `git log`'s output shape.
 */
let repo;

function git(...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * These fixtures intentionally exercise real commit topology. Disable both
 * Git maintenance paths before their first commit: otherwise CI may leave an
 * auto-maintenance child writing `.git/objects` while afterEach removes the
 * disposable repository, yielding ENOTEMPTY rather than a test result.
 */
function initializeRepo(branch) {
  git("init", "-q", "-b", branch);
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "maintenance.auto", "false");
  git("config", "gc.auto", "0");
  git("config", "gc.autoDetach", "false");
}

function commit(message, file = "scripts/f.txt", body = message) {
  const full = join(repo, file);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${body}\n`, "utf8");
  git("add", file);
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
}

function runCli(args) {
  const result = spawnSync("node", [GATE, "--repo", repo, "--json", ...args], { encoding: "utf-8" });
  return { code: result.status, stdout: result.stdout, report: JSON.parse(result.stdout) };
}

/**
 * The gate as the control plane actually spawns it: `bun run gate:adr-trace`,
 * which resolves to `bun scripts/adr-trace.mjs`. Used for the pushed-range
 * cases so the CLI runs in the same runtime that runs it in CI; the
 * pre-existing `node`-based `runCli` cases are unchanged.
 */
function runGateCli(args = [], env = {}) {
  const result = spawnSync("bun", [GATE, "--repo", repo, "--json", ...args], { encoding: "utf-8", env: { ...process.env, ...env } });
  // `--json` mode emits the report and NOTHING else. It used to append the text
  // path's `observed_count:` line, which forced this helper to slice stdout to
  // the leading document — so a `jq`-ing consumer of this gate was reading
  // unparseable output. The count is `report.audited_commit_count` in this mode.
  const stdout = result.stdout ?? "";
  return { code: result.status, stdout, stderr: result.stderr, report: JSON.parse(stdout) };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "adr-trace-"));
  initializeRepo("master");
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("parseAdrReferences — grammar fit to the real corpus", () => {
  it("parses a trailer line, single and comma-separated", () => {
    expect(parseAdrReferences("fix: thing\n\nbody\n\nADR: 074")).toEqual([74]);
    expect(parseAdrReferences("fix: thing\n\nADR: 074, 062")).toEqual([62, 74]);
  });

  it("parses the conventional-commit scope form", () => {
    expect(parseAdrReferences("docs(ADR-074): declare O1/O2 obligations with proofs")).toEqual([74]);
  });

  it("parses a trailing parenthetical, including comma lists", () => {
    expect(parseAdrReferences("feat(mcp): diff∪sibling mutation probe, evidence-only (ADR-069, X-2)")).toEqual([69]);
    expect(parseAdrReferences("feat(arbor-tui): carry a structured scene across RendererPort (ADR-036, ADR-037)")).toEqual([36, 37]);
  });

  it("expands an explicit 'through' range", () => {
    expect(parseAdrReferences("feat(gates): four attestation subsystems (ADR-032 through ADR-035)")).toEqual([32, 33, 34, 35]);
  });

  it("parses slash shorthand, both fully-repeated and bare-second-number forms", () => {
    expect(parseAdrReferences("Ships the deterministic runCampaign loop controller. ADR-001/ADR-005.")).toEqual([1, 5]);
    expect(parseAdrReferences("fix: correct ADR-048/051 accounting")).toEqual([48, 51]);
  });

  it("parses a bare authoring-commit mention", () => {
    expect(parseAdrReferences("docs: allocate ADR-073 project-profile-and-conformance-spec")).toEqual([73]);
  });

  it("does NOT treat an unrelated body mention as a claim", () => {
    // Real-shape case: the commit's own subject claims ADR-028; the body
    // merely discusses ADR-024 in passing. Only the subject's ADR counts.
    const message = "docs: correct a claim (ADR-028)\n\nADR-024's boundary-2 discussion cited ops-server.ts, but this commit is about ADR-028.";
    expect(parseAdrReferences(message)).toEqual([28]);
  });

  it("returns [] for unparseable input — not an error", () => {
    expect(parseAdrReferences("fix: unrelated bug in the parser")).toEqual([]);
    expect(parseAdrReferences("")).toEqual([]);
    expect(parseAdrReferences(null)).toEqual([]);
  });

  it("dedupes and sorts ascending regardless of source order", () => {
    expect(parseAdrReferences("fix(ADR-074): x (ADR-062, ADR-074)")).toEqual([62, 74]);
  });
});

describe("governedPathPrefixes", () => {
  it("falls back to the documented default when no profile exists", () => {
    expect(governedPathPrefixes(repo)).toEqual(["packages", "decisions", "scripts"]);
  });
});

describe("buildTraceIndex", () => {
  it("maps each ADR to the union of files touched by commits claiming it", () => {
    commit("feat(scripts): first (ADR-100)", "scripts/a.mjs");
    commit("feat(scripts): second (ADR-100)", "scripts/b.mjs");
    commit("feat(scripts): third (ADR-101)", "scripts/c.mjs");
    commit("chore: unrelated, no claim", "scripts/d.mjs");

    const index = buildTraceIndex({ repo });
    expect(index["100"].files.sort()).toEqual(["scripts/a.mjs", "scripts/b.mjs"]);
    expect(index["100"].commits).toHaveLength(2);
    expect(index["101"].files).toEqual(["scripts/c.mjs"]);
    expect(index["999"]).toBeUndefined();
  });

  it("attributes one file touched by two ADRs to both", () => {
    commit("feat(scripts): shared (ADR-200)", "scripts/shared.mjs", "v1");
    commit("feat(scripts): shared again (ADR-201)", "scripts/shared.mjs", "v2");

    const index = buildTraceIndex({ repo });
    expect(index["200"].files).toEqual(["scripts/shared.mjs"]);
    expect(index["201"].files).toEqual(["scripts/shared.mjs"]);
  });
});

describe("unclaimedCommits", () => {
  it("flags a governed-path commit with no ADR claim", () => {
    commit("chore: tweak a gate", "scripts/gate.mjs");
    const unclaimed = unclaimedCommits({ repo });
    expect(unclaimed).toHaveLength(1);
    expect(unclaimed[0].subject).toBe("chore: tweak a gate");
    expect(unclaimed[0].files).toEqual(["scripts/gate.mjs"]);
  });

  it("does not flag a claimed commit", () => {
    commit("feat(scripts): gate (ADR-100)", "scripts/gate.mjs");
    expect(unclaimedCommits({ repo })).toEqual([]);
  });

  it("does not flag a commit that touches no governed path", () => {
    commit("chore: readme tweak", "README.md");
    expect(unclaimedCommits({ repo })).toEqual([]);
  });
});

describe("the merge-base boundary — pre-existing unclaimed history must not fail the gate", () => {
  it("a fresh branch off a master with old unclaimed history exits 0 when the branch adds nothing unclaimed", () => {
    commit("chore: old unclaimed work on master", "scripts/old.mjs"); // pre-existing, unclaimed
    git("checkout", "-q", "-b", "feature");
    commit("feat(scripts): new claimed work (ADR-300)", "scripts/new.mjs");

    const { code, report } = runCli([]);
    expect(code).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.unclaimed_commit_count).toBe(0);
  });

  it("the SAME repo still shows the old unclaimed commit via unclaimedCommits({ since: null }) — it is excluded by the boundary, not invisible", () => {
    commit("chore: old unclaimed work on master", "scripts/old.mjs");
    git("checkout", "-q", "-b", "feature");
    commit("feat(scripts): new claimed work (ADR-300)", "scripts/new.mjs");

    const full = unclaimedCommits({ repo });
    expect(full.map((c) => c.subject)).toContain("chore: old unclaimed work on master");
  });

  it("FAILS when the branch's OWN range introduces an unclaimed governed-path commit", () => {
    commit("chore: base", "scripts/base.mjs");
    git("checkout", "-q", "-b", "feature");
    commit("chore: unclaimed on the branch", "scripts/branch.mjs");

    const { code, report } = runCli([]);
    expect(code).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.unclaimed_commit_count).toBe(1);
    expect(report.unclaimed_commits[0].subject).toBe("chore: unclaimed on the branch");
  });

  it("REFUSES to report a pass when HEAD IS master — an empty DERIVED range is not an empty push", () => {
    commit("chore: unclaimed straight on master", "scripts/m.mjs");
    const { code, report } = runGateCli([]);
    // The pre-change behaviour was exit 0 here. That is the defect: on
    // `push: master` the local `master` ref sits at HEAD, so the derived range
    // is empty and the gate reported PASS having measured zero commits.
    expect(code).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.range_resolved).toBe(false);
    expect(report.range_source).toBeNull();
    expect(report.unresolved_detail).toMatch(/HEAD IS master/);
  });

  it("REFUSES to report a pass when there is no master ref at all", () => {
    // Re-init on a differently-named default branch with no master anywhere.
    rmSync(repo, { recursive: true, force: true });
    repo = mkdtempSync(join(tmpdir(), "adr-trace-nomaster-"));
    initializeRepo("trunk");
    commit("chore: unclaimed, no master ref exists", "scripts/x.mjs");

    const { code, report } = runGateCli([]);
    expect(code).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.range_resolved).toBe(false);
    expect(report.boundary_ref).toBeNull();
    expect(report.unresolved_detail).toMatch(/no `master` ref/);
  });
});

/**
 * R2-03: the range must be the range that was PUSHED.
 *
 * The defect this pins is invisible to a canary — the gate behaves identically
 * on both ranges — so it is only provable as a pair: the same repository, the
 * same commit, one inside the pushed range and one outside it.
 */
describe("the pushed range, not a local master ref", () => {
  /**
   * master:  base ── BEFORE ── AFTER  ← this is what was pushed
   *                              └─ OUTSIDE (unclaimed, on master, after the push)
   *
   * `OUTSIDE` is the dangerous case in the other direction too: because it
   * touches a governed path with no `ADR:` trailer, a gate that widened to
   * "everything since the branch fork" would report it, and a gate that fell
   * back to the merge-base would report it on any later run. Only the pushed
   * range excludes it.
   */
  function seedPushWithStrayCommit() {
    const before = commit("chore: base", "scripts/base.mjs");
    const inside = commit("chore: unclaimed inside the push", "scripts/inside.mjs");
    const after = git("rev-parse", "HEAD");
    // HEAD stays on master; the stray lands after the pushed range. No local
    // `master` ref moves it out of the way — it IS master.
    commit("chore: unclaimed outside the push", "scripts/outside.mjs");
    return { before, inside, after };
  }

  it("POSITIVE: audits exactly the supplied pushed range and catches an unclaimed governed commit inside it", () => {
    const { before, after } = seedPushWithStrayCommit();
    const { code, stdout, report } = runGateCli(["--range", `${before}..${after}`]);
    expect(report.range_resolved).toBe(true);
    expect(report.range_source).toBe("explicit_range");
    expect(report.range).toBe(`${before}..${after}`);
    expect(report.unclaimed_commit_count).toBe(1);
    expect(report.unclaimed_commits[0].subject).toBe("chore: unclaimed inside the push");
    expect(code).toBe(1);
    // The structured form of the text path's `observed_count: 1`.
    expect(report.audited_commit_count).toBe(1);
  });

  it("NEGATIVE CONTROL: an unclaimed governed commit OUTSIDE the pushed range is not reported", () => {
    // The pushed range carries only CLAIMED work, so if the stray outside it
    // were being counted the gate would go red here. A green narrow range plus
    // a red wide range over the same repository is the pair that proves the
    // range is narrowed rather than merely unioned or ignored.
    const before = commit("chore: base", "scripts/base.mjs");
    const after = commit("feat(scripts): claimed work in the push (ADR-100)", "scripts/claimed.mjs");
    commit("chore: unclaimed, outside the push", "scripts/outside.mjs");

    const narrow = runGateCli(["--range", `${before}..${after}`]);
    expect(narrow.report.range_resolved).toBe(true);
    expect(narrow.report.unclaimed_commits).toEqual([]);
    expect(narrow.code).toBe(0);

    // Same repository, same instant, one commit wider: the stray IS visible.
    // Its absence above is therefore the range, not an inert gate.
    const wide = runGateCli(["--range", `${before}..HEAD`]);
    expect(wide.report.unclaimed_commits.map((c) => c.subject)).toEqual(["chore: unclaimed, outside the push"]);
    expect(wide.code).toBe(1);

    // And the pre-change fallback would have caught it too — which is the
    // local/CI disagreement this change removes, pinned in both directions.
    expect(unclaimedCommits({ repo, since: before, until: git("rev-parse", "HEAD") }).map((c) => c.subject)).toContain("chore: unclaimed, outside the push");
  });

  it("reads the pushed range from the CI event payload — the push:master case the defect lived in", () => {
    const { before, after } = seedPushWithStrayCommit();
    const eventPath = join(repo, "event.json");
    writeFileSync(eventPath, JSON.stringify({ before, after }), "utf8");
    const { code, report } = runGateCli([], { GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: "push" });
    expect(report.range_resolved).toBe(true);
    expect(report.range_source).toBe("ci_event");
    expect(report.range).toBe(`${before}..${after}`);
    expect(report.unclaimed_commits.map((c) => c.subject)).toEqual(["chore: unclaimed inside the push"]);
    expect(code).toBe(1);
  });

  it("a CI event whose before/after does not resolve is UNRESOLVED, not an empty range", () => {
    seedPushWithStrayCommit();
    const eventPath = join(repo, "event.json");
    // The first push to a new branch: GitHub sends an all-zero `before`.
    writeFileSync(eventPath, JSON.stringify({ before: "0".repeat(40), after: "HEAD" }), "utf8");
    const { code, report } = runGateCli([], { GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: "push" });
    expect(report.range_resolved).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.unresolved_detail).toMatch(/no resolvable before\.\.after/);
    expect(code).toBe(1);
  });

  it("a pull_request event is read as base.sha..head.sha", () => {
    const before = commit("chore: base", "scripts/base.mjs");
    const head = commit("chore: unclaimed inside the PR", "scripts/pr.mjs");
    const eventPath = join(repo, "event.json");
    writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: before }, head: { sha: head } } }), "utf8");
    const { report } = runGateCli([], { GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: "pull_request" });
    expect(report.range_source).toBe("ci_event");
    expect(report.range).toBe(`${before}..${head}`);
    expect(report.unclaimed_commits).toHaveLength(1);
  });

  it("an empty but AUTHORITATIVE range is a real pass — a push that carried no commits", () => {
    const at = commit("chore: base", "scripts/base.mjs");
    const { code, report } = runGateCli(["--range", `${at}..${at}`]);
    expect(report.range_resolved).toBe(true);
    expect(report.ok).toBe(true);
    // Zero is a real observation here, and the distinction from an unresolved
    // range is the point: a push that carried nothing is a pass, a push whose
    // range could not be determined is not.
    expect(report.audited_commit_count).toBe(0);
    expect(code).toBe(0);
  });

  it("--range is an explicit override: it beats a CI event payload that says otherwise", () => {
    const before = commit("chore: base", "scripts/base.mjs");
    const inside = commit("chore: unclaimed inside", "scripts/inside.mjs");
    const after = git("rev-parse", "HEAD");
    commit("chore: later", "scripts/later.mjs");
    const eventPath = join(repo, "event.json");
    writeFileSync(eventPath, JSON.stringify({ before: after, after }), "utf8");
    const { report } = runGateCli(["--range", `${before}..${after}`], { GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: "push" });
    expect(report.range_source).toBe("explicit_range");
    expect(report.unclaimed_commits).toHaveLength(1);
    expect(report.unclaimed_commits[0].hash).toBe(inside);
  });

  it("pushedRange() derives from master only as a labelled local guess, never as the pushed range", () => {
    commit("chore: base", "scripts/base.mjs");
    git("checkout", "-q", "-b", "feature");
    const before = git("rev-parse", "HEAD");
    commit("chore: work", "scripts/w.mjs");
    const resolved = pushedRange({ repo, explicit: null, env: {} });
    expect(resolved.kind).toBe("resolved");
    expect(resolved.source).toBe("derived_merge_base");
    expect(resolved.before).toBe(before);
  });

  it("pushedRange() reports unresolved — never empty — when nothing establishes a range", () => {
    commit("chore: base", "scripts/base.mjs");
    expect(pushedRange({ repo, explicit: null, env: {} })).toMatchObject({ kind: "unresolved", source: "derived_merge_base" });
  });

  it("a malformed --range is UNRESOLVED, not silently ignored", () => {
    commit("chore: base", "scripts/base.mjs");
    const { code, report } = runGateCli(["--range", "HEAD"]);
    expect(report.range_resolved).toBe(false);
    expect(report.unresolved_detail).toMatch(/<before>\.\.<after>/);
    expect(code).toBe(1);
  });
});

describe("--json shape", () => {
  it("reports ok, boundary, boundary_ref, unclaimed_commit_count, unclaimed_commits", () => {
    commit("chore: base", "scripts/base.mjs");
    git("checkout", "-q", "-b", "feature");
    commit("chore: unclaimed", "scripts/x.mjs");
    const { report } = runCli([]);
    expect(report).toHaveProperty("ok");
    expect(report).toHaveProperty("boundary");
    expect(report).toHaveProperty("boundary_ref", "master");
    expect(report).toHaveProperty("unclaimed_commit_count", 1);
    expect(Array.isArray(report.unclaimed_commits)).toBe(true);
    expect(report.unclaimed_commits[0]).toHaveProperty("hash");
    expect(report.unclaimed_commits[0]).toHaveProperty("subject");
    expect(report.unclaimed_commits[0]).toHaveProperty("files");
  });
});

describe("--backfill-report — never emits an inferred claim as fact", () => {
  it("proposes a candidate ONLY when the commit touches decisions/ADR-0NN-*.md directly", () => {
    commit("docs: allocate ADR-500 something", "decisions/ADR-500-something.md", "# ADR-500");
    commit("chore: unrelated scripts change", "scripts/unrelated.mjs");

    const candidates = backfillCandidates({ repo });
    const withEvidence = candidates.find((c) => c.subject.includes("ADR-500"));
    // "docs: allocate ADR-500 something" IS itself parsed as a claim by the
    // bare-mention rule (it matches the real adr-registry.mjs convention),
    // so it must NOT appear in the unclaimed set at all.
    expect(withEvidence).toBeUndefined();

    const unrelated = candidates.find((c) => c.subject.includes("unrelated"));
    expect(unrelated.candidate_adrs).toEqual([]);
    expect(unrelated.evidence).toBeNull();
  });

  it("proposes a candidate for a commit that touches an ADR file WITHOUT naming it in the subject", () => {
    commit("fix: typo in decisions", "decisions/ADR-501-something-else.md", "# ADR-501 typo fix");
    const candidates = backfillCandidates({ repo });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].candidate_adrs).toEqual([501]);
    expect(candidates[0].evidence).toMatch(/ADR-501/);
  });

  it("never writes anything — the repository is untouched other than the commits already made", () => {
    commit("fix: typo in decisions", "decisions/ADR-502-x.md", "# ADR-502");
    const before = git("status", "--porcelain");
    backfillCandidates({ repo });
    runCli(["--backfill-report"]);
    const after = git("status", "--porcelain");
    expect(after).toBe(before);
  });

  it("CLI --backfill-report always exits 0 — it is a report, not a gate", () => {
    commit("chore: unclaimed", "scripts/x.mjs");
    const result = spawnSync("node", [GATE, "--repo", repo, "--json", "--backfill-report"], { encoding: "utf-8" });
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.total_unclaimed).toBe(1);
    expect(report.with_unambiguous_candidate).toBe(0);
  });
});

describe("--trace — the forward query (ADR -> work produced)", () => {
  /**
   * buildTraceIndex always computed this map; the gate consumed it only to
   * derive the violation set and then discarded it. So the script could say
   * "this commit claims no ADR" but could not answer "what was built under
   * ADR-076?" — with the answer in memory a moment earlier.
   *
   * The mode stays DERIVED, which is ADR-075's point: no ADR declares a file
   * list, so no file list can drift. These tests pin that it reads git and
   * writes nothing.
   *
   * Unlike buildTraceIndex/unclaimedCommits above (each of which runs
   * against its own throwaway mkdtemp repo), these tests assert over the
   * ENTIRE live commit history of this checkout — every ADR claim ever
   * made, by anyone. That is a broad-state read in the ADR-078 sense: a
   * commit or branch landing in the live checkout mid-run (this repo's
   * normal concurrent-agent operating mode) can change `out.trace`
   * underneath an assertion. Per ADR-078 category 1, freeze a local
   * shared-object clone of HEAD once at module load and run every case's Git
   * query against that snapshot instead. The child still invokes the current
   * working-tree script source: otherwise focused tests silently execute an
   * older committed implementation and cannot validate the change under test.
   * A detached worktree used to provide the
   * same bytes, but it also mutated the canonical repository's shared
   * `.git/worktrees` registry while the determinism lane ran many other
   * worktree-heavy files concurrently. The clone reads the same object
   * database without participating in that collision domain. `adr-trace.mjs`
   * is dependency-free, so do not create a hardlinked `node_modules` tree in
   * every worker snapshot: it adds a large concurrent cleanup surface without
   * contributing to this read-only Node CLI proof.
   */
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const SNAPSHOT_PARENT = mkdtempSync(join(dirname(REPO_ROOT), ".adr-trace-snapshot-"));
  const SNAPSHOT_DIR = join(SNAPSHOT_PARENT, "repo");
  execFileSync("git", ["clone", "-q", "--shared", REPO_ROOT, SNAPSHOT_DIR], { cwd: REPO_ROOT });
  execFileSync("git", ["checkout", "-q", "--detach", "HEAD"], { cwd: SNAPSHOT_DIR });

  const SCRIPT = join(REPO_ROOT, "scripts", "adr-trace.mjs");

  afterAll(() => {
    rmSync(SNAPSHOT_PARENT, { recursive: true, force: true });
  });

  function trace(args) {
    // This script is plain ESM and has no Bun-only imports. Reusing the
    // already-running Node executable removes a nested Bun startup from the
    // saturated CI process pool while preserving a real child-process CLI
    // proof against the frozen repository snapshot.
    const r = spawnSync(process.execPath, [SCRIPT, "--trace", "--json", ...args], { cwd: SNAPSHOT_DIR, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    const stdout = r.stdout ?? "";
    const stderr = r.stderr ?? "";
    if (r.error !== undefined) throw new Error(`adr-trace child could not start: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`adr-trace child exited ${r.status ?? "without status"}: ${stderr.trim() || stdout.trim() || "no output"}`);
    if (stdout.trim().length === 0) throw new Error(`adr-trace child exited successfully without JSON output${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
    try { return JSON.parse(stdout); }
    catch (error) { throw new Error(`adr-trace child emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}; stderr: ${stderr.trim() || "(empty)"}`); }
  }

  it("emits an ADR-keyed map of commits and files", () => {
    const out = trace([]);
    expect(out.ok).toBe(true);
    const adrs = Object.keys(out.trace);
    expect(adrs.length).toBeGreaterThan(0);
    const sample = out.trace[adrs[0]];
    expect(Array.isArray(sample.files)).toBe(true);
    expect(Array.isArray(sample.commits)).toBe(true);
    expect(sample.commits[0]).toHaveProperty("hash");
    expect(sample.commits[0]).toHaveProperty("subject");
  });

  it("--adr narrows to one decision", () => {
    const all = trace([]);
    const one = Object.keys(all.trace)[0];
    const out = trace(["--adr", one]);
    expect(Object.keys(out.trace)).toEqual([one]);
    expect(out.adr).toBe(Number(one));
  });

  it("--since scopes the window, which is what makes a session answer possible", () => {
    const full = trace([]);
    const scoped = trace(["--since", "HEAD~1"]);
    expect(scoped.since).toBe("HEAD~1");
    // A one-commit window cannot name more decisions than all of history.
    expect(Object.keys(scoped.trace).length).toBeLessThanOrEqual(Object.keys(full.trace).length);
  });

  it("writes nothing — it is a read-only projection of git history", () => {
    const before = spawnSync("git", ["status", "--porcelain"], { cwd: SNAPSHOT_DIR, encoding: "utf8" }).stdout;
    trace([]);
    const after = spawnSync("git", ["status", "--porcelain"], { cwd: SNAPSHOT_DIR, encoding: "utf8" }).stdout;
    expect(after).toBe(before);
  });
});

// --- a trailer is not a citation unless it resolves --------------------------
//
// Both this gate and the commit-msg guard used to accept any 1-3 digit number:
// `parseAdrReferences(msg).length > 0` was the whole test. 13 commits in this
// repository carry `ADR: 148`, which has no file, no allocation and no index
// row, and every layer passed them.

function seedRegistry({ allocations = [154], reserved = [86] } = {}) {
  mkdirSync(join(repo, "decisions"), { recursive: true });
  writeFileSync(
    join(repo, "decisions", "registry.json"),
    JSON.stringify({
      schema_version: 1,
      next_available: 200,
      reserved,
      reserved_reason: {},
      allocations: allocations.map((number) => ({ number, slug: `s-${number}`, placeholder_id: `x:${number}` })),
    }, null, 2),
  );
}

describe("knownAdrNumbers", () => {
  it("accepts allocated records and the registry's reserved cross-namespace numbers", () => {
    seedRegistry({ allocations: [1, 154], reserved: [86] });
    const known = knownAdrNumbers(repo);
    expect(known.has(1)).toBe(true);
    expect(known.has(154)).toBe(true);
    // reserved_reason documents these as citations of ANOTHER repository's
    // decisions: real references with no local file.
    expect(known.has(86)).toBe(true);
  });

  it("rejects a number that is neither allocated nor reserved", () => {
    seedRegistry();
    const known = knownAdrNumbers(repo);
    expect(known.has(148)).toBe(false);
    expect(known.has(999)).toBe(false);
  });

  it("returns null when there is no registry, so a missing boundary cannot manufacture a failure", () => {
    expect(knownAdrNumbers(repo)).toBeNull();
  });
});

describe("miscitedCommits", () => {
  it("reports a governed commit whose every citation resolves to nothing", () => {
    seedRegistry();
    commit("fix(scripts): thing\n\nADR: 999", "scripts/thing.mjs");
    const found = miscitedCommits({ repo });
    expect(found).toHaveLength(1);
    expect(found[0].cited).toEqual([999]);
    expect(found[0].files).toEqual(["scripts/thing.mjs"]);
  });

  it("does NOT report a commit that also cites a real record", () => {
    seedRegistry();
    commit("fix(scripts): thing\n\nADR: 154, 999", "scripts/thing.mjs");
    expect(miscitedCommits({ repo })).toEqual([]);
  });

  it("does NOT report a commit touching no governed path", () => {
    seedRegistry();
    commit("docs: thing\n\nADR: 999", "README.md");
    expect(miscitedCommits({ repo })).toEqual([]);
  });

  it("does NOT report a commit with no citation — that is unclaimedCommits' job", () => {
    seedRegistry();
    commit("fix(scripts): thing", "scripts/thing.mjs");
    expect(miscitedCommits({ repo })).toEqual([]);
    expect(unclaimedCommits({ repo })).toHaveLength(1);
  });

  it("reports nothing at all when the repository has no registry", () => {
    commit("fix(scripts): thing\n\nADR: 999", "scripts/thing.mjs");
    expect(miscitedCommits({ repo })).toEqual([]);
  });
});
