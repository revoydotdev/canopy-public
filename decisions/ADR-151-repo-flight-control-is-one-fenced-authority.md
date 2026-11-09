# ADR-151: Repository Flight Control Is One Fenced Authority

**Status:** Accepted
**Date:** 2026-08-28
**Authoring Revision:** da54f4d537bd92b67ec79fa750503eb774a45750
**Content ID:** sha256:079c78134a3b3ebd8a7948302a3cd8984d6ed05156a092c45af7cb039283b014

## Context

Revoy2 already ships durable agent communication, worktree leases, writer
locks, approval separation, evidence transactions, distributed fencing and
result-adoption transactions. They are individually useful but no durable
repository-run authority joins them. Ordinary Claude, Codex, OpenCode and
native sessions can therefore share a checkout without a common identity or
permission boundary; Git operations, cleanup and verification can race even
while each subsystem behaves correctly in isolation.

The defect is evidenced by the 2026-08-27/28 repository history: a live
campaign observed HEAD move beneath sibling worktrees; unexplained payloads
were repeatedly preserved in collision stashes; a cleanup pass preserved more
than twenty worktrees immediately before removing them; and repository evidence
producers wrote the canonical checkout while other sessions were active. Git
preserved bytes but could not identify the owning provider/session or prove
that the cleanup actor held authority over each target.

An instruction telling agents to coordinate is not enforcement. A language
model can interpret state and negotiate with peers, but it cannot be the
mechanism that makes a stale process unable to write. The product promise of
governed, reliable work requires a deterministic authority beneath every
governed provider adapter.

## Decision

**One repository-scoped Flight Director is the authority for admitted agentic
work.** It is a deterministic service with a durable, replayable reducer. An
agentic operator may inspect its projections, communicate, propose recovery and
request human decisions, but holds no implicit bypass key.

1. **One repository-run lifecycle.** Every admitted operation receives an
   immutable `repo_run_id`. Append-first transitions bind canonical repository,
   base/candidate/tree identity, operation/correlation, provider session,
   process instance, worktree, lease/fence, gate plan, evidence, approval and
   adoption references. Cross-store services remain the owners of their domain
   records, while the Flight Director owns their causal composition and
   recovery disposition.
2. **Process identity is stronger than PID.** An enrolled instance binds
   provider and Revoy session identities to canonical repository/common Git
   directory, worktree, PID, process-start identity and host-boot identity.
   Heartbeat loss alone never proves death; PID reuse or an ambiguous process
   identity cannot inherit authority.
3. **Effects require scoped clearance and a current fence.** A clearance is
   bound to one holder/principal chain, repository, operation classes, exact
   resources, candidate identity, policy version, expiry and use bound. Each
   resource has a monotonically increasing fencing epoch and resource version.
   Every protected effect revalidates the clearance and current fence
   immediately before mutation or publication. TTL is liveness, not effect
   safety.
4. **Concurrency is resource-aware.** Disjoint path writes and immutable
   snapshot checks may run concurrently. Overlapping paths and repository-global
   Git/index/ref/stash/worktree-administration or evidence-publication resources
   conflict. Multi-resource grants are all-or-none in canonical order; partial
   holds are never exposed to a caller.
5. **Verification has two explicit modes.** `snapshot` runs read-only checks in
   an immutable detached candidate and binds results to that digest.
   `quiescent` drains affected mutators through durable instructions and
   acknowledgements, prevents new conflicting grants, verifies repository
   identity, then grants the gate hold. An ambiguous or unresponsive session is
   a named blocker, never inferred quiescence.
6. **Communication remains one mechanism.** ADR-083's ledger bus stays the
   canonical agent conversation evidence. Flight control adds a delivery/apply
   receipt joining a message and thread version to a target instance, repo run
   and operation attempt; acknowledgement never implies application or
   completion. Remote delivery may adapt the existing distributed inbox rather
   than introduce a second semantic bus.
7. **Approval closes over the effect.** High-risk approval binds the exact
   repo run, canonical effect digest, candidate, fence, actor assurance and
   policy version, remains non-self-approved, and is consumed according to its
   declared bound. State and policy are revalidated at effect/adoption time.
8. **Deployment truth is explicit.** A runtime reports `enforced`,
   `cooperative`, `observed_only` or `degraded`. Raw unmanaged shells or missing
   provider interception prevent an `enforced` claim. The first authority is
   repository-local; the existing distributed control plane may later federate
   bounded projections and grants across repositories without acquiring an
   ambient organization-wide mutation key.

## Consequences

Every accepted mutation, gate, cleanup and adoption gains one mechanical answer
to who authorized it, for which repository state, with which current fence.
Paused workers, PID reuse, stale approvals and replayed delivery cannot publish
merely because their old TTL or message still exists. Gates can run concurrently
on immutable snapshots without treating a moving shared checkout as evidence.

The cost is a permanent local service, durable state migration, provider launch
adapters, effect interception, resource compatibility policy, renewal and
recovery, and fault tests across process boundaries. Some work will stop as
`ambiguous` rather than guessing. Unmanaged tools remain outside the prevention
boundary and must make the product report degraded until the shared checkout is
mechanically protected or those tools are enrolled.

## Alternatives / Roads not taken

1. **An LLM flight controller with advisory messages.** Rejected because the
   recent incidents occurred in a repository that already had strong written
   rules. Prose cannot fence a stale process.
2. **One repository-wide mutex.** Rejected because it serializes independent
   reasoning, worktrees and read-only verification. Claims are resource-scoped;
   repository-global serialization is reserved for genuinely global effects.
3. **PID plus heartbeat leases.** Rejected because PIDs are reused and a paused
   holder can resume after expiry. Process-start identity plus monotonic effect
   fencing is required.
4. **Git hooks and aliases as the authority.** Rejected as sole enforcement:
   they do not cover raw filesystem writes, every Git plumbing command, or
   provider tool implementations, and can be bypassed. They remain useful
   admission diagnostics around the kernel.
5. **A new flight-control mailbox.** Rejected because ADR-083 already decided
   that communication is one ledger mechanism. Flight control adds causal
   delivery/application receipts rather than a parallel transcript.
6. **Make distributed control the first deployment root.** Rejected for initial
   rollout. Repository-local authority must remain available offline and be the
   failure-containment unit; federation is an adapter above it.

## Obligations

### O1 — Repository-run state replays deterministically and admits only closed transitions

<!-- proof: symbol=reduceRepoFlightEvent file=packages/arbor-mcp/src/repo-flight-reducer.ts roundtrip=packages/arbor-mcp/tests/repo-flight-lifecycle.test.ts -->

### O2 — A stale, expired, paused or PID-reused holder cannot perform a protected effect

<!-- proof: symbol=RepoFlightAuthority file=packages/arbor-mcp/src/repo-flight-authority.ts roundtrip=packages/arbor-mcp/tests/repo-flight-faults.test.ts -->

### O3 — Gate results bind an immutable candidate and quiescent gates cannot overlap an unacknowledged mutator

<!-- proof: symbol=RepoFlightGateCoordinator file=packages/arbor-mcp/src/repo-flight-gates.ts roundtrip=packages/arbor-mcp/tests/repo-flight-gates.test.ts -->

### O4 — A2A receipt distinguishes delivered, acknowledged, applied and terminal work

<!-- proof: symbol=RepoFlightDeliveryAdapter file=packages/arbor-mcp/src/repo-flight-delivery.ts roundtrip=packages/arbor-mcp/tests/repo-flight-delivery.test.ts -->

### O5 — Approval is independently decided, exact-effect bound, current at effect time and use-bounded

<!-- proof: symbol=RepoFlightEffectExecutor file=packages/arbor-mcp/src/repo-flight-effects.ts roundtrip=packages/arbor-mcp/tests/repo-flight-effects.test.ts -->

### O6 — Production reports enforced only when every selected provider and mutation path is intercepted

<!-- proof: symbol=evaluateRepoFlightProfile file=packages/arbor-mcp/src/repo-flight-profile.ts roundtrip=packages/arbor-mcp/tests/repo-flight-profile.test.ts -->
