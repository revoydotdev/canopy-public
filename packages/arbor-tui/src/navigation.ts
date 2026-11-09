/**
 * Pure workspace, pane, layout, and focus state for the renderer port.
 *
 * `Modal`/`NavigationModel.modals` were removed (wave2/tui-input-model): the
 * type had a correct consumer (`focusTargets` below routed focus to the last
 * modal) but zero producer anywhere in this codebase — `navigation.ts`
 * exported no `pushModal`/`openModal` of any kind, so nothing could ever
 * populate it. The overlay this codebase actually uses (compose/confirm/help)
 * is modeled on `AppModel.overlay` (types.ts) instead, deliberately outside
 * `NavigationModel`'s focus system — overlays already fully own the keyboard
 * while active (the raw input loop intercepts them before catalog routing),
 * so pane-level focus targeting has nothing to add for them.
 */
export interface TerminalSize { readonly columns: number; readonly rows: number; }
export interface Pane { readonly id: string; readonly title: string; readonly focusable?: boolean; readonly min_columns?: number; readonly min_rows?: number; }
export interface Workspace { readonly id: string; readonly route: string; readonly panes: readonly Pane[]; readonly split: "horizontal" | "vertical"; readonly ratio: number; }
export type FocusTarget = { readonly kind: "pane"; readonly id: string };
export interface NavigationModel { readonly workspaces: readonly Workspace[]; readonly terminal: TerminalSize; readonly focus: FocusTarget | null; }
export interface PaneRect { readonly id: string; readonly x: number; readonly y: number; readonly columns: number; readonly rows: number; }
export interface WorkspaceLayout { readonly mode: "split" | "compact" | "empty"; readonly panes: readonly PaneRect[]; }

const MIN_COLUMNS = 80;
const MIN_ROWS = 24;

export function createNavigation(workspace: Workspace, terminal: TerminalSize): NavigationModel {
  return normalize({ workspaces: [freezeWorkspace(workspace)], terminal: validTerminal(terminal), focus: null });
}

export function activeWorkspace(model: NavigationModel): Workspace | null { return model.workspaces.at(-1) ?? null; }
/**
 * Applies a live terminal-size change (real caller: `TuiShell`'s draw loop,
 * `shell.ts` — polls the controlling terminal's actual dimensions on every
 * draw and, when they differ from the projection's own navigation state,
 * re-derives layout through this function before painting).
 */
export function resizeTerminal(model: NavigationModel, terminal: TerminalSize): NavigationModel { return normalize({ ...model, terminal: validTerminal(terminal) }); }

/** Deterministic layout; compact mode presents only the focused pane. */
export function layoutWorkspace(model: NavigationModel): WorkspaceLayout {
  const workspace = activeWorkspace(model); if (!workspace || !workspace.panes.length) return { mode: "empty", panes: [] };
  const compact = model.terminal.columns < MIN_COLUMNS || model.terminal.rows < MIN_ROWS;
  if (compact) {
    const id = model.focus?.kind === "pane" ? model.focus.id : workspace.panes.find((pane) => pane.focusable !== false)?.id ?? workspace.panes[0].id;
    return { mode: "compact", panes: [{ id, x: 0, y: 0, columns: model.terminal.columns, rows: model.terminal.rows }] };
  }
  if (workspace.panes.length === 1) return { mode: "split", panes: [rect(workspace.panes[0], 0, 0, model.terminal.columns, model.terminal.rows)] };
  const first = workspace.panes[0]; const second = workspace.panes[1];
  if (workspace.split === "horizontal") {
    const firstColumns = splitExtent(model.terminal.columns, Math.round(model.terminal.columns * workspace.ratio), first.min_columns ?? 20, second.min_columns ?? 20);
    return { mode: "split", panes: [rect(first, 0, 0, firstColumns, model.terminal.rows), rect(second, firstColumns, 0, model.terminal.columns - firstColumns, model.terminal.rows)] };
  }
  const firstRows = splitExtent(model.terminal.rows, Math.round(model.terminal.rows * workspace.ratio), first.min_rows ?? 5, second.min_rows ?? 5);
  return { mode: "split", panes: [rect(first, 0, 0, model.terminal.columns, firstRows), rect(second, 0, firstRows, model.terminal.columns, model.terminal.rows - firstRows)] };
}

/** Honor pane minimums when they fit; otherwise preserve the ratio without ever overflowing the terminal. */
function splitExtent(total: number, desired: number, firstMinimum: number, secondMinimum: number): number {
  const first = Math.min(total, Math.max(0, firstMinimum));
  const second = Math.min(total, Math.max(0, secondMinimum));
  if (first + second > total) return Math.max(0, Math.min(total, desired));
  return bounded(desired, first, total - second);
}

function normalize(model: NavigationModel): NavigationModel {
  const normalized: NavigationModel = { ...model, workspaces: model.workspaces.map(freezeWorkspace), terminal: validTerminal(model.terminal) };
  const targets = focusTargets(normalized);
  return { ...normalized, focus: normalized.focus !== null && targets.some((target) => sameFocus(target, normalized.focus!)) ? normalized.focus : targets[0] ?? null };
}
function focusTargets(model: NavigationModel): FocusTarget[] {
  return (activeWorkspace(model)?.panes ?? []).filter((pane) => pane.focusable !== false).map((pane) => ({ kind: "pane" as const, id: pane.id }));
}
function sameFocus(left: FocusTarget, right: FocusTarget): boolean { return left.kind === right.kind && left.id === right.id; }
function freezePane(pane: Pane): Pane { if (!pane.id.trim() || !pane.title.trim()) throw new Error("pane id and title must be non-empty"); return { ...pane }; }
function freezeWorkspace(workspace: Workspace): Workspace { if (!workspace.id.trim() || !workspace.route.trim() || !Number.isFinite(workspace.ratio) || workspace.ratio <= 0 || workspace.ratio >= 1) throw new Error("workspace requires id, route, and ratio strictly between zero and one"); if (workspace.panes.length > 2) throw new Error("workspace supports at most two panes"); const ids = new Set<string>(); const panes = workspace.panes.map((pane) => { const value = freezePane(pane); if (ids.has(value.id)) throw new Error(`duplicate pane id ${value.id}`); ids.add(value.id); return value; }); return { ...workspace, panes }; }
function validTerminal(terminal: TerminalSize): TerminalSize { if (!Number.isSafeInteger(terminal.columns) || !Number.isSafeInteger(terminal.rows) || terminal.columns < 1 || terminal.rows < 1) throw new Error("terminal dimensions must be positive safe integers"); return { ...terminal }; }
function bounded(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
function rect(pane: Pane, x: number, y: number, columns: number, rows: number): PaneRect { return { id: pane.id, x, y, columns, rows }; }
