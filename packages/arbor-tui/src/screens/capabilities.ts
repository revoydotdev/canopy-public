/** Catalog-derived action-class and minimum-tier report, never an authority assertion. */
import type { RowIdentity, ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";
import { emptyCaption, unrecognisedCaption } from "./empty-state.js";
import { renderStatusDocument } from "./status-document.js";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function isCatalog(value: unknown): value is { catalog: readonly Record<string, unknown>[] } { return isRecord(value) && Array.isArray(value.catalog); }
function project(value: { catalog: readonly Record<string, unknown>[] }): Omit<ScreenProjection, "variant"> {
  const catalog = value.catalog.slice(0, 200);
  return { screen: "capabilities", caption: `Capability action classes (${catalog.length})`, columns: [{ key: "kind", title: "Kind", width: 28 }, { key: "class", title: "Class", width: 18 }, { key: "tier", title: "Minimum tier", width: 16 }, { key: "state", title: "State", width: 12 }],
    rows: catalog.map((entry) => ({ kind: typeof entry.kind === "string" ? entry.kind : "?", class: typeof entry.action_class === "string" ? entry.action_class : "?", tier: typeof entry.minimum_tier === "string" ? entry.minimum_tier : "never", state: entry.supported === true ? "supported" : "unavailable" })),
    row_ids: catalog.map((entry): RowIdentity | null => typeof entry.kind === "string" ? { id: entry.kind } : null) };
}
function render(projection: ScreenProjection, width: number, height: number, offset?: number): readonly string[] {
  return renderStatusDocument(projection, width, height, offset, { wide_min_columns: 100, empty_caption: "Capability catalog not loaded" });
}
export const capabilitiesScreen: ScreenModule = { id: "capabilities" as ScreenId, title: "Capabilities", required_capabilities: ["capability.read"], surface: { commands: [], queries: ["capability.introspect"] }, ...buildScreenPipeline([
  defineVariant({ tag: "catalog", match: isCatalog, project, render: (p, c) => render(p, c.width, c.height, c.scroll_offset) }),
], { emptyProjection: (reason) => ({
  screen: "capabilities",
  rows: [],
  columns: [{ key: "kind", title: "Kind", width: 24 }],
  caption: reason === "empty"
    ? emptyCaption({ what: "Capability catalog not loaded", how: "reopen Capabilities (=) to refresh" })
    : unrecognisedCaption("Capabilities"),
}) }) };
