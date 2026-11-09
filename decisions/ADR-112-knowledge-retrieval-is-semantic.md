# ADR-112: Knowledge Retrieval Is Semantic, Not Exact-Tag Match

**Status:** Accepted
**Date:** 2026-08-26
**Authoring Revision:** 5afc268fd12b3731abf2ba5b1ca52a3c941f8153
**Content ID:** sha256:7890ae8cbee7fafc3c37f6e3bbfa1c0b4ff8ab43b0a115fd53cd7e3a0217d5f5

## Context

Verified against `packages/arbor-kb/src/` at 5afc268f: `KnowledgeBase.query`
(`kb.ts:208-232`) is a linear scan over `this.longTerm.values()` filtered by
exact `campaign_id` equality, exact `type` equality, and `filter.tags.every(t
=> entry.tags.includes(t))` — string-set membership, not similarity. `inject`
(`kb.ts:246-283`) is real, tier-gated, campaign-scoped prompt injection wired
at the point specialists and critics actually receive context: specialists get
only `type: "failure_mode"` entries optionally narrowed by `category` (an
exact tag check), critics get `query(campaignId, null, cap)` — every entry the
campaign owns, filtered only by the `critic_only`/`specialist_visible` tier
gate. Neither path ranks, scores, or caps result count: there is no `MAX_*`,
`limit`, `slice(0, k)`, or `top_k` anywhere in `kb.ts`. `grep -riE
"embed|vector|cosine" packages/arbor-kb/src` returns no matches — confirmed,
the audit finding holds exactly as stated. The consequence is sharper than
"retrieval quality degrades": for a critic, `inject` has no ceiling at all —
every entry a campaign owns above the tier gate goes into the prompt, so
`arbor-kb/tests/scale-thresholds.test.ts`'s own >1,000-entry parity fixture
would, run through `inject` unmodified, produce a >1,000-line context block.
The test asserts backend query-result parity at scale, not bounded injection
size — nothing in this package currently prevents that growth.

`sqlite.ts` is a genuine dual-runtime backend, not a stub: it branches on
`globalThis.Bun` to load `bun:sqlite` versus lazily `require("node:sqlite")`'s
`DatabaseSync` on Node 22, because Bun does not ship `node:sqlite` and Node
does not ship `bun:sqlite` — a real constraint this file documents and
resolves, not an assumption.

This repository has already built, and already uses, the right instrument for
justifying a retrieval-quality change: `packages/arbor-eval/src/
repository-retrieval-eval.ts`'s `evaluateRepositoryRetrieval` measures
`exact_task_recall` and `mean_projection_reduction` for a `RepositoryGraphIndex`
against a `calibration`/`held_out` cohort split, and
`RepositoryRetrievalAblation` runs named arms side by side for comparison.
`docs/CODE-INTEL-ROUTING.md` (amended 2026-08-24 for ADR-090) is the
adjacent precedent for how this repository actually decides index questions:
it names a real, measured cost — "confirming that `OperationRecord` lacks a
`kind` field took roughly eight file reads across three packages" during a
forensic audit — as "the business case for building an index — and equally
the case for not pretending one exists." That file is about VI's structural
code graph, not the KB, but its discipline is exactly what this record
follows: name the measured cost, do not assume the benefit.

Two structural constraints govern the decision itself. First, `package.json`
at repo root declares zero runtime `dependencies` — this repository ships with
none today, and either form of embedding-backed retrieval breaks that: a
remote embedding API is a network call in the retrieval path (cost, latency,
provider-outage coupling, and — because `inject()` runs inline in prompt
construction — a new failure mode for every specialist/critic turn), while a
local embedding model is a multi-hundred-megabyte-to-gigabyte binary
dependency this repository has never carried. Second, `scripts/
determinism-baseline.ts` (ADR-034) measures flake rate for the test seams
cited by `roundtrip=` proofs across this repository's gates; an
embedding-ranked retrieval whose top-k selection depends on a remote model
that can be silently upgraded, or on floating-point similarity comparisons
whose tie-breaking is not pinned, is a nondeterminism source ADR-034's
machinery was not built to see, because it measures repeated-run flakiness of
*cited test files*, not run-to-run drift in a live retrieval ranking a test
merely exercises once.

## Decision

**1. Retrieval gets a ranked, bounded top-k stage in front of `inject`,
computed from local, deterministically-versioned embeddings — not a remote
API.** A new `arbor-kb` module (`retrieval.ts`) computes an embedding vector
per `KBEntry` at write time using a locally-vendored, fixed-version embedding
model (the same "pin the version, run it locally" posture this repository
already takes for its language servers in ADR-090, and consistent with the
zero-runtime-dependency posture only in the sense that it is a *build/vendor*
dependency checked into the toolchain, not a live network dependency).
Ranking is cosine similarity over exact 32/64-bit float arithmetic with a
stable, total-order tie-break (entry `id` as the final key) — no ranking
output may depend on iteration order, map insertion order, or a network
round-trip's timing. This directly answers the determinism concern named in
Context: a local, versioned model with pinned arithmetic and a defined
tie-break produces the same ranking for the same input on every run, which a
remote API — subject to silent model upgrades — cannot promise.

**2. `inject` gains a `top_k` ceiling on every path, replacing "everything
that matches the tier gate" with "the k most relevant entries that pass it."**
The specialist path keeps its existing `type`/`category` filter as a hard
pre-filter (semantic ranking narrows within that filter, it does not replace
it — a specialist should not receive a critic's unrelated failure mode just
because it scores high), then ranks and truncates to `top_k`. The critic path
keeps the tier gate as a hard pre-filter, then ranks and truncates the same
way — closing the unbounded-injection gap named in Context regardless of
whether semantic ranking ships, because a hard cap alone is real risk
reduction independent of ranking quality.

**3. Retrieval quality is measured before and after using the existing
ablation pattern, not asserted.** A `KnowledgeBaseRetrievalCohort` fixture,
structured the same way `RepositoryRetrievalCohort` is —
`calibration`/`held_out` scope, `required_path_groups`-equivalent expected-
entry sets per query — feeds an ablation with at least two arms: `exact-tag`
(today's `query` behavior) and `semantic-topk` (this decision's ranking).
`evaluateRepositoryRetrieval`'s guard pattern (`EconomizationGuardResult`,
`evaluateEconomizationGuard`) is the template: this decision does not ship
until the `semantic-topk` arm's `held_out` recall is measured against the
`exact-tag` baseline on a real held-out query set, the same discipline
`repository-retrieval-eval.ts` already applies to code retrieval.

**4. Exact-tag `query` is kept as the pre-filter and as a fallback, not
removed.** `KnowledgeBase.query`'s signature and semantics are unchanged;
`inject` composes ranking on top of it rather than replacing its filtering.
If the embedding model is unavailable at runtime (a corrupted vendor asset, a
platform the model was not built for), `inject` falls back to `query`'s
exact-tag result set, truncated to the same `top_k` by recency
(`created_at`) rather than similarity — degrading to today's exact-match
behavior under a cap, never to an unbounded dump and never to a hard failure.

## Consequences

`inject`'s prompt-context growth stops being proportional to campaign KB size
and becomes proportional to `top_k`, closing the unbounded-injection gap
identified in Context independent of ranking quality. A specialist or critic
with a large KB gets the entries most relevant to its current prompt rather
than every entry that happens to share a tag (specialist path) or every
entry period (critic path) — this is the actual "degrades as volume grows"
fix, not merely a quality improvement.

What gets harder: this repository takes on its first vendored ML model
artifact, with the storage, licensing, and platform-availability
obligations that carries — a model that fails to load on an unsupported
architecture must degrade per Decision (4), not fail the turn, and that
fallback path is now permanent surface area to test and keep correct.
Embedding computation at write time adds latency and a new failure mode to
`KnowledgeBase.write` that did not exist before. `sqlite.ts`'s dual-runtime
split (`Bun`/`node:sqlite`) now has to carry vector storage and similarity
computation consistently across both backends, or `scale-thresholds.test.ts`'s
backend-parity guarantee breaks for the new retrieval path even while holding
for the old one. And Decision (3)'s ablation is real, ongoing work, not a
one-time report: an ablation is only honest evidence for the retrieval
behavior it measured, and this repository's own `repository-retrieval-eval.ts`
precedent implies the KB ablation cohort needs to be revisited as the KB's
entry population and query patterns actually change, not run once and cited
forever.

This decision does not change `KnowledgeBase.query`'s public signature or its
exact-tag semantics, does not change `sqlite.ts`'s Bun/Node dual-runtime
branch itself, and does not remove the `specialist_visible`/`critic_only`
tier gate — ranking and the top-k cap apply strictly after that gate, never
in place of it.

## Alternatives / Roads not taken

**A remote embedding API (OpenAI/Voyage/Cohere-style embeddings-as-a-service)
instead of a local model.** Rejected on the determinism ground stated in
Context: a provider can silently version-bump its embedding model, changing
every existing entry's vector meaning without this repository's knowledge or
consent, which is a correctness hazard beyond mere network dependency —
`gate:determinism`'s whole premise is that a cited seam's behavior is stable
run to run, and an externally-versioned embedding space is the opposite of
that by construction. It is also a genuinely new class of dependency this
repository has avoided everywhere else: a live network call inside prompt
construction, on the critical path of every specialist/critic turn.

**BM25 or another sparse lexical-scoring method instead of dense embeddings.**
Considered seriously, not dismissed. A sparse scorer is deterministic,
requires no vendored model, and is a real improvement over unranked exact-tag
match on its own — it would satisfy Decision (2)'s top-k cap without
Decision (1)'s model-vendoring cost. It was not chosen as the sole mechanism
because KB entries (failure modes, root causes, fix templates) are short,
low-vocabulary-overlap text where synonymy matters more than term frequency —
"timeout" and "connection refused" describing the same underlying failure
share no tokens. This record's Decision (3) ablation should include a
sparse-scoring arm alongside `exact-tag` and `semantic-topk` so the tradeoff
is measured rather than assumed away in either direction.

**Leave `query` as-is and add only a `top_k` cap with no ranking (truncate by
recency or insertion order).** Rejected as the sole fix, though Decision (4)
keeps it as the degraded fallback: a cap without ranking turns "unbounded and
unranked" into "bounded and arbitrary" — still no better than random which
entries a specialist sees when more entries match a tag than fit the cap.
It is the right fallback for when ranking is unavailable, not a substitute
for ranking when it is.

## Obligations

### O1 — `inject`'s exact-tag, unranked, uncapped injection is the real current behavior, not an audit assumption

`KnowledgeBase.query`'s tag filter is string-set membership with no scoring,
and `inject`'s critic path passes every tier-gated entry through with no
`top_k`. This is the precise baseline Decision (2)'s cap and Decision (1)'s
ranking replace, and it is directly demonstrated today against the
`KnowledgeBase` class this decision modifies.

<!-- proof: symbol=KnowledgeBase file=packages/arbor-kb/src/kb.ts roundtrip=packages/arbor-kb/tests/kb.test.ts -->

### O2 — This repository already has a working ablation harness for retrieval-quality claims, which Decision (3) reuses rather than inventing

`evaluateRepositoryRetrieval` runs named arms over a `calibration`/`held_out`
cohort split and reports `exact_task_recall` and `mean_projection_reduction`
under an economization guard. Citing this now, before the KB ablation cohort
exists, demonstrates that the discipline Decision (3) commits to — measure
before and after, do not assert — has a real, proven precedent in this
codebase rather than being a novel promise.

<!-- proof: symbol=evaluateRepositoryRetrieval file=packages/arbor-eval/src/repository-retrieval-eval.ts roundtrip=packages/arbor-eval/tests/repository-retrieval-eval.test.ts -->

### O3 — No embedding, vector, or similarity computation exists anywhere in `arbor-kb` today

`packages/arbor-kb/src/retrieval.ts` now implements `cosineSimilarity` (exact
float64 arithmetic) and `selectTopK` (ranking with a stable, total-order
tie-break on entry `id`). Determinism is demonstrated, not merely ranking's
existence: `packages/arbor-kb/tests/retrieval.test.ts`'s "identical top-k
output across repeated runs on the same input" case runs `selectTopK` twice
against the same fixed entries and a fixed embedder and asserts the ordered
id list is byte-identical. The real vendored embedding model this decision
names (`loadVendoredEmbeddingPort`, `VENDORED_EMBEDDING_MODEL`) is genuinely
wired but has never executed its success path in this environment: no
vendor/embedding-model/model.json asset has been committed to this
repository yet, so only its miss branch (falling back to Decision 4) has
run — vendoring the real asset is follow-on work. All ranking tests in this
tranche exercise the port boundary via a deterministic test double
(`packages/arbor-kb/tests/helpers/fake-embedder.ts`), never a live model.

<!-- proof: symbol=selectTopK file=packages/arbor-kb/src/retrieval.ts roundtrip=packages/arbor-kb/tests/retrieval.test.ts -->

### O4 — `inject`'s `top_k` ceiling does not exist yet, and the unbounded-critic-injection risk it closes is real today

`KnowledgeBase.inject` and `SqliteKbStore.inject` both now take a `topK`
parameter (defaulting to `DEFAULT_KB_INJECT_TOP_K`) and truncate via
`selectTopK` on both the specialist and critic paths, after their existing
pre-filters. `packages/arbor-kb/tests/retrieval.test.ts`'s cap tests
construct 200 tier-gated entries against a cap of 10 (critic path) and 50
entries against a cap of 5 (specialist path) and assert the injected block
never exceeds the cap on either backend (`KnowledgeBase` and
`SqliteKbStore`), including when the embedding model is unavailable and
retrieval degrades to Decision (4)'s exact-tag/recency fallback — the cap is
enforced independent of ranking mode.

<!-- proof: symbol=KnowledgeBase file=packages/arbor-kb/src/kb.ts roundtrip=packages/arbor-kb/tests/retrieval.test.ts -->
