/**
 * Focused regression proof for the ADR-selection ordering fix (companion to
 * the fuller journey in s07-a04-pointer-journeys.test.ts, which discovered
 * and documents the defect in detail).
 *
 * `tui.ts`'s `consoleAdrRecords()` backs both the sticky default ADR
 * selection and keyboard Up/Down cycling (`moveConsoleAdrSelection`). It used
 * to read the governance query's raw `records` array in ASCENDING
 * record-number order, while the rendered inspector rail
 * (`responsive-sidebar.ts`'s `projectGovernance`) renders that same data in
 * DESCENDING order ("newest first") via the exported
 * `orderDecisionRecordsForDisplay`. The two disagreed: a fresh "adrs" tab
 * opened already selecting the lowest-numbered record -- the visual BOTTOM
 * of the list -- and pressing Down moved the selection to numerically higher
 * records while it visually moved UP the screen.
 *
 * `consoleAdrRecords()` now sorts through the same `orderDecisionRecordsForDisplay`
 * the rail itself uses. This test proves, over the real `runTui` entry point
 * and real raw stdin (never a selection helper called directly):
 *   1. a fresh "adrs" tab opens with the newest record selected -- the
 *      visual TOP of the list, not the bottom.
 *   2. pressing Down moves the selection to the next record DOWN the
 *      screen (the next-newest, not the next-oldest).
 *   3. pressing Up moves it back -- the two keys are real, symmetric
 *      opposites of the same visual order.
 */
import { describe, expect, it, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTui } from "../src/tui.js";
import { resolvePersistenceDir } from "../src/cli.js";

const ESC = String.fromCharCode(27);

function stripAnsi(text: string): string {
  return text.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "gu"), "");
}

async function waitUntil(predicate: () => boolean, message: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Three ADR records, all "accepted" (no proposed/draft tiebreak in play) -- display order is purely by record number, descending. */
function seedAdrCorpus(root: string): void {
  const decisionsDir = join(root, "decisions");
  mkdirSync(decisionsDir, { recursive: true });
  for (const number of [601, 602, 603]) {
    const body = `# ADR-${number}: fixture record ${number}\n\n` +
      `**Status:** Accepted\n**Date:** 2026-08-05\n\n` +
      `## Context\n\nFixture context for record ${number}.\n\n` +
      `## Decision\n\nFixture decision text ${number}.\n\n` +
      `## Consequences\n\nFixture consequences text ${number}.\n`;
    writeFileSync(join(decisionsDir, `ADR-${number}-fixture.md`), body, "utf8");
  }
}

describe("ADR-rail selection order matches display order (runTui, real stdin)", () => {
  let tempDir = "";
  afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

  it("opens the adrs tab selecting the newest record (visual top), and Down/Up move the selection to match the rendered order", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-tui-s10-adr-order-"));
    seedAdrCorpus(tempDir);

    const persistenceDir = resolvePersistenceDir(tempDir);
    const stdin = new PassThrough();
    let out = "";
    const stdout = new PassThrough(); stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    Object.assign(stdout, { isTTY: false });
    const stderr = new PassThrough(); stderr.on("data", () => {});

    const donePromise = runTui({ cwd: tempDir, persistence_dir: persistenceDir, stdin, stdout, stderr, frame_interval_ms: 10 });
    await waitUntil(() => stripAnsi(out).includes("revoy2 console"), "Console did not render", 15_000);

    // Ctrl+B focuses the rail; Tab moves from "project" to "adrs".
    out = "";
    stdin.write("\x02");
    stdin.write("\t");
    // A fresh tab opens selecting ADR-603 -- the newest record, display
    // index 0 -- not ADR-601 (the raw ascending array's first entry, the
    // pre-fix bug).
    await waitUntil(() => stripAnsi(out).includes("› ✓ revoy2:ADR-603"), "a fresh adrs tab did not open on the newest record", 5_000);
    const openedFrame = stripAnsi(out);
    // The list opens at its visual top: the header and every record are on
    // screen without needing to scroll (only 3 records exist).
    expect(openedFrame).toContain("ARCHITECTURAL DECISIONS");
    expect(openedFrame).toContain("revoy2:ADR-602");
    expect(openedFrame).toContain("revoy2:ADR-601");

    // Down moves the selection to the next record DOWN the rendered list
    // (ADR-602, the next-newest) -- not to some other record picked by a
    // raw, unrendered order.
    out = "";
    stdin.write(`${ESC}[B`);
    await waitUntil(() => stripAnsi(out).includes("› ✓ revoy2:ADR-602"), "Down did not move the selection to the next record down the rendered list", 5_000);
    expect(stripAnsi(out)).not.toContain("› ✓ revoy2:ADR-603");

    // A second Down moves it one further down: ADR-601, the last (oldest,
    // bottom-of-list) record.
    out = "";
    stdin.write(`${ESC}[B`);
    await waitUntil(() => stripAnsi(out).includes("› ✓ revoy2:ADR-601"), "a second Down did not move the selection to the bottom-of-list record", 5_000);
    expect(stripAnsi(out)).not.toContain("› ✓ revoy2:ADR-602");

    // Up is the real, symmetric opposite: it moves back UP the same
    // rendered order, landing on ADR-602 again.
    out = "";
    stdin.write(`${ESC}[A`);
    await waitUntil(() => stripAnsi(out).includes("› ✓ revoy2:ADR-602"), "Up did not move the selection back up the rendered list", 5_000);
    expect(stripAnsi(out)).not.toContain("› ✓ revoy2:ADR-601");

    stdin.write(`${ESC}`);
    stdin.end();
    expect(await donePromise).toBe(0);
  }, 30_000);
});
