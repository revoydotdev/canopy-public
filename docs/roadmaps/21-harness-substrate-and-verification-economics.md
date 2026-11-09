# Roadmap 21 — Harness substrate & verification economics (2026-08)

Artifact kind: roadmap
Status: historical
Revision: 1
As-of commit: 73fb8068 (2026-09-22)
Authority: Retained research-and-build brief; findings are inputs to ADRs or the canonical roadmap and are not implementation claims.
Evidence scope: mixed — dated 2026-08 literature/protocol sweep re-verified against code at authoring time (observed) plus build and do-not-build proposals (target); not re-run since
Supersedes: none
Superseded by: sequencing and priority only: `docs/roadmap-1.0.0-and-documentation-governance.md`
Owner: Canopy/revoy2 maintainers
Review trigger: the brief is reopened, or its implementation is materially changed or superseded by an accepted ADR

> **Sequencing superseded (2026-09-22):** this brief is retained as design and implementation history. Its priorities and ordering are subordinate to the [Canopy/revoy2 1.0.0 roadmap](../roadmap-1.0.0-and-documentation-governance.md). Treat implementation and research claims as bounded to the evidence recorded in this brief; verify current status against code and sealed evidence before relying on them.
**Lane:** standing correction lane (with 19 and 20). Same two-stage discipline: a dispatched
frontier research agent produced a brief; every paper it cited was then pulled and read
personally, and every claim about revoy2 in this document was re-verified against the code
before it was written down. As in 19 and 20, that pass rejected items the research proposed
(§9) and downgraded several it ranked highly (§8).

**Sweep scope:** a general, deep sweep across arXiv for concepts bearing on *harness design* —
not a single protocol or topic. 24 papers were pulled and read. Unlike 19 (protocol drift) and
20 (inter-agent comms), this sweep produced **build items**, because it found four places where
independently-motivated literatures converge on a structural claim that revoy2 does not yet
satisfy, and each of those is a small, testable change.

---

## §0 The bound: what this sweep does and does not establish

Read this before treating anything below as settled.

**The load-bearing result of the sweep is a negative one.** The single most careful measurement
in the corpus — Leni's production decomposition (2607.17044) — finds that the *verification loop
itself* contributes **+1.5 pp of an +11.0 pp architectural uplift** on SpreadsheetBench. The other
+9.5 pp is scaffolding, routing, and specialist models. Their instrumented verifier catches
**c ≈ 0.20** of true errors (fix rate r ≈ 0.75). That is a production deterministic loop with a
real external oracle, and it catches one error in five.

revoy2's central architectural claim is a four-gate lifecycle. This paper is the closest thing in
the literature to an independent measurement of what such a lifecycle is worth, and the honest
reading is: **the gates are worth less in isolation than the architecture around them, and their
value is concentrated at the margin** — the +1.5 pp was six rescued tasks, which is the difference
between a mid-leaderboard and a near-top result. That is a real effect and worth having. It is not
the effect the design rhetoric implies.

Three consequences run through every item below:

1. **Do not add gates. Make the existing gates say more.** Every build item here either adds a
   *field* to an existing record or adds a *distinction* to an existing outcome. None adds a gate.
2. **The oracle sets the ceiling, not the loop.** Leni's three oracle classes (deterministic /
   self-reflective / planner-mediated) bound what any loop can catch. revoy2's `verified`
   provenance tag is a deterministic oracle; `critic_approved` is a self-reflective one. Those are
   different reliability classes and the ledger does not currently say which ceiling applies.
3. **Independence of the observer carries the effect.** Leni's specialist-swap ablation moved the
   observe/compare stage from an independent small verifier back onto the frontier model that
   generated the artifact: rescues fell 6 → 2, and a separate benchmark's correct-rejection rate
   fell 4–5 pp. §W3 is the one item here that could plausibly matter more than all the others.

**What this sweep does not establish.** No paper here measures anything like revoy2's actual
workload (crash-safe, gate-governed, UCT-over-campaigns tree search with a durable hash-chained
ledger). The strongest papers measure single-agent loops on public benchmarks. Every quantitative
figure quoted below is quoted with its sample size and its provenance, and §8 grades each one.

---

## §1 Files to read first

Repo (verify these yourself before implementing — every claim below was checked against them):

- `packages/arbor-gate/src/gate.ts` — `GateResult`, `makeResult`, `bypassGate`,
  `checkHarnessPromotion`. **W1, W3, W9.**
- `packages/arbor-mcp/src/manager.ts:369–380`, `:448–465`, **`:836–849`** — the three gate call
  sites. The third is the checkpoint round-trip that reconstructs `failures` from prose. **W1.**
- `packages/arbor-core/src/types.ts:12–25` — the `Provenance` tagged union. **W2, W4.**
- `packages/arbor-mcp/src/worktree-machine-verifier.ts:114–135` — where provenance is produced and
  where argv is deliberately flattened to a redacted display label. **Read the comment at :129
  before touching `cmd`. W2.**
- `packages/arbor-mcp/src/tools.ts:32–56` — `validateProvenance`, the trust-boundary check.
  **W2, §13.3.**
- `packages/arbor-core/src/scoring.ts` — `scoreAction`, `scoreActionWithPolicy`, `scoreAgentUct`,
  `deriveDecayingLambda`. **W7.**
- `packages/arbor-prompts/src/role-profiles.ts` — `specialist-executor` vs `critic-reviewer`
  separation. **W3.**
- `packages/arbor-eval/src/metrics.ts`, `agent-uct.ts`, `reuse-ledger.ts` — **W6, W7.**
- `decisions/ADR-002` (UCT scoring), `ADR-006` (process gates), `ADR-012`/`ADR-016`/`ADR-043`
  (recovery authority), `ADR-034` (determinism measured off the critical path), `ADR-038`
  (harness overlays), `ADR-051` (cost attribution is evidence before pruning).

Roadmaps: **19** §7 (the amended empty-finding block) and **20** §7–8. This roadmap narrows 19 §7
again — see §10.

---

## §2 The four convergences

A convergence is where two or more papers, from *different* problem domains and with no shared
authorship, arrive at the same structural claim. These are the findings I weight most, because
neither paper could have derived the other's motivation.

### C1 — Binary decisions are the wrong shape; a third "non-evaluable" state is required

- **Governance enforcement** (2605.23935, Fernandez, ACP series paper 6): execution state must be
  `{execute, deny, halt}`. `deny` is *falsified* authority; `halt` is *non-evaluable* authority.
  "Systems that collapse this distinction treat epistemic incompleteness as a denial decision,
  which is incorrect." `halt` is non-terminal — a Recovery Loop identifies the minimal unresolved
  variable set, acquires it, and re-attempts.
- **Benchmark statistics** (2607.12338, Huang): a partial evaluation must be able to return
  *unresolved* rather than being forced to a pairwise conclusion. Forcing a decision is how a
  partial run reports a low error rate while silently deciding only the easy cases. On SWE-bench
  Verified, an error-controlled policy still leaves 93.6% of comparisons unresolved at 25% budget.

These two have nothing in common except the shape of the answer. One is a policy-enforcement
paper with no empirical evaluation; the other is a careful replay study over public leaderboards.
Both conclude that a two-valued decision is a category error under partial observability.

**revoy2 (verified):** `GateResult.result` is `"pass" | "fail" | "bypass"`, and
`makeResult(gate, failures)` returns `fail` whenever `failures.length > 0`. A gate that *checked
and found a violation* and a gate that *could not check* both produce `fail`. `bypass` is not the
missing third state — it is an evidence *deficit* recorded for later resolution
(`bypass_evidence_deficit`), for gates that could not fail closed. There is no state meaning
"insufficient evidence; suspend and re-attempt when the missing input becomes observable." → **W1**

### C2 — Citation is necessary but not sufficient; the claim must be *contained* in the evidence

- **Multimodal agent runtime** (2607.28374, LedgerMind, HKUST-GZ et al.): four ledger invariants —
  (I1) evidence origination, (I2) citation validity, (I3) **claim–evidence containment**, (I4)
  repair locality. They name the failure I3 catches **Phantom Grounding**: a claim cites valid
  evidence IDs yet introduces entities or numeric values absent from the cited source. Citation
  structure passes; content does not. Their Proposition 1 (provenance non-amplification) proves
  that no repair operator can add a ledger entry without tool-produced provenance, by enumerating
  the seven typed operators.
- **Provenance survey** (2606.04990, Griffith et al.): the taxonomy distinguishes `CITED` from
  `SUPPORT` as different edge types precisely because "a source may be CITED but not SUPPORT a
  claim." And: "logs answer what happened; execution graphs answer what depended on what."
- **Harness survey** (2605.18747 §5.2.2, UIUC/Meta/Stanford): "a harness can become overconfident
  precisely because it has executable feedback: the agent sees a green test, but the green test is
  not the full specification." Their proposed fix is an *evidence bundle* per accepted action —
  checks run, assumptions preserved, untested regions, remaining risks.

**revoy2 (verified):** the `verified` provenance variant is
`{ tag: "verified"; cmd: string; exit: number; stdout_hash: string }`. It records *that* a command
ran and anchors its output. It does not record what the command verifies, what it cannot verify,
or whether the claim it supports is contained in its output. revoy2 has I1 and I2 structurally; it
has no I3, and no machine-readable statement of what a passing check covers. → **W2, W4**

### C3 — Governance objects must be canonical, not textual

- **Runtime governance** (2607.13716, CAVA): approval must bind to a hash over canonical *action
  semantics*, never to a display string. Named threat: **approval drift** — "an operator approves
  one surface description while a different semantic action executes." An approval is not a
  session permission; it is an *action gate lease* scoped to target, policy version, actor,
  session, proof digest, and time window, expiring if any changes.
- **Formal protocol semantics** (2603.24747, SBB): MCP tool schemas cannot express
  transactionality; the approval requirement survives only as prose in a `description` string that
  MCP's rules do not interpret. Their principle P2 makes `side_effects` and `requires_approval`
  first-class structural metadata rather than prose.
- **Harness survey** (§5.2.5): permissions "should depend not only on tool identity, but also on
  arguments, environment state, data sensitivity, and expected side effects."

Three papers, three domains (enterprise runtime governance, π-calculus protocol semantics, and a
literature survey), one claim: *the thing you approve must be a reconstructed semantic object, not
the string you rendered to the approver.* → **W5**

### C4 — The tree already contains signal the harness is not reading

- **Agent RL** (2509.21240, Tree-GRPO, ICLR 2026): nodes anchored at the *complete agent step*
  (thought–action–observation), not tokens. Prefix sharing yields ~1.5× more rollouts at equal
  token/tool budget (`E[B_tree] = M·B + L·N·B/2`, because an expansion from a randomly selected
  node costs half a trajectory in expectation). Critically: **sibling differences at branch points
  convert outcome-only rewards into step-level process supervision**, with no additional
  evaluation. Intra-tree GRPO has the same gradient structure as step-level DPO.
- **Stateful precomputation** (2504.13171, Letta/Berkeley): splitting a problem into persistent
  *context* and transient *query* lets the context be pre-reasoned once and amortized —
  ~5× less test-time compute for equal accuracy, 2.5× lower cost per query when amortized across
  related queries on one context.
- **Production token economics** (2607.06906, Writer): the byte-stable cached prefix is the single
  highest-leverage cost variable; naive full-history replay is O(k²) in turns, harness-managed
  context is O(k).

Three independent framings — RL credit assignment, precomputation, and cache economics — all say
the shared prefix of a search tree is an unexploited asset. revoy2's campaign tree *is* a
prefix-sharing structure (worktree lineage) and currently uses it for isolation only. → **W7**

---

## §W1 — Gate outcomes: persist the structure, then decide whether `indeterminate` is worth building

**Grounding:** C1. Also 2605.18747 §5.2.2: "the harness should know when a signal is strong enough
to act on, when it is weak, and when additional evidence is required."

**Verified gap, in two layers.** `makeResult` in `packages/arbor-gate/src/gate.ts` sets
`result: failures.length === 0 ? "pass" : "fail"`. Every checker pushes into a single `failures`
array, so there is no channel for "I could not evaluate this." Concretely in `checkEvidence`:

- `provenance_tag === null` — nothing was produced. **Non-evaluable.**
- `tag === "verified"` with an empty `stdout_hash` — the caller asserted something the evidence
  contradicts. **Evaluated and false.**

These differ in what should happen next. The first should acquire the missing provenance and
re-attempt; the second must *never* be re-attempted on the same inputs, because re-attempting is
how a false claim gets laundered into a true one. Both produce `fail`, and `manager.ts:459`
branches only on that — the distinction survives only as prose inside `detail`.

**The second layer is worse, and was found by tracing rather than by reading types.**
`GateCheckpoint` persists only `detail`, which is `failures.join("; ")`. On the recovery path,
`manager.ts:836–849` reconstructs the result by wrapping that single prose string back into a
one-element array:

```ts
failures: priorCheckpoint.checkpoint.gate.result === "fail" ? [priorCheckpoint.checkpoint.gate.detail] : [],
```

**The per-failure structure is destroyed at persist time and cannot be recovered on replay.** This
is therefore not only a type gap: the durable record — the thing revoy2 calls authority — keeps the
rendered form and discards the structured one. Any fix must touch the checkpoint schema, not just
`GateResult`.

Those failure strings are static English authored in `gate.ts` (`"worktree not isolated"`,
`"no provenance tag on result"`) — no paths, no user data. **Unlike the provenance case in §W2,
there is no redaction rationale here.** The structure is discarded for nothing.

### W1a — Persist the structure *(do this first; no ADR)*

1. `GateCheckpoint` persists `failures: string[]` structurally; `detail` becomes a *derived*
   display string rather than the stored form. This is the repo's own idiom (ADR-014, ADR-017,
   ADR-020, ADR-021: structured is authority, rendered is projection) applied to one of the few
   places that inverted it.
2. Additive and non-breaking: readers that only consume `detail` keep working, and the
   recovery-path reconstruction stops synthesising an array from prose.
3. Split the checkers' pushes into `failures` and `unresolved`. `checkEvidence`'s
   `provenance_tag === null` moves to `unresolved`; the `stdout_hash` contradiction stays in
   `failures`. **Do not change `result` yet** — only record which bucket each entry came from.

Point 3 is the whole trick: *the distinction can be recorded without being acted on.* Once
recorded, §W3's measurement becomes valid and the real frequency of `unresolved` becomes
observable — which is the input W1b needs and does not currently have.

### W1b — `indeterminate` as an outcome, and a recovery loop *(conditional; ADR required)*

**Do not build this until W1a's data shows how often `unresolved` actually fires.** If it is rare,
the recovery loop is machinery for a case that does not happen — exactly the failure §0 warns
against. If it is common:

1. `GateResult.result` becomes `"pass" | "fail" | "indeterminate" | "bypass"`; `indeterminate`
   when `unresolved` is non-empty and `failures` is empty. **`fail` takes precedence when both are
   non-empty** — you already know the outcome is bad, and acquiring a missing input cannot make it
   good.
2. `bypass` stays exactly as-is (a gate that could not fail closed, proceeding under a recorded
   deficit). Do **not** merge them: `bypass` proceeds; `indeterminate` does not.
3. A bounded recovery loop over `indeterminate`. Fernandez's Theorem 2 gives liveness only under
   *eventual observability*, and his §11.5 names oscillation between constructible and
   non-constructible states as a real failure mode. Cap re-attempts; escalate to `human_required`
   (roadmap 07).

**Deliberately out of phase 1: `checkIsolation`.** Its three inputs are already `boolean`, so the
distinction is destroyed *before* the checker runs — `worktree_isolated: false` means either "I
checked and it isn't" or "I couldn't check." Fixing it means changing `IsolationCheck` and every
caller, including test doubles in `arbor-mcp` and `arbor-opencode`. Real, but not on the critical
path. Note the inconsistency for whoever picks it up: `EvidenceCheck` carries a comment explaining
that `verification_cmd_ran` was *removed* for precisely this class of reason (A-1, "true by
construction and proves nothing about whether a command actually ran"). That reasoning was applied
to one interface and not to its neighbour.

**Nit while you are in there:** `checkEvidence`'s message reads `"provenance claims !verified but
stdout_hash is missing"` while the branch condition is `tag === "verified"`. The message is
inverted relative to the code.

**Do not** adopt ACP wholesale. Roadmap 20 §5's authority-boundary finding still
stands after D46's bounded IDE transport: `arbor acp` refuses client-supplied
MCP authority and does not use ACP as an execution or approval substrate. The
`halt` *state* is separable from the protocol and is what this roadmap takes.

**Test (W1a):** a checker with an unavailable input records a non-empty `unresolved` and an empty
`failures`; the checkpoint round-trip preserves both arrays. **Test (W1b):** a recovery loop that
never resolves terminates at the cap rather than spinning.

---

## §W2 — Provenance: a closed classification beside `cmd`, never free text

**Grounding:** C2 and Leni's oracle-class taxonomy — the oracle bounds both catch rate `c` and
false-alarm rate `f`, so a record that does not name its class cannot be reasoned about.

**Be fair about what `verified` establishes:** a command with this exact text ran, exited with this
code, and produced output with this hash. Anchored, replayable, non-repudiable — stronger than most
of the corpus surveyed here. What it does not establish is what a pass *licenses*. These three
produce identical records:

- `bun run test:all` → exit 0
- `npx vitest run packages/arbor-gate/tests/gate.test.ts` → exit 0
- `npx vitest run -t "checkEvidence passes with verified tag"` → exit 0

**The scope is present in `cmd`, and nothing reads it.** Every consumer of `provenance.cmd` in the
repo is a shape validator — `tools.ts:39`, `audit.ts:1664`, `persist.ts:186`, `kb.ts:97`,
`output-evidence.ts:315`, `reuse-ledger.ts:80`, all checking "non-empty string" — plus exactly one
human-facing render at `arbor-tui/src/screens/tree.ts:114`. **No code in revoy2 branches on the
content of `cmd`.** It is validated, persisted, hash-chained, and addressed exclusively to a human
reader.

That is the same shape 2603.24747 formalizes about MCP: a requirement that "survives at best as
prose in a description string that MCP's rules do not interpret." revoy2 reproduces it internally.

Two further findings from the trace:

- **`cmd` is not always a command.** `plugin-registry.ts:117` writes
  `{ tag: "verified", cmd: "plugin-registry.verify", exit: 0, stdout_hash: digest }` — an internal
  function name and a digest, not a process invocation. The same tag covers "a shell command exited
  0" and "an internal function computed a hash."
- **The boundary validator is weaker than the in-tree producers.** All three producers
  (`worktree-machine-verifier.ts:127`, `opencode-executor.ts:532`,
  `opencode-server-executor.ts:568`) gate on `result.exit !== 0` before constructing `verified`.
  `validateProvenance` at `tools.ts:40` requires only `Number.isSafeInteger(v.exit)` — **not zero**.
  Whether a nonzero-exit `verified` can actually reach the ledger via `arbor_record_result` was not
  traced to a conclusion; see §13.

### The constraint that shapes the fix

**Do not "persist the structure instead of the prose" here.** Unlike W1, the flattening is
deliberate and correct — `worktree-machine-verifier.ts:129–130`:

```ts
// Prefer a bounded audit label over the raw argv so an argv carrying
// repository paths cannot leak into the durable session projection.
const display = command.display ?? commandDisplay(command.argv);
```

That is the structural-redaction invariant, and it stands. **Recorded here so no future reader
proposes un-flattening `cmd` — that path is closed.**

But note what it costs: the redaction protects paths by discarding *all* structure, including
structure that carries no paths. `WorktreeMachineVerifier` holds the full `command` object at the
moment it builds provenance, and throws away the breadth of what it ran along with the paths.

### Change

Add a small **closed enum** beside `cmd`, populated at the producer:

```ts
| { tag: "verified"; cmd: string; exit: number; stdout_hash: string;
    check?: { kind: RuntimeCatalogKind; breadth: "suite" | "subset" | "single" } }
```

No paths. No free text. `bun run test:all` and `vitest run -t "…"` become machine-distinguishable,
which is all §W6.3's false-acceptance metric needs, and the `plugin-registry` case gets a `kind`
that honestly is not a shell command.

**Retracted from this roadmap's first draft:** an optional free-text
`scope: { verifies, does_not_verify }`. That was wrong. Optional prose that nothing branches on is
*exactly how `cmd` became write-only*; it would have reproduced the bug one level up. A closed enum
or nothing.

A stored `oracle` field is also unnecessary: it is derivable from the tag (`verified` ⇒
deterministic, `critic_approved` ⇒ self-reflective). Derive it in `arbor-eval`; do not persist it.

**Test:** a fixture campaign records `check` on every machine-verified node; a projection groups
verification outcomes by `breadth` and by oracle class derived from the tag.

---

## §W3 — Observer independence: measure it, then enforce what the measurement supports

**This is the highest-expected-value item in the roadmap, and the least certain.**

**Grounding:** 2607.17044 §7. Moving the observe/compare stage from an independent post-trained
verifier back onto the frontier model that generated the artifact reduced SpreadsheetBench rescues
from 6 tasks to 2 and BullshitBench correct rejection by 4–5 pp. The paper's own framing: "what
carries the effect is the independence of the observer, not just the presence of a loop."
Consistent with the self-preference literature it cites, and with Huang et al.'s result that LLMs
largely cannot self-correct without external signal. Independently corroborated by 2603.26942
(the observability gap: output-level feedback is *structurally* under-informative for diagnosis
when the causal chain from code to symptom is many-to-one — feedback that minimizes reviewer
workload is insufficient to drive convergence).

Also relevant, and cutting the other way: 2606.08275 (Causal Agent Replay, CMU) reports that
LLM-judge step-level failure attribution on Who&When is only ~14% accurate. An LLM observer is a
weak instrument even when independent.

**Verified state:** `packages/arbor-prompts/src/role-profiles.ts` separates `specialist-executor`
from `critic-reviewer`, and the critic prompt states "You cannot approve work you proposed or
modified." That is **identity** independence and it is genuinely enforced. There is *no* constraint
that the critic runs a different model than the specialist, and no constraint that verification
observes through a different code path than the one that produced the artifact. Leni's spreadsheet
loop uses three distinct paths deliberately (openpyxl writes → LibreOffice headless recalculates →
openpyxl `data_only=True` reads back).

**Change, in order:**

1. **Measure before enforcing.** Record the model identity used for each role on each node in the
   ledger (revoy2 already has per-node cost attribution under ADR-051, so the plumbing exists).
   Then add an `arbor-eval` lane that computes revoy2's own `(c, r, f, b)`:
   - `c` — of nodes where a later gate or human found a defect, the fraction the critic flagged.
   - `r` — of flagged defects, the fraction the subsequent correction actually fixed.
   - `f` — of nodes that were correct, the fraction the critic flagged.
   - `b` — of false alarms, the fraction whose "correction" made the node worse.

   **This measurement is invalid on pre-W1a data, and that is an ordering constraint, not a
   caveat.** `f` is the rate at which a *correct* node is flagged. Today a gate that could not
   evaluate a correct node and a gate that wrongly flagged one both record `fail`, and §W1 shows
   the distinguishing structure is destroyed at persist time. Computing `f` from existing ledgers
   therefore inflates it by an unknown amount. Land W1a first and measure only on data collected
   after it.

   Then evaluate Leni's inequality **`(1 − p)·c·r > p·f·b`** for revoy2's actual numbers. Right now
   that inequality is assumed, not checked. If it fails, the critic gate is *reducing* reliability
   and that is a finding worth more than any feature in this roadmap.
2. **Then**, and only if the measurement supports it, add a same-model check: warn (do not block)
   when the critic and the specialist for a node used the same model identity. Blocking would be
   premature — revoy2's critic is prompted to be approval-biased and rejects only verified
   blockers, which is a different regime from Leni's judge-style verifier.
3. **Independent read-back where it is cheap.** Where a specialist's result is a file mutation, the
   evidence gate should read the artifact back off disk rather than trusting the specialist's
   report of it. Claw-SWE-Bench (2606.12344) is the sharpest evidence for this: a bare adapter that
   asks the model to emit a unified diff in its final message scores **19.1% Pass@1 with 69.1%
   apply-failure**; the full adapter, where the model edits files and the *runner* exports the
   patch from git state, scores **73.4% with <1.5% apply-failure**. Same model, same tasks. This is
   direct external validation of revoy2's worktree-isolated-node design and of the doctrine that
   protocol adapters are never authority — and it is worth an explicit citation in ADR-023.

**Test:** the `(c, r, f, b)` lane produces numbers on a fixture corpus, and the inequality is
evaluated and reported rather than assumed.

---

## §W4 — Claim–evidence containment, and a named Phantom Grounding regression test

**Grounding:** C2. LedgerMind's I3 and its Proposition 1.

**Verified gap:** revoy2 enforces that evidence exists, is hash-chained, and is cited. It does not
check that the *content* of a claim is licensed by the evidence cited for it. A critic rationale or
specialist report that cites a valid `stdout_hash` while asserting a file, symbol, or count absent
from that stdout passes every current gate.

**Change:**

1. A containment check at the evidence gate: identifiers and numeric values appearing in a
   promoted claim must appear in the cited evidence (or in an explicitly declared derivation
   chain). LedgerMind's decomposition is the right shape — an entity-consistency check and a
   numeric-coherence check with type-aware tolerance (exact for counts, exit codes, and hashes).
   Start narrow: **exit codes, file paths, and test counts**. Those are the three that appear in
   nearly every revoy2 claim and admit exact matching with no NLP.
2. A regression test named for the failure: a node whose claim cites a real `stdout_hash` but
   asserts a file path absent from that stdout must not reach `verified`.
3. **Audit the repair path against Proposition 1.** revoy2's recovery authority (ADR-012, ADR-016,
   ADR-043) already refuses to replay indeterminate effects — which is a *stronger* property than
   LedgerMind's, since theirs concerns content and revoy2's concerns effects. The open question is
   the narrower one: can any recovery or continuation path append a ledger entry that did not
   originate from a tool return or a deterministic mapping of one? Enumerate the writers and state
   the answer in the handoff. If the answer is yes, that is a defect; if no, it is a property worth
   stating in an ADR because it is currently only implied.

**Test:** the Phantom Grounding fixture above, plus a positive control (a claim genuinely contained
in its evidence passes).

---

## §W5 — Approval binds to a canonical action fingerprint

**Grounding:** C3.

**Verified state:** ADR-024 puts tool-execution enforcement at a host trust boundary and ADR-028
puts capability enforcement at revoy2-owned mutating surfaces. Those are the right placements. The
question this sweep raises is orthogonal to placement: **what object does an approval bind to?**

**Change:**

1. Where revoy2 asks for an approval or records a capability grant, compute a deterministic
   fingerprint over the canonical action — at minimum
   `{operation, capability, target, reversible, systems_touched, policy_version}` — and bind the
   approval record to that hash, not to the rendered description shown to the approver.
   `packages/arbor-core/src/canonical.ts` and the existing `operation-registry.ts` fingerprint
   field are the natural homes; the registry already carries `fingerprint` and `idempotency_key`,
   so this may be closer to *wiring* than to new code. **Check that first** — if the approval path
   already binds to `OperationRecord.fingerprint`, this item reduces to a test and a doc note.
2. Treat an approval as a **lease**: if target, policy version, actor, or session changes, the
   approval does not carry over. State the lease scope explicitly wherever an approval is recorded.
3. `reversible` is the field most worth adding if absent: it is the input to both blast-radius
   reasoning and rollback policy, and CAVA, the harness survey §5.2.5, and 2603.24747's P2 all
   name it independently.

**Deliberately not taken:** CAVA's wrapper-normalization parser packs, its Semantic Pattern Layer,
and its attestation substrates. See §8 for why the paper's evidence does not support adopting its
machinery, only its threat model.

**Test:** re-rendering an approved action's description without changing its semantics keeps the
approval valid; changing the target invalidates it.

---

## §W6 — `arbor-eval`: trajectory faithfulness, harness-level metrics, and a run manifest

This is the largest item and the one with the best cost/benefit, because revoy2's ledger already
contains nearly every input.

**Grounding (four sources, all converging on "final-outcome accuracy is the wrong unit"):**

- 2605.18747 §5.2.1 names six harness-level metric dimensions: trajectory efficiency,
  **verification strength (including false-acceptance rate)**, recovery ability, state consistency,
  safety compliance, and **replayability**. revoy2 plausibly leads on replayability and safety
  compliance and has *no* measure of verification strength.
- 2607.28374 gives four computable trajectory metrics: `UCR_reason` (unsupported claim rate),
  `GDR` (grounded decision rate), **`R4R`** (right *for the right reasons* — succeeded ∧ grounded),
  and **`WDG`** (wrong but decision-grounded). `R4R` and `WDG` are the pair that separates
  evidence-backed success from luck, and they are exactly the discrimination revoy2's doctrine
  ("no unverified status claim") asserts but does not measure.
- 2605.21404 audits twelve canonical agent-benchmark papers against a five-field disclosure schema
  (benchmark identity / harness spec / inference settings / cost / failure breakdown). Mean agent
  score **0.38 / 1.0**; **zero of eight** agent benchmarks disclose inference cost in any form;
  **zero** pin a content-addressed environment digest. Their manifest is ~40 lines of JSON.
- 2607.12338 shows a task *fraction* is not a decision rule: a sufficient budget must
  simultaneously meet decision-error, **group-coverage**, and **unresolved-comparison** targets.
  Cheap-first ordering on τ-bench used 11.5% of cost and produced **100% coverage failure** plus
  wrong conclusions.

**Change:**

1. Emit a **run manifest** per campaign from the ledger. Fields, in priority order:
   *content-addressed environment identifier* (a digest, never a mutable tag — this was the single
   universal failure in the twelve-paper audit), model identifier **plus run date** (closed-API
   aliases are silently re-pointed), sampling/aggregation rule, cost (input tokens, output tokens,
   tool calls, wall-clock, and dollar cost at a stated rate), and a **structured failure breakdown
   with counts** — named categories, per-node attribution. revoy2 already records all of this; the
   item is the projection, not the collection.
2. Add `R4R` and `WDG` to `packages/arbor-eval/src/metrics.ts`. revoy2 has a cleaner grounding
   predicate available than LedgerMind's — `provenance.tag === "verified"` is machine-checkable
   where theirs requires an LLM judge. `WDG` (wrong, but the decision looked grounded) is the one
   to watch: a rising `WDG` means the evidence gate is being satisfied by claims that are not true.
3. Add **false-acceptance rate**, split by §W2's `check.breadth` and by oracle class derived from
   the provenance tag. Breadth is the more informative split: a false acceptance under
   `breadth: "single"` is a scope problem, one under `breadth: "suite"` is an oracle problem, and
   today they are the same number. This is the metric
   revoy2 most conspicuously lacks and the one the harness survey names first under verification
   strength.
4. Adopt the **unresolved** third outcome in eval comparisons (the same shape as §W1b, but
   independent of it — this one is about comparing configurations, not gating nodes): when a partial
   eval budget cannot separate two configurations, report unresolved rather than forcing a winner,
   and report the unresolved *rate* alongside the error rate.
5. **Eval hygiene, from Claw-SWE-Bench §2.3:** their SWE-bench-Multilingual containers still
   exposed git commits *after* `base_commit`, so an agent could read the real fix via `git log`.
   They strip reachable future commits during workspace preparation. revoy2 constructs worktrees
   at a `starting_commit`; confirm that future history is not reachable from an expansion worktree,
   and if it is, fix it and record the check. This is a correctness bug class, not a nicety.

**Test:** the manifest validates against a schema; `R4R`/`WDG` compute on a fixture corpus; the
future-commit reachability check has a red-then-green test.

---

## §W7 — Selection: a documented tension, and a free process signal *(ADR amendment to 002)*

**Verified state:** `scoreAction` computes
`(gain/cost)·(1−r_acc)·(1−r_crash)·m_gap + C·√(ln N/(1+n_cat))`. `scoreAgentUct` (landed
eval-only from roadmap 19) adds `−λ_t·ΔĈ` with `λ_t = λ₀/√t`. Both are cost-aware. Neither is
consequence-aware, and neither uses marginal-gain-from-more-compute.

### W7.1 — Record the cost/consequence tension (documentation, do not build yet)

Roadmap 19 landed Agent-UCT's cost-regularization term as an eval-only comparator. This sweep
found a paper that argues the *opposite* of naive cost/difficulty ranking, and the two must be
recorded together or a future reader will land the wrong one.

2606.04402 (Sydney/SIOM) finds, on 300 SWE-bench Lite tasks with a 16-solver compute-tier
benchmark:

- Consequence (cost-if-wrong) and difficulty are **orthogonal**: |ρ| ≤ 0.11 across four
  independent labelings including a three-annotator human majority.
- **Difficulty-aware routing performs 13.1% *worse* than random** under a cost-weighted objective,
  because `ρ(difficulty, Δsuccess) = −0.78` — the hardest tasks remain unsolved at every tier, so
  premium compute spent there returns nothing.
- The right signal is `priority(x) = consequence(x) · Δsuccess(x)` — cost-if-wrong times marginal
  gain from more compute. That reduces cost-weighted loss by 30.7% over difficulty-aware routing.
- Their consequence predictor never made the dangerous error (high-consequence routed to lowest
  tier: 0/44) across two model families.

The bearing on revoy2: `m_gap = gain/best_known` and the UCB term together push budget toward
under-explored and under-performing categories. That is difficulty-shaped allocation, which is
the policy this paper measures as worse than random *under a cost-weighted objective*. revoy2's
objective is not obviously cost-weighted, so this is not yet a defect — but it is a live question
and ADR-002 should say so rather than leaving a future reader to rediscover it.

Also record the **negative result from BAVT's ablation** (2603.12634, UBC/Vector, ICLR-grade
evaluation across 4 benchmarks × 2 model families × 3 budget tiers): tree structure *without*
value guidance scores **0.215 EM versus 0.268 for the flat parallel baseline** — unguided tree
expansion is actively worse than no tree at all, because it fragments a limited budget across
dead ends. revoy2's entire architecture is a tree. The quality of the value signal is therefore
not a refinement; it is the precondition for the tree being worth anything.

### W7.2 — Harvest the process signal already in the tree *(build)*

**Grounding:** C4, specifically Tree-GRPO §3.2. At every branching point, the difference between
outcome rewards back-propagated from sibling subtrees is a preference signal — step-level process
supervision derived from outcome rewards alone, at zero additional evaluation cost. Subtree depth
sets the granularity.

revoy2 back-propagates node scores through a tree whose siblings share a prefix. **The
sibling-difference signal is already sitting in the ledger and is not being read.** Concretely:
for a node with ≥2 expanded children, the spread of their eventual verified outcomes is evidence
about the *decision at that node*, independent of any critic. That is a second, structurally
independent estimate of node quality — and §W3's whole point is that independence of the observer
is what carries the effect.

**Change:** in `arbor-eval` (not production selection — keep the ADR-002 discipline of comparing
before switching), compute per-branch-point sibling-outcome spread from replayed campaign ledgers
and report its correlation with the critic's verdict at that node. If they disagree, that is
directly actionable. If the sibling signal predicts verified outcomes better than the critic does,
that is a major finding for ADR-002.

Also record two facts from Tree-GRPO for anyone touching expansion:

- Node granularity should be the **complete agent step**, not a sub-step. Their §3.1/Appendix B.3
  argues this explicitly for agent tasks with clear step structure. revoy2 already does this;
  it is worth a citation because it is a load-bearing choice that currently rests on nothing.
- Expected budget for random tree expansion is `M·B + L·N·B/2` — an expansion from a randomly
  chosen non-leaf node costs *half* a full trajectory in expectation. Trading trees (`M`) for
  expansions (`N`,`L`) buys more rollouts at the price of narrower exploration.

### W7.3 — Consider a budget-annealed selection exponent *(evaluate only)*

BAVT's `α_t = 1/r_t`, where `r_t` is the minimum remaining budget ratio across resources, applied
as `w(n) ∝ V(n)^{α_t}`, gives a parameter-free exploration→exploitation transition: broad when
budget is abundant, near-greedy as it depletes. Their motivation is explicitly that UCB "assumes
unbounded horizons, failing to adapt to strict, depleting resource constraints" — which is
precisely revoy2's regime (`max_seconds`, token budgets, campaign caps).

Their residual value critic is the other half and may matter more: the critic scores a *delta*
(marginal information gain, clipped to `[−4, +4]`) rather than an absolute quality, specifically to
counter LLM self-evaluation overconfidence. That is a small prompt-level change to revoy2's critic
with a plausible effect, and it is testable in an eval lane.

**Do not land either in production selection.** Add as `ScorePolicy` modes alongside `agent_uct`
and compare. ADR-002's existing discipline is correct here.

---

## §W8 — Budget overrun is a named production failure class

**Grounding:** 2606.04056 catalogs **63 confirmed production budget-overrun incidents** across 21
frameworks (2023–2026), each backed by a quoted issue and maintainer statement, with two-human
inter-rater reliability κ = 0.837 on the four-class scheme. The catalog is carefully caveated
(selection on the dependent variable; no prevalence claim) and its eight-cluster mechanism
partition is explicitly exploratory (κ = 0.44).

Two findings bear directly on revoy2 and on roadmap 09:

1. **The M-delegation-fanout race** (11 catalog incidents): a budget delegated across agent
   boundaries is duplicated or reused. revoy2 expands child nodes under a parent budget; if any
   budget is delegated per-expansion, this race applies. The mitigation is not the paper's Rust
   affine-types crate (which requires a Rust rewrite and is out of scope) — it is the property:
   *a delegated budget slice must not be duplicable or reusable after delegation.* State whether
   revoy2 holds it.
2. **Reasoning models break `max_output_tokens` accounting** (their assumption A6): providers bill
   hidden reasoning tokens not bounded by `max_output_tokens`, so any client-side pre-flight token
   cap under-estimates for extended-thinking models. This matters beyond cost: BAVT's `r_t`
   (§W7.3) and any budget-annealed policy are wrong if the budget accounting is wrong. ADR-015
   (model-aware token epochs) is the right home for the note.

**Change:** documentation only. Record both in ADR-051 / roadmap 09 as named risks with the
catalog citation. Adopt the paper's **guarantee-map** table format for any future budget ADR —
each property, the single layer that enforces it, whether it is proven or empirical, and the trust
assumption it rests on. That table is the most transferable thing in the paper.

---

## §W9 — Citations for properties revoy2 already has

Cheap, and it stops future readers re-deriving settled things. Add citations, not code:

- **ADR-023** (worktree isolation) ← Claw-SWE-Bench's 19.1%→73.4% adapter result (§W3.3). The
  strongest external validation of "read the result from repository state, never from the model's
  final message" in the corpus.
- **ADR-006** (process gates) ← 2605.18747 §3.4's Plan–Execute–Verify framing, especially §3.4.4
  "Verification through Deterministic Sensors": "critiques should interpret sensor outputs rather
  than replace them" and "termination should be governed by verification rather than by model
  confidence." That is revoy2's doctrine, published as an open research direction.
- **ADR-034** (determinism measured off the critical path) ← 2606.08275 §3 and the Thinking
  Machines result it cites: hosted inference is nondeterministic even at temperature 0 (FP8
  non-associativity, batch-dependent kernels), and a single-stream local model with a fixed seed
  replays exactly. CAR's response — report an *action-match rate* rather than assert
  reproducibility — is the right posture and matches ADR-034.
- **`arbor-audit`** ← PROV-AGENT (2508.02866, ORNL, IEEE e-Science 2025) extends W3C PROV with
  MCP concepts and models `Campaign` as a top-level Activity — the same word revoy2 uses. Worth
  citing as convergent vocabulary; see §7 for why we are not adopting it.
- **`arbor-gate`'s `checkHarnessPromotion`** ← see §9. It already exceeds what two 2026 papers
  propose as future work.

---

## §7 Don't-build decisions

| Candidate | Paper | Disposition & reason |
|---|---|---|
| **ACM configuration model** | 2608.11166 (PwC) | **Don't build.** A framework-independent config-governance model with immutable configuration items, baselines, and lattice-based impact propagation. revoy2's `decisions/registry.json` + ADR corpus already *is* an immutable-configuration-item store with baselines. The one idea worth stealing is **dependency-aware impact propagation** — when an ADR is superseded, which downstream items are impacted? revoy2's registry is flat. Note it as a possible future item for roadmap 13/15; do not adopt the model. |
| **Full W3C PROV / PROV-AGENT adoption** | 2508.02866 | **Don't build as core.** Adopting PROV as the ledger's internal model would be a large refactor for interoperability revoy2 has no consumer for. If an external auditor ever needs it, it is an *export projection* over the existing ledger, not a change to it. |
| **agrepl-style MITM record/replay** | 2607.16200 | **Don't build.** A transport-layer proxy that replays stored HTTP responses. Its `F = 1.0` fidelity is tautological (it returns stored outputs), it is single-author with no venue, and it explicitly does **not** capture filesystem mutations — which is most of what a revoy2 node does. revoy2's worktree isolation is the stronger position. The one transferable idea is its **signal/noise header taxonomy** for diffing: classify divergence into semantically meaningful vs. per-request noise before reporting it. Useful if replay-divergence reporting is ever built. |
| **CAVA machinery** | 2607.13716 | **Threat model only** (§W5). The parser packs, Semantic Pattern Layer, Bounded Action Firewall, and attestation substrates are a commercial stack; see §8 for the evidence problem. |
| **Anomaly detection over agentic traces** | 2511.04032 | **Don't build.** XGBoost/SVDD at 98%/96% accuracy on agentic traces sounds compelling and is circular: the labels are generated by a script from cycle/error criteria, and SHAP shows the classifier is driven by exactly those path-level features (`tool_count`, `total_steps`). It is re-detecting its own labeling rule. Their own error analysis concedes the point — the false negatives are precisely the subtle-drift cases, i.e. the actual *silent* failures the paper is named for. |
| **Rust affine budget types** | 2606.04056 | **Don't build** (the catalog is what we take — §W8). Requires a Rust rewrite; the paper's own decision matrix places it in the "new Rust agent" cell and explicitly does not recommend it elsewhere. |

---

## §8 Evidence grades

Graded on what the paper's own evidence supports, not on how relevant its idea is.

| # | Paper | Venue / provenance | Evidence | Grade | Used for |
|---|---|---|---|---|---|
| 2607.17044 | Where Does Agent Reliability Come From? | Leni Inc. (vendor) | 3 benchmarks, n=400/100/165, CIs, contamination audit, **corrects its own earlier company number downward**, states which comparisons are unresolvable | **High for a vendor paper.** The self-correction and the explicit non-claims are unusual and earn trust. Specialist-swap is *preliminary* by the authors' own label. | §0, W3 |
| 2606.04402 | Not All Errors Are Equal | Sydney / SIOM | 300+400 tasks, 4 independent labelings incl. 3-human majority, sub-domain replication, R² decomposition, confusion matrices | **High.** The orthogonality result replicates under every labeling including humans-only. Offline compute-tier study, not a controlled single-model intervention (their own §9). | W7.1 |
| 2603.12634 | BAVT | UBC / Vector | 4 benchmarks × 2 model families × 3 budget tiers, full ablation, convergence proof | **High.** The ablation (tree-alone is worse than flat) is the most important number and is internal to their own method. | W7.1, W7.3 |
| 2509.21240 | Tree-GRPO | ICLR 2026, Xiamen/AMAP | 11 datasets, 3 task types, theory + ablation, public code | **High.** | W7.2 |
| 2606.12344 | Claw-SWE-Bench | Tsinghua/PKU/SJTU + industry | 350 instances, 8 languages, 5 harnesses × 2 models + 9-model sweep, public data | **High.** The 19.1→73.4 adapter diagnostic is a single comparison but a decisive one. | W3.3, W6.5 |
| 2607.12338 | How Many Tasks Are Enough? | Independent researcher | Replay over public SWE-bench/AppWorld/τ-bench records, sensitivity sweeps, reproducibility package | **High.** Careful, well-caveated, claims only what replay of completed records supports. | C1, W6.4 |
| 2607.28374 | LedgerMind | HKUST-GZ et al. | 6 benchmarks + stress set, 6 frontier MLLMs, 4 vendors, trajectory metrics | **Medium-high.** Strong evaluation; domain (multimodal VQA) is far from revoy2, so the architecture transfers and the numbers do not. | C2, W4, W6.2 |
| 2605.18747 | Code as Agent Harness | UIUC / Meta / Stanford | Survey; no new measurement | **Medium (survey).** Its §5.2 open problems are the best available articulation of the design space; treat as framing, never as evidence. | C2, C4, W6.1, W9 |
| 2606.04990 | From Agent Traces to Trust | Griffith et al. | Survey | **Medium (survey).** Taxonomy and vocabulary only. | C2 |
| 2606.04056 | Token Budgets | Independent researcher | 63 incidents, κ=0.837 four-class IRR, public catalog | **High for the catalog, low for the mechanism.** Authors are explicit: selection on the dependent variable; the 8-cluster partition is exploratory (κ=0.44). Take the catalog. | W8 |
| 2605.21404 | Twelve Benchmark Papers Audit | BrightMind / UT Arlington | 12 papers, single auditor, one pass | **Medium.** The authors call it a pilot and name the cells where a second rater would disagree. The *schema* is the contribution and does not depend on the scores. | W6.1 |
| 2508.02866 | PROV-AGENT | ORNL / Argonne, IEEE e-Science 2025 | "Preliminary evaluation"; no quantitative results | **Medium-low.** Real lab, real venue, no measurement. Model only. | W9, §7 |
| 2607.06906 | The Harness Effect | Writer Inc. (vendor) | n=22 tasks, 6 models, LLM-judge quality, self-defined frozen baseline | **Low for the claims, high for the mechanisms.** The baseline is their own deliberately-poor prior loop (49 KB monolithic prompt, regex XML tool parsing, destructive truncation); a 41% improvement over that is not a neutral measurement, and they concede quality deltas are "a wash at n=22." The §4.3 mechanism inventory is nonetheless the most detailed public description of production harness token discipline. | C4 |
| 2605.23935 | Operationalizing Reconstructive Authority | Self-published series (arXiv + Zenodo), single author | **No empirical evaluation.** Theorems are true by construction. | **Low.** Taken for the `halt` *concept* only, and only because 2607.12338 independently converges on it. Would not be actionable alone. | C1 |
| 2603.24747 | Formal Semantics for Agentic Tool Protocols | SBB, v3 | π-calculus formalization; bisimulation proofs | **Medium, with a caveat.** The proofs are sound but the SGD grammar is *authored by the paper*, so "necessary and sufficient" is a property of their chosen model, not of MCP. P2 is independently well-motivated. | C3 |
| 2607.13716 | CAVA | Ond Holdings (startup), single author | Self-constructed 96-seed benchmark; **CAVA scores 1.000 on all nine metrics, baselines score 0.000** | **Low.** A benchmark authored by the system's vendor on which the system is perfect and the baselines are perfectly useless is a designed demonstration, not a measurement. The threat model (approval drift, wrapper bypass, evidence laundering) is nonetheless sharp and is what we take. | C3, W5 |
| 2608.02645 | Verified Tool Calls | Old Dominion / CNU | Simulated env, Gemini Flash-Lite, n=25/config | **Low-medium.** Simulated only. Notably, their own ablation shows verify-*only* ≥ verify-before-retry — retries are not clearly beneficial. Consistent with §0. | §0 context |
| 2603.26942 | The Observability Gap | Cambridge / UEA | 4-page paper, one task domain, one evaluator, one model family, n=10/group | **Low.** Suggestive; the authors call Group D a diagnostic probe, not a solution. | W3 (corroboration only) |
| 2606.08275 | Causal Agent Replay | CMU | Synthetic SCMs with planted ground truth | **Medium.** Validates its estimators against known answers, which is the right discipline. The ~14% LLM-judge attribution figure is quoted *from* Who&When, not measured here. | W3, W9 |
| 2605.27328 | Governed Evolution of Agent Runtimes | Independent researcher | **Vision paper; no evaluation, by the author's own statement** | **Low.** See §9 — revoy2 already implements more than it proposes. | §9 |
| 2605.16278 | Keeping an Eye on AI | Dagstuhl seminar, 20+ authors | Framework + template applied to 4 domains; no measurement | **Medium (framework).** Cross-disciplinary and careful. Its warning is the usable part. | §11 |
| 2605.20173 | Runtime Architecture Patterns | Independent researcher | Methodology + runnable reference impl on public data; no comparative evaluation | **Low-medium.** The failure-signature catalog is checkable against one's own logs, which is its real value. | §11 |
| 2608.11166 | ACM | PwC | Reference impl + 3 adapters; qualitative scenarios | **Low-medium.** Modeling paper. | §7 |
| 2511.04032 | Detecting Silent Failures | IBM Research | 4,275 + 894 traces, IRR reported | **Low despite the numbers** — the labeling is circular. See §7. | §7 |
| 2504.13171 | Sleep-time Compute | Letta / UC Berkeley | 2 synthetic stateful datasets + amortization set, multiple frontier models | **Medium.** Real evaluation, but on splits the authors constructed; the agentic SWE result is a single case study, and at high test-time budgets the baseline slightly wins. | C4 |

---

## §9 Recommendations rejected on verification

Following roadmap 20 §8's precedent — recording what came back clean so it is not re-opened.

**Rejected: "add governed harness mutation / an Evolution Agent."** Two papers propose this as
future work — 2605.27328 in full (HarnessMutation, a five-state capability lifecycle, a change
contract with rollback conditions) and 2605.18747 §3.5.3 / §5.2.3 ("every proposed edit should
carry a change contract: which component is modified, which failure mode it targets, what
improvement it predicts, which invariants it must preserve, which evaluation can falsify it, and
how it can be rolled back").

**revoy2 already implements this, and implements it more strictly than either paper specifies.**
Verified in `packages/arbor-gate/src/gate.ts`, `checkHarnessPromotion` requires all of:

- the component is on an allow-list (`isAllowedHarnessComponent`);
- a named human approver;
- prior critic activation (`status === "active"` && `approved_by`);
- **three-way separation of duties** — the human promoter must differ from both the proposer and
  the activating critic;
- a measured `evaluation.outcome === "improved"`;
- **non-empty replay evidence *and* non-empty independent holdout evidence**;
- no regression detected.

Neither paper specifies three-way separation, and neither requires *both* replay and holdout
evidence. 2605.27328 is a vision paper with no implementation; §5.2.3 of the survey lists
"evidence-carrying harness evolution, held-out regression suites, safety invariants, canary
deployment, rollback semantics" as an open research agenda. ADR-038 already governs the overlay
scope.

**Disposition: no work item.** Cite `checkHarnessPromotion` against both papers in the handoff so
the next reader sees that this ground is held. The only gap worth noting is *canary deployment* —
neither ADR-038 nor `checkHarnessPromotion` stages a promoted revision across a subset before
full activation. That is a legitimate future item, not one this sweep justifies building.

---

## §10 Empty findings, and a further narrowing of roadmap 19 §7

**Roadmap 19 §7, as amended, claims: "no published comparator exists for *live, crash-safe,
gate-governed* campaign search."** That claim survives, but it must narrow again on one axis.

**LedgerMind (2607.28374) is a comparator on the evidence-ledger axis.** Its four invariants map
almost one-to-one onto revoy2's doctrine, and it was derived independently in a completely
different domain (multimodal visual QA):

| LedgerMind invariant | revoy2 |
|---|---|
| I1 evidence origination — every entry is a tool return or a deterministic mapping of one | "protocol adapters are never authority"; `Provenance` tags the origin |
| I2 citation validity — claims cite only ACTIVE entries | hash-chained evidence; `stdout_hash` anchoring |
| I3 **claim–evidence containment** | **absent — this is §W4** |
| I4 repair locality — repair cannot append unsupported content | ADR-012/016/043 (stronger: concerns *effects*, not just content) |

This is closer to revoy2's evidence architecture than EvoGit (nearest on coordination paradigm)
or Agent-UCT (nearest on search mechanism) — the two comparators recorded in 19 §7. It is still
not a comparator on the *durability* axis: LedgerMind's ledger is per-trajectory runtime state for
a frozen-backbone VQA agent, not a crash-safe, hash-chained, replayable audit ledger. So the
narrowed claim is now:

> Three adjacent systems exist, each nearest on a different axis — Agent-UCT (search mechanism),
> EvoGit (coordination paradigm), LedgerMind (evidence-ledger invariants). No published system
> combines them, and none is crash-safe or durable. The "no comparator" claim should now be read
> as *no comparator on the composition*, never as *nothing adjacent exists*.

**Genuinely empty findings from this sweep:**

- **No paper found on crash-safe durable ledgers for agent campaigns.** Searched across
  provenance, observability, replay, and governance vocabularies. The closest are agrepl
  (transport replay, no filesystem state) and PROV-AGENT (provenance model, no durability
  semantics). revoy2's crash-continuation work (roadmap 03, ADR-043) has no literature to check
  against; that is a real gap in the field, not a gap in the search.
- **No paper found measuring gate-lifecycle contribution in a *tree-search* harness.** Leni's
  decomposition is the only isolated measurement of a verification loop's marginal contribution
  anywhere in the corpus, and it is a linear pipeline.

**Methodological notes for the next brief in this lane:**

1. `mcp__frontier__arxiv_fetch` is **broken** — it returns
   `{"ok":false,"error_code":"AttributeError","error_detail":"'Result' object has no attribute 'download_pdf'"}`.
   Fall back to `curl -sL https://arxiv.org/pdf/<id>` piped through `pdftotext`. This has now
   failed in two consecutive sweeps; it is a tool defect, not a transient.
2. **Reading depth, stated honestly.** Of the 24 papers, 21 were read end-to-end. Three exceeded
   practical limits and were read selectively, with the sections named: **2605.18747** (5,986
   lines) — abstract, introduction, framing, §3.4, §3.5, and all of §5.2 read in full; the middle
   taxonomy sections and reference list skimmed. **2607.06906** — all of §1–§7 read; appendix
   tables skimmed. **2606.04990** — §1–§5 read; §6–§8 skimmed. Every claim attributed to those
   three above comes from a section read in full.
3. **An empty finding is only as strong as the vocabulary it was searched with** — the lesson
   recorded in 19 §7 held again here. LedgerMind surfaced only under "evidence ledger," not under
   "audit," "provenance," or "trajectory."

---

## §11 Cautions carried forward but not built

Two papers produce warnings that no build item can discharge. Record them; do not roadmap them.

**Oversight can be theatre** (2605.16278, Dagstuhl, 20+ authors across CS/HCI/psychology/law).
Their framing separates three preconditions for monitoring — information *availability*,
*detection*, and *interpretation* — and two for intervention — *capability* (authority, skill,
willingness, situation awareness) and *feasibility*. The warning: "poorly-designed oversight can
create the illusion of human control, when oversight structures give humans the responsibility,
but not the agency, to prevent harm."

revoy2's ledger maximizes **availability**. It does nothing for detection or interpretation, and
availability without those two is exactly the illusion they name. This is the same shape as the
repo's own doctrine ("a safeguard that is documented but not wired is worse than none") pointed at
the ledger itself. It composes with the reviewer-fatigue finding already recorded elsewhere in
this lane: a guard that escalates more is not automatically safer, because past the reviewer's
capacity the extra escalations spend the attention the dangerous action will need. Their layered
model (real-time / systemic / compliance oversight) is a useful lens if revoy2's approval surface
is ever revisited.

**Failure signatures worth checking against revoy2's own logs** (2605.20173). Low-grade paper,
but the catalog is directly checkable and four entries are sharp enough to be worth quoting:

- *Symptom:* one sub-agent's output dominates merged outputs beyond its declared weight.
  *Cause:* merge logic delegated to an LLM call; the LLM developed a preference.
  *Correction:* **"The LLM proposes. Deterministic code decides."**
- *Symptom:* sub-agent retries appear after the orchestrator's deadline. *Correction:* **the retry
  budget belongs to the parent** — disable retries on sub-agents. (Composes with §W8's
  delegation-fanout race.)
- *Symptom:* gate decisions take longer than the action they gate. *Cause:* the gate is running a
  model call. *Correction:* a gate is a deterministic rule check. (revoy2's gates are pure
  functions — this one is already held, and worth stating.)
- *Symptom:* a timer fires after a manual override and produces a stale transition.
  *Correction:* **every timer fire is a CAS, not an unconditional write.** Relevant to roadmap 07's
  durable scheduler.

---

## §12 Ordering

**Corrected from this roadmap's first draft.** The original ordering put W3's measurement first and
gated everything on it. That was wrong: `f` cannot be computed from existing ledgers (§W3), so the
structural fixes must land *before* the measurement, not after it.

1. **W1a** — persist `failures`/`unresolved` structurally; `detail` becomes derived. Cheap, no ADR,
   no redaction tension. Makes the measurement valid.
2. **W2** — the `check` enum beside `cmd`. Cheap, respects the redaction invariant. Makes
   false-acceptance computable per breadth and per oracle class.
3. **W6.5** — future-commit reachability in expansion worktrees. Independent of 1–2 and a potential
   correctness bug, so it can run in parallel.
4. **W3.1** — measure `(c, r, f, b)`; evaluate `(1−p)cr > pfb`. **On post-W1a data only.**
5. **W4** — containment + Phantom Grounding test + repair-path audit.
6. **W5** — approval fingerprint binding. Check first whether `OperationRecord.fingerprint` already
   carries it; may reduce to a test.
7. **W6** — manifest, `R4R`/`WDG`, false-acceptance rate, unresolved. The largest item.
8. **W1b** — `indeterminate` + recovery loop, **only if step 1's data shows `unresolved` fires often
   enough to justify it.** ADR required.
9. **W7.2** — sibling-difference signal in `arbor-eval`. Highest upside, lowest urgency.
10. **W7.1, W7.3, W8, W9** — documentation and eval-only comparators; any time.

Steps 1–2 are roughly a day's work and unblock everything downstream. Step 8 stays unwritten until
the data justifies it: building the recovery loop before knowing its trigger rate is the failure §0
warns against.

Step 4 still gates the build items after it. If revoy2's critic gate does not satisfy the
inequality, this roadmap's priorities change completely, and that is the correct outcome.

---

## §13 Handoff note

Write `docs/roadmaps/handoffs/21-harness-substrate-and-verification-economics.md` recording:

1. The measured `(c, r, f, b)` for revoy2's gates and the evaluated inequality, **with the data
   window stated** (post-W1a only — §W3). **State the numbers even if they are unflattering** —
   especially if they are unflattering.
2. **The observed `unresolved` rate from W1a.** This is the input that decides whether W1b gets
   built at all; record it even if the answer is "never fires."
3. **Can a nonzero-exit `verified` reach the ledger?** `validateProvenance` (`tools.ts:40`) accepts
   any safe integer while all three in-tree producers gate on `exit !== 0`. Trace
   `arbor_record_result`'s provenance path to a conclusion. If yes, it is a bug; if no, add the
   assertion at the boundary anyway to match the producers.
4. The answer to §W4.3: can any recovery or continuation path append a ledger entry without
   tool-produced provenance? Enumerate the writers.
5. Whether the approval path already binds to `OperationRecord.fingerprint` (§W5).
6. The future-commit reachability result (§W6.5).
7. Any `ADR-PENDING-<slug>` authored for W1b, with a content id and **no number** — the integration
   conductor allocates from `decisions/registry.json` at landing (ADR-054).
8. Which of §11's four failure signatures were checked against revoy2's logs and what was found.
