import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { quarantinePersistenceFile, type PersistenceDiagnostic, type PersistenceLoadResult } from "@arbor/core";
import { KnowledgeBase, KBIntegrityError, parseKBStream, serializeKBStream, type KBEntry } from "./kb.js";
import { SqliteKbStore } from "./sqlite.js";


/**
 * Atomically replace the disposable KB materialization with an exact,
 * ledger-derived projection. It deliberately does not merge rows from the
 * prior cache; callers must already hold the authority from which every
 * projected entry was rebuilt. (The older merge-on-write `saveKB`/`loadKB`
 * compatibility pair was deleted 2026-08-06 — `manager.ts` had long since
 * moved to this projection and `loadKBResult`, leaving the pair and its
 * internal merge helper unreachable.)
 */
export function saveKBProjection(kb: KnowledgeBase, dir: string): void {
  const kbDir = join(dir, "kb");
  mkdirSync(kbDir, { recursive: true });
  const entries = [...kb.getEntries()];
  for (const [type, fileName] of Object.entries(FILE_NAMES) as [KBEntry["type"], string][]) {
    atomicWrite(join(kbDir, fileName), serializeKBStream(type, entries));
  }
}

export function loadKBResult(dir: string): PersistenceLoadResult<KnowledgeBase> {
  const kbDir = join(dir, "kb");
  const kb = new KnowledgeBase();
  const diagnostics: PersistenceDiagnostic[] = [];

  if (!existsSync(kbDir)) return { value: kb, diagnostics };

  for (const [type, file] of Object.entries(FILE_NAMES) as [KBEntry["type"], string][]) {
    const filePath = join(kbDir, file);
    if (!existsSync(filePath)) continue;
    try {
      const data = readFileSync(filePath, "utf-8");
      // `.integrity` is deliberately unused: parseKBStream throws
      // KBIntegrityError (caught below, quarantined) on every failure mode
      // it can detect, so a returned verdict is always `{valid: true,
      // error: null}` and its remaining fields (`legacy`, `entry_count`)
      // are already derivable from `entries` at this call site.
      const { entries } = parseKBStream(data, type);
      kb.fromJSONL(entries.map((entry) => JSON.stringify(entry)).join("\n"));
    } catch (error) {
      const syntax = error instanceof SyntaxError;
      diagnostics.push(quarantinePersistenceFile(
        filePath, dir, "knowledge_base", syntax ? "invalid_json" : "integrity_failure",
        `knowledge-base stream ${file} could not be trusted: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
  }

  return { value: kb, diagnostics };
}


const FILE_NAMES: Record<KBEntry["type"], string> = {
  failure_mode: "failure-modes.jsonl",
  success_pattern: "success-patterns.jsonl",
  parameter_finding: "parameter-findings.jsonl",
};


/** Write a complete sealed snapshot, fsync it, then atomically publish it. */
function atomicWrite(filePath: string, content: string): void {
  const temporary = `${filePath}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, content, "utf-8");
    // Windows' FlushFileBuffers path rejects a read-only handle with EPERM;
    // reopen the fully written temporary file read/write so fsync remains a
    // real durability barrier on every supported platform.
    const fileDescriptor = openSync(temporary, "r+");
    try {
      fsyncSync(fileDescriptor);
    } finally {
      closeSync(fileDescriptor);
    }
    renameSync(temporary, filePath);
    // POSIX requires syncing the parent directory to make the rename itself
    // durable across a crash. Windows does not expose directory handles with
    // Node's file-fsync semantics: opening the directory succeeds, but
    // fsyncSync rejects it with EPERM. The temporary file was already flushed
    // above and renameSync is the atomic publication boundary on Windows.
    if (process.platform !== "win32") {
      const directoryDescriptor = openSync(dirname(filePath), "r");
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    }
  } catch (error) {
    throw error instanceof KBIntegrityError ? error : new KBIntegrityError(`could not durably save KB stream ${filePath}: ${String(error)}`);
  }
}

// ============================================================
// SQLITE PERSISTENCE (optional backend)
// ============================================================

/**
 * Save a SqliteKbStore's entries to a SQLite file on disk under
 * <dir>/kb/kb.sqlite. Like `saveKBProjection`, this is an atomic, exact
 * projection — it replaces the target file's contents rather than merging,
 * so a rebuilt ledger projection never leaves stale rows behind. `kb` may be
 * any store (including an in-memory `:memory:` scratch instance); the target
 * file is opened, cleared, and repopulated independently of `kb`'s own path.
 */
export function saveKBToSqlite(kb: SqliteKbStore, dir: string): string {
  const kbDir = join(dir, "kb");
  mkdirSync(kbDir, { recursive: true });
  const dbPath = join(kbDir, "kb.sqlite");
  const serialized = kb.toJSONL(); // read before opening the target: kb and target may be the same file
  const target = new SqliteKbStore(dbPath);
  try {
    // WA-17: `replaceAll` runs clear()+fromJSONL() inside one SQLite
    // transaction — a throw partway through (a conflicting/duplicate id)
    // rolls back to the pre-replace contents instead of leaving the target
    // cleared but only partially repopulated. Two independent statements
    // here previously meant a crash or thrown error mid-save could empty
    // the on-disk knowledge base.
    target.replaceAll(serialized);
  } finally {
    target.close();
  }
  return dbPath;
}

/**
 * Load a SqliteKbStore from a SQLite file on disk, or create a fresh one.
 * If the SQLite DB doesn't exist but JSONL files do, migrate JSONL into SQLite.
 *
 * Returns { store, migrated } where migrated is the count of entries imported
 * from JSONL (0 if the SQLite DB already had data).
 */
export function loadKBFromSqlite(dir: string): { store: SqliteKbStore; migrated: number } {
  const kbDir = join(dir, "kb");
  const dbPath = join(kbDir, "kb.sqlite");
  mkdirSync(kbDir, { recursive: true });

  let store: SqliteKbStore;
  let migrated = 0;

  if (existsSync(dbPath)) {
    store = new SqliteKbStore(dbPath);
  } else {
    store = new SqliteKbStore(dbPath);

    // Auto-migrate from JSONL if available and DB is empty
    if (existsSync(kbDir)) {
      for (const [type, file] of Object.entries(FILE_NAMES) as [KBEntry["type"], string][]) {
        const filePath = join(kbDir, file);
        if (!existsSync(filePath)) continue;
        const data = readFileSync(filePath, "utf-8");
        // `.integrity` unused here too — see the loadKBResult note above.
        const parsed = parseKBStream(data, type);
        migrated += store.fromJSONL(parsed.entries.map((entry) => JSON.stringify(entry)).join("\n"));
      }
    }
  }

  return { store, migrated };
}
