/**
 * Bounded causal-document presentation for durable message projections.
 *
 * This helper owns no message state, ordering, or lifecycle inference. Screen
 * adapters supply the exact authority/source label and relationships already
 * present in their canonical query result.
 */
import { clipDisplay, wrapDisplay } from "../widgets.js";

export interface CausalMessageDocumentRow {
  readonly id: string;
  readonly kind: string;
  readonly actor: string;
  readonly recipients: string;
  readonly source: string;
  readonly truth: "canonical" | "supplemental" | "unavailable";
  /** Exact producer-supplied parent/reply/ack/retraction references. */
  readonly relationship: string;
  /** A producer-projected delivery/acknowledgement fact, never local state. */
  readonly status: string | null;
  readonly detail: string | null;
}

export function renderCausalMessageDocument(
  caption: string,
  rows: readonly CausalMessageDocumentRow[],
  width: number,
  height: number,
  offset = 0,
): readonly string[] {
  const header = clipDisplay(caption, width);
  if (rows.length === 0) return [header];
  if (!Number.isSafeInteger(offset) || offset < 0) return [clipDisplay("(render error)", width)];

  const bodyHeight = Math.max(0, height - 1);
  const lines: string[] = [];
  for (const row of rows.slice(offset)) {
    const status = row.status === null ? "" : ` · ${row.status}`;
    const primary = `↳ ${row.kind} · ${row.actor} → ${row.recipients} · ${row.truth}/${row.source}${status}`;
    lines.push(...wrapDisplay(primary, width).slice(0, 2).map((line, index) => clipDisplay(index === 0 ? line : `  ${line}`, width)));
    lines.push(...wrapDisplay(`  ${row.relationship} · id ${row.id}`, width).slice(0, 2).map((line) => clipDisplay(line, width)));
    if (row.detail !== null && row.detail.length > 0) {
      lines.push(...wrapDisplay(`  ${row.detail}`, Math.max(1, width)).slice(0, 2).map((line) => clipDisplay(line, width)));
    }
    lines.push("");
    if (lines.length >= bodyHeight) break;
  }
  return [header, ...lines.slice(0, bodyHeight)];
}
