# ADR-079: A Precondition Must Be Satisfiable by the Action It Gates

**Status:** Accepted
**Date:** 2026-08-18
**Authoring Revision:** 68bccee417009289ea106474844696aafc05b4b2
**Content ID:** sha256:1d5c8f81a77cfaac18ae63cf8641d0f6684c231fa8be90bc079d5cfa628608fe

Authored as Proposed, not Accepted: the authoring change does not hold its own
acceptance authority (ADR-059).

**Scope.** This record refines constraint 1 of `evidence.refresh`
(`packages/arbor-mcp/src/native-tools/evidence-refresh.ts`). Constraints 2 and
3 — verify-after-commit, and graph-before-stores — are untouched, as is
ADR-034's rule that determinism is measured off the critical path.

## Context

`evidence.refresh` refuses to run `determinism:refresh` unless it has just
observed the suite green. The reason is sound and stays: refreshing the
determinism baseline against a red suite records that failure as a legitimate
recorded flake, laundering a broken test into committed evidence.

The predicate it uses is `bun run test` — the whole suite. On 2026-08-18 that
predicate deadlocked, twice in one session:

1. `scripts/tests/gate-failure-modes.test.mjs` asserts that the gates "agree
   with themselves on a clean tree" — specifically that `store-freshness-gate`
   exits 0 against the **committed** stores.
2. That test was red because `.determinism-baseline` was stale.
3. So `evidence.refresh` refused to refresh `.determinism-baseline`, because
   the suite was red, because `.determinism-baseline` was stale.

The operator broke the cycle both times with the documented per-store fallback
(`captest bun run determinism:refresh`). A guard whose documented escape hatch
is used every time it fires is not protecting anything; it is a toll.

**The structural fault is not "the predicate is too broad."** It is that the
predicate included an assertion the gated action *cannot clear*.
`store-freshness-gate` compares the working tree against **committed** bytes.
`evidence.refresh` deliberately never commits — constraint 2 states plainly
that committing a refreshed store is the operator's authority, not the tool's.
So that assertion is red until a human commits, and no amount of refreshing
will satisfy it. It is not a safety check on this action; it is an unrelated
condition that the action is structurally incapable of meeting.

## Decision

**A precondition may only include assertions that the gated action is capable
of clearing. An assertion the action cannot satisfy is not a safety check — it
is a deadlock, and it must be excluded from the predicate with its reason
stated.**

Applied to `evidence.refresh`'s constraint 1: the suite-green check excludes
assertions about **committed evidence-store freshness**, because clearing them
requires a commit and this tool holds no commit authority. Everything else in
the suite still gates, unchanged.

**What was considered and rejected: narrowing the predicate to the cited
seams.** That was the obvious fix and it is wrong, for the reason the module's
own header already gives:

> "Running the WHOLE suite once … rather than only the seams the existing
> baseline happens to cite is the deliberately more expensive but strictly more
> honest choice: a newly red test outside the current citation set would
> otherwise sail through undetected and still get baked in as soon as
> `determinism-baseline.ts` expands its own seam discovery."

That argument still holds. Seams-only would trade a narrow deadlock for a wide
blind spot. The exclusion above is the minimum that breaks the cycle while
keeping the protection the original choice bought.

**The exclusion set is declared, not inferred.** It is a named list, and each
member must state why the gated action cannot clear it. It has exactly one
member today. Growth is the signal to re-examine, not a routine edit — an
exclusion list that accretes silently would reproduce the drift this repository
has already been bitten by three times.

## Consequences

**Positive:**

- The guard stops firing on a condition it cannot resolve, so its escape hatch
  stops being the normal path. A guard that is routinely bypassed teaches
  operators to bypass guards.
- The rule generalizes beyond this tool. "Can the action I am gating actually
  clear this?" is answerable at design time for any precondition.

**Negative:**

- An exclusion list is a maintained artifact, and this repository's own history
  says maintained lists drift. Mitigated by keeping it declared, tiny, and
  reason-bearing — not by assuming it will stay small.
- A genuine regression *in* the excluded assertion is no longer caught by this
  particular predicate. It is still caught by `gate:store-freshness` itself, by
  the Stop battery, and by pre-push — this predicate was never its only guard.

**Neutral:**

- No change to what `determinism:refresh` measures, or to ADR-034's placement of
  determinism off the critical path.

## Obligations

### O1 — The excluded assertion is named, not pattern-matched

<!-- proof: symbol=SUITE_CHECK_EXCLUSIONS file=packages/arbor-mcp/src/native-tools/evidence-refresh.ts roundtrip=packages/arbor-mcp/tests/evidence-refresh.test.ts -->

The exclusion is a declared constant carrying its reason, so a reader can see
what is not gating and why. It is not a regex over failure text, which would
silently widen.

### O2 — Everything outside the exclusion still gates

<!-- proof: symbol=failuresAreAllUnclearable file=packages/arbor-mcp/src/native-tools/evidence-refresh.ts roundtrip=packages/arbor-mcp/tests/evidence-refresh.test.ts -->

A red test anywhere else still refuses the determinism refresh. The exclusion
removes one unsatisfiable condition, not the guard.

## Test implications

- With the evidence-freshness assertion red and nothing else red, the
  determinism refresh proceeds rather than refusing.
- With any other test red, it still refuses, and says which.
- The exclusion set is asserted to contain exactly its declared members, so
  silent growth fails a test rather than passing unnoticed.
