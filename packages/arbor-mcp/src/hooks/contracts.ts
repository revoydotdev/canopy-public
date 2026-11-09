/**
 * Data contracts for the governed hook & lifecycle bus (roadmap 06).
 *
 * A hook descriptor is validated exactly like a skill descriptor
 * (`packages/arbor-mcp/src/skills/catalog.ts`): immutable, filename-identified,
 * bounded, and closed against a fixed registry of revoy2-owned handlers. The
 * descriptor never carries executable code — `handler_ref` names one
 * in-process handler from the closed registry in `handlers.ts`, exactly as a
 * skill's `structured_output` names a closed contract id rather than
 * embedding a schema.
 *
 * The whole safety case (roadmap §4) is that a hook can only reduce:
 *   - `veto` hooks may deny a tool call; they can never turn a base denial
 *     into an allow (the bus intersects, never unions, decisions).
 *   - `observe` hooks return `void` or a bounded note; the type gives them no
 *     path to influence any decision.
 *   - `lifecycle` hooks are observe-only, except a hook declared for the
 *     `session_start` event may be backed by a deny-capable handler — no
 *     other lifecycle event may ever deny (enforced structurally: see
 *     `HookHandlerEntry` below and the catalog's "hook_escalation" check).
 *   - `inject` hooks (proposal §5) return a typed `Tropism | null` that the
 *     bus validates and renders into prompt text. This is the only channel
 *     by which harness state reaches the model, and it is the *weakest* of
 *     the four: the rendered block is advisory data, it can never deny a
 *     tool call, grant a capability, or satisfy a predicate.
 */
import type { Tropism } from "@arbor/prompts";

/** Re-exported so a hook author imports one contract module; the definition lives in `@arbor/prompts` beside the renderer that consumes it. */
export type { Tropism, TropismLane, TropismScope } from "@arbor/prompts";

export const HOOK_SCHEMA_VERSION = 1;
export const HOOK_MAX_DESCRIPTORS = 64;
export const HOOK_MAX_DESCRIPTOR_BYTES = 8 * 1024;
export const HOOK_MAX_WHY_BYTES = 2 * 1024;
export const HOOK_MAX_REASON_BYTES = 512;
export const HOOK_MAX_NOTE_BYTES = 512;
export const HOOK_MAX_LEDGER_ENTRIES = 500;
/**
 * The wall-clock bound a handler gets when it declares none of its own
 * (`HookHandlerEntry.timeout_ms`) and the bus was not given one.
 *
 * It is sized for the handler this bus actually ships: a synchronous,
 * in-process, revoy2-owned function (§2 non-goal: no shell, no
 * code-from-disk). A single-threaded runtime cannot preempt a running
 * synchronous call, so this bound is a measured, after-the-fact wall-clock
 * check: a handler that runs long is detected and its action fails closed,
 * but it is not forcibly interrupted mid-flight. Documented honestly in
 * ADR-049's Consequences ("measured after return rather than forcibly
 * preempted").
 *
 * It is a DEFAULT, not a ceiling. A handler whose work is genuinely
 * asynchronous — a governed subprocess, a bounded filesystem read — states
 * its own cost on its registry entry, because 50 ms is the right line for
 * an in-process predicate and a meaningless one for I/O. The bound lives on
 * the handler entry rather than on the descriptor on purpose: it is a
 * property of revoy2-owned code, not of the operator's on-disk policy, and
 * putting it in `HookDescriptor` would have re-hashed every descriptor and
 * every `descriptor_hash` in the tree to record something about our own
 * function.
 */
export const HOOK_DEFAULT_TIMEOUT_MS = 50;

export type HookKind = "observe" | "veto" | "lifecycle" | "inject";

export const HOOK_VETO_EVENTS = Object.freeze(["tool_preflight"] as const);
/**
 * `user_prompt_submit`, `pre_compact`, and `notification` (ADR-111 decision 4)
 * parallel the Claude Code `settings.json` events of the same shape but are
 * observe-only here: they close the event-parity gap without granting any
 * new place a hook can block harness execution. They can never appear in
 * `HOOK_VETO_EVENTS`, and `HOOK_LIFECYCLE_VETO_EVENT` stays `session_start`.
 *
 * `turn_end` is the observe half of the per-turn boundary seam, and it is
 * deliberately NOT the place a turn is refused. A deny-capable `turn_end` would
 * be, by contract, a synchronous in-process handler the bus measures after it
 * returns and cannot preempt — which is exactly what a multi-second battery is
 * not: a single-threaded runtime will not run the bus's timer while such a
 * handler is on the stack, and on a deny lane an overrun fails CLOSED INTO A
 * DENIAL, so a slow handler would block the turn rather than let it proceed.
 * Widening `HOOK_LIFECYCLE_VETO_EVENT` from its single value to two would also
 * weaken the catalog's load-time reduction check, which refuses to bind a
 * deny-capable handler to any lifecycle event but `session_start`.
 *
 * So the split is: THIS lane observes out of band — it starts detached, writes
 * the firing row synchronously and settles it asynchronously, and carries no
 * field that could deny — while the refusal is the worker's own
 * `NativeHarnessWorkerOptions.turn_gate`, consulted at the one place a turn
 * ends successfully and bounded by a refusal budget like the structured-output
 * correction budget beside it. Reduction still holds: a hook can only reduce,
 * and the gate can only refuse a turn, never complete one the worker accepted.
 */
export const HOOK_OBSERVE_EVENTS = Object.freeze(["tool_audit", "tool_write", "phase", "ledger_transition", "user_prompt_submit", "pre_compact", "notification", "turn_end"] as const);
/**
 * The bound on ONE `HookObserveContext.detail` value.
 *
 * It is the same 1024 the file tools already enforce on their own `path` field
 * (`stringField(value, "path", 1, 1_024)`), for the same reason `MAX_VETO_PATH_BYTES`
 * is: the bus must never truncate a path the tool itself would have accepted.
 * The bound is on the VALUE, not the map, so one oversized entry cannot starve
 * the others and a handler reading `detail.path` can size its own reads.
 */
export const HOOK_MAX_DETAIL_VALUE_BYTES = 1024;
export const HOOK_LIFECYCLE_EVENTS = Object.freeze(["session_start", "session_end", "node_start", "node_end", "plan_confirm", "interruption"] as const);
/**
 * Proposal §5: `inject` reuses the lifecycle trigger points verbatim rather
 * than minting new ones, plus ONE addition.
 *
 * The six lifecycle events are already exactly the right moments for a
 * session-scoped derivation, so reusing them keeps `HOOK_ALL_EVENTS` a
 * faithful set of the names the bus actually dispatches.
 *
 * `turn_end` is the per-turn boundary, and it joins this list as a SECOND
 * binding of an event the bus already dispatches — which is legal, because an
 * event may be bindable by several KINDS. `session_start` is already
 * lifecycle_start + lifecycle_observe + inject; `turn_end` is observe
 * (W7b-1) + inject (this lane).
 *
 * WHAT THIS DOES NOT DO, which is the whole safety argument and the reason it
 * is a list edit rather than a new capability: an `inject` handler's return
 * type is `Tropism | null`, which carries NO decision field. So widening this
 * list cannot widen `HOOK_LIFECYCLE_VETO_EVENT` (still the single value
 * `session_start`), cannot make a descriptor on `turn_end` deny-capable, and
 * leaves the catalog's load-time reduction check refusing exactly what it
 * refused before — a veto or lifecycle_start handler bound to `turn_end` is
 * still `hook_escalation`, because `turn_end` is absent from `HOOK_VETO_EVENTS`
 * and from `HOOK_LIFECYCLE_EVENTS`. A per-turn REFUSAL is the worker's
 * `turn_gate`, which is not a bus event at all. This lane is the model-facing
 * text half of the seam, and it is advisory in the strict sense: it can
 * inform a model and can never deny a turn, grant a capability, or satisfy a
 * predicate.
 */
export const HOOK_INJECT_EVENTS = Object.freeze([...HOOK_LIFECYCLE_EVENTS, "turn_end"] as const);

export type HookVetoEvent = (typeof HOOK_VETO_EVENTS)[number];
export type HookObserveEvent = (typeof HOOK_OBSERVE_EVENTS)[number];
export type HookLifecycleEvent = (typeof HOOK_LIFECYCLE_EVENTS)[number];
export type HookInjectEvent = (typeof HOOK_INJECT_EVENTS)[number];
export type HookEvent = HookVetoEvent | HookObserveEvent | HookLifecycleEvent;

/**
 * The canonical lifecycle event catalog (`arbor hook events`, WA-43/J3-23):
 * derived by union from the three closed per-kind event lists above, never a
 * hand-typed second copy that could drift from what the bus actually
 * dispatches.
 */
export const HOOK_ALL_EVENTS: readonly HookEvent[] = Object.freeze([...HOOK_VETO_EVENTS, ...HOOK_OBSERVE_EVENTS, ...HOOK_LIFECYCLE_EVENTS]);

/** The only lifecycle event a lifecycle hook may ever deny (roadmap §2). */
export const HOOK_LIFECYCLE_VETO_EVENT: HookLifecycleEvent = "session_start";

export interface HookDescriptor {
  readonly schema_version: 1;
  readonly hook_id: string;
  readonly version: string;
  readonly kind: HookKind;
  readonly event: HookEvent;
  /**
   * Names one entry in the handler registry: either the closed, revoy2-owned
   * set in `handlers.ts`, or (ADR-111) an entry a `PluginRegistry`-admitted
   * plugin registered via `HookCatalog.addPluginHandlers` — never an
   * unsigned, unverified code-from-disk reference in either case.
   */
  readonly handler_ref: string;
  /** Non-secret, redacted rationale for why this hook is enabled. */
  readonly why: string;
}

export interface ValidatedHook extends HookDescriptor {
  readonly descriptor_hash: string;
}

export type HookCatalogErrorCode =
  | "descriptor_bound" | "malformed" | "identity" | "version" | "kind" | "hook_escalation" | "contract" | "immutable_conflict" | "plugin_tier";

export class HookCatalogError extends Error {
  constructor(readonly code: HookCatalogErrorCode, message: string) { super(message); this.name = "HookCatalogError"; }
}

export interface HookCatalogDiagnostic { readonly source: string; readonly code: HookCatalogErrorCode; readonly message: string; }

// --- Handler contexts and decisions -----------------------------------
//
// Every handler signature is synchronous and its return type is the only
// mechanism by which it can affect anything. An observe-shaped handler's
// return type carries no decision field at all, so "an observe hook grants
// or denies" is not a runtime bug to guard against — it is a value the type
// checker cannot construct.

/**
 * The bounded, redacted view of the call's own input a veto handler is
 * allowed to inspect. Deliberately four strings and nothing else: a
 * `tool_preflight` context is the *only* place a hook sees a call's payload,
 * so it is also the only place a payload could leak into a deny reason, a
 * ledger row, or a transcript. The bus redacts and truncates before the
 * handler is invoked, so no handler can widen this.
 *
 * A handler that wants to reconstruct an unredacted payload has nothing to
 * reconstruct from: a truncated field is a head slice, a redacted secret is
 * `[REDACTED]`, and an absent field is `""`. A handler that needs more must
 * read the file through a governed tool port, never through this context.
 *
 * Which fields populate is decided by the TOOL NAME alone, never by the
 * payload's own keys: a `file.write` is never judged by a git-write rule
 * because its payload happens to carry `command`, and a shell tool is never
 * judged by a file-write rule because it happens to carry `path`.
 */
export interface HookVetoToolInput {
  /** The shell command, for a command-carrying tool; `""` for every other tool. */
  readonly command: string;
  /**
   * The path the call writes, repo-relative as the file tools already resolve
   * it, and truncated at the bus's path bound. `""` for a tool that writes no
   * file, and for a write whose `path` is absent or not a string.
   */
  readonly path: string;
  /**
   * The text the call ADDS: `content` for `file.write` (the whole file), the
   * `replacement` for `file.patch`. `""` for every other tool.
   */
  readonly added_text: string;
  /**
   * The text the call REMOVES: the located `expected` span of a
   * `file.patch`, and nothing else. A `file.write` replaces a whole file and
   * displaces no located span, so its `removed_text` is `""` — never a copy
   * of `added_text`, which would assert a removal that did not happen.
   *
   * This field is what lets a guard distinguish an edit that INTRODUCED a
   * marker from one that merely touched a file where the marker was already
   * present. Without it the two are indistinguishable and that discharge is
   * unrepresentable.
   */
  readonly removed_text: string;
}

export interface HookVetoContext {
  readonly event: "tool_preflight";
  readonly hook_id: string;
  readonly version: string;
  readonly session_id: string;
  readonly call_id: string;
  readonly tool: string;
  /**
   * Already bounded and redacted by the bus. A handler that needs to reason
   * about *what* is being called can read it; a handler that wants to
   * reconstruct an unredacted payload has nothing to reconstruct from.
   */
  readonly tool_input: HookVetoToolInput;
  /**
   * True when the port this veto chain guards was composed for a dispatched
   * subagent session rather than the orchestrator's own. The signal is the
   * repo's own discriminator (`nodeId.startsWith("subagent-")` in
   * `native-agent-executor.ts`), threaded in by the composition site — never
   * parsed out of a session id, which is opaque. It defaults to `false` at
   * every composition site that passes no option, so an unguarded orchestrator
   * call can never be mislabelled as a subagent one.
   */
  readonly subagent: boolean;
}
export type HookVetoDecision = Readonly<{ allow: true }> | Readonly<{ allow: false; reason: string }>;
export type HookVetoHandler = (context: HookVetoContext) => HookVetoDecision;

export interface HookObserveContext {
  readonly event: HookObserveEvent;
  readonly hook_id: string;
  readonly version: string;
  readonly session_id: string | null;
  /** Already bounded/redacted by the caller before this handler ever sees it. */
  readonly summary: string;
  /**
   * The structured half of the observation, and — as of `tool_write` — the
   * ONLY place an observe handler can see a path.
   *
   * Every value is redacted with `redactNativeText` and sliced to
   * `HOOK_MAX_DETAIL_VALUE_BYTES` by the bus, exactly as `summary` is. That
   * closing is deliberate and BROADER than the one field that forced it: this
   * map is a `Record<string, string>` any caller (including a plugin handler)
   * fills, and a redaction discipline enforced per-caller is one a future
   * caller forgets. Doing it once, at the boundary, is the same reason
   * `vetoToolInput` redacts the veto payload rather than each guard.
   */
  readonly detail: Readonly<Record<string, string>>;
}
/**
 * No field here can deny, mutate, or grant anything — only an optional note
 * for the hook's own ledger line, and the hashes that note is a function of.
 * The Promise arm is the same shape resolved later, and carries no field the
 * synchronous arm does not: an observe handler still cannot reach a decision,
 * and `HookObserveOutcome` is the whole of what the bus reads off a settled
 * handler.
 *
 * `derived_from` is LEDGER-ONLY and is not a dedupe key on this lane: the
 * inject lane drops a body whose derivation did not move (§5.3 rule 2), and
 * `fireObserve` records every firing. It exists because a hook that stops
 * measuring has to be visible, and a hook that only ever emitted a fixed verdict
 * is invisible by construction — the failure ADR-032 records across ~42
 * sessions. Carrying the derivation on the row makes "its inputs stopped
 * moving" a fact in the ledger rather than an absence, and it is the only
 * audit hook-liveness has of a native handler (that gate reads stdout from
 * shell scripts and cannot see a handler at all).
 */
export type HookObserveOutcome = Readonly<{ note?: string; derived_from?: readonly string[] }> | void;
export type HookObserveHandler = (context: HookObserveContext) => HookObserveOutcome | Promise<HookObserveOutcome>;

export interface HookLifecycleContext {
  readonly event: HookLifecycleEvent;
  readonly hook_id: string;
  readonly version: string;
  readonly session_id: string;
  readonly campaign_id: string;
  readonly node_id: string | null;
  /** The dispatched role profile id (e.g. "architect", "documentation-writer"); null when not yet composed (never for session_start onward). */
  readonly role: string | null;
  /** Terminal session state at `session_end`/`node_end`; null for every other event — a hook may observe this, never forge it. */
  readonly outcome: string | null;
}
/** Only ever invoked by the bus for `event === "session_start"`. */
export type HookLifecycleStartDecision = Readonly<{ allow: true }> | Readonly<{ allow: false; reason: string }>;
export type HookLifecycleStartHandler = (context: HookLifecycleContext) => HookLifecycleStartDecision;
export type HookLifecycleObserveHandler = (context: HookLifecycleContext) => HookObserveOutcome;

/**
 * Proposal §5.2: an `inject` handler returns a `Tropism | null` — never a
 * string. Returning `null` means "this trigger has nothing new to say",
 * which is the ordinary case, because §5.3 rule 2 forbids re-injecting a
 * body whose `derived_from` did not change.
 *
 * The return type is a *proposal*, not an assertion: the bus validates
 * every tropism against the catalog's §5.3 lints and bounds it before
 * anything is rendered, so a handler cannot declare its own validity and a
 * plugin handler cannot smuggle unbounded or imperative text past the bus.
 *
 * `turn` is the only addition to the lifecycle context, and it is
 * additive: `expires_after_turns` is denominated in model turns, and the
 * existing `observe`/`veto`/`lifecycle` contexts are deliberately left
 * unchanged so no handler of those kinds can observe a turn counter.
 */
export type HookInjectContext = Omit<HookLifecycleContext, "event" | "campaign_id"> & Readonly<{
  /** The lifecycle event, or `turn_end` — the two sets of moments a tropism can be derived from. */
  readonly event: HookInjectEvent;
  /**
   * Null on `turn_end`. A per-turn boundary knows the session and the turn,
   * and nothing else: the campaign and node a lifecycle event carries are
   * orchestrator facts the turn loop does not hold. Null rather than `""` so
   * "not a lifecycle moment" is unrepresentable as a plausible-looking id.
   */
  readonly campaign_id: string | null;
  readonly turn: number;
}>;
export type HookInjectHandler = (context: HookInjectContext) => Promise<Tropism | null> | Tropism | null;

/**
 * A handler's own wall-clock bound, in milliseconds. The bus enforces it
 * instead of `HOOK_DEFAULT_TIMEOUT_MS` when it is a positive finite number,
 * and on every kind of entry — the deny lanes included, where an overrun is
 * still a denial rather than a warning.
 *
 * It is declared here, on the revoy2-owned registry entry, and not on
 * `HookDescriptor`: the bound describes what a given function costs, and
 * `HookDescriptor` is the operator's hashed on-disk policy artifact whose
 * bytes are a `descriptor_hash` recorded in the ledger. A malformed value
 * (not a number, non-positive, infinite) is not fatal — the bus falls back
 * to the tighter bus-wide default, and a handler that then overruns is
 * reported as an overrun rather than silently ignored.
 */
/**
 * A handler's two declared costs, both properties of revoy2-owned code rather
 * than of the operator's on-disk policy, and both therefore declared on the
 * registry entry instead of on `HookDescriptor` (whose bytes are a
 * `descriptor_hash` recorded in the ledger — putting a bound there would
 * re-hash every descriptor in the tree to record something about our own
 * function).
 */
interface HookHandlerBounds {
  readonly timeout_ms?: number;
  /**
   * How many bytes of `added_text` / `removed_text` this handler is given.
   * The bus-wide default is deliberately small, which is the right line for a
   * guard that tests a PREFIX (`is this path under .visual-intelligence/`) and
   * the wrong one for a guard that searches a body for a marker: a head slice
   * that happens to fall short of the marker turns a refusal into a silent
   * allow, and a guard that cannot see the rest of the body cannot know it did.
   *
   * A handler that declares this states what the TOOL will admit, so the bus
   * never truncates text the tool would have accepted — the same relationship
   * `MAX_VETO_PATH_BYTES` already has to the file tools' own `path` bound. A
   * value that is not a positive finite number falls back to the bus default
   * (the tighter line is the safe direction), and a handler that then overruns
   * is told its text may be a head rather than being left to assume otherwise.
   */
  readonly text_bytes?: number;
}

/**
 * A handler's classified outcome. Lives here rather than in `bus.ts`
 * because both the bus and the `inject` surface consume it and must agree
 * on one timing/fail-closed policy. The failure arm carries the bound that
 * was actually in force so the ledger can name it: a refusal that does not
 * say which limit was crossed is a refusal an operator cannot act on.
 */
export type BoundedOutcome<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; code: string; message: string; bound_ms: number }>;

/**
 * A refused firing, named by cause. An overrun additionally names the bound
 * it crossed, because "this hook failed" and "this hook took longer than the
 * limit it declared" call for different operator responses and neither is
 * actionable without the second. Shared by the bus and the inject surface so
 * one refusal reads the same in every lane's ledger row.
 */
export function hookFailureRef(prefix: string, outcome: Readonly<{ code: string; bound_ms: number }>): string {
  return outcome.code === "hook_timeout_exceeded" ? `${prefix} error=${outcome.code} bound_ms=${outcome.bound_ms}` : `${prefix} error=${outcome.code}`;
}

/**
 * A handler's registry entry is tagged with its own capability kind, which is
 * distinct from (and checked against) the *descriptor's* declared `kind`.
 * `lifecycle_start` is the single deny-capable lifecycle shape and the
 * catalog (`catalog.ts`) refuses to bind it to any event but
 * `HOOK_LIFECYCLE_VETO_EVENT` — this is where "reduction at load" lives for
 * lifecycle hooks.
 *
 * `"plugin"` (ADR-111 decision 1) is the operator-authored path: it lets a
 * `HookDescriptor.handler_ref` resolve to a function an *admitted*
 * `PluginRegistry` plugin exports, instead of only to a `handlers.ts`
 * built-in. It carries `plugin_id`/`export_name` for audit provenance and a
 * `handler` the bus dispatches exactly like any other entry. It grants no
 * new decision shape: `runVetoChain`/`fireObserve`/the lifecycle dispatchers
 * still runtime-validate the returned value against `HookVetoDecision` /
 * `HookObserveOutcome` before trusting it, so a plugin-backed veto hook can
 * only ever return `{ allow: true }` or `{ allow: false; reason }`, exactly
 * as a built-in one can. `HookCatalog` refuses to bind a `"plugin"` entry to
 * a `tool_preflight` veto descriptor unless the owning plugin holds `T4`
 * (`catalog.ts`'s `plugin_tier` check) — the single trust tier this ADR
 * requires for a veto-capable hook.
 */

export type HookHandlerEntry = (HookHandlerBounds & Readonly<{ readonly kind: "veto"; readonly handler: HookVetoHandler }>)
  | (HookHandlerBounds & Readonly<{ readonly kind: "observe"; readonly handler: HookObserveHandler }>)
  | (HookHandlerBounds & Readonly<{ readonly kind: "lifecycle_start"; readonly handler: HookLifecycleStartHandler }>)
  | (HookHandlerBounds & Readonly<{ readonly kind: "lifecycle_observe"; readonly handler: HookLifecycleObserveHandler }>)
  | (HookHandlerBounds & Readonly<{ readonly kind: "inject"; readonly handler: HookInjectHandler }>)
  | (HookHandlerBounds & Readonly<{
      readonly kind: "plugin";
      readonly plugin_id: string;
      readonly export_name: string;
      readonly handler: (context: HookVetoContext | HookObserveContext | HookLifecycleContext) => unknown;
    }>);

export type HookHandlerRegistry = Readonly<Record<string, HookHandlerEntry>>;
