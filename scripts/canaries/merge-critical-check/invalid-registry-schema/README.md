# canary: gate:merge-critical-check — an invalid registry schema version

`verifyMergeCriticalRegistry(repo, registry)` is the gate module's own exported
check; the wrapper's `main` was the only hardcoded part, and it now takes
`--repo`. The registry loader was already parameterised on `repo` and
`registryPath`, so no library change was needed.

The fixture's registry declares `schema_version: 2` and satisfies every other
validator — `property_id` is a slug, `ADR-900` resolves to exactly one
decision, the statement is non-empty, `watch_globs` is a safe relative path,
and `test_id` resolves to a real collected test file. That is load-bearing: a
fixture that tripped four validators at once would prove the wrapper is
reachable without proving which check fired.

Note that this fixture is *about the registry*, not about any property
statement, so `ADR-900` appears here as a resolvable decision id and nothing
else. No document in this fixture claims a back-reference to it, so no
retirement-integrity style check can be satisfied by this fixture's own prose.
