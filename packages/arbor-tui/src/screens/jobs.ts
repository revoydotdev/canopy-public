/**
 * Jobs screen (roadmap 4C, item 16).
 *
 * Bounded view of the job queue from `job.list` plus dispatch controls
 * surfaced ONLY where the canonical capabilities exist: submit, cancel,
 * retry, pause (dispatch throttle, never a task state), resume. A job maps
 * 1:1 to a supervised task; liveness/progress is a projection over live task
 * state, never a second authority.
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

const MAX_ROWS = 200;

function isQueueShape(result: unknown): result is { jobs?: readonly Record<string, unknown>[]; queue_paused?: boolean } {
  return typeof result === "object" && result !== null && "jobs" in result && Array.isArray((result as { jobs?: unknown }).jobs);
}

function jobStateIcon(state: string): string {
  switch (state) {
    case "queued": return "○";
    case "started": return "▶";
    case "retrying": return "↻";
    case "cancel_requested": return "◼";
    case "cancelled": return "⊘";
    case "failed": return "✗";
    case "completed": return "✓";
    case "timed_out": return "⏱";
    default: return "?";
  }
}

function rowCountCaption(caption: string, count: number): string {
  return count > 0 ? `${caption} (${count})` : `no ${caption.toLowerCase()}`;
}

/**
 * `job.list`'s `queue_paused` was destructured out of the shape guard
 * (`isQueueShape`) and then never read: the backend can report the whole
 * dispatch queue is paused (the `job.pause` command this screen already
 * issues controls exactly this flag) and the operator had no way to see it
 * — every job kept rendering its own per-job state as if dispatch were
 * live. Folded into the caption, the same place every other screen here
 * (`campaigns.ts`'s halt reason, `devtools.ts`'s streaming dot) already
 * surfaces queue/stream-level status alongside the row count.
 */
function projectJobs(jobs: readonly Record<string, unknown>[], limit: number, queuePaused: boolean): Omit<ScreenProjection, "variant"> {
  const sliced = jobs.slice(0, limit);
  const bounded = sliced.map((job) => ({
    id: typeof job.id === "string" ? job.id : "?",
    kind: typeof job.kind === "string" ? job.kind : "?",
    // T6 (cosmetic sweep): a raw enum like "cancel_requested" or "timed_out"
    // read as a machine token, not English — humanized to match every other
    // status label in this package (product.ts's `status()`/`readinessLabel()`,
    // etc.), while the icon still switches on the untouched raw value.
    state: `${jobStateIcon(typeof job.state === "string" ? job.state : "?")} ${operatorStateLabel(job.state, "state unavailable")}`,
    owner: typeof job.owner_scope_id === "string" ? job.owner_scope_id : "?",
    operation: typeof job.operation_id === "string" ? job.operation_id : "operation unavailable",
    progress:
      typeof job.progress === "number"
        ? `${Math.round(job.progress * 100)}%`
        : "—",
  }));
  const base = rowCountCaption("Jobs", bounded.length);
  return {
    screen: "jobs",
    rows: bounded,
    columns: [
      { key: "id", title: "Job", width: 14, truncate: "middle" },
      { key: "kind", title: "Kind", width: 16 },
      { key: "state", title: "State", width: 16 },
      { key: "owner", title: "Owner", width: 12 },
      { key: "operation", title: "Operation", width: 14 },
      { key: "progress", title: "Prog", width: 6 },
    ],
    caption: `${queuePaused ? `${base} · QUEUE PAUSED` : base} · canonical job.list`,
    // `job.cancel`/`job.retry` need only `job_id` — the bare id.
    row_ids: sliced.map((job): RowIdentity | null => (typeof job.id === "string" ? { id: job.id } : null)),
  };
}

function renderJobsTable(projection: ScreenProjection, width: number, height: number, offset?: number, selectedId?: string): readonly string[] {
  const rows = projection.rows.map((row) => ({
    ...row,
    id: `${selectedId !== undefined && row.id === selectedId ? "›" : " "} ${String(row.id ?? "")}`,
  }));
  if (rows.length === 0) return [clipDisplay("(no jobs)", width)];
  try {
    const colCount = projection.columns.length;
    const colWidth = Math.max(1, Math.floor((width - (colCount - 1)) / colCount));
    const cols: TableColumn[] = projection.columns.map((c) => ({ key: c.key, title: c.title, width: Math.min(c.width, colWidth) }));
    const lines = renderTable(rows, cols, { height, offset });
    return [clipDisplay(projection.caption ?? "Jobs", width), ...lines];
  } catch {
    return [clipDisplay("(render error)", width)];
  }
}

function emptyProjection(reason: "empty" | "unrecognised"): Omit<ScreenProjection, "variant"> {
  return {
    screen: "jobs",
    rows: [],
    columns: [{ key: "id", title: "Job", width: 10, truncate: "middle" }],
    caption: reason === "empty"
      ? emptyCaption({ what: "No jobs queued", how: "submit one with `arbor task <text>`" })
      : unrecognisedCaption("Jobs"),
  };
}

const JOBS_VARIANTS = [
  defineVariant({
    tag: "jobs",
    match: isQueueShape,
    project: (shape) => {
      // Truncation is bounded by the screen's own MAX_ROWS, not the current
      // viewport height (wave2/tui-input-model) — coupling it to height made
      // widgets.ts's offset parameter permanently inert: on a 30-row pane a
      // 200-row result kept only ~28 rows, leaving nothing for `offset` to
      // scroll into. `render`'s `ctx.scroll_offset`/`renderTable`'s `offset`
      // are what actually windows a long list into the visible viewport now.
      return projectJobs(shape.jobs ?? [], MAX_ROWS, shape.queue_paused === true);
    },
    render: (projection, ctx) => renderJobsTable(projection, ctx.width, ctx.height, ctx.scroll_offset, ctx.selected_id),
  }),
];

export const jobsScreen: ScreenModule = {
  id: "jobs" as ScreenId,
  title: "Jobs",
  required_capabilities: ["job.read", "job.write"],

  surface: {
    commands: ["job.submit", "job.cancel", "job.retry", "job.pause", "job.resume"],
    queries: ["job.list"],
  },

  ...buildScreenPipeline(JOBS_VARIANTS, { emptyProjection }),
};
