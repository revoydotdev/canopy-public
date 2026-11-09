import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isVerificationCheck, type Provenance } from "@arbor/core";
import { AuditIntegrityError } from "./audit.js";
import { canonicalizeForHash as canonicalJson } from "@arbor/core";

/**
 * A single fact about the process an executed command ran under, or a typed
 * reason it could not be determined. Never a silent `undefined`: absence is
 * a value here for the same reason it is for `TokenUsageResult`/`Cost` — a
 * caller that cannot recover a fact (e.g. a sandboxed port that never
 * surfaces `process.platform` to composition) must say why, so a reviewer
 * can tell "checked, unavailable" apart from "field never wired up".
 */
export type ExecutionContextFact<T> =
  | { readonly known: true; readonly value: T }
  | { readonly known: false; readonly reason: string };

/**
 * Full execution context an executed verification/acceptance command ran
 * under, bound to the output record so context drift between two runs of
 * "the same" command is a diffable fact instead of something only a human
 * happens to notice. `path_hash` is a SHA-256 of the raw `PATH` value, not
 * the value itself — `PATH` commonly carries local usernames and absolute
 * paths that do not belong duplicated verbatim into evidence records meant
 * to be shared and reviewed, and a hash still detects drift between runs.
 */
export interface ExecutionContext {
  /** The resolved shell the command ran under, or `"none"` for an argv-only exec with no shell involved. */
  readonly shell: ExecutionContextFact<string>;
  readonly cwd: ExecutionContextFact<string>;
  readonly timeout_ms: ExecutionContextFact<number>;
  readonly max_output_bytes: ExecutionContextFact<number>;
  /** `process.platform` (or equivalent) of the host the command actually ran on. */
  readonly platform: ExecutionContextFact<string>;
  readonly path_hash: ExecutionContextFact<string>;
}

/**
 * The value stamped onto a record when the caller supplies no execution
 * context at all — every fact explicitly "not known" rather than the field
 * being missing. Keeps `put()` backward-compatible for callers that predate
 * this field (the metadata parameter is optional) while the PERSISTED
 * record always carries a complete, typed value.
 */
const UNKNOWN_EXECUTION_CONTEXT: ExecutionContext = Object.freeze({
  shell: { known: false as const, reason: "caller did not supply execution context" },
  cwd: { known: false as const, reason: "caller did not supply execution context" },
  timeout_ms: { known: false as const, reason: "caller did not supply execution context" },
  max_output_bytes: { known: false as const, reason: "caller did not supply execution context" },
  platform: { known: false as const, reason: "caller did not supply execution context" },
  path_hash: { known: false as const, reason: "caller did not supply execution context" },
});

export interface OutputArtifactMetadata {
  campaign_id: string;
  node_id: string;
  operation_id: string;
  stream: "stdout" | "stderr" | "model" | "transcript" | "other";
  media_type: string;
  provenance: Provenance;
  /** Optional on input so callers written before this field existed keep compiling unchanged; see `OutputArtifactRecord.execution_context`, which is always present. */
  execution_context?: ExecutionContext;
}

/** Durable descriptor only. Raw bytes live in the content-addressed blob store. */
export interface OutputArtifactRecord extends Omit<OutputArtifactMetadata, "execution_context"> {
  schema: "arbor.output-artifact/v1";
  id: string;
  sha256: string;
  byte_count: number;
  stored_at: string;
  /** Always present: `UNKNOWN_EXECUTION_CONTEXT` when the caller supplied none, so absence is recorded rather than silently omitted. */
  execution_context: ExecutionContext;
  /** SHA-256 over every descriptor field except this seal. */
  record_hash: string;
}

export interface RawOutputAuthorization {
  actor: string;
  capability: "auditor" | "orchestrator";
  reason: string;
}

export interface OutputEvidenceStoreOptions {
  max_artifact_bytes?: number;
  authorize_raw_read?: (record: OutputArtifactRecord, authorization: RawOutputAuthorization) => boolean;
  now?: () => string;
}

/**
 * A single `list()` entry. A descriptor that fails validation is reported as
 * `{ status: "corrupt" }` rather than silently omitted — otherwise "this
 * output was never captured" and "this output's record is tampered/corrupt"
 * would both render as nothing, and an operator (or the audit itself)
 * couldn't tell the two apart.
 */
export type OutputListEntry =
  | { readonly status: "ok"; readonly record: OutputArtifactRecord }
  | { readonly status: "corrupt"; readonly id: string; readonly error: string };

export interface OutputListOptions {
  limit?: number;
}

const DEFAULT_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const RECORD_EXTENSION = ".json";
const DEFAULT_LIST_LIMIT = 200;
/**
 * Hard ceiling on how many descriptor files a single `list()` call reads
 * from disk, independent of the requested `limit` — enumeration must stay
 * bounded even if the store has accumulated far more captured outputs than
 * any caller will ever request. Only descriptor JSON is read here (never
 * the, potentially large, raw blob content), so this bound is cheap even at
 * its ceiling.
 */
const MAX_LIST_SCAN = 2_000;

/** Atomic, bounded storage for full outputs that must not be copied into ledger previews. */
export class OutputEvidenceStore {
  private readonly root: string;
  private readonly maxBytes: number;
  private readonly authorizeRawRead: (record: OutputArtifactRecord, authorization: RawOutputAuthorization) => boolean;
  private readonly now: () => string;

  constructor(persistenceRoot: string, options: OutputEvidenceStoreOptions = {}) {
    const maxBytes = options.max_artifact_bytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new AuditIntegrityError("max_artifact_bytes must be a positive safe integer");
    }
    this.root = join(persistenceRoot, "audit", "output-artifacts");
    this.maxBytes = maxBytes;
    this.authorizeRawRead = options.authorize_raw_read ?? (() => true);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  put(metadata: OutputArtifactMetadata, content: string | Uint8Array): OutputArtifactRecord {
    validateMetadata(metadata);
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    if (bytes.byteLength > this.maxBytes) {
      throw new AuditIntegrityError(`output artifact exceeds ${this.maxBytes} byte limit`);
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const id = artifactId(metadata);
    const recordPath = this.recordPath(id);
    const executionContext = metadata.execution_context ?? UNKNOWN_EXECUTION_CONTEXT;

    if (existsSync(recordPath)) {
      const existing = this.readRecord(id);
      const candidate = { ...metadata, execution_context: executionContext, sha256, byte_count: bytes.byteLength };
      const observed = {
        campaign_id: existing.campaign_id, node_id: existing.node_id, operation_id: existing.operation_id,
        stream: existing.stream, media_type: existing.media_type, provenance: existing.provenance,
        execution_context: existing.execution_context, sha256: existing.sha256, byte_count: existing.byte_count,
      };
      if (canonicalJson(candidate) !== canonicalJson(observed)) {
        throw new AuditIntegrityError(`conflicting output artifact ${id}`);
      }
      this.verifyBlob(existing);
      return existing;
    }

    const unsealed = {
      schema: "arbor.output-artifact/v1" as const,
      id,
      ...structuredClone(metadata),
      execution_context: structuredClone(executionContext),
      sha256,
      byte_count: bytes.byteLength,
      stored_at: this.now(),
    };
    const record: OutputArtifactRecord = {
      ...unsealed,
      record_hash: createHash("sha256").update(canonicalJson(unsealed)).digest("hex"),
    };
    atomicWrite(this.blobPath(sha256), bytes);
    this.verifyBlob(record);
    atomicWrite(recordPath, Buffer.from(`${JSON.stringify(record)}\n`, "utf8"));
    return structuredClone(record);
  }

  getRecord(id: string): OutputArtifactRecord | null {
    validateId(id);
    if (!existsSync(this.recordPath(id))) return null;
    return this.readRecord(id);
  }

  /**
   * The store's enumeration surface: `put`/`getRecord`/`readRaw`/`verify`
   * all require a known id, so nothing could previously answer "what
   * outputs exist" — the honest query an operator-facing list view needs.
   *
   * Deterministic: candidate filenames are sorted lexicographically before
   * any content is read (so the result never depends on the filesystem's
   * own, platform-dependent readdir order), and the final list orders by
   * `stored_at` descending (most recent first) with `id` ascending as a
   * stable tiebreak for equal timestamps.
   *
   * Bounded twice over: at most `MAX_LIST_SCAN` descriptor files are read
   * per call regardless of how many exist on disk (so a store holding many
   * more records than that returns a deterministic, but not necessarily
   * globally-most-recent, subset — the same trade every bounded scan over
   * unindexed storage makes), and the returned list never exceeds `limit`
   * (default `DEFAULT_LIST_LIMIT`).
   *
   * Reads descriptor JSON only, never blob bytes (`readRecord`, not
   * `verify`) — enumerating metadata must never require touching the raw
   * output content this store exists to keep out of ledger previews.
   *
   * A descriptor that fails validation is surfaced as `{status: "corrupt"}`
   * rather than dropped — see `OutputListEntry`.
   */
  list(options: OutputListOptions = {}): OutputListEntry[] {
    const limit = options.limit ?? DEFAULT_LIST_LIMIT;
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new AuditIntegrityError("list limit must be a positive safe integer");
    }
    const recordsDir = join(this.root, "records");
    if (!existsSync(recordsDir)) return [];

    const filenames = readdirSync(recordsDir)
      .filter((name) => name.endsWith(RECORD_EXTENSION))
      .sort()
      .slice(0, MAX_LIST_SCAN);

    const entries: OutputListEntry[] = filenames.map((filename) => {
      const id = filename.slice(0, -RECORD_EXTENSION.length);
      try {
        return { status: "ok", record: this.readRecord(id) };
      } catch (error) {
        return { status: "corrupt", id, error: error instanceof Error ? error.message : String(error) };
      }
    });

    // Ordered by UTF-16 code unit, NOT localeCompare. localeCompare is locale-
    // and ICU-build-dependent, so it can order the same two records differently
    // on two machines — the exact defect that made `output-evidence.ts`'s old
    // canonicalizer disagree with `audit.ts` and that `@arbor/core`'s
    // `canonicalizeForHash` exists to prevent. "Deterministic" has to mean
    // deterministic across hosts, not just across runs on this one.
    entries.sort((a, b) => {
      const timeA = a.status === "ok" ? a.record.stored_at : "";
      const timeB = b.status === "ok" ? b.record.stored_at : "";
      if (timeA !== timeB) return timeA < timeB ? 1 : -1; // newest first
      const idA = a.status === "ok" ? a.record.id : a.id;
      const idB = b.status === "ok" ? b.record.id : b.id;
      if (idA === idB) return 0;
      return idA < idB ? -1 : 1;
    });

    return entries.slice(0, limit);
  }

  readRaw(id: string, authorization: RawOutputAuthorization): Uint8Array {
    validateAuthorization(authorization);
    const record = this.readRecord(id);
    if (!this.authorizeRawRead(record, authorization)) {
      throw new AuditIntegrityError(`raw output access denied for ${id}`);
    }
    return new Uint8Array(this.verifyBlob(record));
  }

  verify(id: string): OutputArtifactRecord {
    const record = this.readRecord(id);
    this.verifyBlob(record);
    return record;
  }

  private readRecord(id: string): OutputArtifactRecord {
    validateId(id);
    const path = this.recordPath(id);
    if (!existsSync(path)) throw new AuditIntegrityError(`unknown output artifact ${id}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new AuditIntegrityError(`invalid output artifact record ${id}`);
    }
    validateRecord(parsed, id);
    return structuredClone(parsed);
  }

  private verifyBlob(record: OutputArtifactRecord): Buffer {
    const path = this.blobPath(record.sha256);
    if (!existsSync(path)) throw new AuditIntegrityError(`missing output artifact blob ${record.sha256}`);
    const bytes = readFileSync(path);
    if (bytes.byteLength !== record.byte_count) {
      throw new AuditIntegrityError(`output artifact byte count mismatch for ${record.id}`);
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== record.sha256) throw new AuditIntegrityError(`output artifact hash mismatch for ${record.id}`);
    return bytes;
  }

  private recordPath(id: string): string {
    return join(this.root, "records", `${id}.json`);
  }

  private blobPath(hash: string): string {
    if (!HASH_PATTERN.test(hash)) throw new AuditIntegrityError("invalid output artifact hash");
    return join(this.root, "blobs", hash.slice(0, 2), hash);
  }
}

function artifactId(metadata: OutputArtifactMetadata): string {
  return `out_${createHash("sha256").update(canonicalJson({
    campaign_id: metadata.campaign_id,
    node_id: metadata.node_id,
    operation_id: metadata.operation_id,
    stream: metadata.stream,
  })).digest("hex")}`;
}

function atomicWrite(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) return;
  const temporary = `${path}.tmp-${process.pid}-${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
    if (existsSync(path)) return;
    throw error;
  }
}

function validateMetadata(value: OutputArtifactMetadata): void {
  for (const [name, field] of Object.entries({
    campaign_id: value.campaign_id, node_id: value.node_id, operation_id: value.operation_id, media_type: value.media_type,
  })) {
    if (typeof field !== "string" || field.length === 0 || field.length > 1024) {
      throw new AuditIntegrityError(`invalid output artifact ${name}`);
    }
  }
  if (!(["stdout", "stderr", "model", "transcript", "other"] as const).includes(value.stream)) {
    throw new AuditIntegrityError("invalid output artifact stream");
  }
  validateProvenance(value.provenance);
  if (value.execution_context !== undefined) validateExecutionContext(value.execution_context);
}

function validateExecutionContextFact(value: unknown, name: string, valueType: "string" | "number"): void {
  if (typeof value !== "object" || value === null) throw new AuditIntegrityError(`invalid output artifact execution_context.${name}`);
  const fact = value as { known?: unknown; value?: unknown; reason?: unknown };
  if (fact.known === true) {
    if (typeof fact.value !== valueType || (valueType === "string" && fact.value === "")) {
      throw new AuditIntegrityError(`invalid output artifact execution_context.${name}`);
    }
    return;
  }
  if (fact.known === false) {
    if (typeof fact.reason !== "string" || fact.reason.length === 0) {
      throw new AuditIntegrityError(`invalid output artifact execution_context.${name}`);
    }
    return;
  }
  throw new AuditIntegrityError(`invalid output artifact execution_context.${name}`);
}

function validateExecutionContext(value: unknown): asserts value is ExecutionContext {
  if (typeof value !== "object" || value === null) throw new AuditIntegrityError("invalid output artifact execution_context");
  const context = value as Partial<Record<keyof ExecutionContext, unknown>>;
  validateExecutionContextFact(context.shell, "shell", "string");
  validateExecutionContextFact(context.cwd, "cwd", "string");
  validateExecutionContextFact(context.timeout_ms, "timeout_ms", "number");
  validateExecutionContextFact(context.max_output_bytes, "max_output_bytes", "number");
  validateExecutionContextFact(context.platform, "platform", "string");
  validateExecutionContextFact(context.path_hash, "path_hash", "string");
}

function validateProvenance(value: Provenance): void {
  if (typeof value !== "object" || value === null || typeof value.tag !== "string") {
    throw new AuditIntegrityError("output artifact provenance is required");
  }
  switch (value.tag) {
    case "verified":
      if (typeof value.cmd !== "string" || value.exit !== 0
        || typeof value.stdout_hash !== "string" || value.stdout_hash.length === 0
        || (value.check !== undefined && !isVerificationCheck(value.check))) {
        throw new AuditIntegrityError("invalid verified output provenance");
      }
      return;
    case "claimed":
      if (typeof value.claimant !== "string" || value.claimant.length === 0) {
        throw new AuditIntegrityError("invalid claimed output provenance");
      }
      return;
    case "critic_approved":
      if (typeof value.critic !== "string" || value.critic.length === 0 || typeof value.rationale !== "string") {
        throw new AuditIntegrityError("invalid critic-approved output provenance");
      }
      return;
    case "generated":
      if (typeof value.generator !== "string" || value.generator.length === 0 || typeof value.input_hash !== "string") {
        throw new AuditIntegrityError("invalid generated output provenance");
      }
      return;
    default:
      throw new AuditIntegrityError("invalid output artifact provenance tag");
  }
}

function validateRecord(value: unknown, expectedId: string): asserts value is OutputArtifactRecord {
  if (typeof value !== "object" || value === null) throw new AuditIntegrityError(`invalid output artifact record ${expectedId}`);
  const record = value as Partial<OutputArtifactRecord>;
  if (record.schema !== "arbor.output-artifact/v1" || record.id !== expectedId || !HASH_PATTERN.test(record.sha256 ?? "")
    || !HASH_PATTERN.test(record.record_hash ?? "")
    || !Number.isSafeInteger(record.byte_count) || (record.byte_count ?? -1) < 0 || typeof record.stored_at !== "string") {
    throw new AuditIntegrityError(`invalid output artifact record ${expectedId}`);
  }
  if (record.execution_context === undefined) throw new AuditIntegrityError(`output artifact record ${expectedId} is missing execution_context`);
  validateMetadata(record as OutputArtifactRecord);
  if (artifactId(record as OutputArtifactRecord) !== expectedId) {
    throw new AuditIntegrityError(`output artifact identity mismatch for ${expectedId}`);
  }
  const { record_hash, ...unsealed } = record as OutputArtifactRecord;
  const expectedHash = createHash("sha256").update(canonicalJson(unsealed)).digest("hex");
  if (record_hash !== expectedHash) throw new AuditIntegrityError(`output artifact record hash mismatch for ${expectedId}`);
}

function validateAuthorization(value: RawOutputAuthorization): void {
  if (!value || (value.capability !== "auditor" && value.capability !== "orchestrator")
    || typeof value.actor !== "string" || value.actor.length === 0
    || typeof value.reason !== "string" || value.reason.length === 0) {
    throw new AuditIntegrityError("auditor or orchestrator authorization with reason is required");
  }
}

function validateId(id: string): void {
  if (!/^out_[a-f0-9]{64}$/.test(id)) throw new AuditIntegrityError("invalid output artifact id");
}
