/** Ledger-derived telemetry screen.  The snapshot arrives through the injected
 * TelemetrySourcePort, never through a TUI-owned counter or transport. */
import { clipDisplay } from "../widgets.js";
import { renderTelemetryView } from "../telemetry-widgets.js";
import type { TelemetrySnapshot } from "../telemetry-types.js";
import type { ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";

function isTelemetrySnapshot(value: unknown): value is TelemetrySnapshot {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<TelemetrySnapshot>;
  return typeof item.campaign_id === "string" && Number.isSafeInteger(item.source_record_count)
    && Array.isArray(item.counters) && Array.isArray(item.phase_histograms) && Array.isArray(item.usage_cost)
    && Array.isArray(item.context_economy) && Array.isArray(item.tool_economy);
}

function project(snapshot: TelemetrySnapshot): Omit<ScreenProjection, "variant"> {
  return {
    screen: "telemetry",
    caption: `Ledger telemetry · ${snapshot.campaign_id}`,
    columns: [{ key: "snapshot", title: "Telemetry", width: 1 }],
    rows: [{ snapshot }],
  };
}

function render(projection: ScreenProjection, width: number, height: number): readonly string[] {
  const snapshot = projection.rows[0]?.snapshot;
  return isTelemetrySnapshot(snapshot)
    ? renderTelemetryView(snapshot, { width, height })
    : [clipDisplay("Telemetry unavailable", width)];
}

export const telemetryScreen: ScreenModule = {
  id: "telemetry" as ScreenId,
  title: "Telemetry",
  // This virtual read capability is granted only by a composition root that
  // injects a real TelemetrySourcePort (the cockpit does); no catalog query is
  // claimed because telemetry is derived directly from the audited ledger.
  required_capabilities: ["telemetry.read"],
  surface: { commands: [], queries: [] },
  ...buildScreenPipeline([
    defineVariant({ tag: "telemetry", match: isTelemetrySnapshot, project, render: (p, c) => render(p, c.width, c.height) }),
  ], { emptyProjection: () => ({ screen: "telemetry", rows: [], columns: [{ key: "snapshot", title: "Telemetry", width: 1 }], caption: "Select an active campaign to load ledger telemetry" }) }),
};
