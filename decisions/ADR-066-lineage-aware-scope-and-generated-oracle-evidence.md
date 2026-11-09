# ADR-066: Lineage-Aware Scope Enforcement and Generated-Oracle Evidence

**Status:** Accepted
**Date:** 2026-08-15
**Authoring Revision:** 91bac0e01d922d06c89b25808fa37eaf399b617e
**Content ID:** sha256:9b8aadce01eac9b22c73366b76a35f12789111d310e99969394cbb7ef8036e38

## Context

ADR-065 (cycle-2) closed the "no check at all" half of a mined write scope's
enforcement gap with graduated enforcement (`"block"` for authored scopes,
`"audit"` for mined) and left one threat named but deferred: the check runs
per-node only. Cycle-3's research manifest
(qa-bench/manifests/CYCLE3-MANIFEST.md — external research-tooling output,
never checked into this repository, synthesized from
cycle3-path-policy.md, CAVA arXiv 2607.13716, VIGIL 2606.26524,
ToolPrivBench 2606.20023) sharpens that gap into a concrete threat: a
specialist can split an out-of-scope change across a critic-block retry
lineage — write file A under node N's declared scope, get critic-rejected on
unrelated grounds, get revived (`reviveFailedNode`, same node id, same
worktree) or decomposed into a child node, and write file B there. Each
individual node's own worktree diff stays inside that node's own declared
scope; the union across the lineage does not. ADR-065's per-node check cannot
see this by construction — it only ever compares one node's diff against one
node's own declaration.

A second, adjacent gap: ADR-065's audit-tier `scope_observation` records are
append-only with no dedupe. A specialist that repeats the same out-of-scope
write across several retries of the same node (or several nodes in the same
lineage) journals a new ledger record every time — durable but noisy, and
with no way for the ledger to express "this was already blocked once,
descendants should not get another free pass."

Separately, cycle-3's test-amplification research thread (AssertFlip arXiv
2507.17542, UnsatGuided 1810.10614, TestHumanizer 2606.28229) targets a
different weak-oracle failure mode the bench observed: a specialist fixes one
of several structurally identical "sibling" sites (`sibling-scan.ts` already
flags these for the critic prompt as advisory text) and the declared tests
pass because they never exercised the untouched siblings. Nothing in the
loop today can independently interrogate an unfixed sibling site; the
sibling-scan note is prose only, and a critic reading it still has no
executable evidence either way.

## Decision

Three additive changes, each confined to this workstream's owned files
(`worktree-machine-verifier.ts`, `manager.ts`, the new `test-amplifier.ts`,
`arbor-audit/src`), with two documented contract points left for the
integrator (`cli.ts`/`loop.ts`, owned by a concurrent workstream this cycle).

**Lineage-scoped diff union (`worktree-machine-verifier.ts`,
`manager.ts`).** `WorktreeMachineVerifierOptions` gains an optional
`lineage_paths_for_node?: (input) => readonly string[]` seam, deliberately
NOT added to `DeclaredWriteScope` itself — that type stays a pure "what this
node declares" value, so every existing caller that never supplies the new
option is byte-identical to pre-ADR-066 behavior. When supplied,
`verifyOutcome`'s scope check unions the returned paths with the CURRENT
node's observed `git status` diff before filtering against the declared
scope, so an ancestor's already-written path this node's own declaration
never covers is flagged even though this node never touched it itself.
Enforcement mode is unchanged: `"block"`/`"audit"` still derive solely from
`cli.ts`'s `scopeIsAuthored`, exactly as ADR-065 fixed it — lineage widens
WHAT is compared, never HOW strictly a mismatch binds.

The lineage data itself is `manager.ts`'s
`deriveScopeLineagePaths(campaignId, nodeId)`: it walks `TreeNode.parent_id`
upward from `nodeId`'s immediate parent, collecting the UNION of
`declared`/`observed_out_of_scope` paths from every ancestor's own journaled
`scope_observation` records, stopping at (and excluding) the nearest
ancestor that is both `state === "verified"` and carries a genuine
`critic_verdict` — already fully accepted, so its writes are settled and out
of the smuggling threat model — or the campaign root (also excluded; an
unsettled lineage that reaches the root has no "locked in" boundary, but the
root is not itself part of the retry lineage this check exists for).

This sourcing is deliberately narrow and is named here rather than
overclaimed: the ONLY durable path-shaped evidence this data model records
per node is what a `scope_observation` ledger record carries.
`Provenance`'s `verified` variant carries a `cmd`/`stdout_hash`, not paths;
`CandidateArtifact` carries none; `TreeNode.verified_ref` is an opaque git
ref/hash. An ancestor whose own diff never mismatched its declared scope
therefore journals NO `scope_observation` at all (see `verifyOutcome`'s
existing `observedOutOfScope.length > 0` gate) — that ancestor's genuinely
in-scope writes leave no ledger trace to union against. This is a real,
narrower gap than "no lineage check at all," and it is inherited by
`deriveScopeLineagePaths` rather than papered over: closing it fully would
require the verifier to record every tracked write (not just mismatches),
which is a larger, separate change this record does not make.

**Contract point — WIRED (verified 2026-08-18):** `deriveScopeLineagePaths`'s
return value reaches `WorktreeMachineVerifierOptions.lineage_paths_for_node`'s
closure at `packages/arbor-mcp/src/cli.ts:860`. Stated below as unwired because
that file was outside this workstream's scope at authoring time: That composition wiring lives in `cli.ts`
(`createDeclaredOutputsVerifier`, the same site ADR-065 already documented
as owning `write_scope_for_node`), outside this workstream's file scope.

**Scope-observation dedupe and blocked-repeat escalation
(`arbor-audit/src/audit.ts`, `manager.ts`).** `recordScopeObservation` now
folds a repeat: when a new observation's `observed_out_of_scope` set is a
subset of an already-journaled observation's set for the SAME
`enforcement` tier AND the same `lineage_root` (a new, optional, additive
field on `ScopeObservation`, defaulting to `node_id` for every pre-ADR-066
caller), it appends a new additive `ScopeObservationAmendmentRecord`
(`kind: "scope_observation_amendment"`, `scopeobsamend_` ids) referencing
the existing record instead of appending a duplicate
`ScopeObservationRecord` — the exact append-then-fold shape
`WaiverOutcomeAmendmentRecord` (ADR-063/E-8) established. The enforcement
match is deliberate: an `"audit"` observation and a `"blocked"` observation
over the identical path set are different classes of event (a mined guess
versus an authored hard violation) — folding them together would both
corrupt the read-side `enforcement` view and defeat
`hasBlockedScopePrecedent`'s escalation query below, which depends on a
genuine `"blocked"` record existing in its own right, never merged into an
`"audit"` one. `getFoldedScopeObservations` exposes the read-side view
(`{record, folded_count}`), mirroring `getFoldedWaiverOutcomes`.

`lineage_root` is populated by `manager.ts`'s `journalResult` using a new
private `lineageRootId`: the id of the nearest verified-and-critic-approved
ancestor (the same boundary `deriveScopeLineagePaths`'s walk stops at), or
the campaign root when none exists. Two nodes sharing this value are both
unresolved descendants of the same "locked in" commitment point — grouping
folds/escalation queries by shared exposure, not merely by identical node.

Escalation — "a lineage that repeats a write previously BLOCKED flips the
audit-tier check for that path to block for descendants" — is exposed as a
query primitive, `manager.hasBlockedScopePrecedent(campaignId, nodeId,
paths)`: true iff an already-journaled `enforcement: "blocked"` observation
exists, within `nodeId`'s own lineage (itself plus the same ancestor walk),
for any of `paths`. The actual escalation DECISION — folding this into
`DeclaredWriteScope.enforcement`'s construction — belongs where
`ScopeEnforcement` is already decided: `cli.ts`'s
`scopeIsAuthored`-driven composition (ADR-065's same site), outside this
workstream's file scope. **Contract point — WIRED (verified 2026-08-18):** that site calls
`hasBlockedScopePrecedent` (a `CampaignManager` method, not a top-level
export — declared in `packages/arbor-mcp/src/manager.ts`) from the call site
in `packages/arbor-mcp/src/cli.ts` and upgrades
a mined (would-be `"audit"`) scope to `"block"` when it returns true, as this
record required.

**Generated-oracle evidence (`test-amplifier.ts`, new).** A new module,
`amplifySiblingSites`, gated off by default behind `ARBOR_TEST_AMPLIFIER=native`.
Given the sibling-scan's flagged sites (bounded to 2), it composes one
single-call native model port per site — mirroring `native-critic-transport.ts`'s
`createNativeCriticPort` COMPOSITION PATTERN (readiness gate, credential
overlay, one non-streaming chat-completion call, no agent harness, no
session/tool machinery) rather than reusing that function directly, since a
critic call is schema-locked to a verdict and this call must return free-form
test-file source — and asks it to write ONE inverted regression test
asserting the KNOWN-GOOD post-fix behavior at the unfixed sibling site.

The generated test is written into the node's worktree and run through the
injected `MachineVerificationCommandPort` (the same sandboxed port the
verifier itself uses) before its result is trusted at all. A result that
never reaches `"exited"` (spawn failure, timeout, cancellation, output cap)
is treated as "could not even load" and discarded silently — no finding, no
evidence, no note. A clean exit (the site already behaves correctly, or the
generated oracle is too weak to catch anything) also produces nothing — this
module never claims a site IS broken from a passing test. Only a test that
RUNS and FAILS produces a finding: `{note, evidence}`. This is EVIDENCE ONLY,
mined-class oracle in the same sense the sibling-scan note itself is: it is
never fed into `recordResult`, never flips a critic verdict, never blocks or
retries anything by itself. `amplifySiblingSites` is a pure, exported entry
point; **contract point — WIRED (verified 2026-08-18):** the loop calls it after the
sibling scan and threads `AmplifierFinding.note` into the critic prompt and
`evidence` into advisory evidence at
`packages/arbor-opencode/src/loop.ts:1860-1878`; `cli.ts:633-725` composes
`amplifySiblingSites` into the runtime. The "not wired here" phrasing reflected
the manifest's explicit "do NOT wire loop.ts" instruction to this workstream at
authoring time, not a standing gap.

## Consequences

The lineage union closes the specific smuggling shape the ab3-style bench
threat models for this cycle: a specialist can no longer keep an
out-of-scope write invisible merely by spreading it across a critic-block
retry lineage, PROVIDED cli.ts wires the documented contract point — until
then this is, like ADR-065's original journaling gap, a tested primitive
with no production caller. The named sourcing gap (in-scope ancestor writes
leave no ledger trace) means the union is a strict improvement over
per-node-only enforcement, not a complete diff reconstruction; a fully
split write where every individual node's diff also stays inside that
node's own declaration AND never gets a chance to journal an observation
(because nothing about it mismatches locally) remains invisible to this
check, exactly as it was invisible to ADR-065's per-node check. This is
named rather than left to be discovered, per this project's stated
preference for an honest narrower gap over a silently overclaimed one.

The fold/escalation change reduces ledger noise (a repeated audit-tier
observation across retries no longer multiplies `ScopeObservationRecord`s)
while adding, not removing, defense: `hasBlockedScopePrecedent` gives a
future `cli.ts` wiring pass a structural (never model-produced) signal to
escalate a lineage's audit-tier enforcement to block once a hard violation
has already been recorded once. Both amendment/query additions are
additive; no existing `scope_observation` reader's shape changes.

The generated-oracle module adds a genuinely new evidence class without
widening what can grant verified/claimed provenance: its posture is
identical to the sibling-scan note's (advisory-only, critic-prompt
evidence), just backed by an executed test instead of a text pattern match.
Off by default, it costs nothing until an operator opts in; the compile/
execute gate (discard on non-`"exited"` results) protects the pipeline from
a malformed generation the way `opportunistic_command_for_node`
(S8/G-SCOPE) already protects verification from a malformed mined
acceptance command — never able to fail a node, only ever able to add
evidence.

## Obligations

### O1 — The lineage union only ever widens what a mismatch check compares, never how strictly it binds

<!-- proof: symbol=WorktreeMachineVerifier file=packages/arbor-mcp/src/worktree-machine-verifier.ts roundtrip=packages/arbor-mcp/tests/worktree-machine-verifier.test.ts -->

With `lineage_paths_for_node` absent, `verifyOutcome`'s scope check is
byte-identical to its ADR-065 behavior. With it present, a lineage path not
covered by the current node's declared scope is folded into
`observed_out_of_scope` exactly as a current-diff mismatch would be, and
`ScopeEnforcement` (`"block"`/`"audit"`) continues to be read only from the
`DeclaredWriteScope` the composition's `write_scope_for_node` closure
returns — never from `lineage_paths_for_node`, never from any
model-produced field.

### O2 — `deriveScopeLineagePaths` sources only journaled scope-observation paths, bounded by the documented ancestor-walk boundary

<!-- proof: symbol=CampaignManager file=packages/arbor-mcp/src/manager.ts roundtrip=packages/arbor-mcp/tests/manager-scope-lineage.test.ts -->

For a node whose strict ancestors include a verified-and-critic-approved
node, `deriveScopeLineagePaths` never includes that ancestor's or any more
distant ancestor's paths. For a node whose ancestor chain reaches the
campaign root without such a boundary, the root's own paths are excluded.
Every path returned traces to a `declared` or `observed_out_of_scope` entry
on a journaled `scope_observation` record for a qualifying ancestor's
`node_id` — no other `TreeNode` field is consulted.

### O3 — A repeat scope observation whose out-of-scope paths are already covered folds into an amendment instead of a duplicate record

<!-- proof: symbol=EvidenceLedger file=packages/arbor-audit/src/audit.ts roundtrip=packages/arbor-audit/tests/scope-observation-amendment.test.ts -->

`recordScopeObservation` returns the EXISTING record's id (never mints a new
`ScopeObservationRecord`) when the new input's `observed_out_of_scope` is a
subset of an already-journaled observation's set sharing the same
`enforcement` tier AND `lineage_root`, and instead journals a
`ScopeObservationAmendmentRecord`. A subset match against a DIFFERENT
`enforcement` tier never folds -- it always mints its own new record.
`getFoldedScopeObservations`'s `folded_count` for that record increments by
exactly one per such repeat. A non-subset repeat (a genuinely new
out-of-scope path) always mints a new record.

### O4 — `hasBlockedScopePrecedent` is true only for a path with an actual prior `"blocked"` observation in the querying node's own lineage

<!-- proof: symbol=CampaignManager file=packages/arbor-mcp/src/manager.ts roundtrip=packages/arbor-mcp/tests/manager-scope-lineage.test.ts -->

A path with no prior `"blocked"` observation anywhere, or one whose only
prior `"blocked"` observation belongs to a different lineage (a different
`lineageRootId`/ancestor chain), returns `false`. It never reads
`enforcement: "audit"` observations as precedent.

### O5 — A generated test never grants or denies verified/claimed provenance, and a non-`"exited"` result is discarded silently

<!-- proof: symbol=amplifySiblingSites file=packages/arbor-mcp/src/test-amplifier.ts roundtrip=packages/arbor-mcp/tests/test-amplifier.test.ts -->

`amplifySiblingSites` returns `AmplifierFinding[]` only — no field of its
return type is, or is accepted by, any `recordResult` parameter. With
`ARBOR_TEST_AMPLIFIER` unset or not `"native"`, it returns `[]` without
calling the model port. A `MachineVerificationCommandPort.run` result whose
`kind` is not `"exited"` produces no finding for that site. A clean
(`exit === 0`) result produces no finding. Only `kind: "exited"` with a
non-zero exit produces a finding, always carrying both `note` (string) and
`evidence` (an object, never a bare string).

### Acceptance note

This record remains Proposed. ADR-059 requires acceptance authority separate
from the implementation and authoring authority used in this tranche.
