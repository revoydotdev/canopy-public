/**
 * scripts/tests/tui-pilot-pty.bun.test.mjs — the real launcher, in a real
 * pty, observed through the emulator. Bun-only (`Bun.spawn({ terminal })`);
 * runs in the `test:opentui` lane, not under vitest.
 *
 * Three things the apparatus exists to make trustworthy:
 *  1. a bare `;` reaches the app and navigates (tmux consumed it — EC-026);
 *  2. the receipt's renderer is READ from the byte stream, and differs between
 *     `--renderer opentui` and `--renderer stdout` (EC-045 assumed it);
 *  3. a terminal capability reply replayed byte by byte with the timing tmux
 *     produced does not land in the composer (EC-044's regression, on the
 *     path an operator actually uses).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PtySession } from "../tui-pilot/lib/pty-session.mjs";
import { encodeKey } from "../tui-pilot/lib/keys.mjs";
import { applySeed } from "../tui-pilot/seeds/index.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LAUNCHER = join(REPO, "packages/arbor-mcp/bin/arbor-mcp.mjs");
const ESC = "\u001b";
const READY = /❯/u;

async function launch({ renderer = "opentui", cols = 120, rows = 40, seed = "greenfield" } = {}) {
  const project = mkdtempSync(join(tmpdir(), "tui-pilot-pty-"));
  await applySeed(seed, project);
  const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
  delete env.ARBOR_TUI_RENDERER;
  const session = new PtySession({ cmd: ["bun", LAUNCHER, "tui", "--renderer", renderer, "--notification-mechanism", "off"], cwd: project, env, cols, rows }).start();
  const ready = await session.waitFor(READY, { timeoutMs: 60_000 });
  return { session, project, ready };
}

async function finish({ session, project }) {
  await session.close();
  rmSync(project, { recursive: true, force: true });
}

describe("tui-pilot pty session", () => {
  test("a bare semicolon navigates to Surveillance, and the leader chord to Campaigns", async () => {
    const run = await launch();
    try {
      expect(run.ready.matched).toBe(true);
      // The composer owns the keyboard at launch; blur it so `;` is a binding, not text.
      run.session.write(encodeKey("Escape").bytes);
      await Bun.sleep(300);
      run.session.write(encodeKey(";").bytes);
      const surveillance = await run.session.waitFor(/surveillance/iu, { timeoutMs: 10_000 });
      expect(surveillance.matched).toBe(true);
      run.session.write(encodeKey("\\").bytes);
      await Bun.sleep(150);
      run.session.write(encodeKey("1").bytes);
      const campaigns = await run.session.waitFor(/no campaigns|Campaigns \(/iu, { timeoutMs: 10_000 });
      expect(campaigns.matched).toBe(true);
    } finally { await finish(run); }
  }, 120_000);

  test("the observed renderer is read from the byte stream and distinguishes the two renderers", async () => {
    const opentui = await launch({ renderer: "opentui" });
    try { expect(opentui.session.observedRenderer()).toBe("opentui"); } finally { await finish(opentui); }
    const stdout = await launch({ renderer: "stdout" });
    try {
      expect(stdout.session.observedRenderer()).toBe("stdout");
      expect(stdout.session.observedQueries().kitty_query ?? 0).toBe(0);
    } finally { await finish(stdout); }
  }, 180_000);

  test("a cursor-position report split after its ESC does not navigate (EC-056)", async () => {
    const run = await launch();
    try {
      // The Console keeps settling after the prompt appears (the "New session"
      // event lands a moment later; under a full-tier load, seconds later).
      // The assertion is about navigation, not startup content, so let the
      // startup finish before taking the reference frame.
      await run.session.hold(1500);
      const before = (await run.session.snapshot()).lines[1];
      run.session.write(ESC);
      await Bun.sleep(60);
      for (const ch of "[40;120R") { run.session.write(ch); await Bun.sleep(5); }
      await run.session.hold(1500);
      const after = await run.session.snapshot();
      expect(after.lines[1]).toBe(before);
      expect(after.text).toContain("❯");
    } finally { await finish(run); }
  }, 120_000);

  test("a tmux XTVERSION reply replayed byte by byte does not become composer text (EC-044)", async () => {
    const run = await launch();
    try {
      // Lone ESC, a pause, then the payload one byte at a time, then ST — the
      // exact chunking the tmux transport produced.
      run.session.write(ESC);
      await Bun.sleep(60);
      for (const ch of "P>|tmux 3.7c") { run.session.write(ch); await Bun.sleep(5); }
      run.session.write(`${ESC}\\`);
      await run.session.hold(1500);
      const snap = await run.session.snapshot();
      expect(snap.text).not.toMatch(/tmux 3\.7|P>\|/u);
      // And ordinary typing still lands.
      run.session.write("\r");
      await Bun.sleep(200);
      run.session.write("refactor");
      const typed = await run.session.waitFor(/❯ refactor/u, { timeoutMs: 5_000 });
      expect(typed.matched).toBe(true);
    } finally { await finish(run); }
  }, 120_000);
});
