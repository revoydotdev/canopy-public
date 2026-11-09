# Revision-bound enforcement control plane

`scripts/execution-profile.json` is the one machine-readable roster for every
`package.json` `gate:*` command. Each entry carries its command, DAG
prerequisites, execution contexts, deadline/cost class, mutability, required
status, and a typed reason for every context it does not enter.

`planGateDag()` derives stable topological waves from those prerequisites. The
same plan is consumed by execution and returned as `execution_plan`; it is not
a second display-only ordering. Gate names are sorted before bounded read-only
batching, so reordering JSON object keys cannot change execution. Human
preflight output prints those waves rather than alphabetizing away the order
that actually ran.

## Execution

- `bun run enforcement:prepush` runs the registered local pre-push profile in a
  detached candidate worktree. It is still local enforcement and Git's
  `--no-verify` remains a deliberate bypass.
- `bun run enforcement:ci` writes an aggregate candidate-bound report. CI runs
  it and emits/uploads `aggregate-attestation.json`.
- `bun scripts/enforcement-control-plane.mjs --verify` fails roster drift,
  including a newly declared `gate:*` that lacks CI enrollment.
- `trunk:submit` verifies the registry's explicit hook-authority delegation;
  it does not invent a second, mutable gate battery after its evidence seal.

A result binds candidate OID, canonical tree digest, profile version/fingerprint,
gate deadline/status, prerequisite failures, timing, and a canonical execution
manifest digest. CI verifies that every required CI entry has an actual result
for that one identity before it publishes the aggregate artifact. The runner snapshots a
clean candidate, installs its frozen dependencies in that snapshot, and refuses
a result if the watched source checkout changes while it runs. Cached successes
are keyed only by candidate OID, input digest, profile fingerprint, and command.

## Evidence refresh lease

`bun run evidence:refresh-atomic` owns a repository-common lock from graph
precheck through all evidence writers. It runs producers in a detached staging
worktree, stages only canonical evidence prefixes (including new files), and
publishes one checked indexed patch only after the original source identity is
still exact. A transaction may carry tracked source edits as an immutable
source overlay; it rejects untracked source inputs and pre-existing evidence
changes, records the base candidate plus non-evidence source digest, and
refuses publication if either source bytes or identity change concurrently.
The normal dirty-graph refusal remains in force unless a committed transaction
snapshot binding proves the same source digest. The state records transaction ID, owner
PID plus process-start identity when available, expected candidate/digest,
phase, heartbeat, and a hashed delegation capability. `vi:refresh`,
`vi:observe`, claim-ledger, completion-depth, and determinism writers reject a
present lease unless they received that owner capability.

There is no automatic cleanup or lease theft. After a process is proven dead,
run `bun run evidence:recover -- --transaction <id>` to archive its lock,
then start a new transaction. A live or ambiguous lock is refused.

## Local finalization

`bun run finalize` is the change-aware composition boundary for finishing work
without pushing. It emits one versioned five-phase plan: committed source
candidate → cheap evidence-freshness admission → atomic evidence closure →
separate operator-owned evidence commit → exact immutable prepush battery.

The coordinator never starts the expensive detached install/build/battery when
freshness already proves the candidate cannot pass. When it reports
`evidence_refresh_required`, run `bun run finalize -- --refresh`; this invokes
the existing atomic transaction and stops at the typed
`evidence_commit_required` barrier. Review and commit the staged evidence, then
rerun `bun run finalize` once for immutable verification. `--plan` performs no
refresh or verification, and `--json` exposes the same phase records to
automation.

This does not replace `trunk:submit`: finalization is local and never pushes;
`trunk:submit` remains the journaled source → evidence → push transaction. The
required invocation after an evidence commit is an identity boundary, not a
repeated battery—the committed candidate has changed and must receive its own
immutable result.

## Enrollment and central authority

`gate:organization-enrollment` is CI-only and required. Its declared command uses
`--github-api` with CI-provided `GH_TOKEN`; a required inventory exits nonzero
unless coverage is authoritatively reconciled. `--report-only` retains the
non-authoritative doctor/report path without turning it into a green gate.

The checked inventory is an explicit `allowlist` for `revoydotdev/canopy`, not
organization-wide coverage. An allowlist receipt directly queries every listed
repository and lists `.github/workflows` through GitHub's repository Contents
API at its default branch. This is deliberately limited to `contents: read`:
the Actions workflow-administration endpoint is not required, and a 403 stays
a hard, non-authoritative failure rather than becoming an empty workflow list.
GitHub Actions' installation token cannot call `GET /user`, so no ambient
actor variable or user endpoint is used as identity. Instead the receipt binds
successful private canonical-repository and default-branch Contents responses;
the verifier cross-checks that proof against the observed repository record.
The receipt explicitly labels organization enumeration incomplete, and may
prove only that allowlist. `all_non_archived` and
`all_non_archived_with_workflows` dynamically enumerate every active repository
and query workflows for each; both require an active organization-owner
membership receipt before they can be authoritative. The latter reports active
repositories without workflows separately, allowing progressive enrollment of
repositories that already expose CI. A caller-provided status never supplies
authority. `--provider-receipt` remains only for schema-validated hermetic
fixtures. Bootstrap mode is possible but explicitly non-authoritative.

CI artifacts are evidence, not self-authentication. Production
`attestation:verify` accepts no local `--receipt` file: it requires
`--github-api` plus `GH_TOKEN`, queries the authenticated Actions run, resolves
the workflow file through the Contents API at that run's head SHA (recording its
blob SHA), and downloads the named aggregate artifact to compare its embedded
attestation digest. GitHub's run `path` is path-only; it is never treated as a
revision. The receipt binds repository, workflow ref/path and content identity,
run ID/attempt, head SHA, conclusion, artifact name/ID/API digest when supplied,
and the downloaded attestation digest. Fixture receipts are an in-memory test seam only. Missing
artifacts, local/forged issuers, wrong run/artifact, not-run or unavailable
gates, SHA/digest/profile mismatch, and absent platform authentication all have
distinct failure codes.

`bun run server-enforcement:doctor` reports the real boundary: only protected
refs/rulesets requiring the trusted CI check can achieve `BLOCKED`. A private
GitHub Free repository that cannot enable that rule remains `DETECTED`; local
hooks and local artifacts do not change that fact.
