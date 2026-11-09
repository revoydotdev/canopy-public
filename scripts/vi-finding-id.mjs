/**
 * scripts/vi-finding-id.mjs — the ONE authoritative stable-id implementation
 * for `.visual-intelligence/findings/findings.jsonl` (ADR-042 Half B).
 *
 * Shared by `vi-findings.mjs` (`--rewrite-ids`, applied to the vendored
 * validator's sequential VI-0001-style ids) and `vi-observed-compare.mjs`
 * (which mints ids directly, at emission time, so its findings are "born"
 * with a stable id and never need rewriting). Two independent
 * implementations of the same hash would be exactly the kind of duplicated
 * knowledge this repository's CLAUDE.md calls out — one authoritative
 * source, imported both places.
 */

import { createHash } from "node:crypto";

const sha256Hex = (s) => createHash("sha256").update(s).digest("hex");

/** Deterministic JSON stringify: object keys sorted, arrays left in order. */
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/**
 * Strip counts from a title so "orphans-no-inbound: 6 record(s)" and
 * "...: 7 record(s)" share an id — the SUBJECT is the identity, not the
 * day's count. Any run of digits is removed (dates inside a title would also
 * fold, which is intentional: a title should not encode a moving number at
 * all if its identity is meant to be stable).
 */
export function normalizeTitle(title) {
  return String(title ?? "").replace(/\d+/g, "").replace(/\s+/g, " ").trim();
}

/**
 * `vi:<first 16 hex of sha256(category + "\n" + normalized title)>` — a
 * stable SUBJECT identity, deliberately independent of `affected_nodes`.
 *
 * A finding can gain or lose symbols as the observation graph improves. That
 * must REOPEN the recorded verdict (the triage row's `symbol_set` enforces
 * that), but it must not mint a different finding id and strand the previous
 * verdict as an apparent orphan. Identity answers “which question is this?”;
 * the content hash and symbol set answer “has that question changed enough to
 * need a new operator decision?”.
 *
 * The category plus normalized title is the detector's stable subject label:
 * emitted per-file titles include the path, and aggregate titles deliberately
 * collapse changing counts. `rewrite-ids` rejects a collision rather than
 * guessing if an emitter ever violates that uniqueness contract.
 */
export function stableFindingId(finding) {
  const basis = `${finding.category}\n${normalizeTitle(finding.title)}`;
  return `vi:${sha256Hex(basis).slice(0, 16)}`;
}

/**
 * Fields stamped per RUN, not per finding: hashing them makes every refresh
 * reopen every verdict (observed on the first post-rebase regeneration —
 * `found_at_revision` alone reopened all 63 findings), which turns triage
 * into busywork and defeats ADR-042 O4. `id` is excluded because it is
 * derived from the substance this hash already covers.
 */
const RUN_STAMP_FIELDS = new Set(["id", "found_at_revision"]);

/**
 * Strip cosmetic record/symbol counts (e.g. "651 record(s)", "20 file(s)")
 * out of a hashed string, so a count moving day-to-day does not rotate the
 * content hash — the same reasoning `RUN_STAMP_FIELDS` already applies to
 * `found_at_revision` (see that comment: hashing a per-run stamp reopened
 * all 63 findings on the first refresh). This one forced a 52-verdict mass
 * re-attestation the day a record count moved from 753 to 760.
 *
 * Deliberately narrow, NOT a blanket `\d+` strip: only a digit run
 * immediately followed by " <word>(s)" is replaced. A catalog hash like
 * "declared scenario catalog hash 7dbf7d1c2a6976ec" is never followed by
 * that pattern, so it survives untouched — a genuine catalog change MUST
 * still reopen catalog-relative verdicts (that behavior is intentional; see
 * this function's own doc below).
 */
function stripCosmeticCounts(value) {
  // The unit phrase may be several words: real bodies read "1 file(s) (1
  // visible symbol(s)) in arbor-audit …", and a single-word lookahead
  // normalizes "1 file(s)" while leaving "1 visible symbol(s)" untouched —
  // so a symbol-count change alone still reopened every catalog_gap verdict.
  // Bounded to three intervening words rather than unbounded `(\w+\s+)*` to
  // keep the lookahead from backtracking over long prose.
  //
  // A catalog hash is not at risk: it is followed by ")." and never by a
  // "(s)" unit, so no digit run inside the hex can satisfy this lookahead.
  // That is load-bearing — a changed catalog MUST still reopen its verdicts.
  return typeof value === "string" ? value.replace(/\d+(?=\s+(?:\w+\s+){0,3}\w+\(s\))/g, "N") : value;
}

/** Deep-maps `stripCosmeticCounts` over every string leaf in a JSON value. */
function normalizeCosmeticCounts(value) {
  if (typeof value === "string") return stripCosmeticCounts(value);
  if (Array.isArray(value)) return value.map(normalizeCosmeticCounts);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeCosmeticCounts(v)]));
  }
  return value;
}

/**
 * sha256 (first 16 hex) of the canonical finding body MINUS run-stamp
 * fields MINUS cosmetic counts — sensitive to every substantive field,
 * including the catalog hash inside `observed_model` (a changed catalog
 * SHOULD reopen catalog-relative verdicts) but NOT a record/symbol count
 * moving on its own. This is what lets the triage gate distinguish "still
 * the same open question" (stable id, same content hash) from "the
 * underlying finding changed since it was triaged" (stable id, different
 * content hash -> reopened) — without a mere count refresh masquerading as
 * the latter.
 */
export function findingContentHash(finding) {
  const substance = Object.fromEntries(
    Object.entries(finding).filter(([k]) => !RUN_STAMP_FIELDS.has(k)),
  );
  return sha256Hex(canonical(normalizeCosmeticCounts(substance))).slice(0, 16);
}

/**
 * The PRE-normalization digest, kept solely so a one-time migration can tell
 * two indistinguishable situations apart.
 *
 * When count normalization landed, every recorded `content_hash` went stale
 * at once — not because any finding changed, but because the formula did.
 * From the stored digest alone, "the algorithm moved" and "this finding's
 * substance moved" look identical, and blanket-rewriting the store would
 * silently re-attest the second kind: a verdict would be carried forward
 * over a body a human never re-read. That is precisely the fabricated human
 * decision `gate:vi-findings` exists to prevent.
 *
 * With this function the migration is decidable. If the recorded digest
 * equals V1 of the CURRENT body, the body is provably unchanged and only the
 * formula moved, so the row can be rehashed. If it does not match, the
 * finding genuinely changed and the verdict must stay reopened for a person.
 *
 * Delete this once no committed triage row predates the normalization.
 */
export function findingContentHashV1(finding) {
  const substance = Object.fromEntries(
    Object.entries(finding).filter(([k]) => !RUN_STAMP_FIELDS.has(k)),
  );
  return sha256Hex(canonical(substance)).slice(0, 16);
}
