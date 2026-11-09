/** Durable campaign-wide native allocation projection; never a telemetry estimate. */
import { wrapDisplay } from "../widgets.js";
import type { ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";
import { renderStatusDocument } from "./status-document.js";

export interface BudgetWarningProjection {
  readonly severity: "warning" | "error";
  readonly remaining_percent: number;
  readonly effective_ceiling_tokens: number;
  readonly remediation_reserve_tokens: number;
  readonly message: string;
}

/** Pure TUI-side projection of the authority's fixed 10% remedy reserve. */
export function nativeBudgetWarning(value: Record<string, unknown>): BudgetWarningProjection | null {
  const configured = record(value.configured) ? value.configured : null;
  const hard = typeof configured?.max_tokens === "number" ? configured.max_tokens : null;
  const consumed = typeof value.consumed_tokens === "number" ? value.consumed_tokens : null;
  const reserved = typeof value.reserved_tokens === "number" ? value.reserved_tokens : null;
  if (hard === null || consumed === null || reserved === null || hard <= 0) return null;
  const reserve = Math.max(1, Math.ceil(hard * 0.10));
  const effective = Math.max(1, hard - reserve);
  const percent = Math.max(0, Math.min(100, Math.floor((Math.max(0, effective - consumed - reserved) / effective) * 100)));
  if (percent > 40) return null;
  const severity = percent <= 20 ? "error" as const : "warning" as const;
  return { severity, remaining_percent: percent, effective_ceiling_tokens: effective, remediation_reserve_tokens: reserve,
    message: `${percent}% remaining · finish or interrupt the current native session, then compact or start a fresh context window (${reserve} tokens reserved to run the remedy)` };
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function isUnconfigured(value: unknown): value is { availability: "unconfigured"; campaign_id: string } {
  return record(value) && value.availability === "unconfigured" && typeof value.campaign_id === "string";
}

function isConfigured(value: unknown): value is Record<string, unknown> & { availability: "configured"; campaign_id: string; revision: number } {
  return record(value) && value.availability === "configured" && typeof value.campaign_id === "string" && typeof value.revision === "number";
}

function formatCost(value: unknown): string {
  if (!record(value)) return "unavailable";
  if (value.kind === "unpriced") return `unpriced: ${typeof value.reason === "string" ? value.reason : "reason unavailable"}`;
  if (value.kind !== "priced" || typeof value.minor_units !== "number" || typeof value.currency !== "string" || typeof value.minor_unit_exponent !== "number") return "unavailable";
  const amount = Math.abs(value.minor_units).toString().padStart(value.minor_unit_exponent + 1, "0");
  const scaled = value.minor_unit_exponent === 0 ? amount : `${amount.slice(0, -value.minor_unit_exponent)}.${amount.slice(-value.minor_unit_exponent)}`;
  return `${value.minor_units < 0 ? "-" : ""}${scaled} ${value.currency}`;
}

function projectConfigured(value: Record<string, unknown> & { availability: "configured"; campaign_id: string; revision: number }): Omit<ScreenProjection, "variant"> {
  const configured = record(value.configured) ? value.configured : {};
  const tokenCeiling = typeof configured.max_tokens === "number" ? String(configured.max_tokens) : "not configured";
  const reservationCount = Array.isArray(value.reservations) ? value.reservations.length : 0;
  const warning = nativeBudgetWarning(value);
  const rows = [
    { field: "Campaign", value: value.campaign_id },
    { field: "Budget revision", value: String(value.revision) },
    { field: "Token ceiling", value: tokenCeiling },
    ...(warning === null ? [] : [{ field: warning.severity === "error" ? "BUDGET ERROR" : "Budget warning", value: warning.message }]),
    ...(warning === null ? [] : [{ field: "Operator ceiling", value: `${warning.effective_ceiling_tokens} (${warning.remediation_reserve_tokens} remedy reserve)` }]),
    { field: "Tokens consumed", value: String(value.consumed_tokens ?? "unavailable") },
    { field: "Tokens reserved", value: String(value.reserved_tokens ?? "unavailable") },
    { field: "Tokens remaining", value: value.remaining_tokens === null ? "not configured" : String(value.remaining_tokens ?? "unavailable") },
    { field: "Cost ceiling", value: formatCost(configured.max_cost) },
    { field: "Cost consumed", value: formatCost(value.consumed_cost) },
    { field: "Cost reserved", value: formatCost(value.reserved_cost) },
    { field: "Cost remaining", value: formatCost(value.remaining_cost) },
    { field: "Reservations", value: String(reservationCount) },
  ];
  return {
    screen: "native-budget",
    caption: `Native campaign budget · ${value.campaign_id} · durable revision ${value.revision}`,
    rows,
    columns: [{ key: "field", title: "Field", width: 22 }, { key: "value", title: "Observed allocation", width: 72 }],
    row_ids: rows.map(() => null),
  };
}

function render(projection: ScreenProjection, width: number, height: number, offset?: number): readonly string[] {
  if (projection.rows.length === 0) {
    return [
      "NATIVE BUDGET",
      "",
      projection.caption ?? "Native campaign budget unavailable",
      "",
      "No allocation is shown. This is not evidence of unlimited capacity or zero usage.",
      "",
      "NEXT STEPS",
      "Ctrl+P > Campaigns: inspect the campaign you want to supervise.",
      "7: review configuration and its source before changing budget policy.",
      "Ctrl+P > Console: return to the conversation. Alt+B: reopen this view.",
    ].flatMap((line) => line === "" ? [""] : wrapDisplay(line, width)).slice(0, Math.max(0, height));
  }
  return renderStatusDocument(projection, width, height, offset, { wide_min_columns: 80, empty_caption: "Native campaign budget unavailable" });
}

export const nativeBudgetScreen: ScreenModule = {
  id: "native-budget" as ScreenId,
  title: "Native Budget",
  required_capabilities: ["campaign.read"],
  surface: { commands: [], queries: ["native.budget.get"] },
  ...buildScreenPipeline([
    defineVariant({ tag: "configured", match: isConfigured, project: projectConfigured, render: (p, c) => render(p, c.width, c.height, c.scroll_offset) }),
    defineVariant({ tag: "unconfigured", match: isUnconfigured, project: (value) => ({ screen: "native-budget", rows: [], columns: [{ key: "status", title: "Status", width: 24 }], caption: `Native campaign budget is not configured for ${value.campaign_id}` }), render: (p, c) => render(p, c.width, c.height) }),
  ], { shortCircuitEmptyRows: false, emptyProjection: (reason) => ({ screen: "native-budget", rows: [], columns: [{ key: "status", title: "Status", width: 24 }], caption: reason === "unrecognised" ? "Native budget response was not recognized. No allocation can be inferred." : "Select an active campaign to inspect its native budget" }) }),
};
