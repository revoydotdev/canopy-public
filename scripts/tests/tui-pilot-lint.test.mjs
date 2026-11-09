/**
 * scripts/tests/tui-pilot-lint.test.mjs — each detector fires on the frame
 * shape the EC log recorded, and not on a clean frame.
 *
 * The positives are lifted from the log's own quoted frames, so a detector
 * that stops matching the defect it was written for fails here. The negative
 * control is a clean greenfield Console row set: a detector that fires on it
 * would send the reviewer to look at nothing.
 */
import { describe, expect, it } from "vitest";
import { DETECTORS, lintFrame } from "../tui-pilot/lint-frames.mjs";

const COLS = 120;
const frame = (lines, extra = {}) => ({ name: "f0001", lines, cols: COLS, rows: Math.max(lines.length, 12), step: "test", ...extra });
const box = (...rows) => [
  `┌─revoy2${"─".repeat(COLS - 9)}┐`,
  ...rows.map((r) => `│${r.padEnd(COLS - 2)}│`),
  ...Array.from({ length: Math.max(0, 9 - rows.length) }, () => `│${" ".repeat(COLS - 2)}│`),
  `└${"─".repeat(COLS - 2)}┘`,
  " · Idle — describe what you want changed",
];
const detectorsOf = (findings) => [...new Set(findings.map((f) => f.detector))].sort();

describe("lintFrame — known positives from the EC log", () => {
  it("control_leak: tmux's XTVERSION reply in the composer (EC-044)", () => {
    const f = lintFrame(frame(box("", "", "", "", "", "", "", "", "│ ❯ P>|tmux 3.7c")));
    expect(detectorsOf(f)).toContain("control_leak");
  });

  it("sgr_literal: an SGR parameter list rendered as text (EC-049)", () => {
    const f = lintFrame(frame(box("[38;2;170;160;185m·[0m New session on /tmp/x")));
    expect(detectorsOf(f)).toContain("sgr_literal");
  });

  it("impossible_range: the paged-past-the-end caption (EC-043)", () => {
    const f = lintFrame(frame(box("Capabilities · 0-188 of 188")));
    expect(detectorsOf(f)).toContain("impossible_range");
    expect(detectorsOf(lintFrame(frame(box("Capabilities · 1-41 of 188"))))).not.toContain("impossible_range");
  });

  it("bare_question_mark: endpoints disclosed as ? (EC-016)", () => {
    const f = lintFrame(frame(box("↳ node_communication · ? → ? · payload structurally unavailable")));
    expect(detectorsOf(f)).toContain("bare_question_mark");
  });

  it("identifier_heading: a form titled by its command id (EC-035)", () => {
    const f = lintFrame(frame(box("job.submit", "", "id:")));
    expect(detectorsOf(f)).toContain("identifier_heading");
  });

  it("bare_empty_state: an absence naming no subject or cause (EC-012)", () => {
    expect(detectorsOf(lintFrame(frame(box("no bus messages", ""))))).toContain("bare_empty_state");
    // The remedied form names its subject and what creates a record.
    expect(detectorsOf(lintFrame(frame(box("No bus messages yet", "Messages appear when governed nodes broadcast on a lane"))))).not.toContain("bare_empty_state");
  });

  it("stderr_smear: a [tui] diagnostic painted over the screen (EC-038)", () => {
    const f = lintFrame(frame(box("Value: auto l      le evidence could not be persisted: ca", "Secret: no                                 t", "[tui] terminal profile evidence could not be persisted")));
    expect(detectorsOf(f)).toContain("stderr_smear");
  });

  it("unmarked_truncation: a cell cut flush against a border with no ellipsis (EC-023)", () => {
    // The row fills the pane and ends mid-word against the border, as the
    // 80x24 populated Console did ("… approval pending: output.raw · s│").
    const filler = "• task started: specialist.expand · INSPECT · approval pending: output.raw · seeded disclosure review by the operator ".repeat(3);
    const flush = filler.slice(0, COLS - 2).replace(/\s+$/u, "").padEnd(COLS - 3, "x") + "s";
    expect(detectorsOf(lintFrame(frame(box(flush))))).toContain("unmarked_truncation");
    const marked = `${flush.slice(0, COLS - 3)}…`;
    expect(detectorsOf(lintFrame(frame(box(marked))))).not.toContain("unmarked_truncation");
  });

  it("residue: an isolated glyph surviving a screen change at the same cell (EC-019)", () => {
    // Rows differ around the glyphs (the screen changed) but `e` and `d` sit
    // at the same cells in both frames — EC-019's "e     d" floating in the
    // middle of every subsequent screen.
    const prev = frame(box("Interviews (1)", "", "", "", "", "", `Interview  Question${" ".repeat(21)}e${" ".repeat(5)}d`));
    const cur = frame(box("Communications (5)", "", "", "", "", "", `Communications     ${" ".repeat(21)}e${" ".repeat(5)}d`));
    expect(detectorsOf(lintFrame(cur, { prev }))).toContain("residue");
    const clean = frame(box("Communications (5)", "", "", "", "", "", "↳ report · worker → root"));
    expect(detectorsOf(lintFrame(clean, { prev }))).not.toContain("residue");
  });

  it("dead_space: a pane whose interior is almost entirely blank (EC-001)", () => {
    const rows = Array.from({ length: 30 }, () => "");
    rows[0] = "no campaigns";
    expect(detectorsOf(lintFrame(frame(box(...rows), { rows: 33 })))).toContain("dead_space");
  });
});

describe("lintFrame — calibration: right-aligned header (sweep 2)", () => {
  it("does not read the header's flush STATUS block as a cut", () => {
    const width = 132;
    const inner = `TASK · plan.md${" ".repeat(60)}STATUS · Delegating · nodes 0/3 · revoy-native · tree 1:1`;
    const line = `│${inner.padEnd(width - 2)}│`.slice(0, width);
    const frame = { cols: width, rows: 3, lines: [`┌${"─".repeat(width - 2)}┐`, line, `└${"─".repeat(width - 2)}┘`] };
    expect(lintFrame(frame).filter((f) => f.detector === "unmarked_truncation")).toEqual([]);
  });
});

describe("lintFrame — negative control", () => {
  it("a clean greenfield Console raises no error- or warning-level finding", () => {
    const lines = box(
      "· New session on /tmp/pilot-project                                         ┌──────────────┐",
      "                                                                            │[PROJECT] | A…│",
      "No campaign yet. Describe a change below and revoy plans it into one.       │Ctrl+B focus  │",
      `Try "write a test for src/main.ts"                                          │              │`,
      "                                                                            └──────────────┘",
      "┌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐",
      "│ ❯ Enter to focus…                                                                                                │",
      "└╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ Enter focus · Ctrl+P palette ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘",
    );
    const serious = lintFrame(frame(lines)).filter((f) => f.severity !== "info");
    expect(serious).toEqual([]);
  });

  it("every detector declares a severity and the EC it came from", () => {
    for (const [name, meta] of Object.entries(DETECTORS)) {
      expect(["error", "warning", "info"], name).toContain(meta.severity);
      expect(meta.ec, name).toMatch(/^EC-\d{3}/u);
    }
  });
});

describe("lintRun — unprompted screen change (EC-056)", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { lintRun } = await import("../tui-pilot/lint-frames.mjs");
  const run = (captions, steps) => {
    const dir = mkdtempSync(join(tmpdir(), "lint-run-"));
    mkdirSync(join(dir, "frames"));
    captions.forEach((caption, i) => writeFileSync(join(dir, "frames", `f${String(i).padStart(4, "0")}.txt`), `┌─revoy2─┐\n│${caption}│\n└────────┘\n`));
    writeFileSync(join(dir, "receipt.json"), JSON.stringify({ kind: "revoy2.tui_pilot", frames: captions.map((_, i) => ({ file: `frames/f${String(i).padStart(4, "0")}`, step: "s" })), steps }));
    const result = lintRun(dir);
    rmSync(dir, { recursive: true, force: true });
    return result;
  };
  it("flags a caption change inside a step that sent no input, and not one that followed a key", () => {
    const captions = ["", "revoy2  /  STARTING", "TASK · plan.md", "No compaction records yet", "no surveillance findings", "Command palette"];
    const idle = run(captions, [{ index: 0, label: "launch", frame_start: 0, frame_end: 5, actions: [{ wait_for: "x", matched: false }] }, { index: 1, label: "palette", frame_start: 5, frame_end: 6, actions: [{ key: "C-p" }] }]);
    const flagged = idle.findings.filter((f) => f.detector === "unprompted_screen_change");
    expect(flagged.map((f) => f.frame)).toEqual(["f0003", "f0004"]);
    expect(flagged[0].excerpt).toContain("during \"launch\"");
  });
  it("does not flag the Console's pending caption hydrating into its variant", () => {
    const settled = run(["", "revoy2 console — no active campaign", "TASK · plan.md STATUS · Delegating"], [{ index: 0, label: "launch", frame_start: 0, frame_end: 3, actions: [{ wait_for: "x", matched: true }] }]);
    expect(settled.findings.filter((f) => f.detector === "unprompted_screen_change")).toEqual([]);
  });
});
