/**
 * Deterministic transcript live-edge state.
 *
 * This is viewport-local presentation state, not a transcript store or a
 * lifecycle authority. The composition layer supplies only canonical events
 * that it has already deduplicated, and turns this state into a scroll offset
 * against its own rendered document. In particular, an arriving terminal
 * event is meaningful but cannot take an inspecting operator back to the
 * live edge.
 *
 * Source exposure: INDEPENDENT-DESIGN — revoy2 and the user-supplied Frontier
 * Operator Interface Program Brief only.
 */

export type FrontierLiveEdgeMode = "following" | "scrollback";

/**
 * `anchor_id` is an event identity, never a rendered row number. The caller
 * owns retention and can re-anchor deliberately if it removes that event.
 */
export interface FrontierLiveEdgeState {
  readonly mode: FrontierLiveEdgeMode;
  readonly anchor_id: string | null;
  readonly unseen_meaningful_events: number;
}

export interface FrontierLiveEdgeLimits {
  /** Maximum number displayed by the Return-to-live affordance. */
  readonly max_unseen_meaningful_events: number;
  /** Reject oversize anchors rather than truncating and changing identity. */
  readonly max_anchor_id_length: number;
}

export const DEFAULT_FRONTIER_LIVE_EDGE_LIMITS: Readonly<FrontierLiveEdgeLimits> = Object.freeze({
  max_unseen_meaningful_events: 9_999,
  max_anchor_id_length: 512,
});

export type FrontierLiveEdgeAction =
  /** The operator leaves the live edge to inspect an existing event. */
  | { readonly type: "inspect"; readonly anchor_id: string }
  /** A canonical event arrived after the composition layer's deduplication. */
  | { readonly type: "arrival"; readonly meaningful: boolean; readonly terminal: boolean }
  /** The operator explicitly chooses the Return-to-live affordance. */
  | { readonly type: "return_to_live" }
  /** Layout changed; the caller retains the dimensions, this reducer retains intent. */
  | { readonly type: "resize"; readonly columns: number; readonly rows: number };

const FOLLOWING: FrontierLiveEdgeState = Object.freeze({
  mode: "following",
  anchor_id: null,
  unseen_meaningful_events: 0,
});

/** Creates a fresh state at the live edge. */
export function createFrontierLiveEdgeState(): FrontierLiveEdgeState {
  return FOLLOWING;
}

/**
 * Reduces explicit operator navigation and canonical-event arrivals.
 *
 * No clock, viewport measurement, transcript length, or event order is read
 * here. This makes repeat application deterministic and prevents presentation
 * policy from creating a second session/event authority.
 */
export function reduceFrontierLiveEdge(
  state: FrontierLiveEdgeState,
  action: FrontierLiveEdgeAction,
  limits: Partial<FrontierLiveEdgeLimits> = {},
): FrontierLiveEdgeState {
  const resolvedLimits = resolveLimits(limits);
  const current = normalizeState(state, resolvedLimits);

  switch (action.type) {
    case "inspect": {
      if (!isAnchorId(action.anchor_id, resolvedLimits)) return current;
      if (current.mode === "scrollback" && current.anchor_id === action.anchor_id) return current;
      return freezeState({
        mode: "scrollback",
        anchor_id: action.anchor_id,
        unseen_meaningful_events: current.unseen_meaningful_events,
      });
    }
    case "arrival": {
      // A terminal event is always material, even if an upstream classifier
      // otherwise calls its final delta routine. It must still not force a
      // jump from scrollback to following.
      const meaningful = action.meaningful || action.terminal;
      if (current.mode === "following" || !meaningful) return current;
      const unseen = Math.min(
        resolvedLimits.max_unseen_meaningful_events,
        current.unseen_meaningful_events + 1,
      );
      if (unseen === current.unseen_meaningful_events) return current;
      return freezeState({ ...current, unseen_meaningful_events: unseen });
    }
    case "return_to_live":
      return current.mode === "following" ? current : FOLLOWING;
    case "resize":
      // Dimensions belong to the layout layer. Keeping no derived offset here
      // is what preserves the exact mode and event-ID anchor through resize.
      return current;
  }
}

function resolveLimits(input: Partial<FrontierLiveEdgeLimits>): FrontierLiveEdgeLimits {
  return {
    max_unseen_meaningful_events: positiveSafeInteger(
      input.max_unseen_meaningful_events,
      DEFAULT_FRONTIER_LIVE_EDGE_LIMITS.max_unseen_meaningful_events,
    ),
    max_anchor_id_length: positiveSafeInteger(
      input.max_anchor_id_length,
      DEFAULT_FRONTIER_LIVE_EDGE_LIMITS.max_anchor_id_length,
    ),
  };
}

function positiveSafeInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function isAnchorId(value: string, limits: FrontierLiveEdgeLimits): boolean {
  return value.trim().length > 0 && value.length <= limits.max_anchor_id_length;
}

function normalizeState(state: FrontierLiveEdgeState, limits: FrontierLiveEdgeLimits): FrontierLiveEdgeState {
  if (state.mode !== "scrollback" || state.anchor_id === null || !isAnchorId(state.anchor_id, limits)) return FOLLOWING;
  const unseen = Number.isSafeInteger(state.unseen_meaningful_events)
    ? Math.min(limits.max_unseen_meaningful_events, Math.max(0, state.unseen_meaningful_events))
    : 0;
  if (unseen === state.unseen_meaningful_events) return state;
  return freezeState({ ...state, unseen_meaningful_events: unseen });
}

function freezeState(state: FrontierLiveEdgeState): FrontierLiveEdgeState {
  return Object.freeze({ ...state });
}
