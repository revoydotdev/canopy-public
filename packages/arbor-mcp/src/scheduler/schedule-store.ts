import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CampaignSchedule, ScheduledRunRecord } from "./contracts.js";

interface Snapshot { readonly schema_version: 1; readonly revision: number; readonly schedules: readonly CampaignSchedule[]; readonly runs: readonly ScheduledRunRecord[] }
export class DurableScheduleStore {
  private readonly file: string;
  private revision = 0;
  private schedules = new Map<string, CampaignSchedule>();
  private runs: ScheduledRunRecord[] = [];
  constructor(private readonly persistenceDir: string) { this.file = join(persistenceDir, "scheduler", "registry.json"); this.load(); }
  list(): readonly CampaignSchedule[] { return [...this.schedules.values()].sort((a, b) => a.schedule_id.localeCompare(b.schedule_id)); }
  get(id: string): CampaignSchedule | null { return this.schedules.get(id) ?? null; }
  runHistory(scheduleId?: string): readonly ScheduledRunRecord[] { return this.runs.filter((run) => scheduleId === undefined || run.schedule_id === scheduleId); }
  put(value: CampaignSchedule): CampaignSchedule {
    const prior = this.schedules.get(value.schedule_id);
    if (prior && value.version !== prior.version + 1) throw new Error("stale schedule version");
    if (!prior && value.version !== 1) throw new Error("new schedule must start at version 1");
    this.schedules.set(value.schedule_id, Object.freeze(structuredClone(value))); this.persist(); return value;
  }
  appendRun(run: ScheduledRunRecord): void { if (this.runs.some((value) => value.run_id === run.run_id)) return; this.runs.push(Object.freeze({ ...run })); this.persist(); }
  private load(): void {
    if (!existsSync(this.file)) return;
    const raw = JSON.parse(readFileSync(this.file, "utf8")) as Snapshot;
    if (raw.schema_version !== 1 || !Number.isSafeInteger(raw.revision) || !Array.isArray(raw.schedules) || !Array.isArray(raw.runs)) throw new Error("invalid scheduler registry");
    this.revision = raw.revision; this.schedules = new Map(raw.schedules.map((value) => [value.schedule_id, Object.freeze(structuredClone(value))])); this.runs = raw.runs.map((value) => Object.freeze({ ...value }));
  }
  private persist(): void {
    const directory = join(this.persistenceDir, "scheduler"); mkdirSync(directory, { recursive: true, mode: 0o700 }); this.revision += 1;
    const temporary = join(directory, `.registry.${process.pid}.tmp`);
    writeFileSync(temporary, JSON.stringify({ schema_version: 1, revision: this.revision, schedules: this.list(), runs: this.runs }), { mode: 0o600 });
    const fd = openSync(temporary, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } renameSync(temporary, this.file);
  }
}
