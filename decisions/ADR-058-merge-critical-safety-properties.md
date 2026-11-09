# ADR-058: Merge-Critical Safety Properties Must Be Rechecked After Composition

**Status:** Accepted
**Date:** 2026-08-12
**Authoring Revision:** 057e591f7563bfa15819f4f2b72eb01ca3bc4f25
**Content ID:** sha256:6ea434d82e90a19767d1a1aaf83649ea8357cf3e75e26d5c91491147f180c1e6

Authored as Proposed: implementation authority is not acceptance authority.

## Context

The multi-worktree integration postmortem's sandbox-`read` incident is the
motivating counterexample. A textual merge could retain a direct-filesystem
`read` underneath the new asynchronous sandbox design, compile, and satisfy
the then-existing suite while silently losing confinement. A green branch or
green general suite did not identify which security invariant the composed
edit was expected to preserve.

SafeMerge (arXiv:1802.06551) supplies the useful vocabulary: semantic
conflict-freedom means composition introduces no behavior beyond the branches'
intended union. This decision adopts that vocabulary, not SafeMerge's
Java/Boogie implementation. Merge-Bench (arXiv:2605.25890) reports that the
best commercial model in its 7,938-hunk benchmark correctly resolved fewer
than 60% of conflicts. An LLM may therefore propose a resolution, but cannot
be the oracle for trust-boundary merge correctness.

The audit also found that ADR-044's existing tests proved honest broker grades
and denied-network behavior but did not assert the postmortem's missing
property: native `file.read` routing through the injected broker. The existing
native-tool-host test was strengthened with a broker-only content witness so a
plausible direct-filesystem read now fails the actual registered property.

## Decision

`docs/merge-critical-properties.jsonc` is the canonical registry of
merge-critical ADR safety properties. Each row binds a stable property id and
human-readable statement to one ADR, conservative implementation globs, and
one reachable Vitest test file. A change to a watched implementation, its
test, its ADR, or the registry triggers the property. False-positive reruns
are preferred to false-negative selection.

`scripts/merge-critical-check.mjs` validates registry reachability at build
time and, for a Git diff range, reruns every triggered test with its ADR and
statement printed before execution. An unreachable ADR or test fails closed.
The integration conductor invokes the check on the fully rebased
`trunk..candidate` composition before its ordinary build and suite isolation
gate. This applies even when Git reported no textual conflict: clean textual
composition is the dangerous case this decision exists to cover.

The initial audit registers merge-critical properties from ADR-023, ADR-028,
ADR-043, ADR-044, ADR-049, and ADR-052. The governed-skills roadmap has a
reduction property but no landed ADR to attribute it to; inventing an ADR
mapping would corrupt provenance, so that absence is recorded in the handoff
rather than hidden. Future ADRs that declare a safety-case invariant must add
their registry row as part of the same roadmap.

## Consequences

A normal full-suite pass remains required, but is not sufficient merge
evidence by itself. The property rerun is separately legible and attributable,
so an integrator can see exactly which invariant a composed edit exercises.
The mechanism is intentionally not formal verification and does not claim to
prove arbitrary semantic conflict-freedom; its strength is bounded by the
declared property tests and conservative watch coverage.

Changing a broad hot file may rerun multiple or repeated suites. That cost is
accepted at composition time. Registry drift is visible at the whole-repo
build boundary rather than degrading silently.

## Obligations

### O1 — Conservative selection reruns every property whose implementation, ADR, test, or registry is touched

<!-- proof: symbol=selectMergeCriticalProperties file=scripts/lib/merge-critical.mjs roundtrip=scripts/tests/merge-critical-check.test.mjs -->

### O2 — The sandbox-read bypass is rejected by a broker-routing witness even when direct reading would return plausible content

<!-- proof: symbol=createNativeRepositoryToolHost file=packages/arbor-mcp/src/native-tool-host.ts roundtrip=packages/arbor-mcp/tests/native-tool-host.test.ts -->

### O3 — Missing ADR and test targets fail registry verification at build time

<!-- proof: symbol=verifyMergeCriticalRegistry file=scripts/lib/merge-critical.mjs roundtrip=scripts/tests/merge-critical-check.test.mjs -->

### O4 — The integration conductor runs attributed properties before ordinary isolation verification and never advances trunk on failure

<!-- proof: symbol=landBranch file=scripts/lib/conductor/land.mjs roundtrip=scripts/tests/integration-conductor.test.mjs -->
