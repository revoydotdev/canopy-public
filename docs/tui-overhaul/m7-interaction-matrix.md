# M7 interaction matrix

The matrix is a contract for the pure policies in
`packages/arbor-tui/src/interaction-polish.ts`; the renderer and runtime keep
execution authority. Every route has both a discoverable keyboard path and an
optional pointer equivalent.

| journey | keyboard route | pointer route | invariant |
|---|---|---|---|
| keyboard-only | `F6`, `Enter`, `Esc` | n/a | reader close restores focus and selection |
| mouse-assisted | `Shift+F10`, `Enter` | row click, right click | context item is the same catalog action and reports authorization |
| background refresh | `j`/`k` | wheel | selected identity and reading offset remain stable; newer content is disclosed |
| narrow layout | resize, `F6` | resize, drawer click | F6 cycles only through painted zones; at 59×15 the warning names the current focus and the composer/transcript remain reachable while rail/graph are hidden |

The narrow-layout row is backed by `focusZonesForShellLayout` and a live
`runTui` stdin test at 59×15. The table remains journey guidance rather than
a generated fixture matrix.
`restoreReaderFocus` covers close/back focus restoration and ships in
production. A former exported copy of this table (`M7_INTERACTION_MATRIX`) and
a simulated bounded-queue probe (`measureInteractionStress`) were deleted on
2026-09-23: neither had a production caller, and the probe modelled a queue
the live renderer does not use. Cell-level
renderer coverage remains in the M2 viewport snapshots and the narrow-layout
OpenTUI suite; M7 adds policy-level before/after evidence without inventing
runtime state.

The live renderer's contextual help overlay invokes `contextMenuItems` with
the current palette catalogue and disabled-reason projection, so its selected
row shows the same keyboard route and authorization explanation used by
Shift+F10 and command-palette dispatch.
