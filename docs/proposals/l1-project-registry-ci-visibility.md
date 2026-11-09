# L1 — the project registry is invisible to CI, and why it stays that way

**Status:** analysis, not a decision. Written while closing Roadmap 23 §6's
L1 and L2 limits. Implements a narrow, non-gating fix (below); does not
close the CI-visibility gap, and explains why not.

## The limit, restated

`docs/roadmaps/23-multi-project-enrollment.md` §6, L1:

> CI sees an empty registry, so `gate:project-registry` passes trivially
> there... Closing it needs a decision about where durable multi-project
> state lives, which is exactly the centralized-vs-federated question
> ADR-076 explicitly declined to settle.

`.arbor/` is gitignored, correctly (ADR-076): entries hold machine-specific
absolute paths, and committing them would be meaningless across checkouts.
The consequence is that a fresh clone or a CI runner always evaluates a
registry with `entry_count === 0`, and `evaluateProjectRegistry`'s `ok` is
vacuously `true` for that state (ADR-076 requirement 6, deliberately: an
operator who genuinely governs zero projects must not be told they have a
failing gate).

## What was implemented

`packages/arbor-mcp/src/project-registry.ts`'s `ProjectRegistryReport` now
carries a `present: boolean` field: whether
`<persistenceDir>/project-registry.json` actually exists on disk, as
distinct from `entry_count === 0` because the file legitimately holds zero
entries. `evaluateProjectRegistry` computes it with a plain `existsSync`
check before loading. `formatProjectRegistryReport`'s human-readable output
now reads differently for the two states:

- present, empty: `(governing no projects — a valid state, not a failure)`
  (unchanged wording)
- absent: `(no registry file present — nothing has been registered here
  yet, which is not evidence that every governed project passes; run
  \`arbor project registry list\` to confirm)`

`--json` output gets the field automatically (`scripts/project-registry-gate.mjs`
already serializes whatever `evaluateProjectRegistry` returns and prints
whatever `formatProjectRegistryReport` renders — neither needed to change
to pick this up, and neither was touched by this change).

Verified directly, against this checkout's own `.arbor/project-registry.json`
(a real, present, empty registry file):

```
$ bun scripts/project-registry-gate.mjs --json
{ "ok": true, "entry_count": 0, "verifications": [], "present": true }
```

and with that file moved aside to simulate the fresh-clone/CI state:

```
$ bun scripts/project-registry-gate.mjs --json
{ "ok": true, "entry_count": 0, "verifications": [], "present": false }

$ bun scripts/project-registry-gate.mjs
Project registry — 0 entries
(no registry file present — nothing has been registered here yet, which is
not evidence that every governed project passes; run `arbor project
registry list` to confirm)
...
PASS
```

Deliberately, `ok` and the gate's exit code do **not** change based on
`present`. See the next section for why.

## Why `present: false` must not become a failure

The tempting next step is: if the registry file is missing, fail the gate
instead of passing it — that is what would make "no registry" visibly
different from "empty registry" in the one place that actually matters, CI's
exit code, not just in a message a human has to go read.

That does not work, and not for a subtle reason: `.arbor/` is gitignored in
**every** revoy2 checkout, including revoy2's own. There is currently no
mechanism by which a `project-registry.json` reaches a CI runner for *any*
repository under this scheme, this one included. `gate:project-registry` is
wired into `gate:all` at the "stop" tier
(`scripts/gate-all.mjs:106`) — a required gate for this repository's own
release readiness. If `present: false` failed the gate, `gate:all` would
fail on every single CI run of revoy2 itself, forever, with no operator
action available to fix it (there is nothing to commit — the `.gitignore`
entry is correct and should stay). That is not "distinguishing absence from
emptiness for CI." It is turning a required gate permanently red, which
would either get the gate disabled or get `.arbor/` un-gitignored under
pressure — the second of which reintroduces exactly the machine-specific,
meaningless-across-checkouts commit content ADR-076 was written to avoid.

Put differently: the reason CI cannot see a *populated* registry is not a
bug in the gate. It is the absence of any durable channel between "an
operator's local `arbor project enroll` runs" and "what a CI runner
observes." That channel is precisely the centralized-vs-federated storage
question ADR-076 named and declined to answer:

- **Federated**: each governed project's own repo carries some committed
  record of its own registration (e.g., a project asserts membership from
  its own checkout), and a central registry is assembled by querying
  members rather than being the sole source of truth. Concurrency/staleness
  and cross-repo trust become the open questions.
- **Centralized**: some service or shared, non-gitignored store (a
  database, a dedicated non-`.arbor` repo, an artifact bucket) holds the
  registry durably, and every checkout — including CI runners — reads from
  it. Availability, auth, and "what happens when the store is unreachable"
  become the open questions.

Neither is free, and ADR-076 was explicit that choosing between them was
out of scope for the registry's *semantics* (claim-with-discharge), which
is the part it did settle. Manufacturing a storage topology inside this
task, under a roadmap item that explicitly named the question as open,
would be inventing an architectural decision that belongs in its own ADR
with its own review — not a side effect of closing L1's reporting gap.

## What this leaves open

- CI (and any fresh clone) still cannot observe real multi-project
  governance state. `present: false` is now reportable, not hidden, but it
  is not enforced.
- Closing that requires: (1) an ADR settling centralized vs. federated
  durable state, and (2) whichever storage mechanism it picks, wired so a
  CI runner can populate or reach a registry before `gate:project-registry`
  runs. Neither is implemented here.
- A further, smaller follow-up that *would* need a `scripts/**` change
  (outside this task's ownership boundary — `scripts/project-registry-gate.mjs`
  belongs to the sibling workstream for this task) is deciding whether
  `arbor project manage`'s own report should surface `present` in its
  per-project summary the same way. Not attempted here; flagged for whoever
  picks up L1's next increment.

## Judgment

L1 does **not** need the centralized-vs-federated decision to become
*reportable* — that part was closed here, narrowly, inside
`packages/arbor-mcp` only, with no gate-exit-code change and no `scripts/**`
edit. L1 **does** need that decision to become *enforced* in CI, because the
only way to make "absent" fail without a durable-state answer is to make a
permanently-red required gate the price of correctly gitignoring
machine-specific paths. That trade is not worth taking silently, so it was
not taken.
