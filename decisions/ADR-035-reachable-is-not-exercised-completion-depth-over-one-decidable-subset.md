# ADR-035: Reachable Is Not Exercised — Completion Depth Over One Decidable Subset

**Status:** Accepted
**Date:** 2026-08-07

Authored as Proposed, not Accepted: the implementing agent does not hold
acceptance authority (AGENTS.md checks-and-balances, applied to ADR governance
by ADR-024's ratification note), and POL-05 flags any record arriving already
accepted as never having traversed the lifecycle.

## Context

`gate:reachability` answers *"can execution get here."* Nothing answers *"and
then does anything happen."*

A branch guarded on an optional config key that no production composer ever sets
is reachable, covered by tests, exercised by a demo, and permanently dead in the
real process. `.visual-intelligence/README.md` names this the **Hollow** shape
and states plainly that it is *not structurally detectable*, that two instances
existed in this repository, and that **no gate caught either**. The
`revoy2-visual-intelligence` SKILL.md prescribes the only method that has worked
— grep for early-return guards on optional fields, then trace each from the real
production entry points, *"not from construction, and not from tests, which
routinely supply what production does not."* That is a manual method, rerun by
hand, and the halves it does not reach stay open.

A third instance was live when this record was written, and it is not
hypothetical:

```
packages/arbor-opencode/src/loop.ts:555
    const cardSelection = config.task_skills && config.task_skills.length > 0 ? … : …
```

`task_skills` is assigned in exactly two places — `packages/arbor-mcp/src/demo.ts:379`
and `packages/arbor-opencode/tests/loop.test.ts`. `createProductionCampaignRunner`
(`packages/arbor-mcp/src/cli.ts:345-362`) composes the production config from
`DEFAULT_LOOP_CONFIG` plus eight named overrides plus `composeLoopConfigPorts`,
and none of the three sets it. The branch is false on every real run of
`arbor run`.

The first automated scan found **two more of the same shape in the same file** —
`config.panel` (`:755`) and `config.run_reviewer` (`:757`), both assigned only in
`demo.ts` and tests. Neither had been found by hand.

## Decision

**Detect one structurally-decidable subset of Hollow, ship it REPORT-ONLY, and
say exactly what it cannot see.**

1. **The subset.** A guard on `<obj>.<KEY>` — in the condition of an `if`, a
   ternary, or the left operand of `&&`/`||` — where **every** assignment of
   `KEY` in the repository lives in a test file or a demo file, and none in
   ordinary source.

2. **`.completion-depth/findings.jsonl` (committed).** Per finding:
   `{id, guard_file, guard_line, guard_symbol, gating_expression, gating_key,
   setters[], production_setter_count, test_setter_count, demo_setter_count,
   production_reachable_unset, confidence, verdict, verdict_reason,
   first_seen, last_verified, content_hash}`. This generalises
   `anti-stub.mjs`'s inline `TRIAGE` array into a persistent ledger; human
   verdicts survive a refresh, because losing them would re-open every closed
   finding on every run and turn a report-only signal into noise nobody reads.

3. **Confidence.** `high` when a demo file assigns the key — someone wired the
   branch for a demonstration and never for the real path. `medium` when only
   tests assign it, which is weaker: the value may legitimately arrive from
   outside this repository. Never `authoritative` — this is syntax-only
   analysis with no cross-file type resolution.

4. **REPORT-ONLY, and blocking does not turn on at ship time.**
   `gate:anti-stub`'s own first run produced 10 findings of which 9 were false
   positives, and it defaults REPORT-ONLY for exactly that reason. Claiming
   day-one blocking for an untriaged heuristic would recreate that. Blocking on
   new `high`/`medium` untriaged findings is a later decision, to be taken only
   with triage evidence in hand.

   **Post-adoption ratchet (2026-08-08).** That later decision has now been
   taken: the complete baseline was reviewed and every finding received a
   reasoned verdict. `gate:completion-depth` therefore fails immediately on a
   new untriaged finding. It still compels a verdict, not a fix.

5. **Syntax only, on purpose.** `ts.createSourceFile`, not a type-checked
   `ts.Program` — the same scoping `anti-stub.mjs` chose, which keeps the scan
   cheap enough to run at pre-push.

### What this cannot see, stated rather than discovered

A key set to a falsy value; a key set behind another dormant branch; a
mocked-but-present dependency; a guard on anything other than a property access;
a value produced outside this repository. That last one is not theoretical — the
first scan flagged `specResult.needs_input` (`loop.ts:699`), which is a field on
a **result type** produced by the opencode executor, a process this repository
does not contain. It is triaged `false_positive` with that reason recorded, and
it is the heuristic's blind spot working exactly as documented.

**This is not a general Hollow detector, and must not be described as one.**
`.visual-intelligence/README.md`'s statement holds everywhere outside the subset
above.

## Consequences

**Positive.** The three-instance backlog is now a durable, machine-refreshed
record instead of a manual grep rerun from memory. Two of the three confirmed
findings (`panel`, `run_reviewer`) had never been found by hand at all. A
regression that re-introduces the shape will be reported the next time the gate
runs, rather than waiting for the next audit.

**Historical baseline.** The initial scan contained 11 findings, of which 4
were triaged and 7 initially remained untriaged. The medium-confidence ones
were exactly the ambiguous class —
`estimateTokens`, `held`, `paste`, `persistAbandonment`,
`persistRetryTransition`, `raw_output_authorization`, `structural_context` —
where the value plausibly arrives from an injected collaborator. The current
committed store is authoritative; all surviving findings now carry reviewed
verdicts, enabling the post-adoption ratchet above.

**Negative.** The `test`/`demo` classification is path-based
(`**/tests/**`, `*.test.ts`, `**/demo.ts`). A demo living somewhere unusual, or
production code under a path that looks like a test, defeats it silently.

**Negative.** The scanner remains heuristic. Blocking only on the absence of a
human verdict limits false denials: it compels triage, not remediation, while
the committed store makes every decision reviewable and expirable.

**Negative.** The three confirmed findings are **reported, not fixed.** Whether
`task_skills`, `panel` and `run_reviewer` should be wired into the production
composer or deleted is a product decision about whether those features are
wanted, and it belongs to whoever owns the loop — not to the author of the gate
that found them.

## Alternatives considered

1. **Extend `gate:anti-stub` with a sixth rule.** Rejected: anti-stub's five
   rules are single-file syntactic shape checks. This needs a whole-repository
   assignment index, which is a different analysis with a different cost, and
   folding it in would make one gate's runtime unpredictable.

2. **Use a type-checked `ts.Program` and real dataflow.** Would raise confidence
   and catch the falsy-value and injected-collaborator cases. Rejected for v1 on
   cost: it makes the scan too slow for pre-push, and the cheap version already
   found three real instances including two nobody had found by hand. Revisit if
   triage shows the medium band is mostly false positives.

3. **Block on `high`-confidence findings from day one.** Rejected — see decision
   point 4.

4. **Consume the `.visual-intelligence/` graph for production reachability
   instead of path heuristics.** Attractive, and the right long-term join. Not
   done here because the graph's `reachable_from` cannot distinguish `demo.ts`
   (genuinely reachable from `cli.ts`) from the production campaign path, which
   is the exact distinction this needs. Solving it properly requires the
   per-entry-point reachability the graph does not currently model.

   **BUILT 2026-08-19, twelve days after this alternative was rejected.**
   `scripts/entrypoint-reachability.mjs` provides exactly this: one walk per
   declared root over the committed graph, so "reachable from A but not B" is
   now answerable. Measured on this repository, 262 nodes are reachable from
   neither CLI root's production path — 239 of them the arbor-eval harness
   surface — which is the demo-versus-production distinction this alternative
   named. It is a separate module rather than a change to this record's
   detector, and completion-depth does not consume it yet; wiring the two is
   open work, not a claim made here. Recorded so that a reader arriving at this
   alternative learns the capability exists rather than that it is impossible.

## Obligations

### O1 — A guard whose key is assigned only by tests or demos is reported

<!-- unverifiable: scripts/completion-depth.mjs exports collectGuards/collectSetters (the syntactic primitives, tested), but the test/demo/production classification and verdict emission this obligation asserts run in its unexported main(); no single exported symbol witnesses the full claim. -->

**Re-anchored 2026-08-19, because the original anchor was a first-run count
rather than a durable property.** The store holds 8 findings today, every one
of them the shape this obligation describes: a guarded key with
`production_setter_count: 0` and a non-zero test or demo count. A current
example is `estimateTokens`, a port method inside
`packages/arbor-mcp/src/loop-adapters.ts`
(0 production setters, 3 test setters). The count moves as the codebase moves;
the property is what this obligation asserts, and it is checkable at any time
via `bun scripts/completion-depth.mjs --json`.

### O2 — The confirmed instance that motivated this record is detected

<!-- unverifiable: the task_skills instance this obligation names was fixed in production (cli.ts:552-557) and no longer exists to detect, so the claim as literally written cannot be re-verified against its own anchor. -->

`loop.ts:555` / `task_skills` is found at `high` confidence and triaged
`confirmed_hollow` with the production-composer evidence recorded.

**Anchor resolved, obligation now unreproducible (verified 2026-08-18).** The
findings store today holds zero `confirmed_hollow` records and no `task_skills`
entry, because the Hollow condition itself was fixed:
`packages/arbor-mcp/src/cli.ts:552-557` now genuinely sets `task_skills`,
`panel` and `run_reviewer` in the production composer. The detector correctly
dropped the finding when the defect went away. This obligation as literally
written therefore cannot be re-verified — not because the mechanism regressed,
but because its evidentiary anchor was repaired. Recorded rather than rewritten
to point at some other finding, which would be inventing evidence.

### O3 — Human triage verdicts survive a refresh

<!-- unverifiable: the verdict-carry-forward logic lives in scripts/completion-depth.mjs's unexported main(), not behind any of the file's 4 exported symbols. -->

**Re-anchored 2026-08-19.** All 8 findings in the store carry a `verdict`, a
`verdict_reason` and a `triage_expires`, and have survived many `--refresh`
cycles across this session's work — the preservation path is
`scripts/completion-depth.mjs`'s verdict-carry-forward, which re-derives the
finding set and re-attaches recorded verdicts by gating key. This obligation
is the reason a refresh is safe to run at all: without it, regenerating the
store would silently discard every human decision in it.

### O4 — The gate blocks on an UNTRIAGED finding, never on an unfixed one

<!-- unverifiable: the blocking-on-untriaged exit-code logic lives in scripts/completion-depth.mjs's unexported main(), not behind any of the file's 4 exported symbols. -->

**CORRECTED 2026-08-19. The previous text — "the gate does not block;
`gate:completion-depth` prints REPORT-ONLY and exits 0 regardless of findings"
— was false**, and had been for some time before anyone read it against the
code. `scripts/completion-depth.mjs` reports `mode: "blocking-on-untriaged"`
and sets `process.exitCode = 2` when a finding is untriaged past its deadline.
The record is corrected rather than the gate, because the gate's behavior is
the one that is right: a finding nobody has looked at is exactly the thing an
end-condition check should refuse to let pass.

What the gate does NOT do, and this is the distinction the original text was
reaching for: it never blocks because a finding is unfixed. A recorded verdict
— `false_positive` or `accepted_tradeoff`, with a reason and an expiry —
clears it. Judgment is required; agreement is not. Live today: 8 findings, 0
untriaged, `ok: true`, so the gate passes while nothing has been "fixed".

### O5 — A value produced outside this repository is not reported as a defect once triaged

<!-- unverifiable: the triage-persistence logic this obligation depends on lives in scripts/completion-depth.mjs's unexported main(), not behind any of the file's 4 exported symbols. -->

**Re-anchored 2026-08-19.** The original instance (`specResult.needs_input`)
is gone from the store, but the property has current instances of exactly the
same shape: `verifyOutcome`, a port method inside
`packages/arbor-mcp/src/integrations/claude-code-campaign.ts`, and the
`"paste"` `InputResult` discriminant kind
inside `packages/arbor-tui/src/input-catalog.ts` are both triaged
`false_positive` with recorded reasons, and both persist across refreshes.
Host-capability and external-tool values are the recurring case this
obligation exists for.

**Anchor no longer present (verified 2026-08-18).** No `needs_input` entry
remains in the findings store. The persistence property this obligation asserts
is still exercised by the 8 findings currently triaged with 0 untriaged, but
the specific instance named here is gone, so O5 cannot be re-verified against
its own cited anchor.
