/**
 * `arbor interview` (ADR-178) — the governance interview asked through arbor's
 * native human-input port, driven at the real CLI entry (`main`).
 *
 * The CLI runs from this checkout (its scripts/) and governs a throwaway
 * fixture repository through `--repo` (ADR-078); no test touches the real
 * decisions/interviews.jsonl. The operator is a scripted line stream on stdin.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NATIVE_HUMAN_INPUT_EGRESS } from "@arbor/harness";
import { main } from "../src/cli.js";
import { EXIT_CODES } from "../src/exit-codes.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

interface DecisionQueueModule {
  deriveDecisionQueue(input: { repo: string; today?: string }): { over_age: unknown[]; operator_calls: unknown[]; flagged_proposed: unknown[] };
  readInterviews(repo: string): Array<{ held_at: string; covered: unknown[]; outcomes: Record<string, unknown>; note?: string; witness?: unknown }>;
}

const queueModule = (): Promise<DecisionQueueModule> =>
  import(pathToFileURL(join(ROOT, "scripts", "decision-queue.mjs")).href) as Promise<DecisionQueueModule>;

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** The same owed-decision fixture scripts/tests/interview-native.test.mjs uses. */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "arbor-interview-cli-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  mkdirSync(join(dir, "decisions"), { recursive: true });
  mkdirSync(join(dir, "docs/proposals"), { recursive: true });
  mkdirSync(join(dir, "scripts/interview"), { recursive: true });
  mkdirSync(join(dir, ".visual-intelligence/findings"), { recursive: true });
  writeFileSync(join(dir, "decisions/ADR-900-native-egress.md"), "# ADR-900: Native Egress\n\n**Status:** Proposed\n**Date:** 2026-10-01\n");
  writeFileSync(join(dir, "docs/proposals/operator-decisions-2026-09-01.md"), "## D1 — retire the old dashboard\n");
  writeFileSync(join(dir, ".visual-intelligence/findings/findings.jsonl"), "");
  writeFileSync(join(dir, ".visual-intelligence/findings/triage.jsonl"), `${JSON.stringify({ finding_id: "vi:gone", verdict: "false_positive" })}\n`);
  writeFileSync(join(dir, "scripts/interview/baseline.json"), JSON.stringify({ records_historical_through: "2026-08-31" }));
  writeFileSync(join(dir, "decisions/discharge-obligations.jsonl"), "");
  return dir;
}

/** Every file under `dir` (except .git) with its content — what "writes nothing" is checked against. */
function snapshot(dir: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    if (name === ".git") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) Object.assign(out, snapshot(path, `${prefix}${name}/`));
    else out[`${prefix}${name}`] = readFileSync(path, "utf8");
  }
  return out;
}

async function runInterview(args: string[], lines: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdin = new PassThrough();
  stdin.end(lines.map((line) => `${line}\n`).join(""));
  const stdout = new PassThrough(); const stderr = new PassThrough();
  let out = ""; let err = "";
  stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
  stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
  const code = await main(["interview", ...args], { cwd: ROOT, stdin, stdout, stderr, env: process.env });
  return { code, stdout: out, stderr: err };
}

const REPLIES = ["2 — put it in the November slot", "retain deliberately, with the reason: history", "accept"];

describe("arbor interview", () => {
  it("asks the derived pack on the terminal and records the verbatim answers under the native egress", async () => {
    const repo = fixture();
    const { code, stdout, stderr } = await runInterview(["--repo", repo], REPLIES);
    expect(stderr).toBe("");
    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(stdout).toContain("[Op decision]");
    expect(stdout).toMatch(/recorded interview held_at=\d{4}-\d{2}-\d{2}, covered 3 item\(s\)/);

    const queue = await queueModule();
    const rows = queue.readInterviews(repo);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row!.covered.every((id) => typeof id === "string")).toBe(true);
    expect(Object.values(row!.outcomes).every((value) => typeof value === "string")).toBe(true);
    expect(row!.outcomes["operator-decisions-2026-09-01:D1"]).toBe("2 — put it in the November slot");
    // ADR-178: the witness is a structured field on the record, not a line in `note`.
    expect(row!.note).toBeUndefined();
    const witness = row!.witness as { schema_version: number; egress: { channel: string; session_id: string }; pack_digest: string; questions: string[] };
    expect(witness.schema_version).toBe(1);
    expect(witness.questions).toHaveLength(3);
    expect(witness.egress.channel).toBe(NATIVE_HUMAN_INPUT_EGRESS);
    expect(witness.egress.session_id).toMatch(/^arbor-interview-/);
    expect(stdout).toContain(witness.pack_digest);

    const after = queue.deriveDecisionQueue({ repo, today: row!.held_at });
    expect(after.over_age).toEqual([]);
    expect(after.operator_calls).toEqual([]);
    expect(after.flagged_proposed).toEqual([]);
  });

  it("--dry-run asks and validates, prints the payload, and writes nothing", async () => {
    const repo = fixture();
    const before = snapshot(repo);
    const { code, stdout, stderr } = await runInterview(["--dry-run", "--repo", repo], REPLIES);
    expect(stderr).toBe("");
    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(stdout).toContain("\"outcome\": \"2 — put it in the November slot\"");
    expect(stdout).toContain("Dry run: answers validated; nothing recorded.");
    expect(snapshot(repo)).toEqual(before);
    expect(existsSync(join(repo, "decisions/interviews.jsonl"))).toBe(false);
  });

  it("records nothing when the operator ends the interview before answering", async () => {
    const repo = fixture();
    const before = snapshot(repo);
    const { code, stdout } = await runInterview(["--repo", repo], ["q"]);
    expect(code).toBe(EXIT_CODES.PARTIAL);
    expect(stdout).toContain("human input declined: the operator ended the interview");
    expect(stdout).toContain("Nothing answered; nothing recorded.");
    expect(snapshot(repo)).toEqual(before);
  });

  it("refuses an unrecognized argument as a usage error", async () => {
    const { code, stderr } = await runInterview(["--yes"], []);
    expect(code).toBe(EXIT_CODES.USAGE);
    expect(stderr).toContain("unrecognized argument \"--yes\"");
  });
});
