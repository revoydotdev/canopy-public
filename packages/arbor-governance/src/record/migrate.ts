/**
 * migrate.ts — the migration honesty triad (P5) applied to the 27-record
 * legacy ADR corpus: resolving bare "ADR-NNN" prose citations found inside
 * each record into a namespaced `RecordId` target, or reporting them
 * unresolved.
 *
 * Ported shape, not code, from revoy-spec's `revoy/prov/migrate.py`
 * (docs/adr-governance-audit/09-prior-art-and-self-hosting-roadmap.md §24.2
 * row P5): every candidate carries `{method, confidence, provenance}`; an
 * inference is tagged as an inference, never as something verified; and a
 * citation with no structural match produces `method: "none"` rather than a
 * guess. This module reuses contracts.ts's OWN vocabulary for those three
 * concepts — `DiscoveryMethod`, `Confidence`, `EvidenceRef` — instead of
 * inventing a parallel one; a second vocabulary for the same concept would
 * be duplicated knowledge with two sources of truth.
 *
 * WHY EVERY RESOLVED FACT IS "derived", NEVER "declared": this corpus's
 * template (see parse.ts's own header) has no structured citation,
 * `supersedes`, or `depends_on` field anywhere. Every citation this module
 * finds is a bare "ADR-NNN" token inside prose — text co-occurrence, exactly
 * the signal `06-threats-migration-roadmap.md`'s T-01 names as this
 * repository's single biggest unclosed threat: "no static system can verify
 * that a resolvable claim is a true claim." So every resolved fact here
 * carries `confidence: "medium"`, never "high" or "authoritative" — those
 * levels would overstate what a text match proves. This is the concrete
 * form of "inference is tagged claimed, never verified": nothing this
 * module produces is backed by an executed check, so nothing it produces is
 * allowed to claim the top confidence band.
 *
 * WHY AN UNRESOLVED CITATION IS `method: "none"`, NEVER A NAMESPACE GUESS:
 * `contracts.ts`'s `RecordId` is namespaced ("revoy2:ADR-026") precisely
 * because eight source locations elsewhere in this repository cite
 * revoy-spec's ADR numbers in the same bare token space, and one such
 * citation (`hashline.ts`'s "ADR-036") was recorded as permanently
 * unresolvable before the file was deleted — the audit calls that the
 * CORRECT outcome, not a failure to fix. This migration's authority is the
 * local `decisions/*.md` corpus it is actually handed, and nothing else: it
 * has no repository-boundary access to revoy-spec's own `decisions/`
 * directory, and hardcoding "these specific numbers happen to be real
 * revoy-spec records" would fabricate a cross-repository fact this
 * migration cannot itself verify, or re-verify on a future run against a
 * changed corpus. A citation whose number is not a real file in THIS scan
 * therefore always resolves to `method: "none"` — reported, never guessed.
 *
 * DETERMINISM: pure function of its inputs. No `Date.now()`, no filesystem
 * read of its own (it operates on already-parsed `LegacyReadResult[]`, the
 * same shape `corpus.ts` already produces), no randomness. `at` is supplied
 * by the caller — following `obligation/proof.ts`'s and `counts/check.ts`'s
 * existing convention — so this module reads no clock of its own. Facts are
 * sorted by (source record id, cited number) so two runs against the same
 * corpus produce byte-identical output regardless of Map iteration order.
 */

import { compareCodeUnits } from "@arbor/core";
import type { Confidence, DiscoveryMethod, EvidenceRef, RecordId } from "../contracts.js";
import type { LegacyReadResult } from "./legacy.js";
import type { SectionKey } from "./schema.js";

/** Tool identity + version for EvidenceRef.producer, per contracts.ts's requirement that a result be reproducible/invalidatable on upgrade. */
export const CITATION_MIGRATION_PRODUCER = "arbor-governance/record-migration@1";

/**
 * Sentinel `at` used when no caller-supplied timestamp is threaded through.
 * `corpus.ts`'s `scanDecisionsCorpus` has, today, exactly one real wired
 * caller (`arbor-mcp`'s `governance-projection.ts`) that does not pass one —
 * a stated, honest limitation rather than a fabricated timestamp. An
 * obviously-fixed epoch, never a clock read, so re-running never changes
 * output on that path either.
 */
export const CITATION_MIGRATION_AT_UNSET = "1970-01-01T00:00:00.000Z";

const CITATION_RE = /\bADR-(\d+)\b/g;

/** Every prose location a citation can appear in — a subset of RecordSections' keys, plus the title and any amendment blocks. */
export type ScannableField = SectionKey | "title" | "amendments";

/** One resolvable-or-not "ADR-NNN" citation found in one record's prose. */
export interface CitationFact {
  readonly source_record_id: RecordId;
  readonly source_path: string;
  /** Exactly as written, e.g. "ADR-086". */
  readonly citation_token: string;
  readonly cited_number: number;
  /** Where the citation was found, for a human reviewer — not used by resolution logic. */
  readonly found_in: readonly ScannableField[];
  /** "none" when no local record with this number exists in the scanned corpus — never a guess. */
  readonly method: DiscoveryMethod | "none";
  /** Present exactly when `method !== "none"`; null otherwise (Migration Honesty: no confidence without a fact to be confident about). */
  readonly confidence: Confidence | null;
  /** The resolved target, present exactly when `method !== "none"`. */
  readonly target: RecordId | null;
  /** Empty when `method === "none"` — no evidence backs a non-fact. */
  readonly evidence: readonly EvidenceRef[];
  readonly reason: string;
}

export type RecordCitationOutcome = "resolved" | "unresolved" | "no_citations" | "unparseable";

/**
 * Per-record rollup. A record with zero citations is its own outcome
 * (`"no_citations"`), never folded into "resolved" — a migration that
 * reports everything as resolved is a warning sign, not a success, and this
 * type makes "nothing to resolve" visibly distinct from "resolved."
 * Likewise `"unparseable"` stays its own bucket: a record this migration
 * could not even read prose from must remain visibly unclassified rather
 * than being defaulted into either of the other three.
 */
export interface RecordCitationSummary {
  readonly record_id: RecordId | null;
  readonly source_path: string;
  readonly outcome: RecordCitationOutcome;
  readonly resolved_count: number;
  readonly unresolved_count: number;
}

export interface CitationMigrationReport {
  readonly schema_version: 1;
  readonly at: string;
  readonly total_records: number;
  readonly records_with_no_citations: number;
  readonly records_fully_resolved: number;
  readonly records_with_unresolved_citations: number;
  readonly records_unparseable: number;
  readonly total_citations: number;
  /** Sum across every resolved `CitationFact`, keyed by `Confidence` — this migration only ever populates "medium" (see module header), but the full vocabulary is declared so a future, stronger resolution method has somewhere honest to report a higher band. */
  readonly resolved_by_confidence: Readonly<Record<Confidence, number>>;
  readonly unresolved_count: number;
  readonly per_record: readonly RecordCitationSummary[];
  readonly facts: readonly CitationFact[];
}

function zeroConfidenceCounts(): Record<Confidence, number> {
  return { authoritative: 0, high: 0, medium: 0, low: 0 };
}

interface MentionAccumulator {
  citationToken: string;
  fields: Set<ScannableField>;
}

/** Extracts every distinct "ADR-NNN" mention from one record's prose, deduped by cited number, excluding the record's own self-citation. */
function extractMentions(record: NonNullable<LegacyReadResult["record"]>): Array<{ citedNumber: number; citationToken: string; fields: ScannableField[] }> {
  const byNumber = new Map<number, MentionAccumulator>();

  function scan(field: ScannableField, text: string | null): void {
    if (!text) return;
    CITATION_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CITATION_RE.exec(text))) {
      const citedNumber = Number.parseInt(m[1], 10);
      if (citedNumber === record.record_number) continue; // self-mention, not a cross-reference
      const existing = byNumber.get(citedNumber);
      if (existing) existing.fields.add(field);
      else byNumber.set(citedNumber, { citationToken: `ADR-${m[1]}`, fields: new Set([field]) });
    }
  }

  scan("title", record.title);
  scan("context", record.sections.context);
  scan("decision", record.sections.decision);
  scan("consequences", record.sections.consequences);
  scan("alternatives", record.sections.alternatives);
  scan("test_implications", record.sections.test_implications);
  scan("source", record.sections.source);
  for (const amendment of record.amendments) {
    scan("amendments", `${amendment.note} ${amendment.body}`);
  }

  return [...byNumber.entries()]
    .sort(([a], [b]) => a - b)
    .map(([citedNumber, { citationToken, fields }]) => ({
      citedNumber,
      citationToken,
      fields: [...fields].sort(),
    }));
}

/**
 * Resolves every "ADR-NNN" prose citation across an already-parsed legacy
 * corpus scan. Pure: takes the same `LegacyReadResult[]` shape `corpus.ts`
 * already produces, reads no filesystem and no clock of its own.
 */
export function classifyCorpusCitations(
  results: readonly LegacyReadResult[],
  options: { readonly at: string },
): CitationMigrationReport {
  const sortedResults = [...results].sort((a, b) => compareCodeUnits(a.source_path, b.source_path));

  // The local corpus's own resolution universe: every number this scan
  // actually parsed into a real record, mapped to its namespaced id.
  const localByNumber = new Map<number, RecordId>();
  for (const result of sortedResults) {
    if (result.record) localByNumber.set(result.record.record_number, result.record.id);
  }
  const localNumbers = [...localByNumber.keys()].sort((a, b) => a - b);

  const facts: CitationFact[] = [];
  const perRecord: RecordCitationSummary[] = [];

  for (const result of sortedResults) {
    if (!result.record) {
      perRecord.push({
        record_id: null,
        source_path: result.source_path,
        outcome: "unparseable",
        resolved_count: 0,
        unresolved_count: 0,
      });
      continue;
    }

    const record = result.record;
    const mentions = extractMentions(record);

    if (mentions.length === 0) {
      perRecord.push({
        record_id: record.id,
        source_path: result.source_path,
        outcome: "no_citations",
        resolved_count: 0,
        unresolved_count: 0,
      });
      continue;
    }

    let resolvedCount = 0;
    let unresolvedCount = 0;

    for (const mention of mentions) {
      const target = localByNumber.get(mention.citedNumber) ?? null;
      if (target) {
        resolvedCount += 1;
        facts.push({
          source_record_id: record.id,
          source_path: result.source_path,
          citation_token: mention.citationToken,
          cited_number: mention.citedNumber,
          found_in: mention.fields,
          method: "derived",
          confidence: "medium",
          target,
          evidence: [
            {
              kind: "code_location",
              ref: `${result.source_path}#${mention.citationToken}`,
              producer: CITATION_MIGRATION_PRODUCER,
              at: options.at,
              content_hash: record.source_content_hash,
            },
          ],
          reason:
            `bare "${mention.citationToken}" mention resolves to a record present in this corpus's own scan (${target}); ` +
            `this is a text co-occurrence match, not a structured citation field (this template has none — see parse.ts), ` +
            `so relevance beyond the number matching is not verified (T-01, 06-threats-migration-roadmap.md).`,
        });
      } else {
        unresolvedCount += 1;
        facts.push({
          source_record_id: record.id,
          source_path: result.source_path,
          citation_token: mention.citationToken,
          cited_number: mention.citedNumber,
          found_in: mention.fields,
          method: "none",
          confidence: null,
          target: null,
          evidence: [],
          reason:
            `"${mention.citationToken}" does not match any record in this scan's local corpus (local numbers present: ` +
            `${localNumbers.join(", ")}); left unresolved rather than guessed — it is either outside the local range or ` +
            `a cross-namespace citation (e.g. revoy-spec's own ADR numbering, which this migration has no authority to ` +
            `read or verify), and RecordId is namespaced precisely so a bare number is never silently resolved to a ` +
            `local record it does not belong to.`,
        });
      }
    }

    perRecord.push({
      record_id: record.id,
      source_path: result.source_path,
      outcome: unresolvedCount > 0 ? "unresolved" : "resolved",
      resolved_count: resolvedCount,
      unresolved_count: unresolvedCount,
    });
  }

  facts.sort((a, b) => compareCodeUnits(a.source_record_id, b.source_record_id) || a.cited_number - b.cited_number);
  perRecord.sort((a, b) => compareCodeUnits(a.source_path, b.source_path));

  const resolvedByConfidence = zeroConfidenceCounts();
  let unresolvedTotal = 0;
  for (const fact of facts) {
    if (fact.confidence) resolvedByConfidence[fact.confidence] += 1;
    else unresolvedTotal += 1;
  }

  return {
    schema_version: 1,
    at: options.at,
    total_records: perRecord.length,
    records_with_no_citations: perRecord.filter((r) => r.outcome === "no_citations").length,
    records_fully_resolved: perRecord.filter((r) => r.outcome === "resolved").length,
    records_with_unresolved_citations: perRecord.filter((r) => r.outcome === "unresolved").length,
    records_unparseable: perRecord.filter((r) => r.outcome === "unparseable").length,
    total_citations: facts.length,
    resolved_by_confidence: resolvedByConfidence,
    unresolved_count: unresolvedTotal,
    per_record: perRecord,
    facts,
  };
}
