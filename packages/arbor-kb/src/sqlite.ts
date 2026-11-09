// arbor-kb — SQLite-backed Knowledge Base store (optional backend)
// Uses Node 22's built-in node:sqlite: no native deps, no better-sqlite3.
// Clean-room design: mirrors KnowledgeBase public API with SQL persistence.
//
// The node:sqlite module is loaded lazily to avoid vitest
// static-analysis failures in test suites that don't touch the SQLite path.

import { createRequire } from "node:module";
import type { Envelope, AbsenceReason, Provenance, CapabilityContext } from "@arbor/core";
import { canonicalizeForHash as canonicalJson } from "@arbor/core";
import { isValidKBEntry, KBIntegrityError, type KBEntry, type KBEntryTier, type KbStore } from "./kb.js";
import { DEFAULT_KB_INJECT_TOP_K, kbEntryRankingText, loadVendoredEmbeddingPort, selectTopK, type EmbeddingPort } from "./retrieval.js";

// node:sqlite is only resolvable via require (native module). We use
// createRequire(import.meta.url) so it works in true ESM — a bare require()
// would throw "require is not defined" under Node ESM at runtime (it only
// appears to work in vitest because vite transpiles to CJS interop).
const _require = createRequire(import.meta.url);

// Lazy-loaded DatabaseSync — only resolved when a SqliteKbStore is constructed.
let _DatabaseSync: (new (path: string) => DatabaseSyncInstance) | null = null;

interface DatabaseSyncInstance {
  exec(sql: string): void;
  prepare(sql: string): StatementInstance;
  close(): void;
}

interface StatementInstance {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown | undefined;
}

// Runtime-aware, because the built-in SQLite module is not the same on both
// runtimes this repo now supports (see docs/bun-migration-plan.md). Bun does
// NOT ship Node 22's `node:sqlite` — importing it there fails outright with
// "No such built-in module: node:sqlite" — but it ships `bun:sqlite`, whose
// `Database` satisfies exactly the three-method surface this module uses
// (`exec`, `prepare` -> `run`/`all`/`get`, `close`). Both were verified
// empirically against both runtimes on 2026-08-07, not assumed from docs.
//
// The branch is on `globalThis.Bun` rather than a try/catch around the
// require, so a genuine load failure on either runtime still surfaces as
// itself instead of being silently swallowed into a fallback that then fails
// somewhere less legible.
function getDatabaseSync(): new (path: string) => DatabaseSyncInstance {
  if (!_DatabaseSync) {
    if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
      const m = _require("bun:sqlite") as { Database: new (path: string) => DatabaseSyncInstance };
      _DatabaseSync = m.Database;
    } else {
      const m = _require("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSyncInstance };
      _DatabaseSync = m.DatabaseSync;
    }
  }
  return _DatabaseSync;
}

// ============================================================
// SQLITE SCHEMA
// ============================================================

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS kb_entries (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('failure_mode', 'success_pattern', 'parameter_finding')),
    value TEXT NOT NULL,
    provenance_json TEXT NOT NULL,
    as_of TEXT NOT NULL,
    tier TEXT NOT NULL CHECK(tier IN ('specialist_visible', 'critic_only')),
    tags_json TEXT NOT NULL DEFAULT '[]',
    failure_mode TEXT,
    root_cause TEXT,
    fix_template TEXT,
    parameter TEXT,
    validated_value TEXT,
    created_at TEXT NOT NULL,
    embedding_json TEXT,
    embedding_model TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_kb_campaign ON kb_entries(campaign_id);
  CREATE INDEX IF NOT EXISTS idx_kb_type ON kb_entries(type);
  CREATE INDEX IF NOT EXISTS idx_kb_campaign_type ON kb_entries(campaign_id, type);
`;

// ============================================================
// SQLITE KB STORE
// ============================================================

/**
 * SQLite-backed knowledge base store.
 *
 * Mirrors the KnowledgeBase public API: write(), read(), query(), inject(),
 * plus JSONL import/export for migration.
 *
 * Uses Node 22's built-in node:sqlite (DatabaseSync). The dbPath can be
 * ":memory:" for an ephemeral DB or a file path for persistence.
 */
export class SqliteKbStore implements KbStore {
  private db: DatabaseSyncInstance;
  private nextId = 0;
  private readonly embedder: EmbeddingPort | null;

  /**
   * `embedder` defaults to the real vendored model loader (ADR-112 Decision
   * 1), mirroring `KnowledgeBase`'s constructor so both `KbStore` backends
   * agree on retrieval semantics, not just persistence semantics. Tests
   * inject a deterministic double here for the same reason kb.ts's does.
   */
  constructor(dbPath = ":memory:", embedder: EmbeddingPort | null = loadVendoredEmbeddingPort()) {
    const DatabaseSync = getDatabaseSync();
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    this.initNextId();
    this.embedder = embedder;
  }

  // --- Internal helpers ---

  private initNextId(): void {
    const rows = this.db.prepare("SELECT id FROM kb_entries").all() as { id: string }[];
    for (const row of rows) {
      const match = /^kb_([0-9a-z]+)$/i.exec(row.id);
      if (!match) continue;
      const numeric = Number.parseInt(match[1]!, 36);
      if (Number.isSafeInteger(numeric)) this.nextId = Math.max(this.nextId, numeric);
    }
  }

  private rowToEntry(r: Record<string, unknown>): KBEntry {
    return {
      id: r["id"] as string,
      campaign_id: r["campaign_id"] as string,
      type: r["type"] as KBEntry["type"],
      value: r["value"] as string,
      provenance: JSON.parse(r["provenance_json"] as string) as Provenance,
      as_of: r["as_of"] as string,
      tier: r["tier"] as KBEntryTier,
      tags: JSON.parse(r["tags_json"] as string) as string[],
      failure_mode: (r["failure_mode"] as string) ?? undefined,
      root_cause: (r["root_cause"] as string) ?? undefined,
      fix_template: (r["fix_template"] as string) ?? undefined,
      parameter: (r["parameter"] as string) ?? undefined,
      validated_value: (r["validated_value"] as string) ?? undefined,
      created_at: r["created_at"] as string,
      embedding: r["embedding_json"] ? (JSON.parse(r["embedding_json"] as string) as number[]) : undefined,
      embedding_model: (r["embedding_model"] as string) ?? undefined,
    };
  }

  // --- Write side ---

  /**
   * Write a KB entry. Returns the entry's stable id.
   */
  write(entry: Omit<KBEntry, "id" | "created_at">): string {
    const id = `kb_${(++this.nextId).toString(36)}`;
    const created_at = new Date().toISOString();
    const embedding = this.embedder ? this.embedder.embed(kbEntryRankingText({ ...entry, id, created_at } as KBEntry)) : null;
    const embedding_model = this.embedder ? this.embedder.model_key : null;

    if (!isValidKBEntry({ ...entry, id, created_at, ...(embedding ? { embedding, embedding_model } : {}) })) {
      throw new Error("Invalid KB entry: every entry requires complete provenance");
    }

    this.db.prepare(`
      INSERT INTO kb_entries (id, campaign_id, type, value, provenance_json, as_of,
        tier, tags_json, failure_mode, root_cause, fix_template, parameter,
        validated_value, created_at, embedding_json, embedding_model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      entry.campaign_id,
      entry.type,
      entry.value,
      JSON.stringify(entry.provenance),
      entry.as_of,
      entry.tier,
      JSON.stringify(entry.tags),
      entry.failure_mode ?? null,
      entry.root_cause ?? null,
      entry.fix_template ?? null,
      entry.parameter ?? null,
      entry.validated_value ?? null,
      created_at,
      embedding ? JSON.stringify(embedding) : null,
      embedding_model,
    );

    return id;
  }

  // --- Read side (envelope-wrapped, capability-gated) ---

  /**
   * Read a single KB entry by id. Returns an envelope.
   * Capability-gated: critic_only entries return absence=ccapability_required for specialists.
   */
  read(id: string, cap: CapabilityContext): Envelope<KBEntry> {
    const rows = this.db.prepare("SELECT * FROM kb_entries WHERE id = ?").all(id) as Record<string, unknown>[];
    if (rows.length === 0) {
      return absentEnvelope(id, "not_found");
    }

    const entry = this.rowToEntry(rows[0]);

    // Capability gate: specialists can't see critic_only entries
    if (entry.tier === "critic_only" && cap.tier === "specialist") {
      return absentEnvelope(id, "capability_required");
    }

    return {
      value: entry,
      provenance: entry.provenance,
      as_of: entry.as_of,
      id: entry.id,
      absence: null,
    };
  }

  /**
   * Query KB entries by campaign and optional filter.
   * Returns envelopes, capability-gated.
   */
  query(
    campaignId: string | null,
    filter: { type?: KBEntry["type"]; tags?: string[] } | null,
    cap: CapabilityContext,
  ): Envelope<KBEntry>[] {
    let sql = "SELECT * FROM kb_entries WHERE 1=1";
    const params: (string | number)[] = [];

    if (campaignId) {
      sql += " AND campaign_id = ?";
      params.push(campaignId);
    }

    if (filter?.type) {
      sql += " AND type = ?";
      params.push(filter.type);
    }

    sql += " ORDER BY created_at DESC";

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];

    let entries = rows.map((r) => this.rowToEntry(r));

    // Tag filter applied in JS (SQLite JSON extraction is verbose)
    if (filter?.tags && filter.tags.length > 0) {
      entries = entries.filter((e) => filter.tags!.every((t) => e.tags.includes(t)));
    }

    return entries.map((entry) => {
      if (entry.tier === "critic_only" && cap.tier === "specialist") {
        return absentEnvelope(entry.id, "capability_required");
      }
      return {
        value: entry,
        provenance: entry.provenance,
        as_of: entry.as_of,
        id: entry.id,
        absence: null,
      };
    });
  }

  /**
   * Inject relevant KB entries into a prompt string.
   * This mirrors KnowledgeBase.inject() exactly, including the optional
   * category scope for specialist failure-mode injection and (ADR-112
   * Decision 2) the ranked, bounded `topK` cap on both paths.
   */
  inject(prompt: string, campaignId: string, cap: CapabilityContext, category?: string, topK = DEFAULT_KB_INJECT_TOP_K): string {
    if (cap.tier === "specialist") {
      const preFiltered = this.query(campaignId, { type: "failure_mode" }, cap)
        .filter((e) => e.value !== null)
        .filter((e) => !category || (e.value as KBEntry).tags.includes(category))
        .map((e) => e.value as KBEntry);
      if (preFiltered.length === 0) return prompt;

      const { entries } = selectTopK(preFiltered, prompt, { top_k: topK, embedder: this.embedder });

      const kbBlock = entries
        .map((entry) => `- Prior failure in this area: ${entry.failure_mode ?? entry.value} (root cause: ${entry.root_cause ?? "unknown"})`)
        .join("\n");

      return `${prompt}\n\n--- KB CONTEXT (prior failures) ---\n${kbBlock}\n--- END KB CONTEXT ---`;
    }

    const preFiltered = this.query(campaignId, null, cap).filter((e) => e.value !== null).map((e) => e.value as KBEntry);
    if (preFiltered.length === 0) return prompt;

    const { entries } = selectTopK(preFiltered, prompt, { top_k: topK, embedder: this.embedder });

    const kbBlock = entries
      .map((entry) => `- [${entry.type}] ${entry.value} (provenance: ${entry.provenance.tag})`)
      .join("\n");

    return `${prompt}\n\n--- KB CONTEXT ---\n${kbBlock}\n--- END KB CONTEXT ---`;
  }

  // --- Serialization ---

  /**
   * Export all entries as JSONL. For migration and interoperability.
   */
  toJSONL(): string {
    const rows = this.db.prepare("SELECT * FROM kb_entries ORDER BY created_at").all() as Record<string, unknown>[];
    return rows.map((r) => {
      const entry = this.rowToEntry(r);
      return JSON.stringify(entry);
    }).join("\n");
  }

  /**
   * Import entries from JSONL. Idempotent for a byte-identical re-append of
   * an id already present — but a duplicate id whose content *differs* from
   * what's stored is a genuine conflict (replay, merge accident, or
   * tampering), never a legitimate re-append, and is rejected with
   * KBIntegrityError naming the conflicting id. This mirrors
   * KnowledgeBase.fromJSONL's semantics (kb.ts) so both KbStore backends
   * agree on what counts as a duplicate; previously this method used
   * `INSERT OR IGNORE`, which silently kept the first-seen row and dropped
   * every conflicting duplicate with no signal at all — fail-open on
   * exactly the input this check exists to catch.
   */
  fromJSONL(data: string): number {
    const countBefore = (
      this.db.prepare("SELECT COUNT(*) as cnt FROM kb_entries").get() as { cnt: number }
    ).cnt;

    const selectStmt = this.db.prepare("SELECT * FROM kb_entries WHERE id = ?");
    const insertStmt = this.db.prepare(`
      INSERT INTO kb_entries (id, campaign_id, type, value, provenance_json, as_of,
        tier, tags_json, failure_mode, root_cause, fix_template, parameter,
        validated_value, created_at, embedding_json, embedding_model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const line of data.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(trimmed) as unknown;
      } catch {
        // Skip malformed lines
        continue;
      }
      if (!isValidKBEntry(entry)) continue;

      const existingRows = selectStmt.all(entry.id) as Record<string, unknown>[];
      if (existingRows.length > 0) {
        const existingEntry = this.rowToEntry(existingRows[0]);
        if (canonicalJson(existingEntry) !== canonicalJson(entry)) {
          throw new KBIntegrityError(`conflicting KB entry for id ${entry.id}`);
        }
        continue; // byte-identical re-append: idempotent, not a conflict
      }

      insertStmt.run(
        entry.id,
        entry.campaign_id,
        entry.type,
        entry.value,
        JSON.stringify(entry.provenance),
        entry.as_of,
        entry.tier,
        JSON.stringify(entry.tags),
        entry.failure_mode ?? null,
        entry.root_cause ?? null,
        entry.fix_template ?? null,
        entry.parameter ?? null,
        entry.validated_value ?? null,
        entry.created_at,
        entry.embedding ? JSON.stringify(entry.embedding) : null,
        entry.embedding_model ?? null,
      );
    }

    const countAfter = (
      this.db.prepare("SELECT COUNT(*) as cnt FROM kb_entries").get() as { cnt: number }
    ).cnt;

    // Update nextId after import
    this.initNextId();
    return countAfter - countBefore;
  }

  /**
   * Return every entry, detached from the live row set. Mirrors
   * `KnowledgeBase.getEntries()` for persistence adapters and legacy-entry
   * detection that must work identically across backends.
   */
  getEntries(): readonly KBEntry[] {
    const rows = this.db.prepare("SELECT * FROM kb_entries ORDER BY created_at").all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToEntry(r));
  }

  /**
   * Remove all entries. Used by projection-replace persistence (mirrors
   * `saveKBProjection`'s atomic, non-merging file overwrite) so a rebuilt
   * ledger projection never leaves stale rows behind.
   */
  clear(): void {
    this.db.exec("DELETE FROM kb_entries");
    this.nextId = 0;
  }

  /**
   * WA-17: atomically replace the store's entire contents with `data`'s
   * JSONL, in one SQLite transaction. `saveKBToSqlite` (persist.ts) used to
   * call `clear()` then `fromJSONL()` as two independent statements — a
   * throw partway through `fromJSONL` (a conflicting/duplicate id, mirroring
   * `fromJSONL`'s own conflict rule) left the store cleared but only
   * partially repopulated, which for the on-disk persistence path meant a
   * crash mid-save could empty the knowledge base. Wrapping both in
   * BEGIN/COMMIT and rolling back on any throw makes the replace all-or-
   * nothing: either every row lands, or none of the prior rows are ever
   * removed.
   */
  replaceAll(data: string): number {
    const priorNextId = this.nextId;
    this.db.exec("BEGIN");
    try {
      this.clear();
      const imported = this.fromJSONL(data);
      this.db.exec("COMMIT");
      return imported;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Nothing to roll back to if BEGIN itself never took effect; the
        // original error is what matters below regardless.
      }
      // clear()/fromJSONL() may have already advanced this in-memory
      // counter past what the rolled-back DB actually contains; restore it
      // so a later write() cannot mint an id that collides with a row the
      // rollback just brought back.
      this.nextId = priorNextId;
      throw error;
    }
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}

// ============================================================
// HELPERS
// ============================================================

function absentEnvelope(id: string, reason: AbsenceReason): Envelope<KBEntry> {
  return {
    value: null,
    provenance: null,
    as_of: new Date().toISOString(),
    id,
    absence: reason,
  };
}
