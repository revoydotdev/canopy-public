/** Durable compaction history and guard projection; lifecycle writes stay loop-owned. */
import { clipDisplay } from "../widgets.js";
import type { RowIdentity, ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";
import { emptyCaption, unrecognisedCaption } from "./empty-state.js";
import { renderStatusDocument } from "./status-document.js";

const MAX_ROWS = 200;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function table(projection: ScreenProjection, width: number, height: number, offset?: number): readonly string[] {
  return renderStatusDocument(projection, width, height, offset, { wide_min_columns: 96, empty_caption: "No compaction records" });
}

function isHistory(value: unknown): value is { records: readonly Record<string, unknown>[] } {
  return isRecord(value) && Array.isArray(value.records);
}

function projectHistory(value: { records: readonly Record<string, unknown>[] }): Omit<ScreenProjection, "variant"> {
  const records = value.records.slice(0, MAX_ROWS);
  return {
    // EC-012: name what creates a record rather than stating a bare absence.
    screen: "compaction", caption: records.length ? `Compaction history (${records.length})` : "No compaction records yet — a record appears when governed context is compacted",
    columns: [{ key: "node", title: "Node", width: 16 }, { key: "status", title: "Status", width: 12 }, { key: "strategy", title: "Strategy", width: 24 }, { key: "rollback", title: "Rollback", width: 36 }],
    rows: records.map((record) => {
      const lifecycle = isRecord(record.lifecycle) ? record.lifecycle : {};
      const status = typeof lifecycle.status === "string" ? lifecycle.status : "?";
      // A missing post pointer means no folded state to restore. The TUI does
      // not claim to perform rollback: it exposes the durable recovery facts.
      const rollback = status === "completed"
        ? (typeof lifecycle.pre_evidence_id === "string" ? `restore anchor ${lifecycle.pre_evidence_id}` : "pre-fold anchor unavailable")
        : (typeof lifecycle.reason === "string" ? lifecycle.reason : "interrupted before fold completed");
      return { node: typeof record.node_id === "string" ? record.node_id : "?", status, strategy: typeof lifecycle.strategy === "string" ? lifecycle.strategy : "?", rollback: clipDisplay(rollback, 140) };
    }),
    row_ids: records.map((record): RowIdentity | null => typeof record.id === "string" ? { id: record.id } : null),
  };
}

export const compactionScreen: ScreenModule = {
  id: "compaction" as ScreenId, title: "Compaction", required_capabilities: ["compaction.read"],
  surface: { commands: [], queries: ["compaction.list"] },
  ...buildScreenPipeline([
    defineVariant({ tag: "history", match: isHistory, project: projectHistory, render: (p, c) => table(p, c.width, c.height, c.scroll_offset) }),
  ], { emptyProjection: (reason) => ({
    screen: "compaction",
    rows: [],
    columns: [{ key: "node", title: "Node", width: 16 }],
    caption: reason === "empty"
      ? emptyCaption({ what: "No compaction records", how: "loop-owned; none has run for this campaign yet" })
      : unrecognisedCaption("Compaction"),
  }) }),
};
