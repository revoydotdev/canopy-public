/**
 * scheduler-command.ts — the operator surface for D24's long-horizon
 * scheduler: `LongHorizonScheduler`, `DurableScheduleStore`, and
 * `PlanReuseCache` (packages/arbor-mcp/src/scheduler/*) have been
 * constructed and threaded into `ArborRuntime` since `createCliRuntime` grew
 * a `long_horizon_scheduler`, but nothing ever called `register`, `tick`, or
 * `triggerExternal` — `longHorizonScheduler` was written, never read. ADR-047
 * deliberately scoped the driver OUT ("Hosts must call `tick` or deliver an
 * external trigger; process liveness is deliberately separate from durable
 * correctness") — this file is that host-invoked driver, not a daemon. There
 * is no `setInterval` anywhere below; every action runs once and exits.
 *
 * Four actions:
 *
 *   scheduler register <schedule-id> --campaign <id> --task <text>
 *       (--once <iso>|--cron <expr>|--external <key>)
 *       [--catch-up fire_once|skip|backfill_all] [--max-backfill <n>] [--json]
 *   scheduler list [--json]
 *   scheduler tick [--json]
 *   scheduler trigger <key> [--json]
 *   scheduler daemon [--interval-ms <milliseconds>] [--json]
 *
 * `register` is what makes `tick`/`trigger` reachable in the first place —
 * D24's finding was that the whole chain (`register` -> due row -> `tick` ->
 * `PlanReuseCache.find()` -> launch) was unreachable by construction; a
 * `tick` verb alone would still leave nothing to tick.
 *
 * `tick`, `trigger`, and `daemon` open the SAME production `ArborRuntime` every other
 * long-lived CLI transport uses (`createCliRuntime` in cli.ts) and drive its
 * already-wired `longHorizonScheduler`, rather than building a second,
 * parallel launch path — that scheduler's launcher already dispatches through
 * `JobScheduler`/`ArborRuntime.runCampaignJob`, which is ADR-047 O5's
 * sanctioned production path ("CLI runtime composition launches due rows
 * through `JobScheduler` and `ArborRuntime.runCampaignJob`"). `register` and
 * `list` are cheap metadata operations against the same durable, file-backed
 * `DurableScheduleStore` and deliberately do NOT pay that cost — they never
 * need a launcher, only the registry file at the resolved persistence dir.
 *
 * `createCliRuntime`/`resolvePersistenceDir` are imported dynamically (never
 * at module top level) so a hermetic `register`/`list`-only test, and this
 * module's own unit tests via the `deps` seam below, never have to load
 * cli.ts's full module graph (native harness adapters, MCP connectors,
 * `@arbor/opencode`) just to exercise registry logic.
 */

import { EXIT_CODES } from "./exit-codes.js";
import { DurableScheduleStore } from "./scheduler/schedule-store.js";
import { LongHorizonScheduler } from "./scheduler/scheduler.js";
import type {
  CampaignSchedule,
  CatchUpPolicy,
  ScheduledCampaignLauncher,
  ScheduledRunRecord,
  ScheduleTrigger,
} from "./scheduler/contracts.js";

export interface SchedulerCommandEnvironment {
  readonly cwd: string;
  readonly persistence_dir?: string;
  readonly stdout: { write(text: string): void };
  readonly stderr: { write(text: string): void };
  /** Optional process-lifecycle signal, supplied by the CLI host for `daemon`. */
  readonly shutdown?: Promise<void>;
}

/** A started, closeable handle onto a real scheduler — production or test. */
export interface SchedulerRuntimeHandle {
  readonly scheduler: LongHorizonScheduler;
  close(): Promise<void>;
}

/**
 * D12-style test seam: the only way `tick`/`trigger` reach a
 * `LongHorizonScheduler` with a real launcher. Production never supplies
 * this — the default resolves lazily to `createCliRuntime`'s already-wired
 * scheduler — so the wiring cli.ts needs stays the two-line dispatch
 * documented in this file's header, with no dependency parameter threaded
 * through.
 */
export interface SchedulerCommandDeps {
  resolvePersistenceDir?(cwd: string, persistenceDir: string | undefined): Promise<string>;
  openRuntimeScheduler?(cwd: string, persistenceDir: string | undefined): Promise<SchedulerRuntimeHandle>;
  /** Test-only clock override for `register`'s own `LongHorizonScheduler` (production always uses `Date`, i.e. real wall time). */
  now?(): number;
  /** Test seam for daemon cadence; production uses a cancellable wall-clock delay. */
  sleep?(milliseconds: number, signal: AbortSignal): Promise<void>;
}

async function defaultResolvePersistenceDir(cwd: string, persistenceDir: string | undefined): Promise<string> {
  const { resolvePersistenceDir } = await import("./cli.js");
  return resolvePersistenceDir(cwd, persistenceDir);
}

async function defaultOpenRuntimeScheduler(cwd: string, persistenceDir: string | undefined): Promise<SchedulerRuntimeHandle> {
  const { createCliRuntime } = await import("./cli.js");
  const runtime = createCliRuntime(cwd, persistenceDir);
  const started = await runtime.start();
  if (!started.ok) {
    throw new Error(`runtime failed to start: ${started.failures.map((failure) => failure.summary).join("; ") || "unknown failure"}`);
  }
  if (!runtime.longHorizonScheduler) {
    // Cannot happen through `createCliRuntime` (it always constructs one),
    // but a thrown error beats a silent no-op tick if that composition ever
    // changes.
    const closed = await runtime.close();
    if (!closed.ok) throw new Error(`runtime shutdown failed: ${closed.failures.map((failure) => failure.summary).join("; ") || "unknown failure"}`);
    throw new Error("runtime did not construct a long-horizon scheduler");
  }
  const scheduler = runtime.longHorizonScheduler;
  return { scheduler, close: async () => {
    const closed = await runtime.close();
    if (!closed.ok) throw new Error(`runtime shutdown failed: ${closed.failures.map((failure) => failure.summary).join("; ") || "unknown failure"}`);
  } };
}

/** Register never launches anything, so it never needs a real launcher. */
const UNREACHABLE_LAUNCHER: ScheduledCampaignLauncher = {
  launch() {
    throw new Error("scheduler register: the launcher must never be invoked during registration");
  },
};

/**
 * D12: the single source of truth for `arbor scheduler`'s dispatched
 * actions — the usage line below renders from this same array, so a
 * handled action can never silently diverge from the one --help advertises.
 */
export const SCHEDULER_ACTIONS = ["register", "list", "tick", "trigger", "daemon"] as const;

const USAGE =
  `Usage: arbor-mcp scheduler <${SCHEDULER_ACTIONS.join("|")}> ...\n`
  + "  scheduler register <schedule-id> --campaign <id> --task <text>\n"
  + "      (--once <iso-timestamp>|--cron <5-field-expr>|--external <key>)\n"
  + "      [--catch-up fire_once|skip|backfill_all] [--max-backfill <n>] [--json]\n"
  + "  scheduler list [--json]                 Show every registered schedule\n"
  + "  scheduler tick [--json]                  Run all schedules due now\n"
  + "  scheduler trigger <key> [--json]         Deliver an external trigger\n"
  + "  scheduler daemon [--interval-ms <ms>] [--json]\n"
  + "                                             Run due schedules until interrupted (default: 60000ms)\n";

interface ParsedFlags {
  readonly values: Readonly<Record<string, string>>;
  readonly json: boolean;
}

function parseFlags(args: readonly string[]): ParsedFlags {
  const values: Record<string, string> = {};
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") { json = true; continue; }
    if (!argument.startsWith("--")) continue;
    const name = argument.slice(2);
    const next = args[index + 1];
    values[name] = next === undefined || next.startsWith("--") ? "" : next;
    if (values[name] !== "") index += 1;
  }
  return { values, json };
}

function emit(environment: SchedulerCommandEnvironment, json: boolean, payload: unknown, human: readonly string[]): void {
  if (json) {
    environment.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  for (const line of human) environment.stdout.write(`${line}\n`);
}

/** A daemon emits multiple records, so its JSON mode is deliberately NDJSON. */
function emitDaemonEvent(environment: SchedulerCommandEnvironment, json: boolean, payload: unknown, human: readonly string[]): void {
  if (json) {
    environment.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  for (const line of human) environment.stdout.write(`${line}\n`);
}

function formatSchedule(schedule: CampaignSchedule): string {
  const trigger =
    schedule.trigger.kind === "once" ? `once@${schedule.trigger.at}`
    : schedule.trigger.kind === "cron" ? `cron(${schedule.trigger.expression})`
    : `external(${schedule.trigger.key})`;
  return `${schedule.schedule_id}  campaign=${schedule.campaign_id}  trigger=${trigger}  state=${schedule.state}`
    + `  next_fire_at=${schedule.next_fire_at ?? "-"}  version=${schedule.version}`;
}

function formatRun(run: ScheduledRunRecord): string {
  return `  ${run.schedule_id}  decision=${run.decision}  due_at=${run.due_at}  plan_source=${run.plan_source}  run_id=${run.run_id}`;
}

/**
 * `LongHorizonScheduler.tick()`/`triggerExternal()` return only the
 * dispatch record (`fired`/`skipped`) — the launcher's settled outcome
 * (`completed`/`failed`/`human_required`) is appended to the durable store
 * under a second run id (`${run_id}:${outcome.kind}`) and never returned
 * directly (see `scheduler.ts`'s `evaluate`). Resolve each `fired` record to
 * its settled outcome via `runHistory` so the operator sees what actually
 * happened, not just that a launch was dispatched.
 */
function resolveOutcome(scheduler: LongHorizonScheduler, run: ScheduledRunRecord): ScheduledRunRecord {
  if (run.decision !== "fired") return run;
  const outcome = scheduler.runHistory(run.schedule_id).find((candidate) => candidate.run_id.startsWith(`${run.run_id}:`));
  return outcome ?? run;
}

/** A "failed" outcome is a real operational failure; every other outcome (including `human_required`, a durable success) is not. */
function exitCodeForRuns(runs: readonly ScheduledRunRecord[]): number {
  return runs.some((run) => run.decision === "failed") ? EXIT_CODES.FAILURE : EXIT_CODES.SUCCESS;
}

const CATCH_UP_POLICIES: readonly CatchUpPolicy[] = ["fire_once", "skip", "backfill_all"];

function buildTrigger(values: Readonly<Record<string, string>>, stderr: SchedulerCommandEnvironment["stderr"]): ScheduleTrigger | null {
  const present = (["once", "cron", "external"] as const).filter((kind) => values[kind] !== undefined && values[kind] !== "");
  if (present.length !== 1) {
    stderr.write("scheduler register: exactly one of --once <iso-timestamp>, --cron <expr>, or --external <key> is required\n");
    return null;
  }
  const kind = present[0]!;
  if (kind === "once") return { kind: "once", at: values.once! };
  if (kind === "cron") return { kind: "cron", expression: values.cron! };
  return { kind: "external", key: values.external! };
}

async function runRegister(args: readonly string[], environment: SchedulerCommandEnvironment, deps: SchedulerCommandDeps): Promise<number> {
  const scheduleId = args[0];
  if (!scheduleId || scheduleId.startsWith("--")) {
    environment.stderr.write("scheduler register: a schedule id is required as the first positional argument\n");
    return EXIT_CODES.USAGE;
  }
  const { values, json } = parseFlags(args.slice(1));
  const campaignId = values.campaign;
  const taskTemplate = values.task;
  if (!campaignId || !taskTemplate) {
    environment.stderr.write("scheduler register: --campaign and --task are both required\n");
    return EXIT_CODES.USAGE;
  }
  const trigger = buildTrigger(values, environment.stderr);
  if (!trigger) return EXIT_CODES.USAGE;

  let catchUp: CatchUpPolicy | undefined;
  if (values["catch-up"] !== undefined) {
    if (!(CATCH_UP_POLICIES as readonly string[]).includes(values["catch-up"])) {
      environment.stderr.write(`scheduler register: --catch-up must be one of ${CATCH_UP_POLICIES.join("|")}\n`);
      return EXIT_CODES.USAGE;
    }
    catchUp = values["catch-up"] as CatchUpPolicy;
  }

  let maxBackfill: number | undefined;
  if (values["max-backfill"] !== undefined) {
    maxBackfill = Number.parseInt(values["max-backfill"], 10);
    if (!Number.isSafeInteger(maxBackfill) || maxBackfill < 1) {
      environment.stderr.write("scheduler register: --max-backfill must be a positive integer\n");
      return EXIT_CODES.USAGE;
    }
  }

  const resolveDir = deps.resolvePersistenceDir ?? defaultResolvePersistenceDir;
  const resolvedDir = await resolveDir(environment.cwd, environment.persistence_dir);
  const scheduler = new LongHorizonScheduler(new DurableScheduleStore(resolvedDir), UNREACHABLE_LAUNCHER, undefined, deps.now ? { now: deps.now } : undefined);

  let schedule: CampaignSchedule;
  try {
    schedule = scheduler.register({
      schedule_id: scheduleId,
      campaign_id: campaignId,
      task_template: taskTemplate,
      trigger,
      catch_up: catchUp,
      max_backfill: maxBackfill,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    environment.stderr.write(`scheduler register: ${message}\n`);
    return message === "schedule already exists" ? EXIT_CODES.CONFLICT : EXIT_CODES.USAGE;
  }

  emit(environment, json, { registered: schedule }, [`registered: ${formatSchedule(schedule)}`]);
  return EXIT_CODES.SUCCESS;
}

async function runList(args: readonly string[], environment: SchedulerCommandEnvironment, deps: SchedulerCommandDeps): Promise<number> {
  const { json } = parseFlags(args);
  const resolveDir = deps.resolvePersistenceDir ?? defaultResolvePersistenceDir;
  const resolvedDir = await resolveDir(environment.cwd, environment.persistence_dir);
  const store = new DurableScheduleStore(resolvedDir);
  const schedules = store.list();
  const human = schedules.length === 0 ? ["no schedules registered"] : schedules.map(formatSchedule);
  emit(environment, json, { schedules }, human);
  return EXIT_CODES.SUCCESS;
}

async function runTick(args: readonly string[], environment: SchedulerCommandEnvironment, deps: SchedulerCommandDeps): Promise<number> {
  const { json } = parseFlags(args);
  const open = deps.openRuntimeScheduler ?? defaultOpenRuntimeScheduler;
  const handle = await open(environment.cwd, environment.persistence_dir);
  try {
    const dispatched = await handle.scheduler.tick();
    const runs = dispatched.map((run) => resolveOutcome(handle.scheduler, run));
    const human = runs.length === 0 ? ["no schedules due"] : ["fired:", ...runs.map(formatRun)];
    emit(environment, json, { fired: runs }, human);
    return exitCodeForRuns(runs);
  } finally {
    await handle.close();
  }
}

async function runTrigger(args: readonly string[], environment: SchedulerCommandEnvironment, deps: SchedulerCommandDeps): Promise<number> {
  const key = args[0];
  if (!key || key.startsWith("--")) {
    environment.stderr.write("scheduler trigger: an external trigger key is required as the first positional argument\n");
    return EXIT_CODES.USAGE;
  }
  const { json } = parseFlags(args.slice(1));
  const open = deps.openRuntimeScheduler ?? defaultOpenRuntimeScheduler;
  const handle = await open(environment.cwd, environment.persistence_dir);
  try {
    const dispatched = await handle.scheduler.triggerExternal(key);
    const runs = dispatched.map((run) => resolveOutcome(handle.scheduler, run));
    const human = runs.length === 0 ? [`no schedule matched external key "${key}"`] : ["fired:", ...runs.map(formatRun)];
    emit(environment, json, { key, fired: runs }, human);
    return exitCodeForRuns(runs);
  } finally {
    await handle.close();
  }
}

const DEFAULT_DAEMON_INTERVAL_MS = 60_000;
const MIN_DAEMON_INTERVAL_MS = 1_000;

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = () => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      signal.removeEventListener("abort", settle);
      resolve();
    };
    if (signal.aborted) { settle(); return; }
    timer = setTimeout(settle, milliseconds);
    signal.addEventListener("abort", settle, { once: true });
  });
}

/**
 * D45: an explicit, single-process scheduler driver. It serializes ticks
 * (rather than using setInterval) so a slow campaign launch can never overlap
 * a subsequent tick. The CLI host gives it a shutdown promise on SIGINT/SIGTERM;
 * shutdown aborts the one pending cadence timer before closing the runtime, so
 * no referenced timer can keep the CLI alive after a graceful stop.
 */
async function runDaemon(args: readonly string[], environment: SchedulerCommandEnvironment, deps: SchedulerCommandDeps): Promise<number> {
  const { values, json } = parseFlags(args);
  const rawInterval = values["interval-ms"] ?? String(DEFAULT_DAEMON_INTERVAL_MS);
  const intervalMs = Number(rawInterval);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < MIN_DAEMON_INTERVAL_MS) {
    environment.stderr.write(`scheduler daemon: --interval-ms must be an integer of at least ${MIN_DAEMON_INTERVAL_MS}\n`);
    return EXIT_CODES.USAGE;
  }

  let stopping = false;
  let resolveStopped: () => void = () => {};
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
  let cancelCadence: (() => void) | null = null;
  const shutdown = environment.shutdown ?? new Promise<void>(() => {});
  // Attach exactly one shutdown observer for the daemon's entire lifetime;
  // individual cadence waits use an AbortSignal and remove their own listener.
  void shutdown.then(() => {
    stopping = true;
    cancelCadence?.();
    resolveStopped();
  });
  // Let an already-resolved host shutdown settle before opening a runtime or
  // executing the first tick. This makes an interrupted-before-start daemon a
  // no-op rather than briefly starting a campaign-capable runtime.
  await Promise.resolve();
  if (stopping) {
    emitDaemonEvent(environment, json, { event: "stopped", before_start: true, had_failures: false }, ["scheduler daemon stopped before start"]);
    return EXIT_CODES.SUCCESS;
  }
  const open = deps.openRuntimeScheduler ?? defaultOpenRuntimeScheduler;
  const sleep = deps.sleep ?? delay;
  const handle = await open(environment.cwd, environment.persistence_dir);
  let sawFailure = false;
  try {
    emitDaemonEvent(environment, json, { event: "started", interval_ms: intervalMs }, [`scheduler daemon started (interval_ms=${intervalMs})`]);
    while (!stopping) {
      const dispatched = await handle.scheduler.tick();
      const runs = dispatched.map((run) => resolveOutcome(handle.scheduler, run));
      sawFailure ||= exitCodeForRuns(runs) === EXIT_CODES.FAILURE;
      emitDaemonEvent(environment, json, { event: "tick", fired: runs }, runs.length === 0 ? ["no schedules due"] : ["fired:", ...runs.map(formatRun)]);
      if (stopping) break;
      const cadence = new AbortController();
      cancelCadence = () => cadence.abort();
      try {
        await Promise.race([sleep(intervalMs, cadence.signal), stopped]);
      } finally {
        cadence.abort();
        cancelCadence = null;
      }
    }
    emitDaemonEvent(environment, json, { event: "stopped", had_failures: sawFailure }, ["scheduler daemon stopped"]);
    return sawFailure ? EXIT_CODES.FAILURE : EXIT_CODES.SUCCESS;
  } finally {
    await handle.close();
  }
}

export async function schedulerCommand(
  args: readonly string[],
  environment: SchedulerCommandEnvironment,
  deps: SchedulerCommandDeps = {},
): Promise<number> {
  const action = args[0];
  if (!(SCHEDULER_ACTIONS as readonly string[]).includes(action ?? "")) {
    environment.stderr.write(USAGE);
    return EXIT_CODES.USAGE;
  }
  const rest = args.slice(1);
  if (action === "register") return runRegister(rest, environment, deps);
  if (action === "list") return runList(rest, environment, deps);
  if (action === "tick") return runTick(rest, environment, deps);
  if (action === "daemon") return runDaemon(rest, environment, deps);
  // Explicit rather than an unnamed implicit tail (ledger-command.ts's own
  // rule): an action added to SCHEDULER_ACTIONS with no handler must fail
  // loudly here, not silently fall through to `trigger`.
  if (action !== "trigger") {
    environment.stderr.write(`scheduler: no handler for action "${action}" — this is a dispatch bug, not operator error\n`);
    return EXIT_CODES.USAGE;
  }
  return runTrigger(rest, environment, deps);
}
