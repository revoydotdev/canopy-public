/** Real active sibling topology, reconciled from the durable communication ledger. */
import type { RowIdentity, ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";
import { emptyCaption, unrecognisedCaption } from "./empty-state.js";
import { renderStatusDocument } from "./status-document.js";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function isStatus(value: unknown): value is { node_id: string; active: readonly string[]; depth: number; within_bounds: boolean } {
  return isRecord(value) && typeof value.node_id === "string" && Array.isArray(value.active) && typeof value.depth === "number" && typeof value.within_bounds === "boolean";
}
function project(value: { node_id: string; active: readonly string[]; depth: number; within_bounds: boolean }): Omit<ScreenProjection, "variant"> {
  const active = value.active.slice(0, 200);
  return { screen: "siblings", caption: `Active sibling topology for ${value.node_id} — depth ${value.depth}, ${value.within_bounds ? "within bounds" : "outside bounds"}`,
    columns: [{ key: "sibling", title: "Active sibling", width: 32 }, { key: "status", title: "Status", width: 16 }],
    rows: active.map((sibling) => ({ sibling, status: "delegated" })), row_ids: active.map((id): RowIdentity => ({ id })) };
}
function render(projection: ScreenProjection, width: number, height: number, offset?: number): readonly string[] {
  return renderStatusDocument(projection, width, height, offset, { wide_min_columns: 72, empty_caption: `${projection.caption ?? "Sibling topology"}; no active siblings` });
}
export const siblingsScreen: ScreenModule = { id: "siblings" as ScreenId, title: "Siblings", required_capabilities: ["sibling.read"], surface: { commands: [], queries: ["sibling.status"] }, ...buildScreenPipeline([
  defineVariant({ tag: "status", match: isStatus, project, render: (p, c) => render(p, c.width, c.height, c.scroll_offset) }),
], { emptyProjection: (reason) => ({
  screen: "siblings",
  rows: [],
  columns: [{ key: "sibling", title: "Sibling", width: 24 }],
  caption: reason === "empty"
    ? emptyCaption({ what: "No sibling topology", how: "select a non-root Tree node (t) with delegated siblings" })
    : unrecognisedCaption("Siblings"),
}) }) };
