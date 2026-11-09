# ADR-113: A Gate Failure Carries A Remedy, And One Cause Reports Once

**Status:** Accepted
**Date:** 2026-08-26
**Authoring Revision:** f8312bdb933bf2aa03fe29347f56d7ea9c67f59d
**Content ID:** sha256:7c7b7e1832594bb9d70616e4fbec13be9f41b5e831e3d8869c28ccbdf41d6dd8

## Context

Two independent findings surfaced in the same survey, both about what a red gate hands back to the actor who has to fix it — the operator, or the model reading stop-guard.mjs's block message.

**Finding (a): one held evidence transaction fails five gates with near-duplicate text.** `assertGovernanceConsumerReady` (`scripts/lib/governance-plan.mjs:76-103`) is the shared precondition every governance-reading gate calls first. Five stop-tier gates call it directly: `adr-acceptance-gate.mjs:17`, `adr-decision-followthrough.mjs:71`, `obligations-gate.ts:52`, `decisions-precommit-gate.mjs:73`, `store-freshness-gate.mjs:235`. While a transaction is held (`evidenceStatus.held && evidenceStatus.delegated_read !== true`), it throws `GovernancePlanRefusal("producer_incomplete", ...)` with the same holder/phase/heartbeat text, differing only by which `consumer` name each gate passed in. `gate-all.mjs`'s `runGate()` (`scripts/gate-all.mjs:253-272`) spawns every selected gate via `spawnSync` in a loop and collects every result into one in-process `runs` array before printing anything — the whole battery's output already exists in one place before the reader sees any of it. stop-guard.mjs's `buildBlockMessage(output)` (scripts/hooks/stop-guard.mjs:168-176) then pastes that `output` — five near-identical `producer_incomplete` paragraphs included — verbatim into the Stop-tier block, repeating on every Stop attempt for as long as the transaction stays held. The tool that already holds all five results does not notice, for the reader, that they are one cause.

**Finding (b): most gates already state a remedy; a real minority don't.** Reading `gate-all.mjs`'s `enumerateGates()` roster (`gate:*` in `package.json` minus `gate:all` — 48 entries) against what each gate prints on failure, the majority meet a real bar: `store-freshness-gate.mjs:227` prints `Remedy: \`${REMEDY_COMMAND}\``, and `adr-trace.mjs`'s `printRemedy()` (`:351-360`) spells out the exact commit-trailer fix. A counted minority name no next step: `hook-liveness-gate.mjs:53` states only that no manifest exists; `liveness-gate.ts:60-61` states only that drift "could not be determined... which must never read as a pass"; `entrypoint-reachability.mjs:284-289` prints "SELF-CHECK FAILED... do not act on this report" with no command; `adr-registry.mjs:29-34` has no human-formatted path at all — every outcome is a bare `JSON.stringify(result, null, 2)`; `project-registry-gate.mjs`'s default formatter (`formatProjectRegistryReport`, `packages/arbor-mcp/src/project-registry.ts:363-378`) prints `[code] detail` with no remedy; and `checkIsolation`'s result flows straight through at `packages/arbor-mcp/src/manager.ts:1545` — whatever `detail` it wrote is what the caller gets, unmediated.

Both findings are about what a gate's output owes the reader. This ADR decides gate output; it treats no gate's verdict as wrong and weakens none of them.

## Decision

**1. `gate-all.mjs` deduplicates same-cause failures in its own report, before stop-guard.mjs sees them.** `runGate()` already returns each gate's full `stdout`/`stderr`; `main()`'s `report.gates` array (`:333-337`) is built from the same in-process `runs` this groups. Add a grouping pass keyed on `evidenceStatus.transaction_id` — already attached to `GovernancePlanRefusal`'s payload (`governance-plan.mjs:90`) — so N gates failing on the identical held transaction collapse to one entry in the non-JSON report: the shared cause stated once, followed by the gate names it took down. `--json` mode keeps every gate's individual result untouched; only the human-readable path `buildBlockMessage(output)` consumes prints the grouped form. `report.ok`, `failures`, and every `exit_code` are unchanged — nothing that fails starts passing.

**2. New gates must ship a remedy; existing gates are held to a ratchet, not a retrofit.** Following this corpus's house pattern (`obligations-gate.ts`'s `POL_04_FLOOR`, `adr-sections.mjs`'s `ALTERNATIVES_FLOOR`), the ~7 counted gates above are not required to gain remedy text in this change. A new check, `gate:remedy-coverage`, mirrors `alternatives-over-floor`'s shape and fails only if the count of gates without an actionable remedy line *increases* past the floor set at the counted figure (7). A gate exits the floor the moment it adds a remedy; the floor itself may only be lowered by a change that closes an entry, never raised to make room for a new remedy-less gate.

**3. This is a new gate, not ADR-108's `scope` field.** ADR-108's `scope: "self" | "target" | "both"`, validated by `loadExecutionProfile`/`auditExecutionProfile`, declares a structural fact about a gate's *subject*. "Does this gate's failure text include a remedy" is a fact about output quality, checkable only by reading what the gate actually printed on a real failing run — a declared `remedy: true` field could drift from the script's real text the moment someone edited the message without updating the manifest. `gate:remedy-coverage` inspects real gate output (the same `tailOutput` text `gate-all.mjs` already captures) rather than a self-reported claim.

## Consequences

**Easier:** the reader of a Stop block sees one cause and a "covers: 5 gates" note instead of five paragraphs of identical holder/pid/heartbeat text; a genuinely new failure inside a busy battery is no longer buried in near-duplicate noise. New gates get a forcing function pushing their author to name a next step before shipping, the way `gate:adr-sections` already pushes toward an Alternatives section.

**Harder:** the grouping key is `evidenceStatus.transaction_id`, which exists only for the `producer_incomplete` shape — a future second cause of correlated failures needs its own key added, not automatic coverage. The floor is an honest admission that 7 gates keep shipping without a stated remedy; it does not retrofit them, and a reader should not read the floor's existence as those 7 having been fixed.

**Unchanged:** no gate's exit code, `ok` value, or blocking/advisory classification changes. `assertGovernanceConsumerReady`'s refusal text and the ADR-101 "never read an actively-produced store" rule are untouched — only how many times the same refusal prints, never whether it fires.

## Alternatives / Roads not taken

**Silence every consumer but the first, inside `assertGovernanceConsumerReady` itself.** Rejected: that function runs once per gate's own `spawnSync` child and has no view of the other four gates' outcomes. Grouping has to happen where all five results already live in one process — `gate-all.mjs` — or it needs cross-process coordination this ADR has no reason to build.

**A `scope`-style manifest field (`remedy: true|false`) instead of an output-inspecting gate.** Rejected in decision 3, restated here because it was the obvious first move, mirroring ADR-108 too literally: a declared field is exactly the kind of unfalsifiable claim `gate:obligations`' own proof mechanism exists to distrust — it can go stale the instant the underlying text changes. Reading real stdout cannot drift the same way.

**Hard-block on all 7 remedy-less gates now.** Rejected per this repo's own ratchet precedent (`POL_04_FLOOR`, `ALTERNATIVES_FLOOR`): treating a newly-discovered convention as an immediate blocking requirement against a pre-existing corpus punishes work unrelated to this ADR's gap, and invites rushed, low-quality remedy text written only to clear a gate.

## Obligations

### O1 — `assertGovernanceConsumerReady` is the single real precondition five stop-tier gates share, and already carries the transaction identity decision 1 groups on

It throws `GovernancePlanRefusal("producer_incomplete", ...)` with `evidenceStatus.transaction_id` attached whenever a governance-reading gate runs while a transaction is held — the exact payload the grouping pass reads, not new plumbing.

<!-- proof: symbol=assertGovernanceConsumerReady file=scripts/lib/governance-plan.mjs roundtrip=scripts/tests/governance-plan.test.mjs -->

### O2 — `buildBlockMessage` is the real function that pastes battery output into the Stop-tier block, where decision 1's grouped text lands

Today it interpolates the full `output` string unmodified into the block message on every Stop while the battery is red. This demonstrates the current verbatim-paste behavior this ADR changes; it does not demonstrate the grouping, which is not implemented as of this ADR.

<!-- proof: symbol=buildBlockMessage file=packages/arbor-mcp/src/hooks/stop-battery.ts roundtrip=packages/arbor-mcp/tests/hooks/stop-battery.test.ts -->

### O3 — `gate-all.mjs` groups same-`transaction_id` failures before they reach the human-readable report

`groupFailuresByCause` reads each failing run's captured stdout/stderr for `assertGovernanceConsumerReady`'s literal `producer_incomplete` refusal text, extracts the shared `transaction_id`, and collapses every run naming the same one into a single group; `printFailureSection` (both the blocking and advisory report sections) prints a group of more than one run as one `SHARED CAUSE` entry — the cause stated once, followed by a `- gate (exit N)` line per gate it covers — and prints a solitary or non-matching failure exactly as before. stop-guard.mjs's `parseRedGates` was extended to read both the classic and the grouped list-item shape, so the Stop-tier circuit breaker's fingerprint is unaffected by which shape a given run prints in. `--json` mode is untouched; only the human-readable path is affected.

<!-- proof: symbol=groupFailuresByCause file=scripts/gate-all.mjs roundtrip=scripts/tests/gate-all.test.mjs -->

### O4 — `gate:remedy-coverage` enforces decision 2's floor and only tightens it

`gate:remedy-coverage` (`scripts/remedy-coverage-gate.mjs`, wired into `package.json` and `scripts/execution-profile.json`) re-verifies a curated `EXEMPT_GATES` list — the five of Finding (b)'s counted seven this implementation could independently confirm by citation (`gate:hook-liveness`, `gate:liveness`, `gate:entrypoint-reachability`, `gate:adr-registry`, `gate:project-registry`) — against each gate's real, current source text on every run, and fails if the list exceeds `FLOOR = 7` or if an entry has gone stale (cited gate removed, cited file missing, or predicate no longer matching). It does not attempt a generic classifier over the other ~41 gates: an early heuristic (grep the word "remedy") was tried and discarded because it flagged the corpus's own majority as remedy-less, contradicting Finding (b)'s audit — see the file's header comment for why a curated, source-verified list was chosen over a mechanical scan or a self-reported field.

<!-- proof: symbol=auditRemedyCoverage file=scripts/remedy-coverage-gate.mjs roundtrip=scripts/tests/remedy-coverage-gate.test.mjs -->
