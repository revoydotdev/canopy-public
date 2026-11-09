import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableScheduleStore } from "../../src/scheduler/schedule-store.js";
import { LongHorizonScheduler } from "../../src/scheduler/scheduler.js";
import { PlanReuseCache, intentTemplate } from "../../src/scheduler/plan-reuse.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
function directory(): string { const value = mkdtempSync(join(tmpdir(), "arbor-scheduler-")); dirs.push(value); return value; }

describe("LongHorizonScheduler", () => {
  it("fires once on cadence and survives a store restart", async () => {
    const dir = directory(); let now = Date.parse("2026-08-12T10:00:00Z"); const launched: string[] = [];
    const first = new LongHorizonScheduler(new DurableScheduleStore(dir), { async launch({ run }) { launched.push(run.run_id); return { kind: "completed" }; } }, undefined, { now: () => now });
    first.register({ schedule_id: "daily", campaign_id: "campaign", task_template: "audit account 42", trigger: { kind: "cron", expression: "*/5 * * * *" } });
    now = Date.parse("2026-08-12T10:05:00Z");
    const restarted = new LongHorizonScheduler(new DurableScheduleStore(dir), { async launch({ run }) { launched.push(run.run_id); return { kind: "completed" }; } }, undefined, { now: () => now });
    expect(await restarted.tick()).toHaveLength(1); expect(launched).toHaveLength(1);
    expect(new DurableScheduleStore(dir).runHistory("daily").map((run) => run.decision)).toEqual(["fired", "completed"]);
  });

  it("records skip and bounded backfill catch-up policies", async () => {
    const dir = directory(); let now = Date.parse("2026-08-12T10:00:00Z"); let calls = 0;
    const scheduler = new LongHorizonScheduler(new DurableScheduleStore(dir), { async launch() { calls += 1; return { kind: "completed" }; } }, undefined, { now: () => now });
    scheduler.register({ schedule_id: "skip", campaign_id: "c", task_template: "audit", trigger: { kind: "cron", expression: "* * * * *" }, catch_up: "skip" });
    scheduler.register({ schedule_id: "backfill", campaign_id: "c", task_template: "audit", trigger: { kind: "cron", expression: "* * * * *" }, catch_up: "backfill_all", max_backfill: 3 });
    now += 10 * 60_000; const records = await scheduler.tick();
    expect(records.filter((run) => run.schedule_id === "skip")).toMatchObject([{ decision: "skipped" }]);
    expect(records.filter((run) => run.schedule_id === "backfill")).toHaveLength(3); expect(calls).toBe(3);
  });

  it("persists human_required and resumes under a new schedule version", async () => {
    const dir = directory(); let now = Date.parse("2026-08-12T10:00:00Z");
    const scheduler = new LongHorizonScheduler(new DurableScheduleStore(dir), { async launch() { return { kind: "human_required", reason: "approve deployment" }; } }, undefined, { now: () => now });
    scheduler.register({ schedule_id: "external", campaign_id: "c", task_template: "deploy", trigger: { kind: "external", key: "deploy-ready" } });
    await scheduler.triggerExternal("deploy-ready");
    const suspended = new DurableScheduleStore(dir).get("external")!; expect(suspended).toMatchObject({ state: "human_required", human_reason: "approve deployment", version: 2 });
    expect(scheduler.resume("external")).toMatchObject({ state: "active", human_reason: null, version: 3 });
  });

  it("reuses only similar verified templates and downgrades provenance to claimed", () => {
    const cache = new PlanReuseCache(); const intent = intentTemplate("audit account 42");
    cache.store({ template_id: "p1", intent_category: intent.category, task_template: intent.template, plan: [{ action: "inspect" }], provenance: { tag: "verified", cmd: "plan-reuse-test", exit: 0, stdout_hash: "sha256:evidence" } });
    expect(cache.find("audit account 99")).toMatchObject({ template_id: "p1", provenance: { tag: "claimed" } });
    expect(cache.find("deploy production now")).toBeNull();
  });
});
