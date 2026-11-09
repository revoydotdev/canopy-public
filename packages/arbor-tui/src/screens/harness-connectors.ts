/** Read-only inventory of composed harness connectors and direct dispatch admission. */
import type { ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";
import { renderStatusDocument } from "./status-document.js";

const rec = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function inventory(value: unknown): value is { readonly connectors: readonly Record<string, unknown>[]; readonly selected_execution: Record<string, unknown>; readonly requirements: readonly Record<string, unknown>[] } {
  return rec(value) && Array.isArray(value.connectors) && rec(value.selected_execution) && Array.isArray(value.requirements);
}

function capabilitySummary(value: unknown): string {
  if (!Array.isArray(value)) return "—";
  return value.slice(0, 16).filter(rec).map((capability) => `${String(capability.capability ?? "?")}:${String(capability.grade ?? "?")}`).join(", ") || "—";
}

function requirementSummary(value: readonly Record<string, unknown>[]): string {
  return value.map((requirement) => `${String(requirement.capability ?? "?")}≥${String(requirement.minimum_grade ?? "?")}`).join(", ") || "none";
}

function project(value: { readonly connectors: readonly Record<string, unknown>[]; readonly selected_execution: Record<string, unknown>; readonly requirements: readonly Record<string, unknown>[] }): Omit<ScreenProjection, "variant"> {
  const execution = value.selected_execution;
  const selected = typeof execution.connector_id === "string" ? execution.connector_id : "?";
  const readiness = typeof execution.readiness === "string" ? execution.readiness : "?";
  const reason = execution.reason === null ? "direct dispatch admitted" : typeof execution.reason === "string" ? execution.reason : "unreported";
  const rows = value.connectors.slice(0, 100).map((connector) => ({
    connector: typeof connector.connector_id === "string" ? connector.connector_id : "?",
    health: typeof connector.health === "string" ? connector.health : "?",
    version: typeof connector.implementation_version === "string" ? connector.implementation_version : "?",
    upstream: typeof connector.supported_upstream_range === "string" ? connector.supported_upstream_range : "?",
    capabilities: capabilitySummary(connector.capabilities),
    diagnostic: typeof connector.diagnostic === "string" ? connector.diagnostic : "—",
  }));
  return {
    screen: "harness-connectors",
    caption: `Execution: ${String(execution.kind ?? "?")} via ${selected} (${readiness}) — ${reason}. Requirements: ${requirementSummary(value.requirements)}`,
    rows,
    columns: [
      { key: "connector", title: "Connector", width: 18 }, { key: "health", title: "Health", width: 12 },
      { key: "version", title: "Version", width: 12 }, { key: "upstream", title: "Upstream", width: 18 },
      { key: "capabilities", title: "Capabilities / grade", width: 52 }, { key: "diagnostic", title: "Diagnostic", width: 28 },
    ],
    row_ids: rows.map((row) => row.connector === "?" ? null : { id: row.connector }),
  };
}

function render(projection: ScreenProjection, width: number, height: number, offset?: number): readonly string[] {
  return renderStatusDocument(projection, width, height, offset, { wide_min_columns: 120, empty_caption: "No registered harness connectors" });
}

export const harnessConnectorsScreen: ScreenModule = {
  id: "harness-connectors" as ScreenId,
  title: "Harness Connectors",
  required_capabilities: ["harness.connector.read"],
  surface: { commands: [], queries: ["harness.connector.inventory"] },
  ...buildScreenPipeline([
    defineVariant({ tag: "inventory", match: inventory, project, render: (value, context) => render(value, context.width, context.height, context.scroll_offset) }),
  ], { emptyProjection: () => ({ screen: "harness-connectors", rows: [], columns: [{ key: "status", title: "Status", width: 32 }], caption: "Awaiting harness connector inventory" }) }),
};
