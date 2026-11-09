# ADR-158: An Interview Record Must Come From The Recorder

**Status:** Accepted
**Date:** 2026-09-03
**Authoring Revision:** 8c3ecf5dd3b8bb98e6fe86cd0e20c6393fe353b9
**Content ID:** sha256:5b665a2eda136209542e02b5c9aa8efc2341200551ea8d22e4152f021a2db90b

## Context

`decisions/interviews.jsonl` is the artifact that silences `gate:decision-queue`, and
`acceptDecision` refuses to promote any ADR it does not cover: *"acceptance is a witnessed
human decision."* It is the load-bearing evidence that an operator was actually asked.

It was a plain JSONL file that any agent could append a line to, and the interview skill
said so out loud rather than hiding it:

> The gate reads `decisions/interviews.jsonl` and passes when a record covers each owed
> item. **An agent can write that file.** That is not a loophole to route around — it is
> the reason this skill exists, and the reason the gate's own output says so. A ledger
> entry written without a real answer converts a working mechanism into a rubber stamp,
> and does it silently.

Prose was the only thing between a real answer and a fabricated one. That is a thin
defence for the repository's most authoritative artifact, and it gets thinner exactly when
it matters most: an unattended run, a blocked push, an absent operator, and a gate that
clears the moment a line appears.

The pressure is worth naming precisely, because it is what any "make the interview
mandatory" design must survive. Make ending a session *require* a covering record, put the
operator out of reach, and the agent has two options: wedge, or write the line. The
incentive points at the one artifact with no verification. The predictable result is not
more interviews. It is fabricated ones, and a fabricated interview is worse than a red
gate because the red gate is still true.

## Decision

**A record that cannot be traced to the recorder does not count as an interview.**

1. **`recordInterviewAnswer` mints a receipt for every record it writes**, into
   `<git-common-dir>/arbor/interviews/receipts.jsonl` — beside the evidence-transaction
   receipts and the stop-guard release journal, outside the working tree, so ordinary
   repository editing cannot produce one as a side effect. The receipt carries a digest of
   the record's own content.

2. **The receipt is minted BEFORE the ledger line is appended.** A crash between the two
   then leaves an unmatched receipt, which is harmless and visible, rather than an
   unattested ledger record, which is indistinguishable from a hand-written one. The
   failure mode is chosen deliberately.

3. **The digest is over canonical content, so editing a recorded answer orphans it.** The
   receipt attests to specific content, not to the fact that some record once existed.
   Flipping an outcome from accept to reject after the fact breaks the match.

4. **`gate:interview-attestation` reports every post-baseline record with no matching
   receipt.** Records held on or before `scripts/interview/baseline.json`'s date are
   historical: they predate the mechanism and nobody can retroactively attest them. That
   date may move earlier as history is pruned, never later, since moving it later would
   grandfather a fabrication.

5. **An unattested record does not cover anything.** `coverageIndex` takes an injected
   `isAttested` predicate, so a hand-written line no longer silences the decision queue.
   The predicate is injected rather than computed inside, both to keep the function pure
   and so a caller with no receipt store keeps the prior behaviour.

6. **A clone with no receipt store is treated as attested, not as forged.** A fresh
   checkout has never recorded an interview locally; that is its normal state, not
   evidence against its history. The gate reports the situation instead of the queue
   silently demanding re-interviews of the whole backlog.

## Consequences

The load-bearing artifact acquires the first verification it has ever had, and the honest
statement of what it proves changes from "an agent wrote a line" to "this record came
through the recorder on this machine."

What it does **not** prove, and must never be described as proving: that a human answered.
The receipt store is a file on the same disk. An agent that knows this mechanism exists
can write both halves. What changed is that forgery is now a deliberate, separate act
against a git-internal store instead of one invisible line in a file the agent edits all
day, and — the part that actually matters — a mismatch is now **visible to a gate** rather
than invisible to everyone. Detection, not prevention.

Cross-machine proof is out of scope and deliberately so. A record written on one clone has
no receipt on another, which is why the gate is `local_history_only` and absent from CI,
the same boundary `gate:hook-liveness` and `gate:stop-guard-releases` carry. Proving to a
third party that a human answered needs a signature over a key the agent does not hold, or
a CI-side attestation of the kind `enforcement-attestation.mjs` already builds against the
GitHub API. That is a strictly larger mechanism and this record does not pretend to it.

One implementation note worth keeping, because it nearly shipped as a silent hole: the
first digest used `JSON.stringify`'s array replacer to sort keys. That replacer filters
*nested* keys by the same top-level list, so `outcomes` serialized as `{}` and tampering
with a recorded answer left the digest unchanged. The tamper test caught it. Canonical
serialization now recurses, and that test stays as the regression pin.

## Alternatives / Roads not taken

**Block session end until every owed decision is answered.** Rejected, and this is the
central rejection. Nothing can force an answer from an absent operator, so the only
reachable outcomes are a wedged session or a fabricated record. It is also unenforceable
in the host harness: `SessionEnd` cannot block, `Stop` blocking is capped, and revoy2's own
stop-guard releases after three identical failures. A mandate that cannot hold and whose
failure mode is fabrication is worse than no mandate.

**Make the ledger writable by exactly one tool via a path allowlist.** Deferred, not
rejected. `NativeHighRiskToolScope.write_paths` already enforces exact-path write authority
inside the native harness, before approval or credential delivery, and binding
`decisions/interviews.jsonl` into it is the strictly stronger form of this decision. It
does not help under the Claude Code connector, which has no general per-path write
authority, so it closes one executor and not the others. Receipts work across all of them.

**Sign records with a per-session secret.** Rejected for now as more mechanism than the
threat justifies. The secret would live on the same disk as the store it protects, so it
raises the same bar the receipt already raises, while adding key handling and a new way for
honest records to become permanently unverifiable.

**Reject unattested historical records.** Rejected: forty existing records predate the
mechanism and no one can retroactively attest them. A gate that fails forever on a correct
repository gets disabled, and a disabled gate checks nothing.

## Obligations

### O1 — A record that did not come from the recorder is reported, and one that did is not

`auditInterviewAttestation` grandfathers pre-baseline records, passes a post-baseline
record matching a receipt, and fails one with no receipt, one whose content was edited
after recording, and one carrying no date to place against the baseline.

<!-- proof: symbol=auditInterviewAttestation file=scripts/lib/interview-receipts.mjs roundtrip=scripts/tests/interview-attestation.test.mjs -->

### O2 — The digest covers nested content, so editing a recorded answer breaks the match

`canonicalRecordDigest` is stable under key reordering, ignores the receipt id the record
cannot know before minting, and changes when an outcome is flipped.

<!-- proof: symbol=canonicalRecordDigest file=scripts/lib/interview-receipts.mjs roundtrip=scripts/tests/interview-attestation.test.mjs -->

### O3 — An unattested record does not silence the decision queue

`coverageIndex` skips records failing the injected predicate, and preserves prior
behaviour when no predicate is supplied.

<!-- proof: symbol=coverageIndex file=scripts/decision-queue.mjs roundtrip=scripts/tests/interview-attestation.test.mjs -->
