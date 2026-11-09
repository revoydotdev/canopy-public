import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schedulerCommand, type SchedulerCommandDeps, type SchedulerCommandEnvironment, type SchedulerRuntimeHandle } from "../../src/scheduler-command.js";
import { DurableScheduleStore } from "../../src/scheduler/schedule-store.js";
import { LongHorizonScheduler } from "../../src/scheduler/scheduler.js";
import { PlanReuseCache } from "../../src/scheduler/plan-reuse.js";
import { EXIT_CODES } from "../../src/exit-codes.js";
import type { ScheduledCampaignLauncher } from "../../src/scheduler/contracts.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
function directory(): string { const value = mkdtempSync(join(tmpdir(), "arbor-scheduler-cmd-")); dirs.push(value); return value; }

function environment(dir: string): { env: SchedulerCommandEnvironment; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    env: { cwd: dir, persistence_dir: ".arbor", stdout: { write: (t) => { out.push(t); } }, stderr: { write: (t) => { err.push(t); } } },
    out, err,
  };
}

/**
 * The `deps` seam this module ships specifically so `tick`/`trigger` tests
 * never need `createCliRuntime`'s full stack (native harness adapters, MCP
 * connectors, `@arbor/opencode`, a real `opencode` binary) — just a real
 * `DurableScheduleStore` at the resolved dir plus an injected launcher, the
 * same shape `long-horizon.test.ts` already exercises against the scheduler
 * class directly.
 */
function depsWithLauncher(resolvedDir: string, launcher: ScheduledCampaignLauncher, now: () => number, plans = new PlanReuseCache()): SchedulerCommandDeps {
  return {
    resolvePersistenceDir: async () => resolvedDir,
    openRuntimeScheduler: async (): Promise<SchedulerRuntimeHandle> => ({
      scheduler: new LongHorizonScheduler(new DurableScheduleStore(resolvedDir), launcher, plans, { now }),
      close: async () => {},
    }),
  };
}

describe("arbor-mcp scheduler — the D24 host-invoked driver and D45 daemon", () => {
  it("register makes a schedule reachable, and list shows it", async () => {
    const dir = directory();
    const resolvedDir = join(dir, ".arbor");
    const deps: SchedulerCommandDeps = { resolvePersistenceDir: async () => resolvedDir };
    const { env: regEnv, out: regOut } = environment(dir);
    const registerCode = await schedulerCommand(
      ["register", "daily", "--campaign", "camp", "--task", "audit account 42", "--cron", "*/5 * * * *", "--json"],
      regEnv, deps,
    );
    expect(registerCode).toBe(EXIT_CODES.SUCCESS);
    expect(JSON.parse(regOut.join(""))).toMatchObject({ registered: { schedule_id: "daily", campaign_id: "camp", state: "active" } });

    const { env: listEnv, out: listOut } = environment(dir);
    const listCode = await schedulerCommand(["list", "--json"], listEnv, deps);
    expect(listCode).toBe(EXIT_CODES.SUCCESS);
    expect(JSON.parse(listOut.join(""))).toMatchObject({ schedules: [{ schedule_id: "daily" }] });
  });

  it("register refuses a duplicate schedule id as CONFLICT, and an unknown action as USAGE", async () => {
    const dir = directory();
    const resolvedDir = join(dir, ".arbor");
    const deps: SchedulerCommandDeps = { resolvePersistenceDir: async () => resolvedDir };
    const first = await schedulerCommand(["register", "s", "--campaign", "c", "--task", "t", "--once", "2026-09-01T00:00:00Z"], environment(dir).env, deps);
    expect(first).toBe(EXIT_CODES.SUCCESS);
    const dup = await schedulerCommand(["register", "s", "--campaign", "c", "--task", "t", "--once", "2026-09-01T00:00:00Z"], environment(dir).env, deps);
    expect(dup).toBe(EXIT_CODES.CONFLICT);

    const unknown = await schedulerCommand(["frobnicate"], environment(dir).env, deps);
    expect(unknown).toBe(EXIT_CODES.USAGE);
  });

  it("tick fires a due schedule registered through this same command, and is a clean no-op with nothing due", async () => {
    const dir = directory();
    const resolvedDir = join(dir, ".arbor");
    let now = Date.parse("2026-08-12T10:00:00Z");
    const launched: string[] = [];
    const launcher: ScheduledCampaignLauncher = { async launch({ run }) { launched.push(run.run_id); return { kind: "completed" }; } };
    const registerDeps: SchedulerCommandDeps = { resolvePersistenceDir: async () => resolvedDir, now: () => now };

    const registered = await schedulerCommand(
      ["register", "daily", "--campaign", "camp", "--task", "audit account 42", "--once", "2026-08-12T10:05:00Z"],
      { ...environment(dir).env }, registerDeps,
    );
    expect(registered).toBe(EXIT_CODES.SUCCESS);

    // Nothing is due yet — the schedule's one occurrence is 5 minutes out.
    const { env: noopEnv, out: noopOut } = environment(dir);
    const noopCode = await schedulerCommand(["tick", "--json"], noopEnv, depsWithLauncher(resolvedDir, launcher, () => now));
    expect(noopCode).toBe(EXIT_CODES.SUCCESS);
    expect(JSON.parse(noopOut.join(""))).toEqual({ fired: [] });
    expect(launched).toHaveLength(0);

    now = Date.parse("2026-08-12T10:05:00Z");
    const { env: tickEnv, out: tickOut } = environment(dir);
    const tickCode = await schedulerCommand(["tick", "--json"], tickEnv, depsWithLauncher(resolvedDir, launcher, () => now));
    expect(tickCode).toBe(EXIT_CODES.SUCCESS);
    const payload = JSON.parse(tickOut.join("")) as { fired: { schedule_id: string; decision: string }[] };
    // The resolved decision is the launcher's settled outcome ("completed"),
    // not the intermediate "fired" dispatch record `tick()` itself returns —
    // this is what `resolveOutcome` (scheduler-command.ts) exists to surface.
    expect(payload.fired).toMatchObject([{ schedule_id: "daily", decision: "completed" }]);
    expect(launched).toHaveLength(1);
  });

  it("trigger fires the schedule matching its external key, and a non-matching key is a clean no-op", async () => {
    const dir = directory();
    const resolvedDir = join(dir, ".arbor");
    const now = Date.parse("2026-08-12T10:00:00Z");
    const launcher: ScheduledCampaignLauncher = { async launch() { return { kind: "completed" }; } };
    const registerDeps: SchedulerCommandDeps = { resolvePersistenceDir: async () => resolvedDir };
    await schedulerCommand(["register", "deploy", "--campaign", "camp", "--task", "deploy service", "--external", "deploy-ready"], environment(dir).env, registerDeps);

    const { env: missEnv, out: missOut } = environment(dir);
    const missCode = await schedulerCommand(["trigger", "not-the-key", "--json"], missEnv, depsWithLauncher(resolvedDir, launcher, () => now));
    expect(missCode).toBe(EXIT_CODES.SUCCESS);
    expect(JSON.parse(missOut.join(""))).toEqual({ key: "not-the-key", fired: [] });

    const { env: hitEnv, out: hitOut } = environment(dir);
    const hitCode = await schedulerCommand(["trigger", "deploy-ready", "--json"], hitEnv, depsWithLauncher(resolvedDir, launcher, () => now));
    expect(hitCode).toBe(EXIT_CODES.SUCCESS);
    const payload = JSON.parse(hitOut.join("")) as { fired: { schedule_id: string; decision: string }[] };
    expect(payload.fired).toMatchObject([{ schedule_id: "deploy", decision: "completed" }]);
  });

  it("tick reports FAILURE when a launched run's decision is failed", async () => {
    const dir = directory();
    const resolvedDir = join(dir, ".arbor");
    let now = Date.parse("2026-08-12T10:00:00Z");
    const launcher: ScheduledCampaignLauncher = { async launch() { return { kind: "failed", reason: "campaign settled failed" }; } };
    const registerDeps: SchedulerCommandDeps = { resolvePersistenceDir: async () => resolvedDir, now: () => now };
    await schedulerCommand(["register", "daily", "--campaign", "camp", "--task", "audit", "--cron", "*/5 * * * *"], environment(dir).env, registerDeps);
    now = Date.parse("2026-08-12T10:05:00Z");
    const code = await schedulerCommand(["tick"], environment(dir).env, depsWithLauncher(resolvedDir, launcher, () => now));
    expect(code).toBe(EXIT_CODES.FAILURE);
  });

  it("daemon serially drives due schedules until the host shutdown signal closes its runtime", async () => {
    const dir = directory();
    const resolvedDir = join(dir, ".arbor");
    const now = Date.parse("2026-08-12T10:05:00Z");
    const launched: string[] = [];
    const launcher: ScheduledCampaignLauncher = { async launch({ run }) { launched.push(run.run_id); return { kind: "completed" }; } };
    const registerDeps: SchedulerCommandDeps = { resolvePersistenceDir: async () => resolvedDir, now: () => now };
    await schedulerCommand(["register", "daily", "--campaign", "camp", "--task", "audit", "--once", "2026-08-12T10:05:00Z"], environment(dir).env, registerDeps);

    let requestStop: () => void = () => {};
    const shutdown = new Promise<void>((resolve) => { requestStop = resolve; });
    let closed = false;
    const daemonDeps: SchedulerCommandDeps = {
      ...depsWithLauncher(resolvedDir, launcher, () => now),
      openRuntimeScheduler: async () => ({
        scheduler: new LongHorizonScheduler(new DurableScheduleStore(resolvedDir), launcher, undefined, { now: () => now }),
        close: async () => { closed = true; },
      }),
      // Stop after the first completed tick without a wall-clock wait.
      sleep: async () => { requestStop(); },
    };
    const { env, out } = environment(dir);
    const code = await schedulerCommand(["daemon", "--interval-ms", "1000", "--json"], { ...env, shutdown }, daemonDeps);

    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(launched).toHaveLength(1);
    expect(closed).toBe(true);
    const events = out.join("").trim().split("\n").map((line) => JSON.parse(line) as { event: string; fired?: unknown[] });
    expect(events).toMatchObject([{ event: "started" }, { event: "tick", fired: [{ schedule_id: "daily", decision: "completed" }] }, { event: "stopped" }]);
  });

  it("clears the real cadence timer when shutdown arrives during its wait, then closes promptly", async () => {
    vi.useFakeTimers();
    try {
      const dir = directory();
      const resolvedDir = join(dir, ".arbor");
      let requestStop: () => void = () => {};
      const shutdown = new Promise<void>((resolve) => { requestStop = resolve; });
      let closed = false;
      const out: string[] = [];
      const env: SchedulerCommandEnvironment = {
        cwd: dir, persistence_dir: ".arbor",
        stdout: { write: (text) => {
          out.push(text);
          // Queue after `sleep()` has installed its production timer but before
          // it can fire; the assertion below proves shutdown cleared that timer.
          if (text.includes('"event":"tick"')) queueMicrotask(requestStop);
        } },
        stderr: { write: () => {} },
        shutdown,
      };
      const deps: SchedulerCommandDeps = {
        openRuntimeScheduler: async () => ({
          scheduler: new LongHorizonScheduler(new DurableScheduleStore(resolvedDir), { launch: async () => ({ kind: "completed" }) }),
          close: async () => { closed = true; },
        }),
      };

      const code = await schedulerCommand(["daemon", "--interval-ms", "1000", "--json"], env, deps);

      expect(code).toBe(EXIT_CODES.SUCCESS);
      expect(closed).toBe(true);
      expect(out.join("")).toContain('"event":"stopped"');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not open a runtime or tick when the host was already shut down", async () => {
    const dir = directory();
    const { env, out } = environment(dir);
    let opened = false;
    const code = await schedulerCommand(
      ["daemon", "--json"],
      { ...env, shutdown: Promise.resolve() },
      { openRuntimeScheduler: async () => { opened = true; throw new Error("must not open after shutdown"); } },
    );

    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(opened).toBe(false);
    expect(JSON.parse(out.join(""))).toMatchObject({ event: "stopped", before_start: true });
  });

  it("exercises the plan-reuse cache path: a similar registered task reuses a stored verified plan as claimed", async () => {
    const dir = directory();
    const resolvedDir = join(dir, ".arbor");
    const now = Date.parse("2026-08-12T10:00:00Z");
    const plans = new PlanReuseCache();
    plans.store({
      template_id: "p1",
      intent_category: "audit account",
      task_template: "audit account {number}",
      plan: [{ action: "inspect" }],
      provenance: { tag: "verified", cmd: "plan-reuse-test", exit: 0, stdout_hash: "sha256:evidence" },
    });
    const sources: string[] = [];
    const launcher: ScheduledCampaignLauncher = { async launch({ reused_plan }) { sources.push(reused_plan ? reused_plan.provenance.tag : "fresh"); return { kind: "completed" }; } };
    const registerDeps: SchedulerCommandDeps = { resolvePersistenceDir: async () => resolvedDir };
    await schedulerCommand(["register", "reuse-me", "--campaign", "camp", "--task", "audit account 99", "--external", "go"], environment(dir).env, registerDeps);
    const { env, out } = environment(dir);
    const code = await schedulerCommand(["trigger", "go", "--json"], env, depsWithLauncher(resolvedDir, launcher, () => now, plans));
    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(sources).toEqual(["claimed"]);
    const payload = JSON.parse(out.join("")) as { fired: { plan_source: string }[] };
    expect(payload.fired).toMatchObject([{ plan_source: "reused" }]);
  });

  it("register refuses missing --campaign/--task, an invalid schedule id, and a malformed cron expression as USAGE", async () => {
    const dir = directory();
    const resolvedDir = join(dir, ".arbor");
    const deps: SchedulerCommandDeps = { resolvePersistenceDir: async () => resolvedDir };
    expect(await schedulerCommand(["register", "s"], environment(dir).env, deps)).toBe(EXIT_CODES.USAGE);
    expect(await schedulerCommand(["register", "s", "--campaign", "c", "--task", "t"], environment(dir).env, deps)).toBe(EXIT_CODES.USAGE);
    expect(await schedulerCommand(["register", "s", "--campaign", "c", "--task", "t", "--cron", "not a cron expr"], environment(dir).env, deps)).toBe(EXIT_CODES.USAGE);
    expect(await schedulerCommand(["register", "not a valid id!", "--campaign", "c", "--task", "t", "--once", "2026-09-01T00:00:00Z"], environment(dir).env, deps)).toBe(EXIT_CODES.USAGE);
  });
});
