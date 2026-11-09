# ADR-188: VI Plane Is One Transaction; Graph Stores Record the Graph They Consumed

**Status:** Accepted
**Date:** 2026-10-07
**Authoring Revision:** f3100ff189dfe4ebb474b414e780b7338859868a
**Content ID:** sha256:e72293b23cb2d371cf38e4e88cbdba9098afd7c7eff839cb88de1666ad006ab0

## Context

Authored as Proposed: the implementing agent does not hold acceptance authority. This record amends ADR-169 (the graph is not committed), ADR-090 (LSP-sourced static facts) and ADR-183 (store freshness hashes graph inputs). It implements the follow-up ADR-183 named and left undecided.

**Defect 1, non-transactional plane writes.** `vi-refresh` runs its stages in sequence and each updates `.visual-intelligence/` in place. When the LSP stage failed (tsserver killed, or a 60s request timeout under host load) the extractor had already written nodes, edges and evidence, and the run aborted with a half-written graph on disk. The next successful refresh read that pair as its prior generation and, correctly, recorded a `generation_mismatch` extraction gap (prior manifest counts differ from the prior files). `gate:vi-freshness` refuses that gap at pre-push, and recovery meant deleting the graph cache and rebinding.

**Defect 2, lost stale-graph check.** ADR-183 made `completion-depth` and `vi-observed` hash the graph's input closure, so `gate:store-freshness` no longer notices a store refreshed against a stale local graph. Only the graph-before-stores ordering in `arbor evidence refresh` guarded that.

## Decision

**The generated plane is one transaction.** `vi-refresh` snapshots `.visual-intelligence/` before the first stage (`beginPlaneTransaction`). Exit 0 commits (discards the snapshot). Any other exit, or a thrown error, rolls back: the previous graph, manifest, findings and views are restored byte-for-byte. Settling is idempotent and exclusive, so an explicit stage rollback followed by the outer handler cannot restore twice. `--check` keeps its existing contract: it rolls back on success as well. The extractor's `generation_mismatch` detection is unchanged and still fires for a plane that is inconsistent when a run starts.

**Graph stores record the graph they consumed.** `completion-depth` and `vi-observed` write `graph_input_binding`, the `input_binding.content_hash` of the committed `.visual-intelligence/manifest.json` at the time they were produced. `gate:store-freshness` compares it to the current graph manifest and fails on a mismatch with the standard remedy. A store with no record, or a graph manifest with no `input_binding`, fails as UNMEASURED, never as a pass. No graph bytes are read, so a fresh checkout with no graph passes whenever the committed manifest agrees.

## Consequences

**Positive.** An aborted refresh leaves the last good plane in place and the next run records no gap. The stale-graph check ADR-183 gave up is back without byte dependence.

**Negative.** Each refresh copies the plane (graph, views, observed store) to the temp directory first. A SIGKILL of `vi-refresh` itself skips the rollback and leaves a partial plane; the next run reports it as `generation_mismatch`, which is the intended, meaningful use of that gap. The two store manifests gain a field, so existing committed manifests fail as UNMEASURED until one `evidence:rebind` regenerates them.

## Alternatives / Roads not taken

- **Build the graph in a sibling temp directory and rename it into place.** The stages resolve `.visual-intelligence/` from `--root` and read prior state from it (carry-forward, `generation_mismatch`), and the manifest sits beside the graph rather than inside it. Redirecting every stage is a wider change than snapshot and restore, for the same failure-path guarantee.
- **Delete the generation_mismatch check.** It is the only detector for a genuinely inconsistent plane.
- **Hash graph bytes again.** Rejected by ADR-183: not reproducible across checkouts.

## Obligations

### O1 — A refresh that fails after a stage wrote leaves the previous plane byte-identical

<!-- proof: symbol=beginPlaneTransaction file=scripts/vi-refresh.mjs roundtrip=scripts/tests/vi-refresh-transaction.test.mjs -->

### O2 — A graph store consumed against a different graph binding is not fresh, and a graph-less checkout with a matching committed binding is

<!-- proof: symbol=assessEvidenceProvenance file=scripts/lib/store-provenance.mjs roundtrip=scripts/tests/store-scoped-provenance.test.mjs -->
