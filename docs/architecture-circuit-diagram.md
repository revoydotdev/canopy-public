# The harness circuit diagram
Artifact kind: architecture
Status: draft
Revision: 1
As-of commit: 82ce26a10946cbc6e98617ceddb1cef0607cef14
Authority: derived from a gitignored, locally regenerable artifact; not an accepted decision, no ADR, no operator sign-off.
Evidence scope: mixed — every count and every path:line is static-analysis-derived and pinned to base revision 82ce26a1; the observed runtime plane is UNAVAILABLE (static analysis only), hollow defects are structurally undetectable and are not shown, and packages/arbor-mcp/src is covered only by the type_only and dynamic edge strata, not by static call edges.
Supersedes: none
Superseded by: none
Owner: revoy2 campaign plan .omo/plans/revoy2-harness-circuit-dag.md (untracked; not a governed path).
Review trigger: any change to the 74-path quarantine boundary or to base revision 82ce26a1; also a vi:refresh, which would make this document's node, symbol and edge counts unciteable.

This document is the prose synthesis of a circuit analysis of `revoy2`. It answers one
question: **how does a task become a governed, evidenced result in this repository, and
where can this analysis not follow it?**

It is not a second architecture document. `docs/architecture.md` describes the system's
shape. This document describes the *wiring* that shape runs on, and it is honest about the
places where the wiring cannot be observed from the evidence available.

Every structural claim below carries a `path:line` citation or a named measurement rule.
Every count carries the artifact that produced it. A view's silence is not absence, and a
derived edge is not an observed one; both are labelled where they appear.

---

## 0. Evidence anchor

All counts in this document were measured against a **snapshot copy** of the graph, never
the live files, because a sibling process transiently rewrote the live `edges.jsonl` during
the run.

| file | sha256 | lines |
|---|---|---|
| `nodes.snapshot.jsonl` | `ad40747907c7d2b83b492979f30794029e291da82ef986a15be46dd379dab874` | 35,816 |
| `edges.snapshot.jsonl` | `3f14017d7f8ab0f99e39c849969102d72d1df5eb72e36b4056366f3e13ae5fdb` | 133,087 |

Both checksums are byte-identical to `.visual-intelligence/graph/{nodes,edges}.jsonl` at
measurement time. Base revision: `82ce26a10946cbc6e98617ceddb1cef0607cef14` (worktree and
MAIN HEAD agreed at observation).

**The graph files are gitignored** (`.gitignore:81`; `git ls-files .visual-intelligence/`
does not list `graph/`). The graph therefore cannot honestly be pinned to HEAD, and this
document is pinned to the base revision instead.

---

## 1. What this diagram cannot answer

These are the five holes. Each one is a question a reader would reasonably expect answered,
and each one has no answer available. Absence here is *undeterminable*, which is not the
same claim as "none".

None of the five is the biggest limitation of this document, because the biggest one is not
a hole in the corpus — it is a hole in the evidence for the corpus. Three adversarial oracles
attacked these measurements and **all three returned verdicts that block delivery**: the
`calls` relation is not a census, the cited/derived rule does not discriminate, and the
egress and ingress enumerations are not exhaustive. Section 10 carries their verdicts, and
sections 3.2, 3.3, 3.5 and 5 carry the specific corrections.

### 1.1 The `observed` plane is UNAVAILABLE

Every scope in the graph declares `observed: "unavailable"` with the reason `"static
analysis only; no runtime evidence source"`. Nothing here is witnessed at runtime. Every
statement in this document about what code *does* is a statement about what the source
*declares*, and a declaration is not an execution. The observed plane is what would answer
`derived` becomes `observed`, dormant-branch detection, and dispatch edges. Only
`bun run vi:observe` can reach it; no scope change can.

**In particular, the `scripts/` upgrade does not reach it, and must not be credited with
it** (`CD-CD-06`). Route C — moving extraction over `scripts/**/*.mjs`, which would add
11,038 `scripts/` nodes (BS-001, row 74 of the appendix) — was measured and is **DEFERRED**,
not adopted: `.mjs` is absent from `typescript.extensions` at
`scripts/lib/lsp-client.mjs:41`, and `scripts/vi-refresh.mjs:475` hardcodes
`"--language", "typescript"`. But that deferral is beside the point. Route C widens the
**static** `derived` plane. The `observed` plane needs a *runtime evidence source* —
`devtools.ts`'s ND-JSON stream is the designated future ingestion point — and no amount of
source-extension coverage creates one. An unavailable plane stays unavailable however wide
the derived plane gets. The one thing Route C changes is how much of the repository the
static plane can see; the static plane was never able to answer the observed question.

### 1.2 Hollow defects are structurally undetectable here

A hollow defect is reachable code short-circuited by a guard on an unset value. Static
structural analysis cannot see it, and the graph's own `hollow_candidate` category is the
wrong instrument: its `claim` field asks whether a production-reachable symbol is exercised
under a production run, which is the *observed-plane* question, not the hollow question. It
flags symbols such as `arbor-core/src/tree.ts::verifyNode` and
`arbor-gate/src/gate.ts::checkEvidence` that run on every campaign. That category raised
**51** `hollow_candidate` findings over 163 symbols. The separate `triage.jsonl` holds **62
rows** — 57 `accepted_tradeoff`, 5 `false_positive`, 0 genuine hollow — and those 62 rows
are a **sample of adjudicated findings, not an audit of all 51**, so the ratio carries no
information about the 51. Source: `findings-hollow.md` H-04.

The structural plane returned a clean bill of health on every node while four real hollow
defects were confirmed by reading. That is the defect class working as designed, and it
means **a clean structural sweep is not evidence of absence of hollowness**.

### 1.3 The `scripts/` call graph is absent by construction

The graph's declared scope is exactly `packages/*/src/**` and `packages/*/tests/**`. There
are **zero** nodes under `scripts/`. This is correct scoping, not drift:
`arbor.profile.jsonc:46` declares `source_roots: ["packages"]`, and
`scripts/vi-refresh.mjs:183-185` builds the extractor's `--include` from `source_roots`
alone. Any question of the form "does `scripts/` reach into `packages/`?" is unanswerable
from the graph, because one whole side of the boundary is outside it.

**This is governance-closed, not technically closed.** Widening the seam was measured
working end to end: 46,853 nodes and 156,849 edges, reachability computed with 75 roots,
39 of 39 entry points materializing, 11,038 `scripts/` nodes, and 248 measured
cross-boundary `scripts` to `packages` edges. The route is closed only because
`scripts/vi-refresh.mjs` **is** `gate:vi-reproducible`, so editing it edits a blocking
gate's own extraction logic, which requires its own ADR, a full battery run, and a graph
regeneration. The honest statement is: there is no route that is both compliant and free
of governance cost.

Note the asymmetry in those 248: all point `scripts` to `packages`, none the reverse.
`scripts/` is a leaf consumer of `packages/` at the symbol level. And the graph asserts
this statically without witnessing it: `scripts/` dispatches 163 capability kinds by <!-- sur-05:historical — counted at this document's As-of commit 82ce26a1 -->
string at runtime, which no static scope change can reach.

### 1.4 A sibling agent's 64 changed paths are outside this analysis

At the base revision the working tree carried a large in-flight change set belonging to
another governed agent. The plan recorded 66 total changed paths and an "in-scope or
adjacent" total of 64. Independent measurement found **74**, decomposed as 65 modified and
9 untracked, with 56 under `packages/`, 9 under `scripts/`, and 9 elsewhere. The plan's 64
was an arithmetic artifact: 55 + 9 = 64 does not decompose its own 66. None of those 74
paths is this analysis's work, and no claim here rests on them.

### 1.5 The base revision, not HEAD

Every number is as of `82ce26a1`. The graph on disk was built at `12f3c56b`, five commits
behind. Nothing here describes a later revision.

---

## 2. The causal spine

This is the trace. Each hop names the file, the line, and what the line does. A hop with no
`path:line` is not a hop.

### Hop 1: entry

`packages/arbor-mcp/src/cli.ts:2524` : `export async function main(...)`. The single
process entry. It loads project environment then user environment, so a project-level
placeholder cannot shadow an operator key, and strips `--safe-mode` from the argument
vector before dispatch.

### Hop 2: runtime construction

`packages/arbor-mcp/src/cli.ts:1810` : `createCliRuntime(...)` builds an `ArborRuntime`.
From there the router is constructed at eleven distinct sites, for different surfaces:
`cli.ts:807` (runtime port adapter), `:1233`, `:1258` (composed runtimes), `:2145` and
`:2603` (remote ingress), `:2648` and `:2817` (remote control), `:2844`, `:2889` (the
`arbor resume` path, which supplies `recovery_service`), `:2905`.

### Hop 3: the router

`packages/arbor-mcp/src/runtime-catalog.ts:309` : `export class RuntimeCatalogRouter`.

**Dispatch is not a switch.** It is a type-predicate ladder. The command entry is
`dispatchCommandObserved` at `packages/arbor-mcp/src/runtime-catalog.ts:355`, and it opens
with 29 predicate branches. The query entry is `executeQueryObserved` at
`packages/arbor-mcp/src/runtime-catalog.ts:677`, opening with 40 branches. Behind those
ladders sit a small number of genuine `case` switches: one at `:1746` with 14 cases.

**The DAG cannot follow this reliably.** A map built from `case "...":` labels captures 33
of 195 kinds. The other 162 are reached by a type predicate or a guard predicate, and the
graph records no edge for them. This is an under-report, stated here so a reader does not
read a thin router subgraph as a thin router.

Before any branch runs, the command ladder refuses on seven front gates in order:
`unsupportedCommandKind(input)` refuses a `supported: false` command *before any guard
runs* (`runtime-catalog.ts:3078-3086`), then `commandSession(...)` checks permission, then
`validateRuntimeCommand(input)`, then `catalogEntry(envelope.command.kind, "command")`,
then `operations.accept(...)`, then the `entry.supported` check, then `this.authorized(entry)`.
69 guards are declared in total.

### Hop 4: admission gate

`packages/arbor-gate/src/gate.ts:60` : `export function checkAdmission(check)`.

Called from `packages/arbor-mcp/src/manager.ts:456` in `startCampaign` (declared at
`:445`) and again at `manager.ts:498`. The result is checkpointed via
`this.checkpointGate(id, "root", "campaign_start", ...)` before it is inspected, so the
gate decision is durable even on the refusal path.

### Hop 5: campaign manager

`packages/arbor-mcp/src/manager.ts:312` : `export class CampaignManager`. It owns all
campaigns, the shared KB, and the evidence ledger (`manager.ts:316` instantiates
`EvidenceLedger`).

### Hop 6: isolation gate

`packages/arbor-gate/src/gate.ts:72` : `export function checkIsolation(check)`.

Called at `manager.ts:733`, in the node-expansion path whose signature is at `manager.ts:726`
and takes `{ worktree_isolated, starting_commit_correct, lease_acquired }`. A second call
site exists at `manager.ts:1604` on the recovery path, which supplies `lease_acquired: true`
explicitly. On a fail, `attachGateRecord(node, isolation)` has already run: the refusal is
attached to the node, not just returned.

### Hop 7: specialist worktree

The worktree machine lives at `packages/arbor-campaign-support/src/worktree.ts`, not in
`arbor-mcp`. The manager states the boundary in its own comment at `manager.ts:2559-2560`:
worktree and lease acquisition are owned by the campaign-support `WorktreeManager`, so the
manager's `workspace` status is honestly always `"ready"`. Isolation is therefore *declared
to* the manager, not performed by it, and `checkIsolation` is a pure function over a
declaration.

### Hop 8: critic, and the evidence gate

`packages/arbor-mcp/src/manager.ts:759` : `recordResult(...)`, documented at `:754` as
"Record a Specialist's result. Runs the evidence gate and Critic verdict."

The order is load-bearing and is enforced in source. At `manager.ts:912` a critic-approved
result is required before any evidence reasoning runs; a rejection routes to
`recordFailure(...)`, which extracts a failure-mode KB entry. Only on approval does the
evidence gate fire.

`packages/arbor-gate/src/gate.ts:85` : `export function checkEvidence(check)`, called at
`manager.ts:919`. It reads `params.provenance.tag`, and supplies `stdout_hash` and
`exit_code` **only** when the tag is `"verified"`. Its checkpoint is written at
`manager.ts:927` as `node_verification`, and `attachGateRecord(node, evidence)` runs at
`manager.ts:934`.

### Hop 9: provenance is a type, not a comment

`packages/arbor-core/src/types.ts:48` : `export type Provenance`, a four-arm discriminated
union:

```
{ tag: "verified";         cmd; exit; stdout_hash; check?; strength? }
{ tag: "claimed";          claimant }
{ tag: "critic_approved";  critic; rationale }
{ tag: "generated";        generator; input_hash }
```

This is the repository's central invariant and it is enforced by the type system, not by a
convention. A `claimed` result cannot supply a `stdout_hash`, because the arm does not have
the field to supply.

### Hop 10: the evidence ledger

`packages/arbor-audit/src/audit.ts:1032` : `export class EvidenceLedger`, held by the
manager at `manager.ts:316` and read back at `manager.ts:1433` (`getRecords`),
`:1464`/`:1497` (interruptions), `:1567` (recovery decisions), `:1587` (gate checkpoints).
The gate checkpoint read at `:1587` is what lets a recovery decision consult what the gates
actually decided rather than what a caller asserts.

### Where the DAG cannot follow the spine

Three breaks, all structural:

1. **The router break.** The 29-branch predicate ladder is invisible to edge extraction. 162
   of 195 kinds have no `case`-label edge.
2. **The `scripts/` break.** No call-graph nodes exist for `scripts/`, so the gate scripts
   that wrap the real enforcement are not in the DAG at all. See section 1.3.
3. **The execution break.** Every `reachable_from` edge in the graph is BFS-derived, not
   execution-derived. See section 3.3.

---

## 3. The graph as measured

### 3.1 The ten relations partition the corpus exactly

`total_edges == relation_sum == 133087`, `unparseable_lines: 0`,
`partition_is_exhaustive: true`. Counts are from `relations.json`, whose pinned command is
`node .omo/circuit-dag/census.mjs <edges> <out>`.

| relation | edges | cited | derived |
|---|---|---|---|
| `references` | 36,323 | 36,323 | 0 |
| `contains` | 35,799 | 34,519 | 1,280 |
| `reachable_from` | 21,335 | 0 | 21,335 |
| `calls` | 18,105 | 18,105 | 0 |
| `tests` | 16,066 | 16,066 | 0 |
| `imports` | 3,639 | 3,639 | 0 |
| `instantiates` | 1,271 | 1,271 | 0 |
| `exports` | 443 | 443 | 0 |
| `extends` | 62 | 62 | 0 |
| `implements` | 44 | 44 | 0 |
| **total** | **133,087** | **110,472** | **22,615** |

### 3.2 The cited/derived rule, and its limit

**Rule `CIRCUIT-DAG-1`**, from `cited-vs-derived.json`, pinned command
`node .omo/circuit-dag/classify-edges.mjs <edges> <out>`:

```
cited   <=>  /^(?<path>.+):(?<line>\d+)$/.test(edge.evidence_location)
derived <=>  the negation
```

An edge is *cited* if and only if its `evidence_location` names a line. There is no
judgement in the rule. 110,472 cited, 22,615 derived, 83 percent cited.

**The rule partitions relations; it does not discriminate within them.** Only `contains`
splits at all, 34,519 cited against 1,280 derived. The other nine relations are 100 percent
one class or 100 percent the other. So `CIRCUIT-DAG-1` is a relation classifier wearing a
citation classifier's clothes, and a reader who applies it expecting within-relation
discrimination will be disappointed.

### 3.2a LIMITATION — the rule is correct; its validation is weaker than its correctness

This is the honest statement of the limit, and it is deliberately narrower than
"the rule is wrong". **X-09: correctness and validatedness are different
properties, and collapsing them would either overstate the rule or discard a
correct artifact. Neither is done here.**

`CIRCUIT-DAG-1` is **correct at this revision.** `evidence_location` names a line
if and only if the edge is cited — that is a true statement about all 133,087
edges, with 110,472 cited + 22,615 derived = 133,087 and an exhaustive partition.
The rule is **kept**.

What the rule lacks is **independent discriminating evidence**. An adversarial
oracle measured it: `CIRCUIT-DAG-1` is **100.0000% collinear** with
`source.startsWith("pkg:") || relation === "reachable_from"` — a predicate that
never inspects `evidence_location` at all. **Re-measured over the whole corpus for
this section: NOT ONE EDGE IN 133,087 has evidence shape and relation
disagreeing** (`relation_vs_shape_disagreements = 0`). The rule therefore
**partitions** relations perfectly and **discriminates** nothing. Those are
different properties, and only the first has evidence on this corpus. A corpus
containing one counterexample would separate them; this one does not, so nothing
here shows the rule would survive it. Source: `evidence/todo-29-oracle2.md` F1;
reproduced by the measurement recorded in §3.2b.

Consequence, stated as a limit and not as a verdict: `CIRCUIT-DAG-1` is applied
without error and is nonetheless the wrong instrument for any job that needs
*within-relation* discrimination. `confidence` cannot substitute — every value
spans both classes (§3.3).

### 3.2b LIMITATION — the structural approximation is a one-way screen, never a classifier

The renderer-side approximation
`relation === "reachable_from" || (relation === "contains" && an endpoint node-id starts with "file:")`
is **SOUND** — it matches all 22,615 derived edges with 0 exceptions — and
**INCOMPLETE**, because it also matches **34,519 CITED edges** (package→symbol
containment carrying a real `path:line`).

| figure | value |
|---|---|
| total edges | 133,087 |
| cited / derived (by the rule) | 110,472 / 22,615 |
| sum-check `110,472 + 22,615` | 133,087 |
| partition is exhaustive | true |
| relation vs evidence-shape disagreements | **0** |
| approximation matches derived | 22,615 (all of them) |
| **approximation matches CITED** | **34,519** |
| derived edges NOT matching the approximation | 0 |

**So the approximation may say "definitely derived" and may never say "derived".**
`scripts/entrypoint-reachability.mjs` is the consequential consumer named here,
and it is constrained accordingly: `definitelyDerived()` is the *conjunction* of
the rule and the approximation, so a `cited` edge that matches the approximation
is not reported as derived. Worked example from the corpus —
`edge:00004a92702716a5`, a `contains` edge from
`file:packages/arbor-mcp/tests/governance-projection.test.ts` with
`evidence_location: …:497` and `confidence: "authoritative"` — matches the
approximation and is **cited**, so it is not definitely derived. Note the
confidence value: the strongest-sounding label in the vocabulary, on a cited edge,
which is why confidence cannot stand in for the rule either.

### 3.3 The 22,615 derived edges, and why 21,335 of them are a problem

The derived set decomposes exactly: **21,335 `reachable_from` plus 1,280 file-level
`contains`**.

All 21,335 `reachable_from` edges carry `evidence_location: "bfs from 75 declared roots"`,
which is prose, not a `path:line`. They also carry `discovery: "derived"`,
`confidence: "high"`, and `evidence_type: "ast_call"`. **`ast_call` is the modal value of the
whole corpus**: 34,171 genuinely cited edges carry it too. So the extractor has labelled a
breadth-first search over a name-resolution graph with the same field it uses for a
resolved call site, and marked it high confidence.

**`confidence` cannot be used as a citation filter.** All three values in the corpus
{high, medium, authoritative} occur on both cited and derived edges: `high` sits on 55,869
cited edges and on all 21,335 derived BFS edges; `authoritative` sits on 38,537 cited edges
and on the 1,280 derived `contains` inferences, which is the strongest-sounding value in
the vocabulary landing on the weakest evidence. `medium` is exactly the 16,066 `tests` edges
and nothing else, so it carries a relation signal, but a relation signal is not a citation
signal.

The structural approximation is safe in one direction only:
`relation === "reachable_from" || (relation === "contains" && an endpoint starts with
"file:")` matches all 22,615 derived edges with zero exceptions (sound), but also matches
34,519 cited edges (incomplete). Use it to say "definitely derived", never "derived". Zero
`reachable_from` edges carry a `path:line`.

**The defect is latent, and one blocking gate is already living with it.** The graph on
disk is unchanged. The most consequential consumer is not hypothetical:
`scripts/entrypoint-reachability.mjs` **is** `gate:entrypoint-reachability` (registered at
`scripts/gate-manifest.json:94` and in `scripts/execution-profile.json:980-981`). It reads
`graph/edges.jsonl` directly, never through `cited-vs-derived.json`, and its
`committedReachable()` filters on `relation` **alone** — no `confidence`, no
`evidence_type`, no `evidence_location`, no `discovery` filter. Its 21,335-node expectation
is therefore constituted 100% by the prose-evidence `ast_call` edges.

**This can mask a defect.** The expected side of the gate's self-check is defined as the
BFS's own output, so the check verifies that two mechanisms *agree* and can never verify
that either is *correct*. A genuine citation-level defect in the reachability graph — a
deleted or wrong `calls` edge — is invisible: the BFS reaches the node by a separate route,
`union` and `committed` still agree, and the gate reports `ok: true`. `report.ok` sets the
CLI exit code and is consumed by `scripts/completion-depth.mjs:363` as
`available: check.ok`. A consumer reading `confidence: "high"` on those edges would assert
21,335 verified citations. There are zero. Source: `evidence/todo-29-oracle2.md` §5.1.

**And the rule has no machine consumer at all.** Nothing in `scripts/`, `packages/` or
`.claude/` reads `cited-vs-derived.json`, and no script anywhere applies a `path:line`
regex to `evidence_location`. The quarantine of 21,335 is **documentation, not
enforcement**: nothing mechanically stops a future consumer from reading those edges as
high-confidence AST call evidence. Nothing in this document may be read as describing
observed runtime behaviour on the strength of a `reachable_from` edge. Source:
`evidence/todo-29-oracle2.md` §5.2.

### 3.4 The 1,280 derived `contains` edges

Shape: `pkg:<name> -> file:<path>`, with the `evidence_location` a bare path. They are
inferred, and todo 4 proved the inference is set-equal to the citations: the 1,280 file
nodes these edges point at are **exactly** the 1,280 distinct files named by cited
evidence locations, symmetric difference empty in both directions. The file has no line to
cite, so containment is derived from the file existing.

### 3.5 `calls` resolves completely, and is still not a census

18,105 of 18,105 `calls` edges resolve to a real line, across 1,205 distinct cited files,
with 0 missing files and 0 past-EOF. A negative control that removed exactly one edge moved
every dependent count by one and left the worktree file byte-unchanged. That measurement is
about *resolution* and it is true.

**It says nothing about completeness, and completeness was tested and failed.** An
adversarial oracle re-derived the call set from source with an independent
TypeScript-compiler-API extraction and found **621 strict call-set defects** inside the
declared `packages/` scope — call sites with both endpoints present in the graph and **no
`calls` edge**, against a threshold of 5. Its verdict is `VERIFIED`, and `VERIFIED` at 621
**blocks delivery**. It also measured the `scripts/` blind spot this document describes in
1.3: **24,984 distinct call sites, 0 represented, 0 rescued by an `imports` edge**. Two
further overstatements come from it: `.visual-intelligence/manifest.json` carries
`"extraction_gaps": []`, which is false, and reports `"module_resolution": {"unresolved": 0}`
as a clean bill of health while resolution health is being read as extraction completeness.
Source: `evidence/todo-28-oracle1.md` §§3, 5, 6, 7.

The two facts are not in conflict and neither cancels the other: **every edge the relation
carries is real, and the relation is not all the edges there are.** See section 10.

Separately: 7 of the cited files contain a NUL byte. This is a disjoint byte-content fact,
not a line-resolution failure, and is recorded so the two are not conflated.

### 3.6 Test nodes are included, and must stay labelled

**Decision: INCLUDE.** 13,095 of 35,816 nodes are test nodes, 36.57 percent, identified by
`attributes.is_test === true` alone. The stored flag and path-derived membership agree
**exactly and completely**: 13,095 agree, 0 path-only, 0 flag-only, 22,721 neither.

17 nodes carry no `is_test` key: 16 `package` nodes and 1 `entrypoint` node. None is a
test, and the entrypoint is also the only node with no derivable repo path. The residual is
fully accounted for.

52,384 of 133,087 edges touch at least one test node, 39.36 percent. The `tests` relation
is 100 percent test-touching; excluding test nodes would delete it entirely, leaving a
declared relation with zero edges, and would make the graph assert that this repository
contains no test evidence at all.

The opposite choice changes real numbers (22,721 nodes, 80,703 edges, `tests` to 0), so the
decision is load-bearing. But it is **cosmetic for two relations**: `exports` (443 edges)
and `reachable_from` (21,335 edges) have **zero** test-touching edges, so they render
identically either way. Do not use the export subgraph to demonstrate that the labelling
took effect.

Labelling rule, required of every view: classify by the stored flag, treat flag/path
divergence as a **graph gate failure to report** rather than a fallback to paper over,
distinguish test nodes by a non-colour channel so the distinction survives greyscale and
colour-vision deficiency, always render both totals as `N total (T test / N-T non-test)`,
and label the `tests` relation explicitly wherever relations are counted.

---

## 4. The dispatch surface

| quantity | value | source |
|---|---|---|
| catalog kinds | 195 | `runtime-catalog-manifest.ts`, rule `^\s*\{ kind: ` |
| supported | 163 | same file, `supported: true` |
| unsupported | 32 | same file, `supported: false` |
| direction: command / query | 104 / 91 | same file |
| distinct kind literals | 195 | equal to total, so no duplicate kind |
| unsupported carrying `unavailable_reason` | **0** | same file |
| `catalogEntry` call sites | 71 (40 literal, 31 dynamic) | `runtime-catalog.ts` |

Declaration site: `packages/arbor-core/src/runtime-catalog-manifest.ts`. Re-export site:
`packages/arbor-mcp/src/runtime-catalog.ts:226`, which reads
`export const RUNTIME_CATALOG = RUNTIME_CATALOG_MANIFEST;`. Counting the manifest therefore
counts the router's table.

**Zero of the 32 unsupported kinds carry an `unavailable_reason`.** The field is declared
optional at `runtime-catalog-manifest.ts:65` and populated nowhere. Consumers at
`runtime-catalog.ts:404`, `:779`, and `:2916` all read
`entry.unavailable_reason ?? "not available"`, so an operator receives the bare string
"not available" for all 32. This defeats a real probe: `packages/arbor-mcp/src/liveness.ts:433`
states that a `supported: false` kind "should refuse with its `unavailable_reason`", and
because the field is never set, the probe can never distinguish a deliberately absent kind
from a lazily declared one. The only place the field is ever set to a real value is a
fixture, `scripts/tests/registration-integrity.test.mjs:243` ("not wired yet").

All 32 unsupported kinds are `repo.flight.*`, added by commit `bcb0f831` on 2026-09-24.

---

## 5. Egress and ingress

These are modelled as first-class relations with pinned regexes, **not** read from the
symbol graph. That is deliberate: the graph has no `scripts/` nodes, so a graph-scoped
egress rule would be structurally blind to roughly a third of all egress.

Counting domain: `packages/**/*.ts` plus `scripts/**/*.{mjs,js}`, 1,611 files (1,279 under
`packages`, 332 under `scripts`).

| class | total | product only |
|---|---|---|
| `writes` | 3,603 | 886 |
| `spawns` | 992 | 248 |
| `fetches` | 67 | 30 |
| `mutates_git` | 547 | 123 (63 irreversible) |

**These are upper bounds with three adversarial verifiers on record, and the verifiers
overturned the census twice.** They are not accepted as complete. Verifier A and verifier B
are below. Verifier C, run later, overturned verifier B's own negatives and added **six
further sink misses** (`E-N1`…`E-N6`) that neither of them caught.

- **`fetches`: 17 genuine product misses, including every `@arbor/harness` provider call.**
  The rule's lookbehind rejects any receiver-qualified or injected `fetch`, and in this
  repository the injected-binding form is not an edge case, it is how every LLM provider
  call is written. `packages/arbor-harness/src/anthropic-messages.ts:282`,
  `bedrock-messages.ts:247`, `ollama-native.ts:238`, and `openai-compatible.ts:312` all
  read `await config.fetch(config.endpoint, ...)`. None is counted. The count of 30
  product fetches is a floor, and the surface it misses is the product's primary egress.
- **`writes`: 10 genuine product misses** for `writeSync`, `cpSync`, `linkSync`, and
  `new DatabaseSync(dbPath)` (a file write with no `fs` call at all).
- **`spawns`: 2 genuine product misses** for `Bun.spawn` and a `createRequire`
  indirection.
- **`mutates_git`: 2 irreversible misses**, one of which **falsifies a stated negative.**

**A third verifier found six more, on a different axis.** Verifier C's claim 1 is
`VERIFIED` at 6 new misses against a threshold of 5, and it `BLOCKS`. The common mechanism
is that each site is invisible to a pinned *verb* regex for a reason no widening of that
regex fixes, so these are the class boundary itself, not six more typos:

- **`E-N1`** a second writable SQLite database at
  `packages/arbor-mcp/src/canopy-debug-journal.ts:128`, opened by a **computed constructor**
  (`new (databaseConstructor())(...)`). Pinned `writes` match count **0**. Verifier B's row
  names only the KB store; widening its proposed alternation would fix that one and still
  miss this.
- **`E-N2`** the product sandbox's entire write primitive at
  `packages/arbor-mcp/src/sandbox/workspace-file.ts:33`, embedded as a `String.raw` worker
  program. All three of its `fs` calls match **0**, because the one-letter alias puts a `.`
  where the rule's lookbehind expects a boundary. This **contradicts a stated negative** in
  verifier B §7, which scoped the alias channel to the names `fsp`/`fsPromises` and
  concluded it closed.
- **`E-N3`** `chmodSync` at `packages/arbor-config/src/native-oauth-secret.ts:135` and
  `:167` — the permission bits on the file holding the operator's **OAuth tokens**. The verb
  is absent from the whole `writes` alternation. Verifier B's row names a git-hook chmod and
  calls it the important one; it is the least consequential `chmodSync` in the repository.
- **`E-N4`** `scripts/observe-devtools.sh` is **undeclared telemetry**, which retracts the
  "zero outbound telemetry" negative. A literal grep for tool names returns **0 hits** in that
  file, so every vendor-name probe missed it *by construction*.
  *Line citation, as of base `82ce26a1`:* the transmit was `:164` and the third-party default
  `MODEL` was `:39`. Both moved when ADR-173 landed — the consent gate is now `:107` and the
  transmit `:219`, with no default destination. **This row is remediated as of ADR-173**
  (every transmit path now requires `--allow-third-party-egress=<provider/model>` naming the
  destination, and `|| true` no longer swallows failure); the probe failure it records is not
  remediated and remains the reason a vendor-axis census cannot see this class.
- **`E-N5`** `scripts/hooks/pre-push:173` runs `bun install --frozen-lockfile` on every push.
  The existing rows charge that hook writes and spawns; **none charges it network egress**.
  All five pinned rules return **0**.
- **`E-N6`** `scripts/lib/tree-holders.sh:16` enumerates live coding-agent processes. **Not
  egress** — a local `pgrep`, no network. Recorded so the boundary is explicit and a future
  pass need not re-derive it.

Nothing in this list is remediated. Source: `findings-egress.md` §9z, from
`evidence/todo-30-oracle3.md` §1.2 and §4; the register rows are `CD-E-31`…`CD-E-34`.

**The shell-script counting-domain hole.** The egress census's rule reads
`packages/**/*.ts` and `scripts/**/*.{mjs,js}`. Shell scripts are in neither. The result is
that `scripts/hooks/pre-push:158` runs
`git -C "$toplevel" worktree remove --force "$candidate_root" || rm -rf "$candidate_root"`
inside a `cleanup()` function installed via `trap cleanup EXIT HUP INT TERM`, and the
census reports that surface as **covered**. It is an irreversible git site. The census
itself was corrected to add it; the rule defect is that the correction was found by a
verifier reading shell, not by the rule.

Quantified: the census's own follow-up claimed `writes +15` and `spawns +19` and
`fetches +0`. Adversarial verification found **`fetches +0` falsified** (two real shell
fetches exist), **`writes +15` not reproducible** with 4 of the 15 being `>&2` stderr
redirections rather than writes, and **5 of the claimed 19 spawns are `jq` string
payloads**, not spawns. The shell hole is real and correctly named; the rule that
quantified it is defective in **both** directions, too narrow to see wrapped commands and
`find -exec` subtrees, and too loose to exclude `jq` payloads and `>&2`.

**Ingress has the same hole, and it is larger.** Five machine-readable ingress surfaces sit
in and beside `scripts/` with **no row at all** in the ingress register, and they are **four
registries plus the `package.json` script surface**:

| surface | commands | lifecycle events |
|---|---|---|
| `package.json` `scripts` (`bun run`) | 188 | — |
| `.claude/settings.json` (the only tracked agent-hook registry) | 13 | 5 |
| `.hook-liveness/hook-manifest.json` | 10 | 4 |
| `.codex/hooks.json` | 3 | 2 |
| `install-git-hooks.mjs:60-66` `MANAGED_HOOKS` | 3 | 3 |

The union of the agent and git surfaces is **16 commands over 8 events**; adding
`.codex/hooks.json` gives **19 commands over the same 8 events**. This corrects an earlier
figure of "16 commands over 7 events", which no measurement of any single registry yields:
it is `13 + 3`, two registries with two different trigger mechanisms and lifecycles summed
into one number, and it double-counted a row that already enumerates the 3 git hooks. A row
whose number is the sum of two rows is not a row. Separately, the liveness manifest is
itself incomplete — it omits 3 of the 13 hooks `.claude/settings.json` actually wires, so
a liveness gate reading only that file cannot see a third of what it attests.

The canonical root set recognises none of them: the scan finds 0 CLI verbs, 0 MCP tools,
0 HTTP routes, 0 TUI screens, and 0 config entries. A register whose own headline finding
is that surfaces drift silently when undeclared was itself blind to the largest ingress
surface in the repository. Source: `evidence/todo-30-oracle3.md` §5.1, and the corrected
register rows `CD-I-11` and `CD-I-13`…`CD-I-15` in `findings-register.md`.

**Egress is not the same hole.** The `scripts/` blind spot is the *call graph* only.
Path-level and text-level egress and ingress enumerations do not read the symbol graph and
are unaffected by it. A reader who finds `scripts/` absent from the graph has not lost
egress coverage; they have lost the ability to ask which `packages/` function a given script
calls.

---

## 6. Pre-existing red gates

These were red before this analysis. None was caused by it, and none was repaired, because
remediation is out of scope for a diagram.

### 6.1 `gate:tui-catalog-parity` reads 0 catalog entries

```
$ bun scripts/tui-catalog-parity.mjs
TUI catalog parity gate — 0 supported catalog entries, 163 dispositions
BLOCKER: runtime catalog parser found no entries
BLOCKER: campaign.start is dispositioned but is not a supported runtime catalog kind
... (163 such BLOCKERs)
```

The cause is a re-export the parser cannot follow. `runtime-catalog.ts:226` re-exports the
manifest by identifier, and the manifest's initializer is
`[...] as const satisfies readonly RuntimeCatalogEntry[]`; the gate's `parseRuntimeCatalog`
unwraps `as` but not `satisfies`, so it returns 0 entries. This was introduced by
`bcb0f831`, the same commit that added the 32 `repo.flight.*` kinds.

### 6.2 `gate:hollow-parity` item 3 is a vacuous PASS

```
item 3 surface-scoped reachability: PASS (0 MCP-generic-only of 0 kinds; 0 allowlisted, 0 unlisted)
```

**That is a vacuous pass over 195 kinds.** The denominator is 0 because the gate shares the
broken parser from 6.1. Item 3 filters `supported: true` (`surfaces.mjs:47`), so even a
fixed parser would still not see the 32 unsupported kinds. The repository's only
hollow-shaped gate cannot detect a hollow kind today, and reports PASS while failing to.

The gate is red for three other reasons, all pre-existing: item 1 boundary-constant parity
FAILS, the catalog-surfaces projection is stale, and item 5 branch evidence is unavailable
because `coverage/coverage-final.json` has not been generated.

### 6.3 `gate:vi-reproducible` fails

The local graph is 5 commits stale: built at `12f3c56b`, HEAD is `82ce26a1`. Not repaired,
because `vi:refresh` is prohibited in this work. Non-perturbation was confirmed: 21 of 21
files byte-identical after `--check`.

### 6.4 `MANIFEST-COUNT-DESYNC`

Three sources disagree about one graph. `manifest.json` `counts` says 36,132 nodes and
110,106 edges. The graph files say 35,816 and 133,087. A fresh rebuild at HEAD yields
36,132 and 103,810. `gate:vi-freshness` reads **only** `manifest.json` and never the graph
bytes, so it is asserting against a number that does not describe any graph on disk. Its
passing is not evidence that the graph matches its manifest. **The graph and the manifest
must not be used interchangeably.** Every count in this document is from the files.

**The edge surplus is 22,981, and it is checkable, not asserted.**

    133,087 (disk, edges.jsonl) − 110,106 (manifest.json counts.edges) = 22,981

Name each source before doing the arithmetic: the two operands come from *different*
generations, which is the whole defect. 133,087 and 35,816 are the on-disk line counts;
110,106, 36,132 and 48,117 are `manifest.json`'s `counts`; 103,810 is a fresh rebuild at
HEAD. The node surplus is 36,132 − 35,816 = 316. A third number, `cited_total` = 110,472
in `.omo/circuit-dag/cited-vs-derived.json`, is **not** an operand here.

**Why 22,981 and no other value is possible.** `writeJsonl`
(`scripts/lib/graph.mjs:235-241`) sorts, writes exactly one line per record, and returns
`sorted.length` — the number it just wrote. `vi-extract-ts.mjs:918-920` feeds that return
value into `counts` at `:1031`. So for any *single* run, `counts.edges` **must** equal the
line count of the `edges.jsonl` that same run wrote, and a 22,981 gap is arithmetically
impossible within one generation. Its existence therefore proves the two figures describe
different generations, rather than a counting-convention difference.

This is the correction of `CD-CD-05`. `.omo/circuit-dag/cited-vs-derived.json:62,64` states
"**12,981** edges of surplus" in both its `discrepancy` and its `consequence` string, while
the same JSON object records `manifest_counts.edges = 110106` and
`file_counts_measured.edges = 133087`. **12,981 is a transcription error, wrong by 10,000** —
not a different measurement. It is left in place deliberately: that file is the completed
prior plan's evidence, is untracked (`.omo/` is gitignored), and a reviewer needs the
original misstatement to see the correction. Every tracked site that mentions 12,981 —
`.visual-intelligence/findings/circuit-dag-register.md:254,362,365` — already quotes it as
the *error*, so the wrong figure is never asserted as a fact anywhere in tracked content.

### 6.5 SUR-05 is RED

`bun run gate:docs-truth` reports drift at
`docs/comparative-analysis/opencode-tui-interaction-anatomy-and-canopy-design-direction.md:1613`,
which claims "43 ADR" against a derived count of 163. Live scan surface is 1,004 documents. <!-- sur-05:historical — quotes another document's stale claim and the count at 82ce26a1 -->
SUR-05's recognised phrasings are a narrow, self-declared set (`<N> ADRs`, `~<N> kinds`,
`<N> tests / <M> files`); package counts, screen counts, symbol counts, and edge counts are
invisible to it and are therefore unowned drift by construction even inside `docs/`.

### 6.6 Two drift rows in `AGENTS.md` itself, and what they mean

- `AGENTS.md:95` states "~26,000 symbols + ~81,000 edges". Measured against the anchored
  files: 35,816 nodes and 133,087 edges. **High severity**, a live operator-facing number
  that is wrong by roughly a third.
- `AGENTS.md:93` states "163 capability kinds at `2348ddbb`". **This is historically
  accurate and stale by exactly 32, and the mechanism is worth stating rather than just
  the verdict.** At `2348ddbb` the catalog was genuinely 163 total, 163 supported, 0
  unsupported. `bcb0f831` added 32 `repo.flight.*` kinds, so today it is 195 total, 163
  supported, 32 unsupported. **The supported count is still exactly 163**, and that
  coincidence with the total at the time of anchoring is precisely what makes a stale
  figure read as a live one. The defect is a labelling failure (a pinned historical
  measurement presented in a live table with no "as of" qualifier), not a number failure.

`gate:governance-counts` and `governance:render --check` are **GREEN**, captured verbatim
below, and the register above does not contradict them.

---

## 7. Delivered artifacts

| artifact | state |
|---|---|
| `artifacts/circuit-dag/revoy2-circuit-dag.architecture.html` | validated `ok: true`, 9 of 9 checks ok, composition errors 0, zero layout diagnostics |
| `artifacts/circuit-dag/subgraph/arbor-mcp-calls.html` | 120 components, 49 connections |
| `artifacts/circuit-dag/subgraph/arbor-tui-calls.html` | 100 components, 61 connections |
| `artifacts/circuit-dag/subgraph/arbor-mcp-cited-vs-derived.html` | 65 components, 67 connections |
| the three `*.companion.html` sidecars | 1,904 citation anchors, 1,904 resolve, 0 broken |

Those four rows are true only because two defects in these very artifacts were found by the
manual QA pass and then **fixed**. Both were open when the first version of this table was
written, and a table that reports only the post-fix state would be a clean bill of health
the reader could not have earned. Stated plainly:

- **D1 — the map clipped its own top row of node titles.** `svg.getBBox().y` was **-28**
  against a `viewBox` origin of 0 inside `overflow:hidden`, slicing four of the ten curated
  titles through the glyphs, viewport-independently at all four tested viewports. Root
  cause: `.omo/circuit-dag/projector.mjs` derived the `viewBox` extent from a fixed origin
  instead of from the laid-out bbox, and the schema cannot express an origin shift — so the
  drawing is translated instead. Minimum node origin is now **+90**, measured
  `getBBox().y` is **+21.378**, the bbox is contained in the `viewBox` at 1440x900, 1600x1000,
  1920x1080 and 2048x1320, and **0 of 20 node titles are clipped** in any of them. A second
  cause rode along: `viewer.css` had no wrap rule on the prose cards, so one unbreakable path
  token pushed the document 35px past its viewport; card `clientW == scrollW` at all four
  viewports now. `layout_diagnostics` stayed **0**, so the delivery was never traded away for
  the fix. Evidence: `evidence/todo-32-geom/todo-32-report.md`, with the four viewport
  screenshots and the raw `browser-qa.json` beside it.
- **D2 — every sidecar citation link was broken by one path segment.** All **1,904** of 1,904
  anchors resolved to `<worktree>/.omo/packages/...` instead of `<worktree>/packages/...`,
which made the sidecar's entire stated purpose — the only click-through to a cited
  `path:line`, the primaries carrying citations as text and 0 `<a>` elements — non-functional
  as shipped. Root cause: `subgraph-viewer.mjs` computed its relative href from the viewer's
  default output depth rather than from the repository root, so any `--out` three levels
  shallower broke the round trip. A pre-fix and post-fix render into the same directory differ
  in **828 lines, all of them hrefs and nothing else**, and a real browser click now delivers
  the cited file byte-identical at the cited non-empty line. Evidence: `evidence/todo-33.md`.

**The map now passes.** The figures in the table are the post-fix state, and each is
traceable to a re-run `validate` with `"ok": true` and `"errors": 0`, not to the original
delivery. The fix touched three files: the projector, the sidecar generator, and
`.agents/skills/revoy-map/assets/viewer.css` (the prose-card wrap rule disclosed in D1 above,
committed in this plan's `eb8a9b76`). No file under `packages/**`, `scripts/**` or
`.visual-intelligence/**` was written to produce it.

**This says nothing about the topology itself.** A map that renders correctly and an analysis
whose completeness claims survive falsification are different questions, and the answer to
the second is currently no. See section 10.

Each subgraph renders the cited/derived contract as an explicit card, so a reader of the
HTML cannot mistake a derived edge for a cited one.

The spine projection uses a `layered-col` layout chosen from a sweep of 100 or more
layout predicates; the chosen route emitted 0 diagnostics. The 10-node, 15-edge spine
projection is 100 percent cited (`calls` 1, `tests` 14) because the filter excludes derived
edges by construction. That is a **selection effect of the projection predicate, not a
measurement of the spine's evidence quality**: the real spine in `packages/` contains
21,335 BFS-derived edges that this view deliberately omits.

---

## 8. Number sourcing audit

Every numeric claim in this document, with its source. There are 84 distinct quantities.

**Measured from the anchored snapshot** (`nodes.snapshot.jsonl` sha256 `ad407479...`,
`edges.snapshot.jsonl` sha256 `3f14017...`), never the live files:

| # | quantity | value | source artifact |
|---|---|---|---|
| 1-2 | node / edge totals | 35,816 / 133,087 | `relations.json.integrity`, `cited-vs-derived.json.totals` |
| 3 | unparseable edge lines | 0 | `relations.json.totals` |
| 4-5 | cited / derived totals | 110,472 / 22,615 | `relations.json.totals` |
| 6 | cited percentage | 83 | `cited-vs-derived.json.totals.cited_pct` |
| 7-16 | the 10 per-relation edge counts | see 3.1 | `relations.json`, reproduced in `cited-vs-derived.json.by_relation` |
| 17-18 | `contains` cited / derived split | 34,519 / 1,280 | `cited-vs-derived.json.by_relation.contains` |
| 19 | `reachable_from` derived | 21,335 | `cited-vs-derived.json.by_relation.reachable_from.derived` |
| 20 | `reachable_from` cited | 0 | same |
| 21 | `reachable_from` edges carrying a `path:line` | 0 | `structural_restatement.reachable_from_edges_carrying_path_line` |
| 22 | distinct `evidence_location` on derived BFS edges | 1 | `cited-vs-derived.json.quarantine.distinct_evidence_locations` |
| 23-25 | `contains` derived edges / distinct file nodes / distinct cited files | 1,280 each | `relations.json.evidence_location.derived_contains` |
| 24 | symmetric difference of those two file sets | empty both ways | same, `set_equality_proven: true` |
| 26 | structural approximation sound / incomplete | 22,615 sound, 34,519 incomplete | `cited-vs-derived.json.structural_restatement` |
| 26a | relation vs evidence-shape disagreements (collinearity) | **0 of 133,087** | re-measured for §3.2a; `evidence/todo-20-cited-derived.txt` |
| 26b | derived edges NOT matching the approximation | 0 | same |
| 27-29 | `confidence` buckets on cited edges | 55,869 / 38,537 / 16,066 | `cited-vs-derived.json.confidence.on_cited` |
| 30-31 | `confidence` buckets on derived edges | 21,335 high / 1,280 authoritative | `cited-vs-derived.json.confidence.on_derived` |
| 32 | `evidence_type: ast_call` on cited edges | 34,171 | `cited-vs-derived.json.evidence_type.on_cited` |
| 33 | `tests` edges carrying `confidence: medium` | 16,066 | `cited-vs-derived.json.confidence.why` |
| 34-35 | `calls` resolving / past-EOF | 18,105 / 0 | `relations.json.calls_resolution` |
| 36 | distinct files cited by `calls` | 1,205 | same |
| 37 | cited files containing a NUL byte | 7 | same |
| 38-39 | test nodes / percent of nodes | 13,095 / 36.57 | `test-node-decision.md` §Verification |
| 40-41 | nodes lacking the flag, and their composition | 22,721; 16 pkg + 1 entrypoint | same |
| 42 | path-vs-flag agreement | 13,095 agree, 0 either way | same |
| 43-44 | test-touching edges / percent | 52,384 / 39.36 | same |
| 45-46 | excluded-alternative node / edge totals | 22,721 / 80,703 | same, QA-failure table |
| 47-48 | test-touching edges in `exports` / `reachable_from` | 0 / 0 | same, per-relation table |
| 49 | declared guards | 69 | `dispatch-relations.json.guards` |
| 50 | `catalogEntry` call sites, literal / dynamic | 71; 40 / 31 | `dispatch-relations.json.catalogEntry_call_sites` |
| 51-52 | command / query ladder branch counts | 29 / 40 | `dispatch-relations.json.dispatch_shape` |
| 53 | `case`-label kinds captured vs total | 33 of 195 | same, `dispatch_shape.finding` |
| 54 | kinds in the `case` switch at `:1746` | 14 | same, `kind_switches[0]` |
| 55 | egress counting-domain files | 1,611; 1,279 + 332 | `egress-relations.json.counting_domain` |
| 56-59 | egress class totals, product split | 3,603/886, 992/248, 67/30, 547/123 | same, `classes` |
| 60 | irreversible git mutations | 63 | same, `destructive_git_coverage` |
| 61-64 | verifier-B misses: fetches / writes / spawns / irreversible git | 17 / 10 / 2 / 2 | `evidence/todo-13-verifierB.md` §Verdict table |
| 65 | shell `scripts/` sink corrections: writes / spawns / fetches | at least +22 / at least +19 / +0 falsified | `evidence/todo-12-verifierA.md` §4c |
| 66 | uncounted ingress registries (3 agent-hook files + `MANAGED_HOOKS`) | 4 | `evidence/todo-30-oracle3.md` §5.1 |
| 67-68 | uncounted `bun run` targets / agent+git hook commands over events / git hooks | 188 / **16 over 8** (19 with `.codex/hooks.json`) / 3 | same; `findings-register.md` `CD-I-11`, `CD-I-13`…`CD-I-15` |
| 69-70 | confirmed / candidate / struck hollow rows | 4 / 7 / 4 | `findings-hollow.md` header |
| 71 | graph hollow findings and flagged symbols | 51 findings, 163 symbols | same, H-04 |
| 72 | drift register rows, and the SUR-05 red location | 10 rows; `opencode-tui-interaction-anatomy-and-canopy-design-direction.md:1613` | `findings-drift.md` §1 |
| 73 | SUR-05 live scan surface | 1,004 documents | same, §0 |
| 74 | Route C working measurement: nodes / edges / roots / entry points / `scripts/` nodes / cross-boundary edges. **Route C is DEFERRED (not adopted), and it is a `derived`-plane measurement: it does not make the `observed` plane available** — see §1.1 | 46,853 / 156,849 / 75 / 39 of 39 / 11,038 / 248 | `blind-spots.md` BS-001 |
| 75 | adversarial oracles run against this analysis, and their verdicts | 3, **all blocking** | `evidence/todo-28-oracle1.md`, `todo-29-oracle2.md`, `todo-30-oracle3.md` §0.1 |
| 76 | oracle 1 strict `calls` call-set defects, threshold 5 | 621 | `evidence/todo-28-oracle1.md` §7 |
| 77 | oracle 1 `scripts/` call sites, represented / rescued by `imports` | 24,984 / 0 / 0 | same, §5 |
| 78 | oracle 2 direction 1 (false `cited`), threshold 5 | **0 — a negative, not a pass**; lane `UNPROVEN` | `evidence/todo-29-oracle2.md` §7 |
| 79 | oracle 2 direction 2 (false `derived`) counterexamples | 1,280 | same |
| 80 | `CIRCUIT-DAG-1` collinearity with the shape predicate | 100.0000% | same, F1 |
| 81 | oracle 3 claims verified / blocking | 5 / 5 | `evidence/todo-30-oracle3.md` §0.1 |
| 82 | oracle 3 new sink misses `E-N1`…`E-N6` | 6 | `findings-egress.md` §9z |
| 83 | sidecar citation anchors, before → after | 1,904 broken → 0 broken | `evidence/todo-33.md` §5 |
| 84 | map `getBBox().y` before → after, titles clipped, viewports cleared | -28 → +21.378; 4 → 0; 4 of 4 | `evidence/todo-32-geom/todo-32-report.md` §2, §5 |

**Repeated from prior artifacts and re-confirmed here**, each with its own pinned rule:
catalog 195 / 163 / 32, 104 command, 91 query, 195 distinct, 0 carrying
`unavailable_reason` (rule `^\s*\{ kind: ` on `runtime-catalog-manifest.ts`);
subgraph views at 120, 100, and 65 components; the spine projection at 10 nodes and 15
edges.

**Not used anywhere in this document:** the `AGENTS.md:95` "~26,000 symbols + ~81,000
edges" figure and the `AGENTS.md:93` "163 capability kinds" figure. Both are recorded in
section 6.6 as drift rows with their own measured replacements, and neither is quoted
unlabelled.

**No number in this document was re-derived for this document.** Every value is a restatement
of a measurement another artifact already made under a pinned rule, and each row above names
that artifact. Where two artifacts independently produced the same figure (the ten relation
counts in `relations.json` and `cited-vs-derived.json`; the catalog triple in
`dispatch-relations.json` and `measured-baseline.md`), agreement is stated rather than
coincidence-implied.

---

## 9. Verbatim gate capture

```
$ bun run governance:render --check
$ bun scripts/render-governance-counts.mjs --check
governance counts already match derivation
EXIT=0
```

GREEN. This document agrees with the gate: it asserts no `adr_total` claim in any of the
three owned documents (`AGENTS.md`, `docs/release-readiness.md`,
`.claude/skills/revoy2-implementation-audit/SKILL.md`), and it introduces no number that
`gate:governance-counts` or `gate:docs-truth` owns.

---

## 10. Adversarial verification: three oracles, three blocking verdicts

Everything above is a measurement. This section is the record of what happened when three
oracles were pointed at those measurements and told to prove them wrong. **All three
returned blocking verdicts.** Under the plan's verification strategy, a confirmed defect
count at or above a threshold of 5 blocks delivery, and a lane that cannot reach a verdict
also blocks it. Nothing was remediated; this document records.

| oracle | attacked | verdict | headline | effect |
|---|---|---|---|---|
| 1 | `calls` is a complete census of call sites | `VERIFIED` | **621** strict call-set defects (threshold 5), plus **24,984** `scripts/` call sites at 0 represented | **BLOCKS** |
| 2 | the cited/derived boundary `CIRCUIT-DAG-1` | `UNPROVEN` | direction 1 returns **0** — a negative, not a pass; direction 2 returns **1,280** counterexamples | **BLOCKS** |
| 3 | ingress and egress completeness | `VERIFIED` | **5 of 5** claims verified, **0** unproven; 6 new sink misses, 3 uncovered ingress surfaces, 1 falsified telemetry negative, 3 register rows wrong | **BLOCKS** |

**What each one found, and where this document already carries it.**

*Oracle 1* (`evidence/todo-28-oracle1.md`) rebuilt the call set from source with an
independent TypeScript-compiler-API extraction rather than re-running the graph's own tool,
keyed on `(file, line)`. 621 in-scope call sites have both endpoints present in the graph
and no `calls` edge, against a threshold of 5. It confirmed the `scripts/` blind spot of 1.3
as larger than estimated, and found two overstatements in the graph's own manifest:
`"extraction_gaps": []` is false, and `"module_resolution": {"unresolved": 0}` reads as a
clean bill of health when resolution health is being read as extraction completeness. It
also showed the relation is a **pair** graph by construction — one edge per (caller, callee)
pair, anchored at the first occurrence — so "census" was never the right word. Carried in
**3.5**. One methodological note is worth keeping: that oracle's first pass produced a false
pass through its own bug, and only removing it produced the real result.

*Oracle 2* (`evidence/todo-29-oracle2.md`) attacked the classifier itself and found the rule
has **zero discriminating power** — 100.0000% collinear with a shape predicate that never
inspects `evidence_location` — while 1,280 `derived` edges are in fact file-level citations
to files that exist, carrying the schema's strongest confidence value. It then demonstrated,
rather than asserted, the live-consumer hazard of 3.3. It also falsified the *plan's own*
premise: a claimed floor of 7 past-EOF citations was false at this revision. That was a
finding about the plan, not about this document, and the `0` in 3.5 is the correct figure.
Carried in **3.2** and **3.3**. A fifth finding is not carried and is recorded here because it
bears on how this document was written: **590** cited edges are invisible to `grep -n` and
**156** of them unreachable even with `grep -a`, so any grep-based negative over this corpus
is unsound.

*Oracle 3* (`evidence/todo-30-oracle3.md`) attacked the two relations this document claims
are first-class and complete. It found a sink class no pinned verb regex can match — six
sites, including a computed SQLite constructor, the product sandbox's entire write primitive
behind a one-letter alias, and `chmodSync` on the OAuth credential store — overturned a
stated negative in an earlier verifier, and retracted the "zero outbound telemetry" result
after one line in `scripts/observe-devtools.sh` (`:164` at base `82ce26a1`; now `:219`, behind
the consent gate at `:107` per ADR-173). It also showed the ingress figure in
5 was a conflation of two registries. Carried in **5** and in the corrected register rows
`CD-S-08`, `CD-I-11`, `CD-I-13`…`CD-I-15`, `CD-E-31`…`CD-E-34`.

**The honest summary.** The measurements in this document are measurements of the graph, and
where they were independently re-derived they reproduced exactly — 18,105 `calls` edges
resolve, 0 past-EOF, over 1,205 files, and the cited/derived partition is exact. What the
three oracles attacked is everything one level above that: whether the relations are
*complete*, whether the classifier that labels them is *fit for purpose*, and whether the
egress and ingress enumerations are *exhaustive*. On all three, the answer is currently no.
This document is a map of a corpus that has been measured but not yet shown complete, and
the difference is the whole content of this section.
