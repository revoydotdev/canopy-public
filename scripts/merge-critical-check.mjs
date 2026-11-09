#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadMergeCriticalRegistry, runMergeCriticalCheck, verifyMergeCriticalRegistry } from "./lib/merge-critical.mjs";

const DEFAULT_REPO = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));

/**
 * `--repo` selects which tree is verified, and is inert when the flag is
 * absent. The registry loader and the verifier below were ALREADY
 * parameterised on `repo`; only this wrapper was hardcoded, so the seam is
 * here and the library is untouched.
 */
function repoRoot(args) {
  const index = args.indexOf("--repo");
  return resolve(index >= 0 && args[index + 1] ? args[index + 1] : DEFAULT_REPO);
}

export function main(args = process.argv.slice(2)) {
  const REPO = repoRoot(args);
  if (args.includes("--verify")) {
    const result = verifyMergeCriticalRegistry(REPO, loadMergeCriticalRegistry(REPO));
    if (!result.ok) for (const error of result.errors) console.error(`[merge-critical] ${error}`);
    else console.log(`[merge-critical] registry valid (${result.properties.length} properties)`);
    return result.ok ? 0 : 1;
  }
  const range = args.find((arg) => !arg.startsWith("--"));
  if (!range) {
    console.error("usage: merge-critical-check.mjs --verify | <base>..<head>");
    return 2;
  }
  const result = runMergeCriticalCheck({ repo: REPO, range, log: (message) => console.log(message) });
  for (const item of result.results) {
    if (item.stdout) process.stdout.write(item.stdout);
    if (item.stderr) process.stderr.write(item.stderr);
  }
  if (!result.ok) console.error(`[merge-critical] ${result.state}`);
  else console.log(`[merge-critical] passed ${result.selected.length} triggered properties`);
  return result.ok ? 0 : 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) process.exitCode = main();
