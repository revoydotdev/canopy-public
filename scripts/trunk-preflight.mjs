#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripJsonc } from "../packages/arbor-config/src/loader.ts";
import { readHandoffMetadata } from "./lib/conductor/graph.mjs";

function git(repo, args, allowFailure = false) {
  try { return { ok: true, stdout: execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() }; }
  catch (error) { if (allowFailure) return { ok: false, stdout: "" }; throw error; }
}

export function readIntegrationContract(repo) {
  const path = join(repo, ".arbor", "integration.jsonc");
  if (!existsSync(path)) throw new Error("missing .arbor/integration.jsonc");
  const value = JSON.parse(stripJsonc(readFileSync(path, "utf8")));
  if (typeof value.trunk_ref !== "string" || typeof value.trunk_head_at_declaration !== "string") throw new Error("integration contract requires trunk_ref and trunk_head_at_declaration");
  return value;
}

function commits(repo, range) {
  const value = git(repo, ["rev-list", range], true);
  return value.ok ? new Set(value.stdout.split("\n").filter(Boolean)) : new Set();
}

function dependencyMatches(branch, dependency) {
  return dependency === branch || branch.endsWith(`/${dependency}`);
}

/**
 * Checks a candidate against either the local integration ref (the standalone
 * CLI's historical behaviour) or an immutable commit fetched by the submit
 * transaction. The latter is what makes "live trunk" mean the remote value
 * observed for this transaction, not whatever an operator last fetched.
 */
export function checkTrunkPreflight({ repo, candidate, handoffBranch = null, trunkHead: suppliedTrunkHead = null }) {
  const contract = readIntegrationContract(repo);
  const failures = [];
  const trunkHead = suppliedTrunkHead === null
    ? git(repo, ["rev-parse", `${contract.trunk_ref}^{commit}`]).stdout
    : git(repo, ["rev-parse", `${suppliedTrunkHead}^{commit}`]).stdout;
  const declared = git(repo, ["rev-parse", `${contract.trunk_head_at_declaration}^{commit}`], true);
  if (!declared.ok || !git(repo, ["merge-base", "--is-ancestor", declared.stdout, trunkHead], true).ok) failures.push(".arbor/integration.jsonc is stale: trunk_head_at_declaration is not an ancestor of the live trunk");

  if (contract.trunk_ref !== "master" && git(repo, ["rev-parse", "--verify", "master^{commit}"], true).ok) {
    const masterHead = git(repo, ["rev-parse", "master^{commit}"]).stdout;
    if (git(repo, ["merge-base", "master", contract.trunk_ref]).stdout !== masterHead) failures.push(`master and ${contract.trunk_ref} have diverged; the integration base is ambiguous`);
  }

  const candidateHead = git(repo, ["rev-parse", `${candidate}^{commit}`], true);
  if (!candidateHead.ok || !git(repo, ["merge-base", "--is-ancestor", trunkHead, candidateHead.stdout], true).ok) failures.push(`candidate ${candidate} is not based on live trunk ${contract.trunk_ref}; rebase onto ${contract.trunk_ref} before continuing`);

  if (handoffBranch) {
    const metadata = readHandoffMetadata(repo, handoffBranch);
    if (!metadata.found || !metadata.depends_on_declared) failures.push(`handoff for ${handoffBranch} must declare depends_on: [] (or its actual dependencies)`);
    else {
      const own = commits(repo, `${contract.trunk_ref}..${handoffBranch}`);
      const refs = git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads/feature/"], true).stdout.split("\n").filter(Boolean);
      for (const other of refs.filter((ref) => ref !== handoffBranch)) {
        const overlap = [...commits(repo, `${contract.trunk_ref}..${other}`)].filter((commit) => own.has(commit));
        if (overlap.length && !metadata.depends_on.some((dependency) => dependencyMatches(other, dependency))) failures.push(`${handoffBranch} contains ${overlap.length} commit(s) from ${other} but does not declare it in depends_on`);
      }
    }
  }
  return { ok: failures.length === 0, trunk_ref: contract.trunk_ref, trunk_head: trunkHead, candidate, failures };
}

function value(flag) { const index = process.argv.indexOf(flag); return index >= 0 ? process.argv[index + 1] : null; }
function main() {
  const repo = resolve(value("--repo") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const branch = value("--branch");
  const candidate = value("--base") ?? branch ?? git(repo, ["rev-parse", "HEAD"]).stdout;
  const result = checkTrunkPreflight({ repo, candidate, handoffBranch: branch });
  if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else if (result.ok) console.log(`trunk preflight PASS — ${candidate} contains ${result.trunk_ref} at ${result.trunk_head.slice(0, 12)}`);
  else for (const failure of result.failures) console.error(`trunk preflight FAIL — ${failure}`);
  return result.ok ? 0 : 1;
}

if (import.meta.main) process.exitCode = main();
