# Code-intelligence routing

**Verified 2026-08-05 against this checkout; amended 2026-08-24 for ADR-090's
LSP client seam.** Every claim below was checked, not assumed. If you are
reading this because a session hook cited it, the short version is at the top.

## The position, in one line

**`gate:reachability` is the authority on what is dead; use `Grep` and `Read`
for structural questions today.** As of ADR-090 (2026-08-24) a language-agnostic
LSP client seam (`scripts/lib/lsp-client.mjs`) exists and is proven against the
live `typescript-language-server`, but it is a **seam, not yet the authority**:
VI's extractor has not yet been re-sourced onto it, so the answers below still
govern. See "If an index is later registered" — ADR-090 is that migration
starting, under the same two constraints.

## What actually exists

| Thing | Status | How this was checked |
|---|---|---|
| `revoy.lsp` MCP server | **does not exist** | no such server; the name survives only in prose, now corrected |
| `scripts/lib/lsp-client.mjs` | **real seam, proven, not yet authoritative** | ADR-090: language-agnostic LSP stdio client (documentSymbol, call hierarchy, references), driven against the live `typescript-language-server` in `scripts/tests/lsp-client.test.mjs`. VI does not yet source its graph from it. |
| `.codegraph/codegraph.db` | **does not exist** | `.codegraph/` is a symlink holding one 72-byte `source.json` and no database |
| `codegraph` MCP registration | **not registered** | this repository has no `.mcp.json` |
| `scripts/reachability.mjs` | **real, wired, blocking** | builds its own TypeScript program; run it |
| `scripts/registration-integrity.mjs` | **real, wired, blocking** | dead entrypoints, CLI dispatch drift, unregistered MCP tools |
| `packages/arbor-mcp/tests/roundtrip/manifest.ts` | **real** | every supported catalog kind must name a real conformance test |

## Why this file exists at all

A hook cited it as the authoritative routing policy, and it did not exist. A
pointer to a missing policy is the same defect class the policy is about: a
claim with nothing behind it.

Worse, the advice that *was* in circulation pointed at `revoy.lsp` and a
symbol-graph database, neither of which is here. That is not a harmless
inaccuracy. Routing advice toward an absent tool does not degrade to neutral —
it spends the reader's budget looking for the tool, and it crowds out the
approach that would have worked.

The cost is measured, not hypothetical. In a four-agent forensic audit of this
branch, the structural auditor had to reconstruct call graphs by hand; confirming
that `OperationRecord` lacks a `kind` field took roughly **eight file reads across
three packages**. One `find_references` call would have collapsed that to one.
That is the business case for building an index — and equally the case for not
pretending one exists.

## How to answer structural questions today

1. **"Is this symbol reachable?"** — `node scripts/reachability.mjs --json`.
   Authoritative, and deliberately biased so a false LIVE is acceptable and a
   false DEAD is not. It proves *module-graph* reachability, not call-level: a
   symbol imported by a reachable module counts as reached even if no code path
   calls it. Confirm call-level reachability by reading.
2. **"Is this registered / dispatched / wired?"** —
   `node scripts/registration-integrity.mjs --json`. Covers dead entrypoints,
   CLI dispatch vs `--help` drift, unregistered MCP tools, catalog/dispatch
   drift, orphaned scripts.
3. **"Who calls this?"** — `Grep`. There is no index. Budget for it.
4. **"Is this claim in the docs true?"** — `node scripts/docs-truth.mjs --json`,
   but note its stated limit: it reads **only `ROADMAP.md`**. Claims in
   `decisions/` and `docs/` — including this file — are outside every gate.
5. **Anything you are about to call dead** — cross-check with grep regardless of
   tooling. No static index sees a string-keyed dynamic registry.

## If an index is later registered

**ADR-090 (2026-08-24) is this, starting.** It records the decision to source
VI's static facts (symbol existence, find-callers, reachability) from an LSP
client over the mature per-language servers (`typescript-language-server`,
`rust-analyzer`, `pyright`, `clangd` — all installed here), keeping VI's graph
and governance overlay and carrying a per-language soundness flag. The client
seam (`scripts/lib/lsp-client.mjs`) has landed and is proven; the swap of VI's
extractor edge-source onto it is sequenced follow-on work. Both constraints
below are honored: the gates do not yet depend on it, and enforcement stays
advisory. The "who calls this? — Grep, budget for it" answer above is what
that migration is designed to replace with a `callHierarchy/incomingCalls`
lookup.

Two constraints that must not be traded away:

- **The gates must not depend on it.** `reachability.mjs`, `docs-truth.mjs` and
  `anti-stub.mjs` each state in their headers that they run from a clean
  checkout with no `.codegraph/` and no MCP tooling. That is deliberate: CI runs
  from a fresh clone, and a gate that needs box-local state is not a gate. Those
  header lines are correct and should stay.
- **Enforcement stays advisory.** revoy-spec's ADR-029 (`implementation:
  Complete`) settled this shape for the same problem: route through the index,
  gate it on real coverage with a drift preflight, name the exemptions where raw
  `Read` is correct, and keep enforcement **advisory by default, opt-in hard,
  never default-blocking**. That matches this repository's REPORTED ceiling
  (ADR-025) and is worth adopting rather than re-deriving.

For the build-vs-depend question, note that revoy-spec's ADR-042 justified ~12k
LOC of Python over depending on a Go binary because of the subprocess/IPC seam.
revoy2 inverts that calculus: it is TypeScript and already depends on the
`typescript` compiler, so the compiler API is both a better symbol source for TS
and a near-zero-cost seam.

## Keeping this file honest

Nothing gates it. `docs-truth.mjs` reads only `ROADMAP.md`, so every table above
is an unwitnessed claim by this repository's own standard. Re-verify before
relying on it, with the exact commands in the "How this was checked" column —
and if you find it stale, fix it rather than working around it.
