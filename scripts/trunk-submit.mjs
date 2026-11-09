#!/usr/bin/env node
/**
 * Transactional trunk submission.
 *
 * This intentionally makes a source commit and an evidence-seal commit. The
 * evidence stores attest to committed bytes, so placing their refreshed bytes
 * in the source commit would change the commit they are meant to attest to.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { STORE_REGENERATION_MARKER } from "./lib/store-budgets.mjs";
import { MANAGED_HOOKS, managedLauncherSource } from "./install-git-hooks.mjs";
import { checkTrunkPreflight, readIntegrationContract } from "./trunk-preflight.mjs";
import { verifyTrunkSubmitExecutionProfile } from "./enforcement-control-plane.mjs";
import { acquireEvidenceTransaction } from "./evidence-transaction.mjs";

export const EVIDENCE_PATH_PREFIXES = Object.freeze([
  ".visual-intelligence/",
  ".claim-ledger/",
  ".completion-depth/",
  ".determinism-baseline/",
]);

const AUTOMATED_EVIDENCE_STORES = Object.freeze(["vi-observed", "claim-ledger", "completion-depth"]);
const REPORTED_EVIDENCE_STORES = Object.freeze([...AUTOMATED_EVIDENCE_STORES, "determinism-baseline"]);
const MAX_COMMAND_OUTPUT_BYTES = 512 * 1024 * 1024;
const MAX_ERROR_DETAIL_CHARS = 16_384;

export class TrunkSubmitError extends Error {}

function command(command, args, cwd, options = {}) {
  try {
    const output = execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      input: options.input,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });
    return options.trim === false ? output : output.trim();
  } catch (error) {
    const rawDetail = [error.stdout, error.stderr].filter((value) => typeof value === "string" && value.length > 0).join("\n").trim();
    const halfDetail = Math.floor(MAX_ERROR_DETAIL_CHARS / 2);
    const detail = rawDetail.length > MAX_ERROR_DETAIL_CHARS
      ? `${rawDetail.slice(0, halfDetail)}\n...[diagnostic truncated: ${rawDetail.length - MAX_ERROR_DETAIL_CHARS} characters omitted]...\n${rawDetail.slice(-halfDetail)}`
      : rawDetail;
    throw new TrunkSubmitError(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
}

function git(repo, args, options) {
  return command("git", args, repo, options);
}

function gitSucceeds(repo, args) {
  try { git(repo, args); return true; } catch { return false; }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safePath(raw) {
  if (typeof raw !== "string" || raw.length === 0 || isAbsolute(raw)) throw new TrunkSubmitError("--include must name a non-empty repository-relative path");
  const value = normalize(raw).replaceAll("\\", "/");
  if (value === "." || value === ".." || value.startsWith("../") || value.includes("\0")) {
    throw new TrunkSubmitError(`unsafe --include path: ${raw}`);
  }
  return value.replace(/\/$/, "");
}

export function parseTrunkSubmitArgs(args) {
  const result = { message: null, includes: [], remote: null, branch: null, resume: null };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--message") {
      if (result.message !== null || typeof value !== "string" || value.trim().length === 0) throw new TrunkSubmitError("--message is required exactly once and must be non-empty");
      result.message = value;
      index += 1;
    } else if (flag === "--include") {
      result.includes.push(safePath(value));
      index += 1;
    } else if (flag === "--remote") {
      if (typeof value !== "string" || value.length === 0) throw new TrunkSubmitError("--remote requires a value");
      result.remote = value;
      index += 1;
    } else if (flag === "--branch") {
      if (typeof value !== "string" || value.length === 0) throw new TrunkSubmitError("--branch requires a value");
      result.branch = value;
      index += 1;
    } else if (flag === "--resume") {
      if (result.resume !== null || typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) throw new TrunkSubmitError("--resume requires exactly one transaction UUID");
      result.resume = value;
      index += 1;
    } else {
      throw new TrunkSubmitError(`unknown option: ${flag}`);
    }
  }
  for (const include of result.includes) {
    if (EVIDENCE_PATH_PREFIXES.some((prefix) => include === prefix.slice(0, -1) || include.startsWith(prefix))) {
      throw new TrunkSubmitError(`--include may not name generated evidence: ${include}`);
    }
  }
  if (result.resume !== null) {
    if (result.remote !== null || result.branch !== null) throw new TrunkSubmitError("--resume derives remote and branch from its journal");
    if (result.message !== null || result.includes.length > 0) throw new TrunkSubmitError("--resume continues the original transaction and may not add a message or --include path");
    return Object.freeze({ ...result, includes: Object.freeze([...new Set(result.includes)]) });
  }
  if (result.message === null) throw new TrunkSubmitError("Usage: bun run trunk:submit -- --message <subject> [--include <path>]... [--remote <upstream>] [--branch <branch>] | --resume <transaction-id> [--message <subject>] [--include <path>]...");
  return Object.freeze({ ...result, includes: Object.freeze([...new Set(result.includes)]) });
}

export function evidenceRefreshIsComplete(value) {
  if (typeof value !== "object" || value === null) return { ok: false, reason: "refresh did not emit a JSON object" };
  const report = value;
  if (report.ok !== true || report.error !== null || report.scope !== "all") return { ok: false, reason: "refresh report was not a successful all-store run" };
  if (!report.graph_precheck || report.graph_precheck.ran !== true || report.graph_precheck.stale === null || !["refreshed", "skipped"].includes(report.graph_precheck.action)) {
    return { ok: false, reason: "VI graph precondition was absent, incomplete, or failed" };
  }
  if (!Array.isArray(report.stores) || report.stores.length !== REPORTED_EVIDENCE_STORES.length) return { ok: false, reason: "refresh report did not contain exactly four store outcomes" };
  const seen = new Set();
  for (const store of report.stores) {
    const expectedAction = store?.name === "determinism-baseline" ? "skipped" : "refreshed";
    if (typeof store !== "object" || store === null || !REPORTED_EVIDENCE_STORES.includes(store.name) || store.action !== expectedAction) {
      return { ok: false, reason: `store ${store?.name ?? "unknown"} did not report the required ${expectedAction} action` };
    }
    seen.add(store.name);
  }
  if (seen.size !== REPORTED_EVIDENCE_STORES.length) return { ok: false, reason: "refresh report duplicated or omitted an evidence store" };
  if (report.suite_check?.ran !== false) return { ok: false, reason: "automatic evidence closure must not run the determinism suite measurement preflight" };
  return { ok: true };
}

function isIncluded(path, includes) {
  return includes.some((include) => path === include || path.startsWith(`${include}/`));
}

function nulPaths(value) {
  return value.length === 0 ? [] : value.split("\0").filter(Boolean);
}

function dirtyState(repo) {
  const tracked = nulPaths(command("git", ["diff", "--name-only", "-z"], repo));
  const untracked = nulPaths(command("git", ["ls-files", "--others", "--exclude-standard", "-z"], repo));
  return Object.freeze({ tracked: [...new Set(tracked)].sort(), untracked: [...new Set(untracked)].sort() });
}

function stagedPaths(repo) {
  return nulPaths(command("git", ["diff", "--cached", "--name-only", "-z"], repo));
}

function assertInitialState(repo, input) {
  if (!gitSucceeds(repo, ["diff", "--cached", "--quiet"])) throw new TrunkSubmitError("refusing a pre-staged index; unstage it so this transaction owns its exact commit contents");
  const branch = git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (input.branch !== null && input.branch !== branch) throw new TrunkSubmitError(`--branch ${input.branch} does not match checked-out branch ${branch}`);
  const remote = git(repo, ["config", "--get", `branch.${branch}.remote`]);
  const mergeRef = git(repo, ["config", "--get", `branch.${branch}.merge`]);
  const upstreamBranch = mergeRef.startsWith("refs/heads/") ? mergeRef.slice("refs/heads/".length) : null;
  if (upstreamBranch !== branch) throw new TrunkSubmitError(`branch ${branch} must track a same-named remote branch; found ${mergeRef}`);
  if (input.remote !== null && input.remote !== remote) throw new TrunkSubmitError(`--remote ${input.remote} does not match @{upstream} remote ${remote}`);
  const state = dirtyState(repo);
  const untrackedEvidence = state.untracked.filter((path) => EVIDENCE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)));
  if (untrackedEvidence.length > 0) throw new TrunkSubmitError(`refusing untracked generated evidence path(s): ${untrackedEvidence.join(", ")}`);
  const sourceChanged = [...state.tracked, ...state.untracked].filter((path) => !EVIDENCE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)));
  const outside = sourceChanged.filter((path) => !isIncluded(path, input.includes));
  if (outside.length > 0) throw new TrunkSubmitError(`refusing unrelated dirty path(s): ${outside.join(", ")}`);
  if (sourceChanged.length > 0 && input.includes.length === 0) throw new TrunkSubmitError("source changes require one or more explicit --include paths");
  const evidencePaths = state.tracked.filter((path) => EVIDENCE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)));
  return { branch, remote, sourceChanged, evidencePaths };
}

function assertCurrentHooks(repo) {
  for (const hook of MANAGED_HOOKS) {
    const source = join(repo, "scripts", "hooks", hook.name);
    const targetRaw = git(repo, ["rev-parse", "--git-path", `hooks/${hook.name}`]);
    const target = resolve(repo, targetRaw);
    const sourceCurrent = existsSync(source) && readFileSync(source, "utf8").includes(hook.marker);
    const launcherCurrent = existsSync(target) && readFileSync(target, "utf8") === managedLauncherSource(hook);
    if (!sourceCurrent || !launcherCurrent) {
      throw new TrunkSubmitError(`managed ${hook.name} hook is missing or stale; run bun run install-hooks before submitting`);
    }
  }
}

function assertRemoteBase(repo, remote, branch) {
  git(repo, ["fetch", "--no-tags", remote, branch]);
  if (!gitSucceeds(repo, ["merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"])) {
    throw new TrunkSubmitError(`local ${branch} does not contain the current ${remote}/${branch}; integrate remote changes before submitting`);
  }
}

function journalWriter(commonDir, id, initial, existing = null) {
  const directory = join(commonDir, "arbor", "trunk-submit");
  const lock = join(directory, "lock");
  mkdirSync(directory, { recursive: true });
  try { mkdirSync(lock); } catch { throw new TrunkSubmitError(`another trunk submission owns ${lock}; wait for it or inspect its journal`); }
  const path = join(directory, `${id}.json`);
  let state = existing ?? initial;
  const write = (patch) => {
    state = Object.freeze({ ...state, ...patch, updated_at: new Date().toISOString() });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  };
  write(existing === null ? { phase: "started" } : { phase: "resuming", resumed_at: new Date().toISOString() });
  return { path, write, release: () => rmSync(lock, { recursive: true, force: true }) };
}

function readTransactionJournal(commonDir, id) {
  const path = join(commonDir, "arbor", "trunk-submit", `${id}.json`);
  if (!existsSync(path)) throw new TrunkSubmitError(`transaction journal does not exist: ${id}`);
  let value;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { throw new TrunkSubmitError(`transaction journal is malformed: ${path}`); }
  if (typeof value !== "object" || value === null || value.schema_version !== 1 || value.id !== id || typeof value.branch !== "string" || typeof value.remote !== "string") {
    throw new TrunkSubmitError(`transaction journal has an unrecognized identity: ${path}`);
  }
  return value;
}

function recoverInterruptedImport(root, commonDir, journal, sourceIncludes = []) {
  const branch = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch !== journal.branch) throw new TrunkSubmitError(`resume journal targets branch ${journal.branch}, not checked-out ${branch}`);
  const state = dirtyState(root);
  const staged = stagedPaths(root);
  const touched = [...new Set([...state.tracked, ...state.untracked, ...staged])];
  const sourceTouched = touched.filter((path) => !evidencePathsOnly([path]));
  const unrelated = sourceTouched.filter((path) => !isIncluded(path, sourceIncludes));
  if (unrelated.length > 0) throw new TrunkSubmitError(`resume refuses unrelated non-evidence dirty path(s): ${unrelated.join(", ")}`);
  const stagedSource = staged.filter((path) => !evidencePathsOnly([path]));
  if (stagedSource.length > 0) throw new TrunkSubmitError(`resume refuses staged source path(s): ${stagedSource.join(", ")}`);
  const untrackedEvidence = state.untracked.filter((path) => evidencePathsOnly([path]));
  if (untrackedEvidence.length > 0) throw new TrunkSubmitError(`resume refuses untracked evidence path(s): ${untrackedEvidence.join(", ")}`);

  const marker = storeRegenerationMarker(commonDir);
  if (existsSync(marker)) {
    let record;
    try { record = JSON.parse(readFileSync(marker, "utf8")); } catch { throw new TrunkSubmitError(`resume cannot prove ownership of malformed marker ${marker}`); }
    if (record.owner !== "trunk-submit" || record.transaction_id !== journal.id) {
      throw new TrunkSubmitError(`resume transaction ${journal.id} does not own marker ${marker}`);
    }
  }
  const stagedEvidence = staged.filter((path) => evidencePathsOnly([path]));
  if (stagedEvidence.length > 0) git(root, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...stagedEvidence]);
  const remainingEvidence = dirtyState(root).tracked.filter((path) => evidencePathsOnly([path]));
  if (remainingEvidence.length > 0) git(root, ["restore", "--source=HEAD", "--worktree", "--", ...remainingEvidence]);
  const after = [...dirtyState(root).tracked, ...stagedPaths(root)].filter((path) => evidencePathsOnly([path]));
  if (after.length > 0) {
    throw new TrunkSubmitError("resume could not restore the interrupted evidence import to committed bytes");
  }
  if (existsSync(marker)) clearStoreRegenerationMarker(marker);
}

function snapshotDirtyEvidence(repo, commonDir, id, paths) {
  if (paths.length === 0) return null;
  const patch = command("git", ["diff", "--binary", "HEAD", "--", ...paths], repo, { trim: false });
  const path = join(commonDir, "arbor", "trunk-submit", `${id}.preexisting-evidence.patch`);
  writeFileSync(path, patch, { mode: 0o600, flag: "wx" });
  return Object.freeze({ paths: Object.freeze([...paths]), patch_path: path, sha256: sha256(patch) });
}

function assertAndSupersedeDirtyEvidence(repo, snapshot) {
  if (snapshot === null) {
    if (!gitSucceeds(repo, ["diff", "--quiet"]) || !gitSucceeds(repo, ["diff", "--cached", "--quiet"])) throw new TrunkSubmitError("canonical worktree changed while detached evidence refresh ran");
    return;
  }
  if (!gitSucceeds(repo, ["diff", "--cached", "--quiet"])) throw new TrunkSubmitError("canonical index changed while detached evidence refresh ran");
  const current = dirtyState(repo);
  if (current.untracked.length > 0 || current.tracked.length !== snapshot.paths.length || current.tracked.some((path, index) => path !== snapshot.paths[index])) {
    throw new TrunkSubmitError("canonical generated evidence changed while detached refresh ran; refusing to supersede an unrecorded state");
  }
  const patch = command("git", ["diff", "--binary", "HEAD", "--", ...snapshot.paths], repo, { trim: false });
  if (sha256(patch) !== snapshot.sha256) throw new TrunkSubmitError("canonical generated evidence no longer matches the journaled pre-refresh snapshot");
  // This is deliberately limited to pre-journaled generated roots. Source
  // paths are never reset, restored, stashed, or otherwise rewritten.
  git(repo, ["restore", "--source=HEAD", "--worktree", "--", ...snapshot.paths]);
  if (!gitSucceeds(repo, ["diff", "--quiet"])) throw new TrunkSubmitError("generated evidence restoration did not produce a clean canonical worktree");
}

function storeRegenerationMarker(commonDir) {
  return join(commonDir, STORE_REGENERATION_MARKER);
}

function assertNoStoreRegenerationMarker(commonDir) {
  const marker = storeRegenerationMarker(commonDir);
  // Existence alone is authoritative. A malformed or dead-PID marker is not
  // safe to infer away: it may guard a still-uncommitted canonical import.
  if (existsSync(marker)) throw new TrunkSubmitError(`store regeneration marker already exists at ${marker}; inspect and resolve it before submitting`);
}

function acquireStoreRegenerationMarker(commonDir, transactionId) {
  const marker = storeRegenerationMarker(commonDir);
  try {
    writeFileSync(marker, `${JSON.stringify({ schema_version: 1, owner: "trunk-submit", transaction_id: transactionId, pid: process.pid, started_at: new Date().toISOString(), phase: "canonical_evidence_import" })}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    throw new TrunkSubmitError(`could not acquire canonical store regeneration marker at ${marker}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return marker;
}

function clearStoreRegenerationMarker(marker) {
  rmSync(marker, { force: true });
}

function evidencePathsOnly(paths) {
  return paths.every((path) => EVIDENCE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)));
}

function createSnapshot(repo, id) {
  const snapshot = mkdtempSync(join(tmpdir(), `revoy2-trunk-submit-${id.slice(0, 8)}-`));
  // `git worktree add` requires a path it can create itself; mkdtemp gives us
  // an unguessable reservation, then we release that empty directory only.
  rmSync(snapshot, { recursive: true, force: true });
  git(repo, ["worktree", "add", "--detach", snapshot, "HEAD"]);
  try {
    // Never link the primary checkout's node_modules here. Workspace package
    // symlinks inside it resolve TypeScript imports back across the snapshot
    // boundary, which correctly trips VI's cross-root contamination guard.
    // A frozen snapshot-local install preserves the admitted lockfile and lets
    // Bun reuse its content-addressed cache without changing resolution roots.
    command("bun", ["install", "--frozen-lockfile"], snapshot);
    // vi-observe executes the repository's declared dist entrypoints, and its
    // regression tests intentionally require those same real artifacts. A
    // source-only worktree is therefore not an evidence-capable snapshot until
    // the canonical whole-repo build has completed inside it.
    command("bun", ["run", "build"], snapshot);
    return snapshot;
  } catch (error) {
    removeSnapshot(repo, snapshot);
    throw error;
  }
}

function removeSnapshot(repo, snapshot) {
  try { git(repo, ["worktree", "remove", "--force", snapshot]); } catch { rmSync(snapshot, { recursive: true, force: true }); }
}

function refreshEvidence(snapshot) {
  const lease = acquireEvidenceTransaction({ repo: snapshot });
  let stdout;
  try {
    lease.transition("graph_precheck_and_evidence_producers");
    stdout = command("bun", ["packages/arbor-mcp/bin/arbor-mcp.mjs", "evidence", "refresh", "--scope", "all", "--json", "--delegated-evidence-transaction"], snapshot, { env: { ...process.env, ...lease.environment } });
    lease.transition("completed");
  } finally {
    lease.release();
  }
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { throw new TrunkSubmitError("evidence refresh did not emit parseable JSON"); }
  const verdict = evidenceRefreshIsComplete(parsed);
  if (!verdict.ok) throw new TrunkSubmitError(`evidence refresh was incomplete: ${verdict.reason}`);
  const untracked = nulPaths(command("git", ["ls-files", "--others", "--exclude-standard", "-z"], snapshot));
  if (untracked.length > 0) throw new TrunkSubmitError(`evidence refresh created untracked output: ${untracked.join(", ")}`);
  const paths = nulPaths(command("git", ["diff", "--name-only", "-z", "HEAD"], snapshot));
  if (!evidencePathsOnly(paths)) throw new TrunkSubmitError(`evidence refresh changed non-evidence path(s): ${paths.filter((path) => !evidencePathsOnly([path])).join(", ")}`);
  return { report: parsed, paths, patch: command("git", ["diff", "--binary", "HEAD"], snapshot, { trim: false }) };
}

function assertEvidenceSealPostconditions(repo, evidenceCommit) {
  if (!gitSucceeds(repo, ["diff", "--quiet"]) || !gitSucceeds(repo, ["diff", "--cached", "--quiet"])) {
    throw new TrunkSubmitError("evidence seal commit did not leave a clean canonical worktree/index");
  }
  const committedPaths = nulPaths(command("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", evidenceCommit], repo));
  if (!evidencePathsOnly(committedPaths)) throw new TrunkSubmitError(`evidence seal commit contains non-evidence path(s): ${committedPaths.filter((path) => !evidencePathsOnly([path])).join(", ")}`);
}

function assertEvidenceSupersessionPostconditions(repo) {
  if (!gitSucceeds(repo, ["diff", "--quiet"]) || !gitSucceeds(repo, ["diff", "--cached", "--quiet"])) {
    throw new TrunkSubmitError("generated-evidence supersession did not leave a clean canonical worktree/index");
  }
}

function assertSourceCommitPostconditions(repo, sourceCommit, includes) {
  const paths = nulPaths(command("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", sourceCommit], repo));
  const invalid = paths.filter((path) => EVIDENCE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)) || !isIncluded(path, includes));
  if (invalid.length > 0) throw new TrunkSubmitError(`source commit contains unselected or generated path(s): ${invalid.join(", ")}`);
}

function deleteRef(repo, ref) {
  try { git(repo, ["update-ref", "-d", ref]); } catch { /* transaction cleanup is best-effort */ }
}

/**
 * Fetch the integration contract's trunk into a transaction-private local ref
 * and hand its immutable OID to preflight. FETCH_HEAD is intentionally not
 * used: it is mutable process state, while this ref is unique to the journal.
 */
function assertRemoteIntegrationPreflight(repo, remote, branch, id) {
  const contract = readIntegrationContract(repo);
  const temporaryRef = `refs/arbor/trunk-submit/${id}/integration-trunk`;
  try {
    git(repo, ["fetch", "--no-tags", remote, `+refs/heads/${contract.trunk_ref}:${temporaryRef}`]);
    const trunkHead = git(repo, ["rev-parse", `${temporaryRef}^{commit}`]);
    const result = checkTrunkPreflight({
      repo,
      candidate: git(repo, ["rev-parse", "HEAD"]),
      handoffBranch: branch === contract.trunk_ref ? null : branch,
      trunkHead,
    });
    if (!result.ok) throw new TrunkSubmitError(`trunk preflight failed:\n${result.failures.map((failure) => `  - ${failure}`).join("\n")}`);
    return Object.freeze({ temporaryRef, trunkHead });
  } catch (error) {
    deleteRef(repo, temporaryRef);
    throw error;
  }
}

function assertResumeCheckpoint(repo, journal) {
  const expected = typeof journal.evidence_commit === "string"
    ? journal.evidence_commit
    : typeof journal.source_commit === "string"
      ? journal.source_commit
      : null;
  if (expected === null) {
    throw new TrunkSubmitError(
      `transaction ${journal.id} has no committed checkpoint to resume; its source phase never committed. Start a new trunk submission instead.`,
    );
  }
  const actual = git(repo, ["rev-parse", "HEAD"]);
  if (actual !== expected) {
    throw new TrunkSubmitError(
      `resume refuses transaction ${journal.id}: HEAD changed since its committed checkpoint (expected ${expected}, found ${actual}). Start a new trunk submission; do not seal or push intervening commits under this journal.`,
    );
  }
  return expected;
}

function executeTrunkSubmit({ parsed, root, commonDir, journal, initial, id, hookToken, sourceAlreadyCommitted = false }) {
  let snapshot = null;
  try {
    let sourceCommit = sourceAlreadyCommitted && typeof journal.source_commit === "string" ? journal.source_commit : null;
    if (!sourceAlreadyCommitted && initial.sourceChanged.length > 0) {
      git(root, ["add", "--", ...parsed.includes]);
      if (!gitSucceeds(root, ["diff", "--cached", "--quiet"])) {
        git(root, ["commit", "-m", parsed.message], { env: { REVOY_TRUNK_SUBMIT_ID: id, REVOY_TRUNK_SUBMIT_TOKEN: hookToken } });
        sourceCommit = git(root, ["rev-parse", "HEAD"]);
        journal.write({ phase: "source_commit_created", source_commit: sourceCommit });
        assertSourceCommitPostconditions(root, sourceCommit, parsed.includes);
        journal.write({ phase: "source_committed", source_commit: sourceCommit });
      }
    }
    const dirtyEvidence = snapshotDirtyEvidence(root, commonDir, id, initial.evidencePaths);
    journal.write({ phase: "source_committed", source_commit: sourceCommit ?? git(root, ["rev-parse", "HEAD"]), preexisting_evidence: dirtyEvidence, last_safe_phase: "source_committed" });
    snapshot = createSnapshot(root, id);
    const evidence = refreshEvidence(snapshot);
    journal.write({ phase: "evidence_refreshed", evidence_paths: evidence.paths, evidence_report_sha256: sha256(JSON.stringify(evidence.report)) });
    let evidenceCommit = null;
    if (evidence.patch.length > 0 || dirtyEvidence !== null) {
      const marker = acquireStoreRegenerationMarker(commonDir, id);
      assertAndSupersedeDirtyEvidence(root, dirtyEvidence);
      if (evidence.patch.length === 0) {
        assertEvidenceSupersessionPostconditions(root);
        clearStoreRegenerationMarker(marker);
        journal.write({ phase: "evidence_unchanged", last_safe_phase: "source_committed" });
      } else {
        git(root, ["apply", "--index", "--whitespace=error"], { input: evidence.patch });
        const applied = command("git", ["diff", "--cached", "--binary", "HEAD"], root, { trim: false });
        if (sha256(applied) !== sha256(evidence.patch)) throw new TrunkSubmitError("evidence patch did not round-trip into the canonical index exactly");
        journal.write({ phase: "evidence_staged", evidence_patch_sha256: sha256(evidence.patch) });
        git(root, ["commit", "-m", `chore(evidence): seal ${git(root, ["rev-parse", "HEAD"]).slice(0, 12)}`], { env: { REVOY_TRUNK_SUBMIT_ID: id, REVOY_TRUNK_SUBMIT_TOKEN: hookToken } });
        evidenceCommit = git(root, ["rev-parse", "HEAD"]);
        assertEvidenceSealPostconditions(root, evidenceCommit);
        clearStoreRegenerationMarker(marker);
        journal.write({ phase: "evidence_committed", evidence_commit: evidenceCommit, last_safe_phase: "evidence_committed" });
      }
    }
    assertRemoteBase(root, initial.remote, initial.branch);
    git(root, ["push", initial.remote, `HEAD:refs/heads/${initial.branch}`]);
    journal.write({ phase: "pushed", pushed_head: git(root, ["rev-parse", "HEAD"]) });
    return Object.freeze({ ok: true, transaction_id: id, journal: journal.path, source_commit: sourceCommit, evidence_commit: evidenceCommit });
  } catch (error) {
    journal.write({ phase: "partial_needs_resume", error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    if (snapshot !== null) removeSnapshot(root, snapshot);
  }
}

/** Performs the normal-hooked source/evidence commits followed by one ordinary push. */
export function runTrunkSubmit(input, repo = process.cwd()) {
  const root = git(repo, ["rev-parse", "--show-toplevel"]);
  const commonRaw = git(root, ["rev-parse", "--git-common-dir"]);
  const commonDir = resolve(root, commonRaw);
  const parsed = typeof input?.message === "string" ? input : parseTrunkSubmitArgs(input);
  if (typeof parsed.resume === "string") return resumeTrunkSubmit(parsed.resume, root, commonDir, parsed);
  const initial = assertInitialState(root, parsed);
  assertNoStoreRegenerationMarker(commonDir);
  assertCurrentHooks(root);
  const executionProfile = verifyTrunkSubmitExecutionProfile(root);
  if (!executionProfile.ok) throw new TrunkSubmitError(`execution profile refuses trunk submission: ${executionProfile.problems.join("; ")}`);
  const id = randomUUID();
  const hookToken = randomUUID();
  let remotePreflight = null;
  try {
    remotePreflight = assertRemoteIntegrationPreflight(root, initial.remote, initial.branch, id);
    assertRemoteBase(root, initial.remote, initial.branch);
    const journal = journalWriter(commonDir, id, {
      schema_version: 1,
      id,
      branch: initial.branch,
      remote: initial.remote,
      includes: parsed.includes,
      message: parsed.message,
      initial_head: git(root, ["rev-parse", "HEAD"]),
      remote_trunk_head: remotePreflight.trunkHead,
      owner_pid: process.pid,
      hook_token: hookToken,
      journal_path: null,
    });
    try {
      return executeTrunkSubmit({ parsed, root, commonDir, journal, initial, id, hookToken });
    } finally {
      journal.release();
    }
  } finally {
    if (remotePreflight !== null) deleteRef(root, remotePreflight.temporaryRef);
  }
}

export function resumeTrunkSubmit(id, root = process.cwd(), commonDirOverride = null, submission = {}) {
  const repo = git(root, ["rev-parse", "--show-toplevel"]);
  const commonDir = commonDirOverride ?? resolve(repo, git(repo, ["rev-parse", "--git-common-dir"]));
  const existing = readTransactionJournal(commonDir, id);
  const recovery = journalWriter(commonDir, id, existing, existing);
  let remotePreflight = null;
  try {
    recoverInterruptedImport(repo, commonDir, existing, []);
    assertResumeCheckpoint(repo, existing);
    recovery.write({ phase: "recovered", recovered_head: git(repo, ["rev-parse", "HEAD"]) });

    const parsed = {
      message: existing.message ?? "resume trunk submission",
      includes: Object.freeze([]),
      remote: existing.remote,
      branch: existing.branch,
      resume: null,
    };
    const initial = assertInitialState(repo, parsed);
    assertNoStoreRegenerationMarker(commonDir);
    assertCurrentHooks(repo);
    const executionProfile = verifyTrunkSubmitExecutionProfile(repo);
    if (!executionProfile.ok) throw new TrunkSubmitError(`execution profile refuses resumed trunk submission: ${executionProfile.problems.join("; ")}`);
    remotePreflight = assertRemoteIntegrationPreflight(repo, initial.remote, initial.branch, id);
    assertRemoteBase(repo, initial.remote, initial.branch);
    return executeTrunkSubmit({
      parsed,
      root: repo,
      commonDir,
      journal: recovery,
      initial,
      id,
      hookToken: existing.hook_token,
      sourceAlreadyCommitted: true,
    });
  } catch (error) {
    recovery.write({ phase: "recovery_refused", error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    if (remotePreflight !== null) deleteRef(repo, remotePreflight.temporaryRef);
    recovery.release();
  }
}

if (import.meta.main) {
  try {
    const result = runTrunkSubmit(process.argv.slice(2));
    process.stdout.write(`trunk submit: pushed ${result.evidence_commit ?? result.source_commit ?? "current HEAD"} (journal: ${result.journal})\n`);
  } catch (error) {
    process.stderr.write(`trunk submit: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
