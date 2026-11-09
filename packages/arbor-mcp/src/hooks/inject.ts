/**
 * The `inject` dispatch surface (proposal §5) — split out of `bus.ts` so
 * that file stays one thing (the four hook dispatch surfaces and their
 * shared bounds/ledger) rather than two.
 *
 * This is the only code path in the plane that can put harness state in
 * front of a model, so it is the narrowest by construction:
 *
 *   - a handler *proposes* a `Tropism`; it never asserts one. The catalog
 *     applies §5.3's two lints and the shape/bound checks, and a refused
 *     tropism is dropped without the model ever being told anything.
 *   - the result is returned as a bounded prompt *scope*, never pushed into
 *     a context manager. `boundedHistory`
 *     (`packages/arbor-harness/src/native-worker.ts`) drops any context
 *     entry a conversation entry does not cite and renders cited text only
 *     through `sources[0].text`, so an appended, uncited fact never reaches
 *     the model. Prompt text is the path that is proven to arrive.
 *   - §5.3 rule 2 ("derived, never constant") is enforced here by a
 *     per-session claim on each derivation, which is what keeps a per-turn
 *     trigger from becoming a per-turn prompt tax.
 *
 * It holds no deny capability of any kind: nothing in this file can refuse
 * a tool call, start or stop a session, or grant authority.
 */
import { resolveTropisms, type Tropism, type TropismScope } from "@arbor/prompts";
import type { HookCatalog } from "./catalog.js";
import type { HookFiredRecord } from "./bus.js";
import { hookFailureRef, type BoundedOutcome, type HookEvent, type HookInjectContext, type HookInjectEvent, type ValidatedHook } from "./contracts.js";

/** An unconfigured lane renders nothing rather than failing; mirrors `EMPTY_SCOPE` in `@arbor/prompts`' `repo-instructions`. */
const EMPTY_TROPISM_SCOPE: TropismScope = Object.freeze({ source_paths: Object.freeze([]), content: "", truncated: false });

/**
 * Bounds the per-session derivation-claim map so a long session with a
 * chatty hook cannot grow the bus without limit. Eviction is oldest-first
 * and only ever costs a re-render, never a correctness failure.
 */
const MAX_CLAIMED_DERIVATIONS = 512;

/**
 * Identity of one *derivation*, for §5.3 rule 2. Keyed on the tropism's
 * identity as well as its event hashes on purpose: two different tropisms
 * legitimately derived from the same ring event carry different text and
 * must both render, whereas the same tropism over the same derivation is
 * the duplicate the rule exists to suppress.
 */
function fingerprint(tropism: Tropism): string {
  return `${tropism.id}\u0000${[...tropism.derived_from].sort().join(",")}`;
}

export class TropismInjector {
  private readonly claims = new Map<string, Map<string, number>>();

  constructor(
    private readonly catalog: HookCatalog,
    private readonly emit: (hook: ValidatedHook, event: HookEvent, decision: HookFiredRecord["decision"], evidenceRef: string, derivedFrom?: readonly string[]) => void,
  ) {}

  /**
   * Fire every `inject` hook declared for `event` and return the composed,
   * byte-bounded scope for the caller to thread into prompt composition.
   * `runBoundedAsync` is the bus's own wall-clock/fail-closed wrapper,
   * passed in rather than reimplemented so one timing policy governs every
   * handler in this bus — and so this lane can AWAIT a handler that declared
   * the Promise arm its own contract already permitted. It did not, and the
   * cost was total: a handler returning `Promise<Tropism>` measured ~0 ms,
   * passed the bound, and had the Promise refused by `validateTropism` as
   * `tropism_malformed`. An I/O-backed handler was not slow, it was
   * unreachable, and its ledger row named a malformed value rather than the
   * handler's silence.
   *
   * The second argument is the handler's own declared bound, forwarded
   * untouched: resolving it against the bus-wide default is the bus's policy,
   * not this surface's.
   */
  async inject(event: HookInjectEvent, context: HookInjectContext, runBounded: (fn: () => unknown, declaredBoundMs?: number) => Promise<BoundedOutcome<unknown>>): Promise<TropismScope> {
    const hooks = this.catalog.list().filter((hook) => hook.kind === "inject" && hook.event === event);
    if (hooks.length === 0) return EMPTY_TROPISM_SCOPE;
    const rendered: Tropism[] = [];
    for (const hook of hooks) {
      const entry = this.catalog.resolveHandler(hook.handler_ref);
      const outcome = await runBounded((): unknown => {
        if (entry === undefined || entry.kind !== "inject") throw new Error("hook handler is not a registered inject handler");
        return entry.handler(Object.freeze({ ...context, hook_id: hook.hook_id, version: hook.version }));
      }, entry?.timeout_ms);
      if (!outcome.ok) { this.emit(hook, event, "error", hookFailureRef(event, outcome)); continue; }
      if (outcome.value === null || outcome.value === undefined) { this.emit(hook, event, "observed", `${event} note=-`); continue; }
      const diagnostic = this.catalog.validateTropism(outcome.value);
      if (diagnostic !== null) { this.emit(hook, event, "error", `${event} refused=${diagnostic.code}`); continue; }
      const tropism = outcome.value as Tropism;
      if (!this.claim(context.session_id, tropism, context.turn)) {
        this.emit(hook, event, "observed", `${event} deduped=${tropism.id}`, tropism.derived_from);
        continue;
      }
      rendered.push(tropism);
      this.emit(hook, event, "observed", `${event} injected=${tropism.id} lane=${tropism.lane}`, tropism.derived_from);
    }
    return resolveTropisms(rendered);
  }

  /**
   * §5.3 rule 2. True when this derivation has not been injected yet
   * inside its own `expires_after_turns` window. Once the window closes
   * the claim is released, so a *new* derivation still renders immediately
   * while a *stale* one cannot be resurrected by re-firing the same
   * trigger.
   */
  private claim(sessionId: string, tropism: Tropism, turn: number): boolean {
    const claims = this.claims.get(sessionId) ?? new Map<string, number>();
    this.claims.set(sessionId, claims);
    const key = fingerprint(tropism);
    const claimedAt = claims.get(key);
    if (claimedAt !== undefined) {
      if (turn - claimedAt < tropism.expires_after_turns) return false;
      claims.delete(key);
    }
    claims.set(key, turn);
    if (claims.size > MAX_CLAIMED_DERIVATIONS) {
      const oldest = claims.keys().next();
      if (!oldest.done) claims.delete(oldest.value);
    }
    return true;
  }
}
