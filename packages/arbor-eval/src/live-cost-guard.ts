/**
 * arbor-eval/live-cost-guard — ADR-095 Decision 3: "a hard per-run dollar
 * ceiling enforced BEFORE dispatch — the harness refuses to start a run that
 * would exceed it."
 *
 * The estimate is a conservative upper bound (every call is priced as if it
 * consumes its full `max_output_tokens` budget), computed and checked before
 * any `fetch` happens. It is never adjusted after the fact to make a run
 * that already started look cheaper.
 */
export class LiveCostCeilingExceededError extends Error {
  constructor(readonly estimated_usd: number, readonly ceiling_usd: number) {
    super(`live eval run refused: estimated cost $${estimated_usd.toFixed(4)} exceeds ceiling $${ceiling_usd.toFixed(4)}`);
    this.name = "LiveCostCeilingExceededError";
  }
}

export interface LiveRunCostEstimateInput {
  /** Number of arms (e.g. tree-search + linear = 2). */
  readonly arms: number;
  readonly tasks: number;
  /** Capped `n` per arm per task (ADR-095 Decision 3, target n=3). */
  readonly runs_per_arm_per_task: number;
  /** Upper bound on verification-call (== model-call) budget spent per run. */
  readonly max_calls_per_run: number;
  readonly estimated_prompt_tokens_per_call: number;
  readonly max_output_tokens_per_call: number;
  readonly price_per_input_token_usd: number;
  readonly price_per_output_token_usd: number;
}

/** A conservative (never-under) estimate of what one full ablation run could cost. */
export function estimateLiveRunCostUsd(input: LiveRunCostEstimateInput): number {
  const totalCalls = input.arms * input.tasks * input.runs_per_arm_per_task * input.max_calls_per_run;
  const perCallUsd =
    input.estimated_prompt_tokens_per_call * input.price_per_input_token_usd +
    input.max_output_tokens_per_call * input.price_per_output_token_usd;
  return round(totalCalls * perCallUsd);
}

/**
 * Enforced BEFORE any dispatch. Throws `LiveCostCeilingExceededError` — never
 * silently clamps the run down to fit — so a misconfigured ceiling is a loud
 * refusal, not a quietly-smaller experiment that gets reported as the full one.
 */
export function assertWithinCostCeiling(estimatedUsd: number, ceilingUsd: number): void {
  if (!Number.isFinite(ceilingUsd) || ceilingUsd <= 0) throw new Error("live cost ceiling must be a positive finite USD amount");
  if (estimatedUsd > ceilingUsd) throw new LiveCostCeilingExceededError(estimatedUsd, ceilingUsd);
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
