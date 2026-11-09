/**
 * Durable governance record store and read index.
 *
 * The markdown corpus under `decisions/` remains authoritative.  The index
 * written by this module is a disposable projection: it can be deleted and
 * rebuilt without changing record identity or content.  Publication uses a
 * lock plus rename, so readers observe either the previous complete file or
 * the new complete file, never a partially written document.
 *
 * Governing record: ADR-027 (governance control plane over the existing ledger).
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { CanonicalRecord } from "./schema.js";
import { parseRecord } from "./parse.js";
import { recordContentHash } from "./canonical.js";
import type { GovernanceError, GovernanceResult } from "../contracts.js";

const INDEX_SCHEMA_VERSION = 1;
const INDEX_FILE = ".governance-index.json";
const LOCK_FILE = ".governance-publish.lock";
const ADR_FILE_RE = /^ADR-(\d+)-.+\.md$/;

export interface GovernanceRecordRevision {
  readonly id: string;
  readonly revision: number;
  readonly content_hash: string;
  readonly source_path: string;
  readonly published_at: string;
}

export interface GovernanceIndexEntry {
  readonly id: string;
  readonly record_number: number;
  readonly title: string;
  readonly status: CanonicalRecord["status"];
  readonly source_path: string;
  readonly content_hash: string | null;
  readonly revision: number;
  readonly terms: readonly string[];
  readonly links: readonly string[];
  readonly valid: boolean;
  readonly error?: string;
}

export type InterviewState = "unresolved" | "answered";

/** Normalized view of the canonical decisions/interviews.jsonl history. */
export interface GovernanceInterviewRecord {
  readonly id: string;
  readonly state: InterviewState;
  readonly covered: readonly string[];
  readonly outcomes: Readonly<Record<string, string>>;
  readonly line: number;
}

export interface GovernanceIndex {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly source_root: string;
  readonly source_fingerprint: string;
  readonly entries: readonly GovernanceIndexEntry[];
  readonly revisions: readonly GovernanceRecordRevision[];
  readonly interviews: readonly GovernanceInterviewRecord[];
  readonly interview_errors: readonly GovernanceRecordError[];
}

export interface GovernanceRecordError {
  readonly source_path: string;
  readonly message: string;
  readonly at?: string;
}

export interface GovernanceBrowseResult {
  readonly entries: readonly GovernanceIndexEntry[];
  readonly errors: readonly GovernanceRecordError[];
  readonly index: GovernanceIndex;
  readonly next_offset: number | null;
  readonly has_more: boolean;
}

export interface GovernanceRecordStoreOptions {
  /** Repository root containing the canonical `decisions/` directory. */
  readonly repo_root: string;
  readonly decisions_dir?: string;
  readonly index_path?: string;
  /** Lock stale after this many milliseconds. Defaults to ten minutes. */
  readonly lock_stale_ms?: number;
  readonly interviews_path?: string;
}

function fail<T>(message: string, at?: string): GovernanceResult<T> {
  const error: GovernanceError = { code: "validation", message, ...(at === undefined ? {} : { at }) };
  return { ok: false, error, capability: "record.store" };
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function terms(record: CanonicalRecord): string[] {
  const value = [record.id, record.title, record.sections.context, record.sections.decision,
    record.sections.consequences, record.sections.alternatives ?? ""].join(" ").toLowerCase();
  return [...new Set(value.match(/[a-z0-9][a-z0-9:_-]*/g) ?? [])].sort();
}

function links(record: CanonicalRecord): string[] {
  const text = Object.values(record.sections).filter((value): value is string => typeof value === "string").join("\n");
  const result = new Set<string>();
  for (const match of text.matchAll(/\bADR-(\d+)\b/gi)) result.add(`revoy2:ADR-${match[1]}`);
  result.delete(record.id);
  return [...result].sort();
}

function sourceRelative(decisionsDir: string, path: string): string {
  return relative(decisionsDir, path).split(sep).join("/");
}

function parseIndex(value: unknown): GovernanceIndex | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<GovernanceIndex>;
  if (candidate.schema_version !== INDEX_SCHEMA_VERSION || !Array.isArray(candidate.entries) || !Array.isArray(candidate.revisions)) return null;
  if (typeof candidate.source_root !== "string" || typeof candidate.source_fingerprint !== "string") return null;
  return { ...candidate, interviews: candidate.interviews ?? [], interview_errors: candidate.interview_errors ?? [] } as GovernanceIndex;
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

function withLock<T>(lockPath: string, staleMs: number, action: () => T): T {
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd: number | null = null;
  try {
    try {
      fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, `${process.pid}\n`, "utf8");
    } catch (error) {
      if (existsSync(lockPath) && Date.now() - statSync(lockPath).mtimeMs > staleMs) {
        unlinkSync(lockPath);
        fd = openSync(lockPath, "wx", 0o600);
        writeFileSync(fd, `${process.pid}\n`, "utf8");
      } else {
        throw new Error(`governance publication is busy: ${lockPath}`);
      }
    }
    return action();
  } finally {
    if (fd !== null) closeSync(fd);
    try { unlinkSync(lockPath); } catch { /* another process may have recovered a stale lock */ }
  }
}

export class GovernanceRecordStore {
  readonly repo_root: string;
  readonly decisions_dir: string;
  readonly index_path: string;
  readonly lock_path: string;
  readonly interviews_path: string;
  private readonly lock_stale_ms: number;

  constructor(options: GovernanceRecordStoreOptions) {
    this.repo_root = resolve(options.repo_root);
    this.decisions_dir = resolve(options.decisions_dir ?? join(this.repo_root, "decisions"));
    this.index_path = resolve(options.index_path ?? join(this.decisions_dir, INDEX_FILE));
    this.lock_path = `${this.index_path}${LOCK_FILE}`;
    this.interviews_path = resolve(options.interviews_path ?? join(this.repo_root, "decisions", "interviews.jsonl"));
    this.lock_stale_ms = options.lock_stale_ms ?? 10 * 60_000;
  }

  private sourceFiles(): string[] {
    if (!existsSync(this.decisions_dir)) return [];
    return readdirSync(this.decisions_dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && ADR_FILE_RE.test(entry.name))
      .map((entry) => join(this.decisions_dir, entry.name))
      .sort((a, b) => a.localeCompare(b));
  }

  private readInterviews(): { records: GovernanceInterviewRecord[]; errors: GovernanceRecordError[] } {
    const records: GovernanceInterviewRecord[] = [];
    const errors: GovernanceRecordError[] = [];
    if (!existsSync(this.interviews_path)) return { records, errors };
    const lines = readFileSync(this.interviews_path, "utf8").split(/\r?\n/);
    for (const [offset, line] of lines.entries()) {
      if (line.trim().length === 0) continue;
      const sourcePath = sourceRelative(this.repo_root, this.interviews_path);
      try {
        const value: unknown = JSON.parse(line);
        if (typeof value !== "object" || value === null) throw new Error("interview row must be an object");
        const row = value as { receipt_id?: unknown; covered?: unknown; outcomes?: unknown };
        if (!Array.isArray(row.covered) || !row.covered.every((item) => typeof item === "string")) throw new Error("interview covered must be a string array");
        const outcomes = row.outcomes === undefined ? {} : row.outcomes;
        if (typeof outcomes !== "object" || outcomes === null || Array.isArray(outcomes) || !Object.entries(outcomes).every(([key, item]) => typeof key === "string" && typeof item === "string")) throw new Error("interview outcomes must be an object of strings");
        records.push({ id: typeof row.receipt_id === "string" && row.receipt_id.length > 0 ? row.receipt_id : `interview-line-${offset + 1}`,
          state: Object.keys(outcomes).length > 0 ? "answered" : "unresolved", covered: row.covered, outcomes: outcomes as Record<string, string>, line: offset + 1 });
      } catch (error) {
        errors.push({ source_path: sourcePath, message: error instanceof Error ? error.message : String(error), at: `${sourcePath}:${offset + 1}` });
      }
    }
    return { records, errors };
  }

  /** Build a complete index from authoritative markdown, retaining malformed rows as errors. */
  fullRebuild(): GovernanceResult<GovernanceIndex> {
    try {
      const files = this.sourceFiles();
      const entries: GovernanceIndexEntry[] = [];
      const errors: GovernanceRecordError[] = [];
      for (const path of files) {
        const content = readFileSync(path, "utf8");
        const result = parseRecord(content, path);
        if (!result.ok) {
          errors.push({ source_path: sourceRelative(this.decisions_dir, path), message: result.error.message, at: result.error.at });
          const match = ADR_FILE_RE.exec(basename(path));
          entries.push({ id: match ? `revoy2:ADR-${match[1]}` : `invalid:${digest(path).slice(0, 16)}`, record_number: match ? Number(match[1]) : 0,
            title: basename(path), status: { decision: "draft", implementation: "not_applicable", verification: "unverified", compliance: "unknown" },
            source_path: sourceRelative(this.decisions_dir, path), content_hash: null, revision: 0, terms: [], links: [], valid: false, error: result.error.message });
          continue;
        }
        const record = result.value;
        entries.push({ id: record.id, record_number: record.record_number, title: record.title, status: record.status,
          source_path: sourceRelative(this.decisions_dir, path), content_hash: recordContentHash(record), revision: 1,
          terms: terms(record), links: links(record), valid: true });
      }
      const interviewState = this.readInterviews();
      const sourceFingerprint = digest(files.map((path) => `${sourceRelative(this.decisions_dir, path)}:${digest(readFileSync(path, "utf8"))}`).concat(
        `${sourceRelative(this.repo_root, this.interviews_path)}:${existsSync(this.interviews_path) ? digest(readFileSync(this.interviews_path, "utf8")) : "missing"}`,
      ).join("\n"));
      const priorIndex = this.readIndex();
      const previous = priorIndex.ok ? priorIndex.value : null;
      const currentRevisions = entries.filter((entry) => entry.valid && entry.content_hash !== null).map((entry) => {
        const prior = previous?.revisions.find((item) => item.id === entry.id && item.content_hash === entry.content_hash);
        return prior ?? { id: entry.id, revision: (previous?.revisions.filter((item) => item.id === entry.id).reduce((max, item) => Math.max(max, item.revision), 0) ?? 0) + 1,
          content_hash: entry.content_hash!, source_path: entry.source_path, published_at: new Date().toISOString() };
      });
      const currentIds = new Set(currentRevisions.map((item) => `${item.id}:${item.revision}:${item.content_hash}`));
      const revisions = [...(previous?.revisions.filter((item) => !currentIds.has(`${item.id}:${item.revision}:${item.content_hash}`)) ?? []), ...currentRevisions];
      const revisionById = new Map(revisions.map((item) => [item.id, item.revision]));
      const normalizedEntries = entries.map((entry) => ({ ...entry, revision: revisionById.get(entry.id) ?? 0 }));
      const index: GovernanceIndex = { schema_version: 1, generated_at: new Date().toISOString(), source_root: this.decisions_dir,
        source_fingerprint: sourceFingerprint, entries: normalizedEntries, revisions, interviews: interviewState.records, interview_errors: interviewState.errors };
      // Invalid rows remain in the index itself, so browse/read callers can
      // surface them without a second scan. Keep the public result shape
      // compatible with the package-wide GovernanceResult contract.
      return { ok: true, value: index, capability: "record.store.rebuild" };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  /** Publish a complete index atomically while serializing concurrent writers. */
  publish(index?: GovernanceIndex): GovernanceResult<GovernanceIndex> {
    try {
      return withLock(this.lock_path, this.lock_stale_ms, () => {
        const built: GovernanceResult<GovernanceIndex> = index
          ? { ok: true, value: index, capability: "record.store.publish" }
          : this.fullRebuild();
        if (!built.ok) return built;
        atomicWrite(this.index_path, `${JSON.stringify(built.value, null, 2)}\n`);
        return built;
      });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  readIndex(): GovernanceResult<GovernanceIndex> {
    try {
      if (!existsSync(this.index_path)) return fail("governance index is unavailable", this.index_path);
      const parsed = parseIndex(JSON.parse(readFileSync(this.index_path, "utf8")));
      return parsed ? { ok: true, value: parsed, capability: "record.store.read" } : fail("governance index schema is invalid", this.index_path);
    } catch (error) {
      return fail(`governance index is malformed: ${error instanceof Error ? error.message : String(error)}`, this.index_path);
    }
  }

  /** Rebuild when the authoritative source fingerprint changed; otherwise reuse the index. */
  ensureIndex(): GovernanceResult<GovernanceIndex> {
    const current = this.readIndex();
    const rebuilt = this.fullRebuild();
    if (!rebuilt.ok) return rebuilt;
    if (current.ok && current.value.source_fingerprint === rebuilt.value.source_fingerprint) return current;
    return this.publish(rebuilt.value);
  }

  browse(query = "", limit = 100, offset = 0): GovernanceResult<GovernanceBrowseResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(offset) || offset < 0) return fail("browse limit must be 1..500 and offset must be non-negative");
    const ensured = this.ensureIndex();
    if (!ensured.ok) return ensured as GovernanceResult<GovernanceBrowseResult>;
    const needle = query.trim().toLowerCase();
    const filtered = needle.length === 0 ? ensured.value.entries : ensured.value.entries.filter((entry) =>
      entry.terms.some((term) => term.includes(needle)) || entry.id.toLowerCase().includes(needle) || entry.source_path.toLowerCase().includes(needle));
    const entries = filtered.slice(offset, offset + limit);
    const errors = ensured.value.entries.filter((entry) => !entry.valid).map((entry) => ({ source_path: entry.source_path, message: entry.error ?? "invalid record" }));
    return { ok: true, value: { entries, errors, index: ensured.value, next_offset: offset + entries.length < filtered.length ? offset + entries.length : null, has_more: offset + entries.length < filtered.length }, capability: "record.store.browse" };
  }

  /** Append one canonical interview receipt and republish the derived index. */
  appendInterview(row: Record<string, unknown>): GovernanceResult<GovernanceIndex> {
    try {
      return withLock(this.lock_path, this.lock_stale_ms, () => {
        mkdirSync(dirname(this.interviews_path), { recursive: true });
        appendFileSync(this.interviews_path, `${JSON.stringify(row)}\n`, "utf8");
        const rebuilt = this.fullRebuild();
        if (!rebuilt.ok) return rebuilt;
        atomicWrite(this.index_path, `${JSON.stringify(rebuilt.value, null, 2)}\n`);
        return rebuilt;
      });
    } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
  }

  read(idOrPath: string): GovernanceResult<CanonicalRecord> {
    const index = this.ensureIndex();
    if (!index.ok) return index as GovernanceResult<CanonicalRecord>;
    const entry = index.value.entries.find((candidate) => candidate.id === idOrPath || candidate.source_path === idOrPath);
    if (!entry) return fail(`governance record not found: ${idOrPath}`);
    if (!entry.valid) return fail(entry.error ?? "governance record is invalid", entry.source_path);
    const result = parseRecord(readFileSync(join(this.decisions_dir, entry.source_path), "utf8"), join(this.decisions_dir, entry.source_path));
    return result;
  }

  crossLinks(id: string): GovernanceResult<readonly GovernanceIndexEntry[]> {
    const index = this.ensureIndex();
    if (!index.ok) return index as GovernanceResult<readonly GovernanceIndexEntry[]>;
    return { ok: true, value: index.value.entries.filter((entry) => entry.links.includes(id) || entry.id === id), capability: "record.store.links" };
  }

  /** Write a new canonical markdown record without ever overwriting an existing ID. */
  create(markdown: string, requestedNumber?: number): GovernanceResult<CanonicalRecord> {
    try {
      return withLock(this.lock_path, this.lock_stale_ms, () => {
        mkdirSync(this.decisions_dir, { recursive: true });
        const parsed = parseRecord(markdown, "<new-record>");
        if (!parsed.ok) return parsed;
        const existingIndex = this.readIndex();
        const historical = existingIndex.ok ? existingIndex.value.revisions.map((item) => Number(/^revoy2:ADR-(\d+)$/.exec(item.id)?.[1])).filter(Number.isFinite) : [];
        const used = new Set([...this.sourceFiles().map((path) => Number(ADR_FILE_RE.exec(basename(path))?.[1])), ...historical].filter(Number.isFinite));
        const number = requestedNumber ?? ((Math.max(0, ...used) + 1));
        if (used.has(number) || number < 1) return fail(`record number already exists: ADR-${number}`);
        const rewritten = markdown.replace(/^#\s+ADR-\d+\s*:/, `# ADR-${String(number).padStart(3, "0")}:`);
        const filenameTitle = parsed.value.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        const path = join(this.decisions_dir, `ADR-${String(number).padStart(3, "0")}-${filenameTitle || "record"}.md`);
        atomicWrite(path, rewritten.endsWith("\n") ? rewritten : `${rewritten}\n`);
        const reread = parseRecord(readFileSync(path, "utf8"), path);
        if (!reread.ok) return reread;
        const published = this.fullRebuild();
        if (!published.ok) return published as GovernanceResult<CanonicalRecord>;
        atomicWrite(this.index_path, `${JSON.stringify(published.value, null, 2)}\n`);
        return reread;
      });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }
}
