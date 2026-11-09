/** Advisory surveillance findings; scanning remains a governed runtime lifecycle command. */
import { clipDisplay } from "../widgets.js";
import type { RowIdentity, ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";
import { emptyCaption, unrecognisedCaption } from "./empty-state.js";
import { renderStatusDocument } from "./status-document.js";

const MAX_ROWS = 200;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function isFindings(value: unknown): value is { findings: readonly Record<string, unknown>[] } { return isRecord(value) && Array.isArray(value.findings); }
function project(value: { findings: readonly Record<string, unknown>[] }): Omit<ScreenProjection, "variant"> {
  const findings = value.findings.slice(0, MAX_ROWS);
  return { screen: "surveillance", caption: findings.length ? `Surveillance findings (${findings.length})` : "no surveillance findings",
    columns: [{ key: "severity", title: "Severity", width: 10 }, { key: "kind", title: "Kind", width: 22 }, { key: "summary", title: "Finding", width: 64 }],
    rows: findings.map((finding) => ({ severity: typeof finding.severity === "string" ? finding.severity : "?", kind: typeof finding.kind === "string" ? finding.kind : "?", summary: clipDisplay(typeof finding.summary === "string" ? finding.summary : "?", 180) })),
    row_ids: findings.map((finding): RowIdentity | null => typeof finding.dedup_key === "string" ? { id: finding.dedup_key } : null) };
}
function render(projection: ScreenProjection, width: number, height: number, offset?: number): readonly string[] {
  return renderStatusDocument(projection, width, height, offset, { wide_min_columns: 88, empty_caption: "No surveillance findings" });
}
export const surveillanceScreen: ScreenModule = { id: "surveillance" as ScreenId, title: "Surveillance", required_capabilities: ["surveillance.read"], surface: { commands: [], queries: ["surveillance.findings"] }, ...buildScreenPipeline([
  defineVariant({ tag: "findings", match: isFindings, project, render: (p, c) => render(p, c.width, c.height, c.scroll_offset) }),
], { emptyProjection: (reason) => ({
  screen: "surveillance",
  rows: [],
  columns: [{ key: "kind", title: "Kind", width: 20 }],
  caption: reason === "empty"
    ? emptyCaption({ what: "No surveillance findings recorded", how: "runs via the surveillance.scan command" })
    : unrecognisedCaption("Surveillance"),
}) }) };
