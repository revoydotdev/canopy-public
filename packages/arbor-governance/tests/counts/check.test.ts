import { describe, expect, it } from "vitest";
import { checkCounts, findExemptedClaims, HISTORICAL_CLAIM_MARKER, SUR_05_RULE_ID } from "../../src/counts/check.js";
import { deriveRepositoryCounts, type RepositoryCounts } from "../../src/counts/derive.js";
import { deriveCountDriftDocuments } from "../../src/counts/documents.js";

const REPO_ROOT = process.cwd();
const AT = "2026-08-04T00:00:00.000Z";

const FIXTURE_COUNTS: RepositoryCounts = {
  adr_total: 5,
  catalog_kinds: 3,
  src_files: 0,
  packages: 0,
  test_files: 7,
  allowlist_entries: 0,
  // Every quantity in this fixture is a real number the test chose, so nothing
  // is unmeasured. A fixture listing a quantity here would be asserting that
  // its source was unreadable.
  unmeasured: [],
};

describe("checkCounts — no false positives", () => {
  it("reports zero findings when every claim in the document agrees with the configured counts", () => {
    const findings = checkCounts(
      REPO_ROOT,
      ["packages/arbor-governance/tests/counts/fixtures/matching-claims.md"],
      FIXTURE_COUNTS,
      { at: AT, test_count: 42 },
    );
    expect(findings).toEqual([]);
  });

  it("skips a configured document that does not exist, rather than erroring", () => {
    const findings = checkCounts(REPO_ROOT, ["does/not/exist.md"], FIXTURE_COUNTS, { at: AT });
    expect(findings).toEqual([]);
  });

  it("does not check the <N> tests case-count claim when test_count is not supplied — absence, not a false 'matches'", () => {
    const findings = checkCounts(
      REPO_ROOT,
      ["packages/arbor-governance/tests/counts/fixtures/drifted-claims.md"],
      FIXTURE_COUNTS,
      { at: AT }, // no test_count
    );
    expect(findings.some((f) => f.detail.includes("test case count"))).toBe(false);
  });
});

describe("checkCounts — drifted fixture", () => {
  const findings = checkCounts(
    REPO_ROOT,
    ["packages/arbor-governance/tests/counts/fixtures/drifted-claims.md"],
    FIXTURE_COUNTS,
    { at: AT, test_count: 42 },
  );

  it("flags every mismatched pattern with rule_id SUR-05", () => {
    expect(findings.length).toBeGreaterThanOrEqual(4);
    expect(findings.every((f) => f.rule_id === SUR_05_RULE_ID)).toBe(true);
  });

  it("flags the compound '999 tests / 888 files' claim as both a test_count and a test_files mismatch", () => {
    expect(findings.some((f) => f.detail.includes("test case count") && f.detail.includes("999") && f.detail.includes("42"))).toBe(true);
    expect(findings.some((f) => f.detail.includes("test file count") && f.detail.includes("888") && f.detail.includes("7"))).toBe(true);
  });

  it("flags the standalone '555 test files' claim too", () => {
    expect(findings.filter((f) => f.detail.includes("test file count"))).toHaveLength(2); // compound (888) + standalone (555)
  });

  it("flags '777 ADRs' against the configured adr_total", () => {
    expect(findings.some((f) => f.detail.includes("ADR count") && f.detail.includes("777") && f.detail.includes("5"))).toBe(true);
  });

  it("flags '~666 kinds' against the configured catalog_kinds", () => {
    expect(findings.some((f) => f.detail.includes("RUNTIME_CATALOG kind count") && f.detail.includes("666") && f.detail.includes("3"))).toBe(true);
  });

  it("attaches evidence with the caller-supplied `at`, never its own clock", () => {
    for (const finding of findings) {
      expect(finding.evidence).toHaveLength(1);
      expect(finding.evidence[0]!.at).toBe(AT);
      expect(finding.evidence[0]!.producer).toMatch(/^arbor-governance\/counts\/check@/);
    }
  });

  it("marks every finding waiver-eligible legacy debt, not a hard blocker", () => {
    expect(findings.every((f) => f.waiver_eligible === true && f.is_legacy_debt === true)).toBe(true);
  });

  it("attaches a `doc`-kind ArtifactIdentity subject naming the offending file", () => {
    for (const finding of findings) {
      expect(finding.subject).toMatchObject({
        kind: "doc",
        path: "packages/arbor-governance/tests/counts/fixtures/drifted-claims.md",
      });
    }
  });
});

/**
 * These tests used to pin the *live drift* of two real documents as their
 * expectation ("flags SKILL.md's '21 ADRs'", "flags tools.ts's '~30 ...
 * kinds'"). That made the suite fail the moment somebody actually fixed the
 * documents — the test asserted on transient repository state rather than on
 * the checker's behaviour, so doing the right thing broke the build. Both
 * documents were corrected on 2026-08-06 (SKILL.md 21→29 ADRs, tools.ts
 * ~30→~54 kinds), and these are now regression guards in the opposite
 * direction. If one re-drifts, the corresponding assertion fails.
 *
 * The checker's positive detection behaviour is covered by the "drifted
 * fixture" suite above, which uses synthetic inputs that cannot be "fixed"
 * out from under it.
 *
 * What is asserted here is the property that actually matters and that nothing
 * else checks: the exact set of drifted claims across the whole derived
 * document set, against the real derived counts.
 *
 * CD-D-11 (2026-09-28): the recogniser was widened, and the set below is
 * therefore no longer empty. It was `toEqual([])` and had been RED since
 * `82ce26a1` introduced the two "43 ADR" sites — a check whose red is
 * invisible to anyone not running the unit suite. Enumerating the set instead
 * of asserting emptiness keeps the assertion strict in BOTH directions: a new
 * drifted claim fails here, and so does a FIXED one, which is the drift
 * register the gate prints. The 15 sites it enumerated were each corrected or
 * marked sur-05:historical on 2026-10-01, so the set is empty again; a new
 * drifted claim fails here exactly as `gate:sur-05` fails on it.
 */
describe("checkCounts — the whole derived document set, against the real counts", () => {
  const REAL_COUNTS = deriveRepositoryCounts(REPO_ROOT);
  const REAL_DOCUMENTS = deriveCountDriftDocuments(REPO_ROOT);

  it("reports exactly the known drifted claims, and no others", () => {
    const findings = checkCounts(REPO_ROOT, REAL_DOCUMENTS, REAL_COUNTS, { at: AT });
    // Named in the failure message so a regression says WHICH document drifted.
    expect(findings.map((f) => f.detail.slice(0, f.detail.indexOf(" claims ")))).toEqual([]);
  });

  it("checks a set large enough to include the documents that actually drifted", () => {
    // Guards against the derived set silently narrowing to nothing (a walk
    // that returns [] would make the assertion above vacuously true — the
    // G-24 shape). Each of these carried real drift on 2026-08-06.
    expect(REAL_DOCUMENTS).toContain("ROADMAP.md");
    expect(REAL_DOCUMENTS).toContain("README.md");
    expect(REAL_DOCUMENTS).toContain("AGENTS.md");
    expect(REAL_DOCUMENTS).toContain("docs/release-readiness.md");
    expect(REAL_DOCUMENTS).toContain("docs/operator-guide.md");
    expect(REAL_DOCUMENTS).toContain("packages/arbor-mcp/src/tools.ts");
    expect(REAL_DOCUMENTS.length).toBeGreaterThan(100);
  });

  it("exempts only lines that carry the marker, and every exemption is enumerable", () => {
    const exempted = findExemptedClaims(REPO_ROOT, REAL_DOCUMENTS);
    expect(exempted.length).toBeGreaterThan(0);
    for (const e of exempted) {
      expect(e.text).toContain(HISTORICAL_CLAIM_MARKER);
      expect(REAL_DOCUMENTS).toContain(e.document);
      expect(e.line).toBeGreaterThan(0);
    }
  });

  it("still detects drift in a checked document when the marker is absent", () => {
    // The enumerated-set result above must come from a checker that is still
    // finding things, not from one that has stopped. AGENTS.md is in the real
    // set and states the real ADR count; assert it against a wrong one.
    //
    // This deliberately no longer uses a test-count claim: exact test/file
    // totals were removed from prose on 2026-08-06 (they drift on every
    // commit that adds a test), so no live document carries one to check.
    const findings = checkCounts(
      REPO_ROOT,
      ["AGENTS.md"],
      { ...REAL_COUNTS, adr_total: REAL_COUNTS.adr_total + 1 },
      { at: AT },
    );
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.rule_id === SUR_05_RULE_ID)).toBe(true);
    expect(findings.some((f) => f.detail.includes("ADR count"))).toBe(true);
  });
});

describe("checkCounts — dotted-identifier false positive (fixed 2026-08-06)", () => {
  it("does not read 'Phase 4D.1 ADR' as a claim that the repository has 1 ADR", () => {
    const findings = checkCounts(
      REPO_ROOT,
      ["packages/arbor-governance/tests/counts/fixtures/dotted-identifier.md"],
      FIXTURE_COUNTS,
      { at: AT },
    );
    expect(findings.filter((f) => f.detail.includes("ADR count"))).toEqual([]);
  });

  it("still reads a genuine '5 ADRs' claim on a line that also has a dotted identifier", () => {
    const findings = checkCounts(
      REPO_ROOT,
      ["packages/arbor-governance/tests/counts/fixtures/dotted-identifier.md"],
      { ...FIXTURE_COUNTS, adr_total: 9 },
      { at: AT },
    );
    const adr = findings.filter((f) => f.detail.includes("ADR count"));
    expect(adr).toHaveLength(1);
    expect(adr[0]!.detail).toContain("5");
  });
});

/**
 * The absence-as-zero defect, and its blast radius.
 *
 * Every probe in `derive.ts` used to `return 0` when its source file was
 * missing or unparseable. Because `checkCounts` compares prose against those
 * numbers, a moved `runtime-catalog.ts` would have made `catalog_kinds` 0,
 * flagged every document truthfully saying "~54 kinds" as drifted, and emitted
 * a remediation string instructing the reader to write **0**. A gate that tells
 * you to replace a correct number with a false one is worse than no gate.
 *
 * Found while porting `baseline.mjs`, whose own probes had this right: they
 * reported UNMEASURED rather than a number they could not stand behind.
 */
describe("unmeasured quantities are absent, not zero", () => {
  it("derives an empty `unmeasured` against the real repository", () => {
    expect(deriveRepositoryCounts(REPO_ROOT).unmeasured).toEqual([]);
  });

  it("reports every derivable quantity as unmeasured for a directory that is not a repository", () => {
    const counts = deriveRepositoryCounts("/nonexistent-path-for-this-test");
    // The numbers are still 0 — but `unmeasured` is what says those zeros mean
    // "not known" rather than "none".
    expect(counts.unmeasured).toContain("adr_total");
    expect(counts.unmeasured).toContain("catalog_kinds");
    expect(counts.unmeasured).toContain("allowlist_entries");
    expect(counts.unmeasured).toContain("packages");
  });

  it("does NOT report drift for a quantity whose source could not be read", () => {
    // AGENTS.md truthfully states the real ADR count. With `adr_total`
    // unmeasured, the naive comparison would flag it against 0 and tell the
    // reader to write 0. Skipping is the only honest outcome.
    const findings = checkCounts(
      REPO_ROOT,
      ["AGENTS.md"],
      { ...FIXTURE_COUNTS, adr_total: 0, unmeasured: ["adr_total"] },
      { at: AT },
    );
    expect(findings.filter((f) => f.detail.includes("ADR count"))).toEqual([]);
  });

  it("still reports drift for that same quantity once it IS measured", () => {
    // Proves the skip above is scoped to unmeasured-ness, not a blanket mute:
    // the identical call with `unmeasured: []` must find the drift.
    const findings = checkCounts(
      REPO_ROOT,
      ["AGENTS.md"],
      { ...FIXTURE_COUNTS, adr_total: 0, unmeasured: [] },
      { at: AT },
    );
    expect(findings.some((f) => f.detail.includes("ADR count"))).toBe(true);
  });
});

/**
 * CD-D-11: the phrasings the widening added, and the three shapes it must not
 * mistake for claims. Every negative here is a real line from `docs/` — the
 * fixture is a transcription of corpus prose, not an invention, so a guard
 * change that starts flagging them is a real regression and not a fixture
 * artefact. See `.omo/graph-remediation/evidence/todo-17-DECLARED-EXPECTED-SET.txt`.
 */
describe("widened phrasings (CD-D-11)", () => {
  const COUNTS: RepositoryCounts = { ...FIXTURE_COUNTS, catalog_kinds: 195, packages: 14 };
  const findings = checkCounts(
    REPO_ROOT,
    ["packages/arbor-governance/tests/counts/fixtures/widened-claims.md"],
    COUNTS,
    { at: AT },
  );
  const claims = (quantity: string) => findings.filter((f) => f.detail.includes(quantity));

  it("flags a package-count claim the old four phrasings could not see", () => {
    expect(claims("(package count")).toHaveLength(1);
    expect(claims("(package count")[0]!.detail).toContain('claims "11 packages"');
  });

  it("flags a bare kind-count claim with no tilde", () => {
    expect(claims("RUNTIME_CATALOG kind count")).toHaveLength(1);
    expect(claims("RUNTIME_CATALOG kind count")[0]!.detail).toContain('claims "155 kinds"');
  });

  it("does NOT flag the correct phrasings it now recognises", () => {
    // POS-5/POS-6: a recogniser that cannot see a TRUE claim is not widened,
    // it is broken. `195 capability kinds` and `195 kinds` are both correct here.
    // Anchored on the quoted CLAIM, not the number 195: a drifted finding's
    // remediation text legitimately names the measured value.
    expect(findings.some((f) => f.detail.includes('claims "195'))).toBe(false);
  });

  it("does not read a parenthesised enumeration's member count as the total", () => {
    expect(findings.some((f) => f.detail.includes('claims "7 kinds"'))).toBe(false);
  });

  it("does not read an observed zero as a claim about the total", () => {
    // Rewriting "0 of 0 kinds" to 195 would be nonsense; the sentence reports
    // what the parity gate saw, not how many kinds exist.
    expect(findings.some((f) => f.detail.includes('claims "0 kinds"'))).toBe(false);
  });

  it("does not re-report a figure the line merely cites by file:line", () => {
    expect(findings.some((f) => f.detail.includes('claims "163 capability kinds"'))).toBe(false);
  });

  it("does not match a bare source-file count, which the census showed means something else", () => {
    expect(findings.some((f) => f.detail.includes('claims "22 source files"'))).toBe(false);
  });
});
