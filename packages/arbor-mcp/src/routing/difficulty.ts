import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface DifficultyTaskFeatures { readonly description: string; readonly category: string; readonly constraints: readonly string[]; readonly estimated_gain: number; readonly estimated_cost: number; readonly high_stakes?: boolean; readonly decomposition_depth?: number }
interface Observation { successes: number; failures: number }

/** Deterministic calibrated head whose feedback state is durable ledger evidence. */
export class DifficultyCalibrator {
  private readonly observations = new Map<string, Observation>();
  private readonly file: string | null;
  constructor(persistenceDir?: string) { this.file = persistenceDir ? join(persistenceDir, "routing", "difficulty-observations.json") : null; this.load(); }
  estimate(task: DifficultyTaskFeatures): number {
    const length = Math.min(1, task.description.length / 600);
    const constraintLoad = Math.min(1, task.constraints.length / 8);
    const costRatio = Math.max(0, task.estimated_cost) / Math.max(1, Math.max(0, task.estimated_gain) + Math.max(0, task.estimated_cost));
    const depth = Math.min(1, (task.decomposition_depth ?? 0) / 3);
    const base = clamp(0.08 + 0.22 * length + 0.18 * constraintLoad + 0.22 * costRatio + 0.2 * depth + (task.high_stakes ? 0.1 : 0));
    const observed = this.observations.get(task.category);
    if (!observed || observed.successes + observed.failures === 0) return base;
    const empiricalFailure = (observed.failures + 1) / (observed.successes + observed.failures + 2);
    const weight = Math.min(0.7, (observed.successes + observed.failures) / 20);
    return clamp(base * (1 - weight) + empiricalFailure * weight);
  }
  record(category: string, succeeded: boolean): void {
    const old = this.observations.get(category) ?? { successes: 0, failures: 0 };
    this.observations.set(category, succeeded ? { ...old, successes: old.successes + 1 } : { ...old, failures: old.failures + 1 }); this.persist();
  }
  private load(): void { if (!this.file || !existsSync(this.file)) return; const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, Observation>; for (const [key, value] of Object.entries(raw)) if (Number.isSafeInteger(value.successes) && Number.isSafeInteger(value.failures)) this.observations.set(key, value); }
  private persist(): void { if (!this.file) return; mkdirSync(dirname(this.file), { recursive: true }); const temporary = `${this.file}.${process.pid}.tmp`; writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.observations))); renameSync(temporary, this.file); }
}
function clamp(value: number): number { return Math.max(0.01, Math.min(0.99, value)); }
