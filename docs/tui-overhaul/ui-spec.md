# TUI overhaul — UI specification (M0.5)

Status: **proposed** — this spec is the contract M2 implements. Governing decisions: the proposed ADRs listed in [tasks.md](tasks.md).
Brief: `.revoy/briefs/governance-harness-tui-orchestrator-prompt.md` (gitignored operator brief).
Current state: [baseline.md](baseline.md), [architecture.md](architecture.md).

Claim tags: **SC** source-confirmed · **M** measured · **H** hypothesis · **U** unverified.

## 1. What changes and what does not

Stays as it is:
- the Elm core (`model.ts` / `update.ts`), ADR-011;
- the structured `SceneFrame` renderer port, ADR-037;
- the `RuntimePort` command/query boundary (`runtime-port.ts`), which mirrors `RuntimeCatalogRouter`;
- `uct-header.ts` as the only UCT renderer. It never invents nodes (SC `uct-header.ts:1-16`).

Changes:
- **Geometry** moves out of `renderCockpitScene` (`renderer.ts:291`) into a pure `layout.ts` (`computeShellLayout`). The flat painter, the OpenTUI painter and hit-testing all consume that function.
- **The status row** (`renderer.ts` statusRow=0 plus the 4-row hero at `renderer.ts:308`) is replaced by a framed **top band**: left zone | graph rectangle | right zone.
- **The inspector rail** (`responsive-sidebar.ts`, tabs project/adrs/docs/devtools, one breakpoint at 120) becomes a **three-tab rail** (Git / Governance / Inspect) with four breakpoint classes.
- **Focus** becomes an explicit `FocusModel` in `AppModel`. It replaces the implicit "screen + overlay" focus.

## 2. Geometry contract (`computeShellLayout`)

The input is `{ columns, rows, rail: "auto"|"open"|"closed", header: "auto"|"collapsed"|"expanded", composer_lines }`. The output is a set of non-overlapping integer rects: `header`, `header.left`, `header.graph`, `header.right`, `transcript`, `composer`, `rail` (null when closed), `rail_overlay` (drawer), `warning`, plus the `layout_class`.

### 2.1 Layout class

| class | condition | rail | header |
|---|---|---|---|
| `docked` | cols ≥ 120 ∧ rows ≥ 24 | docked right | full |
| `drawer` | 80 ≤ cols < 120 ∧ rows ≥ 24 | overlay, opened explicitly; tab state retained | full |
| `compressed` | (60 ≤ cols < 80 ∨ 16 ≤ rows < 24) ∧ not minimal | overlay drawer, opened explicitly | compressed |
| `minimal` | cols < 60 ∨ rows < 16 | overlay only, full-screen reader | one status row + size warning |

### 2.2 Header (top band)

- Full-width, **height `clamp(floor(rows/3), 8, 12)`** including a 1-row top border and a 1-row bottom border. The graph interior is therefore 6–10 rows, and at 24 rows it is 8 rows with 6 interior graph rows. The user can collapse it to the compressed height, or expand it by +4 rows, within the §2.5 invariants.
- Compressed: 4 rows (2 border + 2 interior) when rows ≥ 18, otherwise 1 unframed status row.
- Zones: `left = right = clamp(floor(cols * 0.2), 18, 30)` and `graph = cols − left − right − 2` (two 1-col separators). If `graph < 24`, the zones fold. The left and right text move into the header's first interior row, and the graph takes the remaining rows at full width.
- The zone widths depend **only on `cols`**, never on the status text. Text is truncated with `…` inside its zone and can never move the graph (brief §4.1).
- Priority order inside a zone, highest first: blockers (denied gate, pending approval, failed action) > active work > identity metadata. Lower priority lines drop first.
- Left zone: repository, branch/worktree, run id. Right zone: gate/approval state, active work count, runtime health (connection, event lag).

### 2.3 Body

- `rail` (docked): `width = min(clamp(floor(cols * 0.28), 32, 44), cols − 72)`, spanning from below the header to the bottom row. The main region is always ≥ 72 cols.
- `composer`: anchored at the bottom of the main region. `height = clamp(composer_lines + 2, 3, max(3, floor(body_rows / 3)))`. It never scrolls with the transcript.
- `transcript`: the rest of the main region between the header and the composer. When the notification band is non-empty it takes up to 3 rows of the transcript's bottom, never the composer's.
- Drawer / compressed rail: an overlay `width = min(44, cols − 4)` anchored to the right edge, over the transcript, **never over the composer**. The existing rule is kept: an active `operator_form` suspends the overlay (SC `renderer.ts` renderCockpitScene).

### 2.4 Minimal

Row 0 is the size warning (`terminal WxH below 60x16 — some panes hidden`). Then the transcript, then a composer of at least 1 row. Drafts, focus and rail tab state are retained in the model and restored when the terminal grows.

### 2.5 Invariants (property-tested, M2.5)

1. Every rect lies inside `[0,cols) × [0,rows)`, and no two painted rects overlap. The drawer overlays the transcript only.
2. Whenever rows ≥ 3 the composer has height ≥ 1 and width ≥ 1. It is never off-screen.
3. Layout is a pure function of its input. The same input gives the same rects.
4. Hit-testing uses the rects of the **frame actually painted**. Frames carry `layout_epoch`, and a click resolved against an older epoch is dropped.

## 3. Focus and keyboard model

`FocusModel = { zone: "composer"|"transcript"|"rail"|"graph"; overlay_stack: Overlay[]; rail_tab: "git"|"governance"|"inspect"; selection: Map<PaneId, StableId>; scroll_anchor: Map<PaneId, {id, offset}> }`.

- The topmost overlay owns input (reader, search, context menu, palette, help, confirmation, form). When the stack is empty, `zone` owns it.
- **Text-entry contexts** are the composer, search fields and form fields. Printable keys are always text there, and navigation letters are inert.
- `F6` / `Shift+F6` cycle composer → transcript → rail → graph. `Ctrl+P` opens the palette (existing). `?` opens help (existing, navigation contexts only).
- Navigation contexts use `↑↓←→` and `h j k l`. `h` / `l` go to the parent / expand the child in trees; in lists `l` / `Enter` open. Also `PgUp/PgDn`, `Home/End` / `g G`, `/` (pane search), `Enter` (open reader), and `Backspace` / `Alt+←` (back).
- `Esc` pops the top overlay only. With an empty stack it moves focus to the composer. It **never** cancels a run.
- Cancellation is explicit and scoped. The existing interrupt binding stays for the main run. Inspect gets its own cancel inside its tab (M6).
- `Shift+F10` or the `Menu` key opens a context menu for the selected object. Right-click opens the same menu when mouse capture is on. Menus, palette and keys all resolve through **one action registry** (`default-catalog.ts` actions), so a menu item is a catalog action id, never a separate code path.
- Selection is stored by stable id (node id, file path, record id, action id), never by row index. After an update the selection is re-resolved by id; if the id is gone, the selection moves to the nearest surviving neighbour and a notice is shown.
- A reader keeps its scroll anchor when newer content arrives and shows `↓ N newer`. It does not snap.
- The breadcrumb (header right zone, last line, or rail title) shows `focus › tab › item k/N`.

## 4. Rail tabs (M2 scope vs later)

| tab | M2 (this checkpoint) | later milestone |
|---|---|---|
| Git | re-home the existing porcelain file list (`responsive-sidebar.ts:628-661`, SC) plus branch/HEAD from the product surface; observed state only | M4: worktree tree, ancestry, diff readers, watcher, governed worktree commands |
| Governance | re-home the existing ADR tab rows (`sidebarAdrRows`) and add unresolved-interview count | M3: full categories, search, cross-links, index |
| Inspect | structured state of the selected action/operation (id, attempt, lifecycle, gate results, timestamps) from `operation.list` / `task.changed` read model | M6: side-queries, promotion |

Project/docs/devtools content stays reachable through the palette. Nothing is deleted without a replacement route.

## 5. UCT band (M2 scope)

- The graph rectangle renders `projectUctHeader` at its exact interior size. The M2 change is sizing only; the renderer is not replaced.
- If there is no campaign or `campaign.tree` has not answered, the band shows **`UCT: no live campaign`** or **`UCT: awaiting tree`**. It never shows an empty decorative graph. Elision is labelled with `elided_node_count` (already reported, SC).
- Fit / hysteresis / LOD, the modal graph reader, and 20k-node support are **M5**. The 200-node page cap (SC `tui.ts` issues `campaign.tree` limit 200) is recorded as a known truthfulness limit. The band labels `showing 200 of N` whenever N is known to exceed the page.

## 6. Theme tokens

Semantic roles are mapped onto the existing `PaletteRole` set (SC `theme.ts`), so components never name colours.

| token | meaning | default dark | monochrome / ASCII carrier |
|---|---|---|---|
| `active` | running work | cyan | `▶` / `>` + bold |
| `governance` | ADR/gate/decision accents | violet | `§` / `$` |
| `success` | verified / pass | green | `✓` / `+` |
| `waiting` | pending approval, warning | amber | `…` / `~` |
| `failure` | fail / deny / error | red | `✗` / `x` + bold |
| `muted` | metadata | dim | dim or plain |
| `selection` | selected row | inverse | `›` row marker + inverse |
| `focus` | focused pane | heavy border | heavy vs light border (`=` vs `-` in ASCII) |

State is always carried by glyph + label, never by colour alone. An ASCII glyph table sits beside the Unicode one, chosen by the existing `FrameOptions.unicode`. No icon font is required. Untrusted text keeps going through `sanitizeUntrustedTerminalText` (SC `widgets.ts:19`).

## 7. Composer

- Multiline editing already exists (SC `terminal-editor.ts:93-100`, `text-buffer.ts`). M2 adds grapheme-cluster cursor movement and deletion via `Intl.Segmenter`, so combining marks, emoji ZWJ sequences and wide characters move as one unit.
- Bracketed paste inserts text only and **never submits**. This is existing behaviour and gets a regression test.
- States are shown in the composer border: `draft`, `queued (n)`, `running`, `awaiting answer`. The existing console input shape carries `send|queue|answer` (SC `screens/console.ts:170,284`).
- The composer draft is keyed per surface, so Inspect never reuses or clobbers the main draft.

## 8. Acceptance for this checkpoint (M2)

These are defined in [tasks.md](tasks.md) under M2.1–M2.5. Viewports: 160×48, 120×36, 100×30, 80×24, 60×18, plus 50×14 undersized and recovery back to 120×36.
