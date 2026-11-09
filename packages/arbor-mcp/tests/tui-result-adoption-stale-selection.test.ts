/**
 * Audit finding: the selective-file-adoption state (`pendingResultAdoptionFiles`,
 * `resultActionFeedback`, `resultAdoptionConfirmation`) is closure state owned by
 * `tui.ts`'s driver, keyed to whatever capture `latestResultCapture` currently
 * names. When a *different*, higher-ranked capture supersedes the one the
 * operator was reviewing (a second verified node for the same campaign), the
 * driver never invalidates that state: the "Controls:" hint keeps claiming a
 * file selection is already armed ("confirm selected-file adoption") for a
 * capture the operator never chose files for — and pressing A would submit
 * the STALE file list against the NEW capture's node/patch identity.
 *
 * Driven over real stdin through the real `runTui` entry point, following
 * tui-diff-review.test.ts's real-capture seeding pattern. The renderer only
 * re-emits a screen line when its text changes, so the assertion reads the
 * LAST occurrence of the "Controls:" line across the whole accumulated
 * output rather than resetting the buffer between actions.
 */
import { describe, expect, it, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArborRuntime } from "../src/runtime.js";
import { resolvePersistenceDir } from "../src/cli.js";
import { captureWorktreeResult } from "../src/result-adoption.js";
import { runTui } from "../src/tui.js";
import { clearRegisteredScreens } from "@arbor/tui";
import type { Action } from "@arbor/core";

const rootAction: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;?]*[A-Za-z]/g, "");
}

function repo(fileName: string, content: string): string {
  const root = mkdtempSync(join(tmpdir(), "stale-selection-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "review@test.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Review test"], { cwd: root });
  writeFileSync(join(root, "base.txt"), "base\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
  writeFileSync(join(root, fileName), content, "utf8");
  return root;
}

function baseRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "scope-target-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "review@test.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Review test"], { cwd: root });
  writeFileSync(join(root, "base.txt"), "base\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
  return root;
}

/**
 * Console renders the operator facts as a wrapped ` · `-joined strip inside a
 * bordered pane, so a fact's text routinely spans several rendered lines. Strip
 * the pane borders and collapse whitespace so an assertion can match the fact's
 * logical content rather than whichever column it happened to break at.
 */
function flatten(text: string): string {
  return text.replaceAll("│", " ").replace(/\s+/gu, " ");
}

async function settle(ms = 80): Promise<void> { await new Promise((resolve) => setTimeout(resolve, ms)); }

/**
 * Deadline-bounded poll for flattened rendered content. A fixed delay before a
 * content assertion reads the frame before the real `runTui` has progressed
 * once the 300+ file suite contends for workers; this waits for the SAME
 * content the assertion then requires. `expect.poll` above covers the startup
 * transitions; this covers the post-startup keystroke round trips.
 */
async function waitFor(read: () => string, needle: string, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!read().includes(needle)) {
    if (Date.now() > deadline) throw new Error(`${label}: ${JSON.stringify(needle)} never rendered\n${read().slice(-1200)}`);
    await settle(20);
  }
}

describe("Console result adoption — stale file-selection state across a superseding capture", () => {
  let tempDir = "";
  let worktreeA = "";
  let worktreeB = "";
  afterEach(() => {
    clearRegisteredScreens();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    if (worktreeA) rmSync(worktreeA, { recursive: true, force: true });
    if (worktreeB) rmSync(worktreeB, { recursive: true, force: true });
  });

  it("clears a prior capture's selected-file adoption state once a higher-ranked capture supersedes it", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arbor-tui-stale-selection-"));
    const persistenceDir = resolvePersistenceDir(tempDir);
    worktreeA = repo("a.txt", "capture A\n");

    const seed = new ArborRuntime({ persistence_dir: persistenceDir, devtools_logger: { persistence_dir: persistenceDir, disable_fsync: true } });
    await seed.start();
    seed.manager.startCampaign("cmp-stale", "plan.md", rootAction);
    const captureA = captureWorktreeResult({ campaign_id: "cmp-stale", node_id: "node-a", worktree_path: worktreeA, verified: true, score: 1, persistence_dir: persistenceDir });
    expect(captureA).not.toBeNull();
    await seed.close();

    const stdin = new PassThrough();
    let out = "";
    const stdout = new PassThrough(); stdout.on("data", (d: Buffer) => { out += d.toString(); });
    Object.assign(stdout, { rows: 30, columns: 110, isTTY: false });
    const stderr = new PassThrough(); stderr.on("data", () => {});

    const donePromise = runTui({ cwd: tempDir, stdin, stdout, stderr, resume: true, frame_interval_ms: 10 });
    try {
      // Explicitly resume the seeded result and wait for its real projection.
      await expect.poll(() => flatten(stripAnsi(out)), { timeout: 15_000 }).toContain("node node-a");
      const beforeBlur = out.length;
      stdin.write("\u001b");
      await expect.poll(() => flatten(stripAnsi(out.slice(beforeBlur))), { timeout: 5_000 }).toContain("Enter focus");

      // Select node-a's file for adoption ('S' -> type the exact captured path -> Enter).
      const read = (): string => flatten(stripAnsi(out));
      stdin.write("S"); await settle(100);
      stdin.write("a.txt"); await settle(100);
      stdin.write("\r");
      await waitFor(read, "A confirm selected-file adoption", "selecting node-a's file did not arm adoption");
      expect(read()).toContain("A confirm selected-file adoption");

      // A second, higher-scored capture for the SAME campaign supersedes node-a
      // — the operator never touches S/A again for it.
      worktreeB = repo("b.txt", "capture B\n");
      const captureB = captureWorktreeResult({ campaign_id: "cmp-stale", node_id: "node-b", worktree_path: worktreeB, verified: true, score: 2, persistence_dir: persistenceDir });
      expect(captureB).not.toBeNull();

      // Force a fresh product-surface refresh — the same real round trip a
      // screen-focus transition always issues. "`" re-focuses Console.
      stdin.write("`");
      // Wait on the LAST "Controls:" window, per this file's own header note
      // that the renderer only re-emits a changed line: everything after the
      // final stale hint is the post-supersede frame, so the assertions below
      // read a settled render rather than whatever 600ms happened to catch.
      const postStaleWindow = (): string => {
        const flat = read();
        const stale = flat.lastIndexOf("A confirm selected-file adoption");
        return stale === -1 ? "" : flat.slice(stale);
      };
      await expect.poll(postStaleWindow, { timeout: 30_000 }).toContain("node node-b");
      await expect.poll(postStaleWindow, { timeout: 30_000 }).toContain("A arm adoption");
      const finalText = stripAnsi(out);

      // node-b is now the ranked capture...
      expect(flatten(finalText)).toContain("node node-b");
      // ...but the operator never selected any files for it: the control hint
      // must not still claim a file selection is armed for it.
      expect(flatten(finalText)).toContain("A arm adoption");
    } finally {
      stdin.end();
    }
    const code = await donePromise;
    expect(code).toBe(0);
  }, 90_000);
});

describe("Console result adoption — governed scope expansion", () => {
  let target = "";
  let worktree = "";
  afterEach(() => {
    clearRegisteredScreens();
    if (target) rmSync(target, { recursive: true, force: true });
    if (worktree) rmSync(worktree, { recursive: true, force: true });
  });

  it("records an exact scope authorization before separately adopting the same patch", async () => {
    target = baseRepo();
    const persistenceDir = resolvePersistenceDir(target);
    worktree = repo("generated.txt", "governed output\n");

    const seed = new ArborRuntime({ persistence_dir: persistenceDir, devtools_logger: { persistence_dir: persistenceDir, disable_fsync: true } });
    await seed.start();
    seed.manager.startCampaign("cmp-scope", "plan.md", rootAction);
    const capture = captureWorktreeResult({
      campaign_id: "cmp-scope",
      node_id: "root",
      worktree_path: worktree,
      verified: true,
      score: 1,
      declared_write_paths: ["declared-only.txt"],
      persistence_dir: persistenceDir,
    });
    expect(capture).toMatchObject({ verified: false, command_verified: true, scope_violations: ["generated.txt"] });
    await seed.close();

    const stdin = new PassThrough();
    let out = "";
    const stdout = new PassThrough(); stdout.on("data", (d: Buffer) => { out += d.toString(); });
    Object.assign(stdout, { rows: 30, columns: 110, isTTY: false });
    const stderr = new PassThrough(); stderr.on("data", () => {});

    const donePromise = runTui({ cwd: target, stdin, stdout, stderr, resume: true, frame_interval_ms: 10 });
    try {
      await expect.poll(() => flatten(stripAnsi(out)), { timeout: 15_000 }).toContain("A arm exact scope authorization");
      const beforeBlur = out.length;
      stdin.write("\u001b");
      await expect.poll(() => flatten(stripAnsi(out.slice(beforeBlur))), { timeout: 5_000 }).toContain("Enter focus");

      const read = (): string => flatten(stripAnsi(out));
      stdin.write("A");
      await waitFor(read, "Confirm authorization of exactly generated.txt with A", "scope authorization did not confirm");
      expect(read()).toContain("Confirm authorization of exactly generated.txt with A");
      stdin.write("A");
      await waitFor(read, "Scope authorization tui-scope-", "scope authorization was not recorded");
      expect(stripAnsi(out)).toMatch(/Scope authorization tui-scope-[0-9]+ recorded/);

      // Authorization and adoption are deliberately separate confirmations.
      stdin.write("A");
      await waitFor(read, "Confirm adoption with A", "adoption did not ask for its own separate confirmation");
      expect(read()).toContain("Confirm adoption with A");
      stdin.write("A");
      await waitFor(read, "Adoption completed", "adoption did not complete");
      expect(read()).toContain("Adoption completed");
      expect(readFileSync(join(target, "generated.txt"), "utf8")).toBe("governed output\n");
    } finally {
      stdin.end();
    }
    expect(await donePromise).toBe(0);
  }, 90_000);
});
