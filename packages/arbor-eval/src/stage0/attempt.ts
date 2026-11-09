/**
 * arbor-eval/stage0/attempt — one production attempt, end to end.
 *
 * clone fixture → provision deps → `arbor project enroll` → project config
 * commit → `arbor task <text> --tier <tier> --json --progress` → `arbor report`
 * → (if the campaign verified) `arbor adopt --apply` → this harness's own run
 * of the acceptance command on the adopted tree → protected-path check.
 *
 * This is the real CLI, the real provider and the real verifier: nothing here
 * mocks the production composition. The run directory (target clone, its
 * `.arbor` persistence, every log) is preserved whatever the outcome.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { VerifiedProvenance } from "@arbor/core";
import { assertEffectiveMatchesPreregistration, attemptConfigHome, hermeticEnv, resolveEffectiveConfig } from "./hermetic.js";
import type { EffectiveConfigRecord } from "./hermetic.js";
import { connectorIdsInTarget, providerErrorsInTarget } from "./guard.js";
import { campaignIdFromTarget, unrecordedUsage } from "./journal-usage.js";
import { runLoggedAsync, runStreamed } from "./proc.js";
import { OPERATIONAL_EXCLUDES, provisionDependencies, sha256File } from "./tasks.js";
import type { FixtureEnvironment } from "./tasks.js";
import { STAGE0_ATTEMPT_SCHEMA } from "./types.js";
import type { Stage0AttemptRecord, Stage0Experiment, Stage0FailureClass, Stage0FixtureProof, Stage0Member, Stage0ProviderError, Stage0Task, Stage0Tokens, Stage0UnrecordedUsage } from "./types.js";

export interface PriceObservation {
  readonly input_minor_units_per_million_tokens: number;
  readonly output_minor_units_per_million_tokens: number;
  readonly cache_read_minor_units_per_million_tokens: number;
  readonly cache_write_minor_units_per_million_tokens: number;
  readonly minor_unit_exponent: number;
}

export interface AttemptEnvironment {
  /** argv prefix that runs the arbor CLI, e.g. ["bun", "<repo>/packages/arbor-mcp/bin/arbor-mcp.mjs"]. */
  readonly arbor: readonly string[];
  /** The `native` block written to every attempt's project config. */
  readonly native_config: Readonly<Record<string, unknown>> & { readonly pricing: PriceObservation };
  readonly tier: "direct" | "reviewed" | "governed";
  readonly fixtures: FixtureEnvironment;
  readonly runs_root: string;
  readonly attempt_timeout_ms: number;
  /** Hard ceiling on the whole attempt, setup to acceptance (Revision 2); `arbor task` gets what is left after a reserve for the post-task steps. */
  readonly max_attempt_wall_ms?: number;
  /** ADR-191 verifier egress grants, per member, written to the attempt's `verification.network_egress`. */
  readonly network_egress?: Readonly<Partial<Record<Stage0Member, readonly { readonly argv: readonly string[]; readonly reason: string }[]>>>;
}

/** Run-guard hooks for one attempt (see `guard.ts`). */
export interface AttemptHooks {
  /** Aborted when the run must stop outright; the attempt ends `arbor task` and skips adoption. */
  readonly signal?: AbortSignal;
  /** Live priced spend and provider errors, polled from the attempt's audit log while `arbor task` runs. */
  readonly onProgress?: (costUsd: number, errors: readonly Stage0ProviderError[]) => void;
  readonly poll_ms?: number;
}

/** Time kept back from `arbor task` for report, adoption and the independent acceptance run. */
export const POST_TASK_RESERVE_MS = 150_000;

export interface AttemptSpec {
  readonly experiment: Stage0Experiment;
  readonly task: Stage0Task;
  readonly proof: Stage0FixtureProof;
  readonly seed: number;
  readonly attempt_index: number;
  readonly wave: number;
}

interface UsageSpan {
  readonly key: string;
  readonly agent_id: string | null;
  readonly phase: string | null;
  readonly tokens: Stage0Tokens;
  readonly priced_minor_units: number | null;
  readonly minor_unit_exponent: number;
}

/** Usage spans from an `arbor report --json` value, de-duplicated by idempotency key. */
export function usageSpansFromReport(report: unknown): UsageSpan[] {
  const records = ((report as { ledger?: { records?: unknown[] } })?.ledger?.records ?? []) as Array<{ observation?: Record<string, unknown> }>;
  const spans = new Map<string, UsageSpan>();
  for (const record of records) {
    const o = record.observation;
    if (o === undefined || o.type !== "usage_cost") continue;
    const key = String(o.idempotency_key ?? `${String(o.operation_id)}:${String(o.epoch)}:${String(o.phase)}`);
    const cost = o.cost as { kind?: string; minor_units?: number; minor_unit_exponent?: number } | undefined;
    spans.set(key, {
      key,
      agent_id: typeof o.agent_id === "string" ? o.agent_id : null,
      phase: typeof o.phase === "string" ? o.phase : null,
      tokens: {
        input: Number(o.input_tokens ?? 0),
        output: Number(o.output_tokens ?? 0),
        cache_read: Number(o.cache_read_tokens ?? 0),
        cache_write: Number(o.cache_write_tokens ?? 0),
      },
      priced_minor_units: cost?.kind === "priced" && typeof cost.minor_units === "number" ? cost.minor_units : null,
      minor_unit_exponent: cost?.minor_unit_exponent ?? 6,
    });
  }
  return [...spans.values()];
}

/**
 * Usage spans read straight from the campaign's audit log
 * (`.arbor/audit/<campaign>.jsonl`). `arbor report` reads the same records,
 * but it needs a loadable campaign snapshot; when the snapshot was
 * quarantined (see `quarantinedSnapshots`) the report says "not found" and
 * the spend would otherwise be lost.
 */
export function usageSpansFromAuditLog(target: string, campaignId: string): UsageSpan[] {
  const path = join(target, ".arbor", "audit", `${campaignId}.jsonl`);
  if (!existsSync(path)) return [];
  const records = readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0).map(parseJson).filter((record) => record !== null);
  return usageSpansFromReport({ ledger: { records } });
}

/** Usage spans from every campaign audit log in a target; live spend while the campaign id is still unknown. */
export function usageSpansFromAuditDir(target: string): UsageSpan[] {
  const dir = join(target, ".arbor", "audit");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".jsonl")).flatMap((name) => usageSpansFromAuditLog(target, name.slice(0, -".jsonl".length)));
}

/** Campaign snapshots the runtime quarantined as unreadable. */
export function quarantinedSnapshots(target: string, campaignId: string): string[] {
  const dir = join(target, ".arbor", "quarantine");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.startsWith(`${campaignId}.json.`)).map((name) => join(dir, name));
}

/**
 * Attempt cost: the runtime's own priced spans, plus any unpriced span
 * re-priced from the same configured price observation (reported separately
 * so the estimate is never confused with a runtime price).
 */
export function costOfSpans(spans: readonly UsageSpan[], price: PriceObservation): { priced: number; unpriced_estimate: number; unpriced_spans: number; tokens: Stage0Tokens } {
  let priced = 0;
  let unpriced = 0;
  let unpricedSpans = 0;
  const tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  const scale = 10 ** price.minor_unit_exponent;
  for (const span of spans) {
    tokens.input += span.tokens.input;
    tokens.output += span.tokens.output;
    tokens.cache_read += span.tokens.cache_read;
    tokens.cache_write += span.tokens.cache_write;
    if (span.priced_minor_units !== null) {
      priced += span.priced_minor_units / 10 ** span.minor_unit_exponent;
    } else {
      unpricedSpans++;
      unpriced += (span.tokens.input * price.input_minor_units_per_million_tokens
        + span.tokens.output * price.output_minor_units_per_million_tokens
        + span.tokens.cache_read * price.cache_read_minor_units_per_million_tokens
        + span.tokens.cache_write * price.cache_write_minor_units_per_million_tokens) / 1e6 / scale;
    }
  }
  return { priced, unpriced_estimate: unpriced, unpriced_spans: unpricedSpans, tokens };
}

/**
 * Priced spend of everything an attempt's evidence shows so far: the audit
 * spans plus the session-journal usage the audit does not cover (D9). This is
 * what the guard's kill switch reads while `arbor task` runs, so sessions that
 * are killed or crash before their node completes still count.
 */
export function liveAttemptSpend(target: string, price: PriceObservation): { cost_usd: number; spans: UsageSpan[]; unrecorded: Stage0UnrecordedUsage | null } {
  const spans = usageSpansFromAuditDir(target);
  const cost = costOfSpans(spans, price);
  const unrecorded = unrecordedUsage(target, cost.tokens, price);
  return { cost_usd: cost.priced + cost.unpriced_estimate + (unrecorded?.cost_usd ?? 0), spans, unrecorded };
}

/** Find the first value for `key` anywhere in a JSON tree. */
export function findKey(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  if (!Array.isArray(value) && key in value) return (value as Record<string, unknown>)[key];
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findKey(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Tool refusal counts from a target's harness session log, keyed `tool:code`. */
export function toolRefusals(target: string): Record<string, number> {
  const path = join(target, ".arbor", "harness-sessions.ndjson");
  const counts: Record<string, number> = {};
  if (!existsSync(path)) return counts;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.length === 0) continue;
    const record = parseJson(line) as { kind?: string; event?: { kind?: string; payload?: { tool?: string; success?: boolean; code?: string } } } | null;
    const payload = record?.event?.payload;
    if (record?.kind !== "event" || record.event?.kind !== "tool_result" || payload === undefined || payload.success !== false) continue;
    const key = `${payload.tool ?? "?"}:${payload.code ?? "?"}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

const PROVIDER_PATTERN = /\b(429|rate[ -]?limit|502|503|504|ECONNRESET|ETIMEDOUT|EAI_AGAIN|provider (?:error|unavailable)|upstream (?:error|timeout))\b/i;

/** Preregistered automatic classification; the report adjudicates each non-model class by hand. */
export function classifyAttempt(input: {
  readonly setup_failed: string | null;
  readonly task_exit: number | null;
  readonly timed_out: boolean;
  readonly campaign_id: string | null;
  readonly harness_verified: boolean;
  readonly adopted: boolean;
  readonly adopt_output: string;
  readonly independent_exit: number | null;
  readonly protected_intact: boolean;
  readonly stderr: string;
  readonly refusals: Readonly<Record<string, number>>;
  readonly provider_errors?: readonly Stage0ProviderError[];
  readonly aborted_by?: string | null;
  /** Names the wall cap that ended `arbor task` when `timed_out` (e.g. "per-attempt wall cap of 25 min"). */
  readonly timeout_cap?: string | null;
}): { failure_class: Stage0FailureClass | null; detail: string | null } {
  if (input.setup_failed !== null) return { failure_class: "capture", detail: input.setup_failed };
  const providerErrors = input.provider_errors ?? [];
  if (input.harness_verified) {
    if (!input.adopted) {
      return /scope_unadoptable|out of scope|scope/i.test(input.adopt_output)
        ? { failure_class: "capture", detail: "verified but unadoptable (scope)" }
        : { failure_class: "harness", detail: "verified but adoption failed" };
    }
    if (!input.protected_intact) return { failure_class: "harness", detail: "verified and adopted, but a protected specification file changed" };
    if (input.independent_exit !== 0) return { failure_class: "harness", detail: `verified and adopted, but independent acceptance exited ${String(input.independent_exit)}` };
    return { failure_class: null, detail: null };
  }
  // A provider error recorded in the campaign's own logs outranks every other reading: the
  // 2026-10-07 run classified 399 HTTP 402 attempts as `model` because it looked only at stderr.
  if (providerErrors.length > 0) return { failure_class: "provider", detail: `provider error: ${providerErrors[0].signature}` };
  if (input.aborted_by != null) return { failure_class: "aborted", detail: `aborted by the run guard: ${input.aborted_by}` };
  // §11.3: an attempt cut off by a wall cap is `aborted`, not a harness defect (D10).
  if (input.timed_out) return { failure_class: "aborted", detail: `arbor task cut off by the ${input.timeout_cap ?? "attempt timeout"}` };
  if (input.campaign_id === null) {
    return PROVIDER_PATTERN.test(input.stderr)
      ? { failure_class: "provider", detail: "no campaign; provider error in stderr" }
      : { failure_class: "harness", detail: `no campaign id (arbor task exit ${String(input.task_exit)})` };
  }
  const allowlist = Object.entries(input.refusals).filter(([key]) => key.endsWith(":command_not_allowlisted")).reduce((sum, [, n]) => sum + n, 0);
  if (allowlist >= 5) return { failure_class: "harness", detail: `command_not_allowlisted refusals: ${allowlist}` };
  if (input.task_exit !== 0 && input.task_exit !== 3) {
    return PROVIDER_PATTERN.test(input.stderr)
      ? { failure_class: "provider", detail: `arbor task exit ${String(input.task_exit)}; provider error in stderr` }
      : { failure_class: "harness", detail: `arbor task exit ${String(input.task_exit)}` };
  }
  return { failure_class: "model", detail: "campaign completed without a verified result" };
}

export function attemptRunDir(runsRoot: string, spec: Pick<AttemptSpec, "experiment" | "task" | "seed" | "attempt_index">): string {
  return join(runsRoot, spec.experiment, spec.task.id, `s${spec.seed}`, `a${spec.attempt_index}`);
}

let enrollChain: Promise<unknown> = Promise.resolve();

/** Serialise a step across concurrent attempts (enrolment writes a shared project registry). */
function serially<T>(fn: () => Promise<T>): Promise<T> {
  const next = enrollChain.then(fn, fn);
  enrollChain = next.catch(() => undefined);
  return next;
}

export async function runAttempt(spec: AttemptSpec, env: AttemptEnvironment, hooks: AttemptHooks = {}): Promise<Stage0AttemptRecord> {
  const { task, proof } = spec;
  let runDir = attemptRunDir(env.runs_root, spec);
  // A crashed earlier try keeps its directory; this try gets a fresh sibling.
  for (let retry = 1; existsSync(runDir); retry++) runDir = `${attemptRunDir(env.runs_root, spec)}-r${retry}`;
  const target = join(runDir, "target");
  const logs = join(runDir, "logs");
  mkdirSync(logs, { recursive: true });
  const started = new Date();
  const deadline = started.getTime() + (env.max_attempt_wall_ms ?? Number.POSITIVE_INFINITY);
  const remaining = (fallback: number) => Math.max(5_000, Math.min(fallback, deadline - Date.now()));
  const note = (event: string, detail: Record<string, unknown> = {}) =>
    appendFileSync(join(runDir, "events.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`);
  note("attempt_started", { task: task.id, seed: spec.seed, attempt_index: spec.attempt_index, wave: spec.wave });

  // Hermetic config scope (D4): no user/organization layer, no ARBOR_CONFIG__* overrides.
  const childEnv = hermeticEnv(process.env, attemptConfigHome(runDir));
  let effectiveConfig: EffectiveConfigRecord | null = null;
  let setupFailed: string | null = null;
  try {
    const clone = await runLoggedAsync(logs, "clone", ["git", "clone", "-q", proof.fixture_repo, target], runDir);
    if (clone.exit_code !== 0) throw new Error("clone of fixture failed");
    const head = (await runLoggedAsync(logs, "rev-parse", ["git", "rev-parse", "HEAD"], target)).stdout.trim();
    if (head !== proof.fixture_commit) throw new Error(`fixture commit mismatch ${head}`);
    await runLoggedAsync(logs, "git-config-email", ["git", "config", "user.email", "stage0@revoy.invalid"], target);
    await runLoggedAsync(logs, "git-config-name", ["git", "config", "user.name", "Revoy Stage0"], target);
    appendFileSync(join(target, ".git", "info", "exclude"), OPERATIONAL_EXCLUDES);
    provisionDependencies(task.member, target, env.fixtures, logs);
    const enroll = await serially(() => runLoggedAsync(logs, "enroll", [...env.arbor, "project", "enroll", ".", "--json"], target, { timeoutMs: 120_000, env: childEnv }));
    // Exit 4 is the registry refusing a project without a conformant profile (`conformance_failed`);
    // the enrolment itself is usable when the inspection reports `ready`, as in the 2026-10-06 cohort runs.
    const enrolled = (parseJson(enroll.stdout) as { inspection?: { state?: string } } | null)?.inspection?.state === "ready";
    if (!(enroll.exit_code === 0 || (enroll.exit_code === 4 && enrolled))) throw new Error(`arbor project enroll exited ${String(enroll.exit_code)}`);
    const egress = env.network_egress?.[task.member] ?? [];
    const verificationConfig = egress.length === 0 ? { acceptance_commands: [task.acceptance] } : { acceptance_commands: [task.acceptance], network_egress: egress };
    const config = { native: env.native_config, verification: verificationConfig, kb: { backend: "jsonl" } };
    writeFileSync(join(target, "arbor.jsonc"), `${JSON.stringify(config, null, 2)}\n`);
    // Resolve what arbor will actually run with, record it, and refuse a drift from the preregistered values.
    const resolved = resolveEffectiveConfig(target, childEnv);
    effectiveConfig = resolved.record;
    writeFileSync(join(runDir, "effective-config.json"), `${JSON.stringify({ sha256: resolved.record.sha256, config: resolved.record.config }, null, 2)}\n`);
    assertEffectiveMatchesPreregistration(resolved.effective, env.native_config);
    await runLoggedAsync(logs, "add-config", ["git", "add", "--", "arbor.jsonc"], target);
    const commit = await runLoggedAsync(logs, "commit-config", ["git", "commit", "-q", "-m", "chore: stage0 project config"], target);
    if (commit.exit_code !== 0) throw new Error("config commit failed");
    const dirty = (await runLoggedAsync(logs, "status-setup", ["git", "status", "--porcelain"], target)).stdout.trim();
    if (dirty.length > 0) throw new Error(`target dirty after setup: ${dirty.slice(0, 200)}`);
  } catch (error) {
    setupFailed = (error as Error).message;
    note("setup_failed", { error: setupFailed });
  }

  const configCommit = setupFailed === null ? (await runLoggedAsync(logs, "rev-parse-config", ["git", "rev-parse", "HEAD"], target)).stdout.trim() : "";
  let taskExit: number | null = null;
  let timedOut = false;
  let campaignId: string | null = null;
  let haltReason: string | null = null;
  let harnessVerified = false;
  let verification: VerifiedProvenance | null = null;
  let adoptExit: number | null = null;
  let adoptOutput = "";
  let independentExit: number | null = null;
  let changedPaths: string[] = [];
  let protectedIntact = true;
  let spans: UsageSpan[] = [];
  let refusals: Record<string, number> = {};
  let stderr = "";
  let abortedBy: string | null = null;
  let timeoutCap: string | null = null;
  let recoveredCampaignId: string | null = null;
  let providerErrors: Stage0ProviderError[] = [];
  let connectorIds: string[] = [];
  const abortReason = () => (hooks.signal?.reason instanceof Error ? hooks.signal.reason.message : "run guard stop");

  if (setupFailed === null && hooks.signal?.aborted === true) abortedBy = abortReason();
  if (setupFailed === null && abortedBy === null) {
    const taskTimeout = Math.max(30_000, Math.min(env.attempt_timeout_ms, deadline - Date.now() - POST_TASK_RESERVE_MS));
    const poll = hooks.onProgress === undefined ? null : setInterval(() => {
      try {
        hooks.onProgress?.(liveAttemptSpend(target, env.native_config.pricing).cost_usd, providerErrorsInTarget(target));
      } catch {
        // A torn line mid-write is read again on the next tick.
      }
    }, hooks.poll_ms ?? 5_000);
    const run = await runStreamed(logs, "arbor-task", [...env.arbor, "task", task.task_text, "--tier", env.tier, "--json", "--progress"], target, taskTimeout, childEnv, hooks.signal);
    if (poll !== null) clearInterval(poll);
    if (run.timed_out) timeoutCap = taskTimeout < env.attempt_timeout_ms ? `per-attempt wall cap (${Math.round((env.max_attempt_wall_ms ?? taskTimeout) / 60_000)} min total, ${Math.round(taskTimeout / 60_000)} min left for arbor task)` : `attempt timeout of ${Math.round(env.attempt_timeout_ms / 60_000)} min`;
    taskExit = run.exit_code;
    timedOut = run.timed_out;
    if (run.aborted) abortedBy = abortReason();
    note("arbor_task_finished", { exit_code: run.exit_code, timed_out: run.timed_out, aborted: run.aborted, timeout_ms: taskTimeout, ms: run.ms });
    const stdout = readFileSync(join(logs, "arbor-task.stdout.log"), "utf8");
    stderr = readFileSync(join(logs, "arbor-task.stderr.log"), "utf8");
    const taskJson = parseJson(stdout);
    const result = findKey(taskJson, "campaign_result") as Record<string, unknown> | undefined;
    const idValue = result?.campaign_id ?? findKey(taskJson, "campaign_id") ?? /"campaign_id"\s*:\s*"([^"]+)"/.exec(stdout)?.[1];
    campaignId = typeof idValue === "string" ? idValue : null;
    haltReason = typeof result?.halt_reason === "string" ? result.halt_reason : null;
    if (campaignId !== null) {
      const report = await runLoggedAsync(logs, "report", [...env.arbor, "report", "--campaign", campaignId, "--json"], target, { timeoutMs: remaining(300_000), env: childEnv });
      const value = (parseJson(report.stdout) as { value?: unknown } | null)?.value ?? null;
      spans = usageSpansFromReport(value);
      if (spans.length === 0) spans = usageSpansFromAuditLog(target, campaignId);
      const campaign = (value as { campaign?: { nodes?: Array<{ id: string; state: string; provenance?: { tag?: string; exit?: number } }>; halt_reason?: string } } | null)?.campaign;
      haltReason = haltReason ?? campaign?.halt_reason ?? null;
      const verifiedNode = (campaign?.nodes ?? []).find((node) => node.id !== "root" && node.state === "verified" && node.provenance?.tag === "verified" && node.provenance.exit === 0);
      if (verifiedNode !== undefined) {
        harnessVerified = true;
        verification = verifiedNode.provenance as VerifiedProvenance;
      }
      if (harnessVerified && abortedBy === null) {
        const apply = await runLoggedAsync(logs, "adopt-apply", [...env.arbor, "adopt", "--campaign", campaignId, "--apply", "--json"], target, { timeoutMs: remaining(300_000), env: childEnv });
        adoptExit = apply.exit_code;
        adoptOutput = `${apply.stdout}\n${apply.stderr}`;
      }
    }
    // An aborted or crashed `arbor task` may print no campaign id; its spend is still in the audit log.
    if (spans.length === 0) spans = usageSpansFromAuditDir(target);
    changedPaths = (await runLoggedAsync(logs, "diff-names", ["git", "diff", "--name-only", configCommit], target)).stdout.split("\n").filter((line) => line.length > 0);
    await runLoggedAsync(logs, "diff", ["git", "diff", "--binary", configCommit], target);
    await runLoggedAsync(logs, "status-after", ["git", "status", "--porcelain"], target);
    for (const [path, sha] of Object.entries(proof.protected_sha256)) {
      const full = join(target, path);
      if (!existsSync(full) || sha256File(full) !== sha) protectedIntact = false;
    }
    if (harnessVerified && adoptExit === 0) {
      const independent = await runLoggedAsync(logs, "independent-acceptance", [...task.acceptance], target, { timeoutMs: remaining(900_000) });
      independentExit = independent.exit_code;
    }
    refusals = toolRefusals(target);
    // A cap or crash can end `arbor task` before it reports a campaign id; the run dir still names it (D10).
    if (campaignId === null) recoveredCampaignId = campaignIdFromTarget(target);
  }
  if (setupFailed === null) {
    providerErrors = providerErrorsInTarget(target, stderr);
    connectorIds = connectorIdsInTarget(target);
  }

  const adopted = harnessVerified && adoptExit === 0 && changedPaths.length > 0;
  const cost = costOfSpans(spans, env.native_config.pricing);
  // Sessions that never finished reach the journal but not the audit spans (D9).
  const unrecorded = setupFailed === null ? unrecordedUsage(target, cost.tokens, env.native_config.pricing) : null;
  const quarantined = campaignId === null ? [] : quarantinedSnapshots(target, campaignId);
  const classification = quarantined.length > 0 && !harnessVerified
    ? { failure_class: "harness" as const, detail: `campaign snapshot quarantined by the runtime (halt ${String(haltReason)}); report unavailable` }
    : classifyAttempt({
      setup_failed: setupFailed,
      task_exit: taskExit,
      timed_out: timedOut,
      campaign_id: campaignId,
      harness_verified: harnessVerified,
      adopted,
      adopt_output: adoptOutput,
      independent_exit: independentExit,
      protected_intact: protectedIntact,
      stderr,
      refusals,
      provider_errors: providerErrors,
      aborted_by: abortedBy,
      timeout_cap: timeoutCap,
    });
  const finished = new Date();
  const record: Stage0AttemptRecord = {
    schema: STAGE0_ATTEMPT_SCHEMA,
    experiment: spec.experiment,
    task_id: task.id,
    seed: spec.seed,
    attempt_index: spec.attempt_index,
    wave: spec.wave,
    started_at: started.toISOString(),
    finished_at: finished.toISOString(),
    wall_ms: finished.getTime() - started.getTime(),
    campaign_id: campaignId ?? recoveredCampaignId,
    arbor_task_exit: taskExit,
    arbor_task_timed_out: timedOut,
    halt_reason: haltReason,
    harness_verified: harnessVerified,
    verification,
    adopt_apply_exit: adoptExit,
    adopted,
    changed_paths: changedPaths,
    independent_acceptance_exit: independentExit,
    protected_paths_intact: protectedIntact,
    verified_and_adopted: classification.failure_class === null && harnessVerified,
    cost_usd: cost.priced + cost.unpriced_estimate + (unrecorded?.cost_usd ?? 0),
    cost_priced_usd: cost.priced,
    cost_unpriced_estimate_usd: cost.unpriced_estimate,
    unpriced_spans: cost.unpriced_spans,
    tokens: cost.tokens,
    unrecorded_usage: unrecorded,
    failure_class: classification.failure_class,
    failure_detail: classification.detail,
    run_dir: runDir,
    provider_errors: providerErrors,
    connector_ids: connectorIds,
    aborted_by: abortedBy,
    effective_config: effectiveConfig?.config ?? null,
    effective_config_sha256: effectiveConfig?.sha256 ?? null,
  };
  writeFileSync(join(runDir, "attempt.json"), `${JSON.stringify({ ...record, tool_refusals: refusals, usage_spans: spans }, null, 2)}\n`);
  note("attempt_finished", { verified_and_adopted: record.verified_and_adopted, failure_class: record.failure_class });
  return record;
}
