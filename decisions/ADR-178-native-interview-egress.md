# ADR-178: The Host's Native Question Tool Is The Interview's Sole Egress

**Status:** Accepted
**Date:** 2026-10-06
**Authoring Revision:** 0340135296b271230647f545eb6723873f64a822
**Content ID:** sha256:69f2d85d595848563472b3e64d993b15dcda9fbd2a081aa963ad4a6e3ba952bb

## Context

The operator decision interview reached the operator through one place: the `revoy2-interview`
Claude Code skill. The skill read `bun scripts/decision-queue.mjs --json`, composed each question
in prose inside its own transcript, asked it, and then called the recorder (ADR-158). Three
consequences followed.

- **The questions existed only in one host.** ADR-159 gave arbor's native `userinput.ask` real
  options, but the questions themselves were authored by the skill, so a Canopy run had nothing to
  ask. The decision queue derived *what* was owed; nothing derived *the question*.
- **Nothing bound an answer to the question it answered.** A ledger record carried an `outcome`
  string. Which option set was on offer, what text the operator saw, and which tool carried it were
  not recorded anywhere a gate could read.
- **The witness was the skill.** The discipline "ask, do not decide" lived in skill prose; the
  receipt (ADR-158) proves the record came from the recorder, not that a question was asked.

On 2026-10-06 the operator directed: *translate any revoy2-interview based questions into the
native interview, deprecate revoy2-interview and subsume it into the native harness; for working
on the native harness inside Claude Code, the agent's own native interview tooling should be the
sole Q&A egress.*

## Decision

**The host's native question tool is the interview's sole egress, fed by a derived question pack
and recorded by one writer that binds the operator's verbatim answer to the pack.**

1. **The queue emits a host-neutral question pack.** `deriveQuestionPack`
   (`scripts/interview-pack.mjs`, also `bun scripts/decision-queue.mjs --question-pack`) turns the
   derived queue into one question per owed item, ordered by consequence (hazards, lapsed,
   due-soon, over-age, operator calls, Proposed records). Each question carries at most four
   options drawn from the closed per-kind set in `scripts/lib/discharge-catalog.mjs`, with the
   recommended option first, the consequence of each, and what record each produces (ledger
   coverage, any discharge obligation, whether a date is required). A question the recorder could
   not record (a `hazard`, which the catalog does not declare) is emitted and marked
   `recordable: false`, never hidden.

2. **The pack is digested.** `pack_digest` is sha256 over the canonical pack with the digest
   removed; `verifyQuestionPack` refuses a pack whose content no longer matches it.

3. **Egress is a declared native tool.** Claude Code's `AskUserQuestion`
   (`claude-code.AskUserQuestion`), arbor's native human-input port (`arbor.native.human_input`) or
   arbor's `userinput.ask` (`arbor.native.userinput.ask`). The set is closed in
   `EGRESS_CHANNELS`; a new host is a reviewed edit.

4. **One writer records verbatim answers.** `bun scripts/interview-record.mjs --pack <p>
   --answers <a>` validates with `buildInterviewPayload` and writes through `recordInterviewAnswer`
   (the sole ledger writer, which mints the ADR-158 receipt and queues ADR-137 discharges). It
   refuses, before writing anything: a pack edited after derivation; answers bound to a different
   pack digest; an undeclared egress or one without session id and timestamp; an answer with no
   verbatim text; an option the question did not offer (a free-text "Other" leaves the item open);
   a question not in the pack, answered twice, or marked unrecordable; and a dated option without a
   date after the interview.

5. **The witness is the verbatim answer bound to the pack digest, not the skill.** Each recorded
   outcome is the operator's verbatim answer. The binding (egress channel, session id, asked-at
   time, pack digest, question ids) rides in the record's `note` as a single `witness:v1` line,
   inside the content the ADR-158 receipt digests, so editing either orphans the record.

6. **The native harness drives the same pack.** `askInterviewPack` (`@arbor/harness`) asks each
   recordable question through a `NativeHumanInputPort`, keeps each reply verbatim, and returns the
   answers document the writer consumes. It stops at a handoff, decline or unavailability, and
   leaves a question open when the reply names no offered option; it never substitutes a default.

7. **`revoy2-interview` is deprecated, not deleted.** Its SKILL.md becomes a pointer to this flow
   so the many `/revoy2-interview` references (hooks, gate output, records) still resolve.

**Relationship to prior records.** This *amends* ADR-158 (the receipt still attests the record;
this adds what the record must bind) and ADR-159 (whose Consequences said the interview "reached
the operator only through the Claude Code skill"). It does not supersede either: receipts and
real native options remain load-bearing. It also amends ADR-081's statement that "the
human-in-the-loop guarantee lives in the skill": it now lives in the host's native question tool. No `adr:supersede` is required; if the operator prefers a formal retirement,
ADR-159 is the only candidate, and only its Consequences paragraph is displaced.

## Consequences

Any host with a native multiple-choice tool can conduct the interview from the same derived data,
and an answer now names the exact question set it answered and the tool that carried it. Agents in
Claude Code ask with `AskUserQuestion` rather than prose, which is what the operator directed.

What it does **not** prove, stated with ADR-158's ceiling: that a human typed the verbatim text.
An agent that fabricates an answers file can run the writer; the digest makes the fabrication
specific (a real pack, a real option, a declared egress) and the receipt makes it visible to a
gate, but neither is a signature.

Known gaps, stated rather than hidden:

- The `witness:v1` binding is carried in `note` because the ledger writer
  (`scripts/lib/discharge-store.mjs`) accepts no structured witness field. A first-class `witness`
  field is the cleaner form and a small additive follow-up.
- No gate yet *requires* a post-adoption record to carry a witness line;
  `gate:interview-attestation` checks receipts only. Requiring it is the natural next tightening,
  with a baseline date like ADR-158's.
- `hazard` items cannot be recorded until the discharge catalog declares a `hazard` kind.
- `askInterviewPack` is a library seam with tests and no production call site; offering the pack
  inside a running Canopy session (composition root and TUI affordance) is follow-up work.
- `bun run interview:record` still points at the legacy payload recorder
  (`scripts/record-interview.mjs`); repointing it is a `package.json` edit outside this change.

## Alternatives / Roads not taken

**Keep the skill as the egress and add a digest.** Rejected: it keeps the questions inside one
host's transcript, and the operator directed the opposite.

**Have the skill or harness write the ledger directly.** Rejected: `recordInterviewAnswer` is the
sole writer, and a second writer would fork receipt minting and discharge queuing.

**Bind answers to the queue report rather than to a question pack.** Rejected: the report says what
is owed, not what was asked. Two hosts rendering the same report differently would record
indistinguishable answers to different questions.

**Accept free-text "Other" answers as covering an item.** Rejected: the discharge catalog is closed
per kind (ADR-137 §4); an answer that maps to no declared option has no defined consequence.

## Obligations

### O1 — The queue derives a bounded, ordered, recommended-first question pack

`deriveQuestionPack` emits every owed item as a question with at most four catalog options, the
recommended option first, and marks an unrecordable kind rather than hiding it.

<!-- proof: symbol=deriveQuestionPack file=scripts/interview-pack.mjs roundtrip=scripts/tests/interview-native.test.mjs -->

### O2 — A pack edited after derivation is refused

`verifyQuestionPack` refuses a pack whose content no longer matches its own digest.

<!-- proof: symbol=verifyQuestionPack file=scripts/interview-pack.mjs roundtrip=scripts/tests/interview-native.test.mjs -->

### O3 — Only verbatim answers bound to the asked pack, through a declared egress, are recorded

`buildInterviewPayload` refuses a missing verbatim answer, a digest mismatch, an undeclared egress,
an unoffered option and an undated deferral before anything is written, and what it accepts is
recorded through the sole writer and read by the decision queue as coverage.

<!-- proof: symbol=buildInterviewPayload file=scripts/interview-record.mjs roundtrip=scripts/tests/interview-native.test.mjs -->

### O4 — The native harness asks the same pack and invents nothing

`askInterviewPack` returns verbatim replies in the writer's answers shape, and leaves questions
open on a handoff, a decline, or a reply naming no offered option.

<!-- proof: symbol=askInterviewPack file=packages/arbor-harness/src/interview-pack.ts roundtrip=packages/arbor-harness/tests/interview-pack.test.ts -->
