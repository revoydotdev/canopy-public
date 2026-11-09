/**
 * arbor-eval/stage0/guard — hard run caps and the provider-fatal stop.
 *
 * The 2026-10-07 full run kept dispatching attempts after the provider
 * account ran out of credits: 399 attempts each failed in seconds with
 * HTTP 402, and the driver classified every one as a `model` failure
 * because the error lived only in the campaign's audit log. This module is
 * the driver-side defence, enforced in code rather than by an operator
 * watching a terminal:
 *
 * - `validateRunPlan` refuses to start a run whose plan or native config
 *   exceeds the caps (tasks, seeds, attempts, turns, wall clock,
 *   concurrency, per-campaign spend);
 * - `Stage0RunGuard` admits each new attempt only while the attempt cap, the
 *   wall-clock cap and the projected priced spend allow it, aborts every
 *   in-flight attempt the moment spend exceeds the kill switch or the total
 *   wall clock runs out, and stops the whole run on the first provider-fatal
 *   error (HTTP 401/402/403, a credential failure), on the same provider
 *   error in two consecutive attempts, or when the sessions did not run on
 *   the required connector.
 *
 * Provider errors are read from the attempt's own preserved evidence (the
 * campaign audit log and harness session log), which is where the runtime
 * records a model-port failure; `arbor task`'s stderr does not carry it.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Stage0Unit } from "./scheduler.js";
import type { Stage0ProviderError } from "./types.js";

/** Hard caps for one run. Every field is an upper bound the driver enforces. */
export interface Stage0RunCaps {
  readonly max_tasks: number;
  readonly max_seeds: number;
  readonly max_attempts: number;
  /** Ceiling on `native.max_turns` (per session). */
  readonly max_turns: number;
  /** Ceiling on one attempt's wall clock, setup to acceptance. */
  readonly max_attempt_wall_ms: number;
  /** The whole run's wall clock; in-flight attempts are aborted when it runs out. */
  readonly max_total_wall_ms: number;
  /** Attempts in flight at once. */
  readonly max_in_flight: number;
  /** Priced USD (provider tokens × the configured price observation) at which the run stops. */
  readonly usd_kill_switch: number;
  /** The only harness connector the sessions may run on. */
  readonly required_connector_id: string;
}

/** Operator budget rules of 2026-10-07 (preregistration Revision 2). */
export const STAGE0_REV2_PILOT_CAPS: Stage0RunCaps = {
  max_tasks: 5,
  max_seeds: 1,
  max_attempts: 24,
  max_turns: 32,
  max_attempt_wall_ms: 15 * 60_000,
  max_total_wall_ms: 2 * 60 * 60_000,
  max_in_flight: 2,
  usd_kill_switch: 3,
  required_connector_id: "revoy-native",
};

/**
 * Operator decision of 2026-10-07 after the Revision 2.3 pilot: the per-attempt
 * wall cap rises from 15 to 25 minutes; every other cap is unchanged. A new
 * preset rather than an edit of `STAGE0_REV2_PILOT_CAPS`, so ledgers written
 * under the 15-minute cap stay interpretable; the preset name and the cap are
 * recorded in the ledger's `run_started` event.
 */
export const STAGE0_REV2_PILOT_25MIN_CAPS: Stage0RunCaps = { ...STAGE0_REV2_PILOT_CAPS, max_attempt_wall_ms: 25 * 60_000 };

/** Named cap presets accepted by `--caps`. */
export const STAGE0_CAPS_PRESETS: Readonly<Record<string, Stage0RunCaps>> = {
  "rev2-pilot": STAGE0_REV2_PILOT_CAPS,
  "rev2-pilot-25min": STAGE0_REV2_PILOT_25MIN_CAPS,
};

export interface RunPlan {
  readonly units: readonly Stage0Unit[];
  /** Attempts each unit may dispatch (the scheduler's `max_budget`). */
  readonly max_attempts_per_unit: number;
  readonly native_config: Readonly<Record<string, unknown>>;
  readonly attempt_timeout_ms: number;
  readonly max_in_flight: number;
}

/** Every way the plan exceeds the caps; an empty list means the run may start. */
export function validateRunPlan(plan: RunPlan, caps: Stage0RunCaps): string[] {
  const errors: string[] = [];
  const tasks = new Set(plan.units.map((u) => u.task_id));
  const seeds = new Set(plan.units.map((u) => u.seed));
  if (tasks.size > caps.max_tasks) errors.push(`${tasks.size} tasks exceed the cap of ${caps.max_tasks}`);
  if (seeds.size > caps.max_seeds) errors.push(`${seeds.size} seeds exceed the cap of ${caps.max_seeds}`);
  const planned = plan.units.length * plan.max_attempts_per_unit;
  if (planned > caps.max_attempts) errors.push(`${planned} planned attempts exceed the cap of ${caps.max_attempts}`);
  const native = plan.native_config;
  const turns = native.max_turns;
  if (typeof turns !== "number" || turns > caps.max_turns) errors.push(`native.max_turns must be set and at most ${caps.max_turns} (got ${String(turns)})`);
  const session = native.max_session_wall_clock_ms;
  if (typeof session !== "number" || session > caps.max_attempt_wall_ms) errors.push(`native.max_session_wall_clock_ms must be set and at most ${caps.max_attempt_wall_ms} (got ${String(session)})`);
  if (plan.attempt_timeout_ms > caps.max_attempt_wall_ms) errors.push(`attempt timeout ${plan.attempt_timeout_ms} ms exceeds the cap of ${caps.max_attempt_wall_ms} ms`);
  if (plan.max_in_flight > caps.max_in_flight || plan.max_in_flight < 1) errors.push(`${plan.max_in_flight} attempts in flight is outside 1..${caps.max_in_flight}`);
  const pricing = native.pricing as Record<string, unknown> | undefined;
  if (pricing === undefined || typeof pricing.input_minor_units_per_million_tokens !== "number" || typeof pricing.output_minor_units_per_million_tokens !== "number") errors.push("native.pricing must carry the price observation the spend cap is computed from");
  const budget = (native.usage_budget as { max_campaign_cost?: { minor_units?: number; minor_unit_exponent?: number } } | undefined)?.max_campaign_cost;
  const campaignCap = budget?.minor_units === undefined ? null : budget.minor_units / 10 ** (budget.minor_unit_exponent ?? 6);
  if (campaignCap === null || campaignCap > caps.usd_kill_switch) errors.push(`native.usage_budget.max_campaign_cost must be set and at most the $${caps.usd_kill_switch} kill switch`);
  return errors;
}

/** A provider error as the runtime records it: adapter kind, HTTP status (if any), message head. */
export type ProviderError = Stage0ProviderError;

const ADAPTER_ERROR = /AdapterError \((\w+)\): ((?:[^"\\\n]|\\[^"n])*)/g;
const HTTP_STATUS = /\bHTTP (\d{3})\b/;

/** Distinct provider errors in a text (audit log, session log, stderr), in order of first appearance. */
export function providerErrorsIn(text: string): ProviderError[] {
  const out = new Map<string, ProviderError>();
  for (const match of text.matchAll(ADAPTER_ERROR)) {
    const kind = match[1];
    const message = match[2].trim().slice(0, 160);
    const status = HTTP_STATUS.exec(message);
    const signature = `${kind}:${message}`;
    if (!out.has(signature)) out.set(signature, { kind, status: status === null ? null : Number(status[1]), signature });
  }
  return [...out.values()];
}

/** Credit exhaustion and authentication failures: no further attempt can succeed. */
export function isProviderFatal(error: ProviderError): boolean {
  return error.kind === "credential" || error.status === 401 || error.status === 402 || error.status === 403;
}

function readIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** The provider errors an attempt's preserved evidence records. */
export function providerErrorsInTarget(target: string, extra = ""): ProviderError[] {
  const audit = join(target, ".arbor", "audit");
  const texts = [extra, readIfExists(join(target, ".arbor", "harness-sessions.ndjson"))];
  if (existsSync(audit)) for (const name of readdirSync(audit)) if (name.endsWith(".jsonl")) texts.push(readIfExists(join(audit, name)));
  return providerErrorsIn(texts.join("\n"));
}

/** Harness connector ids the attempt's sessions ran on. */
export function connectorIdsInTarget(target: string): string[] {
  const text = readIfExists(join(target, ".arbor", "harness-sessions.ndjson"));
  return [...new Set([...text.matchAll(/"connector_id":"([^"]+)"/g)].map((m) => m[1]))].sort();
}

/** The key the guard tracks an attempt under. */
export function attemptKey(unit: Stage0Unit, attemptIndex: number): string {
  return `${unit.task_id}#${unit.seed}/a${attemptIndex}`;
}

/** Verifier egress grants (ADR-191) translated from a cohort file's `acceptance_network: { mode: "egress" }` members. */
export function cohortEgressGrants(cohort: { readonly members: readonly { readonly id: string; readonly acceptance: readonly string[]; readonly acceptance_network?: { readonly mode?: string; readonly reason?: string } | null }[] }): Record<string, { argv: string[]; reason: string }[]> {
  const grants: Record<string, { argv: string[]; reason: string }[]> = {};
  for (const member of cohort.members) {
    const network = member.acceptance_network;
    if (network?.mode !== "egress" || typeof network.reason !== "string") continue;
    grants[member.id] = [{ argv: [...member.acceptance], reason: network.reason }];
  }
  return grants;
}

export type Stage0StopReason = "attempt_cap" | "wall_cap" | "spend_cap" | "provider_fatal" | "provider_repeated" | "connector_mismatch";

/** What the guard needs from a finished attempt. */
export interface GuardedAttemptOutcome {
  readonly key: string;
  readonly cost_usd: number;
  readonly provider_errors: readonly ProviderError[];
  readonly connector_ids: readonly string[];
  readonly campaign_id: string | null;
}

export interface Stage0RunGuardOptions {
  readonly caps: Stage0RunCaps;
  /** Spend already in the ledger (a resumed run). */
  readonly spent_usd?: number;
  /** Attempts already in the ledger; they count toward the attempt cap. */
  readonly attempts_already_run?: number;
  /** Worst-case USD reserved for an attempt before any has finished (the per-campaign cap). */
  readonly per_attempt_reserve_usd: number;
  readonly now?: () => number;
  readonly onStop?: (reason: Stage0StopReason, detail: string) => void;
}

export class Stage0RunGuard {
  readonly caps: Stage0RunCaps;
  private readonly controller = new AbortController();
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly reserve: number;
  private readonly live = new Map<string, number>();
  private finishedSpend: number;
  private maxFinishedCost = 0;
  private started: number;
  private connectorVerified = false;
  private previousErrors: readonly ProviderError[] | null = null;
  private stop: { reason: Stage0StopReason; detail: string } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly onStop?: (reason: Stage0StopReason, detail: string) => void;

  constructor(options: Stage0RunGuardOptions) {
    this.caps = options.caps;
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.finishedSpend = options.spent_usd ?? 0;
    this.started = options.attempts_already_run ?? 0;
    this.reserve = options.per_attempt_reserve_usd;
    this.onStop = options.onStop;
  }

  /** Aborted when the run must stop outright; in-flight attempts kill their processes on it. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get stopped(): { readonly reason: Stage0StopReason; readonly detail: string } | null {
    return this.stop;
  }

  get spent_usd(): number {
    let live = 0;
    for (const value of this.live.values()) live += value;
    return this.finishedSpend + live;
  }

  /** Arm the total wall-clock cap. */
  arm(): void {
    const remaining = this.startedAt + this.caps.max_total_wall_ms - this.now();
    this.timer = setTimeout(() => this.halt("wall_cap", `total wall clock of ${this.caps.max_total_wall_ms} ms reached`), Math.max(0, remaining));
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Stop the run outright: no new attempt starts and every in-flight attempt is aborted. */
  halt(reason: Stage0StopReason, detail: string): void {
    if (this.stop !== null) return;
    this.stop = { reason, detail };
    this.onStop?.(reason, detail);
    this.controller.abort(new Error(`stage0 run stopped: ${reason}: ${detail}`));
  }

  /**
   * Admit one more attempt, or refuse. Refusing for the attempt cap or the
   * projected spend stops new starts but lets in-flight attempts finish.
   */
  admit(key: string): boolean {
    if (this.stop !== null) return false;
    if (this.now() - this.startedAt >= this.caps.max_total_wall_ms) {
      this.halt("wall_cap", `total wall clock of ${this.caps.max_total_wall_ms} ms reached`);
      return false;
    }
    if (this.started >= this.caps.max_attempts) {
      this.refuse("attempt_cap", `${this.started} attempts started; cap ${this.caps.max_attempts}`);
      return false;
    }
    const projected = this.projectedWith(1);
    if (projected >= this.caps.usd_kill_switch) {
      this.refuse("spend_cap", `projected spend $${projected.toFixed(4)} ≥ $${this.caps.usd_kill_switch}`);
      return false;
    }
    this.started++;
    this.live.set(key, 0);
    return true;
  }

  /**
   * Projected spend: finished + each in-flight attempt at no less than the
   * reserve + `extra` new attempts at the reserve. The reserve is the
   * costliest finished attempt, or the configured per-attempt reserve until
   * one has a cost.
   */
  projectedWith(extra: number): number {
    const reserve = this.maxFinishedCost > 0 ? this.maxFinishedCost : this.reserve;
    let inflight = 0;
    for (const value of this.live.values()) inflight += Math.max(value, reserve);
    return this.finishedSpend + inflight + extra * reserve;
  }

  /** Live priced spend of an in-flight attempt (polled from its audit log). */
  progress(key: string, liveCostUsd: number, errors: readonly ProviderError[] = []): void {
    if (!this.live.has(key)) return;
    this.live.set(key, Math.max(this.live.get(key) ?? 0, liveCostUsd));
    const fatal = errors.find(isProviderFatal);
    if (fatal !== undefined) this.halt("provider_fatal", `${key}: ${fatal.signature}`);
    if (this.spent_usd > this.caps.usd_kill_switch) this.halt("spend_cap", `spend $${this.spent_usd.toFixed(4)} exceeded $${this.caps.usd_kill_switch}`);
  }

  /** Record a finished attempt; may stop the run. */
  finish(outcome: GuardedAttemptOutcome): void {
    this.live.delete(outcome.key);
    this.finishedSpend += outcome.cost_usd;
    this.maxFinishedCost = Math.max(this.maxFinishedCost, outcome.cost_usd);
    const fatal = outcome.provider_errors.find(isProviderFatal);
    if (fatal !== undefined) this.halt("provider_fatal", `${outcome.key}: ${fatal.signature}`);
    const previous = this.previousErrors;
    if (previous !== null) {
      const repeated = outcome.provider_errors.find((e) => previous.some((p) => p.signature === e.signature));
      if (repeated !== undefined) this.halt("provider_repeated", `${outcome.key} repeats the previous attempt's provider error: ${repeated.signature}`);
    }
    this.previousErrors = outcome.provider_errors;
    const foreign = outcome.connector_ids.filter((id) => id !== this.caps.required_connector_id);
    if (foreign.length > 0) this.halt("connector_mismatch", `${outcome.key} ran on connector(s) ${foreign.join(", ")}; required ${this.caps.required_connector_id}`);
    else if (outcome.connector_ids.length > 0) this.connectorVerified = true;
    else if (!this.connectorVerified && outcome.campaign_id !== null) this.halt("connector_mismatch", `${outcome.key} recorded no harness connector; the required ${this.caps.required_connector_id} could not be verified`);
    if (this.spent_usd > this.caps.usd_kill_switch) this.halt("spend_cap", `spend $${this.spent_usd.toFixed(4)} exceeded $${this.caps.usd_kill_switch}`);
  }

  private refuse(reason: Stage0StopReason, detail: string): void {
    // Stop new starts without aborting in-flight attempts.
    if (this.stop !== null) return;
    this.stop = { reason, detail };
    this.onStop?.(reason, detail);
  }
}

/** A counting semaphore bounding attempts in flight. */
export function semaphore(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}
