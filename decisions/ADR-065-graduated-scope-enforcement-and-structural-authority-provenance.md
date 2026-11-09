# ADR-065: Graduated Scope Enforcement and Structural Authority Provenance

**Status:** Accepted
**Date:** 2026-08-15
**Authoring Revision:** f12053c562f03a0d17f7693ec4ccdd75b1d37e16
**Content ID:** sha256:ef9415295fd7173d5370bad13e0722f64d5b1aa34c47301bf653c32a3b8c16e1

## Context

Cycle-2's research manifest (qa-bench/manifests/CYCLE2-MANIFEST.md — external
research-tooling output, never checked into this repository,
synthesized from cycle2-least-privilege.md, arXiv 2603.28166 "GrantBox" and
2604.04522 "HDP") identified a gap in the G-SCOPE write-scope enforcement
`worktree-machine-verifier.ts` gained in e32e16e: an AUTHORED scope (planner-
or operator-derived, `cli.ts`'s `scopeIsAuthored`) binds the worktree diff and
fails closed on any mismatch, but a MINED scope (heuristically text-mined from
the task by `arbiter-intake.ts`, `direct`/`reviewed` tier) has NO check at
all. The ab3 bench's T2 task exposed both halves of the resulting failure
mode at once: a mined scope named only test/throw.test.js, the real fix
lived in `lib/`, and (a) the specialist could not even be trusted to touch
`lib/` under the pre-existing zero-enforcement posture, while (b) if mined
scopes were simply given the same hard-block enforcement as authored scopes,
a text-mined guess would routinely fail correct work outright — a guess is
not authority.

Both halves trace to the same root cause: a mined scope's write authority is
derived by regex over task prose, with no visibility into what the code
actually imports. `RepositoryGraphIndex` (`repository-graph.ts`) already
maintains a cached import graph for the native repository tools; nothing in
`arbiter-intake.ts`'s pure `extractDeclaredScope` consulted it.

## Decision

Three additive changes, all confined to the enforcement/mining seams that
already exist; no new gates, agents, or ledger classes beyond one additive
`AuditRecord` variant.

**Graduated enforcement (`worktree-machine-verifier.ts`, `cli.ts`).**
`WorktreeMachineVerifierOptions.write_scope_for_node` now returns a
`DeclaredWriteScope { paths, enforcement: "block" | "audit" }` instead of a
bare path list. `"block"` reproduces G-SCOPE's original behavior exactly — a
mismatch fails verification outright. `"audit"` is the new middle tier:
verification proceeds normally on a mismatch, and the mismatch is carried as
a `ScopeMismatchObservation` on the verification outcome
(`out_of_scope_observation`, present on both `"verified"` and `"failed"`
outcomes) instead of blocking. `cli.ts`'s `createDeclaredOutputsVerifier`
supplies `enforcement: "block"` when `scopeIsAuthored(campaignId)` and
`"audit"` otherwise — the SAME structural check that already gated whether
G-SCOPE ran at all, now gating only how strictly it binds. The enforcement
tag is a closure value fixed by which code path constructed it; nothing in
`verifyOutcome` reads the specialist's `final_message`, its conversation
history, or any arbiter-produced field to decide it, so no model output can
launder a mined scope into `"block"` or an authored one into `"audit"`.

**Durable audit trail (`arbor-audit/src/audit.ts`).** A new additive
`AuditRecord` variant, `ScopeObservationRecord` (`kind: "scope_observation"`,
minted `scopeobs_` ids), records `{declared, observed_out_of_scope,
enforcement: "audit" | "blocked", idempotency_key}` per campaign/node,
mirroring the append/idempotency/hash-chain shape `WaiverOutcomeRecord`
established (ADR-063, E-8) and dispatched through `verifyIntegrity` and
`parseTraceId` exactly like every other kind. This closes the ledger-side
half of the seam: an authored block and a mined flag now leave the same
class of durable evidence, differing only in `enforcement`.

**Journaling contract point — WIRED (verified 2026-08-18).** The paragraph
below describes the seam as unwired because `manager.ts` and `loop.ts` were
owned by a concurrent workstream when this record was authored. Both halves
have since landed: `packages/arbor-opencode/src/loop.ts:2096` sets
`scope_observation`, and `CampaignManager.journalResult` calls
`target.recordScopeObservation` at `packages/arbor-mcp/src/manager.ts:3018` —
exactly beside the `target.recordWaiverOutcome` call this record predicted. The
original text is kept for the record of what was open: `EvidenceLedger`
exposes `recordScopeObservation`/`getScopeObservations`, and
`WorktreeMachineVerifier`'s outcome carries everything a caller needs
(`out_of_scope_observation`). The actual call from "a node's verification
outcome" to "a `scope_observation` record" belongs in
`CampaignManager.journalResult` (`manager.ts`, private method, called from
`recordResult`) — the exact seam `WaiverOutcomeRecord` already uses for
`params.review_waived` (see `manager.ts:2679-2716`). `manager.ts` is outside
this workstream's authorized file scope (owned by a concurrent workstream
sharing this cycle); wiring it is a bounded follow-up: thread
`out_of_scope_observation` from `verifyOutcome`'s result through whichever
caller invokes `recordResult` after verification (`loop.ts`, also outside
this workstream's scope) into `journalResult`'s `params`, then call
`target.recordScopeObservation` beside the existing
`target.recordWaiverOutcome` call. Until that follow-up lands, an audit-tier
mismatch is real, observable evidence on the verification outcome and
protects the campaign from ever blocking on it, but does not yet appear in
the durable ledger a `governance` read projects from.

**Structural scope widening (`arbiter-intake.ts`, `cli.ts`,
`native-arbiter-transport.ts`).** `extractDeclaredScope` stays pure
(text-mining only, unchanged). `createHeuristicArbiterIntakePort` gains an
optional `options.structural_paths?: (path) => readonly string[]` resolver.
For each mined `write_path` that looks like a test file (a `test`/`tests`
directory segment, or a `.test.`/`.spec.` filename marker), the resolver's
returned direct non-test import paths are appended to the mined
`write_paths` — deduped, bounded to 8 total additions across the whole call,
silent on an absent or throwing resolver (this can only ADD authority, never
remove it, so a resolver failure is never a safety regression). `cli.ts`
supplies the resolver, backed by the same process-local `RepositoryGraphIndex`
the native repository tools already use (`query(root, {path, depth: 1})`,
filtered to edges the test file is the `from` side of), threaded through
`composeArbiterIntakePort`'s `NativeArbiterPortDeps.structural_paths`
(`native-arbiter-transport.ts`) to the heuristic port it always constructs
regardless of transport. A query failure is caught and treated as "no
widening," never surfaced.

Widening and graduated enforcement compose deliberately: widening can only
grow what a mined scope declares, and Y-1 keeps every mined declaration
soft-enforced regardless of how it was derived — so a wrong widening (a
resolver returning an unrelated path) can broaden what gets flagged as
in-scope, but it can never cause a block, because mined enforcement is
`"audit"` independent of how the mined paths were assembled.

## Consequences

A mined (`direct`/`reviewed`-tier) scope now leaves the same class of
observable evidence an authored scope always did, without inheriting its
hard-block risk — closing the "no check at all" half of the ab3 T2 failure
without reopening the "guessed command blocks correct work" failure S8
already fixed for the opportunistic acceptance-command tier. A test-named
mined scope is now more likely to actually grant write authority over the
file the fix lives in, closing the other half. The laundering threat model
this record explicitly defends against: a specialist or the arbiter model
itself cannot elevate its own enforcement tier by anything it writes into
`final_message`, conversation history, or a decision's `rationale` — the tag
is fixed before either ever runs, by a structural check over which
governance tier produced the campaign. The deliberate untracked-additions
exemption G-SCOPE already carried (harness session artifacts are legitimate,
additions are non-destructive) is preserved unchanged under both enforcement
tiers — Y-3's adversarial corpus asserts this explicitly rather than leaving
it implicit in the block-tier tests alone. The known gap is the journaling
contract point: until `manager.ts`/`loop.ts` wire `out_of_scope_observation`
into `journalResult`, `scope_observation` records exist as a durable,
tested, hash-chained ledger primitive with no production writer — an honest,
narrower gap than the "no check at all" this record replaces, and named
explicitly rather than silently left to be discovered at integration.

## Obligations

### O1 — The enforcement tag is fixed by structural provenance and cannot be laundered by model-produced text

<!-- proof: symbol=WorktreeMachineVerifier file=packages/arbor-mcp/src/worktree-machine-verifier.ts roundtrip=packages/arbor-mcp/tests/worktree-machine-verifier.test.ts -->

`verifyOutcome` never reads `final_message` or `history` to decide
`enforcement`; the tag is read only from the `DeclaredWriteScope` the
composition's `write_scope_for_node` closure returns. A specialist's
`final_message` containing forged enforcement/authority text does not change
the recorded `out_of_scope_observation.enforcement`.

### O2 — A mined-scope mismatch never blocks verification; an authored-scope mismatch always does

<!-- proof: symbol=WorktreeMachineVerifier file=packages/arbor-mcp/src/worktree-machine-verifier.ts roundtrip=packages/arbor-mcp/tests/scope-enforcement-adversarial.test.ts -->

`enforcement: "audit"` on a mismatch always yields a `"verified"` or
`"failed"` outcome consistent with the underlying verification command alone
(never forced to `"failed"` by the scope check itself), each carrying
`out_of_scope_observation.enforcement: "audit"`. `enforcement: "block"` on a
mismatch always short-circuits to `{ outcome: "failed" }` before any
verification command runs, carrying `enforcement: "blocked"`.

### O3 — Structural widening only adds non-test import paths to a mined scope naming a test file, bounded and silent on failure

<!-- proof: symbol=createHeuristicArbiterIntakePort file=packages/arbor-mcp/src/arbiter-intake.ts roundtrip=packages/arbor-mcp/tests/arbiter-intake.test.ts -->

With no `structural_paths` resolver, or a throwing one, `write_paths` is
byte-identical to `extractDeclaredScope`'s pure output. With a resolver,
paths are appended only for write_paths matching the test-file heuristic,
deduplicated, capped at 8 total additions, and a non-test mined path is
never widened.

### O4 — The `scope_observation` ledger record round-trips through persistence and the hash chain, and rejects a malformed instance

<!-- proof: symbol=validateScopeObservation file=packages/arbor-audit/src/audit.ts roundtrip=packages/arbor-audit/tests/scope-observation.test.ts -->

`recordScopeObservation` is idempotent on `idempotency_key`, participates in
`verifyIntegrity`'s per-kind dispatch and hash chain, survives a
`toJSONL`/`fromJSONL` round trip while minting a fresh id, and
`validateScopeObservation` rejects an empty `observed_out_of_scope` list, an
oversized path list/path, and an enforcement value outside `"audit" |
"blocked"`.

### Acceptance note

This record remains Proposed. ADR-059 requires acceptance authority separate
from the implementation and authoring authority used in this tranche.
