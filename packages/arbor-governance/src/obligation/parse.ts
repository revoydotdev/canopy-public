/**
 * obligation/parse.ts — parse an ADR's "## Obligations" section into structured
 * `Obligation` records, honestly.
 *
 * The problem this closes (see the module-level brief this package implements):
 * commits assert exact completion ratios ("14/14 satisfied") for clauses that do
 * not exist in any traceable form anywhere in `decisions/*.md`. This parser makes
 * "how many obligations does this record declare, and which carry a proof
 * comment" a fact derived from the file, not an assertion made about it.
 *
 * Target format (new records only):
 *
 *   ## Obligations
 *
 *   ### O1 — <obligation text>
 *
 *   <!-- proof: symbol=NAME roundtrip=path/to.test.ts -->
 *   <!-- proof: symbol=NAME file=path/to/src.ts roundtrip=path/to.test.ts -->
 *   <!-- unverifiable: <why no resolving repository proof can be cited yet> -->
 *
 * A record with no "## Obligations" heading is a legacy record. It is reported
 * with `has_obligations_section: false` and `obligations: []` — NEVER inferred
 * or backfilled from prose elsewhere in the document. Fabricating obligations
 * for a legacy record would recreate the exact failure this module exists to
 * prevent (an unfalsifiable claim dressed up as a checkable one).
 */

import type { GovernanceResult, ObligationId, RecordId } from "../contracts.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One `<!-- proof: ... -->` comment attached to an obligation, fields as written. */
export interface ObligationProofComment {
  /** Exact text between `proof:` and the comment's closing `-->`, trimmed, for diagnostics. */
  raw: string;
  symbol?: string;
  file?: string;
  roundtrip?: string;
}

export interface Obligation {
  id: ObligationId;
  record_id: RecordId;
  /** "O1", "O2", ... exactly as written in the heading. */
  ordinal: string;
  text: string;
  /** 1-based line number of the "### O<n> — ..." heading in the source file. */
  line: number;
  proofs: readonly ObligationProofComment[];
  /** Required when `proofs` is empty; absence is explicit debt, never silence. */
  unverifiable_reason?: string;
}

export interface RecordObligations {
  record_id: RecordId;
  /** Repo-relative, e.g. "decisions/ADR-026-campaign-loop-is-a-supervised-job.md". */
  source_path: string;
  /**
   * Whether a "## Obligations" heading was found at all — distinct from
   * `obligations.length === 0`. A section can legitimately exist and declare
   * zero obligations; a legacy record simply never had the heading. Collapsing
   * these two into one boolean would hide which case a given record is in.
   */
  has_obligations_section: boolean;
  obligations: readonly Obligation[];
  /**
   * Ordinals that appeared more than once ("O1" twice in the same section).
   * Surfaced, never silently deduplicated or renumbered — a duplicate ordinal
   * is itself evidence of a malformed record.
   */
  duplicate_ordinals: readonly string[];
}

// ---------------------------------------------------------------------------
// Record id derivation
// ---------------------------------------------------------------------------

const ADR_FILENAME_RE = /^(ADR-\d+)-.*\.md$/;

/**
 * Derives a namespaced RecordId from a decisions/ filename, e.g.
 * "ADR-026-campaign-loop-is-a-supervised-job.md" -> "revoy2:ADR-026". Returns
 * null for anything that isn't an ADR record (README.md, stray files) rather
 * than guessing.
 */
export function deriveRecordId(basename: string): RecordId | null {
  const m = ADR_FILENAME_RE.exec(basename);
  return m ? (`revoy2:${m[1]}` as RecordId) : null;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const OBLIGATIONS_HEADING_RE = /^##\s+Obligations\s*$/i;
const TOP_HEADING_RE = /^##\s+/;
const OBLIGATION_ITEM_RE = /^###\s+(O\d+)\s*[—-]\s*(.+?)\s*$/;
const PROOF_COMMENT_RE = /<!--\s*proof:(.*?)-->/g;
const UNVERIFIABLE_COMMENT_RE = /<!--\s*unverifiable:\s*(.*?)\s*-->/g;
const PROOF_FIELD_RE = /(\w+)=(\S+)/g;

function parseProofFields(inner: string): ObligationProofComment {
  const fields: Record<string, string> = {};
  PROOF_FIELD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PROOF_FIELD_RE.exec(inner))) {
    fields[m[1]] = m[2];
  }
  return { raw: inner.trim(), symbol: fields.symbol, file: fields.file, roundtrip: fields.roundtrip };
}

/**
 * Parses one ADR's obligations from its raw markdown text. Never throws — any
 * unexpected failure is returned as a `GovernanceResult` error so a caller
 * walking many records can't be taken down by one malformed file.
 */
export function parseObligationsFromText(
  recordId: RecordId,
  sourcePath: string,
  text: string,
): GovernanceResult<RecordObligations> {
  try {
    const lines = text.split("\n");

    let sectionStart = -1;
    let sectionEnd = lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (OBLIGATIONS_HEADING_RE.test(lines[i])) {
        sectionStart = i + 1;
        for (let j = sectionStart; j < lines.length; j++) {
          if (TOP_HEADING_RE.test(lines[j])) {
            sectionEnd = j;
            break;
          }
        }
        break;
      }
    }

    if (sectionStart < 0) {
      return {
        ok: true,
        capability: "governance.obligation.parse",
        value: {
          record_id: recordId,
          source_path: sourcePath,
          has_obligations_section: false,
          obligations: [],
          duplicate_ordinals: [],
        },
      };
    }

    const headingLines: Array<{ line: number; ordinal: string; text: string }> = [];
    for (let i = sectionStart; i < sectionEnd; i++) {
      const m = OBLIGATION_ITEM_RE.exec(lines[i]);
      if (m) headingLines.push({ line: i, ordinal: m[1], text: m[2] });
    }

    const seenCounts = new Map<string, number>();
    const duplicates: string[] = [];
    const obligations: Obligation[] = [];

    for (let idx = 0; idx < headingLines.length; idx++) {
      const heading = headingLines[idx];
      const bodyEnd = headingLines[idx + 1]?.line ?? sectionEnd;
      const bodyText = lines.slice(heading.line + 1, bodyEnd).join("\n");

      const proofs: ObligationProofComment[] = [];
      PROOF_COMMENT_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = PROOF_COMMENT_RE.exec(bodyText))) {
        proofs.push(parseProofFields(m[1]));
      }
      UNVERIFIABLE_COMMENT_RE.lastIndex = 0;
      const unverifiableMatches = [...bodyText.matchAll(UNVERIFIABLE_COMMENT_RE)];
      const unverifiableReason = unverifiableMatches.length === 1
        ? unverifiableMatches[0][1].trim()
        : undefined;

      const count = (seenCounts.get(heading.ordinal) ?? 0) + 1;
      seenCounts.set(heading.ordinal, count);
      if (count === 2) duplicates.push(heading.ordinal); // record once, on the second sighting
      const id = (count > 1 ? `${recordId}-${heading.ordinal}#${count}` : `${recordId}-${heading.ordinal}`) as ObligationId;

      obligations.push({
        id,
        record_id: recordId,
        ordinal: heading.ordinal,
        text: heading.text,
        line: heading.line + 1,
        proofs,
        ...(unverifiableReason ? { unverifiable_reason: unverifiableReason } : {}),
      });
    }

    return {
      ok: true,
      capability: "governance.obligation.parse",
      value: {
        record_id: recordId,
        source_path: sourcePath,
        has_obligations_section: true,
        obligations,
        duplicate_ordinals: duplicates,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "internal",
        message: `failed to parse obligations: ${err instanceof Error ? err.message : String(err)}`,
        at: sourcePath,
      },
      capability: "governance.obligation.parse",
    };
  }
}
