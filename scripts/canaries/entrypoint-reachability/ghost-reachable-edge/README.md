# canary: gate:entrypoint-reachability — a self-check that must fail

`analyzeEntrypointReachability({ repo })` is the gate module's own exported body;
`main` was the only hardcoded part and now takes `--root`. Everything the report
prints — the per-root counts, the partition, and the self-check verdict — is that
function's own return value.

This fixture is about the ONE thing this gate gates on: its self-check. The
self-check asserts that the union of every per-root closure equals the set the
vendored extractor already committed as `reachable_from` edges, and fails closed
when they disagree — because a partition derived from a stale copy of someone
else's adjacency rule is not a finding, it is a fiction.

So the fixture commits a graph where they disagree. One derived
`reachable_from` edge names `sym:canary.ghost` as reachable, but no adjacency
edge leads any declared root to it, so no per-root walk can ever reach it. The
gate must report `SELF-CHECK FAILED` and exit non-zero.

Deliberately absent: `scripts/reachability/entry-points.json`. That file only
supplies pretty labels for the roots; the seeds come from the graph's own
`entrypoint` node, so leaving it out proves the seeds were not read from prose.
