/**
 * Governed hook catalog — mirrors `packages/arbor-mcp/src/skills/catalog.ts`
 * wholesale (roadmap 06 §1): immutable frozen descriptors, filename identity,
 * a load-time reduction check, and bounded diagnostics for anything that
 * fails to validate. A hook descriptor never carries executable code; it
 * only names a `handler_ref` from the closed registry in `handlers.ts`.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { basename, join } from "node:path";
import { redactNativeText } from "@arbor/harness";
import { TROPISM_BYTE_BUDGET } from "@arbor/prompts";
import type { PluginTrustTier } from "../extensibility/plugin-manifest.js";
import { HOOK_HANDLERS } from "./handlers.js";
import {
  HOOK_LIFECYCLE_VETO_EVENT,
  HOOK_LIFECYCLE_EVENTS,
  HOOK_INJECT_EVENTS,
  HOOK_MAX_DESCRIPTORS,
  HOOK_MAX_DESCRIPTOR_BYTES,
  HOOK_MAX_WHY_BYTES,
  HOOK_OBSERVE_EVENTS,
  HOOK_SCHEMA_VERSION,
  HOOK_VETO_EVENTS,
  HookCatalogError,
  type HookCatalogDiagnostic,
  type HookDescriptor,
  type HookEvent,
  type HookHandlerRegistry,
  type HookKind,
  type ValidatedHook,
} from "./contracts.js";

/**
 * Proposal §5.3's two lints, as catalog diagnostics. `HookCatalog` is the
 * only place that knows which enforcement surfaces are *declared*, so a
 * `CODE` tropism's claim to be enforced can only be checked here — and it
 * has to be checked here rather than trusted, because the handler that
 * wrote the tropism is the very thing that would benefit from the claim
 * going unexamined.
 */
export type HookTropismDiagnosticCode = "advisory_imperative" | "code_unenforced" | "tropism_malformed" | "tropism_bound";

export interface HookTropismDiagnostic { readonly code: HookTropismDiagnosticCode; readonly message: string; }

/**
 * §5.3 rule 1: a tropism that *asks for behaviour* must be `CODE`, and an
 * `ADVISORY` one may not. The match is deliberately blunt and anchored to
 * the first token — a false positive costs a handler author one rewrite,
 * while a false negative silently turns advisory context into an
 * instruction the plane does not enforce, which is the whole failure this
 * rule exists to prevent.
 */
const IMPERATIVE_LEAD = /^(?:must|shall|should|never|always|do[\s-]not|don['’]t)\b/i;

/** Bounded identity for a tropism's `id`/`trigger`, matching the descriptor's own identity discipline. */
const HOOK_MAX_TROPISM_ID_BYTES = 128;

/** One default hook's materialized descriptor filename and exact JSON bytes. */
export interface DefaultHookDescriptor { readonly filename: string; readonly contents: string; }

/**
 * The documented default hook set (WA-43/J3-23), plus the four descriptors
 * that activate the native replacements for the host hooks deleted in
 * 2c133efb/64bb2ce8. A project enrollment/repair step materializes these
 * into `.arbor/hooks/` only when the identity is absent, mirroring how
 * `.arbor/commands` is seeded (see `project-lifecycle.ts`).
 *
 * WHY THE FOUR GOVERNANCE ROWS ARE HERE AND NOT OPTIONAL. A key in
 * `HOOK_HANDLERS` makes a handler SELECTABLE; only a descriptor naming it
 * ACTIVATES it, and `HookBus.wrapToolPort` returns the tool port unchanged
 * when zero veto hooks are declared (`bus.ts`) — a veto that never wraps is
 * indistinguishable from one that approved everything. Those four host hooks
 * were deleted in favour of handlers that were in the registry and inert,
 * because no descriptor anywhere named them: `arbor hook validate` reported
 * "All hook descriptors are valid." over an empty set and exited 0. Shipping
 * a registry entry alone is exactly how that happened, so each replacement
 * ships with the descriptor that makes it fire.
 */
const DEFAULT_HOOK_SET: readonly HookDescriptor[] = Object.freeze([
  Object.freeze({
    schema_version: 1, hook_id: "plan-confirm-notifier", version: "1.0.0", kind: "lifecycle", event: "plan_confirm",
    handler_ref: "lifecycle.session-boundary-notes",
    why: "Notify operators whenever a plan is confirmed, before campaign admission (roadmap 06 default hook set).",
  }),
  Object.freeze({
    schema_version: 1, hook_id: "tool-execute-audit-log", version: "1.0.0", kind: "observe", event: "tool_audit",
    handler_ref: "observe.tool-audit-notes",
    why: "Record an audit-log note for every tool execution the native session observes (roadmap 06 default hook set).",
  }),
  Object.freeze({
    schema_version: 1, hook_id: "subagent-git-write-guard", version: "1.0.0", kind: "veto", event: "tool_preflight",
    handler_ref: "veto.git-write-guard",
    why: "Replace scripts/hooks/git-write-guard.sh (deleted in 64bb2ce8): refuse a forbidden git write issued from subagent context. It exists because registration in the closed handler registry is not activation — without this descriptor the veto is never dispatched and the guard is enforced nowhere.",
  }),
  Object.freeze({
    schema_version: 1, hook_id: "session-governance-orient", version: "1.0.0", kind: "inject", event: "session_start",
    handler_ref: "inject.governance-orient",
    why: "Replace scripts/hooks/governance-orientation.sh (deleted in 2c133efb): inject the ordering index plus live repository posture before the session's first model action. It exists because a handler in HOOK_HANDLERS is only selectable; this descriptor is what makes the inject lane fire it.",
  }),
  Object.freeze({
    schema_version: 1, hook_id: "session-isolation-report", version: "1.0.0", kind: "inject", event: "session_start",
    handler_ref: "inject.session-isolation",
    why: "Replace scripts/hooks/session-isolation.sh (deleted in 2c133efb): inject whether this checkout is shared and what is already uncommitted in it. Observe-only by design, and activated by this descriptor rather than by its registry entry alone.",
  }),
  Object.freeze({
    schema_version: 1, hook_id: "session-owed-decisions", version: "1.0.0", kind: "inject", event: "session_start",
    handler_ref: "inject.owed-decisions",
    why: "Replace scripts/hooks/adr-proposed-flag.sh (deleted in 2c133efb): inject the queue of Proposed or Draft ADRs awaiting a definitive operator decision. It exists because a tropism nothing dispatches is a tropism the model never reads.",
  }),
  Object.freeze({
    schema_version: 1, hook_id: "vi-readonly-guard", version: "1.0.0", kind: "veto", event: "tool_preflight",
    handler_ref: "veto.vi-readonly-guard",
    why: "Replace .claude/skills/repository-visual-intelligence/hooks/vi-readonly-guard.sh: while a .visual-intelligence run is armed, refuse a hand-edit outside .visual-intelligence/. It ships with this descriptor because a registry entry only makes the guard selectable, and this is what makes it refuse.",
  }),
  Object.freeze({
    schema_version: 1, hook_id: "claim-completeness-guard", version: "1.0.0", kind: "veto", event: "tool_preflight",
    handler_ref: "veto.claim-completeness-guard",
    why: "Replace .claim-ledger/claim-guard.sh: refuse an edit that adds a completeness marker to ROADMAP.md, decisions/README.md or an ADR with no proof comment in the same change. A nudge at the moment of writing; gate:claim-ledger remains the fail-closed authority over the whole tree.",
  }),
  Object.freeze({
    schema_version: 1, hook_id: "session-graph-freshness", version: "1.0.0", kind: "inject", event: "session_start",
    handler_ref: "inject.vi-freshness",
    why: "Replace .claude/skills/repository-visual-intelligence/hooks/vi-freshness.sh: report how far the committed graph trails HEAD, and whether the drift touched the graphed domain. It reads the .dirty the vi-dirty-tracker descriptor writes, and it is SILENT in three of its five verdicts (no manifest, CURRENT, and a STALE that missed packages/+decisions/) — so without this descriptor a repository whose graph had been quietly stale for weeks would report nothing at all, which is indistinguishable from a healthy one.",
  }),
  Object.freeze({
    schema_version: 1, hook_id: "vi-dirty-tracker", version: "1.0.0", kind: "observe", event: "tool_write",
    handler_ref: "observe.vi-dirty-tracker",
    why: "Replace .claude/skills/repository-visual-intelligence/hooks/vi-dirty-track.sh: append every repo-relative path this session writes to .visual-intelligence/.dirty, deduped. It is the SOLE writer of the file that remembers a path edited AND THEN COMMITTED, which git status cannot show, so without this descriptor vi-freshness and vi-graph-debt would read a file nothing maintains and report clean forever.",
  }),
  Object.freeze({
    schema_version: 1, hook_id: "vi-graph-debt", version: "1.0.0", kind: "inject", event: "turn_end",
    handler_ref: "inject.vi-graph-debt",
    why: "Replace .claude/skills/repository-visual-intelligence/hooks/vi-graph-debt.sh: on every turn boundary, report how much graph debt this session has accrued — the UNSCOPED .dirty ∩ git status intersection, sampled to five paths. The `turn_end` INJECT lane is what preserves its product: the deleted hook printed its prose to stdout at Stop time and the host fed that to the MODEL, so as an observe handler it became a ledger row whose only reader had no production caller. It reads the file the vi-dirty-tracker descriptor writes, and it is SILENT whenever that intersection is empty, so without this descriptor a repository carrying days of unrefreshed graph debt reports nothing, which is indistinguishable from a clean one. Advisory only — a Tropism carries no decision field, so this cannot refuse a turn or grant anything.",
  }),
Object.freeze({
    schema_version: 1, hook_id: "stop-battery", version: "1.0.0", kind: "observe", event: "turn_end",
    handler_ref: "observe.stop-battery",
    why: "Replace scripts/hooks/gate-stop.sh (deleted here): measure the stop-tier gate battery at the turn boundary, and cache the verdict against what it measured. It exists because ADR-074's end condition had no native producer at all — the shell was the only enforcement, so a native session enforced nothing. The MEASUREMENT is here and the REFUSAL is the worker's turn_gate; this descriptor is what starts the measurement, and without it the battery is never measured and every turn is deferred.",
  }),
  Object.freeze({
    schema_version: 1, hook_id: "repo-session-open", version: "1.0.0", kind: "inject", event: "session_start",
    handler_ref: "inject.repo-session-open",
    why: "Replace scripts/hooks/session-close-start.sh and the Codex SessionStart adapter (both deleted here): open this checkout's durable repository-session record and tell the model what the deferral costs. It exists because ADR-160's deferral is only enforced when a record exists — without this descriptor a native session commits freely and the close has nothing to bind the evidence stores to.",
  }),
  Object.freeze({
    schema_version: 1, hook_id: "repo-session-end", version: "1.0.0", kind: "lifecycle", event: "session_end",
    handler_ref: "lifecycle.repo-session-end",
    why: "Replace scripts/hooks/session-close-end.sh and the Codex SessionEnd adapter (both deleted here): record that the repository session ended and what it left unfinished, so a window opened and never closed is provably stranded and can be retired. It is observe-only on session_end by construction — the close is a manual action, and a handler that could finish from here would run an eight-minute rebind under a three-second host timeout.",
  }),
  Object.freeze({
    schema_version: 1, hook_id: "session-operator-decision-queue", version: "1.0.0", kind: "inject", event: "session_start",
    handler_ref: "inject.operator-decision-queue",
    why: "Replace scripts/hooks/codex-decision-interview-session-start.mjs (deleted here): inject every uncovered decision that is the OPERATOR's alone — proposed records, operator decisions, operator disposal calls — plus any governance hazard, before the session's first model action. It renders `scripts/decision-queue.mjs`'s own report rather than re-deriving the queue, because a second derivation of what gate:decision-queue enforces would drift silently, in the direction where an owed interview is simply not mentioned. It reads and renders only: it cannot write the interview ledger, record coverage, or answer for the operator. This descriptor is what makes it fire — a registry entry only makes the handler selectable.",
  }),
  Object.freeze({
    schema_version: 1, hook_id: "evidence-staleness", version: "1.0.0", kind: "inject", event: "turn_end",
    handler_ref: "inject.evidence-staleness",
    why: "Replace scripts/hooks/evidence-staleness-nudge.sh (deleted here): on every turn boundary, say so when a commit touching packages/ or decisions/ has just gone in AND the four evidence stores are stale, so the rebind is run once for the whole series instead of surfacing later inside a 17-gate battery. The `turn_end` INJECT lane is what preserves its product: the deleted hook's whole output was model-facing additionalContext, which an observe note is not. Advisory only — the tropism carries no decision field, so nothing is enforced here that was not already enforced, and gate:store-freshness still blocks the push. Without this descriptor the nudge would not be a quiet nudge but an absent one, which reads as a repository with nothing stale.",
  }),
]);

export const DEFAULT_HOOK_DESCRIPTORS: readonly DefaultHookDescriptor[] = Object.freeze(
  DEFAULT_HOOK_SET.map((descriptor) => Object.freeze({
    filename: `${descriptor.hook_id}@${descriptor.version}.json`,
    contents: `${JSON.stringify(descriptor, null, 2)}\n`,
  })),
);

export interface HookCatalogOptions {
  /** Defaults to the production registry; tests may inject a superset that adds test-only handlers. */
  readonly handlers?: HookHandlerRegistry;
}

export class HookCatalog {
  private readonly hooks = new Map<string, ValidatedHook>();
  private readonly activation = new Map<string, () => boolean>();
  private readonly owners = new Map<string, string>();
  private readonly failures: HookCatalogDiagnostic[] = [];
  private handlers: HookHandlerRegistry;

  constructor(options: HookCatalogOptions = {}) {
    this.handlers = options.handlers ?? HOOK_HANDLERS;
  }

  /**
   * Admit a plugin's own exported hook handlers (ADR-111 decision 1) into
   * this catalog's resolution registry, so a subsequently-registered hook
   * descriptor's `handler_ref` can name one. Every entry must be a
   * `"plugin"`-kind `HookHandlerEntry` self-attributed to `pluginId` — a
   * plugin can only register handlers for itself, never impersonate another
   * plugin or shadow a closed `handlers.ts` key.
   */
  addPluginHandlers(pluginId: string, handlers: HookHandlerRegistry): void {
    for (const [handlerRef, entry] of Object.entries(handlers)) {
      if (entry.kind !== "plugin" || entry.plugin_id !== pluginId) throw new HookCatalogError("contract", `plugin handler registration for '${handlerRef}' must be a self-attributed 'plugin'-kind entry`);
      if (Object.prototype.hasOwnProperty.call(HOOK_HANDLERS, handlerRef)) throw new HookCatalogError("contract", `plugin handler_ref '${handlerRef}' collides with the closed built-in registry`);
    }
    this.handlers = Object.freeze({ ...this.handlers, ...handlers });
  }

  /**
   * Load the catalog from an operator-owned `.arbor/hooks` directory.
   *
   * FALLBACK RULE, and it is the whole reason this method has a docstring:
   *
   *   - ABSENT directory means "this clone has never enrolled", so the SOURCE
   *     defaults (`DEFAULT_HOOK_SET`) are registered in memory. `.arbor/` is
   *     gitignored (`.gitignore:29`), so activation has to be shipped in
   *     source; without this fallback a descriptor added to
   *     `DEFAULT_HOOK_SET` would only ever fire in a clone that had
   *     re-enrolled, and every other clone would keep an inert handler — the
   *     exact defect this default set was extended to close.
   *   - EXISTING directory stays operator-authoritative and is read alone.
   *     Materializing their own `.arbor/hooks` is how an operator overrides,
   *     narrows, or removes a default, and enrollment deliberately never
   *     re-adds a descriptor an operator deleted from an existing directory
   *     (`ensureDefaultHooks` writes only absent identities).
   *
   * So the fallback is strictly a not-yet-enrolled clone, never a silent
   * re-imposition of a default over a live operator decision.
   */
  static fromDirectory(directory: string, options: HookCatalogOptions = {}): HookCatalog {
    const catalog = new HookCatalog(options);
    if (!existsSync(directory)) {
      for (const descriptor of DEFAULT_HOOK_SET) {
        try { catalog.register(JSON.stringify(descriptor), `in-memory.json`); }
        catch (error) { catalog.capture("DEFAULT_HOOK_SET", error); }
      }
      return catalog;
    }
    let files: Dirent[];
    try { files = readdirSync(directory, { withFileTypes: true, encoding: "utf8" }); }
    catch { catalog.failures.push(Object.freeze({ source: directory, code: "malformed", message: "hook directory could not be read" })); return catalog; }
    files = files.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).sort((left, right) => left.name.localeCompare(right.name));
    if (files.length > HOOK_MAX_DESCRIPTORS) {
      catalog.failures.push(Object.freeze({ source: directory, code: "descriptor_bound", message: `hook catalog exceeds ${HOOK_MAX_DESCRIPTORS} descriptors` }));
      return catalog;
    }
    for (const file of files) {
      const path = join(directory, file.name);
      try { catalog.register(readFileSync(path), file.name); }
      catch (error) { catalog.capture(file.name, error); }
    }
    return catalog;
  }

  register(bytes: Uint8Array | string, source = "in-memory.json", active?: () => boolean, pluginId?: string, replace = false, pluginTier?: PluginTrustTier): ValidatedHook {
    const raw = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
    if (raw.byteLength === 0 || raw.byteLength > HOOK_MAX_DESCRIPTOR_BYTES) throw new HookCatalogError("descriptor_bound", "hook descriptor is empty or oversized");
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { throw new HookCatalogError("malformed", "hook descriptor is not valid UTF-8 JSON"); }
    const hash = createHash("sha256").update(raw).digest("hex");
    const hook = this.validateDescriptor(parsed, hash, pluginId, pluginTier);
    const expectedName = `${hook.hook_id}@${hook.version}.json`;
    if (basename(source) !== "in-memory.json" && basename(source) !== expectedName) throw new HookCatalogError("identity", `hook filename must be ${expectedName}`);
    const key = identity(hook.hook_id, hook.version);
    const existing = this.hooks.get(key);
    if (existing !== undefined) {
      if (existing.descriptor_hash !== hash && (!replace || this.owners.get(key) !== pluginId)) throw new HookCatalogError("immutable_conflict", `hook ${hook.hook_id}@${hook.version} is immutable`);
      if (existing.descriptor_hash !== hash) { this.hooks.set(key, hook); this.activation.set(key, active ?? (() => true)); if (pluginId !== undefined) this.owners.set(key, pluginId); return hook; }
      if (pluginId !== undefined && this.owners.get(key) === pluginId) this.activation.set(key, active ?? (() => true));
      return existing;
    }
    if (this.hooks.size >= HOOK_MAX_DESCRIPTORS) throw new HookCatalogError("descriptor_bound", `hook catalog exceeds ${HOOK_MAX_DESCRIPTORS} descriptors`);
    this.hooks.set(key, hook); this.activation.set(key, active ?? (() => true)); if (pluginId !== undefined) this.owners.set(key, pluginId);
    return hook;
  }

  resolve(hookId: string, version: string): ValidatedHook | null { const key = identity(hookId, version); const hook = this.hooks.get(key); return hook === undefined || !(this.activation.get(key) ?? (() => true))() ? null : hook; }
  /**
   * The live handler registry (built-ins plus anything `addPluginHandlers` has merged in) that `HookBus` dispatches against. */
  resolveHandler(handlerRef: string): HookHandlerRegistry[string] | undefined { return this.handlers[handlerRef]; }
  list(): readonly ValidatedHook[] { return Object.freeze([...this.hooks].filter(([key]) => (this.activation.get(key) ?? (() => true))()).map(([, hook]) => hook)); }
  diagnostics(): readonly HookCatalogDiagnostic[] { return Object.freeze(this.failures.map((failure) => Object.freeze({ ...failure }))); }

  /**
   * Whether a `CODE` tropism's `enforcing_ref` names something this catalog
   * actually declares. Today the only enforcement surface a hook can name
   * is a declared veto hook, so that is what resolves; a Guard cell's gate
   * id becomes a second accepted form when the Guard milestone lands, and
   * until then accepting one would mean trusting a string nobody declared.
   */
  declaresEnforcingRef(ref: string): boolean {
    const [hookId, version] = ref.split("@");
    return this.list().some((hook) => hook.kind === "veto" && hook.hook_id === hookId && (version === undefined || hook.version === version));
  }

  /**
   * Proposal §5.3's two lints, plus the shape and bound an injection needs
   * before it can be rendered at all. Returns a diagnostic rather than
   * throwing: a bad tropism is a *firing* outcome the bus records and
   * reports, not a catalog-load failure — the descriptors around it are
   * still valid and must keep working.
   */
  validateTropism(value: unknown): HookTropismDiagnostic | null {
    if (!plain(value)) return Object.freeze({ code: "tropism_malformed", message: "tropism is not a plain object" });
    if (typeof value.id !== "string" || !value.id.trim() || value.id.length > HOOK_MAX_TROPISM_ID_BYTES) return Object.freeze({ code: "tropism_malformed", message: "tropism id must be a bounded non-empty string" });
    if (typeof value.trigger !== "string" || value.trigger.length > HOOK_MAX_TROPISM_ID_BYTES) return Object.freeze({ code: "tropism_malformed", message: "tropism trigger must be a bounded string" });
    if (value.lane !== "CODE" && value.lane !== "ADVISORY") return Object.freeze({ code: "tropism_malformed", message: "tropism lane must be CODE or ADVISORY" });
    // A tropism is a projection of state the plane holds; nothing verifies
    // one, so a stronger tag would assert a fact no component established.
    if (value.provenance !== "generated") return Object.freeze({ code: "tropism_malformed", message: "tropism provenance must be 'generated'; the plane never verifies one" });
    if (!Array.isArray(value.derived_from) || value.derived_from.length === 0 || value.derived_from.some((source) => typeof source !== "string" || !source.trim())) {
      return Object.freeze({ code: "tropism_malformed", message: "tropism derived_from must be a non-empty list of event hashes (proposal 5.3 rule 2: derived, never constant)" });
    }
    if (typeof value.body !== "string" || !value.body.trim()) return Object.freeze({ code: "tropism_malformed", message: "tropism body must be non-empty text" });
    if (Buffer.byteLength(value.body, "utf8") > TROPISM_BYTE_BUDGET) return Object.freeze({ code: "tropism_bound", message: `tropism body exceeds the ${TROPISM_BYTE_BUDGET}-byte budget` });
    if (!Number.isSafeInteger(value.expires_after_turns) || (value.expires_after_turns as number) <= 0) return Object.freeze({ code: "tropism_malformed", message: "tropism expires_after_turns must be a positive integer" });
    if (value.lane === "ADVISORY") {
      if (value.enforcing_ref !== null) return Object.freeze({ code: "tropism_malformed", message: "an ADVISORY tropism may not declare an enforcing_ref; it asks for nothing" });
      if (IMPERATIVE_LEAD.test(value.body.trim())) {
        return Object.freeze({ code: "advisory_imperative", message: `ADVISORY tropism '${value.id}' opens with imperative text ('${value.body.trim().split(/\s/)[0]}'); a tropism that asks for behaviour must declare lane CODE and name its enforcing_ref` });
      }
      return null;
    }
    if (typeof value.enforcing_ref !== "string" || !value.enforcing_ref.trim()) {
      return Object.freeze({ code: "code_unenforced", message: `CODE tropism '${value.id}' has no enforcing_ref; a CODE tropism is a claim that the plane enforces the thing, so it must name a declared veto or gate` });
    }
    if (!this.declaresEnforcingRef(value.enforcing_ref)) {
      return Object.freeze({ code: "code_unenforced", message: `CODE tropism '${value.id}' names enforcing_ref '${value.enforcing_ref}', which resolves to no declared hook` });
    }
    return null;
  }

  private capture(source: string, error: unknown): void {
    const code = error instanceof HookCatalogError ? error.code : "malformed";
    const message = redactNativeText(error instanceof Error ? error.message : "hook descriptor failed validation").slice(0, 512);
    this.failures.push(Object.freeze({ source, code, message }));
  }

  /**
   * "Reduction at load" (roadmap §4): a descriptor whose declared
   * event/handler capability exceeds what its kind permits is rejected here,
   * as `hook_escalation`, before it can ever be dispatched.
   */
  private validateDescriptor(value: unknown, hash: string, pluginId?: string, pluginTier?: PluginTrustTier): ValidatedHook {
    if (!plain(value) || !exactKeys(value, ["schema_version", "hook_id", "version", "kind", "event", "handler_ref", "why"]) || value.schema_version !== HOOK_SCHEMA_VERSION) {
      throw new HookCatalogError("malformed", "hook descriptor shape or schema_version is invalid");
    }
    if (typeof value.hook_id !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value.hook_id)) throw new HookCatalogError("identity", "hook_id is not bounded canonical kebab-case");
    if (typeof value.version !== "string" || value.version.length > 128 || !SEMVER.test(value.version)) throw new HookCatalogError("version", "hook version must be canonical SemVer");
    if (value.kind !== "observe" && value.kind !== "veto" && value.kind !== "lifecycle" && value.kind !== "inject") throw new HookCatalogError("kind", "hook kind is unknown");
    const kind = value.kind as HookKind;
    if (typeof value.event !== "string") throw new HookCatalogError("malformed", "hook event must be a string");
    const event = value.event as HookEvent;
    const allowedEvents: readonly string[] = kind === "veto" ? HOOK_VETO_EVENTS : kind === "observe" ? HOOK_OBSERVE_EVENTS : kind === "inject" ? HOOK_INJECT_EVENTS : HOOK_LIFECYCLE_EVENTS;
    if (!allowedEvents.includes(event)) throw new HookCatalogError("hook_escalation", `event '${event}' exceeds what hook kind '${kind}' permits`);
    if (typeof value.handler_ref !== "string" || value.handler_ref.length === 0 || value.handler_ref.length > 128) throw new HookCatalogError("malformed", "handler_ref must be a bounded non-empty string");
    if (!Object.prototype.hasOwnProperty.call(this.handlers, value.handler_ref)) throw new HookCatalogError("contract", "handler_ref is not in the closed handler registry");
    const handlerEntry = this.handlers[value.handler_ref]!;
    const handlerKind = handlerEntry.kind;
    // ADR-111 decision 1: a "plugin" entry resolves handler_ref to a
    // PluginRegistry-admitted plugin's own exported function. It is only
    // ever installed here by that plugin's own PluginRegistry.syncComponents
    // call (`addPluginHandlers` refuses any entry not self-attributed), so a
    // descriptor naming a "plugin" handler_ref must itself have been
    // registered by that same plugin — it may not bind another plugin's
    // handler, and a built-in (non-plugin-owned) descriptor may never bind a
    // plugin-backed handler_ref at all.
    if (handlerKind === "plugin") {
      if (pluginId === undefined || handlerEntry.plugin_id !== pluginId) throw new HookCatalogError("contract", `handler_ref '${value.handler_ref}' belongs to plugin '${handlerEntry.plugin_id}', not the registering hook's owner`);
    }
    const isPluginHandler = handlerKind === "plugin";
    if (kind === "veto") {
      if (handlerKind !== "veto" && !isPluginHandler) throw new HookCatalogError("hook_escalation", `handler_ref '${value.handler_ref}' does not implement a veto handler`);
      // The strictest gate this ADR requires: a plugin-supplied tool_preflight
      // veto hook is refused below T4, whether it binds a built-in handler
      // (pluginId !== undefined here means the *descriptor* is plugin-owned)
      // or a plugin-authored one — a veto hook is standing authority over
      // every tool call, not one capability among the plugin's others.
      if (pluginId !== undefined && pluginTier !== "T4") throw new HookCatalogError("plugin_tier", `plugin-supplied '${event}' veto hook requires tier T4 (plugin is ${pluginTier ?? "untiered"})`);
    } else if (kind === "observe") {
      if (handlerKind !== "observe" && !isPluginHandler) throw new HookCatalogError("hook_escalation", `handler_ref '${value.handler_ref}' does not implement an observe handler`);
    } else if (kind === "inject") {
      // An inject hook is the weakest of the four: only a handler that
      // returns a Tropism may back it. A deny-capable or veto-shaped
      // handler bound here would be an escalation the descriptor's declared
      // kind does not describe, and a bare observe handler would bind a
      // descriptor whose whole purpose — reaching the model — it can never
      // fulfil. Checked before the lifecycle branches below because inject
      // shares their events: the escalation ladder is a chain of
      // `else if`s, so a branch placed after them would be unreachable for
      // `inject @ session_start`.
      if (handlerKind !== "inject") throw new HookCatalogError("hook_escalation", `handler_ref '${value.handler_ref}' does not implement an inject handler`);
      if (pluginId !== undefined && pluginTier !== "T4") throw new HookCatalogError("plugin_tier", `plugin-supplied '${event}' inject hook requires tier T4 (plugin is ${pluginTier ?? "untiered"})`);
    } else if (event === HOOK_LIFECYCLE_VETO_EVENT) {
      // The single lifecycle event allowed to deny: either a deny-capable or
      // a plain observe handler may attach here.
      if (handlerKind !== "lifecycle_start" && handlerKind !== "lifecycle_observe" && !isPluginHandler) throw new HookCatalogError("hook_escalation", `handler_ref '${value.handler_ref}' does not implement a lifecycle handler`);
      // Same reasoning as the veto gate above: any plugin-supplied hook bound
      // to the one deny-capable lifecycle event requires T4, whether it binds
      // a built-in lifecycle_start handler or a plugin-authored one — only a
      // plain lifecycle_observe binding is exempt (it cannot deny anything).
      if (pluginId !== undefined && handlerKind !== "lifecycle_observe" && pluginTier !== "T4") throw new HookCatalogError("plugin_tier", `plugin-supplied '${event}' lifecycle veto hook requires tier T4 (plugin is ${pluginTier ?? "untiered"})`);
    } else if (handlerKind !== "lifecycle_observe" && !isPluginHandler) {
      // Every other lifecycle event is structurally observe-only: a
      // deny-capable handler may never be bound to it.
      throw new HookCatalogError("hook_escalation", `event '${event}' may not bind a deny-capable handler; only '${HOOK_LIFECYCLE_VETO_EVENT}' may deny`);
    }
    if (typeof value.why !== "string" || !value.why.trim() || Buffer.byteLength(value.why, "utf8") > HOOK_MAX_WHY_BYTES) throw new HookCatalogError("malformed", "hook why is empty or oversized");
    return Object.freeze({
      schema_version: 1, hook_id: value.hook_id, version: value.version, kind, event,
      handler_ref: value.handler_ref, why: redactNativeText(value.why), descriptor_hash: hash,
    });
  }
}

function identity(hookId: string, version: string): string { return `${hookId}\u0000${version}`; }
function plain(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean { return Object.keys(value).length === expected.length && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key)); }
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
