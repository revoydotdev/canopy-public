# ADR-187: Interview Records Carry A Structured Witness And Stay Attested Across Clones

**Status:** Accepted
**Date:** 2026-10-07
**Authoring Revision:** f3100ff189dfe4ebb474b414e780b7338859868a
**Content ID:** sha256:5869355394d02a39380120deb1f6713f8666bacf4a9858d7aab0b837fd9b7b94

## Context

ADR-178 made the host's native question tool the interview's sole egress and listed its own gaps.
Four of them are closed here, and one defect in ADR-158 found while doing so.

- **The witness rode in prose.** The binding (egress, session, time, pack digest, question ids) was
  a `witness:v1 {...}` line in the record's free-text `note`, because the writer accepted no
  structured field. Nothing checked its shape, and nothing required it.
- **Hazards could not be recorded.** The discharge catalog declared no `hazard` kind, so the pack
  emitted hazard questions with `recordable: false` and no options.
- **Two recorders, one script name.** `bun run interview:record` still ran the legacy payload
  writer, which cannot build a witness.
- **A fresh clone lost its coverage on its first recorded interview (ADR-158 §6).** Receipts live
  per clone in the git common dir. A clone with no receipt store treated every record as attested;
  the first interview recorded there created the store, and every earlier post-baseline record
  then matched no receipt and stopped covering anything at once. Reproduced on 2026-10-06 in a
  temporary `git clone` of this repository: 63 covered queue items lost coverage in one step, 9 of
  them then blocking `gate:decision-queue`, and `gate:interview-attestation` reported 21 honest
  records as unattested.

## Decision

1. **The witness is a structured, schema-validated record field.** `recordInterviewAnswer` takes
   `witness: { schema_version: 1, egress: { channel, session_id, asked_at }, pack_digest,
   questions }`, checked by `validateWitness` (closed key set; channel in `EGRESS_CHANNELS`; ISO
   timestamp; `sha256:` digest; non-empty, distinct question ids). `buildInterviewPayload` emits it;
   the operator's note stays in `note`. The witness is part of the record, so the ADR-158 receipt
   digests it. `readRecordWitness` still reads the legacy `witness:v1` note form, so records already
   written stay readable; they are never rewritten, which would orphan them from their receipts.

2. **Records held after ADR-178's acceptance must carry it.** `WITNESS_REQUIRED_AFTER` is
   2026-10-06, exclusive: the interview accepting ADR-178 was held that day and predates the field.
   The writer refuses a later interview with no witness, and `gate:decision-queue` (pre-push)
   reports any later record without a valid one as `witness_violations`. Such a record covers
   nothing and blocks; the remedy is to re-ask natively and record with `bun run
   interview:record`, never to add a witness by hand. The cutoff may move earlier, never later.

3. **`hazard` is a catalog kind.** Its options are `re-ground the commitments` (recommended;
   discharged when no dated commitment cites the record, or the record governs), `accept the cited
   record` (discharged when the record is Accepted) and `defer with a date` (no discharge; covers
   until the date). The question is about the commitments resting on the record, not about the
   record itself, which keeps its own `proposed_record` question.

4. **One entry point.** `bun run interview:record` runs `scripts/interview-record.mjs`, and
   `bun run interview:pack` derives the pack. `scripts/record-interview.mjs` stays as a low-level
   payload writer for fixtures and replay, with no `package.json` entry; it cannot build a witness,
   so it cannot record a live post-cutoff interview.

5. **A record that arrived from another clone is attested (amends ADR-158 §6).** A post-baseline
   record is attested when it matches a local receipt or when it is present in the ledger at a
   remote-tracking ref's last fetched position (`importedRecordDigests`): the newest reflog entry
   that is not this clone's own push. A record there was written in another clone, under that
   clone's receipts and pre-push gates, and reached this one through git transport. Positions this
   clone pushed are excluded, so pushing a hand-written line does not launder it locally. The
   attestation check is therefore the same before and after a clone's first receipt. The
   all-attested fallback remains only where nothing can attest anything (no baseline, or neither a
   receipt store nor a fetched remote ledger).

**Relationship to prior records.** This amends ADR-158 §6 and its Consequences ("a record written
on one clone has no receipt on another") and ADR-178 Decision §1 and §5 and the five gaps its
Consequences list. It supersedes neither: receipts and the native egress remain load-bearing.

## Consequences

A fresh clone keeps the coverage its history has, and recording in it no longer changes what
earlier records prove. Every interview after the cutoff names the pack, questions and native tool
it answered, in a shape a gate checks. Hazards get a considered, recordable answer.

What this does **not** prove, stated with ADR-158's ceiling: that a human answered. Importing from
a remote trusts that the clone which pushed the record ran its gates; a record pushed with hooks
bypassed, or pushed and then fetched back, is imported like any other. Both are deliberate acts
that leave the line on a shared remote, not an invisible local edit. A remote-tracking ref with no
reflog (for example, a branch a fresh clone never fetched) contributes nothing, which errs strict.
`gate:interview-attestation` stays out of CI: a commit under test is not yet at a fetched position.

## Alternatives / Roads not taken

**Carry the receipt store in the repository.** Rejected: any line appended to a tracked receipt
file would attest itself, so "came through the recorder" would reduce to "two files edited
together", which is weaker than the git-internal store it would replace.

**Grandfather records predating the clone's first receipt.** Rejected: it fixes the first record
only. Records pulled from other clones after that receipt would lose coverage the same way, and a
snapshot taken at store creation would grandfather anything hand-written before it.

**Require the witness from ADR-178's date inclusively.** Rejected: the interview that accepted
ADR-178, and others held that day, predate the field and cannot gain one without being rewritten.

## Obligations

### O1 — A record fetched from another clone stays attested after this clone's first receipt

`importedRecordDigests` reads the ledger at each remote-tracking ref's last fetched position,
excluding this clone's own pushes, and `interviewAttestation` counts those records as attested
before and after the receipt store exists. A hand-written local line stays unattested.

<!-- proof: symbol=importedRecordDigests file=scripts/lib/interview-receipts.mjs roundtrip=scripts/tests/interview-attestation.test.mjs -->

### O2 — The queue counts a record as an interview only with a receipt, an import, or the baseline

`interviewAttestation` gives the same answer for a record before and after a clone's first
receipt, and falls back to all-attested only where nothing can attest anything.

<!-- proof: symbol=interviewAttestation file=scripts/decision-queue.mjs roundtrip=scripts/tests/interview-attestation.test.mjs -->

### O3 — The witness is schema-validated, and legacy note witnesses stay readable

`validateWitness` rejects undeclared fields, undeclared channels, malformed digests and empty or
duplicate question lists; `readRecordWitness` reads the structured field and the legacy note form.

<!-- proof: symbol=validateWitness file=scripts/lib/discharge-store.mjs roundtrip=scripts/tests/interview-native.test.mjs -->

### O4 — A record after ADR-178's acceptance without a valid witness is reported and covers nothing

`auditInterviewWitnesses` reports every post-cutoff or undated record lacking a valid witness;
`gate:decision-queue` blocks on them and does not let them cover.

<!-- proof: symbol=auditInterviewWitnesses file=scripts/lib/discharge-store.mjs roundtrip=scripts/tests/interview-native.test.mjs -->

### O5 — A hazard is recordable, and each answer discharges only on the condition it names

`DISCHARGE_CATALOG.hazard` declares three options whose predicates re-derive the hazard's own
condition from repository state.

<!-- proof: symbol=DISCHARGE_CATALOG file=scripts/lib/discharge-catalog.mjs roundtrip=scripts/tests/discharge-catalog.test.mjs -->
