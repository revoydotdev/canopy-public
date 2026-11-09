# TUI pilot apparatus

Drives `arbor tui` in a real pty, observes it through a VT emulator
(`@xterm/headless`), and leaves a receipt that records what the app did rather
than what was asked of it. It replaces `scripts/record-console-reel.mjs` (tmux)
for pilot evidence. The reasons are in the EC log,
`artifacts/tui-pilot/2026-09-02-exemplar-checks.md`: tmux consumed `;`, could
not send `S-` on letters or ctrl+shift at all, its capture-pane approximated
positioned partial updates, the renderer was assumed rather than read, and
single runs were used to judge an intermittent defect.

```
bun run pilot:tui -- --scenario <id|file> [--seed <preset>|--project <dir>]
  [--geometry <WxH>|random] [--renderer opentui|stdout] [--resume|--no-resume]
  [--runs N] [--out <dir>] [--interval-ms 250] [--budget-s 600] [--no-png]
  [--env K=V]... [--tui-arg <arg>]... [--kitty]
```

| piece | file | what it guarantees |
|---|---|---|
| key bytes | `lib/keys.mjs` | every key name becomes bytes the pilot chose; a legacy-inexpressible chord is marked `lossy` in the receipt instead of silently degrading |
| pty + emulator | `lib/pty-session.mjs` | `Bun.spawn({ terminal })` gives the app a real TTY; the emulator's grid is what an operator sees, stale cells included; terminal replies are written back to the app |
| snapshots | `lib/screen.mjs` | text, per-cell colour/attributes, sha256, SVG→PNG with colour |
| seeds | `seeds/index.mjs` | durable state built through the real runtime, each write checked as `ok && value.accepted !== false` (EC-015); a rejected required step throws |
| scenarios | `scenarios/*.json` | steps: `wait_for`, `type`, `key`, `keys`, `raw` (exact bytes, optional per-byte gap), `resize`, `hold_s`; `covers` lists the surface-matrix rows |
| lint | `lint-frames.mjs <run-dir>` | detectors for every defect class the EC log found by eye, each pinned by a known-positive fixture; writes `findings.jsonl`; findings are leads for the eye |
| sheets | `contact-sheet.mjs <run-dir>` | six moments per image with step label and lint summary; `sheets/index.json` carries the six-region review checklist |
| matrix | `matrix.mjs --receipts <root> --assessment <md>` | the surface matrix derived from receipts: PILOTED needs a receipt AND an assessment that cites it |

## Output

Per run under `--out`: `frames/fNNNN.{txt,json,svg,png}` (deduplicated to
moments; the tick log in the receipt keeps the per-poll sha for rate
arithmetic), `stream.cast` (asciicast v2 with input, reply, resize and marker
events), `seed.json`, `receipt.json`. Across runs: `summary.json`.

The receipt's `renderer.observed` is derived from the terminal queries the app
wrote (kitty/XTVERSION/XTGETTCAP → OpenTUI; none → stdout). `summary.json`
refuses to permit a rate claim below sixteen runs.

## The loop

```
pilot (random geometry, seeded) -> lint -> sheets -> eye review by region -> EC entry ->
exemplar-conventions.md row (or a fresh search) -> fix -> re-pilot same scenario -> tests -> commit
```

## Rules that survive from the log

- A palette row naming a screen is not evidence the screen rendered.
- Any "key X does nothing" claim is reproduced here, never through tmux.
- An intermittent defect gets `--runs 16` or more before a rate is stated.
- Seeded state is foregrounded only under `--resume`; the CLI defaults it on
  for every preset except `greenfield`.
- Exemplar search precedes remediation; see the EC log's standing rule.

## Tests

`scripts/tests/tui-pilot-{keys,screen,seeds}.test.mjs` run under vitest.
`scripts/tests/tui-pilot-pty.bun.test.mjs` drives the real launcher and runs in
the Bun lane (`bun run test:opentui`).
