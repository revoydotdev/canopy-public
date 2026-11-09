#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const EVIDENCE_PREFIXES = [".visual-intelligence/", ".claim-ledger/", ".completion-depth/", ".determinism-baseline/"];

function isEvidence(path) {
  return EVIDENCE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function evaluateTrunkSubmitHookAuthority({ journal, lockExists, id, token, stagedPaths }) {
  if (!lockExists) return { ok: false, reason: "exclusive trunk-submit lock is absent" };
  if (!journal || journal.schema_version !== 1 || journal.id !== id || journal.hook_token !== token) {
    return { ok: false, reason: "transaction journal identity or capability token does not match" };
  }
  if (!Number.isInteger(journal.owner_pid) || journal.owner_pid <= 0) return { ok: false, reason: "journal has no valid owner pid" };
  if (journal.phase === "started") {
    const invalid = stagedPaths.filter(isEvidence);
    return invalid.length === 0
      ? { ok: true, phase: "source", reason: "full evidence refresh is transactionally deferred until the source commit exists" }
      : { ok: false, reason: `source phase staged generated evidence: ${invalid.join(", ")}` };
  }
  if (journal.phase === "evidence_staged") {
    const invalid = stagedPaths.filter((path) => !isEvidence(path));
    const hasClaims = stagedPaths.some((path) => path.startsWith(".claim-ledger/"));
    return invalid.length === 0 && hasClaims
      ? { ok: true, phase: "evidence", reason: "the transaction already staged the complete evidence seal" }
      : { ok: false, reason: invalid.length > 0 ? `evidence phase staged source paths: ${invalid.join(", ")}` : "evidence phase omitted .claim-ledger" };
  }
  return { ok: false, reason: `journal phase ${JSON.stringify(journal.phase)} has no commit authority` };
}

function main() {
  const id = process.env.REVOY_TRUNK_SUBMIT_ID;
  const token = process.env.REVOY_TRUNK_SUBMIT_TOKEN;
  if (!id || !token) throw new Error("both REVOY_TRUNK_SUBMIT_ID and REVOY_TRUNK_SUBMIT_TOKEN are required");
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const commonRaw = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim();
  const directory = join(resolve(root, commonRaw), "arbor", "trunk-submit");
  const journalPath = join(directory, `${id}.json`);
  let journal;
  try { journal = JSON.parse(readFileSync(journalPath, "utf8")); } catch { throw new Error(`cannot read transaction journal ${journalPath}`); }
  const staged = execFileSync("git", ["diff", "--cached", "--name-only", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const verdict = evaluateTrunkSubmitHookAuthority({ journal, lockExists: existsSync(join(directory, "lock")), id, token, stagedPaths: staged });
  if (!verdict.ok) throw new Error(`trunk-submit hook authority refused: ${verdict.reason}`);
  console.log(`[pre-commit] claim-ledger auto-refresh deferred by locked trunk-submit ${verdict.phase} phase: ${verdict.reason}`);
}

if (import.meta.main) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
