import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanDecisionsCorpus } from "../../src/record/corpus.js";
import { classifyCorpusCitations, CITATION_MIGRATION_AT_UNSET } from "../../src/record/migrate.js";

// packages/arbor-governance/tests/migration/citations.test.ts -> repo root is
// four directories up.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const DECISIONS_DIR = join(REPO_ROOT, "decisions");
const FIXED_AT = "2026-08-05T00:00:00.000Z";

describe("citation migration honesty triad — real corpus (decisions/*.md)", () => {
  it("resolves the real corpus deterministically and reports the true breakdown", () => {
    const scan1 = scanDecisionsCorpus(DECISIONS_DIR, { at: FIXED_AT });
    const scan2 = scanDecisionsCorpus(DECISIONS_DIR, { at: FIXED_AT });
    expect(scan1.ok).toBe(true);
    expect(scan2.ok).toBe(true);
    if (!scan1.ok || !scan2.ok) return;

    const report = scan1.value.citations;

    // Re-running must be byte-identical (determinism, no wall-clock, no randomness).
    expect(JSON.stringify(scan2.value.citations)).toBe(JSON.stringify(report));

    // Print the real numbers so a human running this test sees them directly,
    // matching corpus.test.ts's existing convention (console.log of real
    // fields, not a formatter helper — this migration's human-reviewable
    // artifact IS the structured CitationMigrationReport itself).
    // eslint-disable-next-line no-console
    console.log(
      `[record/migrate] ${report.total_records} records: ${report.records_with_no_citations} with no citations, ` +
        `${report.records_fully_resolved} fully resolved, ${report.records_with_unresolved_citations} with unresolved ` +
        `citations, ${report.records_unparseable} unparseable`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `[record/migrate] ${report.total_citations} total citations — resolved_by_confidence: ` +
        `${JSON.stringify(report.resolved_by_confidence)}, none: ${report.unresolved_count}`,
    );
    for (const fact of report.facts) {
      // eslint-disable-next-line no-console
      console.log(
        `  ${fact.source_record_id} -> ${fact.citation_token} [${fact.method}${fact.confidence ? `/${fact.confidence}` : ""}] ${fact.target ?? "(unresolved)"} — ${fact.reason}`,
      );
    }

    expect(report.total_records).toBeGreaterThan(0);
    expect(report.records_unparseable).toBe(0);
    // An accounting identity, not a corpus size: every record lands in exactly
    // one of the three buckets. Pinning the literal made adding an ADR a
    // failure while saying nothing extra about the migration.
    expect(
      report.records_with_no_citations + report.records_fully_resolved + report.records_with_unresolved_citations,
    ).toBe(report.total_records);

    // A migration that resolves everything is a warning sign, not a success —
    // assert the real corpus does NOT do that: at least one citation must
    // come out unresolved (the audit's own finding: ADR-027 cites
    // revoy-spec's ADR-045, ADR-006 cites revoy-spec's ADR-086, neither of
    // which is a local revoy2 record).
    expect(report.unresolved_count).toBeGreaterThan(0);
    expect(report.records_with_unresolved_citations).toBeGreaterThan(0);

    // Every rollup must reconcile against the raw facts — no silent drift
    // between the summary counters and what's actually in `facts`.
    const factsByMethod = { resolved: 0, none: 0 };
    for (const fact of report.facts) {
      if (fact.method === "none") factsByMethod.none += 1;
      else factsByMethod.resolved += 1;
    }
    expect(factsByMethod.none).toBe(report.unresolved_count);
    expect(factsByMethod.resolved).toBe(
      Object.values(report.resolved_by_confidence).reduce((a, b) => a + b, 0),
    );
    expect(report.total_citations).toBe(report.facts.length);

    const sumResolved = report.per_record.reduce((sum, r) => sum + r.resolved_count, 0);
    const sumUnresolved = report.per_record.reduce((sum, r) => sum + r.unresolved_count, 0);
    expect(sumResolved).toBe(factsByMethod.resolved);
    expect(sumUnresolved).toBe(factsByMethod.none);

    // Migration honesty invariant 1: every resolved fact carries method +
    // confidence + provenance (EvidenceRef), and confidence is never above
    // "medium" — this migration never verifies relevance, only text
    // co-occurrence, so it must never claim "high"/"authoritative".
    for (const fact of report.facts) {
      if (fact.method === "none") {
        expect(fact.confidence).toBeNull();
        expect(fact.target).toBeNull();
        expect(fact.evidence).toHaveLength(0);
      } else {
        expect(fact.method).toBe("derived"); // never "declared" (no structured field exists) or "observed"
        expect(fact.confidence).toBe("medium");
        expect(fact.target).not.toBeNull();
        expect(fact.evidence).toHaveLength(1);
        expect(fact.evidence[0].producer).toContain("arbor-governance/record-migration");
        expect(fact.evidence[0].at).toBe(FIXED_AT);
        expect(fact.evidence[0].content_hash).toBeTruthy();
      }
      // Migration honesty invariant 2: nothing is ever tagged "verified" —
      // Confidence has no such value, but assert the stronger textual
      // contract too: "authoritative" (the closest analog to "verified" in
      // this vocabulary) is never produced by a text-mention-only migration.
      expect(fact.confidence).not.toBe("authoritative");
    }

    // Migration honesty invariant 3: resolution is a property of the local
    // corpus, never of a historically convenient example number.
    const localNumbers = new Set(scan1.value.results.flatMap((entry) => entry.record ? [entry.record.record_number] : []));
    for (const fact of report.facts.filter((entry) => entry.method === "none")) {
      expect(localNumbers.has(fact.cited_number)).toBe(false);
      expect(fact.target).toBeNull();
    }

    // A genuinely local, in-range citation resolves — ADR-023 cites ADR-006,
    // a real local record.
    const adr006FromAdr023 = report.facts.find(
      (f) => f.source_record_id === "revoy2:ADR-023" && f.cited_number === 6,
    );
    expect(adr006FromAdr023).toBeDefined();
    expect(adr006FromAdr023?.method).toBe("derived");
    expect(adr006FromAdr023?.target).toBe("revoy2:ADR-006");
  });

  it("scanDecisionsCorpus defaults the citation report's `at` to the documented sentinel when no options are passed (today's real, unmodified `governance-projection.ts` call shape)", () => {
    const result = scanDecisionsCorpus(DECISIONS_DIR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.citations.at).toBe(CITATION_MIGRATION_AT_UNSET);
    for (const fact of result.value.citations.facts) {
      if (fact.evidence.length > 0) expect(fact.evidence[0].at).toBe(CITATION_MIGRATION_AT_UNSET);
    }
  });

  it("is a pure function of its LegacyReadResult input — same input, same output, called directly", () => {
    const result = scanDecisionsCorpus(DECISIONS_DIR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const a = classifyCorpusCitations(result.value.results, { at: FIXED_AT });
    const b = classifyCorpusCitations(result.value.results, { at: FIXED_AT });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never fabricates a resolution: an unresolvable citation stays unresolved rather than being defaulted", () => {
    const fixture = [
      {
        source_path: "decisions/ADR-900-fixture.md",
        classification: "parsed" as const,
        record: {
          schema_version: 1 as const,
          record_class: "adr" as const,
          id: "revoy2:ADR-900",
          record_number: 900,
          title: "Fixture citing an out-of-corpus record",
          status: { decision: "draft" as const, implementation: "none" as const, verification: "unverified" as const, compliance: "unknown" as const },
          authored_date: { value: "2026-01-01", inferred: false, method: null },
          accepted_date: { value: null, inferred: false, method: null },
          authors: { value: null, inferred: false, method: null },
          sections: {
            context: "Mentions ADR-999, which does not exist anywhere in this fixture corpus.",
            decision: "n/a",
            consequences: "n/a",
            alternatives: null,
            test_implications: null,
            source: null,
            obligations_section: null,
          },
          obligations: [],
          amendments: [],
          source_path: "decisions/ADR-900-fixture.md",
          source_content_hash: "deadbeef",
          parse_warnings: [],
        },
        reasons: [],
      },
    ];

    const report = classifyCorpusCitations(fixture, { at: FIXED_AT });
    expect(report.unresolved_count).toBe(1);
    expect(report.facts).toHaveLength(1);
    expect(report.facts[0].method).toBe("none");
    expect(report.facts[0].target).toBeNull();
    expect(report.facts[0].confidence).toBeNull();
    expect(report.facts[0].reason).toMatch(/left unresolved rather than guessed/);
  });

  it("excludes a record's citation of its own number (self-mention is not a cross-reference)", () => {
    const fixture = [
      {
        source_path: "decisions/ADR-901-fixture.md",
        classification: "parsed" as const,
        record: {
          schema_version: 1 as const,
          record_class: "adr" as const,
          id: "revoy2:ADR-901",
          record_number: 901,
          title: "Fixture",
          status: { decision: "draft" as const, implementation: "none" as const, verification: "unverified" as const, compliance: "unknown" as const },
          authored_date: { value: "2026-01-01", inferred: false, method: null },
          accepted_date: { value: null, inferred: false, method: null },
          authors: { value: null, inferred: false, method: null },
          sections: {
            context: "As required by ADR-901 itself.",
            decision: "n/a",
            consequences: "n/a",
            alternatives: null,
            test_implications: null,
            source: null,
            obligations_section: null,
          },
          obligations: [],
          amendments: [],
          source_path: "decisions/ADR-901-fixture.md",
          source_content_hash: "deadbeef",
          parse_warnings: [],
        },
        reasons: [],
      },
    ];

    const report = classifyCorpusCitations(fixture, { at: FIXED_AT });
    expect(report.facts).toHaveLength(0);
    expect(report.per_record[0].outcome).toBe("no_citations");
  });

  it('gives an unparseable record its own visible "unparseable" outcome, never defaulted into "no_citations" or "resolved" (the real corpus has 0 unparseable today, so this branch needs its own fixture proof)', () => {
    const fixture = [
      {
        source_path: "decisions/garbage.md",
        classification: "unparseable" as const,
        record: null,
        reasons: ["missing or malformed H1"],
      },
    ];

    const report = classifyCorpusCitations(fixture, { at: FIXED_AT });
    expect(report.total_records).toBe(1);
    expect(report.records_unparseable).toBe(1);
    expect(report.records_with_no_citations).toBe(0);
    expect(report.records_fully_resolved).toBe(0);
    expect(report.records_with_unresolved_citations).toBe(0);
    expect(report.per_record[0].outcome).toBe("unparseable");
    expect(report.per_record[0].record_id).toBeNull();
    expect(report.facts).toHaveLength(0);
  });
});

/**
 * A tripwire, not a coverage test.
 *
 * The open question this closes: "nothing yet promotes a citation to `high`
 * confidence on stronger evidence." Investigated against the real corpus and
 * the answer is that there IS no stronger evidence to promote on — which is a
 * different fact from "the checker is not clever enough yet", and the
 * difference is what stops this being re-investigated every few weeks.
 *
 * Two signals would genuinely justify a higher band, and neither exists here:
 *
 *   1. A STRUCTURED citation field (`Supersedes:`, `Amends:`, a frontmatter
 *      list). That would make the link `declared` rather than `derived`, and
 *      `declared` is what `high`/`authoritative` are for. revoy2's ADR
 *      template has no such field — every citation is a bare ADR-NNN token in
 *      prose. (revoy-spec HAS an `amends:` field; the audit rejected adopting
 *      it because 81 of its 159 records carry it and nothing consumes it.)
 *
 *   2. MUTUAL citation — both records independently naming each other, which
 *      is corroboration rather than one-directional mention.
 *
 * Promoting on anything weaker — heading proximity, section context — would be
 * text co-occurrence with extra steps, and manufacturing certainty is the one
 * thing the migration honesty triad exists to prevent.
 *
 * WHEN THIS TEST FAILS, that is the signal that the corpus gained a stronger
 * structure and promotion became implementable. Implement it then; do not
 * weaken the assertion to make it pass.
 */
describe("citation confidence ceiling — evidence of absence, not absence of evidence", () => {
  const scan = scanDecisionsCorpus(DECISIONS_DIR, { at: FIXED_AT });
  if (!scan.ok) throw new Error(`corpus scan failed: ${scan.error.message}`);
  const report = scan.value.citations;
  const files = readdirSync(DECISIONS_DIR).filter((name) => /^ADR-\d{3}.*\.md$/.test(name)).sort();
  const bodies = new Map(files.map((name) => [name.slice(0, 7), readFileSync(join(DECISIONS_DIR, name), "utf8")]));

  it("every resolved citation sits at medium/derived, because nothing stronger exists", () => {
    expect(report.resolved_by_confidence.authoritative).toBe(0);
    expect(report.resolved_by_confidence.high).toBe(0);
    expect(report.resolved_by_confidence.low).toBe(0);
    expect(report.resolved_by_confidence.medium).toBeGreaterThan(0);
  });

  it("no record declares a structured citation field", () => {
    // If one appears, those citations become `declared` and earn a real
    // confidence promotion — see this block's header.
    // Requires the field's colon. Without it this matched wrapped prose that
    // merely began a line with "replaces" (ADR-018) — a false accusation, the
    // failure mode this repository's gates are explicitly biased against.
    const structured = /^\s*(?:\*\*)?(?:Supersedes|Superseded[- ]by|Amends|Amended[- ]by|Replaces|Replaced[- ]by)(?:\*\*)?\s*:/im;
    const offenders = [...bodies].filter(([, body]) => structured.test(body)).map(([id]) => id);
    expect(offenders, "structured citation fields appeared — promotion is now implementable").toEqual([]);
  });

  it("no two records cite each other, so there is no corroboration to promote on", () => {
    const cited = new Map<string, Set<string>>();
    for (const [own, body] of bodies) {
      const targets = new Set(
        [...body.matchAll(/ADR-\d{3}/g)].map((match) => match[0]).filter((id) => id !== own && bodies.has(id)),
      );
      cited.set(own, targets);
    }
    const mutual: string[] = [];
    for (const [source, targets] of cited) {
      for (const target of targets) {
        if (cited.get(target)?.has(source) && source < target) mutual.push(`${source} <-> ${target}`);
      }
    }
    // FIRED, correctly, on 2026-08-05. ADR-024's ratification note points at
    // ADR-028 as the record deciding the boundary it deferred, and ADR-028
    // cites ADR-024 as the reason it exists — the corpus's first mutual
    // citation. This tripwire exists to notice exactly that, so known pairs
    // are pinned rather than the assertion loosened. ADR-040/041 now form a
    // second intentional pair because the transport decision and its contract
    // are explicitly cross-referenced; this remains an observation, not an
    // automatic confidence promotion.
    //
    // ADR-036/077 is a third intentional pair, and of a different kind: ADR-077
    // supersedes ADR-036's O3, so it necessarily cites ADR-036, and ADR-036's
    // now-false O3 carries a pointer forward so a reader arriving there finds
    // the record that governs instead of only the note that it is false. Worth
    // observing that supersession does NOT automatically produce mutuality --
    // ADR-037 supersedes ADR-011's O4 and that pair is not here, because
    // ADR-011 was never given the back-reference. Whether it should be is a
    // separate question this tripwire is well placed to keep visible.
    //
    // RESOLVED 2026-08-18: it should have been, and now is. The new
    // `gate:adr-retirement-integrity` scanned the corpus and reported exactly
    // this — ADR-011 missing back-references for both ADR-036 (the provisional
    // Ink decision) and ADR-037 (obligation O4). The gate was allowed to indict
    // the corpus rather than be weakened to let it pass, so ADR-011 gained
    // supersession markers at all three sites and two mutual pairs appeared
    // here. This tripwire predicted its own next firing.
    //
    // ADR-081/082, 2026-08-19: a fifth pair, and of the ADR-036/077 kind
    // rather than the ADR-024/028 kind. ADR-082 supersedes ADR-081's
    // scheduling clause and therefore cites it; ADR-081's now-retired clause
    // carries a pointer forward so a reader arriving at it finds the record
    // that governs instead of only the retired text. That back-reference was
    // not optional -- gate:adr-retirement-integrity requires supersession to
    // be legible from BOTH sides, so this pair is the direct, predictable
    // consequence of that gate existing. Mutuality here remains an
    // observation, not a confidence promotion.
    //
    // ADR-122/149, 2026-08-29: ADR-149 supersedes ADR-122 Decision 2, and
    // ADR-122 now points forward to the governing replacement. This is the
    // same retirement-integrity mechanism, so it adds one expected mutual
    // pair without changing the migration confidence ceiling.
    //
    // ADR-146/153, 2026-08-31: ADR-153 truthfully supersedes ADR-146's
    // unimplemented governance-debt contract, and ADR-146 points forward to
    // the narrower controls that are actually built. This is another required
    // retirement-integrity pair, not corroboration of an implementation claim.
    expect(mutual, "a NEW mutual citation appeared — corroboration-based promotion is implementable for it too")
      .toEqual([
        "ADR-011 <-> ADR-036",
        "ADR-011 <-> ADR-037",
        "ADR-024 <-> ADR-028",
        "ADR-031 <-> ADR-176",
        "ADR-036 <-> ADR-077",
        "ADR-040 <-> ADR-041",
        "ADR-081 <-> ADR-082",
        "ADR-081 <-> ADR-129",
        "ADR-091 <-> ADR-094",
        "ADR-092 <-> ADR-094",
        "ADR-122 <-> ADR-149",
        "ADR-141 <-> ADR-142",
        "ADR-146 <-> ADR-153",
      ]);
  });
});
