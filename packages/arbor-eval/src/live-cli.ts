/**
 * arbor-eval/live-cli — `arbor-eval live` subcommand (ADR-095).
 *
 * Runs on a slower cadence than `gate:eval-regression` (nightly/pre-release,
 * never every push — ADR-095 Decision 3, ADR-095 Obligation O2): it costs
 * real money, so nothing in this package invokes it from a push-blocking
 * gate. An operator (or a dedicated, non-blocking scheduled job) runs it
 * explicitly: `bun packages/arbor-eval/src/cli.ts live`.
 *
 * CREDENTIAL HONESTY: if `ARBOR_EVAL_LIVE_*` environment variables are not
 * fully configured, this refuses to run rather than silently falling back to
 * the scripted `runBenchmark`/`runBaseline` path — see
 * `live-model-port.ts`'s `resolveLiveModelConfigFromEnv`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveLiveModelConfigFromEnv, createLiveModelPort } from "./live-model-port.js";
import type { LiveModelConfig } from "./live-model-port.js";
import {
  FRONTIER_FLASH_TESTING_PROFILE,
  resolveFrontierFlashTestingProfile,
} from "./frontier-flash-profile.js";
import { runLiveAblation } from "./live-ablation.js";
import { generateLiveAblationReport } from "./live-report.js";
import { defaultLiveTasks } from "./live-tasks.js";

export interface LiveCliArgs {
  readonly runsPerArmPerTask: number;
  readonly maxCallsPerRun: number;
  readonly costCeilingUsd: number | null;
  readonly estimatedPromptTokensPerCall: number;
  readonly maxOutputTokensPerCall: number | null;
  readonly outputDir: string;
  readonly frontierFlashAttestation: string | null;
}

const DEFAULTS: LiveCliArgs = Object.freeze({
  runsPerArmPerTask: 3,
  maxCallsPerRun: 3,
  costCeilingUsd: null,
  estimatedPromptTokensPerCall: 800,
  maxOutputTokensPerCall: null,
  outputDir: ".arbor/eval",
  frontierFlashAttestation: null,
});

export function parseLiveArgs(argv: string[]): LiveCliArgs {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i];
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "true";
      args.set(key, val);
      if (val !== "true") i++;
    }
  }
  return {
    runsPerArmPerTask: positiveRequiredInteger(args.get("--runs") ?? String(DEFAULTS.runsPerArmPerTask), "--runs"),
    maxCallsPerRun: positiveRequiredInteger(args.get("--max-calls") ?? String(DEFAULTS.maxCallsPerRun), "--max-calls"),
    costCeilingUsd: positiveOptionalNumber(args.get("--cost-ceiling-usd"), "--cost-ceiling-usd"),
    estimatedPromptTokensPerCall: parseInt(args.get("--estimated-prompt-tokens") ?? String(DEFAULTS.estimatedPromptTokensPerCall), 10),
    maxOutputTokensPerCall: positiveOptionalInteger(args.get("--max-output-tokens"), "--max-output-tokens"),
    outputDir: args.get("--output") ?? DEFAULTS.outputDir,
    frontierFlashAttestation: args.get("--frontier-flash-attestation") ?? null,
  };
}

const FRONTIER_FLASH_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const FRONTIER_FLASH_ATTESTATION_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * Resolve the explicit economy test lane. The attestation contains public
 * catalog facts only; the separately scoped test credential remains in the
 * environment and no generic provider/model/base-url override is consulted.
 */
export function resolveFrontierFlashLiveConfig(input: {
  readonly attestationPath: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly nowMs?: number;
  readonly maxOutputTokens?: number | null;
}): LiveModelConfig {
  const env = input.env ?? process.env;
  const credential = env.ARBOR_EVAL_FRONTIER_FLASH_API_KEY;
  let catalogAttestation: unknown;
  try {
    catalogAttestation = JSON.parse(readFileSync(input.attestationPath, "utf-8")) as unknown;
  } catch (error) {
    throw new Error(`arbor-eval live: Flash catalog attestation is unreadable or invalid JSON (${error instanceof Error ? error.message : String(error)}); result is unmeasured`);
  }
  const outcome = resolveFrontierFlashTestingProfile({
    profile: FRONTIER_FLASH_TESTING_PROFILE,
    credential,
    catalog_attestation: catalogAttestation,
    now_ms: input.nowMs ?? Date.now(),
    max_attestation_age_ms: FRONTIER_FLASH_ATTESTATION_MAX_AGE_MS,
  });
  if (outcome.status !== "ready") {
    throw new Error(`arbor-eval live: Flash profile ${outcome.status} (${outcome.reason}); result is unmeasured and no fallback was selected`);
  }
  const priceInput = outcome.catalog_attestation.observed_metadata.price_input_usd_per_token;
  const priceOutput = outcome.catalog_attestation.observed_metadata.price_output_usd_per_token;
  if (priceInput === undefined || priceOutput === undefined) {
    throw new Error("arbor-eval live: Flash catalog attestation has incomplete input/output price metadata; result is unmeasured");
  }
  return Object.freeze({
    base_url: FRONTIER_FLASH_OPENROUTER_BASE_URL,
    provider_id: outcome.profile.provider_id,
    model_id: outcome.profile.model_id,
    credential: credential!,
    price_per_input_token_usd: priceInput,
    price_per_output_token_usd: priceOutput,
    max_output_tokens: input.maxOutputTokens ?? null,
  });
}

/**
 * The real, network-capable entrypoint. `main()` in `cli.ts` dispatches here
 * for `arbor-eval live ...` and never falls back to the scripted benchmark
 * on failure — a thrown error here is a real refusal (missing credential,
 * cost ceiling exceeded), not something to paper over.
 */
export async function runLiveCli(argv: string[]): Promise<void> {
  const args = parseLiveArgs(argv);
  const config = args.frontierFlashAttestation === null
    ? resolveLiveModelConfigFromEnv()
    : resolveFrontierFlashLiveConfig({ attestationPath: args.frontierFlashAttestation, maxOutputTokens: args.maxOutputTokensPerCall });
  if (config === null) {
    throw new Error(
      "arbor-eval live: missing live-provider configuration. Set ARBOR_EVAL_LIVE_BASE_URL, " +
      "ARBOR_EVAL_LIVE_PROVIDER_ID, ARBOR_EVAL_LIVE_MODEL_ID, ARBOR_EVAL_LIVE_API_KEY, " +
      "ARBOR_EVAL_LIVE_PRICE_INPUT_USD, and ARBOR_EVAL_LIVE_PRICE_OUTPUT_USD. This lane never " +
      "substitutes a scripted outcome for a missing credential (ADR-095).",
    );
  }
  const port = createLiveModelPort(config);
  const interruption = new AbortController();
  const abort = () => interruption.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
  const report = await runLiveAblation({
    tasks: defaultLiveTasks,
    model_port: port,
    credential: config.credential,
    provider_id: config.provider_id,
    model_id: config.model_id,
    runs_per_arm_per_task: args.runsPerArmPerTask,
    max_calls_per_run: args.maxCallsPerRun,
    cost_ceiling_usd: args.costCeilingUsd,
    estimated_prompt_tokens_per_call: args.estimatedPromptTokensPerCall,
    max_output_tokens_per_call: config.max_output_tokens,
    price_per_input_token_usd: config.price_per_input_token_usd,
    price_per_output_token_usd: config.price_per_output_token_usd,
    signal: interruption.signal,
  });
  const reportText = generateLiveAblationReport(report);
  mkdirSync(args.outputDir, { recursive: true });
  const reportPath = join(args.outputDir, `live-report-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  writeFileSync(reportPath, reportText, "utf-8");
  writeFileSync(join(args.outputDir, "live-ablation.json"), `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  console.log(reportText);
  console.error(`\nLive ablation report written to: ${reportPath}`);
  for (const finding of report.falsifiability.filter((f) => f.triggered)) {
    console.error(`\nFALSIFIABILITY FINDING TRIGGERED (${finding.claim}) — ${finding.detail}`);
  }
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

function positiveOptionalInteger(value: string | undefined, flag: string): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive safe integer when supplied`);
  return parsed;
}

function positiveRequiredInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive safe integer`);
  return parsed;
}

function positiveOptionalNumber(value: string | undefined, flag: string): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive finite number when supplied`);
  return parsed;
}
