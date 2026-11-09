# Operator journey for a governed task

Artifact kind: runbook
Status: active
Revision: 1
As-of commit: 0ed1f372 (2026-09-23)
Authority: operator workflow guidance; commands and policy are governed by the CLI and accepted ADRs
Evidence scope: mixed — documented command flow, with release-grade provider outcomes still requiring candidate-bound evidence
Supersedes: none
Superseded by: none
Owner: Canopy/revoy2 maintainers
Review trigger: changes to task confirmation, verification, recovery, adoption, or operator surfaces

This page joins the supported offline quickstart to the supervised task
lifecycle. It explains what an operator should inspect at each transition. It
does not claim that a provider-backed run, successful recovery, or 1.0.0
acceptance has been demonstrated on a current release candidate.

## Start from a known checkout

From the repository root, install the locked dependencies, build, and inspect
the local configuration before starting work:

```bash
bun install --frozen-lockfile
bun run build
arbor doctor
arbor project enroll . --dry-run
arbor project enroll .
arbor project status .
```

Review the enrollment preview and the repository's declared acceptance
commands. Enrollment must not invent a build or test command. The deterministic
smoke path is useful for learning the UI and persistence model, but it returns
claimed work because it does not run independent repository verification; it
is not a release acceptance run. See the [five-minute quickstart](five-minute-quickstart.md).

## Run one bounded task

Describe a concrete change and the checks that determine success. Review the
draft, its repository scope, and the planned commands before confirming it:

```bash
arbor task "Implement the requested change and verify the acceptance criteria"
arbor task confirm <draft-id> <revision> --wait
```

While it runs, use the TUI or WebUI for the live tree, activity, and questions.
Cancellation is durable; a late worker result does not replace it. After the
run, inspect the report and patch before adopting:

```bash
arbor report --campaign <campaign-id>
arbor adopt --campaign <campaign-id>
```

The report distinguishes critic approval from independent machine
verification. If verification is missing or unavailable, treat the outcome as
unverified. Apply only the reviewed patch:

```bash
arbor adopt --campaign <campaign-id> --apply
```

Adoption checks the captured patch digest, repository identity, and current
target state. Keep the returned receipt with the change record. The
[operator guide](operator-guide.md) and [recovery guide](recovery-guide.md)
describe the wider workflow and authority rules.

## Choose a recovery action

Recovery is an explicit decision. First inspect the campaign and diagnostics;
do not infer success from process exit, a stopped spinner, or a critic vote.

| Observed state | Operator decision | Next action |
|---|---|---|
| Task draft is incomplete or asks a question | Supply the missing information, then review the revised draft and scope | Resume by confirming the current draft revision; do not confirm an older revision |
| Campaign is interrupted and its prior lease is inactive | Retry only if the original task remains valid and its scope still fits | Use the governed `recovery.retry` action; it must acquire fresh authority and a fresh lease |
| Campaign is interrupted but the prior worker or lease may still be active | Avoid duplicate execution until state is reconciled | Inspect `arbor doctor --json` and campaign diagnostics; resolve the named lease or persistence issue before retrying |
| Campaign is interrupted and the task should not continue | Record the reason and abandon only with operator or auditor authority | Use the governed `recovery.abandon` action |
| Critic rejected the result | Decide whether the requested change still makes sense | Review the rejection and request a bounded revision or stop; rejection is not a verified failure fact by itself |
| Campaign stopped without machine verification | Do not adopt as verified work | Inspect the missing check and its remedy; rerun only through a newly admitted action that records the check |
| Adoption reports a patch or target conflict | Preserve the target state and review the current diff | Reinspect the report and patch; do not force apply or reuse a stale receipt |
| Provider, integration, or sandbox is unavailable | Decide whether the task can be safely handled with an admitted local path | Follow the named doctor remediation or record the relevant evidence as unavailable; do not silently switch providers |

Retry uses a new operation and lease; it does not replay indeterminate side
effects or restore old credentials, approvals, or handles. Abandonment does not
erase evidence. If no safe next action is clear, preserve the campaign record
and ask an authorized operator to decide. The [recovery guide](recovery-guide.md)
is authoritative for recovery mechanics.

## Evidence to retain

For an ordinary task, retain the campaign identifier, report, verification
commands and exit statuses, adoption receipt, and any recovery decision. For a
release claim, each producer must additionally bind its proof artifact to the
full candidate commit. An unavailable provider, credential, platform control,
or external cohort is recorded as unavailable with its reason; it is not a
zero, a pass, or proof that the feature is absent. See the
[release acceptance contract](release-acceptance-1.0.0/README.md).
