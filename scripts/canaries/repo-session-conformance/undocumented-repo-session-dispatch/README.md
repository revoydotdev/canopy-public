# canary: gate:repo-session-conformance — a native CLI without the lifecycle

This gate is a set of source-text conformance assertions over the real checkout
(`packages/arbor-mcp/src/cli.ts`, `repo-session-close.ts`, `hooks/contracts.ts`,
`hooks/bus.ts`, `scripts/session-close.mjs`, the host-control manifests and
bridges). `main` was hardcoded to its own checkout; it now takes `--root`, which
only relocates input — every pattern is unchanged.

The fixture is deliberately minimal. `scripts/host-controls.mjs` is present and
exits 0, because the gate's first action is to run that file's `check` command,
and a missing one would fire a different problem and make the canary prove the
missing-file branch instead of a conformance branch.

That leaves many assertions failing on absent files, which is the honest shape
here: this gate reads ~12 real paths and this fixture is not a revoy2 checkout,
so it cannot satisfy all of them without becoming a copy of the repository. The
declared `expected_failure_reason` is the FIRST and most specific assertion —
the native CLI does not dispatch the repository-session lifecycle at all — so
the canary is not passing on an incidental "file is missing".

`expected_failure_reason` is deliberately that sentence and not a substring
common to the "is missing" family, so a fixture change that made the gate fail
only on absent files would be reported `misfired` rather than silently
counted as proven.

THE TRAP THIS FIXTURE ALREADY FELL INTO ONCE. Its first version explained what
the gate checks and wrote the argv comparison and the command name in prose
inside `cli.ts`. The gate greps that file's text, so the fixture's own
explanatory comment satisfied the assertion and the canary went `unproven` — the
gate passed a file it was built to reject. The comment now names neither. This
is the general hazard: **a fixture's prose is itself an input to the gate**, so
any fixture for a text-pattern gate must be written by reading the pattern and
confirming the prose does not match it.
