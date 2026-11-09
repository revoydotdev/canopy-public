/**
 * Governed by ADR-023: worktree isolation plus the ledger bound blast radius,
 * so un-integrated work is preserved before a worktree is ever removed.
 *
 * arbor-campaign-support/preservation — durable, content-addressed capture of
 * a lease's un-integrated work, written BEFORE `worktree.ts` destroys a
 * worktree/branch in `releaseLease`/`reclaimOrphan`.
 *
 * Principle (data-safety): a failed release that preserves data beats a
 * "successful" one that silently destroys work. This module only ever
 * WRITES under `<repoRoot>/.arbor/preserved/<campaign_id>/<node_id>/`; it
 * never touches the worktree's real git index or working tree, and every
 * artifact is verified (re-read + re-hashed) before this module reports
 * success, so a caller can trust `ok: true` as proof the bytes are actually
 * on disk and intact — not merely that the write calls did not throw.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, writeSync, fsyncSync, renameSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { sanitizedGitEnv } from "./worktree.js";
import type { IntegrationClassification } from "./integration-check.js";

export interface PreserveWorkParams {
  /** The worktree directory holding the work to preserve. Must still exist. */
  worktreePath: string;
  /** `<repoRoot>/.arbor/preserved` (or an injected equivalent for tests). */
  preservedRoot: string;
  campaignId: string;
  nodeId: string;
  branch: string;
  /** The commit the lease started from — the baseline the working-tree patch is diffed against. */
  startingCommit: string;
  /** The worktree's current HEAD (may equal `startingCommit` if no commits were made). */
  headCommit: string;
  /** Why this content was judged not (yet) integrated — recorded for audit, not re-derived here. */
  integrationRung: IntegrationClassification;
  gitTimeoutMs?: number;
  now?: Date;
}

export interface PreservedArtifactRef {
  file: string;
  sha256: string;
  bytes: number;
}

export interface PreservationManifest {
  node_id: string;
  campaign_id: string;
  branch: string;
  starting_commit: string;
  head: string;
  /**
   * The tree id of the exact working-tree snapshot this manifest's patch was
   * built from (`read-tree HEAD; add -A; write-tree` on a scratch index —
   * see `computeWorkingTreeSnapshotId`). This is the TOCTOU proof: a caller
   * re-checking right before removal compares a FRESH id against this one,
   * never against a boolean "still dirty" flag, so a further edit to an
   * already-modified file (same dirty flag, same HEAD, different content)
   * is never mistaken for "nothing changed".
   */
  working_tree_id: string;
  integration_rung: IntegrationClassification;
  created_at: string;
  artifacts: {
    patch: PreservedArtifactRef | null;
    bundle: PreservedArtifactRef | null;
  };
}

export type PreserveWorkResult =
  | { ok: true; manifestPath: string; manifest: PreservationManifest; workingTreeId: string }
  | { ok: false; reason: string };

const DEFAULT_TIMEOUT_MS = 120_000;

function run(cwd: string, args: string[], timeoutMs: number, extraEnv?: NodeJS.ProcessEnv): { ok: boolean; status: number | null; stdout: string; stderr: string } {
  let result: SpawnSyncReturns<string>;
  try {
    result = spawnSync("git", args, {
      cwd,
      stdio: "pipe",
      encoding: "utf-8",
      env: { ...sanitizedGitEnv(), ...extraEnv },
      timeout: timeoutMs,
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return { ok: false, status: null, stdout: "", stderr: "" };
  }
  if (result.error) return { ok: false, status: result.status, stdout: "", stderr: String(result.error) };
  return { ok: true, status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function sha256Hex(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Write `content` to `targetPath` via a sibling temp file + fsync + rename, so a reader never observes a partial write. */
function atomicWriteBinary(targetPath: string, content: Buffer | string): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmp = join(dirname(targetPath), `.${Math.random().toString(16).slice(2)}-${randomBytes(4).toString("hex")}.tmp`);
  let renamed = false;
  try {
    const fd = openSync(tmp, "w");
    try {
      if (typeof content === "string") writeSync(fd, content);
      else writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, targetPath);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // best-effort cleanup of a failed write
      }
    }
  }
}

/** Write a content-addressed artifact (named by its sha256) idempotently: a re-release that produces the same bytes writes nothing new. */
function writeContentAddressedArtifact(dir: string, extension: string, content: Buffer): PreservedArtifactRef {
  const sha256 = sha256Hex(content);
  const file = `${sha256}.${extension}`;
  const path = join(dir, file);
  if (!existsSync(path)) atomicWriteBinary(path, content);
  return { file, sha256, bytes: content.length };
}

/** Re-read an artifact from disk and confirm its bytes hash to what the manifest claims — proof, not assumption. */
function verifyArtifact(dir: string, ref: PreservedArtifactRef | null): boolean {
  if (ref === null) return true;
  const path = join(dir, ref.file);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return false;
  }
  return bytes.length === ref.bytes && sha256Hex(bytes) === ref.sha256;
}

/**
 * Content identity of the CURRENT working tree, independent of the
 * revision the diff is baselined against: seed a scratch index from `HEAD`,
 * `add -A` to converge it onto the on-disk state (adds, modifications, AND
 * deletions), then `write-tree`. Two calls made with no working-tree writes
 * between them always produce the same tree id; a write anywhere in between
 * — even re-editing a file that was already dirty — changes it. Never
 * touches the worktree's real index. Returns `null` on any failure; callers
 * MUST treat `null` as "identity unknown" and fail closed (never treat it as
 * proof of "unchanged").
 */
export function computeWorkingTreeSnapshotId(worktreePath: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): string | null {
  const scratchIndex = join(worktreePath, ".git", `.snapshot-index-${process.pid}-${randomBytes(4).toString("hex")}`);
  const env = { GIT_INDEX_FILE: scratchIndex };
  try {
    const readTree = run(worktreePath, ["read-tree", "HEAD"], timeoutMs, env);
    if (!readTree.ok || readTree.status !== 0) return null;
    const add = run(worktreePath, ["add", "-A"], timeoutMs, env);
    if (!add.ok || add.status !== 0) return null;
    const writeTree = run(worktreePath, ["write-tree"], timeoutMs, env);
    if (!writeTree.ok || writeTree.status !== 0) return null;
    const id = writeTree.stdout.trim();
    return id.length > 0 ? id : null;
  } finally {
    try {
      rmSync(scratchIndex, { force: true });
    } catch {
      // best-effort cleanup of the scratch index
    }
  }
}

/**
 * Build the working-tree patch (staged + unstaged + untracked, binary-safe)
 * against `startingCommit`, WITHOUT touching the worktree's real index: a
 * scratch index (`GIT_INDEX_FILE` pointed at a throwaway path) is seeded
 * from `startingCommit`'s tree, then `add -A` stages the worktree's current
 * on-disk state into that scratch index only. The real index the worktree's
 * owner may still be relying on is never opened.
 *
 * Also returns `treeId`, the write-tree of this EXACT same scratch index —
 * i.e. the content identity of precisely the snapshot this patch was built
 * from (`add -A` converges any seed tree onto the same on-disk state, so
 * this is identical to `computeWorkingTreeSnapshotId`'s result taken at the
 * same instant, with no separate git invocation and therefore no gap
 * between "what was preserved" and "what was fingerprinted").
 */
function buildWorkingTreePatch(worktreePath: string, startingCommit: string, timeoutMs: number): { ok: true; patch: string; treeId: string } | { ok: false; reason: string } {
  const scratchIndex = join(worktreePath, ".git", `.preserve-index-${process.pid}-${randomBytes(4).toString("hex")}`);
  const env = { GIT_INDEX_FILE: scratchIndex };
  try {
    const readTree = run(worktreePath, ["read-tree", startingCommit], timeoutMs, env);
    if (!readTree.ok || readTree.status !== 0) return { ok: false, reason: `git read-tree failed: ${readTree.stderr}` };
    const add = run(worktreePath, ["add", "-A"], timeoutMs, env);
    if (!add.ok || add.status !== 0) return { ok: false, reason: `git add -A into scratch index failed: ${add.stderr}` };
    const writeTree = run(worktreePath, ["write-tree"], timeoutMs, env);
    if (!writeTree.ok || writeTree.status !== 0) return { ok: false, reason: `git write-tree on the scratch index failed: ${writeTree.stderr}` };
    const treeId = writeTree.stdout.trim();
    if (treeId.length === 0) return { ok: false, reason: "git write-tree returned an empty tree id" };
    const diff = run(
      worktreePath,
      ["diff", "--cached", "--binary", "--no-ext-diff", "--no-color", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", startingCommit],
      timeoutMs,
      env,
    );
    if (!diff.ok || diff.status !== 0) return { ok: false, reason: `git diff --cached against ${startingCommit} failed: ${diff.stderr}` };
    return { ok: true, patch: diff.stdout, treeId };
  } finally {
    try {
      rmSync(scratchIndex, { force: true });
    } catch {
      // best-effort: a leftover scratch index is inert (never referenced by anything else)
    }
  }
}

function buildBundle(worktreePath: string, startingCommit: string, headCommit: string, timeoutMs: number): { ok: true; bundle: Buffer } | { ok: false; reason: string } {
  const tmpPath = join(worktreePath, ".git", `.preserve-bundle-${process.pid}-${randomBytes(4).toString("hex")}.bundle`);
  // `git bundle create` needs a NAMEABLE ref for the range's tip to record
  // in the bundle header — two bare commit shas ("A..B") give it nothing to
  // advertise and it refuses with "Refusing to create empty bundle" even
  // though real commits exist in the range. A scratch ref (deleted right
  // after) gives it exactly that, without depending on the worktree's real
  // HEAD/branch still pointing at `headCommit` at this exact instant.
  const tmpRef = `refs/arbor-preserve-tmp/${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    const mkRef = run(worktreePath, ["update-ref", tmpRef, headCommit], timeoutMs);
    if (!mkRef.ok || mkRef.status !== 0) return { ok: false, reason: `could not create a scratch ref for the bundle range: ${mkRef.stderr}` };
    const create = run(worktreePath, ["bundle", "create", tmpPath, `${startingCommit}..${tmpRef}`], timeoutMs);
    if (!create.ok || create.status !== 0) return { ok: false, reason: `git bundle create failed: ${create.stderr}` };
    let bytes: Buffer;
    try {
      bytes = readFileSync(tmpPath);
    } catch (error) {
      return { ok: false, reason: `bundle was reported created but could not be read back: ${(error as Error).message}` };
    }
    return { ok: true, bundle: bytes };
  } finally {
    run(worktreePath, ["update-ref", "-d", tmpRef], timeoutMs);
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // best-effort cleanup of the scratch bundle path
    }
  }
}

/**
 * Preserve a lease's un-integrated work under
 * `<preservedRoot>/<campaign_id>/<node_id>/` and return the manifest that
 * proves it. Verifies every artifact's bytes before returning `ok: true`;
 * any failure at any step returns `ok: false` with an actionable reason and
 * writes NOTHING that a caller would need to clean up (a scratch index/
 * bundle path never lives outside this function, and content-addressed
 * artifacts that did get written are harmless leftovers, never partial).
 */
export function preserveWork(params: PreserveWorkParams): PreserveWorkResult {
  const timeoutMs = params.gitTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = params.now ?? new Date();

  if (!existsSync(params.worktreePath)) {
    return { ok: false, reason: `worktree ${params.worktreePath} does not exist; nothing to preserve` };
  }

  const dir = join(params.preservedRoot, params.campaignId, params.nodeId);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    return { ok: false, reason: `could not create preservation directory ${dir}: ${(error as Error).message}` };
  }

  let patchRef: PreservedArtifactRef | null = null;
  const patchResult = buildWorkingTreePatch(params.worktreePath, params.startingCommit, timeoutMs);
  if (!patchResult.ok) return { ok: false, reason: patchResult.reason };
  if (patchResult.patch.length > 0) {
    try {
      patchRef = writeContentAddressedArtifact(dir, "patch", Buffer.from(patchResult.patch, "utf-8"));
    } catch (error) {
      return { ok: false, reason: `could not write working-tree patch artifact: ${(error as Error).message}` };
    }
  }

  let bundleRef: PreservedArtifactRef | null = null;
  if (params.headCommit !== params.startingCommit) {
    const bundleResult = buildBundle(params.worktreePath, params.startingCommit, params.headCommit, timeoutMs);
    if (!bundleResult.ok) return { ok: false, reason: bundleResult.reason };
    try {
      bundleRef = writeContentAddressedArtifact(dir, "bundle", bundleResult.bundle);
    } catch (error) {
      return { ok: false, reason: `could not write bundle artifact: ${(error as Error).message}` };
    }
  }

  if (patchRef === null && bundleRef === null) {
    return { ok: false, reason: "no un-integrated content was found to preserve (dirty/unintegrated was reported but the patch and bundle were both empty)" };
  }

  if (!verifyArtifact(dir, patchRef) || !verifyArtifact(dir, bundleRef)) {
    return { ok: false, reason: "preserved artifact failed post-write verification (hash mismatch or unreadable)" };
  }

  const manifest: PreservationManifest = {
    node_id: params.nodeId,
    campaign_id: params.campaignId,
    branch: params.branch,
    starting_commit: params.startingCommit,
    head: params.headCommit,
    working_tree_id: patchResult.treeId,
    integration_rung: params.integrationRung,
    created_at: now.toISOString(),
    artifacts: { patch: patchRef, bundle: bundleRef },
  };
  const manifestPath = join(dir, "manifest.json");
  try {
    atomicWriteBinary(manifestPath, JSON.stringify(manifest, null, 2));
  } catch (error) {
    return { ok: false, reason: `could not write preservation manifest: ${(error as Error).message}` };
  }

  // Verify the manifest itself round-trips before trusting `ok: true`.
  try {
    const reread: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (JSON.stringify(reread) !== JSON.stringify(manifest)) {
      return { ok: false, reason: "preservation manifest failed post-write verification" };
    }
  } catch (error) {
    return { ok: false, reason: `preservation manifest could not be read back: ${(error as Error).message}` };
  }

  return { ok: true, manifestPath, manifest, workingTreeId: patchResult.treeId };
}
