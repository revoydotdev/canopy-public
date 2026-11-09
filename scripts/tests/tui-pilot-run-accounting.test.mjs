/**
 * scripts/tests/tui-pilot-run-accounting.test.mjs — pilot.mjs's run-integrity
 * decisions (A07/A09/A10 remediation), exercised as pure functions so no pty
 * is spawned.
 *
 * A07/A09: the step loop can break early (budget exhausted, session exited)
 * leaving declared steps unrun; `computeStepAccounting` must say so, and
 * `isIncompleteScenarioFailure` must fail the run UNLESS the scenario itself
 * declared the early exit as its expected contract (early_exit_expected).
 * Budget exhaustion is never exempt — under-budgeting is a pilot defect, not
 * a property of the scenario. `clampToDeadline` is what keeps a single
 * step's wait/hold from overrunning the whole --budget-s.
 *
 * A10: `scanPublishableStreams` scans a name -> text map of every publishable
 * stream and turns a scan error into a hard `ok: false` rather than a
 * silently-recorded note. `exportRunArtifacts` is the export gate itself: it
 * scans frame text, the asciicast, the seed record, AND the receipt as one
 * set before anything is written, and on failure withholds every one of
 * them — frames are deleted, stream.cast/seed.json are never written, and
 * receipt.json is replaced by a scrubbed `buildFailureReceipt` that carries
 * no typed input, no event_log detail, and no seed. The disk-level test
 * below is the actual audit fix: it proves a secret in typed input (the
 * exact shape of `record.actions.push({ type: step.type })`) does not
 * survive on disk in ANY artifact after a failed scan, by asserting on the
 * run directory's real contents — not on a return value.
 */
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildFailureReceipt, buildWaitPattern, classifyWaitResult, clampToDeadline, computeStepAccounting, exportRunArtifacts, isIncompleteScenarioFailure, scanPublishableStreams } from "../tui-pilot/pilot.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "tui-pilot-export-")); roots.push(dir); return dir; };

describe("clampToDeadline — one deadline for the whole run", () => {
  it("passes a request through when the deadline has plenty of room", () => {
    expect(clampToDeadline(5000, 1000, 600_000)).toBe(5000);
  });

  it("clamps a request that would overrun the remaining budget", () => {
    expect(clampToDeadline(5000, 598_000, 600_000)).toBe(2000);
  });

  it("never returns negative — a budget already exhausted clamps to zero, not a negative timeout", () => {
    expect(clampToDeadline(5000, 601_000, 600_000)).toBe(0);
  });
});

describe("computeStepAccounting — explicit unexecuted-step accounting", () => {
  it("records no skip and no break reason when every declared step ran", () => {
    expect(computeStepAccounting({ declaredSteps: 5, executedSteps: 5, breakReason: null }))
      .toEqual({ declared_steps: 5, executed_steps: 5, skipped_steps: 0, break_reason: null });
  });

  it("records the skip count and break reason when the loop broke early", () => {
    expect(computeStepAccounting({ declaredSteps: 12, executedSteps: 2, breakReason: "budget-exhausted" }))
      .toEqual({ declared_steps: 12, executed_steps: 2, skipped_steps: 10, break_reason: "budget-exhausted" });
  });

  it("suppresses a stale break reason once every step actually ran", () => {
    // executedSteps caught up to declaredSteps in the same tick the deadline
    // check would have fired — skipped is 0, so break_reason reads null even
    // if a caller passed one through.
    expect(computeStepAccounting({ declaredSteps: 3, executedSteps: 3, breakReason: "session-exited" }).break_reason).toBeNull();
  });
});

describe("isIncompleteScenarioFailure — a crash-expecting scenario is a different contract", () => {
  it("a fully executed scenario is never a failure", () => {
    expect(isIncompleteScenarioFailure({ skippedSteps: 0, breakReason: null, earlyExitExpected: false })).toBe(false);
    expect(isIncompleteScenarioFailure({ skippedSteps: 0, breakReason: null, earlyExitExpected: true })).toBe(false);
  });

  it("budget exhaustion always fails, even for a scenario that expects an early exit", () => {
    expect(isIncompleteScenarioFailure({ skippedSteps: 1, breakReason: "budget-exhausted", earlyExitExpected: true })).toBe(true);
  });

  it("an undeclared session exit with steps unrun fails (lifecycle-plan.json's default contract)", () => {
    expect(isIncompleteScenarioFailure({ skippedSteps: 10, breakReason: "session-exited", earlyExitExpected: false })).toBe(true);
  });

  it("a declared early exit with steps unrun is not a failure (degraded-badconfig.json's contract)", () => {
    expect(isIncompleteScenarioFailure({ skippedSteps: 1, breakReason: "session-exited", earlyExitExpected: true })).toBe(false);
  });
});

describe("scanPublishableStreams — a stream set, not two hardcoded arguments", () => {
  it("passes when every named stream is clean", () => {
    const result = scanPublishableStreams({ frames: "no campaigns\n", "stream.cast": '[[0,"o","hello"]]\n', "receipt.json": "{}", "seed.json": "{}" });
    expect(result).toEqual({ ok: true, error: null, failures: [] });
  });

  it("fails on a secret in the frame text even when everything else is clean", () => {
    const result = scanPublishableStreams({ frames: "ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnop", "stream.cast": "clean" });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([{ stream: "frames", error: expect.stringContaining("frames") }]);
  });

  it("fails on a secret in the cast stream even when the frame text is clean", () => {
    const result = scanPublishableStreams({ frames: "clean", "stream.cast": "AKIAABCDEFGHIJKLMNOP" });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([{ stream: "stream.cast", error: expect.stringContaining("stream.cast") }]);
  });

  it("fails on a secret that only appears in the receipt's own serialized bytes", () => {
    // This is the case the audit caught: typed input lands in
    // steps[].actions[].type, which is only present in the receipt, not in
    // the frame text or the cast.
    const receiptText = JSON.stringify({ steps: [{ actions: [{ type: "export ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnop" }] }] });
    const result = scanPublishableStreams({ frames: "clean", "stream.cast": "clean", "receipt.json": receiptText });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([{ stream: "receipt.json", error: expect.stringContaining("receipt.json") }]);
  });

  it("reports every failing stream, not just the first", () => {
    const result = scanPublishableStreams({ frames: "AKIAABCDEFGHIJKLMNOP", "stream.cast": "sk-ant-abcdefghijklmnop" });
    expect(result.failures.map((f) => f.stream).sort()).toEqual(["frames", "stream.cast"]);
  });
});

describe("buildFailureReceipt — only what the scanner is safe to disclose", () => {
  it("carries the scan result and step accounting but none of the run's content", () => {
    const base = {
      kind: "revoy2.tui_pilot", recorded_at: "t", repo_revision: "r", repo_branch: "b", repo_dirty_paths: 0, bun_version: "1",
      scenario: { id: "s" }, geometry: { cols: 80, rows: 24 }, renderer: { requested: "opentui" }, interval_ms: 250,
      exit_code: 0, duration_ms: 100, step_accounting: { declared_steps: 3, executed_steps: 3, skipped_steps: 0, break_reason: null },
      // Fields a real receipt carries but a failure receipt must never leak:
      frames: [{ file: "frames/f0000" }], ticks: [{ elapsed_ms: 1 }], steps: [{ actions: [{ type: "sk-ant-leak" }] }], event_log: [{ kind: "type", detail: "sk-ant-leak" }],
    };
    const receipt = buildFailureReceipt({ base, secretScan: { ok: false, error: "boom", failures: [{ stream: "receipt.json", error: "boom" }] }, withheld: ["frames", "stream.cast"] });
    expect(receipt).toMatchObject({ status: "secret_scan_failed", frame_count: 0, tick_count: 0, frames: [], ticks: [], steps: [], step_accounting: base.step_accounting, withheld: ["frames", "stream.cast"] });
    expect(receipt.event_log).toBeUndefined();
    expect(JSON.stringify(receipt)).not.toContain("sk-ant-leak");
  });
});

describe("exportRunArtifacts — nothing a failed scan found survives on disk", () => {
  it("writes stream.cast, seed.json and a full receipt on a clean run", () => {
    const dir = scratch();
    const framesDir = join(dir, "frames");
    mkdirSync(framesDir);
    writeFileSync(join(framesDir, "f0000.txt"), "no campaigns\n");
    const receipt = exportRunArtifacts({
      runDir: dir, framesDir, frameText: "no campaigns\n", cast: '[[0,"o","hello"]]\n', seedText: '{"preset":"greenfield"}\n',
      receiptCore: { kind: "revoy2.tui_pilot", exit_code: 0, step_accounting: { declared_steps: 1, executed_steps: 1, skipped_steps: 0, break_reason: null } },
    });
    expect(receipt.secret_scan.ok).toBe(true);
    expect(existsSync(join(dir, "stream.cast"))).toBe(true);
    expect(existsSync(join(dir, "seed.json"))).toBe(true);
    expect(existsSync(framesDir)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8")).exit_code).toBe(0);
  });

  it("a secret typed as scenario input reaches no artifact on disk after a failed scan", () => {
    // This is the exact shape the audit found: a secret that only shows up
    // in steps[].actions[].type (via receiptCore.steps), not in the frame
    // text or the cast — so the receipt itself must be part of the scan.
    const dir = scratch();
    const framesDir = join(dir, "frames");
    mkdirSync(framesDir);
    writeFileSync(join(framesDir, "f0000.txt"), "clean frame\n");
    const secret = "export ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnop";
    const receiptCore = {
      kind: "revoy2.tui_pilot", exit_code: 0,
      step_accounting: { declared_steps: 1, executed_steps: 1, skipped_steps: 0, break_reason: null },
      steps: [{ index: 0, label: "type the secret", actions: [{ type: secret }] }],
      event_log: [{ elapsed_ms: 0, kind: "type", detail: JSON.stringify(secret) }],
    };
    const receipt = exportRunArtifacts({ runDir: dir, framesDir, frameText: "clean frame\n", cast: "clean cast\n", seedText: '{"preset":"greenfield"}\n', receiptCore });

    // Return value says failure.
    expect(receipt.secret_scan.ok).toBe(false);
    expect(receipt.status).toBe("secret_scan_failed");

    // The actual filesystem is the proof: no cast, no seed, frames gone, and
    // the one file that does exist (receipt.json) does not contain the secret.
    expect(existsSync(join(dir, "stream.cast"))).toBe(false);
    expect(existsSync(join(dir, "seed.json"))).toBe(false);
    expect(existsSync(framesDir)).toBe(false);
    expect(readdirSync(dir)).toEqual(["receipt.json"]);
    const onDisk = readFileSync(join(dir, "receipt.json"), "utf8");
    expect(onDisk).not.toContain(secret);
    expect(onDisk).not.toContain("sk-ant-");
    expect(JSON.parse(onDisk).steps).toEqual([]);
    expect(JSON.parse(onDisk).event_log).toBeUndefined();
  });
});

describe("fail_on — a crash screen is a failed wait, not an arrival (A09)", () => {
  it("watches for both patterns so a crash ends the wait early", () => {
    expect(buildWaitPattern("OUTCOME ·", undefined)).toBe("OUTCOME ·");
    const re = new RegExp(buildWaitPattern("OUTCOME ·|NEEDS YOU ·", "revoy2 crashed"), "iu");
    expect(re.test("revoy2 crashed: boom")).toBe(true);
    expect(re.test("OUTCOME · done")).toBe(true);
  });
  it("classifies a fail_on hit as unmatched even when the combined wait matched", () => {
    expect(classifyWaitResult({ matched: true, snapshot: { text: "revoy2 crashed: boom" } }, "revoy2 crashed")).toEqual({ matched: false, reason: "fail_on" });
    expect(classifyWaitResult({ matched: true, snapshot: { text: "OUTCOME · done" } }, "revoy2 crashed")).toEqual({ matched: true, reason: null });
    expect(classifyWaitResult({ matched: false, reason: "timeout", snapshot: { text: "" } }, "revoy2 crashed")).toEqual({ matched: false, reason: "timeout" });
    expect(classifyWaitResult({ matched: true, snapshot: { text: "revoy2 crashed" } }, undefined)).toEqual({ matched: true, reason: null });
  });
  it("lifecycle-plan no longer accepts the crash screen as a terminal state", () => {
    const scenario = JSON.parse(readFileSync(new URL("../tui-pilot/scenarios/lifecycle-plan.json", import.meta.url), "utf8"));
    const wait = scenario.steps.find((s) => s.label === "terminal or blocked state");
    expect(wait.wait_for).not.toMatch(/crash/iu);
    expect(wait.fail_on).toBe("revoy2 crashed");
  });
});
