/**
 * Durable local capture sink for the canopy-debug operator session.
 *
 * The index is intentionally JSONL (one self-contained row per mutation), so
 * an agent can tail it while the TUI is live and recover after a crash without
 * replaying a partially-written database transaction.  Media is kept beside
 * the index and every row carries its relative path and timestamp.
 */
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import type { RenderedFrame } from "@arbor/tui";
import { createCanopyDebugJournal, type CanopyDebugJournal } from "./canopy-debug-journal.js";
import { renderTerminalPng, terminalRecordingHeader } from "./canopy-debug-visual.js";

/**
 * The operator-facing event vocabulary.  Keep this closed and explicit: it is
 * consumed by the query/export helpers and makes missing instrumentation
 * visible to agents instead of hiding it in an untyped catch-all row.
 */
export type CanopyDebugCaptureKind =
  | "session_open" | "session_close" | "screenshot" | "recording_start" | "recording_frame" | "recording_stop"
  | "input" | "output" | "console" | "error" | "function_start" | "function_end"
  | "token_usage" | "api_request" | "api_response" | "mcp_discovery" | "mcp_call"
  | "skill_load" | "reasoning" | "lifecycle";

export type CanopyDebugCaptureLevel = "trace" | "debug" | "info" | "warn" | "error";

export interface CanopyDebugCaptureRecord {
  readonly schema: 1;
  readonly id: string;
  readonly timestamp: string;
  /** Monotonic nanoseconds since the process started; serialized as a string. */
  readonly monotonic_ns: string;
  readonly kind: CanopyDebugCaptureKind;
  readonly session_id: string;
  readonly level?: CanopyDebugCaptureLevel;
  readonly correlation_id?: string;
  readonly parent_id?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly artifact_path?: string;
  readonly bytes?: number;
  readonly sha256?: string;
  readonly frame_number?: number;
  readonly mime?: string;
  readonly width?: number;
  readonly height?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CanopyDebugCaptureStoreOptions {
  readonly root: string;
  readonly session_id?: string;
  /** Optional override; defaults to the session's durable journal.sqlite. */
  readonly journal_path?: string;
  readonly clock?: () => Date;
  /** Injectable for deterministic tests; production uses process.hrtime.bigint. */
  readonly monotonic?: () => bigint;
}

export interface CanopyDebugEventInput {
  readonly kind: Exclude<CanopyDebugCaptureKind, "session_open" | "session_close" | "screenshot" | "recording_start" | "recording_frame" | "recording_stop">;
  readonly level?: CanopyDebugCaptureLevel;
  readonly correlation_id?: string;
  readonly parent_id?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CanopyDebugEventQuery {
  readonly kind?: CanopyDebugCaptureKind;
  readonly session_id?: string;
  readonly correlation_id?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
}

export interface CanopyDebugCaptureStore {
  readonly session_id: string;
  readonly root: string;
  /** Indexed SQLite sink shared by all TUI producers for this session. */
  readonly journal: CanopyDebugJournal;
  readonly recording: boolean;
  appendFrame(frame: RenderedFrame, metadata?: Readonly<Record<string, unknown>>): void;
  screenshot(frame: RenderedFrame, metadata?: Readonly<Record<string, unknown>>): CanopyDebugCaptureRecord;
  toggleRecording(frame?: RenderedFrame, metadata?: Readonly<Record<string, unknown>>): boolean;
  /** Append an arbitrary redacted telemetry event and return its durable row. */
  event(input: CanopyDebugEventInput): CanopyDebugCaptureRecord;
  /** Alias useful to instrumentation adapters that call their sink a journal. */
  recordEvent(input: CanopyDebugEventInput): CanopyDebugCaptureRecord;
  query(query?: CanopyDebugEventQuery): readonly CanopyDebugCaptureRecord[];
  export(query?: CanopyDebugEventQuery): string;
  close(): void;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/gu, "_").slice(0, 96) || "capture";
}

function digest(bytes: Uint8Array): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

const SECRET_KEY = /(?:authorization|api[_-]?key|credential|password|passwd|private[_-]?key|secret|token)/iu;
// Do not blanket-redact every long identifier: operation ids, paths, model
// names, and governance keys are valuable agent context.  Keyed fields are
// redacted below; this value matcher is reserved for recognizable credential
// formats that can arrive under an otherwise innocuous field name.
const SECRET_VALUE = /\b(?:sk-[A-Za-z0-9]{16,}|pk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/gu;
const MAX_TEXT = 32_768;

/** Redact values at the journal boundary, including nested provider payloads. */
function redactValue(value: unknown, key?: string): unknown {
  if (key !== undefined && SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return value.replace(SECRET_VALUE, "[REDACTED]").slice(0, MAX_TEXT);
  if (Array.isArray(value)) return value.slice(0, 1_000).map((item) => redactValue(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 1_000).map(([name, item]) => [name, redactValue(item, name)]));
  }
  return value;
}

function redactRecord(value: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  return redactValue(value) as Readonly<Record<string, unknown>>;
}

/** Creates an append-only capture store under a caller-owned persistence root. */
export function createCanopyDebugCaptureStore(options: CanopyDebugCaptureStoreOptions): CanopyDebugCaptureStore {
  const root = resolve(options.root);
  const clock = options.clock ?? (() => new Date());
  const monotonic = options.monotonic ?? (() => process.hrtime.bigint());
  const sessionId = safeId(options.session_id ?? `${clock().toISOString().replace(/[:.]/gu, "-")}-${process.pid}`);
  const sessionRoot = join(root, "canopy-debug", sessionId);
  const mediaRoot = join(sessionRoot, "artifacts");
  const indexPath = join(sessionRoot, "capture-index.jsonl");
  mkdirSync(mediaRoot, { recursive: true });
  const journal: CanopyDebugJournal = createCanopyDebugJournal({
    path: options.journal_path ?? join(sessionRoot, "journal.sqlite"),
    session_id: sessionId,
    clock,
    monotonic,
    metadata: { capture_index: "capture-index.jsonl" },
  });
  const writeRecord = (record: CanopyDebugCaptureRecord): void => {
    const line = `${JSON.stringify(record)}\n`;
    const fd = openSync(indexPath, "a");
    try { writeFileSync(fd, line, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
  };
  const writeArtifact = (name: string, bytes: Uint8Array): string => {
    const relativePath = join("artifacts", name);
    const absolutePath = join(sessionRoot, relativePath);
    writeFileSync(absolutePath, bytes, { flag: "w" });
    return relativePath;
  };
  const appendArtifact = (name: string, text: string): string => {
    const relativePath = join("artifacts", name);
    const absolutePath = join(sessionRoot, relativePath);
    appendFileSync(absolutePath, text, "utf8");
    return relativePath;
  };
  const now = (): { iso: string; stamp: string } => {
    const date = clock();
    const iso = date.toISOString();
    return { iso, stamp: iso.replace(/[:.]/gu, "-") };
  };
  let sequence = 0;
  let recording = false;
  let frameNumber = 0;
  let recordingPath: string | undefined;
  let recordingWidth = 0;
  let recordingHeight = 0;
  let closed = false;
  const record = (kind: CanopyDebugCaptureKind, fields: Omit<CanopyDebugCaptureRecord, "schema" | "id" | "timestamp" | "monotonic_ns" | "kind" | "session_id"> = {}): CanopyDebugCaptureRecord => {
    const time = now();
    const complete: CanopyDebugCaptureRecord = { schema: 1, id: `${sessionId}:${++sequence}`, timestamp: time.iso, monotonic_ns: monotonic().toString(), kind, session_id: sessionId, ...fields };
    writeRecord(complete);
    journal.appendCapture(complete);
    return complete;
  };
  record("session_open", { metadata: redactRecord({ pid: process.pid, cwd: process.cwd() }) });
  const event = (input: CanopyDebugEventInput): CanopyDebugCaptureRecord => {
    if (closed) throw new Error("capture store is closed");
    return record(input.kind, {
      level: input.level ?? "debug",
      correlation_id: input.correlation_id,
      parent_id: input.parent_id,
      payload: redactRecord(input.payload),
      metadata: redactRecord(input.metadata),
    });
  };
  const query = (filter: CanopyDebugEventQuery = {}): readonly CanopyDebugCaptureRecord[] => {
    let rows: CanopyDebugCaptureRecord[] = [];
    try {
      rows = readFileSync(indexPath, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as CanopyDebugCaptureRecord);
    } catch { return []; }
    const filtered = rows.filter((row) => (filter.kind === undefined || row.kind === filter.kind)
      && (filter.session_id === undefined || row.session_id === filter.session_id)
      && (filter.correlation_id === undefined || row.correlation_id === filter.correlation_id)
      && (filter.since === undefined || row.timestamp >= filter.since)
      && (filter.until === undefined || row.timestamp <= filter.until));
    return filter.limit === undefined ? filtered : filtered.slice(Math.max(0, filtered.length - Math.max(0, filter.limit)));
  };
  const exportJournal = (filter: CanopyDebugEventQuery = {}): string => {
    const rows = query(filter);
    return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");
  };
  const store: CanopyDebugCaptureStore = {
    session_id: sessionId,
    root: sessionRoot,
    journal,
    get recording() { return recording; },
    appendFrame(frame, metadata) {
      if (!recording || closed) return;
      const time = now();
      const text = Buffer.from(frame.text, "utf8");
      const artifactPath = writeArtifact(`recording-${safeId(time.stamp)}-${frameNumber}.ansi`, text);
      if (recordingPath !== undefined) appendArtifact(recordingPath.slice("artifacts/".length), `${JSON.stringify([Number(monotonic()) / 1e9, "o", frame.text])}\n`);
      record("recording_frame", {
        artifact_path: artifactPath,
        bytes: text.byteLength,
        sha256: digest(text),
        frame_number: frameNumber++,
        mime: "text/plain; charset=utf-8",
        width: recordingWidth > 0 ? recordingWidth : undefined,
        height: recordingHeight > 0 ? recordingHeight : undefined,
        metadata: redactRecord(metadata),
      });
    },
    screenshot(frame, metadata) {
      if (closed) throw new Error("capture store is closed");
      const time = now();
      const text = Buffer.from(frame.text, "utf8");
      const json = Buffer.from(`${JSON.stringify(frame.scene, null, 2)}\n`, "utf8");
      const png = renderTerminalPng(frame);
      const pngPath = writeArtifact(`screenshot-${safeId(time.stamp)}.png`, png);
      const textPath = writeArtifact(`screenshot-${safeId(time.stamp)}.ansi`, text);
      const scenePath = writeArtifact(`screenshot-${safeId(time.stamp)}.scene.json`, json);
      return record("screenshot", {
        artifact_path: pngPath, bytes: png.byteLength, sha256: digest(png), mime: "image/png", width: frame.scene.columns, height: frame.scene.rows.length,
        metadata: redactRecord({ ...metadata, text_path: textPath, scene_path: relative(sessionRoot, join(sessionRoot, scenePath)), text_bytes: text.byteLength, scene_bytes: json.byteLength }),
      });
    },
    toggleRecording(frame, metadata) {
      if (closed) return false;
      recording = !recording;
      frameNumber = 0;
      if (recording) {
        const time = now();
        recordingPath = join("artifacts", `recording-${safeId(time.stamp)}.cast`);
        recordingWidth = frame?.scene.columns ?? 0;
        recordingHeight = frame?.scene.rows.length ?? 0;
        writeArtifact(recordingPath.slice("artifacts/".length), Buffer.from(frame === undefined ? `${JSON.stringify({ version: 2, width: 0, height: 0, timestamp: Math.floor(Date.now() / 1000), env: { TERM: "xterm-256color", SHELL: "canopy-debug" } })}\n` : terminalRecordingHeader(frame), "utf8"));
      }
      const stoppedPath = !recording && recordingPath !== undefined ? recordingPath : undefined;
      const stoppedBytes = stoppedPath === undefined ? undefined : readFileSync(join(sessionRoot, stoppedPath));
      record(recording ? "recording_start" : "recording_stop", {
        ...(stoppedPath === undefined || stoppedBytes === undefined ? {} : { artifact_path: stoppedPath, bytes: stoppedBytes.byteLength, sha256: digest(stoppedBytes), mime: "application/x-asciicast", width: recordingWidth, height: recordingHeight }),
        metadata: redactRecord({ ...metadata, ...(recording ? { recording_path: recordingPath, format: "asciicast-v2" } : { format: "asciicast-v2" }) }),
      });
      if (!recording) { recordingPath = undefined; recordingWidth = 0; recordingHeight = 0; }
      if (recording && frame !== undefined) store.appendFrame(frame, metadata);
      return recording;
    },
    close() {
      if (closed) return;
      if (recording) { recording = false; record("recording_stop", { metadata: { reason: "session_close" } }); }
      record("session_close");
      journal.close();
      closed = true;
    },
    event,
    recordEvent: event,
    query,
    export: exportJournal,
  };
  return store;
}
