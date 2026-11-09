# ADR-154: The Stop Breaker Never Releases On An Unproven Battery

**Status:** Accepted
**Date:** 2026-09-02
**Authoring Revision:** 9ac0a0e7df31cbb2a60dc06881a76959b839b8c2
**Content ID:** sha256:12aa42e5be21f76f67f19e097bd0d62dfecefbcb121adf52b24892359d51ebb0

## Context

ADR-074 made the cheap gate tier a mandatory end condition: scripts/hooks/gate-stop.sh
blocks the Stop event whenever the stop-tier battery is red, and feeds the gate's own
remedy text back into the turn. scripts/hooks/stop-guard.mjs then added a bounded
no-progress circuit breaker, because a gate can be red for a reason no amount of
re-reading the same remedy fixes from inside the session — an owed operator verdict, an
interview answer. Without an escape valve that session is wedged forever.

The breaker keys on a fingerprint: the sorted set of blocking gate names and exit codes,
extracted from the battery's human-readable output by `parseRedGates`. After
`ARBOR_STOP_GUARD_MAX_NO_PROGRESS` (default 3) consecutive identical fingerprints it
releases.

That premise — "this session has seen the SAME red gates N times and cannot fix them" —
requires knowing which gates are red. It does not hold when the battery fails *before any
gate reports*. Roster drift is the important case and it is deliberate: when the declared
`gate:*` set and `GATE_TIERS` disagree, `scripts/gate-all.mjs` runs **no gates at all**,
on the stated reasoning that a green battery over a wrong roster proves nothing. An
unknown `--tier`, or a crashed battery, produce the same shape. None of them print a line
matching either of `parseRedGates`'s two regexes, so all of them collide on the
fingerprint of the empty set.

This is not hypothetical. Of the 75 releases recorded in
`.git/arbor/stop-guard/releases.jsonl` on this machine, **31 carry `blocking_gates: []`
and `advisory_red_gates: []`**, all sharing fingerprint
`4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`, which is
`sha256("[]")`. It correlates with the 92 gate-stop.sh exit-2 rows in
`.hook-liveness/invocations.jsonl`. In each of those, three unrelated structural failures
in a row were read as "no progress" and the Stop was released — and the release message
could not name a single gate that was still red, because there were none to name.

So the one condition that proves *nothing was checked* is currently the condition most
likely to be released, because every instance of it looks identical to every other.

## Decision

**An unnameable battery failure is a distinct failure class, and it always blocks.**

1. A non-zero battery that named no blocking gate is recognised by
   `isUnnameableFailure`, an exported predicate, rather than by an inline emptiness
   check. Conflating "no gates are red" with "the battery could not say what is red" is
   the defect; a named predicate is what stops the two being conflated again.

2. It is handled **before any state is read or written**, so it is inert to the breaker:
   it cannot advance the counter, cannot reset another fingerprint's counter, and cannot
   be released. A session alternating between a real failure and a structural one sees
   the real fingerprint's count neither accelerated nor cleared.

3. It writes **no line to `releases.jsonl`**. A release record asserts that a bounded
   escape was granted against a known red set; there is no such set here, and an entry
   claiming one would be the same unwitnessed claim in the audit trail.

4. Its message states that the battery failed before any gate reported, that the breaker
   does not apply and will never release it, and the three causes the code already knows
   about (roster drift, an unrecognised tier or context name, a crashed battery). The
   battery's own output is still passed through, because per ADR-113 the remedy text is
   the part that changes what happens next.

The threshold is deliberately **not** raised to compensate. The other 45 releases are
genuine: real red gates a session could not fix. Those are an observability problem rather
than a release-rule one, and this decision closes that half too:

5. **The journal is read.** `gate:stop-guard-releases` audits `releases.jsonl` at Stop. It
   **blocks** on exactly one condition — an empty-set release record dated after
   `scripts/stop-guard/baseline.json` — which after point 2 is structurally impossible and
   therefore means the guard regressed. It **reports and never gates** the release rate,
   because a release means a session met a red gate it had no authority to clear; failing
   a gate on that would punish the session for the repository's state and produce the
   bypass ADR-074 warns about.

   The baseline is an instant, not a count. The 31 historical empty-set records are the
   evidence the defect was real; pruning them to satisfy a count would destroy it. The
   instant may move EARLIER as history is genuinely pruned, never later, since moving it
   later would relabel a real regression as history.

   The gate is `required: false` and absent from CI under `local_history_only`. The
   journal lives in the gitignored git common dir and is per-clone; in CI this gate would
   read an empty file and print a clean result forever, which is a check that cannot fail
   reported as a check that passed. `gate:hook-liveness` carries the same exclusion for
   the same reason.

## Consequences

Easier: a roster-drift state can no longer be walked past. Under ADR-074 that state
exists precisely so that a wrong roster fails loudly instead of reporting a false green,
and the breaker was quietly undoing it after three turns. The two mechanisms now agree.

Harder: a session that hits a genuinely unfixable structural failure — a battery that
cannot start for an environmental reason — is wedged, with no bounded escape. This is
accepted deliberately. The remaining exits are `ARBOR_SKIP_STOP_GATES`, which is explicit
and printed, and fixing the roster, which is usually a one-line edit the message now names.
A wedge that says exactly what is wrong is a better failure than a release that cannot say
what it released past.

Visible, where it was not before: the release rate now prints at every Stop. On adoption
this repository reads 77 releases, 4 distinct fingerprints, and a maximum consecutive count
of 43 — a single session ending its turn 43 times against an identical failing set. That
number was always true and nothing surfaced it.

Unchanged: every property proven in scripts/tests/stop-guard.test.mjs for named
failures. The block/block/block/release sequence, reset-on-change, stay-released, and the
no-session-id path all behave exactly as before.

Note a coupling this decision inherits rather than creates: `parseRedGates` reads
`gate-all.mjs`'s *printed* shape, so a change to `printFailureSection` can turn a
nameable failure into an unnameable one. Under this ADR that now fails closed — it blocks
rather than releasing — which is the safe direction, but it is still a defect to be found.
ADR-113's existing test coupling on the printed shape remains the guard against it.

## Alternatives / Roads not taken

**Fingerprint the battery's raw output instead of the parsed gate set.** Would let
distinct structural failures count separately, so three *identical* roster-drift failures
would still release. Rejected: repetition is not the question. A failure that checked
nothing should not become acceptable through repetition, however faithfully we distinguish
one from another.

**Raise `ARBOR_STOP_GUARD_MAX_NO_PROGRESS`.** Rejected: it treats a correctness defect as
a tuning parameter, delays every legitimate release, and still releases the unnameable
case eventually.

**Make `gate-all.mjs` always emit a parseable pseudo-gate for structural failures.**
Rejected as the wrong seam: it would satisfy the regex while leaving the breaker
reasoning about a fabricated gate, and it puts the fix in the producer of the text rather
than in the component whose premise is violated.

**Have the breaker verify the roster itself before releasing.** Rejected: it duplicates
`auditRoster` in a second place that could drift from it, which is the failure shape
`gate:execution-profile` exists to prevent.

## Obligations

### O1 — An unnameable battery failure is recognised as its own class, not as an empty list

`isUnnameableFailure` is exported and separately tested, so the distinction between "no
gates are red" and "the battery could not name what is red" cannot be re-collapsed into an
inline emptiness check without deleting a named, covered symbol.

<!-- proof: symbol=isUnnameableFailure file=packages/arbor-mcp/src/hooks/stop-battery.ts roundtrip=packages/arbor-mcp/tests/hooks/stop-battery.test.ts -->

### O2 — An unnameable failure blocks on every repetition and records no release

Driven through the real hook with a stubbed battery: six consecutive roster-drift
failures all exit 2, `releases.jsonl` is never created, and an unnameable run interleaved
with a real one leaves the real fingerprint's count untouched.

<!-- proof: symbol=buildUnnameableFailureMessage file=packages/arbor-mcp/src/hooks/stop-battery.ts roundtrip=packages/arbor-mcp/tests/hooks/stop-battery.test.ts -->

### O3 — The release journal is audited, and the audit can fail

`gate:stop-guard-releases` blocks on an empty-set release record dated after the baseline
and reports the rate without gating on it. Both directions are driven as pure functions of
a journal and a baseline, so the verdict is provable without a real breaker having run.

<!-- proof: symbol=auditReleases file=scripts/stop-guard-releases-gate.mjs roundtrip=scripts/tests/stop-guard-releases-gate.test.mjs -->
