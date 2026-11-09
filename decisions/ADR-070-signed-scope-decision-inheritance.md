# ADR-070: Signed Scope-Decision Inheritance

**Status:** Accepted
**Date:** 2026-08-15
**Authoring Revision:** 46e7d15f1b4775002a1b16adc62fa4e983fe20e3
**Content ID:** sha256:cf6cbb528bd3693fcefd7ed9b32967abde49e992a9b95c9908bfac64d9db0b34

## Context

The post-marathon manifest (qa-bench/manifests/POSTM-MANIFEST.md — external
research-tooling output, never checked into this repository, PM-3,
synthesized from HDP 2604.04522's descendant-visible-approval shape) names a
gap Y-1/Y-2 (ADR-065/066) left open: an audit-tier scope widening judged
legitimate re-flags on every descendant node. `hasBlockedScopePrecedent`'s
fold records dampen the noise from a REPEATED observation, but the judgment
that a widening was legitimate is never itself carried forward -- nothing
lets a descendant's enforcement decision consult "was this already approved
higher up the lineage", and nothing makes that judgment's provenance
verifiable OFFLINE, independent of trusting whoever currently operates the
ledger. `EvidenceLedger` already has the exact shape to extend: Y-1/Y-2 added
`ScopeObservationRecord`, an additive `AuditRecord` union member with its own
id prefix, validation, and `verifyIntegrity`/`parseTraceId` dispatch, and
`manager.ts`'s `lineageAncestorIds` walk plus `hasBlockedScopePrecedent`/
`deriveScopeLineagePaths` are the exact lineage-query primitives a sibling
"has this already been approved" query needs. What Y-1/Y-2 do not have is
any notion of an authenticated DECISION, only observations of what was
seen -- a decision needs a stronger evidentiary bar than an observation: it
must be attributable to a specific act, at a specific point in the ledger's
own history, resistant to being forged after the fact by anyone who merely
has ledger write access.

## Decision

One additive record kind, `ScopeDecisionRecord` (`packages/arbor-audit/src`,
id prefix `scopedec_`), plus three additive `CampaignManager` methods
(`packages/arbor-mcp/src/manager.ts`) and one additive `sweepLedgerAudit`
check. No existing record kind, validator, or CLI action changes shape.

**Signed hops.** `ScopeDecision` carries `{paths (≤32 entries, ≤4096
bytes each), decision: "approved_widening" | "revoked", decided_by,
parent_decision_id: string | null, public_key: base64 SPKI DER, signature:
base64 Ed25519, idempotency_key}`. The signature covers a canonical JSON
payload -- `scopeDecisionSigningPayload({campaign_id, node_id, paths
(sorted), decision, parent_decision_id, previous_record_content_hash})` --
signed with `node:crypto`'s `sign(null, ..., privateKey)` (the `null`
algorithm Ed25519 requires) and verified with `verify(null, ...)`.
`previous_record_content_hash` is NOT a separate persisted field: it is
exactly the new record's own `previous_hash` (the ledger's tip for the
campaign at signing time), so the signature binds the hop into the existing
hash chain -- a tamperer must alter the hash chain AND forge a fresh
signature, not merely one or the other.

**Key management is deliberately campaign-local and ephemeral this
tranche.** `CampaignManager` holds a `Map<campaignId, {privateKey,
publicKeyBase64, lastDecisionId}>` populated lazily on first use; the
private key lives IN MEMORY ONLY and is never persisted, never serialized
into any campaign or ledger JSON. `EvidenceLedger.recordScopeDecision`
validates, in order: shape/bounds; that the caller's
`previous_record_content_hash` matches the campaign's ACTUAL current tip
(refusing a signature signed against a stale tip -- the race guard);
`parent_decision_id` resolves to a prior `scope_decision` in the same
campaign, or is null (a generation's genesis hop); a non-null parent's
`public_key` matches this hop's -- the GENERATION-membership check, since a
hop belongs to whichever generation its `parent_decision_id` chain
ultimately roots at, not to any single campaign-wide key; and finally the
Ed25519 signature itself. A PROCESS RESTART drops the in-memory map, so the
very next scope decision for that campaign starts a NEW generation: a fresh
keypair, journaled on a `parent_decision_id: null` genesis hop, coexisting
in the same campaign's ledger alongside whatever generation(s) came before
it. This is an explicit, documented trade, not an oversight: the ledger
never silently continues a chain with a key it does not hold, and never
refuses to make progress just because an earlier generation's key is gone --
it starts a new one and says so structurally (a new genesis hop). The direct
consequence: a `scope_decision` minted before a restart can no longer be
REVOKED after that restart (the process holds no key for its generation);
`CampaignManager.revokeScopeWidening` surfaces this as an ordinary
`AuditIntegrityError` from `recordScopeDecision`'s generation-mismatch check,
not a special case.

**Manager API.** `approveScopeWidening(campaignId, nodeId, paths,
decidedBy)` journals a signed `approved_widening` hop, chained onto this
process's own last-minted hop for the campaign (or null, starting a fresh
generation). `revokeScopeWidening(campaignId, decisionId, decidedBy)`
journals a signed `revoked` hop whose `parent_decision_id` is the decision
being revoked -- only possible while the process still holds that decision's
generation's key. `hasApprovedWideningPrecedent(campaignId, nodeId, paths)`
is a pure query: true iff `nodeId`'s lineage (itself plus the same
strict-ancestor walk `hasBlockedScopePrecedent` uses) carries a signed,
UNREVOKED `approved_widening` whose `paths` cover ALL of the given `paths`.
It does not itself suppress anything -- the enforcement-mode decision point
(`cli.ts`, integrator glue, outside this workstream) is the intended caller.

**Evidence-vs-enforcement split.** `approveScopeWidening` does NOT touch
`recordScopeObservation`'s journaling: an approved widening and the raw
scope observations it approves remain deliberately decoupled evidence.
`journalResult`'s existing `params.scope_observation` wiring is untouched by
this change -- a node whose write-scope mismatch was already approved
upstream still journals its own observation exactly as before. Only a FUTURE
enforcement decision point consults `hasApprovedWideningPrecedent` to decide
whether to re-flag; nothing in this record silences the evidence trail
itself. This mirrors the same split ADR-068 draws between advisory evidence
(durable, non-authoritative) and a verdict.

**Offline re-verification.** `ledger-audit-sweep.ts` gains check (f),
`forged_scope_decision`: re-verifies every `scope_decision`'s Ed25519
signature and parent-generation linkage purely from the already-loaded
records, using the exact same `verifyScopeDecisionSignature` primitive
`EvidenceLedger.verifyIntegrity`'s live dispatch calls -- the two can never
drift because they share one function. A hand-forged record (bad signature
bytes, or a hop claiming a `public_key` its parent did not journal) fires a
`"finding"`; a legitimate chain stays clean.

## Consequences

Signing proves INTRA-CAMPAIGN hop integrity -- a tamperer must alter the
hash chain AND forge a signature to rewrite a scope decision's history --
NOT operator identity. There is no PKI this tranche: `decided_by` is an
unauthenticated free-text field, and `public_key` is generated by the
process itself with no external attestation of who controls the
corresponding private key. A campaign-local key proves "the same process
that minted hop N also minted hop N+1 in this generation," nothing about who
that process was running as. A future cycle wanting real operator identity
would need to bind `decided_by` to an authenticated actor (e.g. the existing
`LocalSessionAuthority`/`RemoteRuntimeIngress` identity machinery) rather
than trusting a caller-supplied string -- explicitly out of this ADR's scope.
The evidence-vs-enforcement split means `hasApprovedWideningPrecedent`
existing does NOTHING to campaign behavior today: no caller in this
workstream's file scope consults it from an enforcement path, so every
approved widening still re-flags in every descendant until `cli.ts` is wired
to call it (the manifest's own named integrator follow-up, `SELF`'s "cli
enforcement decision consults hasApprovedWideningPrecedent"). The
restart-loses-the-key trade means a long-running or crash-recovered campaign
can accumulate multiple key generations in its own ledger, each internally
consistent but never cross-verifiable against each other's keys -- an
operator inspecting `arbor ledger audit`'s output sees every generation
verify cleanly on its own terms, with no record TYING generations together
beyond their shared campaign id and their position in the overall hash
chain (which check (f) does re-verify, since `previous_hash` chaining is
universal across all record kinds, not generation-scoped).

## Obligations

### O1 — A scope decision's signature is genuine, bound to the ledger's tip at signing time, and its generation lineage is enforced

<!-- proof: symbol=EvidenceLedger file=packages/arbor-audit/src/audit.ts roundtrip=packages/arbor-audit/tests/scope-decision.test.ts -->

`EvidenceLedger.recordScopeDecision` refuses a signature that does not
verify against `scopeDecisionSigningPayload`'s canonical payload built from
the record's own fields, refuses a `previous_record_content_hash` that does
not match the campaign's actual current tip, refuses a `parent_decision_id`
that does not resolve to a prior `scope_decision` in the same campaign, and
refuses a non-genesis hop whose `public_key` does not match its parent's --
each with a distinct, loud `AuditIntegrityError`. Idempotent on
`idempotency_key`, mints ids matching `scopedec_<base36>` recognized by
`parseTraceId` after a `fromJSONL` reload, and a hand-forged record fails
`EvidenceLedger.verifyIntegrity`.

### O2 — The manager signs with a campaign-local, in-memory-only key, and a restart starts a fresh generation rather than reusing a lost key

<!-- proof: symbol=CampaignManager file=packages/arbor-mcp/src/manager.ts roundtrip=packages/arbor-mcp/tests/manager-scope-decision.test.ts -->

`CampaignManager.approveScopeWidening`/`revokeScopeWidening` sign through a
`Map`-held Ed25519 keypair generated lazily per campaign; no persisted
campaign or ledger file on disk ever contains private key material
(`manager-scope-decision.test.ts` scans every file a persistence-backed run
wrote). A fresh `CampaignManager` instance against the same persistence
directory (simulating a restart) mints its next scope decision as a new
generation's genesis hop with a different public key, and cannot revoke a
decision from a generation whose key it does not hold.

### O3 — `hasApprovedWideningPrecedent` is a pure, lineage-scoped, revocation-aware query that never suppresses evidence journaling

<!-- proof: symbol=CampaignManager file=packages/arbor-mcp/src/manager.ts roundtrip=packages/arbor-mcp/tests/manager-scope-decision.test.ts -->

True iff the queried node's lineage (itself plus `lineageAncestorIds`'s
strict-ancestor walk) carries a signed, unrevoked `approved_widening` whose
`paths` cover every requested path; false when coverage is partial, when the
only matching decision has since been revoked, or for a node outside the
lineage. `recordScopeObservation`/`journalResult`'s `scope_observation`
wiring is untouched: a node covered by an approved widening still journals
its own raw observation.

### O4 — `arbor ledger audit`'s offline sweep re-verifies every scope decision's signature and parent-generation chain

<!-- proof: symbol=sweepLedgerAudit file=packages/arbor-audit/src/ledger-audit-sweep.ts roundtrip=packages/arbor-audit/tests/ledger-audit-sweep.test.ts -->

Check (f) (`forged_scope_decision`) calls the same
`verifyScopeDecisionSignature` primitive `EvidenceLedger.verifyIntegrity`
uses, plus a parent/generation linkage check, over already-loaded records
with no ledger object required. A hand-forged signature and a
generation-mismatched child both fire a `"finding"`; a legitimate,
correctly-signed chain stays clean.

### Acceptance note

This record remains Proposed. ADR-059 requires acceptance authority separate
from the implementation and authoring authority used in this tranche.
