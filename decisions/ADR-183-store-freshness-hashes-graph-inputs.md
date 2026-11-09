# ADR-183: Store Freshness Hashes the Graph's Inputs, Not Its Bytes

**Status:** Accepted
**Date:** 2026-10-06
**Authoring Revision:** fd77110c437db4ea710b479739ff5395b4f98bee
**Content ID:** sha256:57e527249f8a4db9d4d402c3247617a595c221b7ab288e1bb544ed0b681e1d99

## Context

Authored as Proposed, not Accepted: the implementing agent does not hold
acceptance authority (AGENTS.md checks-and-balances). This record amends
ADR-169's store-provenance clause and its obligations O1 and O2; the rest of
ADR-169 (the graph is not committed) stands unchanged.

ADR-169 kept `.visual-intelligence/graph/` an input of the `completion-depth`
and `vi-observed` store hashes by walking the gitignored directory from disk
and hashing its bytes. Those bytes are not a function of the source tree.
Every graph record is stamped with the revision it was built at
(`first_seen`, `last_verified`), and `first_seen` is carried forward from
whatever prior graph sat on that disk. Observed on 2026-10-06: a graph
regenerated at `fd77110c` in a fresh worktree stamps all 37,312 nodes with
`fd77110c`, while the graph `evidence:rebind` built at `354f023f` carries
37,254 nodes stamped `f3b4bca6`. The three JSONL files differ from the first
record onward.

So a store bound in one checkout could not be reproduced in any other. The
pre-push candidate is a fresh detached worktree with no graph:
`gate:vi-prepush-policy` either only checks the input binding
(`exact_binding_only`) or runs `vi-refresh --check`, which by design leaves no
graph behind. `gate:store-freshness` therefore failed both stores on every
governed push, and the only explanation it could give was "no
dirty/untracked/committed-since input identified". ADR-169 assumed that
pre-push "already regenerates" the graph, which was not true. Earlier pushes
got through only because the hook exits early outside a governed run
(`ARBOR_GOVERNED_RUN`). Recomputing `03401352`'s committed manifests from its
tree alone does not reproduce them either.

## Decision

A store that reads the graph depends on the graph's declared input closure,
not on the graph's bytes. `scripts/lib/store-provenance.mjs` drops the
on-disk walk of `.visual-intelligence/graph/`. For every store in
`GRAPH_CONSUMING_STORES` (`completion-depth`, `vi-observed`), it unions the
store's own `STORE_SCOPES` entry with the same `targetInput`/`toolInput`
predicate that `computeViInputBinding` hashes and that `gate:vi-freshness`
holds blocking against the committed graph manifest. Every hashed path is
repo-relative and committed or committable. As a result, the same tree yields
the same store hash in every checkout, with or without a local graph.

## Consequences

**Positive.** A store bound by `evidence:rebind` in one worktree verifies in
the pre-push candidate and in CI. Every input that can move the graph still
invalidates both stores (for example decisions/, ROADMAP.md, the reachability
entry points, the VI producers themselves, and bun.lock), so the dependency is
wider than the graph's bytes, never narrower. A mismatch now names the
changed input path instead of reporting that nothing changed.

**Negative.** Both stores now track every graph input. An ADR or ROADMAP
edit stales them even when the graph would come out structurally identical.
This is over-invalidation, the safe direction. The two stores' input sets
also coincide in this repository, because the graph closure contains both
scopes.

**Negative, load-bearing.** Store freshness no longer notices a store that
was refreshed against a stale local graph and then had the graph rebuilt
underneath it. ADR-079's graph-before-stores ordering in
`arbor evidence refresh` remains the only guard for that ordering.
Before this record, the byte hash caught the problem only on the machine that
made the mistake, and it failed every other checkout. A stronger follow-up
is possible: record the graph manifest's `input_binding` that the producer
consumed in each store manifest, and compare it to the live binding. That
change touches the producers and is not decided here.

**Remedy for existing stores.** The committed `completion-depth` and
`vi-observed` manifests carry hashes in the old scheme. One
`evidence:rebind` after this change lands rebinds them.

## Alternatives / Roads not taken

- **Hash the graph with its provenance stamps stripped.** This still needs a
  graph on disk, which the pre-push candidate never has, and it still depends
  on LSP output. That output timed out under contention on this machine
  during the same investigation.
- **Regenerate the graph in the pre-push candidate before store freshness
  runs.** This costs minutes of LSP per push, and it reintroduces the
  contention-sensitive regeneration that ADR-169 removed from pre-push.
- **Treat an absent graph as fresh.** This passes on absence, which is the
  unmeasured-reads-as-clean failure ADR-094 forbids.

## Obligations

### O1 — A graph-consuming store's hash is the same with no graph, a different graph, or a graph in another checkout of the same tree

<!-- proof: symbol=computeEvidenceContentHashForStore file=scripts/lib/store-provenance.mjs roundtrip=scripts/tests/store-scoped-provenance.test.mjs -->

### O2 — Every graph input still invalidates a graph-consuming store, so the dependency is no narrower than the graph

<!-- proof: symbol=evidenceInputPathsForStore file=scripts/lib/store-provenance.mjs roundtrip=scripts/tests/store-scoped-provenance.test.mjs -->
