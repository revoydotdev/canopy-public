# ADR-184: The native critic reviews the work, not the verifier's receipt

**Status:** Accepted
**Date:** 2026-10-06
**Authoring Revision:** fd77110c437db4ea710b479739ff5395b4f98bee
**Content ID:** sha256:357c9783aa15eaa6ed5a1addba8cdc55bd965553d379326f8c63e7c7aa329124

## Context

Eight provider-backed native campaigns against the pinned external cohort
(`docs/release-acceptance-1.0.0/evidence/2026-10-06-external-cohort-native.md`,
defects 2 and 4) failed for reasons the harness, not the model, introduced.

When the governed completion boundary verifies a native session,
`NativeHarnessWorker.complete` signals the verifier's message
(`machine verification passed: <cmd>`) as the terminal message. The
specialist's own final message is handed to the verifier and then dropped.
`NativeAgentExecutor.specialize` returned that terminal message as
`SpecialistResult.output`, and the campaign loop gives `output` to the critic
panel as "Specialist output". So a reviewed-tier critic saw one line: no
report, no `VALIDATION EVIDENCE`, no diff. One critic said so ("The
declaration is unsupported by any reviewable artifact"); others returned
schema-shaped placeholders (`"rationale": "placeholder"`). The native verdict
contract accepted those as real verdicts, and the panel counted them as
rejections. Runs 1 and 2 failed although their patches passed acceptance.

Separately, the worktree verifier computes a bounded, sanitized tail of a
failing command's output (`diagnostic`). The native executor dropped it when
it built `deferred_verification`, so the node's recorded failure, the retry
capsule and `arbor report` held only `command_exit_nonzero (exit 101)`. A TLS
failure inside the verification sandbox was found only by reproducing it by
hand.

No existing decision states what a native critic receives. The opencode panel
reviewer already captures and sends a bounded candidate patch; the native
path did not.

## Decision

**1. A native specialist's `output` is its own final message plus labelled
harness evidence.** `composeReviewableSpecialistOutput` builds it after the
session: the specialist's (already redacted) final message, then a
`HARNESS EVIDENCE` section the harness captured itself: the verification
result (command label, exit, strength, or the failure code and exit), a
bounded output tail of the verifier, and a bounded, redacted diff of the
worktree against its starting commit (`captureWorktreeDiff`; binary hunks
omitted; at most 240 lines and 12,000 bytes). The worker's terminal event is
unchanged: its message under `verified` provenance is still the verifier's
receipt, so model-authored text never acquires verified provenance. A
structured skill result is not changed, and a session with no verifier and
no capturable diff keeps its plain message.

**2. Harness evidence crosses the existing redaction boundaries.** The
verifier's sanitizer is exported as `sanitizeHarnessEvidenceText` (control
stripping, worktree and home de-identification, credential and e-mail
shapes) and applied to the diff, and the session's own context redactor
(broker-owned secrets included) is applied after it.

**3. Placeholder text is malformed critic output, not a review.** The native
verdict contract refuses a verdict whose rationale, root cause or any check
detail is whole-field template text (a closed vocabulary such as
`placeholder`, `TODO`, `string`; an `<...>` or `{{...}}` slot; punctuation
alone). Its validation reason starts with `malformed_critic_verdict` and
names the field, so the worker's bounded structured-output correction tells
the critic what to fix. When the corrections are spent, the review session
fails, `review()` returns a typed `error` with root cause
`malformed_critic_verdict`, and the panel adapter forwards that `error`.
The panel then treats the reviewer as having rendered no verdict, and the
loop parks the node `awaiting_review` with its candidate intact. This is
the containment the opencode panel reviewer already applies to an
unparseable verdict.

**4. The verifier's failure tail reaches the node, the retry and the
report.** `deferred_verification` carries the diagnostic, cut from the end
to 1,536 bytes so that `machine verification failed: <code> (exit N): <tail>`
fits the retry record's 2,048-byte field. The manager's existing
`verification_failure` path records it as the node's failure and failure-mode
memory; the loop's existing retry capsule makes it the next attempt's
corrective requirement; `arbor report` shows it through the node's output.

The critic's verdict provenance is unchanged (`critic_approved` is never
`verified`), no KB read path changes, and specialists still cannot read
`critic_only` entries.

## Consequences

A critic can judge the change it is approving, and a template answer can no
longer fail correct work. A malformed critic now leaves a node awaiting
review instead of failed, which is honest but means a campaign whose critic
keeps returning templates ends without a verdict; the operator sees
`malformed_critic_verdict` as the reason.

`SpecialistResult.output` for native sessions is longer, up to about 12 KB of
diff, and it is durable: it is the node's candidate, phase message and
recorded output. That content is bounded and redacted, but it is source text
in the ledger where before there was one line. The opencode path already
sends diffs to critics, and `changed_files` remains digest-only.

A failing verifier's output tail varies between attempts (timings, paths),
so the retry fingerprint derived from the root cause changes more often than
the bare code did. Repeated identical failures are still caught when the
output is stable.

A native panel reviewer whose dispatch fails now also forwards its typed
`error`, as `ReviewerVerdict.error` intends, instead of becoming a rejection.

**Amendment (2026-10-07, UCT Stage 0 Revision 2.2 pilot, H7):** a critic
reply that is not a JSON object is malformed critic output in the same sense
as §3's placeholder text. The contract's `unparsed_reason` names it with the
`malformed_critic_verdict` prefix and says exactly what to send, the worker
gives it the bounded correction turns, and an exhausted review parks the
node `awaiting_review` with its candidate kept, as §3 already does. The
`checks[root_cause]` refusal now names which way to fix the flag (passed
means no blocker was found).

## Alternatives / Roads not taken

**Concatenate the specialist message into the worker's verified terminal
message.** Rejected: the terminal message is recorded under `verified`
provenance, and mixing model-authored claims into it blurs exactly the
type distinction the governance model rests on.

**Have each panel reviewer capture the diff from `PanelContext.worktree_path`,
as the opencode reviewer does.** Rejected for the native path: the
single-critic route and the durable candidate would still hold only the
receipt, and the specialist's own report would still be lost.

**Treat a placeholder verdict as an unparseable rejection.** Rejected: that
is the behaviour that failed runs 1 and 2. A verdict that names no finding
is not evidence about the work in either direction.

**Fuzzy placeholder detection (short text, low entropy).** Rejected: a
terse genuine finding ("N/A", "no blocker") must never be refused. Only
whole-field template text counts.

## Obligations

### O1 — The critic receives the specialist's report and a redacted diff of the attempt

A verified native session's critic input contains the specialist's final
message, the machine verification line and the candidate diff, and never a
credential-shaped string from that diff, demonstrated through the production
CLI composition with a faked provider.

<!-- proof: symbol=composeReviewableSpecialistOutput file=packages/arbor-mcp/src/native-agent-executor.ts roundtrip=packages/arbor-mcp/tests/native-critic-evidence-e2e.test.ts -->

### O2 — A placeholder verdict is refused as malformed, never accepted as a review

The native contract refuses whole-field template text in rationale, root
cause or check detail with a `malformed_critic_verdict` reason that names the
field, and accepts short genuine findings.

<!-- proof: symbol=nativeCriticVerdictPlaceholderField file=packages/arbor-mcp/src/native-critic-contract.ts roundtrip=packages/arbor-mcp/tests/native-critic-contract.test.ts -->

### O3 — An exhausted malformed verdict reaches the panel as an error, not a rejection

The native panel reviewer forwards the review's typed `error`, so a node
whose critic only returns templates is parked `awaiting_review` rather than
failed.

<!-- proof: symbol=createNativePanelReviewer file=packages/arbor-mcp/src/cli.ts roundtrip=packages/arbor-mcp/tests/native-critic-evidence-e2e.test.ts -->

### O4 — Harness-captured evidence crosses one shared sanitizer

The verifier's failure tail and the critic's candidate diff are both passed
through `sanitizeHarnessEvidenceText` before the session redactor, and the
failure tail reaches the retrying specialist's prompt and `arbor report`.

<!-- proof: symbol=sanitizeHarnessEvidenceText file=packages/arbor-mcp/src/worktree-machine-verifier.ts roundtrip=packages/arbor-mcp/tests/native-critic-evidence-e2e.test.ts -->
