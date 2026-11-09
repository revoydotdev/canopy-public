# Repository Flight Director

The Repository Flight Director is Revoy2's single, durable authority for one
Git repository. It joins provider process identity, repository-run lifecycle,
resource-scoped clearance, fencing, gates, effect dispatch, and A2A delivery
receipts without giving an agent an ambient bypass credential.

## Start and inspect

Production `arbor greenfield` dispatch starts the repo-local director when it
is absent. Operators can manage it explicitly:

```text
arbor flight start
arbor flight status
arbor flight profile
arbor flight sessions
arbor flight runs
arbor flight clearances
arbor flight drains
arbor flight deliveries [--run <repo-run-id>]
arbor flight effects [--run <repo-run-id>]
arbor flight gates --plan <gate-plan-id>
arbor flight stop
```

`arbor flight serve` is the foreground service entry point. `start` launches
that entry point detached. `stop` signals only the PID whose process-start and
host-boot identities still match the private owner record. State and transport
material live below the resolved Arbor persistence directory in
`repo-flight/`; the Unix socket and credentials are mode `0600` and the
directory is mode `0700`.

Mutation commands use one typed JSON envelope on bounded stdin:

```text
arbor flight command < envelope.json
```

The transport authenticates the caller and replaces any asserted `actor_id`
with the credential-bound identity. An accepted transport frame is distinct
from an accepted domain command; the CLI returns a conflict exit when either
layer refuses the operation.

## Mechanical control model

Every provider invocation creates one `repo_run_id` and is admitted before any
provider credential or model dispatch. Subprocess connectors enroll the real
child PID before prompt bytes are written; enrollment binds the provider and
Revoy session identifiers to the process-start token, host-boot identity,
process group, canonical repository, worktree, campaign, node, task, and
declared write paths. The in-process native lane records its real harness
session lifecycle but deliberately does not fabricate a child PID, so its
deployment profile remains below identity-enrolled. Revoy's detached-object
worktrees are accepted only when their managed path, active durable lease,
admitted base commit, and live parent `git worktree` registration all agree.

A protected effect needs an HMAC-authenticated clearance for its exact holder,
operation, resource set, candidate digest, policy version, expiry, and use
bound. Resource epochs fence stale holders. Disjoint paths can proceed
concurrently; overlapping paths and repository-global Git, stash, worktree,
evidence-publication, adoption, or push operations conflict. Approval-required
effects additionally bind the independent approval to the exact effect digest
and current fence set.

The effect journal persists `prepared -> authorized -> dispatched -> terminal`
before and after the external callback. Recovery treats a durable dispatch
without a receipt as ambiguous. A transaction-bound authority receipt also
closes the earlier crash window: authorization without durable dispatch is
settled `no_effect`, never automatically replayed.

Snapshot gates verify an immutable private candidate. Quiescent gates require
durable drain acknowledgements and run in a probed Bubblewrap boundary with a
read-only root, private temporary directory, and unshared network. The runtime
does not claim that mode when the real host probe fails.

## A2A and recovery

Flight delivery records join the canonical communication message/thread
identity to a repo run, operation attempt, and target instance. `sent`,
`claimed`, `delivered`, `acknowledged`, `applied`, and terminal states remain
distinct. Restart after a dispatch checkpoint never redispatches an uncertain
effect or message; an operator must certify `applied` or `no_effect` where the
system cannot prove the outcome.

Stores are private, bounded, single-writer, atomically replaced or append-first
and hash-chained as appropriate. Malformed state, a broken chain, PID reuse,
host reboot ambiguity, stale fences, reused idempotency keys, and mismatched
candidate identity all fail closed.

## Deployment truth

`arbor flight profile` reports one of `enforced`, `cooperative`,
`observed_only`, or `degraded` from composed facts. A provider launch hook is
not a mutation interceptor. Raw same-user shells and any required provider
without a real launch/identity/mutation boundary prevent an `enforced` claim.
This distinction is intentional: the director governs every route actually
composed through it and names unmanaged routes rather than presenting an
advisory hook as kernel-level prevention.

The initial authority is repository-scoped and works offline. Organization or
multi-repository federation is a future adapter over bounded projections and
grants; it must not become an ambient cross-project mutation credential.
