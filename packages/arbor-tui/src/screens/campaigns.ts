/**
 * Campaigns screen (roadmap 4C, item 14).
 *
 * Renders the bounded `campaign.list` projection. The dedicated Tree screen
 * owns topology, node selection, and tree controls through `campaign.tree`.
 *
 * This is a leaf module. It depends only on @arbor/core (via widgets)
 * and the runtime-port/screen contracts — never @arbor/mcp.
 */

import { clipDisplay, renderTable } from "../widgets.js";
import type { TableColumn } from "../widgets.js";
import type { RowIdentity, ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";
import { clipLabelWithEllipsis } from "./region.js";

// ── cardinality bounds ───────────────────────────────────────────────────────

const MAX_TABLE_ROWS = 200;

/**
 * Two real callers feed this screen a genuinely different shape for the same
 * data, so BOTH must be matched (never just one guessed at):
 *  - `RuntimeCatalogRouter.executeQuery`'s "campaign.list" case
 *    (`runtime-catalog.ts`) returns a cursor page — `{items, next_cursor,
 *    total, limit}` — the shape the TUI's own `issue_query`/`campaign.list`
 *    round trip (`arbor-mcp/src/tui.ts`) receives.
 *  - `buildCampaignsFrame` (`arbor-mcp/src/frame-resource.ts`, shared by the
 *    `arbor://frame` MCP resource and the webui SSE `frame` event) calls
 *    `CampaignManager.listCampaigns()` directly and feeds this screen a raw
 *    array — never routed through the catalog at all.
 * A guard checking only one of these silently blanks the other caller's real
 * data; G-31 found `tasks.ts` matching neither of ITS real callers.
 */
function isCampaignPageShape(result: unknown): result is { readonly items: readonly Record<string, unknown>[] } {
  return (
    typeof result === "object" &&
    result !== null &&
    "items" in result &&
    // Like `tree`, preserve a real empty page so the operator can distinguish
    // an empty campaign list from an unavailable or malformed query result.
    Array.isArray((result as { items?: unknown }).items)
  );
}

function isCampaignListShape(result: unknown): result is readonly Record<string, unknown>[] {
  return Array.isArray(result) && (result.length === 0 || (typeof result[0] === "object" && result[0] !== null));
}

function rowCountCaption(caption: string, count: number): string {
  return count > 0 ? `${caption} (${count})` : `no ${caption.toLowerCase()}`;
}

// ── projection ───────────────────────────────────────────────────────────────

function projectCampaignList(
  rows: readonly Record<string, unknown>[],
  limit: number,
): Omit<ScreenProjection, "variant"> {
  // These read `campaign.list`'s REAL field names. They previously read
  // `name`/`status`/`node_count`/`verified_count`, none of which the runtime
  // has ever returned (`listCampaigns` yields plan_path/halted/halt_reason/
  // root_node_state/total_nodes/verified_nodes), so every guard fell through
  // and the whole table rendered "?" and "0" on every run — a degraded seam
  // that typechecked because the guards made the absence look deliberate.
  const sliced = rows.slice(0, limit);
  const bounded = sliced.map((item) => ({
    id: typeof item.id === "string" ? item.id : "?",
    // The plan is what names a campaign to an operator; the full path is noise.
    name: typeof item.plan_path === "string" ? (item.plan_path.split("/").pop() ?? item.plan_path) : "?",
    // Halt reason beats a bare "halted" — an operator scanning the list needs
    // to know WHY it stopped, and the root node's state is the live signal
    // while it is still running.
    status: item.halted === true
      ? (typeof item.halt_reason === "string" && item.halt_reason.length > 0 ? item.halt_reason : "halted")
      : (typeof item.root_node_state === "string" ? item.root_node_state : "?"),
    nodes: typeof item.total_nodes === "number" ? String(item.total_nodes) : "0",
    verified: typeof item.verified_nodes === "number" ? String(item.verified_nodes) : "0",
  }));

  return {
    screen: "campaigns",
    rows: bounded,
    columns: [
      { key: "id", title: "Campaign", width: 12, truncate: "middle" },
      { key: "name", title: "Name", width: 20 },
      { key: "status", title: "Status", width: 10 },
      { key: "nodes", title: "Nodes", width: 7 },
      { key: "verified", title: "Verified", width: 8 },
    ],
    caption: rowCountCaption("Campaigns", bounded.length),
    row_ids: sliced.map((item): RowIdentity | null => (typeof item.id === "string" ? { id: item.id } : null)),
  };
}

// ── render ───────────────────────────────────────────────────────────────────

function renderCampaignTable(
  projection: ScreenProjection,
  width: number,
  height: number,
  offset?: number,
  selectedId?: string,
): readonly string[] {
  // Selection marker: keyboard (j/k, arrows) and click selection update
  // AppModel.selection, but this table never showed it — the selection was
  // invisible on the Campaigns screen (audit 2026-08-23 lane T2.3b). Same
  // `›` convention jobs.ts uses.
  const rows = projection.rows.map((row) => ({ ...row, id: `${selectedId !== undefined && row.id === selectedId ? "›" : " "} ${String(row.id ?? "")}` }));
  if (rows.length === 0) {
    return [clipDisplay(projection.caption ?? "No campaigns", width)];
  }

  const colCount = projection.columns.length;
  const available = Math.max(1, width - (colCount - 1));
  const colWidth = Math.max(1, Math.floor(available / Math.max(1, colCount)));
  // Keep numeric columns compact; spend the remaining pane width on identity,
  // plan, and state. Row geometry stays one line per record for hit testing.
  const extra = Math.max(0, available - 61);
  const identityExtra = Math.floor(extra * 0.4);
  const nameExtra = Math.floor(extra * 0.25);
  const expandedWidths: Readonly<Record<string, number>> = {
    id: 14 + identityExtra,
    name: 16 + nameExtra,
    status: 16 + extra - identityExtra - nameExtra,
    nodes: 7,
    verified: 8,
  };

  const cols: TableColumn[] = projection.columns.map((c) => ({
    ...c,
    width: available >= 61 ? (expandedWidths[c.key] ?? colWidth) : colWidth,
  }));

  try {
    const lines = renderTable(rows, cols, { height: Math.max(1, height - 1), offset, line_width: width });
    const heading = `${projection.caption ?? "Campaigns"} · ↑/↓ select · Ctrl+P commands`;
    return [clipLabelWithEllipsis(heading, width), ...lines].slice(0, Math.max(1, height));
  } catch {
    return [clipDisplay("(render error)", width)];
  }
}

// ── empty / fallback ─────────────────────────────────────────────────────────

function emptyProjection(): Omit<ScreenProjection, "variant"> {
  return {
    screen: "campaigns",
    rows: [],
    columns: [{ key: "id", title: "ID", width: 10, truncate: "middle" }],
    caption: "Campaign data unavailable — campaigns appear after approved plan submission",
  };
}

// ── variants (roadmap 4F.8) ──────────────────────────────────────────────────

const CAMPAIGNS_VARIANTS = [
  defineVariant({
    tag: "paged-list",
    match: isCampaignPageShape,
    project: (shape) => projectCampaignList(shape.items, MAX_TABLE_ROWS),
    render: (projection, ctx) => renderCampaignTable(projection, ctx.width, ctx.height, ctx.scroll_offset, ctx.selected_id),
  }),
  defineVariant({
    tag: "list",
    match: isCampaignListShape,
    project: (shape) => projectCampaignList(shape, MAX_TABLE_ROWS),
    render: (projection, ctx) => renderCampaignTable(projection, ctx.width, ctx.height, ctx.scroll_offset, ctx.selected_id),
  }),
];

// ── exported module ──────────────────────────────────────────────────────────

export const campaignsScreen: ScreenModule = {
  id: "campaigns" as ScreenId,
  title: "Campaigns",
  required_capabilities: ["campaign.read"],

  surface: {
    commands: ["campaign.halt"],
    // `campaign.snapshot` (a real, supported catalog query) was declared here
    // with no real caller: `tui.ts`'s `refreshScreenData` never issues it for
    // this screen, and its actual return shape (the raw `CampaignManager`
    // snapshot, `{id, nodes, ...}`, no `campaign_id` field) would only ever
    // accidentally match this screen's `isTreeShape` variant — landing as a
    // redundant, mis-captioned duplicate of `tree.ts`'s purpose-built view,
    // never a real "campaign detail" render. Removed rather than left as a
    // declaration nothing exercises. Reintroducing it needs a dedicated
    // detail variant (mirroring `governance.ts`'s key/value dashboard
    // pattern) plus a `tui.ts` dispatch, not just the query kind back here.
    queries: ["campaign.list"],
  },

  ...buildScreenPipeline(CAMPAIGNS_VARIANTS, { emptyProjection }),
};
