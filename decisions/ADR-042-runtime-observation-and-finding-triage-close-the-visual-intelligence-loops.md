# ADR-042: Runtime Observation and Finding Triage Close the Visual-Intelligence Loops

**Status:** Accepted
**Date:** 2026-08-11

Authored as Proposed, not Accepted: the authoring agent does not hold
acceptance authority (AGENTS.md checks-and-balances, applied to ADR governance
by ADR-024's ratification note), and POL-05 flags any record arriving already
accepted as never having traversed the lifecycle.

## Context

The visual-intelligence graph models four planes. The observed plane is marked
NOT BUILT in the repository's own schema, and the project skill instructs
"never emit `runtime_observed` on revoy2" because no runtime evidence source
exists. Consequently every derived→observed comparison — *"is this reachable
code actually exercised in production?"* — is permanently unmakeable, and the
graph's honest typed absence ("planes UNAVAILABLE: observed") appears in every
view.

That absence is not evenly distributed across the defect shapes. The two
shapes with automation, `unreached` and `unwitnessed_claim`, were already
caught by `gate:reachability` and `gate:docs-truth` before the graph existed.
The shape the graph would be uniquely positioned to catch — **Hollow**: green
everywhere, dead where it counts — has only partial coverage:

- ADR-035's `completion-depth` gate automates exactly one statically decidable
  subset: a guard on `<obj>.<key>` where every assignment of the key lives in
  test or demo files. It is syntax-only by design, and its own store shows the
  cost of that boundary: of the five findings in the current baseline, three
  are `false_positive` verdicts caused by blindness the heuristic declares up
  front (class-prototype method satisfaction, externally constructed events).
- Everything outside that subset — a key set to a falsy value, a dormant
  branch behind another dormant branch, a mocked-but-present dependency, a
  guard on anything other than a property access — is found only by the manual
  method the skill prescribes: grep for early-return guards, then hand-trace
  from the production entry points. The instance class that motivated the
  shape (`task_skills` capability routing in `arbor-opencode`'s loop,
  reachable and tested and permanently dormant under
  `createProductionCampaignRunner`) was found by that manual method, not by
  any gate.

The designated future ingestion point, `devtools.ts` (ADR-021), streams
ND-JSON **runtime events** — campaign lifecycle, ledger witnesses, loop
events. That stream is semantically rich but event-granular: it can say a
campaign expanded a node; it cannot witness that a specific function executed.
Symbol-granular observation needs a different instrument.

The second open loop is the graph's own output. `vi-refresh` emits tier-4
interpretive findings — validator query results, `vi-emit`'s dangling
citations and waiver-policy findings — into `findings/findings.jsonl`. The
current run carries 17 dangling citations and 42 findings. Nothing consumes
them: ids are sequential per run (`VI-0001`) and not stable across refreshes,
there is no disposition store, and no gate reads the file. Backfill proposals
for the intent plane sit at `pending-ratification` with no enforced
ratifier. Contrast `completion-depth`, where every finding has a
content-addressed id, a durable verdict with a reason and an expiry, and a
gate that fails on an untriaged or expired lead. One loop closes; the other
emits into silence. Emission without an obliged consumer is precisely the
`unwitnessed_claim` shape ADR-033 governs — here exhibited by the tool whose
job is detecting it.

## Decision

One rule, enforced in two halves: **the visual-intelligence system may not
emit what nothing is obliged to consume.** A single record covers both halves
deliberately — each is an instance of the same defect, and accepting one
without the other would leave the rule half-true.

### Half A — an observed plane, built from V8 coverage of a declared scenario catalog

1. **Scenario catalog.** A committed, closed catalog
   (`scripts/observation/scenarios.json`) declares every observation run:
   stable id, exact argv against **built `dist/` entry points** (never the
   esbuild bin launcher, whose temporary bundle breaks source attribution),
   environment, `run_class` (`production` | `demo`), timeout, and expected
   exit. Scenarios are hermetic: no network, no credentials, temp-dir
   persistence, deterministic termination. The initial catalog includes at
   least one real campaign run through the production CLI entry
   (`createProductionCampaignRunner`, per the deterministic quickstart) plus
   the primary CLI surface commands.
2. **Producer.** `scripts/vi-observe.mjs` runs each scenario under
   `NODE_V8_COVERAGE`, maps the reported function ranges through the
   tsc-emitted sourcemaps back to `packages/*/src` positions, and resolves
   them to graph symbol ids by file and enclosing span. Coverage that cannot
   be mapped is recorded as a typed `unmappable` entry — never guessed, never
   dropped silently. The producer is manual and expensive-class: it runs off
   the critical path, exactly as ADR-034 places determinism measurement.
3. **Store.** `.visual-intelligence/observed/` — a manifest (repo revision,
   tree state, catalog content hash, node version) plus observations
   aggregated per symbol × scenario (`symbol id, scenario id, run_class,
   count`). Aggregation keeps the store size proportional to the symbol
   count, not the event count. The store joins `store-freshness-gate` with a
   generous budget matching its manual/expensive class.
4. **Absence semantics.** An unobserved symbol is *"not observed under the
   declared catalog"* — never "dead." The catalog is a declared, finite
   instrument; every view and finding that uses the observed plane states
   this bound.
5. **Comparisons unlocked.** The validator gains two checks:
   - `hollow_candidate`: reachable from production entry points in the
     derived plane ∧ zero observations across every `run_class: production`
     scenario → a tier-4 finding, triaged under Half B. A candidate is a lead
     requiring a verdict, not a verdict.
   - the reverse cross-check: a symbol observed at runtime that the derived
     plane does not mark production-reachable is an extractor-gap finding —
     the dynamic analogue of `verify-against-gate`, and the same doctrine:
     two independent instruments agreeing is the strongest available
     evidence that either is right.
6. **Supersession.** The schema's "NOT BUILT" marker and the skill's "never
   emit `runtime_observed`" prohibition are superseded **only** for records
   produced by this pipeline. Hand-authored runtime evidence remains
   forbidden.

### Half B — a triage obligation for every emitted finding

1. **Stable identity.** Finding ids become content-addressed (hash of
   category plus subject set), the convention `completion-depth` already
   uses. Sequential per-run ids are retired.
2. **Disposition store.** `.visual-intelligence/findings/triage.jsonl`
   records, per finding id: a verdict from a closed set (`false_positive`,
   `accepted_tradeoff`, `fixed`, `superseded`), a reason, first-seen
   revision and date, an expiry, and the finding's content hash. A verdict
   never forces a fix — it forces a recorded decision. Expiry forces
   re-verification.
3. **Gate.** `gate:vi-findings` fails on: any committed finding without a
   disposition; any expired disposition; any disposition whose recorded
   content hash no longer matches its finding (the finding changed, so it
   reopens). The gate joins the `check` chain and the gate self-agreement
   suite.
4. **One loop, all emitters.** Validator query findings, dangling citations,
   waiver-policy findings, Half A's hollow candidates and extractor gaps,
   and intent-plane backfill proposals all flow through this single loop.
   "Pending ratification" ceases to exist as a separate unenforced queue: a
   proposal is a finding, and a finding gets a verdict.
5. **Baseline.** The findings committed at adoption receive a one-time triage
   pass with recorded verdicts before the gate turns on — the same adoption
   path `anti-stub` and `completion-depth` took.

## Consequences

**Gained.** Hollow detection acquires its dynamic half; the static heuristic
(ADR-035) remains, and the overlap is deliberate — where both instruments can
see, agreement is evidence. The derived plane gains an independent runtime
cross-check. The findings loop closes, eliminating the unwitnessed-claim
shape from the skill's own output. The empty `runtime_evidence` field on
graph symbol nodes finally has a producer.

**Paid.** A new committed store and its freshness budget; a scenario catalog
that is a real maintenance surface (a scenario that stops exercising a path
silently narrows the instrument — catalog changes must bump its content
hash); a producer too expensive for pre-commit; and triage that is human work
by design.

**Bounded honesty retained.** Observation is catalog-relative. A
`hollow_candidate` is a lead. The observed plane never blesses a symbol as
"exercised in production" beyond the declared scenarios.

**Done when:**

1. A single `vi-observe` run from a clean tree produces the committed
   observed store, and the validator emits hollow candidates from it.
2. The known dormant instance class — `task_skills` capability routing,
   dormant under `createProductionCampaignRunner` — surfaces as a
   `hollow_candidate` without being hand-listed anywhere.
3. `gate:vi-findings` is red against an untriaged finding and green after the
   baseline triage pass.
4. The full suite and the `check` chain are green with both halves wired.

## Obligations

### O1 — A single observation run produces the observed store and hollow candidates

<!-- unverifiable: the producer (scripts/vi-observe.mjs) and comparison (scripts/vi-observed-compare.mjs) are repository scripts with no top-level exported symbol driving this end-to-end claim, so symbol= cannot resolve against them — the same reason ADR-008 and ADR-035 give for their own script-level obligations -->

One `vi-observe` run from a clean tree writes the committed observed store, and
the comparison emits `hollow_candidate` findings from it.

*No proof comment: the producer and comparison are repository scripts, not
exports under `packages/*/src`, so `symbol=` cannot resolve against them — the
same reason ADR-008 and ADR-035 give for their own script-level obligations.*

### O2 — The known dormant instance surfaces without being hand-listed

<!-- unverifiable: a finding is a JSONL record, not a source symbol proof= can name; verified instead by citation — .visual-intelligence/findings/findings.jsonl id vi:73b536233ef07008 auto-lists deriveProductionTaskSkills (packages/arbor-mcp/src/cli.ts:604, invoked from createProductionCampaignRunner via createProductionCampaignLoopConfig at cli.ts:754) among 14 symbols never invoked under the scenario catalog, with no hand-listing anywhere in the producer -->

The `task_skills` capability-routing branch, dormant under
`createProductionCampaignRunner`, appears inside a `hollow_candidate` finding
with no hand-listing anywhere in the pipeline. **Verified (2026-08-26):**
`.visual-intelligence/findings/findings.jsonl` finding `vi:73b536233ef07008`
("hollow-candidate: 14 symbol(s) in `packages/arbor-mcp/src/cli.ts`") lists
`deriveProductionTaskSkills` among its 14 `affected_nodes`, generated
generically by `scripts/vi-observed-compare.mjs`'s `findCandidates`/
`buildFindings` from the observed-store comparison — the symbol is not named
anywhere in the producer's source, satisfying "no hand-listing." The call
site is `packages/arbor-mcp/src/cli.ts:604`
(`task_skills: deriveProductionTaskSkills(runtime, campaignId)`), reached from
`createProductionCampaignRunner`'s `run()` via
`createProductionCampaignLoopConfig(...)` at `cli.ts:754`.

*No proof comment: this obligation asserts membership of one symbol inside a
committed JSONL finding record, not a source-level behavior a `symbol=`/
`roundtrip=` proof can witness — the same shape as this record's own O1.*

### O3 — The triage gate fires and then clears

<!-- unverifiable: gate:vi-findings' red/green transition is a CLI exit-code behavior driven by an unexported gate() in scripts/vi-findings.mjs, not a symbol proof= can witness; verified instead by scripts/tests/vi-findings.test.mjs's "gate — can it actually fail?" describe block (lines 311-372), which subprocess-spawns the script and asserts exit code 1 untriaged / 0 triaged -->

`gate:vi-findings` is demonstrably red against an untriaged finding and green
after the baseline triage pass records verdicts. **Verified (2026-08-26):**
`scripts/tests/vi-findings.test.mjs`'s `describe("vi-findings.mjs gate — can
it actually fail?")` block (lines 311-372) spawns `scripts/vi-findings.mjs`
as a real subprocess against fixture stores and asserts exit code `1` for an
untriaged finding, an expired triage row, and a content-hash mismatch
("REOPENED"), and exit code `0` once triaged/unexpired/hash-matched. Re-ran
`npx vitest run scripts/tests/vi-findings.test.mjs` directly: 38/38 tests
pass.

*No proof comment: `gate()` in `scripts/vi-findings.mjs` is not exported —
the test drives the CLI's process exit code via `spawnSync`, a behavior
`symbol=`/`roundtrip=` has no grammar to name (same script-level shape as
this record's own O1).*

### O4 — Finding identity survives a refresh

<!-- proof: symbol=stableFindingId file=scripts/vi-finding-id.mjs roundtrip=scripts/tests/vi-findings.test.mjs -->

Re-running the refresh preserves content-addressed finding ids and their
recorded verdicts; a finding whose content changes reopens.
`scripts/tests/vi-findings.test.mjs`'s `"keeps the same id when a refreshed
finding changes symbols, then reopens the prior verdict instead of creating
an orphan"` test (lines 169-190) drives `stableFindingId`/`findingContentHash`
(exported from `scripts/vi-finding-id.mjs`) through `--rewrite-ids`: the id is
unchanged after a symbol-set change, no triage row is orphaned, and the
gate's `violation_ids` names the now-mismatched finding — i.e. it reopens.

## Roads not taken

- **devtools ND-JSON as the sole observation source.** Event-granular; cannot
  witness symbol execution. It remains the designated ingestion point for
  *semantic* runtime observations, under a future record if pursued.
- **Instrumenting source code.** Intrusive, and violates the skill's
  read-only-over-`packages/` discipline. `NODE_V8_COVERAGE` observes without
  touching the observed.
- **Test-suite coverage as observation.** Tests routinely supply what
  production does not; admitting them would reintroduce the exact confusion
  the `run_class` discipline exists to prevent. Only `production`-class
  scenarios feed Hollow candidacy.
- **Auto-triage or auto-expiring findings.** Automatically closing findings
  silently reopens the gap this record exists to close; a disposition is a
  human decision with a recorded reason.
