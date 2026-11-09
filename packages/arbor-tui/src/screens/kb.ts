/**
 * KB screen (finding 8, TUI-vs-backend observability gap audit).
 *
 * Renders the real, capability-gated Knowledge Base entries `kb.list`
 * (`@arbor/mcp`'s `runtime-catalog.ts`, backed by `CampaignManager.kbQuery`)
 * returns: failure_mode/success_pattern/parameter_finding entries with their
 * actual `value`/`failure_mode`/`root_cause`/`fix_template`/`parameter`/
 * `validated_value` content. Previously an operator only ever saw the entry's
 * opaque id flash through the diagnostics event log
 * (`kb.entry_added`/`diagnostics.ts`) — the content itself was unreachable.
 *
 * This is a LEAF module: it never imports `@arbor/kb`, `@arbor/core`, or
 * `@arbor/mcp` (ADR-011). Rows are envelopes: an absent entry (a
 * `critic_only` fact this consumer's tier cannot see) is rendered as a real
 * "redacted" row, never silently dropped or fabricated.
 */
import { clipLabelWithEllipsis } from "./region.js";

import type { RowIdentity, ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";
import { emptyCaption, unrecognisedCaption } from "./empty-state.js";
import { renderStatusDocument } from "./status-document.js";

const MAX_ROWS = 200;
const MAX_DETAIL_CHARS = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface KbEnvelopeShape {
  readonly id?: string;
  readonly absence?: string | null;
  readonly provenance?: { readonly tag?: string } | null;
  readonly as_of?: string;
  readonly value?: {
    readonly type?: string;
    readonly value?: string;
    readonly tier?: string;
    readonly failure_mode?: string;
    readonly root_cause?: string;
    readonly fix_template?: string;
    readonly parameter?: string;
    readonly validated_value?: string;
  } | null;
}

/** Recognized as a `kb.list` result: an array (possibly empty — a real "no entries yet" is not "no query issued"). */
function isKbListShape(result: unknown): result is readonly KbEnvelopeShape[] {
  if (!Array.isArray(result)) return false;
  if (result.length === 0) return true;
  return isRecord(result[0]) && "id" in result[0];
}

function rowCountCaption(count: number): string {
  // Name the subject and what creates a record (EC-012); "no KB entries"
  // stated absence without telling the operator what a KB entry IS.
  return count > 0 ? `KB entries (${count})` : "No knowledge entries yet — entries appear as campaigns record findings and patterns";
}

/** Mirrors kb.ts's KBEntry.value shape: the human-readable summary a row shows. */
function entryDetail(value: KbEnvelopeShape["value"]): string {
  if (!value) return "";
  switch (value.type) {
    case "failure_mode":
      return `${value.failure_mode ?? value.value ?? "?"}${value.root_cause ? ` (cause: ${value.root_cause})` : ""}`;
    case "parameter_finding":
      return `${value.parameter ?? "?"} = ${value.validated_value ?? "?"}`;
    case "success_pattern":
      return value.value ?? "?";
    default:
      return value.value ?? "?";
  }
}

function projectKbList(entries: readonly KbEnvelopeShape[], limit: number): Omit<ScreenProjection, "variant"> {
  const sliced = entries.slice(0, limit);
  const bounded = sliced.map((entry) => {
    const redacted = entry.value == null;
    return {
      id: typeof entry.id === "string" ? entry.id : "?",
      type: entry.value?.type ?? (redacted ? "-" : "?"),
      tier: entry.value?.tier ?? (redacted ? "-" : "?"),
      provenance: redacted ? "[redacted]" : entry.provenance?.tag ?? "unknown",
      as_of: redacted ? "[redacted]" : entry.as_of ?? "unknown",
      detail: redacted ? `[redacted: ${entry.absence ?? "capability_required"}]` : clipLabelWithEllipsis(entryDetail(entry.value), MAX_DETAIL_CHARS),
    };
  });
  return {
    screen: "kb",
    rows: bounded,
    columns: [
      { key: "id", title: "ID", width: 10, truncate: "middle" },
      { key: "type", title: "Type", width: 16 },
      { key: "tier", title: "Tier", width: 16 },
      { key: "provenance", title: "Provenance", width: 16 },
      { key: "as_of", title: "As of", width: 16 },
      { key: "detail", title: "Detail", width: 60 },
    ],
    caption: rowCountCaption(bounded.length),
    row_ids: sliced.map((entry): RowIdentity | null => (typeof entry.id === "string" ? { id: entry.id } : null)),
  };
}

function renderKbTable(projection: ScreenProjection, width: number, height: number, offset?: number): readonly string[] {
  return renderStatusDocument(projection, width, height, offset, {
    wide_min_columns: 160,
    empty_caption: "No knowledge entries",
    empty_title: "KNOWLEDGE BASE",
    empty_hint: "Ctrl+P: return to Console or inspect Campaigns.",
  });
}

function emptyProjection(reason: "empty" | "unrecognised"): Omit<ScreenProjection, "variant"> {
  return {
    screen: "kb",
    rows: [],
    columns: [{ key: "id", title: "ID", width: 10, truncate: "middle" }],
    caption: reason === "empty"
      ? emptyCaption({ what: "No KB entries yet", how: "they accrue as nodes verify — run `arbor task <text>`" })
      : unrecognisedCaption("Knowledge Base"),
  };
}

const KB_VARIANTS = [
  defineVariant({
    tag: "entries",
    match: isKbListShape,
    project: (shape) => projectKbList(shape, MAX_ROWS),
    render: (projection, ctx) => renderKbTable(projection, ctx.width, ctx.height, ctx.scroll_offset),
  }),
];

export const kbScreen: ScreenModule = {
  id: "kb" as ScreenId,
  title: "Knowledge Base",
  required_capabilities: ["kb.read"],

  surface: { commands: [], queries: ["kb.list"] },

  ...buildScreenPipeline(KB_VARIANTS, { emptyProjection, shortCircuitEmptyRows: false }),
};
