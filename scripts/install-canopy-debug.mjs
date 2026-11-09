#!/usr/bin/env bun
/** Build the current checkout and install its source-bound canopy-debug link. */
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(repo, "packages", "arbor-mcp", "bin", "canopy-debug.mjs");
let binDir = join(homedir(), ".local", "bin");
let skipBuild = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--skip-build") { skipBuild = true; continue; }
  if (args[i] === "--bin-dir" && args[i + 1]) { binDir = resolve(args[++i]); continue; }
  throw new Error("usage: bun run canopy-debug:install [--bin-dir <dir>] [--skip-build]");
}
if (!skipBuild) {
  const result = spawnSync("bun", ["run", "build"], { cwd: repo, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`build failed (${result.status ?? "unknown"})`);
}
mkdirSync(binDir, { recursive: true });
const target = join(binDir, "canopy-debug");
let existing = null;
try { existing = lstatSync(target); } catch (error) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
}
if (existing !== null) {
  const link = existing.isSymbolicLink() ? resolve(dirname(target), readlinkSync(target)) : null;
  if (link !== launcher) {
    if (!existing.isSymbolicLink()) throw new Error(`${target} exists and is not a symlink to this checkout's launcher`);
    unlinkSync(target);
    symlinkSync(launcher, target);
  }
} else symlinkSync(launcher, target);
process.stdout.write(`installed ${target} -> ${launcher}\n`);
