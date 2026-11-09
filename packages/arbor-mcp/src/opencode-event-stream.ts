/**
 * opencode-event-stream.ts — parses `opencode run --format json`'s
 * line-delimited event stream into typed, bounded harness records.
 *
 * WHY THIS EXISTS. `opencode-executor.ts`'s `runOpenCode` spawns `opencode
 * run` with `--format default` (or no `--format` at all, its own default),
 * accumulates the ENTIRE stdout as one opaque string, and only inspects it
 * after the process exits (see `runOpenCode`/`buildOpenCodeArgs`). Whatever
 * commands the specialist or critic actually ran inside that turn — every
 * `bash`, `read`, `edit`, `grep` — are invisible: the only devtools events
 * the loop ever emits are harness-level dispatch records
 * (`opencode.panel_review`, `opencode.run`), one per WHOLE `opencode run`
 * call, never per command. That is the entire reason the cockpit has zero UI
 * representation of commands being run, unlike Codex or Claude Code.
 *
 * `opencode run` also supports `--format json` ("raw JSON events"), which
 * this repo has never used. A real probe, preserved as a sanitized committed
 * fixture at `packages/arbor-mcp/tests/fixtures/opencode-json-events.jsonl`,
 * captured the genuine shape: one JSON object per line, of type `step_start` / `tool_use` /
 * `text` / `step_finish`. `tool_use.part` carries `tool`, `callID`, and a
 * `state` object with `status`, `input`, `output`, `metadata.exit`,
 * `title` (already a terse human summary opencode itself computed — e.g.
 * `"wc -l f.txt"` for `{command:"wc -l f.txt"}`), and `time.start`/`time.end`.
 *
 * That probe is ONE observed sample from a single trivial `bash` call, not
 * the full contract: other tools (read/edit/write/glob/grep/task) will carry
 * different `input` shapes, `status` will not always be `"completed"`, and a
 * failing command carries a non-zero `exit`. Every extraction below is
 * therefore defensive — optional chaining and `typeof` guards only, never a
 * bare property access assumed to exist, and a line/field this parser has
 * never seen degrades to a generic fallback rather than throwing.
 *
 * WHAT THIS FILE OWNS. Pure parsing only: line-delimited-JSON -> typed
 * records. It has no dependency on `@arbor/tui`, `@arbor/opencode`, or the
 * devtools ring — it does not know what a `DevtoolsStreamLine` is. Wiring its
 * output into the loop's devtools stream and into the specialist/critic
 * result path is `opencode-executor.ts`'s job (see the call-site contract
 * documented on `parseOpenCodeEventStream` below); this module only needs to
 * be correct and bounded, independent of who calls it.
 */

// ── public record shapes ─────────────────────────────────────────────────────

/**
 * One normalized command the opencode agent ran during a turn — enough for
 * BOTH a terse one-line live projection (`summary`) and a full history pane
 * entry (`input`/`output`/`exit`).
 */
export interface OpenCodeCommandRecord {
  /** The tool name opencode reported (e.g. "bash", "read", "edit", "task"), or "unknown". */
  readonly tool: string;
  /**
   * Terse, human-readable one-liner. Prefers opencode's own `state.title`
   * when present (it already computed a terse form, e.g. `"wc -l f.txt"`);
   * otherwise built from tool-specific known input fields, then a generic
   * fallback — see `buildSummary`.
   */
  readonly summary: string;
  /** Full tool input, JSON-stringified and bounded by `MAX_FIELD_CHARS`. */
  readonly input: string;
  /** Full tool output/stdout, bounded by `MAX_FIELD_CHARS`. */
  readonly output: string;
  /** Process exit code when the tool reported one (e.g. a bash command), else null. */
  readonly exit: number | null;
  /**
   * Best-effort success signal: `exit === 0` when an exit code was observed,
   * else derived from `state.status` ("completed" -> true, "error"/"failed"
   * -> false), else null when neither signal is present — never guessed.
   */
  readonly ok: boolean | null;
  /** Raw `state.status` string as opencode reported it, "" if absent. */
  readonly status: string;
  /** `state.time.end - state.time.start` in ms when both are finite numbers, else null. */
  readonly durationMs: number | null;
  /** `state.time.start`, falling back to the event's own `timestamp`, else null. */
  readonly startedAtMs: number | null;
  /** opencode's `callID` for this tool invocation, or null. */
  readonly callId: string | null;
  /** True when `input` or `output` was cut to fit `MAX_FIELD_CHARS`, or opencode's own `metadata.truncated` was set. */
  readonly truncated: boolean;
}

/** Snapshot of everything parsed so far. Cheap to call repeatedly; never mutates the caller's data. */
export interface OpenCodeEventStreamResult {
  /** Commands in arrival order, oldest first, bounded to the most recent `MAX_COMMANDS` (see module doc). */
  readonly commands: readonly OpenCodeCommandRecord[];
  /**
   * The assistant's final answer, reassembled from every `text` event's
   * `part.text`, deduplicated by `part.id` (last value wins per id — the
   * correct semantics whether opencode emits one event per finished text
   * part or a growing value per id as it streams), joined in first-seen
   * order, then trimmed. This is the direct replacement for
   * `res.stdout.trim()` in the `--format default` path: switching to
   * `--format json` means the specialist's/critic's deliverable text no
   * longer IS the raw stdout, so callers MUST read `answerText`, not stdout.
   */
  readonly answerText: string;
  /** True when `answerText` was cut to fit `MAX_ANSWER_CHARS`. */
  readonly answerTruncated: boolean;
  /** Total structurally-valid JSON lines seen (any recognized or unrecognized event type). */
  readonly eventCount: number;
  /** Lines that were not valid JSON, or too large to safely parse. Never thrown on — counted instead. */
  readonly unparseableLineCount: number;
  /** First `MAX_UNPARSEABLE_SAMPLES` unparseable raw lines (each capped), for inspection/debugging. */
  readonly unparseableSamples: readonly string[];
}

// ── bounds ────────────────────────────────────────────────────────────────
//
// A campaign can run many specialist/critic turns back to back, and a single
// turn can invoke dozens of tools; none of these bounds may grow with stream
// length, or a long-running campaign exhausts memory the same way the
// devtools ring (DEVTOOLS_RING_CAPACITY, tui-adapter.ts) already guards
// against for ledger events.

/** Commands retained per parser instance; oldest dropped once exceeded (matches tui-adapter's ring pattern). One parser instance is scoped to one `opencode run` turn, so this is generous headroom, not a per-campaign budget. */
const MAX_COMMANDS = 500;
/** Per-field cap on a command's `input`/`output` string. Large enough to show a real command's output in the history pane; small enough that one `cat` of a huge file cannot dominate memory across hundreds of retained commands. */
const MAX_FIELD_CHARS = 4_000;
/** Cap on a live terse `summary` line — this is a one-liner, not a body. */
const MAX_SUMMARY_CHARS = 140;
/** Cap on the reassembled final answer text. Specialist/critic deliverables are normally a short summary; this is a defensive ceiling, not an expected size. */
const MAX_ANSWER_CHARS = 200_000;
/** Cap on distinct `text` part ids tracked for answer reassembly, guarding against a pathological stream that never reuses an id. */
const MAX_TEXT_PARTS = 2_000;
/** Raw unparseable lines kept for inspection. */
const MAX_UNPARSEABLE_SAMPLES = 20;
/** A single buffered line larger than this (no newline yet) is treated as unparseable and dropped, rather than growing the internal buffer without bound. */
const MAX_LINE_BYTES = 1_000_000;
/** Length a raw line sample is clipped to before being retained in `unparseableSamples`. */
const SAMPLE_CLIP_CHARS = 300;

function clip(value: string, max: number): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  return { text: value.slice(0, max), truncated: true };
}

// ── structural guards (never throw, never assume a field exists) ───────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ── summary construction ────────────────────────────────────────────────────

/** Known per-tool input field names to try, in priority order, when opencode supplies no `state.title`. */
const TOOL_SUMMARY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  bash: ["command"],
  read: ["filePath", "path"],
  write: ["filePath", "path"],
  edit: ["filePath", "path"],
  glob: ["pattern"],
  grep: ["pattern"],
  task: ["description", "prompt"],
  agent: ["description", "prompt"],
};
/** Generic fallback field order for a tool this module has not seen before. */
const GENERIC_SUMMARY_FIELDS: readonly string[] = ["command", "filePath", "path", "pattern", "query", "description", "prompt"];

function buildSummary(tool: string, title: string | null, input: Record<string, unknown> | null): string {
  if (title !== null && title.trim() !== "") return clip(title.trim(), MAX_SUMMARY_CHARS).text;
  const fields = TOOL_SUMMARY_FIELDS[tool] ?? GENERIC_SUMMARY_FIELDS;
  if (input !== null) {
    for (const field of fields) {
      const raw = asString(input[field]);
      if (raw !== null && raw.trim() !== "") {
        const prefix = tool === "bash" ? "$ " : `${tool} `;
        return clip(`${prefix}${raw.trim()}`, MAX_SUMMARY_CHARS).text;
      }
    }
  }
  return tool;
}

// ── tool_use -> OpenCodeCommandRecord ───────────────────────────────────────

function parseToolUse(event: Record<string, unknown>): OpenCodeCommandRecord | null {
  const part = asRecord(event["part"]);
  if (part === null) return null;
  const tool = asString(part["tool"]) ?? "unknown";
  const callId = asString(part["callID"]);
  const state = asRecord(part["state"]);
  const input = state !== null ? asRecord(state["input"]) : null;
  const metadata = state !== null ? asRecord(state["metadata"]) : null;
  const time = state !== null ? asRecord(state["time"]) : null;

  const status = (state !== null ? asString(state["status"]) : null) ?? "";
  const outputRaw = (state !== null ? asString(state["output"]) : null) ?? (metadata !== null ? asString(metadata["output"]) : null) ?? "";
  const title = state !== null ? asString(state["title"]) : null;

  const exit = metadata !== null ? asFiniteNumber(metadata["exit"]) : null;
  const ok = exit !== null ? exit === 0 : status === "completed" ? true : status === "error" || status === "failed" ? false : null;

  const startMs = time !== null ? asFiniteNumber(time["start"]) : null;
  const endMs = time !== null ? asFiniteNumber(time["end"]) : null;
  const durationMs = startMs !== null && endMs !== null ? endMs - startMs : null;
  const startedAtMs = startMs ?? asFiniteNumber(event["timestamp"]);

  const inputText = clip(input !== null ? safeStringify(input) : "", MAX_FIELD_CHARS);
  const outputText = clip(outputRaw, MAX_FIELD_CHARS);
  const metadataTruncated = metadata !== null && metadata["truncated"] === true;

  return Object.freeze({
    tool,
    summary: buildSummary(tool, title, input),
    input: inputText.text,
    output: outputText.text,
    exit,
    ok,
    status,
    durationMs,
    startedAtMs,
    callId,
    truncated: inputText.truncated || outputText.truncated || metadataTruncated,
  });
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    // Circular/unserializable input (never observed, but `state.input` is
    // opencode's own free-form payload — never trust it blindly).
    return "[unserializable input]";
  }
}

// ── incremental parser ──────────────────────────────────────────────────────

/**
 * Incremental line-delimited-JSON parser. Feed it stdout chunks as they
 * arrive (`push`); it never requires the whole stream in memory — only the
 * bounded state described in the module doc. Call `finish()` once after the
 * source ends to flush a final line with no trailing newline, then
 * `snapshot()` for the result. `snapshot()` is also safe to call mid-stream
 * for a live, ever-growing projection.
 */
export class OpenCodeEventStreamParser {
  private buffer = "";
  private readonly commands: OpenCodeCommandRecord[] = [];
  private readonly textParts = new Map<string, string>();
  private eventCount = 0;
  private unparseableLineCount = 0;
  private readonly unparseableSamples: string[] = [];

  push(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE_BYTES && !this.buffer.includes("\n")) {
      // No newline in sight and the buffer is already oversized — this is
      // not a line we can safely hold, let alone JSON.parse. Record it as
      // unparseable and drop it rather than growing without bound.
      this.recordUnparseable(this.buffer);
      this.buffer = "";
      return;
    }
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.consumeLine(line);
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  /** Flush a final buffered line that never received a trailing newline. Idempotent. */
  finish(): void {
    if (this.buffer.trim() !== "") this.consumeLine(this.buffer);
    this.buffer = "";
  }

  private consumeLine(rawLine: string): void {
    const line = rawLine.trim();
    if (line === "") return; // blank lines are normal framing, not malformed input
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.recordUnparseable(line);
      return;
    }
    const event = asRecord(parsed);
    if (event === null) {
      this.recordUnparseable(line);
      return;
    }
    this.eventCount += 1;
    this.consumeEvent(event);
  }

  private recordUnparseable(rawLine: string): void {
    this.unparseableLineCount += 1;
    if (this.unparseableSamples.length < MAX_UNPARSEABLE_SAMPLES) {
      this.unparseableSamples.push(clip(rawLine, SAMPLE_CLIP_CHARS).text);
    }
  }

  private consumeEvent(event: Record<string, unknown>): void {
    const type = asString(event["type"]);
    if (type === "tool_use") {
      const record = parseToolUse(event);
      if (record !== null) {
        this.commands.push(record);
        if (this.commands.length > MAX_COMMANDS) this.commands.shift();
      }
      return;
    }
    if (type === "text") {
      const part = asRecord(event["part"]);
      const id = part !== null ? asString(part["id"]) : null;
      const text = part !== null ? asString(part["text"]) : null;
      if (id === null || text === null) return;
      if (!this.textParts.has(id) && this.textParts.size >= MAX_TEXT_PARTS) return; // bounded distinct-id guard
      const bounded = clip(text, MAX_ANSWER_CHARS).text;
      this.textParts.set(id, bounded);
      return;
    }
    // step_start / step_finish / any other/unrecognized-but-valid-JSON event
    // kind: structural bookkeeping this parser does not project. Counted in
    // eventCount above, otherwise deliberately ignored — never an error.
  }

  snapshot(): OpenCodeEventStreamResult {
    let answer = "";
    for (const text of this.textParts.values()) answer += text;
    answer = answer.trim();
    const boundedAnswer = clip(answer, MAX_ANSWER_CHARS);
    return Object.freeze({
      commands: [...this.commands],
      answerText: boundedAnswer.text,
      answerTruncated: boundedAnswer.truncated,
      eventCount: this.eventCount,
      unparseableLineCount: this.unparseableLineCount,
      unparseableSamples: [...this.unparseableSamples],
    });
  }
}

/**
 * One-shot convenience for callers that already hold the complete stdout
 * string (the common case: `runOpenCode` resolves with the whole buffered
 * string regardless of `--format`, so a caller passing `format: "json"` can
 * call this directly on `res.stdout` with no streaming wiring required).
 * Equivalent to `push(fullText)` + `finish()` + `snapshot()` on a fresh parser.
 *
 * CALL-SITE CONTRACT for `opencode-executor.ts` (not made by this file —
 * opencode-executor.ts is out of this change's ownership):
 *
 *   const args = buildOpenCodeArgs({ ...existing fields..., format: "json" });
 *   const res = await runOpenCode({ opencodeBin, args, timeoutMs });
 *   if (res.ok) {
 *     const events = parseOpenCodeEventStream(res.stdout);
 *     const output = events.answerText;              // replaces res.stdout.trim()
 *     for (const cmd of events.commands) {
 *       adapter.pushDevtoolsLine({
 *         seq: 0, ts: new Date(cmd.startedAtMs ?? Date.now()).toISOString(),
 *         event_kind: "loop.tool_call", campaign_id: campaignId, node_id: params.node_id,
 *         synthetic: false,
 *         loop_event: {
 *           type: "tool_call", tool: cmd.tool, args: cmd.summary,
 *           ok: cmd.ok ?? undefined, duration_ms: cmd.durationMs, stdout: cmd.output,
 *           exit: cmd.exit, command: cmd.input,
 *         } as never,
 *       });
 *     }
 *     // events.unparseableLineCount > 0 is a real signal (opencode changed
 *     // its event shape, or emitted a corrupt line) worth a devtools/log
 *     // line of its own — never silently ignored.
 *   }
 *
 * This reuses the EXISTING `loop.tool_call` event_kind and its
 * `{tool,args,ok,duration_ms,stdout}` shape verbatim (see
 * `opencode-executor.ts`'s critic/specialist dispatch calls) — the two new
 * fields (`exit`, `command`) are additive, so every existing consumer of a
 * `loop.tool_call` line (devtools.ts's `renderRichRow`) keeps working
 * unchanged on lines that don't carry them. `packages/arbor-tui/src/
 * screens/command-history.ts` reads `exit`/`command` when present and
 * degrades gracefully when they are not (e.g. the harness-level
 * `opencode.panel_review`/`opencode.run` dispatch lines that predate this
 * change).
 *
 * For a live per-command devtools push AS a specialist runs (rather than
 * all at once after the whole turn exits), a caller can instead construct an
 * `OpenCodeEventStreamParser`, `.push()` each `child.stdout` chunk, and read
 * `.snapshot().commands` incrementally — the class this function wraps.
 */
export function parseOpenCodeEventStream(fullText: string): OpenCodeEventStreamResult {
  const parser = new OpenCodeEventStreamParser();
  parser.push(fullText);
  parser.finish();
  return parser.snapshot();
}
