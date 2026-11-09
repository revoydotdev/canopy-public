# Authoring an ADR

This is the reference an ADR author reads instead of reverse-engineering
conventions from other decisions/*.md files. It states what each section must
answer, the proof-triple contract, and the voice this corpus writes in.

Structure is mechanized, not left to imitation: `bun scripts/adr-registry.mjs new <slug> --title "…"` (see `scripts/lib/adr-registry.mjs`'s `newPendingDecision`) scaffolds every required heading — Context, Decision, Consequences, Alternatives / Roads not taken, and Obligations with a real `### O1 — <claim>` skeleton — as HTML-comment prompts. `gate:adr-sections` (`scripts/adr-sections.mjs`) fails a non-retired ADR whose heading is missing or whose body is still just that prompt. Neither tool judges whether the *content* is good — that part is still yours.

## What each section must answer

**Context** — what forces make this decision necessary *right now*. Cite the
concrete trigger: a bench run, an incident, a measured gap, a specific prior
decision this one responds to. "We should probably..." is not a force; a
reproducible failure, a measured count, or an operator directive is.

**Decision** — what is being decided, and by what mechanism. Name the actual
functions/types/files that carry the decision, not just the shape of the
idea. A reader should be able to go from this section straight to the diff.
Numbered sub-decisions are fine and common when one ADR closes several
related gaps (see ADR-088).

**Consequences** — what becomes easier and what becomes harder as a result.
Both directions, honestly — a decision with only upside was not a decision,
it was the obvious move. Note what this does NOT change (a boundary left
alone is itself a claim worth stating explicitly).

**Alternatives / Roads not taken** — the other approaches considered, and
the specific reason each was rejected (not "we didn't have time," but the
actual tradeoff). This is the section a reviewer uses to check whether the
chosen approach was actually compared against real alternatives or just the
first idea that worked. `gate:adr-sections` currently ratchets this section
(see its own header comment for the floor and why) rather than hard-blocking
on it — most of the existing corpus predates this convention — but every
newly-scaffolded ADR carries the heading and should fill it in.

**Obligations** — the durable, checkable claims this decision makes about the
system, each as its own `### O<n> — <claim>` item with a proof. This is the
one section that is falsifiable by construction: a claim with a resolving
proof is checkable by anyone, forever, without re-reading the prose.

## The proof-triple contract

An obligation's proof is an HTML comment with a fixed grammar, parsed by
`packages/arbor-governance/src/obligation/parse.ts` and resolved against the
real working tree by `packages/arbor-governance/src/obligation/proof.ts`:

```
<!-- proof: symbol=<Name> file=<path> roundtrip=<test-path> -->
```

- `symbol=` — the name a reader would grep for. It MUST be a top-level
  **exported** symbol (a direct `export function/class/const/interface/…`,
  or re-exported via `export { Name }`) — an internal/unexported symbol
  cannot be verified by an external reader, and citing one is exactly the
  ADR-088 failure this tooling exists to catch before allocation, not after.
- `file=` — repo-relative path to where `symbol=` is declared. Optional in
  the grammar but always worth supplying: without it, resolution falls back
  to a repo-wide search that fails outright on any ambiguous name (multiple
  files exporting the same symbol name).
- `roundtrip=` — repo-relative path to a test file that exists **and** is
  collected by `vitest.config.ts`'s `include` globs. A test that exists on
  disk but isn't collected is a false proof, not a weak one, and resolves as
  "missing".

**The honest ceiling** (stated once here, restated in every module that
computes coverage): a resolving `roundtrip=` proves the named test file
exists and is collected. It does NOT prove the test passes, and it does NOT
prove the test exercises this specific obligation. Citation integrity, not
correctness — write the obligation's prose to explain what the test actually
demonstrates, because the proof comment alone cannot.

Run `bun run proof <symbol> [--file <path>] [--test <path>]` before pasting
any proof comment by hand. It resolves the exact same way `gate:obligations`
will resolve it later (it calls the identical `resolveProofComment` the gate
calls) and either emits the comment ready to paste, or fails with the
specific reason — a non-exported symbol, an ambiguous match, a missing or
uncollected test — so a broken citation is caught at authoring time, not
after allocation.

If no resolving proof can be cited yet — the obligation is real but nothing
exercises it — write `<!-- unverifiable: <why> -->` instead. This is a
legitimate, honest answer (`gate:obligations`' M-C rule requires one or the
other, never silence); it is not a way to skip the section.

## Voice

This corpus writes in a consistent register — match it rather than
introducing a new one:

- **Cite the mechanism, not the vibe.** Name real files, functions, gate
  names, and prior ADR numbers. "The composer validates before admission"
  is weaker than "`task-composer.ts`'s `classifyAndRepairMutatingActions`
  runs inside `confirm()`, before `admission.admit(...)`".
- **State the WHY before the WHAT** in any non-obvious design choice — the
  same convention every gate script in `scripts/` opens its header comment
  with. A future reader without today's context should be able to
  reconstruct the reasoning, not just the resulting shape.
- **Name the roads not taken explicitly**, including ones an earlier draft
  of this same decision considered and rejected — see Alternatives above.
- **Prefer a ratchet to a retroactive demand.** When a new rule would fail
  a large pre-existing corpus, a floor that only tightens (see
  `obligations-gate.ts`'s `POL_04_FLOOR`, `scripts/adr-sections.mjs`'s
  `ALTERNATIVES_FLOOR`) is the house pattern — not exempting the rule, and
  not demanding an unrelated retrofit in the same change.
- **Say the honest limit out loud.** If a check proves less than it sounds
  like it proves (see "the honest ceiling" above), say so in the obligation
  text itself rather than letting the proof comment imply more than it does.
- **Acceptance is a separate, later act** (ADR-059). A freshly-authored ADR
  stays `**Status:** Proposed`; do not set it to `Accepted` in the same
  change that authors it — `bun scripts/adr-registry.mjs accept <number>`
  carries a witnessed operator decision through, it does not make one.
