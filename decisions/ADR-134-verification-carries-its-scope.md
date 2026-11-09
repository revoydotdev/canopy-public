# ADR-134: A Verification Result Carries Its Scope, Not Just Its Verdict

**Status:** Accepted
**Date:** 2026-08-27
**Authoring Revision:** 3e7ffa215cf325197b8f0065d2df1e48470650b6
**Content ID:** sha256:d1282eecd13d46f83d0a68be76e3445a727a7306a8395c84597e8ec07ba6e14e

## Context

`packages/arbor-core/src/types.ts` (lines 47-51) defines `Provenance` as a
closed four-tag union: `verified`, `claimed`, `critic_approved`,
`generated`. Only `tag: "verified"` — a real `cmd`, a real `exit`, a real
`stdout_hash` — can retire a tree node as `verified`
(`packages/arbor-core/tests/invariant.test.ts` drives this end to end: a
`claimed`, `critic_approved`, or `generated` provenance, or a `null`
provenance, can never reach `verified` state). That binary is real and it
is this system's best property: `verified` means a command actually ran,
exited zero, and its stdout was hashed — not merely asserted. Nothing in
this ADR loosens it.

The finding is that the binary is not where the risk lives. Three
independent sources converge on the same gap, in three different domains:

- **SWE-Bench+** (arXiv 2410.06992) manually screened SWE-Agent+GPT-4's
  "resolved" patches on SWE-bench and found 31.08% passed only because the
  benchmark's own test suite was too weak to catch a wrong fix; filtering
  those out dropped the reported resolution rate from 12.47% to 3.97%.
- **SWE-ABS** (arXiv 2603.00520) adversarially strengthened SWE-Bench
  Verified's test suites via coverage-driven augmentation and mutation
  testing and found one in five patches the leaderboard counted as
  "solved" were semantically incorrect, passing only because the original
  tests failed to expose the error — enough to drop the top agent's score
  from 78.80% to 62.20%.
- **This system's own source paper**, Arbor (arXiv 2606.12563, Prakriya et
  al.), reports that 39% of kernel-level "verified" improvements the
  harness accepted regressed once measured at end-to-end scope.

All three say the same thing from a different angle: a verification
command exiting zero is a true fact about that command, not a true fact
about whatever broader claim the reader assumes it settles. This repo has
already made one real move in this direction. ADR-064's E-4 gave
`Provenance` an additive `strength?: "command_executed" | "outputs_check"`
(`types.ts:45`) so the critic's note text can distinguish "the plan's real
acceptance command ran" from "only declared output files were checked for
existence" (`worktree-machine-verifier.ts:468`, `cli.ts:973`,
`loop.ts:2117`). `types.ts` separately declares a `VerificationCheck` shape
(`kind: "shell_command" | "internal_integrity"`, `breadth: "suite" |
"subset" | "single"`, lines 21-33) that could carry the SWE-Bench+/SWE-ABS
axis — did the executed command's scope actually cover the claim being
retired, or only a narrow slice of it.

Neither field does that work today. Both are optional on `Provenance`
(`check?: VerificationCheck; strength?: VerificationStrength`,
`types.ts:49`). `EvidenceCheck`, the input contract for
`packages/arbor-gate/src/gate.ts`'s `checkEvidence` — the gate that decides
whether a node's evidence is sufficient — declares `provenance_tag`,
`stdout_hash`, `exit_code`, `promoted_claim`, `evidence_text`
(`gate.ts:24-36`) and nothing else; `check`/`breadth`/`strength` are not
even fields of the type the gate receives, so `checkEvidence`'s body
(`gate.ts:77-90`) cannot read them regardless of whether a caller
populated them. `gate.test.ts`'s `describe("checkEvidence", ...)` block
(eleven cases) never constructs a check with breadth or strength, because
there is nowhere on `EvidenceCheck` to put one. And the one production
writer of `check`, `verifiedProvenanceFromRun`
(`packages/arbor-eval/src/live-verification.ts:79-92`), hardcodes
`breadth: "single"` unconditionally on every call — it is not derived from
what actually ran, so today it carries no information at all.

Frame this with **Verification Autonomy Levels** (arXiv 2608.19009,
"Grading the Graders"), which classifies a verification scheme by where
its spec comes from and what the verdict guarantees, from L0
(self-declaration) through L2 (objective ground truth, correctness only)
to L3/L4 (completeness, reachable only for formally specifiable
properties). A shell command's exit code checked against a real hash is
squarely **L2 — anchored correctness**: the verdict is objective, but it
says nothing about whether the checked property is the same property the
reader assumes was checked, and nothing about completeness — VAL's
"completeness blind spot" is that a verifier can confirm what it looked at
holds, never that nothing was missed. This repository's own `gate:vi-freshness`
gate (`scripts/vi-freshness-gate.mjs:181-184`) already states this about
itself in almost the same words, independently of this research pass:
"Strength: DETECTED, not PREVENTED. This bounds distance using git and the
manifest; it does not regenerate, so it cannot prove the graph matches
HEAD's source — only that it is not far behind, was built from a real
commit, and is not degraded." The repository arrived at the VAL ceiling on
its own; this ADR generalizes the same honesty to every `verified`
provenance record, not just the freshness gate.

## Decision

**A `verified` provenance record must state what it checked, and every
surface that renders "verified" to a reader must render that scope
alongside it. This ADR does not attempt to reach L3 or higher — it makes
the existing L2 ceiling visible, not exceeded.**

1. **`EvidenceCheck` gains the fields `checkEvidence` needs to see scope.**
   `packages/arbor-gate/src/gate.ts`'s `EvidenceCheck` interface adds
   `check?: VerificationCheck` and `strength?: VerificationStrength`,
   mirroring `Provenance`'s own fields exactly rather than inventing a
   second shape. `checkEvidence` reads them for a `verified` tag and adds
   the resolved scope to the `GateResult` it already returns (a new,
   additive field — this ADR does not change what `failures`/`unresolved`
   mean, and a missing or absent scope is never itself a gate failure; see
   §3).

2. **`verifiedProvenanceFromRun` stops hardcoding `breadth`.** The caller
   supplying a `VerificationCommand` must declare what breadth the command
   they are running actually has (`suite`/`subset`/`single`), the same way
   `WorktreeVerificationCommand.strength` is already caller-declared
   (`worktree-machine-verifier.ts:468`) rather than inferred after the
   fact. `verifiedProvenanceFromRun` threads the caller's declared breadth
   into `check` instead of writing a constant. A caller that declares
   nothing gets `check: undefined` — an honest "scope unknown," never a
   guessed value.

3. **Absence of scope is not blocked, and narrow scope is not blocked —
   only unsurfaced scope is.** `checkEvidence` never fails or downgrades a
   node for having `strength: "outputs_check"` or `breadth: "single"`; a
   narrow-scope verification is still a real, honest `verified` record of
   what it checked. What changes is that the scope travels with the
   verdict instead of being dropped at the gate boundary, so a downstream
   reader — the critic's note, an audit report, a human reviewing a
   campaign's outcome — can see "verified (single command, outputs-check
   only)" instead of an undifferentiated "verified" that reads the same as
   a full-suite, command-executed pass. Making this a blocking condition
   would be a policy judgment about sufficiency this ADR explicitly does
   not make (see Alternatives).

4. **Every human-facing rendering of a `verified` outcome states scope
   next to verdict, not verdict alone.** Concretely: the critic-note
   composer already does this for `strength` (ADR-064); this ADR extends
   the same requirement to `breadth` and to every other place a `verified`
   tag reaches a human or an audit artifact without going through that
   composer — obligation-resolution prose in ADR files (this repository's
   own `<!-- proof: ... -->` convention already names a symbol and a
   roundtrip test; it does not yet name what breadth that roundtrip
   covers), campaign summaries, and `arbor-eval`'s trajectory reports. The
   mechanism is additive text, not a new gate: nowhere does "verified"
   render without its scope again being nowhere to find.

## Consequences

A reader can now tell a narrow unit-test pass from an end-to-end
acceptance-command pass by looking at the same field the gate already
consumes, instead of inferring it (or failing to) from prose. This does
**not** reduce the false-positive rate SWE-Bench+, SWE-ABS, or Arbor's own
paper measured — a labeling fix cannot repair a weak test suite, and this
ADR does not claim it does. What it buys is that when a `verified` record
*is* one of those false positives — a real command that ran, exited zero,
and still didn't settle the claim the reader assumes it settled — the
record itself carries the information needed to notice, instead of
looking identical to a genuinely comprehensive pass. `checkEvidence`,
`verifiedProvenanceFromRun`, and every caller of either gain one additive,
optional field each; no existing `Provenance` value becomes invalid, and
no existing gate outcome flips from pass to fail. The cost is that scope
must now be threaded through every new call site that produces a
`verified` record — a caller that skips it is not blocked, but its
`verified` record stays as opaque as it is today, so this decision only
pays off as adoption spreads past the first writer this obligation set
proves out.

## Alternatives / Roads not taken

**Fail the gate on narrow or missing scope.** Rejected: that is a decision
about sufficiency — how much verification is enough for a given claim —
which is exactly the kind of policy judgment VAL's completeness blind spot
warns cannot be settled at L2. Blocking on scope would silently convert an
honest "I checked X" into an implicit, unstated claim about how much
checking is required, which is worse than the status quo's silence, not
better.

**Add a numeric "coverage score" instead of the closed `breadth` enum.**
Rejected: a synthesized confidence number dressed as an objective measure
is the same "forced proof that resolves but demonstrates less than it
claims" anti-pattern this repository's own obligation discipline already
names as worse than an honest gap (see `docs/adr-authoring.md`'s M-C rule and
ADR-106's rejected alternative of backpropagating an unvalidated
heuristic). `breadth`/`strength` are closed enums with no room to imply
false precision; a coverage percentage would invite exactly that.

**Reach for L3 (formal completeness) on the acceptance command itself —
e.g. require mutation testing or coverage thresholds before a result can
be `verified`.** Rejected per VAL's own dichotomy: completeness is only
reachable for formally specifiable properties, and this repository's
acceptance commands are arbitrary shell invocations, not specifications.
Naming this as a future direction without qualification would be the
exact overclaim this ADR exists to prevent — an unmet standard could be
declared met by fiat, which is a worse failure mode than today's honest
silence about scope.

**Leave `check`/`strength` optional and unread, relying on convention and
code review to notice scope gaps.** This is the status quo the Context
section describes, and it is falsified by the repository's own tests:
`gate.test.ts`'s eleven `checkEvidence` cases never exercise breadth or
strength because `EvidenceCheck` has nowhere to put them, and
`verifiedProvenanceFromRun`'s hardcoded `"single"` shows that even the one
field that does exist on `Provenance` degrades to a constant the moment
nothing forces it to carry real information.

## Obligations

### O1 — `verified` provenance is a genuine, machine-checked binary today, carrying no completeness claim

`Provenance`'s `verified` tag requires a real `cmd`, `exit === 0`, and a
non-empty `stdout_hash`; `claimed`, `critic_approved`, `generated`, and
`null` provenance can never retire a tree node as `verified`. This is the
property this ADR preserves unmodified while adding scope alongside it —
grounding the Decision's claim that nothing about the binary loosens.

<!-- proof: symbol=Provenance file=packages/arbor-core/src/types.ts roundtrip=packages/arbor-core/tests/invariant.test.ts -->

### O2 — The evidence gate that decides sufficiency does not read scope today, confirmed by its own input contract and its own tests

`checkEvidence`'s parameter type `EvidenceCheck` declares
`provenance_tag`, `stdout_hash`, `exit_code`, `promoted_claim`,
`evidence_text` and no `check`/`breadth`/`strength` field; `gate.test.ts`'s
`checkEvidence` suite (eleven cases) never constructs one with scope
information, because the type gives it nowhere to go. This is the gap
Decision §1 closes.

<!-- proof: symbol=checkEvidence file=packages/arbor-gate/src/gate.ts roundtrip=packages/arbor-gate/tests/gate.test.ts -->

### O3 — The one production writer of `VerificationCheck` hardcodes its breadth rather than deriving it from what actually ran

`verifiedProvenanceFromRun` sets `check: { kind: "shell_command", breadth:
"single" }` unconditionally on every successful run, regardless of what
command or how many tests it actually executed — the field exists on the
returned `Provenance` but carries a constant, not an observation. This is
the gap Decision §2 closes.

<!-- proof: symbol=verifiedProvenanceFromRun file=packages/arbor-eval/src/live-verification.ts roundtrip=packages/arbor-eval/tests/live-verification.test.ts -->

### O4 — Once `EvidenceCheck` and its writers carry real scope, every human-facing "verified" rendering can state it — this is future work, not yet built

Decision §4's requirement that campaign summaries, `arbor-eval` trajectory
reports, and ADR obligation prose render scope next to verdict depends on
O1-O3 landing first (the fields must exist and carry real values before
any renderer can surface them), and on choosing which of several existing
rendering call sites to extend — a scope decision for the implementing
tranche, not this record. No roundtrip can demonstrate a capability that
does not exist yet.

<!-- unverifiable: this obligation describes rendering work gated on O1-O3's implementation landing first; no renderer change exists yet to write a roundtrip test against -->
