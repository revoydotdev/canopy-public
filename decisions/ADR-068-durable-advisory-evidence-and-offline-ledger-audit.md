# ADR-068: Durable Advisory Evidence and Offline Ledger Audit

**Status:** Accepted
**Date:** 2026-08-15
**Authoring Revision:** d3842aacc3a0e8a1ab967d69b4e2770291d21a57
**Content ID:** sha256:95337cdbe77753b76d32ce263c7f624e9816508aec713a0088043f5a382d8c92

## Context

Cycle-4's research manifest (qa-bench/manifests/CYCLE4-MANIFEST.md — external
research-tooling output, never checked into this repository, synthesized
from cycle4-evidence-durability.md, PROV-AGENT 2508.02866 and
CAVA 2607.13716) identified two gaps this final mandated cycle closes.
First: the sibling-tree scan and the test amplifier (`test-amplifier.ts`)
both surface real findings to the critic prompt on a single expansion, and
those findings evaporate the moment that prompt is answered -- nothing
durable records that a sibling scan or amplifier ever ran or what it found,
so no later human or auditor read can recover it, and no cross-record
analysis can ever reference it. Second: nothing in this package performs
offline cross-record analysis over an already-persisted ledger at all.
`verifyIntegrity`, the tip sentinel, and attestation all verify that a
ledger has not been TAMPERED WITH; none of them ask whether its own content
is internally coherent -- a race whose loser vanished without an honest
reason, a scope escalation quietly downgraded, a "verified" result whose
critic phase was never timed, or a waiver nobody ever revisited are all
cross-record facts a hash-chained, perfectly intact ledger can still
exhibit. `EvidenceLedger` already has the exact shape this needs: Y-1's
prior cycle (ADR-065/066) added `ScopeObservationRecord`, an additive
`AuditRecord` union member with its own id prefix, validation, and
`verifyIntegrity`/`parseTraceId` dispatch wired through the same pattern
`TelemetryObservation.source_evidence_id` uses to witness a record against
prior evidence in the same campaign.

## Decision

Two additive pieces, both entirely within `packages/arbor-audit/src` and
`packages/arbor-mcp/src/manager.ts`/`ledger-command.ts` -- no existing
record kind, validator, or CLI action changes shape.

**Durable advisory evidence.** A new `AuditRecord` variant,
`AdvisoryEvidenceRecord` (id prefix `advisory_`), carries
`{generator: "sibling_scan"|"test_amplifier"|"mutation_probe", activity
(bounded 256 bytes), payload (byte-capped 8192, truncated -- never refused
-- past the cap, with `payload_truncated` marked honestly), source_evidence_id,
idempotency_key}`. `source_evidence_id` is validated as a witness to PRIOR
evidence in the same campaign, structurally identical to
`TelemetryIdentity.source_evidence_id`'s check in
`recordTelemetryObservation` (`EvidenceLedger.recordAdvisoryEvidence` reuses
the exact same "does this id resolve to an earlier packet in this campaign"
guard). `EvidenceLedger.getAdvisoryEvidence(campaignId)` is the read side.
`CampaignManager.recordResult` gains an optional
`advisory_evidence?: readonly {generator, activity, payload}[]` parameter;
`journalResult` journals each finding into the SAME staged
target/fsync boundary as the trace it belongs to (mirroring exactly how
`scope_observation` is journaled one block above it), witnessed by that
call's own freshly-appended (or replayed) trace id, with idempotency key
`${operationId}:advisory:${index}` -- one key per finding, so a retried
journal call never doubles any of them.

**Contract point (explicitly out of this package's ownership).** Wiring a
real sibling-scan or test-amplifier finding INTO `recordResult`'s
`advisory_evidence` parameter is loop-side work (`loop.ts`), owned by
integration, not this change. This ADR records the seam:
`params.advisory_evidence` is the one place a caller hands durable findings
to the ledger; nothing upstream of `recordResult` is touched here.

**Offline ledger audit.** A new `arbor ledger audit <campaign-id>|--all
--dir <dir> [--json]` subcommand (`ledger-command.ts`) runs
`sweepLedgerAudit` (`packages/arbor-audit/src/ledger-audit-sweep.ts`, a new
additive, pure, read-only module) over one campaign's already-loaded
records, or every campaign in the persistence dir. Five deterministic
checks: (a) a `race_outcome` that cancelled a fork/primary-win loser but
whose node has only one specialist `usage_cost` row AND no
`loser_usage_unavailable_reason` -- verified read-only against the real
bench ledgers at `qa-bench/ab3/A/.arbor`: every real race in that corpus
carries the reason field on its single row, the exact honest shape this
check is built to pass; (b) a `scope_observation` "blocked" for a path
followed by a later "audit" for the same path in the same lineage --
enforcement silently downgraded; (c) a `verified`-provenance trace with
`strength: "command_executed"` but no `phase_timing` "critic" record for its
node -- literal per the manifest, and it never fires against the real
corpus (which contains zero `command_executed`-strength traces, only
`outputs_check`), so no deviation was needed; (d) a `waiver_outcome` with no
adoption amendment older than 7 days -- reported `"info"`, since absence
alone is the expected starting state for every waiver and only age makes it
worth surfacing (7 days is a documented, arbitrary default, configurable via
`LedgerAuditSweepOptions.unadopted_waiver_days`; no record in the ledger
states an SLA); (e) an `advisory_evidence` whose `source_evidence_id` does
not resolve -- defensive, since `recordAdvisoryEvidence`/`verifyIntegrity`
already refuse this at write/chain-verification time, but a hand-edited or
externally-produced JSONL bypasses both. Output is JSON and a human summary;
exit `SUCCESS` (0) when no check (a)/(b)/(c)/(e) finding fired anywhere in
scope, `VIOLATION` (5) otherwise -- deliberately the same code `ledger
verify` already uses for "the command ran to completion and reported a real
integrity problem" (registry's own documented meaning), not the numeric `3`
a literal reading of the manifest's shorthand might suggest: `PARTIAL` (3)
is reserved by the registry for "some targets failed, others succeeded" in a
multi-target run, which is not this command's failure mode -- a `finding`
either exists somewhere in the swept scope or it does not. `(d)`'s `"info"`
severity never escalates the exit code on its own, mirroring
`exitCodeForFindings`'s existing blocker/warning split. The command is
read-only: `sweepLedgerAudit` never mutates the records it is given, and
`ledger-command.ts`'s `audit` branch only ever calls `loadLedgerResult`.

## Consequences

A sibling scan or amplifier finding now survives past the single critic
prompt that consumed it, at the cost of a bounded (8192-byte payload,
256-byte activity) per-finding ledger record and one more `AuditRecord`
union member every `verifyIntegrity`/`parseTraceId` dispatch site must (and,
per `verify-kind-coverage.test.ts`/`id-prefix-coverage.test.ts`'s own
mechanical source scans, now does) cover. `arbor ledger audit` gives an
operator a genuine offline read of ledger content coherence for the first
time, independent of and complementary to `verify`'s tamper-detection axis
-- smoke-run read-only against all 39 real campaigns in
`qa-bench/ab3/A/.arbor`, it reported zero findings and left the directory
byte-identical to before the run. The known limitation this record does not
resolve: check (c) is unexercised by any real ledger in this cycle's corpus
(no `command_executed`-strength trace exists there yet), so its real-world
firing rate is unproven outside its own fixture. **The second half of this
sentence is no longer true.** The deferred loop-side wiring for advisory
evidence (sibling scan / amplifier / mutation probe findings flowing into
`recordResult`) landed in `65ea4b7a`, eight minutes after this record was
authored, and is exercised end to end as of 2026-08-18 by a loop test running
a real `WorktreeManager` over a real git worktree. Only check (c)'s
corpus-composition limitation above remains accurate; it is integration's
explicit follow-up, not a gap in this record's own scope.

## Obligations

### O1 — Advisory evidence is durable, bounded, and witnessed, never lost to truncation or an unresolved source

<!-- proof: symbol=EvidenceLedger file=packages/arbor-audit/src/audit.ts roundtrip=packages/arbor-audit/tests/advisory-evidence.test.ts -->

`EvidenceLedger.recordAdvisoryEvidence` refuses a `source_evidence_id` that
does not resolve to prior evidence in the same campaign
(`AuditIntegrityError`, mirroring `recordTelemetryObservation`'s witness
guard), caps `payload` at `ADVISORY_EVIDENCE_MAX_PAYLOAD_BYTES` (8192) by
truncating on a UTF-8 character boundary and marking `payload_truncated:
true` rather than refusing the record, is idempotent on `idempotency_key`,
and mints ids matching `advisory_<base36>` recognized by `parseTraceId`
after a `fromJSONL` reload. `EvidenceLedger.getAdvisoryEvidence(campaignId)`
returns only that campaign's records.

### O2 — `recordResult`'s advisory findings land in the same staged, fsynced write as the trace, never a separate unsynchronized append

<!-- proof: symbol=CampaignManager file=packages/arbor-mcp/src/manager.ts roundtrip=packages/arbor-mcp/tests/manager-advisory-evidence.test.ts -->

`CampaignManager.recordResult`'s optional `params.advisory_evidence` entries
are journaled inside `journalResult`'s existing staged `target` ledger
(the same one the trace, memory fact, waiver outcome, and scope observation
already share), each witnessed by that call's own trace id and keyed
`${operationId}:advisory:${index}`; a replay of the same `result_operation_id`
never doubles a finding, and `CampaignManager.getAdvisoryEvidence(campaignId)`
is the read-side accessor.

### O3 — `arbor ledger audit` is deterministic, read-only, and its exit code distinguishes a clean sweep from a real finding

<!-- proof: symbol=ledgerCommand file=packages/arbor-mcp/src/ledger-command.ts roundtrip=packages/arbor-mcp/tests/ledger-command-audit.test.ts -->

`ledgerCommand(["audit", <campaign-id or --all>, "--dir", dir, ...])` calls
`sweepLedgerAudit` (`packages/arbor-audit/src/ledger-audit-sweep.ts`) purely
over records already loaded by `loadLedgerResult`, never writes to disk,
excludes the reserved `governance` campaign id from `--all`, and returns
`EXIT_CODES.SUCCESS` when no `"finding"`-severity result exists across the
swept scope, or `EXIT_CODES.VIOLATION` when at least one does; a `"info"`
severity result (check d) never escalates the exit code by itself.

### O4 — Every one of the five checks has both a firing fixture and a clean fixture, and the sweep does not crash against real bench ledgers

<!-- proof: symbol=sweepLedgerAudit file=packages/arbor-audit/src/ledger-audit-sweep.ts roundtrip=packages/arbor-audit/tests/ledger-audit-sweep.test.ts -->

`ledger-audit-sweep.test.ts` exercises checks (a)-(e) each with a fixture
that fires the check and a fixture that stays clean, plus one fully-clean
campaign that produces zero findings across all five at once. Read-only
against a copy of `qa-bench/ab3/A/.arbor` (39 real campaigns), the sweep
completed without throwing and reported zero findings, leaving the copied
directory byte-identical to the source.

### Acceptance note

This record remains Proposed. ADR-059 requires acceptance authority separate
from the implementation and authoring authority used in this tranche.
