# canary: gate:determinism — a flaky seam above the ceiling fails the gate

`scripts/determinism-baseline.ts` reads its baseline store from
`REVOY2_DETERMINISM_DIR` when set, falling back to `<repo>/.determinism-baseline`.
The variable exists for exactly this purpose — the script's own comment calls
it "overridable for fixture-based failure tests".

`current.jsonl` here is one row: a cited seam measured 3 times with 1 pass and
2 fails, i.e. `flake_rate` 0.67. That is above the gate's `MAX_FLAKE_RATE`
ceiling of 0.2, so the gate's own `DB-B` check must fire.

The row's `roundtrip_path` is a real cited seam rather than a made-up one, so
the fixture is testing the flake ceiling and not the unmeasured-seam count
(`DB-R`) that fires anyway when the store holds one row against 241 citations.

## What this does and does not prove

It proves the gate can read a store and RED on a seam whose recorded flake
rate breaches the ceiling — its stated purpose. It does NOT prove the gate can
*detect* flakiness: measurement is deliberately manual (`--refresh`, never run
by this gate), so this canary can only prove the read-and-judge half, which is
the half the gate actually performs.
