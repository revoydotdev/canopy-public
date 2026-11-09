# Four adjacent intelligence categories for revoy2

**Status:** Proposal, not an ADR. Written for a skeptical reader; nothing here is authorized
by being written down.

**Scope of this document.** `repository-visual-intelligence` (VI), as tailored for revoy2 in
`.claude/skills/revoy2-visual-intelligence/`, builds one thing well: a canonical, deterministic
graph of the repository's **static structure** — symbols, imports, the call graph, reachability
from `scripts/reachability/entry-points.json`, orphans, stubs (via AST heuristics), ADR-intent
vs. implementation (via proof-comment resolution), UI/TUI wiring, and pre-merge structural drift.
Its own doctrine says what it cannot see: it has no `observed` plane
(`.visual-intelligence/manifest.json`: `"observed": {"status": "unavailable", "reason": "static
analysis only; no runtime evidence source"}`), and its own SKILL.md names the Hollow defect shape
— "reachable, exercised by nothing that matters" — as **structurally undetectable** by anything
in its toolkit.

This proposal names four *other* axes of truth about revoy2 that a similarly bespoke
skill-plus-repo-integration would materially improve, each one something VI's static graph
cannot see **by construction**, not merely by omission. Every citation below was read directly
from this repository on 2026-08-07 (commit `1033155`/`efa8e95` era); counts and waiver totals are
point-in-time and will go stale, exactly the failure mode `revoy2-visual-intelligence/SKILL.md`
already warns about for its own prose ("Earlier drafts hardcoded the measurements... every one of
them was wrong within a day"). Treat every number here as an anchor to re-derive, not a fact to
cite.

---

## The four categories, at a glance

| # | Category | Axis VI cannot see | Build-first rank |
|---|---|---|---|
| 1 | Authorization & Enforcement-Strength Intelligence | Who is allowed to trigger a mutation, and whether the mechanism that's supposed to stop an unauthorized actor actually runs — including facts that live outside the source tree (GitHub's platform state) | **1st** |
| 2 | Runtime Execution-Trace Intelligence (completing the `observed` plane) | What a real, multi-step campaign actually dispatched, over time, under production config — vs. what a synthetic single-shot probe or a static call graph can show | 2nd |
| 3 | Temporal & Concurrency Protocol-Conformance Intelligence | Whether durable state survives a crash, a race between two writers, or a retried operation — a property of *interleavings over time*, not of the code's shape | 3rd (cheap half only) |
| 4 | Assertion-Strength (Mutation-Verified) Test-Efficacy Intelligence | Whether a passing, assertion-bearing test would actually fail if the logic under test were wrong — a dynamically-measured property, not an edge in a graph | Defer |

---

## 1. Authorization & Enforcement-Strength Intelligence

### (a) Axis of truth and the failure mode it catches

VI's reachability plane answers "is there a path from an entry point to this symbol." It has no
vocabulary for "is the caller *authorized*," and — this is the part with no static analogue at
all — no way to represent a fact that lives **outside the repository**: whether GitHub's platform
actually refuses a merge. ADR-025 exists because that exact gap went unnoticed for six tranches:

> `$ gh api repos/revelri/revoy2/branches/master/protection` → `403` — GitHub Free on a private
> repo cannot configure branch protection at all. Six tranches (6.1, 6.2, 6.6, 6.7, 6.8, 6.9)
> claimed **BLOCKED** ("the build or CI refuses to merge it"). None of them delivered it. Nothing
> in the repository's source could have told you that — `gh api` is a live call to an external
> service, and ADR-025 exists only because a human ran it by hand during an audit.

A second, independent instance of the same axis: `packages/arbor-core/src/capability.ts` and
`capability-token.ts` (`enforceAction`, `tokenCovers`) shipped fully tested and exported, with
**zero callers**, for the span between commit `690cabd` (2026-08-02) and ADR-028 (accepted
2026-08-06) — four days during which `arbor-mcp/src/tools.ts`'s `arbor_command`/`arbor_query`
exposed `RuntimeCatalogRouter`'s mutating kinds (`job.submit`, `campaign.halt`,
`recovery.retry`/`abandon`, `approval.approve`/`reject`) to **any MCP client**, not just this
repo's own CLI. VI's own reachability gate (`gate:reachability`) correctly reported these two
files as unreached — under a `G-14` waiver — but "unreached" and "unauthorized-if-called" are
different claims, and nothing distinguished them. Even after ADR-028 wired enforcement in, the
ADR's own Decision section had to issue a **correction**: it originally claimed wiring retired
"all twelve" `G-14` waivers; the actual count, verified against `scripts/reachability/allowlist.json`,
is two (`enforceAction`, `CapabilityError`) — ten survive, because the router derives its
action class from `direction` alone and never consults `ACTION_CLASSES`, `entitledActionClasses`,
`requiredCapability`, `isMutating`, or any `capability-token.ts` export. **The people who wrote the
enforcement wiring miscounted their own coverage in the document that describes it.** That is
exactly the kind of claim a mechanically-checked graph makes unable to survive to merge.

### (b) Canonical artifact / ontology

Extends VI's node/edge schema with a repo-specific `ontology-extension` (per
`references/ontology.md`'s stated mechanism):

```yaml
node_kinds:
  - kind: actor_tier          # junior | senior | operator | auditor — from capability.ts's
                               # CapabilityTier and AGENTS.md's agent-role table
    identity: "tier:<name>"
  - kind: mutating_surface     # a RuntimeCatalogRouter command kind, MCP tool, or CLI mutator
    identity: "surface:<catalog-kind-or-symbol>"
    attributes: {handler_symbol, action_class, caller_tier_default}
  - kind: enforcement_mechanism
    identity: "enf:<symbol>"   # enforceAction, tokenCovers, authorized(), ApprovalService, PermissionConfig
  - kind: platform_control     # external to source: branch protection, required-status-checks,
                               # the pre-push hook
    identity: "platform:<control-name>"

edge_kinds:
  - relation: gates            # enforcement_mechanism -> mutating_surface
    attributes: {tier_required, verified_by_call_site: bool}
  - relation: grants           # actor_tier -> capability string
    attributes: {is_default_omit_to_grant: bool}   # flags ADR-028's `senior`-default pattern
  - relation: claims_strength  # an ADR/ROADMAP tranche -> PREVENTED|BLOCKED|REPORTED|DETECTED
                               # (ADR-025's own vocabulary, adopted verbatim, not reinvented)
  - relation: verifies_strength  # this graph's own probe result -> claims_strength edge
    default_discovery: observed   # a live gh api call, or a CI-config parse; never derived-from-prose
```

### (c) Planes reconciled

`intended` (ADR-024/025/028's stated boundary decisions) → `declared` (`capability.ts`'s
`ActionClass` table, `RUNTIME_CATALOG`'s `capability` strings) → `derived` (does the handler's
actual source call `enforceAction`/`tokenCovers`/`authorized` before mutating — reuses VI's own
call-graph as input, not a re-parse) → `observed`-external (does GitHub's platform, probed live,
actually refuse; typed `unavailable` without `gh` credentials — never silently assumed clean).

### (d) Deterministic extractor(s) and degradation

- **AST/call-graph extractor** — walks the *existing* VI `calls` edges for every
  `mutating_surface` handler and checks whether any resolve to an `enforcement_mechanism` node.
  Fully deterministic; no new parsing, only a new query over VI's own output.
- **CI-config extractor** — parses `.github/workflows/ci.yml` for whether a job is `required` on
  the merge path (currently: none are, since GitHub Free blocks required-status-checks
  entirely — this extractor would report that as a fact, not infer it).
- **Platform-probe extractor** — a live `gh api .../protection` call. Non-deterministic by
  nature (it reflects external, mutable state), so its result is timestamped in the manifest,
  never in a graph record, mirroring VI's own rule that timestamps belong only at the manifest
  level. Degrades to `platform_control: unavailable, reason: "no gh credentials"` — never inferred
  from the absence of an error.

### (e) Invariants / queries

- `INV-CAP-01` — every `mutating_surface` node has at least one `gates` edge from a real
  `enforcement_mechanism`, or a dated waiver citing `scripts/reachability/allowlist.json`
  (never a second waiver store — see the shared-substrate section).
- `INV-CAP-02` — no `claims_strength` edge may assert `BLOCKED` unless a `verifies_strength`
  edge with `discovery: observed` confirms it within a configured freshness budget (mirrors
  `vi-freshness-gate.mjs`'s own "budget, not equality" design, applied to a claim instead of a
  revision).
- `INV-CAP-03` — no `caller_tier_default` is the permissive `senior`/omit-to-grant value on any
  `mutating_surface` reachable (per VI's own reachability plane — a genuine cross-graph join) from
  a transport this repository does not itself control.

### (f) Hooks and CI ratchet

SessionStart: banner if the last platform probe is stale, or if `ROADMAP.md`'s strength-ladder
prose changed without a re-probe (mirrors `vi-freshness.sh`). Stop: report new mutating catalog
kinds added this session with no `gates` edge (mirrors `vi-graph-debt.sh`'s dirty-count report).
CI: **Informational first** — this whole category exists because a human audit found ADR-025's
gap by hand; the honest first step is to make that check machine-run, not to gate on day one.
Ratchet once the G-14 residual (ten waivers, as read from `allowlist.json` on 2026-08-07) is
resolved or re-justified with dated reasons.

### (g) Interop with the existing VI graph

Not a parallel graph. `mutating_surface.handler_symbol` and `enforcement_mechanism` nodes reuse
VI's own `sym:` identity formula and its already-extracted `calls` edges as the derived-plane
substrate — this category adds authorization semantics VI's ontology has no vocabulary for; it
does not re-extract anything VI already extracts.

### (h) Specific defects this repo it would have caught

- ADR-025's six-tranche BLOCKED overclaim — found only by a human running `gh api` during an
  audit; `INV-CAP-02` makes the same fact fail a build.
- The four-day window (`690cabd` → ADR-028) where `capability.ts` was tested, exported, and
  unreachable from any check that distinguished "correctly unreached" from "reachable and
  unauthorized-if-reached" — `RuntimeCatalogRouter`'s mutating kinds were already externally
  reachable via `tools.ts` during that window.
- ADR-028's own miscount of how many `G-14` waivers its wiring retired (claimed twelve, delivered
  two) — a claim about graph state that a graph, rather than prose, cannot get wrong without the
  build failing.

### Why you might not want this

The platform-probe half depends on live `gh api` calls with credentials in CI — a new external
dependency and rate-limit surface a purely static skill does not have. More fundamentally: ADR-024
already ratified that **boundary 1** (the host's own tool-dispatch — an opencode agent's own Bash/
Edit calls) is *never* enforced by revoy2 at all; this category can only ever model **boundary 2**
(revoy2-owned mutating MCP surfaces). A reader who sees a green authorization graph and infers
"revoy2 is safe against a malicious tool call" is wrong in a way this category cannot fix by
itself — every view it produces must carry the same "planes UNAVAILABLE" style disclosure VI
already uses, naming boundary 1 as permanently out of scope, or this tool becomes exactly the kind
of overstated safeguard ADR-024/025 both exist to warn against.

---

## 2. Runtime Execution-Trace Intelligence (completing the `observed` plane)

### (a) Axis of truth and the failure mode it catches

`docs/adr-governance-audit/appendices/graph-schema.json` already specs the edge this category
would build, and marks it, verbatim:

```json
{"type":"DISPATCHES","from":"Caller","to":"CatalogKind","discovery":"observed","confidence":"n/a",
 "status":"NOT BUILT","note":"Requires runtime tracing. devtools.ts ND-JSON is the correct future
 ingestion point."}
```

The repo already tried the *cheap* version of this axis, and it paid off immediately: ADR-030
(2026-08-07, the most recent commit at time of writing — "liveness attestation over the seam
catalog") built `gate:liveness`, which **calls** every `RUNTIME_CATALOG` seam with a synthetic,
single-shot request and classifies the result `answered`/`refused`/`unreachable`/`indeterminate`.
It found real defects nothing static had: the `diagnostics` screen issuing `event.resume` with
`cursor: 0` where `RuntimeCursor` is `{stream_id, sequence}` — reachable, tested, and broken on
every real dispatch, invisible to `gate:reachability`, `gate:docs-truth`, and `gate:anti-stub`
alike.

But ADR-030 states its own ceiling in writing, twice:

> "Executing the consumers themselves — driving a real terminal — would remove the weakness and
> is not attempted here." / "An `answered` attests that a well-posed request reached a handler
> that produced a result. It does not attest that the result is *correct*... This measures
> **liveness and citation integrity, not correctness.**"

The gap ADR-030 explicitly declines to close is a live instance of the Hollow shape in this
repository. Verified directly against source at `0ac6ea8`, not cited from a prior audit:

- `packages/arbor-opencode/src/loop.ts:555` guards capability routing on an unset value —
  `const cardSelection = config.task_skills && config.task_skills.length > 0 ? … : …`.
- `task_skills` is set in exactly two places in the tree: `packages/arbor-mcp/src/demo.ts:379`
  and `packages/arbor-opencode/tests/loop.test.ts:282,316`.
- `createProductionCampaignRunner` (`packages/arbor-mcp/src/cli.ts:345-362`) composes the
  production `CampaignLoopConfig` from `DEFAULT_LOOP_CONFIG` plus eight explicit overrides, and
  **never sets `task_skills`**.

So the branch is reachable, test-covered, demo-covered, and **permanently false under
`arbor run`**. Note what the existing record does and does not say: `ROADMAP.md:1936` closes
**G-01** (2026-08-04) for a *different* defect — `selectNodeByCapability` never being reached at
all — and states that `demo.ts` sets `task_skills` "so `arbor demo` exercises the path." The
production-config dormancy is acknowledged in passing and tracked by nothing. Advisory-on-mismatch
is deliberate (ADR-001); *never consulted in production* is not the same claim.

`gate:liveness` would score this seam `answered` — the seam it belongs to responds correctly to a
well-formed synthetic request. Nothing about a single-shot catalog probe can see that the
*production composition root's own default config* never feeds the branch a value that would take
it. That is a fact about a **real, multi-step run under real config**, not about one request/
response pair, and it is the specific thing ADR-030 says it did not attempt.

### (b) Canonical artifact / ontology

This is not a new graph — it is filling the plane VI's own manifest already reserves and marks
`unavailable`. Node/edge identity reuses VI's existing `sym:` ids exactly, adding:

```yaml
# on an existing VI node
runtime_evidence: [evidence_id, ...]     # already in VI's node schema, currently always empty here
implementation_status: runtime_observed  # already a VI status value, currently unreachable here

# new node kind, finer-grained than VI's default symbol identity
node_kinds:
  - kind: guarded_branch
    identity: "branch:<symbol>::<guard-condition-source-location>"
    attributes: {gating_config_key, production_default_value}
```

### (c) Planes / tiers reconciled

Fills `derived → observed` exactly as VI's own doctrine defines it. Adds one comparison the
parent skill's four standard pairs do not name: `observed-under-production-config` vs.
`observed-under-test-or-demo-config` — a repo-specific extension (declared with a `rationale`,
per `references/ontology.md`'s extension mechanism) rather than silently overloading the parent's
vocabulary, since VI's plane model has no native concept of "which config produced this trace."

### (d) Deterministic extractor(s) and degradation

An ND-JSON line parser over `<persistence_dir>/devtools/devtools.log` (`DevToolsTraceLogger`,
ADR-021), correlating each `RuntimeEvent` payload's `record_id`/symbol back to VI's existing node
ids. Requires an actual log from a real run — degrades honestly to exactly what
`.visual-intelligence/manifest.json` already states today (`observed: unavailable`) when none
exists. The cheapest real source: `gate:eval-regression`'s CI job already runs a real, deterministic
campaign (`packages/arbor-eval/src/cli.ts` against `defaultTasks`) — pointing `DevToolsTraceLogger`
at that job's persistence directory ingests a real trace with **no new live-model soak**, reusing
existing CI rather than adding one.

### (e) Invariants / queries

- `INV-OBS-01` — no node carries `runtime_observed` without a resolving `runtime_evidence`
  citation into a real `devtools.log` (this is VI's own parent-level `INV-16`, restated — the
  parent skill already specifies this rule; revoy2 currently cannot enforce it for lack of a
  source, and this closes that).
- `INV-OBS-02` (new finding category, `config_induced_dormancy`) — any `guarded_branch` reachable
  and probe-`answered` (per `gate:liveness`) but never appearing in a `DISPATCHES` edge across N
  eval-regression runs under the **production** composition root's default config is flagged —
  named directly for the `selectNodeWithCard`/`task_skills` shape above.

### (f) Hooks and CI ratchet

SessionStart: freshness banner keyed to "has a devtools.log been ingested since the last commit
touching a `guarded_branch`'s gating config key." CI: informational only at first — a
misattributed trace (wrongly marking a branch "not dormant") is a **fabricated-observed-plane**
defect, the single thing VI's doctrine treats as worse than an absent plane; this category must
earn trust before it gates anything.

### (g) Interop with the existing VI graph

Directly completes VI's own reserved plane — the single least-invented interoperation of the four
categories in this document. It is not a new graph; it is the missing half of one that already
exists.

### (h) Specific defects this repo it would have caught

The `selectNodeWithCard`/`task_skills` dormancy established above, currently findable only by the
manual method the `revoy2-visual-intelligence` SKILL.md prescribes at line 121:

> "grep `packages/*/src` for early-return guards on optional fields, then trace each candidate
> from the **real production entry points** (`cli.ts`'s `createProductionCampaignRunner`,
> `createCliRuntime`) — not from construction, and not from tests, which routinely supply what
> production does not."

That skill states the boundary plainly two lines earlier: "A structural graph cannot see Hollow
without points-to analysis and must not pretend to." This category is the answer to that
sentence. Related entries in `ROADMAP.md`'s gap register reached their current state by applying
that by-hand method fresh each time — **G-01** (`:1936`, closed) and **G-29** (`:1974`, closed
with a residual configuration gap), with **G-03** (`:1938`, recovery half closed, spawn-path half
still open under 4D.5) and **G-34** (`:1978`, "real but dark" — not closed) showing the method's
cost: it is rerun by hand, and the halves it does not reach stay open. An ingested trace graph
turns "reachable + probe-`answered` + zero real production dispatches" into a standing,
automatically-refreshed finding instead of a rediscovery exercise every session.

### Why you might not want this

ADR-030 already banked the cheapest, highest-value slice of "dynamic truth over the catalog" —
found real bugs, shipped in one day, at gate-time cost. The marginal value of full multi-step
trace ingestion on top of that is real but measurably smaller than it would be if ADR-030 did not
exist. Building a correlator that survives `devtools.log`'s documented 100MB rotation and
concurrent-observer ordering, without ever misattributing a dispatch (which manufactures a false
"not dormant" verdict — actively worse than the manual-grep status quo, per this repo's own
zero-tolerance stance on fabricated observed-plane data), is a real engineering cost that should
not be underestimated relative to ADR-030's one-day build.

---

## 3. Temporal & Concurrency Protocol-Conformance Intelligence

### (a) Axis of truth and the failure mode it catches

VI's call graph is inherently a single point in time: it shows that `RecoveryService.execute` is
called, not that a crash between lease acquisition and lease persistence leaves the system in a
safe state, and not that two processes writing the same persistence directory don't silently drop
one of them. This axis is about **interleavings and crash points**, a property of execution over
time and across processes, invisible to any static graph by definition. ADR-029 is the sharpest
evidence this is real, not hypothetical:

> `saveLedger` performs a read-modify-append with **no locking anywhere in the repository** (a
> search for `flock`, `lockfile`, `.lock`, `pidfile` across `packages/*/src` and `scripts/`
> returns only the unrelated npm-lockfile gate). Reproduced directly: `B's append REFUSED: cannot
> overwrite persisted trace packet trace_2` / `B's evidence on disk -> false (silently dropped: no
> retry, no rebase)`. **Evidence that was taken and then dropped is worse than evidence never
> taken**, because the ledger reads as complete in both cases.

This was found by direct reproduction during an audit, not by any gate. Six ADRs in this
repository (012, 016, 018, 023, 026, 029) exist *specifically* to reason about crash points,
recovery authority, and idempotency — a concentration of architectural effort on exactly this axis
that has, today, zero machine-checked, continuously-verified representation. Each ADR's own
"Test implications" section independently lists the crash points it expects covered (ADR-012:
"Lease tests must cover expiry, explicit release, ambiguity, cross-campaign exclusion, **crash
before/after each durable step**, and bypass deficits"), but nothing cross-checks that list
against what the test suite actually exercises — it is asserted in prose, once, per ADR, and never
revisited.

### (b) Canonical artifact / ontology

```yaml
node_kinds:
  - kind: durable_transition       # a governed state change: gate checkpoint, ledger append,
                                    # lease acquire/release, recovery record, writer-lock acquisition
    identity: "txn:<owning-symbol>::<transition-name>"
    attributes:
      owning_adr: [ADR-012, ADR-016, ADR-018, ADR-023, ADR-026, ADR-029]
      crash_points_claimed: []     # extracted from the ADR's own "Test implications" prose
      crash_points_tested: []      # cross-referenced against actual test titles/structure
      idempotency_key_present: bool
      concurrency_model: single-writer | multi-writer-advisory-lock | untested

edge_kinds:
  - relation: recovers_via         # durable_transition -> recovery mechanism
  - relation: races_with           # two durable_transition nodes sharing a persistence directory
                                    # with no serialization edge between them (generalizes the
                                    # exact ADR-029 shape into a standing check)
```

### (c) Planes / tiers reconciled

`intended` (each ADR's prose-named crash points) → `declared` (a repo convention, if adopted) →
**`derived-by-fault-injection`** — deliberately not VI's ordinary `derived` (static structure);
this plane can only be populated by actually running a harness that exercises the named
interleaving → `observed` (unavailable, same honest absence as VI's own).

### (d) Deterministic extractor(s) and honest degradation — phased, deliberately

**Phase 1 (recommended to build now, genuinely cheap):** a markdown/text extractor over each
ADR's "Test implications" section (already prose-structured, one bullet per claim) cross-checked
against the *existence and title* of the `roundtrip=`-cited test files
(`recovery-lease-adapter.test.ts`, `interruption-runtime.test.ts`, `hash-chain-integrity.test.ts`,
`compaction-lifecycle.test.ts`, `writer-lock.test.ts`) — a coverage **matrix**, not a dynamic
engine. This is the same cost class as VI's own `extract-intent.mjs` (a markdown parser), not a
novel build.

**Phase 2 (explicitly a separate, later decision, not bundled into "build this category"):** an
actual fault-injection harness that kills a subprocess at instrumented boundaries and asserts the
invariant survives. This is where the real engineering cost and flakiness risk live — see "Why you
might not want this" below.

Honest degradation: without Phase 2, every `derived-by-fault-injection` edge is `agent_inferred`
from prose-matching alone and must say so loudly — a coverage matrix built from prose claims,
without dynamic verification, is a weaker artifact than its name suggests, and the manifest must
carry that caveat on every view, mirroring VI's own discipline for `observed: unavailable`.

### (e) Invariants / queries

- `INV-TIME-01` — every `durable_transition` whose owning ADR's prose names a crash point has at
  least one matching test, or is flagged `crash_point_unwitnessed` (maps to the repo's own
  `M-B`/`verification_gap` taxonomy per `references/vocabulary.md`'s mapping table — this needs a
  human decision on whether it earns a new `M`-letter or reuses an existing category; per
  `machinery.md`'s own rule, extending `gap-taxonomy.csv` is a change to that file, not a local
  decision this proposal can make).
- `INV-TIME-02` — no two `durable_transition` nodes write to the same persistence directory
  without a `races_with` edge resolved by a serialization mechanism (`ADR-029`'s writer-lock) —
  generalizes the ADR-029 finding into a standing detector rather than a one-time patch.

### (f) Hooks and CI ratchet

Informational only — this category's entire evidence base is retrospective (all six ADRs were
written *after* a defect was found, none pre-emptively). A Stop hook flagging a new
`saveLedger`-shaped call site (a new persistence-directory writer) with no accompanying
writer-lock acquisition directly generalizes ADR-029's own fix into a standing check instead of
a one-time patch — this is the single highest-leverage, cheapest hook in this whole proposal,
because it turns one already-fixed bug class into a permanent detector for its recurrence.

### (g) Interop with the existing VI graph

`durable_transition` nodes join VI's graph on the same symbol ids (`RecoveryService.execute`,
`EvidenceLedger.append`, `acquireWriterLock`) — a temporal annotation layer over existing VI
nodes, not a parallel node space.

### (h) Specific defects this repo it would have caught

ADR-029's two-writer silent evidence-loss bug, found only by direct reproduction. ADR-018/G-04's
Hollow-shape compaction defect: the loop called `recordCompactionLifecycle` with empty evidence
pointers on **every** auto-compaction, the ledger validator correctly threw, and a bare `catch {}`
swallowed the exception — shipping silently until caught. A Phase-1 coverage matrix, cross-checking
ADR-018's own "Test implications" ("crash after each durable boundary... no false critic/event/
tree transition on a failed or interrupted compaction") against what actually existed in
`loop.test.ts`, would have flagged that no compaction crash-boundary test existed at all — the
exact gap `G-24` documents was covered only by a test that "could not fail"
(`expect(lifecycles.length).toBeGreaterThanOrEqual(0)`, always true for any array).

### Why you might not want this

Phase 1's value is real but bounded — it tells you a test exists *near* a named crash point, not
that the test actually forces the interleaving it claims to (that is category 4's question, not
this one). Phase 2 — real fault injection — is a multi-week build with genuine flakiness risk:
kill-timing races are inherently hard to reproduce deterministically in CI, and a flaky
fault-injection gate is a worse outcome than no gate at all, per this repository's own
zero-tolerance for a safeguard that is "documented but not confirmed" (the exact shape ADR-024
names as worse than an absent one). The honest recommendation is to build Phase 1 now and treat
Phase 2 as its own, later, separately-costed decision — not to promise the full vision in one pass.

---

## 4. Assertion-Strength (Mutation-Verified) Test-Efficacy Intelligence

### (a) Axis of truth and the failure mode it catches

VI's `verification_status` axis (`unverified` → `test_imported` → `test_executed` →
`test_asserted` → `integration_verified`) and its status-and-stubs.md heuristics #23–26
("verification theater": "test proves only the stub," "tautological assertion") already *gesture*
at this question, but concede plainly that they are static pattern-matches — heuristic #23's own
detection method is "change the constant mentally — would the test still pass?", a manual thought
experiment, never `derived`. This category converts that from a mental exercise into an executed,
measured signal: actually mutate the implementation (flip a comparison, delete a branch, replace a
constant), rerun the suite, and record whether anything goes red.

Two live, self-documented instances of exactly this failure mode already exist in this repository,
found only because a human happened to reason through them by hand:

> **G-38** — `KnowledgeBase.write()` routes `failure_mode` entries into both the private
> `shortTerm` and `longTerm` maps... but every entry is written to `longTerm` regardless of type —
> **"both short-term branches could be deleted and no test in `packages/arbor-kb/tests/` would
> fail."** Found while authoring ADR-010's obligations; its O2 and O3 are declared with **no proof
> attached, for exactly this reason** — the author checked, by hand, that citing an existing test
> would be a false proof.

> **G-24** — "A test that could not fail." `loop.test.ts:251-270` asserted
> `expect(lifecycles.length).toBeGreaterThanOrEqual(0)` — vacuously true for any array — then
> guarded its only real assertion behind a branch that never executed. The test passed
> unconditionally for however long it shipped.

Both are, precisely, "this test would pass whether or not the code under test is correct" — the
definition of a surviving mutant. Both were caught by a human's manual mutation-style reasoning,
not by any gate.

### (b) Canonical artifact / ontology

```yaml
node_kinds:
  - kind: mutant
    identity: "mut:<target_symbol>::<mutation_operator>::<location>"
    attributes: {mutation_operator, killed_by: [test_id] | null}

# extends an existing VI edge (tests) rather than inventing a new one
edge_attributes_added_to: tests
  - mutation_score: killed | survived | equivalent | not_run
```

### (c) Planes / tiers reconciled — an honest exception to the four-plane model

This axis has essentially no `intended`/`declared` equivalent — no ADR asserts "this line must be
mutation-tested" — so forcing VI's four-plane reconciliation here would be manufacturing structure
that does not exist. The comparison that actually matters is narrower and single-plane: VI's own
`test_demonstrated` discovery value (reserved in the parent skill's vocabulary, per
`references/vocabulary.md`'s own note — **"Proposed as an addition to `graph-schema.json`'s enum
via the ontology-extension artifact,"** not yet adopted here) vs. mutation-verified — does an
assertion-bearing test remain assertion-bearing under adversarial mutation, or was it only ever
exercising the happy path.

### (d) Deterministic extractor(s) and honest degradation

Reuse an existing TS mutation engine (e.g. Stryker) rather than building one — directly following
this repository's own prior-art discipline (mimesis over reinvention). Scope initially to
`packages/arbor-core` and `packages/arbor-audit` — the two packages carrying the scoring and
ledger logic the rest of the system trusts most — not the whole eleven-package monorepo.
Full-matrix mutation testing across ~1,676+ tests (the count `ADR-027`'s Test implications cites
as the suite size at that point) and eleven packages is computationally prohibitive per run; the
manifest must say `mutation_coverage_scope: partial` with the reason stated, exactly mirroring
VI's own rule that a partial extraction must say so rather than silently pass as clean.

### (e) Invariants / queries

- `INV-MUT-01` — no node may carry VI's own `verified` status if its covering test(s) show
  `mutation_score: survived` on the specific line/branch the claim depends on. This is a strictly
  *tighter* version of VI's existing `INV-15` ("no node has status `verified` without
  assertion-bearing evidence"), applied only within the scoped packages — it does not conflict
  with the parent invariant, it sharpens it where it is affordable to.

### (f) Hooks and CI ratchet

Informational/ratchet only, and likely to **stay** there rather than ever reach `strict` —
mutation runs are too slow for per-commit or even per-session feedback (a Stop hook is low-value
here; the natural cadence is nightly or weekly, a genuine deviation from VI's dirty-tracking model
worth stating plainly rather than forcing a fit it does not have).

### (g) Interop with the existing VI graph

`mutant.target_symbol` resolves against VI's existing `sym:` ids. Findings attach to VI's existing
`verification_gap` category rather than inventing a new one; `mutation_score` is a new field on
VI's existing `tests` edges, not a new edge kind.

### (h) Specific defects this repo it would have caught

G-38 (dead short-term-memory branches, self-admitted by ADR-010's own unproven O2/O3) and G-24
(the vacuous `toBeGreaterThanOrEqual(0)` assertion) — both found only by a human manually asking
"what if this were deleted or wrong," the exact question this category automates and would run
continuously rather than once, by hand, during an audit.

### Why you might not want this — the bluntest of the four

This is the most expensive category to run continuously (mutation testing typically multiplies
suite runtime by 10–100×), the hardest to keep from becoming exactly the kind of ignored,
`REPORTED`-tier signal ADR-025 already found this repository is prone to producing, and the
existing static heuristics (VI's #23–26, plus this repo's own `scripts/anti-stub.mjs`) already
catch a meaningful fraction of the same defect class far more cheaply, if more approximately.
**Recommendation: do not build this until categories 1–3 are running and there is direct evidence
the cheaper heuristics are missing real defects** — building the expensive tool speculatively,
before that evidence exists, repeats the exact "safeguard nobody needed yet" pattern this
repository's own `gate:liveness` design (Decision point 5, ADR-030) explicitly guards against for
self-attestation.

---

## Ranking and the build-first call

| Rank | Category | Reasoning |
|---|---|---|
| **1 — build first** | Authorization & Enforcement-Strength | Cheapest of the four (mostly a query over VI's *existing* call-graph output, plus one CI-config parse and one external API probe). Highest hit rate against real, already-documented misses: three ADRs (024/025/028) already burned human-audit cycles on exactly this question, one of them (028) miscounting its own coverage inside the document meant to settle it. |
| 2 | Runtime Execution-Trace (deep observed plane) | Highest ceiling value — completes a plane VI's own schema already reserves — but ADR-030 shipped one day before this document was written and already banked the cheapest slice of the same axis. Build second; consider scoping the first cut to just the `config_induced_dormancy` invariant rather than the full trace-ingestion pipeline. |
| 3 | Temporal & Concurrency Protocol-Conformance | Phase 1 (the prose-to-test coverage matrix) is cheap and should ship alongside rank 1–2. Phase 2 (real fault injection) has the highest engineering cost and flakiness risk of anything in this document — treat it as a separate, later decision, not part of "building this category." |
| 4 — defer | Assertion-Strength (Mutation) | Real, evidenced (G-24, G-38), but worst cost-to-run ratio, most likely to become an ignored signal per this repo's own ADR-025 lesson, and most redundant with cheap heuristics already in place. Revisit only after 1–3 are live and demonstrably still missing defects. |

---

## Shared substrate: what to factor out once, not reimplement four times

CLAUDE.md's own §4.1 (Rule of Three: "first occurrence, write it; second, tolerate it; third,
abstract only if the duplication is real") is the right test here, and with four new categories
plus VI itself, the line is crossed. What all five (VI + these four) share, concretely:

- **The four-tier doctrine and the discovery/confidence provenance model.** Every category above
  reuses `discovery: declared|derived|observed|test_demonstrated|agent_inferred|unknown` and the
  four-value confidence scale verbatim rather than inventing its own — this is already the
  cheapest, highest-leverage thing to hold in common, and it costs nothing to share since it is
  pure vocabulary.
- **Manifest-level freshness and typed-`unavailable` plane status.** `.visual-intelligence/
  manifest.json`'s `{status, reason, would_have_answered}` shape for an absent plane is exactly
  what categories 2–4 need for their own absent/partial planes (`observed: unavailable`,
  `mutation_coverage_scope: partial`). One shared manifest schema fragment, not four
  independently-invented ones.
- **The four hook contracts.** `vi-freshness.sh` (SessionStart), `vi-dirty-track.sh`
  (PostToolUse), `vi-graph-debt.sh` (Stop), and `vi-readonly-guard.sh` (PreToolUse) are already
  written generically enough — they key off `.visual-intelligence/manifest.json` and
  `.visual-intelligence/.dirty` by path — that they could be parameterized by directory
  (`.auth-intelligence/`, `.temporal-intelligence/`, etc.) rather than copy-pasted four times.
  Four near-identical shell scripts per hook event is the literal AHA-violating duplication
  CLAUDE.md warns against; a single parameterized hook family is the cheaper, more honest build.
- **One waiver store, never a second one.** `revoy2-visual-intelligence`'s own load-bearing rule —
  "waivers live in `scripts/reachability/allowlist.json`... `.visual-intelligence/exceptions/`
  mirrors it and adds the checks the allowlist cannot make itself... it never becomes a second
  store" — must bind all four new categories identically. Category 1's `G-14` waivers, category
  3's crash-point exceptions: all cite the *same* `allowlist.json`, never a category-specific
  `exceptions.jsonl`. Machinery.md already names the failure mode this prevents: "two stores means
  two truths, and the older one silently wins."
- **The CI strength ladder (PREVENTED/BLOCKED/REPORTED/DETECTED).** ADR-025 established this
  vocabulary for the *whole repository*, not just VI. Every gate any of these four categories ships
  must self-report on this same ladder — and category 1 is, not coincidentally, the mechanism that
  keeps the *other three's* own strength claims honest, not only VI's.
- **"Measure, never cite."** `revoy2-visual-intelligence/SKILL.md`'s own lesson — hardcoded counts
  in a skill doc go stale within a day — applies identically to all four proposed skills. Each
  needs its own `baseline.mjs`-equivalent rather than prose numbers, exactly as this document's own
  opening disclaimer concedes about its own citations.
- **One writer per generated artifact.** `vi-refresh.mjs`'s own header names the reason a single,
  ordered, three-extractor pipeline exists rather than four ad hoc regeneration paths: a
  17–28MB committed JSONL graph cannot be merged textually across parallel branches, so it needs
  exactly one writer, in a fixed extractor order (derived → intended → exceptions), or the result
  "is not the artifact this repository reviews." Every one of the four categories above produces
  its own large generated JSONL artifact and inherits the identical risk `ADR-029` named for
  persistence directories. A single shared `refresh-pipeline` helper, parameterized per category
  rather than four hand-copied `*-refresh.mjs` scripts, is the correct factoring — and skipping it
  reproduces the exact "documented but not wired" trap ADR-029 itself rejected as a cheaper
  alternative ("convention without enforcement... creates the belief that the directory is
  protected while leaving the proven path open").
