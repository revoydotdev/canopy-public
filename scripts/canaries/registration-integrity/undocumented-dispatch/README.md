# canary: gate:registration-integrity — an undocumented CLI dispatch

The five checks here are already pure functions of file TEXT
(`checkCliDispatch(cliSourceText)` and its four siblings). What was hardcoded
was the walk in `main` that decides which files to hand them, so the seam is one
`--root` on the module's `REPO_ROOT`. No check function was changed.

`packages/arbor-mcp/src/cli.ts` has the shape `checkCliDispatch` requires — a
top-level `main(args, environment)`, an `args[0] === "--help"` /
`args.length === 0` branch writing to `environment.stderr`, and one further
`args[0] === "canary"` branch — and dispatches a command its own usage text
never mentions. That is the same `undocumented-dispatch` class the live corpus
currently reports for `cliDispatch`.

`package.json` and `scripts/canary-gate.mjs` exist so check 5 has a readable
package and a non-empty script list; without them `main` threw ENOENT before
printing any verdict, which is a crash, not a check failing.

## What this canary does and does not cover

`expected_failure_reason` is the `cliDispatch` sentence, so the census
attributes the red to check 2 specifically. This fixture is a minimal
repository, not a revoy2 checkout, and it cannot satisfy all five checks at once:

- `deadEntrypoints` reads `scripts/reachability/entry-points.json` from the real
  `scripts/` directory (that manifest is the one input a foreign root cannot
  supply) and so also reports the real `arbor-mcp-cli` entry as having no
  executable statement here.
- `toolRegistration` and `catalogDispatchDrift` report their files as absent.

A green here says the cli-dispatch leg is able to fail. It is not a claim that
the other four legs were exercised.

## `run.mjs` is not used

An earlier draft drove `checkCliDispatch` from a `run.mjs` inside the fixture.
That does not work through `guard-canaries.mjs`: a declared `command` is a raw
argv prefix that is NOT `{repo}`-templated, and the child is spawned with `cwd`
set to the real repository, so a fixture-local script is unreachable. The file
is retained rather than deleted because this checkout is shared; it is dead.
