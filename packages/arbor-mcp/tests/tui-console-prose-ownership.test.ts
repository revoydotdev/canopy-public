/**
 * Regression: ordinary prose typed on a fresh Console became a command
 * sequence.
 *
 * Console used to launch blurred, promoting a printable key into text mode
 * only when that key was NOT an exact screen binding. But `default-catalog.ts`
 * binds EVERY lowercase letter to a screen (`w` Recovery, `i` Interviews, `t`
 * Tree, `g` Governance, `d` DevTools, `m` KB, `v` Evidence Ledger, `l`
 * Backlog, ...; that table's own comment records the alphabet is exhausted),
 * so `isScreenNavigationKey` answered true for all 26 and the text-mode branch
 * was unreachable for every letter.
 *
 * Typing `wire up the console prompt` therefore navigated to Recovery on `w`,
 * to Interviews on `i`, and opened the USERINPUT.ASK operator form on the `u`
 * of "up" — on the primary greenfield intake surface. Every earlier pilot
 * probe missed it because each one pressed Enter to focus first.
 *
 * Console now owns the keyboard from its first frame and `Esc` releases it to
 * the navigation catalog. Both halves are asserted here: prose must land
 * intact and open no form, and the blur gesture must still reach a screen.
 * Driven through the real `runTui` entry point over real stdin.
 */
import { describe, expect, it, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTui } from "../src/tui.js";

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;?]*[A-Za-z]/g, "");
}
const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(() => resolve(), ms));
const ESCAPE = "";

describe("Console keyboard ownership on a fresh launch", () => {
  let tempDir = "";
  afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

  it("types prose containing bound navigation letters instead of routing them as commands", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-tui-prose-"));
    const stdin = new PassThrough();
    let out = "";
    const stdout = new PassThrough(); stdout.on("data", (d: Buffer) => { out += d.toString(); });
    Object.assign(stdout, { rows: 40, columns: 120, isTTY: false });
    const stderr = new PassThrough(); stderr.on("data", () => {});
    const donePromise = runTui({ cwd: tempDir, stdin, stdout, stderr });

    const waitFor = async (needle: string, timeoutMs = 30_000): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (stripAnsi(out).includes(needle)) return true;
        await settle(20);
      }
      return false;
    };
    expect(await waitFor("revoy2 console"), "Console did not render").toBe(true);

    // Every one of these letters is a global screen binding; `w`, `i` and `u`
    // are the three that used to fire before the operator finished the phrase.
    const prose = "wire up the console prompt";
    const beforeTyping = out.length;
    for (const char of prose) { stdin.write(char); await settle(2); }
    expect(await waitFor(prose), "typed prose never reached the composer").toBe(true);

    const typed = stripAnsi(out.slice(beforeTyping));
    expect(typed, "prose opened the USERINPUT.ASK form instead of typing").not.toContain("USERINPUT.ASK");

    // Escape is the documented release gesture (the composer footer says
    // "Esc blur"): one-key screen navigation must still work after it.
    const beforeBlur = out.length;
    stdin.write(ESCAPE);
    await settle(300);
    stdin.write("t");
    // Assert on the Tree screen's own visible identity. Its caption wording
    // changed with EC-006 (it no longer prescribes selecting a campaign that
    // may not exist), so match the durable noun rather than the old phrasing.
    expect(await waitFor("search tree", 10_000), "Escape did not restore navigation").toBe(true);
    expect(stripAnsi(out.slice(beforeBlur)).length).toBeGreaterThan(0);

    stdin.end();
    expect(await donePromise).toBe(0);
  }, 60_000);
});

describe("a terminal capability reply is not typed into the composer (EC-044)", () => {
  let tempDir = "";
  afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

  it("drops a DCS reply whose ESC arrives alone and whose payload trickles in byte by byte", async () => {
    // tmux answers XTVERSION with `ESC P > | tmux 3.7 ESC \\`, and delivers it
    // ONE BYTE PER CHUNK. The 30ms escape timer flushed the lone ESC as a
    // keypress, leaving the decoder empty, so the payload decoded as ordinary
    // text: `P>|tmux 3.7c` appeared in the operator's composer on 6 of 8 real
    // launches before this was fixed.
    tempDir = mkdtempSync(join(tmpdir(), "arbor-tui-reply-"));
    const stdin = new PassThrough();
    let out = "";
    const stdout = new PassThrough(); stdout.on("data", (d: Buffer) => { out += d.toString(); });
    Object.assign(stdout, { rows: 40, columns: 120, isTTY: false });
    const stderr = new PassThrough(); stderr.on("data", () => {});
    const donePromise = runTui({ cwd: tempDir, stdin, stdout, stderr });

    const waitFor = async (needle: string, timeoutMs = 30_000): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (stripAnsi(out).includes(needle)) return true;
        await settle(20);
      }
      return false;
    };
    expect(await waitFor("revoy2 console"), "Console did not render").toBe(true);

    stdin.write(ESCAPE);
    await settle(60);                       // let the escape timer flush it alone
    for (const ch of "P>|tmux 3.7") { stdin.write(ch); await settle(6); }
    stdin.write(`${ESCAPE}\\`);              // ST terminator
    await settle(200);

    const screen = stripAnsi(out);
    expect(screen).not.toContain("P>|tmux");
    expect(screen).not.toContain("tmux 3.7");

    stdin.end();
    await donePromise;
  }, 60_000);
});

describe("a CSI terminal report is not decoded as navigation keys (EC-056)", () => {
  let tempDir = "";
  afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

  it("drops a cursor-position report whose ESC arrives alone and whose bytes trickle in", async () => {
    // `ESC [ 40 ; 120 R` split after its ESC decoded as `[` (Compaction),
    // `4` (Output), `0` (Approvals) and `R` (Diff Review): a 240x70 pilot
    // walked four screens before the operator touched a key.
    tempDir = mkdtempSync(join(tmpdir(), "arbor-tui-cpr-"));
    const stdin = new PassThrough();
    let out = "";
    const stdout = new PassThrough(); stdout.on("data", (d: Buffer) => { out += d.toString(); });
    Object.assign(stdout, { rows: 40, columns: 120, isTTY: false });
    const stderr = new PassThrough(); stderr.on("data", () => {});
    const donePromise = runTui({ cwd: tempDir, stdin, stdout, stderr });
    const waitFor = async (needle: string, timeoutMs = 30_000): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) { if (stripAnsi(out).includes(needle)) return true; await settle(20); }
      return false;
    };
    expect(await waitFor("revoy2 console"), "Console did not render").toBe(true);
    const beforeReply = out.length;
    stdin.write(ESCAPE);
    await settle(60);
    for (const ch of "[40;120R") { stdin.write(ch); await settle(6); }
    await settle(400);
    const after = stripAnsi(out.slice(beforeReply));
    expect(after).not.toContain("compaction");
    expect(after).not.toContain("no approvals");
    expect(after).not.toContain("Diff Review unavailable");
    // A real chord still works: Escape then `[` after a gap opens Compaction.
    stdin.write(ESCAPE);
    await settle(60);
    stdin.write("[");
    expect(await waitFor("compaction", 10_000), "Escape then [ did not open Compaction").toBe(true);
    stdin.end();
    await donePromise;
  }, 60_000);
});
