// arbor-kb — Lexical (trigram) retrieval (ADR-112, renamed by ADR-138)
//
// Adds a ranked, bounded top-k stage in front of `KnowledgeBase.inject` /
// `SqliteKbStore.inject`, computed from local, deterministically-versioned
// vectors rather than a remote API. See
// decisions/ADR-112-knowledge-retrieval-is-semantic.md for the original
// record and decisions/ADR-138-kb-retrieval-is-lexical-not-semantic.md for
// why this module does NOT perform semantic retrieval: no vendored
// embedding asset has ever been checked in, so the only ranking that has
// ever run in production is `trigramEmbed`'s character-trigram lexical
// similarity, never `cosineSimilarity` over meaning-bearing vectors. Name
// everything here accordingly — an operator reading `TopKSelection.mode`
// must be able to tell whether a result was ranked by meaning or by
// character overlap, per ADR-138 Decision 3.
//
// Determinism (Decision 1): ranking is cosine similarity over exact
// float64 arithmetic with a stable, total-order tie-break (entry `id` as
// the final sort key) — no ranking output may depend on iteration order,
// Map insertion order, or a network round-trip's timing. This module never
// makes a network call.
//
// Fallback (Decision 4): if the embedding model is unavailable at runtime
// (a corrupted vendor asset, a platform the model was not built for, or —
// as is genuinely the case in this repository today — no vendored asset
// has been checked in yet), retrieval degrades to `query`'s exact-tag
// result set, truncated to the same `top_k` by recency, never to an
// unbounded dump and never to a hard failure. `reportDegradedLexicalRetrieval`
// makes this loud (a real console.warn, deduplicated per model key) rather
// than allowing a silent quality regression.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KBEntry } from "./kb.js";

// ============================================================
// EMBEDDING PORT
// ============================================================

/**
 * The seam production code and tests both plug into. Production wiring is
 * `loadVendoredEmbeddingPort()`; tests inject a deterministic double
 * directly so ranking logic is exercised without loading or downloading
 * any real model (see packages/arbor-kb/tests/helpers/fake-embedder.ts).
 * Despite the port shape (a vector + cosine similarity), the only
 * implementation ever wired in production is a character-trigram lexical
 * hash (`trigramEmbed`) — see ADR-138.
 */
export interface EmbeddingPort {
  /** Stable identity for the vectors this port produces, e.g. "arbor-kb-local-trigram@v1". */
  readonly model_key: string;
  readonly dims: number;
  embed(text: string): readonly number[];
}

/**
 * Describes the local, fixed-version embedding model this repository pins
 * — the same "pin the version, run it locally" posture ADR-090 already
 * takes for language servers. `vendor_relative_path` is resolved relative
 * to the `arbor-kb` package root.
 */
export interface VendoredLexicalModelSpec {
  readonly model_id: string;
  readonly version: string;
  readonly dims: number;
  readonly vendor_relative_path: string;
}

/** ADR-138: renamed from `VENDORED_EMBEDDING_MODEL` — this pins a character-trigram hashing table, not a semantic embedding model. */
export const VENDORED_LEXICAL_MODEL: VendoredLexicalModelSpec = Object.freeze({
  model_id: "arbor-kb-local-trigram",
  version: "v1",
  dims: 64,
  vendor_relative_path: "vendor/embedding-model/model.json",
});

/** Shape of the vendored asset a real model drop must provide: a fixed hashing-trick weight table. */
interface VendoredLexicalAsset {
  readonly model_id: string;
  readonly version: string;
  readonly dims: number;
  /** Deterministic bucket weights, keyed by lowercase character trigram. */
  readonly trigram_weights: Readonly<Record<string, readonly number[]>>;
}

function isVendoredLexicalAsset(value: unknown, spec: VendoredLexicalModelSpec): value is VendoredLexicalAsset {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.model_id === spec.model_id && v.version === spec.version && v.dims === spec.dims
    && typeof v.trigram_weights === "object" && v.trigram_weights !== null;
}

function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * Load the real, locally-vendored embedding model. This is genuinely wired
 * — it reads the pinned asset from disk and, when present, computes
 * deterministic embeddings from it (see `assetEmbeddingPort`) — but it has
 * never executed the success path in this environment: no vendor asset has
 * been checked in yet (this repository ships zero runtime dependencies,
 * and vendoring the actual model binary is follow-on work, per the ADR's
 * Consequences). It never downloads anything and never throws; a missing
 * or corrupt asset returns `null` so callers take Decision (4)'s bounded
 * fallback instead of failing the turn.
 */
export function loadVendoredEmbeddingPort(
  baseDir: string = packageRoot(),
  spec: VendoredLexicalModelSpec = VENDORED_LEXICAL_MODEL,
): EmbeddingPort | null {
  const assetPath = join(baseDir, spec.vendor_relative_path);
  if (!existsSync(assetPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(assetPath, "utf8"));
  } catch {
    return null;
  }
  if (!isVendoredLexicalAsset(parsed, spec)) return null;
  return assetEmbeddingPort(parsed);
}

/** Real embedder over a loaded vendored asset — a deterministic feature-hashing (trigram) embedding. */
function assetEmbeddingPort(asset: VendoredLexicalAsset): EmbeddingPort {
  const modelKey = `${asset.model_id}@${asset.version}`;
  return Object.freeze({
    model_key: modelKey,
    dims: asset.dims,
    embed(text: string): readonly number[] {
      return trigramEmbed(text, asset.dims, (trigram) => asset.trigram_weights[trigram]);
    },
  });
}

/** Deterministic character-trigram feature-hashing embedding, L2-normalized. */
function trigramEmbed(text: string, dims: number, weightFor: (trigram: string) => readonly number[] | undefined): number[] {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const vector = new Array<number>(dims).fill(0);
  if (normalized.length === 0) return vector;
  const padded = `  ${normalized}  `;
  for (let i = 0; i < padded.length - 2; i++) {
    const trigram = padded.slice(i, i + 3);
    const weights = weightFor(trigram);
    if (!weights) continue;
    for (let d = 0; d < dims; d++) vector[d] += weights[d] ?? 0;
  }
  return l2Normalize(vector);
}

function l2Normalize(vector: readonly number[]): number[] {
  let sumSq = 0;
  for (const v of vector) sumSq += v * v;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return vector.slice();
  return vector.map((v) => v / norm);
}

// ============================================================
// RANKING — exact float64 cosine similarity, stable total-order tie-break
// ============================================================

/**
 * Cosine similarity over exact float64 arithmetic. Vectors of mismatched
 * length compare as maximally dissimilar (-1) rather than throwing, so a
 * stale entry embedded under a retired model version never crashes
 * ranking — it simply sorts last, same as Decision (4)'s intent for
 * anything the current model cannot meaningfully compare.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return -1;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return -1;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Default injection cap (Decision 2). Applies on both the specialist and critic paths. */
export const DEFAULT_KB_INJECT_TOP_K = 20;

export interface TopKSelection {
  readonly entries: readonly KBEntry[];
  readonly mode: "lexical_trigram" | "fallback_exact_tag";
  readonly degraded_reason: string | null;
}

/** Text an entry is embedded/ranked against — the fields a reader actually cares about. */
export function kbEntryRankingText(entry: KBEntry): string {
  return [entry.value, entry.failure_mode, entry.root_cause, entry.fix_template, ...entry.tags]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");
}

const warnedModelKeys = new Set<string>();

/**
 * Surfaces the degraded-retrieval signal loudly (a real, deduplicated
 * console.warn) rather than letting a missing embedding model silently
 * change retrieval quality with no trace. Deduplicated per reason so a
 * hot inject() loop does not spam stderr once the condition is known.
 */
export function reportDegradedLexicalRetrieval(reason: string): void {
  if (warnedModelKeys.has(reason)) return;
  warnedModelKeys.add(reason);
  // eslint-disable-next-line no-console
  console.warn(`[arbor-kb] lexical retrieval degraded: ${reason}`);
}

/**
 * Rank `entries` against `queryText` and truncate to `top_k`. Decision 1's
 * ranking stage when `embedder` is available; Decision 4's bounded
 * exact-tag/recency fallback when it is not — the fallback is a hard cap
 * on top of today's behavior, never an unbounded dump.
 *
 * Entries missing a valid vector for `embedder`'s current model key are
 * embedded on demand from `kbEntryRankingText` (covers entries written
 * before an embedder was configured, or under a retired model version) —
 * this keeps ranking correct without requiring every historical entry to
 * be re-embedded before it can be seen.
 */
export function selectTopK(
  entries: readonly KBEntry[],
  queryText: string,
  opts: { readonly top_k: number; readonly embedder: EmbeddingPort | null },
): TopKSelection {
  const top_k = Math.max(0, Math.trunc(opts.top_k));
  if (!opts.embedder) {
    const reason = "no embedding model available (vendored asset not found); falling back to exact-tag/recency retrieval";
    reportDegradedLexicalRetrieval(reason);
    return { entries: truncateByRecency(entries, top_k), mode: "fallback_exact_tag", degraded_reason: reason };
  }

  const embedder = opts.embedder;
  const queryVector = embedder.embed(queryText);
  const ranked = entries
    .map((entry) => {
      const vector = entry.embedding_model === embedder.model_key && entry.embedding
        ? entry.embedding
        : embedder.embed(kbEntryRankingText(entry));
      return { entry, score: cosineSimilarity(queryVector, vector) };
    })
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.entry.id.localeCompare(b.entry.id)))
    .slice(0, top_k)
    .map((r) => r.entry);

  return { entries: ranked, mode: "lexical_trigram", degraded_reason: null };
}

function truncateByRecency(entries: readonly KBEntry[], top_k: number): readonly KBEntry[] {
  return [...entries]
    .sort((a, b) => (b.created_at !== a.created_at ? b.created_at.localeCompare(a.created_at) : a.id.localeCompare(b.id)))
    .slice(0, top_k);
}
