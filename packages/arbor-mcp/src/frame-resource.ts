/**
 * `arbor://frame` — the canonical typed Frame (roadmap 4F.5) as JSON.
 *
 * Builds the exact same scene `TerminalPainter`/`SsePainter` would paint —
 * the campaigns screen composed through `renderScene` — from real
 * `CampaignManager` state (`listCampaigns()`, the same read the web
 * dashboard's `/api/campaigns` route uses). No invented/mocked data: an
 * empty manager renders an empty campaigns table, not a stub payload.
 */
import {
  createNavigation, getScreen, initialModel, installScreens, renderScene,
  type Frame, type RenderProjection, type ScreenId,
} from "@arbor/tui";
import type { CampaignManager } from "./manager.js";
import type { ResourceDefinition } from "./resources.js";

const FRAME_TERMINAL = Object.freeze({ columns: 120, rows: 40 });
const CAMPAIGNS_SCREEN_ID = "campaigns" as ScreenId;

/** Maps a real `listCampaigns()` row onto the campaigns screen's expected field names. */
/**
 * Pass-through, deliberately. This used to RENAME `listCampaigns`' fields into
 * `{name, status, node_count}` — the shape `screens/campaigns.ts` read. That
 * made this path (arbor://frame, and the webui SSE frame event) the only one
 * where the campaigns table worked: the TUI queries `campaign.list`, which
 * returns `listCampaigns` raw, so its guards fell through and every row
 * rendered "?" and "0". One consumer, two producers, and only one of them
 * adapted — with the unadapted one being the primary operator surface.
 *
 * The screen now reads the real field names, so translating here would
 * re-open the same gap in the opposite direction. Kept as a named function
 * rather than inlined so this reasoning has somewhere to live.
 */
function toCampaignRow(campaign: ReturnType<CampaignManager["listCampaigns"]>[number]): Record<string, unknown> {
  return { ...campaign };
}

/**
 * Builds the canonical campaigns-screen Frame from real `CampaignManager`
 * state. Shared by the `arbor://frame` MCP resource and the webui SSE
 * `frame` event — one scene-building path, painted by every backend.
 */
export function buildCampaignsFrame(manager: CampaignManager): Frame {
  // The fixed operational catalog is installed by the cockpit. The resource
  // can be used independently, so initialize that catalog once when needed;
  // it never mutates the registry by registering an arbitrary module.
  try { getScreen(CAMPAIGNS_SCREEN_ID); } catch { installScreens(); }
  const rows = manager.listCampaigns().map(toCampaignRow);
  const app = {
    ...initialModel(),
    grantedCapabilities: new Set(["campaign.read", "tree.read"]),
    screen: CAMPAIGNS_SCREEN_ID,
    screens: new Map<ScreenId, unknown>([[CAMPAIGNS_SCREEN_ID, rows]]),
  };
  const navigation = createNavigation(
    { id: "main", route: "campaigns", panes: [{ id: "main", title: "Campaigns" }], split: "horizontal", ratio: 0.5 },
    FRAME_TERMINAL,
  );
  const projection: RenderProjection = { app, navigation, output: "" };
  return renderScene(projection, {});
}

export function defineFrameResource(manager: CampaignManager): ResourceDefinition {
  return {
    uri_template: "arbor://frame",
    description: "Canonical rendered frame (typed scene, 4F.5) as JSON — the campaigns screen, 1:1 with the terminal/SSE painters",
    handler: () => buildCampaignsFrame(manager),
  };
}
