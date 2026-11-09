/**
 * The closed, bounded, revoy2-owned set of in-process hook handlers a
 * deployment may enable by naming a `handler_ref` in a hook descriptor
 * (`catalog.ts`). A hook cannot carry arbitrary code — it can only select
 * from this registry, the hook analogue of `skills/catalog.ts`'s
 * `SKILL_STRUCTURED_OUTPUT_IDS` closed contract-id catalog.
 *
 * `HookCatalog` reads this registry (or an injected test double of the same
 * shape) to check that a descriptor's `handler_ref` exists and that its
 * registered capability (`HookHandlerEntry.kind`) does not exceed what the
 * descriptor's `kind`/`event` permits — this is the single source of truth
 * for handler capability, so there is nothing else to keep in sync (no
 * catalog-drift-in-three-places here: one table, read by both the catalog
 * validator and the bus that dispatches it).
 */
import { NATIVE_REPOSITORY_TOOL_RISKS } from "../native-tools/contracts.js";
import { CLAIM_TEXT_BOUND_BYTES, claimCompletenessGuard } from "./claim-completeness-guard.js";
import { gitWriteGuard } from "./git-write-guard.js";
import { currentGovernedRoot, governanceOrientTropism, owedDecisionsTropism, sessionIsolationTropism } from "./governance-tropisms.js";
import { EVIDENCE_STALENESS_HANDLER_BOUND_MS, evidenceStalenessTropism } from "./evidence-staleness-tropism.js";
import { OPERATOR_QUEUE_HANDLER_BOUND_MS, operatorDecisionQueueTropism } from "./operator-decision-queue.js";
import { viDirtyTracker } from "./vi-dirty-tracker.js";
import { viFreshnessTropism } from "./vi-freshness-tropism.js";
import { viGraphDebt } from "./vi-graph-debt.js";
import { REPO_SESSION_HANDLER_BOUND_MS, repoSessionEndHandler, repoSessionOpenHandler } from "./repo-session.js";
import { STOP_BATTERY_HANDLER_BOUND_MS, stopBatteryObserver } from "./stop-battery.js";
import { viReadOnlyGuard } from "./vi-readonly-guard.js";
import type { HookHandlerRegistry, HookInjectHandler, HookLifecycleObserveHandler, HookLifecycleStartHandler, HookObserveHandler, HookVetoHandler } from "./contracts.js";

const denyShellExecute: HookVetoHandler = (context) => context.tool === "shell.execute"
  ? { allow: false, reason: "shell.execute is denied by deployment policy (veto.deny-shell-execute)" }
  : { allow: true };

const denyHighRiskRepositoryTool: HookVetoHandler = (context) => NATIVE_REPOSITORY_TOOL_RISKS[context.tool as keyof typeof NATIVE_REPOSITORY_TOOL_RISKS] === "high"
  ? { allow: false, reason: `${context.tool} is a high-risk repository tool denied by deployment policy (veto.deny-high-risk-repository-tool)` }
  : { allow: true };

const toolAuditNotes: HookObserveHandler = (context) => ({ note: context.summary });
const sessionLedgerNotes: HookObserveHandler = (context) => ({ note: context.summary });

const denySessionStart: HookLifecycleStartHandler = () => ({ allow: false, reason: "new sessions are denied while deployment policy lifecycle.deny-session-start is enabled" });

/** Resolved per firing, not captured at module load: the working directory is the session's own. */
const governanceOrient: HookInjectHandler = () => governanceOrientTropism(currentGovernedRoot());
const sessionIsolation: HookInjectHandler = () => sessionIsolationTropism(currentGovernedRoot());
const owedDecisions: HookInjectHandler = () => owedDecisionsTropism(currentGovernedRoot());
const viFreshness: HookInjectHandler = () => viFreshnessTropism(currentGovernedRoot());
/** Resolved per firing, not captured at module load: the working directory is the session's own. */
const operatorDecisionQueue: HookInjectHandler = () => operatorDecisionQueueTropism(currentGovernedRoot());
const evidenceStaleness: HookInjectHandler = () => evidenceStalenessTropism(currentGovernedRoot());

const sessionBoundaryNotes: HookLifecycleObserveHandler = (context) => ({
  note: `${context.event} campaign=${context.campaign_id}${context.role === null ? "" : ` role=${context.role}`}${context.outcome === null ? "" : ` outcome=${context.outcome}`}`,
});

export const HOOK_HANDLERS: HookHandlerRegistry = Object.freeze({
  /** Defense in depth: deny shell execution regardless of approval/session policy. */
  "veto.deny-shell-execute": Object.freeze({ kind: "veto", handler: denyShellExecute }),
  /** Locks a session down to the low-risk repository tools only. */
  "veto.deny-high-risk-repository-tool": Object.freeze({ kind: "veto", handler: denyHighRiskRepositoryTool }),
  /** Refuses a `git` write issued from subagent context; never blocks the orchestrator. */
  "veto.git-write-guard": Object.freeze({ kind: "veto", handler: gitWriteGuard }),
  /**
   * Refuses a hand-edit outside `.visual-intelligence/` while a VI run is armed.
   * Costs three `stat` calls and a pair of `realpath` resolutions per firing, so
   * it declares a wall-clock bound rather than inheriting the 50 ms default meant
   * for a pure in-process predicate.
   */
  "veto.vi-readonly-guard": Object.freeze({ kind: "veto", handler: viReadOnlyGuard, timeout_ms: 250 }),
  /**
   * Refuses an unbacked completeness marker in a claim-bearing document.
   * `text_bytes` is the guard's own constant rather than a literal, so the bound
   * the registry declares and the bound the handler refuses on cannot drift; see
   * `claim-completeness-guard.ts` for why the value is 128 KiB and not the bus
   * default. Its marker scan is a handful of regexes over that text, so it
   * declares its own wall-clock bound too.
   */
  "veto.claim-completeness-guard": Object.freeze({ kind: "veto", handler: claimCompletenessGuard, timeout_ms: 250, text_bytes: CLAIM_TEXT_BOUND_BYTES }),
  /** Real observation: each fired tool-audit record gets its own bounded ledger note. */
  "observe.tool-audit-notes": Object.freeze({ kind: "observe", handler: toolAuditNotes }),
  /**
   * Records every path a session writes into `.visual-intelligence/.dirty`, the
   * file that remembers a path edited AND THEN COMMITTED. It is the SOLE writer
   * of a state file two read-side hooks depend on, so it declares a wall-clock
   * bound rather than inheriting the 50 ms default meant for a pure in-process
   * predicate: it costs a `stat`, a read and an append.
   */
  "observe.vi-dirty-tracker": Object.freeze({ kind: "observe", handler: viDirtyTracker, timeout_ms: 250 }),
  /**
   * Reports, on every turn boundary, how much graph debt the session has
   * accrued: the UNSCOPED `.dirty ∩ git status` intersection, sampled to five
   * paths. Same cost class as `inject.vi-freshness` and the same declared
   * bound for the same reason — it spawns git three times, and the bus's 50 ms
   * default is sized for a pure in-process predicate, so crossing it would drop
   * the report.
   *
   * It is an `inject` handler, not an `observe` one, because that is the only
   * lane whose product reaches the model: the deleted hook printed its prose at
   * Stop time and the host fed it straight to the model, so on the observe lane
   * it became a ledger row nobody read. Advisory in the strict sense — a
   * `Tropism` carries no decision field — so `turn_end` gains nothing that could
   * refuse a turn. See `vi-graph-debt.ts`.
   */
  "inject.vi-graph-debt": Object.freeze({ kind: "inject", handler: viGraphDebt, timeout_ms: 2000 }),
  /**
   * Measures the stop-tier gate battery out of band and caches the verdict.
   *
   * The bound is the one that matters most in this registry: the battery is
   * the most expensive thing any handler here runs, at a measured ~30s median
   * against a 25000 ms ratcheted ceiling. The declared `timeout_ms` is that
   * ceiling plus slack, because crossing it drops only the ledger NOTE — the
   * battery's own spawn is bounded separately inside the handler and reports an
   * over-run as a measurement failure, which BLOCKS. Nothing here can silently
   * drop a verdict: an over-run is a refusal with its own message.
   */
  "observe.stop-battery": Object.freeze({ kind: "observe", handler: stopBatteryObserver, timeout_ms: STOP_BATTERY_HANDLER_BOUND_MS }),
  /** Same shape, for the native session engine's own ledger-witnessed event stream. */
  "observe.session-ledger-notes": Object.freeze({ kind: "observe", handler: sessionLedgerNotes }),
  /** Incident-response kill switch: refuse every new session while enabled. */
  "lifecycle.deny-session-start": Object.freeze({ kind: "lifecycle_start", handler: denySessionStart }),
  /** Pure observation across any lifecycle event, including session_start when no denial is wanted. */
  "lifecycle.session-boundary-notes": Object.freeze({ kind: "lifecycle_observe", handler: sessionBoundaryNotes }),
  /**
   * Session-start ordering index plus the repository's live governance posture.
   *
   * Both posture handlers spawn git (`readGovernedPosture`: `status`, and
   * `merge-base` when a graph revision is committed), so they declare the same
   * bound as `inject.vi-freshness`. Under the bus's 50 ms default, sized for a
   * pure in-process predicate, a loaded host pushed the spawns past the bound
   * and the tropism was dropped as `hook_timeout_exceeded` — the session
   * silently lost its isolation warning, and the bus's dedupe then saw the
   * unchanged posture as new on the next turn.
   */
  "inject.governance-orient": Object.freeze({ kind: "inject", handler: governanceOrient, timeout_ms: 2000 }),
  /** Session-start checkout-sharing report. Observe-only; the gate that enforces is separate. */
  "inject.session-isolation": Object.freeze({ kind: "inject", handler: sessionIsolation, timeout_ms: 2000 }),
  /** Session-start owed-decision queue: every Proposed or Draft ADR, with its age. It reads every record in `decisions/`, so it is not a pure predicate either. */
  "inject.owed-decisions": Object.freeze({ kind: "inject", handler: owedDecisions, timeout_ms: 2000 }),
  /**
   * Session-start graph-freshness verdict: how far the committed VI graph
   * trails HEAD, and whether the drift touched the graphed domain.
   *
   * It declares a wall-clock bound because it spawns git: `rev-parse`, and
   * when the graph is behind also `status`, `rev-list --count` and
   * `diff --name-only`. The bound is
   * deliberately generous (measured ~10 ms for the four-spawn worst case on
   * this repository) because the consequence of crossing it is the one failure
   * mode this hook must not have: the tropism is dropped and the hook goes
   * SILENT for the session. An overrun is still visible — it is an
   * `error=hook_timeout_exceeded` row in the ledger, not a clean skip.
   */
  "inject.vi-freshness": Object.freeze({ kind: "inject", handler: viFreshness, timeout_ms: 2000 }),
  /**
   * Opens (or joins) the repository-session record and injects what the deferral
   * costs: the five verbs, and the fact that commits and the battery run once at
   * the close. Replaces `scripts/hooks/session-close-start.sh` and the Codex
   * SessionStart half of `codex-session-lifecycle.mjs`.
   *
   * It declares a wall-clock bound because it does I/O: `git status` through the
   * commit plan is not on this path, but the durable-store read and the write are,
   * and the bus's 50 ms default is sized for a pure in-process predicate.
   */
  "inject.repo-session-open": Object.freeze({ kind: "inject", handler: repoSessionOpenHandler, timeout_ms: REPO_SESSION_HANDLER_BOUND_MS }),
  /**
   * Records the end of the repository session. It is an OBSERVE handler on
   * `session_end` and deliberately cannot close anything: the close rebinds
   * evidence for eight to twelve minutes, and the host hook it replaces fired
   * under a three-second timeout. Replaces `scripts/hooks/session-close-end.sh`
   * and the Codex SessionEnd half of `codex-session-lifecycle.mjs`.
   */
  "lifecycle.repo-session-end": Object.freeze({ kind: "lifecycle_observe", handler: repoSessionEndHandler, timeout_ms: REPO_SESSION_HANDLER_BOUND_MS }),
  /**
   * The uncovered OPERATOR-OWNED decision rows, plus any governance hazard,
   * rendered as bounded context before the session's first model action.
   * Replaces `scripts/hooks/codex-decision-interview-session-start.mjs`.
   *
   * It READS and RENDERS and has no write path at all: it cannot write the
   * interview ledger, record coverage, or answer for the operator. That
   * guarantee was never this hook's property either — it lives in
   * `LEGAL_TRANSITIONS` and in a store that only PARSES
   * `decisions/interviews.jsonl` — so a read-only handler cannot weaken it.
   *
   * It declares a wall-clock bound because it SPAWNS `decision-queue.mjs`
   * rather than reimplementing it: a second derivation of the queue
   * `gate:decision-queue` enforces would drift silently, in the direction where
   * an owed interview is simply not mentioned.
   */
  "inject.operator-decision-queue": Object.freeze({ kind: "inject", handler: operatorDecisionQueue, timeout_ms: OPERATOR_QUEUE_HANDLER_BOUND_MS }),
  /**
   * Per-turn advisory: a commit touching `packages/` or `decisions/` just went
   * in AND the evidence stores are stale. Replaces
   * `scripts/hooks/evidence-staleness-nudge.{sh,mjs}`.
   *
   * The `turn_end` INJECT lane is what makes this devolvable at all without
   * losing its product: the deleted hook's whole output was model-facing
   * `additionalContext` on a PostToolUse call, and an observe note is not
   * model-facing. This is advisory in the strict sense — `Tropism | null`
   * carries no decision field, so it cannot block anything — and
   * `gate:store-freshness` still blocks the push either way.
   *
   * It declares the largest bound in this registry because it runs at every
   * turn boundary and reads four stores; see the constant for the measurement
   * and for why it must stay under the turn loop's settle window.
   */
  "inject.evidence-staleness": Object.freeze({ kind: "inject", handler: evidenceStaleness, timeout_ms: EVIDENCE_STALENESS_HANDLER_BOUND_MS }),
}) satisfies HookHandlerRegistry;
