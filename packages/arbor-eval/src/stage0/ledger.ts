/**
 * arbor-eval/stage0/ledger — the append-only, machine-readable results ledger.
 *
 * One JSON object per line. Entries are only ever appended; a re-run of a
 * unit appends new attempts and the reader refuses duplicates rather than
 * silently choosing one. A torn final line (a crash mid-append) is reported
 * and skipped, never repaired in place.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { STAGE0_ATTEMPT_SCHEMA, STAGE0_CORRECTION_SCHEMA, STAGE0_WAVE_SCHEMA } from "./types.js";
import type { Stage0AttemptRecord, Stage0CorrectionRecord, Stage0Experiment, Stage0LedgerEntry, Stage0WaveRecord } from "./types.js";

export function appendLedger(path: string, entry: Stage0LedgerEntry): void {
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

export function logEvent(path: string, experiment: Stage0Experiment, event: string, detail: Record<string, unknown> = {}): void {
  appendLedger(path, { schema: "revoy2.stage0.event.v1", experiment, at: new Date().toISOString(), event, detail });
}

export interface ParsedLedger {
  readonly attempts: readonly Stage0AttemptRecord[];
  readonly waves: readonly Stage0WaveRecord[];
  /** Corrections, in ledger order; already applied to `attempts`. */
  readonly corrections: readonly Stage0CorrectionRecord[];
  readonly events: readonly Extract<Stage0LedgerEntry, { schema: "revoy2.stage0.event.v1" }>[];
  /** 1-based line numbers that did not parse (expected only for a torn last line). */
  readonly unparsed_lines: readonly number[];
}

export function parseLedger(text: string, experiment?: Stage0Experiment): ParsedLedger {
  const attempts: Stage0AttemptRecord[] = [];
  const waves: Stage0WaveRecord[] = [];
  const corrections: Stage0CorrectionRecord[] = [];
  const events: Extract<Stage0LedgerEntry, { schema: "revoy2.stage0.event.v1" }>[] = [];
  const unparsed: number[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    let entry: Stage0LedgerEntry;
    try {
      entry = JSON.parse(line) as Stage0LedgerEntry;
    } catch {
      unparsed.push(i + 1);
      continue;
    }
    if (experiment !== undefined && entry.experiment !== experiment) continue;
    if (entry.schema === STAGE0_ATTEMPT_SCHEMA) {
      const key = `${entry.experiment}\u0000${entry.task_id}\u0000${entry.seed}\u0000${entry.attempt_index}`;
      if (seen.has(key)) throw new Error(`ledger line ${i + 1}: duplicate attempt ${entry.task_id}#${entry.seed}/a${entry.attempt_index} (${entry.experiment})`);
      seen.add(key);
      attempts.push(entry);
    } else if (entry.schema === STAGE0_WAVE_SCHEMA) {
      waves.push(entry);
    } else if (entry.schema === STAGE0_CORRECTION_SCHEMA) {
      corrections.push(entry);
    } else {
      events.push(entry);
    }
  }
  const corrected = attempts.map((attempt) => {
    let current = attempt;
    for (const correction of corrections) {
      if (correction.task_id !== attempt.task_id || correction.seed !== attempt.seed || correction.attempt_index !== attempt.attempt_index || correction.experiment !== attempt.experiment) continue;
      current = { ...current, ...pickMeasurement(correction.set) };
    }
    return current;
  });
  return { attempts: corrected, waves, corrections, events, unparsed_lines: unparsed };
}

/** Only measurement fields pass; outcome fields in a correction are ignored. */
function pickMeasurement(set: Stage0CorrectionRecord["set"]): Stage0CorrectionRecord["set"] {
  const allowed = ["cost_usd", "cost_priced_usd", "cost_unpriced_estimate_usd", "unpriced_spans", "tokens", "unrecorded_usage", "campaign_id", "failure_class", "failure_detail"] as const;
  const out: Record<string, unknown> = {};
  for (const key of allowed) if (key in set) out[key] = set[key];
  return out as Stage0CorrectionRecord["set"];
}

export function readLedger(path: string, experiment?: Stage0Experiment): ParsedLedger {
  if (!existsSync(path)) return { attempts: [], waves: [], corrections: [], events: [], unparsed_lines: [] };
  return parseLedger(readFileSync(path, "utf8"), experiment);
}

/** Attempts grouped by unit key `${task_id}#${seed}`. */
export function groupUnits(attempts: readonly Stage0AttemptRecord[]): Map<string, Stage0AttemptRecord[]> {
  const units = new Map<string, Stage0AttemptRecord[]>();
  for (const attempt of attempts) {
    const key = `${attempt.task_id}#${attempt.seed}`;
    const list = units.get(key) ?? [];
    list.push(attempt);
    units.set(key, list);
  }
  for (const list of units.values()) list.sort((a, b) => a.attempt_index - b.attempt_index);
  return units;
}

/**
 * Freeze the preregistration into the ledger (pilot-3 D5). Refuses when the
 * file is missing. A fresh ledger gets `preregistration_frozen` (path, sha256,
 * timestamp) as its first line; a ledger that already has one is resumed only
 * if the file still hashes to the frozen value.
 */
export function freezePreregistration(ledger: string, experiment: Stage0Experiment, preregistrationPath: string): { readonly sha256: string; readonly written: boolean } {
  if (!existsSync(preregistrationPath)) throw new Error(`preregistration file not found: ${preregistrationPath}; refusing to run without a frozen preregistration`);
  const sha256 = createHash("sha256").update(readFileSync(preregistrationPath)).digest("hex");
  mkdirSync(dirname(ledger), { recursive: true });
  const frozen = readLedger(ledger, experiment).events.find((entry) => entry.event === "preregistration_frozen");
  if (frozen === undefined) {
    logEvent(ledger, experiment, "preregistration_frozen", { path: preregistrationPath, sha256, frozen_at: new Date().toISOString() });
    return { sha256, written: true };
  }
  const previous = (frozen.detail as { sha256?: unknown }).sha256;
  if (previous !== sha256) throw new Error(`preregistration changed since it was frozen in ${ledger}: frozen ${String(previous)}, now ${sha256}`);
  return { sha256, written: false };
}
