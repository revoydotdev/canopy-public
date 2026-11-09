# ADR-153: Branch Accounting and Shared Reservations Are the Built Unlanded-Governance Controls

**Status:** Accepted
**Date:** 2026-08-31
**Authoring Revision:** 7b93d761f0959a32b2cf653270c651ac03f545fa
**Content ID:** sha256:441cfd2dff8ff2a7a4590ee2debff35e31401fb6a35594fbb130fcb35319a4de

## Context

ADR-146 was accepted on the premise that a new `gate:governance-debt` would
attribute ADR allocations to a claimant, enumerate decision records present on
local branches but absent from the push target, and block the push until those
debts landed or received a dated deferral. That gate was never implemented.
There is no `governance-debt` script or package command, branch accounting
reasons about commits rather than decision files, and the advisory ADR claim
ledger deliberately states that it is not a lock and blocks no write.

The repository did build three adjacent controls. `gate:branch-accounting`
finds commits reachable only from unaccounted local branches, treats a checked-
out or under-48-hour branch as visible work in progress, and blocks an older
unaccounted branch. Its dated disposition store becomes an accounted reference
and returns through `gate:decision-queue` on expiry. Separately, the ADR
allocator serializes allocation through the Git common directory and records a
short-lived shared reservation before mutating a worktree's tracked registry,
so sibling worktrees in one clone do not independently allocate the same
number. `adr-claim.mjs` records explicit advisory ownership for operator
coordination but is not enforcement.

The distinction matters. These mechanisms prevented or surfaced the branch and
number collisions that motivated ADR-146, but they do not prove its stronger
content-specific and claimant-attributed gate. Leaving ADR-146 Accepted makes
the obligation gate correctly red; adding `unverifiable` comments would
misclassify absent implementation as an epistemic limit.

## Decision

The built contract is the following narrower composition, and it supersedes
ADR-146's unimplemented `gate:governance-debt` contract.

1. **Branch retention is commit-accounted.** Integration refs and active dated
   dispositions are accounted references. Any older, non-worktree branch with
   commits reachable from no accounted reference blocks
   `gate:branch-accounting`. Checked-out and fresh branches remain visible as
   `in_progress`; they are not silently ignored and are not accused as
   abandoned work.
2. **Sibling allocation is reserved within one clone.** The allocator locks in
   the shared Git common directory, consults the untracked shared-reservation
   ledger, records the chosen number before tracked-tree mutation, and prunes
   landed or stale reservations. Separate clones still reconcile collisions at
   integration; this mechanism claims no distributed allocator.
3. **Explicit ADR ownership stays advisory.** `adr-claim.mjs` may name a holder,
   PID and ADR set for coordination and liveness reporting. It neither refuses
   a competing claim nor authorizes mutation and must never be cited as the
   blocking claimant receipt ADR-146 described.
4. **Deferral is dated and returns.** A branch disposition requires a reason
   and expiry, stops accounting when expired, and is independently projected
   into the decision queue. Deleting a branch is a retirement operation, not a
   reason to keep a stale disposition.
5. **No content-specific debt gate is claimed.** The current controls do not
   enumerate ADR files across refs, compare them with a push target, or
   attribute a dangling tracked allocation to the allocating session. If that
   stronger behavior is wanted later, it requires a new decision and failing
   fixtures; this record does not reserve the `gate:governance-debt` name.

## Consequences

The governance corpus now describes the enforcement operators can actually
run. The original incidents remain mechanically harder to hide: a unique old
branch becomes a blocker, an in-clone allocation collision is refused before
tracked mutation, and a dated deferral returns for review.

The ceiling is explicit. A branch can be accounted for while containing an ADR
that was omitted from a selective integration, and no current gate attributes
that omission to a claimant. Cross-clone allocation remains a merge-time
reconciliation problem. Operators must review branch contents before retirement
rather than reading a green branch-accounting result as content-level parity.

## Alternatives / Roads not taken

**Implement ADR-146 now.** Rejected by the recorded 2026-08-30 operator
decision, which directed superseding the unbuilt claim with the mechanisms that
exist. A future content-specific gate remains possible, but it must be justified
and tested as new scope rather than smuggled in as cleanup.

**Mark ADR-146's obligations unverifiable.** Rejected. The missing scripts and
call paths are directly verifiable evidence of non-implementation.

**Treat `adr-claim.mjs` as the claimant receipt.** Rejected because its public
contract is advisory and deliberately permits competing claims. Reporting
ownership and enforcing allocation debt are different authorities.

## Obligations

### O1 — Old unique branch commits block unless an accounted reference retains them

The branch-accounting evaluator computes commits reachable from no integration
or dispositioned ref, with fixtures for unique work, active worktrees, the
fresh-work grace period, expiry, and corrupt dispositions.

<!-- proof: symbol=uniqueCommits file=scripts/branch-accounting.mjs roundtrip=scripts/tests/branch-accounting.test.mjs -->

### O2 — One clone's sibling worktrees cannot silently allocate the same ADR number

The allocator consults and records shared reservations under its common-dir
lock before changing the tracked registry, and the allocator suite exercises
reservation-aware number selection.

<!-- proof: symbol=recordSharedReservation file=scripts/lib/adr-registry.mjs roundtrip=scripts/tests/adr-registry.test.mjs -->

### O3 — A branch deferral requires a reason and expiry and returns to the queue

Branch-accounting fixtures prove missing, corrupt, and expired rows fail closed;
the queue projects each dated branch disposition as a review commitment.

<!-- proof: symbol=waiverCommitments file=scripts/decision-queue.mjs roundtrip=scripts/tests/branch-accounting.test.mjs -->
