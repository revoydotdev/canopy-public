import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runDecisionsGate } from "../decisions-precommit-gate.mjs";

/**
 * X-4 (fixes D4, narrowly): a commit touching decisions/ must pass
 * `verifyRegistry`, or be bypassed with a LOGGED escape hatch. Driven against
 * a real throwaway git repo — `git diff --cached` and `git rev-parse` are the
 * real commands, not mocks. `runDecisionsGate` accepts `repoRoot`/`env`/`log`
 * so the real logic is testable without a real `git commit` or a real HEAD.
 */
let repo;

function git(...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function write(path, text) {
  const absolute = join(repo, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "decisions-gate-"));
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: repo });
  git("config", "user.email", "gate@test.invalid");
  git("config", "user.name", "Gate Test");
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

function validRegistry() {
  return JSON.stringify({ schema_version: 1, next_available: 44, reserved: [], reserved_reason: {}, allocations: [] }, null, 2);
}

describe("decisions-precommit-gate — runDecisionsGate", () => {
  it("is a no-op for a commit that does not touch decisions/", () => {
    write("README.md", "hello\n");
    write("decisions/registry.json", "{ not valid json");
    git("add", "README.md");
    const result = runDecisionsGate({ repoRoot: repo, log: () => {} });
    expect(result).toEqual({ ok: true, skipped: true });
  });

  it("blocks a decisions-touching commit when verify fails", () => {
    write("decisions/registry.json", validRegistry());
    git("add", "decisions/registry.json");
    // Break the registry: next_available already reserved, so verifyRegistry fails.
    write("decisions/registry.json", JSON.stringify({ schema_version: 1, next_available: 44, reserved: [44], reserved_reason: { 44: "x" }, allocations: [] }, null, 2));
    git("add", "decisions/registry.json");
    const lines = [];
    const result = runDecisionsGate({ repoRoot: repo, log: (line) => lines.push(line) });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/next_available is already reserved/);
    expect(lines.join("\n")).toMatch(/BLOCKED/);
  });

  it("passes through a decisions-touching commit when verify succeeds", () => {
    write("decisions/registry.json", validRegistry());
    write("decisions/README.md", "# ADR Index\n");
    git("add", "decisions/");
    const result = runDecisionsGate({ repoRoot: repo, log: () => {} });
    expect(result.ok).toBe(true);
  });

  it("ARBOR_SKIP_DECISION_GATE=1 bypasses a failing verify AND logs the bypass", () => {
    write("decisions/registry.json", JSON.stringify({ schema_version: 1, next_available: 44, reserved: [44], reserved_reason: { 44: "x" }, allocations: [] }, null, 2));
    git("add", "decisions/registry.json");
    git("commit", "-q", "-m", "base");
    write("decisions/README.md", "# ADR Index\n");
    git("add", "decisions/README.md");

    const livenessLog = join(repo, ".hook-liveness", "invocations.jsonl");
    const lines = [];
    const result = runDecisionsGate({ repoRoot: repo, livenessLog, env: { ARBOR_SKIP_DECISION_GATE: "1" }, log: (line) => lines.push(line) });

    expect(result).toMatchObject({ ok: true, bypassed: true, staged_decision_paths: ["decisions/README.md"] });
    expect(lines.join("\n")).toMatch(/ARBOR_SKIP_DECISION_GATE=1/);

    expect(existsSync(livenessLog)).toBe(true);
    const record = JSON.parse(readFileSync(livenessLog, "utf8").trim().split("\n").pop());
    expect(record.hook_id).toBe("decisions-precommit-gate");
    expect(record.bypass).toBe(true);
    expect(record.head_sha).toBe(git("rev-parse", "HEAD"));
    expect(record.staged_decision_paths).toEqual(["decisions/README.md"]);
    expect(typeof record.at_epoch).toBe("number");
  });

  it("never appends to the liveness log when the bypass is not used", () => {
    write("decisions/registry.json", validRegistry());
    write("decisions/README.md", "# ADR Index\n");
    git("add", "decisions/");
    const livenessLog = join(repo, ".hook-liveness", "invocations.jsonl");
    runDecisionsGate({ repoRoot: repo, livenessLog, log: () => {} });
    expect(existsSync(livenessLog)).toBe(false);
  });
});
