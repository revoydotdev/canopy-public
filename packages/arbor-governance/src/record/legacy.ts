/**
 * legacy.ts — the Phase 1 compatibility reader: classifies one markdown file
 * as `parsed` | `parsed_with_warnings` | `unparseable`.
 *
 * This is Phase 1's stated exit criterion: "all current valid ADRs can be
 * classified; conversion failures are reported." It never throws — parse.ts
 * already returns a typed result, and this module just interprets it.
 */

import { parseRecord } from "./parse.js";
import type { CanonicalRecord } from "./schema.js";

export type LegacyClassification = "parsed" | "parsed_with_warnings" | "unparseable";

export interface LegacyReadResult {
  readonly source_path: string;
  readonly classification: LegacyClassification;
  /** The parsed record, or null when classification is "unparseable". */
  readonly record: CanonicalRecord | null;
  /**
   * Human-readable reasons: the parse_warnings when "parsed_with_warnings",
   * the single failure message (with its `at` pointer folded in) when
   * "unparseable", and an empty array when cleanly "parsed".
   */
  readonly reasons: readonly string[];
}

/** Classifies one ADR markdown file's content by parsing it and interpreting the result. */
export function classifyLegacyRecord(content: string, sourcePath: string): LegacyReadResult {
  const result = parseRecord(content, sourcePath);
  if (!result.ok) {
    const at = result.error.at ? ` (at ${result.error.at})` : "";
    return {
      source_path: sourcePath,
      classification: "unparseable",
      record: null,
      reasons: [`${result.error.message}${at}`],
    };
  }
  const warnings = result.value.parse_warnings;
  return {
    source_path: sourcePath,
    classification: warnings.length > 0 ? "parsed_with_warnings" : "parsed",
    record: result.value,
    reasons: warnings,
  };
}
