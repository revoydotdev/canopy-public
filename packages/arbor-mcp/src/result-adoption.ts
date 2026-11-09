/**
 * Adopt-result: durably capture a campaign node's worktree changes before its
 * lease is released (worktrees are removed after every node — `loop.ts`), and
 * let an operator apply a verified node's captured changes to the main tree.
 *
 * The native harness is a tree-SEARCH system: it explores and verifies in
 * isolated worktrees and then discards them. That is correct for search, but it
 * means a genuinely useful, verified result would vanish with its worktree.
 * This module is the one governed bridge from "verified in a worktree" to "in
 * your working tree" — it is never automatic: capture is durable and passive;
 * adoption is an explicit, operator-invoked, preview-then-apply mutation.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJsonFile } from "./json-file.js";

export interface CapturedResult {
  readonly schema_version: 1;
  readonly campaign_id: string;
  readonly node_id: string;
  /** True only when the node reached command-evidenced verification. */
  readonly verified: boolean;
  /** The node's best score at capture, for operator ranking. */
  readonly score: number;
  /** Repository-relative paths the patch creates or modifies. */
  readonly files: readonly string[];
  /** Immutable action-authored authority used when this result was captured. */
  readonly declared_write_paths?: readonly string[];
  /** Changed paths outside declared authority. Non-empty always makes the capture unverified. */
  readonly scope_violations?: readonly string[];
  /**
   * The node's own verification outcome (command/critic), BEFORE the scope
   * check is applied. Lets `adoptCapturedResult` tell a genuine verification
   * failure apart from a result that only failed because of `scope_violations`
   * (WA-67) — the latter is the one case `--expand-scope` may override.
   */
  readonly command_verified?: boolean;
  /**
   * Structural provenance of `declared_write_paths` (ADR-065): "authored"
   * (operator/planner) scopes are enforced as a hard block upstream, so a
   * scope violation on an authored capture should never coincide with
   * `command_verified: true`. "mined" (heuristically text-derived) scopes are
   * enforced only as an audit observation upstream — an out-of-scope mined
   * capture can legitimately be `command_verified: true`, which is exactly
   * the adoptable-but-refused dead end this field lets the adopt path narrate
   * and, with explicit acknowledgment, resolve.
   */
  readonly scope_provenance?: "authored" | "mined";
  readonly captured_at: string;
  /** sha256 of the patch bytes; identity for idempotent re-capture. */
  readonly patch_sha256: string;
}

export interface CapturedResultInspection {
  readonly record: CapturedResult;
  readonly patch: {
    readonly content: string;
    readonly total_bytes: number;
    readonly truncated: boolean;
    readonly sha256: string;
  };
}

function git(cwd: string, args: readonly string[]): { code: number; stdout: string; stderr: string } {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]) delete env[key];
  const result = spawnSync("git", [...args], { cwd, stdio: "pipe", encoding: "utf-8", env });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function sha256(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

function isSafeId(value: string): boolean {
  return value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) && value !== "." && value !== "..";
}

const store = (persistenceDir: string, campaignId: string): string => join(persistenceDir, "adopt", campaignId);
const patchPath = (persistenceDir: string, campaignId: string, nodeId: string): string => join(store(persistenceDir, campaignId), `${nodeId}.patch`);
const metaPath = (persistenceDir: string, campaignId: string, nodeId: string): string => join(store(persistenceDir, campaignId), `${nodeId}.json`);
const expansionPath = (persistenceDir: string, campaignId: string, nodeId: string): string => join(store(persistenceDir, campaignId), `${nodeId}.scope-expansion.json`);
const scopeAuthorizationPath = (persistenceDir: string, campaignId: string, nodeId: string): string => join(store(persistenceDir, campaignId), `${nodeId}.scope-authorization.json`);

/**
 * WA-67 remedy: a durable, witnessed record of an operator's explicit
 * acknowledgment that a capture's out-of-scope files (`scope_violations`)
 * should be adopted anyway. Written only from `adoptCapturedResult`'s
 * `acknowledge_scope_expansion` path, and only for a capture whose
 * `command_verified` was already `true` — this never resurrects a genuinely
 * failed verification, it only witnesses an operator overriding the
 * capture-time scope gate. Mirrors the `CapturedComposition` manifest's
 * additive-JSON-record shape in this same store.
 */
export interface ScopeExpansionRecord {
  readonly schema_version: 1;
  readonly campaign_id: string;
  readonly node_id: string;
  /** The capture identity this acknowledgment is bound to; a later re-capture needs a fresh acknowledgment. */
  readonly patch_sha256: string;
  readonly declared_write_paths: readonly string[];
  readonly acknowledged_paths: readonly string[];
  readonly scope_provenance?: "authored" | "mined";
  readonly acknowledged_by: string;
  readonly acknowledged_at: string;
  /** The separate, hash-bound re-scope authority used for this adoption, when present. */
  readonly authorization_id?: string;
  /** Durable audit evidence supplied by the authorization service. */
  readonly authorization_evidence_id?: string;
}

/**
 * A separately recorded authorization to re-scope one exact captured patch.
 * `authorization_evidence_id` is deliberately opaque: the composition root
 * binds it to its signed/audited decision system (for example the manager's
 * scope-decision ledger) without making this storage-only module import a
 * runtime authority implementation.
 */
export interface ScopeExpansionAuthorization {
  readonly schema_version: 1;
  readonly authorization_id: string;
  readonly campaign_id: string;
  readonly node_id: string;
  readonly patch_sha256: string;
  readonly declared_write_paths: readonly string[];
  readonly authorized_paths: readonly string[];
  readonly authorized_by: string;
  readonly authorization_evidence_id: string;
  readonly authorized_at: string;
}

export type ScopeExpansionAuthorizationOutcome =
  | { readonly ok: true; readonly authorization: ScopeExpansionAuthorization }
  | { readonly ok: false; readonly reason: string };

function recordScopeExpansion(input: {
  readonly persistence_dir: string;
  readonly campaign_id: string;
  readonly node_id: string;
  readonly patch_sha256: string;
  readonly declared_write_paths: readonly string[];
  readonly acknowledged_paths: readonly string[];
  readonly scope_provenance?: "authored" | "mined";
  readonly acknowledged_by: string;
  readonly authorization_id?: string;
  readonly authorization_evidence_id?: string;
  readonly now?: () => string;
}): ScopeExpansionRecord {
  const record: ScopeExpansionRecord = {
    schema_version: 1,
    campaign_id: input.campaign_id,
    node_id: input.node_id,
    patch_sha256: input.patch_sha256,
    declared_write_paths: Object.freeze([...input.declared_write_paths]),
    acknowledged_paths: Object.freeze([...input.acknowledged_paths]),
    ...(input.scope_provenance === undefined ? {} : { scope_provenance: input.scope_provenance }),
    acknowledged_by: input.acknowledged_by,
    acknowledged_at: (input.now ?? (() => new Date().toISOString()))(),
    ...(input.authorization_id === undefined ? {} : { authorization_id: input.authorization_id }),
    ...(input.authorization_evidence_id === undefined ? {} : { authorization_evidence_id: input.authorization_evidence_id }),
  };
  durableWrite(expansionPath(input.persistence_dir, input.campaign_id, input.node_id), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** Read back a previously recorded scope expansion acknowledgment, or null when none exists. */
export function readScopeExpansion(persistenceDir: string, campaignId: string, nodeId: string): ScopeExpansionRecord | null {
  assertSafeId(campaignId, "campaign_id");
  assertSafeId(nodeId, "node_id");
  const path = expansionPath(persistenceDir, campaignId, nodeId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const record = parsed as Partial<ScopeExpansionRecord>;
    if (record.schema_version !== 1 || record.campaign_id !== campaignId || record.node_id !== nodeId
      || typeof record.patch_sha256 !== "string" || !Array.isArray(record.declared_write_paths)
      || !Array.isArray(record.acknowledged_paths) || typeof record.acknowledged_by !== "string"
      || typeof record.acknowledged_at !== "string") return null;
    return record as ScopeExpansionRecord;
  } catch {
    return null;
  }
}

/** Read a separately-issued, patch-bound re-scope authorization. */
export function readScopeExpansionAuthorization(persistenceDir: string, campaignId: string, nodeId: string): ScopeExpansionAuthorization | null {
  assertSafeId(campaignId, "campaign_id");
  assertSafeId(nodeId, "node_id");
  const path = scopeAuthorizationPath(persistenceDir, campaignId, nodeId);
  if (!existsSync(path)) return null;
  try {
    const record = readJsonFile(path) as Partial<ScopeExpansionAuthorization>;
    if (record.schema_version !== 1 || record.campaign_id !== campaignId || record.node_id !== nodeId
      || typeof record.authorization_id !== "string" || !isSafeId(record.authorization_id)
      || typeof record.patch_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.patch_sha256)
      || !Array.isArray(record.declared_write_paths) || !record.declared_write_paths.every(isSafeRelativePath)
      || !Array.isArray(record.authorized_paths) || !record.authorized_paths.every(isSafeRelativePath)
      || typeof record.authorized_by !== "string" || record.authorized_by.trim().length === 0
      || typeof record.authorization_evidence_id !== "string" || record.authorization_evidence_id.trim().length === 0
      || typeof record.authorized_at !== "string") return null;
    return record as ScopeExpansionAuthorization;
  } catch {
    return null;
  }
}

/**
 * Persist an explicit re-scope decision before any patch application. This is
 * intentionally a separate operation from `adoptCapturedResult`: retries of
 * either step remain inspectable, and a caller cannot accidentally turn a
 * reviewed patch into a wider authority merely by asking to apply it.
 */
export function authorizeScopeExpansion(input: {
  readonly campaign_id: string;
  readonly node_id: string;
  readonly persistence_dir: string;
  readonly expected_patch_sha256: string;
  readonly authorization_id: string;
  readonly authorized_by: string;
  readonly authorization_evidence_id: string;
  readonly authorized_paths?: readonly string[];
  readonly now?: () => string;
}): ScopeExpansionAuthorizationOutcome {
  try {
    assertSafeId(input.campaign_id, "campaign_id");
    assertSafeId(input.node_id, "node_id");
    assertSafeId(input.authorization_id, "authorization_id");
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "scope authorization identity is invalid" };
  }
  if (!input.authorized_by.trim() || input.authorized_by.length > 256) return { ok: false, reason: "scope authorization requires a bounded authorized_by identity" };
  if (!input.authorization_evidence_id.trim() || input.authorization_evidence_id.length > 512) return { ok: false, reason: "scope authorization requires durable authorization_evidence_id" };
  let record: CapturedResult | null = null;
  try { record = readJsonFile(metaPath(input.persistence_dir, input.campaign_id, input.node_id)) as CapturedResult; } catch { /* validated below */ }
  if (record === null || record.schema_version !== 1 || record.campaign_id !== input.campaign_id || record.node_id !== input.node_id) return { ok: false, reason: "captured result metadata is missing or does not match the requested result" };
  if (record.patch_sha256 !== input.expected_patch_sha256) return { ok: false, reason: "captured result changed since it was inspected" };
  const violations = Array.isArray(record.scope_violations) ? [...record.scope_violations] : [];
  if (record.command_verified !== true || violations.length === 0) return { ok: false, reason: "only a command-verified capture blocked solely by declared scope can be re-scoped" };
  const requested = input.authorized_paths === undefined ? violations : [...input.authorized_paths];
  if (requested.length !== violations.length || new Set(requested).size !== requested.length || requested.some((path) => !violations.includes(path))) {
    return { ok: false, reason: "scope authorization must explicitly cover exactly the capture's observed out-of-scope paths" };
  }
  const authorization: ScopeExpansionAuthorization = {
    schema_version: 1,
    authorization_id: input.authorization_id,
    campaign_id: input.campaign_id,
    node_id: input.node_id,
    patch_sha256: record.patch_sha256,
    declared_write_paths: Object.freeze([...(record.declared_write_paths ?? [])]),
    authorized_paths: Object.freeze([...requested].sort()),
    authorized_by: input.authorized_by,
    authorization_evidence_id: input.authorization_evidence_id,
    authorized_at: (input.now ?? (() => new Date().toISOString()))(),
  };
  const existing = readScopeExpansionAuthorization(input.persistence_dir, input.campaign_id, input.node_id);
  if (existing !== null) {
    return existing.authorization_id === authorization.authorization_id
      && existing.patch_sha256 === authorization.patch_sha256
      && existing.authorized_by === authorization.authorized_by
      && existing.authorization_evidence_id === authorization.authorization_evidence_id
      && JSON.stringify(existing.declared_write_paths) === JSON.stringify(authorization.declared_write_paths)
      && JSON.stringify(existing.authorized_paths) === JSON.stringify(authorization.authorized_paths)
      ? { ok: true, authorization: existing }
      : { ok: false, reason: "a different scope authorization is already recorded for this capture; inspect it before replacing authority" };
  }
  durableWrite(scopeAuthorizationPath(input.persistence_dir, input.campaign_id, input.node_id), `${JSON.stringify(authorization, null, 2)}\n`);
  return { ok: true, authorization };
}

/**
 * Capture the worktree's full uncommitted change set (including new files) as a
 * durable, self-contained patch. Staging into the worktree's own index is safe
 * because the worktree is about to be removed. Returns null when there is
 * nothing to adopt (a node that changed no files). Idempotent by patch content.
 */
export function captureWorktreeResult(input: {
  readonly campaign_id: string;
  readonly node_id: string;
  readonly worktree_path: string;
  readonly verified: boolean;
  readonly score: number;
  readonly declared_write_paths?: readonly string[];
  /** See `CapturedResult.scope_provenance`. */
  readonly scope_provenance?: "authored" | "mined";
  readonly persistence_dir: string;
  readonly now?: () => string;
}): CapturedResult | null {
  assertSafeId(input.campaign_id, "campaign_id");
  assertSafeId(input.node_id, "node_id");
  if (!existsSync(input.worktree_path)) return null;
  // Stage everything so untracked files are included, then emit one applicable
  // binary-safe patch relative to the worktree's base.
  if (git(input.worktree_path, ["add", "-A"]).code !== 0) return null;
  const diff = git(input.worktree_path, ["diff", "--cached", "--binary"]);
  if (diff.code !== 0 || diff.stdout.trim().length === 0) return null;
  const nameStatus = git(input.worktree_path, ["diff", "--cached", "--name-only", "-z"]);
  const files = nameStatus.stdout.split("\0").filter((path) => path.length > 0);
  const declaredWritePaths = input.declared_write_paths === undefined ? undefined : [...input.declared_write_paths];
  const validDeclaration = declaredWritePaths === undefined || declaredWritePaths.every(isSafeRelativePath);
  const scopeViolations = declaredWritePaths === undefined
    ? []
    : validDeclaration
      ? files.filter((path) => !declaredWritePaths.includes(path))
      : [...files];

  const record: CapturedResult = {
    schema_version: 1,
    campaign_id: input.campaign_id,
    node_id: input.node_id,
    verified: input.verified && scopeViolations.length === 0,
    score: Number.isFinite(input.score) ? input.score : 0,
    files: Object.freeze(files),
    ...(declaredWritePaths === undefined ? {} : {
      declared_write_paths: Object.freeze(declaredWritePaths),
      scope_violations: Object.freeze(scopeViolations),
      command_verified: input.verified,
      ...(input.scope_provenance === undefined ? {} : { scope_provenance: input.scope_provenance }),
    }),
    captured_at: (input.now ?? (() => new Date().toISOString()))(),
    patch_sha256: sha256(diff.stdout),
  };
  mkdirSync(store(input.persistence_dir, input.campaign_id), { recursive: true });
  writeFileSync(patchPath(input.persistence_dir, input.campaign_id, input.node_id), diff.stdout, "utf8");
  writeFileSync(metaPath(input.persistence_dir, input.campaign_id, input.node_id), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

/**
 * D6 (2026-08-24): a selfhost campaign captures into the WORKTREE's own
 * `.arbor` (`runtime.persistenceRoot`, `selfhost.ts`), never the target
 * root's. `arbor adopt --campaign X` invoked from the target root resolves
 * `persistence_dir` from `cwd`, so it silently reads an empty store even
 * though the campaign's captures exist a few directories away. Two agents
 * independently misread that empty `captures: []` as "adoption is broken"
 * rather than "wrong cwd" — see `scratchpad/dogfood-defects.md`'s D6 entry.
 *
 * This locates a campaign's capture store before reporting emptiness, so a
 * caller (human or scripted) always gets one of three distinguishable
 * outcomes instead of a bare, ambiguous `[]`:
 *   - "found": the store exists directly under `primaryPersistenceDir`
 *     (whether or not it holds any captures — present-but-empty is still
 *     "found", distinct from "unknown campaign").
 *   - "found_in_worktree": no store at `primaryPersistenceDir`, but exactly
 *     one `<cwd>/.worktrees/*\/.arbor` store matches — that store is used
 *     automatically (its `persistence_dir` is reported so the caller can
 *     see where the data actually came from). When MORE than one worktree
 *     matches, the search stops short of guessing: `persistence_dir` is
 *     left `null` and every match is listed in `worktree_paths`, so the
 *     caller can pick the exact one rather than risk adopting from the
 *     wrong campaign incarnation.
 *   - "not_found": no store anywhere searched — a genuinely unknown
 *     campaign id, not merely an empty one.
 */
export interface CampaignCaptureLocation {
  readonly resolution: "found" | "found_in_worktree" | "not_found" | "ambiguous";
  /** The store to read from, or `null` when unresolved (`not_found`, or an ambiguous multi-worktree match). */
  readonly persistence_dir: string | null;
  readonly captures: readonly CapturedResult[];
  /** All worktree stores found to contain this campaign id (0, 1, or more than 1 — more than 1 means ambiguous). */
  readonly worktree_paths: readonly string[];
  /** Every persistence root actually checked, for a legible "not found under X, Y, Z" message. */
  readonly searched: readonly string[];
}

/** Locate a campaign's capture store: directly, in exactly one selfhost worktree, or nowhere. See `CampaignCaptureLocation`. */
export function locateCampaign(cwd: string, primaryPersistenceDir: string, campaignId: string): CampaignCaptureLocation {
  assertSafeId(campaignId, "campaign_id");
  const searched: string[] = [primaryPersistenceDir];
  if (existsSync(store(primaryPersistenceDir, campaignId))) {
    return { resolution: "found", persistence_dir: primaryPersistenceDir, captures: listCapturedResults(primaryPersistenceDir, campaignId), worktree_paths: [], searched };
  }
  // D6 (self-hosting blockers B6): the capture store lives under the
  // campaign's own persistence root — for selfhost, the throwaway worktree's
  // `.arbor/` — so a caller at the target root, at a clone elsewhere, or in
  // a nested worktree found nothing. Search every `.worktrees/*` up the
  // parent chain AND every worktree git itself knows about, dedupe, and
  // report ambiguity as ambiguity rather than as an empty store.
  const candidates = new Set<string>();
  let dir = cwd;
  for (let depth = 0; depth < 5; depth += 1) {
    const worktreesRoot = join(dir, ".worktrees");
    if (existsSync(worktreesRoot)) {
      for (const entry of readdirSync(worktreesRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.add(join(worktreesRoot, entry.name, ".arbor"));
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const worktreePath of gitWorktreePaths(cwd)) candidates.add(join(worktreePath, ".arbor"));
  candidates.delete(primaryPersistenceDir);
  const matches: string[] = [];
  for (const candidateDir of [...candidates].sort()) {
    searched.push(candidateDir);
    if (existsSync(store(candidateDir, campaignId))) matches.push(candidateDir);
  }
  if (matches.length === 0) return { resolution: "not_found", persistence_dir: null, captures: [], worktree_paths: [], searched };
  if (matches.length === 1) return { resolution: "found_in_worktree", persistence_dir: matches[0]!, captures: listCapturedResults(matches[0]!, campaignId), worktree_paths: matches, searched };
  return { resolution: "ambiguous", persistence_dir: null, captures: [], worktree_paths: matches, searched };
}

/** Worktree roots git knows about from `cwd`, or none when `cwd` is not a repository. */
function gitWorktreePaths(cwd: string): string[] {
  const result = spawnSync("git", ["-C", cwd, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  if (result.status !== 0 || typeof result.stdout !== "string") return [];
  return result.stdout.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length).trim()).filter((path) => path.length > 0);
}

/**
 * A genuine capture's metadata file is exactly `<node_id>.json` — but the
 * store directory also holds sibling record kinds per node, all likewise
 * suffixed `.json` (`<node_id>.composition.json`, `.scope-expansion.json`,
 * `.scope-authorization.json`). Those share `schema_version: 1` and a
 * `node_id` field, so a bare `.endsWith(".json")` scan would mistake one for
 * a capture. Require the full `CapturedResult` shape, not just its identity
 * fields.
 */
function isCapturedResultRecord(value: unknown): value is CapturedResult {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<CapturedResult>;
  return record.schema_version === 1
    && typeof record.campaign_id === "string"
    && typeof record.node_id === "string"
    && typeof record.verified === "boolean"
    && typeof record.score === "number"
    && Array.isArray(record.files)
    && typeof record.patch_sha256 === "string"
    && typeof record.captured_at === "string";
}

/** Every captured result for a campaign, newest-scoring first (verified before unverified). */
export function listCapturedResults(persistenceDir: string, campaignId: string): readonly CapturedResult[] {
  assertSafeId(campaignId, "campaign_id");
  const dir = store(persistenceDir, campaignId);
  if (!existsSync(dir)) return [];
  const records: CapturedResult[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json") || entry.endsWith(".composition.json") || entry.endsWith(".scope-expansion.json") || entry.endsWith(".scope-authorization.json")) continue;
    try {
      const record = JSON.parse(readFileSync(join(dir, entry), "utf8")) as unknown;
      if (isCapturedResultRecord(record)) records.push(record);
    } catch { /* skip a corrupt record rather than fail the whole listing */ }
  }
  return records.sort((a, b) => (a.verified === b.verified ? b.score - a.score : a.verified ? -1 : 1));
}

/** The best verified capture for a campaign, or null when none is verified. */
export function bestVerifiedResult(persistenceDir: string, campaignId: string): CapturedResult | null {
  return listCapturedResults(persistenceDir, campaignId).find((record) => record.verified) ?? null;
}

const MAX_COMPOSITION_SOURCES = 64;
const MAX_COMPOSITION_FILES = 512;
const MAX_COMPOSITION_MANIFEST_BYTES = 128 * 1024;

/** Durable inherited-workspace state for a dependent verifier. */
export interface CapturedComposition {
  readonly schema_version: 1;
  readonly campaign_id: string;
  readonly node_id: string;
  /** Ordered patches materialized into the verifier worktree. */
  readonly source_node_ids: readonly string[];
  /** Ordered, de-duplicated paths inherited from those sources. */
  readonly files: readonly string[];
  /** Content identity after composition, or null when the inherited path is deleted. */
  readonly baseline_hashes: Readonly<Record<string, string | null>>;
}

export type ComposeCapturedResultsOutcome =
  | { readonly ok: true; readonly record: CapturedComposition }
  | { readonly ok: false; readonly reason: string };

function compositionPath(persistenceDir: string, campaignId: string, nodeId: string): string {
  return join(store(persistenceDir, campaignId), `${nodeId}.composition.json`);
}

function validCapturedSource(value: unknown, campaignId: string, nodeId: string): value is CapturedResult {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<CapturedResult>;
  return record.schema_version === 1
    && record.campaign_id === campaignId
    && record.node_id === nodeId
    && typeof record.patch_sha256 === "string"
    && /^[0-9a-f]{64}$/.test(record.patch_sha256)
    && Array.isArray(record.files)
    && record.files.length <= MAX_COMPOSITION_FILES
    && record.files.every((file) => typeof file === "string" && isSafeRelativePath(file))
    && (record.scope_violations === undefined
      || (Array.isArray(record.scope_violations) && record.scope_violations.length === 0));
}

function readCapturedSource(persistenceDir: string, campaignId: string, nodeId: string):
  | { readonly ok: true; readonly record: CapturedResult; readonly patch_path: string }
  | { readonly ok: false; readonly reason: string } {
  const metadataPath = metaPath(persistenceDir, campaignId, nodeId);
  const patch = patchPath(persistenceDir, campaignId, nodeId);
  if (!existsSync(metadataPath) || !existsSync(patch)) {
    return { ok: false, reason: `required source capture ${nodeId} is missing` };
  }
  try {
    const record = JSON.parse(readFileSync(metadataPath, "utf8")) as unknown;
    if (!validCapturedSource(record, campaignId, nodeId)) {
      return { ok: false, reason: `required source capture ${nodeId} has invalid metadata` };
    }
    if (sha256(readFileSync(patch)) !== record.patch_sha256) {
      return { ok: false, reason: `required source capture ${nodeId} failed integrity validation` };
    }
    return { ok: true, record, patch_path: patch };
  } catch {
    return { ok: false, reason: `required source capture ${nodeId} could not be read` };
  }
}

function isCapturedComposition(value: unknown, campaignId: string, nodeId: string): value is CapturedComposition {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<CapturedComposition>;
  if (record.schema_version !== 1 || record.campaign_id !== campaignId || record.node_id !== nodeId
    || !Array.isArray(record.source_node_ids) || !Array.isArray(record.files)
    || record.source_node_ids.length > MAX_COMPOSITION_SOURCES || record.files.length > MAX_COMPOSITION_FILES
    || !record.source_node_ids.every((source) => typeof source === "string" && isSafeId(source))
    || !record.files.every((file) => typeof file === "string" && isSafeRelativePath(file))
    || !record.baseline_hashes || typeof record.baseline_hashes !== "object" || Array.isArray(record.baseline_hashes)) return false;
  const hashes = record.baseline_hashes as Record<string, unknown>;
  return Object.keys(hashes).length === record.files.length
    && record.files.every((file) => Object.hasOwn(hashes, file)
      && (hashes[file] === null || (typeof hashes[file] === "string" && /^[0-9a-f]{64}$/.test(hashes[file]))));
}

/**
 * Load a composition manifest only when its bounded, campaign-scoped shape is
 * valid. Invalid or oversized manifests are evidence failures, never input to
 * a later verifier.
 */
export function readCapturedComposition(persistenceDir: string, campaignId: string, nodeId: string): CapturedComposition | null {
  assertSafeId(campaignId, "campaign_id");
  assertSafeId(nodeId, "node_id");
  const path = compositionPath(persistenceDir, campaignId, nodeId);
  if (!existsSync(path)) return null;
  try {
    const bytes = readFileSync(path);
    if (bytes.byteLength > MAX_COMPOSITION_MANIFEST_BYTES) return null;
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    return isCapturedComposition(parsed, campaignId, nodeId) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Materialize previously captured ancestor/prerequisite patches into a fresh
 * verifier worktree. Sources need not themselves be verified: the verifier's
 * later capture is the authority-bearing aggregate. Every source is still
 * integrity- and scope-checked, and any failure leaves no composition record.
 */
export function composeCapturedResults(input: {
  readonly persistence_dir: string;
  readonly campaign_id: string;
  readonly node_id: string;
  readonly worktree_path: string;
  readonly source_node_ids: readonly string[];
  /** Governed, author-declared read-only dependencies that correctly produced no patch. */
  readonly empty_source_node_ids?: readonly string[];
}): ComposeCapturedResultsOutcome {
  try {
    assertSafeId(input.campaign_id, "campaign_id");
    assertSafeId(input.node_id, "node_id");
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "invalid composition identity" };
  }
  if (!existsSync(input.worktree_path)) return { ok: false, reason: "composition worktree is missing" };
  if (input.source_node_ids.length > MAX_COMPOSITION_SOURCES) return { ok: false, reason: "composition has too many source captures" };
  const declaredSourceNodeIds = [...input.source_node_ids];
  if (new Set(declaredSourceNodeIds).size !== declaredSourceNodeIds.length) return { ok: false, reason: "composition source IDs must be unique" };
  const emptySourceNodeIds = new Set(input.empty_source_node_ids ?? []);
  if (emptySourceNodeIds.size !== (input.empty_source_node_ids?.length ?? 0) || [...emptySourceNodeIds].some((sourceNodeId) => !declaredSourceNodeIds.includes(sourceNodeId))) return { ok: false, reason: "empty composition sources must be unique requested source IDs" };
  for (const sourceNodeId of declaredSourceNodeIds) {
    try {
      assertSafeId(sourceNodeId, "source_node_id");
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "invalid source identity" };
    }
  }

  // Captures produced after workspace composition are cumulative patches
  // against the campaign base. If a verifier names both an ancestor capture
  // and a descendant that already materialized that ancestor, applying both
  // duplicates the ancestor (commonly "already exists in index"). Reduce the
  // requested set to maximal descendants using only bounded, validated
  // composition manifests. A missing/invalid manifest grants no reduction;
  // the ordinary git-apply path then remains fail closed.
  const coveredSourceIds = new Set<string>();
  const expandedCompositionIds = new Set<string>();
  const pendingCompositionIds = [...declaredSourceNodeIds];
  while (pendingCompositionIds.length > 0) {
    const candidate = pendingCompositionIds.pop()!;
    if (expandedCompositionIds.has(candidate)) continue;
    expandedCompositionIds.add(candidate);
    if (expandedCompositionIds.size > MAX_COMPOSITION_SOURCES) return { ok: false, reason: "composition ancestry exceeds its source bound" };
    const composition = readCapturedComposition(input.persistence_dir, input.campaign_id, candidate);
    if (composition === null) continue;
    for (const ancestor of composition.source_node_ids) {
      coveredSourceIds.add(ancestor);
      if (!expandedCompositionIds.has(ancestor)) pendingCompositionIds.push(ancestor);
    }
  }
  const sourceNodeIds = declaredSourceNodeIds.filter((sourceNodeId) => !coveredSourceIds.has(sourceNodeId));
  if (sourceNodeIds.length === 0 && declaredSourceNodeIds.length > 0) return { ok: false, reason: "composition ancestry contains a cycle" };

  const sources: { readonly ok: true; readonly record: CapturedResult; readonly patch_path: string }[] = [];
  for (const sourceNodeId of sourceNodeIds) {
    const source = readCapturedSource(input.persistence_dir, input.campaign_id, sourceNodeId);
    if (!source.ok) {
      if (emptySourceNodeIds.has(sourceNodeId) && source.reason === `required source capture ${sourceNodeId} is missing`) continue;
      return source;
    }
    sources.push(source);
  }

  // Compute the full union of inherited paths from source METADATA only
  // (no worktree mutation yet) so an over-bound composition can be refused
  // before any patch is applied — a rejected composition must leave the
  // verifier worktree exactly as it started, never half (or fully) mutated
  // with no manifest to explain it.
  const files: string[] = [];
  const seenFiles = new Set<string>();
  for (const source of sources) {
    for (const file of source.record.files) {
      if (!seenFiles.has(file)) {
        seenFiles.add(file);
        files.push(file);
      }
    }
  }
  if (files.length > MAX_COMPOSITION_FILES) return { ok: false, reason: "composition changes too many paths" };

  for (const source of sources) {
    const applied = git(input.worktree_path, ["apply", "--index", "--whitespace=nowarn", source.patch_path]);
    if (applied.code !== 0) {
      return { ok: false, reason: `required source capture ${source.record.node_id} does not apply cleanly: ${(applied.stderr || applied.stdout).trim() || "git apply failed"}` };
    }
  }

  const baselineHashes: Record<string, string | null> = {};
  for (const file of files) {
    const path = join(input.worktree_path, file);
    try {
      baselineHashes[file] = existsSync(path) ? sha256(readFileSync(path)) : null;
    } catch {
      return { ok: false, reason: `could not hash inherited path ${file}` };
    }
  }
  const record: CapturedComposition = {
    schema_version: 1,
    campaign_id: input.campaign_id,
    node_id: input.node_id,
    source_node_ids: Object.freeze(sources.map((source) => source.record.node_id)),
    files: Object.freeze(files),
    baseline_hashes: Object.freeze(baselineHashes),
  };
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_COMPOSITION_MANIFEST_BYTES) {
    return { ok: false, reason: "composition manifest exceeds its byte bound" };
  }
  try {
    mkdirSync(store(input.persistence_dir, input.campaign_id), { recursive: true });
    writeFileSync(compositionPath(input.persistence_dir, input.campaign_id, input.node_id), serialized, "utf8");
    return { ok: true, record };
  } catch {
    return { ok: false, reason: "could not persist composition manifest" };
  }
}

/**
 * Read a bounded, integrity-checked captured patch for operator review.
 * This is deliberately separate from adoption: inspecting bytes grants no
 * mutation authority, and a corrupt/mismatched patch is refused rather than
 * rendered as if it were the captured result named by metadata.
 */
export function inspectCapturedResult(input: {
  readonly persistence_dir: string;
  readonly campaign_id: string;
  readonly node_id: string;
  readonly max_patch_bytes?: number;
}): CapturedResultInspection {
  assertSafeId(input.campaign_id, "campaign_id");
  assertSafeId(input.node_id, "node_id");
  const maximum = input.max_patch_bytes ?? 128 * 1024;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1_048_576) throw new Error("max_patch_bytes must be from 1 to 1048576");
  const metadata = metaPath(input.persistence_dir, input.campaign_id, input.node_id);
  const patch = patchPath(input.persistence_dir, input.campaign_id, input.node_id);
  if (!existsSync(metadata) || !existsSync(patch)) throw new Error(`captured result ${input.node_id} was not found`);
  const record = listCapturedResults(input.persistence_dir, input.campaign_id).find((candidate) => candidate.node_id === input.node_id);
  if (record === undefined || record.schema_version !== 1 || record.campaign_id !== input.campaign_id || !Array.isArray(record.files)) throw new Error("captured result metadata is invalid");
  const content = readFileSync(patch, "utf8");
  const digest = sha256(content);
  if (record.patch_sha256 !== digest) throw new Error(`captured result ${input.node_id} patch integrity check failed`);
  const bytes = Buffer.from(content, "utf8");
  return {
    record: { ...record, files: [...record.files] },
    patch: { content: bytes.subarray(0, maximum).toString("utf8"), total_bytes: bytes.byteLength, truncated: bytes.byteLength > maximum, sha256: digest },
  };
}

export type AdoptOutcome =
  | { readonly ok: true; readonly applied: true; readonly node_id: string; readonly files: readonly string[] }
  | { readonly ok: false; readonly reason: string };
export type RevertOutcome =
  | { readonly ok: true; readonly reverted: true; readonly node_id: string; readonly files: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Apply a captured node's patch to `target_root` (the operator's working tree).
 * `check_only` runs `git apply --check` for a preview that mutates nothing.
 * Refuses when the patch does not exist or does not apply cleanly — it never
 * force-applies over a conflict.
 */
export function adoptCapturedResult(input: {
  readonly campaign_id: string;
  readonly node_id: string;
  readonly persistence_dir: string;
  readonly target_root: string;
  readonly check_only?: boolean;
  readonly expected_patch_sha256?: string;
  readonly files?: readonly string[];
  /**
   * WA-67 remedy: explicit operator acknowledgment that this capture's
   * `scope_violations` should be adopted despite the declared write scope.
   * Only rescues a capture whose underlying verification already succeeded
   * (`command_verified: true`) — it can never rescue a capture that failed
   * verification for an unrelated reason. Requires `expected_patch_sha256`,
   * the same digest-bound confirmation the ordinary adopt path uses, so the
   * acknowledgment is bound to the exact reviewed patch. Records a durable
   * `ScopeExpansionRecord` (see `readScopeExpansion`) before applying.
   */
  readonly acknowledge_scope_expansion?: boolean;
  /** Attribution for the durable `ScopeExpansionRecord`; defaults to "cli-operator". */
  readonly acknowledged_by?: string;
  /**
   * Preferred D51 path: a separately persisted re-scope authorization. Its
   * record is bound to this exact capture hash and is consumed only when this
   * id matches, so authorizing scope and applying a patch are two auditable
   * operations rather than one overloaded boolean.
   */
  readonly scope_expansion_authorization_id?: string;
}): AdoptOutcome {
  try {
    assertSafeId(input.campaign_id, "campaign_id");
    assertSafeId(input.node_id, "node_id");
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "captured result identity is invalid" };
  }
  const patch = patchPath(input.persistence_dir, input.campaign_id, input.node_id);
  if (!existsSync(patch)) return { ok: false, reason: `no captured patch for node ${input.node_id} in campaign ${input.campaign_id}` };
  const metaFile = metaPath(input.persistence_dir, input.campaign_id, input.node_id);
  let record: CapturedResult | null = null;
  try { record = JSON.parse(readFileSync(metaFile, "utf8")) as CapturedResult; } catch { record = null; }
  if (record === null || record.schema_version !== 1 || record.campaign_id !== input.campaign_id || record.node_id !== input.node_id) {
    return { ok: false, reason: "captured result metadata is missing or does not match the requested result" };
  }
  if (input.acknowledge_scope_expansion === true && input.expected_patch_sha256 === undefined) {
    return { ok: false, reason: "--expand-scope requires expected_patch_sha256 (inspect the capture first and pass its digest, mirroring the ordinary adopt confirmation)" };
  }
  if (record.verified !== true) {
    const scopeViolations = Array.isArray(record.scope_violations) ? record.scope_violations : [];
    const declaredScope = Array.isArray(record.declared_write_paths) ? record.declared_write_paths : [];
    // A mismatch here means the underlying verification (command + critic)
    // already succeeded and the ONLY reason capture is unverified is that the
    // diff exceeds the declared scope — the WA-67 dead end. Any other
    // failure (command_verified is false or absent) is a genuine
    // verification failure `--expand-scope` cannot and must not rescue.
    const scopeOnlyFailure = scopeViolations.length > 0 && record.command_verified === true;
    const authorization = input.scope_expansion_authorization_id === undefined
      ? null
      : readScopeExpansionAuthorization(input.persistence_dir, input.campaign_id, input.node_id);
    const authorizedBySeparateStep = authorization !== null
      && authorization.authorization_id === input.scope_expansion_authorization_id
      && authorization.patch_sha256 === record.patch_sha256
      && authorization.authorized_paths.length === scopeViolations.length
      && authorization.authorized_paths.every((path) => scopeViolations.includes(path));
    if (scopeOnlyFailure && input.scope_expansion_authorization_id !== undefined && !authorizedBySeparateStep) {
      return { ok: false, reason: "scope expansion authorization is missing, does not match this exact patch, or does not cover every observed out-of-scope path" };
    } else if (scopeOnlyFailure && authorizedBySeparateStep && input.expected_patch_sha256 === record.patch_sha256) {
      recordScopeExpansion({
        persistence_dir: input.persistence_dir,
        campaign_id: input.campaign_id,
        node_id: input.node_id,
        patch_sha256: record.patch_sha256,
        declared_write_paths: declaredScope,
        acknowledged_paths: scopeViolations,
        ...(record.scope_provenance === undefined ? {} : { scope_provenance: record.scope_provenance }),
        acknowledged_by: authorization.authorized_by,
        authorization_id: authorization.authorization_id,
        authorization_evidence_id: authorization.authorization_evidence_id,
      });
    } else if (scopeOnlyFailure && input.acknowledge_scope_expansion === true && input.expected_patch_sha256 === record.patch_sha256) {
      recordScopeExpansion({
        persistence_dir: input.persistence_dir,
        campaign_id: input.campaign_id,
        node_id: input.node_id,
        patch_sha256: record.patch_sha256,
        declared_write_paths: declaredScope,
        acknowledged_paths: scopeViolations,
        ...(record.scope_provenance === undefined ? {} : { scope_provenance: record.scope_provenance }),
        acknowledged_by: input.acknowledged_by ?? "cli-operator",
      });
      // Fall through to the ordinary apply path below: the acknowledgment is
      // now durably witnessed, and adoption proceeds like any other capture.
    } else if (scopeViolations.length === 0) {
      return { ok: false, reason: `captured result ${input.node_id} is not verified` };
    } else {
      const base = `captured result ${input.node_id} is not verified because changed files exceed its declared write scope: ${scopeViolations.join(", ")}`;
      if (!scopeOnlyFailure) return { ok: false, reason: base };
      const provenanceLabel = record.scope_provenance === "authored"
        ? "operator/planner-authored, enforced as a hard block per ADR-065"
        : record.scope_provenance === "mined"
          ? "heuristically mined from the task text, enforced only as an audit observation during verification per ADR-065"
          : "of unrecorded provenance";
      return { ok: false, reason: `${base} (declared write scope, ${provenanceLabel}: ${declaredScope.join(", ") || "none"}). `
        + `First record a hash-bound scope authorization, then adopt it with that authorization id. Legacy explicit --expand-scope remains available during CLI migration.` };
    }
  }
  const patchContents = readFileSync(patch, "utf8");
  if (record.patch_sha256 !== sha256(patchContents)) return { ok: false, reason: `captured result ${input.node_id} patch integrity check failed` };
  if (input.expected_patch_sha256 !== undefined && record.patch_sha256 !== input.expected_patch_sha256) return { ok: false, reason: `captured result ${input.node_id} changed since it was inspected` };

  const selectedFiles = input.files === undefined ? [...record.files] : [...input.files];
  if (selectedFiles.length === 0) return { ok: false, reason: "at least one captured file must be selected for adoption" };
  if (new Set(selectedFiles).size !== selectedFiles.length || selectedFiles.some((path) => !record.files.includes(path))) return { ok: false, reason: "selected adoption files must be a unique subset of the captured result manifest" };
  const literalPattern = (path: string): string => path.replace(/[\\*?\[\]]/g, "\\$&");
  const includeArgs = selectedFiles.length === record.files.length ? [] : selectedFiles.map((path) => `--include=${literalPattern(path)}`);

  const check = git(input.target_root, ["apply", "--check", ...includeArgs, patch]);
  if (check.code !== 0) return { ok: false, reason: `patch does not apply cleanly to ${input.target_root}: ${check.stderr.trim() || "conflict"}` };
  if (input.check_only === true) return { ok: true, applied: true, node_id: input.node_id, files: selectedFiles };
  const applied = git(input.target_root, ["apply", ...includeArgs, patch]);
  if (applied.code !== 0) return { ok: false, reason: `git apply failed after a clean check: ${applied.stderr.trim()}` };
  return { ok: true, applied: true, node_id: input.node_id, files: selectedFiles };
}

/** Reverse an exact previously adopted subset, refusing any workspace divergence. */
export function revertCapturedResult(input: {
  readonly campaign_id: string;
  readonly node_id: string;
  readonly persistence_dir: string;
  readonly target_root: string;
  readonly expected_patch_sha256: string;
  readonly files?: readonly string[];
}): RevertOutcome {
  try {
    const inspection = inspectCapturedResult({ persistence_dir: input.persistence_dir, campaign_id: input.campaign_id, node_id: input.node_id, max_patch_bytes: 1 });
    if (!inspection.record.verified) return { ok: false, reason: `captured result ${input.node_id} is not verified` };
    if (inspection.record.patch_sha256 !== input.expected_patch_sha256) return { ok: false, reason: `captured result ${input.node_id} changed since it was adopted` };
    const selectedFiles = input.files === undefined ? [...inspection.record.files] : [...input.files];
    if (selectedFiles.length === 0 || new Set(selectedFiles).size !== selectedFiles.length || selectedFiles.some((path) => !inspection.record.files.includes(path))) return { ok: false, reason: "revert files must be the adopted subset of the captured result manifest" };
    const literalPattern = (path: string): string => path.replace(/[\\*?\[\]]/g, "\\$&");
    const includeArgs = selectedFiles.length === inspection.record.files.length ? [] : selectedFiles.map((path) => `--include=${literalPattern(path)}`);
    const patch = patchPath(input.persistence_dir, input.campaign_id, input.node_id);
    const check = git(input.target_root, ["apply", "--reverse", "--check", ...includeArgs, patch]);
    if (check.code !== 0) return { ok: false, reason: `adopted patch cannot be reverted cleanly from ${input.target_root}: ${check.stderr.trim() || "conflict"}` };
    const reverted = git(input.target_root, ["apply", "--reverse", ...includeArgs, patch]);
    if (reverted.code !== 0) return { ok: false, reason: `git reverse-apply failed after a clean check: ${reverted.stderr.trim()}` };
    return { ok: true, reverted: true, node_id: input.node_id, files: selectedFiles };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "captured result could not be reverted" };
  }
}

function assertSafeId(value: string, field: string): void {
  if (value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) || value === "." || value === "..") throw new Error(`${field} must be a safe path segment`);
}

function isSafeRelativePath(value: string): boolean {
  return value.length > 0
    && value.length <= 512
    && !value.startsWith("/")
    && !value.includes("\0")
    && !value.split("/").includes("..");
}

/** Atomic fsync-backed write for authorization/audit artifacts. */
function durableWrite(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, data, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

export { patchPath as capturedPatchPath, metaPath as capturedMetaPath };
