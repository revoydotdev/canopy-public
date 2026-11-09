import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { mp4EncoderArgs, normalizeScriptRaw, parseScriptTiming, replayScriptRecording, renderTerminalFrame, validateOutputAncestor, webmEncoderArgs } from "../terminal-recording-publication.mjs";

describe("terminal recording publication", () => {
  it("replays standard raw/timing bytes at a real capture clock", () => {
    const raw = Buffer.from("before\r\n\u001b[2Jafter", "utf8");
    const timing = parseScriptTiming("60 8\n60 9\n");
    const replay = replayScriptRecording(raw, timing, 1);
    expect(replay.duration_ms).toBe(120_000);
    expect(replay.frames.some((frame) => frame.text.includes("before"))).toBe(true);
    expect(replay.frames.at(-1).text).toContain("after");
    const svg = renderTerminalFrame(replay.frames[0], { campaign_id: "campaign-j", duration_ms: replay.duration_ms });
    expect(svg).toContain("RECORDED TUI REPLAY / REAL TIMING / SECRET-SCANNED TEXT");
    expect(svg).toContain("campaign-j");
  });

  it("fails closed on malformed timing, byte mismatches, and short recordings", () => {
    expect(() => parseScriptTiming("bad timing\n")).toThrow(/delay and byte count/);
    const timing = parseScriptTiming("120 3\n");
    expect(() => replayScriptRecording(Buffer.from("xx"), timing)).toThrow(/missing or ambiguous/);
    expect(() => replayScriptRecording(Buffer.from("xxx"), parseScriptTiming("119 3\n"))).toThrow(/not minutes long/);
  });

  it("carries ANSI sequences across timed raw chunks", () => {
    const raw = Buffer.from("before\u001b[2Jafter", "utf8");
    const replay = replayScriptRecording(raw, parseScriptTiming("0 6\n60 2\n60 7\n"));
    expect(replay.frames.some((frame) => frame.text.includes("before"))).toBe(true);
    expect(replay.frames.at(-1).text).toContain("after");
    expect(replay.frames.at(-1).text).not.toContain("[2J");
  });

  it("renders only the timed interior of a recognized util-linux script wrapper", () => {
    const header = Buffer.from("Script started on 2026-08-22 14:30:28-04:00 [COMMAND=\"bun /workspace/canopy/packages/arbor-mcp/src/cli.ts tui --renderer opentui\" TERM=\"xterm-256color\" TTY=\"/dev/pts/15\" COLUMNS=\"180\" LINES=\"50\"]\n");
    const interior = Buffer.from("hello");
    const footer = Buffer.from("Script done on 2026-08-22 00:02:00+00:00 [COMMAND_EXIT_CODE=\"0\"]\n");
    const raw = Buffer.concat([header, interior, Buffer.from("\n"), footer]);
    const timing = parseScriptTiming("120 5\n");
    const normalized = normalizeScriptRaw(raw, timing);
    expect(normalized.wrapper).toMatchObject({ kind: "util_linux_script", start_bytes: header.length, footer_bytes: footer.length + 1, raw_bytes: raw.length, timed_bytes: 5 });
    expect(replayScriptRecording(raw, timing).frames.at(-1).text).toContain("hello");
  });

  it("accepts util-linux's verbatim embedded JSON quotes in the discarded COMMAND field", () => {
    const header = Buffer.from("Script started on 2026-08-23 09:44:53-04:00 [COMMAND=\"'driver' '--verify-json' '[\"cargo\",\"test\",\"--quiet\"]'\" TERM=\"xterm-256color\" TTY=\"/dev/pts/11\" COLUMNS=\"180\" LINES=\"50\"]\n");
    const interior = Buffer.from("hello");
    const footer = Buffer.from("\nScript done on 2026-08-23 09:48:53-04:00 [COMMAND_EXIT_CODE=\"0\"]\n");
    const normalized = normalizeScriptRaw(Buffer.concat([header, interior, footer]), parseScriptTiming("240 5\n"));
    expect(normalized.wrapper).toMatchObject({ kind: "util_linux_script", start_bytes: header.length, timed_bytes: 5 });
    expect(normalized.timed_bytes.toString()).toBe("hello");
  });

  it("accepts util-linux 2.42's exact headless wrapper used by automated recordings", () => {
    const header = Buffer.from("Script started on 2026-08-23 11:46:11-04:00 [COMMAND=\"'driver' '--verify-json' '[\"npm\",\"test\"]'\" <not executed on terminal>]\n");
    const interior = Buffer.from("hello");
    const footer = Buffer.from("\nScript done on 2026-08-23 11:47:11-04:00 [COMMAND_EXIT_CODE=\"0\"]\n");
    const normalized = normalizeScriptRaw(Buffer.concat([header, interior, footer]), parseScriptTiming("120 5\n"));
    expect(normalized.wrapper).toMatchObject({ kind: "util_linux_script", start_bytes: header.length, timed_bytes: 5 });
    expect(normalized.timed_bytes.toString()).toBe("hello");
  });

  it("rejects malformed, ambiguous, and residual util-linux wrappers", () => {
    const header = Buffer.from("Script started on 2026-08-22 14:30:28-04:00 [COMMAND=\"arbor tui\" TERM=\"xterm\" TTY=\"/dev/pts/1\" COLUMNS=\"120\" LINES=\"42\"]\n");
    const footer = Buffer.from("Script done on 2026-08-22 00:02:00+00:00 [COMMAND_EXIT_CODE=\"0\"]\n");
    const timing = parseScriptTiming("120 5\n");
    expect(() => normalizeScriptRaw(Buffer.concat([Buffer.from("not a wrapper\n"), Buffer.from("hello")]), timing)).toThrow(/missing or ambiguous/);
    expect(() => normalizeScriptRaw(Buffer.concat([header, Buffer.from("hello"), Buffer.from("junk\n")]), timing)).toThrow(/missing or ambiguous|done wrapper/);
    expect(() => normalizeScriptRaw(Buffer.concat([header, Buffer.from("hello!\n"), footer]), timing)).toThrow(/wrapped interior contains 6/);
    expect(() => normalizeScriptRaw(Buffer.concat([header, Buffer.from("hello\n"), footer, Buffer.from("\n"), footer]), timing)).toThrow(/ambiguous/);
  });

  it("rejects a symlinked output ancestor before creating an outside child", () => {
    const root = mkdtempSync(join(tmpdir(), "terminal-publication-root-"));
    const outside = mkdtempSync(join(tmpdir(), "terminal-publication-outside-"));
    try {
      symlinkSync(outside, join(root, "escape"));
      const target = join(root, "escape", "must-not-exist");
      expect(() => validateOutputAncestor(target, root)).toThrow(/ancestor resolves outside/);
      expect(existsSync(join(outside, "must-not-exist"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });

  it("uses bounded practical encoders for long recordings", () => {
    expect(mp4EncoderArgs("frames.ffconcat", 120_000, "proof.mp4")).toEqual(expect.arrayContaining(["-loglevel", "error", "-nostats", "-preset", "veryfast"]));
    expect(webmEncoderArgs("proof.mp4", "proof.webm")).toEqual(expect.arrayContaining(["-loglevel", "error", "-nostats", "-cpu-used", "5"]));
  });
});
