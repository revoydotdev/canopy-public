# ADR-030: Liveness Is Attested by Invocation, Over the Seam Catalog

**Status:** Accepted
**Date:** 2026-08-07

Authored as Proposed, not Accepted: the implementing agent does not hold
acceptance authority (AGENTS.md checks-and-balances, applied to ADR governance
by ADR-024's ratification note), and POL-05 flags any record arriving already
accepted as never having traversed the lifecycle.

## Context

Every gate this repository had before this record answers a **static** question:

| Gate | Question |
|---|---|
| `tsc --build` | does this symbol exist and typecheck |
| `gate:reachability` | is it reachable from a declared entry point |
| `gate:obligations` (`roundtrip=`) | does a test naming it exist and get collected |
| 6.3 roundtrip manifest | does each supported kind have a named conformance test |
| `gate:docs-truth` | does a document's citation resolve |
| `gate:anti-stub` | does its shape match a known stub pattern |

None of them calls anything. The repository's own graph model states the
consequence: `.visual-intelligence`'s views carry the line *"Hollow defects —
reachable code short-circuited by a guard on an unset value — are not
structurally detectable and are NOT shown. Their absence from this view is not
evidence of absence."*

That absence has been expensive, and the record is specific:

- **`diagnostics`** issued `event.resume` with `cursor: 0` where
  `RuntimeCursor` is `{stream_id, sequence}`. The call site existed and was
  reachable; validation rejected it on **every** dispatch; the screen never
  rendered a real event on any run. It also had a passing screen-projection
  test. Every gate above was green.
- **G-34** — `modelCapabilityTokenBridge` never forwarded its `modelId`, so a
  real, tested, wired provider adapter was permanently dark.
- **G-03** — `RecoveryService.execute` had a live call site guarded on an option
  nothing set, so recovery always rejected.
- **G-29** — eight catalog kinds advertised `supported: true` and were rejected
  before dispatch.

The shape is constant: **the code is present and reachable, and does not work.**

There is a second, sharper reason this matters now. An LLM agent has no
persistent mental model of a system; it has a context window and whatever it can
rediscover. The dominant long-horizon failure mode is not carelessness, it is
that the agent's model of the system silently diverges from the system. Six gap
register rows in this repository described a world that had already moved on —
including two that reported open blockers which no longer existed. A static map
the agent must reconstruct is exactly the artifact that drifts.

## Decision

**Attest liveness by invocation, over the seam catalog that already exists, and
expose the result through the same surface an agent dispatches through.**

Five bindings:

1. **Probe seams, not symbols.** The unit is a `RUNTIME_CATALOG` entry, not an
   exported function. A per-symbol probe table would be a second source of
   truth about contracts that `*-contracts.ts` already owns — the precise
   duplication `tools.ts` rejected when it chose two generic pass-through tools
   over ~102 per-kind ones <!-- sur-05:historical (catalog size when this record was accepted; the catalog has grown since and this figure is not a live claim) -->. The catalog is derived and already exists; this adds
   invocation, not inventory.

2. **Four outcomes, never two.** `answered` / `refused` / `unreachable` /
   `indeterminate`. A binary result would score `a2a.send` correctly declining
   without a configured secret identically to the broken `diagnostics`, and the
   defects all live between the poles. `indeterminate` carries this
   repository's governing rule into its own instrumentation: a missing
   measurement is a typed absence, never a zero.

3. **Two families, because "callable" and "called correctly" are different
   claims.** *Catalog* liveness asks whether a seam answers when invoked
   correctly. *Consumer* attestation replays the request a real consumer sends.
   Only the second finds the diagnostics class — a catalog probe would have
   reported `event.resume` perfectly healthy, because the prober's own cursor
   was well-formed.

4. **A `validation` failure means different things by author.** From the prober
   it is ambiguous (its payload is a fixture and may be wrong) and reports
   `indeterminate`. From a consumer it is the finding itself — that request
   shape is the thing under test — and reports `unreachable`. Collapsing the two
   would have downgraded the real defect to "nothing is known" and let it pass.

5. **Attestation is a byproduct of invocation, never a claim by a component.**
   Nothing is asked whether it is healthy. G-22 and G-25 were both components
   asserting `verified` provenance with a fabricated `stdout_hash` for a command
   that never ran; a self-attesting component, under an agent that writes both
   the component and its attestation, is that defect with extra steps.

The probe runs against a router an `ArborMCPServer` actually built, with a real
persistence directory — not a hand-assembled one. The first version omitted the
directory and duly reported `output.list` as "not configured": a true statement
about a runtime nobody ships.

`devtools_liveness` exposes the report as an MCP tool (ADR-021's inspector
family), so **the map and the control plane are the same object**. That is the
part that is specifically LLM-native. A human does not need the architecture
diagram to be callable; an agent benefits enormously, because it can ask the
running system what is alive instead of inferring it from source.

## Consequences

**Positive.** A defect class that passed every existing gate is now detectable
before merge. `gate:liveness` blocks on any unreachable seam or consumer, and
ratchets unprobed seams against a floor. On the first run it confirmed something
no static gate could: all three `supported: false` kinds refuse with their own
declared reason, which is the catalog being honest about itself.

**Negative, and load-bearing.** The consumer table **mirrors** requests that
real consumers issue, and a mirror can drift from what it mirrors. This is a
genuine weakness, not a rounding error. Two things bound it: drift surfaces as a
changed outcome rather than a false green, and `consumersCoverScreens` fails
when a screen gains a dispatch with no declared consumer. Executing the
consumers themselves — driving a real terminal — would remove the weakness and
is not attempted here.

**The honest ceiling.** An `answered` attests that a well-posed request reached
a handler that produced a result. It does not attest that the result is
*correct*, that any consumer renders it, or that a human would recognise it.
This measures **liveness and citation integrity, not correctness.** The screen
tests and roundtrip conformance suites remain necessary and are not replaced.

**Mutating kinds are not invoked by default**, so 27 of 54 seams report
`indeterminate` rather than health. Probing them for real requires accepting
that `campaign.halt` halts something. That is a deliberate coverage gap held at
a floor, and it is reported rather than hidden.

## Alternatives considered

1. **A tool per functional element, as originally proposed.** Rejected: at 622
   exported symbols, the MCP surface becomes a mirror of the codebase and drifts
   faster than the code. The repository has spent two sessions deleting
   hand-maintained mirrors.
2. **Binary green/red attestation.** Rejected under Decision point 2 — it
   cannot distinguish a working refusal from a broken seam, which is most of
   the interesting space.
3. **Components self-attest.** Rejected under Decision point 5. This is the
   fabricated-evidence shape, and an agent writing both sides makes it worse.
4. **Extend `gate:reachability` instead.** Rejected: it answers a genuinely
   different question — reachable-from-an-entry-point — and it correctly said
   the diagnostics call site *was* reachable. Nothing static could have caught
   it.

## Test implications

An instrument's tests must establish that it cannot be fooled: that `answered`
follows an actual dispatch, that a non-trivial number of seams answer (so the
gate cannot pass by measuring nothing), and that the historical `cursor: 0`
defect is reported as `unreachable` while the same consumer with a well-formed
cursor is reported as `answered`.

## Obligations

### O1 — Liveness outcomes are four-valued; a working seam that declines is never reported as a failure

<!-- proof: symbol=classifyRuntimeError file=packages/arbor-mcp/src/liveness.ts roundtrip=packages/arbor-mcp/tests/liveness.test.ts -->

### O2 — A `validation` failure from a consumer's own request is a finding, not an ambiguity

<!-- proof: symbol=classifyRuntimeError file=packages/arbor-mcp/src/liveness.ts roundtrip=packages/arbor-mcp/tests/liveness.test.ts -->

### O3 — Every declared catalog seam is probed exactly once, including those declared unsupported

<!-- proof: symbol=probeCatalog file=packages/arbor-mcp/src/liveness.ts roundtrip=packages/arbor-mcp/tests/liveness.test.ts -->

### O4 — A seam with no declared probe reports `indeterminate`, never health

<!-- proof: symbol=probeCatalog file=packages/arbor-mcp/src/liveness.ts roundtrip=packages/arbor-mcp/tests/liveness.test.ts -->

### O5 — Consumer attestation replays the request a real consumer sends, and catches a malformed one

<!-- proof: symbol=probeConsumers file=packages/arbor-mcp/src/liveness.ts roundtrip=packages/arbor-mcp/tests/liveness.test.ts -->

### O6 — The declared consumer table cannot silently fall behind the screens it mirrors

<!-- proof: symbol=consumersCoverScreens file=packages/arbor-mcp/src/liveness-consumers.ts roundtrip=packages/arbor-mcp/tests/liveness.test.ts -->

### O7 — The probe runs against a router a real composition root built, not a hand-assembled one

<!-- proof: symbol=livenessRouterFromCompositionRoot file=packages/arbor-mcp/src/liveness-runner.ts roundtrip=packages/arbor-mcp/tests/liveness.test.ts -->

### O8 — The report is reachable as an MCP tool, so the map and the control plane are one object

<!-- proof: symbol=defineDevToolsTools file=packages/arbor-mcp/src/devtools.ts roundtrip=packages/arbor-mcp/tests/liveness.test.ts -->
