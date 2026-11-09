# Arboretum: a global coordination plane for revoy2 and Canopy

**Status:** Proposal, not an ADR. Nothing here is authorized by being written down. Written
2026-09-29 from HEAD `58b069ad`, for a skeptical reader and for the operator who will decide
which parts become records.

**Amendment 1 (operator, 2026-09-29): native harness first.** Claude Code and Codex hooks are
deprecated from everyday use. They are archived as reference material and are **not in force**
for this design. Every mechanism below targets the native revoy2 harness only. Where the
original text proposed driving external hosts from the same catalog, that is now out of scope
and marked as such (§5.5, §8, §9). This matches the operator framing already recorded in
`.omo/plans/disable-claude-codex-hooks.md`: those hooks are vestigial, left over from the plugin
direction, and become second-class connectors, while the hook logic moves into the native harness
at source level.

**Inputs, and how each was used.**

| input | what was taken from it |
|---|---|
| `~/src/revelri/private/oh-my-openagent-fork` @ `80d1691` (`docs/architecture.md`, `docs/roles.md`, `docs/dag/**`, `docs/port-v2/ARBOR-INTEL.md`, `docs/revy-review/r1,r2`) | OMO's plan/boulder/hook/role machinery, sorted into what is enforced in code vs prompt-only; the `dag_graph` scheduler and its independent critique; the arbor code review's verified gate defects |
| this repository at `58b069ad` | the existing seams each proposal attaches to (hook bus, ADR registry, execution profile, session close, user scope, `@arbor/audit` hash chain) |
| the 2026-09-29 session (state assessment, remediation plan `.omo/plans/revoy2-remediation-20260929.md`) | the observed failure modes the design must remove, cited as **[S]** below |

**Evidence classes used below.** *Observed* = read in source or seen run this session, cited.
*Reported* = taken from a fork document, cited to it. *Proposed* = this document's design; no
code exists for it.

---

## 0. The argument in one page

Three systems have each solved one third of the problem and each has a signature failure.

- **OMO** has the best *operating loop*: a plan file whose checkboxes are the progress counter,
  a boulder pointer that survives the session, hooks that inject reminders into the model's
  context, a continuation enforcer, a final verification wave, and a clean role roster with a
  read-only wall. Its failure: roughly half of it is **prompt-only**. The reviewer-resubmit cap
  appears in four prompt variants and nothing counts it; the atlas write policy only appends
  reminder text; `task.dag` is a validated config block read by nothing
  (`fork: docs/architecture.md §6.3, §6.4`). A non-compliant run completes silently.
- **`dag_graph`** (the fork's scheduler experiment) has the best *planning theory*: a plan is a
  labelled resource-access graph, hazards are `{W,W}` and `{W,R}`, a `path:line` citation is a
  **value that rots**, eligibility is not admission, an unknown write-set is unsafe, and cycles
  are plan defects. Its failure: the machine channel could not see the hazards the prose
  reported, and it inferred write-sets from prose at recall 0.27
  (`fork: docs/dag/README.md`, `ADJUDICATION.md` S1–S7).
- **revoy2** has the best *governance substrate*: provenance as a type, hash-chained ledgers,
  content-addressed execution manifests, typed refusals, witnessed operator decisions. Its
  failure: enforcement is total over **declarations**, not over **gate bodies or inputs** — a
  required CI gate that exits 0 on every path (R2-01), a claim ledger that fails open when its
  subprocess fails (R2-02), gates fed caller-asserted verdicts (R1 #1–3), and a per-turn gate
  battery that was red for reasons unrelated to the turn on every turn of this session **[S]**.

**The proposal:** one global, repo-agnostic plane — **Arboretum**, at
`~/.config/arbor/arboretum/` (the ADR-110 user scope; `~/.arbor` already symlinks there) —
holding five things, each taking the best of the three and removing each one's failure:

| component | botanical role | replaces / absorbs | the fix it carries |
|---|---|---|---|
| **Rings** | growth rings: one per event, never rewritten | `decisions/registry.json`, `.governance-index.json`, `interviews.jsonl`, `discharge-obligations.jsonl`, waiver stores, `.omo/boulder.json` | one immutable, hash-chained index; every current store becomes a derived view |
| **Trellis** | the frame a plant is trained along | `.omo/plans/*.md`, hand-written wave matrices | a typed, multi-axis resource-and-authority graph; markdown is a rendering, not the truth |
| **Tendrils** | what climbs the trellis | `boulder.json` works/task_sessions | live execution state as a fold over Rings, never a mutable file |
| **Tropisms** | growth responses to stimuli | OMO system reminders, continuation enforcer, `gate-stop.sh` dump | typed, state-derived context injection with a declared enforcement lane |
| **Guard cells** | the cells that open and close a stoma | the stop battery, `execution-profile.json` roster audit | gates whose bodies are tested to fail, scheduled by changed inputs, with debt owned in Rings |

And one cross-cutting rule, taken from OMO's own best line — *"progress is computed from the
plan markdown, not from the model's report"* (`fork: architecture.md §6.1`) — and hardened:
**nothing is complete because an agent says so; completion is a predicate the plane evaluates,
or a witnessed operator record.**

---

## 1. What is worth taking, sorted by lane

The fork's most useful contribution is its sorting discipline: every mechanism is CODE (fires
whether or not the model complies), PROMPT-ONLY (text; nothing checks it), or HYBRID (code
exists, the implied behaviour does not happen). This proposal adopts that vocabulary as a
**required field** on every mechanism it defines (§5.3).

### 1.1 From OMO — take (they are CODE)

| mechanism | fork citation | why it is good | where it lands |
|---|---|---|---|
| progress parsed from plan checkboxes | `architecture.md §6.1` (`96062`) | the model cannot move the counter by claiming | Trellis node predicates (§3.5) |
| boulder pointer surviving sessions; `reconcileStaleWorks` demotes stale works to `paused` | §6.1 (`96573`, `114288`) | work outlives a context window; stale work self-heals | Tendrils (§4) |
| notepad scaffold created in code (`ensureNotepadScaffold`, `wx`) | §6.1 (`113618`) | a promise in the prompt that code keeps | Tendril workspace (§4.3) |
| final-wave gate: one `VERDICT: APPROVE` per F-task, contradictory reviewer = `missing` | §6.4 (`115970-116012`) | verdict parsing that refuses ambiguity | Trellis `verify` nodes (§3.3) |
| continuation countdown with stagnation/failure caps and a kill switch | §6.1 (`todo-continuation-enforcer`) | bounded persistence instead of hope | Tropism `continue` (§5.4) |
| every hook individually switchable | §6.1 (`isHookEnabled`) | a mechanism is a set of switches | Tropism catalog (§5.2) |
| read-only subagent wall; coordinator never delegated | `architecture.md §4` (`27776`) | authority separation by construction | role manifest (§6) |
| `prometheus-md-only`, the one real write blocker | §6.4 (`113179`) | proof the pattern can be enforced | role capability veto (§6.3) |

### 1.2 From OMO — take the idea, reject the implementation (HYBRID / PROMPT-ONLY)

| mechanism | defect | correction |
|---|---|---|
| reviewer resubmit cap "at most twice" | no counter symbol exists (`§6.3`) | the cap is a Tendril field the plane increments; the 3rd submit is refused (§4.2) |
| atlas write/edit policy | only appends reminder strings; nothing denied (`§6.4`) | tool-preflight **veto** against the node's declared write-set (§3.4) |
| `task.dag` config | validated, read by nothing (`§6.4`) | no config key without a consumer — Guard cell `consumer-exists` (§7.2) |
| final-wave user approval | "wait for the user" is prose; a model can tick the F-boxes | F-nodes complete only on a Rings `operator.approve` record from the recorder (ADR-158) |
| categories → one agent + model + context block | routing labels with no capability binding | **Grains** carry model + context **and** a capability ceiling (§6.2) |
| `mktemp` notepad, `ledger.jsonl` with no writer | protocol with no code (`§6.3`) | only Tendril-created artifacts exist; the prompt may not mention an artifact the plane does not create (§5.3 lint) |
| `boulder.json` duplicating active-work fields at top level and inside `works` | observed this session: both copies of `active_plan`/`status` are maintained by hand **[S]** | one fold, no mirrors (§4.1) |

### 1.3 From `dag_graph` — take (the planning theory)

`fork: docs/dag/synthesis/DESIGN.md §1–§6`, `observed-failures.md`.

1. **The primitive is a labelled resource-access graph, not a DAG.** `HAZARD = {{W,W},{W,R}}`;
   `{R,R}` is not a hazard; a precedence edge is a *linearisation* of a hazard, on one canonical
   order, never both directions (a 2-cycle collapses the plan).
2. **A citation is a value, not an observation.** `L:path:line` is written into a document; a
   later edit to the file silently falsifies it. This session reproduced it exactly: commit
   `8c2bcbed` moved lines in `docs/architecture-circuit-diagram.md` and silently broke the SUR-05
   drift test, which pinned `:107`/`:630` **[S]**.
3. **Phases:** `dispatch` edges shape order; `verify` edges allow parallel edit then joint test;
   `advisory` edges are named, never ordered on.
4. **Eligibility ≠ admission.** "Safe to run together" and "should launch now" are different
   questions; conflating them produced loadavg 9.53 and a 0.9 s → 50 s test run.
5. **Unknown is unsafe.** A node whose write-set is not known produces no edge, and a missing
   edge looks like compatibility. Report it as `unsafe`, exit non-zero.
6. **Cycles are plan defects**: collapse the SCC, report it, refuse to pretend it was scheduled.
7. **Never hand-maintain a value a machine can compute** (the "19 gap rows" were 73).
8. **The JSON channel is the product.** A finding that exists only in prose is invisible to the
   consumer (`ADJUDICATION.md` S1).

### 1.4 From `dag_graph` — do not take

- **Inferring write-sets from prose.** Measured recall 0.27–0.23, and the diagnosis of why was
  wrong (S6, S7). Trellis write-sets are **declared** and then **enforced** by the preflight veto,
  and **reconciled** against the actual diff at node close. Inference survives only as a lint
  that flags a declared set that looks too small.
- **Correlated axes presented as independent** (S13). Trellis axes are typed by *what they read*,
  and the plan reports which axes share an input.

### 1.5 From revoy2 — keep, and extend globally

Provenance tags as types; `@arbor/audit`'s hash-chained ledger and tamper detection; the
execution control plane's content-addressed candidate snapshot and `cached` gate status
(`fork: revy-review/r2/R2-enforcement.md`, "The real enforcement topology"); typed refusals;
ADR-059/072 separation of authoring, allocation and acceptance; ADR-158 recorder-only interviews;
ADR-110 declared config scopes; ADR-160 commit-at-close; the hook bus's intersection-only veto
(`packages/arbor-mcp/src/hooks/bus.ts:5-13`: *"a hook can flip an allow to a deny, never the
reverse"*).

### 1.6 From revoy2 — the defects the design must make impossible

| defect | source | design response |
|---|---|---|
| a required blocking gate whose every path exits 0 | R2-01 `adr-status-audit.mjs:152,191,200,215` | Guard cells must fail their own canary (§7.1) |
| a gate that fails open when its subprocess fails | R2-02 `claim-ledger.ts:536-543` | tri-state result; `unresolved` is not `pass` (§7.1) |
| a gate registered on a trigger where it can evaluate nothing | R2-03 `adr-trace.mjs:433-445` | Guard cells declare `observed_count`; zero on a non-empty input is `unresolved` |
| registry lock with no reclamation | R2-04 `lib/adr-registry.mjs:162-172` | Rings are append-only; allocation needs no lock (§2.3) |
| a `CLOSED` marker discharging its own claim | R2-05 | a claim's discharge must reference a Rings event that is not the claim |
| gates fed caller-asserted verdicts (`isolation` as tool input, `plan_reviewed: true`, `lease_acquired: true` literal type) | R1 #1–3 `tools.ts:296-303`, `manager.ts:456-460,1559` | `Witnessed<T>` brand, constructible only by the witnessing module (§7.4) |
| a completion-depth gate that PASSes having scanned nothing; a missing graph making the observed plane empty with exit 0 | R2b F2, F3, F6 | same: canary + `observed_count` |
| the stop battery red on every turn for reasons not caused by the turn; the budget over 25 s | observed, 7 of 39 red, 30.5–31.5 s median **[S]** | input-scoped scheduling + owned baseline debt (§7.3) |
| an allowlist that expired on 2026-09-26 and blocked the evidence rebind three days later with no warning | `scripts/reachability/allowlist.json:83-100` **[S]** | time axis: expiry nodes are planned before they bite (§3.2) |
| worktree tooling that defaults to an ntfs3 mount where `bun install` cannot create workspace links | `scripts/session-worktree.mjs` **[S]** | environment axis + Guard cell on the tool's own post-condition |
| a stash drop that lost `cli.ts` changes while their tests stayed in the tree | dangling `c338b9b8` **[S]** | node close reconciles declared write-set against the diff; a declared path with no change is a finding |
| hook notes that reach only the hook ledger, never the model | `hooks/bus.ts:230-231,351-352` (notes recorded, no context path) | Tropisms add an `inject` kind (§5) |

---

## 2. Rings — the single immutable index

### 2.1 What it is

An append-only log of governance events for **every enrolled repository on this machine**, plus
global events, at `~/.config/arbor/arboretum/rings/`. Each event is canonical JSON with
`{seq, prev_hash, hash, at, scope, kind, subject, body, provenance, actor}`. `hash =
sha256(canonical(event_without_hash))`; `prev_hash` chains to the previous event. This is the
same construction `@arbor/audit` already uses for campaign ledgers (hash-chain integrity and
reorder detection are already tested there, per the claim-ledger run output this session), lifted
from per-campaign to per-machine.

Every store that today *owns* part of a decision becomes a **projection** of Rings, rebuildable
from it and disposable:

| today (per repo) | becomes |
|---|---|
| `decisions/registry.json` (allocation, placeholders, `next_available`) | fold over `adr.allocate` |
| `decisions/.governance-index.json` | fold over `adr.*` |
| `decisions/interviews.jsonl` (52 lines) | `operator.interview` events, recorder-signed |
| `decisions/discharge-obligations.jsonl` | `obligation.discharge` events referencing evidence events |
| waiver/allowlist stores (~120 dated waivers across five stores, per `revoy2-interview` SKILL.md:19) | `waiver.grant` / `waiver.expire` events with expiry as data |
| `.claim-ledger/claims.jsonl` | `claim.*` events |
| `.omo/boulder.json` | Tendril fold (§4) |
| `.git/arbor/sessions/*` | `session.open` / `session.close` events |

ADR **text** stays in the repository as markdown, because it is reviewed there. Rings records
its identity: `{repo_id, number, path, content_id, commit}`. The status of an ADR is never a line
in a file; it is the fold of its `adr.*` events. The `**Status:**` line in the markdown becomes a
rendered field that a Guard cell checks against the fold, rather than the source of truth that
three gates currently parse.

### 2.2 Scopes, mirroring ADR-110

`scope ∈ {machine, org:<id>, repo:<id>}`. A **machine- or org-scoped ADR** is a decision every
enrolled repository inherits (the role manifest, the tropism catalog, the plan schema), exactly
as a user-scope `arbor.jsonc` key is inherited by every clone today. A repo may *narrow* an
inherited decision only by its own ADR that cites and supersedes it for that scope — never by
editing a copy. This is what makes the plane repo-agnostic without making every repository
re-litigate the same governance.

### 2.3 Why this removes whole defect classes

- **No lock to wedge.** Allocation is `append(adr.allocate{number})` with a compare-and-append on
  the chain head (`O_APPEND` segment write + fsync, then verify `prev_hash`). A crash leaves at
  worst a torn final line, which the reader detects by hash and truncates to a `.torn` quarantine
  file — the pattern `@arbor/core/boulder.ts` already uses for abandoned temp files. R2-04 cannot
  occur.
- **No five-store disagreement.** One log, many folds. A fold that disagrees with a rendered file
  is a Guard-cell finding against the file, never against the log.
- **No history rewriting pressure.** A reword today breaks `gate:vi-freshness` ancestry and costs a
  6-minute rebind (governance SKILL §1.1). Evidence keyed to Rings events and content hashes,
  not commit ancestry, removes that failure mode (§7.5).
- **Cross-repo questions become answerable**: "which decisions are owed across everything I run",
  "which waivers expire this week", "which plans touch the harness package" are one query.

### 2.4 Immutability, stated precisely

Events are never edited or deleted. Correction is a new event that references the one it
corrects (`kind: "*.correct"`), which is ADR-011 → ADR-036/037's supersession-with-back-reference
rule applied to every record, not only ADRs. Checkpoints (every N events, a Merkle root over the
segment) make verification O(segment). The directory is itself a git repository (optionally
pushed to a private remote), which gives off-machine backup and a second, independent hash
witness without inventing a sync protocol.

### 2.5 Honest ceiling

A local log is tamper-*evident*, not tamper-*proof*: the operator (or anything running as them)
can rewrite the whole chain. The remote git mirror raises the cost; it does not remove it. This
is the same ceiling ADR-025 records for local pre-push enforcement, and should be stated in the
same words.

---

## 3. Trellis — the plan as a multi-axis resource-and-authority graph

### 3.1 Form

A Trellis plan is a **typed JSON document** (schema in Rings as a machine-scoped ADR), stored
content-addressed at `arboretum/trellis/<plan-id>/<version-hash>.json` and referenced from Rings
by `plan.admit`. Markdown (the `.omo/plans/*.md` shape the operator reads today) is a
**rendering** with a stable anchor per node. Editing a plan means admitting a new version; nodes
carry stable ids across versions, so Tendril progress survives a re-plan.

This reverses OMO, where the markdown is the truth and a parser reads checkboxes. The reason:
`dag_graph` showed that parsing structure out of prose is where the errors live (the field-label
veto, the `**bold**`-only regex that lost the "19 gap rows", S6/S8). A typed document cannot
contradict itself the way `Blocks:`/`Blocked by:` did (`observed-failures.md` #2).

### 3.2 The axes

`dag_graph` had six axes, all derived from file access. Trellis has twelve, grouped by **what
kind of constraint** they express, and each declares the input it reads so correlation is
visible (§1.4).

| # | axis | resource token | hazard semantics | phase | source of the edge | example from this session **[S]** |
|---|---|---|---|---|---|---|
| A1 | **files** | `F:path` | `{W,W}`, `{W,R}` | dispatch | declared write/read sets, enforced by veto | todos 6 and 11 both edit `docs/…` |
| A2 | **citations** | `L:path:line` | W on `F:path` × R on `L:path:n` | dispatch | citations parsed from node outputs and ADR bodies | SUR-05 test pinned `:107`/`:630`, moved by `8c2bcbed` |
| A3 | **symbols** | `S:module#name` | co-verification | verify | TS compiler API (not regex) | `composeLoopConfigPorts` signature change + 5 callers |
| A4 | **execution classes** | `C:git-index`, `C:evidence-lease`, `C:port:NNNN`, `C:model-budget` | exclusive | dispatch | declared on node kinds | two rebinds can never overlap |
| A5 | **authority** | `D:adr-NNN`, `D:waiver-id`, `D:operator:<question>` | a node that *consumes* a decision waits for the decision event | dispatch | declared; decision nodes are human | todos 8, 9, 17, 23 wait on the interview |
| A6 | **evidence** | `E:store` | every source-writing node W-invalidates `E:*`; a rebind node R-requires quiescence | dispatch (sink) | derived from node kind | "rebind exactly once, at the end" becomes a graph property, not advice |
| A7 | **time** | `T:<iso>` | a node becomes eligible (or mandatory) at a time | dispatch | waiver/allowlist expiries, cert/lease expiries from Rings | the ADR-094 allowlist expiry becomes a node scheduled 7 days earlier |
| A8 | **gates** | `G:gate-name` | a node declares which gates it may turn red; a gate-repair node W-writes `G:*` | verify | Guard-cell input globs (§7.3) intersected with the write-set | which gates must re-run after a node, computed, not guessed |
| A9 | **environment** | `X:fs:<mount>`, `X:tool:<bin>@<ver>` | node requires a capability of the host | admission | node declaration + host probe | worktree on ntfs3 fails `bun install` |
| A10 | **cost** | `$:model`, `$:cpu`, `$:wall` | admission budget, not ordering | admission | node estimate + Rings actuals | eligibility vs admission (§1.3 #4) |
| A11 | **ownership** | `O:session`, `O:worktree`, `O:sibling-wip` | a node may not write a path another live Tendril owns | dispatch | Tendril leases (§4.2) | "the checkout is shared; unexpected files are someone else's" (AGENTS.md) made mechanical |
| A12 | **proof** | `P:real-binary`, `P:unit`, `P:negative-control` | a node's claimed outcome requires evidence of a stated strength | verify | node acceptance schema | "drive the real binary, not just the tests" (AGENTS.md) made a completion requirement |

A1–A3 are `dag_graph`'s core. A4 is its `C:` class, generalized. **A5–A12 are new**, and they
are exactly the dimensions along which this session's remediation plan had to be hand-ordered:
decisions blocking repairs (A5), the single rebind sink (A6), the expiry that nobody scheduled
(A7), which gates a change can redden (A8), the broken worktree mount (A9), model spend needing
authorization (A10), sibling work in a shared checkout (A11), and unit-green-but-never-run (A12).

### 3.3 Node kinds

| kind | completes when | who may complete it |
|---|---|---|
| `work` | its acceptance predicate evaluates true **and** its write-set reconciles with the diff | an agent, via the plane |
| `decision` | a recorder-signed `operator.*` event answering its question exists | only the operator (ADR-158) |
| `verify` (OMO's F-wave) | one `VERDICT: APPROVE` per verifier from distinct role instances, **then** an `operator.approve` event | verifiers + operator |
| `sink` (rebind, store commit) | quiescence on `E:*` and the sink's own predicate | the plane schedules it last by construction |
| `observe` (real-binary run) | captured evidence meets the A12 strength; failure preserves evidence | agent, under an A10 authorization |
| `hygiene` (destructive) | an `operator.approve` event whose body **is the exact list** to be destroyed | operator-approved, agent-executed |
| `expiry` | the time arrives; spawns a `decision` node | the plane |

### 3.4 Write-sets: declared, enforced, reconciled

1. **Declared** on the node (glob allowed, must be narrow; a lint flags `**`).
2. **Enforced** at tool preflight through the existing veto surface
   (`hooks/bus.ts` `wrapToolPort`, intersection-only): a write outside the active node's set is
   denied with a typed refusal naming the node. This converts OMO's reminder-only atlas policy
   into a real control. Shell writes are the known hole (`dag_graph` §"Known limits"); they are
   closed by A1's third leg:
3. **Reconciled** at node close against the actual diff of the node's worktree
   (`captureWorktreeChanges`, which `native-agent-executor.ts:740` already calls). A changed path
   outside the declared set, or a declared path with no change when the node claims to have done
   the work, is a finding that blocks completion. The second case is the one that would have
   caught the lost `cli.ts` hunks this session **[S]**.

### 3.5 Acceptance predicates

Every `work`/`observe` node carries a machine-checkable predicate: a command, its expected exit
code, an assertion over its output, and an evidence path. The plane runs it, records the result
as a Rings event, and only then advances the Tendril. The plan's QA prose is rendered from the
predicate, not the other way round — so "QA happy" can no longer drift from what is checked.
Every repair of a check carries a **negative control** predicate (it must still fail on a
constructed defect), which is the dual-control rule from the graph-remediation plan made a schema
field.

### 3.6 Scheduler output

The scheduler emits one JSON channel (`dag_graph` S1's lesson) with: `eligible`, `admitted`,
`deferred_by(admission|authority|time|environment)`, `unsafe` with reasons, `cycles`, per-edge
`axes` and `witnesses`, and `--explain` per path (credited as the best feature in the fork's
critique). Exit codes as in the fork: `3` for unsafe. The admission cap is derived from the host
(`sched_getaffinity - 1`, clamped) and from A10 budgets.

---

## 4. Tendrils — live execution state as a fold

### 4.1 Replace the mutable pointer

`boulder.json` today is a mutable document with duplicated fields; `@arbor/core/boulder.ts`
writes one atomically but its shape (`active_plan`, `active_campaign`, `session_ids`) predates
multi-plan work. A **Tendril** is the fold of `tendril.*` events for one (plan, version) pair:
current node leases, attempts, verdict counts, timers, notepad path, worktree, base revision.
There is nothing to keep consistent because there is only one representation.

### 4.2 Leases and counters

- A node is worked under a **lease** (`tendril.lease{node, session, worktree, expires}`). A11
  ownership is the set of live leases. A dead session's lease expires and the node returns to
  `eligible` — OMO's `reconcileStaleWorks`, made per-node.
- **Counters are events**, so caps are real: `tendril.submit{node, attempt}`; the plane refuses
  attempt 3 when the node declares `max_submits: 2`. This is the reviewer cap OMO wrote four times
  in prose and never counted.
- Timers (`started_at`, `elapsed_ms`) come from event timestamps, not agent reports.

### 4.3 Notepads and workspaces

Created by the plane on lease (`wx`, EEXIST-tolerant, as `ensureNotepadScaffold` does), inside
the Tendril's worktree metadata, never in `/tmp`. The fork learned this the hard way: agent
reports written to volatile `/tmp` were lost until a sync tool copied them in
(`fork: AGENTS.md`, `tools/sync-agent-reports.sh`). The graph-remediation plan hit the same class
when the capture recorder deleted its own evidence on the failure path (AGENTS.md).

### 4.4 Worktrees on a known-good filesystem

Tendril worktrees are created under `arboretum/worktrees/` on the same filesystem as the checkout,
after an A9 environment probe; the post-condition (all workspace links present) is checked, and a
failure is a refusal, not a warning. **[S]** `session-worktree.mjs` reported failure only in text
after `bun install` could not link four packages on ntfs3.

---

## 5. Tropisms — state-derived context injection

### 5.1 The gap

revoy2's hook bus has two kinds: **veto** (tool preflight, intersection-only) and **observe**
(returns a bounded note). Notes are recorded to the hook ledger
(`hooks/bus.ts:230-231,351-352`) and I found no path by which they reach the model's context.
The native agent therefore has no equivalent of OMO's system-reminder injection, its
continuation enforcer, or Claude Code's `SessionStart` additional-context. ADR-174 (Proposed,
"Repository instructions reach the native agent path") is the first half of this gap.

### 5.2 A third hook kind: `inject`

`inject` handlers return a **typed Tropism**:
`{id, trigger, lane, provenance: "generated", derived_from: [ring-event-hash…], body ≤ N bytes,
expires_after_turns}`. The plane renders it into the model's context as a delimited block that
the prompt contract defines as **advisory state, never instruction authority** (the fork's §7
trust-boundary rule: prompt payloads are data). An injection can never grant a capability, change
a node's write-set, or satisfy a predicate.

### 5.3 Three rules that keep Tropisms from becoming OMO's prompt lane

1. **Every tropism declares its lane** — `CODE` (the plane enforces the thing it mentions), or
   `ADVISORY` (information only). A tropism that *asks for behaviour* must be `CODE`, meaning a
   Guard cell or veto enforces it. A lint rejects imperative text in an `ADVISORY` tropism.
2. **Derived, never constant.** `body` must be a function of `derived_from` events;
   `gate:hook-liveness` already treats a hook whose output stopped varying as a defect, and the
   same rule applies. A tropism whose inputs did not change is not re-injected.
3. **No artifact the plane does not create.** A tropism may not reference a path or tool the plane
   has not materialised (OMO's `mktemp` notepad and writerless `ledger.jsonl`).

### 5.4 The initial catalog (machine-scoped ADR)

| tropism | trigger | lane | replaces |
|---|---|---|---|
| `orient` | session start | ADVISORY | `governance-orientation.sh` text; now: current Tendril, leased node, its write-set and predicate, owed decisions touching it |
| `lease` | first tool call without a lease | CODE (veto follows) | "branch before committing", "commit only your files" prose |
| `continue` | idle / stop with a leased node whose predicate is false | CODE (Stop blocks, countdown + stagnation + failure caps, kill switch) | OMO todo-continuation enforcer; `gate-stop.sh` dump |
| `delta` | stop | CODE | the 39-gate dump; now: only gates whose inputs this session changed, plus one line of owned debt (§7.3) |
| `rot` | a write lands on `F:p` that another node or doc cites as `L:p:n` | ADVISORY → spawns node | the SUR-05 line drift **[S]** |
| `sink` | a source commit after the last rebind | ADVISORY | `evidence-staleness-nudge.sh` |
| `expiry` | T-7 days on a waiver/allowlist | CODE (spawns decision node) | nothing today **[S]** |
| `sibling` | a path outside the lease changes on disk | ADVISORY | `session-isolation.sh` minute-zero warning, made continuous |

### 5.5 One catalog, one host (amended)

The catalog drives the **native** harness only: `inject` runs in-process, at the same lifecycle
points the hook bus already defines (`hooks/contracts.ts:42-51`), and a repository participates
by **enrollment**, not by copying scripts.

**Claude Code and Codex hooks are deprecated and archived, not in force** (Amendment 1). Today
revoy2 registers 13 hooks in `.claude/settings.json` and 3 in `.codex/hooks.json`. Under this
design they are retired on the no-loss checklist in `.omo/plans/disable-claude-codex-hooks.md`:
each hook's *check* is confirmed to exist natively, and each hook's *trigger moment* (per tool
call, at session start) is listed as the thing a native Tropism must reproduce before the hook
is removed. The scripts move to an archive directory, clearly marked as reference material, so
their logic stays readable while none of them runs in everyday use. Re-enabling an external host
later means a generated shim calling the native `arbor tropism <event>` entry point. That is a
separate decision, not part of this proposal.

---

## 6. Roles — OMO's roster on the botanical taxonomy, with capability binding

### 6.1 The mapping

The fit is close, which is evidence the two rosters describe the same underlying separation.

| OMO role | what it does there | revoy2 role | change |
|---|---|---|---|
| prometheus (coordinator, never delegated, md-only writer) | plans | **Taproot** | already "writes only `.arbor/`"; keep the never-delegated rule as code |
| atlas (plan executor, owns plan file and F-wave) | executes plans | **Cambium** | Cambium owns Tendril advancement; it cannot complete `decision` or `verify` nodes |
| sisyphus (primary orchestrator) | drives the session | **Crown** | selection is UCT over Trellis-eligible nodes, not free choice |
| hephaestus (deep worker) | long autonomous work | **Heartwood** | unchanged; lease-bound |
| sisyphus-junior + category | does delegated work | **Seed** + **Grain** | see §6.2 |
| oracle (read-only consultant) | reasoning | **Burl** | read-only wall enforced by veto |
| librarian | external docs | **Mycelium** | egress under ADR-173 consent |
| explore | codebase search | **Rhizome** | read-only |
| multimodal-looker | vision | **Stoma** | read-only |
| metis (pre-planning gap analysis) | finds what a plan misses | **Xylem** | runs the Trellis linter and axis coverage report |
| momus (plan critic) | reviews plans | **Lenticel** | critic of work *and* plans; ADR-175: an approval must come from an actual critic instance |
| — (new) | tests that gates can fail | **Guard** | owns Guard-cell canaries (§7.1); may not edit the gate it tests |
| — (new) | carries operator decisions through | **Recorder** | the only role that may emit `operator.*` events, and only from a live interview (ADR-158) |

### 6.2 Grains replace categories

OMO's nine categories resolve to the same agent plus a model and a `<Category_Context>` block
(`fork: architecture.md §4`). A **Grain** keeps that — model, context block, reasoning budget —
and adds what categories lacked: a **capability ceiling** (max tool tier, allowed resource
namespaces) and a **cost class** feeding A10. A Grain can narrow a role's authority, never widen
it (intersection, as the hook bus already does for vetoes). revoy2's two-level `routing_tier`
(economical/capable) becomes two of the Grains.

### 6.3 Enforcement at source

Role and Grain are bound into the session at `session_start` (the only deny-capable lifecycle
event, `hooks/contracts.ts:51`) and checked on every tool preflight. The OMO pattern — a policy
that "appends a reminder" — is explicitly out of scope: a role restriction without a veto is not
a role restriction.

---

## 7. Guard cells — gate remediation and relocating responsibility

### 7.1 Gates must be able to fail: canaries and the third state

Every gate ships a **canary**: a minimal input on which it must fail, and the expected failure
reason. A machine-scoped Guard job runs every gate against its canary (on gate-body change and
weekly), and a gate that passes its canary is **quarantined** — its green results are reported
as `unproven` until fixed. This is the missing check R2 names: *"Nothing anywhere executes a gate
body and asks whether it can fail."*

Every gate result is tri-state — `pass | fail | unresolved` — and reports `observed_count`.
`observed_count == 0` on an input that is expected non-empty is `unresolved`, and `unresolved`
never counts as green (the `unresolved` third state ARBOR-INTEL §5.6 recommends keeping).

Concrete fixes this implies, each a Trellis node in the migration (§9):

| gate | defect | fix |
|---|---|---|
| `gate:adr-status` | exit 0 on every path (R2-01) | real exit codes, or re-declare as `advisory` in the profile — not both |
| `gate:claim-ledger` | null subprocess → every claim discharged (R2-02) | subprocess failure = `unresolved` |
| `gate:adr-trace` | cannot evaluate on `push: master` (R2-03) | evaluate the pushed range from the CI event payload, not a local ref |
| ADR registry lock | no reclamation (R2-04) | retired by Rings (§2.3) |
| `gate:completion-depth`, observed plane, decision-queue, interview store | empty input = pass (R2b F2–F6) | canary + `observed_count` |
| `gate:registration-integrity` | cannot parse `RUNTIME_CATALOG` alias **[S]** | reuse the one catalog reader (three parsers exist today: `derive.ts`, `tui-catalog-parity/catalog-parser.mjs`, `registration-integrity.mjs`) |

### 7.2 New Guard cells

- `consumer-exists`: every config key, exported tool, catalog kind and tropism has a production
  consumer (OMO's `task.dag`; this session's `max_session_wall_clock_ms` before `d2f9a2b8` wired
  it **[S]**).
- `wiring-proof`: every config field has a composition-root test that fails when the wiring is
  removed (remediation plan todo 18, generalized).
- `rendered-matches-fold`: every rendered status line/count equals its Rings fold (retires SUR-05's
  hand-pinned drift list, which this session had to re-pin because a doc moved **[S]**).

### 7.3 Relocating responsibility: the per-turn battery

Today the Stop hook runs the whole stop tier on every turn: 39 gates, median 30.5–31.5 s against
a 25 s ceiling (ADR-156), and on every turn of this session it reported the same 7 red gates, none
caused by the turn **[S]**. The signal "red means you broke something" was gone, and the cost was
paid on every stop.

Three moves, in order of payoff:

1. **Schedule by changed inputs.** Each Guard cell declares its input globs (the evidence stores
   already declare producer inputs). The Stop tier runs only gates whose inputs intersect the
   turn's write-set (A8), reusing the control plane's existing `cached` status keyed by input
   digest. A doc-only turn runs a handful of gates; a turn that changed nothing runs none.
2. **Owned baseline debt.** A red gate that was red at the Tendril's base revision is recorded
   once as `debt.open{gate, reason, owner: decision-node}` and rendered as one line; it blocks
   nothing until its owning node is leased. A *new* red — a gate that was green at base — blocks.
   The `delta` tropism (§5.4) is the rendering.
3. **Move repo-wide gates to their natural tier.** `vi-freshness`, `store-freshness`, `vi-vendor`,
   `reuse-compliance`, `sur-05` answer "is the repository's evidence consistent", which is a
   session-close question (ADR-160 already moved commits there), not a per-turn one.

Expected effect, stated as a measurement to take, not a claim: stop-tier p50 on a doc-only turn
under 3 s; zero unattributed reds; the ceiling in `stop-budget.json` lowered, per ADR-156's
ratchet.

### 7.4 `Witnessed<T>`: make caller-asserted inputs untypeable

R1's headline class is a gate whose input is a verdict supplied by its caller. The fix is a
branded type, `Witnessed<T, W extends WitnessId>`, whose constructor is exported only from the
module that performs the witnessing (isolation from the worktree service, plan review from the
Lenticel verdict fold, lease acquisition from the lease authority). A gate signature that accepts
`boolean` for a witnessed fact fails a Guard cell (AST check over gate entry points). `lease_acquired:
true` as a literal type becomes impossible to write because the literal is not a `Witnessed`.

### 7.5 Offloading the evidence graph

The VI graph rebind is the costliest and most fragile step: 5–6 minutes, refuses a dirty tree,
breaks on a reword, and was blocked this session by an unrelated expired allowlist **[S]**.
Offload it:

- A background **Xylem service** (per machine) extracts the graph incrementally for each new
  commit of each enrolled repository, in its own clean worktree under `arboretum/worktrees/`,
  and stores it content-addressed at `arboretum/cache/graph/<repo>/<tree-hash>/`.
- Gates read the graph **by tree hash**, not by commit ancestry. A reword changes the commit id
  but not the tree, so it no longer invalidates evidence. `evidence:rebind` becomes a cache lookup
  plus a wait.
- The graph leaves the repository entirely, which is what ADR-169 (Proposed) already argues.
- The reachability allowlist becomes Rings waivers with A7 expiry nodes, so an expiry can no
  longer surface first as a rebind failure.

---

## 8. Source-level forcing, and its honest tiers

"Agents are forced at source level" is true in exactly one place and must be stated as tiers,
the way ADR-025 states the strength ladder.

| tier | host | what is enforced | bypass |
|---|---|---|---|
| **T1 enforced** | native revoy2 harness | `session_start` veto without a lease or a recorded ad-hoc exploration lease; tool-preflight veto on write-set, role and Grain; node completion only via predicates and Rings events; `Witnessed<T>` in the type system | none from inside the harness; only by editing the harness, which is itself a governed change |
| ~~**T2 hooked**~~ | Claude Code, Codex | **deprecated, archived, not in force** (Amendment 1). Their hooks are reference material only | — |
| **T3 detected** | anything else writing to an enrolled repo, including Claude Code or Codex sessions | node-close reconciliation, Rings-vs-git audit, CI Guard job | undetected until the next audit |

Three design consequences. First, all governed work runs through the native path (T1). Second,
an external-host session is treated as T3: whatever it writes is caught by reconciliation and
audit, never trusted as governed. Third, the plane never reports a T3 guarantee as T1, which is
the same "do not over-claim the tier" discipline the repo already applies to local pre-push
hooks.

---

## 9. Migration, smallest valuable steps first

Each step is independently landable and each retires something. Nothing here requires the whole
design to be adopted.

| step | delivers | retires | depends on |
|---|---|---|---|
| M1 | Guard canaries + tri-state + `observed_count` for the R2/R2b gates | R2-01/02/03, R2b F2–F6 as silent passes | — |
| M2 | Stop tier scheduled by changed inputs; owned debt lines | the 30 s all-red Stop dump **[S]**; stop-budget breach | M1 (so skipped gates are trustworthy) |
| M3 | Rings v0: append-only machine log, projections for registry + interviews + waivers | R2-04 lock; five-store drift | — |
| M4 | `inject` hook kind + `orient`/`delta`/`sink` tropisms in the native harness; Claude Code/Codex hooks archived per the no-loss checklist | 16 external-host hook scripts (13 Claude Code, 3 Codex) move to an archive, not in force; ADR-174's gap | M3 |
| M5 | Trellis schema v1 (A1, A2, A4, A5, A6, A7) + scheduler JSON + `.omo` renderer | hand-ordered waves; this session's remediation plan becomes the first Trellis instance | M3 |
| M6 | Tendrils + leases + preflight write-set veto + node-close reconciliation | mutable `boulder.json`; reminder-only write policy | M5 |
| M7 | Role manifest + Grains as a machine-scoped ADR; `Witnessed<T>` | caller-asserted gate inputs (R1) | M6 |
| M8 | Xylem graph service keyed by tree hash | 6-minute rebind; reword-breaks-ancestry | M3 |
| M9 | Remaining axes (A3, A8–A12) and Guard cells `consumer-exists`, `wiring-proof`, `rendered-matches-fold` | SUR-05 hand-pinned lists; hollow config fields | M5–M8 |

M1 and M2 are the cheapest and remove most of the day-to-day pain observed this session. M3 is
the keystone for everything else.

---

## 10. What this deliberately does not do

- **It does not make the model the authority on anything.** Every completion is a predicate or a
  witnessed operator event.
- **It does not infer write-sets from prose** (§1.4).
- **It does not adopt OMO's prompt lane.** No rule without a counter, no artifact without a
  writer, no reminder where a veto is meant.
- **It does not add a governance store.** Rings replaces at least eight; the net count must fall,
  and a Guard cell should measure it.
- **It does not keep Claude Code or Codex hooks in force.** They are deprecated and archived as
  reference (Amendment 1); external-host sessions are T3 at best (§8).
- **It does not port to opencode v2**, per the fork's own decision record (ARBOR-INTEL §1): no 2.x
  host has been published to npm.

## 11. Risks and open questions for the operator

1. **Machinery budget.** revoy2's governance already costs a real share of each session (this
   session: 7 red gates, a failed rebind, stale sessions blocking commits). The proposal is only
   worth adopting if M1–M3 measurably *reduce* per-session overhead. Proposed acceptance metric:
   stop-tier p50, rebind wall time, and count of governance stores, measured before and after
   each step and recorded as Rings events.
2. **Global vs repo authority.** Moving decision identity out of the repository changes what a
   fresh clone knows on its own. Option: Rings events for a repo are also exported, read-only,
   into `decisions/.rings-export.jsonl` at session close, so a clone can verify without the
   machine plane.
3. **Multi-machine.** A git-backed Rings directory gives backup and a second witness; it does not
   give concurrent multi-writer semantics. Is one writer machine an acceptable constraint?
4. **Enrollment scope.** Which repositories enroll first: revoy2 alone, or revoy2 plus the fork as
   a second tenant to prove repo-agnosticism?
5. **Naming.** Arboretum, Rings, Trellis, Tendrils, Tropisms, Guard, Recorder, Grain are
   proposals. The botanical constraint is the repository's own convention (AGENTS.md role table).

## 12. Decisions this document asks for

Each would become one ADR through `/revoy2-interview`, in this order:

1. Adopt Guard-cell canaries and the tri-state result (M1).
2. Adopt input-scoped Stop scheduling with owned baseline debt, and the tier moves in §7.3 (M2).
3. Adopt Rings as the single immutable governance index at the machine scope (M3).
4. Add the `inject` hook kind and the Tropism lane rules in the native harness (M4), which
   subsumes ADR-174, and retire the Claude Code/Codex hooks to an archive under the no-loss
   checklist in `.omo/plans/disable-claude-codex-hooks.md`.
5. Adopt the Trellis plan schema and Tendril state (M5–M6), superseding `.omo` plans as the plan
   of record while keeping the markdown rendering.
6. Adopt the role manifest, Grains and `Witnessed<T>` (M7).
7. Adopt the Xylem graph service keyed by tree hash (M8), which subsumes ADR-169.
