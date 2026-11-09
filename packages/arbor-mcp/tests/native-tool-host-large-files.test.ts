/**
 * H5 (Stage 0 re-pilot, 2026-10-07): `repository.search` skipped every file
 * over 128 KiB, still counted it as scanned and reported `truncated: false`,
 * so a model searching `more_itertools/more.py` (174,587 bytes) was told the
 * file had no match. `file.read` could not read past its first window and told
 * the model to "request a smaller byte range", which no argument allowed.
 *
 * These tests drive the real tool host (`createNativeRepositoryToolHost`, the
 * real sandbox broker and workspace-file worker) against a GENERATED file of
 * the same shape — a large Python module whose target definition sits past
 * byte 131,072 — rather than the third-party file itself.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeToolRequest } from "@arbor/harness";
import { boundedToolModelOutput, createNativeRepositoryToolHost } from "../src/native-tool-host.js";

const created: string[] = [];
afterEach(() => { while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true }); });

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "arbor-native-large-files-"));
  created.push(root);
  return root;
}

function request(root: string, input: unknown): NativeToolRequest {
  return { session_id: "session-large", turn: 1, call_id: "call-large", input, workspace_roots: [root], filesystem: "read_only", intent_evidence: [], network_allowed: false };
}

function tools(root: string, limits: { max_read_bytes?: number; max_output_bytes?: number } = {}) {
  const descriptors = createNativeRepositoryToolHost({
    filesystem: "read_only",
    workspace_roots: [root],
    resolve_intent: () => ({ purpose: "large-file test", provenance: { tag: "claimed", claimant: "test" } }),
    ...limits,
  });
  return new Map(descriptors.map((descriptor) => [descriptor.tool, descriptor.port]));
}

async function call(host: ReturnType<typeof tools>, root: string, tool: string, input: unknown): Promise<Record<string, unknown>> {
  const response = await host.get(tool)!.execute(request(root, input), null, new AbortController().signal);
  return JSON.parse(response.model_output) as Record<string, unknown>;
}

/**
 * A >128 KiB Python-shaped module: quotes and backslashes (JSON escaping
 * inflates them), multi-byte UTF-8, CRLF-free LF lines, and `def padded` at
 * a line whose byte offset is past 131,072.
 */
function largeModule(): { text: string; paddedLine: number; paddedOffset: number } {
  const lines: string[] = ['"""Generated module for the H5 large-file regression (not third-party code)."""', ""];
  let index = 0;
  while (Buffer.byteLength(lines.join("\n"), "utf8") < 150 * 1024) {
    lines.push(`def helper_${index}(iterable, n=${index}):`, `    """Return the 'café' → \\"chunk\\" number ${index} of iterable."""`, `    return [x for x in iterable if x != "${index}\\\\t"]`, "");
    index += 1;
  }
  const paddedLine = lines.length + 1;
  const paddedOffset = Buffer.byteLength(lines.join("\n"), "utf8") + 1;
  lines.push("def padded(iterable, fillvalue=None, n=None, next_multiple=False):", '    """Yield the elements from *iterable*, followed by *fillvalue*."""', "    return iterable", "");
  for (let tail = 0; tail < 600; tail += 1) lines.push(`def trailer_${tail}():`, `    return ${tail}`, "");
  return { text: lines.join("\n"), paddedLine, paddedOffset };
}

describe("H5: repository.search scans large files and reports every bound it hits", () => {
  it("finds a match past byte 131,072 in a >128 KiB file, named directly or reached by the walk", async () => {
    const root = workspace();
    const module = largeModule();
    expect(Buffer.byteLength(module.text)).toBeGreaterThan(160 * 1024);
    expect(module.paddedOffset).toBeGreaterThan(131_072);
    mkdirSync(join(root, "more_itertools"));
    writeFileSync(join(root, "more_itertools", "more.py"), module.text);
    writeFileSync(join(root, "more_itertools", "more.pyi"), "def padded(iterable: object) -> object: ...\n");
    const host = tools(root);

    const named = await call(host, root, "repository.search", { query: "def padded", path: "more_itertools/more.py" });
    const walked = await call(host, root, "repository.search", { query: "def padded" });
    const scoped = await call(host, root, "repository.search", { query: "padded", path: "more_itertools", context_lines: 1 });

    expect(named).toMatchObject({ outcome: "succeeded", files_scanned: 1, truncated: false, truncation_reasons: [], skipped_files: [] });
    expect(named.matches).toEqual([expect.objectContaining({ path: "more_itertools/more.py", line: module.paddedLine, text: expect.stringContaining("def padded(iterable") })]);
    expect(named.bytes_scanned).toBe(Buffer.byteLength(module.text));
    expect((walked.matches as Array<{ path: string }>).map((match) => match.path).sort()).toEqual(["more_itertools/more.py", "more_itertools/more.pyi"]);
    expect(walked).toMatchObject({ files_scanned: 2, truncated: false });
    const scopedMatch = (scoped.matches as Array<Record<string, unknown>>).find((match) => match.path === "more_itertools/more.py");
    expect(scopedMatch).toMatchObject({ line: module.paddedLine, context_after: [expect.stringContaining("Yield the elements")] });
    expect((scopedMatch!.context_before as string[])).toHaveLength(1);
  });

  it("reports a file cut short by the per-file byte bound instead of an empty, complete-looking result", async () => {
    const root = workspace();
    const filler = `${"# filler line for the per-file scan bound\n".repeat(220_000)}`;
    const text = `${filler}needle_beyond_the_bound = 1\n`;
    expect(Buffer.byteLength(text)).toBeGreaterThan(8 * 1024 * 1024);
    writeFileSync(join(root, "huge.py"), text);

    const result = await call(tools(root), root, "repository.search", { query: "needle_beyond_the_bound" });

    expect(result).toMatchObject({ matches: [], files_scanned: 1, truncated: true, truncation_reasons: ["file_byte_limit"] });
    expect(result.skipped_files).toEqual([{ path: "huge.py", bytes: Buffer.byteLength(text), scanned_bytes: 8 * 1024 * 1024, reason: "file_byte_limit" }]);
    expect(result.remediation).toEqual(expect.stringContaining("file.read"));
  });

  it("never yields truncated:false with no matches when a line is longer than the line bound", async () => {
    const root = workspace();
    writeFileSync(join(root, "minified.js"), `var a="${"x".repeat(100 * 1024)}";var hidden_marker=1;\nshort line\n`);

    const result = await call(tools(root), root, "repository.search", { query: "hidden_marker" });

    expect(result).toMatchObject({ matches: [], truncated: true, truncation_reasons: ["line_byte_limit"], skipped_files: [expect.objectContaining({ path: "minified.js", reason: "line_byte_limit" })] });
  });

  it("names the file the match limit cut short, and lists a sensitive file as not searched without calling the result incomplete", async () => {
    const root = workspace();
    writeFileSync(join(root, "many.txt"), Array.from({ length: 150 }, (_, line) => `match ${line}`).join("\n"));
    const limited = await call(tools(root), root, "repository.search", { query: "match", path: "many.txt" });
    expect(limited).toMatchObject({ truncated: true, truncation_reasons: ["match_limit"], skipped_files: [expect.objectContaining({ path: "many.txt", reason: "match_limit" })] });
    expect(limited.matches).toHaveLength(100);

    const other = workspace();
    writeFileSync(join(other, ".env"), "NEEDLE=1\n");
    writeFileSync(join(other, "plain.txt"), "nothing here\n");
    const excluded = await call(tools(other), other, "repository.search", { query: "NEEDLE" });
    expect(excluded).toMatchObject({ matches: [], files_scanned: 1, truncated: false, skipped_files: [{ path: ".env", bytes: 9, scanned_bytes: 0, reason: "sensitive_path_denied" }] });
  });
});

describe("file.read pages through a large file with exact next-window hints", () => {
  type Window = Record<string, unknown> & { content: string; next_window: Record<string, unknown> | null };

  async function pageAll(host: ReturnType<typeof tools>, root: string, first: Record<string, unknown>): Promise<Window[]> {
    const windows: Window[] = [];
    let input: Record<string, unknown> | null = first;
    while (input !== null) {
      const result = await call(host, root, "file.read", input) as Window;
      expect(result.outcome).toBe("succeeded");
      windows.push(result);
      // The hint is sent back verbatim: that is the contract the model is given.
      input = result.next_window;
      expect(windows.length).toBeLessThan(100);
    }
    return windows;
  }

  it("follows next_window from the head to the end and reassembles the file byte-for-byte, inside the output bound", async () => {
    const root = workspace();
    const module = largeModule();
    writeFileSync(join(root, "more.py"), module.text);
    const host = tools(root);

    const windows = await pageAll(host, root, { path: "more.py" });

    expect(windows.length).toBeGreaterThan(2);
    expect(windows.map((window) => window.content).join("")).toBe(module.text);
    for (const [index, window] of windows.entries()) {
      // The default 64 KiB output bound holds the whole serialized result, so
      // no window is replaced by the head/tail projection.
      expect(window).not.toHaveProperty("head");
      expect(window.truncated).toBe(true);
      expect(window.content_sha256).toBeNull();
      expect(window.total_bytes).toBe(Buffer.byteLength(module.text));
      if (index > 0) expect(window.offset).toBe(windows[index - 1]!.end_offset);
      if (index > 0) expect(window.start_line).toBe((windows[index - 1]!.end_line as number) + 1);
      if (index < windows.length - 1) {
        expect(window.content.endsWith("\n")).toBe(true);
        expect(window.next_window).toEqual({ path: "more.py", offset: window.end_offset });
        expect(window.remaining_bytes).toBe(Buffer.byteLength(module.text) - (window.end_offset as number));
      }
    }
    const last = windows.at(-1)!;
    expect(last).toMatchObject({ remaining_bytes: 0, next_window: null, end_offset: Buffer.byteLength(module.text) });
    expect(windows.some((window) => window.content.includes("def padded(iterable"))).toBe(true);
  });

  it("pages by line with start_line/max_lines and lands on the definition past byte 131,072", async () => {
    const root = workspace();
    const module = largeModule();
    writeFileSync(join(root, "more.py"), module.text);
    const host = tools(root);

    const direct = await call(host, root, "file.read", { path: "more.py", start_line: module.paddedLine, max_lines: 3 });
    expect(direct).toMatchObject({ start_line: module.paddedLine, end_line: module.paddedLine + 2, offset: module.paddedOffset, truncated: true, next_window: { path: "more.py", start_line: module.paddedLine + 3, max_lines: 3 } });
    expect(direct.content).toBe(`${module.text.split("\n").slice(module.paddedLine - 1, module.paddedLine + 2).join("\n")}\n`);

    const windows = await pageAll(host, root, { path: "more.py", start_line: 1, max_lines: 2_000 });
    expect(windows.map((window) => window.content).join("")).toBe(module.text);
    for (const window of windows.slice(0, -1)) expect(window.next_window).toEqual({ path: "more.py", start_line: (window.end_line as number) + 1, max_lines: 2_000 });
  });

  it("pages by byte offset with max_bytes, never splitting a multi-byte character", async () => {
    const root = workspace();
    const text = "é→".repeat(6_000);
    writeFileSync(join(root, "wide.txt"), text);
    const host = tools(root);

    const windows = await pageAll(host, root, { path: "wide.txt", offset: 0, max_bytes: 1_001 });

    expect(windows.map((window) => window.content).join("")).toBe(text);
    expect(windows.every((window) => !window.content.includes("�"))).toBe(true);
    expect(windows[0]!.next_window).toEqual({ path: "wide.txt", offset: windows[0]!.end_offset, max_bytes: 1_001 });
  });

  it("keeps a complete small read writable and refuses impossible windows with actionable codes", async () => {
    const root = workspace();
    writeFileSync(join(root, "small.txt"), "one\ntwo\n");
    const host = tools(root);

    expect(await call(host, root, "file.read", { path: "small.txt" })).toMatchObject({ truncated: false, next_window: null, start_line: 1, end_line: 2, content_sha256: expect.stringMatching(/^sha256:/) });
    expect(await call(host, root, "file.read", { path: "small.txt", start_line: 2 })).toMatchObject({ content: "two\n", truncated: true, content_sha256: null, next_window: null });
    expect(await call(host, root, "file.read", { path: "small.txt", start_line: 9 })).toMatchObject({ outcome: "refused", code: "read_window_out_of_range" });
    expect(await call(host, root, "file.read", { path: "small.txt", offset: 99 })).toMatchObject({ outcome: "refused", code: "read_window_out_of_range" });
    expect(await call(host, root, "file.read", { path: "small.txt", offset: 0, start_line: 1 })).toMatchObject({ outcome: "refused", code: "read_window_invalid" });
  });

  it("tells a projected file.read result how to page, not to request a byte range that does not exist", () => {
    const projected = JSON.parse(boundedToolModelOutput({ outcome: "succeeded", stage: "execution", code: "ok", content: "x".repeat(4_000) }, 1_024, "file.read")) as Record<string, unknown>;
    const otherTool = JSON.parse(boundedToolModelOutput({ outcome: "succeeded", stage: "execution", code: "ok", output: "x".repeat(4_000) }, 1_024, "git.diff")) as Record<string, unknown>;

    expect(projected.remediation).toEqual(expect.stringContaining("start_line"));
    expect(otherTool.remediation).not.toEqual(expect.stringContaining("byte range"));
  });
});
