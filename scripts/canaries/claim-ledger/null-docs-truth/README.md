# Canary: gate:claim-ledger — a validating gate that produced no report

Run as `bun run gate:claim-ledger --repo {repo}`.

## The behaviour under test

`claim-ledger.ts` does not re-decide what `docs-truth.mjs` decides; it spawns it
and joins the result. Its rule CL-C is that a `docs-truth` run which produced no
usable report is not a clean report — `violations` is `[]` either way, so every
`✅` claim would otherwise read as unviolated and DISCHARGE on a validation nobody
performed. A null result must leave the claim UNDISCHARGED and block the gate.

## How the fixture forces that null

`--repo` points the gate at this directory, and this directory has **no
`scripts/docs-truth.mjs`**. The gate's own subprocess spawn therefore fails at
ENOENT, its `catch` returns `null`, and `docsTruthAvailable` is false. That is
deliberate: the fixture does not need a broken docs-truth, only an absent one,
so the canary is a property of `claim-ledger`'s handling and not of the state of
the live corpus. (Note the difference from the `--docs-truth-json` reuse flag,
which exists precisely so a caller can hand in a real report; the fixture
deliberately supplies none.)

## What the ROADMAP here is for

One `✅` heading and nothing else, so the claim population is exactly one and
every count in the output is attributable to it. The consequences are the point:

- CL-C fires — the validating gate produced no usable report.
- CL-A fires — the one claim is new (this fixture's store is empty) AND
  undischarged. It is undischarged precisely because the docs-truth result was
  null.

CL-R does not fire, and correctly so: one undischarged claim is exactly the
floor, not above it. A fixture that produced two `✅` claims would trip the
ratchet as well and blur which rule was under test.

## Two things this fixture must have, and why

`git_repo: true` is not optional. Before it reads a single claim the gate asserts
its governance consumer precondition, which resolves the repository's common git
directory; against a plain directory that throws
`cannot resolve repository common git directory` and the gate exits 1 having
examined nothing. That is a real refusal, but it is the wrong one to assert —
it would be a canary green for a reason that has nothing to do with CL-C. So the
fixture is a one-commit repository, and `REVOY2_CLAIM_LEDGER_DIR` points the
store at the fixture's own (empty) `.claim-ledger`, leaving the real store
untouched.

Two lines of stderr noise on every run are expected, not fixture damage: the
caught `Module not found .../scripts/docs-truth.mjs` from the docs-truth spawn,
and `ambiguous argument 'HEAD~60..HEAD'` from the commit-message scan on a
one-commit history. Both are the failures the fixture is built to cause, and both
are caught; neither changes the verdict.

## What this canary proves, and what it does not

Proves: a null docs-truth discharges nothing, and the gate blocks in its own
right rather than relying on a downstream count happening to trip.

Does not prove anything about the live corpus's current red, and this fixture is
not a fix for it. `docs-truth.mjs` fails on the real checkout for an unrelated
environmental reason (a `vitest run --reporter=json` child whose output does not
parse), which makes `claim-ledger` correctly red there too. Both are pre-existing
baseline debt. The two are independent: this canary passes identically whether or
not the live `docs-truth` breakage is ever fixed, which is exactly why it is a
statement about `claim-ledger` and not about the environment.
