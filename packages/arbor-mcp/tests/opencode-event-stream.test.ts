import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OpenCodeEventStreamParser, parseOpenCodeEventStream } from "../src/opencode-event-stream.js";

const PROBE_FILE = fileURLToPath(new URL("./fixtures/opencode-json-events.jsonl", import.meta.url));

describe("parseOpenCodeEventStream — sanitized real-probe fixture", () => {
  const probeText = readFileSync(PROBE_FILE, "utf8");

  it("parses the committed opencode --format json fixture with zero unparseable lines", () => {
    const result = parseOpenCodeEventStream(probeText);
    expect(result.unparseableLineCount).toBe(0);
    expect(result.unparseableSamples).toEqual([]);
    expect(result.eventCount).toBe(7); // step_start, tool_use, text, step_finish x2 rounds (7 lines total)
  });

  it("recovers the one real tool_use as a normalized command record", () => {
    const result = parseOpenCodeEventStream(probeText);
    expect(result.commands).toHaveLength(1);
    const [cmd] = result.commands;
    expect(cmd.tool).toBe("bash");
    // opencode's own state.title ("wc -l f.txt") is preferred verbatim.
    expect(cmd.summary).toBe("wc -l f.txt");
    expect(cmd.exit).toBe(0);
    expect(cmd.ok).toBe(true);
    expect(cmd.status).toBe("completed");
    expect(cmd.output).toBe("1 f.txt\n");
    expect(cmd.durationMs).toBe(1787872790915 - 1787872790910);
    expect(cmd.callId).toBe("call_02abd6ee7d3b46939e30241f");
    expect(cmd.truncated).toBe(false);
    expect(JSON.parse(cmd.input)).toEqual({ command: "wc -l f.txt", workdir: "/home/example/.claude/jobs/example/tmp/probe" });
  });

  it("reassembles the final answer text from the real text parts, trimmed", () => {
    const result = parseOpenCodeEventStream(probeText);
    // The probe's two text parts are "\n\n" (trailing whitespace after the
    // tool call) and "1" (the model's actual answer) — concatenated then
    // trimmed, this must recover exactly the deliverable a human reading the
    // transcript would call the answer.
    expect(result.answerText).toBe("1");
    expect(result.answerTruncated).toBe(false);
  });
});

describe("OpenCodeEventStreamParser — incremental / streaming behavior", () => {
  it("produces the identical result whether fed as one chunk or split arbitrarily across pushes", () => {
    const probeText = readFileSync(PROBE_FILE, "utf8");
    const whole = parseOpenCodeEventStream(probeText);

    const parser = new OpenCodeEventStreamParser();
    // Split mid-line, mid-token, and across several tiny chunks — the exact
    // shape a real `child.stdout.on("data", ...)` stream delivers.
    let index = 0;
    const chunkSizes = [3, 17, 1, 200, 5, 1000, 2, 40];
    let sizeIndex = 0;
    while (index < probeText.length) {
      const size = chunkSizes[sizeIndex % chunkSizes.length];
      sizeIndex += 1;
      parser.push(probeText.slice(index, index + size));
      index += size;
    }
    parser.finish();
    const streamed = parser.snapshot();

    expect(streamed.eventCount).toBe(whole.eventCount);
    expect(streamed.unparseableLineCount).toBe(0);
    expect(streamed.commands).toEqual(whole.commands);
    expect(streamed.answerText).toBe(whole.answerText);
  });

  it("snapshot() reflects partial progress mid-stream without requiring finish()", () => {
    const parser = new OpenCodeEventStreamParser();
    parser.push('{"type":"tool_use","timestamp":1,"part":{"type":"tool","tool":"bash","callID":"c1","state":{"status":"completed","input":{"command":"echo hi"},"output":"hi\\n","metadata":{"exit":0},"title":"echo hi","time":{"start":1,"end":2}}}}\n');
    const mid = parser.snapshot();
    expect(mid.commands).toHaveLength(1);
    expect(mid.commands[0].summary).toBe("echo hi");
  });

  it("never throws on malformed lines, and counts them instead of dropping them silently", () => {
    const parser = new OpenCodeEventStreamParser();
    parser.push("not json at all\n");
    parser.push('{"broken": \n'); // incomplete JSON on its own line
    parser.push("42\n"); // valid JSON, but not an object
    parser.push("\n"); // blank line — normal framing, not malformed
    parser.push('{"type":"text","part":{"id":"p1","text":"ok"}}\n');
    parser.finish();
    const result = parser.snapshot();
    expect(result.unparseableLineCount).toBe(3);
    expect(result.unparseableSamples).toEqual(["not json at all", '{"broken":', "42"]);
    expect(result.answerText).toBe("ok");
  });

  it("handles a partial line split across two push() calls", () => {
    const parser = new OpenCodeEventStreamParser();
    const line = '{"type":"text","part":{"id":"p1","text":"hello world"}}\n';
    parser.push(line.slice(0, 20));
    parser.push(line.slice(20));
    parser.finish();
    expect(parser.snapshot().answerText).toBe("hello world");
  });

  it("flushes a final line with no trailing newline only on finish()", () => {
    const parser = new OpenCodeEventStreamParser();
    parser.push('{"type":"text","part":{"id":"p1","text":"no newline"}}');
    expect(parser.snapshot().answerText).toBe(""); // not yet flushed
    parser.finish();
    expect(parser.snapshot().answerText).toBe("no newline");
  });

  it("last value wins per text part id, modeling a streaming/growing text part", () => {
    const parser = new OpenCodeEventStreamParser();
    parser.push('{"type":"text","part":{"id":"p1","text":"partial"}}\n');
    parser.push('{"type":"text","part":{"id":"p1","text":"partial answer complete"}}\n');
    parser.finish();
    expect(parser.snapshot().answerText).toBe("partial answer complete");
  });

  it("ignores step_start/step_finish and any unrecognized-but-valid event type without error", () => {
    const parser = new OpenCodeEventStreamParser();
    parser.push('{"type":"step_start","id":"s1"}\n');
    parser.push('{"type":"step_finish","id":"s1"}\n');
    parser.push('{"type":"some_future_event_kind","payload":{"nested":true}}\n');
    parser.finish();
    const result = parser.snapshot();
    expect(result.eventCount).toBe(3);
    expect(result.commands).toEqual([]);
    expect(result.answerText).toBe("");
    expect(result.unparseableLineCount).toBe(0);
  });

  it("degrades gracefully on a tool_use event with an unfamiliar tool and input shape", () => {
    const parser = new OpenCodeEventStreamParser();
    parser.push('{"type":"tool_use","timestamp":5,"part":{"type":"tool","tool":"webfetch","callID":"c9","state":{"input":{"url":"https://example.com"}}}}\n');
    parser.finish();
    const [cmd] = parser.snapshot().commands;
    expect(cmd.tool).toBe("webfetch");
    // No known field for "webfetch" and no state.title — falls back to the bare tool name.
    expect(cmd.summary).toBe("webfetch");
    expect(cmd.exit).toBeNull();
    expect(cmd.ok).toBeNull(); // no exit, no recognized status string
    expect(cmd.durationMs).toBeNull();
    expect(cmd.startedAtMs).toBe(5); // falls back to the event's own timestamp
  });

  it("degrades gracefully on a tool_use event missing part/state entirely", () => {
    const parser = new OpenCodeEventStreamParser();
    parser.push('{"type":"tool_use","timestamp":1}\n'); // no `part` at all
    parser.push('{"type":"tool_use","part":{}}\n'); // `part` with no `tool`/`state`
    parser.finish();
    const result = parser.snapshot();
    expect(result.eventCount).toBe(2);
    expect(result.unparseableLineCount).toBe(0);
    // The first line has no `part` -> dropped as a command (parseToolUse returns null).
    // The second has a `part` but no `tool` -> recovered as "unknown" with an empty summary fallback.
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].tool).toBe("unknown");
  });

  it("caps a command's input/output at MAX_FIELD_CHARS and marks it truncated", () => {
    const parser = new OpenCodeEventStreamParser();
    const hugeOutput = "x".repeat(10_000);
    parser.push(JSON.stringify({
      type: "tool_use",
      timestamp: 1,
      part: { type: "tool", tool: "bash", callID: "c1", state: { status: "completed", input: { command: "cat bigfile" }, output: hugeOutput, metadata: { exit: 0 } } },
    }) + "\n");
    parser.finish();
    const [cmd] = parser.snapshot().commands;
    expect(cmd.output.length).toBe(4_000);
    expect(cmd.truncated).toBe(true);
  });

  it("caps retained commands at 500, dropping the oldest first", () => {
    const parser = new OpenCodeEventStreamParser();
    for (let i = 0; i < 510; i += 1) {
      parser.push(JSON.stringify({
        type: "tool_use",
        timestamp: i,
        part: { type: "tool", tool: "bash", callID: `c${i}`, state: { status: "completed", input: { command: `echo ${i}` }, metadata: { exit: 0 } } },
      }) + "\n");
    }
    parser.finish();
    const result = parser.snapshot();
    expect(result.commands).toHaveLength(500);
    expect(result.commands[0].callId).toBe("c10"); // the first 10 were evicted
    expect(result.commands.at(-1)?.callId).toBe("c509");
  });

  it("guards an unbounded line with no newline instead of growing the buffer forever", () => {
    const parser = new OpenCodeEventStreamParser();
    parser.push("x".repeat(1_000_001)); // exceeds MAX_LINE_BYTES with no newline in sight
    const result = parser.snapshot();
    expect(result.unparseableLineCount).toBe(1);
    expect(result.unparseableSamples[0].length).toBe(300);
  });

  it("caps unparseableSamples retention while still counting every malformed line", () => {
    const parser = new OpenCodeEventStreamParser();
    for (let i = 0; i < 25; i += 1) parser.push(`not json ${i}\n`);
    const result = parser.snapshot();
    expect(result.unparseableLineCount).toBe(25);
    expect(result.unparseableSamples).toHaveLength(20);
  });
});
