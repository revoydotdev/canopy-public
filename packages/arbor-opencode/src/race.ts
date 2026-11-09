/**
 * arbor-opencode/race — staggered first-verified-wins specialist racing
 * (ADR-067, X-1/X-2).
 *
 * Env-gated (`ARBOR_RACE_SPECIALISTS=2`) and `direct`/`reviewed` governance
 * tier only — a `governed` tree, or one with no recorded governance
 * decision, never races. The loop dispatches attempt 1 exactly as it always
 * has (see loop.ts §4). If attempt 1's independent machine verification
 * (`SpecialistResult.deferred_verification`, OPT-1) has not settled
 * successfully within `ARBOR_RACE_FORK_MS`, this module forks a second
 * attempt into a second REAL isolated worktree acquired through the exact
 * same seam the loop used for the first (`WorktreeManager.acquireLease` /
 * `releaseLease`, "./worktree.js") — the only extension is a synthetic lease
 * key so the single-lease-per-node-id invariant in worktree.ts is never
 * violated. Whichever attempt's deferred verification resolves with the
 * `{provenance}` (verified) shape first wins; the loser is aborted via its
 * own `AbortController` and its worktree released through the same lease
 * path, win or lose. Only machine verification ever picks a VERIFIED
 * winner — output text is never consulted for that decision. When a race
 * actually forks and BOTH attempts fully settle without either verifying
 * (`winner: "none"`), an optional `tie_breaker` seam (ADR-071, X) may be
 * consulted to choose which attempt's unverified result is handed to the
 * critic next; absent a tie-breaker, or one that returns `null` or throws,
 * attempt 1 is taken — today's behavior, unchanged. The tie-breaker never
 * runs, and never gets a vote, on any path where verification already
 * decided a winner.
 *
 * This module is deliberately executor/manager-agnostic: it depends only on
 * `LoopExecutor`/`SpecialistResult` (structural, from loop.ts, type-only —
 * no runtime cycle under `isolatedModules`) and `WorktreeManager`. Env
 * parsing and the governance-tier gate are pure functions so they are
 * testable without process.env mutation or a real CampaignManager.
 */

import type { LoopExecutor, SpecialistResult } from "./loop.js";
import type { WorktreeManager, WorktreeLease } from "@arbor/campaign-support";
import type { GovernanceTier, RaceOutcomeObservation } from "@arbor/core";

export const RACE_SPECIALISTS_ENV = "ARBOR_RACE_SPECIALISTS";
export const RACE_FORK_MS_ENV = "ARBOR_RACE_FORK_MS";

/** Measured p50 fork threshold (bench v4 wall decomposition, manifest X-1). */
export const DEFAULT_RACE_FORK_MS = 25_000;
export const MIN_RACE_FORK_MS = 5_000;
export const MAX_RACE_FORK_MS = 300_000;

/** Suffix distinguishing the fork's synthetic lease key from the real node id it shadows. */
// Suffix must stay valid inside a git branch name (worktree.ts derives
// `arbor/<campaign>/<node_id>` from the lease key): ":" is illegal in git
// refs, and the original "::race-fork" made every fork's worktree
// acquisition fail — bench v5b measured two 20s forks that both silently
// degraded to waiting out attempt 1 because of it.
const FORK_LEASE_SUFFIX = "--race-fork";

/**
 * X-1's env + governance-tier gate. Pure and total: never throws, never
 * reads `process.env` itself (the caller supplies it) so it is trivially
 * unit-testable. `tier` is the campaign's recorded `ArbiterDecision.tier`
 * (via `manager.getCampaignSnapshot(campaign_id)?.governance?.tier`) —
 * `undefined`/`null` (no governance decision recorded) and `"governed"`
 * both refuse racing.
 */
export function isRaceEligible(env: Readonly<Record<string, string | undefined>>, tier: GovernanceTier | null | undefined): boolean {
  if (env[RACE_SPECIALISTS_ENV] !== "2") return false;
  return tier === "direct" || tier === "reviewed";
}

/**
 * Validated, bounded fork threshold. An unset or non-numeric value falls
 * back to `DEFAULT_RACE_FORK_MS`; an in-range numeric value is used as-is;
 * an out-of-range numeric value is clamped into [MIN_RACE_FORK_MS,
 * MAX_RACE_FORK_MS] rather than silently ignored, so a misconfigured but
 * present override still does something bounded and observable.
 */
export function resolveForkThresholdMs(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env[RACE_FORK_MS_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_RACE_FORK_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_RACE_FORK_MS;
  return Math.min(MAX_RACE_FORK_MS, Math.max(MIN_RACE_FORK_MS, parsed));
}

export interface RaceLoserJournal {
  /** The losing attempt's full result, when its `specialize()` call returned one before being superseded. `null` only when the call itself threw/rejected before returning. */
  result: SpecialistResult | null;
  /** Wall time the losing attempt ran before it was superseded (dispatch start to abort/settle). */
  wall_ms: number;
}

export interface RaceResult {
  /** The winning (or, on a both-fail outcome, attempt 1's) result — flows into the existing critic/recordResult pipeline unchanged. */
  result: SpecialistResult;
  /**
   * Present only when the race gate actually engaged (attempt 1 both passed
   * the env/tier gate AND returned `deferred_verification`). `null` means
   * either the gate was closed, or the executor did not support
   * `deferred_verification` — both fall back silently to `result` being
   * exactly attempt 1's unmodified return value.
   */
  outcome: {
    telemetry: RaceOutcomeObservation;
    loser?: RaceLoserJournal;
  } | null;
}

export type RaceSpecializeParams = Omit<Parameters<LoopExecutor["specialize"]>[0], "worktree_path" | "signal">;

export interface RaceLogEvent {
  readonly type: "race_forked" | "race_settled";
  readonly node_id: string;
  readonly forked_at_ms?: number;
  readonly winner?: "primary" | "fork" | "none";
  readonly cancelled?: boolean;
}

/**
 * A "resolves exactly once, on success only" latch. Feeding it a settled
 * `deferred_verification` outcome that is NOT the `{provenance}` shape is a
 * deliberate no-op — the latch stays pending forever, which is correct here:
 * only the fork *timer* (or the other attempt's success) may end the wait,
 * never an early non-success settlement (see module doc + ADR-067).
 */
function successLatch(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

function isVerifiedUpgrade(
  outcome: Awaited<NonNullable<SpecialistResult["deferred_verification"]>>,
): outcome is Extract<Awaited<NonNullable<SpecialistResult["deferred_verification"]>>, { provenance: unknown }> {
  return outcome !== null && "provenance" in outcome;
}

/**
 * Run one attempt's specialize+verify pipeline and wire it into a success
 * latch + a "fully settled" promise the caller can use to detect a
 * never-verifies outcome without hanging forever.
 */
function trackAttempt(
  resultPromise: Promise<SpecialistResult>,
): { latch: ReturnType<typeof successLatch>; settled: Promise<void>; resultRef: { current: SpecialistResult | null } } {
  const latch = successLatch();
  const resultRef: { current: SpecialistResult | null } = { current: null };
  const settled = resultPromise
    .then(async (result) => {
      resultRef.current = result;
      if (result.deferred_verification === undefined) return;
      const outcome = await result.deferred_verification;
      if (isVerifiedUpgrade(outcome)) latch.resolve();
    })
    .catch(() => { /* a rejected specialize() call never verifies; resultRef stays null */ });
  return { latch, settled, resultRef };
}

/** Forward an incoming AbortSignal's abort into a derived controller, honestly, including an already-aborted incoming signal. */
function forwardAbort(into: AbortController, from: AbortSignal | undefined): void {
  if (from === undefined) return;
  if (from.aborted) { into.abort(from.reason); return; }
  from.addEventListener("abort", () => into.abort(from.reason), { once: true });
}

export interface RaceSpecializeInput {
  executor: LoopExecutor;
  /** Attempt 1's dispatch params, minus `worktree_path`/`signal` (each attempt supplies its own). */
  baseParams: RaceSpecializeParams;
  /** Attempt 1's already-acquired worktree path — the loop's normal §3 isolation gate is unchanged; racing only adds a *second* worktree on fork. */
  primaryWorktreePath: string;
  worktrees: WorktreeManager;
  campaign_id: string;
  node_id: string;
  specialist_agent: string;
  /** The loop's incoming cancellation signal; aborts both attempts. */
  signal?: AbortSignal;
  forkThresholdMs: number;
  /**
   * Additive (ADR-069, X-1): provenance for `forkThresholdMs`, when the
   * caller resolved it via `resolveLearnedForkThresholdMs` rather than the
   * plain `resolveForkThresholdMs` fallback. Absent (the default) emits no
   * threshold provenance fields on the race telemetry at all -- existing
   * callers that never pass these fields see byte-identical telemetry
   * shapes to before this field existed.
   */
  thresholdSource?: "learned" | "env" | "default";
  /** Observation count backing `thresholdSource: "learned"`; ignored otherwise. */
  thresholdObservations?: number;
  /**
   * Additive (ADR-071, X): optional, executor-agnostic none-tie arbitration.
   * Called ONLY on the forked `winner: "none"` path (a race that actually
   * forked, and BOTH attempts fully settled without either verifying) —
   * never on any path where verification already produced a winner. `null`
   * means "no opinion" and falls back to attempt 1, today's behavior; a
   * thrown error is treated identically to `null` (caught, never
   * propagated). The IMPLEMENTATION is deliberately composition-side (the
   * caller wires in e.g. the existing fast critic) — this module stays
   * executor-agnostic and never constructs one itself.
   */
  tie_breaker?: (a: SpecialistResult, b: SpecialistResult, signal?: AbortSignal) => Promise<"primary" | "fork" | null>;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Injectable timer for deterministic tests (fake timers). */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  log?: (event: RaceLogEvent) => void;
}

/**
 * Dispatch attempt 1 exactly as `loop.ts` always has, then race per ADR-067.
 * Never throws for racing-specific reasons: a fork-worktree acquisition
 * failure degrades to "wait out attempt 1" rather than aborting the node's
 * dispatch. Attempt 1's own rejection (executor threw) propagates unchanged
 * — this module never swallows a genuine dispatch failure on the attempt
 * whose result the caller ultimately trusts absent a fork.
 */
/**
 * ADR-069/X-1: the optional threshold-provenance fields to spread onto a
 * `RaceOutcomeObservation`, present only when the caller supplied
 * `thresholdSource` -- an untouched caller (no provenance passed) gets
 * telemetry with none of these keys at all, byte-identical to pre-ADR-069.
 */
function thresholdProvenanceFields(input: RaceSpecializeInput): Partial<RaceOutcomeObservation> {
  if (input.thresholdSource === undefined) return {};
  return {
    threshold_ms: input.forkThresholdMs,
    threshold_source: input.thresholdSource,
    threshold_observations: input.thresholdObservations ?? 0,
  };
}

export async function raceSpecialize(input: RaceSpecializeInput): Promise<RaceResult> {
  const now = input.now ?? (() => Date.now());
  const setTimeoutFn = input.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = input.clearTimeoutFn ?? clearTimeout;
  const log = input.log ?? (() => {});
  const thresholdProvenance = thresholdProvenanceFields(input);

  const controller1 = new AbortController();
  forwardAbort(controller1, input.signal);

  const t0 = now();
  // Attempt 1 dispatches exactly as today — same params the caller would
  // have used without racing, just routed through our own AbortController so
  // it can be independently cancelled if attempt 2 wins. Deliberately NOT
  // awaited before the fork timer arms: the point (ADR-067) is to race the
  // in-flight specialist, whose 25–50 s generation dominates wall time. An
  // earlier implementation awaited specialize() here first, which reduced
  // racing to the ~2 s verification tail — bench v5 measured zero forks
  // across five eligible slow tasks as a result.
  const result1Promise = input.executor.specialize({
    ...input.baseParams,
    worktree_path: input.primaryWorktreePath,
    signal: controller1.signal,
  });
  const attempt1 = trackAttempt(result1Promise);

  const timer = { current: null as ReturnType<typeof setTimeout> | null };
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timer.current = setTimeoutFn(() => resolve("timeout"), input.forkThresholdMs);
  });
  const clearTimer = (): void => { if (timer.current !== null) clearTimeoutFn(timer.current); };

  const firstSignal = await Promise.race([
    attempt1.latch.promise.then((): "success" => "success"),
    attempt1.settled.then((): "settled" => "settled"),
    timeoutPromise,
  ]);
  clearTimer();

  if (firstSignal !== "timeout") {
    // Attempt 1 concluded before the fork threshold — verified ("success")
    // or fully settled without verifying ("settled") — so no fork ever
    // happens. Re-awaiting the raw promise propagates a genuine dispatch
    // rejection unchanged, exactly as the unraced path would.
    const result1 = await result1Promise;
    if (result1.deferred_verification === undefined) {
      // The executor does not support pipelined verification at all —
      // nothing was ever raceable. Silent fallback, no observation.
      return { result: result1, outcome: null };
    }
    // Emit a (fork-free) race observation so the ledger can reconstruct
    // that racing was considered for this node.
    return {
      result: result1,
      outcome: { telemetry: { forked_at_ms: null, winner: firstSignal === "success" ? "primary" : "none", loser_wall_ms: null, cancelled: false, ...thresholdProvenance } },
    };
  }

  // Fork: acquire a second isolated worktree through the exact same seam
  // the loop used for attempt 1. The lease store is keyed strictly by
  // node_id (worktree.ts), so a genuinely second, independently-leased
  // worktree for the same tree node needs a distinct lease key — this is
  // the "extend it honestly" the manifest calls for, not a new acquisition
  // mechanism. The fork worktree still belongs to this campaign/specialist;
  // only its lease *key* is synthetic.
  const forkedAtMs = now() - t0;
  const forkLeaseKey = `${input.node_id}${FORK_LEASE_SUFFIX}`;
  const forkLease: WorktreeLease | null = input.worktrees.acquireLease({
    campaign_id: input.campaign_id,
    node_id: forkLeaseKey,
    specialist: input.specialist_agent,
  });

  if (forkLease === null || !forkLease.active) {
    // Could not acquire a real second worktree (e.g. lease contention on a
    // retry, or the manager's own git call failed) — degrade to waiting out
    // attempt 1 exactly as if racing had never engaged. No fork, no loser.
    log({ type: "race_forked", node_id: input.node_id, forked_at_ms: forkedAtMs });
    await attempt1.settled;
    // Re-awaiting the raw promise propagates a genuine dispatch rejection.
    const result1 = await result1Promise;
    const verified = result1.deferred_verification === undefined ? false : isVerifiedUpgrade(await result1.deferred_verification);
    log({ type: "race_settled", node_id: input.node_id, winner: verified ? "primary" : "none", cancelled: false });
    return {
      result: result1,
      outcome: {
        telemetry: { forked_at_ms: forkedAtMs, winner: verified ? "primary" : "none", loser_wall_ms: null, cancelled: false, ...thresholdProvenance },
      },
    };
  }

  log({ type: "race_forked", node_id: input.node_id, forked_at_ms: forkedAtMs });

  const controller2 = new AbortController();
  forwardAbort(controller2, input.signal);
  const t2 = now();
  const attempt2ResultPromise = input.executor.specialize({
    ...input.baseParams,
    worktree_path: forkLease.path,
    signal: controller2.signal,
  });
  const attempt2 = trackAttempt(attempt2ResultPromise);

  const winner = await new Promise<"primary" | "fork" | "none">((resolve) => {
    let decided = false;
    attempt1.latch.promise.then(() => { if (!decided) { decided = true; resolve("primary"); } });
    attempt2.latch.promise.then(() => { if (!decided) { decided = true; resolve("fork"); } });
    Promise.all([attempt1.settled, attempt2.settled]).then(() => { if (!decided) { decided = true; resolve("none"); } });
  });

  let cancelled = false;
  let loser: RaceLoserJournal | undefined;
  if (winner === "primary") {
    cancelled = true;
    controller2.abort(new Error("race: attempt 1 verified first"));
    await attempt2.settled;
    loser = { result: attempt2.resultRef.current, wall_ms: now() - t2 };
  } else if (winner === "fork") {
    cancelled = true;
    controller1.abort(new Error("race: attempt 2 verified first"));
    await attempt1.settled;
    loser = { result: attempt1.resultRef.current, wall_ms: now() - t0 };
  }
  // winner === "none": both ran to natural completion; no forced cancellation, no loser to journal beyond what already happened.

  // ADR-071/X: only the forked winner:"none" path ever consults a
  // tie-breaker — verification already decided every other branch. `null`,
  // a thrown tie-breaker, or a missing/unusable result from either attempt
  // (specialize() itself rejected — see `RaceLoserJournal.result`'s doc)
  // all fall back to "none_default" (attempt 1), today's behavior.
  let tieBreak: "primary" | "fork" | "none_default" | undefined;
  if (winner === "none") {
    tieBreak = "none_default";
    const r1 = attempt1.resultRef.current;
    const r2 = attempt2.resultRef.current;
    if (input.tie_breaker !== undefined && r1 !== null && r2 !== null) {
      let choice: "primary" | "fork" | null;
      try {
        choice = await input.tie_breaker(r1, r2, input.signal);
      } catch {
        choice = null;
      }
      if (choice === "primary" || choice === "fork") tieBreak = choice;
    }
  }

  input.worktrees.releaseLease(forkLeaseKey);

  log({ type: "race_settled", node_id: input.node_id, winner, cancelled });

  const loserUnavailableReason = loser?.result === null
    ? "losing race attempt's specialist dispatch did not return a result before being aborted"
    : loser?.result !== undefined && !hasUsableTokenUsage(loser.result)
      ? loserUsageUnavailableReason(loser.result)
      : undefined;

  // When the fork's own machine verification won, OR the tie-breaker chose
  // the fork's unverified result, attempt 1's own rejection (if any) must
  // not propagate — a real winning result exists; keep the raw promise from
  // surfacing as an unhandled rejection. Otherwise attempt 1's raw promise
  // is awaited so a genuine dispatch rejection propagates exactly as the
  // unraced path would.
  const forkResult = winner === "fork" || tieBreak === "fork" ? attempt2.resultRef.current : null;
  if (forkResult !== null) void result1Promise.catch(() => {});
  const winningResult = forkResult ?? await result1Promise;

  return {
    result: winningResult,
    outcome: {
      telemetry: {
        forked_at_ms: forkedAtMs,
        winner,
        loser_wall_ms: loser?.wall_ms ?? null,
        cancelled,
        ...(loserUnavailableReason === undefined ? {} : { loser_usage_unavailable_reason: loserUnavailableReason }),
        ...(tieBreak === undefined ? {} : { tie_break: tieBreak }),
        ...thresholdProvenance,
      },
      ...(loser === undefined ? {} : { loser }),
    },
  };
}

function hasUsableTokenUsage(result: SpecialistResult): boolean {
  return !("kind" in result.token_usage);
}

function loserUsageUnavailableReason(result: SpecialistResult): string {
  return "kind" in result.token_usage ? result.token_usage.reason : "unknown";
}
