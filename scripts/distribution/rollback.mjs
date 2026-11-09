#!/usr/bin/env bun
/** Roll back the active channel only to its previously verified release. */
import { resolve } from "node:path";
import { loadReleaseTrustStore, rollbackVerifiedRelease } from "../../packages/arbor-mcp/src/distribution.ts";

const [channel, stateDir] = process.argv.slice(2);
if ((channel !== "stable" && channel !== "beta") || !stateDir) throw new Error("usage: bun scripts/distribution/rollback.mjs <stable|beta> <state-dir>");
const state = resolve(stateDir);
const result = rollbackVerifiedRelease({ state_dir: state, channel, trust_roots: loadReleaseTrustStore(state) });
process.stdout.write(`Rolled back Revoy ${channel} to verified ${result.version}\n`);
