// arbor-kb — Provenance-typed Knowledge Base with envelope reads and capability gating
// Clean-room synthesis: provenance-as-type from revoy-spec's .revoy format (ADR-010),
// envelope pattern from revoy-spec's REVOY-Q (ADR-004),
// dual-level memory from KernelSkill (arXiv 2603.10085).
// No code copied from any source.

import { isVerificationCheck, type Envelope, type AbsenceReason, type Provenance, type CapabilityContext } from "@arbor/core";
import { createHash } from "node:crypto";
import { canonicalizeForHash as canonicalJson } from "@arbor/core";
import { DEFAULT_KB_INJECT_TOP_K, kbEntryRankingText, loadVendoredEmbeddingPort, selectTopK, type EmbeddingPort } from "./retrieval.js";

// ============================================================
// KB ENTRY SCHEMA
// ============================================================

/**
 * A knowledge base entry. Every entry carries provenance.
 *
 * Entry types:
 * - failure_mode: (failure-mode, root-cause, fix-template) triple from a failed branch
 * - success_pattern: what worked, reusable across campaigns
 * - parameter_finding: a tuned value or validated configuration
 */
export interface KBEntry {
  id: string;
  campaign_id: string;
  type: "failure_mode" | "success_pattern" | "parameter_finding";
  value: string;
  provenance: Provenance;
  as_of: string; // 'iter:N' or 'sha:XXXXXXX'
  tier: KBEntryTier;
  // For failure_mode entries:
  failure_mode?: string;
  root_cause?: string;
  fix_template?: string;
  // For parameter_finding entries:
  parameter?: string;
  validated_value?: string;
  // Metadata
  created_at: string;
  tags: string[];
  // Ranked retrieval (ADR-112; the ranking is lexical, not semantic — see
  // ADR-138): computed at write time when a vector port is available.
  // `embedding_model` records which model produced `embedding` (e.g.
  // "arbor-kb-local-trigram@v1") so ranking can detect a stale vector from
  // a retired model version and re-embed on demand instead of comparing
  // incompatible spaces.
  embedding?: readonly number[];
  embedding_model?: string;
}

/**
 * Visibility tier for a KB entry.
 * - specialist_visible: any agent tier can read it
 * - critic_only: only critic and auditor tiers can read it (prevents gaming)
 */
export type KBEntryTier = "specialist_visible" | "critic_only";

/** The versioned, sealed JSONL format used by the on-disk KB streams. */
export const KB_STREAM_FORMAT_VERSION = 1;

export interface KBStreamIntegrity {
  valid: boolean;
  legacy: boolean;
  entry_count: number;
  error: string | null;
}

/** Raised when persisted knowledge cannot safely be treated as evidence. */
export class KBIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KBIntegrityError";
  }
}

/**
 * Runtime validation for persisted/untrusted KB data. TypeScript protects
 * in-process callers, but JSONL imports and MCP-facing callers cross a
 * runtime boundary. In particular, generated entries must retain the hash of
 * the inputs from which the artifact was derived.
 */
export function isValidKBEntry(value: unknown): value is KBEntry {
  if (!isRecord(value)) return false;
  if (
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.campaign_id) ||
    !isNonEmptyString(value.value) ||
    !isNonEmptyString(value.as_of) ||
    !isNonEmptyString(value.created_at) ||
    !["failure_mode", "success_pattern", "parameter_finding"].includes(value.type as string) ||
    !["specialist_visible", "critic_only"].includes(value.tier as string) ||
    !Array.isArray(value.tags) ||
    !value.tags.every(isNonEmptyString) ||
    !isValidProvenance(value.provenance) ||
    !isValidOptionalEmbedding(value.embedding, value.embedding_model)
  ) {
    return false;
  }
  return true;
}

/** `embedding` and `embedding_model` are optional, but if either is present both must be valid together. */
function isValidOptionalEmbedding(embedding: unknown, embedding_model: unknown): boolean {
  if (embedding === undefined && embedding_model === undefined) return true;
  return (
    Array.isArray(embedding) &&
    embedding.length > 0 &&
    embedding.every((v) => typeof v === "number" && Number.isFinite(v)) &&
    isNonEmptyString(embedding_model)
  );
}

function isValidProvenance(value: unknown): value is Provenance {
  if (!isRecord(value) || !isNonEmptyString(value.tag)) return false;
  switch (value.tag) {
    case "verified":
      return isNonEmptyString(value.cmd) && value.exit === 0 && isNonEmptyString(value.stdout_hash)
        && (value.check === undefined || isVerificationCheck(value.check));
    case "claimed":
      return isNonEmptyString(value.claimant);
    case "critic_approved":
      return isNonEmptyString(value.critic) && isNonEmptyString(value.rationale);
    case "generated":
      return isNonEmptyString(value.generator) && isNonEmptyString(value.input_hash);
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// ============================================================
// KB STORE — JSONL-backed, query-structured, capability-gated
// ============================================================

/**
 * Shared storage-engine contract. `KnowledgeBase` (JSONL/in-memory) and
 * `SqliteKbStore` (SQLite) both implement this identically, so callers that
 * hold a `KbStore` observe the same provenance, envelope, and capability-gating
 * semantics no matter which backend produced it. Storage is a persistence
 * choice, never a semantic one.
 */
export interface KbStore {
  write(entry: Omit<KBEntry, "id" | "created_at">): string;
  read(id: string, cap: CapabilityContext): Envelope<KBEntry>;
  query(
    campaignId: string | null,
    filter: { type?: KBEntry["type"]; tags?: string[] } | null,
    cap: CapabilityContext,
  ): Envelope<KBEntry>[];
  inject(prompt: string, campaignId: string, cap: CapabilityContext, category?: string, topK?: number): string;
  toJSONL(): string;
  getEntries(): readonly KBEntry[];
  fromJSONL(data: string): number;
}

/**
 * The Knowledge Base. JSONL-backed for human-readability and git-diffability.
 * All retained knowledge persists in the canonical store. Campaign scoping is
 * a query concern, not a duplicate in-memory storage tier.
 */
export class KnowledgeBase implements KbStore {
  private longTerm: Map<string, KBEntry> = new Map();
  private nextId = 0;
  private readonly embedder: EmbeddingPort | null;

  /**
   * `embedder` defaults to the real vendored model loader (ADR-112 Decision
   * 1). It is a constructor parameter — not a hardcoded singleton — so
   * tests can inject a deterministic double at this exact port boundary
   * instead of depending on a vendored ML asset this repository does not
   * ship yet.
   */
  constructor(embedder: EmbeddingPort | null = loadVendoredEmbeddingPort()) {
    this.embedder = embedder;
  }

  // --- Write side ---

  /**
   * Write a KB entry. Returns the entry's stable id.
   *
   * ADR-112 Decision 1: computes an embedding vector at write time when an
   * embedding model is available, so `inject`'s ranking stage does not
   * have to re-embed every entry on every prompt construction.
   */
  write(entry: Omit<KBEntry, "id" | "created_at">): string {
    const id = `kb_${(++this.nextId).toString(36)}`;
    const created_at = new Date().toISOString();
    const embeddingFields = this.embedder
      ? { embedding: this.embedder.embed(kbEntryRankingText({ ...entry, id, created_at } as KBEntry)), embedding_model: this.embedder.model_key }
      : {};
    const full: KBEntry = { ...entry, id, created_at, ...embeddingFields };

    if (!isValidKBEntry(full)) {
      throw new Error("Invalid KB entry: every entry requires complete provenance");
    }

    // G-38: the former shortTerm map duplicated each failure_mode but could
    // never change a read: query() had already included the same id from this
    // canonical store. One retained representation keeps persistence and
    // visibility semantics honest.
    this.longTerm.set(id, full);

    return id;
  }

  // --- Read side (envelope-wrapped, capability-gated) ---

  /**
   * Read a single KB entry by id. Returns an envelope.
   * Capability-gated: critic_only entries return absence=ccapability_required for specialists.
   */
  read(id: string, cap: CapabilityContext): Envelope<KBEntry> {
    const entry = this.longTerm.get(id);
    if (!entry) {
      return absentEnvelope(id, "not_found");
    }

    // Capability gate: specialists can't see critic_only entries
    if (entry.tier === "critic_only" && cap.tier === "specialist") {
      return absentEnvelope(id, "capability_required");
    }

    return {
      value: entry,
      provenance: entry.provenance,
      as_of: entry.as_of,
      id: entry.id,
      absence: null,
    };
  }

  /**
   * Query KB entries by campaign and optional filter.
   * Returns envelopes, capability-gated.
   */
  query(
    campaignId: string | null,
    filter: { type?: KBEntry["type"]; tags?: string[] } | null,
    cap: CapabilityContext,
  ): Envelope<KBEntry>[] {
    const results: KBEntry[] = [];

    for (const entry of this.longTerm.values()) {
      // Filter by campaign if specified
      if (campaignId && entry.campaign_id !== campaignId) continue;

      // Filter by type
      if (filter?.type && entry.type !== filter.type) continue;

      // Filter by tags (all specified tags must be present)
      if (filter?.tags && filter.tags.length > 0) {
        if (!filter.tags.every((t) => entry.tags.includes(t))) continue;
      }

      results.push(entry);
    }

    return results.map((entry) => {
      // Capability gate
      if (entry.tier === "critic_only" && cap.tier === "specialist") {
        return absentEnvelope(entry.id, "capability_required");
      }
      return {
        value: entry,
        provenance: entry.provenance,
        as_of: entry.as_of,
        id: entry.id,
        absence: null,
      };
    });
  }

  /**
   * Inject relevant KB entries into a prompt string.
   * This is Arbor's highest-leverage idea: the KB is active context, not a passive log.
   *
   * Only specialist_visible entries are injected — critic_only entries never leak
   * into Specialist prompts. When `category` is given, specialist failure-mode
   * injection is scoped to prior failures in that same category, so irrelevant
   * history from other categories is not surfaced to the Specialist.
   *
   * ADR-112 Decision 2: both the specialist and critic paths keep their
   * existing hard pre-filters (type/category, tier gate) unchanged, then
   * rank and truncate to `topK`. The cap applies unconditionally — even
   * when the embedding model is unavailable and ranking degrades to
   * exact-tag/recency (Decision 4) — so prompt-context growth is bounded
   * by `topK`, not by campaign KB size, on every path.
   */
  inject(prompt: string, campaignId: string, cap: CapabilityContext, category?: string, topK = DEFAULT_KB_INJECT_TOP_K): string {
    // Specialists never get critic_only entries
    if (cap.tier === "specialist") {
      const preFiltered = this.query(campaignId, { type: "failure_mode" }, cap)
        .filter((e) => e.value !== null)
        .filter((e) => !category || (e.value as KBEntry).tags.includes(category))
        .map((e) => e.value as KBEntry);
      if (preFiltered.length === 0) return prompt;

      const { entries } = selectTopK(preFiltered, prompt, { top_k: topK, embedder: this.embedder });

      const kbBlock = entries
        .map((entry) => `- Prior failure in this area: ${entry.failure_mode ?? entry.value} (root cause: ${entry.root_cause ?? "unknown"})`)
        .join("\n");

      return `${prompt}\n\n--- KB CONTEXT (prior failures) ---\n${kbBlock}\n--- END KB CONTEXT ---`;
    }

    // Critics and auditors get everything the tier gate allows, ranked and capped.
    const preFiltered = this.query(campaignId, null, cap).filter((e) => e.value !== null).map((e) => e.value as KBEntry);
    if (preFiltered.length === 0) return prompt;

    const { entries } = selectTopK(preFiltered, prompt, { top_k: topK, embedder: this.embedder });

    const kbBlock = entries
      .map((entry) => `- [${entry.type}] ${entry.value} (provenance: ${entry.provenance.tag})`)
      .join("\n");

    return `${prompt}\n\n--- KB CONTEXT ---\n${kbBlock}\n--- END KB CONTEXT ---`;
  }

  // --- Serialization ---

  /**
   * Export all entries as JSONL. For persistence and git-diffability.
   */
  toJSONL(): string {
    const lines: string[] = [];
    for (const entry of this.longTerm.values()) {
      lines.push(JSON.stringify(entry));
    }
    return lines.join("\n");
  }

  /**
   * Return a detached, complete view for persistence adapters. `toJSONL()`
   * deliberately remains the legacy entry-only interchange format so SQLite
   * imports and existing tooling continue to work.
   */
  getEntries(): readonly KBEntry[] {
    return structuredClone([...this.longTerm.values()]);
  }

  /**
   * Import entries from JSONL. Idempotent — duplicate ids are skipped.
   */
  fromJSONL(data: string): number {
    let count = 0;
    for (const line of data.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(trimmed) as unknown;
      } catch {
        // Skip malformed lines
        continue;
      }
      if (isValidKBEntry(entry)) {
        const existing = this.longTerm.get(entry.id);
        if (existing && canonicalJson(existing) !== canonicalJson(entry)) {
          throw new KBIntegrityError(`conflicting KB entry for id ${entry.id}`);
        }
        if (existing) continue;
        this.longTerm.set(entry.id, entry);
        this.nextId = Math.max(this.nextId, parseKbId(entry.id));
        count++;
      }
    }
    return count;
  }
}

type KBStreamType = KBEntry["type"];

interface KBStreamHeader {
  kind: "arbor_kb_stream";
  version: number;
  stream: KBStreamType;
}

interface KBStreamRecord {
  kind: "kb_entry";
  version: number;
  sequence: number;
  previous_hash: string | null;
  content_hash: string;
  entry: KBEntry;
}

interface KBStreamSeal {
  kind: "arbor_kb_seal";
  version: number;
  stream: KBStreamType;
  entry_count: number;
  tip_hash: string | null;
  content_hash: string;
}

/** Serialize one type-specific stream with a hash chain and terminal seal. */
export function serializeKBStream(stream: KBStreamType, entries: readonly KBEntry[]): string {
  const matching = entries.filter((entry) => entry.type === stream);
  const header: KBStreamHeader = { kind: "arbor_kb_stream", version: KB_STREAM_FORMAT_VERSION, stream };
  const lines = [JSON.stringify(header)];
  let previous_hash: string | null = null;
  for (const [index, entry] of matching.entries()) {
    const unhashed = {
      kind: "kb_entry" as const,
      version: KB_STREAM_FORMAT_VERSION,
      sequence: index + 1,
      previous_hash,
      entry,
    };
    const record: KBStreamRecord = { ...unhashed, content_hash: hashKBRecord(unhashed) };
    lines.push(JSON.stringify(record));
    previous_hash = record.content_hash;
  }
  const unsealed = {
    kind: "arbor_kb_seal" as const,
    version: KB_STREAM_FORMAT_VERSION,
    stream,
    entry_count: matching.length,
    tip_hash: previous_hash,
  };
  lines.push(JSON.stringify({ ...unsealed, content_hash: hashKBRecord(unsealed) } satisfies KBStreamSeal));
  return `${lines.join("\n")}\n`;
}

/**
 * Read a persisted KB stream. Entry-only JSONL is deliberately accepted as a
 * legacy v0 import path, but all new on-disk writes use the sealed v1 format.
 */
export function parseKBStream(data: string, expectedStream: KBStreamType): {
  entries: KBEntry[];
  integrity: KBStreamIntegrity;
} {
  const values = data.split("\n").map((line) => line.trim()).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as unknown; } catch { throw new KBIntegrityError(`invalid JSON at line ${index + 1}`); }
  });
  if (values.length === 0) return { entries: [], integrity: { valid: true, legacy: true, entry_count: 0, error: null } };
  if (!isStreamHeader(values[0])) {
    const entries = values.filter(isValidKBEntry);
    if (entries.length !== values.length) throw new KBIntegrityError("legacy KB stream contains an invalid entry");
    ensureUniqueKBEntries(entries);
    if (entries.some((entry) => entry.type !== expectedStream)) {
      throw new KBIntegrityError(`legacy KB stream contains entries outside ${expectedStream}`);
    }
    return { entries, integrity: { valid: true, legacy: true, entry_count: entries.length, error: null } };
  }

  const header = values[0];
  if (header.version !== KB_STREAM_FORMAT_VERSION) {
    throw new KBIntegrityError(`unsupported KB stream version ${String(header.version)}`);
  }
  if (header.stream !== expectedStream) throw new KBIntegrityError(`KB stream is ${header.stream}, expected ${expectedStream}`);
  if (values.length < 2 || !isStreamSeal(values.at(-1))) throw new KBIntegrityError("KB stream is missing its terminal seal (possible truncation)");
  const seal = values.at(-1) as KBStreamSeal;
  if (seal.version !== KB_STREAM_FORMAT_VERSION || seal.stream !== expectedStream) throw new KBIntegrityError("KB stream seal does not match header");
  const { content_hash: sealHash, ...unsealed } = seal;
  if (sealHash !== hashKBRecord(unsealed)) throw new KBIntegrityError("KB stream seal hash does not match");

  const entries: KBEntry[] = [];
  let previous_hash: string | null = null;
  for (let index = 1; index < values.length - 1; index++) {
    const record = values[index];
    if (!isStreamRecord(record)) throw new KBIntegrityError(`invalid KB record at line ${index + 1}`);
    if (record.version !== KB_STREAM_FORMAT_VERSION || record.sequence !== index || record.previous_hash !== previous_hash) {
      throw new KBIntegrityError(`KB record ${index} has an invalid sequence or predecessor hash`);
    }
    const { content_hash, ...unhashed } = record;
    if (content_hash !== hashKBRecord(unhashed)) throw new KBIntegrityError(`KB record ${index} content hash does not match`);
    if (!isValidKBEntry(record.entry) || record.entry.type !== expectedStream) throw new KBIntegrityError(`KB record ${index} contains an invalid entry`);
    entries.push(record.entry);
    previous_hash = content_hash;
  }
  ensureUniqueKBEntries(entries);
  if (seal.entry_count !== entries.length || seal.tip_hash !== previous_hash) throw new KBIntegrityError("KB stream seal does not match records (possible truncation or reordering)");
  return { entries, integrity: { valid: true, legacy: false, entry_count: entries.length, error: null } };
}

function isStreamHeader(value: unknown): value is KBStreamHeader {
  return isRecord(value) && value.kind === "arbor_kb_stream" && typeof value.version === "number"
    && ["failure_mode", "success_pattern", "parameter_finding"].includes(value.stream as string);
}

function isStreamRecord(value: unknown): value is KBStreamRecord {
  return isRecord(value) && value.kind === "kb_entry" && typeof value.version === "number"
    && typeof value.sequence === "number" && (typeof value.previous_hash === "string" || value.previous_hash === null)
    && typeof value.content_hash === "string" && "entry" in value;
}

function isStreamSeal(value: unknown): value is KBStreamSeal {
  return isRecord(value) && value.kind === "arbor_kb_seal" && typeof value.version === "number"
    && ["failure_mode", "success_pattern", "parameter_finding"].includes(value.stream as string)
    && typeof value.entry_count === "number" && (typeof value.tip_hash === "string" || value.tip_hash === null)
    && typeof value.content_hash === "string";
}

function ensureUniqueKBEntries(entries: readonly KBEntry[]): void {
  const seen = new Map<string, KBEntry>();
  for (const entry of entries) {
    const existing = seen.get(entry.id);
    if (existing && canonicalJson(existing) !== canonicalJson(entry)) throw new KBIntegrityError(`conflicting KB entry for id ${entry.id}`);
    if (existing) throw new KBIntegrityError(`duplicate KB entry id ${entry.id}`);
    seen.set(entry.id, entry);
  }
}

function hashKBRecord(record: object): string {
  return createHash("sha256").update(canonicalJson(record)).digest("hex");
}


function parseKbId(id: string): number {
  const encoded = id.match(/^kb_([0-9a-z]+)$/)?.[1];
  return encoded ? parseInt(encoded, 36) || 0 : 0;
}

// --- Helpers ---

function absentEnvelope(id: string, reason: AbsenceReason): Envelope<KBEntry> {
  return {
    value: null,
    provenance: null,
    as_of: new Date().toISOString(),
    id,
    absence: reason,
  };
}
