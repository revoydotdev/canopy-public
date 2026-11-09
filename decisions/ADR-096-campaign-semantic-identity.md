# ADR-096: Campaign Persistence Is Bound to Semantic Identity and Explicit Rebase

**Status:** Accepted
**Date:** 2026-08-25
**Authoring Revision:** 999de38b53dbba1e528a1d20ad90829b73b751a9
**Content ID:** sha256:d28f173b90ffaa0ede0a554625ced12a1e947f893bf402d0ee3efc39d54bf663

## Context

`@arbor/core` validates persisted campaign and retry data structurally, but the
semantic-lifecycle audit found no compatibility boundary between the facts that
created UCT authority and a later restore. A saved tree can therefore retain
visit/value statistics, terminal and prune decisions, ranking authority, and
retry context after changes to the objective, action set, repository,
governed context, memory projection, score/reward policy, verification policy,
skills, tools, or provider capabilities. A sealed retry capsule can similarly
remain prompt and suppression authority after its evidence context changes.

ADR-002 selects the UCT scorer, ADR-009 makes tree search the execution model,
ADR-012 governs interrupted recovery, and ADR-014 makes memory a witnessed
projection. None says which combined inputs identify the semantics of a saved
campaign generation or what a rebase may carry forward. Step 0 must settle
legacy treatment and rebase before restore and retry consumers are changed.

## Decision

Every admitted campaign generation and retry capsule MUST bind one versioned
`CampaignSemanticIdentity` and its canonical fingerprint. The identity is
created at admission, rechecked before dispatch, and persisted with the tree,
boulder pointer, retry context, and any future transposition, rollout, or value
cache.

### 1. Canonical identity inputs

The identity includes the objective/plan; ordered action set and every action
authority field; repository/worktree revision or provenance root; governed
context revision; memory-projection snapshot id; acceptance, evidence,
scoring, reward, retry, verification, skill, and policy versions; available
tool/environment/catalog capabilities; and, for retry, the prior evidence
identities. Canonical serialization is versioned and rejects missing,
duplicate, non-finite, or non-canonical values rather than hashing a convenient
subset.

### 2. Closed compatibility result

The domain analyzer returns exactly one of `compatible`, `stale_environment`,
`stale_objective`, `stale_action_set`, `stale_policy`, `stale_provenance`,
`invalid`, `legacy_historical`, or `analyzer_failed`. Only `compatible` may
resume a tree, repair/select a boulder pointer, preserve UCT visits/value,
terminal/pruned state or ranking, inject retry context, synthesize retry
suppression, or call `recordResult`. Every restore, selection, report/queue,
retry prompt, and retry-enforcement path consumes this one result.

### 3. Legacy is history, never implicit compatibility

State without a complete supported identity is `legacy_historical`. Corrupt or
unanalyzable state remains quarantined/invalid. Neither may be silently
upgraded, treated as a clean first attempt, or used as active authority. It
remains inspectable with diagnostics and lineage.

### 4. Rebase creates a new generation

Rebase is an explicit admission operation that creates a new campaign
generation and identity linked to its historical parent. It never mutates the
old identity in place and never automatically carries UCT visits/value,
terminal/pruned state, active-node pointers, retry suppression, or execution
authority. Immutable source evidence, ledger facts, and KB entries may be
referenced only after their own applicability analysis; they are not copied as
active merely because their bytes are sealed. A changed objective or action
set requires a new generation, not a compatibility override.

There is no automatic rebase on startup and no force-resume escape hatch. An
operator may request rebase, but the ordinary admission, scope, evidence, and
capability gates still decide whether the new generation can execute.

## Consequences

Restart becomes deterministic about authority: unchanged semantics resume;
changed semantics remain available as history but cannot steer selection or
retry. Future persistent search caches inherit the same boundary from their
first version instead of inventing invalidation later.

The cost is a larger persisted identity, versioned canonicalization, migration
diagnostics, compatibility checks at several hot paths, and explicit operator
workflow for rebase. Existing unidentified snapshots stop auto-resuming. That
is an intentional compatibility break: preserving unexplained UCT authority is
more dangerous than requiring fresh admission.

## Alternatives / Roads not taken

1. **Use repository revision alone.** Rejected because policy, context,
   capabilities, and objective can change without a different source commit.
2. **Invalidate only cached scores.** Rejected because terminal, prune,
   active-pointer, retry, and suppression state also carries authority.
3. **Best-effort migration of legacy snapshots.** Rejected because absent
   identity inputs cannot be reconstructed truthfully after the fact.
4. **Allow force resume.** Rejected because it bypasses the exact semantic
   admission boundary this decision establishes; explicit rebase supplies a
   governed alternative without rewriting history.

## Obligations

### O1 — Mutating any semantic-identity input prevents old campaign and retry authority from being consumed

<!-- unverifiable: CampaignSemanticIdentity and the restart mutation matrix do not exist at authoring time. -->

Acceptance requires table-driven mutations of repository, objective, action,
policy/score, context/KB, skills, tools, capabilities, and retry evidence that
prove no select, rank, inject, suppress, pointer repair, or `recordResult`
occurs; an unchanged control must resume.

### O2 — Legacy and corrupt state remain inspectable but never become active or clean-first-attempt state

<!-- unverifiable: legacy-history projection and quarantine migration fixtures are future work. -->

Acceptance requires missing-version, missing-input, unsupported-version,
corrupt, and analyzer-failure fixtures with explicit historical/quarantine
diagnostics and no execution authority.

### O3 — Rebase creates a newly admitted generation and carries no UCT or retry authority implicitly

<!-- unverifiable: the explicit campaign rebase operation and lineage tests do not exist at authoring time. -->

Acceptance requires proof that a rebase has a new identity and lineage,
reruns admission, leaves the parent immutable, and resets visits/value,
terminal/pruned state, active pointers, and retry suppression.

### Acceptance note

This record remains Proposed. Acceptance is a separate operator act under
ADR-059 after the native decision interview chooses legacy and rebase policy.
