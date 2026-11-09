#!/usr/bin/env bun
/**
 * arbor-eval/stage0/cli — the Stage 0 instrument's entry point.
 *
 *   bun packages/arbor-eval/src/stage0/cli.ts build-fixtures --cohort <external-cohort.json> --sources <dir> --work <dir> --out <tasks.json>
 *   bun packages/arbor-eval/src/stage0/cli.ts run --experiment pilot|full --tasks <tasks.json> --work <dir> --native-config <json> [--caps rev2-pilot|rev2-pilot-25min|<caps.json>] [--preregistration <md>] [--cohort <external-cohort.json>] [--max-in-flight <n>] [options]
 *   bun packages/arbor-eval/src/stage0/cli.ts analyze --tasks <tasks.json> --ledger <ledger.jsonl> --experiment full --usd-unit <usd> [--out <json>]
 *   bun packages/arbor-eval/src/stage0/cli.ts pilot-summary --ledger <ledger.jsonl> --units <n> [--k 4] [--max-budget 8]
 *
 * See docs/research/uct-search/stage0-preregistration.md for the protocol.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeStage0 } from "./analysis.js";
import { runAttempt } from "./attempt.js";
import { deriveCorrections } from "./audit.js";
import type { AttemptEnvironment } from "./attempt.js";
import { attemptKey, cohortEgressGrants, STAGE0_CAPS_PRESETS, Stage0RunGuard, validateRunPlan } from "./guard.js";
import type { Stage0RunCaps } from "./guard.js";
import { appendLedger, freezePreregistration, logEvent, readLedger } from "./ledger.js";
import { assertEffectiveMatchesPreregistration, hermeticEnv, resolveEffectiveConfig } from "./hermetic.js";
import { median, mean, quantile } from "./stats.js";
import { preregisteredUnitOrder, runUnits } from "./scheduler.js";
import { buildFixture, enumerateCandidates, exportPristine, listFilesRecursive, STAGE0_GENERATOR_VERSION, STAGE0_QUOTAS } from "./tasks.js";
import type { FixtureEnvironment } from "./tasks.js";
import { runLogged } from "./proc.js";
import type { Stage0Design, Stage0Experiment, Stage0FixtureProof, Stage0Member, Stage0Task } from "./types.js";

export const STAGE0_MANIFEST_SCHEMA = "revoy2.stage0.tasks.v1";

export interface Stage0Manifest {
  readonly schema: typeof STAGE0_MANIFEST_SCHEMA;
  readonly generator_version: string;
  readonly generated_at: string;
  readonly cohort: Readonly<Record<string, { readonly repository: string; readonly revision: string }>>;
  readonly work: string;
  readonly fixtures: FixtureEnvironment;
  readonly tasks: readonly { readonly task: Stage0Task; readonly proof: Stage0FixtureProof }[];
  readonly rejected: readonly { readonly task: Stage0Task; readonly proof: Stage0FixtureProof }[];
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

function flags(argv: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out.set(argv[i].slice(2), "true");
    else out.set(argv[i].slice(2), argv[++i]);
  }
  return out;
}

function required(f: Map<string, string>, name: string): string {
  const value = f.get(name);
  if (value === undefined) throw new Error(`missing --${name}`);
  return value;
}

const numbers = (text: string): number[] => text.split(",").map((part) => Number(part.trim()));

async function buildFixtures(f: Map<string, string>): Promise<void> {
  const cohort = JSON.parse(readFileSync(required(f, "cohort"), "utf8")) as { members: Array<{ id: Stage0Member; repository: string; revision: string }> };
  const sources = resolve(required(f, "sources"));
  const work = resolve(required(f, "work"));
  const out = resolve(required(f, "out"));
  const only = f.get("member") as Stage0Member | undefined;
  const logs = join(work, "logs");
  mkdirSync(logs, { recursive: true });
  const pristine = {} as Record<Stage0Member, string>;
  for (const member of cohort.members) {
    const dest = join(work, "pristine", member.id);
    if (!existsSync(dest)) exportPristine({ member: member.id, repo: join(sources, member.id), revision: member.revision }, dest, logs);
    pristine[member.id] = dest;
  }
  // yocto-queue dependencies, installed once from the registry, hardlink-copied afterwards.
  const deps = join(work, "deps", "yocto-queue");
  if (!existsSync(join(deps, "node_modules"))) {
    mkdirSync(deps, { recursive: true });
    runLogged(logs, "deps-copy", ["cp", "-a", `${pristine["yocto-queue"]}/.`, deps], work);
    const install = runLogged(logs, "deps-npm-install", ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"], deps, { timeoutMs: 900_000 });
    if (install.exit_code !== 0) throw new Error("npm install for yocto-queue failed");
  }
  // semver's Cargo.lock, resolved once on the host (the verification sandbox has no usable CA store, D3).
  const lockDir = join(work, "deps", "semver");
  if (!existsSync(join(lockDir, "Cargo.lock"))) {
    mkdirSync(lockDir, { recursive: true });
    runLogged(logs, "lock-copy", ["cp", "-a", `${pristine.semver}/.`, lockDir], work);
    const lock = runLogged(logs, "cargo-generate-lockfile", ["cargo", "generate-lockfile"], lockDir, { timeoutMs: 600_000 });
    if (lock.exit_code !== 0) throw new Error("cargo generate-lockfile failed");
    const fetch = runLogged(logs, "cargo-fetch", ["cargo", "fetch", "--locked"], lockDir, { timeoutMs: 600_000 });
    if (fetch.exit_code !== 0) throw new Error("cargo fetch failed");
  }
  const env: FixtureEnvironment = {
    fixtures_root: join(work, "fixtures"),
    pristine,
    node_modules_cache: join(deps, "node_modules"),
    cargo_lock: join(lockDir, "Cargo.lock"),
  };
  const previous = existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as Stage0Manifest) : null;
  const tasks = [...(previous?.tasks ?? [])].filter((entry) => only === undefined || entry.task.member !== only);
  const rejected = [...(previous?.rejected ?? [])].filter((entry) => only === undefined || entry.task.member !== only);
  for (const member of cohort.members) {
    if (only !== undefined && member.id !== only) continue;
    const readPristine = (path: string) => readFileSync(join(pristine[member.id], path), "utf8");
    const listPristine = (dir: string) => listFilesRecursive(pristine[member.id], dir);
    let admitted = 0;
    for (const candidate of enumerateCandidates(member.id, readPristine, listPristine)) {
      if (admitted >= STAGE0_QUOTAS[member.id]) break;
      process.stderr.write(`[stage0] building ${candidate.task.id}\n`);
      const proof = await buildFixture(candidate, env);
      process.stderr.write(`[stage0]   red=${String(proof.baseline_exit)} green=${String(proof.reference_exit)} admitted=${proof.admitted}\n`);
      if (proof.admitted) {
        admitted++;
        tasks.push({ task: candidate.task, proof });
      } else rejected.push({ task: candidate.task, proof });
    }
  }
  const manifest: Stage0Manifest = {
    schema: STAGE0_MANIFEST_SCHEMA,
    generator_version: STAGE0_GENERATOR_VERSION,
    generated_at: new Date().toISOString(),
    cohort: Object.fromEntries(cohort.members.map((m) => [m.id, { repository: m.repository, revision: m.revision }])),
    work,
    fixtures: env,
    tasks,
    rejected,
  };
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ admitted: tasks.length, rejected: rejected.length, out }, null, 2)}\n`);
}

async function run(f: Map<string, string>): Promise<void> {
  const experiment = required(f, "experiment") as Stage0Experiment;
  const manifest = JSON.parse(readFileSync(required(f, "tasks"), "utf8")) as Stage0Manifest;
  const work = resolve(required(f, "work"));
  const native = JSON.parse(readFileSync(required(f, "native-config"), "utf8")) as AttemptEnvironment["native_config"];
  const ledger = f.get("ledger") ?? join(work, `ledger-${experiment}.jsonl`);
  // D5: the driver owns its work directory and the preregistration freeze event.
  mkdirSync(work, { recursive: true });
  const preregistration = resolve(f.get("preregistration") ?? join(f.get("repo") ?? REPO_ROOT, "docs/research/uct-search/stage0-preregistration.md"));
  const frozen = freezePreregistration(ledger, experiment, preregistration);
  // D4: before any live call, the config arbor would run with must carry the preregistered native values.
  const probe = join(work, "config-probe");
  mkdirSync(probe, { recursive: true });
  writeFileSync(join(probe, "arbor.jsonc"), `${JSON.stringify({ native }, null, 2)}\n`);
  const probed = resolveEffectiveConfig(probe, hermeticEnv(process.env, join(probe, "config-home")));
  assertEffectiveMatchesPreregistration(probed.effective, native);
  const seeds = numbers(f.get("seeds") ?? "0,1,2,3");
  const k = Number(f.get("k") ?? "4");
  const maxBudget = Number(f.get("max-budget") ?? "8");
  const usdUnit = Number(required(f, "usd-unit"));
  const filter = f.get("task-ids")?.split(",") ?? null;
  const entries = manifest.tasks.filter((entry) => filter === null || filter.includes(entry.task.id));
  const byMember = (["more-itertools", "semver", "yocto-queue"] as const).map((member) => entries.filter((e) => e.task.member === member).map((e) => e.task.id));
  const units = preregisteredUnitOrder(byMember, seeds);
  const lookup = new Map(entries.map((entry) => [entry.task.id, entry]));
  const capsFlag = f.get("caps");
  const caps: Stage0RunCaps | null = capsFlag === undefined ? null : STAGE0_CAPS_PRESETS[capsFlag] ?? (JSON.parse(readFileSync(capsFlag, "utf8")) as Stage0RunCaps);
  const cohortFlag = f.get("cohort");
  const networkEgress = cohortFlag === undefined ? undefined : cohortEgressGrants(JSON.parse(readFileSync(cohortFlag, "utf8")) as Parameters<typeof cohortEgressGrants>[0]);
  const env: AttemptEnvironment = {
    arbor: ["bun", join(f.get("repo") ?? REPO_ROOT, "packages/arbor-mcp/bin/arbor-mcp.mjs")],
    ...(caps === null ? {} : { max_attempt_wall_ms: caps.max_attempt_wall_ms }),
    ...(networkEgress === undefined ? {} : { network_egress: networkEgress }),
    native_config: native,
    tier: (f.get("tier") ?? "reviewed") as AttemptEnvironment["tier"],
    fixtures: manifest.fixtures,
    runs_root: join(work, "runs"),
    attempt_timeout_ms: Number(f.get("attempt-timeout-min") ?? "40") * 60_000,
  };
  const deadline = Date.now() + Number(f.get("deadline-min") ?? "240") * 60_000;
  const existing = readLedger(ledger, experiment).attempts;
  const maxInFlight = Number(f.get("max-in-flight") ?? String(caps?.max_in_flight ?? Number.POSITIVE_INFINITY));
  let guard: Stage0RunGuard | null = null;
  if (caps !== null) {
    // Refuse before any live call when the plan or the native config exceeds a cap.
    const errors = validateRunPlan({ units, max_attempts_per_unit: maxBudget, native_config: native, attempt_timeout_ms: env.attempt_timeout_ms, max_in_flight: maxInFlight }, caps);
    if (errors.length > 0) throw new Error(`run plan exceeds the caps:\n- ${errors.join("\n- ")}`);
    const budget = (native as { usage_budget?: { max_campaign_cost?: { minor_units: number; minor_unit_exponent?: number } } }).usage_budget?.max_campaign_cost;
    guard = new Stage0RunGuard({
      caps,
      spent_usd: existing.reduce((sum, a) => sum + a.cost_usd, 0),
      attempts_already_run: existing.length,
      per_attempt_reserve_usd: budget === undefined ? caps.usd_kill_switch : budget.minor_units / 10 ** (budget.minor_unit_exponent ?? 6),
      onStop: (reason, detail) => {
        process.stderr.write(`[stage0] ${new Date().toISOString()} GUARD STOP ${reason}: ${detail}\n`);
        logEvent(ledger, experiment, "guard_stop", { reason, detail });
      },
    });
    guard.arm();
  }
  logEvent(ledger, experiment, "run_started", { caps_preset: capsFlag === undefined || STAGE0_CAPS_PRESETS[capsFlag] === undefined ? (capsFlag === undefined ? null : "custom-file") : capsFlag, max_attempt_wall_ms: caps?.max_attempt_wall_ms ?? null, preregistration_sha256: frozen.sha256, effective_config_sha256: probed.record.sha256, caps, max_in_flight: maxInFlight, network_egress: networkEgress ?? null,  units: units.length, seeds, k, max_budget: maxBudget, usd_unit: usdUnit, tier: env.tier, deadline: new Date(deadline).toISOString(), usd_ceiling: Number(f.get("usd-ceiling") ?? "Infinity"), existing_attempts: existing.length, arbor: env.arbor });
  const result = await runUnits({
    experiment,
    units,
    k,
    max_budget: maxBudget,
    usd_unit: usdUnit,
    unit_concurrency: Number(f.get("unit-concurrency") ?? "2"),
    deadline_ms: deadline,
    usd_ceiling: Number(f.get("usd-ceiling") ?? "Infinity"),
    existing,
    ...(guard === null ? {} : { guard }),
    max_in_flight: maxInFlight,
    runAttempt: async (unit, attemptIndex, wave, signal) => {
      const entry = lookup.get(unit.task_id);
      if (entry === undefined) throw new Error(`unknown task ${unit.task_id}`);
      process.stderr.write(`[stage0] ${new Date().toISOString()} start ${unit.task_id}#${unit.seed}/a${attemptIndex}\n`);
      const key = attemptKey(unit, attemptIndex);
      const hooks = guard === null ? {} : { signal, onProgress: (cost: number, errors: Parameters<Stage0RunGuard["progress"]>[2]) => guard?.progress(key, cost, errors) };
      const record = await runAttempt({ experiment, task: entry.task, proof: entry.proof, seed: unit.seed, attempt_index: attemptIndex, wave }, env, hooks);
      process.stderr.write(`[stage0] ${new Date().toISOString()} done  ${unit.task_id}#${unit.seed}/a${attemptIndex} va=${record.verified_and_adopted} class=${String(record.failure_class)} $${record.cost_usd.toFixed(4)} ${Math.round(record.wall_ms / 1000)}s\n`);
      return record;
    },
    append: (entry) => appendLedger(ledger, entry),
    event: (event, detail) => logEvent(ledger, experiment, event, detail),
  });
  guard?.dispose();
  logEvent(ledger, experiment, "run_finished", { ...result, guard_spent_usd: guard?.spent_usd ?? null });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function analyze(f: Map<string, string>): void {
  const manifest = JSON.parse(readFileSync(required(f, "tasks"), "utf8")) as Stage0Manifest;
  const experiment = (f.get("experiment") ?? "full") as Stage0Experiment;
  const parsed = readLedger(required(f, "ledger"), experiment);
  const design: Stage0Design = {
    budget_levels: numbers(f.get("budgets") ?? "1,4,8"),
    k_wide: Number(f.get("k") ?? "4"),
    usd_unit: Number(required(f, "usd-unit")),
    seeds: numbers(f.get("seeds") ?? "0,1,2,3"),
    bootstrap_resamples: Number(f.get("resamples") ?? "10000"),
    bootstrap_seed: f.get("bootstrap-seed") ?? "stage0-2026-10-06",
  };
  const analysis = analyzeStage0(manifest.tasks.map((e) => e.task), parsed.attempts, parsed.waves, design);
  const out = f.get("out");
  const serialised = JSON.stringify({ design, unparsed_ledger_lines: parsed.unparsed_lines, ...analysis }, null, 2);
  if (out !== undefined) writeFileSync(out, `${serialised}\n`);
  const { outcomes: _outcomes, ...summary } = analysis;
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function pilotSummary(f: Map<string, string>): void {
  const parsed = readLedger(required(f, "ledger"), (f.get("experiment") ?? "pilot") as Stage0Experiment);
  const attempts = parsed.attempts;
  const k = Number(f.get("k") ?? "4");
  const maxBudget = Number(f.get("max-budget") ?? "8");
  const units = Number(required(f, "units"));
  const costs = attempts.map((a) => a.cost_usd);
  const p = attempts.length === 0 ? 0 : attempts.filter((a) => a.harness_verified).length / attempts.length;
  // Expected attempts per unit under the K-wide wave schedule with i.i.d. attempts of verify-probability p.
  let expectedAttempts = 0;
  for (let wave = 0; wave * k < maxBudget; wave++) expectedAttempts += Math.min(k, maxBudget - wave * k) * (1 - p) ** (wave * k);
  const projected = units * expectedAttempts * mean(costs);
  const wall = attempts.map((a) => a.wall_ms);
  process.stdout.write(`${JSON.stringify({
    attempts: attempts.length,
    harness_verified_rate: p,
    verified_and_adopted_rate: attempts.length === 0 ? 0 : attempts.filter((a) => a.verified_and_adopted).length / attempts.length,
    median_cost_usd: median(costs),
    mean_cost_usd: mean(costs),
    median_tokens: {
      input: median(attempts.map((a) => a.tokens.input)),
      output: median(attempts.map((a) => a.tokens.output)),
      cache_read: median(attempts.map((a) => a.tokens.cache_read)),
      cache_write: median(attempts.map((a) => a.tokens.cache_write)),
    },
    p90_cost_usd: quantile(costs, 0.9),
    total_cost_usd: costs.reduce((sum, c) => sum + c, 0),
    p90_tokens: {
      input: quantile(attempts.map((a) => a.tokens.input), 0.9),
      output: quantile(attempts.map((a) => a.tokens.output), 0.9),
      cache_read: quantile(attempts.map((a) => a.tokens.cache_read), 0.9),
      cache_write: quantile(attempts.map((a) => a.tokens.cache_write), 0.9),
    },
    connector_ids: [...new Set(attempts.flatMap((a) => a.connector_ids ?? []))].sort(),
    attempts_with_provider_errors: attempts.filter((a) => (a.provider_errors ?? []).length > 0).length,
    median_wall_ms: median(wall),
    mean_wall_ms: mean(wall),
    expected_attempts_per_unit: expectedAttempts,
    projected_full_cost_usd: projected,
    projected_attempts: units * expectedAttempts,
    by_failure_class: attempts.reduce<Record<string, number>>((acc, a) => {
      const cls = a.failure_class ?? "verified_and_adopted";
      acc[cls] = (acc[cls] ?? 0) + 1;
      return acc;
    }, {}),
  }, null, 2)}\n`);
}

/** Append measurement corrections re-derived from preserved evidence (see `audit.ts`). */
function auditAttempts(f: Map<string, string>): void {
  const ledger = required(f, "ledger");
  const experiment = (f.get("experiment") ?? "full") as Stage0Experiment;
  const native = JSON.parse(readFileSync(required(f, "native-config"), "utf8")) as AttemptEnvironment["native_config"];
  const dryRun = f.get("dry-run") === "true";
  const corrections = deriveCorrections(readLedger(ledger, experiment).attempts, native.pricing, experiment, new Date().toISOString());
  if (!dryRun) for (const correction of corrections) appendLedger(ledger, correction);
  process.stdout.write(`${JSON.stringify({ corrections: corrections.length, dry_run: dryRun, items: corrections.map((c) => ({ unit: `${c.task_id}#${c.seed}/a${c.attempt_index}`, reason: c.reason, set: c.set })) }, null, 2)}\n`);
}

const [command, ...rest] = process.argv.slice(2);
const parsedFlags = flags(rest);
// Direct calls, not a lookup table: the static reachability walk follows a
// call it can see, and this file is a declared entry point.
function dispatch(name: string, flags: Map<string, string>): unknown {
  switch (name) {
    case "build-fixtures": return buildFixtures(flags);
    case "run": return run(flags);
    case "analyze": return analyze(flags);
    case "pilot-summary": return pilotSummary(flags);
    case "audit-attempts": return auditAttempts(flags);
    default: return undefined;
  }
}
const KNOWN_COMMANDS = new Set(["build-fixtures", "run", "analyze", "pilot-summary", "audit-attempts"]);
if (command === undefined || !KNOWN_COMMANDS.has(command)) {
  process.stderr.write("usage: cli.ts build-fixtures|run|analyze|pilot-summary [--flags]\n");
  process.exit(2);
} else {
  Promise.resolve(dispatch(command, parsedFlags)).catch((error: unknown) => {
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
    process.exit(1);
  });
}
