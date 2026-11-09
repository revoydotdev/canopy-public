/**
 * schema.ts — the canonical in-memory shape of a governance record.
 *
 * Governing decision: ADR-027 (draft, this branch). Built strictly against
 * ../contracts.ts's frozen types (RecordId, RecordClass, StatusVector,
 * ObligationId) — nothing here redefines them.
 *
 * Two record classes share `RecordClass` ("adr" | "ahr"). This mission's
 * corpus (decisions/ADR-NNN-*.md, 27 files, all class "adr") is what this
 * package parses. `CanonicalResearchRecord` — the AHR/research-record
 * counterpart, driven by `ResearchStatus` rather than `DecisionStatus` — is
 * declared here for completeness against contracts.ts's `RecordClass` union,
 * but this package ships no parser for it: the only AHR-shaped file in the
 * repo is `docs/adr-governance-audit/appendices/ahr-sample-record.md`, which
 * is documentation illustrating a *future* shape, not a real record to
 * validate a parser against. Shipping an AHR parser with no real corpus
 * input to prove it on would itself be the "substrate with no caller"
 * anti-pattern this mission exists to eliminate — so it is deliberately
 * deferred, not stubbed.
 */

import type { RecordId, RecordClass, StatusVector, ResearchStatus, ObligationId } from "../contracts.js";

/** Canonical section keys every ADR-class record is modelled with. */
export type SectionKey = "context" | "decision" | "consequences" | "alternatives" | "test_implications" | "source" | "obligations";

/**
 * Parsed section bodies, trimmed markdown text.
 *
 * `context` / `decision` / `consequences` are universal across the corpus
 * (verified: present in all 27 files) and therefore required. The rest are
 * optional and drift across the corpus (`## Alternatives considered` /
 * `## Alternatives Considered` — a case split — and `## Roads not taken` all
 * fold into `alternatives`; `## Test implications` and `## Source` are
 * independently optional). `null` means the section is genuinely absent from
 * the source file, never an empty string standing in for absence.
 */
export interface RecordSections {
  readonly context: string;
  readonly decision: string;
  readonly consequences: string;
  readonly alternatives: string | null;
  readonly test_implications: string | null;
  readonly source: string | null;
  /**
   * The "## Obligations" section's raw text, or null when the record has none.
   *
   * Added 2026-08-07. The parser previously had no key for this heading, so
   * every record that adopted the obligation format — the format this same
   * package defines and gates on — was folded into `alternatives` and
   * downgraded to `parsed_with_warnings`. The two halves of the package
   * disagreed about the corpus they share: `obligation/parse.ts` required the
   * section, and `record/parse.ts` treated it as an anomaly.
   *
   * The structured obligations themselves remain `obligation/parse.ts`'s
   * concern; this field only records that the section exists and what it says,
   * so the record parser stops reporting a warning for a record that is more
   * rigorous than its peers, not less.
   */
  readonly obligations_section: string | null;
}

/**
 * A value the corpus does not state in a single, unambiguous, structured
 * field. `inferred: true` means a value was derived and `method` names how;
 * `inferred: false` with a non-null `value` means the value was read
 * directly off the page. `value: null` means genuinely unknown — never a
 * plausible-looking default (Migration Honesty). `method` may still carry an
 * explanation when `inferred` is false and `value` is null, to record *why*
 * it is null rather than leaving the reader to guess.
 */
export interface Inferred<T> {
  readonly value: T;
  readonly inferred: boolean;
  readonly method: string | null;
}

/**
 * One in-body amendment paragraph, e.g. ADR-024's two blockquote-style
 * `**Amendment (...):**` / `**Second amendment (...):**` blocks. These are
 * prose, not a fixed grammar — `note` is the raw parenthetical text, not a
 * parsed date, because the corpus's parentheticals are not all dates
 * ("wave 3, still Proposed" alongside a date, free-form).
 */
export interface AmendmentBlock {
  /** 1-based occurrence order within the source file. */
  readonly ordinal: number;
  /** Raw label as written, e.g. "Amendment" or "Second amendment". */
  readonly label: string;
  /** Raw parenthetical text following the label. */
  readonly note: string;
  /** The paragraph body following the label, whitespace-collapsed and trimmed. */
  readonly body: string;
}

export interface CanonicalRecord {
  readonly schema_version: 1;
  readonly record_class: Extract<RecordClass, "adr">;
  /** Namespaced, e.g. "revoy2:ADR-026" (RecordId; see contracts.ts's namespace note). */
  readonly id: RecordId;
  readonly record_number: number;
  readonly title: string;
  readonly status: StatusVector;
  readonly authored_date: Inferred<string | null>;
  readonly accepted_date: Inferred<string | null>;
  readonly authors: Inferred<readonly string[] | null>;
  readonly sections: RecordSections;
  /** Empty for every legacy record in this corpus — never fabricated. */
  readonly obligations: readonly ObligationId[];
  readonly amendments: readonly AmendmentBlock[];
  readonly source_path: string;
  /** sha256 hex of the raw source file bytes (provenance, not content identity). */
  readonly source_content_hash: string;
  /**
   * Non-fatal parse anomalies (e.g. an unrecognized `##` subsection folded
   * into a canonical section, or preamble text before the first heading).
   * Empty when the file parsed with no anomalies. This is what
   * `legacy.ts`'s three-way classification is derived from.
   */
  readonly parse_warnings: readonly string[];
}

/** AHR/research-record counterpart. Declared, not parsed — see file header. */
export interface CanonicalResearchRecord {
  readonly schema_version: 1;
  readonly record_class: Extract<RecordClass, "ahr">;
  readonly id: RecordId;
  readonly title: string;
  readonly research_status: ResearchStatus;
  readonly source_path: string;
  readonly source_content_hash: string;
}
