/**
 * Semantic UCT graph model (M5).  This is deliberately independent of the
 * terminal renderer: lifecycle events update stable node/edge identities and
 * the renderer consumes a bounded layout projection below.
 */
export interface UctModelNode {
  readonly id: string;
  readonly parent_id: string | null;
  readonly state: string;
  readonly label?: string;
  readonly visit_count?: number;
}

export interface UctModelEdge { readonly from: string; readonly to: string }

export interface UctLifecycleEvent {
  readonly sequence: number;
  readonly kind: "snapshot" | "node_changed" | "node_pruned" | "rerooted" | "edge_changed" | "watermark";
  readonly node?: Partial<UctModelNode> & { readonly id: string };
  readonly nodes?: readonly UctModelNode[];
  readonly edges?: readonly UctModelEdge[];
  readonly node_id?: string;
  readonly parent_id?: string | null;
}

export interface UctGraphModel {
  readonly sequence: number;
  readonly status: "ok" | "gap";
  readonly nodes: ReadonlyMap<string, UctModelNode>;
  readonly edges: ReadonlyMap<string, UctModelEdge>;
}

export function emptyUctGraph(): UctGraphModel {
  return { sequence: 0, status: "ok", nodes: new Map(), edges: new Map() };
}

function edgeKey(edge: UctModelEdge): string { return `${edge.from}\u0000${edge.to}`; }

/** Fold ordered lifecycle events. Duplicate/delayed events are harmless. */
export function applyUctEvents(model: UctGraphModel, events: readonly UctLifecycleEvent[]): UctGraphModel {
  let next = model;
  for (const event of events) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence < next.sequence || (event.sequence === next.sequence && event.kind !== "snapshot")) continue;
    // A fresh snapshot is also the reconnect/resume boundary: its watermark
    // may jump past a missed delta and replaces the stale local projection.
    // Deltas remain strictly contiguous so a missing event is never hidden.
    if (event.kind !== "snapshot" && event.sequence !== next.sequence + 1) return { ...next, status: "gap" };
    const nodes = new Map(next.nodes);
    const edges = new Map(next.edges);
    if (event.kind === "snapshot") {
      nodes.clear(); edges.clear();
      for (const node of event.nodes ?? []) nodes.set(node.id, { ...node, parent_id: node.parent_id ?? null });
      const snapshotEdges = event.edges ?? [...nodes.values()].flatMap((node) =>
        node.parent_id && nodes.has(node.parent_id) ? [{ from: node.parent_id, to: node.id }] : [],
      );
      for (const edge of snapshotEdges) if (nodes.has(edge.from) && nodes.has(edge.to) && edge.from !== edge.to) edges.set(edgeKey(edge), edge);
    } else if (event.kind === "node_pruned") {
      const id = event.node_id ?? event.node?.id;
      if (id) nodes.delete(id);
      for (const [key, edge] of edges) if (edge.from === id || edge.to === id) edges.delete(key);
    } else if (event.kind === "rerooted") {
      if (event.node_id && nodes.has(event.node_id)) {
        const current = nodes.get(event.node_id)!;
        nodes.set(event.node_id, { ...current, parent_id: null });
        for (const [key, edge] of edges) if (edge.to === event.node_id) edges.delete(key);
      }
    } else if (event.node) {
      const prior = nodes.get(event.node.id);
      const node = { ...(prior ?? { id: event.node.id, parent_id: null, state: "unknown" }), ...event.node, parent_id: event.node.parent_id ?? prior?.parent_id ?? null };
      nodes.set(node.id, node);
      for (const [key, edge] of edges) if (edge.to === node.id || edge.from === node.id) edges.delete(key);
      if (node.parent_id && nodes.has(node.parent_id)) edges.set(edgeKey({ from: node.parent_id, to: node.id }), { from: node.parent_id, to: node.id });
    }
    if (event.kind === "edge_changed") for (const edge of event.edges ?? []) {
      if (nodes.has(edge.from) && nodes.has(edge.to)) edges.set(edgeKey(edge), edge);
    }
    next = { sequence: event.sequence, status: "ok", nodes, edges };
  }
  return next;
}

export interface UctReaderState { readonly selected_id: string | null; readonly follow_active: boolean; readonly modal: boolean; readonly filter: string }
export function initialUctReader(): UctReaderState { return { selected_id: null, follow_active: true, modal: false, filter: "" }; }
export type UctReaderAction = "next" | "prev" | "follow" | "fit" | "modal" | "snapshot" | { readonly filter: string } | { readonly select: string };

/** Keep reader identity and follow behavior attached to each authoritative tree snapshot. */
export function updateUctReader(state: UctReaderState, model: UctGraphModel, action: UctReaderAction): UctReaderState {
  if (action === "follow") return { ...state, follow_active: !state.follow_active };
  if (action === "modal") return { ...state, modal: !state.modal };
  if (typeof action === "object" && "select" in action) {
    return model.nodes.has(action.select) ? { ...state, selected_id: action.select, follow_active: false } : state;
  }
  const filter = typeof action === "object" ? action.filter : state.filter;
  const ids = [...model.nodes.values()]
    .filter((node) => filter === "" || `${node.id} ${node.label ?? ""} ${node.state}`.toLowerCase().includes(filter.toLowerCase()))
    .map((node) => node.id);
  if (action === "fit") return state;
  if (action === "snapshot" || typeof action === "object") {
    if (ids.length === 0) return { ...state, filter, selected_id: null };
    const retained = state.selected_id !== null && ids.includes(state.selected_id) ? state.selected_id : null;
    const active = state.follow_active && action === "snapshot"
      ? [...model.nodes.values()].filter((node) => ids.includes(node.id) && (node.state === "expanding" || node.state === "claimed" || node.state === "awaiting_review")).at(-1)?.id ?? null
      : null;
    return { ...state, filter, selected_id: active ?? retained ?? ids[0]! };
  }
  if (ids.length === 0) return state;
  const index = Math.max(0, ids.indexOf(state.selected_id ?? ids[0]!));
  return { ...state, selected_id: ids[(index + (action === "next" ? 1 : -1) + ids.length) % ids.length]!, follow_active: false };
}
