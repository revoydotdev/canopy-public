import type { AppLimits, AppModel } from "./types.js";
import type { ScreenId } from "./screens/screen.js";
import { deriveTheme, type RunTheme } from "./theme.js";
import { initialUctPlayback } from "./uct-playback.js";
import { initialUctReader } from "./uct-model.js";
import { emptyReadModel } from "./read-model.js";

export const DEFAULT_LIMITS: AppLimits = Object.freeze({
  notifications: 100,
  diagnostics: 200,
});

export function initialModel(limits: AppLimits = DEFAULT_LIMITS, theme: RunTheme = deriveTheme(undefined)): AppModel {
  validateLimit("notifications", limits.notifications);
  validateLimit("diagnostics", limits.diagnostics);
  return {
    connection: { status: "disconnected", reason: null },
    snapshot: null,
    notifications: [],
    diagnostics: [],
    limits: { ...limits },
    shuttingDown: false,
    shutdownComplete: false,
    telemetrySnapshot: null,
    telemetryCampaignId: null,
    // ADR-107's interactive coding session is the product's primary surface.
    // The legacy dashboard/cockpit projections remain palette-reachable for
    // deep operations, but boot must land where an operator can type, watch,
    // steer, and review one governed session without changing screens.
    screen: "console",
    grantedCapabilities: new Set<string>(),
    latestQueryValue: undefined,
    latestQueryId: null,
    screens: new Map<ScreenId, unknown>(),
    epoch: 0,
    devtoolsTransitions: new Map<string, { state: string; frames_remaining: number }>(),
    uctPlayback: initialUctPlayback(),
    uctReader: initialUctReader(),
    overlay: null,
    repeatConfirmation: null,
    selection: new Map(),
    scrollOffsets: new Map(),
    frontierLiveEdges: new Map(),
    theme,
    focus: { zone: "composer", rail_tab: "git" },
    // Re-seeded to the real stream id by the composition root's first
    // `read_model_updated` dispatch once the runtime event stream exists
    // (`tui.ts`); a model boots with no runtime bound to it yet.
    readModel: emptyReadModel("unbound"),
  };
}

function validateLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} limit must be a positive safe integer`);
  }
}
