# canary: gate:stop-guard-releases — a post-baseline release that named no gate

`auditReleases({ records, baselineThrough })` is the gate module's own exported
body, and it is a pure function of the journal and the baseline — which is
exactly why the gate can be proven able to fail without a real breaker having
ever run. `main` was the only hardcoded part; it now takes `--root` (which
baseline is read) and `--journal` (which journal is audited). Both are inert
when absent and both only relocate INPUT.

`ARBOR_STOP_GUARD_STATE_DIR` would also have relocated the journal — that seam
already exists in `resolveStateDir` — but `guard-canaries.mjs` does not forward
a declared `env` to the spawned gate, so the CLI flag is the seam that actually
works from a fixture. That is a gap in the canary mechanism, not in this gate.

The one record in `state/releases.jsonl` is dated after the baseline in
`scripts/stop-guard/baseline.json` and names no blocking and no advisory gate.
Under ADR-154 that combination is structurally impossible, so it is the gate's
one blocking condition: the breaker has regressed.

The baseline is dated 2020 deliberately, so the record is unambiguously
post-baseline rather than sitting on a boundary. Nothing in this fixture's prose
is scanned by any check — the gate reads the baseline and the journal only.
