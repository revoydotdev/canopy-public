# ADR-166: Trajectory Reuse Uses Target-Bound Notes Without Granting Authority

**Status:** Accepted
**Date:** 2026-09-23
**Authoring Revision:** 0daed8256e1a9d811bd0308594c983a714353beb
**Content ID:** sha256:107fb39e8a4d362c5c88a3cfca033de8209dee7f44ca13de11a37c01611d1bc4

## Context

The Q2/Q3 2026 literature review finds a possible memory improvement in reusing a compact procedure with target-specific bindings, applicability conditions, and verification requirements instead of injecting a full prior trajectory. The cited QCR results are from web and application tasks, not Revoy2 repository campaigns; their reported success and token figures do not transfer here.

Revoy2 already has provenance-typed KB entries and bounded cross-session handoffs. The research question is whether a target-bound reuse note improves held-out follow-up work at equal retrieval, model, decoding, and tool budgets without granting authority or being mistaken for outcome evidence.

## Decision

Authorize a held-out evaluation of a Revoy-owned typed reuse-note projection before implementing one in the production KB. The candidate note contains source evidence identities, an abstract procedure, target-specific bindings to recover, applicability predicates, invalidation or expiry conditions, required verification, and an explicit authority ceiling.

Compare full-trajectory injection, the existing bounded handoff, and the candidate note with retrieval candidate, target state, model, decoding, and tool budget held fixed. Measure verified task success, context tokens, invalid-binding attempts, rejected tool calls, and verifier-confirmed results.

A reuse note remains `!claimed` or `!generated` until independently corroborated. It cannot add a tool or capability, satisfy an admission or approval gate, or mark a tree node `!verified`. Any production representation or changed KB write/read path requires a separate implementation review against the existing provenance and capability contracts.

## Consequences

The evaluation distinguishes compact reusable guidance from raw trajectory replay and exposes unsafe binding attempts. Its result applies only to the held-out Revoy2 fixtures and named versions; it does not validate the source paper's numerical results or establish cross-domain generality.

## Alternatives / Roads not taken

- **Inject the full prior trajectory.** Rejected as the candidate design because it spends context on target-irrelevant history and can confuse past actions with present authority.
- **Promote retrieved notes to verified KB facts.** Rejected because retrieval is not independent verification and cannot change provenance.
- **Adopt a production note format immediately.** Rejected because no Revoy2 holdout result currently establishes utility or safe binding.

## Obligations

### O1 — The reuse-note evaluation uses matched retrieval and execution budgets

The tracked E2 evidence record compares all three arms on held-out follow-up fixtures with the same retrieval candidate, target, model, decoding, and tool budget.

<!-- unverifiable: E2 is a proposed experiment; no result is claimed until a tracked evidence record exists. -->

### O2 — Reuse notes cannot grant authority or verification provenance

The E2 fixture and review show that a note cannot add tools, pass a policy gate, or mark an outcome verified, and that invalid target bindings are measured.

<!-- unverifiable: E2 is a proposed experiment; its fixture and evidence have not been created. -->
