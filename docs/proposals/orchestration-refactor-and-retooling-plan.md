# Revoy2 orchestration refactor and re-tooling plan

**Status:** Proposed implementation program
**Date:** 2026-08-14
**Scope:** Native Revoy2 orchestration, model/session management, tool authority,
review, recovery, context, worktrees, and the operator contract
**Primary objective:** Increase task accuracy, completion rate, recovery quality,
latency, and token efficiency by moving hard controls to real effect boundaries and
removing restrictions that govern model cognition without preventing a concrete risk.

This is a corrective plan, not a claim that every proposed policy has already been
validated. It combines code inspection with the 2026-08-14 self-host dogfood runs.
Every policy change below must be promoted through paired evaluation; this document
does not authorize weakening a safety property merely because it appears expensive.

## 1. Executive decision

Revoy2 should adopt one governing rule:

> **Flexible cognition; strict effects; independent acceptance.**

Models may inspect, search, hypothesize, revise plans, retry tools, change tactics,
and challenge reviewers without pre-authorization. Revoy2 must enforce containment
and authority where an operation can actually cause harm or falsely claim success:
credential release, filesystem and process effects, network/external effects,
result adoption, governance mutation, and promotion to trunk.

The current system often applies the inverse shape. It is permissive at some host
boundaries it cannot enforce, but highly restrictive inside the reasoning loop. Exact
file and command declarations, mandatory stage progression, terminal treatment of
operational failures, critic vetoes, static budgets, and worktree assumptions can stop
a competent model without preventing a corresponding real-world threat. That is both
performance loss and security theatre.

The target is not an ungoverned agent. It is a small, enforceable safety kernel around
a resilient execution engine.

## 2. Evidence and confidence

### 2.1 Directly observed in live self-host runs

The following are operator-observed dogfood findings. They are not benchmark results:

1. A missing `high_risk_tool_scope` caused an implementation task to execute as an
   effectively read-only session instead of producing a preflight error or requesting
   usable authority.
2. Worktrees created from committed `HEAD` did not contain adopted but uncommitted
   changes visible in the operator checkout.
3. A critic approved a read-only plan as if implementation had completed.
4. A critic rejected a valid corrective patch by restating the pre-patch defect.
5. A critic attempted to supersede an operator clarification that had already answered
   the disputed question.
6. A critic transport failure caused completed specialist work to be recorded as node
   failure rather than a durable candidate awaiting review.
7. A verification/evidence worktree lacked `node_modules`; a determinism refresh then
   recorded a broad false failure surface while its outer command still exited zero.
8. Temporary out-of-scope writes were not prevented at the syscall boundary; model
   self-correction reverted them. This shows that some elaborate policy machinery was
   less effective than its presentation implied.
9. Specialist and critic sessions replayed substantial context and repeated tool loops.
   Individual successful phases consumed tens of thousands of output tokens and
   millions of cache-read tokens. This is not an efficient steady state.

### 2.2 Confirmed architectural contributors

The code supplies concrete mechanisms for those outcomes:

- `packages/arbor-opencode/src/loop.ts` is a large sequential coordinator. Isolation
  rejection, enforced retry advice, specialist operational errors, critic operational
  errors, and substantive rejection all reach failure-shaped paths.
- A critic transport error calls `recordClassifiedError` with the already-produced
  specialist result and increments `report.failed`; there is no durable
  `candidate_awaiting_review` state.
- Retry-context load and save are defensive best-effort operations. Failures are
  swallowed, so the system can silently regress to broad-context retry behavior.
- The retry decision compares a stored failure fingerprint with itself and hard-codes
  `hasNewEvidence: false`; it cannot accurately recognize all material progress at the
  point where it advises suppression.
- `CampaignManager.deriveNativeHighRiskToolScope` returns `null` when a plan omitted an
  exact declaration. Native high-risk tools then refuse execution. This is safe in the
  narrow sense, but the task is admitted and a costly model session is still allowed to
  discover the omission through tool failure.
- Native write scope is an exact list of paths and command scope is an exact list of
  argv vectors. A planner must predict implementation details before repository
  discovery has occurred.
- Native session context uses UTF-8 bytes as a conservative token count and rejects an
  oversized single entry. The comments themselves identify structural folding as a
  deeper follow-up.
- Session and campaign token budgets can deny dispatch prospectively. Although useful
  as opt-in resource controls, they are too uncertain to be the default product
  workflow.
- Worktree creation is based on a Git revision. Uncommitted composition-root state has
  no automatic, explicit materialization contract.
- ADR-024 correctly says that Revoy2 cannot enforce raw tool calls executed inside an
  external harness. Any UI or ledger language implying otherwise is an overclaim.

### 2.3 Existing strengths to preserve

This refactor must retain the parts that create real leverage:

- provenance-typed evidence and the rule that only `!verified` evidence can mark a
  result verified;
- independent proposal and acceptance authority for consequential promotion;
- append-only evidence and durable recovery records;
- workspace containment and explicit result adoption;
- credential leases that do not serialize secret values into prompts or config;
- structured provider/session contracts and typed operational errors;
- deterministic verification where a real command and relevant output exist;
- fail-closed handling of unknown external effects after crashes;
- content-addressed repository retrieval and bounded output capture.

## 3. Problem statement: where control has become counterproductive

### 3.1 Governance is attached to stages instead of consequences

The loop assumes a mostly fixed sequence:

`select → isolate → specialize → critic → record → branch/backtrack`

This makes each stage look authoritative. In practice, selection is a scheduling choice,
isolation is a containment mechanism, the specialist produces a candidate, a critic
produces an opinion, deterministic checks produce evidence, and adoption changes the
operator's repository. These are different kinds of facts. Collapsing them into one
linear success/failure pipeline lets a weak or unavailable stage destroy stronger facts.

### 3.2 Plans are being used as permission manifests

A plan can responsibly state intent, constraints, risk, and acceptance conditions. It
usually cannot predict every file and exact command an implementation will need before
the agent examines the repository. Requiring that prediction rewards shallow plans,
penalizes discovery, and converts harmless implementation variation into denial.

### 3.3 Review authority exceeds reviewer evidence

The critic is prompted to be approval-biased, but its boolean still determines the
candidate's path. A critic may lack the worktree, command output, operator conversation,
or up-to-date diff needed to justify a blocker. A natural-language veto is therefore
stronger than its epistemic basis.

### 3.4 Operational failures are mistaken for task judgments

Provider transport failure, timeouts, missing dependencies, unavailable review, invalid
tool input, and genuine implementation defects require different recovery. Treating all
of them as node failure corrupts scoring, teaches the KB the wrong lesson, wastes
completed artifacts, and causes retries to repeat unchanged work.

### 3.5 Safety claims exceed enforcement

Some controls genuinely prevent effects: canonical path checks, broker routing, runtime
catalog authorization, credential isolation, and merge-critical tests. Others merely
record a claim, depend on model compliance, or rely on an external host. Presenting the
latter with the same visual and architectural weight creates security theatre while
making the product harder to use.

### 3.6 Search is over-applied

Tree search is useful for ambiguous strategies and competing hypotheses. It is overhead
for a well-scoped edit with a known verification command. Using UCT, decomposition,
specialist review, and critic backpropagation for every task turns a capability into a
tax.

## 4. Target architecture

### 4.1 Separate five planes

| Plane | Responsibility | May block cognition? | May block an effect? |
|---|---|---:|---:|
| Cognition | Search, read, reason, plan, ask, compare, revise | No, except physical context/provider limits | No |
| Execution | Worktree-local file/process operations | Only when the requested effect cannot be contained | Yes |
| Evidence | Capture artifacts, diffs, commands, outputs, provenance | No; unavailable evidence changes state | It may prevent a verification claim |
| Review | Challenge claims, identify missing evidence, recommend disposition | No terminal veto without a supported blocker | It may require evidence before adoption under policy |
| Acceptance | Adopt result, mutate governance, merge/promote, release credentials/external effects | N/A | Yes, with independent authority where risk warrants |

The package architecture should reflect these planes. `@arbor/opencode` may retain a
connector temporarily, but the Revoy-owned orchestration state machine belongs in a
neutral package or neutral modules with connector adapters at the edge.

### 4.2 Replace the monolithic loop with a resumable reducer

Introduce a pure `OrchestrationReducer` over durable events and a thin effect runner.
The reducer returns one of a small number of next intents; it never directly invokes a
model, tool, worktree, ledger, or critic.

Suggested durable states:

```text
pending
  → preparing_workspace
  → executing
  → candidate_ready
  → verifying | awaiting_evidence
  → awaiting_review | review_challenged
  → accepted
  → adoptable
  → adopted

Any nonterminal state may become:
  awaiting_operator | interrupted | recoverable_error

Only supported task judgments become:
  rejected | exhausted
```

Key separation:

- `AttemptResult` records what a specialist actually produced.
- `VerificationResult` records which claims a deterministic check covers.
- `ReviewFinding[]` records critic claims and evidence references.
- `AcceptanceDecision` determines whether policy permits adoption.
- `NodeOutcome` summarizes the final disposition only after those facts exist.

Every completed phase is committed before the next dispatch. A crash or downstream
transport failure can therefore resume from the last durable fact instead of rerunning
the phase.

### 4.3 Use an effect-oriented authority model

Replace exact plan-time file/argv enumeration as the ordinary path with layered runtime
authority:

1. **Workspace lease:** permits ordinary create/modify/delete operations strictly inside
   one disposable worktree. It is issued from campaign/node/worktree identity, not model
   text. Path escape, symlink escape, sensitive-file policy, and cross-worktree access
   remain hard denials.
2. **Process profile:** permits a reviewed class of local commands inside the workspace,
   such as repository-declared build/test/lint scripts. The executed argv and effect are
   audited. Exact argv predeclaration remains available for high-assurance workflows but
   is not the default development mode.
3. **Elevated effect lease:** required for network access, credentials, external services,
   host-level paths, destructive Git operations, package publication, deployment, or any
   non-idempotent effect outside the disposable workspace.
4. **Adoption lease:** required to apply a captured result to the operator checkout.
5. **Promotion authority:** independent of the implementing model for trunk merge,
   governance acceptance, release, or other configured high-impact transitions.

The trusted host derives the requested effect from the actual tool call. The model may
describe intent, but its prose or generated provenance never grants authority.

### 4.4 Make risk adaptive and observable

Use a closed `EffectClass`, for example:

```text
observe
workspace_reversible
workspace_destructive
external_idempotent
external_non_idempotent
secret_bearing
adoption
promotion
```

Policy maps effect class plus confinement grade to `allow`, `ask`, or `deny`. This is a
host decision at dispatch time. The operator can inspect the resolved policy and the
reason for a decision. A missing policy is a preflight/configuration error, not an LLM
failure and not a critic rejection.

### 4.5 Make review evidence-scoped

Replace the critic boolean as the universal task oracle with structured findings:

```ts
type ReviewFinding = {
  claim: string;
  severity: "note" | "warning" | "blocker";
  scope: "requirement" | "regression" | "safety" | "evidence";
  evidence_refs: string[];
  reproducible_check?: string;
  confidence: number;
};
```

A blocking finding is admissible only when it identifies the violated acceptance
condition and points to current evidence or a reproducible check. Unsupported objections
are challenges, not vetoes. The specialist receives a bounded rebuttal opportunity when
the diff or evidence materially contradicts the finding.

The precedence order is:

1. explicit operator decision within its scope;
2. deterministic evidence relevant to the claim;
3. current repository/diff/tool evidence;
4. independent reviewer finding;
5. model assertion.

A critic cannot overwrite an operator answer. It can identify a new, distinct risk and
ask for confirmation.

### 4.6 Make verification proportional

Verification policy should select the cheapest sufficient oracle:

- documentation-only changes: path/content/policy checks, optionally no LLM critic;
- localized code edits: targeted tests plus diff inspection;
- cross-package/runtime changes: build, affected suites, integration checks;
- security/governance changes: merge-critical properties plus independent review;
- external/destructive actions: explicit operator acceptance and effect evidence.

Deterministic verification can accept a low-risk candidate without a second model
opinion because the verifier is not the proposing agent. High-risk policy may still
require independent model or human review. “Every action gets a critic” is replaced by
“every adoption gets sufficient evidence for its risk.”

### 4.7 Select the orchestration strategy, not only the model tier

Add an `ExecutionModePolicy` that chooses among:

- `direct`: one agent, bounded worktree, verify, adopt;
- `plan_execute`: short plan followed by sequential/DAG execution;
- `tree_search`: competing hypotheses or uncertain solution strategies;
- `investigate`: read-only evidence gathering with no implied implementation;
- `repair`: resume from a durable candidate, failed verification, or interrupted effect.

Selection uses task ambiguity, blast radius, verification availability, prior failed
attempts, and operator intent. The mode can escalate from direct to plan/tree when new
uncertainty appears. It should not escalate merely because a generic stage failed.

Tree branches should represent materially different hypotheses or implementations, not
routine sequential steps. Dependencies belong in the durable action DAG.

## 5. Workstreams

### W0 — Establish the baseline before changing policy

Build a versioned dogfood/evaluation corpus from real tasks, including the failures in
§2.1. For every run capture:

- verified task completion and independently adjudicated correctness;
- false acceptance and false rejection;
- wall-clock time to first useful candidate and to adoptable result;
- model calls, turns, input/output/cache tokens by phase and agent;
- tool calls, refusals, corrected tool inputs, repeated reads, and repeated failure
  fingerprints;
- amount of specialist work preserved across review/provider failures;
- operator interventions and approval prompts;
- worktree setup and verification failures attributable to the harness.

No optimization is promoted from fixtures alone. Use paired tasks, the same model and
environment, and a sealed held-out cohort as already required by
`docs/token-economy-architecture.md`.

### W1 — Durable candidate and phase state

1. Persist `AttemptResult` immediately after specialist completion.
2. Add `candidate_ready`, `awaiting_review`, and `recoverable_error` projections without
   immediately changing old final node states.
3. Persist critic dispatch separately from critic outcome.
4. On critic transport failure, retain the candidate and retry/re-route review; never
   score it as implementation failure.
5. Make retry capsules required when retry policy depends on them. If persistence fails,
   surface `degraded_recovery` rather than silently acting as if no prior state exists.
6. Add idempotent phase keys so a restarted manager cannot duplicate completed provider
   or tool effects.

Primary files: `packages/arbor-opencode/src/loop.ts`,
`packages/arbor-core/src/types.ts`, `packages/arbor-core/src/persist.ts`,
`packages/arbor-mcp/src/manager.ts`, and recovery/audit ports.

### W2 — Extract the reducer and effect runner

1. Characterize the existing loop with event-sequence tests.
2. Extract pure selection, transition, review-disposition, and stop-policy reducers.
3. Define typed intents such as `PrepareWorkspace`, `DispatchSpecialist`, `RunChecks`,
   `DispatchReviewer`, `RequestOperator`, `CaptureCandidate`, and `AdoptResult`.
4. Implement a supervisor that executes one intent, writes its result, then asks the
   reducer for the next intent.
5. Keep the existing loop behind a compatibility switch until paired replay produces
   equivalent durable outcomes for supported cases.
6. Move connector-specific execution behind ports; the native engine becomes the
   reference adapter and OpenCode becomes a plugin adapter rather than the owner of the
   orchestration loop.

This work reduces `loop.ts` from policy nexus to compatibility façade. It also makes
phase-level retry and testing possible without constructing a whole campaign.

### W3 — Replace plan-time micro-permissions

1. Add `EffectClass` and an inspectable policy resolver.
2. Issue a default reversible-workspace lease for implementation campaigns.
3. Keep exact path restrictions for explicit narrow roles such as documentation-only
   agents and user-selected high-assurance mode.
4. Discover repository-owned verification commands from package/task configuration;
   do not require the planner to predict the final argv.
5. Return actionable preflight states before model dispatch when a requested execution
   mode has no usable authority.
6. Give a running model one ordinary correction turn for malformed or denied tool input
   when the denial is recoverable.
7. Keep arbitrary shell/network unavailable by default until a broker can enforce the
   stated confinement. Offer a clearly labeled operator opt-in rather than implying the
   current application checks are an OS sandbox.

### W4 — Rebuild critic and acceptance semantics

1. Persist structured `ReviewFinding[]`; retain raw reviewer output only as bounded
   evidence.
2. Require blocker-to-acceptance-condition and blocker-to-evidence links.
3. Add `accept`, `request_evidence`, `challenge`, and `block` dispositions; remove forced
   binary judgment under missing evidence.
4. Add a bounded rebuttal/second-look path using only the disputed diff, evidence, and
   finding—not the full transcript.
5. Prevent any reviewer from changing or reinterpreting a resolved operator answer.
6. Route reviewer conflicts by evidence strength; do not solve them with more majority
   voting by default.
7. Make model review optional for low-risk, deterministically verified changes.
8. Keep independent acceptance mandatory for configured promotion and governance risks.

### W5 — Recovery as continuation, not repetition

1. Classify failure by phase and cause: `tool_input`, `tool_policy`, `workspace`,
   `provider_transport`, `provider_quota`, `timeout_with_progress`,
   `timeout_without_progress`, `verification`, `review`, `adoption`, or `internal`.
2. Store the last completed phase, candidate digest, worktree digest, changed paths,
   tool outcomes, unresolved requirements, and provider/session checkpoint.
3. Resume from that phase. Never rerun specialist work solely because review failed.
4. Treat a tool schema/path mistake as feedback to the active session before consuming a
   campaign retry.
5. Use progress-aware timeouts. A session producing novel evidence or a candidate may
   checkpoint and continue; a repeated no-progress fingerprint may stop or decompose.
6. Replace retry logic's hard-coded `hasNewEvidence: false` with facts derived from the
   durable candidate, verification, tool, and worktree records.
7. Do not write operational failures into the failure-pattern KB as if they established
   a task-level causal lesson.

### W6 — Context and token economics

1. Make resource budgets opt-in limits, not default task semantics. Keep physical model
   context ceilings and operator-configured hard spend ceilings.
2. Replace broad transcript replay with phase-specific context manifests:
   stable task/constraints, current candidate diff, unresolved requirements, selected
   repository neighborhood, operator decisions, and evidence references.
3. Persist a content-addressed repository summary and invalidate it by Git tree/diff
   digest rather than rebuilding it per agent.
4. Feed critics the candidate, acceptance conditions, and verification evidence—not the
   specialist's complete reasoning history.
5. Feed retries the changed facts and failed checks—not the previous prompt.
6. Structurally fold oversized tool results; retain raw evidence outside model context.
7. Preserve provider-stable prefixes and measure cache writes/reads without treating
   cached tokens as free.
8. Add early termination for repeated identical tool failures, but offer a concrete
   alternate action before stopping.
9. Report token economy as efficiency telemetry. Do not place a predictive token budget
   ornament in the default cockpit or make uncertain estimates a normal denial reason.

### W7 — Worktree materialization and environment reliability

1. Define `WorkspaceBase` as an explicit immutable object: source revision, dirty-state
   policy, overlay digest, submodule state, and dependency/environment profile.
2. Before campaign admission, tell the operator whether the run uses committed `HEAD`, a
   captured dirty overlay, or an explicitly chosen revision.
3. Support a safe captured-overlay mode that materializes intended uncommitted changes
   into the isolated worktree without committing or copying secrets.
4. Add a governed, repository-owned bootstrap hook for dependencies. Its effect scope is
   auditable and separate from harness source; missing dependencies become
   `workspace_not_ready`, not test failure.
5. Run a preflight probe for package manager, required binaries, and declared verification
   commands before expensive model dispatch.
6. Capture candidate patches before cleanup and preserve them across all downstream
   failures.
7. Verify against the same materialized base and dependency profile used by the
   specialist.

### W8 — Operator and model error ergonomics

Every denial or pause should carry:

- a stable code;
- the failed boundary and effect class;
- whether the condition is recoverable;
- who can resolve it—model, harness, operator, or administrator;
- the exact next action;
- which completed work was preserved.

Preflight errors must occur before a provider call when they are locally knowable.
Tool-call errors should be returned in a compact machine-readable form the model can
correct. TUI status should distinguish `working`, `needs tool correction`, `needs
workspace`, `awaiting evidence`, `awaiting review`, `needs operator`, and `adoptable`.

### W9 — Remove or demote security theatre

Audit every control and assign one strength:

- **enforced:** a trusted component prevents the effect;
- **detected:** an independent observer can reliably detect the violation;
- **recorded:** the system stores a claim or decision but does not enforce it;
- **advisory:** prompt or policy guidance only;
- **absent:** no control.

Then apply these rules:

1. Never display `recorded` or `advisory` as “protected.”
2. Delete duplicate gates that restate a stronger downstream boundary without adding
   detection or recovery value.
3. Convert locally unknowable preconditions from fail-closed booleans into
   `indeterminate` plus bounded evidence acquisition.
4. Do not treat generated intent provenance as permission. Authority comes from the
   host policy and lease.
5. Do not claim external-harness tool safety beyond the harness's attested capability.
6. Do not call application-level path validation an OS sandbox. Report its actual
   confinement grade.
7. Keep checks-and-balances at acceptance/promotion boundaries; remove role separation
   where it merely prevents a model from correcting its own draft.
8. Expire compatibility controls and unused approval machinery instead of keeping them
   for aesthetic completeness.

### W10 — Adaptive orchestration and tree-search correction

1. Build a transparent mode classifier with an operator override.
2. Default simple repository changes to `direct`; do not invoke UCT merely because the
   harness supports it.
3. Use `plan_execute` for dependency-ordered tasks and reserve `tree_search` for genuine
   alternatives or uncertain diagnoses.
4. Make decomposition respond to observed complexity and lack of progress, not only a
   timeout class.
5. Score branches on verified progress, evidence gained, remaining uncertainty, and
   marginal cost. Do not penalize provider transport or workspace setup as solution
   quality.
6. Stop when acceptance conditions are satisfied and the result is adoptable. Do not
   continue searching to exhaust a budget or iteration count.

## 6. Safety kernel: keep, change, remove

| Control | Disposition | Reason |
|---|---|---|
| Canonical workspace/path containment | Keep hard | Prevents a real filesystem effect |
| Sensitive-file and secret redaction | Keep hard | Prevents credential disclosure |
| Credential leases scoped to a session | Keep hard | Enforceable secret boundary |
| Network/external/destructive effect approval | Keep hard | Consequences escape disposable workspace |
| Candidate capture before cleanup | Strengthen | Prevents loss of completed work |
| Independent trunk/governance promotion | Keep hard | Real checks-and-balances boundary |
| Evidence required for `!verified` | Keep, improve coverage semantics | Prevents unsupported completion claims |
| Exact file list for ordinary implementation | Replace with worktree lease | Premature detail prediction hobbles discovery |
| Exact argv list for ordinary verification | Replace with process profiles | Brittle and often unknowable before execution |
| Mandatory critic for every result | Make risk-based | Costly and not reliably stronger than deterministic evidence |
| Critic boolean as terminal oracle | Replace | Opinion must not erase stronger evidence |
| Default predictive token budgets | Disable | Estimates are uncertain; retain opt-in spend limits |
| Fixed global iteration/turn behavior | Make adaptive | Progress and task type matter more than a universal count |
| External-host permissions presented as Revoy enforcement | Relabel honestly | Revoy is not the host enforcement point |
| Prompt-only restrictions presented as security | Demote to advisory | They guide behavior but do not prevent effects |

## 7. Migration sequence

### Phase A — Observe and stop losing work

**Goal:** No completed specialist candidate is discarded by a later phase.

- Land W0 instrumentation.
- Persist candidates and phase state from W1.
- Change critic transport failure to `awaiting_review`.
- Surface preflight authority/workspace failures before provider dispatch.
- Add regression scenarios for every §2.1 incident.

Exit criteria:

- 100% of completed synthetic and live candidate artifacts remain retrievable after
  critic failure, process restart, and cleanup failure.
- Operational failures do not change solution-quality calibration.
- No provider call occurs for a locally detectable missing-workspace or missing-authority
  preflight.

### Phase B — Move authority to effects

**Goal:** A normal implementation can discover and edit safely without a clairvoyant plan.

- Land effect classes, workspace leases, process profiles, and preflight projection.
- Keep the current exact-scope mode as `high_assurance_exact` during migration.
- Add captured dirty-overlay worktrees and dependency preflight.
- Update operator documentation and TUI labels to report actual enforcement strength.

Exit criteria:

- The live corpus completes ordinary worktree-local edits without plan-time path/argv
  enumeration.
- Path escape, sensitive-file access, unauthorized network, and cross-worktree effects
  remain blocked in adversarial tests.
- No control is labeled stronger than its tested enforcement grade.

### Phase C — Replace critic veto and retry repetition

**Goal:** Review improves accuracy without becoming a single point of failure.

- Land structured findings, evidence-scoped blockers, rebuttal, and proportional review.
- Resume from candidates on review failure.
- Land phase-specific context manifests and durable retry facts.

Exit criteria:

- Critic transport failure adds no specialist rerun.
- A stale critic cannot block when current deterministic evidence disproves its stated
  blocker.
- Operator answers are immutable inputs within their declared scope.
- Retry input excludes prior transcript bulk and contains the material delta.

### Phase D — Introduce the reducer and adaptive modes

**Goal:** Make orchestration resumable, testable, and proportional to the task.

- Land W2 behind an experimental switch.
- Replay the same durable event fixtures through old and new paths.
- Land execution-mode selection and direct/plan/tree escalation.
- Move connector-specific code behind neutral session/effect ports.

Exit criteria:

- Crash recovery resumes at every phase boundary without duplicate non-idempotent effect.
- Direct tasks do not allocate tree-search or critic overhead unless policy escalates.
- The native path no longer imports orchestration ownership from `@arbor/opencode`.

### Phase E — Default cutover and deletion

**Goal:** Make the simpler system the only production path.

- Run paired held-out evaluation.
- Promote only after accuracy and safety criteria pass.
- Remove the monolithic compatibility loop, obsolete exact-scope default, redundant
  gates, stale config, and unused approval/reporting machinery.
- Write or amend ADRs for changed accepted decisions; do not rewrite historical rationale.

## 8. Evaluation and promotion criteria

First record a baseline. The numeric targets below are initial promotion thresholds, not
claims about current performance:

| Dimension | Required result |
|---|---|
| Correct completion | Non-inferior lower confidence bound on held-out task success |
| False acceptance | No statistically supported increase; zero tolerated on designated critical fixtures |
| False rejection | At least 50% reduction on the curated stale/unsupported-critic cohort |
| Candidate preservation | 100% across injected critic/provider/process failures after specialist completion |
| Effective input tokens | At least 35% median reduction on retrying tasks |
| Total model calls | At least 25% median reduction on direct and repair tasks |
| Time to adoptable result | At least 25% median reduction without accuracy loss |
| Repeated identical tool failures | At least 80% reduction |
| Locally knowable preflight failures | 100% detected before model dispatch |
| Workspace escape / secret / unauthorized external effect | Zero successes in adversarial suite |
| Crash duplicate external effects | Zero; indeterminate effects require reconciliation |

Report results by task mode and risk class. A global average must not hide a regression in
security-sensitive or long-horizon tasks. Token savings never compensate for degraded
correctness.

## 9. Test architecture

Add four complementary suites:

1. **Reducer model tests:** generate event sequences and assert invariants such as “a
   candidate cannot disappear” and “an effect result is applied at most once.”
2. **Fault-injection tests:** kill or fail every boundary before dispatch, during dispatch,
   after effect, after candidate capture, during verification, and during review.
3. **Adversarial authority tests:** path traversal, symlink escape, secret reads, command
   profile escape, network attempts, stale leases, cross-session reuse, and external
   effect replay.
4. **Behavioral dogfood evals:** real repositories and models, sealed task expectations,
   phase/token metrics, and independent outcome adjudication.

Do not use model self-report as the oracle for any of these suites. Do not make live model
evals a hermetic PR gate; run them as explicit scheduled/manual promotion evidence.

## 10. API and type changes

Proposed additive contracts, refined during implementation:

```ts
type OrchestrationIntent =
  | { kind: "workspace.prepare"; node_id: string }
  | { kind: "specialist.dispatch"; node_id: string; context_manifest_id: string }
  | { kind: "candidate.capture"; node_id: string; attempt_id: string }
  | { kind: "verification.run"; candidate_id: string; profile_id: string }
  | { kind: "review.dispatch"; candidate_id: string; evidence_bundle_id: string }
  | { kind: "operator.request"; request_id: string }
  | { kind: "result.adopt"; candidate_id: string; lease_id: string };

type PhaseDisposition =
  | "completed"
  | "recoverable_error"
  | "awaiting_evidence"
  | "awaiting_review"
  | "awaiting_operator"
  | "rejected";

type EffectDecision = {
  effect_class: EffectClass;
  decision: "allow" | "ask" | "deny";
  enforcement: "host" | "broker" | "external_harness";
  confinement_grade: string;
  reason_code: string;
};
```

Compatibility readers may project these into the existing `NodeState` and
`CampaignReport` initially. New runtime code must consume the structured forms, not parse
their rendered explanations.

## 11. ADR impact

Implementation will require a decision audit, not silent drift:

- **ADR-006 / ADR-009:** clarify that gates and tree search are policies selected at
  consequence/uncertainty boundaries, not mandatory stages for every task.
- **ADR-015 / ADR-051:** retain measurement and opt-in hard ceilings while removing
  predictive budgets from default task authority.
- **ADR-019:** establish operator-answer precedence and distinguish blocking lead input
  from reviewer challenge.
- **ADR-023:** preserve no-rollback reasoning, but add explicit dirty-overlay
  materialization and candidate preservation.
- **ADR-024 / ADR-028 / ADR-044:** retain honest host boundaries and confinement grades;
  replace plan-time micro-permissions with effect-time leases where enforcement exists.
- **ADR-043:** extend crash continuation from operation reconciliation to phase/candidate
  continuation.
- **ADR-046 / ADR-050:** expand strategy selection from stop/model depth into
  direct/plan/tree/investigate/repair modes.
- **ADR-058 / ADR-059:** keep merge-critical and independent acceptance boundaries.

Any accepted ADR whose decision changes must be superseded or amended through the
repository's separate acceptance process. This proposal itself holds no acceptance
authority.

## 12. Explicit non-goals

- Removing provenance typing or allowing unverified output to masquerade as verified.
- Letting a model self-authorize credentials, network, external effects, adoption, or
  promotion.
- Building a second fake OS sandbox in TypeScript.
- Making every operational detail part of an immutable plan.
- Replacing deterministic verification with critic consensus.
- Using token reduction as permission to lower task quality.
- Preserving OpenCode as an orchestration dependency; it is a migration adapter only.
- Adding more agent roles, gates, or ledgers unless a measured failure cannot be solved by
  simplifying an existing boundary.

## 13. Immediate tranche

The first implementation tranche should be deliberately narrow:

1. Add durable `CandidateArtifact` and `ReviewStatus` records.
2. Capture the specialist result before critic dispatch.
3. On critic error, transition to `awaiting_review` and retry review from the candidate.
4. Add a preflight projection for workspace readiness and effective tool authority.
5. Turn missing implementation authority into a pre-dispatch actionable error.
6. Add the §2.1 regression scenarios and phase/token measurements.
7. Run the paired corpus before changing critic or permission defaults.

This tranche fixes irreversible information loss and makes later policy decisions
measurable. It does not require replacing the entire loop first.

## 14. Definition of done

The program is complete when a developer can submit a normal repository task and Revoy2:

1. selects a proportional execution mode;
2. materializes the repository state the operator intended;
3. gives the model enough worktree-local freedom to discover and implement;
4. blocks only effects the trusted host can identify and policy does not authorize;
5. preserves every completed candidate through failures and restarts;
6. verifies claims with evidence appropriate to their risk;
7. treats critics as evidence-producing reviewers, not infallible task oracles;
8. resumes from compact structured state rather than replaying the campaign;
9. presents enforcement strength honestly in CLI/TUI diagnostics;
10. produces a measurably more accurate, faster, and token-efficient held-out result
    without weakening containment, secret handling, external-effect control, or
    independent promotion.
