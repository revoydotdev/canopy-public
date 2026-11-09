#!/usr/bin/env bun
/** Launch only the version named by the host-owned verified release state. */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { activeReleaseVersion } from "../../packages/arbor-mcp/src/distribution.ts";

const [channel, stateDir, installRoot, ...args] = process.argv.slice(2);
if ((channel !== "stable" && channel !== "beta") || !stateDir || !installRoot) throw new Error("usage: bun scripts/distribution/launch.mjs <stable|beta> <state-dir> <install-root> [arbor arguments...]");
const root = realpathSync(resolve(installRoot)); const version = activeReleaseVersion(resolve(stateDir), channel);
if (version === null) throw new Error("no verified release is active");
const release = realpathSync(join(root, "releases", version)); const escaped = relative(root, release);
if (escaped.startsWith("..") || resolve(root, escaped) !== release || lstatSync(release).isSymbolicLink()) throw new Error("active release path escapes the install root");
const entry = join(release, "packages", "arbor-mcp", "bin", "arbor-mcp.mjs");
if (!existsSync(entry) || !lstatSync(entry).isFile() || lstatSync(entry).isSymbolicLink()) throw new Error("active release launcher is missing or unsafe");
const child = spawnSync("bun", [entry, ...args], { stdio: "inherit" });
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
