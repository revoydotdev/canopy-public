/** Pure normalized terminal input and catalog routing for the headless cockpit. */
export type KeyModifier = "ctrl" | "alt" | "shift";
export interface NormalizedKeyEvent { key: string; modifiers?: readonly KeyModifier[]; text?: string; paste?: boolean; }
export type InputScope = "global" | "screen" | "pane" | "modal";
export interface KeyBinding { keys: readonly string[]; scope: InputScope; description: string; }
/**
 * Catalog-kind discriminator (per the fused-component architecture §3.4): the
 * palette/help unifies built-in commands, catalog command/query kinds, node
 * actions (NodeCard steerable), and skill/delegation surfaces behind one
 * surfaced search. `undefined` = legacy action without a declared source.
 */
export type CatalogSource = "builtin" | "command" | "node" | "skill";
export interface UiAction {
  id: string;
  title: string;
  description: string;
  bindings: readonly KeyBinding[];
  /**
   * A short authority/effect statement for contextual discovery.  This is
   * presentation metadata only: command routing remains keyed by `id`.
   */
  discovery?: { readonly authority?: string; readonly effect?: string };
  /** Optional source discriminator for the unified palette (ADR-020/4D.9). */
  source?: CatalogSource;
}
export interface CatalogConflict { scope: InputScope; sequence: string; action_ids: readonly string[]; }
export interface InputCatalog { actions: readonly UiAction[]; }
export type InputResult = { kind: "action"; action_id: string } | { kind: "pending" } | { kind: "ignored" } | { kind: "paste"; text: string; truncated: boolean };

const precedence: readonly InputScope[] = ["modal", "pane", "screen", "global"];
export function normalizeKey(event: NormalizedKeyEvent): string {
  const mods = [...new Set(event.modifiers ?? [])].sort();
  return [...mods, event.key.toLowerCase()].join("+");
}
export function catalogConflicts(catalog: InputCatalog): CatalogConflict[] {
  const found = new Map<string, string[]>();
  for (const action of catalog.actions) for (const binding of action.bindings) {
    const sequence = binding.keys.join(" "); const key = `${binding.scope}:${sequence}`;
    found.set(key, [...(found.get(key) ?? []), action.id]);
  }
  return [...found].filter(([, ids]) => ids.length > 1).map(([key, action_ids]) => { const [scope, sequence] = key.split(":", 2); return { scope: scope as InputScope, sequence, action_ids }; });
}
export function helpActions(catalog: InputCatalog, scope?: InputScope): UiAction[] {
  return catalog.actions.filter((action) => scope === undefined || action.bindings.some((binding) => binding.scope === scope));
}

/** Stateful only for a pending chord; time is supplied by callers, never scheduled. */
export class InputRouter {
  private pending: { keys: string[]; at: number; scopes: readonly InputScope[] } | null = null;
  constructor(private readonly catalog: InputCatalog, private readonly clock: () => number, private readonly chordTimeoutMs = 750, private readonly pasteLimit = 8192) {
    if (catalogConflicts(catalog).length) throw new Error("input catalog contains conflicting bindings");
  }
  handle(event: NormalizedKeyEvent, activeScopes: readonly InputScope[]): InputResult {
    if (event.paste) { const text = (event.text ?? "").slice(0, this.pasteLimit); return { kind: "paste", text, truncated: (event.text ?? "").length > text.length }; }
    const now = this.clock();
    const scopes = precedence.filter((scope) => activeScopes.includes(scope) || scope === "global");
    const prior = this.pending && now - this.pending.at <= this.chordTimeoutMs ? this.pending.keys : [];
    const keys = [...prior, normalizeKey(event)]; this.pending = null;
    const bindings = this.matches(keys, scopes);
    if (bindings.length === 0 && prior.length) return this.route([normalizeKey(event)], scopes, now);
    if (bindings.some((item) => item.binding.keys.length > keys.length)) { this.pending = { keys, at: now, scopes }; return { kind: "pending" }; }
    const exact = bindings.find((item) => item.binding.keys.length === keys.length);
    return exact ? { kind: "action", action_id: exact.action.id } : { kind: "ignored" };
  }
  expire(): InputResult { if (!this.pending || this.clock() - this.pending.at <= this.chordTimeoutMs) return { kind: "ignored" }; this.pending = null; return { kind: "ignored" }; }
  /** Current incomplete chord, if it is still live.  The renderer owns how it is surfaced. */
  pendingChord(): readonly string[] {
    if (this.pending === null || this.clock() - this.pending.at > this.chordTimeoutMs) return [];
    return [...this.pending.keys];
  }
  private route(keys: string[], scopes: readonly InputScope[], now: number): InputResult { const bindings = this.matches(keys, scopes); if (bindings.some((item) => item.binding.keys.length > keys.length)) { this.pending = { keys, at: now, scopes }; return { kind: "pending" }; } const exact = bindings.find((item) => item.binding.keys.length === keys.length); return exact ? { kind: "action", action_id: exact.action.id } : { kind: "ignored" }; }
  private matches(keys: string[], scopes: readonly InputScope[]) { return precedence.flatMap((scope) => !scopes.includes(scope) ? [] : this.catalog.actions.flatMap((action) => action.bindings.filter((binding) => binding.scope === scope && binding.keys.slice(0, keys.length).every((key, index) => key === keys[index])).map((binding) => ({ action, binding })))); }
}
