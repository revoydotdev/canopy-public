/**
 * Output screen (roadmap 4C, item 18).
 *
 * Bounded tool/stream output view — accepted operations, progress, and a
 * BOUNDED virtual output stream. Raw oversized output is never rendered
 * into the view: only a bounded preview + counts + evidence pointer are
 * projected (roadmap 4B.3). Control only for the real catalog capability
 * `output.capture` (supported:true); queries `output.descriptor` (one
 * artifact, by id) and `output.list` (the enumeration this screen refreshes
 * on, backed by OutputEvidenceStore.list()).
 *
 * Leaf module. Depends only on @arbor/core (via widgets) and the
 * runtime-port/screen contracts — never @arbor/mcp.
 */

import { clipDisplay, renderStreamViewport, renderTable } from "../widgets.js";
import type { TableColumn } from "../widgets.js";
import type { RowIdentity, ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";

const MAX_TABLE_ROWS = 200;
const MAX_PREVIEW_CHARS = 2_000;

function isDescriptorShape(result: unknown): result is Record<string, unknown> {
  return typeof result === "object" && result !== null;
}

/**
 * A genuinely empty capture list (a healthy store with nothing captured
 * yet, or a query that legitimately matched zero records) is a real result,
 * not an edge case to special-case away. The same bug already found and
 * fixed in `screens/operations.ts`'s `isOperationListShape`: gating on
 * `result.length > 0` makes an empty `[]` fail this shape check and fall
 * through to `emptyProjection()` — "No data" — which is indistinguishable
 * from "no query has run yet" or "the store is broken". Checked first (an
 * empty array is `[]` regardless of what it's an array *of*), so `[]`
 * short-circuits true before the element-shape check below ever runs.
 */
function isCaptureListShape(result: unknown): result is readonly Record<string, unknown>[] {
  if (!Array.isArray(result)) return false;
  if (result.length === 0) return true;
  return typeof result[0] === "object" && result[0] !== null;
}

function rowCountCaption(caption: string, count: number): string {
  return count > 0 ? `${caption} (${count})` : `no ${caption.toLowerCase()}`;
}

function projectDescriptor(
  shape: Record<string, unknown>,
): Omit<ScreenProjection, "variant"> {
  // The live `output.descriptor` response is `{descriptor, preview?}`. Raw
  // output uses `{evidence_id, content}` and shares this renderer only after
  // being structurally unwrapped here; never assume the evidence id is flat.
  const descriptor = shape.descriptor !== null && typeof shape.descriptor === "object"
    ? shape.descriptor as Record<string, unknown> : shape;
  const evidenceId = typeof descriptor.id === "string"
    ? descriptor.id : (typeof shape.evidence_id === "string" ? shape.evidence_id : null);
  const preview = shape.preview !== null && typeof shape.preview === "object" ? shape.preview as Record<string, unknown> : shape;
  const content = typeof preview.content === "string" ? preview.content : "";
  // A completed capture's preview stays the existing bounded HEAD slice — a
  // finished artifact never grows, so the first MAX_PREVIEW_CHARS is a
  // stable window (roadmap 4B.3). A still-running capture (ADR-104 Decision
  // 3 / O4) is a separate, explicitly time-bounded branch on this same
  // shape: it renders the bounded TAIL instead, because an operator
  // watching a live stream needs whatever arrived most recently, not the
  // first chars written possibly seconds ago — and that tail keeps sliding
  // as the underlying capture keeps writing between polls. Either branch is
  // capped at the same MAX_PREVIEW_CHARS ceiling; in-progress never widens
  // it.
  const inProgress = preview.in_progress === true || descriptor.status === "in_progress";
  const channel = typeof descriptor.stream === "string" ? descriptor.stream : "unavailable";
  const trimmed = inProgress
    ? content.slice(Math.max(0, content.length - MAX_PREVIEW_CHARS))
    : content.slice(0, MAX_PREVIEW_CHARS);
  const truncated = content.length > trimmed.length;

  const rows: readonly Readonly<Record<string, unknown>>[] = [
    {
      evidence_id: evidenceId ?? "—",
      preview_chars: String(trimmed.length),
      truncated: truncated ? "yes" : "no",
      in_progress: inProgress ? "yes" : "no",
      channel,
      source: "canonical/output-evidence",
      // Only output.raw produces `shape.content`; that query is approval-bound
      // in the catalog. Descriptor responses never carry blob bytes.
      content: trimmed,
    },
  ];

  return {
    screen: "output",
    rows,
    columns: [
      { key: "evidence_id", title: "Evidence", width: 24 },
      { key: "preview_chars", title: "Preview", width: 9 },
      { key: "truncated", title: "Trunc", width: 6 },
      { key: "in_progress", title: "Live", width: 5 },
      { key: "channel", title: "Channel", width: 10 },
      { key: "source", title: "Source", width: 18 },
    ],
    caption: evidenceId ? `Output ${evidenceId}${inProgress ? " (live)" : ""} · ${channel} · canonical/output-evidence` : "Output · canonical/output-evidence",
    row_ids: [evidenceId === null ? null : { id: evidenceId }],
  };
}

/** The evidence id a capture row's `output.descriptor`/`output.raw` follow-up query needs, or `null` when this entry carries none (a corrupt record). */
function captureEvidenceId(item: Record<string, unknown>, source: Record<string, unknown>, corrupt: boolean): string | null {
  if (corrupt) return typeof item.id === "string" ? item.id : null;
  if (typeof source.id === "string") return source.id;
  if (typeof source.evidence_id === "string") return source.evidence_id;
  if (typeof source.evidence === "string") return source.evidence;
  return null;
}

function projectCaputures(
  rows: readonly Record<string, unknown>[],
  limit: number,
): Omit<ScreenProjection, "variant"> {
  const sliced = rows.slice(0, limit);
  const bounded = sliced.map((item) => {
    // `output.list` returns a discriminated entry — {status:"ok", record} or
    // {status:"corrupt", id, error} — so the descriptor fields live one level
    // down. Read through `record` when it is present, but keep reading the
    // flat shape too: this screen is structural by design (ADR-011 keeps
    // arbor-tui off @arbor/audit's types), so it must not assume one producer.
    const nested = item.record;
    const source: Record<string, unknown> =
      typeof nested === "object" && nested !== null ? nested as Record<string, unknown> : item;

    // A corrupt descriptor has no readable fields at all. Surfacing it as a
    // row of "?" would make tampering look like missing metadata; name it.
    const corrupt = item.status === "corrupt";

    return {
      operation: corrupt
        ? (typeof item.id === "string" ? item.id : "?")
        : (typeof source.operation_id === "string" ? source.operation_id
          : (typeof source.id === "string" ? source.id : "?")),
      kind: corrupt
        ? "corrupt"
        : (typeof source.stream === "string" ? source.stream
          : (typeof source.kind === "string" ? source.kind : "?")),
      status: typeof item.status === "string" ? item.status : "?",
      bytes: typeof source.byte_count === "number" ? String(source.byte_count)
        : (typeof source.bytes === "number" ? String(source.bytes) : "—"),
      evidence: captureEvidenceId(item, source, corrupt) ?? "—",
      source: corrupt ? "canonical/corrupt-descriptor" : "canonical/output-evidence",
    };
  });

  return {
    screen: "output",
    rows: bounded,
    columns: [
      { key: "operation", title: "Operation", width: 18 },
      { key: "kind", title: "Kind", width: 14 },
      { key: "status", title: "Status", width: 10 },
      { key: "bytes", title: "Bytes", width: 8 },
      { key: "evidence", title: "Evidence", width: 24 },
      { key: "source", title: "Source", width: 18 },
    ],
    caption: rowCountCaption("Outputs", bounded.length),
    // `output.descriptor`/`output.capture`(re-capture)/`output.raw` all key
    // off `evidence_id` — the same value the `evidence` column already
    // resolves, exposed here as typed identity rather than a display string.
    row_ids: sliced.map((item): RowIdentity | null => {
      const nested = item.record;
      const source: Record<string, unknown> = typeof nested === "object" && nested !== null ? nested as Record<string, unknown> : item;
      const id = captureEvidenceId(item, source, item.status === "corrupt");
      return id === null ? null : { id };
    }),
  };
}

function renderDescriptor(
  projection: ScreenProjection,
  width: number,
  height: number,
): readonly string[] {
  const first = projection.rows[0];
  const evidence = first ? String(first.evidence_id ?? "") : "";
  const charCount = first ? Number(first.preview_chars) || 0 : 0;

  // Read the preview from the projection? We keep a bounded head/tail preview
  // in the caption and rows; render a stream viewport placeholder with the
  // evidence pointer. Raw content is NOT rendered (roadmap 4B.3).
  const disclosed = typeof first?.content === "string" ? first.content : "";
  const head = disclosed ? [disclosed] : ["[descriptor only — raw review requires approved disclosure]"];
  const preamble: string[] = [clipDisplay(projection.caption ?? "Output", width)];
  if (charCount > 0) {
    preamble.push(clipDisplay(`${charCount} preview chars${evidence ? ` — ${evidence}` : ""}`, width));
  }
  const stream = renderStreamViewport(head.join("\n"), {
    width,
    height: Math.max(1, height - preamble.length),
    evidence_pointer: evidence || undefined,
  });
  return [...preamble, ...stream];
}

function renderCaputuresTable(
  projection: ScreenProjection,
  width: number,
  height: number,
  offset?: number,
): readonly string[] {
  const rows = projection.rows;
  if (rows.length === 0) {
    return [clipDisplay(projection.caption ?? "No outputs", width)];
  }

  const colCount = projection.columns.length;
  const colWidth = Math.max(1, Math.floor((width - (colCount - 1)) / colCount));
  const cols: TableColumn[] = projection.columns.map((c) => ({
    key: c.key,
    title: c.title,
    width: Math.min(c.width, colWidth),
  }));

  try {
    const lines = renderTable(rows, cols, { height, offset });
    return [clipDisplay(projection.caption ?? "Outputs", width), ...lines];
  } catch {
    return [clipDisplay("(render error)", width)];
  }
}

function emptyProjection(): Omit<ScreenProjection, "variant"> {
  return {
    screen: "output",
    rows: [],
    columns: [{ key: "id", title: "ID", width: 10, truncate: "middle" }],
    // This screen shows *captured tool/stream output* (OutputEvidenceStore),
    // never a campaign's claimed/verified root result — a genuinely empty
    // capture store is common and does not mean the campaign produced
    // nothing. A pilot-run defect ("Output said no outputs despite claimed
    // results existing") turned out to be exactly this label being read as
    // "campaign result"; the caption says what it actually measures instead.
    caption: "No captured tool/stream output — see the tree/cockpit screen for the campaign's claimed or verified result",
  };
}

// raw content / descriptor shape (has evidence_id or content)
function isDescriptorVariantShape(result: unknown): result is Record<string, unknown> {
  return isDescriptorShape(result) && (typeof result.content === "string" || "evidence_id" in result || "descriptor" in result);
}

const OUTPUT_VARIANTS = [
  defineVariant({
    tag: "descriptor",
    match: isDescriptorVariantShape,
    project: (shape) => projectDescriptor(shape),
    render: (projection, ctx) => renderDescriptor(projection, ctx.width, ctx.height),
  }),
  defineVariant({
    tag: "captures",
    match: isCaptureListShape,
    project: (shape) => projectCaputures(shape, MAX_TABLE_ROWS),
    render: (projection, ctx) => renderCaputuresTable(projection, ctx.width, ctx.height, ctx.scroll_offset),
  }),
];

export const outputScreen: ScreenModule = {
  id: "output" as ScreenId,
  title: "Output",
  required_capabilities: ["output.read", "output.capture"],

  surface: {
    commands: ["output.capture"],
    // `output.descriptor` already has a real, tested render path (the
    // "descriptor" variant above) — it just has no live caller yet: like
    // `operations.ts`'s `operation.get`, `tui.ts`'s own comment says why
    // ("no selection surface in scope"). This screen's new `row_ids`
    // (`captureEvidenceId`) supplies exactly the `evidence_id` a row-targeted
    // "view descriptor" dispatch would need; wiring that dispatch is a
    // `tui.ts` change, out of scope here (Lane 1 owns arbor-mcp/src/tui.ts).
    queries: ["output.descriptor", "output.list"],
  },

  ...buildScreenPipeline(OUTPUT_VARIANTS, { emptyProjection }),
};
