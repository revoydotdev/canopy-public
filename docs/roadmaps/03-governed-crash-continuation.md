# Roadmap 03 — Governed crash continuation (LR-NH-01)

Artifact kind: roadmap
Status: historical
Revision: 1
As-of commit: c373ea2b (2026-09-22)
Authority: Retained implementation brief for governed crash continuation; informs local technical scope only. Release sequencing is owned by the canonical 1.0.0 roadmap.
Evidence scope: mixed — supervised native continuation path observed at 2348ddbb; provider replay and unattended continuation are not established
Supersedes: none
Superseded by: sequencing and priority only: `docs/roadmap-1.0.0-and-documentation-governance.md`
Owner: Canopy/revoy2 maintainers
Review trigger: the brief is reopened, or its implementation is materially changed or superseded by an accepted ADR

> **Historical implementation brief — sequencing superseded.** The canonical 1.0.0 sequence is [docs/roadmap-1.0.0-and-documentation-governance.md](../roadmap-1.0.0-and-documentation-governance.md); this document's priority and ordering are subordinate to it. The design and evidence history below is retained. Any present-tense gap or future-work statements below describe the brief's authoring-time baseline, not a current status claim.
>
> **Implementation status at `2348ddbb6363f85ae3ddd3aeffec4b07156e5cd8`: implemented for the documented supervised native continuation path.** `packages/arbor-mcp/src/recovery/`, `recovery-service.ts`, `harness-session-journal.ts`, `packages/arbor-mcp/tests/recovery/`, and `docs/roadmaps/handoffs/governed-crash-continuation.md`; commit `aff826fb`. This does not establish provider replay or unattended continuation.

**Audience:** an implementing coding agent on a feature branch. This is your brief.
Read roadmap 01 §1-§2 and §8 first (invariants, read-list, repo gotchas). This is the
**hardest and most safety-critical** of the roadmaps — the governance stakes are highest.
Do not cut corners; when unsure, fail closed and report.

**One-line goal:** let a long native campaign survive a process/machine/provider interruption
and *continue* — without ever re-running an operation that may already have had a billable or
externally-visible effect, and without ever silently resurrecting expired authority.

**The governing rule (from `ROADMAP.md` §"LR-NH-01" and ADR-012/ADR-016 — read them):**
> New authority requires new admission and new evidence. Persistence, protocol metadata, a
> provider assertion, or the mere survival of bytes across a restart must never silently
> recreate expired credentials, tool scopes, approvals, context, or verification.

**Permanently rejected (do NOT build any of these):** "restart the last request"; resurrection
of old leases or approvals; treating "no response" as "no effect"; any claim of deterministic
provider replay. If your design does any of these, it is wrong.

---

## 0. What revoy2 ALREADY has (do not rebuild it — extend it)

- **Interruption as a typed outcome** (ADR-016): a campaign/node can reach `interrupted` /
  `recovery_required`. This already works. Read `packages/arbor-mcp/src/recovery-service.ts`
  (`RecoveryService`) and the interruption path in `manager.ts`.
- **Reconciliation-only restore**: on restart, `runtime.ts` reconstructs supervised task and
  operation state from durable facts and produces `recovery_required` — it does NOT replay
  provider/tool work. Read the reconciliation in `runtime.ts` (`reconcile*` fields, the
  "single-writer boundary" comments).
- **Fresh-authority redispatch** (ADR-012): `RecoveryService` prepares a fresh attempt (fresh
  lease, no manufactured critic/failure/verified provenance). Read its class doc — note the
  warning about a prior bespoke `redispatchRecoveredNode` that was removed for living outside
  the loop's authority. **You must extend the existing `RecoveryService`, not write a parallel
  path.**
- **Session lineage**: `packages/arbor-harness/src/native-session.ts` already models
  `SessionLineage` (a session can reference a prior session). A recovery session is a **new**
  session linked by lineage — the machinery for that link exists.
- **Write-ahead journal**: `packages/arbor-mcp/src/harness-session-journal.ts` durably records a
  redacted structural observation of each native session. This is your evidence source for
  "what had this interrupted session already done".

**Your job is the missing piece:** turn `recovery_required` into an *operator-authorized,
effect-classified continuation* rather than a dead end.

---

## 1. What "done" means (acceptance)

1. After an interruption, an operator can run a governed command (`arbor recover --campaign <id>
   [--node <id>]`) that presents, for each interrupted node: what it had done (from the journal),
   classified as observed-complete / observed-failed / safely-idempotent / compensatable /
   indeterminate, and what continuing would require (fresh admission of connector, credential,
   budget, worktree, policy).
2. Continuation, when authorized, creates a **new** session linked by lineage to the interrupted
   one; it re-runs admission for every authority (never reuses the old lease/approval/budget);
   it admits into the new session only provenance-bearing artifacts, decisions, open questions,
   and bounded summaries — never a raw transcript.
3. An **indeterminate** in-flight effect (a provider/tool request that may have applied) is
   **never** auto-continued: it stops for explicit operator or system-policy disposition.
   Automatic continuation is allowed **only** for operations independently proven idempotent and
   still within freshly-admitted authority.
4. Idempotency keys (where the provider/tool supports them) are recorded and the
   provider/tool acknowledgement is durably observed **before** an operation is treated as
   protected against duplication.
5. Crash-injection tests at every boundary (pre-dispatch, in-flight, post-effect, pre-settlement)
   prove: no duplicated effects; restart performs no provider/tool call before fresh admission;
   lineage + reconciliation are durable; indeterminate effects reliably stop.

Non-goals: hosted/remote recovery (local single-machine only); cross-machine handoff; automatic
(non-operator) continuation of anything not provably idempotent.

---

## 2. The effect classifier (the core new component)

For each interrupted operation, classify from durable evidence (journal + audit ledger + tool
action-scope records) into exactly one:
- **observed-complete** — a terminal success/verification record exists → nothing to redo; admit
  its result into the new session.
- **observed-failed** — a terminal failure record exists → treat as a normal failure; the new
  session may retry under fresh authority.
- **safely-idempotent** — the operation is read-only OR carries a provider/tool-acknowledged
  idempotency key AND its effect is by-construction repeatable (e.g. a `file.write` of a full
  file to a declared path is idempotent; a `file.patch` or a `shell.execute` is NOT). Only these
  may auto-continue.
- **compensatable** — a partial effect exists that can be explicitly reverted/superseded; requires
  operator authorization and records compensation evidence.
- **indeterminate** — a request was in-flight with no terminal record and no idempotency guarantee
  (the dangerous case: a provider call or a `shell.execute` that may or may not have run). MUST
  stop for governed disposition. Never guess.

Implement as a pure function over durable records → classification, with a closed union result
type. Test it exhaustively with fixtures for each class and the boundary crashes.

---

## 3. Files & seams

```
packages/arbor-mcp/src/recovery/
  effect-classifier.ts     # durable records -> closed-union classification (pure, exhaustively tested)
  continuation-plan.ts     # per-node: classification + required fresh admissions + admitted-context set
  recovery-command.ts      # the `arbor recover` CLI surface (present plan; apply on --authorize)
  contracts.ts             # closed catalogs, bounds
```
- Extend `RecoveryService` (recovery-service.ts) with a `prepareContinuation(campaign_id, node_id,
  authorization)` that: builds the continuation plan, runs fresh admission for each authority via
  the existing gates (admission/isolation/evidence/audit — do NOT bypass a gate; use the same
  `checkAdmission`/lease/budget paths the normal loop uses), links a new session by lineage, and
  admits the bounded provenance-bearing context. It must fail closed if any admission fails.
- The admitted context comes from `harness-session-journal.ts` (redacted structural facts) and the
  KB/audit projections — never from a raw transcript. If you cannot rebuild a needed fact from a
  provenance-bearing durable record, it does not enter the new session.
- CLI: add an `arbor recover` command in `cli.ts` mirroring the `arbor adopt` command's
  preview-then-apply, operator-authorized shape (see `result-adoption.ts` + the `adopt` handler
  for the pattern: default = present the plan and mutate nothing; `--authorize` = apply).

---

## 4. Gotchas (safety-critical)

- **"No response" ≠ "no effect".** The single most dangerous assumption. An in-flight provider or
  `shell.execute` request with no terminal record is *indeterminate*, not *failed*. Classify it
  indeterminate and stop. A test must prove a post-dispatch/pre-settlement crash yields
  indeterminate, never auto-continue.
- **Do not reuse identity across unrelated attempts, and do conflict on reuse with a different
  payload** (commandment XI). A recovery attempt has a fresh operation id linked by lineage;
  replaying the *same* identity returns the same semantic result; a different payload under the
  same identity is a typed conflict.
- **Every authority is re-admitted, individually.** Credentials, budget reservation, worktree
  lease, tool policy, approval policy, high-risk scope, model revision — each re-runs its gate.
  A surviving byte is not a surviving grant. There is no "resume with the old context" shortcut.
- **Interruption is not failure** (commandment VI). Do not write a failure-mode KB fact for an
  interrupted node; do not treat context overflow / cooperative cancellation as critic rejection.
- **Evidence precedes observability** (commandment II). The continuation's admission/evidence
  records are durable *before* the new session becomes observable or does any work. Inject a
  persistence failure at each boundary in tests; the new session must remain unobservable if a
  record failed to persist.
- **Extend the loop's authority, never a bespoke redispatch** — the removed
  `redispatchRecoveredNode` is a documented trap in `recovery-service.ts`. Your continuation runs
  through the same supervised `campaign.run` job authority (see roadmap on adopt / `runtime.ts`
  `runCampaignJob`), not a side channel.

---

## 5. Tests (crash injection is the whole point)

Happy-path tests are nearly worthless here. Write:
- Kill at each boundary (pre-dispatch, in-flight, post-effect, pre-settlement) → correct
  classification; no provider/tool call before fresh admission on restart.
- Idempotent op with acknowledged key → may auto-continue; same op without acknowledged key →
  indeterminate → stops.
- Each authority admission failure (expired credential, exhausted budget, missing worktree,
  revoked approval, changed model revision) → continuation fails closed, no work done.
- Duplicate `prepareContinuation` (same authorization) → same result, no double effect; different
  payload same identity → typed conflict.
- Persistence failure injected before each durable write → new session stays unobservable.
- No false failure/verified KB fact, event, or tree transition on an interrupted/recovered node.
- `npm run build`, `npx vitest run packages/arbor-mcp`, then full suite.

---

## 6. Feature-branch workflow

Same as roadmap 01 §10. Branch `feature/governed-crash-continuation`. Handoff note at
`docs/roadmaps/handoffs/governed-crash-continuation.md` — and in it, spell out explicitly, for
each of the five effect classes, exactly which durable records drive the classification and why
the indeterminate case can never be auto-continued. The integrator will hard-review the classifier
and the crash-injection tests before merge; that review is the safety gate for the whole feature.
Because this touches recovery authority, **write/reconcile an ADR** (supersede-or-extend ADR-012)
describing the continuation model before spreading implementation across packages — the repo
requires an ADR when authority/ordering/recovery semantics change.
