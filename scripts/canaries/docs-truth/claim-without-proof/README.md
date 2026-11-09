# Canary: gate:docs-truth — a claimed tranche with no proof comment

Run as `bun run gate:docs-truth --repo {repo}`.

## What the gate must reject

`docs-truth.mjs` is a FAIL-CLOSED gate: ROADMAP.md's own rule is that a tranche
is complete only when a non-test caller reaches it, and the machine-checked form
of that rule is an HTML proof comment that resolves. Its first and
cheapest check is structural — a claimed (✅) leaf heading with **zero** proof
comments is a violation, before any symbol lookup, reachability query, or vitest
run happens.

That is what this fixture supplies: one claimed leaf heading and no proof comment.

## Why the fixture contains none of the strings the gate looks for

The fixture is itself an input to the gate. `ROADMAP.md` here is parsed by the
same parser that parses the real one, so this file deliberately contains **no**
proof comment, **no** documentation-register declaration, and **no** `G-NN`
token (every `G-NN` mentioned anywhere in ROADMAP.md is required to have a
register row, and this fixture declares no register at all). Adding any of them
would let the fixture satisfy the very check it is meant to fail — a canary that
passes for the wrong reason is worse than no canary. The same rule is why this
paragraph describes those comments instead of writing them out: an HTML comment
marker reproduced here would be one keystroke away from being copy-pasted into
the fixture's ROADMAP.md, and this file is not read by the gate, but a fixture
whose own prose is a loaded gun is a bad habit to leave lying around.

## The two stand-in inputs, and why they are here rather than symlinked

`docs-truth.mjs` reads two things it does not own:

- `scripts/reachability.mjs --json`, spawned as a child, whose `checklist` array
  is the authority on "does this symbol exist and is it reachable". This fixture
  ships a three-line stand-in that emits an empty checklist. That is a
  deliberately EMPTY authority: the canary's failure is decided before any
  symbol is looked up, so the checklist has no bearing on the verdict. The
  real `scripts/` is not symlinked in because the real reachability gate
  enumerates a real `packages/*/src` tree, and a fixture with none would make
  the child fail rather than answer.
- Three documents the gate reads unconditionally, outside any ROI: the
  product-quality register, the operator-decision reconciliation, and the TUI
  census. A missing one throws ENOENT and the gate dies before reporting, so
  all three exist. The operator-decision file carries one declaration per ID
  the gate hardcodes, each `state=`-matched and each citing a file that exists,
  so that leg is clean and cannot be mistaken for the failure.

## What this canary proves, and what it does not

Proves: `gate:docs-truth` exits non-zero on a claimed tranche that carries no
proof, and it names the cause.

Does not prove anything about the live corpus's current red. `docs-truth.mjs`
fails there for an unrelated environmental reason (a `vitest run --reporter=json`
child whose output does not parse), which is pre-existing baseline debt. This
fixture never reaches that leg: it has no proof comment, so no roundtrip file is
collected and vitest is never spawned. The two failures are independent, and this
canary says nothing about fixing the other one.
