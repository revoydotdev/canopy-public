#!/usr/bin/env bun
/**
 * Cross-platform process smoke for the on-demand Windows and macOS runners.
 * This stays smaller than the Linux correctness/coverage lanes: its job is to
 * expose host assumptions in the shipped CLI boundary.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(repoRoot, "packages", "arbor-mcp", "bin", "arbor-mcp.mjs");
const expectedIndex = process.argv.indexOf("--expect-platform");
const expectedPlatform = expectedIndex >= 0 ? process.argv[expectedIndex + 1] : undefined;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function runBun(args, cwd = repoRoot) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env },
  });
  if (result.error) throw result.error;
  if (result.signal !== null) throw new Error(`process terminated by ${result.signal}: ${args.join(" ")}`);
  return result;
}

if (expectedPlatform !== undefined) {
  check(["win32", "darwin", "linux"].includes(expectedPlatform), `unsupported expected platform: ${expectedPlatform}`);
  check(process.platform === expectedPlatform, `runner platform mismatch: expected ${expectedPlatform}, received ${process.platform}`);
}

const version = runBun([launcher, "--version"]);
check(version.status === 0, `arbor --version exited ${version.status}: ${version.stderr}`);
check(/^arbor \d+\.\d+\.\d+\r?\n$/.test(version.stdout), `unexpected version output: ${JSON.stringify(version.stdout)}`);

const help = runBun([launcher, "--help"]);
check(help.status === 0, `arbor --help exited ${help.status}: ${help.stderr}`);
check(help.stderr === "", `arbor --help wrote stderr: ${help.stderr}`);
check(help.stdout.includes("Usage: arbor <command> [options]"), "arbor help omitted the primary usage line");

const child = runBun(["--eval", "process.stdout.write(JSON.stringify({child:true,platform:process.platform}))"]);
check(child.status === 0, `Bun child process exited ${child.status}: ${child.stderr}`);
check(JSON.parse(child.stdout).platform === process.platform, "child process observed a different platform");

const projectRoot = mkdtempSync(join(tmpdir(), "arbor-platform-smoke-"));
try {
  const first = runBun([launcher, "setup", "--json"], projectRoot);
  check(first.status === 0, `arbor setup exited ${first.status}: ${first.stderr}`);
  const created = JSON.parse(first.stdout);
  check(created.files.every((file) => file.disposition === "created"), "first setup did not create every missing file");
  check(existsSync(join(projectRoot, ".env")), "setup did not create .env");
  check(existsSync(join(projectRoot, "arbor.jsonc")), "setup did not create arbor.jsonc");
  check(readFileSync(join(projectRoot, ".env"), "utf8").includes("OPENROUTER_API_KEY"), ".env omitted provider-key scaffolding");

  const second = runBun([launcher, "setup", "--json"], projectRoot);
  check(second.status === 0, `second arbor setup exited ${second.status}: ${second.stderr}`);
  check(JSON.parse(second.stdout).files.every((file) => file.disposition === "preserved"), "idempotent setup did not preserve existing files");
} finally {
  rmSync(projectRoot, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  platform: process.platform,
  arch: process.arch,
  bun: process.versions.bun,
  cli: version.stdout.trim(),
})}\n`);
