# ADR-063: External Ledger-Head Attestation And A Waiver-Outcome Ledger

**Status:** Accepted
**Date:** 2026-08-15
**Authoring Revision:** b694ac8c6e8ebe2a58d8091df556906b24767709
**Content ID:** sha256:9f229aaf03adf5e6b4fa00bef06cf031d1a3625df2ad04f4a293e0d2baafaaaf

## Context

Cycle-1's governance research (CAVA, arXiv 2607.13716; the actuarial-runtime
framing, arXiv 2605.26508) named two field-observed gaps in revoy2's audit
ledger. First: the hash-chained ledger and its `tip-sentinel.ts` completeness
anchor both live inside the same persistence tree they protect — an attacker
or bug with write access to that tree can rewrite both together, and nothing
external to the store would know. Second: ADR-062's `direct`-tier
(review-waived) results are recorded (`TreeNode.review_waived`) but nothing
tracks what happens to them afterward — whether a waived result is ever
adopted, or whether it later proves to have been the wrong call. There is no
feedback loop from outcomes back to the waiver decision.

A companion research item (AgentLAB, arXiv 2602.16901) named a third,
narrower gap directly relevant to the audit ledger's own consumers: KB
`failure_mode` entries carry agent-authored free text
(`action_description`/`critic_root_cause`) that `@arbor/kb`'s `inject()`
interpolates verbatim into the next specialist's prompt, with no bound or
escaping — a poisoned entry can forge a fake end-of-context boundary or fake
prompt lines.

## Decision

**External ledger-head attestation (`packages/arbor-audit/src/attestation.ts`).**
On every campaign settle (`CampaignManager.manualHalt`/`completeAutoHalt`,
after the durable `campaign_halt` gate checkpoint), the manager appends one
row — `{campaign_id, ledger_head_hash, entry_count, at}` — to a
new, append-only, per-store (not per-campaign) file:
`<persistence_dir>/attestation/heads.jsonl`. This is a THIRD file, deliberately
outside both `audit/` (the ledger) and `audit-tips/` (the existing tip
sentinel), for the same reason those two are already separate: raising the
cost of an undetected rewrite from "edit one file" to "edit three,
independently".

`arbor ledger verify` cross-checks the newest attestation row for a campaign
against the ledger's ACTUAL record at that attested index (not merely its
current tip, so a legitimately-grown ledger since its last attestation still
verifies). A truncated or rewritten ledger reports a distinct
`attestation_status: "attestation_mismatch"` and a VIOLATION exit code, even
when the pre-existing tip sentinel independently also catches it — the two
mechanisms are intentionally non-overlapping evidence, not redundant.

This does not make the ledger tamper-proof: an attacker with write access to
the whole persistence tree can still forge all three files. It raises cost
and creates the seam a future EXTERNAL anchor (a signed remote, a commit)
would attach to — consistent with `tip-sentinel.ts`'s own acknowledged
ceiling (ADR-025: report, not prevent).

**Waiver-outcome ledger (E-8, `WaiverOutcomeRecord`/`WaiverOutcomeAmendmentRecord`
in `packages/arbor-audit/src/audit.ts`).** `CampaignManager.recordResult`
writes a durable `waiver_outcome` record — `{campaign_id, node_id,
task_category, waived_by, waived_reason, waived_at}` — whenever
`params.review_waived` is present, independent of the node's own immediate
verified/claimed/failed outcome: the arbiter's decision to waive review is
itself the auditable event. `adopted`/`later_failed` are NOT fields on that
record — an append-only record cannot honestly claim a future outcome at
creation time — they are folded from separately-appended
`WaiverOutcomeAmendmentRecord`s (the same append-then-fold shape ADR-019
already uses for `RequestUserInputRecord`/`UserInputAnswerRecord`).
`adopted` is wired automatically this cycle: a successful `arbor adopt
--apply` appends an `adopted: true` amendment for that node's waiver record,
if one exists. `later_failed` is deliberately NOT wired automatically —
`CampaignManager.recordWaiverOutcomeFollowUp` is a documented, durably
recorded API for a human or a future cycle's feedback loop to call
explicitly. Policy auto-adjustment from these outcomes is out of scope this
cycle; this decision only builds the evidence base.

Counts (`N adopted, M unadjudicated`) are surfaced on `arbor report`'s human
summary and on `buildGovernanceSnapshot`'s optional ledger-derived
`waiver_outcome_totals`, folded across every campaign the supplied in-memory
ledger holds — mirroring the existing optional-`ledger` purity boundary
`governance_events_witnessed`/`graph` already use.

**KB failure-mode sanitization (E-7a, `CampaignManager.kbInject`).**
`@arbor/kb` is out of this cycle's file scope, so the fix lives at the
manager/KB boundary instead: every specialist-visible memory-fact entry's
free-text fields (`value`, `failure_mode`, `root_cause`, `fix_template`) are
sanitized — control characters and embedded newlines collapsed to spaces,
the literal KB block delimiter forged/neutralized, length-bounded — BEFORE
being fed into the scoped `KnowledgeBase` `kbInject` builds and hands to
`inject()`, not after `inject()` has already assembled the prompt.

**Evidence-gate contract hardening (E-7b/E-7c, `CampaignManager.recordResult`).**
Two additive, optional fields close the two remaining AgentLAB-taxonomy gaps
this cycle's file scope can reach:

- `task_echo?: string` — when a caller supplies it, it must equal the
  node's own `Action.description` exactly, or `recordResult` fails the node
  with a `task-echo mismatch` root cause instead of accepting evidence that
  does not correspond to what the node actually asked for. No existing
  caller supplies it yet (no transport this cycle carries a task-identity
  echo distinct from the node's own action) — this is a manager-side
  contract validated by direct tests, not yet end-to-end wired from a real
  critic transport.
- `verification_source?: { campaign_id, node_id }` — when a caller
  supplies it, it must equal `{campaignId, nodeId}` (this exact call's
  target) or `recordResult` rejects the result as an evidence replay: a
  verification captured for a different node or campaign, attached here
  instead. **That end-to-end wiring landed 2026-08-18.** The identity now
  flows from `claude-code-campaign.ts`'s deferred-verification mapping through
  `loop.ts`'s `recordResult` call as `verification_source`, so the anti-replay
  check at `manager.ts:648-679` — already implemented, already rejecting
  mismatches — finally has something to check. Until then this paragraph read:
  the verification port return type "does not yet carry this identity through
  to `recordResult`", with `claude-code-campaign.ts` stripping it. Named as
  follow-up rather than left undiscoverable, and then closed.

## Consequences

`arbor ledger verify` on an intact-but-never-attested ledger now reports
`PARTIAL` rather than `SUCCESS` — a real, intentional behavior change: every
pre-existing test asserting `SUCCESS` on a bare intact ledger was updated to
either attest first or explicitly assert the new `PARTIAL` outcome. Every
campaign settle now performs one additional durable, fsynced disk write.

The waiver-outcome ledger adds one more append-only record kind (plus its
amendment kind) to `EvidenceLedger`'s closed `AuditRecord` union, extending
`parseTraceId`'s id-prefix alternation (`waiver_`/`waiveramend_`) — enforced
by the existing `id-prefix-coverage.test.ts` mechanical scan, so a future
kind cannot reintroduce that class of defect unnoticed.

`task_echo`/`verification_source` are honest, additive contract points, not
completed end-to-end features: a critic transport or the machine-verification
port must still be updated to actually populate them before either check
protects a real production path. Recorded here so the gap is a discoverable,
citable decision rather than a silent omission.

## Obligations

### O1 — A campaign settle always durably attests its ledger head when persisted

<!-- proof: symbol=CampaignManager file=packages/arbor-mcp/src/manager.ts roundtrip=packages/arbor-mcp/tests/manager.test.ts -->

`manualHalt` and `completeAutoHalt` both call `attestLedgerHead` after their
durable `campaign_halt` gate checkpoint and campaign persistence; it no-ops
only when there is no `persistence_dir` (nothing on disk to attest to).

### O2 — `arbor ledger verify` detects a truncated or rewritten ledger even when the attestation is the only file that still tells the truth

<!-- proof: symbol=classifyLedgerAttestation file=packages/arbor-audit/src/attestation.ts roundtrip=packages/arbor-audit/tests/attestation.test.ts -->

Truncating or fully rewriting a ledger after it was attested changes the
record at the attested index's content hash (or drops it below the attested
count); `classifyLedgerAttestation` reports `attestation_mismatch` in both
cases, and `ledgerCommand`'s `verify` action surfaces it as a VIOLATION exit
code independent of the pre-existing tip-sentinel/hash-chain checks.

### O3 — A review-waived result always leaves a durable waiver-outcome record, independent of its own success or failure

<!-- proof: symbol=CampaignManager file=packages/arbor-mcp/src/manager.ts roundtrip=packages/arbor-mcp/tests/manager.test.ts -->

`journalResult` records a `waiver_outcome` whenever `params.review_waived`
is present, in the same staged/fsynced write as the result's trace and
memory-fact evidence.

### O4 — Adoption is observed automatically; a later-failed determination is never fabricated

<!-- proof: symbol=recordWaiverAdoptionIfWaived file=packages/arbor-mcp/src/cli.ts roundtrip=packages/arbor-mcp/tests/cli.test.ts -->

A successful `arbor adopt --apply` appends an `adopted: true` amendment for
that node's waiver record when one exists; `later_failed` is never set by
any automated path this cycle, only by the documented
`CampaignManager.recordWaiverOutcomeFollowUp` API.

### O5 — A poisoned KB failure-mode entry cannot forge a fake context boundary or multi-line breakout in specialist context

<!-- proof: symbol=sanitizeMemoryEntryText file=packages/arbor-mcp/src/manager.ts roundtrip=packages/arbor-mcp/tests/manager.test.ts -->

Every specialist-visible memory-fact field is sanitized before being fed
into `kbInject`'s scoped `KnowledgeBase`: embedded newlines/control
characters are collapsed, the literal KB block boundary text is neutralized,
and content is length-bounded.

### O6 — `recordResult` rejects a task-echo mismatch or an evidence replay before accepting the result

<!-- proof: symbol=CampaignManager file=packages/arbor-mcp/src/manager.ts roundtrip=packages/arbor-mcp/tests/manager.test.ts -->

When a caller supplies `task_echo` or `verification_source`, a mismatch
against the node's own action description or this call's own
campaign/node target fails the node with a distinct, greppable root cause
rather than silently accepting the evidence.

### Acceptance note

This record remains Proposed. ADR-059 requires acceptance authority
separate from the implementation and authoring authority used in this
tranche.
