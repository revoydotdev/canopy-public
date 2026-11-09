/**
 * Operations screen (roadmap 4C, items 17/23).
 *
 * Bounded canonical view of active operations with cancellation. Recovery
 * and runtime-event diagnostics remain on their dedicated screens. Queries:
 * operation.list (the real enumeration backed by OperationRegistry.list)
 * and operation.get.
 *
 * `operation.list` yields the real `OperationRecord` shape
 * (arbor-core/src/operation-registry.ts): `operation_id`, `state`,
 * `capability`, and (once terminal) `error.recoverable`. There is no `kind`
 * field on `OperationRecord`, and `runtime-catalog.ts`'s `operation.list`
 * handler passes the registry's own records straight through with no
 * enrichment, so no real producer of this query has ever supplied one — a
 * "Kind" column here would be a permanent, non-actionable "?" burning a
 * fixed slice of a narrow terminal. The column was removed rather than
 * repurposed onto `capability`: `capability` already has its own column, and
 * duplicating it under a second header would be worse than the empty column
 * it replaced.
 *
 * Errors surface as structured RuntimeResult failures (code/summary),
 * mapped deterministically — never a generic throw.
 *
 * Leaf module. Depends only on @arbor/core (via widgets) and the
 * runtime-port/screen contracts — never @arbor/mcp.
 */

import { clipDisplay, renderTable } from "../widgets.js";
import type { TableColumn } from "../widgets.js";
import type { RowIdentity, ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";
import { emptyCaption, unrecognisedCaption } from "./empty-state.js";

const MAX_TABLE_ROWS = 200;

/**
 * An empty array counts as a real (if empty) operation list — real dispatch
 * of `operation.list` against a healthy runtime with no active operations
 * returns exactly `[]`, which is the common steady state, not an edge case.
 * Without this, `result[0]` on an empty array is `undefined` (not `"object"`
 * by `typeof`), so `[]` fell through to `isEventListShape` below (vacuously
 * true on any array via `.every`) and rendered the wrong caption — "no
 * errors" for a plain "there are no operations right now". Checked first in
 * OPERATIONS_VARIANTS, this is what keeps `[]` correctly captioned.
 */
function isOperationListShape(result: unknown): result is readonly Record<string, unknown>[] {
  if (!Array.isArray(result)) return false;
  if (result.length === 0) return true;
  return result.every((item) => {
    if (item === null || typeof item !== "object") return false;
    const record = item as Record<string, unknown>;
    return typeof record.operation_id === "string" && typeof record.state === "string" && typeof record.capability === "string";
  });
}

function rowCountCaption(caption: string, count: number): string {
  return count > 0 ? `${caption} (${count})` : `no ${caption.toLowerCase()}`;
}

/**
 * `recoverable` reads a flat boolean when present (the projected
 * error-row shape, and older synthetic fixtures), else the real
 * `OperationRecord.error.recoverable` (`RuntimeError`'s own field) for a
 * terminal operation — never fabricated when neither is present (a live
 * accepted/running operation has no error yet, so recoverability is moot).
 */
function recoverableLabel(item: Readonly<Record<string, unknown>>): string {
  if (typeof item.recoverable === "boolean") return item.recoverable ? "yes" : "no";
  const error = item.error;
  if (error !== null && typeof error === "object" && typeof (error as Record<string, unknown>).recoverable === "boolean") {
    return (error as Record<string, unknown>).recoverable ? "yes" : "no";
  }
  return "—";
}

function operationIdOf(item: Readonly<Record<string, unknown>>): string | null {
  if (typeof item.operation_id === "string") return item.operation_id;
  if (typeof item.id === "string") return item.id;
  return null;
}

function projectOperations(
  rows: readonly Record<string, unknown>[],
  limit: number,
): Omit<ScreenProjection, "variant"> {
  const sliced = rows.slice(0, limit);
  const bounded = sliced.map((item) => ({
    id: operationIdOf(item) ?? "?",
    state: typeof item.state === "string" ? item.state : "?",
    capability: typeof item.capability === "string" ? item.capability : "?",
    recoverable: recoverableLabel(item),
    source: "canonical/operation-registry",
  }));

  return {
    screen: "operations",
    rows: bounded,
    columns: [
      { key: "id", title: "Operation", width: 22, truncate: "middle" },
      { key: "state", title: "State", width: 13 },
      { key: "capability", title: "Capability", width: 16 },
      { key: "recoverable", title: "Rec", width: 5 },
      { key: "source", title: "Source", width: 18 },
    ],
    caption: rowCountCaption("Operations", bounded.length),
    // `operation.cancel` needs only `target_operation_id` — the bare id.
    // `recovery.retry`/`recovery.abandon` need MORE than this row carries
    // (campaign_id, node_id, reason) — `OperationRecord` has no such fields,
    // so those two commands cannot be fully addressed from this row alone;
    // flagged here rather than silently under-populating `context`.
    row_ids: sliced.map((item): RowIdentity | null => {
      const id = operationIdOf(item);
      return id === null ? null : { id };
    }),
  };
}

/**
 * `operation.get`'s real return value: one raw `OperationRecord`
 * (arbor-core/src/operation-registry.ts), never an array. Distinguished from
 * every other variant by `!Array.isArray` — `isOperationListShape` etc. all
 * require an array, so there is no ambiguity with a single record.
 */
function isOperationDetailShape(result: unknown): result is Record<string, unknown> {
  return (
    typeof result === "object" &&
    result !== null &&
    !Array.isArray(result) &&
    typeof (result as Record<string, unknown>).operation_id === "string" &&
    typeof (result as Record<string, unknown>).state === "string"
  );
}

/**
 * Single-record detail view (mirrors `output.ts`'s descriptor variant): the
 * canonical list/detail split for an operation selected by id.
 */
function projectOperationDetail(item: Record<string, unknown>): Omit<ScreenProjection, "variant"> {
  const id = operationIdOf(item) ?? "?";
  const row = {
    id,
    state: typeof item.state === "string" ? item.state : "?",
    capability: typeof item.capability === "string" ? item.capability : "?",
    recoverable: recoverableLabel(item),
    task: typeof item.task_id === "string" ? item.task_id : "—",
    result: typeof item.result_summary === "string" ? item.result_summary : "—",
    source: "canonical/operation-registry",
  };
  return {
    screen: "operations",
    rows: [row],
    columns: [
      { key: "id", title: "Operation", width: 22, truncate: "middle" },
      { key: "state", title: "State", width: 13 },
      { key: "capability", title: "Capability", width: 16 },
      { key: "recoverable", title: "Rec", width: 5 },
      { key: "task", title: "Task", width: 18 },
      { key: "result", title: "Result", width: 30 },
      { key: "source", title: "Source", width: 18 },
    ],
    caption: `Operation ${id}`,
    row_ids: [id === "?" ? null : { id }],
  };
}

function renderOperationsTable(
  projection: ScreenProjection,
  width: number,
  height: number,
  offset?: number,
): readonly string[] {
  const rows = projection.rows;
  if (rows.length === 0) {
    return [clipDisplay("(no operations)", width)];
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
    return [clipDisplay(projection.caption ?? "Operations", width), ...lines];
  } catch {
    return [clipDisplay("(render error)", width)];
  }
}

// ── mode detection: does the projection hold errors (has a `code` column) or operations? ──

function emptyProjection(reason: "empty" | "unrecognised"): Omit<ScreenProjection, "variant"> {
  return {
    screen: "operations",
    rows: [],
    columns: [{ key: "id", title: "ID", width: 10, truncate: "middle" }],
    caption: reason === "empty"
      ? emptyCaption({ what: "No active operations", how: "they appear once a governed command is dispatched" })
      : unrecognisedCaption("Operations"),
  };
}

const OPERATIONS_VARIANTS = [
  defineVariant({
    tag: "detail",
    match: isOperationDetailShape,
    project: (shape) => projectOperationDetail(shape),
    render: (projection, ctx) => renderOperationsTable(projection, ctx.width, ctx.height, ctx.scroll_offset),
  }),
  defineVariant({
    tag: "operations",
    match: isOperationListShape,
    project: (shape) => projectOperations(shape, MAX_TABLE_ROWS),
    render: (projection, ctx) => renderOperationsTable(projection, ctx.width, ctx.height, ctx.scroll_offset),
  }),
];

export const operationsScreen: ScreenModule = {
  id: "operations" as ScreenId,
  title: "Operations",
  required_capabilities: ["operation.read", "operation.cancel"],

  surface: {
    commands: ["operation.cancel"],
    // Diagnostics owns event.resume. Operations consumes only canonical
    // operation-registry list/detail projections.
    queries: ["operation.list", "operation.get"],
  },

  ...buildScreenPipeline(OPERATIONS_VARIANTS, { emptyProjection }),
};
