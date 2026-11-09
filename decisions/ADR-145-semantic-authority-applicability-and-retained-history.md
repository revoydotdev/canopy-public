# ADR-145: Semantic Authority Requires Current Applicability and Retained History

**Status:** Accepted
**Date:** 2026-08-25
**Authoring Revision:** 764ccfd0c66e16c8372a823e3420d115e7858e58
**Content ID:** sha256:7a1c5d90c283564306f993d8ce529cb33eb5fd3945c6a31754dfa9e85d64d06b

**Renumbered from ADR-095.** This record was authored on 2026-08-25 at revision
999de38b and Accepted on a worktree branch that never landed. Master
independently allocated 095 to a different record ("A Search Claim Is Evidenced
By Live-Model Evaluation") on 2026-08-26, which has been Accepted and cited
since. The branch claimed the number first, but the landed record is the one
with live citations, so this one moves. Nothing in the decision below changed;
only its identity did.

## Context

The semantic-lifecycle audit at
`docs/semantic-lifecycle-audit/` found the same defect shape in otherwise
unrelated governance stores: a row remains parseable after the fact that made
it authoritative has changed, and a gate, queue, report, or renewal workflow
continues to treat raw presence as current authority. Reachability already
computes stale rows and allowlist read errors but omits them from its success
predicate; other exception families inspect only rows that happen to match a
current finding, so resolved, deleted, moved, unused-expired, and malformed
unused rows can disappear from disposition. Raw decision-queue and governance
readers then independently reconstruct a different active set.

ADR-055 binds generated evidence freshness to content hashes, ADR-068 keeps
advisory evidence durable, and ADR-094 defines client-side projection
freshness. None defines the domain rule that makes a persisted governance row
currently applicable, the severity of an unavailable analyzer, or how history
is retained after authority ends. Step 0 of the audit remediation plan requires
those choices before individual gates are patched, otherwise each consumer
will invent a subtly different lifecycle again.

## Decision

Authority-bearing persistent records MUST be consumed through a domain-owned,
versioned applicability projection. Raw file presence, schema validity,
provenance, expiry, or a previously successful analysis is admission evidence;
none is sufficient current authority by itself.

### 1. Closed applicability and severity

Every exception-like analyzer enumerates every stored row into exactly one of:

`active`, `expired_live`, `stale_resolved`, `stale_deleted_or_moved`,
`superseded`, `invalid`, `historical_only`, or `analyzer_failed`.

Only `active` may waive, suppress, renew, or reduce a gate finding. `invalid`,
`analyzer_failed`, or an unavailable authority dependency is blocking for an
authority-bearing gate and cannot be serialized as an empty active set.
`expired_live`, stale, and superseded rows in an active store are also
blocking cleanup debt until a governed retirement transition moves them out of
the active store. Once durably retired, `historical_only` remains queryable but
is non-blocking and never renewal-capable. A presentation-only or analytics
store may classify missing history as nonfatal only when no admission, gate,
queue, selection, dispatch, credential, or mutation consumer exists.

Gate, human report, JSON report, governance snapshot, and decision queue MUST
consume the same projection identity and partition counts. Presentation may
differ; membership and severity may not. An interview can decide an active
commitment, but cannot convert cleanup, invalid, historical, or unavailable
state into active authority.

### 2. Semantic identity is domain-owned

Every active row binds a stable row id, analyzer/schema version, current input
or snapshot fingerprint, subject identity, semantic fingerprint, and bounded
explanation. Each domain owns the fields that make its subject the same
subject: an export plus entry-point graph for reachability, a branch/ref for
branch disposition, a rule plus finding fingerprint for anti-stub, and the
corresponding catalog/route/occurrence identity for TUI, palette, API-only, and
closed-enum exceptions. A coincidentally equal display key is not identity.

### 3. Retirement retains provenance without retaining authority

Resolution, deletion, move, expiry, supersession, analyzer-version change, or
incompatibility creates an append-only retirement record containing the prior
row id and semantic fingerprint, disposition, time, actor/producer, cause,
replacement id when any, analyzer version, and input/snapshot id. The active
projection excludes it deterministically. Reintroducing the same display key
requires fresh analysis and a new decision; history may be cited but never
reactivates itself.

Migration MUST be non-destructive. Existing rows are analyzed under the new
contract: provably current rows receive a versioned active identity; stale or
invalid rows move to retained history; ambiguous or unanalyzable rows fail
closed until repaired. There is no compatibility fallback to a raw reader
during or after cutover.

## Consequences

False-green gates, raw renewal queues, and contradictory governance counts
become one class of mechanically testable defect. Operators gain an explicit
cleanup/history queue instead of being asked to renew records whose subjects
no longer exist. Historical provenance remains inspectable and immutable where
its domain requires it.

The cost is domain-specific analyzers, migration code, stable fingerprints,
tombstone storage, and coordinated consumer cutovers. Some repositories that
previously passed with stale active-store rows will correctly fail until those
rows are retired. This ADR does not make all persistence generic: generated
evidence snapshots, campaign state, schedules, budgets, integrations, and
verification results retain their own state machines.

## Alternatives / Roads not taken

1. **Patch each gate predicate independently.** Rejected because queue and
   governance readers would continue to reconstruct different active sets.
2. **Delete stale rows on sight.** Rejected because deletion destroys the
   provenance needed to explain why authority ended and permits key reuse to
   look like a first occurrence.
3. **Treat stale rows as warnings forever.** Rejected because a warning that
   can still waive or renew is authority, and a warning that cannot be retired
   becomes permanent operational noise.
4. **Use one universal applicability matcher.** Rejected because subject
   identity and invalidation differ materially across exports, branches,
   findings, routes, evidence snapshots, and campaigns.

## Obligations

### O1 — Every stored exception row has exactly one disposition and only active rows can affect authority

<!-- unverifiable: the domain applicability analyzers and exhaustive partition property tests are implementation work required before acceptance. -->

Acceptance requires property tests that enumerate active, expired, resolved,
deleted/moved, superseded, invalid, historical, and analyzer-failure fixtures
and prove no non-active row can waive, suppress, or enter renewal work.

### O2 — Gate, queue, JSON, human, and governance consumers share one active set and severity

<!-- unverifiable: canonical consumer cutovers and equality fixtures do not exist at authoring time. -->

Acceptance requires injected-projection tests and a raw-reader inventory that
prove all authority consumers serialize the same projection identity,
partitions, counts, and fatal analyzer failures.

### O3 — Retirement preserves history without allowing key reuse to reactivate authority

<!-- unverifiable: retirement records and migration fixtures are future implementation work. -->

Acceptance requires resolution, deletion, rename, expiry, analyzer-version,
and same-display-key/new-subject fixtures proving a new decision is required
while the prior disposition remains queryable as history.

### Acceptance note

This record remains Proposed. Acceptance is a separate operator act under
ADR-059 after the native decision interview selects this severity and retention
policy.
