# ADR-132: The Exploration Term's Axis Is Probably The Wrong Question

**Status:** Accepted
**Date:** 2026-08-27
**Authoring Revision:** 3e7ffa215cf325197b8f0065d2df1e48470650b6
**Content ID:** sha256:167ee2997555adf1a97832e2711fb4ce93019617e53f87264de62475c17dc1ac

## Context

`packages/arbor-core/src/scoring.ts`'s production (`classic`) exploration
term is `C·√(ln N / (1 + n_cat))` — the denominator counts visits **per
category** (`categoryVisits`, keyed by `action.category`), not per node or
per edge. The initial suspicion behind this ADR was that this is a defect:
UCB1 in its textbook and MCTS forms counts visits to the specific
state-action pair being scored, and pooling many distinct candidate actions
into one shared category-visit count means an underexplored *specific*
action can still look "well-explored" merely because siblings sharing its
category were tried.

**A frontier literature check changes the question, not just the answer.**
Both purpose-built agent-tree-search papers this repository already cites
abandon UCB1-style visit counting entirely, not just its axis:

- **Tree-GRPO** (arXiv 2509.21240, cited in `decisions/ADR-002-*.md`'s
  2026-08-12 amendment) scores via group-relative advantage over
  shared-prefix rollouts — an RL/GRPO comparator, not a UCB exploration
  bonus at all. There is no visit-count term to have an axis.
- **Koh et al.** (arXiv 2407.01476, *Tree Search for Language Model
  Agents*) drives selection with a value model scoring the actual
  environment state reached by each candidate — best-first search guided
  by a learned value estimate, again not a UCB visit-count formula.

Neither paper counts by category or by edge, because neither uses a
UCB-family term as its primary selection signal at all. Fixing `n_cat` to
`n_edge` — the fix the initial "defect" framing implies — would still leave
this repository's selection resting on a UCB1 exploration bonus, a family
of formula the two papers actually built for *this exact problem* (agentic
tree search over LLM-generated actions, not board games) have both moved
past. The candidate fix and the status quo are two points on the same
axis; the frontier is a different axis.

**A factual correction to `scoring.ts`'s own citations, verified against
the primary source, not assumed.** `scoring.ts:2` reads:

```
// Clean-room from Arbor paper §4 (arXiv 2606.12563v1), formula independently implemented.
```

and the docstring above `scoreActionWithPolicy` (`scoring.ts:58-67`)
describes `agent_uct` mode as implementing "the paper's selection term,"
positioning `classic` as the production formula that diverges from the
paper and `agent_uct` as the paper-faithful alternative — a framing
`decisions/ADR-106-*.md` repeats explicitly, calling `agent_uct` "a
paper-cited" mode and describing the split between it and `classic` as one
the source "describes... itself."

This ADR's author fetched the primary source (`arxiv_get` +
`arxiv_fetch`/direct PDF read via the `frontier` MCP, arXiv 2606.12563v1,
*Arbor: Tree Search as a Cognition Layer for Autonomous Agents*, Prakriya
et al., AMD Training and Inference Optimization Team) and read the
relevant section directly, rather than trusting the in-repo comment or the
task brief's claim about it. Findings, page-and-section verified:

1. **The paper's scoring equation lives in §3.2 ("Heuristic Tree Search"),
   not §4.** §4 of the paper is titled "Experiments" — setup, main
   results, and an ablation study — and contains no scoring formula at
   all. `scoring.ts:2`'s "§4" citation is simply the wrong section number.
2. **The paper's equation (1), reproduced verbatim from the PDF, is:**
   `h(a) = [g(a)/c(a)]·(1−r_acc)·(1−r_crash)·m_gap + C√(ln N / (1+n_cat))`
   — category-pooled `n_cat` in the denominator, exactly as `scoring.ts`'s
   `deriveClassicScoreTerms` implements it, and exactly as
   `decisions/ADR-002-*.md`'s Decision section already states ("Use the
   Arbor paper's published formula (arXiv 2606.12563v1 §4)... `C ·
   √(ln N / (1 + n_cat))`" — ADR-002 has the same wrong section number but
   the right formula). **This repository's own `classic` mode is the
   paper's formula.**
3. **The paper contains no per-edge, per-state-action visit-count formula
   anywhere.** A search of every equation and section in the fetched PDF
   turns up exactly one scoring formula, §3.2's equation (1). There is no
   `N(s,a)` or edge-local visit count for `agent_uct`'s
   `scoreAgentUct` — `\hat{Q}_t(s,a) + C·√(ln(N_t(s)+1)/(N_t(s,a)+1)) −
   λ_t·ΔĈ_t(s,a)` with decaying `λ_t = λ_0/√t` — to be faithful *to*.
   That formula, and its cost-decay regularization term, do not appear in
   the paper at all.

**This finding directly contradicts the framing in `scoring.ts`'s own
docstring and in `decisions/ADR-106-*.md`.** Production `classic` is not a
divergence from the paper's formula; it IS the paper's formula, modulo a
wrong section number. `agent_uct`'s per-edge `N(s,a)` term and its
decaying-λ cost regularization are Arbor-**team**-original — this
repository's own extension, not a reproduction of anything in arXiv
2606.12563v1. The task brief that motivated this ADR reported a researcher
citing this correction against "§3.2," which matches what direct reading
confirms; this ADR's own independent read of the primary source reaches
the same section and the same conclusion by an independent path, so the
correction is **confirmed**, not merely relayed.

## Decision

**1. `scoring.ts`'s citation and framing are corrected to match the
primary source, in a follow-up change this ADR authorizes but does not
itself make** (this ADR's file ownership is limited to ADR authorship; the
correction lands in `packages/arbor-core/src/scoring.ts`, which belongs to
whichever pass implements this decision). The corrected text should say,
in substance:

   - `scoring.ts:2`'s citation becomes "Clean-room from Arbor paper §3.2,
     eq. (1) (arXiv 2606.12563v1)" — the section fix alone.
   - The `scoreActionWithPolicy` docstring (`:58-67`) stops calling
     `agent_uct` an implementation of "the paper's selection term." It
     should instead state plainly that `classic` (`deriveClassicScoreTerms`)
     implements the paper's actual §3.2 formula, and `agent_uct`
     (`scoreAgentUct`) is this repository's own extension — a per-edge
     visit-count and cost-decay-regularized variant with no counterpart in
     the cited paper — kept eval-only specifically so that difference is
     never silently absorbed into production selection.
   - `decisions/ADR-106-*.md` is Accepted and, per this repo's ADR
     discipline (§8 of the global conventions: "once accepted, an ADR is
     effectively immutable"), is not rewritten. Its "paper-cited `agent_uct`
     mode" characterization is superseded by this ADR's finding, not edited
     in place; a reader following ADR-106 to this ADR gets the corrected
     attribution.

**2. The next experiment on selection is a third, eval-only scoring arm —
value-model-guided (Koh et al.-style) or group-relative
(Tree-GRPO-style) — not a migration of `n_cat` to `n_edge` within the
existing UCB1 family, and not a promotion of `agent_uct` to production.**
Both frontier papers replace the UCB-visit-count family outright rather
than reindexing it; a same-family fix (category → edge) answers a question
("is the axis wrong?") the literature suggests is no longer the live
question ("is UCB1-family selection itself the right family, for this
problem?"). This decision does not resolve that question — ADR-095/the
companion live-ablation ADR's efficacy measurement is a precondition for
spending more selection-tuning effort at all — but it does set the shape
of the next selection experiment once that precondition is met: a new
`ScorePolicy` mode alongside `classic` and `agent_uct`, exercised only
through `arbor-eval`'s eval lanes exactly as `agent_uct` already is,
compared against both existing modes on the same live-ablation instrument.
`DEFAULT_SCORE_POLICY` stays `{ mode: "classic" }` throughout — this
Decision does not change what any production campaign selects.

## Consequences

**Positive:** `scoring.ts` stops asserting a factually backwards
provenance story about its own two modes — a reader (including a future
agent doing clean-room verification) who trusted the current comment would
conclude the opposite of what the primary source says. Correcting it
removes a live source of misattribution before it propagates further (it
already propagated once, into ADR-106's prose). Naming the next
experiment's shape now (a third eval-only arm, not an in-family tweak)
prevents a plausible-looking but frontier-inconsistent change — `n_cat` →
`n_edge` — from landing as the "obvious" fix the moment someone next
touches `scoring.ts` for this reason.

**Negative:** This ADR explicitly does not fix the exploration term. Team
members who read this ADR's title expecting a formula change get a
correction and a scoping decision instead. That is deliberate: neither
frontier paper gives a drop-in replacement formula this repository could
adopt today without its own eval-lane work (the value model in Koh et al.
is trained on that paper's web-agent environment; Tree-GRPO's
group-relative advantage presumes an RL training loop this repository does
not run), so committing to either now, without building and evaluating an
eval-only arm first, would repeat the exact pattern the companion ADR
(measure efficacy before tuning) exists to stop.

**Neutral:** `agent_uct` remains exactly what it was — an eval-only,
Arbor-team-original scoring mode, not driving any production campaign.
Nothing about `DEFAULT_SCORE_POLICY`, `manager.ts`'s call sites, or
`agent_uct`'s existing test coverage changes as a result of this ADR.

## Alternatives / Roads not taken

**Fix the axis: change `categoryVisits` to a per-node or per-edge visit
count within the existing UCB1 formula.** Rejected as the next move,
though not because it is wrong on its own terms — pooling distinct
candidate actions by category IS a real deviation from textbook UCB1's
per-state-action counting, and a future in-family cleanup may still be
warranted for that reason alone. Rejected *here* because the literature
survey that motivated re-examining this term found no purpose-built
agent-tree-search paper still using visit-count-based UCB1 at all; treating
"which visit count" as the open question when the frontier's open question
is "visit-count-based selection at all" would spend the next round of
selection-tuning effort on a family the state of the art has already moved
past.

**Promote `agent_uct` to `DEFAULT_SCORE_POLICY` now, since it is closer to
a per-edge formula than `classic`.** Rejected on two grounds. First, per
this ADR's Context, `agent_uct` is not "closer to the paper" — it has no
correspondence to the paper at all, so promoting it on paper-fidelity
grounds is promoting it on a false premise. Second, and independent of the
first: `agent_uct` has never been evaluated against `classic` on real
tasks (the companion ADR's point), so promoting it to production would be
exactly the kind of tuning-without-measurement this repository is trying
to stop, regardless of which formula is "more correct" on paper.

**Leave the mischaracterization in `scoring.ts` and `decisions/ADR-106-*.md`
uncorrected, since ADR-106 is Accepted and nominally immutable.** Rejected:
§8's immutability rule protects a *decision* from being silently rewritten
after acceptance, not a *factual claim* about an external paper from being
corrected once verified against the primary source. `scoring.ts`'s comment
is not an ADR at all and carries no such protection, and this ADR is itself
the mechanism §8 provides for recording a correction — a new decision that
supersedes the prior characterization — rather than an edit to ADR-106's
text.

## Obligations

### O1 — Production `classic` scoring (`deriveClassicScoreTerms`) is a category-pooled UCB bonus, `C·√(ln N / (1 + n_cat))`, matching arXiv 2606.12563v1 §3.2 equation (1) exactly, confirmed by direct primary-source reading for this ADR

Verified by fetching and reading the paper's PDF directly (§3.2, equation
1, page 4 of the arXiv v1 PDF) rather than trusting the in-repo citation.
This is a claim about an external document's content, not a property of
this repository's runtime behavior a vitest roundtrip can exercise — the
existing `scoreAction`/`deriveClassicScoreTerms` formula-shape obligation
is already covered by `decisions/ADR-002-*.md`'s O1, which this ADR does
not duplicate.

<!-- unverifiable: claim is about the content of an external primary source (arXiv 2606.12563v1 §3.2), confirmed by direct PDF reading for this ADR, not a repository behavior a roundtrip test can check -->

### O2 — `scoring.ts:2`'s "§4" citation and the `scoreActionWithPolicy` docstring's "agent_uct implements the paper's selection term" framing are corrected to match the primary source

Decision §1 specifies the corrected text. The correction itself is
follow-up implementation work in `packages/arbor-core/src/scoring.ts`,
outside this ADR's file ownership (this pass owns only the two ADR
documents named in its brief) — recorded here as the obligation the
follow-up change must satisfy, not yet closed by it.

<!-- unverifiable: names a correction to packages/arbor-core/src/scoring.ts's comments that this ADR's authoring pass is not authorized to make (file ownership is limited to ADR documents this cycle); not yet implemented -->

### O3 — `DEFAULT_SCORE_POLICY` still gates production selection to `classic` mode; this ADR does not promote `agent_uct` or any new mode to production

`DEFAULT_SCORE_POLICY = { mode: "classic" }` (`packages/arbor-core/src/types.ts`)
remains the default `scoreActionWithPolicy` uses when no explicit policy is
passed, and no call site in `manager.ts` or `loop.ts` passes an explicit
`agent_uct` (or other) policy — unchanged by this ADR, and exercised by
`scoring.test.ts`'s existing `scoreActionWithPolicy` coverage of both the
default-classic path and an explicit `agent_uct` policy.

<!-- proof: symbol=DEFAULT_SCORE_POLICY file=packages/arbor-core/src/types.ts roundtrip=packages/arbor-core/tests/scoring.test.ts -->
