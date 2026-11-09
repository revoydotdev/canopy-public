/** Redacted governed-overlay evaluation runs.  This is an operator projection:
 * it reads only canonical run records.  The start command is separately
 * routed to the composed controlled evaluator, which may use a configured
 * provider but fixes every measured arm to fresh read-only/no-tools/no-human
 * execution and requires durable replay/holdout oracle evidence. */
import { clipDisplay, renderTable } from "../widgets.js";
import type { TableColumn } from "../widgets.js";
import type { ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => typeof value === "string" ? value : "—";
function isRuns(value: unknown): value is readonly Record<string, unknown>[] { return Array.isArray(value) && value.every(record); }
function isDetail(value: unknown): value is Record<string, unknown> { return record(value) && typeof value.id === "string" && typeof value.revision_id === "string" && typeof value.state === "string"; }

function runsProject(runs: readonly Record<string, unknown>[]): Omit<ScreenProjection, "variant"> {
  const rows = runs.slice(0, 200).map((run) => {
    const evaluation = record(run.evaluation) ? run.evaluation : null;
    return {
      id: text(run.id), revision: text(run.revision_id), state: text(run.state), evaluator: text(run.evaluator_id),
      outcome: evaluation === null ? "unmeasured" : text(evaluation.outcome),
      regression: evaluation?.regression_detected === true ? "yes" : evaluation === null ? "—" : "no",
      evidence: String(Array.isArray(run.evidence_ids) ? run.evidence_ids.length : 0),
      requested: text(run.requested_at),
    };
  });
  return {
    screen: "harness-evaluations",
    caption: `Controlled overlay evaluation runs (${rows.length}) · Enter opens bounded redacted detail`,
    rows,
    columns: [{ key: "revision", title: "Revision", width: 18 }, { key: "state", title: "State", width: 11 }, { key: "outcome", title: "Outcome", width: 11 }, { key: "regression", title: "Regression", width: 11 }, { key: "evaluator", title: "Evaluator", width: 18 }, { key: "evidence", title: "Evidence", width: 8 }, { key: "requested", title: "Requested", width: 24 }],
    row_ids: runs.slice(0, 200).map((run) => {
      if (typeof run.id !== "string" || typeof run.revision_id !== "string") return null;
      const evaluation = record(run.evaluation) ? run.evaluation : null;
      return { id: run.id, context: {
        revision_id: run.revision_id, state: text(run.state), outcome: evaluation === null ? "" : text(evaluation.outcome),
        regression_detected: evaluation?.regression_detected === true ? "true" : "false",
        evidence_ids_json: JSON.stringify(Array.isArray(run.evidence_ids) ? run.evidence_ids : []),
      } };
    }),
  };
}

function detailProject(run: Record<string, unknown>): Omit<ScreenProjection, "variant"> {
  const evaluation = record(run.evaluation) ? run.evaluation : null;
  const fields: Array<[string, unknown]> = [
    ["Run", run.id], ["Revision", run.revision_id], ["Campaign", run.campaign_id], ["State", run.state], ["Evaluator", run.evaluator_id],
    ["Requested", run.requested_at], ["Completed", run.completed_at], ["Outcome", evaluation?.outcome], ["Regression", evaluation?.regression_detected],
    ["Control tokens", evaluation?.main_model_tokens], ["Candidate tokens", evaluation?.child_model_tokens], ["Latency ms", evaluation?.latency_ms],
    ["Evidence ids", Array.isArray(run.evidence_ids) ? run.evidence_ids.join(", ") : "—"], ["Reason", run.reason],
  ];
  const rows = fields.filter(([, value]) => value !== undefined && value !== null).map(([field, value]) => ({ field, value: typeof value === "string" ? value : String(value) }));
  return { screen: "harness-evaluations", caption: `Controlled evaluation detail ${text(run.id)} · redacted canonical run record`, rows, columns: [{ key: "field", title: "Field", width: 20 }, { key: "value", title: "Value", width: 70 }], row_ids: rows.map(() => null) };
}

function render(projection: ScreenProjection, width: number, height: number, offset?: number): readonly string[] {
  if (!projection.rows.length) return [clipDisplay(projection.caption ?? "No controlled evaluation runs", width)];
  try { return [clipDisplay(projection.caption ?? "Controlled overlay evaluation", width), ...renderTable(projection.rows, projection.columns.map((column): TableColumn => ({ ...column, width: Math.min(column.width, Math.max(4, Math.floor(width / Math.max(1, projection.columns.length)))) })), { height, offset })]; }
  catch { return [clipDisplay("(render error)", width)]; }
}

export const harnessEvaluationsScreen: ScreenModule = {
  id: "harness-evaluations" as ScreenId,
  title: "Harness Evaluations",
  required_capabilities: ["harness.evaluate", "harness.promote", "harness.quarantine"],
  // Candidate selection and evaluation start are owned by Overlays, whose
  // canonical revision row supplies the required active/unmeasured context.
  // This screen owns measured run review and promotion/quarantine only.
  surface: { commands: ["harness.promote", "harness.quarantine"], queries: ["harness.evaluation.runs", "harness.evaluation.detail"] },
  ...buildScreenPipeline([
    defineVariant({ tag: "runs", match: isRuns, project: runsProject, render: (projection, context) => render(projection, context.width, context.height, context.scroll_offset) }),
    defineVariant({ tag: "detail", match: isDetail, project: detailProject, render: (projection, context) => render(projection, context.width, context.height, context.scroll_offset) }),
  ], { emptyProjection: () => ({ screen: "harness-evaluations", rows: [], columns: [{ key: "status", title: "Status", width: 20 }], caption: "Awaiting controlled evaluation run projection" }) }),
};
