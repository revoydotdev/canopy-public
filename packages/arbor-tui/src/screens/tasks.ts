/**
 * Tasks screen (roadmap 4C, item 17).
 *
 * Bounded hierarchy of supervised tasks (progress, cleanup, failure
 * diagnostics), projected from the canonical `task.list` query. The only
 * issued control is a real catalog capability — `task.retry`
 * (supported:true per RUNTIME_CATALOG) — whose required capability
 * (`task.read`) is declared in required_capabilities.
 *
 * G-31: `task.list`'s real result (`runtime-catalog.ts`'s
 * `executeQueryValue`, case "task.list") is a cursor page —
 * `{items: SupervisorTask[], next_cursor, total, limit}` — never a raw
 * array; the ORIGINAL guard here never matched it. Each item is a real
 * `SupervisorTask` (`arbor-core/src/task-supervisor.ts` /
 * `runtime-contracts.ts`), whose lifecycle field is `.state` (not
 * `.status`) with a closed enum: accepted|started|retrying|
 * cancel_requested|cancelled|failed|completed|timed_out.
 *
 * Two real callers feed this screen, with two different top-level shapes
 * (the same pattern found in `campaigns.ts`'s list variant while wiring
 * G-32): `arbor-mcp/src/tui.ts`'s live `issue_query` round trip passes the
 * router's `{items, ...}` page straight through, while `demo.ts`'s
 * `feedAutoScreens` pre-unwraps `.items` and feeds a raw `SupervisorTask[]`.
 * Both variants below funnel into the same `.state`-correct projection.
 *
 * Leaf module. Depends only on @arbor/core (via widgets) and the
 * runtime-port/screen contracts — never @arbor/mcp.
 */

import { clipDisplay, renderTable } from "../widgets.js";
import type { TableColumn } from "../widgets.js";
import type { RowIdentity, ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";
import { emptyCaption, unrecognisedCaption } from "./empty-state.js";
import { operatorStateLabel } from "../operator-view-model.js";

const MAX_TABLE_ROWS = 200;

/** The real `task.list` cursor-page shape: `{items, next_cursor, total, limit}`. */
function isTaskPageShape(result: unknown): result is { readonly items: readonly Record<string, unknown>[] } {
  return (
    typeof result === "object" &&
    result !== null &&
    "items" in result &&
    Array.isArray((result as { items?: unknown }).items) &&
    ((result as { items?: readonly unknown[] }).items ?? []).length > 0
  );
}

/** `demo.ts`'s pre-unwrapped `task.list().items` — a raw `SupervisorTask[]`. */
function isTaskListShape(result: unknown): result is readonly Record<string, unknown>[] {
  return (
    Array.isArray(result) &&
    result.length > 0 &&
    typeof result[0] === "object" &&
    result[0] !== null
  );
}

/** Mirrors `SupervisorTaskState` (`arbor-core/src/runtime-contracts.ts`) exactly. */
function taskStateIcon(state: string): string {
  switch (state) {
    case "accepted":
      return "○";
    case "started":
      return "▶";
    case "retrying":
      return "↻";
    case "cancel_requested":
      return "◼";
    case "cancelled":
      return "⊘";
    case "failed":
      return "✗";
    case "completed":
      return "✓";
    case "timed_out":
      return "⏱";
    default:
      return "?";
  }
}

function rowCountCaption(caption: string, count: number): string {
  return count > 0 ? `${caption} (${count})` : `no ${caption.toLowerCase()}`;
}

function projectTaskList(
  rows: readonly Record<string, unknown>[],
  limit: number,
): Omit<ScreenProjection, "variant"> {
  const sliced = rows.slice(0, limit);
  const bounded = sliced.map((item) => ({
    id: typeof item.id === "string" ? item.id : "?",
    kind: typeof item.kind === "string" ? item.kind : "?",
    // T6 (cosmetic sweep): humanized to match every other status label in
    // this package — the icon still switches on the untouched raw value.
    state: item.interrupted === true
      // EC-053: durable `started` evidence with no live worker behind it.
      ? `‖ interrupted (was ${operatorStateLabel(item.state, "unknown")})`
      : `${taskStateIcon(typeof item.state === "string" ? item.state : "?")} ${operatorStateLabel(item.state, "state unavailable")}`,
    progress:
      typeof item.progress === "number" && Number.isFinite(item.progress) && item.progress >= 0 && item.progress <= 1
        ? `${Math.round(item.progress * 100)}%`
      : typeof item.progress === "string"
          ? item.progress
          : "—",
    owner: typeof item.owner_scope_id === "string" ? item.owner_scope_id : "?",
    parent: typeof item.parent_id === "string" ? item.parent_id : "root task",
    operation: typeof item.operation_id === "string" ? item.operation_id : "operation unavailable",
    cleanup: typeof item.cleanup === "string" ? operatorStateLabel(item.cleanup) : "not reported",
  }));

  return {
    screen: "tasks",
    rows: bounded,
    columns: [
      { key: "id", title: "Task", width: 14, truncate: "middle" },
      { key: "kind", title: "Kind", width: 14 },
      { key: "state", title: "State", width: 16 },
      { key: "progress", title: "Progress", width: 9 },
      { key: "owner", title: "Owner", width: 14 },
      { key: "parent", title: "Parent", width: 14 },
      { key: "operation", title: "Operation", width: 14 },
      { key: "cleanup", title: "Cleanup", width: 12 },
    ],
    caption: `${rowCountCaption("Tasks", bounded.length)} · canonical task.list`,
    // `task.retry` (surface.commands) needs only `task_id` — the bare id.
    row_ids: sliced.map((item): RowIdentity | null => (typeof item.id === "string" ? { id: item.id } : null)),
  };
}

function renderTaskTable(
  projection: ScreenProjection,
  width: number,
  height: number,
  offset?: number,
): readonly string[] {
  const rows = projection.rows;
  if (rows.length === 0) {
    return [clipDisplay("(no tasks)", width)];
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
    return [clipDisplay(projection.caption ?? "Tasks", width), ...lines];
  } catch {
    return [clipDisplay("(render error)", width)];
  }
}

function emptyProjection(reason: "empty" | "unrecognised"): Omit<ScreenProjection, "variant"> {
  return {
    screen: "tasks",
    rows: [],
    columns: [{ key: "id", title: "ID", width: 10, truncate: "middle" }],
    caption: reason === "empty"
      ? emptyCaption({ what: "No supervised tasks", how: "submit one with `arbor task <text>`" })
      : unrecognisedCaption("Tasks"),
  };
}

const TASKS_VARIANTS = [
  defineVariant({
    tag: "paged-list",
    match: isTaskPageShape,
    project: (shape) => projectTaskList(shape.items, MAX_TABLE_ROWS),
    render: (projection, ctx) => renderTaskTable(projection, ctx.width, ctx.height, ctx.scroll_offset),
  }),
  defineVariant({
    tag: "list",
    match: isTaskListShape,
    project: (shape) => projectTaskList(shape, MAX_TABLE_ROWS),
    render: (projection, ctx) => renderTaskTable(projection, ctx.width, ctx.height, ctx.scroll_offset),
  }),
];

export const tasksScreen: ScreenModule = {
  id: "tasks" as ScreenId,
  title: "Tasks",
  required_capabilities: ["task.read"],

  surface: {
    commands: ["task.retry"],
    queries: ["task.list"],
  },

  ...buildScreenPipeline(TASKS_VARIANTS, { emptyProjection }),
};
