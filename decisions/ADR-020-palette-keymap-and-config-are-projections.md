# ADR-020: Palette, Keymap, and Config Are Projections with a Grammatical Keymap

**Status:** Accepted
**Date:** 2026-08-02

## Context

The TUI cockpit (ADR-011, Phase 4C) already has a catalog-derived palette/help
surface and a bounded config screen, but its palette is not terminal-true, its
key bindings are not a configurable grammar, and its config lacks per-knob
provenance on governance-critical values. The frontier survey (frontier
`Appendix B`) shows opencode owns the *operator-feel* (a terminal-derived
palette with neutrality guarantees; JSONC config with comment-preserving edits
and source-tagged provenance) and Codex owns the *operator-power* (deep config
profiles + a TUI keymap grammar with chords, bounds, canonicalization, and early
rejection). Neither binds surface to the ledger the way revoy2's authority model
(Commandment III, ADR-011/017) demands.

## Decision

Surface appearance and interaction grammar are **projections**, and the key
grammar is **itself configurable with defined bounds**.

- **Terminal-true palette as a projection with a legibility contract
  (opencode):** colors are derived from the actual terminal — dark/light mode
  detection + the renderer's palette — and modeled with a **closed
  `RunFooterTheme`/`RunBlockTheme`/`RunSplashTheme`** type. A **neutrality-spread
  test** asserts surfaces stay within a small luminance spread on saturated or
  warm backgrounds, so the palette is legible on *any* user theme. No hardcoded
  RGB as the primary path; a hardcoded dark-mode palette is only the
  detection-failure fallback. Because the TUI is headless, the palette is
  terminal-derived, never borrowed from an editor theme.
- **Keymap-as-config with chords + bounds (Codex):** key bindings are a bounded
  `[tui.keymap]`-style config — a normalized canonical key-spec (so `"ctrl-a"`
  and `"ctrl-x ctrl-s"` unify), **two-stroke chord** support, a
  **max-events-per-binding bound**, alternative-binding lists (`[...]` =
  alternatives, not a chord), and **early rejection** of malformed bindings with
  user-facing diagnostics. The palette *grammar* is configurable, not hardcoded.
- **One surface for commands + node-actions + skills (opencode
  `source==="skill"`):** the palette/help unifies built-in commands, node-card
  actions, and delegation via a `catalog.source: "builtin" | "node" | "skill" |
  "command"` discriminator — capability routing feeds the same surface the
  operator searches (Phase 4D.3).
- **Config with per-knob source + ledger provenance (opencode + revoy2 twist):**
  keep `arbor-config` JSONC + `$schema` + **comment-preserving edits**
  (`jsonc-parser applyEdits`), and add a **per-knob `source`** that records
  whether a value came from a checked-in file, env, or — for any
  governance-critical knob — **the ledger**. A governance-critical value is a
  **ledger projection**, never a mutable file that can drift from authority
  (Commandment III; the config screen is a view over it, not a second authority).

## Consequences

- The palette is a deterministic function of the terminal; neutrality is tested,
  so legibility holds on any theme and no symbol/color-only meaning creeps in.
- Key bindings are user-configurable within defined bounds, with early rejecting
  diagnostics — no unparseable or unbounded keymaps.
- The palette routes on capability (`catalog.source`), so the operator's surface
  cannot show a node-action the node's card cannot back (Phase 4D.3).
- Config values carry provenance; governance-critical knobs are ledger-derived,
  so settings never drift from authority and survive restart.

## Roads not taken

- Hardcoding a fixed RGB theme — rejected: illegible on many terminals and not
  a projection (ADR-011/017).
- Borrowing the host editor's color-token theme (Zoo) — rejected: the TUI is
  headless and must own its palette derivation.
- Unbounded/freeform keymap strings — rejected: violates Commandment IX (bounds
  are part of the type-level contract).
- A mutable global-config-as-authority — rejected: the confirmed
  drift/marker class (Commandment III).

The roadmap (Phase 4D.9) and clean-room guardrails govern rebinding; map this
onto `arbor-config` (source-tagged JSONC) + `arbor-tui` (terminal-theme and
keymap projections) before spreading code. If a config or palette decision later
touches authority/ordering, reconcile an ADR first (handoff §5).

## Obligations

### O1 — The palette is a deterministic, closed-type projection of the terminal, never a hardcoded RGB constant

<!-- proof: symbol=deriveTheme file=packages/arbor-tui/src/theme.ts roundtrip=packages/arbor-tui/tests/theme.test.ts -->

### O2 — A legibility contract asserts every foreground role holds a minimum contrast ratio against the background, so the palette stays legible on any terminal theme

<!-- proof: symbol=checkLegibility file=packages/arbor-tui/src/theme.ts roundtrip=packages/arbor-tui/tests/theme.test.ts -->

### O3 — Key bindings are a bounded, chord-capable config grammar with early rejection of malformed or over-length bindings, never unbounded or silently accepted

<!-- proof: symbol=parseKeymap file=packages/arbor-config/src/keymap.ts roundtrip=packages/arbor-config/tests/keymap.test.ts -->

### O4 — One palette/help surface unifies built-in commands, node actions, and skill delegation behind a single `source` discriminator, filterable by kind

<!-- unverifiable: the former nodecard-gate roundtrip was retired with its stale capability predicate; add a focused source-discriminator roundtrip before treating this obligation as verified. -->

### O5 — Every effective config leaf carries a per-knob provenance tag from a closed source union that reserves a dedicated `ledger` source for governance-critical knobs

<!-- proof: symbol=ConfigSourceKind file=packages/arbor-mcp/src/config-inspection.ts roundtrip=packages/arbor-mcp/tests/config-inspection.test.ts -->

Scoped honestly: the `ledger` source is typed and reserved but, per
`config-inspection.ts`'s own docstring, not yet fed by any production
caller — no config knob is actually ledger-derived today. This obligation
covers the provenance-tagging mechanism, which is real and tested; it does
not claim a governance-critical value currently resolves from the ledger.
