import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveRepositoryBaseline } from "../../src/vi/baseline.js";
import { deriveRepositoryCounts } from "../../src/counts/derive.js";

const TODAY = "2026-08-06";

// vitest runs from the repo root, so process.cwd() is the real checkout —
// matching counts/derive.test.ts's own convention of asserting against the
// real repository rather than a fixture for the "does this actually consume
// deriveRepositoryCounts" property.
const REPO_ROOT = process.cwd();

function makeFixture(): string {
  return mkdtempSync(join(tmpdir(), "arbor-governance-baseline-"));
}

describe("deriveRepositoryBaseline — real repo", () => {
  it("is a pure function: two calls return a deep-equal result", () => {
    const first = deriveRepositoryBaseline(REPO_ROOT, { today: TODAY });
    const second = deriveRepositoryBaseline(REPO_ROOT, { today: TODAY });
    expect(second).toEqual(first);
  });

  it("delegates waivers_total, adrs_total, and runtime_catalog_kinds to deriveRepositoryCounts rather than re-deriving them", () => {
    const counts = deriveRepositoryCounts(REPO_ROOT);
    const baseline = deriveRepositoryBaseline(REPO_ROOT, { today: TODAY });
    expect(baseline.waivers_total).toBe(counts.allowlist_entries);
    expect(baseline.adrs_total).toBe(counts.adr_total);
    expect(baseline.runtime_catalog_kinds).toBe(counts.catalog_kinds);
  });

  it("measures the git-grep-backed probes as real, non-negative numbers against the live tree", () => {
    const baseline = deriveRepositoryBaseline(REPO_ROOT, { today: TODAY });
    // Not pinned to exact literals (the tree moves — see derive.test.ts's own
    // rationale for src_files/test_files). What's asserted is that these
    // probes are genuinely MEASURED against a real git repo, not silently
    // unmeasured because git grep failed to find the worktree.
    expect(baseline.adrs_uncited_from_src.status).toBe("measured");
    expect(baseline.adr_citations_dangling.status).toBe("measured");
    expect(baseline.persist_ts_files.status).toBe("measured");
    expect(baseline.type_only_whole_clause.status).toBe("measured");
    expect(baseline.roadmap_proof_comments.status).toBe("measured");
    expect(baseline.entry_points.status).toBe("measured");
    if (baseline.persist_ts_files.status === "measured") {
      expect(baseline.persist_ts_files.value).toBeGreaterThan(0);
    }
    expect(baseline.type_only_inline_files).toBeGreaterThanOrEqual(0);
  });

  it("measures waiver ownership/expiry/authority against the real allowlist", () => {
    const baseline = deriveRepositoryBaseline(REPO_ROOT, { today: TODAY });
    expect(baseline.waivers_unowned.status).toBe("measured");
    expect(baseline.waivers_expired.status).toBe("measured");
    expect(baseline.waivers_authority_unresolved.status).toBe("measured");
    expect(baseline.waiver_gaps_dangling.status).toBe("measured");
  });
});

describe("deriveRepositoryBaseline — fixture repos exercising the honesty discipline", () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("reports UNMEASURED (not a false zero) for every allowlist-derived probe when the allowlist is missing", () => {
    root = makeFixture();
    const baseline = deriveRepositoryBaseline(root, { today: TODAY });

    expect(baseline.waivers_unowned).toEqual({ status: "unmeasured", reason: expect.stringContaining("allowlist.json") });
    expect(baseline.waivers_expired.status).toBe("unmeasured");
    expect(baseline.waivers_authority_unresolved.status).toBe("unmeasured");
    expect(baseline.waiver_gaps_dangling.status).toBe("unmeasured");
    // waivers_total still reports a real number (0) because it delegates to
    // deriveRepositoryCounts, which is silent-zero on a missing file — this
    // is the documented honesty gap this module inherits, not a bug here.
    expect(baseline.waivers_total).toBe(0);
  });

  it("measures zero waivers as a genuine zero (not unmeasured) when the allowlist exists but is empty", () => {
    root = makeFixture();
    mkdirSync(join(root, "scripts/reachability"), { recursive: true });
    writeFileSync(join(root, "scripts/reachability/allowlist.json"), JSON.stringify({ version: 1, entries: [] }));

    const baseline = deriveRepositoryBaseline(root, { today: TODAY });
    expect(baseline.waivers_unowned).toEqual({ status: "measured", value: 0 });
    expect(baseline.waivers_expired).toEqual({ status: "measured", value: 0 });
  });

  it("counts unowned and expired waivers correctly from a fixture allowlist", () => {
    root = makeFixture();
    mkdirSync(join(root, "scripts/reachability"), { recursive: true });
    writeFileSync(
      join(root, "scripts/reachability/allowlist.json"),
      JSON.stringify({
        version: 1,
        entries: [
          { symbol: "a", file: "packages/w/src/a.ts", owner: "alice", expires: "2099-01-01" },
          { symbol: "b", file: "packages/w/src/b.ts", expires: "2020-01-01" }, // unowned + expired
          { symbol: "c", file: "packages/w/src/c.ts", owner: "bob" }, // no expiry, owned
        ],
      }),
    );

    const baseline = deriveRepositoryBaseline(root, { today: TODAY });
    expect(baseline.waivers_unowned).toEqual({ status: "measured", value: 1 });
    expect(baseline.waivers_expired).toEqual({ status: "measured", value: 1 });
  });

  it("reports UNMEASURED for waiver authority probes when the gap register is missing", () => {
    root = makeFixture();
    mkdirSync(join(root, "scripts/reachability"), { recursive: true });
    writeFileSync(
      join(root, "scripts/reachability/allowlist.json"),
      JSON.stringify({ version: 1, entries: [{ symbol: "a", file: "packages/w/src/a.ts", gap: "G-01" }] }),
    );

    const baseline = deriveRepositoryBaseline(root, { today: TODAY });
    expect(baseline.waivers_authority_unresolved.status).toBe("unmeasured");
    expect(baseline.waiver_gaps_dangling.status).toBe("unmeasured");
  });

  it("measures waiver authority resolution and dangling gap ids against a real gap register", () => {
    root = makeFixture();
    mkdirSync(join(root, "scripts/reachability"), { recursive: true });
    mkdirSync(join(root, "audit"), { recursive: true });
    writeFileSync(join(root, "audit/10-gap-register.md"), "| G-01 | CLOSED |\n");
    writeFileSync(
      join(root, "scripts/reachability/allowlist.json"),
      JSON.stringify({
        version: 1,
        entries: [
          { symbol: "a", file: "packages/w/src/a.ts", gap: "G-01" }, // resolves
          { symbol: "b", file: "packages/w/src/b.ts", gap: "G-99" }, // dangling
        ],
      }),
    );

    const baseline = deriveRepositoryBaseline(root, { today: TODAY });
    expect(baseline.waivers_authority_unresolved).toEqual({ status: "measured", value: 1 });
    expect(baseline.waiver_gaps_dangling).toEqual({ status: "measured", value: ["G-99(x1)"] });
  });

  it("reports UNMEASURED for roadmap_proof_comments when ROADMAP.md is missing, and measures it when present", () => {
    root = makeFixture();
    const missing = deriveRepositoryBaseline(root, { today: TODAY });
    expect(missing.roadmap_proof_comments.status).toBe("unmeasured");

    writeFileSync(join(root, "ROADMAP.md"), "<!-- proof: G-01 -->\nsome text\n<!-- proof: G-02 -->\n");
    const present = deriveRepositoryBaseline(root, { today: TODAY });
    expect(present.roadmap_proof_comments).toEqual({ status: "measured", value: 2 });
  });

  it("honors a non-default roadmapPath option, and still reports UNMEASURED — not a false zero — when that path does not exist", () => {
    root = makeFixture();
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs/PLAN.md"), "<!-- proof: G-01 -->\n<!-- proof: G-02 -->\n<!-- proof: G-03 -->\n");

    // The default path finds nothing (no ROADMAP.md at repo root).
    const defaultPath = deriveRepositoryBaseline(root, { today: TODAY });
    expect(defaultPath.roadmap_proof_comments.status).toBe("unmeasured");

    // The option redirects the probe to the fixture's actual roadmap doc.
    const withOption = deriveRepositoryBaseline(root, { today: TODAY, roadmapPath: "docs/PLAN.md" });
    expect(withOption.roadmap_proof_comments).toEqual({ status: "measured", value: 3 });

    // A caller-supplied path that itself does not exist is UNMEASURED, never 0.
    const wrongOption = deriveRepositoryBaseline(root, { today: TODAY, roadmapPath: "docs/NOPE.md" });
    expect(wrongOption.roadmap_proof_comments).toEqual({ status: "unmeasured", reason: "docs/NOPE.md unreadable" });
  });

  it("honors a non-default gapRegisterPath option for waiver authority resolution", () => {
    root = makeFixture();
    mkdirSync(join(root, "scripts/reachability"), { recursive: true });
    mkdirSync(join(root, "governance"), { recursive: true });
    writeFileSync(join(root, "governance/gaps.md"), "| G-01 | CLOSED |\n");
    writeFileSync(
      join(root, "scripts/reachability/allowlist.json"),
      JSON.stringify({ version: 1, entries: [{ symbol: "a", file: "packages/w/src/a.ts", gap: "G-01" }] }),
    );

    // Default location (audit/10-gap-register.md) does not exist — unmeasured.
    const defaultPath = deriveRepositoryBaseline(root, { today: TODAY });
    expect(defaultPath.waivers_authority_unresolved.status).toBe("unmeasured");

    // The option redirects the probe to the fixture's actual gap register.
    const withOption = deriveRepositoryBaseline(root, { today: TODAY, gapRegisterPath: "governance/gaps.md" });
    expect(withOption.waivers_authority_unresolved).toEqual({ status: "measured", value: 0 });
  });

  it("CRITICAL: a fixture with no ROADMAP.md and no audit/ directory at all reports every dependent probe as UNMEASURED, never a false zero, across both roadmap- and gap-register-derived probes simultaneously", () => {
    root = makeFixture(); // nothing written at all: no ROADMAP.md, no audit/, no decisions/, no allowlist.
    const baseline = deriveRepositoryBaseline(root, { today: TODAY });

    expect(baseline.roadmap_proof_comments).toEqual({ status: "unmeasured", reason: "ROADMAP.md unreadable" });
    expect(baseline.waivers_authority_unresolved.status).toBe("unmeasured");
    expect(baseline.waiver_gaps_dangling.status).toBe("unmeasured");
    // Delegated counts (deriveRepositoryCounts) are the module's documented,
    // pre-existing honesty gap — waivers_total/adrs_total are real 0s here,
    // not fabricated non-zero values, and are asserted so a future change
    // that turns them into a false positive number would be caught.
    expect(baseline.waivers_total).toBe(0);
    expect(baseline.adrs_total).toBe(0);
  });

  it("reports UNMEASURED for entry_points when entry-points.json is missing or malformed", () => {
    root = makeFixture();
    const missing = deriveRepositoryBaseline(root, { today: TODAY });
    expect(missing.entry_points.status).toBe("unmeasured");

    mkdirSync(join(root, "scripts/reachability"), { recursive: true });
    writeFileSync(join(root, "scripts/reachability/entry-points.json"), JSON.stringify({ notEntryPoints: [] }));
    const malformed = deriveRepositoryBaseline(root, { today: TODAY });
    expect(malformed.entry_points.status).toBe("unmeasured");

    writeFileSync(
      join(root, "scripts/reachability/entry-points.json"),
      JSON.stringify({ entryPoints: [{ id: "a" }, { id: "b" }] }),
    );
    const present = deriveRepositoryBaseline(root, { today: TODAY });
    expect(present.entry_points).toEqual({ status: "measured", value: 2 });
  });

  it("reports UNMEASURED (never a false zero) for every git-grep-backed probe outside a real git repository", () => {
    root = makeFixture(); // a plain tmpdir, deliberately never `git init`'d
    const baseline = deriveRepositoryBaseline(root, { today: TODAY });

    expect(baseline.adrs_uncited_from_src.status).toBe("unmeasured");
    expect(baseline.adr_citations_dangling.status).toBe("unmeasured");
    expect(baseline.persist_ts_files.status).toBe("unmeasured");
    expect(baseline.type_only_whole_clause.status).toBe("unmeasured");
    // type_only_inline_files is deliberately NOT Probe-wrapped upstream (a
    // repo can genuinely have zero inline type imports) — it degrades to a
    // plain 0 here, which is the documented, intentional asymmetry.
    expect(baseline.type_only_inline_files).toBe(0);
  });
});
