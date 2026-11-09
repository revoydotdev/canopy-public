/**
 * ADR-162 O3, end to end: F6/Shift+F6 decoded from real stdin bytes move the
 * routing authority (the console input strip / inspector focus that key
 * dispatch actually consults), and the reducer's `focus.zone` shown in the
 * breadcrumb follows it. A draft typed in the composer survives a full cycle.
 */
import { afterEach, describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTui } from "../src/tui.js";
import { clearRegisteredScreens } from "@arbor/tui";

const ESC = String.fromCharCode(27);
const F6 = `${ESC}[17~`;
const SHIFT_F6 = `${ESC}[17;2~`;
const SHIFT_F10 = `${ESC}[21;2~`;
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g");

let tempDir: string | null = null;
afterEach(() => {
  clearRegisteredScreens();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

describe("focus zone routing over real stdin (ADR-162 O3)", () => {
  it("F6 cycles composer → transcript → rail → graph → composer, Shift+F6 reverses, and the draft survives", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-focus-routing-"));
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let text = "";
    stdout.on("data", (chunk: Buffer) => { text += chunk.toString(); });
    stderr.resume();
    const done = runTui({ cwd: tempDir, stdin, stdout: stdout as never, stderr: stderr as never });
    await settle(120);

    const plain = (): string => text.replace(ANSI, "\n");
    const lastBreadcrumbZone = (): string | null => {
      const matches = [...plain().matchAll(/\b(composer|transcript|rail|graph) › \w+/g)];
      return matches.at(-1)?.[1] ?? null;
    };

    expect(lastBreadcrumbZone()).toBe("composer");
    stdin.write("ab");
    await settle();
    expect(plain()).toContain("❯ ab");

    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      stdin.write(F6);
      await settle();
      seen.push(lastBreadcrumbZone() ?? "none");
    }
    expect(seen).toEqual(["transcript", "rail", "graph", "composer"]);

    stdin.write(SHIFT_F6);
    await settle();
    expect(lastBreadcrumbZone()).toBe("graph");
    stdin.write(F6);
    await settle();
    expect(lastBreadcrumbZone()).toBe("composer");

    // Back in the text-entry zone: printable keys are text, and the draft
    // typed before the cycle is intact.
    stdin.write("c");
    await settle();
    expect(plain()).toContain("❯ abc");

    stdin.end();
    expect(await done).toBe(0);
  });

  it("at 59x15 F6 skips hidden rail and graph and the warning identifies focus", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-focus-minimal-"));
    const stdin = new PassThrough();
    const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
    stdout.columns = 80;
    stdout.rows = 24;
    const stderr = new PassThrough();
    let text = "";
    stdout.on("data", (chunk: Buffer) => { text += chunk.toString(); });
    stderr.resume();
    const done = runTui({ cwd: tempDir, stdin, stdout, stderr });
    await settle(180);
    const plain = (): string => text.replace(ANSI, "\n");
    const focusedZone = (): string | null => [...plain().matchAll(/focus (composer|transcript) \(F6\)/g)].at(-1)?.[1] ?? null;
    stdin.write("draft");
    await settle(120);
    expect(plain()).toContain("draft");
    stdout.columns = 59;
    stdout.rows = 15;
    stdin.write(F6);
    await settle(140);
    expect(focusedZone()).toBe("transcript");
    stdin.write(F6);
    await settle(140);
    expect(focusedZone()).toBe("composer");
    stdin.write("x");
    await settle(120);
    expect(plain()).toContain("draftx");
    stdin.end();
    expect(await done).toBe(0);
  }, 30_000);

  // Defect (tui-overhaul m2 reel): Shift+F10 (CONTEXT_MENU_ACTION_ID,
  // default-catalog.ts's "shift+f10") did nothing while the Console's inline
  // composer was focused — the composer-focused key branch in tui.ts
  // forwarded ONLY Ctrl/Alt chords to `keyboardAction` and swallowed
  // everything else. F6/Shift+F6 already had an explicit bypass ahead of
  // that capture (the test above); this proves Shift+F10 now shares it, and
  // that the composer's draft is untouched by the shortcut.
  it("Shift+F10 opens the context menu even while the composer is focused, without touching the draft", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-context-menu-"));
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let text = "";
    stdout.on("data", (chunk: Buffer) => { text += chunk.toString(); });
    stderr.resume();
    const done = runTui({ cwd: tempDir, stdin, stdout: stdout as never, stderr: stderr as never });
    await settle(120);

    const plain = (): string => text.replace(ANSI, "\n");
    // `text` accumulates every frame ever written (stdout is a running
    // transcript, not a snapshot of the current screen), so `.toContain`
    // against the full buffer would stay true forever once a frame shows
    // something once. Only the text written SINCE the last checkpoint
    // reflects the current screen. Bookmark the PLAIN (ANSI-stripped)
    // string's own length, not the raw stream's -- stripping shortens the
    // string, so an index taken from the raw length overshoots the slice.
    let checkpoint = 0;
    const sinceCheckpoint = (): string => { const current = plain(); const slice = current.slice(checkpoint); checkpoint = current.length; return slice; };

    stdin.write("draft");
    await settle();
    expect(sinceCheckpoint()).toContain("❯ draft");

    stdin.write(SHIFT_F10);
    await settle();
    expect(sinceCheckpoint()).toContain("Command palette ·");

    stdin.write(ESC);
    // A lone Escape byte is deliberately HELD for ~30ms (a terminal
    // capability reply can arrive with its ESC alone in the first chunk)
    // before it flushes as a real keypress -- give the dismissal enough
    // room past that hold plus its own dispatch/render round trip.
    await settle(150);
    const afterDismiss = sinceCheckpoint();
    expect(afterDismiss).not.toContain("Command palette ·");
    expect(afterDismiss).toContain("❯ draft");

    stdin.end();
    expect(await done).toBe(0);
  });

  it("opens a live Console document and restores the rail focus/selection after close", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-reader-focus-"));
    mkdirSync(join(tempDir, "docs"));
    writeFileSync(join(tempDir, "docs", "reader.md"), "M7 live reader anchor evidence");
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let text = "";
    stdout.on("data", (chunk: Buffer) => { text += chunk.toString(); });
    stderr.resume();
    const done = runTui({ cwd: tempDir, stdin, stdout: stdout as never, stderr: stderr as never });
    const plain = (): string => text.replace(ANSI, "\n");
    const waitFor = async (needle: string, timeoutMs = 10_000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (plain().includes(needle)) return;
        await settle(20);
      }
      throw new Error(`timed out waiting for ${needle}`);
    };
    await waitFor("revoy2 console");
    // Release the composer, enter the rail, then cycle Git → … → Docs.
    stdin.write(ESC);
    stdin.write(F6);
    stdin.write(F6);
    await waitFor("rail › git");
    for (let index = 0; index < 5; index += 1) { stdin.write("\t"); await settle(40); }
    await waitFor("rail › docs");
    stdin.write("\n");
    await waitFor("M7 live reader anchor evidence");
    const beforeClose = plain().length;
    stdin.write(ESC);
    await settle(120);
    const afterClose = plain().slice(beforeClose);
    expect(afterClose).toContain("PROJECT DOCUMENTS");
    expect(afterClose).not.toContain("M7 live reader anchor evidence");
    stdin.end();
    expect(await done).toBe(0);
  }, 30_000);

  it("after resizing to 59x15, F6 skips hidden rail/graph zones and the warning keeps focus discoverable", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-focus-minimal-"));
    const stdin = new PassThrough();
    const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
    stdout.columns = 80;
    stdout.rows = 24;
    const stderr = new PassThrough();
    let text = "";
    stdout.on("data", (chunk: Buffer) => { text += chunk.toString(); });
    stderr.resume();
    const done = runTui({ cwd: tempDir, stdin, stdout, stderr });
    await settle(180);

    const plain = (): string => text.replace(ANSI, "\n");
    const focusedZone = (): string | null => [...plain().matchAll(/focus (composer|transcript) \(F6\)/g)].at(-1)?.[1] ?? null;
    stdin.write("draft");
    await settle(120);
    expect(plain()).toContain("draft");

    stdout.columns = 59;
    stdout.rows = 15;
    stdin.write(F6);
    await settle(140);
    expect(focusedZone()).toBe("transcript");
    stdin.write(F6);
    await settle(140);
    expect(focusedZone()).toBe("composer");
    stdin.write("x");
    await settle(120);
    expect(plain()).toContain("draftx");

    stdin.end();
    expect(await done).toBe(0);
  }, 30_000);
});
