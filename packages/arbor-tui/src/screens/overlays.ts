/** Governed context overlays: active, bounded and rollback-addressable only. */
import { clipDisplay } from "../widgets.js";
import type { RowIdentity, ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";
import { renderStatusDocument } from "./status-document.js";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function shape(value: unknown): value is { campaign_id: string; active_folds: readonly Record<string, unknown>[]; active_playbook: readonly Record<string, unknown>[]; active_harness_revisions: readonly Record<string, unknown>[]; declarative_subagent_executions?: readonly Record<string, unknown>[]; rollbackable_ids: readonly string[] } {
  return record(value) && typeof value.campaign_id === "string" && Array.isArray(value.active_folds) && Array.isArray(value.active_playbook) && Array.isArray(value.active_harness_revisions) && Array.isArray(value.rollbackable_ids);
}
function project(value: { campaign_id: string; active_folds: readonly Record<string, unknown>[]; active_playbook: readonly Record<string, unknown>[]; active_harness_revisions: readonly Record<string, unknown>[]; declarative_subagent_executions?: readonly Record<string, unknown>[]; rollbackable_ids: readonly string[] }): Omit<ScreenProjection, "variant"> {
  const rollbackable = new Set(value.rollbackable_ids);
  const entries = [
    ...value.active_folds.map((item) => ({ item, type: "fold" })),
    ...value.active_playbook.map((item) => ({ item, type: "playbook" })),
    ...value.active_harness_revisions.map((item) => ({ item, type: "harness" })),
    ...(value.declarative_subagent_executions ?? []).map((item) => ({ item, type: "subagent-run" })),
  ].slice(0, 200);
  return {
    // EC-012: a bare count said nothing about what an overlay is or what
    // creates one; keep the count, add the subject when there are none.
    screen: "overlays", caption: entries.length === 0
      ? `${value.campaign_id} · no active governed overlays — a fold, playbook or harness revision creates one`
      : `${value.campaign_id} · ${entries.length} active governed overlay${entries.length === 1 ? "" : "s"}`,
    columns: [{ key: "type", title: "Type", width: 11 }, { key: "id", title: "Identity", width: 22, truncate: "middle" }, { key: "status", title: "State", width: 12 }, { key: "evaluation", title: "Evaluation", width: 12 }, { key: "evidence", title: "Evidence", width: 28 }, { key: "rollback", title: "Rollback", width: 12 }],
    rows: entries.map(({ item, type }) => {
      const id = typeof item.id === "string" ? item.id : "?";
      const events = Array.isArray(item.source_event_ids) ? item.source_event_ids.filter((v): v is string => typeof v === "string").join(",")
        : Array.isArray(item.evidence_ids) ? item.evidence_ids.filter((v): v is string => typeof v === "string").join(",") : "—";
      const state = typeof item.status === "string" ? item.status : typeof item.state === "string" ? item.state : "active";
      const evaluation = record(item.evaluation) ? item.evaluation : null;
      return { type, id, status: state, evaluation: typeof evaluation?.outcome === "string" ? evaluation.outcome : "—", evidence: clipDisplay(events || "—", 100), rollback: rollbackable.has(id) ? "available" : "—" };
    }),
    row_ids: entries.map(({ item, type }) => {
      if (typeof item.id !== "string") return null;
      const evaluation = record(item.evaluation) ? item.evaluation : null;
      return { id: item.id, context: { campaign_id: value.campaign_id, overlay_type: type, ...(typeof item.component === "string" ? { component: item.component } : {}), ...(typeof item.status === "string" ? { status: item.status } : {}), ...(typeof evaluation?.outcome === "string" ? { evaluation_outcome: evaluation.outcome } : {}) } } as RowIdentity;
    }),
  };
}
function render(projection: ScreenProjection, width: number, height: number, offset?: number): readonly string[] {
  return renderStatusDocument(projection, width, height, offset, { wide_min_columns: 112, empty_caption: `${projection.caption ?? "Governed context"}; no active overlays` });
}
export const overlaysScreen: ScreenModule = {
  id: "overlays" as ScreenId, title: "Governed Context", required_capabilities: ["context.read", "fold.write", "fold.approve", "fold.rollback", "playbook.write", "playbook.approve", "harness.write", "harness.approve", "harness.rollback", "harness.evaluate", "subagent.execute"],
  // This module has one projection shape: the bounded aggregate returned by
  // context.overlays.  The catalog's context.governance, subagent.executions,
  // and harness.evaluation.candidates responses are distinct contracts and
  // must not claim this screen slot (an incompatible response renders as the
  // empty projection and can erase a valid aggregate).
  surface: { commands: ["fold.propose", "fold.approve", "fold.rollback", "playbook.propose", "playbook.approve", "harness.propose", "harness.approve", "harness.rollback", "harness.evaluate", "subagent.execute", "harness.evaluation.start"], queries: ["context.overlays"] },
  ...buildScreenPipeline([defineVariant({ tag: "overlays", match: shape, project, render: (p, c) => render(p, c.width, c.height, c.scroll_offset) })], { emptyProjection: () => ({ screen: "overlays", rows: [], columns: [{ key: "type", title: "Type", width: 12 }], caption: "Select an active campaign to inspect governed overlays" }) }),
};
