#!/usr/bin/env node
/**
 * scripts/adr-claim.mjs — CLI over the advisory claim ledger (`scripts/lib/adr-claims.mjs`).
 *
 * Usage:
 *   bun scripts/adr-claim.mjs claim <ADR...> [--holder NAME] [--repo PATH] [--json]
 *   bun scripts/adr-claim.mjs release [--holder NAME] [--repo PATH] [--json]
 *   bun scripts/adr-claim.mjs list [--repo PATH] [--json]
 *
 * This is a claim, not a lock: `claim` never refuses an ADR already claimed by
 * someone else (see the library header for why), and nothing in this CLI
 * blocks a write anywhere in the repository. It only records and reports.
 */

import { claimAdrs, releaseClaim, activeClaims } from "./lib/adr-claims.mjs";
import { hostname } from "node:os";
import { resolve } from "node:path";

function value(args, flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

/**
 * Default holder identity: worktree-relative path + host + pid, in the same
 * spirit as worktree-hygiene.mjs's lock-reason convention
 * ("claude session <name> (pid N start M)") — a human can tell which
 * checkout and which live process made the claim without extra lookup.
 * Overridable with `--holder` so a session can name itself explicitly
 * ("AGENT-B") when that is more useful than the mechanical default.
 */
function defaultHolder(repo) {
  const base = repo.split("/").filter(Boolean).pop() ?? repo;
  return `${base}@${hostname()}#${process.pid}`;
}

const args = process.argv.slice(2);
const command = args[0];
const repo = resolve(value(args, "--repo", process.cwd()));
const jsonMode = args.includes("--json");
const holder = value(args, "--holder", defaultHolder(repo));

/** Flags that consume the following token as their value, so positional ADR
 * numbers can be told apart from flag arguments regardless of order. */
const VALUE_FLAGS = new Set(["--holder", "--repo"]);

function adrNumbers(rest) {
  const numbers = [];
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token.startsWith("--")) {
      if (VALUE_FLAGS.has(token)) i++; // skip its value too
      continue;
    }
    numbers.push(Number(token));
  }
  return numbers;
}

function print(result) {
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "claim") {
    console.log(`claimed ${result.adrs.map((n) => `ADR-${String(n).padStart(3, "0")}`).join(", ")} as "${result.holder}"`);
  } else if (command === "release") {
    console.log(result.released.length === 0
      ? `no claims recorded for "${result.holder}" — nothing to release`
      : `released ${result.released.length} claim(s) held by "${result.holder}": ${result.released.map((e) => `ADR-${String(e.adr).padStart(3, "0")}`).join(", ")}`);
  } else if (command === "list") {
    if (result.length === 0) {
      console.log("no active claims");
    } else {
      for (const entry of result) {
        const age = Math.round((Date.now() - entry.at) / 1000);
        const liveness = entry.pid_alive === null ? "unknown" : entry.pid_alive ? "alive" : "DEAD";
        console.log(`ADR-${String(entry.adr).padStart(3, "0")}  ${entry.holder}  pid=${entry.pid ?? "?"} (${liveness})  claimed ${age}s ago`);
      }
    }
  }
}

try {
  let result;
  if (command === "claim") {
    result = claimAdrs({ repo, adrs: adrNumbers(args.slice(1)), holder });
  } else if (command === "release") {
    result = releaseClaim({ repo, holder });
  } else if (command === "list") {
    result = activeClaims({ repo });
  } else {
    console.error('usage: adr-claim.mjs <claim ADR... | release | list> [--holder NAME] [--repo PATH] [--json]');
    process.exitCode = 2;
    process.exit();
  }
  print(result);
  process.exitCode = 0;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (jsonMode) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  else console.error(`adr-claim: ${message}`);
  process.exitCode = 1;
}
