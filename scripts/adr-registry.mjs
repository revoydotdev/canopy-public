#!/usr/bin/env node
import { resolve } from "node:path";
import { acceptDecision, allocateDecision, newPendingDecision, readSharedReservations, verifyRegistry } from "./lib/adr-registry.mjs";

function value(args, flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

const args = process.argv.slice(2);
const command = args[0];
const repo = resolve(value(args, "--repo", process.cwd()));
try {
  const result = command === "verify"
    ? verifyRegistry(repo)
    : command === "allocate"
      ? allocateDecision({ repo, slug: args[1], commit: !args.includes("--no-commit") })
      : command === "new"
        ? newPendingDecision({ repo, slug: args[1], title: value(args, "--title"), status: value(args, "--status", "Proposed") })
        // The shared reservation ledger exists precisely to stop two worktrees
        // claiming the same ADR number, but it had no read path: it was written
        // and pruned internally and could only be inspected by locating and
        // `cat`-ing the file. An operator could not ask the question the
        // mechanism exists to answer.
        : command === "accept"
          ? acceptDecision({ repo, number: args[1], reject: args.includes("--reject"), commit: !args.includes("--no-commit") })
        : command === "supersede"
          ? acceptDecision({ repo, number: args[1], supersededBy: args[args.indexOf("--by") + 1] ?? null, commit: !args.includes("--no-commit") })
          : command === "reservations"
            ? { ok: true, reservations: readSharedReservations(repo) }
            : { ok: false, error: 'usage: adr-registry.mjs <new SLUG --title "…" [--status Proposed] | verify | allocate SLUG | accept NUMBER [--reject] | supersede NUMBER --by NUMBER | reservations> [--repo PATH] [--no-commit]' };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}
