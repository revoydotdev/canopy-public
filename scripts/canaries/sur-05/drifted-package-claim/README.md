# canary: gate:sur-05 — a drifted count claim

`runSur05` is the gate module's own exported body; the CLI's `main` is a
reporting wrapper around it, and the wrapper is reproduced in `run.mjs` only
because `main` hardcodes this checkout as its root. Every verdict printed
there — `blocking`, `findings`, the counts — is `runSur05`'s own return value.

This file is itself a scanned document (the scan covers root-level `*.md`), so
it deliberately never states a count claim in a phrasing `checkCounts`
recognises; doing so would add a second, incidental finding.

The fixture is built so that every quantity `deriveRepositoryCounts` can
measure IS measured: a `decisions/registry.json` with an `allocations` array
(`adr_total`), a readable `packages/arbor-mcp/src/runtime-catalog.ts`
(`catalog_kinds`), and a `scripts/reachability/allowlist.json` with an
`entries` array (`allowlist_entries`). That is load-bearing. Without them the
gate blocks on "unmeasured" for each, which is a condition any fixture at all
would trip and which would therefore prove nothing about drift detection. With
them, the only remaining failure is the drifted claim the fixture is actually
about: a document in `docs/` claims a package count the repository does not
have.
