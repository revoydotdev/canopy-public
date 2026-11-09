/**
 * arbor-eval/tests/live-verification — proves O3 (ADR-095): `verified`
 * provenance is produced ONLY when the command actually ran and exited 0.
 * `runVerificationCommand` spawns a real process (no mocking of
 * `child_process`); only the command text itself is a small fixture.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVerificationCommand, verifiedProvenanceFromRun } from "../src/live-verification.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "arbor-live-verification-"));
  dirs.push(dir);
  return dir;
}

describe("runVerificationCommand", () => {
  it("runs a real command and content-hashes its real stdout", () => {
    const dir = fixtureDir();
    const result = runVerificationCommand({ cmd: process.execPath, args: ["-e", "console.log('hello verification')"], cwd: dir });
    expect(result.ran).toBe(true);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("hello verification\n");
    expect(result.stdout_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    // The hash is a real digest of the real bytes, not a fixed string.
    const other = runVerificationCommand({ cmd: process.execPath, args: ["-e", "console.log('different output')"], cwd: dir });
    expect(other.stdout_hash).not.toBe(result.stdout_hash);
  });

  it("records a real non-zero exit without fabricating success", () => {
    const dir = fixtureDir();
    const result = runVerificationCommand({ cmd: process.execPath, args: ["-e", "process.exit(7)"], cwd: dir });
    expect(result.ran).toBe(true);
    expect(result.exit_code).toBe(7);
  });

  it("reports ran:false and a spawn_error when the command cannot be spawned at all", () => {
    const dir = fixtureDir();
    const result = runVerificationCommand({ cmd: "arbor-eval-does-not-exist-binary", args: [], cwd: dir });
    expect(result.ran).toBe(false);
    expect(result.exit_code).toBeNull();
    expect(result.stdout_hash).toBeNull();
    expect(result.spawn_error).not.toBeNull();
  });
});

describe("verifiedProvenanceFromRun — O3: verified only when the command genuinely ran and hashed", () => {
  it("produces a verified Provenance with a real cmd/exit/stdout_hash when the command ran and exited 0", () => {
    const dir = fixtureDir();
    const run = runVerificationCommand({ cmd: process.execPath, args: ["-e", "console.log('ok')"], cwd: dir });
    const provenance = verifiedProvenanceFromRun(run);
    expect(provenance).toMatchObject({ tag: "verified", exit: 0, stdout_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) });
    expect(provenance?.tag === "verified" && provenance.stdout_hash).toBe(run.stdout_hash);
  });

  it("refuses to produce verified provenance when the command ran but exited non-zero", () => {
    const dir = fixtureDir();
    const run = runVerificationCommand({ cmd: process.execPath, args: ["-e", "process.exit(1)"], cwd: dir });
    expect(verifiedProvenanceFromRun(run)).toBeNull();
  });

  it("refuses to produce verified provenance when the command never ran at all", () => {
    const dir = fixtureDir();
    const run = runVerificationCommand({ cmd: "arbor-eval-does-not-exist-binary", args: [], cwd: dir });
    expect(verifiedProvenanceFromRun(run)).toBeNull();
  });
});

describe("verifiedProvenanceFromRun — ADR-134 O3: breadth is caller-declared, never a hardcoded constant", () => {
  it("carries no check field at all when the caller declares no breadth — honest 'scope unknown', not a guess", () => {
    const dir = fixtureDir();
    const run = runVerificationCommand({ cmd: process.execPath, args: ["-e", "console.log('ok')"], cwd: dir });
    const provenance = verifiedProvenanceFromRun(run);
    expect(provenance?.tag === "verified" && provenance.check).toBeUndefined();
  });

  it("threads the caller's declared breadth into check.breadth verbatim", () => {
    const dir = fixtureDir();
    const run = runVerificationCommand({ cmd: process.execPath, args: ["-e", "console.log('ok')"], cwd: dir });
    const suiteProvenance = verifiedProvenanceFromRun(run, "suite");
    expect(suiteProvenance?.tag === "verified" && suiteProvenance.check).toEqual({ kind: "shell_command", breadth: "suite" });
    const subsetProvenance = verifiedProvenanceFromRun(run, "subset");
    expect(subsetProvenance?.tag === "verified" && subsetProvenance.check).toEqual({ kind: "shell_command", breadth: "subset" });
  });
});

describe("runVerificationCommand — ADR-133 §1: real wall-clock duration capture", () => {
  it("measures a positive real duration around the spawnSync call, distinct across a slower command", () => {
    const dir = fixtureDir();
    const fast = runVerificationCommand({ cmd: process.execPath, args: ["-e", "0"], cwd: dir });
    expect(fast.duration_ms).toBeGreaterThanOrEqual(0);
    const slow = runVerificationCommand({ cmd: process.execPath, args: ["-e", "const s=Date.now(); while(Date.now()-s<80){}"], cwd: dir });
    expect(slow.duration_ms).toBeGreaterThanOrEqual(70);
  });

  it("still reports a real duration even when the command cannot be spawned at all", () => {
    const dir = fixtureDir();
    const result = runVerificationCommand({ cmd: "arbor-eval-does-not-exist-binary", args: [], cwd: dir });
    expect(result.ran).toBe(false);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });
});
