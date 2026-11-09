# ADR-101: Recovery Is Proven By Killing The Process, And Contention Reports Itself Plainly

**Status:** Accepted
**Date:** 2026-08-26
**Authoring Revision:** 5afc268fd12b3731abf2ba5b1ca52a3c941f8153
**Content ID:** sha256:f9a2f38ddf95515bdcfb5a4509e5e1ed58cdf12328ad4046618701bc5dadf434

## Context

Two related gaps, both grounded in the tree as it stands today.

**(a) Recovery is designed well but proven only in-process.**
`packages/arbor-core/src/persist.ts`'s `saveCampaign` writes atomically —
temp file plus fsync, confirmed by `persist-fsync.test.ts` — and
`quarantinePersistenceFile` moves a corrupt snapshot aside on load rather
than crashing or silently discarding it. `packages/arbor-mcp/src/recovery/`
(`recovery-service.ts`, `recovery-lease-adapter.ts`,
`recovery-list-contracts.ts`) implements a real lease/continuation model
with typed `RecoveryAction` (`retry` | `abandon`) and role-scoped
`RecoveryRequest`s. `packages/arbor-core/src/tree.ts`'s
`RecoveryAttempt`/`RecoveryAbandonment` types and `reviveFailedNode`/
`reviveScopeBlockedNode` give the tree a typed interrupt/retry/abandon state
machine. All of it is exercised — `recovery-roundtrip.test.ts`,
`recovery-service.test.ts`, `recovery-lease-adapter.test.ts` — but every one
of those tests replays state within a single process. None SIGKILLs a real
`arbor-mcp` process holding a campaign and asserts a freshly started process
resumes it correctly. The design is strong; the proof it survives an actual
process death is missing.

**(b) A live incident, reproduced twice — during the 2026-08-26 audit and
again while drafting this ADR — exposed a schema-compatibility defect
across concurrent worktrees, not only a wording defect.** The evidence
lease lives under this repository's *shared* git common directory
(`evidenceTransactionPaths`, `scripts/evidence-transaction.mjs`, resolving
to `<git-common-dir>/arbor/evidence-refresh/lock`, state file at
`.../lock/state.json`) — shared because `git worktree list` on this
checkout shows roughly seventy worktrees (`revoy2-b1-eval`,
`revoy2-b2-gate-control`, `/tmp/revoy2-push-master`, and many more) all
pointing at the same `.git` common dir. This checkout's
`scripts/evidence-transaction.mjs:24` reads `const LOCK_SCHEMA_VERSION =
1`, and `readState` (line 71) hard-fails with `"schema mismatch"` whenever
`state.schema_version !== LOCK_SCHEMA_VERSION`. Reading the live lock file
directly (.git/arbor/evidence-refresh/lock/state.json — exists only while a
transaction holds the lock, never checked in — both during the
audit and again just now) shows `"schema_version": 2`, a structured
`lifecycle.heartbeat: { sequence, at }` object, and a persisted
`lifecycle.deadline: { status: "armed", at }` — written by
`/tmp/revoy2-push-master`'s copy of `evidence-transaction.mjs`, whose own
`LOCK_SCHEMA_VERSION = 2` (that worktree's line 29) and comment ("Version
two deliberately records *lifecycle*, rather than merely a lock") confirm
this is a real, deliberate, in-flight schema evolution on a sibling branch
(`codex/situational-awareness-integration-20260825`), not a corrupted file.
Running `bun run evidence:status` in *this* checkout against that *real,
live, healthy* lock reproduces the exact defect: `evidence lock state at
.../state.json is malformed; no process may steal it automatically (schema
mismatch)`. Both observations are true — the schema-1 source in this
checkout and the schema-2 file genuinely on disk — and the gap between them
is the finding. A forward-incompatible lock schema is shared across
worktrees running different code revisions, and a newer writer's healthy
lock is indistinguishable from corruption to an older reader. The refusal
this produces is fail-closed and therefore *safe* — no process steals the
lock — but it is safe by accident of the wording ("no process may steal it
automatically" happens to hold either way), not by design: nothing in
`readState` treats "I don't understand this schema version" as a distinct,
named case from "this file is genuinely broken." An operator or agent
reading "malformed" is being invited to delete or "repair" a lock held by a
live sibling process three worktrees away.

One clarification on the two source strings driving this: `governance-plan.mjs`
line 85 emits `` `${consumer} refuses derived governance evidence while
transaction ${evidenceStatus.transaction_id ?? "unknown"} is active at
${phase}; wait for its atomic commit or recover it explicitly` `` — this
message fires only once a transaction is confirmed *held*, and already says
"wait." The malformed-sounding message is `readState`'s own, at
`evidence-transaction.mjs:74`, and it fires for both a genuinely truncated
file and a healthy schema-2 lock alike, because line 71's equality check
cannot tell them apart.

## Decision

**1. Schema compatibility across concurrent worktrees is the primary fix.**
`readState` must define a minimum readable envelope that every schema
version is contractually required to preserve, independent of
`schema_version`'s value: `schema_version` (number), `transaction_id`
(string), `owner` (object with `pid`, `owner_id`, `acquired_at`,
`process_start_identity`), and a top-level `heartbeat_at` (string
timestamp). This envelope already exists by coincidence, not policy — the
live schema-2 file carries a top-level `heartbeat_at` alongside its new
nested `lifecycle.heartbeat` object, which is why this fix is cheap rather
than speculative. When `state.schema_version` is a number different from
`LOCK_SCHEMA_VERSION` but the envelope fields are present and correctly
typed, `readState` must NOT throw `ambiguous_lock`/"malformed." It must
throw a new, distinct code — `unsupported_schema_version` — carrying the
envelope fields (so `ownerLiveness` and message construction below can
still run against `owner`), and the phase/lifecycle-specific fields of that
newer or older schema remain opaque to this reader. Only when the envelope
itself is missing, mistyped, or the JSON does not parse does `ambiguous_lock`
fire. This is the rule that keeps a future schema bump — version 3, 4 —
from reproducing this exact incident: any writer, present or future, that
preserves the envelope is safely readable as "someone else holds this,"
never "corrupt," by an older reader that has never heard of its schema.

**2. Message content names the holder, the heartbeat age, and the caller's
own polling deadline — never a fabricated persisted one.** For both the
existing `held`-and-live case and the new `unsupported_schema_version` case,
the message states the owner's `pid`/`owner_id`, an age computed from
`heartbeat_at` (`Date.now() - Date.parse(heartbeat_at)`), and, only when the
caller is polling via `acquireEvidenceTransactionWithWait`, the remaining
time on that call's own local deadline. It must not claim the lock itself
expires on a timer — under `LOCK_SCHEMA_VERSION = 1` in this checkout, it
does not. Tellingly, the live schema-2 file *does* persist a deadline
(`lifecycle.deadline: { status: "armed", at }`) — which is itself the
argument for rule 1's envelope contract: a persisted deadline is exactly
the kind of version-specific enhancement that must live outside the
envelope, available to a reader that understands schema 2 but never
fabricated by a reader that does not. The message closes on an explicit
instruction: wait for the owner, or run `bun run evidence:status` to check
liveness. `assertGovernanceConsumerReady`
(`scripts/lib/governance-plan.mjs:85`) should embed this same owner/age
summary rather than composing a shorter one from `transaction_id`/`phase`
alone, and `readState`'s malformed-file message keeps its current wording —
unchanged — for the case that is actually left once rule 1 removes the
schema-mismatch false positive from it.

**3. A real kill-and-restart test proves resume, governed by ADR-078's
frozen-snapshot rule.** A new integration test spawns a real `arbor-mcp`
process (via `packages/arbor-mcp/bin/arbor-mcp.mjs`, the same entry point production uses)
against a campaign directory, drives it partway through a campaign, sends
`SIGKILL`, then starts a fresh process pointed at the same directory and
asserts the campaign resumes from its last durably saved state — exercising
`saveCampaign`'s fsync guarantee and the recovery lease's actual
`retry`/`abandon` contract end to end, not replayed in-process. Per
ADR-078, this test must run against an isolated, frozen working copy (a
temp directory populated by `git archive` or an isolated worktree, never
the live checkout other agents may be committing to concurrently), so it
cannot race a sibling session's writes — the same concurrency hazard that
produced finding (b) in the first place.

## Consequences

Rule 1 is the consequential change: it turns "unknown schema" into a named,
safe, waitable state instead of relying on an equality check to accidentally
fail closed. That removes a real, reproduced false positive — this
checkout genuinely cannot read the live lock today and calls it corrupt —
without weakening the guard against actual corruption at all, since the
envelope check is strictly narrower than "parses as JSON." The cost is a
small, permanent compatibility obligation: every future schema version must
keep emitting the envelope fields, forever, or this contract breaks silently
for the next version pair. That is a real constraint on future schema
authors (the schema-2 branch already satisfies it, but only by chance), and
this ADR's obligations must make it checkable, not just documented. A
kill-restart test gives the recovery design its first proof against a real
process death instead of an in-process replay assumption; it also adds
real cost — slower than the in-process suite, and needs the ADR-078
frozen-snapshot machinery wired for a new scenario. Rewording contention
messages costs nothing in behavior — every affected gate still fails
exactly as it does today for a genuinely held or genuinely malformed lock —
but changes what an agent reads while red. What this decision does NOT
change: no automatic recovery, no lock-side timeout/expiry introduced into
schema 1, and no weakening of the genuinely-malformed refusal — a truly
corrupt or envelope-violating lock still requires the explicit
`evidence:recover` path with a proven-dead owner.

## Alternatives / Roads not taken

**Pin all worktrees to one `evidence-transaction.mjs` version so schema
drift cannot happen.** Rejected: worktrees exist precisely so concurrent
branches can carry different, in-progress code — including in-progress
changes to this very module, as the live incident demonstrates. Forcing
version lockstep across every worktree this repository carries would block
exactly the schema evolution (`schema_version 1 → 2`, adding `lifecycle`)
this incident shows is already happening in the ordinary course of
development.

**Have the older reader attempt to parse and interpret the newer schema's
extra fields instead of treating it as opaque.** Rejected: an older reader
guessing at a newer schema's semantics (is `lifecycle.deadline.status:
"armed"` binding? what does an unrecognized `phase` value mean for
liveness?) is worse than treating everything outside the envelope as
opaque and simply waiting. The envelope's job is exactly to be the minimal
subset every version can agree on; anything richer belongs to a reader that
was built after that version shipped.

**Add a persisted deadline/expiry field to schema 1 so a stale lock
self-expires, matching what schema 2 already does.** Rejected for this
ADR: adopting schema 2's lifecycle/deadline model in this checkout is a
substantive, separate design decision (a policy for how long is too long, a
new failure mode where a still-live owner's lease "expires" mid-write) that
this ADR's schema-compatibility fix does not require and should not be
bundled with, since it would make this ADR's obligations harder to verify
independently of that larger change.

**Skip the real kill-restart test and instead strengthen the existing
in-process recovery tests' assertions.** Rejected: in-process replay cannot
exercise the one thing this ADR is about — whether a write that was
mid-flight when the OS killed the process leaves the file in a state
`loadCampaignResult` can actually recover from.

## Obligations

### O1 — `saveCampaign`'s atomic-write guarantee is real today, independent of this ADR's kill-restart test

`saveCampaign` writes via a temp-file-plus-fsync sequence, exercised by
`persist-fsync.test.ts`, the existing strength this ADR's kill-restart test
is designed to validate against a real process boundary rather than
replace.

<!-- proof: symbol=saveCampaign file=packages/arbor-core/src/persist.ts roundtrip=packages/arbor-core/tests/persist-fsync.test.ts -->

### O2 — An unknown-but-higher `schema_version` with a valid envelope is treated as "held by a newer writer — wait," distinctly from a genuinely malformed lock

A test must construct a synthetic lock state with `schema_version: 99` and
a complete, correctly-typed envelope (`transaction_id`, `owner.pid`,
`owner.owner_id`, `owner.acquired_at`, `heartbeat_at`) and assert `readState`
raises `unsupported_schema_version`, not `ambiguous_lock` — and a second
case with `schema_version: 99` but a missing or mistyped `owner` still
raises `ambiguous_lock`. This is the obligation that reproduces and closes
the exact false positive this checkout hit twice against the live schema-2
lock.

<!-- proof: symbol=readState file=scripts/evidence-transaction.mjs roundtrip=scripts/tests/evidence-transaction-schema.test.mjs -->

### O3 — A real SIGKILL-and-restart test exists and asserts campaign resume from durable state

`packages/arbor-mcp/tests/recovery/persist-kill-restart.test.ts` spawns a
real, separate `bun` process (`packages/arbor-mcp/tests/recovery/fixtures/kill-restart-worker.ts`) that
repeatedly calls the real, unmodified `saveCampaign` against a throwaway
`mkdtempSync` persistence directory, waits for genuine forward progress
(`progress:<n>` observed on its stdout), sends it a real `SIGKILL`
(confirmed via the exit event's `signal`), then spawns a second fresh
process that calls the real, unmodified `loadCampaignResult` against the
same directory and asserts the snapshot itself is never found corrupt (any
diagnostic is a legitimate `temporary_file` quarantine, never a
`campaign_snapshot` one) and durably reflects real progress made before the
kill. This proves the atomic-write half of the ADR's claim against a real
process death. Scope note, honestly recorded: this tranche's file ownership
is `packages/arbor-core/src/persist.ts` and
`packages/arbor-mcp/src/recovery/**` only — `packages/arbor-mcp/bin/arbor-mcp.mjs`'s full
CLI/demo/runtime composition root (`cli.ts`, `demo.ts`, `runtime.ts`) and the
session-level retry/abandon dispatch belong to other files outside this
ownership set, so the test drives `@arbor/core`'s production persistence
functions directly rather than the full `arbor run`/`arbor resume` CLI
surface. It is a real-entrypoint driver per ADR-078 (its own throwaway
persistence dir, never this repo's `.arbor/`), not a broad-state repo scan,
so no frozen git snapshot was required for it.

<!-- proof: symbol=loadCampaignResult file=packages/arbor-core/src/persist.ts roundtrip=packages/arbor-mcp/tests/recovery/persist-kill-restart.test.ts -->

### O4 — Contention and unsupported-schema refusals resolve through `evidenceTransactionStatus`'s existing owner/liveness/message assembly, verified as the real mechanism this ADR extends

`evidenceTransactionStatus` already computes `liveness` via `ownerLiveness`
and assembles a message naming the owner's pid, phase, and acquired time,
distinguishing LIVE / DEAD / AMBIGUOUS in its own text today — the exact
vocabulary this ADR requires both the reworded malformed-lock message and
the new `unsupported_schema_version` message to extend rather than
duplicate.

<!-- proof: symbol=evidenceTransactionStatus file=scripts/evidence-transaction.mjs roundtrip=scripts/tests/evidence-rebind.test.mjs -->

### O5 — `assertGovernanceConsumerReady` embeds `evidenceTransactionStatus`'s own owner/heartbeat-age summary in a real refusal, rather than recomposing a shorter one from `transaction_id`/`phase` alone

Re-audited 2026-08-26: `assertGovernanceConsumerReady`
(`scripts/lib/governance-plan.mjs:76`) already builds its refusal by
appending `evidenceStatus.message` — the same string
`evidenceTransactionStatus` assembles, which names the holder's `pid`,
`owner_id`, and an age computed from `heartbeat_at` — rather than composing
a terser one from `transaction_id`/`phase` alone. This was previously
"plausible but unconfirmed" because no test drove a real held transaction
through it; a new integration test (`governance-plan.test.mjs`, "names the
holder pid and heartbeat age in a real held-transaction refusal") acquires
a real evidence transaction lease in a throwaway `mkdtempSync` repo (never
this checkout's own `.git/arbor/`), calls `assertGovernanceConsumerReady`
against the real `evidenceTransactionStatus` result, and asserts the thrown
message matches `pid ${process.pid} (owner: ` and `heartbeat \d+s ago`. No
`assertGovernanceConsumerReady` caller in this repo polls via
`acquireEvidenceTransactionWithWait`, so the caller's-own-polling-deadline
clause in rule 2 does not currently apply to any consumer gate.

<!-- proof: symbol=assertGovernanceConsumerReady file=scripts/lib/governance-plan.mjs roundtrip=scripts/tests/governance-plan.test.mjs -->
