/**
 * DevTools trace logger (ADR-021).
 *
 * A `RuntimeLifecycleParticipant` that subscribes to the post-durability
 * `manager.subscribeEvents` sink — the same sink the SSE bridge taps — and
 * appends one ND-JSON line per runtime event to
 * `<persistence_dir>/devtools/devtools.log`.
 *
 * What it is:
 *  - A derived projection. Every line records the producing ledger
 *    `record_id` + `content_hash` when the event was ledger-witnessed
 *    (e.g. `audit.evidence_recorded`, `kb.entry_added`). For events with no
 *    direct ledger pointer (e.g. `tree.node_changed`), the line carries the
 *    event payload verbatim — it never invents a synthetic pointer.
 *  - Externally observable: `tail -f <persistence_dir>/devtools/devtools.log`
 *    works without an MCP client. Lines are stable ND-JSON.
 *  - Bounded: rotation at `max_bytes` (default 100 MB), retaining up to
 *    `max_segments` rotated segments. The active segment never grows without
 *    limit.
 *  - Backpressure-safe: a slow disk cannot wedge the loop. Events are enqueued
 *    on a bounded buffer; an overflow drops the oldest pending event and
 *    records a synthetic `stream.truncated` marker line, mirroring the
 *    discipline `RuntimeEventStream` already uses for its in-memory subscribers.
 *
 * What it is NOT:
 *  - Not a parallel audit ledger. The file is lossy by design (rotation
 *    evicts). Restart replays from the audit ledger, never from this file.
 *  - Not an authority. It cannot verify a node, gate a transition, or affect
 *    campaign correctness. ADRs 014 and 017 govern — DevTools is the same
 *    projection shape applied to the inspector surface.
 */
import { openSync, closeSync, writeSync, fsyncSync, mkdirSync, renameSync, statSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeEvent } from "@arbor/core";
import type { RuntimeLifecycleParticipant } from "./runtime.js";
import type { CampaignManager } from "./manager.js";

/**
 * Structural, dependency-free slice of the loop's `LoopEvent` (the opencode
 * loop executor's `log` hook). Intentionally not `import`ed from
 * `@arbor/opencode` so `arbor-mcp` does not acquire a runtime dependency on
 * the plugin package — the bridge is a plain `{ type: string }` envelope with
 * extra fields, which is exactly what `executor.log` emits.
 */
export type DevToolsLoopEventLike = { type: string } & Record<string, unknown>;

/** Shared FIFO item across both feedback channels, preserving arrival order. */
type DevToolsLogItem =
  | { source: "runtime"; event: RuntimeEvent }
  | { source: "loop"; loop: DevToolsLoopEventLike };

/** ND-JSON line shape. Stable. Adding fields is a schema bump; never reorder. */
export interface DevToolsLogLine {
  /** Schema discriminator. */
  schema: "arbor.devtools/v1";
  /** Monotonic per-logger sequence. NOT a cursor; use the runtime event stream for cursor-resume. */
  seq: number;
  /** Wall-clock timestamp from the logger's clock, ISO 8601. */
  ts: string;
  /** Campaign id when known from the event, else null. */
  campaign_id: string | null;
  /** Node id when known from the event, else null. */
  node_id: string | null;
  /** Closed RuntimeEvent kind discriminator, or a `loop.*` kind for loop-phase lines. */
  event_kind: RuntimeEvent["kind"] | `loop.${string}`;
  /** The verbatim RuntimeEvent payload; for loop lines, a `loop.*` stub (full payload in `loop_event`). */
  event: RuntimeEvent | { kind: `loop.${string}` };
  /**
   * Ledger pointer when the event was ledger-witnessed, else null.
   * For `audit.evidence_recorded` this is the trace/gate/recovery id;
   * for `kb.entry_added` it is the KB entry id; for others it is null
   * because the event has no direct ledger counterpart.
   */
  source_record_id: string | null;
  /**
   * Reserved for future ledger content-hash linkage. The post-durability sink
   * does not currently surface the producing record's content_hash; when it
   * does, populate this. Null until then.
   */
  source_content_hash: string | null;
  /** Set to true on a synthetic stream-truncation marker line. */
  synthetic: boolean;
  /**
   * Loop-phase feedback (ADR-021 bridge). Present when this line was produced
   * from the opencode loop's `executor.log` hook (e.g. `specialist_dispatched`,
   * `critic_dispatched`, `node_verified`, `node_failed`, `branched`,
   * `backtracked`, `halt`, `iteration`). Absent on manager/runtime event lines.
   * Structural — never imported from the plugin package.
   */
  loop_event: DevToolsLoopEventLike | null;
}

export interface DevToolsTraceLoggerOptions {
  /** Root directory; the log lives at `<root>/devtools/devtools.log`. */
  persistence_dir: string;
  /** Per-logger clock; defaults to `() => new Date().toISOString()`. */
  now?: () => string;
  /** Rotate when the active segment exceeds this many bytes. Default 100 MB. */
  max_bytes?: number;
  /** Retain this many rotated segments (`.1.log`, `.2.log`, …). Default 5. */
  max_segments?: number;
  /** Bound on the in-memory queue. Default 1024 events. */
  max_pending?: number;
  /** Optional name for the lifecycle participant; default "devtools-trace-logger". */
  name?: string;
  /**
   * Optional flush interval in milliseconds. Lines are always appended
   * synchronously to the OS page cache; this controls how often fsync is
   * called. Default 0 = fsync per line (strongest durability, highest cost).
   */
  flush_interval_ms?: number;
  /** Disable fsync entirely (tests / ephemeral runs). Default false. */
  disable_fsync?: boolean;
}

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_SEGMENTS = 5;
const DEFAULT_MAX_PENDING = 1024;

/**
 * The DevTools trace logger. Construct via {@link createDevToolsTraceLogger},
 * which returns a {@link RuntimeLifecycleParticipant} so the runtime can
 * start/close it like any other participant. The logger subscribes on start
 * and unsubscribes on close.
 */
export class DevToolsTraceLogger {
  readonly name: string;
  private readonly directory: string;
  private readonly logPath: string;
  private readonly now: () => string;
  private readonly maxBytes: number;
  private readonly maxSegments: number;
  private readonly maxPending: number;
  private readonly flushIntervalMs: number;
  private readonly disableFsync: boolean;

  private queue: DevToolsLogItem[] = [];
  private droppedSinceFlush = 0;
  private sequence = 0;
  private fd: number | null = null;
  private activeBytes = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private unsub: (() => void) | null = null;
  private readonly manager: CampaignManager;
  private closed = false;

  constructor(manager: CampaignManager, options: DevToolsTraceLoggerOptions) {
    if (!options.persistence_dir.trim()) throw new Error("DevToolsTraceLogger requires a non-empty persistence_dir");
    this.manager = manager;
    this.name = options.name ?? "devtools-trace-logger";
    this.directory = join(options.persistence_dir, "devtools");
    this.logPath = join(this.directory, "devtools.log");
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxBytes = options.max_bytes ?? DEFAULT_MAX_BYTES;
    this.maxSegments = options.max_segments ?? DEFAULT_MAX_SEGMENTS;
    this.maxPending = options.max_pending ?? DEFAULT_MAX_PENDING;
    this.flushIntervalMs = options.flush_interval_ms ?? 0;
    this.disableFsync = options.disable_fsync ?? false;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1024) throw new Error("max_bytes must be a safe integer >= 1024");
    if (!Number.isSafeInteger(this.maxSegments) || this.maxSegments < 0) throw new Error("max_segments must be a non-negative safe integer");
    if (!Number.isSafeInteger(this.maxPending) || this.maxPending < 1) throw new Error("max_pending must be a positive safe integer");
    if (!Number.isSafeInteger(this.flushIntervalMs) || this.flushIntervalMs < 0) throw new Error("flush_interval_ms must be a non-negative safe integer");
  }

  // --- RuntimeLifecycleParticipant surface ---

  /** Open the log fd, subscribe to manager events, start the flush timer. */
  start(): void {
    if (this.closed) throw new Error(`${this.name}: cannot start a closed logger`);
    if (this.unsub !== null) return; // idempotent
    mkdirSync(this.directory, { recursive: true });
    this.fd = openSync(this.logPath, "a");
    try {
      this.activeBytes = statSync(this.logPath).size;
    } catch {
      this.activeBytes = 0;
    }
    this.unsub = this.manager.subscribeEvents((event) => this.enqueue(event));
    if (this.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
      // Don't keep the event loop alive solely for the flush timer.
      this.flushTimer.unref?.();
    }
  }

  /** Flush pending, close the fd, unsubscribe. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
    this.unsub?.();
    this.unsub = null;
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }

  // --- Internals ---

  /**
   * Enqueue an event on the bounded buffer. If the buffer is full, drop the
   * oldest pending event and record a synthetic truncation marker on the next
   * flush — never block the loop on disk I/O.
   */
  private enqueue(event: RuntimeEvent): void {
    if (this.closed) return;
    if (this.queue.length >= this.maxPending) {
      this.queue.shift();
      this.droppedSinceFlush++;
    }
    this.queue.push({ source: "runtime", event });
    if (this.flushIntervalMs === 0) this.flush();
  }

  /**
   * Ingest one loop-phase event (the opencode loop's `executor.log` hook).
   * Shares the same bounded FIFO as runtime events so both channels preserve
   * arrival order, and the same backpressure/rotation path. A burst of loop
   * feedback can never wedge the loop.
   */
  loopEvent(loop: DevToolsLoopEventLike): void {
    if (this.closed) return;
    if (!loop || typeof loop.type !== "string" || !loop.type) return;
    if (this.queue.length >= this.maxPending) {
      this.queue.shift();
      this.droppedSinceFlush++;
    }
    this.queue.push({ source: "loop", loop: { ...loop } });
    if (this.flushIntervalMs === 0) this.flush();
  }

  /** Drain the queue, append each line, fsync per policy, rotate if needed. */
  private flush(): void {
    if (this.fd === null || this.queue.length === 0) {
      if (this.droppedSinceFlush > 0 && this.fd !== null) this.writeTruncationMarker();
      return;
    }
    const items = this.queue;
    this.queue = [];
    for (const item of items) {
      this.appendLine(item.source === "runtime" ? this.toLine(item.event) : this.toLoopLine(item.loop));
    }
    if (this.droppedSinceFlush > 0) this.writeTruncationMarker();
    if (!this.disableFsync && this.flushIntervalMs > 0 && this.fd !== null) {
      fsyncSync(this.fd);
    }
  }

  private toLoopLine(loop: DevToolsLoopEventLike): DevToolsLogLine {
    return {
      schema: "arbor.devtools/v1",
      seq: ++this.sequence,
      ts: this.now(),
      campaign_id: typeof loop.campaign_id === "string" ? loop.campaign_id : null,
      node_id: typeof loop.node_id === "string" ? loop.node_id : null,
      event_kind: `loop.${loop.type}`,
      event: { kind: `loop.${loop.type}` },
      source_record_id: null,
      source_content_hash: null,
      synthetic: false,
      loop_event: { ...loop },
    };
  }

  private writeTruncationMarker(): void {
    const dropped = this.droppedSinceFlush;
    this.droppedSinceFlush = 0;
    const marker: DevToolsLogLine = {
      schema: "arbor.devtools/v1",
      seq: ++this.sequence,
      ts: this.now(),
      campaign_id: null,
      node_id: null,
      event_kind: "stream.truncated",
      event: { kind: "stream.truncated", stream_id: "devtools", cursor: { stream_id: "devtools", sequence: this.sequence }, dropped_records: dropped },
      source_record_id: null,
      source_content_hash: null,
      synthetic: true,
      loop_event: null,
    };
    this.appendLine(marker);
  }

  private toLine(event: RuntimeEvent): DevToolsLogLine {
    const pointer = ledgerPointerFor(event);
    return {
      schema: "arbor.devtools/v1",
      seq: ++this.sequence,
      ts: this.now(),
      campaign_id: campaignIdOf(event),
      node_id: nodeIdOf(event),
      event_kind: event.kind,
      event,
      source_record_id: pointer,
      source_content_hash: null,
      synthetic: false,
      loop_event: null,
    };
  }

  private appendLine(line: DevToolsLogLine): void {
    if (this.fd === null) return;
    const text = `${JSON.stringify(line)}\n`;
    const buffer = Buffer.from(text, "utf8");
    writeSync(this.fd, buffer);
    if (!this.disableFsync && this.flushIntervalMs === 0) fsyncSync(this.fd);
    this.activeBytes += buffer.byteLength;
    if (this.activeBytes >= this.maxBytes) this.rotate();
  }

  /**
   * Rotate the active segment. Renames `devtools.log` → `devtools.1.log`,
   * shifts older segments up to `max_segments`, and opens a fresh fd. Older
   * segments beyond `max_segments` are evicted (lossy by design — this is a
   * debugging aid, not a durability surface; restart replays from the ledger).
   */
  private rotate(): void {
    if (this.fd === null) return;
    fsyncSync(this.fd);
    closeSync(this.fd);
    this.fd = null;
    // Evict the oldest segment first to make room.
    if (this.maxSegments > 0) {
      const oldest = join(this.directory, `devtools.${this.maxSegments}.log`);
      if (existsSync(oldest)) renameSync(oldest, `${oldest}.evicted-${Date.now()}`);
      // Shift segments .(n-1) → .n, .(n-2) → .(n-1), …, .1 → .2
      for (let n = this.maxSegments - 1; n >= 1; n--) {
        const from = join(this.directory, `devtools.${n}.log`);
        const to = join(this.directory, `devtools.${n + 1}.log`);
        if (existsSync(from)) renameSync(from, to);
      }
      // Active → .1
      renameSync(this.logPath, join(this.directory, "devtools.1.log"));
    } else {
      // No retention: truncate the active file by replacing it.
      // The `a` open below on a missing path creates a fresh file.
      if (existsSync(this.logPath)) renameSync(this.logPath, `${this.logPath}.evicted-${Date.now()}`);
    }
    this.fd = openSync(this.logPath, "a");
    this.activeBytes = 0;
  }

  // --- Test-only accessors (used by the test suite, not exported via index) ---

  /** Active segment size in bytes (test-only). */
  _activeBytesForTest(): number { return this.activeBytes; }
  /** Current queue depth (test-only). */
  _queueDepthForTest(): number { return this.queue.length; }
  /** Dropped count since last flush (test-only). */
  _droppedSinceFlushForTest(): number { return this.droppedSinceFlush; }
  /** Path to the active log segment (test-only). */
  _logPathForTest(): string { return this.logPath; }
}

/**
 * Build a {@link RuntimeLifecycleParticipant} that runs a
 * {@link DevToolsTraceLogger}. Compose this into `ArborRuntime` via the
 * `lifecycle` option, or pass it directly when constructing the runtime.
 */
export function createDevToolsTraceLogger(
  manager: CampaignManager,
  options: DevToolsTraceLoggerOptions,
): RuntimeLifecycleParticipant & { logger: DevToolsTraceLogger } {
  const logger = new DevToolsTraceLogger(manager, options);
  return {
    name: logger.name,
    start: () => logger.start(),
    close: () => logger.close(),
    get logger() { return logger; },
  };
}

/**
 * Build an `executor.log`-compatible sink that routes loop-phase feedback
 * into a DevToolsTraceLogger. Wire it at the composition site where the loop
 * executor is built:
 *
 * ```ts
 * const hook = devtoolsLoopHook(myLogger);
 * executor.log = (e) => { existingLog?.(e); hook(e); };
 * ```
 *
 * Safe to call before the logger is started (a closed logger no-ops) and
 * defensive against malformed events.
 */
export function devtoolsLoopHook(logger: DevToolsTraceLogger | null): (loop: unknown) => void {
  return (loop: unknown) => {
    if (!logger) return;
    if (loop === null || typeof loop !== "object") return;
    const candidate = loop as Partial<DevToolsLoopEventLike>;
    if (typeof candidate.type !== "string" || !candidate.type) return;
    logger.loopEvent(candidate as DevToolsLoopEventLike);
  };
}

/**
 * Resolve the devtools loop hook for a started runtime.
 *
 * The loop executor takes a `devtoolsHook` sink, and every `loop.*` line in a
 * devtools log arrives through it -- specialist dispatch, critic dispatch, node
 * claims. Wiring it means locating the started `devtools-trace-logger`
 * participant on the runtime, which is fiddly enough that it was open-coded at
 * exactly one composition site (the seeded demo) and simply forgotten at the
 * other: `selfhost` passed `() => {}` and threw every loop event away. A real
 * campaign therefore produced a devtools log with no `loop.*` lines at all,
 * which is not a cosmetic gap -- the publication recorder requires empirical
 * proof of dispatch, so a genuine self-hosted run could never be recorded,
 * while the seeded replay could.
 *
 * Two callers is the Rule of Three's second occurrence, but the duplicated
 * thing here is knowledge -- the participant's name and the shape it is found
 * in -- and the cost of getting it wrong is silence rather than a failure. So
 * it lives in one place.
 *
 * Returns a safe no-op when the runtime has no devtools logger, which is the
 * correct behaviour for runs that were not started with one.
 */
export function devtoolsHookForRuntime(runtime: unknown): (loop: unknown) => void {
  const participants = (runtime as { startedParticipants?: Array<{ name?: string; logger?: unknown }> })
    ?.startedParticipants;
  const logger = participants?.find((participant) => participant?.name === "devtools-trace-logger")?.logger ?? null;
  return logger === null ? (): void => {} : devtoolsLoopHook(logger as DevToolsTraceLogger);
}

/**
 * Extract the producing ledger record id from a runtime event, when the event
 * carries one. Returns null for events that have no direct ledger counterpart
 * (e.g. `tree.node_changed`, `task.changed`) — the line still records the
 * event payload verbatim, it just doesn't invent a synthetic pointer.
 */
function ledgerPointerFor(event: RuntimeEvent): string | null {
  switch (event.kind) {
    case "audit.evidence_recorded": return event.evidence_id;
    case "kb.entry_added": return event.entry_id;
    case "gate.recorded": return null; // gate id is not ledger-identity; the checkpoint is recorded separately
    case "operation.accepted": return event.accepted_operation_id;
    default: return null;
  }
}

/** Pull the campaign id from any event variant that carries one. */
function campaignIdOf(event: RuntimeEvent): string | null {
  if ("campaign_id" in event) return event.campaign_id ?? null;
  return null;
}

/** Pull the node id from any event variant that carries one. */
function nodeIdOf(event: RuntimeEvent): string | null {
  if ("node_id" in event) return event.node_id ?? null;
  return null;
}

/**
 * Read the last `limit` records of a durable devtools log. Malformed lines
 * (a torn write at the tail, a rotation seam) are skipped rather than
 * failing the read: the log is an observability surface, and one bad line
 * must not blank the screen that replays it (EC-063).
 */
export function readDevToolsLogTail(logPath: string, limit: number): DevToolsLogLine[] {
  if (!existsSync(logPath)) return [];
  let text: string;
  try { text = readFileSync(logPath, "utf8"); } catch { return []; }
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const out: DevToolsLogLine[] = [];
  for (const raw of lines.slice(Math.max(0, lines.length - limit))) {
    try {
      const parsed = JSON.parse(raw) as Partial<DevToolsLogLine>;
      if (parsed.schema !== "arbor.devtools/v1" || typeof parsed.seq !== "number" || typeof parsed.event_kind !== "string") continue;
      out.push(parsed as DevToolsLogLine);
    } catch { /* torn or foreign line */ }
  }
  return out;
}
