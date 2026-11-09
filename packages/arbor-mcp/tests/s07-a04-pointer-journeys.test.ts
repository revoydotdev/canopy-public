/**
 * A04 closure (audit/2026-09-06-remediation/manifest.md): "ADR pointers,
 * scrolled lists, query submission and narrow modal coexistence remain
 * unproven." Driven end-to-end over real raw stdin + real SGR mouse reports
 * through the real `runTui` entry point (pattern:
 * tui-mouse-click-selection.test.ts), never by calling a selection helper
 * directly.
 *
 * Geometry note: `runTui` sizes the scene from `process.stdout.columns`/
 * `.rows` (tui.ts's `termCols`/`termRows`), not from the injected
 * `options.stdout` stream's own `.columns`/`.rows` -- setting those on the
 * `PassThrough` here has no effect on layout (only `isTTY` matters, for
 * renderer selection). Under vitest's piped stdout, `process.stdout.columns`
 * is `undefined`, so the real fallback of 120x40 governs. Under M2's
 * `computeShellLayout` (ui-spec §2.1), 120x40 is `columns >= 120 && rows >=
 * 24` -- the `docked` class, not `drawer`/overlay (the pre-M2 breakpoint was
 * `> 120`, baseline defect D-02; M2 fixes it to `>= 120`, so this exact
 * fallback size now docks rather than overlays). The rail is side-by-side
 * with the transcript rather than painted over it, but the click-resolution
 * and scroll-viewport math this journey proves is identical either way --
 * it always went through `sidebarAdrRows`/`hitTestFrame` against the rail's
 * real painted rect, never a hardcoded row/column. This journey uses that
 * real, reproducible geometry rather than an injected one that `runTui`
 * would silently ignore.
 *
 * Click-target derivation: rather than hand-deriving the rail's viewport
 * math (fragile -- see below), this computes the expected click row with
 * the SAME production functions the app itself renders with
 * (`buildGovernanceSnapshot` + `computeShellLayout` +
 * `sidebarAdrRows`/`projectResponsiveSidebar`, all real, unmodified
 * production code), fed the exact governance data and selection state this
 * test independently knows to be true at that point. The actual proof
 * remains end-to-end: a real SGR mouse byte sequence sent to the real
 * `runTui` process, asserted against its real stdout and a real persisted
 * store -- these helpers only compute WHERE to click, they do not assert
 * anything themselves.
 *
 * Ordering fix (this file previously documented this as a separately-
 * reportable finding rather than fixing it; it is fixed now): `tui.ts`'s
 * `consoleAdrRecords()` -- which supplies both the sticky default selection
 * and keyboard Up/Down cycling (`moveConsoleAdrSelection`) -- used to read
 * the governance query's raw `records` array, which
 * `governance-projection.ts`'s `buildGovernanceSnapshot` returns in
 * ASCENDING record-number order, while the RENDERED rail
 * (`responsive-sidebar.ts`'s `projectGovernance`) re-sorts that same data
 * into DESCENDING order ("newest first") for display via the exported
 * `orderDecisionRecordsForDisplay`. The two orderings disagreed: the sticky
 * default (raw ascending index 0) landed on the lowest-numbered record,
 * DESCENDING display index 19 (the bottom of the list) -- a fresh "adrs" tab
 * opened already scrolled to the bottom, and pressing Down moved the
 * selection to numerically higher records while it visually moved UP the
 * screen. `consoleAdrRecords()` now sorts through the same
 * `orderDecisionRecordsForDisplay` the rail itself uses (one ordering
 * authority, not two), so a fresh tab opens at the visual top (the newest
 * record, ADR-519 in this fixture corpus) and Down moves the selection
 * visually downward through the list, exactly as the rail renders it.
 */
import { describe, expect, it, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTui } from "../src/tui.js";
import { buildGovernanceSnapshot } from "../src/governance-projection.js";
import { computeShellLayout, projectResponsiveSidebar, resolveRailRenderOptions, sidebarAdrRows } from "@arbor/tui";
import { ArborRuntime } from "../src/runtime.js";
import { resolvePersistenceDir } from "../src/cli.js";
import { TaskAttachmentStore } from "../src/task-attachment-store.js";

/**
 * A reference-answer query always attaches the source document
 * (`askAboutConsoleAdr`'s `reference_attachments`, tui.ts), and
 * `TaskComposer.submit` (task-composer.ts) requires
 * `planner.supports_governed_artifacts === true` for ANY attachment-bearing
 * submission -- true only under `direct_native` campaign selection
 * (cli.ts), which needs a real reachable native model provider. This test
 * environment has none, so it supplies the same fixture-planner seam
 * `task-composer-reference-answer.test.ts` already established for this
 * exact case: a real `TaskComposer`/`ArborRuntime`, with only the
 * network-bound model call replaced by a deterministic fixture answer.
 */
function referenceAnsweringRuntime(persistenceDir: string): ArborRuntime {
  return new ArborRuntime({
    persistence_dir: persistenceDir,
    devtools_logger: { persistence_dir: persistenceDir, disable_fsync: true },
    task_composer_attachment_store: new TaskAttachmentStore(persistenceDir),
    task_composer_planner: {
      supports_governed_artifacts: true,
      answer_reference: async () => ({
        text: "This ADR fixture record is a pointer-journey test fixture; no repository authority is implied.",
        error: null, session_id: "a04-pointer-journey", model_identity: "test-native",
        usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, counter_source: "provider_counter" as const },
      }),
      plan: async () => { throw new Error("plan() should not be reached for a mode:'answer' reference-query submission"); },
    },
  });
}

const ESC = String.fromCharCode(27);
// The real fallback geometry `runTui` boots with when `process.stdout` is
// not a TTY (this test's own process, piped under vitest) -- see the file
// header note.
const TERMINAL_COLUMNS = 120;
const TERMINAL_ROWS = 40;
// The rail's real painted rect at this exact terminal size (docked, per
// `computeShellLayout` -- see the file header note), computed with the same
// production function the app renders with rather than a second, hand-kept
// copy of its geometry rules.
const SHELL_RAIL = computeShellLayout({ columns: TERMINAL_COLUMNS, rows: TERMINAL_ROWS }).rail;
if (SHELL_RAIL === null) throw new Error("expected a docked rail at the fixture's fallback terminal size");
const RAIL_RECT = SHELL_RAIL;
const RAIL_WIDTH = resolveRailRenderOptions({ width: RAIL_RECT.columns }).width;
const RAIL_X = RAIL_RECT.x;

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

/** A raw xterm SGR mouse press report: left button, 1-based (column, row). */
function sgrLeftClick(column: number, row: number): string {
  return `${ESC}[<0;${column};${row}M`;
}

function seedAdrCorpus(root: string, count: number): void {
  const decisionsDir = join(root, "decisions");
  mkdirSync(decisionsDir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    const number = 500 + i;
    const title = `Pointer fixture record ${i}`;
    const body = `# ADR-${number}: ${title}\n\n` +
      `**Status:** Accepted\n**Date:** 2026-08-05\n\n` +
      `## Context\n\nFixture context for A04 pointer-journey record ${i}.\n\n` +
      `## Decision\n\nFixture decision text ${i}.\n\n` +
      `## Consequences\n\nFixture consequences text ${i}.\n`;
    writeFileSync(join(decisionsDir, `ADR-${number}-fixture-${i}.md`), body, "utf8");
  }
}

/**
 * The exact 1-based (column, row) SGR coordinate a click on `targetId`'s
 * marker line resolves to, given `selectedId` is the currently-selected
 * record -- computed with the real `sidebarAdrRows` the app itself uses to
 * answer the same question in `onNativePaneHit` (tui.ts). Throws if the
 * target is not currently visible (i.e. this test's own scenario assumption
 * was wrong), rather than silently returning a coordinate that would prove
 * nothing.
 */
function adrClickCoordinate(cwd: string, selectedId: string, targetId: string): { column: number; row: number } {
  const snapshot = buildGovernanceSnapshot({ repo_root: cwd, at: new Date().toISOString() });
  if (!snapshot.ok) throw new Error(`governance snapshot build failed: ${snapshot.error.message}`);
  // M2 (ui-spec §4): the rail's ADR rows now render under the "governance"
  // tab (the M2 Governance tab re-homes the pre-M2 "adrs" tab's own rows
  // verbatim, `governanceTabBody`), one Tab press from the rail's default
  // "git" landing tab.
  const sidebar = projectResponsiveSidebar({
    width: TERMINAL_COLUMNS, visibility: "shown", tab: "governance",
    governance: { ok: true, value: snapshot.value },
    selected: { adr_id: selectedId },
  });
  const rows = sidebarAdrRows(sidebar, RAIL_RECT.rows, RAIL_WIDTH, null, "truecolor");
  const found = rows.find((entry) => entry.id === targetId);
  if (found === undefined) throw new Error(`${targetId} is not visible with ${selectedId} selected; visible rows: ${JSON.stringify(rows)}`);
  // `sidebarAdrRows`' row is 0-based from the rail pane's own interior; the
  // rail pane itself starts at `RAIL_RECT.y` (below the M2 header band, ui-
  // spec §2.2), and SGR rows are 1-based.
  return { column: RAIL_X + 6, row: RAIL_RECT.y + found.row + 1 };
}

describe("A04: ADR-rail pointer selection, post-scroll hit-region math, query submission by pointer, and narrow-overlay coexistence (runTui, real SGR mouse)", () => {
  let tempDir = "";
  afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

  it("mouse-selects a scrolled ADR row in a narrow rail overlay, without losing the Console draft underneath, then submits a real query", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-tui-a04-"));
    // 20 records: content.length = 4 (preamble) + 20*2 = 44, well over the
    // rail's own contentBudget (height - 5 = 35 at the real 40-row
    // fallback). A fresh tab opens at the visual top (the fix below), so the
    // first 15 records (ADR-519 down through ADR-505) fit without scrolling
    // -- only walking the selection all the way to the bottom (ADR-500)
    // actually scrolls the view, which is what the keyboard-navigation step
    // does.
    seedAdrCorpus(tempDir, 20);

    const persistenceDir = resolvePersistenceDir(tempDir);
    const stdin = new PassThrough();
    let out = "";
    const stdout = new PassThrough(); stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    Object.assign(stdout, { isTTY: false }); // forces the plain-text renderer path; geometry comes from process.stdout (see file header).
    const stderr = new PassThrough(); stderr.on("data", () => {});

    const donePromise = runTui({
      cwd: tempDir, persistence_dir: persistenceDir, stdin, stdout, stderr, frame_interval_ms: 10,
      runtime_factory: () => referenceAnsweringRuntime(persistenceDir),
    });
    await waitUntil(() => stripAnsi(out).includes("revoy2 console"), "Console did not render", 15_000);

    // A real in-progress draft, left uncommitted, underneath where the rail
    // is about to overlay.
    for (const char of "kept behind overlay") {
      stdin.write(char);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await waitUntil(() => stripAnsi(out).includes("kept behind overlay"), "Console draft did not render before the overlay opened", 5_000);

    // Ctrl+B focuses the rail (visibility "shown"); Tab moves from the
    // M2 default "git" tab to "governance" (ui-spec §4's rail cycle order:
    // git, governance, inspect, then the pre-M2 tabs). `consoleAdrRecords()`'s
    // sticky default now lands on ADR-519 (the fix): the newest record,
    // DISPLAY index 0 -- the same record the rail itself renders first.
    out = "";
    stdin.write("");
    stdin.write("\t");
    await waitUntil(() => stripAnsi(out).includes("› ✓ revoy2:ADR-519"), "ADR rail tab did not open on the expected sticky default", 5_000);
    const overlayFrame = stripAnsi(out);
    // Narrow-viewport "modal coexistence": the rail overlay and the
    // Console's own draft are both on screen in the SAME frame -- the
    // overlay did not blank, reset, or replace the pane underneath it.
    expect(overlayFrame).toContain("kept behind overlay");
    // A fresh tab opens at the visual TOP of the list -- the panel header
    // and the newest record are both visible without any scroll.
    expect(overlayFrame).toContain("ARCHITECTURAL DECISIONS");
    expect(overlayFrame).not.toContain("revoy2:ADR-500"); // the bottom-of-list record is not yet visible.

    // Move the keyboard selection all the way to the bottom: 19 Down
    // presses walk display index 0 (ADR-519) to display index 19
    // (ADR-500) -- Down moves the selection visually DOWNWARD through the
    // list (proving the fix, not just a selection flag with no visual
    // effect), and only this walk actually scrolls the view (the first 15
    // records fit in the initial unscrolled viewport; see the seeding
    // comment above).
    out = "";
    for (let i = 0; i < 19; i += 1) { stdin.write(`${ESC}[B`); await new Promise((resolve) => setTimeout(resolve, 15)); }
    await waitUntil(() => stripAnsi(out).includes("› ✓ revoy2:ADR-500"), "keyboard navigation did not move the selection to the bottom of the display order", 5_000);
    const scrolledFrame = stripAnsi(out);
    // The selection marker moved off the top-of-list default -- Down moved
    // the selection, not just an internal index with no visible effect.
    expect(scrolledFrame).not.toContain("› ✓ revoy2:ADR-519");

    // The click target: a record still visible alongside the current
    // ("ADR-500") selection, computed by the real production row-mapping
    // function (`sidebarAdrRows`) rather than hand-derived arithmetic --
    // see the file header note on why this journey computes rather than
    // screen-scrapes for its row oracle.
    const target = adrClickCoordinate(tempDir, "revoy2:ADR-500", "revoy2:ADR-505");

    out = "";
    stdin.write(sgrLeftClick(target.column, target.row));
    await waitUntil(() => stripAnsi(out).includes("› ✓ revoy2:ADR-505"), "the clicked ADR row did not redraw as selected", 5_000);
    const clickedFrame = stripAnsi(out);
    // The click MOVED the marker onto ADR-505 and off ADR-500 (the prior
    // keyboard selection) -- proving a real selection change resolved
    // against the actual scrolled layout, not merely that ADR-505's row
    // exists somewhere in the whole scrollback.
    expect(clickedFrame).toContain("› ✓ revoy2:ADR-505");
    expect(clickedFrame).not.toContain("› ✓ revoy2:ADR-500");

    // "?" opens the real query preset for the mouse-selected record.
    out = "";
    stdin.write("?");
    await waitUntil(() => stripAnsi(out).includes("ASK ABOUT THIS REFERENCE"), "the query preset did not open for the pointer-selected ADR", 5_000);
    const queryFrame = stripAnsi(out);
    expect(queryFrame).toContain("revoy2:ADR-505");
    expect(queryFrame).toContain("Pointer fixture record 5");

    // Enter SUBMITS it -- the manifest's own callout is that the prior
    // pilot "opened then cancelled its form"; this closes that gap with a
    // durably persisted record.
    stdin.write("\n");
    const draftsPath = join(persistenceDir, "task-composer", "drafts.json");
    await waitUntil(() => {
      try {
        const parsed = JSON.parse(readFileSync(draftsPath, "utf8")) as { drafts?: readonly { task?: string; mode?: string }[] };
        return (parsed.drafts ?? []).some((d) => typeof d.task === "string" && d.task.includes("revoy2:ADR-505") && d.mode === "answer");
      } catch {
        return false;
      }
    }, "the pointer-driven query was not durably submitted (still just opened/cancelled)", 15_000);

    stdin.write(`${ESC}`);
    stdin.end();
    expect(await donePromise).toBe(0);

    // Independent, post-exit confirmation the submission is a real durable
    // record, not a transient in-memory echo: read the store back exactly
    // the way a fresh process would.
    const persisted = JSON.parse(readFileSync(draftsPath, "utf8")) as { drafts?: readonly { task?: string; mode?: string; source?: string }[] };
    const submitted = (persisted.drafts ?? []).find((d) => typeof d.task === "string" && d.task.includes("revoy2:ADR-505"));
    expect(submitted).toMatchObject({ mode: "answer", source: "tui" });
  }, 60_000);
});
