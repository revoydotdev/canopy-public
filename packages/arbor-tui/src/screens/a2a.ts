/** A2A source cards for the active campaign (`a2a.cards` — fail-closed without a configured signing secret). */
import { clipDisplay } from "../widgets.js";
import type { RowIdentity, ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";
import { emptyCaption, unrecognisedCaption } from "./empty-state.js";
import { renderStatusDocument } from "./status-document.js";

const MAX_ROWS = 200;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

interface CardsProjection {
  readonly campaign_id: string;
  readonly cards: readonly Record<string, unknown>[];
  readonly configured?: boolean;
  readonly message?: unknown;
}

function isCardsProjection(value: unknown): value is CardsProjection {
  return isRecord(value) && typeof value.campaign_id === "string" && Array.isArray(value.cards);
}

function project(value: CardsProjection): Omit<ScreenProjection, "variant"> {
  const cards = value.cards.slice(0, MAX_ROWS);
  const caption = value.configured === false
    ? typeof value.message === "string" && value.message.trim().length > 0
      ? value.message
      : "A2A publication is not configured — run `arbor setup` to provision a signing secret."
    : cards.length ? `A2A source cards (${cards.length})` : "no A2A source cards";
  return {
    screen: "a2a",
    caption,
    columns: [
      { key: "node_ref", title: "Node", width: 18 },
      { key: "role", title: "Role", width: 14 },
      { key: "tier", title: "Tier", width: 12 },
      { key: "skills", title: "Skills", width: 40 },
      { key: "signature", title: "Signature", width: 20 },
    ],
    rows: cards.map((card) => ({
      node_ref: typeof card.node_ref === "string" ? card.node_ref : "?",
      role: typeof card.role === "string" ? card.role : "?",
      tier: typeof card.tier === "string" ? card.tier : "?",
      skills: clipDisplay(Array.isArray(card.skills) ? card.skills.join(", ") : "?", 200),
      signature: clipDisplay(typeof card.signature === "string" ? card.signature : "?", 40),
    })),
    row_ids: cards.map((card): RowIdentity | null => (typeof card.node_ref === "string" ? { id: card.node_ref } : null)),
  };
}

function render(projection: ScreenProjection, width: number, height: number, offset?: number): readonly string[] {
  return renderStatusDocument(projection, width, height, offset, { wide_min_columns: 110, empty_caption: "A2A source cards unavailable" });
}

export const a2aScreen: ScreenModule = {
  id: "a2a" as ScreenId, title: "A2A Cards", required_capabilities: ["a2a.read", "a2a.write"],
  surface: { commands: ["a2a.send", "a2a.receive"], queries: ["a2a.cards"] },
  ...buildScreenPipeline([defineVariant({ tag: "cards", match: isCardsProjection, project, render: (p, c) => render(p, c.width, c.height, c.scroll_offset) })], {
    emptyProjection: (reason) => ({
      screen: "a2a",
      rows: [],
      columns: [{ key: "node_ref", title: "Node", width: 18 }],
      caption: reason === "empty"
        ? emptyCaption({ what: "No A2A source cards", how: "requires a configured signing secret — run `arbor setup`" })
        : unrecognisedCaption("A2A Cards"),
    }),
  }),
};
