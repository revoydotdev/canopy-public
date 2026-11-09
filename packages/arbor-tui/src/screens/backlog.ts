/**
 * Backlog screen (finding 15, TUI-vs-backend observability gap audit).
 *
 * Renders the real governance work backlog `@arbor/mcp`'s
 * `governance-projection.ts` derives via `@arbor/governance`'s
 * `deriveBacklog`/`selectNextBacklogItem` — the same ranked, POL-04-derived
 * queue `selfhost.ts` already uses to pick a self-host campaign's next task
 * (`formatBacklogSelection`, previously printed to CLI stdout only, never
 * visible in the cockpit).
 *
 * This is a LEAF module: it never imports `@arbor/governance` or
 * `@arbor/mcp` (ADR-011). `GovernanceBacklogSnapshotShape` below is a
 * structural mirror of `governance-projection.ts`'s real, tested
 * `GovernanceBacklogSnapshot`/`Backlog`/`BacklogItem` types — field names
 * copied from those, not guessed. Every nested field is re-validated with
 * `typeof`/`Array.isArray` at read time, the same discipline every other
 * screen in this package applies to its real-caller shapes.
 */
import { clipDisplay } from "../widgets.js";

import type { RowIdentity, ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";
import { emptyCaption, unrecognisedCaption } from "./empty-state.js";
import { renderStatusDocument } from "./status-document.js";

const MAX_ROWS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface BacklogItemShape {
  readonly record_id?: string;
  readonly title?: string;
  readonly decision_status?: string;
  readonly classification?: string;
  readonly rank_tier?: number;
  readonly evidence?: { readonly finding_detail?: string };
}

interface GovernanceBacklogSnapshotShape {
  readonly backlog?: {
    readonly total_records_scanned?: number;
    readonly items?: readonly BacklogItemShape[];
  };
  readonly selected?: BacklogItemShape | null;
}

/** Recognized by the presence of a `backlog.items` array — a real (possibly empty) derivation. */
function isGovernanceBacklogSnapshotShape(result: unknown): result is GovernanceBacklogSnapshotShape {
  return isRecord(result) && isRecord(result.backlog) && Array.isArray(result.backlog.items);
}

function isGovernanceAbsenceShape(result: unknown): result is { governance_absence: true; message?: unknown } {
  return isRecord(result) && result.governance_absence === true;
}

function rowCountCaption(count: number, selectedId: string | null): string {
  const base = count > 0 ? `Backlog (${count})` : "Backlog: empty";
  return selectedId ? `${base} — next: ${selectedId}` : base;
}

function projectBacklog(shape: GovernanceBacklogSnapshotShape, limit: number): Omit<ScreenProjection, "variant"> {
  const items = shape.backlog?.items ?? [];
  const selectedId = typeof shape.selected?.record_id === "string" ? shape.selected.record_id : null;
  const sliced = items.slice(0, limit);
  const bounded = sliced.map((item) => ({
    record_id: typeof item.record_id === "string" ? item.record_id : "?",
    title: typeof item.title === "string" ? item.title : "?",
    decision_status: typeof item.decision_status === "string" ? item.decision_status : "?",
    classification: typeof item.classification === "string" ? item.classification : "?",
    rank_tier: typeof item.rank_tier === "number" ? String(item.rank_tier) : "?",
    next: item.record_id === selectedId ? "-> next" : "",
  }));
  return {
    screen: "backlog",
    rows: bounded,
    columns: [
      { key: "record_id", title: "Record", width: 14 },
      { key: "title", title: "Title", width: 32 },
      { key: "decision_status", title: "Status", width: 10 },
      { key: "classification", title: "Class", width: 18 },
      { key: "rank_tier", title: "Tier", width: 4 },
      { key: "next", title: "", width: 8 },
    ],
    caption: rowCountCaption(bounded.length, selectedId),
    row_ids: sliced.map((item): RowIdentity | null => (typeof item.record_id === "string" ? { id: item.record_id } : null)),
  };
}

function renderBacklogTable(projection: ScreenProjection, width: number, height: number, offset?: number): readonly string[] {
  return renderStatusDocument(projection, width, height, offset, { wide_min_columns: 100, empty_caption: "No governance backlog items" });
}

function emptyProjection(reason: "empty" | "unrecognised"): Omit<ScreenProjection, "variant"> {
  return {
    screen: "backlog",
    rows: [],
    columns: [{ key: "record_id", title: "Record", width: 14 }],
    caption: reason === "empty"
      ? emptyCaption({ what: "Governance backlog not loaded", how: "inspect it with `arbor governance`" })
      : unrecognisedCaption("Backlog"),
  };
}

const BACKLOG_VARIANTS = [
  defineVariant({
    tag: "greenfield-absence",
    match: isGovernanceAbsenceShape,
    project: (shape) => ({
      screen: "backlog" as ScreenId,
      rows: [],
      columns: [{ key: "record_id", title: "Record", width: 14 }],
      // EC-012: lead with THIS screen's subject. Preferring the governance
      // subsystem's message verbatim made the Backlog screen describe the ADR
      // decision store instead of the backlog; its own fallback was better
      // than the message it preferred. Append the upstream reason, never
      // replace the subject with it.
      caption: typeof shape.message === "string"
        ? `No governance backlog yet. ${shape.message}`
        : "No governance backlog yet — no canonical ADRs have been recorded.",
    }),
    render: (projection, ctx) => [clipDisplay(projection.caption ?? "No governance backlog — no canonical ADRs yet.", ctx.width)],
  }),
  defineVariant({
    tag: "backlog",
    match: isGovernanceBacklogSnapshotShape,
    project: (shape) => projectBacklog(shape, MAX_ROWS),
    render: (projection, ctx) => renderBacklogTable(projection, ctx.width, ctx.height, ctx.scroll_offset),
  }),
];

export const backlogScreen: ScreenModule = {
  id: "backlog" as ScreenId,
  title: "Backlog",
  required_capabilities: ["governance.backlog.read"],

  surface: { commands: [], queries: ["governance.backlog"] },

  ...buildScreenPipeline(BACKLOG_VARIANTS, { emptyProjection }),
};
