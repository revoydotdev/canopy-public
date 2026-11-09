# ADR-152: Flight Admission and Validation Are Attested and Revision-Bound

**Status:** Accepted
**Date:** 2026-08-28
**Authoring Revision:** ec446879c293a0c9707027e9e2cc3d095df4f160
**Content ID:** sha256:e7d7df468d5d91c784a45368d490648abc2c98b1dd652c371730018ffe0b39c3

## Context

ADR-151 establishes one repository-scoped, fenced Flight authority, but the
first implementation exposes a governance and an execution gap. Provider and
native hooks can create a run and move it directly from `planned` to
`admitted`; no durable artifact proves that the governing decision was
accepted, interviewed, and independently approved. The same hooks perform
agent lifecycle calls with an operator credential even though the transport
can provision a narrower agent credential. Flight therefore identifies and
fences work after admission without yet proving that the work was authorized
to begin.

The repository also has two schedulers in practice. The declarative execution
profile owns gate selection, dependencies, contexts, cost classes and mutation
semantics, while `gate:all` shells the selected gates sequentially. The
immutable execution-profile runner already derives a bounded DAG, but each run
creates and hydrates a fresh worktree and its cache is process-local. Coverage
is a single two-worker Vitest process, CI can repeat it inside another profile
run, and evidence refresh repeats graph extraction, 4,723 call-hierarchy
queries, 9,142 reference queries, production observation and three complete
201-seam determinism runs. In the 2026-08-28 Flight validation this composition
consumed hours and then repeated already-bound facts. More cores cannot repair
duplicated authority, mutable shared resources or results with no durable
revision identity.

The product promise requires both properties at once: unauthorized work must
be mechanically unable to start or publish, and authorized work must receive a
fast answer without weakening coverage, evidence, or gate semantics. Flight is
the appropriate execution authority, but it must consume governance and
execution policy owned elsewhere. It must never become the author, approver or
semantic owner of the decisions it enforces.

## Decision

### 1. Governance authorization is an external typed warrant

Every repository run carries one immutable, closed work-class binding:
`decision_bound` or `exploratory`. Every successful admission requires a
versioned, externally issued `GovernanceAdmissionAttestation`. For
`decision_bound` it carries the Accepted-ADR, interview and independent-
acceptance evidence below; for `exploratory` it carries an independently
issued bounded exploratory authorization with those decision fields explicitly
`null`/`not_applicable`. Flight verifies and records the attestation; Flight
cannot author, sign, classify, upgrade, reinterpret or approve it.

Before issuing, the governance authority independently derives and verifies
the canonical repository, allocated ADR number, current Accepted ADR content
identity and status-only acceptance commit, standing allocated-ID interview
coverage with no active deferral, and independent acceptance receipt. The
attestation binds those derived facts together with repository run, immutable
admission base and input digest, declared work scope and authorized workspace
lineage, work class, proposer/issuer/acceptor identities, execution-profile and
policy versions, issue/expiry times, and canonical digest/signature. It does
not pre-commit an unknown future result candidate. Every protected effect
separately binds the then-current exact candidate to the immutable admission
base and rejects a candidate outside the authorized lineage or declared scope.

The schema declares issuer identity, key identifier, signature algorithm,
canonical payload version, trust-root reference, separation-policy
version/digest, revocation epoch or status receipt, and verification time. The
issuer trust set, public-key material, rotation, revocation state and schema
compatibility are governance-owned versioned inputs. Flight holds verification
material only; a local Flight signing secret, operator credential or
caller-supplied issuer key cannot satisfy the warrant.

The warrant is invalid when an immutable binding changes, the issuer or
revocation state cannot be verified, or the current effect candidate cannot be
proven to descend from the admission base inside the authorized lineage and
scope. It is also invalid unless proposer identity differs from independent
acceptor identity and attestation issuer identity, and the issuer verifies the
acceptance principal differs from the proposer. Additional separation rules
may tighten this closed minimum but never relax it.

Exploratory work is explicit, expiring and non-publishing. It may inspect and
produce private scratch evidence inside declared bounds, but cannot mutate the
candidate, acquire publication/adoption/finalization authority, satisfy an ADR
obligation, or be relabelled decision-bound without a new attestation. A caller
cannot self-select this class through an unverified request.

### 2. Admission becomes a closed, witnessed lifecycle

The direct `planned -> admitted` transition is removed. The only successful
path is:

`planned -> awaiting_governance -> governance_authorized -> admitted`.

Neither `awaiting_governance` nor `governance_authorized` grants mutation,
worktree, gate, evidence, publication, adoption, credential-renewal,
clearance or finalization authority. `governance_authorized` exists only to
durably bind a verified warrant immediately before the closed admission
transition. Failed, missing, expired, revoked, ambiguous, out-of-lineage or
self-issued warrants fail closed.

`repo_run.created` durably carries the immutable work class. Governance
authorization is an append-only attempt record; an active-attempt reference is
selected only by a successful `awaiting_governance -> governance_authorized`
transition. A warrant that expires, is revoked or no longer matches current
derived governance facts before admission or effect use returns the run to
`awaiting_governance`, or to a typed refusal/terminal state, and requires a new
verified attempt. No transition overwrites a prior attempt or converts work
class.

The active attestation is rebound immediately before every protected effect.
`protected_effect` is a closed authority vocabulary covering workspace
mutation, clearance renewal, gate execution, evidence publication, adoption,
finalization, and every repository or external effect resource kind. Unknown
kinds are denied; adding one requires profile and Flight schema evolution. The
attestation digest is part of the effect authorization receipt. Admission-time
success is not a lease on future policy truth.

### 3. Enrollment yields a short-lived agent principal

Operator credentials remain operator-only. After successful process-identity
enrollment, Flight issues a short-lived credential bound to that exact agent
instance, repository, run, provider session, boot/process-start identity,
scope, expiry and revocation epoch. Agent calls use this credential and may
only affect their own admitted run and explicitly delegated receipts or drain
actions. Credential renewal requires a live enrollment, current fence and
current governance attestation. Enrollment failure, terminal disposition or
fencing revokes the credential mechanically.

Run creation, governance authorization and initial process enrollment use a
Flight-owned launcher/operator path, never a provider child carrying an
operator credential. A one-time enrollment bootstrap, if required, is bound to
one launch and expiry and can authenticate only that exact `session.enroll`
and credential issuance. It cannot create or transition arbitrary runs or
invoke a protected effect and is invalidated before the agent credential is
issued. The issued credential carries credential, instance, repository, run
and provider-session identities, process/boot identity, closed operation
scope, issue/expiry time, revocation epoch and signature; every request
revalidates them against current enrollment and revocation state.

### 4. The execution profile remains policy owner

`scripts/execution-profile.json` and its canonical parser remain the only
owners of gate roster, prerequisites, contexts, commands, cost classes,
mutability and gate semantics. A Profile-to-Flight adapter converts the exact
parsed profile plus candidate/toolchain facts into an immutable
`FlightExecutionPlan`, canonicalized and signed by a trusted adapter issuer.
The plan contains the canonical profile digest, normalized argv-only command
specifications, execution context, candidate/toolchain fingerprint, dependency
waves and resource classifications. Flight verifies the plan against the
parsed canonical profile; a caller-supplied digest or arbitrary command list is
never sufficient. Flight cannot manufacture the plan or choose its inputs.

Resource class, isolation requirements, coverage eligibility and serial-lane
reasons are canonical execution-profile fields included in the profile digest.
Flight enforces but cannot infer or override them. It may choose launch timing
only among gates simultaneously runnable in the same profile-derived read-only
wave; it cannot alter prerequisites, wave boundaries, stable reporting order,
terminal semantics, timeouts, mutability, resource classification or gate
membership.

Rollout begins in shadow mode. The adapter and legacy executor must agree on
gate set, commands, dependency waves, mutability, candidate/profile identity
and terminal semantics. Flight becomes authoritative first for hermetic
read-only work, then exact-candidate reuse, then conservative impact reuse,
then coverage dispatch, and finally evidence/finalization scheduling. Any
disagreement leaves the legacy path authoritative and records a finding.

### 5. Execution-state classes remain distinct

Flight recognizes three non-interchangeable execution-state classes, with
distinct snapshot and authority semantics:

1. `immutable_candidate`: detached, read-only verification bound to an exact
   candidate and input digest;
2. `workspace_candidate`: isolated copy-on-write mutation space with its own
   process, temp and tool state; and
3. `evidence_publication`: a candidate-bound evidence workspace operating
   under the repository-common evidence transaction lease, with writer
   serialization over the logical canonical evidence stores; it is an
   authority-governed transaction, not an immutable snapshot.

No cache receipt or successful immutable check proves workspace quiescence or
evidence-publication authority. Hydrated dependency bases may be reused by
lockfile, runtime ABI, platform and toolchain identity, but each running shard
receives an isolated writable overlay, temp root, process group and output
directory.

### 6. Flight schedules resources; existing mechanisms retain semantics

Flight centrally schedules subprocesses, worktrees, process groups, resource
leases, fences, drains and crash recovery. Multi-resource acquisition remains
canonical and all-or-none. Resource-sensitive work, including Git refs/index,
worktree administration, evidence leases, shared `.arbor` state, local socket
namespaces and process-control tests, is serialized or isolated by an explicit
profile classification.

Evidence refresh keeps its producer order and evidence-transaction authority.
Finalization keeps its candidate/evidence phases and human commit barrier.
During migration, evidence publication and finalization require both legacy
authority and a current Flight clearance. Flight schedules the existing
mechanisms and records their receipts; it does not replace their policy or
permit one authority to bypass the other.

Dual-authority transactions acquire Flight repository-resource clearance
before requesting the legacy evidence/finalization lease and release in reverse
order. No implementation waits while holding the later-order authority. Either
authority's refusal is a terminal non-publication result with preserved
evidence.

### 7. Validation results are durable, revision-bound evidence

A reusable result binds candidate OID and input digest, profile digest, exact
gate command/digest, runtime and toolchain versions, lockfile/dependency
digest, platform/architecture, relevant environment allowlist, configuration,
shard manifest and artifact digest. Only authenticated, complete, successful
receipts are reusable. Failures, timeouts, interruptions, ambiguous outcomes,
incomplete artifacts, evidence writers, nondeterminism measurements and
time-sensitive governance checks are not cached unless their owning policy
defines a stricter exact attestation.

Exact-candidate reuse requires an exact fingerprint match. Descendant-candidate
reuse is allowed only for a hermetic shard whose complete transitive input
closure is proven unchanged. The visual-intelligence graph may accelerate that
proof, but missing, dynamic or ambiguous edges fail closed to affected. Impact
selection is never itself coverage evidence.

### 8. Coverage is sharded without changing the coverage promise

The adapter emits two deterministic, revision-bound manifests: a validation-
lane manifest in which every applicable test file appears exactly once, and a
coverage-shard manifest in which every coverage-profile-eligible Vitest file
appears exactly once. A current-candidate coverage verdict consists of one
complete effective shard set: each shard is newly executed or represented by
an authenticated reusable artifact with a full matching fingerprint. Impact
selection may choose which shards execute anew but is never itself coverage
evidence.

Hermetic shards run concurrently in isolated snapshots; resource-sensitive
files run in an explicit serial lane with a profile-owned reason. Each coverage
shard emits private V8/Istanbul JSON and records canonical source-root identity
and normalized source-map paths. Merge rejects differing roots,
instrumentation, runtime/toolchain fingerprints or manifest digests. Flight
verifies the complete shard set, merges maps deterministically, and evaluates
the existing global and per-package thresholds exactly once against the merged
artifact. Per-shard thresholds cannot substitute for the merged threshold.

The Bun-native OpenTUI proof and explicitly classified process-heavy
integration tests remain required behavior lanes outside V8 instrumentation.
Their results cannot substitute for coverage or be omitted where the profile
requires them. Coverage eligibility, source denominator, exclusions and
global/per-package thresholds remain exclusively owned by the coverage
profile. No candidate is accepted, merged, released or given a green coverage
attestation unless its complete effective map meets those thresholds.

A scheduled nightly full audit is an additional oracle. Trunk finalization and
release require a successful uncached all-shard audit bound to the same
candidate, input, profile, toolchain and coverage configuration being
finalized; a nightly result for another identity cannot satisfy it. An
uncached audit is also required after runtime, runner, lockfile, profile or
coverage-configuration changes, after descendant reuse, and whenever impact
analysis is uncertain.

### 9. Scheduling and performance are observable product behavior

The existing finalization progress protocol is extended rather than creating a
second telemetry truth. Plans record queue time, work/execution-state class, cache
fingerprint, impact reason and shard-manifest digest. Stage terminals record
queue delay, wall time, outcome, timeout, output bytes, cache hit/miss and
source receipt. Child process groups record user/system CPU, peak RSS, read and
write bytes; unsupported measurements are `unavailable`, never zero. Waves
record runnable/scheduled counts, dependency/resource wait causes and critical
path contribution. Runs record setup/build/merge time, summed CPU, peak
concurrent RSS, cache-hit rate and full-audit status.

For each named workload lane, baseline and shadow cohorts use the same fixed
24-core reference-host image, representative candidate corpus, toolchain,
declared cache state, isolation mode, concurrency policy, no-competing-work
condition and start-to-terminal boundary. Host capability and telemetry must be
available; unavailable host telemetry disqualifies a performance-promotion
claim rather than reading as zero. `p95` over ten runs uses nearest-rank
reporting and is therefore the maximum observed run.

Authority promotion requires ten clean shadow runs per lane, zero semantic,
coverage or attestation disagreement, and complete crash evidence. Zero false
cache hits means none observed in the cohort and no failures in cache-
corruption, identity-mismatch, changed-transitive-input, incomplete-artifact or
crash-recovery fault suites. On the reference host, ordinary changed-scope
validation must achieve both at least a 60% p95 wall-time reduction from its
ten-run baseline and p95 at or below fifteen minutes. Warm exact-candidate
validation means receipt and artifact-integrity verification under an exact
fingerprint match, excluding a concurrently scheduled full audit, and must
achieve p95 at or below two minutes. The scheduled uncached full audit may move
off the interactive path but may not become slower than its recorded baseline
p95. Thresholds may ratchet tighter through a later accepted decision; they
cannot silently loosen.

### 10. Repository scope is the first containment boundary

All authority, credentials, caches and receipts are repository-scoped in the
first deployment. Their interfaces carry organization/project identity and an
opaque federation issuer so a later accepted decision can coordinate multiple
repositories. No repository Flight instance gains ambient cross-repository or
organization-wide mutation authority.

## Consequences

An agent cannot turn a task request into mutation authority merely by reaching
a provider hook. Every admitted effect has a mechanically verifiable chain
from human-governed decision through independent attestation, agent identity,
current fence and exact candidate. Exploratory work remains useful without
becoming an undocumented bypass.

Validation becomes a scheduled, revision-addressed computation rather than a
sequence of repeated shell batteries. Independent work can consume the host's
cores; shared Git, evidence and process resources remain serialized. Operators
receive a fast ordinary answer and a separately visible full-audit promise,
with enough telemetry to distinguish CPU saturation, I/O, queueing, setup,
cache misses and critical-path defects.

The cost is a governance issuer and key lifecycle, new durable schemas,
attestation migration, a profile adapter, snapshot/cache storage and garbage
collection, shard classification, coverage merging, performance baselines and
a staged dual-authority rollout. Fail-closed impact analysis will initially run
more work than an optimistic cache. The interactive path becomes faster only
after shadow evidence proves that reuse and concurrency preserve the existing
semantics.

## Alternatives / Roads not taken

1. **Let Flight decide whether an ADR is good enough.** Rejected because the
   enforcement authority cannot also author or approve its warrant.
2. **Treat every task as exploratory until publication.** Rejected because
   mutation itself can create irreversible repository and external effects;
   classification must precede authority.
3. **Keep provider hooks on the operator credential.** Rejected because it
   gives child agents ambient authority unrelated to their enrolled instance.
4. **Move gate semantics into Flight.** Rejected because it creates two policy
   stores and lets scheduling code weaken governance by drift.
5. **Parallelize `gate:all` in one checkout.** Rejected because many tests and
   gates mutate Git, evidence, sockets, processes or shared state; more workers
   without isolation reproduce the collision Flight exists to prevent.
6. **Cache by commit or package name alone.** Rejected because runtime,
   lockfile, profile, configuration, fixtures and dynamic dependencies can
   change the answer without changing that coarse key.
7. **Run only impacted tests and call that coverage.** Rejected because a
   selected test pass does not establish repository-wide coverage thresholds.
8. **Replace the full audit with permanent caching.** Rejected because impact
   analysis and cache identity are fallible mechanisms whose false negatives
   require an uncached oracle and explicit cadence.
9. **One organization-level Flight authority first.** Rejected because the
   repository is the offline failure-containment boundary and an ambient
   organization key increases blast radius before federation semantics exist.

## Obligations

### O1 — Decision-bound work cannot reach admission without an externally issued, independently approved governance attestation

<!-- proof: symbol=verifyGovernanceAdmissionAttestation file=packages/arbor-governance/src/admission-attestation.ts roundtrip=packages/arbor-governance/tests/admission-attestation.test.ts -->

The lifecycle and transport must fail closed for missing, stale, malformed,
self-issued or wrong-scope warrants and expose only the closed governed path.

### O2 — Exploratory work is explicit, expiring and mechanically unable to mutate or publish

<!-- proof: symbol=RepoFlightController file=packages/arbor-mcp/src/repo-flight-controller.ts roundtrip=packages/arbor-mcp/tests/repo-flight-controller.test.ts -->

The work-class policy must prove that exploratory authority cannot be relabelled
or used for candidate mutation, evidence publication, adoption or finalization.

### O3 — Every protected effect and renewal rebinds the current governance attestation

<!-- proof: symbol=RepoFlightEffectExecutor file=packages/arbor-mcp/src/repo-flight-effects.ts roundtrip=packages/arbor-mcp/tests/repo-flight-effects.test.ts -->

The durable effect receipt must carry the warrant digest and reject an
out-of-lineage candidate or changed immutable binding, policy, profile, issuer,
expiry, revocation or separation state at dispatch.

### O4 — Enrolled agents use short-lived instance credentials, never the operator credential

<!-- proof: symbol=RepoFlightTransportServer file=packages/arbor-mcp/src/repo-flight-transport.ts roundtrip=packages/arbor-mcp/tests/repo-flight-transport.test.ts -->

Provider and native production hooks must demonstrate issuance, scope,
revocation, expiry and provider/session interoperability over the authenticated
transport.

### O5 — Flight schedules an execution plan derived exactly from the canonical profile

<!-- proof: symbol=compareRepoFlightExecutionPlanShadow file=packages/arbor-mcp/src/repo-flight-execution-plan.ts roundtrip=packages/arbor-mcp/tests/repo-flight-execution-plan.test.ts -->

Shadow comparison and parity checks must prove that Flight cannot invent,
omit or weaken profile-owned gates, alter the dependency partial order or wave
boundaries, or override resource classes.

### O6 — Immutable, workspace and evidence-publication snapshots remain non-interchangeable

<!-- proof: symbol=executeRepoFlightDualAuthorityTransaction file=packages/arbor-mcp/src/repo-flight-dual-authority.ts roundtrip=packages/arbor-mcp/tests/repo-flight-dual-authority.test.ts -->

Fault tests must prove isolation, resource fencing, dual evidence/finalization
authority, crash preservation and the retained human commit barrier.

### O7 — Reuse is authenticated, revision-bound and conservative under uncertainty

<!-- proof: symbol=evaluateRepoFlightDescendantReuse file=packages/arbor-mcp/src/repo-flight-validation-cache.ts roundtrip=packages/arbor-mcp/tests/repo-flight-validation-cache.test.ts -->

Exact and descendant reuse tests must prove complete fingerprint binding,
fail-closed dependency ambiguity, durable receipts and zero reuse of incomplete
or unsuccessful results.

### O8 — Sharded coverage is complete and threshold-identical to the unsharded oracle

<!-- proof: symbol=validateRepoFlightEffectiveCoverageArtifactSet file=packages/arbor-mcp/src/repo-flight-validation-cache.ts roundtrip=packages/arbor-mcp/tests/repo-flight-validation-cache.test.ts -->

A deterministic shard manifest, isolated execution, artifact merge and parity
test must prove every test is represented once and existing global/per-package
thresholds are evaluated over the complete merged map.

### O9 — Performance promotion is based on durable resource and critical-path telemetry

<!-- proof: symbol=evaluateRepoFlightPerformancePromotion file=packages/arbor-mcp/src/repo-flight-telemetry.ts roundtrip=packages/arbor-mcp/tests/repo-flight-telemetry.test.ts -->

Ten-run baselines and shadow cohorts must prove the declared p95 targets,
zero semantic/coverage/attestation disagreements, zero false cache hits and an
uncached full audit no slower than its baseline.

### O10 — Authority remains repository-scoped while federation identities are carried explicitly

<!-- proof: symbol=verifyGovernanceAdmissionAttestation file=packages/arbor-governance/src/admission-attestation.ts roundtrip=packages/arbor-governance/tests/admission-attestation.test.ts -->
<!-- proof: symbol=RepoFlightTransportServer file=packages/arbor-mcp/src/repo-flight-transport.ts roundtrip=packages/arbor-mcp/tests/repo-flight-transport.test.ts -->
<!-- proof: symbol=RepoFlightEffectExecutor file=packages/arbor-mcp/src/repo-flight-effects.ts roundtrip=packages/arbor-mcp/tests/repo-flight-effects.test.ts -->

Multi-repository adversarial tests must prove that credentials, receipts,
caches and effects from one repository cannot authorize another.
