/**
 * Retry-context capsule: a semantically-complete, byte-bounded, digest-only
 * summary of what changed between retry attempts on a node — never raw
 * prompt/tool/file/diff content, only identity, structured failure
 * taxonomy, deltas, evidence pointers, and unresolved requirements.
 */

import { createHash } from "node:crypto";
import type { Provenance } from "@arbor/core";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CAPSULE_MAX_BYTES = 16384;
export const PROJECTION_MAX_BYTES = 8192;
export const FIELD_MAX_BYTES = 2048;
export const MAX_LIST_ITEMS = 32;
export const MAX_TOOL_SIGNATURES = 20;

type RetryFieldName = "taskFacts" | "changedFiles" | "evidence" | "requirements" | "toolSignatures";

/** Lowest-priority field is dropped first when a byte budget is exceeded. */
const FIELD_PRIORITY_ORDER: readonly RetryFieldName[] = [
  "toolSignatures",
  "evidence",
  "requirements",
  "changedFiles",
  "taskFacts",
];

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface CampaignIdentity {
  readonly campaignId: string;
  readonly nodeId: string;
}

/**
 * Failure classification is caller-owned: the caller (the campaign loop)
 * decides what class and kind a failure belongs to and states its own
 * normalized (short, non-raw) root cause. Only `fingerprint` is not
 * caller-supplied — it is canonically derived from the other three fields
 * (see `deriveFailureFingerprint`), so two callers that classify the same
 * failure the same way always produce the same fingerprint, and no caller
 * can manufacture a fingerprint collision or mismatch by hand.
 */
export interface FailureClassificationInput {
  /** Closed broad taxonomy used for retry policy and aggregate metrics. */
  readonly failure_class: "operational" | "critic" | "verification" | "tool";
  /** Caller-owned specific failure kind within the class. Never raw output. */
  readonly kind: string;
  /** Caller-owned short, normalized root cause. Never the raw failure message/output. */
  readonly normalized_root_cause: string;
}

export interface FailureClassification extends FailureClassificationInput {
  /** SHA-256 hex digest of the canonicalized classification triple — always derived, never caller-supplied. */
  readonly fingerprint: string;
}

export interface TaskFact {
  readonly id: string;
  /** Short structured summary of the fact — not raw prompt/tool text. */
  readonly summary: string;
}

export type ChangeKind = "added" | "modified" | "deleted" | "renamed";

export interface ChangedFile {
  readonly path: string;
  readonly changeKind: ChangeKind;
  /** SHA-256 hex digest of the file's diff/delta. The diff itself is never stored. */
  readonly deltaDigest: string;
  /** Short structured description of the change — never the raw diff. */
  readonly summary: string;
}

export interface EvidenceRef {
  readonly id: string;
  readonly kind: string;
  /** SHA-256 hex digest of the evidence content. The content itself is never stored. */
  readonly digest: string;
  /** Pointer/reference (path, URI, artifact id) to the evidence — never raw content. */
  readonly pointer: string;
  /** Full provenance for this evidence — never raw content, only the provenance record. */
  readonly provenance: Provenance;
}

export interface CriticRequirement {
  readonly id: string;
  /** Short label for the unresolved requirement — not the full critic transcript. */
  readonly description: string;
  /** Requirements carried in a capsule are always unresolved by construction. */
  readonly status: "unresolved";
}

export interface ToolSignature {
  readonly name: string;
  /** SHA-256 hex digest of the canonicalized call arguments. Raw arguments are never stored. */
  readonly argsDigest: string;
}

export interface FieldTruncationRecord {
  readonly field: RetryFieldName;
  readonly omittedCount: number;
  readonly omittedDigests: readonly string[];
}

export interface RetryContextCapsuleInput {
  readonly identity: CampaignIdentity;
  readonly failure: FailureClassificationInput;
  /** SHA-256 hex digest of the stable context (system prompt / tree state). Never the raw text. */
  readonly stableContextDigest: string;
  /** Which consecutive attempt against the current fingerprint this capsule represents. Caller-owned. */
  readonly attempt: number;
  /** SHA-256 hex digest of the prompt that was dispatched for this attempt. Never the raw prompt. */
  readonly priorPromptDigest: string;
  readonly taskFacts: readonly TaskFact[];
  readonly changedFiles: readonly ChangedFile[];
  readonly evidence: readonly EvidenceRef[];
  readonly requirements: readonly CriticRequirement[];
  readonly toolSignatures: readonly ToolSignature[];
}

export interface RetryContextCapsule {
  readonly version: 1;
  readonly identity: CampaignIdentity;
  readonly failure: FailureClassification;
  readonly stableContextDigest: string;
  readonly attempt: number;
  readonly priorPromptDigest: string;
  readonly taskFacts: readonly TaskFact[];
  readonly changedFiles: readonly ChangedFile[];
  readonly evidence: readonly EvidenceRef[];
  readonly requirements: readonly CriticRequirement[];
  readonly toolSignatures: readonly ToolSignature[];
  readonly truncation: readonly FieldTruncationRecord[];
  /** SHA-256 hex digest of the canonical capsule body — a stable reference for provenance. */
  readonly capsuleDigest: string;
}

export interface RetryContextProjection {
  readonly version: 1;
  readonly identity: CampaignIdentity;
  readonly failure: FailureClassification;
  readonly stableContextDigest: string;
  readonly attempt: number;
  readonly priorPromptDigest: string;
  readonly taskFacts: readonly TaskFact[];
  readonly changedFiles: readonly ChangedFile[];
  readonly evidence: readonly EvidenceRef[];
  readonly requirements: readonly CriticRequirement[];
  readonly toolSignatures: readonly ToolSignature[];
  readonly truncation: readonly FieldTruncationRecord[];
  /** Pointer back to the source capsule's digest — provenance only, never the capsule content. */
  readonly sourceCapsuleDigest: string;
}

export interface RetryContextCapsuleError {
  readonly field: string;
  readonly reason: string;
}

export type CapsuleBuildResult =
  | { readonly ok: true; readonly capsule: RetryContextCapsule }
  | { readonly ok: false; readonly error: RetryContextCapsuleError };

export type ProjectionBuildResult =
  | { readonly ok: true; readonly projection: RetryContextProjection }
  | { readonly ok: false; readonly error: RetryContextCapsuleError };

/** Verifies a deserialized capsule before a persistence adapter returns it. */
export function verifyRetryContextCapsule(value: unknown): value is RetryContextCapsule {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<RetryContextCapsule>;
  if (candidate.version !== 1 || candidate.identity === undefined || candidate.failure === undefined) return false;
  if (!Array.isArray(candidate.taskFacts) || !Array.isArray(candidate.changedFiles)
    || !Array.isArray(candidate.evidence) || !Array.isArray(candidate.requirements)
    || !Array.isArray(candidate.toolSignatures) || !Array.isArray(candidate.truncation)) return false;
  if (typeof candidate.stableContextDigest !== "string" || typeof candidate.priorPromptDigest !== "string"
    || typeof candidate.capsuleDigest !== "string" || !Number.isSafeInteger(candidate.attempt) || (candidate.attempt ?? 0) < 1) return false;
  const { truncation: _truncation, capsuleDigest, ...body } = candidate as RetryContextCapsule;
  return canonicalDigest(body) === capsuleDigest && checkFieldCeilings(body, "capsule") === null;
}

// ---------------------------------------------------------------------------
// Canonical digesting
// ---------------------------------------------------------------------------

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted;
  }
  return value;
}

function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function canonicalDigest(value: unknown): string {
  return sha256Hex(canonicalStringify(value));
}

/**
 * Canonically derives the fingerprint for a caller-owned failure
 * classification. Two callers that classify the same failure identically
 * (same `failure_class`/`kind`/`normalized_root_cause`) always derive the
 * same fingerprint — it is never itself caller-supplied.
 */
export function deriveFailureFingerprint(input: FailureClassificationInput): string {
  return canonicalDigest({
    failure_class: input.failure_class,
    kind: input.kind,
    normalized_root_cause: input.normalized_root_cause,
  });
}

// ---------------------------------------------------------------------------
// Deep freeze
// ---------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// Field ceiling validation (reject, never silently truncate a field's text)
// ---------------------------------------------------------------------------

function collectStringFields(prefix: string, value: unknown, out: Array<[string, string]>): void {
  if (typeof value === "string") {
    out.push([prefix, value]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStringFields(`${prefix}[${index}]`, item, out));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      collectStringFields(prefix ? `${prefix}.${key}` : key, item, out);
    }
  }
}

function checkFieldCeilings(value: unknown, rootLabel: string): RetryContextCapsuleError | null {
  const fields: Array<[string, string]> = [];
  collectStringFields(rootLabel, value, fields);
  for (const [label, text] of fields) {
    if (Buffer.byteLength(text, "utf8") > FIELD_MAX_BYTES) {
      return { field: label, reason: `field exceeds the ${FIELD_MAX_BYTES}-byte per-field ceiling` };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Deterministic sorting + whole-row truncation
// ---------------------------------------------------------------------------

function sortRowsByKey<T>(rows: readonly T[], keyOf: (row: T) => string): T[] {
  return [...rows].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });
}

type TruncationMap = Map<RetryFieldName, { omittedCount: number; omittedDigests: string[] }>;

function recordOmission(truncation: TruncationMap, field: RetryFieldName, rows: readonly unknown[]): void {
  if (rows.length === 0) return;
  const entry = truncation.get(field) ?? { omittedCount: 0, omittedDigests: [] };
  for (const row of rows) entry.omittedDigests.push(canonicalDigest(row));
  entry.omittedCount += rows.length;
  truncation.set(field, entry);
}

function capListToMax<T>(truncation: TruncationMap, field: RetryFieldName, rows: readonly T[], cap: number): T[] {
  if (rows.length <= cap) return [...rows];
  const kept = rows.slice(0, cap);
  recordOmission(truncation, field, rows.slice(cap));
  return kept;
}

function toTruncationRecords(truncation: TruncationMap): FieldTruncationRecord[] {
  return FIELD_PRIORITY_ORDER.filter((field) => (truncation.get(field)?.omittedCount ?? 0) > 0).map((field) => {
    const entry = truncation.get(field)!;
    return { field, omittedCount: entry.omittedCount, omittedDigests: [...entry.omittedDigests] };
  });
}

function mergeTruncationMap(base: TruncationMap, records: readonly FieldTruncationRecord[]): void {
  for (const record of records) {
    const entry = base.get(record.field) ?? { omittedCount: 0, omittedDigests: [] };
    entry.omittedCount += record.omittedCount;
    entry.omittedDigests.push(...record.omittedDigests);
    base.set(record.field, entry);
  }
}

/**
 * Drops whole lowest-priority rows, one at a time, until `fixed` + `lists` +
 * the truncation metadata itself fits `maxBytes`. The metadata is re-measured
 * on every iteration since each dropped row grows the omission record.
 */
function shrinkToByteBudget(
  fixed: Record<string, unknown>,
  lists: Record<RetryFieldName, unknown[]>,
  maxBytes: number,
  truncation: TruncationMap,
): boolean {
  const currentSize = (): number =>
    Buffer.byteLength(canonicalStringify({ ...fixed, ...lists, truncation: toTruncationRecords(truncation) }), "utf8");
  let guard = 0;
  while (currentSize() > maxBytes && guard < 10_000) {
    guard += 1;
    const field = FIELD_PRIORITY_ORDER.find((candidate) => lists[candidate].length > 0);
    if (!field) break;
    const rows = lists[field];
    const dropped = rows[rows.length - 1];
    lists[field] = rows.slice(0, -1);
    recordOmission(truncation, field, [dropped]);
  }
  return currentSize() <= maxBytes;
}

// ---------------------------------------------------------------------------
// Capsule builder
// ---------------------------------------------------------------------------

export function buildRetryContextCapsule(input: RetryContextCapsuleInput): CapsuleBuildResult {
  const ceilingError = checkFieldCeilings(
    {
      identity: input.identity,
      failure: input.failure,
      stableContextDigest: input.stableContextDigest,
      priorPromptDigest: input.priorPromptDigest,
      taskFacts: input.taskFacts,
      changedFiles: input.changedFiles,
      evidence: input.evidence,
      requirements: input.requirements,
      toolSignatures: input.toolSignatures,
    },
    "input",
  );
  if (ceilingError) return { ok: false, error: ceilingError };

  const failure: FailureClassification = { ...input.failure, fingerprint: deriveFailureFingerprint(input.failure) };

  const truncation: TruncationMap = new Map();

  const sortedTaskFacts = sortRowsByKey(input.taskFacts, (row) => row.id);
  const sortedChangedFiles = sortRowsByKey(input.changedFiles, (row) => row.path);
  const sortedEvidence = sortRowsByKey(input.evidence, (row) => row.id);
  const sortedRequirements = sortRowsByKey(input.requirements, (row) => row.id);
  const sortedToolSignatures = sortRowsByKey(input.toolSignatures, (row) => row.name);

  const lists: Record<RetryFieldName, unknown[]> = {
    taskFacts: capListToMax(truncation, "taskFacts", sortedTaskFacts, MAX_LIST_ITEMS),
    changedFiles: capListToMax(truncation, "changedFiles", sortedChangedFiles, MAX_LIST_ITEMS),
    evidence: capListToMax(truncation, "evidence", sortedEvidence, MAX_LIST_ITEMS),
    requirements: capListToMax(truncation, "requirements", sortedRequirements, MAX_LIST_ITEMS),
    toolSignatures: capListToMax(truncation, "toolSignatures", sortedToolSignatures, MAX_TOOL_SIGNATURES),
  };

  const fixed = {
    version: 1 as const,
    identity: input.identity,
    failure,
    stableContextDigest: input.stableContextDigest,
    attempt: input.attempt,
    priorPromptDigest: input.priorPromptDigest,
  };
  // capsuleDigest is only computable after truncation settles, but it is part
  // of the final serialized capsule — budget for it via a same-length placeholder.
  const fixedWithDigestPlaceholder = { ...fixed, capsuleDigest: "0".repeat(64) };

  const fits = shrinkToByteBudget(fixedWithDigestPlaceholder, lists, CAPSULE_MAX_BYTES, truncation);
  if (!fits) {
    return {
      ok: false,
      error: {
        field: "capsule",
        reason: `capsule cannot fit within the ${CAPSULE_MAX_BYTES}-byte budget even after dropping all optional rows`,
      },
    };
  }

  const body = {
    ...fixed,
    taskFacts: lists.taskFacts as TaskFact[],
    changedFiles: lists.changedFiles as ChangedFile[],
    evidence: lists.evidence as EvidenceRef[],
    requirements: lists.requirements as CriticRequirement[],
    toolSignatures: lists.toolSignatures as ToolSignature[],
  };

  const capsule: RetryContextCapsule = deepFreeze({
    ...body,
    truncation: toTruncationRecords(truncation),
    capsuleDigest: canonicalDigest(body),
  });

  return { ok: true, capsule };
}

// ---------------------------------------------------------------------------
// Projection builder
// ---------------------------------------------------------------------------

export function projectRetryContextCapsule(capsule: RetryContextCapsule): ProjectionBuildResult {
  const truncation: TruncationMap = new Map();
  mergeTruncationMap(truncation, capsule.truncation);

  const lists: Record<RetryFieldName, unknown[]> = {
    taskFacts: [...capsule.taskFacts],
    changedFiles: [...capsule.changedFiles],
    evidence: [...capsule.evidence],
    requirements: [...capsule.requirements],
    toolSignatures: [...capsule.toolSignatures],
  };

  const fixed = {
    version: 1 as const,
    identity: capsule.identity,
    failure: capsule.failure,
    stableContextDigest: capsule.stableContextDigest,
    attempt: capsule.attempt,
    priorPromptDigest: capsule.priorPromptDigest,
    sourceCapsuleDigest: capsule.capsuleDigest,
  };

  const fits = shrinkToByteBudget(fixed, lists, PROJECTION_MAX_BYTES, truncation);
  if (!fits) {
    return {
      ok: false,
      error: {
        field: "projection",
        reason: `projection cannot fit within the ${PROJECTION_MAX_BYTES}-byte budget even after dropping all optional rows`,
      },
    };
  }

  const projection: RetryContextProjection = deepFreeze({
    ...fixed,
    taskFacts: lists.taskFacts as TaskFact[],
    changedFiles: lists.changedFiles as ChangedFile[],
    evidence: lists.evidence as EvidenceRef[],
    requirements: lists.requirements as CriticRequirement[],
    toolSignatures: lists.toolSignatures as ToolSignature[],
    truncation: toTruncationRecords(truncation),
  });

  return { ok: true, projection };
}

// ---------------------------------------------------------------------------
// Failure decision API — advisory only, never enforced control flow
// ---------------------------------------------------------------------------

export type RetryDecisionAction = "continue" | "decompose" | "stop";

export interface RetryDecisionInput {
  readonly currentFingerprint: string;
  readonly previousFingerprint?: string;
  readonly stableContextDigest: string;
  readonly previousStableContextDigest?: string;
  readonly hasNewEvidence: boolean;
  readonly hasTaskOrFileDelta: boolean;
  /** Count of consecutive identical occurrences of `currentFingerprint`, including this one. */
  readonly occurrenceCount: number;
}

export interface RetryDecision {
  readonly action: RetryDecisionAction;
  readonly reason: string;
  readonly occurrenceCount: number;
  /** This decision is advisory only — it does not enforce control flow. */
  readonly advisory: true;
}

/**
 * Advisory retry-continuation signal. Callers remain responsible for actual
 * control flow; this function never enforces stop/decompose on its own.
 */
export function decideRetryContinuation(input: RetryDecisionInput): RetryDecision {
  const base = { occurrenceCount: input.occurrenceCount, advisory: true as const };

  if (input.previousFingerprint === undefined) {
    return { ...base, action: "continue", reason: "no previous occurrence recorded" };
  }
  if (input.hasNewEvidence) {
    return { ...base, action: "continue", reason: "new evidence present" };
  }
  if (input.hasTaskOrFileDelta) {
    return { ...base, action: "continue", reason: "task/file delta detected" };
  }
  if (input.previousStableContextDigest !== undefined && input.previousStableContextDigest !== input.stableContextDigest) {
    return { ...base, action: "continue", reason: "stable_context_digest changed" };
  }
  if (input.previousFingerprint !== input.currentFingerprint) {
    return { ...base, action: "continue", reason: "failure fingerprint changed" };
  }

  if (input.occurrenceCount >= 3) {
    return { ...base, action: "stop", reason: `repeated identical failure at occurrence ${input.occurrenceCount} (stop threshold)` };
  }
  if (input.occurrenceCount === 2) {
    return { ...base, action: "decompose", reason: "repeated identical failure at occurrence 2 (decompose threshold)" };
  }
  return { ...base, action: "continue", reason: "repeated identical failure below decompose threshold" };
}
