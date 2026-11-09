# canary: gate:governance-counts — a stale rendered count

`renderGovernanceCounts(repoRoot, {check: true})` is the gate module's own
exported body; its CLI `main` is a reporting wrapper whose root is hardcoded
to this checkout, so `run.mjs` reproduces only that wrapper. The verdict
(`ok`, and the list of stale files) is the function's return value.

All three documents the gate renders are present, because the function throws
rather than reporting when any of them is absent or carries a broken marker
pair — a missing document is a usage error, not the drift this canary is
about. Two of them are already correct; one carries a count the derivation
does not produce, so exactly one file is reported stale.

`decisions/registry.json`, `packages/arbor-mcp/src/runtime-catalog.ts` and
`scripts/reachability/allowlist.json` exist so `adr_total` is measured: an
unmeasured quantity makes the function throw before any comparison happens,
which would fail for a reason unrelated to staleness.
