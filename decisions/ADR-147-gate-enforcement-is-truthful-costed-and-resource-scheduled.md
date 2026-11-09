# ADR-147: Gate Enforcement Is Truthful, Costed, and Resource-Scheduled

**Status:** Accepted
**Date:** 2026-08-29
**Authoring Revision:** 0d53214c28870b1f97a723ef3b16c0a64507878e
**Content ID:** sha256:44d6ff052f62970df239e36997fb2d6ae9e172575ef650e20541c82709d4d826

## Context

The enforcement control plane now registers 53 gates and selects 19 of them
for local pre-push.  A six-trial diagnostic receipt recorded a current-profile
critical path near 198 seconds even though it stopped at
`gate:vi-reproducible` before the final three waves.  The same candidate's VI
reproduction alone took roughly 165 seconds; test typechecking took roughly 27
seconds and docs truth roughly 12 seconds in the serial comparison arm.  The
problem is therefore not merely that the suite is large.  The profile does not
yet carry enough truthful information to schedule, deduplicate, or even
describe its work safely.

Two independent gate-by-gate audits on 2026-08-29 inspected all 53 registered
entries against their commands and implementation.  They found four classes
of defect.

First, some gates can return a false green or consume invalid authority.
`typecheck-tests.mjs` records a failed compiler spawn as `ok: false` but derives
its process exit only from parsed `TS####` lines, so an empty spawn error exits
zero.  It also accepts an empty package census.  `reachability.mjs` surfaces an
unparseable waiver file and stale waiver rows but excludes both from `ok`.
Those are correctness defects, independent of performance.

Second, `mutability: read_only` is not true for every declared reader.
`claim-ledger-precommit` may refresh and stage the claim store,
`worktree-hygiene` calls `git worktree prune` against shared Git administration,
and `hollow-parity` overwrites a tracked catalog projection on every gate run.
The scheduler currently uses mutability as its only concurrency safety signal,
so a false declaration is an execution-safety defect.  Even genuinely
read-only processes can contend: TypeScript compilers, Vitest workers, coverage,
and the LSP graph producer are all treated like cheap JSON scans under the same
four-reader cap.

Third, placement and authority drifted.  `hook-liveness` is selected and
required in CI even though its own implementation says CI invocation history is
vacuous and always exits zero.  CI runs the report-only and blocking anti-stub
variants over the same corpus.  Standalone CI jobs execute the same expensive
gates that the final aggregate immutable battery then replays.  Graph consumers
can run before exact graph verification.  The result spends time without adding
independent evidence and sometimes presents a stronger name than its verdict.

Fourth, evidence refresh contradicts an accepted decision.  ADR-034 requires
determinism measurement to remain manual and off CI, pre-push, and the critical
path; staleness is explicitly report-only.  `evidence:rebind` nevertheless runs
all 195 cited seams three times, every time, and store freshness treats any
in-scope source-byte change as blocking until that measurement is repeated.
The baseline gate itself only reads committed results.  Automating the producer
inside the mandatory source-to-evidence sequence silently reversed ADR-034 and
is a major contributor to multi-hour finalization.

The audits also confirmed two absent controls.  No declared gate enforces the
package import matrix in `AGENTS.md`, and no gate verifies the repository's
vendored-source attribution/license inventory or distinguishes that mechanical
check from the necessarily human clean-room provenance claim.

## Decision

Subject to the operator interview recorded for this allocated ADR, revoy2 will
apply the following policy as one enforcement-control-plane migration.

1. **A gate contract states effect, resources, and writes separately.**  Every
   profile entry declares an `effect` (`blocking` or `advisory`), a
   `resource_class` (`light`, `git_admin`, `typescript`, `vitest`, `coverage`,
   `lsp`, or `network`), and its real `mutability`.  Profile verification
   rejects missing fields and invalid context combinations.  The scheduler
   retains deterministic waves but admits work only when both its data
   prerequisites and resource limits are satisfied.  Light readers may use the
   configured reader width; TypeScript, Vitest, coverage, LSP, network, and Git
   administration receive explicit per-context caps.  A required advisory is
   not fabricated into a blocking CI result.

2. **Declared readers are actually read-only.**  Hollow-parity generation is a
   separate writer command; the gate regenerates in memory and compares the
   committed projection without writing.  Claim-ledger precommit is declared an
   evidence writer.  Worktree pruning is removed from immutable candidate
   verification and retained only as an explicit local maintenance action;
   its check mode observes without pruning.  Identity watching remains a final
   backstop, not the primary purity mechanism.

3. **Known false greens fail closed.**  Test typechecking fails on any compiler
   invocation error, on an empty declared source-root census, and on missing
   package test configurations.  Reachability fails on an unparseable waiver
   store and on stale waiver rows; a row no longer suppressing a current finding
   must be removed rather than silently retained.  Hollow-parity uses the
   repository's installed Vitest binary and treats unavailable observed/branch
   evidence as an explicit unavailable result rather than a passing check.

4. **Context placement matches actual authority.**  Hook-liveness becomes a
   local advisory and is not selected by CI.  Only the blocking anti-stub form
   is selected by CI/pre-push; the report-only form remains an operator command.
   Fast graph input binding and freshness precede graph consumers.  Full graph
   reproducibility remains a blocking CI control, while local pre-push uses the
   exact input/content binding and runs full reproduction only when VI producer,
   root-set, profile, or vendored-tool inputs changed.  The names and emitted
   receipts state which path actually ran.

5. **Determinism returns to ADR-034's boundary.**  `evidence:rebind` no longer
   invokes `determinism:refresh`.  Determinism content/age drift is reported, not
   used to demand a measurement after ordinary source changes.  The blocking
   read gate still refuses a newly cited but unmeasured seam and a committed
   baseline above its flake ceiling.  The manual producer remains exclusive,
   records machine/revision identity, and is never adopted as fresh merely
   because another evidence producer ran.

6. **Generated evidence binds to input content, not self-referential commit
   churn.**  The VI manifest records an exact hash of every declared producer
   input, excluding generated evidence outputs.  A fast binding gate validates
   that hash against the immutable candidate.  Store content hashes remain
   authoritative and commit distance remains advisory.  This reduces the
   normal closure to source commit, one governed evidence refresh, review, and
   one evidence commit; it removes the repeated graph/rebind cycle whose only
   new input was the previous evidence commit.  Full reproduction still checks
   the graph structurally in CI and on producer/tool changes.

7. **CI has one Linux authority path.**  The immutable aggregate battery is the
   authoritative Linux result.  Standalone jobs remain only for platform lanes
   or evidence the aggregate cannot reproduce.  A duplicate standalone Linux
   gate is either removed or produces a candidate/profile/toolchain-bound
   receipt the aggregate verifies and adopts; it is never blindly rerun and
   then counted as independent assurance.  Receipt adoption fails closed on any
   identity or roster mismatch.

8. **Package boundaries and reuse compliance become explicit, bounded gates.**
   A package-boundary gate parses workspace imports and enforces the permitted
   dependency matrix from one machine-readable manifest, including the
   `@arbor/core` no-internal-dependency rule.  A reuse-compliance gate validates
   vendored-source inventory, license/notice presence, attribution, and declared
   dependency-license policy.  It explicitly does not claim to prove human
   clean-room independence; that remains a provenance assertion requiring
   human evidence, never a scanner-generated fact.

9. **Timing is part of the receipt, not folklore.**  Every aggregate result
   retains snapshot, install, build, per-gate, wave, critical-path, and cleanup
   timings.  A gate audit command renders all 53 contracts and last measured
   costs with no blank cells.  Performance acceptance compares successful runs
   on the same candidate and machine; failed runs remain diagnostic only.

## Consequences

False greens named by the audit become mechanical failures, and a gate's name,
effect, resource demand, mutation behavior, and context stop being separate
prose claims.  Pre-push should lose the unconditional determinism producer and
ordinary-source full VI reproduction, while CI preserves the stronger
reproduction check.  Evidence closure becomes one content-bound transaction
instead of repeatedly rebinding artifacts to commits created only by those
artifacts.

The scheduler becomes more complex: it must enforce resource caps as well as
data edges and preserve deterministic progress ordering.  CI receipt adoption
adds identity validation and artifact transport.  The new package/reuse gates
need maintained policy manifests.  Exact input hashing is only as sound as its
declared input set, so profile verification and fixtures must fail on omitted
producer inputs.  None of this upgrades ADR-025's local hook into protected
server-side enforcement; `--no-verify` remains a deliberate bypass and GitHub
branch protection remains unavailable on the current plan.

## Alternatives / Roads not taken

**Simply raise concurrency from four to 24.**  Rejected.  The expensive lanes
share TypeScript servers, compiler memory, Vitest workers, and filesystem
bandwidth; treating core count as permission to launch 24 unclassified readers
can increase tail latency and nondeterminism.  Resource classes allow measured
parallelism without assuming every read-only process is cheap.

**Remove expensive gates from both pre-push and CI.**  Rejected.  The audits
found real false-green and authority defects, so reducing cost by deleting
independent assurance would optimize the wrong quantity.  The decision removes
duplication and vacuous checks while keeping one authoritative execution.

**Keep automatic determinism refresh because its data are useful.**  Rejected.
ADR-034 explicitly chose manual measurement because shared/contended runners
measure the host as much as the code.  Quietly making it mandatory after every
source commit is governance drift, not a stronger implementation of that ADR.

**Call exact input binding graph reproducibility.**  Rejected.  A content hash
proves that a committed graph names the current producer inputs; it does not
prove that regenerating those inputs yields the same graph.  The fast and full
checks retain distinct names and receipts.

**Claim a scanner proves clean-room provenance.**  Rejected.  A scanner can
verify inventory, licenses, notices, hashes, and forbidden dependency edges.
It cannot establish how a human or model formed an implementation.  The gate
will state that ceiling explicitly.

## Obligations

### O1 — Gate contracts and the scheduler enforce truthful effect, resource, and mutation semantics

Profile validation rejects incomplete contracts, and the plan/executor honors
resource caps without changing deterministic progress order.

<!-- proof: symbol=planGateDag file=scripts/enforcement-control-plane.mjs roundtrip=scripts/tests/enforcement-control-plane.test.mjs -->

### O2 — The audited false-green and hidden-writer paths fail closed

Compiler invocation failure, empty source census, invalid/stale reachability
waivers, and a tracked write from a declared reader each have a failing fixture.

<!-- proof: symbol=typecheckResultsPass file=scripts/typecheck-tests.mjs roundtrip=scripts/tests/typecheck-tests-root.test.mjs -->
<!-- proof: symbol=reachabilityVerdict file=scripts/reachability.mjs roundtrip=scripts/tests/reachability-graph.test.mjs -->
<!-- proof: symbol=compareCatalogSurfacesArtifact file=scripts/hollow-parity.mjs roundtrip=scripts/tests/hollow-parity.test.mjs -->

### O3 — Determinism measurement is manual and absent from evidence rebind, pre-push, and CI producers

The read gate continues to enforce unmeasured cited seams and the committed
flake ceiling, while no governed critical-path command invokes the producer.

<!-- proof: symbol=AUTOMATED_EVIDENCE_STORE_NAMES file=packages/arbor-mcp/src/native-tools/evidence-refresh.ts roundtrip=packages/arbor-mcp/tests/evidence-refresh.test.ts -->

### O4 — VI fast binding and full reproducibility are separate, truthful controls

The fast gate proves exact producer-input content identity; the full gate
regenerates and structurally compares, and receipts identify which verdict ran.

<!-- proof: symbol=computeViInputBinding file=scripts/lib/vi-input-binding.mjs roundtrip=scripts/tests/vi-input-binding.test.mjs -->

### O5 — Aggregate CI does not blindly replay an identical authoritative Linux gate result

Each expensive Linux gate executes once per exact candidate/profile/toolchain,
or an adopted receipt fails closed when any identity field differs.

<!-- proof: symbol=auditWorkflowProfile file=scripts/enforcement-control-plane.mjs roundtrip=scripts/tests/ci-workflow-contract.test.mjs -->

### O6 — Package boundaries and reuse compliance have explicit gates with honest ceilings

The package matrix and reuse inventory are machine-checked, while clean-room
independence remains explicitly outside scanner authority.

<!-- proof: symbol=evaluatePackageBoundaries file=scripts/package-boundary-gate.mjs roundtrip=scripts/tests/adr147-compliance-gates.test.mjs -->
<!-- proof: symbol=evaluateReuseCompliance file=scripts/reuse-compliance-gate.mjs roundtrip=scripts/tests/adr147-compliance-gates.test.mjs -->
