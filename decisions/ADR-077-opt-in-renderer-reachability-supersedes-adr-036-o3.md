# ADR-077: Opt-In Renderer Reachability Supersedes ADR-036's O3 Unreachability Obligation

**Status:** Accepted
**Date:** 2026-08-18
**Authoring Revision:** 4418c757a725bf771d0fee5b870a921600b03265
**Content ID:** sha256:d687fdc6995dee5922d886ffb3f325c1fb1100b46e1a98b66fd24faf7d43e6f2

Authored as Proposed, not Accepted: the authoring change does not hold its own
acceptance authority (ADR-059).

**Scope.** This record supersedes only ADR-036's obligation **O3**
(`decisions/ADR-036-opentui-supersedes-adr-011s-provisional-ink-renderer-decision.md`).
ADR-036's Decision, Consequences, Alternatives, and obligations O1, O2 and O4
are untouched, as is ADR-037 in full.

## Context

ADR-036's O3 reads: *"`OpenTuiRenderer` is not reachable from the production TUI
entry point in this pass."* It is an obligation asserting an **absence**, and
the record says so explicitly — it carries no proof comment because
`packages/arbor-governance/src/obligation/parse.ts`'s `symbol=`/`roundtrip=` shape "names a thing that exists,
not a search that found nothing."

That absence has since been filled, deliberately and under authority:

- `packages/arbor-mcp/src/tui.ts:26` imports `OpenTuiRenderer`; `:198`
  constructs one inside `createRenderer()`.
- `packages/arbor-tui/src/index.ts:173` exports it from the package barrel.
- Selection is explicit opt-in: `ARBOR_TUI_RENDERER=opentui` or
  `TuiLaunchOptions.renderer: "opentui"`, gated to the Bun runtime, falling back
  to `StdoutRenderer` under Node (`tui.ts:176-209`).
- `docs/tui-wave2-plan.md` Lane G authorized it: *"make the OpenTUI renderer
  reachable."*

ADR-036 anticipated this exactly. Its Decision item 2 said a future record
"should add the barrel export and the `tui.ts` wiring together, once
`feat/bun-runtime-migration` has made Bun the whole repository's runtime." The
Bun migration landed and wave 2 did both.

So O3 is not wrong about the past — it was true when written — but it is false
now, and an obligation that is false is not a thing a reader can rely on. An
obligation asserting an absence has a failure mode a positive obligation does
not: it silently inverts the moment the absence is filled, and nothing in the
proof machinery can detect that, because there is no citation to resolve. That
is why this needs a superseding record rather than a body edit: ADR-036 was
corrected in place to describe what happened, but the **obligation itself**
still stands as a commitment the repository no longer keeps.

## Decision

**ADR-036's O3 is superseded. The commitment it encoded is restated as a
positive, checkable property: `OpenTuiRenderer` is reachable from the production
TUI entry point only by explicit opt-in, and `StdoutRenderer` remains the
default.**

The substance ADR-036 cared about was never "the symbol must be unreachable."
Reading its Decision item 2, the concern was concrete: exporting the class from
the public barrel would make every Node-hosted consumer of `@arbor/tui`
transitively import `@opentui/core`, a package they could not safely construct
on their runtime. That concern is real and still governs — it is now satisfied
by the runtime gate and the Node fallback rather than by absence.

Restating it positively is strictly better governance. "This symbol has no
caller" cannot be proven by a proof comment and rots invisibly. "This symbol is
reachable only under an explicit flag, and the default is unchanged" names
things that exist, can carry a proof citation, and fails loudly if someone makes
the opt-in the default.

## Consequences

**Positive:**

- The corpus stops carrying a false obligation. ADR-036 becomes acceptable on
  its remaining obligations, which are all true.
- The property that actually matters — an operator who does not opt in sees no
  behavior change — becomes machine-checkable rather than implied.

**Negative:**

- An operator who *does* opt in now depends on `OpenTuiRenderer`'s exact visual
  output, which ADR-037's Consequences argued nobody did. That argument rested
  on O3 and no longer holds. The per-pane composition has not been re-examined
  against a live terminal since the wiring landed; this record does not claim it
  has, and does not resolve whether that composition is the right thing to ship
  on the opt-in path.

**Neutral:**

- No code changes. This record describes a state the repository already reached
  through authorized work; it changes what the corpus commits to, not what runs.

## Obligations

### O1 — The default renderer is unchanged by the opt-in path existing

<!-- proof: symbol=runTui file=packages/arbor-mcp/src/tui.ts roundtrip=packages/arbor-mcp/tests/tui.test.ts -->

With no `ARBOR_TUI_RENDERER` set and no explicit `renderer` option, the
production entry point selects `StdoutRenderer`. An operator who never opts in
observes exactly what they observed before ADR-036's renderer was wired.

### O2 — Selection is explicit, and unavailability degrades rather than throwing

<!-- proof: symbol=OpenTuiRenderer file=packages/arbor-tui/src/opentui-renderer.ts roundtrip=packages/arbor-tui/tests/opentui-renderer.test.ts -->

`OpenTuiRenderer` is constructed only when explicitly requested, and only under
Bun; a Node host that asks for it falls back to `StdoutRenderer` rather than
failing at import or construction time. The renderer itself remains proven
against `@opentui/core/testing`'s real native test renderer, unchanged from
ADR-036's O1.

## Test implications

- Launching with no renderer preference yields `StdoutRenderer`.
- Requesting `opentui` under Node yields `StdoutRenderer`, not a throw.
- The barrel export does not cause a Node-hosted consumer of `@arbor/tui` to
  fail — the transitive-import concern ADR-036 raised is testable directly.
