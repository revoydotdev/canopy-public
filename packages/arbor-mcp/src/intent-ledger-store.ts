import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendIntentLifecycleRecord, parseIntentLedger, serializeIntentLedger } from "@arbor/core";
import type { IntentLedger, IntentLifecycleRecord } from "@arbor/core";

/**
 * Durable, append-only backing store for `IntentLedger` — the concrete
 * "durable intent ledger" ADR-062's intake path was missing a production
 * writer for. One ledger per intent id.
 *
 * Mirrors `TaskComposer`'s own persistence convention
 * (`task-composer.ts`'s `persist()`): a temp-file-then-rename atomic
 * snapshot write, gated on a configured directory (`null` = in-memory
 * only, same as `TaskComposer.path === null`). Additively, every accepted
 * record is also appended as its own line to a `.jsonl` history file —
 * genuinely append-only, and the artifact `parseIntentLedger`/
 * `appendIntentLifecycleRecord` replay from when a snapshot is missing or
 * corrupt (e.g. a crash between two lines).
 *
 * The in-memory `Map` is always the source of truth for reads within this
 * process — durability to disk is additive, exactly like drafts.json is
 * for `TaskComposer` itself, so callers get a working ledger even when no
 * `persistence_dir` is configured (the common case in tests and in an
 * embedded/ephemeral composer).
 */
export class IntentLedgerStore {
  private readonly ledgers = new Map<string, IntentLedger>();
  private readonly dir: string | null;

  constructor(dir: string | null) {
    this.dir = dir === null ? null : join(dir, "intent-ledger");
  }

  get(intentId: string): IntentLedger | null {
    const cached = this.ledgers.get(intentId);
    if (cached) return cached;
    const restored = this.restore(intentId);
    if (restored) this.ledgers.set(intentId, restored);
    return restored;
  }

  /**
   * Validate and durably append one record. Throws on a genuine sequencing
   * or shape violation (a wiring bug in the caller, never a fact about the
   * operator's request) rather than silently dropping governance evidence.
   */
  append(intentId: string, record: IntentLifecycleRecord): IntentLedger {
    const prior = this.get(intentId);
    const result = appendIntentLifecycleRecord(prior, record);
    if (!result.ok) {
      throw new Error(`intent ledger append rejected for ${intentId}: ${result.violations.map((v) => `${v.code} ${v.path}: ${v.message}`).join("; ")}`);
    }
    this.ledgers.set(intentId, result.ledger);
    this.persist(intentId, record, result.ledger);
    return result.ledger;
  }

  private jsonlPath(intentId: string): string | null { return this.dir === null ? null : join(this.dir, `${safeName(intentId)}.jsonl`); }
  private snapshotPath(intentId: string): string | null { return this.dir === null ? null : join(this.dir, `${safeName(intentId)}.json`); }

  private persist(intentId: string, record: IntentLifecycleRecord, ledger: IntentLedger): void {
    const jsonl = this.jsonlPath(intentId);
    const snapshot = this.snapshotPath(intentId);
    if (jsonl === null || snapshot === null) return;
    mkdirSync(this.dir!, { recursive: true, mode: 0o700 });
    appendFileSync(jsonl, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    const temporary = `${snapshot}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, `${serializeIntentLedger(ledger)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, snapshot);
  }

  private restore(intentId: string): IntentLedger | null {
    const snapshot = this.snapshotPath(intentId);
    if (snapshot !== null && existsSync(snapshot)) {
      try {
        const parsed = parseIntentLedger(JSON.parse(readFileSync(snapshot, "utf8")));
        if (parsed) return parsed;
      } catch { /* fall through to jsonl replay below */ }
    }
    const jsonl = this.jsonlPath(intentId);
    if (jsonl === null || !existsSync(jsonl)) return null;
    let ledger: IntentLedger | null = null;
    for (const line of readFileSync(jsonl, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      let record: unknown;
      try { record = JSON.parse(line); } catch { continue; }
      const appended = appendIntentLifecycleRecord(ledger, record as IntentLifecycleRecord);
      if (!appended.ok) continue; // a corrupt/out-of-order line is skipped, never fabricated into a valid one
      ledger = appended.ledger;
    }
    return ledger;
  }
}

function safeName(intentId: string): string {
  return intentId.replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 200);
}
