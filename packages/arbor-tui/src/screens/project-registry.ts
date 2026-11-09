/**
 * Project Registry screen (multi-project registry, ADR-076 / Roadmap 23).
 *
 * The `projects` screen (product.ts) only ever showed the CURRENT checkout's
 * own enrollment overlay state — a single `project`, never a list. This
 * screen is the missing multi-project view: every entry `arbor project
 * registry list`/`arbor project registry verify` already report, with the
 * same real, fresh-every-call discharge (`project.registry.list` — backed by
 * `verifyRegistryEntry`, ADR-076's one evaluation path) that makes a broken
 * or stale entry visually obvious instead of a static "conformant" label
 * nobody re-checks.
 *
 * Two variants share one screen (registry.ts's table-driven pipeline):
 *   - "registry": the list/re-check projection (`project.registry.list`).
 *     Re-issuing this query — for the whole registry, or scoped to one
 *     `project_id` via `view_selected_row_detail` (update.ts) — IS the
 *     "verify/re-check an entry" operator action; no second evaluation path.
 *   - "manage": the reconcile-pass projection (`project.manage`, Roadmap 23
 *     W6's real per-entry gate battery), triggered by the operator's
 *     `cmd:project.manage` action (default-catalog.ts, key ctrl+shift+n).
 *
 * Leaf module: depends only on @arbor/core (via widgets) and the
 * runtime-port/screen contracts — never @arbor/mcp.
 */
import { clipDisplay, renderTable, wrapDisplay } from "../widgets.js";
import { clipLabelWithEllipsis } from "./region.js";
import type { TableColumn } from "../widgets.js";
import type { RowIdentity, ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";

const MAX_ROWS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface RegistryFailureShape {
  readonly code?: string;
  readonly detail?: string;
}

interface RegistryEntryShape {
  readonly project_id?: string;
  readonly path?: string;
  readonly verified_at_revision?: string;
  readonly verified_at?: string;
  readonly expires?: string;
  readonly ok?: boolean;
  readonly failures?: readonly RegistryFailureShape[];
}

interface RegistryListShape {
  readonly present?: boolean;
  readonly entry_count?: number;
  readonly ok?: boolean;
  readonly entries?: readonly RegistryEntryShape[];
}

/** `project.registry.list`'s projection: recognized by `present` (a field only that query's shape carries). */
function isRegistryListShape(result: unknown): result is RegistryListShape {
  return isRecord(result) && typeof result.present === "boolean" && Array.isArray(result.entries);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function stalenessLabel(expires: string): string {
  if (typeof expires !== "string" || expires.length === 0) return "?";
  const days = Math.round((Date.parse(expires) - Date.parse(today())) / (24 * 60 * 60 * 1000));
  if (Number.isNaN(days)) return "?";
  if (days < 0) return `expired ${-days}d ago`;
  if (days === 0) return "expires today";
  return `${days}d left`;
}

function failureSummary(failures: readonly RegistryFailureShape[]): string {
  if (failures.length === 0) return "";
  return failures.map((failure) => String(failure.code ?? "?")).join(", ");
}

function projectRegistryList(shape: RegistryListShape): Omit<ScreenProjection, "variant"> {
  const entries = (shape.entries ?? []).slice(0, MAX_ROWS);
  const rows = entries.map((entry) => {
    const ok = entry.ok === true;
    const failures = entry.failures ?? [];
    return {
      project_id: typeof entry.project_id === "string" ? entry.project_id : "?",
      path: typeof entry.path === "string" ? entry.path : "?",
      revision: typeof entry.verified_at_revision === "string" ? entry.verified_at_revision.slice(0, 12) : "?",
      discharge: ok ? "OK" : `FAIL${failureSummary(failures) ? ` (${failureSummary(failures)})` : ""}`,
      staleness: typeof entry.expires === "string" ? stalenessLabel(entry.expires) : "?",
    };
  });
  const failing = entries.filter((entry) => entry.ok !== true).length;
  const caption = entries.length === 0
    ? (shape.present === true
        ? "Project registry — 0 entries (governing no projects; a valid state, not a failure)"
        : "Project registry — no projects registered yet. `arbor project enroll .` registers the current checkout.")
    : `Project registry — ${entries.length} entr${entries.length === 1 ? "y" : "ies"}${failing > 0 ? `, ${failing} FAILING DISCHARGE` : ", all discharged"}`;
  return {
    screen: "project-registry",
    rows,
    columns: [
      { key: "project_id", title: "Project", width: 20 },
      { key: "path", title: "Path", width: 34 },
      { key: "revision", title: "Revision", width: 13 },
      { key: "discharge", title: "Discharge", width: 24 },
      { key: "staleness", title: "TTL", width: 16 },
    ],
    caption,
    row_ids: entries.map((entry): RowIdentity | null =>
      typeof entry.project_id === "string" ? { id: entry.project_id } : null),
  };
}

function renderRegistryTable(projection: ScreenProjection, width: number, height: number, offset?: number, selectedId?: string): readonly string[] {
  if (projection.rows.length === 0) return wrapDisplay(projection.caption ?? "Project registry", width).slice(0, Math.max(1, height));
  const rows = projection.rows.map((row) => ({
    ...row,
    project_id: `${selectedId !== undefined && row.project_id === selectedId ? "›" : " "} ${String(row.project_id ?? "")}`,
  }));
  try {
    const colCount = projection.columns.length;
    const colWidth = Math.max(1, Math.floor((width - (colCount - 1)) / colCount));
    const cols: TableColumn[] = projection.columns.map((c) => ({ key: c.key, title: c.title, width: Math.min(c.width, colWidth) }));
    const lines = renderTable(rows, cols, { height, offset });
    return [
      clipLabelWithEllipsis(projection.caption ?? "Project registry", width),
      clipDisplay("Enter: re-check selected entry   Ctrl+Shift+N: run reconcile pass over every entry", width),
      ...lines,
    ];
  } catch {
    return [clipDisplay("(render error)", width)];
  }
}

interface ManageGateShape {
  readonly gate_id?: string;
  readonly status?: string;
  readonly detail?: string;
}

interface ManageEntryShape {
  readonly project_id?: string;
  readonly path?: string;
  readonly discharge_ok?: boolean;
  readonly ok?: boolean;
  readonly gates?: readonly ManageGateShape[];
}

interface ManageReportShape {
  readonly ok?: boolean;
  readonly entry_count?: number;
  readonly retargetable_gate_ids?: readonly string[];
  readonly entries?: readonly ManageEntryShape[];
}

/** `project.manage`'s projection: recognized by `retargetable_gate_ids` (a field only that query's shape carries). */
function isManageReportShape(result: unknown): result is ManageReportShape {
  return isRecord(result) && Array.isArray(result.retargetable_gate_ids) && Array.isArray(result.entries);
}

function gateSummary(gates: readonly ManageGateShape[]): string {
  if (gates.length === 0) return "no gates";
  const pass = gates.filter((g) => g.status === "pass").length;
  const fail = gates.filter((g) => g.status === "fail").length;
  const na = gates.filter((g) => g.status === "not_applicable").length;
  const skip = gates.filter((g) => g.status === "not_run_discharge_failed").length;
  const parts = [pass ? `${pass} pass` : null, fail ? `${fail} FAIL` : null, na ? `${na} n/a` : null, skip ? `${skip} skipped` : null];
  return parts.filter((p): p is string => p !== null).join(", ") || "no gates";
}

function projectManage(shape: ManageReportShape): Omit<ScreenProjection, "variant"> {
  const entries = (shape.entries ?? []).slice(0, MAX_ROWS);
  const rows = entries.map((entry) => ({
    project_id: typeof entry.project_id === "string" ? entry.project_id : "?",
    path: typeof entry.path === "string" ? entry.path : "?",
    discharge: entry.discharge_ok === true ? "OK" : "FAILED",
    gates: entry.discharge_ok === true ? gateSummary(entry.gates ?? []) : "not run — discharge failed",
    outcome: entry.ok === true ? "PASS" : "FAIL",
  }));
  const caption = entries.length === 0
    ? "Reconcile pass — no projects registered yet"
    : `Reconcile pass — ${entries.length} project${entries.length === 1 ? "" : "s"}, ${shape.ok === true ? "all OK" : "FAILURES PRESENT"} (gates: ${(shape.retargetable_gate_ids ?? []).join(", ") || "none discovered"})`;
  return {
    screen: "project-registry",
    rows,
    columns: [
      { key: "project_id", title: "Project", width: 18 },
      { key: "path", title: "Path", width: 28 },
      { key: "discharge", title: "Discharge", width: 10 },
      { key: "gates", title: "Gates", width: 30 },
      { key: "outcome", title: "Outcome", width: 8 },
    ],
    caption,
    row_ids: entries.map((entry): RowIdentity | null =>
      typeof entry.project_id === "string" ? { id: entry.project_id } : null),
  };
}

function renderManageTable(projection: ScreenProjection, width: number, height: number, offset?: number): readonly string[] {
  if (projection.rows.length === 0) return [clipDisplay(projection.caption ?? "Reconcile pass", width)];
  try {
    const colCount = projection.columns.length;
    const colWidth = Math.max(1, Math.floor((width - (colCount - 1)) / colCount));
    const cols: TableColumn[] = projection.columns.map((c) => ({ key: c.key, title: c.title, width: Math.min(c.width, colWidth) }));
    return [clipDisplay(projection.caption ?? "Reconcile pass", width), ...renderTable(projection.rows, cols, { height, offset })];
  } catch {
    return [clipDisplay("(render error)", width)];
  }
}

function emptyProjection(): Omit<ScreenProjection, "variant"> {
  return {
    screen: "project-registry",
    rows: [],
    columns: [{ key: "project_id", title: "Project", width: 20 }],
    caption: "Loading project registry…",
  };
}

const PROJECT_REGISTRY_VARIANTS = [
  defineVariant({
    tag: "registry",
    match: isRegistryListShape,
    project: (shape) => projectRegistryList(shape),
    render: (projection, ctx) => renderRegistryTable(projection, ctx.width, ctx.height, ctx.scroll_offset, ctx.selected_id),
  }),
  defineVariant({
    tag: "manage",
    match: isManageReportShape,
    project: (shape) => projectManage(shape),
    render: (projection, ctx) => renderManageTable(projection, ctx.width, ctx.height, ctx.scroll_offset),
  }),
];

export const projectRegistryScreen: ScreenModule = {
  id: "project-registry" as ScreenId,
  title: "Project Registry",
  required_capabilities: ["project.registry.read", "project.manage.read"],

  surface: { commands: [], queries: ["project.registry.list", "project.manage"] },

  ...buildScreenPipeline(PROJECT_REGISTRY_VARIANTS, { emptyProjection }),
};
