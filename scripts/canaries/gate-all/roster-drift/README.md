# canary: gate:all — ROSTER DRIFT

`scripts/gate-all.mjs` reads its gate roster out of the target repository's
`package.json` (`enumerateGates(repoRoot)`) and compares it against the cost
tier table it holds. A `gate:*` script declared here has no tier, so
`auditRoster` reports drift and `main` exits 1 BEFORE any gate runs.

This is the gate's real anti-drift check, reached through its real `--repo`
flag and its real `--list` short-circuit — no reporting wrapper is
reimplemented, the output string is the gate's own.

`--list` is load-bearing: without it the battery would proceed to spawn the
whole tier and time out rather than fail on the drift.
