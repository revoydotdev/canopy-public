#!/usr/bin/env bun
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(repoRoot, "packages", "arbor-mcp", "bin", "arbor-mcp.mjs");

function usage() {
  process.stderr.write("Usage: bun run dev:install [--bin-dir <directory>] [--only arbor|arbor-mcp]\n");
  process.exit(2);
}

let binDir = join(homedir(), ".local", "bin");
let only = null;
for (let index = 0; index < process.argv.slice(2).length; index++) {
  const args = process.argv.slice(2);
  if (args[index] === "--bin-dir" && args[index + 1] && index + 2 <= args.length) {
    binDir = resolve(args[index + 1]);
    index += 1;
    continue;
  }
  if (args[index] === "--only" && args[index + 1] && index + 2 <= args.length && ["arbor", "arbor-mcp"].includes(args[index + 1])) {
    only = args[index + 1];
    index += 1;
    continue;
  }
  usage();
}

if (!existsSync(launcher)) {
  throw new Error(`development launcher is missing: ${launcher}`);
}
mkdirSync(binDir, { recursive: true });

for (const name of (only === null ? ["arbor", "arbor-mcp"] : [only])) {
  const destination = join(binDir, name);
  let stat = null;
  try { stat = lstatSync(destination); } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  if (stat !== null) {
    const linked = stat.isSymbolicLink() ? readlinkSync(destination) : null;
    const resolvedLink = linked === null
      ? null
      : resolve(dirname(destination), linked);
    if (resolvedLink !== launcher) {
      // A checkout that was moved or renamed leaves its dev links behind
      // pointing at a path that no longer exists. `lstatSync` sees the link,
      // `existsSync` does not follow it to a target, so the entry is dangling:
      // it cannot be a working command, only a stale one. Without this branch
      // the refusal below reports a self-inflicted `rm` as the remedy, and the
      // operator has to discover that themselves.
      //
      // Scoped deliberately: only a dangling link whose target is *this
      // repository's launcher filename* is replaced. A dangling link to some
      // other program is still refused -- absence of a target is not evidence
      // of ownership.
      const danglingStaleDevLink = linked !== null
        && !existsSync(destination)
        && basename(resolvedLink) === basename(launcher);
      if (!danglingStaleDevLink) {
        throw new Error(`${destination} already exists and is not this checkout's launcher; refusing to replace it`);
      }
      process.stdout.write(`replacing stale dev link ${destination} -> ${resolvedLink} (target no longer exists)\n`);
      unlinkSync(destination);
    }
  }
  if (!existsSync(destination)) symlinkSync(launcher, destination);
  process.stdout.write(`installed ${destination} -> ${launcher}\n`);
}

const pathEntries = (process.env.PATH ?? "").split(":");
if (!pathEntries.includes(binDir)) {
  process.stdout.write(`note: add ${binDir} to PATH before invoking arbor\n`);
}
