/**
 * Governed hook & lifecycle bus (roadmap 06).
 *
 * Composes the closed, catalog-validated hook set (`catalog.ts`) into three
 * dispatch surfaces that generalize prior art rather than forking it:
 *
 *   - `wrapToolPort` composes a veto chain *before* an existing
 *     `NativeToolPort.preflight` (`packages/arbor-harness/src/native-worker.ts`
 *     ~:181/:604, which already fails closed on a thrown/invalid preflight
 *     result). The effective decision is `base_allow AND ⋀(hook.decide)` —
 *     intersection only, so `effective_allow ⟹ base_allow` holds by
 *     construction: a hook can flip an allow to a deny, never the reverse.
 *   - `observeToolAudit`/`observeLedgerTransition`/`observePhase` subscribe
 *     to the existing post-execution audit callback
 *     (`native-tools/contracts.ts` `on_audit`) and the native session
 *     engine's own ledger-witnessed event stream. Observe handlers return
 *     `void` or a bounded note; there is no field they could use to deny,
 *     mutate, or grant anything.
 *   - `lifecycleSessionStart`/`lifecycleObserve` cover session/node
 *     start+end, plan confirm, and interruption. Only `session_start` may be
 *     bound to a deny-capable handler (enforced at catalog load, not here).
 *   - `injectForSession`/`injectTurnEnd` (proposal §5) are the only surfaces
 *     that can put harness state in front of the model. They are deliberately
 *     the narrowest: a handler proposes a `Tropism`, and *this bus* validates
 *     it against the catalog's §5.3 lints, bounds it, and renders it. A
 *     handler cannot assert its own validity, and the returned text carries the
 *     same `context-only` trust label every other framed prompt block uses — an
 *     injection can inform a model but can never deny, grant, or satisfy. The
 *     session lane fires on a lifecycle moment; the turn lane fires on the
 *     per-turn boundary, and its scope belongs to the NEXT turn's prompt
 *     rather than the session's.
 *     It travels as prompt text, never as a context-manager entry: see
 *     `packages/arbor-harness/src/native-worker.ts`'s `boundedHistory`,
 *     which drops any context entry a conversation entry does not cite.
 *
 * Fail-closed: a veto (or lifecycle-start) handler that throws, exceeds its
 * wall-clock bound, or returns an invalid decision denies the action and is
 * attributed to the firing hook by id. An observe handler that throws is
 * dropped and logged; the action it observed already happened and proceeds
 * unaffected. Every firing — allow, deny, observed, or error — writes one
 * bounded, redacted record to this bus's own ledger (`HookFiredRecord`), the
 * same "persisted invocation history" idea ADR-032 uses for dev-hook
 * liveness, kept in a separate store per that ADR's own distinction.
 *
 * Two lanes carry a handler that may return a Promise, and all three dispatch
 * it under a real timer rather than a synchronous measurement: both inject
 * lanes await the handler because the caller needs the tropism it returns,
 * and `fireObserve` cannot await because the host stream it subscribes to is
 * synchronous, so it writes a `pending=` row at the observation point and
 * records the settlement when it lands. A handler declares the bound it
 * needs on its registry entry (`HookHandlerEntry.timeout_ms`); a refusal
 * names the bound it crossed.
 */
import { redactNativeText } from "@arbor/harness";
import type { NativeToolExecutionEvidence, NativeToolPort, NativeToolPreflightResult, NativeToolRequest, NativeToolResponse, SessionEvent } from "@arbor/harness";
import type { TropismScope } from "@arbor/prompts";
import type { NativeToolAuditRecord } from "../native-tools/contracts.js";
import { HookCatalog } from "./catalog.js";
import { HOOK_HANDLERS } from "./handlers.js";
import { TropismInjector } from "./inject.js";
import { projectToolVeto } from "../gate-refusal-projection.js";
import {
  HOOK_DEFAULT_TIMEOUT_MS,
  HOOK_LIFECYCLE_VETO_EVENT,
  HOOK_MAX_DETAIL_VALUE_BYTES,
  HOOK_MAX_LEDGER_ENTRIES,
  HOOK_MAX_NOTE_BYTES,
  HOOK_MAX_REASON_BYTES,
  type HookEvent,
  type HookHandlerRegistry,
  type HookKind,
  type HookLifecycleContext,
  type HookLifecycleEvent,
  type HookObserveContext,
  type HookObserveEvent,
  type HookVetoContext,
  type HookVetoToolInput,
  type BoundedOutcome,
  type HookVetoDecision,
  type ValidatedHook,
  hookFailureRef,
} from "./contracts.js";

export interface HookFiredRecord {
  readonly hook_id: string;
  readonly version: string;
  readonly kind: HookKind;
  readonly event: HookEvent;
  readonly decision: "observed" | "allow" | "deny" | "error";
  /** Bounded, redacted; never tool input, file content, or a credential. */
  readonly evidence_ref: string;
  readonly at: string;
  /**
   * Present on an `inject` firing (proposal §5.3 rule 2): the event
   * hashes the injected body is a function of. It is what makes "derived,
   * never constant" auditable from the ledger alone, and it is what the
   * bus dedupes on to stop a per-turn injection becoming a per-turn tax.
   *
   * An `observe` firing may carry one too, as a handler-declared derivation.
   * It is NOT deduped there — the observe lane records every firing — so it
   * is an audit field: a native handler is invisible to
   * `scripts/hook-liveness-gate.mjs`, which reads stdout from shell scripts,
   * and a note whose derivation stopped moving is the only trace that the
   * handler behind it stopped measuring.
   */
  readonly derived_from?: readonly string[];
}

export interface HookBusOptions {
  readonly catalog: HookCatalog;
  readonly handlers?: HookHandlerRegistry;
  /** Optional external durable sink (e.g. the campaign audit ledger). */
  readonly on_fired?: (record: HookFiredRecord) => void;
  readonly timeout_ms?: number;
  readonly max_ledger_entries?: number;
  readonly clock?: { now(): number };
}

const NO_ACTION_SCOPE = Object.freeze({ status: "not_required" as const });

/**
 * Origin the composition site already knows and the request does not carry.
 * Absent means "not a dispatched subagent" — the pre-existing behaviour at
 * every call site that predates this option.
 */
export interface HookToolPortOrigin {
  readonly subagent?: boolean;
}


export class HookBus {
  private readonly catalog: HookCatalog;
  private readonly onFired: ((record: HookFiredRecord) => void) | undefined;
  private readonly timeoutMs: number;
  private readonly maxLedger: number;
  private readonly clock: { now(): number };
  private readonly ledgerEntries: HookFiredRecord[] = [];
  private readonly firedHookIdentities = new Set<string>();
  private readonly injector: TropismInjector;

  static fromDirectory(directory: string, options: Omit<HookBusOptions, "catalog"> = {}): HookBus {
    const handlers = options.handlers ?? HOOK_HANDLERS;
    return new HookBus({ ...options, handlers, catalog: HookCatalog.fromDirectory(directory, { handlers }) });
  }

  constructor(options: HookBusOptions) {
    this.catalog = options.catalog;
    this.onFired = options.on_fired;
    this.timeoutMs = options.timeout_ms ?? HOOK_DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("hook bus timeout_ms must be a positive number");
    this.maxLedger = options.max_ledger_entries ?? HOOK_MAX_LEDGER_ENTRIES;
    if (!Number.isSafeInteger(this.maxLedger) || this.maxLedger <= 0) throw new Error("hook bus max_ledger_entries must be a positive safe integer");
    this.clock = options.clock ?? { now: () => Date.now() };
    this.injector = new TropismInjector(this.catalog, (hook, event, decision, evidenceRef, derivedFrom) => this.record(hook, event, decision, evidenceRef, derivedFrom));
  }

  diagnostics() { return this.catalog.diagnostics(); }
  ledger(): readonly HookFiredRecord[] { return Object.freeze([...this.ledgerEntries]); }

  /** Declared hooks that have never fired — the ADR-032 failure mode, surfaced instead of reproduced. */
  neverFired(): readonly ValidatedHook[] {
    return this.catalog.list().filter((hook) => !this.firedHookIdentities.has(identity(hook.hook_id, hook.version)));
  }

  // --- veto: tool_preflight -------------------------------------------

  /**
   * Compose this bus's veto chain *before* `port`'s own preflight, and fire the
   * `tool_write` observe event after `port`'s own preflight admits the call. When
   * neither a veto hook nor a `tool_write` observe hook is declared this returns
   * `port` unchanged so an unconfigured bus adds no indirection. Reuses the
   * worker's existing preflight fail-closed contract
   * (`NativeToolPreflightResult`) rather than forking it: a denial from here is
   * indistinguishable, to the worker, from a denial the tool host itself would
   * have produced.
   */
  wrapToolPort(port: NativeToolPort, options?: HookToolPortOrigin): NativeToolPort {
    const vetoHooks = this.catalog.list().filter((hook) => hook.kind === "veto" && hook.event === "tool_preflight");
    // A declared `tool_write` observe hook must ALSO cause the wrap, or it
    // would be a handler no tool call can reach on a bus that declares no veto
    // — the same registration-is-not-activation defect `DEFAULT_HOOK_SET`'s own
    // header records, in a lane that had no veto to fall back on.
    const writeHooks = this.catalog.list().filter((hook) => hook.kind === "observe" && hook.event === "tool_write");
    if (vetoHooks.length === 0 && writeHooks.length === 0) return port;
    const bus = this;
    const subagent = options?.subagent ?? false;
    // Spread first, override only `preflight`: a real tool port (an MCP
    // adapter in particular) may carry extra properties the composition root
    // reads by duck-typed cast (`model_definition`, for the model-visible
    // tool schema — see native-agent-executor.ts's `advertisedToolDefinitions`).
    // Reconstructing the object field-by-field would silently drop them.
    return Object.freeze({
      ...port,
      preflight(request: NativeToolRequest): NativeToolPreflightResult {
        const vetoed = bus.runVetoChain(vetoHooks, port.tool, request, subagent);
        if (vetoed !== null) return vetoed;
        const admitted = port.preflight ? port.preflight(request) : { allowed: true } as const;
        // After admission, not before: a call a veto or the base port refuses
        // never reaches the filesystem, so recording it would put a line in
        // `.dirty` for a write that cannot exist.
        if (admitted.allowed) bus.fireToolWrite(request.session_id, port.tool, request.input);
        return admitted;
      },
    });
  }

  /**
   * Like `wrapToolPort`, but also wraps `execute` to fire a bounded
   * `tool_audit` observe event once the call completes — the tool outcome
   * kind only (tool name, outcome, code, effect), never a payload body. Use
   * this for a tool port family with no other post-execution audit path
   * (bus-thread, subagent dispatch, user input, and any other
   * `specialist_tools`-composed port). Repository tools keep using plain
   * `wrapToolPort`: their host already produces a richer
   * `NativeToolAuditRecord` through its own `on_audit` callback
   * (`cli.ts`), and wrapping their `execute` here too would fire
   * `tool_audit` twice for one action.
   */
  wrapToolPortWithAudit(port: NativeToolPort, options?: HookToolPortOrigin): NativeToolPort {
    const wrapped = this.wrapToolPort(port, options);
    const auditHooks = this.catalog.list().filter((hook) => hook.kind === "observe" && hook.event === "tool_audit");
    if (auditHooks.length === 0) return wrapped;
    const bus = this;
    return Object.freeze({
      ...wrapped,
      async execute(request: NativeToolRequest, secret: string | null, signal: AbortSignal): Promise<NativeToolResponse> {
        const response = await wrapped.execute(request, secret, signal);
        bus.fireObserve("tool_audit", request.session_id, `${port.tool} ${response.evidence.outcome}`, {
          tool: port.tool, outcome: response.evidence.outcome, code: response.evidence.code, effect: response.evidence.effect,
        });
        return response;
      },
    });
  }

  /** Returns a denial when a hook denies or fails closed; `null` (proceed to base preflight) otherwise. */
  private runVetoChain(hooks: readonly ValidatedHook[], tool: string, request: NativeToolRequest, subagent: boolean): NativeToolPreflightResult | null {
    for (const hook of hooks) {
      const entry = this.catalog.resolveHandler(hook.handler_ref);
      const context: HookVetoContext = Object.freeze({ event: "tool_preflight", hook_id: hook.hook_id, version: hook.version, session_id: request.session_id, call_id: request.call_id, tool, subagent, tool_input: vetoToolInput(tool, request.input, entry?.text_bytes) });
      const outcome = this.runBounded((): unknown => {
        if (entry === undefined || (entry.kind !== "veto" && entry.kind !== "plugin")) throw new Error("hook handler is not a registered veto handler");
        return entry.handler(context);
      }, entry?.timeout_ms);
      if (!outcome.ok) {
        this.record(hook, "tool_preflight", "error", hookFailureRef(`tool=${tool}`, outcome));
        return denial(hook, "hook_veto_failed", outcome.message);
      }
      if (!isVetoDecision(outcome.value)) {
        this.record(hook, "tool_preflight", "error", `tool=${tool} error=invalid_decision`);
        return denial(hook, "hook_veto_failed", "handler returned an invalid decision");
      }
      if (!outcome.value.allow) {
        this.record(hook, "tool_preflight", "deny", `tool=${tool}`);
        return denial(hook, "hook_denied", outcome.value.reason);
      }
      // An explicit `allow` from a veto hook grants nothing on its own — it
      // only means this one hook did not object. The chain continues, and
      // after it the base port's own preflight still runs: the effective
      // decision is the AND of every check, never the OR.
      this.record(hook, "tool_preflight", "allow", `tool=${tool}`);
    }
    return null;
  }

  // --- observe: tool_audit / ledger_transition / phase ----------------

  /**
   * The lane that carries a WRITE'S PATH, which the post-execution audit path
   * structurally cannot: `NativeToolAuditRecord` is content-free by design
   * (`native-tools/contracts.ts` — "raw paths, argv, and scope ids never leave
   * the host"), and wrapping a repository tool's `execute` to reach the input
   * would fire `tool_audit` twice for one action. So this fires from the
   * tool-INPUT side instead, in `wrapToolPort`'s preflight, where
   * `request.input.path` is already what the tool is about to act on.
   *
   * PRE-FIRING, STATED HONESTLY. The deleted script was `PostToolUse`; this is
   * before the call executes, so a write that then fails is still recorded and
   * `.dirty` becomes "paths this session ATTEMPTED" — a superset of "paths this
   * session changed". That costs no fidelity here because BOTH readers
   * (`inject.vi-freshness`'s `dirty_count` and `inject.vi-graph-debt`'s debt
   * count) intersect `.dirty` with `git status`, so an entry for a write that
   * never landed intersects nothing. What `.dirty` uniquely adds over `git status` is
   * unchanged and is the whole reason it exists: it remembers a path that was
   * edited AND THEN COMMITTED, which `git status` cannot show.
   */
  private fireToolWrite(sessionId: string, tool: string, input: unknown): void {
    const path = FILE_WRITING_TOOLS.has(tool) ? boundedText(asRecord(input), "path", MAX_VETO_PATH_BYTES) : "";
    if (path === "") return;
    this.fireObserve("tool_write", sessionId, `${tool} ${path}`, { tool, path });
  }

  /** Subscribe as `repository_tools.on_audit`/an MCP tool audit sink — the existing post-execution observe seam. */
  observeToolAudit(record: NativeToolAuditRecord): void {
    this.fireObserve("tool_audit", record.session_id, `${record.tool} ${record.outcome}: ${record.summary}`, {
      tool: record.tool, outcome: record.outcome, code: record.code, effect: record.effect, risk: record.risk,
    });
  }

  /** Subscribe as (or alongside) `on_session_event` — the native session engine's own ledger-witnessed stream. */
  observeLedgerTransition(sessionId: string, event: SessionEvent): void {
    this.fireObserve("ledger_transition", sessionId, `ledger transition: ${event.kind}`, { kind: event.kind, sequence: String(event.sequence) });
  }

  /** Subscribe as a `LoopTelemetryPort`-style phase sink; real and tested, not yet wired to a live campaign loop (see handoff). */
  observePhase(campaignId: string, phase: string, outcome: string): void {
    this.fireObserve("phase", null, `phase ${phase}: ${outcome}`, { campaign_id: campaignId, phase, outcome });
  }

  /**
   * The per-turn boundary: the model produced a final result and the turn is
   * being offered for acceptance. Fired by `HookBus.observeTurnEnd` consumers
   * through the same two-row shape as every other async observe lane — the
   * firing row at the observation point, the settlement when it lands — so a
   * handler that runs a battery costs the turn nothing.
   *
   * It cannot deny, and a descriptor that tries is refused at catalog load;
   * see `HOOK_OBSERVE_EVENTS`'s comment for why the refusal is the worker's
   * `turn_gate` instead.
   */
  observeTurnEnd(sessionId: string | null, turn: number): void {
    this.fireObserve("turn_end", sessionId, `turn_end turn=${turn}`, { turn: String(turn) });
  }

  private fireObserve(event: HookObserveEvent, sessionId: string | null, summary: string, detail: Readonly<Record<string, string>>): void {
    const hooks = this.catalog.list().filter((hook) => hook.kind === "observe" && hook.event === event);
    const boundedSummary = redactNativeText(summary).slice(0, HOOK_MAX_NOTE_BYTES);
    // Redact and bound `detail` here, once, for every caller — the same
    // boundary discipline `vetoToolInput` applies to the veto payload. A
    // per-caller redaction policy is one a future caller forgets, and
    // `tool_write` proves the map carries text a plugin handler will read.
    const boundedDetail = Object.freeze(Object.fromEntries(
      Object.entries(detail).map(([key, value]) => [key, redactNativeText(value).slice(0, HOOK_MAX_DETAIL_VALUE_BYTES)]),
    ));
    for (const hook of hooks) {
      const entry = this.catalog.resolveHandler(hook.handler_ref);
      const context: HookObserveContext = Object.freeze({ event, hook_id: hook.hook_id, version: hook.version, session_id: sessionId, summary: boundedSummary, detail: boundedDetail });
      const outcome = this.runBounded((): unknown => {
        if (entry === undefined || (entry.kind !== "observe" && entry.kind !== "plugin")) throw new Error("hook handler is not a registered observe handler");
        return entry.handler(context);
      }, entry?.timeout_ms);
      if (!outcome.ok) { this.record(hook, event, "error", hookFailureRef(boundedSummary, outcome)); continue; }
      if (!isThenable(outcome.value)) {
        const note = observeNote(outcome.value);
        this.record(hook, event, "observed", note === undefined ? boundedSummary : `${boundedSummary} note=${note}`, observeDerivedFrom(outcome.value));
        continue;
      }
      // The host stream this lane subscribes to is synchronous — `on_audit`
      // and the session engine's `on_event` cannot be awaited — so the caller
      // cannot own the settlement and this method cannot become async
      // without either a queue or a promise nobody awaits, which is the same
      // F1 shape one level up. So the two facts are two rows: `pending=` is
      // written HERE, at the observation point, which is the evidence that
      // the handler was reached; the settlement is recorded when it lands,
      // bounded, with its own cause.
      this.record(hook, event, "observed", `${boundedSummary} pending=`);
      void this.settleObserve(hook, event, boundedSummary, outcome.value, entry?.timeout_ms);
    }
  }

  /** Records the outcome of an observe handler that returned a Promise. Never rejects: the bound is the only exit that is not the handler's own. */
  private async settleObserve(hook: ValidatedHook, event: HookObserveEvent, boundedSummary: string, pending: Promise<unknown>, declaredBoundMs: number | undefined): Promise<void> {
    const outcome = await this.runBoundedAsync(() => pending, declaredBoundMs);
    if (!outcome.ok) { this.record(hook, event, "error", hookFailureRef(`${boundedSummary} settled=`, outcome)); return; }
    const note = observeNote(outcome.value);
    this.record(hook, event, "observed", note === undefined ? `${boundedSummary} settled=` : `${boundedSummary} settled=note=${note}`, observeDerivedFrom(outcome.value));
  }

  // --- lifecycle: session_start (veto-capable) / everything else (observe) ---

  /**
   * Evaluate every declared `session_start` lifecycle hook. The native
   * executor calls this after composing the closed role/tool profile but
   * before constructing the model port; the command catalog uses the same
   * gate for operator-authored extension commands. A denial is therefore
   * recorded through the canonical session ledger without resolving provider
   * credentials or crossing the model boundary.
   */
  lifecycleSessionStart(input: { readonly session_id: string; readonly campaign_id: string; readonly node_id: string; readonly role?: string }): Readonly<{ allowed: true }> | Readonly<{ allowed: false; hook_id: string; reason: string }> {
    const hooks = this.catalog.list().filter((hook) => hook.kind === "lifecycle" && hook.event === HOOK_LIFECYCLE_VETO_EVENT);
    for (const hook of hooks) {
      const entry = this.catalog.resolveHandler(hook.handler_ref);
      const context: HookLifecycleContext = Object.freeze({ event: HOOK_LIFECYCLE_VETO_EVENT, hook_id: hook.hook_id, version: hook.version, session_id: input.session_id, campaign_id: input.campaign_id, node_id: input.node_id, role: input.role ?? null, outcome: null });
      if (entry?.kind === "lifecycle_observe") {
        const outcome = this.runBounded(() => entry.handler(context), entry.timeout_ms);
        if (!outcome.ok) { this.record(hook, HOOK_LIFECYCLE_VETO_EVENT, "error", hookFailureRef("session_start", outcome)); continue; }
        this.record(hook, HOOK_LIFECYCLE_VETO_EVENT, "observed", `session_start note=${observeNote(outcome.value) ?? "-"}`);
        continue;
      }
      const outcome = this.runBounded((): unknown => {
        // A "plugin" entry (ADR-111) bound to session_start is dispatched
        // through this deny-capable path unconditionally: the entry itself
        // does not distinguish start-vs-observe intent, and this bus fails
        // closed rather than guess, exactly as an invalid built-in decision
        // shape already does below.
        if (entry === undefined || (entry.kind !== "lifecycle_start" && entry.kind !== "plugin")) throw new Error("hook handler is not a registered lifecycle_start handler");
        return entry.handler(context);
      }, entry?.timeout_ms);
      if (!outcome.ok) {
        this.record(hook, HOOK_LIFECYCLE_VETO_EVENT, "error", hookFailureRef("session_start", outcome));
        return { allowed: false, hook_id: hook.hook_id, reason: `denied by hook ${hook.hook_id}@${hook.version}: ${outcome.message}` };
      }
      if (!isVetoDecision(outcome.value)) {
        this.record(hook, HOOK_LIFECYCLE_VETO_EVENT, "error", "session_start error=invalid_decision");
        return { allowed: false, hook_id: hook.hook_id, reason: `denied by hook ${hook.hook_id}@${hook.version}: handler returned an invalid decision` };
      }
      if (!outcome.value.allow) {
        this.record(hook, HOOK_LIFECYCLE_VETO_EVENT, "deny", "session_start");
        return { allowed: false, hook_id: hook.hook_id, reason: `denied by hook ${hook.hook_id}@${hook.version}: ${redactNativeText(outcome.value.reason).slice(0, HOOK_MAX_REASON_BYTES)}` };
      }
      this.record(hook, HOOK_LIFECYCLE_VETO_EVENT, "allow", "session_start");
    }
    return { allowed: true };
  }

  /** Observe-only firing for every lifecycle event except `session_start` (see `lifecycleSessionStart`). */
  lifecycleObserve(event: Exclude<HookLifecycleEvent, "session_start">, input: { readonly session_id: string; readonly campaign_id: string; readonly node_id: string | null; readonly role?: string; readonly outcome?: string }): void {
    const hooks = this.catalog.list().filter((hook) => hook.kind === "lifecycle" && hook.event === event);
    for (const hook of hooks) {
      const entry = this.catalog.resolveHandler(hook.handler_ref);
      const context: HookLifecycleContext = Object.freeze({ event, hook_id: hook.hook_id, version: hook.version, session_id: input.session_id, campaign_id: input.campaign_id, node_id: input.node_id, role: input.role ?? null, outcome: input.outcome ?? null });
      const outcome = this.runBounded((): unknown => {
        if (entry === undefined || (entry.kind !== "lifecycle_observe" && entry.kind !== "plugin")) throw new Error("hook handler is not a registered lifecycle observe handler");
        return entry.handler(context);
      }, entry?.timeout_ms);
      if (!outcome.ok) { this.record(hook, event, "error", hookFailureRef(event, outcome)); continue; }
      this.record(hook, event, "observed", `${event} note=${observeNote(outcome.value) ?? "-"}`);
    }
  }

  // --- inject: tropism proposal -> validated, bounded prompt text (proposal §5) ---

  /**
   * The model-facing injection lane. Validates every proposed tropism,
   * drops anything whose derivation has not changed, and returns the
   * composed, byte-bounded scope for the caller to thread into prompt
   * composition. The policy lives in `TropismInjector`; this method is the
   * composition that gives it this bus's timing and ledger.
   *
   * It is `async` because `HookInjectHandler` declares a Promise arm and the
   * caller needs the tropism in the scope it returns. A handler that
   * returns a Promise is dispatched and awaited under a real bound: the
   * previous synchronous measurement took ~0 ms on a Promise, passed the
   * bound, and then had the Promise itself refused by `validateTropism` —
   * so every I/O-backed inject handler was unreachable and read in the
   * ledger exactly like a handler with nothing to say.
   *
   * It returns a *scope* rather than mutating a session, because this bus
   * holds no context manager and the `boundedHistory` mechanism would drop
   * an appended, uncited entry before it reached the model anyway.
   */
  async injectForSession(event: HookLifecycleEvent, input: { readonly session_id: string; readonly campaign_id: string; readonly node_id: string | null; readonly role?: string | null; readonly outcome?: string | null; readonly turn: number }): Promise<TropismScope> {
    return this.injector.inject(event, Object.freeze({
      event, hook_id: "", version: "", session_id: input.session_id, campaign_id: input.campaign_id,
      node_id: input.node_id, role: input.role ?? null, outcome: input.outcome ?? null, turn: input.turn,
    }), (fn, declaredBoundMs) => this.runBoundedAsync(fn, declaredBoundMs));
  }

  /**
   * The per-turn half of the same lane, and the model-facing text two devolved
   * hooks needed. `evidence-staleness` and `vi-graph-debt` were both MODEL-FACING
   * prose in the shell — the one was `additionalContext` on a PostToolUse call,
   * the other `hookSpecificOutput` text at Stop — and the observe lane's
   * `HookObserveOutcome` has no field that reaches a model at all. As ledger
   * notes they were readable by exactly one caller (`hookInvocations()`), which
   * had no production caller of its own.
   *
   * It is the SAME `TropismInjector`, so §5.3's lints, the byte budget, the TTL
   * and `claim()` dedupe apply unchanged — which is what makes a PER-TURN lane
   * affordable at all: a finding whose derivation did not move is not
   * re-injected.
   *
   * It AWAITS the handler, under the handler's own declared `timeout_ms`,
   * because an inject's product is text rather than a ledger note. That is the
   * one behavioural difference from `observeTurnEnd`, which cannot await: an
   * observe handler's settlement is a record nobody reads this turn, while
   * this one is prompt text for the next. An overrun is therefore a NAMED
   * dropped state recorded as `error=hook_timeout_exceeded` plus an empty
   * scope — never silence, and never an exception thrown at the turn boundary.
   *
   * It is NOT a "session" scope: the returned scope belongs to the NEXT turn's
   * prompt, and the caller (the turn loop) is what carries it there. The
   * context carries `campaign_id: null` because a per-turn boundary knows the
   * session and the turn and nothing else.
   */
  async injectTurnEnd(input: { readonly session_id: string; readonly turn: number }): Promise<TropismScope> {
    return this.injector.inject("turn_end", Object.freeze({
      event: "turn_end", hook_id: "", version: "", session_id: input.session_id, campaign_id: null,
      node_id: null, role: null, outcome: null, turn: input.turn,
    }), (fn, declaredBoundMs) => this.runBoundedAsync(fn, declaredBoundMs));
  }

  // --- shared bounds/ledger --------------------------------------------

  /**
   * Runs `fn` and classifies its outcome as fail-closed input for the
   * caller: a thrown error or a measured wall-clock overrun both become a
   * typed failure. A single-threaded runtime cannot preempt a running
   * synchronous handler, so the timeout check is necessarily measured after
   * the call returns, not a true cancellation — every handler this bus
   * dispatches synchronously is a bounded, revoy2-owned in-process function,
   * so this is a real, if honestly limited, bound rather than a race
   * against untrusted code.
   *
   * `declaredBoundMs` is the handler's own `timeout_ms`; the bus-wide
   * default applies when it is absent or malformed.
   */
  private runBounded<T>(fn: () => T, declaredBoundMs?: number): BoundedOutcome<T> {
    const boundMs = this.boundMs(declaredBoundMs);
    const start = this.clock.now();
    try {
      const value = fn();
      const elapsed = this.clock.now() - start;
      if (elapsed > boundMs) return { ok: false, code: "hook_timeout_exceeded", message: `hook exceeded its ${boundMs} ms bound (${elapsed} ms)`, bound_ms: boundMs };
      return { ok: true, value };
    } catch (error) {
      return { ok: false, code: "hook_handler_failed", message: redactNativeText(error instanceof Error ? error.message : "hook handler threw a non-Error value").slice(0, HOOK_MAX_REASON_BYTES), bound_ms: boundMs };
    }
  }

  /**
   * The same classification for a handler that may return a Promise, raced
   * against a real timer.
   *
   * This is the bound's whole point on the `inject` and `observe` lanes: a
   * handler declared `Promise<Tropism | null>` and dispatched without an
   * `await` measured ~0 ms, passed, and then handed a Promise to a validator
   * that refused it as malformed — so an I/O-backed handler was not slow, it
   * was unreachable, and it read in the ledger exactly like a handler that
   * had nothing to say.
   *
   * The timer and the post-hoc elapsed check are both required, and they
   * catch disjoint cases. The timer bounds a handler that actually yields.
   * It cannot bound one that does NOT: a single-threaded runtime will not
   * run a timer callback while a synchronous handler is still on the stack,
   * so the timer is still pending when that handler resolves and the race is
   * already won. The elapsed check is what catches that one, and it is the
   * same after-the-fact measurement `runBounded` has always made — which is
   * why a slow synchronous handler is refused here exactly as it was before.
   * The timer is cleared in `finally` and both race participants are
   * handled, so this never leaves a timer behind or an unhandled rejection.
   *
   * `Promise.resolve().then(fn)` rather than a bare `fn()` call, so a
   * synchronous throw and an asynchronous rejection reach one `catch`.
   */
  private async runBoundedAsync<T>(fn: () => T | Promise<T>, declaredBoundMs?: number): Promise<BoundedOutcome<T>> {
    const boundMs = this.boundMs(declaredBoundMs);
    const start = this.clock.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        Promise.resolve().then(fn),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new HookBoundExceeded()), boundMs); }),
      ]);
      const elapsed = this.clock.now() - start;
      if (elapsed > boundMs) return { ok: false, code: "hook_timeout_exceeded", message: `hook exceeded its ${boundMs} ms bound (${elapsed} ms)`, bound_ms: boundMs };
      return { ok: true, value };
    } catch (error) {
      if (error instanceof HookBoundExceeded) return { ok: false, code: "hook_timeout_exceeded", message: `hook exceeded its ${boundMs} ms bound`, bound_ms: boundMs };
      return { ok: false, code: "hook_handler_failed", message: redactNativeText(error instanceof Error ? error.message : "hook handler threw a non-Error value").slice(0, HOOK_MAX_REASON_BYTES), bound_ms: boundMs };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** The handler's declared bound when it is a usable one, else the bus-wide default — the tighter line is the safe direction. */
  private boundMs(declaredBoundMs: number | undefined): number {
    return declaredBoundMs !== undefined && Number.isFinite(declaredBoundMs) && declaredBoundMs > 0 ? declaredBoundMs : this.timeoutMs;
  }

  private record(hook: ValidatedHook, event: HookEvent, decision: HookFiredRecord["decision"], evidenceRef: string, derivedFrom?: readonly string[]): void {
    this.firedHookIdentities.add(identity(hook.hook_id, hook.version));
    const record: HookFiredRecord = Object.freeze({
      hook_id: hook.hook_id, version: hook.version, kind: hook.kind, event, decision,
      evidence_ref: redactNativeText(evidenceRef).slice(0, HOOK_MAX_NOTE_BYTES),
      at: new Date(this.clock.now()).toISOString(),
      ...(derivedFrom === undefined ? {} : { derived_from: Object.freeze([...derivedFrom].map((source) => redactNativeText(source).slice(0, HOOK_MAX_REASON_BYTES))) }),
    });
    this.ledgerEntries.push(record);
    if (this.ledgerEntries.length > this.maxLedger) this.ledgerEntries.splice(0, this.ledgerEntries.length - this.maxLedger);
    this.onFired?.(record);
  }
}

function denial(hook: ValidatedHook, code: "hook_denied" | "hook_veto_failed", reason: string): NativeToolPreflightResult {
  const boundedReason = `denied by hook ${hook.hook_id}@${hook.version}: ${redactNativeText(reason).slice(0, HOOK_MAX_REASON_BYTES)}`;
  // The typed remedy travels with the denial so the worker can hand it to the
  // actor it names: the model for a policy veto, the runtime host for a
  // handler failure (which the worker keeps terminal).
  return Object.freeze({ allowed: false, code, reason: boundedReason, evidence: refusedEvidence(code), remedy: projectToolVeto(code, boundedReason) });
}

function refusedEvidence(code: string): NativeToolExecutionEvidence {
  return Object.freeze({ outcome: "refused", stage: "audit", code, effect: "none", action_scope: NO_ACTION_SCOPE });
}

function isVetoDecision(value: unknown): value is HookVetoDecision {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.allow === true || (record.allow === false && typeof record.reason === "string" && record.reason.trim().length > 0);
}

function observeNote(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const note = (value as Record<string, unknown>).note;
  return typeof note === "string" && note.trim().length > 0 ? redactNativeText(note).slice(0, HOOK_MAX_NOTE_BYTES) : undefined;
}

/**
 * A handler-declared derivation for its ledger row, or `undefined` when it
 * declared none or declared something unusable.
 *
 * A non-array, an empty array, or an entry that is not a non-empty string is
 * dropped rather than recorded: the field's whole claim is "these are the
 * hashes this body is a function of", and a row carrying `[null]` or `[""]`
 * would assert a derivation nothing established — the fixed-verdict shape this
 * field exists to make visible. Redaction and bounding happen in `record`.
 */
function observeDerivedFrom(value: unknown): readonly string[] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const declared = (value as Record<string, unknown>).derived_from;
  if (!Array.isArray(declared) || declared.length === 0) return undefined;
  const sources = declared.filter((source): source is string => typeof source === "string" && source.trim() !== "");
  return sources.length === declared.length ? Object.freeze(sources) : undefined;
}

function isThenable(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

/** The `Promise.race` sentinel. A distinct class so a handler that throws its own value is never read as an overrun. */
class HookBoundExceeded extends Error {}

const NO_TOOL_INPUT: HookVetoToolInput = Object.freeze({ command: "", path: "", added_text: "", removed_text: "" });
/**
 * Only these two tools can reach a `git` binary at all, so they are the only
 * ones whose input carries a command. Any other tool reports an empty
 * command even if its payload happens to have a `command` key — a
 * `file.write` must never be judged by a git-write rule.
 */
const COMMAND_CARRYING_TOOLS: ReadonlySet<string> = new Set(["shell.execute", "verification.run"]);
/**
 * The two tools that write repository bytes, and so the only ones whose input
 * carries a path or a diff. A file-writing guard is otherwise inexpressible:
 * before this set existed, `vetoToolInput` short-circuited to
 * `NO_TOOL_INPUT` for both, and a handler had no path to test and no text to
 * search.
 */
const FILE_WRITING_TOOLS: ReadonlySet<string> = new Set(["file.write", "file.patch"]);
const MAX_VETO_COMMAND_BYTES = 4096;
/**
 * The bus-wide DEFAULT for a file tool's text, a quarter of the command bound.
 *
 * It is the right line for a guard that decides on a PREFIX or on a short
 * window near the start of a body, and the wrong one for a guard that searches
 * a body for a marker anywhere in it: a head slice that happens to fall short
 * of the marker converts a refusal into a SILENT ALLOW, which is the one
 * direction a guard's bound must never fail. So it is a default rather than a
 * ceiling — `HookHandlerEntry.text_bytes` lets a handler state what the tool
 * itself will admit (see `CLAIM_TEXT_BOUND_BYTES`), and the bus honours it.
 *
 * 1024 UTF-16 code units is two to the field's share of the 512-byte deny
 * reason (`HOOK_MAX_REASON_BYTES`) plus a header, and an eighth of what a
 * command costs. Truncation is a plain head slice, exactly as `command` is, so
 * a handler can see that a field is a head and not mistake it for the whole.
 */
const MAX_VETO_TEXT_BYTES = 1024;
/**
 * The same bound the file tools already enforce on their own `path` field
 * (`stringField(value, "path", 1, 1_024)`), so the bus never truncates a path
 * the tool would have accepted. A tool that bounds its path differently, or
 * not at all, is clamped here rather than trusted.
 */
const MAX_VETO_PATH_BYTES = 1024;

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : undefined;
}

/**
 * A field the bus could not read is `""`, never a throw and never an error —
 * the whole of the bus's tolerance policy, and the answer to what a malformed
 * payload should do.
 *
 * It is fail-OPEN, deliberately. The bus fails closed at `runVetoChain` for a
 * handler that throws, overruns, or returns an invalid decision; that rule
 * governs what a handler decided, and a context the bus could not fully build
 * is not a handler decision. Denying here would also misattribute: the ledger
 * row and the operator-facing reason would name the HOOK for a call the hook
 * never got to judge, and it would make an unreadable optional field on a
 * perfectly ordinary write indistinguishable from a real policy violation —
 * a trap with no way out, since the one lever a guard has (`path !== ""`)
 * would be the thing the bus had already consumed. So an unreadable field
 * yields the empty sentinel, and a guard that needs that field is required to
 * treat `""` as "cannot prove" and allow, never as "suspicious".
 */
function boundedText(record: Record<string, unknown> | undefined, name: string, limit: number): string {
  const value = record === undefined ? undefined : record[name];
  return typeof value === "string" ? redactNativeText(value).slice(0, limit) : "";
}

/**
 * The command, from either host shape: the native shell tool takes an argv
 * array while a Claude-Code-shaped host takes a single `command` string, and a
 * guard that only understood one of them would be a guard with a hole in it.
 * A present `command` wins, so widening the context cannot change which of
 * two present forms a shell guard reads.
 */
function commandText(record: Record<string, unknown> | undefined): string {
  const direct = record === undefined ? undefined : record.command;
  if (typeof direct === "string") return direct;
  const argv = record === undefined ? undefined : record.argv;
  return Array.isArray(argv) && argv.every((argument): argument is string => typeof argument === "string") ? argv.join(" ") : "";
}

/**
 * Reduce a call's payload to the bounded, redacted fields a veto handler may
 * read, here rather than in the handler: the bus is the boundary that
 * redacts, so a plugin or a future built-in cannot skip it. The mapping is the
 * NATIVE file tools' own schema, not a host-shaped one — `file.write`
 * carries a whole `content`, `file.patch` a located `expected` span plus its
 * `replacement` — so a guard written against these fields matches what the
 * tool will actually do. `""` in every field is the one shared sentinel,
 * returned whenever the tool carries nothing readable.
 *
 * `declaredTextBytes` is the calling hook's own `text_bytes`, honoured per hook
 * because the chain builds the context inside its loop: a guard that searches a
 * body for a marker needs the whole body, and a global bound small enough for
 * the cheapest guard is a bound that silently un-guards the strictest one.
 */
function vetoToolInput(tool: string, input: unknown, declaredTextBytes?: number): HookVetoToolInput {
  const textBytes = declaredTextBytes !== undefined && Number.isFinite(declaredTextBytes) && declaredTextBytes > 0 ? Math.floor(declaredTextBytes) : MAX_VETO_TEXT_BYTES;
  const record = asRecord(input);
  const command = COMMAND_CARRYING_TOOLS.has(tool) ? commandText(record) : "";
  const path = FILE_WRITING_TOOLS.has(tool) ? boundedText(record, "path", MAX_VETO_PATH_BYTES) : "";
  const added = FILE_WRITING_TOOLS.has(tool) ? boundedText(record, tool === "file.write" ? "content" : "replacement", textBytes) : "";
  const removed = tool === "file.patch" ? boundedText(record, "expected", textBytes) : "";
  if (command === "" && path === "" && added === "" && removed === "") return NO_TOOL_INPUT;
  return Object.freeze({
    command: redactNativeText(command).slice(0, MAX_VETO_COMMAND_BYTES),
    path,
    added_text: added,
    removed_text: removed,
  });
}

function identity(hookId: string, version: string): string { return `${hookId}\u0000${version}`; }
