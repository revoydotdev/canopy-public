#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { planBranches, readHandoffMetadata } from "./lib/conductor/graph.mjs";
import { landBranch } from "./lib/conductor/land.mjs";
import { regenerateStores } from "./lib/conductor/stores.mjs";
import { allocateDecision } from "./lib/adr-registry.mjs";
import { readIntegrationContract } from "./trunk-preflight.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function value(args, flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

function usage() {
  console.error("usage: integration-conductor.mjs <plan|land|renumber|regenerate-stores> [options]");
  console.error("  plan [--repo PATH] --trunk REF [--json] BRANCH...");
  console.error("  land [--repo PATH] --trunk REF [--scratch PATH] [--accept-manual-resolution] BRANCH");
  console.error("  renumber [--repo PATH] BRANCH");
  console.error("  regenerate-stores [--repo PATH]");
}

export function main(args = process.argv.slice(2)) {
  const subcommand = args[0];
  const repo = resolve(value(args, "--repo", join(SCRIPT_DIR, "..")));
  const trunk = value(args, "--trunk", null) ?? (subcommand === "plan" || subcommand === "land" ? readIntegrationContract(repo).trunk_ref : null);
  let result;
  if (subcommand === "plan") {
    const branches = args.slice(1).filter((arg, index, all) => !arg.startsWith("--") && all[index - 1] !== "--repo" && all[index - 1] !== "--trunk");
    result = planBranches({ repo, trunk, branches });
  } else if (subcommand === "land") {
    const branch = args.slice(1).find((arg, index, all) => !arg.startsWith("--") && all[index] !== value(args, "--repo", null) && all[index] !== value(args, "--trunk", null) && all[index] !== value(args, "--scratch", null));
    if (!branch) throw new Error("land requires a branch");
    const metadata = readHandoffMetadata(repo, branch);
    result = landBranch({ repo, trunk, branch, declaredBase: metadata.declared_base, scratchRoot: value(args, "--scratch", undefined), acceptManualResolution: args.includes("--accept-manual-resolution") });
  } else if (subcommand === "renumber") {
    const slug = args.slice(1).find((arg, index, all) => !arg.startsWith("--") && all[index] !== value(args, "--repo", null));
    if (!slug) throw new Error("renumber requires a pending ADR slug");
    result = allocateDecision({ repo, slug, commit: !args.includes("--no-commit") });
  } else if (subcommand === "regenerate-stores") {
    result = regenerateStores(repo);
  } else {
    usage();
    return 2;
  }
  console.log(JSON.stringify(result, null, args.includes("--json") ? 2 : 2));
  return result.ok === false ? 1 : 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}
