/**
 * T2.3a (FP-20 / RV-TUI-10): a real inline diff viewer for the Diff Review
 * screen — unified/split modes and hunk/file navigation — driven over real
 * stdin through the real `runTui` entry point, the same pattern
 * tui-keyboard-scrolling.test.ts uses for PageDown/Home/Down. Seeds a
 * campaign with a REAL captured patch (result-review-workspace.test.ts's
 * `captureWorktreeResult` pattern) so the frames asserted on are the real
 * `result.review.workspace` wire shape, not a hand-built fixture.
 */
import { describe, expect, it, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArborRuntime } from "../src/runtime.js";
import { resolvePersistenceDir } from "../src/cli.js";
import { captureWorktreeResult, listCapturedResults } from "../src/result-adoption.js";
import { runTui } from "../src/tui.js";
import type { Action } from "@arbor/core";

const rootAction: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;?]*[A-Za-z]/g, "");
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "diff-review-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "review@test.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Review test"], { cwd: root });
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
  writeFileSync(join(root, "wide.txt"), `${lines.join("\n")}\n`, "utf8");
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
  return root;
}

async function settle(ms = 60): Promise<void> { await new Promise((resolve) => setTimeout(resolve, ms)); }

describe("Diff Review screen — real inline diff viewer over real stdin (T2.3a)", () => {
  let tempDir = "";
  let worktree = "";
  afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); if (worktree) rmSync(worktree, { recursive: true, force: true }); });

  it("renders a real unified diff with a hunk header, toggles split mode via the command palette, and moves the hunk marker on Shift+J", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-tui-diff-"));
    const persistenceDir = resolvePersistenceDir(tempDir);
    worktree = repo();

    // Two edits far enough apart (line 2 vs line 55 of 60) to produce two
    // separate hunks in the real unified patch.
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
    lines[2] = "line 2 CHANGED";
    lines[55] = "line 55 CHANGED";
    writeFileSync(join(worktree, "wide.txt"), `${lines.join("\n")}\n`, "utf8");

    const seed = new ArborRuntime({ persistence_dir: persistenceDir, devtools_logger: { persistence_dir: persistenceDir, disable_fsync: true } });
    await seed.start();
    seed.manager.startCampaign("cmp-diff", "plan.md", rootAction);
    const capture = captureWorktreeResult({ campaign_id: "cmp-diff", node_id: "node-diff", worktree_path: worktree, verified: true, score: 1, persistence_dir: persistenceDir });
    expect(capture).not.toBeNull();
    expect(listCapturedResults(persistenceDir, "cmp-diff")).toHaveLength(1);

    const stdin = new PassThrough();
    let out = "";
    const stdout = new PassThrough(); stdout.on("data", (d: Buffer) => { out += d.toString(); });
    Object.assign(stdout, { rows: 30, columns: 110, isTTY: false });
    const stderr = new PassThrough(); stderr.on("data", () => {});

    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => { markReady = resolve; });
    // The capture is durable state created before this process starts, so
    // resume is the explicit history boundary that makes it visible.
    const donePromise = runTui({
      cwd: tempDir,
      stdin,
      stdout,
      stderr,
      frame_interval_ms: 10,
      resume: true,
      on_ready: markReady,
      // Keep the initialized manager and durable capture under one runtime
      // owner. A second pre-start manager would violate the runtime lifecycle
      // boundary and cannot provide the campaign identity to the query.
      runtime_factory: () => seed,
    });
    await ready;

    // Focus Diff Review through the command palette (`?` then a title
    // search) rather than its raw `shift+r` SCREEN_NAV binding: cockpit
    // intercepts bare "r"/"R" for the result-adopt/revert shortcut whenever
    // a captured result is pending (tui.ts's cockpit "R" handler), which
    // shadows the SCREEN_NAV chord in exactly this seeded state.
    stdin.write("?"); await settle(80);
    stdin.write("Diff Review"); await settle(80);
    stdin.write("\r"); await settle(300);
    const reviewDeadline = Date.now() + 5_000;
    while (!stripAnsi(out).includes("@@") && Date.now() < reviewDeadline) await settle(50);
    const opened = stripAnsi(out);
    expect(opened).toContain("Diff Review");
    expect(opened).toContain("@@");
    expect(opened).toContain("hunk 1/2");
    expect(opened).not.toContain("OLD │ NEW");

    // Open the command palette, filter to the mode-toggle action, execute it.
    out = "";
    stdin.write("?"); await settle(80);
    stdin.write("Toggle Result Diff Mode"); await settle(80);
    stdin.write("\r"); await settle(300);
    const toggled = stripAnsi(out);
    expect(toggled).toMatch(/OLD\s*│\s*NEW/);

    // Shift+J moves the hunk cursor from 1/2 to 2/2 within the current file.
    out = "";
    stdin.write("J"); await settle(250);
    const advanced = stripAnsi(out);
    expect(advanced).toContain("hunk 2/2");

    // Shift+K moves it back.
    out = "";
    stdin.write("K"); await settle(250);
    expect(stripAnsi(out)).toContain("hunk 1/2");

    stdin.end();
    const code = await donePromise;
    expect(code).toBe(0);
  }, 20_000);
});
