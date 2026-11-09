# ADR-036: OpenTUI Supersedes ADR-011's Provisional Ink Renderer Decision

**Status:** Accepted
**Date:** 2026-08-07

Authored as Proposed, not Accepted: the implementing agent does not hold
acceptance authority (AGENTS.md checks-and-balances, applied to ADR governance
by ADR-024's ratification note), and POL-05 flags any record arriving already
accepted as never having traversed the lifecycle.

**Scope.** This record supersedes only ADR-011's "Renderer decision" section
(`decisions/ADR-011-tui-cockpit-architecture.md:46-52`). ADR-011's Decision,
Consequences, Alternatives, and O1-O5 obligations are untouched — the
Elm-style model/update/effect core they describe is not in question here, and
this record does not re-litigate it.

## Context

### ADR-011 named a renderer it never shipped

ADR-011's "Renderer decision" reads, in full: *"Use Ink provisionally behind a
renderer port because it supports the repository's Node/TypeScript execution
model and headless stream injection with lower native packaging risk. This is
not permission for component-owned I/O. OpenTUI may be reconsidered only after
an isolated compatibility/performance spike proves its runtime, native
artifact, CI, teardown and deterministic-test requirements."*

**VERIFIED, by direct inspection of this repository:** there is no `ink`
dependency in any `package.json` in this repository (`grep -r '"ink"'
packages/*/package.json` — no hits), and no reference to Ink anywhere in
`packages/arbor-tui/src` or `packages/arbor-mcp/src/tui.ts`. The renderer that
actually ships (`packages/arbor-tui/src/renderer.ts:36-57`'s `renderScene`) is
a from-scratch, headless `string[][]` canvas: `layoutWorkspace` computes pane
rectangles, `drawPane`/`put` write cell-width-aware glyphs directly into the
grid (`renderer.ts:150-183`), and `StdoutRenderer` (`renderer.ts:197-242`)
diffs joined row strings and repaints only changed rows. This is a fourth
path — not Ink, not OpenTUI, and not named or authorized by ADR-011 at all.

This is the load-bearing finding of this record, stated plainly because the
mechanism that let it happen is itself instructive: ADR-011's obligation O4
(*"Rendering is an adapter behind a pure renderer contract... The renderer can
be replaced or driven headlessly without touching the model/update core"*,
proof `symbol=RendererPort file=packages/arbor-tui/src/renderer.ts
roundtrip=packages/arbor-tui/tests/renderer-shell.test.ts`) **stayed true** —
the port abstraction is real, tested, and exactly what it claims to be — while
the renderer *choice* the Decision section named silently stopped matching. A
proof comment that attests the seam, not the implementation behind it, cannot
detect the implementation drifting out from under it. Whether ADR-011's named
compatibility/performance spike gate was ever run and the ADR simply never
updated, or was skipped entirely, is **INDETERMINATE** from static reading —
resolving it would need git/PR archaeology outside this record's scope, and it
does not change the disposition below either way: what ships today is
undocumented regardless of how it got that way.

### The empirical case for OpenTUI now

Measured on this machine, same script, same package version, ahead of any
implementation decision (`docs/bun-migration-plan.md`):

| Runtime | Result |
|---|---|
| Node 22.23.2 | `Failed to initialize OpenTUI render library: OpenTUI native FFI is not available for this runtime yet` |
| Bun 1.3.14 | renders correctly |
| vitest launched via `bun x` | same FFI failure — vitest executes tests in Node workers |
| `bun test` | passes |

`@opentui/core` at the `0.5.1` version pinned during this investigation (since bumped to `@opentui/core@0.5.3`) *imports* cleanly under Node (267 exports resolve; no
top-level native call in the module graph) and only fails when the render
library binds — a partial migration would look healthy until the first draw.
The vitest row is decisive on its own: OpenTUI is untestable in this
repository's committed harness (`vitest.config.ts`) even with Bun driving
vitest, because vitest's own worker model runs under Node regardless of which
binary invokes it. Adopting OpenTUI is therefore not a per-package renderer
swap; it forces the whole repository's runtime to Bun, which is
`feat/bun-runtime-migration`'s subject, not this record's.

This record's job is narrower: given that migration is already decided
elsewhere, does OpenTUI replace the from-scratch renderer once Bun is the
runtime — and does the existing `RendererPort` seam actually accept it?

### `RendererPort`'s contract, tested against a structurally different backend

`RendererPort` (`packages/arbor-tui/src/renderer.ts:17-21`) is:

```ts
export interface RendererPort {
  enter(): void | Promise<void>;
  render(frame: string): void | Promise<void>;
  restore(): void | Promise<void>;
}
```

`OpenTuiRenderer` (`packages/arbor-tui/src/opentui-renderer.ts`, this record's
companion artifact) implements it against `@opentui/core`'s `CliRenderer`: a
single full-viewport `TextRenderable` receives each frame string, and
`enter()`/`restore()` own the renderer's lifecycle. It is exercised by
`packages/arbor-tui/tests/opentui-renderer.test.ts` under `bun test`, against
`@opentui/core/testing`'s `createTestRenderer` — a **real** native renderer in
test mode, not a mock standing in for one — asserting literal strings
(`"┌─ Cockpit"`, a real content marker) read back out of `captureCharFrame()`,
the same "assert on real rendered output" bar
`packages/arbor-mcp/tests/tui-operator-controls.test.ts` already sets for this
repository's TUI tests. All 5 assertions pass (`bun test
packages/arbor-tui/tests/opentui-renderer.test.ts`: `5 pass, 0 fail, 12
expect() calls`).

**Verdict: O4's claim holds, literally.** `OpenTuiRenderer` required zero
changes to `types.ts`, `update.ts`, `model.ts`, `navigation.ts`, or any
screen — only a new file implementing the existing three-method interface.
The port is genuinely renderer-agnostic in the sense O4 states.

**But the honest, more valuable finding is what O4 does not say, and what
adopting OpenTUI actually buys.** `RendererPort.render` takes one flattened
`string` — by the time a frame reaches this boundary,
`renderTerminalFrame`/`TerminalPainter` (`renderer.ts:60-73`, `painter.ts:
55-63`) have already discarded every trace of structure: which characters
belong to which pane, where the status bar row starts, where a wide glyph's
continuation cell sits. `OpenTuiRenderer` can only hand that opaque blob to a
single `TextRenderable` — it cannot register per-pane hit regions for mouse
support, cannot delegate to `ScrollBoxRenderable`'s native scroll handling, and
cannot get retained-tree diffing on individual widgets, because the structure
those `@opentui/core` primitives operate on never crosses `render(frame:
string)`. **A framework swap behind this exact port cannot close IQ-01
(mouse), and only a shallow reading of `audit/tui-remediation-
presentation.md` §6 would conclude otherwise** — that document's own §6
already independently reaches the same conclusion by a different route
(no retained layout tree survives to hit-test against) and adds the sharper
data point that opencode's own `ScrollBoxRenderable.scrollChildIntoView` — the
single best argument for "the framework gives you this for free" — is not
even used by opencode's own call sites, which hand-roll the same scroll-clamp
arithmetic three times instead. Realizing OpenTUI's structural advantages
would require widening `RendererPort` to pass a structured scene (panes,
regions, a widget tree) instead of a pre-joined string — a materially bigger,
separately-scoped change this record does not authorize.

A second, narrower honest limitation: `TextRenderable.content` accepts a
`StyledText | string`; a plain string is displayed literally, not
ANSI-parsed. `renderer.ts` embeds SGR sequences in a frame only when
`FrameOptions.color === true` (`status-bar.ts`'s palette codes, ADR-020, plus
`TerminalPainter`'s outer reset wrap). `OpenTuiRenderer` therefore renders
**uncolored** frames faithfully and would show a colored frame's escape bytes
as literal characters — `@opentui/core` ships no ANSI-to-`StyledText` parser,
and this record does not add one.

### A cross-cutting finding, surfaced and then resolved mid-verification

Proving `@opentui/core` for real required `bun install` after adding it to
`packages/arbor-tui/package.json`. At the point that install first ran, no
`bunfig.toml` pinned a linker, so Bun used its default **isolated** linker —
which migrated this repository's node_modules away from the npm-era flat,
hoisted layout (the prior layout was backed up locally to
`node_modules/.old_modules-<hash>`, since garbage-collected by a later
idempotent install) and does not create `node_modules/@arbor/<name>`
symlinks for a workspace dependency a package does not **declare**. Two
packages' source imports outran their own declared dependencies under that
layout: `packages/arbor-mcp/src/{cli,demo,loop-ports-helper,
opencode-executor,opencode-server-executor,recovery-lease-adapter,
selfhost}.ts` import `@arbor/opencode`, absent from
`packages/arbor-mcp/package.json`'s dependencies (`@arbor/audit, config,
core, gate, governance, kb, tui, prompts` only); `packages/arbor-opencode/
src/{agents,canonical-adapter,categories,communications,critics,loop,
output-boundary,token-economy-boundary}.ts` import
`@arbor/core`/`@arbor/mcp`/`@arbor/audit`, absent from
`packages/arbor-opencode/package.json`'s dependencies (`@arbor/prompts,
config` only). Under the isolated linker this failed `tsc --build`
(`Cannot find module '@arbor/opencode'`/`'@arbor/core'`, etc.) — a
repository-wide breakage this record's own verification triggered but did
not cause.

By the time this record's verification finished, `feat/bun-runtime-
migration`'s runtime/package-manager lane had landed `bunfig.toml` with
`linker = "hoisted"`, pinning Bun to the npm-equivalent flat layout and
explicitly documenting the same isolated-linker trap this record hit
independently (`bunfig.toml`'s own comment: *"Reproduced twice in a clean,
no-prior-lockfile scratch copy: default `bun install` yields 4 top-level
node_modules entries and zero @arbor symlinks"*). Once that landed, a plain
`bun install` restored the flat layout and `npx tsc --build --force` passed
clean across the whole repository, confirmed at the end of this record's own
verification pass. **The linker-default risk is resolved, but the narrower
finding underneath it is not**: `arbor-mcp`'s and `arbor-opencode`'s
`package.json` files still do not declare dependencies their source code
imports directly. Hoisted linking papers over this exactly the way npm's
flat `node_modules` always did — it is real, latent debt (any future switch
to isolated/strict linking, or a stricter tool, reintroduces the breakage
outright) — but it is no longer this migration's live blocker. Fixing the
declarations is `packages/*/package.json` territory outside `arbor-tui`,
reported here rather than fixed here.

## Decision

**Adopt `@opentui/core` (`0.5.1` at the time of this decision; `@opentui/core@0.5.3` as of this citation's last verification) as this repository's TUI renderer, superseding
ADR-011's Ink/OpenTUI provisional language — but only as a second, proven
implementation behind `RendererPort` in this pass. The swap that makes it the
one `packages/arbor-mcp/src/tui.ts` actually constructs is a later, separately
reviewed change, gated on `feat/bun-runtime-migration` landing.**

1. `@opentui/core` is pinned to an exact version in
   `packages/arbor-tui/package.json` — not a caret/tilde range. It read
   `0.5.1` when this record was authored and reads `0.5.3` today (bumped by
   `f55fd3e7`), which is the pin discipline working as intended: a version
   change is a deliberate, reviewed commit. Per SemVer
   2.0.0, a `0.x` version is initial development where the public API is
   unstable and anything may change at any time; pinning is the only
   responsible way to depend on it, and a version bump is a deliberate,
   reviewed act, not an incidental `bun install`.
2. `OpenTuiRenderer` (`packages/arbor-tui/src/opentui-renderer.ts`) is a real,
   non-placeholder `RendererPort` implementation, proven against
   `@opentui/core/testing`'s real native test renderer
   (`packages/arbor-tui/tests/opentui-renderer.test.ts`, `bun test` only —
   see the runtime table above for why). At authoring time it was deliberately **not** exported
   from `packages/arbor-tui/src/index.ts` and **not** wired into
   `packages/arbor-mcp/src/tui.ts`, because exporting it from the public
   barrel would make every Node-hosted consumer of `@arbor/tui` transitively
   import `@opentui/core` for a class they could not safely construct. This
   paragraph called for a future record to "add the barrel export and the
   `tui.ts` wiring together, once `feat/bun-runtime-migration` has made Bun the
   whole repository's runtime." **That is what happened**: the Bun migration
   landed and wave 2 added both, as a runtime-gated opt-in that leaves
   `StdoutRenderer` the default. See O3 below.
3. `RendererPort`'s contract is accepted as sufficient for a renderer *swap*
   and insufficient for OpenTUI's structural advantages (mouse, native
   scroll, retained-tree diffing). Widening the port to carry structure
   (`Frame`'s pane rects, not a pre-joined string) is out of this record's
   scope and is named as the prerequisite for IQ-01 in `audit/
   tui-remediation-presentation.md` §6/§9's decision point 2, which this
   record does not resolve — it is the repository owner's proportionality
   call, not a mechanical consequence of adopting a rendering library.
4. Bun becomes a **hard runtime requirement** for the TUI the moment the swap
   in item 2 happens — not merely a build-time convenience. This is a real
   cost, stated rather than absorbed: any future contributor, CI job, or
   deployment target that cannot run Bun cannot run the shipped TUI.

## Consequences

**Positive.** ADR-011 no longer describes a renderer decision the shipped
system silently abandoned years ago. The gap between "the port is
replaceable" (O4, still true) and "the current renderer choice matches what
the ADR says" (false since an unknown point before this record) is closed by
naming the actual system, not by discovering it again later.

**Positive, concretely.** Once the later swap lands, OpenTUI gives this
repository real primitives the from-scratch renderer does not have and would
be expensive to build in parallel: `ScrollBoxRenderable` for native scroll
regions (closing IQ-02 without this repository hand-rolling
`clampToSelection`-style arithmetic across 13 screens, per `audit/
tui-remediation-presentation.md` §2.2's own more cautious reading of that
trade); a real mouse event model (`MouseEvent`, per-renderable
`onMouse*` handlers) as a structural prerequisite for IQ-01, which the
from-scratch string-grid renderer has no path to at all without inventing an
equivalent shadow hit-test tree from nothing; retained-widget diffing at the
native/Zig layer, which is a different order of efficiency than
`StdoutRenderer`'s current row-string diff for a densely-updating cockpit.
None of these are realized by this record — they are named as the concrete
payoff a future widened-port swap would unlock, distinguished here from what
this record actually proves.

**Negative, and load-bearing.** Bun becomes non-optional for the TUI's real
runtime path, not merely for its test harness. A contributor or environment
that has Node but not Bun cannot exercise the shipped renderer once the swap
happens. This repository accepted that cost by starting
`feat/bun-runtime-migration` at all; this record does not introduce it, but
it is the first record to spend it on a concrete, load-bearing feature rather
than tooling convenience.

**Negative.** `@opentui/core` is `0.x` per SemVer 2.0.0 — an explicitly
unstable public API where "anything may change at any time." Pinning to
`0.5.1` exactly defers that risk rather than removing it: every version bump
is a deliberate, reviewed diff against this repository's own usage, not a
transitive drift.

**Negative.** The test harness genuinely splits. `packages/arbor-tui/tests/
opentui-renderer.test.ts` cannot run under `vitest` — collection itself fails
(`Cannot find module 'bun:test'`) even though it contributes zero failing
test cases, because `vitest.config.ts`'s `include` glob
(`packages/**/tests/**/*.test.ts`) has no way to distinguish a `bun:test` file
from a `vitest` one by name alone under this record's scope. This is reported,
not fixed: `vitest.config.ts` is `feat/bun-runtime-migration`'s Lane B
territory, out of this record's file ownership. The same collision applies to
`scripts/typecheck-tests.mjs`'s per-package `tsconfig.tests.json` type-check
gate; this record closes that one specific instance for `arbor-tui` by adding
`bun-types` as a devDependency and a `/// <reference types="bun-types" />`
directive in the test file itself (both inside this record's own file
ownership), so `arbor-tui`'s `typecheck-tests` entry passes clean — but the
underlying vitest-collection collision is a repository-wide shape that
recurs for every future `bun:test` file this migration adds, and needs a
durable fix (a naming convention plus an `exclude`, or an equivalent) that is
Lane B's to make.

**Negative.** `TextRenderable`'s plain-string content path does not interpret
embedded SGR sequences (above); a colored frame is not faithfully rendered by
`OpenTuiRenderer` today. Only the uncolored path (this repository's default)
is proven.

**Negative.** This record's own verification transiently activated Bun's
isolated-linker default (above) and, through it, a pre-existing, unrelated
defect — undeclared `@arbor/*` dependencies in `arbor-mcp`'s and
`arbor-opencode`'s `package.json` — that briefly blocked `tsc --build`
repo-wide. `feat/bun-runtime-migration`'s runtime/package-manager lane landed
`bunfig.toml`'s `linker = "hoisted"` before this record finished, which
restores the flat layout and made `tsc --build --force` pass clean again;
`bun run build` is not currently broken. The underlying declaration gap in
those two `package.json` files is real, latent, and outside this record's
ownership to fix — reported, not resolved, here.

## Alternatives considered

1. **Keep the from-scratch renderer, close every reachable IQ row except
   mouse.** `audit/tui-remediation-presentation.md` §6 shows all of modal
   stack, scrolling, notifications, and filterable help are reachable without
   any framework — the from-scratch renderer's real ceiling is IQ-01 (mouse)
   alone. Rejected as the *sole* path forward, not as wrong: it adds zero new
   dependencies and zero runtime constraints, and every non-mouse gap in
   `audit/tui-parity-census.md`'s IQ rows can close on it. But it cannot
   close IQ-01 without inventing a parallel shadow hit-test/layout structure
   from scratch — real, large, ongoing infrastructure that a maintained
   native renderer already solves. This record's actual position: this
   alternative is not rejected, it is *complementary* — the primitives in
   `audit/tui-remediation-presentation.md` §3 (overlay union, scroll offset,
   notification band, help filter) should land on the current renderer
   regardless of this record's disposition, since they are cheaper there and
   do not depend on Bun. Only IQ-01 is this record's actual subject.

2. **Ink**, as ADR-011 originally named. Rejected on the same grounds ADR-011
   would have applied had its own named spike run: Ink is a React-reconciler
   renderer, which reintroduces exactly the "renderer framework as
   architecture" risk ADR-011's own alternative 4 already rejected for a
   different framework, and does not solve the mouse/scroll ceiling any more
   than the from-scratch renderer does — React's virtual-DOM reconciliation
   does not include a terminal mouse/hit-test model on its own; a consumer
   still has to build or bolt one on. Given the repository was going to pay
   *a* framework-adoption cost to close IQ-01 at all, OpenTUI is the
   framework that actually ships the primitive (native mouse events,
   `ScrollBoxRenderable`) the from-scratch and Ink paths both still lack.

3. **`@opentui/solid`** (SolidJS bindings over `@opentui/core`), the pattern
   `~/Dev/opencode/packages/tui` uses. Rejected: this repository's TUI core
   is a headless Elm-style model/update/effect architecture (ADR-011), and
   `@opentui/core`'s own `CliRenderer`/`Renderable` tree already gives
   imperative, directly-controllable primitives that a pure `renderScene`
   function can drive without a reactive UI framework's implicit dependency
   tracking sitting on top. Adding SolidJS would trade ADR-011's explicit,
   directly-testable `AppModel.epoch`-bump-plus-redraw mechanism
   (`update.ts:306-308`, `shell.ts:133-139`) for an implicit one, for no
   capability this repository's architecture does not already have by a
   different route — exactly the reasoning `audit/tui-remediation-
   presentation.md` §6 gives independently for the same conclusion, and
   exactly what ADR-011's own alternative 4 ("Renderer framework as
   architecture... rendering choice must remain an adapter detail") already
   forecloses.

4. **Widen `RendererPort` now, in this same record, to unlock OpenTUI's
   structural advantages immediately.** Rejected for this pass: it is a
   materially bigger change (touching `Frame`'s consumers, not just adding
   an implementation behind the existing contract), it was explicitly out of
   this pass's scope per the migration plan's lane discipline, and doing it
   without the repository owner's proportionality call on IQ-01's actual
   cost/value (`audit/tui-remediation-presentation.md` §9, decision point 2)
   would be building ahead of a decision that is not this record's to make.

## Obligations

### O1 — `OpenTuiRenderer` implements `RendererPort` and is proven against a real native renderer, not a mock

<!-- proof: symbol=OpenTuiRenderer file=packages/arbor-tui/src/opentui-renderer.ts roundtrip=packages/arbor-tui/tests/opentui-renderer.test.ts -->

### O2 — `@opentui/core` is pinned exactly, not range-matched

<!-- unverifiable: package.json's dependency version field is not a symbol export under packages/*/src, so symbol= cannot resolve against it — the same reason ADR-008 gives for its own three obligations -->

**Version cite updated (verified 2026-08-26): the prior text here read
`"0.5.1"`; it now reads `"0.5.3"`** (`packages/arbor-tui/package.json:16`).
The obligation itself is unaffected — the field is still the bare literal
`"0.5.3"`, carrying no `^`/`~`/`*` — but the specific version number this
paragraph cited was stale.

*No proof comment: a `package.json` version field is not a symbol export
under `packages/*/src`, so `symbol=` cannot resolve against it — the same
reason ADR-008 gives for its own three obligations.*

### O3 — `OpenTuiRenderer` is not reachable from the production TUI entry point in this pass

<!-- unverifiable: asserts an absence (no OpenTuiRenderer construction reachable from tui.ts), which proof grammar has no way to attest — and the absence itself no longer holds, superseded by ADR-077's opt-in wiring at tui.ts:32,316 -->

**SUPERSEDED BY ADR-077 — this obligation is false today (verified
2026-08-26, citations refreshed against current line numbers).**
`decisions/ADR-077-opt-in-renderer-reachability-supersedes-adr-036-o3.md`
retires it and restates the commitment positively: the renderer is reachable
only by explicit opt-in, and `StdoutRenderer` remains the default. It asserted an absence, and that absence has since been filled
deliberately: `packages/arbor-mcp/src/tui.ts:32` imports `OpenTuiRenderer` and
`:316` constructs one inside `createRenderer()`, and
`packages/arbor-tui/src/index.ts:190` exports it from the barrel.

The wiring is an **explicit opt-in**, not the default swap this record warned
against: it is selected only by `ARBOR_TUI_RENDERER=opentui` or
`TuiLaunchOptions.renderer: "opentui"`, is gated to the Bun runtime, and falls
back to `StdoutRenderer` under Node (`tui.ts:307-323`). It was authorized by
`docs/tui-wave2-plan.md` Lane G ("make the OpenTUI renderer reachable") and
landed in the wave-2 cockpit work, not by an unreviewed change. What this
obligation originally recorded, and which held when written:
`tui.ts` constructed no `OpenTuiRenderer` and the barrel exported no symbol
from `opentui-renderer.ts`.

*No proof comment: this obligation asserts an absence, which
`packages/arbor-governance/src/obligation/parse.ts`'s `symbol=`/`roundtrip=` proof shape has no way to
attest (a proof comment names a thing that exists, not a search that found
nothing) — the same shape `ADR-035`'s O1 describes for its own
extractor-is-a-script case, generalized here to an extractor-is-a-grep case.*

### O4 — The `bun test`-only test file does not silently pass on Node

<!-- unverifiable: absence of a false-positive collection outcome is not a source symbol proof= can name; verified instead by vitest.config.ts's exclude glob and a real vitest/bun test run, cited in the body below -->

`packages/arbor-tui/tests/opentui-renderer.test.ts` imports `bun:test`, so it
must never report a phantom pass under vitest.

**The mechanism changed, the property holds (verified 2026-08-26, line cite
refreshed).** This paragraph recorded that the file "fails at collection
(`Cannot find module 'bun:test'`)" under `vitest run packages/arbor-tui/tests`.
It no longer does: `vitest.config.ts:34` now excludes `packages/arbor-tui/tests/opentui-*.test.ts`
by name — the fix ADR-036's own Consequences named as "reported, not fixed …
Lane B's to make" — so the file is filtered out before collection rather than
failing during it. `npx vitest run packages/arbor-tui/tests/opentui-renderer.test.ts`
now reports `No test files found`, and the scoped directory run passes 67 files
/ 878 tests (re-verified 2026-08-26; was 51/668) with the opentui files cleanly absent. Either way there is no
phantom pass, which is what this obligation actually asserts. Its real evidence
is `bun test packages/arbor-tui/tests/opentui-renderer.test.ts`: 11 pass, 0
fail, 37 expect() calls.

*No proof comment: this obligation is about an absence of false-positive
behavior in a harness collision, not a source symbol — `symbol=` has nothing
to name.*
