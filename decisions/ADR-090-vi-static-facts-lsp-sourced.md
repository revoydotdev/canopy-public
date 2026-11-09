# ADR-090: VI Static Facts Sourced From LSP Over Mature Language Servers

**Status:** Accepted
**Date:** 2026-08-24
**Authoring Revision:** 375e0c7df8798d31bcbb2f6755b989765b98b7d8
**Content ID:** sha256:5929df0c8ac257fa148618de9d2c5d99999f0bb5cb93a7e405e24bfe7065aa73

## Context

Visual Intelligence (VI, ADR-042) reasons over three planes: a *derived*
plane (a static graph of symbols, calls, reachability, and tests), an
*intended* plane (the governance overlay — ADRs, obligations, waivers mapped
onto the graph), and an *observed* plane (runtime coverage). The derived plane
is produced by a per-language graph extractor —
`.claude/skills/repository-visual-intelligence/scripts/vi-extract-ts.mjs` —
which today handles TypeScript only, via the TypeScript compiler API.

The harness's goal is to build *its own codebase* and, beyond that, general
repositories across languages. That raises a real design question the operator
posed directly: does VI's per-language extractor break worse as it meets Rust,
Go, Python, C/C++, and the rest? Writing and maintaining a bespoke extractor
per language — each mapping a different analysis backend into VI's graph
schema, each needing its own tuning and gating — is a maintenance treadmill,
and a per-language extractor that silently under-analyzes a dynamic language is
worse than none.

Two facts, verified rather than assumed, reframe the question:

1. **The static facts VI needs are a standard LSP capability.** Symbol
   existence is `textDocument/documentSymbol`; find-callers and reachability
   are `textDocument/prepareCallHierarchy` + `callHierarchy/incomingCalls`/
   `outgoingCalls`; reference lookup is `textDocument/references`. Call
   hierarchy has been in the LSP spec since 3.16 and is implemented by the
   mature server for every major language — `gopls`, `rust-analyzer`,
   `typescript-language-server`, `pyright`, `clangd`, `jdtls`.
2. **Those servers wrap the same dependable native backends a bespoke
   extractor would have to call directly.** `gopls` *is* `go/packages`/
   `go/types`; `rust-analyzer` *is* the `ra_ap_*` crates; `typescript-language-
   server`/`tsserver` *is* the TypeScript compiler API VI already uses;
   `clangd` *is* the clang AST. LSP is the *uniform interface over* the exact
   analysis engines a per-language extractor would otherwise wrap one at a
   time.

This box confirms the availability empirically:
`typescript-language-server`, `rust-analyzer`, `pyright`, `clangd`, and
`vscode-json-language-server` are all installed and drivable (only `gopls` is
absent). So the corollary-coverage test the operator set — "if there is an
equivalent dependable API for the big languages, make it robust and keep it" —
is met: the coverage exists, and LSP is how VI reaches it without an extractor
per language.

A separate, independent problem lives in the observed plane. The `catalog_gap`
finding — "N files in package X load but are never invoked" — is not a
static-analysis result at all. It reports that the declared *scenario catalog*
never drove a module in a captured run. Its own body always read "The catalog
does not exercise these modules." Because the captured traces are necessarily
incomplete, `catalog_gap` flags heavily-used core files (e.g.
`arbiter-intake.ts`, `exit-codes.ts`) as "never invoked", and routing that
through `gate:vi-findings` demanded a recorded human verdict, with an expiry,
per package — flooding the operator triage queue with leads about the catalog
rather than the code.

## Decision

**1. VI sources its static facts through one LSP client, not a per-language
extractor.** `scripts/lib/lsp-client.mjs` is a language-agnostic LSP stdio
client speaking exactly the requests the derived plane needs
(`documentSymbol`, `prepareCallHierarchy` + `incomingCalls`/`outgoingCalls`,
`references`). Adding a language becomes *pointing this client at that
language's server command*, not writing and maintaining a new extractor. The
client is real, not scaffolding: it is driven against the live
`typescript-language-server` in `scripts/tests/lsp-client.test.mjs`, and the
same client drives `rust-analyzer`/`pyright`/`clangd` because the protocol is
uniform. This is a lateral move for TypeScript (the compiler API and `tsserver`
are the same engine) whose whole value is generalization.

**2. The governance overlay is kept, and is fed from LSP-provided facts.** The
intended plane (ADR/obligation/waiver mapping) and the graph model are
unchanged; only the *source* of the derived symbol/reference/reachability facts
moves to LSP. LSP resolves symbols and calls; it does not know what an ADR
obligation is. The migration replaces the extractor's data source, never the
governance model layered on top of it.

**3. Each language carries an explicit soundness flag.** Reachability from a
compiler-grade backend (TypeScript, Go, Rust, C/C++, Java) is sound; from a
dynamic language (Python via `pyright`) it is best-effort and must be labelled
so, never presented with the same confidence; and HTML/CSS have no call graph
at all — they are out of the reachability model and, if analyzed, use a usage
model (`documentSymbol`/`references`), not call hierarchy. VI must record which
regime produced a fact rather than flattening them into one "unreachable"
verdict.

**4. `catalog_gap` is demoted from a per-finding human-verdict obligation to an
advisory coverage signal.** `scripts/vi-observed-compare.mjs` no longer merges
`catalog_gap` into the `gate:vi-findings` store; `buildCatalogCoverageReport`
writes it to `.visual-intelligence/observed/catalog-coverage.json` as an
advisory — a property of the scenario catalog's breadth, useful for improving
the scenario set, but not a per-package human decision. `catalog_gap` remains
in the comparison's `OWNED_CATEGORIES` only so any prior run's `catalog_gap`
findings are purged from the store.

This is a direction plus an increment, not a claim that an immutable vendored
extractor was rewritten. `scripts/vi-lsp-facts.mjs` is the revoy-owned adapter
stage run by `vi-refresh`: it projects TypeScript document symbols, calls, and
reachability through the common client, records the compiler-grade *backend*
and the `semantic-symbol-call-reachability` fact regime in the manifest, and fails
the refresh when the server is unavailable. It projects those facts into the
canonical graph, with LSP evidence locations and backend soundness on every
projected edge. It does not fabricate a call edge where an LSP location cannot
yet be losslessly mapped to a graph identity: an in-scope unresolved or
ambiguous target is counted as `in_scope_targets_unmapped` coverage debt in
the graph directory's lsp-facts.json, while an out-of-scope target is counted separately as an
external target. That is deliberately non-blocking—blocking would make a
partial legacy graph unusable—but neither category is silently substituted with
an enclosing class, file, or arbitrary duplicate identity.

## Consequences

Adding a language stops being an extractor-authoring project and becomes a
server-registration entry, over backends the language's own tool team
maintains — the maintenance treadmill the operator flagged is removed at its
root. VI gains an honest multi-language reachability story with per-language
soundness rather than a silent TypeScript-only assumption. The operator triage
queue sheds the `catalog_gap` noise (10 package-level findings, including false
"never invoked" flags on core files) while the coverage signal is preserved as
an advisory for improving the scenario catalog.

The costs: an LSP client is a new runtime dependency on external server
processes (spawn, initialize handshake, per-request timeouts) — heavier and
more asynchronous than an in-process compiler call, and dependent on the target
language's server being installed. The LSP stage now replaces the canonical
call, reference, instantiation, and reachability relations after the vendored
adapter supplies node identities. Python's best-effort soundness is a permanent
caveat of the language, not a defect this decision can remove — only label.

## Alternatives / Roads not taken

**Retire VI's derived plane entirely in favor of raw LSP.** Rejected: the
governance overlay and the graph model are the leverage, and LSP provides
neither. The problem was never the model; it was the per-language *source* of
its facts. Throwing out the model would discard the intended plane that makes
VI a governance instrument rather than a code browser.

**Keep bespoke per-language extractors, one per language, each wrapping that
language's native API directly** (`go/packages`, `ra_ap_ide`, `jedi`/`pyright`,
clang libtooling). Rejected: this is exactly the maintenance treadmill the
operator questioned. Every extractor is a different API mapped into VI's schema,
separately tuned and gated — N integrations to maintain where LSP is one, over
those same backends.

**Leave `catalog_gap` as a human-verdict finding but lower its severity.**
Rejected: severity does not change the category error. `gate:vi-findings`
requires a recorded verdict for any finding in its store regardless of severity,
so a low-severity `catalog_gap` still demands per-package operator dispositions
for a catalog-coverage metric. The fix is to move it out of the human-verdict
store, not to relabel it inside it.

## Obligations

### O1 — The LSP seam is real: it resolves symbol existence and find-callers against a live language server

The `LspClient` drives an actual `typescript-language-server` over stdio and
returns `documentSymbol` (symbol existence) and `prepareCallHierarchy` +
`incomingCalls` (find-callers) for a real caller relationship — the two static
facts VI's derived plane needs, from the uniform protocol that generalizes to
every installed server. Proven end-to-end, no stub.

<!-- proof: symbol=LspClient file=scripts/lib/lsp-client.mjs roundtrip=scripts/tests/lsp-client.test.mjs -->

### O2 — `catalog_gap` no longer enters the human-verdict findings store

`buildCatalogCoverageReport` produces the advisory catalog-coverage shape (a
per-package property of the scenario catalog, sorted and deterministic) that
carries no `catalog_gap` finding category and never lands in
`gate:vi-findings` — demoting the catalog-coverage signal out of the
per-package operator-verdict obligation while preserving it as advice.

<!-- proof: symbol=buildCatalogCoverageReport file=scripts/vi-observed-compare.mjs roundtrip=scripts/tests/vi-catalog-coverage.test.mjs -->

### O3 — Refresh records LSP provenance and fails without its language server

`vi-refresh` invokes the owned `vi-lsp-facts.mjs` stage after the vendored
shape extractor and refuses any result whose call hierarchy, top-level semantic
references, reachability, and canonical-edge projection are not projected. The
stage records `lsp_static_facts` with an explicit fact regime, exact-only
identity mapping, and the coverage-debt policy; it recomputes graph-node status
from those facts, and never falls back to compiler facts when the registered
server cannot start. LSP-only nested declarations retain symbol-existence
provenance but receive no fabricated reachability verdict. An in-scope unmapped
target is explicit coverage debt, not a blocking refresh failure or a guessed
edge.

<!-- proof: symbol=LSP_FACT_PROJECTION file=scripts/vi-lsp-facts.mjs roundtrip=scripts/tests/vi-lsp-facts.test.mjs -->
