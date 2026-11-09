# ADR-059: ADR Acceptance Is a Separate Status-Only Authority Act

**Status:** Accepted
**Date:** 2026-08-12
**Authoring Revision:** c382f2083348231fe64bc9c72a8f4cad7eef2fb1
**Content ID:** sha256:b5e61cb426f4480042467e79ce8a34d65e81d5ac84bcae5285653ef48a9ca446

Authored as Proposed: the authoring change does not hold its own acceptance
authority.

## Context

ADR-044 states the repository rule directly: implementation authority is not
acceptance authority. ADR-024 and ADR-028 separate host action authority from
approval and policy authority, while ADR-026 keeps campaign execution under a
separate supervised command path. The ADR lifecycle needs the same
checks-and-balances applied reflexively to its own governance artifacts.

During the multi-worktree integration recorded in
`docs/postmortems/multi-worktree-branch-integration.md`, the Roadmap 09 and 10
implementers each created an ADR already marked `Accepted`. The downstream
claim-ledger caught those instances only because the index remained
`Proposed`. Had both surfaces agreed on the incorrect self-acceptance, the
contradiction signal would have disappeared.

The repository has no authenticated implementer/acceptor identity model and
this decision does not invent one. Git provenance provides a narrow,
deterministic proxy for the incident: authorship or substantive revision and
acceptance cannot occur in one commit.

## Decision

A commit that first adds an ADR must give it a leading status token of
`Proposed`. A later commit may change the leading token to `Accepted` only when
the ADR file's sole change is its `Status:` line. The matching index status may
change in that same later commit. Compound statuses such as ADR-024's
`Accepted (ratified ...; ... deferred ...)` are classified by their leading
token.

`scripts/adr-acceptance-gate.mjs` checks one commit, every commit in a range,
or the prospective staged snapshot. It imports the claim-ledger's canonical
leading-status and index/file comparison functions. An index contradiction,
new non-Proposed ADR, or acceptance bundled with substantive content fails
closed with a specific reason.

The checked-in pre-commit hook runs the staged check before claim-ledger
refresh. The integration conductor checks every commit in the rebased
trunk-to-candidate range after pending ADR allocation and before
merge-critical/property and ordinary isolation verification. `bun run build`
also checks `HEAD`, ensuring the executable gate and current decision snapshot
remain valid even where local hooks were never installed.

This is local enforcement and remains bypassable through Git's standard hook
escape hatch, as ADR-025 requires the repository to state honestly. The
conductor and build checks are independent defense in depth, not a claim of
server-side branch protection.

## Consequences

An implementing agent can propose a decision alongside its implementation but
cannot collapse proposal and acceptance into one authored change. A later
operator or integrator action remains possible without an identity or RBAC
system. Acceptors must separate any requested decision-body revision from the
status flip, making the accepted text independently reviewable in history.

The gate intentionally does not infer human identity or determine whether an
ADR deserves acceptance. It proves only commit separation and status/index
consistency. That narrow property directly prevents the observed failure
without overstating the authority available to local tooling.

## Obligations

### O1 — A newly-authored ADR cannot be Accepted in the same commit

<!-- proof: symbol=checkAdrAcceptance file=scripts/lib/adr-acceptance.mjs roundtrip=scripts/tests/adr-acceptance-gate.test.mjs -->

### O2 — A later acceptance passes only when the ADR body is unchanged and compound statuses are classified by their leading token

<!-- proof: symbol=leadingAdrStatus file=scripts/claim-ledger.ts roundtrip=scripts/tests/adr-acceptance-gate.test.mjs -->

### O3 — Staged authoring and rebased candidate histories are both refused before landing

<!-- proof: symbol=checkAdrAcceptance file=scripts/lib/adr-acceptance.mjs roundtrip=scripts/tests/integration-conductor.test.mjs -->

### O4 — Index/file contradiction parsing has one implementation shared with the claim ledger

<!-- proof: symbol=findAdrIndexDefectsFromEntries file=scripts/claim-ledger.ts roundtrip=scripts/tests/adr-acceptance-gate.test.mjs -->
