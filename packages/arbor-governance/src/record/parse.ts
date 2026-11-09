/**
 * parse.ts — parses one ADR markdown file into a CanonicalRecord.
 *
 * NEVER throws on malformed input: every failure path returns a typed
 * `GovernanceError` with `code: "validation"` and an `at` pointer, wrapped in
 * a `GovernanceResult`. A corpus parser that throws cannot report on a
 * corpus — it can only crash the first time it meets a record it dislikes.
 *
 * Handles the full shape drift verified across decisions/*.md (27 files):
 *   - `## Alternatives considered` / `## Alternatives Considered` (case
 *     split) and `## Roads not taken` (ADR-018/019/020) all normalize to the
 *     single canonical `alternatives` section.
 *   - `## Test implications` and `## Source` are independently optional.
 *   - A `**Date:**` line whose value is more than a bare ISO date
 *     (ADR-022, ADR-023: "2026-08-04 (proposed); accepted 2026-08-04 (wave
 *     4)...") — the first ISO date token is extracted; the extra prose is
 *     flagged as a parse warning rather than silently dropped or guessed at.
 *   - Non-blank preamble text between the `**Date:**` line and the first
 *     `##` heading (ADR-022, ADR-023, ADR-027's blockquote) is folded into
 *     `context` with a parse warning, never discarded.
 *   - An unrecognized `##` subsection (ADR-011's `## Renderer decision`) is
 *     folded into whichever canonical section most recently opened, with
 *     its original heading preserved verbatim so no text is lost, plus a
 *     parse warning.
 *   - ADR-024's two in-body `**Amendment (...):**` / `**Second amendment
 *     (...):**` paragraphs are extracted into `amendments` in addition to
 *     remaining part of their enclosing section's prose (extraction is
 *     additive, not a rewrite of the section text).
 *
 * Migration honesty: `obligations` is always `[]` for every record this
 * parser produces (no legacy record states obligations), and `authors` is
 * always unknown (`value: null`) because no field in this corpus's template
 * ever records authorship. Neither is fabricated.
 */

import type { DecisionStatus, GovernanceError, GovernanceResult } from "../contracts.js";
import type { AmendmentBlock, CanonicalRecord, RecordSections, SectionKey } from "./schema.js";
import { deriveStatusVector, ZERO_OBLIGATIONS } from "./status.js";
import { sha256Hex } from "./canonical.js";

const CAPABILITY_PARSE = "record.parse";

const H1_RE = /^#\s+(ADR|AHR)-(\d+)\s*:\s*(.+?)\s*$/;
const STATUS_LINE_RE = /^\*\*Status:\*\*\s*(.*?)\s*$/;
const DATE_LINE_RE = /^\*\*Date:\*\*\s*(.*?)\s*$/;
const DATE_TOKEN_RE = /\d{4}-\d{2}-\d{2}/;
const H2_RE = /^##\s+(.+?)\s*$/;
const AMENDMENT_LINE_RE = /^\*\*([A-Za-z][A-Za-z ]*?)\s*\(([^)]*)\)\s*:\*\*\s*(.*)$/;

const STATUS_MAP: Record<string, DecisionStatus> = {
  Draft: "draft",
  Proposed: "proposed",
  Accepted: "accepted",
  Rejected: "rejected",
  Superseded: "superseded",
};

const CANONICAL_SECTION_BY_HEADER: Record<string, SectionKey> = {
  context: "context",
  decision: "decision",
  consequences: "consequences",
  "alternatives considered": "alternatives",
  "roads not taken": "alternatives",
  "test implications": "test_implications",
  source: "source",
  obligations: "obligations",
};

function fail(message: string, at: string): GovernanceResult<CanonicalRecord> {
  const error: GovernanceError = { code: "validation", message, at };
  return { ok: false, error, capability: CAPABILITY_PARSE };
}

interface HeadingBlock {
  readonly headerRaw: string;
  /** 1-based source line number of the heading itself, for diagnostics. */
  readonly line: number;
  readonly bodyLines: string[];
}

/** Extracts every `**Label (note):** body...` amendment paragraph in the document, in occurrence order. */
function extractAmendments(lines: readonly string[]): AmendmentBlock[] {
  const amendments: AmendmentBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = AMENDMENT_LINE_RE.exec(lines[i]);
    if (!m) continue;
    const [, label, note, restOfLine] = m;
    const bodyParts: string[] = [];
    if (restOfLine.trim().length > 0) bodyParts.push(restOfLine.trim());
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (next.trim().length === 0) break;
      if (H2_RE.test(next) || AMENDMENT_LINE_RE.test(next)) break;
      bodyParts.push(next.trim());
    }
    amendments.push({
      ordinal: amendments.length + 1,
      label: label.trim(),
      note: note.trim(),
      body: bodyParts.join(" ").replace(/\s+/g, " ").trim(),
    });
  }
  return amendments;
}

/** Parses one ADR markdown file. Never throws; every failure is a typed GovernanceResult error. */
export function parseRecord(content: string, sourcePath: string): GovernanceResult<CanonicalRecord> {
  const normalized = content.replace(/\r\n/g, "\n");
  if (normalized.trim().length === 0) {
    return fail("empty file: no H1 title line", `${sourcePath}:1`);
  }

  const lines = normalized.split("\n");

  const h1Match = H1_RE.exec(lines[0]);
  if (!h1Match) {
    return fail(
      'missing or malformed H1 (expected "# ADR-NNN: Title" or "# AHR-NNN: Title" on line 1)',
      `${sourcePath}:1`,
    );
  }
  const [, classToken, numberToken, title] = h1Match;
  if (classToken.toLowerCase() !== "adr") {
    return fail(
      `record class "${classToken.toLowerCase()}" is not supported by parseRecord (this parser handles "adr" records only — see schema.ts on CanonicalResearchRecord)`,
      `${sourcePath}:1`,
    );
  }
  const recordNumber = Number.parseInt(numberToken, 10);
  const id = `revoy2:ADR-${numberToken}`;

  let statusLineIndex = -1;
  let rawStatus = "";
  for (let i = 1; i < lines.length; i++) {
    const m = STATUS_LINE_RE.exec(lines[i]);
    if (m) {
      statusLineIndex = i;
      rawStatus = m[1];
      break;
    }
  }
  if (statusLineIndex === -1) {
    return fail('missing "**Status:**" line', `${sourcePath}`);
  }
  const decision = STATUS_MAP[rawStatus];
  if (!decision) {
    return fail(`unknown status string "${rawStatus}"`, `${sourcePath}:${statusLineIndex + 1}`);
  }

  let dateLineIndex = -1;
  let rawDateLine = "";
  for (let i = statusLineIndex + 1; i < lines.length; i++) {
    const m = DATE_LINE_RE.exec(lines[i]);
    if (m) {
      dateLineIndex = i;
      rawDateLine = m[1];
      break;
    }
  }
  if (dateLineIndex === -1) {
    return fail('missing "**Date:**" line', `${sourcePath}`);
  }
  const dateTokenMatch = DATE_TOKEN_RE.exec(rawDateLine);
  if (!dateTokenMatch) {
    return fail(`malformed "**Date:**" line: no ISO date found in "${rawDateLine}"`, `${sourcePath}:${dateLineIndex + 1}`);
  }
  const authoredDateValue = dateTokenMatch[0];

  const warnings: string[] = [];
  if (rawDateLine.trim() !== authoredDateValue) {
    warnings.push(
      `"**Date:**" line contains text beyond a bare ISO date ("${rawDateLine}"); extracted the first date token, "${authoredDateValue}", and left the rest unmodelled`,
    );
  }

  // ------------------------------------------------------------ headings
  const blocks: HeadingBlock[] = [];
  const preambleLines: string[] = [];
  for (let i = dateLineIndex + 1; i < lines.length; i++) {
    const h2 = H2_RE.exec(lines[i]);
    if (h2) {
      blocks.push({ headerRaw: h2[1], line: i + 1, bodyLines: [] });
    } else if (blocks.length > 0) {
      blocks[blocks.length - 1].bodyLines.push(lines[i]);
    } else {
      preambleLines.push(lines[i]);
    }
  }

  const sectionChunks = new Map<SectionKey, string[]>();
  function pushChunk(key: SectionKey, text: string): void {
    if (text.length === 0) return;
    const existing = sectionChunks.get(key);
    if (existing) existing.push(text);
    else sectionChunks.set(key, [text]);
  }

  const preambleText = preambleLines.join("\n").trim();
  if (preambleText.length > 0) {
    warnings.push(`preamble content before the first "##" heading was folded into "context"`);
    pushChunk("context", preambleText);
  }

  let lastCanonicalKey: SectionKey | null = preambleText.length > 0 ? "context" : null;
  for (const block of blocks) {
    const normalizedHeader = block.headerRaw.trim().toLowerCase();
    const canonicalKey = CANONICAL_SECTION_BY_HEADER[normalizedHeader];
    const bodyText = block.bodyLines.join("\n").trim();
    if (canonicalKey) {
      pushChunk(canonicalKey, bodyText);
      lastCanonicalKey = canonicalKey;
    } else {
      const target = lastCanonicalKey ?? "context";
      warnings.push(
        `unrecognized subsection heading "## ${block.headerRaw}" (line ${block.line}) folded into "${target}"`,
      );
      pushChunk(target, [`## ${block.headerRaw}`, bodyText].filter((s) => s.length > 0).join("\n\n"));
    }
  }

  function joinChunks(key: SectionKey): string {
    const chunks = sectionChunks.get(key);
    return chunks ? chunks.join("\n\n").trim() : "";
  }

  const context = joinChunks("context");
  const decisionText = joinChunks("decision");
  const consequences = joinChunks("consequences");
  const alternatives = joinChunks("alternatives");
  const obligationsSection = joinChunks("obligations");
  const testImplications = joinChunks("test_implications");
  const source = joinChunks("source");

  if (context.length === 0) return fail('missing or empty "## Context" section', sourcePath);
  if (decisionText.length === 0) return fail('missing or empty "## Decision" section', sourcePath);
  if (consequences.length === 0) return fail('missing or empty "## Consequences" section', sourcePath);

  const sections: RecordSections = {
    context,
    decision: decisionText,
    consequences,
    alternatives: alternatives.length > 0 ? alternatives : null,
    obligations_section: obligationsSection.length > 0 ? obligationsSection : null,
    test_implications: testImplications.length > 0 ? testImplications : null,
    source: source.length > 0 ? source : null,
  };

  const amendments = extractAmendments(lines);

  const status = deriveStatusVector(decision, ZERO_OBLIGATIONS);

  const record: CanonicalRecord = {
    schema_version: 1,
    record_class: "adr",
    id,
    record_number: recordNumber,
    title,
    status,
    authored_date: { value: authoredDateValue, inferred: false, method: null },
    accepted_date: {
      value: null,
      inferred: false,
      method:
        "legacy corpus records a single **Date:** field with no event distinguishing authoring from acceptance; not inferred, to avoid fabricating an acceptance timestamp",
    },
    authors: {
      value: null,
      inferred: false,
      method:
        "the ADR template used by this corpus (H1 / Status / Date / Context / Decision / Consequences, optionally Alternatives / Test implications / Source / Roads not taken) carries no author or byline field",
    },
    sections,
    obligations: [],
    amendments,
    source_path: sourcePath,
    source_content_hash: sha256Hex(normalized),
    parse_warnings: warnings,
  };

  return { ok: true, value: record, capability: CAPABILITY_PARSE };
}
