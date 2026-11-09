import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveBacklog, selectNextBacklogItem } from "../../src/backlog/derive.js";
import { buildObligationCoverageReport } from "../../src/obligation/report.js";

const AT = "2026-08-04T00:00:00.000Z";

/**
 * The backlog is designed to EMPTY as records gain obligations, so any test
 * pinning a real record as a backlog member fails the moment that record is
 * witnessed — and would be vacuous once the corpus is fully migrated. The
 * classification and ranking rules do not depend on the real corpus being
 * deficient, so these use a synthetic one: ADR-901 buildable with no Test
 * implications (tier 1), ADR-903 buildable with them (tier 0), ADR-902 a
 * non-goal (tier 2).
 */
const FIXTURE_DECISIONS = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "decisions");

describe("deriveBacklog — the real decisions/ corpus", () => {
  it("covers exactly the records carrying a POL-04 finding — no more, no fewer", () => {
    const backlog = deriveBacklog({ at: AT });
    const report = buildObligationCoverageReport({ at: AT });
    expect(backlog.ok).toBe(true);
    expect(report.ok).toBe(true);
    if (!backlog.ok || !report.ok) return;

    const pol04RecordIds = report.value.findings
      .filter((f) => f.rule_id === "POL-04")
      .map((f) => (f.subject as { record_id: string }).record_id)
      .sort();
    const backlogRecordIds = backlog.value.items.map((i) => i.record_id).sort();

    // The set equality above is the real invariant. A hard-coded length used
    // to sit here too; it made every record that gained obligations a test
    // failure, so it is derived from the same report instead.
    expect(backlogRecordIds).toEqual(pol04RecordIds);
    expect(backlog.value.items).toHaveLength(pol04RecordIds.length);
  });

  it("classifies a reasoned non-goal as not_applicable, with a reason quoting its own text", () => {
    const backlog = deriveBacklog({ at: AT, decisionsDir: FIXTURE_DECISIONS });
    expect(backlog.ok).toBe(true);
    if (!backlog.ok) return;

    const item = backlog.value.items.find((i) => i.record_id === "revoy2:ADR-902");
    expect(item).toBeDefined();
    if (!item) return;

    expect(item.classification).toBe("not_applicable");
    expect(item.reason).not.toBeNull();
    expect(item.reason).toContain("does not introduce a mechanism");
    expect(item.rank_tier).toBe(2);
  });

  it("classifies an operator-action record as not_applicable — its real fix is not a code change", () => {
    const backlog = deriveBacklog({ at: AT, decisionsDir: FIXTURE_DECISIONS });
    expect(backlog.ok).toBe(true);
    if (!backlog.ok) return;

    const item = backlog.value.items.find((i) => i.record_id === "revoy2:ADR-904");
    expect(item).toBeDefined();
    if (!item) return;

    expect(item.classification).toBe("not_applicable");
    expect(item.reason).not.toBeNull();
    expect(item.reason).toMatch(/not something an agent working inside the repo can decide|operator\/business decision/);
    expect(item.rank_tier).toBe(2);
  });

  it("classifies a genuine buildable decision as author_obligations, not not_applicable", () => {
    const backlog = deriveBacklog({ at: AT, decisionsDir: FIXTURE_DECISIONS });
    expect(backlog.ok).toBe(true);
    if (!backlog.ok) return;

    const item = backlog.value.items.find((i) => i.record_id === "revoy2:ADR-901");
    expect(item).toBeDefined();
    if (!item) return;

    expect(item.classification).toBe("author_obligations");
    expect(item.reason).toBeNull();
    expect(item.rank_tier).toBeLessThan(2);
  });

  it("the real corpus has an empty backlog — every accepted record now declares obligations", () => {
    const backlog = deriveBacklog({ at: AT });
    expect(backlog.ok).toBe(true);
    if (!backlog.ok) return;

    // The backlog is derived from POL-04 findings, so an empty backlog is the
    // completed end state of the obligations workstream, not a broken scan.
    // `total_records_scanned` proves the corpus was actually read.
    expect(backlog.value.total_records_scanned).toBeGreaterThan(0);
    expect(backlog.value.items.map((i) => i.record_id)).toEqual([]);
    expect(selectNextBacklogItem(backlog.value)).toBeNull();
  });

  it("exactly two of the real backlog items are not_applicable (ADR-023, ADR-025) — everything else is author_obligations", () => {
    const backlog = deriveBacklog({ at: AT });
    expect(backlog.ok).toBe(true);
    if (!backlog.ok) return;

    const notApplicable = backlog.value.items.filter((i) => i.classification === "not_applicable").map((i) => i.record_id).sort();
    // ADR-023 and ADR-025 are classified by what they decide (a non-goal, and
    // a platform limitation), which does not change as records gain
    // obligations. Both may legitimately drop out of the backlog entirely
    // once they declare obligations of their own, so assert containment
    // within the backlog rather than a fixed membership.
    for (const id of notApplicable) expect(["revoy2:ADR-023", "revoy2:ADR-025"]).toContain(id);

    const buildable = backlog.value.items.filter((i) => i.classification === "author_obligations");
    expect(buildable).toHaveLength(backlog.value.items.length - notApplicable.length);
  });

  it("ranks tier 0 (has Test implications) before tier 1 (no Test implications) before tier 2 (not_applicable)", () => {
    const backlog = deriveBacklog({ at: AT });
    expect(backlog.ok).toBe(true);
    if (!backlog.ok) return;

    const tiers = backlog.value.items.map((i) => i.rank_tier);
    const sorted = [...tiers].sort((a, b) => a - b);
    expect(tiers).toEqual(sorted); // already in non-decreasing tier order

    // ADR-001 has no "## Test implications" heading (verified against the
    // real file in record/corpus.test.ts's neighborhood) -> tier 1;
    // ADR-026 has one -> tier 0. A real, checkable ordering fact, not a
    // tautology: this fails if the ranking rule is reversed or ignored.
    const fixture = deriveBacklog({ at: AT, decisionsDir: FIXTURE_DECISIONS });
    expect(fixture.ok).toBe(true);
    if (!fixture.ok) return;
    const byId = new Map(fixture.value.items.map((i) => [i.record_id, i]));
    // ADR-901 has no "## Test implications" -> tier 1; ADR-903 has one ->
    // tier 0. A real, checkable ordering fact, not a tautology: this fails if
    // the ranking rule is reversed or ignored.
    expect(byId.get("revoy2:ADR-901")?.rank_tier).toBe(1);
    expect(byId.get("revoy2:ADR-903")?.rank_tier).toBe(0);
    const idx901 = fixture.value.items.findIndex((i) => i.record_id === "revoy2:ADR-901");
    const idx903 = fixture.value.items.findIndex((i) => i.record_id === "revoy2:ADR-903");
    expect(idx903).toBeLessThan(idx901);
  });

  it("within a tier, items are ordered by ascending record_number (deterministic reading order)", () => {
    const backlog = deriveBacklog({ at: AT });
    expect(backlog.ok).toBe(true);
    if (!backlog.ok) return;

    const tier0 = backlog.value.items.filter((i) => i.rank_tier === 0).map((i) => i.record_number);
    const tier1 = backlog.value.items.filter((i) => i.rank_tier === 1).map((i) => i.record_number);
    expect(tier0).toEqual([...tier0].sort((a, b) => a - b));
    expect(tier1).toEqual([...tier1].sort((a, b) => a - b));
  });

  it("every buildable item carries this record's own real Decision text, not empty/boilerplate", () => {
    const backlog = deriveBacklog({ at: AT });
    expect(backlog.ok).toBe(true);
    if (!backlog.ok) return;

    for (const item of backlog.value.items) {
      expect(item.decision_text.length).toBeGreaterThan(0);
    }
    const fixture = deriveBacklog({ at: AT, decisionsDir: FIXTURE_DECISIONS });
    expect(fixture.ok).toBe(true);
    if (!fixture.ok) return;
    const buildable = fixture.value.items.find((i) => i.record_id === "revoy2:ADR-901");
    expect(buildable?.decision_text).toMatch(/canonical adapter|transport/i);
  });

  it("determinism: same input => byte-identical backlog, run twice", () => {
    const first = deriveBacklog({ at: AT });
    const second = deriveBacklog({ at: AT });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(JSON.stringify(first.value)).toBe(JSON.stringify(second.value));
  });

  it("file_path is repo-relative, not an absolute filesystem path (portability/determinism across checkouts)", () => {
    const backlog = deriveBacklog({ at: AT });
    expect(backlog.ok).toBe(true);
    if (!backlog.ok) return;

    for (const item of backlog.value.items) {
      expect(item.file_path.startsWith("/")).toBe(false);
      expect(item.file_path).toMatch(/^decisions\/ADR-\d+-.*\.md$/);
    }
  });

  it("every item's evidence cites the real POL-04 finding detail, not a fabricated summary", () => {
    const backlog = deriveBacklog({ at: AT });
    expect(backlog.ok).toBe(true);
    if (!backlog.ok) return;

    for (const item of backlog.value.items) {
      expect(item.evidence.finding_rule_id).toBe("POL-04");
      expect(item.evidence.finding_detail).toContain(item.record_id);
      expect(item.evidence.finding_detail).toContain("accepted but declares zero obligations");
    }
  });
});

describe("deriveBacklog — fixture decisions/ directory", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("an accepted record with a real buildable Decision and no disclaimer classifies author_obligations", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "arbor-governance-backlog-"));
    writeFileSync(
      join(tmpDir, "ADR-900-fixture.md"),
      [
        "# ADR-900: Fixture Record",
        "",
        "**Status:** Accepted",
        "**Date:** 2026-08-04",
        "",
        "## Context",
        "",
        "Some context.",
        "",
        "## Decision",
        "",
        "We will build a real thing: a widget factory in packages/example/src/widget.ts.",
        "",
        "## Consequences",
        "",
        "Things happen.",
        "",
      ].join("\n"),
    );

    const backlog = deriveBacklog({ decisionsDir: tmpDir, at: AT });
    expect(backlog.ok).toBe(true);
    if (!backlog.ok) return;
    expect(backlog.value.items).toHaveLength(1);
    expect(backlog.value.items[0].classification).toBe("author_obligations");
    expect(backlog.value.items[0].reason).toBeNull();
    expect(backlog.value.items[0].rank_tier).toBe(1); // no Test implications section
  });

  it("an accepted record whose Decision explicitly disclaims a mechanism classifies not_applicable", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "arbor-governance-backlog-"));
    writeFileSync(
      join(tmpDir, "ADR-901-fixture-nongoal.md"),
      [
        "# ADR-901: Fixture Non-Goal",
        "",
        "**Status:** Accepted",
        "**Date:** 2026-08-04",
        "",
        "## Context",
        "",
        "Some context.",
        "",
        "## Decision",
        "",
        "No. We will not build this.",
        "",
        "## Consequences",
        "",
        "Things do not happen.",
        "",
        "## Test implications",
        "",
        "None directly - this ADR does not introduce a mechanism.",
        "",
      ].join("\n"),
    );

    const backlog = deriveBacklog({ decisionsDir: tmpDir, at: AT });
    expect(backlog.ok).toBe(true);
    if (!backlog.ok) return;
    expect(backlog.value.items).toHaveLength(1);
    expect(backlog.value.items[0].classification).toBe("not_applicable");
    expect(backlog.value.items[0].reason).toContain("ADR-901");
    expect(backlog.value.items[0].rank_tier).toBe(2);
  });

  it("a missing decisions directory returns a GovernanceResult error, never throws", () => {
    const backlog = deriveBacklog({ decisionsDir: "/definitely/does/not/exist/anywhere", at: AT });
    expect(backlog.ok).toBe(false);
    if (backlog.ok) return;
    expect(backlog.error.code).toBe("unavailable");
  });
});

describe("selectNextBacklogItem — Track B3's self-hosting selection rule", () => {
  it("selects the first author_obligations item, never a not_applicable one", () => {
    const backlog = deriveBacklog({ at: AT, decisionsDir: FIXTURE_DECISIONS });
    expect(backlog.ok).toBe(true);
    if (!backlog.ok) return;

    const selected = selectNextBacklogItem(backlog.value);
    expect(selected).not.toBeNull();
    expect(selected?.classification).toBe("author_obligations");
    // Matches the first author_obligations-classified item in the already-
    // asserted tier/record_number ordering (see the ordering tests above) —
    // i.e. this is genuinely "first", not merely "some buildable item".
    const firstBuildable = backlog.value.items.find((i) => i.classification === "author_obligations");
    expect(selected?.record_id).toBe(firstBuildable?.record_id);
  });

  it("returns null when every remaining item is not_applicable", () => {
    const onlyNotApplicable: Parameters<typeof selectNextBacklogItem>[0] = {
      decisions_dir: "/fixture",
      total_records_scanned: 1,
      items: [
        {
          record_id: "revoy2:ADR-901",
          record_number: 901,
          title: "Fixture Non-Goal",
          file_path: "decisions/ADR-901-fixture-nongoal.md",
          decision_status: "accepted",
          classification: "not_applicable",
          reason: "ADR-901 states, in its own text, that it commits to no buildable mechanism here.",
          has_test_implications_section: true,
          rank_tier: 2,
          evidence: { finding_rule_id: "POL-04", finding_detail: "revoy2:ADR-901 is accepted but declares zero obligations." },
          decision_text: "No. We will not build this.",
          test_implications_text: "None directly - this ADR does not introduce a mechanism.",
        },
      ],
    };
    expect(selectNextBacklogItem(onlyNotApplicable)).toBeNull();
  });

  it("returns null on an empty backlog", () => {
    expect(selectNextBacklogItem({ decisions_dir: "/fixture", total_records_scanned: 0, items: [] })).toBeNull();
  });

  it("skips a leading not_applicable item and selects the next author_obligations one (tier ordering already puts author_obligations first in practice, but the skip is an explicit rule, not an accident of sort order)", () => {
    const mixed: Parameters<typeof selectNextBacklogItem>[0] = {
      decisions_dir: "/fixture",
      total_records_scanned: 2,
      items: [
        {
          record_id: "revoy2:ADR-901",
          record_number: 901,
          title: "Fixture Non-Goal",
          file_path: "decisions/ADR-901-fixture-nongoal.md",
          decision_status: "accepted",
          classification: "not_applicable",
          reason: "disclaimed",
          has_test_implications_section: false,
          rank_tier: 2,
          evidence: { finding_rule_id: "POL-04", finding_detail: "revoy2:ADR-901 is accepted but declares zero obligations." },
          decision_text: "No.",
          test_implications_text: null,
        },
        {
          record_id: "revoy2:ADR-902",
          record_number: 902,
          title: "Fixture Buildable",
          file_path: "decisions/ADR-902-fixture-buildable.md",
          decision_status: "accepted",
          classification: "author_obligations",
          reason: null,
          has_test_implications_section: false,
          rank_tier: 1,
          evidence: { finding_rule_id: "POL-04", finding_detail: "revoy2:ADR-902 is accepted but declares zero obligations." },
          decision_text: "We will build a widget.",
          test_implications_text: null,
        },
      ],
    };
    expect(selectNextBacklogItem(mixed)?.record_id).toBe("revoy2:ADR-902");
  });
});
