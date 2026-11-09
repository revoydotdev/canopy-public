/**
 * SQLite journal for canopy-debug captures.
 *
 * The TUI capture adapter writes JSONL for human inspection; this journal is
 * the indexed, durable query side.  It deliberately uses the same event
 * envelope as `canopy-debug-capture.ts`, so callers can export NDJSON without
 * a lossy translation.  SQLite is loaded lazily because the repository still
 * supports both Bun (`bun:sqlite`) and Node 22 (`node:sqlite`).
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { CanopyDebugCaptureKind, CanopyDebugCaptureLevel, CanopyDebugCaptureRecord, CanopyDebugEventInput, CanopyDebugEventQuery } from "./canopy-debug-capture.js";

interface Statement { run(...params: unknown[]): unknown; all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown; }
interface Database { exec(sql: string): void; prepare(sql: string): Statement; close(): void; }
const require = createRequire(import.meta.url);
let DatabaseCtor: (new (path: string) => Database) | undefined;
function databaseConstructor(): new (path: string) => Database {
  if (DatabaseCtor) return DatabaseCtor;
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    DatabaseCtor = (require("bun:sqlite") as { Database: new (path: string) => Database }).Database;
  } else {
    DatabaseCtor = (require("node:sqlite") as { DatabaseSync: new (path: string) => Database }).DatabaseSync;
  }
  return DatabaseCtor;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY, opened_at TEXT NOT NULL, opened_monotonic_ns TEXT NOT NULL,
  closed_at TEXT, closed_monotonic_ns TEXT, status TEXT NOT NULL CHECK(status IN ('open','closed','recovered')),
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, schema INTEGER NOT NULL,
  timestamp TEXT NOT NULL, monotonic_ns TEXT NOT NULL, kind TEXT NOT NULL, session_id TEXT NOT NULL,
  level TEXT, correlation_id TEXT, parent_id TEXT, payload_json TEXT, artifact_path TEXT,
  bytes INTEGER, sha256 TEXT, frame_number INTEGER, metadata_json TEXT,
  FOREIGN KEY(session_id) REFERENCES sessions(session_id)
);
CREATE INDEX IF NOT EXISTS events_session_time ON events(session_id, timestamp, sequence);
CREATE INDEX IF NOT EXISTS events_kind_time ON events(kind, timestamp, sequence);
CREATE INDEX IF NOT EXISTS events_correlation ON events(correlation_id, sequence);
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, event_id TEXT NOT NULL,
  path TEXT NOT NULL, mime TEXT, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL, width INTEGER, height INTEGER, metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(session_id) REFERENCES sessions(session_id), FOREIGN KEY(event_id) REFERENCES events(id)
);
CREATE INDEX IF NOT EXISTS artifacts_session_time ON artifacts(session_id, created_at);
`;

const SECRET_KEY = /(?:authorization|api[_-]?key|credential|password|passwd|private[_-]?key|secret|token)/iu;
// Keep high-value telemetry identifiers intact.  Secret-looking field names
// are redacted structurally; this matcher only catches common provider-token
// formats when a caller puts a credential in an unlabelled field.
const SECRET_VALUE = /\b(?:sk-[A-Za-z0-9]{16,}|pk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/gu;
const MAX_TEXT = 32_768;
function redact(value: unknown, key?: string): unknown {
  if (key !== undefined && SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return value.replace(SECRET_VALUE, "[REDACTED]").slice(0, MAX_TEXT);
  if (Array.isArray(value)) return value.slice(0, 1_000).map((item) => redact(item));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 1_000).map(([k, v]) => [k, redact(v, k)]));
  return value;
}
function json(value: unknown): string { return JSON.stringify(redact(value)) ?? "null"; }
function hash(bytes: Uint8Array): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

export interface CanopyDebugArtifactInput {
  readonly artifact_id?: string; readonly event_id?: string; readonly path: string; readonly mime?: string;
  readonly bytes: number | Uint8Array; readonly sha256?: string; readonly created_at?: string;
  readonly width?: number; readonly height?: number; readonly metadata?: Readonly<Record<string, unknown>>;
}
export interface CanopyDebugArtifactRecord { readonly artifact_id: string; readonly session_id: string; readonly event_id: string; readonly path: string; readonly mime: string | null; readonly bytes: number; readonly sha256: string; readonly created_at: string; readonly width: number | null; readonly height: number | null; readonly metadata: Readonly<Record<string, unknown>>; }
export interface CanopyDebugJournalOptions { readonly path: string; readonly session_id: string; readonly clock?: () => Date; readonly monotonic?: () => bigint; readonly metadata?: Readonly<Record<string, unknown>>; }
export interface CanopyDebugJournal {
  readonly session_id: string;
  append(input: CanopyDebugEventInput): CanopyDebugCaptureRecord;
  /** Persist a capture adapter row verbatim, retaining its stable id and artifact fields. */
  appendCapture(record: CanopyDebugCaptureRecord): void;
  recordArtifact(input: CanopyDebugArtifactInput): CanopyDebugArtifactRecord;
  query(query?: CanopyDebugEventQuery): readonly CanopyDebugCaptureRecord[];
  artifacts(): readonly CanopyDebugArtifactRecord[];
  exportNdjson(query?: CanopyDebugEventQuery): string;
  close(): void;
}

/**
 * Default machine-local state root for the instrumented TUI.
 *
 * The launcher normally supplies this explicitly, but keeping the fallback in
 * the journal boundary makes embedded `runTui` callers durable as well. The
 * project-local `.arbor` root satisfies the CLI's containment rule and is the
 * repository's established ignored location for durable runtime state.
 */
export function defaultCanopyDebugPersistenceDir(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  cwd = process.cwd(),
): string {
  const configured = environment.CANOPY_DEBUG_STATE_DIR?.trim();
  if (configured !== undefined && configured.length > 0) return resolve(configured);
  return resolve(join(cwd, ".arbor", "canopy-debug"));
}

function rowToRecord(row: Record<string, unknown>): CanopyDebugCaptureRecord {
  const parsed = (key: string): Readonly<Record<string, unknown>> | undefined => row[key] === null || row[key] === undefined ? undefined : JSON.parse(String(row[key])) as Readonly<Record<string, unknown>>;
  return {
    schema: 1, id: String(row.id), timestamp: String(row.timestamp), monotonic_ns: String(row.monotonic_ns),
    kind: String(row.kind) as CanopyDebugCaptureKind, session_id: String(row.session_id),
    ...(row.level === null ? {} : { level: String(row.level) as CanopyDebugCaptureLevel }),
    ...(row.correlation_id === null ? {} : { correlation_id: String(row.correlation_id) }),
    ...(row.parent_id === null ? {} : { parent_id: String(row.parent_id) }),
    ...(parsed("payload_json") === undefined ? {} : { payload: parsed("payload_json") }),
    ...(row.artifact_path === null ? {} : { artifact_path: String(row.artifact_path) }),
    ...(row.bytes === null ? {} : { bytes: Number(row.bytes) }), ...(row.sha256 === null ? {} : { sha256: String(row.sha256) }),
    ...(row.frame_number === null ? {} : { frame_number: Number(row.frame_number) }),
    ...(parsed("metadata_json") === undefined ? {} : { metadata: parsed("metadata_json") }),
  };
}

export function createCanopyDebugJournal(options: CanopyDebugJournalOptions): CanopyDebugJournal {
  mkdirSync(dirname(resolve(options.path)), { recursive: true });
  const db = new (databaseConstructor())(options.path);
  db.exec(SCHEMA);
  const clock = options.clock ?? (() => new Date());
  const monotonic = options.monotonic ?? (() => process.hrtime.bigint());
  const session = options.session_id;
  const openedAt = clock().toISOString();
  const openedMono = monotonic().toString();
  // If a process died while holding a session open, make that state explicit.
  db.prepare("UPDATE sessions SET status='recovered', closed_at=? WHERE status='open' AND session_id<>?").run(openedAt, session);
  db.prepare("INSERT OR REPLACE INTO sessions(session_id, opened_at, opened_monotonic_ns, status, metadata_json) VALUES (?, ?, ?, 'open', ?)").run(session, openedAt, openedMono, json(options.metadata ?? {}));
  let sequence = Number((db.prepare("SELECT COALESCE(MAX(sequence), 0) AS n FROM events").get() as { n?: number }).n ?? 0);
  let closed = false;
  const append = (input: CanopyDebugEventInput): CanopyDebugCaptureRecord => {
    if (closed) throw new Error("canopy-debug journal is closed");
    const timestamp = clock().toISOString();
    const id = `${session}:${++sequence}`;
    const record: CanopyDebugCaptureRecord = {
      schema: 1, id, timestamp, monotonic_ns: monotonic().toString(), kind: input.kind, session_id: session,
      level: input.level ?? "debug", ...(input.correlation_id === undefined ? {} : { correlation_id: input.correlation_id }),
      ...(input.parent_id === undefined ? {} : { parent_id: input.parent_id }), ...(input.payload === undefined ? {} : { payload: redact(input.payload) as Readonly<Record<string, unknown>> }),
      ...(input.metadata === undefined ? {} : { metadata: redact(input.metadata) as Readonly<Record<string, unknown>> }),
    };
    db.prepare("INSERT INTO events(id,schema,timestamp,monotonic_ns,kind,session_id,level,correlation_id,parent_id,payload_json,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
      record.id, record.schema, record.timestamp, record.monotonic_ns, record.kind, record.session_id, record.level ?? null, record.correlation_id ?? null, record.parent_id ?? null, record.payload === undefined ? null : json(record.payload), record.metadata === undefined ? null : json(record.metadata));
    return record;
  };
  const appendCapture = (record: CanopyDebugCaptureRecord): void => {
    if (closed) throw new Error("canopy-debug journal is closed");
    const existing = db.prepare("SELECT 1 AS present FROM events WHERE id=?").get(record.id) as { present?: number } | undefined;
    if (existing?.present === 1) return;
    db.prepare("INSERT INTO events(id,schema,timestamp,monotonic_ns,kind,session_id,level,correlation_id,parent_id,payload_json,artifact_path,bytes,sha256,frame_number,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      record.id, record.schema, record.timestamp, record.monotonic_ns, record.kind, record.session_id, record.level ?? null,
      record.correlation_id ?? null, record.parent_id ?? null, record.payload === undefined ? null : json(record.payload), record.artifact_path ?? null,
      record.bytes ?? null, record.sha256 ?? null, record.frame_number ?? null, record.metadata === undefined ? null : json(record.metadata));
    if (record.artifact_path !== undefined) {
      const artifactId = `${record.id}:artifact`;
      db.prepare("INSERT OR IGNORE INTO artifacts(artifact_id,session_id,event_id,path,mime,bytes,sha256,created_at,width,height,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
        artifactId, record.session_id, record.id, record.artifact_path, record.mime ?? null, record.bytes ?? 0, record.sha256 ?? "sha256:unavailable", record.timestamp,
        record.width ?? null, record.height ?? null, json(record.metadata ?? {}));
    }
  };
  const query = (filter: CanopyDebugEventQuery = {}): readonly CanopyDebugCaptureRecord[] => {
    const clauses = ["1=1"]; const params: unknown[] = [];
    if (filter.kind !== undefined) { clauses.push("kind=?"); params.push(filter.kind); }
    if (filter.session_id !== undefined) { clauses.push("session_id=?"); params.push(filter.session_id); }
    if (filter.correlation_id !== undefined) { clauses.push("correlation_id=?"); params.push(filter.correlation_id); }
    if (filter.since !== undefined) { clauses.push("timestamp>=?"); params.push(filter.since); }
    if (filter.until !== undefined) { clauses.push("timestamp<=?"); params.push(filter.until); }
    const limit = Math.max(0, Math.min(filter.limit ?? 10_000, 100_000));
    params.push(limit);
    return (db.prepare(`SELECT * FROM events WHERE ${clauses.join(" AND ")} ORDER BY sequence ASC LIMIT ?`).all(...params) as Record<string, unknown>[]).map(rowToRecord);
  };
  const recordArtifact = (input: CanopyDebugArtifactInput): CanopyDebugArtifactRecord => {
    if (closed) throw new Error("canopy-debug journal is closed");
    const bytes = typeof input.bytes === "number" ? input.bytes : input.bytes.byteLength;
    const sha256 = input.sha256 ?? (typeof input.bytes === "number" ? "sha256:unavailable" : hash(input.bytes));
    const createdAt = input.created_at ?? clock().toISOString();
    const artifactId = input.artifact_id ?? `${session}:artifact:${sequence + 1}`;
    const eventId = input.event_id ?? append({ kind: "lifecycle", level: "debug", payload: { artifact_indexed: artifactId, path: input.path } }).id;
    const result: CanopyDebugArtifactRecord = { artifact_id: artifactId, session_id: session, event_id: eventId, path: input.path, mime: input.mime ?? null, bytes, sha256, created_at: createdAt, width: input.width ?? null, height: input.height ?? null, metadata: (redact(input.metadata ?? {}) as Readonly<Record<string, unknown>>) };
    db.prepare("INSERT INTO artifacts(artifact_id,session_id,event_id,path,mime,bytes,sha256,created_at,width,height,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(result.artifact_id,result.session_id,result.event_id,result.path,result.mime,result.bytes,result.sha256,result.created_at,result.width,result.height,json(result.metadata));
    return result;
  };
  return {
    session_id: session, append, appendCapture, recordArtifact,
    query, artifacts: () => (db.prepare("SELECT * FROM artifacts WHERE session_id=? ORDER BY created_at ASC").all(session) as Record<string, unknown>[]).map((row) => ({ artifact_id: String(row.artifact_id), session_id: String(row.session_id), event_id: String(row.event_id), path: String(row.path), mime: row.mime === null ? null : String(row.mime), bytes: Number(row.bytes), sha256: String(row.sha256), created_at: String(row.created_at), width: row.width === null ? null : Number(row.width), height: row.height === null ? null : Number(row.height), metadata: JSON.parse(String(row.metadata_json)) as Readonly<Record<string, unknown>> })),
    exportNdjson: (filter = {}) => { const rows = query(filter); return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""); },
    close: () => { if (closed) return; const endedAt = clock().toISOString(); db.prepare("UPDATE sessions SET status='closed', closed_at=?, closed_monotonic_ns=? WHERE session_id=?").run(endedAt, monotonic().toString(), session); db.close(); closed = true; },
  };
}
