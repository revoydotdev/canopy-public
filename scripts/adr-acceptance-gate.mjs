#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkAdrAcceptance } from "./lib/adr-acceptance.mjs";
import { evidenceTransactionReadStatus } from "./evidence-transaction.mjs";
import { assertGovernanceConsumerReady } from "./lib/governance-plan.mjs";

const REPO = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));

// `--repo` is a fixture seam only (see `guard:canaries`): `checkAdrAcceptance`
// already took `repo` as a parameter, so pointing it at a throwaway corpus is a
// one-line change here. The `--repo` VALUE is excluded from the positional
// revision scan below, or it would be read as the revision. Absent the flag,
// unchanged.
function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

export function main(args = process.argv.slice(2)) {
  const staged = args.includes("--staged");
  const json = args.includes("--json");
  const repoArg = argValue(args, "--repo");
  const repo = repoArg ? resolve(repoArg) : REPO;
  const revision = args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--repo") ?? "HEAD";
  let result;
  try {
    assertGovernanceConsumerReady({ consumer: "adr-acceptance", evidenceStatus: evidenceTransactionReadStatus({ repo }) });
    result = checkAdrAcceptance({ repo, revision, staged });
  } catch (error) {
    result = { ok: false, inspected: [], violations: [{ code: error && typeof error === "object" && "code" in error ? error.code : "consumer_precondition", path: "governance evidence", commit: "working tree", message: error instanceof Error ? error.message : String(error) }] };
  }
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (result.ok) console.log(`[adr-acceptance] PASS — inspected ${result.inspected.length} ${staged ? "staged snapshot" : "commit(s)"}`);
  else {
    for (const violation of result.violations) console.error(`[adr-acceptance] FAIL ${violation.path} (${violation.commit}): ${violation.message}`);
  }
  return result.ok ? 0 : 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) process.exitCode = main();
