import { createHash } from "node:crypto";
import { nextCronOccurrence } from "./cron.js";
import { PlanReuseCache } from "./plan-reuse.js";
import { DurableScheduleStore } from "./schedule-store.js";
import type { CampaignSchedule, CatchUpPolicy, ScheduledCampaignLauncher, ScheduledRunRecord, ScheduleTrigger } from "./contracts.js";

export class LongHorizonScheduler {
  constructor(private readonly store: DurableScheduleStore, private readonly launcher: ScheduledCampaignLauncher, private readonly plans = new PlanReuseCache(), private readonly clock: { now(): number } = Date) {}
  register(input: { schedule_id: string; campaign_id: string; task_template: string; trigger: ScheduleTrigger; catch_up?: CatchUpPolicy; max_backfill?: number }): CampaignSchedule {
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(input.schedule_id) || !input.campaign_id.trim() || !input.task_template.trim()) throw new Error("schedule identity, campaign, and task are required and bounded");
    if (this.store.get(input.schedule_id)) throw new Error("schedule already exists");
    const now = new Date(this.clock.now()); const next = initialNext(input.trigger, now);
    return this.store.put(Object.freeze({ schema_version: 1, ...input, catch_up: input.catch_up ?? "fire_once", max_backfill: input.max_backfill ?? 32, state: "active", version: 1, next_fire_at: next, last_fire_at: null, created_at: now.toISOString(), human_reason: null }));
  }
  /** ADR-047: "Schedules and run decisions survive restarts and remain inspectable" — the durable outcome (fired/skipped, then completed/failed/human_required) a caller cannot get from `tick`/`triggerExternal` alone, since those return only the fired/skipped dispatch record, not the launcher's settled outcome. */
  runHistory(scheduleId?: string): readonly ScheduledRunRecord[] { return this.store.runHistory(scheduleId); }
  /** Read-only durable schedule projection for the canonical control plane. */
  list(): readonly CampaignSchedule[] { return this.store.list(); }
  suspendForHuman(id: string, reason: string): CampaignSchedule { return this.transition(id, { state: "human_required", human_reason: reason.slice(0, 512) }); }
  resume(id: string): CampaignSchedule { return this.transition(id, { state: "active", human_reason: null }); }
  async triggerExternal(key: string): Promise<readonly ScheduledRunRecord[]> { return this.evaluate(new Date(this.clock.now()), key); }
  async tick(at = new Date(this.clock.now())): Promise<readonly ScheduledRunRecord[]> { return this.evaluate(at, null); }
  private async evaluate(now: Date, externalKey: string | null): Promise<readonly ScheduledRunRecord[]> {
    const emitted: ScheduledRunRecord[] = [];
    for (const schedule of this.store.list()) {
      if (schedule.state !== "active") continue;
      const due = dueTimes(schedule, now, externalKey);
      for (const dueAt of due) {
        if (schedule.catch_up === "skip" && dueAt.getTime() < now.getTime() - 60_000) { emitted.push(this.record(schedule, dueAt, now, "skipped", "fresh")); continue; }
        const reused = this.plans.find(schedule.task_template);
        const run = this.record(schedule, dueAt, now, "fired", reused ? "reused" : "fresh"); emitted.push(run);
        const outcome = await this.launcher.launch({ schedule, run, reused_plan: reused });
        this.store.appendRun({ ...run, run_id: `${run.run_id}:${outcome.kind}`, decision: outcome.kind, evidence_ref: hash(`${run.run_id}:${outcome.kind}:${outcome.reason ?? ""}`) });
        if (outcome.kind === "human_required") this.suspendForHuman(schedule.schedule_id, outcome.reason ?? "scheduled run requires human input");
      }
      if (schedule.trigger.kind !== "external" && due.length > 0 && this.store.get(schedule.schedule_id)?.state === "active") this.advance(schedule, due[due.length - 1]!);
    }
    return emitted;
  }
  private record(schedule: CampaignSchedule, dueAt: Date, now: Date, decision: ScheduledRunRecord["decision"], source: ScheduledRunRecord["plan_source"]): ScheduledRunRecord {
    const run: ScheduledRunRecord = Object.freeze({ run_id: `${schedule.schedule_id}:${schedule.version}:${dueAt.toISOString()}:${decision}`, schedule_id: schedule.schedule_id, schedule_version: schedule.version, campaign_id: schedule.campaign_id, due_at: dueAt.toISOString(), fired_at: now.toISOString(), decision, plan_source: source, evidence_ref: hash(`${schedule.schedule_id}:${schedule.version}:${dueAt.toISOString()}:${decision}`) });
    this.store.appendRun(run); return run;
  }
  private advance(schedule: CampaignSchedule, last: Date): void {
    const next = schedule.trigger.kind === "cron" ? nextCronOccurrence(schedule.trigger.expression, last).toISOString() : null;
    this.store.put({ ...schedule, version: schedule.version + 1, last_fire_at: last.toISOString(), next_fire_at: next, state: schedule.trigger.kind === "once" ? "completed" : schedule.state });
  }
  private transition(id: string, patch: Partial<CampaignSchedule>): CampaignSchedule { const old = this.store.get(id); if (!old) throw new Error("schedule not found"); return this.store.put({ ...old, ...patch, version: old.version + 1 }); }
}
function initialNext(trigger: ScheduleTrigger, now: Date): string | null { if (trigger.kind === "external") return null; if (trigger.kind === "once") { if (Number.isNaN(Date.parse(trigger.at))) throw new Error("once trigger requires an ISO timestamp"); return new Date(trigger.at).toISOString(); } return nextCronOccurrence(trigger.expression, new Date(now.getTime() - 60_000)).toISOString(); }
function dueTimes(schedule: CampaignSchedule, now: Date, external: string | null): Date[] {
  if (schedule.trigger.kind === "external") return external === schedule.trigger.key ? [now] : [];
  if (!schedule.next_fire_at || new Date(schedule.next_fire_at) > now) return [];
  if (schedule.trigger.kind === "once" || schedule.catch_up !== "backfill_all") return [new Date(schedule.next_fire_at)];
  const due: Date[] = []; let cursor = new Date(schedule.next_fire_at); while (cursor <= now && due.length < schedule.max_backfill) { due.push(cursor); cursor = nextCronOccurrence(schedule.trigger.expression, cursor); } return due;
}
function hash(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
