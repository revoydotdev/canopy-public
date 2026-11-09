#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { viProducerChangedPaths } from "./lib/vi-input-binding.mjs";

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

// `--repo` is a fixture seam only (see `guard:canaries`): it points this gate's
// graph-manifest and git reads at a throwaway root so a canary can prove the
// gate is able to fail without triggering a real graph reproduction. Absent the
// flag, behaviour is byte-identical to the previous constant.
const REPO_ROOT = resolve(argValue(process.argv, "--repo") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));

export function selectViPrepushMode(changedPaths) {
  const producerChanges = viProducerChangedPaths(changedPaths);
  return Object.freeze({ mode: producerChanges.length > 0 ? "full_reproduction" : "exact_binding_only", producer_changes: Object.freeze(producerChanges) });
}

export function main() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(REPO_ROOT, ".visual-intelligence", "manifest.json"), "utf8"));
  } catch (error) {
    console.error(`vi-prepush-policy — FAIL: cannot read graph manifest: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const revision = manifest.repo_revision;
  let changedPaths;
  try {
    changedPaths = execFileSync("git", ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", revision], { cwd: REPO_ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch (error) {
    console.error(`vi-prepush-policy — FAIL: cannot inspect graph source revision ${revision}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const decision = selectViPrepushMode(changedPaths);
  if (decision.mode === "exact_binding_only") {
    console.log(JSON.stringify({ ok: true, gate: "vi-prepush-policy", ...decision, authority: "gate:vi-freshness exact input binding" }));
    return 0;
  }
  console.log(JSON.stringify({ ok: null, gate: "vi-prepush-policy", ...decision, authority: "full structural reproduction required" }));
  const result = spawnSync("bun", ["scripts/vi-refresh.mjs", "--check"], { cwd: REPO_ROOT, stdio: "inherit" });
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
