# ADR-143: Gates Declare Their Language; A Repo Declares Its Languages; Detection Proposes The Rest

**Status:** Accepted
**Date:** 2026-08-27
**Authoring Revision:** 36315784
**Content ID:** sha256:20bb43d916e16c912a296e3cef74dd93a1cc28ebb7ae85aea1d5b908b60af880

## Context

revoy2's governance battery is presented as a general model for governed
autonomous work. It is not general today: it silently assumes TypeScript.

A census of the 51 gates (excluding the `gate:all` aggregator) on 2026-08-27:

| Class | Count | What it reads |
|---|---|---|
| artifact only | 26 | decisions, JSONL stores, git |
| reads the VI graph | 7 | `.visual-intelligence/graph/*` |
| globs source paths | 9 | `packages/**`, `*.ts` |
| parses source | 7 | the TypeScript compiler API |
| unresolved by the census | 2 | `gate:coverage`, `gate:ledger-audit` |

So **26 gates are already language-free by construction**, 7 more inherit
whatever portability their graph producer has, and the genuine coupling is
**16 gates resting on ~5 files**: `vi-extract-ts.mjs`, `vi-lsp-facts.mjs`,
`tui-catalog-parity.mjs`, `anti-stub-rules.mjs`, `scripts/observation/sourcemap.mjs`.

The uncomfortable part is not the count. It is that **nothing says so**. A gate
that parses TypeScript and a gate that reads markdown report the same `PASS`.
Point this battery at a Python repository and most of it goes green while
measuring nothing — the failure mode this repository has repeatedly named as
the worst kind: a safeguard that is documented but not wired, printing
confidence it has not earned.

Two mechanisms needed for the fix already exist and are half-used.

**ADR-073's project profile.** `arbor.profile.jsonc` already declares
`language: "typescript"`, `source_roots`, `citation_roots`, governance paths,
and a `commands` map. The `language` field is essentially unread — declared,
carried, and never dispatched on.

**ADR-090's LSP client.** `scripts/lib/lsp-client.mjs` describes itself as "a
minimal, language-agnostic Language Server Protocol client… adding a language
is pointing this client at that language's server command, not writing a new
extractor." That is exactly the right seam. But `vi-refresh` still runs the
hand-written `vi-extract-ts` as its primary producer (stage 1) and LSP facts as
a supplement (stage 1.5). The agnostic path was built and left as the passenger.

A third force makes this urgent rather than tidy. revoy2 writes code
autonomously. A campaign can introduce a language the profile does not name — a
Rust helper, a Python script, a Go tool — and today nothing notices. The
battery keeps reporting green over source it cannot read. An autonomous harness
that can add a language it cannot govern is a harness whose governance is
optional in practice.

## Decision

**Language support becomes an explicit, declared, checked property of both
gates and repositories, and an undeclared language is a finding rather than
silence.**

1. **Every gate declares the languages it can measure.** A new
   `scripts/gate-manifest.json` maps each gate id to one of:
   `language_agnostic` (reads only artifacts, git, or the graph),
   `languages: [...]` (needs a rule pack per language), or
   `graph_derived` (portable exactly as far as the graph producer is). The
   aggregator refuses to run a gate whose manifest entry is missing, so a new
   gate cannot skip the declaration by omission.

2. **A gate with no pack for a repo's language reports `unsupported`, never
   `PASS`.** This is the load-bearing clause. `unsupported` is a distinct
   third verdict, rendered distinctly, counted distinctly, and it fails the
   battery when the gate is stop-tier. A gate that cannot see is not a gate
   that agrees.

3. **`arbor.profile.jsonc` carries `languages` (plural), not `language`.**
   Polyglot is the normal case — this repository is already TypeScript plus
   shell plus JSONC. Each entry names its LSP server command, its file globs,
   its rule-pack id, and its `commands` (typecheck, test, coverage), extending
   ADR-073's existing `commands` map rather than replacing it.

4. **The LSP client becomes the primary static-fact producer; `vi-extract-ts`
   becomes a TypeScript rule pack behind the same interface.** This inverts
   ADR-090's stage ordering and is what makes the 7 graph-reading gates
   portable for free. The extractor is not deleted: it stays as the TypeScript
   pack and as a cross-check, because a second independent producer is how the
   graph's own accuracy is checkable.

   **The inversion is staged, not flipped.** `vi-extract-ts` remains primary
   while the LSP producer runs alongside it, and every disagreement between the
   two is a finding to be resolved before the flip — as often a finding about
   the extractor as about the server. Only once they reconcile does the LSP
   producer take primacy. Flipping first and verifying afterwards would land
   graph drift in a store seven gates read before anyone understood it; the
   disagreements are not an obstacle to the migration, they are the evidence
   that the resulting graph can be trusted.

5. **Detection is automatic and continuous.** `gate:language-census` walks
   `source_roots`, classifies files by extension and build-manifest presence,
   and compares the observed language set against the declared one. An
   undeclared language above a materiality floor is a finding naming the
   language, the file count, and the first commit that introduced it. This is
   what catches revoy2 writing itself a Rust helper.

6. **Provisioning is automatic; admission is not.** On detecting an undeclared
   language, the harness scaffolds a candidate pack — LSP server command,
   globs, commands, and the rule-pack stub — and registers it in
   **advisory mode**, where it runs and reports but cannot fail the battery.
   Promotion to blocking is an operator decision recorded in the interview
   ledger, exactly as a waiver or an ADR acceptance is.

   The split is deliberate and is the point of the ADR. Scaffolding is
   mechanical and should not wait for a human. But a *silently* self-promoting
   pack would let the harness grant itself governance coverage it has not
   demonstrated — the same shape as a model triaging its own findings, which
   `gate:vi-findings` already refuses. Automatic implementation, governed
   promotion.

7. **A pack declares what it can and cannot answer.** LSP-derived facts
   (symbol existence, definitions, references, call hierarchy, document
   symbols) are standard and port cleanly. Syntactic judgements do not: the
   "is this body real work or a stub?" heuristics in `anti-stub-rules.mjs` are
   shaped by TypeScript's grammar, and a Python `pass` is the same idea in a
   different shape. A pack therefore declares per-capability support, and a
   gate needing a capability the pack lacks reports `unsupported` for that
   repo rather than approximating.

## Consequences

The battery stops overstating itself. Pointed at a Python repository today it
would report a large green majority; under this ADR it reports 26 passes and a
loud `unsupported` count, which is the true answer and the only one from which
someone can act.

Adding a language becomes a bounded, declarative act — a profile entry and a
rule pack — rather than a fork of the gate scripts. That is the property that
makes "a repo's bespoke revoy2 architecture" real rather than aspirational.

The cost is honest and lands on this repository first: inverting the graph
producer is a real migration with a real risk of graph drift, and the
cross-check in Decision 4 exists because of it. Expect the two producers to
disagree initially, and expect those disagreements to be findings about the
extractor as often as about the LSP server.

`unsupported` will appear in this repository too — `anti-stub` over shell
scripts, for instance. That is not a regression; it is a measurement that was
always missing and is now visible.

Detection has a false-positive surface: a vendored fixture or a single example
file in another language should not trigger a pack proposal. Hence the
materiality floor in Decision 5, and hence detection reports rather than
installs.

## Alternatives / Roads not taken

**Leave it TypeScript-only and say so in the README.** Rejected: the battery is
already run against this repository's shell scripts and JSONC, and revoy2
already writes code in languages the profile does not name. The coupling is not
hypothetical, and a README does not stop a gate from printing PASS.

**Rewrite each gate per language.** Rejected as the fork this ADR exists to
prevent — 16 gates × N languages, each drifting independently. The rule-pack
interface exists precisely so the gate logic stays single-sourced.

**Make every gate language-agnostic by weakening it to what all languages
share.** Rejected: it would delete the syntactic judgements that make
`anti-stub` and `closed-enum-hygiene` worth running. A gate reduced to its
lowest common denominator is a gate that no longer catches the defect it was
written for. Per-language depth with honest `unsupported` beats uniform
shallowness.

**Auto-promote a scaffolded pack to blocking once its tests pass.** Rejected:
the pack's tests are written by the same agent that wrote the pack. This is the
self-triage shape `gate:vi-findings` already refuses, and it would let the
harness certify its own governance coverage.

**Infer languages from file extensions alone.** Rejected as insufficient: an
extension census cannot distinguish a vendored fixture from a real source root,
which is why Decision 5 also reads build manifests and requires a materiality
floor.

## Obligations

### O1 — A gate that cannot measure a repository's language says so, and never reports PASS.

Every gate resolves to exactly one of `pass`, `fail`, or `unsupported` for a
given profile, and `unsupported` is produced whenever the gate needs a language
capability the repo's packs do not provide — so a battery run over an
unsupported language reports absence rather than agreement.

<!-- proof: symbol=resolveGateSupport file=scripts/lib/language-support.mjs roundtrip=scripts/tests/language-support.test.mjs -->

### O2 — An undeclared language in the source roots is surfaced, not silently ungoverned.

`gate:language-census` compares observed languages against
`arbor.profile.jsonc`'s declared set and reports any undeclared language above
the materiality floor, naming the language and its file count, so a language
introduced by an autonomous campaign cannot enter the repository ungoverned.

<!-- proof: symbol=undeclaredLanguages file=scripts/lib/language-support.mjs roundtrip=scripts/tests/language-support.test.mjs -->

### O3 — A scaffolded language pack runs in advisory mode until an operator promotes it.

A pack created by detection is registered advisory-by-construction and cannot
fail the battery; promotion to blocking requires a recorded operator decision,
so the harness cannot certify its own governance coverage.

<!-- proof: symbol=scaffoldLanguagePack file=scripts/lib/language-support.mjs roundtrip=scripts/tests/language-support.test.mjs -->
