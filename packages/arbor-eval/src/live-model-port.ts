/**
 * arbor-eval/live-model-port — the live lane's real-provider wiring.
 *
 * Points the harness's existing `createOpenAICompatibleModelPort`
 * (`@arbor/harness`, already used by `staged-native-safety.ts` against
 * in-process fixtures — see that file's `scriptedModel`) at a genuine
 * provider. Construction performs no I/O; `fetch` is only invoked when
 * `callLiveModel` below actually drives a completion.
 *
 * CREDENTIAL HONESTY: `resolveLiveModelConfigFromEnv` returns `null` when a
 * required environment variable is absent. Callers MUST treat `null` as "the
 * live lane cannot run" and fail loudly (see `live-ablation.ts`'s
 * `runLiveAblation`) — they must never substitute a scripted/simulated
 * outcome for a missing credential. That substitution is exactly the defect
 * this ADR exists to remove (see ADR-095's Context section on
 * `deterministicHash`).
 */
import {
  createOpenAICompatibleModelPort,
  NativeHarnessWorker,
  NativeSessionEngine,
  type NativeModelPort,
  type NativeModelResponse,
  type NativeUsageAndCost,
  type NativeUsageBudgetPort,
  type OpenAICompatibleFetch,
} from "@arbor/harness";

/** Composition-root configuration for one live-provider connection. */
export interface LiveModelConfig {
  readonly base_url: string;
  readonly provider_id: string;
  readonly model_id: string;
  readonly credential: string;
  /** USD per input/output token, for the pre-dispatch cost ceiling (live-cost-guard.ts). */
  readonly price_per_input_token_usd: number;
  readonly price_per_output_token_usd: number;
  /** No provider completion ceiling unless an operator explicitly supplies one. */
  readonly max_output_tokens: number | null;
}

const REQUIRED_ENV = Object.freeze({
  base_url: "ARBOR_EVAL_LIVE_BASE_URL",
  provider_id: "ARBOR_EVAL_LIVE_PROVIDER_ID",
  model_id: "ARBOR_EVAL_LIVE_MODEL_ID",
  credential: "ARBOR_EVAL_LIVE_API_KEY",
  price_per_input_token_usd: "ARBOR_EVAL_LIVE_PRICE_INPUT_USD",
  price_per_output_token_usd: "ARBOR_EVAL_LIVE_PRICE_OUTPUT_USD",
});
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

/**
 * Reads the live provider connection out of the process environment. Returns
 * `null` — not a default, not a fixture — the moment any required variable
 * is missing or malformed, so `runLiveAblation` can refuse to start rather
 * than silently degrading to a non-live path.
 */
export function resolveLiveModelConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LiveModelConfig | null {
  const baseUrl = env[REQUIRED_ENV.base_url];
  const providerId = env[REQUIRED_ENV.provider_id];
  const modelId = env[REQUIRED_ENV.model_id];
  const credential = env[REQUIRED_ENV.credential];
  const priceInRaw = env[REQUIRED_ENV.price_per_input_token_usd];
  const priceOutRaw = env[REQUIRED_ENV.price_per_output_token_usd];
  if (!baseUrl || !providerId || !modelId || !credential || !priceInRaw || !priceOutRaw) return null;
  const priceIn = Number(priceInRaw);
  const priceOut = Number(priceOutRaw);
  if (!Number.isFinite(priceIn) || priceIn < 0 || !Number.isFinite(priceOut) || priceOut < 0) return null;
  const maxOutputTokensRaw = env.ARBOR_EVAL_LIVE_MAX_OUTPUT_TOKENS;
  const maxOutputTokens = maxOutputTokensRaw ? Number(maxOutputTokensRaw) : DEFAULT_MAX_OUTPUT_TOKENS;
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) return null;
  return Object.freeze({
    base_url: baseUrl,
    provider_id: providerId,
    model_id: modelId,
    credential,
    price_per_input_token_usd: priceIn,
    price_per_output_token_usd: priceOut,
    max_output_tokens: maxOutputTokens,
  });
}

/**
 * Build the real model port. `fetchImpl` defaults to the platform's global
 * `fetch` (a genuine network call) but is an explicit injection seam: tests
 * supply a fake `OpenAICompatibleFetch` that returns real SSE-shaped
 * `Response` bytes, exercising the exact same adapter code
 * (`createOpenAICompatibleModelPort`) a real provider run would use — the
 * network boundary is what's faked, not the harness logic.
 */
export function createLiveModelPort(
  config: LiveModelConfig,
  fetchImpl: OpenAICompatibleFetch = (url, init) => fetch(url, init),
  observedAt: string = new Date().toISOString(),
): NativeModelPort {
  return createOpenAICompatibleModelPort({
    fetch: fetchImpl,
    base_url: config.base_url,
    provider_id: config.provider_id,
    model_id: config.model_id,
    observed_at: observedAt,
    credential_required: true,
    ...(config.max_output_tokens === null ? {} : { max_output_tokens: config.max_output_tokens }),
  });
}

export class LiveModelCallError extends Error {
  constructor(
    message: string,
    readonly cause_detail: string,
    readonly usage_and_cost: NativeUsageAndCost | null = null,
  ) {
    super(`${message}: ${cause_detail}`);
    this.name = "LiveModelCallError";
  }
}

/**
 * One bounded, non-streaming completion. Returns the response's
 * `final_message` text — the live lane always asks for a direct file-content
 * answer (see `live-tasks.ts`), never a tool-call loop, so a response with no
 * final message (only tool calls) is a protocol violation for this lane, not
 * a value to paper over.
 */
export async function callLiveModel(input: {
  readonly port: NativeModelPort;
  readonly credential: string;
  readonly session_id: string;
  readonly turn: number;
  readonly provider_id: string;
  readonly model_id: string;
  readonly prompt: string;
  readonly signal?: AbortSignal;
}): Promise<{ readonly text: string; readonly response: NativeModelResponse; readonly usage_and_cost: NativeUsageAndCost | null }> {
  const signal = input.signal ?? new AbortController().signal;
  const engine = new NativeSessionEngine({ clock: { now: () => Date.now() }, capabilities: [] });
  const usage = new MeasuredUsageCollector();
  const worker = new NativeHarnessWorker({
    session_engine: engine,
    model: input.port,
    model_tools_allowed: false,
    usage_budget: usage,
    model_credential: Object.freeze({ lease_id: `live-eval:${input.session_id}:${input.turn}`, inject: async <T>(recipient: (secret: string) => Promise<T>) => recipient(input.credential) }),
  });
  const result = await worker.run({
      start: {
      session_id: input.session_id,
      policy: {
        // No tool or approval path is composed. The provider transport is the
        // model port's injected capability, not a governed tool-network grant.
        filesystem: "read_only", approvals: "never", tool_allow: [], tool_deny: [], workspace_roots: [process.cwd()],
        max_wall_clock_ms: Number.MAX_SAFE_INTEGER, max_events: 16, network_allowed: false, ambient_plugins_allowed: false,
        user_configuration_allowed: false, inherited_credentials_allowed: false,
      },
      required_capabilities: [], lineage: { kind: "new" }, ephemeral: false,
      model_identity: { provider_id: input.provider_id, model_id: input.model_id, configured_revision: null, revision: null },
      },
      prompt: input.prompt,
      max_turns: 1,
      signal,
      // The operator owns cancellation. Retry classification/backoff remains
      // native and abort-aware without an eval-specific elapsed-time ceiling.
      retry_policy: { max_model_attempts_per_turn: 10, initial_delay_ms: 250, max_delay_ms: 30_000 },
  });
  const response: NativeModelResponse = {
    text: engine.observe(input.session_id).filter((event) => event.kind === "model_text").map((event) => ({ text: event.payload.text, phase: event.payload.phase })),
    tool_calls: [],
    final_message: result.session.terminal?.state === "completed" ? result.session.terminal.message : null,
  };
  if (response.final_message === null || response.final_message.trim().length === 0) {
    const terminal = result.session.terminal;
    throw new LiveModelCallError(
      "live model call produced no final message",
      `session=${input.session_id} turn=${input.turn} state=${result.session.state} terminal_cause=${terminal?.cause ?? "absent"} terminal_message=${terminal?.message ?? "absent"}`,
      result.usage_and_cost,
    );
  }
  return { text: response.final_message, response, usage_and_cost: result.usage_and_cost };
}

/** Preserves provider-reported usage without inventing a price or imposing a spend ceiling. */
class MeasuredUsageCollector implements NativeUsageBudgetPort {
  private observed: NativeUsageAndCost | null = null;

  admit() { return { allowed: true as const, estimate: null }; }
  observe(observation: NativeUsageAndCost) {
    this.observed = observation;
    return { observation, allowed: true as const };
  }
  total(): NativeUsageAndCost | null { return this.observed; }
}
