/** Secret-free native harness setup/readiness doctor. */
import { clipDisplay, renderTable, wrapDisplay } from "../widgets.js";
import type { TableColumn } from "../widgets.js";
import type { ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";

const rec = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function readiness(value: unknown): value is { readonly execution: Record<string, unknown>; readonly adapter: Record<string, unknown>; readonly credential: Record<string, unknown>; readonly model_revision: Record<string, unknown>; readonly pricing: Record<string, unknown>; readonly budget: Record<string, unknown>; readonly missing_requirements: readonly Record<string, unknown>[] } {
  return rec(value) && rec(value.execution) && rec(value.adapter) && rec(value.credential) && rec(value.model_revision) && rec(value.pricing) && rec(value.budget) && Array.isArray(value.missing_requirements);
}

type ReadinessShape = Parameters<typeof readiness>[0] & {
  readonly execution: Record<string, unknown>; readonly adapter: Record<string, unknown>;
  readonly credential: Record<string, unknown>; readonly model_revision: Record<string, unknown>;
  readonly pricing: Record<string, unknown>; readonly budget: Record<string, unknown>;
  readonly missing_requirements: readonly Record<string, unknown>[];
};

function executionSummary(execution: Record<string, unknown>): string {
  const kind = String(execution.kind ?? "unreported");
  const basis = execution.selected_by ?? execution.reason;
  return basis === undefined ? kind : `${kind} / ${String(basis)}`;
}

function project(value: ReadinessShape): Omit<ScreenProjection, "variant"> {
  const missing = value.missing_requirements.slice(0, 20);
  const rows = [
    { concern: "Execution", status: executionSummary(value.execution), action: "" },
    { concern: "Adapter", status: `${String(value.adapter.adapter_id ?? "not selected")} (${String(value.adapter.availability ?? "?")})`, action: "" },
    { concern: "Credential", status: String(value.credential.present === true ? "present" : "absent"), action: value.credential.present === true ? "" : "Set ARBOR_NATIVE_API_KEY in this process environment." },
    { concern: "Model revision", status: String(value.model_revision.readiness ?? "?"), action: "" },
    { concern: "Pricing", status: String(value.pricing.readiness ?? "?"), action: "Optional static pricing supports cost enforcement." },
    { concern: "Budget", status: String(value.budget.readiness ?? "?"), action: "Optional ceilings support native session/campaign limits." },
    ...missing.map((item) => ({ concern: String(item.code ?? "missing requirement"), status: "action required", action: String(item.action ?? "unreported") })),
  ];
  return {
    screen: "harness-readiness",
    caption: missing.length === 0
      ? `Native readiness: no reported setup blockers · ${executionSummary(value.execution)}`
      : `Native readiness: ${missing.length}${value.missing_requirements.length > missing.length ? "+" : ""} setup blocker${missing.length === 1 ? "" : "s"} · ${executionSummary(value.execution)}`,
    rows,
    columns: [{ key: "concern", title: "Concern", width: 26 }, { key: "status", title: "Readiness", width: 28 }, { key: "action", title: "Action", width: 66 }],
    row_ids: rows.map(() => null),
  };
}

function render(projection: ScreenProjection, width: number, height: number, offset?: number): readonly string[] {
  try {
    const caption = clipDisplay(projection.caption ?? "Native readiness", width);
    if (width >= 80) {
      const columns = projection.columns.map((column): TableColumn => ({ ...column, width: Math.min(column.width, Math.max(4, Math.floor(width / projection.columns.length))) }));
      return [caption, ...renderTable(projection.rows, columns, { height: Math.max(1, height - 1), offset })];
    }
    const start = Math.min(offset ?? 0, projection.rows.length);
    const lines: string[] = [caption];
    for (const row of projection.rows.slice(start)) {
      if (lines.length >= height) break;
      lines.push(clipDisplay(`• ${String(row.concern ?? "status")}: ${String(row.status ?? "unreported")}`, width));
      const action = String(row.action ?? "").trim();
      for (const actionLine of action === "" ? [] : wrapDisplay(`  next: ${action}`, Math.max(1, width))) {
        if (lines.length >= height) break;
        lines.push(clipDisplay(actionLine, width));
      }
    }
    return lines;
  }
  catch { return [clipDisplay("(render error)", width)]; }
}

export const harnessReadinessScreen: ScreenModule = {
  id: "harness-readiness" as ScreenId,
  title: "Native Setup Doctor",
  required_capabilities: ["harness.connector.read"],
  surface: { commands: [], queries: ["harness.native.readiness"] },
  ...buildScreenPipeline([
    defineVariant({ tag: "readiness", match: readiness, project: (value) => project(value), render: (value, context) => render(value, context.width, context.height, context.scroll_offset) }),
  ], { emptyProjection: () => ({ screen: "harness-readiness", rows: [], columns: [{ key: "status", title: "Status", width: 32 }], caption: "Awaiting native setup doctor" }) }),
};
