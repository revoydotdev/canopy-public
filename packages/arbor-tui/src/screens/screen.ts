/**
 * Operational TUI screen registry (roadmap 4C, items 14–24; ADR-011).
 *
 * A screen is a leaf module that projects ONE canonical runtime capability
 * into a bounded, deterministic, testable view. Screens never touch the
 * manager/catalog directly — they dispatch bounded commands/queries through
 * the injected `RuntimePort` (see runtime-port.ts).
 *
 * Wire / no-wire policy (ADR-011 + handoff §14): a visible control is only
 * registered when the canonical backend capability exists AND has a tested
 * round trip. Screens whose capabilities are absent (e.g. a scheduler that is
 * not yet a canonical runtime capability) are simply NOT registered — never
 * stubbed. `required_capabilities` lets the composition layer hide a screen
 * whose capability set is not granted.
 */

import type { TableColumn } from "../widgets.js";
import { compareCodeUnits } from "@arbor/core";
import type { RuntimeCommandKind, RuntimeQueryKind } from "../runtime-port.js";
import type { NodeTransition } from "../player-piano.js";
import type { FrontierLiveEdgeState } from "../frontier-live-edge.js";
import type { ColorMode, RunTheme } from "../theme.js";
import type { TuiReadModel } from "../read-model.js";
import type { UctReaderState } from "../uct-model.js";

export type ScreenId =
  | "project-registry"
  | "campaigns"
  | "tree"
  | "tasks"
  | "operations"
  | "recovery"
  | "output"
  | "result-review"
  | "communications"
  | "telemetry"
  | "diagnostics"
  | "config"
  | "native-budget"
  | "agents"
  | "jobs"
  | "approvals"
  | "interviews"
  | "devtools"
  | "command-history"
  | "governance"
  | "backlog"
  | "kb"
  | "audit"
  | "compaction"
  | "siblings"
  | "surveillance"
  | "capabilities"
  | "threads"
  | "bus"
  | "a2a"
  | "overlays"
  | "trust"
  | "harness-connectors"
  | "harness-readiness"
  | "harness-sessions"
  | "harness-evaluations"
  | "task-composer"
  | "live-session"
  | "control"
  | "console";

/** Commands/queries a screen may issue through the runtime port. */
export interface ScreenSurface {
  readonly commands: readonly RuntimeCommandKind[];
  readonly queries: readonly RuntimeQueryKind[];
}

/**
 * One row's stable backend identity: the id of the durable record a
 * `ScreenProjection` row was projected from, plus whatever compound key a
 * row-targeted command needs beyond the bare id (e.g. the tree screen's
 * `tree.branch`/`tree.prune` need `campaign_id` alongside the node id).
 * Deliberately the same shape as `operator-selection.ts`'s `ScreenSelection`
 * (`{id, context?}`) so a consumer can construct one directly from the
 * other — a click or a keyboard cursor move resolves to a `RowIdentity`,
 * which IS a `ScreenSelection`, with no reshaping in between.
 */
export interface RowIdentity {
  readonly id: string;
  readonly context?: Readonly<Record<string, string>>;
}

/** A bounded renderable projection. Rendering must be Unicode-width aware. */
export interface ScreenProjection {
  readonly screen: ScreenId;
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly columns: readonly TableColumn[];
  readonly caption?: string;
  /** Compact retained-reader controls/status when a projection has them. */
  readonly reader_status?: string;
  /**
   * Which registry variant (packages/arbor-tui/src/screens/registry.ts)
   * produced this projection (roadmap 4F.8). render() dispatches on this
   * field via a table lookup instead of re-inspecting rows/columns shape.
   * "empty" marks the no-data / no-matching-variant fallback.
   */
  readonly variant: string;
  /**
   * Per-row record identity, aligned 1:1 with `rows` by index — `row_ids[i]`
   * is the identity of `rows[i]`, so `row_ids`, when present, always has the
   * same length as `rows`. This is the contract that closes two verified
   * gaps: a mouse click resolves to a pane + row index
   * (`hitTestFrame`/`PaneHit.row_in_pane`) but nothing previously mapped
   * that index back to a record, and row-targeted operator commands
   * (`job.cancel`, `operation.cancel`, `task.retry`, `approval.approve`,
   * `userinput.answer`, ...) need a target id that only the tree screen
   * (via a bespoke `operator-selection.ts` extractor) previously supplied.
   *
   * `row_ids[i]` is `null` when row i genuinely has no stable identity of
   * its own — e.g. a governance dashboard's aggregated key/value line, which
   * was never a single backend record to begin with. `null` is a typed,
   * intentional absence: it must never be synthesized from the row's array
   * index (an index shifts under sort/filter/scroll and would silently
   * rebind a command to the wrong record after the next refresh — precisely
   * the false positive `selectTreeRow`'s own doc comment refuses to
   * manufacture for an out-of-range click).
   *
   * The field itself may be omitted from the whole projection when NO row
   * it carries has a meaningful per-row identity — e.g. `governance.ts`'s
   * dashboard, whose rows are aggregated facets (a decision-status count, an
   * obligation-coverage summary) joined from five different sources, never
   * one-to-one with a single backend record — a screen is not required to
   * fabricate an all-null array just to satisfy the shape.
   */
  readonly row_ids?: readonly (RowIdentity | null)[];
}

export interface ScreenProjectContext {
  readonly width: number;
  readonly height: number;
  readonly consumerTier?: string;
  /** Current canonical runtime grants, used to describe available controls. */
  readonly granted_capabilities?: ReadonlySet<string>;
  /** Current canonical runtime read model, supplied by the live renderer. */
  readonly read_model?: TuiReadModel;
  /** Retained Tree reader controls, supplied by the live AppModel. */
  readonly uct_reader?: UctReaderState;
}

export interface ScreenModule {
  readonly id: ScreenId;
  readonly title: string;
  /** Capabilities the canonical runtime must grant for this screen to be offered. */
  readonly required_capabilities: readonly string[];
  readonly surface: ScreenSurface;
  /**
   * Deterministic render over a bounded projection. `frame_count` is the
   * injected frame clock (timerCadence) for player-piano animation; `color`
   * enables ANSI styling; `transitions` is the model-folded state-change flash
   * map. All optional — a screen that ignores them stays backward compatible.
   */
  readonly render: (input: {
    projection: ScreenProjection;
    width: number;
    height: number;
    frame_count?: number;
    color?: boolean;
    /** Whether the terminal can render Unicode semantic and box glyphs. */
    unicode?: boolean;
    theme?: RunTheme;
    color_mode?: ColorMode;
    transitions?: ReadonlyMap<string, NodeTransition>;
    /** Row id the operator has selected (e.g. the tree screen's node cursor). Optional — a screen that ignores it stays backward compatible. */
    selected_id?: string;
    /**
     * The operator's current scroll position for this screen (wave2/
     * tui-input-model), threaded from `AppModel.scrollOffsets`. A row index,
     * not a pixel/cell offset. Optional — a screen that ignores it stays
     * backward compatible (and simply always renders from row 0, today's
     * behavior). The composition root supplies this; `renderer.ts`'s
     * `resolveActiveScreen` is the one production call site responsible for
     * reading `app.scrollOffsets.get(app.screen)` and passing it through —
     * without that one line, this parameter is real but inert.
     */
    scroll_offset?: number;
    /** Transcript live-edge intent and bounded unseen count, when applicable. */
    live_edge?: FrontierLiveEdgeState;
  }) => readonly string[];
  /**
   * Build a projection from a bounded query result (unknown shape → typed
   * rows). `consumerTier` is the projecting consumer's capability tier, used
   * by screens that apply structural tier redaction (e.g. communications);
   * a screen that ignores it stays backward compatible.
   */
  readonly project: (
    result: unknown,
    input: ScreenProjectContext,
  ) => ScreenProjection;
}

/** Registry is a closed catalog: unknown screens are rejected, never silently empty. */
const registry = new Map<ScreenId, ScreenModule>();

export function registerScreen(module: ScreenModule): void {
  if (!module.id.trim()) throw new Error("screen id must be non-empty");
  if (module.required_capabilities.length === 0) throw new Error(`screen ${module.id} must declare required capabilities`);
  if (registry.has(module.id)) throw new Error(`screen ${module.id} is already registered`);
  if (!module.title.trim()) throw new Error(`screen ${module.id} requires a title`);
  registry.set(module.id, module);
}

/**
 * Installs one screen only for the duration of a synchronous projection and
 * restores the exact prior registry state afterward. Deterministic artifact
 * capture uses this instead of leaking process-global registration into a
 * later TUI launch or test file.
 */
export function withTemporaryScreenRegistration<T>(module: ScreenModule, run: () => T): T {
  const previous = registry.get(module.id);
  if (previous === undefined) registerScreen(module);
  try {
    return run();
  } finally {
    if (previous === undefined) registry.delete(module.id);
  }
}

/** Screens visible given a transport's granted capability set. */
export function availableScreens(grantedCapabilities: ReadonlySet<string>): ScreenModule[] {
  return [...registry.values()]
    .filter((module) => module.required_capabilities.every((capability) => grantedCapabilities.has(capability)))
    .sort((left, right) => compareCodeUnits(left.id, right.id));
}

export function getScreen(id: ScreenId): ScreenModule {
  const module = registry.get(id);
  if (!module) throw new Error(`screen ${id} is not registered`);
  return module;
}

/**
 * Resolve the screen that owns a query kind (its `surface.queries`), so a query
 * result (dispatched back onto the model) can be routed to the per-screen slot
 * (4F.1). Returns null when no registered screen declares the kind — the caller
 * then falls back to the currently active screen.
 *
 * More than one screen can legitimately declare the same query kind when
 * distinct workflows share a projection. `preferred`, when supplied and
 * among the claimants, wins — this is always the screen the query was
 * issued FOR (`refreshScreenData(screen)`'s `screen`, threaded through as
 * the currently focused screen), so an ambiguous kind lands in the slot the
 * operator is actually looking at rather than silently in whichever screen
 * happened to register first. Falls back to the first claimant when
 * `preferred` doesn't claim the kind (or wasn't supplied) — never throws on
 * an unclaimed kind.
 */
export function screenForQueryKind(kind: RuntimeQueryKind, preferred?: ScreenId): ScreenId | null {
  let first: ScreenId | null = null;
  for (const module of registry.values()) {
    if (!module.surface.queries.includes(kind)) continue;
    if (first === null) first = module.id;
    if (preferred !== undefined && module.id === preferred) return preferred;
  }
  return first;
}

/**
 * Reset the static catalog before a composition root installs its fixed screen
 * set. This makes a second TUI launch in the same host start from the same
 * closed catalog, rather than retaining registrations from a previous launch.
 */
export function clearRegisteredScreens(): void {
  registry.clear();
}
