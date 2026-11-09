/**
 * Revision-bound validation receipts and conservative Flight reuse decisions.
 *
 * This module intentionally owns neither gate policy nor test dispatch.  Its
 * inputs are the already-parsed execution profile and the already-derived
 * Flight plan.  It answers only whether a previously completed, externally
 * signed result may stand for one exact or provably unchanged descendant input.
 */
import { createHash, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireWriterLock, type WriterLockHandle } from "@arbor/core";
import { isRepoFlightDigest, isRepoFlightGitOid, isRepoFlightRepositoryId, type RepoFlightRunRepositoryIdentity } from "./repo-flight-contracts.js";

export const REPO_FLIGHT_VALIDATION_SCHEMA_VERSION = 1 as const;
export const REPO_FLIGHT_NORMALIZED_SOURCE_ROOT = "repo-relative-v1" as const;

type Sha256 = `sha256:${string}`;
type IsoInstant = string;

export interface RepoFlightValidationCandidate {
  readonly candidate_oid: string;
  readonly input_digest: Sha256;
}

export interface RepoFlightRuntimeIdentity {
  readonly runtime: Readonly<Record<string, string>>;
  readonly toolchain: Readonly<Record<string, string>>;
  readonly platform: { readonly os: string; readonly arch: string; readonly abi: string };
}

export interface RepoFlightValidationFingerprintInput {
  readonly repository_id: RepoFlightRunRepositoryIdentity["repository_id"];
  readonly candidate: RepoFlightValidationCandidate;
  readonly profile_digest: Sha256;
  readonly gate_id: string;
  readonly argv: readonly string[];
  readonly runtime_identity: RepoFlightRuntimeIdentity;
  readonly lockfile_digest: Sha256;
  readonly environment: Readonly<Record<string, string>>;
  readonly configuration_digest: Sha256;
  readonly shard_manifest_digest: Sha256;
  /** Candidate-independent digest of the exact shard assignment/classification. */
  readonly shard_assignment_digest: Sha256;
  readonly artifact_digest: Sha256;
}

export interface RepoFlightValidationFingerprint extends RepoFlightValidationFingerprintInput {
  readonly schema_version: typeof REPO_FLIGHT_VALIDATION_SCHEMA_VERSION;
  readonly kind: "revoy2.repo_flight.validation_fingerprint";
  readonly gate_argv_digest: Sha256;
  readonly environment_digest: Sha256;
  readonly runtime_digest: Sha256;
  readonly fingerprint: Sha256;
}

export type RepoFlightValidationOutcome = "passed" | "failed" | "timed_out" | "interrupted" | "ambiguous";
export type RepoFlightValidationKind = "gate" | "coverage_shard" | "integration" | "full_audit" | "evidence_writer" | "nondeterminism_measurement" | "time_sensitive_governance";

export interface RepoFlightValidationProducer {
  readonly issuer_id: string;
  readonly key_id: string;
}

export interface RepoFlightValidationReceiptPayload {
  readonly schema_version: typeof REPO_FLIGHT_VALIDATION_SCHEMA_VERSION;
  readonly kind: "revoy2.repo_flight.validation_receipt";
  readonly receipt_id: string;
  readonly producer: RepoFlightValidationProducer;
  readonly validation_kind: RepoFlightValidationKind;
  readonly outcome: RepoFlightValidationOutcome;
  readonly artifact_complete: boolean;
  readonly issued_at: IsoInstant;
  readonly expires_at: IsoInstant;
  readonly fingerprint: RepoFlightValidationFingerprint;
}

export interface RepoFlightValidationReceipt extends RepoFlightValidationReceiptPayload {
  readonly signature: string;
}

export interface RepoFlightValidationTrustRoot {
  readonly issuer_id: string;
  readonly key_id: string;
  readonly public_key: KeyObject | string | Buffer;
  readonly revoked?: boolean;
}

export type RepoFlightValidationTrustRoots = ReadonlyMap<string, RepoFlightValidationTrustRoot> | Readonly<Record<string, RepoFlightValidationTrustRoot>>;

export type RepoFlightReceiptVerification =
  | { readonly ok: true; readonly receipt: RepoFlightValidationReceipt }
  | { readonly ok: false; readonly code: "malformed" | "trust_root_absent" | "trust_root_mismatch" | "issuer_revoked" | "signature_invalid" | "expired"; readonly reason: string };

export interface RepoFlightClosureNode {
  readonly node_id: string;
  readonly source_digest: Sha256;
  readonly target_digest: Sha256;
}

export interface RepoFlightTransitiveClosureProofPayload {
  readonly schema_version: typeof REPO_FLIGHT_VALIDATION_SCHEMA_VERSION;
  readonly kind: "revoy2.repo_flight.transitive_closure_proof";
  readonly proof_id: string;
  readonly producer: RepoFlightValidationProducer;
  readonly source_candidate: RepoFlightValidationCandidate;
  readonly target_candidate: RepoFlightValidationCandidate;
  readonly source_shard_manifest_digest: Sha256;
  readonly target_shard_manifest_digest: Sha256;
  readonly analyzer_version: string;
  readonly graph_digest: Sha256;
  readonly complete: boolean;
  readonly nodes: readonly RepoFlightClosureNode[];
  readonly unknown_edges: readonly string[];
  readonly dynamic_edges: readonly string[];
  readonly ambiguous_edges: readonly string[];
  readonly issued_at: IsoInstant;
  readonly expires_at: IsoInstant;
}

export interface RepoFlightTransitiveClosureProof extends RepoFlightTransitiveClosureProofPayload {
  readonly signature: string;
}

export type RepoFlightClosureVerification =
  | { readonly ok: true; readonly proof: RepoFlightTransitiveClosureProof }
  | { readonly ok: false; readonly code: "malformed" | "trust_root_absent" | "trust_root_mismatch" | "issuer_revoked" | "signature_invalid" | "expired" | "incomplete" | "input_changed"; readonly reason: string };

export type RepoFlightReuseDecision =
  | { readonly reusable: true; readonly mode: "exact" | "descendant"; readonly receipt: RepoFlightValidationReceipt }
  | { readonly reusable: false; readonly code: string; readonly reason: string };

export type RepoFlightValidationLane = "hermetic" | "serial";

export interface RepoFlightValidationTestFile {
  readonly path: string;
  readonly coverage_eligible: boolean;
  readonly serial_reason: string | null;
}

export interface RepoFlightValidationShard {
  readonly shard_id: string;
  readonly lane: RepoFlightValidationLane;
  readonly serial_reason: string | null;
  readonly files: readonly string[];
}

export interface RepoFlightValidationShardManifest {
  readonly schema_version: typeof REPO_FLIGHT_VALIDATION_SCHEMA_VERSION;
  readonly kind: "revoy2.repo_flight.validation_shard_manifest";
  readonly manifest_kind: "validation" | "coverage";
  readonly repository_id: RepoFlightRunRepositoryIdentity["repository_id"];
  readonly candidate: RepoFlightValidationCandidate;
  readonly profile_digest: Sha256;
  readonly classification_digest: Sha256;
  readonly hermetic_shard_count: number;
  readonly shards: readonly RepoFlightValidationShard[];
  /** Stable assignment identity; unlike manifest_digest it intentionally excludes candidate bytes. */
  readonly assignment_digest: Sha256;
  readonly manifest_digest: Sha256;
}

export interface RepoFlightValidationShardManifests {
  readonly validation: RepoFlightValidationShardManifest;
  readonly coverage: RepoFlightValidationShardManifest;
}

export interface RepoFlightCoverageShardArtifact {
  readonly shard_id: string;
  readonly effective_candidate: RepoFlightValidationCandidate;
  readonly manifest_digest: Sha256;
  readonly coverage_configuration_digest: Sha256;
  readonly toolchain_digest: Sha256;
  readonly normalized_source_root: typeof REPO_FLIGHT_NORMALIZED_SOURCE_ROOT;
  readonly artifact_digest: Sha256;
  readonly complete: boolean;
  readonly receipt: RepoFlightValidationReceipt;
  readonly reuse: { readonly mode: "executed" | "exact" | "descendant"; readonly closure_proof?: RepoFlightTransitiveClosureProof };
}

export type RepoFlightCoverageArtifactSetVerification =
  | { readonly ok: true; readonly artifact_digest: Sha256; readonly shard_count: number }
  | { readonly ok: false; readonly code: string; readonly reason: string };

export type RepoFlightFullAuditVerification =
  | { readonly ok: true; readonly receipt: RepoFlightValidationReceipt; readonly receipt_digest: Sha256 }
  | { readonly ok: false; readonly code: string; readonly reason: string };

export interface RepoFlightValidationCacheOptions {
  readonly persistence_dir: string;
  readonly trust_roots: RepoFlightValidationTrustRoots;
  readonly now?: () => Date;
  readonly max_receipts?: number;
}

interface RepoFlightValidationCacheState {
  readonly schema_version: 1;
  readonly receipts: readonly RepoFlightValidationReceipt[];
}

const MAX_TEXT_BYTES = 4096;
const MAX_ENVIRONMENT_ITEMS = 128;
const MAX_ARGV = 128;
const MAX_SHARD_FILES = 50_000;
const NON_REUSABLE_KINDS = new Set<RepoFlightValidationKind>(["evidence_writer", "nondeterminism_measurement", "time_sensitive_governance"]);

/**
 * A repository-local append-by-replacement receipt cache.  It preserves every
 * authenticated terminal result (including interrupted/failed records) so a
 * restart cannot silently convert an ambiguous outcome into a fresh cache hit.
 * Only the reuse evaluators below decide whether a stored result is reusable.
 */
export class RepoFlightValidationCache {
  private readonly path: string;
  private readonly lock: WriterLockHandle;
  private readonly now: () => Date;
  private readonly maxReceipts: number;
  private state: RepoFlightValidationCacheState;
  private closed = false;

  constructor(private readonly options: RepoFlightValidationCacheOptions) {
    if (!options.persistence_dir || Buffer.byteLength(options.persistence_dir) > MAX_TEXT_BYTES * 4) throw new Error("validation cache persistence directory is invalid");
    this.maxReceipts = options.max_receipts ?? 10_000;
    if (!Number.isSafeInteger(this.maxReceipts) || this.maxReceipts < 1 || this.maxReceipts > 100_000) throw new Error("validation cache receipt bound is invalid");
    this.now = options.now ?? (() => new Date());
    mkdirSync(options.persistence_dir, { recursive: true, mode: 0o700 });
    const acquired = acquireWriterLock(options.persistence_dir, { holder: "repo-flight-validation-cache" });
    if (!acquired.ok) throw new Error(acquired.detail);
    this.lock = acquired.lock;
    this.path = join(options.persistence_dir, "repo-flight-validation-cache.json");
    try { this.state = this.restore(); } catch (error) { this.lock.release(); throw error; }
  }

  close(): void { if (!this.closed) { this.closed = true; this.lock.release(); } }

  /** Persist one signed terminal result; same receipt id must be byte-identical. */
  record(value: unknown): { readonly ok: true; readonly receipt: RepoFlightValidationReceipt; readonly idempotent: boolean } | { readonly ok: false; readonly code: string; readonly reason: string } {
    this.assertOpen();
    const verified = verifyRepoFlightValidationReceipt(value, this.options.trust_roots, this.now());
    if (!verified.ok) return { ok: false, code: verified.code, reason: verified.reason };
    const existing = this.state.receipts.find((receipt) => receipt.receipt_id === verified.receipt.receipt_id);
    if (existing) {
      if (canonicalRepoFlightValidationJson(existing) !== canonicalRepoFlightValidationJson(verified.receipt)) return { ok: false, code: "receipt_id_conflict", reason: "receipt id was reused with different signed content" };
      return { ok: true, receipt: freeze(structuredClone(existing)), idempotent: true };
    }
    if (this.state.receipts.length >= this.maxReceipts) return { ok: false, code: "capacity", reason: "validation cache receipt capacity is exhausted; retain or archive receipts explicitly" };
    this.state = freeze({ schema_version: 1, receipts: freeze([...this.state.receipts, freeze(structuredClone(verified.receipt))]) });
    this.persist();
    return { ok: true, receipt: freeze(structuredClone(verified.receipt)), idempotent: false };
  }

  lookupExact(expected: RepoFlightValidationFingerprint): RepoFlightReuseDecision {
    this.assertOpen();
    const receipts = [...this.state.receipts].sort((left, right) => right.issued_at.localeCompare(left.issued_at) || right.receipt_id.localeCompare(left.receipt_id));
    for (const receipt of receipts) {
      const decision = evaluateRepoFlightExactReuse(receipt, expected, this.options.trust_roots, this.now());
      if (decision.reusable) return decision;
    }
    return noReuse("cache_miss", "no authenticated exact-candidate reusable receipt was found");
  }

  snapshot(): readonly RepoFlightValidationReceipt[] { this.assertOpen(); return freeze(this.state.receipts.map((receipt) => freeze(structuredClone(receipt)))); }

  private restore(): RepoFlightValidationCacheState {
    if (!existsSync(this.path)) return freeze({ schema_version: 1, receipts: freeze([]) });
    let value: unknown;
    try { value = JSON.parse(readFileSync(this.path, "utf8")); } catch { throw new Error("validation cache state is unreadable"); }
    if (!isRecord(value) || !hasExactKeys(value, ["schema_version", "receipts"]) || value.schema_version !== 1 || !Array.isArray(value.receipts) || value.receipts.length > this.maxReceipts) throw new Error("validation cache state is malformed");
    const receipts: RepoFlightValidationReceipt[] = [];
    for (const receipt of value.receipts) {
      // Expiry prevents reuse, not historical evidence retention. Verify the
      // signature against the issuer's still-current trust root at an instant
      // inside the original receipt window so an ordinary expired record cannot
      // brick cache recovery.
      const receiptIssuedAt = isRecord(receipt) ? Date.parse(receipt.issued_at as unknown as string) : Number.NaN;
      const verified = verifyRepoFlightValidationReceipt(receipt, this.options.trust_roots, Number.isFinite(receiptIssuedAt) ? new Date(receiptIssuedAt) : this.now());
      if (!verified.ok) throw new Error(`validation cache contains an untrusted receipt: ${verified.code}`);
      receipts.push(freeze(structuredClone(verified.receipt)));
    }
    if (new Set(receipts.map((receipt) => receipt.receipt_id)).size !== receipts.length) throw new Error("validation cache state contains duplicate receipt ids");
    return freeze({ schema_version: 1, receipts: freeze(receipts) });
  }

  private persist(): void {
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const descriptor = openSync(temporary, "wx", 0o600);
    try { writeFileSync(descriptor, `${canonicalRepoFlightValidationJson(this.state)}\n`, "utf8"); fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
    renameSync(temporary, this.path);
    const directory = openSync(dirname(this.path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }

  private assertOpen(): void { if (this.closed) throw new Error("validation cache is closed"); }
}

/** Canonical JSON is deliberate: no caller-controlled object key order reaches a hash or signature. */
export function canonicalRepoFlightValidationJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalRepoFlightValidationJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalRepoFlightValidationJson(item)}`)
    .join(",")}}`;
}

export function repoFlightValidationDigest(value: unknown): Sha256 {
  return `sha256:${createHash("sha256").update(canonicalRepoFlightValidationJson(value)).digest("hex")}`;
}

export function createRepoFlightValidationFingerprint(input: RepoFlightValidationFingerprintInput): RepoFlightValidationFingerprint {
  const normalized = normalizeFingerprintInput(input);
  const gate_argv_digest = repoFlightValidationDigest(normalized.argv);
  const environment_digest = repoFlightValidationDigest(normalized.environment);
  const runtime_digest = repoFlightValidationDigest(normalized.runtime_identity);
  const payload = {
    schema_version: REPO_FLIGHT_VALIDATION_SCHEMA_VERSION,
    kind: "revoy2.repo_flight.validation_fingerprint" as const,
    ...normalized,
    gate_argv_digest,
    environment_digest,
    runtime_digest,
  };
  return freeze({ ...payload, fingerprint: repoFlightValidationDigest(payload) });
}

export function signRepoFlightValidationReceipt(payload: RepoFlightValidationReceiptPayload, privateKey: KeyObject | string | Buffer): RepoFlightValidationReceipt {
  const normalized = normalizeReceiptPayload(payload);
  const signature = sign(null, Buffer.from(canonicalRepoFlightValidationJson(normalized)), privateKey).toString("base64url");
  return freeze({ ...normalized, signature });
}

export function verifyRepoFlightValidationReceipt(value: unknown, trustRoots: RepoFlightValidationTrustRoots, now: Date = new Date()): RepoFlightReceiptVerification {
  if (!validNow(now)) return failReceipt("malformed", "verification clock is invalid");
  if (!isRecord(value) || !hasExactKeys(value, receiptKeys())) return failReceipt("malformed", "validation receipt uses an unknown or missing schema");
  const receipt = value as RepoFlightValidationReceipt;
  try { normalizeReceiptPayload(stripSignature(receipt)); } catch (error) { return failReceipt("malformed", errorMessage(error)); }
  if (!validSignature(receipt.signature)) return failReceipt("malformed", "validation receipt signature is malformed");
  const root = trustRoot(trustRoots, receipt.producer.issuer_id);
  if (!root) return failReceipt("trust_root_absent", "validation receipt issuer is not in the external trust root");
  if (root.issuer_id !== receipt.producer.issuer_id || root.key_id !== receipt.producer.key_id) return failReceipt("trust_root_mismatch", "validation receipt producer does not match its trust-root key");
  if (root.revoked === true) return failReceipt("issuer_revoked", "validation receipt issuer key is revoked");
  if (Date.parse(receipt.expires_at) <= now.getTime()) return failReceipt("expired", "validation receipt is expired");
  const payload: RepoFlightValidationReceiptPayload = stripSignature(receipt);
  try {
    if (!verify(null, Buffer.from(canonicalRepoFlightValidationJson(payload)), root.public_key, Buffer.from(receipt.signature, "base64url"))) return failReceipt("signature_invalid", "validation receipt signature did not verify");
  } catch { return failReceipt("signature_invalid", "validation receipt signature could not be verified"); }
  return { ok: true, receipt: freeze(structuredClone(receipt)) };
}

/** Finalization accepts only a complete, successful, exact-identity uncached full-audit receipt. */
export function verifyRepoFlightFullAuditForFinalization(value: unknown, expected: RepoFlightValidationFingerprint, trustRoots: RepoFlightValidationTrustRoots, now: Date = new Date()): RepoFlightFullAuditVerification {
  const verified = verifyRepoFlightValidationReceipt(value, trustRoots, now);
  if (!verified.ok) return { ok: false, code: verified.code, reason: verified.reason };
  if (verified.receipt.validation_kind !== "full_audit") return { ok: false, code: "wrong_kind", reason: "finalization requires an uncached full-audit receipt" };
  if (verified.receipt.outcome !== "passed" || !verified.receipt.artifact_complete) return { ok: false, code: "incomplete", reason: "full audit did not complete successfully" };
  let normalizedExpected: RepoFlightValidationFingerprint;
  try { normalizedExpected = assertFingerprint(expected); } catch (error) { return { ok: false, code: "expected_fingerprint", reason: errorMessage(error) }; }
  if (canonicalRepoFlightValidationJson(verified.receipt.fingerprint) !== canonicalRepoFlightValidationJson(normalizedExpected)) return { ok: false, code: "identity_mismatch", reason: "full audit is bound to a different candidate, profile, toolchain, configuration, shard manifest, or artifact" };
  return { ok: true, receipt: verified.receipt, receipt_digest: repoFlightValidationDigest(verified.receipt) };
}

export function repoFlightFullAuditRequired(input: { readonly last_success_at: string | null; readonly now: string; readonly max_age_ms: number; readonly descendant_reuse: boolean; readonly impact_uncertain: boolean; readonly identity_changed: boolean }): boolean {
  if (!validInstant(input.now) || !Number.isSafeInteger(input.max_age_ms) || input.max_age_ms < 1) throw new Error("full-audit cadence input is invalid");
  if (input.descendant_reuse || input.impact_uncertain || input.identity_changed || input.last_success_at === null || !validInstant(input.last_success_at)) return true;
  return Date.parse(input.now) - Date.parse(input.last_success_at) >= input.max_age_ms;
}

export function signRepoFlightTransitiveClosureProof(payload: RepoFlightTransitiveClosureProofPayload, privateKey: KeyObject | string | Buffer): RepoFlightTransitiveClosureProof {
  const normalized = normalizeClosurePayload(payload);
  const signature = sign(null, Buffer.from(canonicalRepoFlightValidationJson(normalized)), privateKey).toString("base64url");
  return freeze({ ...normalized, signature });
}

export function verifyRepoFlightTransitiveClosureProof(value: unknown, trustRoots: RepoFlightValidationTrustRoots, now: Date = new Date()): RepoFlightClosureVerification {
  if (!validNow(now)) return failClosure("malformed", "verification clock is invalid");
  if (!isRecord(value) || !hasExactKeys(value, closureKeys())) return failClosure("malformed", "closure proof uses an unknown or missing schema");
  const proof = value as RepoFlightTransitiveClosureProof;
  try { normalizeClosurePayload(stripSignature(proof)); } catch (error) { return failClosure("malformed", errorMessage(error)); }
  if (!validSignature(proof.signature)) return failClosure("malformed", "closure proof signature is malformed");
  const root = trustRoot(trustRoots, proof.producer.issuer_id);
  if (!root) return failClosure("trust_root_absent", "closure proof issuer is not in the external trust root");
  if (root.issuer_id !== proof.producer.issuer_id || root.key_id !== proof.producer.key_id) return failClosure("trust_root_mismatch", "closure proof producer does not match its trust-root key");
  if (root.revoked === true) return failClosure("issuer_revoked", "closure proof issuer key is revoked");
  if (Date.parse(proof.expires_at) <= now.getTime()) return failClosure("expired", "closure proof is expired");
  try {
    if (!verify(null, Buffer.from(canonicalRepoFlightValidationJson(stripSignature(proof))), root.public_key, Buffer.from(proof.signature, "base64url"))) return failClosure("signature_invalid", "closure proof signature did not verify");
  } catch { return failClosure("signature_invalid", "closure proof signature could not be verified"); }
  if (!proof.complete || proof.unknown_edges.length > 0 || proof.dynamic_edges.length > 0 || proof.ambiguous_edges.length > 0) return failClosure("incomplete", "closure proof contains incomplete, dynamic, unknown, or ambiguous edges");
  if (proof.nodes.some((node) => node.source_digest !== node.target_digest)) return failClosure("input_changed", "a transitive closure input changed between candidates");
  return { ok: true, proof: freeze(structuredClone(proof)) };
}

export function evaluateRepoFlightExactReuse(receiptValue: unknown, expected: RepoFlightValidationFingerprint, trustRoots: RepoFlightValidationTrustRoots, now: Date = new Date()): RepoFlightReuseDecision {
  let normalizedExpected: RepoFlightValidationFingerprint;
  try { normalizedExpected = assertFingerprint(expected); } catch (error) { return noReuse("expected_fingerprint_invalid", errorMessage(error)); }
  const verified = verifyRepoFlightValidationReceipt(receiptValue, trustRoots, now);
  if (!verified.ok) return noReuse(`receipt_${verified.code}`, verified.reason);
  const eligible = reusableReceipt(verified.receipt);
  if (eligible !== null) return noReuse("receipt_not_reusable", eligible);
  return verified.receipt.fingerprint.fingerprint === normalizedExpected.fingerprint
    ? { reusable: true, mode: "exact", receipt: verified.receipt }
    : noReuse("fingerprint_mismatch", "validation fingerprint is not an exact match");
}

export function evaluateRepoFlightDescendantReuse(receiptValue: unknown, expected: RepoFlightValidationFingerprint, proofValue: unknown, trustRoots: RepoFlightValidationTrustRoots, now: Date = new Date()): RepoFlightReuseDecision {
  let normalizedExpected: RepoFlightValidationFingerprint;
  try { normalizedExpected = assertFingerprint(expected); } catch (error) { return noReuse("expected_fingerprint_invalid", errorMessage(error)); }
  const verifiedReceipt = verifyRepoFlightValidationReceipt(receiptValue, trustRoots, now);
  if (!verifiedReceipt.ok) return noReuse(`receipt_${verifiedReceipt.code}`, verifiedReceipt.reason);
  const eligible = reusableReceipt(verifiedReceipt.receipt);
  if (eligible !== null) return noReuse("receipt_not_reusable", eligible);
  const receipt = verifiedReceipt.receipt;
  if (!sameFingerprintExceptCandidate(receipt.fingerprint, normalizedExpected)) return noReuse("non_candidate_fingerprint_mismatch", "a descendant reuse input other than the candidate changed");
  if (sameCandidate(receipt.fingerprint.candidate, normalizedExpected.candidate)) return noReuse("not_descendant", "exact-candidate reuse must be evaluated through the exact path");
  const verifiedProof = verifyRepoFlightTransitiveClosureProof(proofValue, trustRoots, now);
  if (!verifiedProof.ok) return noReuse(`closure_${verifiedProof.code}`, verifiedProof.reason);
  if (!sameCandidate(verifiedProof.proof.source_candidate, receipt.fingerprint.candidate) || !sameCandidate(verifiedProof.proof.target_candidate, normalizedExpected.candidate)) return noReuse("closure_candidate_mismatch", "closure proof does not bind the receipt candidate to the target candidate");
  if (verifiedProof.proof.source_shard_manifest_digest !== receipt.fingerprint.shard_manifest_digest || verifiedProof.proof.target_shard_manifest_digest !== normalizedExpected.shard_manifest_digest || receipt.fingerprint.shard_assignment_digest !== normalizedExpected.shard_assignment_digest) return noReuse("closure_manifest_mismatch", "closure proof does not bind equivalent source and target shard manifests");
  return { reusable: true, mode: "descendant", receipt };
}

export function createRepoFlightValidationShardManifests(input: {
  readonly repository_id: RepoFlightRunRepositoryIdentity["repository_id"];
  readonly candidate: RepoFlightValidationCandidate;
  readonly profile_digest: Sha256;
  readonly classification_digest: Sha256;
  readonly hermetic_shard_count: number;
  readonly files: readonly RepoFlightValidationTestFile[];
}): RepoFlightValidationShardManifests {
  const normalized = normalizeManifestInput(input);
  return freeze({
    validation: createManifest("validation", normalized),
    coverage: createManifest("coverage", { ...normalized, files: normalized.files.filter((file) => file.coverage_eligible) }),
  });
}

export function validateRepoFlightValidationShardManifest(value: unknown): { readonly ok: true; readonly manifest: RepoFlightValidationShardManifest } | { readonly ok: false; readonly reason: string } {
  try {
    if (!isRecord(value) || !hasExactKeys(value, manifestKeys())) throw new Error("shard manifest uses an unknown or missing schema");
    const manifest = value as RepoFlightValidationShardManifest;
    const rebuilt = createManifest(manifest.manifest_kind, {
      repository_id: manifest.repository_id,
      candidate: manifest.candidate,
      profile_digest: manifest.profile_digest,
      classification_digest: manifest.classification_digest,
      hermetic_shard_count: manifest.hermetic_shard_count,
      files: manifestToFiles(manifest),
    });
    if (canonicalRepoFlightValidationJson(rebuilt) !== canonicalRepoFlightValidationJson(manifest)) throw new Error("shard manifest does not match its deterministic derivation");
    return { ok: true, manifest: freeze(structuredClone(manifest)) };
  } catch (error) { return { ok: false, reason: errorMessage(error) }; }
}

export function validateRepoFlightEffectiveCoverageArtifactSet(input: {
  readonly manifest: RepoFlightValidationShardManifest;
  readonly artifacts: readonly RepoFlightCoverageShardArtifact[];
  readonly coverage_configuration_digest: Sha256;
  readonly toolchain_digest: Sha256;
  readonly trust_roots: RepoFlightValidationTrustRoots;
  readonly now?: Date;
}): RepoFlightCoverageArtifactSetVerification {
  const manifestResult = validateRepoFlightValidationShardManifest(input.manifest);
  if (!manifestResult.ok) return coverageFail("manifest_invalid", manifestResult.reason);
  const manifest = manifestResult.manifest;
  if (manifest.manifest_kind !== "coverage") return coverageFail("wrong_manifest_kind", "effective coverage artifacts require a coverage shard manifest");
  if (!isDigest(input.coverage_configuration_digest) || !isDigest(input.toolchain_digest)) return coverageFail("identity_invalid", "coverage configuration or toolchain digest is malformed");
  const expectedShardIds = new Set(manifest.shards.map((shard) => shard.shard_id));
  if (input.artifacts.length !== expectedShardIds.size) return coverageFail("incomplete_shards", "coverage artifact set does not contain exactly one artifact per expected shard");
  const seen = new Set<string>();
  const effectiveDigests: Sha256[] = [];
  for (const artifact of input.artifacts) {
    if (!artifact || typeof artifact !== "object" || !expectedShardIds.has(artifact.shard_id)) return coverageFail("unknown_shard", "coverage artifact names an unknown shard");
    if (seen.has(artifact.shard_id)) return coverageFail("duplicate_shard", "coverage artifact set contains a duplicate shard");
    seen.add(artifact.shard_id);
    if (!artifact.complete || artifact.normalized_source_root !== REPO_FLIGHT_NORMALIZED_SOURCE_ROOT || !isDigest(artifact.artifact_digest)) return coverageFail("artifact_incomplete", "coverage artifact is incomplete or does not use the canonical source root");
    if (!sameCandidate(artifact.effective_candidate, manifest.candidate) || artifact.manifest_digest !== manifest.manifest_digest || artifact.coverage_configuration_digest !== input.coverage_configuration_digest || artifact.toolchain_digest !== input.toolchain_digest) return coverageFail("artifact_identity_mismatch", "coverage artifact does not bind the effective candidate, manifest, configuration, and toolchain");
    const expected = createRepoFlightValidationFingerprint({ ...artifact.receipt.fingerprint, candidate: manifest.candidate, artifact_digest: artifact.artifact_digest, shard_manifest_digest: manifest.manifest_digest, shard_assignment_digest: manifest.assignment_digest });
    const decision = artifact.reuse.mode === "executed"
      ? evaluateRepoFlightExactReuse(artifact.receipt, expected, input.trust_roots, input.now)
      : artifact.reuse.mode === "exact"
        ? evaluateRepoFlightExactReuse(artifact.receipt, expected, input.trust_roots, input.now)
        : evaluateRepoFlightDescendantReuse(artifact.receipt, expected, artifact.reuse.closure_proof, input.trust_roots, input.now);
    if (!decision.reusable) return coverageFail("receipt_not_reusable", `${artifact.shard_id}: ${decision.code}: ${decision.reason}`);
    if (decision.receipt.validation_kind !== "coverage_shard") return coverageFail("wrong_receipt_kind", "coverage artifact is not backed by a coverage-shard receipt");
    effectiveDigests.push(artifact.artifact_digest);
  }
  if (seen.size !== expectedShardIds.size) return coverageFail("incomplete_shards", "coverage artifact set omitted a shard");
  return { ok: true, artifact_digest: repoFlightValidationDigest({ manifest_digest: manifest.manifest_digest, artifacts: [...effectiveDigests].sort() }), shard_count: seen.size };
}

function normalizeFingerprintInput(input: RepoFlightValidationFingerprintInput): RepoFlightValidationFingerprintInput {
  if (!isRecord(input) || !isRepoFlightRepositoryId(input.repository_id) || !validCandidate(input.candidate) || !isDigest(input.profile_digest) || !atom(input.gate_id) || !Array.isArray(input.argv) || input.argv.length < 1 || input.argv.length > MAX_ARGV || input.argv.some((argument) => !atom(argument)) || !validRuntimeIdentity(input.runtime_identity) || !isDigest(input.lockfile_digest) || !validEnvironment(input.environment) || !isDigest(input.configuration_digest) || !isDigest(input.shard_manifest_digest) || !isDigest(input.shard_assignment_digest) || !isDigest(input.artifact_digest)) throw new Error("validation fingerprint input is malformed");
  return freeze({
    repository_id: input.repository_id,
    candidate: cloneCandidate(input.candidate),
    profile_digest: input.profile_digest,
    gate_id: input.gate_id,
    argv: freeze([...input.argv]),
    runtime_identity: freeze({ runtime: normalizeStringRecord(input.runtime_identity.runtime), toolchain: normalizeStringRecord(input.runtime_identity.toolchain), platform: freeze({ ...input.runtime_identity.platform }) }),
    lockfile_digest: input.lockfile_digest,
    environment: normalizeStringRecord(input.environment),
    configuration_digest: input.configuration_digest,
    shard_manifest_digest: input.shard_manifest_digest,
    shard_assignment_digest: input.shard_assignment_digest,
    artifact_digest: input.artifact_digest,
  });
}

function assertFingerprint(value: unknown): RepoFlightValidationFingerprint {
  if (!isRecord(value) || !hasExactKeys(value, fingerprintKeys())) throw new Error("validation fingerprint uses an unknown or missing schema");
  const fingerprint = value as RepoFlightValidationFingerprint;
  const rebuilt = createRepoFlightValidationFingerprint(fingerprint);
  if (canonicalRepoFlightValidationJson(fingerprint) !== canonicalRepoFlightValidationJson(rebuilt)) throw new Error("validation fingerprint digest or canonical projections do not verify");
  return rebuilt;
}

function normalizeReceiptPayload(value: RepoFlightValidationReceiptPayload): RepoFlightValidationReceiptPayload {
  if (!isRecord(value) || !hasExactKeys(value as unknown as Record<string, unknown>, receiptPayloadKeys()) || value.schema_version !== 1 || value.kind !== "revoy2.repo_flight.validation_receipt" || !atom(value.receipt_id) || !validProducer(value.producer) || !validationKind(value.validation_kind) || !validationOutcome(value.outcome) || typeof value.artifact_complete !== "boolean" || !validInstant(value.issued_at) || !validInstant(value.expires_at) || Date.parse(value.expires_at) <= Date.parse(value.issued_at)) throw new Error("validation receipt payload is malformed");
  const fingerprint = assertFingerprint(value.fingerprint);
  return freeze({ ...value, producer: freeze({ ...value.producer }), fingerprint, issued_at: value.issued_at, expires_at: value.expires_at });
}

function normalizeClosurePayload(value: RepoFlightTransitiveClosureProofPayload): RepoFlightTransitiveClosureProofPayload {
  if (!isRecord(value) || !hasExactKeys(value as unknown as Record<string, unknown>, closurePayloadKeys()) || value.schema_version !== 1 || value.kind !== "revoy2.repo_flight.transitive_closure_proof" || !atom(value.proof_id) || !validProducer(value.producer) || !validCandidate(value.source_candidate) || !validCandidate(value.target_candidate) || !isDigest(value.source_shard_manifest_digest) || !isDigest(value.target_shard_manifest_digest) || !atom(value.analyzer_version) || !isDigest(value.graph_digest) || typeof value.complete !== "boolean" || !Array.isArray(value.nodes) || value.nodes.length < 1 || value.nodes.length > MAX_SHARD_FILES || !Array.isArray(value.unknown_edges) || !Array.isArray(value.dynamic_edges) || !Array.isArray(value.ambiguous_edges) || !validInstant(value.issued_at) || !validInstant(value.expires_at) || Date.parse(value.expires_at) <= Date.parse(value.issued_at)) throw new Error("transitive closure proof payload is malformed");
  const nodes: RepoFlightClosureNode[] = value.nodes.map((node): RepoFlightClosureNode => {
    if (!isRecord(node) || !hasExactKeys(node, ["node_id", "source_digest", "target_digest"]) || !atom(node.node_id) || !isDigest(node.source_digest) || !isDigest(node.target_digest)) throw new Error("transitive closure proof has a malformed node");
    return freeze({ node_id: node.node_id, source_digest: node.source_digest, target_digest: node.target_digest });
  }).sort((left, right) => left.node_id.localeCompare(right.node_id));
  if (new Set(nodes.map((node) => node.node_id)).size !== nodes.length) throw new Error("transitive closure proof has duplicate nodes");
  const normalizeEdges = (edges: readonly string[]): readonly string[] => {
    if (edges.length > MAX_SHARD_FILES || edges.some((edge) => !atom(edge))) throw new Error("transitive closure proof has malformed edge evidence");
    const sorted = [...edges].sort(); if (new Set(sorted).size !== sorted.length) throw new Error("transitive closure proof has duplicate edge evidence"); return freeze(sorted);
  };
  return freeze({ ...value, producer: freeze({ ...value.producer }), source_candidate: cloneCandidate(value.source_candidate), target_candidate: cloneCandidate(value.target_candidate), nodes: freeze(nodes), unknown_edges: normalizeEdges(value.unknown_edges), dynamic_edges: normalizeEdges(value.dynamic_edges), ambiguous_edges: normalizeEdges(value.ambiguous_edges) });
}

function createManifest(kind: "validation" | "coverage", input: { readonly repository_id: RepoFlightRunRepositoryIdentity["repository_id"]; readonly candidate: RepoFlightValidationCandidate; readonly profile_digest: Sha256; readonly classification_digest: Sha256; readonly hermetic_shard_count: number; readonly files: readonly RepoFlightValidationTestFile[] }): RepoFlightValidationShardManifest {
  const hermetic: string[][] = Array.from({ length: input.hermetic_shard_count }, () => []);
  const serial = new Map<string, string[]>();
  for (const file of input.files) {
    if (file.serial_reason === null) hermetic[shardIndex(file.path, input.hermetic_shard_count)]!.push(file.path);
    else { const files = serial.get(file.serial_reason) ?? []; files.push(file.path); serial.set(file.serial_reason, files); }
  }
  const shards: RepoFlightValidationShard[] = [];
  for (const [index, files] of hermetic.entries()) if (files.length > 0) shards.push(freeze({ shard_id: `hermetic:${String(index + 1).padStart(3, "0")}`, lane: "hermetic", serial_reason: null, files: freeze(files.sort()) }));
  for (const [reason, files] of [...serial.entries()].sort(([left], [right]) => left.localeCompare(right))) shards.push(freeze({ shard_id: `serial:${repoFlightValidationDigest(reason).slice("sha256:".length, "sha256:".length + 16)}`, lane: "serial", serial_reason: reason, files: freeze(files.sort()) }));
  const assignment = { schema_version: REPO_FLIGHT_VALIDATION_SCHEMA_VERSION, kind: "revoy2.repo_flight.validation_shard_assignment" as const, manifest_kind: kind, repository_id: input.repository_id, profile_digest: input.profile_digest, classification_digest: input.classification_digest, hermetic_shard_count: input.hermetic_shard_count, shards: freeze(shards) };
  const payload = { schema_version: REPO_FLIGHT_VALIDATION_SCHEMA_VERSION, kind: "revoy2.repo_flight.validation_shard_manifest" as const, manifest_kind: kind, repository_id: input.repository_id, candidate: cloneCandidate(input.candidate), profile_digest: input.profile_digest, classification_digest: input.classification_digest, hermetic_shard_count: input.hermetic_shard_count, shards: freeze(shards), assignment_digest: repoFlightValidationDigest(assignment) };
  return freeze({ ...payload, manifest_digest: repoFlightValidationDigest(payload) });
}

function normalizeManifestInput(input: { readonly repository_id: RepoFlightRunRepositoryIdentity["repository_id"]; readonly candidate: RepoFlightValidationCandidate; readonly profile_digest: Sha256; readonly classification_digest: Sha256; readonly hermetic_shard_count: number; readonly files: readonly RepoFlightValidationTestFile[] }) {
  if (!isRecord(input) || !isRepoFlightRepositoryId(input.repository_id) || !validCandidate(input.candidate) || !isDigest(input.profile_digest) || !isDigest(input.classification_digest) || !Number.isSafeInteger(input.hermetic_shard_count) || input.hermetic_shard_count < 1 || input.hermetic_shard_count > 128 || !Array.isArray(input.files) || input.files.length > MAX_SHARD_FILES) throw new Error("shard manifest input is malformed");
  const files = input.files.map((file) => {
    if (!isRecord(file) || !hasExactKeys(file, ["path", "coverage_eligible", "serial_reason"]) || !testPath(file.path) || typeof file.coverage_eligible !== "boolean" || (file.serial_reason !== null && !atom(file.serial_reason))) throw new Error("shard manifest has a malformed test-file classification");
    return freeze({ path: file.path, coverage_eligible: file.coverage_eligible, serial_reason: file.serial_reason });
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error("shard manifest has duplicate test files");
  return freeze({ repository_id: input.repository_id, candidate: cloneCandidate(input.candidate), profile_digest: input.profile_digest, classification_digest: input.classification_digest, hermetic_shard_count: input.hermetic_shard_count, files: freeze(files) });
}

function manifestToFiles(manifest: RepoFlightValidationShardManifest): readonly RepoFlightValidationTestFile[] {
  if (manifest.schema_version !== 1 || manifest.kind !== "revoy2.repo_flight.validation_shard_manifest" || (manifest.manifest_kind !== "validation" && manifest.manifest_kind !== "coverage") || !isRepoFlightRepositoryId(manifest.repository_id) || !validCandidate(manifest.candidate) || !isDigest(manifest.profile_digest) || !isDigest(manifest.classification_digest) || !Number.isSafeInteger(manifest.hermetic_shard_count) || !Array.isArray(manifest.shards) || !isDigest(manifest.assignment_digest) || !isDigest(manifest.manifest_digest)) throw new Error("shard manifest is malformed");
  const files: RepoFlightValidationTestFile[] = [];
  for (const shard of manifest.shards) {
    if (!isRecord(shard) || !hasExactKeys(shard, ["shard_id", "lane", "serial_reason", "files"]) || !atom(shard.shard_id) || (shard.lane !== "hermetic" && shard.lane !== "serial") || !Array.isArray(shard.files) || shard.files.length === 0 || (shard.lane === "hermetic" ? shard.serial_reason !== null : !atom(shard.serial_reason))) throw new Error("shard manifest has a malformed shard");
    for (const path of shard.files) { if (!testPath(path)) throw new Error("shard manifest has a malformed test path"); files.push({ path, coverage_eligible: manifest.manifest_kind === "coverage", serial_reason: shard.serial_reason }); }
  }
  if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error("shard manifest assigns a test more than once");
  return files;
}

function reusableReceipt(receipt: RepoFlightValidationReceipt): string | null {
  if (receipt.outcome !== "passed") return `receipt outcome ${receipt.outcome} is never reusable`;
  if (!receipt.artifact_complete) return "incomplete artifacts are never reusable";
  if (NON_REUSABLE_KINDS.has(receipt.validation_kind)) return `${receipt.validation_kind} receipts are never reusable`;
  return null;
}

function sameFingerprintExceptCandidate(left: RepoFlightValidationFingerprint, right: RepoFlightValidationFingerprint): boolean {
  const { candidate: _leftCandidate, shard_manifest_digest: _leftManifest, artifact_digest: _leftArtifact, fingerprint: _leftFingerprint, ...leftComparable } = left;
  const { candidate: _rightCandidate, shard_manifest_digest: _rightManifest, artifact_digest: _rightArtifact, fingerprint: _rightFingerprint, ...rightComparable } = right;
  // An old artifact is expected to have a different digest. All execution inputs
  // other than the candidate/artifact must still match exactly.
  return canonicalRepoFlightValidationJson(leftComparable) === canonicalRepoFlightValidationJson(rightComparable);
}

function sameCandidate(left: RepoFlightValidationCandidate, right: RepoFlightValidationCandidate): boolean {
  return left.candidate_oid === right.candidate_oid && left.input_digest === right.input_digest;
}
function validCandidate(value: unknown): value is RepoFlightValidationCandidate { return isRecord(value) && hasExactKeys(value, ["candidate_oid", "input_digest"]) && isRepoFlightGitOid(value.candidate_oid) && isDigest(value.input_digest); }
function cloneCandidate(value: RepoFlightValidationCandidate): RepoFlightValidationCandidate { return freeze({ candidate_oid: value.candidate_oid, input_digest: value.input_digest }); }
function validRuntimeIdentity(value: unknown): value is RepoFlightRuntimeIdentity { return isRecord(value) && hasExactKeys(value, ["runtime", "toolchain", "platform"]) && validStringRecord(value.runtime) && validStringRecord(value.toolchain) && isRecord(value.platform) && hasExactKeys(value.platform, ["os", "arch", "abi"]) && atom(value.platform.os) && atom(value.platform.arch) && atom(value.platform.abi); }
function normalizeStringRecord(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> { if (!validStringRecord(value)) throw new Error("runtime, toolchain, or environment identity is malformed"); return freeze(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))); }
function validStringRecord(value: unknown): value is Readonly<Record<string, string>> { return isRecord(value) && Object.keys(value).length > 0 && Object.keys(value).length <= MAX_ENVIRONMENT_ITEMS && Object.entries(value).every(([key, item]) => atom(key) && typeof item === "string" && Buffer.byteLength(item) <= MAX_TEXT_BYTES && !/[\0\r\n]/u.test(item)); }
function validEnvironment(value: unknown): value is Readonly<Record<string, string>> { return isRecord(value) && Object.keys(value).length <= MAX_ENVIRONMENT_ITEMS && Object.entries(value).every(([key, item]) => atom(key) && typeof item === "string" && Buffer.byteLength(item) <= MAX_TEXT_BYTES && !/[\0\r\n]/u.test(item)); }
function validProducer(value: unknown): value is RepoFlightValidationProducer { return isRecord(value) && hasExactKeys(value, ["issuer_id", "key_id"]) && atom(value.issuer_id) && atom(value.key_id); }
function validationKind(value: unknown): value is RepoFlightValidationKind { return typeof value === "string" && ["gate", "coverage_shard", "integration", "full_audit", "evidence_writer", "nondeterminism_measurement", "time_sensitive_governance"].includes(value); }
function validationOutcome(value: unknown): value is RepoFlightValidationOutcome { return typeof value === "string" && ["passed", "failed", "timed_out", "interrupted", "ambiguous"].includes(value); }
function validInstant(value: unknown): value is IsoInstant { return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value)); }
function validNow(value: Date): boolean { return value instanceof Date && Number.isFinite(value.getTime()); }
function validSignature(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{80,256}$/.test(value); }
function isDigest(value: unknown): value is Sha256 { return isRepoFlightDigest(value); }
function atom(value: unknown): value is string { return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= MAX_TEXT_BYTES && /^[A-Za-z0-9][A-Za-z0-9._:/@+=-]*$/.test(value); }
function testPath(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT_BYTES && !value.startsWith("/") && !value.includes("\\") && !value.split("/").some((part) => part === "" || part === "." || part === "..") && /\.test\.[cm]?[jt]sx?$/.test(value); }
function shardIndex(path: string, count: number): number { return Number.parseInt(repoFlightValidationDigest(path).slice("sha256:".length, "sha256:".length + 8), 16) % count; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const expected = new Set(keys); return keys.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => expected.has(key)); }
function freeze<T>(value: T): T { return Object.freeze(value); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function trustRoot(roots: RepoFlightValidationTrustRoots, issuerId: string): RepoFlightValidationTrustRoot | undefined {
  const map = roots as ReadonlyMap<string, RepoFlightValidationTrustRoot>;
  return typeof map.get === "function" ? map.get(issuerId) : (roots as Readonly<Record<string, RepoFlightValidationTrustRoot>>)[issuerId];
}
function stripSignature<T extends { readonly signature: string }>(value: T): Omit<T, "signature"> { const { signature: _signature, ...payload } = value; return payload; }
function failReceipt(code: Extract<RepoFlightReceiptVerification, { ok: false }> ["code"], reason: string): Extract<RepoFlightReceiptVerification, { ok: false }> { return { ok: false, code, reason }; }
function failClosure(code: Extract<RepoFlightClosureVerification, { ok: false }> ["code"], reason: string): Extract<RepoFlightClosureVerification, { ok: false }> { return { ok: false, code, reason }; }
function noReuse(code: string, reason: string): RepoFlightReuseDecision { return { reusable: false, code, reason }; }
function coverageFail(code: string, reason: string): RepoFlightCoverageArtifactSetVerification { return { ok: false, code, reason }; }
function fingerprintKeys(): readonly string[] { return ["schema_version", "kind", "repository_id", "candidate", "profile_digest", "gate_id", "argv", "runtime_identity", "lockfile_digest", "environment", "configuration_digest", "shard_manifest_digest", "shard_assignment_digest", "artifact_digest", "gate_argv_digest", "environment_digest", "runtime_digest", "fingerprint"]; }
function receiptPayloadKeys(): readonly string[] { return ["schema_version", "kind", "receipt_id", "producer", "validation_kind", "outcome", "artifact_complete", "issued_at", "expires_at", "fingerprint"]; }
function receiptKeys(): readonly string[] { return [...receiptPayloadKeys(), "signature"]; }
function closurePayloadKeys(): readonly string[] { return ["schema_version", "kind", "proof_id", "producer", "source_candidate", "target_candidate", "source_shard_manifest_digest", "target_shard_manifest_digest", "analyzer_version", "graph_digest", "complete", "nodes", "unknown_edges", "dynamic_edges", "ambiguous_edges", "issued_at", "expires_at"]; }
function closureKeys(): readonly string[] { return [...closurePayloadKeys(), "signature"]; }
function manifestKeys(): readonly string[] { return ["schema_version", "kind", "manifest_kind", "repository_id", "candidate", "profile_digest", "classification_digest", "hermetic_shard_count", "shards", "assignment_digest", "manifest_digest"]; }
